/**
 * `cliyard daemon` CLI (P2a): start / status / stop.
 *
 * `start` is the long-running process. It prints one JSON line with the bound
 * address and pid, then waits for SIGINT/SIGTERM. Shutdown is graceful: the
 * listener closes, the store-backed lease is released and the StateStore is
 * closed before the process exits.
 *
 * `status` and `stop` read the lease from the same StateStore; they never open
 * the daemon's projection and never mutate domain state. `stop` signals one
 * exact pid recorded in the lease, and only after that pid's OS start identity
 * matches the recorded identity (no name/port/pattern matching, no blind
 * kills). P2a exposes no HTTP or action endpoint.
 */
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import {
  CliyardDaemon,
  DAEMON_CONTROL_HOST,
  DaemonLeaseHeldError,
  daemonStatePaths,
  createFileLeaseOps,
  startDaemon,
  type DaemonAddress,
  type DaemonLeaseCheckOptions,
  type DaemonLeaseInspection,
  type DaemonLeaseOps,
  type DaemonStoreHandle,
} from "./core.js";

const DEFAULT_STOP_TIMEOUT_MS = 5_000;
const STOP_POLL_MS = 25;

const CLI_USAGE = `Usage:
  cliyard daemon start --repo <path> [--port <n>]
  cliyard daemon status --repo <path> [--json]
  cliyard daemon stop --repo <path> [--timeout <ms>] [--json]

Read-only P2a daemon: opens the repository StateStore, takes a store-backed
single-instance lease, and binds ${DAEMON_CONTROL_HOST} on an ephemeral
(--port 0, default) or explicit port. It serves no Control API yet; accepted
TCP connections are closed immediately. SIGINT/SIGTERM release the lease and
close the store.`;

export interface DaemonCliOptions {
  log?: (line: string) => void;
  error?: (line: string) => void;
  cwd?: string;
  /** Test/embedding seam: replaces the file-backed store handle for `start`. */
  openStore?: (repoRoot: string) => DaemonStoreHandle;
  /** Test/embedding seam: replaces the file-backed lease ops for status/stop. */
  openLeaseOps?: (
    paths: ReturnType<typeof daemonStatePaths>,
  ) => DaemonLeaseOps;
  /** Test seam: invoked after the listening line is printed. */
  onStarted?: (daemon: CliyardDaemon) => void | Promise<void>;
  /** Test seam: process signalling. */
  sendSignal?: (pid: number, signal: NodeJS.Signals) => void;
  sleep?: (ms: number) => Promise<void>;
  isAlive?: (pid: number) => boolean;
  readStartIdentity?: (pid: number) => string | null;
}

export async function runDaemonCli(
  argv: string[],
  options: DaemonCliOptions = {},
): Promise<number> {
  const log = options.log ?? ((line: string) => console.log(line));
  const error = options.error ?? ((line: string) => console.error(line));
  const [cmd, ...rest] = argv;
  if (!cmd || cmd === "-h" || cmd === "--help") {
    log(CLI_USAGE);
    return cmd ? 0 : 1;
  }
  if (cmd !== "start" && cmd !== "status" && cmd !== "stop") {
    error(`unknown daemon command: ${cmd}`);
    error(CLI_USAGE);
    return 1;
  }

  const repoRoot = resolve(
    arg("--repo", rest) ?? options.cwd ?? process.cwd(),
  );
  try {
    if (cmd === "start") {
      return await runStart(repoRoot, rest, log, error, options);
    }
    if (cmd === "status") {
      return await runStatus(repoRoot, rest, log, options);
    }
    return await runStop(repoRoot, rest, log, error, options);
  } catch (caught) {
    error(errorMessage(caught));
    return 1;
  }
}

// ---------------------------------------------------------------------------
// start
// ---------------------------------------------------------------------------

async function runStart(
  repoRoot: string,
  argv: string[],
  log: (line: string) => void,
  error: (line: string) => void,
  options: DaemonCliOptions,
): Promise<number> {
  const portRaw = arg("--port", argv);
  const port = portRaw === undefined ? 0 : Number(portRaw);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    error(`--port must be an integer from 0 to 65535 (got ${portRaw})`);
    return 1;
  }

  const daemon = await startDaemon({
    repoRoot,
    port,
    openStore: options.openStore,
    isAlive: options.isAlive,
    readStartIdentity: options.readStartIdentity,
  });

  // Install handlers before announcing the address so a supervisor that reads
  // the line can signal immediately without racing startup.
  const handlers: Array<[NodeJS.Signals, () => void]> = [];
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    const handler = (): void => {
      void daemon.stop(signal);
    };
    process.on(signal, handler);
    handlers.push([signal, handler]);
  }

  try {
    log(
      JSON.stringify({
        event: "listening",
        pid: daemon.info.pid,
        host: daemon.info.address.host,
        port: daemon.info.address.port,
        address: daemon.info.addressText,
        repoRoot: daemon.info.repoRoot,
        storePath: daemon.info.storePath,
        backend: daemon.info.backend,
        holderId: daemon.info.holderId,
        startedAt: daemon.info.startedAt,
      }),
    );
    await options.onStarted?.(daemon);
    const result = await daemon.waitForStop();
    log(
      JSON.stringify({
        event: "stopped",
        pid: result.pid,
        address: `${result.address.host}:${result.address.port}`,
        reason: result.reason,
        leaseReleased: result.leaseReleased,
        storeClosed: result.storeClosed,
        errors: result.errors,
      }),
    );
    return result.errors.length > 0 || result.reason.startsWith("server-error")
      ? 1
      : 0;
  } finally {
    for (const [signal, handler] of handlers) process.off(signal, handler);
    if (daemon.state !== "stopped") {
      await daemon.stop("cli-exit").catch(() => {});
    }
  }
}

// ---------------------------------------------------------------------------
// status
// ---------------------------------------------------------------------------

async function runStatus(
  repoRoot: string,
  argv: string[],
  log: (line: string) => void,
  options: DaemonCliOptions,
): Promise<number> {
  const paths = daemonStatePaths(repoRoot);
  const leases = openLeaseOps(paths, options);
  try {
    const inspection = await leases.inspect(checkOptions(options));
    const payload = statusPayload(paths, inspection);
    if (has("--json", argv)) {
      log(JSON.stringify(payload, null, 2));
    } else {
      printStatus(payload, log);
    }
    return inspection.state === "invalid" ||
      inspection.state === "foreign-host"
      ? 1
      : 0;
  } finally {
    leases.close();
  }
}

interface StatusPayload {
  event: "status";
  state: DaemonLeaseInspection["state"];
  repoRoot: string;
  storePath: string | null;
  backend: string | null;
  pid: number | null;
  host: string | null;
  port: number | null;
  address: string | null;
  holderId: string | null;
  startedAt: string | null;
  processStartIdentity: string | null;
  lease: DaemonLeaseInspection["lease"];
  detail: string | null;
}

function statusPayload(
  paths: ReturnType<typeof daemonStatePaths>,
  inspection: DaemonLeaseInspection,
): StatusPayload {
  const hasSqlite = existsSync(paths.sqlitePath);
  const hasFacts = existsSync(paths.factsPath);
  const storePath = hasSqlite
    ? paths.sqlitePath
    : hasFacts
      ? paths.factsPath
      : null;
  const backend = hasSqlite
    ? "better-sqlite3"
    : hasFacts
      ? "json-file"
      : null;
  const lease = inspection.lease;
  return {
    event: "status",
    state: inspection.state,
    repoRoot: paths.repoRoot,
    storePath,
    backend,
    pid: lease?.pid ?? null,
    host: lease?.address.host ?? null,
    port: lease?.address.port ?? null,
    address:
      lease === null
        ? null
        : `${lease.address.host}:${lease.address.port}`,
    holderId: lease?.holderId ?? null,
    startedAt: lease?.startedAt ?? null,
    processStartIdentity: lease?.processStartIdentity ?? null,
    lease,
    detail: inspection.detail,
  };
}

function printStatus(
  payload: StatusPayload,
  log: (line: string) => void,
): void {
  switch (payload.state) {
    case "free":
      log("cliyardd status: stopped (no lease)");
      return;
    case "stale":
      log(
        `cliyardd status: stale lease pid=${payload.pid} ` +
          `holder=${payload.holderId} (${payload.detail ?? "owner is gone"})`,
      );
      return;
    case "held":
      log(
        `cliyardd status: running pid=${payload.pid} ` +
          `address=${payload.address} holder=${payload.holderId}`,
      );
      return;
    case "foreign-host":
      log(
        `cliyardd status: held on another host (${payload.lease?.host ?? "unknown"}); ` +
          "refusing to guess",
      );
      return;
    case "invalid":
      log(`cliyardd status: invalid lease (${payload.detail ?? "unreadable"})`);
      return;
  }
}

// ---------------------------------------------------------------------------
// stop
// ---------------------------------------------------------------------------

async function runStop(
  repoRoot: string,
  argv: string[],
  log: (line: string) => void,
  error: (line: string) => void,
  options: DaemonCliOptions,
): Promise<number> {
  const timeoutRaw = arg("--timeout", argv);
  const timeoutMs =
    timeoutRaw === undefined ? DEFAULT_STOP_TIMEOUT_MS : Number(timeoutRaw);
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
    error(`--timeout must be a positive integer (got ${timeoutRaw})`);
    return 1;
  }
  const asJson = has("--json", argv);
  const sleep =
    options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const sendSignal =
    options.sendSignal ??
    ((pid: number, signal: NodeJS.Signals) => process.kill(pid, signal));

  const paths = daemonStatePaths(repoRoot);
  const leases = openLeaseOps(paths, options);
  try {
    const inspection = await leases.inspect(checkOptions(options));
    if (inspection.state === "free") {
      printStop(
        asJson,
        log,
        { event: "stop", state: "stopped", pid: null, address: null },
      );
      return 0;
    }
    if (inspection.state === "invalid") {
      error(
        `cannot stop: daemon lease is unreadable (${inspection.detail ?? "invalid"})`,
      );
      return 1;
    }
    if (inspection.state === "foreign-host") {
      error(
        `cannot stop: the lease belongs to host ` +
          `${JSON.stringify(inspection.lease?.host ?? "unknown")}; ` +
          "refusing to signal a process on this host",
      );
      return 1;
    }
    if (inspection.state === "stale" || inspection.lease === null) {
      printStop(asJson, log, {
        event: "stop",
        state: "stale",
        pid: inspection.lease?.pid ?? null,
        address: null,
        detail: inspection.detail,
      });
      return 0;
    }

    const lease = inspection.lease;
    if (inspection.identityVerified !== true) {
      error(
        `cannot stop pid ${lease.pid}: the lease does not carry a verified ` +
          "OS process start identity; refusing to signal an unverified pid " +
          "(needs human)",
      );
      return 1;
    }

    try {
      sendSignal(lease.pid, "SIGTERM");
    } catch (caught) {
      if ((caught as NodeJS.ErrnoException).code === "ESRCH") {
        printStop(asJson, log, {
          event: "stop",
          state: "stale",
          pid: lease.pid,
          address: addressText(lease.address),
          detail: "process is already gone",
        });
        return 0;
      }
      error(`cannot signal pid ${lease.pid}: ${errorMessage(caught)}`);
      return 1;
    }

    const startedAt = Date.now();
    for (;;) {
      const current = await leases.inspect(checkOptions(options));
      if (
        current.state === "free" ||
        current.lease === null ||
        current.lease.holderId !== lease.holderId
      ) {
        printStop(asJson, log, {
          event: "stop",
          state: "stopped",
          pid: lease.pid,
          address: addressText(lease.address),
          waitedMs: Date.now() - startedAt,
        });
        return 0;
      }
      if (Date.now() - startedAt >= timeoutMs) {
        error(
          `cliyardd pid ${lease.pid} did not release the lease within ` +
            `${timeoutMs} ms`,
        );
        return 1;
      }
      await sleep(STOP_POLL_MS);
    }
  } finally {
    leases.close();
  }
}

function printStop(
  asJson: boolean,
  log: (line: string) => void,
  payload: Record<string, unknown>,
): void {
  log(
    asJson
      ? JSON.stringify(payload, null, 2)
      : `cliyardd stop: ${String(payload.state)}` +
          (payload.pid === null ? "" : ` (pid ${String(payload.pid)})`),
  );
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function openLeaseOps(
  paths: ReturnType<typeof daemonStatePaths>,
  options: DaemonCliOptions,
): DaemonLeaseOps {
  return options.openLeaseOps?.(paths) ?? createFileLeaseOps(paths);
}

function checkOptions(options: DaemonCliOptions): DaemonLeaseCheckOptions {
  return {
    isAlive: options.isAlive,
    readStartIdentity: options.readStartIdentity,
  };
}

function addressText(address: DaemonAddress): string {
  return `${address.host}:${address.port}`;
}

function arg(flag: string, argv: string[]): string | undefined {
  const index = argv.indexOf(flag);
  if (index >= 0 && argv[index + 1] && !argv[index + 1]!.startsWith("--")) {
    return argv[index + 1];
  }
  const equals = argv.find((entry) => entry.startsWith(`${flag}=`));
  return equals?.slice(flag.length + 1);
}

function has(flag: string, argv: string[]): boolean {
  return argv.includes(flag);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// Re-exported so tests and embedders do not need to reach into core for the
// common error names.
export { DaemonLeaseHeldError };

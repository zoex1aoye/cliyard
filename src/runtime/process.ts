/**
 * Single-host process identity inspection for runtime orphan recovery
 * (design/runtime-orphan-reaper-v0.md).
 *
 * Recovery must distinguish "the recorded pid is still running" from "the
 * recorded pid was reused by an unrelated process". The portable, dependency-
 * free evidence for that is the OS-reported process start identity from `ps`:
 * `(pid, pgid, lstart)`. Everything here is read-only.
 *
 * Missing or partial identity is reported as `unknown` — never guessed — so
 * old manifests fail closed instead of authorizing a kill.
 */
import { execFile } from "node:child_process";
import { hostname } from "node:os";
import type { RuntimeOwner, RuntimeProcessIdentity } from "./types.js";

const DEFAULT_PS_TIMEOUT_MS = 5_000;
const MAX_PS_OUTPUT_BYTES = 8 * 1024 * 1024;
const SUPPORTED_PLATFORMS: ReadonlySet<NodeJS.Platform> = new Set<NodeJS.Platform>(
  ["darwin", "linux"],
);

/** pid, pgid, then the remaining text is `lstart` (which contains spaces). */
const PS_ROW_PATTERN = /^\s*(\d+)\s+(\d+)\s+(.+?)\s*$/;

/** One process that belongs to an inspected process group. */
export type ProcessGroupMember = RuntimeProcessIdentity;

/**
 * - `match`: every component of the exact identity agrees.
 * - `mismatch`: at least one component differs (including a reused pid).
 * - `unknown`: either side is absent/incomplete or the process is not running.
 *   Callers must treat this as unsafe, never as ownership.
 */
export type ProcessIdentityComparison = "match" | "mismatch" | "unknown";

/**
 * - `alive`: same host and the pid exists.
 * - `dead`: same host and the pid does not exist.
 * - `foreign-host`: liveness cannot be checked from this host.
 * - `unknown`: owner metadata is absent or malformed.
 */
export type RuntimeOwnerState = "alive" | "dead" | "foreign-host" | "unknown";

export interface ProcessInspectorOptions {
  /** Local hostname for same-host checks (default `os.hostname()`). */
  host?: string;
  /** `ps` executable (default `"ps"`). */
  psPath?: string;
  /** Timeout for one `ps` invocation (default 5s). */
  timeoutMs?: number;
  /** Platform gate (default `process.platform`); tests can simulate others. */
  platform?: NodeJS.Platform;
}

export class ProcessInspectorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

export class ProcessInspectorUnsupportedPlatformError extends ProcessInspectorError {}

interface PsResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/**
 * Read-only inspector. Identity capture and group listing require macOS or
 * Linux; pid liveness works wherever `process.kill(pid, 0)` works.
 */
export class ProcessInspector {
  /** This host's normalized name, used for same-host checks. */
  readonly host: string;
  /** Whether `ps`-based identity capture is supported here. */
  readonly supported: boolean;

  private readonly platform: NodeJS.Platform;
  private readonly psPath: string;
  private readonly timeoutMs: number;

  constructor(options: ProcessInspectorOptions = {}) {
    if (options === null || typeof options !== "object") {
      throw new ProcessInspectorError("ProcessInspector options must be an object");
    }

    this.platform = options.platform ?? process.platform;
    this.supported = SUPPORTED_PLATFORMS.has(this.platform);

    this.psPath = options.psPath ?? "ps";
    if (typeof this.psPath !== "string" || this.psPath.trim() === "") {
      throw new ProcessInspectorError("psPath must be a non-empty string");
    }

    const timeoutMs = options.timeoutMs ?? DEFAULT_PS_TIMEOUT_MS;
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      throw new ProcessInspectorError("timeoutMs must be a positive number");
    }
    this.timeoutMs = timeoutMs;

    const host = options.host ?? hostname();
    if (typeof host !== "string" || host.trim() === "") {
      throw new ProcessInspectorError("host must be a non-empty string");
    }
    this.host = host.trim();
  }

  /** Case-insensitive, whitespace-trimmed host comparison. */
  isSameHost(host: string | undefined): boolean {
    if (typeof host !== "string") return false;
    const normalized = host.trim().toLowerCase();
    return normalized !== "" && normalized === this.host.toLowerCase();
  }

  /**
   * Same-host pid liveness via signal 0.
   *
   * Only `ESRCH` proves absence. `EPERM` (and any other enumeration limit)
   * keeps the process "alive", because claiming death would authorize recovery
   * against a process that may still be running.
   */
  isAlive(pid: number | undefined): boolean {
    if (!isProcessPid(pid)) return false;
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code !== "ESRCH";
    }
  }

  /**
   * Liveness that respects the persisted owner host: a foreign host is never
   * probed on this machine, and an absent owner stays unknown.
   */
  ownerState(owner: RuntimeOwner | undefined): RuntimeOwnerState {
    if (!isRuntimeOwner(owner)) return "unknown";
    if (!this.isSameHost(owner.host)) return "foreign-host";
    return this.isAlive(owner.pid) ? "alive" : "dead";
  }

  /**
   * Capture the exact identity of `pid` from `ps -o pgid=,lstart=`.
   *
   * Returns `undefined` when the pid is absent, invalid, or the process has
   * already exited — i.e. "no identity", never a guessed one. A `ps` failure
   * (missing binary, timeout, unexpected exit) is thrown so callers can fail
   * closed rather than misclassify the process as gone.
   */
  async capture(pid: number | undefined): Promise<RuntimeProcessIdentity | undefined> {
    if (!isProcessPid(pid)) return undefined;
    this.assertSupported("capture process identity");

    const result = await this.exec([
      "-p",
      String(pid),
      "-o",
      "pid=",
      "-o",
      "pgid=",
      "-o",
      "lstart=",
    ]);

    const row = firstNonEmptyLine(result.stdout);
    if (row === undefined) {
      // `ps -p` exits 1 when no process matches; both macOS and Linux also use
      // exit 1 for "pid out of range", which is equally a non-existent pid.
      if (result.exitCode === 0 || result.exitCode === 1) return undefined;
      throw this.psFailure("capture process identity", result);
    }

    const identity = parsePsRow(row);
    if (
      identity === undefined ||
      identity.pid !== pid ||
      !isProcessIdentity(identity)
    ) {
      throw new ProcessInspectorError(
        `cannot parse ps identity for pid ${pid}: ${JSON.stringify(row)}`,
      );
    }
    return identity;
  }

  /**
   * List every process in `pgid`, including the leader, ordered by pid.
   * An invalid or absent pgid yields `[]`; a `ps` failure throws.
   */
  async listGroupMembers(pgid: number | undefined): Promise<ProcessGroupMember[]> {
    if (!isProcessPid(pgid)) return [];
    this.assertSupported("list process group members");

    const result = await this.exec([
      "-A",
      "-o",
      "pid=",
      "-o",
      "pgid=",
      "-o",
      "lstart=",
    ]);
    if (result.exitCode !== 0) {
      throw this.psFailure("list process group members", result);
    }

    const members: ProcessGroupMember[] = [];
    for (const line of result.stdout.split(/\r?\n/)) {
      if (line.trim() === "") continue;
      const row = parsePsRow(line);
      if (row === undefined) {
        // Never silently under-report a group: an unparseable row must fail
        // closed, because a missed member would make the group look gone.
        throw new ProcessInspectorError(
          `cannot parse ps process row: ${JSON.stringify(line)}`,
        );
      }
      if (row.pgid === pgid && isProcessPid(row.pid)) members.push(row);
    }

    members.sort((a, b) => a.pid - b.pid);
    return members;
  }

  private assertSupported(action: string): void {
    if (this.supported) return;
    throw new ProcessInspectorUnsupportedPlatformError(
      `cannot ${action} on ${this.platform}: ` +
        "process identity inspection requires macOS or Linux",
    );
  }

  private exec(args: readonly string[]): Promise<PsResult> {
    return new Promise<PsResult>((resolveExec, rejectExec) => {
      execFile(
        this.psPath,
        [...args],
        {
          encoding: "utf8",
          timeout: this.timeoutMs,
          maxBuffer: MAX_PS_OUTPUT_BYTES,
          windowsHide: true,
          // Fixed locale/timezone keep `lstart` stable across sessions,
          // otherwise the same process could compare as a mismatch later.
          env: { ...process.env, LC_ALL: "C", LANG: "C", TZ: "UTC" },
        },
        (error, stdout, stderr) => {
          if (error === null) {
            resolveExec({ stdout, stderr, exitCode: 0 });
            return;
          }
          const errno = error as NodeJS.ErrnoException & {
            killed?: boolean;
          };
          if (errno.killed === true) {
            rejectExec(
              new ProcessInspectorError(
                `${this.psPath} timed out after ${this.timeoutMs}ms`,
              ),
            );
            return;
          }
          if (typeof errno.code === "number") {
            resolveExec({ stdout, stderr, exitCode: errno.code });
            return;
          }
          rejectExec(
            new ProcessInspectorError(
              `cannot run ${JSON.stringify(this.psPath)}: ${error.message}`,
            ),
          );
        },
      );
    });
  }

  private psFailure(action: string, result: PsResult): ProcessInspectorError {
    const detail = result.stderr.trim() || result.stdout.trim() || "no output";
    return new ProcessInspectorError(
      `cannot ${action}: ps exited ${result.exitCode}: ${detail}`,
    );
  }
}

/** `true` for positive integer pids (and process group ids). */
export function isProcessPid(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

/** Complete identity only; partial identities are unknown, never completed. */
export function isProcessIdentity(
  value: unknown,
): value is RuntimeProcessIdentity {
  if (!isRecord(value)) return false;
  return (
    isProcessPid(value.pid) &&
    isProcessPid(value.pgid) &&
    typeof value.startedAt === "string" &&
    normalizeStartIdentity(value.startedAt) !== ""
  );
}

export function isRuntimeOwner(value: unknown): value is RuntimeOwner {
  if (!isRecord(value)) return false;
  return (
    isProcessPid(value.pid) &&
    typeof value.host === "string" &&
    value.host.trim() !== ""
  );
}

/**
 * Compare the exact persisted identity with the observed one.
 *
 * `unknown` when either side is missing or malformed (legacy manifests, a
 * process that already exited, a capture race). Callers must treat unknown as
 * `needs_human`, never as a match or as proof that a group is gone.
 */
export function compareProcessIdentity(
  expected: unknown,
  observed: unknown,
): ProcessIdentityComparison {
  if (!isProcessIdentity(expected) || !isProcessIdentity(observed)) {
    return "unknown";
  }
  if (expected.pid !== observed.pid) return "mismatch";
  if (expected.pgid !== observed.pgid) return "mismatch";
  if (
    normalizeStartIdentity(expected.startedAt) !==
    normalizeStartIdentity(observed.startedAt)
  ) {
    return "mismatch";
  }
  return "match";
}

function parsePsRow(row: string): RuntimeProcessIdentity | undefined {
  const match = PS_ROW_PATTERN.exec(row);
  if (match === null) return undefined;
  const pid = Number(match[1]);
  const pgid = Number(match[2]);
  const startedAt = normalizeStartIdentity(match[3]);
  if (
    !Number.isInteger(pid) ||
    pid < 0 ||
    !Number.isInteger(pgid) ||
    pgid < 0 ||
    startedAt === ""
  ) {
    return undefined;
  }
  return { pid, pgid, startedAt };
}

function firstNonEmptyLine(text: string): string | undefined {
  for (const line of text.split(/\r?\n/)) {
    if (line.trim() !== "") return line;
  }
  return undefined;
}

function normalizeStartIdentity(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

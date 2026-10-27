/**
 * Destructive orphan recovery executor (design/runtime-orphan-reaper-v0.md).
 *
 * Safety planning lives in `reaper.ts`; this module may only act on
 * `safe_to_reap` plans from that preflight. For each approved runtime it:
 *
 *   SIGTERM every proven service group in reverse start order
 *     → wait for group exit, escalate to SIGKILL after the grace period
 *     → confirm every leased port binds on 127.0.0.1
 *     → release only the exact preflight-correlated leases
 *     → atomically append the recovery record and final cleanup state
 *
 * The whole reconciliation runs under `<repoRoot>/.cliyard/runtime/reaper.lock`
 * so concurrent reapers are serialized. Any uncertainty or cleanup failure
 * preserves the remaining process groups and leases, leaves `cleanup: failed`,
 * and reports `needs_human` — never `reaped`.
 */
import { randomUUID } from "node:crypto";
import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { hostname } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { isProcessAlive, isSameHost } from "../supervisor/store.js";
import { PortAllocator, portAllocatorPaths, probePort } from "./ports.js";
import {
  ProcessInspector,
  compareProcessIdentity,
  isProcessIdentity,
} from "./process.js";
import {
  preflightOrphanedRuntimes,
  type RuntimeReapLeaseSource,
  type RuntimeReapPlan,
  type RuntimeReapServicePlan,
} from "./reaper.js";
import type {
  PortLease,
  RuntimeManifest,
  RuntimeRecoveryRecord,
  RuntimeRecoveryServiceRecord,
  RuntimeRecoveryState,
} from "./types.js";

export const REAPER_LOCK_FILE = "reaper.lock";

const DEFAULT_STOP_GRACE_MS = 5_000;
const DEFAULT_KILL_GRACE_MS = 5_000;
const DEFAULT_PORT_RELEASE_TIMEOUT_MS = 5_000;
const DEFAULT_LOCK_WAIT_MS = 15_000;
const LOCK_POLL_MS = 20;
const GROUP_POLL_MS = 25;
const PORT_POLL_MS = 50;
/** Age after which a lock with an unreadable/foreign owner is abandoned. */
const UNKNOWN_OWNER_STALE_MS = 5 * 60_000;

// ---------------------------------------------------------------------------
// Public shapes
// ---------------------------------------------------------------------------

/** Exact-lease store used for preflight correlation and release. */
export interface RuntimeReapExecuteAllocator extends RuntimeReapLeaseSource {
  release(lease: PortLease): Promise<boolean>;
}

export interface RuntimeReapExecuteOptions {
  /** Local hostname for same-host checks (default `os.hostname()`). */
  host?: string;
  /** Process inspector override (default a `ProcessInspector` for `host`). */
  inspector?: ProcessInspector;
  /** Lease store override (default a `PortAllocator` rooted at `repoRoot`). */
  allocator?: RuntimeReapExecuteAllocator;
  /** Port availability probe (default {@link probePort}). */
  isPortAvailable?: (port: number) => Promise<boolean>;
  /** Time a proven group gets to exit after SIGTERM (default 5s). */
  stopGraceMs?: number;
  /** Time to wait after SIGKILL before declaring the group unkillable (5s). */
  killGraceMs?: number;
  /** Time to wait for a leased port to become bindable (default 5s). */
  portReleaseTimeoutMs?: number;
  /** Maximum wait for the cross-process reaper lock (default 15s). */
  lockTimeoutMs?: number;
}

export interface RuntimeReapReport {
  /** Number of runtime manifest files examined by preflight. */
  scanned: number;
  reaped: RuntimeRecoveryRecord[];
  needsHuman: RuntimeRecoveryRecord[];
  skipped: RuntimeRecoveryRecord[];
}

export class RuntimeReaperExecuteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

export class RuntimeReaperLockError extends RuntimeReaperExecuteError {}

/** `<repoRoot>/.cliyard/runtime/reaper.lock` */
export function reaperLockPath(repoRoot: string): string {
  return join(portAllocatorPaths(repoRoot).runtimeDir, REAPER_LOCK_FILE);
}

// ---------------------------------------------------------------------------
// Reconciliation
// ---------------------------------------------------------------------------

/**
 * Preflight every runtime and execute only `safe_to_reap` plans.
 *
 * Plans classified `needs_human` or `skip` are reported but never touch a
 * process, lease, or manifest — preflight already proved that acting would be
 * unsafe or pointless.
 */
export async function reapOrphanedRuntimes(
  repoRoot: string,
  options: RuntimeReapExecuteOptions = {},
): Promise<RuntimeReapReport> {
  if (typeof repoRoot !== "string" || repoRoot.trim() === "") {
    throw new RuntimeReaperExecuteError("repoRoot must be a non-empty string");
  }
  if (options === null || typeof options !== "object") {
    throw new RuntimeReaperExecuteError("options must be an object");
  }

  const root = resolve(repoRoot);
  const inspector =
    options.inspector ?? new ProcessInspector({ host: options.host });

  let allocator: RuntimeReapExecuteAllocator;
  if (options.allocator !== undefined) {
    if (
      typeof options.allocator.list !== "function" ||
      typeof options.allocator.release !== "function"
    ) {
      throw new RuntimeReaperExecuteError(
        "allocator must implement list() and release()",
      );
    }
    allocator = options.allocator;
  } else {
    allocator = new PortAllocator({ repoRoot: root });
  }

  const deps: ExecutionDeps = {
    inspector,
    allocator,
    isPortAvailable: options.isPortAvailable ?? probePort,
    stopGraceMs: positiveInteger(
      options.stopGraceMs,
      DEFAULT_STOP_GRACE_MS,
      "stopGraceMs",
    ),
    killGraceMs: positiveInteger(
      options.killGraceMs,
      DEFAULT_KILL_GRACE_MS,
      "killGraceMs",
    ),
    portReleaseTimeoutMs: positiveInteger(
      options.portReleaseTimeoutMs,
      DEFAULT_PORT_RELEASE_TIMEOUT_MS,
      "portReleaseTimeoutMs",
    ),
    reaperHost: hostname(),
  };
  const lockTimeoutMs = positiveInteger(
    options.lockTimeoutMs,
    DEFAULT_LOCK_WAIT_MS,
    "lockTimeoutMs",
  );

  // The lock is acquired before preflight so a second reaper observes the
  // first one's finalized manifests instead of planning from stale evidence.
  const releaseLock = await acquireReaperLock(
    reaperLockPath(root),
    lockTimeoutMs,
  );
  try {
    const preflight = await preflightOrphanedRuntimes(root, {
      inspector,
      allocator,
    });

    const report: RuntimeReapReport = {
      scanned: preflight.scanned,
      reaped: [],
      needsHuman: [],
      skipped: [],
    };

    for (const plan of preflight.plans) {
      if (plan.state === "skip") {
        report.skipped.push(
          makeRecord(
            plan.runtimeId,
            "skipped",
            plan.reason,
            plan.services,
            deps.reaperHost,
          ),
        );
        continue;
      }
      if (plan.state === "needs_human") {
        report.needsHuman.push(
          makeRecord(
            plan.runtimeId,
            "needs_human",
            plan.reason,
            plan.services,
            deps.reaperHost,
          ),
        );
        continue;
      }

      const record = await executeSafePlan(plan, deps);
      if (record.state === "reaped") {
        report.reaped.push(record);
      } else {
        report.needsHuman.push(record);
      }
    }

    return report;
  } finally {
    releaseLock();
  }
}

interface ExecutionDeps {
  inspector: ProcessInspector;
  allocator: RuntimeReapExecuteAllocator;
  isPortAvailable: (port: number) => Promise<boolean>;
  stopGraceMs: number;
  killGraceMs: number;
  portReleaseTimeoutMs: number;
  reaperHost: string;
}

interface ServiceExecution {
  plan: RuntimeReapServicePlan;
  action: RuntimeRecoveryServiceRecord["action"];
  portReleased: boolean;
  failure?: string;
}

/**
 * Execute one preflight-approved plan. Returns the record to report; whenever
 * anything is uncertain or fails, the record is `needs_human` and the manifest
 * is finalized with `cleanup: failed` instead of `complete`.
 */
async function executeSafePlan(
  plan: RuntimeReapPlan,
  deps: ExecutionDeps,
): Promise<RuntimeRecoveryRecord> {
  if (plan.manifest === undefined) {
    return makeRecord(
      plan.runtimeId,
      "needs_human",
      "safe plan has no parsed manifest; refusing to act",
      plan.services,
      deps.reaperHost,
    );
  }

  const executions = new Map<string, ServiceExecution>();
  const failures: string[] = [];

  // Reverse start order, mirroring dependency shutdown.
  for (const service of [...plan.services].reverse()) {
    const execution = await executeService(service, deps);
    executions.set(service.name, execution);
    if (execution.failure !== undefined) failures.push(execution.failure);
  }

  // Only release leases once every proven group is gone and every leased port
  // is bindable. Preserving all leases on failure keeps the runtime
  // reconcilable after a human fixes the underlying problem.
  if (failures.length === 0) {
    failures.push(...(await checkPorts(plan.services, executions, deps)));
  }
  if (failures.length === 0) {
    failures.push(...(await releaseLeases(plan.services, executions, deps)));
  }

  const state: RuntimeRecoveryState =
    failures.length === 0 ? "reaped" : "needs_human";
  const services = recordServices(plan.services, executions);
  const reason =
    state === "reaped"
      ? reapedReason(plan, services)
      : `orphan recovery failed: ${failures.join("; ")}`;

  const record = makeRecord(
    plan.runtimeId,
    state,
    reason,
    plan.services,
    deps.reaperHost,
  );
  record.services = services;

  try {
    persistRecovery(plan.manifestPath, plan.runtimeId, record);
  } catch (error) {
    // Processes/leases may already be cleaned up, but evidence could not be
    // recorded: report the truth rather than claiming a completed recovery.
    return {
      ...record,
      state: "needs_human",
      reason:
        `${reason}; cannot persist recovery evidence: ` +
        `${errorMessage(error)}`,
    };
  }

  return record;
}

async function executeService(
  service: RuntimeReapServicePlan,
  deps: ExecutionDeps,
): Promise<ServiceExecution> {
  const name = JSON.stringify(service.name);

  if (service.action === "none") {
    return { plan: service, action: "preserved", portReleased: false };
  }
  if (service.action === "preserve") {
    return {
      plan: service,
      action: "preserved",
      portReleased: false,
      failure: service.reason,
    };
  }
  if (service.action === "already-exited") {
    const group = await inspectGroup(service, deps);
    if (group.error !== undefined) {
      return {
        plan: service,
        action: "preserved",
        portReleased: false,
        failure: group.error,
      };
    }
    if (group.members.length > 0) {
      return {
        plan: service,
        action: "preserved",
        portReleased: false,
        failure:
          `service ${name} leader pid ${service.pid} is gone but process ` +
          `group ${service.pgid} now has ${group.members.length} member(s); ` +
          "ownership cannot be proven",
      };
    }
    return { plan: service, action: "already-exited", portReleased: false };
  }

  return terminateService(service, deps);
}

/**
 * Re-verify the exact identity immediately before signalling, then stop the
 * whole group with bounded SIGTERM → SIGKILL escalation.
 */
async function terminateService(
  service: RuntimeReapServicePlan,
  deps: ExecutionDeps,
): Promise<ServiceExecution> {
  const name = JSON.stringify(service.name);
  const { pid, pgid, processIdentity } = service;

  if (
    pid === undefined ||
    pgid === undefined ||
    !isProcessIdentity(processIdentity)
  ) {
    return {
      plan: service,
      action: "preserved",
      portReleased: false,
      failure:
        `service ${name} lacks a complete pid/pgid/process identity; ` +
        "refusing to signal",
    };
  }

  let observed;
  try {
    observed = await deps.inspector.capture(pid);
  } catch (error) {
    return {
      plan: service,
      action: "preserved",
      portReleased: false,
      failure:
        `service ${name} process identity cannot be inspected: ` +
        errorMessage(error),
    };
  }

  const comparison = compareProcessIdentity(processIdentity, observed);
  if (comparison !== "match") {
    // The leader may have exited between preflight and now. That is only safe
    // when the group is provably empty; otherwise ownership is unproven.
    if (observed === undefined && !deps.inspector.isAlive(pid)) {
      const group = await inspectGroup(service, deps);
      if (group.error !== undefined) {
        return {
          plan: service,
          action: "preserved",
          portReleased: false,
          failure: group.error,
        };
      }
      if (group.members.length === 0) {
        return { plan: service, action: "already-exited", portReleased: false };
      }
      return {
        plan: service,
        action: "preserved",
        portReleased: false,
        failure:
          `service ${name} leader pid ${pid} exited but process group ` +
          `${pgid} still has ${group.members.length} member(s); ` +
          "ownership cannot be proven",
      };
    }
    return {
      plan: service,
      action: "preserved",
      portReleased: false,
      failure:
        `service ${name} identity changed before signalling ` +
        `(${comparison}); refusing to signal pid ${pid}`,
    };
  }

  const termError = sendGroupSignal(pgid, "SIGTERM");
  if (termError !== undefined) {
    return {
      plan: service,
      action: "preserved",
      portReleased: false,
      failure: termError,
    };
  }

  let exit = await waitForGroupExit(pgid, deps.stopGraceMs, deps.inspector);
  if (!exit.gone && exit.failure === undefined) {
    const killError = sendGroupSignal(pgid, "SIGKILL");
    if (killError !== undefined) {
      return {
        plan: service,
        action: "preserved",
        portReleased: false,
        failure: killError,
      };
    }
    exit = await waitForGroupExit(pgid, deps.killGraceMs, deps.inspector);
  }

  if (exit.failure !== undefined) {
    return {
      plan: service,
      action: "preserved",
      portReleased: false,
      failure: exit.failure,
    };
  }
  if (!exit.gone) {
    return {
      plan: service,
      action: "preserved",
      portReleased: false,
      failure:
        `process group ${pgid} for service ${name} survived SIGKILL ` +
        `after ${deps.stopGraceMs}ms + ${deps.killGraceMs}ms grace`,
    };
  }

  return { plan: service, action: "terminated", portReleased: false };
}

// ---------------------------------------------------------------------------
// Port and lease handling
// ---------------------------------------------------------------------------

async function checkPorts(
  services: readonly RuntimeReapServicePlan[],
  executions: ReadonlyMap<string, ServiceExecution>,
  deps: ExecutionDeps,
): Promise<string[]> {
  const failures: string[] = [];
  for (const service of services) {
    const execution = executions.get(service.name);
    const lease = service.lease;
    if (lease === undefined || execution === undefined) continue;
    if (!isGroupGone(execution)) continue;

    let available: boolean;
    try {
      available = await waitForPortBindable(
        lease.port,
        deps.portReleaseTimeoutMs,
        deps.isPortAvailable,
      );
    } catch (error) {
      failures.push(
        `port ${lease.port} for service ${JSON.stringify(service.name)} ` +
          `cannot be probed: ${errorMessage(error)}`,
      );
      continue;
    }
    if (!available) {
      failures.push(
        `port ${lease.port} for service ${JSON.stringify(service.name)} has ` +
          `no process group left but is still not bindable on 127.0.0.1 ` +
          `after ${deps.portReleaseTimeoutMs}ms; lease preserved`,
      );
    }
  }
  return failures;
}

/**
 * Release only leases that still exactly match the preflight correlation.
 * A lease that vanished is already released; a lease with different
 * pid/acquiredAt/port evidence belongs to someone else and is left untouched.
 */
async function releaseLeases(
  services: readonly RuntimeReapServicePlan[],
  executions: ReadonlyMap<string, ServiceExecution>,
  deps: ExecutionDeps,
): Promise<string[]> {
  const failures: string[] = [];

  let current: PortLease[];
  try {
    const listed = deps.allocator.list();
    if (!Array.isArray(listed)) {
      throw new RuntimeReaperExecuteError(
        "allocator.list() did not return an array",
      );
    }
    current = listed;
  } catch (error) {
    return [`cannot re-read port leases before release: ${errorMessage(error)}`];
  }

  for (const service of services) {
    const execution = executions.get(service.name);
    const lease = service.lease;
    if (lease === undefined || execution === undefined) continue;
    if (!isGroupGone(execution)) continue;

    const observed = current.find((entry) => entry.key === lease.key);
    if (observed !== undefined && !isSameLease(observed, lease)) {
      failures.push(
        `lease ${lease.key}@${lease.port} changed since preflight; ` +
          "refusing to release a lease owned by another allocator",
      );
      continue;
    }
    if (observed === undefined) {
      // Already removed; the exact reservation is no longer held.
      execution.portReleased = true;
      continue;
    }

    let released: boolean;
    try {
      released = await deps.allocator.release(lease);
    } catch (error) {
      failures.push(
        `cannot release lease ${lease.key}@${lease.port}: ` +
          errorMessage(error),
      );
      continue;
    }

    if (released) {
      execution.portReleased = true;
      continue;
    }

    // A concurrent actor may have removed the exact lease; that is success.
    let remaining: PortLease[] | undefined;
    try {
      remaining = deps.allocator.list();
    } catch {
      remaining = undefined;
    }
    if (
      remaining !== undefined &&
      !remaining.some((entry) => isSameLease(entry, lease))
    ) {
      execution.portReleased = true;
      continue;
    }
    failures.push(
      `lease ${lease.key}@${lease.port} was not released and is still held`,
    );
  }

  return failures;
}

function isGroupGone(execution: ServiceExecution): boolean {
  return (
    execution.action === "terminated" || execution.action === "already-exited"
  );
}

// ---------------------------------------------------------------------------
// Evidence persistence
// ---------------------------------------------------------------------------

function makeRecord(
  runtimeId: string,
  state: RuntimeRecoveryState,
  reason: string,
  services: readonly RuntimeReapServicePlan[],
  reaperHost: string,
): RuntimeRecoveryRecord {
  return {
    runtimeId,
    state,
    reason,
    at: new Date().toISOString(),
    reaperPid: process.pid,
    reaperHost,
    services: services.map((service) => ({
      name: service.name,
      ...(service.pgid !== undefined ? { pgid: service.pgid } : {}),
      action: "preserved",
      portReleased: false,
    })),
  };
}

function recordServices(
  services: readonly RuntimeReapServicePlan[],
  executions: ReadonlyMap<string, ServiceExecution>,
): RuntimeRecoveryServiceRecord[] {
  return services.map((service) => {
    const execution = executions.get(service.name);
    return {
      name: service.name,
      ...(service.pgid !== undefined ? { pgid: service.pgid } : {}),
      action: execution?.action ?? "preserved",
      portReleased: execution?.portReleased ?? false,
    };
  });
}

function reapedReason(
  plan: RuntimeReapPlan,
  services: readonly RuntimeRecoveryServiceRecord[],
): string {
  const terminated = services.filter(
    (service) => service.action === "terminated",
  ).length;
  const alreadyExited = services.filter(
    (service) => service.action === "already-exited",
  ).length;
  const released = services.filter((service) => service.portReleased).length;
  return (
    `${plan.reason}; terminated ${terminated} group(s), ` +
    `${alreadyExited} already exited, released ${released} exact lease(s); ` +
    "all leased ports bindable"
  );
}

/**
 * Re-read the manifest, apply the recovery record and final cleanup state, and
 * replace it atomically so readers never observe a partial record.
 */
function persistRecovery(
  manifestPath: string,
  runtimeId: string,
  record: RuntimeRecoveryRecord,
): void {
  const raw = readFileSync(manifestPath, "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch (error) {
    throw new RuntimeReaperExecuteError(
      `invalid JSON in runtime manifest ${manifestPath}: ${errorMessage(error)}`,
    );
  }
  if (!isRecord(parsed) || parsed.runtimeId !== runtimeId) {
    throw new RuntimeReaperExecuteError(
      `runtime manifest ${manifestPath} no longer describes ` +
        JSON.stringify(runtimeId),
    );
  }

  const manifest = parsed as unknown as RuntimeManifest;
  if (record.state === "reaped") {
    manifest.cleanup = "complete";
    manifest.stoppedAt ??= record.at;
  } else {
    manifest.cleanup = "failed";
    manifest.failureReason = [manifest.failureReason, `reaper: ${record.reason}`]
      .filter(Boolean)
      .join("; ");
  }
  manifest.recovery = record;
  writeManifestAtomic(manifestPath, manifest);
}

/** Temp file + fsync + rename; readers see the old or new manifest, never both. */
function writeManifestAtomic(
  manifestPath: string,
  manifest: RuntimeManifest,
): void {
  const dir = dirname(manifestPath);
  mkdirSync(dir, { recursive: true });
  const tmp = join(
    dir,
    `.${basename(manifestPath)}.${process.pid}.${randomUUID()}.tmp`,
  );
  try {
    const fd = openSync(tmp, "wx", 0o600);
    try {
      writeSync(fd, JSON.stringify(manifest, null, 2) + "\n");
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, manifestPath);
  } catch (error) {
    try {
      unlinkSync(tmp);
    } catch {
      /* best-effort cleanup */
    }
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Process helpers
// ---------------------------------------------------------------------------

/** Returns an error message, or `undefined` when the signal was delivered. */
function sendGroupSignal(
  pgid: number,
  signal: NodeJS.Signals,
): string | undefined {
  try {
    process.kill(-pgid, signal);
    return undefined;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return undefined;
    return (
      `cannot send ${signal} to process group ${pgid}: ` +
      errorMessage(error)
    );
  }
}

async function waitForGroupExit(
  pgid: number,
  timeoutMs: number,
  inspector: ProcessInspector,
): Promise<{ gone: boolean; failure?: string }> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    let members;
    try {
      members = await inspector.listGroupMembers(pgid);
    } catch (error) {
      return {
        gone: false,
        failure:
          `process group ${pgid} cannot be inspected: ` +
          errorMessage(error),
      };
    }
    if (members.length === 0) return { gone: true };
    if (Date.now() >= deadline) return { gone: false };
    await delay(GROUP_POLL_MS);
  }
}

async function inspectGroup(
  service: RuntimeReapServicePlan,
  deps: ExecutionDeps,
): Promise<{ members: unknown[]; error?: string }> {
  if (service.pgid === undefined) {
    return {
      members: [],
      error: `service ${JSON.stringify(service.name)} has no process group`,
    };
  }
  try {
    return { members: await deps.inspector.listGroupMembers(service.pgid) };
  } catch (error) {
    return {
      members: [],
      error:
        `service ${JSON.stringify(service.name)} process group ` +
        `${service.pgid} cannot be inspected: ${errorMessage(error)}`,
    };
  }
}

async function waitForPortBindable(
  port: number,
  timeoutMs: number,
  isPortAvailable: (port: number) => Promise<boolean>,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    let available: boolean;
    try {
      available = await isPortAvailable(port);
    } catch {
      available = false;
    }
    if (available) return true;
    if (Date.now() >= deadline) return false;
    await delay(PORT_POLL_MS);
  }
}

// ---------------------------------------------------------------------------
// Cross-process reaper lock
// ---------------------------------------------------------------------------

interface ReaperLockInfo {
  pid: number;
  host: string;
  token: string;
  acquiredAt: string;
}

async function acquireReaperLock(
  lockPath: string,
  timeoutMs: number,
): Promise<() => void> {
  mkdirSync(dirname(lockPath), { recursive: true });
  const token = `${process.pid}-${randomUUID()}`;
  const content =
    JSON.stringify({
      pid: process.pid,
      host: hostname(),
      token,
      acquiredAt: new Date().toISOString(),
    } satisfies ReaperLockInfo) + "\n";
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    let fd: number;
    try {
      fd = openSync(lockPath, "wx", 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        throw new RuntimeReaperLockError(
          `cannot create reaper lock ${lockPath}: ${errorMessage(error)}`,
        );
      }
      if (clearStaleReaperLock(lockPath)) continue;
      if (Date.now() >= deadline) {
        throw new RuntimeReaperLockError(
          `timed out waiting for reaper lock: ${lockPath}`,
        );
      }
      await delay(LOCK_POLL_MS);
      continue;
    }

    try {
      writeSync(fd, content);
      fsyncSync(fd);
      closeSync(fd);
    } catch (error) {
      try {
        closeSync(fd);
      } catch {
        /* already closed or invalid */
      }
      try {
        unlinkSync(lockPath);
      } catch {
        /* ignore */
      }
      throw new RuntimeReaperLockError(
        `cannot initialize reaper lock ${lockPath}: ${errorMessage(error)}`,
      );
    }

    let released = false;
    return () => {
      if (released) return;
      released = true;
      try {
        if (readFileSync(lockPath, "utf8") === content) unlinkSync(lockPath);
      } catch {
        /* already released or replaced */
      }
    };
  }
}

/** Remove the lock only when its owner is provably gone. */
function clearStaleReaperLock(lockPath: string): boolean {
  let raw: string;
  try {
    raw = readFileSync(lockPath, "utf8");
  } catch (error) {
    // Vanished between open() and read(): retry acquisition immediately.
    return (error as NodeJS.ErrnoException).code === "ENOENT";
  }

  let info: ReaperLockInfo | undefined;
  try {
    info = parseLockInfo(JSON.parse(raw) as unknown);
  } catch {
    info = undefined;
  }

  let stale: boolean;
  if (info !== undefined && isSameHost(info.host)) {
    // Same host: pid liveness is authoritative even for an old lock.
    stale = !isProcessAlive(info.pid);
  } else {
    // Foreign or unreadable owner: only age can prove abandonment.
    try {
      stale = Date.now() - statSync(lockPath).mtimeMs > UNKNOWN_OWNER_STALE_MS;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "ENOENT";
    }
  }
  if (!stale) return false;

  try {
    // Do not unlink a fresh lock another waiter installed after our check.
    if (readFileSync(lockPath, "utf8") !== raw) return false;
    unlinkSync(lockPath);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT";
  }
}

function parseLockInfo(raw: unknown): ReaperLockInfo {
  if (
    !isRecord(raw) ||
    !Number.isInteger(raw.pid) ||
    (raw.pid as number) <= 0 ||
    typeof raw.host !== "string" ||
    !raw.host.trim() ||
    typeof raw.token !== "string" ||
    !raw.token.trim() ||
    typeof raw.acquiredAt !== "string" ||
    !raw.acquiredAt.trim()
  ) {
    throw new RuntimeReaperExecuteError("invalid reaper lock");
  }
  return {
    pid: raw.pid as number,
    host: raw.host,
    token: raw.token,
    acquiredAt: raw.acquiredAt,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Same identity as `PortAllocator`'s exact-lease comparison. */
function isSameLease(a: PortLease, b: PortLease): boolean {
  return (
    a.key === b.key &&
    a.runId === b.runId &&
    a.service === b.service &&
    a.host === b.host &&
    a.port === b.port &&
    a.pid === b.pid &&
    a.acquiredAt === b.acquiredAt
  );
}

function positiveInteger(
  value: number | undefined,
  fallback: number,
  field: string,
): number {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value) || value <= 0) {
    throw new RuntimeReaperExecuteError(`${field} must be a positive number`);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

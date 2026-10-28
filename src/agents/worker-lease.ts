/**
 * WorkerLease v1 (design/worker-lease-v1.md).
 *
 * A lease is the credential-free, same-host record of which controller owns a
 * worker process group. It is written immediately after spawn, updated with
 * the exact OS identity before a result can be accepted, and updated again
 * with the process-tree cleanup outcome.
 *
 * A lease is observational coordination. It never grants task acceptance and
 * recovery never rewrites a RunManifest.
 */
import { randomUUID } from "node:crypto";
import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
  type Dirent,
} from "node:fs";
import { hostname } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import {
  compareProcessIdentity,
  isProcessIdentity,
  isProcessPid,
  ProcessInspector,
  type ProcessGroupMember,
} from "../runtime/process.js";
import type { RuntimeProcessIdentity } from "../runtime/types.js";
import {
  type ManagedWorkerProcess,
  type WorkerCleanupReason,
  type WorkerCaptureSource,
  type WorkerCleanupState,
  type WorkerProcessCleanupOutcome,
  type WorkerProcessSignalRecord,
  type WorkerProcessTreeInspector,
} from "./process-tree.js";

export const WORKER_LEASE_VERSION = 1 as const;
export const WORKER_LEASES_DIR = "worker-leases";
/** Maximum leases read for one status/recovery observation. */
export const MAX_WORKER_LEASES_SCAN = 512;
/** Maximum persisted recovery observations per lease. */
export const MAX_WORKER_LEASE_RECOVERY = 8;
/** Maximum lease file size considered valid. */
export const MAX_WORKER_LEASE_BYTES = 64 * 1024;
export const MAX_WORKER_LEASE_DETAIL = 600;
export const DEFAULT_LEASE_TERM_GRACE_MS = 2_000;
export const DEFAULT_LEASE_KILL_GRACE_MS = 1_000;
export const DEFAULT_LEASE_POLL_MS = 50;

export type WorkerLeaseState =
  | "active"
  | "released"
  | "cleanup-failed"
  | "unknown";

/** Cleanup reasons plus the same-host recovery path. */
export type WorkerLeaseCleanupReason = WorkerCleanupReason | "recovery";

export type WorkerLeaseCaptureMode = "posix-group" | "windows-exact-child";

export interface WorkerLeaseController {
  pid: number;
  host: string;
  identity: RuntimeProcessIdentity;
}

export interface WorkerLeaseWorker {
  /** Absent only when spawn failed before the OS reported a pid. */
  pid?: number;
  pgid?: number;
  /** Exact `ps lstart` identity. Never synthesized or guessed. */
  osStartIdentity?: string;
  captureMode: WorkerLeaseCaptureMode;
}

/** Bounded process-tree outcome copied onto the lease. */
export interface WorkerLeaseCleanupEvidence {
  processTreeState: WorkerCleanupState;
  captureSource: WorkerCaptureSource;
  residualCount: number;
  signalCount: number;
  detail?: string;
}

/** Append-only same-host recovery observation. */
export interface WorkerLeaseRecoveryEvidence {
  version: 1;
  at: string;
  reaperPid: number;
  reaperHost: string;
  action:
    | "terminated"
    | "already-exited"
    | "preserved"
    | "live-owner"
    | "foreign-host"
    | "invalid";
  outcome: "recovered" | "needs_human" | "skipped";
  reason: string;
  signals: WorkerProcessSignalRecord[];
  residualCount?: number;
}

export interface WorkerLease {
  version: typeof WORKER_LEASE_VERSION;
  leaseId: string;
  repoRoot: string;
  runId: string;
  taskId: string;
  attempt: number;
  invocationId: string;
  controller: WorkerLeaseController;
  worker: WorkerLeaseWorker;
  workspace: string;
  startedAt: string;
  updatedAt: string;
  state: WorkerLeaseState;
  cleanupReason?: WorkerLeaseCleanupReason;
  cleanedAt?: string;
  cleanup?: WorkerLeaseCleanupEvidence;
  recovery?: WorkerLeaseRecoveryEvidence[];
}

export class WorkerLeaseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

export class WorkerLeasePersistenceError extends WorkerLeaseError {}

// ---------------------------------------------------------------------------
// Store paths and strict parsing
// ---------------------------------------------------------------------------

const SEGMENT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const LEASE_STATES: ReadonlySet<string> = new Set<WorkerLeaseState>([
  "active",
  "released",
  "cleanup-failed",
  "unknown",
]);
const CLEANUP_REASONS: ReadonlySet<string> = new Set<WorkerLeaseCleanupReason>([
  "child-close",
  "timeout",
  "cancel",
  "spawn-error",
  "recovery",
]);
const CAPTURE_MODES: ReadonlySet<string> = new Set<WorkerLeaseCaptureMode>([
  "posix-group",
  "windows-exact-child",
]);
const CLEANUP_STATES: ReadonlySet<string> = new Set<WorkerCleanupState>([
  "clean",
  "terminated",
  "failed",
  "unsupported",
]);
const CAPTURE_SOURCES: ReadonlySet<string> = new Set<WorkerCaptureSource>([
  "ps-exact",
  "pgid-reservation",
  "none",
  "unsupported",
]);
const RECOVERY_ACTIONS: ReadonlySet<string> = new Set<
  WorkerLeaseRecoveryEvidence["action"]
>([
  "terminated",
  "already-exited",
  "preserved",
  "live-owner",
  "foreign-host",
  "invalid",
]);
const RECOVERY_OUTCOMES: ReadonlySet<string> = new Set<
  WorkerLeaseRecoveryEvidence["outcome"]
>(["recovered", "needs_human", "skipped"]);

export function workerLeasesDir(repoRoot: string): string {
  return join(resolve(repoRoot), ".cliyard", WORKER_LEASES_DIR);
}

export function workerLeaseDir(
  repoRoot: string,
  runId: string,
  taskId: string,
): string {
  assertSafeSegment(runId, "runId");
  assertSafeSegment(taskId, "taskId");
  return join(workerLeasesDir(repoRoot), runId, taskId);
}

export function workerLeasePath(
  repoRoot: string,
  runId: string,
  taskId: string,
  leaseId: string,
): string {
  assertSafeSegment(leaseId, "leaseId");
  return join(workerLeaseDir(repoRoot, runId, taskId), `${leaseId}.json`);
}

export function isSafeWorkerLeaseSegment(value: unknown): value is string {
  return typeof value === "string" && SEGMENT_PATTERN.test(value);
}

export function parseWorkerLease(value: unknown): WorkerLease | undefined {
  if (!isRecord(value) || value.version !== WORKER_LEASE_VERSION) {
    return undefined;
  }
  const leaseId = value.leaseId;
  const repoRoot = value.repoRoot;
  const runId = value.runId;
  const taskId = value.taskId;
  const invocationId = value.invocationId;
  const workspace = value.workspace;
  if (
    !isSafeWorkerLeaseSegment(leaseId) ||
    typeof repoRoot !== "string" ||
    !isAbsolute(repoRoot) ||
    !isSafeWorkerLeaseSegment(runId) ||
    !isSafeWorkerLeaseSegment(taskId) ||
    !isBoundedText(invocationId, 128) ||
    !isBoundedText(workspace, 4096) ||
    !Number.isInteger(value.attempt) ||
    (value.attempt as number) < 0 ||
    typeof value.startedAt !== "string" ||
    !isTimestamp(value.startedAt) ||
    !isTimestamp(value.updatedAt) ||
    typeof value.state !== "string" ||
    !LEASE_STATES.has(value.state)
  ) {
    return undefined;
  }

  const controller = parseController(value.controller);
  if (!controller) return undefined;
  const worker = parseWorker(value.worker);
  if (!worker) return undefined;

  let cleanupReason: WorkerLeaseCleanupReason | undefined;
  if (value.cleanupReason !== undefined) {
    if (
      typeof value.cleanupReason !== "string" ||
      !CLEANUP_REASONS.has(value.cleanupReason)
    ) {
      return undefined;
    }
    cleanupReason = value.cleanupReason as WorkerLeaseCleanupReason;
  }
  let cleanedAt: string | undefined;
  if (value.cleanedAt !== undefined) {
    if (!isTimestamp(value.cleanedAt)) return undefined;
    cleanedAt = value.cleanedAt;
  }
  const cleanup =
    value.cleanup === undefined
      ? undefined
      : parseCleanupEvidence(value.cleanup);
  if (value.cleanup !== undefined && !cleanup) return undefined;
  const recovery =
    value.recovery === undefined
      ? undefined
      : parseRecoveryEvidence(value.recovery);
  if (value.recovery !== undefined && !recovery) return undefined;

  return {
    version: WORKER_LEASE_VERSION,
    leaseId,
    repoRoot,
    runId,
    taskId,
    attempt: value.attempt as number,
    invocationId,
    controller,
    worker,
    workspace,
    startedAt: value.startedAt,
    updatedAt: value.updatedAt,
    state: value.state as WorkerLeaseState,
    ...(cleanupReason !== undefined ? { cleanupReason } : {}),
    ...(cleanedAt !== undefined ? { cleanedAt } : {}),
    ...(cleanup !== undefined ? { cleanup } : {}),
    ...(recovery !== undefined ? { recovery } : {}),
  };
}

function parseController(value: unknown): WorkerLeaseController | undefined {
  if (!isRecord(value)) return undefined;
  if (
    !isProcessPid(value.pid) ||
    !isBoundedText(value.host, 256) ||
    !isProcessIdentity(value.identity)
  ) {
    return undefined;
  }
  return {
    pid: value.pid,
    host: value.host,
    identity: copyIdentity(value.identity),
  };
}

function parseWorker(value: unknown): WorkerLeaseWorker | undefined {
  if (!isRecord(value)) return undefined;
  const pid = value.pid;
  const pgid = value.pgid;
  const startedAt = value.osStartIdentity;
  if (pid !== undefined && !isProcessPid(pid)) return undefined;
  if (pgid !== undefined && !isProcessPid(pgid)) return undefined;
  if (pgid !== undefined && pid === undefined) return undefined;
  if (startedAt !== undefined) {
    if (
      !isBoundedText(startedAt, 128) ||
      pid === undefined ||
      pgid === undefined
    ) {
      return undefined;
    }
  }
  if (
    typeof value.captureMode !== "string" ||
    !CAPTURE_MODES.has(value.captureMode)
  ) {
    return undefined;
  }
  return {
    ...(pid !== undefined ? { pid } : {}),
    ...(pgid !== undefined ? { pgid } : {}),
    ...(startedAt !== undefined ? { osStartIdentity: startedAt } : {}),
    captureMode: value.captureMode as WorkerLeaseCaptureMode,
  };
}

function parseCleanupEvidence(
  value: unknown,
): WorkerLeaseCleanupEvidence | undefined {
  if (!isRecord(value)) return undefined;
  if (
    typeof value.processTreeState !== "string" ||
    !CLEANUP_STATES.has(value.processTreeState) ||
    typeof value.captureSource !== "string" ||
    !CAPTURE_SOURCES.has(value.captureSource) ||
    !isBoundedCount(value.residualCount) ||
    !isBoundedCount(value.signalCount)
  ) {
    return undefined;
  }
  let detail: string | undefined;
  if (value.detail !== undefined) {
    if (!isBoundedText(value.detail, MAX_WORKER_LEASE_DETAIL)) return undefined;
    detail = value.detail;
  }
  return {
    processTreeState: value.processTreeState as WorkerCleanupState,
    captureSource: value.captureSource as WorkerCaptureSource,
    residualCount: value.residualCount,
    signalCount: value.signalCount,
    ...(detail !== undefined ? { detail } : {}),
  };
}

function parseRecoveryEvidence(
  value: unknown,
): WorkerLeaseRecoveryEvidence[] | undefined {
  if (!Array.isArray(value) || value.length > MAX_WORKER_LEASE_RECOVERY) {
    return undefined;
  }
  const records: WorkerLeaseRecoveryEvidence[] = [];
  for (const raw of value) {
    if (!isRecord(raw) || raw.version !== 1) return undefined;
    if (
      !isTimestamp(raw.at) ||
      !isProcessPid(raw.reaperPid) ||
      !isBoundedText(raw.reaperHost, 256) ||
      typeof raw.action !== "string" ||
      !RECOVERY_ACTIONS.has(raw.action) ||
      typeof raw.outcome !== "string" ||
      !RECOVERY_OUTCOMES.has(raw.outcome) ||
      !isBoundedText(raw.reason, MAX_WORKER_LEASE_DETAIL)
    ) {
      return undefined;
    }
    const signals = parseSignals(raw.signals);
    if (!signals) return undefined;
    let residualCount: number | undefined;
    if (raw.residualCount !== undefined) {
      if (!isBoundedCount(raw.residualCount)) return undefined;
      residualCount = raw.residualCount;
    }
    records.push({
      version: 1,
      at: raw.at,
      reaperPid: raw.reaperPid,
      reaperHost: raw.reaperHost,
      action: raw.action as WorkerLeaseRecoveryEvidence["action"],
      outcome: raw.outcome as WorkerLeaseRecoveryEvidence["outcome"],
      reason: raw.reason,
      signals,
      ...(residualCount !== undefined ? { residualCount } : {}),
    });
  }
  return records;
}

function parseSignals(raw: unknown): WorkerProcessSignalRecord[] | undefined {
  if (!Array.isArray(raw) || raw.length > 8) return undefined;
  const signals: WorkerProcessSignalRecord[] = [];
  for (const value of raw) {
    if (!isRecord(value)) return undefined;
    if (
      (value.signal !== "SIGTERM" && value.signal !== "SIGKILL") ||
      value.scope !== "process-group" ||
      (value.result !== "sent" && value.result !== "failed") ||
      !isTimestamp(value.at)
    ) {
      return undefined;
    }
    let detail: string | undefined;
    if (value.detail !== undefined) {
      if (!isBoundedText(value.detail, MAX_WORKER_LEASE_DETAIL)) {
        return undefined;
      }
      detail = value.detail;
    }
    signals.push({
      signal: value.signal,
      scope: "process-group",
      at: value.at,
      result: value.result,
      ...(detail !== undefined ? { detail } : {}),
    });
  }
  return signals;
}

// ---------------------------------------------------------------------------
// Attach / update from an adapter
// ---------------------------------------------------------------------------

export interface WorkerLeaseAttachInput {
  taskId: string;
  attempt: number;
  /** Unique per spawned CLI invocation (retries and continuations included). */
  invocationId: string;
  workspace: string;
  managed: ManagedWorkerProcess;
}

export interface WorkerLeaseHandle {
  leaseId: string;
  path: string;
  /** Update the same lease with the terminal process-tree outcome. */
  update(outcome: WorkerProcessCleanupOutcome): Promise<WorkerLease>;
}

export type WorkerLeaseAttacher = (
  input: WorkerLeaseAttachInput,
) => Promise<WorkerLeaseHandle>;

export interface WorkerLeaseAttacherOptions {
  repoRoot: string;
  runId: string;
  inspector?: WorkerProcessTreeInspector;
  /** Injection for tests; production captures this process exactly. */
  controller?: WorkerLeaseController;
  now?: () => Date;
}

interface MutableLeaseHandle extends WorkerLeaseHandle {
  current: WorkerLease;
}

/**
 * Build the run-scoped callback passed through the closed loop into adapters.
 * It captures the controller identity once and writes one lease per invocation.
 */
export function createWorkerLeaseAttacher(
  options: WorkerLeaseAttacherOptions,
): WorkerLeaseAttacher {
  if (options === null || typeof options !== "object") {
    throw new WorkerLeaseError("worker lease attacher options must be an object");
  }
  assertSafeSegment(options.runId, "runId");
  const repoRoot = resolve(options.repoRoot);
  const inspector = options.inspector ?? new ProcessInspector();
  const now = options.now ?? (() => new Date());
  let controllerPromise: Promise<WorkerLeaseController> | undefined;

  const captureController = (): Promise<WorkerLeaseController> => {
    if (options.controller) return Promise.resolve(options.controller);
    controllerPromise ??= (async () => {
      const identity = await inspector.capture(process.pid);
      if (!identity) {
        throw new WorkerLeasePersistenceError(
          "cannot capture the controller process identity",
        );
      }
      return { pid: process.pid, host: inspector.host, identity };
    })();
    return controllerPromise;
  };

  return async (input: WorkerLeaseAttachInput): Promise<WorkerLeaseHandle> => {
    const managed = input.managed;
    if (!managed || typeof managed !== "object") {
      throw new WorkerLeaseError("worker lease attach requires a managed process");
    }
    assertSafeSegment(input.taskId, "taskId");
    if (!Number.isInteger(input.attempt) || input.attempt < 0) {
      throw new WorkerLeaseError("worker lease attempt must be a non-negative integer");
    }
    if (!isBoundedText(input.invocationId, 128)) {
      throw new WorkerLeaseError("worker lease invocationId is invalid");
    }
    if (!isBoundedText(input.workspace, 4096)) {
      throw new WorkerLeaseError("worker lease workspace is invalid");
    }

    const leaseId = randomUUID();
    const startedAt = now().toISOString();
    let controller: WorkerLeaseController;
    try {
      controller = await captureController();
    } catch (error) {
      await cleanupForLeaseFailure(managed);
      throw asPersistenceError(error, "controller identity capture failed");
    }

    const provisional = provisionalLease({
      leaseId,
      repoRoot,
      runId: options.runId,
      taskId: input.taskId,
      attempt: input.attempt,
      invocationId: input.invocationId,
      workspace: input.workspace,
      controller,
      managed,
      startedAt,
    });
    const path = workerLeasePath(
      repoRoot,
      provisional.runId,
      provisional.taskId,
      provisional.leaseId,
    );

    try {
      writeJsonAtomic(path, provisional);
    } catch (error) {
      await cleanupForLeaseFailure(managed);
      throw asPersistenceError(error, "cannot write the provisional worker lease");
    }

    let current = provisional;
    try {
      const capture = await managed.captureIdentity();
      if (!capture.identity && capture.error) {
        // Identity capture failure is an ambiguity, not a guessed identity.
        current = { ...current, state: "unknown" };
      }
      if (capture.identity && managed.pid !== undefined) {
        if (capture.identity.pid === managed.pid) {
          current = {
            ...current,
            worker: {
              ...current.worker,
              pid: managed.pid,
              pgid: capture.identity.pgid,
              osStartIdentity: capture.identity.startedAt,
            },
            state: "active",
          };
        } else {
          current = { ...current, state: "unknown" };
        }
      } else if (!capture.identity) {
        current = { ...current, state: "unknown" };
      }
      current = { ...current, updatedAt: now().toISOString() };
      writeJsonAtomic(path, current);
    } catch (error) {
      await cleanupForLeaseFailure(managed);
      throw asPersistenceError(error, "cannot persist the exact worker identity");
    }

    let mutable: MutableLeaseHandle | undefined;
    let updated = false;
    const handle: MutableLeaseHandle = {
      leaseId: current.leaseId,
      path,
      current,
      async update(outcome: WorkerProcessCleanupOutcome): Promise<WorkerLease> {
        if (updated) return mutable!.current;
        const onDisk = readLeaseFile(path);
        if (!onDisk) {
          throw new WorkerLeasePersistenceError(
            `worker lease disappeared before update: ${path}`,
          );
        }
        assertImmutableLeaseFields(onDisk, current);
        const next = applyCleanupOutcome(onDisk, outcome, now().toISOString());
        writeJsonAtomic(path, next);
        current = next;
        mutable!.current = next;
        updated = true;
        return next;
      },
    };
    mutable = handle;
    return handle;
  };
}

function provisionalLease(input: {
  leaseId: string;
  repoRoot: string;
  runId: string;
  taskId: string;
  attempt: number;
  invocationId: string;
  workspace: string;
  controller: WorkerLeaseController;
  managed: ManagedWorkerProcess;
  startedAt: string;
}): WorkerLease {
  const pid = input.managed.pid;
  const captureMode: WorkerLeaseCaptureMode =
    input.managed.captureSupport === "posix-process-group"
      ? "posix-group"
      : "windows-exact-child";
  return {
    version: WORKER_LEASE_VERSION,
    leaseId: input.leaseId,
    repoRoot: input.repoRoot,
    runId: input.runId,
    taskId: input.taskId,
    attempt: input.attempt,
    invocationId: input.invocationId,
    controller: {
      pid: input.controller.pid,
      host: input.controller.host,
      identity: copyIdentity(input.controller.identity),
    },
    worker: {
      ...(isProcessPid(pid) ? { pid } : {}),
      ...(isProcessPid(pid) && captureMode === "posix-group"
        ? { pgid: pid }
        : {}),
      captureMode,
    },
    workspace: input.workspace,
    startedAt: input.startedAt,
    updatedAt: input.startedAt,
    state: isProcessPid(pid) ? "active" : "unknown",
  };
}

function applyCleanupOutcome(
  lease: WorkerLease,
  outcome: WorkerProcessCleanupOutcome,
  at: string,
): WorkerLease {
  const record = outcome.record;
  const state = leaseStateForCleanup(lease, outcome);
  return {
    ...lease,
    state,
    cleanupReason: record.cleanupReason,
    cleanedAt: record.cleanedAt ?? at,
    updatedAt: at,
    cleanup: {
      processTreeState: record.cleanupState,
      captureSource: record.captureSource,
      residualCount: record.residualCount,
      signalCount: record.signals.length,
      ...(record.detail ? { detail: boundText(record.detail) } : {}),
    },
  };
}

function leaseStateForCleanup(
  lease: WorkerLease,
  outcome: WorkerProcessCleanupOutcome,
): WorkerLeaseState {
  if (!outcome.treeOk || outcome.record.cleanupState === "failed") {
    return "cleanup-failed";
  }
  if (
    lease.worker.captureMode !== "posix-group" ||
    outcome.record.captureSupport !== "posix-process-group" ||
    !lease.worker.osStartIdentity ||
    !isProcessPid(lease.worker.pid) ||
    !isProcessPid(lease.worker.pgid) ||
    outcome.record.captureSource === "none" ||
    outcome.record.captureSource === "unsupported"
  ) {
    // A short-lived worker or a platform without group ownership never gains a
    // fabricated identity. It remains unknown evidence, not a success claim.
    return "unknown";
  }
  return "released";
}

function assertImmutableLeaseFields(
  onDisk: WorkerLease,
  expected: WorkerLease,
): void {
  const same =
    resolve(onDisk.repoRoot) === resolve(expected.repoRoot) &&
    onDisk.leaseId === expected.leaseId &&
    onDisk.runId === expected.runId &&
    onDisk.taskId === expected.taskId &&
    onDisk.attempt === expected.attempt &&
    onDisk.invocationId === expected.invocationId &&
    onDisk.workspace === expected.workspace &&
    onDisk.startedAt === expected.startedAt &&
    onDisk.controller.pid === expected.controller.pid &&
    onDisk.controller.host === expected.controller.host &&
    compareProcessIdentity(
      onDisk.controller.identity,
      expected.controller.identity,
    ) === "match" &&
    onDisk.worker.pid === expected.worker.pid &&
    onDisk.worker.pgid === expected.worker.pgid &&
    onDisk.worker.osStartIdentity === expected.worker.osStartIdentity &&
    onDisk.worker.captureMode === expected.worker.captureMode;
  if (!same) {
    throw new WorkerLeasePersistenceError(
      `worker lease identity was rewritten concurrently: ${onDisk.leaseId}`,
    );
  }
}

async function cleanupForLeaseFailure(
  managed: ManagedWorkerProcess,
): Promise<void> {
  try {
    await managed.cleanup("spawn-error");
  } catch {
    // Cleanup never rejects by contract; this is a final safety net.
  }
}

function asPersistenceError(error: unknown, prefix: string): WorkerLeasePersistenceError {
  const detail = error instanceof Error ? error.message : String(error);
  return new WorkerLeasePersistenceError(
    `${prefix}: ${boundText(detail)}`,
  );
}

// ---------------------------------------------------------------------------
// Store reads
// ---------------------------------------------------------------------------

export interface WorkerLeaseMalformedRecord {
  path: string;
  runId?: string;
  taskId?: string;
  reason: string;
}

export interface WorkerLeaseReadResult {
  leases: WorkerLease[];
  malformed: WorkerLeaseMalformedRecord[];
  scanned: number;
  truncated: boolean;
}

export interface ReadWorkerLeasesOptions {
  runId?: string;
  maxLeases?: number;
}

export function readWorkerLeases(
  repoRoot: string,
  options: ReadWorkerLeasesOptions = {},
): WorkerLeaseReadResult {
  const root = resolve(repoRoot);
  if (options.runId !== undefined) {
    assertSafeSegment(options.runId, "runId");
  }
  const maxLeases = positiveBound(
    options.maxLeases,
    MAX_WORKER_LEASES_SCAN,
    "maxLeases",
  );
  const leases: WorkerLease[] = [];
  const malformed: WorkerLeaseMalformedRecord[] = [];
  let scanned = 0;
  let truncated = false;

  outer: for (const runEntry of directoryEntries(workerLeasesDir(root))) {
    if (!runEntry.isDirectory() || !isSafeWorkerLeaseSegment(runEntry.name)) {
      continue;
    }
    if (options.runId !== undefined && runEntry.name !== options.runId) continue;
    const runDir = join(workerLeasesDir(root), runEntry.name);
    for (const taskEntry of directoryEntries(runDir)) {
      if (
        !taskEntry.isDirectory() ||
        !isSafeWorkerLeaseSegment(taskEntry.name)
      ) {
        continue;
      }
      const taskDir = join(runDir, taskEntry.name);
      for (const fileEntry of directoryEntries(taskDir)) {
        if (
          !fileEntry.isFile() ||
          !fileEntry.name.endsWith(".json") ||
          fileEntry.name.startsWith(".")
        ) {
          continue;
        }
        if (scanned >= maxLeases) {
          truncated = true;
          break outer;
        }
        scanned += 1;
        const path = join(taskDir, fileEntry.name);
        const leaseId = fileEntry.name.slice(0, -".json".length);
        const fail = (reason: string): void => {
          malformed.push({
            path,
            runId: runEntry.name,
            taskId: taskEntry.name,
            reason,
          });
        };
        if (!isSafeWorkerLeaseSegment(leaseId)) {
          fail("lease file name is not a safe lease id");
          continue;
        }
        let lease: WorkerLease | undefined;
        try {
          const size = statSync(path).size;
          if (size > MAX_WORKER_LEASE_BYTES) {
            fail("lease file exceeds the size bound");
            continue;
          }
          lease = parseWorkerLease(JSON.parse(readFileSync(path, "utf8")));
        } catch {
          fail("lease file is not valid JSON");
          continue;
        }
        if (!lease) {
          fail("lease record is malformed");
          continue;
        }
        if (
          lease.runId !== runEntry.name ||
          lease.taskId !== taskEntry.name ||
          lease.leaseId !== leaseId ||
          resolve(lease.repoRoot) !== root
        ) {
          fail("lease identity does not match its storage path");
          continue;
        }
        leases.push(lease);
      }
    }
  }

  leases.sort((left, right) => {
    const byStarted = left.startedAt.localeCompare(right.startedAt);
    if (byStarted !== 0) return byStarted;
    return left.leaseId.localeCompare(right.leaseId);
  });
  malformed.sort((left, right) => left.path.localeCompare(right.path));
  return { leases, malformed, scanned, truncated };
}

export function readLeaseFile(path: string): WorkerLease | undefined {
  try {
    const size = statSync(path).size;
    if (size > MAX_WORKER_LEASE_BYTES) return undefined;
    return parseWorkerLease(JSON.parse(readFileSync(path, "utf8")));
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Status projection
// ---------------------------------------------------------------------------

export type WorkerLeaseControllerState =
  | "alive"
  | "dead"
  | "foreign-host"
  | "unknown";

export interface WorkerLeaseStatusEntry {
  leaseId: string;
  taskId: string;
  attempt: number;
  invocationId: string;
  state: WorkerLeaseState;
  startedAt: string;
  updatedAt: string;
  controller: {
    pid: number;
    host: string;
    state: WorkerLeaseControllerState;
  };
  worker: WorkerLeaseWorker;
  cleanupReason?: WorkerLeaseCleanupReason;
  cleanedAt?: string;
  cleanup?: WorkerLeaseCleanupEvidence;
  latestObservation?: string;
}

export interface WorkerLeaseTaskStatus {
  taskId: string;
  latest: WorkerLeaseStatusEntry | null;
  malformed: number;
  /** True when durable attempt evidence exists but no valid lease was found. */
  missing: boolean;
}

export interface WorkerLeaseStatusReport {
  runId: string;
  counts: {
    active: number;
    released: number;
    cleanupFailed: number;
    unknown: number;
    malformed: number;
    total: number;
  };
  tasks: WorkerLeaseTaskStatus[];
  degraded: boolean;
  degradedReasons: string[];
  truncated: boolean;
}

export interface WorkerLeaseTaskHint {
  taskId: string;
  expectsLease: boolean;
}

export interface WorkerLeaseStatusOptions {
  inspector?: WorkerProcessTreeInspector;
  maxLeases?: number;
}

export async function buildWorkerLeaseStatus(
  repoRoot: string,
  runId: string,
  tasks: readonly WorkerLeaseTaskHint[],
  options: WorkerLeaseStatusOptions = {},
): Promise<WorkerLeaseStatusReport> {
  assertSafeSegment(runId, "runId");
  const inspector = options.inspector ?? new ProcessInspector();
  const read = readWorkerLeases(repoRoot, {
    runId,
    ...(options.maxLeases !== undefined
      ? { maxLeases: options.maxLeases }
      : {}),
  });
  const counts = {
    active: 0,
    released: 0,
    cleanupFailed: 0,
    unknown: 0,
    malformed: read.malformed.length,
    total: read.leases.length,
  };
  const latestByTask = new Map<string, WorkerLease>();
  for (const lease of read.leases) {
    if (lease.state === "active") counts.active += 1;
    else if (lease.state === "released") counts.released += 1;
    else if (lease.state === "cleanup-failed") counts.cleanupFailed += 1;
    else if (lease.state === "unknown") counts.unknown += 1;
    const previous = latestByTask.get(lease.taskId);
    if (!previous || newerLease(lease, previous)) {
      latestByTask.set(lease.taskId, lease);
    }
  }

  const malformedByTask = new Map<string, number>();
  for (const record of read.malformed) {
    if (!record.taskId) continue;
    malformedByTask.set(
      record.taskId,
      (malformedByTask.get(record.taskId) ?? 0) + 1,
    );
  }

  const statusTasks: WorkerLeaseTaskStatus[] = [];
  for (const hint of tasks) {
    const latest = latestByTask.get(hint.taskId);
    statusTasks.push({
      taskId: hint.taskId,
      latest: latest ? await statusEntry(latest, inspector) : null,
      malformed: malformedByTask.get(hint.taskId) ?? 0,
      missing: hint.expectsLease && !latest,
    });
  }
  // Leases for tasks no longer present in the manifest remain visible evidence.
  for (const [taskId, lease] of latestByTask) {
    if (statusTasks.some((task) => task.taskId === taskId)) continue;
    statusTasks.push({
      taskId,
      latest: await statusEntry(lease, inspector),
      malformed: malformedByTask.get(taskId) ?? 0,
      missing: false,
    });
  }

  const degradedReasons: string[] = [];
  for (const record of read.malformed) {
    degradedReasons.push(`malformed lease ${record.path}: ${record.reason}`);
  }
  for (const task of statusTasks) {
    if (task.missing) degradedReasons.push(`task ${task.taskId} has no worker lease`);
  }
  if (read.truncated) degradedReasons.push("worker lease scan was truncated");
  return {
    runId,
    counts,
    tasks: statusTasks,
    degraded: degradedReasons.length > 0,
    degradedReasons: degradedReasons.slice(0, 32),
    truncated: read.truncated,
  };
}

async function statusEntry(
  lease: WorkerLease,
  inspector: WorkerProcessTreeInspector,
): Promise<WorkerLeaseStatusEntry> {
  const controllerState = await observeControllerForStatus(lease, inspector);
  const latestRecovery = lease.recovery?.at(-1);
  const cleanup = lease.cleanup ? { ...lease.cleanup } : undefined;
  return {
    leaseId: lease.leaseId,
    taskId: lease.taskId,
    attempt: lease.attempt,
    invocationId: lease.invocationId,
    state: lease.state,
    startedAt: lease.startedAt,
    updatedAt: lease.updatedAt,
    controller: {
      pid: lease.controller.pid,
      host: lease.controller.host,
      state: controllerState,
    },
    worker: { ...lease.worker },
    ...(lease.cleanupReason !== undefined
      ? { cleanupReason: lease.cleanupReason }
      : {}),
    ...(lease.cleanedAt !== undefined ? { cleanedAt: lease.cleanedAt } : {}),
    ...(cleanup ? { cleanup } : {}),
    ...(latestRecovery
      ? {
          latestObservation:
            `${latestRecovery.outcome}/${latestRecovery.action} at ` +
            `${latestRecovery.at}: ${latestRecovery.reason}`,
        }
      : cleanup
        ? {
            latestObservation:
              `${cleanup.processTreeState}/${cleanup.captureSource}` +
              (cleanup.detail ? `: ${cleanup.detail}` : ""),
          }
        : {}),
  };
}

async function observeControllerForStatus(
  lease: WorkerLease,
  inspector: WorkerProcessTreeInspector,
): Promise<WorkerLeaseControllerState> {
  if (!sameHost(lease.controller.host, inspector.host)) return "foreign-host";
  if (!inspector.isAlive(lease.controller.pid)) return "dead";
  try {
    const observed = await inspector.capture(lease.controller.pid);
    if (!observed) return "unknown";
    const comparison = compareProcessIdentity(
      lease.controller.identity,
      observed,
    );
    return comparison === "match"
      ? "alive"
      : comparison === "mismatch"
        ? "dead"
        : "unknown";
  } catch {
    return "unknown";
  }
}

function newerLease(candidate: WorkerLease, current: WorkerLease): boolean {
  const byStarted = candidate.startedAt.localeCompare(current.startedAt);
  if (byStarted !== 0) return byStarted > 0;
  const byUpdated = candidate.updatedAt.localeCompare(current.updatedAt);
  if (byUpdated !== 0) return byUpdated > 0;
  return candidate.leaseId.localeCompare(current.leaseId) > 0;
}

// ---------------------------------------------------------------------------
// Same-host controller-death recovery
// ---------------------------------------------------------------------------

export interface WorkerLeaseRecoveryOptions {
  repoRoot: string;
  runId?: string;
  inspector?: WorkerProcessTreeInspector;
  termGraceMs?: number;
  killGraceMs?: number;
  pollMs?: number;
  /** Injection for tests; production only signals a negative process group. */
  killGroup?: (pgid: number, signal: NodeJS.Signals) => void;
  now?: () => Date;
}

export type WorkerLeaseRecoveryAction =
  | "terminated"
  | "already-exited"
  | "preserved"
  | "live-owner"
  | "foreign-host"
  | "invalid";

export interface WorkerLeaseRecoveryEntry {
  path: string;
  leaseId?: string;
  runId?: string;
  taskId?: string;
  attempt?: number;
  invocationId?: string;
  outcome: "recovered" | "needs_human" | "skipped";
  action: WorkerLeaseRecoveryAction;
  reason: string;
  controllerState: WorkerLeaseControllerState;
  workerState: "active" | "exited" | "unknown" | "preserved" | "terminated";
  resumeNeeded: boolean;
  signals: WorkerProcessSignalRecord[];
  residualCount?: number;
  leaseUpdated: boolean;
}

export interface WorkerLeaseResumeNeed {
  runId: string;
  taskId: string;
  leaseId: string;
  attempt: number;
  invocationId: string;
  reason: string;
}

export interface WorkerLeaseRecoveryReport {
  version: 1;
  at: string;
  host: string;
  repoRoot: string;
  /** Present when recovery was scoped to one run. */
  runId?: string;
  scanned: number;
  truncated: boolean;
  recovered: number;
  needsHuman: number;
  skipped: number;
  resumeNeeded: WorkerLeaseResumeNeed[];
  entries: WorkerLeaseRecoveryEntry[];
}

interface RecoveryContext {
  inspector: WorkerProcessTreeInspector;
  termGraceMs: number;
  killGraceMs: number;
  pollMs: number;
  killGroup: (pgid: number, signal: NodeJS.Signals) => void;
  now: () => Date;
}

interface RecoveryDecision {
  outcome: "recovered" | "needs_human" | "skipped";
  action: WorkerLeaseRecoveryAction;
  reason: string;
  controllerState: WorkerLeaseControllerState;
  workerState: "active" | "exited" | "unknown" | "preserved" | "terminated";
  resumeNeeded: boolean;
  signals: WorkerProcessSignalRecord[];
  residualCount?: number;
  /** Lifecycle state to persist; omitted means preserve the current state. */
  nextState?: WorkerLeaseState;
  cleanupReason?: WorkerLeaseCleanupReason;
  cleanedAt?: string;
}

/**
 * Recover active leases after controller death. Live owners, foreign hosts and
 * every identity ambiguity are preserved. Only an exactly verified dedicated
 * POSIX group is signalled, and recovery never edits the RunManifest.
 */
export async function recoverWorkerLeases(
  options: WorkerLeaseRecoveryOptions,
): Promise<WorkerLeaseRecoveryReport> {
  if (options === null || typeof options !== "object") {
    throw new WorkerLeaseRecoveryError("recovery options must be an object");
  }
  const repoRoot = resolve(options.repoRoot);
  if (options.runId !== undefined) {
    assertSafeSegment(options.runId, "runId");
  }
  const now = options.now ?? (() => new Date());
  const inspector = options.inspector ?? new ProcessInspector();
  const context: RecoveryContext = {
    inspector,
    termGraceMs: positiveBound(
      options.termGraceMs,
      DEFAULT_LEASE_TERM_GRACE_MS,
      "termGraceMs",
    ),
    killGraceMs: positiveBound(
      options.killGraceMs,
      DEFAULT_LEASE_KILL_GRACE_MS,
      "killGraceMs",
    ),
    pollMs: positiveBound(options.pollMs, DEFAULT_LEASE_POLL_MS, "pollMs"),
    killGroup:
      options.killGroup ??
      ((pgid, signal) => {
        process.kill(-pgid, signal);
      }),
    now,
  };
  const read = readWorkerLeases(repoRoot, {
    ...(options.runId !== undefined ? { runId: options.runId } : {}),
  });
  const at = now().toISOString();
  const entries: WorkerLeaseRecoveryEntry[] = [];
  const resumeNeeded: WorkerLeaseResumeNeed[] = [];

  for (const malformed of read.malformed) {
    entries.push({
      path: malformed.path,
      ...(malformed.runId ? { runId: malformed.runId } : {}),
      ...(malformed.taskId ? { taskId: malformed.taskId } : {}),
      outcome: "needs_human",
      action: "invalid",
      reason: malformed.reason,
      controllerState: "unknown",
      workerState: "unknown",
      resumeNeeded: false,
      signals: [],
      leaseUpdated: false,
    });
  }

  for (const lease of read.leases) {
    const path = workerLeasePath(
      repoRoot,
      lease.runId,
      lease.taskId,
      lease.leaseId,
    );
    if (lease.state !== "active") {
      entries.push({
        path,
        leaseId: lease.leaseId,
        runId: lease.runId,
        taskId: lease.taskId,
        attempt: lease.attempt,
        invocationId: lease.invocationId,
        outcome: "skipped",
        action: "preserved",
        reason: `lease is already ${lease.state}`,
        controllerState: "unknown",
        workerState: "unknown",
        resumeNeeded: false,
        signals: [],
        leaseUpdated: false,
      });
      continue;
    }

    const decision = await recoverActiveLease(lease, context);
    let leaseUpdated = false;
    if (decision.controllerState === "dead") {
      const evidence: WorkerLeaseRecoveryEvidence = {
        version: 1,
        at: now().toISOString(),
        reaperPid: process.pid,
        reaperHost: inspector.host,
        action: decision.action,
        outcome:
          decision.outcome === "recovered" ? "recovered" : "needs_human",
        reason: boundText(decision.reason),
        signals: decision.signals.map((signal) => ({ ...signal })),
        ...(decision.residualCount !== undefined
          ? { residualCount: decision.residualCount }
          : {}),
      };
      try {
        const next = appendRecoveryEvidence(lease, evidence, decision, context);
        writeJsonAtomic(path, next);
        leaseUpdated = true;
      } catch {
        decision.reason = boundText(
          `${decision.reason}; recovery evidence could not be persisted`,
        );
      }
      if (decision.resumeNeeded) {
        resumeNeeded.push({
          runId: lease.runId,
          taskId: lease.taskId,
          leaseId: lease.leaseId,
          attempt: lease.attempt,
          invocationId: lease.invocationId,
          reason: decision.reason,
        });
      }
    }

    entries.push({
      path,
      leaseId: lease.leaseId,
      runId: lease.runId,
      taskId: lease.taskId,
      attempt: lease.attempt,
      invocationId: lease.invocationId,
      outcome: decision.outcome,
      action: decision.action,
      reason: decision.reason,
      controllerState: decision.controllerState,
      workerState: decision.workerState,
      resumeNeeded: decision.resumeNeeded,
      signals: decision.signals.map((signal) => ({ ...signal })),
      ...(decision.residualCount !== undefined
        ? { residualCount: decision.residualCount }
        : {}),
      leaseUpdated,
    });
  }

  entries.sort((left, right) => left.path.localeCompare(right.path));
  const recovered = entries.filter((entry) => entry.outcome === "recovered").length;
  const needsHuman = entries.filter((entry) => entry.outcome === "needs_human").length;
  const skipped = entries.filter((entry) => entry.outcome === "skipped").length;
  return {
    version: 1,
    at,
    host: inspector.host,
    repoRoot,
    ...(options.runId !== undefined ? { runId: options.runId } : {}),
    scanned: read.scanned,
    truncated: read.truncated,
    recovered,
    needsHuman,
    skipped,
    resumeNeeded,
    entries,
  };
}

async function recoverActiveLease(
  lease: WorkerLease,
  context: RecoveryContext,
): Promise<RecoveryDecision> {
  if (!sameHost(lease.controller.host, context.inspector.host)) {
    return {
      outcome: "skipped",
      action: "foreign-host",
      reason:
        `controller host ${lease.controller.host} is not this host ` +
        `(${context.inspector.host}); no cross-host action`,
      controllerState: "foreign-host",
      workerState: "unknown",
      resumeNeeded: false,
      signals: [],
    };
  }

  const controllerState = await observeController(lease, context.inspector);
  if (controllerState === "alive") {
    return {
      outcome: "skipped",
      action: "live-owner",
      reason: "the matching controller process is still alive",
      controllerState,
      workerState: "unknown",
      resumeNeeded: false,
      signals: [],
    };
  }
  if (controllerState === "unknown") {
    return {
      outcome: "needs_human",
      action: "preserved",
      reason:
        "controller liveness or exact controller identity is ambiguous; " +
        "lease and processes preserved",
      controllerState,
      workerState: "preserved",
      resumeNeeded: false,
      signals: [],
    };
  }

  return recoverWorkerGroup(lease, context);
}

async function observeController(
  lease: WorkerLease,
  inspector: WorkerProcessTreeInspector,
): Promise<WorkerLeaseControllerState> {
  if (!inspector.isAlive(lease.controller.pid)) return "dead";
  try {
    const observed = await inspector.capture(lease.controller.pid);
    if (!observed) return "unknown";
    const comparison = compareProcessIdentity(
      lease.controller.identity,
      observed,
    );
    if (comparison === "match") return "alive";
    if (comparison === "mismatch") {
      // The recorded controller identity is gone; the pid now belongs to an
      // unrelated process and cannot be a live owner.
      return "dead";
    }
    return "unknown";
  } catch {
    return "unknown";
  }
}

async function recoverWorkerGroup(
  lease: WorkerLease,
  context: RecoveryContext,
): Promise<RecoveryDecision> {
  const pid = lease.worker.pid;
  const pgid = lease.worker.pgid;
  const osStartIdentity = lease.worker.osStartIdentity;
  if (lease.worker.captureMode !== "posix-group") {
    return preserveNeedsHuman(
      "worker was captured as windows-exact-child; no recoverable POSIX group",
    );
  }
  if (!isProcessPid(pid) || !isProcessPid(pgid) || !osStartIdentity) {
    return preserveNeedsHuman(
      "exact worker pid/pgid/OS start identity is missing; processes preserved",
    );
  }
  if (pgid !== pid) {
    return preserveNeedsHuman(
      "worker was not the leader of its dedicated process group; processes preserved",
    );
  }

  const expectedIdentity: RuntimeProcessIdentity = {
    pid,
    pgid,
    startedAt: osStartIdentity,
  };
  let observed: RuntimeProcessIdentity | undefined;
  try {
    observed = await context.inspector.capture(pid);
  } catch {
    return preserveNeedsHuman(
      "worker identity could not be inspected; processes preserved",
    );
  }
  if (!observed) {
    // The design requires the exact leader identity before recovery may act.
    // An absent identity is ambiguous even when the group also looks empty:
    // it may be a short-lived capture failure or a reused pid.
    let members: ProcessGroupMember[];
    try {
      members = await context.inspector.listGroupMembers(pgid);
    } catch {
      return preserveNeedsHuman(
        "worker group could not be inspected; processes preserved",
      );
    }
    return preserveNeedsHuman(
      members.length === 0
        ? "worker leader identity is absent; processes and lease preserved"
        : "worker leader identity is absent while group members remain; " +
          "processes preserved",
    );
  }
  if (compareProcessIdentity(expectedIdentity, observed) !== "match") {
    return preserveNeedsHuman(
      "worker exact identity does not match the lease; processes preserved",
    );
  }

  let members: ProcessGroupMember[];
  try {
    members = await context.inspector.listGroupMembers(pgid);
  } catch {
    return preserveNeedsHuman(
      "worker group could not be listed; processes preserved",
    );
  }
  if (members.length === 0) {
    return {
      outcome: "recovered",
      action: "already-exited",
      reason: "verified worker group is already gone",
      controllerState: "dead",
      workerState: "exited",
      resumeNeeded: true,
      signals: [],
      nextState: "released",
      cleanupReason: "recovery",
      cleanedAt: context.now().toISOString(),
    };
  }
  const guard = await groupSignalAllowed(pgid, expectedIdentity, members, context);
  if (!guard.ok) return preserveNeedsHuman(guard.reason);

  const signals: WorkerProcessSignalRecord[] = [];
  const term = sendGroupSignal(pgid, "SIGTERM", context, signals);
  if (term === "error") {
    return {
      outcome: "needs_human",
      action: "preserved",
      reason: "SIGTERM to the verified worker group failed; processes preserved",
      controllerState: "dead",
      workerState: "preserved",
      resumeNeeded: false,
      signals,
    };
  }
  try {
    members = await waitForGroupEmpty(pgid, context, context.termGraceMs);
  } catch {
    return {
      outcome: "needs_human",
      action: "preserved",
      reason:
        "worker group became uninspectable after SIGTERM; processes preserved",
      controllerState: "dead",
      workerState: "preserved",
      resumeNeeded: false,
      signals,
    };
  }
  if (members.length === 0) {
    return {
      outcome: "recovered",
      action: "terminated",
      reason: "verified worker group terminated after SIGTERM",
      controllerState: "dead",
      workerState: "terminated",
      resumeNeeded: true,
      signals,
      nextState: "released",
      cleanupReason: "recovery",
      cleanedAt: context.now().toISOString(),
    };
  }

  const residualBeforeKill = members.length;
  const killGuard = await groupSignalAllowed(
    pgid,
    expectedIdentity,
    members,
    context,
  );
  if (!killGuard.ok) {
    return {
      outcome: "needs_human",
      action: "preserved",
      reason: killGuard.reason,
      controllerState: "dead",
      workerState: "preserved",
      resumeNeeded: false,
      signals,
      residualCount: residualBeforeKill,
    };
  }
  const kill = sendGroupSignal(pgid, "SIGKILL", context, signals);
  if (kill === "error") {
    return {
      outcome: "needs_human",
      action: "preserved",
      reason: "SIGKILL to the verified worker group failed; processes preserved",
      controllerState: "dead",
      workerState: "preserved",
      resumeNeeded: false,
      signals,
      residualCount: residualBeforeKill,
    };
  }
  try {
    members = await waitForGroupEmpty(pgid, context, context.killGraceMs);
  } catch {
    return {
      outcome: "needs_human",
      action: "preserved",
      reason:
        "worker group became uninspectable after SIGKILL; lease preserved",
      controllerState: "dead",
      workerState: "preserved",
      resumeNeeded: false,
      signals,
      residualCount: residualBeforeKill,
    };
  }
  if (members.length === 0) {
    return {
      outcome: "recovered",
      action: "terminated",
      reason: "verified worker group terminated after SIGTERM/SIGKILL",
      controllerState: "dead",
      workerState: "terminated",
      resumeNeeded: true,
      signals,
      nextState: "released",
      cleanupReason: "recovery",
      cleanedAt: context.now().toISOString(),
    };
  }
  return {
    outcome: "needs_human",
    action: "preserved",
    reason:
      `verified worker group still has ${members.length} member(s) after SIGKILL`,
    controllerState: "dead",
    workerState: "preserved",
    resumeNeeded: false,
    signals,
    residualCount: members.length,
    nextState: "cleanup-failed",
    cleanupReason: "recovery",
    cleanedAt: context.now().toISOString(),
  };
}

function preserveNeedsHuman(reason: string): RecoveryDecision {
  return {
    outcome: "needs_human",
    action: "preserved",
    reason,
    controllerState: "dead",
    workerState: "preserved",
    resumeNeeded: false,
    signals: [],
  };
}

async function groupSignalAllowed(
  pgid: number,
  identity: RuntimeProcessIdentity,
  members: readonly ProcessGroupMember[],
  context: RecoveryContext,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  if (!isProcessPid(pgid) || pgid <= 1) {
    return { ok: false, reason: "refusing an invalid process-group id" };
  }
  if (pgid === process.pid) {
    return { ok: false, reason: "refusing cliyard's own process id as a group" };
  }
  if (members.length === 0) {
    return { ok: false, reason: "process group membership disappeared" };
  }
  if (members.some((member) => member.pgid !== pgid)) {
    return {
      ok: false,
      reason: "process group membership is inconsistent; processes preserved",
    };
  }
  if (members.some((member) => member.pid === process.pid)) {
    return {
      ok: false,
      reason: "refusing a group that contains this recovery process",
    };
  }
  const leader = members.find((member) => member.pid === identity.pid);
  if (!leader || compareProcessIdentity(identity, leader) !== "match") {
    return {
      ok: false,
      reason: "the exact worker leader identity is absent or mismatched",
    };
  }
  let own: RuntimeProcessIdentity | undefined;
  try {
    own = await context.inspector.capture(process.pid);
  } catch {
    return {
      ok: false,
      reason: "cannot inspect the recovery process group; processes preserved",
    };
  }
  if (!own || !isProcessPid(own.pgid)) {
    return {
      ok: false,
      reason: "cannot prove the worker group differs from our own group",
    };
  }
  if (own.pgid === pgid) {
    return { ok: false, reason: "refusing this recovery process's own group" };
  }
  return { ok: true };
}

function sendGroupSignal(
  pgid: number,
  signal: "SIGTERM" | "SIGKILL",
  context: RecoveryContext,
  signals: WorkerProcessSignalRecord[],
): "sent" | "gone" | "error" {
  try {
    context.killGroup(pgid, signal);
    signals.push({
      signal,
      scope: "process-group",
      at: context.now().toISOString(),
      result: "sent",
    });
    return "sent";
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return "gone";
    signals.push({
      signal,
      scope: "process-group",
      at: context.now().toISOString(),
      result: "failed",
      detail: boundText(error instanceof Error ? error.message : String(error)),
    });
    return "error";
  }
}

async function waitForGroupEmpty(
  pgid: number,
  context: RecoveryContext,
  graceMs: number,
): Promise<ProcessGroupMember[]> {
  const deadline = Date.now() + graceMs;
  for (;;) {
    const members = await context.inspector.listGroupMembers(pgid);
    if (members.length === 0) return members;
    if (Date.now() >= deadline) return members;
    await sleep(Math.min(context.pollMs, Math.max(1, deadline - Date.now())));
  }
}

function appendRecoveryEvidence(
  lease: WorkerLease,
  evidence: WorkerLeaseRecoveryEvidence,
  decision: RecoveryDecision,
  context: RecoveryContext,
): WorkerLease {
  const recovery = [...(lease.recovery ?? []), evidence].slice(
    -MAX_WORKER_LEASE_RECOVERY,
  );
  return {
    ...lease,
    ...(decision.nextState !== undefined
      ? { state: decision.nextState }
      : {}),
    ...(decision.cleanupReason !== undefined
      ? { cleanupReason: decision.cleanupReason }
      : {}),
    ...(decision.cleanedAt !== undefined ? { cleanedAt: decision.cleanedAt } : {}),
    updatedAt: context.now().toISOString(),
    recovery,
  };
}

export class WorkerLeaseRecoveryError extends WorkerLeaseError {}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function writeJsonAtomic(path: string, value: unknown): void {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = join(
    dir,
    `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`,
  );
  try {
    const fd = openSync(tmp, "wx", 0o600);
    try {
      writeFileSync(fd, JSON.stringify(value, null, 2) + "\n", "utf8");
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, path);
  } catch (error) {
    try {
      unlinkSync(tmp);
    } catch {
      /* best-effort cleanup */
    }
    throw error;
  }
}

function directoryEntries(path: string): Dirent[] {
  try {
    return readdirSync(path, { withFileTypes: true });
  } catch {
    return [];
  }
}

function assertSafeSegment(value: unknown, field: string): asserts value is string {
  if (typeof value !== "string" || !SEGMENT_PATTERN.test(value)) {
    throw new WorkerLeaseError(`${field} is not a safe path segment`);
  }
}

function sameHost(left: string, right: string): boolean {
  return (
    left.trim().toLowerCase() !== "" &&
    left.trim().toLowerCase() === right.trim().toLowerCase()
  );
}

function copyIdentity(identity: RuntimeProcessIdentity): RuntimeProcessIdentity {
  return {
    pid: identity.pid,
    pgid: identity.pgid,
    startedAt: identity.startedAt,
  };
}

function boundText(text: string): string {
  return text
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_WORKER_LEASE_DETAIL);
}

function isBoundedText(value: unknown, max: number): value is string {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    value.length <= max &&
    !value.includes("\0")
  );
}

function isTimestamp(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 64 &&
    !Number.isNaN(Date.parse(value))
  );
}

function isBoundedCount(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 0 &&
    value <= 100_000
  );
}

function positiveBound(
  value: number | undefined,
  fallback: number,
  name: string,
): number {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value) || value <= 0) {
    throw new WorkerLeaseError(`${name} must be a positive number`);
  }
  return Math.floor(value);
}

function sleep(ms: number): Promise<void> {
  return new Promise<void>((resolveSleep) => {
    setTimeout(resolveSleep, Math.max(1, ms));
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

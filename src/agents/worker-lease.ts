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
  MAX_PROCESS_TABLE_ROWS,
  compareProcessIdentity,
  isProcessIdentity,
  isProcessPid,
  ProcessInspector,
  type ProcessGroupMember,
  type ProcessTableEntry,
} from "../runtime/process.js";
import type { RuntimeProcessIdentity } from "../runtime/types.js";
import {
  MAX_NESTED_GROUPS,
  MAX_NESTED_GROUP_MEMBERS,
  MAX_NESTED_SIGNAL_TARGETS,
  MAX_PERSISTED_EXTERNAL_DESCENDANTS,
  type ManagedWorkerProcess,
  type WorkerCleanupReason,
  type WorkerCaptureSource,
  type WorkerCleanupState,
  type WorkerNestedGroup,
  type WorkerNestedProcesses,
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
/** Maximum exact nested-descendant identities persisted on one lease. */
export const MAX_WORKER_LEASE_NESTED_IDENTITIES =
  MAX_PERSISTED_EXTERNAL_DESCENDANTS;
/** Maximum external process groups persisted on one lease. */
export const MAX_WORKER_LEASE_NESTED_GROUPS = MAX_NESTED_GROUPS;
/** Hard bound for the observed nested count carried as evidence. */
export const MAX_WORKER_LEASE_NESTED_COUNT = 100_000;

/**
 * Optional, all-or-nothing durable nested-descendant evidence. The shape is
 * shared with the managed-process observer; a lease without this field keeps
 * the legacy v1 behavior.
 */
export type WorkerLeaseNestedProcesses = WorkerNestedProcesses;
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
  /**
   * Bounded exact identities of descendants observed outside the worker's
   * dedicated group before the controller could die. Absent for legacy
   * leases and for invocations that never observed an external descendant.
   */
  nestedProcesses?: WorkerLeaseNestedProcesses;
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
  const nestedProcesses =
    value.nestedProcesses === undefined
      ? undefined
      : parseNestedProcesses(value.nestedProcesses, controller.host);
  if (value.nestedProcesses !== undefined && !nestedProcesses) return undefined;

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
    ...(nestedProcesses !== undefined ? { nestedProcesses } : {}),
    ...(recovery !== undefined ? { recovery } : {}),
  };
}

/**
 * Optional nested evidence is all-or-nothing and must belong to the same host
 * as the controller. Duplicate pids, a count smaller than the persisted list,
 * or an untruncated count that disagrees with the persisted list are
 * malformed, never best-effort evidence.
 */
function parseNestedProcesses(
  value: unknown,
  controllerHost: string,
): WorkerLeaseNestedProcesses | undefined {
  if (!isRecord(value) || value.version !== 1) return undefined;
  if (
    !isBoundedText(value.host, 256) ||
    !sameHost(value.host, controllerHost) ||
    typeof value.observedCount !== "number" ||
    !Number.isInteger(value.observedCount) ||
    value.observedCount < 0 ||
    value.observedCount > MAX_WORKER_LEASE_NESTED_COUNT ||
    typeof value.truncated !== "boolean" ||
    !isTimestamp(value.lastObservedAt) ||
    !Array.isArray(value.identities) ||
    value.identities.length > MAX_WORKER_LEASE_NESTED_IDENTITIES
  ) {
    return undefined;
  }
  const identities: RuntimeProcessIdentity[] = [];
  const seen = new Set<number>();
  for (const raw of value.identities) {
    // pid 1 (init/launchd) is never a worker descendant; accepting it would
    // make the registry a traversal root for the entire process tree.
    if (!isProcessIdentity(raw) || raw.pid <= 1 || seen.has(raw.pid)) {
      return undefined;
    }
    seen.add(raw.pid);
    identities.push(copyIdentity(raw));
  }
  let groups: WorkerNestedGroup[] | undefined;
  if (value.groups !== undefined) {
    groups = parseSnapshotGroups(value.groups);
    if (!groups) return undefined;
  }
  const groupIds = new Set((groups ?? []).map((group) => group.pgid));
  for (const identity of identities) {
    // Group members and the exact group leader are one bounded unit; a
    // fallback identity that duplicates either is malformed, not extra
    // authority.
    if (groupIds.has(identity.pid) || groupIds.has(identity.pgid)) {
      return undefined;
    }
  }
  if (value.observedCount < identities.length) return undefined;
  // A complete fallback registry persists every observed ungrouped identity.
  // Only a truncated registry may carry a larger observed count than its
  // bounded list.
  if (!value.truncated && value.observedCount !== identities.length) {
    return undefined;
  }
  if (
    value.observedCount > MAX_WORKER_LEASE_NESTED_IDENTITIES &&
    !value.truncated
  ) {
    return undefined;
  }
  return {
    version: 1,
    host: value.host,
    observedCount: value.observedCount,
    truncated: value.truncated,
    lastObservedAt: value.lastObservedAt,
    ...(groups !== undefined ? { groups } : {}),
    identities,
  };
}

/**
 * Validate one bounded group registry. `null`-like `undefined` means invalid;
 * an empty array is valid and means "no external group has an exact leader".
 */
function parseSnapshotGroups(raw: unknown): WorkerNestedGroup[] | undefined {
  if (!Array.isArray(raw) || raw.length > MAX_WORKER_LEASE_NESTED_GROUPS) {
    return undefined;
  }
  const groups: WorkerNestedGroup[] = [];
  const seen = new Set<number>();
  for (const value of raw) {
    if (!isRecord(value)) return undefined;
    if (
      !isProcessPid(value.pgid) ||
      value.pgid <= 1 ||
      seen.has(value.pgid) ||
      !isProcessIdentity(value.leader)
    ) {
      return undefined;
    }
    if (value.leader.pid !== value.pgid || value.leader.pgid !== value.pgid) {
      return undefined;
    }
    if (
      !Number.isInteger(value.observedMemberCount) ||
      (value.observedMemberCount as number) < 1 ||
      (value.observedMemberCount as number) > MAX_NESTED_GROUP_MEMBERS ||
      !isTimestamp(value.lastObservedAt)
    ) {
      return undefined;
    }
    seen.add(value.pgid);
    groups.push({
      pgid: value.pgid,
      leader: copyIdentity(value.leader),
      observedMemberCount: value.observedMemberCount as number,
      lastObservedAt: value.lastObservedAt,
    });
  }
  return groups;
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
      (value.scope !== "process-group" &&
        value.scope !== "descendant-pid" &&
        value.scope !== "nested-process-group") ||
      (value.result !== "sent" && value.result !== "failed") ||
      !isTimestamp(value.at)
    ) {
      return undefined;
    }
    let pid: number | undefined;
    let pgid: number | undefined;
    if (value.scope === "descendant-pid") {
      if (!isProcessPid(value.pid) || value.pgid !== undefined) {
        return undefined;
      }
      pid = value.pid;
    } else if (value.scope === "nested-process-group") {
      if (!isProcessPid(value.pgid) || value.pgid <= 1 || value.pid !== undefined) {
        return undefined;
      }
      pgid = value.pgid;
    } else if (value.pid !== undefined || value.pgid !== undefined) {
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
      scope: value.scope,
      ...(pid !== undefined ? { pid } : {}),
      ...(pgid !== undefined ? { pgid } : {}),
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

    let updated = false;
    let closing = false;
    let nestedFailure: WorkerLeasePersistenceError | undefined;
    let writeChain: Promise<void> = Promise.resolve();
    let unsubscribeNested: (() => void) | undefined;

    const markNestedUnhealthy = (error: unknown): void => {
      if (nestedFailure !== undefined) return;
      nestedFailure = asPersistenceError(
        error,
        "cannot persist nested descendant evidence",
      );
      // Stop the invocation rather than accept a worker whose nested
      // ownership evidence is not durable.
      void cleanupForLeaseFailure(managed);
    };

    const persistNestedSnapshot = (snapshot: WorkerNestedProcesses): void => {
      if (closing || updated || nestedFailure !== undefined) return;
      if (!sameHost(snapshot.host, controller.host)) {
        markNestedUnhealthy(
          new WorkerLeasePersistenceError(
            "nested descendant evidence host does not match the controller host",
          ),
        );
        return;
      }
      // Never durably write evidence that the strict lease parser would later
      // reject: a malformed snapshot is a persistence-health failure.
      const snapshotGroups =
        snapshot.groups === undefined
          ? undefined
          : parseSnapshotGroups(snapshot.groups);
      const snapshotGroupIds = new Set(
        (snapshotGroups ?? []).map((group) => group.pgid),
      );
      if (
        snapshot.version !== 1 ||
        !isTimestamp(snapshot.lastObservedAt) ||
        typeof snapshot.truncated !== "boolean" ||
        !Number.isInteger(snapshot.observedCount) ||
        snapshot.observedCount < 0 ||
        snapshot.observedCount > MAX_WORKER_LEASE_NESTED_COUNT ||
        !Array.isArray(snapshot.identities) ||
        snapshot.identities.length > MAX_WORKER_LEASE_NESTED_IDENTITIES ||
        snapshot.identities.some(
          (identity) =>
            !isProcessIdentity(identity) ||
            identity.pid <= 1 ||
            snapshotGroupIds.has(identity.pid) ||
            snapshotGroupIds.has(identity.pgid),
        ) ||
        (snapshot.groups !== undefined && snapshotGroups === undefined)
      ) {
        markNestedUnhealthy(
          new WorkerLeasePersistenceError(
            "nested descendant evidence is malformed",
          ),
        );
        return;
      }
      const onDisk = readLeaseFile(path);
      if (!onDisk) {
        markNestedUnhealthy(
          new WorkerLeasePersistenceError(
            `worker lease disappeared before nested evidence could be written: ${path}`,
          ),
        );
        return;
      }
      assertImmutableLeaseFields(onDisk, current);
      const next = applyNestedSnapshot(onDisk, snapshot, now().toISOString());
      if (!next) return;
      writeJsonAtomic(path, next);
      current = next;
    };

    const handle: MutableLeaseHandle = {
      leaseId: current.leaseId,
      path,
      // The observer may replay its current snapshot synchronously inside
      // `observeExternalDescendants`, before this function returns, so the
      // handle must read the live variable instead of a copied snapshot.
      get current() {
        return current;
      },
      async update(outcome: WorkerProcessCleanupOutcome): Promise<WorkerLease> {
        if (updated) return current;
        closing = true;
        unsubscribeNested?.();
        unsubscribeNested = undefined;
        // Let any already-enqueued nested snapshot finish before the terminal
        // update; the update itself must be the last write to the lease.
        await writeChain;
        if (nestedFailure !== undefined) throw nestedFailure;
        const onDisk = readLeaseFile(path);
        if (!onDisk) {
          throw new WorkerLeasePersistenceError(
            `worker lease disappeared before update: ${path}`,
          );
        }
        assertImmutableLeaseFields(onDisk, current);
        const updatedAt = now().toISOString();
        const withCleanup = applyCleanupOutcome(onDisk, outcome, updatedAt);
        const next = enrichNestedFromRecord(withCleanup, outcome.record, updatedAt);
        writeJsonAtomic(path, next);
        current = next;
        updated = true;
        return next;
      },
    };

    // Subscribe only after the immutable controller and worker identity have
    // been durably written. Snapshot writes are serialized on one chain so an
    // older observation can never replace a newer one.
    const observeNested = managed.observeExternalDescendants;
    if (typeof observeNested === "function") {
      unsubscribeNested = observeNested.call(managed, (snapshot) => {
        if (closing) return;
        writeChain = writeChain
          .then(() => persistNestedSnapshot(snapshot))
          .catch(markNestedUnhealthy);
        // Cleanup awaits this returned promise to prove the refreshed registry
        // is durable before it sends any nested signal.
        return writeChain.then(() => {
          if (nestedFailure !== undefined) throw nestedFailure;
        });
      });
      await writeChain;
      if (nestedFailure !== undefined) {
        unsubscribeNested();
        unsubscribeNested = undefined;
        await cleanupForLeaseFailure(managed);
        throw nestedFailure;
      }
    }

    return handle;
  };
}

/**
 * Merge one observer snapshot into the durable registry. Older snapshots are
 * ignored; identity evidence is monotonic (never removed by a newer snapshot)
 * and the persisted list stays bounded. An empty snapshot never creates or
 * replaces evidence.
 */
function applyNestedSnapshot(
  lease: WorkerLease,
  snapshot: WorkerNestedProcesses,
  at: string,
): WorkerLease | undefined {
  const existing = lease.nestedProcesses;
  if (
    !existing &&
    snapshot.observedCount === 0 &&
    snapshot.identities.length === 0 &&
    (snapshot.groups?.length ?? 0) === 0 &&
    !snapshot.truncated
  ) {
    return undefined;
  }
  // ISO timestamps from different offsets sort differently as strings; compare
  // parsed instants so an older observation can never win on lexical order.
  const existingTime = existing ? timestampMs(existing.lastObservedAt) : undefined;
  const snapshotTime = timestampMs(snapshot.lastObservedAt);
  if (
    existing &&
    existingTime !== undefined &&
    snapshotTime !== undefined &&
    snapshotTime < existingTime
  ) {
    return undefined;
  }

  // Group evidence is monotonic per pgid. A same-pgid observation with a
  // different exact leader is a reused group id: keep the first authority and
  // mark the registry truncated so recovery fails closed.
  const groups = new Map<number, WorkerNestedGroup>();
  for (const group of existing?.groups ?? []) {
    groups.set(group.pgid, copyNestedGroup(group));
  }
  let groupConflict = false;
  for (const group of snapshot.groups ?? []) {
    const prior = groups.get(group.pgid);
    if (!prior) {
      groups.set(group.pgid, copyNestedGroup(group));
      continue;
    }
    if (compareProcessIdentity(prior.leader, group.leader) !== "match") {
      groupConflict = true;
      continue;
    }
    const priorTime = timestampMs(prior.lastObservedAt);
    const nextTime = timestampMs(group.lastObservedAt);
    groups.set(group.pgid, {
      ...prior,
      observedMemberCount: Math.max(
        prior.observedMemberCount,
        group.observedMemberCount,
      ),
      lastObservedAt:
        nextTime !== undefined && (priorTime === undefined || nextTime >= priorTime)
          ? group.lastObservedAt
          : prior.lastObservedAt,
    });
  }
  const groupIds = new Set(groups.keys());
  const boundedGroups = [...groups.values()]
    .sort((first, second) => first.pgid - second.pgid)
    .slice(0, MAX_WORKER_LEASE_NESTED_GROUPS);

  // Fallback identities are merged monotonically, but a pid that now belongs
  // to a proven group is a group member and never a fallback target.
  const identities = new Map<number, RuntimeProcessIdentity>();
  for (const identity of existing?.identities ?? []) {
    if (groupIds.has(identity.pgid) || groupIds.has(identity.pid)) continue;
    identities.set(identity.pid, copyIdentity(identity));
  }
  for (const identity of snapshot.identities) {
    if (groupIds.has(identity.pgid) || groupIds.has(identity.pid)) continue;
    identities.set(identity.pid, copyIdentity(identity));
  }
  const existingFallbackCount = existing
    ? existing.identities.filter(
        (identity) =>
          !groupIds.has(identity.pgid) && !groupIds.has(identity.pid),
      ).length
    : 0;
  const observedCount = Math.max(
    existingFallbackCount,
    existing?.truncated === true ? existing.observedCount : 0,
    snapshot.observedCount,
    identities.size,
  );
  const truncated =
    existing?.truncated === true ||
    snapshot.truncated ||
    groupConflict ||
    observedCount > MAX_WORKER_LEASE_NESTED_IDENTITIES ||
    groups.size > MAX_WORKER_LEASE_NESTED_GROUPS;
  const bounded = [...identities.values()]
    .sort((first, second) => first.pid - second.pid)
    .slice(0, MAX_WORKER_LEASE_NESTED_IDENTITIES);
  const lastObservedAt =
    existing &&
    existingTime !== undefined &&
    snapshotTime !== undefined &&
    existingTime > snapshotTime
      ? existing.lastObservedAt
      : snapshot.lastObservedAt;
  if (
    existing &&
    existing.host === lease.controller.host &&
    existing.observedCount === observedCount &&
    existing.truncated === truncated &&
    existing.lastObservedAt === lastObservedAt &&
    sameIdentities(existing.identities, bounded) &&
    sameGroups(existing.groups ?? [], boundedGroups)
  ) {
    return undefined;
  }
  return {
    ...lease,
    updatedAt: at,
    nestedProcesses: {
      version: 1,
      host: lease.controller.host,
      observedCount,
      truncated,
      lastObservedAt,
      ...(boundedGroups.length > 0
        ? { groups: boundedGroups.map(copyNestedGroup) }
        : {}),
      identities: bounded,
    },
  };
}

function copyNestedGroup(group: WorkerNestedGroup): WorkerNestedGroup {
  return {
    pgid: group.pgid,
    leader: copyIdentity(group.leader),
    observedMemberCount: group.observedMemberCount,
    lastObservedAt: group.lastObservedAt,
  };
}

function sameGroups(
  left: readonly WorkerNestedGroup[],
  right: readonly WorkerNestedGroup[],
): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    const first = left[index]!;
    const second = right[index]!;
    if (
      first.pgid !== second.pgid ||
      first.observedMemberCount !== second.observedMemberCount ||
      first.lastObservedAt !== second.lastObservedAt ||
      compareProcessIdentity(first.leader, second.leader) !== "match"
    ) {
      return false;
    }
  }
  return true;
}

/**
 * The terminal process-tree record may enrich the durable registry, but it
 * never removes identities and never invents them. A foreign-host record is
 * not nested-evidence authority.
 */
function enrichNestedFromRecord(
  lease: WorkerLease,
  record: WorkerProcessCleanupOutcome["record"],
  at: string,
): WorkerLease {
  const identities = record.observedExternalDescendants;
  const count = record.observedExternalDescendantCount;
  if (
    !identities ||
    identities.length === 0 ||
    count === undefined ||
    !sameHost(record.host, lease.controller.host)
  ) {
    return lease;
  }
  const snapshot: WorkerNestedProcesses = {
    version: 1,
    host: lease.controller.host,
    observedCount: Math.max(count, identities.length),
    truncated:
      count > identities.length ||
      count > MAX_WORKER_LEASE_NESTED_IDENTITIES,
    lastObservedAt: record.cleanedAt ?? at,
    identities: identities.map(copyIdentity),
  };
  return applyNestedSnapshot(lease, snapshot, at) ?? lease;
}

function sameIdentities(
  left: readonly RuntimeProcessIdentity[],
  right: readonly RuntimeProcessIdentity[],
): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    if (
      compareProcessIdentity(left[index], right[index]) !== "match" ||
      left[index]!.pid !== right[index]!.pid
    ) {
      return false;
    }
  }
  return true;
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

/**
 * Read-only projection of the optional durable nested registry. The liveness
 * counters are only classified when this host can inspect exact identities;
 * otherwise every identity is reported as `unknown`.
 */
export interface WorkerLeaseNestedStatus {
  present: boolean;
  observedCount: number;
  identityCount: number;
  truncated: boolean;
  lastObservedAt?: string;
  /** Persisted exact-led external groups; present only when any exist. */
  groupCount?: number;
  live: number;
  gone: number;
  reused: number;
  unknown: number;
}

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
  nestedProcesses: WorkerLeaseNestedStatus;
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
    nestedProcesses: await observeNestedForStatus(lease, inspector),
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

async function observeNestedForStatus(
  lease: WorkerLease,
  inspector: WorkerProcessTreeInspector,
): Promise<WorkerLeaseNestedStatus> {
  const nested = lease.nestedProcesses;
  if (!nested) {
    return {
      present: false,
      observedCount: 0,
      identityCount: 0,
      truncated: false,
      live: 0,
      gone: 0,
      reused: 0,
      unknown: 0,
    };
  }
  const leaders = (nested.groups ?? []).map((group) => group.leader);
  const status: WorkerLeaseNestedStatus = {
    present: true,
    observedCount: nested.observedCount,
    identityCount: nested.identities.length,
    truncated: nested.truncated,
    lastObservedAt: nested.lastObservedAt,
    ...(leaders.length > 0 ? { groupCount: leaders.length } : {}),
    live: 0,
    gone: 0,
    reused: 0,
    unknown: 0,
  };
  const observedIdentities = [...nested.identities, ...leaders];
  if (!sameHost(nested.host, inspector.host)) {
    status.unknown = observedIdentities.length;
    return status;
  }
  for (const identity of observedIdentities) {
    if (!inspector.isAlive(identity.pid)) {
      status.gone += 1;
      continue;
    }
    try {
      const observed = await inspector.capture(identity.pid);
      const comparison = compareProcessIdentity(identity, observed);
      if (comparison === "match") status.live += 1;
      else if (comparison === "mismatch") status.reused += 1;
      else status.unknown += 1;
    } catch {
      status.unknown += 1;
    }
  }
  return status;
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
  /**
   * Injection for tests; production only signals an exact revalidated pid.
   * Nested targets are never signalled by a process group.
   */
  killPid?: (pid: number, signal: NodeJS.Signals) => void;
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
  /** Present when the lease carried durable nested-descendant evidence. */
  nested?: WorkerLeaseNestedRecoveryStatus;
  leaseUpdated: boolean;
}

/** Bounded nested registry observation included in a recovery entry. */
export interface WorkerLeaseNestedRecoveryStatus {
  observedCount: number;
  persistedCount: number;
  truncated: boolean;
  targetCount: number;
  residualCount: number;
  /** Persisted exact-led external groups; present only when any exist. */
  groupCount?: number;
  /** External groups that could not be proven gone. */
  residualGroupCount?: number;
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
  killPid: (pid: number, signal: NodeJS.Signals) => void;
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
  /** Bounded nested registry observation for the recovery report. */
  nested?: WorkerLeaseNestedRecoveryStatus;
  /** Refreshed nested target set to persist; omitted leaves the registry. */
  nextNested?: WorkerNestedProcesses;
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
    killPid:
      options.killPid ??
      ((pid, signal) => {
        process.kill(pid, signal);
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

    const decision = await recoverActiveLease(lease, context, path);
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
      ...(decision.nested !== undefined ? { nested: decision.nested } : {}),
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
  path: string,
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

  return recoverWorkerGroup(lease, context, path);
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
  path: string,
): Promise<RecoveryDecision> {
  if (lease.nestedProcesses !== undefined) {
    return recoverNestedWorker(lease, context, path);
  }
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

/**
 * Recovery for a lease carrying durable nested-descendant evidence.
 *
 * The only signals are (a) the legacy guarded dedicated-group signal while
 * the exact top-level leader is present and (b) exact-pid signals to
 * revalidated nested identities. A leader that is absent or reused never
 * authorizes a negative-pgid signal.
 */
async function recoverNestedWorker(
  lease: WorkerLease,
  context: RecoveryContext,
  path: string,
): Promise<RecoveryDecision> {
  const registry = lease.nestedProcesses;
  if (registry === undefined) {
    return preserveNeedsHuman("nested descendant registry is absent");
  }

  const registryGroups = registry.groups ?? [];
  let targetCount = 0;
  let residualCount = 0;
  let residualGroupCount = 0;
  let persistedCount = registry.identities.length;
  let refreshedObservation = false;
  const nestedStatus = (): WorkerLeaseNestedRecoveryStatus => ({
    observedCount: refreshedObservation
      ? targetCount
      : registry.observedCount,
    persistedCount,
    truncated: registry.truncated,
    targetCount,
    residualCount,
    ...(registryGroups.length > 0
      ? {
          groupCount: registryGroups.length,
          residualGroupCount,
        }
      : {}),
  });
  const preserve = (
    reason: string,
    extras: Partial<RecoveryDecision> = {},
  ): RecoveryDecision => ({
    ...preserveNeedsHuman(reason),
    nested: nestedStatus(),
    ...extras,
  });

  // Rule 1: a truncated or structurally incomplete registry authorizes
  // nothing. All-or-nothing validation is repeated here because recovery must
  // not rely on a caller having re-parsed the lease.
  if (registry.truncated) {
    return preserve(
      "nested descendant registry is truncated; processes preserved",
    );
  }
  if (
    registry.version !== 1 ||
    !isTimestamp(registry.lastObservedAt) ||
    !Number.isInteger(registry.observedCount) ||
    registry.observedCount < 0 ||
    registry.observedCount > MAX_WORKER_LEASE_NESTED_COUNT ||
    !sameHost(registry.host, lease.controller.host) ||
    !sameHost(registry.host, context.inspector.host) ||
    registry.observedCount !== registry.identities.length ||
    registry.identities.length > MAX_WORKER_LEASE_NESTED_IDENTITIES
  ) {
    return preserve(
      "nested descendant registry is structurally incomplete; processes preserved",
    );
  }
  const seenPids = new Set<number>();
  for (const identity of registry.identities) {
    if (
      !isProcessIdentity(identity) ||
      identity.pid <= 1 ||
      seenPids.has(identity.pid)
    ) {
      return preserve(
        "nested descendant registry contains an invalid or duplicate identity; " +
          "processes preserved",
      );
    }
    seenPids.add(identity.pid);
  }
  // Group evidence must be structurally exact before it can authorize a
  // negative-pgid signal, even if a caller skipped the strict parser.
  if (registryGroups.length > MAX_WORKER_LEASE_NESTED_GROUPS) {
    return preserve(
      "nested group registry exceeds its bound; processes preserved",
    );
  }
  const groupIds = new Set<number>();
  for (const group of registryGroups) {
    if (
      !isProcessIdentity(group.leader) ||
      !isProcessPid(group.pgid) ||
      group.pgid <= 1 ||
      group.leader.pid !== group.pgid ||
      group.leader.pgid !== group.pgid ||
      groupIds.has(group.pgid) ||
      !Number.isInteger(group.observedMemberCount) ||
      group.observedMemberCount < 1 ||
      group.observedMemberCount > MAX_NESTED_GROUP_MEMBERS ||
      !isTimestamp(group.lastObservedAt)
    ) {
      return preserve(
        "nested group registry contains an invalid or duplicate group; " +
          "processes preserved",
      );
    }
    groupIds.add(group.pgid);
  }
  for (const identity of registry.identities) {
    if (groupIds.has(identity.pid) || groupIds.has(identity.pgid)) {
      return preserve(
        "nested fallback identity overlaps a persisted group; processes preserved",
      );
    }
  }

  const pid = lease.worker.pid;
  const pgid = lease.worker.pgid;
  const osStartIdentity = lease.worker.osStartIdentity;
  if (lease.worker.captureMode !== "posix-group") {
    return preserve(
      "worker was captured as windows-exact-child; no recoverable POSIX group",
    );
  }
  if (!isProcessPid(pid) || !isProcessPid(pgid) || !osStartIdentity) {
    return preserve(
      "exact worker pid/pgid/OS start identity is missing; processes preserved",
    );
  }
  if (pgid !== pid) {
    return preserve(
      "worker was not the leader of its dedicated process group; processes preserved",
    );
  }
  const expectedIdentity: RuntimeProcessIdentity = {
    pid,
    pgid,
    startedAt: osStartIdentity,
  };

  // Rule 2/3: classify the top-level leader. Capture errors stay ambiguous;
  // an absent or reused leader only disables group cleanup.
  let leaderObserved: RuntimeProcessIdentity | undefined;
  try {
    leaderObserved = await context.inspector.capture(pid);
  } catch {
    return preserve("worker identity could not be inspected; processes preserved");
  }
  const leaderPresent =
    leaderObserved !== undefined &&
    compareProcessIdentity(expectedIdentity, leaderObserved) === "match";
  if (
    leaderObserved !== undefined &&
    !leaderPresent &&
    compareProcessIdentity(expectedIdentity, leaderObserved) === "unknown"
  ) {
    return preserve("worker exact identity is ambiguous; processes preserved");
  }

  // An absent leader never authorizes a negative-pgid signal, but it must not
  // block the durable nested registry either: exact-pid recovery continues,
  // and any remaining worker-group members simply keep the lease unreleased
  // (checked after the target grace below).
  // Nested targets are signalled by pid, so the recovery process and its own
  // group must be provably excludable before any identity is collected.
  let ownGroupId: number;
  try {
    const own = await context.inspector.capture(process.pid);
    if (!own || !isProcessPid(own.pgid)) {
      return preserve(
        "cannot prove the recovery process group; processes preserved",
      );
    }
    ownGroupId = own.pgid;
  } catch {
    return preserve(
      "cannot inspect the recovery process group; processes preserved",
    );
  }

  // Rule 5: revalidate every persisted nested identity before any snapshot.
  const roots: RuntimeProcessIdentity[] = [];
  for (const identity of [...registry.identities].sort(
    (first, second) => first.pid - second.pid,
  )) {
    let observed: RuntimeProcessIdentity | undefined;
    try {
      observed = await context.inspector.capture(identity.pid);
    } catch {
      return preserve(
        "nested descendant identity could not be inspected; processes preserved",
      );
    }
    if (!observed) continue; // gone
    const comparison = compareProcessIdentity(identity, observed);
    if (comparison === "match") {
      // A fabricated registry never turns the recovery process or its own
      // group into a nested target.
      if (identity.pid === process.pid || identity.pgid === ownGroupId) {
        continue;
      }
      roots.push(identity);
      continue;
    }
    if (comparison === "mismatch") continue; // reused pid: never signalled
    return preserve(
      "nested descendant identity is ambiguous; processes preserved",
    );
  }

  // Rule 4/6: one bounded snapshot supplies both the leader's fresh
  // descendant graph and the recursive extension of matching nested roots.
  const targets = new Map<number, RuntimeProcessIdentity>();
  let graph: ProcessGraph | undefined;
  if (leaderPresent || roots.length > 0) {
    const snapshotProcessTable = context.inspector.snapshotProcessTable;
    if (typeof snapshotProcessTable !== "function") {
      return preserve(
        "process-table inspection is unavailable; processes preserved",
      );
    }
    let table: ProcessTableEntry[];
    try {
      table = await snapshotProcessTable.call(context.inspector, {
        maxEntries: MAX_PROCESS_TABLE_ROWS,
      });
    } catch {
      return preserve(
        "process table could not be snapshotted; processes preserved",
      );
    }
    graph = buildProcessGraph(table);
    if (!graph) {
      return preserve(
        "process table contains a malformed or duplicate row; processes preserved",
      );
    }
    if (leaderPresent) {
      const row = graph.byPid.get(pid);
      if (!row || compareProcessIdentity(expectedIdentity, row) !== "match") {
        return preserve(
          "worker leader identity changed during recovery; processes preserved",
        );
      }
      const walked = collectExternalDescendants(
        graph,
        expectedIdentity,
        pgid,
        ownGroupId,
        groupIds,
        targets,
      );
      if (walked !== "ok") {
        return preserve(
          `external descendants exceed the ${MAX_NESTED_SIGNAL_TARGETS}-process signal bound; processes preserved`,
        );
      }
    }
    for (const root of roots) {
      const row = graph.byPid.get(root.pid);
      if (!row || compareProcessIdentity(root, row) !== "match") {
        return preserve(
          "nested descendant root identity changed during recovery; " +
            "processes preserved",
        );
      }
      if (root.pid !== pid && !targets.has(root.pid)) {
        if (targets.size >= MAX_NESTED_SIGNAL_TARGETS) {
          return preserve(
            `external descendants exceed the ${MAX_NESTED_SIGNAL_TARGETS}-process signal bound; processes preserved`,
          );
        }
        targets.set(root.pid, copyIdentity(root));
      }
      const walked = collectExternalDescendants(
        graph,
        root,
        pgid,
        ownGroupId,
        groupIds,
        targets,
      );
      if (walked !== "ok") {
        return preserve(
          `external descendants exceed the ${MAX_NESTED_SIGNAL_TARGETS}-process signal bound; processes preserved`,
        );
      }
    }
  }
  targetCount = targets.size;
  refreshedObservation = true;

  // Rule 8: persist the refreshed group/fallback registry before any signal.
  // An empty registry never overwrites durable evidence.
  let checkpoint: WorkerNestedProcesses | undefined;
  if (targets.size > 0 || registryGroups.length > 0) {
    const at = context.now().toISOString();
    checkpoint = {
      version: 1,
      host: lease.controller.host,
      observedCount: targets.size,
      truncated: false,
      lastObservedAt: at,
      ...(registryGroups.length > 0
        ? { groups: registryGroups.map(copyNestedGroup) }
        : {}),
      identities: [...targets.values()]
        .sort((first, second) => first.pid - second.pid)
        .map(copyIdentity),
    };
    try {
      writeJsonAtomic(path, {
        ...lease,
        nestedProcesses: checkpoint,
        updatedAt: at,
      });
    } catch {
      return preserve(
        "refreshed nested target set could not be persisted; processes preserved",
      );
    }
    persistedCount = checkpoint.identities.length;
  }
  const checkpointExtra = checkpoint !== undefined ? { nextNested: checkpoint } : {};

  // Rule 9: the top-level group is cleaned only through the existing guarded
  // path and only while its exact leader is present.
  const groupResult = leaderPresent
    ? await cleanVerifiedWorkerGroup(expectedIdentity, pgid, context)
    : { ok: true, signals: [], residual: 0, reason: "" };
  const signals: WorkerProcessSignalRecord[] = [...groupResult.signals];

  // Rule 9b: every persisted external group is eligible only through a fresh
  // exact leader capture plus a fresh membership guard. A leader that is
  // absent, reused or mismatched never authorizes a negative-pgid signal.
  let groupFailure: string | undefined;
  for (const group of [...registryGroups].sort(
    (first, second) => first.pgid - second.pgid,
  )) {
    const result = await cleanVerifiedNestedGroup(
      group,
      pgid,
      context,
      signals,
    );
    if (!result.gone) {
      residualGroupCount += 1;
      groupFailure ??= result.failure;
    }
  }

  const targetIds = [...targets.values()].sort(
    (first, second) => first.pid - second.pid,
  );

  // Rule 10: SIGTERM exact nested pids only.
  let ambiguous = false;
  for (const target of targetIds) {
    if (!isSignalableTargetPid(target.pid)) continue;
    const state = await revalidateTarget(target, context);
    if (state === "match") {
      if (sendPidSignal(target.pid, "SIGTERM", context, signals) === "error") {
        ambiguous = true;
      }
    } else if (state === "unknown") {
      ambiguous = true;
    }
  }

  const termWait = await waitForTargetsGone(targetIds, context, context.termGraceMs);
  if (termWait.unknown) ambiguous = true;

  // Escalate only targets that still hold their exact identity.
  const killTargets: RuntimeProcessIdentity[] = [];
  for (const observed of termWait.alive) {
    const state = await revalidateTarget(observed, context);
    if (state === "match") {
      killTargets.push(observed);
      if (sendPidSignal(observed.pid, "SIGKILL", context, signals) === "error") {
        ambiguous = true;
      }
    } else if (state === "unknown") {
      ambiguous = true;
    }
  }
  const killWait = await waitForTargetsGone(killTargets, context, context.killGraceMs);
  if (killWait.unknown) ambiguous = true;

  // Rule 11: re-read every target after the final grace. A still-matching live
  // pid is residual; a reused pid is not ours and is never signalled.
  const finalTargets = await observeTargets(targetIds, context);
  if (finalTargets.unknown) ambiguous = true;
  residualCount = finalTargets.alive.length;

  // The group must also be provably empty before the lease can be released.
  let groupResidual = 0;
  try {
    const remaining = await context.inspector.listGroupMembers(pgid);
    groupResidual = remaining.length;
  } catch {
    ambiguous = true;
  }

  const reasonParts: string[] = [];
  if (groupResult.signals.length > 0) reasonParts.push(groupResult.reason);
  if (signals.length > groupResult.signals.length) {
    reasonParts.push(
      `${signals.length - groupResult.signals.length} nested signal(s) sent`,
    );
  }
  if (!groupResult.ok) reasonParts.push(groupResult.reason);
  if (groupFailure !== undefined) reasonParts.push(groupFailure);
  if (groupResidual > 0) {
    reasonParts.push(`${groupResidual} worker-group member(s) remain`);
  }
  if (residualCount > 0) {
    reasonParts.push(`${residualCount} nested target(s) remain`);
  }
  if (residualGroupCount > 0) {
    reasonParts.push(`${residualGroupCount} nested group(s) remain unproven`);
  }
  if (ambiguous) reasonParts.push("nested recovery stayed ambiguous");

  const recovered =
    !ambiguous &&
    residualCount === 0 &&
    residualGroupCount === 0 &&
    groupResidual === 0 &&
    (groupResult.ok || !leaderPresent);
  if (recovered) {
    const action: WorkerLeaseRecoveryEvidence["action"] =
      signals.length > 0 ? "terminated" : "already-exited";
    return {
      outcome: "recovered",
      action,
      reason:
        signals.length > 0
          ? "verified worker group and exact nested targets terminated"
          : "verified worker group and exact nested targets are already gone",
      controllerState: "dead",
      workerState: signals.length > 0 ? "terminated" : "exited",
      resumeNeeded: true,
      signals,
      nested: nestedStatus(),
      ...checkpointExtra,
      nextState: "released",
      cleanupReason: "recovery",
      cleanedAt: context.now().toISOString(),
    };
  }

  const reason =
    reasonParts.length > 0
      ? reasonParts.join("; ")
      : groupResult.reason || "nested recovery did not complete";
  const residual = Math.max(
    residualCount,
    groupResidual,
    residualGroupCount,
    groupResult.residual,
  );
  return {
    outcome: "needs_human",
    action: "preserved",
    reason: boundText(reason),
    controllerState: "dead",
    workerState: "preserved",
    resumeNeeded: false,
    signals,
    ...(residual > 0 ? { residualCount: residual } : {}),
    nested: nestedStatus(),
    ...checkpointExtra,
    // Only a signal that was actually delivered and then left a residual
    // marks the lease cleanup-failed; ambiguity before any signal keeps the
    // lease active so a later recovery can retry.
    ...(residual > 0 && signals.length > 0
      ? {
          nextState: "cleanup-failed" as WorkerLeaseState,
          cleanupReason: "recovery" as WorkerLeaseCleanupReason,
          cleanedAt: context.now().toISOString(),
        }
      : {}),
  };
}

interface ProcessGraph {
  byPid: Map<number, ProcessTableEntry>;
  children: Map<number, ProcessTableEntry[]>;
}

function buildProcessGraph(
  table: readonly ProcessTableEntry[],
): ProcessGraph | undefined {
  const byPid = new Map<number, ProcessTableEntry>();
  const children = new Map<number, ProcessTableEntry[]>();
  for (const entry of table) {
    if (
      !Number.isSafeInteger(entry.pid) ||
      entry.pid <= 0 ||
      !Number.isSafeInteger(entry.ppid) ||
      entry.ppid < 0 ||
      !Number.isSafeInteger(entry.pgid) ||
      entry.pgid < 0 ||
      typeof entry.startedAt !== "string" ||
      entry.startedAt.trim() === ""
    ) {
      return undefined;
    }
    if (byPid.has(entry.pid)) return undefined;
    byPid.set(entry.pid, entry);
    const siblings = children.get(entry.ppid);
    if (siblings) siblings.push(entry);
    else children.set(entry.ppid, [entry]);
  }
  return { byPid, children };
}

/**
 * Walk every descendant of one validated root. Only rows with a complete
 * exact identity and a process group outside the managed group become signal
 * targets; in-group descendants belong to the guarded group path.
 */
function collectExternalDescendants(
  graph: ProcessGraph,
  root: RuntimeProcessIdentity,
  managedPgid: number,
  ownGroupId: number,
  knownGroupPgids: ReadonlySet<number>,
  targets: Map<number, RuntimeProcessIdentity>,
): "ok" | "over-bound" {
  const queue: number[] = [root.pid];
  const seen = new Set<number>([root.pid]);
  while (queue.length > 0) {
    const parent = queue.shift() as number;
    for (const child of graph.children.get(parent) ?? []) {
      if (seen.has(child.pid)) continue;
      seen.add(child.pid);
      // The recovery process and its own group are never traversed or
      // signalled, even if a fabricated table makes them descendants.
      const ownProcess =
        child.pid === process.pid || child.pgid === ownGroupId;
      // Members of a persisted exact-led group are one bounded group unit,
      // never individual exact-pid targets. The walk itself is bounded by the
      // bounded process-table snapshot, not by a descendant-pid cap.
      const groupMember = knownGroupPgids.has(child.pgid);
      if (
        !ownProcess &&
        !groupMember &&
        isProcessIdentity(child) &&
        child.pid > 1 &&
        child.pgid !== managedPgid &&
        !targets.has(child.pid)
      ) {
        if (targets.size >= MAX_NESTED_SIGNAL_TARGETS) return "over-bound";
        targets.set(child.pid, copyIdentity(child));
      }
      if (!ownProcess && child.pid > 1) queue.push(child.pid);
    }
  }
  return "ok";
}

function isSignalableTargetPid(pid: number): boolean {
  return isProcessPid(pid) && pid > 1 && pid !== process.pid;
}

/** `match` means the recorded identity still owns the pid. */
async function revalidateTarget(
  identity: RuntimeProcessIdentity,
  context: RecoveryContext,
): Promise<"match" | "gone" | "reused" | "unknown"> {
  let observed: RuntimeProcessIdentity | undefined;
  try {
    observed = await context.inspector.capture(identity.pid);
  } catch {
    return "unknown";
  }
  if (!observed) return "gone";
  const comparison = compareProcessIdentity(identity, observed);
  if (comparison === "match") return "match";
  if (comparison === "mismatch") return "reused";
  return "unknown";
}

function sendPidSignal(
  pid: number,
  signal: "SIGTERM" | "SIGKILL",
  context: RecoveryContext,
  signals: WorkerProcessSignalRecord[],
): "sent" | "gone" | "error" {
  if (!isSignalableTargetPid(pid)) return "gone";
  try {
    context.killPid(pid, signal);
    signals.push({
      signal,
      scope: "descendant-pid",
      pid,
      at: context.now().toISOString(),
      result: "sent",
    });
    return "sent";
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return "gone";
    signals.push({
      signal,
      scope: "descendant-pid",
      pid,
      at: context.now().toISOString(),
      result: "failed",
      detail: boundText(error instanceof Error ? error.message : String(error)),
    });
    return "error";
  }
}

interface TargetObservation {
  alive: RuntimeProcessIdentity[];
  unknown: boolean;
}

async function observeTargets(
  targets: readonly RuntimeProcessIdentity[],
  context: RecoveryContext,
): Promise<TargetObservation> {
  const alive: RuntimeProcessIdentity[] = [];
  let unknown = false;
  for (const target of targets) {
    if (!isSignalableTargetPid(target.pid)) continue;
    let observed: RuntimeProcessIdentity | undefined;
    try {
      observed = await context.inspector.capture(target.pid);
    } catch {
      unknown = true;
      continue;
    }
    if (!observed) continue;
    const comparison = compareProcessIdentity(target, observed);
    if (comparison === "match") alive.push(observed);
    else if (comparison === "unknown") unknown = true;
  }
  return { alive, unknown };
}

async function waitForTargetsGone(
  targets: readonly RuntimeProcessIdentity[],
  context: RecoveryContext,
  graceMs: number,
): Promise<TargetObservation> {
  const deadline = Date.now() + graceMs;
  for (;;) {
    const observation = await observeTargets(targets, context);
    if (observation.alive.length === 0 && !observation.unknown) {
      return observation;
    }
    if (Date.now() >= deadline) return observation;
    await sleep(Math.min(context.pollMs, Math.max(1, deadline - Date.now())));
  }
}

interface GroupCleanupResult {
  ok: boolean;
  signals: WorkerProcessSignalRecord[];
  residual: number;
  reason: string;
}

/** Existing guarded dedicated-group cleanup, shared by nested recovery. */
async function cleanVerifiedWorkerGroup(
  identity: RuntimeProcessIdentity,
  pgid: number,
  context: RecoveryContext,
): Promise<GroupCleanupResult> {
  let members: ProcessGroupMember[];
  try {
    members = await context.inspector.listGroupMembers(pgid);
  } catch {
    return {
      ok: false,
      signals: [],
      residual: 0,
      reason: "worker group could not be listed; processes preserved",
    };
  }
  if (members.length === 0) {
    return { ok: true, signals: [], residual: 0, reason: "verified worker group is already gone" };
  }
  const guard = await groupSignalAllowed(pgid, identity, members, context);
  if (!guard.ok) {
    return { ok: false, signals: [], residual: members.length, reason: guard.reason };
  }
  const signals: WorkerProcessSignalRecord[] = [];
  const term = sendGroupSignal(pgid, "SIGTERM", context, signals);
  if (term === "error") {
    return {
      ok: false,
      signals,
      residual: members.length,
      reason: "SIGTERM to the verified worker group failed; processes preserved",
    };
  }
  try {
    members = await waitForGroupEmpty(pgid, context, context.termGraceMs);
  } catch {
    return {
      ok: false,
      signals,
      residual: members.length,
      reason: "worker group became uninspectable after SIGTERM; processes preserved",
    };
  }
  if (members.length === 0) {
    return {
      ok: true,
      signals,
      residual: 0,
      reason: "verified worker group terminated after SIGTERM",
    };
  }
  const residualBeforeKill = members.length;
  const killGuard = await groupSignalAllowed(pgid, identity, members, context);
  if (!killGuard.ok) {
    return {
      ok: false,
      signals,
      residual: residualBeforeKill,
      reason: killGuard.reason,
    };
  }
  const kill = sendGroupSignal(pgid, "SIGKILL", context, signals);
  if (kill === "error") {
    return {
      ok: false,
      signals,
      residual: residualBeforeKill,
      reason: "SIGKILL to the verified worker group failed; processes preserved",
    };
  }
  try {
    members = await waitForGroupEmpty(pgid, context, context.killGraceMs);
  } catch {
    return {
      ok: false,
      signals,
      residual: residualBeforeKill,
      reason: "worker group became uninspectable after SIGKILL; lease preserved",
    };
  }
  if (members.length === 0) {
    return {
      ok: true,
      signals,
      residual: 0,
      reason: "verified worker group terminated after SIGTERM/SIGKILL",
    };
  }
  return {
    ok: false,
    signals,
    residual: members.length,
    reason: `verified worker group still has ${members.length} member(s) after SIGKILL`,
  };
}

/**
 * Guarded negative-pgid cleanup for one persisted external group. The leader
 * must be re-captured and its exact identity re-proven before SIGTERM, before
 * SIGKILL, and against every fresh membership listing. Any ambiguity leaves
 * the group unproven; it is never signalled speculatively.
 */
async function cleanVerifiedNestedGroup(
  group: WorkerNestedGroup,
  workerPgid: number,
  context: RecoveryContext,
  signals: WorkerProcessSignalRecord[],
): Promise<{ gone: boolean; failure?: string }> {
  const pgid = group.pgid;
  let leader: RuntimeProcessIdentity | undefined;
  try {
    leader = await context.inspector.capture(group.leader.pid);
  } catch {
    return {
      gone: false,
      failure: `nested group ${pgid} leader could not be inspected; group preserved`,
    };
  }
  if (!leader) {
    // An absent leader never authorizes a group signal, even when members
    // remain. Only exact-pid fallback (already revalidated separately) may act.
    let members: ProcessGroupMember[];
    try {
      members = await context.inspector.listGroupMembers(pgid);
    } catch {
      return {
        gone: false,
        failure: `nested group ${pgid} could not be inspected; group preserved`,
      };
    }
    if (members.length === 0) return { gone: true };
    return {
      gone: false,
      failure:
        `nested group ${pgid} leader is absent while ` +
        `${members.length} member(s) remain; group not signalled`,
    };
  }
  if (
    compareProcessIdentity(group.leader, leader) !== "match" ||
    leader.pid !== pgid ||
    leader.pgid !== pgid
  ) {
    return {
      gone: false,
      failure:
        `nested group ${pgid} leader identity changed or was reused; ` +
        "group not signalled",
    };
  }

  let members: ProcessGroupMember[];
  try {
    members = await context.inspector.listGroupMembers(pgid);
  } catch {
    return {
      gone: false,
      failure: `nested group ${pgid} could not be listed; group preserved`,
    };
  }
  if (members.length === 0) return { gone: true };

  const guard = await nestedGroupRecoveryAllowed(
    group,
    leader,
    members,
    workerPgid,
    context,
  );
  if (!guard.ok) return { gone: false, failure: guard.reason };

  const term = sendNestedGroupSignal(pgid, "SIGTERM", context, signals);
  if (term === "error") {
    return {
      gone: false,
      failure: `SIGTERM to nested group ${pgid} failed; group preserved`,
    };
  }
  if (term === "gone") {
    let remaining: ProcessGroupMember[];
    try {
      remaining = await context.inspector.listGroupMembers(pgid);
    } catch {
      return {
        gone: false,
        failure: `nested group ${pgid} could not be re-inspected after SIGTERM`,
      };
    }
    return remaining.length === 0
      ? { gone: true }
      : {
          gone: false,
          failure: `nested group ${pgid} disappeared while member(s) remain`,
        };
  }
  try {
    members = await waitForGroupEmpty(pgid, context, context.termGraceMs);
  } catch {
    return {
      gone: false,
      failure: `nested group ${pgid} became uninspectable after SIGTERM`,
    };
  }
  if (members.length === 0) return { gone: true };

  // SIGKILL requires the same fresh exact leader proof, not the SIGTERM-time
  // evidence.
  let revalidated: RuntimeProcessIdentity | undefined;
  try {
    revalidated = await context.inspector.capture(group.leader.pid);
  } catch {
    return {
      gone: false,
      failure: `nested group ${pgid} leader could not be revalidated after SIGTERM`,
    };
  }
  if (
    !revalidated ||
    compareProcessIdentity(group.leader, revalidated) !== "match"
  ) {
    return {
      gone: false,
      failure:
        `nested group ${pgid} leader identity is no longer exact after ` +
        "SIGTERM; refusing SIGKILL",
    };
  }
  const killGuard = await nestedGroupRecoveryAllowed(
    group,
    revalidated,
    members,
    workerPgid,
    context,
  );
  if (!killGuard.ok) return { gone: false, failure: killGuard.reason };

  const kill = sendNestedGroupSignal(pgid, "SIGKILL", context, signals);
  if (kill === "error") {
    return {
      gone: false,
      failure: `SIGKILL to nested group ${pgid} failed; group preserved`,
    };
  }
  if (kill === "gone") {
    let remaining: ProcessGroupMember[];
    try {
      remaining = await context.inspector.listGroupMembers(pgid);
    } catch {
      return {
        gone: false,
        failure: `nested group ${pgid} could not be re-inspected after SIGKILL`,
      };
    }
    return remaining.length === 0
      ? { gone: true }
      : {
          gone: false,
          failure: `nested group ${pgid} disappeared while member(s) remain`,
        };
  }
  try {
    members = await waitForGroupEmpty(pgid, context, context.killGraceMs);
  } catch {
    return {
      gone: false,
      failure: `nested group ${pgid} became uninspectable after SIGKILL`,
    };
  }
  if (members.length === 0) return { gone: true };
  return {
    gone: false,
    failure:
      `nested group ${pgid} still has ${members.length} member(s) after SIGKILL`,
  };
}

async function nestedGroupRecoveryAllowed(
  group: WorkerNestedGroup,
  observed: RuntimeProcessIdentity,
  members: readonly ProcessGroupMember[],
  workerPgid: number,
  context: RecoveryContext,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const pgid = group.pgid;
  if (
    !isProcessPid(pgid) ||
    pgid <= 1 ||
    group.leader.pid !== pgid ||
    group.leader.pgid !== pgid ||
    observed.pid !== pgid ||
    observed.pgid !== pgid ||
    compareProcessIdentity(group.leader, observed) !== "match"
  ) {
    return {
      ok: false,
      reason: `nested group ${pgid} leader is not an exact owned identity`,
    };
  }
  if (pgid === workerPgid) {
    return {
      ok: false,
      reason: "refusing the managed worker group as a nested group",
    };
  }
  return groupSignalAllowed(pgid, group.leader, members, context);
}

function sendNestedGroupSignal(
  pgid: number,
  signal: "SIGTERM" | "SIGKILL",
  context: RecoveryContext,
  signals: WorkerProcessSignalRecord[],
): "sent" | "gone" | "error" {
  try {
    context.killGroup(pgid, signal);
    signals.push({
      signal,
      scope: "nested-process-group",
      pgid,
      at: context.now().toISOString(),
      result: "sent",
    });
    return "sent";
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return "gone";
    signals.push({
      signal,
      scope: "nested-process-group",
      pgid,
      at: context.now().toISOString(),
      result: "failed",
      detail: boundText(error instanceof Error ? error.message : String(error)),
    });
    return "error";
  }
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
    ...(decision.nextNested !== undefined
      ? { nestedProcesses: decision.nextNested }
      : {}),
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

function timestampMs(value: string): number | undefined {
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? undefined : parsed;
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

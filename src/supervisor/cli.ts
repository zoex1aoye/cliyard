/**
 * Supervisor v0 CLI: foreground `start` / `resume`, read-only `status` and
 * `evidence`, orphan-runtime `reap`, and a cooperative `stop`.
 *
 * Durability lives in the RunManifest store; the worker batch persists a
 * checkpoint after every accepted task. `resume` reloads that manifest, checks
 * the contracts / base / integration preconditions, and dispatches only tasks
 * that are not accepted yet.
 *
 * `start` and `resume` reconcile orphaned runtime processes after acquiring the
 * repository lock and before creating or marking a run. Any runtime that needs
 * human review fails the command closed (design/runtime-orphan-reaper-v0.md).
 */
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  readFileSync,
  readdirSync,
  statSync,
  unlinkSync,
  type Dirent,
} from "node:fs";
import { hostname } from "node:os";
import { basename, extname, join, resolve } from "node:path";
import {
  isWorkerProgressEvent,
  type WorkerProgressEvent,
} from "../agents/types.js";
import {
  buildWorkerLeaseStatus,
  readWorkerLeases,
  recoverWorkerLeases,
  type WorkerLease,
  type WorkerLeaseRecoveryReport,
  type WorkerLeaseStatusReport,
} from "../agents/worker-lease.js";
import {
  BUDGET_CONTINUATION_POLICY_VERSION,
  DEFAULT_BUDGET_CONTINUATION_POLICY,
  DEFAULT_DEADLINE_EXTENSION_POLICY,
  MAX_BUDGET_CONTINUATIONS,
  MAX_BUDGET_GUARD_USD,
  MAX_DEADLINE_TIMEOUT_MS,
  parseBudgetContinuationPolicy,
  parseBudgetGuardUsd,
  parseDeadlineExtensionPolicy,
  type BudgetContinuationPolicy,
  type DeadlineExtensionPolicy,
} from "../agents/continuation.js";
import {
  DEFAULT_EXECUTION_CONTINUITY,
  executionContinuity,
  type ExecutionContinuityPolicy,
  type TaskContract,
} from "../contracts/schema.js";
import {
  parseRuntimeHandle,
  runtimeHandleKey,
  type RuntimeHandle,
} from "../execution/types.js";
import {
  aggregateCostTruth,
  COST_STATES,
  type CostTruth,
  type FailureRecord,
} from "../failures.js";
import {
  compareProcessIdentity,
  ProcessInspector,
} from "../runtime/process.js";
import type { RuntimeProcessIdentity } from "../runtime/types.js";
import { RUNTIME_MANIFEST_FILE } from "../runtime/manager.js";
import { portAllocatorPaths } from "../runtime/ports.js";
import {
  reapOrphanedRuntimes,
  type RuntimeReapReport,
} from "../runtime/reaper-execute.js";
import type {
  RuntimeCleanupState,
  RuntimeRecoveryRecord,
} from "../runtime/types.js";
import {
  listReusableAttempts,
  runCodexBatch,
  workerEventsDir,
  type CodexBatchOptions,
  type CodexBatchResult,
} from "../scheduler/codex-batch.js";
import { loadContractsInput } from "../scheduler/mock-batch.js";
import {
  acquireSupervisorLock,
  assertContractsHash,
  clearStaleSupervisorLock,
  computeContractsHash,
  createRunManifest,
  getActiveRunId,
  inspectRun,
  inspectSupervisorLock,
  isProcessAlive,
  isSameHost,
  loadRunManifest,
  setActiveRun,
  SupervisorLockHeldError,
  updateRunManifest,
  type RunInspection,
  type SupervisorLockHandle,
  type SupervisorLockInspection,
} from "./store.js";
import {
  EVIDENCE_BUNDLE_VERSION,
  evidenceBundlePath,
  MAX_EVIDENCE_BUNDLE_BYTES,
  runManifestHash,
  writeEvidenceBundle,
  type EvidenceNextAction,
  type EvidenceRepositoryFacts,
} from "./evidence-bundle.js";
import type {
  ReusableAttempt,
  RunManifest,
  RunOwner,
  RunStatus,
  RunTaskState,
  SupervisorLockInfo,
  WorkspaceBoundaryRecordStatus,
} from "./types.js";

const STOP_TIMEOUT_MS = 5_000;
/**
 * A worker event older than this is shown as stale. Staleness is display-only:
 * it never changes the run status or any acceptance decision.
 */
export const WORKER_PROGRESS_STALE_MS = 60_000;

export interface SupervisorCliOptions {
  /** Output sink; defaults to console.log. */
  log?: (line: string) => void;
  /**
   * Diagnostics sink for progress that is not part of the machine-readable
   * summary. Defaults to stderr so `start`/`resume` stdout stays valid JSON.
   */
  diagnostics?: (line: string) => void;
  /** Test seam forwarded to the worker batch. */
  workerFactory?: CodexBatchOptions["workerFactory"];
  /**
   * The real CLI installs SIGINT/SIGTERM handlers so a foreground run is
   * checkpointed as interrupted before exit. Tests that drive the CLI
   * in-process can disable them.
   */
  signalHandling?: boolean;
  /**
   * Hard bound for holding a durable execution attachment at start/resume.
   * A durable unit that is still running at the bound preserves its processes
   * and fails the command closed instead of waiting forever.
   */
  durableAttachTimeoutMs?: number;
}

/** A recovery record already persisted in a runtime manifest. */
export interface SupervisorRuntimeRecovery {
  runtimeId: string;
  cleanup?: RuntimeCleanupState;
  recovery: RuntimeRecoveryRecord;
}

/**
 * Read-only view of a task's latest valid worker progress event. `stale` only
 * describes age; it has no effect on run status or acceptance.
 */
export interface WorkerProgressStatus {
  taskId: string;
  event: WorkerProgressEvent;
  ageMs: number;
  stale: boolean;
}

/** Concise, bounded per-task WorkspaceBoundary evidence for status output. */
export interface SupervisorBoundaryTaskEvidence {
  taskId: string;
  status: WorkspaceBoundaryRecordStatus;
  capturedAt: string;
  comparedAt: string;
  /** Total bounded change count from the durable record. */
  changeCount: number;
  /** Display preview of evidence paths; the durable record is the authority. */
  changedPaths: string[];
  error?: string;
}

export interface SupervisorWorkspaceBoundaryStatus {
  tasks: number;
  clean: number;
  violations: number;
  inspectionErrors: number;
  evidence: SupervisorBoundaryTaskEvidence[];
}

/**
 * Bounded, read-only view of `.cliyard/evidence/<runId>.json`. The bundle file
 * is the review artifact; the RunManifest remains task authority. `present`
 * means the file parsed, is bound to the current manifest hash and carries the
 * same run/task identity. Anything else for a terminal run is degraded.
 */
export type SupervisorEvidenceState =
  | "not-terminal"
  | "missing"
  | "invalid"
  | "present";

export interface SupervisorEvidenceCostStatus {
  state: CostTruth["state"];
  amount: number | null;
  currency: string | null;
  authoritative: boolean;
}

export interface SupervisorEvidenceStatus {
  state: SupervisorEvidenceState;
  runId: string;
  /** Absolute expected bundle path. */
  path: string;
  /** `true` when a terminal run has missing or invalid evidence. */
  degraded: boolean;
  /** Bounded explanation for a missing, invalid or unavailable bundle. */
  reason: string | null;
  generatedAt: string | null;
  nextAction: EvidenceNextAction | null;
  humanReviewRequired: boolean | null;
  /** SHA-256 binding recorded in the bundle, when the file parsed. */
  manifestHash: string | null;
  taskCount: number | null;
  /** Total missing-observation count in the bundle. */
  missingCount: number;
  /** Bounded display preview; the bundle file remains the authority. */
  missing: string[];
  cost: SupervisorEvidenceCostStatus | null;
}

/** JSON shape of `supervisor evidence`; never includes the full bundle. */
export interface SupervisorEvidenceCommandResult {
  regenerated: boolean;
  /** `true` when regeneration changed the bundle bytes. */
  written: boolean;
  /** Bounded failure reason, never a raw stack or credential. */
  error: string | null;
  evidence: SupervisorEvidenceStatus;
}

export interface SupervisorStatus {
  runId: string;
  planId: string;
  status: RunStatus;
  repoRoot: string;
  contractsPath: string;
  contractsHash: string;
  baseCommit: string;
  integrationBranch: string;
  integrationHead: string;
  integrationBranchHead: string | null;
  accepted: number;
  pending: number;
  blocked: number;
  total: number;
  tasks: RunTaskState[];
  owner: RunOwner;
  ownerAlive: boolean | null;
  interrupted: boolean;
  /** `interrupted` when a running manifest's owner is gone, else `status`. */
  effectiveStatus: RunStatus;
  activeRunId: string | null;
  lock: {
    state: SupervisorLockInspection["state"];
    path: string;
    owner: SupervisorLockInfo | null;
    reason: string | null;
  };
  /** Timestamp of the last manifest checkpoint write. */
  lastCheckpoint: string;
  lastAccepted: RunTaskState | null;
  /** Rejected attempts whose recorded worktree still validates for reuse. */
  reusableAttempts: ReusableAttempt[];
  /** Latest valid worker event per task, oldest first. Never run authority. */
  workerProgress: WorkerProgressStatus[];
  /** Recovery evidence persisted by earlier reaper runs; never reconciled here. */
  runtimeRecovery: SupervisorRuntimeRecovery[];
  /**
   * Bounded worker-lease evidence for this run. Lease state never changes task
   * acceptance or the manifest; malformed/missing records only degrade it.
   */
  workerLeases: WorkerLeaseStatusReport;
  /**
   * Concise WorkspaceBoundary v1 projection. Detection only: it records
   * guard outcomes and never grants acceptance or claims prevention.
   */
  workspaceBoundary: SupervisorWorkspaceBoundaryStatus;
  /**
   * Bounded controller EvidenceBundle projection. A terminal run with a
   * missing or invalid bundle is explicitly degraded; this projection never
   * writes, repairs or changes task acceptance.
   */
  evidence: SupervisorEvidenceStatus;
}

export async function runSupervisorCli(
  argv: string[],
  options: SupervisorCliOptions = {},
): Promise<number> {
  const log = options.log ?? ((line: string) => console.log(line));
  const diagnostics =
    options.diagnostics ?? ((line: string) => console.error(line));
  const [cmd, ...rest] = argv;
  if (!cmd) {
    printUsage(log);
    return 1;
  }
  if (cmd === "-h" || cmd === "--help") {
    printUsage(log);
    return 0;
  }

  switch (cmd) {
    case "start":
      return startCommand(rest, options, log, diagnostics);
    case "status":
      return statusCommand(rest, options, log);
    case "evidence":
      return evidenceCommand(rest, options, log);
    case "resume":
      return resumeCommand(rest, options, log, diagnostics);
    case "reap":
      return reapCommand(rest, options, log);
    case "recover-workers":
      return recoverWorkersCommand(rest, options, log);
    case "stop":
      return stopCommand(rest, options, log);
    default:
      log(`unknown supervisor command: ${cmd}`);
      printUsage(log);
      return 1;
  }
}

// ---------------------------------------------------------------------------
// execution.continuity
// ---------------------------------------------------------------------------

/**
 * Legacy default: a task whose contract does not opt into durable execution is
 * stopped on lease expiry. The bound keeps a durable re-attach from turning a
 * resume into an unbounded wait.
 */
export const DEFAULT_DURABLE_ATTACH_TIMEOUT_MS = 30_000;
export const MAX_DURABLE_ATTACH_TIMEOUT_MS = 600_000;
const DURABLE_ATTACH_POLL_MS = 50;

export class ExecutionContinuityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

export interface DurableAttachment {
  taskId: string;
  leaseId: string;
  /** Stable `(backendType, handle)` identity; pid/pgid are diagnostics only. */
  handle: RuntimeHandle;
}

export interface ExecutionContinuityReport {
  /** Durable units proven live and held until they exited or the bound hit. */
  attached: DurableAttachment[];
  /** Durable units whose exact identity was already gone. */
  exited: DurableAttachment[];
  /** Fail-closed task ids stopped by exact-identity lease recovery. */
  stopped: string[];
  /** Task ids whose effective policy was durable. */
  durable: string[];
  /** Task ids whose effective policy was fail-closed. */
  failClosed: string[];
}

interface ContinuityReconcileOptions {
  repoRoot: string;
  runId: string;
  contracts: readonly TaskContract[];
  log: (line: string) => void;
  durableAttachTimeoutMs?: number;
}

type DurableLeaseObservation =
  | { state: "live"; handle: RuntimeHandle }
  | { state: "exited"; handle: RuntimeHandle }
  | { state: "live-owner" }
  | { state: "blocked"; reason: string };

/**
 * Apply `execution.continuity` to the previous controller's active worker
 * leases at start/resume.
 *
 * Controller death is the observed lease-expiry point. A fail-closed lease is
 * stopped through the existing exact-identity recovery routine; a durable
 * lease is re-attached by its stable process-group RuntimeHandle, never
 * signalled, and held only until it exits or the hard bound is reached. A
 * durable unit that outlives the bound preserves its processes and fails the
 * command closed. Ambiguous identities always preserve processes and block the
 * run. This function never edits the RunManifest and never changes task
 * acceptance.
 */
async function reconcileExecutionContinuity(
  options: ContinuityReconcileOptions,
): Promise<ExecutionContinuityReport> {
  const timeoutMs = durableAttachTimeout(options.durableAttachTimeoutMs);
  const policyByTask = new Map<string, ExecutionContinuityPolicy>();
  for (const contract of options.contracts) {
    policyByTask.set(contract.taskId, executionContinuity(contract));
  }
  const policyFor = (taskId: string | undefined): ExecutionContinuityPolicy =>
    taskId === undefined
      ? DEFAULT_EXECUTION_CONTINUITY
      : policyByTask.get(taskId) ?? DEFAULT_EXECUTION_CONTINUITY;

  const read = readWorkerLeases(options.repoRoot, { runId: options.runId });
  if (read.truncated) {
    throw new ExecutionContinuityError(
      `worker-lease scan for run ${options.runId} was truncated; ` +
        "refusing to infer continuity for unread leases",
    );
  }
  if (read.malformed.length > 0) {
    throw new ExecutionContinuityError(
      `worker-lease state for run ${options.runId} is ambiguous: ` +
        read.malformed
          .map((entry) => `${entry.taskId ?? entry.path}: ${entry.reason}`)
          .join("; "),
    );
  }
  const active = read.leases.filter((lease) => lease.state === "active");
  const report: ExecutionContinuityReport = {
    attached: [],
    exited: [],
    stopped: [],
    durable: [],
    failClosed: [],
  };
  if (active.length === 0) return report;

  const durableLeases = active.filter(
    (lease) => policyFor(lease.taskId) === "durable",
  );
  const failClosedLeases = active.filter(
    (lease) => policyFor(lease.taskId) !== "durable",
  );
  report.durable = sortedTaskIds(durableLeases);
  report.failClosed = sortedTaskIds(failClosedLeases);
  if (failClosedLeases.length === 0) {
    options.log(
      `continuity: ${durableLeases.length} durable worker lease(s) found; ` +
        "no fail-closed unit requires lease-expiry stop",
    );
  }

  const inspector = new ProcessInspector();
  const live = new Map<
    string,
    { lease: WorkerLease; handle: RuntimeHandle }
  >();
  for (const lease of durableLeases) {
    const observation = await observeDurableLease(lease, inspector);
    if (observation.state === "blocked") {
      throw new ExecutionContinuityError(
        `durable task ${lease.taskId}: ${observation.reason}; ` +
          "processes and lease preserved, no task dispatched",
      );
    }
    if (observation.state === "live-owner") {
      throw new ExecutionContinuityError(
        `durable task ${lease.taskId}: the controller recorded in lease ` +
          `${lease.leaseId} is still alive; refusing to take over a live owner`,
      );
    }
    if (observation.state === "exited") {
      report.exited.push({
        taskId: lease.taskId,
        leaseId: lease.leaseId,
        handle: observation.handle,
      });
      options.log(
        `continuity: durable task ${lease.taskId} already exited; ` +
          `RuntimeHandle ${runtimeHandleKey(observation.handle)} not re-attached`,
      );
      continue;
    }
    const attachment: DurableAttachment = {
      taskId: lease.taskId,
      leaseId: lease.leaseId,
      handle: observation.handle,
    };
    report.attached.push(attachment);
    live.set(lease.leaseId, { lease, handle: observation.handle });
    options.log(
      `continuity: durable task ${lease.taskId} re-attached by RuntimeHandle ` +
        `${runtimeHandleKey(observation.handle)} (lease ${lease.leaseId})`,
    );
  }

  await waitForDurableUnitsToExit(live, inspector, timeoutMs, options.log);

  if (failClosedLeases.length > 0) {
    // The recovery routine is run-scoped and would also inspect durable
    // leases. Durable units were confirmed gone above; the guard is a final
    // guarantee that no signal can reach an identity the contract preserved.
    const guard = durableSignalTargets(durableLeases);
    const refused: string[] = [];
    const recovery = await recoverWorkerLeases({
      repoRoot: options.repoRoot,
      runId: options.runId,
      inspector,
      killGroup: (pgid, signal) => {
        if (guard.pgids.has(pgid)) {
          refused.push(`pgid ${pgid}`);
          return;
        }
        process.kill(-pgid, signal);
      },
      killPid: (pid, signal) => {
        if (guard.pids.has(pid)) {
          refused.push(`pid ${pid}`);
          return;
        }
        process.kill(pid, signal);
      },
    });
    if (recovery.truncated) {
      throw new ExecutionContinuityError(
        `worker-lease recovery scan for run ${options.runId} was truncated; ` +
          "refusing to dispatch with unread fail-closed leases",
      );
    }
    if (refused.length > 0) {
      throw new ExecutionContinuityError(
        `worker-lease recovery attempted to signal durable execution ` +
          `target(s) ${[...new Set(refused)].sort().join(", ")}; processes ` +
          "preserved and no task dispatched",
      );
    }
    for (const entry of recovery.entries) {
      if (
        entry.taskId !== undefined &&
        policyFor(entry.taskId) === "durable"
      ) {
        // A durable lease whose unit already exited is preserved as
        // needs_human evidence by the shared recovery routine. It never
        // blocks dispatch and its processes are never signalled.
        continue;
      }
      if (entry.outcome === "needs_human") {
        throw new ExecutionContinuityError(
          `fail-closed worker lease ${entry.taskId ?? entry.path} needs ` +
            `human review: ${entry.reason}`,
        );
      }
      if (entry.outcome === "recovered") {
        const taskId = entry.taskId ?? entry.path;
        report.stopped.push(taskId);
        options.log(
          `continuity: fail-closed task ${taskId} stopped on lease expiry ` +
            `(${entry.action})`,
        );
        continue;
      }
      // A lease another process already released is safe to continue; a
      // cleanup-failed or unknown lease may still own processes, so it must
      // not be followed by a duplicate dispatch.
      if (entry.reason === "lease is already released") continue;
      throw new ExecutionContinuityError(
        `fail-closed worker lease ${entry.taskId ?? entry.path} was not ` +
          `recovered: ${entry.reason}`,
      );
    }
    for (const lease of failClosedLeases) {
      if (!recovery.entries.some((entry) => entry.leaseId === lease.leaseId)) {
        throw new ExecutionContinuityError(
          `fail-closed task ${lease.taskId}: lease ${lease.leaseId} has no ` +
            "recovery decision",
        );
      }
    }
  }

  // Lease files are read in directory order; keep the summary deterministic.
  const byTaskAndLease = (left: DurableAttachment, right: DurableAttachment) =>
    left.taskId.localeCompare(right.taskId) ||
    left.leaseId.localeCompare(right.leaseId);
  report.attached.sort(byTaskAndLease);
  report.exited.sort(byTaskAndLease);
  report.stopped = [...new Set(report.stopped)].sort();
  return report;
}

function durableAttachTimeout(value: number | undefined): number {
  const timeout = value ?? DEFAULT_DURABLE_ATTACH_TIMEOUT_MS;
  if (
    !Number.isSafeInteger(timeout) ||
    timeout <= 0 ||
    timeout > MAX_DURABLE_ATTACH_TIMEOUT_MS
  ) {
    throw new ExecutionContinuityError(
      "durableAttachTimeoutMs must be a positive safe integer no greater " +
        `than ${MAX_DURABLE_ATTACH_TIMEOUT_MS}`,
    );
  }
  return timeout;
}

function sortedTaskIds(leases: readonly WorkerLease[]): string[] {
  return [...new Set(leases.map((lease) => lease.taskId))].sort();
}

/**
 * Derive the stable RuntimeHandle from already-persisted exact worker
 * identity. The handle encodes the group id plus the OS start identity; pid and
 * pgid remain diagnostics and never authorize a decision by themselves.
 */
function workerLeaseRuntimeHandle(
  lease: WorkerLease,
): RuntimeHandle | undefined {
  const identity = exactWorkerIdentity(lease);
  if (!identity) return undefined;
  const normalized = identity.startedAt.trim().replace(/\s+/g, " ");
  if (!normalized) return undefined;
  const encoded = Buffer.from(normalized, "utf8").toString("base64url");
  return parseRuntimeHandle({
    backendType: "process-group",
    handle: `${identity.pgid}:${encoded}`,
    diagnostics: { pid: identity.pid, pgid: identity.pgid },
  });
}

function exactWorkerIdentity(
  lease: WorkerLease,
): RuntimeProcessIdentity | undefined {
  const { pid, pgid, osStartIdentity, captureMode } = lease.worker;
  if (
    captureMode !== "posix-group" ||
    pid === undefined ||
    pgid === undefined ||
    osStartIdentity === undefined ||
    pid !== pgid
  ) {
    return undefined;
  }
  return { pid, pgid, startedAt: osStartIdentity };
}

async function observeDurableLease(
  lease: WorkerLease,
  inspector: ProcessInspector,
): Promise<DurableLeaseObservation> {
  if (!sameHostname(lease.controller.host, inspector.host)) {
    return {
      state: "blocked",
      reason:
        `controller host ${lease.controller.host} is not this host ` +
        `(${inspector.host}); cross-host recovery is not supported`,
    };
  }

  if (inspector.isAlive(lease.controller.pid)) {
    let observed: RuntimeProcessIdentity | undefined;
    try {
      observed = await inspector.capture(lease.controller.pid);
    } catch {
      return {
        state: "blocked",
        reason: "controller liveness could not be inspected exactly",
      };
    }
    if (!observed) {
      return { state: "blocked", reason: "controller liveness is ambiguous" };
    }
    const comparison = compareProcessIdentity(
      lease.controller.identity,
      observed,
    );
    if (comparison === "match") return { state: "live-owner" };
    if (comparison === "unknown") {
      return { state: "blocked", reason: "controller identity is ambiguous" };
    }
    // mismatch: the recorded pid was reused; the controller is gone.
  }

  const handle = workerLeaseRuntimeHandle(lease);
  if (!handle) {
    return {
      state: "blocked",
      reason:
        "worker lease has no stable POSIX process-group RuntimeHandle",
    };
  }
  const identity = exactWorkerIdentity(lease);
  if (!identity) {
    return {
      state: "blocked",
      reason: "worker lease has no exact worker identity",
    };
  }

  let observedWorker: RuntimeProcessIdentity | undefined;
  try {
    observedWorker = await inspector.capture(identity.pid);
  } catch {
    return {
      state: "blocked",
      reason: "worker identity could not be inspected",
    };
  }
  if (!observedWorker) {
    const nested = await observeNestedTargets(lease, inspector);
    if (nested === "unknown") {
      return {
        state: "blocked",
        reason:
          "worker leader identity is absent and nested targets are ambiguous",
      };
    }
    if (nested === "live") return { state: "live", handle };
    const members = await inspectGroupMembers(identity.pgid, inspector);
    if (members === undefined) {
      return { state: "blocked", reason: "worker group could not be inspected" };
    }
    if (members.length === 0) return { state: "exited", handle };
    return {
      state: "blocked",
      reason: "worker leader identity is absent while group members remain",
    };
  }
  if (compareProcessIdentity(identity, observedWorker) !== "match") {
    return {
      state: "blocked",
      reason:
        "worker exact identity does not match the RuntimeHandle; " +
        "the handle was not signalled",
    };
  }

  const members = await inspectGroupMembers(identity.pgid, inspector);
  if (members === undefined) {
    return { state: "blocked", reason: "worker group could not be inspected" };
  }
  const nested = await observeNestedTargets(lease, inspector);
  if (nested === "unknown") {
    return {
      state: "blocked",
      reason: "nested execution targets are ambiguous",
    };
  }
  if (members.length === 0 && nested === "none") {
    return { state: "exited", handle };
  }
  return { state: "live", handle };
}

async function inspectGroupMembers(
  pgid: number,
  inspector: ProcessInspector,
): Promise<RuntimeProcessIdentity[] | undefined> {
  try {
    return await inspector.listGroupMembers(pgid);
  } catch {
    return undefined;
  }
}

async function observeNestedTargets(
  lease: WorkerLease,
  inspector: ProcessInspector,
): Promise<"none" | "live" | "unknown"> {
  const nested = lease.nestedProcesses;
  if (nested === undefined) return "none";
  // A truncated registry cannot prove that an external descendant is gone.
  if (nested.truncated) return "unknown";
  if (!sameHostname(nested.host, inspector.host)) return "unknown";
  for (const identity of nested.identities) {
    const state = await observeExactIdentity(identity, inspector);
    if (state === "unknown") return "unknown";
    if (state === "live") return "live";
  }
  for (const group of nested.groups ?? []) {
    const state = await observeExactIdentity(group.leader, inspector);
    if (state === "unknown") return "unknown";
    if (state === "live") {
      const members = await inspectGroupMembers(group.pgid, inspector);
      if (members === undefined) return "unknown";
      if (members.length > 0) return "live";
    }
  }
  return "none";
}

async function observeExactIdentity(
  identity: RuntimeProcessIdentity,
  inspector: ProcessInspector,
): Promise<"live" | "gone" | "unknown"> {
  let observed: RuntimeProcessIdentity | undefined;
  try {
    observed = await inspector.capture(identity.pid);
  } catch {
    return "unknown";
  }
  if (!observed) return "gone";
  const comparison = compareProcessIdentity(identity, observed);
  if (comparison === "match") return "live";
  if (comparison === "mismatch") return "gone";
  return "unknown";
}

function durableSignalTargets(leases: readonly WorkerLease[]): {
  pgids: Set<number>;
  pids: Set<number>;
} {
  const pgids = new Set<number>();
  const pids = new Set<number>();
  for (const lease of leases) {
    if (lease.worker.pgid !== undefined) pgids.add(lease.worker.pgid);
    if (lease.worker.pid !== undefined) pids.add(lease.worker.pid);
    const nested = lease.nestedProcesses;
    if (!nested) continue;
    for (const identity of nested.identities) {
      pids.add(identity.pid);
      pgids.add(identity.pgid);
    }
    for (const group of nested.groups ?? []) {
      pids.add(group.leader.pid);
      pgids.add(group.leader.pgid);
    }
  }
  return { pgids, pids };
}

async function waitForDurableUnitsToExit(
  live: Map<string, { lease: WorkerLease; handle: RuntimeHandle }>,
  inspector: ProcessInspector,
  timeoutMs: number,
  log: (line: string) => void,
): Promise<void> {
  if (live.size === 0) return;
  const deadline = Date.now() + timeoutMs;
  while (live.size > 0) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      const tasks = [...live.values()]
        .map((entry) => entry.lease.taskId)
        .sort()
        .join(", ");
      throw new ExecutionContinuityError(
        `durable task ${tasks} is still running after ${timeoutMs}ms; ` +
          "the RuntimeHandle was preserved and no task was dispatched",
      );
    }
    await sleep(Math.min(DURABLE_ATTACH_POLL_MS, remaining));
    for (const [leaseId, entry] of [...live]) {
      const observation = await observeDurableLease(entry.lease, inspector);
      if (observation.state === "blocked") {
        throw new ExecutionContinuityError(
          `durable task ${entry.lease.taskId}: ${observation.reason}; ` +
            "processes and lease preserved, no task dispatched",
        );
      }
      if (observation.state === "live-owner") {
        throw new ExecutionContinuityError(
          `durable task ${entry.lease.taskId}: the controller recorded in ` +
            "the lease became live during attachment; no task dispatched",
        );
      }
      if (observation.state === "exited") {
        live.delete(leaseId);
        log(
          `continuity: durable task ${entry.lease.taskId} exited before ` +
            `dispatch (RuntimeHandle ${runtimeHandleKey(entry.handle)})`,
        );
      }
    }
  }
}

function sameHostname(left: string, right: string): boolean {
  return left.trim().toLowerCase() === right.trim().toLowerCase();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

// ---------------------------------------------------------------------------
// start
// ---------------------------------------------------------------------------

async function startCommand(
  rest: string[],
  options: SupervisorCliOptions,
  log: (line: string) => void,
  diagnostics: (line: string) => void,
): Promise<number> {
  const repoRoot = repoFrom(rest);
  const contractsArg = positionalArg(rest);
  if (!contractsArg) {
    log("supervisor start: missing <contracts.json>");
    printUsage(log);
    return 1;
  }
  const deadlinePolicy = deadlinePolicyFromArgs(rest);
  const budget = budgetSettingsFromArgs(rest, workerFrom(rest));

  const contractsPath = resolve(repoRoot, contractsArg);
  const contracts = loadContractsInput(contractsPath);
  const baseCommit = resolveSharedBaseCommit(repoRoot, contracts);
  const runId = arg("--run-id", rest) ?? randomUUID();
  const planId =
    arg("--plan-id", rest) ?? basename(contractsPath, extname(contractsPath));
  const integrationBranch = `cliyard/integration/${runId}`;

  // Acquire before writing the manifest so a held lock never leaves a
  // half-started run behind.
  const lock = acquireSupervisorLock(repoRoot, runId);
  let manifest: RunManifest;
  let continuity: ExecutionContinuityReport | undefined;
  try {
    // Reconcile orphaned runtimes only once this supervisor owns the repo. Any
    // runtime needing human review fails the start before a run is created.
    await reconcileOrphansBeforeRun(repoRoot, "start");
    // A fresh run normally has no worker leases; a leftover lease directory
    // under this run id is still reconciled by the new contract's policy before
    // any manifest is created, so a failed re-attach leaves no running run.
    continuity = await reconcileExecutionContinuity({
      repoRoot,
      runId,
      contracts,
      log: diagnostics,
      ...(options.durableAttachTimeoutMs !== undefined
        ? { durableAttachTimeoutMs: options.durableAttachTimeoutMs }
        : {}),
    });
    manifest = createRunManifest(repoRoot, {
      runId,
      planId,
      contractsPath,
      baseCommit,
      integrationBranch,
      tasks: contracts.map((contract) => contract.taskId),
    });
  } catch (error) {
    lock.release();
    throw error;
  }

  return executeRun({
    repoRoot,
    manifest,
    lock,
    rest,
    options,
    log,
    resumed: false,
    ...(continuity === undefined ? {} : { continuity }),
    deadlinePolicy,
    ...(budget.maxBudgetUsd !== undefined
      ? { maxBudgetUsd: budget.maxBudgetUsd }
      : {}),
    ...(budget.budgetPolicy !== undefined
      ? { budgetPolicy: budget.budgetPolicy }
      : {}),
    // A new run never has a draft; always start a clean worktree.
    reuseAttempts: false,
  });
}

// ---------------------------------------------------------------------------
// resume
// ---------------------------------------------------------------------------

async function resumeCommand(
  rest: string[],
  options: SupervisorCliOptions,
  log: (line: string) => void,
  diagnostics: (line: string) => void,
): Promise<number> {
  const deadlinePolicy = deadlinePolicyFromArgs(rest);
  const budget = budgetSettingsFromArgs(rest, workerFrom(rest));
  const reuseAttempt = has("--reuse-attempt", rest);
  const freshAttempt = has("--fresh-attempt", rest);
  if (reuseAttempt && freshAttempt) {
    throw new Error(
      "supervisor resume: --reuse-attempt and --fresh-attempt are mutually exclusive",
    );
  }

  const repoRoot = repoFrom(rest);
  const manifest = loadRunManifest(repoRoot, arg("--run", rest));

  if (manifest.status === "completed") {
    // Completed work is never re-dispatched. The terminal evidence bundle is
    // the one thing a completed resume repairs: a missing or damaged bundle
    // is rebuilt from the RunManifest without rewriting it.
    const evidence = repairCompletedRunEvidence(repoRoot, manifest);
    log(`run ${manifest.runId} is already completed; nothing to resume`);
    log(`evidence: ${formatEvidenceStatus(evidence)}`);
    if (evidence.state !== "present") {
      log(
        `evidence bundle is ${evidence.state}; inspect ${evidence.path} ` +
          "or rerun `cliyard supervisor evidence --regenerate`",
      );
      return 1;
    }
    return 0;
  }

  // Resume preconditions run before the lock or any dispatch.
  assertContractsHash(manifest);
  const contracts = loadContractsInput(manifest.contractsPath);
  const baseCommit = resolveSharedBaseCommit(repoRoot, contracts);
  if (baseCommit !== manifest.baseCommit) {
    throw new Error(
      `supervisor resume: base commit changed for run ${manifest.runId}: ` +
        `manifest has ${manifest.baseCommit}, contracts resolve to ${baseCommit}`,
    );
  }
  assertIntegrationBranch(repoRoot, manifest);

  const rejected = Object.values(manifest.tasks).filter(
    (task) => !task.accepted && task.status === "rejected",
  );
  if (rejected.length > 0 && !has("--retry-rejected", rest)) {
    throw new Error(
      `supervisor resume: run ${manifest.runId} has rejected task(s) ` +
        `${rejected.map((task) => task.taskId).join(", ")}; ` +
        "rerun with --retry-rejected to retry them",
    );
  }

  const lock = acquireResumeLock(repoRoot, manifest, has("--force", rest));
  let resumed: RunManifest;
  let continuity: ExecutionContinuityReport | undefined;
  try {
    // Reconcile before marking the run running so unsafe orphan evidence can
    // never coexist with a newly dispatched batch.
    await reconcileOrphansBeforeRun(repoRoot, "resume");
    // Apply execution.continuity before resetting unfinished tasks. A durable
    // unit is preserved and observed until it exits (bounded); a fail-closed
    // unit is stopped on lease expiry through exact-identity recovery.
    continuity = await reconcileExecutionContinuity({
      repoRoot,
      runId: manifest.runId,
      contracts,
      log: diagnostics,
      ...(options.durableAttachTimeoutMs !== undefined
        ? { durableAttachTimeoutMs: options.durableAttachTimeoutMs }
        : {}),
    });
    setActiveRun(repoRoot, manifest.runId);
    resumed = updateRunManifest(repoRoot, manifest.runId, (current) => {
      current.status = "running";
      current.owner = { pid: process.pid, host: hostname() };
      for (const task of Object.values(current.tasks)) {
        if (!task.accepted && task.status !== "rejected") {
          // A previous owner may have died mid-task; rebuild it as ready.
          // Rejected attempts keep their status until the batch decides
          // whether to reuse or discard the recorded draft. Structured
          // observations belong to the abandoned attempt, not the new one:
          // retain its cost as prior-attempt provenance instead of dropping
          // it, then aggregate on completion.
          task.status = "ready";
          delete task.reason;
          delete task.failure;
          if (task.cost !== undefined) {
            task.priorAttemptCost = aggregateCostTruth([
              task.priorAttemptCost,
              task.cost,
            ]);
            delete task.cost;
          }
          delete task.workspaceBoundary;
        }
      }
    });
  } catch (error) {
    lock.release();
    throw error;
  }

  return executeRun({
    repoRoot,
    manifest: resumed,
    lock,
    rest,
    options,
    log,
    resumed: true,
    ...(continuity === undefined ? {} : { continuity }),
    deadlinePolicy,
    ...(budget.maxBudgetUsd !== undefined
      ? { maxBudgetUsd: budget.maxBudgetUsd }
      : {}),
    ...(budget.budgetPolicy !== undefined
      ? { budgetPolicy: budget.budgetPolicy }
      : {}),
    // Reuse is the default for rejected attempts. --fresh-attempt is the
    // explicit recovery path for a missing, invalid or unwanted draft.
    reuseAttempts: !freshAttempt,
  });
}

function acquireResumeLock(
  repoRoot: string,
  manifest: RunManifest,
  force: boolean,
): SupervisorLockHandle {
  const inspection = inspectSupervisorLock(repoRoot);
  if (inspection.state === "held") {
    throw new SupervisorLockHeldError(
      inspection.path,
      inspection.lock,
      inspection.reason ?? "another supervisor owns this repository",
    );
  }
  if (inspection.state === "stale") {
    // Recovery is explicit: the owner is provably gone.
    clearStaleSupervisorLock(repoRoot);
  }
  if (inspection.state === "invalid" && !force) {
    throw new Error(
      `supervisor resume: unreadable supervisor lock ${inspection.path}` +
        (inspection.reason ? ` (${inspection.reason})` : "") +
        "; rerun with --force to replace it",
    );
  }
  return acquireSupervisorLock(repoRoot, manifest.runId, {
    force: force && inspection.state === "invalid",
  });
}

function assertIntegrationBranch(
  repoRoot: string,
  manifest: RunManifest,
): void {
  const head = tryResolveCommit(
    repoRoot,
    `refs/heads/${manifest.integrationBranch}`,
  );
  if (!head) {
    throw new Error(
      `supervisor resume: integration branch ${manifest.integrationBranch} ` +
        `is missing for run ${manifest.runId}; ` +
        "cannot resume without the integration checkpoint",
    );
  }
}

// ---------------------------------------------------------------------------
// status
// ---------------------------------------------------------------------------

async function statusCommand(
  rest: string[],
  _options: SupervisorCliOptions,
  log: (line: string) => void,
): Promise<number> {
  const repoRoot = repoFrom(rest);
  const inspection = inspectRun(repoRoot, arg("--run", rest));
  const lock = inspectSupervisorLock(repoRoot);
  const status = await buildStatus(repoRoot, inspection, lock);

  if (has("--json", rest)) {
    log(JSON.stringify(status, null, 2));
  } else {
    printStatus(status, log);
  }
  return 0;
}

export async function buildStatus(
  repoRoot: string,
  inspection: RunInspection,
  lock: SupervisorLockInspection,
): Promise<SupervisorStatus> {
  const manifest = inspection.manifest;
  const tasks = Object.values(manifest.tasks);
  const counts = taskCounts(manifest);
  const lastAccepted = tasks.filter((task) => task.accepted).pop() ?? null;
  const branchHead = tryResolveCommit(
    repoRoot,
    `refs/heads/${manifest.integrationBranch}`,
  );
  // Status is read-only. Git/FS failures only hide reuse metadata; they must
  // never make the run unreadable or mutate state.
  const reusableAttempts = await listReusableAttempts(repoRoot, manifest).catch(
    () => [] as ReusableAttempt[],
  );
  // Worker progress is advisory: missing, malformed or stale files only hide
  // progress rows. They can never change status, counts or accepted work.
  const workerProgress = readWorkerProgress(repoRoot, manifest);
  // Lease evidence is advisory and read-only. A malformed or missing lease is
  // surfaced as degraded; it never makes a run look successful.
  const workerLeases = await buildWorkerLeaseStatus(
    repoRoot,
    manifest.runId,
    tasks.map((task) => ({
      taskId: task.taskId,
      expectsLease:
        task.attemptStartedAt !== undefined ||
        task.status === "running" ||
        task.status === "verifying" ||
        task.status === "repairing",
    })),
  );

  return {
    runId: manifest.runId,
    planId: manifest.planId,
    status: manifest.status,
    repoRoot: manifest.repoRoot,
    contractsPath: manifest.contractsPath,
    contractsHash: manifest.contractsHash,
    baseCommit: manifest.baseCommit,
    integrationBranch: manifest.integrationBranch,
    integrationHead: manifest.integrationHead,
    integrationBranchHead: branchHead ?? null,
    accepted: counts.accepted,
    pending: counts.pending,
    blocked: counts.blocked,
    total: counts.total,
    tasks: tasks.map((task) => ({ ...task })),
    owner: manifest.owner,
    ownerAlive: inspection.ownerAlive,
    interrupted: inspection.interrupted,
    effectiveStatus: inspection.interrupted ? "interrupted" : manifest.status,
    activeRunId: getActiveRunId(repoRoot) ?? null,
    lock: {
      state: lock.state,
      path: lock.path,
      owner: lock.lock ?? null,
      reason: lock.reason ?? null,
    },
    lastCheckpoint: manifest.updatedAt,
    lastAccepted: lastAccepted ? { ...lastAccepted } : null,
    reusableAttempts,
    workerProgress,
    // Read-only: expose evidence written by previous reaper runs; status never
    // plans, signals, releases a lease, or rewrites a manifest.
    runtimeRecovery: readRuntimeRecoveryRecords(repoRoot),
    workerLeases,
    workspaceBoundary: buildWorkspaceBoundaryStatus(tasks),
    // Strictly read-only: this projection reports the on-disk bundle state.
    // Status never repairs, rewrites or creates evidence.
    evidence: inspectEvidenceStatus(repoRoot, manifest),
  };
}

const BOUNDARY_STATUS_PATHS_PREVIEW = 8;

/**
 * Project the durable per-task records into a concise status view. The
 * RunManifest record stays the authority; this projection truncates path
 * lists for display only.
 */
function buildWorkspaceBoundaryStatus(
  tasks: RunTaskState[],
): SupervisorWorkspaceBoundaryStatus {
  const evidence: SupervisorBoundaryTaskEvidence[] = [];
  let clean = 0;
  let violations = 0;
  let inspectionErrors = 0;
  for (const task of tasks) {
    const record = task.workspaceBoundary;
    if (!record) continue;
    if (record.status === "clean") clean += 1;
    else if (record.status === "violation") violations += 1;
    else inspectionErrors += 1;

    const changedPaths = record.changes.map((change) =>
      change.rootIndex === 0
        ? change.path
        : `root${change.rootIndex}:${change.path}`,
    );
    evidence.push({
      taskId: task.taskId,
      status: record.status,
      capturedAt: record.capturedAt,
      comparedAt: record.comparedAt,
      changeCount: changedPaths.length,
      changedPaths: changedPaths.slice(0, BOUNDARY_STATUS_PATHS_PREVIEW),
      ...(record.error !== undefined ? { error: record.error } : {}),
    });
  }
  evidence.sort((left, right) => left.taskId.localeCompare(right.taskId));
  return {
    tasks: evidence.length,
    clean,
    violations,
    inspectionErrors,
    evidence,
  };
}

function printStatus(
  status: SupervisorStatus,
  log: (line: string) => void,
): void {
  log(`runId: ${status.runId}`);
  log(`planId: ${status.planId}`);
  log(
    `status: ${status.effectiveStatus}` +
      (status.interrupted ? " (stale owner; resumable)" : ""),
  );
  const blockedNote =
    status.blocked > 0 ? ` (blocked ${status.blocked})` : "";
  log(
    `tasks: accepted ${status.accepted} / pending ${status.pending} / ` +
      `total ${status.total}${blockedNote}`,
  );
  let branchNote = " (branch missing)";
  if (status.integrationBranchHead) {
    branchNote =
      status.integrationBranchHead === status.integrationHead
        ? ""
        : ` (branch head ${status.integrationBranchHead})`;
  }
  log(
    `integration: ${status.integrationBranch} @ ` +
      `${status.integrationHead}${branchNote}`,
  );
  log(`lock: ${formatLock(status.lock)}`);
  const alive =
    status.ownerAlive === null
      ? " (remote host)"
      : status.ownerAlive
        ? " (alive)"
        : " (not running)";
  log(`owner: pid ${status.owner.pid} on ${status.owner.host}${alive}`);
  log(`last checkpoint: ${status.lastCheckpoint}`);
  log(`evidence: ${formatEvidenceStatus(status.evidence)}`);
  if (status.runtimeRecovery.length === 0) {
    log("runtime recovery: none");
  } else {
    for (const entry of status.runtimeRecovery) {
      log(
        `runtime recovery: ${entry.runtimeId} ${entry.recovery.state} ` +
          `at ${entry.recovery.at} - ${entry.recovery.reason}`,
      );
    }
  }
  if (status.lastAccepted) {
    const commit = status.lastAccepted.resultCommit
      ? ` @ ${status.lastAccepted.resultCommit}`
      : "";
    log(`last accepted: ${status.lastAccepted.taskId}${commit}`);
  }
  // One line per task that carries durable failure/cost truth. Amounts are
  // printed only when observed; unavailable cost is never shown as $0.
  for (const task of status.tasks) {
    const extensions = task.extensions ?? [];
    const processTrees = task.processTrees ?? [];
    if (
      !task.failure &&
      !task.cleanupFailure &&
      !task.cost &&
      extensions.length === 0 &&
      processTrees.length === 0
    ) {
      continue;
    }
    const parts = [`task ${task.taskId}: ${task.status}`];
    if (task.failure) {
      parts.push(`failure=${formatFailureObservation(task.failure)}`);
    }
    if (task.cleanupFailure) {
      parts.push(
        `cleanup-failure=${formatFailureObservation(task.cleanupFailure)}`,
      );
    }
    if (task.cost) {
      parts.push(`cost=${formatCostObservation(task.cost)}`);
    }
    const lastTree = processTrees.at(-1);
    if (lastTree) {
      parts.push(
        `process-tree=${lastTree.cleanupState}`,
        `reason=${lastTree.cleanupReason}`,
        `residual=${lastTree.residualCount}`,
      );
    }
    if (extensions.length > 0) {
      parts.push(`extensions=${extensions.length}`);
      const deadlines = extensions.filter(
        (extension) => extension.kind === "deadline",
      );
      const budgets = extensions.filter(
        (extension) => extension.kind === "budget-continuation",
      );
      const lastDeadline = deadlines.at(-1);
      if (lastDeadline) {
        parts.push(
          `last deadline extension=${lastDeadline.grantedAt} ` +
            `+${lastDeadline.extensionMs}ms ` +
            `cumulative=${lastDeadline.cumulativeTimeoutMs}ms`,
        );
      }
      const lastBudget = budgets.at(-1);
      if (lastBudget) {
        parts.push(
          `budget-extensions=${budgets.length}`,
          `last budget continuation=${lastBudget.grantedAt} ` +
            `+${lastBudget.additionalGuardUsd} ` +
            `cumulative-guard-usd=${lastBudget.cumulativeGuardUsd}`,
        );
      }
    }
    log(parts.join(" "));
  }
  if (status.workspaceBoundary.tasks > 0) {
    const boundary = status.workspaceBoundary;
    log(
      `workspace boundary: clean ${boundary.clean} / violation ` +
        `${boundary.violations} / inspection-error ` +
        `${boundary.inspectionErrors} (detection only)`,
    );
    for (const entry of boundary.evidence) {
      const parts = [
        `task ${entry.taskId}: boundary=${entry.status}`,
        `compared=${entry.comparedAt}`,
        `changes=${entry.changeCount}`,
      ];
      if (entry.changedPaths.length > 0) {
        const truncated =
          entry.changeCount > entry.changedPaths.length ? " …" : "";
        parts.push(`paths=[${entry.changedPaths.join(", ")}${truncated}]`);
      }
      if (entry.error) parts.push(`error=${entry.error}`);
      log(`  ${parts.join(" ")}`);
    }
  }
  if (status.workerProgress.length === 0) {
    log("worker progress: none");
  } else {
    for (const entry of status.workerProgress) {
      const detail = entry.event.detail ? ` - ${entry.event.detail}` : "";
      const stale = entry.stale
        ? ` (stale ${Math.round(entry.ageMs / 1000)}s)`
        : "";
      log(
        `worker progress: ${entry.taskId} ${entry.event.at} ` +
          `${entry.event.type}/${entry.event.phase} ` +
          `${entry.event.message}${detail}${stale}`,
      );
    }
  }
  const leaseCounts = status.workerLeases.counts;
  log(
    `worker leases: active ${leaseCounts.active} / released ` +
      `${leaseCounts.released} / cleanup-failed ${leaseCounts.cleanupFailed} / ` +
      `unknown ${leaseCounts.unknown} / malformed ${leaseCounts.malformed}`,
  );
  for (const task of status.workerLeases.tasks) {
    if (!task.latest) {
      if (task.missing) {
        log(`worker lease: ${task.taskId} missing (degraded evidence)`);
      }
      continue;
    }
    const latest = task.latest;
    log(
      `worker lease: ${task.taskId} attempt=${latest.attempt} ` +
        `${latest.state} controller=${latest.controller.state} ` +
        `capture=${latest.worker.captureMode}` +
        (latest.cleanupReason ? ` reason=${latest.cleanupReason}` : "") +
        (latest.latestObservation ? ` - ${latest.latestObservation}` : ""),
    );
  }
  if (status.workerLeases.degraded) {
    log(
      "worker lease evidence degraded: " +
        status.workerLeases.degradedReasons.join("; "),
    );
  }
  if (status.reusableAttempts.length === 0) {
    log("reusable attempts: none");
  } else {
    for (const attempt of status.reusableAttempts) {
      log(
        `reusable attempt: ${attempt.taskId} ${attempt.worktree} ` +
          `(${attempt.branch} @ ${attempt.baseCommit}; ` +
          `rejected ${attempt.rejectedAt})`,
      );
    }
  }
  log(
    `contracts: ${status.contractsPath} (sha256 ${status.contractsHash})`,
  );
  log(`repo: ${status.repoRoot}`);
}

/** `category/stage` plus the bounded code, when one was observed. */
export function formatFailureObservation(failure: FailureRecord): string {
  return (
    `${failure.category}/${failure.stage}` +
    (failure.code ? ` (${failure.code})` : "")
  );
}

/**
 * Cost state plus an observed amount only. A missing amount stays missing and
 * a CLI estimate is always labelled non-authoritative.
 */
export function formatCostObservation(cost: CostTruth): string {
  const amount =
    cost.amount !== null
      ? ` ${cost.amount} ${cost.currency ?? "<currency unknown>"}` +
        " (observed, non-authoritative)"
      : "";
  const missing =
    cost.missing.length > 0 ? ` missing=${cost.missing.join(",")}` : "";
  return `${cost.state}${amount}${missing}`;
}

/**
 * Read the latest valid JSONL event for each tracked task. Status is strictly
 * read-only: missing directories, unreadable files, malformed lines and
 * foreign task ids are skipped without touching the manifest.
 */
function readWorkerProgress(
  repoRoot: string,
  manifest: RunManifest,
): WorkerProgressStatus[] {
  const dir = workerEventsDir(repoRoot, manifest.runId);
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }

  const now = Date.now();
  const progress: WorkerProgressStatus[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
    const taskId = entry.name.slice(0, -".jsonl".length);
    if (!Object.hasOwn(manifest.tasks, taskId)) continue;
    const event = readLatestWorkerEvent(join(dir, entry.name), taskId);
    if (!event) continue;
    const ageMs = Math.max(0, now - Date.parse(event.at));
    progress.push({
      taskId,
      event,
      ageMs,
      stale: ageMs > WORKER_PROGRESS_STALE_MS,
    });
  }
  return progress.sort(
    (left, right) =>
      Date.parse(left.event.at) - Date.parse(right.event.at) ||
      left.taskId.localeCompare(right.taskId),
  );
}

function readLatestWorkerEvent(
  path: string,
  taskId: string,
): WorkerProgressEvent | undefined {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
  let latest: WorkerProgressEvent | undefined;
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line) as unknown;
    } catch {
      continue;
    }
    if (!isWorkerProgressEvent(parsed) || parsed.taskId !== taskId) continue;
    latest = parsed;
  }
  return latest;
}

function formatLock(
  lock: SupervisorStatus["lock"],
): string {
  if (lock.state === "free") return "free";
  if (lock.state === "invalid") {
    return `invalid${lock.reason ? ` (${lock.reason})` : ""}`;
  }
  const owner = lock.owner;
  if (!owner) return lock.state;
  if (lock.state === "stale") {
    return `stale (pid ${owner.pid} on ${owner.host} is not running)`;
  }
  if (!isSameHost(owner.host)) {
    return `held by run ${owner.runId} pid ${owner.pid} on ${owner.host} (remote host)`;
  }
  const alive = isProcessAlive(owner.pid) ? "" : " (not running)";
  return `held by run ${owner.runId} pid ${owner.pid} on ${owner.host}${alive}`;
}

// ---------------------------------------------------------------------------
// Evidence bundle
// ---------------------------------------------------------------------------

/**
 * Terminal for evidence purposes, matching the EvidenceBundle core. A running
 * manifest can never produce a final bundle. `interrupted` is terminal too,
 * but automatic generation only happens after a settled batch return.
 */
const EVIDENCE_TERMINAL_STATUSES: ReadonlySet<RunStatus> = new Set<RunStatus>([
  "completed",
  "blocked",
  "interrupted",
]);
const EVIDENCE_NEXT_ACTIONS: ReadonlySet<string> = new Set<EvidenceNextAction>([
  "human-review",
  "inspect-failure",
  "resume",
  "needs-human",
]);
const EVIDENCE_COST_STATES: ReadonlySet<string> = new Set(COST_STATES);
/** Display bounds; the bundle file remains the authority. */
const EVIDENCE_MISSING_PREVIEW = 16;
const EVIDENCE_MISSING_ENTRY_LIMIT = 200;
const EVIDENCE_REASON_LIMIT = 300;

function evidenceStatusBase(
  runId: string,
  path: string,
): SupervisorEvidenceStatus {
  return {
    state: "missing",
    runId,
    path,
    degraded: false,
    reason: null,
    generatedAt: null,
    nextAction: null,
    humanReviewRequired: null,
    manifestHash: null,
    taskCount: null,
    missingCount: 0,
    missing: [],
    cost: null,
  };
}

/**
 * Read-only projection of the on-disk bundle. It never writes, repairs or
 * changes the RunManifest. A terminal run whose bundle is absent, unreadable,
 * structurally invalid or bound to a different manifest is `missing`/`invalid`
 * and degraded.
 */
function inspectEvidenceStatus(
  repoRoot: string,
  manifest: RunManifest,
): SupervisorEvidenceStatus {
  const path = evidenceBundlePath(repoRoot, manifest.runId);
  const base = evidenceStatusBase(manifest.runId, path);
  if (!EVIDENCE_TERMINAL_STATUSES.has(manifest.status)) {
    return {
      ...base,
      state: "not-terminal",
      reason: "run is running; final evidence is written after settlement",
    };
  }

  let stats;
  try {
    stats = statSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return {
        ...base,
        state: "missing",
        degraded: true,
        reason: "evidence bundle is missing",
      };
    }
    return {
      ...base,
      state: "invalid",
      degraded: true,
      reason: boundEvidenceText(
        `cannot inspect evidence bundle: ${errorMessage(error)}`,
        EVIDENCE_REASON_LIMIT,
      ),
    };
  }
  if (!stats.isFile()) {
    return {
      ...base,
      state: "invalid",
      degraded: true,
      reason: "evidence path is not a regular file",
    };
  }
  if (stats.size > MAX_EVIDENCE_BUNDLE_BYTES) {
    return {
      ...base,
      state: "invalid",
      degraded: true,
      reason: "evidence bundle exceeds the size bound",
    };
  }

  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    return {
      ...base,
      state: "invalid",
      degraded: true,
      reason: boundEvidenceText(
        `cannot read evidence bundle: ${errorMessage(error)}`,
        EVIDENCE_REASON_LIMIT,
      ),
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return {
      ...base,
      state: "invalid",
      degraded: true,
      reason: "evidence bundle is not valid JSON",
    };
  }

  try {
    return { ...base, state: "present", ...projectEvidenceBundle(parsed, manifest) };
  } catch (error) {
    return {
      ...base,
      state: "invalid",
      degraded: true,
      reason: boundEvidenceText(errorMessage(error), EVIDENCE_REASON_LIMIT),
    };
  }
}

interface ProjectedEvidenceFacts {
  generatedAt: string;
  nextAction: EvidenceNextAction;
  humanReviewRequired: boolean;
  manifestHash: string;
  taskCount: number;
  missingCount: number;
  missing: string[];
  cost: SupervisorEvidenceCostStatus;
}

/**
 * Validate the bundle's bounded review facts and bind them to the current
 * RunManifest. Only declared fields are read into the projection.
 */
function projectEvidenceBundle(
  parsed: unknown,
  manifest: RunManifest,
): ProjectedEvidenceFacts {
  if (!isRecord(parsed)) {
    throw new Error("evidence bundle must be a JSON object");
  }
  if (parsed.version !== EVIDENCE_BUNDLE_VERSION) {
    throw new Error("evidence bundle version is not supported");
  }

  const run = parsed.run;
  if (!isRecord(run)) {
    throw new Error("evidence bundle run record is missing");
  }
  if (
    run.runId !== manifest.runId ||
    run.planId !== manifest.planId
  ) {
    throw new Error("evidence bundle run identity does not match the RunManifest");
  }
  if (run.terminal !== true || run.status !== manifest.status) {
    throw new Error("evidence bundle does not describe this terminal run");
  }

  const authority = parsed.authority;
  if (!isRecord(authority)) {
    throw new Error("evidence bundle authority record is missing");
  }
  if (
    authority.taskAuthority !== "run-manifest" ||
    authority.grantsAcceptance !== false ||
    authority.authorizesMerge !== false ||
    authority.replacesVerification !== false
  ) {
    throw new Error(
      "evidence bundle authority does not defer to the RunManifest",
    );
  }
  const manifestIdentity = authority.manifest;
  const expectedHash = runManifestHash(manifest);
  if (
    !isRecord(manifestIdentity) ||
    manifestIdentity.hash !== expectedHash
  ) {
    throw new Error(
      "evidence bundle is not bound to the current RunManifest",
    );
  }

  const tasks = parsed.tasks;
  if (!Array.isArray(tasks)) {
    throw new Error("evidence bundle task list is missing");
  }
  const expectedTasks = Object.values(manifest.tasks);
  if (tasks.length !== expectedTasks.length) {
    throw new Error(
      "evidence bundle task count does not match the RunManifest",
    );
  }
  const byId = new Map(expectedTasks.map((task) => [task.taskId, task]));
  const seen = new Set<string>();
  for (const task of tasks) {
    if (!isRecord(task) || typeof task.taskId !== "string") {
      throw new Error("evidence bundle contains an invalid task record");
    }
    const source = byId.get(task.taskId);
    if (!source || seen.has(task.taskId)) {
      throw new Error(
        "evidence bundle task identity does not match the RunManifest",
      );
    }
    if (task.status !== source.status || task.accepted !== source.accepted) {
      throw new Error(
        "evidence bundle task state does not match the RunManifest",
      );
    }
    seen.add(task.taskId);
  }

  const generatedAt = parsed.generatedAt;
  if (
    typeof generatedAt !== "string" ||
    generatedAt.length === 0 ||
    Number.isNaN(Date.parse(generatedAt))
  ) {
    throw new Error("evidence bundle generation time is invalid");
  }
  if (
    typeof parsed.nextAction !== "string" ||
    !EVIDENCE_NEXT_ACTIONS.has(parsed.nextAction)
  ) {
    throw new Error("evidence bundle next action is invalid");
  }
  if (parsed.humanReviewRequired !== true) {
    throw new Error("evidence bundle does not require human review");
  }
  if (
    !Array.isArray(parsed.missing) ||
    !parsed.missing.every((entry) => typeof entry === "string")
  ) {
    throw new Error("evidence bundle missing-observation list is invalid");
  }
  const rawMissing = parsed.missing as string[];
  const missing = rawMissing
    .slice(0, EVIDENCE_MISSING_PREVIEW)
    .map((entry) => boundEvidenceText(entry, EVIDENCE_MISSING_ENTRY_LIMIT));

  return {
    generatedAt,
    nextAction: parsed.nextAction as EvidenceNextAction,
    humanReviewRequired: true,
    manifestHash: expectedHash,
    taskCount: tasks.length,
    missingCount: rawMissing.length,
    missing,
    cost: projectEvidenceCost(parsed.cost),
  };
}

function projectEvidenceCost(value: unknown): SupervisorEvidenceCostStatus {
  if (!isRecord(value)) {
    throw new Error("evidence bundle cost record is missing");
  }
  if (
    typeof value.state !== "string" ||
    !EVIDENCE_COST_STATES.has(value.state)
  ) {
    throw new Error("evidence bundle cost state is invalid");
  }
  const amount = value.amount;
  if (
    amount !== null &&
    (typeof amount !== "number" || !Number.isFinite(amount))
  ) {
    throw new Error("evidence bundle cost amount is invalid");
  }
  const currency = value.currency;
  if (currency !== null && typeof currency !== "string") {
    throw new Error("evidence bundle cost currency is invalid");
  }
  if (typeof value.authoritative !== "boolean") {
    throw new Error("evidence bundle cost authority flag is invalid");
  }
  return {
    state: value.state as CostTruth["state"],
    amount,
    currency,
    authoritative: value.authoritative,
  };
}

/** Independently observed repository facts; absent facts stay unknown. */
function evidenceRepositoryFacts(
  repoRoot: string,
  manifest: RunManifest,
): EvidenceRepositoryFacts {
  const facts: EvidenceRepositoryFacts = {};
  try {
    facts.contractsHash = computeContractsHash(manifest.contractsPath);
  } catch {
    /* unobserved contracts hash stays unknown */
  }
  const head = tryResolveCommit(
    repoRoot,
    `refs/heads/${manifest.integrationBranch}`,
  );
  if (head) facts.integrationHead = head;
  return facts;
}

/**
 * Write (idempotently) the final bundle for a terminal manifest. A write
 * failure is swallowed here: the returned projection reports the durable
 * missing/invalid state instead of turning a finished run into a crash.
 */
function generateRunEvidence(
  repoRoot: string,
  manifest: RunManifest,
): SupervisorEvidenceStatus {
  if (EVIDENCE_TERMINAL_STATUSES.has(manifest.status)) {
    try {
      writeEvidenceBundle(repoRoot, manifest, {
        facts: evidenceRepositoryFacts(repoRoot, manifest),
      });
    } catch {
      /* never changes run status, acceptance or the manifest */
    }
  }
  return inspectEvidenceStatus(repoRoot, manifest);
}

/** Completed-run resume: rebuild a missing or damaged bundle, never the run. */
function repairCompletedRunEvidence(
  repoRoot: string,
  manifest: RunManifest,
): SupervisorEvidenceStatus {
  const current = inspectEvidenceStatus(repoRoot, manifest);
  if (current.state === "present") return current;
  return generateRunEvidence(repoRoot, manifest);
}

async function evidenceCommand(
  rest: string[],
  _options: SupervisorCliOptions,
  log: (line: string) => void,
): Promise<number> {
  const repoRoot = repoFrom(rest);
  const manifest = loadRunManifest(repoRoot, arg("--run", rest));
  const regenerate = has("--regenerate", rest);
  const result: SupervisorEvidenceCommandResult = {
    regenerated: regenerate,
    written: false,
    error: null,
    evidence: inspectEvidenceStatus(repoRoot, manifest),
  };

  if (regenerate) {
    if (!EVIDENCE_TERMINAL_STATUSES.has(manifest.status)) {
      // A running manifest cannot produce final evidence; this is a rejection,
      // not a read-only degraded report.
      result.error = "a running RunManifest cannot produce final evidence";
    } else {
      try {
        const write = writeEvidenceBundle(repoRoot, manifest, {
          facts: evidenceRepositoryFacts(repoRoot, manifest),
        });
        result.written = write.written;
        result.evidence = inspectEvidenceStatus(repoRoot, manifest);
      } catch (error) {
        result.error = boundEvidenceText(
          `cannot regenerate evidence: ${errorMessage(error)}`,
          EVIDENCE_REASON_LIMIT,
        );
        result.evidence = inspectEvidenceStatus(repoRoot, manifest);
      }
    }
  }

  if (has("--json", rest)) {
    log(JSON.stringify(result, null, 2));
  } else {
    if (result.error) log(`supervisor evidence: ${result.error}`);
    printEvidenceStatus(result.evidence, log);
    if (regenerate) {
      log(
        result.written
          ? "evidence bundle written"
          : "evidence bundle already current",
      );
    }
  }

  return result.error === null && result.evidence.state === "present" ? 0 : 1;
}

function printEvidenceStatus(
  status: SupervisorEvidenceStatus,
  log: (line: string) => void,
): void {
  log(`runId: ${status.runId}`);
  log(`evidence: ${status.state}`);
  log(`path: ${status.path}`);
  log(`degraded: ${status.degraded ? "yes" : "no"}`);
  if (status.reason) log(`reason: ${status.reason}`);
  if (status.state !== "present") return;
  log(`generated: ${status.generatedAt}`);
  log(`next action: ${status.nextAction}`);
  log(
    `human review required: ${status.humanReviewRequired ? "yes" : "no"}`,
  );
  log(`tasks: ${status.taskCount}`);
  if (status.cost) {
    const amount =
      status.cost.amount !== null
        ? ` ${status.cost.amount} ` +
          `${status.cost.currency ?? "<currency unknown>"}`
        : "";
    log(
      `cost: ${status.cost.state}${amount} ` +
        `(authoritative: ${status.cost.authoritative ? "yes" : "no"})`,
    );
  }
  if (status.missingCount === 0) {
    log("missing: none");
    return;
  }
  const truncated =
    status.missingCount > status.missing.length
      ? ` … (${status.missingCount} total)`
      : "";
  log(`missing: ${status.missing.join(", ")}${truncated}`);
}

function formatEvidenceStatus(status: SupervisorEvidenceStatus): string {
  switch (status.state) {
    case "present": {
      const next = status.nextAction
        ? `; next action ${status.nextAction}`
        : "";
      const missing =
        status.missingCount > 0 ? `; missing ${status.missingCount}` : "";
      return `present${next}${missing}`;
    }
    case "not-terminal":
      return "not-terminal (final evidence is written after settlement)";
    case "missing":
      return `missing (degraded): ${status.reason ?? "not written"}`;
    case "invalid":
      return `invalid (degraded): ${status.reason ?? "validation failed"}`;
  }
}

function boundEvidenceText(value: string, max: number): string {
  const cleaned = value.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ");
  if (cleaned.length <= max) return cleaned;
  return `${cleaned.slice(0, Math.max(0, max - 1))}…`;
}

// ---------------------------------------------------------------------------
// stop
// ---------------------------------------------------------------------------

async function stopCommand(
  rest: string[],
  _options: SupervisorCliOptions,
  log: (line: string) => void,
): Promise<number> {
  const repoRoot = repoFrom(rest);
  const manifest = loadRunManifest(repoRoot, arg("--run", rest));
  const force = has("--force", rest);
  const initial = inspectSupervisorLock(repoRoot);

  if (initial.lock && initial.lock.runId !== manifest.runId) {
    throw new Error(
      `supervisor stop: supervisor lock is held by run ${initial.lock.runId} ` +
        `(pid ${initial.lock.pid}), not ${manifest.runId}`,
    );
  }

  if (initial.state === "held" && initial.lock) {
    const owner = initial.lock;
    if (owner.pid === process.pid) {
      if (!force) {
        throw new Error(
          `supervisor stop: lock ${initial.path} is owned by this process; ` +
            "refusing to signal itself (use --force to drop the lock)",
        );
      }
    } else if (!isSameHost(owner.host)) {
      if (!force) {
        throw new Error(
          `supervisor stop: owner pid ${owner.pid} is on ${owner.host}; ` +
            "liveness cannot be checked (use --force after confirming it exited)",
        );
      }
    } else if (isProcessAlive(owner.pid)) {
      try {
        process.kill(owner.pid, "SIGTERM");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      }
      const stopped = await waitFor(
        () => !isProcessAlive(owner.pid),
        STOP_TIMEOUT_MS,
      );
      if (!stopped) {
        throw new Error(
          `supervisor stop: owner pid ${owner.pid} did not exit within ` +
            `${STOP_TIMEOUT_MS}ms`,
        );
      }
    }
  }

  let lock = inspectSupervisorLock(repoRoot);
  if (lock.state === "stale") {
    clearStaleSupervisorLock(repoRoot);
    lock = inspectSupervisorLock(repoRoot);
  }
  if (lock.state !== "free") {
    if (!force) {
      throw new Error(
        `supervisor stop: supervisor lock is still held at ${lock.path}` +
          (lock.reason ? ` (${lock.reason})` : ""),
      );
    }
    removeLockIfOwned(lock);
    lock = inspectSupervisorLock(repoRoot);
  }

  const updated = updateRunManifest(repoRoot, manifest.runId, (current) => {
    if (current.status === "running") current.status = "interrupted";
  });
  log(`stopped run ${updated.runId}: status ${updated.status}`);
  log(
    `lock: ${formatLock({
      state: lock.state,
      path: lock.path,
      owner: lock.lock ?? null,
      reason: lock.reason ?? null,
    })}`,
  );
  return 0;
}

function removeLockIfOwned(lock: SupervisorLockInspection): void {
  try {
    if (lock.lock) {
      const current = JSON.parse(
        readFileSync(lock.path, "utf8"),
      ) as SupervisorLockInfo;
      if (
        current.runId !== lock.lock.runId ||
        current.pid !== lock.lock.pid ||
        current.acquiredAt !== lock.lock.acquiredAt
      ) {
        throw new Error(
          `supervisor stop: lock ${lock.path} changed while stopping; ` +
            "refusing to remove it",
        );
      }
    }
    unlinkSync(lock.path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
  }
  return predicate();
}

// ---------------------------------------------------------------------------
// Orphan runtime reconciliation
// ---------------------------------------------------------------------------

interface AnnotatedRecoveryRecord {
  group: "reaped" | "needsHuman" | "skipped";
  record: RuntimeRecoveryRecord;
}

interface BlockedRuntime {
  runtimeId?: string;
  reason: string;
}

interface ReconciliationOutcome {
  report: RuntimeReapReport;
  records: AnnotatedRecoveryRecord[];
  blocked: BlockedRuntime[];
}

async function reapCommand(
  rest: string[],
  _options: SupervisorCliOptions,
  log: (line: string) => void,
): Promise<number> {
  const repoRoot = repoFrom(rest);
  const outcome = await reconcileRuntimeOrphans(repoRoot);

  if (has("--json", rest)) {
    log(JSON.stringify(outcome.report, null, 2));
  } else {
    printReconciliation(outcome, log);
  }
  return 0;
}

// ---------------------------------------------------------------------------
// recover-workers
// ---------------------------------------------------------------------------

async function recoverWorkersCommand(
  rest: string[],
  _options: SupervisorCliOptions,
  log: (line: string) => void,
): Promise<number> {
  const repoRoot = repoFrom(rest);
  const runId = arg("--run", rest);
  const report = await recoverWorkerLeases({
    repoRoot,
    ...(runId !== undefined ? { runId } : {}),
  });
  if (has("--json", rest)) {
    log(JSON.stringify(report, null, 2));
  } else {
    printWorkerLeaseRecovery(report, log);
  }
  return 0;
}

function printWorkerLeaseRecovery(
  report: WorkerLeaseRecoveryReport,
  log: (line: string) => void,
): void {
  log(`host: ${report.host}`);
  log(`scanned: ${report.scanned}`);
  log(`recovered: ${report.recovered}`);
  log(`needs human: ${report.needsHuman}`);
  log(`skipped: ${report.skipped}`);
  if (report.truncated) log("scan truncated: yes");
  for (const entry of report.entries) {
    const identity = entry.runId && entry.taskId
      ? `${entry.runId}/${entry.taskId}`
      : entry.path;
    log(
      `${entry.outcome} ${entry.action} ${identity}` +
        (entry.leaseId ? ` lease=${entry.leaseId}` : "") +
        ` controller=${entry.controllerState}` +
        ` worker=${entry.workerState}` +
        (entry.resumeNeeded ? " resume-needed" : "") +
        ` - ${entry.reason}`,
    );
  }
  if (report.resumeNeeded.length > 0) {
    log(
      `resume needed: ${report.resumeNeeded.length} task invocation(s); ` +
        "RunManifest acceptance was not changed",
    );
  }
}

/**
 * Run the destructive reaper and group its records for reporting.
 *
 * Every executor record names its runtime directly, so neither ids nor labels
 * are reconstructed here: a second preflight would have to match state and
 * reason text, which is ambiguous when two runtimes produce the same reason.
 * Records written before runtime identity was carried are only read by
 * `status`, where `readRuntimeRecoveryRecords` falls back to the manifest id.
 */
async function reconcileRuntimeOrphans(
  repoRoot: string,
): Promise<ReconciliationOutcome> {
  const report = await reapOrphanedRuntimes(repoRoot);

  const records: AnnotatedRecoveryRecord[] = [
    ...report.reaped.map((record) => ({ group: "reaped" as const, record })),
    ...report.needsHuman.map((record) => ({
      group: "needsHuman" as const,
      record,
    })),
    ...report.skipped.map((record) => ({ group: "skipped" as const, record })),
  ];

  const blocked: BlockedRuntime[] = [];
  const blockedKeys = new Set<string>();
  const addBlocked = (runtimeId: string | undefined, reason: string): void => {
    const key = JSON.stringify([runtimeId ?? null, reason]);
    if (blockedKeys.has(key)) return;
    blockedKeys.add(key);
    blocked.push({ ...(runtimeId !== undefined ? { runtimeId } : {}), reason });
  };
  for (const entry of records) {
    if (entry.group === "needsHuman") {
      addBlocked(entry.record.runtimeId, entry.record.reason);
    }
  }

  return { report, records, blocked };
}

async function reconcileOrphansBeforeRun(
  repoRoot: string,
  command: "start" | "resume",
): Promise<void> {
  const outcome = await reconcileRuntimeOrphans(repoRoot);
  if (outcome.blocked.length === 0) return;

  const detail = outcome.blocked
    .map(
      (entry) =>
        `${entry.runtimeId ?? "<unidentified runtime>"}: ${entry.reason}`,
    )
    .join("; ");
  throw new Error(
    `supervisor ${command}: orphan runtime reconciliation needs human review ` +
      `for ${outcome.blocked.length} candidate(s): ${detail}; ` +
      "resolve the preserved runtime evidence, then rerun " +
      `(inspect with "cliyard supervisor reap --repo ${repoRoot} --json")`,
  );
}

function printReconciliation(
  outcome: ReconciliationOutcome,
  log: (line: string) => void,
): void {
  const { report } = outcome;
  log(`scanned: ${report.scanned}`);
  log(`reaped: ${report.reaped.length}`);
  log(`needs human: ${report.needsHuman.length}`);
  log(`skipped: ${report.skipped.length}`);
  for (const entry of outcome.records) {
    const label = entry.group === "needsHuman" ? "needs human" : entry.group;
    const runtimeId = entry.record.runtimeId;
    log(
      `${label}${runtimeId ? ` ${runtimeId}` : ""}: ` +
        entry.record.reason,
    );
    for (const service of entry.record.services) {
      log(
        `  service ${service.name}: ${service.action}` +
          (service.portReleased ? " (port lease released)" : ""),
      );
    }
  }
}

/** Read persisted recovery evidence without planning or mutating anything. */
function readRuntimeRecoveryRecords(
  repoRoot: string,
): SupervisorRuntimeRecovery[] {
  const runtimeDir = portAllocatorPaths(repoRoot).runtimeDir;
  let entries: Dirent[];
  try {
    entries = readdirSync(runtimeDir, { withFileTypes: true });
  } catch {
    // Status/read-only callers must stay usable without runtime state.
    return [];
  }

  const records: SupervisorRuntimeRecovery[] = [];
  for (const entry of entries
    .filter((candidate) => candidate.isDirectory())
    .sort((a, b) => a.name.localeCompare(b.name))) {
    const path = join(runtimeDir, entry.name, RUNTIME_MANIFEST_FILE);
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    } catch {
      continue;
    }
    if (!isRecord(parsed)) continue;
    const recovery = parsed.recovery;
    if (!isRuntimeRecoveryRecord(recovery)) continue;

    // The record owns its identity. Records written before runtime identity
    // was carried fall back to the manifest, then the runtime directory.
    const runtimeId =
      typeof recovery.runtimeId === "string" && recovery.runtimeId.trim() !== ""
        ? recovery.runtimeId
        : typeof parsed.runtimeId === "string" &&
            parsed.runtimeId.trim() !== ""
          ? parsed.runtimeId
          : entry.name;
    const cleanup = isRuntimeCleanupState(parsed.cleanup)
      ? parsed.cleanup
      : undefined;
    records.push({
      runtimeId,
      ...(cleanup !== undefined ? { cleanup } : {}),
      recovery,
    });
  }
  return records;
}

function isRuntimeCleanupState(value: unknown): value is RuntimeCleanupState {
  return (
    value === "pending" ||
    value === "running" ||
    value === "complete" ||
    value === "failed"
  );
}

function isRuntimeRecoveryRecord(
  value: unknown,
): value is RuntimeRecoveryRecord {
  if (!isRecord(value)) return false;
  return (
    (value.state === "reaped" ||
      value.state === "needs_human" ||
      value.state === "skipped") &&
    typeof value.reason === "string" &&
    typeof value.at === "string" &&
    typeof value.reaperPid === "number" &&
    typeof value.reaperHost === "string" &&
    Array.isArray(value.services)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// ---------------------------------------------------------------------------
// Shared batch execution
// ---------------------------------------------------------------------------

interface ExecuteRunInput {
  repoRoot: string;
  manifest: RunManifest;
  lock: SupervisorLockHandle;
  rest: string[];
  options: SupervisorCliOptions;
  log: (line: string) => void;
  resumed: boolean;
  /** Outcome of the pre-dispatch execution.continuity reconciliation. */
  continuity?: ExecutionContinuityReport;
  /** Reuse validated rejected attempt worktrees instead of fresh ones. */
  reuseAttempts: boolean;
  deadlinePolicy?: DeadlineExtensionPolicy;
  budgetPolicy?: BudgetContinuationPolicy;
  maxBudgetUsd?: number;
}

async function executeRun(input: ExecuteRunInput): Promise<number> {
  const {
    repoRoot,
    manifest,
    lock,
    rest,
    options,
    log,
    resumed,
    continuity,
    deadlinePolicy,
    budgetPolicy,
    maxBudgetUsd,
  } = input;
  // Resume reconciliation moved any abandoned attempt's cost to
  // prior-attempt provenance. The batch replaces task records when a task
  // completes, so capture the retained costs before dispatch and re-aggregate
  // them into the checkpointed result.
  const priorAttemptCosts = collectPriorAttemptCosts(manifest);
  const removeSignals = installSignalHandlers(
    repoRoot,
    manifest.runId,
    lock,
    options,
  );

  try {
    const result = await runCodexBatch({
      contractsPath: manifest.contractsPath,
      repoRoot,
      ledgerPath:
        arg("--ledger", rest) ?? join(repoRoot, ".cliyard", "ledger.json"),
      worker: workerFrom(rest),
      model: arg("--model", rest),
      dryRun: has("--dry-run", rest),
      keepWorktrees: has("--keep-worktrees", rest),
      verbose: has("--verbose", rest),
      runManifest: manifest,
      reuseAttempts: input.reuseAttempts,
      ...(deadlinePolicy ? { deadlinePolicy } : {}),
      ...(budgetPolicy ? { budgetPolicy } : {}),
      ...(maxBudgetUsd !== undefined ? { maxBudgetUsd } : {}),
      workerFactory: options.workerFactory,
    });
    const finalManifest = mergePriorAttemptCosts(
      repoRoot,
      result.manifest ?? loadRunManifest(repoRoot, manifest.runId),
      priorAttemptCosts,
    );
    // Worker exit, path audit, process cleanup, WorkspaceBoundary comparison
    // and cost checkpoints have all settled by the time the batch returns.
    // The controller-owned bundle is finalized here, after those facts exist.
    const evidence = generateRunEvidence(repoRoot, finalManifest);
    log(
      JSON.stringify(
        summarizeRun(finalManifest, result, resumed, evidence, continuity),
        null,
        2,
      ),
    );
    return finalManifest.status === "completed" ? 0 : 1;
  } catch (error) {
    // A failed invocation must not discard the abandoned attempt's cost.
    // Best effort: the retained record is already durable on disk.
    try {
      mergePriorAttemptCosts(
        repoRoot,
        loadRunManifest(repoRoot, manifest.runId),
        priorAttemptCosts,
      );
    } catch {
      /* best-effort retention; the original error stays authoritative */
    }
    markInterrupted(repoRoot, manifest.runId);
    throw error;
  } finally {
    removeSignals();
    lock.release();
  }
}

function collectPriorAttemptCosts(
  manifest: RunManifest,
): Map<string, CostTruth> {
  const prior = new Map<string, CostTruth>();
  for (const task of Object.values(manifest.tasks)) {
    if (task.priorAttemptCost !== undefined) {
      prior.set(task.taskId, task.priorAttemptCost);
    }
  }
  return prior;
}

/**
 * Aggregate each retained prior-attempt cost with the cost the invocation
 * recorded for that task, then clear the retention field. Every observation
 * keeps its own session id, so an abandoned session is never reattributed to
 * the new attempt and an unavailable session stays visible in `missing`.
 */
function mergePriorAttemptCosts(
  repoRoot: string,
  manifest: RunManifest,
  priorAttemptCosts: ReadonlyMap<string, CostTruth>,
): RunManifest {
  if (priorAttemptCosts.size === 0) return manifest;
  let changed = false;
  const updated = updateRunManifest(repoRoot, manifest.runId, (current) => {
    for (const [taskId, captured] of priorAttemptCosts) {
      const task = current.tasks[taskId];
      if (!task) continue;
      // The batch drops the field when it replaces a task record, so fall
      // back to the pre-dispatch capture when needed.
      const prior = task.priorAttemptCost ?? captured;
      task.cost = aggregateCostTruth([prior, task.cost]);
      delete task.priorAttemptCost;
      changed = true;
    }
  });
  return changed ? updated : manifest;
}

function summarizeRun(
  manifest: RunManifest,
  result: CodexBatchResult,
  resumed: boolean,
  evidence: SupervisorEvidenceStatus,
  continuity?: ExecutionContinuityReport,
): Record<string, unknown> {
  const counts = taskCounts(manifest);
  return {
    runId: manifest.runId,
    planId: manifest.planId,
    status: manifest.status,
    resumed,
    accepted: counts.accepted,
    pending: counts.pending,
    blocked: counts.blocked,
    total: counts.total,
    startOrder: result.startOrder,
    waves: result.waves,
    skipped: result.skipped,
    allAccepted: result.allAccepted,
    integration: result.integration,
    integrationHead: manifest.integrationHead,
    tasks: Object.values(manifest.tasks).map((task) => ({ ...task })),
    ledgerPath: result.ledgerPath,
    evidence,
    ...(continuity && hasContinuityActivity(continuity)
      ? { continuity }
      : {}),
  };
}

/** Keep the summary shape unchanged when no prior worker lease was observed. */
function hasContinuityActivity(report: ExecutionContinuityReport): boolean {
  return (
    report.attached.length > 0 ||
    report.exited.length > 0 ||
    report.stopped.length > 0 ||
    report.durable.length > 0 ||
    report.failClosed.length > 0
  );
}

function taskCounts(manifest: RunManifest): {
  total: number;
  accepted: number;
  pending: number;
  blocked: number;
} {
  const tasks = Object.values(manifest.tasks);
  const accepted = tasks.filter((task) => task.accepted).length;
  return {
    total: tasks.length,
    accepted,
    pending: tasks.length - accepted,
    blocked: tasks.filter(
      (task) => !task.accepted && task.status === "blocked",
    ).length,
  };
}

function installSignalHandlers(
  repoRoot: string,
  runId: string,
  lock: SupervisorLockHandle,
  options: SupervisorCliOptions,
): () => void {
  if (options.signalHandling === false) return () => undefined;

  const shutdown = (code: number) => {
    markInterrupted(repoRoot, runId);
    lock.release();
    process.exit(code);
  };
  const onSigint = () => shutdown(130);
  const onSigterm = () => shutdown(143);
  process.on("SIGINT", onSigint);
  process.on("SIGTERM", onSigterm);
  return () => {
    process.off("SIGINT", onSigint);
    process.off("SIGTERM", onSigterm);
  };
}

function markInterrupted(repoRoot: string, runId: string): void {
  try {
    updateRunManifest(repoRoot, runId, (manifest) => {
      if (manifest.status === "running") manifest.status = "interrupted";
    });
  } catch {
    /* best-effort: existing checkpoints are already durable */
  }
}

// ---------------------------------------------------------------------------
// Argument / git helpers
// ---------------------------------------------------------------------------

const DEADLINE_VALUE_FLAGS = [
  "--timeout-ms",
  "--deadline-extension-ms",
  "--max-deadline-extensions",
  "--max-total-timeout-ms",
  "--healthy-activity-window-ms",
] as const;

const BUDGET_VALUE_FLAGS = [
  "--max-budget-usd",
  "--continuation-guard-usd",
  "--max-budget-continuations",
  "--max-cumulative-budget-guard-usd",
  "--budget-overshoot-reserve-usd",
] as const;

function budgetSettingsFromArgs(
  argv: string[],
  worker: "codex" | "claude",
): {
  maxBudgetUsd?: number;
  budgetPolicy?: BudgetContinuationPolicy;
} {
  const autoOccurrences = flagOccurrences(
    "--auto-continue-budget",
    argv,
  );
  if (autoOccurrences.length > 1) {
    throw new Error(
      "supervisor: --auto-continue-budget may be specified only once",
    );
  }
  if (autoOccurrences.some((value) => value.includes("="))) {
    throw new Error(
      "supervisor: --auto-continue-budget does not accept a value",
    );
  }
  const anyBudgetFlag =
    autoOccurrences.length > 0 ||
    BUDGET_VALUE_FLAGS.some(
      (flag) => flagOccurrences(flag, argv).length > 0,
    );
  if (anyBudgetFlag && worker !== "claude") {
    throw new Error(
      "supervisor: budget continuation flags require --worker claude",
    );
  }

  const maxBudgetUsd = moneyFlag("--max-budget-usd", argv, false);
  const continuationGuardUsd = moneyFlag(
    "--continuation-guard-usd",
    argv,
    false,
  );
  const requestedMaxContinuations = integerFlag(
    "--max-budget-continuations",
    argv,
  );
  if (
    requestedMaxContinuations !== undefined &&
    requestedMaxContinuations > MAX_BUDGET_CONTINUATIONS
  ) {
    throw new Error(
      `supervisor: --max-budget-continuations must be at most ` +
        `${MAX_BUDGET_CONTINUATIONS}`,
    );
  }
  const requestedMaxCumulative = moneyFlag(
    "--max-cumulative-budget-guard-usd",
    argv,
    false,
  );
  const overshootReserveUsd = moneyFlag(
    "--budget-overshoot-reserve-usd",
    argv,
    true,
  );
  const autoContinue = autoOccurrences.length === 1;
  const hasPolicyFlag =
    autoContinue ||
    continuationGuardUsd !== undefined ||
    requestedMaxContinuations !== undefined ||
    requestedMaxCumulative !== undefined ||
    overshootReserveUsd !== undefined;
  if (!hasPolicyFlag) return maxBudgetUsd !== undefined ? { maxBudgetUsd } : {};

  const baseGuardUsd =
    maxBudgetUsd ?? DEFAULT_BUDGET_CONTINUATION_POLICY.baseGuardUsd;
  const continuationGuard =
    continuationGuardUsd ??
    DEFAULT_BUDGET_CONTINUATION_POLICY.continuationGuardUsd;
  const maxContinuations =
    requestedMaxContinuations ??
    DEFAULT_BUDGET_CONTINUATION_POLICY.maxContinuations;
  const overshootReserve =
    overshootReserveUsd ??
    DEFAULT_BUDGET_CONTINUATION_POLICY.overshootReserveUsd;
  const maxCumulativeGuardUsd =
    requestedMaxCumulative ??
    roundMoney(
      baseGuardUsd +
        continuationGuard * maxContinuations +
        overshootReserve,
    );

  if (autoContinue && maxContinuations === 0) {
    throw new Error(
      "supervisor: --auto-continue-budget requires " +
        "--max-budget-continuations > 0",
    );
  }
  if (maxCumulativeGuardUsd > MAX_BUDGET_GUARD_USD) {
    throw new Error(
      `supervisor: max cumulative budget guard must be at most ` +
        `${MAX_BUDGET_GUARD_USD}`,
    );
  }
  const policy = parseBudgetContinuationPolicy({
    version: BUDGET_CONTINUATION_POLICY_VERSION,
    baseGuardUsd,
    continuationGuardUsd: continuationGuard,
    maxContinuations,
    maxCumulativeGuardUsd,
    autoContinue,
    overshootReserveUsd: overshootReserve,
  });
  if (!policy) {
    throw new Error(
      "supervisor: invalid budget continuation policy; positive guards, " +
        "a cumulative guard covering continuation plus overshoot reserve, " +
        "and 0..64 continuations are required",
    );
  }
  return { maxBudgetUsd: baseGuardUsd, budgetPolicy: policy };
}

function moneyFlag(
  flag: string,
  argv: string[],
  allowZero: boolean,
): number | undefined {
  const occurrences = flagOccurrences(flag, argv);
  if (occurrences.length === 0) return undefined;
  if (occurrences.length > 1) {
    throw new Error(`supervisor: ${flag} may be specified only once`);
  }
  const raw = arg(flag, argv);
  if (
    raw === undefined ||
    !/^(?:0|[1-9]\d*)(?:\.\d{1,6})?$/.test(raw)
  ) {
    throw new Error(
      `supervisor: ${flag} requires a non-negative USD amount with at ` +
        "most 6 decimal places",
    );
  }
  const value = Number(raw);
  if (
    !Number.isFinite(value) ||
    value > MAX_BUDGET_GUARD_USD ||
    (!allowZero && value === 0) ||
    (parseBudgetGuardUsd(value) === undefined && !(allowZero && value === 0))
  ) {
    throw new Error(
      `supervisor: ${flag} requires a ` +
        `${allowZero ? "non-negative" : "positive"} bounded USD amount`,
    );
  }
  return value;
}

function roundMoney(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function deadlinePolicyFromArgs(
  argv: string[],
): DeadlineExtensionPolicy | undefined {
  const autoFlags = flagOccurrences("--auto-extend-deadline", argv);
  if (autoFlags.length > 1) {
    throw new Error(
      "supervisor: --auto-extend-deadline may be specified only once",
    );
  }
  if (
    autoFlags.some((value) =>
      value.startsWith("--auto-extend-deadline="),
    )
  ) {
    throw new Error(
      "supervisor: --auto-extend-deadline does not accept a value",
    );
  }
  const autoExtend = autoFlags.length === 1;
  const present = DEADLINE_VALUE_FLAGS.some((flag) =>
    flagOccurrences(flag, argv).length > 0,
  );
  if (!present && !autoExtend) return undefined;

  const baseTimeoutMs =
    integerFlag("--timeout-ms", argv) ??
    DEFAULT_DEADLINE_EXTENSION_POLICY.baseTimeoutMs;
  const extensionStepMs =
    integerFlag("--deadline-extension-ms", argv) ??
    DEFAULT_DEADLINE_EXTENSION_POLICY.extensionStepMs;
  const maxExtensions =
    integerFlag("--max-deadline-extensions", argv) ??
    DEFAULT_DEADLINE_EXTENSION_POLICY.maxExtensions;
  const healthyActivityWindowMs =
    integerFlag("--healthy-activity-window-ms", argv) ??
    DEFAULT_DEADLINE_EXTENSION_POLICY.healthyActivityWindowMs;
  const requestedMaxTotal = integerFlag("--max-total-timeout-ms", argv);
  const maxTotalTimeoutMs =
    requestedMaxTotal ??
    (maxExtensions > 0
      ? baseTimeoutMs + extensionStepMs * maxExtensions
      : baseTimeoutMs);

  if (
    !Number.isSafeInteger(maxTotalTimeoutMs) ||
    maxTotalTimeoutMs > MAX_DEADLINE_TIMEOUT_MS
  ) {
    throw new Error(
      `supervisor: deadline policy maxTotalTimeoutMs must be at most ` +
        `${MAX_DEADLINE_TIMEOUT_MS}`,
    );
  }
  if (maxTotalTimeoutMs < baseTimeoutMs) {
    throw new Error(
      "supervisor: deadline policy maxTotalTimeoutMs must be at least base timeout",
    );
  }
  if (
    maxExtensions > 0 &&
    baseTimeoutMs + extensionStepMs > maxTotalTimeoutMs
  ) {
    throw new Error(
      "supervisor: deadline extension step cannot fit within maxTotalTimeoutMs",
    );
  }
  if (autoExtend && maxExtensions === 0) {
    throw new Error(
      "supervisor: --auto-extend-deadline requires --max-deadline-extensions > 0",
    );
  }

  const policy = parseDeadlineExtensionPolicy({
    version: 1,
    baseTimeoutMs,
    extensionStepMs,
    maxExtensions,
    maxTotalTimeoutMs,
    healthyActivityWindowMs,
    autoExtend,
  });
  if (!policy) {
    throw new Error(
      "supervisor: invalid deadline policy; positive timer bounds and " +
        "non-negative max extensions are required",
    );
  }
  return policy;
}

function integerFlag(flag: string, argv: string[]): number | undefined {
  const occurrences = flagOccurrences(flag, argv);
  if (occurrences.length === 0) return undefined;
  if (occurrences.length > 1) {
    throw new Error(`supervisor: ${flag} may be specified only once`);
  }
  const raw = arg(flag, argv);
  if (raw === undefined || !/^(?:0|[1-9]\d*)$/.test(raw)) {
    throw new Error(`supervisor: ${flag} requires a non-negative integer`);
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) {
    throw new Error(`supervisor: ${flag} is too large`);
  }
  return value;
}

function flagOccurrences(flag: string, argv: string[]): string[] {
  return argv.filter(
    (value) => value === flag || value.startsWith(`${flag}=`),
  );
}

function repoFrom(argv: string[]): string {
  return resolve(arg("--repo", argv) ?? process.cwd());
}

function workerFrom(argv: string[]): "codex" | "claude" {
  const raw = arg("--worker", argv) ?? "claude";
  if (raw !== "codex" && raw !== "claude") {
    throw new Error(`supervisor: --worker must be codex or claude (got ${raw})`);
  }
  return raw;
}

function resolveSharedBaseCommit(
  repoRoot: string,
  contracts: TaskContract[],
): string {
  if (contracts.length === 0) {
    throw new Error("supervisor: contracts contain no tasks");
  }
  const bases = new Set<string>();
  for (const contract of contracts) {
    bases.add(resolveCommit(repoRoot, contract.baseCommit?.trim() || "HEAD"));
  }
  if (bases.size !== 1) {
    throw new Error(
      "supervisor: all contracts must resolve to one base commit; got " +
        [...bases].join(", "),
    );
  }
  return [...bases][0]!;
}

function resolveCommit(repoRoot: string, revision: string): string {
  const result = git(repoRoot, [
    "rev-parse",
    "--verify",
    `${revision}^{commit}`,
  ]);
  if (result.status !== 0) {
    throw new Error(
      `supervisor: cannot resolve git revision "${revision}" in ${repoRoot}: ` +
        ((result.stderr || result.stdout).trim() ||
          `git exited ${result.status}`),
    );
  }
  return result.stdout.trim();
}

function tryResolveCommit(
  repoRoot: string,
  revision: string,
): string | undefined {
  const result = git(repoRoot, [
    "rev-parse",
    "--verify",
    `${revision}^{commit}`,
  ]);
  return result.status === 0 ? result.stdout.trim() : undefined;
}

function git(cwd: string, args: string[]) {
  return spawnSync("git", args, { cwd, encoding: "utf8" });
}

function arg(flag: string, argv: string[]): string | undefined {
  const i = argv.indexOf(flag);
  if (i >= 0 && argv[i + 1] !== undefined && !argv[i + 1]!.startsWith("--")) {
    return argv[i + 1];
  }
  const eq = argv.find((value) => value.startsWith(`${flag}=`));
  return eq?.slice(flag.length + 1);
}

function has(flag: string, argv: string[]): boolean {
  return argv.includes(flag);
}

const VALUE_FLAGS = new Set([
  "--repo",
  "--run",
  "--run-id",
  "--worker",
  "--model",
  "--ledger",
  "--plan-id",
  ...DEADLINE_VALUE_FLAGS,
  ...BUDGET_VALUE_FLAGS,
]);

function positionalArg(argv: string[]): string | undefined {
  for (let i = 0; i < argv.length; i += 1) {
    const value = argv[i]!;
    if (value.startsWith("--")) {
      if (VALUE_FLAGS.has(value)) i += 1;
      continue;
    }
    return value;
  }
  return undefined;
}

function printUsage(log: (line: string) => void): void {
  log(`cliyard supervisor — durable foreground supervisor (V0)

Usage:
  cliyard supervisor start <contracts.json> --repo <path> [--run-id id]
                                [--worker claude|codex] [--model id]
                                [--plan-id id] [--ledger path] [--dry-run]
                                [--keep-worktrees] [--verbose]
                                [--timeout-ms n]
                                [--auto-extend-deadline]
                                [--deadline-extension-ms n]
                                [--max-deadline-extensions n]
                                [--max-total-timeout-ms n]
                                [--healthy-activity-window-ms n]
                                [--max-budget-usd usd]
                                [--auto-continue-budget]
                                [--continuation-guard-usd usd]
                                [--max-budget-continuations n]
                                [--max-cumulative-budget-guard-usd usd]
                                [--budget-overshoot-reserve-usd usd]
  cliyard supervisor status --repo <path> [--run id] [--json]
  cliyard supervisor evidence --repo <path> [--run id] [--json] [--regenerate]
  cliyard supervisor resume --repo <path> [--run id] [--worker claude|codex]
                            [--model id] [--dry-run] [--keep-worktrees]
                            [--retry-rejected] [--reuse-attempt | --fresh-attempt]
                            [--force] [--verbose] [--timeout-ms n]
                            [--auto-extend-deadline]
                            [--deadline-extension-ms n]
                            [--max-deadline-extensions n]
                            [--max-total-timeout-ms n]
                            [--healthy-activity-window-ms n]
                            [--max-budget-usd usd]
                            [--auto-continue-budget]
                            [--continuation-guard-usd usd]
                            [--max-budget-continuations n]
                            [--max-cumulative-budget-guard-usd usd]
                            [--budget-overshoot-reserve-usd usd]
  cliyard supervisor reap --repo <path> [--json]
  cliyard supervisor recover-workers --repo <path> [--run id] [--json]
  cliyard supervisor stop --repo <path> [--run id] [--force]

Foreground only: start/resume hold .cliyard/supervisor.lock until exit.
Resume rejects changed contracts, a moved base commit, or a missing
integration branch, and never reruns accepted tasks.
A rejected attempt keeps its dirty worktree. Resume reuses a valid recorded
attempt by default; --fresh-attempt discards it for a clean worktree.
Start/resume reap proven orphaned runtimes after acquiring the lock and fail
closed when any runtime needs human review. Status only reads persisted
recovery and worker-lease records; it never reconciles. A terminal run with a
missing or invalid final evidence bundle is reported as degraded. The evidence
command only reads; --regenerate rebuilds the bundle from the terminal
RunManifest without changing task acceptance. recover-workers only
signals an exactly verified worker group after proving its controller dead on
this host; it never reattaches stdout or changes RunManifest acceptance.
Automatic deadline extension is off by default and is available only with
Claude's mapped assistant/tool progress.
Automatic budget continuation is off by default and max continuations are
zero; an opted-in grant starts a new Claude invocation and is not a balance,
invoice, quota or strict hard cap. Codex remains fail-closed at its base
timeout.`);
}

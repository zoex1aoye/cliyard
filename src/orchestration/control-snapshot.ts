/**
 * Read-only queue control projection (queue-observe-v0).
 *
 * This joins durable queue authority, the latest RunManifest, worker progress,
 * queue locks and bounded audit events. It never writes any of them and never
 * changes acceptance or run status.
 */
import {
  inspectQueueLock,
  loadQueue,
  queueCounts,
  queueItemContractsIdentity,
  type QueueCounts,
  type QueueItem,
  type QueueLockInspection,
} from "./queue-store.js";
import {
  readQueueEventJournal,
  type QueueControlEvent,
  type QueueEventJournalSummary,
} from "./event-journal.js";
import {
  sampleResourceSnapshot,
  unresolvedProviderCapacity,
  type ResourceSnapshot,
} from "../runtime/resource-snapshot.js";
import {
  buildStatus,
  type SupervisorStatus,
  type WorkerProgressStatus,
} from "../supervisor/cli.js";
import {
  inspectRun,
  inspectSupervisorLock,
} from "../supervisor/store.js";
import type {
  ReusableAttempt,
  RunStatus,
  RunTaskState,
} from "../supervisor/types.js";
import {
  FAILURE_CATEGORIES,
  aggregateCostTruth,
  costCompleteness,
  type CostCompleteness,
  type CostState,
  type CostTruth,
  type FailureCategory,
  type FailureRecord,
  type TokenUsage,
} from "../failures.js";
import { resolve } from "node:path";
import {
  checkExecutionPolicyCompatibility,
  type ExecutionCapabilities,
  type ExecutionPolicyCompatibility,
  type ExecutionRuntimeId,
} from "../execution/profile.js";
import {
  summarizeQueueContinuationPolicy,
  type QueueContinuationPolicySummary,
} from "../agents/continuation.js";

export const CONTROL_SNAPSHOT_VERSION = 1 as const;

export type ControlDecisionCategory =
  | "none"
  | "dependency"
  | "verifier"
  | "infrastructure"
  | "policy"
  | "human";

export type ObservedNextAction =
  | "none"
  | "wait-dependencies"
  | "reconcile-running-item"
  | "dispatch-start"
  | "dispatch-resume"
  | "inspect-and-retry"
  | "extend-attempts-or-cancel";

export interface ControlRunSnapshot {
  runId: string;
  planId: string;
  status: RunStatus;
  effectiveStatus: RunStatus;
  interrupted: boolean;
  ownerAlive: boolean | null;
  baseCommit: string;
  contractsPath: string;
  contractsHash: string;
  contractsMatch: boolean | null;
  integrationBranch: string;
  integrationHead: string;
  integrationBranchHead: string | null;
  accepted: number;
  pending: number;
  blocked: number;
  total: number;
  tasks: RunTaskState[];
  lastCheckpoint: string;
  lastAccepted: RunTaskState | null;
  reusableAttempts: ReusableAttempt[];
  workerProgress: WorkerProgressStatus[];
}

export interface ControlItemSnapshot extends QueueItem {
  ready: boolean;
  retryable: boolean;
  observedNextAction: ObservedNextAction;
  decision: {
    category: ControlDecisionCategory;
    reason: string | null;
  };
  contracts: {
    path: string;
    hash: string;
  } | null;
  run: ControlRunSnapshot | null;
  execution: ControlExecutionSnapshot;
  journalEvents: QueueControlEvent[];
  errors: string[];
}

/** Read-only projection of the frozen queue execution identity. */
export interface ControlExecutionSnapshot {
  frozen: boolean;
  profileId: string | null;
  runtimeId: ExecutionRuntimeId | "unknown";
  modelId: string | null;
  providerId: string | null;
  endpointRef: string | null;
  accountBindingId: string | null;
  capabilities: ExecutionCapabilities | null;
  continuation: QueueContinuationPolicySummary | null;
  policyCheck: ExecutionPolicyCompatibility;
}

/** Observed failure categories across queue items and their durable run tasks. */
export type ControlFailureCounts = Partial<Record<FailureCategory, number>>;

/**
 * Run-wide cost observation. v0 never claims an authoritative run total:
 * `authoritative` is always false and a subtotal is shown only when known
 * amounts share one currency.
 */
export interface ControlCostSnapshot {
  state: CostState;
  completeness: CostCompleteness;
  authoritative: false;
  currency: string | null;
  amount: number | null;
  usage: TokenUsage | null;
  missing: string[];
}

export interface ControlSnapshot {
  version: typeof CONTROL_SNAPSHOT_VERSION;
  observedAt: string;
  repoRoot: string;
  counts: QueueCounts;
  queue: {
    updatedAt: string;
    lock: QueueLockInspection;
  };
  journal: QueueEventJournalSummary;
  resources: ResourceSnapshot;
  items: ControlItemSnapshot[];
  /** Non-zero durable failure-category counts only. */
  failureCounts: ControlFailureCounts;
  /** Observed, non-authoritative cost subtotal with completeness/missing. */
  cost: ControlCostSnapshot;
}

export interface BuildControlSnapshotOptions {
  /** Test/embedding seam; defaults to the current time. */
  now?: Date;
  journalLimit?: number;
}

/**
 * Build a read-only control snapshot. Missing/unreadable manifests, worker
 * events and journal records are surfaced per item without changing state.
 */
export async function buildControlSnapshot(
  repoRootInput: string,
  options: BuildControlSnapshotOptions = {},
): Promise<ControlSnapshot> {
  const repoRoot = resolve(repoRootInput);
  const observedAt = (options.now ?? new Date()).toISOString();
  const document = loadQueue(repoRoot);
  const journal = readQueueEventJournal(
    repoRoot,
    options.journalLimit,
  );
  const queueLock = inspectQueueLock(repoRoot);
  const byId = new Map(document.items.map((item) => [item.id, item]));
  const items: ControlItemSnapshot[] = [];
  const supervisorLock = inspectSupervisorLock(repoRoot);

  for (const item of document.items) {
    const contractsIdentity = queueItemContractsIdentity(item);
    const contracts = contractsIdentity
      ? {
          path: contractsIdentity.contractsPath,
          hash: contractsIdentity.contractsHash,
        }
      : null;
    const errors: string[] = [];
    let run: ControlRunSnapshot | null = null;
    const runId = item.lastRunId ?? item.runIds.at(-1);
    if (runId) {
      try {
        const inspection = inspectRun(repoRoot, runId);
        const status = await buildStatus(
          repoRoot,
          inspection,
          supervisorLock,
        );
        run = controlRun(status, contracts, errors);
        if (
          item.status === "running" &&
          run.effectiveStatus !== "running"
        ) {
          errors.push(
            `queue item is running but run is ${run.effectiveStatus}`,
          );
        }
        if (
          item.status === "completed" &&
          run.effectiveStatus !== "completed"
        ) {
          errors.push(
            `queue item is completed but run is ${run.effectiveStatus}`,
          );
        }
      } catch (error) {
        errors.push(`run ${runId}: ${errorMessage(error)}`);
      }
    }

    const runIds = new Set(item.runIds);
    if (runId) runIds.add(runId);
    const journalEvents = journal.events.filter(
      (event) =>
        event.itemId === item.id ||
        (event.runId !== undefined && runIds.has(event.runId)),
    );
    const ready = itemIsReady(item, byId);
    const execution = controlExecution(item);
    if (!execution.policyCheck.ok && execution.policyCheck.reason) {
      errors.push(execution.policyCheck.reason);
    }
    const retryable =
      item.status === "blocked" && item.attempts < item.maxAttempts;

    items.push({
      ...cloneQueueItem(item),
      ready,
      retryable,
      observedNextAction: observedNextAction(
        item,
        ready,
        queueLock.state,
      ),
      decision: classifyDecision(item, run, ready, queueLock.state),
      contracts,
      run,
      execution,
      journalEvents,
      errors,
    });
  }

  const hasUnknownActiveItem = items.some(
    (item) => item.status === "running" && item.run === null,
  );
  const activeTaskAttempts = hasUnknownActiveItem
    ? null
    : items.reduce(
        (total, item) =>
          total +
          (item.run?.tasks.filter((task) => task.status === "running").length ??
            0),
        0,
      );
  const profiles = new Map<
    string,
    ReturnType<typeof unresolvedProviderCapacity>
  >();
  for (const item of document.items) {
    const key = `${item.worker}\u0000${item.model ?? ""}`;
    const profileItems = items.filter(
      (candidate) =>
        candidate.worker === item.worker &&
        candidate.model === item.model,
    );
    const observedInFlight = profileItems.some(
      (candidate) => candidate.status === "running" && candidate.run === null,
    )
      ? null
      : profileItems.reduce(
          (total, candidate) =>
            total +
            (candidate.run?.tasks.filter(
              (task) => task.status === "running",
            ).length ?? 0),
          0,
        );
    if (!profiles.has(key)) {
      profiles.set(
        key,
        unresolvedProviderCapacity(
          item.worker,
          item.model ?? null,
          observedInFlight,
        ),
      );
    }
  }

  const resources = sampleResourceSnapshot({
    at: options.now ?? new Date(observedAt),
    provider: [...profiles.values()],
    runtime: { activeTaskAttempts },
  });

  return {
    version: CONTROL_SNAPSHOT_VERSION,
    observedAt,
    repoRoot,
    counts: queueCounts(document),
    queue: {
      updatedAt: document.updatedAt,
      lock: queueLock,
    },
    journal,
    resources,
    items,
    failureCounts: collectFailureCounts(items),
    cost: summarizeCost(items),
  };
}

/**
 * Count durable failures without double-counting one run task referenced by
 * multiple queue items. A queue-item failure is counted only when that item
 * has no RunManifest, because dispatched-run failure is manifest authority.
 */
function collectFailureCounts(
  items: ControlItemSnapshot[],
): ControlFailureCounts {
  const seen = new Set<string>();
  const tally = new Map<FailureCategory, number>();
  const add = (failure: FailureRecord): void => {
    tally.set(failure.category, (tally.get(failure.category) ?? 0) + 1);
  };
  for (const item of items) {
    if (!item.run && item.failure) {
      const key = `item:${item.id}`;
      if (!seen.has(key)) {
        seen.add(key);
        add(item.failure);
      }
    }
    for (const task of item.run?.tasks ?? []) {
      if (!task.failure) continue;
      const key = `run:${item.run!.runId}:${task.taskId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      add(task.failure);
    }
  }
  const counts: ControlFailureCounts = {};
  for (const category of FAILURE_CATEGORIES) {
    const value = tally.get(category);
    if (value !== undefined && value > 0) counts[category] = value;
  }
  return counts;
}

/**
 * Aggregate known task costs across durable runs. Mixed currencies stay
 * uncombined (null amount plus missing reasons), and the result is explicitly
 * non-authoritative even when every observation is provider-reported.
 */
function summarizeCost(items: ControlItemSnapshot[]): ControlCostSnapshot {
  const seen = new Set<string>();
  const costs: CostTruth[] = [];
  for (const item of items) {
    for (const task of item.run?.tasks ?? []) {
      if (!task.cost) continue;
      const key = `run:${item.run!.runId}:${task.taskId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      costs.push(task.cost);
    }
  }
  const aggregated = aggregateCostTruth(costs);
  return {
    state: aggregated.state,
    completeness: costCompleteness(aggregated),
    authoritative: false,
    currency: aggregated.currency,
    amount: aggregated.amount,
    usage: aggregated.usage,
    missing: aggregated.missing,
  };
}

function controlRun(
  status: SupervisorStatus,
  contracts: { path: string; hash: string } | null,
  errors: string[],
): ControlRunSnapshot {
  let contractsMatch: boolean | null = null;
  if (contracts) {
    contractsMatch =
      resolve(status.contractsPath) === resolve(contracts.path) &&
      status.contractsHash === contracts.hash;
    if (!contractsMatch) {
      errors.push(
        "RunManifest contracts identity does not match the queue item",
      );
    }
  }

  return {
    runId: status.runId,
    planId: status.planId,
    status: status.status,
    effectiveStatus: status.effectiveStatus,
    interrupted: status.interrupted,
    ownerAlive: status.ownerAlive,
    baseCommit: status.baseCommit,
    contractsPath: status.contractsPath,
    contractsHash: status.contractsHash,
    contractsMatch,
    integrationBranch: status.integrationBranch,
    integrationHead: status.integrationHead,
    integrationBranchHead: status.integrationBranchHead,
    accepted: status.accepted,
    pending: status.pending,
    blocked: status.blocked,
    total: status.total,
    tasks: status.tasks.map((task) => ({ ...task })),
    lastCheckpoint: status.lastCheckpoint,
    lastAccepted: status.lastAccepted
      ? { ...status.lastAccepted }
      : null,
    reusableAttempts: status.reusableAttempts.map((attempt) => ({
      ...attempt,
    })),
    workerProgress: status.workerProgress.map((progress) => ({
      ...progress,
      event: { ...progress.event },
    })),
  };
}

function itemIsReady(
  item: QueueItem,
  byId: ReadonlyMap<string, QueueItem>,
): boolean {
  if (item.status !== "pending") return false;
  return item.dependsOn.every(
    (dependency) => byId.get(dependency)?.status === "completed",
  );
}

function observedNextAction(
  item: QueueItem,
  ready: boolean,
  queueLockState: QueueLockInspection["state"],
): ObservedNextAction {
  if (item.status === "completed" || item.status === "cancelled") {
    return "none";
  }
  if (item.status === "running") {
    return queueLockState === "held"
      ? "none"
      : "reconcile-running-item";
  }
  if (item.status === "blocked") {
    if (item.attempts >= item.maxAttempts) {
      return "extend-attempts-or-cancel";
    }
    return "inspect-and-retry";
  }
  if (!ready) return "wait-dependencies";
  if (item.attempts >= item.maxAttempts) {
    return "extend-attempts-or-cancel";
  }
  return item.nextAction === "resume"
    ? "dispatch-resume"
    : "dispatch-start";
}

/**
 * Read-only display classifier. Durable failure categories are the primary
 * signal; the text heuristics below remain only for legacy records without
 * structured failure metadata. It never changes queue or run authority.
 */
function classifyDecision(
  item: QueueItem,
  run: ControlRunSnapshot | null,
  ready: boolean,
  queueLockState: QueueLockInspection["state"],
): ControlItemSnapshot["decision"] {
  if (item.status === "completed" || item.status === "cancelled") {
    return { category: "none", reason: null };
  }
  if (item.status === "pending") {
    if (!ready) {
      return {
        category: "dependency",
        reason: "waiting for completed dependencies",
      };
    }
    if (item.attempts >= item.maxAttempts) {
      return {
        category: "policy",
        reason: `attempt limit ${item.attempts}/${item.maxAttempts}`,
      };
    }
    return { category: "none", reason: null };
  }
  if (run?.interrupted) {
    return {
      category: "infrastructure",
      reason: "run owner is gone; reconcile or resume the durable run",
    };
  }
  if (item.status === "running") {
    return queueLockState === "held"
      ? { category: "none", reason: "dispatch is in progress" }
      : {
          category: "infrastructure",
          reason:
            `item is running but queue lock is ${queueLockState}; ` +
            "reconcile it in the foreground",
        };
  }

  const reason =
    item.reason ??
    run?.tasks.find((task) => !task.accepted && task.reason)?.reason ??
    null;
  if (item.attempts >= item.maxAttempts) {
    return {
      category: "policy",
      reason: reason ?? `attempt limit ${item.attempts}/${item.maxAttempts}`,
    };
  }
  // Durable category first: a structured failure is authoritative for display.
  // The queue item's failure is only used when no RunManifest exists.
  const durableFailure = durableFailureFor(item, run);
  if (durableFailure) {
    return {
      category: decisionCategoryForFailure(durableFailure),
      reason: reason ?? durableFailure.message,
    };
  }
  const lower = (reason ?? "").toLowerCase();
  if (
    lower.includes("dependenc") ||
    lower.includes("upstream") ||
    lower.includes("not completed")
  ) {
    return { category: "dependency", reason };
  }
  if (
    lower.includes("verif") ||
    lower.includes("reject") ||
    lower.includes("test")
  ) {
    return { category: "verifier", reason };
  }
  if (
    lower.includes("provider") ||
    lower.includes("timeout") ||
    lower.includes("budget") ||
    lower.includes("auth") ||
    lower.includes("429") ||
    lower.includes("network") ||
    lower.includes("manifest")
  ) {
    return { category: "infrastructure", reason };
  }
  return { category: "human", reason };
}

/**
 * RunManifest authority wins whenever a run exists. A QueueItem failure is
 * only consulted for a deterministic pre-dispatch block with no run.
 */
function durableFailureFor(
  item: QueueItem,
  run: ControlRunSnapshot | null,
): FailureRecord | undefined {
  if (run) {
    const task = run.tasks.find(
      (candidate) => !candidate.accepted && candidate.failure !== undefined,
    );
    return task?.failure;
  }
  return item.failure;
}

function decisionCategoryForFailure(
  failure: FailureRecord,
): ControlDecisionCategory {
  switch (failure.category) {
    case "policy_blocked":
      return failure.code === "dependency_blocked" ? "dependency" : "policy";
    case "verifier_rejected":
      return "verifier";
    case "unknown":
      return "human";
    default:
      return "infrastructure";
  }
}

function controlExecution(item: QueueItem): ControlExecutionSnapshot {
  const profile = item.executionProfile;
  return {
    frozen: profile !== undefined,
    profileId: profile?.profileId ?? null,
    runtimeId: profile?.runtimeId ?? item.worker,
    modelId: profile?.modelId ?? item.model ?? null,
    providerId: profile?.providerId ?? null,
    endpointRef: profile?.endpointRef ?? null,
    accountBindingId: profile?.accountBindingId ?? null,
    capabilities: profile?.capabilities
      ? Object.freeze({ ...profile.capabilities })
      : null,
    continuation: summarizeQueueContinuationPolicy(
      item.continuationPolicy,
    ),
    policyCheck: checkExecutionPolicyCompatibility(
      profile,
      item.continuationPolicy,
    ),
  };
}

function cloneQueueItem(item: QueueItem): QueueItem {
  return {
    ...item,
    dependsOn: [...item.dependsOn],
    runIds: [...item.runIds],
    ...(item.executionProfile !== undefined
      ? {
          executionProfile: Object.freeze({
            ...item.executionProfile,
            capabilities: Object.freeze({
              ...item.executionProfile.capabilities,
            }),
          }),
        }
      : {}),
    ...(item.continuationPolicy !== undefined
      ? {
          continuationPolicy: Object.freeze({
            version: item.continuationPolicy.version,
            ...(item.continuationPolicy.deadlineExtension
              ? {
                  deadlineExtension: Object.freeze({
                    ...item.continuationPolicy.deadlineExtension,
                  }),
                }
              : {}),
            ...(item.continuationPolicy.budgetContinuation
              ? {
                  budgetContinuation: Object.freeze({
                    ...item.continuationPolicy.budgetContinuation,
                  }),
                }
              : {}),
          }),
        }
      : {}),
    ...(item.materialization !== undefined
      ? { materialization: { ...item.materialization } }
      : {}),
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Small helper used by human-readable CLI output. */
export function latestWorkerProgress(
  run: ControlRunSnapshot | null,
): WorkerProgressStatus | undefined {
  if (!run || run.workerProgress.length === 0) return undefined;
  return [...run.workerProgress].sort(
    (left, right) =>
      Date.parse(right.event.at) - Date.parse(left.event.at) ||
      left.taskId.localeCompare(right.taskId),
  )[0];
}

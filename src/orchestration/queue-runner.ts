/**
 * Foreground orchestration queue runner
 * (design/durable-orchestration-v0.md).
 *
 * One invocation takes the queue lock, reconciles any stale `running` items
 * against their RunManifest, then dispatches ready items one at a time through
 * the existing Supervisor CLI. Dispatch is strictly sequential.
 *
 * The queue persists `running` and increments `attempts` *before* calling the
 * supervisor. The RunManifest remains the task-level authority: the queue
 * only reads it to classify an outcome and never rewrites it.
 */
import { resolve } from "node:path";
import { runSupervisorCli } from "../supervisor/cli.js";
import {
  getActiveRunId,
  isProcessAlive,
  isSameHost,
  loadRunManifest,
} from "../supervisor/store.js";
import type { RunManifest, RunStatus } from "../supervisor/types.js";
import {
  checkQueueContracts,
  loadQueue,
  queueCounts,
  QueueValidationError,
  saveQueue,
  withQueueLockWait,
  type QueueDocument,
  type QueueItem,
  type QueueItemStatus,
  type QueueNextAction,
  type QueueCounts,
} from "./queue-store.js";

export interface QueueSupervisorRequest {
  repoRoot: string;
  /** Snapshot of the persisted `running` item, after attempts increment. */
  item: QueueItem;
  action: QueueNextAction;
  /** Run id to resume; present only when action is `resume`. */
  runId?: string;
  log?: (line: string) => void;
}

export interface QueueSupervisorResult {
  exitCode: number;
  runId?: string;
  /** Manifest status when known. Completion requires `completed`. */
  status?: RunStatus;
  reason?: string;
}

/**
 * Test/embedding seam. The default implementation calls the existing
 * `runSupervisorCli` and reads the resulting RunManifest.
 */
export type QueueSupervisorRunner = (
  request: QueueSupervisorRequest,
) => QueueSupervisorResult | Promise<QueueSupervisorResult>;

export interface QueueDispatchRecord {
  id: string;
  action: QueueNextAction;
  runId?: string;
  exitCode: number;
  status: "completed" | "blocked";
  reason?: string;
}

export interface QueueReconcileRecord {
  id: string;
  from: "running";
  to: QueueItemStatus;
  runId?: string;
  reason?: string;
}

export interface QueueBlockRecord {
  id: string;
  reason: string;
}

export type QueueStopReason =
  | "idle"
  | "no-ready"
  | "blocked"
  | "max-dispatches";

export interface QueueRunSummary {
  version: 1;
  repoRoot: string;
  startedAt: string;
  finishedAt: string;
  continueOnBlocked: boolean;
  maxDispatches: number | null;
  dispatches: QueueDispatchRecord[];
  reconciled: QueueReconcileRecord[];
  propagated: QueueBlockRecord[];
  dispatched: number;
  counts: QueueCounts;
  items: QueueItem[];
  stopped: QueueStopReason;
  reason?: string;
}

export interface QueueRunOptions {
  /** Keep independent work moving after a block; dependants become blocked. */
  continueOnBlocked?: boolean;
  /** Bound dispatches in one foreground invocation. */
  maxDispatches?: number;
  /** Defaults to the Supervisor CLI runner. */
  runner?: QueueSupervisorRunner;
  /** Lock wait for a live same-host queue owner. Defaults to 5000 ms. */
  lockTimeoutMs?: number;
  lockPollMs?: number;
  /** Optional foreground progress sink (the CLI passes its human log here). */
  log?: (line: string) => void;
}

// ---------------------------------------------------------------------------
// Default Supervisor runner
// ---------------------------------------------------------------------------

/**
 * Drive one queue item through the existing Supervisor CLI:
 * `start` for a new item, `resume --retry-rejected` for an existing run.
 * Supervisor failures are returned (not thrown) with whatever run evidence is
 * durable so the queue can persist an exact blocked reason.
 */
export function createQueueSupervisorRunner(): QueueSupervisorRunner {
  return async (request) => {
    const { repoRoot, item, action } = request;
    const resumeRunId =
      action === "resume" ? (request.runId ?? item.lastRunId) : undefined;
    if (action === "resume" && !resumeRunId) {
      return {
        exitCode: 1,
        reason:
          `cannot resume queue item ${JSON.stringify(item.id)}: ` +
          "no run id is recorded",
      };
    }

    const args: string[] =
      action === "resume"
        ? [
            "resume",
            "--repo",
            repoRoot,
            "--run",
            resumeRunId!,
            "--worker",
            item.worker,
            "--retry-rejected",
          ]
        : ["start", item.contractsPath, "--repo", repoRoot, "--worker", item.worker];
    if (item.model) args.push("--model", item.model);
    if (action === "start" && item.planId) {
      args.push("--plan-id", item.planId);
    }

    const activeBefore =
      action === "start" ? getActiveRunId(repoRoot) : undefined;
    const lines: string[] = [];
    let exitCode = 1;
    let failure: string | undefined;
    try {
      exitCode = await runSupervisorCli(args, {
        log: (line) => lines.push(line),
      });
    } catch (error) {
      failure = errorMessage(error);
    }

    let runId = resumeRunId;
    if (!runId) {
      runId = readSummaryRunId(lines.join("\n"));
      if (!runId) {
        // A failed start may still have created a manifest before throwing.
        const activeAfter = getActiveRunId(repoRoot);
        if (activeAfter && activeAfter !== activeBefore) runId = activeAfter;
      }
    }

    let manifest: RunManifest | undefined;
    if (runId) {
      try {
        manifest = loadRunManifest(repoRoot, runId);
      } catch (error) {
        if (!failure) {
          failure =
            `run manifest ${runId} is unreadable: ${errorMessage(error)}`;
        }
      }
      if (
        manifest !== undefined &&
        (manifest.contractsHash !== item.contractsHash ||
          resolve(manifest.contractsPath) !== resolve(item.contractsPath))
      ) {
        // An active-pointer fallback can race a concurrent run. Never let a
        // manifest for different frozen contracts classify this item.
        if (!failure) {
          failure =
            `run ${runId} evidence does not match the item's frozen contracts`;
        }
        manifest = undefined;
      }
    }

    let reason = failure;
    if (!reason && manifest && manifest.status !== "completed") {
      reason = describeManifestFailure(manifest);
    }
    if (!reason && !manifest && exitCode === 0) {
      reason = "supervisor exited 0 without a readable RunManifest";
    }

    return {
      exitCode,
      ...(runId !== undefined ? { runId } : {}),
      ...(manifest !== undefined ? { status: manifest.status } : {}),
      ...(reason !== undefined ? { reason } : {}),
    };
  };
}

export const defaultQueueSupervisorRunner: QueueSupervisorRunner =
  createQueueSupervisorRunner();

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

export async function runQueue(
  repoRootInput: string,
  options: QueueRunOptions = {},
): Promise<QueueRunSummary> {
  const repoRoot = resolve(repoRootInput);
  if (
    options.maxDispatches !== undefined &&
    (!Number.isInteger(options.maxDispatches) || options.maxDispatches < 1)
  ) {
    throw new QueueValidationError(
      "--max-dispatches must be a positive integer",
    );
  }
  const continueOnBlocked = options.continueOnBlocked === true;
  const runner = options.runner ?? defaultQueueSupervisorRunner;
  const log = options.log ?? (() => undefined);
  const startedAt = now();

  return withQueueLockWait(
    repoRoot,
    async () => {
      const document = loadQueue(repoRoot);
      const reconciled = reconcileRunningItems(repoRoot, document);
      if (reconciled.length > 0) saveQueue(repoRoot, document);

      const propagated: QueueBlockRecord[] = [];
      if (continueOnBlocked) {
        const newlyBlocked = propagateBlockedDependants(document);
        if (newlyBlocked.length > 0) {
          propagated.push(...newlyBlocked);
          saveQueue(repoRoot, document);
        }
      }

      const dispatches: QueueDispatchRecord[] = [];
      let stopped: QueueStopReason = "idle";
      let stopReason: string | undefined;

      for (;;) {
        const ordered = dependencyOrder(document.items);
        const byId = new Map(document.items.map((item) => [item.id, item]));
        const candidateIndex = ordered.findIndex((item) =>
          isReady(item, byId),
        );
        // Default mode stops at the first blocked item in queue order. A
        // ready item that precedes it may still dispatch; nothing behind it
        // does. `--continue-on-blocked` skips this gate.
        const blockedIndex = ordered.findIndex(
          (item) => item.status === "blocked",
        );
        if (
          !continueOnBlocked &&
          blockedIndex >= 0 &&
          (candidateIndex < 0 || blockedIndex < candidateIndex)
        ) {
          const blocked = ordered[blockedIndex]!;
          stopped = "blocked";
          stopReason =
            `item ${JSON.stringify(blocked.id)} is blocked` +
            (blocked.reason ? `: ${blocked.reason}` : "");
          break;
        }

        const candidate =
          candidateIndex >= 0 ? ordered[candidateIndex]! : undefined;
        if (!candidate) {
          stopped = document.items.some((item) => item.status === "pending")
            ? "no-ready"
            : "idle";
          break;
        }
        // Only report the bound when it actually withholds dispatchable work.
        if (
          options.maxDispatches !== undefined &&
          dispatches.length >= options.maxDispatches
        ) {
          stopped = "max-dispatches";
          stopReason = `max dispatches reached (${options.maxDispatches})`;
          break;
        }

        const blockedReason = preDispatchBlockReason(candidate);
        if (blockedReason) {
          blockItem(document, candidate, blockedReason);
          saveQueue(repoRoot, document);
          log(`blocked ${candidate.id}: ${blockedReason}`);
          if (!continueOnBlocked) {
            stopped = "blocked";
            stopReason = `item ${JSON.stringify(candidate.id)} blocked: ${blockedReason}`;
            break;
          }
          propagated.push(...propagateBlockedDependants(document));
          saveQueue(repoRoot, document);
          continue;
        }

        log(
          `dispatch ${candidate.id}: ${candidate.nextAction}` +
            (candidate.nextAction === "resume"
              ? ` run ${candidate.lastRunId}`
              : ` ${candidate.contractsPath}`),
        );
        const record = await dispatchItem(
          repoRoot,
          document,
          candidate,
          runner,
        );
        dispatches.push(record);
        if (record.status === "completed") {
          log(`completed ${candidate.id}: run ${record.runId ?? "-"}`);
        } else {
          log(
            `blocked ${candidate.id}: ` +
              `${record.reason ?? "supervisor dispatch failed"}`,
          );
        }

        if (record.status === "blocked") {
          if (!continueOnBlocked) {
            stopped = "blocked";
            stopReason =
              `item ${JSON.stringify(candidate.id)} blocked: ` +
              `${record.reason ?? "supervisor dispatch failed"}`;
            break;
          }
          const newlyBlocked = propagateBlockedDependants(document);
          if (newlyBlocked.length > 0) {
            propagated.push(...newlyBlocked);
            saveQueue(repoRoot, document);
          }
        }
      }

      return buildSummary({
        repoRoot,
        document,
        startedAt,
        options,
        dispatches,
        reconciled,
        propagated,
        stopped,
        ...(stopReason !== undefined ? { reason: stopReason } : {}),
      });
    },
    {
      ...(options.lockTimeoutMs !== undefined
        ? { timeoutMs: options.lockTimeoutMs }
        : {}),
      ...(options.lockPollMs !== undefined ? { pollMs: options.lockPollMs } : {}),
    },
  );
}

/**
 * Dependency order that preserves queue insertion order while placing every
 * dependency before its dependants.
 */
export function dependencyOrder(items: QueueItem[]): QueueItem[] {
  const byId = new Map(items.map((item) => [item.id, item]));
  const visited = new Set<string>();
  const visiting = new Set<string>();
  const ordered: QueueItem[] = [];

  const visit = (item: QueueItem): void => {
    if (visited.has(item.id)) return;
    if (visiting.has(item.id)) {
      throw new QueueValidationError(
        `queue dependency cycle at ${JSON.stringify(item.id)}`,
      );
    }
    visiting.add(item.id);
    for (const dependency of item.dependsOn) {
      const target = byId.get(dependency);
      if (!target) {
        throw new QueueValidationError(
          `queue item ${JSON.stringify(item.id)} depends on unknown item ` +
            JSON.stringify(dependency),
        );
      }
      visit(target);
    }
    visiting.delete(item.id);
    visited.add(item.id);
    ordered.push(item);
  };

  for (const item of items) visit(item);
  return ordered;
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

async function dispatchItem(
  repoRoot: string,
  document: QueueDocument,
  item: QueueItem,
  runner: QueueSupervisorRunner,
): Promise<QueueDispatchRecord> {
  const action = item.nextAction;
  const resumeRunId = action === "resume" ? item.lastRunId : undefined;

  // Persist running and the attempt before any supervisor work can start.
  const startedAt = now();
  item.status = "running";
  item.attempts += 1;
  delete item.reason;
  item.updatedAt = startedAt;
  document.updatedAt = startedAt;
  saveQueue(repoRoot, document);

  const snapshot: QueueItem = {
    ...item,
    dependsOn: [...item.dependsOn],
    runIds: [...item.runIds],
  };

  let result: QueueSupervisorResult;
  try {
    result = await runner({
      repoRoot,
      item: snapshot,
      action,
      ...(resumeRunId !== undefined ? { runId: resumeRunId } : {}),
    });
  } catch (error) {
    result = {
      exitCode: 1,
      ...(resumeRunId !== undefined ? { runId: resumeRunId } : {}),
      reason: `supervisor runner failed: ${errorMessage(error)}`,
    };
  }

  const runId = result.runId ?? resumeRunId;
  if (runId) {
    item.lastRunId = runId;
    if (!item.runIds.includes(runId)) item.runIds.push(runId);
  }

  let manifestStatus = result.status;
  if (manifestStatus === undefined && runId) {
    try {
      manifestStatus = loadRunManifest(repoRoot, runId).status;
    } catch {
      /* reported as missing/ambiguous evidence below */
    }
  }

  const completed =
    result.exitCode === 0 && manifestStatus === "completed";
  const finishedAt = now();
  if (completed) {
    item.status = "completed";
    delete item.reason;
  } else {
    item.status = "blocked";
    item.reason =
      result.reason ??
      describeFailedDispatch(result.exitCode, manifestStatus, runId);
  }
  item.nextAction = item.lastRunId ? "resume" : "start";
  item.updatedAt = finishedAt;
  document.updatedAt = finishedAt;
  saveQueue(repoRoot, document);

  return {
    id: item.id,
    action,
    ...(runId !== undefined ? { runId } : {}),
    exitCode: result.exitCode,
    status: item.status as "completed" | "blocked",
    ...(item.reason !== undefined ? { reason: item.reason } : {}),
  };
}

function preDispatchBlockReason(item: QueueItem): string | undefined {
  if (item.nextAction === "resume" && !item.lastRunId) {
    return "nextAction is resume but no run id is recorded";
  }
  if (item.attempts >= item.maxAttempts) {
    return `attempt limit reached (${item.attempts}/${item.maxAttempts})`;
  }
  const contracts = checkQueueContracts(item);
  if (!contracts.ok) {
    return contracts.reason ?? "frozen contracts check failed";
  }
  return undefined;
}

function isReady(
  item: QueueItem,
  byId: ReadonlyMap<string, QueueItem>,
): boolean {
  if (item.status !== "pending") return false;
  return item.dependsOn.every(
    (dependency) => byId.get(dependency)?.status === "completed",
  );
}

function blockItem(
  document: QueueDocument,
  item: QueueItem,
  reason: string,
): void {
  const at = now();
  item.status = "blocked";
  item.reason = reason;
  item.nextAction = item.lastRunId ? "resume" : "start";
  item.updatedAt = at;
  document.updatedAt = at;
}

/** Mark pending items whose dependency is blocked/cancelled, transitively. */
function propagateBlockedDependants(
  document: QueueDocument,
): QueueBlockRecord[] {
  const byId = new Map(document.items.map((item) => [item.id, item]));
  const records: QueueBlockRecord[] = [];
  let changed = true;
  while (changed) {
    changed = false;
    for (const item of document.items) {
      if (item.status !== "pending") continue;
      const blocking = item.dependsOn.find((dependency) => {
        const target = byId.get(dependency);
        return (
          target !== undefined &&
          (target.status === "blocked" || target.status === "cancelled")
        );
      });
      if (!blocking) continue;
      const target = byId.get(blocking)!;
      const reason = `dependency ${JSON.stringify(blocking)} is ${target.status}`;
      blockItem(document, item, reason);
      records.push({ id: item.id, reason });
      changed = true;
    }
  }
  return records;
}

// ---------------------------------------------------------------------------
// Stale running reconciliation
// ---------------------------------------------------------------------------

/**
 * The queue lock proves no queue dispatch is active, so any persisted
 * `running` item belongs to a previous runner that died. Reconcile it against
 * its recorded RunManifest without rewriting that manifest.
 */
function reconcileRunningItems(
  repoRoot: string,
  document: QueueDocument,
): QueueReconcileRecord[] {
  const records: QueueReconcileRecord[] = [];
  for (const item of document.items) {
    if (item.status !== "running") continue;

    const runId =
      item.lastRunId ?? item.runIds[item.runIds.length - 1] ?? undefined;
    // Default is fail-closed; every successful evidence branch reassigns it.
    let to: QueueItemStatus = "blocked";
    let reason: string | undefined;

    if (!runId) {
      to = "blocked";
      reason = "running item has no recorded run id";
    } else {
      let manifest: RunManifest | undefined;
      try {
        manifest = loadRunManifest(repoRoot, runId);
      } catch (error) {
        to = "blocked";
        reason = `cannot reconcile run ${runId}: ${errorMessage(error)}`;
      }
      if (manifest) {
        if (
          manifest.contractsHash !== item.contractsHash ||
          resolve(manifest.contractsPath) !== resolve(item.contractsPath)
        ) {
          to = "blocked";
          reason =
            `run ${runId} evidence does not match the item's frozen ` +
            "contracts";
        } else if (manifest.status === "completed") {
          // Completed is terminal even if stale attempt metadata looks odd.
          to = "completed";
        } else if (item.attempts < 1) {
          to = "blocked";
          reason = "running item has no recorded dispatch attempt";
        } else if (manifest.status === "running") {
          const ownerAlive = isSameHost(manifest.owner.host)
            ? isProcessAlive(manifest.owner.pid)
            : null;
          if (ownerAlive === true) {
            to = "blocked";
            reason =
              `run ${runId} is still owned by a live process ` +
              `(pid ${manifest.owner.pid} on ${manifest.owner.host})`;
          } else if (ownerAlive === null) {
            to = "blocked";
            reason =
              `run ${runId} owner is on ${manifest.owner.host}; ` +
              "liveness cannot be proven from this host";
          } else if (item.attempts >= item.maxAttempts) {
            to = "blocked";
            reason =
              `attempt limit reached (${item.attempts}/${item.maxAttempts}) ` +
              `while recovering interrupted run ${runId}`;
          } else {
            to = "pending";
          }
        } else if (item.attempts >= item.maxAttempts) {
          to = "blocked";
          reason =
            `attempt limit reached (${item.attempts}/${item.maxAttempts}) ` +
            `after run ${runId} ended ${manifest.status}`;
        } else {
          // interrupted or blocked: Supervisor resume can retry non-accepted
          // work, so keep the existing run instead of starting a fresh one.
          to = "pending";
        }
      }
    }

    const at = now();
    item.status = to;
    if (runId) {
      item.lastRunId = runId;
      if (!item.runIds.includes(runId)) item.runIds.push(runId);
    }
    if (to === "completed") {
      item.nextAction = item.lastRunId ? "resume" : "start";
      delete item.reason;
    } else if (to === "pending") {
      item.nextAction = "resume";
      delete item.reason;
    } else {
      item.nextAction = item.lastRunId ? "resume" : "start";
      item.reason =
        reason ?? "stale running item could not be reconciled";
    }
    item.updatedAt = at;
    document.updatedAt = at;
    records.push({
      id: item.id,
      from: "running",
      to,
      ...(runId !== undefined ? { runId } : {}),
      ...(reason !== undefined ? { reason } : {}),
    });
  }
  return records;
}

// ---------------------------------------------------------------------------
// Summary / formatting helpers
// ---------------------------------------------------------------------------

interface BuildSummaryInput {
  repoRoot: string;
  document: QueueDocument;
  startedAt: string;
  options: QueueRunOptions;
  dispatches: QueueDispatchRecord[];
  reconciled: QueueReconcileRecord[];
  propagated: QueueBlockRecord[];
  stopped: QueueStopReason;
  reason?: string;
}

function buildSummary(input: BuildSummaryInput): QueueRunSummary {
  return {
    version: 1,
    repoRoot: input.repoRoot,
    startedAt: input.startedAt,
    finishedAt: now(),
    continueOnBlocked: input.options.continueOnBlocked === true,
    maxDispatches: input.options.maxDispatches ?? null,
    dispatches: input.dispatches,
    reconciled: input.reconciled,
    propagated: input.propagated,
    dispatched: input.dispatches.length,
    counts: queueCounts(input.document),
    items: input.document.items.map((item) => ({
      ...item,
      dependsOn: [...item.dependsOn],
      runIds: [...item.runIds],
    })),
    stopped: input.stopped,
    ...(input.reason !== undefined ? { reason: input.reason } : {}),
  };
}

function describeManifestFailure(manifest: RunManifest): string {
  const tasks = Object.values(manifest.tasks);
  const rejected = tasks.filter(
    (task) => !task.accepted && task.status === "rejected",
  );
  if (manifest.status === "blocked" && rejected.length > 0) {
    const detail = rejected
      .map(
        (task) =>
          `${task.taskId}` + (task.reason ? ` (${task.reason})` : ""),
      )
      .join(", ");
    return `run ${manifest.runId} blocked with rejected task(s): ${detail}`;
  }
  if (manifest.status === "blocked") {
    const blocked = tasks.filter(
      (task) => !task.accepted && task.status === "blocked",
    );
    return (
      `run ${manifest.runId} blocked` +
      (blocked.length > 0
        ? ` (${blocked.map((task) => task.taskId).join(", ")})`
        : "")
    );
  }
  if (manifest.status === "interrupted") {
    return `run ${manifest.runId} interrupted`;
  }
  if (manifest.status === "running") {
    return `run ${manifest.runId} is still running`;
  }
  return `run ${manifest.runId} ended with status ${manifest.status}`;
}

function describeFailedDispatch(
  exitCode: number,
  status: RunStatus | undefined,
  runId: string | undefined,
): string {
  if (status) {
    return `run ${runId ?? "<unknown>"} finished with status ${status}`;
  }
  if (runId) {
    return `run ${runId} has no readable RunManifest`;
  }
  return (
    `supervisor dispatch failed (exit ${exitCode}) ` +
    "without a run manifest"
  );
}

function readSummaryRunId(text: string): string | undefined {
  try {
    const parsed = JSON.parse(text) as unknown;
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      typeof (parsed as Record<string, unknown>).runId === "string"
    ) {
      return (parsed as Record<string, string>).runId;
    }
  } catch {
    /* not the supervisor JSON summary */
  }
  return undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function now(): string {
  return new Date().toISOString();
}

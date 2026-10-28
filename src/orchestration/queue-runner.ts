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
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { runSupervisorCli } from "../supervisor/cli.js";
import {
  getActiveRunId,
  isProcessAlive,
  isSameHost,
  loadRunManifest,
  RunNotFoundError,
} from "../supervisor/store.js";
import type { RunManifest, RunStatus } from "../supervisor/types.js";
import {
  createFailureRecord,
  type CostTruth,
  type FailureRecord,
} from "../failures.js";
import {
  materializePlan,
  type PlanUpstreamEvidence,
} from "./plan-materializer.js";
import {
  checkQueueContracts,
  isPlanBackedQueueItem,
  loadQueue,
  queueCounts,
  queueItemContractsIdentity,
  QueueValidationError,
  saveQueue,
  withQueueLockWait,
  type PlanBackedQueueItem,
  type QueueDocument,
  type QueueItem,
  type QueueItemStatus,
  type QueueNextAction,
  type QueueCounts,
  type QueuePlanMaterialization,
} from "./queue-store.js";
import { tryAppendQueueEvent } from "./event-journal.js";
import {
  continuationPolicyToSupervisorArgs,
  parseQueueContinuationPolicy,
  type QueueContinuationPolicy,
} from "../agents/continuation.js";
import {
  checkExecutionPolicyCompatibility,
  executionProfileEventFields,
  executionProfileMirrorReason,
  parseExecutionProfile,
  type ExecutionPolicyCompatibility,
  type ExecutionProfile,
} from "../execution/profile.js";

export interface QueueSupervisorRequest {
  repoRoot: string;
  /** Snapshot of the persisted `running` item, after attempts increment. */
  item: QueueItem;
  action: QueueNextAction;
  /**
   * Run id to resume; present only when action is `resume`.
   *
   * A start receives its preallocated id in `item.lastRunId`, which is persisted
   * before this request is built. Keeping this field resume-only preserves the
   * existing injected-runner contract.
   */
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

export interface CreateQueueSupervisorRunnerOptions {
  /** Test/embedding seam; defaults to the real Supervisor CLI. */
  runSupervisorCli?: typeof runSupervisorCli;
}

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
export function createQueueSupervisorRunner(
  options: CreateQueueSupervisorRunnerOptions = {},
): QueueSupervisorRunner {
  const runCli = options.runSupervisorCli ?? runSupervisorCli;
  return async (request) => {
    const { repoRoot, item, action } = request;
    const execution = queueItemExecution(item);
    if (!execution.ok) {
      return {
        exitCode: 1,
        reason:
          `cannot dispatch queue item ${JSON.stringify(item.id)}: ` +
          execution.reason,
      };
    }
    const continuationArgs = execution.continuationPolicy
      ? continuationPolicyToSupervisorArgs(execution.continuationPolicy)
      : [];
    const resumeRunId =
      action === "resume" ? (request.runId ?? item.lastRunId) : undefined;
    const startRunId =
      action === "start" ? (item.lastRunId ?? request.runId) : undefined;
    if (action === "resume" && !resumeRunId) {
      return {
        exitCode: 1,
        reason:
          `cannot resume queue item ${JSON.stringify(item.id)}: ` +
          "no run id is recorded",
      };
    }

    const contracts = queueItemContractsIdentity(item);
    if (action === "start" && !contracts) {
      return {
        exitCode: 1,
        reason:
          `cannot start queue item ${JSON.stringify(item.id)}: ` +
          "no frozen contracts identity is recorded",
      };
    }

    const dispatchRunId =
      action === "resume" ? resumeRunId : startRunId;
    const args: string[] =
      action === "resume"
        ? [
            "resume",
            "--repo",
            repoRoot,
            "--run",
            resumeRunId!,
            "--worker",
            execution.worker,
            "--retry-rejected",
          ]
        : [
            "start",
            contracts!.contractsPath,
            "--repo",
            repoRoot,
            ...(startRunId !== undefined
              ? ["--run-id", startRunId]
              : []),
            "--worker",
            execution.worker,
          ];
    if (execution.model !== undefined) {
      args.push("--model", execution.model);
    }
    args.push(...continuationArgs);
    if (action === "start" && item.planId) {
      args.push("--plan-id", item.planId);
    }

    const activeBefore =
      action === "start" && dispatchRunId === undefined
        ? getActiveRunId(repoRoot)
        : undefined;
    const lines: string[] = [];
    let exitCode = 1;
    let failure: string | undefined;
    try {
      exitCode = await runCli(args, {
        log: (line) => lines.push(line),
      });
    } catch (error) {
      failure = errorMessage(error);
    }

    let runId = dispatchRunId;
    if (!runId) {
      runId = readSummaryRunId(lines.join("\n"));
      if (!runId) {
        // This fallback exists only for callers that do not provide the
        // preallocated id. With an explicit id, active.json is never used.
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
      if (manifest !== undefined) {
        const mismatch =
          contracts === undefined ||
          manifest.contractsHash !== contracts.contractsHash ||
          resolve(manifest.contractsPath) !==
            resolve(contracts.contractsPath);
        if (mismatch) {
          // An active-pointer fallback can race a concurrent run. Never let a
          // manifest for different frozen contracts classify this item.
          if (!failure) {
            failure =
              `run ${runId} evidence does not match the item's frozen contracts`;
          }
          manifest = undefined;
        }
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
      if (reconciled.length > 0) {
        saveQueue(repoRoot, document);
        for (const record of reconciled) {
          tryAppendQueueEvent(repoRoot, {
            type: "queue.item.reconciled",
            itemId: record.id,
            ...(record.runId !== undefined ? { runId: record.runId } : {}),
            status: record.to,
            ...(record.reason !== undefined ? { reason: record.reason } : {}),
          });
        }
      }

      const propagated: QueueBlockRecord[] = [];
      if (continueOnBlocked) {
        const newlyBlocked = propagateBlockedDependants(document);
        if (newlyBlocked.length > 0) {
          propagated.push(...newlyBlocked);
          saveQueue(repoRoot, document);
          journalPropagatedBlocks(repoRoot, document, newlyBlocked);
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

        const preDispatch = preDispatchBlockReason(candidate);
        let blockedReason = preDispatch?.reason;
        let blockedCode = preDispatch?.code;
        if (!blockedReason && isPlanBackedQueueItem(candidate)) {
          // Plan materialization is queue work, not Supervisor work: it must
          // finish and be durable before any attempt increment or start.
          blockedReason = preparePlanDispatch(
            repoRoot,
            document,
            candidate,
            byId,
            log,
          );
          if (blockedReason) blockedCode = "plan_materialization_failed";
        }
        if (blockedReason) {
          blockItem(
            document,
            candidate,
            blockedReason,
            blockedCode ?? "pre_dispatch_blocked",
          );
          saveQueue(repoRoot, document);
          tryAppendQueueEvent(repoRoot, {
            type: "run.blocked",
            itemId: candidate.id,
            ...(candidate.lastRunId !== undefined
              ? { runId: candidate.lastRunId }
              : {}),
            attempt: candidate.attempts,
            status: candidate.status,
            reason: blockedReason,
            ...executionProfileEventFields(
              candidate.executionProfile,
              candidate.continuationPolicy,
            ),
            // Queue-item failure is authority only because no run exists.
            ...failureEventFields(candidate.failure),
          });
          log(`blocked ${candidate.id}: ${blockedReason}`);
          if (!continueOnBlocked) {
            stopped = "blocked";
            stopReason = `item ${JSON.stringify(candidate.id)} blocked: ${blockedReason}`;
            break;
          }
          const newlyBlocked = propagateBlockedDependants(document);
          if (newlyBlocked.length > 0) {
            propagated.push(...newlyBlocked);
            saveQueue(repoRoot, document);
            journalPropagatedBlocks(repoRoot, document, newlyBlocked);
          }
          continue;
        }

        log(
          `dispatch ${candidate.id}: ${candidate.nextAction}` +
            (candidate.nextAction === "resume"
              ? ` run ${candidate.lastRunId}`
              : isPlanBackedQueueItem(candidate)
                ? ""
                : ` ${candidate.contractsPath}`) +
            (isPlanBackedQueueItem(candidate)
              ? ` ${planLineage(candidate)}`
              : ""),
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
            journalPropagatedBlocks(repoRoot, document, newlyBlocked);
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

type QueueItemExecution =
  | {
      ok: true;
      worker: QueueItem["worker"];
      model?: string;
      profile?: ExecutionProfile;
      continuationPolicy?: QueueContinuationPolicy;
    }
  | {
      ok: false;
      code: string;
      reason: string;
    };

/**
 * Pure read-only validation shared by the pre-dispatch gate and the concrete
 * Supervisor runner. No field is inferred from the current environment.
 */
export function checkQueueItemExecutionPolicy(
  item: QueueItem,
): ExecutionPolicyCompatibility {
  const execution = queueItemExecution(item);
  return execution.ok
    ? { ok: true }
    : { ok: false, code: execution.code, reason: execution.reason };
}

function queueItemExecution(item: QueueItem): QueueItemExecution {
  if (item.executionProfile === undefined) {
    if (item.continuationPolicy !== undefined) {
      return {
        ok: false,
        code: "execution_profile_required",
        reason: "continuationPolicy requires a frozen executionProfile",
      };
    }
    return {
      ok: true,
      worker: item.worker,
      ...(item.model !== undefined ? { model: item.model } : {}),
    };
  }

  const profile = parseExecutionProfile(item.executionProfile);
  if (!profile) {
    return {
      ok: false,
      code: "invalid_execution_profile",
      reason: "executionProfile is not a valid, secret-free v1 profile",
    };
  }
  const mirrorReason = executionProfileMirrorReason(
    profile,
    item.worker,
    item.model,
  );
  if (mirrorReason !== undefined) {
    return {
      ok: false,
      code: "execution_profile_mismatch",
      reason: mirrorReason,
    };
  }

  let continuationPolicy: QueueContinuationPolicy | undefined;
  if (item.continuationPolicy !== undefined) {
    continuationPolicy = parseQueueContinuationPolicy(
      item.continuationPolicy,
    );
    if (!continuationPolicy) {
      return {
        ok: false,
        code: "invalid_continuation_policy",
        reason: "continuationPolicy is not a valid, secret-free v1 policy",
      };
    }
  }
  const compatibility = checkExecutionPolicyCompatibility(
    profile,
    continuationPolicy,
  );
  if (!compatibility.ok) {
    return {
      ok: false,
      code: compatibility.code ?? "policy_capability_mismatch",
      reason: compatibility.reason ?? "execution profile is incompatible",
    };
  }
  return {
    ok: true,
    worker: profile.runtimeId,
    model: profile.modelId,
    profile,
    ...(continuationPolicy !== undefined ? { continuationPolicy } : {}),
  };
}

async function dispatchItem(
  repoRoot: string,
  document: QueueDocument,
  item: QueueItem,
  runner: QueueSupervisorRunner,
): Promise<QueueDispatchRecord> {
  const action = item.nextAction;
  const resumeRunId = action === "resume" ? item.lastRunId : undefined;
  const assignedRunId = resumeRunId ?? randomUUID();
  let assignedManifestExisted = false;
  if (action === "start") {
    try {
      loadRunManifest(repoRoot, assignedRunId);
      assignedManifestExisted = true;
    } catch {
      /* a new id normally has no manifest */
    }
  }

  // Persist the exact run binding, running state and attempt before any
  // supervisor work can start. A crash from here leaves an explicit id that
  // the next invocation can reconcile against its RunManifest.
  const startedAt = now();
  item.status = "running";
  item.attempts += 1;
  item.lastRunId = assignedRunId;
  if (!item.runIds.includes(assignedRunId)) item.runIds.push(assignedRunId);
  delete item.reason;
  // From here on the RunManifest is the task authority; the queue never
  // duplicates or overrides a dispatched run's failure.
  delete item.failure;
  item.updatedAt = startedAt;
  document.updatedAt = startedAt;
  saveQueue(repoRoot, document);
  tryAppendQueueEvent(repoRoot, {
    type: "attempt.started",
    at: startedAt,
    itemId: item.id,
    runId: assignedRunId,
    attempt: item.attempts,
    action,
    status: item.status,
    ...executionProfileEventFields(
      item.executionProfile,
      item.continuationPolicy,
    ),
  });
  tryAppendQueueEvent(repoRoot, {
    type: action === "resume" ? "run.resumed" : "run.started",
    at: startedAt,
    itemId: item.id,
    runId: assignedRunId,
    attempt: item.attempts,
    action,
    ...executionProfileEventFields(
      item.executionProfile,
      item.continuationPolicy,
    ),
  });

  const snapshot: QueueItem = {
    ...item,
    dependsOn: [...item.dependsOn],
    runIds: [...item.runIds],
    ...(item.materialization !== undefined
      ? { materialization: { ...item.materialization } }
      : {}),
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
      runId: assignedRunId,
      reason: `supervisor runner failed: ${errorMessage(error)}`,
    };
  }

  // The manifest is read-only evidence for classification and journal
  // observations; the queue never rewrites it and never becomes its authority.
  let runId: string | undefined = assignedRunId;
  let manifest: RunManifest | undefined;
  let assignedManifestError: unknown;
  try {
    manifest = loadRunManifest(repoRoot, assignedRunId);
  } catch (error) {
    assignedManifestError = error;
  }
  const assignedManifestMissing =
    assignedManifestError instanceof RunNotFoundError;

  let startBindingDiscard: "collision" | "missing-manifest" | undefined;
  if (action === "start" && assignedManifestExisted) {
    startBindingDiscard = "collision";
    clearRunBinding(item, assignedRunId);
    runId = undefined;
    manifest = undefined;
  }

  // Compatibility for an injected runner that predates --run-id and reports
  // a different id explicitly. Real queue dispatch always uses assignedRunId.
  if (
    startBindingDiscard === undefined &&
    action === "start" &&
    assignedManifestMissing &&
    manifest === undefined &&
    result.runId !== undefined &&
    result.runId !== assignedRunId
  ) {
    clearRunBinding(item, assignedRunId);
    runId = result.runId;
    try {
      manifest = loadRunManifest(repoRoot, runId);
    } catch {
      /* classified below */
    }
  }

  // A start that did not create its preallocated manifest never established
  // run authority. Remove the speculative binding so retry is a new start.
  if (
    startBindingDiscard === undefined &&
    action === "start" &&
    assignedManifestMissing &&
    manifest === undefined &&
    runId === assignedRunId
  ) {
    clearRunBinding(item, assignedRunId);
    runId = undefined;
    startBindingDiscard = "missing-manifest";
  } else if (runId) {
    item.lastRunId = runId;
    if (!item.runIds.includes(runId)) item.runIds.push(runId);
  }

  const manifestStatus = startBindingDiscard !== undefined
    ? undefined
    : (result.status ?? manifest?.status);

  const completed =
    result.exitCode === 0 && manifestStatus === "completed";
  const finishedAt = now();
  if (completed) {
    item.status = "completed";
    delete item.reason;
  } else {
    item.status = "blocked";
    let reason = result.reason;
    if (!reason) {
      if (startBindingDiscard === "collision") {
        reason =
          "preallocated run id already had a manifest; retry from start";
      } else if (
        startBindingDiscard === "missing-manifest" &&
        manifest === undefined &&
        runId === undefined &&
        result.exitCode === 0
      ) {
        reason =
          "supervisor exited 0 without creating its preallocated RunManifest";
      } else {
        reason = describeFailedDispatch(
          result.exitCode,
          manifestStatus,
          runId,
        );
      }
    }
    item.reason = reason;
  }
  item.nextAction = item.lastRunId ? "resume" : "start";
  item.updatedAt = finishedAt;
  document.updatedAt = finishedAt;
  saveQueue(repoRoot, document);
  const blockedEvidence = completed ? {} : manifestFailureEvidence(manifest);
  tryAppendQueueEvent(repoRoot, {
    type: completed ? "run.completed" : "run.blocked",
    at: finishedAt,
    itemId: item.id,
    ...(runId !== undefined ? { runId } : {}),
    attempt: item.attempts,
    action,
    status: item.status,
    ...executionProfileEventFields(
      item.executionProfile,
      item.continuationPolicy,
    ),
    ...(item.reason !== undefined ? { reason: item.reason } : {}),
    ...(completed
      ? {}
      : failureEventFields(blockedEvidence.failure, blockedEvidence.cost)),
  });

  return {
    id: item.id,
    action,
    ...(runId !== undefined ? { runId } : {}),
    exitCode: result.exitCode,
    status: item.status as "completed" | "blocked",
    ...(item.reason !== undefined ? { reason: item.reason } : {}),
  };
}

function clearRunBinding(item: QueueItem, runId: string): void {
  if (item.lastRunId === runId) delete item.lastRunId;
  item.runIds = item.runIds.filter((candidate) => candidate !== runId);
}

interface PreDispatchBlock {
  reason: string;
  code: string;
}

function preDispatchBlockReason(
  item: QueueItem,
): PreDispatchBlock | undefined {
  if (item.nextAction === "resume" && !item.lastRunId) {
    return {
      reason: "nextAction is resume but no run id is recorded",
      code: "resume_without_run_id",
    };
  }
  if (item.attempts >= item.maxAttempts) {
    return {
      reason: `attempt limit reached (${item.attempts}/${item.maxAttempts})`,
      code: "attempt_limit_reached",
    };
  }
  const executionPolicy = checkQueueItemExecutionPolicy(item);
  if (!executionPolicy.ok) {
    return {
      reason:
        executionPolicy.reason ?? "execution profile policy is incompatible",
      code: executionPolicy.code ?? "policy_capability_mismatch",
    };
  }
  // Plan items have no top-level contracts identity; their recorded
  // materialization is verified (or created) by preparePlanDispatch.
  if (isPlanBackedQueueItem(item)) return undefined;
  const contracts = checkQueueContracts(item);
  if (!contracts.ok) {
    return {
      reason: contracts.reason ?? "frozen contracts check failed",
      code: "contracts_mismatch",
    };
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

/**
 * Block before any dispatch. Only this deterministic path stores a
 * QueueItem failure: no RunManifest exists to carry the observation, and the
 * RunManifest stays the authority for every dispatched run.
 */
function blockItem(
  document: QueueDocument,
  item: QueueItem,
  reason: string,
  failureCode: string,
): void {
  const at = now();
  item.status = "blocked";
  item.reason = reason;
  item.failure = createFailureRecord({
    policyBlocked: true,
    stage: "policy",
    code: failureCode,
    messageDetail: reason,
    observedAt: at,
  });
  item.nextAction = item.lastRunId ? "resume" : "start";
  item.updatedAt = at;
  document.updatedAt = at;
}

/**
 * Primary durable failure evidence from a dispatched run's manifest. Tasks are
 * ordered by id so the observed journal fields are deterministic.
 */
function manifestFailureEvidence(manifest: RunManifest | undefined): {
  failure?: FailureRecord;
  cost?: CostTruth;
} {
  if (!manifest) return {};
  const tasks = Object.values(manifest.tasks).sort((left, right) =>
    left.taskId.localeCompare(right.taskId),
  );
  const failed = tasks.find(
    (task) => !task.accepted && task.failure !== undefined,
  );
  if (failed?.failure) {
    return {
      failure: failed.failure,
      ...(failed.cost !== undefined ? { cost: failed.cost } : {}),
    };
  }
  const withCost = tasks.find(
    (task) => !task.accepted && task.cost !== undefined,
  );
  return withCost?.cost !== undefined ? { cost: withCost.cost } : {};
}

/** Bounded observations allowed on a `run.blocked` event. */
function failureEventFields(
  failure?: FailureRecord,
  cost?: CostTruth,
): {
  failureCategory?: FailureRecord["category"];
  failureStage?: FailureRecord["stage"];
  failureCode?: string;
  costState?: CostTruth["state"];
} {
  return {
    ...(failure !== undefined
      ? {
          failureCategory: failure.category,
          failureStage: failure.stage,
          ...(failure.code !== undefined ? { failureCode: failure.code } : {}),
        }
      : {}),
    ...(cost !== undefined ? { costState: cost.state } : {}),
  };
}

function journalPropagatedBlocks(
  repoRoot: string,
  document: QueueDocument,
  records: QueueBlockRecord[],
): void {
  const byId = new Map(document.items.map((item) => [item.id, item]));
  for (const record of records) {
    // The failure is read from the durable item, never synthesized here.
    tryAppendQueueEvent(repoRoot, {
      type: "run.blocked",
      itemId: record.id,
      reason: record.reason,
      ...executionProfileEventFields(
        byId.get(record.id)?.executionProfile,
        byId.get(record.id)?.continuationPolicy,
      ),
      ...failureEventFields(byId.get(record.id)?.failure),
    });
  }
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
      blockItem(document, item, reason, "dependency_blocked");
      records.push({ id: item.id, reason });
      changed = true;
    }
  }
  return records;
}

// ---------------------------------------------------------------------------
// Plan-backed materialization
// ---------------------------------------------------------------------------

/**
 * Materialize a new attempt chain or byte-verify the recorded one. This runs
 * before `dispatchItem`, so any failure blocks with no attempt increment and no
 * Supervisor call. Returns the exact blocked reason instead of throwing.
 */
function preparePlanDispatch(
  repoRoot: string,
  document: QueueDocument,
  item: PlanBackedQueueItem,
  byId: ReadonlyMap<string, QueueItem>,
  log: (line: string) => void,
): string | undefined {
  if (item.materialization) {
    try {
      verifyRecordedPlanMaterialization(repoRoot, item, byId);
      if (item.nextAction === "resume") {
        const runId = item.lastRunId;
        if (!runId) {
          throw new Error("nextAction is resume but no run id is recorded");
        }
        verifyPlanRunManifest(repoRoot, item, item.materialization, runId);
      }
    } catch (error) {
      return (
        `plan materialization verification failed: ${errorMessage(error)}`
      );
    }
    log(`reused materialization ${item.id}: ${planLineage(item)}`);
    return undefined;
  }

  if (item.nextAction === "resume" || item.lastRunId !== undefined) {
    // Never substitute freshly compiled contracts under a resumable run.
    return (
      `plan materialization failed: cannot resume queue item ` +
      `${JSON.stringify(item.id)}: no plan materialization is recorded`
    );
  }

  let materialization: QueuePlanMaterialization;
  try {
    materialization = createPlanMaterialization(repoRoot, item, byId);
  } catch (error) {
    return `plan materialization failed: ${errorMessage(error)}`;
  }

  const previous = item.materialization;
  item.materialization = materialization;
  const at = now();
  item.updatedAt = at;
  document.updatedAt = at;
  try {
    // Durable before `running` and the attempt increment.
    saveQueue(repoRoot, document);
  } catch (error) {
    if (previous === undefined) delete item.materialization;
    else item.materialization = previous;
    return `plan materialization failed: ${errorMessage(error)}`;
  }
  tryAppendQueueEvent(repoRoot, {
    type: "plan.materialized",
    at: materialization.materializedAt,
    itemId: item.id,
    action: "materialize",
    status: "pending",
    reason:
      `base ${materialization.baseCommit}; ` +
      `contracts ${materialization.contractsHash}`,
  });
  log(`materialized ${item.id}: ${planLineage(item)}`);
  return undefined;
}

function createPlanMaterialization(
  repoRoot: string,
  item: PlanBackedQueueItem,
  byId: ReadonlyMap<string, QueueItem>,
): QueuePlanMaterialization {
  const materializedAt = now();
  if (item.planBaseCommit !== undefined) {
    return materializePlan({
      repoRoot,
      queueId: item.id,
      planPath: item.planPath,
      planHash: item.planHash,
      planId: item.planId,
      rootBaseCommit: item.planBaseCommit,
      materializedAt,
    });
  }

  const dependencyId = item.dependsOn[0];
  if (item.dependsOn.length !== 1 || dependencyId === undefined) {
    throw new Error(
      `dependent plan-backed item ${JSON.stringify(item.id)} must have ` +
        "exactly one dependency",
    );
  }
  const upstream = byId.get(dependencyId);
  if (!upstream) {
    throw new Error(
      `dependency ${JSON.stringify(dependencyId)} is missing from the queue`,
    );
  }
  if (upstream.status !== "completed") {
    throw new Error(
      `dependency ${JSON.stringify(dependencyId)} is not completed ` +
        `(status: ${upstream.status})`,
    );
  }
  const upstreamRunId = lastRunIdOf(upstream);
  if (!upstreamRunId) {
    throw new Error(
      `dependency ${JSON.stringify(dependencyId)} has no completed run id`,
    );
  }
  const upstreamContracts = queueItemContractsIdentity(upstream);
  if (!upstreamContracts) {
    throw new Error(
      `dependency ${JSON.stringify(dependencyId)} has no frozen contracts ` +
        "identity",
    );
  }

  const evidence: PlanUpstreamEvidence = {
    queueId: dependencyId,
    status: upstream.status,
    lastRunId: upstreamRunId,
    contractsPath: upstreamContracts.contractsPath,
    contractsHash: upstreamContracts.contractsHash,
  };
  return materializePlan({
    repoRoot,
    queueId: item.id,
    planPath: item.planPath,
    planHash: item.planHash,
    planId: item.planId,
    upstream: evidence,
    materializedAt,
  });
}

/**
 * Reuse-only verification for a recorded materialization: the Plan hash, the
 * exact artifact bytes, the base and upstream evidence must all still match.
 * It never compiles a Plan.
 */
function verifyRecordedPlanMaterialization(
  repoRoot: string,
  item: PlanBackedQueueItem,
  byId: ReadonlyMap<string, QueueItem>,
): void {
  const materialization = item.materialization;
  if (!materialization) {
    throw new Error(
      `plan materialization is not recorded for queue item ` +
        JSON.stringify(item.id),
    );
  }

  const planBytes = readBytesOrThrow(materialization.planPath, "Plan file");
  const planHash = sha256Hex(planBytes);
  if (planHash !== item.planHash.toLowerCase()) {
    throw new Error(
      `Plan hash mismatch for ${materialization.planPath}: expected sha256 ` +
        `${item.planHash}, found ${planHash}`,
    );
  }
  if (materialization.planHash.toLowerCase() !== item.planHash.toLowerCase()) {
    throw new Error(
      `recorded materialization plan hash ${materialization.planHash} does ` +
        `not match the item plan hash ${item.planHash}`,
    );
  }

  if (item.dependsOn.length === 0) {
    if (item.planBaseCommit === undefined) {
      throw new Error(
        `root plan-backed item ${JSON.stringify(item.id)} has no recorded ` +
          "planBaseCommit",
      );
    }
    if (
      materialization.baseCommit.toLowerCase() !==
      item.planBaseCommit.toLowerCase()
    ) {
      throw new Error(
        `recorded materialization base ${materialization.baseCommit} does ` +
          `not match the root planBaseCommit ${item.planBaseCommit}`,
      );
    }
    resolveExactCommit(
      repoRoot,
      materialization.baseCommit,
      "materialization baseCommit",
    );
  } else {
    verifyRecordedUpstreamEvidence(repoRoot, item, materialization, byId);
  }

  const artifactBytes = readBytesOrThrow(
    materialization.contractsPath,
    "materialized contracts artifact",
  );
  const actualHash = sha256Hex(artifactBytes);
  const identity = queueItemContractsIdentity(item);
  if (!identity) {
    throw new Error(
      `plan-backed item ${JSON.stringify(item.id)} has no contracts identity`,
    );
  }
  if (
    actualHash !== materialization.contractsHash.toLowerCase() ||
    identity.contractsHash.toLowerCase() !==
      materialization.contractsHash.toLowerCase()
  ) {
    throw new Error(
      `materialized contracts artifact changed: ` +
        `${materialization.contractsPath} (expected sha256 ` +
        `${materialization.contractsHash}, found ${actualHash})`,
    );
  }
  verifyArtifactProvenance(item, materialization, artifactBytes);
}

/**
 * A dependent base must equal the completed upstream RunManifest integration
 * head, and that manifest must still describe the upstream item's frozen
 * contracts identity.
 */
function verifyRecordedUpstreamEvidence(
  repoRoot: string,
  item: PlanBackedQueueItem,
  materialization: QueuePlanMaterialization,
  byId: ReadonlyMap<string, QueueItem>,
): void {
  const dependencyId = item.dependsOn[0];
  if (item.dependsOn.length !== 1 || dependencyId === undefined) {
    throw new Error(
      `dependent plan-backed item ${JSON.stringify(item.id)} must have ` +
        "exactly one dependency",
    );
  }
  const upstream = byId.get(dependencyId);
  if (!upstream) {
    throw new Error(
      `dependency ${JSON.stringify(dependencyId)} is missing from the queue`,
    );
  }
  if (upstream.status !== "completed") {
    throw new Error(
      `dependency ${JSON.stringify(dependencyId)} is not completed ` +
        `(status: ${upstream.status})`,
    );
  }
  const upstreamRunId = lastRunIdOf(upstream);
  if (!upstreamRunId) {
    throw new Error(
      `dependency ${JSON.stringify(dependencyId)} has no completed run id`,
    );
  }
  if (materialization.upstreamQueueId !== dependencyId) {
    throw new Error(
      `recorded materialization upstream ${String(
        materialization.upstreamQueueId,
      )} does not match the item dependency ${JSON.stringify(dependencyId)}`,
    );
  }
  if (materialization.upstreamRunId !== upstreamRunId) {
    throw new Error(
      `recorded materialization upstream run ${String(
        materialization.upstreamRunId,
      )} does not match the upstream item run ${upstreamRunId}`,
    );
  }
  if (materialization.upstreamIntegrationHead === undefined) {
    throw new Error(
      "recorded materialization is missing upstreamIntegrationHead",
    );
  }
  if (
    materialization.baseCommit.toLowerCase() !==
    materialization.upstreamIntegrationHead.toLowerCase()
  ) {
    throw new Error(
      `recorded materialization base ${materialization.baseCommit} does not ` +
        `match upstreamIntegrationHead ` +
        `${materialization.upstreamIntegrationHead}`,
    );
  }

  const upstreamContracts = queueItemContractsIdentity(upstream);
  if (!upstreamContracts) {
    throw new Error(
      `dependency ${JSON.stringify(dependencyId)} has no frozen contracts ` +
        "identity",
    );
  }
  let manifest: RunManifest;
  try {
    manifest = loadRunManifest(repoRoot, upstreamRunId);
  } catch (error) {
    throw new Error(
      `cannot load upstream RunManifest ${JSON.stringify(upstreamRunId)}: ` +
        `${errorMessage(error)}`,
    );
  }
  if (manifest.status !== "completed") {
    throw new Error(
      `upstream RunManifest ${JSON.stringify(upstreamRunId)} is not ` +
        `completed (status: ${manifest.status})`,
    );
  }
  if (manifest.runId !== upstreamRunId) {
    throw new Error(
      `upstream RunManifest run id ${JSON.stringify(manifest.runId)} does ` +
        `not match recorded lastRunId ${JSON.stringify(upstreamRunId)}`,
    );
  }
  if (
    resolve(manifest.contractsPath) !==
      resolve(upstreamContracts.contractsPath) ||
    manifest.contractsHash.toLowerCase() !==
      upstreamContracts.contractsHash.toLowerCase()
  ) {
    throw new Error(
      `upstream RunManifest ${JSON.stringify(upstreamRunId)} contracts ` +
        "identity does not match the frozen upstream evidence",
    );
  }

  const materializedHead = resolveExactCommit(
    repoRoot,
    materialization.upstreamIntegrationHead,
    "materialization upstreamIntegrationHead",
  );
  if (materializedHead !== materialization.baseCommit.toLowerCase()) {
    throw new Error(
      `recorded materialization base ${materialization.baseCommit} does not ` +
        `equal the exact upstream integration head ${materializedHead}`,
    );
  }
  const manifestHead = resolveExactCommit(
    repoRoot,
    manifest.integrationHead,
    "upstream manifest integrationHead",
  );
  if (manifestHead !== materializedHead) {
    throw new Error(
      `recorded materialization integration head ${materializedHead} does ` +
        `not match upstream RunManifest ${JSON.stringify(upstreamRunId)}`,
    );
  }
  const manifestBase = resolveExactCommit(
    repoRoot,
    manifest.baseCommit,
    "upstream manifest baseCommit",
  );
  assertAncestorCommit(repoRoot, manifestBase, manifestHead);
}

/** A resumed run must still describe this Plan item and its artifact/base. */
function verifyPlanRunManifest(
  repoRoot: string,
  item: PlanBackedQueueItem,
  materialization: QueuePlanMaterialization,
  runId: string,
  knownManifest?: RunManifest,
): void {
  let manifest = knownManifest;
  if (!manifest) {
    try {
      manifest = loadRunManifest(repoRoot, runId);
    } catch (error) {
      throw new Error(
        `cannot load RunManifest ${JSON.stringify(runId)}: ` +
          `${errorMessage(error)}`,
      );
    }
  }
  if (manifest.runId !== runId) {
    throw new Error(
      `RunManifest run id ${JSON.stringify(manifest.runId)} does not match ` +
        `recorded run ${JSON.stringify(runId)}`,
    );
  }
  if (resolve(manifest.repoRoot) !== resolve(repoRoot)) {
    throw new Error(
      `run ${runId} belongs to ${resolve(manifest.repoRoot)}, not ${repoRoot}`,
    );
  }
  if (manifest.planId !== item.planId) {
    throw new Error(
      `run ${runId} planId ${JSON.stringify(manifest.planId)} does not ` +
        `match plan item id ${JSON.stringify(item.planId)}`,
    );
  }
  if (
    resolve(manifest.contractsPath) !== resolve(materialization.contractsPath)
  ) {
    throw new Error(
      `run ${runId} contracts path ${manifest.contractsPath} does not match ` +
        `the recorded materialization ${materialization.contractsPath}`,
    );
  }
  if (
    manifest.contractsHash.toLowerCase() !==
    materialization.contractsHash.toLowerCase()
  ) {
    throw new Error(
      `run ${runId} contracts hash ${manifest.contractsHash} does not match ` +
        `the recorded materialization ${materialization.contractsHash}`,
    );
  }
  if (
    manifest.baseCommit.toLowerCase() !==
    materialization.baseCommit.toLowerCase()
  ) {
    throw new Error(
      `run ${runId} base commit ${manifest.baseCommit} does not match the ` +
        `materialized base ${materialization.baseCommit}`,
    );
  }
}

/** Prove the artifact bytes still describe exactly this Plan lineage. */
function verifyArtifactProvenance(
  item: PlanBackedQueueItem,
  materialization: QueuePlanMaterialization,
  bytes: Buffer,
): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString("utf8")) as unknown;
  } catch (error) {
    throw new Error(
      `materialized contracts artifact is not valid JSON: ` +
        `${errorMessage(error)}`,
    );
  }
  if (!isRecord(parsed)) {
    throw new Error("materialized contracts artifact must be an object");
  }
  if (parsed.planId !== item.planId) {
    throw new Error(
      `materialized contracts artifact planId ${JSON.stringify(
        parsed.planId,
      )} does not match ${JSON.stringify(item.planId)}`,
    );
  }
  if (!Array.isArray(parsed.contracts)) {
    throw new Error(
      "materialized contracts artifact contracts must be an array",
    );
  }
  if (!isRecord(parsed.provenance)) {
    throw new Error(
      "materialized contracts artifact is missing provenance",
    );
  }
  const provenance = parsed.provenance;
  if (provenance.queueId !== item.id) {
    throw new Error(
      "materialized contracts artifact provenance.queueId does not match " +
        `the queue item ${JSON.stringify(item.id)}`,
    );
  }
  if (
    typeof provenance.planPath !== "string" ||
    resolve(provenance.planPath) !== resolve(item.planPath)
  ) {
    throw new Error(
      "materialized contracts artifact provenance.planPath does not match " +
        "the item planPath",
    );
  }
  if (
    typeof provenance.planHash !== "string" ||
    provenance.planHash.toLowerCase() !== item.planHash.toLowerCase()
  ) {
    throw new Error(
      "materialized contracts artifact provenance.planHash does not match " +
        "the item planHash",
    );
  }
  if (provenance.planId !== item.planId) {
    throw new Error(
      "materialized contracts artifact provenance.planId does not match " +
        "the item planId",
    );
  }
  if (
    typeof provenance.baseCommit !== "string" ||
    provenance.baseCommit.toLowerCase() !==
      materialization.baseCommit.toLowerCase()
  ) {
    throw new Error(
      "materialized contracts artifact provenance.baseCommit does not " +
        "match the materialized base",
    );
  }

  const upstreamQueueId = optionalArtifactString(
    provenance.upstreamQueueId,
    "upstreamQueueId",
  );
  const upstreamRunId = optionalArtifactString(
    provenance.upstreamRunId,
    "upstreamRunId",
  );
  const upstreamIntegrationHead = optionalArtifactString(
    provenance.upstreamIntegrationHead,
    "upstreamIntegrationHead",
  );
  if (materialization.upstreamQueueId === undefined) {
    if (
      upstreamQueueId !== undefined ||
      upstreamRunId !== undefined ||
      upstreamIntegrationHead !== undefined
    ) {
      throw new Error(
        "materialized contracts artifact records upstream lineage for a " +
          "root plan item",
      );
    }
    return;
  }
  if (
    upstreamQueueId !== materialization.upstreamQueueId ||
    upstreamRunId !== materialization.upstreamRunId ||
    upstreamIntegrationHead === undefined ||
    materialization.upstreamIntegrationHead === undefined ||
    upstreamIntegrationHead.toLowerCase() !==
      materialization.upstreamIntegrationHead.toLowerCase()
  ) {
    throw new Error(
      "materialized contracts artifact upstream provenance does not match " +
        "the recorded materialization",
    );
  }
}

function planLineage(item: PlanBackedQueueItem): string {
  const materialization = item.materialization;
  const base =
    materialization?.baseCommit ?? item.planBaseCommit ?? "<pending>";
  const upstream =
    materialization?.upstreamQueueId !== undefined
      ? ` upstream ${materialization.upstreamQueueId}#${materialization.upstreamRunId ?? "-"} integrationHead ${materialization.upstreamIntegrationHead ?? "-"}`
      : "";
  const contracts = materialization
    ? ` contracts ${materialization.contractsPath} (sha256 ${materialization.contractsHash})`
    : "";
  return (
    `plan ${item.planId} sha256 ${item.planHash} base ${base}` +
    `${upstream}${contracts}`
  );
}

function planReconcileEvidence(
  repoRoot: string,
  item: PlanBackedQueueItem,
  byId: ReadonlyMap<string, QueueItem>,
  runId: string,
  manifest: RunManifest,
): string | undefined {
  try {
    if (!item.materialization) {
      throw new Error(
        `plan materialization is not recorded for queue item ` +
          JSON.stringify(item.id),
      );
    }
    verifyRecordedPlanMaterialization(repoRoot, item, byId);
    verifyPlanRunManifest(
      repoRoot,
      item,
      item.materialization,
      runId,
      manifest,
    );
    return undefined;
  } catch (error) {
    return `plan materialization verification failed: ${errorMessage(error)}`;
  }
}

function contractEvidenceReason(
  item: QueueItem,
  runId: string,
  manifest: RunManifest,
): string | undefined {
  if (
    typeof item.contractsPath !== "string" ||
    manifest.contractsHash !== item.contractsHash ||
    resolve(manifest.contractsPath) !== resolve(item.contractsPath)
  ) {
    return (
      `run ${runId} evidence does not match the item's frozen contracts`
    );
  }
  return undefined;
}

function lastRunIdOf(item: QueueItem): string | undefined {
  return item.lastRunId ?? item.runIds[item.runIds.length - 1] ?? undefined;
}

function readBytesOrThrow(path: string, label: string): Buffer {
  try {
    return readFileSync(path);
  } catch (error) {
    throw new Error(
      `${label} is missing or unreadable: ${path} (${errorMessage(error)})`,
    );
  }
}

function sha256Hex(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Require an exact full commit hash and prove git resolves it unchanged. */
function resolveExactCommit(
  repoRoot: string,
  value: string,
  label: string,
): string {
  const candidate = value.trim().toLowerCase();
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(candidate)) {
    throw new Error(
      `${label} must be an exact full git commit hash ` +
        `(40 or 64 hex characters), got ${JSON.stringify(value)}`,
    );
  }
  const result = spawnSync(
    "git",
    ["rev-parse", "--verify", "--quiet", `${candidate}^{commit}`],
    { cwd: repoRoot, encoding: "utf8" },
  );
  if (result.error !== undefined || result.status !== 0) {
    throw new Error(
      `cannot resolve ${label} ${JSON.stringify(candidate)} as a commit in ` +
        repoRoot,
    );
  }
  const resolved = result.stdout.trim().toLowerCase();
  if (resolved !== candidate) {
    throw new Error(
      `${label} ${JSON.stringify(candidate)} did not resolve to the exact ` +
        `commit (got ${JSON.stringify(resolved)})`,
    );
  }
  return resolved;
}

function assertAncestorCommit(
  repoRoot: string,
  ancestor: string,
  descendant: string,
): void {
  const result = spawnSync(
    "git",
    ["merge-base", "--is-ancestor", ancestor, descendant],
    { cwd: repoRoot, encoding: "utf8" },
  );
  if (result.error !== undefined || result.status === null) {
    throw new Error(
      `cannot prove ancestry of ${ancestor} in ${descendant}: ` +
        `${result.error?.message ?? "git did not run"}`,
    );
  }
  if (result.status === 1) {
    throw new Error(
      `upstream manifest base ${ancestor} is not an ancestor of integration ` +
        `head ${descendant}`,
    );
  }
  if (result.status !== 0) {
    throw new Error(
      `cannot prove ancestry of ${ancestor} in ${descendant} ` +
        `(git exited ${result.status})`,
    );
  }
}

function optionalArtifactString(
  value: unknown,
  field: string,
): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(
      `materialized contracts artifact provenance.${field} must be a ` +
        "non-empty string",
    );
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
  const byId = new Map(document.items.map((item) => [item.id, item]));
  for (const item of document.items) {
    if (item.status !== "running") continue;
    // A running item was dispatched, so the RunManifest owns its failure.
    delete item.failure;

    const attemptedRunId =
      item.lastRunId ?? item.runIds[item.runIds.length - 1] ?? undefined;
    let boundRunId: string | undefined = attemptedRunId;
    // Default is fail-closed; every successful evidence branch reassigns it.
    let to: QueueItemStatus = "blocked";
    let reason: string | undefined;

    if (!attemptedRunId) {
      to = "blocked";
      reason = "running item has no recorded run id";
    } else {
      let manifest: RunManifest | undefined;
      try {
        manifest = loadRunManifest(repoRoot, attemptedRunId);
      } catch (error) {
        to = "blocked";
        if (error instanceof RunNotFoundError) {
          if (item.nextAction === "start") {
            clearRunBinding(item, attemptedRunId);
            boundRunId = undefined;
            reason =
              `run manifest not found for start attempt ${attemptedRunId}; ` +
              "retry from start";
          } else {
            reason =
              `cannot reconcile resumed run ${attemptedRunId}: ` +
              errorMessage(error);
          }
        } else {
          reason =
            `cannot reconcile run ${attemptedRunId}: ${errorMessage(error)}`;
        }
      }
      if (manifest) {
        const evidenceReason = isPlanBackedQueueItem(item)
          ? planReconcileEvidence(
              repoRoot,
              item,
              byId,
              attemptedRunId,
              manifest,
            )
          : contractEvidenceReason(item, attemptedRunId, manifest);
        if (evidenceReason !== undefined) {
          to = "blocked";
          reason = evidenceReason;
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
              `run ${attemptedRunId} is still owned by a live process ` +
              `(pid ${manifest.owner.pid} on ${manifest.owner.host})`;
          } else if (ownerAlive === null) {
            to = "blocked";
            reason =
              `run ${attemptedRunId} owner is on ${manifest.owner.host}; ` +
              "liveness cannot be proven from this host";
          } else if (item.attempts >= item.maxAttempts) {
            to = "blocked";
            reason =
              `attempt limit reached (${item.attempts}/${item.maxAttempts}) ` +
              `while recovering interrupted run ${attemptedRunId}`;
          } else {
            to = "pending";
          }
        } else if (item.attempts >= item.maxAttempts) {
          to = "blocked";
          reason =
            `attempt limit reached (${item.attempts}/${item.maxAttempts}) ` +
            `after run ${attemptedRunId} ended ${manifest.status}`;
        } else {
          // interrupted or blocked: Supervisor resume can retry non-accepted
          // work, so keep the existing run instead of starting a fresh one.
          to = "pending";
        }
      }
    }

    const at = now();
    item.status = to;
    if (boundRunId) {
      item.lastRunId = boundRunId;
      if (!item.runIds.includes(boundRunId)) item.runIds.push(boundRunId);
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
      ...(attemptedRunId !== undefined
        ? { runId: attemptedRunId }
        : {}),
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

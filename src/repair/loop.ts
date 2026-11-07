import { assertTransition, type TaskStatus } from "../core/status.js";
import type { TaskContract } from "../contracts/schema.js";
import type {
  AgentAdapter,
  AgentStartInput,
  WorkerProgressEvent,
} from "../agents/types.js";
import {
  appendTaskExtensionRecord,
  parseTaskBudgetContinuationState,
  parseTaskExtensionRecord,
  type TaskBudgetContinuationState,
  type TaskExtensionRecord,
} from "../agents/continuation.js";
import { auditPathScope } from "../agents/path-scope.js";
import {
  createProcessTreeCleanupFailure,
  isWorkerProcessCleanupFailure,
  MAX_WORKER_PROCESS_RECORDS,
  parseWorkerProcessRecord,
  type WorkerProcessRecord,
} from "../agents/process-tree.js";
import type { WorkerLeaseAttacher } from "../agents/worker-lease.js";
import type { Verifier } from "../verification/verifier.js";
import {
  aggregateCostTruth,
  boundFailureText,
  createFailureRecord,
  parseCostTruth,
  parseFailureRecord,
  type CostTruth,
  type FailureRecord,
} from "../failures.js";
import {
  appendEvent,
  updateLedger,
  type LedgerTaskRecord,
  defaultLedgerPath,
} from "../persistence/ledger.js";
import {
  MAX_PATH_AUDITS,
  MAX_PATH_AUDIT_ERROR_LENGTH,
  MAX_PATH_AUDIT_PATHS,
  MAX_PROCESS_TREES,
  type PathAuditRecord,
} from "../supervisor/types.js";
import {
  isSandboxReport,
  type SandboxReport,
} from "../sandbox/types.js";
import {
  isVerificationObservation,
  type VerificationObservation,
} from "../verification/background-verifier.js";
import {
  isCleanReviewEnabled,
  isReviewObservation,
  runAcceptanceReview,
  type CleanReviewWireOptions,
  type ReviewObservation,
} from "../review/index.js";

export interface LoopOptions {
  contract: TaskContract;
  worker: AgentAdapter;
  verifier: Verifier;
  ledgerPath?: string;
  /** Log each transition to stdout */
  verbose?: boolean;
  /**
   * Forward live worker progress for every attempt. The callback receives the
   * adapter's task/session-scoped event; the batch owns any persistence.
   */
  onProgress?: (event: WorkerProgressEvent) => void;
  /**
   * Persist one deadline or budget grant before the adapter acts on it. A
   * thrown/rejected callback denies the grant.
   */
  onExtension?: (
    extension: TaskExtensionRecord,
  ) => void | Promise<void>;
  /**
   * Run-scoped worker lease sink. Standalone loops leave this unset; the
   * Supervisor-backed batch supplies it so every spawned worker is tracked.
   */
  onWorkerLease?: WorkerLeaseAttacher;
  /**
   * Opt-in clean-context review after verify.ok. Observational only —
   * findings never flip the loop verdict. Enable via `review.enabled` or
   * `CLIYARD_CLEAN_REVIEW=1`.
   */
  review?: CleanReviewWireOptions;
}

export interface LoopResult {
  taskId: string;
  status: TaskStatus;
  repairCount: number;
  verdict: "accepted" | "rejected";
  reason: string;
  ledgerPath: string;
  events: { type: string; status?: TaskStatus; detail?: string }[];
  /** Final structured failure for a rejected task; absent when accepted. */
  failure?: FailureRecord;
  /**
   * Aggregated cost truth across every worker session the loop started,
   * including repairs. Never an authoritative run total.
   */
  cost?: CostTruth;
  /**
   * Bounded path evidence for every worker exit observed by this loop.
   * These records are observational and never grant acceptance.
   */
  pathAudits: PathAuditRecord[];
  /** Deadline and budget grants whose persistence callback completed. */
  extensions: TaskExtensionRecord[];
  /**
   * Task-level guard ledger after the last attempt when a budget policy is
   * configured. Local allocation caps only; never provider balance or
   * invoice truth, and never an observed spend.
   */
  taskBudget?: TaskBudgetContinuationState;
  /** Bounded process-tree evidence for every worker invocation observed. */
  processTrees: WorkerProcessRecord[];
  /**
   * Structured resource-cleanup failure kept separate from the worker's own
   * failure. A success result is rejected when this is present.
   */
  cleanupFailure?: FailureRecord;
  /**
   * Observational sandbox prepare/wrap report from the last worker attempt.
   * Absence means sandbox was not enabled. Never grants acceptance.
   */
  sandbox?: SandboxReport;
  /**
   * Observational background VerificationTask summary from the last verify.
   * Absence means shell/mock verify was used. Never grants acceptance.
   */
  verification?: import("../verification/background-verifier.js").VerificationObservation;
  /**
   * Observational clean-review summary after verify.ok when enabled.
   * Absence means clean review was not enabled. Never grants acceptance.
   */
  review?: ReviewObservation;
}

function setStatus(
  record: LedgerTaskRecord,
  to: TaskStatus,
  log?: (s: string) => void,
): void {
  assertTransition(record.status, to);
  record.status = to;
  log?.(`  status → ${to}`);
}

/**
 * Minimal Route C closed loop:
 * dispatch → implement → verify → onFail repair/retry → accept|reject
 * Ledger writes are locked so parallel tasks can share one ledger file.
 */
export async function runClosedLoop(opts: LoopOptions): Promise<LoopResult> {
  const log = opts.verbose
    ? (s: string) => console.log(s)
    : (_s: string) => undefined;

  const ledgerPath = opts.ledgerPath ?? defaultLedgerPath();
  const { contract, worker, verifier } = opts;

  let record!: LedgerTaskRecord;

  await updateLedger(ledgerPath, (ledger) => {
    record = {
      taskId: contract.taskId,
      status: "draft",
      repairCount: 0,
      contract,
      events: [],
      sessionIds: [],
    };
    ledger.tasks[contract.taskId] = record;
    log(`[loop] dispatch taskId=${contract.taskId} maxRepairs=${contract.maxRepairs}`);
    setStatus(record, "ready", log);
    appendEvent(record, "dispatch", "contract loaded");
  });

  let attempt = 0;
  let priorFailure: AgentStartInput["priorFailure"];
  /**
   * Every worker session started by this loop, including repairs. Unknown
   * observations stay missing rather than becoming zero.
   */
  const attemptCosts: CostTruth[] = [];
  const pathAudits: PathAuditRecord[] = [];
  const processTrees: WorkerProcessRecord[] = [];
  let extensions: TaskExtensionRecord[] = [];
  /**
   * Task-level guard ledger. It only advances when an adapter reports one, so
   * adapters without a budget policy keep their existing behavior.
   */
  let taskBudget: TaskBudgetContinuationState | undefined;
  /** Last valid sandbox report from a worker attempt (observational). */
  let sandbox: SandboxReport | undefined;
  /** Last valid background verification observation (observational). */
  let verification: VerificationObservation | undefined;
  /** Last valid clean-review observation (observational). */
  let review: ReviewObservation | undefined;

  while (true) {
    await updateLedger(ledgerPath, (ledger) => {
      record = ledger.tasks[contract.taskId]!;
      setStatus(record, "running", log);
      appendEvent(record, "implement.start", `attempt=${attempt}`);
    });

    const onExtension = opts.onExtension
      ? async (extension: TaskExtensionRecord): Promise<void> => {
          const parsed = parseTaskExtensionRecord(extension);
          if (!parsed) {
            throw new Error("worker emitted an invalid task extension");
          }
          // Validate bounds/conflicts before persistence. Publish the grant to
          // the loop only after the durable callback resolves.
          const next = appendTaskExtensionRecord(extensions, parsed);
          await opts.onExtension!(parsed);
          extensions = next;
        }
      : undefined;
    const { sessionId } = await worker.start({
      contract,
      attempt,
      ...(taskBudget !== undefined ? { taskBudget } : {}),
      priorFailure,
      ...(opts.onProgress ? { onProgress: opts.onProgress } : {}),
      ...(onExtension ? { onExtension } : {}),
      ...(opts.onWorkerLease ? { onWorkerLease: opts.onWorkerLease } : {}),
    });
    const agentResult = await worker.collect(sessionId);
    if (agentResult.sandbox !== undefined) {
      // Fail closed on malformed sandbox evidence: keep the prior valid
      // report (if any) rather than inventing fields.
      if (isSandboxReport(agentResult.sandbox)) {
        sandbox = agentResult.sandbox;
      }
    }
    for (const extension of agentResult.extensions ?? []) {
      const parsed = parseTaskExtensionRecord(extension);
      if (!parsed) continue;
      extensions = appendTaskExtensionRecord(extensions, parsed);
    }
    /**
     * Thread the task-level guard ledger into the next attempt. A malformed
     * ledger, a changed cap or a decrease would reset or widen the configured
     * envelope, so it is a deterministic policy failure instead of an
     * observation to trust. Adapters without a budget policy never return one.
     */
    let taskBudgetFailure: FailureRecord | undefined;
    if (agentResult.taskBudget !== undefined) {
      const reported = parseTaskBudgetContinuationState(
        agentResult.taskBudget,
      );
      const reset =
        reported !== undefined &&
        taskBudget !== undefined &&
        (reported.cumulativeGuardUsd < taskBudget.cumulativeGuardUsd ||
          reported.continuationCount < taskBudget.continuationCount);
      const capChanged =
        reported !== undefined &&
        taskBudget !== undefined &&
        reported.maxCumulativeGuardUsd !== taskBudget.maxCumulativeGuardUsd;
      if (
        !reported ||
        reported.taskId !== contract.taskId ||
        reset ||
        capChanged
      ) {
        taskBudgetFailure = createFailureRecord({
          stage: "policy",
          policyBlocked: true,
          code: "task_budget_state_invalid",
          messageDetail: "adapter returned an invalid task budget ledger",
        });
      } else {
        taskBudget = reported;
      }
    }
    // Fail closed on malformed adapter observations: an unusable record is
    // omitted (cost becomes missing), never guessed at.
    const parsedCost = agentResult.cost
      ? parseCostTruth(agentResult.cost)
      : null;
    if (parsedCost) attemptCosts.push(parsedCost);
    const parsedFailure = agentResult.failure
      ? parseFailureRecord(agentResult.failure)
      : null;
    /** Resource-cleanup failure for this attempt only. */
    let cleanupFailure: FailureRecord | undefined;
    const pathScope = auditPathScope(
      contract.writePaths,
      agentResult.touchedPaths,
      { maxPaths: MAX_PATH_AUDIT_PATHS },
    );
    const changedPathsError =
      typeof agentResult.changedPathsError === "string"
        ? boundFailureText(
            agentResult.changedPathsError,
            MAX_PATH_AUDIT_ERROR_LENGTH,
          )
        : "";

    // Fail closed on unusable process-tree evidence: a record that cannot be
    // parsed cannot prove the worker's descendants are gone.
    const attemptTrees: WorkerProcessRecord[] = [];
    let invalidTreeRecord = false;
    const suppliedTrees = agentResult.processTrees ?? [];
    if (suppliedTrees.length > MAX_WORKER_PROCESS_RECORDS) {
      // An adapter must never return an unbounded list; refuse it whole.
      invalidTreeRecord = true;
    }
    for (const raw of suppliedTrees.slice(0, MAX_WORKER_PROCESS_RECORDS)) {
      const parsedTree = parseWorkerProcessRecord(raw);
      if (!parsedTree) {
        invalidTreeRecord = true;
        continue;
      }
      attemptTrees.push(parsedTree);
      processTrees.push(parsedTree);
      if (isWorkerProcessCleanupFailure(parsedTree) && !cleanupFailure) {
        cleanupFailure = createProcessTreeCleanupFailure(parsedTree);
      }
    }
    if (processTrees.length > MAX_PROCESS_TREES) {
      processTrees.splice(0, processTrees.length - MAX_PROCESS_TREES);
    }
    const suppliedCleanupFailure = agentResult.cleanupFailure
      ? parseFailureRecord(agentResult.cleanupFailure)
      : null;
    if (suppliedCleanupFailure && !cleanupFailure) {
      cleanupFailure = suppliedCleanupFailure;
    }
    if (invalidTreeRecord && !cleanupFailure) {
      cleanupFailure = createFailureRecord({
        stage: "worker",
        code: "process_tree_record_invalid",
        messageDetail: "adapter returned an invalid process-tree record",
      });
    }
    // A worker that otherwise succeeded is not accepted while its tree is
    // ambiguous or its task guard ledger is unusable. The original worker
    // failure, when present, stays primary.
    const gateFailure = cleanupFailure ?? taskBudgetFailure;
    const effectiveExitCode =
      agentResult.exitCode === 0 && gateFailure ? 1 : agentResult.exitCode;

    const pathAudit: PathAuditRecord = {
      attempt,
      observedAt: new Date().toISOString(),
      exitCode: effectiveExitCode,
      changedPaths: pathScope.changedPaths,
      outsideWritePaths: pathScope.outsideWritePaths,
      ...(changedPathsError ? { changedPathsError } : {}),
    };
    pathAudits.push(pathAudit);
    if (pathAudits.length > MAX_PATH_AUDITS) {
      pathAudits.splice(0, pathAudits.length - MAX_PATH_AUDITS);
    }

    await updateLedger(ledgerPath, (ledger) => {
      record = ledger.tasks[contract.taskId]!;
      record.sessionIds.push(sessionId);
      appendEvent(
        record,
        "implement.done",
        `exitCode=${agentResult.exitCode}; ${agentResult.logTail.split("\n").pop() ?? ""}`,
      );
      appendEvent(record, "path.audit", describePathAudit(pathAudit));
      for (const tree of attemptTrees) {
        appendEvent(record, "process.tree", describeProcessTree(tree));
      }
      if (cleanupFailure) {
        appendEvent(
          record,
          "process.cleanup",
          boundFailureText(
            `cleanup failed: ${cleanupFailure.message}`,
            MAX_PATH_AUDIT_ERROR_LENGTH,
          ),
        );
      }
    });
    log(`  implement: exit=${agentResult.exitCode}`);
    log(agentResult.logTail.split("\n").map((l) => `    ${l}`).join("\n"));

    if (effectiveExitCode !== 0) {
      const v = await verifier.run(contract, agentResult);
      if (
        v.verification !== undefined &&
        isVerificationObservation(v.verification)
      ) {
        verification = v.verification;
      }
      // A worker exit is never relabeled as a verifier rejection, even when
      // the verifier also fails afterward. Adapters without structured
      // failure metadata fall back to normal bounded classification.
      const workerFailure =
        parsedFailure ??
        (agentResult.exitCode !== 0
          ? createFailureRecord({
              exitCode: agentResult.exitCode,
              text: agentResult.logTail,
              messageDetail: `implement failed: exitCode=${agentResult.exitCode}`,
            })
          : undefined);
      const failure = workerFailure ?? gateFailure!;
      await updateLedger(ledgerPath, (ledger) => {
        record = ledger.tasks[contract.taskId]!;
        setStatus(record, "verifying", log);
        appendEvent(record, "verify.done", v.logTail);
        setStatus(record, "rejected", log);
        record.verdict = "rejected";
        record.reason =
          workerFailure !== undefined
            ? `implement failed: exitCode=${agentResult.exitCode}`
            : cleanupFailure !== undefined
              ? `process-tree cleanup failed: ${cleanupFailure.code ?? cleanupFailure.category}`
              : `task budget ledger rejected: ${taskBudgetFailure!.code ?? taskBudgetFailure!.category}`;
        record.lastVerifyLog = v.logTail;
        record.failure = failure;
        record.cost = aggregateAttemptCost(attemptCosts, taskBudget);
        appendEvent(record, "verdict", record.reason);
      });
      return finish(
        record,
        ledgerPath,
        pathAudits,
        extensions,
        processTrees,
        cleanupFailure,
        taskBudget,
        sandbox,
        verification,
        review,
      );
    }

    await updateLedger(ledgerPath, (ledger) => {
      record = ledger.tasks[contract.taskId]!;
      setStatus(record, "verifying", log);
      appendEvent(record, "verify.start");
    });

    const verify = await verifier.run(contract, agentResult);
    if (
      verify.verification !== undefined &&
      isVerificationObservation(verify.verification)
    ) {
      verification = verify.verification;
    }
    log(`  verify: ok=${verify.ok}`);
    log(verify.logTail.split("\n").map((l) => `    ${l}`).join("\n"));

    if (verify.ok) {
      let reviewError: string | undefined;
      if (isCleanReviewEnabled(opts.review)) {
        // Observational only: failures here must not flip verify.ok into a
        // reject, and findings never grant or revoke acceptance.
        try {
          const observation = await runAcceptanceReview({
            contract,
            options: opts.review ?? { enabled: true },
          });
          if (isReviewObservation(observation)) {
            review = observation;
          }
        } catch (error) {
          reviewError =
            error instanceof Error ? error.message : String(error);
          log(`  clean review skipped: ${reviewError}`);
        }
      }
      await updateLedger(ledgerPath, (ledger) => {
        record = ledger.tasks[contract.taskId]!;
        record.lastVerifyLog = verify.logTail;
        appendEvent(record, "verify.done", `ok=${verify.ok} exit=${verify.exitCode}`);
        if (review !== undefined) {
          appendEvent(
            record,
            "review.done",
            `reviewId=${review.reviewId} findings=${review.findingCount}`,
          );
        } else if (reviewError !== undefined) {
          appendEvent(record, "review.error", reviewError);
        }
        setStatus(record, "accepted", log);
        record.verdict = "accepted";
        record.reason = `verified after ${attempt} repair(s)`;
        record.cost = aggregateAttemptCost(attemptCosts, taskBudget);
        delete record.failure;
        appendEvent(record, "verdict", record.reason);
      });
      return finish(
        record,
        ledgerPath,
        pathAudits,
        extensions,
        processTrees,
        cleanupFailure,
        taskBudget,
        sandbox,
        verification,
        review,
      );
    }

    const exhausted = await updateLedger(ledgerPath, (ledger) => {
      record = ledger.tasks[contract.taskId]!;
      record.lastVerifyLog = verify.logTail;
      appendEvent(record, "verify.done", `ok=${verify.ok} exit=${verify.exitCode}`);
      if (record.repairCount >= contract.maxRepairs) {
        setStatus(record, "rejected", log);
        record.verdict = "rejected";
        record.reason = `verify failed and maxRepairs=${contract.maxRepairs} exhausted`;
        // The worker succeeded and the verifier rejected its result. No raw
        // verifier log is copied into the bounded record.
        record.failure = createFailureRecord({
          workerSucceeded: true,
          verifierRejected: true,
          stage: "verifier",
          messageDetail: `maxRepairs=${contract.maxRepairs} exhausted`,
        });
        record.cost = aggregateAttemptCost(attemptCosts, taskBudget);
        appendEvent(record, "verdict", record.reason);
        return true;
      }
      setStatus(record, "repairing", log);
      record.repairCount += 1;
      appendEvent(
        record,
        "repair",
        `repairCount=${record.repairCount}/${contract.maxRepairs}`,
      );
      log(`  repair ${record.repairCount}/${contract.maxRepairs}`);
      return false;
    });

    if (exhausted) {
      return finish(
        record,
        ledgerPath,
        pathAudits,
        extensions,
        processTrees,
        cleanupFailure,
        taskBudget,
        sandbox,
        verification,
        review,
      );
    }
    priorFailure = {
      attempt,
      verifyLog: verify.logTail,
    };
    attempt += 1;
  }
}

/**
 * Aggregate attempt cost truth. The configured task cumulative guard is
 * recorded as the local cap allocation; it is never added to the CLI-reported
 * amount and never presented as provider balance or invoice truth.
 */
function aggregateAttemptCost(
  attemptCosts: ReadonlyArray<CostTruth>,
  taskBudget: TaskBudgetContinuationState | undefined,
): CostTruth {
  return aggregateCostTruth(
    attemptCosts,
    taskBudget
      ? { guardBudgetUsd: taskBudget.cumulativeGuardUsd }
      : {},
  );
}

function finish(
  record: LedgerTaskRecord,
  ledgerPath: string,
  pathAudits: PathAuditRecord[],
  extensions: TaskExtensionRecord[],
  processTrees: WorkerProcessRecord[],
  cleanupFailure: FailureRecord | undefined,
  taskBudget: TaskBudgetContinuationState | undefined,
  sandbox: SandboxReport | undefined,
  verification: VerificationObservation | undefined,
  review: ReviewObservation | undefined,
): LoopResult {
  return {
    taskId: record.taskId,
    status: record.status,
    repairCount: record.repairCount,
    verdict: record.verdict!,
    reason: record.reason!,
    ledgerPath,
    events: record.events.map((e) => ({
      type: e.type,
      status: e.status,
      detail: e.detail,
    })),
    ...(record.failure !== undefined ? { failure: record.failure } : {}),
    ...(record.cost !== undefined ? { cost: record.cost } : {}),
    pathAudits: pathAudits.map((audit) => ({
      ...audit,
      changedPaths: [...audit.changedPaths],
      outsideWritePaths: [...audit.outsideWritePaths],
    })),
    extensions: extensions.map((extension) => ({
      ...extension,
      healthyEvidence: [...extension.healthyEvidence],
    })),
    ...(taskBudget !== undefined ? { taskBudget: { ...taskBudget } } : {}),
    processTrees: processTrees.map((tree) => ({
      ...tree,
      signals: tree.signals.map((signal) => ({ ...signal })),
      residualMembers: tree.residualMembers.map((member) => ({ ...member })),
      ...(tree.identity ? { identity: { ...tree.identity } } : {}),
    })),
    ...(cleanupFailure !== undefined ? { cleanupFailure } : {}),
    ...(sandbox !== undefined ? { sandbox } : {}),
    ...(verification !== undefined ? { verification } : {}),
    ...(review !== undefined ? { review } : {}),
  };
}

function describeProcessTree(tree: WorkerProcessRecord): string {
  return boundFailureText(
    `attempt-tree pid=${tree.pid ?? "none"} pgid=${tree.pgid ?? "none"} ` +
      `trigger=${tree.cleanupReason} state=${tree.cleanupState} ` +
      `capture=${tree.captureSource}/${tree.captureSupport} ` +
      `residual=${tree.residualCount}` +
      (tree.detail ? `; ${tree.detail}` : ""),
    1_200,
  );
}

function describePathAudit(audit: PathAuditRecord): string {
  const changed =
    audit.changedPaths.length > 0 ? audit.changedPaths.join(", ") : "(none)";
  const outside =
    audit.outsideWritePaths.length > 0
      ? audit.outsideWritePaths.join(", ")
      : "(none)";
  return boundFailureText(
    `attempt=${audit.attempt}; exitCode=${audit.exitCode}; ` +
      `changed=${changed}; outside=${outside}` +
      (audit.changedPathsError
        ? `; changedPathsError=${audit.changedPathsError}`
        : ""),
    1_200,
  );
}

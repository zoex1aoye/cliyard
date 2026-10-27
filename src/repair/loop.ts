import { assertTransition, type TaskStatus } from "../core/status.js";
import type { TaskContract } from "../contracts/schema.js";
import type {
  AgentAdapter,
  AgentStartInput,
  WorkerProgressEvent,
} from "../agents/types.js";
import { auditPathScope } from "../agents/path-scope.js";
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
  type PathAuditRecord,
} from "../supervisor/types.js";

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

  while (true) {
    await updateLedger(ledgerPath, (ledger) => {
      record = ledger.tasks[contract.taskId]!;
      setStatus(record, "running", log);
      appendEvent(record, "implement.start", `attempt=${attempt}`);
    });

    const { sessionId } = await worker.start({
      contract,
      attempt,
      priorFailure,
      ...(opts.onProgress ? { onProgress: opts.onProgress } : {}),
    });
    const agentResult = await worker.collect(sessionId);
    // Fail closed on malformed adapter observations: an unusable record is
    // omitted (cost becomes missing), never guessed at.
    const parsedCost = agentResult.cost
      ? parseCostTruth(agentResult.cost)
      : null;
    if (parsedCost) attemptCosts.push(parsedCost);
    const parsedFailure = agentResult.failure
      ? parseFailureRecord(agentResult.failure)
      : null;
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
    const pathAudit: PathAuditRecord = {
      attempt,
      observedAt: new Date().toISOString(),
      exitCode: agentResult.exitCode,
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
    });
    log(`  implement: exit=${agentResult.exitCode}`);
    log(agentResult.logTail.split("\n").map((l) => `    ${l}`).join("\n"));

    if (agentResult.exitCode !== 0) {
      const v = await verifier.run(contract, agentResult);
      // A worker exit is never relabeled as a verifier rejection, even when
      // the verifier also fails afterward. Adapters without structured
      // failure metadata fall back to normal bounded classification.
      const failure =
        parsedFailure ??
        createFailureRecord({
          exitCode: agentResult.exitCode,
          text: agentResult.logTail,
          messageDetail: `implement failed: exitCode=${agentResult.exitCode}`,
        });
      await updateLedger(ledgerPath, (ledger) => {
        record = ledger.tasks[contract.taskId]!;
        setStatus(record, "verifying", log);
        appendEvent(record, "verify.done", v.logTail);
        setStatus(record, "rejected", log);
        record.verdict = "rejected";
        record.reason = `implement failed: exitCode=${agentResult.exitCode}`;
        record.lastVerifyLog = v.logTail;
        record.failure = failure;
        record.cost = aggregateCostTruth(attemptCosts);
        appendEvent(record, "verdict", record.reason);
      });
      return finish(record, ledgerPath, pathAudits);
    }

    await updateLedger(ledgerPath, (ledger) => {
      record = ledger.tasks[contract.taskId]!;
      setStatus(record, "verifying", log);
      appendEvent(record, "verify.start");
    });

    const verify = await verifier.run(contract, agentResult);
    log(`  verify: ok=${verify.ok}`);
    log(verify.logTail.split("\n").map((l) => `    ${l}`).join("\n"));

    if (verify.ok) {
      await updateLedger(ledgerPath, (ledger) => {
        record = ledger.tasks[contract.taskId]!;
        record.lastVerifyLog = verify.logTail;
        appendEvent(record, "verify.done", `ok=${verify.ok} exit=${verify.exitCode}`);
        setStatus(record, "accepted", log);
        record.verdict = "accepted";
        record.reason = `verified after ${attempt} repair(s)`;
        record.cost = aggregateCostTruth(attemptCosts);
        delete record.failure;
        appendEvent(record, "verdict", record.reason);
      });
      return finish(record, ledgerPath, pathAudits);
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
        record.cost = aggregateCostTruth(attemptCosts);
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
      return finish(record, ledgerPath, pathAudits);
    }
    priorFailure = {
      attempt,
      verifyLog: verify.logTail,
    };
    attempt += 1;
  }
}

function finish(
  record: LedgerTaskRecord,
  ledgerPath: string,
  pathAudits: PathAuditRecord[],
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
  };
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

import { assertTransition, type TaskStatus } from "../core/status.js";
import type { TaskContract } from "../contracts/schema.js";
import type {
  AgentAdapter,
  AgentStartInput,
  WorkerProgressEvent,
} from "../agents/types.js";
import type { Verifier } from "../verification/verifier.js";
import {
  appendEvent,
  updateLedger,
  type LedgerTaskRecord,
  defaultLedgerPath,
} from "../persistence/ledger.js";

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

    await updateLedger(ledgerPath, (ledger) => {
      record = ledger.tasks[contract.taskId]!;
      record.sessionIds.push(sessionId);
      appendEvent(
        record,
        "implement.done",
        `exitCode=${agentResult.exitCode}; ${agentResult.logTail.split("\n").pop() ?? ""}`,
      );
    });
    log(`  implement: exit=${agentResult.exitCode}`);
    log(agentResult.logTail.split("\n").map((l) => `    ${l}`).join("\n"));

    if (agentResult.exitCode !== 0) {
      const v = await verifier.run(contract, agentResult);
      await updateLedger(ledgerPath, (ledger) => {
        record = ledger.tasks[contract.taskId]!;
        setStatus(record, "verifying", log);
        appendEvent(record, "verify.done", v.logTail);
        setStatus(record, "rejected", log);
        record.verdict = "rejected";
        record.reason = `implement failed: exitCode=${agentResult.exitCode}`;
        record.lastVerifyLog = v.logTail;
        appendEvent(record, "verdict", record.reason);
      });
      return finish(record, ledgerPath);
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
        appendEvent(record, "verdict", record.reason);
      });
      return finish(record, ledgerPath);
    }

    const exhausted = await updateLedger(ledgerPath, (ledger) => {
      record = ledger.tasks[contract.taskId]!;
      record.lastVerifyLog = verify.logTail;
      appendEvent(record, "verify.done", `ok=${verify.ok} exit=${verify.exitCode}`);
      if (record.repairCount >= contract.maxRepairs) {
        setStatus(record, "rejected", log);
        record.verdict = "rejected";
        record.reason = `verify failed and maxRepairs=${contract.maxRepairs} exhausted`;
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
      return finish(record, ledgerPath);
    }
    priorFailure = {
      attempt,
      verifyLog: verify.logTail,
    };
    attempt += 1;
  }
}

function finish(record: LedgerTaskRecord, ledgerPath: string): LoopResult {
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
  };
}

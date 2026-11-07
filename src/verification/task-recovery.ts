/**
 * Startup recovery for VerificationTask records
 * (design/verification-task-v0.md).
 *
 * Uncertain in-flight work becomes `lost` — never `succeeded` by inference.
 */
import { createFailureRecord } from "../failures.js";
import {
  ProcessInspector,
  compareProcessIdentity,
} from "../runtime/process.js";
import {
  isTerminalVerificationStatus,
  type VerificationTask,
} from "./task-types.js";
import {
  listVerificationTasks,
  saveVerificationTask,
} from "./task-store.js";

export interface RecoverVerificationTasksOptions {
  repoRoot: string;
  now?: () => string;
  inspector?: ProcessInspector;
}

export interface RecoverVerificationTasksResult {
  reviewed: number;
  markedLost: VerificationTask[];
  leftRunning: VerificationTask[];
}

/**
 * Scan durable verification tasks. Any `running`/`stopping` task whose
 * ownerIdentity is missing or no longer matches a live process is marked
 * `lost` with a structured failure.
 */
export async function recoverVerificationTasks(
  options: RecoverVerificationTasksOptions,
): Promise<RecoverVerificationTasksResult> {
  const now = options.now ?? (() => new Date().toISOString());
  const inspector = options.inspector ?? new ProcessInspector();
  const markedLost: VerificationTask[] = [];
  const leftRunning: VerificationTask[] = [];
  const all = listVerificationTasks(options.repoRoot);
  let reviewed = 0;

  for (const task of all) {
    if (isTerminalVerificationStatus(task.status)) continue;
    if (task.status !== "running" && task.status !== "stopping") continue;
    reviewed += 1;

    const expected = task.ownerIdentity;
    if (expected === undefined) {
      const lost = markLost(
        task,
        now(),
        "verification owner identity missing at recovery",
        "verification_identity_missing",
      );
      saveVerificationTask(options.repoRoot, lost);
      markedLost.push(lost);
      continue;
    }

    let observed;
    try {
      observed = await inspector.capture(expected.pid);
    } catch {
      const lost = markLost(
        task,
        now(),
        "verification identity capture failed at recovery",
        "verification_identity_capture_failed",
      );
      saveVerificationTask(options.repoRoot, lost);
      markedLost.push(lost);
      continue;
    }

    const comparison = compareProcessIdentity(expected, observed);
    if (comparison === "match") {
      leftRunning.push(task);
      continue;
    }

    const lost = markLost(
      task,
      now(),
      comparison === "unknown"
        ? "verification process identity unknown at recovery"
        : "verification process identity mismatch at recovery",
      comparison === "unknown"
        ? "verification_identity_unknown"
        : "verification_identity_mismatch",
    );
    saveVerificationTask(options.repoRoot, lost);
    markedLost.push(lost);
  }

  return { reviewed, markedLost, leftRunning };
}

function markLost(
  task: VerificationTask,
  endedAt: string,
  messageDetail: string,
  code: string,
): VerificationTask {
  return {
    ...task,
    status: "lost",
    endedAt,
    lastError: createFailureRecord({
      policyBlocked: true,
      stage: "policy",
      code,
      messageDetail,
      retryableHint: false,
      observedAt: endedAt,
    }),
  };
}

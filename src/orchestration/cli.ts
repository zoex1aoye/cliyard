/**
 * `cliyard queue` CLI: durable foreground orchestration over frozen contracts.
 *
 * Commands mutate or inspect `<repo>/.cliyard/queue.json`; `run` dispatches
 * ready items one at a time through the Supervisor CLI. There is no daemon and
 * no parallel dispatch.
 */
import { resolve } from "node:path";
import {
  addPlanQueueItem,
  addQueueItem,
  cancelQueueItem,
  isPlanBackedQueueItem,
  loadQueue,
  queueCounts,
  retryQueueItem,
  type PlanBackedQueueItem,
  type QueueDocument,
  type QueueItem,
  type QueueWorker,
} from "./queue-store.js";
import {
  runQueue,
  type QueueRunSummary,
  type QueueSupervisorRunner,
} from "./queue-runner.js";
import {
  buildControlSnapshot,
  latestWorkerProgress,
  type ControlItemSnapshot,
  type ControlSnapshot,
} from "./control-snapshot.js";
import {
  formatCostObservation,
  formatFailureObservation,
} from "../supervisor/cli.js";
import {
  summarizeExecutionProfile,
  type ExecutionProfile,
} from "../execution/profile.js";
import {
  summarizeQueueContinuationPolicy,
  type QueueContinuationPolicy,
} from "../agents/continuation.js";

export interface QueueCliOptions {
  /** Output sink; defaults to console.log. */
  log?: (line: string) => void;
  /** Test/embedding seam forwarded to `queue run`. */
  runner?: QueueSupervisorRunner;
  /** Override the queue-lock wait used by `queue run`. */
  lockTimeoutMs?: number;
  lockPollMs?: number;
}

const VALUE_FLAGS = new Set([
  "--repo",
  "--id",
  "--depends-on",
  "--worker",
  "--model",
  "--execution-profile",
  "--continuation-policy",
  "--max-attempts",
  "--plan-id",
  "--max-dispatches",
]);

export async function runQueueCli(
  argv: string[],
  options: QueueCliOptions = {},
): Promise<number> {
  const log = options.log ?? ((line: string) => console.log(line));
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
    case "add":
      return addCommand(rest, log);
    case "add-plan":
      return addPlanCommand(rest, log);
    case "list":
      return listCommand(rest, log);
    case "status":
      return statusCommand(rest, log);
    case "retry":
      return retryCommand(rest, log);
    case "cancel":
      return cancelCommand(rest, log);
    case "run":
      return runCommand(rest, options, log);
    default:
      log(`unknown queue command: ${cmd}`);
      printUsage(log);
      return 1;
  }
}

// ---------------------------------------------------------------------------
// add / list / retry / cancel
// ---------------------------------------------------------------------------

function addCommand(rest: string[], log: (line: string) => void): number {
  const repoRoot = repoFrom(rest);
  const contractsArg = positionalArg(rest);
  if (!contractsArg) {
    throw new Error("queue add: missing <contracts.json>");
  }
  const id = arg("--id", rest);
  if (!id) {
    throw new Error("queue add: missing --id <queue-id>");
  }

  const workerRaw = arg("--worker", rest);
  if (
    workerRaw !== undefined &&
    workerRaw !== "claude" &&
    workerRaw !== "codex"
  ) {
    throw new Error(
      `queue add: --worker must be claude or codex (got ${workerRaw})`,
    );
  }
  const maxAttemptsRaw = arg("--max-attempts", rest);
  const maxAttempts =
    maxAttemptsRaw === undefined
      ? undefined
      : parsePositiveInt(maxAttemptsRaw, "--max-attempts");
  const model = arg("--model", rest);
  if (model !== undefined && !model.trim()) {
    throw new Error("queue add: --model must be non-empty");
  }

  const item = addQueueItem(repoRoot, {
    id,
    contractsPath: contractsArg,
    dependsOn: values("--depends-on", rest),
    ...(workerRaw !== undefined
      ? { worker: workerRaw as QueueWorker }
      : {}),
    model,
    executionProfilePath: arg("--execution-profile", rest),
    continuationPolicyPath: arg("--continuation-policy", rest),
    planId: arg("--plan-id", rest),
    maxAttempts,
  });

  if (has("--json", rest)) {
    log(JSON.stringify(item, null, 2));
  } else {
    log(
      `added queue item ${item.id}: ${item.status} ` +
        `(worker=${item.worker}${item.model ? `/${item.model}` : ""}, ` +
        `attempts=${item.attempts}/${item.maxAttempts}, ` +
        `deps=${item.dependsOn.join(",") || "-"}, next=${item.nextAction})`,
    );
    printItemDetail(item, log);
  }
  return 0;
}

function addPlanCommand(rest: string[], log: (line: string) => void): number {
  const repoRoot = repoFrom(rest);
  const planArg = positionalArg(rest);
  if (!planArg) {
    throw new Error("queue add-plan: missing <plan.json>");
  }
  const id = arg("--id", rest);
  if (!id) {
    throw new Error("queue add-plan: missing --id <queue-id>");
  }

  const workerRaw = arg("--worker", rest);
  if (
    workerRaw !== undefined &&
    workerRaw !== "claude" &&
    workerRaw !== "codex"
  ) {
    throw new Error(
      `queue add-plan: --worker must be claude or codex (got ${workerRaw})`,
    );
  }
  const maxAttemptsRaw = arg("--max-attempts", rest);
  const maxAttempts =
    maxAttemptsRaw === undefined
      ? undefined
      : parsePositiveInt(maxAttemptsRaw, "--max-attempts");
  const model = arg("--model", rest);
  if (model !== undefined && !model.trim()) {
    throw new Error("queue add-plan: --model must be non-empty");
  }

  const item = addPlanQueueItem(repoRoot, {
    id,
    planPath: planArg,
    dependsOn: values("--depends-on", rest),
    ...(workerRaw !== undefined
      ? { worker: workerRaw as QueueWorker }
      : {}),
    model,
    executionProfilePath: arg("--execution-profile", rest),
    continuationPolicyPath: arg("--continuation-policy", rest),
    maxAttempts,
  });

  if (has("--json", rest)) {
    log(JSON.stringify(item, null, 2));
  } else {
    log(
      `added queue item ${item.id}: ${item.status} ` +
        `(worker=${item.worker}${item.model ? `/${item.model}` : ""}, ` +
        `attempts=${item.attempts}/${item.maxAttempts}, ` +
        `deps=${item.dependsOn.join(",") || "-"}, next=${item.nextAction})`,
    );
    printItemDetail(item, log);
  }
  return 0;
}

function listCommand(rest: string[], log: (line: string) => void): number {
  const repoRoot = repoFrom(rest);
  const document = loadQueue(repoRoot);
  if (has("--json", rest)) {
    log(JSON.stringify(document, null, 2));
  } else {
    printQueue(document, log);
  }
  return 0;
}

async function statusCommand(
  rest: string[],
  log: (line: string) => void,
): Promise<number> {
  const repoRoot = repoFrom(rest);
  const snapshot = await buildControlSnapshot(repoRoot);
  if (has("--json", rest)) {
    log(JSON.stringify(snapshot, null, 2));
  } else {
    printControlSnapshot(snapshot, log);
  }
  return 0;
}

function retryCommand(rest: string[], log: (line: string) => void): number {
  const repoRoot = repoFrom(rest);
  const id = positionalArg(rest);
  if (!id) throw new Error("queue retry: missing <queue-id>");
  const item = retryQueueItem(repoRoot, id);
  if (has("--json", rest)) {
    log(JSON.stringify(item, null, 2));
  } else {
    log(
      `queue item ${item.id}: ${item.status} ` +
        `(next ${item.nextAction}, attempts ${item.attempts}/${item.maxAttempts})`,
    );
    if (isPlanBackedQueueItem(item)) printItemDetail(item, log);
  }
  return 0;
}

function cancelCommand(rest: string[], log: (line: string) => void): number {
  const repoRoot = repoFrom(rest);
  const id = positionalArg(rest);
  if (!id) throw new Error("queue cancel: missing <queue-id>");
  const item = cancelQueueItem(repoRoot, id);
  if (has("--json", rest)) {
    log(JSON.stringify(item, null, 2));
  } else {
    log(`queue item ${item.id}: ${item.status}`);
    if (isPlanBackedQueueItem(item)) printItemDetail(item, log);
  }
  return 0;
}

// ---------------------------------------------------------------------------
// run
// ---------------------------------------------------------------------------

async function runCommand(
  rest: string[],
  options: QueueCliOptions,
  log: (line: string) => void,
): Promise<number> {
  const repoRoot = repoFrom(rest);
  const maxRaw = arg("--max-dispatches", rest);
  const maxDispatches =
    maxRaw === undefined
      ? undefined
      : parsePositiveInt(maxRaw, "--max-dispatches");
  const json = has("--json", rest);

  const summary = await runQueue(repoRoot, {
    continueOnBlocked: has("--continue-on-blocked", rest),
    ...(maxDispatches !== undefined ? { maxDispatches } : {}),
    ...(options.runner !== undefined ? { runner: options.runner } : {}),
    ...(options.lockTimeoutMs !== undefined
      ? { lockTimeoutMs: options.lockTimeoutMs }
      : {}),
    ...(options.lockPollMs !== undefined
      ? { lockPollMs: options.lockPollMs }
      : {}),
    // Keep stdout machine-readable when --json is requested.
    ...(!json ? { log } : {}),
  });

  if (json) {
    log(JSON.stringify(summary, null, 2));
  } else {
    printRunSummary(summary, log);
  }
  return summary.counts.blocked > 0 ? 1 : 0;
}

// ---------------------------------------------------------------------------
// Human output
// ---------------------------------------------------------------------------

function printQueue(
  document: QueueDocument,
  log: (line: string) => void,
): void {
  const counts = queueCounts(document);
  log(
    `queue: ${counts.total} item(s) — pending ${counts.pending} / ` +
      `running ${counts.running} / completed ${counts.completed} / ` +
      `blocked ${counts.blocked} / cancelled ${counts.cancelled}`,
  );
  if (document.items.length === 0) {
    log("no queue items");
    return;
  }
  for (const item of document.items) {
    log(
      `${item.id}  ${item.status}  next=${item.nextAction}  ` +
        `worker=${item.worker}${item.model ? `/${item.model}` : ""}  ` +
        `attempts=${item.attempts}/${item.maxAttempts}  ` +
        `deps=${item.dependsOn.join(",") || "-"}  ` +
        `run=${item.lastRunId ?? "-"}`,
    );
    printItemDetail(item, log);
  }
}

function printItemDetail(
  item: QueueItem,
  log: (line: string) => void,
): void {
  printExecutionDetail(
    item.executionProfile,
    item.continuationPolicy,
    log,
  );
  if (item.failure) {
    log(`  failure: ${formatFailureObservation(item.failure)}`);
  }
  if (isPlanBackedQueueItem(item)) {
    printPlanDetail(item, log);
    if (item.reason) log(`  reason: ${item.reason}`);
    return;
  }
  if (item.planId) log(`  plan: ${item.planId}`);
  log(
    `  contracts: ${item.contractsPath} (sha256 ${item.contractsHash})`,
  );
  if (item.reason) log(`  reason: ${item.reason}`);
}

function printExecutionDetail(
  profile: ExecutionProfile | undefined,
  policy: QueueContinuationPolicy | undefined,
  log: (line: string) => void,
): void {
  log(`  execution: ${summarizeExecutionProfile(profile)}`);
  if (profile?.endpointRef) {
    log(`  endpointRef: ${profile.endpointRef}`);
  }
  if (profile?.accountBindingId) {
    log(`  accountBindingId: ${profile.accountBindingId}`);
  }
  const summary = summarizeQueueContinuationPolicy(policy);
  if (!summary) {
    log("  continuation: none");
    return;
  }
  if (summary.deadlineExtension) {
    const deadline = summary.deadlineExtension;
    log(
      `  continuation deadline: auto=${String(deadline.autoExtend)} ` +
        `maxExtensions=${deadline.maxExtensions} ` +
        `base=${deadline.baseTimeoutMs}ms ` +
        `maxTotal=${deadline.maxTotalTimeoutMs}ms`,
    );
  }
  if (summary.budgetContinuation) {
    const budget = summary.budgetContinuation;
    log(
      `  continuation budget: auto=${String(budget.autoContinue)} ` +
        `maxContinuations=${budget.maxContinuations} ` +
        `base=$${budget.baseGuardUsd} ` +
        `maxCumulative=$${budget.maxCumulativeGuardUsd}`,
    );
  }
}

function printPlanDetail(
  item: PlanBackedQueueItem,
  log: (line: string) => void,
): void {
  log(`  plan: ${item.planId}`);
  log(`  plan path: ${item.planPath}`);
  log(`  plan sha256: ${item.planHash}`);
  if (item.dependsOn.length === 0) {
    log(`  plan base: ${item.planBaseCommit} (frozen initial base)`);
  } else {
    log(
      `  plan base: upstream ${item.dependsOn[0]} ` +
        "(materialized before dispatch)",
    );
  }
  const materialization = item.materialization;
  if (!materialization) {
    log("  contracts: not materialized yet");
    return;
  }
  log(`  materialized base: ${materialization.baseCommit}`);
  if (materialization.upstreamQueueId !== undefined) {
    log(
      `  upstream: queue ${materialization.upstreamQueueId} ` +
        `run ${materialization.upstreamRunId ?? "-"} ` +
        `integration head ${materialization.upstreamIntegrationHead ?? "-"}`,
    );
  }
  log(
    `  contracts: ${materialization.contractsPath} ` +
      `(sha256 ${materialization.contractsHash})`,
  );
}

function printRunSummary(
  summary: QueueRunSummary,
  log: (line: string) => void,
): void {
  if (summary.dispatches.length === 0) {
    log("dispatched: none");
  } else {
    log(`dispatched: ${summary.dispatches.length}`);
    for (const dispatch of summary.dispatches) {
      log(
        `  ${dispatch.id}  ${dispatch.action}  ` +
          `run=${dispatch.runId ?? "-"}  ${dispatch.status}` +
          (dispatch.reason ? `: ${dispatch.reason}` : ""),
      );
    }
  }

  if (summary.reconciled.length > 0) {
    log(`reconciled: ${summary.reconciled.length}`);
    for (const record of summary.reconciled) {
      log(
        `  ${record.id}  ${record.from} -> ${record.to}` +
          (record.runId ? ` (run ${record.runId})` : "") +
          (record.reason ? `: ${record.reason}` : ""),
      );
    }
  }
  if (summary.propagated.length > 0) {
    log(`blocked dependants: ${summary.propagated.length}`);
    for (const record of summary.propagated) {
      log(`  ${record.id}: ${record.reason}`);
    }
  }

  const counts = summary.counts;
  log(
    `queue: pending ${counts.pending} / running ${counts.running} / ` +
      `completed ${counts.completed} / blocked ${counts.blocked} / ` +
      `cancelled ${counts.cancelled} (total ${counts.total})`,
  );
  log(
    `stopped: ${summary.stopped}` +
      (summary.reason ? ` (${summary.reason})` : ""),
  );

  for (const item of summary.items) {
    if (item.status === "blocked") {
      log(
        `blocked ${item.id}: ${item.reason ?? "no reason recorded"}` +
          (item.failure
            ? ` [failure ${formatFailureObservation(item.failure)}]`
            : ""),
      );
    }
  }

  const planItems = summary.items.filter(isPlanBackedQueueItem);
  if (planItems.length > 0) {
    log(`plans: ${planItems.length}`);
    for (const item of planItems) {
      log(
        `  ${item.id}  ${item.status}  next=${item.nextAction}  ` +
          `run=${item.lastRunId ?? "-"}`,
      );
      printItemDetail(item, log);
    }
  }
}

function printControlSnapshot(
  snapshot: ControlSnapshot,
  log: (line: string) => void,
): void {
  const counts = snapshot.counts;
  log(
    `queue: ${counts.total} item(s) — pending ${counts.pending} / ` +
      `running ${counts.running} / completed ${counts.completed} / ` +
      `blocked ${counts.blocked} / cancelled ${counts.cancelled}`,
  );
  log(`observed: ${snapshot.observedAt}`);
  log(`queue lock: ${formatQueueLock(snapshot)}`);
  const cpu = snapshot.resources.cpu;
  const memory = snapshot.resources.memory;
  log(
    `resources: cpu ${cpu.logicalCpus} / load ${formatLoad(cpu.load1)} / ` +
      `memory free ${formatBytes(memory.availableBytesEstimate ?? memory.freeBytes)} ` +
      `of ${formatBytes(memory.totalBytes)} / pressure ${memory.pressure}`,
  );
  log(
    `journal: ${snapshot.journal.totalEvents} event(s), ` +
      `${snapshot.journal.malformedLines} malformed` +
      (snapshot.journal.readError
        ? `, read error: ${snapshot.journal.readError}`
        : ""),
  );
  log(`failure categories: ${formatFailureCounts(snapshot.failureCounts)}`);
  log(`cost: ${formatControlCost(snapshot.cost)}`);
  if (snapshot.resources.provider.length > 0) {
    log("provider capacity:");
    for (const provider of snapshot.resources.provider) {
      log(
        `  ${provider.runtimeId}/${provider.modelId ?? "<cli-default>"}  ` +
          `in-flight=${provider.observedInFlight ?? "unknown"}  ` +
          `capacity=unknown  ` +
          `quota=${provider.quota.state}  balance=${provider.balance.state}  ` +
          `pricing=${provider.pricing.state}`,
      );
    }
  }
  if (snapshot.items.length === 0) {
    log("no queue items");
    return;
  }
  for (const item of snapshot.items) {
    printControlItem(item, log);
  }
}

function printControlItem(
  item: ControlItemSnapshot,
  log: (line: string) => void,
): void {
  log(
    `${item.id}  ${item.status}  next=${item.observedNextAction}  ` +
      `ready=${item.ready ? "yes" : "no"}  ` +
      `worker=${item.worker}${item.model ? `/${item.model}` : ""}  ` +
      `attempts=${item.attempts}/${item.maxAttempts}`,
  );
  printExecutionDetail(
    item.executionProfile,
    item.continuationPolicy,
    log,
  );
  if (item.run) {
    log(
      `  run: ${item.run.runId}  ${item.run.effectiveStatus}  ` +
        `tasks=${item.run.accepted}/${item.run.total} accepted  ` +
        `ownerAlive=${String(item.run.ownerAlive)}`,
    );
    // Durable per-task observations from the RunManifest authority.
    for (const task of item.run.tasks) {
      if (!task.failure && !task.cost) continue;
      const parts = [`  task ${task.taskId}: ${task.status}`];
      if (task.failure) {
        parts.push(`failure=${formatFailureObservation(task.failure)}`);
      }
      if (task.cost) {
        parts.push(`cost=${formatCostObservation(task.cost)}`);
      }
      log(parts.join(" "));
    }
  } else if (item.lastRunId) {
    log(`  run: ${item.lastRunId} (manifest unavailable)`);
  }
  if (item.failure) {
    // Deterministic pre-dispatch block with no RunManifest.
    log(`  failure: ${formatFailureObservation(item.failure)}`);
  }
  if (item.materialization) {
    log(
      `  materialized base: ${item.materialization.baseCommit}  ` +
        `contracts=${item.materialization.contractsHash.slice(0, 12)}`,
    );
  }
  const progress = latestWorkerProgress(item.run);
  if (progress) {
    log(
      `  worker: ${progress.event.type}/${progress.event.phase}  ` +
        `session=${progress.event.sessionId}  age=${progress.ageMs}ms` +
        `${progress.stale ? " (stale)" : ""}  ` +
        `${progress.event.message}`,
    );
  }
  if (item.decision.category !== "none") {
    log(
      `  decision: ${item.decision.category}` +
        (item.decision.reason ? ` — ${item.decision.reason}` : ""),
    );
  }
  if (item.journalEvents.length > 0) {
    const latest = item.journalEvents[item.journalEvents.length - 1]!;
    log(`  journal: ${latest.type} at ${latest.at}`);
  }
  for (const error of item.errors) log(`  warning: ${error}`);
}

function formatFailureCounts(
  counts: ControlSnapshot["failureCounts"],
): string {
  const entries = Object.entries(counts);
  return entries.length === 0
    ? "none"
    : entries.map(([category, count]) => `${category} ${count}`).join(" / ");
}

/**
 * Render only observed cost. A missing amount stays missing; the subtotal is
 * always labelled non-authoritative and completeness/missing reasons follow.
 */
function formatControlCost(cost: ControlSnapshot["cost"]): string {
  const base =
    cost.amount !== null
      ? `${cost.state} ${cost.amount} ${cost.currency ?? "<currency unknown>"}` +
        " observed; non-authoritative"
      : `${cost.state}; non-authoritative`;
  const missing =
    cost.missing.length > 0 ? `; missing ${cost.missing.join(", ")}` : "";
  return `${base}; completeness ${cost.completeness}${missing}`;
}

function formatQueueLock(snapshot: ControlSnapshot): string {
  const lock = snapshot.queue.lock;
  if (lock.state === "free") return "free";
  if (lock.state === "invalid") {
    return `invalid${lock.reason ? ` (${lock.reason})` : ""}`;
  }
  if (!lock.lock) return lock.state;
  return (
    `${lock.state} by pid ${lock.lock.pid} on ${lock.lock.host}` +
    (lock.reason ? ` (${lock.reason})` : "")
  );
}

function formatLoad(value: number | null): string {
  return value === null ? "unknown" : value.toFixed(2);
}

function formatBytes(value: number | null): string {
  if (value === null) return "unknown";
  return `${(value / 1024 ** 3).toFixed(1)} GiB`;
}

// ---------------------------------------------------------------------------
// Argument helpers
// ---------------------------------------------------------------------------

function repoFrom(argv: string[]): string {
  return resolve(arg("--repo", argv) ?? process.cwd());
}

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

function arg(flag: string, argv: string[]): string | undefined {
  const index = argv.indexOf(flag);
  if (
    index >= 0 &&
    argv[index + 1] !== undefined &&
    !argv[index + 1]!.startsWith("--")
  ) {
    return argv[index + 1];
  }
  const eq = argv.find((value) => value.startsWith(`${flag}=`));
  return eq?.slice(flag.length + 1);
}

function values(flag: string, argv: string[]): string[] {
  const found: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    const value = argv[i]!;
    if (value === flag) {
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        found.push(next);
        i += 1;
      }
      continue;
    }
    if (value.startsWith(`${flag}=`)) {
      found.push(value.slice(flag.length + 1));
    }
  }
  return found;
}

function has(flag: string, argv: string[]): boolean {
  return argv.includes(flag);
}

function parsePositiveInt(value: string, flag: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`queue: ${flag} must be a positive integer (got ${value})`);
  }
  return parsed;
}

function printUsage(log: (line: string) => void): void {
  log(`cliyard queue — durable foreground orchestration queue

Usage:
  cliyard queue add <contracts.json> --repo <path> --id <queue-id>
                    [--depends-on <id>]... [--worker claude|codex]
                    [--model id] [--execution-profile <profile.json>]
                    [--continuation-policy <policy.json>]
                    [--max-attempts n] [--plan-id id] [--json]
  cliyard queue add-plan <plan.json> --repo <path> --id <queue-id>
                    [--depends-on <id>] [--worker claude|codex]
                    [--model id] [--execution-profile <profile.json>]
                    [--continuation-policy <policy.json>]
                    [--max-attempts n] [--json]
  cliyard queue list --repo <path> [--json]
  cliyard queue status --repo <path> [--json]
  cliyard queue retry <queue-id> --repo <path> [--json]
  cliyard queue cancel <queue-id> --repo <path> [--json]
  cliyard queue run --repo <path> [--continue-on-blocked]
                    [--max-dispatches n] [--json]

The queue freezes each contracts file's SHA-256 at add time and dispatches
ready items sequentially through the Supervisor (start, or resume --retry-rejected
for an existing run). add-plan freezes the approved Plan's SHA-256 instead and
compiles queue-owned contracts at a pinned base immediately before dispatch; a
Plan item supports at most one queue dependency. A blocked item stops the run
by default; with --continue-on-blocked independent items continue and
dependants are blocked.
Foreground only: no daemon, no parallel dispatch. The RunManifest remains the
task authority and is never rewritten by the queue.`);
}

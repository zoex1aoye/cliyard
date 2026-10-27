/**
 * `cliyard queue` CLI: durable foreground orchestration over frozen contracts.
 *
 * Commands mutate or inspect `<repo>/.cliyard/queue.json`; `run` dispatches
 * ready items one at a time through the Supervisor CLI. There is no daemon and
 * no parallel dispatch.
 */
import { resolve } from "node:path";
import {
  addQueueItem,
  cancelQueueItem,
  loadQueue,
  queueCounts,
  retryQueueItem,
  type QueueDocument,
  type QueueItem,
  type QueueWorker,
} from "./queue-store.js";
import {
  runQueue,
  type QueueRunSummary,
  type QueueSupervisorRunner,
} from "./queue-runner.js";

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
    case "list":
      return listCommand(rest, log);
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

  const workerRaw = arg("--worker", rest) ?? "claude";
  if (workerRaw !== "claude" && workerRaw !== "codex") {
    throw new Error(
      `queue add: --worker must be claude or codex (got ${workerRaw})`,
    );
  }
  const maxAttemptsRaw = arg("--max-attempts", rest);
  const maxAttempts =
    maxAttemptsRaw === undefined
      ? undefined
      : parsePositiveInt(maxAttemptsRaw, "--max-attempts");

  const item = addQueueItem(repoRoot, {
    id,
    contractsPath: contractsArg,
    dependsOn: values("--depends-on", rest),
    worker: workerRaw as QueueWorker,
    model: arg("--model", rest),
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
  if (item.planId) log(`  plan: ${item.planId}`);
  log(
    `  contracts: ${item.contractsPath} (sha256 ${item.contractsHash})`,
  );
  if (item.reason) log(`  reason: ${item.reason}`);
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
      log(`blocked ${item.id}: ${item.reason ?? "no reason recorded"}`);
    }
  }
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
                    [--model id] [--max-attempts n] [--plan-id id] [--json]
  cliyard queue list --repo <path> [--json]
  cliyard queue retry <queue-id> --repo <path> [--json]
  cliyard queue cancel <queue-id> --repo <path> [--json]
  cliyard queue run --repo <path> [--continue-on-blocked]
                    [--max-dispatches n] [--json]

The queue freezes each contracts file's SHA-256 at add time and dispatches
ready items sequentially through the Supervisor (start, or resume --retry-rejected
for an existing run). A blocked item stops the run by default; with
--continue-on-blocked independent items continue and dependants are blocked.
Foreground only: no daemon, no parallel dispatch. The RunManifest remains the
task authority and is never rewritten by the queue.`);
}

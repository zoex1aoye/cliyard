import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { TaskContract } from "../src/contracts/schema.js";
import { runQueueCli } from "../src/orchestration/cli.js";
import {
  runQueue,
  type QueueSupervisorRequest,
  type QueueSupervisorResult,
  type QueueSupervisorRunner,
} from "../src/orchestration/queue-runner.js";
import {
  QueueLockHeldError,
  acquireQueueLock,
  addQueueItem,
  cancelQueueItem,
  hashFileSha256,
  inspectQueueLock,
  loadQueue,
  queuePaths,
  retryQueueItem,
  withQueueLock,
  type QueueItem,
} from "../src/orchestration/queue-store.js";
import {
  createRunManifest,
  runManifestPath,
  updateRunManifest,
} from "../src/supervisor/store.js";
import type { RunStatus } from "../src/supervisor/types.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const CLI_PATH = fileURLToPath(new URL("../src/cli.ts", import.meta.url));

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function runGit(repo: string, args: string[]): string {
  const result = spawnSync("git", args, { cwd: repo, encoding: "utf8" });
  assert.equal(
    result.status,
    0,
    `git ${args.join(" ")} failed: ${result.stderr}`,
  );
  return result.stdout.trim();
}

function initRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), "cliyard-queue-"));
  runGit(repo, ["init"]);
  runGit(repo, ["config", "user.email", "t@t.com"]);
  runGit(repo, ["config", "user.name", "t"]);
  writeFileSync(join(repo, "README.md"), "# fixture\n");
  runGit(repo, ["add", "."]);
  runGit(repo, ["commit", "-m", "init"]);
  return repo;
}

async function withRepo(fn: (repo: string) => Promise<void>): Promise<void> {
  const repo = initRepo();
  try {
    await fn(repo);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
}

function contract(taskId: string, baseCommit: string): TaskContract {
  return {
    taskId,
    version: 1,
    frozen: true,
    goals: [`Produce ${taskId}`],
    dependsOn: [],
    readPaths: ["."],
    writePaths: [`${taskId}.txt`],
    sharedResources: [],
    baseCommit,
    verifyCommands: [`test -f ${taskId}.txt`],
    maxRepairs: 0,
  };
}

function writeContracts(
  repo: string,
  name = "contracts.json",
  taskId = "task",
): string {
  const base = runGit(repo, ["rev-parse", "HEAD"]);
  const path = join(repo, name);
  writeFileSync(
    path,
    JSON.stringify({ contracts: [contract(taskId, base)] }, null, 2) + "\n",
    "utf8",
  );
  return path;
}

function exitedPid(): number {
  const result = spawnSync(process.execPath, ["-e", "process.exit(0)"], {
    stdio: "ignore",
  });
  assert.ok(result.pid);
  return result.pid;
}

interface RunnerOutcome {
  status?: RunStatus;
  exitCode?: number;
  runId?: string;
  reason?: string;
  delayMs?: number;
  throw?: string;
}

type RunnerSpec =
  | RunnerOutcome
  | ((
      request: QueueSupervisorRequest,
    ) => RunnerOutcome | Promise<RunnerOutcome>);

interface RecordedCall {
  id: string;
  action: "start" | "resume";
  runId?: string;
  persistedStatus?: string;
  persistedAttempts?: number;
}

/**
 * Injected Supervisor runner. It records the queue state it observed at call
 * time, which proves `running`/attempts were persisted before dispatch.
 */
function fakeRunner(
  repo: string,
  specs: Record<string, RunnerSpec> = {},
): { calls: RecordedCall[]; runner: QueueSupervisorRunner } {
  const calls: RecordedCall[] = [];
  let sequence = 0;

  const runner: QueueSupervisorRunner = async (request) => {
    const persisted = loadQueue(repo).items.find(
      (item) => item.id === request.item.id,
    );
    calls.push({
      id: request.item.id,
      action: request.action,
      ...(request.runId !== undefined ? { runId: request.runId } : {}),
      ...(persisted !== undefined
        ? {
            persistedStatus: persisted.status,
            persistedAttempts: persisted.attempts,
          }
        : {}),
    });

    const spec = specs[request.item.id];
    const outcome: RunnerOutcome =
      typeof spec === "function" ? await spec(request) : (spec ?? {});
    if (outcome.delayMs) {
      await new Promise((resolvePromise) =>
        setTimeout(resolvePromise, outcome.delayMs),
      );
    }
    if (outcome.throw) throw new Error(outcome.throw);

    sequence += 1;
    const result: QueueSupervisorResult = {
      exitCode: outcome.exitCode ?? 0,
      status: outcome.status ?? "completed",
      runId: outcome.runId ?? `run-${request.item.id}-${sequence}`,
      ...(outcome.reason !== undefined ? { reason: outcome.reason } : {}),
    };
    return result;
  };
  return { calls, runner };
}

function itemById(repo: string, id: string): QueueItem {
  const item = loadQueue(repo).items.find((candidate) => candidate.id === id);
  assert.ok(item, `queue item ${id} must exist`);
  return item;
}

function statuses(repo: string): Record<string, string> {
  return Object.fromEntries(
    loadQueue(repo).items.map((item) => [item.id, item.status]),
  );
}

function markRunning(
  repo: string,
  id: string,
  runId: string,
  attempts = 1,
): void {
  const document = loadQueue(repo);
  const item = document.items.find((candidate) => candidate.id === id);
  assert.ok(item, `queue item ${id} must exist`);
  item.status = "running";
  item.lastRunId = runId;
  item.attempts = attempts;
  item.nextAction = "resume";
  if (!item.runIds.includes(runId)) item.runIds.push(runId);
  document.updatedAt = new Date().toISOString();
  writeRawQueueDocument(repo, document);
}

/**
 * Write the queue directly, bypassing `saveQueue` validation. Only the cycle
 * fixture needs this; all production writes validate first.
 */
function writeRawQueueDocument(
  repo: string,
  document: ReturnType<typeof loadQueue>,
): void {
  writeFileSync(
    queuePaths(repo).queuePath,
    JSON.stringify(document, null, 2) + "\n",
    "utf8",
  );
}

function createManifest(
  repo: string,
  contractsPath: string,
  runId: string,
  status: RunStatus,
  options: { ownerPid?: number; rejected?: boolean } = {},
): void {
  const base = runGit(repo, ["rev-parse", "HEAD"]);
  createRunManifest(repo, {
    runId,
    planId: `plan-${runId}`,
    contractsPath,
    baseCommit: base,
    integrationBranch: `cliyard/integration/${runId}`,
    tasks: ["task"],
    ...(options.ownerPid !== undefined
      ? { owner: { pid: options.ownerPid, host: hostname() } }
      : {}),
  });
  updateRunManifest(repo, runId, (manifest) => {
    manifest.status = status;
    const task = manifest.tasks["task"]!;
    if (status === "completed") {
      task.accepted = true;
      task.status = "accepted";
    } else if (options.rejected) {
      task.status = "rejected";
      task.accepted = false;
      task.reason = "verify failed";
      task.attemptRejectedAt = new Date().toISOString();
    } else if (status === "blocked") {
      task.status = "blocked";
      task.accepted = false;
      task.reason = "dependencies not accepted";
    }
  });
}

interface CliResult {
  code: number;
  text: string;
  json: any;
}

async function runCli(
  repo: string,
  args: string[],
  runner?: QueueSupervisorRunner,
): Promise<CliResult> {
  const lines: string[] = [];
  const code = await runQueueCli([...args, "--repo", repo], {
    log: (line) => lines.push(line),
    ...(runner !== undefined ? { runner } : {}),
  });
  const text = lines.join("\n");
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  return { code, text, json };
}

// ---------------------------------------------------------------------------
// add / mutation validation
// ---------------------------------------------------------------------------

test("queue add freezes contracts identity and rejects unsafe ids and dependencies", async () => {
  await withRepo(async (repo) => {
    const contracts = writeContracts(repo);
    const item = addQueueItem(repo, {
      id: "alpha",
      contractsPath: contracts,
      worker: "codex",
      model: "fixture-model",
      planId: "plan-alpha",
      maxAttempts: 2,
    });

    assert.equal(item.id, "alpha");
    assert.equal(item.contractsPath, contracts);
    assert.equal(item.contractsHash, hashFileSha256(contracts));
    assert.match(item.contractsHash, /^[0-9a-f]{64}$/);
    assert.equal(item.worker, "codex");
    assert.equal(item.model, "fixture-model");
    assert.equal(item.planId, "plan-alpha");
    assert.deepEqual(item.dependsOn, []);
    assert.equal(item.status, "pending");
    assert.equal(item.attempts, 0);
    assert.equal(item.maxAttempts, 2);
    assert.deepEqual(item.runIds, []);
    assert.equal(item.nextAction, "start");
    assert.ok(!Number.isNaN(Date.parse(item.createdAt)));
    assert.equal(item.createdAt, item.updatedAt);
    assert.deepEqual(loadQueue(repo).items, [item]);

    assert.throws(
      () => addQueueItem(repo, { id: "alpha", contractsPath: contracts }),
      /duplicate queue id/,
    );
    assert.throws(
      () =>
        addQueueItem(repo, {
          id: "../escape",
          contractsPath: contracts,
        }),
      /invalid queue id/,
    );
    assert.throws(
      () =>
        addQueueItem(repo, {
          id: "orphan",
          contractsPath: contracts,
          dependsOn: ["missing"],
        }),
      /depends on unknown item "missing"/,
    );
    assert.throws(
      () =>
        addQueueItem(repo, {
          id: "gone",
          contractsPath: join(repo, "missing.contracts.json"),
        }),
      /contracts file not found/,
    );

    // A cycle that is already on disk is refused at the next mutation.
    addQueueItem(repo, {
      id: "beta",
      contractsPath: contracts,
      dependsOn: ["alpha"],
    });
    const cyclic = loadQueue(repo);
    cyclic.items.find((entry) => entry.id === "alpha")!.dependsOn = ["beta"];
    writeRawQueueDocument(repo, cyclic);
    assert.throws(
      () =>
        addQueueItem(repo, { id: "gamma", contractsPath: contracts }),
      /dependency cycle/,
    );
  });
});

test("queue add/list emit JSON and human summaries through the CLI", async () => {
  await withRepo(async (repo) => {
    const contracts = writeContracts(repo);
    const added = await runCli(repo, [
      "add",
      contracts,
      "--id",
      "first",
      "--worker",
      "codex",
      "--model",
      "fixture-model",
      "--max-attempts",
      "2",
      "--json",
    ]);
    assert.equal(added.code, 0);
    assert.equal(added.json.id, "first");
    assert.equal(added.json.worker, "codex");
    assert.equal(added.json.model, "fixture-model");
    assert.equal(added.json.maxAttempts, 2);
    assert.equal(added.json.status, "pending");

    const second = await runCli(repo, [
      "add",
      contracts,
      "--id",
      "second",
      "--depends-on",
      "first",
      "--json",
    ]);
    assert.equal(second.code, 0);
    assert.deepEqual(second.json.dependsOn, ["first"]);

    const listed = await runCli(repo, ["list", "--json"]);
    assert.equal(listed.code, 0);
    assert.equal(listed.json.version, 1);
    assert.deepEqual(
      listed.json.items.map((item: QueueItem) => item.id),
      ["first", "second"],
    );

    const human = await runCli(repo, ["list"]);
    assert.equal(human.code, 0);
    for (const fragment of [
      "queue: 2 item(s)",
      "first  pending",
      "second  pending",
      "deps=first",
      "contracts:",
    ]) {
      assert.ok(
        human.text.includes(fragment),
        `list output missing ${JSON.stringify(fragment)}:\n${human.text}`,
      );
    }
  });
});

// ---------------------------------------------------------------------------
// Dependency order, attempt persistence, completion monotonicity
// ---------------------------------------------------------------------------

test("queue run dispatches in dependency order and persists running before dispatch", async () => {
  await withRepo(async (repo) => {
    const contracts = writeContracts(repo);
    addQueueItem(repo, { id: "alpha", contractsPath: contracts });
    addQueueItem(repo, {
      id: "beta",
      contractsPath: contracts,
      dependsOn: ["alpha"],
    });
    addQueueItem(repo, {
      id: "gamma",
      contractsPath: contracts,
      dependsOn: ["beta"],
    });
    addQueueItem(repo, { id: "delta", contractsPath: contracts });

    const first = fakeRunner(repo);
    const summary = await runQueue(repo, { runner: first.runner });

    assert.deepEqual(
      first.calls.map((call) => call.id),
      ["alpha", "beta", "gamma", "delta"],
    );
    assert.equal(summary.dispatched, 4);
    assert.deepEqual(statuses(repo), {
      alpha: "completed",
      beta: "completed",
      gamma: "completed",
      delta: "completed",
    });
    assert.deepEqual(summary.counts, {
      total: 4,
      pending: 0,
      running: 0,
      completed: 4,
      blocked: 0,
      cancelled: 0,
    });
    assert.equal(summary.stopped, "idle");
    for (const call of first.calls) {
      assert.equal(
        call.persistedStatus,
        "running",
        `${call.id}: running must be durable before dispatch`,
      );
      assert.equal(
        call.persistedAttempts,
        1,
        `${call.id}: the attempt must increment before dispatch`,
      );
    }
    for (const item of loadQueue(repo).items) {
      assert.equal(item.attempts, 1);
      assert.equal(item.runIds.length, 1);
      assert.equal(item.lastRunId, item.runIds[0]);
      assert.equal(item.nextAction, "resume");
    }

    // Completed is monotonic: a second run performs no dispatch and does not
    // rewrite the queue file.
    const queueBytes = readFileSync(queuePaths(repo).queuePath, "utf8");
    const second = fakeRunner(repo);
    const secondSummary = await runQueue(repo, { runner: second.runner });
    assert.deepEqual(second.calls, []);
    assert.equal(secondSummary.dispatched, 0);
    assert.equal(secondSummary.stopped, "idle");
    assert.deepEqual(statuses(repo), {
      alpha: "completed",
      beta: "completed",
      gamma: "completed",
      delta: "completed",
    });
    assert.equal(
      readFileSync(queuePaths(repo).queuePath, "utf8"),
      queueBytes,
    );

    assert.throws(
      () => retryQueueItem(repo, "alpha"),
      /completed items never run again/,
    );
    assert.throws(
      () => cancelQueueItem(repo, "alpha"),
      /completed items never run again/,
    );
  });
});

test("--max-dispatches bounds one invocation without discarding pending work", async () => {
  await withRepo(async (repo) => {
    const contracts = writeContracts(repo);
    for (const id of ["one", "two", "three"]) {
      addQueueItem(repo, { id, contractsPath: contracts });
    }

    const first = fakeRunner(repo);
    const firstRun = await runQueue(repo, {
      runner: first.runner,
      maxDispatches: 2,
    });
    assert.deepEqual(
      first.calls.map((call) => call.id),
      ["one", "two"],
    );
    assert.equal(firstRun.dispatched, 2);
    assert.equal(firstRun.stopped, "max-dispatches");
    assert.equal(firstRun.counts.pending, 1);
    assert.equal(itemById(repo, "three").status, "pending");

    const second = fakeRunner(repo);
    const secondRun = await runQueue(repo, {
      runner: second.runner,
      maxDispatches: 1,
    });
    assert.deepEqual(
      second.calls.map((call) => call.id),
      ["three"],
    );
    // The bound did not withhold work: the queue finished at the same time.
    assert.equal(secondRun.stopped, "idle");
    assert.equal(secondRun.counts.completed, 3);
  });
});

test("cancelled items are monotonic and are never dispatched", async () => {
  await withRepo(async (repo) => {
    const contracts = writeContracts(repo);
    addQueueItem(repo, { id: "cancelled", contractsPath: contracts });
    addQueueItem(repo, { id: "kept", contractsPath: contracts });

    const cancelled = cancelQueueItem(repo, "cancelled");
    assert.equal(cancelled.status, "cancelled");
    assert.equal(cancelQueueItem(repo, "cancelled").status, "cancelled");
    assert.throws(
      () => retryQueueItem(repo, "cancelled"),
      /cancelled items never run again/,
    );

    const fake = fakeRunner(repo);
    const summary = await runQueue(repo, { runner: fake.runner });
    assert.deepEqual(
      fake.calls.map((call) => call.id),
      ["kept"],
    );
    assert.equal(summary.counts.cancelled, 1);
    assert.equal(itemById(repo, "cancelled").status, "cancelled");
    assert.equal(itemById(repo, "cancelled").runIds.length, 0);
  });
});

// ---------------------------------------------------------------------------
// Blocked stop / continue propagation
// ---------------------------------------------------------------------------

test("default queue run stops at the first blocked item", async () => {
  await withRepo(async (repo) => {
    const contracts = writeContracts(repo);
    addQueueItem(repo, { id: "blocker", contractsPath: contracts });
    addQueueItem(repo, {
      id: "dependent",
      contractsPath: contracts,
      dependsOn: ["blocker"],
    });
    addQueueItem(repo, { id: "independent", contractsPath: contracts });

    const fake = fakeRunner(repo, {
      blocker: {
        status: "blocked",
        exitCode: 1,
        reason: "verification failed",
      },
    });
    const summary = await runQueue(repo, { runner: fake.runner });

    assert.deepEqual(
      fake.calls.map((call) => call.id),
      ["blocker"],
      "default mode must not continue to independent work",
    );
    assert.equal(summary.dispatched, 1);
    assert.equal(summary.stopped, "blocked");
    assert.match(summary.reason!, /verification failed/);
    assert.deepEqual(statuses(repo), {
      blocker: "blocked",
      dependent: "pending",
      independent: "pending",
    });
    const blocker = itemById(repo, "blocker");
    assert.equal(blocker.attempts, 1);
    assert.equal(blocker.lastRunId, "run-blocker-1");
    assert.equal(blocker.nextAction, "resume");
    assert.match(blocker.reason!, /verification failed/);
  });
});

test("default queue run stops before work queued behind an existing block", async () => {
  await withRepo(async (repo) => {
    const contracts = writeContracts(repo);
    addQueueItem(repo, { id: "head", contractsPath: contracts });
    addQueueItem(repo, { id: "behind", contractsPath: contracts });

    const blocking = fakeRunner(repo, {
      head: { status: "blocked", exitCode: 1, reason: "first failure" },
    });
    await runQueue(repo, { runner: blocking.runner });
    assert.deepEqual(statuses(repo), {
      head: "blocked",
      behind: "pending",
    });

    // The block is already durable; a default rerun still refuses to skip
    // past it to later independent work.
    const second = fakeRunner(repo);
    const secondSummary = await runQueue(repo, { runner: second.runner });
    assert.deepEqual(second.calls, []);
    assert.equal(secondSummary.dispatched, 0);
    assert.equal(secondSummary.stopped, "blocked");
    assert.match(secondSummary.reason!, /"head" is blocked/);
    assert.equal(itemById(repo, "behind").status, "pending");

    const third = fakeRunner(repo);
    const thirdSummary = await runQueue(repo, {
      runner: third.runner,
      continueOnBlocked: true,
    });
    assert.deepEqual(
      third.calls.map((call) => call.id),
      ["behind"],
    );
    assert.equal(itemById(repo, "behind").status, "completed");
    assert.equal(thirdSummary.counts.completed, 1);
    assert.equal(thirdSummary.counts.blocked, 1);
  });
});

test("--continue-on-blocked keeps independent work moving and blocks dependants", async () => {
  await withRepo(async (repo) => {
    const contracts = writeContracts(repo);
    addQueueItem(repo, { id: "blocker", contractsPath: contracts });
    addQueueItem(repo, {
      id: "dependent",
      contractsPath: contracts,
      dependsOn: ["blocker"],
    });
    addQueueItem(repo, { id: "independent", contractsPath: contracts });

    const fake = fakeRunner(repo, {
      blocker: { status: "blocked", exitCode: 1, reason: "verify failed" },
    });
    const summary = await runQueue(repo, {
      runner: fake.runner,
      continueOnBlocked: true,
    });

    assert.deepEqual(
      fake.calls.map((call) => call.id),
      ["blocker", "independent"],
    );
    assert.deepEqual(statuses(repo), {
      blocker: "blocked",
      dependent: "blocked",
      independent: "completed",
    });
    const dependent = itemById(repo, "dependent");
    assert.match(dependent.reason!, /dependency "blocker" is blocked/);
    assert.deepEqual(summary.propagated, [
      {
        id: "dependent",
        reason: 'dependency "blocker" is blocked',
      },
    ]);
    // All dispatchable work ran; the blocked pair remains for explicit retry.
    assert.equal(summary.stopped, "idle");
    assert.equal(summary.counts.completed, 1);
    assert.equal(summary.counts.blocked, 2);
  });
});

// ---------------------------------------------------------------------------
// Retry / resume
// ---------------------------------------------------------------------------

test("queue retry resumes the recorded run and falls back to start without one", async () => {
  await withRepo(async (repo) => {
    const contracts = writeContracts(repo);
    addQueueItem(repo, { id: "resumable", contractsPath: contracts });

    const interrupted = fakeRunner(repo, {
      resumable: {
        status: "interrupted",
        exitCode: 1,
        runId: "run-resumable",
      },
    });
    await runQueue(repo, { runner: interrupted.runner });

    const blocked = itemById(repo, "resumable");
    assert.equal(blocked.status, "blocked");
    assert.equal(blocked.lastRunId, "run-resumable");
    assert.deepEqual(blocked.runIds, ["run-resumable"]);
    assert.equal(blocked.nextAction, "resume");
    assert.equal(blocked.attempts, 1);

    // Blocked work is explicit: it is not retried automatically.
    const idle = fakeRunner(repo);
    const idleSummary = await runQueue(repo, { runner: idle.runner });
    assert.deepEqual(idle.calls, []);
    assert.equal(idleSummary.dispatched, 0);

    const retried = await runCli(repo, ["retry", "resumable", "--json"]);
    assert.equal(retried.code, 0);
    assert.equal(retried.json.status, "pending");
    assert.equal(retried.json.nextAction, "resume");
    assert.equal(retried.json.attempts, 1);

    const resumed = fakeRunner(repo, {
      resumable: { status: "completed", runId: "run-resumable" },
    });
    const resumedSummary = await runQueue(repo, { runner: resumed.runner });
    assert.deepEqual(
      resumed.calls.map((call) => ({
        id: call.id,
        action: call.action,
        runId: call.runId,
      })),
      [{ id: "resumable", action: "resume", runId: "run-resumable" }],
    );
    const completed = itemById(repo, "resumable");
    assert.equal(completed.status, "completed");
    assert.deepEqual(completed.runIds, ["run-resumable"]);
    assert.equal(completed.attempts, 2);
    assert.equal(resumedSummary.counts.completed, 1);

    // A dispatch with no durable run retries with a fresh `start`.
    addQueueItem(repo, { id: "fresh", contractsPath: contracts });
    const crashed = fakeRunner(repo, { fresh: { throw: "spawn exploded" } });
    await runQueue(repo, { runner: crashed.runner });
    const failed = itemById(repo, "fresh");
    assert.equal(failed.status, "blocked");
    assert.equal(failed.lastRunId, undefined);
    assert.equal(failed.nextAction, "start");
    assert.match(failed.reason!, /spawn exploded/);

    retryQueueItem(repo, "fresh");
    assert.equal(itemById(repo, "fresh").nextAction, "start");

    const restarted = fakeRunner(repo, {
      fresh: { status: "completed", runId: "run-fresh" },
    });
    await runQueue(repo, { runner: restarted.runner });
    assert.deepEqual(
      restarted.calls.map((call) => call.action),
      ["start"],
    );
    assert.equal(itemById(repo, "fresh").status, "completed");
  });
});

// ---------------------------------------------------------------------------
// Frozen contracts
// ---------------------------------------------------------------------------

test("changed or missing contracts fail closed before dispatch", async () => {
  await withRepo(async (repo) => {
    const changedContracts = writeContracts(repo, "changed.json", "changed");
    const removedContracts = writeContracts(repo, "removed.json", "removed");
    addQueueItem(repo, {
      id: "changed",
      contractsPath: changedContracts,
    });
    addQueueItem(repo, {
      id: "removed",
      contractsPath: removedContracts,
    });

    writeFileSync(changedContracts, `${readFileSync(changedContracts, "utf8")}\n`, "utf8");
    unlinkSync(removedContracts);

    const fake = fakeRunner(repo);
    const summary = await runQueue(repo, {
      runner: fake.runner,
      continueOnBlocked: true,
    });

    assert.deepEqual(fake.calls, []);
    assert.equal(summary.dispatched, 0);
    assert.equal(itemById(repo, "changed").status, "blocked");
    assert.equal(itemById(repo, "removed").status, "blocked");
    assert.equal(itemById(repo, "changed").attempts, 0);
    assert.equal(itemById(repo, "removed").attempts, 0);
    assert.match(itemById(repo, "changed").reason!, /contracts changed/);
    assert.match(
      itemById(repo, "removed").reason!,
      /missing or unreadable/,
    );
    assert.equal(summary.counts.blocked, 2);
  });
});

// ---------------------------------------------------------------------------
// Stale running recovery
// ---------------------------------------------------------------------------

test("a stale queue lock is reclaimed and running items reconcile against their RunManifest", async () => {
  await withRepo(async (repo) => {
    const contracts = writeContracts(repo);
    addQueueItem(repo, { id: "done", contractsPath: contracts });
    addQueueItem(repo, { id: "resume", contractsPath: contracts });
    addQueueItem(repo, { id: "missing", contractsPath: contracts });
    addQueueItem(repo, {
      id: "capped",
      contractsPath: contracts,
      maxAttempts: 3,
    });
    addQueueItem(repo, { id: "rejected", contractsPath: contracts });
    addQueueItem(repo, { id: "live", contractsPath: contracts });

    createManifest(repo, contracts, "run-done", "completed");
    createManifest(repo, contracts, "run-resume", "interrupted");
    createManifest(repo, contracts, "run-capped", "interrupted");
    createManifest(repo, contracts, "run-rejected", "blocked", {
      rejected: true,
    });
    createManifest(repo, contracts, "run-live", "running", {
      ownerPid: process.pid,
    });

    markRunning(repo, "done", "run-done");
    markRunning(repo, "resume", "run-resume");
    markRunning(repo, "missing", "run-missing");
    markRunning(repo, "capped", "run-capped", 3);
    markRunning(repo, "rejected", "run-rejected");
    markRunning(repo, "live", "run-live");

    // Simulate a runner that died after persisting `running`.
    const deadPid = exitedPid();
    writeFileSync(
      queuePaths(repo).lockPath,
      JSON.stringify({
        pid: deadPid,
        host: hostname(),
        token: "dead-runner-token",
        acquiredAt: new Date().toISOString(),
      }) + "\n",
      "utf8",
    );
    assert.equal(inspectQueueLock(repo).state, "stale");
    const resumeManifestBytes = readFileSync(
      runManifestPath(repo, "run-resume"),
      "utf8",
    );

    const fake = fakeRunner(repo, {
      resume: { status: "completed", runId: "run-resume" },
      rejected: { status: "completed", runId: "run-rejected" },
    });
    const summary = await runQueue(repo, {
      runner: fake.runner,
      continueOnBlocked: true,
    });

    assert.deepEqual(
      fake.calls.map((call) => ({
        id: call.id,
        action: call.action,
        runId: call.runId,
      })),
      [
        { id: "resume", action: "resume", runId: "run-resume" },
        { id: "rejected", action: "resume", runId: "run-rejected" },
      ],
      "completed evidence is not redone; existing runs are resumed",
    );
    assert.deepEqual(statuses(repo), {
      done: "completed",
      resume: "completed",
      missing: "blocked",
      capped: "blocked",
      rejected: "completed",
      live: "blocked",
    });
    assert.equal(summary.counts.completed, 3);
    assert.equal(summary.counts.blocked, 3);
    assert.equal(summary.reconciled.length, 6);
    assert.match(
      itemById(repo, "missing").reason!,
      /run manifest not found/,
    );
    assert.match(itemById(repo, "capped").reason!, /attempt limit reached/);
    assert.match(itemById(repo, "live").reason!, /live process/);
    assert.equal(itemById(repo, "resume").attempts, 2);
    assert.deepEqual(itemById(repo, "resume").runIds, ["run-resume"]);
    // The queue reads the manifest as authority and never rewrites it.
    assert.equal(
      readFileSync(runManifestPath(repo, "run-resume"), "utf8"),
      resumeManifestBytes,
    );
    assert.equal(inspectQueueLock(repo).state, "free");
    assert.equal(existsSync(queuePaths(repo).lockPath), false);
  });
});

// ---------------------------------------------------------------------------
// Lock serialization
// ---------------------------------------------------------------------------

test("queue lock serializes concurrent runs and fails closed on foreign or invalid owners", async () => {
  await withRepo(async (repo) => {
    const contracts = writeContracts(repo);
    addQueueItem(repo, { id: "alpha", contractsPath: contracts });
    addQueueItem(repo, { id: "beta", contractsPath: contracts });
    const lockPath = queuePaths(repo).lockPath;

    // Stale same-host lock: dead PID is reclaimable.
    const deadPid = exitedPid();
    writeFileSync(
      lockPath,
      JSON.stringify({
        pid: deadPid,
        host: hostname(),
        token: "stale-token",
        acquiredAt: new Date().toISOString(),
      }) + "\n",
      "utf8",
    );
    const reclaimed = acquireQueueLock(repo);
    assert.equal(reclaimed.lock.pid, process.pid);
    reclaimed.release();
    assert.equal(existsSync(lockPath), false);

    // Live same-host lock: a second acquisition fails closed.
    const held = acquireQueueLock(repo);
    try {
      assert.throws(() => acquireQueueLock(repo), QueueLockHeldError);
      assert.throws(
        () => withQueueLock(repo, () => undefined),
        QueueLockHeldError,
      );
    } finally {
      held.release();
    }

    // Foreign-host lock: liveness is unknowable, so even a waiting run fails
    // immediately instead of treating it as stale.
    writeFileSync(
      lockPath,
      JSON.stringify({
        pid: process.pid,
        host: "remote-fixture-host",
        token: "remote-token",
        acquiredAt: new Date().toISOString(),
      }) + "\n",
      "utf8",
    );
    await assert.rejects(
      runQueue(repo, {
        runner: fakeRunner(repo).runner,
        lockTimeoutMs: 1_000,
      }),
      /remote-fixture-host|liveness cannot be checked/,
    );
    unlinkSync(lockPath);

    // Invalid JSON is ambiguous and fails closed.
    writeFileSync(lockPath, "{not-json", "utf8");
    assert.throws(() => acquireQueueLock(repo), /queue lock .* invalid/);
    unlinkSync(lockPath);

    // Two concurrent foreground runs serialize on the queue lock: each item
    // is dispatched exactly once, never in parallel.
    const fake = fakeRunner(repo, {
      alpha: { delayMs: 100 },
      beta: { delayMs: 100 },
    });
    const [first, second] = await Promise.all([
      runQueue(repo, { runner: fake.runner }),
      runQueue(repo, { runner: fake.runner }),
    ]);
    assert.deepEqual(
      fake.calls.map((call) => call.id),
      ["alpha", "beta"],
    );
    assert.equal(
      new Set(fake.calls.map((call) => call.id)).size,
      fake.calls.length,
      "no item may be dispatched twice",
    );
    assert.equal(first.dispatched + second.dispatched, 2);
    assert.deepEqual(statuses(repo), {
      alpha: "completed",
      beta: "completed",
    });
    assert.equal(existsSync(lockPath), false);
  });
});

// ---------------------------------------------------------------------------
// CLI run summaries / top-level wiring
// ---------------------------------------------------------------------------

test("queue run JSON/human summaries and top-level cliyard queue wiring", async () => {
  await withRepo(async (repo) => {
    const contracts = writeContracts(repo);
    await runCli(repo, ["add", contracts, "--id", "first", "--json"]);
    await runCli(repo, [
      "add",
      contracts,
      "--id",
      "second",
      "--depends-on",
      "first",
      "--json",
    ]);

    const fake = fakeRunner(repo);
    const firstRun = await runCli(
      repo,
      ["run", "--max-dispatches", "1", "--json"],
      fake.runner,
    );
    assert.equal(firstRun.code, 0);
    assert.equal(firstRun.json.dispatched, 1);
    assert.equal(firstRun.json.stopped, "max-dispatches");
    assert.equal(firstRun.json.counts.completed, 1);
    assert.equal(firstRun.json.counts.pending, 1);
    assert.deepEqual(
      firstRun.json.dispatches.map((entry: any) => entry.id),
      ["first"],
    );

    const secondRun = await runCli(repo, ["run"], fake.runner);
    assert.equal(secondRun.code, 0);
    assert.match(secondRun.text, /dispatched: 1/);
    assert.match(secondRun.text, /second\s+start/);
    assert.match(secondRun.text, /queue: pending 0 \/ running 0 \/ completed 2/);

    // A blocked dispatch exits non-zero and the JSON summary carries the exact
    // reason and the resume pointer.
    await runCli(repo, ["add", contracts, "--id", "third", "--json"]);
    const blockedRun = await runCli(
      repo,
      ["run", "--json"],
      fakeRunner(repo, {
        third: {
          status: "blocked",
          exitCode: 1,
          reason: "fixture rejection",
        },
      }).runner,
    );
    assert.equal(blockedRun.code, 1);
    assert.equal(blockedRun.json.dispatches[0].status, "blocked");
    assert.equal(blockedRun.json.items.find((item: QueueItem) => item.id === "third").reason, "fixture rejection");
    assert.equal(blockedRun.json.counts.blocked, 1);

    const retry = await runCli(repo, ["retry", "third", "--json"]);
    assert.equal(retry.code, 0);
    assert.equal(retry.json.status, "pending");
    assert.equal(retry.json.nextAction, "resume");

    const cancelled = await runCli(repo, ["cancel", "third", "--json"]);
    assert.equal(cancelled.code, 0);
    assert.equal(cancelled.json.status, "cancelled");
    await assert.rejects(
      runCli(repo, ["retry", "third"]),
      /cancelled items never run again/,
    );

    // Cancelled items never dispatch.
    const afterCancel = fakeRunner(repo);
    const afterCancelRun = await runCli(repo, ["run", "--json"], afterCancel.runner);
    assert.equal(afterCancelRun.code, 0);
    assert.equal(afterCancelRun.json.dispatched, 0);
    assert.equal(itemById(repo, "third").status, "cancelled");

    // The installed `cliyard queue` path is wired through src/cli.ts.
    const wired = spawnSync(
      process.execPath,
      [
        "--import",
        "tsx",
        CLI_PATH,
        "queue",
        "list",
        "--repo",
        repo,
        "--json",
      ],
      { cwd: ROOT, encoding: "utf8" },
    );
    assert.equal(wired.status, 0, wired.stderr);
    const listed = JSON.parse(wired.stdout) as {
      items: Array<{ id: string; status: string }>;
    };
    assert.deepEqual(
      listed.items.map((item) => [item.id, item.status]),
      [
        ["first", "completed"],
        ["second", "completed"],
        ["third", "cancelled"],
      ],
    );
  });
});

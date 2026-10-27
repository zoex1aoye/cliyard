import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runQueueCli } from "../src/orchestration/cli.js";
import {
  addQueueItem,
  loadQueue,
  queuePaths,
} from "../src/orchestration/queue-store.js";
import {
  appendQueueEvent,
  queueEventJournalPath,
  readQueueEventJournal,
  tryAppendQueueEvent,
} from "../src/orchestration/event-journal.js";
import {
  buildControlSnapshot,
} from "../src/orchestration/control-snapshot.js";
import {
  runQueue,
  type QueueSupervisorRunner,
} from "../src/orchestration/queue-runner.js";
import {
  appendWorkerProgressEvent,
  workerEventLogPath,
} from "../src/scheduler/codex-batch.js";
import {
  createRunManifest,
  updateRunManifest,
} from "../src/supervisor/store.js";

const CLI_PATH = fileURLToPath(new URL("../src/cli.ts", import.meta.url));

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
  const repo = mkdtempSync(join(tmpdir(), "cliyard-control-"));
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

function writeContracts(repo: string): {
  path: string;
  baseCommit: string;
} {
  const baseCommit = runGit(repo, ["rev-parse", "HEAD"]);
  const path = join(repo, "contracts.json");
  writeFileSync(
    path,
    JSON.stringify(
      {
        contracts: [
          {
            taskId: "task",
            version: 1,
            frozen: true,
            goals: ["Produce task.txt"],
            dependsOn: [],
            readPaths: ["."],
            writePaths: ["task.txt"],
            sharedResources: [],
            baseCommit,
            verifyCommands: ["test -f task.txt"],
            maxRepairs: 0,
          },
        ],
      },
      null,
      2,
    ) + "\n",
    "utf8",
  );
  return { path, baseCommit };
}

function setQueueState(
  repo: string,
  id: string,
  state: {
    status: "running" | "blocked";
    attempts: number;
    runId?: string;
    reason?: string;
  },
): void {
  const document = loadQueue(repo);
  const item = document.items.find((candidate) => candidate.id === id);
  assert.ok(item);
  item.status = state.status;
  item.attempts = state.attempts;
  item.nextAction = state.runId ? "resume" : "start";
  if (state.runId) {
    item.lastRunId = state.runId;
    item.runIds = [state.runId];
  }
  if (state.reason) item.reason = state.reason;
  document.updatedAt = new Date().toISOString();
  writeFileSync(
    queuePaths(repo).queuePath,
    JSON.stringify(document, null, 2) + "\n",
    "utf8",
  );
}

async function runCli(
  repo: string,
  args: string[],
): Promise<{ code: number; json: any; text: string }> {
  const lines: string[] = [];
  const code = await runQueueCli([...args, "--repo", repo], {
    log: (line) => lines.push(line),
  });
  const text = lines.join("\n");
  return { code, text, json: JSON.parse(text) };
}

test("queue status is read-only when no state exists", async () => {
  await withRepo(async (repo) => {
    const before = new Set<string>();
    const snapshot = await buildControlSnapshot(repo);
    assert.equal(snapshot.counts.total, 0);
    assert.equal(snapshot.queue.lock.state, "free");
    assert.equal(snapshot.journal.exists, false);
    assert.equal(snapshot.resources.provider.length, 0);
    assert.deepEqual(
      new Set(
        existsSync(join(repo, ".cliyard"))
          ? [".cliyard"]
          : [],
      ),
      before,
      "status must not create control-plane files",
    );

    const child = spawnSync(
      process.execPath,
      ["--import", "tsx", CLI_PATH, "queue", "status", "--repo", repo, "--json"],
      { encoding: "utf8" },
    );
    assert.equal(child.status, 0, child.stderr);
    const cli = JSON.parse(child.stdout) as { counts: { total: number } };
    assert.equal(cli.counts.total, 0);
    assert.equal(existsSync(join(repo, ".cliyard")), false);
  });
});

test("queue status joins run, task, worker progress and line-age evidence", async () => {
  await withRepo(async (repo) => {
    const contracts = writeContracts(repo);
    const item = addQueueItem(repo, {
      id: "active",
      contractsPath: contracts.path,
      worker: "claude",
      model: "subscription-model",
    });
    addQueueItem(repo, {
      id: "ready",
      contractsPath: contracts.path,
      worker: "claude",
      model: "subscription-model",
    });
    const runId = "run-active";
    setQueueState(repo, item.id, {
      status: "running",
      attempts: 1,
      runId,
    });
    createRunManifest(repo, {
      runId,
      planId: "plan-active",
      contractsPath: contracts.path,
      baseCommit: contracts.baseCommit,
      integrationBranch: `cliyard/integration/${runId}`,
      tasks: ["task"],
    });
    updateRunManifest(repo, runId, (manifest) => {
      manifest.tasks.task!.status = "running";
    });

    const eventPath = workerEventLogPath(repo, runId, "task");
    mkdirSync(dirname(eventPath), { recursive: true });
    const started = {
      version: 1,
      at: new Date(Date.now() - 100).toISOString(),
      source: "claude",
      taskId: "task",
      sessionId: "session-1",
      type: "session.start",
      phase: "starting",
      message: "session started",
    };
    const tool = {
      ...started,
      at: new Date().toISOString(),
      type: "tool.start",
      phase: "tool",
      message: "running verification",
    };
    writeFileSync(
      eventPath,
      [JSON.stringify(started), "{truncated", JSON.stringify(tool), ""].join(
        "\n",
      ),
      "utf8",
    );
    appendQueueEvent(repo, {
      type: "attempt.started",
      itemId: item.id,
      runId,
      attempt: 1,
      action: "start",
    });

    const queueBefore = readFileSync(queuePaths(repo).queuePath, "utf8");
    const journalBefore = readFileSync(queueEventJournalPath(repo), "utf8");
    const snapshot = await buildControlSnapshot(repo);
    const active = snapshot.items.find((entry) => entry.id === item.id);
    assert.ok(active);
    assert.equal(active.status, "running");
    assert.equal(active.ready, false);
    assert.equal(active.observedNextAction, "reconcile-running-item");
    assert.equal(active.decision.category, "infrastructure");
    assert.match(active.decision.reason ?? "", /queue lock is free/);
    assert.equal(active.contracts?.path, contracts.path);
    assert.equal(active.contracts?.hash, item.contractsHash);
    assert.equal(active.run?.runId, runId);
    assert.equal(active.run?.contractsMatch, true);
    assert.equal(active.run?.tasks[0]?.status, "running");
    assert.equal(active.run?.workerProgress[0]?.event.type, "tool.start");
    assert.equal(active.run?.workerProgress[0]?.event.sessionId, "session-1");
    assert.equal(active.journalEvents.at(-1)?.type, "attempt.started");
    assert.equal(active.errors.length, 0);
    const ready = snapshot.items.find((entry) => entry.id === "ready");
    assert.ok(ready);
    assert.equal(ready.ready, true);
    assert.equal(ready.observedNextAction, "dispatch-start");
    assert.equal(ready.decision.category, "none");

    const provider = snapshot.resources.provider[0];
    assert.equal(provider?.runtimeId, "claude");
    assert.equal(provider?.modelId, "subscription-model");
    assert.equal(provider?.observedInFlight, 1);
    assert.equal(provider?.capacity.configuredMax, null);
    assert.equal(provider?.capacity.learnedSafeInFlight, null);
    assert.equal(provider?.capacity.limitSource, "unknown");
    assert.equal(provider?.quota.state, "unknown");
    assert.equal(provider?.balance.state, "unknown");
    assert.equal(provider?.pricing.state, "unknown");

    assert.equal(
      readFileSync(queuePaths(repo).queuePath, "utf8"),
      queueBefore,
      "queue status must not rewrite queue authority",
    );
    assert.equal(
      readFileSync(queueEventJournalPath(repo), "utf8"),
      journalBefore,
      "queue status must not append journal events",
    );

    const cli = await runCli(repo, ["status", "--json"]);
    assert.equal(cli.code, 0);
    assert.equal(cli.json.version, 1);
    assert.equal(cli.json.items[0].run.workerProgress[0].event.type, "tool.start");
    assert.equal(cli.json.resources.provider[0].capacity.configuredMax, null);

    const humanLines: string[] = [];
    assert.equal(
      await runQueueCli(["status", "--repo", repo], {
        log: (line) => humanLines.push(line),
      }),
      0,
    );
    const human = humanLines.join("\n");
    for (const fragment of [
      "queue: 2 item(s)",
      "active  running",
      "next=reconcile-running-item",
      "capacity=unknown",
      "quota=unknown",
      "worker: tool.start/tool",
      "journal: attempt.started",
    ]) {
      assert.ok(human.includes(fragment), `missing ${fragment}:\n${human}`);
    }
  });
});

test("queue status reports missing manifests and malformed journal lines without failing", async () => {
  await withRepo(async (repo) => {
    const contracts = writeContracts(repo);
    addQueueItem(repo, {
      id: "damaged",
      contractsPath: contracts.path,
    });
    setQueueState(repo, "damaged", {
      status: "blocked",
      attempts: 1,
      runId: "missing-run",
      reason: "provider process ended without a manifest",
    });
    tryAppendQueueEvent(repo, {
      type: "run.blocked",
      itemId: "damaged",
      runId: "missing-run",
      reason: "provider process ended without a manifest",
    });
    writeFileSync(
      queueEventJournalPath(repo),
      `${JSON.stringify({
        version: 1,
        eventId: "bad?",
        at: "not-a-date",
        type: "run.blocked",
      })}\n{broken\n`,
      { encoding: "utf8", flag: "a" },
    );

    const snapshot = await buildControlSnapshot(repo);
    const damaged = snapshot.items[0]!;
    assert.equal(snapshot.journal.malformedLines, 2);
    assert.equal(damaged.decision.category, "infrastructure");
    assert.equal(damaged.observedNextAction, "inspect-and-retry");
    assert.match(damaged.errors[0] ?? "", /run missing-run:/);
    assert.equal(damaged.run, null);
  });
});

test("queue mutations and dispatch append bounded lifecycle events", async () => {
  await withRepo(async (repo) => {
    const contracts = writeContracts(repo);
    addQueueItem(repo, { id: "failure", contractsPath: contracts.path });

    const runner: QueueSupervisorRunner = async (request) => {
      assert.equal(request.item.status, "running");
      return {
        exitCode: 1,
        runId: "run-failure",
        status: "blocked",
        reason: "provider timeout",
      };
    };
    await runQueue(repo, { runner });

    let journal = readQueueEventJournal(repo);
    assert.deepEqual(
      journal.events.map((event) => event.type),
      [
        "queue.item.added",
        "attempt.started",
        "run.started",
        "run.blocked",
      ],
    );
    assert.equal(journal.events[1]?.attempt, 1);
    assert.equal(journal.events[3]?.runId, "run-failure");

    const retried = await runCli(repo, ["retry", "failure", "--json"]);
    assert.equal(retried.code, 0);
    journal = readQueueEventJournal(repo);
    assert.equal(journal.events.at(-1)?.type, "queue.retry");

    const cancelled = await runCli(repo, ["cancel", "failure", "--json"]);
    assert.equal(cancelled.code, 0);
    journal = readQueueEventJournal(repo);
    assert.equal(journal.events.at(-1)?.type, "queue.cancel");
    assert.equal(loadQueue(repo).items[0]?.status, "cancelled");
  });
});

test("worker session progress adds provider lifecycle journal events", async () => {
  await withRepo(async (repo) => {
    const at = new Date().toISOString();
    appendWorkerProgressEvent(repo, "run-session", {
      version: 1,
      at,
      source: "claude",
      taskId: "task",
      sessionId: "session-a",
      type: "session.start",
      phase: "starting",
      message: "started",
    });
    appendWorkerProgressEvent(repo, "run-session", {
      version: 1,
      at,
      source: "claude",
      taskId: "task",
      sessionId: "session-a",
      type: "result",
      phase: "ending",
      message: "finished",
    });
    const journal = readQueueEventJournal(repo);
    assert.deepEqual(
      journal.events.map((event) => event.type),
      ["provider.session.started", "provider.session.ended"],
    );
    assert.equal(journal.events[0]?.taskId, "task");
    assert.equal(journal.events[0]?.sessionId, "session-a");
  });
});

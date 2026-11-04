import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildControlSnapshot,
  type ControlSnapshot,
} from "../src/orchestration/control-snapshot.js";
import {
  appendQueueEvent,
  queueEventJournalPath,
} from "../src/orchestration/event-journal.js";
import {
  addQueueItem,
  loadQueue,
  queuePaths,
} from "../src/orchestration/queue-store.js";
import {
  createRunManifest,
  updateRunManifest,
  runManifestPath,
} from "../src/supervisor/store.js";
import { defaultLedgerPath } from "../src/persistence/ledger.js";
import {
  buildStateStoreReadView,
  compareControlSnapshotParity,
  compareSemanticValues,
} from "../src/statestore/read.js";

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
  const repo = mkdtempSync(join(tmpdir(), "cliyard-statestore-read-"));
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
  state: { status: "running"; attempts: number; runId: string },
): void {
  const document = loadQueue(repo);
  const item = document.items.find((candidate) => candidate.id === id);
  assert.ok(item);
  item.status = state.status;
  item.attempts = state.attempts;
  item.nextAction = "resume";
  item.lastRunId = state.runId;
  item.runIds = [state.runId];
  document.updatedAt = new Date().toISOString();
  writeFileSync(
    queuePaths(repo).queuePath,
    JSON.stringify(document, null, 2) + "\n",
    "utf8",
  );
}

/** Queue item + RunManifest + journal event + ledger record. */
function seedFixture(repo: string): { runId: string } {
  const contracts = writeContracts(repo);
  const active = addQueueItem(repo, {
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
  setQueueState(repo, active.id, { status: "running", attempts: 1, runId });
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
  appendQueueEvent(repo, {
    type: "attempt.started",
    itemId: active.id,
    runId,
    attempt: 1,
    action: "start",
  });
  writeFileSync(
    defaultLedgerPath(repo),
    JSON.stringify(
      {
        tasks: {
          task: {
            taskId: "task",
            status: "accepted",
            repairCount: 0,
            contract: {
              path: contracts.path,
              hash: active.contractsHash,
            },
            events: [
              {
                at: "2026-01-01T00:00:00.000Z",
                type: "task.accepted",
                status: "accepted",
              },
            ],
            sessionIds: ["session-1"],
            verdict: "accepted",
          },
        },
      },
      null,
      2,
    ) + "\n",
    "utf8",
  );
  return { runId };
}

function readWritePaths(repo: string, runId: string): Record<string, string> {
  return {
    queue: readFileSync(queuePaths(repo).queuePath, "utf8"),
    journal: readFileSync(queueEventJournalPath(repo), "utf8"),
    run: readFileSync(runManifestPath(repo, runId), "utf8"),
    ledger: readFileSync(defaultLedgerPath(repo), "utf8"),
  };
}

/**
 * Durable control state. The read projection intentionally carries the exact
 * snapshot value, but acceptance compares this stable subset so host-sampled
 * resources and read-time worker ages never decide parity.
 */
function durableStatus(snapshot: ControlSnapshot): unknown {
  return {
    counts: snapshot.counts,
    failureCounts: snapshot.failureCounts,
    cost: snapshot.cost,
    journal: {
      path: snapshot.journal.path,
      exists: snapshot.journal.exists,
      totalEvents: snapshot.journal.totalEvents,
      malformedLines: snapshot.journal.malformedLines,
      events: snapshot.journal.events,
      lastEventAt: snapshot.journal.lastEventAt,
      readError: snapshot.journal.readError,
    },
    items: snapshot.items.map((item) => ({
      id: item.id,
      status: item.status,
      attempts: item.attempts,
      runIds: item.runIds,
      ready: item.ready,
      retryable: item.retryable,
      observedNextAction: item.observedNextAction,
      decision: item.decision,
      errors: item.errors,
      journalEvents: item.journalEvents,
      run:
        item.run === null
          ? null
          : {
              runId: item.run.runId,
              status: item.run.status,
              effectiveStatus: item.run.effectiveStatus,
              tasks: item.run.tasks,
            },
    })),
  };
}

test("projection is semantically equivalent to the control snapshot", async () => {
  await withRepo(async (repo) => {
    const { runId } = seedFixture(repo);
    const before = readWritePaths(repo, runId);
    const expected = await buildControlSnapshot(repo);
    const view = await buildStateStoreReadView(repo, {
      controlSnapshot: expected,
    });

    const comparison = compareControlSnapshotParity(expected, view.status);
    assert.equal(
      comparison.equal,
      true,
      JSON.stringify(comparison.differences, null, 2),
    );
    // Byte equality is a diagnostic, not the gate: the projection round-trips
    // through canonical JSON, so key order legitimately differs.
    assert.equal(comparison.byteIdentical, false);
    assert.equal(view.status.observedAt, expected.observedAt);
    const journalEvents = expected.journal.events.length;
    assert.equal(view.store.sources.snapshot, 1);
    assert.equal(view.store.sources.queue, 1);
    assert.equal(view.store.sources.run, 1);
    assert.equal(view.store.sources.ledger, 1);
    assert.equal(view.store.sources.journal, 1 + journalEvents);
    assert.equal(view.store.recordCount, 5 + journalEvents);
    assert.equal(view.store.factCount, 3 * (5 + journalEvents));
    assert.equal(
      view.events.journal.totalEvents,
      expected.journal.totalEvents,
    );
    assert.equal(
      view.events.journal.events.at(-1)?.type,
      "attempt.started",
    );
    assert.equal(view.events.ledger.tasks.length, 1);
    assert.equal(view.events.ledger.tasks[0]?.taskId, "task");
    assert.equal(view.events.errors.length, 0);

    assert.deepEqual(
      readWritePaths(repo, runId),
      before,
      "the read projection must not touch JSON write paths",
    );
  });
});

test("float tolerance is the gate and byte equality is diagnostic", () => {
  const close = compareSemanticValues(
    { estimatedUsd: 0.30000000000000004 },
    { estimatedUsd: 0.3 },
  );
  assert.equal(close.equal, true);
  assert.equal(close.byteIdentical, false);

  const outside = compareSemanticValues(
    { estimatedUsd: 0.3 },
    { estimatedUsd: 0.4 },
  );
  assert.equal(outside.equal, false);
  assert.equal(outside.differences[0]?.kind, "number");

  const tightened = compareSemanticValues(
    { estimatedUsd: 0.30000000000000004 },
    { estimatedUsd: 0.3 },
    { floatTolerance: 0 },
  );
  assert.equal(tightened.equal, false);
});

test("default pipeline projects the same durable control state", async () => {
  await withRepo(async (repo) => {
    seedFixture(repo);
    const view = await buildStateStoreReadView(repo);
    const fresh = await buildControlSnapshot(repo);
    assert.deepEqual(
      durableStatus(view.status),
      durableStatus(fresh),
    );
    assert.equal(view.status.items.length, 2);
    assert.deepEqual(
      view.events.errors,
      [],
      JSON.stringify(view.events.errors),
    );
    assert.equal(view.events.ledger.tasks[0]?.verdict, "accepted");
  });
});

function runStatestoreJson(
  repo: string,
  command: "status" | "events",
): string {
  const child = spawnSync(
    process.execPath,
    [
      "--import",
      "tsx",
      CLI_PATH,
      "statestore",
      command,
      "--repo",
      repo,
      "--json",
    ],
    { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
  );
  assert.equal(child.status, 0, child.stderr);
  return child.stdout;
}

test("a fresh process rebuilds the same view", async () => {
  await withRepo(async (repo) => {
    seedFixture(repo);

    const firstEvents = runStatestoreJson(repo, "events");
    const secondEvents = runStatestoreJson(repo, "events");
    assert.equal(
      secondEvents,
      firstEvents,
      "events output must be identical across fresh processes",
    );
    const events = JSON.parse(firstEvents) as {
      store: { seedHash: string; sources: Record<string, number> };
      journal: { totalEvents: number };
      ledger: { tasks: Array<{ taskId: string }> };
    };
    assert.equal(
      events.store.sources.run,
      1,
      JSON.stringify(events.store),
    );
    assert.equal(
      events.journal.totalEvents,
      3,
      JSON.stringify(events.journal),
    );
    assert.equal(events.ledger.tasks[0]?.taskId, "task");

    const firstStatus = JSON.parse(
      runStatestoreJson(repo, "status"),
    ) as ControlSnapshot;
    const secondStatus = JSON.parse(
      runStatestoreJson(repo, "status"),
    ) as ControlSnapshot;
    assert.deepEqual(
      durableStatus(firstStatus),
      durableStatus(secondStatus),
    );
    assert.equal(firstStatus.items.length, 2);
  });
});

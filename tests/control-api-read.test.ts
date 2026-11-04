import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CliyardDaemon } from "../src/daemon/core.js";
import { startControlApiDaemon } from "../src/daemon/http.js";
import {
  appendQueueEvent,
  queueEventJournalPath,
} from "../src/orchestration/event-journal.js";
import {
  addQueueItem,
  loadQueue,
  queuePaths,
} from "../src/orchestration/queue-store.js";
import { defaultLedgerPath } from "../src/persistence/ledger.js";
import {
  createRunManifest,
  runManifestPath,
  updateRunManifest,
} from "../src/supervisor/store.js";

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
  const repo = mkdtempSync(join(tmpdir(), "cliyard-control-api-"));
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

/** Durable JSON truth that the read-only API must not touch. */
function readAuthorityFiles(
  repo: string,
  runId: string,
): Record<string, string> {
  return {
    queue: readFileSync(queuePaths(repo).queuePath, "utf8"),
    journal: readFileSync(queueEventJournalPath(repo), "utf8"),
    run: readFileSync(runManifestPath(repo, runId), "utf8"),
    ledger: readFileSync(defaultLedgerPath(repo), "utf8"),
  };
}

// ---------------------------------------------------------------------------
// Client helpers
// ---------------------------------------------------------------------------

async function startApi(repo: string): Promise<CliyardDaemon> {
  return startControlApiDaemon({
    repoRoot: repo,
    port: 0,
    pid: process.pid,
    isAlive: () => true,
    readStartIdentity: () => "control-api-test-identity",
  });
}

function baseUrl(daemon: CliyardDaemon): string {
  return `http://${daemon.info.address.host}:${daemon.info.address.port}`;
}

interface JsonResponse {
  status: number;
  headers: Headers;
  body: Record<string, any>;
}

async function getJson(url: string): Promise<JsonResponse> {
  const response = await fetch(url);
  const text = await response.text();
  return {
    status: response.status,
    headers: response.headers,
    body: text.length === 0 ? {} : (JSON.parse(text) as Record<string, any>),
  };
}

type EventLine = { cursor: string } & Record<string, any>;

function parseNdjson(text: string): EventLine[] {
  return text
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as EventLine);
}

// ---------------------------------------------------------------------------
// Endpoint coverage
// ---------------------------------------------------------------------------

test(
  "control API serves status, events and run reads without mutating state",
  { timeout: 20_000 },
  async () => {
    await withRepo(async (repo) => {
      const { runId } = seedFixture(repo);
      const before = readAuthorityFiles(repo, runId);
      const daemon = await startApi(repo);
      try {
        assert.equal(daemon.info.address.host, "127.0.0.1");
        const base = baseUrl(daemon);

        const status = await getJson(`${base}/v1/status`);
        assert.equal(status.status, 200);
        assert.match(
          status.headers.get("content-type") ?? "",
          /^application\/json/,
        );
        assert.equal(status.body.apiVersion, 1);
        assert.match(status.body.version, /^st1_[0-9a-f]{64}$/);
        assert.equal(
          status.headers.get("x-cliyard-version"),
          status.body.version,
        );
        assert.equal(status.body.snapshot.counts.total, 2);
        assert.equal(status.body.snapshot.counts.running, 1);
        const active = status.body.snapshot.items.find(
          (item: { id: string }) => item.id === "active",
        );
        assert.equal(active.run.runId, runId);
        assert.equal(status.body.store.recordCount > 0, true);

        const eventsResponse = await fetch(`${base}/v1/events`);
        assert.equal(eventsResponse.status, 200);
        assert.match(
          eventsResponse.headers.get("content-type") ?? "",
          /^application\/x-ndjson/,
        );
        assert.equal(
          eventsResponse.headers.get("x-cliyard-version"),
          status.body.version,
        );
        assert.equal(
          eventsResponse.headers.get("x-cliyard-has-more"),
          "false",
        );
        const events = parseNdjson(await eventsResponse.text());
        assert.ok(events.length >= 1);
        assert.equal(
          new Set(events.map((line) => line.cursor)).size,
          events.length,
          "every event line carries a distinct replay cursor",
        );
        for (const line of events) {
          assert.match(line.cursor, /^ev1_[0-9a-f]{32}$/);
        }
        const latest = events.at(-1)!;
        assert.equal(latest.type, "attempt.started");
        assert.equal(latest.runId, runId);

        const run = await getJson(`${base}/v1/runs/${runId}`);
        assert.equal(run.status, 200);
        assert.equal(run.body.apiVersion, 1);
        assert.equal(run.body.version, status.body.version);
        assert.equal(run.body.runId, runId);
        assert.equal(run.body.manifest.runId, runId);
        assert.equal(run.body.manifest.planId, "plan-active");
        assert.match(run.body.evidence.attemptId, /^run\.[0-9a-f]{32}$/);
        assert.match(run.body.evidence.ref.contentHash, /^[0-9a-f]{64}$/);
        assert.equal(
          run.body.evidence.ref.path,
          `sha256/${run.body.evidence.ref.contentHash}`,
        );
        assert.ok(run.body.evidence.ref.byteLength > 0);
        assert.equal(
          typeof run.body.evidence.ref.mediaType,
          "string",
        );

        assert.deepEqual(
          readAuthorityFiles(repo, runId),
          before,
          "read endpoints must not mutate durable state",
        );
      } finally {
        await daemon.stop("test");
      }
    });
  },
);

test(
  "version token is stable without state changes and changes with state",
  { timeout: 20_000 },
  async () => {
    await withRepo(async (repo) => {
      const { runId } = seedFixture(repo);
      const daemon = await startApi(repo);
      try {
        const base = baseUrl(daemon);
        const first = await getJson(`${base}/v1/status`);
        const second = await getJson(`${base}/v1/status`);
        assert.equal(first.status, 200);
        assert.equal(second.status, 200);
        assert.equal(
          first.body.version,
          second.body.version,
          "host observations must not change the state token",
        );

        const beforeEvents = parseNdjson(
          await (await fetch(`${base}/v1/events`)).text(),
        );
        const lastCursor = beforeEvents.at(-1)!.cursor;

        const appended = appendQueueEvent(repo, {
          type: "queue.retry",
          itemId: "active",
          reason: "control-api-read test",
        });

        const changed = await getJson(`${base}/v1/status`);
        assert.notEqual(changed.body.version, second.body.version);
        assert.equal(
          changed.body.snapshot.journal.totalEvents,
          second.body.snapshot.journal.totalEvents + 1,
        );
        const run = await getJson(`${base}/v1/runs/${runId}`);
        assert.equal(
          run.body.version,
          changed.body.version,
          "all endpoints report the same state token",
        );

        const replayResponse = await fetch(
          `${base}/v1/events?after=${encodeURIComponent(lastCursor)}`,
        );
        assert.equal(replayResponse.status, 200);
        const replay = parseNdjson(await replayResponse.text());
        assert.equal(replay.length, 1);
        assert.equal(replay[0]!.eventId, appended.eventId);
        assert.equal(replay[0]!.type, "queue.retry");

        const caughtUp = await fetch(
          `${base}/v1/events?after=${encodeURIComponent(replay[0]!.cursor)}`,
        );
        assert.equal(caughtUp.status, 200);
        assert.equal(await caughtUp.text(), "");
        assert.equal(caughtUp.headers.get("x-cliyard-has-more"), "false");
        assert.equal(
          caughtUp.headers.get("x-cliyard-next-cursor"),
          replay[0]!.cursor,
        );
      } finally {
        await daemon.stop("test");
      }
    });
  },
);

test(
  "unknown cursors and ids return bounded errors",
  { timeout: 20_000 },
  async () => {
    await withRepo(async (repo) => {
      const { runId } = seedFixture(repo);
      const daemon = await startApi(repo);
      try {
        const base = baseUrl(daemon);

        const unknownCursor = await fetch(
          `${base}/v1/events?after=ev1_${"0".repeat(32)}`,
        );
        assert.equal(unknownCursor.status, 400);
        const unknownBody = (await unknownCursor.json()) as Record<string, any>;
        assert.equal(unknownBody.error.code, "unknown_cursor");
        assert.ok(unknownBody.error.message.length <= 200);

        const invalidCursor = await fetch(
          `${base}/v1/events?after=${"x".repeat(1_000)}`,
        );
        assert.equal(invalidCursor.status, 400);
        const invalidText = await invalidCursor.text();
        assert.ok(invalidText.length < 1_024, "error body must stay bounded");
        assert.equal(
          (JSON.parse(invalidText) as Record<string, any>).error.code,
          "invalid_cursor",
        );

        const invalidLimit = await fetch(`${base}/v1/events?limit=0`);
        assert.equal(invalidLimit.status, 400);
        assert.equal(
          ((await invalidLimit.json()) as Record<string, any>).error.code,
          "invalid_limit",
        );

        const unknownRun = await fetch(`${base}/v1/runs/does-not-exist`);
        assert.equal(unknownRun.status, 404);
        const unknownRunText = await unknownRun.text();
        assert.ok(unknownRunText.length < 1_024);
        assert.equal(
          (JSON.parse(unknownRunText) as Record<string, any>).error.code,
          "run_not_found",
        );

        const oversizedRunId = await fetch(
          `${base}/v1/runs/${"a".repeat(500)}`,
        );
        assert.equal(oversizedRunId.status, 400);
        assert.ok((await oversizedRunId.text()).length < 1_024);

        const invalidRunId = await fetch(
          `${base}/v1/runs/${encodeURIComponent("../escape")}`,
        );
        assert.equal(invalidRunId.status, 400);
        assert.equal(
          ((await invalidRunId.json()) as Record<string, any>).error.code,
          "invalid_run_id",
        );

        const missing = await fetch(`${base}/v1/not-an-endpoint`);
        assert.equal(missing.status, 404);
        assert.equal(
          ((await missing.json()) as Record<string, any>).error.code,
          "not_found",
        );

        const post = await fetch(`${base}/v1/status`, { method: "POST" });
        assert.equal(post.status, 405);
        assert.equal(post.headers.get("allow"), "GET, HEAD");

        // A successful read still works after the bounded failures.
        assert.equal((await fetch(`${base}/v1/runs/${runId}`)).status, 200);
      } finally {
        await daemon.stop("test");
      }
    });
  },
);

test(
  "HEAD returns the same headers without a body",
  { timeout: 20_000 },
  async () => {
    await withRepo(async (repo) => {
      seedFixture(repo);
      const daemon = await startApi(repo);
      try {
        const head = await fetch(`${baseUrl(daemon)}/v1/status`, {
          method: "HEAD",
        });
        assert.equal(head.status, 200);
        assert.match(head.headers.get("content-type") ?? "", /^application\/json/);
        assert.match(
          head.headers.get("x-cliyard-version") ?? "",
          /^st1_[0-9a-f]{64}$/,
        );
        assert.equal(await head.text(), "");
      } finally {
        await daemon.stop("test");
      }
    });
  },
);

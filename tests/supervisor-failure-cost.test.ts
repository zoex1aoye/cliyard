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
import { join } from "node:path";
import type {
  AgentAdapter,
  AgentResult,
  AgentStartInput,
} from "../src/agents/types.js";
import type { TaskContract } from "../src/contracts/schema.js";
import { loadContractJson } from "../src/contracts/schema.js";
import {
  createCostObservation,
  createCostTruth,
  createFailureRecord,
  unavailableCostTruth,
  type CostTruth,
  type TokenUsage,
} from "../src/failures.js";
import { runClosedLoop, type LoopResult } from "../src/repair/loop.js";
import { loadLedger } from "../src/persistence/ledger.js";
import { runCodexBatch } from "../src/scheduler/codex-batch.js";
import {
  createRunManifest,
  loadRunManifest,
  runManifestPath,
  updateRunManifest,
} from "../src/supervisor/store.js";
import { runSupervisorCli } from "../src/supervisor/cli.js";
import {
  addQueueItem,
  loadQueue,
  queuePaths,
  retryQueueItem,
} from "../src/orchestration/queue-store.js";
import { runQueue } from "../src/orchestration/queue-runner.js";
import {
  appendQueueEvent,
  readQueueEventJournal,
} from "../src/orchestration/event-journal.js";
import { runQueueCli } from "../src/orchestration/cli.js";
import { buildControlSnapshot } from "../src/orchestration/control-snapshot.js";
import type { Verifier } from "../src/verification/verifier.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const FULL_USAGE: TokenUsage = {
  inputTokens: 10,
  outputTokens: 5,
  cacheCreationInputTokens: 2,
  cacheReadInputTokens: 1,
};

function cost(amount: number, sessionId: string): CostTruth {
  return createCostTruth({
    observations: [
      createCostObservation({
        sessionId,
        amount,
        currency: "USD",
        usage: FULL_USAGE,
      }),
    ],
  });
}

const baseContract = loadContractJson(
  readFileSync(
    new URL("../examples/mock.contract.json", import.meta.url),
    "utf8",
  ),
);

function scriptedWorker(
  build: (attempt: number, sessionId: string) => AgentResult,
): AgentAdapter {
  const attempts = new Map<string, number>();
  return {
    id: "mock",
    async discover() {
      return {
        id: "mock",
        ok: true,
        supportsModelFlag: false,
        notes: [],
      };
    },
    async start(input) {
      const sessionId = `session-${input.attempt}`;
      attempts.set(sessionId, input.attempt);
      return { sessionId };
    },
    async collect(sessionId) {
      const attempt = attempts.get(sessionId);
      assert.notEqual(attempt, undefined);
      return build(attempt!, sessionId);
    },
    async cancel() {},
  };
}

function scriptedVerifier(okSequence: boolean[]): Verifier {
  let index = 0;
  return {
    async run() {
      const ok = okSequence[Math.min(index, okSequence.length - 1)]!;
      index += 1;
      return {
        ok,
        exitCode: ok ? 0 : 1,
        commandResults: [],
        logTail: ok ? "verification passed" : "verification failed",
      };
    },
  };
}

function withTempLedger<T>(
  fn: (ledgerPath: string) => Promise<T>,
): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "cliyard-failure-cost-"));
  return fn(join(dir, "ledger.json")).finally(() => {
    rmSync(dir, { recursive: true, force: true });
  });
}

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
  const repo = mkdtempSync(join(tmpdir(), "cliyard-durable-failure-"));
  runGit(repo, ["init"]);
  runGit(repo, ["config", "user.email", "t@t.com"]);
  runGit(repo, ["config", "user.name", "t"]);
  writeFileSync(join(repo, "README.md"), "# fixture\n");
  runGit(repo, ["add", "."]);
  runGit(repo, ["commit", "-m", "init"]);
  return repo;
}

function contract(
  taskId: string,
  writePath: string,
  baseCommit: string,
  verifyCommands: string[],
  dependsOn: string[] = [],
): TaskContract {
  return {
    taskId,
    version: 1,
    frozen: true,
    goals: [`Create ${writePath}`],
    dependsOn,
    readPaths: ["."],
    writePaths: [writePath],
    sharedResources: [],
    baseCommit,
    verifyCommands,
    maxRepairs: 0,
  };
}

function writeContracts(repo: string, contracts: TaskContract[]): string {
  const path = join(repo, "contracts.json");
  writeFileSync(
    path,
    JSON.stringify({ contracts }, null, 2) + "\n",
    "utf8",
  );
  return path;
}

function fixtureAdapter(
  cwd: string,
  build: (input: AgentStartInput, sessionId: string) => AgentResult,
): AgentAdapter {
  let current: AgentStartInput | undefined;
  return {
    id: "claude",
    async discover() {
      return {
        id: "claude",
        ok: true,
        supportsModelFlag: true,
        notes: ["durable fixture"],
      };
    },
    async start(input) {
      current = input;
      return { sessionId: `fixture-${input.contract.taskId}` };
    },
    async collect(sessionId) {
      if (!current) throw new Error("worker did not start");
      return build(current, sessionId);
    },
    async cancel() {},
  };
}

function parseJson(lines: string[]): any {
  return JSON.parse(lines.join("\n"));
}

// ---------------------------------------------------------------------------
// Closed loop: capture, fallback classification and repair aggregation
// ---------------------------------------------------------------------------

test("closed loop aggregates repair cost and persists accepted cost without failure", async () => {
  await withTempLedger(async (ledgerPath) => {
    const result = await runClosedLoop({
      contract: { ...baseContract, maxRepairs: 2 },
      worker: scriptedWorker((attempt, sessionId) =>
        ({
          sessionId,
          exitCode: 0,
          touchedPaths: ["src/hello/"],
          logTail: `implemented attempt ${attempt}`,
          cost: cost(attempt === 0 ? 0.01 : 0.02, sessionId),
        }) satisfies AgentResult,
      ),
      verifier: scriptedVerifier([false, true]),
      ledgerPath,
    });

    assert.equal(result.verdict, "accepted");
    assert.equal(result.failure, undefined);
    assert.ok(result.cost);
    assert.equal(result.cost.amount, 0.03);
    assert.equal(result.cost.state, "cli-estimated");
    assert.equal(result.cost.authoritative, false);
    assert.equal(result.cost.observations.length, 2);

    const ledger = loadLedger(ledgerPath);
    const record = ledger.tasks[baseContract.taskId]!;
    assert.equal(record.failure, undefined);
    assert.ok(record.cost);
    assert.equal(record.cost.amount, 0.03);
    assert.equal(record.cost.observations.length, 2);
  });
});

test("rejected worker failure stays structured and is never relabeled verifier_rejected", async () => {
  await withTempLedger(async (ledgerPath) => {
    let starts = 0;
    const worker = scriptedWorker((_attempt, sessionId) => {
      starts += 1;
      return {
        sessionId,
        exitCode: 1,
        touchedPaths: [],
        logTail: "API Error: 429 rate limit exceeded",
        failure: createFailureRecord({
          exitCode: 1,
          text: "API Error: 429 rate limit exceeded",
        }),
        cost: cost(0.05, sessionId),
      };
    });

    const result: LoopResult = await runClosedLoop({
      contract: { ...baseContract, maxRepairs: 2 },
      worker,
      verifier: scriptedVerifier([false]),
      ledgerPath,
    });

    assert.equal(result.verdict, "rejected");
    // Worker exit failures do not auto-retry.
    assert.equal(starts, 1);
    assert.equal(result.repairCount, 0);
    assert.ok(result.failure);
    assert.equal(result.failure.category, "provider_transient");
    assert.equal(result.failure.stage, "provider");
    assert.notEqual(result.failure.category, "verifier_rejected");
    assert.match(result.failure.message, /429|rate limit/);
    assert.ok(result.cost);
    assert.equal(result.cost.amount, 0.05);

    const record = loadLedger(ledgerPath).tasks[baseContract.taskId]!;
    assert.equal(record.verdict, "rejected");
    assert.equal(record.failure?.category, "provider_transient");
    assert.equal(record.cost?.amount, 0.05);
  });
});

test("verifier rejection after a successful worker keeps verifier_rejected and cost", async () => {
  await withTempLedger(async (ledgerPath) => {
    const result = await runClosedLoop({
      contract: { ...baseContract, maxRepairs: 0 },
      worker: scriptedWorker((_attempt, sessionId) => ({
        sessionId,
        exitCode: 0,
        touchedPaths: ["src/hello/"],
        logTail: "implemented",
        cost: cost(0.02, sessionId),
      })),
      verifier: scriptedVerifier([false]),
      ledgerPath,
    });

    assert.equal(result.verdict, "rejected");
    assert.equal(result.failure?.category, "verifier_rejected");
    assert.equal(result.failure?.stage, "verifier");
    assert.equal(result.cost?.amount, 0.02);
    assert.equal(
      loadLedger(ledgerPath).tasks[baseContract.taskId]?.failure?.category,
      "verifier_rejected",
    );
  });
});

test("loop fallback classifies a worker exit when the adapter omits structured fields", async () => {
  await withTempLedger(async (ledgerPath) => {
    const result = await runClosedLoop({
      contract: { ...baseContract, maxRepairs: 0 },
      worker: scriptedWorker((_attempt, sessionId) => ({
        sessionId,
        exitCode: 7,
        touchedPaths: [],
        logTail: "fatal worker error",
      })),
      verifier: scriptedVerifier([false]),
      ledgerPath,
    });

    assert.equal(result.verdict, "rejected");
    assert.equal(result.failure?.category, "worker_process_exit");
    assert.equal(result.failure?.stage, "worker");
    assert.ok((result.failure?.message.length ?? 0) > 0);
    // No cost observation means unavailable, never zero.
    assert.equal(result.cost?.state, "unavailable");
    assert.equal(result.cost?.amount, null);
  });
});

// ---------------------------------------------------------------------------
// Supervisor checkpoints and worktree cleanup
// ---------------------------------------------------------------------------

test("accepted cost survives the RunManifest checkpoint and worktree cleanup", async () => {
  const repo = initRepo();
  try {
    const base = runGit(repo, ["rev-parse", "HEAD"]);
    const contractsPath = writeContracts(repo, [
      contract("task", "task.txt", base, ["test -f task.txt"]),
    ]);
    const manifest = createRunManifest(repo, {
      planId: "accepted-cost",
      contractsPath,
      baseCommit: base,
      integrationBranch: "cliyard/integration/accepted-cost",
      tasks: ["task"],
    });

    const result = await runCodexBatch({
      contractsPath,
      repoRoot: repo,
      ledgerPath: join(repo, ".cliyard", "ledger.json"),
      worker: "claude",
      dryRun: false,
      keepWorktrees: false,
      runManifest: manifest,
      workerFactory: (_worker, cwd) =>
        fixtureAdapter(cwd, (input, sessionId) => {
          writeFileSync(join(cwd, "task.txt"), "done\n");
          return {
            sessionId,
            exitCode: 0,
            touchedPaths: ["task.txt"],
            logTail: "wrote task.txt",
            cost: cost(0.02, sessionId),
          };
        }),
    });

    assert.equal(result.allAccepted, true);
    assert.equal(result.worktrees.length, 1);
    assert.equal(
      existsSync(result.worktrees[0]!.path),
      false,
      "accepted worktree is cleaned up",
    );

    const saved = loadRunManifest(repo, manifest.runId);
    const task = saved.tasks["task"]!;
    assert.equal(task.accepted, true);
    assert.equal(task.failure, undefined);
    assert.ok(task.cost);
    assert.equal(task.cost.amount, 0.02);
    assert.equal(task.cost.authoritative, false);
    assert.deepEqual(task.cost.usage, FULL_USAGE);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("worker and verifier failures checkpoint distinctly and skip dependants as policy_blocked", async () => {
  const repo = initRepo();
  try {
    const base = runGit(repo, ["rev-parse", "HEAD"]);
    const contractsPath = writeContracts(repo, [
      contract("provider-fail", "provider-fail.txt", base, [
        "test -f provider-fail.txt",
      ]),
      contract("verify-fail", "verify-fail.txt", base, [
        "test -f expected.txt",
      ]),
      contract(
        "downstream",
        "downstream.txt",
        base,
        ["test -f downstream.txt"],
        ["provider-fail"],
      ),
    ]);
    const manifest = createRunManifest(repo, {
      planId: "rejected-failures",
      contractsPath,
      baseCommit: base,
      integrationBranch: "cliyard/integration/rejected-failures",
      tasks: ["provider-fail", "verify-fail", "downstream"],
    });
    const started: string[] = [];

    const result = await runCodexBatch({
      contractsPath,
      repoRoot: repo,
      ledgerPath: join(repo, ".cliyard", "ledger.json"),
      worker: "claude",
      dryRun: false,
      keepWorktrees: false,
      runManifest: manifest,
      workerFactory: (_worker, cwd) =>
        fixtureAdapter(cwd, (input, sessionId) => {
          started.push(input.contract.taskId);
          if (input.contract.taskId === "provider-fail") {
            return {
              sessionId,
              exitCode: 1,
              touchedPaths: [],
              logTail: "401 unauthorized: invalid api key",
              failure: createFailureRecord({
                exitCode: 1,
                text: "401 unauthorized: invalid api key",
              }),
              cost: cost(0.01, sessionId),
            };
          }
          // Worker reports success without producing the verified file.
          return {
            sessionId,
            exitCode: 0,
            touchedPaths: [],
            logTail: "implemented",
            cost: cost(0.02, sessionId),
          };
        }),
    });

    assert.equal(result.allAccepted, false);
    assert.deepEqual(started.sort(), ["provider-fail", "verify-fail"]);
    assert.ok(!started.includes("downstream"));

    const saved = loadRunManifest(repo, manifest.runId);
    assert.equal(saved.status, "blocked");

    const provider = saved.tasks["provider-fail"]!;
    assert.equal(provider.status, "rejected");
    assert.equal(provider.failure?.category, "provider_auth");
    assert.equal(provider.failure?.stage, "provider");
    assert.match(provider.reason ?? "", /implement failed/);
    assert.equal(provider.cost?.amount, 0.01);
    // The verifier also ran and failed, but must not relabel the worker exit.
    assert.notEqual(provider.failure?.category, "verifier_rejected");

    const verifier = saved.tasks["verify-fail"]!;
    assert.equal(verifier.status, "rejected");
    assert.equal(verifier.failure?.category, "verifier_rejected");
    assert.equal(verifier.failure?.stage, "verifier");
    assert.equal(verifier.cost?.amount, 0.02);

    const downstream = saved.tasks["downstream"]!;
    assert.equal(downstream.accepted, false);
    assert.equal(downstream.status, "blocked");
    assert.equal(downstream.failure?.category, "policy_blocked");
    assert.equal(downstream.failure?.stage, "policy");
    assert.equal(downstream.failure?.code, "dependency_blocked");
    assert.equal(downstream.cost, undefined);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Fail-closed parsing / legacy compatibility
// ---------------------------------------------------------------------------

test("legacy ledger, manifest and queue records load while malformed structured fields fail closed", () => {
  const repo = initRepo();
  try {
    const base = runGit(repo, ["rev-parse", "HEAD"]);
    const contractsPath = writeContracts(repo, [
      contract("task", "task.txt", base, ["test -f task.txt"]),
    ]);
    const manifest = createRunManifest(repo, {
      planId: "parsing",
      contractsPath,
      baseCommit: base,
      integrationBranch: "cliyard/integration/parsing",
      tasks: ["task"],
    });

    // A legacy manifest has no failure/cost and remains readable.
    assert.equal(loadRunManifest(repo, manifest.runId).tasks["task"]?.failure, undefined);

    const manifestRaw = JSON.parse(
      readFileSync(runManifestPath(repo, manifest.runId), "utf8"),
    ) as Record<string, any>;
    manifestRaw.tasks.task.failure = {
      version: 1,
      category: "made_up",
      stage: "worker",
      message: "x",
      observedAt: new Date().toISOString(),
    };
    writeFileSync(
      runManifestPath(repo, manifest.runId),
      JSON.stringify(manifestRaw, null, 2) + "\n",
      "utf8",
    );
    assert.throws(
      () => loadRunManifest(repo, manifest.runId),
      /task task\.failure is not a valid failure record/,
    );

    // Legacy ledger record without optional fields.
    mkdirSync(join(repo, ".cliyard"), { recursive: true });
    const ledgerPath = join(repo, ".cliyard", "ledger.json");
    writeFileSync(
      ledgerPath,
      JSON.stringify({ tasks: { legacy: { taskId: "legacy", status: "accepted" } } }),
      "utf8",
    );
    assert.equal(loadLedger(ledgerPath).tasks.legacy?.taskId, "legacy");

    writeFileSync(
      ledgerPath,
      JSON.stringify({
        tasks: {
          broken: {
            taskId: "broken",
            status: "rejected",
            cost: { version: 1 },
          },
        },
      }),
      "utf8",
    );
    assert.throws(
      () => loadLedger(ledgerPath),
      /task broken\.cost is not a valid cost record/,
    );

    // Legacy queue item without failure metadata loads unchanged.
    const item = addQueueItem(repo, {
      id: "queue-legacy",
      contractsPath,
    });
    assert.equal(loadQueue(repo).items[0]?.failure, undefined);

    // A valid structured failure round-trips through queue store validation.
    const document = loadQueue(repo);
    document.items[0]!.failure = createFailureRecord({
      policyBlocked: true,
      stage: "policy",
      code: "dependency_blocked",
      messageDetail: "dependency is blocked",
      observedAt: item.createdAt,
    });
    writeFileSync(
      queuePaths(repo).queuePath,
      JSON.stringify(document, null, 2) + "\n",
      "utf8",
    );
    assert.equal(
      loadQueue(repo).items[0]?.failure?.category,
      "policy_blocked",
    );

    const brokenQueue = JSON.parse(
      readFileSync(queuePaths(repo).queuePath, "utf8"),
    ) as Record<string, any>;
    brokenQueue.items[0].failure = {
      version: 1,
      category: "unknown",
      stage: "made_up",
      message: "x",
      observedAt: new Date().toISOString(),
    };
    writeFileSync(
      queuePaths(repo).queuePath,
      JSON.stringify(brokenQueue, null, 2) + "\n",
      "utf8",
    );
    assert.throws(
      () => loadQueue(repo),
      /failure is not a valid failure record/,
    );
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Supervisor status surface
// ---------------------------------------------------------------------------

test("supervisor status JSON and human output expose failure/cost without fabricating amounts", async () => {
  const repo = initRepo();
  try {
    const base = runGit(repo, ["rev-parse", "HEAD"]);
    const contractsPath = writeContracts(repo, [
      contract("task", "task.txt", base, ["test -f task.txt"]),
      contract("missing", "missing.txt", base, ["test -f missing.txt"]),
    ]);
    const manifest = createRunManifest(repo, {
      planId: "status-surface",
      contractsPath,
      baseCommit: base,
      integrationBranch: "cliyard/integration/status-surface",
      tasks: ["task", "missing"],
    });
    updateRunManifest(repo, manifest.runId, (current) => {
      const rejected = current.tasks["task"]!;
      rejected.status = "rejected";
      rejected.reason = "budget exhausted";
      rejected.failure = createFailureRecord({
        exitCode: 1,
        text: "provider budget exhausted",
        observedAt: "2026-10-27T10:00:00Z",
      });
      rejected.cost = cost(0.07, "session-budget");

      const pending = current.tasks["missing"]!;
      pending.status = "rejected";
      pending.reason = "unknown failure";
      pending.cost = unavailableCostTruth({
        sessionId: "session-missing-cost",
        note: "provider emitted no usage",
      });
    });

    const jsonLines: string[] = [];
    assert.equal(
      await runSupervisorCli(
        ["status", "--repo", repo, "--run", manifest.runId, "--json"],
        { log: (line) => jsonLines.push(line), signalHandling: false },
      ),
      0,
    );
    const status = parseJson(jsonLines);
    const rejected = status.tasks.find((task: any) => task.taskId === "task");
    assert.equal(rejected.failure.category, "budget_exhausted");
    assert.equal(rejected.failure.stage, "provider");
    assert.equal(rejected.cost.amount, 0.07);
    assert.equal(rejected.cost.authoritative, false);
    const missing = status.tasks.find(
      (task: any) => task.taskId === "missing",
    );
    assert.equal(missing.cost.amount, null);
    assert.equal(missing.cost.state, "unavailable");

    const humanLines: string[] = [];
    assert.equal(
      await runSupervisorCli(["status", "--repo", repo], {
        log: (line) => humanLines.push(line),
        signalHandling: false,
      }),
      0,
    );
    const human = humanLines.join("\n");
    assert.match(
      human,
      /task task: rejected failure=budget_exhausted\/provider \(exit_1\)/i,
    );
    assert.match(
      human,
      /cost=cli-estimated 0\.07 USD \(observed, non-authoritative\)/,
    );
    assert.match(
      human,
      /task missing: rejected cost=unavailable missing=cost\.amount,cost\.usage/,
    );
    assert.doesNotMatch(human, /cost=\$?0(?:\.0+)?\b/);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Queue pre-dispatch failures, retry and journal
// ---------------------------------------------------------------------------

test("pre-dispatch blocks are durable without a RunManifest, journaled and cleared by retry", async () => {
  const repo = initRepo();
  try {
    const base = runGit(repo, ["rev-parse", "HEAD"]);
    const contractsPath = writeContracts(repo, [
      contract("task", "task.txt", base, ["test -f task.txt"]),
    ]);
    addQueueItem(repo, { id: "pre", contractsPath });
    // Break the frozen contracts identity so the block happens before dispatch.
    writeFileSync(contractsPath, `${readFileSync(contractsPath, "utf8")}\n`);

    let dispatched = 0;
    const summary = await runQueue(repo, {
      runner: async () => {
        dispatched += 1;
        throw new Error("pre-dispatch block must not dispatch");
      },
    });

    assert.equal(dispatched, 0);
    assert.equal(summary.counts.blocked, 1);
    const item = loadQueue(repo).items[0]!;
    assert.equal(item.status, "blocked");
    assert.equal(item.lastRunId, undefined);
    assert.equal(item.failure?.category, "policy_blocked");
    assert.equal(item.failure?.stage, "policy");
    assert.equal(item.failure?.code, "contracts_mismatch");
    assert.match(item.reason ?? "", /contracts changed/);

    const event = readQueueEventJournal(repo).events.at(-1)!;
    assert.equal(event.type, "run.blocked");
    assert.equal(event.failureCategory, "policy_blocked");
    assert.equal(event.failureStage, "policy");
    assert.equal(event.failureCode, "contracts_mismatch");
    assert.equal(event.costState, undefined);

    const snapshot = await buildControlSnapshot(repo);
    const snapshotItem = snapshot.items[0]!;
    assert.equal(snapshotItem.failure?.category, "policy_blocked");
    assert.equal(snapshotItem.run, null);
    assert.equal(snapshotItem.decision.category, "policy");
    assert.deepEqual(snapshot.failureCounts, { policy_blocked: 1 });
    assert.equal(snapshot.cost.amount, null);
    assert.equal(snapshot.cost.authoritative, false);
    assert.equal(snapshot.cost.completeness, "missing");

    const jsonLines: string[] = [];
    assert.equal(
      await runQueueCli(["status", "--repo", repo, "--json"], {
        log: (line) => jsonLines.push(line),
      }),
      0,
    );
    const cli = parseJson(jsonLines);
    assert.equal(cli.items[0].failure.category, "policy_blocked");
    assert.deepEqual(cli.failureCounts, { policy_blocked: 1 });
    assert.equal(cli.cost.amount, null);

    const humanLines: string[] = [];
    assert.equal(
      await runQueueCli(["status", "--repo", repo], {
        log: (line) => humanLines.push(line),
      }),
      0,
    );
    const human = humanLines.join("\n");
    assert.match(human, /failure categories: policy_blocked 1/);
    assert.match(
      human,
      /cost: unavailable; non-authoritative; completeness missing; missing cost\.observation/,
    );
    assert.match(human, /failure: policy_blocked\/policy \(contracts_mismatch\)/);

    const retried = retryQueueItem(repo, "pre");
    assert.equal(retried.status, "pending");
    assert.equal(retried.failure, undefined);
    assert.equal(loadQueue(repo).items[0]?.failure, undefined);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("dispatched run failure/cost is journaled while the RunManifest stays authoritative", async () => {
  const repo = initRepo();
  try {
    const base = runGit(repo, ["rev-parse", "HEAD"]);
    const contractsPath = writeContracts(repo, [
      contract("task", "task.txt", base, ["test -f task.txt"]),
    ]);
    addQueueItem(repo, { id: "dispatch", contractsPath });
    const runId = "run-dispatched-journal";

    const summary = await runQueue(repo, {
      runner: async () => {
        createRunManifest(repo, {
          runId,
          planId: "dispatch",
          contractsPath,
          baseCommit: base,
          integrationBranch: `cliyard/integration/${runId}`,
          tasks: ["task"],
        });
        updateRunManifest(repo, runId, (manifest) => {
          manifest.status = "blocked";
          const task = manifest.tasks["task"]!;
          task.status = "rejected";
          task.accepted = false;
          task.reason = "implement failed: exitCode=1";
          task.failure = createFailureRecord({
            exitCode: 1,
            text: "503 service unavailable",
          });
          task.cost = cost(0.03, "session-dispatched");
        });
        return {
          exitCode: 1,
          runId,
          status: "blocked",
          reason: "run dispatched-journal blocked",
        };
      },
    });

    assert.equal(summary.stopped, "blocked");
    // A dispatched run's failure is never duplicated into the QueueItem.
    assert.equal(loadQueue(repo).items[0]?.failure, undefined);

    const event = readQueueEventJournal(repo).events.at(-1)!;
    assert.equal(event.type, "run.blocked");
    assert.equal(event.failureCategory, "provider_transient");
    assert.equal(event.failureStage, "provider");
    assert.equal(event.failureCode, "exit_1");
    assert.equal(event.costState, "cli-estimated");

    // The queue read the manifest without rewriting it.
    const saved = loadRunManifest(repo, runId);
    assert.equal(saved.tasks["task"]?.failure?.category, "provider_transient");
    assert.equal(saved.tasks["task"]?.cost?.amount, 0.03);

    const snapshot = await buildControlSnapshot(repo);
    assert.deepEqual(snapshot.failureCounts, { provider_transient: 1 });
    assert.equal(snapshot.cost.state, "cli-estimated");
    assert.equal(snapshot.cost.amount, 0.03);
    assert.equal(snapshot.cost.authoritative, false);
    assert.equal(snapshot.items[0]?.decision.category, "infrastructure");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("dependency-propagated blocks journal bounded policy failure fields", async () => {
  const repo = initRepo();
  try {
    const base = runGit(repo, ["rev-parse", "HEAD"]);
    const contractsPath = writeContracts(repo, [
      contract("upstream", "upstream.txt", base, ["test -f upstream.txt"]),
      contract("downstream", "downstream.txt", base, ["test -f downstream.txt"], [
        "upstream",
      ]),
    ]);
    addQueueItem(repo, { id: "upstream", contractsPath });
    addQueueItem(repo, {
      id: "downstream",
      contractsPath,
      dependsOn: ["upstream"],
    });
    // Break both frozen identities; the ready upstream blocks pre-dispatch and
    // its dependant is blocked by propagation instead of dispatch.
    writeFileSync(contractsPath, `${readFileSync(contractsPath, "utf8")}\n`);

    const summary = await runQueue(repo, {
      continueOnBlocked: true,
      runner: async () => {
        throw new Error("blocked items must not dispatch");
      },
    });
    assert.equal(summary.counts.blocked, 2);

    const events = readQueueEventJournal(repo).events.filter(
      (event) => event.type === "run.blocked",
    );
    const downstream = events.find((event) => event.itemId === "downstream");
    assert.ok(downstream, "missing propagated run.blocked event");
    assert.equal(downstream.failureCategory, "policy_blocked");
    assert.equal(downstream.failureStage, "policy");
    assert.equal(downstream.failureCode, "dependency_blocked");

    const saved = loadQueue(repo).items.find(
      (item) => item.id === "downstream",
    )!;
    assert.equal(saved.failure?.category, "policy_blocked");
    assert.equal(saved.failure?.code, "dependency_blocked");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("event journal bounds and validates failure/cost observation fields", () => {
  const repo = initRepo();
  try {
    const event = appendQueueEvent(repo, {
      type: "run.blocked",
      itemId: "item",
      failureCategory: "timeout",
      failureStage: "worker",
      failureCode: "x".repeat(200),
      costState: "cli-estimated",
    });
    assert.equal(event.failureCategory, "timeout");
    assert.equal(event.failureStage, "worker");
    assert.equal(event.failureCode?.length, 64);
    assert.equal(event.costState, "cli-estimated");

    const journal = readQueueEventJournal(repo);
    assert.equal(journal.events.at(-1)?.failureCategory, "timeout");
    assert.equal(journal.malformedLines, 0);

    // A category outside the taxonomy fails closed as a malformed line.
    const path = join(repo, ".cliyard", "queue-events", "events.jsonl");
    writeFileSync(
      path,
      `${JSON.stringify({
        version: 1,
        eventId: "bad-category",
        at: new Date().toISOString(),
        type: "run.blocked",
        failureCategory: "made_up",
        failureStage: "worker",
      })}\n`,
      { encoding: "utf8", flag: "a" },
    );
    const reread = readQueueEventJournal(repo);
    assert.equal(reread.malformedLines, 1);
    assert.equal(reread.events.at(-1)?.failureCategory, "timeout");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

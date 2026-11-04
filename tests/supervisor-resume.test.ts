import { test } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import type {
  AgentAdapter,
  AgentResult,
  AgentStartInput,
} from "../src/agents/types.js";
import type { TaskContract } from "../src/contracts/schema.js";
import {
  createCostObservation,
  createCostTruth,
  unavailableCostTruth,
  type CostTruth,
  type TokenUsage,
} from "../src/failures.js";
import { runCodexBatch } from "../src/scheduler/codex-batch.js";
import { runSupervisorCli } from "../src/supervisor/cli.js";
import {
  ContractsHashMismatchError,
  createRunManifest,
  inspectSupervisorStateStore,
  loadRunManifest,
  supervisorPaths,
  supervisorStatePaths,
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
  const repo = mkdtempSync(join(tmpdir(), "cliyard-resume-"));
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
  dependsOn: string[],
  writePath: string,
  baseCommit: string,
  verifyCommands: string[],
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

function writeContracts(repo: string, baseCommit: string): string {
  const path = join(repo, "contracts.json");
  writeFileSync(
    path,
    JSON.stringify(
      {
        contracts: [
          contract("foundation", [], "foundation.ts", baseCommit, [
            "test -f foundation.ts",
          ]),
          contract("left", ["foundation"], "left.ts", baseCommit, [
            "test -f foundation.ts",
            "test -f left.ts",
          ]),
          contract("right", ["foundation"], "right.ts", baseCommit, [
            "test -f foundation.ts",
            "test -f right.ts",
          ]),
          contract("upper", ["left", "right"], "upper.ts", baseCommit, [
            "test -f foundation.ts",
            "test -f left.ts",
            "test -f right.ts",
            "test -f upper.ts",
          ]),
        ],
      },
      null,
      2,
    ) + "\n",
    "utf8",
  );
  return path;
}

interface WorkerHarness {
  started: string[];
  /** Simulate the supervisor dying while this task is being dispatched. */
  interruptOnStart?: ReadonlySet<string>;
}

function createFixtureWorker(
  cwd: string,
  harness: WorkerHarness,
): AgentAdapter {
  let contract: TaskContract | undefined;
  return {
    id: "claude",
    async discover() {
      return {
        id: "claude",
        ok: true,
        supportsModelFlag: true,
        notes: ["resume fixture"],
      };
    },
    async start(input: AgentStartInput) {
      contract = input.contract;
      harness.started.push(contract.taskId);
      if (harness.interruptOnStart?.has(contract.taskId)) {
        throw new Error(`[fixture] interrupted before ${contract.taskId}`);
      }
      return { sessionId: `fixture-${contract.taskId}` };
    },
    async collect(sessionId: string): Promise<AgentResult> {
      if (!contract) throw new Error("worker did not start");
      const file = `${contract.taskId}.ts`;
      writeFileSync(
        join(cwd, file),
        `export const name = '${contract.taskId}';\n`,
      );
      return {
        sessionId,
        exitCode: 0,
        touchedPaths: [file],
        logTail: `[fixture] wrote ${file}`,
      };
    },
    async cancel() {},
  };
}

const FULL_USAGE: TokenUsage = {
  inputTokens: 10,
  outputTokens: 5,
  cacheCreationInputTokens: 2,
  cacheReadInputTokens: 1,
};

function writeSingleTaskContracts(repo: string, baseCommit: string): string {
  const path = join(repo, "contracts.json");
  writeFileSync(
    path,
    JSON.stringify(
      {
        contracts: [
          contract("task", [], "task.ts", baseCommit, ["test -f task.ts"]),
        ],
      },
      null,
      2,
    ) + "\n",
    "utf8",
  );
  return path;
}

/** Worker that writes the task file and reports one CLI-estimated cost. */
function createCostFixtureWorker(
  cwd: string,
  sessionId: string,
  amount: number,
): AgentAdapter {
  let contract: TaskContract | undefined;
  return {
    id: "claude",
    async discover() {
      return {
        id: "claude",
        ok: true,
        supportsModelFlag: true,
        notes: ["resume cost fixture"],
      };
    },
    async start(input: AgentStartInput) {
      contract = input.contract;
      return { sessionId };
    },
    async collect(collectSessionId: string): Promise<AgentResult> {
      if (!contract) throw new Error("worker did not start");
      const file = `${contract.taskId}.ts`;
      writeFileSync(
        join(cwd, file),
        `export const name = '${contract.taskId}';\n`,
      );
      return {
        sessionId: collectSessionId,
        exitCode: 0,
        touchedPaths: [file],
        logTail: `[fixture] wrote ${file}`,
        cost: createCostTruth({
          observations: [
            createCostObservation({
              sessionId: collectSessionId,
              amount,
              currency: "USD",
              usage: FULL_USAGE,
            }),
          ],
        }),
      };
    },
    async cancel() {},
  };
}

/**
 * Seed a run whose previous supervisor died mid-task after checkpointing the
 * abandoned attempt's cost. The integration checkpoint branch must already
 * exist for resume preconditions.
 */
function seedInterruptedRun(
  repo: string,
  abandonedCost: CostTruth,
): {
  runId: string;
  integrationBranch: string;
} {
  const base = runGit(repo, ["rev-parse", "HEAD"]);
  const contractsPath = writeSingleTaskContracts(repo, base);
  const manifest = createRunManifest(repo, {
    planId: "resume-cost-retention",
    contractsPath,
    baseCommit: base,
    integrationBranch: `cliyard/integration/resume-cost-${base.slice(0, 8)}`,
    tasks: ["task"],
  });
  runGit(repo, ["branch", manifest.integrationBranch, base]);
  updateRunManifest(repo, manifest.runId, (current) => {
    const task = current.tasks["task"]!;
    task.status = "running";
    task.cost = abandonedCost;
  });
  return {
    runId: manifest.runId,
    integrationBranch: manifest.integrationBranch,
  };
}

async function resumeWithCost(
  repo: string,
  runId: string,
  newSessionId: string,
  newAmount: number,
): Promise<number> {
  const lines: string[] = [];
  return runSupervisorCli(
    ["resume", "--repo", repo, "--run", runId],
    {
      log: (line) => lines.push(line),
      signalHandling: false,
      workerFactory: (_worker, cwd) =>
        createCostFixtureWorker(cwd, newSessionId, newAmount),
    },
  );
}

// ---------------------------------------------------------------------------
// Resume
// ---------------------------------------------------------------------------

test("interrupted first wave resumes only the remaining DAG work", async () => {
  const repo = initRepo();
  try {
    const base = runGit(repo, ["rev-parse", "HEAD"]);
    const contractsPath = writeContracts(repo, base);
    const manifest = createRunManifest(repo, {
      planId: "resume-fixture",
      contractsPath,
      baseCommit: base,
      integrationBranch: "cliyard/integration/resume-fixture",
      tasks: ["foundation", "left", "right", "upper"],
    });

    // First supervisor invocation accepts the first wave, then dies while
    // dispatching the second wave.
    const firstHarness: WorkerHarness = {
      started: [],
      interruptOnStart: new Set(["left", "right"]),
    };
    await assert.rejects(
      runCodexBatch({
        contractsPath,
        repoRoot: repo,
        ledgerPath: join(repo, ".cliyard", "ledger.json"),
        worker: "claude",
        dryRun: false,
        keepWorktrees: false,
        runManifest: manifest,
        workerFactory: (_worker, cwd) =>
          createFixtureWorker(cwd, firstHarness),
      }),
      /\[fixture\] interrupted before (left|right)/,
    );

    // The accepted first wave is durable, and cleanup kept the integration
    // branch as the resume checkpoint.
    const interrupted = loadRunManifest(repo, manifest.runId);
    assert.equal(interrupted.tasks["foundation"]?.accepted, true);
    assert.ok(interrupted.tasks["foundation"]?.resultCommit);
    assert.equal(interrupted.tasks["left"]?.accepted, false);
    assert.equal(interrupted.tasks["right"]?.accepted, false);
    assert.equal(interrupted.tasks["upper"]?.accepted, false);
    const branchHead = runGit(repo, [
      "rev-parse",
      "--verify",
      `refs/heads/${manifest.integrationBranch}`,
    ]);
    assert.equal(branchHead, interrupted.integrationHead);

    // A brand-new scheduler invocation loads the checkpoint from disk.
    const resumed = loadRunManifest(repo, manifest.runId);
    const secondHarness: WorkerHarness = { started: [] };
    const result = await runCodexBatch({
      contractsPath,
      repoRoot: repo,
      ledgerPath: join(repo, ".cliyard", "ledger.json"),
      worker: "claude",
      dryRun: false,
      keepWorktrees: true,
      runManifest: resumed,
      workerFactory: (_worker, cwd) =>
        createFixtureWorker(cwd, secondHarness),
    });

    assert.deepEqual(secondHarness.started, ["left", "right", "upper"]);
    assert.deepEqual(result.startOrder, ["left", "right", "upper"]);
    assert.deepEqual(result.waves, [["left", "right"], ["upper"]]);
    assert.equal(result.allAccepted, true);
    assert.equal(result.integration.branch, manifest.integrationBranch);
    for (const file of [
      "foundation.ts",
      "left.ts",
      "right.ts",
      "upper.ts",
    ]) {
      assert.ok(
        existsSync(join(result.integration.path, file)),
        `${file} missing from resumed integration`,
      );
    }

    const completed = loadRunManifest(repo, manifest.runId);
    assert.equal(completed.status, "completed");
    assert.deepEqual(
      Object.values(completed.tasks)
        .filter((task) => task.accepted)
        .map((task) => task.taskId)
        .sort(),
      ["foundation", "left", "right", "upper"],
    );
    assert.equal(
      completed.tasks["foundation"]?.resultCommit,
      interrupted.tasks["foundation"]?.resultCommit,
      "accepted first-wave work must not be regenerated",
    );
    assert.equal(completed.integrationHead, result.integration.head);
    assert.equal(result.manifest?.status, "completed");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("resume rejects changed contracts and changed base data before dispatch", async () => {
  const repo = initRepo();
  try {
    const base = runGit(repo, ["rev-parse", "HEAD"]);
    // "HEAD" lets the repository move after the manifest recorded its base.
    const contractsPath = writeContracts(repo, "HEAD");
    const original = readFileSync(contractsPath, "utf8");
    const manifest = createRunManifest(repo, {
      planId: "resume-reject",
      contractsPath,
      baseCommit: base,
      integrationBranch: "cliyard/integration/resume-reject",
      tasks: ["foundation", "left", "right", "upper"],
    });

    let dispatched = 0;
    const workerFactory = (_worker: "codex" | "claude", cwd: string) => {
      dispatched += 1;
      return createFixtureWorker(cwd, { started: [] });
    };

    writeFileSync(contractsPath, `${original}\n`, "utf8");
    await assert.rejects(
      runCodexBatch({
        contractsPath,
        repoRoot: repo,
        worker: "claude",
        dryRun: false,
        keepWorktrees: false,
        runManifest: manifest,
        workerFactory,
      }),
      ContractsHashMismatchError,
    );
    assert.equal(dispatched, 0);

    writeFileSync(contractsPath, original, "utf8");
    runGit(repo, ["commit", "--allow-empty", "-m", "move base"]);
    await assert.rejects(
      runCodexBatch({
        contractsPath,
        repoRoot: repo,
        worker: "claude",
        dryRun: false,
        keepWorktrees: false,
        runManifest: manifest,
        workerFactory,
      }),
      /base commit changed/,
    );
    assert.equal(dispatched, 0);
    assert.equal(loadRunManifest(repo, manifest.runId).status, "running");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("resume merges an abandoned attempt's cost with the new attempt without overwriting it", async () => {
  const repo = initRepo();
  try {
    const abandonedCost = createCostTruth({
      observations: [
        createCostObservation({
          sessionId: "abandoned-session",
          amount: 0.04,
          currency: "USD",
          usage: FULL_USAGE,
        }),
      ],
    });
    const { runId } = seedInterruptedRun(repo, abandonedCost);

    assert.equal(await resumeWithCost(repo, runId, "new-session", 0.02), 0);

    const completed = loadRunManifest(repo, runId);
    assert.equal(completed.status, "completed");
    const task = completed.tasks["task"]!;
    assert.equal(task.accepted, true);
    assert.equal(task.priorAttemptCost, undefined, "retention field is cleared");
    assert.ok(task.cost);
    assert.equal(task.cost.amount, 0.06);
    assert.equal(task.cost.authoritative, false);
    assert.equal(task.cost.observations.length, 2);

    const abandoned = task.cost.observations.filter(
      (observation) => observation.sessionId === "abandoned-session",
    );
    assert.equal(abandoned.length, 1);
    assert.equal(abandoned[0]?.amount, 0.04);

    const resumed = task.cost.observations.filter(
      (observation) => observation.sessionId === "new-session",
    );
    assert.equal(resumed.length, 1, "new attempt observations stay separate");
    assert.equal(resumed[0]?.amount, 0.02);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("resume records an unavailable abandoned session in missing", async () => {
  const repo = initRepo();
  try {
    const abandonedCost = unavailableCostTruth({
      sessionId: "abandoned-unavailable",
      note: "provider emitted no usage",
    });
    const { runId } = seedInterruptedRun(repo, abandonedCost);

    assert.equal(await resumeWithCost(repo, runId, "new-session", 0.02), 0);

    const task = loadRunManifest(repo, runId).tasks["task"]!;
    assert.equal(task.accepted, true);
    assert.ok(task.cost);
    // Only the real new session contributes a known amount.
    assert.equal(task.cost.amount, 0.02);
    assert.equal(task.cost.state, "cli-estimated");
    assert.equal(task.cost.observations.length, 2);

    const abandoned = task.cost.observations.find(
      (observation) => observation.sessionId === "abandoned-unavailable",
    );
    assert.ok(abandoned, "abandoned session stays in provenance");
    assert.equal(abandoned.state, "unavailable");
    assert.equal(abandoned.amount, null);

    // The unavailable observation is not silently dropped: its absent fields
    // remain missing in the merged truth.
    assert.ok(task.cost.missing.includes("cost.amount"));
    assert.ok(task.cost.missing.includes("cost.usage"));
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("a resumed legacy run checkpoints through the StateStore", async () => {
  const repo = initRepo();
  try {
    const abandonedCost = createCostTruth({
      observations: [
        createCostObservation({
          sessionId: "abandoned-session",
          amount: 0.04,
          currency: "USD",
          usage: FULL_USAGE,
        }),
      ],
    });
    const { runId } = seedInterruptedRun(repo, abandonedCost);

    // Simulate a run directory written before the cutover: no StateStore yet.
    rmSync(supervisorStatePaths(repo).stateDir, {
      recursive: true,
      force: true,
    });
    assert.equal(inspectSupervisorStateStore(repo), undefined);

    assert.equal(await resumeWithCost(repo, runId, "new-session", 0.02), 0);

    const inspection = inspectSupervisorStateStore(repo);
    assert.ok(inspection, "resume must create the StateStore authority");
    assert.ok(inspection.migration, "resume must import the legacy run once");
    assert.equal(inspection.migration.importedRuns, 1);
    assert.match(inspection.migration.importHash, /^[0-9a-f]{64}$/);
    assert.equal(inspection.runs[0]?.runId, runId);
    assert.equal(inspection.activeRun?.runId, runId);

    // The JSON export is derived: removing it must not lose resume state.
    rmSync(supervisorPaths(repo).runsDir, { recursive: true, force: true });
    assert.equal(existsSync(supervisorPaths(repo).activePath), false);

    const completed = loadRunManifest(repo, runId);
    assert.equal(completed.status, "completed");
    const task = completed.tasks["task"]!;
    assert.equal(task.accepted, true);
    assert.ok(task.cost);
    assert.equal(task.cost.amount, 0.06);
    assert.equal(task.cost.observations.length, 2);
    assert.equal(
      task.cost.observations.filter(
        (observation) => observation.sessionId === "abandoned-session",
      ).length,
      1,
    );
    assert.equal(
      task.cost.observations.filter(
        (observation) => observation.sessionId === "new-session",
      ).length,
      1,
    );
    assert.deepEqual(inspection.runs, [completed]);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("resume resolves a relative contracts path against repoRoot", async () => {
  const repo = initRepo();
  try {
    const base = runGit(repo, ["rev-parse", "HEAD"]);
    writeContracts(repo, base);
    const manifest = createRunManifest(repo, {
      planId: "relative-contracts",
      contractsPath: "contracts.json",
      baseCommit: base,
      integrationBranch: "cliyard/integration/relative-contracts",
      tasks: ["foundation", "left", "right", "upper"],
    });

    const harness: WorkerHarness = { started: [] };
    const result = await runCodexBatch({
      contractsPath: "contracts.json",
      repoRoot: repo,
      ledgerPath: join(repo, ".cliyard", "ledger.json"),
      worker: "claude",
      dryRun: false,
      keepWorktrees: false,
      runManifest: manifest,
      workerFactory: (_worker, cwd) =>
        createFixtureWorker(cwd, harness),
    });

    assert.equal(result.allAccepted, true);
    assert.deepEqual(result.startOrder, [
      "foundation",
      "left",
      "right",
      "upper",
    ]);
    assert.equal(result.manifest?.status, "completed");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

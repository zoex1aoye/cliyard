import { test } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { hostname, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import type {
  AgentAdapter,
  AgentResult,
  AgentStartInput,
} from "../src/agents/types.js";
import {
  processGroupRuntimeHandle,
  workerLeasePath,
  type WorkerLease,
} from "../src/agents/worker-lease.js";
import type {
  ExecutionContinuityPolicy,
  TaskContract,
} from "../src/contracts/schema.js";
import { ProcessInspector } from "../src/runtime/process.js";
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
  execution?: TaskContract["execution"],
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
    ...(execution === undefined ? {} : { execution }),
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

interface ContinuityTaskSpec {
  taskId: string;
  continuity?: ExecutionContinuityPolicy;
}

function writeContinuityContracts(
  repo: string,
  baseCommit: string,
  specs: readonly ContinuityTaskSpec[],
): string {
  const path = join(repo, "contracts.json");
  writeFileSync(
    path,
    JSON.stringify(
      {
        contracts: specs.map(({ taskId, continuity }) =>
          contract(
            taskId,
            [],
            `${taskId}.ts`,
            baseCommit,
            [`test -f ${taskId}.ts`],
            continuity === undefined ? undefined : { continuity },
          ),
        ),
      },
      null,
      2,
    ) + "\n",
    "utf8",
  );
  return path;
}

function writeSingleTaskContracts(
  repo: string,
  baseCommit: string,
  continuity?: ExecutionContinuityPolicy,
): string {
  return writeContinuityContracts(repo, baseCommit, [{ taskId: "task", continuity }]);
}

/** A real, detached POSIX process group used as an execution unit fixture. */
interface ActiveUnit {
  child: ChildProcess;
  pid: number;
  startedAt: string;
  termMarker: string;
  exitMarker: string;
  releasePath: string;
}

/**
 * Spawn a dedicated-group unit. It exits only after `release` is written, or
 * on SIGTERM unless `ignoreSigterm` simulates a unit that outlives the bound.
 */
async function spawnActiveUnit(
  repo: string,
  prefix: string,
  options: { ignoreSigterm?: boolean } = {},
): Promise<ActiveUnit> {
  const termMarker = join(repo, `${prefix}.term`);
  const exitMarker = join(repo, `${prefix}.exited`);
  const releasePath = join(repo, `${prefix}.release`);
  const script = `
    const fs = require("node:fs");
    process.on("SIGTERM", () => {
      fs.writeFileSync(${JSON.stringify(termMarker)}, "sigterm");
      ${options.ignoreSigterm ? "" : "process.exit(0);"}
    });
    const timer = setInterval(() => {
      if (!fs.existsSync(${JSON.stringify(releasePath)})) return;
      clearInterval(timer);
      fs.writeFileSync(${JSON.stringify(exitMarker)}, "exited");
      process.exit(0);
    }, 25);
  `;
  const child = spawn(process.execPath, ["-e", script], {
    detached: true,
    stdio: "ignore",
  });
  await once(child, "spawn");
  const pid = child.pid;
  assert.ok(pid !== undefined, "fixture unit must spawn");
  const identity = await new ProcessInspector().capture(pid);
  assert.ok(identity, "fixture unit identity must be capturable");
  assert.equal(identity.pid, pid);
  assert.equal(identity.pgid, pid, "detached unit must lead its own group");
  return {
    child,
    pid,
    startedAt: identity.startedAt,
    termMarker,
    exitMarker,
    releasePath,
  };
}

/** Capture a valid controller identity, then kill the process it described. */
async function deadController(): Promise<WorkerLease["controller"]> {
  const child = spawn(
    process.execPath,
    ["-e", "setTimeout(() => {}, 60_000)"],
    { stdio: "ignore" },
  );
  await once(child, "spawn");
  const pid = child.pid;
  assert.ok(pid !== undefined);
  const identity = await new ProcessInspector().capture(pid);
  assert.ok(identity);
  child.kill("SIGKILL");
  await once(child, "exit");
  return { pid, host: hostname(), identity };
}

function writeActiveLease(
  repo: string,
  runId: string,
  taskId: string,
  unit: ActiveUnit,
  controller: WorkerLease["controller"],
  leaseId: string,
): string {
  const startedAt = new Date().toISOString();
  // Production leases persist RuntimeHandle as the only recovery authority.
  // Fixture leases must do the same; pid/pgid remain diagnostics only.
  const runtime = processGroupRuntimeHandle({
    pid: unit.pid,
    pgid: unit.pid,
    startedAt: unit.startedAt,
  });
  const lease: WorkerLease = {
    version: 1,
    leaseId,
    repoRoot: resolve(repo),
    runId,
    taskId,
    attempt: 0,
    invocationId: `fixture-${taskId}`,
    controller,
    worker: {
      pid: unit.pid,
      pgid: unit.pid,
      osStartIdentity: unit.startedAt,
      captureMode: "posix-group",
    },
    runtime,
    workspace: repo,
    startedAt,
    updatedAt: startedAt,
    state: "active",
  };
  const path = workerLeasePath(repo, runId, taskId, leaseId);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(lease, null, 2)}\n`, "utf8");
  return path;
}

/**
 * Seed an interrupted run whose previous controller died while the supplied
 * units were still executing. No attempt result or acceptance is recorded.
 */
async function seedRunWithLeases(
  repo: string,
  planId: string,
  specs: readonly (ContinuityTaskSpec & { unit: ActiveUnit })[],
): Promise<{ runId: string; integrationBranch: string; leasePaths: Record<string, string> }> {
  const base = runGit(repo, ["rev-parse", "HEAD"]);
  const contractsPath = writeContinuityContracts(repo, base, specs);
  const manifest = createRunManifest(repo, {
    planId,
    contractsPath,
    baseCommit: base,
    integrationBranch: `cliyard/integration/${planId}-${base.slice(0, 8)}`,
    tasks: specs.map((spec) => spec.taskId),
  });
  runGit(repo, ["branch", manifest.integrationBranch, base]);
  updateRunManifest(repo, manifest.runId, (current) => {
    for (const spec of specs) {
      const task = current.tasks[spec.taskId]!;
      task.status = "running";
      task.attemptStartedAt = new Date().toISOString();
    }
  });

  const controller = await deadController();
  const leasePaths: Record<string, string> = {};
  for (const [index, spec] of specs.entries()) {
    leasePaths[spec.taskId] = writeActiveLease(
      repo,
      manifest.runId,
      spec.taskId,
      spec.unit,
      controller,
      `lease-${index + 1}`,
    );
  }
  return {
    runId: manifest.runId,
    integrationBranch: manifest.integrationBranch,
    leasePaths,
  };
}

function startResumeWithContinuity(
  repo: string,
  runId: string,
  harness: WorkerHarness,
  durableAttachTimeoutMs?: number,
): { promise: Promise<number>; lines: string[] } {
  const lines: string[] = [];
  const promise = runSupervisorCli(
    ["resume", "--repo", repo, "--run", runId],
    {
      log: (line) => lines.push(line),
      // Continuity progress is diagnostics, not part of the JSON summary.
      diagnostics: (line) => lines.push(line),
      signalHandling: false,
      ...(durableAttachTimeoutMs === undefined
        ? {}
        : { durableAttachTimeoutMs }),
      workerFactory: (_worker, cwd) => createFixtureWorker(cwd, harness),
    },
  );
  return { promise, lines };
}

async function waitForLogLine(
  lines: readonly string[],
  pattern: RegExp,
  timeoutMs = 10_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (lines.some((line) => pattern.test(line))) return;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
  }
  assert.fail(`timed out waiting for ${pattern}; got:\n${lines.join("\n")}`);
}

/** The last JSON object emitted on stdout is the run summary. */
function resumeSummary(lines: readonly string[]): Record<string, any> {
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try {
      const value = JSON.parse(lines[index]!) as unknown;
      if (value !== null && typeof value === "object" && "runId" in value) {
        return value as Record<string, any>;
      }
    } catch {
      // Diagnostics lines are plain text and are skipped.
    }
  }
  assert.fail(`no run summary in output:\n${lines.join("\n")}`);
}

function disposeUnit(unit: ActiveUnit | undefined): void {
  if (!unit) return;
  try {
    unit.child.kill("SIGKILL");
  } catch {
    // The unit already exited.
  }
}

function readLease(path: string): WorkerLease {
  return JSON.parse(readFileSync(path, "utf8")) as WorkerLease;
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

// ---------------------------------------------------------------------------
// execution.continuity
// ---------------------------------------------------------------------------

test("resume stops an expired fail-closed worker lease before re-dispatch", async () => {
  const repo = initRepo();
  const unit = await spawnActiveUnit(repo, "fail-closed-unit");
  try {
    const { runId, leasePaths } = await seedRunWithLeases(
      repo,
      "continuity-fail-closed",
      [{ taskId: "task", continuity: "fail-closed", unit }],
    );

    const harness: WorkerHarness = { started: [] };
    const { promise, lines } = startResumeWithContinuity(repo, runId, harness);
    assert.equal(await promise, 0);

    assert.deepEqual(harness.started, ["task"]);
    assert.ok(existsSync(unit.termMarker), "SIGTERM must reach the expired unit");
    assert.ok(
      lines.some((line) =>
        /continuity: fail-closed task task stopped on lease expiry \(terminated\)/.test(
          line,
        ),
      ),
      `missing fail-closed stop log:\n${lines.join("\n")}`,
    );
    // The summary stays valid JSON and carries the machine-readable outcome.
    const summary = resumeSummary(lines);
    assert.deepEqual(summary.continuity, {
      attached: [],
      exited: [],
      stopped: ["task"],
      durable: [],
      failClosed: ["task"],
    });

    const lease = readLease(leasePaths["task"]!);
    assert.equal(lease.state, "released");
    assert.equal(lease.cleanupReason, "recovery");
    assert.equal(lease.recovery?.[0]?.action, "terminated");
    assert.equal(lease.recovery?.[0]?.outcome, "recovered");

    const completed = loadRunManifest(repo, runId);
    assert.equal(completed.status, "completed");
    assert.equal(completed.tasks["task"]?.accepted, true);
  } finally {
    disposeUnit(unit);
    rmSync(repo, { recursive: true, force: true });
  }
});

test("resume re-attaches a durable unit by RuntimeHandle and never signals it", async () => {
  const repo = initRepo();
  const unit = await spawnActiveUnit(repo, "durable-unit");
  try {
    const { runId, leasePaths } = await seedRunWithLeases(
      repo,
      "continuity-durable",
      [{ taskId: "task", continuity: "durable", unit }],
    );

    const harness: WorkerHarness = { started: [] };
    const { promise, lines } = startResumeWithContinuity(
      repo,
      runId,
      harness,
      10_000,
    );
    await waitForLogLine(
      lines,
      /continuity: durable task task re-attached by RuntimeHandle process-group:/,
    );
    assert.equal(
      harness.started.length,
      0,
      "resume must wait for the durable unit before dispatch",
    );

    // Let the preserved unit finish on its own.
    writeFileSync(unit.releasePath, "release", "utf8");
    assert.equal(await promise, 0);

    assert.deepEqual(harness.started, ["task"]);
    assert.equal(
      existsSync(unit.termMarker),
      false,
      "a durable unit must never receive SIGTERM from resume",
    );
    assert.ok(existsSync(unit.exitMarker), "durable unit exited on its own");
    assert.ok(
      lines.some((line) =>
        /continuity: durable task task exited before dispatch/.test(line),
      ),
      `missing durable exit log:\n${lines.join("\n")}`,
    );
    const summary = resumeSummary(lines);
    const continuity = summary.continuity as Record<string, any>;
    assert.deepEqual(continuity.durable, ["task"]);
    assert.deepEqual(continuity.failClosed, []);
    assert.deepEqual(continuity.stopped, []);
    assert.equal(continuity.attached.length, 1);
    assert.equal(continuity.attached[0].taskId, "task");
    assert.equal(continuity.attached[0].leaseId, "lease-1");
    assert.equal(continuity.attached[0].handle.backendType, "process-group");
    assert.match(continuity.attached[0].handle.handle, /^\d+:/);
    // The unit was live at attach; it exited during the bounded hold, so it is
    // not reported as an already-gone lease.
    assert.deepEqual(continuity.exited, []);

    const lease = readLease(leasePaths["task"]!);
    assert.equal(lease.state, "active");
    assert.equal(lease.cleanupReason, undefined);
    assert.equal(lease.recovery, undefined);

    const completed = loadRunManifest(repo, runId);
    assert.equal(completed.status, "completed");
    assert.equal(completed.tasks["task"]?.accepted, true);
  } finally {
    disposeUnit(unit);
    rmSync(repo, { recursive: true, force: true });
  }
});

test("resume bounds a durable attachment and preserves the running unit", async () => {
  const repo = initRepo();
  const unit = await spawnActiveUnit(repo, "durable-slow", {
    ignoreSigterm: true,
  });
  try {
    const { runId, leasePaths } = await seedRunWithLeases(
      repo,
      "continuity-durable-bound",
      [{ taskId: "task", continuity: "durable", unit }],
    );

    const harness: WorkerHarness = { started: [] };
    const { promise, lines } = startResumeWithContinuity(
      repo,
      runId,
      harness,
      200,
    );
    await assert.rejects(
      promise,
      /durable task task is still running after 200ms/,
    );

    assert.ok(
      lines.some((line) => /re-attached by RuntimeHandle/.test(line)),
      "the bound only applies after a successful re-attach",
    );
    assert.equal(
      harness.started.length,
      0,
      "no task may be dispatched while its durable unit is still running",
    );
    assert.equal(existsSync(unit.termMarker), false);
    assert.ok(
      new ProcessInspector().isAlive(unit.pid),
      "the durable unit must be preserved when the bound is hit",
    );

    const lease = readLease(leasePaths["task"]!);
    assert.equal(lease.state, "active");
    assert.equal(lease.recovery, undefined);
    assert.equal(loadRunManifest(repo, runId).tasks["task"]?.accepted, false);
  } finally {
    disposeUnit(unit);
    rmSync(repo, { recursive: true, force: true });
  }
});

test("resume preserves a durable unit while stopping a legacy fail-closed unit", async () => {
  const repo = initRepo();
  const durableUnit = await spawnActiveUnit(repo, "mixed-durable");
  const failClosedUnit = await spawnActiveUnit(repo, "mixed-fail-closed");
  try {
    const { runId, leasePaths } = await seedRunWithLeases(
      repo,
      "continuity-mixed",
      [
        { taskId: "durable-task", continuity: "durable", unit: durableUnit },
        // Absent execution keeps the legacy fail-closed default.
        { taskId: "fail-closed-task", unit: failClosedUnit },
      ],
    );

    const harness: WorkerHarness = { started: [] };
    const { promise, lines } = startResumeWithContinuity(
      repo,
      runId,
      harness,
      10_000,
    );
    await waitForLogLine(
      lines,
      /continuity: durable task durable-task re-attached/,
    );
    writeFileSync(durableUnit.releasePath, "release", "utf8");
    assert.equal(await promise, 0);

    assert.deepEqual([...harness.started].sort(), [
      "durable-task",
      "fail-closed-task",
    ]);
    assert.equal(
      existsSync(durableUnit.termMarker),
      false,
      "durable unit must not be signalled by the run-scoped recovery",
    );
    assert.ok(
      existsSync(failClosedUnit.termMarker),
      "legacy fail-closed unit must stop on lease expiry",
    );
    assert.ok(
      lines.some((line) =>
        /continuity: fail-closed task fail-closed-task stopped on lease expiry/.test(
          line,
        ),
      ),
      `missing mixed fail-closed stop log:\n${lines.join("\n")}`,
    );
    const summary = resumeSummary(lines);
    const continuity = summary.continuity as Record<string, any>;
    assert.deepEqual(continuity.durable, ["durable-task"]);
    assert.deepEqual(continuity.failClosed, ["fail-closed-task"]);
    assert.deepEqual(continuity.stopped, ["fail-closed-task"]);
    assert.deepEqual(
      continuity.attached.map((entry: { taskId: string }) => entry.taskId),
      ["durable-task"],
    );

    // The durable lease is left active: its unit exited but the contract's
    // durable policy explicitly keeps recovery from driving that decision.
    const durableLease = readLease(leasePaths["durable-task"]!);
    assert.equal(durableLease.state, "active");

    const failClosedLease = readLease(leasePaths["fail-closed-task"]!);
    assert.equal(failClosedLease.state, "released");
    assert.equal(failClosedLease.recovery?.[0]?.action, "terminated");

    const completed = loadRunManifest(repo, runId);
    assert.equal(completed.status, "completed");
    assert.deepEqual(
      Object.values(completed.tasks)
        .filter((task) => task.accepted)
        .map((task) => task.taskId)
        .sort(),
      ["durable-task", "fail-closed-task"],
    );
  } finally {
    disposeUnit(durableUnit);
    disposeUnit(failClosedUnit);
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

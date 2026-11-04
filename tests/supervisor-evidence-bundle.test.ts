import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
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
import type { WorkerProcessRecord } from "../src/agents/process-tree.js";
import type { TaskContract } from "../src/contracts/schema.js";
import {
  createCostObservation,
  createCostTruth,
  createFailureRecord,
  type CostTruth,
} from "../src/failures.js";
import { runSupervisorCli } from "../src/supervisor/cli.js";
import {
  evidenceBundlePath,
  runManifestHash,
} from "../src/supervisor/evidence-bundle.js";
import {
  createRunManifest,
  loadRunManifest,
  supervisorPaths,
} from "../src/supervisor/store.js";
import type { RunManifest } from "../src/supervisor/types.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const OBSERVED_AT = "2026-10-01T00:30:00.000Z";

const USAGE = {
  inputTokens: 10,
  outputTokens: 5,
  cacheCreationInputTokens: 0,
  cacheReadInputTokens: 2,
};

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
  const repo = mkdtempSync(join(tmpdir(), "cliyard-evidence-cli-"));
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

function contract(
  taskId: string,
  dependsOn: string[],
  writePath: string,
  baseCommit: string,
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
    verifyCommands: [`test -f ${writePath}`],
    maxRepairs: 0,
  };
}

function writeContracts(
  repo: string,
  baseCommit: string,
  tasks: TaskContract[] = [
    contract("foundation", [], "foundation.ts", baseCommit),
  ],
): string {
  const path = join(repo, "contracts.json");
  writeFileSync(
    path,
    JSON.stringify({ contracts: tasks }, null, 2) + "\n",
    "utf8",
  );
  return path;
}

function taskCost(taskId: string, amount: number): CostTruth {
  return createCostTruth({
    observations: [
      createCostObservation({
        sessionId: `fixture-${taskId}`,
        amount,
        currency: "USD",
        source: "cli",
        usage: USAGE,
      }),
    ],
  });
}

function processTreeFixture(): WorkerProcessRecord {
  return {
    version: 1,
    host: "fixture-host",
    pid: 4242,
    pgid: 4242,
    captureSource: "ps-exact",
    captureSupport: "posix-process-group",
    cleanupReason: "child-close",
    cleanupState: "clean",
    cleanupCompleteness: "complete",
    durableRecoveryCompleteness: "complete",
    signals: [],
    residualMembers: [],
    residualCount: 0,
    startedAt: OBSERVED_AT,
    closedAt: "2026-10-01T00:31:00.000Z",
    cleanedAt: "2026-10-01T00:31:01.000Z",
  };
}

interface WorkerHarness {
  started: string[];
  /** Task ids whose worker exits non-zero. */
  failOn?: ReadonlySet<string>;
  amount?: number;
}

function createFixtureWorker(
  cwd: string,
  harness: WorkerHarness,
): AgentAdapter {
  let current: TaskContract | undefined;
  return {
    id: "claude",
    async discover() {
      return {
        id: "claude",
        ok: true,
        supportsModelFlag: true,
        notes: ["supervisor evidence fixture"],
      };
    },
    async start(input: AgentStartInput) {
      current = input.contract;
      harness.started.push(current.taskId);
      return { sessionId: `fixture-${current.taskId}` };
    },
    async collect(sessionId: string): Promise<AgentResult> {
      if (!current) throw new Error("worker did not start");
      const file = `${current.taskId}.ts`;
      writeFileSync(join(cwd, file), `export const name = '${current.taskId}';\n`);
      const failed = harness.failOn?.has(current.taskId) === true;
      return {
        sessionId,
        exitCode: failed ? 1 : 0,
        touchedPaths: [file],
        logTail: `[fixture] ${current.taskId}`,
        cost: taskCost(current.taskId, harness.amount ?? 1.25),
        processTrees: [processTreeFixture()],
        ...(failed
          ? {
              failure: createFailureRecord({
                exitCode: 1,
                text: `fixture rejected ${current.taskId}`,
                retryableHint: false,
                observedAt: OBSERVED_AT,
              }),
            }
          : {}),
      };
    },
    async cancel() {},
  };
}

function harnessFactory(harness: WorkerHarness) {
  return (_worker: "codex" | "claude", cwd: string) =>
    createFixtureWorker(cwd, harness);
}

function parseJson(lines: string[]): Record<string, any> {
  return JSON.parse(lines.join("\n")) as Record<string, any>;
}

interface StartedRun {
  code: number;
  summary: Record<string, any>;
  manifest: RunManifest;
  repo: string;
  bundlePath: string;
}

async function startRun(
  repo: string,
  harness: WorkerHarness = { started: [] },
  tasks?: TaskContract[],
): Promise<StartedRun> {
  const base = runGit(repo, ["rev-parse", "HEAD"]);
  const contractsPath = writeContracts(repo, base, tasks);
  const out: string[] = [];
  const code = await runSupervisorCli(
    ["start", contractsPath, "--repo", repo, "--worker", "claude", "--dry-run"],
    {
      log: (line) => out.push(line),
      signalHandling: false,
      workerFactory: harnessFactory(harness),
    },
  );
  const summary = parseJson(out);
  const manifest = loadRunManifest(repo, summary.runId as string);
  return {
    code,
    summary,
    manifest,
    repo,
    bundlePath: evidenceBundlePath(repo, manifest.runId),
  };
}

function readBundle(path: string): Record<string, any> {
  return JSON.parse(readFileSync(path, "utf8")) as Record<string, any>;
}

function fileHash(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

async function runStatusJson(
  repo: string,
  runId: string,
): Promise<Record<string, any>> {
  const out: string[] = [];
  const code = await runSupervisorCli(
    ["status", "--repo", repo, "--run", runId, "--json"],
    { log: (line) => out.push(line), signalHandling: false },
  );
  assert.equal(code, 0);
  return parseJson(out);
}

async function runEvidenceCommand(
  repo: string,
  runId: string,
  extra: string[] = [],
): Promise<{ code: number; result: Record<string, any> }> {
  const out: string[] = [];
  const code = await runSupervisorCli(
    ["evidence", "--repo", repo, "--run", runId, "--json", ...extra],
    { log: (line) => out.push(line), signalHandling: false },
  );
  return { code, result: parseJson(out) };
}

// ---------------------------------------------------------------------------
// Automatic finalization
// ---------------------------------------------------------------------------

test("completed run automatically writes an exact final evidence bundle", async () => {
  await withRepo(async (repo) => {
    const run = await startRun(repo, { started: [] });

    assert.equal(run.code, 0);
    assert.equal(run.summary.status, "completed");
    assert.equal(run.summary.evidence.state, "present");
    assert.equal(run.summary.evidence.degraded, false);
    assert.equal(run.summary.evidence.path, run.bundlePath);
    assert.equal(existsSync(run.bundlePath), true);

    const bundle = readBundle(run.bundlePath);
    const manifest = run.manifest;
    const manifestPath = join(
      supervisorPaths(repo).runsDir,
      `${manifest.runId}.json`,
    );
    const manifestRaw = readFileSync(manifestPath, "utf8");

    assert.equal(bundle.version, 1);
    assert.deepEqual(bundle.run, {
      runId: manifest.runId,
      planId: manifest.planId,
      status: "completed",
      terminal: true,
      createdAt: manifest.createdAt,
      updatedAt: manifest.updatedAt,
    });
    assert.equal(bundle.generatedAt, manifest.updatedAt);

    // The bundle binds itself to the exact RunManifest bytes on disk while
    // remaining a non-authority projection.
    assert.equal(
      bundle.authority.manifest.hash,
      createHash("sha256").update(manifestRaw, "utf8").digest("hex"),
    );
    assert.equal(bundle.authority.manifest.hash, runManifestHash(manifest));
    assert.equal(bundle.authority.taskAuthority, "run-manifest");
    assert.equal(bundle.authority.grantsAcceptance, false);
    assert.equal(bundle.authority.authorizesMerge, false);
    assert.equal(bundle.authority.replacesVerification, false);

    assert.equal(
      bundle.authority.contracts.path,
      manifest.contractsPath,
    );
    assert.equal(bundle.authority.contracts.hash, manifest.contractsHash);
    assert.equal(bundle.authority.contracts.verified, true);

    const head = runGit(repo, [
      "rev-parse",
      "--verify",
      `refs/heads/${manifest.integrationBranch}`,
    ]);
    assert.equal(bundle.repository.baseCommit, manifest.baseCommit);
    assert.equal(
      bundle.repository.integrationBranch,
      manifest.integrationBranch,
    );
    assert.equal(bundle.repository.integrationHead, manifest.integrationHead);
    assert.equal(bundle.repository.observedIntegrationHead, head);
    assert.equal(bundle.repository.integrationHeadVerified, true);

    // Every task fact is copied exactly from the manifest. The fixture worker
    // supplied cost and a clean process tree; the batch supplied path audits
    // and the WorkspaceBoundary record after the worker exited.
    const taskIds = Object.keys(manifest.tasks).sort();
    assert.deepEqual(
      bundle.tasks.map((task: Record<string, any>) => task.taskId),
      taskIds,
    );
    for (const taskId of taskIds) {
      const source = manifest.tasks[taskId]!;
      const projected = bundle.tasks.find(
        (task: Record<string, any>) => task.taskId === taskId,
      );
      assert.ok(projected);
      assert.equal(projected.status, source.status);
      assert.equal(projected.accepted, source.accepted);
      assert.equal(projected.verdict, "accepted");
      assert.equal(projected.resultCommit, source.resultCommit);
      assert.deepEqual(projected.cost, source.cost);
      assert.deepEqual(projected.pathAudits, source.pathAudits);
      assert.deepEqual(projected.processTrees, source.processTrees);
      assert.deepEqual(projected.workspaceBoundary, source.workspaceBoundary);
      assert.equal(projected.pathAudits.length, 1);
      assert.ok(projected.pathAudits[0].changedPaths.includes(`${taskId}.ts`));
      assert.deepEqual(projected.pathAudits[0].outsideWritePaths, []);
      assert.equal(projected.processTrees[0].cleanupState, "clean");
      assert.equal(projected.processTrees[0].residualCount, 0);
      assert.equal(projected.workspaceBoundary.status, "clean");
      assert.equal(projected.cost.amount, 1.25);
    }

    assert.equal(bundle.cost.state, "cli-estimated");
    assert.equal(bundle.cost.amount, 1.25);
    assert.equal(bundle.cost.currency, "USD");
    assert.equal(bundle.cost.authoritative, false);
    assert.deepEqual(bundle.missing, []);
    assert.equal(bundle.humanReviewRequired, true);
    assert.equal(bundle.nextAction, "human-review");

    // The RunManifest is untouched by evidence finalization.
    assert.equal(readFileSync(manifestPath, "utf8"), manifestRaw);
    assert.equal(loadRunManifest(repo, manifest.runId).updatedAt, manifest.updatedAt);
  });
});

test("blocked run writes a bundle that carries failure truth", async () => {
  await withRepo(async (repo) => {
    const base = runGit(repo, ["rev-parse", "HEAD"]);
    const tasks = [
      contract("foundation", [], "foundation.ts", base),
      contract("upper", ["foundation"], "upper.ts", base),
    ];
    const run = await startRun(
      repo,
      { started: [], failOn: new Set(["foundation"]) },
      tasks,
    );

    assert.equal(run.code, 1);
    assert.equal(run.summary.status, "blocked");
    assert.equal(run.summary.evidence.state, "present");
    assert.equal(existsSync(run.bundlePath), true);

    const bundle = readBundle(run.bundlePath);
    assert.equal(bundle.run.status, "blocked");
    assert.equal(bundle.run.terminal, true);
    assert.equal(bundle.humanReviewRequired, true);
    assert.equal(bundle.nextAction, "inspect-failure");

    const byId = new Map<string, Record<string, any>>(
      bundle.tasks.map((task: Record<string, any>) => [task.taskId, task]),
    );
    const rejected = byId.get("foundation")!;
    assert.equal(rejected.status, "rejected");
    assert.equal(rejected.verdict, "rejected");
    assert.equal(rejected.accepted, false);
    assert.ok(rejected.failure);
    assert.equal(rejected.failure.retryableHint, false);
    assert.equal(rejected.cost.amount, 1.25);

    const blocked = byId.get("upper")!;
    assert.equal(blocked.status, "blocked");
    assert.equal(blocked.verdict, "blocked");
    assert.equal(blocked.accepted, false);
    assert.ok(blocked.failure);
    assert.deepEqual(bundle.missing, []);
  });
});

// ---------------------------------------------------------------------------
// Status projection
// ---------------------------------------------------------------------------

test("status reports present, missing and invalid evidence without writing", async () => {
  await withRepo(async (repo) => {
    const run = await startRun(repo, { started: [] });
    const originalBundle = readFileSync(run.bundlePath);
    const manifestPath = join(
      supervisorPaths(repo).runsDir,
      `${run.manifest.runId}.json`,
    );
    const originalManifest = readFileSync(manifestPath);

    const present = await runStatusJson(repo, run.manifest.runId);
    assert.equal(present.evidence.state, "present");
    assert.equal(present.evidence.degraded, false);
    assert.equal(present.evidence.path, run.bundlePath);
    assert.equal(present.evidence.nextAction, "human-review");
    assert.equal(present.evidence.humanReviewRequired, true);
    assert.equal(present.evidence.taskCount, 1);
    assert.equal(present.evidence.missingCount, 0);
    assert.deepEqual(present.evidence.missing, []);
    assert.equal(present.evidence.cost.state, "cli-estimated");
    assert.equal(present.evidence.cost.amount, 1.25);

    const human: string[] = [];
    await runSupervisorCli(["status", "--repo", repo], {
      log: (line) => human.push(line),
      signalHandling: false,
    });
    assert.match(human.join("\n"), /evidence: present/);
    assert.equal(readFileSync(run.bundlePath).equals(originalBundle), true);

    // Missing evidence is degraded, and status never repairs it.
    rmSync(run.bundlePath);
    const missing = await runStatusJson(repo, run.manifest.runId);
    assert.equal(missing.evidence.state, "missing");
    assert.equal(missing.evidence.degraded, true);
    assert.match(missing.evidence.reason, /missing/);
    assert.equal(existsSync(run.bundlePath), false);

    const humanMissing: string[] = [];
    await runSupervisorCli(["status", "--repo", repo], {
      log: (line) => humanMissing.push(line),
      signalHandling: false,
    });
    assert.match(humanMissing.join("\n"), /evidence: missing \(degraded\)/);

    const readMissing = await runEvidenceCommand(repo, run.manifest.runId);
    assert.equal(readMissing.code, 1);
    assert.equal(readMissing.result.regenerated, false);
    assert.equal(readMissing.result.evidence.state, "missing");
    assert.equal(readMissing.result.evidence.degraded, true);
    assert.equal(existsSync(run.bundlePath), false);

    // A malformed bundle is invalid, never reported as success.
    writeFileSync(run.bundlePath, "not json\n", "utf8");
    const invalid = await runStatusJson(repo, run.manifest.runId);
    assert.equal(invalid.evidence.state, "invalid");
    assert.equal(invalid.evidence.degraded, true);
    assert.match(invalid.evidence.reason, /not valid JSON/);

    const readInvalid = await runEvidenceCommand(repo, run.manifest.runId);
    assert.equal(readInvalid.code, 1);
    assert.equal(readInvalid.result.evidence.state, "invalid");
    assert.equal(readFileSync(run.bundlePath, "utf8"), "not json\n");
    assert.deepEqual(readFileSync(manifestPath), originalManifest);
  });
});

// ---------------------------------------------------------------------------
// Explicit regeneration
// ---------------------------------------------------------------------------

test("explicit regeneration repairs evidence without mutating the RunManifest", async () => {
  await withRepo(async (repo) => {
    const run = await startRun(repo, { started: [] });
    const originalBundle = readFileSync(run.bundlePath);
    const manifestPath = join(
      supervisorPaths(repo).runsDir,
      `${run.manifest.runId}.json`,
    );
    const originalManifest = readFileSync(manifestPath);

    // A structurally valid bundle with a foreign manifest hash is invalid.
    const tampered = readBundle(run.bundlePath);
    tampered.authority.manifest.hash = "0".repeat(64);
    writeFileSync(run.bundlePath, JSON.stringify(tampered, null, 2) + "\n");
    const tamperedStatus = await runStatusJson(repo, run.manifest.runId);
    assert.equal(tamperedStatus.evidence.state, "invalid");
    assert.match(
      tamperedStatus.evidence.reason,
      /not bound to the current RunManifest/,
    );

    const regenerated = await runEvidenceCommand(repo, run.manifest.runId, [
      "--regenerate",
    ]);
    assert.equal(regenerated.code, 0);
    assert.equal(regenerated.result.regenerated, true);
    assert.equal(regenerated.result.written, true);
    assert.equal(regenerated.result.error, null);
    assert.equal(regenerated.result.evidence.state, "present");
    assert.equal(regenerated.result.evidence.degraded, false);
    assert.equal(readFileSync(run.bundlePath).equals(originalBundle), true);

    // The manifest, including its checkpoint timestamp, is only read.
    assert.equal(readFileSync(manifestPath).equals(originalManifest), true);
    assert.equal(
      loadRunManifest(repo, run.manifest.runId).updatedAt,
      run.manifest.updatedAt,
    );

    // Regeneration is idempotent for byte-identical source facts.
    const again = await runEvidenceCommand(repo, run.manifest.runId, [
      "--regenerate",
    ]);
    assert.equal(again.code, 0);
    assert.equal(again.result.written, false);
    assert.equal(readFileSync(run.bundlePath).equals(originalBundle), true);
    assert.equal(readFileSync(manifestPath).equals(originalManifest), true);

    // Human regeneration output is bounded and explicit.
    const human: string[] = [];
    const humanCode = await runSupervisorCli(
      ["evidence", "--repo", repo, "--run", run.manifest.runId, "--regenerate"],
      { log: (line) => human.push(line), signalHandling: false },
    );
    assert.equal(humanCode, 0);
    const text = human.join("\n");
    assert.match(text, /evidence: present/);
    assert.match(text, /already current/);
  });
});

// ---------------------------------------------------------------------------
// Running manifests
// ---------------------------------------------------------------------------

test("evidence rejects a running RunManifest without creating a bundle", async () => {
  await withRepo(async (repo) => {
    const base = runGit(repo, ["rev-parse", "HEAD"]);
    const contractsPath = writeContracts(repo, base);
    const manifest = createRunManifest(repo, {
      planId: "running-evidence",
      contractsPath,
      baseCommit: base,
      integrationBranch: "cliyard/integration/running-evidence",
      tasks: ["foundation"],
    });
    const path = evidenceBundlePath(repo, manifest.runId);
    assert.equal(existsSync(path), false);

    const regenerate = await runEvidenceCommand(repo, manifest.runId, [
      "--regenerate",
    ]);
    assert.equal(regenerate.code, 1);
    assert.match(regenerate.result.error, /running RunManifest/);
    assert.equal(regenerate.result.evidence.state, "not-terminal");
    assert.equal(existsSync(path), false);

    const read = await runEvidenceCommand(repo, manifest.runId);
    assert.equal(read.code, 1);
    assert.equal(read.result.error, null);
    assert.equal(read.result.evidence.state, "not-terminal");
    assert.equal(read.result.evidence.degraded, false);
    assert.equal(existsSync(path), false);

    const status = await runStatusJson(repo, manifest.runId);
    assert.equal(status.status, "running");
    assert.equal(status.evidence.state, "not-terminal");
    assert.equal(status.evidence.degraded, false);

    const human: string[] = [];
    await runSupervisorCli(["status", "--repo", repo, "--run", manifest.runId], {
      log: (line) => human.push(line),
      signalHandling: false,
    });
    assert.match(human.join("\n"), /evidence: not-terminal/);
    assert.equal(existsSync(path), false);
  });
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { runQueueCli } from "../src/orchestration/cli.js";
import {
  addQueueItem,
  loadQueue,
  queuePaths,
  type QueueItem,
} from "../src/orchestration/queue-store.js";
import type {
  QueueSupervisorRequest,
  QueueSupervisorRunner,
} from "../src/orchestration/queue-runner.js";
import {
  createRunManifest,
  updateRunManifest,
} from "../src/supervisor/store.js";
import type { RunStatus } from "../src/supervisor/types.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const CLI_PATH = fileURLToPath(new URL("../src/cli.ts", import.meta.url));

// ---------------------------------------------------------------------------
// Scratch repository fixtures
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
  const repo = mkdtempSync(join(tmpdir(), "cliyard-plan-cli-"));
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

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function commitFile(
  repo: string,
  name: string,
  content: string,
  message: string,
): string {
  writeFileSync(join(repo, name), content, "utf8");
  runGit(repo, ["add", name]);
  runGit(repo, ["commit", "-m", message]);
  return runGit(repo, ["rev-parse", "HEAD"]);
}

interface PlanTask {
  taskId: string;
  goal: string;
  writePaths: string[];
  verifyCommands: string[];
}

interface PlanFixture {
  path: string;
  hash: string;
  text: string;
  planId: string;
}

function writePlan(repo: string, planId: string): PlanFixture {
  const tasks: PlanTask[] = [
    {
      taskId: `${planId}-task`,
      goal: `Produce the ${planId} artifact`,
      writePaths: [`${planId}.txt`],
      verifyCommands: [`test -f ${planId}.txt`],
    },
  ];
  const text = `${JSON.stringify({ planId, tasks }, null, 2)}\n`;
  const path = join(repo, `${planId}.plan.json`);
  writeFileSync(path, text, "utf8");
  return { path, hash: sha256(text), text, planId };
}

function itemById(repo: string, id: string): QueueItem {
  const item = loadQueue(repo).items.find((candidate) => candidate.id === id);
  assert.ok(item, `queue item ${id} must exist`);
  return item;
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
// Injected Supervisor fixture
// ---------------------------------------------------------------------------

function materializationOf(request: QueueSupervisorRequest) {
  const materialization = request.item.materialization;
  assert.ok(
    materialization,
    `expected a materialization before dispatch of ${request.item.id}`,
  );
  return materialization;
}

/** Leave the completed RunManifest a real Supervisor would produce. */
function writeManifestForRequest(
  repo: string,
  request: QueueSupervisorRequest,
  runId: string,
  status: RunStatus,
  integrationHead?: string,
): void {
  const materialization = materializationOf(request);
  createRunManifest(repo, {
    runId,
    planId: request.item.planId ?? request.item.id,
    contractsPath: materialization.contractsPath,
    contractsHash: materialization.contractsHash,
    baseCommit: materialization.baseCommit,
    integrationBranch: `cliyard/integration/${runId}`,
    ...(integrationHead !== undefined ? { integrationHead } : {}),
    tasks: [],
  });
  updateRunManifest(repo, runId, (manifest) => {
    manifest.status = status;
  });
}

// ---------------------------------------------------------------------------
// add-plan / list
// ---------------------------------------------------------------------------

test("queue add-plan registers root and dependent Plan items and list exposes them", async () => {
  await withRepo(async (repo) => {
    const base = runGit(repo, ["rev-parse", "HEAD"]);
    const rootPlan = writePlan(repo, "root");
    const dependentPlan = writePlan(repo, "dependent");

    const root = await runCli(repo, [
      "add-plan",
      "root.plan.json",
      "--id",
      "root",
      "--worker",
      "codex",
      "--model",
      "fixture-model",
      "--max-attempts",
      "2",
      "--json",
    ]);
    assert.equal(root.code, 0);
    assert.equal(root.json.id, "root");
    assert.equal(root.json.planId, "root");
    assert.equal(root.json.planPath, rootPlan.path);
    assert.equal(root.json.planHash, rootPlan.hash);
    assert.equal(root.json.planBaseCommit, base);
    assert.deepEqual(root.json.dependsOn, []);
    assert.equal(root.json.worker, "codex");
    assert.equal(root.json.model, "fixture-model");
    assert.equal(root.json.maxAttempts, 2);
    assert.equal(root.json.status, "pending");
    assert.equal(root.json.attempts, 0);
    assert.equal(root.json.materialization, undefined);

    const dependent = await runCli(repo, [
      "add-plan",
      dependentPlan.path,
      "--id",
      "dependent",
      "--depends-on",
      "root",
      "--json",
    ]);
    assert.equal(dependent.code, 0);
    assert.equal(dependent.json.planId, "dependent");
    assert.equal(dependent.json.planPath, dependentPlan.path);
    assert.equal(dependent.json.planHash, dependentPlan.hash);
    assert.deepEqual(dependent.json.dependsOn, ["root"]);
    assert.equal(
      Object.hasOwn(dependent.json, "planBaseCommit"),
      false,
      "a dependent Plan item has no frozen root base",
    );
    assert.equal(dependent.json.materialization, undefined);

    const listed = await runCli(repo, ["list", "--json"]);
    assert.equal(listed.code, 0);
    assert.deepEqual(
      listed.json.items.map((item: QueueItem) => item.id),
      ["root", "dependent"],
    );
    assert.equal(listed.json.items[0].planPath, rootPlan.path);
    assert.equal(listed.json.items[0].planHash, rootPlan.hash);
    assert.equal(listed.json.items[0].planBaseCommit, base);
    assert.equal(listed.json.items[1].planHash, dependentPlan.hash);
    assert.deepEqual(listed.json.items[1].dependsOn, ["root"]);

    const human = await runCli(repo, ["list"]);
    assert.equal(human.code, 0);
    for (const fragment of [
      "queue: 2 item(s)",
      "root  pending",
      "dependent  pending",
      "deps=root",
      "plan: root",
      `plan path: ${rootPlan.path}`,
      `plan sha256: ${rootPlan.hash}`,
      `plan base: ${base} (frozen initial base)`,
      "contracts: not materialized yet",
      "plan: dependent",
      `plan path: ${dependentPlan.path}`,
      `plan sha256: ${dependentPlan.hash}`,
      "plan base: upstream root (materialized before dispatch)",
    ]) {
      assert.ok(
        human.text.includes(fragment),
        `list output missing ${JSON.stringify(fragment)}:\n${human.text}`,
      );
    }

    // Human add-plan output carries the same frozen Plan identity.
    const humanPlan = writePlan(repo, "human");
    const humanAdd = await runCli(repo, [
      "add-plan",
      humanPlan.path,
      "--id",
      "human",
    ]);
    assert.equal(humanAdd.code, 0);
    for (const fragment of [
      "added queue item human: pending",
      "plan: human",
      `plan path: ${humanPlan.path}`,
      `plan sha256: ${humanPlan.hash}`,
      "frozen initial base",
      "contracts: not materialized yet",
    ]) {
      assert.ok(
        humanAdd.text.includes(fragment),
        `add-plan output missing ${JSON.stringify(fragment)}:\n${humanAdd.text}`,
      );
    }
  });
});

// ---------------------------------------------------------------------------
// retry / cancel
// ---------------------------------------------------------------------------

test("queue retry and cancel expose Plan fields in JSON and human output", async () => {
  await withRepo(async (repo) => {
    const plan = writePlan(repo, "careful");
    const added = await runCli(repo, [
      "add-plan",
      plan.path,
      "--id",
      "careful",
      "--json",
    ]);
    assert.equal(added.code, 0);

    const retried = await runCli(repo, ["retry", "careful", "--json"]);
    assert.equal(retried.code, 0);
    assert.equal(retried.json.id, "careful");
    assert.equal(retried.json.planId, "careful");
    assert.equal(retried.json.planPath, plan.path);
    assert.equal(retried.json.planHash, plan.hash);
    assert.equal(retried.json.planBaseCommit, added.json.planBaseCommit);
    assert.equal(retried.json.status, "pending");

    const retryHuman = await runCli(repo, ["retry", "careful"]);
    assert.equal(retryHuman.code, 0);
    for (const fragment of [
      "queue item careful: pending",
      "plan: careful",
      `plan path: ${plan.path}`,
      `plan sha256: ${plan.hash}`,
      "frozen initial base",
      "contracts: not materialized yet",
    ]) {
      assert.ok(
        retryHuman.text.includes(fragment),
        `retry output missing ${JSON.stringify(fragment)}:\n${retryHuman.text}`,
      );
    }

    const cancelled = await runCli(repo, ["cancel", "careful", "--json"]);
    assert.equal(cancelled.code, 0);
    assert.equal(cancelled.json.status, "cancelled");
    assert.equal(cancelled.json.planId, "careful");
    assert.equal(cancelled.json.planPath, plan.path);
    assert.equal(cancelled.json.planHash, plan.hash);
    assert.equal(cancelled.json.planBaseCommit, added.json.planBaseCommit);

    const cancelHuman = await runCli(repo, ["cancel", "careful"]);
    assert.equal(cancelHuman.code, 0);
    for (const fragment of [
      "queue item careful: cancelled",
      "plan: careful",
      `plan path: ${plan.path}`,
      `plan sha256: ${plan.hash}`,
    ]) {
      assert.ok(
        cancelHuman.text.includes(fragment),
        `cancel output missing ${JSON.stringify(fragment)}:\n${cancelHuman.text}`,
      );
    }
  });
});

// ---------------------------------------------------------------------------
// Dispatch through the injected queue runner
// ---------------------------------------------------------------------------

test("queue run dispatches a Plan chain through the injected runner and reports lineage", async () => {
  await withRepo(async (repo) => {
    const rootBase = runGit(repo, ["rev-parse", "HEAD"]);
    const foundationPlan = writePlan(repo, "foundation");
    const upperPlan = writePlan(repo, "upper");
    await runCli(repo, [
      "add-plan",
      foundationPlan.path,
      "--id",
      "foundation",
      "--json",
    ]);
    await runCli(repo, [
      "add-plan",
      upperPlan.path,
      "--id",
      "upper",
      "--depends-on",
      "foundation",
      "--json",
    ]);

    let upstreamHead = "";
    const requests: QueueSupervisorRequest[] = [];
    const runner: QueueSupervisorRunner = async (request) => {
      requests.push(request);
      if (request.item.id === "foundation") {
        const materialization = materializationOf(request);
        assert.equal(materialization.baseCommit, rootBase);
        assert.equal(materialization.upstreamQueueId, undefined);
        upstreamHead = commitFile(
          repo,
          "foundation.txt",
          "export const foundation = true;\n",
          "accept foundation",
        );
        writeManifestForRequest(
          repo,
          request,
          "run-foundation",
          "completed",
          upstreamHead,
        );
        return { exitCode: 0, status: "completed", runId: "run-foundation" };
      }

      assert.equal(request.item.id, "upper");
      const materialization = materializationOf(request);
      assert.equal(materialization.baseCommit, upstreamHead);
      assert.equal(materialization.upstreamQueueId, "foundation");
      assert.equal(materialization.upstreamRunId, "run-foundation");
      assert.equal(
        materialization.upstreamIntegrationHead,
        upstreamHead,
      );
      writeManifestForRequest(
        repo,
        request,
        "run-upper",
        "completed",
        upstreamHead,
      );
      return { exitCode: 0, status: "completed", runId: "run-upper" };
    };

    const run = await runCli(repo, ["run"], runner);
    assert.equal(run.code, 0);
    assert.deepEqual(
      requests.map((request) => request.item.id),
      ["foundation", "upper"],
    );

    const foundationItem = itemById(repo, "foundation");
    const upperItem = itemById(repo, "upper");
    assert.equal(foundationItem.status, "completed");
    assert.equal(upperItem.status, "completed");
    assert.equal(foundationItem.planBaseCommit, rootBase);
    assert.equal(upperItem.planBaseCommit, undefined);
    const upperMaterialization = upperItem.materialization;
    assert.ok(upperMaterialization);
    assert.equal(upperMaterialization.baseCommit, upstreamHead);

    // Human run output identifies the Plan identity, base lineage, upstream
    // evidence and the generated contracts artifact.
    for (const fragment of [
      "dispatched: 2",
      "plan path:",
      `plan path: ${foundationPlan.path}`,
      `plan sha256: ${foundationPlan.hash}`,
      `plan path: ${upperPlan.path}`,
      `plan sha256: ${upperPlan.hash}`,
      `plan base: ${rootBase} (frozen initial base)`,
      `materialized base: ${upstreamHead}`,
      `upstream: queue foundation run run-foundation integration head ${upstreamHead}`,
      `contracts: ${upperMaterialization.contractsPath} (sha256 ${upperMaterialization.contractsHash})`,
      "queue: pending 0 / running 0 / completed 2",
    ]) {
      assert.ok(
        run.text.includes(fragment),
        `run output missing ${JSON.stringify(fragment)}:\n${run.text}`,
      );
    }

    // JSON exposes the persisted Plan and materialization fields. Completed
    // items mean a second run only reports state.
    const jsonRun = await runCli(
      repo,
      ["run", "--json"],
      async () => ({
        exitCode: 0,
        status: "completed" as const,
        runId: "must-not-run",
      }),
    );
    assert.equal(jsonRun.code, 0);
    assert.equal(jsonRun.json.dispatched, 0);
    const jsonUpper = jsonRun.json.items.find(
      (item: QueueItem) => item.id === "upper",
    );
    assert.ok(jsonUpper);
    assert.equal(jsonUpper.planId, "upper");
    assert.equal(jsonUpper.planPath, upperPlan.path);
    assert.equal(jsonUpper.planHash, upperPlan.hash);
    assert.equal(jsonUpper.materialization.baseCommit, upstreamHead);
    assert.equal(
      jsonUpper.materialization.upstreamQueueId,
      "foundation",
    );
    assert.equal(
      jsonUpper.materialization.upstreamRunId,
      "run-foundation",
    );
    assert.equal(
      jsonUpper.materialization.upstreamIntegrationHead,
      upstreamHead,
    );
    assert.equal(
      jsonUpper.materialization.contractsHash,
      upperMaterialization.contractsHash,
    );
  });
});

// ---------------------------------------------------------------------------
// Rejections
// ---------------------------------------------------------------------------

test("queue add-plan rejects unsafe, malformed, mismatched, unknown, cyclic and multi dependencies", async () => {
  await withRepo(async (repo) => {
    const goodPlan = writePlan(repo, "good");
    const secondPlan = writePlan(repo, "second");
    await runCli(repo, ["add-plan", goodPlan.path, "--id", "good", "--json"]);
    await runCli(repo, [
      "add-plan",
      secondPlan.path,
      "--id",
      "second",
      "--json",
    ]);

    await assert.rejects(
      runCli(repo, ["add-plan", goodPlan.path, "--id", "../escape"]),
      /invalid queue id/,
    );

    const malformedPath = join(repo, "malformed.plan.json");
    writeFileSync(malformedPath, "{not json\n", "utf8");
    await assert.rejects(
      runCli(repo, ["add-plan", malformedPath, "--id", "malformed"]),
      /cannot parse Plan/,
    );

    const invalidPath = join(repo, "invalid.plan.json");
    writeFileSync(
      invalidPath,
      JSON.stringify({ planId: "invalid", tasks: [] }),
      "utf8",
    );
    await assert.rejects(
      runCli(repo, ["add-plan", invalidPath, "--id", "invalid"]),
      /invalid Plan/,
    );

    const declaredPlan = writePlan(repo, "declared");
    await assert.rejects(
      runCli(repo, ["add-plan", declaredPlan.path, "--id", "mismatch"]),
      /Plan id mismatch/,
    );

    const orphanPlan = writePlan(repo, "orphan");
    await assert.rejects(
      runCli(repo, [
        "add-plan",
        orphanPlan.path,
        "--id",
        "orphan",
        "--depends-on",
        "missing",
      ]),
      /depends on unknown item "missing"/,
    );

    const multiPlan = writePlan(repo, "multi");
    await assert.rejects(
      runCli(repo, [
        "add-plan",
        multiPlan.path,
        "--id",
        "multi",
        "--depends-on",
        "good",
        "--depends-on",
        "second",
      ]),
      /supports at most one dependency/,
    );

    // No rejected mutation append a partial Plan item.
    assert.deepEqual(
      loadQueue(repo).items.map((item) => item.id),
      ["good", "second"],
    );

    // A cycle already present in the durable graph is refused before mutation.
    const contractsPath = join(repo, "cycle.contracts.json");
    writeFileSync(
      contractsPath,
      `${JSON.stringify({ planId: "cycle", contracts: [] }, null, 2)}\n`,
      "utf8",
    );
    addQueueItem(repo, { id: "cycle-a", contractsPath });
    addQueueItem(repo, {
      id: "cycle-b",
      contractsPath,
      dependsOn: ["cycle-a"],
    });
    const cyclic = loadQueue(repo);
    cyclic.items.find((item) => item.id === "cycle-a")!.dependsOn = [
      "cycle-b",
    ];
    writeFileSync(
      queuePaths(repo).queuePath,
      `${JSON.stringify(cyclic, null, 2)}\n`,
      "utf8",
    );

    const cycledPlan = writePlan(repo, "cycled");
    await assert.rejects(
      runCli(repo, ["add-plan", cycledPlan.path, "--id", "cycled"]),
      /dependency cycle/,
    );
  });
});

// ---------------------------------------------------------------------------
// Usage
// ---------------------------------------------------------------------------

test("queue and top-level usage document add-plan", async () => {
  const lines: string[] = [];
  const code = await runQueueCli(["--help"], {
    log: (line) => lines.push(line),
  });
  assert.equal(code, 0);
  const usage = lines.join("\n");
  assert.match(usage, /queue add-plan <plan\.json>/);
  assert.match(usage, /at most one queue dependency/);

  const topLevel = spawnSync(
    process.execPath,
    ["--import", "tsx", CLI_PATH, "--help"],
    { cwd: ROOT, encoding: "utf8" },
  );
  assert.equal(topLevel.status, 1, topLevel.stderr);
  assert.match(topLevel.stdout, /cliyard queue add-plan <plan\.json>/);
});

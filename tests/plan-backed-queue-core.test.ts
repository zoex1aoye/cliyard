import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  materializePlan,
  MATERIALIZED_QUEUE_DIR,
} from "../src/orchestration/plan-materializer.js";
import {
  runQueue,
  type QueueSupervisorRequest,
  type QueueSupervisorResult,
  type QueueSupervisorRunner,
} from "../src/orchestration/queue-runner.js";
import {
  addPlanQueueItem,
  addQueueItem,
  cancelQueueItem,
  hashFileSha256,
  isPlanBackedQueueItem,
  loadQueue,
  queueItemContractsIdentity,
  queuePaths,
  retryQueueItem,
  saveQueue,
  type QueueItem,
} from "../src/orchestration/queue-store.js";
import {
  createRunManifest,
  loadRunManifest,
  updateRunManifest,
} from "../src/supervisor/store.js";
import type { RunStatus } from "../src/supervisor/types.js";

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
  const repo = mkdtempSync(join(tmpdir(), "cliyard-plan-queue-"));
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
  readPaths?: string[];
  writePaths: string[];
  verifyCommands: string[];
}

interface PlanFixture {
  path: string;
  hash: string;
  text: string;
  document: { planId: string; tasks: PlanTask[] };
}

function planTasks(planId: string): PlanTask[] {
  return [
    {
      taskId: `${planId}-task`,
      goal: `Produce the ${planId} artifact`,
      writePaths: [`${planId}.txt`],
      verifyCommands: [`test -f ${planId}.txt`],
    },
  ];
}

function writePlan(
  repo: string,
  planId: string,
  tasks: PlanTask[] = planTasks(planId),
): PlanFixture {
  const document = { planId, tasks };
  const text = `${JSON.stringify(document, null, 2)}\n`;
  const path = join(repo, `${planId}.plan.json`);
  writeFileSync(path, text, "utf8");
  return { path, hash: sha256(text), text, document };
}

function writeContractsFile(
  repo: string,
  name = "legacy.contracts.json",
): { path: string; hash: string } {
  const text = `${JSON.stringify(
    { planId: "legacy-plan", contracts: [] },
    null,
    2,
  )}\n`;
  const path = join(repo, name);
  writeFileSync(path, text, "utf8");
  return { path, hash: sha256(text) };
}

function itemById(repo: string, id: string): QueueItem {
  const item = loadQueue(repo).items.find((candidate) => candidate.id === id);
  assert.ok(item, `queue item ${id} must exist`);
  return item;
}

function artifactDir(repo: string, id: string): string {
  return join(repo, MATERIALIZED_QUEUE_DIR, id);
}

// ---------------------------------------------------------------------------
// Injected Supervisor runner
// ---------------------------------------------------------------------------

interface RecordedCall {
  request: QueueSupervisorRequest;
  /** The queue item as persisted at the moment the runner was invoked. */
  persisted: QueueItem | undefined;
}

type RunnerBehavior = (
  request: QueueSupervisorRequest,
  index: number,
) => QueueSupervisorResult | Promise<QueueSupervisorResult>;

function recordingRunner(
  repo: string,
  behavior: RunnerBehavior,
): { calls: RecordedCall[]; runner: QueueSupervisorRunner } {
  const calls: RecordedCall[] = [];
  const runner: QueueSupervisorRunner = async (request) => {
    calls.push({
      request,
      persisted: loadQueue(repo).items.find(
        (item) => item.id === request.item.id,
      ),
    });
    return behavior(request, calls.length - 1);
  };
  return { calls, runner };
}

function materializationOf(request: QueueSupervisorRequest) {
  const materialization = request.item.materialization;
  assert.ok(
    materialization,
    `expected a plan materialization before dispatch of ${request.item.id}`,
  );
  return materialization;
}

interface ManifestOptions {
  runId: string;
  status: RunStatus;
  integrationHead?: string;
}

/**
 * Create the RunManifest a real Supervisor would leave for this request.
 * Identity fields are copied from the materialized contracts so reuse checks
 * can prove the manifest belongs to this exact attempt chain.
 */
function writeManifestForRequest(
  repo: string,
  request: QueueSupervisorRequest,
  options: ManifestOptions,
): string {
  const materialization = materializationOf(request);
  createRunManifest(repo, {
    runId: options.runId,
    planId: request.item.planId ?? request.item.id,
    contractsPath: materialization.contractsPath,
    contractsHash: materialization.contractsHash,
    baseCommit: materialization.baseCommit,
    integrationBranch: `cliyard/integration/${options.runId}`,
    ...(options.integrationHead !== undefined
      ? { integrationHead: options.integrationHead }
      : {}),
    tasks: [],
  });
  updateRunManifest(repo, options.runId, (manifest) => {
    manifest.status = options.status;
  });
  return options.runId;
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
  if (!item.runIds.includes(runId)) item.runIds.push(runId);
  item.attempts = attempts;
  item.nextAction = "resume";
  document.updatedAt = new Date().toISOString();
  saveQueue(repo, document);
}

function storeMaterialization(
  repo: string,
  id: string,
  materialization: NonNullable<QueueItem["materialization"]>,
): void {
  const document = loadQueue(repo);
  const item = document.items.find((candidate) => candidate.id === id);
  assert.ok(item, `queue item ${id} must exist`);
  item.materialization = materialization;
  document.updatedAt = new Date().toISOString();
  saveQueue(repo, document);
}

function addRootPlan(
  repo: string,
  id: string,
  tasks?: PlanTask[],
): { item: QueueItem; plan: PlanFixture } {
  const plan = writePlan(repo, id, tasks);
  const item = addPlanQueueItem(repo, { id, planPath: plan.path });
  return { item, plan };
}

function addDependentPlan(
  repo: string,
  id: string,
  dependsOn: string[],
  tasks?: PlanTask[],
): { item: QueueItem; plan: PlanFixture } {
  const plan = writePlan(repo, id, tasks);
  const item = addPlanQueueItem(repo, {
    id,
    planPath: plan.path,
    dependsOn,
  });
  return { item, plan };
}

// ---------------------------------------------------------------------------
// add-plan validation and snapshot
// ---------------------------------------------------------------------------

test("add-plan snapshots the approved Plan and rejects unsafe queue shape", async () => {
  await withRepo(async (repo) => {
    const base = runGit(repo, ["rev-parse", "HEAD"]);
    const rootPlan = writePlan(repo, "root");

    const root = addPlanQueueItem(repo, {
      id: "root",
      planPath: "root.plan.json",
      worker: "codex",
      model: "fixture-model",
      maxAttempts: 4,
    });

    assert.equal(root.id, "root");
    // Relative input is snapshotted as an absolute path.
    assert.equal(root.planPath, join(repo, "root.plan.json"));
    assert.equal(root.planHash, rootPlan.hash);
    assert.equal(root.planId, "root");
    assert.equal(root.planBaseCommit, base);
    assert.deepEqual(root.dependsOn, []);
    assert.equal(root.worker, "codex");
    assert.equal(root.model, "fixture-model");
    assert.equal(root.maxAttempts, 4);
    assert.equal(root.status, "pending");
    assert.equal(root.attempts, 0);
    assert.equal(root.nextAction, "start");
    assert.equal(root.materialization, undefined);
    assert.equal(root.contractsPath, undefined);
    assert.equal(root.contractsHash, undefined);
    assert.equal(isPlanBackedQueueItem(root), true);
    assert.equal(queueItemContractsIdentity(root), undefined);
    // add-plan never compiles artifacts or writes contracts.
    assert.equal(existsSync(join(repo, MATERIALIZED_QUEUE_DIR)), false);

    const raw = JSON.parse(
      readFileSync(queuePaths(repo).queuePath, "utf8"),
    ) as Record<string, any>;
    assert.equal(raw.version, 1);
    assert.equal(raw.items[0].source, undefined);
    assert.equal(raw.items[0].planPath, join(repo, "root.plan.json"));
    assert.equal(raw.items[0].planBaseCommit, base);
    assert.equal(raw.items[0].contractsPath, undefined);
    assert.equal(raw.items[0].contractsHash, undefined);

    // A pinned root base does not follow later repository movement.
    const movedHead = commitFile(repo, "later.txt", "later\n", "move HEAD");
    const laterPlan = writePlan(repo, "later");
    const later = addPlanQueueItem(repo, {
      id: "later",
      planPath: laterPlan.path,
    });
    assert.equal(later.planBaseCommit, movedHead);
    assert.equal(itemById(repo, "root").planBaseCommit, base);

    // A dependent item records no root base; its base comes from the run.
    const dependentPlan = writePlan(repo, "dependent");
    const dependent = addPlanQueueItem(repo, {
      id: "dependent",
      planPath: dependentPlan.path,
      dependsOn: ["root"],
    });
    assert.deepEqual(dependent.dependsOn, ["root"]);
    assert.equal(dependent.planBaseCommit, undefined);
    assert.equal(dependent.planId, "dependent");
    assert.equal(dependent.planHash, dependentPlan.hash);

    const queueBeforeRejections = loadQueue(repo);

    assert.throws(
      () => addPlanQueueItem(repo, { id: "root", planPath: rootPlan.path }),
      /duplicate queue id/,
    );
    assert.throws(
      () =>
        addPlanQueueItem(repo, {
          id: "../escape",
          planPath: rootPlan.path,
        }),
      /invalid queue id/,
    );
    assert.throws(
      () =>
        addPlanQueueItem(repo, {
          id: "missing-plan",
          planPath: join(repo, "missing.plan.json"),
        }),
      /Plan file is missing or unreadable/,
    );

    const malformedPath = join(repo, "malformed.plan.json");
    writeFileSync(malformedPath, "{not json\n", "utf8");
    assert.throws(
      () => addPlanQueueItem(repo, { id: "malformed", planPath: malformedPath }),
      /cannot parse Plan/,
    );

    const invalidPath = join(repo, "invalid.plan.json");
    writeFileSync(
      invalidPath,
      JSON.stringify({ planId: "invalid", tasks: [] }),
      "utf8",
    );
    assert.throws(
      () => addPlanQueueItem(repo, { id: "invalid", planPath: invalidPath }),
      /invalid Plan/,
    );

    const mismatchPlan = writePlan(repo, "declared-other");
    assert.throws(
      () =>
        addPlanQueueItem(repo, {
          id: "mismatch",
          planPath: mismatchPlan.path,
        }),
      /Plan id mismatch/,
    );

    const orphanPlan = writePlan(repo, "orphan");
    assert.throws(
      () =>
        addPlanQueueItem(repo, {
          id: "orphan",
          planPath: orphanPlan.path,
          dependsOn: ["unknown-item"],
        }),
      /depends on unknown item "unknown-item"/,
    );

    const multiPlan = writePlan(repo, "multi");
    assert.throws(
      () =>
        addPlanQueueItem(repo, {
          id: "multi",
          planPath: multiPlan.path,
          dependsOn: ["root", "later"],
        }),
      /supports at most one dependency/,
    );

    // Failed validations never append a partial item.
    assert.deepEqual(loadQueue(repo), queueBeforeRejections);
    assert.equal(existsSync(join(repo, MATERIALIZED_QUEUE_DIR)), false);

    // A cycle already present in the graph is refused before mutation.
    const contracts = writeContractsFile(repo);
    addQueueItem(repo, { id: "cycle-a", contractsPath: contracts.path });
    addQueueItem(repo, {
      id: "cycle-b",
      contractsPath: contracts.path,
      dependsOn: ["cycle-a"],
    });
    const cyclic = loadQueue(repo);
    cyclic.items.find((item) => item.id === "cycle-a")!.dependsOn = ["cycle-b"];
    writeFileSync(
      queuePaths(repo).queuePath,
      `${JSON.stringify(cyclic, null, 2)}\n`,
      "utf8",
    );
    const cycledPlan = writePlan(repo, "cycled");
    assert.throws(
      () =>
        addPlanQueueItem(repo, {
          id: "cycled",
          planPath: cycledPlan.path,
        }),
      /dependency cycle/,
    );
  });
});

// ---------------------------------------------------------------------------
// Legacy contract-backed queue format
// ---------------------------------------------------------------------------

test("legacy queue version 1 and contract-backed item parsing stay unchanged", async () => {
  await withRepo(async (repo) => {
    const contracts = writeContractsFile(repo);
    const at = "2026-01-02T03:04:05.000Z";
    const legacyItem = {
      id: "legacy",
      contractsPath: contracts.path,
      contractsHash: contracts.hash,
      planId: "legacy-plan",
      worker: "codex",
      model: "fixture-model",
      dependsOn: [],
      status: "pending",
      attempts: 0,
      maxAttempts: 2,
      runIds: [],
      nextAction: "start",
      createdAt: at,
      updatedAt: at,
    };
    mkdirSync(dirname(queuePaths(repo).queuePath), { recursive: true });
    writeFileSync(
      queuePaths(repo).queuePath,
      `${JSON.stringify(
        { version: 1, updatedAt: at, items: [legacyItem] },
        null,
        2,
      )}\n`,
      "utf8",
    );

    const document = loadQueue(repo);
    assert.deepEqual(document, {
      version: 1,
      updatedAt: at,
      items: [legacyItem],
    });
    const item = document.items[0]!;
    assert.equal(isPlanBackedQueueItem(item), false);
    assert.deepEqual(queueItemContractsIdentity(item), {
      contractsPath: contracts.path,
      contractsHash: contracts.hash,
    });
    assert.equal(item.planId, "legacy-plan");

    // Saving keeps the v1 document shape and adds no Plan-only fields.
    saveQueue(repo, document);
    const raw = JSON.parse(
      readFileSync(queuePaths(repo).queuePath, "utf8"),
    ) as Record<string, any>;
    assert.deepEqual(Object.keys(raw).sort(), ["items", "updatedAt", "version"]);
    assert.equal(raw.version, 1);
    assert.deepEqual(Object.keys(raw.items[0]).sort(), [
      "attempts",
      "contractsHash",
      "contractsPath",
      "createdAt",
      "dependsOn",
      "id",
      "maxAttempts",
      "model",
      "nextAction",
      "planId",
      "runIds",
      "status",
      "updatedAt",
      "worker",
    ]);
    for (const field of [
      "planPath",
      "planHash",
      "planBaseCommit",
      "materialization",
      "source",
    ]) {
      assert.equal(
        Object.hasOwn(raw.items[0], field),
        false,
        `legacy item must not gain ${field}`,
      );
    }

    // Plan-only fields without planPath are still refused on save/load.
    const tampered = loadQueue(repo);
    (tampered.items[0] as unknown as Record<string, unknown>).planHash =
      sha256("plan");
    assert.throws(
      () => saveQueue(repo, tampered),
      /planHash requires planPath/,
    );

    writeFileSync(
      queuePaths(repo).queuePath,
      `${JSON.stringify(
        { version: 2, updatedAt: at, items: [legacyItem] },
        null,
        2,
      )}\n`,
      "utf8",
    );
    assert.throws(() => loadQueue(repo), /unsupported queue version/);
  });
});

// ---------------------------------------------------------------------------
// Materialize before attempt / injected-runner dispatch
// ---------------------------------------------------------------------------

test("plan dispatch materializes and persists before the attempt increments", async () => {
  await withRepo(async (repo) => {
    const { item: added, plan } = addRootPlan(repo, "materialized");
    assert.equal(added.planBaseCommit, runGit(repo, ["rev-parse", "HEAD"]));

    const logs: string[] = [];
    const recorded = recordingRunner(repo, (request) => {
      const runId = writeManifestForRequest(repo, request, {
        runId: "run-materialized",
        status: "completed",
      });
      return { exitCode: 0, status: "completed", runId };
    });

    const summary = await runQueue(repo, {
      runner: recorded.runner,
      log: (line) => logs.push(line),
    });

    assert.equal(recorded.calls.length, 1);
    const call = recorded.calls[0]!;
    assert.equal(call.request.action, "start");
    assert.equal(call.request.runId, undefined);

    // The request snapshot carries the generated contracts identity.
    const snapshot = materializationOf(call.request);
    assert.equal(snapshot.planId, "materialized");
    assert.equal(snapshot.planHash, plan.hash);
    assert.equal(snapshot.contractsHash, snapshot.contractsHash.toLowerCase());
    assert.match(snapshot.contractsPath, /\.contracts\.json$/);
    assert.equal(call.request.item.contractsPath, undefined);

    // Materialization, `running` and the attempt are durable before dispatch.
    assert.ok(call.persisted, "the queue must be readable during dispatch");
    assert.equal(call.persisted.status, "running");
    assert.equal(call.persisted.attempts, 1);
    assert.deepEqual(call.persisted.materialization, snapshot);

    const item = itemById(repo, "materialized");
    assert.equal(item.status, "completed");
    assert.equal(item.attempts, 1);
    assert.equal(item.lastRunId, "run-materialized");
    assert.deepEqual(item.materialization, snapshot);
    assert.equal(item.contractsPath, undefined);
    assert.equal(item.contractsHash, undefined);
    assert.deepEqual(queueItemContractsIdentity(item), {
      contractsPath: snapshot.contractsPath,
      contractsHash: snapshot.contractsHash,
    });

    assert.equal(snapshot.planPath, plan.path);
    assert.equal(snapshot.planHash, plan.hash);
    assert.equal(snapshot.baseCommit, added.planBaseCommit);
    assert.equal(snapshot.upstreamQueueId, undefined);
    assert.equal(snapshot.upstreamRunId, undefined);
    assert.equal(snapshot.upstreamIntegrationHead, undefined);
    assert.equal(
      snapshot.contractsPath,
      join(
        repo,
        MATERIALIZED_QUEUE_DIR,
        "materialized",
        `${added.planBaseCommit}-${plan.hash}.contracts.json`,
      ),
    );
    assert.equal(
      hashFileSha256(snapshot.contractsPath),
      snapshot.contractsHash,
    );

    const line = logs.join("\n");
    assert.match(line, /materialized materialized: plan materialized sha256/);
    assert.match(line, new RegExp(`base ${added.planBaseCommit}`));
    assert.match(
      line,
      /contracts .*\.contracts\.json \(sha256 [0-9a-f]{64}\)/,
    );
    assert.match(line, /dispatch materialized: start plan materialized sha256/);
    assert.equal(summary.dispatched, 1);
    assert.equal(summary.counts.completed, 1);
  });
});

// ---------------------------------------------------------------------------
// Fail-closed materialization
// ---------------------------------------------------------------------------

test("a changed approved Plan fails closed before dispatch with attempts 0", async () => {
  await withRepo(async (repo) => {
    const { plan } = addRootPlan(repo, "changed-plan");
    writeFileSync(plan.path, `${plan.text}\n`, "utf8");

    const recorded = recordingRunner(repo, () => ({
      exitCode: 0,
      status: "completed",
      runId: "must-not-run",
    }));
    const summary = await runQueue(repo, { runner: recorded.runner });

    assert.equal(recorded.calls.length, 0);
    assert.equal(summary.dispatched, 0);
    const item = itemById(repo, "changed-plan");
    assert.equal(item.status, "blocked");
    assert.equal(item.attempts, 0);
    assert.equal(item.materialization, undefined);
    assert.match(item.reason!, /Plan hash mismatch/);
    assert.equal(existsSync(artifactDir(repo, "changed-plan")), false);
  });
});

test("a changed or missing recorded artifact fails closed with attempts 0", async () => {
  await withRepo(async (repo) => {
    const { item: added, plan } = addRootPlan(repo, "artifact-plan");
    const materialization = materializePlan({
      repoRoot: repo,
      queueId: added.id,
      planPath: plan.path,
      planHash: plan.hash,
      planId: plan.document.planId,
      rootBaseCommit: added.planBaseCommit!,
      materializedAt: new Date().toISOString(),
    });
    storeMaterialization(repo, added.id, materialization);

    const tampered = Buffer.concat([
      readFileSync(materialization.contractsPath),
      Buffer.from("\n", "utf8"),
    ]);
    writeFileSync(materialization.contractsPath, tampered);

    const recorded = recordingRunner(repo, () => ({
      exitCode: 0,
      status: "completed",
      runId: "must-not-run",
    }));
    await runQueue(repo, { runner: recorded.runner });

    assert.equal(recorded.calls.length, 0);
    const item = itemById(repo, "artifact-plan");
    assert.equal(item.status, "blocked");
    assert.equal(item.attempts, 0);
    assert.match(item.reason!, /materialized contracts artifact changed/);
    assert.deepEqual(readFileSync(materialization.contractsPath), tampered);
  });

  await withRepo(async (repo) => {
    const { item: added, plan } = addRootPlan(repo, "missing-artifact");
    const materialization = materializePlan({
      repoRoot: repo,
      queueId: added.id,
      planPath: plan.path,
      planHash: plan.hash,
      planId: plan.document.planId,
      rootBaseCommit: added.planBaseCommit!,
      materializedAt: new Date().toISOString(),
    });
    storeMaterialization(repo, added.id, materialization);
    unlinkSync(materialization.contractsPath);

    const recorded = recordingRunner(repo, () => ({
      exitCode: 0,
      status: "completed",
      runId: "must-not-run",
    }));
    await runQueue(repo, { runner: recorded.runner });

    assert.equal(recorded.calls.length, 0);
    const item = itemById(repo, "missing-artifact");
    assert.equal(item.status, "blocked");
    assert.equal(item.attempts, 0);
    assert.match(
      item.reason!,
      /materialized contracts artifact is missing or unreadable/,
    );
  });
});

// ---------------------------------------------------------------------------
// Dependent lineage
// ---------------------------------------------------------------------------

test("a dependent Plan materializes at the completed upstream integrationHead", async () => {
  await withRepo(async (repo) => {
    const rootBase = runGit(repo, ["rev-parse", "HEAD"]);
    const foundation = addRootPlan(repo, "foundation");
    const upper = addDependentPlan(repo, "upper", ["foundation"]);

    let upstreamHead = "";
    const recorded = recordingRunner(repo, (request) => {
      if (request.item.id === "foundation") {
        const snapshot = materializationOf(request);
        assert.equal(snapshot.baseCommit, rootBase);
        upstreamHead = commitFile(
          repo,
          "foundation.txt",
          "export const foundation = true;\n",
          "accept foundation",
        );
        const runId = writeManifestForRequest(repo, request, {
          runId: "run-foundation",
          status: "completed",
          integrationHead: upstreamHead,
        });
        return { exitCode: 0, status: "completed", runId };
      }
      assert.equal(request.item.id, "upper");
      return {
        exitCode: 0,
        status: "completed",
        runId: "run-upper",
      };
    });

    const summary = await runQueue(repo, { runner: recorded.runner });

    assert.deepEqual(
      recorded.calls.map((call) => call.request.item.id),
      ["foundation", "upper"],
    );
    assert.equal(summary.dispatched, 2);

    const foundationItem = itemById(repo, "foundation");
    assert.equal(foundationItem.status, "completed");
    assert.equal(foundationItem.planBaseCommit, rootBase);

    const upperItem = itemById(repo, "upper");
    assert.equal(upperItem.status, "completed");
    assert.equal(upperItem.planBaseCommit, undefined);
    const materialization = upperItem.materialization;
    assert.ok(materialization);
    assert.equal(materialization.baseCommit, upstreamHead);
    assert.notEqual(materialization.baseCommit, rootBase);
    assert.equal(materialization.upstreamQueueId, "foundation");
    assert.equal(materialization.upstreamRunId, "run-foundation");
    assert.equal(materialization.upstreamIntegrationHead, upstreamHead);
    assert.equal(materialization.planHash, upper.plan.hash);

    // The dependent contracts were compiled at that exact base.
    const artifact = JSON.parse(
      readFileSync(materialization.contractsPath, "utf8"),
    ) as Record<string, any>;
    assert.ok(
      artifact.contracts.every(
        (contract: { baseCommit: string }) =>
          contract.baseCommit === upstreamHead,
      ),
    );
    assert.equal(artifact.provenance.upstreamQueueId, "foundation");
    assert.equal(artifact.provenance.upstreamRunId, "run-foundation");
    assert.equal(
      artifact.provenance.upstreamIntegrationHead,
      upstreamHead,
    );

    // The runner observed the generated identity on the dependent dispatch.
    const upperCall = recorded.calls[1]!;
    assert.equal(upperCall.persisted?.status, "running");
    assert.equal(upperCall.persisted?.attempts, 1);
    assert.deepEqual(upperCall.request.item.materialization, materialization);

    const foundationManifest = loadRunManifest(
      repo,
      foundationItem.lastRunId!,
    );
    assert.equal(foundationManifest.status, "completed");
    assert.equal(foundationManifest.integrationHead, upstreamHead);
    assert.equal(
      foundationManifest.contractsHash,
      foundationItem.materialization!.contractsHash,
    );
    assert.equal(upper.baseCommit, undefined);
  });
});

// ---------------------------------------------------------------------------
// Upstream availability
// ---------------------------------------------------------------------------

test("blocked, cancelled and missing upstreams never dispatch the dependent", async () => {
  await withRepo(async (repo) => {
    addRootPlan(repo, "blocked-foundation");
    addDependentPlan(repo, "blocked-upper", ["blocked-foundation"]);

    const recorded = recordingRunner(repo, (request) => {
      writeManifestForRequest(repo, request, {
        runId: "run-blocked-foundation",
        status: "blocked",
      });
      return {
        exitCode: 1,
        status: "blocked",
        runId: "run-blocked-foundation",
        reason: "upstream verification failed",
      };
    });
    const summary = await runQueue(repo, {
      runner: recorded.runner,
      continueOnBlocked: true,
    });

    assert.deepEqual(
      recorded.calls.map((call) => call.request.item.id),
      ["blocked-foundation"],
    );
    const dependent = itemById(repo, "blocked-upper");
    assert.equal(dependent.status, "blocked");
    assert.equal(dependent.attempts, 0);
    assert.equal(dependent.materialization, undefined);
    assert.match(
      dependent.reason!,
      /dependency "blocked-foundation" is blocked/,
    );
    assert.equal(existsSync(artifactDir(repo, "blocked-upper")), false);
    assert.deepEqual(
      summary.propagated.map((record) => record.id),
      ["blocked-upper"],
    );
  });

  await withRepo(async (repo) => {
    addRootPlan(repo, "cancelled-foundation");
    addDependentPlan(repo, "cancelled-upper", ["cancelled-foundation"]);
    cancelQueueItem(repo, "cancelled-foundation");

    const recorded = recordingRunner(repo, () => ({
      exitCode: 0,
      status: "completed",
      runId: "must-not-run",
    }));
    await runQueue(repo, {
      runner: recorded.runner,
      continueOnBlocked: true,
    });

    assert.equal(recorded.calls.length, 0);
    const dependent = itemById(repo, "cancelled-upper");
    assert.equal(dependent.status, "blocked");
    assert.equal(dependent.attempts, 0);
    assert.equal(dependent.materialization, undefined);
    assert.match(
      dependent.reason!,
      /dependency "cancelled-foundation" is cancelled/,
    );
    assert.equal(existsSync(artifactDir(repo, "cancelled-upper")), false);
  });

  await withRepo(async (repo) => {
    addRootPlan(repo, "missing-foundation");
    addDependentPlan(repo, "missing-upper", ["missing-foundation"]);

    const recorded = recordingRunner(repo, () => ({
      exitCode: 0,
      status: "completed",
      runId: "run-missing-foundation",
    }));
    await runQueue(repo, { runner: recorded.runner });

    assert.deepEqual(
      recorded.calls.map((call) => call.request.item.id),
      ["missing-foundation"],
    );
    const root = itemById(repo, "missing-foundation");
    assert.equal(root.status, "completed");
    assert.equal(root.lastRunId, "run-missing-foundation");

    const dependent = itemById(repo, "missing-upper");
    assert.equal(dependent.status, "blocked");
    assert.equal(dependent.attempts, 0);
    assert.equal(dependent.materialization, undefined);
    assert.match(
      dependent.reason!,
      /cannot load upstream RunManifest "run-missing-foundation"/,
    );
    assert.equal(existsSync(artifactDir(repo, "missing-upper")), false);
  });
});

// ---------------------------------------------------------------------------
// Retry identity
// ---------------------------------------------------------------------------

test("a recorded materialization is byte-identical across retry and rejects a changed Plan", async () => {
  await withRepo(async (repo) => {
    const { plan } = addRootPlan(repo, "resumable");

    const first = recordingRunner(repo, (request) => {
      const runId = writeManifestForRequest(repo, request, {
        runId: "run-resumable",
        status: "interrupted",
      });
      return { exitCode: 1, status: "interrupted", runId };
    });
    await runQueue(repo, { runner: first.runner });

    let item = itemById(repo, "resumable");
    assert.equal(item.status, "blocked");
    assert.equal(item.attempts, 1);
    assert.equal(item.lastRunId, "run-resumable");
    assert.equal(item.nextAction, "resume");
    const recordedMaterialization = { ...item.materialization! };
    const artifactBytes = readFileSync(recordedMaterialization.contractsPath);
    const artifactInode = statSync(recordedMaterialization.contractsPath).ino;

    retryQueueItem(repo, "resumable");
    assert.equal(itemById(repo, "resumable").nextAction, "resume");

    // A changed Plan cannot be substituted into the resumable run.
    const originalText = readFileSync(plan.path, "utf8");
    writeFileSync(plan.path, `${originalText}\n`, "utf8");
    const rejected = recordingRunner(repo, () => ({
      exitCode: 0,
      status: "completed",
      runId: "must-not-run",
    }));
    await runQueue(repo, { runner: rejected.runner });

    assert.equal(rejected.calls.length, 0);
    item = itemById(repo, "resumable");
    assert.equal(item.status, "blocked");
    assert.equal(item.attempts, 1, "a failed verification never increments");
    assert.deepEqual(item.materialization, recordedMaterialization);
    assert.match(item.reason!, /Plan hash mismatch/);
    assert.deepEqual(
      readFileSync(recordedMaterialization.contractsPath),
      artifactBytes,
    );

    // Restoring the Plan resumes the exact recorded run and bytes.
    writeFileSync(plan.path, originalText, "utf8");
    retryQueueItem(repo, "resumable");
    const resumed = recordingRunner(repo, (request) => {
      assert.equal(request.action, "resume");
      assert.equal(request.runId, "run-resumable");
      updateRunManifest(repo, "run-resumable", (manifest) => {
        manifest.status = "completed";
      });
      return { exitCode: 0, status: "completed", runId: "run-resumable" };
    });
    const logs: string[] = [];
    await runQueue(repo, {
      runner: resumed.runner,
      log: (line) => logs.push(line),
    });

    assert.equal(resumed.calls.length, 1);
    assert.deepEqual(
      resumed.calls[0]!.request.item.materialization,
      recordedMaterialization,
    );
    assert.equal(resumed.calls[0]!.persisted?.attempts, 2);
    item = itemById(repo, "resumable");
    assert.equal(item.status, "completed");
    assert.equal(item.attempts, 2);
    assert.deepEqual(item.materialization, recordedMaterialization);
    assert.equal(
      item.materialization!.materializedAt,
      recordedMaterialization.materializedAt,
      "reuse must not rematerialize under a resumable run",
    );
    assert.deepEqual(
      readFileSync(recordedMaterialization.contractsPath),
      artifactBytes,
    );
    assert.equal(
      statSync(recordedMaterialization.contractsPath).ino,
      artifactInode,
      "the recorded artifact must not be rewritten",
    );
    assert.match(logs.join("\n"), /reused materialization resumable:/);
  });
});

// ---------------------------------------------------------------------------
// Stale running reconciliation
// ---------------------------------------------------------------------------

test("stale running Plan items reconcile against the recorded materialization", async () => {
  await withRepo(async (repo) => {
    addRootPlan(repo, "stale");

    const first = recordingRunner(repo, (request) => {
      const runId = writeManifestForRequest(repo, request, {
        runId: "run-stale",
        status: "interrupted",
      });
      return { exitCode: 1, status: "interrupted", runId };
    });
    await runQueue(repo, { runner: first.runner });

    const recorded = itemById(repo, "stale");
    assert.ok(recorded.materialization);
    markRunning(repo, "stale", "run-stale", 1);
    updateRunManifest(repo, "run-stale", (manifest) => {
      manifest.status = "completed";
    });

    const idle = recordingRunner(repo, () => ({
      exitCode: 0,
      status: "completed",
      runId: "must-not-run",
    }));
    const summary = await runQueue(repo, { runner: idle.runner });

    assert.equal(idle.calls.length, 0);
    assert.deepEqual(summary.reconciled, [
      {
        id: "stale",
        from: "running",
        to: "completed",
        runId: "run-stale",
      },
    ]);
    const item = itemById(repo, "stale");
    assert.equal(item.status, "completed");
    assert.equal(item.attempts, 1);
    assert.deepEqual(item.materialization, recorded.materialization);
  });

  await withRepo(async (repo) => {
    addRootPlan(repo, "stale-tampered");
    const first = recordingRunner(repo, (request) => {
      const runId = writeManifestForRequest(repo, request, {
        runId: "run-stale-tampered",
        status: "interrupted",
      });
      return { exitCode: 1, status: "interrupted", runId };
    });
    await runQueue(repo, { runner: first.runner });

    const recorded = itemById(repo, "stale-tampered");
    assert.ok(recorded.materialization);
    markRunning(repo, "stale-tampered", "run-stale-tampered", 1);
    updateRunManifest(repo, "run-stale-tampered", (manifest) => {
      manifest.status = "completed";
    });
    writeFileSync(
      recorded.materialization.contractsPath,
      `${readFileSync(recorded.materialization.contractsPath, "utf8")}\n`,
      "utf8",
    );

    const idle = recordingRunner(repo, () => ({
      exitCode: 0,
      status: "completed",
      runId: "must-not-run",
    }));
    const summary = await runQueue(repo, { runner: idle.runner });

    assert.equal(idle.calls.length, 0);
    assert.equal(summary.reconciled[0]?.to, "blocked");
    assert.match(
      summary.reconciled[0]?.reason ?? "",
      /materialized contracts artifact changed/,
    );
    const item = itemById(repo, "stale-tampered");
    assert.equal(item.status, "blocked");
    assert.equal(item.attempts, 1);
    assert.match(item.reason!, /materialized contracts artifact changed/);
  });

  await withRepo(async (repo) => {
    const { item: added } = addRootPlan(repo, "stale-bare");
    const contracts = writeContractsFile(repo);
    createRunManifest(repo, {
      runId: "run-stale-bare",
      planId: "stale-bare",
      contractsPath: contracts.path,
      contractsHash: contracts.hash,
      baseCommit: added.planBaseCommit!,
      integrationBranch: "cliyard/integration/run-stale-bare",
      tasks: [],
    });
    updateRunManifest(repo, "run-stale-bare", (manifest) => {
      manifest.status = "completed";
    });
    markRunning(repo, "stale-bare", "run-stale-bare", 1);

    const idle = recordingRunner(repo, () => ({
      exitCode: 0,
      status: "completed",
      runId: "must-not-run",
    }));
    const summary = await runQueue(repo, { runner: idle.runner });

    assert.equal(idle.calls.length, 0);
    assert.equal(summary.reconciled[0]?.to, "blocked");
    const item = itemById(repo, "stale-bare");
    assert.equal(item.status, "blocked");
    assert.equal(item.attempts, 1);
    assert.match(item.reason!, /plan materialization is not recorded/);
  });
});

// ---------------------------------------------------------------------------
// Real chain through the existing Supervisor CLI
// ---------------------------------------------------------------------------

test(
  "a real local plan chain runs through the Supervisor with upstream ancestry",
  { timeout: 120_000 },
  async () => {
    const repo = initRepo();
    try {
      const foundationPlan = writePlan(repo, "foundation", [
        {
          taskId: "foundation",
          goal: "Create the foundation artifact",
          writePaths: ["foundation.txt"],
          verifyCommands: ["test -f foundation.txt"],
        },
      ]);
      const upperPlan = writePlan(repo, "upper", [
        {
          taskId: "upper",
          goal: "Create the upper layer artifact",
          readPaths: ["foundation.txt"],
          writePaths: ["upper.txt"],
          verifyCommands: [
            "test -f foundation.txt",
            "test -f upper.txt",
          ],
        },
      ]);
      addPlanQueueItem(repo, {
        id: "foundation",
        planPath: foundationPlan.path,
      });
      addPlanQueueItem(repo, {
        id: "upper",
        planPath: upperPlan.path,
        dependsOn: ["foundation"],
      });

      const fakeClaude = join(repo, "fake-claude.cjs");
      writeFileSync(
        fakeClaude,
        String.raw`#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");

if (process.argv.includes("--version")) {
  console.log("fixture-claude 1.0");
  process.exit(0);
}

const promptIndex = process.argv.indexOf("-p");
const prompt = promptIndex >= 0 ? process.argv[promptIndex + 1] : "";
const taskId = (prompt.match(/Task:\s*(\S+)/) || [])[1];
const writePath = (prompt.match(/Write only under:\n- ([^\n]+)/) || [])[1];
const readFirst = (prompt.match(/Read first:\n([\s\S]*?)\n\n/) || [])[1] || "";
if (!taskId || !writePath) {
  console.error("fixture could not parse task prompt");
  process.exit(2);
}

if (taskId === "upper" && !/^- foundation\.txt$/m.test(readFirst)) {
  console.error("fixture: downstream task did not declare foundation.txt in readPaths");
  process.exit(4);
}

const foundation = path.resolve(process.cwd(), "foundation.txt");
if (taskId === "upper" && !fs.existsSync(foundation)) {
  console.error("fixture: upstream foundation.txt is missing from the worktree");
  process.exit(3);
}

const target = path.resolve(process.cwd(), writePath);
fs.mkdirSync(path.dirname(target), { recursive: true });
let content = "export const task = '" + taskId + "';\n";
if (taskId === "upper") {
  content += "export const upstream = " +
    JSON.stringify(fs.readFileSync(foundation, "utf8").trim()) + ";\n";
}
fs.writeFileSync(target, content);
console.log(JSON.stringify({
  type: "result",
  subtype: "success",
  is_error: false,
  result: "fixture completed " + taskId,
  session_id: "fixture-" + taskId,
  total_cost_usd: 0,
  usage: { input_tokens: 0, output_tokens: 0 },
  modelUsage: {}
}));
`,
        "utf8",
      );
      chmodSync(fakeClaude, 0o755);

      const previousBinary = process.env.CLIYARD_CLAUDE_BINARY;
      process.env.CLIYARD_CLAUDE_BINARY = fakeClaude;
      const logs: string[] = [];
      try {
        await runQueue(repo, { log: (line) => logs.push(line) });
      } finally {
        if (previousBinary === undefined) {
          delete process.env.CLIYARD_CLAUDE_BINARY;
        } else {
          process.env.CLIYARD_CLAUDE_BINARY = previousBinary;
        }
      }

      const foundationItem = itemById(repo, "foundation");
      const upperItem = itemById(repo, "upper");
      assert.equal(foundationItem.status, "completed");
      assert.equal(upperItem.status, "completed");
      assert.equal(foundationItem.attempts, 1);
      assert.equal(upperItem.attempts, 1);

      const foundationManifest = loadRunManifest(
        repo,
        foundationItem.lastRunId!,
      );
      const upperManifest = loadRunManifest(repo, upperItem.lastRunId!);
      assert.equal(foundationManifest.status, "completed");
      assert.equal(upperManifest.status, "completed");
      assert.equal(upperManifest.planId, "upper");

      // The dependent run starts exactly at the upstream integration head.
      assert.equal(
        upperItem.materialization!.baseCommit,
        foundationManifest.integrationHead,
      );
      assert.equal(
        upperItem.materialization!.upstreamIntegrationHead,
        foundationManifest.integrationHead,
      );
      assert.equal(
        upperItem.materialization!.upstreamRunId,
        foundationManifest.runId,
      );
      assert.equal(
        upperManifest.baseCommit,
        foundationManifest.integrationHead,
      );

      // The downstream contract explicitly declares the upstream artifact as
      // read context; preflight proves it at the pinned base.
      const upperArtifact = JSON.parse(
        readFileSync(upperItem.materialization!.contractsPath, "utf8"),
      ) as { contracts: Array<{ taskId: string; readPaths: string[] }> };
      const upperTask = upperArtifact.contracts.find(
        (contract) => contract.taskId === "upper",
      );
      assert.ok(upperTask, "the materialized downstream contract must exist");
      assert.deepEqual(upperTask.readPaths, ["foundation.txt"]);

      const ancestry = spawnSync(
        "git",
        [
          "merge-base",
          "--is-ancestor",
          foundationManifest.integrationHead,
          upperManifest.integrationHead,
        ],
        { cwd: repo, encoding: "utf8" },
      );
      assert.equal(
        ancestry.status,
        0,
        `upstream integrationHead must be an ancestor of downstream: ` +
          `${ancestry.stderr}`,
      );

      // The downstream worktree saw the upstream accepted file: the fake
      // worker copied it into upper.txt, and both files are in the final
      // dependent integration branch.
      assert.match(
        runGit(repo, [
          "show",
          `${upperManifest.integrationBranch}:foundation.txt`,
        ]),
        /export const task = 'foundation'/,
      );
      assert.match(
        runGit(repo, [
          "show",
          `${upperManifest.integrationBranch}:upper.txt`,
        ]),
        /export const upstream = "export const task = 'foundation';"/,
      );

      const line = logs.join("\n");
      assert.match(line, /materialized foundation: plan foundation sha256/);
      assert.match(line, /materialized upper: plan upper sha256/);
      assert.match(
        line,
        new RegExp(
          `base ${foundationManifest.integrationHead} upstream foundation#${foundationManifest.runId}`,
        ),
      );
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  },
);

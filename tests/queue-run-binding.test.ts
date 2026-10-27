import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import type { TaskContract } from "../src/contracts/schema.js";
import {
  createQueueSupervisorRunner,
  runQueue,
  type QueueSupervisorRequest,
  type QueueSupervisorRunner,
} from "../src/orchestration/queue-runner.js";
import {
  addQueueItem,
  loadQueue,
  retryQueueItem,
  saveQueue,
  type QueueItem,
} from "../src/orchestration/queue-store.js";
import { runSupervisorCli } from "../src/supervisor/cli.js";
import {
  createRunManifest,
  getActiveRunId,
  loadRunManifest,
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
  const repo = mkdtempSync(join(tmpdir(), "cliyard-queue-binding-"));
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

function contract(baseCommit: string): TaskContract {
  return {
    taskId: "task",
    version: 1,
    frozen: true,
    goals: ["Create the fixture output"],
    dependsOn: [],
    readPaths: ["."],
    writePaths: ["task.txt"],
    sharedResources: [],
    baseCommit,
    verifyCommands: ["test -f task.txt"],
    maxRepairs: 0,
  };
}

function writeContracts(repo: string): string {
  const baseCommit = runGit(repo, ["rev-parse", "HEAD"]);
  const path = join(repo, "contracts.json");
  writeFileSync(
    path,
    JSON.stringify({ contracts: [contract(baseCommit)] }, null, 2) + "\n",
    "utf8",
  );
  return path;
}

function createManifest(
  repo: string,
  contractsPath: string,
  runId: string,
  options: {
    completed?: boolean;
    ownerPid?: number;
  } = {},
): void {
  const baseCommit = runGit(repo, ["rev-parse", "HEAD"]);
  createRunManifest(repo, {
    runId,
    planId: `plan-${runId}`,
    contractsPath,
    baseCommit,
    integrationBranch: `cliyard/integration/${runId}`,
    tasks: ["task"],
    ...(options.ownerPid !== undefined
      ? { owner: { pid: options.ownerPid, host: hostname() } }
      : {}),
  });
  if (options.completed) completeManifest(repo, runId);
}

function completeManifest(repo: string, runId: string): void {
  updateRunManifest(repo, runId, (manifest) => {
    manifest.status = "completed";
    const task = manifest.tasks["task"]!;
    task.status = "accepted";
    task.accepted = true;
  });
}

function itemById(repo: string, id: string): QueueItem {
  const item = loadQueue(repo).items.find((candidate) => candidate.id === id);
  assert.ok(item, `queue item ${id} must exist`);
  return item;
}

function exitedPid(): number {
  const result = spawnSync(process.execPath, ["-e", "process.exit(0)"], {
    stdio: "ignore",
  });
  assert.ok(result.pid);
  return result.pid;
}

// ---------------------------------------------------------------------------
// Focused run-binding tests
// ---------------------------------------------------------------------------

test("a start run id is durable before the runner returns and keys the manifest", async () => {
  await withRepo(async (repo) => {
    const contractsPath = writeContracts(repo);
    addQueueItem(repo, { id: "bound-start", contractsPath });

    let requestRunId: string | undefined;
    let persisted: QueueItem | undefined;
    const runner: QueueSupervisorRunner = async (request) => {
      requestRunId = request.item.lastRunId;
      persisted = itemById(repo, request.item.id);
      assert.equal(
        request.runId,
        undefined,
        "the resume-only request field keeps its legacy start shape",
      );
      assert.ok(requestRunId, "the start snapshot must carry its run id");
      assert.equal(persisted.lastRunId, requestRunId);
      assert.deepEqual(persisted.runIds, [requestRunId]);
      assert.equal(persisted.status, "running");
      assert.equal(persisted.attempts, 1);

      createManifest(repo, contractsPath, requestRunId, { completed: true });
      return {
        exitCode: 0,
        runId: requestRunId,
        status: "completed",
      };
    };

    const summary = await runQueue(repo, { runner });

    assert.ok(requestRunId);
    assert.match(requestRunId, /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/);
    assert.equal(persisted?.status, "running");
    const manifest = loadRunManifest(repo, requestRunId);
    assert.equal(manifest.runId, requestRunId);
    assert.equal(manifest.contractsPath, contractsPath);
    assert.equal(getActiveRunId(repo), requestRunId);

    const completed = itemById(repo, "bound-start");
    assert.equal(completed.status, "completed");
    assert.equal(completed.lastRunId, requestRunId);
    assert.deepEqual(completed.runIds, [requestRunId]);
    assert.equal(summary.dispatches[0]?.runId, requestRunId);
  });
});

test("the real start runner passes --run-id while resume keeps --run", async () => {
  await withRepo(async (repo) => {
    const contractsPath = writeContracts(repo);
    addQueueItem(repo, { id: "adapter", contractsPath });
    const item = itemById(repo, "adapter");
    const calls: string[][] = [];
    const startRunId = "queue-preallocated-start";
    const resumeRunId = "existing-resume-run";
    createManifest(repo, contractsPath, resumeRunId);

    const runner = createQueueSupervisorRunner({
      runSupervisorCli: async (argv) => {
        calls.push([...argv]);
        if (argv[0] === "start") {
          const flag = argv.indexOf("--run-id");
          assert.ok(flag >= 0);
          createManifest(repo, contractsPath, argv[flag + 1]!, {
            completed: true,
          });
        }
        return 0;
      },
    });

    const startResult = await runner({
      repoRoot: repo,
      item: { ...item, lastRunId: startRunId },
      action: "start",
    } satisfies QueueSupervisorRequest);
    assert.equal(startResult.exitCode, 0);
    assert.equal(startResult.runId, startRunId);
    assert.equal(loadRunManifest(repo, startRunId).status, "completed");

    const resumeManifest = loadRunManifest(repo, resumeRunId);
    const resumeResult = await runner({
      repoRoot: repo,
      item: { ...item, lastRunId: resumeRunId },
      action: "resume",
      runId: resumeRunId,
    });
    assert.equal(resumeResult.runId, resumeRunId);
    assert.equal(resumeResult.status, resumeManifest.status);

    assert.equal(calls.length, 2);
    assert.deepEqual(calls[0]?.slice(0, 6), [
      "start",
      contractsPath,
      "--repo",
      repo,
      "--run-id",
      startRunId,
    ]);
    assert.equal(calls[0]?.includes("--run"), false);
    assert.ok(calls[1]?.includes("--run"));
    assert.equal(calls[1]?.[calls[1].indexOf("--run") + 1], resumeRunId);
    assert.equal(calls[1]?.includes("--run-id"), false);
  });
});

test("supervisor start honors --run-id and the manifest store rejects unsafe ids and collisions", async () => {
  await withRepo(async (repo) => {
    const contractsPath = writeContracts(repo);
    const runId = "caller-selected-run";
    const output: string[] = [];

    const code = await runSupervisorCli(
      [
        "start",
        contractsPath,
        "--repo",
        repo,
        "--run-id",
        runId,
        "--dry-run",
      ],
      {
        log: (line) => output.push(line),
        signalHandling: false,
      },
    );
    assert.equal(code, 0);
    const summary = JSON.parse(output.join("\n")) as { runId: string };
    assert.equal(summary.runId, runId);
    assert.equal(loadRunManifest(repo, runId).runId, runId);
    assert.equal(getActiveRunId(repo), runId);

    await assert.rejects(
      runSupervisorCli(
        [
          "start",
          contractsPath,
          "--repo",
          repo,
          "--run-id",
          runId,
          "--dry-run",
        ],
        {
          log: () => undefined,
          signalHandling: false,
        },
      ),
      /run manifest already exists/,
    );
    await assert.rejects(
      runSupervisorCli(
        [
          "start",
          contractsPath,
          "--repo",
          repo,
          "--run-id",
          "../escape",
          "--dry-run",
        ],
        {
          log: () => undefined,
          signalHandling: false,
        },
      ),
      /invalid runId/,
    );
  });
});

test("a crash-like start with a durable manifest is reconciled by its explicit id", async () => {
  await withRepo(async (repo) => {
    const contractsPath = writeContracts(repo);
    addQueueItem(repo, { id: "durable-crash", contractsPath });
    const runId = "durable-crash-run";
    createManifest(repo, contractsPath, runId, { ownerPid: exitedPid() });

    const document = loadQueue(repo);
    const item = document.items[0]!;
    item.status = "running";
    item.attempts = 1;
    item.lastRunId = runId;
    item.runIds = [runId];
    // A start crash after the pre-dispatch queue write leaves `start` here.
    item.nextAction = "start";
    document.updatedAt = new Date().toISOString();
    saveQueue(repo, document);

    let resumedFrom: QueueSupervisorRequest | undefined;
    const runner: QueueSupervisorRunner = async (request) => {
      resumedFrom = request;
      assert.equal(request.action, "resume");
      assert.equal(request.runId, runId);
      const persisted = itemById(repo, request.item.id);
      assert.equal(persisted.lastRunId, runId);
      assert.deepEqual(persisted.runIds, [runId]);
      completeManifest(repo, runId);
      return {
        exitCode: 0,
        runId,
        status: "completed",
      };
    };

    const summary = await runQueue(repo, { runner });

    assert.equal(resumedFrom?.runId, runId);
    assert.equal(summary.reconciled.length, 1);
    assert.equal(summary.reconciled[0]?.runId, runId);
    assert.equal(summary.reconciled[0]?.to, "pending");
    const completed = itemById(repo, "durable-crash");
    assert.equal(completed.status, "completed");
    assert.equal(completed.lastRunId, runId);
    assert.deepEqual(completed.runIds, [runId]);
    assert.equal(loadRunManifest(repo, runId).status, "completed");
  });
});

test("a start failure before manifest creation falls back to a fresh start", async () => {
  await withRepo(async (repo) => {
    const contractsPath = writeContracts(repo);
    addQueueItem(repo, { id: "returns-failure", contractsPath });
    addQueueItem(repo, { id: "throws-failure", contractsPath });

    const preallocated = new Map<string, string>();
    const firstRunner: QueueSupervisorRunner = async (request) => {
      const runId = request.item.lastRunId;
      assert.equal(request.runId, undefined);
      assert.ok(runId);
      preallocated.set(request.item.id, runId);
      const persisted = itemById(repo, request.item.id);
      assert.equal(persisted.lastRunId, runId);
      assert.deepEqual(persisted.runIds, [runId]);
      assert.equal(persisted.status, "running");
      assert.equal(persisted.attempts, 1);

      if (request.item.id === "throws-failure") {
        throw new Error("runner died before creating a manifest");
      }
      return {
        exitCode: 1,
        runId,
        status: "blocked",
        reason: "start failed before manifest creation",
      };
    };

    await runQueue(repo, {
      runner: firstRunner,
      continueOnBlocked: true,
    });

    for (const id of ["returns-failure", "throws-failure"]) {
      const blocked = itemById(repo, id);
      assert.equal(blocked.status, "blocked");
      assert.equal(blocked.lastRunId, undefined);
      assert.deepEqual(blocked.runIds, []);
      assert.equal(blocked.nextAction, "start");
      assert.throws(
        () => loadRunManifest(repo, preallocated.get(id)!),
        /run manifest not found/,
      );
    }

    for (const id of ["returns-failure", "throws-failure"]) {
      retryQueueItem(repo, id);
      assert.equal(itemById(repo, id).nextAction, "start");
    }

    const retryCalls: QueueSupervisorRequest[] = [];
    const retryRunner: QueueSupervisorRunner = async (request) => {
      retryCalls.push(request);
      assert.equal(request.action, "start");
      assert.equal(request.runId, undefined);
      const runId = request.item.lastRunId;
      assert.ok(runId);
      assert.notEqual(runId, preallocated.get(request.item.id));
      createManifest(repo, contractsPath, runId, {
        completed: true,
      });
      return {
        exitCode: 0,
        runId,
        status: "completed",
      };
    };
    await runQueue(repo, { runner: retryRunner });

    assert.deepEqual(
      retryCalls.map((request) => request.action),
      ["start", "start"],
    );
    assert.deepEqual(
      retryCalls.map((request) => request.item.id),
      ["returns-failure", "throws-failure"],
    );
    for (const id of ["returns-failure", "throws-failure"]) {
      assert.equal(itemById(repo, id).status, "completed");
    }
  });
});

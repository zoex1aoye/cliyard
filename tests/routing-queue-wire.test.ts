import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  activateProfile,
  isQueueRoutingEnabled,
  readRoutingDecisions,
} from "../src/admission/index.js";
import {
  runQueue,
  type QueueSupervisorRequest,
  type QueueSupervisorRunner,
} from "../src/orchestration/queue-runner.js";
import {
  addQueueItem,
  loadQueue,
  QueueValidationError,
} from "../src/orchestration/queue-store.js";
import type { TaskContract } from "../src/contracts/schema.js";
import type { ExecutionProfile } from "../src/execution/profile.js";

function runGit(repo: string, args: string[]): string {
  const result = spawnSync("git", args, { cwd: repo, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function initRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), "cliyard-route-wire-"));
  runGit(repo, ["init"]);
  runGit(repo, ["config", "user.email", "t@t.com"]);
  runGit(repo, ["config", "user.name", "t"]);
  writeFileSync(join(repo, "README.md"), "# fixture\n");
  runGit(repo, ["add", "."]);
  runGit(repo, ["commit", "-m", "init"]);
  return repo;
}

function writeContracts(repo: string): string {
  const base = runGit(repo, ["rev-parse", "HEAD"]);
  const contract: TaskContract = {
    taskId: "task",
    version: 1,
    frozen: true,
    goals: ["g"],
    dependsOn: [],
    readPaths: ["."],
    writePaths: ["task.txt"],
    sharedResources: [],
    baseCommit: base,
    verifyCommands: ["true"],
    maxRepairs: 0,
  };
  const path = join(repo, "contracts.json");
  writeFileSync(
    path,
    `${JSON.stringify({ contracts: [contract] }, null, 2)}\n`,
    "utf8",
  );
  return path;
}

const CLAUDE: ExecutionProfile = {
  version: 1,
  profileId: "claude-deepseek-flash",
  runtimeId: "claude",
  modelId: "deepseek-flash",
  providerId: "deepseek",
  endpointRef: "deepseek-claude-default",
  capabilities: {
    mappedProgress: true,
    providerSessionResume: true,
  },
};

test("isQueueRoutingEnabled respects option and env", () => {
  assert.equal(isQueueRoutingEnabled(undefined, {}), false);
  assert.equal(isQueueRoutingEnabled({ enabled: true }, {}), true);
  assert.equal(
    isQueueRoutingEnabled({ enabled: false }, { CLIYARD_ROUTING: "1" }),
    false,
  );
  assert.equal(isQueueRoutingEnabled(undefined, { CLIYARD_ROUTING: "1" }), true);
});

test("routing-enabled add selects activated catalog profile; empty catalog fails", () => {
  const repo = initRepo();
  try {
    const contracts = writeContracts(repo);
    assert.throws(
      () =>
        addQueueItem(repo, {
          id: "no-catalog",
          contractsPath: contracts,
          routing: { enabled: true },
        }),
      (err: unknown) =>
        err instanceof QueueValidationError && /no_activated_profiles/.test(err.message),
    );

    activateProfile({ repoRoot: repo, profile: CLAUDE });
    const item = addQueueItem(repo, {
      id: "routed",
      contractsPath: contracts,
      worker: "claude",
      model: "deepseek-flash",
      routing: { enabled: true },
    });
    assert.equal(item.executionProfile?.profileId, "claude-deepseek-flash");
    assert.equal(readRoutingDecisions(repo).at(-1)?.code, "selected");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("runQueue routing-denied leaves pending when profile not activated", async () => {
  const repo = initRepo();
  try {
    const contracts = writeContracts(repo);
    // Default-off add creates a legacy profile that is NOT in the catalog.
    addQueueItem(repo, {
      id: "legacy",
      contractsPath: contracts,
      worker: "claude",
      model: "deepseek-flash",
    });
    assert.ok(loadQueue(repo).items[0]?.executionProfile);
    assert.notEqual(
      loadQueue(repo).items[0]?.executionProfile?.profileId,
      "claude-deepseek-flash",
    );

    const calls: string[] = [];
    const runner: QueueSupervisorRunner = async (
      request: QueueSupervisorRequest,
    ) => {
      calls.push(request.item.id);
      return { exitCode: 0, status: "completed", runId: "run-1" };
    };

    const summary = await runQueue(repo, {
      runner,
      routing: { enabled: true },
    });
    assert.equal(summary.stopped, "routing-denied");
    assert.equal(summary.dispatched, 0);
    assert.deepEqual(calls, []);
    assert.equal(loadQueue(repo).items[0]?.status, "pending");
    assert.equal(loadQueue(repo).items[0]?.attempts, 0);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("runQueue routing allows activated profile", async () => {
  const repo = initRepo();
  try {
    const contracts = writeContracts(repo);
    activateProfile({ repoRoot: repo, profile: CLAUDE });
    addQueueItem(repo, {
      id: "ok",
      contractsPath: contracts,
      worker: "claude",
      model: "deepseek-flash",
      routing: { enabled: true },
    });

    const calls: string[] = [];
    const runner: QueueSupervisorRunner = async (request) => {
      calls.push(request.item.id);
      return { exitCode: 0, status: "completed", runId: "run-ok" };
    };
    const summary = await runQueue(repo, {
      runner,
      routing: { enabled: true },
    });
    assert.notEqual(summary.stopped, "routing-denied");
    assert.equal(calls.length, 1);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

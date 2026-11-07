import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  activateProfile,
  evaluateQueueAdmission,
  isQueueAdmissionEnabled,
  readAdmissionDecisions,
  setBindingCapacity,
} from "../src/admission/index.js";
import {
  runQueue,
  type QueueSupervisorRequest,
  type QueueSupervisorRunner,
} from "../src/orchestration/queue-runner.js";
import {
  addQueueItem,
  loadQueue,
} from "../src/orchestration/queue-store.js";
import type { TaskContract } from "../src/contracts/schema.js";

function runGit(repo: string, args: string[]): string {
  const result = spawnSync("git", args, { cwd: repo, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function initRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), "cliyard-adm-wire-"));
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
    goals: ["Produce task"],
    dependsOn: [],
    readPaths: ["."],
    writePaths: ["task.txt"],
    sharedResources: [],
    baseCommit: base,
    verifyCommands: ["test -f task.txt"],
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

const PROFILE = {
  version: 1 as const,
  profileId: "claude-deepseek-flash",
  runtimeId: "claude" as const,
  modelId: "deepseek-flash",
  providerId: "deepseek",
  endpointRef: "deepseek-claude-default",
  capabilities: {
    mappedProgress: true,
    providerSessionResume: true,
  },
};

function writeProfile(repo: string): string {
  const path = join(repo, "profile.json");
  writeFileSync(path, `${JSON.stringify(PROFILE, null, 2)}\n`, "utf8");
  return path;
}

function fakeRunner(): {
  calls: string[];
  runner: QueueSupervisorRunner;
} {
  const calls: string[] = [];
  const runner: QueueSupervisorRunner = async (
    request: QueueSupervisorRequest,
  ) => {
    calls.push(request.item.id);
    return {
      exitCode: 0,
      status: "completed",
      runId: `run-${request.item.id}`,
    };
  };
  return { calls, runner };
}

test("isQueueAdmissionEnabled respects option and CLIYARD_ADMISSION", () => {
  assert.equal(isQueueAdmissionEnabled(undefined, {}), false);
  assert.equal(isQueueAdmissionEnabled({ enabled: true }, {}), true);
  assert.equal(isQueueAdmissionEnabled({ enabled: false }, { CLIYARD_ADMISSION: "1" }), false);
  assert.equal(isQueueAdmissionEnabled(undefined, { CLIYARD_ADMISSION: "1" }), true);
});

test("evaluateQueueAdmission requires activated catalog profile; unknown ⇒ permit 1", () => {
  const repo = initRepo();
  try {
    const missing = evaluateQueueAdmission({
      repoRoot: repo,
      candidate: {
        id: "a",
        status: "pending",
        executionProfile: PROFILE,
      },
      items: [],
    });
    assert.equal(missing.code, "profile_not_activated");
    assert.equal(missing.admitted, false);

    activateProfile({ repoRoot: repo, profile: PROFILE });
    const probe = evaluateQueueAdmission({
      repoRoot: repo,
      candidate: {
        id: "a",
        status: "pending",
        executionProfile: PROFILE,
      },
      items: [],
    });
    assert.equal(probe.admitted, true);
    assert.equal(probe.decision?.effective, 1);

    setBindingCapacity({
      repoRoot: repo,
      profileId: PROFILE.profileId,
      configuredMax: 1,
      limitSource: "operator",
    });
    const denied = evaluateQueueAdmission({
      repoRoot: repo,
      candidate: {
        id: "b",
        status: "pending",
        executionProfile: PROFILE,
      },
      items: [
        {
          id: "running-one",
          status: "running",
          executionProfile: PROFILE,
        },
      ],
    });
    assert.equal(denied.admitted, false);
    assert.equal(denied.code, "admission_denied");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("opt-in runQueue admission-denied leaves candidate pending (no attempt)", async () => {
  const repo = initRepo();
  try {
    const contracts = writeContracts(repo);
    const profilePath = writeProfile(repo);
    activateProfile({ repoRoot: repo, profile: PROFILE });

    addQueueItem(repo, {
      id: "candidate",
      contractsPath: contracts,
      executionProfilePath: profilePath,
      worker: "claude",
      model: "deepseek-flash",
    });

    const fake = fakeRunner();
    // globalTaskLimit 0 forces a capacity deny without a live running peer
    // (running items would be reconciled to blocked and stop the queue first).
    const summary = await runQueue(repo, {
      runner: fake.runner,
      admission: { enabled: true, globalTaskLimit: 0 },
    });

    assert.equal(summary.stopped, "admission-denied");
    assert.equal(summary.dispatched, 0);
    assert.deepEqual(fake.calls, []);
    assert.equal(summary.admission?.code, "admission_denied");
    assert.equal(
      loadQueue(repo).items.find((i) => i.id === "candidate")?.status,
      "pending",
    );
    assert.equal(
      loadQueue(repo).items.find((i) => i.id === "candidate")?.attempts,
      0,
    );

    const decisions = readAdmissionDecisions(repo);
    assert.equal(decisions.length, 1);
    assert.equal(decisions[0]?.admitted, false);
    assert.equal(decisions[0]?.itemId, "candidate");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("default-off admission still dispatches; enabled admits when capacity free", async () => {
  const repo = initRepo();
  try {
    const contracts = writeContracts(repo);
    const profilePath = writeProfile(repo);
    activateProfile({ repoRoot: repo, profile: PROFILE });

    addQueueItem(repo, {
      id: "one",
      contractsPath: contracts,
      executionProfilePath: profilePath,
      worker: "claude",
      model: "deepseek-flash",
    });

    const off = fakeRunner();
    const offSummary = await runQueue(repo, { runner: off.runner });
    assert.notEqual(
      offSummary.stopped,
      "admission-denied",
      offSummary.reason ?? offSummary.stopped,
    );
    assert.equal(off.calls.length, 1, offSummary.reason ?? offSummary.stopped);
    assert.equal(offSummary.admission, undefined);

    // Fresh item for the enabled-admit path (prior dispatch may have completed).
    addQueueItem(repo, {
      id: "two",
      contractsPath: contracts,
      executionProfilePath: profilePath,
      worker: "claude",
      model: "deepseek-flash",
    });

    const on = fakeRunner();
    const onSummary = await runQueue(repo, {
      runner: on.runner,
      admission: { enabled: true },
    });
    assert.notEqual(
      onSummary.stopped,
      "admission-denied",
      onSummary.reason ?? onSummary.stopped,
    );
    assert.equal(on.calls.length, 1, onSummary.reason ?? onSummary.stopped);
    assert.equal(onSummary.admission?.admitted, true);
    assert.equal(readAdmissionDecisions(repo).at(-1)?.admitted, true);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

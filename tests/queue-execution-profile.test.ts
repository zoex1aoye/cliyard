import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runQueueCli } from "../src/orchestration/cli.js";
import {
  addQueueItem,
  loadQueue,
  queuePaths,
  retryQueueItem,
  type QueueItem,
} from "../src/orchestration/queue-store.js";
import {
  checkQueueItemExecutionPolicy,
  createQueueSupervisorRunner,
  runQueue,
  type QueueSupervisorRequest,
  type QueueSupervisorRunner,
} from "../src/orchestration/queue-runner.js";
import { readQueueEventJournal } from "../src/orchestration/event-journal.js";
import {
  createLegacyExecutionProfile,
  parseExecutionProfile,
  parseExecutionProfileJson,
} from "../src/execution/profile.js";
import {
  continuationPolicyToSupervisorArgs,
  parseQueueContinuationPolicy,
} from "../src/agents/continuation.js";
import {
  createRunManifest,
  updateRunManifest,
} from "../src/supervisor/store.js";
import type { RunStatus } from "../src/supervisor/types.js";

const DEADLINE = {
  version: 1 as const,
  baseTimeoutMs: 1_200_000,
  extensionStepMs: 300_000,
  maxExtensions: 2,
  maxTotalTimeoutMs: 1_800_000,
  healthyActivityWindowMs: 60_000,
  autoExtend: true,
};

const BUDGET = {
  version: 1 as const,
  baseGuardUsd: 5,
  continuationGuardUsd: 5,
  maxContinuations: 2,
  maxCumulativeGuardUsd: 20,
  autoContinue: true,
  overshootReserveUsd: 2,
};

const QUEUE_POLICY = {
  version: 1 as const,
  deadlineExtension: DEADLINE,
  budgetContinuation: BUDGET,
};

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
  const repo = mkdtempSync(join(tmpdir(), "cliyard-execution-profile-"));
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

function writeContracts(repo: string): string {
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
            goals: ["Create task.txt"],
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
  return path;
}

function writeJson(repo: string, name: string, value: unknown): string {
  const path = join(repo, name);
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  return path;
}

function writePlan(repo: string, planId: string): string {
  return writeJson(repo, `${planId}.plan.json`, {
    planId,
    tasks: [
      {
        taskId: `${planId}-task`,
        goal: `Create ${planId}.txt`,
        writePaths: [`${planId}.txt`],
        verifyCommands: [`test -f ${planId}.txt`],
      },
    ],
  });
}

function itemById(repo: string, id: string): QueueItem {
  const item = loadQueue(repo).items.find((candidate) => candidate.id === id);
  assert.ok(item, `queue item ${id} must exist`);
  return item;
}

function createManifestForItem(
  repo: string,
  item: QueueItem,
  runId: string,
  status: RunStatus,
): void {
  assert.ok(item.contractsPath && item.contractsHash);
  createRunManifest(repo, {
    runId,
    planId: item.planId ?? item.id,
    contractsPath: item.contractsPath,
    contractsHash: item.contractsHash,
    baseCommit: runGit(repo, ["rev-parse", "HEAD"]),
    integrationBranch: `cliyard/integration/${runId}`,
    tasks: ["task"],
  });
  updateRunManifest(repo, runId, (manifest) => {
    manifest.status = status;
    if (status === "completed") {
      const task = manifest.tasks.task!;
      task.status = "accepted";
      task.accepted = true;
    }
  });
}

function completeManifest(repo: string, runId: string): void {
  updateRunManifest(repo, runId, (manifest) => {
    manifest.status = "completed";
    const task = manifest.tasks.task!;
    task.status = "accepted";
    task.accepted = true;
  });
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

function rawQueueDocument(repo: string): Record<string, any> {
  return JSON.parse(
    readFileSync(queuePaths(repo).queuePath, "utf8"),
  ) as Record<string, any>;
}

function writeRawQueue(repo: string, value: unknown): void {
  writeFileSync(
    queuePaths(repo).queuePath,
    `${JSON.stringify(value, null, 2)}\n`,
    "utf8",
  );
}

function flagValue(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}

// ---------------------------------------------------------------------------
// Parsing and provenance
// ---------------------------------------------------------------------------

test("execution profiles normalize bounded fields and derive capabilities", () => {
  const claude = parseExecutionProfile({
    version: 1,
    profileId: "profile-claude-one",
    runtimeId: "claude",
    modelId: "deepseek-flash",
    providerId: "deepseek",
    endpointRef: "endpoint-team-main",
    accountBindingId: "account-team",
  });
  assert.ok(claude);
  assert.deepEqual(claude.capabilities, {
    mappedProgress: true,
    providerSessionResume: true,
  });
  assert.equal(Object.isFrozen(claude), true);
  assert.equal(Object.isFrozen(claude.capabilities), true);

  const codex = parseExecutionProfile({
    version: 1,
    profileId: "profile-codex-one",
    runtimeId: "codex",
    modelId: "deepseek-v4-pro",
    providerId: "deepseek",
  });
  assert.ok(codex);
  assert.deepEqual(codex.capabilities, {
    mappedProgress: false,
    providerSessionResume: false,
  });

  const defaults = [
    createLegacyExecutionProfile({ runtimeId: "claude" }),
    createLegacyExecutionProfile({ runtimeId: "claude" }),
    createLegacyExecutionProfile({ runtimeId: "codex" }),
  ];
  assert.equal(defaults[0]!.modelId, "deepseek-flash");
  assert.equal(defaults[0]!.endpointRef, "deepseek-claude-default");
  assert.equal(defaults[1]!.profileId, defaults[0]!.profileId);
  assert.equal(defaults[2]!.modelId, "deepseek-v4-pro");
  assert.equal(defaults[2]!.endpointRef, "deepseek-codex-default");

  const custom = createLegacyExecutionProfile({
    runtimeId: "claude",
    modelId: "custom-model",
  });
  assert.equal(custom.providerId, "unknown");
  assert.equal(custom.endpointRef, "unknown-default-endpoint");
});

test("profile and continuation parsers reject secrets, URLs and false capabilities", () => {
  const base = {
    version: 1,
    profileId: "profile-safe",
    runtimeId: "claude",
    modelId: "deepseek-flash",
    providerId: "deepseek",
  };
  assert.equal(
    parseExecutionProfile({
      ...base,
      capabilities: {
        mappedProgress: true,
        providerSessionResume: false,
      },
    }),
    undefined,
  );
  assert.equal(
    parseExecutionProfile({
      ...base,
      endpointRef: "https://user:password@example.invalid/v1",
    }),
    undefined,
  );
  assert.equal(
    parseExecutionProfileJson(
      JSON.stringify({ ...base, apiKey: "sk-should-never-persist" }),
    ),
    undefined,
  );
  assert.equal(
    parseQueueContinuationPolicy({
      version: 1,
      budgetContinuation: {
        ...BUDGET,
        apiKey: "sk-should-never-persist",
      },
    }),
    undefined,
  );
  assert.equal(
    parseQueueContinuationPolicy({
      version: 1,
      deadlineExtension: DEADLINE,
      deadlinePolicy: DEADLINE,
    }),
    undefined,
  );
});

test("file input is frozen, source paths are omitted, and add-plan accepts the same files", async () => {
  await withRepo(async (repo) => {
    const contracts = writeContracts(repo);
    const profilePath = writeJson(repo, "team-profile.json", {
      version: 1,
      profileId: "profile-file-claude",
      runtimeId: "claude",
      modelId: "deepseek-v4-pro",
      providerId: "deepseek",
      endpointRef: "endpoint-file-main",
      accountBindingId: "account-file-team",
    });
    const policyPath = writeJson(repo, "team-policy.json", QUEUE_POLICY);

    const added = await runCli(repo, [
      "add",
      contracts,
      "--id",
      "file-add",
      "--execution-profile",
      profilePath,
      "--continuation-policy",
      policyPath,
      "--json",
    ]);
    assert.equal(added.code, 0);
    assert.equal(added.json.worker, "claude");
    assert.equal(added.json.model, "deepseek-v4-pro");
    assert.equal(added.json.executionProfile.profileId, "profile-file-claude");
    assert.deepEqual(added.json.executionProfile.capabilities, {
      mappedProgress: true,
      providerSessionResume: true,
    });
    assert.deepEqual(added.json.continuationPolicy, QUEUE_POLICY);

    const before = JSON.stringify(
      itemById(repo, "file-add").executionProfile,
    );
    writeJson(repo, "team-profile.json", {
      version: 1,
      profileId: "profile-file-changed",
      runtimeId: "codex",
      modelId: "changed-model",
      providerId: "deepseek",
    });
    assert.equal(
      JSON.stringify(itemById(repo, "file-add").executionProfile),
      before,
    );

    const planPath = writePlan(repo, "file-plan");
    const planned = await runCli(repo, [
      "add-plan",
      planPath,
      "--id",
      "file-plan",
      "--execution-profile",
      "team-profile.json",
      "--continuation-policy",
      "team-policy.json",
      "--json",
    ]);
    assert.equal(planned.code, 0);
    assert.equal(planned.json.worker, "codex");
    assert.equal(planned.json.model, "changed-model");
    assert.equal(planned.json.executionProfile.profileId, "profile-file-changed");
    assert.deepEqual(planned.json.continuationPolicy, QUEUE_POLICY);

    const queueText = readFileSync(queuePaths(repo).queuePath, "utf8");
    assert.equal(queueText.includes(profilePath), false);
    assert.equal(queueText.includes(policyPath), false);
    assert.equal(queueText.includes('"apiKey"'), false);
    assert.equal(queueText.includes("https://"), false);
  });
});

test("explicit worker/model conflicts with a profile file fail closed", async () => {
  await withRepo(async (repo) => {
    const contracts = writeContracts(repo);
    const profilePath = writeJson(
      repo,
      "claude-profile.json",
      {
        version: 1,
        profileId: "profile-conflict-claude",
        runtimeId: "claude",
        modelId: "deepseek-flash",
        providerId: "deepseek",
      },
    );

    await assert.rejects(
      runQueueCli([
        "add",
        contracts,
        "--repo",
        repo,
        "--id",
        "worker-conflict",
        "--worker",
        "codex",
        "--execution-profile",
        profilePath,
      ]),
      /--worker codex conflicts with execution profile runtimeId claude/,
    );
    await assert.rejects(
      runQueueCli([
        "add",
        contracts,
        "--repo",
        repo,
        "--id",
        "model-conflict",
        "--model",
        "other-model",
        "--execution-profile",
        profilePath,
      ]),
      /--model other-model conflicts with execution profile modelId deepseek-flash/,
    );

    const matching = await runCli(repo, [
      "add",
      contracts,
      "--id",
      "matching",
      "--worker",
      "claude",
      "--model",
      "deepseek-flash",
      "--execution-profile",
      profilePath,
      "--json",
    ]);
    assert.equal(matching.code, 0);
    assert.equal(matching.json.executionProfile.profileId, "profile-conflict-claude");
  });
});

// ---------------------------------------------------------------------------
// Durable profile/policy behavior
// ---------------------------------------------------------------------------

test("new items always freeze a deterministic profile and legacy records remain readable", async () => {
  await withRepo(async (repo) => {
    const contracts = writeContracts(repo);
    const added = addQueueItem(repo, {
      id: "new-profile",
      contractsPath: contracts,
    });
    assert.ok(added.executionProfile);
    assert.equal(added.worker, added.executionProfile.runtimeId);
    assert.equal(added.model, added.executionProfile.modelId);
    assert.equal(added.model, "deepseek-flash");
    assert.equal(added.executionProfile.providerId, "deepseek");

    const raw = rawQueueDocument(repo);
    const legacy = raw.items[0] as Record<string, unknown>;
    delete legacy.executionProfile;
    delete legacy.model;
    writeRawQueue(repo, raw);

    const loaded = itemById(repo, "new-profile");
    assert.equal(loaded.executionProfile, undefined);
    assert.equal(loaded.model, undefined);

    let observed: QueueSupervisorRequest | undefined;
    const runner: QueueSupervisorRunner = async (request) => {
      observed = request;
      const runId = request.item.lastRunId!;
      createManifestForItem(repo, request.item, runId, "completed");
      return { exitCode: 0, runId, status: "completed" };
    };
    const summary = await runQueue(repo, { runner });
    assert.equal(summary.dispatches[0]?.status, "completed");
    assert.ok(observed);
    assert.equal(observed.item.executionProfile, undefined);
    assert.equal(observed.item.worker, "claude");
    assert.equal(observed.item.model, undefined);
  });
});

test("profile and policy remain byte-identical across blocked retry and resume", async () => {
  await withRepo(async (repo) => {
    const contracts = writeContracts(repo);
    const policyPath = writeJson(repo, "policy.json", QUEUE_POLICY);
    const added = addQueueItem(repo, {
      id: "frozen",
      contractsPath: contracts,
      worker: "claude",
      model: "deepseek-flash",
      continuationPolicyPath: policyPath,
    });
    const frozenProfile = JSON.stringify(added.executionProfile);
    const frozenPolicy = JSON.stringify(added.continuationPolicy);
    assert.ok(frozenProfile);
    assert.ok(frozenPolicy);

    const observed: QueueSupervisorRequest[] = [];
    let call = 0;
    const runner: QueueSupervisorRunner = async (request) => {
      observed.push(request);
      call += 1;
      const runId = request.runId ?? request.item.lastRunId!;
      if (call === 1) {
        createManifestForItem(repo, request.item, runId, "blocked");
        return {
          exitCode: 1,
          runId,
          status: "blocked",
          reason: "fixture blocked",
        };
      }
      completeManifest(repo, runId);
      return { exitCode: 0, runId, status: "completed" };
    };

    const first = await runQueue(repo, { runner });
    assert.equal(first.dispatches[0]?.status, "blocked");
    const blocked = itemById(repo, "frozen");
    assert.equal(JSON.stringify(blocked.executionProfile), frozenProfile);
    assert.equal(JSON.stringify(blocked.continuationPolicy), frozenPolicy);

    retryQueueItem(repo, "frozen");
    const retried = itemById(repo, "frozen");
    assert.equal(retried.nextAction, "resume");
    assert.equal(JSON.stringify(retried.executionProfile), frozenProfile);
    assert.equal(JSON.stringify(retried.continuationPolicy), frozenPolicy);

    const second = await runQueue(repo, { runner });
    assert.equal(second.dispatches[0]?.action, "resume");
    assert.equal(observed.length, 2);
    assert.equal(JSON.stringify(observed[1]!.item.executionProfile), frozenProfile);
    assert.equal(JSON.stringify(observed[1]!.item.continuationPolicy), frozenPolicy);
    const completed = itemById(repo, "frozen");
    assert.equal(completed.status, "completed");
    assert.equal(JSON.stringify(completed.executionProfile), frozenProfile);
    assert.equal(JSON.stringify(completed.continuationPolicy), frozenPolicy);
  });
});

// ---------------------------------------------------------------------------
// Supervisor argv and compatibility
// ---------------------------------------------------------------------------

test("runner maps every frozen policy flag on both start and resume", async () => {
  await withRepo(async (repo) => {
    const contracts = writeContracts(repo);
    const policyPath = writeJson(repo, "runner-policy.json", QUEUE_POLICY);
    addQueueItem(repo, {
      id: "runner",
      contractsPath: contracts,
      worker: "claude",
      model: "deepseek-flash",
      continuationPolicyPath: policyPath,
    });
    const item = itemById(repo, "runner");
    const startId = "profile-start-run";
    const resumeId = "profile-resume-run";
    createManifestForItem(repo, item, startId, "completed");
    createManifestForItem(repo, item, resumeId, "blocked");

    const calls: string[][] = [];
    const runner = createQueueSupervisorRunner({
      runSupervisorCli: async (argv) => {
        calls.push([...argv]);
        return 0;
      },
    });

    const oldModel = process.env.CLIYARD_CLAUDE_MODEL;
    const oldBudget = process.env.CLIYARD_CLAUDE_MAX_BUDGET_USD;
    process.env.CLIYARD_CLAUDE_MODEL = "environment-model";
    process.env.CLIYARD_CLAUDE_MAX_BUDGET_USD = "999";
    try {
      const start = await runner({
        repoRoot: repo,
        item: { ...item, lastRunId: startId },
        action: "start",
      });
      const resume = await runner({
        repoRoot: repo,
        item: { ...item, lastRunId: resumeId },
        action: "resume",
        runId: resumeId,
      });
      assert.equal(start.status, "completed");
      assert.equal(resume.status, "blocked");
    } finally {
      if (oldModel === undefined) delete process.env.CLIYARD_CLAUDE_MODEL;
      else process.env.CLIYARD_CLAUDE_MODEL = oldModel;
      if (oldBudget === undefined) {
        delete process.env.CLIYARD_CLAUDE_MAX_BUDGET_USD;
      } else {
        process.env.CLIYARD_CLAUDE_MAX_BUDGET_USD = oldBudget;
      }
    }

    assert.equal(calls.length, 2);
    for (const args of calls) {
      assert.equal(flagValue(args, "--worker"), "claude");
      assert.equal(flagValue(args, "--model"), "deepseek-flash");
      assert.equal(flagValue(args, "--timeout-ms"), "1200000");
      assert.equal(flagValue(args, "--deadline-extension-ms"), "300000");
      assert.equal(flagValue(args, "--max-deadline-extensions"), "2");
      assert.equal(flagValue(args, "--max-total-timeout-ms"), "1800000");
      assert.equal(flagValue(args, "--healthy-activity-window-ms"), "60000");
      assert.equal(args.includes("--auto-extend-deadline"), true);
      assert.equal(flagValue(args, "--max-budget-usd"), "5");
      assert.equal(flagValue(args, "--continuation-guard-usd"), "5");
      assert.equal(flagValue(args, "--max-budget-continuations"), "2");
      assert.equal(flagValue(args, "--max-cumulative-budget-guard-usd"), "20");
      assert.equal(flagValue(args, "--budget-overshoot-reserve-usd"), "2");
      assert.equal(args.includes("--auto-continue-budget"), true);
      assert.equal(args.includes("environment-model"), false);
    }
    assert.deepEqual(
      continuationPolicyToSupervisorArgs(item.continuationPolicy!),
      calls[0]!.slice(calls[0]!.indexOf("--timeout-ms")),
    );
    assert.equal(calls[1]!.includes("--retry-rejected"), true);
    assert.equal(flagValue(calls[1]!, "--run"), "profile-resume-run");
    assert.equal(calls[0]!.includes("--run-id"), true);
  });
});

test("Codex budget and automatic deadline policies block before dispatch", async () => {
  await withRepo(async (repo) => {
    const contracts = writeContracts(repo);
    const budgetPath = writeJson(repo, "codex-budget.json", {
      version: 1,
      budgetContinuation: BUDGET,
    });
    const deadlinePath = writeJson(repo, "codex-deadline.json", {
      version: 1,
      deadlineExtension: DEADLINE,
    });
    addQueueItem(repo, {
      id: "codex-budget",
      contractsPath: contracts,
      worker: "codex",
      continuationPolicyPath: budgetPath,
    });
    addQueueItem(repo, {
      id: "codex-deadline",
      contractsPath: contracts,
      worker: "codex",
      continuationPolicyPath: deadlinePath,
    });

    let runnerCalls = 0;
    const summary = await runQueue(repo, {
      continueOnBlocked: true,
      runner: async () => {
        runnerCalls += 1;
        return { exitCode: 0 };
      },
    });
    assert.equal(runnerCalls, 0);
    assert.equal(summary.dispatches.length, 0);
    assert.equal(itemById(repo, "codex-budget").attempts, 0);
    assert.equal(
      itemById(repo, "codex-budget").failure?.code,
      "provider_session_resume_required",
    );
    assert.equal(
      itemById(repo, "codex-deadline").failure?.code,
      "mapped_progress_required",
    );
    assert.equal(
      checkQueueItemExecutionPolicy(itemById(repo, "codex-budget")).ok,
      false,
    );
  });
});

// ---------------------------------------------------------------------------
// Tampering and control projections
// ---------------------------------------------------------------------------

test("queue loading fails closed on worker/model, capability and reference tampering", async () => {
  await withRepo(async (repo) => {
    const contracts = writeContracts(repo);
    addQueueItem(repo, {
      id: "tamper-target",
      contractsPath: contracts,
    });
    const original = rawQueueDocument(repo);

    const workerMismatch = structuredClone(original);
    workerMismatch.items[0].worker = "codex";
    writeRawQueue(repo, workerMismatch);
    assert.throws(() => loadQueue(repo), /does not match execution profile runtimeId/);

    const modelMismatch = structuredClone(original);
    modelMismatch.items[0].model = "tampered-model";
    writeRawQueue(repo, modelMismatch);
    assert.throws(() => loadQueue(repo), /does not match execution profile modelId/);

    const capabilityMismatch = structuredClone(original);
    capabilityMismatch.items[0].executionProfile.capabilities.mappedProgress =
      false;
    writeRawQueue(repo, capabilityMismatch);
    assert.throws(() => loadQueue(repo), /executionProfile is not a valid/);

    const urlRef = structuredClone(original);
    urlRef.items[0].executionProfile.endpointRef =
      "https://example.invalid/v1";
    writeRawQueue(repo, urlRef);
    assert.throws(() => loadQueue(repo), /executionProfile is not a valid/);

    writeRawQueue(repo, original);
    assert.equal(itemById(repo, "tamper-target").executionProfile?.runtimeId, "claude");
  });
});

test("status JSON/human and bounded events expose execution and continuation summaries", async () => {
  await withRepo(async (repo) => {
    const contracts = writeContracts(repo);
    const policyPath = writeJson(repo, "status-policy.json", QUEUE_POLICY);
    const added = await runCli(repo, [
      "add",
      contracts,
      "--id",
      "status-item",
      "--continuation-policy",
      policyPath,
      "--json",
    ]);
    assert.equal(added.code, 0);
    const profileId = added.json.executionProfile.profileId as string;

    const runner: QueueSupervisorRunner = async (request) => {
      const runId = request.item.lastRunId!;
      createManifestForItem(repo, request.item, runId, "completed");
      return { exitCode: 0, runId, status: "completed" };
    };
    await runQueue(repo, { runner });

    const status = await runCli(repo, ["status", "--json"]);
    assert.equal(status.code, 0);
    const execution = status.json.items[0].execution;
    assert.equal(execution.frozen, true);
    assert.equal(execution.profileId, profileId);
    assert.equal(execution.runtimeId, "claude");
    assert.equal(execution.modelId, "deepseek-flash");
    assert.equal(execution.providerId, "deepseek");
    assert.deepEqual(execution.capabilities, {
      mappedProgress: true,
      providerSessionResume: true,
    });
    assert.equal(execution.continuation.deadlineExtension.maxExtensions, 2);
    assert.equal(execution.continuation.budgetContinuation.maxContinuations, 2);
    assert.equal(execution.policyCheck.ok, true);

    const human = await runCli(repo, ["status"]);
    for (const fragment of [
      profileId,
      "mappedProgress=true",
      "providerSessionResume=true",
      "continuation deadline: auto=true maxExtensions=2",
      "continuation budget: auto=true maxContinuations=2",
    ]) {
      assert.ok(
        human.text.includes(fragment),
        `status output missing ${JSON.stringify(fragment)}:\n${human.text}`,
      );
    }

    const journal = readQueueEventJournal(repo);
    const addedEvent = journal.events.find(
      (event) => event.type === "queue.item.added",
    );
    const dispatchEvent = journal.events.find(
      (event) => event.type === "attempt.started",
    );
    for (const event of [addedEvent, dispatchEvent]) {
      assert.ok(event);
      assert.equal(event.executionProfileId, profileId);
      assert.equal(event.runtimeId, "claude");
      assert.equal(event.modelId, "deepseek-flash");
      assert.equal(event.mappedProgress, true);
      assert.equal(event.providerSessionResume, true);
      assert.equal(event.deadlineAutoExtend, true);
      assert.equal(event.deadlineMaxExtensions, 2);
      assert.equal(event.budgetAutoContinue, true);
      assert.equal(event.budgetMaxContinuations, 2);
    }
    const eventText = readFileSync(
      join(repo, ".cliyard", "queue-events", "events.jsonl"),
      "utf8",
    );
    assert.equal(eventText.includes("https://"), false);
    assert.equal(eventText.includes("apiKey"), false);
  });
});

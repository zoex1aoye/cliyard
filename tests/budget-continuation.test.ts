import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClaudeAdapter } from "../src/agents/claude.js";
import {
  DEFAULT_BUDGET_CONTINUATION_POLICY,
  parseBudgetContinuationPolicy,
  type BudgetContinuationPolicy,
  type BudgetContinuationTaskExtensionRecord,
  type TaskExtensionRecord,
} from "../src/agents/continuation.js";
import type { AgentResult } from "../src/agents/types.js";
import type { TaskContract } from "../src/contracts/schema.js";
import {
  createRunManifest,
  getActiveRunId,
  loadRunManifest,
  runManifestPath,
} from "../src/supervisor/store.js";
import { runSupervisorCli } from "../src/supervisor/cli.js";

function runGit(
  repo: string,
  args: string[],
  allowFailure = false,
): string {
  const result = spawnSync("git", args, { cwd: repo, encoding: "utf8" });
  if (!allowFailure) {
    assert.equal(
      result.status,
      0,
      `git ${args.join(" ")} failed: ${result.stderr}`,
    );
  }
  return result.stdout.trim();
}

function initRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), "cliyard-budget-continuation-"));
  runGit(repo, ["init"]);
  runGit(repo, ["config", "user.email", "t@t.com"]);
  runGit(repo, ["config", "user.name", "t"]);
  writeFileSync(join(repo, "allowed.ts"), "export const value = 1;\n");
  runGit(repo, ["add", "."]);
  runGit(repo, ["commit", "-m", "init"]);
  return repo;
}

function contract(repo: string, taskId = "budget-fixture"): TaskContract {
  return {
    taskId,
    version: 1,
    frozen: true,
    goals: ["Change allowed.ts"],
    dependsOn: [],
    readPaths: ["."],
    writePaths: ["allowed.ts"],
    sharedResources: [],
    baseCommit: runGit(repo, ["rev-parse", "HEAD"]),
    verifyCommands: ["test -f allowed.ts"],
    maxRepairs: 0,
  };
}

function writeContracts(repo: string, task: TaskContract): string {
  const path = join(repo, "contracts.json");
  writeFileSync(
    path,
    `${JSON.stringify({ contracts: [task] }, null, 2)}\n`,
    "utf8",
  );
  return path;
}

interface ClaudeFixture {
  root: string;
  repo: string;
  binary: string;
  argsPath: string;
  contract: TaskContract;
  cleanup: () => void;
}

function claudeFixture(
  body: string,
  taskId = "budget-fixture",
): ClaudeFixture {
  const root = mkdtempSync(join(tmpdir(), "cliyard-budget-bin-"));
  const repo = initRepo();
  const binary = join(root, "fake-claude");
  const argsPath = join(root, "args.jsonl");
  const runnerPath = join(root, "fake-claude-runner.js");
  writeFileSync(
    runnerPath,
    `
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
const argsPath = ${JSON.stringify(argsPath)};
fs.appendFileSync(argsPath, JSON.stringify(args) + "\\n");
const resumeIndex = args.indexOf("--resume");
const sessionIndex = args.indexOf("--session-id");
const resume = resumeIndex >= 0 ? args[resumeIndex + 1] : undefined;
const freshSessionId =
  sessionIndex >= 0 ? args[sessionIndex + 1] : undefined;
const sessionId = resume || freshSessionId;
const argsLines = fs.readFileSync(argsPath, "utf8").trim().split("\\n");
const callNumber = argsLines.length;
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const assistant = (text) => console.log(JSON.stringify({
  type: "assistant",
  message: {
    role: "assistant",
    content: [{ type: "text", text }]
  }
}));
const budgetResult = (cost = 0.02) => console.log(JSON.stringify({
  type: "result",
  subtype: "error_max_budget_usd",
  is_error: true,
  result: "Claude AI usage limit reached",
  session_id: sessionId,
  total_cost_usd: cost
}));
const successResult = (text = "fixture complete", cost = 0.03) =>
  console.log(JSON.stringify({
    type: "result",
    subtype: "success",
    is_error: false,
    result: text,
    session_id: sessionId,
    total_cost_usd: cost
  }));
(async () => {
${body}
})();
`,
  );
  writeFileSync(
    binary,
    `#!/bin/sh
exec "${process.execPath}" "${runnerPath}" "$@"
`,
  );
  chmodSync(binary, 0o755);
  return {
    root,
    repo,
    binary,
    argsPath,
    contract: contract(repo, taskId),
    cleanup: () => {
      rmSync(root, { recursive: true, force: true });
      rmSync(repo, { recursive: true, force: true });
    },
  };
}

function policy(
  overrides: Partial<BudgetContinuationPolicy> = {},
): BudgetContinuationPolicy {
  const baseGuardUsd = overrides.baseGuardUsd ?? 1;
  const continuationGuardUsd =
    overrides.continuationGuardUsd ?? 1;
  const maxContinuations = overrides.maxContinuations ?? 1;
  return {
    version: 1,
    baseGuardUsd,
    continuationGuardUsd,
    maxContinuations,
    maxCumulativeGuardUsd:
      overrides.maxCumulativeGuardUsd ??
      baseGuardUsd + continuationGuardUsd * maxContinuations,
    autoContinue: overrides.autoContinue ?? true,
    overshootReserveUsd: overrides.overshootReserveUsd ?? 0,
  };
}

async function runAdapter(
  fixture: ClaudeFixture,
  options: {
    policy?: BudgetContinuationPolicy;
    timeoutMs?: number;
  } = {},
  onExtension?: (
    extension: TaskExtensionRecord,
  ) => void | Promise<void>,
): Promise<AgentResult> {
  const worker = createClaudeAdapter({
    binary: fixture.binary,
    cwd: fixture.repo,
    model: "fixture-model",
    maxBudgetUsd: options.policy?.baseGuardUsd ?? 3,
    maxTransientRetries: 0,
    heartbeatMs: 30,
    ...(options.policy ? { budgetPolicy: options.policy } : {}),
    ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
  });
  const { sessionId } = await worker.start({
    contract: fixture.contract,
    attempt: 0,
    ...(onExtension ? { onExtension } : {}),
  });
  return worker.collect(sessionId);
}

function readArgs(path: string): string[][] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as string[]);
}

function argValue(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}

function budgetRecord(
  overrides: Partial<BudgetContinuationTaskExtensionRecord> = {},
): BudgetContinuationTaskExtensionRecord {
  return {
    version: 1,
    extensionId: "budget-extension-1",
    attempt: 0,
    kind: "budget-continuation",
    source: "auto",
    requestedAt: "2026-10-28T00:00:01.000Z",
    grantedAt: "2026-10-28T00:00:01.000Z",
    reason: "mapped assistant progress before clean error_max_budget_usd",
    healthyEvidence: ["assistant@2026-10-28T00:00:00.900Z"],
    providerSessionId: "provider-session-1",
    additionalGuardUsd: 1,
    cumulativeGuardUsd: 2,
    continuationIndex: 1,
    ...overrides,
  };
}

test("budget continuation resumes the same provider session with a larger guard", async () => {
  const markerPath = join(tmpdir(), `cliyard-budget-persisted-${process.pid}-${Date.now()}`);
  const fixture = claudeFixture(`
await delay(20);
assistant("working before budget exhaustion");
if (!resume) {
  budgetResult(0.02);
} else {
  if (!fs.existsSync(${JSON.stringify(markerPath)})) process.exit(31);
  fs.appendFileSync(
    path.join(process.cwd(), "allowed.ts"),
    "\\nexport const resumed = true;\\n"
  );
  successResult("resumed fixture complete", 0.03);
}
`);
  const grants: TaskExtensionRecord[] = [];
  try {
    const result = await runAdapter(
      fixture,
      { policy: policy() },
      (extension) => {
        grants.push(extension);
        writeFileSync(markerPath, "persisted");
      },
    );

    assert.equal(result.exitCode, 0, result.logTail);
    assert.equal(result.failure, undefined);
    assert.deepEqual(result.touchedPaths, ["allowed.ts"]);
    assert.equal(result.extensions?.length, 1);
    assert.equal(grants.length, 1);
    const grant = grants[0]!;
    assert.equal(grant.kind, "budget-continuation");
    if (grant.kind !== "budget-continuation") {
      assert.fail("expected a budget continuation record");
    }
    assert.equal(grant.providerSessionId, result.providerSessionId);
    assert.equal(grant.additionalGuardUsd, 1);
    assert.equal(grant.cumulativeGuardUsd, 2);
    assert.equal(grant.continuationIndex, 1);

    const calls = readArgs(fixture.argsPath);
    assert.equal(calls.length, 2);
    const firstSession = argValue(calls[0]!, "--session-id");
    assert.ok(firstSession);
    assert.equal(argValue(calls[0]!, "--max-budget-usd"), "1");
    assert.equal(argValue(calls[0]!, "--resume"), undefined);
    assert.equal(argValue(calls[1]!, "--resume"), firstSession);
    assert.equal(argValue(calls[1]!, "--session-id"), undefined);
    assert.equal(argValue(calls[1]!, "--max-budget-usd"), "2");

    assert.equal(result.providerSessionId, firstSession);
    assert.equal(result.cost?.state, "cli-estimated");
    assert.equal(result.cost?.authoritative, false);
    assert.equal(result.cost?.amount, 0.05);
    assert.equal(result.cost?.guardBudgetUsd, 2);
    assert.deepEqual(
      result.cost?.observations.map((observation) => observation.sessionId),
      [firstSession, firstSession],
    );
  } finally {
    rmSync(markerPath, { force: true });
    fixture.cleanup();
  }
});

test("no mapped progress before exhaustion denies budget continuation", async () => {
  const fixture = claudeFixture(`
budgetResult(0.01);
assistant("progress after exhaustion does not count");
`);
  const grants: TaskExtensionRecord[] = [];
  try {
    const result = await runAdapter(
      fixture,
      { policy: policy() },
      (extension) => {
        grants.push(extension);
      },
    );
    assert.equal(result.exitCode, 1);
    assert.equal(result.failure?.category, "budget_exhausted");
    assert.equal(result.failure?.code, "error_max_budget_usd");
    assert.equal(grants.length, 0);
    assert.equal(readArgs(fixture.argsPath).length, 1);
  } finally {
    fixture.cleanup();
  }
});

test("wrong provider failures and policy-denied outcomes never continue", async () => {
  const cases = [
    `{
      console.log(JSON.stringify({
        type: "result",
        subtype: "error_max_budget_usd",
        is_error: true,
        result: "401 Unauthorized: invalid api key",
        session_id: sessionId
      }));
    }`,
    `{
      console.log(JSON.stringify({
        type: "result",
        subtype: "error_max_budget_usd",
        is_error: true,
        result: "invalid JSONL response schema",
        session_id: sessionId
      }));
    }`,
    `{
      console.log(JSON.stringify({
        type: "result",
        subtype: "error_max_budget_usd",
        is_error: true,
        result: "policy blocked: task is out of scope",
        session_id: sessionId
      }));
    }`,
    `{
      console.log('{"type":"assistant"');
      assistant("mapped after malformed stream output");
      budgetResult(0.01);
    }`,
    `console.log(JSON.stringify({
      type: "result",
      subtype: "error_max_turns",
      is_error: true,
      result: "maximum turns reached",
      session_id: sessionId
    }));`,
  ];

  for (const body of cases) {
    const fixture = claudeFixture(`
assistant("mapped before the wrong failure");
${body}
`);
    let calls = 0;
    try {
      const result = await runAdapter(
        fixture,
        {
          policy: policy({
            maxContinuations: 1,
            maxCumulativeGuardUsd: 2,
          }),
        },
        () => {
          calls += 1;
        },
      );
      assert.equal(result.exitCode, 1);
      assert.equal(calls, 0, body);
      assert.equal(readArgs(fixture.argsPath).length, 1, body);
    } finally {
      fixture.cleanup();
    }
  }
});

test("autoContinue=false is a denied policy even when a grant callback exists", async () => {
  const fixture = claudeFixture(`
assistant("mapped progress");
budgetResult(0.01);
`);
  let calls = 0;
  try {
    const result = await runAdapter(
      fixture,
      { policy: policy({ autoContinue: false }) },
      () => {
        calls += 1;
      },
    );
    assert.equal(result.failure?.category, "budget_exhausted");
    assert.equal(result.failure?.code, "error_max_budget_usd");
    assert.equal(calls, 0);
    assert.equal(readArgs(fixture.argsPath).length, 1);
  } finally {
    fixture.cleanup();
  }
});

test("a wall-clock timeout outranks a budget subtype and never continues", async () => {
  const fixture = claudeFixture(`
assistant("mapped progress before late budget result");
budgetResult(0.01);
await delay(3000);
successResult("too late");
`);
  let calls = 0;
  try {
    const result = await runAdapter(
      fixture,
      {
        policy: policy(),
        timeoutMs: 1_500,
      },
      () => {
        calls += 1;
      },
    );
    assert.equal(result.exitCode, 1);
    assert.equal(result.failure?.category, "timeout");
    assert.equal(calls, 0);
    assert.equal(readArgs(fixture.argsPath).length, 1);
  } finally {
    fixture.cleanup();
  }
});

test("an outside-write-path change denies continuation before a resumed process", async () => {
  const fixture = claudeFixture(`
assistant("mapped progress");
fs.writeFileSync(path.join(process.cwd(), "outside.txt"), "outside\\n");
budgetResult(0.01);
`);
  let calls = 0;
  try {
    const result = await runAdapter(
      fixture,
      { policy: policy() },
      () => {
        calls += 1;
      },
    );
    assert.equal(result.failure?.category, "budget_exhausted");
    assert.equal(calls, 0);
    assert.equal(readArgs(fixture.argsPath).length, 1);
  } finally {
    fixture.cleanup();
  }
});

test("max continuation count bounds repeated clean exhaustion", async () => {
  const fixture = claudeFixture(`
assistant("mapped progress");
budgetResult(callNumber === 1 ? 0.01 : 0.02);
`);
  const grants: TaskExtensionRecord[] = [];
  try {
    const result = await runAdapter(
      fixture,
      {
        policy: policy({
          maxContinuations: 1,
          maxCumulativeGuardUsd: 2,
        }),
      },
      (extension) => {
        grants.push(extension);
      },
    );
    assert.equal(result.failure?.category, "budget_exhausted");
    assert.equal(result.failure?.code, "error_max_budget_usd");
    assert.equal(grants.length, 1);
    assert.equal(result.extensions?.length, 1);
    assert.equal(readArgs(fixture.argsPath).length, 2);
  } finally {
    fixture.cleanup();
  }
});

test("multiple grants aggregate records, guards and cost observations", async () => {
  const fixture = claudeFixture(`
assistant("mapped progress on call " + callNumber);
budgetResult(0.01);
`);
  const grants: TaskExtensionRecord[] = [];
  try {
    const result = await runAdapter(
      fixture,
      {
        policy: policy({
          maxContinuations: 2,
          maxCumulativeGuardUsd: 3,
        }),
      },
      (extension) => {
        grants.push(extension);
      },
    );
    assert.equal(result.failure?.category, "budget_exhausted");
    assert.equal(grants.length, 2);
    assert.equal(result.extensions?.length, 2);
    assert.equal(result.cost?.observations.length, 3);
    assert.deepEqual(
      result.extensions?.map((extension) =>
        extension.kind === "budget-continuation"
          ? extension.cumulativeGuardUsd
          : undefined,
      ),
      [2, 3],
    );
    const calls = readArgs(fixture.argsPath);
    assert.equal(calls.length, 3);
    assert.deepEqual(
      calls.map((args) => argValue(args, "--max-budget-usd")),
      ["1", "2", "3"],
    );
  } finally {
    fixture.cleanup();
  }
});

test("overshoot reserve prevents a guard with no remaining cumulative room", async () => {
  const fixture = claudeFixture(`
assistant("mapped progress");
budgetResult(0.01);
`);
  const grants: TaskExtensionRecord[] = [];
  try {
    const result = await runAdapter(
      fixture,
      {
        policy: policy({
          maxContinuations: 2,
          maxCumulativeGuardUsd: 2.5,
          overshootReserveUsd: 0.25,
        }),
      },
      (extension) => {
        grants.push(extension);
      },
    );
    assert.equal(result.failure?.category, "budget_exhausted");
    assert.equal(grants.length, 1);
    assert.equal(readArgs(fixture.argsPath).length, 2);
  } finally {
    fixture.cleanup();
  }
});

test("grant persistence failure denies the grant and never starts resume", async () => {
  const fixture = claudeFixture(`
assistant("mapped progress");
if (resume) {
  fs.writeFileSync(path.join(process.cwd(), "must-not-exist.txt"), "bad");
  successResult();
} else {
  budgetResult(0.01);
}
`);
  let calls = 0;
  try {
    const result = await runAdapter(
      fixture,
      { policy: policy() },
      () => {
        calls += 1;
        throw new Error("manifest checkpoint failed");
      },
    );
    assert.equal(calls, 1);
    assert.equal(result.exitCode, 1);
    assert.equal(result.failure?.category, "budget_exhausted");
    assert.equal(result.failure?.code, "error_max_budget_usd");
    assert.equal(result.extensions, undefined);
    assert.equal(readArgs(fixture.argsPath).length, 1);
    assert.equal(existsSync(join(fixture.repo, "must-not-exist.txt")), false);
  } finally {
    fixture.cleanup();
  }
});

test("resume failure consumes the persisted grant but does not create another", async () => {
  const fixture = claudeFixture(`
if (!resume) {
  assistant("mapped progress");
  budgetResult(0.01);
} else {
  process.exit(9);
}
`);
  const grants: TaskExtensionRecord[] = [];
  try {
    const result = await runAdapter(
      fixture,
      {
        policy: policy({
          maxContinuations: 2,
          maxCumulativeGuardUsd: 3,
        }),
      },
      (extension) => {
        grants.push(extension);
      },
    );
    assert.equal(result.exitCode, 1);
    assert.equal(result.failure?.category, "worker_process_exit");
    assert.equal(grants.length, 1);
    assert.equal(result.extensions?.length, 1);
    assert.equal(readArgs(fixture.argsPath).length, 2);
  } finally {
    fixture.cleanup();
  }
});

test("budget continuation defaults stay disabled with zero continuations", async () => {
  assert.equal(DEFAULT_BUDGET_CONTINUATION_POLICY.autoContinue, false);
  assert.equal(DEFAULT_BUDGET_CONTINUATION_POLICY.maxContinuations, 0);
  assert.equal(
    parseBudgetContinuationPolicy(DEFAULT_BUDGET_CONTINUATION_POLICY)
      ?.maxContinuations,
    0,
  );

  const fixture = claudeFixture(`
assistant("mapped progress");
budgetResult(0.01);
`);
  let calls = 0;
  try {
    const result = await runAdapter(fixture, {}, () => {
      calls += 1;
    });
    assert.equal(result.failure?.category, "budget_exhausted");
    assert.equal(result.failure?.code, "error_max_budget_usd");
    assert.equal(calls, 0);
    assert.equal(readArgs(fixture.argsPath).length, 1);
  } finally {
    fixture.cleanup();
  }
});

test("RunManifest round-trips budget evidence and human status exposes it", async () => {
  const repo = initRepo();
  try {
    const task = contract(repo, "budget-manifest");
    const contractsPath = writeContracts(repo, task);
    const extension = budgetRecord();
    const manifest = createRunManifest(repo, {
      planId: "budget-manifest-plan",
      contractsPath,
      baseCommit: task.baseCommit!,
      integrationBranch: "cliyard/integration/budget-manifest",
      tasks: [
        {
          taskId: task.taskId,
          status: "accepted",
          accepted: true,
          extensions: [extension],
        },
      ],
    });
    const loaded = loadRunManifest(repo, manifest.runId);
    assert.deepEqual(loaded.tasks[task.taskId]?.extensions, [extension]);

    const human: string[] = [];
    assert.equal(
      await runSupervisorCli(
        ["status", "--repo", repo, "--run", manifest.runId],
        { log: (line) => human.push(line), signalHandling: false },
      ),
      0,
    );
    assert.match(human.join("\n"), /budget-extensions=1/);
    assert.match(human.join("\n"), /cumulative-guard-usd=2/);

    const path = runManifestPath(repo, manifest.runId);
    const raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, any>;
    raw.tasks[task.taskId].extensions[0].cumulativeGuardUsd = "2";
    writeFileSync(path, `${JSON.stringify(raw, null, 2)}\n`, "utf8");
    assert.throws(
      () => loadRunManifest(repo, manifest.runId),
      /is not a valid budget continuation extension record/,
    );
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("supervisor rejects invalid budget flags before dispatch or lock creation", async () => {
  const repo = initRepo();
  let dispatched = 0;
  try {
    const task = contract(repo);
    const contractsPath = writeContracts(repo, task);
    const run = (args: string[]) =>
      runSupervisorCli(args, {
        log: () => undefined,
        signalHandling: false,
        workerFactory: () => {
          dispatched += 1;
          throw new Error("worker must not dispatch");
        },
      });

    await assert.rejects(
      run([
        "start",
        contractsPath,
        "--repo",
        repo,
        "--auto-continue-budget",
        "--max-budget-continuations",
        "0",
      ]),
      /requires --max-budget-continuations > 0/,
    );
    await assert.rejects(
      run([
        "start",
        contractsPath,
        "--repo",
        repo,
        "--max-budget-usd",
        "1",
        "--max-budget-usd=2",
      ]),
      /--max-budget-usd may be specified only once/,
    );
    await assert.rejects(
      run([
        "start",
        contractsPath,
        "--repo",
        repo,
        "--auto-continue-budget=true",
      ]),
      /--auto-continue-budget does not accept a value/,
    );
    await assert.rejects(
      run([
        "start",
        contractsPath,
        "--repo",
        repo,
        "--max-budget-usd",
        "1",
        "--auto-continue-budget",
        "--continuation-guard-usd",
        "1",
        "--max-budget-continuations",
        "1",
        "--max-cumulative-budget-guard-usd",
        "2",
        "--budget-overshoot-reserve-usd",
        "0.2",
      ]),
      /invalid budget continuation policy/,
    );
    await assert.rejects(
      run([
        "start",
        contractsPath,
        "--repo",
        repo,
        "--worker",
        "codex",
        "--max-budget-usd",
        "1",
      ]),
      /budget continuation flags require --worker claude/,
    );
    assert.equal(dispatched, 0);
    assert.equal(getActiveRunId(repo), undefined);
    assert.doesNotMatch(runGit(repo, ["status", "--short"]), /\.cliyard/);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("supervisor batch persists the budget grant before same-session resume", async () => {
  const repo = initRepo();
  const previousBinary = process.env.CLIYARD_CLAUDE_BINARY;
  const runId = "budget-continuation-run";
  let fixture: ClaudeFixture | undefined;
  try {
    const task = contract(repo, "batch-budget");
    const contractsPath = writeContracts(repo, task);
    const manifestPath = runManifestPath(repo, runId);
    fixture = claudeFixture(`
await delay(20);
if (!resume) {
  assistant("batch progress before exhaustion");
  budgetResult(0.04);
} else {
  const manifest = JSON.parse(
    fs.readFileSync(${JSON.stringify(manifestPath)}, "utf8")
  );
  const extensions = manifest.tasks["batch-budget"].extensions || [];
  if (
    extensions.length !== 1 ||
    extensions[0].kind !== "budget-continuation" ||
    extensions[0].providerSessionId !== sessionId
  ) {
    process.exit(41);
  }
  assistant("batch resumed provider session");
  fs.appendFileSync(
    path.join(process.cwd(), "allowed.ts"),
    "\\nexport const batchResumed = true;\\n"
  );
  successResult("batch resumed complete", 0.06);
}
`, "batch-budget");
    process.env.CLIYARD_CLAUDE_BINARY = fixture.binary;

    const out: string[] = [];
    const code = await runSupervisorCli(
      [
        "start",
        contractsPath,
        "--repo",
        repo,
        "--run-id",
        runId,
        "--worker",
        "claude",
        "--max-budget-usd",
        "1",
        "--auto-continue-budget",
        "--continuation-guard-usd",
        "1",
        "--max-budget-continuations",
        "1",
        "--max-cumulative-budget-guard-usd",
        "2",
        "--budget-overshoot-reserve-usd",
        "0",
      ],
      { log: (line) => out.push(line), signalHandling: false },
    );
    assert.equal(code, 0, out.join("\n"));

    const persisted = loadRunManifest(repo, runId);
    const state = persisted.tasks["batch-budget"]!;
    assert.equal(state.accepted, true);
    assert.equal(state.extensions?.length, 1);
    assert.equal(state.extensions?.[0]?.kind, "budget-continuation");
    assert.equal(state.cost?.amount, 0.1);
    assert.equal(state.cost?.authoritative, false);
    assert.equal(state.cost?.observations.length, 2);

    const calls = readArgs(fixture.argsPath);
    assert.equal(calls.length, 2);
    assert.equal(
      argValue(calls[1]!, "--resume"),
      argValue(calls[0]!, "--session-id"),
    );
    assert.equal(argValue(calls[0]!, "--max-budget-usd"), "1");
    assert.equal(argValue(calls[1]!, "--max-budget-usd"), "2");

    const human: string[] = [];
    assert.equal(
      await runSupervisorCli(
        ["status", "--repo", repo, "--run", runId],
        { log: (line) => human.push(line), signalHandling: false },
      ),
      0,
    );
    assert.match(human.join("\n"), /budget-extensions=1/);
    assert.match(human.join("\n"), /cumulative-guard-usd=2/);

    const json: string[] = [];
    assert.equal(
      await runSupervisorCli(
        ["status", "--repo", repo, "--run", runId, "--json"],
        { log: (line) => json.push(line), signalHandling: false },
      ),
      0,
    );
    const status = JSON.parse(json.join("\n")) as Record<string, any>;
    assert.equal(status.tasks[0].extensions[0].kind, "budget-continuation");
  } finally {
    if (previousBinary === undefined) {
      delete process.env.CLIYARD_CLAUDE_BINARY;
    } else {
      process.env.CLIYARD_CLAUDE_BINARY = previousBinary;
    }
    fixture?.cleanup();
    rmSync(repo, { recursive: true, force: true });
  }
});

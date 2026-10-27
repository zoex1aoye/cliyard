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
  DEFAULT_DEADLINE_EXTENSION_POLICY,
  type DeadlineExtensionPolicy,
  type TaskExtensionRecord,
} from "../src/agents/continuation.js";
import type { AgentResult } from "../src/agents/types.js";
import type { TaskContract } from "../src/contracts/schema.js";
import { runSupervisorCli } from "../src/supervisor/cli.js";
import {
  createRunManifest,
  getActiveRunId,
  loadRunManifest,
  runManifestPath,
} from "../src/supervisor/store.js";

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
  const repo = mkdtempSync(join(tmpdir(), "cliyard-deadline-extension-"));
  runGit(repo, ["init"]);
  runGit(repo, ["config", "user.email", "t@t.com"]);
  runGit(repo, ["config", "user.name", "t"]);
  writeFileSync(join(repo, "allowed.ts"), "export const value = 1;\n");
  runGit(repo, ["add", "."]);
  runGit(repo, ["commit", "-m", "init"]);
  return repo;
}

function contract(repo: string, taskId = "deadline-fixture"): TaskContract {
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

function writeContracts(
  repo: string,
  task: TaskContract,
): string {
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
  taskId = "deadline-fixture",
  withAssistant = true,
): ClaudeFixture {
  const root = mkdtempSync(join(tmpdir(), "cliyard-deadline-bin-"));
  const repo = initRepo();
  const { binary, argsPath } = writeClaudeBinary(
    root,
    body,
    withAssistant,
  );
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

function writeClaudeBinary(
  root: string,
  body: string,
  withAssistant: boolean,
): { binary: string; argsPath: string } {
  const binary = join(root, "fake-claude");
  const argsPath = join(root, "args.txt");
  const runnerPath = join(root, "fake-claude-runner.js");
  writeFileSync(
    runnerPath,
    `
const fs = require("node:fs");
const path = require("node:path");
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
fs.writeFileSync(${JSON.stringify(argsPath)}, process.argv.slice(2).join(" "));
(async () => {
${body}
})();
`,
  );
  const assistant = JSON.stringify({
    type: "assistant",
    message: {
      role: "assistant",
      content: [{ type: "text", text: "working on allowed.ts" }],
    },
  });
  writeFileSync(
    binary,
    `#!/bin/sh
${withAssistant ? `printf '%s\\n' ${shellQuote(assistant)}` : ""}
exec "${process.execPath}" ${shellQuote(runnerPath)} "$@"
`,
  );
  chmodSync(binary, 0o755);
  return {
    binary,
    argsPath,
  };
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function policy(
  overrides: Partial<DeadlineExtensionPolicy> = {},
): DeadlineExtensionPolicy {
  const baseTimeoutMs = overrides.baseTimeoutMs ?? 1_200;
  const extensionStepMs = overrides.extensionStepMs ?? 1_000;
  const maxExtensions = overrides.maxExtensions ?? 1;
  return {
    version: 1,
    baseTimeoutMs,
    extensionStepMs,
    maxExtensions,
    maxTotalTimeoutMs:
      overrides.maxTotalTimeoutMs ??
      baseTimeoutMs + extensionStepMs * maxExtensions,
    healthyActivityWindowMs: overrides.healthyActivityWindowMs ?? 2_000,
    autoExtend: overrides.autoExtend ?? true,
  };
}

async function runFixture(
  fixture: ClaudeFixture,
  deadlinePolicy: DeadlineExtensionPolicy,
  onExtension?: (
    extension: TaskExtensionRecord,
  ) => void | Promise<void>,
): Promise<AgentResult> {
  const worker = createClaudeAdapter({
    binary: fixture.binary,
    cwd: fixture.repo,
    model: "fixture-model",
    maxBudgetUsd: 3,
    maxTransientRetries: 0,
    heartbeatMs: 30,
    deadlinePolicy,
  });
  const { sessionId } = await worker.start({
    contract: fixture.contract,
    attempt: 0,
    ...(onExtension ? { onExtension } : {}),
  });
  return worker.collect(sessionId);
}

function resultLine(result = "fixture complete"): string {
  return `console.log(JSON.stringify({
  type: "result",
  subtype: "success",
  is_error: false,
  result: ${JSON.stringify(result)}
}));`;
}

function assistantLine(text = "mapped fixture progress"): string {
  return `console.log(JSON.stringify({
  type: "assistant",
  message: {
    role: "assistant",
    content: [{ type: "text", text: ${JSON.stringify(text)} }]
  }
}));`;
}

function extensionRecord(
  overrides: Partial<TaskExtensionRecord> = {},
): TaskExtensionRecord {
  return {
    version: 1,
    extensionId: "extension-1",
    attempt: 0,
    kind: "deadline",
    source: "auto",
    requestedAt: "2026-10-28T00:00:01.000Z",
    grantedAt: "2026-10-28T00:00:01.000Z",
    reason: "fixture healthy activity",
    healthyEvidence: ["assistant@2026-10-28T00:00:00.900Z"],
    providerSessionId: "provider-session-1",
    extensionMs: 300,
    cumulativeTimeoutMs: 420,
    ...overrides,
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

test("healthy mapped activity persists one exact grant before extending", async () => {
  const fixture = claudeFixture(`
await delay(700);
${assistantLine("healthy fixture progress")}
await delay(1000);
fs.appendFileSync(path.join(process.cwd(), "allowed.ts"), "\\nexport const extended = true;\\n");
${resultLine()}
`);
  const grants: TaskExtensionRecord[] = [];
  try {
    const result = await runFixture(
      fixture,
      policy({ baseTimeoutMs: 1_200, extensionStepMs: 1_000 }),
      (extension) => {
        grants.push(extension);
      },
    );
    assert.equal(
      result.exitCode,
      0,
      `${result.logTail}\nfailure=${JSON.stringify(result.failure)}\n` +
        `extensions=${JSON.stringify(result.extensions)}`,
    );
    assert.equal(result.failure, undefined);
    assert.deepEqual(result.touchedPaths, ["allowed.ts"]);
    assert.equal(grants.length, 1);
    assert.equal(result.extensions?.length, 1);
    assert.deepEqual(result.extensions, grants);
    const extension = grants[0]!;
    assert.equal(extension.version, 1);
    assert.equal(extension.kind, "deadline");
    assert.equal(extension.source, "auto");
    assert.equal(extension.attempt, 0);
    assert.equal(extension.extensionMs, 1000);
    assert.equal(extension.cumulativeTimeoutMs, 2200);
    assert.equal(extension.healthyEvidence.length, 1);
    assert.match(extension.healthyEvidence[0]!, /^assistant@/);
    assert.ok(extension.providerSessionId);
    assert.ok(!Number.isNaN(Date.parse(extension.requestedAt)));
    assert.ok(!Number.isNaN(Date.parse(extension.grantedAt)));

    const args = readFileSync(fixture.argsPath, "utf8");
    assert.match(args, /--max-budget-usd 3/);
  } finally {
    fixture.cleanup();
  }
});

test("thinking-token and heartbeat traffic alone cannot extend a stale deadline", async () => {
  const fixture = claudeFixture(`
console.log(JSON.stringify({ type: "system", subtype: "init" }));
for (let i = 0; i < 20; i += 1) {
  await delay(20);
  console.log(JSON.stringify({
    type: "system",
    subtype: "thinking_tokens",
    thinking_tokens: { text: "not mapped to task progress" }
  }));
}
await delay(2000);
${resultLine("too late")}
`, "deadline-fixture", false);
  const grants: TaskExtensionRecord[] = [];
  try {
    const result = await runFixture(
      fixture,
      policy({
        baseTimeoutMs: 1_200,
        extensionStepMs: 1_000,
        healthyActivityWindowMs: 50,
      }),
      (extension) => {
        grants.push(extension);
      },
    );

    assert.equal(result.exitCode, 1);
    assert.equal(result.failure?.category, "timeout");
    assert.equal(result.extensions, undefined);
    assert.equal(grants.length, 0);
  } finally {
    fixture.cleanup();
  }
});

test("an unresolved provider error storm denies extension", async () => {
  const fixture = claudeFixture(`
for (let i = 0; i < 6; i += 1) {
  await delay(20);
  console.log(JSON.stringify({
    type: "error",
    error: { message: "retry storm fixture " + i }
  }));
}
await delay(1000);
${resultLine("unreachable success")}
`);
  const grants: TaskExtensionRecord[] = [];
  try {
    const result = await runFixture(
      fixture,
      policy({ baseTimeoutMs: 1_200, extensionStepMs: 1_000 }),
      (extension) => {
        grants.push(extension);
      },
    );

    assert.equal(result.exitCode, 1);
    assert.equal(result.failure?.category, "timeout");
    assert.equal(result.extensions, undefined);
    assert.equal(grants.length, 0);
  } finally {
    fixture.cleanup();
  }
});

test("maxExtensions bounds repeated healthy grants", async () => {
  const fixture = claudeFixture(`
await delay(1000);
${assistantLine("max-extension fixture progress")}
await delay(1500);
${resultLine("unreachable success")}
`);
  const grants: TaskExtensionRecord[] = [];
  try {
    const result = await runFixture(
      fixture,
      policy({
        baseTimeoutMs: 1_200,
        extensionStepMs: 400,
        maxExtensions: 1,
        maxTotalTimeoutMs: 1_600,
      }),
      (extension) => {
        grants.push(extension);
      },
    );

    assert.equal(result.exitCode, 1);
    assert.equal(result.failure?.category, "timeout");
    assert.equal(grants.length, 1);
    assert.equal(result.extensions?.length, 1);
    assert.equal(result.extensions?.[0]?.cumulativeTimeoutMs, 1600);
  } finally {
    fixture.cleanup();
  }
});

test("maxTotalTimeoutMs bounds cumulative healthy grants", async () => {
  const fixture = claudeFixture(`
await delay(1000);
${assistantLine("max-total fixture progress")}
await delay(1500);
${resultLine("unreachable success")}
`);
  const grants: TaskExtensionRecord[] = [];
  try {
    const result = await runFixture(
      fixture,
      policy({
        baseTimeoutMs: 1_200,
        extensionStepMs: 200,
        maxExtensions: 5,
        maxTotalTimeoutMs: 1_600,
      }),
      (extension) => {
        grants.push(extension);
      },
    );

    assert.equal(result.exitCode, 1);
    assert.equal(result.failure?.category, "timeout");
    assert.equal(grants.length, 2);
    assert.deepEqual(
      grants.map((item) => item.cumulativeTimeoutMs),
      [1400, 1600],
    );
    assert.equal(result.extensions?.length, 2);
  } finally {
    fixture.cleanup();
  }
});

test("the same child timer is re-armed only after async persistence resolves", async () => {
  const fixture = claudeFixture(`
await delay(1000);
${assistantLine("persistence fixture progress")}
await delay(700);
fs.appendFileSync(path.join(process.cwd(), "allowed.ts"), "\\nexport const persistedFirst = true;\\n");
${resultLine()}
`);
  const grants: TaskExtensionRecord[] = [];
  let callbackFinishedAt = 0;
  try {
    const result = await runFixture(
      fixture,
      policy({
        baseTimeoutMs: 1_200,
        extensionStepMs: 1_500,
        maxTotalTimeoutMs: 2_700,
      }),
      async (extension) => {
        grants.push(extension);
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 400));
        callbackFinishedAt = Date.now();
      },
    );

    assert.equal(
      result.exitCode,
      0,
      `${result.logTail}\nfailure=${JSON.stringify(result.failure)}\n` +
        `extensions=${JSON.stringify(result.extensions)}`,
    );
    assert.equal(result.failure, undefined);
    assert.equal(grants.length, 1);
    // A timer armed before persistence would have fired at ~1600ms and killed
    // this child before its ~1800ms result.
    assert.ok(callbackFinishedAt > 0);
  } finally {
    fixture.cleanup();
  }
});

test("collect waits for an in-flight grant checkpoint past child exit", async () => {
  const childMarkerRoot = mkdtempSync(
    join(tmpdir(), "cliyard-deadline-child-marker-"),
  );
  const childFinishedPath = join(childMarkerRoot, "finished");
  const fixture = claudeFixture(`
await delay(900);
fs.writeFileSync(${JSON.stringify(childFinishedPath)}, "finished");
${resultLine("finished while checkpoint was pending")}
`);
  let releasePersistence: (() => void) | undefined;
  const persistence = new Promise<void>((resolvePromise) => {
    releasePersistence = resolvePromise;
  });
  let callbackStarted = false;
  let collection: Promise<AgentResult> | undefined;
  try {
    collection = runFixture(
      fixture,
      policy({
        baseTimeoutMs: 600,
        extensionStepMs: 2_000,
        maxTotalTimeoutMs: 2_600,
        healthyActivityWindowMs: 2_000,
      }),
      async (extension) => {
        assert.equal(extension.cumulativeTimeoutMs, 2_600);
        callbackStarted = true;
        await persistence;
      },
    );

    const callbackDeadline = Date.now() + 2_000;
    while (!callbackStarted && Date.now() < callbackDeadline) {
      await delay(10);
    }
    assert.equal(callbackStarted, true);

    const childDeadline = Date.now() + 2_500;
    while (!existsSync(childFinishedPath) && Date.now() < childDeadline) {
      await delay(10);
    }
    assert.equal(existsSync(childFinishedPath), true);
    await delay(50);
    const finishedEarly = await Promise.race([
      collection.then(() => true),
      delay(20).then(() => false),
    ]);
    assert.equal(finishedEarly, false);

    releasePersistence!();
    const result = await collection;
    assert.equal(result.exitCode, 0, result.logTail);
    assert.equal(result.extensions?.length, 1);
    assert.equal(
      result.extensions?.[0]?.cumulativeTimeoutMs,
      2_600,
    );
  } finally {
    releasePersistence?.();
    await collection?.catch(() => undefined);
    fixture.cleanup();
    rmSync(childMarkerRoot, { recursive: true, force: true });
  }
});

test("a rejected persistence callback denies the grant", async () => {
  const fixture = claudeFixture(`
await delay(2500);
${resultLine("unreachable success")}
`);
  let callbackCalls = 0;
  try {
    const result = await runFixture(
      fixture,
      policy({ baseTimeoutMs: 1_200, extensionStepMs: 1_000 }),
      async () => {
        callbackCalls += 1;
        throw new Error("manifest checkpoint failed");
      },
    );

    assert.equal(callbackCalls, 1);
    assert.equal(result.exitCode, 1);
    assert.equal(result.failure?.category, "timeout");
    assert.equal(result.extensions, undefined);
  } finally {
    fixture.cleanup();
  }
});

test("the default policy remains disabled even when a callback exists", async () => {
  const fixture = claudeFixture(`
await delay(1600);
${resultLine("too late")}
`);
  let callbackCalls = 0;
  try {
    const defaultOff = {
      ...DEFAULT_DEADLINE_EXTENSION_POLICY,
      baseTimeoutMs: 1_200,
      maxTotalTimeoutMs: 1_200,
      healthyActivityWindowMs: 2_000,
    };
    assert.equal(defaultOff.autoExtend, false);
    assert.equal(defaultOff.maxExtensions, 0);
    const result = await runFixture(fixture, defaultOff, () => {
      callbackCalls += 1;
    });

    assert.equal(callbackCalls, 0);
    assert.equal(result.exitCode, 1);
    assert.equal(result.failure?.category, "timeout");
    assert.equal(result.extensions, undefined);
  } finally {
    fixture.cleanup();
  }
});

test("RunManifest round-trips deadline evidence and rejects malformed evidence", () => {
  const repo = initRepo();
  try {
    const task = contract(repo, "manifest-extension");
    const contractsPath = writeContracts(repo, task);
    const extension = extensionRecord();
    const manifest = createRunManifest(repo, {
      planId: "deadline-manifest",
      contractsPath,
      baseCommit: task.baseCommit!,
      integrationBranch: "cliyard/integration/deadline-manifest",
      tasks: [
        {
          taskId: task.taskId,
          status: "accepted",
          accepted: true,
          extensions: [extension],
        },
        {
          taskId: "legacy-without-extensions",
          status: "ready",
          accepted: false,
        },
      ],
    });

    const loaded = loadRunManifest(repo, manifest.runId);
    assert.deepEqual(loaded.tasks[task.taskId]?.extensions, [extension]);
    assert.equal(
      loaded.tasks["legacy-without-extensions"]?.extensions,
      undefined,
    );

    const manifestPath = runManifestPath(repo, manifest.runId);
    const raw = JSON.parse(readFileSync(manifestPath, "utf8")) as Record<
      string,
      any
    >;
    raw.tasks[task.taskId].extensions[0].healthyEvidence = [
      { type: "assistant" },
    ];
    writeFileSync(manifestPath, `${JSON.stringify(raw, null, 2)}\n`, "utf8");
    assert.throws(
      () => loadRunManifest(repo, manifest.runId),
      /extensions\[0\] is not a valid deadline extension record/,
    );
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("supervisor start/resume reject invalid deadline policies before dispatch", async () => {
  const repo = initRepo();
  let dispatched = 0;
  try {
    const task = contract(repo);
    const contractsPath = writeContracts(repo, task);
    await assert.rejects(
      runSupervisorCli(
        [
          "start",
          contractsPath,
          "--repo",
          repo,
          "--auto-extend-deadline",
          "--max-deadline-extensions",
          "0",
        ],
        {
          log: () => undefined,
          signalHandling: false,
          workerFactory: () => {
            dispatched += 1;
            throw new Error("worker must not dispatch");
          },
        },
      ),
      /requires --max-deadline-extensions > 0/,
    );
    assert.equal(dispatched, 0);
    assert.equal(getActiveRunId(repo), undefined);
    assert.doesNotMatch(runGit(repo, ["status", "--short"]), /\.cliyard/);

    await assert.rejects(
      runSupervisorCli(
        [
          "start",
          contractsPath,
          "--repo",
          repo,
          "--timeout-ms",
          "1200",
          "--timeout-ms=1300",
        ],
        {
          log: () => undefined,
          signalHandling: false,
          workerFactory: () => {
            dispatched += 1;
            throw new Error("worker must not dispatch");
          },
        },
      ),
      /--timeout-ms may be specified only once/,
    );
    await assert.rejects(
      runSupervisorCli(
        [
          "start",
          contractsPath,
          "--repo",
          repo,
          "--auto-extend-deadline=true",
        ],
        {
          log: () => undefined,
          signalHandling: false,
          workerFactory: () => {
            dispatched += 1;
            throw new Error("worker must not dispatch");
          },
        },
      ),
      /--auto-extend-deadline does not accept a value/,
    );
    assert.equal(dispatched, 0);

    await assert.rejects(
      runSupervisorCli(
        [
          "resume",
          "--repo",
          repo,
          "--timeout-ms",
          "100",
          "--deadline-extension-ms",
          "100",
          "--max-deadline-extensions",
          "1",
          "--max-total-timeout-ms",
          "150",
        ],
        { log: () => undefined, signalHandling: false },
      ),
      /cannot fit within maxTotalTimeoutMs/,
    );
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("batch checkpoint precedes worker completion and status exposes extensions", async () => {
  const repo = initRepo();
  const binRoot = mkdtempSync(join(tmpdir(), "cliyard-deadline-batch-bin-"));
  const previousBinary = process.env.CLIYARD_CLAUDE_BINARY;
  const runId = "deadline-batch-run";
  const markerPath = join(binRoot, "manifest-at-result.json");
  try {
    const task = contract(repo, "batch-deadline");
    const contractsPath = writeContracts(repo, task);
    const manifestPath = runManifestPath(repo, runId);
    const { binary } = writeClaudeBinary(
      binRoot,
      `
  await delay(1000);
  ${assistantLine("batch extension progress")}
  await delay(500);
  fs.appendFileSync(
    path.join(process.cwd(), "allowed.ts"),
    "\\nexport const batchExtended = true;\\n"
  );
  const manifest = JSON.parse(fs.readFileSync(${JSON.stringify(manifestPath)}, "utf8"));
  fs.writeFileSync(
    ${JSON.stringify(markerPath)},
    JSON.stringify(manifest.tasks["batch-deadline"].extensions)
  );
${resultLine("batch fixture complete")}
`,
      true,
    );
    process.env.CLIYARD_CLAUDE_BINARY = binary;

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
        "--timeout-ms",
        "1200",
        "--auto-extend-deadline",
        "--deadline-extension-ms",
        "3000",
        "--max-deadline-extensions",
        "1",
        "--max-total-timeout-ms",
        "4200",
        "--healthy-activity-window-ms",
        "3000",
      ],
      { log: (line) => out.push(line), signalHandling: false },
    );
    assert.equal(code, 0, out.join("\n"));

    const persisted = loadRunManifest(repo, runId);
    const taskState = persisted.tasks["batch-deadline"]!;
    assert.equal(taskState.accepted, true);
    assert.equal(taskState.extensions?.length, 1);
    assert.equal(taskState.extensions?.[0]?.attempt, 0);
    assert.equal(taskState.extensions?.[0]?.extensionMs, 3000);
    assert.equal(taskState.extensions?.[0]?.cumulativeTimeoutMs, 4200);

    assert.ok(existsSync(markerPath));
    const atResult = JSON.parse(
      readFileSync(markerPath, "utf8"),
    ) as TaskExtensionRecord[];
    assert.equal(atResult.length, 1);
    assert.equal(atResult[0]?.extensionId, taskState.extensions?.[0]?.extensionId);

    const statusJson: string[] = [];
    assert.equal(
      await runSupervisorCli(
        ["status", "--repo", repo, "--run", runId, "--json"],
        { log: (line) => statusJson.push(line), signalHandling: false },
      ),
      0,
    );
    const status = JSON.parse(statusJson.join("\n")) as Record<string, any>;
    assert.equal(status.tasks[0].extensions.length, 1);

    const statusHuman: string[] = [];
    assert.equal(
      await runSupervisorCli(
        ["status", "--repo", repo, "--run", runId],
        { log: (line) => statusHuman.push(line), signalHandling: false },
      ),
      0,
    );
    const human = statusHuman.join("\n");
    assert.match(human, /extensions=1/);
    assert.match(human, /last deadline extension=.* \+3000ms cumulative=4200ms/);
  } finally {
    if (previousBinary === undefined) {
      delete process.env.CLIYARD_CLAUDE_BINARY;
    } else {
      process.env.CLIYARD_CLAUDE_BINARY = previousBinary;
    }
    rmSync(binRoot, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  }
});

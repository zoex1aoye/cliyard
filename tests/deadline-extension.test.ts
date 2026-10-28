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

type AssistantActivity = "none" | "once" | "continuous";

interface ClaudeBinaryOptions {
  /**
   * Mapped assistant activity:
   * - `none`: no mapped event (denial by missing mapped evidence);
   * - `once`: one record immediately before the node runner starts;
   * - `continuous`: a shell-level stream from process start until the fixture
   *   leader exits, so evidence freshness never depends on Node startup.
   */
  assistant?: AssistantActivity;
  /** Emit one unmapped thinking-token record before the node runner starts. */
  thinkingPrelude?: boolean;
  /** Emit one unresolved provider error before the node runner starts. */
  errorPrelude?: boolean;
}

function claudeFixture(
  body: string,
  taskId = "deadline-fixture",
  options: ClaudeBinaryOptions = {},
): ClaudeFixture {
  const root = mkdtempSync(join(tmpdir(), "cliyard-deadline-bin-"));
  const repo = initRepo();
  const { binary, argsPath } = writeClaudeBinary(root, body, options);
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
  options: ClaudeBinaryOptions = {},
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
// Marker waits are bounded so a lost fixture signal becomes a visible test
// failure instead of an indefinitely open child process.
const waitForPath = async (file, timeoutMs = 10_000) => {
  const until = Date.now() + timeoutMs;
  while (!fs.existsSync(file)) {
    if (Date.now() >= until) return false;
    await delay(10);
  }
  return true;
};
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
  const thinking = JSON.stringify({
    type: "system",
    subtype: "thinking_tokens",
    thinking_tokens: { text: "not mapped to task progress" },
  });
  const providerError = JSON.stringify({
    type: "error",
    error: { message: "fixture provider error" },
  });
  const activity = options.assistant ?? "once";
  /**
   * The shell starts before the Node runner, so a continuous stream keeps
   * mapped progress fresh through Node startup under suite-wide load. `$$` is
   * the process-group leader (this shell, then the exec'd runner); the stream
   * exits when the leader does, which lets the adapter observe close promptly.
   */
  const stream =
    activity === "continuous"
      ? `(
  while kill -0 $$ 2>/dev/null; do
    printf '%s\\n' ${shellQuote(assistant)}
    sleep 0.05
  done
) &
`
      : "";
  const prelude = [
    activity === "none" ? "" : `printf '%s\\n' ${shellQuote(assistant)}`,
    options.thinkingPrelude
      ? `printf '%s\\n' ${shellQuote(thinking)}`
      : "",
    options.errorPrelude
      ? `printf '%s\\n' ${shellQuote(providerError)}`
      : "",
  ]
    .filter(Boolean)
    .join("\n");
  writeFileSync(
    binary,
    `#!/bin/sh
${stream}${prelude}${prelude ? "\n" : ""}exec "${process.execPath}" ${shellQuote(runnerPath)} "$@"
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

/**
 * Diagnostic bounds for event-driven fixture waits. These only decide how a
 * lost callback or a child that never exits is reported; they are never the
 * schedule under test, so they can be several times longer than the policy
 * timers without extending a passing run.
 */
const DIAGNOSTIC_WAIT_MS = 10_000;

function withDiagnosticDeadline<T>(
  label: string,
  signal: Promise<T>,
  timeoutMs = DIAGNOSTIC_WAIT_MS,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const expired = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`timed out after ${timeoutMs}ms waiting for ${label}`));
    }, timeoutMs);
  });
  return Promise.race([signal, expired]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

async function waitForCondition(
  label: string,
  predicate: () => boolean,
  timeoutMs = DIAGNOSTIC_WAIT_MS,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      assert.fail(`timed out after ${timeoutMs}ms waiting for ${label}`);
    }
    await delay(10);
  }
}

/** The child records its own pid; `exec` keeps the spawned pid stable. */
function readPid(path: string): number | undefined {
  try {
    const pid = Number.parseInt(readFileSync(path, "utf8").trim(), 10);
    return Number.isInteger(pid) && pid > 0 ? pid : undefined;
  } catch {
    return undefined;
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Successful-extension fixtures use a shell-level continuous assistant stream
 * and a grant-callback marker. The base deadline is only a startup margin (the
 * shell streams from process start, before Node boots), so it can stay short;
 * the extension step is a re-arm/completion margin and, when no test waits for
 * the following deadline, does not lengthen a passing run. The exact policy
 * values, cumulative bound and re-arm ordering remain the assertions under
 * test.
 */
test("healthy mapped activity persists one exact grant before extending", async () => {
  const markerRoot = mkdtempSync(
    join(tmpdir(), "cliyard-deadline-grant-marker-"),
  );
  const grantMarkerPath = join(markerRoot, "granted");
  const fixture = claudeFixture(
    `
await waitForPath(${JSON.stringify(grantMarkerPath)});
fs.appendFileSync(path.join(process.cwd(), "allowed.ts"), "\\nexport const extended = true;\\n");
${resultLine()}
`,
    "deadline-fixture",
    { assistant: "continuous" },
  );
  const grants: TaskExtensionRecord[] = [];
  try {
    const result = await runFixture(
      fixture,
      policy({
        baseTimeoutMs: 2_000,
        extensionStepMs: 3_000,
        healthyActivityWindowMs: 10_000,
      }),
      (extension) => {
        grants.push(extension);
        // The exact record was checkpointed; only now may the child finish.
        writeFileSync(grantMarkerPath, "granted");
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
    assert.equal(extension.extensionMs, 3000);
    assert.equal(extension.cumulativeTimeoutMs, 5000);
    assert.equal(extension.healthyEvidence.length, 1);
    assert.match(extension.healthyEvidence[0]!, /^assistant@/);
    assert.ok(extension.providerSessionId);
    assert.ok(!Number.isNaN(Date.parse(extension.requestedAt)));
    assert.ok(!Number.isNaN(Date.parse(extension.grantedAt)));

    const args = readFileSync(fixture.argsPath, "utf8");
    assert.match(args, /--max-budget-usd 3/);
  } finally {
    fixture.cleanup();
    rmSync(markerRoot, { recursive: true, force: true });
  }
});

test("a result after the extended deadline still loses to timeout", async () => {
  const markerRoot = mkdtempSync(
    join(tmpdir(), "cliyard-deadline-late-marker-"),
  );
  const grantMarkerPath = join(markerRoot, "granted");
  const fixture = claudeFixture(
    `
await waitForPath(${JSON.stringify(grantMarkerPath)});
// The grant moves the deadline to base + step. Schedule the result after
// that extended deadline and keep the child alive afterwards: even if the
// host delays the deadline timer, the adapter must see a live child and a
// result observed after the deadline, never a queued close that lets the
// late result win.
await delay(1_500);
fs.appendFileSync(path.join(process.cwd(), "allowed.ts"), "\\nexport const tooLate = true;\\n");
${resultLine("too late")}
await delay(2_000);
`,
    "deadline-fixture",
    { assistant: "continuous" },
  );
  const grants: TaskExtensionRecord[] = [];
  try {
    const result = await runFixture(
      fixture,
      policy({
        baseTimeoutMs: 2_500,
        extensionStepMs: 1_200,
        healthyActivityWindowMs: 10_000,
      }),
      (extension) => {
        grants.push(extension);
        writeFileSync(grantMarkerPath, "granted");
      },
    );

    assert.equal(result.exitCode, 1);
    assert.equal(result.failure?.category, "timeout");
    assert.match(result.failure?.message ?? "", /timed out after 3700ms/);
    assert.equal(grants.length, 1);
    assert.equal(result.extensions?.length, 1);
    assert.deepEqual(result.extensions, grants);
    assert.equal(result.extensions?.[0]?.cumulativeTimeoutMs, 3700);
  } finally {
    fixture.cleanup();
    rmSync(markerRoot, { recursive: true, force: true });
  }
});

test("thinking-token and heartbeat traffic alone cannot extend a stale deadline", async () => {
  // No mapped assistant is emitted by design: unmapped traffic must never
  // qualify. The shell prelude proves the traffic exists before Node boots.
  const fixture = claudeFixture(
    `
console.log(JSON.stringify({ type: "system", subtype: "init" }));
for (let i = 0; i < 20; i += 1) {
  await delay(20);
  console.log(JSON.stringify({
    type: "system",
    subtype: "thinking_tokens",
    thinking_tokens: { text: "not mapped to task progress" }
  }));
}
// Outlive the deadline by a wide bound so a lost kill cannot let this
// fixture's late success result win; only missing mapped evidence denies.
await delay(10_000);
${resultLine("too late")}
`,
    "deadline-fixture",
    { assistant: "none", thinkingPrelude: true },
  );
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
  // The prelude emits one mapped record and then an unresolved error before
  // Node startup. The mapped record is still inside the healthy window at the
  // deadline, so denial is caused by the unresolved error, not missing
  // evidence or slow child startup.
  const fixture = claudeFixture(
    `
for (let i = 0; i < 6; i += 1) {
  await delay(20);
  console.log(JSON.stringify({
    type: "error",
    error: { message: "retry storm fixture " + i }
  }));
}
// Outlive the deadline by a wide bound so the unresolved error, not a child
// that finished early, is the reason no grant is made; the unreachable
// success result stays below the diagnostic bound if the kill is lost.
await delay(10_000);
${resultLine("unreachable success")}
`,
    "deadline-fixture",
    { assistant: "once", errorPrelude: true },
  );
  const grants: TaskExtensionRecord[] = [];
  try {
    const result = await runFixture(
      fixture,
      policy({
        baseTimeoutMs: 2_500,
        extensionStepMs: 1_000,
        healthyActivityWindowMs: 10_000,
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

test("maxExtensions bounds repeated healthy grants", async () => {
  const fixture = claudeFixture(
    `
await delay(10_000);
${resultLine("unreachable success")}
`,
    "deadline-fixture",
    { assistant: "continuous" },
  );
  const grants: TaskExtensionRecord[] = [];
  try {
    const result = await runFixture(
      fixture,
      policy({
        baseTimeoutMs: 1_500,
        extensionStepMs: 600,
        maxExtensions: 1,
        maxTotalTimeoutMs: 2_100,
        healthyActivityWindowMs: 10_000,
      }),
      (extension) => {
        grants.push(extension);
      },
    );

    assert.equal(result.exitCode, 1);
    assert.equal(result.failure?.category, "timeout");
    assert.equal(grants.length, 1);
    assert.equal(result.extensions?.length, 1);
    assert.equal(result.extensions?.[0]?.cumulativeTimeoutMs, 2100);
  } finally {
    fixture.cleanup();
  }
});

test("maxTotalTimeoutMs bounds cumulative healthy grants", async () => {
  const fixture = claudeFixture(
    `
await delay(10_000);
${resultLine("unreachable success")}
`,
    "deadline-fixture",
    { assistant: "continuous" },
  );
  const grants: TaskExtensionRecord[] = [];
  try {
    const result = await runFixture(
      fixture,
      policy({
        baseTimeoutMs: 1_500,
        extensionStepMs: 800,
        maxExtensions: 5,
        maxTotalTimeoutMs: 3_100,
        healthyActivityWindowMs: 10_000,
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
      [2300, 3100],
    );
    assert.equal(result.extensions?.length, 2);
  } finally {
    fixture.cleanup();
  }
});

test("the same child timer is re-armed only after async persistence resolves", async () => {
  const markerRoot = mkdtempSync(
    join(tmpdir(), "cliyard-deadline-persistence-"),
  );
  const persistedMarkerPath = join(markerRoot, "persisted");
  const fixture = claudeFixture(
    `
await waitForPath(${JSON.stringify(persistedMarkerPath)});
fs.appendFileSync(path.join(process.cwd(), "allowed.ts"), "\\nexport const persistedFirst = true;\\n");
${resultLine()}
`,
    "deadline-fixture",
    { assistant: "continuous" },
  );
  const grants: TaskExtensionRecord[] = [];
  let callbackFinishedAt = 0;
  let signalCallbackStarted: (() => void) | undefined;
  const callbackStarted = new Promise<void>((resolvePromise) => {
    signalCallbackStarted = resolvePromise;
  });
  let releasePersistence: (() => void) | undefined;
  const persistence = new Promise<void>((resolvePromise) => {
    releasePersistence = resolvePromise;
  });
  let collection: Promise<AgentResult> | undefined;
  try {
    collection = runFixture(
      fixture,
      policy({
        baseTimeoutMs: 1_500,
        extensionStepMs: 2_500,
        healthyActivityWindowMs: 10_000,
      }),
      async (extension) => {
        grants.push(extension);
        signalCallbackStarted!();
        await persistence;
        callbackFinishedAt = Date.now();
        // The child only finishes after persistence resolves; a timer armed
        // before this point would kill it while collect is still pending.
        writeFileSync(persistedMarkerPath, "persisted");
      },
    );
    const collectionSettled = collection.then(
      () => true,
      () => true,
    );

    await withDiagnosticDeadline(
      "extension callback start",
      callbackStarted,
    );
    assert.equal(grants.length, 1);
    assert.equal(grants[0]!.cumulativeTimeoutMs, 4_000);

    const finishedEarly = await Promise.race([
      collectionSettled,
      delay(400).then(() => false),
    ]);
    assert.equal(
      finishedEarly,
      false,
      "collect resolved while grant persistence was unresolved",
    );

    releasePersistence!();
    const result = await collection;
    assert.equal(
      result.exitCode,
      0,
      `${result.logTail}\nfailure=${JSON.stringify(result.failure)}\n` +
        `extensions=${JSON.stringify(result.extensions)}`,
    );
    assert.equal(result.failure, undefined);
    assert.equal(grants.length, 1);
    assert.ok(callbackFinishedAt > 0);
    assert.ok(Date.parse(grants[0]!.grantedAt) <= callbackFinishedAt);
    assert.deepEqual(result.extensions, grants);
  } finally {
    releasePersistence?.();
    await collection?.catch(() => undefined);
    fixture.cleanup();
    rmSync(markerRoot, { recursive: true, force: true });
  }
});

/**
 * The grant callback is the readiness signal; no fixed child schedule is
 * assumed. The shell-level stream keeps mapped activity fresh from process
 * start, so a host-delayed deadline timer still finds healthy evidence. The
 * child cannot exit before the grant callback has started, so the only exit
 * observed here happens with persistence still in flight.
 */
test("collect waits for an in-flight grant checkpoint past child exit", async () => {
  const markerRoot = mkdtempSync(
    join(tmpdir(), "cliyard-deadline-inflight-"),
  );
  const grantMarkerPath = join(markerRoot, "granted");
  const childFinishedPath = join(markerRoot, "finished");
  const pidPath = join(markerRoot, "pid");
  const fixture = claudeFixture(
    `
fs.writeFileSync(${JSON.stringify(pidPath)}, String(process.pid));
await waitForPath(${JSON.stringify(grantMarkerPath)});
fs.writeFileSync(${JSON.stringify(childFinishedPath)}, "finished");
${resultLine("finished while checkpoint was pending")}
`,
    "deadline-fixture",
    { assistant: "continuous" },
  );
  let releasePersistence: (() => void) | undefined;
  const persistence = new Promise<void>((resolvePromise) => {
    releasePersistence = resolvePromise;
  });
  let signalCallbackStarted: (() => void) | undefined;
  const callbackStarted = new Promise<void>((resolvePromise) => {
    signalCallbackStarted = resolvePromise;
  });
  const grants: TaskExtensionRecord[] = [];
  let collection: Promise<AgentResult> | undefined;
  try {
    collection = runFixture(
      fixture,
      policy({
        baseTimeoutMs: 1_500,
        extensionStepMs: 2_500,
        healthyActivityWindowMs: 10_000,
      }),
      async (extension) => {
        grants.push(extension);
        // The grant is observable but not yet persisted, exactly like the
        // production checkpoint this test holds in flight.
        signalCallbackStarted!();
        writeFileSync(grantMarkerPath, "granted");
        await persistence;
      },
    );
    const collectionSettled = collection.then(
      () => true,
      () => true,
    );

    await withDiagnosticDeadline(
      "extension callback start",
      callbackStarted,
    );
    assert.equal(grants.length, 1);
    assert.equal(grants[0]!.cumulativeTimeoutMs, 4_000);

    await waitForCondition(
      "fixture child pid",
      () => readPid(pidPath) !== undefined,
    );
    const childPid = readPid(pidPath)!;
    await waitForCondition(
      "fixture child exit while grant persistence is held",
      () => !isProcessAlive(childPid),
    );
    assert.equal(existsSync(childFinishedPath), true);

    // The child is gone; give the close path a bounded turn to run while the
    // persistence gate is still unresolved. A premature resolution would
    // surface here, and a correct adapter stays pending.
    const finishedEarly = await Promise.race([
      collectionSettled,
      delay(250).then(() => false),
    ]);
    assert.equal(
      finishedEarly,
      false,
      "collect resolved before the in-flight grant was persisted",
    );

    releasePersistence!();
    const result = await collection;
    assert.equal(result.exitCode, 0, result.logTail);
    assert.equal(result.failure, undefined);
    assert.equal(result.extensions?.length, 1);
    assert.equal(result.extensions?.[0]?.cumulativeTimeoutMs, 4_000);
    assert.deepEqual(result.extensions, grants);
  } finally {
    releasePersistence?.();
    await collection?.catch(() => undefined);
    fixture.cleanup();
    rmSync(markerRoot, { recursive: true, force: true });
  }
});

test("a rejected persistence callback denies the grant", async () => {
  const fixture = claudeFixture(
    `
await delay(10_000);
${resultLine("unreachable success")}
`,
    "deadline-fixture",
    { assistant: "continuous" },
  );
  let callbackCalls = 0;
  try {
    const result = await runFixture(
      fixture,
      policy({
        baseTimeoutMs: 1_500,
        extensionStepMs: 2_000,
        healthyActivityWindowMs: 10_000,
      }),
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
  // Continuous mapped activity makes the disabled policy the only possible
  // reason for denial; the callback is present but must never be called.
  const fixture = claudeFixture(
    `
await delay(10_000);
${resultLine("too late")}
`,
    "deadline-fixture",
    { assistant: "continuous" },
  );
  let callbackCalls = 0;
  try {
    const defaultOff = {
      ...DEFAULT_DEADLINE_EXTENSION_POLICY,
      baseTimeoutMs: 1_200,
      maxTotalTimeoutMs: 1_200,
      healthyActivityWindowMs: 10_000,
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
  // Poll the run manifest until the Supervisor's grant checkpoint is
  // observable. The shell-level activity stream keeps mapped evidence fresh
  // throughout, so a slow checkpoint cannot be mistaken for worker silence.
  let extensions = [];
  {
    const until = Date.now() + 10_000;
    for (;;) {
      try {
        const manifest = JSON.parse(
          fs.readFileSync(${JSON.stringify(manifestPath)}, "utf8")
        );
        extensions =
          (manifest.tasks && manifest.tasks["batch-deadline"].extensions) || [];
        if (extensions.length > 0) break;
      } catch {
        // The manifest is atomically replaced; a transient read may miss it.
      }
      if (Date.now() >= until) break;
      await delay(20);
    }
  }
  fs.writeFileSync(
    ${JSON.stringify(markerPath)},
    JSON.stringify(extensions)
  );
  fs.appendFileSync(
    path.join(process.cwd(), "allowed.ts"),
    "\\nexport const batchExtended = true;\\n"
  );
${resultLine("batch fixture complete")}
`,
      { assistant: "continuous" },
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
        "1500",
        "--auto-extend-deadline",
        "--deadline-extension-ms",
        "3000",
        "--max-deadline-extensions",
        "1",
        "--max-total-timeout-ms",
        "4500",
        "--healthy-activity-window-ms",
        "10000",
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
    assert.equal(taskState.extensions?.[0]?.cumulativeTimeoutMs, 4500);

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
    assert.match(human, /last deadline extension=.* \+3000ms cumulative=4500ms/);
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

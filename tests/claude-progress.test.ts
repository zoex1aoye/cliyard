import { test } from "node:test";
import assert from "node:assert/strict";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { createClaudeAdapter } from "../src/agents/claude.js";
import type { WorkerProgressEvent } from "../src/agents/types.js";
import type { TaskContract } from "../src/contracts/schema.js";

function initRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), "cliyard-claude-progress-"));
  spawnSync("git", ["init"], { cwd: repo, stdio: "ignore" });
  spawnSync("git", ["config", "user.email", "t@t.com"], {
    cwd: repo,
    stdio: "ignore",
  });
  spawnSync("git", ["config", "user.name", "t"], {
    cwd: repo,
    stdio: "ignore",
  });
  writeFileSync(join(repo, "allowed.ts"), "export const value = 1;\n");
  spawnSync("git", ["add", "."], { cwd: repo, stdio: "ignore" });
  spawnSync("git", ["commit", "-m", "init"], { cwd: repo, stdio: "ignore" });
  return repo;
}

function baseCommit(repo: string): string {
  return spawnSync("git", ["rev-parse", "HEAD"], {
    cwd: repo,
    encoding: "utf8",
  }).stdout.trim();
}

function contract(repo: string, taskId: string): TaskContract {
  return {
    taskId,
    version: 1,
    frozen: true,
    goals: ["Change allowed.ts"],
    dependsOn: [],
    readPaths: ["."],
    writePaths: ["allowed.ts"],
    sharedResources: [],
    baseCommit: baseCommit(repo),
    verifyCommands: ["true"],
    maxRepairs: 0,
  };
}

function writeBinary(path: string, body: string): void {
  writeFileSync(path, body);
  chmodSync(path, 0o755);
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 8_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
  }
  throw new Error(`timed out after ${timeoutMs}ms`);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

test("stream-json progress is visible before collect resolves, with hidden details redacted", async () => {
  const root = mkdtempSync(join(tmpdir(), "cliyard-claude-progress-bin-"));
  const repo = initRepo();
  try {
    const binary = join(root, "fake-stream-claude");
    const argsFile = join(root, "args.txt");
    writeBinary(
      binary,
      `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
fs.writeFileSync(${JSON.stringify(argsFile)}, process.argv.slice(2).join(" "));
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
(async () => {
  console.log(JSON.stringify({
    type: "system",
    subtype: "init",
    session_id: "provider-session",
    model: "fixture-model"
  }));
  console.log(JSON.stringify({
    type: "assistant",
    message: {
      role: "assistant",
      content: [
        {
          type: "text",
          text: "Editing allowed.ts with sk-live-SECRET123456789 then running a check " +
            "x".repeat(600)
        },
        {
          type: "tool_use",
          id: "tool-1",
          name: "Edit",
          input: {
            file_path: "allowed.ts",
            old_string: "export const value = 1;",
            new_string: "export const value = 2; sk-other-SECRET987654321"
          }
        }
      ]
    }
  }));
  fs.appendFileSync(
    path.join(process.cwd(), "allowed.ts"),
    "\\nexport const value = 2;\\n"
  );
  await delay(400);
  console.log(JSON.stringify({
    type: "user",
    message: {
      role: "user",
      content: [{
        type: "tool_result",
        tool_use_id: "tool-1",
        content: "FILE-CONTENT-SHOULD-NOT-APPEAR",
        is_error: false
      }]
    }
  }));
  await delay(400);
  console.log(JSON.stringify({
    type: "result",
    subtype: "success",
    is_error: false,
    result: "stream fixture done"
  }));
})();
`,
    );

    const task = contract(repo, "claude-progress");
    const worker = createClaudeAdapter({
      binary,
      cwd: repo,
      model: "fixture-model",
      heartbeatMs: 50,
    });
    const events: WorkerProgressEvent[] = [];
    const { sessionId } = await worker.start({
      contract: task,
      attempt: 0,
      onProgress: (event) => events.push(event),
    });

    let collected = false;
    const collecting = worker.collect(sessionId).then((result) => {
      collected = true;
      return result;
    });

    // The provider is still sleeping between its assistant event and result,
    // so progress must already be visible while collect() is pending.
    await waitFor(() => events.some((event) => event.type === "assistant"));
    assert.equal(
      collected,
      false,
      "assistant progress must not wait for the final result",
    );
    assert.ok(events.some((event) => event.type === "session.start"));
    const toolStart = events.find(
      (event) => event.type === "tool.start" && /Edit/.test(event.message),
    );
    assert.ok(toolStart, "tool.start event missing");
    assert.match(toolStart.detail ?? "", /allowed\.ts/);

    const assistant = events.find((event) => event.type === "assistant");
    assert.ok(assistant, "assistant event missing");
    assert.ok(assistant.message.length <= 240, "assistant summary is unbounded");

    // Providers can be silent for a while; heartbeat proves liveness without
    // claiming success.
    await waitFor(() => events.some((event) => event.type === "heartbeat"));
    // Silence remains distinct from the active-provider heartbeat.
    await waitFor(() =>
      events.some(
        (event) =>
          event.type === "heartbeat" &&
          event.phase === "waiting" &&
          event.message === "waiting for provider output",
      ),
    );
    assert.ok(
      events.every(
        (event) =>
          event.version === 1 &&
          event.taskId === "claude-progress" &&
          event.sessionId === sessionId &&
          event.source === "claude",
      ),
    );

    const result = await collecting;
    assert.equal(result.exitCode, 0);
    assert.deepEqual(result.touchedPaths, ["allowed.ts"]);
    assert.ok(events.some((event) => event.type === "tool.result"));
    assert.ok(events.some((event) => event.type === "result"));
    assert.match(readFileSync(join(repo, "allowed.ts"), "utf8"), /value = 2/);

    const args = readFileSync(argsFile, "utf8");
    assert.match(args, /--output-format stream-json/);
    assert.match(args, /--verbose/);

    // Bounded, credential-free progress: raw provider text, tool inputs and
    // tool outputs never reach the event stream.
    const serialized = JSON.stringify(events);
    assert.doesNotMatch(serialized, /sk-live-SECRET/);
    assert.doesNotMatch(serialized, /sk-other-SECRET/);
    assert.doesNotMatch(serialized, /FILE-CONTENT-SHOULD-NOT-APPEAR/);
    assert.doesNotMatch(serialized, /export const value = 1/);

    // The heartbeat timer is cleared with the child.
    const heartbeats = events.filter(
      (event) => event.type === "heartbeat",
    ).length;
    await delay(150);
    assert.equal(
      events.filter((event) => event.type === "heartbeat").length,
      heartbeats,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  }
});

test("unmapped thinking-token records produce bounded active heartbeats until the result", async () => {
  const root = mkdtempSync(join(tmpdir(), "cliyard-claude-thinking-bin-"));
  const repo = initRepo();
  try {
    const binary = join(root, "fake-thinking-claude");
    const thinkingRecords = 30;
    writeBinary(
      binary,
      `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
(async () => {
  console.log(JSON.stringify({
    type: "system",
    subtype: "init",
    session_id: "provider-session",
    model: "fixture-model"
  }));
  // Only records the adapter maps to no progress event.
  for (let i = 0; i < ${thinkingRecords}; i += 1) {
    await delay(20);
    console.log(JSON.stringify({
      type: "system",
      subtype: "thinking_tokens",
      thinking_tokens: { text: "sk-live-THINKINGSECRET123456789" + i }
    }));
  }
  fs.appendFileSync(
    path.join(process.cwd(), "allowed.ts"),
    "\\nexport const viaThinking = true;\\n"
  );
  console.log(JSON.stringify({
    type: "result",
    subtype: "success",
    is_error: false,
    result: "thinking-only fixture done"
  }));
  // Stay alive after the result so a post-result heartbeat would be visible.
  await delay(250);
})();
`,
    );

    const task = contract(repo, "claude-thinking-heartbeat");
    const worker = createClaudeAdapter({
      binary,
      cwd: repo,
      model: "fixture-model",
      heartbeatMs: 50,
    });
    const events: WorkerProgressEvent[] = [];
    const { sessionId } = await worker.start({
      contract: task,
      attempt: 0,
      onProgress: (event) => events.push(event),
    });
    const result = await worker.collect(sessionId);
    assert.equal(result.exitCode, 0);
    assert.deepEqual(result.touchedPaths, ["allowed.ts"]);

    const resultIndex = events.findIndex((event) => event.type === "result");
    assert.ok(resultIndex >= 0, "result event missing");
    const beforeResult = events.slice(0, resultIndex);
    const afterResult = events.slice(resultIndex + 1);
    const activeBefore = beforeResult.filter(
      (event) =>
        event.type === "heartbeat" &&
        event.phase === "thinking" &&
        event.message === "provider active",
    );

    // 600ms of thinking-token records spans several 50ms heartbeat intervals.
    // Multiple active heartbeats must be visible before the final result.
    assert.ok(
      activeBefore.length >= 3,
      `expected multiple active heartbeats, got ${activeBefore.length}`,
    );
    // One event per interval, never one event per thinking-token record.
    assert.ok(
      activeBefore.length <= 20,
      `active heartbeats are not bounded: ${activeBefore.length}`,
    );
    assert.ok(
      activeBefore.some((event) =>
        /last system\/thinking_tokens/.test(event.detail ?? ""),
      ),
      "active heartbeat should name the last bounded record",
    );
    assert.equal(
      afterResult.filter((event) => event.type === "heartbeat").length,
      0,
      "heartbeats must stop once the result is emitted",
    );
    // Record content and credentials never reach heartbeat details.
    assert.doesNotMatch(JSON.stringify(events), /THINKINGSECRET/);

    // The timer is cleared with the child; the count is stable afterwards.
    const heartbeats = events.filter(
      (event) => event.type === "heartbeat",
    ).length;
    await delay(150);
    assert.equal(
      events.filter((event) => event.type === "heartbeat").length,
      heartbeats,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  }
});

test("plain single-JSON result without a newline or type still completes", async () => {
  const root = mkdtempSync(join(tmpdir(), "cliyard-claude-plain-bin-"));
  const repo = initRepo();
  try {
    const binary = join(root, "fake-plain-claude");
    writeBinary(
      binary,
      `#!/bin/sh
printf '%s' '{"is_error":false,"result":"plain fixture ok"}'
`,
    );
    const task = contract(repo, "claude-plain");
    const worker = createClaudeAdapter({
      binary,
      cwd: repo,
      model: "fixture-model",
      heartbeatMs: 50,
    });
    const events: WorkerProgressEvent[] = [];
    const { sessionId } = await worker.start({
      contract: task,
      attempt: 0,
      onProgress: (event) => events.push(event),
    });
    const result = await worker.collect(sessionId);
    assert.equal(result.exitCode, 0);
    assert.ok(events.some((event) => event.type === "session.start"));
    assert.ok(events.some((event) => event.type === "result"));
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  }
});

test("stream-json transient failures emit retry progress and then succeed", async () => {
  const root = mkdtempSync(join(tmpdir(), "cliyard-claude-progress-retry-"));
  const repo = initRepo();
  try {
    const binary = join(root, "fake-stream-retry");
    const counter = join(root, "attempts");
    writeBinary(
      binary,
      `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
if (!fs.existsSync(${JSON.stringify(counter)})) {
  fs.writeFileSync(${JSON.stringify(counter)}, "1");
  console.log(JSON.stringify({
    type: "result",
    subtype: "error",
    is_error: true,
    result: "API Error: ECONNRESET"
  }));
  process.exit(0);
}
fs.appendFileSync(
  path.join(process.cwd(), "allowed.ts"),
  "\\nexport const retried = true;\\n"
);
console.log(JSON.stringify({
  type: "assistant",
  message: { role: "assistant", content: [{ type: "text", text: "retrying" }] }
}));
console.log(JSON.stringify({
  type: "result",
  subtype: "success",
  is_error: false,
  result: "retry fixture done"
}));
`,
    );
    const task = contract(repo, "claude-stream-retry");
    const worker = createClaudeAdapter({
      binary,
      cwd: repo,
      model: "fixture-model",
      maxTransientRetries: 1,
      heartbeatMs: 50,
    });
    const events: WorkerProgressEvent[] = [];
    const { sessionId } = await worker.start({
      contract: task,
      attempt: 0,
      onProgress: (event) => events.push(event),
    });
    const result = await worker.collect(sessionId);
    assert.equal(result.exitCode, 0);
    assert.deepEqual(result.touchedPaths, ["allowed.ts"]);
    assert.match(result.logTail, /transient failure; retry 1\/1/);
    const retry = events.find((event) => event.type === "retry");
    assert.ok(retry, "retry event missing");
    assert.equal(retry.phase, "waiting");
    assert.match(retry.message, /retry 1\/1/);
    assert.ok(events.some((event) => event.type === "result"));
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  }
});

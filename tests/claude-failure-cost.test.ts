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
import {
  createClaudeAdapter,
  type ClaudeWorkerOptions,
} from "../src/agents/claude.js";
import {
  createCodexAdapter,
  type CodexWorkerOptions,
} from "../src/agents/codex.js";
import type { AgentResult } from "../src/agents/types.js";
import type { TaskContract } from "../src/contracts/schema.js";
import { costCompleteness, type TokenUsage } from "../src/failures.js";

const ZERO_USAGE: TokenUsage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheCreationInputTokens: 0,
  cacheReadInputTokens: 0,
};

const FULL_USAGE: TokenUsage = {
  inputTokens: 10,
  outputTokens: 20,
  cacheCreationInputTokens: 30,
  cacheReadInputTokens: 40,
};

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function initRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), "cliyard-claude-failure-cost-"));
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
  spawnSync("git", ["commit", "-m", "init"], {
    cwd: repo,
    stdio: "ignore",
  });
  return repo;
}

function baseCommit(repo: string): string {
  return spawnSync("git", ["rev-parse", "HEAD"], {
    cwd: repo,
    encoding: "utf8",
  }).stdout.trim();
}

function makeContract(repo: string, taskId: string): TaskContract {
  return {
    taskId,
    version: 1,
    frozen: true,
    goals: ["Exercise failure and cost observations"],
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

interface Fixture {
  root: string;
  repo: string;
  binary: string;
  contract: TaskContract;
  cleanup: () => void;
}

function fixture(script: string, taskId = "failure-cost"): Fixture {
  const root = mkdtempSync(join(tmpdir(), "cliyard-claude-failure-cost-bin-"));
  const repo = initRepo();
  const binary = join(root, "fake-claude");
  writeBinary(binary, script);
  return {
    root,
    repo,
    binary,
    contract: makeContract(repo, taskId),
    cleanup: () => {
      rmSync(root, { recursive: true, force: true });
      rmSync(repo, { recursive: true, force: true });
    },
  };
}

async function runClaude(
  f: Fixture,
  options: Omit<ClaudeWorkerOptions, "cwd" | "model"> = {},
): Promise<AgentResult> {
  const worker = createClaudeAdapter({
    binary: f.binary,
    cwd: f.repo,
    model: "fixture-model",
    ...options,
  });
  const { sessionId } = await worker.start({
    contract: f.contract,
    attempt: 0,
  });
  return worker.collect(sessionId);
}

async function runCodex(
  f: Fixture,
  options: Omit<CodexWorkerOptions, "cwd" | "model"> = {},
): Promise<AgentResult> {
  const worker = createCodexAdapter({
    binary: f.binary,
    cwd: f.repo,
    model: "fixture-model",
    ...options,
  });
  const { sessionId } = await worker.start({
    contract: f.contract,
    attempt: 0,
  });
  return worker.collect(sessionId);
}

function claudeResult(record: Record<string, unknown>): string {
  return `#!/usr/bin/env node
console.log(JSON.stringify(${JSON.stringify(record)}));
`;
}

// ---------------------------------------------------------------------------
// Claude cost truth
// ---------------------------------------------------------------------------

test("Claude preserves explicit zero cost as non-authoritative cli-estimated truth", async () => {
  const f = fixture(
    claudeResult({
      type: "result",
      subtype: "success",
      is_error: false,
      result: "ok",
      total_cost_usd: 0,
      usage: {
        input_tokens: 0,
        output_tokens: 0,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
    }),
  );
  try {
    const result = await runClaude(f, { maxBudgetUsd: 4 });
    assert.equal(result.exitCode, 0);
    assert.equal(result.failure, undefined);
    assert.ok(result.cost);
    assert.equal(result.cost.state, "cli-estimated");
    assert.equal(result.cost.source, "cli");
    assert.equal(result.cost.authoritative, false);
    assert.equal(result.cost.amount, 0);
    assert.equal(result.cost.currency, "USD");
    assert.equal(result.cost.guardBudgetUsd, 4);
    assert.deepEqual(result.cost.usage, ZERO_USAGE);
    assert.deepEqual(result.cost.missing, []);
    assert.equal(result.cost.observations.length, 1);
    assert.equal(result.cost.observations[0].state, "cli-estimated");
    assert.equal(costCompleteness(result.cost), "complete");
  } finally {
    f.cleanup();
  }
});

test("Claude retains token-only usage when cost is absent", async () => {
  const f = fixture(
    claudeResult({
      type: "result",
      subtype: "success",
      is_error: false,
      result: "ok",
      usage: {
        input_tokens: 11,
        output_tokens: 7,
        cache_creation_input_tokens: 3,
        cache_read_input_tokens: 2,
      },
    }),
  );
  try {
    const result = await runClaude(f);
    assert.equal(result.exitCode, 0);
    assert.equal(result.cost?.state, "usage-only");
    assert.equal(result.cost?.source, "none");
    assert.equal(result.cost?.authoritative, false);
    assert.equal(result.cost?.amount, null);
    assert.deepEqual(result.cost?.usage, {
      inputTokens: 11,
      outputTokens: 7,
      cacheCreationInputTokens: 3,
      cacheReadInputTokens: 2,
    });
    assert.ok(result.cost?.missing.includes("cost.amount"));
    assert.equal(costCompleteness(result.cost), "partial");
  } finally {
    f.cleanup();
  }
});

test("Claude reports unavailable cost rather than zero when fields are missing", async () => {
  const f = fixture(
    claudeResult({
      type: "result",
      subtype: "success",
      is_error: false,
      result: "ok",
    }),
  );
  try {
    const result = await runClaude(f);
    assert.equal(result.exitCode, 0);
    assert.equal(result.cost?.state, "unavailable");
    assert.equal(result.cost?.amount, null);
    assert.equal(result.cost?.usage, null);
    assert.ok(result.cost?.missing.includes("cost.amount"));
    assert.ok(result.cost?.missing.includes("cost.usage"));
    assert.equal(costCompleteness(result.cost), "missing");
  } finally {
    f.cleanup();
  }
});

test("Claude fails closed on malformed cost and usage values", async () => {
  const f = fixture(
    claudeResult({
      type: "result",
      subtype: "success",
      is_error: false,
      result: "ok",
      total_cost_usd: "12.50",
      usage: { input_tokens: "ten", output_tokens: -3 },
    }),
  );
  try {
    const result = await runClaude(f);
    assert.equal(result.cost?.state, "unavailable");
    assert.equal(result.cost?.amount, null);
    assert.equal(result.cost?.usage, null);
    assert.equal(result.cost?.currency, null);
    assert.ok(result.cost?.missing.includes("cost.amount"));
    assert.ok(result.cost?.missing.includes("cost.usage"));
  } finally {
    f.cleanup();
  }
});

test("Claude keeps valid usage when only the cost amount is malformed", async () => {
  const f = fixture(
    claudeResult({
      type: "result",
      subtype: "success",
      is_error: false,
      result: "ok",
      total_cost_usd: "not-a-number",
      usage: {
        input_tokens: 5,
        output_tokens: 6,
        cache_creation_input_tokens: 7,
        cache_read_input_tokens: 8,
      },
    }),
  );
  try {
    const result = await runClaude(f);
    assert.equal(result.cost?.state, "usage-only");
    assert.equal(result.cost?.amount, null);
    assert.deepEqual(result.cost?.usage, {
      inputTokens: 5,
      outputTokens: 6,
      cacheCreationInputTokens: 7,
      cacheReadInputTokens: 8,
    });
    assert.ok(result.cost?.missing.includes("cost.amount"));
  } finally {
    f.cleanup();
  }
});

test("Claude falls back to modelUsage when top-level usage is absent", async () => {
  const f = fixture(
    claudeResult({
      type: "result",
      subtype: "success",
      is_error: false,
      result: "ok",
      total_cost_usd: 0.05,
      modelUsage: {
        "model-a": {
          input_tokens: 1,
          output_tokens: 2,
          cache_creation_input_tokens: 3,
          cache_read_input_tokens: 4,
        },
        "model-b": {
          input_tokens: 5,
          output_tokens: 6,
          cache_creation_input_tokens: 7,
          cache_read_input_tokens: 8,
        },
      },
    }),
  );
  try {
    const result = await runClaude(f);
    assert.equal(result.cost?.state, "cli-estimated");
    assert.equal(result.cost?.amount, 0.05);
    assert.deepEqual(result.cost?.usage, {
      inputTokens: 6,
      outputTokens: 8,
      cacheCreationInputTokens: 10,
      cacheReadInputTokens: 12,
    });
    assert.deepEqual(result.cost?.missing, []);
    assert.equal(costCompleteness(result.cost), "complete");
  } finally {
    f.cleanup();
  }
});

test("Claude preserves partial usage while reporting incomplete cost truth", async () => {
  const f = fixture(
    claudeResult({
      type: "result",
      subtype: "success",
      is_error: false,
      result: "ok",
      total_cost_usd: 0.1,
      usage: { input_tokens: 5, output_tokens: 2 },
    }),
  );
  try {
    const result = await runClaude(f);
    assert.equal(result.cost?.state, "cli-estimated");
    assert.equal(result.cost?.amount, 0.1);
    assert.equal(result.cost?.usage?.inputTokens, 5);
    assert.equal(result.cost?.usage?.outputTokens, 2);
    assert.equal(result.cost?.usage?.cacheCreationInputTokens, null);
    assert.equal(result.cost?.usage?.cacheReadInputTokens, null);
    assert.ok(result.cost?.missing.includes("cost.usage"));
    assert.equal(costCompleteness(result.cost), "partial");
  } finally {
    f.cleanup();
  }
});

test("Claude transient retries still succeed and aggregate every session's cost", async () => {
  const f = fixture(`#!/usr/bin/env node
const fs = require("node:fs");
const counter = __filename + ".attempts";
if (!fs.existsSync(counter)) {
  fs.writeFileSync(counter, "1");
  console.log(JSON.stringify({
    type: "result",
    subtype: "error",
    is_error: true,
    result: "API Error: ECONNRESET",
    total_cost_usd: 0.01,
    usage: {
      input_tokens: 10,
      output_tokens: 20,
      cache_creation_input_tokens: 30,
      cache_read_input_tokens: 40
    }
  }));
} else {
  console.log(JSON.stringify({
    type: "result",
    subtype: "success",
    is_error: false,
    result: "ok",
    total_cost_usd: 0.02,
    usage: {
      input_tokens: 10,
      output_tokens: 20,
      cache_creation_input_tokens: 30,
      cache_read_input_tokens: 40
    }
  }));
}
`);
  try {
    const result = await runClaude(f, {
      maxTransientRetries: 1,
      maxBudgetUsd: 4,
    });
    assert.equal(result.exitCode, 0);
    assert.equal(result.failure, undefined);
    assert.match(result.logTail, /transient failure; retry 1\/1/);
    assert.equal(result.cost?.state, "cli-estimated");
    assert.equal(result.cost?.amount, 0.03);
    assert.equal(result.cost?.authoritative, false);
    assert.equal(result.cost?.guardBudgetUsd, 4);
    assert.equal(result.cost?.observations.length, 2);
    assert.deepEqual(result.cost?.usage, {
      inputTokens: 20,
      outputTokens: 40,
      cacheCreationInputTokens: 60,
      cacheReadInputTokens: 80,
    });
    assert.deepEqual(result.cost?.missing, []);
    assert.equal(costCompleteness(result.cost), "complete");
  } finally {
    f.cleanup();
  }
});

test("Claude returns the final structured failure after retry exhaustion", async () => {
  const f = fixture(`#!/usr/bin/env node
const fs = require("node:fs");
fs.appendFileSync(__filename + ".attempts", "attempt\\n");
console.log(JSON.stringify({
  type: "result",
  subtype: "error",
  is_error: true,
  result: "API Error: 429 rate limit exceeded"
}));
`);
  try {
    const result = await runClaude(f, { maxTransientRetries: 1 });
    assert.equal(result.exitCode, 1);
    assert.equal(result.failure?.category, "provider_transient");
    assert.equal(result.failure?.stage, "provider");
    assert.equal(result.failure?.retryableHint, true);
    assert.match(result.failure?.message ?? "", /429 rate limit/);
    assert.match(result.logTail, /transient failure; retry 1\/1/);
    assert.equal(
      readFileSync(`${f.binary}.attempts`, "utf8").trim().split("\n").length,
      2,
    );
    assert.equal(result.cost?.state, "unavailable");
    assert.equal(result.cost?.amount, null);
    assert.equal(result.cost?.observations.length, 2);
    assert.ok(result.cost?.missing.includes("cost.amount"));
    assert.ok(result.cost?.missing.includes("cost.usage"));
  } finally {
    f.cleanup();
  }
});

// ---------------------------------------------------------------------------
// Claude failure classification
// ---------------------------------------------------------------------------

test("Claude classifies budget, auth, resource and protocol failures", async () => {
  const cases = [
    {
      text: "provider budget exhausted",
      category: "budget_exhausted",
      stage: "provider",
    },
    {
      text: "401 Unauthorized: invalid api key",
      category: "provider_auth",
      stage: "provider",
    },
    {
      text: "JavaScript heap out of memory",
      category: "resource_exhausted",
      stage: "worker",
    },
    {
      text: "invalid JSONL record: unexpected token <",
      category: "provider_protocol",
      stage: "provider",
    },
  ] as const;

  for (const expected of cases) {
    const f = fixture(`#!/usr/bin/env node
const fs = require("node:fs");
fs.appendFileSync(__filename + ".attempts", "attempt\\n");
console.log(JSON.stringify(${JSON.stringify({
      type: "result",
      subtype: "error",
      is_error: true,
      result: expected.text,
    })}));
`);
    try {
      const result = await runClaude(f);
      assert.equal(result.exitCode, 1, expected.text);
      assert.equal(result.failure?.category, expected.category, expected.text);
      assert.equal(result.failure?.stage, expected.stage, expected.text);
      assert.ok(result.failure?.message.includes(expected.text), expected.text);
      assert.equal(result.cost?.state, "unavailable");
      // Failure taxonomy is observational: a non-transient category must not
      // introduce a retry that did not exist before.
      assert.equal(
        readFileSync(`${f.binary}.attempts`, "utf8").trim().split("\n").length,
        1,
        expected.text,
      );
    } finally {
      f.cleanup();
    }
  }
});

test("Claude reports a non-zero provider process as worker_process_exit", async () => {
  const f = fixture(`#!/bin/sh
echo "fatal worker error" >&2
exit 7
`);
  try {
    const result = await runClaude(f);
    assert.equal(result.exitCode, 1);
    assert.equal(result.failure?.category, "worker_process_exit");
    assert.equal(result.failure?.stage, "worker");
    assert.equal(result.failure?.code, "exit_7");
    assert.match(result.failure?.message ?? "", /fatal worker error/);
    assert.equal(result.cost?.state, "unavailable");
    assert.equal(result.cost?.observations.length, 1);
    assert.match(result.cost?.observations[0].note ?? "", /code 7/);
  } finally {
    f.cleanup();
  }
});

test("Claude classifies its wall-clock timeout before provider text", async () => {
  const f = fixture(`#!/usr/bin/env node
setInterval(() => {}, 1000);
`);
  try {
    const result = await runClaude(f, { timeoutMs: 150 });
    // The Claude adapter keeps its existing normalized 0/1 result contract;
    // the structured failure carries the timeout distinction.
    assert.equal(result.exitCode, 1);
    assert.equal(result.failure?.category, "timeout");
    assert.equal(result.failure?.stage, "worker");
    assert.equal(result.failure?.code, "timeout");
    assert.match(result.failure?.message ?? "", /timed out after 150ms/);
    assert.equal(result.cost?.state, "unavailable");
    assert.equal(result.cost?.amount, null);
    assert.ok(result.cost?.missing.includes("cost.amount"));
    assert.match(result.cost?.observations[0].note ?? "", /timed out/);
  } finally {
    f.cleanup();
  }
});

test("Claude spawn failure is a structured spawn failure with unavailable cost", async () => {
  const f = fixture("#!/bin/sh\nexit 0\n");
  try {
    const result = await runClaude(f, {
      binary: join(f.root, "missing-claude-binary"),
    });
    assert.equal(result.exitCode, 1);
    assert.equal(result.failure?.category, "worker_process_exit");
    assert.equal(result.failure?.stage, "spawn");
    assert.equal(result.failure?.code, "spawn_error");
    assert.match(result.failure?.message ?? "", /failed to start/);
    assert.equal(result.cost?.state, "unavailable");
    assert.equal(result.cost?.amount, null);
    assert.ok(result.cost?.missing.includes("cost.amount"));
  } finally {
    f.cleanup();
  }
});

test("Claude failures retain bounded text but never secrets or raw payloads", async () => {
  const f = fixture(
    claudeResult({
      type: "result",
      subtype: "error",
      is_error: true,
      result:
        "authentication failed: invalid api key " +
        "sk-live-CLAUDESECRET123456789 Authorization: Bearer " +
        "abcdefghijklmnopqrstuvwxyz012345",
      raw_payload: { prompt: "PROMPT-SHOULD-NOT-LEAK" },
      prompt: "PROMPT-SHOULD-NOT-LEAK",
      total_cost_usd: 0.5,
    }),
  );
  try {
    const result = await runClaude(f);
    assert.equal(result.failure?.category, "provider_auth");
    assert.ok(result.failure?.message);
    assert.equal(
      result.failure.message.includes("sk-live-CLAUDESECRET123456789"),
      false,
    );
    assert.equal(
      result.failure.message.includes("abcdefghijklmnopqrstuvwxyz012345"),
      false,
    );
    const failureJson = JSON.stringify(result.failure);
    assert.equal(failureJson.includes("PROMPT-SHOULD-NOT-LEAK"), false);
    assert.equal(failureJson.includes("raw_payload"), false);
    const costJson = JSON.stringify(result.cost);
    assert.equal(costJson.includes("PROMPT-SHOULD-NOT-LEAK"), false);
    assert.equal(costJson.includes("raw_payload"), false);
    // Cost fields on a failed result are still observed.
    assert.equal(result.cost?.state, "cli-estimated");
    assert.equal(result.cost?.amount, 0.5);
    assert.ok(result.cost?.missing.includes("cost.usage"));
  } finally {
    f.cleanup();
  }
});

// ---------------------------------------------------------------------------
// Codex fallbacks
// ---------------------------------------------------------------------------

test("Codex distinguishes process exit and reports unavailable cost", async () => {
  const f = fixture(`#!/bin/sh
echo "worker exploded" >&2
exit 3
`);
  try {
    const result = await runCodex(f);
    assert.equal(result.exitCode, 3);
    assert.equal(result.failure?.category, "worker_process_exit");
    assert.equal(result.failure?.stage, "worker");
    assert.equal(result.failure?.code, "exit_3");
    assert.match(result.failure?.message ?? "", /worker exploded/);
    assert.equal(result.cost?.state, "unavailable");
    assert.equal(result.cost?.source, "none");
    assert.equal(result.cost?.authoritative, false);
    assert.equal(result.cost?.amount, null);
    assert.ok(result.cost?.missing.includes("cost.amount"));
    assert.ok(result.cost?.missing.includes("cost.usage"));
    assert.equal(costCompleteness(result.cost), "missing");
    assert.match(result.logTail, /worker exploded/);
  } finally {
    f.cleanup();
  }
});

test("Codex distinguishes its timeout from a plain process exit", async () => {
  const f = fixture(`#!/usr/bin/env node
setInterval(() => {}, 1000);
`);
  try {
    const result = await runCodex(f, { timeoutMs: 150 });
    assert.equal(result.exitCode, 124);
    assert.equal(result.failure?.category, "timeout");
    assert.equal(result.failure?.stage, "worker");
    assert.equal(result.failure?.code, "timeout");
    assert.match(result.failure?.message ?? "", /timed out after 150ms/);
    assert.equal(result.cost?.state, "unavailable");
    assert.equal(result.cost?.amount, null);
  } finally {
    f.cleanup();
  }
});

test("Codex success reports unavailable cost without inventing a failure", async () => {
  const f = fixture(`#!/bin/sh
exit 0
`);
  try {
    const result = await runCodex(f);
    assert.equal(result.exitCode, 0);
    assert.equal(result.failure, undefined);
    assert.equal(result.cost?.state, "unavailable");
    assert.equal(result.cost?.amount, null);
    assert.ok(result.cost?.missing.includes("cost.amount"));
    assert.ok(result.cost?.missing.includes("cost.usage"));
  } finally {
    f.cleanup();
  }
});

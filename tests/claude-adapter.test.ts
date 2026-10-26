import { test } from "node:test";
import assert from "node:assert/strict";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createClaudeAdapter } from "../src/agents/claude.js";
import type { TaskContract } from "../src/contracts/schema.js";
import { runCodexBatch } from "../src/scheduler/codex-batch.js";

const parallelFixture = fileURLToPath(
  new URL("../examples/codex-batch.parallel.json", import.meta.url),
);

function initRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), "cliyard-claude-"));
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
  writeFileSync(join(repo, "README.md"), "# fixture\n");
  mkdirSync(join(repo, "docs"), { recursive: true });
  writeFileSync(join(repo, "docs", "fixture.md"), "# fixture\n");
  spawnSync("git", ["add", "."], { cwd: repo, stdio: "ignore" });
  spawnSync("git", ["commit", "-m", "init"], {
    cwd: repo,
    stdio: "ignore",
  });
  return repo;
}

test("Claude adapter runs a JSON worker and records actual git changes", async () => {
  const root = mkdtempSync(join(tmpdir(), "cliyard-claude-bin-"));
  const repo = initRepo();
  try {
    const binary = join(root, "fake-claude");
    const allowedPath = join(repo, "allowed.ts");
    writeFileSync(
      binary,
      `#!/bin/sh
printf '\\nexport const value = 2;\\n' >> ${JSON.stringify(allowedPath)}
printf '%s\\n' '{"type":"result","is_error":false,"result":"ok"}'
`,
    );
    chmodSync(binary, 0o755);
    const baseCommit = spawnSync("git", ["rev-parse", "HEAD"], {
      cwd: repo,
      encoding: "utf8",
    }).stdout.trim();
    const contract: TaskContract = {
      taskId: "claude-worker",
      version: 1,
      frozen: true,
      goals: ["Change allowed.ts"],
      dependsOn: [],
      readPaths: ["."],
      writePaths: ["allowed.ts"],
      sharedResources: [],
      baseCommit,
      verifyCommands: ["true"],
      maxRepairs: 0,
    };

    const worker = createClaudeAdapter({
      binary,
      cwd: repo,
      model: "deepseek-flash[1m]",
    });
    const discovery = await worker.discover();
    assert.equal(discovery.ok, true);
    const { sessionId } = await worker.start({ contract, attempt: 0 });
    const result = await worker.collect(sessionId);
    assert.equal(result.exitCode, 0);
    assert.deepEqual(result.touchedPaths, ["allowed.ts"]);
    assert.match(readFileSync(join(repo, "allowed.ts"), "utf8"), /value = 2/);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  }
});

test("Claude batch dry-run uses worktrees and accepts both tasks", async () => {
  const repo = initRepo();
  try {
    const result = await runCodexBatch({
      contractsPath: parallelFixture,
      repoRoot: repo,
      ledgerPath: join(repo, ".cliyard", "ledger.json"),
      worker: "claude",
      dryRun: true,
      keepWorktrees: false,
    });
    assert.equal(result.allAccepted, true);
    assert.deepEqual(result.startOrder.sort(), ["module-a", "module-b"]);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("Claude adapter treats JSON is_error as failure even on exit 0", async () => {
  const root = mkdtempSync(join(tmpdir(), "cliyard-claude-error-bin-"));
  const repo = initRepo();
  try {
    const binary = join(root, "fake-claude-error");
    writeFileSync(
      binary,
      `#!/bin/sh
printf '%s\\n' '{"type":"result","is_error":true,"result":"budget exhausted"}'
`,
    );
    chmodSync(binary, 0o755);
    const baseCommit = spawnSync("git", ["rev-parse", "HEAD"], {
      cwd: repo,
      encoding: "utf8",
    }).stdout.trim();
    const worker = createClaudeAdapter({
      binary,
      cwd: repo,
      model: "deepseek-flash[1m]",
    });
    const contract: TaskContract = {
      taskId: "claude-error",
      version: 1,
      frozen: true,
      goals: ["No-op"],
      dependsOn: [],
      readPaths: ["."],
      writePaths: ["allowed.ts"],
      sharedResources: [],
      baseCommit,
      verifyCommands: ["true"],
      maxRepairs: 0,
    };
    const { sessionId } = await worker.start({ contract, attempt: 0 });
    const result = await worker.collect(sessionId);
    assert.equal(result.exitCode, 1);
    assert.match(result.logTail, /budget exhausted/);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  }
});

test("Claude adapter retries transient provider failures", async () => {
  const root = mkdtempSync(join(tmpdir(), "cliyard-claude-retry-"));
  const repo = initRepo();
  try {
    const binary = join(root, "fake-claude-retry");
    const counter = join(root, "attempts");
    const allowedPath = join(repo, "allowed.ts");
    writeFileSync(
      binary,
      `#!/bin/sh
if [ ! -f ${JSON.stringify(counter)} ]; then
  : > ${JSON.stringify(counter)}
  printf '%s\\n' '{"type":"result","is_error":true,"result":"API Error: ECONNRESET"}'
  exit 0
fi
printf '\\nexport const retried = true;\\n' >> ${JSON.stringify(allowedPath)}
printf '%s\\n' '{"type":"result","is_error":false,"result":"ok"}'
`,
    );
    chmodSync(binary, 0o755);
    const baseCommit = spawnSync("git", ["rev-parse", "HEAD"], {
      cwd: repo,
      encoding: "utf8",
    }).stdout.trim();
    const worker = createClaudeAdapter({
      binary,
      cwd: repo,
      model: "deepseek-flash[1m]",
      maxTransientRetries: 1,
    });
    const contract: TaskContract = {
      taskId: "claude-retry",
      version: 1,
      frozen: true,
      goals: ["Recover from transient failure"],
      dependsOn: [],
      readPaths: ["."],
      writePaths: ["allowed.ts"],
      sharedResources: [],
      baseCommit,
      verifyCommands: ["true"],
      maxRepairs: 0,
    };
    const { sessionId } = await worker.start({ contract, attempt: 0 });
    const result = await worker.collect(sessionId);
    assert.equal(result.exitCode, 0);
    assert.deepEqual(result.touchedPaths, ["allowed.ts"]);
    assert.match(result.logTail, /transient failure; retry 1\/1/);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  }
});

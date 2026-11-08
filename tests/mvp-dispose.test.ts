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
import { join, resolve } from "node:path";
import {
  DisposeRegistry,
  assertLocalCliTaskContract,
  assertWrapDisabledOrKnown,
  disposeChild,
  isProcessAlive,
  runIdleSpin,
  spawnDetachedSleep,
} from "../src/mvp/index.js";

function runGit(repo: string, args: string[]): void {
  const result = spawnSync("git", args, { cwd: repo, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr || result.stdout);
}

function initRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), "cliyard-mvp-dispose-"));
  runGit(repo, ["init"]);
  runGit(repo, ["config", "user.email", "t@t.com"]);
  runGit(repo, ["config", "user.name", "t"]);
  writeFileSync(join(repo, "README.md"), "# fixture\n");
  runGit(repo, ["add", "."]);
  runGit(repo, ["commit", "-m", "init"]);
  return repo;
}

function loadSleepContract() {
  const raw = JSON.parse(
    readFileSync(
      resolve("examples/mvp/code-local-cli.sleep.contract.json"),
      "utf8",
    ),
  );
  return assertLocalCliTaskContract(raw);
}

test("disposeChild kills a detached sleep process group", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "cliyard-sleep-"));
  try {
    const { pid } = await spawnDetachedSleep(30, cwd);
    assert.equal(isProcessAlive(pid), true);
    const result = await disposeChild({
      pid,
      reason: "explicit",
      processGroup: true,
      graceMs: 30,
    });
    assert.equal(result.disposed, true);
    assert.equal(result.aliveAfter, false);
    assert.equal(isProcessAlive(pid), false);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("idle-spin AbortSignal disposes long sleep and leaves no live pid", async () => {
  const repo = initRepo();
  try {
    const contract = loadSleepContract();
    const controller = new AbortController();
    const registry = new DisposeRegistry();
    const run = runIdleSpin({
      repoRoot: repo,
      contract,
      replaceExisting: true,
      signal: controller.signal,
      registry,
    });
    setTimeout(() => controller.abort(), 150);
    const result = await run;
    assert.equal(result.disposed, true, result.error);
    assert.equal(result.disposeReason, "abort");
    assert.ok(result.spawnPid);
    assert.equal(isProcessAlive(result.spawnPid!), false);
    assert.equal(result.dispose?.aliveAfter, false);
    assert.equal(registry.size(), 0);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("DisposeRegistry.disposeAll aborts in-flight idle-spin child", async () => {
  const repo = initRepo();
  try {
    const contract = loadSleepContract();
    const registry = new DisposeRegistry();
    const run = runIdleSpin({
      repoRoot: repo,
      contract,
      replaceExisting: true,
      registry,
    });
    // Wait until child is registered.
    for (let i = 0; i < 40 && registry.size() === 0; i++) {
      await new Promise((r) => setTimeout(r, 25));
    }
    assert.ok(registry.size() >= 1, "expected tracked child");
    const disposed = await registry.disposeAll("plugin-dispose");
    assert.ok(disposed.length >= 1);
    assert.equal(disposed[0]?.aliveAfter, false);
    const result = await run;
    assert.equal(result.disposed, true);
    assert.ok(result.spawnPid);
    assert.equal(isProcessAlive(result.spawnPid!), false);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("wrap stays default-off: docker/low-priv refused", () => {
  assert.doesNotThrow(() => assertWrapDisabledOrKnown("none"));
  assert.throws(() => assertWrapDisabledOrKnown("docker"), /default-off/);
  assert.throws(() => assertWrapDisabledOrKnown("low-priv"), /default-off/);
  assert.throws(() => assertWrapDisabledOrKnown("landlock"), /unknown/);
});

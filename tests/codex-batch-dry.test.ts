import { test } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
  mkdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { runCodexBatch } from "../src/scheduler/codex-batch.js";

const parallelFixture = fileURLToPath(
  new URL("../examples/codex-batch.parallel.json", import.meta.url),
);
const repoRoot = fileURLToPath(new URL("..", import.meta.url));

test("codex-batch rejects an ignored --worker override", () => {
  const dir = mkdtempSync(join(tmpdir(), "cliyard-codex-worker-"));
  try {
    const result = spawnSync(
      process.execPath,
      [
        "--import",
        "tsx",
        "src/cli.ts",
        "codex-batch",
        parallelFixture,
        "--repo",
        dir,
        "--worker",
        "claude",
      ],
      {
        cwd: repoRoot,
        encoding: "utf8",
      },
    );
    assert.notEqual(result.status, 0);
    assert.match(
      `${result.stdout}\n${result.stderr}`,
      /codex-batch does not accept --worker; use claude-batch instead/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runCodexBatch dry-run: two worktrees then accept", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cliyard-codex-"));
  try {
    // Minimal git repo
    spawnSync("git", ["init"], { cwd: dir, stdio: "ignore" });
    spawnSync("git", ["config", "user.email", "t@t.com"], {
      cwd: dir,
      stdio: "ignore",
    });
    spawnSync("git", ["config", "user.name", "t"], { cwd: dir, stdio: "ignore" });
    writeFileSync(join(dir, "README.md"), "# tmp\n");
    mkdirSync(join(dir, "docs"), { recursive: true });
    writeFileSync(join(dir, "docs", "a.md"), "a\n");
    spawnSync("git", ["add", "."], { cwd: dir, stdio: "ignore" });
    spawnSync("git", ["commit", "-m", "init"], { cwd: dir, stdio: "ignore" });

    const ledgerPath = join(dir, ".cliyard", "ledger.json");
    const result = await runCodexBatch({
      contractsPath: parallelFixture,
      repoRoot: dir,
      ledgerPath,
      dryRun: true,
      keepWorktrees: false,
      verbose: false,
    });

    assert.equal(result.allAccepted, true);
    assert.equal(result.results.length, 2);
    assert.deepEqual(result.startOrder.sort(), ["module-a", "module-b"]);
    assert.equal(result.worktrees.length, 2);
    assert.equal(existsSync(result.integration.path), false);
    for (const worktree of result.worktrees) {
      assert.equal(existsSync(worktree.path), false);
      const branch = spawnSync(
        "git",
        ["branch", "--list", worktree.branch],
        { cwd: dir, encoding: "utf8" },
      );
      assert.equal(branch.stdout.trim(), "");
    }
    const integrationBranch = spawnSync(
      "git",
      ["branch", "--list", result.integration.branch],
      { cwd: dir, encoding: "utf8" },
    );
    assert.equal(integrationBranch.stdout.trim(), "");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readlinkSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import type { TaskContract } from "../src/contracts/schema.js";
import { runCodexBatch } from "../src/scheduler/codex-batch.js";

test("worker worktrees reuse an ignored node_modules directory", async () => {
  const repo = mkdtempSync(join(tmpdir(), "cliyard-deps-"));
  try {
    spawnSync("git", ["init"], { cwd: repo, stdio: "ignore" });
    spawnSync("git", ["config", "user.email", "t@t.com"], {
      cwd: repo,
      stdio: "ignore",
    });
    spawnSync("git", ["config", "user.name", "t"], {
      cwd: repo,
      stdio: "ignore",
    });
    writeFileSync(join(repo, ".gitignore"), "node_modules/\n");
    writeFileSync(join(repo, "README.md"), "# fixture\n");
    mkdirSync(join(repo, "node_modules", ".cache"), { recursive: true });
    writeFileSync(join(repo, "node_modules", ".cache", "probe"), "ok\n");
    spawnSync("git", ["add", ".gitignore", "README.md"], {
      cwd: repo,
      stdio: "ignore",
    });
    spawnSync("git", ["commit", "-m", "init"], {
      cwd: repo,
      stdio: "ignore",
    });
    const contract: TaskContract = {
      taskId: "dependency-task",
      version: 1,
      frozen: true,
      goals: ["Use dependencies"],
      dependsOn: [],
      readPaths: ["."],
      writePaths: ["src/out/"],
      sharedResources: [],
      baseCommit: "HEAD",
      verifyCommands: ["true"],
      maxRepairs: 0,
    };
    const contractsPath = join(repo, "contracts.json");
    writeFileSync(contractsPath, JSON.stringify(contract));

    const result = await runCodexBatch({
      contractsPath,
      repoRoot: repo,
      ledgerPath: join(repo, ".cliyard", "ledger.json"),
      dryRun: true,
      keepWorktrees: true,
    });

    assert.equal(result.allAccepted, true);
    for (const path of [
      result.integration.path,
      ...result.worktrees.map((worktree) => worktree.path),
    ]) {
      const modules = join(path, "node_modules");
      assert.equal(lstatSync(modules).isSymbolicLink(), true);
      assert.equal(readlinkSync(modules), join(repo, "node_modules"));
    }
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

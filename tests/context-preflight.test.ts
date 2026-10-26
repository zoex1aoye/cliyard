import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { runCodexBatch } from "../src/scheduler/codex-batch.js";

test("worker batch blocks untracked read context missing from worktrees", async () => {
  const repo = mkdtempSync(join(tmpdir(), "cliyard-context-"));
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
    writeFileSync(join(repo, "README.md"), "# tracked\n");
    spawnSync("git", ["add", "README.md"], { cwd: repo, stdio: "ignore" });
    spawnSync("git", ["commit", "-m", "init"], {
      cwd: repo,
      stdio: "ignore",
    });
    writeFileSync(join(repo, "design.md"), "# untracked design\n");
    const contracts = join(repo, "contracts.json");
    writeFileSync(
      contracts,
      JSON.stringify({
        contracts: [
          {
            taskId: "needs-design",
            version: 1,
            frozen: true,
            goals: ["Use hidden design"],
            dependsOn: [],
            readPaths: ["design.md"],
            writePaths: ["result.ts"],
            sharedResources: [],
            baseCommit: "HEAD",
            verifyCommands: ["true"],
            maxRepairs: 0,
          },
        ],
      }),
    );

    await assert.rejects(
      runCodexBatch({
        contractsPath: contracts,
        repoRoot: repo,
        ledgerPath: join(repo, ".cliyard", "ledger.json"),
        worker: "claude",
        dryRun: false,
      }),
      /readPath "design\.md" is untracked/,
    );
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

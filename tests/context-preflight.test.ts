import { test } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { runCodexBatch } from "../src/scheduler/codex-batch.js";

function runGit(repo: string, args: string[]): string {
  const result = spawnSync("git", args, { cwd: repo, encoding: "utf8" });
  assert.equal(
    result.status,
    0,
    `git ${args.join(" ")} failed: ${result.stderr}`,
  );
  return result.stdout.trim();
}

function initRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), "cliyard-context-"));
  runGit(repo, ["init"]);
  runGit(repo, ["config", "user.email", "t@t.com"]);
  runGit(repo, ["config", "user.name", "t"]);
  return repo;
}

function commitAll(repo: string, message: string): string {
  runGit(repo, ["add", "-A"]);
  runGit(repo, ["commit", "-m", message]);
  return runGit(repo, ["rev-parse", "HEAD"]);
}

interface ContractFixture {
  taskId: string;
  dependsOn?: string[];
  readPaths: string[];
  writePaths: string[];
}

function writeContracts(
  repo: string,
  baseCommit: string,
  tasks: ContractFixture[],
): string {
  const path = join(repo, "contracts.json");
  writeFileSync(
    path,
    JSON.stringify({
      contracts: tasks.map((task) => ({
        taskId: task.taskId,
        version: 1,
        frozen: true,
        goals: [`Run ${task.taskId}`],
        dependsOn: task.dependsOn ?? [],
        readPaths: task.readPaths,
        writePaths: task.writePaths,
        sharedResources: [],
        baseCommit,
        verifyCommands: ["true"],
        maxRepairs: 0,
      })),
    }),
  );
  return path;
}

async function runBatch(
  repo: string,
  contractsPath: string,
  keepWorktrees = false,
) {
  return runCodexBatch({
    contractsPath,
    repoRoot: repo,
    ledgerPath: join(repo, ".cliyard", "ledger.json"),
    worker: "claude",
    dryRun: true,
    keepWorktrees,
  });
}

test("worker batch validates read context at the pinned base, not current HEAD", async () => {
  const repo = initRepo();
  try {
    writeFileSync(join(repo, "README.md"), "# tracked\n");
    mkdirSync(join(repo, "design"), { recursive: true });
    writeFileSync(join(repo, "design", "upstream.md"), "# upstream\n");
    const base = commitAll(repo, "add upstream context");

    // The control checkout and HEAD move past the context the worker base has.
    rmSync(join(repo, "design", "upstream.md"));
    runGit(repo, ["add", "-A"]);
    runGit(repo, ["commit", "-m", "remove upstream context"]);
    assert.equal(existsSync(join(repo, "design", "upstream.md")), false);

    const contracts = writeContracts(repo, base, [
      {
        taskId: "needs-upstream",
        readPaths: ["design/upstream.md"],
        writePaths: ["result.ts"],
      },
    ]);

    const result = await runBatch(repo, contracts, true);

    assert.equal(result.allAccepted, true);
    assert.equal(result.worktrees.length, 1);
    // The worker worktree is created at the pinned base and can read the file.
    assert.equal(
      readFileSync(
        join(result.worktrees[0]!.path, "design", "upstream.md"),
        "utf8",
      ),
      "# upstream\n",
    );
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("worker batch rejects a readPath added after the pinned base", async () => {
  const repo = initRepo();
  try {
    writeFileSync(join(repo, "README.md"), "# tracked\n");
    const base = commitAll(repo, "init");
    writeFileSync(join(repo, "later.md"), "# added after base\n");
    const head = commitAll(repo, "add later context");
    assert.notEqual(head, base);

    const contracts = writeContracts(repo, base, [
      {
        taskId: "needs-later",
        readPaths: ["later.md"],
        writePaths: ["result.ts"],
      },
    ]);

    await assert.rejects(
      runBatch(repo, contracts),
      /readPath "later\.md" is absent from contracts base/,
    );
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("worker batch blocks untracked read context missing from worktrees", async () => {
  const repo = initRepo();
  try {
    writeFileSync(join(repo, "README.md"), "# tracked\n");
    commitAll(repo, "init");
    writeFileSync(join(repo, "design.md"), "# untracked design\n");
    const contracts = writeContracts(repo, "HEAD", [
      {
        taskId: "needs-design",
        readPaths: ["design.md"],
        writePaths: ["result.ts"],
      },
    ]);

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

test("worker batch keeps '.' and a missing optional AGENTS.md valid", async () => {
  const repo = initRepo();
  try {
    writeFileSync(join(repo, "README.md"), "# tracked\n");
    commitAll(repo, "init");
    assert.equal(existsSync(join(repo, "AGENTS.md")), false);

    const contracts = writeContracts(repo, "HEAD", [
      {
        taskId: "optional-context",
        readPaths: [".", "AGENTS.md"],
        writePaths: ["result.ts"],
      },
    ]);

    const result = await runBatch(repo, contracts);
    assert.equal(result.allAccepted, true);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("worker batch keeps task-produced read paths valid before the base has them", async () => {
  const repo = initRepo();
  try {
    writeFileSync(join(repo, "README.md"), "# tracked\n");
    commitAll(repo, "init");
    assert.equal(existsSync(join(repo, "foundation.txt")), false);

    const contracts = writeContracts(repo, "HEAD", [
      {
        taskId: "foundation",
        readPaths: ["."],
        writePaths: ["foundation.txt"],
      },
      {
        taskId: "upper",
        dependsOn: ["foundation"],
        readPaths: ["foundation.txt"],
        writePaths: ["result.ts"],
      },
    ]);

    const result = await runBatch(repo, contracts, true);

    assert.equal(result.allAccepted, true);
    assert.deepEqual(result.startOrder, ["foundation", "upper"]);
    const upper = result.worktrees.find((worktree) => worktree.taskId === "upper");
    assert.ok(upper, "the downstream worktree must exist");
    assert.equal(
      readFileSync(join(upper.path, "foundation.txt"), "utf8").trim(),
      "/* cliyard claude dry-run: foundation */",
    );
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

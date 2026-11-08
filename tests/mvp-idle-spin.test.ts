import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  assertLocalCliTaskContract,
  productPorcelainLines,
  runIdleSpin,
} from "../src/mvp/index.js";

function runGit(repo: string, args: string[]): void {
  const result = spawnSync("git", args, { cwd: repo, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr || result.stdout);
}

function initRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), "cliyard-mvp-idle-"));
  runGit(repo, ["init"]);
  runGit(repo, ["config", "user.email", "t@t.com"]);
  runGit(repo, ["config", "user.name", "t"]);
  writeFileSync(join(repo, "README.md"), "# fixture\n");
  runGit(repo, ["add", "."]);
  runGit(repo, ["commit", "-m", "init"]);
  return repo;
}

function loadFixtureContract() {
  const raw = JSON.parse(
    readFileSync(
      resolve("examples/mvp/code-local-cli.mock.contract.json"),
      "utf8",
    ),
  );
  return assertLocalCliTaskContract(raw);
}

test("idle-spin locks cwd to worktree and keeps trunk clean", async () => {
  const repo = initRepo();
  try {
    const contract = loadFixtureContract();
    const result = await runIdleSpin({
      repoRoot: repo,
      contract,
      replaceExisting: true,
    });
    assert.equal(result.ok, true, result.error);
    assert.equal(result.spawnCwd, result.worktreePath);
    assert.notEqual(result.worktreePath, resolve(repo));
    assert.equal(result.spawnExitCode, 0);
    assert.equal(result.trunkClean, true);
    assert.ok(
      existsSync(join(result.worktreePath, ".cliyard/mvp-echo/hello.txt")),
    );
    assert.equal(
      existsSync(join(repo, ".cliyard/mvp-echo/hello.txt")),
      false,
      "trunk must not receive worktree writes",
    );
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("idle-spin refuses unfrozen contract", async () => {
  const repo = initRepo();
  try {
    const contract = loadFixtureContract();
    contract.frozen = false;
    await assert.rejects(
      () => runIdleSpin({ repoRoot: repo, contract }),
      /frozen=true/,
    );
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("idle-spin fails closed when spawn cwd would be repoRoot", async () => {
  const repo = initRepo();
  try {
    const contract = loadFixtureContract();
    contract.workspace.path = ".";
    await assert.rejects(
      () => runIdleSpin({ repoRoot: repo, contract }),
      /must not resolve to repoRoot/,
    );
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("productPorcelainLines ignores .cliyard control-plane noise", () => {
  const repo = "/tmp/repo";
  const wt = "/tmp/repo/.cliyard/worktrees/mvp-echo-worktree";
  const lines = productPorcelainLines(
    "?? .cliyard/\n M README.md\n?? leak.txt\n",
    repo,
    wt,
  );
  assert.deepEqual(lines, [" M README.md", "?? leak.txt"]);
});

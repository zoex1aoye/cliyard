import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { runMvpDemo } from "../src/mvp/index.js";

function runGit(repo: string, args: string[]): void {
  const result = spawnSync("git", args, { cwd: repo, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr || result.stdout);
}

function initRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), "cliyard-mvp-demo-"));
  runGit(repo, ["init"]);
  runGit(repo, ["config", "user.email", "t@t.com"]);
  runGit(repo, ["config", "user.name", "t"]);
  writeFileSync(join(repo, "README.md"), "# fixture\n");
  runGit(repo, ["add", "."]);
  runGit(repo, ["commit", "-m", "init"]);
  return repo;
}

test("mvp-demo runs code+novel scenes and writes status.json", async () => {
  const repo = initRepo();
  try {
    const result = await runMvpDemo({
      repoRoot: repo,
      planPaths: [
        resolve("examples/mvp/code-codex.plan.json"),
        resolve("examples/mvp/novel-ep1.plan.json"),
      ],
      replaceExisting: true,
    });
    assert.equal(result.ok, true, JSON.stringify(result.scenes, null, 2));
    assert.equal(result.scenes.length, 2);
    const code = result.scenes.find((s) => s.scene === "code");
    const novel = result.scenes.find((s) => s.scene === "novel");
    assert.ok(code);
    assert.ok(novel);
    assert.equal(code!.target, "codex");
    assert.ok(
      code!.codexMode === "standin" || code!.codexMode === "live",
      `codexMode=${code!.codexMode}`,
    );
    assert.equal(novel!.workspaceKind, "assets");
    assert.ok(existsSync(result.statusPath));
    const status = JSON.parse(readFileSync(result.statusPath, "utf8")) as {
      ok: boolean;
      scenes: unknown[];
    };
    assert.equal(status.ok, true);
    assert.equal(status.scenes.length, 2);
    assert.ok(
      existsSync(
        join(repo, ".cliyard/assets/mvp-novel-ep1/episodes/ep1.md"),
      ),
    );
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

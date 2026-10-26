import { test } from "node:test";
import assert from "node:assert/strict";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { createCodexAdapter } from "../src/agents/codex.js";
import type { TaskContract } from "../src/contracts/schema.js";
import { createShellVerifier } from "../src/verification/verifier.js";

test("Codex path gate uses actual git changes relative to the baseline", async () => {
  const root = mkdtempSync(join(tmpdir(), "cliyard-real-paths-"));
  const oldPath = process.env.PATH;
  try {
    const repo = join(root, "repo");
    const bin = join(root, "bin");
    const dependencies = join(root, "dependencies");
    mkdirSync(repo);
    mkdirSync(bin);
    mkdirSync(dependencies);
    spawnSync("git", ["init"], { cwd: repo, stdio: "ignore" });
    spawnSync("git", ["config", "user.email", "t@t.com"], {
      cwd: repo,
      stdio: "ignore",
    });
    spawnSync("git", ["config", "user.name", "t"], {
      cwd: repo,
      stdio: "ignore",
    });
    writeFileSync(join(repo, "allowed.ts"), "export const ok = 1;\n");
    writeFileSync(join(repo, "forbidden.ts"), "export const no = 1;\n");
    spawnSync("git", ["add", "."], { cwd: repo, stdio: "ignore" });
    spawnSync("git", ["commit", "-m", "init"], {
      cwd: repo,
      stdio: "ignore",
    });
    const baseCommit = spawnSync("git", ["rev-parse", "HEAD"], {
      cwd: repo,
      encoding: "utf8",
    }).stdout.trim();
    symlinkSync(dependencies, join(repo, "node_modules"), "dir");

    const fakeCodex = join(bin, "codex");
    writeFileSync(
      fakeCodex,
      "#!/bin/sh\nprintf '\\nexport const changed = 2;\\n' >> forbidden.ts\necho fake-codex-ok\n",
    );
    chmodSync(fakeCodex, 0o755);
    process.env.PATH = `${bin}:${oldPath ?? ""}`;

    const contract: TaskContract = {
      taskId: "path-gate",
      version: 1,
      frozen: true,
      goals: ["Edit only allowed.ts"],
      dependsOn: [],
      readPaths: ["."],
      writePaths: ["allowed.ts"],
      sharedResources: [],
      baseCommit,
      verifyCommands: ["true"],
      maxRepairs: 0,
    };
    const worker = createCodexAdapter({ cwd: repo, model: "test" });
    const { sessionId } = await worker.start({ contract, attempt: 0 });
    const agent = await worker.collect(sessionId);
    assert.equal(agent.exitCode, 0);
    assert.deepEqual(agent.touchedPaths, ["forbidden.ts"]);

    const verify = await createShellVerifier({ cwd: repo }).run(
      contract,
      agent,
    );
    assert.equal(verify.ok, false);
    assert.match(verify.logTail, /path overshoot/);
  } finally {
    process.env.PATH = oldPath;
    rmSync(root, { recursive: true, force: true });
  }
});

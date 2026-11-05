import { test } from "node:test";
import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, sep } from "node:path";
import { spawnSync } from "node:child_process";
import { createCodexAdapter } from "../src/agents/codex.js";
import type { AgentAdapter } from "../src/agents/types.js";
import type { TaskContract } from "../src/contracts/schema.js";
import {
  assertTaskWorktreeCwd,
  runCodexBatch,
  WorkerCwdGuardError,
} from "../src/scheduler/codex-batch.js";
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

// ---------------------------------------------------------------------------
// Worker/verifier cwd guard (design/self-host-worker-isolation-v0.md)
// ---------------------------------------------------------------------------

test("worker cwd guard rejects the repository root before any spawn or write", () => {
  const root = mkdtempSync(join(tmpdir(), "cliyard-cwd-guard-"));
  try {
    const repo = join(root, "repo");
    const worktree = join(repo, ".cliyard", "worktrees", "task-1");
    mkdirSync(worktree, { recursive: true });
    writeFileSync(join(repo, "README.md"), "# fixture\n");

    const base = {
      repoRoot: repo,
      taskId: "task-1",
      role: "worker" as const,
      expectedWorktree: worktree,
    };
    const rejects = (cwd: string | undefined, pattern: RegExp) =>
      assert.throws(
        () => assertTaskWorktreeCwd({ ...base, cwd }),
        (error: unknown) =>
          error instanceof WorkerCwdGuardError &&
          /^worker-cwd-guard:/.test(error.message) &&
          pattern.test(error.message),
      );

    rejects(repo, /repository root/);
    rejects(undefined, /missing/);
    rejects("", /missing/);
    rejects(relative(process.cwd(), worktree), /absolute/);
    rejects(join(repo, "does-not-exist"), /does not exist/);
    rejects(join(repo, "README.md"), /not a directory/);

    // A symlink that resolves to the repository root is still the root.
    const rootLink = join(root, "repo-link");
    symlinkSync(repo, rootLink, "dir");
    rejects(rootLink, /repository root/);

    // A sibling task worktree is not the prepared worktree for this task.
    const sibling = join(repo, ".cliyard", "worktrees", "task-2");
    mkdirSync(sibling, { recursive: true });
    assert.throws(
      () => assertTaskWorktreeCwd({ ...base, cwd: sibling }),
      /worker-cwd-guard:.*not the prepared task worktree/,
    );
    assert.throws(
      () =>
        assertTaskWorktreeCwd({
          repoRoot: repo,
          taskId: "task-1",
          role: "verifier",
          cwd: repo,
          expectedWorktree: worktree,
        }),
      /worker-cwd-guard: verifier cwd for task task-1.*repository root/,
    );

    // Dispatching only after the guard passes means a rejected cwd can never
    // reach spawn or write a file.
    let spawned = false;
    const dispatch = (cwd: string) => {
      assertTaskWorktreeCwd({ ...base, cwd });
      spawned = true;
      writeFileSync(join(cwd, "task.ts"), "written\n");
    };
    assert.throws(() => dispatch(repo), /worker-cwd-guard/);
    assert.equal(spawned, false);
    assert.equal(existsSync(join(repo, "task.ts")), false);

    assert.equal(assertTaskWorktreeCwd({ ...base, cwd: worktree }), worktree);
    dispatch(worktree);
    assert.equal(spawned, true);
    assert.equal(existsSync(join(worktree, "task.ts")), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("batch dispatches every worker with its absolute task worktree cwd", async () => {
  const root = mkdtempSync(join(tmpdir(), "cliyard-batch-cwd-"));
  try {
    const repo = join(root, "repo");
    mkdirSync(repo);
    spawnSync("git", ["init"], { cwd: repo, stdio: "ignore" });
    spawnSync("git", ["config", "user.email", "t@t.com"], {
      cwd: repo,
      stdio: "ignore",
    });
    spawnSync("git", ["config", "user.name", "t"], {
      cwd: repo,
      stdio: "ignore",
    });
    writeFileSync(join(repo, "README.md"), "# fixture\n");
    spawnSync("git", ["add", "."], { cwd: repo, stdio: "ignore" });
    spawnSync("git", ["commit", "-m", "init"], {
      cwd: repo,
      stdio: "ignore",
    });
    const baseCommit = spawnSync("git", ["rev-parse", "HEAD"], {
      cwd: repo,
      encoding: "utf8",
    }).stdout.trim();
    const contract: TaskContract = {
      taskId: "cwd-task",
      version: 1,
      frozen: true,
      goals: ["Write task.ts in the task worktree"],
      dependsOn: [],
      readPaths: ["."],
      writePaths: ["task.ts"],
      sharedResources: [],
      baseCommit,
      verifyCommands: ["test -f task.ts"],
      maxRepairs: 0,
    };
    const contractsPath = join(repo, "contracts.json");
    writeFileSync(
      contractsPath,
      `${JSON.stringify({ contracts: [contract] }, null, 2)}\n`,
    );

    const seen: string[] = [];
    const workerFactory = (_worker: "codex" | "claude", cwd: string) => {
      seen.push(cwd);
      const worker: AgentAdapter = {
        id: "claude",
        async discover() {
          return {
            id: "claude",
            ok: true,
            supportsModelFlag: true,
            notes: ["cwd fixture"],
          };
        },
        async start(input) {
          return { sessionId: `fixture-${input.contract.taskId}` };
        },
        async collect(sessionId) {
          writeFileSync(
            join(cwd, "task.ts"),
            "export const ok = true;\n",
          );
          return {
            sessionId,
            exitCode: 0,
            touchedPaths: ["task.ts"],
            logTail: "[fixture] wrote task.ts",
          };
        },
        async cancel() {},
      };
      return worker;
    };

    const result = await runCodexBatch({
      contractsPath,
      repoRoot: repo,
      ledgerPath: join(repo, ".cliyard", "ledger.json"),
      worker: "claude",
      dryRun: false,
      keepWorktrees: true,
      workerFactory,
    });

    assert.equal(result.allAccepted, true);
    assert.equal(seen.length, 1);
    const cwd = seen[0]!;
    assert.ok(isAbsolute(cwd), `worker cwd must be absolute: ${cwd}`);
    assert.notEqual(cwd, repo, "worker must never spawn at the repository root");
    assert.equal(
      relative(repo, cwd).startsWith(`.cliyard${sep}worktrees${sep}`),
      true,
      `worker cwd must be inside the task worktree root: ${cwd}`,
    );
    assert.equal(existsSync(join(cwd, "task.ts")), true);
    assert.equal(
      existsSync(join(repo, "task.ts")),
      false,
      "the worker must not write into the authority checkout",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

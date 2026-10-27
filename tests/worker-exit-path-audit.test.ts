import { test } from "node:test";
import assert from "node:assert/strict";
import {
  chmodSync,
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
import {
  auditPathScope,
  normalizeRepositoryRelativePath,
} from "../src/agents/path-scope.js";
import { createClaudeAdapter } from "../src/agents/claude.js";
import { createCodexAdapter } from "../src/agents/codex.js";
import type {
  AgentAdapter,
  AgentResult,
  AgentStartInput,
} from "../src/agents/types.js";
import type { TaskContract } from "../src/contracts/schema.js";
import {
  createFailureRecord,
} from "../src/failures.js";
import { runClosedLoop } from "../src/repair/loop.js";
import { runCodexBatch } from "../src/scheduler/codex-batch.js";
import {
  createRunManifest,
  loadRunManifest,
  runManifestPath,
} from "../src/supervisor/store.js";
import type {
  Verifier,
  VerifyResult,
} from "../src/verification/verifier.js";

const TASK_ID = "path-audit-task";
const ALLOWED = "allowed.txt";

function contract(baseCommit = "HEAD"): TaskContract {
  return {
    taskId: TASK_ID,
    version: 1,
    frozen: true,
    goals: ["Audit all worker exits"],
    dependsOn: [],
    readPaths: [],
    writePaths: [ALLOWED],
    sharedResources: [],
    baseCommit,
    verifyCommands: ["true"],
    maxRepairs: 0,
  };
}

function fakeWorker(options: {
  cwd: string;
  result: (sessionId: string) => AgentResult;
  onCollect?: () => void;
}): AgentAdapter {
  return {
    id: "claude",
    async discover() {
      return {
        id: "claude",
        ok: true,
        supportsModelFlag: true,
        notes: ["path-audit fixture"],
      };
    },
    async start(_input: AgentStartInput) {
      return { sessionId: "path-audit-session" };
    },
    async collect(sessionId: string) {
      options.onCollect?.();
      return options.result(sessionId);
    },
    async cancel() {},
  };
}

function verifier(ok: boolean): Verifier {
  return {
    async run(): Promise<VerifyResult> {
      return {
        ok,
        exitCode: ok ? 0 : 1,
        commandResults: [],
        logTail: ok ? "fixture accepted" : "fixture rejected",
      };
    },
  };
}

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
  const repo = mkdtempSync(join(tmpdir(), "cliyard-path-audit-"));
  runGit(repo, ["init"]);
  runGit(repo, ["config", "user.email", "t@t.com"]);
  runGit(repo, ["config", "user.name", "t"]);
  writeFileSync(join(repo, "README.md"), "# fixture\n");
  runGit(repo, ["add", "."]);
  runGit(repo, ["commit", "-m", "init"]);
  return repo;
}

function writeContracts(
  repo: string,
  value: TaskContract,
): string {
  const path = join(repo, "path-audit-contracts.json");
  writeFileSync(
    path,
    JSON.stringify({ contracts: [value] }, null, 2) + "\n",
    "utf8",
  );
  return path;
}

test("failed exit records outside-scope evidence without replacing its failure", async () => {
  const root = mkdtempSync(join(tmpdir(), "cliyard-loop-path-audit-"));
  const outside = "docs/NEXT_STEP_CONTROLLER.md.tmp.33075.d6472a8bc100";
  const budgetFailure = createFailureRecord({
    subtype: "error_max_budget_usd",
    exitCode: 1,
    text: "provider budget exhausted",
  });
  try {
    const result = await runClosedLoop({
      contract: {
        ...contract(),
        writePaths: ["src/allowed.ts"],
      },
      worker: fakeWorker({
        cwd: root,
        result: (sessionId): AgentResult => ({
          sessionId,
          exitCode: 1,
          touchedPaths: ["src\\allowed.ts", outside],
          changedPathsError: "git diff exited 128",
          logTail: "worker budget exhausted",
          failure: budgetFailure,
        }),
      }),
      verifier: verifier(false),
      ledgerPath: join(root, ".cliyard", "ledger.json"),
    });

    assert.equal(result.verdict, "rejected");
    assert.equal(result.reason, "implement failed: exitCode=1");
    assert.equal(result.failure?.category, "budget_exhausted");
    assert.equal(result.failure?.code, budgetFailure.code);
    assert.equal(result.pathAudits.length, 1);
    assert.deepEqual(result.pathAudits[0], {
      attempt: 0,
      observedAt: result.pathAudits[0]!.observedAt,
      exitCode: 1,
      changedPaths: ["src/allowed.ts", outside],
      outsideWritePaths: [outside],
      changedPathsError: "git diff exited 128",
    });
    assert.ok(!Number.isNaN(Date.parse(result.pathAudits[0]!.observedAt)));
    assert.equal(
      result.events.some(
        (event) =>
          event.type === "path.audit" &&
          event.detail?.includes(outside),
      ),
      true,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("accepted worker exits retain bounded path audit evidence", async () => {
  const root = mkdtempSync(join(tmpdir(), "cliyard-loop-path-accepted-"));
  try {
    const result = await runClosedLoop({
      contract: {
        ...contract(),
        writePaths: ["src/"],
      },
      worker: fakeWorker({
        cwd: root,
        result: (sessionId): AgentResult => ({
          sessionId,
          exitCode: 0,
          touchedPaths: ["src\\nested\\item.ts"],
          logTail: "worker completed",
        }),
      }),
      verifier: verifier(true),
      ledgerPath: join(root, ".cliyard", "ledger.json"),
    });

    assert.equal(result.verdict, "accepted");
    assert.equal(result.pathAudits.length, 1);
    assert.deepEqual(result.pathAudits[0]?.changedPaths, [
      "src/nested/item.ts",
    ]);
    assert.deepEqual(result.pathAudits[0]?.outsideWritePaths, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("path audit rejects traversal and absolute evidence and normalizes separators", () => {
  assert.equal(normalizeRepositoryRelativePath("src\\nested\\file.ts"), "src/nested/file.ts");
  assert.equal(normalizeRepositoryRelativePath("../escape.ts"), undefined);
  assert.equal(normalizeRepositoryRelativePath("/tmp/escape.ts"), undefined);
  assert.equal(normalizeRepositoryRelativePath("C:\\tmp\\escape.ts"), undefined);

  const result = auditPathScope(
    ["src/", "README.md"],
    [
      "src\\allowed.ts",
      "src/../escape.ts",
      "/tmp/absolute.ts",
      "C:\\tmp\\drive.ts",
      "README.md",
      "README.md/child",
    ],
  );
  assert.deepEqual(result.changedPaths, [
    "src/allowed.ts",
    "src/../escape.ts",
    "/tmp/absolute.ts",
    "C:/tmp/drive.ts",
    "README.md",
    "README.md/child",
  ]);
  assert.deepEqual(result.outsideWritePaths, [
    "src/../escape.ts",
    "/tmp/absolute.ts",
    "C:/tmp/drive.ts",
    "README.md/child",
  ]);

  const bounded = auditPathScope(
    ["allowed/"],
    Array.from({ length: 10 }, (_, index) => `other/${index}.tmp`),
    { maxPaths: 3 },
  );
  assert.equal(bounded.changedPaths.length, 3);
  assert.equal(bounded.outsideWritePaths.length, 3);
});

test("Claude and Codex expose changed-path collection failure separately", async () => {
  const repo = initRepo();
  const binaries = mkdtempSync(join(tmpdir(), "cliyard-path-audit-bins-"));
  try {
    const claudeBinary = join(binaries, "claude");
    const codexBinary = join(binaries, "codex");
    writeFileSync(
      claudeBinary,
      "#!/bin/sh\nprintf '%s\\n' '{\"type\":\"result\",\"is_error\":false,\"result\":\"ok\"}'\n",
    );
    writeFileSync(codexBinary, "#!/bin/sh\nexit 0\n");
    chmodSync(claudeBinary, 0o755);
    chmodSync(codexBinary, 0o755);

    const missingBase = "refs/heads/does-not-exist";
    const value = contract(missingBase);
    const claude = createClaudeAdapter({
      binary: claudeBinary,
      cwd: repo,
      model: "test",
      maxTransientRetries: 0,
    });
    const codex = createCodexAdapter({
      binary: codexBinary,
      cwd: repo,
      model: "test",
    });

    for (const adapter of [claude, codex]) {
      const { sessionId } = await adapter.start({
        contract: value,
        attempt: 0,
      });
      const result = await adapter.collect(sessionId);
      assert.equal(result.exitCode, 1, adapter.id);
      assert.equal(typeof result.changedPathsError, "string", adapter.id);
      assert.ok(result.changedPathsError!.length > 0, adapter.id);
      assert.equal(
        result.changedPathsError!.length <= 2_000,
        true,
        adapter.id,
      );
    }
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(binaries, { recursive: true, force: true });
  }
});

test("manifest store keeps pathAudits optional and rejects malformed present evidence", () => {
  const repo = initRepo();
  try {
    const base = runGit(repo, ["rev-parse", "HEAD"]);
    const value = contract(base);
    const contractsPath = writeContracts(repo, value);
    const manifest = createRunManifest(repo, {
      planId: "path-audit-manifest",
      contractsPath,
      baseCommit: base,
      integrationBranch: "cliyard/integration/path-audit-manifest",
      tasks: [TASK_ID],
    });

    const legacy = loadRunManifest(repo, manifest.runId);
    assert.equal(legacy.tasks[TASK_ID]?.pathAudits, undefined);

    const path = runManifestPath(repo, manifest.runId);
    const raw = JSON.parse(readFileSync(path, "utf8")) as {
      tasks: Record<string, Record<string, unknown>>;
    };
    raw.tasks[TASK_ID]!.pathAudits = [
      {
        attempt: 0,
        observedAt: "2026-10-28T00:00:00.000Z",
        exitCode: 1,
        changedPaths: ["../outside.tmp"],
        outsideWritePaths: ["../outside.tmp"],
      },
    ];
    writeFileSync(path, JSON.stringify(raw, null, 2) + "\n", "utf8");
    const withEvidence = loadRunManifest(repo, manifest.runId);
    assert.deepEqual(
      withEvidence.tasks[TASK_ID]?.pathAudits?.[0]?.outsideWritePaths,
      ["../outside.tmp"],
    );

    raw.tasks[TASK_ID]!.pathAudits = [
      {
        attempt: 0,
        observedAt: "2026-10-28T00:00:00.000Z",
        exitCode: 1,
        changedPaths: "not-an-array",
        outsideWritePaths: [],
      },
    ];
    writeFileSync(path, JSON.stringify(raw, null, 2) + "\n", "utf8");
    assert.throws(
      () => loadRunManifest(repo, manifest.runId),
      /pathAudits\[0\]\.changedPaths must be an array/,
    );
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("accepted worker results checkpoint path audits in the run manifest", async () => {
  const repo = initRepo();
  try {
    const base = runGit(repo, ["rev-parse", "HEAD"]);
    const contractsPath = writeContracts(repo, {
      ...contract(base),
      verifyCommands: ["test -f allowed.txt"],
      maxRepairs: 1,
    });
    const manifest = createRunManifest(repo, {
      planId: "path-audit-accepted",
      contractsPath,
      baseCommit: base,
      integrationBranch: "cliyard/integration/path-audit-accepted",
      tasks: [TASK_ID],
    });

    let collects = 0;
    const batch = await runCodexBatch({
      contractsPath,
      repoRoot: repo,
      runManifest: manifest,
      worker: "claude",
      workerFactory: (_worker, cwd) =>
        fakeWorker({
          cwd,
          result: (sessionId): AgentResult => {
            collects += 1;
            if (collects > 1) {
              writeFileSync(join(cwd, ALLOWED), "accepted\n", "utf8");
            }
            return {
              sessionId,
              exitCode: 0,
              touchedPaths: [ALLOWED],
              logTail: "accepted fixture",
            };
          },
        }),
    });

    assert.equal(batch.allAccepted, true);
    const task = loadRunManifest(repo, manifest.runId).tasks[TASK_ID]!;
    assert.equal(task.accepted, true);
    assert.equal(task.pathAudits?.length, 2);
    assert.deepEqual(
      task.pathAudits?.map((audit) => audit.attempt),
      [0, 1],
    );
    assert.deepEqual(task.pathAudits?.[0]?.changedPaths, [ALLOWED]);
    assert.deepEqual(task.pathAudits?.[1]?.changedPaths, [ALLOWED]);
    assert.deepEqual(task.pathAudits?.[0]?.outsideWritePaths, []);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("reused rejected worktree is audited and rejected before worker invocation", async () => {
  const repo = initRepo();
  try {
    const base = runGit(repo, ["rev-parse", "HEAD"]);
    const contractsPath = writeContracts(repo, contract(base));
    const manifest = createRunManifest(repo, {
      planId: "path-audit-reuse",
      contractsPath,
      baseCommit: base,
      integrationBranch: "cliyard/integration/path-audit-reuse",
      tasks: [TASK_ID],
    });

    let firstDispatches = 0;
    const first = await runCodexBatch({
      contractsPath,
      repoRoot: repo,
      runManifest: manifest,
      worker: "claude",
      workerFactory: (_worker, cwd) =>
        fakeWorker({
          cwd,
          onCollect: () => {
            firstDispatches += 1;
          },
          result: (sessionId): AgentResult => {
            writeFileSync(join(cwd, ALLOWED), "draft\n", "utf8");
            return {
              sessionId,
              exitCode: 1,
              touchedPaths: [ALLOWED],
              logTail: "fixture failure",
            };
          },
        }),
    });
    assert.equal(firstDispatches, 1);
    assert.equal(first.allAccepted, false);

    const rejected = loadRunManifest(repo, manifest.runId);
    const rejectedTask = rejected.tasks[TASK_ID]!;
    assert.equal(rejectedTask.pathAudits?.length, 1);
    const worktree = rejectedTask.attemptWorktree!;
    const unexpected = "docs/editor.tmp.999";
    mkdirSync(join(worktree, "docs"), { recursive: true });
    writeFileSync(join(worktree, "docs", "editor.tmp.999"), "temp\n", {
      flag: "w",
    });

    let reusedDispatches = 0;
    await assert.rejects(
      runCodexBatch({
        contractsPath,
        repoRoot: repo,
        runManifest: rejected,
        reuseAttempts: true,
        worker: "claude",
        workerFactory: (_worker, cwd) =>
          fakeWorker({
            cwd,
            onCollect: () => {
              reusedDispatches += 1;
            },
            result: (sessionId): AgentResult => ({
              sessionId,
              exitCode: 0,
              touchedPaths: [ALLOWED],
              logTail: "must not run",
            }),
          }),
      }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /cannot be reused before worker dispatch/);
        assert.ok(error.message.includes(unexpected), error.message);
        assert.match(error.message, /No files were removed/);
        return true;
      },
    );
    assert.equal(reusedDispatches, 0);
    assert.equal(
      readFileSync(join(worktree, unexpected), "utf8"),
      "temp\n",
    );
    assert.equal(
      existsSync(join(worktree, unexpected)),
      true,
      "unexpected files must remain for human review",
    );

    let freshDispatches = 0;
    const fresh = await runCodexBatch({
      contractsPath,
      repoRoot: repo,
      runManifest: loadRunManifest(repo, manifest.runId),
      reuseAttempts: false,
      worker: "claude",
      workerFactory: (_worker, cwd) =>
        fakeWorker({
          cwd,
          onCollect: () => {
            freshDispatches += 1;
          },
          result: (sessionId): AgentResult => {
            writeFileSync(join(cwd, ALLOWED), "fresh\n", "utf8");
            return {
              sessionId,
              exitCode: 0,
              touchedPaths: [ALLOWED],
              logTail: "fresh attempt accepted",
            };
          },
        }),
    });
    assert.equal(fresh.allAccepted, true);
    assert.equal(freshDispatches, 1);
    const accepted = loadRunManifest(repo, manifest.runId).tasks[TASK_ID]!;
    assert.equal(accepted.accepted, true);
    assert.equal(accepted.pathAudits?.length, 2);
    assert.equal(existsSync(join(worktree, unexpected)), true);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

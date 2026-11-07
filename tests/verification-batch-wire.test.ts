import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TaskContract } from "../src/contracts/schema.js";
import type { AgentResult } from "../src/agents/types.js";
import {
  createBackgroundVerifier,
  isBackgroundVerificationEnabled,
  listVerificationTasks,
  putVerificationTaskForTest,
  recoverVerificationTasks,
  VERIFICATION_TASK_SPEC_VERSION,
  type VerificationTask,
} from "../src/verification/index.js";
import { runClosedLoop } from "../src/repair/loop.js";
import type { AgentAdapter } from "../src/agents/types.js";

function initRepo(): { repo: string; head: string } {
  const repo = mkdtempSync(join(tmpdir(), "cliyard-vbw-"));
  const git = (args: string[]) => {
    const r = spawnSync("git", args, { cwd: repo, encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr || r.stdout);
    return (r.stdout || "").trim();
  };
  git(["init"]);
  git(["config", "user.email", "vbw@example.com"]);
  git(["config", "user.name", "vbw"]);
  writeFileSync(join(repo, "README.md"), "vbw\n", "utf8");
  git(["add", "."]);
  git(["commit", "-m", "init"]);
  return { repo, head: git(["rev-parse", "HEAD"]) };
}

function contract(base: string, commands: string[]): TaskContract {
  return {
    taskId: "verification-batch-wire",
    version: 1,
    frozen: true,
    goals: ["noop"],
    nonGoals: [],
    dependsOn: [],
    readPaths: ["README.md"],
    writePaths: ["src/"],
    sharedResources: [],
    baseCommit: base,
    verifyCommands: commands,
    deliverables: ["noop"],
    forbidden: [],
    maxRepairs: 0,
  };
}

function okAgent(sessionId: string): AgentResult {
  return {
    sessionId,
    exitCode: 0,
    touchedPaths: ["src/ok.txt"],
    logTail: "ok",
  };
}

test("isBackgroundVerificationEnabled respects flag and env", () => {
  assert.equal(isBackgroundVerificationEnabled({ backgroundVerification: true }), true);
  assert.equal(
    isBackgroundVerificationEnabled(
      { backgroundVerification: false },
      { CLIYARD_BACKGROUND_VERIFY: "1" },
    ),
    false,
  );
  assert.equal(
    isBackgroundVerificationEnabled(undefined, { CLIYARD_BACKGROUND_VERIFY: "1" }),
    true,
  );
  assert.equal(isBackgroundVerificationEnabled(undefined, {}), false);
});

test("createBackgroundVerifier succeeds and attaches observation", async () => {
  const { repo, head } = initRepo();
  try {
    const verifier = createBackgroundVerifier({
      repoRoot: repo,
      worktree: repo,
      runId: "run-bg",
      contractsHash: "h",
      resolveArtifactCommit: () => head,
    });
    const result = await verifier.run(contract(head, ["printf 'bg-ok\\n'", "true"]), okAgent("s1"));
    assert.equal(result.ok, true);
    assert.ok(result.verification);
    assert.equal(result.verification!.status, "succeeded");
    assert.ok(result.verification!.deliveredAt);
    assert.ok(result.verification!.outputOffset > 0);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("createBackgroundVerifier refuses contract.runtime", async () => {
  const { repo, head } = initRepo();
  try {
    const verifier = createBackgroundVerifier({
      repoRoot: repo,
      worktree: repo,
      resolveArtifactCommit: () => head,
    });
    const withRuntime: TaskContract = {
      ...contract(head, ["true"]),
      runtime: {
        services: [
          {
            name: "web",
            command: ["true"],
          },
        ],
      },
    };
    const result = await verifier.run(withRuntime, okAgent("s2"));
    assert.equal(result.ok, false);
    assert.match(result.logTail, /contract\.runtime/);
    assert.equal(result.verification, undefined);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("runClosedLoop threads verification observation on accept", async () => {
  const { repo, head } = initRepo();
  try {
    const worker: AgentAdapter = {
      id: "fixture",
      discover: async () => ({
        id: "fixture",
        ok: true,
        supportsModelFlag: false,
        notes: [],
      }),
      start: async () => ({ sessionId: "fx-1" }),
      collect: async () => okAgent("fx-1"),
      cancel: async () => undefined,
    };
    const verifier = createBackgroundVerifier({
      repoRoot: repo,
      worktree: repo,
      runId: "run-loop",
      contractsHash: "h",
      resolveArtifactCommit: () => head,
    });
    const result = await runClosedLoop({
      contract: contract(head, ["true"]),
      worker,
      verifier,
      ledgerPath: join(repo, "ledger.json"),
    });
    assert.equal(result.verdict, "accepted");
    assert.ok(result.verification);
    assert.equal(result.verification!.status, "succeeded");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("batch-style recovery at start marks orphaned running lost", async () => {
  const { repo, head } = initRepo();
  try {
    const orphan: VerificationTask = {
      id: "vt-batch-orphan",
      runId: "run",
      taskId: "t",
      artifactCommit: head,
      contractsHash: "h",
      specVersion: VERIFICATION_TASK_SPEC_VERSION,
      commands: ["true"],
      status: "running",
      ownerIdentity: {
        pid: 9_999_999,
        pgid: 9_999_999,
        startedAt: "Thu Jan  1 00:00:00 1970",
      },
      output: {
        uri: join(repo, ".cliyard/verification/vt-batch-orphan/output.log"),
        offset: 0,
      },
      evidenceRefs: [],
      worktreeCwd: repo,
      startedAt: "2026-11-07T00:00:00.000Z",
    };
    putVerificationTaskForTest(repo, orphan);
    const recovered = await recoverVerificationTasks({ repoRoot: repo });
    assert.equal(recovered.markedLost.length, 1);
    assert.equal(listVerificationTasks(repo)[0]?.status, "lost");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

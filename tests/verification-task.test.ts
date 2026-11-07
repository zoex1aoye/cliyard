import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  VERIFICATION_TASK_SPEC_VERSION,
  awaitVerificationTask,
  isTerminalVerificationStatus,
  loadVerificationTask,
  markVerificationDelivered,
  putVerificationTaskForTest,
  recoverVerificationTasks,
  startVerificationTask,
  type VerificationTask,
} from "../src/verification/index.js";

function initRepo(): { repo: string; head: string } {
  const repo = mkdtempSync(join(tmpdir(), "cliyard-vt-"));
  const git = (args: string[]) => {
    const r = spawnSync("git", args, { cwd: repo, encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr || r.stdout);
    return (r.stdout || "").trim();
  };
  git(["init"]);
  git(["config", "user.email", "vt@example.com"]);
  git(["config", "user.name", "vt"]);
  writeFileSync(join(repo, "README.md"), "vt\n", "utf8");
  git(["add", "."]);
  git(["commit", "-m", "init"]);
  return { repo, head: git(["rev-parse", "HEAD"]) };
}

test("verification output offset advances and delivery latch is idempotent", async () => {
  const { repo, head } = initRepo();
  try {
    const { task } = await startVerificationTask({
      repoRoot: repo,
      worktreeCwd: repo,
      runId: "run-1",
      taskId: "t1",
      artifactCommit: head,
      contractsHash: "hash",
      commands: ["printf 'hello-verify\\n'", "true"],
    });
    assert.equal(task.specVersion, VERIFICATION_TASK_SPEC_VERSION);
    assert.equal(task.status, "running");

    const done = await awaitVerificationTask(repo, task.id, {
      timeoutMs: 15_000,
    });
    assert.equal(done.status, "succeeded");
    assert.ok(done.output.offset > 0);
    const log = readFileSync(done.output.uri, "utf8");
    assert.match(log, /hello-verify/);

    const first = markVerificationDelivered(repo, task.id, () => "2026-11-07T00:00:00.000Z");
    assert.equal(first.deliveredAt, "2026-11-07T00:00:00.000Z");
    const second = markVerificationDelivered(repo, task.id, () => "2026-11-07T99:99:99.000Z");
    assert.equal(second.deliveredAt, "2026-11-07T00:00:00.000Z");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("verification survives after the starter process exits", async () => {
  const { repo, head } = initRepo();
  try {
    // Spawn a short-lived Node parent that starts a long verify then exits.
    const starter = `
      const { startVerificationTask } = require(${JSON.stringify(join(process.cwd(), "dist/verification/task-runner.js"))});
      const { writeFileSync } = require("node:fs");
      (async () => {
        const result = await startVerificationTask({
          repoRoot: ${JSON.stringify(repo)},
          worktreeCwd: ${JSON.stringify(repo)},
          runId: "run-survive",
          taskId: "t-survive",
          artifactCommit: ${JSON.stringify(head)},
          contractsHash: "hash",
          commands: ["sleep 0.4", "printf 'still-here\\\\n'"],
          id: "vt-survive",
        });
        writeFileSync(${JSON.stringify(join(repo, "started.json"))}, JSON.stringify({ id: result.task.id, pid: result.workerPid }));
        process.exit(0);
      })().catch((e) => { console.error(e); process.exit(1); });
    `;
    const starterPath = join(repo, "starter.cjs");
    writeFileSync(starterPath, starter, "utf8");
    const parent = spawnSync(process.execPath, [starterPath], {
      encoding: "utf8",
      timeout: 10_000,
    });
    assert.equal(parent.status, 0, parent.stderr || parent.stdout);
    const started = JSON.parse(readFileSync(join(repo, "started.json"), "utf8")) as {
      id: string;
      pid: number;
    };
    assert.equal(started.id, "vt-survive");

    const done = await awaitVerificationTask(repo, started.id, {
      timeoutMs: 15_000,
    });
    assert.equal(done.status, "succeeded", JSON.stringify(done));
    assert.match(readFileSync(done.output.uri, "utf8"), /still-here/);
    assert.ok(isTerminalVerificationStatus(done.status));
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("recovery marks orphaned running tasks as lost, never succeeded", async () => {
  const { repo, head } = initRepo();
  try {
    const orphan: VerificationTask = {
      id: "vt-orphan",
      runId: "run-orphan",
      taskId: "t-orphan",
      artifactCommit: head,
      contractsHash: "hash",
      specVersion: VERIFICATION_TASK_SPEC_VERSION,
      commands: ["true"],
      status: "running",
      ownerIdentity: {
        pid: 8_888_888,
        pgid: 8_888_888,
        startedAt: "Thu Jan  1 00:00:00 1970",
      },
      output: { uri: join(repo, ".cliyard/verification/vt-orphan/output.log"), offset: 0 },
      evidenceRefs: [],
      worktreeCwd: repo,
      startedAt: "2026-11-07T00:00:00.000Z",
    };
    putVerificationTaskForTest(repo, orphan);

    const result = await recoverVerificationTasks({
      repoRoot: repo,
      now: () => "2026-11-07T01:00:00.000Z",
    });
    assert.equal(result.reviewed, 1);
    assert.equal(result.markedLost.length, 1);
    assert.equal(result.leftRunning.length, 0);
    assert.equal(result.markedLost[0]!.status, "lost");
    assert.notEqual(result.markedLost[0]!.status, "succeeded");
    assert.equal(result.markedLost[0]!.endedAt, "2026-11-07T01:00:00.000Z");
    assert.equal(
      result.markedLost[0]!.lastError?.code,
      "verification_identity_unknown",
    );

    const reloaded = loadVerificationTask(repo, "vt-orphan");
    assert.equal(reloaded?.status, "lost");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("failed command yields failed status with offset", async () => {
  const { repo, head } = initRepo();
  try {
    const { task } = await startVerificationTask({
      repoRoot: repo,
      worktreeCwd: repo,
      runId: "run-fail",
      taskId: "t-fail",
      artifactCommit: head,
      contractsHash: "hash",
      commands: ["printf 'before\\n'", "false"],
    });
    const done = await awaitVerificationTask(repo, task.id, { timeoutMs: 15_000 });
    assert.equal(done.status, "failed");
    assert.ok(done.output.offset > 0);
    assert.match(readFileSync(done.output.uri, "utf8"), /before/);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

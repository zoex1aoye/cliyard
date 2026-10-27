import { test } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import type {
  AgentAdapter,
  AgentResult,
  AgentStartInput,
} from "../src/agents/types.js";
import type { TaskContract } from "../src/contracts/schema.js";
import { runSupervisorCli } from "../src/supervisor/cli.js";
import {
  createRunManifest,
  loadRunManifest,
  runManifestPath,
  saveRunManifest,
} from "../src/supervisor/store.js";
import type { RunTaskState } from "../src/supervisor/types.js";

const TASK_ID = "draft-task";
const DRAFT = "draft.txt";
const FINAL = "final.txt";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

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
  const repo = mkdtempSync(join(tmpdir(), "cliyard-attempt-reuse-"));
  runGit(repo, ["init"]);
  runGit(repo, ["config", "user.email", "t@t.com"]);
  runGit(repo, ["config", "user.name", "t"]);
  writeFileSync(join(repo, "README.md"), "# fixture\n");
  runGit(repo, ["add", "."]);
  runGit(repo, ["commit", "-m", "init"]);
  return repo;
}

async function withRepo(fn: (repo: string) => Promise<void>): Promise<void> {
  const repo = initRepo();
  try {
    await fn(repo);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
}

function writeContracts(repo: string, baseCommit: string): string {
  const contract: TaskContract = {
    taskId: TASK_ID,
    version: 1,
    frozen: true,
    goals: ["Produce a draft, then a final artifact"],
    dependsOn: [],
    readPaths: [],
    // The draft is untracked worker output; acceptance snapshots both paths.
    writePaths: [DRAFT, FINAL],
    sharedResources: [],
    baseCommit,
    verifyCommands: [`test -f ${FINAL}`],
    maxRepairs: 0,
  };
  const path = join(repo, "attempt-contracts.json");
  writeFileSync(
    path,
    JSON.stringify({ contracts: [contract] }, null, 2) + "\n",
    "utf8",
  );
  return path;
}

interface AttemptHarness {
  dispatched: number;
  /** Task worktree cwd for each dispatched worker. */
  cwds: string[];
  /** Whether the worktree already contained the prior draft at dispatch. */
  draftSeen: boolean[];
}

function newHarness(): AttemptHarness {
  return { dispatched: 0, cwds: [], draftSeen: [] };
}

/**
 * Fake worker: attempts in `failAttempts` write a draft and exit 1; all other
 * attempts write the final artifact and exit 0.
 */
function attemptWorkerFactory(
  harness: AttemptHarness,
  failAttempts: ReadonlySet<number>,
) {
  return (_worker: "codex" | "claude", cwd: string): AgentAdapter => {
    const attempt = harness.dispatched;
    harness.dispatched += 1;
    harness.cwds.push(cwd);
    harness.draftSeen.push(existsSync(join(cwd, DRAFT)));

    return {
      id: "claude",
      async discover() {
        return {
          id: "claude",
          ok: true,
          supportsModelFlag: true,
          notes: ["attempt-reuse fixture"],
        };
      },
      async start(_input: AgentStartInput) {
        return { sessionId: `attempt-${attempt}` };
      },
      async collect(sessionId: string): Promise<AgentResult> {
        if (failAttempts.has(attempt)) {
          writeFileSync(
            join(cwd, DRAFT),
            `draft from attempt ${attempt}\n`,
            "utf8",
          );
          return {
            sessionId,
            exitCode: 1,
            touchedPaths: [DRAFT],
            logTail: `[fixture] wrote draft on attempt ${attempt}`,
          };
        }
        writeFileSync(
          join(cwd, FINAL),
          `final from attempt ${attempt}\n`,
          "utf8",
        );
        return {
          sessionId,
          exitCode: 0,
          touchedPaths: [FINAL],
          logTail: `[fixture] accepted attempt ${attempt}`,
        };
      },
      async cancel() {},
    };
  };
}

interface CliRun {
  code: number;
  summary: Record<string, any>;
}

async function runStart(
  repo: string,
  contractsPath: string,
  harness: AttemptHarness,
): Promise<CliRun> {
  const out: string[] = [];
  const code = await runSupervisorCli(
    ["start", contractsPath, "--repo", repo, "--worker", "claude"],
    {
      log: (line) => out.push(line),
      signalHandling: false,
      workerFactory: attemptWorkerFactory(harness, new Set([0])),
    },
  );
  return { code, summary: JSON.parse(out.join("\n")) as Record<string, any> };
}

async function runResume(
  repo: string,
  harness: AttemptHarness,
  extraFlags: string[] = [],
): Promise<CliRun> {
  const out: string[] = [];
  const code = await runSupervisorCli(
    [
      "resume",
      "--repo",
      repo,
      "--worker",
      "claude",
      "--retry-rejected",
      ...extraFlags,
    ],
    {
      log: (line) => out.push(line),
      signalHandling: false,
      // A successful retry accepts on its first dispatch (attempt 0).
      workerFactory: attemptWorkerFactory(harness, new Set()),
    },
  );
  return { code, summary: JSON.parse(out.join("\n")) as Record<string, any> };
}

function readStatus(repo: string): Promise<Record<string, any>> {
  const out: string[] = [];
  return runSupervisorCli(["status", "--repo", repo, "--json"], {
    log: (line) => out.push(line),
    signalHandling: false,
  }).then((code) => {
    assert.equal(code, 0);
    return JSON.parse(out.join("\n")) as Record<string, any>;
  });
}

function readHumanStatus(repo: string): Promise<string> {
  const out: string[] = [];
  return runSupervisorCli(["status", "--repo", repo], {
    log: (line) => out.push(line),
    signalHandling: false,
  }).then(() => out.join("\n"));
}

function assertAttemptFields(task: RunTaskState): void {
  assert.equal(task.status, "rejected");
  assert.equal(task.accepted, false);
  for (const field of [
    "attemptWorktree",
    "attemptBranch",
    "attemptBaseCommit",
    "attemptStartedAt",
    "attemptRejectedAt",
  ] as const) {
    assert.equal(
      typeof task[field],
      "string",
      `${field} must be checkpointed on rejection`,
    );
    assert.ok(task[field]!.trim(), `${field} must not be empty`);
  }
  assert.match(task.attemptBaseCommit!, /^[0-9a-f]{40,64}$/i);
  assert.ok(!Number.isNaN(Date.parse(task.attemptStartedAt!)));
  assert.ok(!Number.isNaN(Date.parse(task.attemptRejectedAt!)));
}

// ---------------------------------------------------------------------------
// Backward-compatible manifest validation
// ---------------------------------------------------------------------------

test("manifests without attempt fields stay readable and attempt fields are type-checked", async () => {
  await withRepo(async (repo) => {
    const base = runGit(repo, ["rev-parse", "HEAD"]);
    const contractsPath = writeContracts(repo, base);
    const manifest = createRunManifest(repo, {
      planId: "attempt-reuse-schema",
      contractsPath,
      baseCommit: base,
      integrationBranch: "cliyard/integration/attempt-reuse-schema",
      tasks: [TASK_ID],
    });

    // A pre-feature manifest has no attempt fields and must still load.
    const legacy = loadRunManifest(repo, manifest.runId);
    assert.equal(legacy.tasks[TASK_ID]!.accepted, false);
    assert.equal(legacy.tasks[TASK_ID]!.attemptWorktree, undefined);

    // Malformed attempt metadata is rejected at the store boundary.
    const path = runManifestPath(repo, manifest.runId);
    const raw = JSON.parse(readFileSync(path, "utf8")) as {
      tasks: Record<string, Record<string, unknown>>;
    };
    raw.tasks[TASK_ID]!.attemptWorktree = 42;
    writeFileSync(path, JSON.stringify(raw), "utf8");
    assert.throws(
      () => loadRunManifest(repo, manifest.runId),
      /attemptWorktree must be a string/,
    );
  });
});

// ---------------------------------------------------------------------------
// Default reuse and fail-closed validation
// ---------------------------------------------------------------------------

test(
  "rejected attempt survives, default resume reuses its draft, and tampered metadata fails closed",
  async () => {
    await withRepo(async (repo) => {
      const base = runGit(repo, ["rev-parse", "HEAD"]);
      const contractsPath = writeContracts(repo, base);

      const startHarness = newHarness();
      const started = await runStart(repo, contractsPath, startHarness);
      assert.equal(started.code, 1);
      const runId = started.summary.runId as string;
      const rejected = loadRunManifest(repo, runId);
      const task = rejected.tasks[TASK_ID]!;
      assertAttemptFields(task);

      const worktree = task.attemptWorktree!;
      const taskBranch = task.attemptBranch!;
      const attemptBase = task.attemptBaseCommit!;

      // The dirty draft survives even though --keep-worktrees was not given.
      assert.equal(readFileSync(join(worktree, DRAFT), "utf8"), "draft from attempt 0\n");
      assert.equal(runGit(worktree, ["rev-parse", "HEAD"]), attemptBase);
      assert.equal(runGit(worktree, ["rev-parse", "--abbrev-ref", "HEAD"]), taskBranch);
      assert.ok(
        runGit(repo, ["worktree", "list", "--porcelain"]).includes(worktree),
        "rejected worktree must remain registered",
      );

      // Status exposes the reusable attempt in JSON and human output.
      const status = await readStatus(repo);
      assert.equal(status.reusableAttempts.length, 1);
      assert.deepEqual(status.reusableAttempts[0], {
        taskId: TASK_ID,
        worktree,
        branch: taskBranch,
        baseCommit: attemptBase,
        startedAt: task.attemptStartedAt,
        rejectedAt: task.attemptRejectedAt,
      });
      const human = await readHumanStatus(repo);
      assert.ok(
        human.includes(`reusable attempt: ${TASK_ID} ${worktree}`),
        human,
      );

      // Conflicting flags are rejected before any dispatch or lock work.
      const conflictHarness = newHarness();
      await assert.rejects(
        runResume(repo, conflictHarness, [
          "--reuse-attempt",
          "--fresh-attempt",
        ]),
        /mutually exclusive/,
      );
      assert.equal(conflictHarness.dispatched, 0);

      // Any tampered attempt record fails closed. A fresh attempt is the
      // explicit recovery path and is covered by the next test.
      const clean = loadRunManifest(repo, runId);
      const tamperCases: Array<{
        name: string;
        mutate: (current: RunTaskState) => void;
        pattern: RegExp;
      }> = [
        {
          name: "worktree outside .cliyard/worktrees",
          mutate: (current) => {
            current.attemptWorktree = join(tmpdir(), "cliyard-escaped-draft");
          },
          pattern: /invalid rejected attempt.*outside/s,
        },
        {
          name: "worktree branch mismatch",
          mutate: (current) => {
            current.attemptBranch = "cliyard/not-the-recorded-branch";
          },
          pattern: /invalid rejected attempt.*branch/s,
        },
        {
          name: "missing attemptRejectedAt",
          mutate: (current) => {
            delete current.attemptRejectedAt;
          },
          pattern: /invalid rejected attempt.*attemptRejectedAt/s,
        },
      ];
      for (const tamper of tamperCases) {
        const tampered = loadRunManifest(repo, runId);
        tamper.mutate(tampered.tasks[TASK_ID]!);
        saveRunManifest(tampered);

        const guardedHarness = newHarness();
        await assert.rejects(
          runResume(repo, guardedHarness),
          tamper.pattern,
          tamper.name,
        );
        assert.equal(
          guardedHarness.dispatched,
          0,
          `${tamper.name}: nothing may be dispatched`,
        );
        // Restore the last valid checkpoint before the next case.
        saveRunManifest(clean);
      }

      // Default resume (no --reuse-attempt) attaches to the same dirty
      // worktree and the worker sees the prior draft.
      const resumeHarness = newHarness();
      const resumed = await runResume(repo, resumeHarness);
      assert.equal(resumed.code, 0);
      assert.equal(resumed.summary.status, "completed");
      assert.deepEqual(resumeHarness.cwds, [worktree]);
      assert.deepEqual(resumeHarness.draftSeen, [true]);

      const completed = loadRunManifest(repo, runId);
      assert.equal(completed.status, "completed");
      const accepted = completed.tasks[TASK_ID]!;
      assert.equal(accepted.accepted, true);
      assert.equal(accepted.status, "accepted");
      for (const field of [
        "attemptWorktree",
        "attemptBranch",
        "attemptBaseCommit",
        "attemptStartedAt",
        "attemptRejectedAt",
      ] as const) {
        assert.equal(accepted[field], undefined, `${field} must clear on acceptance`);
      }
      assert.equal(
        existsSync(worktree),
        false,
        "an accepted attempt worktree is cleaned up",
      );
      assert.match(
        runGit(repo, ["show", `${completed.integrationBranch}:${DRAFT}`]),
        /draft from attempt 0/,
      );
      assert.match(
        runGit(repo, ["show", `${completed.integrationBranch}:${FINAL}`]),
        /final from attempt 0/,
      );

      const completedStatus = await readStatus(repo);
      assert.deepEqual(completedStatus.reusableAttempts, []);
    });
  },
);

// ---------------------------------------------------------------------------
// Fresh and explicit reuse
// ---------------------------------------------------------------------------

test(
  "--fresh-attempt starts a different clean worktree and leaves the draft behind",
  async () => {
    await withRepo(async (repo) => {
      const base = runGit(repo, ["rev-parse", "HEAD"]);
      const contractsPath = writeContracts(repo, base);

      const started = await runStart(repo, contractsPath, newHarness());
      assert.equal(started.code, 1);
      const runId = started.summary.runId as string;
      const rejected = loadRunManifest(repo, runId).tasks[TASK_ID]!;
      assertAttemptFields(rejected);
      const rejectedWorktree = rejected.attemptWorktree!;

      const freshHarness = newHarness();
      const resumed = await runResume(repo, freshHarness, ["--fresh-attempt"]);
      assert.equal(resumed.code, 0);
      assert.equal(resumed.summary.status, "completed");

      assert.equal(freshHarness.dispatched, 1);
      assert.notEqual(freshHarness.cwds[0], rejectedWorktree);
      assert.deepEqual(
        freshHarness.draftSeen,
        [false],
        "a fresh worktree must not contain the rejected draft",
      );
      assert.equal(
        existsSync(join(rejectedWorktree, DRAFT)),
        true,
        "the discarded draft stays on disk; worktree GC is out of scope",
      );

      const completed = loadRunManifest(repo, runId);
      assert.equal(completed.tasks[TASK_ID]!.accepted, true);
      assert.equal(completed.tasks[TASK_ID]!.attemptWorktree, undefined);
      assert.match(
        runGit(repo, ["show", `${completed.integrationBranch}:${FINAL}`]),
        /final from attempt 0/,
      );
    });
  },
);

test(
  "--reuse-attempt asserts the default and reuses the recorded worktree",
  async () => {
    await withRepo(async (repo) => {
      const base = runGit(repo, ["rev-parse", "HEAD"]);
      const contractsPath = writeContracts(repo, base);

      const started = await runStart(repo, contractsPath, newHarness());
      assert.equal(started.code, 1);
      const runId = started.summary.runId as string;
      const rejected = loadRunManifest(repo, runId).tasks[TASK_ID]!;
      assertAttemptFields(rejected);

      const reuseHarness = newHarness();
      const resumed = await runResume(repo, reuseHarness, ["--reuse-attempt"]);
      assert.equal(resumed.code, 0);
      assert.equal(resumed.summary.status, "completed");
      assert.deepEqual(reuseHarness.cwds, [rejected.attemptWorktree]);
      assert.deepEqual(reuseHarness.draftSeen, [true]);

      const completed = loadRunManifest(repo, runId);
      assert.equal(completed.tasks[TASK_ID]!.accepted, true);
      assert.match(
        runGit(repo, ["show", `${completed.integrationBranch}:${DRAFT}`]),
        /draft from attempt 0/,
      );
    });
  },
);

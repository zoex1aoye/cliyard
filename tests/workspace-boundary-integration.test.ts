/**
 * WorkspaceBoundary v1 integration (design/workspace-boundary-v1.md).
 *
 * These tests drive the real durable worker batch against temporary
 * repositories with injected clean/dirty/failing guards, plus one
 * end-to-end run that uses the production guard. Nothing here writes
 * outside its temporary repository.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
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
import type {
  AgentAdapter,
  AgentResult,
  AgentStartInput,
} from "../src/agents/types.js";
import type { TaskContract } from "../src/contracts/schema.js";
import type {
  WorkspaceBoundaryChange,
  WorkspaceBoundaryComparison,
  WorkspaceBoundaryPolicy,
} from "../src/agents/workspace-boundary.js";
import { createFailureRecord } from "../src/failures.js";
import { runCodexBatch } from "../src/scheduler/codex-batch.js";
import {
  buildStatus,
  runSupervisorCli,
} from "../src/supervisor/cli.js";
import {
  computeContractsHash,
  createRunManifest,
  inspectRun,
  inspectSupervisorLock,
  loadRunManifest,
  runManifestPath,
  updateRunManifest,
  RunManifestError,
} from "../src/supervisor/store.js";
import type { WorkspaceBoundaryRecord } from "../src/supervisor/types.js";

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

/** Temporary git repository with one committed source file. */
function initRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), "cliyard-wb-integration-"));
  runGit(repo, ["init"]);
  runGit(repo, ["config", "user.email", "t@t.com"]);
  runGit(repo, ["config", "user.name", "t"]);
  mkdirSync(join(repo, "src"), { recursive: true });
  writeFileSync(join(repo, "README.md"), "# fixture\n");
  writeFileSync(join(repo, "src", "tracked.txt"), "tracked-v1\n");
  runGit(repo, ["add", "."]);
  runGit(repo, ["commit", "-m", "init"]);
  return repo;
}

function contract(taskId: string, baseCommit: string): TaskContract {
  return {
    taskId,
    version: 1,
    frozen: true,
    goals: [`Create ${taskId}.txt`],
    dependsOn: [],
    readPaths: ["."],
    writePaths: [`${taskId}.txt`],
    sharedResources: [],
    baseCommit,
    verifyCommands: [`test -f ${taskId}.txt`],
    maxRepairs: 0,
  };
}

function writeContracts(repo: string, ids: string[], baseCommit: string): string {
  const path = join(repo, "contracts.json");
  writeFileSync(
    path,
    JSON.stringify(
      { contracts: ids.map((id) => contract(id, baseCommit)) },
      null,
      2,
    ) + "\n",
    "utf8",
  );
  return path;
}

interface WorkerHarness {
  repo: string;
  started: string[];
  /** Task ids whose worker fails on its own before touching anything. */
  fail: ReadonlySet<string>;
  /** Task ids whose worker mutates the authority checkout. */
  mutateAuthority: ReadonlySet<string>;
}

function fixtureWorker(cwd: string, harness: WorkerHarness): AgentAdapter {
  let contract: TaskContract | undefined;
  let sessionId = "";
  return {
    id: "codex",
    async discover() {
      return {
        id: "codex",
        ok: true,
        supportsModelFlag: true,
        notes: ["workspace-boundary fixture"],
      };
    },
    async start(input: AgentStartInput) {
      contract = input.contract;
      sessionId = `fixture-${input.contract.taskId}`;
      harness.started.push(input.contract.taskId);
      return { sessionId };
    },
    async collect(): Promise<AgentResult> {
      assert.ok(contract, "worker started before collect");
      if (harness.fail.has(contract.taskId)) {
        return {
          sessionId,
          exitCode: 1,
          touchedPaths: [],
          logTail: "[fixture] original worker failure",
          failure: createFailureRecord({
            exitCode: 7,
            code: "original_worker_failure",
            text: "worker failed on its own",
          }),
        };
      }
      if (harness.mutateAuthority.has(contract.taskId)) {
        // An absolute write into the control checkout, exactly what the
        // boundary must observe even though the task worktree is clean.
        writeFileSync(
          join(harness.repo, "rogue.txt"),
          "written by worker\n",
          "utf8",
        );
      }
      const file = `${contract.taskId}.txt`;
      writeFileSync(join(cwd, file), "done\n", "utf8");
      return {
        sessionId,
        exitCode: 0,
        touchedPaths: [file],
        logTail: `[fixture] wrote ${file}`,
      };
    },
    async cancel() {},
  };
}

type InjectedBehavior =
  | { kind: "clean" }
  | { kind: "dirty"; changes?: WorkspaceBoundaryChange[] }
  | { kind: "inspection_error"; error?: string }
  | { kind: "capture_throw" }
  | { kind: "compare_throw" };

interface GuardObservation {
  policies: WorkspaceBoundaryPolicy[];
  captures: number;
  compares: number;
}

const DIGEST_A = "a".repeat(64);
const DIGEST_B = "b".repeat(64);

function injectedGuardFactory(
  behavior: InjectedBehavior,
  observation?: GuardObservation,
): (policy: WorkspaceBoundaryPolicy) => {
  capture(): Promise<void>;
  compare(): Promise<WorkspaceBoundaryComparison>;
} {
  return (policy) => {
    observation?.policies.push(policy);
    return {
      async capture() {
        observation && (observation.captures += 1);
        if (behavior.kind === "capture_throw") {
          throw new Error("injected capture failure");
        }
      },
      async compare() {
        observation && (observation.compares += 1);
        if (behavior.kind === "compare_throw") {
          throw new Error("injected compare failure");
        }
        switch (behavior.kind) {
          case "clean":
            return { status: "clean", changes: [] };
          case "dirty":
            return {
              status: "dirty",
              changes: behavior.changes ?? [
                {
                  rootIndex: 0,
                  change: "modified",
                  kind: "file",
                  path: "src/tracked.txt",
                  beforeDigest: DIGEST_A,
                  afterDigest: DIGEST_B,
                },
              ],
            };
          case "inspection_error":
            return {
              status: "inspection_failed",
              error: behavior.error ?? "injected inspection failure",
              changes: [],
            };
          default:
            return { status: "clean", changes: [] };
        }
      },
    };
  };
}

function batchOptions(
  repo: string,
  contractsPath: string,
  manifest: ReturnType<typeof createRunManifest>,
  harness: WorkerHarness,
  guardFactory?: (policy: WorkspaceBoundaryPolicy) => {
    capture(): Promise<void>;
    compare(): Promise<WorkspaceBoundaryComparison>;
  },
) {
  return {
    contractsPath,
    repoRoot: repo,
    ledgerPath: join(repo, ".cliyard", "ledger.json"),
    worker: "codex" as const,
    dryRun: false,
    keepWorktrees: false,
    runManifest: manifest,
    workerFactory: (_worker: "codex" | "claude", cwd: string) =>
      fixtureWorker(cwd, harness),
    ...(guardFactory !== undefined
      ? { workspaceBoundaryGuardFactory: guardFactory }
      : {}),
  };
}

function validTimestamp(value: string): boolean {
  return typeof value === "string" && !Number.isNaN(Date.parse(value));
}

// ---------------------------------------------------------------------------
// Clean / dirty / inspection-error waves
// ---------------------------------------------------------------------------

test("clean wave accepts every task and persists guard-only clean records", async () => {
  const repo = initRepo();
  try {
    const base = runGit(repo, ["rev-parse", "HEAD"]);
    const contractsPath = writeContracts(repo, ["task-a", "task-b"], base);
    const manifest = createRunManifest(repo, {
      planId: "clean-wave",
      contractsPath,
      baseCommit: base,
      integrationBranch: "cliyard/integration/clean-wave",
      tasks: ["task-a", "task-b"],
    });
    const harness: WorkerHarness = {
      repo,
      started: [],
      fail: new Set(),
      mutateAuthority: new Set(),
    };
    const observation: GuardObservation = { policies: [], captures: 0, compares: 0 };

    const result = await runCodexBatch(
      batchOptions(
        repo,
        contractsPath,
        manifest,
        harness,
        injectedGuardFactory({ kind: "clean" }, observation),
      ),
    );

    assert.equal(result.allAccepted, true);
    assert.deepEqual(result.waves, [["task-a", "task-b"]]);
    assert.equal(observation.captures, 1);
    assert.equal(observation.compares, 1);
    assert.equal(observation.policies.length, 1);
    assert.equal(observation.policies[0]!.authorityRoot, repo);
    assert.equal(
      observation.policies[0]!.ledgerPath,
      join(repo, ".cliyard", "ledger.json"),
    );

    const saved = loadRunManifest(repo, manifest.runId);
    for (const id of ["task-a", "task-b"]) {
      const task = saved.tasks[id]!;
      assert.equal(task.accepted, true);
      assert.ok(task.resultCommit);
      assert.equal(task.failure, undefined);
      const record = task.workspaceBoundary;
      assert.ok(record, "clean wave must persist a record for every task");
      assert.deepEqual(record, {
        version: 1,
        status: "clean",
        enforcement: "guard-only",
        capturedAt: record!.capturedAt,
        comparedAt: record!.comparedAt,
        changes: [],
      });
      assert.ok(validTimestamp(record!.capturedAt));
      assert.ok(validTimestamp(record!.comparedAt));
      assert.ok(Date.parse(record!.comparedAt) >= Date.parse(record!.capturedAt));
    }
    assert.equal(saved.status, "completed");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("dirty wave rejects every task without merge and without deleting evidence", async () => {
  const repo = initRepo();
  try {
    const base = runGit(repo, ["rev-parse", "HEAD"]);
    const contractsPath = writeContracts(repo, ["task-a", "task-b"], base);
    const manifest = createRunManifest(repo, {
      planId: "dirty-wave",
      contractsPath,
      baseCommit: base,
      integrationBranch: "cliyard/integration/dirty-wave",
      tasks: ["task-a", "task-b"],
    });
    const harness: WorkerHarness = {
      repo,
      started: [],
      fail: new Set(),
      mutateAuthority: new Set(),
    };

    const result = await runCodexBatch(
      batchOptions(
        repo,
        contractsPath,
        manifest,
        harness,
        injectedGuardFactory({ kind: "dirty" }),
      ),
    );

    assert.equal(result.allAccepted, false);
    assert.deepEqual(
      result.results.map((r) => r.verdict),
      ["rejected", "rejected"],
    );
    assert.equal(result.integration.head, base, "no merge may advance the head");
    assert.equal(
      runGit(repo, [
        "rev-parse",
        `refs/heads/${manifest.integrationBranch}`,
      ]),
      base,
      "integration branch must stay at the base commit",
    );

    const saved = loadRunManifest(repo, manifest.runId);
    assert.equal(saved.status, "blocked");
    for (const id of ["task-a", "task-b"]) {
      const task = saved.tasks[id]!;
      assert.equal(task.accepted, false);
      assert.equal(task.status, "blocked");
      assert.equal(task.failure?.category, "policy_blocked");
      assert.equal(task.failure?.stage, "policy");
      assert.equal(task.failure?.code, "workspace_boundary_violation");
      const record = task.workspaceBoundary!;
      assert.equal(record.status, "violation");
      assert.equal(record.enforcement, "guard-only");
      assert.deepEqual(record.changes, [
        {
          rootIndex: 0,
          change: "modified",
          kind: "file",
          path: "src/tracked.txt",
          beforeDigest: DIGEST_A,
          afterDigest: DIGEST_B,
        },
      ]);
      // The rejected draft survives for operator inspection; the guard never
      // reverts or deletes anything.
      assert.ok(existsSync(task.attemptWorktree!), "dirty draft must survive");
    }

    // The worker output reached the worktree but was never merged.
    for (const id of ["task-a", "task-b"]) {
      const contained = spawnSync("git", ["cat-file", "-e", `${base}:${id}.txt`], {
        cwd: repo,
        encoding: "utf8",
      });
      assert.notEqual(
        contained.status,
        0,
        `${id}.txt must not be merged into the integration tree`,
      );
    }
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("inspection error after the wave fails closed with a stable policy code", async () => {
  const repo = initRepo();
  try {
    const base = runGit(repo, ["rev-parse", "HEAD"]);
    const contractsPath = writeContracts(repo, ["task-a", "task-b"], base);
    const manifest = createRunManifest(repo, {
      planId: "inspection-error",
      contractsPath,
      baseCommit: base,
      integrationBranch: "cliyard/integration/inspection-error",
      tasks: ["task-a", "task-b"],
    });
    const harness: WorkerHarness = {
      repo,
      started: [],
      fail: new Set(),
      mutateAuthority: new Set(),
    };

    const result = await runCodexBatch(
      batchOptions(
        repo,
        contractsPath,
        manifest,
        harness,
        injectedGuardFactory({
          kind: "inspection_error",
          error: "injected inspection failure",
        }),
      ),
    );

    assert.equal(result.allAccepted, false);
    assert.equal(result.integration.head, base);
    const saved = loadRunManifest(repo, manifest.runId);
    for (const id of ["task-a", "task-b"]) {
      const task = saved.tasks[id]!;
      assert.equal(task.accepted, false);
      assert.equal(task.status, "blocked");
      assert.equal(task.failure?.category, "policy_blocked");
      assert.equal(
        task.failure?.code,
        "workspace_boundary_inspection_failed",
      );
      const record = task.workspaceBoundary!;
      assert.equal(record.status, "inspection_error");
      assert.equal(record.enforcement, "guard-only");
      assert.equal(record.error, "injected inspection failure");
      assert.deepEqual(record.changes, []);
    }
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("capture failure before dispatch skips workers and fails every task closed", async () => {
  const repo = initRepo();
  try {
    const base = runGit(repo, ["rev-parse", "HEAD"]);
    const contractsPath = writeContracts(repo, ["task-a", "task-b"], base);
    const manifest = createRunManifest(repo, {
      planId: "capture-failure",
      contractsPath,
      baseCommit: base,
      integrationBranch: "cliyard/integration/capture-failure",
      tasks: ["task-a", "task-b"],
    });
    const harness: WorkerHarness = {
      repo,
      started: [],
      fail: new Set(),
      mutateAuthority: new Set(),
    };

    const result = await runCodexBatch(
      batchOptions(
        repo,
        contractsPath,
        manifest,
        harness,
        injectedGuardFactory({ kind: "capture_throw" }),
      ),
    );

    assert.deepEqual(harness.started, [], "no worker may run without a snapshot");
    assert.equal(result.allAccepted, false);
    assert.equal(result.integration.head, base);
    const saved = loadRunManifest(repo, manifest.runId);
    for (const id of ["task-a", "task-b"]) {
      const task = saved.tasks[id]!;
      assert.equal(task.accepted, false);
      assert.equal(task.status, "blocked");
      assert.equal(
        task.failure?.code,
        "workspace_boundary_inspection_failed",
      );
      const record = task.workspaceBoundary!;
      assert.equal(record.status, "inspection_error");
      assert.match(record.error ?? "", /injected capture failure/);
    }
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("an already-rejected worker keeps its original structured failure in a dirty wave", async () => {
  const repo = initRepo();
  try {
    const base = runGit(repo, ["rev-parse", "HEAD"]);
    const contractsPath = writeContracts(repo, ["task-a", "task-b"], base);
    const manifest = createRunManifest(repo, {
      planId: "preserve-original",
      contractsPath,
      baseCommit: base,
      integrationBranch: "cliyard/integration/preserve-original",
      tasks: ["task-a", "task-b"],
    });
    const harness: WorkerHarness = {
      repo,
      started: [],
      fail: new Set(["task-a"]),
      mutateAuthority: new Set(),
    };

    const result = await runCodexBatch(
      batchOptions(
        repo,
        contractsPath,
        manifest,
        harness,
        injectedGuardFactory({ kind: "dirty" }),
      ),
    );

    assert.deepEqual(result.results.map((r) => r.verdict), [
      "rejected",
      "rejected",
    ]);
    const saved = loadRunManifest(repo, manifest.runId);

    const failed = saved.tasks["task-a"]!;
    assert.equal(failed.status, "rejected");
    assert.equal(failed.failure?.code, "original_worker_failure");
    assert.equal(failed.failure?.category, "worker_process_exit");
    assert.equal(failed.workspaceBoundary?.status, "violation");

    const converted = saved.tasks["task-b"]!;
    assert.equal(converted.status, "blocked");
    assert.equal(converted.failure?.code, "workspace_boundary_violation");
    assert.equal(converted.workspaceBoundary?.status, "violation");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Durable state: round-trip, legacy, malformed
// ---------------------------------------------------------------------------

test("accepted and rejected boundary evidence survives manifest round-trip", async () => {
  const repo = initRepo();
  try {
    const base = runGit(repo, ["rev-parse", "HEAD"]);
    const contractsPath = writeContracts(repo, ["task-a", "task-b"], base);
    const manifest = createRunManifest(repo, {
      planId: "round-trip",
      contractsPath,
      baseCommit: base,
      integrationBranch: "cliyard/integration/round-trip",
      tasks: ["task-a", "task-b"],
    });
    const harness: WorkerHarness = {
      repo,
      started: [],
      fail: new Set(["task-a"]),
      mutateAuthority: new Set(),
    };

    const result = await runCodexBatch(
      batchOptions(
        repo,
        contractsPath,
        manifest,
        harness,
        injectedGuardFactory({ kind: "clean" }),
      ),
    );

    // Accepted and rejected tasks in one clean wave both carry clean records.
    assert.equal(result.manifest!.tasks["task-a"]!.accepted, false);
    assert.equal(result.manifest!.tasks["task-b"]!.accepted, true);
    const firstLoad = loadRunManifest(repo, manifest.runId);
    for (const id of ["task-a", "task-b"]) {
      assert.deepEqual(
        firstLoad.tasks[id]!.workspaceBoundary,
        result.manifest!.tasks[id]!.workspaceBoundary,
      );
      assert.equal(firstLoad.tasks[id]!.workspaceBoundary?.status, "clean");
    }

    // A violation record round-trips through save/load unchanged.
    const violation: WorkspaceBoundaryRecord = {
      version: 1,
      status: "violation",
      enforcement: "guard-only",
      capturedAt: "2026-10-28T08:00:00.000Z",
      comparedAt: "2026-10-28T08:00:01.000Z",
      changes: [
        {
          rootIndex: 0,
          change: "added",
          kind: "file",
          path: "src/rogue.txt",
          afterDigest: DIGEST_B,
        },
      ],
    };
    updateRunManifest(repo, manifest.runId, (current) => {
      current.tasks["task-a"]!.workspaceBoundary = violation;
    });
    const secondLoad = loadRunManifest(repo, manifest.runId);
    assert.deepEqual(secondLoad.tasks["task-a"]!.workspaceBoundary, violation);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("legacy manifests without workspace boundary records stay readable", () => {
  const repo = initRepo();
  try {
    const base = runGit(repo, ["rev-parse", "HEAD"]);
    const contractsPath = writeContracts(repo, ["task-a"], base);
    const legacy = {
      version: 1,
      runId: "legacy-run",
      planId: "legacy-plan",
      repoRoot: repo,
      contractsPath,
      contractsHash: computeContractsHash(contractsPath),
      baseCommit: base,
      integrationBranch: "cliyard/integration/legacy",
      integrationHead: base,
      status: "completed",
      createdAt: "2026-10-27T00:00:00.000Z",
      updatedAt: "2026-10-27T00:00:00.000Z",
      owner: { pid: 1, host: "legacy-host" },
      tasks: {
        "task-a": {
          taskId: "task-a",
          status: "accepted",
          accepted: true,
          resultCommit: base,
        },
      },
    };
    mkdirSync(join(repo, ".cliyard", "runs"), { recursive: true });
    writeFileSync(
      runManifestPath(repo, "legacy-run"),
      JSON.stringify(legacy, null, 2) + "\n",
      "utf8",
    );

    const loaded = loadRunManifest(repo, "legacy-run");
    assert.equal(loaded.tasks["task-a"]!.accepted, true);
    assert.equal(loaded.tasks["task-a"]!.workspaceBoundary, undefined);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("malformed workspace boundary records fail closed", () => {
  const repo = initRepo();
  try {
    const base = runGit(repo, ["rev-parse", "HEAD"]);
    const contractsPath = writeContracts(repo, ["task-a"], base);
    const write = (record: unknown) => {
      const raw = {
        version: 1,
        runId: "malformed-run",
        planId: "malformed-plan",
        repoRoot: repo,
        contractsPath,
        contractsHash: computeContractsHash(contractsPath),
        baseCommit: base,
        integrationBranch: "cliyard/integration/malformed",
        integrationHead: base,
        status: "completed",
        createdAt: "2026-10-27T00:00:00.000Z",
        updatedAt: "2026-10-27T00:00:00.000Z",
        owner: { pid: 1, host: "malformed-host" },
        tasks: {
          "task-a": {
            taskId: "task-a",
            status: "accepted",
            accepted: true,
            resultCommit: base,
            workspaceBoundary: record,
          },
        },
      };
      mkdirSync(join(repo, ".cliyard", "runs"), { recursive: true });
      writeFileSync(
        runManifestPath(repo, "malformed-run"),
        JSON.stringify(raw, null, 2) + "\n",
        "utf8",
      );
    };
    const clean = (): WorkspaceBoundaryRecord => ({
      version: 1,
      status: "clean",
      enforcement: "guard-only",
      capturedAt: "2026-10-27T00:00:00.000Z",
      comparedAt: "2026-10-27T00:00:00.000Z",
      changes: [],
    });

    write({ ...clean(), status: "warm" });
    assert.throws(
      () => loadRunManifest(repo, "malformed-run"),
      (error: unknown) =>
        error instanceof RunManifestError && /status/.test(error.message),
    );

    write({ ...clean(), enforcement: "prevention" });
    assert.throws(
      () => loadRunManifest(repo, "malformed-run"),
      (error: unknown) =>
        error instanceof RunManifestError && /enforcement/.test(error.message),
    );

    write({ ...clean(), capturedAt: "not-a-time" });
    assert.throws(
      () => loadRunManifest(repo, "malformed-run"),
      (error: unknown) =>
        error instanceof RunManifestError && /capturedAt/.test(error.message),
    );

    write({
      ...clean(),
      status: "violation",
      changes: [
        {
          rootIndex: 0,
          change: "added",
          kind: "file",
          path: "/etc/passwd",
          afterDigest: DIGEST_A,
        },
      ],
    });
    assert.throws(
      () => loadRunManifest(repo, "malformed-run"),
      (error: unknown) =>
        error instanceof RunManifestError && /evidence path/.test(error.message),
    );

    write({ ...clean(), changes: "not-an-array" });
    assert.throws(
      () => loadRunManifest(repo, "malformed-run"),
      (error: unknown) =>
        error instanceof RunManifestError && /must be an array/.test(error.message),
    );
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Status projection
// ---------------------------------------------------------------------------

test("supervisor status reports clean, violation and inspection-error evidence", async () => {
  const repo = initRepo();
  try {
    const base = runGit(repo, ["rev-parse", "HEAD"]);
    const contractsPath = writeContracts(repo, ["task-a"], base);
    const manifest = createRunManifest(repo, {
      planId: "status-projection",
      contractsPath,
      baseCommit: base,
      integrationBranch: "cliyard/integration/status-projection",
      tasks: ["task-a", "task-b", "task-c"],
    });
    const violation: WorkspaceBoundaryRecord = {
      version: 1,
      status: "violation",
      enforcement: "guard-only",
      capturedAt: "2026-10-28T08:00:00.000Z",
      comparedAt: "2026-10-28T08:00:01.000Z",
      changes: [
        {
          rootIndex: 0,
          change: "modified",
          kind: "file",
          path: "src/tracked.txt",
          beforeDigest: DIGEST_A,
          afterDigest: DIGEST_B,
        },
        {
          rootIndex: 0,
          change: "added",
          kind: "file",
          path: "src/added.txt",
          afterDigest: DIGEST_A,
        },
      ],
    };
    const inspectionError: WorkspaceBoundaryRecord = {
      version: 1,
      status: "inspection_error",
      enforcement: "guard-only",
      capturedAt: "2026-10-28T08:00:00.000Z",
      comparedAt: "2026-10-28T08:00:01.000Z",
      changes: [],
      error: "cannot inspect protected root",
    };
    const clean: WorkspaceBoundaryRecord = {
      version: 1,
      status: "clean",
      enforcement: "guard-only",
      capturedAt: "2026-10-28T08:00:00.000Z",
      comparedAt: "2026-10-28T08:00:01.000Z",
      changes: [],
    };
    updateRunManifest(repo, manifest.runId, (current) => {
      current.tasks["task-a"]!.workspaceBoundary = clean;
      current.tasks["task-b"]!.workspaceBoundary = violation;
      current.tasks["task-c"]!.workspaceBoundary = inspectionError;
    });

    const status = await buildStatus(
      repo,
      inspectRun(repo, manifest.runId),
      inspectSupervisorLock(repo),
    );
    assert.deepEqual(
      {
        tasks: status.workspaceBoundary.tasks,
        clean: status.workspaceBoundary.clean,
        violations: status.workspaceBoundary.violations,
        inspectionErrors: status.workspaceBoundary.inspectionErrors,
      },
      { tasks: 3, clean: 1, violations: 1, inspectionErrors: 1 },
    );
    assert.deepEqual(
      status.workspaceBoundary.evidence.map((entry) => entry.taskId),
      ["task-a", "task-b", "task-c"],
    );
    const violationEntry = status.workspaceBoundary.evidence.find(
      (entry) => entry.taskId === "task-b",
    )!;
    assert.equal(violationEntry.status, "violation");
    assert.equal(violationEntry.changeCount, 2);
    assert.deepEqual(violationEntry.changedPaths, [
      "src/tracked.txt",
      "src/added.txt",
    ]);
    const errorEntry = status.workspaceBoundary.evidence.find(
      (entry) => entry.taskId === "task-c",
    )!;
    assert.equal(errorEntry.status, "inspection_error");
    assert.equal(errorEntry.error, "cannot inspect protected root");

    // Human status prints one concise summary plus one line per task.
    const lines: string[] = [];
    const code = await runSupervisorCli(["status", "--repo", repo], {
      log: (line: string) => lines.push(line),
    });
    assert.equal(code, 0);
    const human = lines.join("\n");
    assert.match(
      human,
      /workspace boundary: clean 1 \/ violation 1 \/ inspection-error 1 \(detection only\)/,
    );
    assert.match(human, /task task-b: boundary=violation/);
    assert.match(human, /paths=\[src\/tracked\.txt, src\/added\.txt\]/);
    assert.match(human, /task task-c: boundary=inspection_error/);
    assert.match(human, /error=cannot inspect protected root/);

    // JSON status carries the same projection.
    const jsonLines: string[] = [];
    const jsonCode = await runSupervisorCli(
      ["status", "--repo", repo, "--json"],
      { log: (line: string) => jsonLines.push(line) },
    );
    assert.equal(jsonCode, 0);
    const json = JSON.parse(jsonLines.join("\n")) as {
      workspaceBoundary: {
        clean: number;
        violations: number;
        inspectionErrors: number;
        evidence: Array<{ taskId: string; status: string }>;
      };
    };
    assert.equal(json.workspaceBoundary.clean, 1);
    assert.equal(json.workspaceBoundary.violations, 1);
    assert.equal(json.workspaceBoundary.inspectionErrors, 1);
    assert.deepEqual(
      json.workspaceBoundary.evidence.map((entry) => entry.status),
      ["clean", "violation", "inspection_error"],
    );
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Production default is the real guard; the seam can never disable it
// ---------------------------------------------------------------------------

test("production uses the real guard and an invalid injected guard cannot disable enforcement", async () => {
  const repo = initRepo();
  try {
    const base = runGit(repo, ["rev-parse", "HEAD"]);
    const contractsPath = writeContracts(repo, ["task-a"], base);
    const manifest = createRunManifest(repo, {
      planId: "real-guard",
      contractsPath,
      baseCommit: base,
      integrationBranch: "cliyard/integration/real-guard",
      tasks: ["task-a"],
    });
    const harness: WorkerHarness = {
      repo,
      started: [],
      fail: new Set(),
      mutateAuthority: new Set(["task-a"]),
    };

    // No injected factory: the worker's absolute write into the authority
    // checkout must be observed by the real protected-root guard.
    const result = await runCodexBatch(
      batchOptions(repo, contractsPath, manifest, harness),
    );
    assert.equal(result.allAccepted, false);
    assert.equal(result.integration.head, base);

    const saved = loadRunManifest(repo, manifest.runId);
    const task = saved.tasks["task-a"]!;
    assert.equal(task.accepted, false);
    assert.equal(task.failure?.code, "workspace_boundary_violation");
    const record = task.workspaceBoundary!;
    assert.equal(record.status, "violation");
    assert.ok(
      record.changes.some(
        (change) => change.path === "rogue.txt" && change.change === "added",
      ),
      `expected rogue.txt among changes: ${JSON.stringify(record.changes)}`,
    );
    // Never deleted or reverted: the unexpected change stays on disk.
    assert.equal(existsSync(join(repo, "rogue.txt")), true);
    assert.equal(
      readFileSync(join(repo, "rogue.txt"), "utf8"),
      "written by worker\n",
    );

    // A guard factory that returns nothing must throw, not silently disable.
    await assert.rejects(
      runCodexBatch({
        ...batchOptions(repo, contractsPath, manifest, harness),
        workspaceBoundaryGuardFactory: () =>
          undefined as unknown as {
            capture(): Promise<void>;
            compare(): Promise<WorkspaceBoundaryComparison>;
          },
      }),
      /invalid guard.*never be disabled/,
    );
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

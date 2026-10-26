import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  AgentAdapter,
  AgentResult,
  AgentStartInput,
} from "../src/agents/types.js";
import type { TaskContract } from "../src/contracts/schema.js";
import { runSupervisorCli } from "../src/supervisor/cli.js";
import {
  acquireSupervisorLock,
  createRunManifest,
  getActiveRunId,
  inspectSupervisorLock,
  loadRunManifest,
  supervisorPaths,
  SupervisorLockHeldError,
} from "../src/supervisor/store.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const CLI_PATH = fileURLToPath(new URL("../src/cli.ts", import.meta.url));

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
  const repo = mkdtempSync(join(tmpdir(), "cliyard-supervisor-cli-"));
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

function contract(
  taskId: string,
  dependsOn: string[],
  writePath: string,
  baseCommit: string,
  verifyCommands: string[],
): TaskContract {
  return {
    taskId,
    version: 1,
    frozen: true,
    goals: [`Create ${writePath}`],
    dependsOn,
    readPaths: ["."],
    writePaths: [writePath],
    sharedResources: [],
    baseCommit,
    verifyCommands,
    maxRepairs: 0,
  };
}

function writeContracts(repo: string, baseCommit: string): string {
  const path = join(repo, "contracts.json");
  writeFileSync(
    path,
    JSON.stringify(
      {
        contracts: [
          contract("foundation", [], "foundation.ts", baseCommit, [
            "test -f foundation.ts",
          ]),
          contract("left", ["foundation"], "left.ts", baseCommit, [
            "test -f foundation.ts",
            "test -f left.ts",
          ]),
          contract("right", ["foundation"], "right.ts", baseCommit, [
            "test -f foundation.ts",
            "test -f right.ts",
          ]),
          contract("upper", ["left", "right"], "upper.ts", baseCommit, [
            "test -f foundation.ts",
            "test -f left.ts",
            "test -f right.ts",
            "test -f upper.ts",
          ]),
        ],
      },
      null,
      2,
    ) + "\n",
    "utf8",
  );
  return path;
}

interface WorkerHarness {
  started: string[];
  /** Simulate the supervisor dying while this task is being dispatched. */
  interruptOnStart?: ReadonlySet<string>;
}

function createFixtureWorker(
  cwd: string,
  harness: WorkerHarness,
): AgentAdapter {
  let current: TaskContract | undefined;
  return {
    id: "claude",
    async discover() {
      return {
        id: "claude",
        ok: true,
        supportsModelFlag: true,
        notes: ["supervisor cli fixture"],
      };
    },
    async start(input: AgentStartInput) {
      current = input.contract;
      harness.started.push(current.taskId);
      if (harness.interruptOnStart?.has(current.taskId)) {
        throw new Error(`[fixture] interrupted before ${current.taskId}`);
      }
      return { sessionId: `fixture-${current.taskId}` };
    },
    async collect(sessionId: string): Promise<AgentResult> {
      if (!current) throw new Error("worker did not start");
      const file = `${current.taskId}.ts`;
      writeFileSync(
        join(cwd, file),
        `export const name = '${current.taskId}';\n`,
      );
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

function harnessFactory(harness: WorkerHarness) {
  return (_worker: "codex" | "claude", cwd: string) =>
    createFixtureWorker(cwd, harness);
}

/** Start a run that accepts the first wave and dies dispatching the second. */
async function interruptFirstWave(
  repo: string,
  contractsPath: string,
): Promise<WorkerHarness> {
  const harness: WorkerHarness = {
    started: [],
    interruptOnStart: new Set(["left", "right"]),
  };
  await assert.rejects(
    runSupervisorCli(
      ["start", contractsPath, "--repo", repo, "--worker", "claude"],
      {
        log: () => undefined,
        signalHandling: false,
        workerFactory: harnessFactory(harness),
      },
    ),
    /\[fixture\] interrupted before (left|right)/,
  );
  return harness;
}

async function exitedPid(): Promise<number> {
  const child = spawn(process.execPath, ["-e", "process.exit(0)"], {
    stdio: "ignore",
  });
  assert.ok(child.pid);
  await once(child, "exit");
  return child.pid;
}

function parseJson(lines: string[]): Record<string, any> {
  return JSON.parse(lines.join("\n")) as Record<string, any>;
}

// ---------------------------------------------------------------------------
// start / status
// ---------------------------------------------------------------------------

test("supervisor help succeeds and a missing command fails", async () => {
  const help: string[] = [];
  assert.equal(
    await runSupervisorCli(["--help"], {
      log: (line) => help.push(line),
      signalHandling: false,
    }),
    0,
  );
  assert.match(help.join("\n"), /cliyard supervisor/);

  assert.equal(
    await runSupervisorCli([], {
      log: () => undefined,
      signalHandling: false,
    }),
    1,
  );
});

test("supervisor start runs a foreground batch and persists a completed run", async () => {
  await withRepo(async (repo) => {
    const base = runGit(repo, ["rev-parse", "HEAD"]);
    const contractsPath = writeContracts(repo, base);
    const out: string[] = [];

    const code = await runSupervisorCli(
      ["start", contractsPath, "--repo", repo, "--worker", "claude", "--dry-run"],
      { log: (line) => out.push(line), signalHandling: false },
    );

    assert.equal(code, 0);
    const summary = parseJson(out);
    assert.equal(summary.status, "completed");
    assert.equal(summary.resumed, false);
    assert.equal(summary.accepted, 4);
    assert.equal(summary.pending, 0);
    assert.deepEqual(
      (summary.startOrder as string[]).sort(),
      ["foundation", "left", "right", "upper"],
    );
    assert.ok(summary.runId);

    const manifest = loadRunManifest(repo, summary.runId as string);
    assert.equal(manifest.status, "completed");
    assert.equal(manifest.planId, "contracts");
    assert.equal(manifest.baseCommit, base);
    assert.equal(manifest.integrationBranch, `cliyard/integration/${manifest.runId}`);
    assert.equal(manifest.integrationHead, summary.integration.head);
    for (const task of Object.values(manifest.tasks)) {
      assert.equal(task.accepted, true);
    }
    assert.equal(getActiveRunId(repo), manifest.runId);
    assert.equal(inspectSupervisorLock(repo).state, "free");
    assert.equal(
      runGit(repo, [
        "rev-parse",
        "--verify",
        `refs/heads/${manifest.integrationBranch}`,
      ]),
      manifest.integrationHead,
    );
  });
});

test("supervisor status reports run, counts, integration, lock owner and checkpoint", async () => {
  await withRepo(async (repo) => {
    const base = runGit(repo, ["rev-parse", "HEAD"]);
    const contractsPath = writeContracts(repo, base);
    const startOut: string[] = [];
    await runSupervisorCli(
      ["start", contractsPath, "--repo", repo, "--dry-run"],
      { log: (line) => startOut.push(line), signalHandling: false },
    );
    const started = parseJson(startOut);
    const manifest = loadRunManifest(repo, started.runId as string);

    const jsonOut: string[] = [];
    const code = await runSupervisorCli(
      ["status", "--repo", repo, "--run", manifest.runId, "--json"],
      { log: (line) => jsonOut.push(line), signalHandling: false },
    );
    assert.equal(code, 0);
    const status = parseJson(jsonOut);
    assert.equal(status.runId, manifest.runId);
    assert.equal(status.status, "completed");
    assert.equal(status.accepted, 4);
    assert.equal(status.pending, 0);
    assert.equal(status.total, 4);
    assert.equal(status.integrationBranch, manifest.integrationBranch);
    assert.equal(status.integrationHead, manifest.integrationHead);
    assert.equal(status.integrationBranchHead, manifest.integrationHead);
    assert.equal(status.lock.state, "free");
    assert.equal(status.owner.pid, process.pid);
    assert.equal(status.ownerAlive, true);
    assert.equal(status.lastCheckpoint, manifest.updatedAt);
    assert.ok(status.lastAccepted);

    // Human output must expose the same fields operators rely on.
    const humanOut: string[] = [];
    await runSupervisorCli(["status", "--repo", repo], {
      log: (line) => humanOut.push(line),
      signalHandling: false,
    });
    const text = humanOut.join("\n");
    for (const label of [
      "runId:",
      "status: completed",
      "tasks: accepted 4 / pending 0",
      "integration:",
      "lock: free",
      "last checkpoint:",
    ]) {
      assert.ok(text.includes(label), `status output missing "${label}"`);
    }
  });
});

test("supervisor status reports a held lock and its owner", async () => {
  await withRepo(async (repo) => {
    const base = runGit(repo, ["rev-parse", "HEAD"]);
    const contractsPath = writeContracts(repo, base);
    const manifest = createRunManifest(repo, {
      planId: "status-lock",
      contractsPath,
      baseCommit: base,
      integrationBranch: "cliyard/integration/status-lock",
      tasks: ["foundation", "left"],
    });
    const lock = acquireSupervisorLock(repo, manifest.runId);
    try {
      const out: string[] = [];
      const code = await runSupervisorCli(
        ["status", "--repo", repo, "--run", manifest.runId, "--json"],
        { log: (line) => out.push(line), signalHandling: false },
      );
      assert.equal(code, 0);
      const status = parseJson(out);
      assert.equal(status.lock.state, "held");
      assert.equal(status.lock.owner.runId, manifest.runId);
      assert.equal(status.lock.owner.pid, process.pid);
      assert.equal(status.lock.owner.host, hostname());
      assert.equal(status.accepted, 0);
      assert.equal(status.pending, 2);
    } finally {
      lock.release();
    }
  });
});

// ---------------------------------------------------------------------------
// Interruption / resume
// ---------------------------------------------------------------------------

test("supervisor resume dispatches only unfinished tasks", async () => {
  await withRepo(async (repo) => {
    const base = runGit(repo, ["rev-parse", "HEAD"]);
    const contractsPath = writeContracts(repo, base);

    const first = await interruptFirstWave(repo, contractsPath);
    assert.equal(first.started.includes("foundation"), true);
    assert.equal(first.started.includes("upper"), false);

    const interrupted = loadRunManifest(repo);
    assert.equal(interrupted.status, "interrupted");
    assert.equal(interrupted.tasks["foundation"]?.accepted, true);
    const foundationCommit = interrupted.tasks["foundation"]?.resultCommit;
    assert.ok(foundationCommit);
    assert.equal(inspectSupervisorLock(repo).state, "free");

    const second: WorkerHarness = { started: [] };
    const out: string[] = [];
    const code = await runSupervisorCli(
      ["resume", "--repo", repo, "--worker", "claude"],
      {
        log: (line) => out.push(line),
        signalHandling: false,
        workerFactory: harnessFactory(second),
      },
    );

    assert.equal(code, 0);
    assert.deepEqual([...second.started].sort(), ["left", "right", "upper"]);
    assert.equal(second.started.includes("foundation"), false);

    const summary = parseJson(out);
    assert.equal(summary.resumed, true);
    assert.equal(summary.runId, interrupted.runId);
    assert.deepEqual(summary.startOrder, ["left", "right", "upper"]);
    assert.equal(summary.status, "completed");

    const completed = loadRunManifest(repo, interrupted.runId);
    assert.equal(completed.status, "completed");
    assert.equal(
      completed.tasks["foundation"]?.resultCommit,
      foundationCommit,
      "accepted work must not be regenerated on resume",
    );
    assert.equal(inspectSupervisorLock(repo).state, "free");
  });
});

test("supervisor resume rejects changed contracts and a moved base", async () => {
  await withRepo(async (repo) => {
    // "HEAD" lets the repository move after the manifest records its base.
    const contractsPath = writeContracts(repo, "HEAD");
    const original = readFileSync(contractsPath, "utf8");
    await interruptFirstWave(repo, contractsPath);
    const manifest = loadRunManifest(repo);
    assert.equal(manifest.status, "interrupted");

    const started: string[] = [];
    const workerFactory = (
      _worker: "codex" | "claude",
      cwd: string,
    ): AgentAdapter => {
      started.push("dispatched");
      return createFixtureWorker(cwd, { started: [] });
    };

    writeFileSync(contractsPath, `${original}\n`, "utf8");
    await assert.rejects(
      runSupervisorCli(["resume", "--repo", repo, "--worker", "claude"], {
        log: () => undefined,
        signalHandling: false,
        workerFactory,
      }),
      /contracts hash mismatch/,
    );
    assert.deepEqual(started, []);

    writeFileSync(contractsPath, original, "utf8");
    runGit(repo, ["commit", "--allow-empty", "-m", "move base"]);
    await assert.rejects(
      runSupervisorCli(["resume", "--repo", repo, "--worker", "claude"], {
        log: () => undefined,
        signalHandling: false,
        workerFactory,
      }),
      /base commit changed/,
    );
    assert.deepEqual(started, []);
    assert.equal(loadRunManifest(repo, manifest.runId).status, "interrupted");
    assert.equal(inspectSupervisorLock(repo).state, "free");
  });
});

// ---------------------------------------------------------------------------
// stop / lock exclusivity
// ---------------------------------------------------------------------------

test("supervisor stop clears a stale lock and marks the run interrupted", async () => {
  await withRepo(async (repo) => {
    const base = runGit(repo, ["rev-parse", "HEAD"]);
    const contractsPath = writeContracts(repo, base);
    const deadPid = await exitedPid();
    const manifest = createRunManifest(repo, {
      planId: "stop-fixture",
      contractsPath,
      baseCommit: base,
      integrationBranch: "cliyard/integration/stop-fixture",
      tasks: ["foundation", "left", "right", "upper"],
      owner: { pid: deadPid, host: hostname() },
    });
    writeFileSync(
      supervisorPaths(repo).lockPath,
      JSON.stringify({
        runId: manifest.runId,
        pid: deadPid,
        host: hostname(),
        acquiredAt: new Date().toISOString(),
      }) + "\n",
      "utf8",
    );
    assert.equal(inspectSupervisorLock(repo).state, "stale");

    const out: string[] = [];
    const code = await runSupervisorCli(["stop", "--repo", repo], {
      log: (line) => out.push(line),
      signalHandling: false,
    });
    assert.equal(code, 0);
    assert.match(out.join("\n"), /status interrupted/);
    assert.equal(loadRunManifest(repo, manifest.runId).status, "interrupted");
    assert.equal(inspectSupervisorLock(repo).state, "free");

    // A lock owned by this live process must not be signalled by accident.
    const held = acquireSupervisorLock(repo, manifest.runId);
    try {
      await assert.rejects(
        runSupervisorCli(["stop", "--repo", repo], {
          log: () => undefined,
          signalHandling: false,
        }),
        /refusing to signal itself/,
      );
      assert.equal(inspectSupervisorLock(repo).state, "held");
    } finally {
      held.release();
    }
  });
});

test("a second start cannot acquire a held supervisor lock", async () => {
  await withRepo(async (repo) => {
    const base = runGit(repo, ["rev-parse", "HEAD"]);
    const contractsPath = writeContracts(repo, base);
    const lock = acquireSupervisorLock(repo, "already-running");
    try {
      await assert.rejects(
        runSupervisorCli(
          ["start", contractsPath, "--repo", repo, "--dry-run"],
          { log: () => undefined, signalHandling: false },
        ),
        SupervisorLockHeldError,
      );
      assert.equal(existsSync(supervisorPaths(repo).activePath), false);
    } finally {
      lock.release();
    }
  });
});

// ---------------------------------------------------------------------------
// src/cli.ts wiring
// ---------------------------------------------------------------------------

test("src/cli.ts dispatches supervisor status", async () => {
  await withRepo(async (repo) => {
    const base = runGit(repo, ["rev-parse", "HEAD"]);
    const contractsPath = writeContracts(repo, base);
    const startOut: string[] = [];
    await runSupervisorCli(
      ["start", contractsPath, "--repo", repo, "--dry-run"],
      { log: (line) => startOut.push(line), signalHandling: false },
    );
    const started = parseJson(startOut);

    const result = spawnSync(
      process.execPath,
      [
        "--import",
        "tsx",
        CLI_PATH,
        "supervisor",
        "status",
        "--repo",
        repo,
        "--run",
        started.runId as string,
        "--json",
      ],
      { cwd: ROOT, encoding: "utf8" },
    );
    assert.equal(result.status, 0, result.stderr);
    const status = JSON.parse(result.stdout) as Record<string, any>;
    assert.equal(status.runId, started.runId);
    assert.equal(status.status, "completed");
    assert.equal(status.accepted, 4);
  });
});

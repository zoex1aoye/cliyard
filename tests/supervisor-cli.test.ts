import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import {
  chmodSync,
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

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 10_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
  }
  throw new Error(`timed out after ${timeoutMs}ms`);
}

function runCliProcess(
  args: string[],
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", CLI_PATH, ...args], {
      cwd: ROOT,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", reject);
    child.on("close", (status) => resolvePromise({ status, stdout, stderr }));
  });
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

test(
  "SIGKILL leaves a stale checkpoint and a new process resumes only unfinished work",
  { skip: process.platform === "win32", timeout: 30_000 },
  async () => {
    const repo = initRepo();
    let supervisor:
      | ReturnType<typeof spawn>
      | undefined;
    try {
      const base = runGit(repo, ["rev-parse", "HEAD"]);
      const contractsPath = join(repo, "process-e2e.contracts.json");
      writeFileSync(
        contractsPath,
        JSON.stringify(
          {
            contracts: [
              contract("foundation", [], "foundation.ts", base, [
                "test -f foundation.ts",
              ]),
              contract("upper", ["foundation"], "upper.ts", base, [
                "test -f foundation.ts",
                "test -f upper.ts",
              ]),
            ],
          },
          null,
          2,
        ) + "\n",
        "utf8",
      );

      const fakeClaude = join(repo, "fake-claude.cjs");
      writeFileSync(
        fakeClaude,
        `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");

if (process.argv.includes("--version")) {
  console.log("fixture-claude 1.0");
  process.exit(0);
}

const promptIndex = process.argv.indexOf("-p");
const prompt = promptIndex >= 0 ? process.argv[promptIndex + 1] : "";
const taskId = (prompt.match(/Task:\\s*(\\S+)/) || [])[1];
const writePath = (prompt.match(/Write only under:\\n- ([^\\n]+)/) || [])[1];
if (!taskId || !writePath) {
  console.error("fixture could not parse task prompt");
  process.exit(2);
}

if (process.env.CLIYARD_TEST_WORKER_LOG) {
  fs.appendFileSync(process.env.CLIYARD_TEST_WORKER_LOG, taskId + "\\n");
}
if (
  taskId === process.env.CLIYARD_TEST_BLOCK_TASK &&
  process.env.CLIYARD_TEST_UNBLOCK !== "1"
) {
  fs.writeFileSync(process.env.CLIYARD_TEST_MARKER, taskId + "\\n");
  setInterval(() => {}, 1000);
} else {
  const target = path.resolve(process.cwd(), writePath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, "export const task = '" + taskId + "';\\n");
  console.log(JSON.stringify({
    type: "result",
    subtype: "success",
    is_error: false,
    result: "fixture completed " + taskId,
    session_id: "fixture-" + taskId,
    total_cost_usd: 0,
    usage: { input_tokens: 0, output_tokens: 0 },
    modelUsage: {}
  }));
}
`,
        "utf8",
      );
      chmodSync(fakeClaude, 0o755);

      const marker = join(repo, "upper-started");
      const workerLog = join(repo, "worker-calls.log");
      const env = {
        ...process.env,
        CLIYARD_CLAUDE_BINARY: fakeClaude,
        CLIYARD_CLAUDE_MAX_CONCURRENT: "1",
        CLIYARD_TEST_BLOCK_TASK: "upper",
        CLIYARD_TEST_MARKER: marker,
        CLIYARD_TEST_WORKER_LOG: workerLog,
      };
      supervisor = spawn(
        process.execPath,
        [
          "--import",
          "tsx",
          CLI_PATH,
          "supervisor",
          "start",
          contractsPath,
          "--repo",
          repo,
          "--worker",
          "claude",
          "--model",
          "fixture-model",
          "--ledger",
          join(repo, ".cliyard", "ledger-process-e2e.json"),
        ],
        {
          cwd: ROOT,
          env,
          detached: true,
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      let supervisorStdout = "";
      let supervisorStderr = "";
      supervisor.stdout?.on("data", (chunk) => {
        supervisorStdout += String(chunk);
      });
      supervisor.stderr?.on("data", (chunk) => {
        supervisorStderr += String(chunk);
      });
      assert.ok(supervisor.pid);

      await waitFor(() => {
        const activePath = supervisorPaths(repo).activePath;
        if (!existsSync(activePath) || !existsSync(marker)) return false;
        const active = JSON.parse(readFileSync(activePath, "utf8")) as {
          runId: string;
        };
        const manifestPath = join(
          supervisorPaths(repo).runsDir,
          `${active.runId}.json`,
        );
        if (!existsSync(manifestPath)) return false;
        const manifest = JSON.parse(
          readFileSync(manifestPath, "utf8"),
        ) as { tasks: Record<string, { accepted: boolean }> };
        return manifest.tasks.foundation?.accepted === true;
      });

      const interrupted = loadRunManifest(repo);
      assert.equal(interrupted.tasks.foundation?.accepted, true);
      assert.notEqual(interrupted.tasks.upper?.accepted, true);
      const foundationCommit = interrupted.tasks.foundation?.resultCommit;
      assert.ok(foundationCommit);

      const supervisorExit = once(supervisor, "exit");
      process.kill(-supervisor.pid, "SIGKILL");
      await supervisorExit;
      assert.equal(existsSync(marker), true);

      const statusResult = await runCliProcess(
        ["supervisor", "status", "--repo", repo, "--json"],
        env,
      );
      assert.equal(
        statusResult.status,
        0,
        `${statusResult.stderr}\n${supervisorStderr}`,
      );
      const status = JSON.parse(statusResult.stdout) as Record<string, any>;
      assert.equal(status.effectiveStatus, "interrupted");
      assert.equal(status.lock.state, "stale");
      assert.equal(status.accepted, 1);
      assert.equal(status.pending, 1);

      const resumeResult = await runCliProcess(
        [
          "supervisor",
          "resume",
          "--repo",
          repo,
          "--worker",
          "claude",
          "--model",
          "fixture-model",
          "--ledger",
          join(repo, ".cliyard", "ledger-process-e2e.json"),
        ],
        { ...env, CLIYARD_TEST_UNBLOCK: "1" },
      );
      assert.equal(
        resumeResult.status,
        0,
        `${resumeResult.stderr}\n${supervisorStdout}\n${supervisorStderr}`,
      );
      const summary = JSON.parse(resumeResult.stdout) as Record<string, any>;
      assert.equal(summary.status, "completed");
      assert.equal(summary.resumed, true);
      assert.deepEqual(summary.startOrder, ["upper"]);

      const completed = loadRunManifest(repo, interrupted.runId);
      assert.equal(completed.status, "completed");
      assert.equal(completed.tasks.upper?.accepted, true);
      assert.equal(
        completed.tasks.foundation?.resultCommit,
        foundationCommit,
        "SIGKILL resume must not regenerate accepted work",
      );
      assert.equal(inspectSupervisorLock(repo).state, "free");
      assert.equal(
        readFileSync(workerLog, "utf8")
          .trim()
          .split("\n")
          .filter((taskId) => taskId === "foundation").length,
        1,
      );
      assert.match(
        runGit(repo, [
          "show",
          `${completed.integrationBranch}:foundation.ts`,
        ]),
        /task = 'foundation'/,
      );
      assert.match(
        runGit(repo, ["show", `${completed.integrationBranch}:upper.ts`]),
        /task = 'upper'/,
      );
    } finally {
      if (supervisor?.pid && supervisor.exitCode === null) {
        try {
          process.kill(-supervisor.pid, "SIGKILL");
        } catch {
          /* already exited */
        }
      }
      rmSync(repo, { recursive: true, force: true });
    }
  },
);

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

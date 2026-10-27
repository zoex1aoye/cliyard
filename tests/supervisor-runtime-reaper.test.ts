/**
 * Process-level Supervisor CLI tests for orphan-runtime reconciliation
 * (design/runtime-orphan-reaper-v0.md, "Supervisor integration").
 *
 * Every command runs in a real child process against a scratch git repo, so
 * these tests exercise argument parsing, lock acquisition, the persisted
 * reaper evidence, and fail-closed exits exactly as an operator would see them.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { hostname, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { takeTestPortRange } from "./test-port-ranges.js";
import {
  RUNTIME_MANIFEST_FILE,
  runtimePaths,
} from "../src/runtime/manager.js";
import { PortAllocator } from "../src/runtime/ports.js";
import { ProcessInspector } from "../src/runtime/process.js";
import type {
  PortLease,
  RuntimeCleanupState,
  RuntimeManifest,
  RuntimeProcessIdentity,
  RuntimeRecoveryRecord,
} from "../src/runtime/types.js";
import {
  createRunManifest,
  loadRunManifest,
  supervisorPaths,
  updateRunManifest,
} from "../src/supervisor/store.js";
import type { RunManifest } from "../src/supervisor/types.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const CLI_PATH = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
const inspector = new ProcessInspector();

/** A pid above every configured OS pid limit: always provably dead. */
const DEAD_PID = 999_999_999;

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
  const repo = mkdtempSync(join(tmpdir(), "cliyard-supervisor-reaper-"));
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

function runCliProcess(
  args: string[],
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(
      process.execPath,
      ["--import", "tsx", CLI_PATH, ...args],
      {
        cwd: ROOT,
        env,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
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

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

/**
 * Allocate real leases, then rewrite their owner pid to a provably dead one so
 * preflight treats the runtime as an orphan. Allocation must happen first
 * because the allocator prunes dead-owner leases when reserving ports.
 */
async function allocateOrphanLeases(
  repo: string,
  requests: ReadonlyArray<{ runtimeId: string; service: string }>,
): Promise<PortLease[]> {
  const { range } = takeTestPortRange(
    "supervisor-runtime-reaper",
    requests.length + 2,
  );
  const allocator = new PortAllocator({ repoRoot: repo, range });
  const allocated: PortLease[] = [];
  for (const request of requests) {
    allocated.push(await allocator.allocate(request.runtimeId, request.service));
  }

  const path = join(repo, ".cliyard", "runtime", "port-leases.json");
  const store = JSON.parse(readFileSync(path, "utf8")) as {
    version: number;
    leases: PortLease[];
  };
  for (const lease of store.leases) lease.pid = DEAD_PID;
  writeFileSync(path, JSON.stringify(store, null, 2) + "\n", "utf8");

  return allocated.map((lease) => ({ ...lease, pid: DEAD_PID }));
}

function listLeases(repo: string): PortLease[] {
  return new PortAllocator({ repoRoot: repo }).list();
}

/** A detached process that has already exited, leaving an empty group. */
async function exitedProcess(): Promise<{
  pid: number;
  identity: RuntimeProcessIdentity;
}> {
  const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 500);"], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  const exit = once(child, "exit");
  await once(child, "spawn");
  const pid = child.pid;
  assert.ok(pid, "fixture process has no pid");
  const identity = await inspector.capture(pid);
  assert.ok(identity, "fixture process has no capturable identity");
  assert.equal(identity.pid, pid);
  assert.equal(identity.pgid, pid);
  await exit;

  const deadline = Date.now() + 5_000;
  while ((await inspector.listGroupMembers(pid)).length > 0) {
    if (Date.now() >= deadline) {
      throw new Error(`fixture process group ${pid} did not empty`);
    }
    await delay(25);
  }
  return { pid, identity };
}

async function stopGroup(
  child: ChildProcess,
  pid: number,
): Promise<void> {
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    /* group already gone */
  }
  try {
    child.kill("SIGKILL");
  } catch {
    /* already exited */
  }
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolveExit) => {
    const timer = setTimeout(resolveExit, 5_000);
    child.once("exit", () => {
      clearTimeout(timer);
      resolveExit();
    });
  });
}

interface OrphanManifestInput {
  runtimeId: string;
  lease: PortLease;
  pid: number;
  pgid: number;
  identity: RuntimeProcessIdentity;
  serviceName?: string;
  cleanup?: RuntimeCleanupState;
}

function makeOrphanManifest(input: OrphanManifestInput): RuntimeManifest {
  const serviceName = input.serviceName ?? "web";
  const url = `http://127.0.0.1:${input.lease.port}`;
  return {
    version: 1,
    runtimeId: input.runtimeId,
    taskId: `task-${input.runtimeId}`,
    attempt: 1,
    worktree: "/tmp/cliyard-supervisor-reaper-worktree",
    owner: { pid: DEAD_PID, host: hostname() },
    services: [
      {
        name: serviceName,
        host: "127.0.0.1",
        port: input.lease.port,
        pid: input.pid,
        pgid: input.pgid,
        processIdentity: input.identity,
        url,
        healthUrl: `${url}/`,
        logPath: `/tmp/${input.runtimeId}-${serviceName}.log`,
        dataDir: `/tmp/${input.runtimeId}-${serviceName}-data`,
        readinessAttempts: [],
      },
    ],
    startedAt: new Date().toISOString(),
    cleanup: input.cleanup ?? "pending",
  };
}

function writeRuntimeManifest(
  repo: string,
  manifest: RuntimeManifest,
): string {
  const path = runtimePaths(repo, manifest.runtimeId).manifestPath;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(manifest, null, 2) + "\n", "utf8");
  return path;
}

/** An unreadable runtime manifest: preflight must classify it needs_human. */
function writeBrokenRuntime(repo: string, runtimeId = "runtime-broken"): string {
  const path = runtimePaths(repo, runtimeId).manifestPath;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, "{ this is not valid json\n", "utf8");
  return path;
}

function readRuntimeManifest(
  repo: string,
  runtimeId: string,
): RuntimeManifest {
  return JSON.parse(
    readFileSync(runtimePaths(repo, runtimeId).manifestPath, "utf8"),
  ) as RuntimeManifest;
}

function writeContracts(repo: string, baseCommit: string): string {
  const path = join(repo, "contracts.json");
  writeFileSync(
    path,
    JSON.stringify(
      {
        contracts: [
          {
            taskId: "foundation",
            version: 1,
            frozen: true,
            goals: ["Create foundation.ts"],
            dependsOn: [],
            readPaths: ["."],
            writePaths: ["foundation.ts"],
            sharedResources: [],
            baseCommit,
            verifyCommands: ["test -f foundation.ts"],
            maxRepairs: 0,
          },
        ],
      },
      null,
      2,
    ) + "\n",
    "utf8",
  );
  return path;
}

/** A resumable run: interrupted status plus its integration checkpoint. */
function createInterruptedRun(
  repo: string,
  contractsPath: string,
  baseCommit: string,
): RunManifest {
  const manifest = createRunManifest(repo, {
    planId: "reaper-fixture",
    contractsPath,
    baseCommit,
    integrationBranch: "cliyard/integration/reaper-fixture",
    tasks: ["foundation"],
  });
  runGit(repo, [
    "update-ref",
    `refs/heads/${manifest.integrationBranch}`,
    baseCommit,
  ]);
  return updateRunManifest(repo, manifest.runId, (current) => {
    current.status = "interrupted";
    current.owner = { pid: DEAD_PID, host: hostname() };
  });
}

function parseJsonOutput(stdout: string): Record<string, any> {
  return JSON.parse(stdout) as Record<string, any>;
}

// ---------------------------------------------------------------------------
// reap: real reconciliation and human/JSON records
// ---------------------------------------------------------------------------

test("supervisor reap --json reaps a proven orphan and reports its record", async () => {
  await withRepo(async (repo) => {
    const exited = await exitedProcess();
    const [lease] = await allocateOrphanLeases(repo, [
      { runtimeId: "runtime-orphan", service: "web" },
    ]);
    const manifestPath = writeRuntimeManifest(
      repo,
      makeOrphanManifest({
        runtimeId: "runtime-orphan",
        lease,
        pid: exited.pid,
        pgid: exited.pid,
        identity: exited.identity,
      }),
    );

    const result = await runCliProcess([
      "supervisor",
      "reap",
      "--repo",
      repo,
      "--json",
    ]);
    assert.equal(result.status, 0, result.stderr);

    const report = parseJsonOutput(result.stdout);
    assert.equal(report.scanned, 1);
    assert.equal(report.needsHuman.length, 0);
    assert.equal(report.skipped.length, 0);
    assert.equal(report.reaped.length, 1);

    const record = report.reaped[0] as RuntimeRecoveryRecord;
    assert.equal(record.state, "reaped");
    assert.equal(record.reaperHost, hostname());
    assert.ok(record.reaperPid > 0);
    assert.equal(record.services.length, 1);
    assert.equal(record.services[0].name, "web");
    assert.equal(record.services[0].action, "already-exited");
    assert.equal(record.services[0].portReleased, true);

    // The executor persisted the exact record and finalized the runtime.
    const finalized = readRuntimeManifest(repo, "runtime-orphan");
    assert.equal(finalized.cleanup, "complete");
    assert.deepEqual(finalized.recovery, record);
    assert.deepEqual(listLeases(repo), []);
    assert.ok(readFileSync(manifestPath, "utf8").includes('"complete"'));

    // Human output reports the remaining broken runtime with its id/reason.
    writeBrokenRuntime(repo);
    const human = await runCliProcess([
      "supervisor",
      "reap",
      "--repo",
      repo,
    ]);
    assert.equal(human.status, 0, human.stderr);
    const text = human.stdout;
    assert.match(text, /^scanned: 2$/m);
    assert.match(text, /^reaped: 0$/m);
    assert.match(text, /^needs human: 1$/m);
    assert.match(text, /^skipped: 1$/m);
    assert.match(text, /needs human runtime-broken: .*invalid JSON/);
    assert.match(text, /skipped runtime-orphan: cleanup is complete/);
  });
});

// ---------------------------------------------------------------------------
// status: read-only persisted recovery evidence
// ---------------------------------------------------------------------------

test("supervisor status exposes persisted recovery records without reconciling", async () => {
  await withRepo(async (repo) => {
    const base = runGit(repo, ["rev-parse", "HEAD"]);
    const contractsPath = writeContracts(repo, base);
    const run = createRunManifest(repo, {
      planId: "status-recovery",
      contractsPath,
      baseCommit: base,
      integrationBranch: "cliyard/integration/status-recovery",
      tasks: ["foundation"],
    });

    const recovery: RuntimeRecoveryRecord = {
      state: "reaped",
      reason: "owner pid 999999999 is not running on this host",
      at: new Date().toISOString(),
      reaperPid: 4242,
      reaperHost: hostname(),
      services: [
        { name: "web", pgid: 4242, action: "terminated", portReleased: true },
      ],
    };
    const recoveredPath = writeRuntimeManifest(repo, {
      version: 1,
      runtimeId: "runtime-recovered",
      taskId: "task-recovered",
      attempt: 1,
      worktree: "/tmp/cliyard-supervisor-reaper-worktree",
      owner: { pid: DEAD_PID, host: hostname() },
      services: [],
      startedAt: "2026-10-27T00:00:00.000Z",
      stoppedAt: recovery.at,
      cleanup: "complete",
      recovery,
    });

    // A still-unreconciled orphan: status must report the persisted record but
    // leave this process, lease, and manifest untouched.
    const live = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000);"], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    await once(live, "spawn");
    const livePid = live.pid;
    assert.ok(livePid);
    const liveIdentity = await inspector.capture(livePid);
    assert.ok(liveIdentity);
    try {
      const [liveLease] = await allocateOrphanLeases(repo, [
        { runtimeId: "runtime-live", service: "web" },
      ]);
      const livePath = writeRuntimeManifest(
        repo,
        makeOrphanManifest({
          runtimeId: "runtime-live",
          lease: liveLease,
          pid: livePid,
          pgid: livePid,
          identity: liveIdentity,
        }),
      );

      const paths = [recoveredPath, livePath];
      const before = new Map(
        paths.map((path) => [path, readFileSync(path, "utf8")]),
      );
      const leasesBefore = listLeases(repo);
      const leaseStorePath = join(
        repo,
        ".cliyard",
        "runtime",
        "port-leases.json",
      );
      const leaseStoreBefore = readFileSync(leaseStorePath, "utf8");

      const json = await runCliProcess([
        "supervisor",
        "status",
        "--repo",
        repo,
        "--run",
        run.runId,
        "--json",
      ]);
      assert.equal(json.status, 0, json.stderr);
      const status = parseJsonOutput(json.stdout);
      assert.equal(status.runId, run.runId);
      assert.equal(status.runtimeRecovery.length, 1);
      const entry = status.runtimeRecovery[0];
      assert.equal(entry.runtimeId, "runtime-recovered");
      assert.equal(entry.cleanup, "complete");
      assert.deepEqual(entry.recovery, recovery);

      const human = await runCliProcess([
        "supervisor",
        "status",
        "--repo",
        repo,
        "--run",
        run.runId,
      ]);
      assert.equal(human.status, 0, human.stderr);
      assert.match(
        human.stdout,
        /runtime recovery: runtime-recovered reaped at .*owner pid 999999999/,
      );

      // Read-only: no manifest, lease store, process, or reaper lock changed.
      for (const [path, bytes] of before) {
        assert.equal(readFileSync(path, "utf8"), bytes);
      }
      assert.equal(readFileSync(leaseStorePath, "utf8"), leaseStoreBefore);
      assert.deepEqual(listLeases(repo), leasesBefore);
      assert.equal(inspector.isAlive(livePid), true);
      const stillPending = readRuntimeManifest(repo, "runtime-live");
      assert.equal(stillPending.cleanup, "pending");
      assert.equal(stillPending.recovery, undefined);
      assert.equal(
        existsSync(join(repo, ".cliyard", "runtime", "reaper.lock")),
        false,
      );
    } finally {
      await stopGroup(live, livePid);
    }
  });
});

// ---------------------------------------------------------------------------
// start / resume: fail closed on needs_human candidates
// ---------------------------------------------------------------------------

test("supervisor start fails closed before creating a run when reconciliation needs human review", async () => {
  await withRepo(async (repo) => {
    const base = runGit(repo, ["rev-parse", "HEAD"]);
    const contractsPath = writeContracts(repo, base);
    writeBrokenRuntime(repo);

    const result = await runCliProcess([
      "supervisor",
      "start",
      contractsPath,
      "--repo",
      repo,
      "--dry-run",
    ]);

    assert.equal(result.status, 1, `start should fail closed:\n${result.stdout}`);
    assert.match(
      result.stderr,
      /supervisor start: orphan runtime reconciliation needs human review/,
    );
    assert.match(result.stderr, /runtime-broken/);
    assert.match(result.stderr, /invalid JSON/);
    assert.equal(result.stdout.trim(), "", "no batch summary may be emitted");

    // No run was created and the supervisor lock was released.
    const paths = supervisorPaths(repo);
    assert.equal(
      existsSync(paths.runsDir) ? readdirSync(paths.runsDir).length : 0,
      0,
    );
    assert.equal(existsSync(paths.activePath), false);
    assert.equal(existsSync(paths.lockPath), false);
  });
});

test("supervisor resume fails closed without marking the run running or dispatching", async () => {
  await withRepo(async (repo) => {
    const base = runGit(repo, ["rev-parse", "HEAD"]);
    const contractsPath = writeContracts(repo, base);
    const run = createInterruptedRun(repo, contractsPath, base);
    const runPath = join(supervisorPaths(repo).runsDir, `${run.runId}.json`);
    const runBefore = readFileSync(runPath, "utf8");
    writeBrokenRuntime(repo);

    const result = await runCliProcess([
      "supervisor",
      "resume",
      "--repo",
      repo,
      "--dry-run",
    ]);

    assert.equal(
      result.status,
      1,
      `resume should fail closed:\n${result.stdout}\n${result.stderr}`,
    );
    assert.match(
      result.stderr,
      /supervisor resume: orphan runtime reconciliation needs human review/,
    );
    assert.match(result.stderr, /runtime-broken/);
    assert.match(result.stderr, /invalid JSON/);
    assert.equal(result.stdout.trim(), "", "no batch may start");

    // The run was neither marked running nor checkpointed, and the lock was
    // released so an operator can retry after resolving the evidence.
    assert.equal(readFileSync(runPath, "utf8"), runBefore);
    const after = loadRunManifest(repo, run.runId);
    assert.equal(after.status, "interrupted");
    assert.equal(after.tasks.foundation?.accepted, false);
    assert.equal(existsSync(supervisorPaths(repo).lockPath), false);
    assert.equal(
      runGit(repo, ["rev-parse", `refs/heads/${run.integrationBranch}`]),
      base,
    );
  });
});

// ---------------------------------------------------------------------------
// resume: reconciliation precedes the resumed batch
// ---------------------------------------------------------------------------

test("supervisor resume reaps a proven orphan before dispatching unfinished work", async () => {
  await withRepo(async (repo) => {
    const base = runGit(repo, ["rev-parse", "HEAD"]);
    const contractsPath = writeContracts(repo, base);
    const run = createInterruptedRun(repo, contractsPath, base);

    const exited = await exitedProcess();
    const [lease] = await allocateOrphanLeases(repo, [
      { runtimeId: "runtime-resume-orphan", service: "web" },
    ]);
    writeRuntimeManifest(
      repo,
      makeOrphanManifest({
        runtimeId: "runtime-resume-orphan",
        lease,
        pid: exited.pid,
        pgid: exited.pid,
        identity: exited.identity,
      }),
    );

    const result = await runCliProcess([
      "supervisor",
      "resume",
      "--repo",
      repo,
      "--dry-run",
    ]);

    assert.equal(
      result.status,
      0,
      `${result.stdout}\n${result.stderr}`,
    );
    const summary = parseJsonOutput(result.stdout);
    assert.equal(summary.runId, run.runId);
    assert.equal(summary.resumed, true);
    assert.equal(summary.status, "completed");
    assert.deepEqual(summary.startOrder, ["foundation"]);

    // The orphan was reaped and its lease released before the batch finished.
    const finalized = readRuntimeManifest(repo, "runtime-resume-orphan");
    assert.equal(finalized.cleanup, "complete");
    assert.equal(finalized.recovery?.state, "reaped");
    assert.deepEqual(listLeases(repo), []);

    const completed = loadRunManifest(repo, run.runId);
    assert.equal(completed.status, "completed");
    assert.equal(completed.tasks.foundation?.accepted, true);
    assert.equal(existsSync(supervisorPaths(repo).lockPath), false);
    assert.equal(
      existsSync(
        join(
          repo,
          ".cliyard",
          "runtime",
          "runtime-resume-orphan",
          RUNTIME_MANIFEST_FILE,
        ),
      ),
      true,
    );
  });
});

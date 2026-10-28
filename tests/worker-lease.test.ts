/**
 * WorkerLease v1 (design/worker-lease-v1.md).
 *
 * Real POSIX fixtures own the group-identity and SIGKILL recovery tests; the
 * fake inspector cases cover the decision matrix (live owner, foreign host,
 * mismatch, missing identity) without ever signalling an unrelated process.
 * Windows has no POSIX group, so those tests are skipped there.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
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
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { ProcessInspector, type ProcessGroupMember } from "../src/runtime/process.js";
import type { RuntimeProcessIdentity } from "../src/runtime/types.js";
import { createClaudeAdapter } from "../src/agents/claude.js";
import { createCodexAdapter } from "../src/agents/codex.js";
import type {
  ManagedWorkerProcess,
  WorkerProcessCleanupOutcome,
  WorkerProcessTreeInspector,
} from "../src/agents/process-tree.js";
import {
  buildWorkerLeaseStatus,
  createWorkerLeaseAttacher,
  parseWorkerLease,
  readLeaseFile,
  readWorkerLeases,
  recoverWorkerLeases,
  workerLeasePath,
  workerLeasesDir,
  type WorkerLease,
} from "../src/agents/worker-lease.js";
import type { TaskContract } from "../src/contracts/schema.js";
import { runSupervisorCli } from "../src/supervisor/cli.js";
import { createRunManifest } from "../src/supervisor/store.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const CLI_PATH = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
const POSIX = process.platform !== "win32";
const posixTest = POSIX ? test : test.skip;
const realInspector = new ProcessInspector();

const scratch = mkdtempSync(join(tmpdir(), "cliyard-worker-lease-"));
let seq = 0;
const liveFixturePids = new Set<number>();

function cleanupScratch(): void {
  for (const pgid of liveFixturePids) {
    try {
      process.kill(-pgid, "SIGKILL");
    } catch {
      /* already gone */
    }
  }
  rmSync(scratch, { recursive: true, force: true });
}
process.on("exit", cleanupScratch);

function tempDir(label: string): string {
  seq += 1;
  const path = join(scratch, `${label}-${seq}`);
  mkdirSync(path, { recursive: true });
  return path;
}

async function waitFor(
  predicate: () => boolean,
  label: string,
  timeoutMs = 8_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await delay(20);
  }
  throw new Error(`timed out waiting for ${label}`);
}

function runGit(cwd: string, args: string[]): string {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(
    result.status,
    0,
    `git ${args.join(" ")} failed: ${result.stderr}`,
  );
  return result.stdout.trim();
}

function initRepo(): string {
  const repo = tempDir("repo");
  runGit(repo, ["init"]);
  runGit(repo, ["config", "user.email", "t@t.com"]);
  runGit(repo, ["config", "user.name", "t"]);
  writeFileSync(join(repo, "README.md"), "# worker lease fixture\n");
  runGit(repo, ["add", "."]);
  runGit(repo, ["commit", "-m", "init"]);
  return repo;
}

function contractFor(repo: string): TaskContract {
  const baseCommit = runGit(repo, ["rev-parse", "HEAD"]);
  return {
    taskId: "worker-lease",
    version: 1,
    frozen: true,
    goals: ["Prove worker lease lifecycle"],
    dependsOn: [],
    readPaths: ["."],
    writePaths: ["allowed.ts"],
    sharedResources: [],
    baseCommit,
    verifyCommands: ["true"],
    maxRepairs: 0,
  };
}

// ---------------------------------------------------------------------------
// Fake inspector / managed process
// ---------------------------------------------------------------------------

class FakeInspector implements WorkerProcessTreeInspector {
  readonly host = "host-a";
  readonly supported = true;
  readonly identities = new Map<number, RuntimeProcessIdentity>();

  add(identity: RuntimeProcessIdentity): void {
    this.identities.set(identity.pid, { ...identity });
  }

  remove(pid: number): void {
    this.identities.delete(pid);
  }

  isAlive(pid: number | undefined): boolean {
    return pid !== undefined && this.identities.has(pid);
  }

  async capture(
    pid: number | undefined,
  ): Promise<RuntimeProcessIdentity | undefined> {
    if (pid === undefined) return undefined;
    const identity = this.identities.get(pid);
    return identity ? { ...identity } : undefined;
  }

  async listGroupMembers(
    pgid: number | undefined,
  ): Promise<ProcessGroupMember[]> {
    if (pgid === undefined) return [];
    return [...this.identities.values()]
      .filter((identity) => identity.pgid === pgid)
      .sort((left, right) => left.pid - right.pid)
      .map((identity) => ({ ...identity }));
  }

  snapshot(): Record<number, RuntimeProcessIdentity> {
    return Object.fromEntries(
      [...this.identities].map(([pid, identity]) => [pid, { ...identity }]),
    );
  }
}

function cleanupOutcome(
  reason: WorkerProcessCleanupOutcome["record"]["cleanupReason"],
  options: {
    identity?: RuntimeProcessIdentity;
    captureSource?: WorkerProcessCleanupOutcome["record"]["captureSource"];
    treeOk?: boolean;
    cleanupState?: WorkerProcessCleanupOutcome["record"]["cleanupState"];
    pid?: number;
  } = {},
): WorkerProcessCleanupOutcome {
  const identity = options.identity;
  return {
    treeOk: options.treeOk ?? true,
    record: {
      version: 1,
      host: "host-a",
      ...(options.pid !== undefined ? { pid: options.pid } : {}),
      ...(identity ? { pgid: identity.pgid, identity: { ...identity } } : {}),
      captureSource:
        options.captureSource ?? (identity ? "ps-exact" : "none"),
      captureSupport: "posix-process-group",
      cleanupReason: reason,
      cleanupState:
        options.cleanupState ??
        (options.treeOk === false ? "failed" : "terminated"),
      signals: [],
      residualMembers: [],
      residualCount: 0,
      startedAt: "2026-01-01T00:00:00.000Z",
      cleanedAt: "2026-01-01T00:00:01.000Z",
    },
  };
}

function fakeManaged(options: {
  pid?: number;
  identity?: RuntimeProcessIdentity;
  captureError?: string;
  outcome?: WorkerProcessCleanupOutcome;
}): {
  managed: ManagedWorkerProcess;
  cleanupReasons: Array<WorkerProcessCleanupOutcome["record"]["cleanupReason"]>;
} {
  const cleanupReasons: Array<
    WorkerProcessCleanupOutcome["record"]["cleanupReason"]
  > = [];
  const managed: ManagedWorkerProcess = {
    child: { pid: options.pid } as unknown as ChildProcess,
    pid: options.pid,
    captureSupport: "posix-process-group",
    async captureIdentity() {
      if (options.identity) return { identity: { ...options.identity } };
      return options.captureError !== undefined
        ? { error: options.captureError }
        : {};
    },
    async cleanup(reason) {
      cleanupReasons.push(reason);
      return (
        options.outcome ??
        cleanupOutcome(reason, {
          ...(options.pid !== undefined ? { pid: options.pid } : {}),
          ...(options.identity ? { identity: options.identity } : {}),
        })
      );
    },
  };
  return { managed, cleanupReasons };
}

function identity(
  pid: number,
  startedAt = "Mon Jan  1 00:00:00 2024",
): RuntimeProcessIdentity {
  return { pid, pgid: pid, startedAt };
}

function attachInput(managed: ManagedWorkerProcess, label = "invocation") {
  return {
    taskId: "task-a",
    attempt: 0,
    invocationId: `${label}-${++seq}`,
    workspace: "/tmp/workspace",
    managed,
  };
}

// ---------------------------------------------------------------------------
// Attach and lifecycle
// ---------------------------------------------------------------------------

test("attacher persists exact identity and a cleanup update without rewriting it", async () => {
  const repo = tempDir("attach");
  const workerIdentity = identity(50_001);
  const { managed } = fakeManaged({
    pid: workerIdentity.pid,
    identity: workerIdentity,
  });
  const attach = createWorkerLeaseAttacher({
    repoRoot: repo,
    runId: "run-attach",
    controller: {
      pid: 41_000,
      host: "host-a",
      identity: identity(41_000),
    },
  });
  const handle = await attach(
    attachInput(managed, "normal"),
  );

  const active = readLeaseFile(handle.path);
  assert.ok(active);
  assert.equal(active.state, "active");
  assert.equal(active.worker.pid, workerIdentity.pid);
  assert.equal(active.worker.pgid, workerIdentity.pgid);
  assert.equal(active.worker.osStartIdentity, workerIdentity.startedAt);
  assert.equal(active.worker.captureMode, "posix-group");
  assert.equal(active.controller.pid, 41_000);
  assert.equal(active.repoRoot, resolve(repo));
  // No prompts, commands, environment values or provider output belong here.
  const serialized = JSON.stringify(active);
  assert.doesNotMatch(serialized, /prompt|command|environment|secret/i);
  assert.deepEqual(Object.keys(active).sort(), [
    "attempt",
    "controller",
    "invocationId",
    "leaseId",
    "repoRoot",
    "runId",
    "startedAt",
    "state",
    "taskId",
    "updatedAt",
    "version",
    "worker",
    "workspace",
  ]);

  const outcome = cleanupOutcome("child-close", {
    pid: workerIdentity.pid,
    identity: workerIdentity,
  });
  await handle.update(outcome);
  // Repeated updates are idempotent and never duplicate lifecycle evidence.
  await handle.update(outcome);
  const released = readLeaseFile(handle.path);
  assert.ok(released);
  assert.equal(released.state, "released");
  assert.equal(released.cleanupReason, "child-close");
  assert.equal(released.worker.pid, active.worker.pid);
  assert.equal(released.worker.pgid, active.worker.pgid);
  assert.equal(
    released.worker.osStartIdentity,
    active.worker.osStartIdentity,
  );
  assert.equal(released.startedAt, active.startedAt);
  assert.equal(released.cleanup?.processTreeState, "terminated");
  assert.equal(workerLeasesDir(repo), join(repo, ".cliyard", "worker-leases"));
});

test("timeout and cancel cleanup reasons are persisted on the same lease", async () => {
  const repo = tempDir("reasons");
  for (const reason of ["timeout", "cancel"] as const) {
    const workerIdentity = identity(51_000 + (reason === "timeout" ? 1 : 2));
    const { managed } = fakeManaged({
      pid: workerIdentity.pid,
      identity: workerIdentity,
    });
    const attach = createWorkerLeaseAttacher({
      repoRoot: repo,
      runId: "run-reasons",
      controller: {
        pid: 42_000,
        host: "host-a",
        identity: identity(42_000),
      },
    });
    const handle = await attach(attachInput(managed, reason));
    const outcome = await managed.cleanup(reason);
    await handle.update(outcome);
    const lease = readLeaseFile(handle.path);
    assert.ok(lease);
    assert.equal(lease.state, "released");
    assert.equal(lease.cleanupReason, reason);
    assert.equal(lease.worker.osStartIdentity, workerIdentity.startedAt);
  }
});

test("a spawn-error cleanup reason is persisted on the lease", async () => {
  const repo = tempDir("spawn-error");
  const { managed } = fakeManaged({
    outcome: cleanupOutcome("spawn-error", {
      captureSource: "none",
      cleanupState: "clean",
    }),
  });
  const attach = createWorkerLeaseAttacher({
    repoRoot: repo,
    runId: "run-spawn-error",
    controller: {
      pid: 43_500,
      host: "host-a",
      identity: identity(43_500),
    },
  });
  const handle = await attach(attachInput(managed, "spawn-error"));
  await handle.update(await managed.cleanup("spawn-error"));
  const lease = readLeaseFile(handle.path);
  assert.equal(lease?.state, "unknown");
  assert.equal(lease?.cleanupReason, "spawn-error");
});

test("a short-lived worker keeps an unknown lease instead of inventing identity", async () => {
  const repo = tempDir("unknown");
  const { managed } = fakeManaged({
    pid: 52_000,
    outcome: cleanupOutcome("child-close", {
      pid: 52_000,
      captureSource: "none",
      cleanupState: "clean",
    }),
  });
  const attach = createWorkerLeaseAttacher({
    repoRoot: repo,
    runId: "run-unknown",
    controller: {
      pid: 43_000,
      host: "host-a",
      identity: identity(43_000),
    },
  });
  const handle = await attach(attachInput(managed, "short"));
  const provisional = readLeaseFile(handle.path);
  assert.equal(provisional?.state, "unknown");
  assert.equal(provisional?.worker.osStartIdentity, undefined);
  await handle.update(await managed.cleanup("child-close"));
  const final = readLeaseFile(handle.path);
  assert.equal(final?.state, "unknown");
  assert.equal(final?.worker.osStartIdentity, undefined);
});

test("a lease write failure stops the managed worker and rejects", async () => {
  const repo = tempDir("write-failure");
  // A regular file where the store directory belongs makes mkdir fail.
  writeFileSync(join(repo, ".cliyard"), "not a directory\n");
  const workerIdentity = identity(53_000);
  const { managed, cleanupReasons } = fakeManaged({
    pid: workerIdentity.pid,
    identity: workerIdentity,
  });
  const attach = createWorkerLeaseAttacher({
    repoRoot: repo,
    runId: "run-write-failure",
    controller: {
      pid: 44_000,
      host: "host-a",
      identity: identity(44_000),
    },
  });
  await assert.rejects(attach(attachInput(managed, "failed")), /worker lease/i);
  assert.deepEqual(cleanupReasons, ["spawn-error"]);
});

test("both adapters persist and release a lease for a real worker invocation", async () => {
  const repo = initRepo();
  try {
    const contract = contractFor(repo);
    for (const kind of ["claude", "codex"] as const) {
      const binary = join(repo, `fake-${kind}`);
      writeFileSync(binary, "#!/bin/sh\nsleep 0.2\nexit 0\n");
      chmodSync(binary, 0o755);
      const worker =
        kind === "claude"
          ? createClaudeAdapter({ binary, cwd: repo, model: "fixture" })
          : createCodexAdapter({ binary, cwd: repo, model: "fixture" });
      const attacher = createWorkerLeaseAttacher({
        repoRoot: repo,
        runId: `run-adapter-${kind}`,
        controller: {
          pid: 45_000,
          host: realInspector.host,
          identity: identity(45_000),
        },
      });
      const { sessionId } = await worker.start({
        contract,
        attempt: 0,
        onWorkerLease: attacher,
      });
      const result = await worker.collect(sessionId);
      assert.equal(result.exitCode, 0, `${kind} fixture exits cleanly`);
      const read = readWorkerLeases(repo, { runId: `run-adapter-${kind}` });
      assert.equal(read.leases.length, 1, `${kind} wrote one invocation lease`);
      const lease = read.leases[0]!;
      assert.equal(lease.state, "released");
      assert.equal(lease.cleanupReason, "child-close");
      assert.equal(lease.worker.pid, lease.worker.pgid);
      assert.ok(lease.worker.osStartIdentity, `${kind} captured exact identity`);
      await worker.cancel(sessionId);
    }
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

posixTest("adapter timeout updates the lease and leaves no worker group", async () => {
  const repo = initRepo();
  try {
    const contract = contractFor(repo);
    const binary = join(repo, "fake-timeout");
    writeFileSync(binary, "#!/bin/sh\nsleep 5\nexit 0\n");
    chmodSync(binary, 0o755);
    const worker = createCodexAdapter({
      binary,
      cwd: repo,
      model: "fixture",
      timeoutMs: 250,
    });
    const attacher = createWorkerLeaseAttacher({
      repoRoot: repo,
      runId: "run-adapter-timeout",
      controller: {
        pid: 46_000,
        host: realInspector.host,
        identity: identity(46_000),
      },
    });
    const { sessionId } = await worker.start({
      contract,
      attempt: 0,
      onWorkerLease: attacher,
    });
    const result = await worker.collect(sessionId);
    assert.equal(result.exitCode, 124);
    const read = readWorkerLeases(repo, { runId: "run-adapter-timeout" });
    assert.equal(read.leases.length, 1);
    const lease = read.leases[0]!;
    assert.equal(lease.state, "released");
    assert.equal(lease.cleanupReason, "timeout");
    assert.ok(lease.worker.pid);
    await waitFor(
      () => !realInspector.isAlive(lease.worker.pid),
      "timed-out worker death",
    );
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

posixTest("adapter cancel updates the lease with cancel cleanup", async () => {
  const repo = initRepo();
  try {
    const contract = contractFor(repo);
    const binary = join(repo, "fake-cancel");
    writeFileSync(binary, "#!/bin/sh\nsleep 5\nexit 0\n");
    chmodSync(binary, 0o755);
    const worker = createCodexAdapter({ binary, cwd: repo, model: "fixture" });
    const attacher = createWorkerLeaseAttacher({
      repoRoot: repo,
      runId: "run-adapter-cancel",
      controller: {
        pid: 47_000,
        host: realInspector.host,
        identity: identity(47_000),
      },
    });
    const { sessionId } = await worker.start({
      contract,
      attempt: 0,
      onWorkerLease: attacher,
    });
    const activePath = () => {
      const read = readWorkerLeases(repo, { runId: "run-adapter-cancel" });
      return read.leases[0]?.worker.pid
        ? workerLeasePath(
            repo,
            "run-adapter-cancel",
            "worker-lease",
            read.leases[0]!.leaseId,
          )
        : undefined;
    };
    await waitFor(() => activePath() !== undefined, "active lease");
    await worker.cancel(sessionId);
    await waitFor(() => {
      const path = activePath();
      return path !== undefined && readLeaseFile(path)?.cleanupReason === "cancel";
    }, "cancel lease update");
    const lease = readLeaseFile(activePath()!)!;
    assert.equal(lease.state, "released");
    await waitFor(
      () => !realInspector.isAlive(lease.worker.pid),
      "cancelled worker death",
    );
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

posixTest("the codex adapter stops a worker when lease attachment rejects", async () => {
  const repo = initRepo();
  try {
    const contract = contractFor(repo);
    const pidFile = join(repo, "adapter-pids.json");
    const binary = join(repo, "fake-lease-failure");
    writeFileSync(
      binary,
      `#!/bin/sh
"${process.execPath}" -e 'setInterval(() => {}, 1000)' &
echo "[$!]" > "${pidFile}"
sleep 5
exit 0
`,
    );
    chmodSync(binary, 0o755);
    const worker = createCodexAdapter({
      binary,
      cwd: repo,
      model: "fixture",
      timeoutMs: 5_000,
    });
    let attachedPid: number | undefined;
    const { sessionId } = await worker.start({
      contract,
      attempt: 0,
      onWorkerLease: async (input) => {
        attachedPid = input.managed.pid;
        await waitFor(() => existsSync(pidFile), "worker pid file");
        throw new Error("simulated lease persistence failure");
      },
    });
    await waitFor(() => existsSync(pidFile), "worker pid file");
    const [helperPid] = JSON.parse(
      readFileSync(pidFile, "utf8"),
    ) as number[];
    const result = await worker.collect(sessionId);
    assert.equal(result.exitCode, 1);
    assert.equal(result.failure?.stage, "spawn");
    assert.equal(result.failure?.code, "spawn_error");
    await waitFor(
      () =>
        !realInspector.isAlive(attachedPid) &&
        !realInspector.isAlive(helperPid),
      "adapter fail-closed worker death",
    );
    await worker.cancel(sessionId);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Recovery decision matrix
// ---------------------------------------------------------------------------// ---------------------------------------------------------------------------
// Recovery decision matrix
// ---------------------------------------------------------------------------

function baseLease(overrides: Partial<WorkerLease> = {}): WorkerLease {
  const leaseId = overrides.leaseId ?? `lease-${++seq}`;
  const workerIdentity = identity(61_000);
  return {
    version: 1,
    leaseId,
    repoRoot: "/tmp/repo",
    runId: "run-recovery",
    taskId: "task-a",
    attempt: 0,
    invocationId: `invocation-${seq}`,
    controller: {
      pid: 60_000,
      host: "host-a",
      identity: identity(60_000),
    },
    worker: {
      pid: workerIdentity.pid,
      pgid: workerIdentity.pgid,
      osStartIdentity: workerIdentity.startedAt,
      captureMode: "posix-group",
    },
    workspace: "/tmp/workspace",
    startedAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    state: "active",
    ...overrides,
  };
}

function writeLease(repo: string, lease: WorkerLease): string {
  const path = workerLeasePath(
    repo,
    lease.runId,
    lease.taskId,
    lease.leaseId,
  );
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(
    path,
    JSON.stringify({ ...lease, repoRoot: resolve(repo) }, null, 2) + "\n",
    "utf8",
  );
  return path;
}

async function recoverWith(
  repo: string,
  fake: FakeInspector,
  options: { ignoreTerm?: boolean; runId?: string } = {},
) {
  if (!fake.isAlive(process.pid)) fake.add(identity(process.pid));
  const calls: Array<{ pgid: number; signal: NodeJS.Signals }> = [];
  const report = await recoverWorkerLeases({
    repoRoot: repo,
    ...(options.runId ? { runId: options.runId } : {}),
    inspector: fake,
    termGraceMs: 50,
    killGraceMs: 50,
    pollMs: 5,
    killGroup: (pgid, signal) => {
      calls.push({ pgid, signal });
      if (!options.ignoreTerm || signal === "SIGKILL") {
        for (const member of [...fake.identities.values()]) {
          if (member.pgid === pgid) fake.remove(member.pid);
        }
      }
    },
  });
  return { report, calls };
}

test("recovery skips a live matching controller and preserves the lease", async () => {
  const repo = tempDir("recover-live");
  const fake = new FakeInspector();
  const lease = baseLease();
  fake.add(lease.controller.identity);
  fake.add(identity(61_000));
  const path = writeLease(repo, lease);
  const before = readFileSync(path, "utf8");
  const { report, calls } = await recoverWith(repo, fake);
  assert.equal(report.skipped, 1);
  assert.equal(report.entries[0]?.action, "live-owner");
  assert.equal(calls.length, 0);
  assert.equal(readFileSync(path, "utf8"), before);
});

test("recovery skips a foreign-host controller without inspection", async () => {
  const repo = tempDir("recover-foreign");
  const fake = new FakeInspector();
  const lease = baseLease({
    controller: {
      pid: 60_001,
      host: "other-host",
      identity: identity(60_001),
    },
  });
  fake.add(identity(61_000));
  const path = writeLease(repo, lease);
  const before = readFileSync(path, "utf8");
  const { report, calls } = await recoverWith(repo, fake);
  assert.equal(report.skipped, 1);
  assert.equal(report.entries[0]?.action, "foreign-host");
  assert.equal(report.entries[0]?.controllerState, "foreign-host");
  assert.equal(calls.length, 0);
  assert.equal(readFileSync(path, "utf8"), before);
});

test("recovery preserves processes on a mismatched or missing worker identity", async () => {
  const repo = tempDir("recover-mismatch");
  const fake = new FakeInspector();
  const mismatched = baseLease();
  fake.add(identity(61_000, "Tue Jan  2 00:00:00 2024"));
  const mismatchedPath = writeLease(repo, mismatched);
  const missing = baseLease({
    leaseId: "lease-missing-identity",
    taskId: "task-b",
    worker: { captureMode: "posix-group" },
  });
  const missingPath = writeLease(repo, missing);
  const { report, calls } = await recoverWith(repo, fake);
  assert.equal(calls.length, 0);
  assert.equal(report.needsHuman, 2);
  assert.equal(report.recovered, 0);
  assert.equal(report.resumeNeeded.length, 0);
  for (const entry of report.entries) {
    assert.equal(entry.outcome, "needs_human");
    assert.equal(entry.action, "preserved");
    assert.equal(entry.resumeNeeded, false);
  }
  assert.equal(readLeaseFile(mismatchedPath)?.state, "active");
  assert.equal(readLeaseFile(missingPath)?.state, "active");
  // Recovery evidence is appended even when the process tree is preserved.
  assert.equal(readLeaseFile(mismatchedPath)?.recovery?.length, 1);
  assert.equal(readLeaseFile(mismatchedPath)?.recovery?.[0]?.outcome, "needs_human");
});

test("recovery escalates TERM to KILL only inside the verified group", async () => {
  const repo = tempDir("recover-kill");
  const fake = new FakeInspector();
  const lease = baseLease();
  fake.add(identity(61_000));
  const path = writeLease(repo, lease);
  const { report, calls } = await recoverWith(repo, fake, { ignoreTerm: true });
  assert.equal(report.recovered, 1);
  assert.equal(report.entries[0]?.action, "terminated");
  assert.equal(report.entries[0]?.workerState, "terminated");
  assert.deepEqual(
    calls.map((call) => call.signal),
    ["SIGTERM", "SIGKILL"],
  );
  assert.ok(calls.every((call) => call.pgid === 61_000));
  const updated = readLeaseFile(path);
  assert.equal(updated?.state, "released");
  assert.equal(updated?.cleanupReason, "recovery");
  assert.equal(updated?.recovery?.[0]?.outcome, "recovered");
  assert.equal(report.resumeNeeded.length, 1);
  assert.equal(report.resumeNeeded[0]?.taskId, "task-a");
});

test("recovery is idempotent after a lease is released", async () => {
  const repo = tempDir("recover-idempotent");
  const fake = new FakeInspector();
  const lease = baseLease({ state: "released", cleanupReason: "recovery" });
  const path = writeLease(repo, lease);
  const { report, calls } = await recoverWith(repo, fake);
  assert.equal(report.skipped, 1);
  assert.equal(report.entries[0]?.reason, "lease is already released");
  assert.equal(calls.length, 0);
  assert.equal(readLeaseFile(path)?.state, "released");
});

// ---------------------------------------------------------------------------
// Malformed records and status projection
// ---------------------------------------------------------------------------

test("malformed leases are degraded evidence and recovery needs a human", async () => {
  const repo = tempDir("malformed");
  const fake = new FakeInspector();
  const valid = baseLease({
    leaseId: "lease-valid",
    taskId: "task-valid",
    state: "released",
    cleanupReason: "child-close",
  });
  writeLease(repo, valid);
  const malformedDir = join(
    workerLeasesDir(repo),
    "run-recovery",
    "task-malformed",
  );
  mkdirSync(malformedDir, { recursive: true });
  writeFileSync(join(malformedDir, "broken.json"), "{not json", "utf8");
  writeFileSync(
    join(malformedDir, "wrong-path.json"),
    JSON.stringify({ ...valid, leaseId: "different" }),
    "utf8",
  );

  const read = readWorkerLeases(repo);
  assert.equal(read.leases.length, 1);
  assert.equal(read.malformed.length, 2);

  const status = await buildWorkerLeaseStatus(
    repo,
    "run-recovery",
    [
      { taskId: "task-valid", expectsLease: true },
      { taskId: "task-never-started", expectsLease: true },
      { taskId: "task-optional", expectsLease: false },
    ],
    { inspector: fake },
  );
  assert.equal(status.counts.total, 1);
  assert.equal(status.counts.malformed, 2);
  assert.equal(status.degraded, true);
  assert.equal(
    status.tasks.find((task) => task.taskId === "task-never-started")?.missing,
    true,
  );
  assert.equal(
    status.tasks.find((task) => task.taskId === "task-optional")?.missing,
    false,
  );

  const { report } = await recoverWith(repo, fake);
  assert.equal(report.needsHuman, 2);
  assert.equal(report.recovered, 0);
  assert.ok(
    report.entries
      .filter((entry) => entry.outcome === "needs_human")
      .every((entry) => entry.action === "invalid"),
  );
  assert.equal(readWorkerLeases(repo).malformed.length, 2);
});

test("status projects counts, latest lease per task and controller state", async () => {
  const repo = tempDir("status");
  const fake = new FakeInspector();
  const older = baseLease({
    leaseId: "lease-old",
    taskId: "task-a",
    state: "released",
    cleanupReason: "child-close",
    startedAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:01.000Z",
  });
  const latest = baseLease({
    leaseId: "lease-new",
    taskId: "task-a",
    state: "active",
    startedAt: "2026-01-01T00:00:02.000Z",
    updatedAt: "2026-01-01T00:00:02.000Z",
  });
  const failed = baseLease({
    leaseId: "lease-failed",
    taskId: "task-b",
    state: "cleanup-failed",
    cleanupReason: "timeout",
    controller: {
      pid: 60_010,
      host: "host-a",
      identity: identity(60_010),
    },
  });
  const unknown = baseLease({
    leaseId: "lease-unknown",
    taskId: "task-c",
    state: "unknown",
    worker: { captureMode: "posix-group" },
    controller: {
      pid: 60_011,
      host: "host-a",
      identity: identity(60_011),
    },
  });
  const foreign = baseLease({
    leaseId: "lease-foreign",
    taskId: "task-d",
    controller: {
      pid: 60_002,
      host: "other-host",
      identity: identity(60_002),
    },
  });
  for (const lease of [older, latest, failed, unknown, foreign]) {
    writeLease(repo, lease);
  }
  // Controller for task-a is alive; task-b and task-c are dead here.
  fake.add(latest.controller.identity);
  const status = await buildWorkerLeaseStatus(
    repo,
    "run-recovery",
    [
      { taskId: "task-a", expectsLease: true },
      { taskId: "task-b", expectsLease: true },
      { taskId: "task-c", expectsLease: true },
      { taskId: "task-d", expectsLease: true },
    ],
    { inspector: fake },
  );
  assert.deepEqual(status.counts, {
    active: 2,
    released: 1,
    cleanupFailed: 1,
    unknown: 1,
    malformed: 0,
    total: 5,
  });
  const taskA = status.tasks.find((task) => task.taskId === "task-a");
  assert.equal(taskA?.latest?.leaseId, "lease-new");
  assert.equal(taskA?.latest?.controller.state, "alive");
  const taskB = status.tasks.find((task) => task.taskId === "task-b");
  assert.equal(taskB?.latest?.state, "cleanup-failed");
  assert.equal(taskB?.latest?.controller.state, "dead");
  assert.equal(taskB?.latest?.cleanupReason, "timeout");
  const taskD = status.tasks.find((task) => task.taskId === "task-d");
  assert.equal(taskD?.latest?.controller.state, "foreign-host");
  assert.equal(status.degraded, false);
});

test("supervisor status JSON exposes the bounded worker lease projection", async () => {
  const repo = tempDir("cli-status");
  const runId = "run-status";
  writeFileSync(join(repo, "contracts.json"), "{}\n", "utf8");
  const manifest = createRunManifest(repo, {
    runId,
    planId: "plan-status",
    contractsPath: "contracts.json",
    baseCommit: "a".repeat(40),
    integrationBranch: "cliyard/integration/status",
    tasks: [
      {
        taskId: "task-a",
        status: "running",
        accepted: false,
        attemptStartedAt: "2026-01-01T00:00:00.000Z",
      },
      {
        taskId: "task-b",
        status: "running",
        accepted: false,
        attemptStartedAt: "2026-01-01T00:00:00.000Z",
      },
      { taskId: "task-accepted", status: "accepted", accepted: true },
    ],
    activate: false,
  });
  writeLease(
    repo,
    baseLease({
      runId,
      taskId: "task-a",
      leaseId: "lease-status",
      repoRoot: repo,
    }),
  );
  const lines: string[] = [];
  const code = await runSupervisorCli(
    ["status", "--repo", repo, "--run", runId, "--json"],
    { log: (line) => lines.push(line) },
  );
  assert.equal(code, 0);
  const status = JSON.parse(lines.join("\n")) as {
    runId: string;
    workerLeases: {
      counts: Record<string, number>;
      tasks: Array<{
        taskId: string;
        missing: boolean;
        latest: { leaseId: string; controller: { state: string } } | null;
      }>;
      degraded: boolean;
    };
  };
  assert.equal(status.runId, manifest.runId);
  assert.equal(status.workerLeases.counts.total, 1);
  assert.equal(status.workerLeases.counts.active, 1);
  assert.equal(status.workerLeases.degraded, true);
  assert.equal(
    status.workerLeases.tasks.find((task) => task.taskId === "task-a")?.latest
      ?.leaseId,
    "lease-status",
  );
  assert.equal(
    status.workerLeases.tasks.find((task) => task.taskId === "task-b")?.missing,
    true,
  );
  assert.equal(
    status.workerLeases.tasks.find(
      (task) => task.taskId === "task-accepted",
    )?.missing,
    false,
  );
});

// ---------------------------------------------------------------------------
// Real POSIX controller-death fixture
// ---------------------------------------------------------------------------

posixTest(
  "a new recover-workers invocation kills only a SIGKILLed controller's exact worker group",
  async () => {
    const repo = tempDir("real-recovery");
    const readyPath = join(repo, "ready.json");
    const helperFixture = join(repo, "helper.mjs");
    writeFileSync(helperFixture, "setInterval(() => {}, 1000);\n", "utf8");
    const controllerScript = join(repo, "controller.mts");
    const workerLeaseModule = pathToFileURL(
      fileURLToPath(new URL("../src/agents/worker-lease.ts", import.meta.url)),
    ).href;
    const processTreeModule = pathToFileURL(
      fileURLToPath(new URL("../src/agents/process-tree.ts", import.meta.url)),
    ).href;
    writeFileSync(
      controllerScript,
      `import { writeFileSync } from "node:fs";
import { WorkerProcessTreeManager } from ${JSON.stringify(processTreeModule)};
import { createWorkerLeaseAttacher } from ${JSON.stringify(workerLeaseModule)};

const repo = process.argv[2];
const readyPath = process.argv[3];
const helperFixture = process.argv[4];
const tree = new WorkerProcessTreeManager();
const worker = tree.spawn(
  process.execPath,
  [helperFixture],
  { stdio: ["ignore", "ignore", "ignore"] },
);
const attach = createWorkerLeaseAttacher({
  repoRoot: repo,
  runId: "run-real-recovery",
});
const handle = await attach({
  taskId: "task-real",
  attempt: 0,
  invocationId: "invocation-real",
  workspace: repo,
  managed: worker,
});
writeFileSync(
  readyPath,
  JSON.stringify({ controllerPid: process.pid, workerPid: worker.pid, leasePath: handle.path }),
);
setInterval(() => {}, 1000);
`,
      "utf8",
    );

    let controller: ChildProcess | undefined;
    try {
      controller = spawn(
        process.execPath,
        ["--import", "tsx", controllerScript, repo, readyPath, helperFixture],
        {
          cwd: ROOT,
          env: process.env,
          stdio: ["ignore", "ignore", "pipe"],
        },
      );
      let stderr = "";
      controller.stderr?.on("data", (chunk) => {
        stderr = (stderr + String(chunk)).slice(-4_000);
      });
      await waitFor(() => existsSync(readyPath), `controller ready (${stderr})`);
      const ready = JSON.parse(readFileSync(readyPath, "utf8")) as {
        controllerPid: number;
        workerPid: number;
        leasePath: string;
      };
      liveFixturePids.add(ready.workerPid);
      assert.ok(realInspector.isAlive(ready.workerPid));
      const leaseBefore = readLeaseFile(ready.leasePath);
      assert.equal(leaseBefore?.state, "active");
      assert.equal(leaseBefore?.worker.pid, ready.workerPid);
      assert.ok(leaseBefore?.worker.osStartIdentity);

      // Kill the controller without any cleanup. The detached helper remains.
      process.kill(ready.controllerPid, "SIGKILL");
      await waitFor(
        () => !realInspector.isAlive(ready.controllerPid),
        "controller death",
      );
      assert.ok(realInspector.isAlive(ready.workerPid));
      assert.equal(readLeaseFile(ready.leasePath)?.state, "active");

      const cli = spawnSync(
        process.execPath,
        [
          "--import",
          "tsx",
          CLI_PATH,
          "supervisor",
          "recover-workers",
          "--repo",
          repo,
          "--run",
          "run-real-recovery",
          "--json",
        ],
        { cwd: ROOT, encoding: "utf8", timeout: 20_000 },
      );
      assert.equal(cli.status, 0, cli.stderr);
      const report = JSON.parse(cli.stdout) as {
        recovered: number;
        needsHuman: number;
        resumeNeeded: Array<{ taskId: string }>;
        entries: Array<{
          outcome: string;
          action: string;
          workerState: string;
        }>;
      };
      assert.equal(report.recovered, 1);
      assert.equal(report.needsHuman, 0);
      assert.equal(report.resumeNeeded[0]?.taskId, "task-real");
      assert.equal(report.entries[0]?.action, "terminated");
      assert.equal(report.entries[0]?.workerState, "terminated");
      await waitFor(
        () => !realInspector.isAlive(ready.workerPid),
        "recovered worker group death",
      );
      const leaseAfter = readLeaseFile(ready.leasePath);
      assert.equal(leaseAfter?.state, "released");
      assert.equal(leaseAfter?.cleanupReason, "recovery");
      assert.equal(leaseAfter?.recovery?.[0]?.action, "terminated");
      liveFixturePids.delete(ready.workerPid);
      // No stdout was reattached and no manifest was created or rewritten.
      assert.equal(existsSync(join(repo, ".cliyard", "runs")), false);
    } finally {
      if (controller && controller.exitCode === null) {
        try {
          controller.kill("SIGKILL");
        } catch {
          /* already gone */
        }
      }
    }
  },
);

// The fixture parser itself must fail closed rather than accept a guessed or
// partially valid record.
test("strict parser rejects missing or fabricated lease identity", () => {
  const valid = baseLease({ repoRoot: "/tmp/repo" });
  assert.ok(parseWorkerLease(valid));
  const bad: unknown[] = [
    { ...valid, version: 2 },
    { ...valid, leaseId: "../escape" },
    { ...valid, controller: { ...valid.controller, identity: undefined } },
    { ...valid, state: "running" },
    { ...valid, cleanupReason: "made-up" },
    Object.fromEntries(
      Object.entries(valid).filter(([key]) => key !== "invocationId"),
    ),
  ];
  for (const value of bad) {
    assert.equal(parseWorkerLease(value), undefined);
  }
});

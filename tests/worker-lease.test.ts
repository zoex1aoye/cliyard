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
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import {
  ProcessInspector,
  type ProcessGroupMember,
  type ProcessTableEntry,
} from "../src/runtime/process.js";
import type { RuntimeProcessIdentity } from "../src/runtime/types.js";
import { createClaudeAdapter } from "../src/agents/claude.js";
import { createCodexAdapter } from "../src/agents/codex.js";
import type {
  ManagedWorkerProcess,
  WorkerNestedProcesses,
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
  readonly parents = new Map<number, number>();

  add(identity: RuntimeProcessIdentity): void {
    this.identities.set(identity.pid, { ...identity });
  }

  remove(pid: number): void {
    this.identities.delete(pid);
    this.parents.delete(pid);
  }

  setParent(pid: number, ppid: number): void {
    this.parents.set(pid, ppid);
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

  async snapshotProcessTable(): Promise<ProcessTableEntry[]> {
    return [...this.identities.values()]
      .map((identity) => ({
        pid: identity.pid,
        ppid: this.parents.get(identity.pid) ?? 0,
        pgid: identity.pgid,
        startedAt: identity.startedAt,
      }))
      .sort((left, right) => left.pid - right.pid);
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
  observable?: boolean;
}): {
  managed: ManagedWorkerProcess;
  cleanupReasons: Array<WorkerProcessCleanupOutcome["record"]["cleanupReason"]>;
  emitNested(snapshot: WorkerNestedProcesses): void;
} {
  const cleanupReasons: Array<
    WorkerProcessCleanupOutcome["record"]["cleanupReason"]
  > = [];
  const nestedListeners = new Set<
    (snapshot: WorkerNestedProcesses) => void | Promise<void>
  >();
  let currentNested: WorkerNestedProcesses | undefined;
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
  if (options.observable) {
    managed.observeExternalDescendants = (listener) => {
      nestedListeners.add(listener);
      // Mirror the real observer: async listener failures are surfaced through
      // the lease's own persistence-health path, never as unhandled rejections.
      if (currentNested) {
        void Promise.resolve(listener(structuredClone(currentNested))).catch(
          () => {},
        );
      }
      return () => {
        nestedListeners.delete(listener);
      };
    };
  }
  return {
    managed,
    cleanupReasons,
    emitNested(snapshot) {
      currentNested = structuredClone(snapshot);
      for (const listener of [...nestedListeners]) {
        void Promise.resolve(listener(structuredClone(snapshot))).catch(
          () => {},
        );
      }
    },
  };
}

function nestedSnapshot(
  identities: RuntimeProcessIdentity[],
  overrides: Partial<WorkerNestedProcesses> = {},
): WorkerNestedProcesses {
  return {
    version: 1,
    host: "host-a",
    observedCount: identities.length,
    truncated: false,
    lastObservedAt: "2026-01-01T00:00:02.000Z",
    identities: identities.map((value) => ({ ...value })),
    ...overrides,
  };
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
  options: {
    ignoreTerm?: boolean;
    runId?: string;
    pidIgnoreTerm?: boolean;
  } = {},
) {
  if (!fake.isAlive(process.pid)) fake.add(identity(process.pid));
  const calls: Array<{ pgid: number; signal: NodeJS.Signals }> = [];
  const pidCalls: Array<{ pid: number; signal: NodeJS.Signals }> = [];
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
    killPid: (pid, signal) => {
      pidCalls.push({ pid, signal });
      if (!options.pidIgnoreTerm || signal === "SIGKILL") fake.remove(pid);
    },
  });
  return { report, calls, pidCalls };
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

posixTest(
  "recover-workers recovers a controller-death fixture's 512-member nested group",
  async () => {
    const repo = tempDir("real-nested-recovery");
    const readyPath = join(repo, "ready.json");
    const workerReady = join(repo, "worker-ready.json");
    const helperFixture = join(repo, "nested-helper.mjs");
    writeFileSync(helperFixture, "setInterval(() => {}, 1000);\n", "utf8");
    // A real detached nested group: a leader plus 512 members in its process
    // group. The member count intentionally exceeds the old 256 related-pid
    // sampling bound.
    writeFileSync(
      helperFixture,
      `import { spawn } from "node:child_process";
for (let index = 0; index < 512; index += 1) {
  spawn("/bin/sleep", ["600"], { stdio: "ignore" });
}
setInterval(() => {}, 1000);
`,
      "utf8",
    );
    const workerScript = join(repo, "nested-worker.mjs");
    writeFileSync(
      workerScript,
      `import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
const helper = spawn(process.execPath, [process.argv[2]], {
  detached: true,
  stdio: "ignore",
});
helper.unref();
writeFileSync(process.argv[3], JSON.stringify({ helperPid: helper.pid }));
setInterval(() => {}, 1000);
`,
      "utf8",
    );
    const controllerScript = join(repo, "nested-controller.mts");
    const workerLeaseModule = pathToFileURL(
      fileURLToPath(new URL("../src/agents/worker-lease.ts", import.meta.url)),
    ).href;
    const processTreeModule = pathToFileURL(
      fileURLToPath(new URL("../src/agents/process-tree.ts", import.meta.url)),
    ).href;
    writeFileSync(
      controllerScript,
      `import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { WorkerProcessTreeManager } from ${JSON.stringify(processTreeModule)};
import { createWorkerLeaseAttacher, readLeaseFile } from ${JSON.stringify(workerLeaseModule)};

const [repo, workerScript, helperFixture, workerReady, readyPath] =
  process.argv.slice(2);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const tree = new WorkerProcessTreeManager();
const worker = tree.spawn(
  process.execPath,
  [workerScript, helperFixture, workerReady],
  { stdio: ["ignore", "ignore", "ignore"] },
);
const attach = createWorkerLeaseAttacher({
  repoRoot: repo,
  runId: "run-real-nested",
});
const handle = await attach({
  taskId: "task-real-nested",
  attempt: 0,
  invocationId: "invocation-real-nested",
  workspace: repo,
  managed: worker,
});
while (!existsSync(workerReady)) await sleep(20);
const { helperPid } = JSON.parse(readFileSync(workerReady, "utf8"));
const deadline = Date.now() + 15000;
let observedCount = 0;
while (Date.now() < deadline) {
  const lease = readLeaseFile(handle.path);
  const group = lease?.nestedProcesses?.groups?.find(
    (entry) => entry.pgid === helperPid,
  );
  if (group) {
    observedCount = group.observedMemberCount;
    if (observedCount >= 513) break;
  }
  await sleep(50);
}
if (observedCount < 513) {
  throw new Error(
    \`nested group evidence was not complete: \${observedCount} members\`,
  );
}
writeFileSync(
  readyPath,
  JSON.stringify({
    controllerPid: process.pid,
    workerPid: worker.pid,
    helperPid,
    observedCount,
    leasePath: handle.path,
  }),
);
setInterval(() => {}, 1000);
`,
      "utf8",
    );

    let controller: ChildProcess | undefined;
    try {
      controller = spawn(
        process.execPath,
        ["--import", "tsx", controllerScript, repo, workerScript, helperFixture, workerReady, readyPath],
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
      await waitFor(
        () => existsSync(readyPath),
        `nested controller ready (${stderr})`,
      );
      const ready = JSON.parse(readFileSync(readyPath, "utf8")) as {
        controllerPid: number;
        workerPid: number;
        helperPid: number;
        observedCount: number;
        leasePath: string;
      };
      liveFixturePids.add(ready.workerPid);
      liveFixturePids.add(ready.helperPid);
      assert.ok(realInspector.isAlive(ready.workerPid));
      assert.ok(realInspector.isAlive(ready.helperPid));
      assert.ok(ready.observedCount >= 513);
      const leaseBefore = readLeaseFile(ready.leasePath);
      assert.equal(leaseBefore?.state, "active");
      assert.equal(leaseBefore?.nestedProcesses?.truncated, false);
      const groupBefore = leaseBefore?.nestedProcesses?.groups?.find(
        (entry) => entry.pgid === ready.helperPid,
      );
      assert.ok(
        groupBefore,
        "nested group evidence is durable before controller death",
      );
      assert.equal(groupBefore.leader.pid, ready.helperPid);
      assert.equal(groupBefore.leader.pgid, ready.helperPid);
      assert.ok(groupBefore.observedMemberCount >= 513);
      assert.ok(
        (await realInspector.listGroupMembers(ready.helperPid)).length >= 513,
        "the real nested group has at least 512 members",
      );

      // Kill the controller and then the top-level leader. Only the detached
      // nested group remains; the lease is the only durable evidence for it.
      process.kill(ready.controllerPid, "SIGKILL");
      await waitFor(
        () => !realInspector.isAlive(ready.controllerPid),
        "controller death",
      );
      process.kill(ready.workerPid, "SIGKILL");
      await waitFor(
        () => !realInspector.isAlive(ready.workerPid),
        "worker leader death",
      );
      assert.equal(realInspector.isAlive(ready.helperPid), true);
      assert.ok(
        (await realInspector.listGroupMembers(ready.helperPid)).length >= 513,
      );

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
          "run-real-nested",
          "--json",
        ],
        { cwd: ROOT, encoding: "utf8", timeout: 30_000 },
      );
      assert.equal(cli.status, 0, `${cli.stdout}\n${cli.stderr}`);
      const report = JSON.parse(cli.stdout) as {
        recovered: number;
        needsHuman: number;
        entries: Array<{
          outcome: string;
          action: string;
          signals: Array<{
            scope: string;
            pid?: number;
            pgid?: number;
            signal: string;
          }>;
        }>;
      };
      assert.equal(report.recovered, 1);
      assert.equal(report.needsHuman, 0);
      assert.equal(report.entries[0]?.action, "terminated");
      const signals = report.entries[0]?.signals ?? [];
      assert.ok(signals.length > 0);
      assert.ok(
        signals.every(
          (signal) =>
            signal.scope === "nested-process-group" &&
            signal.pgid === ready.helperPid &&
            signal.pid === undefined,
        ),
        "the whole nested group was signalled as one owned unit",
      );
      const groupDeadline = Date.now() + 8_000;
      while (
        (await realInspector.listGroupMembers(ready.helperPid)).length > 0 &&
        Date.now() < groupDeadline
      ) {
        await delay(20);
      }
      assert.deepEqual(
        await realInspector.listGroupMembers(ready.helperPid),
        [],
        "every member of the recovered nested group is gone",
      );
      await waitFor(
        () => !realInspector.isAlive(ready.helperPid),
        "nested group leader death",
      );
      const leaseAfter = readLeaseFile(ready.leasePath);
      assert.equal(leaseAfter?.state, "released");
      assert.equal(leaseAfter?.cleanupReason, "recovery");
      assert.equal(leaseAfter?.recovery?.[0]?.outcome, "recovered");
      assert.ok(
        leaseAfter?.nestedProcesses?.groups?.some(
          (entry) => entry.pgid === ready.helperPid,
        ),
        "refreshed group registry remains durable",
      );
      assert.equal(existsSync(join(repo, ".cliyard", "runs")), false);
      liveFixturePids.delete(ready.workerPid);
      liveFixturePids.delete(ready.helperPid);
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

// ---------------------------------------------------------------------------
// Durable nested evidence: attacher, parsing and status
// ---------------------------------------------------------------------------

test("attacher persists nested evidence atomically and never regresses", async () => {
  const repo = tempDir("nested-attach");
  const workerIdentity = identity(70_000);
  const { managed, emitNested } = fakeManaged({
    pid: workerIdentity.pid,
    identity: workerIdentity,
    observable: true,
  });
  const attach = createWorkerLeaseAttacher({
    repoRoot: repo,
    runId: "run-nested-attach",
    controller: {
      pid: 70_500,
      host: "host-a",
      identity: identity(70_500),
    },
  });
  const handle = await attach(attachInput(managed, "nested"));
  assert.equal(readLeaseFile(handle.path)?.nestedProcesses, undefined);
  assert.equal(statSync(handle.path).mode & 0o777, 0o600);

  const first = identity(70_101);
  emitNested(
    nestedSnapshot([first], { lastObservedAt: "2026-01-01T00:00:02.000Z" }),
  );
  await waitFor(
    () => readLeaseFile(handle.path)?.nestedProcesses !== undefined,
    "durable nested evidence",
  );
  const persisted = readLeaseFile(handle.path)!;
  assert.equal(persisted.state, "active");
  assert.equal(persisted.nestedProcesses?.observedCount, 1);
  assert.equal(persisted.nestedProcesses?.identities[0]?.pid, first.pid);
  assert.equal(persisted.nestedProcesses?.truncated, false);
  assert.equal(statSync(handle.path).mode & 0o777, 0o600);

  // An older observation must never replace newer durable evidence.
  emitNested(
    nestedSnapshot([identity(70_199)], {
      lastObservedAt: "2026-01-01T00:00:01.000Z",
    }),
  );
  await delay(60);
  const afterStale = readLeaseFile(handle.path)!;
  assert.deepEqual(
    afterStale.nestedProcesses?.identities.map((identity) => identity.pid),
    [first.pid],
  );

  // Newer changed snapshots merge monotonically and stay bounded.
  emitNested(
    nestedSnapshot([identity(70_102)], {
      lastObservedAt: "2026-01-01T00:00:03.000Z",
    }),
  );
  await waitFor(
    () =>
      (readLeaseFile(handle.path)?.nestedProcesses?.identities.length ?? 0) ===
      2,
    "merged nested evidence",
  );
  const merged = readLeaseFile(handle.path)!;
  assert.equal(merged.nestedProcesses?.lastObservedAt, "2026-01-01T00:00:03.000Z");
  assert.equal(merged.nestedProcesses?.observedCount, 2);
  assert.equal(statSync(handle.path).mode & 0o777, 0o600);

  await handle.update(
    cleanupOutcome("child-close", {
      pid: workerIdentity.pid,
      identity: workerIdentity,
    }),
  );
  const released = readLeaseFile(handle.path)!;
  assert.equal(released.state, "released");
  assert.equal(released.nestedProcesses?.identities.length, 2);
});

test("attacher persists a snapshot replayed synchronously at subscription", async () => {
  const repo = tempDir("nested-replay");
  const workerIdentity = identity(70_020);
  const helper = identity(70_120);
  const { managed, cleanupReasons, emitNested } = fakeManaged({
    pid: workerIdentity.pid,
    identity: workerIdentity,
    observable: true,
  });
  // The observer retains its latest bounded snapshot and replays it during
  // subscribe. The attacher must accept that replay instead of failing closed.
  emitNested(nestedSnapshot([helper]));
  const attach = createWorkerLeaseAttacher({
    repoRoot: repo,
    runId: "run-nested-replay",
    controller: {
      pid: 70_520,
      host: "host-a",
      identity: identity(70_520),
    },
  });
  const handle = await attach(attachInput(managed, "nested-replay"));
  const persisted = readLeaseFile(handle.path)!;
  assert.equal(persisted.state, "active");
  assert.equal(persisted.nestedProcesses?.observedCount, 1);
  assert.equal(persisted.nestedProcesses?.identities[0]?.pid, helper.pid);
  assert.equal(handle.current.nestedProcesses?.identities[0]?.pid, helper.pid);
  assert.deepEqual(cleanupReasons, []);
  await handle.update(
    cleanupOutcome("child-close", {
      pid: workerIdentity.pid,
      identity: workerIdentity,
    }),
  );
  assert.equal(readLeaseFile(handle.path)?.state, "released");
});

test("a nested-evidence write failure stops the worker and rejects the update", async () => {
  const repo = tempDir("nested-write-failure");
  const workerIdentity = identity(70_010);
  const { managed, cleanupReasons, emitNested } = fakeManaged({
    pid: workerIdentity.pid,
    identity: workerIdentity,
    observable: true,
  });
  const attach = createWorkerLeaseAttacher({
    repoRoot: repo,
    runId: "run-nested-write-failure",
    controller: {
      pid: 70_510,
      host: "host-a",
      identity: identity(70_510),
    },
  });
  const handle = await attach(attachInput(managed, "nested-write-failure"));
  // Removing the lease makes the nested write path fail closed.
  rmSync(handle.path);
  emitNested(nestedSnapshot([identity(70_110)]));
  await waitFor(
    () => cleanupReasons.includes("spawn-error"),
    "fail-closed worker cleanup",
  );
  await assert.rejects(
    handle.update(
      cleanupOutcome("child-close", {
        pid: workerIdentity.pid,
        identity: workerIdentity,
      }),
    ),
    /nested descendant evidence/i,
  );
});

test("a malformed observer snapshot fails closed instead of being persisted", async () => {
  const repo = tempDir("nested-malformed-snapshot");
  const workerIdentity = identity(70_030);
  const { managed, cleanupReasons, emitNested } = fakeManaged({
    pid: workerIdentity.pid,
    identity: workerIdentity,
    observable: true,
  });
  const attach = createWorkerLeaseAttacher({
    repoRoot: repo,
    runId: "run-nested-malformed-snapshot",
    controller: {
      pid: 70_530,
      host: "host-a",
      identity: identity(70_530),
    },
  });
  const handle = await attach(attachInput(managed, "nested-malformed"));
  emitNested(
    nestedSnapshot([identity(70_130)], { lastObservedAt: "not-a-timestamp" }),
  );
  await waitFor(
    () => cleanupReasons.includes("spawn-error"),
    "fail-closed worker cleanup",
  );
  assert.equal(readLeaseFile(handle.path)?.nestedProcesses, undefined);
  await assert.rejects(
    handle.update(
      cleanupOutcome("child-close", {
        pid: workerIdentity.pid,
        identity: workerIdentity,
      }),
    ),
    /nested descendant evidence/i,
  );
});

test("nested lease evidence is all-or-nothing and backward compatible", () => {
  const valid = baseLease({
    nestedProcesses: nestedSnapshot([identity(73_001)]),
  });
  const parsed = parseWorkerLease(valid);
  assert.ok(parsed);
  assert.equal(parsed.nestedProcesses?.identities[0]?.pid, 73_001);
  const legacy = parseWorkerLease(baseLease());
  assert.ok(legacy);
  assert.equal(legacy.nestedProcesses, undefined);

  const base = nestedSnapshot([identity(73_001)]);
  const thirtyThree = Array.from({ length: 33 }, (_, index) =>
    identity(74_000 + index),
  );
  const bad: unknown[] = [
    { ...valid, nestedProcesses: { ...base, version: 2 } },
    {
      ...valid,
      nestedProcesses: {
        version: 1,
        host: "host-a",
        identities: [identity(73_001)],
      },
    },
    { ...valid, nestedProcesses: { ...base, host: "other-host" } },
    { ...valid, nestedProcesses: { ...base, lastObservedAt: "not-a-time" } },
    { ...valid, nestedProcesses: { ...base, observedCount: 2 } },
    {
      ...valid,
      nestedProcesses: {
        ...base,
        observedCount: 2,
        identities: [identity(73_001), identity(73_001)],
      },
    },
    {
      ...valid,
      nestedProcesses: {
        ...base,
        observedCount: 1,
        identities: [identity(73_001), identity(73_002)],
      },
    },
    {
      ...valid,
      nestedProcesses: { ...base, observedCount: 33, identities: thirtyThree },
    },
    {
      ...valid,
      nestedProcesses: {
        ...base,
        identities: [{ pid: 0, pgid: 1, startedAt: "Mon Jan  1 00:00:00 2024" }],
      },
    },
    {
      ...valid,
      nestedProcesses: {
        ...base,
        identities: [{ pid: 1, pgid: 1, startedAt: "Mon Jan  1 00:00:00 2024" }],
      },
    },
  ];
  for (const value of bad) assert.equal(parseWorkerLease(value), undefined);
  // Truncation is explicit, and a truncated count may exceed the identity list.
  const truncated = parseWorkerLease({
    ...valid,
    nestedProcesses: {
      ...base,
      observedCount: 33,
      truncated: true,
      identities: [identity(73_001)],
    },
  });
  assert.ok(truncated);
  assert.equal(truncated.nestedProcesses?.truncated, true);
});

test("nested group evidence round-trips and rejects unsafe group shapes", () => {
  const group = {
    pgid: 75_000,
    leader: identity(75_000),
    observedMemberCount: 512,
    lastObservedAt: "2026-01-01T00:00:02.000Z",
  };
  const snapshot = nestedSnapshot([identity(75_100)], { groups: [group] });
  const lease = baseLease({ nestedProcesses: snapshot });
  const parsed = parseWorkerLease(lease);
  assert.ok(parsed);
  assert.deepEqual(parsed.nestedProcesses?.groups, [group]);
  assert.equal(parsed.nestedProcesses?.identities[0]?.pid, 75_100);
  // Legacy exact-pid-only evidence (no groups field) stays readable.
  assert.ok(
    parseWorkerLease(baseLease({ nestedProcesses: nestedSnapshot([identity(75_101)]) })),
  );

  const malformedGroups: unknown[] = [
    [{ ...group, pgid: 75_001 }],
    [{ ...group, leader: { ...group.leader, pid: 75_002 } }],
    [{ ...group, leader: { ...group.leader, pgid: 75_002 } }],
    [group, group],
    [{ ...group, observedMemberCount: 0 }],
    [{ ...group, observedMemberCount: 100_001 }],
    [{ ...group, lastObservedAt: "not-a-time" }],
    Array.from({ length: 17 }, (_, index) => ({
      ...group,
      pgid: 75_000 + index,
      leader: identity(75_000 + index),
    })),
  ];
  for (const groups of malformedGroups) {
    assert.equal(
      parseWorkerLease({
        ...lease,
        nestedProcesses: { ...snapshot, groups } as WorkerNestedProcesses,
      }),
      undefined,
    );
  }
  // A fallback identity must not duplicate a proven group as an exact pid.
  assert.equal(
    parseWorkerLease({
      ...lease,
      nestedProcesses: {
        ...snapshot,
        identities: [identity(75_000)],
      },
    }),
    undefined,
  );
});

test("status exposes bounded nested registry presence and exact liveness", async () => {
  const repo = tempDir("nested-status");
  const fake = new FakeInspector();
  const live = identity(72_001);
  const reused: RuntimeProcessIdentity = {
    pid: 72_002,
    pgid: 72_002,
    startedAt: "Mon Jan  1 00:00:00 2024",
  };
  const gone = identity(72_003);
  fake.add(live);
  fake.add({
    pid: reused.pid,
    pgid: reused.pgid,
    startedAt: "Tue Jan  2 00:00:00 2024",
  });
  const lease = baseLease({
    leaseId: "lease-nested",
    taskId: "task-nested",
    nestedProcesses: nestedSnapshot([live, reused, gone], {
      observedCount: 3,
      lastObservedAt: "2026-01-01T00:00:02.000Z",
    }),
  });
  const legacy = baseLease({
    leaseId: "lease-legacy",
    taskId: "task-legacy",
  });
  writeLease(repo, lease);
  writeLease(repo, legacy);
  const status = await buildWorkerLeaseStatus(
    repo,
    "run-recovery",
    [{ taskId: "task-nested" }, { taskId: "task-legacy" }],
    { inspector: fake },
  );
  const nested = status.tasks.find((task) => task.taskId === "task-nested")
    ?.latest?.nestedProcesses;
  assert.deepEqual(nested, {
    present: true,
    observedCount: 3,
    identityCount: 3,
    truncated: false,
    lastObservedAt: "2026-01-01T00:00:02.000Z",
    live: 1,
    gone: 1,
    reused: 1,
    unknown: 0,
  });
  const legacyEntry = status.tasks.find(
    (task) => task.taskId === "task-legacy",
  )?.latest?.nestedProcesses;
  assert.equal(legacyEntry?.present, false);
  assert.equal(legacyEntry?.observedCount, 0);
  // Status is advisory and never rewrites the lease.
  assert.equal(
    readLeaseFile(
      workerLeasePath(repo, "run-recovery", "task-nested", lease.leaseId),
    )?.nestedProcesses?.identities.length,
    3,
  );
});

// ---------------------------------------------------------------------------
// Nested controller-death recovery
// ---------------------------------------------------------------------------

test("recovery rejects a truncated nested registry without any signal", async () => {
  const repo = tempDir("nested-truncated");
  const fake = new FakeInspector();
  const helper = identity(61_200);
  fake.add(identity(61_000));
  fake.add(helper);
  const lease = baseLease({
    taskId: "task-truncated",
    nestedProcesses: {
      ...nestedSnapshot([helper]),
      observedCount: 33,
      truncated: true,
    },
  });
  const path = writeLease(repo, lease);
  const { report, calls, pidCalls } = await recoverWith(repo, fake);
  assert.equal(report.needsHuman, 1);
  assert.equal(report.recovered, 0);
  assert.equal(calls.length, 0);
  assert.equal(pidCalls.length, 0);
  assert.equal(fake.isAlive(helper.pid), true);
  assert.equal(fake.isAlive(61_000), true);
  assert.equal(report.entries[0]?.action, "preserved");
  assert.equal(report.entries[0]?.nested?.truncated, true);
  const updated = readLeaseFile(path)!;
  assert.equal(updated.state, "active");
  assert.equal(updated.recovery?.[0]?.outcome, "needs_human");
});

test("an absent top-level leader recovers only the exact nested identity", async () => {
  const repo = tempDir("nested-leader-absent");
  const fake = new FakeInspector();
  const helper = identity(61_100);
  fake.add(helper);
  const lease = baseLease({
    taskId: "task-nested-absent",
    nestedProcesses: nestedSnapshot([helper]),
  });
  const path = writeLease(repo, lease);
  const { report, calls, pidCalls } = await recoverWith(repo, fake);
  assert.equal(calls.length, 0);
  assert.deepEqual(pidCalls, [{ pid: helper.pid, signal: "SIGTERM" }]);
  assert.equal(report.recovered, 1);
  assert.equal(report.entries[0]?.action, "terminated");
  assert.deepEqual(
    report.entries[0]?.signals.map((signal) => ({
      scope: signal.scope,
      pid: signal.pid,
      signal: signal.signal,
    })),
    [{ scope: "descendant-pid", pid: helper.pid, signal: "SIGTERM" }],
  );
  assert.equal(report.entries[0]?.nested?.observedCount, 1);
  assert.equal(report.entries[0]?.nested?.targetCount, 1);
  assert.equal(fake.isAlive(helper.pid), false);
  const updated = readLeaseFile(path)!;
  assert.equal(updated.state, "released");
  assert.equal(updated.cleanupReason, "recovery");
  assert.equal(updated.nestedProcesses?.observedCount, 1);
  assert.equal(updated.nestedProcesses?.identities[0]?.pid, helper.pid);
  assert.equal(updated.recovery?.[0]?.outcome, "recovered");
});

test("nested recovery continues past residual group members without a group signal", async () => {
  const repo = tempDir("nested-leader-absent-residual");
  const fake = new FakeInspector();
  const helper = identity(61_103);
  // A member of the vanished leader's dedicated group: it must never turn the
  // absent leader into authorization for a negative-pgid signal.
  const residual: RuntimeProcessIdentity = { ...identity(61_050), pgid: 61_000 };
  fake.add(helper);
  fake.add(residual);
  const lease = baseLease({
    taskId: "task-nested-residual",
    nestedProcesses: nestedSnapshot([helper]),
  });
  const path = writeLease(repo, lease);
  const { report, calls, pidCalls } = await recoverWith(repo, fake);
  assert.equal(calls.length, 0);
  assert.deepEqual(pidCalls, [{ pid: helper.pid, signal: "SIGTERM" }]);
  assert.equal(fake.isAlive(helper.pid), false);
  assert.equal(fake.isAlive(residual.pid), true);
  // Exact nested recovery happened, but the lease must not be released while
  // an untouchable worker-group member remains.
  assert.equal(report.entries[0]?.action, "preserved");
  assert.equal(report.entries[0]?.residualCount, 1);
  const updated = readLeaseFile(path)!;
  assert.equal(updated.state, "cleanup-failed");
  assert.equal(updated.nestedProcesses?.identities[0]?.pid, helper.pid);
});

test("a present leader cleans the guarded group and escalates exact nested pids", async () => {
  const repo = tempDir("nested-present-leader");
  const fake = new FakeInspector();
  const workerIdentity = identity(61_000);
  const helper = identity(61_101);
  fake.add(workerIdentity);
  fake.add(helper);
  fake.setParent(helper.pid, workerIdentity.pid);
  const lease = baseLease({
    taskId: "task-nested-present",
    nestedProcesses: nestedSnapshot([helper]),
  });
  const path = writeLease(repo, lease);
  const { report, calls, pidCalls } = await recoverWith(repo, fake, {
    pidIgnoreTerm: true,
  });
  assert.deepEqual(calls, [{ pgid: workerIdentity.pgid, signal: "SIGTERM" }]);
  assert.deepEqual(pidCalls, [
    { pid: helper.pid, signal: "SIGTERM" },
    { pid: helper.pid, signal: "SIGKILL" },
  ]);
  assert.equal(report.recovered, 1);
  assert.equal(fake.isAlive(workerIdentity.pid), false);
  assert.equal(fake.isAlive(helper.pid), false);
  const updated = readLeaseFile(path)!;
  assert.equal(updated.state, "released");
  // The refreshed target set was persisted before the signals.
  assert.equal(updated.nestedProcesses?.identities[0]?.pid, helper.pid);
  assert.ok(
    updated.recovery?.[0]?.signals.some(
      (signal) =>
        signal.scope === "descendant-pid" && signal.pid === helper.pid,
    ),
  );
});

test("recovery terminates a persisted nested group through one guarded negative-pgid signal", async () => {
  const repo = tempDir("nested-group-present");
  const fake = new FakeInspector();
  const leader = identity(61_400);
  const member = { ...identity(61_401), pgid: leader.pgid };
  fake.add(leader);
  fake.add(member);
  const lease = baseLease({
    taskId: "task-group-present",
    nestedProcesses: nestedSnapshot([], {
      groups: [
        {
          pgid: leader.pgid,
          leader,
          observedMemberCount: 2,
          lastObservedAt: "2026-01-01T00:00:02.000Z",
        },
      ],
    }),
  });
  const path = writeLease(repo, lease);
  const { report, calls, pidCalls } = await recoverWith(repo, fake);
  assert.deepEqual(calls, [{ pgid: leader.pgid, signal: "SIGTERM" }]);
  assert.deepEqual(pidCalls, []);
  assert.equal(report.recovered, 1);
  assert.equal(report.needsHuman, 0);
  assert.equal(report.entries[0]?.action, "terminated");
  assert.deepEqual(
    report.entries[0]?.signals.map((signal) => ({
      scope: signal.scope,
      pid: signal.pid,
      pgid: signal.pgid,
      signal: signal.signal,
    })),
    [
      {
        scope: "nested-process-group",
        pid: undefined,
        pgid: leader.pgid,
        signal: "SIGTERM",
      },
    ],
  );
  assert.equal(fake.isAlive(leader.pid), false);
  assert.equal(fake.isAlive(member.pid), false);
  const updated = readLeaseFile(path)!;
  assert.equal(updated.state, "released");
  assert.equal(updated.nestedProcesses?.groups?.[0]?.pgid, leader.pgid);
});

test("recovery never signals a reused nested group leader", async () => {
  const repo = tempDir("nested-group-reused-leader");
  const fake = new FakeInspector();
  const recorded = identity(61_500);
  const reused = { ...identity(61_500), startedAt: "Tue Jan  2 00:00:00 2024" };
  const member = { ...identity(61_501), pgid: recorded.pgid };
  fake.add(reused);
  fake.add(member);
  const lease = baseLease({
    taskId: "task-group-reused",
    nestedProcesses: nestedSnapshot([], {
      groups: [
        {
          pgid: recorded.pgid,
          leader: recorded,
          observedMemberCount: 2,
          lastObservedAt: "2026-01-01T00:00:02.000Z",
        },
      ],
    }),
  });
  const path = writeLease(repo, lease);
  const { report, calls, pidCalls } = await recoverWith(repo, fake);
  assert.deepEqual(calls, []);
  assert.deepEqual(pidCalls, []);
  assert.equal(fake.isAlive(reused.pid), true);
  assert.equal(fake.isAlive(member.pid), true);
  assert.equal(report.needsHuman, 1);
  assert.equal(report.recovered, 0);
  assert.equal(report.entries[0]?.action, "preserved");
  assert.match(report.entries[0]?.reason ?? "", /leader/i);
  const updated = readLeaseFile(path)!;
  assert.equal(updated.state, "active");
  assert.equal(updated.recovery?.[0]?.outcome, "needs_human");
});

test("an absent nested group leader never authorizes a group signal", async () => {
  const repo = tempDir("nested-group-absent-leader");
  const fake = new FakeInspector();
  const recorded = identity(61_600);
  const residual = { ...identity(61_601), pgid: recorded.pgid };
  const helper = identity(61_602);
  fake.add(residual);
  fake.add(helper);
  const lease = baseLease({
    taskId: "task-group-absent",
    nestedProcesses: nestedSnapshot([helper], {
      groups: [
        {
          pgid: recorded.pgid,
          leader: recorded,
          observedMemberCount: 2,
          lastObservedAt: "2026-01-01T00:00:02.000Z",
        },
      ],
    }),
  });
  const path = writeLease(repo, lease);
  const { report, calls, pidCalls } = await recoverWith(repo, fake);
  // The unproven group is never signalled; only the complete exact-pid
  // fallback identity is eligible.
  assert.deepEqual(calls, []);
  assert.deepEqual(pidCalls, [{ pid: helper.pid, signal: "SIGTERM" }]);
  assert.equal(fake.isAlive(helper.pid), false);
  assert.equal(fake.isAlive(residual.pid), true);
  assert.equal(report.needsHuman, 1);
  assert.equal(report.entries[0]?.action, "preserved");
  assert.equal(report.entries[0]?.residualCount, 1);
  const updated = readLeaseFile(path)!;
  assert.equal(updated.recovery?.[0]?.outcome, "needs_human");
  assert.equal(updated.nestedProcesses?.groups?.[0]?.pgid, recorded.pgid);
});

test("recovery never signals a reused nested pid", async () => {
  const repo = tempDir("nested-reused");
  const fake = new FakeInspector();
  const recorded: RuntimeProcessIdentity = {
    pid: 61_102,
    pgid: 61_102,
    startedAt: "Mon Jan  1 00:00:00 2024",
  };
  fake.add({
    pid: recorded.pid,
    pgid: recorded.pgid,
    startedAt: "Tue Jan  2 00:00:00 2024",
  });
  const lease = baseLease({
    taskId: "task-reused",
    nestedProcesses: nestedSnapshot([recorded]),
  });
  const path = writeLease(repo, lease);
  const { report, calls, pidCalls } = await recoverWith(repo, fake);
  assert.equal(calls.length, 0);
  assert.equal(pidCalls.length, 0);
  assert.equal(fake.isAlive(recorded.pid), true);
  assert.equal(report.recovered, 1);
  assert.equal(report.entries[0]?.action, "already-exited");
  assert.equal(readLeaseFile(path)?.state, "released");
});

posixTest(
  "recovery preserves processes when nested targets cannot be checkpointed",
  async () => {
    const repo = tempDir("nested-checkpoint-failure");
    const fake = new FakeInspector();
    const helper = identity(61_300);
    fake.add(helper);
    const lease = baseLease({
      taskId: "task-checkpoint",
      nestedProcesses: nestedSnapshot([helper]),
    });
    const path = writeLease(repo, lease);
    const dir = join(path, "..");
    chmodSync(dir, 0o500);
    try {
      const { report, calls, pidCalls } = await recoverWith(repo, fake);
      assert.equal(report.needsHuman, 1);
      assert.equal(report.recovered, 0);
      assert.equal(calls.length, 0);
      assert.equal(pidCalls.length, 0);
      assert.equal(fake.isAlive(helper.pid), true);
      assert.match(report.entries[0]?.reason ?? "", /persist/i);
      const preserved = readLeaseFile(path)!;
      assert.equal(preserved.state, "active");
      assert.equal(preserved.nestedProcesses?.identities[0]?.pid, helper.pid);
    } finally {
      chmodSync(dir, 0o700);
    }
  },
);

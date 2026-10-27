/**
 * Focused orphan-preflight coverage for exact lease-owner correlation
 * (design/runtime-orphan-hardening.md, finding 1).
 *
 * A service is eligible for reaping only when the exact port lease owner pid
 * equals the manifest owner pid. A dead or live third-party lease owner is
 * `needs_human` and preserves the process group, lease, and manifest.
 *
 * These cases use an in-memory lease source so the owner pid is controlled
 * exactly; real `PortAllocator` correlation stays covered by
 * `runtime-reaper-plan.test.ts`.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { hostname, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { runtimePaths } from "../src/runtime/manager.js";
import { ProcessInspector } from "../src/runtime/process.js";
import {
  preflightOrphanedRuntimes,
  type RuntimeReapLeaseSource,
  type RuntimeReapPlan,
  type RuntimeReapPreflightReport,
} from "../src/runtime/reaper.js";
import type {
  PortLease,
  RuntimeManifest,
  RuntimeProcessIdentity,
} from "../src/runtime/types.js";

const inspector = new ProcessInspector();

/**
 * Pids above every configured OS pid limit: `kill(pid, 0)` always reports
 * ESRCH, so these fixtures simulate dead owners without racing a real process.
 */
const DEAD_OWNER_PID = 999_999_999;
const OTHER_DEAD_PID = 999_999_998;

/** Detached service leader with no listeners: it only needs to stay alive. */
const KEEP_ALIVE_SCRIPT = "setInterval(() => {}, 1000);";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function withTempRepo(fn: (repo: string) => Promise<void>): Promise<void> {
  const base = mkdtempSync(join(tmpdir(), "cliyard-owner-lease-safety-"));
  const repo = join(base, "control");
  mkdirSync(repo, { recursive: true });
  try {
    await fn(repo);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
}

function makeLease(
  runtimeId: string,
  port: number,
  ownerPid: number,
): PortLease {
  return {
    key: `${runtimeId}:web`,
    runId: runtimeId,
    service: "web",
    host: "127.0.0.1",
    port,
    pid: ownerPid,
    acquiredAt: "2026-10-27T00:00:00.000Z",
  };
}

function makeManifest(input: {
  runtimeId: string;
  ownerPid: number;
  port: number;
  servicePid: number;
  identity: RuntimeProcessIdentity;
}): RuntimeManifest {
  return {
    version: 1,
    runtimeId: input.runtimeId,
    taskId: `task-${input.runtimeId}`,
    attempt: 1,
    worktree: "/tmp/cliyard-owner-lease-worktree",
    owner: { pid: input.ownerPid, host: hostname() },
    services: [
      {
        name: "web",
        host: "127.0.0.1",
        port: input.port,
        pid: input.servicePid,
        pgid: input.servicePid,
        processIdentity: input.identity,
        url: `http://127.0.0.1:${input.port}`,
        healthUrl: `http://127.0.0.1:${input.port}/health`,
        logPath: `/tmp/${input.runtimeId}-web.log`,
        dataDir: `/tmp/${input.runtimeId}-web-data`,
        readinessAttempts: [],
        startedAt: "2026-10-27T00:00:00.000Z",
      },
    ],
    startedAt: "2026-10-27T00:00:00.000Z",
    cleanup: "pending",
  };
}

function writeManifest(repo: string, manifest: RuntimeManifest): string {
  const path = runtimePaths(repo, manifest.runtimeId).manifestPath;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(manifest, null, 2) + "\n", "utf8");
  return path;
}

/** Stable in-memory lease store; preflight must leave it untouched. */
function leaseSource(leases: PortLease[]): RuntimeReapLeaseSource {
  return { list: () => leases };
}

function planOf(
  report: RuntimeReapPreflightReport,
  runtimeId: string,
): RuntimeReapPlan {
  const plan = report.plans.find((entry) => entry.runtimeId === runtimeId);
  assert.ok(plan, `missing plan for runtime ${runtimeId}`);
  return plan;
}

async function spawnService(): Promise<{
  child: ChildProcess;
  pid: number;
  identity: RuntimeProcessIdentity;
}> {
  const child = spawn(process.execPath, ["-e", KEEP_ALIVE_SCRIPT], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  await once(child, "spawn");
  const pid = child.pid;
  assert.ok(pid, "spawned service has no pid");
  const identity = await inspector.capture(pid);
  assert.ok(identity, "spawned service has no capturable identity");
  assert.equal(identity.pid, pid);
  assert.equal(identity.pgid, pid);
  return { child, pid, identity };
}

async function stopGroup(child: ChildProcess, pid: number): Promise<void> {
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

// ---------------------------------------------------------------------------
// Equal owner: safe
// ---------------------------------------------------------------------------

test("equal dead lease and manifest owner is safe_to_reap", async () => {
  await withTempRepo(async (repo) => {
    const service = await spawnService();
    try {
      const lease = makeLease("runtime-owner-equal", 46_001, DEAD_OWNER_PID);
      const manifestPath = writeManifest(
        repo,
        makeManifest({
          runtimeId: lease.runId,
          ownerPid: DEAD_OWNER_PID,
          port: lease.port,
          servicePid: service.pid,
          identity: service.identity,
        }),
      );
      const manifestBytes = readFileSync(manifestPath, "utf8");
      const leases = [lease];

      const report = await preflightOrphanedRuntimes(repo, {
        allocator: leaseSource(leases),
      });

      assert.equal(report.scanned, 1);
      assert.equal(report.needsHuman.length, 0);
      assert.equal(report.skipped.length, 0);
      assert.equal(report.safeToReap.length, 1);

      const plan = planOf(report, lease.runId);
      assert.equal(plan.state, "safe_to_reap");
      assert.equal(plan.problems.length, 0);
      assert.deepEqual(plan.leases, [lease]);
      assert.equal(plan.services.length, 1);
      assert.equal(plan.services[0].action, "terminate");
      assert.deepEqual(plan.services[0].lease, lease);
      assert.deepEqual(plan.services[0].processIdentity, service.identity);

      // Preflight planned only: manifest, lease, and live group are unchanged.
      assert.equal(readFileSync(manifestPath, "utf8"), manifestBytes);
      assert.deepEqual(leases, [lease]);
      assert.equal(inspector.isAlive(service.pid), true);
      assert.deepEqual(await inspector.capture(service.pid), service.identity);
    } finally {
      await stopGroup(service.child, service.pid);
    }
  });
});

// ---------------------------------------------------------------------------
// Different owner: needs_human
// ---------------------------------------------------------------------------

test("dead different-owner lease is needs_human and preserves evidence", async () => {
  await withTempRepo(async (repo) => {
    const service = await spawnService();
    try {
      const lease = makeLease(
        "runtime-owner-dead-mismatch",
        46_002,
        OTHER_DEAD_PID,
      );
      const manifestPath = writeManifest(
        repo,
        makeManifest({
          runtimeId: lease.runId,
          ownerPid: DEAD_OWNER_PID,
          port: lease.port,
          servicePid: service.pid,
          identity: service.identity,
        }),
      );
      const manifestBytes = readFileSync(manifestPath, "utf8");
      const leases = [lease];

      assert.equal(inspector.isAlive(lease.pid), false);
      assert.notEqual(lease.pid, DEAD_OWNER_PID);

      const report = await preflightOrphanedRuntimes(repo, {
        allocator: leaseSource(leases),
      });

      assert.equal(report.scanned, 1);
      assert.equal(report.safeToReap.length, 0);
      assert.equal(report.needsHuman.length, 1);
      assert.equal(report.skipped.length, 0);

      const plan = planOf(report, lease.runId);
      assert.equal(plan.state, "needs_human");
      assert.match(
        plan.reason,
        /owned by dead pid 999999998, not the runtime owner pid 999999999/,
      );
      assert.match(plan.reason, /exact lease ownership cannot be proven/);
      assert.deepEqual(plan.leases, [lease]);
      assert.equal(plan.services.length, 1);
      assert.equal(plan.services[0].action, "preserve");
      assert.deepEqual(plan.services[0].lease, lease);

      // Process group, exact lease, and manifest are preserved.
      assert.equal(inspector.isAlive(service.pid), true);
      assert.deepEqual(await inspector.capture(service.pid), service.identity);
      assert.deepEqual(leases, [lease]);
      assert.equal(readFileSync(manifestPath, "utf8"), manifestBytes);
      const persisted = JSON.parse(manifestBytes) as RuntimeManifest;
      assert.equal(persisted.cleanup, "pending");
      assert.equal(persisted.recovery, undefined);
    } finally {
      await stopGroup(service.child, service.pid);
    }
  });
});

test("live different-owner lease is needs_human and preserves evidence", async () => {
  await withTempRepo(async (repo) => {
    const service = await spawnService();
    try {
      const lease = makeLease("runtime-owner-live-mismatch", 46_003, process.pid);
      const manifestPath = writeManifest(
        repo,
        makeManifest({
          runtimeId: lease.runId,
          ownerPid: DEAD_OWNER_PID,
          port: lease.port,
          servicePid: service.pid,
          identity: service.identity,
        }),
      );
      const manifestBytes = readFileSync(manifestPath, "utf8");
      const leases = [lease];

      assert.equal(inspector.isAlive(lease.pid), true);
      assert.notEqual(lease.pid, DEAD_OWNER_PID);

      const report = await preflightOrphanedRuntimes(repo, {
        allocator: leaseSource(leases),
      });

      assert.equal(report.scanned, 1);
      assert.equal(report.safeToReap.length, 0);
      assert.equal(report.needsHuman.length, 1);
      assert.equal(report.skipped.length, 0);

      const plan = planOf(report, lease.runId);
      assert.equal(plan.state, "needs_human");
      assert.match(
        plan.reason,
        new RegExp(
          `owned by live pid ${process.pid}, not the runtime owner pid ` +
            `${DEAD_OWNER_PID}`,
        ),
      );
      assert.match(plan.reason, /exact lease ownership cannot be proven/);
      assert.deepEqual(plan.leases, [lease]);
      assert.equal(plan.services.length, 1);
      assert.equal(plan.services[0].action, "preserve");
      assert.deepEqual(plan.services[0].lease, lease);

      // The unrelated live lease owner proves nothing about this service: the
      // service process group, its lease, and the manifest all stay intact.
      assert.equal(inspector.isAlive(service.pid), true);
      assert.deepEqual(await inspector.capture(service.pid), service.identity);
      assert.deepEqual(leases, [lease]);
      assert.equal(readFileSync(manifestPath, "utf8"), manifestBytes);
      const persisted = JSON.parse(manifestBytes) as RuntimeManifest;
      assert.equal(persisted.cleanup, "pending");
      assert.equal(persisted.recovery, undefined);
    } finally {
      await stopGroup(service.child, service.pid);
    }
  });
});

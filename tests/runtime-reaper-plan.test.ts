import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createServer, type AddressInfo } from "node:net";
import { hostname, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { runtimePaths } from "../src/runtime/manager.js";
import { PortAllocator } from "../src/runtime/ports.js";
import { ProcessInspector } from "../src/runtime/process.js";
import {
  preflightOrphanedRuntimes,
  type RuntimeReapPlan,
  type RuntimeReapPreflightReport,
} from "../src/runtime/reaper.js";
import type {
  PortLease,
  RuntimeCleanupState,
  RuntimeManifest,
  RuntimeOwner,
  RuntimeProcessIdentity,
  RuntimeRecoveryState,
} from "../src/runtime/types.js";

const inspector = new ProcessInspector();

/**
 * A pid above every configured OS pid limit: `kill(pid, 0)` always reports
 * ESRCH, so these fixtures simulate a dead control process without racing a
 * real spawn/exit.
 */
const DEAD_PID = 999_999_999;

/** Detached service leader with no listeners: it only needs to stay alive. */
const KEEP_ALIVE_SCRIPT = "setInterval(() => {}, 1000);";

/**
 * Detached leader that spawns one helper into its process group and then exits,
 * leaving a group whose ownership can no longer be proven from the leader.
 */
const GROUP_REMAINS_SCRIPT = String.raw`
const { spawn } = require("node:child_process");
spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
setTimeout(() => process.exit(0), 200);
`;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function withTempRepo(fn: (repo: string) => Promise<void>): Promise<void> {
  const base = mkdtempSync(join(tmpdir(), "cliyard-reaper-plan-"));
  const repo = join(base, "control");
  mkdirSync(repo, { recursive: true });
  try {
    await fn(repo);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
}

function runtimeDir(repo: string): string {
  return join(repo, ".cliyard", "runtime");
}

function leaseStorePath(repo: string): string {
  return join(runtimeDir(repo), "port-leases.json");
}

function listenOn(server: ReturnType<typeof createServer>, port: number): Promise<void> {
  return new Promise((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen({ host: "127.0.0.1", port }, () => {
      server.off("error", rejectListen);
      resolveListen();
    });
  });
}

function closeServer(server: ReturnType<typeof createServer>): Promise<void> {
  return new Promise((resolveClose, rejectClose) => {
    server.close((error) => (error ? rejectClose(error) : resolveClose()));
  });
}

async function ephemeralPort(): Promise<number> {
  const server = createServer();
  await listenOn(server, 0);
  const { port } = server.address() as AddressInfo;
  await closeServer(server);
  return port;
}

async function freshRange(
  size: number,
): Promise<{ range: string; start: number; end: number }> {
  const base = await ephemeralPort();
  const start = Math.min(base, 65535 - size + 1);
  const end = start + size - 1;
  return { range: `${start}-${end}`, start, end };
}

/**
 * Allocate real PortAllocator leases for every requested service, then rewrite
 * their owner pid to the dead owner. Allocation must happen first because the
 * allocator prunes dead-owner leases whenever it reserves a new port.
 */
async function allocateOrphanLeases(
  repo: string,
  requests: ReadonlyArray<{ runtimeId: string; service: string }>,
): Promise<PortLease[]> {
  const { range } = await freshRange(requests.length + 2);
  const allocator = new PortAllocator({ repoRoot: repo, range });
  const allocated: PortLease[] = [];
  for (const request of requests) {
    allocated.push(await allocator.allocate(request.runtimeId, request.service));
  }

  const path = leaseStorePath(repo);
  const store = JSON.parse(readFileSync(path, "utf8")) as {
    version: number;
    leases: Array<PortLease>;
  };
  for (const lease of store.leases) lease.pid = DEAD_PID;
  writeFileSync(path, JSON.stringify(store, null, 2) + "\n", "utf8");

  return allocated.map((lease) => ({ ...lease, pid: DEAD_PID }));
}

function listLeases(repo: string): PortLease[] {
  return new PortAllocator({ repoRoot: repo }).list();
}

interface ServiceInput {
  name: string;
  port: number;
  pid?: number;
  pgid?: number;
  identity?: RuntimeProcessIdentity;
}

interface ManifestInput {
  runtimeId: string;
  owner?: RuntimeOwner;
  cleanup?: RuntimeCleanupState;
  services?: ServiceInput[];
  recoveryState?: RuntimeRecoveryState;
}

function makeManifest(input: ManifestInput): RuntimeManifest {
  return {
    version: 1,
    runtimeId: input.runtimeId,
    taskId: `task-${input.runtimeId}`,
    attempt: 1,
    worktree: "/tmp/cliyard-reaper-worktree",
    ...(input.owner !== undefined ? { owner: input.owner } : {}),
    services: (input.services ?? []).map((service) => ({
      name: service.name,
      host: "127.0.0.1",
      port: service.port,
      ...(service.pid !== undefined ? { pid: service.pid } : {}),
      ...(service.pgid !== undefined ? { pgid: service.pgid } : {}),
      ...(service.identity !== undefined
        ? { processIdentity: service.identity }
        : {}),
      url: `http://127.0.0.1:${service.port}`,
      healthUrl: `http://127.0.0.1:${service.port}/health`,
      logPath: `/tmp/${input.runtimeId}-${service.name}.log`,
      dataDir: `/tmp/${input.runtimeId}-${service.name}-data`,
      readinessAttempts: [],
      startedAt: "2026-10-27T00:00:00.000Z",
    })),
    startedAt: "2026-10-27T00:00:00.000Z",
    cleanup: input.cleanup ?? "pending",
    ...(input.recoveryState !== undefined
      ? {
          recovery: {
            state: input.recoveryState,
            reason: "seed evidence for the test",
            at: "2026-10-27T00:00:00.000Z",
            reaperPid: process.pid,
            reaperHost: hostname(),
            services: [],
          },
        }
      : {}),
  };
}

function writeManifest(repo: string, manifest: RuntimeManifest): string {
  const path = runtimePaths(repo, manifest.runtimeId).manifestPath;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(manifest, null, 2) + "\n", "utf8");
  return path;
}

function planOf(
  report: RuntimeReapPreflightReport,
  runtimeId: string,
): RuntimeReapPlan {
  const plan = report.plans.find((entry) => entry.runtimeId === runtimeId);
  assert.ok(plan, `missing plan for runtime ${runtimeId}`);
  return plan;
}

async function spawnService(
  script: string = KEEP_ALIVE_SCRIPT,
): Promise<{
  child: ChildProcess;
  pid: number;
  identity: RuntimeProcessIdentity;
}> {
  const child = spawn(process.execPath, ["-e", script], {
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

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

async function waitForGroupMembers(
  pgid: number,
  minimum: number,
  timeoutMs = 5_000,
): Promise<RuntimeProcessIdentity[]> {
  const deadline = Date.now() + timeoutMs;
  let members = await inspector.listGroupMembers(pgid);
  while (members.length < minimum && Date.now() < deadline) {
    await delay(25);
    members = await inspector.listGroupMembers(pgid);
  }
  return members;
}

// ---------------------------------------------------------------------------
// Safe orphan
// ---------------------------------------------------------------------------

test("classifies an exactly correlated orphan as safe_to_reap", async () => {
  await withTempRepo(async (repo) => {
    assert.equal(inspector.isAlive(DEAD_PID), false);
    const service = await spawnService();
    try {
      const [lease] = await allocateOrphanLeases(repo, [
        { runtimeId: "runtime-safe", service: "web" },
      ]);
      writeManifest(
        repo,
        makeManifest({
          runtimeId: "runtime-safe",
          owner: { pid: DEAD_PID, host: hostname() },
          cleanup: "pending",
          services: [
            {
              name: "web",
              port: lease.port,
              pid: service.pid,
              pgid: service.pid,
              identity: service.identity,
            },
          ],
        }),
      );

      const report = await preflightOrphanedRuntimes(repo);

      assert.equal(report.scanned, 1);
      assert.equal(report.needsHuman.length, 0);
      assert.equal(report.skipped.length, 0);
      assert.equal(report.safeToReap.length, 1);

      const plan = report.safeToReap[0];
      assert.equal(plan.runtimeId, "runtime-safe");
      assert.equal(plan.state, "safe_to_reap");
      assert.match(plan.reason, /owner pid 999999999 is not running/);
      assert.match(plan.reason, /1 service\(s\) proven live/);
      assert.equal(plan.problems.length, 0);
      assert.deepEqual(plan.leases, [lease]);

      assert.equal(plan.services.length, 1);
      const servicePlan = plan.services[0];
      assert.equal(servicePlan.name, "web");
      assert.equal(servicePlan.action, "terminate");
      assert.equal(servicePlan.pgid, service.pid);
      assert.deepEqual(servicePlan.lease, lease);
      assert.deepEqual(servicePlan.processIdentity, service.identity);

      // Preflight only planned: the service is still running.
      assert.equal(inspector.isAlive(service.pid), true);
    } finally {
      await stopGroup(service.child, service.pid);
    }
  });
});

// ---------------------------------------------------------------------------
// Skips
// ---------------------------------------------------------------------------

test("skips completed, already-reaped, and foreign-host runtimes", async () => {
  await withTempRepo(async (repo) => {
    writeManifest(
      repo,
      makeManifest({
        runtimeId: "runtime-complete",
        owner: { pid: DEAD_PID, host: hostname() },
        cleanup: "complete",
      }),
    );
    writeManifest(
      repo,
      makeManifest({
        runtimeId: "runtime-reaped",
        owner: { pid: DEAD_PID, host: hostname() },
        cleanup: "failed",
        recoveryState: "reaped",
      }),
    );
    writeManifest(
      repo,
      makeManifest({
        runtimeId: "runtime-foreign",
        owner: { pid: process.pid, host: `foreign-${hostname()}` },
        cleanup: "pending",
        services: [
          {
            name: "web",
            port: 19001,
            pid: process.pid,
            pgid: process.pid,
          },
        ],
      }),
    );

    const report = await preflightOrphanedRuntimes(repo);

    assert.equal(report.scanned, 3);
    assert.equal(report.safeToReap.length, 0);
    assert.equal(report.needsHuman.length, 0);
    assert.deepEqual(
      report.skipped.map((plan) => plan.runtimeId).sort(),
      ["runtime-complete", "runtime-foreign", "runtime-reaped"],
    );

    assert.match(
      planOf(report, "runtime-complete").reason,
      /cleanup is complete/,
    );
    assert.match(
      planOf(report, "runtime-reaped").reason,
      /already reconciled/,
    );
    assert.match(
      planOf(report, "runtime-foreign").reason,
      /is not local host/,
    );
  });
});

test("needs_human rather than safe when the lease store cannot be read", async () => {
  await withTempRepo(async (repo) => {
    writeManifest(
      repo,
      makeManifest({
        runtimeId: "runtime-corrupt-leases",
        owner: { pid: DEAD_PID, host: hostname() },
        cleanup: "pending",
      }),
    );
    writeFileSync(leaseStorePath(repo), "{not json", "utf8");

    const report = await preflightOrphanedRuntimes(repo);

    assert.equal(report.scanned, 1);
    assert.equal(report.safeToReap.length, 0);
    assert.equal(report.needsHuman.length, 1);
    assert.match(
      planOf(report, "runtime-corrupt-leases").reason,
      /cannot read port leases/,
    );
  });
});

// ---------------------------------------------------------------------------
// Legacy / missing identity
// ---------------------------------------------------------------------------

test("needs_human when a potentially active manifest has no identity or owner", async () => {
  await withTempRepo(async (repo) => {
    const service = await spawnService();
    try {
      const [lease] = await allocateOrphanLeases(repo, [
        { runtimeId: "runtime-no-identity", service: "web" },
      ]);
      writeManifest(
        repo,
        makeManifest({
          runtimeId: "runtime-no-identity",
          owner: { pid: DEAD_PID, host: hostname() },
          cleanup: "running",
          services: [
            {
              name: "web",
              port: lease.port,
              pid: service.pid,
              pgid: service.pid,
              // No processIdentity: legacy evidence, but the pid is alive.
            },
          ],
        }),
      );
      writeManifest(
        repo,
        makeManifest({
          runtimeId: "runtime-no-owner",
          cleanup: "pending",
        }),
      );

      const report = await preflightOrphanedRuntimes(repo);

      assert.equal(report.scanned, 2);
      assert.equal(report.safeToReap.length, 0);
      assert.equal(report.needsHuman.length, 2);
      assert.equal(
        planOf(report, "runtime-no-identity").state,
        "needs_human",
      );
      assert.match(
        planOf(report, "runtime-no-identity").reason,
        /no exact persisted process identity/,
      );
      assert.match(
        planOf(report, "runtime-no-owner").reason,
        /no valid owner identity/,
      );

      // The live service and its lease are preserved.
      assert.equal(inspector.isAlive(service.pid), true);
      assert.deepEqual(await inspector.capture(service.pid), service.identity);
      assert.deepEqual(listLeases(repo), [lease]);
    } finally {
      await stopGroup(service.child, service.pid);
    }
  });
});

// ---------------------------------------------------------------------------
// Changed identity
// ---------------------------------------------------------------------------

test("needs_human when a live pid no longer has the persisted identity", async () => {
  await withTempRepo(async (repo) => {
    const service = await spawnService();
    try {
      const [lease] = await allocateOrphanLeases(repo, [
        { runtimeId: "runtime-reused-pid", service: "web" },
      ]);
      writeManifest(
        repo,
        makeManifest({
          runtimeId: "runtime-reused-pid",
          owner: { pid: DEAD_PID, host: hostname() },
          cleanup: "pending",
          services: [
            {
              name: "web",
              port: lease.port,
              pid: service.pid,
              pgid: service.pid,
              identity: {
                ...service.identity,
                // Same pid/pgid, but a different OS start identity: the pid
                // was reused by an unrelated process.
                startedAt: "Mon Jan  1 00:00:00 2001",
              },
            },
          ],
        }),
      );

      const report = await preflightOrphanedRuntimes(repo);

      assert.equal(report.scanned, 1);
      assert.equal(report.safeToReap.length, 0);
      assert.equal(report.needsHuman.length, 1);
      const plan = planOf(report, "runtime-reused-pid");
      assert.equal(plan.state, "needs_human");
      assert.match(plan.reason, /identity changed/);
      assert.equal(plan.services[0].action, "preserve");
      assert.deepEqual(plan.leases, [lease]);

      assert.equal(inspector.isAlive(service.pid), true);
      assert.deepEqual(await inspector.capture(service.pid), service.identity);
      assert.deepEqual(listLeases(repo), [lease]);
    } finally {
      await stopGroup(service.child, service.pid);
    }
  });
});

test("needs_human when the leader exited but its process group still has members", async () => {
  await withTempRepo(async (repo) => {
    const leader = spawn(process.execPath, ["-e", GROUP_REMAINS_SCRIPT], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    await once(leader, "spawn");
    const leaderPid = leader.pid;
    assert.ok(leaderPid, "spawned group leader has no pid");
    const identity = await inspector.capture(leaderPid);
    assert.ok(identity);

    try {
      // The leader spawns a helper into its group, then exits on its own.
      await once(leader, "exit");
      const members = await waitForGroupMembers(leaderPid, 1);
      assert.ok(
        members.length > 0,
        "expected the helper to outlive the group leader",
      );

      const [lease] = await allocateOrphanLeases(repo, [
        { runtimeId: "runtime-orphan-group", service: "web" },
      ]);
      writeManifest(
        repo,
        makeManifest({
          runtimeId: "runtime-orphan-group",
          owner: { pid: DEAD_PID, host: hostname() },
          cleanup: "pending",
          services: [
            {
              name: "web",
              port: lease.port,
              pid: leaderPid,
              pgid: leaderPid,
              identity,
            },
          ],
        }),
      );

      const report = await preflightOrphanedRuntimes(repo);

      assert.equal(report.scanned, 1);
      assert.equal(report.safeToReap.length, 0);
      assert.equal(report.needsHuman.length, 1);
      const plan = planOf(report, "runtime-orphan-group");
      assert.match(plan.reason, /process group .* still has \d+ member/);
      assert.equal(plan.services[0].action, "preserve");
      assert.deepEqual(plan.leases, [lease]);

      // The helper was never signalled.
      assert.deepEqual(
        (await inspector.listGroupMembers(leaderPid)).map((member) => member.pid),
        members.map((member) => member.pid),
      );
    } finally {
      try {
        process.kill(-leaderPid, "SIGKILL");
      } catch {
        /* group already gone */
      }
      try {
        leader.kill("SIGKILL");
      } catch {
        /* already exited */
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Lease correlation
// ---------------------------------------------------------------------------

test("needs_human when the manifest port does not match its exact lease", async () => {
  await withTempRepo(async (repo) => {
    const service = await spawnService();
    try {
      const [lease] = await allocateOrphanLeases(repo, [
        { runtimeId: "runtime-lease-mismatch", service: "web" },
      ]);
      const otherPort = lease.port === 65535 ? lease.port - 1 : lease.port + 1;
      writeManifest(
        repo,
        makeManifest({
          runtimeId: "runtime-lease-mismatch",
          owner: { pid: DEAD_PID, host: hostname() },
          cleanup: "pending",
          services: [
            {
              name: "web",
              port: otherPort,
              pid: service.pid,
              pgid: service.pid,
              identity: service.identity,
            },
          ],
        }),
      );

      const report = await preflightOrphanedRuntimes(repo);

      assert.equal(report.scanned, 1);
      assert.equal(report.safeToReap.length, 0);
      assert.equal(report.needsHuman.length, 1);
      const plan = planOf(report, "runtime-lease-mismatch");
      assert.equal(plan.state, "needs_human");
      assert.match(plan.reason, /no exact port lease/);
      assert.match(plan.reason, /no matching manifest service/);
      assert.equal(plan.services[0].action, "preserve");
      assert.equal(plan.services[0].lease, undefined);

      assert.equal(inspector.isAlive(service.pid), true);
      assert.deepEqual(listLeases(repo), [lease]);
    } finally {
      await stopGroup(service.child, service.pid);
    }
  });
});

// ---------------------------------------------------------------------------
// Competing manifests
// ---------------------------------------------------------------------------

test("needs_human when another unfinished manifest references the group or port", async () => {
  await withTempRepo(async (repo) => {
    const service = await spawnService();
    try {
      const [lease] = await allocateOrphanLeases(repo, [
        { runtimeId: "runtime-orphan", service: "web" },
      ]);
      writeManifest(
        repo,
        makeManifest({
          runtimeId: "runtime-orphan",
          owner: { pid: DEAD_PID, host: hostname() },
          cleanup: "pending",
          services: [
            {
              name: "web",
              port: lease.port,
              pid: service.pid,
              pgid: service.pid,
              identity: service.identity,
            },
          ],
        }),
      );
      // A still-owned runtime claims the same live group and port. Ownership is
      // not exclusive, so the orphan must not be reaped.
      writeManifest(
        repo,
        makeManifest({
          runtimeId: "runtime-competing",
          owner: { pid: process.pid, host: hostname() },
          cleanup: "running",
          services: [
            {
              name: "web",
              port: lease.port,
              pid: service.pid,
              pgid: service.pid,
            },
          ],
        }),
      );

      const report = await preflightOrphanedRuntimes(repo);

      assert.equal(report.scanned, 2);
      assert.equal(report.safeToReap.length, 0);
      assert.equal(report.needsHuman.length, 1);
      assert.equal(report.skipped.length, 1);

      const plan = planOf(report, "runtime-orphan");
      assert.equal(plan.state, "needs_human");
      assert.match(plan.reason, /runtime-competing/);
      assert.match(plan.reason, /pgid /);
      assert.match(plan.reason, /port /);
      assert.equal(plan.services[0].action, "preserve");
      assert.deepEqual(plan.leases, [lease]);

      // The competing manifest's owner is alive, so it is simply skipped.
      assert.equal(planOf(report, "runtime-competing").state, "skip");
      assert.equal(inspector.isAlive(service.pid), true);
      assert.deepEqual(listLeases(repo), [lease]);
    } finally {
      await stopGroup(service.child, service.pid);
    }
  });
});

// ---------------------------------------------------------------------------
// Read-only proof
// ---------------------------------------------------------------------------

test("preflight leaves processes, leases, and manifests byte-identical", async () => {
  await withTempRepo(async (repo) => {
    const safeService = await spawnService();
    const humanService = await spawnService();
    try {
      const leases = await allocateOrphanLeases(repo, [
        { runtimeId: "runtime-safe", service: "web" },
        { runtimeId: "runtime-human", service: "api" },
      ]);
      const safeLease = leases[0];
      const humanLease = leases[1];

      const safeManifestPath = writeManifest(
        repo,
        makeManifest({
          runtimeId: "runtime-safe",
          owner: { pid: DEAD_PID, host: hostname() },
          cleanup: "pending",
          services: [
            {
              name: "web",
              port: safeLease.port,
              pid: safeService.pid,
              pgid: safeService.pid,
              identity: safeService.identity,
            },
          ],
        }),
      );
      const humanManifestPath = writeManifest(
        repo,
        makeManifest({
          runtimeId: "runtime-human",
          owner: { pid: DEAD_PID, host: hostname() },
          cleanup: "running",
          services: [
            {
              name: "api",
              port: humanLease.port,
              pid: humanService.pid,
              pgid: humanService.pid,
              identity: {
                ...humanService.identity,
                startedAt: "Mon Jan  1 00:00:00 2001",
              },
            },
          ],
        }),
      );

      const manifestBytes = new Map([
        [safeManifestPath, readFileSync(safeManifestPath, "utf8")],
        [humanManifestPath, readFileSync(humanManifestPath, "utf8")],
      ]);
      const manifestMtimes = new Map([
        [safeManifestPath, statSync(safeManifestPath, { bigint: true }).mtimeNs],
        [humanManifestPath, statSync(humanManifestPath, { bigint: true }).mtimeNs],
      ]);
      const leaseBytes = readFileSync(leaseStorePath(repo), "utf8");
      const leaseMtime = statSync(leaseStorePath(repo), { bigint: true }).mtimeNs;
      const directoryEntries = readdirSync(runtimeDir(repo)).sort();
      const leasesBefore = listLeases(repo);
      const safeIdentityBefore = await inspector.capture(safeService.pid);
      const humanIdentityBefore = await inspector.capture(humanService.pid);

      const first = await preflightOrphanedRuntimes(repo);
      const second = await preflightOrphanedRuntimes(repo);

      // Classification is stable and includes both states.
      assert.equal(planOf(first, "runtime-safe").state, "safe_to_reap");
      assert.equal(planOf(first, "runtime-human").state, "needs_human");
      assert.deepEqual(
        second.plans.map((plan) => [plan.runtimeId, plan.state]),
        first.plans.map((plan) => [plan.runtimeId, plan.state]),
      );

      // Nothing on disk was rewritten (not even with identical bytes).
      for (const [path, bytes] of manifestBytes) {
        assert.equal(readFileSync(path, "utf8"), bytes);
        assert.equal(
          statSync(path, { bigint: true }).mtimeNs,
          manifestMtimes.get(path),
        );
      }
      assert.equal(readFileSync(leaseStorePath(repo), "utf8"), leaseBytes);
      assert.equal(
        statSync(leaseStorePath(repo), { bigint: true }).mtimeNs,
        leaseMtime,
      );
      assert.deepEqual(readdirSync(runtimeDir(repo)).sort(), directoryEntries);
      assert.deepEqual(listLeases(repo), leasesBefore);

      // Neither process was signalled; both kept their exact identity.
      assert.equal(inspector.isAlive(safeService.pid), true);
      assert.equal(inspector.isAlive(humanService.pid), true);
      assert.deepEqual(
        await inspector.capture(safeService.pid),
        safeIdentityBefore,
      );
      assert.deepEqual(
        await inspector.capture(humanService.pid),
        humanIdentityBefore,
      );
      assert.equal(
        directoryEntries.includes("reaper.lock"),
        false,
        "preflight must not create the executor lock",
      );
    } finally {
      await stopGroup(safeService.child, safeService.pid);
      await stopGroup(humanService.child, humanService.pid);
    }
  });
});

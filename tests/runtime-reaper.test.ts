import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer, type AddressInfo, type Server } from "node:net";
import { hostname, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { runtimePaths } from "../src/runtime/manager.js";
import { PortAllocator, probePort } from "../src/runtime/ports.js";
import { ProcessInspector } from "../src/runtime/process.js";
import {
  reapOrphanedRuntimes,
  reaperLockPath,
} from "../src/runtime/reaper-execute.js";
import type {
  PortLease,
  RuntimeCleanupState,
  RuntimeManifest,
  RuntimeOwner,
  RuntimeProcessIdentity,
  RuntimeRecoveryState,
} from "../src/runtime/types.js";

const inspector = new ProcessInspector();
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * A pid above every configured OS pid limit: `kill(pid, 0)` always reports
 * ESRCH, so fixtures can simulate a dead owner without racing a real exit.
 */
const DEAD_PID = 999_999_999;

/** Detached service leader with no listeners: it only needs to stay alive. */
const KEEP_ALIVE_SCRIPT = "setInterval(() => {}, 1000);";

/** A leader that refuses SIGTERM so the executor must escalate to SIGKILL. */
const IGNORES_SIGTERM_SCRIPT = String.raw`
process.on("SIGTERM", () => {});
setInterval(() => {}, 1000);
`;

/**
 * Detached leader that spawns one helper into its process group and then exits,
 * leaving a group whose ownership can no longer be proven from the leader.
 */
const GROUP_REMAINS_SCRIPT = String.raw`
const { spawn } = require("node:child_process");
spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
setTimeout(() => process.exit(0), 200);
`;

/** HTTP service used by the real RuntimeManager E2E. */
const HTTP_SERVICE_SCRIPT = String.raw`
const http = require("node:http");
const server = http.createServer((_req, res) => {
  res.statusCode = 200;
  res.end("ok");
});
server.listen(Number(process.env.PORT), "127.0.0.1");
setInterval(() => {}, 1000);
`;

const DEFAULT_EXECUTE_OPTIONS = {
  stopGraceMs: 2_000,
  killGraceMs: 2_000,
  portReleaseTimeoutMs: 5_000,
  lockTimeoutMs: 10_000,
} as const;

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

async function withTempRepo(
  fn: (repo: string, base: string) => Promise<void>,
): Promise<void> {
  const base = mkdtempSync(join(tmpdir(), "cliyard-reaper-exec-"));
  const repo = join(base, "control");
  mkdirSync(repo, { recursive: true });
  try {
    await fn(repo, base);
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

function listenOn(server: Server, port: number): Promise<void> {
  return new Promise((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen({ host: "127.0.0.1", port }, () => {
      server.off("error", rejectListen);
      resolveListen();
    });
  });
}

function closeServer(server: Server): Promise<void> {
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
    leases: PortLease[];
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

function manifestPathOf(repo: string, runtimeId: string): string {
  return runtimePaths(repo, runtimeId).manifestPath;
}

function writeManifest(repo: string, manifest: RuntimeManifest): string {
  const path = manifestPathOf(repo, manifest.runtimeId);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(manifest, null, 2) + "\n", "utf8");
  return path;
}

function readManifest(repo: string, runtimeId: string): RuntimeManifest {
  return JSON.parse(
    readFileSync(manifestPathOf(repo, runtimeId), "utf8"),
  ) as RuntimeManifest;
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

async function stopGroup(child: ChildProcess | undefined, pid: number | undefined): Promise<void> {
  if (pid !== undefined) {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      /* group already gone */
    }
  }
  if (child === undefined) return;
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

async function waitForGroupEmpty(
  pgid: number,
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while ((await inspector.listGroupMembers(pgid)).length > 0) {
    if (Date.now() >= deadline) {
      throw new Error(`process group ${pgid} did not empty in ${timeoutMs}ms`);
    }
    await delay(25);
  }
}

// ---------------------------------------------------------------------------
// Real child-process E2E: SIGKILLed owner, detached RuntimeManager service
// ---------------------------------------------------------------------------

test("reaps a real RuntimeManager service after its owner is SIGKILLed", async () => {
  await withTempRepo(async (repo, base) => {
    const worktree = join(base, "worktree");
    mkdirSync(worktree, { recursive: true });
    const readyPath = join(base, "owner-ready.json");
    const scriptPath = join(base, "owner.mjs");
    const managerUrl = pathToFileURL(
      join(REPO_ROOT, "src/runtime/manager.ts"),
    ).href;

    writeFileSync(
      scriptPath,
      [
        `import { writeFileSync } from "node:fs";`,
        `import { RuntimeManager } from ${JSON.stringify(managerUrl)};`,
        `const [repo, worktree, readyPath] = process.argv.slice(2);`,
        `const manager = new RuntimeManager({`,
        `  repoRoot: repo,`,
        `  worktree,`,
        `  taskId: "task-e2e",`,
        `  attempt: 1,`,
        `  runtimeId: "runtime-e2e",`,
        `});`,
        `await manager.start({ services: [{`,
        `  name: "web",`,
        `  command: [process.execPath, "-e", ${JSON.stringify(HTTP_SERVICE_SCRIPT)}],`,
        `  portEnv: "PORT",`,
        `  readiness: { timeoutMs: 20000 },`,
        `}] });`,
        `writeFileSync(readyPath, JSON.stringify({ pid: process.pid }));`,
        `setInterval(() => {}, 1000);`,
        "",
      ].join("\n"),
      "utf8",
    );

    const { range } = await freshRange(3);
    let stderr = "";
    const owner = spawn(
      process.execPath,
      ["--import", "tsx", scriptPath, repo, worktree, readyPath],
      {
        cwd: REPO_ROOT,
        env: { ...process.env, CLIYARD_PORT_RANGE: range },
        stdio: ["ignore", "ignore", "pipe"],
        windowsHide: true,
      },
    );
    owner.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    let servicePid: number | undefined;
    let servicePgid: number | undefined;
    let leasePort: number | undefined;

    try {
      const deadline = Date.now() + 30_000;
      while (!existsSync(readyPath)) {
        if (owner.exitCode !== null) {
          throw new Error(`owner exited ${owner.exitCode}: ${stderr}`);
        }
        if (Date.now() >= deadline) {
          throw new Error(`owner never became ready: ${stderr}`);
        }
        await delay(50);
      }

      const started = readManifest(repo, "runtime-e2e");
      assert.equal(started.cleanup, "pending");
      assert.ok(started.owner, "manager must persist an owner");
      assert.equal(started.owner.pid, owner.pid);
      assert.equal(started.owner.host, hostname());
      assert.equal(started.services.length, 1);

      const service = started.services[0];
      servicePid = service.pid;
      servicePgid = service.pgid;
      leasePort = service.port;
      assert.ok(servicePid, "service must have a pid");
      assert.equal(servicePgid, servicePid);
      assert.ok(service.processIdentity, "service identity must be persisted");
      assert.equal(service.processIdentity.pid, servicePid);
      assert.equal(service.processIdentity.pgid, servicePid);

      assert.equal(listLeases(repo).length, 1);

      // Kill the supervisor-like owner; the detached service must survive.
      process.kill(owner.pid!, "SIGKILL");
      await once(owner, "exit");
      assert.equal(inspector.isAlive(servicePid), true);

      const report = await reapOrphanedRuntimes(repo, DEFAULT_EXECUTE_OPTIONS);

      assert.equal(report.scanned, 1);
      assert.equal(report.needsHuman.length, 0);
      assert.equal(report.skipped.length, 0);
      assert.equal(report.reaped.length, 1);

      const record = report.reaped[0];
      assert.equal(record.state, "reaped");
      assert.equal(record.reaperPid, process.pid);
      assert.equal(record.reaperHost, hostname());
      assert.equal(record.services.length, 1);
      assert.equal(record.services[0].name, "web");
      assert.equal(record.services[0].pgid, servicePid);
      assert.equal(record.services[0].action, "terminated");
      assert.equal(record.services[0].portReleased, true);

      // The proven group is gone and its port is bindable.
      assert.equal(inspector.isAlive(servicePid), false);
      await waitForGroupEmpty(servicePgid);
      assert.equal(await probePort(leasePort), true);

      // Only the exact lease was released; nothing is left in the store.
      assert.deepEqual(listLeases(repo), []);

      const finalized = readManifest(repo, "runtime-e2e");
      assert.equal(finalized.cleanup, "complete");
      assert.ok(finalized.stoppedAt);
      assert.deepEqual(finalized.recovery, record);
      assert.equal(existsSync(reaperLockPath(repo)), false);
    } finally {
      await stopGroup(undefined, servicePgid ?? servicePid);
      if (owner.exitCode === null) {
        try {
          process.kill(owner.pid!, "SIGKILL");
        } catch {
          /* already gone */
        }
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Escalation
// ---------------------------------------------------------------------------

test("escalates to SIGKILL for a proven group that ignores SIGTERM", async () => {
  await withTempRepo(async (repo) => {
    const service = await spawnService(IGNORES_SIGTERM_SCRIPT);
    try {
      const [lease] = await allocateOrphanLeases(repo, [
        { runtimeId: "runtime-signal", service: "web" },
      ]);
      writeManifest(
        repo,
        makeManifest({
          runtimeId: "runtime-signal",
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

      const report = await reapOrphanedRuntimes(repo, {
        ...DEFAULT_EXECUTE_OPTIONS,
        stopGraceMs: 150,
        killGraceMs: 3_000,
      });

      assert.equal(report.reaped.length, 1);
      assert.equal(report.needsHuman.length, 0);
      assert.equal(report.reaped[0].services[0].action, "terminated");
      assert.equal(report.reaped[0].services[0].portReleased, true);
      assert.equal(inspector.isAlive(service.pid), false);
      assert.deepEqual(listLeases(repo), []);
      assert.equal(readManifest(repo, "runtime-signal").cleanup, "complete");
    } finally {
      await stopGroup(service.child, service.pid);
    }
  });
});

test("reaps a runtime whose leader already exited and whose group is empty", async () => {
  await withTempRepo(async (repo) => {
    const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 150);"], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    await once(child, "spawn");
    const pid = child.pid;
    assert.ok(pid);
    const identity = await inspector.capture(pid);
    assert.ok(identity);
    await once(child, "exit");
    await waitForGroupEmpty(pid);

    const [lease] = await allocateOrphanLeases(repo, [
      { runtimeId: "runtime-exited", service: "web" },
    ]);
    writeManifest(
      repo,
      makeManifest({
        runtimeId: "runtime-exited",
        owner: { pid: DEAD_PID, host: hostname() },
        cleanup: "pending",
        services: [
          {
            name: "web",
            port: lease.port,
            pid,
            pgid: pid,
            identity,
          },
        ],
      }),
    );

    const report = await reapOrphanedRuntimes(repo, DEFAULT_EXECUTE_OPTIONS);

    assert.equal(report.reaped.length, 1);
    assert.equal(report.needsHuman.length, 0);
    assert.equal(report.reaped[0].services[0].action, "already-exited");
    assert.equal(report.reaped[0].services[0].portReleased, true);
    assert.deepEqual(listLeases(repo), []);
    assert.equal(readManifest(repo, "runtime-exited").cleanup, "complete");
  });
});

// ---------------------------------------------------------------------------
// Unsafe evidence: preserve everything
// ---------------------------------------------------------------------------

test("identity mismatch is needs_human and preserves the live group and lease", async () => {
  await withTempRepo(async (repo) => {
    const service = await spawnService();
    try {
      const [lease] = await allocateOrphanLeases(repo, [
        { runtimeId: "runtime-identity", service: "web" },
      ]);
      const path = writeManifest(
        repo,
        makeManifest({
          runtimeId: "runtime-identity",
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
                startedAt: "Mon Jan  1 00:00:00 2001",
              },
            },
          ],
        }),
      );
      const before = readFileSync(path, "utf8");

      const report = await reapOrphanedRuntimes(repo, DEFAULT_EXECUTE_OPTIONS);

      assert.equal(report.reaped.length, 0);
      assert.equal(report.needsHuman.length, 1);
      assert.match(report.needsHuman[0].reason, /identity changed/);
      assert.equal(report.needsHuman[0].services[0].action, "preserved");
      assert.equal(report.needsHuman[0].services[0].portReleased, false);

      assert.equal(inspector.isAlive(service.pid), true);
      assert.deepEqual(await inspector.capture(service.pid), service.identity);
      assert.deepEqual(listLeases(repo), [lease]);
      assert.equal(readFileSync(path, "utf8"), before);
      assert.equal(existsSync(reaperLockPath(repo)), false);
    } finally {
      await stopGroup(service.child, service.pid);
    }
  });
});

test("lease mismatch is needs_human and preserves the live group and lease", async () => {
  await withTempRepo(async (repo) => {
    const service = await spawnService();
    try {
      const [lease] = await allocateOrphanLeases(repo, [
        { runtimeId: "runtime-lease", service: "web" },
      ]);
      const otherPort = lease.port === 65535 ? lease.port - 1 : lease.port + 1;
      const path = writeManifest(
        repo,
        makeManifest({
          runtimeId: "runtime-lease",
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
      const before = readFileSync(path, "utf8");

      const report = await reapOrphanedRuntimes(repo, DEFAULT_EXECUTE_OPTIONS);

      assert.equal(report.reaped.length, 0);
      assert.equal(report.needsHuman.length, 1);
      assert.match(report.needsHuman[0].reason, /no exact port lease/);
      assert.match(report.needsHuman[0].reason, /no matching manifest service/);
      assert.equal(inspector.isAlive(service.pid), true);
      assert.deepEqual(listLeases(repo), [lease]);
      assert.equal(readFileSync(path, "utf8"), before);
    } finally {
      await stopGroup(service.child, service.pid);
    }
  });
});

test("a group that remains after its leader died is needs_human and untouched", async () => {
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
      await once(leader, "exit");
      const members = await waitForGroupMembers(leaderPid, 1);
      assert.ok(members.length > 0, "expected a helper to outlive its leader");

      const [lease] = await allocateOrphanLeases(repo, [
        { runtimeId: "runtime-orphan-group", service: "web" },
      ]);
      const path = writeManifest(
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
      const before = readFileSync(path, "utf8");

      const report = await reapOrphanedRuntimes(repo, DEFAULT_EXECUTE_OPTIONS);

      assert.equal(report.reaped.length, 0);
      assert.equal(report.needsHuman.length, 1);
      assert.match(
        report.needsHuman[0].reason,
        /process group .* still has \d+ member/,
      );
      assert.equal(report.needsHuman[0].services[0].action, "preserved");

      // The helper was never signalled and the lease was never released.
      assert.deepEqual(
        (await inspector.listGroupMembers(leaderPid)).map((member) => member.pid),
        members.map((member) => member.pid),
      );
      assert.deepEqual(listLeases(repo), [lease]);
      assert.equal(readFileSync(path, "utf8"), before);
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
// Skip
// ---------------------------------------------------------------------------

test("skips completed, already-reaped, and foreign-host runtimes without writing", async () => {
  await withTempRepo(async (repo) => {
    const completePath = writeManifest(
      repo,
      makeManifest({
        runtimeId: "runtime-complete",
        owner: { pid: DEAD_PID, host: hostname() },
        cleanup: "complete",
      }),
    );
    const reapedPath = writeManifest(
      repo,
      makeManifest({
        runtimeId: "runtime-reaped",
        owner: { pid: DEAD_PID, host: hostname() },
        cleanup: "failed",
        recoveryState: "reaped",
      }),
    );
    const foreignPath = writeManifest(
      repo,
      makeManifest({
        runtimeId: "runtime-foreign",
        owner: { pid: process.pid, host: `foreign-${hostname()}` },
        cleanup: "pending",
      }),
    );
    const before = new Map(
      [completePath, reapedPath, foreignPath].map((path) => [
        path,
        readFileSync(path, "utf8"),
      ]),
    );

    const report = await reapOrphanedRuntimes(repo, DEFAULT_EXECUTE_OPTIONS);

    assert.equal(report.scanned, 3);
    assert.equal(report.reaped.length, 0);
    assert.equal(report.needsHuman.length, 0);
    assert.deepEqual(
      report.skipped.map((record) => record.state),
      ["skipped", "skipped", "skipped"],
    );

    for (const [path, bytes] of before) {
      assert.equal(readFileSync(path, "utf8"), bytes);
    }
  });
});

// ---------------------------------------------------------------------------
// Cleanup failure
// ---------------------------------------------------------------------------

test("a port held by a foreign listener is needs_human with cleanup failed and the lease preserved", async () => {
  await withTempRepo(async (repo) => {
    const service = await spawnService();
    const foreign = createServer((socket) => socket.destroy());
    try {
      const [lease] = await allocateOrphanLeases(repo, [
        { runtimeId: "runtime-port", service: "web" },
      ]);
      // Occupy the leased port with a listener that is NOT in the service
      // group: termination succeeds, but the port never becomes bindable.
      await listenOn(foreign, lease.port);

      const path = writeManifest(
        repo,
        makeManifest({
          runtimeId: "runtime-port",
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

      const report = await reapOrphanedRuntimes(repo, {
        ...DEFAULT_EXECUTE_OPTIONS,
        portReleaseTimeoutMs: 200,
      });

      assert.equal(report.reaped.length, 0);
      assert.equal(report.needsHuman.length, 1);
      assert.match(report.needsHuman[0].reason, /still not bindable/);
      // The group was stopped, but the lease was preserved because the port
      // never became available.
      assert.equal(report.needsHuman[0].services[0].action, "terminated");
      assert.equal(report.needsHuman[0].services[0].portReleased, false);
      assert.equal(inspector.isAlive(service.pid), false);

      const leases = listLeases(repo);
      assert.equal(leases.length, 1);
      assert.deepEqual(leases[0], lease);

      const manifest = readManifest(repo, "runtime-port");
      assert.equal(manifest.cleanup, "failed");
      assert.equal(manifest.recovery?.state, "needs_human");
      assert.match(manifest.failureReason ?? "", /reaper:/);
      assert.ok(readFileSync(path, "utf8").includes('"failed"'));
    } finally {
      await closeServer(foreign);
      await stopGroup(service.child, service.pid);
    }
  });
});

// ---------------------------------------------------------------------------
// Concurrency
// ---------------------------------------------------------------------------

test("concurrent reapers are serialized by the reaper lock", async () => {
  await withTempRepo(async (repo) => {
    const service = await spawnService();
    try {
      const [lease] = await allocateOrphanLeases(repo, [
        { runtimeId: "runtime-concurrent", service: "web" },
      ]);
      writeManifest(
        repo,
        makeManifest({
          runtimeId: "runtime-concurrent",
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

      const [first, second] = await Promise.all([
        reapOrphanedRuntimes(repo, DEFAULT_EXECUTE_OPTIONS),
        reapOrphanedRuntimes(repo, DEFAULT_EXECUTE_OPTIONS),
      ]);

      const reaped = [...first.reaped, ...second.reaped];
      const skipped = [...first.skipped, ...second.skipped];
      const needsHuman = [...first.needsHuman, ...second.needsHuman];

      assert.equal(reaped.length, 1, "exactly one reaper may reap the runtime");
      assert.equal(needsHuman.length, 0);
      assert.equal(skipped.length, 1, "the second reaper sees a completed runtime");
      assert.equal(skipped[0].state, "skipped");
      assert.match(skipped[0].reason, /cleanup is complete|already reconciled/);

      assert.equal(inspector.isAlive(service.pid), false);
      assert.deepEqual(listLeases(repo), []);

      const manifest = readManifest(repo, "runtime-concurrent");
      assert.equal(manifest.cleanup, "complete");
      assert.equal(manifest.recovery?.state, "reaped");
      assert.equal(existsSync(reaperLockPath(repo)), false);
    } finally {
      await stopGroup(service.child, service.pid);
    }
  });
});

test("clears a stale reaper lock whose owner is dead", async () => {
  await withTempRepo(async (repo) => {
    const service = await spawnService();
    try {
      const [lease] = await allocateOrphanLeases(repo, [
        { runtimeId: "runtime-stale-lock", service: "web" },
      ]);
      writeManifest(
        repo,
        makeManifest({
          runtimeId: "runtime-stale-lock",
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

      const lockPath = reaperLockPath(repo);
      mkdirSync(dirname(lockPath), { recursive: true });
      writeFileSync(
        lockPath,
        JSON.stringify({
          pid: DEAD_PID,
          host: hostname(),
          token: "stale-lock",
          acquiredAt: "2026-10-27T00:00:00.000Z",
        }) + "\n",
        "utf8",
      );

      const report = await reapOrphanedRuntimes(repo, DEFAULT_EXECUTE_OPTIONS);

      assert.equal(report.reaped.length, 1);
      assert.equal(report.needsHuman.length, 0);
      assert.equal(inspector.isAlive(service.pid), false);
      assert.deepEqual(listLeases(repo), []);
      assert.equal(existsSync(lockPath), false);
    } finally {
      await stopGroup(service.child, service.pid);
    }
  });
});

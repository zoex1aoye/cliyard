import { test } from "node:test";
import assert from "node:assert/strict";
import { connect } from "node:net";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import {
  DAEMON_LEASE_META_KEY,
  DaemonLeaseCorruptError,
  DaemonLeaseHeldError,
  createDriverLeaseOps,
  createFileLeaseOps,
  daemonStatePaths,
  openDaemonStore,
  startDaemon,
  type CliyardDaemon,
  type DaemonLeaseRecord,
  type DaemonStoreHandle,
} from "../src/daemon/core.js";
import { runDaemonCli } from "../src/daemon/cli.js";
import {
  StateStore,
  StateStoreClosedError,
  createMemoryStateStoreDriver,
  type StateStoreDriver,
} from "../src/statestore/store.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

async function withRepo(fn: (repo: string) => Promise<void>): Promise<void> {
  const repo = mkdtempSync(join(tmpdir(), "cliyard-daemon-"));
  try {
    await fn(repo);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
}

interface MemoryHandle extends DaemonStoreHandle {
  closed: boolean;
}

/**
 * In-memory store handle for core tests. `closeDriver: false` keeps the
 * driver readable after shutdown so a test can inspect the released lease.
 */
function memoryHandle(
  options: {
    driver?: StateStoreDriver;
    closeDriver?: boolean;
  } = {},
): MemoryHandle {
  const driver = options.driver ?? createMemoryStateStoreDriver();
  const store = StateStore.open(driver);
  const closeDriver = options.closeDriver !== false;
  const handle = {
    store,
    backend: driver.kind,
    storePath: null,
    leases: createDriverLeaseOps(driver, { lockPath: null }),
    closed: false,
    close(): void {
      handle.closed = true;
      if (closeDriver) store.close();
    },
  };
  return handle;
}

function seededLease(
  overrides: Partial<DaemonLeaseRecord> = {},
): DaemonLeaseRecord {
  return {
    version: 1,
    holderId: "seeded-holder",
    pid: 9001,
    host: hostname(),
    repoRoot: "/tmp/seeded",
    startedAt: "2026-01-01T00:00:00.000Z",
    processStartIdentity: "seeded-identity",
    address: { host: "127.0.0.1", port: 45678 },
    ...overrides,
  };
}

function seedLease(
  driver: StateStoreDriver,
  lease: DaemonLeaseRecord,
): void {
  driver.initialize();
  driver.transaction((tx) =>
    tx.setMeta(DAEMON_LEASE_META_KEY, JSON.stringify(lease)),
  );
}

function tcpClose(port: number): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const socket = connect({ host: "127.0.0.1", port });
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`timed out connecting to 127.0.0.1:${port}`));
    }, 2_000);
    socket.once("connect", () => clearTimeout(timer));
    socket.once("close", () => resolvePromise());
    socket.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

function tcpRefused(port: number): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const socket = connect({ host: "127.0.0.1", port });
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`timed out connecting to 127.0.0.1:${port}`));
    }, 2_000);
    socket.once("connect", () => {
      clearTimeout(timer);
      socket.destroy();
      reject(new Error("expected the daemon port to be closed"));
    });
    socket.once("error", () => {
      clearTimeout(timer);
      resolvePromise();
    });
  });
}

function parseLines(lines: string[]): Array<Record<string, unknown>> {
  return lines.map((line) => JSON.parse(line) as Record<string, unknown>);
}

// ---------------------------------------------------------------------------
// Lease exclusion
// ---------------------------------------------------------------------------

test("lease exclusion: a live store-backed lease rejects a second daemon", async () => {
  await withRepo(async (repo) => {
    const driver = createMemoryStateStoreDriver();
    const handle1 = memoryHandle({ driver, closeDriver: false });
    const isAlive = (pid: number): boolean => pid === 1001 || pid === 1003;
    const identity = (pid: number): string => `identity-${pid}`;

    const daemon1 = await startDaemon({
      repoRoot: repo,
      pid: 1001,
      openStore: () => handle1,
      isAlive,
      readStartIdentity: identity,
    });
    try {
      const handle2 = memoryHandle({ driver, closeDriver: false });
      await assert.rejects(
        startDaemon({
          repoRoot: repo,
          pid: 1002,
          openStore: () => handle2,
          isAlive,
          readStartIdentity: identity,
        }),
        DaemonLeaseHeldError,
      );
      assert.equal(handle2.closed, true, "failed start must close its store");
      assert.equal(daemon1.state, "running");

      const held = await handle1.leases.inspect({
        isAlive,
        readStartIdentity: identity,
      });
      assert.equal(held.state, "held");
      assert.equal(held.lease?.pid, 1001);
      assert.equal(held.lease?.address.port, daemon1.info.address.port);
    } finally {
      const result = await daemon1.stop("test");
      assert.equal(result.leaseReleased, true);
      assert.equal(result.storeClosed, true);
      assert.deepEqual(result.errors, []);
    }

    assert.equal(
      (
        await handle1.leases.inspect({
          isAlive,
          readStartIdentity: identity,
        })
      ).state,
      "free",
    );
    assert.equal(handle1.closed, true);

    // Re-acquisition after a clean release is allowed.
    const handle3 = memoryHandle({ driver, closeDriver: false });
    const daemon3 = await startDaemon({
      repoRoot: repo,
      pid: 1003,
      openStore: () => handle3,
      isAlive,
      readStartIdentity: identity,
    });
    assert.ok(daemon3.info.address.port > 0);
    await daemon3.stop("test");
  });
});

test("lease exclusion: stale leases are reclaimed, foreign and corrupt leases fail closed", async () => {
  await withRepo(async (repo) => {
    const staleDriver = createMemoryStateStoreDriver();
    seedLease(staleDriver, seededLease({ pid: 8001 }));
    const staleHandle = memoryHandle({
      driver: staleDriver,
      closeDriver: false,
    });
    const reclaimed = await startDaemon({
      repoRoot: repo,
      pid: 8002,
      openStore: () => staleHandle,
      isAlive: (pid) => pid === 8002,
      readStartIdentity: (pid) => `identity-${pid}`,
    });
    try {
      const held = await staleHandle.leases.inspect({
        isAlive: (pid) => pid === 8002,
        readStartIdentity: (pid) => `identity-${pid}`,
      });
      assert.equal(held.state, "held");
      assert.equal(held.lease?.pid, 8002);
    } finally {
      await reclaimed.stop("test");
    }

    const foreignDriver = createMemoryStateStoreDriver();
    seedLease(
      foreignDriver,
      seededLease({ host: "elsewhere.invalid", pid: 8003 }),
    );
    const foreignHandle = memoryHandle({
      driver: foreignDriver,
      closeDriver: false,
    });
    await assert.rejects(
      startDaemon({
        repoRoot: repo,
        pid: 8004,
        openStore: () => foreignHandle,
        isAlive: () => true,
        readStartIdentity: () => "seeded-identity",
      }),
      (error: unknown) =>
        error instanceof DaemonLeaseHeldError &&
        error.inspection.state === "foreign-host",
    );

    const corruptDriver = createMemoryStateStoreDriver();
    corruptDriver.initialize();
    corruptDriver.transaction((tx) =>
      tx.setMeta(DAEMON_LEASE_META_KEY, "{not-json"),
    );
    const corruptHandle = memoryHandle({
      driver: corruptDriver,
      closeDriver: false,
    });
    await assert.rejects(
      startDaemon({
        repoRoot: repo,
        pid: 8005,
        openStore: () => corruptHandle,
      }),
      DaemonLeaseCorruptError,
    );
  });
});

test("lease record: a repository path longer than 128 characters is accepted", async () => {
  await withRepo(async (repo) => {
    let deep = repo;
    while (deep.length <= 128) deep = join(deep, "nested-segment-0123456789");
    mkdirSync(deep, { recursive: true });
    assert.ok(deep.length > 128, "fixture path must exceed the old cap");

    const handle = memoryHandle();
    const daemon = await startDaemon({
      repoRoot: deep,
      pid: 4001,
      openStore: () => handle,
      isAlive: (pid) => pid === 4001,
      readStartIdentity: (pid) => `identity-${pid}`,
    });
    try {
      assert.equal(daemon.info.repoRoot, deep);
      const held = await handle.leases.inspect({
        isAlive: (pid) => pid === 4001,
        readStartIdentity: (pid) => `identity-${pid}`,
      });
      assert.equal(held.state, "held");
      assert.equal(held.lease?.repoRoot, deep);
    } finally {
      const result = await daemon.stop("test");
      assert.equal(result.leaseReleased, true);
    }
  });
});

// ---------------------------------------------------------------------------
// Address reporting
// ---------------------------------------------------------------------------

test("address reporting: binds 127.0.0.1 on an ephemeral port and accepts TCP", async () => {
  await withRepo(async (repo) => {
    const handle = memoryHandle();
    const daemon = await startDaemon({
      repoRoot: repo,
      pid: 1234,
      openStore: () => handle,
      isAlive: (pid) => pid === 1234,
      readStartIdentity: (pid) => `identity-${pid}`,
    });
    try {
      assert.equal(daemon.info.pid, 1234);
      assert.equal(daemon.address.host, "127.0.0.1");
      assert.ok(Number.isInteger(daemon.address.port));
      assert.ok(daemon.address.port > 0 && daemon.address.port <= 65535);
      assert.equal(
        daemon.info.addressText,
        `127.0.0.1:${daemon.address.port}`,
      );
      // A real client reaches the bound socket; P2a closes it with no reply.
      await tcpClose(daemon.address.port);
    } finally {
      await daemon.stop("test");
    }
    await tcpRefused(daemon.address.port);
  });
});

// ---------------------------------------------------------------------------
// Graceful shutdown
// ---------------------------------------------------------------------------

test(
  "graceful shutdown: releases the lease, closes the store and is idempotent",
  { timeout: 10_000 },
  async () => {
  await withRepo(async (repo) => {
    const handle = memoryHandle({ closeDriver: false });
    const daemon = await startDaemon({
      repoRoot: repo,
      pid: 2001,
      openStore: () => handle,
      isAlive: (pid) => pid === 2001,
      readStartIdentity: (pid) => `identity-${pid}`,
    });
    const port = daemon.address.port;

    // This client reads the server's FIN but never sends its own. It must
    // not be able to hold the lease hostage during shutdown.
    const linger = connect({
      host: "127.0.0.1",
      port,
      allowHalfOpen: true,
    });
    const lingerEnded = new Promise<void>((resolvePromise) => {
      linger.once("end", () => resolvePromise());
    });
    await new Promise<void>((resolvePromise, reject) => {
      linger.once("connect", () => resolvePromise());
      linger.once("error", reject);
    });
    await lingerEnded;

    const result = await daemon.stop("SIGTERM");
    linger.destroy();
    assert.deepEqual(result, {
      pid: 2001,
      address: { host: "127.0.0.1", port },
      reason: "SIGTERM",
      leaseReleased: true,
      storeClosed: true,
      errors: [],
    });
    assert.equal(daemon.state, "stopped");
    assert.equal(handle.closed, true);
    assert.equal(
      (
        await handle.leases.inspect({
          isAlive: (pid) => pid === 2001,
          readStartIdentity: (pid) => `identity-${pid}`,
        })
      ).state,
      "free",
    );
    assert.deepEqual(await daemon.waitForStop(), result);
    assert.deepEqual(await daemon.stop("again"), result);
    await tcpRefused(port);

    // The real handle closes the StateStore, so post-handoff use fails loudly.
    const closingHandle = memoryHandle();
    const closingDaemon = await startDaemon({
      repoRoot: repo,
      pid: 2002,
      openStore: () => closingHandle,
      isAlive: (pid) => pid === 2002,
      readStartIdentity: (pid) => `identity-${pid}`,
    });
    await closingDaemon.stop("test");
    assert.throws(
      () => closingHandle.store.snapshot(),
      StateStoreClosedError,
    );
  });
});

// ---------------------------------------------------------------------------
// CLI: start / status / stop and SIGTERM
// ---------------------------------------------------------------------------

test("daemon CLI prints the bound address and shuts down on SIGTERM", async () => {
  await withRepo(async (repo) => {
    const handle = memoryHandle({ closeDriver: false });
    const logs: string[] = [];
    const errors: string[] = [];
    // `daemon start` records the real process pid; this test process is the
    // daemon.
    const isAlive = (pid: number): boolean => pid === process.pid;
    const identity = (pid: number): string => `identity-${pid}`;

    const code = await runDaemonCli(["start", "--repo", repo], {
      log: (line) => logs.push(line),
      error: (line) => errors.push(line),
      openStore: () => handle,
      isAlive,
      readStartIdentity: identity,
      onStarted: async () => {
        // Simulates the OS delivering SIGTERM to the daemon process.
        (process as unknown as { emit: (event: string) => boolean }).emit(
          "SIGTERM",
        );
      },
    });

    assert.deepEqual(errors, []);
    assert.equal(code, 0);
    const events = parseLines(logs);
    assert.equal(events[0]?.event, "listening");
    assert.equal(events[0]?.pid, process.pid);
    assert.equal(events[0]?.host, "127.0.0.1");
    assert.ok((events[0]?.port as number) > 0);
    assert.equal(
      events[0]?.address,
      `127.0.0.1:${events[0]?.port as number}`,
    );
    assert.equal(events[1]?.event, "stopped");
    assert.equal(events[1]?.reason, "SIGTERM");
    assert.equal(events[1]?.leaseReleased, true);
    assert.equal(events[1]?.storeClosed, true);
    assert.equal(handle.closed, true);
    assert.equal(
      (await handle.leases.inspect({ isAlive, readStartIdentity: identity }))
        .state,
      "free",
    );
  });
});

test("daemon CLI status and stop operate on the live store-backed lease", async () => {
  await withRepo(async (repo) => {
    const handle = memoryHandle({ closeDriver: false });
    const isAlive = (pid: number): boolean => pid === 3002;
    const identity = (pid: number): string => `identity-${pid}`;
    const daemon: CliyardDaemon = await startDaemon({
      repoRoot: repo,
      pid: 3002,
      openStore: () => handle,
      isAlive,
      readStartIdentity: identity,
    });

    try {
      const statusLogs: string[] = [];
      const statusCode = await runDaemonCli(
        ["status", "--repo", repo, "--json"],
        {
          log: (line) => statusLogs.push(line),
          openLeaseOps: () => handle.leases,
          isAlive,
          readStartIdentity: identity,
        },
      );
      assert.equal(statusCode, 0);
      const status = JSON.parse(statusLogs.join("\n")) as Record<
        string,
        unknown
      >;
      assert.equal(status.state, "held");
      assert.equal(status.pid, 3002);
      assert.equal(status.address, daemon.info.addressText);
      assert.equal(status.holderId, daemon.info.holderId);

      const stopLogs: string[] = [];
      const stopErrors: string[] = [];
      const stopCode = await runDaemonCli(
        ["stop", "--repo", repo, "--json", "--timeout", "2000"],
        {
          log: (line) => stopLogs.push(line),
          error: (line) => stopErrors.push(line),
          openLeaseOps: () => handle.leases,
          isAlive,
          readStartIdentity: identity,
          sendSignal: (pid, signal) => {
            assert.equal(pid, 3002);
            assert.equal(signal, "SIGTERM");
            void daemon.stop(signal);
          },
        },
      );
      assert.deepEqual(stopErrors, []);
      assert.equal(stopCode, 0);
      const stopped = JSON.parse(stopLogs.join("\n")) as Record<
        string,
        unknown
      >;
      assert.equal(stopped.state, "stopped");
      assert.equal(stopped.pid, 3002);

      const afterLogs: string[] = [];
      assert.equal(
        await runDaemonCli(["status", "--repo", repo, "--json"], {
          log: (line) => afterLogs.push(line),
          openLeaseOps: () => handle.leases,
          isAlive,
          readStartIdentity: identity,
        }),
        0,
      );
      const after = JSON.parse(afterLogs.join("\n")) as Record<
        string,
        unknown
      >;
      assert.equal(after.state, "free");
    } finally {
      if (daemon.state !== "stopped") await daemon.stop("test");
    }
  });
});

test("daemon CLI stop refuses an unverified pid identity", async () => {
  await withRepo(async (repo) => {
    const handle = memoryHandle({ closeDriver: false });
    const daemon = await startDaemon({
      repoRoot: repo,
      pid: 3003,
      openStore: () => handle,
      isAlive: () => true,
      // No OS identity available: the lease records null.
      readStartIdentity: () => null,
    });
    try {
      const logs: string[] = [];
      const errors: string[] = [];
      const code = await runDaemonCli(["stop", "--repo", repo], {
        log: (line) => logs.push(line),
        error: (line) => errors.push(line),
        openLeaseOps: () => handle.leases,
        isAlive: () => true,
        readStartIdentity: () => null,
        sendSignal: () => {
          throw new Error("must not signal an unverified pid");
        },
      });
      assert.equal(code, 1);
      assert.match(errors.join("\n"), /verified OS process start identity/);
      assert.equal(daemon.state, "running");
    } finally {
      await daemon.stop("test");
    }
  });
});

test("daemon CLI status on a repository without a StateStore reports stopped", async () => {
  await withRepo(async (repo) => {
    const logs: string[] = [];
    const code = await runDaemonCli(["status", "--repo", repo, "--json"], {
      log: (line) => logs.push(line),
    });
    assert.equal(code, 0);
    const payload = JSON.parse(logs.join("\n")) as Record<string, unknown>;
    assert.equal(payload.event, "status");
    assert.equal(payload.state, "free");
    assert.equal(payload.pid, null);
    assert.equal(payload.storePath, null);
    assert.equal(existsSync(daemonStatePaths(repo).factsPath), false);
    assert.equal(existsSync(daemonStatePaths(repo).sqlitePath), false);
  });
});

// ---------------------------------------------------------------------------
// Store handoff and read-only discipline
// ---------------------------------------------------------------------------

test("store handoff: a file-backed daemon releases the lease and leaves facts untouched", async () => {
  await withRepo(async (repo) => {
    const seeded = openDaemonStore(repo);
    seeded.store.append(
      {
        kind: "attempt.started",
        attemptId: "attempt-1",
        payload: {
          backendType: "process-group",
          runtimeHandle: "handle-1",
          workspaceId: "workspace-1",
          desiredState: "stopped",
          leaseDeadline: null,
        },
      },
      { at: "2026-01-01T00:00:00.000Z", eventId: "seed-event-1" },
    );
    seeded.store.append(
      {
        kind: "attempt.observed-state-changed",
        attemptId: "attempt-1",
        payload: { observedState: "exited" },
      },
      { at: "2026-01-01T00:00:01.000Z", eventId: "seed-event-2" },
    );
    const factsBefore = seeded.store.exportFacts();
    const attemptsBefore = seeded.store.snapshot().attempts;
    const evidenceBefore = seeded.store.snapshot().evidence;
    seeded.close();

    const isAlive = (pid: number): boolean => pid === 2001 || pid === 2002;
    const identity = (pid: number): string => `identity-${pid}`;
    const daemon = await startDaemon({
      repoRoot: repo,
      pid: 2001,
      isAlive,
      readStartIdentity: identity,
    });
    try {
      assert.equal(daemon.info.backend, "json-file");
      assert.ok(daemon.info.storePath?.endsWith("facts.json"));
      assert.equal(existsSync(daemonStatePaths(repo).factsPath), true);
      assert.deepEqual(daemon.store.snapshot().attempts, attemptsBefore);

      // A second file-backed daemon (fresh driver, fresh connection) is
      // excluded by the lease record, not by an in-process object.
      await assert.rejects(
        startDaemon({
          repoRoot: repo,
          pid: 2002,
          isAlive,
          readStartIdentity: identity,
        }),
        DaemonLeaseHeldError,
      );

      const held = await createFileLeaseOps(
        daemonStatePaths(repo),
      ).inspect({ isAlive, readStartIdentity: identity });
      assert.equal(held.state, "held");
      assert.equal(held.lease?.pid, 2001);
      assert.equal(held.lease?.address.port, daemon.info.address.port);
    } finally {
      const stopped = await daemon.stop("test");
      assert.equal(stopped.leaseReleased, true);
      assert.equal(stopped.storeClosed, true);
      assert.deepEqual(stopped.errors, []);
    }

    const reopened = openDaemonStore(repo);
    try {
      assert.deepEqual(reopened.store.exportFacts(), factsBefore);
      assert.deepEqual(reopened.store.snapshot().evidence, evidenceBefore);
      const free = await createFileLeaseOps(
        daemonStatePaths(repo),
      ).inspect({ isAlive: () => false });
      assert.equal(free.state, "free");
    } finally {
      reopened.close();
    }
  });
});

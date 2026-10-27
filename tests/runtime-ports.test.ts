import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { takeTestPortRange } from "./test-port-ranges.js";
import {
  NoAvailablePortError,
  PortAllocator,
  PortAllocatorError,
  PortLeaseLockError,
  PortLeaseStoreError,
  PortRangeError,
  portAllocatorPaths,
  portLeaseKey,
  probePort,
} from "../src/runtime/ports.js";
import type { PortLease, PortLeaseStore } from "../src/runtime/types.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const PORTS_MODULE = fileURLToPath(
  new URL("../src/runtime/ports.ts", import.meta.url),
);

const CHILD_SOURCE = `
import { PortAllocator } from ${JSON.stringify(PORTS_MODULE)};

const [repoRoot, range, runId, service, mode] = process.argv.slice(2);
const allocator = new PortAllocator({ repoRoot, range });
const lease = await allocator.allocate(runId, service);
process.stdout.write(JSON.stringify(lease) + "\\n");
if (mode === "hold") {
  // Keep the lease owner alive until the parent terminates this process.
  setInterval(() => {}, 1000);
}
`;

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

interface AllocatorChild {
  child: ChildProcess;
  lease: Promise<PortLease>;
  stop(): Promise<void>;
}

async function withRepo(fn: (repo: string) => Promise<void>): Promise<void> {
  const repo = mkdtempSync(join(tmpdir(), "cliyard-runtime-ports-"));
  try {
    await fn(repo);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
}

function writeChildScript(repo: string): string {
  const path = join(repo, "allocator-child.mts");
  if (!existsSync(path)) writeFileSync(path, CHILD_SOURCE, "utf8");
  return path;
}

function readFirstLine(
  child: ChildProcess,
  stderr: () => string,
): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    let buffer = "";
    let settled = false;
    let timer: NodeJS.Timeout | undefined;

    const finish = (error: Error | null, line?: string): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      child.stdout?.off("data", onData);
      child.off("exit", onExit);
      child.off("error", onError);
      if (error) reject(error);
      else resolvePromise(line!);
    };
    const onData = (chunk: Buffer | string): void => {
      buffer += String(chunk);
      const newline = buffer.indexOf("\n");
      if (newline >= 0) finish(null, buffer.slice(0, newline));
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      finish(
        new Error(
          `allocator child exited (code ${code}, signal ${signal}) ` +
            `before printing a lease${stderr() ? `: ${stderr()}` : ""}`,
        ),
      );
    };
    const onError = (error: Error) => finish(error);

    timer = setTimeout(() => {
      finish(
        new Error(
          `timed out waiting for allocator child` +
            (stderr() ? `: ${stderr()}` : ""),
        ),
      );
    }, 20_000);
    child.stdout?.on("data", onData);
    child.once("exit", onExit);
    child.once("error", onError);
  });
}

function startAllocatorChild(
  repo: string,
  range: string,
  runId: string,
  service: string,
  hold: boolean,
): AllocatorChild {
  const script = writeChildScript(repo);
  const child = spawn(
    process.execPath,
    [
      "--import",
      "tsx",
      script,
      repo,
      range,
      runId,
      service,
      hold ? "hold" : "once",
    ],
    {
      cwd: ROOT,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let stderr = "";
  child.stderr?.on("data", (chunk) => {
    stderr += String(chunk);
  });

  const lease = readFirstLine(child, () => stderr).then(
    (line) => JSON.parse(line) as PortLease,
  );
  // Cleanup after a failed assertion must not surface as an unhandled rejection.
  lease.catch(() => {});

  return {
    child,
    lease,
    async stop() {
      if (child.exitCode !== null || child.signalCode !== null) return;
      child.kill("SIGTERM");
      await new Promise<void>((resolvePromise) => {
        child.once("exit", () => resolvePromise());
      });
    },
  };
}

function readStore(repo: string): PortLeaseStore {
  return JSON.parse(
    readFileSync(portAllocatorPaths(repo).storePath, "utf8"),
  ) as PortLeaseStore;
}

function listenOn(server: Server, port: number): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen({ host: "127.0.0.1", port }, () => {
      server.off("error", reject);
      resolvePromise();
    });
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    server.close((error) => (error ? reject(error) : resolvePromise()));
  });
}

/** A pid that has exited and been reaped. */
async function exitedPid(): Promise<number> {
  const child = spawn(process.execPath, ["-e", "process.exit(0)"], {
    stdio: "ignore",
  });
  assert.ok(child.pid);
  await new Promise<void>((resolvePromise) => {
    child.once("exit", () => resolvePromise());
  });
  return child.pid;
}

// ---------------------------------------------------------------------------
// Allocation, persistence, reuse
// ---------------------------------------------------------------------------

test("allocate persists a lease and reuses it for the same live runId+service", async () => {
  await withRepo(async (repo) => {
    const { range, start, end } = takeTestPortRange("runtime-ports", 6);
    const allocator = new PortAllocator({ repoRoot: repo, range });

    const web = await allocator.allocate("run-1", "web");
    assert.equal(web.key, "run-1:web");
    assert.equal(web.runId, "run-1");
    assert.equal(web.service, "web");
    assert.equal(web.host, "127.0.0.1");
    assert.equal(web.pid, process.pid);
    assert.ok(web.port >= start && web.port <= end);
    assert.ok(!Number.isNaN(Date.parse(web.acquiredAt)));

    const { storePath, lockPath, runtimeDir } = portAllocatorPaths(repo);
    assert.ok(storePath.endsWith(join(".cliyard", "runtime", "port-leases.json")));
    assert.ok(existsSync(storePath));
    const disk = readStore(repo);
    assert.equal(disk.version, 1);
    assert.deepEqual(disk.leases, [web]);

    const api = await allocator.allocate("run-1", "api");
    assert.notEqual(api.port, web.port);
    assert.deepEqual(
      allocator.list().map((lease) => lease.port),
      [web.port, api.port].sort((a, b) => a - b),
    );

    const reused = await allocator.allocate("run-1", "web");
    assert.deepEqual(reused, web);
    assert.equal(readStore(repo).leases.length, 2);

    // The cross-process lock must not leak after successful mutations.
    assert.equal(existsSync(lockPath), false);
    assert.deepEqual(
      readdirSync(runtimeDir).filter((name) => name.endsWith(".tmp")),
      [],
    );
  });
});

test("release is idempotent, removes only the exact lease, and frees the port", async () => {
  await withRepo(async (repo) => {
    const { range, start: port } = takeTestPortRange("runtime-ports", 1);
    const allocator = new PortAllocator({ repoRoot: repo, range });

    const first = await allocator.allocate("run-a", "web");
    assert.equal(first.port, port);
    await assert.rejects(
      allocator.allocate("run-b", "web"),
      NoAvailablePortError,
    );

    // Same key, different reservation: must not remove the live lease.
    const forged: PortLease = {
      ...first,
      acquiredAt: new Date(0).toISOString(),
    };
    assert.equal(await allocator.release(forged), false);
    assert.deepEqual(allocator.list(), [first]);

    assert.equal(await allocator.release(first), true);
    assert.equal(await allocator.release(first), false);
    assert.deepEqual(allocator.list(), []);

    // The released port is reusable, and an old handle cannot remove it.
    const second = await allocator.allocate("run-b", "web");
    assert.equal(second.port, port);
    assert.equal(await allocator.release(first), false);
    assert.deepEqual(allocator.list(), [second]);
  });
});

test("CLIYARD_PORT_RANGE selects the range and explicit options win", async () => {
  await withRepo(async (repo) => {
    const defaults = new PortAllocator({ repoRoot: repo, env: {} });
    assert.deepEqual(defaults.range, { start: 19000, end: 19999 });

    const { range, start, end } = takeTestPortRange("runtime-ports", 4);
    const fromEnv = new PortAllocator({
      repoRoot: repo,
      env: { CLIYARD_PORT_RANGE: range },
    });
    assert.deepEqual(fromEnv.range, { start, end });
    const lease = await fromEnv.allocate("env-run", "web");
    assert.ok(lease.port >= start && lease.port <= end);

    const explicit = new PortAllocator({
      repoRoot: repo,
      range: `${start}-${start}`,
      env: { CLIYARD_PORT_RANGE: range },
    });
    assert.deepEqual(explicit.range, { start, end: start });

    for (const invalid of ["nope", "200-100", "0-10", "70000-70010", ""]) {
      assert.throws(
        () =>
          new PortAllocator({
            repoRoot: repo,
            env: { CLIYARD_PORT_RANGE: invalid },
          }),
        PortRangeError,
        `expected ${JSON.stringify(invalid)} to be rejected`,
      );
    }
  });
});

test("lease identities reject unsafe runId and service names", () => {
  assert.equal(portLeaseKey("run-1", "web"), "run-1:web");
  for (const [runId, service] of [
    ["run:1", "web"],
    ["run-1", "../web"],
    ["", "web"],
    ["run-1", "web/api"],
  ] as const) {
    assert.throws(() => portLeaseKey(runId, service), PortAllocatorError);
  }
});

// ---------------------------------------------------------------------------
// Cross-process behavior
// ---------------------------------------------------------------------------

test("separate live processes never lease the same port", async () => {
  await withRepo(async (repo) => {
    const { range, start, end } = takeTestPortRange("runtime-ports", 8);
    const ids = ["p0", "p1", "p2", "p3"];
    const children = ids.map((id) =>
      startAllocatorChild(repo, range, `run-${id}`, "web", true),
    );
    try {
      const leases = await Promise.all(children.map((entry) => entry.lease));
      const ports = leases.map((lease) => lease.port);
      assert.equal(
        new Set(ports).size,
        leases.length,
        `duplicate live port: ${ports.join(", ")}`,
      );
      for (const lease of leases) {
        assert.ok(
          lease.port >= start && lease.port <= end,
          `port ${lease.port} outside ${range}`,
        );
      }

      const store = readStore(repo);
      assert.equal(store.leases.length, ids.length);
      assert.equal(new Set(store.leases.map((lease) => lease.port)).size, ids.length);
      assert.deepEqual(
        store.leases.map((lease) => lease.key).sort(),
        ids.map((id) => `run-${id}:web`).sort(),
      );
      // Every owner is still alive, so none of the leases was reclaimed.
      assert.equal(
        new Set(store.leases.map((lease) => lease.pid)).size,
        ids.length,
      );
    } finally {
      await Promise.all(children.map((entry) => entry.stop()));
    }
  });
});

test("a second process reuses the same live lease while its owner is alive", async () => {
  await withRepo(async (repo) => {
    const { range, start, end } = takeTestPortRange("runtime-ports", 4);
    const holder = startAllocatorChild(repo, range, "run-shared", "web", true);
    try {
      const lease = await holder.lease;
      assert.ok(lease.port >= start && lease.port <= end);

      const allocator = new PortAllocator({ repoRoot: repo, range });
      const reused = await allocator.allocate("run-shared", "web");
      assert.deepEqual(reused, lease);
      assert.equal(readStore(repo).leases.length, 1);
    } finally {
      await holder.stop();
    }
  });
});

test("a dead owner's lease is reclaimed on this host", async () => {
  await withRepo(async (repo) => {
    const { range, start: port } = takeTestPortRange("runtime-ports", 1);
    const holder = startAllocatorChild(repo, range, "dead-run", "web", false);
    let childLease: PortLease;
    try {
      childLease = await holder.lease;
      assert.equal(childLease.port, port);
      assert.notEqual(childLease.pid, process.pid);
    } finally {
      await holder.stop();
    }
    assert.equal(readStore(repo).leases[0]?.pid, childLease.pid);

    const allocator = new PortAllocator({ repoRoot: repo, range });
    const reclaimed = await allocator.allocate("live-run", "web");
    assert.equal(reclaimed.port, port);
    assert.equal(reclaimed.pid, process.pid);
    assert.deepEqual(allocator.list(), [reclaimed]);

    // The dead key itself is also leasable again under a live owner.
    assert.equal(await allocator.release(reclaimed), true);
    const reacquired = await allocator.allocate("dead-run", "web");
    assert.equal(reacquired.port, port);
    assert.equal(reacquired.pid, process.pid);
  });
});

test("a separate process skips an occupied port", async () => {
  await withRepo(async (repo) => {
    const { range, start, end } = takeTestPortRange("runtime-ports", 5);
    const server = createServer();
    await listenOn(server, start);
    try {
      assert.equal(await probePort(start), false);
      const child = startAllocatorChild(repo, range, "run-occupied", "web", false);
      try {
        const lease = await child.lease;
        assert.notEqual(lease.port, start, "leased an occupied port");
        assert.ok(lease.port > start && lease.port <= end);
        assert.equal(readStore(repo).leases[0]?.port, lease.port);
      } finally {
        await child.stop();
      }
    } finally {
      await closeServer(server);
    }
  });
});

// ---------------------------------------------------------------------------
// Cross-process lock
// ---------------------------------------------------------------------------

test("a dead-owner lock is reclaimed, a live-owner lock blocks", async () => {
  await withRepo(async (repo) => {
    const { range } = takeTestPortRange("runtime-ports", 3);
    const { lockPath, runtimeDir } = portAllocatorPaths(repo);
    mkdirSync(runtimeDir, { recursive: true });

    const staleLock =
      JSON.stringify({
        pid: await exitedPid(),
        host: hostname(),
        token: "stale-token",
        acquiredAt: new Date().toISOString(),
      }) + "\n";
    writeFileSync(lockPath, staleLock, "utf8");

    const allocator = new PortAllocator({ repoRoot: repo, range });
    const lease = await allocator.allocate("run-lock", "web");
    assert.equal(await allocator.release(lease), true);
    assert.equal(existsSync(lockPath), false);

    const liveLock =
      JSON.stringify({
        pid: process.pid,
        host: hostname(),
        token: "live-token",
        acquiredAt: new Date().toISOString(),
      }) + "\n";
    writeFileSync(lockPath, liveLock, "utf8");
    const blocked = new PortAllocator({
      repoRoot: repo,
      range,
      lockTimeoutMs: 200,
    });
    await assert.rejects(
      blocked.allocate("run-blocked", "web"),
      PortLeaseLockError,
    );
    assert.equal(readFileSync(lockPath, "utf8"), liveLock);
    unlinkSync(lockPath);
  });
});

// ---------------------------------------------------------------------------
// Durability failures
// ---------------------------------------------------------------------------

test("a corrupt lease store is reported and never overwritten", async () => {
  await withRepo(async (repo) => {
    const { storePath, runtimeDir } = portAllocatorPaths(repo);
    mkdirSync(runtimeDir, { recursive: true });
    const corrupt = "{not json\n";
    writeFileSync(storePath, corrupt, "utf8");

    const { range } = takeTestPortRange("runtime-ports", 2);
    const allocator = new PortAllocator({ repoRoot: repo, range });
    await assert.rejects(
      allocator.allocate("run-x", "web"),
      PortLeaseStoreError,
    );
    assert.equal(readFileSync(storePath, "utf8"), corrupt);
    assert.equal(existsSync(join(runtimeDir, "port-leases.lock")), false);
  });
});

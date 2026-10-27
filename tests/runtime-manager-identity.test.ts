import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer, type AddressInfo, type Server } from "node:net";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { PortAllocator } from "../src/runtime/ports.js";
import { ProcessInspector } from "../src/runtime/process.js";
import {
  RuntimeManager,
  RuntimeStartError,
  runtimePaths,
} from "../src/runtime/manager.js";
import type { RuntimeManifest } from "../src/runtime/types.js";

const inspector = new ProcessInspector();

/**
 * `ps lstart` in the C locale/UTC, e.g. "Tue Oct 27 12:34:56 2026". This is
 * OS-reported identity, not the ISO wall-clock timestamp in `startedAt`.
 */
const PS_LSTART_PATTERN =
  /^[A-Z][a-z]{2} [A-Z][a-z]{2} \d{1,2} \d{2}:\d{2}:\d{2} \d{4}$/;

const FIXTURE_SERVER_SOURCE = String.raw`
import { existsSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";

const port = Number(process.env.PORT);
const status = Number(process.env.FIXTURE_STATUS || "200");
const name = process.env.FIXTURE_NAME || "fixture";

// Deterministic stand-in for an allocator/child bind race: fail the first
// spawn only, leaving a marker so the retry can succeed.
const addressInUse = process.env.FIXTURE_EADDRINUSE;
if (addressInUse) {
  const marker = process.env.FIXTURE_MARKER || "";
  if (addressInUse === "always" || (marker && !existsSync(marker))) {
    if (marker) writeFileSync(marker, "tried\n", "utf8");
    process.stderr.write(
      "Error: listen EADDRINUSE: address already in use 127.0.0.1:" + port + "\n",
    );
    process.exit(1);
  }
}

const server = createServer((req, res) => {
  console.log(name + " " + req.method + " " + req.url);
  if (req.url === "/health") {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: status === 200, name }));
    return;
  }
  res.writeHead(200, { "content-type": "text/plain" });
  res.end("hello from " + name);
});

server.listen(port, "127.0.0.1", () => {
  console.log(name + " listening on " + port);
});
`;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function withTempBase(
  fn: (base: string) => Promise<void>,
): Promise<void> {
  const base = mkdtempSync(join(tmpdir(), "cliyard-runtime-identity-"));
  try {
    await fn(base);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
}

function makeRepo(base: string): string {
  const repo = join(base, "control");
  mkdirSync(repo, { recursive: true });
  return repo;
}

function makeWorktree(base: string): string {
  const worktree = join(base, "task-worktree");
  mkdirSync(worktree, { recursive: true });
  return worktree;
}

function writeScript(dir: string, filename: string, source: string): string {
  const path = join(dir, filename);
  writeFileSync(path, source, "utf8");
  return path;
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

function readManifest(path: string): RuntimeManifest {
  return JSON.parse(readFileSync(path, "utf8")) as RuntimeManifest;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

async function waitForManifest(
  path: string,
  predicate: (manifest: RuntimeManifest) => boolean,
  timeoutMs = 5_000,
): Promise<RuntimeManifest> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const manifest = readManifest(path);
      if (predicate(manifest)) return manifest;
    } catch {
      /* not persisted yet */
    }
    if (Date.now() >= deadline) {
      throw new Error(`manifest condition not met within ${timeoutMs}ms: ${path}`);
    }
    await delay(20);
  }
}

function baseManagerOptions(repo: string, worktree: string) {
  return {
    repoRoot: repo,
    worktree,
    taskId: "task-identity",
    attempt: 1,
    env: { ...process.env },
    readinessPollMs: 25,
    stopGraceMs: 2_000,
    portReleaseTimeoutMs: 3_000,
  } as const;
}

function serviceOf(
  manifest: RuntimeManifest,
  name: string,
): RuntimeManifest["services"][number] {
  const service = manifest.services.find((entry) => entry.name === name);
  assert.ok(service, `missing service ${name}`);
  return service;
}

// ---------------------------------------------------------------------------
// Persisted identity before and after stop
// ---------------------------------------------------------------------------

test("persists owner, pid==pgid, and exact OS identity, then retains it after stop", async () => {
  await withTempBase(async (base) => {
    const repo = makeRepo(base);
    const worktree = makeWorktree(base);
    const script = writeScript(
      worktree,
      "fixture-server.mjs",
      FIXTURE_SERVER_SOURCE,
    );
    const { range } = await freshRange(4);
    const allocator = new PortAllocator({ repoRoot: repo, range });
    const manager = new RuntimeManager({
      ...baseManagerOptions(repo, worktree),
      runtimeId: "task-identity-attempt-1",
      allocator,
    });

    const session = await manager.start({
      services: [
        {
          name: "web",
          command: [process.execPath, script],
          readiness: { path: "/health", timeoutMs: 5_000 },
        },
      ],
    });

    let before: RuntimeManifest;
    let pid = 0;
    let identity: RuntimeManifest["services"][number]["processIdentity"];
    try {
      before = readManifest(session.manifestPath);
      assert.equal(before.version, 1);
      assert.equal(before.cleanup, "pending");
      assert.deepEqual(before.owner, { pid: process.pid, host: hostname() });

      const service = serviceOf(before, "web");
      assert.equal(typeof service.pid, "number");
      // Detached services lead their own process group.
      assert.equal(service.pgid, service.pid);
      pid = service.pid!;

      identity = service.processIdentity;
      assert.ok(identity, "spawn identity should be persisted before stop");
      assert.equal(identity.pid, pid);
      assert.equal(identity.pgid, pid);
      assert.match(identity.startedAt, PS_LSTART_PATTERN);

      // The OS start identity is not the wall-clock bookkeeping timestamp.
      assert.ok(service.startedAt);
      assert.notEqual(identity.startedAt, service.startedAt);

      // An independent capture of the live leader matches exactly.
      assert.deepEqual(identity, await inspector.capture(pid));
    } finally {
      await session.stop();
    }

    const stopped = await session.stop();
    assert.equal(stopped.cleanup, "complete");

    const after = readManifest(session.manifestPath);
    assert.equal(after.cleanup, "complete");
    assert.ok(after.stoppedAt);
    assert.deepEqual(after.owner, before.owner);
    const serviceAfter = serviceOf(after, "web");
    assert.equal(serviceAfter.pid, pid);
    assert.equal(serviceAfter.pgid, pid);
    assert.deepEqual(serviceAfter.processIdentity, identity);
    assert.ok(serviceAfter.exitedAt);
    assert.equal(inspector.isAlive(pid), false);
  });
});

// ---------------------------------------------------------------------------
// Evidence is durable before readiness, and survives a start failure
// ---------------------------------------------------------------------------

test("persists spawn evidence before readiness and retains it after a failed start", async () => {
  await withTempBase(async (base) => {
    const repo = makeRepo(base);
    const worktree = makeWorktree(base);
    const script = writeScript(
      worktree,
      "fixture-server.mjs",
      FIXTURE_SERVER_SOURCE,
    );
    const { range } = await freshRange(4);
    const allocator = new PortAllocator({ repoRoot: repo, range });
    const runtimeId = "task-unready-attempt-1";
    const manifestPath = runtimePaths(repo, runtimeId).manifestPath;
    const manager = new RuntimeManager({
      ...baseManagerOptions(repo, worktree),
      runtimeId,
      env: { ...process.env, FIXTURE_STATUS: "503" },
      allocator,
    });

    // Readiness keeps failing for 1.5s, which gives us a window to inspect the
    // manifest after spawn but before the start settles.
    const settled = manager
      .start({
        services: [
          {
            name: "web",
            command: [process.execPath, script],
            readiness: { path: "/health", timeoutMs: 1_500 },
          },
        ],
      })
      .then(
        () => {
          throw new Error("expected readiness failure");
        },
        (error: unknown) => error,
      );

    const during = await waitForManifest(
      manifestPath,
      (manifest) =>
        manifest.services.some((service) => service.processIdentity !== undefined),
    );

    // The evidence is on disk while readiness is still running.
    assert.equal(during.cleanup, "pending");
    assert.deepEqual(during.owner, { pid: process.pid, host: hostname() });
    const duringService = serviceOf(during, "web");
    assert.equal(duringService.pid, duringService.pgid);
    const identity = duringService.processIdentity;
    assert.ok(identity);
    assert.equal(identity.pid, duringService.pid);
    assert.equal(identity.pgid, duringService.pid);
    assert.match(identity.startedAt, PS_LSTART_PATTERN);
    assert.notEqual(identity.startedAt, duringService.startedAt);

    const error = await settled;
    assert.ok(error instanceof RuntimeStartError);
    assert.match(error.message, /not ready within 1500ms/);

    const after = readManifest(manifestPath);
    assert.equal(after.cleanup, "complete");
    assert.match(after.failureReason ?? "", /not ready within 1500ms/);
    const serviceAfter = serviceOf(after, "web");
    assert.equal(serviceAfter.pid, duringService.pid);
    assert.equal(serviceAfter.pgid, duringService.pid);
    assert.deepEqual(serviceAfter.processIdentity, identity);
    assert.ok(serviceAfter.exitedAt);
    assert.equal(inspector.isAlive(duringService.pid!), false);
  });
});

test("persists owner but no process evidence when the service never spawns", async () => {
  await withTempBase(async (base) => {
    const repo = makeRepo(base);
    const worktree = makeWorktree(base);
    const { range } = await freshRange(4);
    const allocator = new PortAllocator({ repoRoot: repo, range });
    const runtimeId = "task-no-spawn-attempt-1";
    const manifestPath = runtimePaths(repo, runtimeId).manifestPath;
    const manager = new RuntimeManager({
      ...baseManagerOptions(repo, worktree),
      runtimeId,
      allocator,
    });

    let captured: RuntimeStartError | undefined;
    await assert.rejects(
      manager.start({
        services: [
          {
            name: "web",
            command: [join(worktree, "definitely-not-a-real-binary")],
          },
        ],
      }),
      (error: unknown) => {
        assert.ok(error instanceof RuntimeStartError);
        captured = error;
        return true;
      },
    );

    assert.ok(captured);
    assert.equal(captured.manifest.cleanup, "complete");
    const manifest = readManifest(manifestPath);
    assert.equal(manifest.cleanup, "complete");
    assert.deepEqual(manifest.owner, { pid: process.pid, host: hostname() });
    assert.match(manifest.failureReason ?? "", /ENOENT/);

    const service = serviceOf(manifest, "web");
    assert.equal(service.pid, undefined);
    assert.equal(service.pgid, undefined);
    assert.equal(service.processIdentity, undefined);

    // Absent optional evidence is omitted, not persisted as null.
    const raw = JSON.parse(readFileSync(manifestPath, "utf8")) as {
      services: Array<Record<string, unknown>>;
    };
    assert.equal("pid" in raw.services[0], false);
    assert.equal("pgid" in raw.services[0], false);
    assert.equal("processIdentity" in raw.services[0], false);
  });
});

// ---------------------------------------------------------------------------
// Retry must not retain the failed attempt's identity
// ---------------------------------------------------------------------------

test("replaces spawn evidence when the EADDRINUSE retry starts a new process", async () => {
  await withTempBase(async (base) => {
    const repo = makeRepo(base);
    const worktree = makeWorktree(base);
    const script = writeScript(
      worktree,
      "fixture-server.mjs",
      FIXTURE_SERVER_SOURCE,
    );
    const marker = join(worktree, "retry-marker");
    const { range } = await freshRange(8);
    const allocator = new PortAllocator({ repoRoot: repo, range });
    const runtimeId = "task-identity-retry-attempt-1";
    const manager = new RuntimeManager({
      ...baseManagerOptions(repo, worktree),
      runtimeId,
      env: {
        ...process.env,
        FIXTURE_EADDRINUSE: "once",
        FIXTURE_MARKER: marker,
      },
      allocator,
    });

    const session = await manager.start({
      services: [
        {
          name: "web",
          command: [process.execPath, script],
          readiness: { path: "/health", timeoutMs: 5_000 },
        },
      ],
    });

    let before: RuntimeManifest;
    try {
      before = readManifest(session.manifestPath);
      const service = serviceOf(before, "web");
      assert.equal(service.pid, service.pgid);
      const identity = service.processIdentity;
      assert.ok(identity);
      assert.equal(identity.pid, service.pid);
      assert.equal(identity.pgid, service.pid);
      // The surviving process, not the failed first attempt, is recorded.
      assert.deepEqual(identity, await inspector.capture(service.pid!));
    } finally {
      await session.stop();
    }

    const after = readManifest(session.manifestPath);
    assert.equal(after.cleanup, "complete");
    assert.equal(serviceOf(after, "web").pid, serviceOf(before, "web").pid);
    assert.deepEqual(
      serviceOf(after, "web").processIdentity,
      serviceOf(before, "web").processIdentity,
    );
  });
});

// ---------------------------------------------------------------------------
// Backwards compatibility
// ---------------------------------------------------------------------------

test("keeps owner, pgid, and processIdentity optional for legacy manifests", () => {
  // Manifest written before identity capture; must stay readable.
  const legacy: RuntimeManifest = {
    version: 1,
    runtimeId: "legacy-run",
    taskId: "legacy-task",
    attempt: 1,
    worktree: "/tmp/legacy-worktree",
    services: [
      {
        name: "web",
        host: "127.0.0.1",
        port: 19000,
        pid: 4242,
        url: "http://127.0.0.1:19000",
        healthUrl: "http://127.0.0.1:19000/health",
        logPath: "/tmp/legacy-web.log",
        dataDir: "/tmp/legacy-web-data",
        readinessAttempts: [],
      },
    ],
    startedAt: "2026-01-01T00:00:00.000Z",
    cleanup: "complete",
  };

  assert.equal(legacy.owner, undefined);
  assert.equal(legacy.services[0].pgid, undefined);
  assert.equal(legacy.services[0].processIdentity, undefined);

  // A current manifest keeps the same version and only adds optional fields.
  const current: RuntimeManifest = {
    ...legacy,
    owner: { pid: 1, host: "localhost" },
    services: [
      {
        ...legacy.services[0],
        pgid: 4242,
        processIdentity: {
          pid: 4242,
          pgid: 4242,
          startedAt: "Tue Oct 27 00:00:00 2026",
        },
      },
    ],
  };
  assert.equal(current.version, 1);
  assert.equal(current.services[0].pgid, current.services[0].pid);
});

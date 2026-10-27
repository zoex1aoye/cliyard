import { test } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { get as httpGetRaw, type IncomingMessage } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { takeTestPortRange } from "./test-port-ranges.js";
import { PortAllocator, probePort } from "../src/runtime/ports.js";
import {
  RuntimeManager,
  RuntimeStartError,
  runtimePaths,
  type RuntimePortAllocator,
  type RuntimeRunResult,
} from "../src/runtime/manager.js";
import type { PortLease, RuntimeManifest } from "../src/runtime/types.js";

// ---------------------------------------------------------------------------
// Fixture services
// ---------------------------------------------------------------------------

/**
 * Small HTTP service. Reads the leased port from its injected port variable,
 * optionally pretends the first bind lost the EADDRINUSE race, and reports the
 * runtime environment it received at `/env`.
 */
const FIXTURE_SERVER_SOURCE = String.raw`
import { createServer } from "node:http";
import { existsSync, writeFileSync } from "node:fs";

// The first argv element names the injected port variable; tests use this to
// exercise a custom portEnv. Defaults to PORT.
const portEnv = process.argv[2] || "PORT";
const port = Number(process.env[portEnv]);
const status = Number(process.env.FIXTURE_STATUS || "200");
const name = process.env.FIXTURE_NAME || "fixture";

// Deterministic stand-in for the allocator/child bind race. "once" fails the
// first spawn only (a marker file is created), "always" fails every spawn.
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

const selected = {};
for (const [key, value] of Object.entries(process.env)) {
  if (key.startsWith("CLIYARD_") || key === "WEB_URL") selected[key] = value;
  if (key === portEnv) selected.__port = value;
}
selected.__argv = process.argv.slice(2);

const server = createServer((req, res) => {
  console.log(name + " " + req.method + " " + req.url);
  if (req.url === "/health") {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: status === 200, name }));
    return;
  }
  if (req.url === "/env") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(selected));
    return;
  }
  res.writeHead(200, { "content-type": "text/plain" });
  res.end("hello from " + name);
});

server.listen(port, "127.0.0.1", () => {
  console.log(name + " listening on " + port);
});
`;

/**
 * The leader spawns a listener child (same process group) and ignores SIGTERM.
 * Only a process-group kill plus SIGKILL escalation can free the port.
 */
const FIXTURE_GROUP_SOURCE = String.raw`
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";

if (process.argv.includes("--listener")) {
  const port = Number(process.env.PORT);
  const server = createServer((req, res) => {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("group listener");
  });
  server.listen(port, "127.0.0.1", () => {
    console.log("listener pid " + process.pid + " port " + port);
  });
} else {
  process.on("SIGTERM", () => console.log("parent ignoring SIGTERM"));
  spawn(process.execPath, [fileURLToPath(import.meta.url), "--listener"], {
    stdio: "inherit",
    env: process.env,
  });
  console.log("parent pid " + process.pid);
  setInterval(() => {}, 1000);
}
`;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function withTempBase(
  fn: (base: string) => Promise<void>,
): Promise<void> {
  const base = mkdtempSync(join(tmpdir(), "cliyard-runtime-manager-"));
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

interface HttpResult {
  status: number;
  body: string;
}

function httpGet(url: string): Promise<HttpResult> {
  return new Promise<HttpResult>((resolveGet, rejectGet) => {
    const request = httpGetRaw(
      url,
      { agent: false, headers: { connection: "close" } },
      (response: IncomingMessage) => {
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk: string) => {
          body += chunk;
        });
        response.on("end", () =>
          resolveGet({ status: response.statusCode ?? 0, body }),
        );
      },
    );
    request.on("error", rejectGet);
    request.setTimeout(5_000, () =>
      request.destroy(new Error(`request timed out: ${url}`)),
    );
  });
}

async function fetchJson(url: string): Promise<Record<string, unknown>> {
  const result = await httpGet(url);
  assert.equal(result.status, 200, `unexpected status from ${url}`);
  return JSON.parse(result.body) as Record<string, unknown>;
}

function readManifest(path: string): RuntimeManifest {
  return JSON.parse(readFileSync(path, "utf8")) as RuntimeManifest;
}

/** Delegates to a real allocator and records allocation/release order. */
class RecordingAllocator implements RuntimePortAllocator {
  readonly allocations: PortLease[] = [];
  readonly releases: PortLease[] = [];

  constructor(private readonly inner: PortAllocator) {}

  async allocate(runId: string, service: string): Promise<PortLease> {
    const lease = await this.inner.allocate(runId, service);
    this.allocations.push(lease);
    return lease;
  }

  async release(lease: PortLease): Promise<boolean> {
    this.releases.push(lease);
    return this.inner.release(lease);
  }
}

function serviceOf(
  manifest: RuntimeManifest,
  name: string,
): RuntimeManifest["services"][number] {
  const service = manifest.services.find((entry) => entry.name === name);
  assert.ok(service, `missing service ${name}`);
  return service;
}

function baseManagerOptions(repo: string, worktree: string) {
  return {
    repoRoot: repo,
    worktree,
    taskId: "task-runtime",
    attempt: 1,
    env: { ...process.env },
    readinessPollMs: 25,
    stopGraceMs: 2_000,
    portReleaseTimeoutMs: 3_000,
  } as const;
}

// ---------------------------------------------------------------------------
// Happy path: two services
// ---------------------------------------------------------------------------

test("starts two services with leased ports, URL env, and data dirs, then cleans up", async () => {
  await withTempBase(async (base) => {
    const repo = makeRepo(base);
    const worktree = makeWorktree(base);
    const script = writeScript(
      worktree,
      "fixture-server.mjs",
      FIXTURE_SERVER_SOURCE,
    );
    const { range, start, end } = takeTestPortRange("runtime-manager", 8);
    const allocator = new PortAllocator({ repoRoot: repo, range });
    const manager = new RuntimeManager({
      ...baseManagerOptions(repo, worktree),
      taskId: "task-two",
      attempt: 2,
      runtimeId: "supervisor-7-task-two-attempt-2",
      artifactHash: "abc123",
      allocator,
    });

    let webPort = 0;
    let apiPort = 0;
    let runtimeDir = "";

    const { manifest } = await manager.run(
      {
        services: [
          {
            name: "web",
            command: [process.execPath, script, "PORT", "web-arg"],
            urlEnv: "WEB_URL",
            readiness: {
              path: "/health",
              expectedStatus: 200,
              timeoutMs: 5_000,
            },
          },
          {
            name: "api-server",
            command: [process.execPath, script, "API_PORT"],
            portEnv: "API_PORT",
            readiness: { timeoutMs: 5_000 },
          },
        ],
      },
      async (session) => {
        runtimeDir = session.runtimeDir;
        const web = serviceOf(session.manifest, "web");
        const api = serviceOf(session.manifest, "api-server");
        webPort = web.port;
        apiPort = api.port;

        assert.equal(web.host, "127.0.0.1");
        assert.equal(api.host, "127.0.0.1");
        assert.notEqual(web.port, api.port);
        assert.ok(web.port >= start && web.port <= end);
        assert.ok(api.port >= start && api.port <= end);
        assert.equal(web.url, `http://127.0.0.1:${web.port}`);
        assert.equal(web.healthUrl, web.url + "/health");
        assert.equal(api.healthUrl, api.url + "/");
        assert.equal(typeof web.pid, "number");
        assert.equal(typeof api.pid, "number");
        assert.ok(web.startedAt);
        assert.ok(api.startedAt);
        assert.ok(web.readinessAttempts.length >= 1);
        assert.equal(web.readinessAttempts.at(-1)?.ok, true);

        assert.equal(session.env.CLIYARD_WEB_URL, web.url);
        assert.equal(session.env.WEB_URL, web.url);
        assert.equal(session.env.CLIYARD_API_SERVER_URL, api.url);
        assert.deepEqual(session.urls, {
          web: web.url,
          "api-server": api.url,
        });

        assert.ok(session.runtimeDir.startsWith(join(repo, ".cliyard", "runtime")));
        assert.ok(existsSync(web.dataDir));
        assert.ok(existsSync(api.dataDir));
        assert.equal(web.dataDir, join(runtimeDir, "data", "web"));
        assert.equal(api.dataDir, join(runtimeDir, "data", "api-server"));
        assert.equal(web.logPath, join(runtimeDir, "web.log"));
        assert.equal(session.manifestPath, join(runtimeDir, "runtime-manifest.json"));
        assert.ok(existsSync(web.logPath));
        assert.ok(existsSync(session.manifestPath));

        const webEnv = await fetchJson(`${web.url}/env`);
        assert.equal(webEnv.__port, String(web.port));
        assert.equal(webEnv.CLIYARD_WEB_DATA_DIR, web.dataDir);
        assert.equal(webEnv.CLIYARD_API_SERVER_URL, api.url);
        assert.equal(webEnv.WEB_URL, web.url);
        assert.deepEqual(webEnv.__argv, ["PORT", "web-arg"]);

        const apiEnv = await fetchJson(`${api.url}/env`);
        assert.equal(apiEnv.__port, String(api.port));
        assert.equal(apiEnv.CLIYARD_API_SERVER_DATA_DIR, api.dataDir);
        assert.equal(apiEnv.CLIYARD_WEB_URL, web.url);
        assert.deepEqual(apiEnv.__argv, ["API_PORT"]);

        const health = await httpGet(web.healthUrl);
        assert.equal(health.status, 200);

        const onDisk = readManifest(session.manifestPath);
        assert.equal(onDisk.cleanup, "pending");
        assert.equal(onDisk.runtimeId, "supervisor-7-task-two-attempt-2");
        assert.equal(onDisk.taskId, "task-two");
        assert.equal(onDisk.attempt, 2);
        assert.equal(onDisk.artifactHash, "abc123");
        assert.equal(onDisk.worktree, worktree);
        assert.equal(onDisk.services.length, 2);
        assert.ok(onDisk.services.every((entry) => typeof entry.pid === "number"));

        const log = readFileSync(web.logPath, "utf8");
        assert.match(log, /listening on/);
        assert.match(log, /GET \/health/);
      },
    );

    assert.equal(manifest.cleanup, "complete");
    assert.ok(manifest.stoppedAt);
    assert.equal(manifest.failureReason, undefined);
    for (const service of manifest.services) {
      assert.equal(service.exitCode, null);
      assert.equal(service.signal, "SIGTERM");
      assert.ok(service.exitedAt);
    }

    // No listener after stop, and every lease was released.
    assert.equal(await probePort(webPort), true);
    assert.equal(await probePort(apiPort), true);
    await assert.rejects(httpGet(`http://127.0.0.1:${webPort}/health`));
    assert.deepEqual(allocator.list(), []);

    const persisted = readManifest(
      runtimePaths(repo, manifest.runtimeId).manifestPath,
    );
    assert.equal(persisted.cleanup, "complete");
    assert.ok(persisted.stoppedAt);
    assert.deepEqual(
      persisted.services.map((service) => [service.name, service.port]),
      [
        ["web", webPort],
        ["api-server", apiPort],
      ],
    );
    assert.equal(persisted.services[0].dataDir, join(runtimeDir, "data", "web"));
  });
});

// ---------------------------------------------------------------------------
// Readiness failure
// ---------------------------------------------------------------------------

test("readiness failure captures logs, stops the service, and skips the callback", async () => {
  await withTempBase(async (base) => {
    const repo = makeRepo(base);
    const worktree = makeWorktree(base);
    const script = writeScript(
      worktree,
      "fixture-server.mjs",
      FIXTURE_SERVER_SOURCE,
    );
    const { range } = takeTestPortRange("runtime-manager", 4);
    const allocator = new PortAllocator({ repoRoot: repo, range });
    const manager = new RuntimeManager({
      ...baseManagerOptions(repo, worktree),
      taskId: "task-unready",
      // Leave room after the last probe for its 503 response. Polling every
      // 25ms can race a final sub-millisecond probe that times out or is
      // refused instead, masking the expected status in the classified error.
      readinessPollMs: 250,
      env: { ...process.env, FIXTURE_STATUS: "503" },
      allocator,
    });

    let callbackRan = false;
    let captured: RuntimeManifest | undefined;
    await assert.rejects(
      manager.run(
        {
          services: [
            {
              name: "web",
              command: [process.execPath, script],
              readiness: {
                path: "/health",
                expectedStatus: 200,
                timeoutMs: 900,
              },
            },
          ],
        },
        () => {
          callbackRan = true;
        },
      ),
      (error: unknown) => {
        assert.ok(error instanceof RuntimeStartError);
        captured = error.manifest;
        assert.match(error.message, /service "web" is not ready within 900ms/);
        assert.match(error.message, /received 503/);
        return true;
      },
    );
    assert.equal(callbackRan, false);

    const manifest = captured!;
    assert.equal(manifest.cleanup, "complete");
    assert.ok(manifest.stoppedAt);
    assert.match(manifest.failureReason ?? "", /received 503/);
    const service = serviceOf(manifest, "web");
    assert.match(service.error ?? "", /received 503/);
    assert.ok(service.readinessAttempts.length >= 1);
    assert.equal(service.readinessAttempts.at(-1)?.status, 503);

    assert.ok(existsSync(service.logPath));
    const log = readFileSync(service.logPath, "utf8");
    assert.match(log, /GET \/health/);
    assert.match(manifest.failureReason ?? "", /--- .*web\.log ---/);

    assert.equal(await probePort(service.port), true);
    assert.deepEqual(allocator.list(), []);
    const persisted = readManifest(
      runtimePaths(repo, manifest.runtimeId).manifestPath,
    );
    assert.equal(persisted.cleanup, "complete");
    assert.match(persisted.failureReason ?? "", /received 503/);
    assert.match(persisted.failureReason ?? "", /web\.log/);
  });
});

// ---------------------------------------------------------------------------
// finally semantics
// ---------------------------------------------------------------------------

test("run stops services and releases leases when the callback throws", async () => {
  await withTempBase(async (base) => {
    const repo = makeRepo(base);
    const worktree = makeWorktree(base);
    const script = writeScript(
      worktree,
      "fixture-server.mjs",
      FIXTURE_SERVER_SOURCE,
    );
    const { range } = takeTestPortRange("runtime-manager", 4);
    const allocator = new PortAllocator({ repoRoot: repo, range });
    const manager = new RuntimeManager({
      ...baseManagerOptions(repo, worktree),
      taskId: "task-callback-fails",
      runtimeId: "task-callback-fails-attempt-1",
      allocator,
    });

    let port = 0;
    await assert.rejects(
      manager.run(
        {
          services: [
            {
              name: "web",
              command: [process.execPath, script],
              readiness: { timeoutMs: 5_000 },
            },
          ],
        },
        (session) => {
          port = serviceOf(session.manifest, "web").port;
          throw new Error("verification exploded");
        },
      ),
      /verification exploded/,
    );

    assert.equal(await probePort(port), true);
    assert.deepEqual(allocator.list(), []);
    const manifest = readManifest(
      runtimePaths(repo, "task-callback-fails-attempt-1").manifestPath,
    );
    assert.equal(manifest.cleanup, "complete");
    assert.ok(manifest.stoppedAt);
    assert.equal(manifest.services[0].signal, "SIGTERM");
  });
});

// ---------------------------------------------------------------------------
// Complete process-group cleanup
// ---------------------------------------------------------------------------

test("stops the complete process group, escalating past a leader that ignores SIGTERM", async () => {
  await withTempBase(async (base) => {
    const repo = makeRepo(base);
    const worktree = makeWorktree(base);
    const script = writeScript(
      worktree,
      "fixture-group.mjs",
      FIXTURE_GROUP_SOURCE,
    );
    const { range } = takeTestPortRange("runtime-manager", 4);
    const allocator = new PortAllocator({ repoRoot: repo, range });
    const manager = new RuntimeManager({
      ...baseManagerOptions(repo, worktree),
      taskId: "task-group",
      stopGraceMs: 300,
      allocator,
    });

    const session = await manager.start({
      services: [
        {
          name: "web",
          command: [process.execPath, script],
          readiness: { timeoutMs: 5_000 },
        },
      ],
    });

    const service = serviceOf(session.manifest, "web");

    let stopped: RuntimeManifest | undefined;
    try {
      const log = readFileSync(service.logPath, "utf8");
      assert.match(log, /parent pid/);
      assert.match(log, /listener pid/);

      const started = Date.now();
      stopped = await session.stop();
      const elapsed = Date.now() - started;

      assert.equal(stopped.cleanup, "complete");
      assert.ok(
        elapsed >= 200,
        `expected SIGKILL escalation after the 300ms grace, stop took ${elapsed}ms`,
      );
      assert.equal(stopped.services[0].signal, "SIGKILL");
      assert.equal(await probePort(service.port), true);
      await assert.rejects(httpGet(`http://127.0.0.1:${service.port}/`));
      assert.deepEqual(allocator.list(), []);
      assert.equal(await session.stop(), stopped);
    } finally {
      if (!stopped) await session.stop();
    }
  });
});

// ---------------------------------------------------------------------------
// EADDRINUSE retry
// ---------------------------------------------------------------------------

test("retries once on immediate EADDRINUSE evidence with a different port", async () => {
  await withTempBase(async (base) => {
    const repo = makeRepo(base);
    const worktree = makeWorktree(base);
    const script = writeScript(
      worktree,
      "fixture-server.mjs",
      FIXTURE_SERVER_SOURCE,
    );
    const marker = join(worktree, "retry-marker");
    const { range } = takeTestPortRange("runtime-manager", 8);
    const inner = new PortAllocator({ repoRoot: repo, range });
    const allocator = new RecordingAllocator(inner);
    const manager = new RuntimeManager({
      ...baseManagerOptions(repo, worktree),
      taskId: "task-retry",
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
          readiness: { timeoutMs: 5_000 },
        },
      ],
    });

    try {
      assert.equal(allocator.allocations.length, 2);
      const [first, second] = allocator.allocations;
      assert.notEqual(first.port, second.port);
      assert.deepEqual(
        allocator.releases.map((lease) => lease.port),
        [first.port],
      );

      const service = serviceOf(session.manifest, "web");
      assert.equal(service.port, second.port);
      assert.equal(service.url, `http://127.0.0.1:${second.port}`);
      assert.equal(session.env.CLIYARD_WEB_URL, service.url);
      assert.ok(existsSync(marker));

      const log = readFileSync(service.logPath, "utf8");
      assert.match(log, /EADDRINUSE/);
      assert.match(log, /listening on/);

      const health = await httpGet(service.healthUrl);
      assert.equal(health.status, 200);
    } finally {
      await session.stop();
    }

    assert.deepEqual(
      allocator.releases.map((lease) => lease.port).sort(),
      allocator.allocations.map((lease) => lease.port).sort(),
    );
    assert.deepEqual(inner.list(), []);
    for (const lease of allocator.allocations) {
      assert.equal(await probePort(lease.port), true);
    }
  });
});

test("does not retry a second time after EADDRINUSE", async () => {
  await withTempBase(async (base) => {
    const repo = makeRepo(base);
    const worktree = makeWorktree(base);
    const script = writeScript(
      worktree,
      "fixture-server.mjs",
      FIXTURE_SERVER_SOURCE,
    );
    const { range } = takeTestPortRange("runtime-manager", 8);
    const inner = new PortAllocator({ repoRoot: repo, range });
    const allocator = new RecordingAllocator(inner);
    const manager = new RuntimeManager({
      ...baseManagerOptions(repo, worktree),
      taskId: "task-retry-once",
      env: { ...process.env, FIXTURE_EADDRINUSE: "always" },
      allocator,
    });

    let captured: RuntimeStartError | undefined;
    try {
      await manager.start({
        services: [
          {
            name: "web",
            command: [process.execPath, script],
            readiness: { timeoutMs: 2_000 },
          },
        ],
      });
      assert.fail("expected startup to fail");
    } catch (error) {
      assert.ok(error instanceof RuntimeStartError);
      captured = error;
    }

    assert.equal(allocator.allocations.length, 2);
    assert.equal(allocator.releases.length, 2);
    assert.notEqual(
      allocator.allocations[0].port,
      allocator.allocations[1].port,
    );
    assert.equal(captured.manifest.cleanup, "complete");
    const service = captured.manifest.services[0];
    assert.equal(service.port, allocator.allocations[1].port);
    assert.match(service.error ?? "", /EADDRINUSE/);
    assert.match(captured.message, /EADDRINUSE/);
    assert.deepEqual(inner.list(), []);
    for (const lease of allocator.allocations) {
      assert.equal(await probePort(lease.port), true);
    }
  });
});

// ---------------------------------------------------------------------------
// Validation and idempotence
// ---------------------------------------------------------------------------

test("rejects unsafe ids and malformed specs before allocating", async () => {
  await withTempBase(async (base) => {
    const repo = makeRepo(base);
    const worktree = makeWorktree(base);
    const options = baseManagerOptions(repo, worktree);

    assert.throws(
      () => new RuntimeManager({ ...options, runtimeId: "../escape" }),
      /invalid runtimeId/,
    );

    const manager = new RuntimeManager({
      ...options,
      runtimeId: "task-spec-attempt-1",
    });
    await assert.rejects(
      manager.start({
        services: [
          {
            name: "web/api",
            command: [process.execPath, "-e", "process.exit(0)"],
          },
        ],
      }),
      /name/,
    );

    assert.equal(
      existsSync(runtimePaths(repo, "task-spec-attempt-1").manifestPath),
      false,
    );

    const collision = new RuntimeManager({
      ...options,
      runtimeId: "task-spec-collision",
    });
    await assert.rejects(
      collision.start({
        services: [
          {
            name: "web",
            command: [process.execPath, "-e", "process.exit(0)"],
            urlEnv: "SHARED_URL",
          },
          {
            name: "api",
            command: [process.execPath, "-e", "process.exit(0)"],
            urlEnv: "SHARED_URL",
          },
        ],
      }),
      /SHARED_URL/,
    );
  });
});

test("run returns the finalized manifest and session.stop is idempotent", async () => {
  await withTempBase(async (base) => {
    const repo = makeRepo(base);
    const worktree = makeWorktree(base);
    const script = writeScript(
      worktree,
      "fixture-server.mjs",
      FIXTURE_SERVER_SOURCE,
    );
    const { range } = takeTestPortRange("runtime-manager", 4);
    const allocator = new PortAllocator({ repoRoot: repo, range });
    const manager = new RuntimeManager({
      ...baseManagerOptions(repo, worktree),
      runtimeId: "task-idempotent-attempt-1",
      allocator,
    });

    let captured: RuntimeRunResult<number> | undefined;
    captured = await manager.run(
      {
        services: [
          {
            name: "web",
            command: [process.execPath, script],
            readiness: { timeoutMs: 5_000 },
          },
        ],
      },
      async (session) => {
        const firstStop = await session.stop();
        assert.equal(firstStop.cleanup, "complete");
        const secondStop = await session.stop();
        assert.equal(secondStop, firstStop);
        assert.equal(await probePort(serviceOf(secondStop, "web").port), true);
        return 42;
      },
    );

    assert.equal(captured.result, 42);
    assert.equal(captured.manifest.cleanup, "complete");
    assert.deepEqual(allocator.list(), []);
  });
});

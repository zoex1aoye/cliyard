import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import {
  ProcessInspector,
  ProcessInspectorError,
  ProcessInspectorUnsupportedPlatformError,
  compareProcessIdentity,
  isProcessIdentity,
  isProcessPid,
  isRuntimeOwner,
  type ProcessGroupMember,
} from "../src/runtime/process.js";
import type {
  RuntimeManifest,
  RuntimeProcessIdentity,
} from "../src/runtime/types.js";

const inspector = new ProcessInspector();

/**
 * A detached node process leads its own process group, which makes pgid reuse
 * and group membership observable without touching unrelated host processes.
 */
const KEEP_ALIVE_SCRIPT = "setInterval(() => {}, 1000);";

/** Leader plus one helper that inherits the leader's process group. */
const GROUP_SCRIPT = `
const { spawn } = require("node:child_process");
spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
setInterval(() => {}, 1000);
`;

async function spawnDetached(
  script: string = KEEP_ALIVE_SCRIPT,
): Promise<{ child: ChildProcess; pid: number }> {
  const child = spawn(process.execPath, ["-e", script], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  await once(child, "spawn");
  if (child.pid === undefined) throw new Error("spawned child has no pid");
  return { child, pid: child.pid };
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
  await waitForExit(child);
}

function waitForExit(child: ChildProcess, timeoutMs = 5_000): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve();
  }
  return new Promise<void>((resolveExit) => {
    const timer = setTimeout(resolveExit, timeoutMs);
    child.once("exit", () => {
      clearTimeout(timer);
      resolveExit();
    });
  });
}

async function waitForGroupSize(
  pgid: number,
  minimum: number,
  timeoutMs = 5_000,
): Promise<ProcessGroupMember[]> {
  const deadline = Date.now() + timeoutMs;
  let members = await inspector.listGroupMembers(pgid);
  while (members.length < minimum && Date.now() < deadline) {
    await delay(50);
    members = await inspector.listGroupMembers(pgid);
  }
  return members;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

// ---------------------------------------------------------------------------
// Capture
// ---------------------------------------------------------------------------

test("captures the exact pid, pgid, and OS-reported start identity", async () => {
  const { child, pid } = await spawnDetached();
  try {
    const identity: RuntimeProcessIdentity | undefined =
      await inspector.capture(pid);
    assert.ok(identity, "identity should be captured for a live pid");
    assert.equal(identity.pid, pid);
    assert.equal(identity.pgid, pid); // detached child leads its own group
    assert.ok(identity.startedAt.length > 0);

    // `ps lstart` in the C locale/UTC, not an ISO wall-clock stamp written by
    // the control process.
    assert.match(
      identity.startedAt,
      /^[A-Z][a-z]{2} [A-Z][a-z]{2} \d{1,2} \d{2}:\d{2}:\d{2} \d{4}$/,
    );
    const startedMs = Date.parse(`${identity.startedAt} UTC`);
    assert.ok(Number.isFinite(startedMs));
    assert.ok(
      Math.abs(Date.now() - startedMs) < 120_000,
      `start identity should be near now, got ${identity.startedAt}`,
    );

    // Repeated capture is stable, so persisted and later observed identities
    // can be compared exactly.
    const again = await inspector.capture(pid);
    assert.deepEqual(again, identity);
    assert.equal(compareProcessIdentity(identity, again), "match");
  } finally {
    await stopGroup(child, pid);
  }
});

// ---------------------------------------------------------------------------
// Liveness
// ---------------------------------------------------------------------------

test("probes same-host liveness for live and dead pids", async () => {
  const { child, pid } = await spawnDetached();
  try {
    assert.equal(inspector.isAlive(pid), true);
    assert.equal(inspector.ownerState({ pid, host: inspector.host }), "alive");
    assert.equal(
      inspector.ownerState({ pid, host: ` ${inspector.host.toUpperCase()} ` }),
      "alive",
    );
  } finally {
    await stopGroup(child, pid);
  }

  // The kernel no longer has the pid, and no identity can be captured.
  assert.equal(inspector.isAlive(pid), false);
  assert.equal(inspector.ownerState({ pid, host: inspector.host }), "dead");
  assert.equal(await inspector.capture(pid), undefined);
});

test("never probes a foreign-host owner on this machine", () => {
  const foreignHost = `not-${inspector.host}`;
  assert.equal(
    inspector.ownerState({ pid: process.pid, host: foreignHost }),
    "foreign-host",
  );
  assert.equal(inspector.isSameHost(undefined), false);
  assert.equal(inspector.isSameHost(""), false);
  assert.equal(inspector.ownerState(undefined), "unknown");
  assert.equal(inspector.ownerState({ pid: 0, host: inspector.host }), "unknown");
  assert.equal(
    inspector.ownerState({ pid: process.pid, host: "   " }),
    "unknown",
  );
});

// ---------------------------------------------------------------------------
// Process groups
// ---------------------------------------------------------------------------

test("lists every member of a process group", async () => {
  const { child, pid } = await spawnDetached(GROUP_SCRIPT);
  try {
    const members = await waitForGroupSize(pid, 2);
    assert.ok(
      members.length >= 2,
      `expected leader plus helper, got ${JSON.stringify(members)}`,
    );

    assert.deepEqual(
      members.map((member) => member.pid),
      [...members.map((member) => member.pid)].sort((a, b) => a - b),
    );
    for (const member of members) {
      assert.equal(member.pgid, pid);
      assert.ok(member.startedAt.length > 0);
      assert.ok(isProcessIdentity(member));
    }
    assert.ok(members.some((member) => member.pid === pid));

    // A group id above every OS pid limit has no members.
    assert.deepEqual(await inspector.listGroupMembers(999_999_999), []);
  } finally {
    await stopGroup(child, pid);
  }
});

// ---------------------------------------------------------------------------
// Identity comparison
// ---------------------------------------------------------------------------

test("compares identities exactly and keeps missing data unknown", async () => {
  const { child, pid } = await spawnDetached();
  try {
    const identity = await inspector.capture(pid);
    assert.ok(identity);

    assert.equal(compareProcessIdentity(identity, { ...identity }), "match");
    assert.equal(
      compareProcessIdentity(
        { ...identity, startedAt: ` ${identity.startedAt}  ` },
        identity,
      ),
      "match",
    );

    // A reused pid shows up as a changed start identity even when pid/pgid
    // happen to match; any differing component is a mismatch.
    assert.equal(
      compareProcessIdentity(identity, { ...identity, pid: pid + 1 }),
      "mismatch",
    );
    assert.equal(
      compareProcessIdentity(identity, { ...identity, pgid: pid + 1 }),
      "mismatch",
    );
    assert.equal(
      compareProcessIdentity(identity, {
        ...identity,
        startedAt: "Mon Jan  1 00:00:00 2001",
      }),
      "mismatch",
    );

    // Legacy/partial captures must never be interpreted as ownership.
    assert.equal(compareProcessIdentity(identity, undefined), "unknown");
    assert.equal(compareProcessIdentity(undefined, identity), "unknown");
    assert.equal(compareProcessIdentity(undefined, undefined), "unknown");
    assert.equal(compareProcessIdentity({}, identity), "unknown");
    assert.equal(
      compareProcessIdentity({ ...identity, startedAt: "" }, identity),
      "unknown",
    );
  } finally {
    await stopGroup(child, pid);
  }
});

test("treats absent pids as absent instead of probing or guessing", async () => {
  for (const pid of [undefined, 0, -1, 1.5, Number.NaN]) {
    assert.equal(inspector.isAlive(pid), false);
    assert.equal(await inspector.capture(pid), undefined);
    assert.deepEqual(await inspector.listGroupMembers(pid), []);
  }

  assert.equal(isProcessPid(undefined), false);
  assert.equal(isProcessPid(0), false);
  assert.equal(isProcessPid(1.5), false);
  assert.equal(isProcessIdentity(undefined), false);
  assert.equal(isProcessIdentity({ pid: 1, pgid: 1 }), false);
  assert.equal(isProcessIdentity({ pid: 1, pgid: 1, startedAt: "  " }), false);
  assert.equal(isRuntimeOwner(undefined), false);
  assert.equal(isRuntimeOwner({ pid: 1 }), false);
});

// ---------------------------------------------------------------------------
// Failure modes and backwards compatibility
// ---------------------------------------------------------------------------

test("fails closed on unsupported platforms or a broken ps", async () => {
  const windows = new ProcessInspector({ platform: "win32" });
  assert.equal(windows.supported, false);
  await assert.rejects(
    windows.capture(process.pid),
    ProcessInspectorUnsupportedPlatformError,
  );
  await assert.rejects(
    windows.listGroupMembers(process.pid),
    ProcessInspectorUnsupportedPlatformError,
  );
  // Invalid pids short-circuit before any platform or ps work.
  assert.equal(await windows.capture(undefined), undefined);
  assert.deepEqual(await windows.listGroupMembers(undefined), []);

  const broken = new ProcessInspector({
    psPath: "/definitely/not/a/ps/binary",
  });
  await assert.rejects(broken.capture(process.pid), ProcessInspectorError);
  await assert.rejects(
    broken.listGroupMembers(process.pid),
    ProcessInspectorError,
  );
});

test("old manifests without owner or identity stay readable and unknown", async () => {
  // Written by a RuntimeManager that predates identity capture.
  const legacyJson = JSON.stringify({
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
        logPath: "/tmp/web.log",
        dataDir: "/tmp/web-data",
        readinessAttempts: [],
      },
    ],
    startedAt: "2026-01-01T00:00:00.000Z",
    cleanup: "running",
  });

  const manifest = JSON.parse(legacyJson) as RuntimeManifest;
  assert.equal(manifest.owner, undefined);
  assert.equal(manifest.recovery, undefined);
  assert.equal(manifest.services[0]?.pgid, undefined);
  assert.equal(manifest.services[0]?.processIdentity, undefined);

  // Missing identity is unknown whether or not the pid is still present, and
  // must never be completed from the manifest's wall-clock timestamps.
  assert.equal(
    compareProcessIdentity(manifest.services[0]?.processIdentity, {
      pid: 4242,
      pgid: 4242,
      startedAt: "Tue Oct 27 00:00:00 2026",
    }),
    "unknown",
  );
  assert.equal(
    compareProcessIdentity(manifest.services[0]?.processIdentity, undefined),
    "unknown",
  );
});

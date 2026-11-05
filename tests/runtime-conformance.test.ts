/**
 * Runtime conformance for the POSIX process-group ExecutionSupervisor backend
 * (design/execution-supervisor-v0.md, docs/ROADMAP.md P2).
 *
 * These tests use real detached Node processes and the real `ps`-based
 * ProcessInspector. They prove cancellation, restart, re-attach and cleanup
 * semantics, and they record where the process-group backend stops being
 * containment:
 *
 * - a `setsid()` escape is outside the managed group;
 * - a leader exit with group members remaining yields `lost` and refuses to
 *   signal without the exact leader identity;
 * - an inherited output pipe cannot block exit observation or Collect.
 *
 * Test harness cleanup follows the same rule as the backend: every signal is
 * sent only after re-capturing the exact `(pid, pgid, lstart)` identity. The
 * harness reaps escapees it created; it never claims the backend contained
 * them.
 */
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";

import {
  PROCESS_GROUP_CAPABILITY_LIMITS,
  PROCESS_GROUP_RECORD_VERSION,
  RUNTIME_CONFORMANCE_CASES,
  createProcessGroupExecutionSupervisor,
  processGroupRecordPath,
  restartDisposition,
  type ProcessGroupConformanceRecord,
  type ProcessGroupExecutionSupervisor,
} from "../src/execution/conformance.js";
import {
  processGroupIdentityFromRuntimeHandle,
  processGroupRuntimeHandle,
} from "../src/agents/worker-lease.js";
import { ExecutionError } from "../src/execution/supervisor.js";
import {
  ProcessInspector,
  compareProcessIdentity,
} from "../src/runtime/process.js";
import {
  executionCapabilityGaps,
  parseRuntimeHandle,
  runtimeHandleKey,
  sameRuntimeHandle,
  type ExecutionResourceLimits,
  type RuntimeHandle,
  type StartExecutionRequest,
} from "../src/execution/types.js";
import type { RuntimeProcessIdentity } from "../src/runtime/types.js";

const IS_POSIX = process.platform === "darwin" || process.platform === "linux";
const POSIX_SKIP = IS_POSIX
  ? false
  : "POSIX process groups and ps identity capture are required";

const inspector = new ProcessInspector();

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const WORKER_FIXTURE = `
process.stdout.write("worker-ready\\n");
setInterval(() => {}, 1000);
`;

const LABELLED_WORKER_FIXTURE = `
const label = process.env.UNIT_LABEL || "unlabelled";
process.stdout.write("ready:" + label + "\\n");
setInterval(() => {}, 1000);
`;

const SETSID_CHILD_FIXTURE = `
import { writeFileSync } from "node:fs";
import { join } from "node:path";

const [dir] = process.argv.slice(2);
writeFileSync(join(dir, "escape-child.self.pid"), String(process.pid) + "\\n");
process.on("SIGTERM", () => {});
setInterval(() => {}, 1000);
`;

const SETSID_LEADER_FIXTURE = `
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

const [dir, grandchild] = process.argv.slice(2);
const child = spawn(process.execPath, [grandchild, dir], {
  detached: true,
  stdio: "ignore",
});
child.unref();
writeFileSync(join(dir, "escape-leader.pid"), String(process.pid) + "\\n");
writeFileSync(join(dir, "escape-child.pid"), String(child.pid) + "\\n");
setInterval(() => {}, 1000);
`;

const ORPHAN_CHILD_FIXTURE = `
import { appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const [dir, name] = process.argv.slice(2);
writeFileSync(join(dir, name), String(process.pid) + "\\n");
const signalLog = join(dir, "orphan-signals.log");
for (const signal of ["SIGTERM", "SIGINT", "SIGHUP", "SIGQUIT"]) {
  process.on(signal, () => appendFileSync(signalLog, signal + "\\n"));
}
setInterval(() => {}, 1000);
`;

const ORPHAN_LEADER_FIXTURE = `
import { spawn } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const [dir, grandchild] = process.argv.slice(2);
const child = spawn(process.execPath, [grandchild, dir, "orphan-child.pid"], {
  stdio: "ignore",
});
child.unref();
writeFileSync(join(dir, "orphan-leader.pid"), String(process.pid) + "\\n");
const timer = setInterval(() => {
  if (!existsSync(join(dir, "orphan.go"))) return;
  clearInterval(timer);
  process.exit(0);
}, 25);
`;

const PIPE_HOLDER_FIXTURE = `
import { writeFileSync } from "node:fs";
import { join } from "node:path";

const [dir] = process.argv.slice(2);
writeFileSync(join(dir, "pipes-child.self.pid"), String(process.pid) + "\\n");
process.stdout.write("pipe-holder-ready\\n");
process.on("SIGTERM", () => {});
setInterval(() => {}, 1000);
`;

const PIPE_LEADER_FIXTURE = `
import { spawn } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const [dir, grandchild] = process.argv.slice(2);
const child = spawn(process.execPath, [grandchild, dir], {
  detached: true,
  stdio: ["ignore", "inherit", "inherit"],
});
child.unref();
writeFileSync(join(dir, "pipes-leader.pid"), String(process.pid) + "\\n");
writeFileSync(join(dir, "pipes-child.pid"), String(child.pid) + "\\n");
const timer = setInterval(() => {
  if (!existsSync(join(dir, "pipes.go"))) return;
  clearInterval(timer);
  process.exit(0);
}, 25);
`;

const SIGNAL_LOGGING_STANDALONE_FIXTURE = `
import { appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const [dir] = process.argv.slice(2);
writeFileSync(join(dir, "standalone.pid"), String(process.pid) + "\\n");
const signalLog = join(dir, "standalone-signals.log");
for (const signal of ["SIGTERM", "SIGINT", "SIGHUP", "SIGQUIT"]) {
  process.on(signal, () => appendFileSync(signalLog, signal + "\\n"));
}
setInterval(() => {}, 1000);
`;

const CONTROLLER_FIXTURE = `
import { writeFileSync } from "node:fs";

const modulePath = process.env.CONFORMANCE_MODULE;
if (!modulePath) throw new Error("CONFORMANCE_MODULE is required");
const { createProcessGroupExecutionSupervisor } = await import(modulePath);

const [stateDir, tempRoot, worker, readyFile] = process.argv.slice(2);
if (!stateDir || !tempRoot || !worker || !readyFile) {
  throw new Error("missing controller arguments");
}
const supervisor = createProcessGroupExecutionSupervisor({ stateDir, tempRoot });
const handle = await supervisor.start({
  attemptId: "controller-restart-attach",
  workspaceId: "runtime-conformance",
  command: [process.execPath, worker],
  cwd: tempRoot,
});
const deadline = Date.now() + 10000;
for (;;) {
  const output = await supervisor.output(handle);
  if (output.stdout.includes("worker-ready")) break;
  if (Date.now() > deadline) throw new Error("worker did not become ready");
  await new Promise((resolve) => setTimeout(resolve, 50));
}
await supervisor.flush();
writeFileSync(readyFile, JSON.stringify({ handle, controllerPid: process.pid }) + "\\n");
process.on("SIGTERM", () => process.exit(0));
setInterval(() => {}, 1000);
`;

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

class FixtureHarness {
  readonly root: string;
  private readonly tracked: RuntimeProcessIdentity[] = [];
  private readonly adopted: ChildProcess[] = [];
  private fixtureCounter = 0;

  private constructor(root: string) {
    this.root = root;
  }

  static async create(): Promise<FixtureHarness> {
    return new FixtureHarness(
      await mkdtemp(join(tmpdir(), "cliyard-runtime-conformance-")),
    );
  }

  path(name: string): string {
    return join(this.root, name);
  }

  async directory(name: string): Promise<string> {
    const path = this.path(name);
    await mkdir(path, { recursive: true, mode: 0o700 });
    return path;
  }

  async writeFixture(name: string, source: string): Promise<string> {
    this.fixtureCounter += 1;
    const path = this.path(`${name}-${this.fixtureCounter}.mjs`);
    await writeFile(path, source, { mode: 0o600 });
    return path;
  }

  async writeController(name: string, source: string): Promise<string> {
    this.fixtureCounter += 1;
    const path = this.path(`${name}-${this.fixtureCounter}.mts`);
    await writeFile(path, source, { mode: 0o600 });
    return path;
  }

  adopt(child: ChildProcess): void {
    this.adopted.push(child);
  }

  track(identity: RuntimeProcessIdentity): RuntimeProcessIdentity {
    this.tracked.push(identity);
    return identity;
  }

  trackHandle(handle: RuntimeHandle): RuntimeProcessIdentity {
    const identity = processGroupIdentityFromRuntimeHandle(handle);
    assert.ok(
      identity !== undefined,
      "a started unit must expose canonical process-group authority",
    );
    return this.track(identity);
  }

  async cleanup(): Promise<void> {
    for (const child of this.adopted) {
      if (child.exitCode === null && child.signalCode === null) {
        try {
          child.kill("SIGKILL");
        } catch {
          // Already gone.
        }
      }
    }
    for (const identity of [...this.tracked].reverse()) {
      await reapExact(identity).catch(() => undefined);
    }
    await rm(this.root, { recursive: true, force: true }).catch(
      () => undefined,
    );
  }
}

async function waitFor(
  check: () => boolean | Promise<boolean>,
  label: string,
  timeoutMs = 10_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await check()) return;
    if (Date.now() >= deadline) {
      throw new Error(`timed out after ${timeoutMs}ms waiting for ${label}`);
    }
    await sleep(40);
  }
}

async function waitForValue<T>(
  read: () => Promise<T | undefined>,
  label: string,
  timeoutMs = 10_000,
): Promise<T> {
  let value: T | undefined;
  await waitFor(async () => {
    value = await read();
    return value !== undefined;
  }, label, timeoutMs);
  return value as T;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

async function readPidFile(path: string): Promise<number> {
  const text = await waitForValue(
    async () => {
      try {
        return await readFile(path, "utf8");
      } catch {
        return undefined;
      }
    },
    `pid file ${path}`,
  );
  const pid = Number.parseInt(text.trim(), 10);
  assert.ok(
    Number.isInteger(pid) && pid > 0,
    `pid file ${path} did not contain a pid`,
  );
  return pid;
}

async function captureExact(pid: number): Promise<RuntimeProcessIdentity> {
  return waitForValue(
    () => inspector.capture(pid),
    `exact identity for pid ${pid}`,
  );
}

async function isAlive(identity: RuntimeProcessIdentity): Promise<boolean> {
  const current = await inspector.capture(identity.pid).catch(() => undefined);
  return (
    current !== undefined &&
    compareProcessIdentity(identity, current) === "match"
  );
}

/**
 * Reap a fixture process by exact verified identity. This is harness cleanup,
 * not backend containment: the identity is re-captured immediately before the
 * signal and a mismatch refuses the kill.
 */
async function reapExact(identity: RuntimeProcessIdentity): Promise<void> {
  const current = await inspector.capture(identity.pid).catch(() => undefined);
  if (current === undefined) return;
  assert.equal(
    compareProcessIdentity(identity, current),
    "match",
    `refusing to signal pid ${identity.pid}: identity does not match`,
  );
  try {
    process.kill(identity.pid, "SIGKILL");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
  await waitFor(
    async () =>
      (await inspector.capture(identity.pid).catch(() => undefined)) ===
      undefined,
    `pid ${identity.pid} to be reaped`,
    5_000,
  );
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function assertExecutionError(
  call: () => Promise<unknown>,
  code: string,
): Promise<ExecutionError> {
  try {
    await call();
  } catch (error) {
    assert.ok(
      error instanceof ExecutionError,
      `expected ExecutionError(${code}), received ${String(error)}`,
    );
    assert.equal(error.code, code);
    return error;
  }
  throw new Error(`expected ExecutionError(${code}), but the call resolved`);
}

function startRequest(
  attemptId: string,
  command: readonly string[],
  cwd: string,
  extra: {
    env?: Record<string, string>;
    limits?: ExecutionResourceLimits;
  } = {},
): StartExecutionRequest {
  return {
    attemptId,
    workspaceId: "runtime-conformance",
    command,
    cwd,
    ...(extra.env !== undefined ? { env: extra.env } : {}),
    ...(extra.limits !== undefined ? { limits: extra.limits } : {}),
  };
}

async function readRecord(
  path: string,
): Promise<ProcessGroupConformanceRecord> {
  return JSON.parse(await readFile(path, "utf8")) as ProcessGroupConformanceRecord;
}

async function outputContains(
  supervisor: ProcessGroupExecutionSupervisor,
  handle: RuntimeHandle,
  needle: string,
  timeoutMs = 10_000,
): Promise<void> {
  await waitFor(
    async () => (await supervisor.output(handle)).stdout.includes(needle),
    `output ${JSON.stringify(needle)}`,
    timeoutMs,
  );
}

// ---------------------------------------------------------------------------
// Capability and manifest records
// ---------------------------------------------------------------------------

test("capabilities record process-group limits honestly", () => {
  const capabilities = createProcessGroupExecutionSupervisor({
    stateDir: join(tmpdir(), "unused-conformance-state"),
  }).capabilities();

  assert.equal(capabilities.backendType, "process-group");
  assert.equal(capabilities.descendantControl, "partial");
  assert.equal(capabilities.restartRecovery, "partial");
  assert.deepEqual(capabilities.resourceLimits, {
    cpu: false,
    memory: false,
    processCount: false,
    openFiles: false,
  });
  assert.equal(capabilities.filesystemIsolation, "unsupported");
  assert.equal(capabilities.networkIsolation, "unsupported");
  assert.ok(capabilities.notes.length > 0);

  // A full descendant-tree requirement must surface as a capability gap; the
  // backend may never silently downgrade it.
  const gaps = executionCapabilityGaps(capabilities, {
    descendantControl: "full",
    restartRecovery: "full",
    resourceLimits: ["memory"],
  });
  assert.equal(gaps.length, 3);

  const withoutState = createProcessGroupExecutionSupervisor().capabilities();
  assert.equal(withoutState.restartRecovery, "unsupported");

  assert.equal(PROCESS_GROUP_CAPABILITY_LIMITS.fullDescendantTreeContainment, false);
  assert.equal(PROCESS_GROUP_CAPABILITY_LIMITS.cgroupEquivalentContainment, false);
  assert.equal(PROCESS_GROUP_CAPABILITY_LIMITS.setsidEscapeContained, false);
  assert.equal(PROCESS_GROUP_CAPABILITY_LIMITS.ptyAllocation, "unsupported");
  assert.equal(PROCESS_GROUP_CAPABILITY_LIMITS.resourceLimits, "unsupported");
  assert.equal(
    PROCESS_GROUP_CAPABILITY_LIMITS.orphanedDescendantsAfterLeaderExit,
    "refused-without-exact-leader-identity",
  );

  const required = [
    "setsid-escape",
    "orphaned-grandchildren",
    "closed-output-pipes",
    "controller-restart-attach",
    "cancel-never-rerun",
    "resource-cleanup",
    "parallel-isolation",
    "identity-reuse",
  ];
  assert.deepEqual(
    RUNTIME_CONFORMANCE_CASES.map((entry) => entry.id),
    required,
  );
  for (const entry of RUNTIME_CONFORMANCE_CASES) {
    assert.ok(entry.title.length > 0);
    assert.ok(entry.description.length > 0);
    assert.ok(
      ["enforced", "observed", "documented-limit"].includes(entry.guarantee),
    );
  }
  assert.equal(
    RUNTIME_CONFORMANCE_CASES.find((entry) => entry.id === "setsid-escape")
      ?.guarantee,
    "documented-limit",
  );

  const base = {
    handle: {
      backendType: "process-group" as const,
      handle: "pg1:1:00",
    },
    desiredState: "running" as const,
    observedAt: new Date().toISOString(),
    leaseDeadline: null,
  };
  assert.equal(
    restartDisposition({ ...base, observedState: "stopped" }),
    "do-not-rerun",
  );
  assert.equal(
    restartDisposition({ ...base, observedState: "exited" }),
    "do-not-rerun",
  );
  assert.equal(
    restartDisposition({ ...base, observedState: "running" }),
    "attach",
  );
  assert.equal(
    restartDisposition({ ...base, observedState: "lost" }),
    "needs-human",
  );
});

// ---------------------------------------------------------------------------
// Cancellation, restart and re-attach
// ---------------------------------------------------------------------------

test(
  "controller kill then re-attach by RuntimeHandle",
  { skip: POSIX_SKIP },
  async (t) => {
    const harness = await FixtureHarness.create();
    t.after(() => harness.cleanup());

    const stateDir = await harness.directory("state");
    const tempRoot = await harness.directory("work");
    const worker = await harness.writeFixture("worker", WORKER_FIXTURE);
    const controllerSource = await harness.writeController(
      "controller",
      CONTROLLER_FIXTURE,
    );
    const readyFile = harness.path("controller-ready.json");

    const require = createRequire(import.meta.url);
    // The package's "." export is the ESM loader (dist/loader.mjs); the
    // subpath is not exported, so resolve the entry instead of guessing it.
    const tsxLoader = pathToFileURL(require.resolve("tsx")).href;
    const conformanceModule = new URL(
      "../src/execution/conformance.ts",
      import.meta.url,
    ).href;

    const controller = spawn(
      process.execPath,
      [
        "--import",
        tsxLoader,
        controllerSource,
        stateDir,
        tempRoot,
        worker,
        readyFile,
      ],
      {
        cwd: harness.root,
        env: { ...process.env, CONFORMANCE_MODULE: conformanceModule },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    harness.adopt(controller);

    let controllerLog = "";
    controller.stdout?.on("data", (chunk: Buffer) => {
      controllerLog += chunk.toString("utf8");
    });
    controller.stderr?.on("data", (chunk: Buffer) => {
      controllerLog += chunk.toString("utf8");
    });

    let ready: { handle: unknown; controllerPid: number };
    try {
      ready = await waitForValue(
        async () => {
          try {
            return JSON.parse(await readFile(readyFile, "utf8")) as {
              handle: unknown;
              controllerPid: number;
            };
          } catch {
            return undefined;
          }
        },
        `controller ready (log: ${controllerLog})`,
        15_000,
      );
    } catch (error) {
      throw new Error(
        `${(error as Error).message}\ncontroller log:\n${controllerLog}`,
      );
    }

    const handle = parseRuntimeHandle(ready.handle);
    assert.ok(handle !== undefined, "controller persisted a valid handle");
    assert.equal(handle.backendType, "process-group");
    assert.match(handle.handle, /^pg1:[0-9]+:[0-9a-f]+$/);
    assert.equal(ready.controllerPid, controller.pid);

    const workerIdentity = harness.trackHandle(handle);
    assert.equal(
      compareProcessIdentity(
        workerIdentity,
        await captureExact(workerIdentity.pid),
      ),
      "match",
      "the worker must be alive before the controller is killed",
    );

    controller.kill("SIGKILL");
    await waitFor(
      () => controller.exitCode !== null || controller.signalCode !== null,
      "the controller to be killed",
      5_000,
    );
    assert.ok(
      await isAlive(workerIdentity),
      "the worker survives an abrupt controller death",
    );

    // A brand-new controller has no in-memory unit: everything below is
    // recovered from the handle and the durable record.
    const restarted = createProcessGroupExecutionSupervisor({
      stateDir,
      tempRoot,
    });
    const attached = await restarted.attach(handle);
    assert.ok(
      sameRuntimeHandle(attached.handle, handle),
      "Attach must return byte-identical handle authority",
    );
    assert.equal(attached.status.observedState, "running");
    assert.equal(attached.status.desiredState, "running");
    assert.equal(restartDisposition(attached.status), "attach");
    assert.match(
      (await restarted.output(handle)).stdout,
      /worker-ready/,
      "the flushed output prefix must survive the controller kill",
    );

    const beforeStop = await restarted.resources(handle);
    assert.equal(beforeStop.tempDirOwnership, "verified");
    assert.equal(beforeStop.recordExists, true);
    assert.ok(beforeStop.recordPath !== null);
    assert.equal(beforeStop.pty, null);
    assert.equal(beforeStop.groupIdentity, "match");

    const stopped = await restarted.stop(handle, {
      reason: "operator",
      graceMs: 1_500,
    });
    assert.equal(stopped.observedState, "stopped");
    assert.equal(stopped.desiredState, "stopped");
    assert.equal(stopped.handle.handle, handle.handle);

    await waitFor(
      async () => !(await isAlive(workerIdentity)),
      "the re-attached worker to exit",
      5_000,
    );

    const collected = await restarted.collect(handle);
    assert.match(collected.stdout, /worker-ready/);
    assert.equal(collected.outputTruncated, false);
    assert.equal(collected.exit.signal, "SIGTERM");

    const recordPath = beforeStop.recordPath;
    assert.ok(recordPath !== null);
    const persisted = await readRecord(recordPath);
    assert.equal(persisted.attemptId, "controller-restart-attach");
    assert.equal(persisted.desiredState, "stopped");
    assert.equal(persisted.observedState, "stopped");
    assert.equal(persisted.stopReason, "operator");
    assert.ok(
      sameRuntimeHandle(persisted.handle, handle),
      "the durable record carries handle authority, not diagnostics",
    );

    const destroyed = await restarted.destroy(handle);
    assert.ok(destroyed.released.includes("temp-dir"));
    assert.ok(destroyed.released.includes("durable-record"));
    assert.equal(await pathExists(beforeStop.tempDir as string), false);
    assert.equal(await pathExists(recordPath), false);

    await assertExecutionError(
      () => restarted.inspect(handle),
      "not-found",
    );
    await assertExecutionError(
      () => restarted.attach(handle),
      "not-found",
    );
    await assertExecutionError(
      () => restarted.stop(handle, { reason: "operator" }),
      "not-found",
    );
    await assertExecutionError(() => restarted.collect(handle), "not-found");
    await assertExecutionError(() => restarted.destroy(handle), "not-found");
    assert.equal(await isAlive(workerIdentity), false);
  },
);

test(
  "an explicitly cancelled attempt is never rerun by restart",
  { skip: POSIX_SKIP },
  async (t) => {
    const harness = await FixtureHarness.create();
    t.after(() => harness.cleanup());

    const stateDir = await harness.directory("state");
    const tempRoot = await harness.directory("work");
    const worker = await harness.writeFixture("worker", WORKER_FIXTURE);

    const first = createProcessGroupExecutionSupervisor({ stateDir, tempRoot });
    const request = startRequest("cancelled-attempt", [process.execPath, worker], tempRoot);
    const handle = await first.start(request);
    const identity = harness.trackHandle(handle);
    await outputContains(first, handle, "worker-ready");

    const stopped = await first.stop(handle, { reason: "cancel", graceMs: 1_500 });
    assert.equal(stopped.observedState, "stopped");
    assert.equal(stopped.desiredState, "stopped");
    await first.flush();

    const recordPath = first.recordPathFor(handle);
    assert.ok(recordPath !== null);
    const record = await readRecord(recordPath);
    assert.equal(record.stopReason, "cancel");
    assert.equal(record.observedState, "stopped");
    assert.equal(record.desiredState, "stopped");
    assert.equal(await isAlive(identity), false);

    // Restart: a fresh supervisor, no in-memory state.
    const restarted = createProcessGroupExecutionSupervisor({
      stateDir,
      tempRoot,
    });
    const inspected = await restarted.inspect(handle);
    assert.equal(inspected.observedState, "stopped");
    assert.equal(inspected.desiredState, "stopped");
    assert.equal(restartDisposition(inspected), "do-not-rerun");

    const attached = await restarted.attach(handle);
    assert.equal(attached.status.observedState, "stopped");
    assert.equal(restartDisposition(attached.status), "do-not-rerun");

    // Restart reconciliation must never rerun the cancelled attempt.
    await assertExecutionError(
      () => restarted.start(request),
      "already-exists",
    );
    assert.ok(
      await pathExists(recordPath),
      "a rejected rerun must not damage the terminal record",
    );

    const collected = await restarted.collect(handle);
    assert.match(collected.stdout, /worker-ready/);
    assert.equal(await isAlive(identity), false);

    const destroyed = await restarted.destroy(handle);
    assert.ok(destroyed.released.includes("durable-record"));
    assert.equal(await pathExists(recordPath), false);
  },
);

// ---------------------------------------------------------------------------
// Process-group boundaries
// ---------------------------------------------------------------------------

test(
  "a setsid escape leaves no residual after exact-identity cleanup",
  { skip: POSIX_SKIP },
  async (t) => {
    const harness = await FixtureHarness.create();
    t.after(() => harness.cleanup());

    const stateDir = await harness.directory("state");
    const tempRoot = await harness.directory("work");
    const grandchild = await harness.writeFixture(
      "setsid-child",
      SETSID_CHILD_FIXTURE,
    );
    const leader = await harness.writeFixture("setsid-leader", SETSID_LEADER_FIXTURE);

    const supervisor = createProcessGroupExecutionSupervisor({
      stateDir,
      tempRoot,
    });
    const handle = await supervisor.start(
      startRequest(
        "setsid-escape",
        [process.execPath, leader, tempRoot, grandchild],
        tempRoot,
      ),
    );
    const leaderIdentity = harness.trackHandle(handle);

    const leaderPid = await readPidFile(join(tempRoot, "escape-leader.pid"));
    const childPid = await readPidFile(join(tempRoot, "escape-child.self.pid"));
    const escapee = harness.track(await captureExact(childPid));

    assert.equal(leaderPid, leaderIdentity.pid);
    assert.equal(
      escapee.pid,
      escapee.pgid,
      "a detached grandchild becomes its own process-group leader",
    );
    assert.notEqual(
      escapee.pgid,
      leaderIdentity.pgid,
      "setsid must take the escapee out of the managed group",
    );

    const stopped = await supervisor.stop(handle, {
      reason: "operator",
      graceMs: 1_500,
    });
    assert.equal(stopped.observedState, "stopped");
    assert.equal(await isAlive(leaderIdentity), false);

    // Documented limit: the backend stopped its group and did not contain the
    // escapee. The suite proves the escapee exists rather than pretending the
    // stop covered it.
    assert.equal(
      await isAlive(escapee),
      true,
      "setsid escapees are outside process-group containment",
    );
    assert.equal(PROCESS_GROUP_CAPABILITY_LIMITS.setsidEscapeContained, false);
    assert.equal(supervisor.capabilities().descendantControl, "partial");

    const resources = await supervisor.resources(handle);
    assert.equal(resources.groupMembers, 0);

    // Harness cleanup by exact re-captured identity only.
    await reapExact(escapee);
    assert.equal(await isAlive(escapee), false);
    assert.equal(await isAlive(leaderIdentity), false);

    const destroyed = await supervisor.destroy(handle);
    assert.ok(destroyed.released.includes("temp-dir"));
    assert.equal(await pathExists(resources.tempDir as string), false);
    assert.equal(await pathExists(join(tempRoot, "escape-child.self.pid")), true);
    assert.equal(await isAlive(escapee), false, "no residual after cleanup");
  },
);

test(
  "orphaned grandchildren after leader exit are never signalled",
  { skip: POSIX_SKIP },
  async (t) => {
    const harness = await FixtureHarness.create();
    t.after(() => harness.cleanup());

    const stateDir = await harness.directory("state");
    const tempRoot = await harness.directory("work");
    const grandchild = await harness.writeFixture(
      "orphan-child",
      ORPHAN_CHILD_FIXTURE,
    );
    const leader = await harness.writeFixture(
      "orphan-leader",
      ORPHAN_LEADER_FIXTURE,
    );

    const supervisor = createProcessGroupExecutionSupervisor({
      stateDir,
      tempRoot,
    });
    const handle = await supervisor.start(
      startRequest(
        "orphaned-grandchildren",
        [process.execPath, leader, tempRoot, grandchild],
        tempRoot,
      ),
    );
    const leaderIdentity = harness.trackHandle(handle);

    await readPidFile(join(tempRoot, "orphan-leader.pid"));
    const childPid = await readPidFile(join(tempRoot, "orphan-child.pid"));
    const orphan = harness.track(await captureExact(childPid));
    assert.equal(
      orphan.pgid,
      leaderIdentity.pgid,
      "the grandchild must be inside the managed group",
    );

    await writeFile(join(tempRoot, "orphan.go"), "exit\n", { mode: 0o600 });
    await waitFor(
      async () => !(await isAlive(leaderIdentity)),
      "the leader to exit",
      8_000,
    );

    const lost = await waitForValue(
      async () => {
        const status = await supervisor.inspect(handle);
        return status.observedState === "lost" ? status : undefined;
      },
      "the unit to be reported lost with orphaned group members",
    );
    assert.equal(lost.observedState, "lost");
    assert.match(lost.detail ?? "", /leader exited|remain/i);
    assert.equal(await isAlive(orphan), true);

    // The leader identity is absent, so the backend must refuse to signal.
    const error = await assertExecutionError(
      () => supervisor.stop(handle, { reason: "cancel", graceMs: 300 }),
      "ambiguous",
    );
    assert.match(error.message, /leader|group/i);
    assert.equal(
      await pathExists(join(tempRoot, "orphan-signals.log")),
      false,
      "Stop must not signal orphaned descendants without the leader identity",
    );
    assert.equal(await isAlive(orphan), true);

    const afterStop = await supervisor.inspect(handle);
    assert.equal(afterStop.observedState, "lost");
    assert.equal(afterStop.desiredState, "stopped");
    assert.equal(restartDisposition(afterStop), "needs-human");

    // Collect and destroy must not fabricate a terminal unit.
    await assertExecutionError(() => supervisor.collect(handle), "not-exited");
    await assertExecutionError(() => supervisor.destroy(handle), "conflict");

    // Once the orphan is gone (harness cleanup by exact identity), the leader
    // exit evidence makes the unit provably exited.
    await reapExact(orphan);
    const exited = await waitForValue(
      async () => {
        const status = await supervisor.inspect(handle);
        return status.observedState === "exited" ? status : undefined;
      },
      "the unit to settle to exited after orphan cleanup",
    );
    assert.equal(exited.exit?.exitCode, 0);

    const collected = await supervisor.collect(handle);
    assert.equal(collected.exit.exitCode, 0);
    const destroyed = await supervisor.destroy(handle);
    assert.ok(destroyed.released.includes("temp-dir"));
    assert.ok(destroyed.released.includes("durable-record"));
    assert.equal(await isAlive(orphan), false);
  },
);

test(
  "closed output pipes held by an escapee never block exit or collect",
  { skip: POSIX_SKIP },
  async (t) => {
    const harness = await FixtureHarness.create();
    t.after(() => harness.cleanup());

    const stateDir = await harness.directory("state");
    const tempRoot = await harness.directory("work");
    const holder = await harness.writeFixture("pipe-holder", PIPE_HOLDER_FIXTURE);
    const leader = await harness.writeFixture("pipe-leader", PIPE_LEADER_FIXTURE);

    const supervisor = createProcessGroupExecutionSupervisor({
      stateDir,
      tempRoot,
      // Large enough that the suite observes the still-open pipe; the backend
      // must not rely on this drain to observe exit.
      pipeDrainMs: 30_000,
    });
    const handle = await supervisor.start(
      startRequest(
        "closed-output-pipes",
        [process.execPath, leader, tempRoot, holder],
        tempRoot,
      ),
    );
    const leaderIdentity = harness.trackHandle(handle);

    const childPid = await readPidFile(join(tempRoot, "pipes-child.self.pid"));
    const pipeHolder = harness.track(await captureExact(childPid));
    assert.notEqual(pipeHolder.pgid, leaderIdentity.pgid);
    await outputContains(supervisor, handle, "pipe-holder-ready");

    await writeFile(join(tempRoot, "pipes.go"), "exit\n", { mode: 0o600 });
    const exited = await waitForValue(
      async () => {
        const status = await supervisor.inspect(handle);
        return status.observedState === "exited" ? status : undefined;
      },
      "the leader to exit while its output pipe stays open",
    );
    assert.equal(exited.exit?.exitCode, 0);
    assert.equal(await isAlive(pipeHolder), true);

    const resources = await supervisor.resources(handle);
    assert.equal(resources.stdoutPipeOpen, true);
    assert.equal(resources.stderrPipeOpen, true);
    assert.equal(resources.pty, null);

    const startedAt = Date.now();
    const collected = await supervisor.collect(handle);
    const elapsed = Date.now() - startedAt;
    assert.ok(
      elapsed < 2_000,
      `Collect waited ${elapsed}ms for an inherited open pipe`,
    );
    assert.match(collected.stdout, /pipe-holder-ready/);

    const destroyed = await supervisor.destroy(handle);
    assert.ok(destroyed.released.includes("stdout-pipe"));
    assert.ok(destroyed.released.includes("stderr-pipe"));
    assert.ok(destroyed.released.includes("temp-dir"));
    assert.ok(destroyed.released.includes("durable-record"));
    assert.equal(await pathExists(resources.tempDir as string), false);

    await reapExact(pipeHolder);
    assert.equal(await isAlive(pipeHolder), false, "no residual after cleanup");
  },
);

test(
  "a trusted-identity mismatch is never signalled",
  { skip: POSIX_SKIP },
  async (t) => {
    const harness = await FixtureHarness.create();
    t.after(() => harness.cleanup());

    const stateDir = await harness.directory("state");
    const tempRoot = await harness.directory("work");
    const standaloneSource = await harness.writeFixture(
      "standalone",
      SIGNAL_LOGGING_STANDALONE_FIXTURE,
    );
    const standalone = spawn(process.execPath, [standaloneSource, tempRoot], {
      detached: true,
      stdio: "ignore",
    });
    standalone.unref();
    const standalonePid = await readPidFile(join(tempRoot, "standalone.pid"));
    const realIdentity = harness.track(await captureExact(standalonePid));
    assert.equal(realIdentity.pid, realIdentity.pgid);

    // Fabricate durable authority for the same pgid but a different OS start
    // identity. This simulates pid/pgid reuse after a controller restart.
    const fakeHandle = processGroupRuntimeHandle({
      pid: realIdentity.pid,
      pgid: realIdentity.pgid,
      startedAt: "Sat Jan  1 00:00:00 2000",
    });
    const fakeIdentity = processGroupIdentityFromRuntimeHandle(fakeHandle);
    assert.ok(fakeIdentity !== undefined);
    assert.notEqual(fakeIdentity.startedAt, realIdentity.startedAt);

    const record: ProcessGroupConformanceRecord = {
      version: PROCESS_GROUP_RECORD_VERSION,
      handle: fakeHandle,
      attemptId: "identity-reuse",
      workspaceId: "runtime-conformance",
      command: [process.execPath, "-e", "0"],
      desiredState: "running",
      observedState: "running",
      leaseDeadline: null,
      startedAt: new Date().toISOString(),
      observedAt: new Date().toISOString(),
      stdout: "",
      stderr: "",
      outputTruncated: false,
      tempDir: null,
      tempRoot,
    };
    const recordPath = processGroupRecordPath(stateDir, fakeHandle);
    assert.ok(recordPath !== undefined);
    await mkdir(join(stateDir, "units"), { recursive: true, mode: 0o700 });
    await writeFile(recordPath, JSON.stringify(record, null, 2) + "\n", {
      mode: 0o600,
    });

    const supervisor = createProcessGroupExecutionSupervisor({
      stateDir,
      tempRoot,
    });
    const inspected = await supervisor.inspect(fakeHandle);
    assert.equal(inspected.observedState, "lost");
    assert.match(inspected.detail ?? "", /reused|unverifiable/i);

    const resources = await supervisor.resources(fakeHandle);
    assert.equal(resources.groupIdentity, "mismatch");
    assert.equal(resources.recordExists, true);

    const error = await assertExecutionError(
      () => supervisor.stop(fakeHandle, { reason: "operator", graceMs: 300 }),
      "ambiguous",
    );
    assert.match(error.message, /reused|unrelated/i);
    assert.equal(
      await pathExists(join(tempRoot, "standalone-signals.log")),
      false,
      "a mismatched start identity must never authorize a signal",
    );
    assert.equal(await isAlive(realIdentity), true);
    assert.equal(restartDisposition(inspected), "needs-human");

    // A lost unit is not terminal evidence: destroy must not delete it.
    await assertExecutionError(
      () => supervisor.destroy(fakeHandle),
      "conflict",
    );
    assert.equal(await pathExists(recordPath), true);

    await reapExact(realIdentity);
    assert.equal(await isAlive(realIdentity), false);
  },
);

// ---------------------------------------------------------------------------
// Resource cleanup and parallel isolation
// ---------------------------------------------------------------------------

test(
  "destroy releases pipes, temp dir, records and handles without a PTY",
  { skip: POSIX_SKIP },
  async (t) => {
    const harness = await FixtureHarness.create();
    t.after(() => harness.cleanup());

    const stateDir = await harness.directory("state");
    const tempRoot = await harness.directory("work");
    const worker = await harness.writeFixture("worker", WORKER_FIXTURE);

    const supervisor = createProcessGroupExecutionSupervisor({
      stateDir,
      tempRoot,
    });

    // The backend cannot enforce resource limits and must say so rather than
    // accept and ignore them.
    await assertExecutionError(
      () =>
        supervisor.start(
          startRequest(
            "resource-limits",
            [process.execPath, worker],
            tempRoot,
            { limits: { memoryBytes: 1_048_576 } },
          ),
        ),
      "unsupported",
    );

    const handle = await supervisor.start(
      startRequest("resource-cleanup", [process.execPath, worker], tempRoot),
    );
    const identity = harness.trackHandle(handle);
    await outputContains(supervisor, handle, "worker-ready");

    const before = await supervisor.resources(handle);
    assert.equal(before.recordExists, true);
    assert.equal(before.tempDirExists, true);
    assert.equal(before.tempDirOwnership, "verified");
    assert.equal(before.stdoutPipeOpen, true);
    assert.equal(before.stderrPipeOpen, true);
    assert.equal(before.pty, null);
    assert.equal(before.childExited, false);
    assert.equal(before.groupIdentity, "match");
    assert.ok((before.groupMembers ?? 0) >= 1);

    const stopped = await supervisor.stop(handle, {
      reason: "operator",
      graceMs: 1_500,
    });
    assert.equal(stopped.observedState, "stopped");
    const collected = await supervisor.collect(handle);
    assert.match(collected.stdout, /worker-ready/);

    const destroyed = await supervisor.destroy(handle);
    assert.ok(destroyed.released.includes("temp-dir"));
    assert.ok(destroyed.released.includes("durable-record"));
    assert.equal(await pathExists(before.tempDir as string), false);
    assert.equal(await pathExists(before.recordPath as string), false);
    assert.equal(await isAlive(identity), false);

    await assertExecutionError(() => supervisor.inspect(handle), "not-found");
    await assertExecutionError(() => supervisor.collect(handle), "not-found");
    await assertExecutionError(() => supervisor.destroy(handle), "not-found");
    await assertExecutionError(
      () => supervisor.output(handle),
      "not-found",
    );
    assert.equal(await pathExists(before.tempDir as string), false);
  },
);

test(
  "stopping one unit leaves a parallel unit unaffected",
  { skip: POSIX_SKIP },
  async (t) => {
    const harness = await FixtureHarness.create();
    t.after(() => harness.cleanup());

    const stateDir = await harness.directory("state");
    const tempRoot = await harness.directory("work");
    const worker = await harness.writeFixture("worker", LABELLED_WORKER_FIXTURE);

    const supervisor = createProcessGroupExecutionSupervisor({
      stateDir,
      tempRoot,
    });
    const environment = (label: string): Record<string, string> => ({
      ...(process.env as Record<string, string>),
      UNIT_LABEL: label,
    });

    const handleA = await supervisor.start(
      startRequest(
        "parallel-a",
        [process.execPath, worker],
        tempRoot,
        { env: environment("A") },
      ),
    );
    const handleB = await supervisor.start(
      startRequest(
        "parallel-b",
        [process.execPath, worker],
        tempRoot,
        { env: environment("B") },
      ),
    );
    const identityA = harness.trackHandle(handleA);
    const identityB = harness.trackHandle(handleB);

    await outputContains(supervisor, handleA, "ready:A");
    await outputContains(supervisor, handleB, "ready:B");

    assert.notEqual(runtimeHandleKey(handleA), runtimeHandleKey(handleB));
    assert.notEqual(identityA.pgid, identityB.pgid);

    await supervisor.stop(handleA, { reason: "cancel", graceMs: 1_500 });
    assert.equal(await isAlive(identityA), false);

    assert.equal(
      await isAlive(identityB),
      true,
      "stopping one unit must not signal a parallel unit",
    );
    const statusB = await supervisor.inspect(handleB);
    assert.equal(statusB.observedState, "running");
    assert.equal(statusB.desiredState, "running");
    assert.match((await supervisor.output(handleB)).stdout, /ready:B/);

    await supervisor.stop(handleB, { reason: "operator", graceMs: 1_500 });
    assert.equal(await isAlive(identityB), false);

    const collectedB = await supervisor.collect(handleB);
    assert.equal(collectedB.exit.signal, "SIGTERM");
    assert.match(collectedB.stdout, /ready:B/);

    await supervisor.destroy(handleA);
    await supervisor.destroy(handleB);
    assert.equal(await isAlive(identityA), false);
    assert.equal(await isAlive(identityB), false);
  },
);

/**
 * ExecutionSupervisor v0 interface tests (design/execution-supervisor-v0.md).
 *
 * The mock backend exercises the platform-neutral contract only: handle
 * authority, lifecycle states, cancellation semantics and error
 * classification. No real process is started here.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ATTEMPT_DESIRED_STATES,
  ATTEMPT_OBSERVED_STATES,
  EXECUTION_BACKEND_TYPES,
} from "../src/statestore/schema.js";
import {
  EXECUTION_DESIRED_STATES,
  EXECUTION_INTERFACE_VERSION,
  EXECUTION_OBSERVED_STATES,
  MAX_EXECUTION_OUTPUT_CHARS,
  MAX_RUNTIME_HANDLE_LENGTH,
  MOCK_BACKEND_TYPE,
  executionCapabilityGaps,
  isRuntimeBackendType,
  parseExecutionHandle,
  parseRuntimeHandle,
  runtimeHandleKey,
  sameRuntimeHandle,
  validateStartExecutionRequest,
  validateStopExecutionRequest,
  type ExecutionHandle,
  type RuntimeHandle,
  type StartExecutionRequest,
} from "../src/execution/types.js";
import {
  ExecutionError,
  asExecutionError,
  createMockExecutionBackendState,
  createMockExecutionSupervisor,
  defaultMockExecutionCapabilities,
  throwIfExecutionAborted,
  type ExecutionErrorCode,
  type ExecutionOperation,
} from "../src/execution/supervisor.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function fixedClock(
  start = Date.parse("2026-11-05T00:00:00.000Z"),
): () => Date {
  let current = start;
  return () => {
    current += 1_000;
    return new Date(current);
  };
}

function startRequest(
  overrides: Partial<StartExecutionRequest> = {},
): StartExecutionRequest {
  return {
    attemptId: "attempt-1",
    workspaceId: "workspace-1",
    command: ["worker", "--run"],
    ...overrides,
  };
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

function executionError(
  code: ExecutionErrorCode,
  operation: ExecutionOperation,
  retryable?: boolean,
): (error: unknown) => boolean {
  return (error) => {
    assert.ok(
      error instanceof ExecutionError,
      `expected ExecutionError, got ${String(error)}`,
    );
    assert.equal(error.code, code);
    assert.equal(error.operation, operation);
    if (retryable !== undefined) {
      assert.equal(error.retryable, retryable);
    }
    return true;
  };
}

// ---------------------------------------------------------------------------
// Handle authority
// ---------------------------------------------------------------------------

test("start returns a stable handle with desired and observed running", async () => {
  const supervisor = createMockExecutionSupervisor({ now: fixedClock() });
  const handle = await supervisor.start(startRequest(), {});

  assert.equal(handle.backendType, MOCK_BACKEND_TYPE);
  assert.equal(typeof handle.handle, "string");
  assert.ok(handle.handle.length > 0);
  assert.deepEqual(handle.diagnostics, { pid: null, pgid: null });
  assert.deepEqual(parseRuntimeHandle(handle), handle);

  const status = await supervisor.inspect(handle, {});
  assert.deepEqual(status.handle, handle);
  assert.equal(status.desiredState, "running");
  assert.equal(status.observedState, "running");
  assert.equal(status.leaseDeadline, null);
  assert.ok(!Number.isNaN(Date.parse(status.observedAt)));
});

test("handle authority is (backendType, handle), not diagnostics", async () => {
  const supervisor = createMockExecutionSupervisor({ now: fixedClock() });
  const handle = await supervisor.start(startRequest(), {});
  const withDiagnostics: RuntimeHandle = {
    ...handle,
    diagnostics: { pid: 4_242, pgid: 4_242 },
  };

  assert.equal(sameRuntimeHandle(handle, withDiagnostics), true);
  assert.equal(runtimeHandleKey(handle), runtimeHandleKey(withDiagnostics));
  assert.deepEqual(
    await supervisor.inspect(withDiagnostics, {}),
    await supervisor.inspect(handle, {}),
  );

  assert.notEqual(
    runtimeHandleKey(handle),
    runtimeHandleKey({ ...handle, backendType: "process-group" as const }),
  );
  await assert.rejects(
    supervisor.inspect(
      { ...handle, backendType: "process-group" as const },
      {},
    ),
    executionError("invalid-handle", "inspect"),
  );
});

test("parseRuntimeHandle rejects malformed authority and drops stray pids", () => {
  assert.equal(parseRuntimeHandle(null), undefined);
  assert.equal(parseRuntimeHandle({}), undefined);
  assert.equal(
    parseRuntimeHandle({ backendType: "mock", handle: "" }),
    undefined,
  );
  assert.equal(
    parseRuntimeHandle({ backendType: "mock", handle: " mock-1" }),
    undefined,
  );
  assert.equal(
    parseRuntimeHandle({ backendType: "mock", handle: "mock 1" }),
    undefined,
  );
  assert.equal(
    parseRuntimeHandle({
      backendType: "mock",
      handle: "x".repeat(MAX_RUNTIME_HANDLE_LENGTH + 1),
    }),
    undefined,
  );
  assert.equal(
    parseRuntimeHandle({ backendType: "unknown", handle: "mock-1" }),
    undefined,
  );
  assert.equal(
    parseRuntimeHandle({
      backendType: "mock",
      handle: "mock-1",
      diagnostics: { pid: 0, pgid: null },
    }),
    undefined,
  );
  assert.equal(
    parseRuntimeHandle({
      backendType: "mock",
      handle: "mock-1",
      diagnostics: { pid: null, pgid: -1 },
    }),
    undefined,
  );
  // A stray top-level pid is dropped, never promoted into the handle.
  assert.deepEqual(
    parseRuntimeHandle({ backendType: "mock", handle: "mock-1", pid: 99 }),
    { backendType: "mock", handle: "mock-1" },
  );
  assert.deepEqual(
    parseRuntimeHandle({
      backendType: "mock",
      handle: "mock-1",
      diagnostics: { pid: 10, pgid: 10 },
    }),
    {
      backendType: "mock",
      handle: "mock-1",
      diagnostics: { pid: 10, pgid: 10 },
    },
  );
});

test("reported handles and statuses are copies", async () => {
  const supervisor = createMockExecutionSupervisor({ now: fixedClock() });
  const handle = await supervisor.start(startRequest(), {});
  const authority: RuntimeHandle = {
    backendType: handle.backendType,
    handle: handle.handle,
  };
  handle.handle = "tampered";

  const status = await supervisor.inspect(authority, {});
  assert.equal(status.handle.handle, authority.handle);
  status.handle.handle = "tampered-again";
  assert.equal(
    (await supervisor.inspect(authority, {})).handle.handle,
    authority.handle,
  );
});

// ---------------------------------------------------------------------------
// Request validation and capability gating
// ---------------------------------------------------------------------------

test("request validation fails closed on unknown and unsafe fields", async () => {
  assert.equal(validateStartExecutionRequest(startRequest()), undefined);
  assert.equal(
    typeof validateStartExecutionRequest({
      ...startRequest(),
      command: [],
    }),
    "string",
  );
  assert.equal(
    typeof validateStartExecutionRequest({
      ...startRequest(),
      privileged: true,
    }),
    "string",
  );
  assert.equal(
    typeof validateStartExecutionRequest({
      ...startRequest(),
      attemptId: "bad id",
    }),
    "string",
  );
  assert.equal(
    typeof validateStartExecutionRequest({
      ...startRequest(),
      env: { "BAD-NAME": "x" },
    }),
    "string",
  );
  assert.equal(
    typeof validateStartExecutionRequest({
      ...startRequest(),
      limits: { memoryBytes: 0 },
    }),
    "string",
  );
  assert.equal(
    typeof validateStartExecutionRequest({
      ...startRequest(),
      leaseDeadline: "tomorrow",
    }),
    "string",
  );

  assert.equal(validateStopExecutionRequest({ reason: "cancel" }), undefined);
  assert.equal(typeof validateStopExecutionRequest({}), "string");
  assert.equal(
    typeof validateStopExecutionRequest({ reason: "cancel", graceMs: -1 }),
    "string",
  );
  assert.equal(
    typeof validateStopExecutionRequest({ reason: "cancel", extra: true }),
    "string",
  );

  const supervisor = createMockExecutionSupervisor();
  await assert.rejects(
    supervisor.start({ ...startRequest(), command: [] }, {}),
    executionError("invalid-request", "start"),
  );
  await assert.rejects(
    supervisor.stop(
      { backendType: "mock", handle: "mock-x" },
      { reason: "cancel", graceMs: -1 },
      {},
    ),
    executionError("invalid-request", "stop"),
  );
});

test("start refuses resource limits the backend does not declare", async () => {
  const supervisor = createMockExecutionSupervisor({ now: fixedClock() });
  await assert.rejects(
    supervisor.start(startRequest({ limits: { memoryBytes: 1_024 } }), {}),
    executionError("unsupported", "start"),
  );
  // The refused start left no runtime record behind.
  await supervisor.start(startRequest(), {});

  const permissive = createMockExecutionSupervisor({
    now: fixedClock(),
    capabilities: {
      ...defaultMockExecutionCapabilities(),
      resourceLimits: {
        cpu: false,
        memory: true,
        processCount: false,
        openFiles: false,
      },
    },
  });
  const handle = await permissive.start(
    startRequest({ limits: { memoryBytes: 1_024 } }),
    {},
  );
  assert.equal((await permissive.inspect(handle, {})).observedState, "running");
});

test("capability model covers control, recovery, limits and isolation", () => {
  const capabilities = defaultMockExecutionCapabilities();

  assert.deepEqual(executionCapabilityGaps(capabilities, {}), []);
  assert.equal(
    executionCapabilityGaps(capabilities, {
      descendantControl: "unsupported",
    }).length,
    0,
  );
  assert.equal(
    executionCapabilityGaps(capabilities, { descendantControl: "partial" })
      .length,
    1,
  );
  assert.equal(
    executionCapabilityGaps(capabilities, { restartRecovery: "full" }).length,
    0,
  );
  assert.equal(
    executionCapabilityGaps(capabilities, { restartRecovery: "unsupported" })
      .length,
    0,
  );
  assert.equal(
    executionCapabilityGaps(capabilities, { resourceLimits: ["memory"] })
      .length,
    1,
  );
  assert.equal(
    executionCapabilityGaps(capabilities, { filesystemIsolation: "partial" })
      .length,
    1,
  );
  assert.equal(
    executionCapabilityGaps(capabilities, { networkIsolation: "unsupported" })
      .length,
    0,
  );
  assert.ok(capabilities.notes.length > 0);
  assert.equal(Object.isFrozen(capabilities), true);
  assert.equal(Object.isFrozen(capabilities.resourceLimits), true);
  assert.equal(Object.isFrozen(capabilities.notes), true);
});

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

test("desired and observed state stay distinct after a natural exit", async () => {
  const supervisor = createMockExecutionSupervisor({ now: fixedClock() });
  const handle = await supervisor.start(startRequest(), {});

  const exited = supervisor.complete(
    handle,
    { exitCode: 0 },
    { stdout: "done\n" },
  );
  assert.equal(exited.desiredState, "running");
  assert.equal(exited.observedState, "exited");
  assert.deepEqual(exited.exit, {
    exitCode: 0,
    signal: null,
    exitedAt: exited.observedAt,
  });

  const collected = await supervisor.collect(handle, {});
  assert.equal(collected.stdout, "done\n");
  assert.equal(collected.stderr, "");
  assert.equal(collected.outputTruncated, false);
  assert.equal(collected.exit.exitCode, 0);

  const destroyed = await supervisor.destroy(handle, {});
  assert.deepEqual(destroyed.released, []);
  assert.ok(!Number.isNaN(Date.parse(destroyed.destroyedAt)));
  await assert.rejects(
    supervisor.inspect(handle, {}),
    executionError("not-found", "inspect"),
  );
});

test("collect before exit is a retryable not-exited classification", async () => {
  const supervisor = createMockExecutionSupervisor({ now: fixedClock() });
  const handle = await supervisor.start(startRequest(), {});

  await assert.rejects(
    supervisor.collect(handle, {}),
    executionError("not-exited", "collect", true),
  );
  assert.equal((await supervisor.inspect(handle, {})).observedState, "running");
});

test("stop is idempotent and a cancelled call never stops the unit", async () => {
  const supervisor = createMockExecutionSupervisor({ now: fixedClock() });
  const handle = await supervisor.start(startRequest(), {});

  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    supervisor.stop(
      handle,
      { reason: "cancel" },
      { signal: controller.signal },
    ),
    executionError("cancelled", "stop"),
  );
  const stillRunning = await supervisor.inspect(handle, {});
  assert.equal(stillRunning.desiredState, "running");
  assert.equal(stillRunning.observedState, "running");

  const stopped = await supervisor.stop(handle, { reason: "cancel" }, {});
  assert.equal(stopped.desiredState, "stopped");
  assert.equal(stopped.observedState, "stopped");
  assert.equal(stopped.exit?.exitCode, null);
  assert.equal(stopped.exit?.signal, "SIGTERM");

  const again = await supervisor.stop(handle, { reason: "operator" }, {});
  assert.equal(again.desiredState, "stopped");
  assert.equal(again.observedState, "stopped");
  assert.deepEqual(again.exit, stopped.exit);

  const collected = await supervisor.collect(handle, {});
  assert.equal(collected.exit.signal, "SIGTERM");
});

test("destroy never stops a live unit", async () => {
  const supervisor = createMockExecutionSupervisor({ now: fixedClock() });
  const handle = await supervisor.start(startRequest(), {});

  await assert.rejects(
    supervisor.destroy(handle, {}),
    executionError("conflict", "destroy"),
  );
  assert.equal((await supervisor.inspect(handle, {})).observedState, "running");

  supervisor.complete(handle, { exitCode: 3 });
  await supervisor.destroy(handle, {});
  await assert.rejects(
    supervisor.destroy(handle, {}),
    executionError("not-found", "destroy"),
  );
});

test("start refuses to reuse an attempt id while a record exists", async () => {
  const supervisor = createMockExecutionSupervisor({ now: fixedClock() });
  const handle = await supervisor.start(startRequest(), {});

  await assert.rejects(
    supervisor.start(startRequest(), {}),
    executionError("already-exists", "start"),
  );
  supervisor.complete(handle, { exitCode: 0 });
  await assert.rejects(
    supervisor.start(startRequest(), {}),
    executionError("already-exists", "start"),
  );
  await supervisor.destroy(handle, {});
  const fresh = await supervisor.start(startRequest(), {});
  assert.equal(fresh.backendType, MOCK_BACKEND_TYPE);
});

test("collected output is bounded and flagged when truncated", async () => {
  const supervisor = createMockExecutionSupervisor({ now: fixedClock() });
  const handle = await supervisor.start(startRequest(), {});
  const oversized = "x".repeat(MAX_EXECUTION_OUTPUT_CHARS + 32);

  supervisor.complete(handle, { exitCode: 0 }, { stdout: oversized });
  const collected = await supervisor.collect(handle, {});
  assert.equal(collected.outputTruncated, true);
  assert.equal(collected.stdout.length, MAX_EXECUTION_OUTPUT_CHARS);
});

// ---------------------------------------------------------------------------
// Restart re-attach
// ---------------------------------------------------------------------------

test("attach recovers by handle across a simulated controller restart", async () => {
  const state = createMockExecutionBackendState();
  const first = createMockExecutionSupervisor({ state, now: fixedClock() });
  const second = createMockExecutionSupervisor({ state, now: fixedClock() });
  const handle = await first.start(startRequest(), {});

  const attached = await second.attach(
    { ...handle, diagnostics: { pid: 999, pgid: 999 } },
    {},
  );
  assert.equal(attached.handle.handle, handle.handle);
  assert.equal(attached.handle.backendType, handle.backendType);
  assert.deepEqual(attached.handle, handle);
  assert.equal(attached.status.observedState, "running");

  first.complete(handle, { exitCode: 0 }, { stdout: "restart-safe" });
  const collected = await second.collect(handle, {});
  assert.equal(collected.stdout, "restart-safe");

  await second.destroy(handle, {});
  await assert.rejects(
    first.inspect(handle, {}),
    executionError("not-found", "inspect"),
  );
});

test("attach refuses when restart recovery is not declared", async () => {
  const capabilities = {
    ...defaultMockExecutionCapabilities(),
    restartRecovery: "unsupported" as const,
  };
  const supervisor = createMockExecutionSupervisor({
    capabilities,
    now: fixedClock(),
  });
  const handle = await supervisor.start(startRequest(), {});

  await assert.rejects(
    supervisor.attach(handle, {}),
    executionError("unsupported", "attach"),
  );
  assert.equal((await supervisor.inspect(handle, {})).observedState, "running");
});

// ---------------------------------------------------------------------------
// Context cancellation
// ---------------------------------------------------------------------------

test("an aborted context cancels every operation without mutating state", async () => {
  const supervisor = createMockExecutionSupervisor({ now: fixedClock() });
  const handle = await supervisor.start(startRequest(), {});
  const controller = new AbortController();
  controller.abort();
  const context = { signal: controller.signal };

  const operations: Array<[ExecutionOperation, () => Promise<unknown>]> = [
    [
      "start",
      () =>
        supervisor.start(
          startRequest({ attemptId: "attempt-aborted" }),
          context,
        ),
    ],
    ["inspect", () => supervisor.inspect(handle, context)],
    ["attach", () => supervisor.attach(handle, context)],
    ["stop", () => supervisor.stop(handle, { reason: "cancel" }, context)],
    ["collect", () => supervisor.collect(handle, context)],
    ["destroy", () => supervisor.destroy(handle, context)],
  ];
  for (const [operation, run] of operations) {
    await assert.rejects(run(), executionError("cancelled", operation));
  }

  const status = await supervisor.inspect(handle, {});
  assert.equal(status.desiredState, "running");
  assert.equal(status.observedState, "running");
  // The aborted start left no record: the same attempt id starts cleanly.
  const started = await supervisor.start(
    startRequest({ attemptId: "attempt-aborted" }),
    {},
  );
  assert.equal(started.backendType, MOCK_BACKEND_TYPE);
});

test("in-flight cancellation leaves no partial state", async () => {
  const entered = deferred();
  const gate = deferred();
  let holdStart = false;
  const supervisor = createMockExecutionSupervisor({
    now: fixedClock(),
    beforeOperation: async (operation) => {
      if (operation !== "start" || !holdStart) return;
      entered.resolve();
      await gate.promise;
    },
  });
  const first = await supervisor.start(startRequest(), {});

  holdStart = true;
  const controller = new AbortController();
  const pending = supervisor.start(
    startRequest({ attemptId: "attempt-2" }),
    { signal: controller.signal },
  );
  const rejected = assert.rejects(
    pending,
    executionError("cancelled", "start"),
  );
  await entered.promise;
  controller.abort();
  gate.resolve();
  await rejected;

  holdStart = false;
  const second = await supervisor.start(
    startRequest({ attemptId: "attempt-2" }),
    {},
  );
  assert.notEqual(second.handle, first.handle);
});

// ---------------------------------------------------------------------------
// Error classification
// ---------------------------------------------------------------------------

test("errors are classified with operation scope and retryability", () => {
  const failure = asExecutionError(new Error("boom"), "inspect");
  assert.ok(failure instanceof ExecutionError);
  assert.equal(failure.code, "backend-failure");
  assert.equal(failure.operation, "inspect");
  assert.equal(failure.retryable, true);
  assert.equal((failure.cause as Error).message, "boom");

  const abort = new Error("aborted");
  abort.name = "AbortError";
  assert.equal(asExecutionError(abort, "stop").code, "cancelled");
  assert.equal(
    asExecutionError(
      new DOMException("deadline", "TimeoutError"),
      "collect",
    ).code,
    "deadline-exceeded",
  );

  const original = new ExecutionError("not-found", "inspect", "gone");
  assert.equal(asExecutionError(original, "destroy"), original);
  assert.equal(original.retryable, false);
  assert.equal(new ExecutionError("not-exited", "collect", "x").retryable, true);
  assert.equal(
    new ExecutionError("conflict", "destroy", "x", { retryable: true })
      .retryable,
    true,
  );

  const timedOut = new AbortController();
  timedOut.abort(new DOMException("deadline", "TimeoutError"));
  assert.throws(
    () => throwIfExecutionAborted({ signal: timedOut.signal }, "attach"),
    (error: unknown) =>
      error instanceof ExecutionError &&
      error.code === "deadline-exceeded" &&
      error.operation === "attach",
  );
});

test("injected backend failures do not mutate state", async () => {
  const supervisor = createMockExecutionSupervisor({ now: fixedClock() });

  supervisor.failNext("start", "backend-failure");
  await assert.rejects(
    supervisor.start(startRequest(), {}),
    executionError("backend-failure", "start"),
  );
  const handle = await supervisor.start(startRequest(), {});

  supervisor.failNext("stop", "backend-failure");
  await assert.rejects(
    supervisor.stop(handle, { reason: "operator" }, {}),
    executionError("backend-failure", "stop"),
  );
  const status = await supervisor.inspect(handle, {});
  assert.equal(status.desiredState, "running");
  assert.equal(status.observedState, "running");
});

// ---------------------------------------------------------------------------
// Persisted schema
// ---------------------------------------------------------------------------

test("ExecutionHandle schema round-trips the runtime authority", async () => {
  const supervisor = createMockExecutionSupervisor({ now: fixedClock() });
  const handle = await supervisor.start(startRequest(), {});
  const record: ExecutionHandle = {
    version: EXECUTION_INTERFACE_VERSION,
    attemptId: "attempt-1",
    workspaceId: "workspace-1",
    runtime: handle,
    designRevision: "design-7",
    baseCommit: "0123456789abcdef",
    desiredState: "running",
    observedState: "running",
    leaseDeadline: null,
    evidenceBundleRef: "evidence/attempt-1",
    updatedAt: "2026-11-05T00:00:00.000Z",
  };

  assert.deepEqual(parseExecutionHandle(record), record);
  assert.equal(parseExecutionHandle({ ...record, version: 2 }), undefined);
  assert.equal(
    parseExecutionHandle({ ...record, attemptId: "bad id" }),
    undefined,
  );
  assert.equal(
    parseExecutionHandle({ ...record, runtime: { backendType: "mock" } }),
    undefined,
  );
  assert.equal(
    parseExecutionHandle({ ...record, desiredState: "paused" }),
    undefined,
  );
  assert.equal(
    parseExecutionHandle({ ...record, leaseDeadline: "later" }),
    undefined,
  );
  // An exit result must carry a cause and belong to a terminal unit.
  assert.equal(
    parseExecutionHandle({
      ...record,
      observedState: "exited",
      exit: { exitCode: null, signal: null, exitedAt: record.updatedAt },
    }),
    undefined,
  );
  assert.equal(
    parseExecutionHandle({
      ...record,
      exit: { exitCode: 0, signal: null, exitedAt: record.updatedAt },
    }),
    undefined,
  );
  const terminal: ExecutionHandle = {
    ...record,
    observedState: "exited",
    exit: { exitCode: 0, signal: null, exitedAt: record.updatedAt },
  };
  assert.deepEqual(parseExecutionHandle(terminal), terminal);

  const withDiagnostics = {
    ...record,
    runtime: { ...handle, diagnostics: { pid: 77, pgid: 77 } },
  };
  const parsed = parseExecutionHandle(withDiagnostics);
  assert.ok(parsed !== undefined);
  assert.equal(sameRuntimeHandle(parsed.runtime, handle), true);
});

test("state and backend lists stay aligned with the StateStore contract", () => {
  assert.deepEqual([...EXECUTION_DESIRED_STATES], [...ATTEMPT_DESIRED_STATES]);
  assert.deepEqual(
    [...EXECUTION_OBSERVED_STATES],
    [...ATTEMPT_OBSERVED_STATES],
  );

  for (const backendType of EXECUTION_BACKEND_TYPES) {
    const handle = parseRuntimeHandle({ backendType, handle: "unit-1" });
    assert.equal(handle?.backendType, backendType);
  }
  assert.equal(
    (EXECUTION_BACKEND_TYPES as readonly string[]).includes(MOCK_BACKEND_TYPE),
    false,
  );
  assert.equal(isRuntimeBackendType(MOCK_BACKEND_TYPE), true);
});

/**
 * ExecutionSupervisor v0 contract and deterministic mock backend
 * (design/execution-supervisor-v0.md).
 *
 * The controller never owns a process tree. It starts an execution unit,
 * persists a {@link RuntimeHandle}, and later Inspects, Attaches, Stops,
 * Collects or Destroys through that handle. Backends own whatever mechanism
 * they need (POSIX process group, launchd job, systemd unit, Job Object), but
 * no backend may treat a pid or pgid as identity.
 *
 * Every operation takes an {@link ExecutionContext}. Cancelling that context
 * cancels the *call*, never the execution unit: an aborted Stop must not be
 * recorded as a stopped unit, and an aborted Start must leave no unit behind.
 */
import {
  MAX_EXECUTION_DETAIL_LENGTH,
  MAX_EXECUTION_OUTPUT_CHARS,
  MOCK_BACKEND_TYPE,
  isExecutionCapabilities,
  isExecutionExitResult,
  isRuntimeBackendType,
  isTerminalExecutionState,
  parseRuntimeHandle,
  runtimeHandleKey,
  validateStartExecutionRequest,
  validateStopExecutionRequest,
  type AttachExecutionResult,
  type DestroyExecutionResult,
  type ExecutionCapabilities,
  type ExecutionDesiredState,
  type ExecutionExitResult,
  type ExecutionObservedState,
  type ExecutionResourceLimitCapabilities,
  type ExecutionResourceLimits,
  type ExecutionResult,
  type ExecutionStatus,
  type ExecutionStopReason,
  type RuntimeBackendType,
  type RuntimeHandle,
  type StartExecutionRequest,
  type StopExecutionRequest,
} from "./types.js";

export const EXECUTION_OPERATIONS = [
  "start",
  "inspect",
  "attach",
  "stop",
  "collect",
  "destroy",
] as const;
export type ExecutionOperation = (typeof EXECUTION_OPERATIONS)[number];

export const EXECUTION_ERROR_CODES = [
  "cancelled",
  "deadline-exceeded",
  "invalid-handle",
  "invalid-request",
  "not-found",
  "already-exists",
  "not-exited",
  "conflict",
  "unsupported",
  "ambiguous",
  "backend-failure",
  "internal",
] as const;
export type ExecutionErrorCode = (typeof EXECUTION_ERROR_CODES)[number];

/**
 * Cancellation of one call. An aborted signal is not evidence that the unit
 * stopped, exited or was destroyed.
 */
export interface ExecutionContext {
  signal?: AbortSignal;
}

/**
 * Classified supervisor failure. Callers branch on `code` and `retryable`,
 * never on message text.
 *
 * `ambiguous` is deliberately distinct from `not-found`: an identity that
 * cannot be proven must be escalated to a human, not treated as gone.
 */
export class ExecutionError extends Error {
  readonly code: ExecutionErrorCode;
  readonly operation: ExecutionOperation;
  readonly retryable: boolean;

  constructor(
    code: ExecutionErrorCode,
    operation: ExecutionOperation,
    message: string,
    options: { retryable?: boolean; cause?: unknown } = {},
  ) {
    super(
      message,
      options.cause === undefined ? undefined : { cause: options.cause },
    );
    this.name = new.target.name;
    this.code = code;
    this.operation = operation;
    this.retryable = options.retryable ?? DEFAULT_RETRYABLE[code];
  }
}

const DEFAULT_RETRYABLE: Readonly<Record<ExecutionErrorCode, boolean>> = {
  cancelled: false,
  "deadline-exceeded": true,
  "invalid-handle": false,
  "invalid-request": false,
  "not-found": false,
  "already-exists": false,
  "not-exited": true,
  conflict: false,
  unsupported: false,
  ambiguous: false,
  "backend-failure": true,
  internal: false,
};

export function isExecutionOperation(
  value: unknown,
): value is ExecutionOperation {
  return (
    typeof value === "string" &&
    (EXECUTION_OPERATIONS as readonly string[]).includes(value)
  );
}

export function isExecutionErrorCode(
  value: unknown,
): value is ExecutionErrorCode {
  return (
    typeof value === "string" &&
    (EXECUTION_ERROR_CODES as readonly string[]).includes(value)
  );
}

/**
 * Throw the classified cancellation error for an aborted context.
 *
 * `AbortSignal.timeout()` is classified as `deadline-exceeded`; any other
 * abort reason is `cancelled`. Backends must call this at operation entry and
 * again after any awaited boundary, before mutating durable state.
 */
export function throwIfExecutionAborted(
  context: ExecutionContext | undefined,
  operation: ExecutionOperation,
): void {
  const signal = context?.signal;
  if (signal === undefined || !signal.aborted) return;
  const reason: unknown = signal.reason;
  const timedOut = isErrorNamed(reason, "TimeoutError");
  throw new ExecutionError(
    timedOut ? "deadline-exceeded" : "cancelled",
    operation,
    timedOut
      ? `${operation} exceeded its deadline and was not applied`
      : `${operation} was cancelled and was not applied`,
    { cause: reason },
  );
}

/**
 * Normalize anything thrown by a backend into a classified error. An existing
 * {@link ExecutionError} is preserved; abort-like DOMExceptions are classified
 * by name; everything else becomes a retryable `backend-failure` with its
 * cause retained for diagnosis.
 */
export function asExecutionError(
  error: unknown,
  operation: ExecutionOperation,
): ExecutionError {
  if (error instanceof ExecutionError) return error;
  if (isErrorNamed(error, "TimeoutError")) {
    return new ExecutionError(
      "deadline-exceeded",
      operation,
      `${operation} exceeded its deadline`,
      { cause: error },
    );
  }
  if (isErrorNamed(error, "AbortError")) {
    return new ExecutionError(
      "cancelled",
      operation,
      `${operation} was cancelled`,
      { cause: error },
    );
  }
  const detail =
    error instanceof Error ? error.message : String(error);
  return new ExecutionError(
    "backend-failure",
    operation,
    `${operation} failed: ${boundedMessage(detail)}`,
    { cause: error },
  );
}

/**
 * Platform-neutral execution supervisor.
 *
 * Operation contract:
 * - `start` creates a new unit and returns its stable handle. It never adopts
 *   an existing unit; a rerun always receives a new attempt id.
 * - `inspect` is read-only. A handle the backend has no record of is
 *   `not-found`, never successful absence.
 * - `attach` re-establishes a controller relationship by handle after a
 *   restart and refreshes diagnostics only. It never creates a unit and never
 *   proves the unit succeeded.
 * - `stop` requests a terminal state. It is idempotent for terminal units;
 *   a cancelled Stop call does not imply the unit stopped.
 * - `collect` returns bounded output and exit evidence for a terminal unit and
 *   `not-exited` otherwise. A missing exit is never synthesized.
 * - `destroy` releases backend resources for a terminal unit only. It never
 *   signals a live unit; a vanished unit is `not-found`, not success.
 *
 * Every operation rejects a malformed handle or a handle from another backend
 * with `invalid-handle`.
 */
export interface ExecutionSupervisor {
  readonly backendType: RuntimeBackendType;

  /** Static declaration; capabilities are never inferred from a request. */
  capabilities(): ExecutionCapabilities;

  start(
    request: StartExecutionRequest,
    context: ExecutionContext,
  ): Promise<RuntimeHandle>;

  inspect(
    handle: RuntimeHandle,
    context: ExecutionContext,
  ): Promise<ExecutionStatus>;

  attach(
    handle: RuntimeHandle,
    context: ExecutionContext,
  ): Promise<AttachExecutionResult>;

  stop(
    handle: RuntimeHandle,
    request: StopExecutionRequest,
    context: ExecutionContext,
  ): Promise<ExecutionStatus>;

  collect(
    handle: RuntimeHandle,
    context: ExecutionContext,
  ): Promise<ExecutionResult>;

  destroy(
    handle: RuntimeHandle,
    context: ExecutionContext,
  ): Promise<DestroyExecutionResult>;
}

// ---------------------------------------------------------------------------
// Mock backend
// ---------------------------------------------------------------------------

/**
 * Test-only execution unit state. Exposed so a test can share one backend
 * across two supervisors, which simulates a controller restart: the second
 * controller must recover the unit from the handle alone.
 */
export interface MockExecutionUnit {
  handle: RuntimeHandle;
  attemptId: string;
  workspaceId: string;
  command: readonly string[];
  cwd?: string;
  env?: Readonly<Record<string, string>>;
  limits?: ExecutionResourceLimits;
  desiredState: ExecutionDesiredState;
  observedState: ExecutionObservedState;
  leaseDeadline: string | null;
  startedAt: string;
  observedAt: string;
  stopReason?: ExecutionStopReason;
  exit?: ExecutionExitResult;
  stdout: string;
  stderr: string;
  outputTruncated: boolean;
}

export interface MockExecutionBackendState {
  /** Keyed by `runtimeHandleKey(handle)`. */
  units: Map<string, MockExecutionUnit>;
  nextHandleId: number;
}

export type MockBeforeOperation = (
  operation: ExecutionOperation,
  context: ExecutionContext,
) => void | Promise<void>;

export interface MockExecutionSupervisorOptions {
  /** Defaults to `mock`. A test may simulate another declared backend. */
  backendType?: RuntimeBackendType;
  /** Share this object to simulate controller restart. */
  state?: MockExecutionBackendState;
  /** Injected clock; defaults to the real clock. */
  now?: () => Date;
  /** Full override, validated against the backend type. */
  capabilities?: ExecutionCapabilities;
  /**
   * Deterministic in-flight cancellation hook: awaited after entry and
   * before any state change, then the abort check runs again.
   */
  beforeOperation?: MockBeforeOperation;
}

export interface MockExecutionOutput {
  stdout?: string;
  stderr?: string;
}

export interface MockExecutionSupervisor extends ExecutionSupervisor {
  readonly state: MockExecutionBackendState;

  /**
   * Simulate a natural process exit without a Stop. `desiredState` is left
   * untouched so tests can prove desired and observed state are distinct. The
   * provided output replaces any output collected so far.
   */
  complete(
    handle: RuntimeHandle,
    exit?: Partial<ExecutionExitResult>,
    output?: MockExecutionOutput,
  ): ExecutionStatus;

  /** Inject one classified failure for the next call of `operation`. */
  failNext(
    operation: ExecutionOperation,
    code: ExecutionErrorCode,
    message?: string,
  ): void;
}

export function createMockExecutionBackendState(): MockExecutionBackendState {
  return { units: new Map(), nextHandleId: 1 };
}

/**
 * Honest default mock declaration: no real process exists, so descendant
 * control and isolation are unsupported. Restart recovery is simulated by the
 * shared backend state, and resource limits are not enforced, so `start`
 * rejects any requested limit unless a test deliberately overrides the
 * declaration.
 */
export function defaultMockExecutionCapabilities(
  backendType: RuntimeBackendType = MOCK_BACKEND_TYPE,
): ExecutionCapabilities {
  return freezeCapabilities({
    backendType,
    descendantControl: "unsupported",
    restartRecovery: "full",
    resourceLimits: {
      cpu: false,
      memory: false,
      processCount: false,
      openFiles: false,
    },
    filesystemIsolation: "unsupported",
    networkIsolation: "unsupported",
    notes: [
      "MockExecutionSupervisor simulates lifecycle transitions; it never " +
        "starts, signals or reaps a real process.",
      "restartRecovery is simulated for supervisors that share one " +
        "MockExecutionBackendState.",
    ],
  });
}

export function createMockExecutionSupervisor(
  options: MockExecutionSupervisorOptions = {},
): MockExecutionSupervisor {
  return new MockExecutionSupervisorImpl(options);
}

interface InjectedFailure {
  operation: ExecutionOperation;
  code: ExecutionErrorCode;
  message?: string;
}

class MockExecutionSupervisorImpl implements MockExecutionSupervisor {
  readonly backendType: RuntimeBackendType;
  readonly state: MockExecutionBackendState;

  private readonly now: () => Date;
  private readonly declaredCapabilities: ExecutionCapabilities;
  private readonly beforeOperation?: MockBeforeOperation;
  private readonly failures: InjectedFailure[] = [];

  constructor(options: MockExecutionSupervisorOptions) {
    if (
      options === null ||
      typeof options !== "object" ||
      Array.isArray(options)
    ) {
      throw new TypeError("mock supervisor options must be an object");
    }
    const backendType = options.backendType ?? MOCK_BACKEND_TYPE;
    if (!isRuntimeBackendType(backendType)) {
      throw new TypeError("mock supervisor backendType is not supported");
    }
    this.backendType = backendType;

    const state = options.state ?? createMockExecutionBackendState();
    if (!isMockBackendState(state)) {
      throw new TypeError("mock supervisor state is malformed");
    }
    this.state = state;

    if (options.now !== undefined && typeof options.now !== "function") {
      throw new TypeError("mock supervisor now must be a function");
    }
    this.now = options.now ?? (() => new Date());

    if (
      options.beforeOperation !== undefined &&
      typeof options.beforeOperation !== "function"
    ) {
      throw new TypeError("mock supervisor beforeOperation must be a function");
    }
    this.beforeOperation = options.beforeOperation;

    const capabilities =
      options.capabilities ?? defaultMockExecutionCapabilities(backendType);
    if (!isExecutionCapabilities(capabilities)) {
      throw new TypeError("mock supervisor capabilities are malformed");
    }
    if (capabilities.backendType !== backendType) {
      throw new TypeError(
        "mock supervisor capabilities backendType does not match the backend",
      );
    }
    this.declaredCapabilities = freezeCapabilities(capabilities);
  }

  capabilities(): ExecutionCapabilities {
    return this.declaredCapabilities;
  }

  async start(
    request: StartExecutionRequest,
    context: ExecutionContext = {},
  ): Promise<RuntimeHandle> {
    await this.enter("start", context);

    const problem = validateStartExecutionRequest(request);
    if (problem !== undefined) {
      throw new ExecutionError("invalid-request", "start", problem);
    }
    const unsupportedLimit = this.unsupportedLimit(request.limits);
    if (unsupportedLimit !== undefined) {
      throw new ExecutionError(
        "unsupported",
        "start",
        `backend ${this.backendType} cannot enforce resource limit ` +
          unsupportedLimit,
      );
    }
    for (const unit of this.state.units.values()) {
      if (
        unit.handle.backendType === this.backendType &&
        unit.attemptId === request.attemptId
      ) {
        throw new ExecutionError(
          "already-exists",
          "start",
          `attempt ${request.attemptId} already has a runtime record; ` +
            "a rerun requires a new attemptId",
        );
      }
    }

    const at = this.timestamp();
    const handle: RuntimeHandle = {
      backendType: this.backendType,
      handle: `${this.backendType}-${this.state.nextHandleId}`,
      diagnostics: { pid: null, pgid: null },
    };
    this.state.nextHandleId += 1;
    this.state.units.set(runtimeHandleKey(handle), {
      handle: copyRuntimeHandle(handle),
      attemptId: request.attemptId,
      workspaceId: request.workspaceId,
      command: [...request.command],
      ...(request.cwd !== undefined ? { cwd: request.cwd } : {}),
      ...(request.env !== undefined ? { env: { ...request.env } } : {}),
      ...(request.limits !== undefined
        ? { limits: { ...request.limits } }
        : {}),
      desiredState: "running",
      observedState: "running",
      leaseDeadline: request.leaseDeadline ?? null,
      startedAt: at,
      observedAt: at,
      stdout: "",
      stderr: "",
      outputTruncated: false,
    });
    return copyRuntimeHandle(handle);
  }

  async inspect(
    handle: RuntimeHandle,
    context: ExecutionContext = {},
  ): Promise<ExecutionStatus> {
    await this.enter("inspect", context);
    const unit = this.resolve(handle, "inspect");
    return this.statusOf(unit);
  }

  async attach(
    handle: RuntimeHandle,
    context: ExecutionContext = {},
  ): Promise<AttachExecutionResult> {
    await this.enter("attach", context);
    const unit = this.resolve(handle, "attach");
    if (this.declaredCapabilities.restartRecovery === "unsupported") {
      throw new ExecutionError(
        "unsupported",
        "attach",
        `backend ${this.backendType} cannot re-attach after restart`,
      );
    }
    return {
      handle: copyRuntimeHandle(unit.handle),
      status: this.statusOf(unit),
    };
  }

  async stop(
    handle: RuntimeHandle,
    request: StopExecutionRequest,
    context: ExecutionContext = {},
  ): Promise<ExecutionStatus> {
    await this.enter("stop", context);
    const problem = validateStopExecutionRequest(request);
    if (problem !== undefined) {
      throw new ExecutionError("invalid-request", "stop", problem);
    }
    const unit = this.resolve(handle, "stop");
    const at = this.timestamp();
    unit.desiredState = "stopped";
    unit.observedAt = at;
    if (!isTerminalExecutionState(unit.observedState)) {
      // A cancelled call never reaches this point, so the in-memory unit is
      // only marked stopped after the abort checks in enter() passed.
      unit.observedState = "stopped";
      unit.stopReason = request.reason;
      unit.exit = {
        exitCode: null,
        signal: "SIGTERM",
        exitedAt: at,
      };
    }
    return this.statusOf(unit);
  }

  async collect(
    handle: RuntimeHandle,
    context: ExecutionContext = {},
  ): Promise<ExecutionResult> {
    await this.enter("collect", context);
    const unit = this.resolve(handle, "collect");
    if (!isTerminalExecutionState(unit.observedState)) {
      throw new ExecutionError(
        "not-exited",
        "collect",
        `execution unit ${unit.handle.handle} is ${unit.observedState}, ` +
          "not terminal",
        { retryable: true },
      );
    }
    if (unit.exit === undefined) {
      throw new ExecutionError(
        "internal",
        "collect",
        `execution unit ${unit.handle.handle} is terminal but has no exit ` +
          "evidence",
      );
    }
    return {
      handle: copyRuntimeHandle(unit.handle),
      exit: { ...unit.exit },
      stdout: unit.stdout,
      stderr: unit.stderr,
      outputTruncated: unit.outputTruncated,
    };
  }

  async destroy(
    handle: RuntimeHandle,
    context: ExecutionContext = {},
  ): Promise<DestroyExecutionResult> {
    await this.enter("destroy", context);
    const unit = this.resolve(handle, "destroy");
    if (!isTerminalExecutionState(unit.observedState)) {
      throw new ExecutionError(
        "conflict",
        "destroy",
        `execution unit ${unit.handle.handle} is ${unit.observedState}; ` +
          "stop it before destroy",
      );
    }
    this.state.units.delete(runtimeHandleKey(unit.handle));
    return {
      handle: copyRuntimeHandle(unit.handle),
      released: [],
      destroyedAt: this.timestamp(),
    };
  }

  complete(
    handle: RuntimeHandle,
    exit: Partial<ExecutionExitResult> = {},
    output: MockExecutionOutput = {},
  ): ExecutionStatus {
    const unit = this.resolve(handle, "collect");
    if (isTerminalExecutionState(unit.observedState)) {
      throw new ExecutionError(
        "conflict",
        "collect",
        `execution unit ${unit.handle.handle} already was ` +
          unit.observedState,
      );
    }
    const at = this.timestamp();
    const candidate: ExecutionExitResult = {
      exitCode: exit.exitCode === undefined ? 0 : exit.exitCode,
      signal: exit.signal === undefined ? null : exit.signal,
      exitedAt: exit.exitedAt ?? at,
    };
    if (!isExecutionExitResult(candidate)) {
      throw new ExecutionError(
        "invalid-request",
        "collect",
        "complete() received an invalid exit result",
      );
    }

    const stdout = capOutput(output.stdout ?? unit.stdout);
    const stderr = capOutput(output.stderr ?? unit.stderr);
    unit.stdout = stdout.value;
    unit.stderr = stderr.value;
    unit.outputTruncated =
      unit.outputTruncated || stdout.truncated || stderr.truncated;
    unit.observedState = "exited";
    unit.observedAt = at;
    unit.exit = candidate;
    return this.statusOf(unit);
  }

  failNext(
    operation: ExecutionOperation,
    code: ExecutionErrorCode,
    message?: string,
  ): void {
    if (!isExecutionOperation(operation)) {
      throw new TypeError("failNext operation is not recognized");
    }
    if (!isExecutionErrorCode(code)) {
      throw new TypeError("failNext code is not recognized");
    }
    this.failures.push({
      operation,
      code,
      ...(message !== undefined
        ? { message: boundedMessage(message) }
        : {}),
    });
  }

  /**
   * Context check, optional test hook, second context check, injected failure.
   * No state is mutated before this returns, so an abort during the hook
   * cannot leave a partial transition behind.
   */
  private async enter(
    operation: ExecutionOperation,
    context: ExecutionContext,
  ): Promise<void> {
    throwIfExecutionAborted(context, operation);
    if (this.beforeOperation !== undefined) {
      await this.beforeOperation(operation, context);
    }
    throwIfExecutionAborted(context, operation);
    const failure = this.takeFailure(operation);
    if (failure !== undefined) throw failure;
  }

  private takeFailure(
    operation: ExecutionOperation,
  ): ExecutionError | undefined {
    const index = this.failures.findIndex(
      (failure) => failure.operation === operation,
    );
    if (index < 0) return undefined;
    const [injected] = this.failures.splice(index, 1);
    if (injected === undefined) return undefined;
    return new ExecutionError(
      injected.code,
      operation,
      injected.message ??
        `injected ${injected.code} failure for ${operation}`,
    );
  }

  private resolve(
    handle: RuntimeHandle,
    operation: ExecutionOperation,
  ): MockExecutionUnit {
    const parsed = parseRuntimeHandle(handle);
    if (parsed === undefined) {
      throw new ExecutionError(
        "invalid-handle",
        operation,
        "runtime handle is malformed",
      );
    }
    if (parsed.backendType !== this.backendType) {
      throw new ExecutionError(
        "invalid-handle",
        operation,
        `runtime handle belongs to backend ${parsed.backendType}, not ` +
          this.backendType,
      );
    }
    const unit = this.state.units.get(runtimeHandleKey(parsed));
    if (unit === undefined) {
      throw new ExecutionError(
        "not-found",
        operation,
        `backend ${this.backendType} has no record of handle ` +
          parsed.handle,
      );
    }
    return unit;
  }

  private statusOf(unit: MockExecutionUnit): ExecutionStatus {
    return {
      handle: copyRuntimeHandle(unit.handle),
      desiredState: unit.desiredState,
      observedState: unit.observedState,
      observedAt: unit.observedAt,
      leaseDeadline: unit.leaseDeadline,
      ...(unit.exit !== undefined ? { exit: { ...unit.exit } } : {}),
    };
  }

  private unsupportedLimit(
    limits: ExecutionResourceLimits | undefined,
  ): keyof ExecutionResourceLimitCapabilities | undefined {
    if (limits === undefined) return undefined;
    const pairs: ReadonlyArray<
      [keyof ExecutionResourceLimits, keyof ExecutionResourceLimitCapabilities]
    > = [
      ["cpuSeconds", "cpu"],
      ["memoryBytes", "memory"],
      ["processCount", "processCount"],
      ["openFiles", "openFiles"],
    ];
    for (const [requestKey, capabilityKey] of pairs) {
      if (
        limits[requestKey] !== undefined &&
        !this.declaredCapabilities.resourceLimits[capabilityKey]
      ) {
        return capabilityKey;
      }
    }
    return undefined;
  }

  private timestamp(): string {
    return this.now().toISOString();
  }
}

function isMockBackendState(
  value: unknown,
): value is MockExecutionBackendState {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const state = value as Partial<MockExecutionBackendState>;
  return (
    state.units instanceof Map &&
    typeof state.nextHandleId === "number" &&
    Number.isInteger(state.nextHandleId) &&
    state.nextHandleId > 0
  );
}

function copyRuntimeHandle(handle: RuntimeHandle): RuntimeHandle {
  return {
    backendType: handle.backendType,
    handle: handle.handle,
    ...(handle.diagnostics !== undefined
      ? { diagnostics: { ...handle.diagnostics } }
      : {}),
  };
}

function freezeCapabilities(
  capabilities: ExecutionCapabilities,
): ExecutionCapabilities {
  return Object.freeze({
    backendType: capabilities.backendType,
    descendantControl: capabilities.descendantControl,
    restartRecovery: capabilities.restartRecovery,
    resourceLimits: Object.freeze({ ...capabilities.resourceLimits }),
    filesystemIsolation: capabilities.filesystemIsolation,
    networkIsolation: capabilities.networkIsolation,
    notes: Object.freeze([...capabilities.notes]),
  });
}

function capOutput(value: string): { value: string; truncated: boolean } {
  return value.length > MAX_EXECUTION_OUTPUT_CHARS
    ? {
        value: value.slice(0, MAX_EXECUTION_OUTPUT_CHARS),
        truncated: true,
      }
    : { value, truncated: false };
}

function isErrorNamed(value: unknown, name: string): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { name?: unknown }).name === name
  );
}

function boundedMessage(value: string): string {
  const normalized = value.trim().replace(/\s+/g, " ");
  if (normalized.length === 0) return "no detail";
  return normalized.length > MAX_EXECUTION_DETAIL_LENGTH
    ? normalized.slice(0, MAX_EXECUTION_DETAIL_LENGTH)
    : normalized;
}

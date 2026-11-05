/**
 * ExecutionSupervisor v0 platform-neutral schema
 * (design/execution-supervisor-v0.md).
 *
 * The supervisor boundary separates the control plane from process ownership:
 * the controller starts, observes and reconciles execution units through a
 * stable {@link RuntimeHandle}, never through a pid or process group.
 *
 * Identity authority is exactly `(backendType, handle)`. `pid` and `pgid` are
 * diagnostics: they may be stale, absent or reused by the OS, are excluded
 * from handle equality, and must never authorize a signal or a recovery
 * decision. Backends that need process ids for their own mechanics keep that
 * inside the backend; controllers never read them from here as authority.
 *
 * Backend types, desired states and observed states are shared with the
 * StateStore identity contract (src/statestore/schema.ts) so the persisted
 * schema and this interface cannot drift. `mock` is test-only: it is declared
 * here but is never a persistable production backend.
 */
import {
  ATTEMPT_DESIRED_STATES,
  ATTEMPT_OBSERVED_STATES,
  EXECUTION_BACKEND_TYPES,
  MAX_ATTEMPT_ID_LENGTH,
  MAX_DIAGNOSTIC_ID,
  MAX_RUNTIME_HANDLE_LENGTH,
  MAX_TIMESTAMP_LENGTH,
  MAX_WORKSPACE_ID_LENGTH,
  isAttemptDesiredState,
  isAttemptObservedState,
  isExecutionBackendType,
  type AttemptDesiredState,
  type AttemptObservedState,
  type ExecutionBackendType,
} from "../statestore/schema.js";

export {
  ATTEMPT_DESIRED_STATES as EXECUTION_DESIRED_STATES,
  ATTEMPT_OBSERVED_STATES as EXECUTION_OBSERVED_STATES,
  EXECUTION_BACKEND_TYPES as PERSISTED_EXECUTION_BACKEND_TYPES,
  MAX_ATTEMPT_ID_LENGTH,
  MAX_RUNTIME_HANDLE_LENGTH,
  MAX_WORKSPACE_ID_LENGTH,
};
export type { ExecutionBackendType };

export const EXECUTION_INTERFACE_VERSION = 1 as const;
/** Test-only backend. Never persisted as production execution evidence. */
export const MOCK_BACKEND_TYPE = "mock" as const;

export const MAX_EXECUTION_COMMAND_ARGS = 256;
export const MAX_EXECUTION_ARG_LENGTH = 8_192;
export const MAX_EXECUTION_ENV_ENTRIES = 256;
export const MAX_EXECUTION_ENV_VALUE_LENGTH = 8_192;
export const MAX_EXECUTION_PATH_LENGTH = 4_096;
export const MAX_EXECUTION_REF_LENGTH = 512;
export const MAX_EXECUTION_SIGNAL_LENGTH = 64;
export const MAX_EXECUTION_OUTPUT_CHARS = 1_000_000;
export const MAX_EXECUTION_DETAIL_LENGTH = 600;
export const MAX_EXECUTION_GRACE_MS = 300_000;
export const MAX_CAPABILITY_NOTES = 16;
export const MAX_CAPABILITY_NOTE_LENGTH = 600;

const ATTEMPT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const WORKSPACE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@/-]*$/;
const RUNTIME_HANDLE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@/-]*$/;
const ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const CONTROL_CHARACTERS = /[\x00-\x1f\x7f]/;

/** Persisted desired state (`running` / `stopped`). */
export type ExecutionDesiredState = AttemptDesiredState;
/** Observed state, including `lost` for a vanished execution unit. */
export type ExecutionObservedState = AttemptObservedState;

/**
 * Every backend this interface can talk to. The six persisted values are
 * shared with the StateStore; `mock` exists only for tests.
 */
export type RuntimeBackendType = ExecutionBackendType | typeof MOCK_BACKEND_TYPE;

/**
 * Process observations for operator display only.
 *
 * A handle is fully valid without diagnostics. Diagnostics never participate
 * in identity, equality, adoption, recovery or termination decisions.
 */
export interface RuntimeDiagnostics {
  /** Diagnostic only. Never identity, authority or a kill target. */
  pid: number | null;
  /** Diagnostic only. Never identity, authority or a kill target. */
  pgid: number | null;
}

/**
 * Stable identity of one backend-owned execution unit.
 *
 * `handle` is backend-specific and stable for the unit's lifetime: a launchd
 * label, a systemd unit name, a Job Object id or an exact `pgid:startedAt`
 * process-group handle. It is never a bare pid: pids are reused by the OS.
 */
export interface RuntimeHandle {
  backendType: RuntimeBackendType;
  handle: string;
  diagnostics?: RuntimeDiagnostics;
}

export function isRuntimeBackendType(
  value: unknown,
): value is RuntimeBackendType {
  return value === MOCK_BACKEND_TYPE || isExecutionBackendType(value);
}

export function isRuntimeDiagnostics(
  value: unknown,
): value is RuntimeDiagnostics {
  if (!isRecord(value)) return false;
  return isDiagnosticId(value.pid) && isDiagnosticId(value.pgid);
}

/**
 * Validate and normalize a persisted or reported runtime handle. Unknown
 * fields are dropped rather than carried forward, so a stray top-level `pid`
 * can never become a second identity.
 */
export function parseRuntimeHandle(
  value: unknown,
): RuntimeHandle | undefined {
  if (!isRecord(value)) return undefined;
  if (!isRuntimeBackendType(value.backendType)) return undefined;
  const handle = value.handle;
  if (
    typeof handle !== "string" ||
    handle.length === 0 ||
    handle.length > MAX_RUNTIME_HANDLE_LENGTH ||
    handle !== handle.trim() ||
    !RUNTIME_HANDLE_PATTERN.test(handle)
  ) {
    return undefined;
  }
  let diagnostics: RuntimeDiagnostics | undefined;
  if (value.diagnostics !== undefined) {
    if (!isRuntimeDiagnostics(value.diagnostics)) return undefined;
    diagnostics = {
      pid: value.diagnostics.pid,
      pgid: value.diagnostics.pgid,
    };
  }
  return {
    backendType: value.backendType,
    handle,
    ...(diagnostics !== undefined ? { diagnostics } : {}),
  };
}

/** Stable map key for the `(backendType, handle)` identity pair. */
export function runtimeHandleKey(handle: RuntimeHandle): string {
  return `${handle.backendType}:${handle.handle}`;
}

/** Identity comparison; diagnostics are deliberately ignored. */
export function sameRuntimeHandle(left: unknown, right: unknown): boolean {
  const first = parseRuntimeHandle(left);
  const second = parseRuntimeHandle(right);
  return (
    first !== undefined &&
    second !== undefined &&
    first.backendType === second.backendType &&
    first.handle === second.handle
  );
}

// ---------------------------------------------------------------------------
// Capabilities
// ---------------------------------------------------------------------------

/**
 * - `full`: the backend enforces the property for every descendant/unit.
 * - `partial`: enforcement has a documented escape or limit; callers that
 *   cannot tolerate the gap must refuse the task.
 * - `unsupported`: the backend makes no claim.
 */
export type ExecutionCapabilitySupport = "full" | "partial" | "unsupported";

export interface ExecutionResourceLimitCapabilities {
  /** Cumulative CPU time (`cpuSeconds`). */
  cpu: boolean;
  /** Address-space bytes (`memoryBytes`). */
  memory: boolean;
  /** Simultaneous processes/threads (`processCount`). */
  processCount: boolean;
  /** Open file descriptors (`openFiles`). */
  openFiles: boolean;
}

export const EXECUTION_RESOURCE_LIMIT_KEYS = [
  "cpu",
  "memory",
  "processCount",
  "openFiles",
] as const;
export type ExecutionResourceLimitKey =
  (typeof EXECUTION_RESOURCE_LIMIT_KEYS)[number];

/**
 * Static capability declaration. Backends must state known limits honestly:
 * a macOS process group is not full descendant-tree containment and must say
 * `partial`, not `full`.
 */
export interface ExecutionCapabilities {
  backendType: RuntimeBackendType;
  /** Can stop/reap every descendant, including a `setsid()` escape? */
  descendantControl: ExecutionCapabilitySupport;
  /** Can Attach recover a live unit after controller restart, by handle? */
  restartRecovery: ExecutionCapabilitySupport;
  resourceLimits: ExecutionResourceLimitCapabilities;
  /** Write confinement to the task workspace. */
  filesystemIsolation: ExecutionCapabilitySupport;
  /** Network egress confinement. */
  networkIsolation: ExecutionCapabilitySupport;
  /** Bounded operator notes. Never secrets. */
  notes: readonly string[];
}

/** Minimum capability levels a task needs from a backend. */
export interface ExecutionRequirements {
  descendantControl?: ExecutionCapabilitySupport;
  restartRecovery?: ExecutionCapabilitySupport;
  resourceLimits?: readonly ExecutionResourceLimitKey[];
  filesystemIsolation?: ExecutionCapabilitySupport;
  networkIsolation?: ExecutionCapabilitySupport;
}

export function isExecutionCapabilities(
  value: unknown,
): value is ExecutionCapabilities {
  if (!isRecord(value)) return false;
  if (
    !hasOnlyKeys([
      "backendType",
      "descendantControl",
      "restartRecovery",
      "resourceLimits",
      "filesystemIsolation",
      "networkIsolation",
      "notes",
    ], value)
  ) {
    return false;
  }
  if (!isRuntimeBackendType(value.backendType)) return false;
  if (
    !isCapabilitySupport(value.descendantControl) ||
    !isCapabilitySupport(value.restartRecovery) ||
    !isCapabilitySupport(value.filesystemIsolation) ||
    !isCapabilitySupport(value.networkIsolation)
  ) {
    return false;
  }
  if (!isRecord(value.resourceLimits)) return false;
  if (!hasOnlyKeys(EXECUTION_RESOURCE_LIMIT_KEYS, value.resourceLimits)) {
    return false;
  }
  for (const key of EXECUTION_RESOURCE_LIMIT_KEYS) {
    if (typeof value.resourceLimits[key] !== "boolean") return false;
  }
  if (
    !Array.isArray(value.notes) ||
    value.notes.length > MAX_CAPABILITY_NOTES
  ) {
    return false;
  }
  return value.notes.every((note) =>
    isBoundedText(note, MAX_CAPABILITY_NOTE_LENGTH),
  );
}

/**
 * Deterministic capability gate. A non-empty result means the task's
 * requirements exceed the backend declaration and must be refused or raised
 * for explicit human approval; it must never silently downgrade.
 */
export function executionCapabilityGaps(
  capabilities: ExecutionCapabilities,
  requirements: ExecutionRequirements,
): string[] {
  const gaps: string[] = [];
  const levels = [
    "descendantControl",
    "restartRecovery",
    "filesystemIsolation",
    "networkIsolation",
  ] as const;
  for (const key of levels) {
    const required = requirements[key];
    if (required === undefined) continue;
    if (
      capabilityRank(capabilities[key]) < capabilityRank(required)
    ) {
      gaps.push(
        `${key} requires ${required}, backend ${capabilities.backendType} ` +
          `declares ${capabilities[key]}`,
      );
    }
  }
  for (const limit of requirements.resourceLimits ?? []) {
    if (!capabilities.resourceLimits[limit]) {
      gaps.push(
        `resource limit ${limit} is unsupported by backend ` +
          `${capabilities.backendType}`,
      );
    }
  }
  return gaps;
}

function isCapabilitySupport(
  value: unknown,
): value is ExecutionCapabilitySupport {
  return value === "full" || value === "partial" || value === "unsupported";
}

function capabilityRank(level: ExecutionCapabilitySupport): number {
  if (level === "full") return 2;
  if (level === "partial") return 1;
  return 0;
}

// ---------------------------------------------------------------------------
// Requests and results
// ---------------------------------------------------------------------------

/** Portable resource limits. A backend that cannot enforce one must reject. */
export interface ExecutionResourceLimits {
  /** Cumulative CPU time in seconds. */
  cpuSeconds?: number;
  /** Address-space bytes. */
  memoryBytes?: number;
  /** Maximum simultaneous processes/threads. */
  processCount?: number;
  /** Maximum open file descriptors. */
  openFiles?: number;
}

export function isExecutionResourceLimits(
  value: unknown,
): value is ExecutionResourceLimits {
  if (!isRecord(value)) return false;
  if (
    !hasOnlyKeys(
      ["cpuSeconds", "memoryBytes", "processCount", "openFiles"],
      value,
    )
  ) {
    return false;
  }
  return (
    isOptionalPositiveInteger(value.cpuSeconds) &&
    isOptionalPositiveInteger(value.memoryBytes) &&
    isOptionalPositiveInteger(value.processCount) &&
    isOptionalPositiveInteger(value.openFiles)
  );
}

export interface StartExecutionRequest {
  /** Frozen attempt identity owned by the controller. */
  attemptId: string;
  workspaceId: string;
  /**
   * argv array executed directly, never a shell string. An empty command is
   * invalid.
   */
  command: readonly string[];
  cwd?: string;
  /** Explicit environment; absent means the backend default. */
  env?: Readonly<Record<string, string>>;
  limits?: ExecutionResourceLimits;
  /** Absolute ISO deadline; `null`/absent when the unit has none. */
  leaseDeadline?: string | null;
}

/**
 * Validate a start request without allocating any backend state.
 *
 * The check is strict about unknown fields: a misspelled security option must
 * fail closed instead of being silently ignored. Returns a human-readable
 * problem, or `undefined` when valid.
 */
export function validateStartExecutionRequest(
  value: unknown,
): string | undefined {
  if (!isRecord(value)) return "start request must be an object";
  if (
    !hasOnlyKeys(
      [
        "attemptId",
        "workspaceId",
        "command",
        "cwd",
        "env",
        "limits",
        "leaseDeadline",
      ],
      value,
    )
  ) {
    return "start request contains an unsupported field";
  }
  if (
    !isIdentifier(value.attemptId, MAX_ATTEMPT_ID_LENGTH, ATTEMPT_ID_PATTERN)
  ) {
    return "attemptId must be a bounded safe identifier";
  }
  if (
    !isIdentifier(
      value.workspaceId,
      MAX_WORKSPACE_ID_LENGTH,
      WORKSPACE_ID_PATTERN,
    )
  ) {
    return "workspaceId must be a bounded safe identifier";
  }
  if (
    !Array.isArray(value.command) ||
    value.command.length === 0 ||
    value.command.length > MAX_EXECUTION_COMMAND_ARGS
  ) {
    return (
      `command must be an argv array of 1-${MAX_EXECUTION_COMMAND_ARGS} ` +
      "arguments"
    );
  }
  for (const arg of value.command) {
    if (!isBoundedOpaqueString(arg, MAX_EXECUTION_ARG_LENGTH)) {
      return "command arguments must be bounded NUL-free strings";
    }
  }
  if (
    value.cwd !== undefined &&
    !isBoundedText(value.cwd, MAX_EXECUTION_PATH_LENGTH)
  ) {
    return "cwd must be a bounded path string";
  }
  if (value.env !== undefined) {
    if (!isRecord(value.env)) return "env must be a string map";
    const entries = Object.entries(value.env);
    if (entries.length > MAX_EXECUTION_ENV_ENTRIES) {
      return `env exceeds ${MAX_EXECUTION_ENV_ENTRIES} entries`;
    }
    for (const [name, entry] of entries) {
      if (!ENV_NAME_PATTERN.test(name)) {
        return "env contains an invalid variable name";
      }
      if (!isBoundedOpaqueString(entry, MAX_EXECUTION_ENV_VALUE_LENGTH)) {
        return "env values must be bounded NUL-free strings";
      }
    }
  }
  if (value.limits !== undefined && !isExecutionResourceLimits(value.limits)) {
    return "limits contains an unsupported or invalid limit";
  }
  if (
    value.leaseDeadline !== undefined &&
    value.leaseDeadline !== null &&
    !isTimestamp(value.leaseDeadline)
  ) {
    return "leaseDeadline must be null or an ISO timestamp";
  }
  return undefined;
}

/**
 * Why a stop was requested. The reason is evidence, not control: controller
 * crash, lease expiry and user cancel must stay distinguishable in the record.
 */
export type ExecutionStopReason =
  | "cancel"
  | "lease-expired"
  | "controller-shutdown"
  | "operator";

export const EXECUTION_STOP_REASONS = [
  "cancel",
  "lease-expired",
  "controller-shutdown",
  "operator",
] as const;

export interface StopExecutionRequest {
  reason: ExecutionStopReason;
  /** Grace before forced termination; backends may clamp further. */
  graceMs?: number;
}

export function validateStopExecutionRequest(
  value: unknown,
): string | undefined {
  if (!isRecord(value)) return "stop request must be an object";
  if (!hasOnlyKeys(["reason", "graceMs"], value)) {
    return "stop request contains an unsupported field";
  }
  if (!isExecutionStopReason(value.reason)) {
    return "stop reason is not recognized";
  }
  if (value.graceMs !== undefined) {
    if (
      typeof value.graceMs !== "number" ||
      !Number.isInteger(value.graceMs) ||
      value.graceMs < 0 ||
      value.graceMs > MAX_EXECUTION_GRACE_MS
    ) {
      return `graceMs must be an integer between 0 and ${MAX_EXECUTION_GRACE_MS}`;
    }
  }
  return undefined;
}

function isExecutionStopReason(value: unknown): value is ExecutionStopReason {
  return (
    typeof value === "string" &&
    (EXECUTION_STOP_REASONS as readonly string[]).includes(value)
  );
}

export interface ExecutionExitResult {
  /** Process exit code, or `null` when terminated by a signal. */
  exitCode: number | null;
  /** Signal name, or `null` when the unit exited on its own. */
  signal: string | null;
  /** Absolute time the exit was observed. */
  exitedAt: string;
}

/**
 * One observation of an execution unit. `desiredState` is the caller's
 * intent; `observedState` is what the backend can prove. They are not
 * interchangeable: a naturally exited unit can still be desired `running`.
 */
export interface ExecutionStatus {
  handle: RuntimeHandle;
  desiredState: ExecutionDesiredState;
  observedState: ExecutionObservedState;
  observedAt: string;
  leaseDeadline: string | null;
  /** Exit evidence once the unit is terminal. */
  exit?: ExecutionExitResult;
  /** Bounded diagnostic text. Never identity or acceptance evidence. */
  detail?: string;
}

export interface AttachExecutionResult {
  /**
   * The same authority with refreshed diagnostics. `backendType` and `handle`
   * must be byte-identical to the requested handle.
   */
  handle: RuntimeHandle;
  status: ExecutionStatus;
}

export interface ExecutionResult {
  handle: RuntimeHandle;
  exit: ExecutionExitResult;
  stdout: string;
  stderr: string;
  /** True when either stream was capped at MAX_EXECUTION_OUTPUT_CHARS. */
  outputTruncated: boolean;
}

export interface DestroyExecutionResult {
  handle: RuntimeHandle;
  /** Backend resources released with the record (pipes, PTY, temp dir, ...). */
  released: readonly string[];
  destroyedAt: string;
}

export function isExecutionExitResult(
  value: unknown,
): value is ExecutionExitResult {
  if (!isRecord(value)) return false;
  const exitCode = value.exitCode;
  const signal = value.signal;
  const codeOk =
    exitCode === null ||
    (typeof exitCode === "number" &&
      Number.isInteger(exitCode) &&
      exitCode >= 0 &&
      exitCode <= MAX_DIAGNOSTIC_ID);
  const signalOk =
    signal === null ||
    isBoundedOpaqueString(signal, MAX_EXECUTION_SIGNAL_LENGTH);
  if (!codeOk || !signalOk) return false;
  // An exit result needs at least one observed cause.
  if (exitCode === null && signal === null) return false;
  return isTimestamp(value.exitedAt);
}

export function isTerminalExecutionState(
  state: ExecutionObservedState,
): boolean {
  return state === "exited" || state === "stopped";
}

// ---------------------------------------------------------------------------
// Persisted execution handle
// ---------------------------------------------------------------------------

/**
 * Persisted identity for one attempt (delivery-control-plane-v2 §5).
 *
 * `runtime` is the recovery authority and maps to the StateStore
 * `runtime_type` + `runtime_handle` columns. PID/PGID diagnostics may be
 * present inside the handle but are never reconciliation keys.
 */
export interface ExecutionHandle {
  version: typeof EXECUTION_INTERFACE_VERSION;
  attemptId: string;
  workspaceId: string;
  runtime: RuntimeHandle;
  /** Design revision the attempt was compiled from, when known. */
  designRevision?: string;
  /** Exact code snapshot the attempt started from, when known. */
  baseCommit?: string;
  desiredState: ExecutionDesiredState;
  observedState: ExecutionObservedState;
  /** Absolute ISO deadline; `null` when none. */
  leaseDeadline: string | null;
  /** Exit evidence once the unit is terminal. */
  exit?: ExecutionExitResult;
  /** Opaque reference to the attempt's evidence bundle. */
  evidenceBundleRef?: string;
  updatedAt: string;
}

export function parseExecutionHandle(
  value: unknown,
): ExecutionHandle | undefined {
  if (!isRecord(value) || value.version !== EXECUTION_INTERFACE_VERSION) {
    return undefined;
  }
  if (
    !isIdentifier(value.attemptId, MAX_ATTEMPT_ID_LENGTH, ATTEMPT_ID_PATTERN) ||
    !isIdentifier(
      value.workspaceId,
      MAX_WORKSPACE_ID_LENGTH,
      WORKSPACE_ID_PATTERN,
    )
  ) {
    return undefined;
  }
  const runtime = parseRuntimeHandle(value.runtime);
  if (!runtime) return undefined;
  if (
    !isAttemptDesiredState(value.desiredState) ||
    !isAttemptObservedState(value.observedState)
  ) {
    return undefined;
  }
  if (
    !isTimestamp(value.updatedAt) ||
    !(value.leaseDeadline === null || isTimestamp(value.leaseDeadline))
  ) {
    return undefined;
  }

  let exit: ExecutionExitResult | undefined;
  if (value.exit !== undefined) {
    if (!isExecutionExitResult(value.exit)) return undefined;
    // An exit observation only makes sense for a terminal unit.
    if (!isTerminalExecutionState(value.observedState)) return undefined;
    exit = {
      exitCode: value.exit.exitCode,
      signal: value.exit.signal,
      exitedAt: value.exit.exitedAt,
    };
  }

  let designRevision: string | undefined;
  if (value.designRevision !== undefined) {
    if (!isBoundedText(value.designRevision, MAX_EXECUTION_REF_LENGTH)) {
      return undefined;
    }
    designRevision = value.designRevision;
  }
  let baseCommit: string | undefined;
  if (value.baseCommit !== undefined) {
    if (!isBoundedText(value.baseCommit, MAX_EXECUTION_REF_LENGTH)) {
      return undefined;
    }
    baseCommit = value.baseCommit;
  }
  let evidenceBundleRef: string | undefined;
  if (value.evidenceBundleRef !== undefined) {
    if (!isBoundedText(value.evidenceBundleRef, MAX_EXECUTION_REF_LENGTH)) {
      return undefined;
    }
    evidenceBundleRef = value.evidenceBundleRef;
  }

  return {
    version: EXECUTION_INTERFACE_VERSION,
    attemptId: value.attemptId,
    workspaceId: value.workspaceId,
    runtime,
    ...(designRevision !== undefined ? { designRevision } : {}),
    ...(baseCommit !== undefined ? { baseCommit } : {}),
    desiredState: value.desiredState,
    observedState: value.observedState,
    leaseDeadline: value.leaseDeadline,
    ...(exit !== undefined ? { exit } : {}),
    ...(evidenceBundleRef !== undefined ? { evidenceBundleRef } : {}),
    updatedAt: value.updatedAt,
  };
}

// ---------------------------------------------------------------------------
// Bounded value helpers
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(
  allowed: readonly string[],
  value: Record<string, unknown>,
): boolean {
  const allowedSet = new Set(allowed);
  return Object.keys(value).every((key) => allowedSet.has(key));
}

function isIdentifier(
  value: unknown,
  maxLength: number,
  pattern: RegExp,
): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= maxLength &&
    value === value.trim() &&
    pattern.test(value)
  );
}

/** Bounded display text: non-empty, trimmed, no control characters. */
function isBoundedText(value: unknown, maxLength: number): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= maxLength &&
    value === value.trim() &&
    !CONTROL_CHARACTERS.test(value)
  );
}

/** Bounded argv/env value: may contain newlines, never NUL. */
function isBoundedOpaqueString(
  value: unknown,
  maxLength: number,
): value is string {
  return (
    typeof value === "string" &&
    value.length <= maxLength &&
    !value.includes("\u0000")
  );
}

function isTimestamp(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_TIMESTAMP_LENGTH &&
    value === value.trim() &&
    !Number.isNaN(Date.parse(value))
  );
}

function isDiagnosticId(value: unknown): value is number | null {
  return (
    value === null ||
    (typeof value === "number" &&
      Number.isInteger(value) &&
      value >= 1 &&
      value <= MAX_DIAGNOSTIC_ID)
  );
}

function isOptionalPositiveInteger(value: unknown): boolean {
  return (
    value === undefined ||
    (typeof value === "number" &&
      Number.isInteger(value) &&
      value > 0 &&
      value <= Number.MAX_SAFE_INTEGER)
  );
}

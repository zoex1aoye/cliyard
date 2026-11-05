/**
 * POSIX process-group ExecutionSupervisor backend and its conformance manifest
 * (design/execution-supervisor-v0.md).
 *
 * This backend is deliberately small and honest:
 *
 * - Identity authority is the canonical `pg1:<pgid>:<hex(startedAt)>` handle
 *   from `worker-lease.ts`. pid/pgid are diagnostics only.
 * - A unit is one dedicated process group: the leader is spawned detached, so
 *   `pid === pgid`, and every signal addresses `kill(-pgid, signal)` only
 *   after the exact leader identity `(pid, pgid, lstart)` was re-verified.
 * - The backend is not full descendant-tree containment. A descendant that
 *   calls `setsid()` leaves the group and is outside control. If the leader
 *   exits while group members remain, the unit is reported `lost` and no
 *   signal is sent, because the exact leader identity is no longer available.
 * - Stop is fail-closed: absent, reused or unverifiable leader identity never
 *   authorizes a negative-pgid signal.
 * - Durable recovery is opt-in (`stateDir`). Records are keyed by a hash of
 *   the runtime-handle identity and are never used to synthesize authority.
 * - No PTY is allocated, and no resource, filesystem or network limit is
 *   enforced. Requests that ask for a resource limit are rejected.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import {
  WORKER_PROCESS_GROUP_BACKEND,
  processGroupIdentityFromRuntimeHandle,
  processGroupRuntimeHandle,
} from "../agents/worker-lease.js";
import {
  ProcessInspector,
  compareProcessIdentity,
  isProcessIdentity,
  type ProcessGroupMember,
} from "../runtime/process.js";
import type { RuntimeProcessIdentity } from "../runtime/types.js";
import {
  isAttemptDesiredState,
  isAttemptObservedState,
} from "../statestore/schema.js";
import {
  ExecutionError,
  asExecutionError,
  throwIfExecutionAborted,
  type ExecutionContext,
  type ExecutionOperation,
  type ExecutionSupervisor,
} from "./supervisor.js";
import {
  EXECUTION_STOP_REASONS,
  MAX_EXECUTION_DETAIL_LENGTH,
  MAX_EXECUTION_GRACE_MS,
  MAX_EXECUTION_OUTPUT_CHARS,
  isExecutionExitResult,
  isTerminalExecutionState,
  parseRuntimeHandle,
  runtimeHandleKey,
  sameRuntimeHandle,
  validateStartExecutionRequest,
  validateStopExecutionRequest,
  type AttachExecutionResult,
  type DestroyExecutionResult,
  type ExecutionCapabilities,
  type ExecutionDesiredState,
  type ExecutionExitResult,
  type ExecutionObservedState,
  type ExecutionResult,
  type ExecutionStatus,
  type ExecutionStopReason,
  type RuntimeHandle,
  type StartExecutionRequest,
  type StopExecutionRequest,
} from "./types.js";

export const PROCESS_GROUP_BACKEND_TYPE = WORKER_PROCESS_GROUP_BACKEND;

/** Directory/file naming for durable conformance records. */
export const PROCESS_GROUP_UNITS_DIR = "units";
export const PROCESS_GROUP_RECORD_VERSION = 1 as const;
export const PROCESS_GROUP_RECORD_MARKER = ".cliyard-execution-unit";
export const PROCESS_GROUP_TEMP_PREFIX = "cliyard-pg-";

const MAX_UNIT_RECORDS_SCANNED = 512;
const DEFAULT_TERM_GRACE_MS = 2_000;
const DEFAULT_KILL_GRACE_MS = 1_000;
const DEFAULT_POLL_MS = 50;
const DEFAULT_PIPE_DRAIN_MS = 750;
const DEFAULT_SPAWN_TIMEOUT_MS = 5_000;
const IDENTITY_CAPTURE_ATTEMPTS = 40;
const IDENTITY_CAPTURE_INTERVAL_MS = 25;
const EXIT_RACE_WAIT_MS = 200;
const MAX_OWN_GROUP_CAPTURE_ATTEMPTS = 3;

const ATTEMPT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const WORKSPACE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@/-]*$/;
const CONTROL_CHARACTERS = /[\x00-\x1f\x7f]/;

// ---------------------------------------------------------------------------
// Capability limits and conformance manifest
// ---------------------------------------------------------------------------

/**
 * Documented capability limits of the POSIX process-group backend.
 *
 * These are evidence for operators and for the conformance suite. They are not
 * claims of cgroup/launchd/systemd-equivalent containment.
 */
export const PROCESS_GROUP_CAPABILITY_LIMITS = Object.freeze({
  backendType: PROCESS_GROUP_BACKEND_TYPE,
  containment: "single-process-group",
  descendantControl: "partial",
  fullDescendantTreeContainment: false,
  cgroupEquivalentContainment: false,
  setsidEscapeContained: false,
  orphanedDescendantsAfterLeaderExit:
    "refused-without-exact-leader-identity",
  identityReusePolicy: "fail-closed-never-signal",
  ptyAllocation: "unsupported",
  resourceLimits: "unsupported",
  filesystemIsolation: "unsupported",
  networkIsolation: "unsupported",
  restartRecovery: "partial",
  restartRecoveryRequiresStateDir: true,
  liveOutputAfterControllerDeath: "persisted-prefix-only",
  signalMechanism: "kill(-pgid) after exact (pid, pgid, lstart) verification",
} as const);

export type ProcessGroupCapabilityLimits =
  typeof PROCESS_GROUP_CAPABILITY_LIMITS;

export type ConformanceGuarantee =
  | "enforced"
  | "observed"
  | "documented-limit";

export interface RuntimeConformanceCase {
  id: string;
  title: string;
  /** What the suite can prove for this case. */
  guarantee: ConformanceGuarantee;
  description: string;
}

/**
 * The runtime-conformance suite cases. `guarantee: "documented-limit"` means
 * the case proves the limit exists and that the harness can leave no residual
 * by reaping only exact verified identities; it is not a containment claim.
 */
export const RUNTIME_CONFORMANCE_CASES: readonly RuntimeConformanceCase[] =
  Object.freeze([
    Object.freeze({
      id: "setsid-escape",
      title: "A setsid escape leaves the group and is not contained",
      guarantee: "documented-limit",
      description:
        "An escaped descendant survives Stop because it is outside the " +
        "managed process group; the conformance harness reaps it by exact " +
        "identity and proves no residual remains.",
    }),
    Object.freeze({
      id: "orphaned-grandchildren",
      title: "Orphaned grandchildren after leader exit are never signalled",
      guarantee: "enforced",
      description:
        "When the leader is gone and group members remain, the unit is " +
        "reported lost and Stop fails closed with ambiguous without sending " +
        "a signal.",
    }),
    Object.freeze({
      id: "closed-output-pipes",
      title: "Exit and collection do not wait for inherited output pipes",
      guarantee: "enforced",
      description:
        "An escaped descendant that holds inherited stdout/stderr cannot " +
        "block exit observation or Collect; Destroy releases the read ends.",
    }),
    Object.freeze({
      id: "controller-restart-attach",
      title: "A new controller re-attaches by RuntimeHandle",
      guarantee: "enforced",
      description:
        "After the controller is killed, a new supervisor loads the durable " +
        "record by the canonical handle, re-verifies the exact leader " +
        "identity, and re-attaches without rerunning the unit.",
    }),
    Object.freeze({
      id: "cancel-never-rerun",
      title: "An explicitly cancelled attempt is never rerun by restart",
      guarantee: "enforced",
      description:
        "A terminal Stop(cancel) record is reported terminal by a restarted " +
        "controller, restartDisposition says do-not-rerun, and Start with the " +
        "same attemptId is rejected as already-exists.",
    }),
    Object.freeze({
      id: "resource-cleanup",
      title: "Destroy releases pipes, temp dir, records and handles",
      guarantee: "enforced",
      description:
        "Destroy on a terminal unit releases read ends, the per-unit temp " +
        "directory and the durable record, and subsequent operations report " +
        "not-found. No PTY exists to release.",
    }),
    Object.freeze({
      id: "parallel-isolation",
      title: "Stopping one unit does not affect a parallel unit",
      guarantee: "enforced",
      description:
        "Two units have distinct handles and process groups; stopping one " +
        "leaves the other live and producing output.",
    }),
    Object.freeze({
      id: "identity-reuse",
      title: "A reused or mismatched leader identity is never signalled",
      guarantee: "enforced",
      description:
        "A durable record whose canonical handle encodes a start identity " +
        "that does not match the live leader is reported lost; Stop raises " +
        "ambiguous and sends no signal.",
    }),
  ]);

// ---------------------------------------------------------------------------
// Capabilities
// ---------------------------------------------------------------------------

export interface ProcessGroupCapabilityOptions {
  /** Durable restart re-attach is available only with a state directory. */
  durableRestartRecovery?: boolean;
}

export function defaultProcessGroupCapabilities(
  options: ProcessGroupCapabilityOptions = {},
): ExecutionCapabilities {
  const durableRestartRecovery = options.durableRestartRecovery === true;
  const notes = [
    "POSIX process group: signals address only the verified leader's group.",
    "setsid() escapes the group; escaped descendants are outside backend " +
      "control and are a documented capability limit.",
    "If the leader identity is absent, reused or unverifiable, Stop fails " +
      "closed with ambiguous and sends no signal.",
    "A cancelled or otherwise terminal attempt is never rerun by restart; " +
      "a rerun requires a new attemptId.",
    "No PTY is allocated; stdout/stderr are bounded pipes.",
    "No resource limits, filesystem isolation or network isolation are " +
      "enforced; requests for a resource limit are rejected.",
    "Output is bounded and persisted as a prefix flushed on state " +
      "transitions and explicit flush().",
    durableRestartRecovery
      ? "Restart re-attach verifies the exact leader identity from the " +
        "canonical pg1 handle before reporting a live unit."
      : "Without stateDir, a new controller cannot re-attach after restart; " +
        "restart recovery is unavailable.",
  ];
  return freezeCapabilities({
    backendType: PROCESS_GROUP_BACKEND_TYPE,
    descendantControl: "partial",
    restartRecovery: durableRestartRecovery ? "partial" : "unsupported",
    resourceLimits: {
      cpu: false,
      memory: false,
      processCount: false,
      openFiles: false,
    },
    filesystemIsolation: "unsupported",
    networkIsolation: "unsupported",
    notes,
  });
}

/** Whether a restarted controller may re-attach, rerun or escalate. */
export type RestartDisposition = "attach" | "do-not-rerun" | "needs-human";

/**
 * Decide what a restart reconciliation may do with an observed unit.
 *
 * Terminal units are explicitly never rerun. Lost or unknown units require a
 * human because identity cannot be proven. Only live units may be attached.
 */
export function restartDisposition(status: ExecutionStatus): RestartDisposition {
  if (isTerminalExecutionState(status.observedState)) return "do-not-rerun";
  switch (status.observedState) {
    case "starting":
    case "running":
    case "stopping":
      return "attach";
    case "lost":
    case "unknown":
      return "needs-human";
    default:
      return "needs-human";
  }
}

// ---------------------------------------------------------------------------
// Durable conformance record
// ---------------------------------------------------------------------------

/**
 * One durable unit record.
 *
 * `handle` is the only authority; no separate pid/pgid field exists. The
 * record is metadata and evidence, never a second identity.
 */
export interface ProcessGroupConformanceRecord {
  version: typeof PROCESS_GROUP_RECORD_VERSION;
  handle: RuntimeHandle;
  attemptId: string;
  workspaceId: string;
  command: readonly string[];
  cwd?: string;
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
  tempDir: string | null;
  tempRoot: string;
  lastSignal?: string;
  detail?: string;
}

/** Deterministic record path; `undefined` for an unusable handle. */
export function processGroupRecordPath(
  stateDir: string,
  handle: RuntimeHandle,
): string | undefined {
  if (typeof stateDir !== "string" || stateDir.trim() === "") {
    return undefined;
  }
  const parsed = parseRuntimeHandle(handle);
  if (
    parsed === undefined ||
    parsed.backendType !== PROCESS_GROUP_BACKEND_TYPE ||
    processGroupIdentityFromRuntimeHandle(parsed) === undefined
  ) {
    return undefined;
  }
  const digest = createHash("sha256")
    .update(runtimeHandleKey(parsed), "utf8")
    .digest("hex");
  return join(resolve(stateDir), PROCESS_GROUP_UNITS_DIR, `${digest}.json`);
}

/**
 * Validate a durable record. Unknown fields are ignored, but every declared
 * field must be well formed; a malformed record must fail closed upstream.
 */
export function decodeProcessGroupRecord(
  value: unknown,
): ProcessGroupConformanceRecord | undefined {
  if (!isRecord(value)) return undefined;
  if (value.version !== PROCESS_GROUP_RECORD_VERSION) return undefined;

  const handle = parseRuntimeHandle(value.handle);
  if (
    handle === undefined ||
    handle.backendType !== PROCESS_GROUP_BACKEND_TYPE ||
    processGroupIdentityFromRuntimeHandle(handle) === undefined
  ) {
    return undefined;
  }
  if (!isBoundedIdentifier(value.attemptId, 256, ATTEMPT_ID_PATTERN)) {
    return undefined;
  }
  if (!isBoundedIdentifier(value.workspaceId, 512, WORKSPACE_ID_PATTERN)) {
    return undefined;
  }
  if (
    !Array.isArray(value.command) ||
    value.command.length === 0 ||
    value.command.length > 256 ||
    !value.command.every((arg) => typeof arg === "string")
  ) {
    return undefined;
  }
  if (
    value.cwd !== undefined &&
    !(typeof value.cwd === "string" && value.cwd.length > 0)
  ) {
    return undefined;
  }
  if (!isAttemptDesiredState(value.desiredState)) return undefined;
  if (!isAttemptObservedState(value.observedState)) return undefined;
  if (value.leaseDeadline !== null && !isTimestamp(value.leaseDeadline)) {
    return undefined;
  }
  if (!isTimestamp(value.startedAt) || !isTimestamp(value.observedAt)) {
    return undefined;
  }
  let stopReason: ExecutionStopReason | undefined;
  if (value.stopReason !== undefined) {
    if (!isExecutionStopReason(value.stopReason)) return undefined;
    stopReason = value.stopReason;
  }

  let exit: ExecutionExitResult | undefined;
  if (value.exit !== undefined) {
    if (!isExecutionExitResult(value.exit)) return undefined;
    exit = {
      exitCode: value.exit.exitCode,
      signal: value.exit.signal,
      exitedAt: value.exit.exitedAt,
    };
  }
  if (isTerminalExecutionState(value.observedState) && exit === undefined) {
    // A terminal unit without exit evidence is not collectable; refuse to
    // accept a record that would force collect() into an internal error.
    return undefined;
  }

  const stdout = value.stdout;
  const stderr = value.stderr;
  const outputTruncated = value.outputTruncated;
  if (
    typeof stdout !== "string" ||
    stdout.length > MAX_EXECUTION_OUTPUT_CHARS ||
    typeof stderr !== "string" ||
    stderr.length > MAX_EXECUTION_OUTPUT_CHARS ||
    typeof outputTruncated !== "boolean"
  ) {
    return undefined;
  }
  const tempDir = value.tempDir;
  if (
    tempDir !== null &&
    (typeof tempDir !== "string" || tempDir.length === 0)
  ) {
    return undefined;
  }
  if (typeof value.tempRoot !== "string" || value.tempRoot.length === 0) {
    return undefined;
  }
  const lastSignal = value.lastSignal;
  if (
    lastSignal !== undefined &&
    !(
      typeof lastSignal === "string" &&
      lastSignal.length > 0 &&
      lastSignal.length <= 64
    )
  ) {
    return undefined;
  }
  const detail = value.detail;
  if (detail !== undefined && !isBoundedDetail(detail)) {
    return undefined;
  }

  return {
    version: PROCESS_GROUP_RECORD_VERSION,
    handle,
    attemptId: value.attemptId,
    workspaceId: value.workspaceId,
    command: [...(value.command as string[])],
    ...(value.cwd !== undefined ? { cwd: value.cwd } : {}),
    desiredState: value.desiredState,
    observedState: value.observedState,
    leaseDeadline: value.leaseDeadline,
    startedAt: value.startedAt,
    observedAt: value.observedAt,
    ...(exit !== undefined ? { exit } : {}),
    ...(stopReason !== undefined ? { stopReason } : {}),
    stdout,
    stderr,
    outputTruncated,
    tempDir,
    tempRoot: value.tempRoot,
    ...(lastSignal !== undefined ? { lastSignal } : {}),
    ...(detail !== undefined ? { detail } : {}),
  };
}

// ---------------------------------------------------------------------------
// Supervisor
// ---------------------------------------------------------------------------

export interface ProcessGroupExecutionSupervisorOptions {
  /** Read-only inspector; defaults to `new ProcessInspector()`. */
  inspector?: ProcessInspector;
  /** Injected clock for deterministic tests. */
  now?: () => Date;
  /**
   * Enables durable restart recovery. Records live under
   * `<stateDir>/units/<sha256(runtimeHandleKey)>.json`.
   */
  stateDir?: string;
  /** Parent for per-unit temp dirs; defaults to `os.tmpdir()`. */
  tempRoot?: string;
  termGraceMs?: number;
  killGraceMs?: number;
  pollMs?: number;
  /** Bounded wait for inherited output pipes after leader exit. */
  pipeDrainMs?: number;
  /** Per-stream bound; clamped to MAX_EXECUTION_OUTPUT_CHARS. */
  maxOutputChars?: number;
  spawnTimeoutMs?: number;
}

export interface ProcessGroupOutput {
  stdout: string;
  stderr: string;
  outputTruncated: boolean;
}

export type TempDirOwnership =
  | "verified"
  | "unverified"
  | "missing"
  | "no-temp-dir";

/**
 * Resource evidence for conformance tests and operators. This is observation
 * only: it never authorizes a signal and is not identity.
 */
export interface ProcessGroupResourceSnapshot {
  handle: RuntimeHandle;
  recordPath: string | null;
  recordExists: boolean;
  tempDir: string | null;
  tempDirExists: boolean;
  tempDirOwnership: TempDirOwnership;
  stdoutPipeOpen: boolean;
  stderrPipeOpen: boolean;
  /** `null` when this controller did not spawn the unit. */
  childExited: boolean | null;
  groupMembers: number | null;
  groupIdentity: "match" | "mismatch" | "unknown" | "absent";
  /** This backend never allocates a PTY. */
  pty: null;
}

export interface ProcessGroupExecutionSupervisor extends ExecutionSupervisor {
  readonly backendType: typeof PROCESS_GROUP_BACKEND_TYPE;

  // The concrete backend defaults the call context to `{}`; every operation
  // still checks for cancellation at entry and after awaited boundaries.
  start(
    request: StartExecutionRequest,
    context?: ExecutionContext,
  ): Promise<RuntimeHandle>;
  inspect(
    handle: RuntimeHandle,
    context?: ExecutionContext,
  ): Promise<ExecutionStatus>;
  attach(
    handle: RuntimeHandle,
    context?: ExecutionContext,
  ): Promise<AttachExecutionResult>;
  stop(
    handle: RuntimeHandle,
    request: StopExecutionRequest,
    context?: ExecutionContext,
  ): Promise<ExecutionStatus>;
  collect(
    handle: RuntimeHandle,
    context?: ExecutionContext,
  ): Promise<ExecutionResult>;
  destroy(
    handle: RuntimeHandle,
    context?: ExecutionContext,
  ): Promise<DestroyExecutionResult>;

  /** Wait for all queued durable writes, then surface the first failure. */
  flush(): Promise<void>;

  /** Current bounded output buffers for a unit (not an interface operation). */
  output(
    handle: RuntimeHandle,
    context?: ExecutionContext,
  ): Promise<ProcessGroupOutput>;

  /** Read-only resource evidence for a unit. */
  resources(
    handle: RuntimeHandle,
    context?: ExecutionContext,
  ): Promise<ProcessGroupResourceSnapshot>;

  /** Deterministic durable record path, or `null` without `stateDir`. */
  recordPathFor(handle: RuntimeHandle): string | null;
}

interface ProcessGroupUnit {
  handle: RuntimeHandle;
  identity: RuntimeProcessIdentity;
  attemptId: string;
  workspaceId: string;
  command: string[];
  cwd?: string;
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
  tempDir: string | null;
  tempRoot: string;
  lastSignal?: string;
  detail?: string;
  child?: ChildProcess;
  /** The leader's exit was observed by this controller. */
  exited: boolean;
  /** In-flight post-exit group verification. */
  settling?: Promise<void>;
  stdoutOpen: boolean;
  stderrOpen: boolean;
  pipeDrainTimer?: NodeJS.Timeout;
  writeChain: Promise<void>;
  persistenceError?: Error;
  destroyed: boolean;
}

type GroupVerification =
  | { kind: "verified"; members: ProcessGroupMember[] }
  | { kind: "gone"; detail: string }
  | { kind: "ambiguous"; detail: string };

type GroupEmptyResult =
  | { kind: "empty" }
  | { kind: "timeout"; members: number }
  | { kind: "identity-lost"; detail: string }
  | { kind: "error"; detail: string };

export function createProcessGroupExecutionSupervisor(
  options: ProcessGroupExecutionSupervisorOptions = {},
): ProcessGroupExecutionSupervisor {
  return new ProcessGroupExecutionSupervisorImpl(options);
}

class ProcessGroupExecutionSupervisorImpl
  implements ProcessGroupExecutionSupervisor
{
  readonly backendType = PROCESS_GROUP_BACKEND_TYPE;

  private readonly inspector: ProcessInspector;
  private readonly now: () => Date;
  private readonly stateDir: string | undefined;
  private readonly tempRoot: string;
  private readonly termGraceMs: number;
  private readonly killGraceMs: number;
  private readonly pollMs: number;
  private readonly pipeDrainMs: number;
  private readonly maxOutputChars: number;
  private readonly spawnTimeoutMs: number;
  private readonly units = new Map<string, ProcessGroupUnit>();
  private readonly declaredCapabilities: ExecutionCapabilities;
  private ownGroupPromise: Promise<number | undefined> | undefined;
  private writeCounter = 0;

  constructor(options: ProcessGroupExecutionSupervisorOptions) {
    if (
      options === null ||
      typeof options !== "object" ||
      Array.isArray(options)
    ) {
      throw new TypeError("process-group supervisor options must be an object");
    }
    this.inspector = options.inspector ?? new ProcessInspector();
    this.now = options.now ?? (() => new Date());

    if (options.stateDir !== undefined) {
      if (typeof options.stateDir !== "string" || options.stateDir.trim() === "") {
        throw new TypeError("stateDir must be a non-empty path string");
      }
      this.stateDir = resolve(options.stateDir);
    }
    if (options.tempRoot !== undefined) {
      if (typeof options.tempRoot !== "string" || options.tempRoot.trim() === "") {
        throw new TypeError("tempRoot must be a non-empty path string");
      }
      this.tempRoot = resolve(options.tempRoot);
    } else {
      this.tempRoot = tmpdir();
    }

    this.termGraceMs = boundedInteger(
      options.termGraceMs,
      DEFAULT_TERM_GRACE_MS,
      MAX_EXECUTION_GRACE_MS,
      "termGraceMs",
    );
    this.killGraceMs = boundedInteger(
      options.killGraceMs,
      DEFAULT_KILL_GRACE_MS,
      MAX_EXECUTION_GRACE_MS,
      "killGraceMs",
    );
    this.pollMs = boundedInteger(
      options.pollMs,
      DEFAULT_POLL_MS,
      5_000,
      "pollMs",
    );
    this.pipeDrainMs = boundedInteger(
      options.pipeDrainMs,
      DEFAULT_PIPE_DRAIN_MS,
      300_000,
      "pipeDrainMs",
    );
    this.maxOutputChars = boundedInteger(
      options.maxOutputChars,
      MAX_EXECUTION_OUTPUT_CHARS,
      MAX_EXECUTION_OUTPUT_CHARS,
      "maxOutputChars",
      1,
    );
    this.spawnTimeoutMs = boundedInteger(
      options.spawnTimeoutMs,
      DEFAULT_SPAWN_TIMEOUT_MS,
      60_000,
      "spawnTimeoutMs",
    );

    this.declaredCapabilities = defaultProcessGroupCapabilities({
      durableRestartRecovery: this.stateDir !== undefined,
    });
  }

  capabilities(): ExecutionCapabilities {
    return this.declaredCapabilities;
  }

  // -- Start ---------------------------------------------------------------

  async start(
    request: StartExecutionRequest,
    context: ExecutionContext = {},
  ): Promise<RuntimeHandle> {
    this.enter("start", context);
    const problem = validateStartExecutionRequest(request);
    if (problem !== undefined) {
      throw new ExecutionError("invalid-request", "start", problem);
    }
    if (!this.inspector.supported) {
      throw new ExecutionError(
        "unsupported",
        "start",
        "the process-group backend requires macOS or Linux process identity " +
          "inspection",
      );
    }
    const unsupportedLimit = this.unsupportedLimit(request.limits);
    if (unsupportedLimit !== undefined) {
      throw new ExecutionError(
        "unsupported",
        "start",
        `backend ${PROCESS_GROUP_BACKEND_TYPE} cannot enforce resource limit ` +
          unsupportedLimit,
      );
    }

    await this.assertAttemptNotRecorded(request.attemptId);
    this.enter("start", context);

    let unit: ProcessGroupUnit | undefined;
    try {
      await mkdir(this.tempRoot, { recursive: true, mode: 0o700 });
      const tempDir = await mkdtemp(
        join(this.tempRoot, PROCESS_GROUP_TEMP_PREFIX),
      );
      const command = [...request.command];
      const at = this.timestamp();
      unit = {
        handle: {
          backendType: PROCESS_GROUP_BACKEND_TYPE,
          handle: "",
          diagnostics: { pid: null, pgid: null },
        },
        identity: { pid: 0, pgid: 0, startedAt: "" },
        attemptId: request.attemptId,
        workspaceId: request.workspaceId,
        command,
        ...(request.cwd !== undefined ? { cwd: request.cwd } : {}),
        desiredState: "running",
        observedState: "starting",
        leaseDeadline: request.leaseDeadline ?? null,
        startedAt: at,
        observedAt: at,
        stdout: "",
        stderr: "",
        outputTruncated: false,
        tempDir,
        tempRoot: this.tempRoot,
        exited: false,
        stdoutOpen: false,
        stderrOpen: false,
        writeChain: Promise.resolve(),
        destroyed: false,
      };

      const child = await this.spawnUnit(unit, request);
      unit.child = child;
      this.attachOutput(unit, child);

      const identity = await this.captureSpawnedIdentity(child.pid);
      throwIfExecutionAborted(context, "start");
      if (
        identity === undefined ||
        identity.pid !== identity.pgid ||
        identity.pid !== child.pid
      ) {
        throw new ExecutionError(
          "backend-failure",
          "start",
          "spawned unit did not become an observable dedicated-group leader",
        );
      }
      unit.identity = identity;
      unit.handle = processGroupRuntimeHandle(identity);
      unit.observedState = "running";
      unit.observedAt = this.timestamp();

      await writeFile(
        join(tempDir, PROCESS_GROUP_RECORD_MARKER),
        `${runtimeHandleKey(unit.handle)}\n`,
        { mode: 0o600 },
      );
      throwIfExecutionAborted(context, "start");

      await this.queuePersist(unit);
      throwIfExecutionAborted(context, "start");
    } catch (error) {
      if (unit !== undefined) {
        await this.discardFailedStart(unit).catch(() => undefined);
      }
      throw asExecutionError(error, "start");
    }

    const started = unit;
    if (started === undefined) {
      throw new ExecutionError(
        "internal",
        "start",
        "start completed without a unit",
      );
    }
    this.units.set(runtimeHandleKey(started.handle), started);
    return copyHandle(started.handle);
  }

  private async spawnUnit(
    unit: ProcessGroupUnit,
    request: StartExecutionRequest,
  ): Promise<ChildProcess> {
    const [program, ...args] = request.command;
    if (program === undefined) {
      throw new ExecutionError(
        "invalid-request",
        "start",
        "command must have a program",
      );
    }
    let child: ChildProcess;
    try {
      child = spawn(program, args, {
        ...(request.cwd !== undefined ? { cwd: request.cwd } : {}),
        env:
          request.env !== undefined
            ? { ...request.env }
            : { ...process.env },
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch (error) {
      throw new ExecutionError(
        "backend-failure",
        "start",
        `cannot spawn execution unit: ${boundedMessage(errorMessage(error))}`,
        { cause: error },
      );
    }

    return new Promise<ChildProcess>((resolveSpawn, rejectSpawn) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        rejectSpawn(
          new ExecutionError(
            "backend-failure",
            "start",
            `spawn did not complete within ${this.spawnTimeoutMs}ms`,
          ),
        );
      }, this.spawnTimeoutMs);
      timer.unref?.();

      child.once("spawn", () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolveSpawn(child);
      });
      child.on("error", (error) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          rejectSpawn(
            new ExecutionError(
              "backend-failure",
              "start",
              `cannot spawn execution unit: ${boundedMessage(error.message)}`,
              { cause: error },
            ),
          );
          return;
        }
        // Post-spawn errors are observational only; the exit event owns the
        // terminal transition.
        unit.detail = boundedMessage(
          `process reported an error after spawn: ${error.message}`,
        );
      });
      child.once("exit", (code, signal) => {
        this.onLeaderExit(unit, code, signal);
      });
    });
  }

  private async captureSpawnedIdentity(
    pid: number | undefined,
  ): Promise<RuntimeProcessIdentity | undefined> {
    if (pid === undefined) return undefined;
    for (let attempt = 0; attempt < IDENTITY_CAPTURE_ATTEMPTS; attempt += 1) {
      const identity = await this.inspector.capture(pid);
      if (identity !== undefined) return identity;
      if (attempt + 1 < IDENTITY_CAPTURE_ATTEMPTS) {
        await sleep(IDENTITY_CAPTURE_INTERVAL_MS);
      }
    }
    return undefined;
  }

  private attachOutput(unit: ProcessGroupUnit, child: ChildProcess): void {
    const bind = (
      stream: NodeJS.ReadableStream | null,
      key: "stdout" | "stderr",
    ): void => {
      if (stream === null) return;
      const text = stream as NodeJS.ReadableStream & {
        setEncoding(encoding: BufferEncoding): void;
      };
      text.setEncoding("utf8");
      text.on("data", (chunk: string | Buffer) => {
        this.appendOutput(unit, key, String(chunk));
      });
      text.on("error", () => {
        // A broken pipe is a resource condition, never execution evidence.
      });
      text.on("close", () => {
        if (key === "stdout") {
          unit.stdoutOpen = false;
        } else {
          unit.stderrOpen = false;
        }
      });
      if (key === "stdout") {
        unit.stdoutOpen = true;
      } else {
        unit.stderrOpen = true;
      }
    };
    bind(child.stdout, "stdout");
    bind(child.stderr, "stderr");
  }

  private appendOutput(
    unit: ProcessGroupUnit,
    key: "stdout" | "stderr",
    chunk: string,
  ): void {
    if (unit.destroyed) return;
    // Output can keep arriving from a pipe held outside the process group;
    // it stays bounded and is discarded with the unit.
    const current = unit[key];
    const remaining = this.maxOutputChars - current.length;
    if (remaining <= 0) {
      unit.outputTruncated = true;
      return;
    }
    if (chunk.length <= remaining) {
      unit[key] = current + chunk;
      return;
    }
    unit[key] = current + chunk.slice(0, remaining);
    unit.outputTruncated = true;
  }

  private onLeaderExit(
    unit: ProcessGroupUnit,
    code: number | null,
    signal: NodeJS.Signals | null,
  ): void {
    if (unit.exited) return;
    unit.exited = true;
    if (code === null && signal === null) {
      // The OS did not report a cause. Do not synthesize one; leave exit
      // evidence absent and let post-exit verification classify the unit.
      unit.detail = boundedMessage(
        "leader exited without an OS-reported exit code or signal",
      );
    } else {
      unit.exit = {
        exitCode: code,
        signal: signal ?? null,
        exitedAt: this.timestamp(),
      };
    }

    if (isTerminalExecutionState(unit.observedState)) {
      unit.settling = this.queuePersist(unit);
      return;
    }
    unit.settling = this.settleAfterLeaderExit(unit);
  }

  private async settleAfterLeaderExit(unit: ProcessGroupUnit): Promise<void> {
    if (unit.destroyed) return;
    let members: ProcessGroupMember[];
    try {
      members = await this.inspector.listGroupMembers(unit.identity.pgid);
    } catch (error) {
      if (isTerminalExecutionState(unit.observedState)) return;
      unit.observedState = "unknown";
      unit.observedAt = this.timestamp();
      unit.detail = boundedMessage(
        `cannot verify the process group after leader exit: ${
          errorMessage(error)
        }`,
      );
      await this.queuePersist(unit);
      this.armPipeDrain(unit);
      return;
    }
    if (isTerminalExecutionState(unit.observedState)) return;

    unit.observedAt = this.timestamp();
    if (members.length === 0) {
      unit.observedState =
        unit.lastSignal !== undefined ? "stopped" : "exited";
      unit.detail = undefined;
      if (unit.exit === undefined) {
        // The leader exit was observed but had no cause; keep the record
        // non-terminal rather than inventing an exit result.
        unit.observedState = "lost";
        unit.detail = boundedMessage(
          "leader exited and the group is empty, but no exit evidence was " +
            "reported",
        );
      }
    } else {
      unit.observedState = "lost";
      unit.detail = boundedMessage(
        `leader exited but ${members.length} process(es) remain in its ` +
          "group; refusing to signal without the exact leader identity",
      );
    }
    await this.queuePersist(unit);
    this.armPipeDrain(unit);
  }

  private armPipeDrain(unit: ProcessGroupUnit): void {
    if (unit.pipeDrainTimer !== undefined) return;
    if (!unit.stdoutOpen && !unit.stderrOpen) return;
    const timer = setTimeout(() => {
      unit.pipeDrainTimer = undefined;
      this.releasePipes(unit);
    }, this.pipeDrainMs);
    timer.unref();
    unit.pipeDrainTimer = timer;
  }

  private releasePipes(unit: ProcessGroupUnit): string[] {
    const released: string[] = [];
    const stdout = unit.child?.stdout;
    if (stdout !== null && stdout !== undefined && unit.stdoutOpen) {
      stdout.destroy();
      unit.stdoutOpen = false;
      released.push("stdout-pipe");
    }
    const stderr = unit.child?.stderr;
    if (stderr !== null && stderr !== undefined && unit.stderrOpen) {
      stderr.destroy();
      unit.stderrOpen = false;
      released.push("stderr-pipe");
    }
    return released;
  }

  private async discardFailedStart(unit: ProcessGroupUnit): Promise<void> {
    const child = unit.child;
    if (child !== undefined) {
      const identity = unit.identity;
      const verified =
        isProcessIdentity(identity) &&
        identity.pid === identity.pgid &&
        identity.pgid > 1 &&
        (await this.groupStillMatches(identity));
      if (verified) {
        this.signalGroup(identity, "SIGKILL");
        await this.waitForGroupEmpty(unit, this.killGraceMs);
      } else if (child.exitCode === null && child.signalCode === null) {
        // No verified identity: only the direct child object is safe.
        try {
          child.kill("SIGKILL");
        } catch {
          // Best effort during failed-start cleanup.
        }
      }
    }
    this.releasePipes(unit);
    if (unit.pipeDrainTimer !== undefined) {
      clearTimeout(unit.pipeDrainTimer);
      unit.pipeDrainTimer = undefined;
    }
    const path = this.recordPathFor(unit.handle);
    if (path !== null && unit.identity.pid > 0) {
      await rm(path, { force: true }).catch(() => undefined);
    }
    await this.removeOwnedTempDir(unit, true);
  }

  private async groupStillMatches(
    identity: RuntimeProcessIdentity,
  ): Promise<boolean> {
    try {
      const observed = await this.inspector.capture(identity.pid);
      return (
        observed !== undefined &&
        compareProcessIdentity(identity, observed) === "match"
      );
    } catch {
      return false;
    }
  }

  // -- Inspect / Attach ----------------------------------------------------

  async inspect(
    handle: RuntimeHandle,
    context: ExecutionContext = {},
  ): Promise<ExecutionStatus> {
    this.enter("inspect", context);
    const unit = await this.resolve(handle, "inspect");
    await this.refresh(unit);
    this.enter("inspect", context);
    return this.statusOf(unit);
  }

  async attach(
    handle: RuntimeHandle,
    context: ExecutionContext = {},
  ): Promise<AttachExecutionResult> {
    this.enter("attach", context);
    const unit = await this.resolve(handle, "attach");
    await this.refresh(unit);
    this.enter("attach", context);
    return {
      handle: copyHandle(unit.handle),
      status: this.statusOf(unit),
    };
  }

  private async refresh(unit: ProcessGroupUnit): Promise<void> {
    if (unit.destroyed) return;
    if (unit.settling !== undefined) {
      await unit.settling;
    }
    if (isTerminalExecutionState(unit.observedState)) return;

    let observed: RuntimeProcessIdentity | undefined;
    let members: ProcessGroupMember[] | undefined;
    let inspectionError: string | undefined;
    try {
      observed = await this.inspector.capture(unit.identity.pid);
    } catch (error) {
      inspectionError = errorMessage(error);
    }
    if (inspectionError === undefined) {
      try {
        members = await this.inspector.listGroupMembers(unit.identity.pgid);
      } catch (error) {
        inspectionError = errorMessage(error);
      }
    }

    if (inspectionError !== undefined || members === undefined) {
      unit.observedState = "unknown";
      unit.observedAt = this.timestamp();
      unit.detail = boundedMessage(
        `cannot verify unit identity: ${inspectionError ?? "no table"}`,
      );
      await this.queuePersist(unit);
      return;
    }

    if (observed === undefined) {
      if (unit.child !== undefined && !unit.exited) {
        await this.waitForChildExit(unit, EXIT_RACE_WAIT_MS);
        if (unit.settling !== undefined) await unit.settling;
        if (isTerminalExecutionState(unit.observedState)) return;
        if (unit.exited) await this.refresh(unit);
        return;
      }
      unit.observedAt = this.timestamp();
      if (members.length > 0) {
        unit.observedState = "lost";
        unit.detail = boundedMessage(
          "leader is gone but processes in its group remain; refusing to " +
            "attribute or signal them",
        );
      } else if (unit.exited && unit.exit !== undefined) {
        unit.observedState =
          unit.lastSignal !== undefined ? "stopped" : "exited";
        unit.detail = undefined;
      } else {
        unit.observedState = "lost";
        unit.detail = boundedMessage(
          "unit vanished without exit evidence; no signal will be sent",
        );
      }
      await this.queuePersist(unit);
      return;
    }

    const comparison = compareProcessIdentity(unit.identity, observed);
    if (comparison === "mismatch") {
      unit.observedState = "lost";
      unit.observedAt = this.timestamp();
      unit.detail = boundedMessage(
        "leader pid was reused by an unrelated process; the original unit " +
          "is unverifiable and will not be signalled",
      );
      await this.queuePersist(unit);
      return;
    }
    if (comparison !== "match") {
      unit.observedState = "unknown";
      unit.observedAt = this.timestamp();
      unit.detail = boundedMessage("leader identity cannot be verified");
      await this.queuePersist(unit);
      return;
    }

    // The leader identity matches. A concurrent exit event would already have
    // marked the unit, so this is a live unit.
    unit.observedState = "running";
    unit.observedAt = this.timestamp();
    if (members.length === 0) {
      unit.detail = boundedMessage(
        "the leader is alive but one process-table snapshot did not show it " +
          "in its own group; the next Stop will fail closed",
      );
    } else {
      unit.detail = undefined;
    }
    await this.queuePersist(unit);
  }

  // -- Stop ----------------------------------------------------------------

  async stop(
    handle: RuntimeHandle,
    request: StopExecutionRequest,
    context: ExecutionContext = {},
  ): Promise<ExecutionStatus> {
    this.enter("stop", context);
    const problem = validateStopExecutionRequest(request);
    if (problem !== undefined) {
      throw new ExecutionError("invalid-request", "stop", problem);
    }
    const unit = await this.resolve(handle, "stop");
    if (unit.settling !== undefined) await unit.settling;
    if (isTerminalExecutionState(unit.observedState)) {
      return this.statusOf(unit);
    }

    const graceMs = request.graceMs ?? this.termGraceMs;
    const verification = await this.verifyGroup(unit);
    throwIfExecutionAborted(context, "stop");

    if (verification.kind === "ambiguous") {
      unit.desiredState = "stopped";
      unit.stopReason = request.reason;
      unit.observedState = "lost";
      unit.observedAt = this.timestamp();
      unit.detail = verification.detail;
      await this.queuePersist(unit);
      throw new ExecutionError("ambiguous", "stop", verification.detail);
    }

    if (verification.kind === "gone") {
      unit.desiredState = "stopped";
      unit.stopReason = request.reason;
      unit.observedAt = this.timestamp();
      if (unit.child !== undefined) {
        await this.waitForChildExit(unit, EXIT_RACE_WAIT_MS);
        if (unit.settling !== undefined) await unit.settling;
      }
      if (!isTerminalExecutionState(unit.observedState)) {
        unit.observedState = "lost";
        unit.detail = verification.detail;
      }
      await this.queuePersist(unit);
      return this.statusOf(unit);
    }

    const term = this.signalGroup(unit.identity, "SIGTERM");
    if (term === "denied") {
      throw new ExecutionError(
        "backend-failure",
        "stop",
        "the OS denied SIGTERM to the process group; no further signal was " +
          "sent",
      );
    }
    if (term === "gone") {
      await this.waitForChildExit(unit, EXIT_RACE_WAIT_MS);
      if (unit.settling !== undefined) await unit.settling;
      if (!isTerminalExecutionState(unit.observedState)) {
        unit.observedState = "lost";
        unit.observedAt = this.timestamp();
        unit.detail = boundedMessage(
          "process group vanished between verification and SIGTERM",
        );
      }
      await this.queuePersist(unit);
      return this.statusOf(unit);
    }

    unit.desiredState = "stopped";
    unit.stopReason = request.reason;
    unit.lastSignal = "SIGTERM";
    unit.observedAt = this.timestamp();
    await this.queuePersist(unit);

    const afterTerm = await this.waitForGroupEmpty(unit, graceMs);
    if (afterTerm.kind === "empty") {
      await this.finalizeStopped(unit, "SIGTERM");
      return this.statusOf(unit);
    }
    if (afterTerm.kind === "identity-lost" || afterTerm.kind === "error") {
      unit.observedState = "lost";
      unit.observedAt = this.timestamp();
      unit.detail = boundedMessage(
        afterTerm.kind === "identity-lost"
          ? `stopped after SIGTERM without exact leader authority: ${
              afterTerm.detail
            }`
          : `cannot verify the group after SIGTERM: ${afterTerm.detail}`,
      );
      await this.queuePersist(unit);
      throw new ExecutionError("ambiguous", "stop", unit.detail);
    }

    const killVerification = await this.verifyGroup(unit);
    throwIfExecutionAborted(context, "stop");
    if (killVerification.kind !== "verified") {
      unit.observedState = "lost";
      unit.observedAt = this.timestamp();
      unit.detail = boundedMessage(
        "refusing SIGKILL because the exact leader identity is no longer " +
          "verifiable",
      );
      await this.queuePersist(unit);
      throw new ExecutionError("ambiguous", "stop", unit.detail);
    }

    const kill = this.signalGroup(unit.identity, "SIGKILL");
    if (kill === "denied") {
      throw new ExecutionError(
        "backend-failure",
        "stop",
        "the OS denied SIGKILL to the process group; no further signal was " +
          "sent",
      );
    }
    unit.lastSignal = "SIGKILL";
    unit.observedAt = this.timestamp();

    const afterKill = await this.waitForGroupEmpty(unit, this.killGraceMs);
    if (afterKill.kind === "empty") {
      await this.finalizeStopped(unit, "SIGKILL");
      return this.statusOf(unit);
    }

    unit.observedState = "lost";
    unit.observedAt = this.timestamp();
    unit.detail = boundedMessage(
      afterKill.kind === "identity-lost"
        ? "leader identity vanished before the group emptied; refusing " +
            "further signals"
        : `process group still has ${
            afterKill.kind === "timeout" ? afterKill.members : "unknown"
          } member(s) after SIGKILL`,
    );
    await this.queuePersist(unit);
    throw new ExecutionError("ambiguous", "stop", unit.detail);
  }

  private async finalizeStopped(
    unit: ProcessGroupUnit,
    signal: "SIGTERM" | "SIGKILL",
  ): Promise<void> {
    if (unit.child !== undefined) {
      await this.waitForChildExit(unit, EXIT_RACE_WAIT_MS);
    }
    if (unit.settling !== undefined) await unit.settling;
    unit.desiredState = "stopped";
    unit.observedState = "stopped";
    unit.observedAt = this.timestamp();
    if (unit.exit === undefined) {
      unit.exit = {
        exitCode: null,
        signal,
        exitedAt: unit.observedAt,
      };
      unit.detail = boundedMessage(
        signal === "SIGKILL"
          ? "controller escalated to SIGKILL after the grace period; exit " +
              "cause was not reported to this controller"
          : "controller sent SIGTERM; exit cause was not reported to this " +
              "controller",
      );
    }
    await this.queuePersist(unit);
    this.armPipeDrain(unit);
  }

  private async waitForChildExit(
    unit: ProcessGroupUnit,
    timeoutMs: number,
  ): Promise<void> {
    const child = unit.child;
    if (child === undefined || unit.exited) return;
    if (child.exitCode !== null || child.signalCode !== null) return;
    await new Promise<void>((resolveWait) => {
      let settled = false;
      const done = (): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        child.off("exit", done);
        resolveWait();
      };
      const timer = setTimeout(done, timeoutMs);
      timer.unref();
      child.once("exit", done);
    });
  }

  private async verifyGroup(unit: ProcessGroupUnit): Promise<GroupVerification> {
    const identity = unit.identity;
    if (
      !isProcessIdentity(identity) ||
      identity.pid !== identity.pgid ||
      identity.pgid <= 1
    ) {
      return {
        kind: "ambiguous",
        detail:
          "unit does not carry an exact dedicated-group leader identity",
      };
    }
    if (identity.pgid === process.pid) {
      return {
        kind: "ambiguous",
        detail: "refusing to signal the controller's own process group",
      };
    }
    const ownGroup = await this.ownGroupId();
    if (ownGroup === undefined || ownGroup === identity.pgid) {
      return {
        kind: "ambiguous",
        detail:
          "cannot prove the unit group differs from the controller's group",
      };
    }

    let observed: RuntimeProcessIdentity | undefined;
    let members: ProcessGroupMember[];
    try {
      observed = await this.inspector.capture(identity.pid);
      members = await this.inspector.listGroupMembers(identity.pgid);
    } catch (error) {
      return {
        kind: "ambiguous",
        detail: boundedMessage(
          `cannot verify the leader identity before signalling: ${
            errorMessage(error)
          }`,
        ),
      };
    }

    if (observed === undefined) {
      return members.length === 0
        ? {
            kind: "gone",
            detail:
              "the leader is already gone and its process group is empty",
          }
        : {
            kind: "ambiguous",
            detail:
              "leader is gone but its process group still has members; " +
              "refusing to signal descendants without the exact leader",
          };
    }
    if (compareProcessIdentity(identity, observed) !== "match") {
      return {
        kind: "ambiguous",
        detail:
          "leader pid was reused by an unrelated process; refusing to signal",
      };
    }
    if (members.length === 0) {
      return {
        kind: "ambiguous",
        detail:
          "process table does not show the live leader in its own group; " +
          "refusing to signal an unverified group",
      };
    }
    if (members.some((member) => member.pgid !== identity.pgid)) {
      return {
        kind: "ambiguous",
        detail: "group membership is inconsistent; refusing to signal",
      };
    }
    if (members.some((member) => member.pid === process.pid)) {
      return {
        kind: "ambiguous",
        detail: "group contains the controller; refusing to signal",
      };
    }
    const leader = members.find((member) => member.pid === identity.pid);
    if (
      leader === undefined ||
      compareProcessIdentity(identity, leader) !== "match"
    ) {
      return {
        kind: "ambiguous",
        detail:
          "leader identity is not present in its own group; refusing to " +
          "signal",
      };
    }
    return { kind: "verified", members };
  }

  private async waitForGroupEmpty(
    unit: ProcessGroupUnit,
    timeoutMs: number,
  ): Promise<GroupEmptyResult> {
    const deadline = Date.now() + Math.max(0, timeoutMs);
    for (;;) {
      let members: ProcessGroupMember[];
      try {
        members = await this.inspector.listGroupMembers(unit.identity.pgid);
      } catch (error) {
        return {
          kind: "error",
          detail: boundedMessage(errorMessage(error)),
        };
      }
      if (members.length === 0) return { kind: "empty" };
      const leader = members.find(
        (member) => member.pid === unit.identity.pid,
      );
      if (leader === undefined) {
        return {
          kind: "identity-lost",
          detail: "the leader left its group while other members remain",
        };
      }
      if (compareProcessIdentity(unit.identity, leader) !== "match") {
        return {
          kind: "identity-lost",
          detail: "the leader identity changed while the group was draining",
        };
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        return { kind: "timeout", members: members.length };
      }
      await sleep(Math.min(this.pollMs, remaining));
    }
  }

  private signalGroup(
    identity: RuntimeProcessIdentity,
    signal: NodeJS.Signals,
  ): "sent" | "gone" | "denied" {
    if (
      !isProcessIdentity(identity) ||
      identity.pid !== identity.pgid ||
      identity.pgid <= 1
    ) {
      return "denied";
    }
    try {
      process.kill(-identity.pgid, signal);
      return "sent";
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ESRCH") return "gone";
      if (code === "EPERM") return "denied";
      throw new ExecutionError(
        "backend-failure",
        "stop",
        `cannot send ${signal} to the verified process group: ${
          boundedMessage(errorMessage(error))
        }`,
        { cause: error },
      );
    }
  }

  private ownGroupId(): Promise<number | undefined> {
    if (this.ownGroupPromise === undefined) {
      this.ownGroupPromise = (async () => {
        for (
          let attempt = 0;
          attempt < MAX_OWN_GROUP_CAPTURE_ATTEMPTS;
          attempt += 1
        ) {
          try {
            const identity = await this.inspector.capture(process.pid);
            if (identity !== undefined) return identity.pgid;
          } catch {
            // Retry briefly; never guess the controller's own group.
          }
          await sleep(IDENTITY_CAPTURE_INTERVAL_MS);
        }
        return undefined;
      })();
    }
    return this.ownGroupPromise;
  }

  // -- Collect / Destroy ---------------------------------------------------

  async collect(
    handle: RuntimeHandle,
    context: ExecutionContext = {},
  ): Promise<ExecutionResult> {
    this.enter("collect", context);
    const unit = await this.resolve(handle, "collect");
    await this.refresh(unit);
    this.enter("collect", context);
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
      handle: copyHandle(unit.handle),
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
    this.enter("destroy", context);
    const unit = await this.resolve(handle, "destroy");
    await this.refresh(unit);
    if (!isTerminalExecutionState(unit.observedState)) {
      throw new ExecutionError(
        "conflict",
        "destroy",
        `execution unit ${unit.handle.handle} is ${unit.observedState}; ` +
          "stop it and collect exit evidence before destroy",
      );
    }
    throwIfExecutionAborted(context, "destroy");

    await this.queuePersist(unit);
    await this.flushUnit(unit);
    throwIfExecutionAborted(context, "destroy");

    const released: string[] = [];
    if (unit.pipeDrainTimer !== undefined) {
      clearTimeout(unit.pipeDrainTimer);
      unit.pipeDrainTimer = undefined;
    }
    released.push(...this.releasePipes(unit));

    const tempRelease = await this.releaseTempDir(unit);
    if (tempRelease !== undefined) released.push(tempRelease);

    const path = this.recordPathFor(unit.handle);
    if (path !== null) {
      const exists = await fileExists(path);
      if (exists) {
        try {
          await rm(path, { force: true });
          released.push("durable-record");
        } catch (error) {
          throw new ExecutionError(
            "backend-failure",
            "destroy",
            `cannot remove the durable unit record: ${
              boundedMessage(errorMessage(error))
            }`,
            { cause: error },
          );
        }
      }
    }

    unit.destroyed = true;
    this.units.delete(runtimeHandleKey(unit.handle));
    return {
      handle: copyHandle(unit.handle),
      released,
      destroyedAt: this.timestamp(),
    };
  }

  private async releaseTempDir(
    unit: ProcessGroupUnit,
  ): Promise<string | undefined> {
    const tempDir = unit.tempDir;
    if (tempDir === null) return undefined;
    const ownership = await this.tempDirOwnership(unit);
    if (ownership === "missing") return undefined;
    if (ownership !== "verified") {
      throw new ExecutionError(
        "conflict",
        "destroy",
        "temp directory ownership cannot be verified; refusing to delete it",
      );
    }
    try {
      await rm(tempDir, { recursive: true, force: false });
      return "temp-dir";
    } catch (error) {
      throw new ExecutionError(
        "backend-failure",
        "destroy",
        `cannot remove the unit temp directory: ${
          boundedMessage(errorMessage(error))
        }`,
        { cause: error },
      );
    }
  }

  private async removeOwnedTempDir(
    unit: ProcessGroupUnit,
    createdByThisCall: boolean,
  ): Promise<void> {
    if (unit.tempDir === null) return;
    if (createdByThisCall) {
      // The directory was created by this call; there is no other owner.
      await rm(unit.tempDir, { recursive: true, force: true }).catch(
        () => undefined,
      );
      return;
    }
    if ((await this.tempDirOwnership(unit)) !== "verified") return;
    await rm(unit.tempDir, { recursive: true, force: true }).catch(
      () => undefined,
    );
  }

  private async tempDirOwnership(
    unit: ProcessGroupUnit,
  ): Promise<TempDirOwnership> {
    if (unit.tempDir === null) return "no-temp-dir";
    if (!(await pathExists(unit.tempDir))) return "missing";
    if (resolve(dirname(unit.tempDir)) !== resolve(unit.tempRoot)) {
      return "unverified";
    }
    if (!basename(unit.tempDir).startsWith(PROCESS_GROUP_TEMP_PREFIX)) {
      return "unverified";
    }
    try {
      const marker = await readFile(
        join(unit.tempDir, PROCESS_GROUP_RECORD_MARKER),
        "utf8",
      );
      return marker.trim() === runtimeHandleKey(unit.handle)
        ? "verified"
        : "unverified";
    } catch {
      return "unverified";
    }
  }

  // -- Extra observation ---------------------------------------------------

  async output(
    handle: RuntimeHandle,
    context: ExecutionContext = {},
  ): Promise<ProcessGroupOutput> {
    this.enter("collect", context);
    const unit = await this.resolve(handle, "collect");
    return {
      stdout: unit.stdout,
      stderr: unit.stderr,
      outputTruncated: unit.outputTruncated,
    };
  }

  async resources(
    handle: RuntimeHandle,
    context: ExecutionContext = {},
  ): Promise<ProcessGroupResourceSnapshot> {
    this.enter("inspect", context);
    const unit = await this.resolve(handle, "inspect");
    const path = this.recordPathFor(unit.handle);

    let observed: RuntimeProcessIdentity | undefined;
    let members: ProcessGroupMember[] | undefined;
    let inspectionFailed = false;
    try {
      observed = await this.inspector.capture(unit.identity.pid);
      members = await this.inspector.listGroupMembers(unit.identity.pgid);
    } catch {
      inspectionFailed = true;
      observed = undefined;
      members = undefined;
    }

    let groupIdentity: ProcessGroupResourceSnapshot["groupIdentity"];
    if (inspectionFailed) {
      // An inspection failure is unknown, never proof that the unit is gone.
      groupIdentity = "unknown";
    } else if (observed === undefined) {
      groupIdentity = "absent";
    } else {
      groupIdentity = compareProcessIdentity(unit.identity, observed);
    }

    return {
      handle: copyHandle(unit.handle),
      recordPath: path,
      recordExists: path !== null ? await fileExists(path) : false,
      tempDir: unit.tempDir,
      tempDirExists:
        unit.tempDir !== null ? await pathExists(unit.tempDir) : false,
      tempDirOwnership: await this.tempDirOwnership(unit),
      stdoutPipeOpen: unit.stdoutOpen,
      stderrPipeOpen: unit.stderrOpen,
      childExited:
        unit.child === undefined
          ? null
          : unit.exited ||
            unit.child.exitCode !== null ||
            unit.child.signalCode !== null,
      groupMembers: members === undefined ? null : members.length,
      groupIdentity,
      pty: null,
    };
  }

  recordPathFor(handle: RuntimeHandle): string | null {
    if (this.stateDir === undefined) return null;
    return processGroupRecordPath(this.stateDir, handle) ?? null;
  }

  async flush(): Promise<void> {
    const pending: Promise<void>[] = [];
    for (const unit of this.units.values()) {
      // Snapshot the current in-memory state; awaiting only previously queued
      // writes would miss output that arrived since the last transition.
      pending.push(this.queuePersist(unit));
    }
    await Promise.all(pending);
    for (const unit of this.units.values()) {
      if (unit.persistenceError !== undefined) {
        throw new ExecutionError(
          "backend-failure",
          "inspect",
          `cannot persist execution unit state: ${
            boundedMessage(unit.persistenceError.message)
          }`,
          { cause: unit.persistenceError },
        );
      }
    }
  }

  private async flushUnit(unit: ProcessGroupUnit): Promise<void> {
    await unit.writeChain;
    if (unit.persistenceError !== undefined) {
      throw new ExecutionError(
        "backend-failure",
        "inspect",
        `cannot persist execution unit state: ${
          boundedMessage(unit.persistenceError.message)
        }`,
        { cause: unit.persistenceError },
      );
    }
  }

  // -- Durable state -------------------------------------------------------

  private async assertAttemptNotRecorded(attemptId: string): Promise<void> {
    for (const unit of this.units.values()) {
      if (unit.attemptId === attemptId) {
        throw alreadyExists(attemptId);
      }
    }
    if (this.stateDir === undefined) return;
    const dir = join(this.stateDir, PROCESS_GROUP_UNITS_DIR);
    let names: string[];
    try {
      names = await readdir(dir);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") return;
      throw new ExecutionError(
        "backend-failure",
        "start",
        `cannot scan durable execution records: ${
          boundedMessage(errorMessage(error))
        }`,
        { cause: error },
      );
    }
    if (names.length > MAX_UNIT_RECORDS_SCANNED) {
      throw new ExecutionError(
        "conflict",
        "start",
        `durable state has more than ${MAX_UNIT_RECORDS_SCANNED} records; ` +
          "refusing to start a possible rerun",
      );
    }
    for (const name of names.sort()) {
      if (!name.endsWith(".json")) continue;
      let raw: string;
      try {
        raw = await readFile(join(dir, name), "utf8");
      } catch (error) {
        throw new ExecutionError(
          "backend-failure",
          "start",
          `cannot read durable execution record ${name}: ${
            boundedMessage(errorMessage(error))
          }`,
          { cause: error },
        );
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch (error) {
        throw new ExecutionError(
          "ambiguous",
          "start",
          `durable execution record ${name} is malformed; refusing to start ` +
            "a possible rerun",
          { cause: error },
        );
      }
      const record = decodeProcessGroupRecord(parsed);
      if (record === undefined) {
        throw new ExecutionError(
          "ambiguous",
          "start",
          `durable execution record ${name} is not usable authority; ` +
            "refusing to start a possible rerun",
        );
      }
      if (record.attemptId === attemptId) {
        throw alreadyExists(attemptId);
      }
    }
  }

  private async resolve(
    handle: RuntimeHandle,
    operation: ExecutionOperation,
  ): Promise<ProcessGroupUnit> {
    const parsed = parseRuntimeHandle(handle);
    if (parsed === undefined || parsed.backendType !== PROCESS_GROUP_BACKEND_TYPE) {
      throw new ExecutionError(
        "invalid-handle",
        operation,
        "runtime handle is malformed or belongs to another backend",
      );
    }
    const identity = processGroupIdentityFromRuntimeHandle(parsed);
    if (identity === undefined) {
      throw new ExecutionError(
        "invalid-handle",
        operation,
        "runtime handle is not canonical process-group authority",
      );
    }
    const key = runtimeHandleKey(parsed);
    const cached = this.units.get(key);
    if (cached !== undefined) return cached;

    const path = this.recordPathFor(parsed);
    if (path === null) {
      throw new ExecutionError(
        "not-found",
        operation,
        `no durable execution state is configured for handle ${parsed.handle}`,
      );
    }
    let raw: string;
    try {
      raw = await readFile(path, "utf8");
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        throw new ExecutionError(
          "not-found",
          operation,
          `backend ${PROCESS_GROUP_BACKEND_TYPE} has no record of handle ` +
            parsed.handle,
        );
      }
      throw new ExecutionError(
        "backend-failure",
        operation,
        `cannot read durable execution state: ${
          boundedMessage(errorMessage(error))
        }`,
        { cause: error },
      );
    }
    let parsedRecord: unknown;
    try {
      parsedRecord = JSON.parse(raw);
    } catch (error) {
      throw new ExecutionError(
        "ambiguous",
        operation,
        `durable execution record for handle ${parsed.handle} is malformed`,
        { cause: error },
      );
    }
    const record = decodeProcessGroupRecord(parsedRecord);
    if (record === undefined || !sameRuntimeHandle(record.handle, parsed)) {
      throw new ExecutionError(
        "ambiguous",
        operation,
        `durable execution record for handle ${parsed.handle} is not usable ` +
          "authority",
      );
    }

    const unit = unitFromRecord(record, identity);
    this.units.set(key, unit);
    return unit;
  }

  private queuePersist(unit: ProcessGroupUnit): Promise<void> {
    if (this.stateDir === undefined || unit.destroyed) {
      return Promise.resolve();
    }
    const path = this.recordPathFor(unit.handle);
    if (path === null) return Promise.resolve();
    const record = this.serialize(unit);
    unit.writeChain = unit.writeChain
      .then(async () => {
        if (unit.destroyed) return;
        await this.writeRecord(path, record);
      })
      .catch((error: unknown) => {
        if (unit.persistenceError === undefined) {
          unit.persistenceError =
            error instanceof Error ? error : new Error(String(error));
        }
      });
    return unit.writeChain;
  }

  private async writeRecord(
    path: string,
    record: ProcessGroupConformanceRecord,
  ): Promise<void> {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    this.writeCounter += 1;
    const temporary = `${path}.${process.pid}.${this.writeCounter}.tmp`;
    const payload = `${JSON.stringify(record, null, 2)}\n`;
    try {
      await writeFile(temporary, payload, { mode: 0o600 });
      await rename(temporary, path);
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  private serialize(unit: ProcessGroupUnit): ProcessGroupConformanceRecord {
    return {
      version: PROCESS_GROUP_RECORD_VERSION,
      handle: copyHandle(unit.handle),
      attemptId: unit.attemptId,
      workspaceId: unit.workspaceId,
      command: [...unit.command],
      ...(unit.cwd !== undefined ? { cwd: unit.cwd } : {}),
      desiredState: unit.desiredState,
      observedState: unit.observedState,
      leaseDeadline: unit.leaseDeadline,
      startedAt: unit.startedAt,
      observedAt: unit.observedAt,
      ...(unit.stopReason !== undefined
        ? { stopReason: unit.stopReason }
        : {}),
      ...(unit.exit !== undefined ? { exit: { ...unit.exit } } : {}),
      stdout: unit.stdout,
      stderr: unit.stderr,
      outputTruncated: unit.outputTruncated,
      tempDir: unit.tempDir,
      tempRoot: unit.tempRoot,
      ...(unit.lastSignal !== undefined
        ? { lastSignal: unit.lastSignal }
        : {}),
      ...(unit.detail !== undefined ? { detail: unit.detail } : {}),
    };
  }

  // -- Shared helpers ------------------------------------------------------

  private statusOf(unit: ProcessGroupUnit): ExecutionStatus {
    return {
      handle: copyHandle(unit.handle),
      desiredState: unit.desiredState,
      observedState: unit.observedState,
      observedAt: unit.observedAt,
      leaseDeadline: unit.leaseDeadline,
      ...(isTerminalExecutionState(unit.observedState) &&
      unit.exit !== undefined
        ? { exit: { ...unit.exit } }
        : {}),
      ...(unit.detail !== undefined ? { detail: unit.detail } : {}),
    };
  }

  private unsupportedLimit(
    limits: StartExecutionRequest["limits"],
  ): string | undefined {
    if (limits === undefined) return undefined;
    for (const key of [
      "cpuSeconds",
      "memoryBytes",
      "processCount",
      "openFiles",
    ] as const) {
      if (limits[key] !== undefined) return key;
    }
    return undefined;
  }

  private enter(operation: ExecutionOperation, context: ExecutionContext): void {
    throwIfExecutionAborted(context, operation);
  }

  private timestamp(): string {
    return this.now().toISOString();
  }
}

// ---------------------------------------------------------------------------
// Record -> unit
// ---------------------------------------------------------------------------

function unitFromRecord(
  record: ProcessGroupConformanceRecord,
  identity: RuntimeProcessIdentity,
): ProcessGroupUnit {
  return {
    handle: copyHandle(record.handle),
    identity,
    attemptId: record.attemptId,
    workspaceId: record.workspaceId,
    command: [...record.command],
    ...(record.cwd !== undefined ? { cwd: record.cwd } : {}),
    desiredState: record.desiredState,
    observedState: record.observedState,
    leaseDeadline: record.leaseDeadline,
    startedAt: record.startedAt,
    observedAt: record.observedAt,
    ...(record.stopReason !== undefined
      ? { stopReason: record.stopReason }
      : {}),
    ...(record.exit !== undefined ? { exit: { ...record.exit } } : {}),
    stdout: record.stdout,
    stderr: record.stderr,
    outputTruncated: record.outputTruncated,
    tempDir: record.tempDir,
    tempRoot: record.tempRoot,
    ...(record.lastSignal !== undefined
      ? { lastSignal: record.lastSignal }
      : {}),
    ...(record.detail !== undefined ? { detail: record.detail } : {}),
    exited: false,
    stdoutOpen: false,
    stderrOpen: false,
    writeChain: Promise.resolve(),
    destroyed: false,
  };
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

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

function copyHandle(handle: RuntimeHandle): RuntimeHandle {
  return {
    backendType: handle.backendType,
    handle: handle.handle,
    ...(handle.diagnostics !== undefined
      ? { diagnostics: { ...handle.diagnostics } }
      : {}),
  };
}

function alreadyExists(attemptId: string): ExecutionError {
  return new ExecutionError(
    "already-exists",
    "start",
    `attempt ${attemptId} already has a runtime record; a rerun requires a ` +
      "new attemptId",
  );
}

function boundedInteger(
  value: number | undefined,
  fallback: number,
  max: number,
  name: string,
  min = 1,
): number {
  if (value === undefined) return fallback;
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < min ||
    value > max
  ) {
    throw new TypeError(`${name} must be an integer between ${min} and ${max}`);
  }
  return value;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => {
    const timer = setTimeout(resolveSleep, Math.max(0, ms));
    timer.unref?.();
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function boundedMessage(value: string): string {
  const normalized = value.trim().replace(/\s+/g, " ");
  if (normalized.length === 0) return "no detail";
  return normalized.length > MAX_EXECUTION_DETAIL_LENGTH
    ? normalized.slice(0, MAX_EXECUTION_DETAIL_LENGTH)
    : normalized;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isExecutionStopReason(
  value: unknown,
): value is ExecutionStopReason {
  return (
    typeof value === "string" &&
    (EXECUTION_STOP_REASONS as readonly string[]).includes(value)
  );
}

function isTimestamp(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value === value.trim() &&
    !Number.isNaN(Date.parse(value))
  );
}

function isBoundedDetail(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_EXECUTION_DETAIL_LENGTH &&
    value === value.trim() &&
    !CONTROL_CHARACTERS.test(value)
  );
}

function isBoundedIdentifier(
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

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function fileExists(path: string): Promise<boolean> {
  try {
    const info = await stat(path);
    return info.isFile();
  } catch {
    return false;
  }
}

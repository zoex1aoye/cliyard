/**
 * RuntimeManager v0: single-host lifecycle for finite verification services.
 *
 * One runtime is started from an exact task worktree, gets one leased port per
 * service, redirects every service's stdout/stderr to
 * `<controlRepo>/.cliyard/runtime/<runtimeId>/<service>.log`, waits for HTTP
 * readiness, and owns the persisted RuntimeManifest.
 *
 * Cleanup is part of the API rather than an afterthought:
 *
 *   terminate the full service process group
 *     → confirm the leased port no longer accepts connections
 *     → release the lease
 *     → persist the final manifest
 *
 * `run()` wraps that cleanup in `finally` semantics for callers, and `start()`
 * performs it before surfacing a startup error.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  closeSync,
  fstatSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readSync,
  renameSync,
  statSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { get as httpGet, type ClientRequest } from "node:http";
import { createServer } from "node:net";
import { hostname } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { PortAllocator, probePort } from "./ports.js";
import { ProcessInspector } from "./process.js";
import {
  RUNTIME_HOST,
  RUNTIME_MANIFEST_VERSION,
  type PortLease,
  type RuntimeManifest,
  type RuntimeProcessIdentity,
  type RuntimeReadinessAttempt,
  type RuntimeServiceManifest,
  type RuntimeSpec,
} from "./types.js";

export const RUNTIME_MANIFEST_FILE = "runtime-manifest.json";

const DEFAULT_PORT_ENV = "PORT";
const DEFAULT_READINESS_PATH = "/";
const DEFAULT_READINESS_STATUS = 200;
const DEFAULT_READINESS_TIMEOUT_MS = 30_000;
const DEFAULT_READINESS_POLL_MS = 100;
const DEFAULT_STOP_GRACE_MS = 5_000;
const DEFAULT_PORT_RELEASE_TIMEOUT_MS = 5_000;

/** Exit evidence is read from the tail of the service log. */
const LOG_TAIL_BYTES = 4_096;
const EADDRINUSE_TAIL_BYTES = 8_192;
const PORT_RELEASE_POLL_MS = 50;
const GROUP_EXIT_POLL_MS = 25;

const SAFE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

// ---------------------------------------------------------------------------
// Public shapes
// ---------------------------------------------------------------------------

export interface RuntimePaths {
  /** `<repoRoot>/.cliyard/runtime/<runtimeId>` */
  runtimeDir: string;
  /** `<runtimeDir>/runtime-manifest.json` */
  manifestPath: string;
  /** `<runtimeDir>/data` */
  dataDir: string;
}

export interface RuntimePortAllocator {
  allocate(runId: string, service: string): Promise<PortLease>;
  release(lease: PortLease): Promise<boolean>;
}

export interface RuntimeManagerOptions {
  /** Control repository whose `.cliyard/runtime` receives leaks, logs, manifest. */
  repoRoot: string;
  /** Exact task worktree the services are started from. */
  worktree: string;
  taskId: string;
  /** 1-based acceptance attempt. */
  attempt: number;
  /**
   * Deterministic runtime identity. Defaults to `<taskId>-attempt-<attempt>`;
   * must be safe as a single path segment and as a port-lease id.
   */
  runtimeId?: string;
  /** Code snapshot recorded in the manifest, when known. */
  artifactHash?: string;
  /** Base environment for service processes (default `process.env`). */
  env?: NodeJS.ProcessEnv;
  /** Port allocator (default a `PortAllocator` rooted at `repoRoot`). */
  allocator?: RuntimePortAllocator;
  /** Readiness poll interval (default 100ms). */
  readinessPollMs?: number;
  /** Time a service group gets to exit after SIGTERM (default 5s). */
  stopGraceMs?: number;
  /** Time to wait for a leased port to stop accepting (default 5s). */
  portReleaseTimeoutMs?: number;
}

export interface RuntimeSession {
  readonly runtimeId: string;
  readonly runtimeDir: string;
  readonly manifestPath: string;
  /** Live manifest; it is finalized when `stop()` resolves. */
  readonly manifest: RuntimeManifest;
  /** Service name → base URL. */
  readonly urls: Readonly<Record<string, string>>;
  /**
   * URL variables for verify-command environments:
   * `CLIYARD_<UPPER_SNAKE_SERVICE>_URL` plus each `urlEnv`.
   */
  readonly env: Readonly<Record<string, string>>;
  /** Idempotent cleanup: group → port → lease → manifest. */
  stop(): Promise<RuntimeManifest>;
}

export interface RuntimeRunResult<T> {
  result: T;
  manifest: RuntimeManifest;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class RuntimeManagerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

export class RuntimeSpecError extends RuntimeManagerError {}

export class RuntimeStartError extends RuntimeManagerError {
  constructor(
    message: string,
    readonly manifest: RuntimeManifest,
    readonly failure?: unknown,
  ) {
    super(message);
  }
}

export class RuntimeCleanupError extends RuntimeManagerError {}

// ---------------------------------------------------------------------------
// Paths and ids
// ---------------------------------------------------------------------------

export function runtimePaths(
  repoRoot: string,
  runtimeId: string,
): RuntimePaths {
  assertSafeId(runtimeId, "runtimeId");
  const runtimeDir = join(resolve(repoRoot), ".cliyard", "runtime", runtimeId);
  return {
    runtimeDir,
    manifestPath: join(runtimeDir, RUNTIME_MANIFEST_FILE),
    dataDir: join(runtimeDir, "data"),
  };
}

// ---------------------------------------------------------------------------
// Prepared spec
// ---------------------------------------------------------------------------

interface PreparedService {
  name: string;
  command: string[];
  cwd: string;
  portEnv: string;
  urlEnv?: string;
  /** Always injected into verify environments. */
  urlEnvName: string;
  /** Per-service data directory variable for the service process. */
  dataDirEnv: string;
  readinessPath: string;
  expectedStatus: number;
  readinessTimeoutMs: number;
}

interface ServiceState {
  prepared: PreparedService;
  lease: PortLease;
  manifest: RuntimeServiceManifest;
  child?: ChildProcess;
  exitPromise?: Promise<void>;
  exit?: { code: number | null; signal: NodeJS.Signals | null };
  spawnError?: Error;
  pgid?: number;
  /** One EADDRINUSE retry per service. */
  retried: boolean;
  /** The current attempt failed because the port was already in use. */
  addressInUse: boolean;
  /** Log size before the current attempt, so retry evidence is fresh. */
  logOffset: number;
}

// ---------------------------------------------------------------------------
// RuntimeManager
// ---------------------------------------------------------------------------

export class RuntimeManager {
  readonly repoRoot: string;
  readonly worktree: string;
  readonly taskId: string;
  readonly attempt: number;
  readonly runtimeId: string;
  readonly runtimeDir: string;
  readonly manifestPath: string;
  readonly dataDir: string;

  private readonly artifactHash?: string;
  private readonly baseEnv: NodeJS.ProcessEnv;
  private readonly allocator: RuntimePortAllocator;
  private readonly inspector: ProcessInspector;
  private readonly readinessPollMs: number;
  private readonly stopGraceMs: number;
  private readonly portReleaseTimeoutMs: number;

  private readonly states: ServiceState[] = [];
  private manifest?: RuntimeManifest;
  private stopPromise?: Promise<RuntimeManifest>;
  private used = false;

  constructor(options: RuntimeManagerOptions) {
    if (!options || typeof options !== "object") {
      throw new RuntimeManagerError("RuntimeManager options are required");
    }

    this.repoRoot = resolve(requireString(options.repoRoot, "repoRoot"));
    this.worktree = resolve(requireString(options.worktree, "worktree"));
    this.taskId = requireString(options.taskId, "taskId");

    const attempt = options.attempt;
    if (!Number.isInteger(attempt) || attempt < 1) {
      throw new RuntimeManagerError("attempt must be a positive integer");
    }
    this.attempt = attempt;

    const runtimeId =
      options.runtimeId ?? `${this.taskId}-attempt-${attempt}`;
    this.runtimeId = requireString(runtimeId, "runtimeId");
    assertSafeId(this.runtimeId, "runtimeId");

    if (options.artifactHash !== undefined) {
      this.artifactHash = requireString(options.artifactHash, "artifactHash");
    }

    if (options.env !== undefined) {
      if (!options.env || typeof options.env !== "object") {
        throw new RuntimeManagerError("env must be an object");
      }
      this.baseEnv = { ...options.env };
    } else {
      this.baseEnv = { ...process.env };
    }

    this.readinessPollMs = positiveInteger(
      options.readinessPollMs,
      DEFAULT_READINESS_POLL_MS,
      "readinessPollMs",
    );
    this.stopGraceMs = positiveInteger(
      options.stopGraceMs,
      DEFAULT_STOP_GRACE_MS,
      "stopGraceMs",
    );
    this.portReleaseTimeoutMs = positiveInteger(
      options.portReleaseTimeoutMs,
      DEFAULT_PORT_RELEASE_TIMEOUT_MS,
      "portReleaseTimeoutMs",
    );

    if (options.allocator !== undefined) {
      if (
        typeof options.allocator.allocate !== "function" ||
        typeof options.allocator.release !== "function"
      ) {
        throw new RuntimeManagerError(
          "allocator must implement allocate() and release()",
        );
      }
      this.allocator = options.allocator;
    } else {
      this.allocator = new PortAllocator({
        repoRoot: this.repoRoot,
        env: this.baseEnv,
      });
    }

    this.inspector = new ProcessInspector();

    const paths = runtimePaths(this.repoRoot, this.runtimeId);
    this.runtimeDir = paths.runtimeDir;
    this.manifestPath = paths.manifestPath;
    this.dataDir = paths.dataDir;
  }

  /**
   * Start every service, wait for readiness, persist the manifest, and return a
   * session. On any failure the started process groups and leases are cleaned
   * up before a RuntimeStartError (carrying the final manifest) is thrown.
   */
  async start(spec: RuntimeSpec): Promise<RuntimeSession> {
    if (this.used) {
      throw new RuntimeManagerError(
        `RuntimeManager ${this.runtimeId} is single-use`,
      );
    }
    this.used = true;

    let worktreeInfo;
    try {
      worktreeInfo = statSync(this.worktree);
    } catch {
      throw new RuntimeManagerError(
        `task worktree does not exist: ${this.worktree}`,
      );
    }
    if (!worktreeInfo.isDirectory()) {
      throw new RuntimeManagerError(
        `task worktree is not a directory: ${this.worktree}`,
      );
    }

    const prepared = prepareRuntimeSpec(spec, this.worktree);

    const manifest: RuntimeManifest = {
      version: RUNTIME_MANIFEST_VERSION,
      runtimeId: this.runtimeId,
      taskId: this.taskId,
      attempt: this.attempt,
      ...(this.artifactHash !== undefined
        ? { artifactHash: this.artifactHash }
        : {}),
      worktree: this.worktree,
      // The control process owns this runtime for recovery eligibility. The
      // host is the OS hostname, not the 127.0.0.1 bind host.
      owner: { pid: process.pid, host: hostname() },
      services: [],
      startedAt: new Date().toISOString(),
      cleanup: "pending",
    };
    this.manifest = manifest;

    mkdirSync(this.runtimeDir, { recursive: true });
    mkdirSync(this.dataDir, { recursive: true });

    let failure: unknown;
    try {
      // Reserve every port before the first spawn so services can see each
      // other's URLs from the very first environment.
      for (const service of prepared) {
        const dataDir = join(this.dataDir, service.name);
        const logPath = join(this.runtimeDir, `${service.name}.log`);
        mkdirSync(dataDir, { recursive: true });

        const lease = await this.allocator.allocate(
          this.runtimeId,
          service.name,
        );
        const url = serviceUrl(lease.port);
        const serviceManifest: RuntimeServiceManifest = {
          name: service.name,
          host: RUNTIME_HOST,
          port: lease.port,
          url,
          healthUrl: `${url}${service.readinessPath}`,
          logPath,
          dataDir,
          readinessAttempts: [],
        };
        manifest.services.push(serviceManifest);
        this.states.push({
          prepared: service,
          lease,
          manifest: serviceManifest,
          retried: false,
          addressInUse: false,
          logOffset: 0,
        });
      }

      this.persistManifest();

      for (const state of this.states) {
        await this.startService(state);
        this.persistManifest();
      }
    } catch (error) {
      failure = error;
      manifest.failureReason = errorMessage(error);
    }

    if (failure !== undefined) {
      let cleanupError: unknown;
      try {
        await this.cleanup();
      } catch (error) {
        cleanupError = error;
      }
      const message =
        cleanupError === undefined
          ? errorMessage(failure)
          : `${errorMessage(failure)}\ncleanup failed: ${errorMessage(cleanupError)}`;
      throw new RuntimeStartError(message, manifest, failure);
    }

    this.persistManifest();
    return this.createSession();
  }

  /**
   * Run `fn` against a ready session and always stop the runtime afterwards.
   * A callback failure is preserved; a simultaneous cleanup failure surfaces as
   * an AggregateError.
   */
  async run<T>(
    spec: RuntimeSpec,
    fn: (session: RuntimeSession) => Promise<T> | T,
  ): Promise<RuntimeRunResult<T>> {
    if (typeof fn !== "function") {
      throw new RuntimeManagerError("run requires a callback");
    }

    const session = await this.start(spec);

    let result!: T;
    let callbackError: unknown;
    let callbackFailed = false;
    try {
      result = await fn(session);
    } catch (error) {
      callbackError = error;
      callbackFailed = true;
    }

    let cleanupError: unknown;
    try {
      await session.stop();
    } catch (error) {
      cleanupError = error;
    }

    if (callbackFailed && cleanupError !== undefined) {
      throw new AggregateError(
        [callbackError, cleanupError],
        `runtime ${this.runtimeId} callback and cleanup both failed`,
      );
    }
    if (callbackFailed) throw callbackError;
    if (cleanupError !== undefined) throw cleanupError;
    return { result, manifest: session.manifest };
  }

  // -------------------------------------------------------------------------
  // Startup
  // -------------------------------------------------------------------------

  private async startService(state: ServiceState): Promise<void> {
    try {
      await this.spawnService(state);
      await this.waitForReady(state);
    } catch (error) {
      state.addressInUse = hasAddressInUseEvidence(state);
      const message = serviceFailureMessage(state, errorMessage(error));
      state.manifest.error = message;

      if (!state.retried && state.addressInUse) {
        state.retried = true;
        try {
          await this.prepareRetry(state);
        } catch (retryError) {
          throw new RuntimeManagerError(
            `${message}\nretry failed: ${errorMessage(retryError)}`,
          );
        }
        return this.startService(state);
      }

      throw new RuntimeManagerError(message);
    }
  }

  private async spawnService(state: ServiceState): Promise<void> {
    const manifest = state.manifest;
    const service = state.prepared;

    // Reset per-attempt state. Manifest history such as readinessAttempts is
    // intentionally retained across the one EADDRINUSE retry.
    state.child = undefined;
    state.exit = undefined;
    state.exitPromise = undefined;
    state.spawnError = undefined;
    state.pgid = undefined;
    state.addressInUse = false;
    manifest.pid = undefined;
    manifest.pgid = undefined;
    manifest.processIdentity = undefined;
    manifest.startedAt = undefined;
    manifest.exitedAt = undefined;
    manifest.exitCode = undefined;
    manifest.signal = undefined;
    manifest.error = undefined;

    try {
      state.logOffset = statSync(manifest.logPath).size;
    } catch {
      state.logOffset = 0;
    }

    const fd = openSync(manifest.logPath, "a", 0o600);
    const header =
      `[cliyard] runtime ${this.runtimeId} service ${service.name} ` +
      `start ${new Date().toISOString()}\n` +
      `[cliyard] argv ${JSON.stringify(service.command)}\n` +
      `[cliyard] cwd ${service.cwd}\n`;

    let child: ChildProcess;
    try {
      writeSync(fd, header);
      child = spawn(service.command[0], service.command.slice(1), {
        cwd: service.cwd,
        env: this.serviceEnv(state),
        stdio: ["ignore", fd, fd],
        // A dedicated process group lets cleanup reach helpers the service
        // spawned; the leader's pid is the group id.
        detached: process.platform !== "win32",
        windowsHide: true,
      });
    } finally {
      closeSync(fd);
    }

    state.child = child;
    state.exitPromise = new Promise<void>((resolveExit) => {
      child.once("exit", (code, signal) => {
        state.exit = { code, signal };
        manifest.exitedAt ??= new Date().toISOString();
        manifest.exitCode = code;
        manifest.signal = signal;
        resolveExit();
      });
    });
    // Late child errors (for example a failing signal delivery) must never
    // crash the control process; spawn-time errors are handled below.
    child.on("error", (error) => {
      state.spawnError = error;
    });

    await new Promise<void>((resolveSpawn, rejectSpawn) => {
      const cleanup = (): void => {
        child.off("spawn", onSpawn);
        child.off("error", onError);
      };
      const onSpawn = (): void => {
        cleanup();
        resolveSpawn();
      };
      const onError = (error: Error): void => {
        cleanup();
        rejectSpawn(error);
      };
      child.once("spawn", onSpawn);
      child.once("error", onError);
    });

    if (child.pid === undefined) {
      throw new RuntimeManagerError("child process did not report a pid");
    }
    await this.recordSpawnEvidence(state, child.pid);
  }

  /**
   * Record the evidence orphan recovery needs, immediately after spawn:
   * leader pid, process group, and the exact OS-reported process identity.
   *
   * `manifest.startedAt` stays a wall-clock bookkeeping timestamp. It is never
   * copied into `processIdentity.startedAt`, because only the OS start
   * identity distinguishes a reused pid from the original process.
   */
  private async recordSpawnEvidence(
    state: ServiceState,
    pid: number,
  ): Promise<void> {
    const manifest = state.manifest;

    // POSIX services are spawned detached, so the leader pid is the group id.
    // Keeping both fields equal is what makes group ownership provable later.
    state.pgid = pid;
    manifest.pid = pid;
    manifest.pgid = pid;
    manifest.startedAt = new Date().toISOString();

    if (this.inspector.supported) {
      let identity: RuntimeProcessIdentity | undefined;
      try {
        identity = await this.inspector.capture(pid);
      } catch (error) {
        throw new RuntimeManagerError(
          `service ${JSON.stringify(manifest.name)} identity capture failed: ` +
            errorMessage(error),
        );
      }
      if (identity !== undefined) {
        if (identity.pid !== pid || identity.pgid !== pid) {
          throw new RuntimeManagerError(
            `service ${JSON.stringify(manifest.name)} spawned pid ${pid} but ` +
              `ps reports pid ${identity.pid} in process group ` +
              `${identity.pgid}`,
          );
        }
        manifest.processIdentity = identity;
      }
    }

    // Persist before readiness: a control-process crash during the readiness
    // wait must still leave the reaper usable evidence.
    this.persistManifest();
  }

  /**
   * Wait until the child is alive and its readiness URL returns the expected
   * status before the deadline. Every probe is recorded in the manifest.
   */
  private async waitForReady(state: ServiceState): Promise<void> {
    const manifest = state.manifest;
    const expectedStatus = state.prepared.expectedStatus;
    const timeoutMs = state.prepared.readinessTimeoutMs;
    const deadline = Date.now() + timeoutMs;
    let lastError: string | undefined;

    for (;;) {
      if (state.exit) {
        throw new RuntimeManagerError(
          `exited before readiness (${describeExit(state.exit)})`,
        );
      }

      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        throw new RuntimeManagerError(
          `is not ready within ${timeoutMs}ms at ${manifest.healthUrl}` +
            (lastError ? `: ${lastError}` : ""),
        );
      }

      const attempt = await probeReadiness(
        manifest.healthUrl,
        expectedStatus,
        Math.min(remaining, 2_000),
      );
      manifest.readinessAttempts.push(attempt);

      if (attempt.ok) {
        // Readiness only counts while the child is still alive.
        if (state.exit) {
          throw new RuntimeManagerError(
            `exited immediately after readiness (${describeExit(state.exit)})`,
          );
        }
        return;
      }

      lastError =
        attempt.error ??
        (attempt.status !== undefined
          ? `expected status ${expectedStatus}, received ${attempt.status}`
          : "no response");
      const pause = Math.min(
        this.readinessPollMs,
        Math.max(0, deadline - Date.now()),
      );
      if (pause > 0) await delay(pause);
    }
  }

  /**
   * One EADDRINUSE retry. The failed lease is released and reallocated under
   * the same key while the old port is briefly held by the manager, which
   * guarantees the allocator cannot hand back the same port when it is free
   * again. If the port is still occupied externally the hold simply fails and
   * the allocator skips it on its own.
   */
  private async prepareRetry(state: ServiceState): Promise<void> {
    const previous = state.lease;

    await this.terminateProcessGroup(state);
    await this.allocator.release(previous);

    const lease = await withPortHeld(previous.port, () =>
      this.allocator.allocate(this.runtimeId, state.manifest.name),
    );

    state.lease = lease;
    state.manifest.port = lease.port;
    state.manifest.url = serviceUrl(lease.port);
    state.manifest.healthUrl =
      state.manifest.url + state.prepared.readinessPath;
    // The next spawn starts a fresh attempt; do not persist the failed
    // attempt's pid/group/identity/timestamps against the new port.
    state.manifest.pid = undefined;
    state.manifest.pgid = undefined;
    state.manifest.processIdentity = undefined;
    state.manifest.startedAt = undefined;
    state.manifest.exitedAt = undefined;
    state.manifest.exitCode = undefined;
    state.manifest.signal = undefined;
    state.manifest.error = undefined;
    this.persistManifest();
  }

  // -------------------------------------------------------------------------
  // Environment
  // -------------------------------------------------------------------------

  private serviceEnv(state: ServiceState): NodeJS.ProcessEnv {
    return {
      ...this.baseEnv,
      ...buildUrlEnv(this.states),
      [state.prepared.portEnv]: String(state.manifest.port),
      [state.prepared.dataDirEnv]: state.manifest.dataDir,
    };
  }

  private createSession(): RuntimeSession {
    const urls: Record<string, string> = {};
    for (const state of this.states) {
      urls[state.manifest.name] = state.manifest.url;
    }
    return {
      runtimeId: this.runtimeId,
      runtimeDir: this.runtimeDir,
      manifestPath: this.manifestPath,
      manifest: this.manifest!,
      urls: Object.freeze(urls),
      env: Object.freeze(buildUrlEnv(this.states)),
      stop: () => this.cleanup(),
    };
  }

  // -------------------------------------------------------------------------
  // Cleanup
  // -------------------------------------------------------------------------

  private cleanup(): Promise<RuntimeManifest> {
    if (!this.stopPromise) this.stopPromise = this.finishCleanup();
    return this.stopPromise;
  }

  private async finishCleanup(): Promise<RuntimeManifest> {
    const manifest = this.manifest;
    if (!manifest) {
      throw new RuntimeCleanupError(
        `runtime ${this.runtimeId} has not been started`,
      );
    }

    const errors: string[] = [];
    manifest.cleanup = "running";

    // Reverse start order, mirroring dependency shutdown.
    for (const state of [...this.states].reverse()) {
      try {
        await this.terminateProcessGroup(state);
      } catch (error) {
        errors.push(
          `service ${JSON.stringify(state.manifest.name)} stop: ${errorMessage(error)}`,
        );
      }

      // An EADDRINUSE failure means the port belonged to a foreign listener
      // the whole time; there is nothing of ours left to confirm.
      if (state.pgid !== undefined && !state.addressInUse) {
        try {
          await this.waitForPortRelease(state);
        } catch (error) {
          errors.push(errorMessage(error));
        }
      }

      try {
        await this.allocator.release(state.lease);
      } catch (error) {
        errors.push(
          `service ${JSON.stringify(state.manifest.name)} lease: ${errorMessage(error)}`,
        );
      }
    }

    manifest.stoppedAt = new Date().toISOString();
    if (errors.length > 0) {
      manifest.cleanup = "failed";
      manifest.failureReason = [
        manifest.failureReason,
        `cleanup: ${errors.join("; ")}`,
      ]
        .filter(Boolean)
        .join("; ");
    } else {
      manifest.cleanup = "complete";
    }

    let persistError: unknown;
    try {
      this.persistManifest();
    } catch (error) {
      persistError = error;
      manifest.cleanup = "failed";
    }

    if (errors.length > 0 || persistError !== undefined) {
      const detail = [
        ...errors,
        ...(persistError !== undefined
          ? [`manifest: ${errorMessage(persistError)}`]
          : []),
      ].join("; ");
      throw new RuntimeCleanupError(
        `runtime ${this.runtimeId} cleanup failed: ${detail}`,
      );
    }

    return manifest;
  }

  private async terminateProcessGroup(state: ServiceState): Promise<void> {
    const child = state.child;
    if (!child || state.pgid === undefined) return;
    const pgid = state.pgid;

    if (process.platform === "win32") {
      if (!state.exit) child.kill("SIGTERM");
      if (!(await this.waitForExit(state, this.stopGraceMs))) {
        child.kill("SIGKILL");
        await this.waitForExit(state, this.stopGraceMs);
      }
      this.finalizeExit(state);
      return;
    }

    signalProcessGroup(pgid, "SIGTERM");
    if (!(await this.waitForExit(state, this.stopGraceMs))) {
      signalProcessGroup(pgid, "SIGKILL");
      if (!(await this.waitForExit(state, this.stopGraceMs))) {
        throw new RuntimeManagerError(
          `service ${JSON.stringify(state.manifest.name)} did not exit ` +
            `${this.stopGraceMs}ms after SIGKILL`,
        );
      }
    }

    // Helpers can outlive a leader that exited on its own.
    if (isGroupAlive(pgid)) {
      signalProcessGroup(pgid, "SIGKILL");
      await waitUntil(() => !isGroupAlive(pgid), this.stopGraceMs);
      if (isGroupAlive(pgid)) {
        throw new RuntimeManagerError(
          `process group ${pgid} for service ` +
            `${JSON.stringify(state.manifest.name)} survived SIGKILL`,
        );
      }
    }

    this.finalizeExit(state);
  }

  private finalizeExit(state: ServiceState): void {
    const manifest = state.manifest;
    manifest.exitedAt ??= new Date().toISOString();
    if (manifest.exitCode === undefined) {
      manifest.exitCode = state.exit?.code ?? null;
    }
    if (manifest.signal === undefined) {
      manifest.signal = state.exit?.signal ?? null;
    }
  }

  private async waitForPortRelease(state: ServiceState): Promise<void> {
    const manifest = state.manifest;
    const deadline = Date.now() + this.portReleaseTimeoutMs;
    for (;;) {
      if (await probePort(manifest.port)) return;
      if (Date.now() >= deadline) {
        throw new RuntimeManagerError(
          `port ${manifest.port} for service ` +
            `${JSON.stringify(manifest.name)} still accepts connections ` +
            `${this.portReleaseTimeoutMs}ms after stop`,
        );
      }
      await delay(PORT_RELEASE_POLL_MS);
    }
  }

  private waitForExit(
    state: ServiceState,
    timeoutMs: number,
  ): Promise<boolean> {
    if (state.exit) return Promise.resolve(true);
    if (!state.exitPromise) return Promise.resolve(true);

    return new Promise<boolean>((resolveExit) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        resolveExit(false);
      }, timeoutMs);
      state.exitPromise!.then(() => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolveExit(true);
      });
    });
  }

  private persistManifest(): void {
    if (!this.manifest) {
      throw new RuntimeManagerError(
        `runtime ${this.runtimeId} has no manifest to persist`,
      );
    }
    writeManifest(this.manifestPath, this.manifest);
  }
}

// ---------------------------------------------------------------------------
// Spec validation
// ---------------------------------------------------------------------------

function prepareRuntimeSpec(
  spec: RuntimeSpec,
  worktree: string,
): PreparedService[] {
  if (!isRecord(spec)) {
    throw new RuntimeSpecError("runtime spec must be an object");
  }
  if (!Array.isArray(spec.services) || spec.services.length === 0) {
    throw new RuntimeSpecError(
      "runtime.services must be a non-empty array",
    );
  }

  const root = resolve(worktree);
  const names = new Set<string>();
  const envOwners = new Map<string, string>();
  const prepared: PreparedService[] = [];

  spec.services.forEach((raw, index) => {
    if (!isRecord(raw)) {
      throw new RuntimeSpecError(
        `runtime.services[${index}] must be an object`,
      );
    }

    const name = raw.name;
    if (typeof name !== "string" || !SAFE_ID_PATTERN.test(name)) {
      throw new RuntimeSpecError(
        `runtime.services[${index}].name ${JSON.stringify(name)} is invalid: ` +
          "must match [A-Za-z0-9][A-Za-z0-9._-]* (max 128 chars)",
      );
    }
    if (names.has(name)) {
      throw new RuntimeSpecError(
        `duplicate runtime service name ${JSON.stringify(name)}`,
      );
    }
    names.add(name);

    const command = raw.command;
    if (
      !Array.isArray(command) ||
      command.length === 0 ||
      command.some((part) => typeof part !== "string")
    ) {
      throw new RuntimeSpecError(
        `runtime.services[${index}].command must be a non-empty argv array`,
      );
    }
    const argv = command as string[];
    if (argv[0].trim() === "") {
      throw new RuntimeSpecError(
        `runtime.services[${index}].command[0] must be non-empty`,
      );
    }

    let cwd = root;
    if (raw.cwd !== undefined) {
      if (typeof raw.cwd !== "string" || raw.cwd.trim() === "") {
        throw new RuntimeSpecError(
          `runtime.services[${index}].cwd must be a non-empty string`,
        );
      }
      cwd = isAbsolute(raw.cwd) ? resolve(raw.cwd) : resolve(root, raw.cwd);
      if (!isInside(root, cwd)) {
        throw new RuntimeSpecError(
          `runtime.services[${index}].cwd escapes the task worktree: ` +
            JSON.stringify(raw.cwd),
        );
      }
    }

    const portEnv =
      raw.portEnv === undefined ? DEFAULT_PORT_ENV : raw.portEnv;
    if (typeof portEnv !== "string" || !ENV_NAME_PATTERN.test(portEnv)) {
      throw new RuntimeSpecError(
        `runtime.services[${index}].portEnv ${JSON.stringify(portEnv)} is not ` +
          "a valid environment variable name",
      );
    }

    let urlEnv: string | undefined;
    if (raw.urlEnv !== undefined) {
      if (
        typeof raw.urlEnv !== "string" ||
        !ENV_NAME_PATTERN.test(raw.urlEnv)
      ) {
        throw new RuntimeSpecError(
          `runtime.services[${index}].urlEnv ${JSON.stringify(raw.urlEnv)} is ` +
            "not a valid environment variable name",
        );
      }
      urlEnv = raw.urlEnv;
    }

    const readiness = raw.readiness;
    let readinessPath = DEFAULT_READINESS_PATH;
    let expectedStatus = DEFAULT_READINESS_STATUS;
    let readinessTimeoutMs = DEFAULT_READINESS_TIMEOUT_MS;
    if (readiness !== undefined) {
      if (!isRecord(readiness)) {
        throw new RuntimeSpecError(
          `runtime.services[${index}].readiness must be an object`,
        );
      }
      if (readiness.path !== undefined) {
        readinessPath = validateReadinessPath(
          readiness.path,
          `runtime.services[${index}].readiness.path`,
        );
      }
      if (readiness.expectedStatus !== undefined) {
        const status = readiness.expectedStatus;
        if (
          typeof status !== "number" ||
          !Number.isInteger(status) ||
          status < 100 ||
          status > 599
        ) {
          throw new RuntimeSpecError(
            `runtime.services[${index}].readiness.expectedStatus must be an ` +
              "integer between 100 and 599",
          );
        }
        expectedStatus = status;
      }
      if (readiness.timeoutMs !== undefined) {
        const timeout = readiness.timeoutMs;
        if (
          typeof timeout !== "number" ||
          !Number.isFinite(timeout) ||
          timeout <= 0
        ) {
          throw new RuntimeSpecError(
            `runtime.services[${index}].readiness.timeoutMs must be a ` +
              "positive number",
          );
        }
        readinessTimeoutMs = timeout;
      }
    }

    const suffix = envSuffix(name);
    const urlEnvName = `CLIYARD_${suffix}_URL`;
    const dataDirEnv = `CLIYARD_${suffix}_DATA_DIR`;
    claimEnvName(envOwners, urlEnvName, name);
    if (urlEnv !== undefined) claimEnvName(envOwners, urlEnv, name);

    prepared.push({
      name,
      command: [...argv],
      cwd,
      portEnv,
      ...(urlEnv !== undefined ? { urlEnv } : {}),
      urlEnvName,
      dataDirEnv,
      readinessPath,
      expectedStatus,
      readinessTimeoutMs,
    });
  });

  // URL variables are injected into every service process; a portEnv that
  // reuses one would silently mask that service's URL.
  const urlEnvNames = new Set(envOwners.keys());
  for (const service of prepared) {
    if (urlEnvNames.has(service.portEnv)) {
      throw new RuntimeSpecError(
        `runtime service ${JSON.stringify(service.name)} portEnv ` +
          `${service.portEnv} collides with an injected runtime URL variable`,
      );
    }
  }

  return prepared;
}

function validateReadinessPath(path: unknown, field: string): string {
  if (typeof path !== "string" || path === "") {
    throw new RuntimeSpecError(`${field} must be a non-empty string`);
  }
  if (
    !path.startsWith("/") ||
    path.startsWith("//") ||
    path.includes("\\") ||
    /[\s\x00-\x1f]/.test(path)
  ) {
    throw new RuntimeSpecError(
      `${field} ${JSON.stringify(path)} must be an absolute HTTP path`,
    );
  }
  return path;
}

function claimEnvName(
  owners: Map<string, string>,
  envName: string,
  service: string,
): void {
  const owner = owners.get(envName);
  if (owner !== undefined && owner !== service) {
    throw new RuntimeSpecError(
      `environment variable ${envName} is claimed by both ` +
        `${JSON.stringify(owner)} and ${JSON.stringify(service)}`,
    );
  }
  owners.set(envName, service);
}

// ---------------------------------------------------------------------------
// Readiness probe
// ---------------------------------------------------------------------------

function probeReadiness(
  url: string,
  expectedStatus: number,
  timeoutMs: number,
): Promise<RuntimeReadinessAttempt> {
  const at = new Date().toISOString();
  return new Promise<RuntimeReadinessAttempt>((resolveAttempt) => {
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    let request: ClientRequest | undefined;

    const finish = (status: number | undefined, error?: string): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      const attempt: RuntimeReadinessAttempt = {
        at,
        url,
        ok: status === expectedStatus,
      };
      if (status !== undefined) attempt.status = status;
      if (!attempt.ok) {
        attempt.error =
          error ??
          (status !== undefined
            ? `expected status ${expectedStatus}, received ${status}`
            : "no response");
      }
      resolveAttempt(attempt);
    };

    try {
      request = httpGet(
        url,
        { agent: false, headers: { connection: "close" } },
        (response) => {
          response.resume();
          const status = response.statusCode;
          finish(
            status,
            status === expectedStatus
              ? undefined
              : `expected status ${expectedStatus}, received ${status ?? "none"}`,
          );
        },
      );
    } catch (error) {
      finish(undefined, errorMessage(error));
      return;
    }

    request.on("error", (error) => finish(undefined, errorMessage(error)));
    timer = setTimeout(() => {
      request?.destroy(
        new Error(`readiness request timed out after ${timeoutMs}ms`),
      );
    }, Math.max(1, timeoutMs));
  });
}

// ---------------------------------------------------------------------------
// Manifest persistence
// ---------------------------------------------------------------------------

function writeManifest(path: string, manifest: RuntimeManifest): void {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true });
  const tmp = join(
    dir,
    `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`,
  );
  try {
    const fd = openSync(tmp, "wx", 0o600);
    try {
      writeSync(fd, JSON.stringify(manifest, null, 2) + "\n");
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, path);
  } catch (error) {
    try {
      unlinkSync(tmp);
    } catch {
      /* best-effort cleanup */
    }
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Process and file helpers
// ---------------------------------------------------------------------------

function signalProcessGroup(pgid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pgid, signal);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return;
    throw new RuntimeManagerError(
      `cannot send ${signal} to process group ${pgid}: ${errorMessage(error)}`,
    );
  }
}

function isGroupAlive(pgid: number): boolean {
  if (process.platform === "win32") return false;
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function waitUntil(
  predicate: () => boolean,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) return;
    await delay(GROUP_EXIT_POLL_MS);
  }
}

/**
 * Bind the port for the duration of `fn` so a probe-then-reserve allocator
 * cannot lease it again. If the bind fails the port is occupied anyway, which
 * achieves the same result.
 */
async function withPortHeld<T>(
  port: number,
  fn: () => Promise<T>,
): Promise<T> {
  const holder = createServer((socket) => socket.destroy());
  await new Promise<void>((resolveHeld) => {
    holder.once("error", () => resolveHeld());
    holder.listen({ host: RUNTIME_HOST, port, exclusive: true }, () =>
      resolveHeld(),
    );
  });

  try {
    return await fn();
  } finally {
    await new Promise<void>((resolveClose) => {
      try {
        holder.close(() => resolveClose());
      } catch {
        resolveClose();
      }
    });
  }
}

function readLogTail(
  path: string,
  from = 0,
  maxBytes = LOG_TAIL_BYTES,
): string {
  let fd: number | undefined;
  try {
    fd = openSync(path, "r");
    const size = fstatSync(fd).size;
    const start = Math.max(from, size - maxBytes);
    if (start >= size) return "";
    const length = size - start;
    const buffer = Buffer.alloc(length);
    readSync(fd, buffer, 0, length, start);
    return buffer.toString("utf8");
  } catch {
    return "";
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        /* already closed */
      }
    }
  }
}

function hasAddressInUseEvidence(state: ServiceState): boolean {
  const code = (state.spawnError as NodeJS.ErrnoException | undefined)?.code;
  if (code === "EADDRINUSE") return true;
  // The design retries when the child exits because of EADDRINUSE; a live
  // service that merely logs the string is not evidence of a lost bind race.
  if (!state.exit) return false;
  return /EADDRINUSE/.test(
    readLogTail(state.manifest.logPath, state.logOffset, EADDRINUSE_TAIL_BYTES),
  );
}

function serviceFailureMessage(state: ServiceState, reason: string): string {
  const tail = readLogTail(state.manifest.logPath).trim();
  const base = `service ${JSON.stringify(state.manifest.name)} ${reason}`;
  return tail
    ? `${base}\n--- ${state.manifest.logPath} ---\n${tail}`
    : base;
}

function describeExit(exit: {
  code: number | null;
  signal: NodeJS.Signals | null;
}): string {
  const parts: string[] = [];
  if (exit.code !== null) parts.push(`exit code ${exit.code}`);
  if (exit.signal !== null) parts.push(`signal ${exit.signal}`);
  return parts.length > 0 ? parts.join(", ") : "unknown exit";
}

function buildUrlEnv(
  states: readonly ServiceState[],
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const state of states) {
    env[state.prepared.urlEnvName] = state.manifest.url;
    if (state.prepared.urlEnv !== undefined) {
      env[state.prepared.urlEnv] = state.manifest.url;
    }
  }
  return env;
}

function serviceUrl(port: number): string {
  return `http://${RUNTIME_HOST}:${port}`;
}

function envSuffix(name: string): string {
  return name
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function isInside(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new RuntimeManagerError(`${field} must be a non-empty string`);
  }
  return value;
}

function positiveInteger(
  value: number | undefined,
  fallback: number,
  field: string,
): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value <= 0) {
    throw new RuntimeManagerError(`${field} must be a positive integer`);
  }
  return value;
}

function assertSafeId(value: string, field: string): void {
  if (typeof value !== "string" || !SAFE_ID_PATTERN.test(value)) {
    throw new RuntimeManagerError(
      `invalid ${field} ${JSON.stringify(value)}: ` +
        "must match [A-Za-z0-9][A-Za-z0-9._-]* (max 128 chars)",
    );
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

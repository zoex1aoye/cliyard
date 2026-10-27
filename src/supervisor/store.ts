/**
 * Atomic, single-repository persistence for Supervisor v0.
 *
 * Layout, relative to the repository root:
 *
 *   .cliyard/runs/<runId>.json   RunManifest checkpoint
 *   .cliyard/runs/active.json    active run pointer
 *   .cliyard/supervisor.lock     exclusive supervisor lock
 *
 * Manifests and the active pointer are written with temp file + rename, so a
 * reader never observes a partially written checkpoint. The supervisor lock is
 * created with O_EXCL and records its owner; a lock whose owner process is
 * gone is reported as stale and can be cleared explicitly.
 */
import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { hostname } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { parseCostTruth, parseFailureRecord } from "../failures.js";
import {
  ACTIVE_RUN_VERSION,
  RUN_MANIFEST_VERSION,
  type ActiveRunPointer,
  type RunManifest,
  type RunOwner,
  type RunStatus,
  type RunTaskState,
  type SupervisorLockInfo,
} from "./types.js";

export const SUPERVISOR_DIR = ".cliyard";
export const RUNS_DIR = "runs";
export const ACTIVE_RUN_FILE = "active.json";
export const SUPERVISOR_LOCK_FILE = "supervisor.lock";

const RUN_STATUSES: readonly RunStatus[] = [
  "running",
  "interrupted",
  "completed",
  "blocked",
];

const RUN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export interface SupervisorPaths {
  repoRoot: string;
  cliyardDir: string;
  runsDir: string;
  activePath: string;
  lockPath: string;
}

export function supervisorPaths(repoRoot: string): SupervisorPaths {
  const root = resolve(repoRoot);
  const cliyardDir = join(root, SUPERVISOR_DIR);
  const runsDir = join(cliyardDir, RUNS_DIR);
  return {
    repoRoot: root,
    cliyardDir,
    runsDir,
    activePath: join(runsDir, ACTIVE_RUN_FILE),
    lockPath: join(cliyardDir, SUPERVISOR_LOCK_FILE),
  };
}

export function runManifestPath(repoRoot: string, runId: string): string {
  assertSafeRunId(runId);
  return join(supervisorPaths(repoRoot).runsDir, `${runId}.json`);
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class SupervisorStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

export class RunManifestError extends SupervisorStoreError {}

export class RunNotFoundError extends SupervisorStoreError {
  constructor(
    readonly runId: string,
    readonly path: string,
  ) {
    super(`run manifest not found: ${runId} (${path})`);
  }
}

export class NoActiveRunError extends SupervisorStoreError {
  constructor(readonly repoRoot: string) {
    super(`no active supervisor run under ${repoRoot}`);
  }
}

export class ContractsHashMismatchError extends SupervisorStoreError {
  constructor(
    readonly contractsPath: string,
    readonly expected: string,
    readonly actual: string,
  ) {
    super(
      `contracts hash mismatch for ${contractsPath}: ` +
        `manifest has ${expected}, file is ${actual}`,
    );
  }
}

export class SupervisorLockHeldError extends SupervisorStoreError {
  constructor(
    readonly lockPath: string,
    readonly owner?: SupervisorLockInfo,
    readonly reason?: string,
  ) {
    super(
      owner
        ? `supervisor lock held by run ${owner.runId} ` +
            `(pid ${owner.pid} on ${owner.host})` +
            (reason ? `: ${reason}` : "")
        : `supervisor lock is held at ${lockPath}` +
            (reason ? `: ${reason}` : ""),
    );
  }
}

// ---------------------------------------------------------------------------
// Create / load / save / update
// ---------------------------------------------------------------------------

export interface CreateRunManifestInput {
  planId: string;
  /**
   * Path to the frozen contracts file. Relative paths are resolved against
   * the repository root so resume works from any cwd.
   */
  contractsPath: string;
  /** Defaults to the SHA-256 of the contracts file. */
  contractsHash?: string;
  baseCommit: string;
  integrationBranch: string;
  /** Defaults to baseCommit when the integration branch starts there. */
  integrationHead?: string;
  /** Defaults to a random UUID. */
  runId?: string;
  /** Task ids start as `ready`; task records may be passed to seed checkpoints. */
  tasks?: Array<string | RunTaskState>;
  /** Defaults to this process. Mostly a test seam for stale-owner scenarios. */
  owner?: RunOwner;
  /** Write the active run pointer (default true). */
  activate?: boolean;
}

export function resolveContractsPath(repoRoot: string, contractsPath: string): string {
  if (typeof contractsPath !== "string" || !contractsPath.trim()) {
    throw new RunManifestError("contractsPath must be a non-empty string");
  }
  return isAbsolute(contractsPath)
    ? resolve(contractsPath)
    : resolve(resolve(repoRoot), contractsPath);
}

export function createRunManifest(
  repoRoot: string,
  input: CreateRunManifestInput,
): RunManifest {
  const root = resolve(repoRoot);
  const runId = input.runId ?? randomUUID();
  const path = runManifestPath(root, runId);
  if (existsSync(path)) {
    throw new RunManifestError(`run manifest already exists: ${path}`);
  }

  const contractsPath = resolveContractsPath(root, input.contractsPath);
  const tasks: Record<string, RunTaskState> = {};
  for (const entry of input.tasks ?? []) {
    const task: RunTaskState =
      typeof entry === "string"
        ? { taskId: entry, status: "ready", accepted: false }
        : { ...entry };
    if (typeof task.taskId !== "string" || !task.taskId.trim()) {
      throw new RunManifestError("task entry is missing a non-empty taskId");
    }
    if (tasks[task.taskId]) {
      throw new RunManifestError(`duplicate taskId: ${task.taskId}`);
    }
    tasks[task.taskId] = task;
  }

  const at = new Date().toISOString();
  const baseCommit = requireNonEmpty(input.baseCommit, "baseCommit");
  const manifest: RunManifest = {
    version: RUN_MANIFEST_VERSION,
    runId,
    planId: requireNonEmpty(input.planId, "planId"),
    repoRoot: root,
    contractsPath,
    contractsHash:
      input.contractsHash ?? computeContractsHash(contractsPath),
    baseCommit,
    integrationBranch: requireNonEmpty(
      input.integrationBranch,
      "integrationBranch",
    ),
    integrationHead: requireNonEmpty(
      input.integrationHead ?? baseCommit,
      "integrationHead",
    ),
    status: "running",
    createdAt: at,
    updatedAt: at,
    owner: input.owner ?? { pid: process.pid, host: hostname() },
    tasks,
  };

  saveRunManifest(manifest);
  if (input.activate !== false) {
    setActiveRun(root, runId);
  }
  return manifest;
}

export function saveRunManifest(manifest: RunManifest): void {
  parseRunManifest(manifest, "RunManifest");
  writeJsonAtomic(
    runManifestPath(manifest.repoRoot, manifest.runId),
    manifest,
  );
}

/**
 * Load a manifest by id, or the active run when `runId` is omitted.
 * Throws RunNotFoundError / NoActiveRunError when there is nothing to load.
 */
export function loadRunManifest(
  repoRoot: string,
  runId?: string,
): RunManifest {
  const root = resolve(repoRoot);
  const id = runId ?? getActiveRunId(root);
  if (!id) throw new NoActiveRunError(root);

  const path = runManifestPath(root, id);
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new RunNotFoundError(id, path);
    }
    throw new SupervisorStoreError(
      `cannot read run manifest ${path}: ${errorMessage(error)}`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch (error) {
    throw new RunManifestError(
      `invalid JSON in run manifest ${path}: ${errorMessage(error)}`,
    );
  }
  return parseRunManifest(parsed, path);
}

/**
 * Load, mutate, stamp `updatedAt`, and atomically save a manifest.
 * Callers run this while holding the supervisor lock; the mutator must not
 * change the run identity (`runId`, `repoRoot`, `version`).
 */
export function updateRunManifest(
  repoRoot: string,
  runId: string | undefined,
  mutate: (manifest: RunManifest) => void,
): RunManifest {
  const manifest = loadRunManifest(repoRoot, runId);
  const identity = {
    runId: manifest.runId,
    repoRoot: resolve(manifest.repoRoot),
    version: manifest.version,
  };

  mutate(manifest);

  if (
    manifest.runId !== identity.runId ||
    resolve(manifest.repoRoot) !== identity.repoRoot ||
    manifest.version !== identity.version
  ) {
    throw new RunManifestError(
      "run identity (runId, repoRoot, version) is immutable",
    );
  }

  manifest.updatedAt = new Date().toISOString();
  saveRunManifest(manifest);
  return manifest;
}

// ---------------------------------------------------------------------------
// Active run pointer
// ---------------------------------------------------------------------------

export function getActiveRun(repoRoot: string): ActiveRunPointer | undefined {
  return readActiveRun(resolve(repoRoot));
}

export function getActiveRunId(repoRoot: string): string | undefined {
  return readActiveRun(resolve(repoRoot))?.runId;
}

export function setActiveRun(
  repoRoot: string,
  runId: string,
): ActiveRunPointer {
  const root = resolve(repoRoot);
  const manifestPath = runManifestPath(root, runId);
  if (!existsSync(manifestPath)) {
    throw new RunNotFoundError(runId, manifestPath);
  }
  const pointer: ActiveRunPointer = {
    version: ACTIVE_RUN_VERSION,
    runId,
    updatedAt: new Date().toISOString(),
  };
  writeJsonAtomic(supervisorPaths(root).activePath, pointer);
  return pointer;
}

/**
 * Remove the active pointer. When `runId` is given, the pointer is cleared
 * only if it still points at that run.
 */
export function clearActiveRun(repoRoot: string, runId?: string): boolean {
  const root = resolve(repoRoot);
  const pointer = readActiveRun(root);
  if (!pointer) return false;
  if (runId !== undefined && pointer.runId !== runId) return false;
  try {
    unlinkSync(supervisorPaths(root).activePath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function readActiveRun(root: string): ActiveRunPointer | undefined {
  const path = supervisorPaths(root).activePath;
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new SupervisorStoreError(
      `cannot read active run pointer ${path}: ${errorMessage(error)}`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch (error) {
    throw new SupervisorStoreError(
      `invalid JSON in active run pointer ${path}: ${errorMessage(error)}`,
    );
  }

  if (
    !isRecord(parsed) ||
    parsed.version !== ACTIVE_RUN_VERSION ||
    typeof parsed.runId !== "string" ||
    typeof parsed.updatedAt !== "string"
  ) {
    throw new SupervisorStoreError(`invalid active run pointer: ${path}`);
  }
  assertSafeRunId(parsed.runId);
  return parsed as unknown as ActiveRunPointer;
}

// ---------------------------------------------------------------------------
// Contracts hash
// ---------------------------------------------------------------------------

export function computeContractsHash(contractsPath: string): string {
  let bytes: Buffer;
  try {
    bytes = readFileSync(contractsPath);
  } catch (error) {
    throw new SupervisorStoreError(
      `cannot hash contracts file ${contractsPath}: ${errorMessage(error)}`,
    );
  }
  return createHash("sha256").update(bytes).digest("hex");
}

export interface ContractsHashCheck {
  ok: boolean;
  contractsPath: string;
  expected: string;
  actual: string;
}

export function checkContractsHash(manifest: RunManifest): ContractsHashCheck {
  const actual = computeContractsHash(manifest.contractsPath);
  return {
    ok: actual === manifest.contractsHash,
    contractsPath: manifest.contractsPath,
    expected: manifest.contractsHash,
    actual,
  };
}

/** Resume precondition: the contracts file must be byte-identical. */
export function assertContractsHash(manifest: RunManifest): void {
  const check = checkContractsHash(manifest);
  if (!check.ok) {
    throw new ContractsHashMismatchError(
      check.contractsPath,
      check.expected,
      check.actual,
    );
  }
}

// ---------------------------------------------------------------------------
// Exclusive supervisor lock
// ---------------------------------------------------------------------------

export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but belongs to another user.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export function isSameHost(host: string): boolean {
  return host.trim().toLowerCase() === hostname().trim().toLowerCase();
}

export type SupervisorLockState = "free" | "held" | "stale" | "invalid";

export interface SupervisorLockInspection {
  state: SupervisorLockState;
  path: string;
  lock?: SupervisorLockInfo;
  reason?: string;
}

export function inspectSupervisorLock(
  repoRoot: string,
): SupervisorLockInspection {
  const path = supervisorPaths(repoRoot).lockPath;
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { state: "free", path };
    }
    return {
      state: "invalid",
      path,
      reason: `cannot read lock: ${errorMessage(error)}`,
    };
  }

  let lock: SupervisorLockInfo;
  try {
    lock = parseLockInfo(JSON.parse(raw) as unknown);
  } catch (error) {
    return {
      state: "invalid",
      path,
      reason: `invalid lock content: ${errorMessage(error)}`,
    };
  }

  if (!isSameHost(lock.host)) {
    return {
      state: "held",
      path,
      lock,
      reason: `lock owner is on ${lock.host}; liveness cannot be checked`,
    };
  }
  if (!isProcessAlive(lock.pid)) {
    return {
      state: "stale",
      path,
      lock,
      reason: `owner pid ${lock.pid} is not running`,
    };
  }
  return { state: "held", path, lock };
}

export interface AcquireSupervisorLockOptions {
  /**
   * Replace an existing lock without checking its owner. Only for an explicit
   * operator recovery action; normal starts must fail while a lock is held.
   */
  force?: boolean;
}

export interface SupervisorLockHandle {
  path: string;
  lock: SupervisorLockInfo;
  /** Idempotent; removes the lock only if this handle still owns it. */
  release(): void;
}

export function acquireSupervisorLock(
  repoRoot: string,
  runId: string,
  options: AcquireSupervisorLockOptions = {},
): SupervisorLockHandle {
  const root = resolve(repoRoot);
  assertSafeRunId(runId);
  const { cliyardDir, lockPath } = supervisorPaths(root);
  mkdirSync(cliyardDir, { recursive: true });

  if (options.force) {
    try {
      unlinkSync(lockPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  const info: SupervisorLockInfo = {
    runId,
    pid: process.pid,
    host: hostname(),
    acquiredAt: new Date().toISOString(),
  };
  const content = JSON.stringify(info, null, 2) + "\n";

  let fd: number;
  try {
    fd = openSync(lockPath, "wx", 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      const inspection = inspectSupervisorLock(root);
      throw new SupervisorLockHeldError(
        lockPath,
        inspection.lock,
        inspection.reason,
      );
    }
    throw error;
  }

  try {
    writeFileSync(fd, content, "utf8");
    fsyncSync(fd);
  } catch (error) {
    try {
      closeSync(fd);
    } catch {
      /* ignore */
    }
    try {
      unlinkSync(lockPath);
    } catch {
      /* ignore */
    }
    throw error;
  }
  closeSync(fd);

  let released = false;
  return {
    path: lockPath,
    lock: info,
    release() {
      if (released) return;
      released = true;
      try {
        if (readFileSync(lockPath, "utf8") === content) {
          unlinkSync(lockPath);
        }
      } catch {
        /* already released or replaced */
      }
    },
  };
}

export async function withSupervisorLock<T>(
  repoRoot: string,
  runId: string,
  fn: (lock: SupervisorLockHandle) => T | Promise<T>,
  options: AcquireSupervisorLockOptions = {},
): Promise<T> {
  const lock = acquireSupervisorLock(repoRoot, runId, options);
  try {
    return await fn(lock);
  } finally {
    lock.release();
  }
}

/** Remove a lock whose owner process is provably gone. Returns true if removed. */
export function clearStaleSupervisorLock(repoRoot: string): boolean {
  const inspection = inspectSupervisorLock(repoRoot);
  if (inspection.state !== "stale") return false;
  try {
    unlinkSync(inspection.path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Stale / interrupted run detection
// ---------------------------------------------------------------------------

export interface RunInspection {
  manifest: RunManifest;
  lock: SupervisorLockInfo | null;
  /** null when the owner is on another host and liveness is unknowable. */
  ownerAlive: boolean | null;
  /** Running manifest whose owner is dead: a resumable crashed run. */
  interrupted: boolean;
}

export function inspectRun(repoRoot: string, runId?: string): RunInspection {
  const root = resolve(repoRoot);
  const manifest = loadRunManifest(root, runId);
  const lock = inspectSupervisorLock(root).lock ?? null;
  const owner =
    lock && lock.runId === manifest.runId ? lock : manifest.owner;
  const ownerAlive = isSameHost(owner.host)
    ? isProcessAlive(owner.pid)
    : null;
  return {
    manifest,
    lock,
    ownerAlive,
    interrupted:
      manifest.status === "running" && ownerAlive === false,
  };
}

/**
 * Flip a running manifest to `interrupted` when its owner is gone.
 * Idempotent; non-running or foreign-host manifests are returned unchanged.
 */
export function markRunInterrupted(
  repoRoot: string,
  runId?: string,
): RunManifest {
  const inspection = inspectRun(repoRoot, runId);
  if (!inspection.interrupted) return inspection.manifest;
  return updateRunManifest(repoRoot, inspection.manifest.runId, (manifest) => {
    manifest.status = "interrupted";
  });
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function assertSafeRunId(runId: string): void {
  if (typeof runId !== "string" || !RUN_ID_PATTERN.test(runId)) {
    throw new RunManifestError(`invalid runId: ${JSON.stringify(runId)}`);
  }
}

function requireNonEmpty(value: string, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new RunManifestError(`${field} must be a non-empty string`);
  }
  return value;
}

function parseRunManifest(raw: unknown, source: string): RunManifest {
  if (!isRecord(raw)) {
    throw new RunManifestError(`${source}: manifest must be an object`);
  }
  if (raw.version !== RUN_MANIFEST_VERSION) {
    throw new RunManifestError(
      `${source}: unsupported manifest version ${JSON.stringify(raw.version)} ` +
        `(expected ${RUN_MANIFEST_VERSION})`,
    );
  }

  for (const key of [
    "runId",
    "planId",
    "repoRoot",
    "contractsPath",
    "contractsHash",
    "baseCommit",
    "integrationBranch",
    "integrationHead",
    "createdAt",
    "updatedAt",
  ] as const) {
    if (typeof raw[key] !== "string" || !(raw[key] as string).trim()) {
      throw new RunManifestError(
        `${source}: ${key} must be a non-empty string`,
      );
    }
  }
  assertSafeRunId(raw.runId as string);

  if (!RUN_STATUSES.includes(raw.status as RunStatus)) {
    throw new RunManifestError(
      `${source}: invalid run status ${JSON.stringify(raw.status)}`,
    );
  }

  if (
    !isRecord(raw.owner) ||
    !Number.isInteger(raw.owner.pid) ||
    (raw.owner.pid as number) <= 0 ||
    typeof raw.owner.host !== "string" ||
    !raw.owner.host.trim()
  ) {
    throw new RunManifestError(
      `${source}: owner must be { pid: positive integer, host: string }`,
    );
  }

  if (!isRecord(raw.tasks)) {
    throw new RunManifestError(`${source}: tasks must be an object`);
  }
  for (const [key, task] of Object.entries(raw.tasks)) {
    if (!isRecord(task)) {
      throw new RunManifestError(`${source}: task ${key} must be an object`);
    }
    if (typeof task.taskId !== "string" || !task.taskId.trim()) {
      throw new RunManifestError(
        `${source}: task ${key} must have a non-empty taskId`,
      );
    }
    if (typeof task.status !== "string" || !task.status.trim()) {
      throw new RunManifestError(
        `${source}: task ${key} must have a non-empty status`,
      );
    }
    if (typeof task.accepted !== "boolean") {
      throw new RunManifestError(
        `${source}: task ${key}.accepted must be boolean`,
      );
    }
    // Attempt-continuity fields are optional so manifests written before the
    // feature (and active attempts without a rejection) still parse. Their
    // semantics are validated at reuse time by the worker batch.
    for (const optional of [
      "runId",
      "resultCommit",
      "reason",
      "attemptWorktree",
      "attemptBranch",
      "attemptBaseCommit",
      "attemptStartedAt",
      "attemptRejectedAt",
    ] as const) {
      if (
        task[optional] !== undefined &&
        typeof task[optional] !== "string"
      ) {
        throw new RunManifestError(
          `${source}: task ${key}.${optional} must be a string`,
        );
      }
    }
    // Structured observations are optional so older manifests stay readable,
    // but a present record must validate completely. Unknown nested fields are
    // dropped by the parser; nothing is repaired by guessing.
    if (task.failure !== undefined) {
      const failure = parseFailureRecord(task.failure);
      if (!failure) {
        throw new RunManifestError(
          `${source}: task ${key}.failure is not a valid failure record`,
        );
      }
      task.failure = failure;
    }
    if (task.cost !== undefined) {
      const cost = parseCostTruth(task.cost);
      if (!cost) {
        throw new RunManifestError(
          `${source}: task ${key}.cost is not a valid cost record`,
        );
      }
      task.cost = cost;
    }
  }

  return raw as unknown as RunManifest;
}

function parseLockInfo(raw: unknown): SupervisorLockInfo {
  if (
    !isRecord(raw) ||
    typeof raw.runId !== "string" ||
    !raw.runId.trim() ||
    !Number.isInteger(raw.pid) ||
    (raw.pid as number) <= 0 ||
    typeof raw.host !== "string" ||
    !raw.host.trim() ||
    typeof raw.acquiredAt !== "string" ||
    !raw.acquiredAt.trim()
  ) {
    throw new SupervisorStoreError(
      "lock must be { runId, pid, host, acquiredAt }",
    );
  }
  return {
    runId: raw.runId,
    pid: raw.pid as number,
    host: raw.host,
    acquiredAt: raw.acquiredAt,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Write JSON through a same-directory temp file, then rename atomically. */
function writeJsonAtomic(path: string, value: unknown): void {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true });
  const tmp = join(
    dir,
    `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`,
  );
  try {
    const fd = openSync(tmp, "wx", 0o600);
    try {
      writeFileSync(fd, JSON.stringify(value, null, 2) + "\n", "utf8");
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

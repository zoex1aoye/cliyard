/**
 * Durable foreground orchestration queue storage
 * (design/durable-orchestration-v0.md).
 *
 * Layout, relative to the repository root:
 *
 *   .cliyard/queue.json   ordered queue items
 *   .cliyard/queue.lock   exclusive queue ownership
 *
 * Queue JSON is replaced atomically. Mutations take the queue lock, so two
 * foreground commands cannot interleave a read-modify-write. The lock records
 * pid/host/token; a same-host lock whose owner is dead is stale and may be
 * reclaimed. A foreign-host or unreadable lock fails closed.
 *
 * The queue only coordinates Supervisor runs. It never writes a RunManifest.
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
import { findCycle } from "../scheduler/dag.js";
import {
  isProcessAlive,
  isSameHost,
  SUPERVISOR_DIR,
} from "../supervisor/store.js";

export const QUEUE_VERSION = 1 as const;
export const QUEUE_FILE = "queue.json";
export const QUEUE_LOCK_FILE = "queue.lock";
export const DEFAULT_MAX_ATTEMPTS = 3;

/** Queue ids are explicit labels and must be safe path/manifest identifiers. */
const QUEUE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/i;

export type QueueItemStatus =
  | "pending"
  | "running"
  | "completed"
  | "blocked"
  | "cancelled";
export type QueueNextAction = "start" | "resume";
export type QueueWorker = "claude" | "codex";

/**
 * One explicitly approved contracts file plus its frozen hash. The contracts
 * path and hash are captured at `queue add`; dispatch fails closed when the
 * current bytes no longer match.
 */
export interface QueueItem {
  id: string;
  contractsPath: string;
  contractsHash: string;
  /** Optional supervisor plan label; defaults to the contracts basename. */
  planId?: string;
  worker: QueueWorker;
  model?: string;
  dependsOn: string[];
  status: QueueItemStatus;
  attempts: number;
  maxAttempts: number;
  runIds: string[];
  lastRunId?: string;
  nextAction: QueueNextAction;
  createdAt: string;
  updatedAt: string;
  reason?: string;
}

export interface QueueDocument {
  version: typeof QUEUE_VERSION;
  updatedAt: string;
  items: QueueItem[];
}

/** `<repo>/.cliyard/queue.lock` — exclusive foreground queue ownership. */
export interface QueueLockInfo {
  pid: number;
  host: string;
  token: string;
  acquiredAt: string;
}

export interface QueuePaths {
  repoRoot: string;
  cliyardDir: string;
  queuePath: string;
  lockPath: string;
}

export function queuePaths(repoRoot: string): QueuePaths {
  const root = resolve(repoRoot);
  const cliyardDir = join(root, SUPERVISOR_DIR);
  return {
    repoRoot: root,
    cliyardDir,
    queuePath: join(cliyardDir, QUEUE_FILE),
    lockPath: join(cliyardDir, QUEUE_LOCK_FILE),
  };
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class QueueStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

export class QueueValidationError extends QueueStoreError {}

export class QueueItemNotFoundError extends QueueStoreError {
  constructor(
    readonly id: string,
    readonly path: string,
  ) {
    super(`queue item not found: ${id} (${path})`);
  }
}

export class QueueLockError extends QueueStoreError {}

export class QueueLockHeldError extends QueueLockError {
  constructor(
    readonly lockPath: string,
    readonly owner: QueueLockInfo | undefined,
    readonly state: "held" | "invalid",
    readonly detail?: string,
  ) {
    super(
      state === "invalid"
        ? `queue lock ${lockPath} is invalid` +
            (detail ? `: ${detail}` : "") +
            "; inspect it and clean it up manually"
        : owner
          ? `queue lock held by pid ${owner.pid} on ${owner.host}` +
            (detail ? ` (${detail})` : "")
          : `queue lock is held at ${lockPath}` +
            (detail ? `: ${detail}` : ""),
    );
    this.name = "QueueLockHeldError";
  }
}

// ---------------------------------------------------------------------------
// Contracts hash
// ---------------------------------------------------------------------------

/** SHA-256 of a file's exact bytes. Read failures are validation errors. */
export function hashFileSha256(filePath: string): string {
  let bytes: Buffer;
  try {
    bytes = readFileSync(filePath);
  } catch (error) {
    throw new QueueValidationError(
      `contracts file is missing or unreadable: ${resolve(filePath)} ` +
        `(${errorMessage(error)})`,
    );
  }
  return createHash("sha256").update(bytes).digest("hex");
}

export interface QueueContractsCheck {
  ok: boolean;
  contractsPath: string;
  expected: string;
  actual: string | null;
  reason?: string;
}

/** Compare the frozen item hash with the current contracts bytes. */
export function checkQueueContracts(
  item: Pick<QueueItem, "contractsPath" | "contractsHash">,
): QueueContractsCheck {
  let actual: string;
  try {
    actual = hashFileSha256(item.contractsPath);
  } catch (error) {
    return {
      ok: false,
      contractsPath: item.contractsPath,
      expected: item.contractsHash,
      actual: null,
      reason: errorMessage(error),
    };
  }
  if (actual !== item.contractsHash) {
    return {
      ok: false,
      contractsPath: item.contractsPath,
      expected: item.contractsHash,
      actual,
      reason:
        `contracts changed: ${item.contractsPath} ` +
        `(expected sha256 ${item.contractsHash}, found ${actual})`,
    };
  }
  return {
    ok: true,
    contractsPath: item.contractsPath,
    expected: item.contractsHash,
    actual,
  };
}

// ---------------------------------------------------------------------------
// Queue document
// ---------------------------------------------------------------------------

function emptyQueue(): QueueDocument {
  return {
    version: QUEUE_VERSION,
    updatedAt: new Date(0).toISOString(),
    items: [],
  };
}

/** Load the queue. A missing queue file is an empty queue. */
export function loadQueue(repoRoot: string): QueueDocument {
  const path = queuePaths(repoRoot).queuePath;
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return emptyQueue();
    }
    throw new QueueStoreError(
      `cannot read queue ${path}: ${errorMessage(error)}`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch (error) {
    throw new QueueValidationError(
      `invalid JSON in queue ${path}: ${errorMessage(error)}`,
    );
  }
  return parseQueueDocument(parsed, path);
}

/** Validate and atomically replace the queue JSON. */
export function saveQueue(repoRoot: string, document: QueueDocument): void {
  const normalized = parseQueueDocument(document, "queue");
  writeJsonAtomic(queuePaths(repoRoot).queuePath, normalized);
}

export interface QueueCounts {
  total: number;
  pending: number;
  running: number;
  completed: number;
  blocked: number;
  cancelled: number;
}

export function queueCounts(document: QueueDocument): QueueCounts {
  const counts: QueueCounts = {
    total: document.items.length,
    pending: 0,
    running: 0,
    completed: 0,
    blocked: 0,
    cancelled: 0,
  };
  for (const item of document.items) counts[item.status] += 1;
  return counts;
}

// ---------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------

export interface AddQueueItemInput {
  id: string;
  /** Resolved against the repository root when relative. */
  contractsPath: string;
  dependsOn?: string[];
  worker?: QueueWorker;
  model?: string;
  planId?: string;
  maxAttempts?: number;
}

/**
 * Add one approved contracts file. The contracts path is made absolute and
 * hashed under the queue lock so the frozen identity matches the bytes the
 * operator approved.
 */
export function addQueueItem(
  repoRoot: string,
  input: AddQueueItemInput,
): QueueItem {
  const root = resolve(repoRoot);
  return withQueueLock(root, () => {
    const document = loadQueue(root);
    assertSafeQueueId(input.id, "queue id");
    if (document.items.some((item) => item.id === input.id)) {
      throw new QueueValidationError(
        `duplicate queue id ${JSON.stringify(input.id)}`,
      );
    }
    if (typeof input.contractsPath !== "string" || !input.contractsPath.trim()) {
      throw new QueueValidationError("contractsPath must be a non-empty string");
    }
    const contractsPath = isAbsolute(input.contractsPath)
      ? resolve(input.contractsPath)
      : resolve(root, input.contractsPath);
    if (!existsSync(contractsPath)) {
      throw new QueueValidationError(
        `contracts file not found: ${contractsPath}`,
      );
    }
    const contractsHash = hashFileSha256(contractsPath);

    const dependsOn = uniqueStrings(input.dependsOn ?? []);
    for (const dependency of dependsOn) {
      assertSafeQueueId(dependency, "dependency id");
      if (!document.items.some((item) => item.id === dependency)) {
        throw new QueueValidationError(
          `queue item ${JSON.stringify(input.id)} depends on unknown item ` +
            JSON.stringify(dependency),
        );
      }
    }
    const cycle = findCycle([
      ...document.items.map((item) => ({
        id: item.id,
        dependsOn: item.dependsOn,
      })),
      { id: input.id, dependsOn },
    ]);
    if (!cycle.ok) {
      throw new QueueValidationError(
        `dependency cycle: ${cycle.cycle.join(" -> ")}`,
      );
    }

    const worker = input.worker ?? "claude";
    if (worker !== "claude" && worker !== "codex") {
      throw new QueueValidationError(
        `--worker must be claude or codex (got ${String(worker)})`,
      );
    }
    const maxAttempts = input.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
    if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
      throw new QueueValidationError(
        `maxAttempts must be a positive integer (got ${String(maxAttempts)})`,
      );
    }

    const planId = optionalNonEmpty(input.planId);
    const model = optionalNonEmpty(input.model);
    const at = now();
    const item: QueueItem = {
      id: input.id,
      contractsPath,
      contractsHash,
      ...(planId !== undefined ? { planId } : {}),
      worker,
      ...(model !== undefined ? { model } : {}),
      dependsOn,
      status: "pending",
      attempts: 0,
      maxAttempts,
      runIds: [],
      nextAction: "start",
      createdAt: at,
      updatedAt: at,
    };
    document.items.push(item);
    document.updatedAt = at;
    saveQueue(root, document);
    return item;
  });
}

/**
 * Return a blocked item to pending. `nextAction` is `resume` whenever a run id
 * is recorded, otherwise `start`. A pending item is already retryable.
 */
export function retryQueueItem(repoRoot: string, id: string): QueueItem {
  const root = resolve(repoRoot);
  return withQueueLock(root, () => {
    const document = loadQueue(root);
    const item = requireQueueItem(document, root, id);
    if (item.status === "completed") {
      throw new QueueValidationError(
        `queue item ${JSON.stringify(id)} is completed; ` +
          "completed items never run again",
      );
    }
    if (item.status === "cancelled") {
      throw new QueueValidationError(
        `queue item ${JSON.stringify(id)} is cancelled; ` +
          "cancelled items never run again",
      );
    }
    if (item.status === "running") {
      throw new QueueValidationError(
        `queue item ${JSON.stringify(id)} is running (or stale); ` +
          "run `cliyard queue run` to reconcile it before retrying",
      );
    }
    if (item.status === "pending") return item;

    const at = now();
    item.status = "pending";
    item.nextAction = item.lastRunId ? "resume" : "start";
    delete item.reason;
    item.updatedAt = at;
    document.updatedAt = at;
    saveQueue(root, document);
    return item;
  });
}

/**
 * Cancel an item. Completed and already-cancelled items are monotonic; a stale
 * running item may be cancelled because holding the queue lock proves no queue
 * dispatch is active.
 */
export function cancelQueueItem(repoRoot: string, id: string): QueueItem {
  const root = resolve(repoRoot);
  return withQueueLock(root, () => {
    const document = loadQueue(root);
    const item = requireQueueItem(document, root, id);
    if (item.status === "completed") {
      throw new QueueValidationError(
        `queue item ${JSON.stringify(id)} is completed; ` +
          "completed items never run again",
      );
    }
    if (item.status === "cancelled") return item;

    const at = now();
    item.status = "cancelled";
    item.reason = "cancelled";
    item.updatedAt = at;
    document.updatedAt = at;
    saveQueue(root, document);
    return item;
  });
}

// ---------------------------------------------------------------------------
// Exclusive queue lock
// ---------------------------------------------------------------------------

export type QueueLockState = "free" | "held" | "stale" | "invalid";

export interface QueueLockInspection {
  state: QueueLockState;
  path: string;
  lock?: QueueLockInfo;
  reason?: string;
}

export interface QueueLockHandle {
  path: string;
  lock: QueueLockInfo;
  /** Idempotent; removes the lock only if this handle still owns it. */
  release(): void;
}

export function inspectQueueLock(repoRoot: string): QueueLockInspection {
  const path = queuePaths(repoRoot).lockPath;
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

  let lock: QueueLockInfo;
  try {
    lock = parseQueueLock(JSON.parse(raw) as unknown);
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

/**
 * Acquire the queue lock without waiting. Invalid, foreign-host and live
 * same-host locks fail closed. A stale same-host lock is reclaimed, but only
 * when its recorded token still matches what was inspected.
 */
export function acquireQueueLock(repoRoot: string): QueueLockHandle {
  const root = resolve(repoRoot);
  const { cliyardDir, lockPath } = queuePaths(root);
  mkdirSync(cliyardDir, { recursive: true });

  const info: QueueLockInfo = {
    pid: process.pid,
    host: hostname(),
    token: randomUUID(),
    acquiredAt: now(),
  };
  const content = JSON.stringify(info, null, 2) + "\n";

  // The loop handles two benign races: the owner released between O_EXCL and
  // inspection, or another process reclaimed the stale lock first.
  for (let attempt = 0; attempt < 5; attempt += 1) {
    let fd: number;
    try {
      fd = openSync(lockPath, "wx", 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        throw new QueueLockError(
          `cannot create queue lock ${lockPath}: ${errorMessage(error)}`,
        );
      }
      const inspection = inspectQueueLock(root);
      if (inspection.state === "free") continue;
      if (inspection.state === "stale") {
        reclaimStaleQueueLock(inspection);
        continue;
      }
      throw new QueueLockHeldError(
        inspection.path,
        inspection.lock,
        inspection.state === "invalid" ? "invalid" : "held",
        inspection.reason,
      );
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
      throw new QueueLockError(
        `cannot write queue lock ${lockPath}: ${errorMessage(error)}`,
      );
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
  throw new QueueLockError(
    `queue lock ${lockPath} changed while acquiring; try again`,
  );
}

export interface QueueLockWaitOptions {
  /** Total time to wait for a live same-host owner. Defaults to 5000 ms. */
  timeoutMs?: number;
  /** Poll interval while waiting. Defaults to 25 ms. */
  pollMs?: number;
}

/**
 * Acquire the queue lock, waiting for a live same-host owner to release it.
 * Foreign-host and invalid locks still fail immediately.
 */
export async function acquireQueueLockWithWait(
  repoRoot: string,
  options: QueueLockWaitOptions = {},
): Promise<QueueLockHandle> {
  const timeoutMs = options.timeoutMs ?? 5_000;
  const pollMs = options.pollMs ?? 25;
  const deadline = Date.now() + Math.max(0, timeoutMs);

  for (;;) {
    try {
      return acquireQueueLock(repoRoot);
    } catch (error) {
      if (!(error instanceof QueueLockHeldError) || error.state !== "held") {
        throw error;
      }
      // A remote owner can never become provably free on this host.
      if (!error.owner || !isSameHost(error.owner.host)) throw error;
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw error;
      await sleep(Math.min(pollMs, remaining));
    }
  }
}

export function withQueueLock<T>(
  repoRoot: string,
  fn: (lock: QueueLockHandle) => T,
): T;
export function withQueueLock<T>(
  repoRoot: string,
  fn: (lock: QueueLockHandle) => Promise<T>,
): Promise<T>;
export function withQueueLock<T>(
  repoRoot: string,
  fn: (lock: QueueLockHandle) => T | Promise<T>,
): T | Promise<T> {
  const lock = acquireQueueLock(repoRoot);
  try {
    const result = fn(lock);
    if (isPromiseLike(result)) {
      // Keep the lock until async work settles.
      return Promise.resolve(result).finally(() => lock.release());
    }
    lock.release();
    return result;
  } catch (error) {
    lock.release();
    throw error;
  }
}

export async function withQueueLockWait<T>(
  repoRoot: string,
  fn: (lock: QueueLockHandle) => T | Promise<T>,
  options: QueueLockWaitOptions = {},
): Promise<T> {
  const lock = await acquireQueueLockWithWait(repoRoot, options);
  try {
    return await fn(lock);
  } finally {
    lock.release();
  }
}

/** Remove a lock whose same-host owner is provably gone. */
export function clearStaleQueueLock(repoRoot: string): boolean {
  const inspection = inspectQueueLock(repoRoot);
  if (inspection.state !== "stale") return false;
  reclaimStaleQueueLock(inspection);
  return true;
}

function reclaimStaleQueueLock(inspection: QueueLockInspection): void {
  if (!inspection.lock) return;
  try {
    const raw = readFileSync(inspection.path, "utf8");
    const current = parseQueueLock(JSON.parse(raw) as unknown);
    if (current.token === inspection.lock.token) {
      unlinkSync(inspection.path);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    // Content changed or became unreadable: leave it for the next inspection.
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function requireQueueItem(
  document: QueueDocument,
  repoRoot: string,
  id: string,
): QueueItem {
  const item = document.items.find((candidate) => candidate.id === id);
  if (!item) {
    throw new QueueItemNotFoundError(
      id,
      queuePaths(repoRoot).queuePath,
    );
  }
  return item;
}

function assertSafeQueueId(value: string, label: string): void {
  if (typeof value !== "string" || !QUEUE_ID_PATTERN.test(value)) {
    throw new QueueValidationError(
      `invalid ${label}: ${JSON.stringify(value)} ` +
        "(use letters, digits, '.', '_' or '-', max 128 characters)",
    );
  }
}

function optionalNonEmpty(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function now(): string {
  return new Date().toISOString();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPromiseLike<T>(value: T | Promise<T>): value is Promise<T> {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { then?: unknown }).then === "function"
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function parseQueueLock(raw: unknown): QueueLockInfo {
  if (
    !isRecord(raw) ||
    !Number.isInteger(raw.pid) ||
    (raw.pid as number) <= 0 ||
    typeof raw.host !== "string" ||
    !raw.host.trim() ||
    typeof raw.token !== "string" ||
    !raw.token.trim() ||
    typeof raw.acquiredAt !== "string" ||
    !raw.acquiredAt.trim()
  ) {
    throw new QueueLockError(
      "lock must be { pid, host, token, acquiredAt }",
    );
  }
  return {
    pid: raw.pid as number,
    host: raw.host,
    token: raw.token,
    acquiredAt: raw.acquiredAt,
  };
}

function parseQueueDocument(
  raw: unknown,
  source: string,
): QueueDocument {
  if (!isRecord(raw)) {
    throw new QueueValidationError(`${source}: queue must be an object`);
  }
  if (raw.version !== QUEUE_VERSION) {
    throw new QueueValidationError(
      `${source}: unsupported queue version ${JSON.stringify(raw.version)} ` +
        `(expected ${QUEUE_VERSION})`,
    );
  }
  if (typeof raw.updatedAt !== "string" || !raw.updatedAt.trim()) {
    throw new QueueValidationError(
      `${source}: updatedAt must be a non-empty string`,
    );
  }
  if (!Array.isArray(raw.items)) {
    throw new QueueValidationError(`${source}: items must be an array`);
  }

  const items: QueueItem[] = [];
  const ids = new Set<string>();
  for (const [index, value] of raw.items.entries()) {
    const item = parseQueueItem(value, `${source}: items[${index}]`);
    if (ids.has(item.id)) {
      throw new QueueValidationError(
        `${source}: duplicate queue id ${JSON.stringify(item.id)}`,
      );
    }
    ids.add(item.id);
    items.push(item);
  }
  assertQueueGraph(items, source);
  return { version: QUEUE_VERSION, updatedAt: raw.updatedAt, items };
}

function parseQueueItem(raw: unknown, source: string): QueueItem {
  if (!isRecord(raw)) {
    throw new QueueValidationError(`${source}: item must be an object`);
  }
  if (typeof raw.id !== "string" || !QUEUE_ID_PATTERN.test(raw.id)) {
    throw new QueueValidationError(
      `${source}: invalid queue id ${JSON.stringify(raw.id)}`,
    );
  }
  if (typeof raw.contractsPath !== "string" || !raw.contractsPath.trim()) {
    throw new QueueValidationError(
      `${source}: contractsPath must be a non-empty string`,
    );
  }
  if (
    typeof raw.contractsHash !== "string" ||
    !SHA256_PATTERN.test(raw.contractsHash)
  ) {
    throw new QueueValidationError(
      `${source}: contractsHash must be a hex SHA-256 digest`,
    );
  }
  if (raw.worker !== "claude" && raw.worker !== "codex") {
    throw new QueueValidationError(
      `${source}: worker must be claude or codex`,
    );
  }
  if (raw.status === undefined || !QUEUE_STATUSES.includes(raw.status as QueueItemStatus)) {
    throw new QueueValidationError(
      `${source}: invalid status ${JSON.stringify(raw.status)}`,
    );
  }
  if (raw.nextAction !== "start" && raw.nextAction !== "resume") {
    throw new QueueValidationError(
      `${source}: nextAction must be start or resume`,
    );
  }
  if (
    !Array.isArray(raw.dependsOn) ||
    raw.dependsOn.some((dependency) => typeof dependency !== "string")
  ) {
    throw new QueueValidationError(
      `${source}: dependsOn must be a string array`,
    );
  }
  if (
    !Number.isInteger(raw.attempts) ||
    (raw.attempts as number) < 0
  ) {
    throw new QueueValidationError(
      `${source}: attempts must be a non-negative integer`,
    );
  }
  if (
    !Number.isInteger(raw.maxAttempts) ||
    (raw.maxAttempts as number) < 1
  ) {
    throw new QueueValidationError(
      `${source}: maxAttempts must be a positive integer`,
    );
  }
  if (
    !Array.isArray(raw.runIds) ||
    raw.runIds.some((runId) => typeof runId !== "string")
  ) {
    throw new QueueValidationError(`${source}: runIds must be a string array`);
  }
  for (const field of ["createdAt", "updatedAt"] as const) {
    if (typeof raw[field] !== "string" || !raw[field].trim()) {
      throw new QueueValidationError(
        `${source}: ${field} must be a non-empty string`,
      );
    }
  }
  for (const field of ["lastRunId", "reason", "model", "planId"] as const) {
    if (raw[field] !== undefined && typeof raw[field] !== "string") {
      throw new QueueValidationError(
        `${source}: ${field} must be a string`,
      );
    }
  }

  return {
    id: raw.id,
    contractsPath: raw.contractsPath,
    contractsHash: raw.contractsHash,
    ...(raw.planId !== undefined ? { planId: raw.planId as string } : {}),
    worker: raw.worker,
    ...(raw.model !== undefined ? { model: raw.model as string } : {}),
    dependsOn: uniqueStrings(raw.dependsOn as string[]),
    status: raw.status as QueueItemStatus,
    attempts: raw.attempts as number,
    maxAttempts: raw.maxAttempts as number,
    runIds: uniqueStrings(raw.runIds as string[]),
    ...(raw.lastRunId !== undefined
      ? { lastRunId: raw.lastRunId as string }
      : {}),
    nextAction: raw.nextAction,
    createdAt: raw.createdAt as string,
    updatedAt: raw.updatedAt as string,
    ...(raw.reason !== undefined ? { reason: raw.reason as string } : {}),
  };
}

const QUEUE_STATUSES: readonly QueueItemStatus[] = [
  "pending",
  "running",
  "completed",
  "blocked",
  "cancelled",
];

function assertQueueGraph(items: QueueItem[], source: string): void {
  const ids = new Set(items.map((item) => item.id));
  for (const item of items) {
    for (const dependency of item.dependsOn) {
      if (!ids.has(dependency)) {
        throw new QueueValidationError(
          `${source}: queue item ${JSON.stringify(item.id)} depends on ` +
            `unknown item ${JSON.stringify(dependency)}`,
        );
      }
    }
  }
  const cycle = findCycle(
    items.map((item) => ({ id: item.id, dependsOn: item.dependsOn })),
  );
  if (!cycle.ok) {
    throw new QueueValidationError(
      `${source}: dependency cycle: ${cycle.cycle.join(" -> ")}`,
    );
  }
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

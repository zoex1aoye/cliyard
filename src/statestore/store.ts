/**
 * StateStore v0: append-only facts + derived projection in one transaction
 * (design/statestore-v0.md).
 *
 * Discipline:
 * - one `StateStoreDriver` transaction contains the fact append, the projected
 *   rows and the projection sequence marker;
 * - optimistic concurrency is a sequence compare-and-swap checked inside that
 *   transaction (`expectedSeq`);
 * - projection format changes are repaired by discarding the projection and
 *   replaying the fact log, never by a migration script;
 * - clock and event-id randomness enter only at this public boundary. The
 *   projection kernel in `projection.ts` never reads either, so replay is
 *   deterministic;
 * - `pid`/`pgid` are diagnostic observations. Stable identity is
 *   `(attemptId, backendType, runtimeHandle, workspaceId)`.
 *
 * The default driver is synchronous `better-sqlite3` with WAL and full fsync.
 * It is loaded lazily so importing this module (and the unit tests) works even
 * when the native package is not installed; open it only when it is available.
 * `node:sqlite` is intentionally not used: the baseline is Node 20.
 */
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import {
  FACT_LOG_FORMAT_VERSION,
  META_FACT_LOG_FORMAT,
  META_PROJECTION_FORMAT,
  META_PROJECTION_SEQ,
  PROJECTION_FORMAT_VERSION,
  STATE_STORE_SCHEMA_SQL,
  SequenceConflictError,
  StateStoreClosedError,
  StateStoreCorruptionError,
  StateStoreDriverUnavailableError,
  StateStoreValidationError,
  isAttemptDesiredState,
  isAttemptObservedState,
  isExecutionBackendType,
  toPersistedFact,
  validateAttemptId,
  validateEvidenceRef,
  validateStoredFact,
  type AppendFactInput,
  type AttemptRow,
  type EvidenceRef,
  type EvidenceRow,
  type PersistedFact,
  type StoredFact,
} from "./schema.js";
import {
  applyFact,
  cloneProjection,
  emptyProjection,
  evidenceRowsFromFact,
  projectionSnapshot,
  type ProjectionSnapshot,
  type ProjectionState,
} from "./projection.js";

export * from "./schema.js";
export {
  projectionSnapshot,
  replayFacts,
  emptyProjection,
} from "./projection.js";
export type {
  ProjectionSnapshot,
  ProjectionState,
} from "./projection.js";

const REBUILD_PAGE_SIZE = 256;
const DEFAULT_BUSY_TIMEOUT_MS = 5_000;
const MAX_BUSY_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_EVIDENCE_FILE_BYTES = 64 * 1024 * 1024;

/**
 * The synchronous seam every backend must implement. A driver owns durable
 * tables and transaction/rollback semantics; the StateStore kernel owns
 * validation, sequencing and projection logic.
 *
 * `transaction` must be atomic and synchronous. Implementations must serialize
 * writers so the sequence compare-and-swap inside the callback is meaningful.
 */
export interface StateStoreDriver {
  readonly kind: string;
  initialize(): void;
  transaction<T>(work: (tx: StateStoreTransaction) => T): T;
  close(): void;
}

/** Operations available only inside {@link StateStoreDriver.transaction}. */
export interface StateStoreTransaction {
  getMeta(key: string): string | undefined;
  setMeta(key: string, value: string): void;
  deleteMeta(key: string): void;
  /** Highest fact sequence currently durable; 0 for an empty log. */
  lastSeq(): number;
  readFacts(afterSeq: number, limit: number): PersistedFact[];
  appendFact(fact: PersistedFact): void;
  /** Drop every derived table and derived meta key; the fact log survives. */
  clearProjection(): void;
  readAttempts(): AttemptRow[];
  putAttempt(row: AttemptRow): void;
  readEvidence(): EvidenceRow[];
  putEvidence(row: EvidenceRow): void;
}

export interface AppendFactOptions {
  /**
   * Optimistic concurrency: the append succeeds only when the durable log is
   * still at this sequence. Omit for an unchecked append.
   */
  expectedSeq?: number;
  /** Boundary override; defaults to the store clock provider. */
  at?: string;
  /** Boundary override; defaults to the store event-id provider. */
  eventId?: string;
}

export interface StateStoreOptions {
  /**
   * Host boundary clock. The kernel never calls it; the caller (or this
   * default) supplies the timestamp for each append.
   */
  clock?: () => string;
  /**
   * Host boundary randomness. The kernel never calls it; every fact carries a
   * caller-supplied event id so replay needs no random source.
   */
  newEventId?: () => string;
}

/**
 * Synchronous event-sourced store. The caller owns the driver lifetime through
 * {@link StateStore.open}; `close` closes it.
 */
export class StateStore {
  private closed = false;

  private constructor(
    private readonly driver: StateStoreDriver,
    private projection: ProjectionState,
    private readonly clock: () => string,
    private readonly newEventId: () => string,
  ) {}

  /**
   * Open (or rebuild) the projection from the durable fact log. A projection
   * format change or a sequence-marker mismatch triggers a full replay.
   */
  static open(
    driver: StateStoreDriver,
    options: StateStoreOptions = {},
  ): StateStore {
    if (options.clock !== undefined && typeof options.clock !== "function") {
      throw new StateStoreValidationError(
        "clock must be a function",
        "options.clock",
      );
    }
    if (
      options.newEventId !== undefined &&
      typeof options.newEventId !== "function"
    ) {
      throw new StateStoreValidationError(
        "newEventId must be a function",
        "options.newEventId",
      );
    }
    driver.initialize();
    const clock = options.clock ?? defaultHostClock;
    const newEventId = options.newEventId ?? defaultHostEventId;
    const projection = driver.transaction((tx) => {
      ensureFactLogFormat(tx);
      return loadOrRebuildProjection(tx);
    });
    return new StateStore(driver, projection, clock, newEventId);
  }

  get lastSeq(): number {
    this.assertOpen();
    return this.projection.lastSeq;
  }

  /**
   * Append one fact and update the projection atomically. On any validation,
   * identity or sequence failure nothing is written and the cached projection
   * is unchanged.
   */
  append(
    input: AppendFactInput,
    options: AppendFactOptions = {},
  ): StoredFact {
    this.assertOpen();
    const expectedSeq = options.expectedSeq;
    if (
      expectedSeq !== undefined &&
      (!Number.isSafeInteger(expectedSeq) || expectedSeq < 0)
    ) {
      throw new StateStoreValidationError(
        "expectedSeq must be a non-negative safe integer",
        "options.expectedSeq",
      );
    }
    const at = options.at ?? this.clock();
    const eventId = options.eventId ?? this.newEventId();

    const draft = cloneProjection(this.projection);
    const touchedAttempts = new Set<string>();
    const touchedEvidence: EvidenceRow[] = [];
    let appended: StoredFact | undefined;

    this.driver.transaction((tx) => {
      const actualSeq = tx.lastSeq();
      if (expectedSeq !== undefined && expectedSeq !== actualSeq) {
        throw new SequenceConflictError(expectedSeq, actualSeq);
      }
      if (draft.lastSeq > actualSeq) {
        throw new StateStoreCorruptionError(
          `projection is at sequence ${draft.lastSeq} but the fact log is at ` +
            `${actualSeq}`,
          draft.lastSeq,
        );
      }

      // Another writer may have appended since this store's last transaction.
      // Catch the in-memory projection up inside the same transaction before
      // applying the new fact.
      while (draft.lastSeq < actualSeq) {
        const batch = tx.readFacts(draft.lastSeq, REBUILD_PAGE_SIZE);
        if (batch.length === 0) {
          throw new StateStoreCorruptionError(
            `fact log ended at ${draft.lastSeq} but advanced to ${actualSeq}`,
            draft.lastSeq,
          );
        }
        for (const raw of batch) {
          const caughtUp = validateStoredFact(raw);
          applyFact(draft, caughtUp);
          touchedAttempts.add(caughtUp.attemptId);
          touchedEvidence.push(...evidenceRowsFromFact(caughtUp));
        }
      }

      const fact = validateStoredFact({
        seq: actualSeq + 1,
        eventId,
        at,
        kind: input.kind,
        attemptId: input.attemptId,
        payload: input.payload,
      });
      applyFact(draft, fact);
      touchedAttempts.add(fact.attemptId);
      touchedEvidence.push(...evidenceRowsFromFact(fact));

      tx.appendFact(toPersistedFact(fact));
      for (const attemptId of touchedAttempts) {
        const row = draft.attempts.get(attemptId);
        if (row === undefined) {
          throw new StateStoreCorruptionError(
            `projection lost attempt ${attemptId} while appending`,
            fact.seq,
          );
        }
        tx.putAttempt(row);
      }
      for (const row of touchedEvidence) tx.putEvidence(row);
      tx.setMeta(META_PROJECTION_SEQ, String(fact.seq));
      appended = fact;
    });

    this.projection = draft;
    if (appended === undefined) {
      throw new StateStoreCorruptionError("append transaction produced no fact");
    }
    return appended;
  }

  /** Validated fact log, oldest first. */
  exportFacts(): StoredFact[] {
    this.assertOpen();
    return this.driver.transaction((tx) => {
      const facts: StoredFact[] = [];
      let after = 0;
      for (;;) {
        const batch = tx.readFacts(after, REBUILD_PAGE_SIZE);
        if (batch.length === 0) break;
        for (const raw of batch) {
          const fact = validateStoredFact(raw);
          if (fact.seq !== after + 1) {
            throw new StateStoreCorruptionError(
              `fact sequence ${fact.seq} is not contiguous after ${after}`,
              fact.seq,
            );
          }
          facts.push(fact);
          after = fact.seq;
        }
      }
      return facts;
    });
  }

  /** Discard the projection and replay the fact log, atomically. */
  rebuild(): void {
    this.assertOpen();
    const rebuilt = this.driver.transaction((tx) =>
      rebuildProjectionFromLog(tx),
    );
    this.projection = rebuilt;
  }

  snapshot(): ProjectionSnapshot {
    this.assertOpen();
    return projectionSnapshot(this.projection);
  }

  attempt(attemptId: string): AttemptRow | undefined {
    this.assertOpen();
    const row = this.projection.attempts.get(validateAttemptId(attemptId));
    return row === undefined ? undefined : copyAttemptRow(row);
  }

  evidence(attemptId: string): EvidenceRow[] {
    this.assertOpen();
    const bucket = this.projection.evidence.get(validateAttemptId(attemptId));
    if (bucket === undefined) return [];
    return [...bucket.values()]
      .sort((left, right) => compareStrings(left.contentHash, right.contentHash))
      .map((row) => ({ ...row }));
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.driver.close();
  }

  private assertOpen(): void {
    if (this.closed) throw new StateStoreClosedError();
  }
}

/**
 * Host-boundary defaults. The projection kernel never imports or calls these;
 * tests inject counters/fixed values for deterministic replay.
 */
function defaultHostClock(): string {
  return new Date().toISOString();
}

function defaultHostEventId(): string {
  return randomUUID();
}

function ensureFactLogFormat(tx: StateStoreTransaction): void {
  const stored = tx.getMeta(META_FACT_LOG_FORMAT);
  if (stored === undefined) {
    // A log with facts but no format marker did not come from this writer;
    // refuse it instead of guessing at its payload contract.
    if (tx.lastSeq() !== 0) {
      throw new StateStoreCorruptionError(
        "fact log contains facts but has no format marker",
      );
    }
    tx.setMeta(META_FACT_LOG_FORMAT, String(FACT_LOG_FORMAT_VERSION));
    return;
  }
  if (stored !== String(FACT_LOG_FORMAT_VERSION)) {
    throw new StateStoreCorruptionError(
      `unsupported fact log format ${stored}; expected ` +
        `${FACT_LOG_FORMAT_VERSION}`,
    );
  }
}

function loadOrRebuildProjection(
  tx: StateStoreTransaction,
): ProjectionState {
  const logSeq = tx.lastSeq();
  const storedFormat = tx.getMeta(META_PROJECTION_FORMAT);
  const storedSeqRaw = tx.getMeta(META_PROJECTION_SEQ);
  const storedSeq = storedSeqRaw === undefined ? null : Number(storedSeqRaw);
  if (
    storedFormat !== String(PROJECTION_FORMAT_VERSION) ||
    storedSeq === null ||
    !Number.isSafeInteger(storedSeq) ||
    storedSeq !== logSeq
  ) {
    return rebuildProjectionFromLog(tx);
  }

  const state = emptyProjection();
  state.lastSeq = logSeq;
  for (const row of tx.readAttempts()) {
    state.attempts.set(row.attemptId, row);
  }
  for (const row of tx.readEvidence()) {
    let bucket = state.evidence.get(row.attemptId);
    if (bucket === undefined) {
      bucket = new Map();
      state.evidence.set(row.attemptId, bucket);
    }
    bucket.set(row.contentHash, row);
  }
  return state;
}

/**
 * Rebuild every derived row from the fact log in one transaction. This is the
 * only repair path for projection format changes.
 */
function rebuildProjectionFromLog(
  tx: StateStoreTransaction,
): ProjectionState {
  tx.clearProjection();
  const state = emptyProjection();
  let after = 0;
  for (;;) {
    const batch = tx.readFacts(after, REBUILD_PAGE_SIZE);
    if (batch.length === 0) break;
    for (const raw of batch) {
      const fact = validateStoredFact(raw);
      applyFact(state, fact);
      after = fact.seq;
    }
  }

  const logSeq = tx.lastSeq();
  if (state.lastSeq !== logSeq) {
    throw new StateStoreCorruptionError(
      `projection replay ended at ${state.lastSeq} but the fact log is at ` +
        `${logSeq}`,
      state.lastSeq,
    );
  }

  for (const row of state.attempts.values()) tx.putAttempt(row);
  for (const bucket of state.evidence.values()) {
    for (const row of bucket.values()) tx.putEvidence(row);
  }
  tx.setMeta(META_PROJECTION_FORMAT, String(PROJECTION_FORMAT_VERSION));
  tx.setMeta(META_PROJECTION_SEQ, String(state.lastSeq));
  return state;
}

// ---------------------------------------------------------------------------
// Reference in-memory driver (tests, embedding, driver-swap conformance)
// ---------------------------------------------------------------------------

interface MemorySnapshot {
  meta: Map<string, string>;
  facts: Map<number, PersistedFact>;
  eventIds: Set<string>;
  attempts: Map<string, AttemptRow>;
  evidence: Map<string, EvidenceRow>;
}

/**
 * Deterministic reference driver backed by maps. It implements the same
 * driver contract as the SQLite driver; the unit tests run one conformance
 * suite against both to prove the kernel is backend-agnostic.
 */
export class MemoryStateStoreDriver implements StateStoreDriver {
  readonly kind = "memory";

  private readonly meta = new Map<string, string>();
  private readonly facts = new Map<number, PersistedFact>();
  private readonly eventIds = new Set<string>();
  private readonly attempts = new Map<string, AttemptRow>();
  private readonly evidence = new Map<string, EvidenceRow>();
  private open = true;
  private inTransaction = false;

  private readonly transactionApi: StateStoreTransaction = {
    getMeta: (key) => {
      this.assertOpen();
      return this.meta.get(key);
    },
    setMeta: (key, value) => {
      this.assertOpen();
      this.meta.set(key, value);
    },
    deleteMeta: (key) => {
      this.assertOpen();
      this.meta.delete(key);
    },
    lastSeq: () => {
      this.assertOpen();
      let max = 0;
      for (const seq of this.facts.keys()) {
        if (seq > max) max = seq;
      }
      return max;
    },
    readFacts: (afterSeq, limit) => {
      this.assertOpen();
      assertReadRange(afterSeq, limit);
      return [...this.facts.values()]
        .filter((fact) => fact.seq > afterSeq)
        .sort((left, right) => left.seq - right.seq)
        .slice(0, limit)
        .map((fact) => ({ ...fact }));
    },
    appendFact: (fact) => {
      this.assertOpen();
      if (this.facts.has(fact.seq)) {
        throw new StateStoreValidationError(
          `fact sequence ${fact.seq} already exists`,
          "fact.seq",
        );
      }
      if (this.eventIds.has(fact.eventId)) {
        throw new StateStoreValidationError(
          `event id ${fact.eventId} already exists`,
          "fact.eventId",
        );
      }
      this.facts.set(fact.seq, { ...fact });
      this.eventIds.add(fact.eventId);
    },
    clearProjection: () => {
      this.assertOpen();
      this.attempts.clear();
      this.evidence.clear();
      this.meta.delete(META_PROJECTION_FORMAT);
      this.meta.delete(META_PROJECTION_SEQ);
    },
    readAttempts: () => {
      this.assertOpen();
      return [...this.attempts.values()]
        .sort((left, right) => compareStrings(left.attemptId, right.attemptId))
        .map(copyAttemptRow);
    },
    putAttempt: (row) => {
      this.assertOpen();
      this.attempts.set(row.attemptId, copyAttemptRow(row));
    },
    readEvidence: () => {
      this.assertOpen();
      return [...this.evidence.values()]
        .sort(
          (left, right) =>
            compareStrings(left.attemptId, right.attemptId) ||
            compareStrings(left.contentHash, right.contentHash),
        )
        .map((row) => ({ ...row }));
    },
    putEvidence: (row) => {
      this.assertOpen();
      this.evidence.set(evidenceKey(row.attemptId, row.contentHash), {
        ...row,
      });
    },
  };

  initialize(): void {
    this.assertOpen();
  }

  transaction<T>(work: (tx: StateStoreTransaction) => T): T {
    this.assertOpen();
    if (this.inTransaction) {
      throw new StateStoreValidationError(
        "StateStore driver transactions cannot nest",
      );
    }
    const snapshot = this.capture();
    this.inTransaction = true;
    try {
      return work(this.transactionApi);
    } catch (error) {
      this.restore(snapshot);
      throw error;
    } finally {
      this.inTransaction = false;
    }
  }

  close(): void {
    this.open = false;
  }

  private assertOpen(): void {
    if (!this.open) throw new StateStoreClosedError();
  }

  private capture(): MemorySnapshot {
    const attempts = new Map<string, AttemptRow>();
    for (const [key, row] of this.attempts) attempts.set(key, copyAttemptRow(row));
    const evidence = new Map<string, EvidenceRow>();
    for (const [key, row] of this.evidence) evidence.set(key, { ...row });
    const facts = new Map<number, PersistedFact>();
    for (const [key, fact] of this.facts) facts.set(key, { ...fact });
    return {
      meta: new Map(this.meta),
      facts,
      eventIds: new Set(this.eventIds),
      attempts,
      evidence,
    };
  }

  private restore(snapshot: MemorySnapshot): void {
    this.meta.clear();
    for (const [key, value] of snapshot.meta) this.meta.set(key, value);
    this.facts.clear();
    for (const [key, fact] of snapshot.facts) this.facts.set(key, fact);
    this.eventIds.clear();
    for (const eventId of snapshot.eventIds) this.eventIds.add(eventId);
    this.attempts.clear();
    for (const [key, row] of snapshot.attempts) this.attempts.set(key, row);
    this.evidence.clear();
    for (const [key, row] of snapshot.evidence) this.evidence.set(key, row);
  }
}

export function createMemoryStateStoreDriver(): StateStoreDriver {
  return new MemoryStateStoreDriver();
}

// ---------------------------------------------------------------------------
// Default better-sqlite3 driver (synchronous, file-backed, WAL, full fsync)
// ---------------------------------------------------------------------------

interface BetterSqlite3Statement {
  all(...params: unknown[]): unknown[];
  get(...params: unknown[]): unknown;
  run(...params: unknown[]): unknown;
}

interface BetterSqlite3TransactionRunner<T> {
  (): T;
  immediate?: () => T;
}

interface BetterSqlite3Database {
  prepare(sql: string): BetterSqlite3Statement;
  exec(sql: string): void;
  pragma(source: string, options?: { simple?: boolean }): unknown;
  transaction<T>(work: () => T): BetterSqlite3TransactionRunner<T>;
  close(): void;
}

interface BetterSqlite3Constructor {
  new (path: string): BetterSqlite3Database;
}

const requireFromModule = createRequire(import.meta.url);
let cachedBetterSqlite3: BetterSqlite3Constructor | undefined;

function loadBetterSqlite3(): BetterSqlite3Constructor {
  if (cachedBetterSqlite3 !== undefined) return cachedBetterSqlite3;
  let loaded: unknown;
  try {
    loaded = requireFromModule("better-sqlite3");
  } catch (error) {
    throw new StateStoreDriverUnavailableError(
      "better-sqlite3 is not available; install it to use the default " +
        "file-backed StateStore driver. node:sqlite is intentionally not " +
        "used because the project baseline is Node 20." +
        (error instanceof Error ? ` (${error.message})` : ""),
    );
  }
  const candidate =
    typeof loaded === "function"
      ? loaded
      : (loaded as { default?: unknown }).default;
  if (typeof candidate !== "function") {
    throw new StateStoreDriverUnavailableError(
      "better-sqlite3 did not export a database constructor",
    );
  }
  cachedBetterSqlite3 = candidate as BetterSqlite3Constructor;
  return cachedBetterSqlite3;
}

export interface BetterSqlite3DriverOptions {
  /** Database file path, or `:memory:` for an ephemeral database. */
  path: string;
  /** SQLite busy timeout for multi-process writers; default 5000 ms. */
  busyTimeoutMs?: number;
}

export interface OpenFileStateStoreOptions extends StateStoreOptions {
  /** SQLite database file path. */
  path: string;
  busyTimeoutMs?: number;
}

/**
 * Default durable entry point: a better-sqlite3 file-backed StateStore. Other
 * backends remain available through {@link StateStore.open} and the
 * `StateStoreDriver` seam.
 */
export function openFileStateStore(
  options: OpenFileStateStoreOptions,
): StateStore {
  const driver = createBetterSqlite3Driver({
    path: options.path,
    busyTimeoutMs: options.busyTimeoutMs,
  });
  try {
    return StateStore.open(driver, {
      clock: options.clock,
      newEventId: options.newEventId,
    });
  } catch (error) {
    driver.close();
    throw error;
  }
}

interface FactSqlRow {
  seq: number;
  event_id: string;
  at: string;
  kind: string;
  attempt_id: string;
  payload: string;
}

interface AttemptSqlRow {
  attempt_id: string;
  backend_type: string;
  runtime_handle: string;
  workspace_id: string;
  desired_state: string;
  observed_state: string;
  lease_deadline: string | null;
  pid: number | null;
  pgid: number | null;
  updated_at: string;
  last_seq: number;
}

interface EvidenceSqlRow {
  attempt_id: string;
  content_hash: string;
  byte_length: number;
  media_type: string;
  path: string;
  recorded_at: string;
  seq: number;
}

/**
 * Default StateStore driver. Requires the optional native dependency
 * `better-sqlite3`; open fails with a typed error when it is missing rather
 * than silently changing durability or backend semantics.
 */
export function createBetterSqlite3Driver(
  options: BetterSqlite3DriverOptions,
): StateStoreDriver {
  if (typeof options.path !== "string" || options.path.length === 0) {
    throw new StateStoreValidationError(
      "driver path must be a non-empty string",
      "options.path",
    );
  }
  const busyTimeoutMs = options.busyTimeoutMs ?? DEFAULT_BUSY_TIMEOUT_MS;
  if (
    !Number.isInteger(busyTimeoutMs) ||
    busyTimeoutMs < 0 ||
    busyTimeoutMs > MAX_BUSY_TIMEOUT_MS
  ) {
    throw new StateStoreValidationError(
      `busyTimeoutMs must be an integer from 0 to ${MAX_BUSY_TIMEOUT_MS}`,
      "options.busyTimeoutMs",
    );
  }

  const Database = loadBetterSqlite3();
  const databasePath =
    options.path === ":memory:" ? options.path : resolve(options.path);
  // Fresh repos open `.cliyard/state.db` (and peer paths) before any other
  // writer has created the parent. Match the JsonFile fallback / supervisor
  // open paths: create the directory, never rely on a prior mkdir elsewhere.
  if (databasePath !== ":memory:") {
    mkdirSync(dirname(databasePath), { recursive: true, mode: 0o700 });
  }
  const db = new Database(databasePath);
  let initialized = false;
  let closed = false;
  let inTransaction = false;

  try {
    // WAL keeps readers independent of the single writer and FULL keeps the
    // append durable across process death. Refuse to run a file-backed store
    // with a weaker journal mode rather than silently changing durability.
    db.pragma("journal_mode = WAL");
    const journalMode = String(
      db.pragma("journal_mode", { simple: true }),
    ).toLowerCase();
    if (databasePath !== ":memory:" && journalMode !== "wal") {
      throw new StateStoreDriverUnavailableError(
        `SQLite refused WAL journal mode (got ${journalMode || "unknown"}); ` +
          "the file-backed StateStore driver requires WAL",
      );
    }
    db.pragma("synchronous = FULL");
    db.pragma("foreign_keys = ON");
    db.pragma(`busy_timeout = ${busyTimeoutMs}`);
  } catch (error) {
    db.close();
    throw error;
  }

  const transactionApi: StateStoreTransaction = {
    getMeta: (key) => {
      const row = db
        .prepare("SELECT value FROM state_meta WHERE key = ?")
        .get(key) as { value: string } | undefined;
      return row?.value;
    },
    setMeta: (key, value) => {
      db.prepare(
        "INSERT INTO state_meta (key, value) VALUES (?, ?) " +
          "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      ).run(key, value);
    },
    deleteMeta: (key) => {
      db.prepare("DELETE FROM state_meta WHERE key = ?").run(key);
    },
    lastSeq: () => {
      const row = db
        .prepare(
          "SELECT COALESCE(MAX(seq), 0) AS seq FROM state_facts",
        )
        .get() as { seq: number };
      return Number(row.seq);
    },
    readFacts: (afterSeq, limit) => {
      assertReadRange(afterSeq, limit);
      const rows = db
        .prepare(
          "SELECT seq, event_id, at, kind, attempt_id, payload " +
            "FROM state_facts WHERE seq > ? ORDER BY seq ASC LIMIT ?",
        )
        .all(afterSeq, limit) as FactSqlRow[];
      return rows.map(toPersistedFactRow);
    },
    appendFact: (fact) => {
      db.prepare(
        "INSERT INTO state_facts " +
          "(seq, event_id, at, kind, attempt_id, payload) " +
          "VALUES (?, ?, ?, ?, ?, ?)",
      ).run(
        fact.seq,
        fact.eventId,
        fact.at,
        fact.kind,
        fact.attemptId,
        JSON.stringify(fact.payload),
      );
    },
    clearProjection: () => {
      db.prepare("DELETE FROM state_evidence").run();
      db.prepare("DELETE FROM state_attempts").run();
      db.prepare(
        "DELETE FROM state_meta WHERE key IN (?, ?)",
      ).run(META_PROJECTION_FORMAT, META_PROJECTION_SEQ);
    },
    readAttempts: () => {
      const rows = db
        .prepare(
          "SELECT attempt_id, backend_type, runtime_handle, workspace_id, " +
            "desired_state, observed_state, lease_deadline, pid, pgid, " +
            "updated_at, last_seq FROM state_attempts ORDER BY attempt_id ASC",
        )
        .all() as AttemptSqlRow[];
      return rows.map(toAttemptRow);
    },
    putAttempt: (row) => {
      db.prepare(
        "INSERT INTO state_attempts " +
          "(attempt_id, backend_type, runtime_handle, workspace_id, " +
          "desired_state, observed_state, lease_deadline, pid, pgid, " +
          "updated_at, last_seq) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) " +
          "ON CONFLICT(attempt_id) DO UPDATE SET " +
          "backend_type = excluded.backend_type, " +
          "runtime_handle = excluded.runtime_handle, " +
          "workspace_id = excluded.workspace_id, " +
          "desired_state = excluded.desired_state, " +
          "observed_state = excluded.observed_state, " +
          "lease_deadline = excluded.lease_deadline, " +
          "pid = excluded.pid, pgid = excluded.pgid, " +
          "updated_at = excluded.updated_at, " +
          "last_seq = excluded.last_seq",
      ).run(
        row.attemptId,
        row.backendType,
        row.runtimeHandle,
        row.workspaceId,
        row.desiredState,
        row.observedState,
        row.leaseDeadline,
        row.diagnostics.pid,
        row.diagnostics.pgid,
        row.updatedAt,
        row.lastSeq,
      );
    },
    readEvidence: () => {
      const rows = db
        .prepare(
          "SELECT attempt_id, content_hash, byte_length, media_type, path, " +
            "recorded_at, seq FROM state_evidence " +
            "ORDER BY attempt_id ASC, content_hash ASC",
        )
        .all() as EvidenceSqlRow[];
      return rows.map((row) => ({
        attemptId: row.attempt_id,
        contentHash: row.content_hash,
        byteLength: Number(row.byte_length),
        mediaType: row.media_type,
        path: row.path,
        recordedAt: row.recorded_at,
        seq: Number(row.seq),
      }));
    },
    putEvidence: (row) => {
      db.prepare(
        "INSERT INTO state_evidence " +
          "(attempt_id, content_hash, byte_length, media_type, path, " +
          "recorded_at, seq) VALUES (?, ?, ?, ?, ?, ?, ?) " +
          "ON CONFLICT(attempt_id, content_hash) DO UPDATE SET " +
          "byte_length = excluded.byte_length, " +
          "media_type = excluded.media_type, " +
          "path = excluded.path, " +
          "recorded_at = excluded.recorded_at, " +
          "seq = excluded.seq",
      ).run(
        row.attemptId,
        row.contentHash,
        row.byteLength,
        row.mediaType,
        row.path,
        row.recordedAt,
        row.seq,
      );
    },
  };

  function assertDriverOpen(): void {
    if (closed) throw new StateStoreClosedError();
  }

  return {
    kind: "better-sqlite3",
    initialize: () => {
      assertDriverOpen();
      if (initialized) return;
      db.exec(STATE_STORE_SCHEMA_SQL);
      initialized = true;
    },
    transaction: <T>(work: (tx: StateStoreTransaction) => T): T => {
      assertDriverOpen();
      if (!initialized) {
        throw new StateStoreValidationError(
          "StateStoreDriver.initialize() must run before transaction()",
        );
      }
      if (inTransaction) {
        throw new StateStoreValidationError(
          "StateStore driver transactions cannot nest",
        );
      }
      inTransaction = true;
      try {
        const runner = db.transaction(() => work(transactionApi));
        // IMMEDIATE takes the write lock up front, so the sequence
        // compare-and-swap cannot race another connection.
        return runner.immediate === undefined ? runner() : runner.immediate();
      } finally {
        inTransaction = false;
      }
    },
    close: () => {
      if (closed) return;
      closed = true;
      db.close();
    },
  };
}

function toPersistedFactRow(row: FactSqlRow): PersistedFact {
  let payload: unknown;
  try {
    payload = JSON.parse(row.payload) as unknown;
  } catch {
    throw new StateStoreCorruptionError(
      `fact ${row.seq} has an unreadable JSON payload`,
      row.seq,
    );
  }
  return {
    seq: Number(row.seq),
    eventId: row.event_id,
    at: row.at,
    kind: row.kind,
    attemptId: row.attempt_id,
    payload,
  };
}

function toAttemptRow(row: AttemptSqlRow): AttemptRow {
  if (
    !isExecutionBackendType(row.backend_type) ||
    !isAttemptDesiredState(row.desired_state) ||
    !isAttemptObservedState(row.observed_state)
  ) {
    throw new StateStoreCorruptionError(
      `attempt ${row.attempt_id} has an invalid projected state`,
      Number(row.last_seq),
    );
  }
  return {
    attemptId: row.attempt_id,
    backendType: row.backend_type,
    runtimeHandle: row.runtime_handle,
    workspaceId: row.workspace_id,
    desiredState: row.desired_state,
    observedState: row.observed_state,
    leaseDeadline: row.lease_deadline,
    diagnostics: {
      pid: row.pid === null ? null : Number(row.pid),
      pgid: row.pgid === null ? null : Number(row.pgid),
    },
    updatedAt: row.updated_at,
    lastSeq: Number(row.last_seq),
  };
}

// ---------------------------------------------------------------------------
// Content-addressed evidence files
// ---------------------------------------------------------------------------

export interface FileEvidenceStoreOptions {
  directory: string;
  /** Per-object cap; large evidence still never enters the fact log. */
  maxBytes?: number;
}

/**
 * Stores evidence bytes by SHA-256 and returns a reference suitable for
 * `attempt.evidence-recorded`. Evidence payloads are immutable content-addressed
 * files; the fact log only ever carries the reference metadata.
 */
export class FileEvidenceStore {
  private readonly directory: string;
  private readonly maxBytes: number;

  constructor(options: FileEvidenceStoreOptions) {
    if (
      typeof options.directory !== "string" ||
      options.directory.length === 0
    ) {
      throw new StateStoreValidationError(
        "evidence directory must be a non-empty string",
        "options.directory",
      );
    }
    const maxBytes = options.maxBytes ?? DEFAULT_MAX_EVIDENCE_FILE_BYTES;
    if (
      !Number.isSafeInteger(maxBytes) ||
      maxBytes < 0 ||
      maxBytes > 1024 * 1024 * 1024 * 1024
    ) {
      throw new StateStoreValidationError(
        "maxBytes must be a non-negative safe integer",
        "options.maxBytes",
      );
    }
    this.directory = resolve(options.directory);
    this.maxBytes = maxBytes;
  }

  put(content: string | Uint8Array, mediaType: string): EvidenceRef {
    const bytes =
      typeof content === "string" ? Buffer.from(content, "utf8") : Buffer.from(content);
    if (bytes.byteLength > this.maxBytes) {
      throw new StateStoreValidationError(
        `evidence is ${bytes.byteLength} bytes; the configured limit is ` +
          `${this.maxBytes}`,
        "content",
      );
    }
    const contentHash = createHash("sha256").update(bytes).digest("hex");
    const ref: EvidenceRef = {
      contentHash,
      byteLength: bytes.byteLength,
      mediaType,
      path: `sha256/${contentHash}`,
    };
    validateEvidenceRef(ref);
    const target = this.resolveRefPath(ref.path);
    mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
    try {
      writeFileSync(target, bytes, { flag: "wx", mode: 0o600 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const existing = statSync(target);
      if (existing.size !== bytes.byteLength) {
        throw new StateStoreCorruptionError(
          `evidence object ${contentHash} exists with a different size`,
        );
      }
    }
    return ref;
  }

  read(ref: EvidenceRef): Buffer {
    const validated = validateEvidenceRef(ref);
    return readFileSync(this.resolveRefPath(validated.path));
  }

  private resolveRefPath(relativePath: string): string {
    const target = resolve(this.directory, relativePath);
    if (
      target !== this.directory &&
      !target.startsWith(`${this.directory}/`) &&
      !target.startsWith(`${this.directory}\\`)
    ) {
      throw new StateStoreValidationError(
        "evidence path escapes the evidence directory",
        "path",
      );
    }
    return target;
  }
}

function assertReadRange(afterSeq: number, limit: number): void {
  if (!Number.isSafeInteger(afterSeq) || afterSeq < 0) {
    throw new StateStoreValidationError(
      "afterSeq must be a non-negative safe integer",
      "afterSeq",
    );
  }
  if (!Number.isSafeInteger(limit) || limit < 1) {
    throw new StateStoreValidationError(
      "limit must be a positive safe integer",
      "limit",
    );
  }
}

function evidenceKey(attemptId: string, contentHash: string): string {
  return `${attemptId} ${contentHash}`;
}

function copyAttemptRow(row: AttemptRow): AttemptRow {
  return {
    ...row,
    diagnostics: { pid: row.diagnostics.pid, pgid: row.diagnostics.pgid },
  };
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

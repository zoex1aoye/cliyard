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
  readdirSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { hostname } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { parseCostTruth, parseFailureRecord } from "../failures.js";
import {
  MAX_TASK_EXTENSIONS,
  parseTaskExtensionRecord,
  type TaskExtensionRecord,
} from "../agents/continuation.js";
import {
  parseWorkerProcessRecord,
  type WorkerProcessRecord,
} from "../agents/process-tree.js";
import {
  ACTIVE_RUN_VERSION,
  MAX_PATH_AUDITS,
  MAX_PATH_AUDIT_ERROR_LENGTH,
  MAX_PATH_AUDIT_PATHS,
  MAX_PROCESS_TREES,
  MAX_WORKSPACE_BOUNDARY_CHANGES,
  MAX_WORKSPACE_BOUNDARY_ERROR_LENGTH,
  MAX_WORKSPACE_BOUNDARY_PATH_LENGTH,
  RUN_MANIFEST_VERSION,
  WORKSPACE_BOUNDARY_RECORD_VERSION,
  type ActiveRunPointer,
  type PathAuditRecord,
  type RunManifest,
  type RunOwner,
  type RunStatus,
  type RunTaskState,
  type SupervisorLockInfo,
  type WorkspaceBoundaryChangeRecord,
  type WorkspaceBoundaryRecord,
} from "./types.js";
import { normalizeEvidencePath } from "../agents/workspace-boundary.js";
import {
  isSandboxReport,
  type SandboxReport,
} from "../sandbox/types.js";
import {
  FileEvidenceStore,
  META_PROJECTION_FORMAT,
  META_PROJECTION_SEQ,
  StateStore,
  StateStoreClosedError,
  StateStoreCorruptionError,
  StateStoreDriverUnavailableError,
  createBetterSqlite3Driver,
  type AttemptRow,
  type EvidenceRow,
  type PersistedFact,
  type StateStoreDriver,
  type StateStoreTransaction,
} from "../statestore/store.js";
import {
  findCoveringMarker,
  migrateLegacyJson,
} from "../statestore/migrate.js";
import {
  StateStoreDomainWriter,
  StateStoreLegacyDriftError,
  canonicalStateStoreJson,
  projectStateStoreDomainRecords,
  readStateStoreDomainRecords,
  sha256Hex,
  type StateStoreLegacyGuard,
} from "../statestore/write.js";

export const SUPERVISOR_DIR = ".cliyard";
export const RUNS_DIR = "runs";
export const ACTIVE_RUN_FILE = "active.json";
export const SUPERVISOR_LOCK_FILE = "supervisor.lock";
/**
 * Canonical StateStore lives at `.cliyard/state.db` (shared with queue /
 * ledger / journal). Legacy `.cliyard/runtime/statestore/` is relocated once
 * by `resolveControlStatePaths` (design/statestore-path-unify-v0.md).
 * WorkspaceBoundary excludes `.cliyard` wholesale, so checkpoints do not
 * trip the guard.
 *
 * `STATE_DIR` / `STATE_SQLITE_FILE` remain the *legacy* path segments for
 * relocate detection and older imports; new opens go through
 * `supervisorStatePaths` → `resolveControlStatePaths`.
 */
export {
  LEGACY_SUPERVISOR_STATE_DIR as STATE_DIR,
  LEGACY_SUPERVISOR_SQLITE_FILE as STATE_SQLITE_FILE,
  LEGACY_SUPERVISOR_FACTS_FILE as STATE_FACTS_FILE,
  LEGACY_SUPERVISOR_EVIDENCE_DIR as STATE_EVIDENCE_DIR,
  LEGACY_SUPERVISOR_STATE_DIR,
  CONTROL_STATE_DB_FILE,
  CONTROL_STATE_EVIDENCE_DIR,
} from "../statestore/paths.js";
import {
  resolveControlStatePaths,
  type ControlStatePaths,
} from "../statestore/paths.js";

/**
 * Reserved active-pointer id stored in the append-only log when the active
 * run is cleared. It is not a legal run id (the colon is not allowed), so it
 * can never collide with a real run and is never written to `active.json`.
 */
export const CLEARED_ACTIVE_RUN_ID = "state:cleared";

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

export interface SupervisorStatePaths {
  repoRoot: string;
  /**
   * Directory that holds only StateStore durable files for this layout.
   * After path unify this is NOT the whole `.cliyard` tree: callers that
   * `rmSync(stateDir)` to drop the store must not wipe run JSON exports.
   * Implementation uses the fallback directory as the removable store root
   * plus explicit db/evidence paths on the sibling files — prefer
   * {@link clearSupervisorStateStoreFiles} for cleanup.
   */
  stateDir: string;
  /** SQLite authority when `better-sqlite3` is installed (`.cliyard/state.db`). */
  sqlitePath: string;
  /** Durable single-process fallback when the native driver is absent. */
  factsPath: string;
  evidenceDir: string;
}

/**
 * StateStore location for the supervisor run domain. Shared with queue /
 * ledger / journal at `.cliyard/state.db`. The legacy `.cliyard/runs/*.json`
 * files stay as the read-only JSON export; the append-only state log is the
 * write authority. Resolving paths may one-shot relocate a legacy
 * `runtime/statestore` authority.
 */
export function supervisorStatePaths(repoRoot: string): SupervisorStatePaths {
  const { paths } = resolveControlStatePaths(repoRoot);
  return toSupervisorStatePaths(paths);
}

function toSupervisorStatePaths(paths: ControlStatePaths): SupervisorStatePaths {
  return {
    repoRoot: paths.repoRoot,
    // Fallback dir is store-only; sqlite + evidence sit beside it under
    // `.cliyard`. Tests that only rmSync(stateDir) must also clear db/evidence
    // via clearSupervisorStateStoreFiles.
    stateDir: paths.fallbackDir,
    sqlitePath: paths.dbPath,
    factsPath: paths.fallbackFactsPath,
    evidenceDir: paths.evidenceDir,
  };
}

/** Remove canonical StateStore files without deleting `.cliyard/runs`. */
export function clearSupervisorStateStoreFiles(repoRoot: string): void {
  const { paths } = resolveControlStatePaths(repoRoot);
  for (const target of [
    paths.dbPath,
    paths.fallbackDir,
    paths.evidenceDir,
  ]) {
    try {
      rmSync(target, { recursive: true, force: true });
    } catch {
      /* best-effort test/cleanup helper */
    }
  }
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
// StateStore authority and read-only JSON export
// ---------------------------------------------------------------------------

/**
 * Migration imports the parsed legacy truth by calling the public loaders in
 * this module. Those loaders must read the legacy files directly while the
 * import is in flight; opening the store there would recurse into migration.
 * The bypass is synchronous because every store operation is synchronous.
 */
let legacyReadBypassDepth = 0;

function withLegacyReadBypass<T>(fn: () => T): T {
  legacyReadBypassDepth += 1;
  try {
    return fn();
  } finally {
    legacyReadBypassDepth -= 1;
  }
}

function isLegacyReadBypass(): boolean {
  return legacyReadBypassDepth > 0;
}

function supervisorStateExists(repoRoot: string): boolean {
  const paths = supervisorStatePaths(repoRoot);
  return existsSync(paths.sqlitePath) || existsSync(paths.factsPath);
}

interface SupervisorStateContext {
  root: string;
  paths: SupervisorStatePaths;
  backend: string;
  store: StateStore;
  evidence: FileEvidenceStore;
  writer: StateStoreDomainWriter;
}

/**
 * Durable single-process driver used when the optional `better-sqlite3`
 * native module is unavailable. It preserves the StateStore contract the
 * supervisor relies on (append-only facts, contiguous sequence, atomic
 * commit) in one atomically replaced JSON file. It does not add cross-process
 * writer locking; SQLite transactions remain the only multi-process claim.
 */
class JsonFileStateStoreDriver implements StateStoreDriver {
  readonly kind = "json-file";

  private readonly facts = new Map<number, PersistedFact>();
  private readonly eventIds = new Set<string>();
  private readonly meta = new Map<string, string>();
  private readonly attempts = new Map<string, AttemptRow>();
  private readonly evidence = new Map<string, EvidenceRow>();
  private last = 0;
  private initialized = false;
  private inTransaction = false;
  private dirty = false;
  private closed = false;

  constructor(private readonly filePath: string) {}

  initialize(): void {
    this.assertOpen();
    if (this.initialized) return;
    this.initialized = true;

    let raw: string;
    try {
      raw = readFileSync(this.filePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw new StateStoreCorruptionError(
        `cannot read StateStore facts ${this.filePath}: ${errorMessage(error)}`,
      );
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw) as unknown;
    } catch (error) {
      throw new StateStoreCorruptionError(
        `invalid JSON in StateStore facts ${this.filePath}: ` +
          errorMessage(error),
      );
    }
    if (
      !isRecord(parsed) ||
      parsed.version !== 1 ||
      !Array.isArray(parsed.facts)
    ) {
      throw new StateStoreCorruptionError(
        `StateStore facts ${this.filePath} must be { version: 1, facts: [] }`,
      );
    }

    if (parsed.meta !== undefined) {
      if (!isRecord(parsed.meta)) {
        throw new StateStoreCorruptionError(
          `StateStore facts ${this.filePath} contain invalid metadata`,
        );
      }
      for (const [key, value] of Object.entries(parsed.meta)) {
        if (typeof value !== "string") {
          throw new StateStoreCorruptionError(
            `StateStore facts ${this.filePath} contain invalid metadata ` +
              `for ${key}`,
          );
        }
        this.meta.set(key, value);
      }
    }

    for (const candidate of parsed.facts) {
      if (
        !isRecord(candidate) ||
        !Number.isSafeInteger(candidate.seq) ||
        (candidate.seq as number) < 1 ||
        typeof candidate.eventId !== "string" ||
        candidate.eventId.length === 0 ||
        typeof candidate.at !== "string" ||
        typeof candidate.kind !== "string" ||
        typeof candidate.attemptId !== "string" ||
        !("payload" in candidate)
      ) {
        throw new StateStoreCorruptionError(
          `StateStore facts ${this.filePath} contain an invalid record`,
        );
      }
      const fact = candidate as unknown as PersistedFact;
      if (this.facts.has(fact.seq)) {
        throw new StateStoreCorruptionError(
          `StateStore facts ${this.filePath} contain duplicate sequence ` +
            `${fact.seq}`,
          fact.seq,
        );
      }
      if (this.eventIds.has(fact.eventId)) {
        throw new StateStoreCorruptionError(
          `StateStore facts ${this.filePath} contain duplicate event id ` +
            `${fact.eventId}`,
          fact.seq,
        );
      }
      this.facts.set(fact.seq, { ...fact });
      this.eventIds.add(fact.eventId);
      if (fact.seq > this.last) this.last = fact.seq;
    }
    for (let seq = 1; seq <= this.last; seq += 1) {
      if (!this.facts.has(seq)) {
        throw new StateStoreCorruptionError(
          `StateStore facts ${this.filePath} are not contiguous at sequence ` +
            `${seq}`,
          seq,
        );
      }
    }
  }

  transaction<T>(work: (tx: StateStoreTransaction) => T): T {
    this.assertOpen();
    if (!this.initialized) {
      throw new StateStoreCorruptionError(
        "StateStoreDriver.initialize() must run before transaction()",
      );
    }
    if (this.inTransaction) {
      throw new StateStoreCorruptionError(
        "StateStore driver transactions cannot nest",
      );
    }
    const snapshot = this.capture();
    this.inTransaction = true;
    this.dirty = false;
    try {
      const result = work(this.transactionApi);
      if (this.dirty) this.persist();
      return result;
    } catch (error) {
      this.restore(snapshot);
      throw error;
    } finally {
      this.inTransaction = false;
      this.dirty = false;
    }
  }

  close(): void {
    this.closed = true;
  }

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
      return this.last;
    },
    readFacts: (afterSeq, limit) => {
      this.assertOpen();
      if (!Number.isSafeInteger(afterSeq) || afterSeq < 0) {
        throw new StateStoreCorruptionError(
          "afterSeq must be a non-negative safe integer",
        );
      }
      if (!Number.isSafeInteger(limit) || limit < 1) {
        throw new StateStoreCorruptionError(
          "limit must be a positive safe integer",
        );
      }
      return [...this.facts.values()]
        .filter((fact) => fact.seq > afterSeq)
        .sort((left, right) => left.seq - right.seq)
        .slice(0, limit)
        .map((fact) => ({ ...fact }));
    },
    appendFact: (fact) => {
      this.assertOpen();
      if (fact.seq !== this.last + 1) {
        throw new StateStoreCorruptionError(
          `StateStore fact sequence ${fact.seq} is not contiguous after ` +
            `${this.last}`,
          fact.seq,
        );
      }
      if (this.eventIds.has(fact.eventId)) {
        throw new StateStoreCorruptionError(
          `StateStore event id ${fact.eventId} already exists`,
          fact.seq,
        );
      }
      this.facts.set(fact.seq, { ...fact });
      this.eventIds.add(fact.eventId);
      this.last = fact.seq;
      this.dirty = true;
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
        .sort((left, right) =>
          left.attemptId < right.attemptId
            ? -1
            : left.attemptId > right.attemptId
              ? 1
              : 0,
        )
        .map((row) => ({ ...row }));
    },
    putAttempt: (row) => {
      this.assertOpen();
      this.attempts.set(row.attemptId, { ...row });
    },
    readEvidence: () => {
      this.assertOpen();
      return [...this.evidence.values()]
        .sort((left, right) =>
          left.attemptId < right.attemptId
            ? -1
            : left.attemptId > right.attemptId
              ? 1
              : left.contentHash < right.contentHash
                ? -1
                : left.contentHash > right.contentHash
                  ? 1
                  : 0,
        )
        .map((row) => ({ ...row }));
    },
    putEvidence: (row) => {
      this.assertOpen();
      this.evidence.set(`${row.attemptId} ${row.contentHash}`, { ...row });
    },
  };

  private assertOpen(): void {
    if (this.closed) throw new StateStoreClosedError();
  }

  private capture(): {
    facts: Map<number, PersistedFact>;
    eventIds: Set<string>;
    meta: Map<string, string>;
    attempts: Map<string, AttemptRow>;
    evidence: Map<string, EvidenceRow>;
    last: number;
  } {
    return {
      facts: new Map(
        [...this.facts].map(([seq, fact]) => [seq, { ...fact }]),
      ),
      eventIds: new Set(this.eventIds),
      meta: new Map(this.meta),
      attempts: new Map(
        [...this.attempts].map(([key, row]) => [key, { ...row }]),
      ),
      evidence: new Map(
        [...this.evidence].map(([key, row]) => [key, { ...row }]),
      ),
      last: this.last,
    };
  }

  private restore(snapshot: {
    facts: Map<number, PersistedFact>;
    eventIds: Set<string>;
    meta: Map<string, string>;
    attempts: Map<string, AttemptRow>;
    evidence: Map<string, EvidenceRow>;
    last: number;
  }): void {
    this.facts.clear();
    for (const [seq, fact] of snapshot.facts) this.facts.set(seq, fact);
    this.eventIds.clear();
    for (const eventId of snapshot.eventIds) this.eventIds.add(eventId);
    this.meta.clear();
    for (const [key, value] of snapshot.meta) this.meta.set(key, value);
    this.attempts.clear();
    for (const [key, row] of snapshot.attempts) this.attempts.set(key, row);
    this.evidence.clear();
    for (const [key, row] of snapshot.evidence) this.evidence.set(key, row);
    this.last = snapshot.last;
  }

  private persist(): void {
    // Derived projection rows are rebuilt from the fact log on every open.
    // Only the fact-log format metadata is durable; the projection markers
    // are deliberately omitted so a stale derived view can never be trusted.
    const meta: Record<string, string> = {};
    for (const [key, value] of this.meta) {
      if (key === META_PROJECTION_FORMAT || key === META_PROJECTION_SEQ) {
        continue;
      }
      meta[key] = value;
    }
    writeJsonAtomic(this.filePath, {
      version: 1,
      meta,
      facts: [...this.facts.values()].sort(
        (left, right) => left.seq - right.seq,
      ),
    });
  }
}

function createSupervisorStateDriver(
  paths: SupervisorStatePaths,
): StateStoreDriver {
  const hasSqlite = existsSync(paths.sqlitePath);
  const hasFallback = existsSync(paths.factsPath);
  if (hasSqlite && hasFallback) {
    throw new StateStoreCorruptionError(
      `both ${paths.sqlitePath} and ${paths.factsPath} exist; refusing to ` +
        "choose between two StateStore authorities (needs human)",
    );
  }
  if (hasSqlite) {
    return createBetterSqlite3Driver({ path: paths.sqlitePath });
  }
  if (hasFallback) {
    return new JsonFileStateStoreDriver(paths.factsPath);
  }
  try {
    return createBetterSqlite3Driver({ path: paths.sqlitePath });
  } catch (error) {
    if (error instanceof StateStoreDriverUnavailableError) {
      return new JsonFileStateStoreDriver(paths.factsPath);
    }
    throw error;
  }
}

function openSupervisorState(repoRoot: string): SupervisorStateContext {
  const root = resolve(repoRoot);
  const paths = supervisorStatePaths(root);
  mkdirSync(dirname(paths.sqlitePath), { recursive: true, mode: 0o700 });
  mkdirSync(paths.stateDir, { recursive: true, mode: 0o700 });
  mkdirSync(paths.evidenceDir, { recursive: true, mode: 0o700 });
  const driver = createSupervisorStateDriver(paths);
  let store: StateStore;
  try {
    store = StateStore.open(driver);
  } catch (error) {
    driver.close();
    throw error;
  }
  try {
    const evidence = new FileEvidenceStore({ directory: paths.evidenceDir });
    const writer = new StateStoreDomainWriter({ store, evidence });
    return {
      root,
      paths,
      backend: driver.kind,
      store,
      evidence,
      writer,
    };
  } catch (error) {
    store.close();
    throw error;
  }
}

/**
 * Run a write with the StateStore as the only authority.
 *
 * First use imports the existing `.cliyard/runs` directory exactly once; the
 * import hash is verified by the migration before any new fact is appended.
 * Afterwards every append is guarded by the read-only export comparison below.
 */
function withSupervisorStateWrite<T>(
  repoRoot: string,
  fn: (context: SupervisorStateContext) => T,
): T {
  const context = openSupervisorState(repoRoot);
  try {
    let marker = findCoveringMarker(
      readStateStoreDomainRecords(context),
      ["run"],
    );
    if (marker === undefined) {
      const imported = withLegacyReadBypass(() =>
        migrateLegacyJson({
          repoRoot: context.root,
          writer: context.writer,
          domains: ["run"],
        }),
      );
      const records = readStateStoreDomainRecords(context);
      marker = findCoveringMarker(records, ["run"]);
      if (marker === undefined) {
        throw new SupervisorStoreError(
          "StateStore run import did not become visible; refusing to write " +
            "(needs human)",
        );
      }
      if (
        imported.status === "imported" &&
        (marker.payload.importHash !== imported.importHash ||
          marker.payload.sourceHash !== imported.sourceHash)
      ) {
        throw new SupervisorStoreError(
          "StateStore run import did not verify its import hash; refusing " +
            "to write (needs human)",
        );
      }
    }
    context.writer.setLegacyGuard(createSupervisorExportGuard(context));
    return fn(context);
  } finally {
    context.store.close();
  }
}

/**
 * The JSON files under `.cliyard/runs` are a derived, read-only export. A
 * write is refused when an export no longer matches the StateStore record.
 * `updatedAt` is the control plane's checkpoint stamp and is allowed to move
 * independently (a live extension checkpoint may refresh it), but every
 * authority-bearing field must match. Missing exports are recoverable
 * projections and are rewritten on the next checkpoint; malformed, foreign or
 * conflicting exports fail closed with `needs_human`.
 */
function createSupervisorExportGuard(
  context: SupervisorStateContext,
): StateStoreLegacyGuard {
  return {
    domains: ["run"],
    assertUnchanged(): void {
      const projection = projectStateStoreDomainRecords(
        readStateStoreDomainRecords(context),
      );
      const storedRuns = new Map(
        projection.runs.map((manifest) => [manifest.runId, manifest]),
      );
      const diskRuns = new Map<string, RunManifest>();
      const problems: string[] = [];

      for (const runId of listRunManifestIds(context.root)) {
        const path = runManifestPath(context.root, runId);
        let disk: RunManifest;
        try {
          assertSafeRunId(runId);
          disk = readRunManifestFile(path, runId);
        } catch (error) {
          problems.push(
            `${runId}: unreadable export (${errorMessage(error)})`,
          );
          continue;
        }
        diskRuns.set(runId, disk);
        const stored = storedRuns.get(runId);
        if (stored === undefined) {
          problems.push(
            `${runId}: export exists without a StateStore record`,
          );
          continue;
        }
        if (!jsonEqualIgnoringUpdatedAt(stored, disk)) {
          problems.push(
            `${runId}: export differs from the StateStore record`,
          );
        }
      }

      let diskActive: ActiveRunPointer | undefined;
      try {
        diskActive = readActiveRunFile(context.root);
      } catch (error) {
        problems.push(`active: unreadable export (${errorMessage(error)})`);
      }
      const storedActive = projection.activeRun;
      const storedCleared =
        storedActive === null ||
        storedActive.runId === CLEARED_ACTIVE_RUN_ID;
      if (storedCleared) {
        if (existsSync(supervisorPaths(context.root).activePath)) {
          problems.push(
            "active: export exists without an active StateStore pointer",
          );
        }
      } else if (
        diskActive !== undefined &&
        !jsonEqualIgnoringUpdatedAt(storedActive, diskActive)
      ) {
        problems.push(
          "active: export differs from the StateStore pointer",
        );
      }

      if (problems.length === 0) return;
      const expectedSourceHash = sha256Hex(
        canonicalStateStoreJson(
          exportHashShape(projection.runs, projection.activeRun),
        ),
      );
      const actualSourceHash = sha256Hex(
        canonicalStateStoreJson(
          exportHashShape([...diskRuns.values()], diskActive ?? null),
        ),
      );
      throw new StateStoreLegacyDriftError({
        domains: ["run"],
        expectedSourceHash,
        actualSourceHash,
        repoRoot: context.root,
        detail:
          `supervisor export drift: ${problems.slice(0, 3).join("; ")}. ` +
          "Refusing the write so the StateStore stays the only authority " +
          "(needs human).",
      });
    },
  };
}

function exportHashShape(
  runs: readonly RunManifest[],
  activeRun: ActiveRunPointer | null,
): unknown {
  return {
    runs: [...runs]
      .sort((left, right) =>
        left.runId < right.runId ? -1 : left.runId > right.runId ? 1 : 0,
      )
      .map((manifest) => stripUpdatedAt(manifest)),
    activeRun:
      activeRun === null ? null : stripUpdatedAt(activeRun),
  };
}

function stripUpdatedAt(value: unknown): unknown {
  if (!isRecord(value)) return value;
  const clone: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (key !== "updatedAt") clone[key] = entry;
  }
  return clone;
}

function jsonEqualIgnoringUpdatedAt(left: unknown, right: unknown): boolean {
  return jsonEqualDeep(stripUpdatedAt(left), stripUpdatedAt(right));
}

function jsonEqualDeep(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right)) return false;
    if (left.length !== right.length) return false;
    return left.every((value, index) =>
      jsonEqualDeep(value, right[index]),
    );
  }
  if (isRecord(left) && isRecord(right)) {
    const leftKeys = Object.keys(left)
      .filter((key) => left[key] !== undefined)
      .sort();
    const rightKeys = Object.keys(right)
      .filter((key) => right[key] !== undefined)
      .sort();
    if (leftKeys.length !== rightKeys.length) return false;
    return leftKeys.every(
      (key, index) =>
        key === rightKeys[index] &&
        jsonEqualDeep(left[key], right[rightKeys[index]!]),
    );
  }
  return false;
}

function listRunManifestIds(repoRoot: string): string[] {
  const runsDir = supervisorPaths(repoRoot).runsDir;
  let names: string[];
  try {
    names = readdirSync(runsDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw new SupervisorStoreError(
      `cannot list run manifests under ${runsDir}: ${errorMessage(error)}`,
    );
  }
  return names
    .filter(
      (name) =>
        name.endsWith(".json") &&
        name !== ACTIVE_RUN_FILE &&
        !name.startsWith("."),
    )
    .map((name) => name.slice(0, -".json".length))
    .filter((runId) => runId.length > 0)
    .sort();
}

function readStoreRunProjection(
  repoRoot: string,
): ReturnType<typeof projectStateStoreDomainRecords> | undefined {
  if (!supervisorStateExists(repoRoot)) return undefined;
  const context = openSupervisorState(repoRoot);
  try {
    return projectStateStoreDomainRecords(
      readStateStoreDomainRecords(context),
    );
  } finally {
    context.store.close();
  }
}

export interface SupervisorStateInspection {
  backend: string;
  runs: RunManifest[];
  activeRun: ActiveRunPointer | null;
  migration: {
    importedAt: string;
    sourceHash: string;
    contentHash: string;
    importHash: string;
    importedRuns: number;
  } | null;
}

/**
 * Read-only diagnostic view of the supervisor StateStore projection. Returns
 * `undefined` when no StateStore exists yet (legacy-only repository).
 */
export function inspectSupervisorStateStore(
  repoRoot: string,
): SupervisorStateInspection | undefined {
  const root = resolve(repoRoot);
  if (!supervisorStateExists(root)) return undefined;
  const context = openSupervisorState(root);
  try {
    const records = readStateStoreDomainRecords(context);
    const projection = projectStateStoreDomainRecords(records);
    const marker = findCoveringMarker(records, ["run"]);
    return {
      backend: context.backend,
      runs: projection.runs.map((manifest) =>
        parseRunManifest(manifest, "StateStore run.manifest"),
      ),
      activeRun: projection.activeRun,
      migration:
        marker === undefined
          ? null
          : {
              importedAt: marker.payload.importedAt,
              sourceHash: marker.payload.sourceHash,
              contentHash: marker.payload.contentHash,
              importHash: marker.payload.importHash,
              importedRuns: marker.payload.counts.runs,
            },
    };
  } finally {
    context.store.close();
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
  if (!isLegacyReadBypass() && supervisorStateExists(root)) {
    const projection = readStoreRunProjection(root);
    if (projection?.runs.some((manifest) => manifest.runId === runId)) {
      throw new RunManifestError(`run manifest already exists: ${path}`);
    }
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

/**
 * Persist one checkpoint through the StateStore, then refresh the JSON
 * export at the legacy path. The export is derived and never read as truth
 * when the export is absent; all writes are refused on export drift.
 */
export function saveRunManifest(manifest: RunManifest): void {
  parseRunManifest(manifest, "RunManifest");
  withSupervisorStateWrite(manifest.repoRoot, (context) => {
    context.writer.appendRunManifest(manifest, {
      at: manifest.updatedAt,
    });
    writeJsonAtomic(
      runManifestPath(manifest.repoRoot, manifest.runId),
      manifest,
    );
  });
}

function readRunManifestFile(path: string, runId: string): RunManifest {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new RunNotFoundError(runId, path);
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
 * Load a manifest by id, or the active run when `runId` is omitted.
 *
 * The JSON export is read first for compatibility with tooling and with
 * legacy repositories that have no StateStore yet; when the export is absent
 * the StateStore projection is the authority. A malformed export fails
 * validation exactly as before instead of being silently replaced.
 */
export function loadRunManifest(
  repoRoot: string,
  runId?: string,
): RunManifest {
  const root = resolve(repoRoot);
  const id = runId ?? getActiveRunId(root);
  if (!id) throw new NoActiveRunError(root);

  const path = runManifestPath(root, id);
  if (
    !isLegacyReadBypass() &&
    !existsSync(path) &&
    supervisorStateExists(root)
  ) {
    const projection = readStoreRunProjection(root);
    const stored = projection?.runs.find(
      (manifest) => manifest.runId === id,
    );
    if (stored !== undefined) {
      return parseRunManifest(stored, `${path} (StateStore)`);
    }
  }
  return readRunManifestFile(path, id);
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
  assertSafeRunId(runId);
  const manifestPath = runManifestPath(root, runId);
  const diskManifestExists = existsSync(manifestPath);
  if (!diskManifestExists && !supervisorStateExists(root)) {
    throw new RunNotFoundError(runId, manifestPath);
  }
  const pointer: ActiveRunPointer = {
    version: ACTIVE_RUN_VERSION,
    runId,
    updatedAt: new Date().toISOString(),
  };
  withSupervisorStateWrite(root, (context) => {
    if (!diskManifestExists) {
      const projection = projectStateStoreDomainRecords(
        readStateStoreDomainRecords(context),
      );
      if (
        !projection.runs.some((manifest) => manifest.runId === runId)
      ) {
        throw new RunNotFoundError(runId, manifestPath);
      }
    }
    context.writer.appendActiveRun(pointer, { at: pointer.updatedAt });
    writeJsonAtomic(supervisorPaths(root).activePath, pointer);
  });
  return pointer;
}

/**
 * Remove the active pointer. When `runId` is given, the pointer is cleared
 * only if it still points at that run. The append-only state log records a
 * reserved tombstone so a fresh process does not resurrect a stale export.
 */
export function clearActiveRun(repoRoot: string, runId?: string): boolean {
  const root = resolve(repoRoot);
  const pointer = readActiveRun(root);
  if (!pointer) return false;
  if (runId !== undefined && pointer.runId !== runId) return false;
  withSupervisorStateWrite(root, (context) => {
    const tombstone: ActiveRunPointer = {
      version: ACTIVE_RUN_VERSION,
      runId: CLEARED_ACTIVE_RUN_ID,
      updatedAt: new Date().toISOString(),
    };
    context.writer.appendActiveRun(tombstone, { at: tombstone.updatedAt });
    try {
      unlinkSync(supervisorPaths(root).activePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  });
  return true;
}

function readActiveRun(root: string): ActiveRunPointer | undefined {
  if (isLegacyReadBypass() || !supervisorStateExists(root)) {
    return readActiveRunFile(root);
  }
  const projection = readStoreRunProjection(root);
  const stored = projection?.activeRun ?? null;
  if (stored !== null && stored.runId === CLEARED_ACTIVE_RUN_ID) {
    return undefined;
  }
  const disk = readActiveRunFile(root);
  if (disk !== undefined) return disk;
  return stored ?? undefined;
}

function readActiveRunFile(root: string): ActiveRunPointer | undefined {
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
    if (task.priorAttemptCost !== undefined) {
      const priorAttemptCost = parseCostTruth(task.priorAttemptCost);
      if (!priorAttemptCost) {
        throw new RunManifestError(
          `${source}: task ${key}.priorAttemptCost is not a valid cost record`,
        );
      }
      task.priorAttemptCost = priorAttemptCost;
    }
    if (task.pathAudits !== undefined) {
      task.pathAudits = parsePathAudits(
        task.pathAudits,
        `${source}: task ${key}.pathAudits`,
      );
    }
    if (task.extensions !== undefined) {
      task.extensions = parseTaskExtensions(
        task.extensions,
        `${source}: task ${key}.extensions`,
      );
    }
    if (task.processTrees !== undefined) {
      task.processTrees = parseProcessTrees(
        task.processTrees,
        `${source}: task ${key}.processTrees`,
      );
    }
    if (task.cleanupFailure !== undefined) {
      const cleanupFailure = parseFailureRecord(task.cleanupFailure);
      if (!cleanupFailure) {
        throw new RunManifestError(
          `${source}: task ${key}.cleanupFailure is not a valid failure record`,
        );
      }
      task.cleanupFailure = cleanupFailure;
    }
    // Workspace-boundary evidence is optional so older manifests stay
    // readable, but a present record must validate completely. Nothing is
    // repaired by guessing; a malformed record rejects the manifest.
    if (task.workspaceBoundary !== undefined) {
      task.workspaceBoundary = parseWorkspaceBoundaryRecord(
        task.workspaceBoundary,
        `${source}: task ${key}.workspaceBoundary`,
      );
    }
    // Sandbox reports are optional observational evidence. A present record
    // must validate; malformed bytes fail closed instead of being guessed.
    if (task.sandbox !== undefined) {
      task.sandbox = parseSandboxReport(
        task.sandbox,
        `${source}: task ${key}.sandbox`,
      );
    }
  }

  return raw as unknown as RunManifest;
}

function parseSandboxReport(raw: unknown, source: string): SandboxReport {
  if (!isSandboxReport(raw)) {
    throw new RunManifestError(
      `${source} is not a valid SandboxReport (observational; fail closed)`,
    );
  }
  return raw;
}

function parseWorkspaceBoundaryRecord(
  raw: unknown,
  source: string,
): WorkspaceBoundaryRecord {
  if (!isRecord(raw)) {
    throw new RunManifestError(`${source} must be an object`);
  }
  if (raw.version !== WORKSPACE_BOUNDARY_RECORD_VERSION) {
    throw new RunManifestError(
      `${source}.version must be ${WORKSPACE_BOUNDARY_RECORD_VERSION}`,
    );
  }
  if (
    raw.status !== "clean" &&
    raw.status !== "violation" &&
    raw.status !== "inspection_error"
  ) {
    throw new RunManifestError(
      `${source}.status must be clean, violation or inspection_error`,
    );
  }
  if (raw.enforcement !== "guard-only") {
    throw new RunManifestError(
      `${source}.enforcement must be "guard-only" (v1 detects; it never prevents)`,
    );
  }
  if (
    typeof raw.capturedAt !== "string" ||
    raw.capturedAt.length === 0 ||
    Number.isNaN(Date.parse(raw.capturedAt))
  ) {
    throw new RunManifestError(`${source}.capturedAt must be a timestamp`);
  }
  if (
    typeof raw.comparedAt !== "string" ||
    raw.comparedAt.length === 0 ||
    Number.isNaN(Date.parse(raw.comparedAt))
  ) {
    throw new RunManifestError(`${source}.comparedAt must be a timestamp`);
  }

  let error: string | undefined;
  if (raw.error !== undefined) {
    if (
      typeof raw.error !== "string" ||
      raw.error.length === 0 ||
      raw.error.length > MAX_WORKSPACE_BOUNDARY_ERROR_LENGTH
    ) {
      throw new RunManifestError(
        `${source}.error must be a non-empty string of at most ` +
          `${MAX_WORKSPACE_BOUNDARY_ERROR_LENGTH} characters`,
      );
    }
    error = raw.error;
  }

  return {
    version: WORKSPACE_BOUNDARY_RECORD_VERSION,
    status: raw.status,
    enforcement: "guard-only",
    capturedAt: raw.capturedAt,
    comparedAt: raw.comparedAt,
    changes: parseWorkspaceBoundaryChanges(raw.changes, `${source}.changes`),
    ...(error !== undefined ? { error } : {}),
  };
}

function parseWorkspaceBoundaryChanges(
  raw: unknown,
  source: string,
): WorkspaceBoundaryChangeRecord[] {
  if (!Array.isArray(raw)) {
    throw new RunManifestError(`${source} must be an array`);
  }
  if (raw.length > MAX_WORKSPACE_BOUNDARY_CHANGES) {
    throw new RunManifestError(
      `${source} must contain at most ${MAX_WORKSPACE_BOUNDARY_CHANGES} records`,
    );
  }

  const DIGEST_PATTERN = /^[0-9a-f]{64}$/;
  return raw.map((value, index) => {
    const path = `${source}[${index}]`;
    if (!isRecord(value)) {
      throw new RunManifestError(`${path} must be an object`);
    }
    if (!Number.isInteger(value.rootIndex) || (value.rootIndex as number) < 0) {
      throw new RunManifestError(
        `${path}.rootIndex must be a non-negative integer`,
      );
    }
    if (
      value.change !== "added" &&
      value.change !== "removed" &&
      value.change !== "modified"
    ) {
      throw new RunManifestError(
        `${path}.change must be added, removed or modified`,
      );
    }
    if (
      value.kind !== "file" &&
      value.kind !== "symlink" &&
      value.kind !== "directory"
    ) {
      throw new RunManifestError(
        `${path}.kind must be file, symlink or directory`,
      );
    }
    if (
      typeof value.path !== "string" ||
      value.path.length === 0 ||
      value.path.length > MAX_WORKSPACE_BOUNDARY_PATH_LENGTH ||
      normalizeEvidencePath(value.path) !== value.path
    ) {
      throw new RunManifestError(
        `${path}.path must be a bounded, safe root-relative evidence path`,
      );
    }

    const change: WorkspaceBoundaryChangeRecord = {
      rootIndex: value.rootIndex as number,
      change: value.change,
      kind: value.kind,
      path: value.path,
    };
    if (value.beforeDigest !== undefined) {
      if (
        typeof value.beforeDigest !== "string" ||
        !DIGEST_PATTERN.test(value.beforeDigest)
      ) {
        throw new RunManifestError(
          `${path}.beforeDigest must be a SHA-256 hex digest`,
        );
      }
      change.beforeDigest = value.beforeDigest;
    }
    if (value.afterDigest !== undefined) {
      if (
        typeof value.afterDigest !== "string" ||
        !DIGEST_PATTERN.test(value.afterDigest)
      ) {
        throw new RunManifestError(
          `${path}.afterDigest must be a SHA-256 hex digest`,
        );
      }
      change.afterDigest = value.afterDigest;
    }
    return change;
  });
}

function parseTaskExtensions(
  raw: unknown,
  source: string,
): TaskExtensionRecord[] {
  if (!Array.isArray(raw)) {
    throw new RunManifestError(`${source} must be an array`);
  }
  if (raw.length > MAX_TASK_EXTENSIONS) {
    throw new RunManifestError(
      `${source} must contain at most ${MAX_TASK_EXTENSIONS} records`,
    );
  }

  const seen = new Set<string>();
  const continuationIndexes = new Set<string>();
  return raw.map((value, index) => {
    const path = `${source}[${index}]`;
    const extension = parseTaskExtensionRecord(value);
    if (!extension) {
      const label =
        isRecord(value) && value.kind === "budget-continuation"
          ? "budget continuation"
          : isRecord(value) && value.kind === "deadline"
            ? "deadline"
            : "task";
      throw new RunManifestError(
        `${path} is not a valid ${label} extension record`,
      );
    }
    if (seen.has(extension.extensionId)) {
      throw new RunManifestError(
        `${path}.extensionId duplicates ${extension.extensionId}`,
      );
    }
    seen.add(extension.extensionId);
    if (extension.kind === "budget-continuation") {
      const key = `${extension.attempt}:${extension.continuationIndex}`;
      if (continuationIndexes.has(key)) {
        throw new RunManifestError(
          `${path}.continuationIndex duplicates budget continuation ` +
            `${extension.continuationIndex} for attempt ${extension.attempt}`,
        );
      }
      continuationIndexes.add(key);
    }
    return extension;
  });
}

/**
 * Process-tree records are fail-closed: one malformed record rejects the
 * manifest rather than silently hiding an unproven cleanup.
 */
function parseProcessTrees(
  raw: unknown,
  source: string,
): WorkerProcessRecord[] {
  if (!Array.isArray(raw)) {
    throw new RunManifestError(`${source} must be an array`);
  }
  if (raw.length > MAX_PROCESS_TREES) {
    throw new RunManifestError(
      `${source} must contain at most ${MAX_PROCESS_TREES} records`,
    );
  }
  return raw.map((value, index) => {
    const record = parseWorkerProcessRecord(value);
    if (!record) {
      throw new RunManifestError(
        `${source}[${index}] is not a valid worker process-tree record`,
      );
    }
    return record;
  });
}

function parsePathAudits(raw: unknown, source: string): PathAuditRecord[] {
  if (!Array.isArray(raw)) {
    throw new RunManifestError(`${source} must be an array`);
  }
  if (raw.length > MAX_PATH_AUDITS) {
    throw new RunManifestError(
      `${source} must contain at most ${MAX_PATH_AUDITS} records`,
    );
  }

  return raw.map((value, index) => {
    const path = `${source}[${index}]`;
    if (!isRecord(value)) {
      throw new RunManifestError(`${path} must be an object`);
    }
    if (!Number.isInteger(value.attempt) || (value.attempt as number) < 0) {
      throw new RunManifestError(
        `${path}.attempt must be a non-negative integer`,
      );
    }
    if (
      typeof value.observedAt !== "string" ||
      value.observedAt.length === 0 ||
      Number.isNaN(Date.parse(value.observedAt))
    ) {
      throw new RunManifestError(`${path}.observedAt must be a timestamp`);
    }
    if (!Number.isInteger(value.exitCode)) {
      throw new RunManifestError(`${path}.exitCode must be an integer`);
    }

    const changedPaths = parsePathEvidence(
      value.changedPaths,
      `${path}.changedPaths`,
    );
    const outsideWritePaths = parsePathEvidence(
      value.outsideWritePaths,
      `${path}.outsideWritePaths`,
    );

    let changedPathsError: string | undefined;
    if (value.changedPathsError !== undefined) {
      if (
        typeof value.changedPathsError !== "string" ||
        value.changedPathsError.length === 0 ||
        value.changedPathsError.length > MAX_PATH_AUDIT_ERROR_LENGTH
      ) {
        throw new RunManifestError(
          `${path}.changedPathsError must be a non-empty string of at most ` +
            `${MAX_PATH_AUDIT_ERROR_LENGTH} characters`,
        );
      }
      changedPathsError = value.changedPathsError;
    }

    return {
      attempt: value.attempt as number,
      observedAt: value.observedAt,
      exitCode: value.exitCode as number,
      changedPaths,
      outsideWritePaths,
      ...(changedPathsError !== undefined ? { changedPathsError } : {}),
    };
  });
}

function parsePathEvidence(raw: unknown, source: string): string[] {
  if (!Array.isArray(raw)) {
    throw new RunManifestError(`${source} must be an array`);
  }
  if (raw.length > MAX_PATH_AUDIT_PATHS) {
    throw new RunManifestError(
      `${source} must contain at most ${MAX_PATH_AUDIT_PATHS} paths`,
    );
  }
  return raw.map((value, index) => {
    if (
      typeof value !== "string" ||
      value.length === 0 ||
      value.includes("\0")
    ) {
      throw new RunManifestError(
        `${source}[${index}] must be a non-empty path string`,
      );
    }
    return value;
  });
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

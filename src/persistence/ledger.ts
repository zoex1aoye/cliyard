import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, join, relative, resolve, sep } from "node:path";
import type { TaskStatus } from "../core/status.js";
import type { TaskContract } from "../contracts/schema.js";
import {
  parseCostTruth,
  parseFailureRecord,
  type CostTruth,
  type FailureRecord,
} from "../failures.js";
import type { StateStore } from "../statestore/store.js";
import {
  StateStoreDomainWriter,
  StateStoreWriteValidationError,
  projectStateStoreDomainRecords,
  readStateStoreDomainRecords,
  type LegacySourceDomain,
  type StateStoreDomainEvidenceStore,
} from "../statestore/write.js";
import {
  createLegacyJsonGuard,
  findCoveringMarker,
  migrateLegacyJson,
  type LegacyMigrationResult,
} from "../statestore/migrate.js";

export interface LedgerEvent {
  at: string;
  type: string;
  status?: TaskStatus;
  detail?: string;
}

export interface LedgerTaskRecord {
  taskId: string;
  status: TaskStatus;
  repairCount: number;
  contract: TaskContract;
  events: LedgerEvent[];
  sessionIds: string[];
  lastVerifyLog?: string;
  verdict?: "accepted" | "rejected";
  reason?: string;
  /**
   * Structured failure observation for a rejected task. Absent on accepted
   * tasks and on records written before the failure taxonomy.
   */
  failure?: FailureRecord;
  /**
   * Aggregated cost truth for every worker session this task started,
   * including repairs. CLI estimates remain non-authoritative.
   */
  cost?: CostTruth;
}

export interface Ledger {
  path: string;
  tasks: Record<string, LedgerTaskRecord>;
}

export function defaultLedgerPath(cwd = process.cwd()): string {
  return join(cwd, ".cliyard", "ledger.json");
}

// ---------------------------------------------------------------------------
// Single-writer cutover to the StateStore write API
// ---------------------------------------------------------------------------

/** Import scope owned by this module (design/statestore-write-migration-v0.md). */
const LEDGER_SOURCE_DOMAINS: readonly LegacySourceDomain[] = ["ledger"];

/**
 * Explicit cutover binding. Installing one makes the StateStore fact log the
 * only ledger write authority for this ledger path: the legacy JSON file is
 * imported once, hashed and verified, then left untouched forever after.
 *
 * Activation is explicit because opening a durable StateStore needs a driver
 * and a content-addressed evidence store owned by the caller. The JSON path
 * remains the fallback only while no binding is installed, so a process never
 * writes both authorities.
 */
export interface LedgerStateStoreBindingOptions {
  repoRoot: string;
  store: StateStore;
  evidence: StateStoreDomainEvidenceStore;
  /** Fact/evidence timestamp boundary; defaults to the host clock. */
  clock?: () => string;
  /** Fact event-id boundary; defaults to the StateStore provider. */
  newEventId?: () => string;
  /** Import marker timestamp; defaults to the host clock. */
  importedAt?: string;
}

export interface LedgerStateStoreBinding {
  repoRoot: string;
  ledgerPath: string;
  /** Repo-relative POSIX path stored inside the ledger document. */
  relativePath: string;
  store: StateStore;
  evidence: StateStoreDomainEvidenceStore;
  writer: StateStoreDomainWriter;
  clock: () => string;
  /**
   * `null` when a covering import marker already existed and the one-shot
   * migration was therefore skipped.
   */
  migration: LegacyMigrationResult | null;
}

const ledgerStateStores = new Map<string, LedgerStateStoreBinding>();

function ledgerBinding(path: string): LedgerStateStoreBinding | undefined {
  return ledgerStateStores.get(resolve(path));
}

/**
 * Cut the ledger write path over to SQLite.
 *
 * - the existing `ledger.json` is imported once and its source/content/import
 *   hashes are verified by `migrateLegacyJson`; a covering marker makes the
 *   import idempotent across processes;
 * - a fail-closed drift guard is installed before the binding is registered,
 *   so a later write refuses to pick a winner if the legacy bytes change;
 * - from then on `saveLedger` appends a `ledger.document` fact and never
 *   writes the JSON file.
 */
export function attachLedgerStateStore(
  options: LedgerStateStoreBindingOptions,
): LedgerStateStoreBinding {
  if (
    typeof options !== "object" ||
    options === null ||
    options.store === undefined ||
    options.evidence === undefined
  ) {
    throw new StateStoreWriteValidationError(
      "ledger cutover requires a store and an evidence store",
      "options",
    );
  }
  if (typeof options.repoRoot !== "string" || options.repoRoot.length === 0) {
    throw new StateStoreWriteValidationError(
      "ledger cutover requires repoRoot",
      "options.repoRoot",
    );
  }
  const repoRoot = resolve(options.repoRoot);
  const ledgerPath = defaultLedgerPath(repoRoot);
  const key = resolve(ledgerPath);
  if (ledgerStateStores.has(key)) {
    throw new StateStoreWriteValidationError(
      `ledger ${ledgerPath} is already attached to a StateStore; detach it ` +
        "before installing another binding",
      "ledgerPath",
    );
  }

  const clock = options.clock ?? (() => new Date().toISOString());
  const writer = new StateStoreDomainWriter({
    store: options.store,
    evidence: options.evidence,
    clock,
    newEventId: options.newEventId,
  });

  // A covering marker means the one-shot import already happened. Re-running
  // the migration would re-verify the old snapshot against newer appended
  // ledger revisions and fail, so it is only run when no marker exists.
  const before = readStateStoreDomainRecords({
    store: options.store,
    evidence: options.evidence,
  });
  const migration =
    findCoveringMarker(before, LEDGER_SOURCE_DOMAINS) === undefined
      ? migrateLegacyJson({
          repoRoot,
          writer,
          domains: LEDGER_SOURCE_DOMAINS,
          at: options.importedAt ?? clock(),
        })
      : null;

  const guard = createLegacyJsonGuard({
    repoRoot,
    writer,
    domains: LEDGER_SOURCE_DOMAINS,
  });
  // Fail closed before accepting any write: missing marker or drifted bytes.
  guard.assertUnchanged();
  writer.setLegacyGuard(guard);

  const binding: LedgerStateStoreBinding = {
    repoRoot,
    ledgerPath,
    relativePath: relative(repoRoot, ledgerPath).split(sep).join("/"),
    store: options.store,
    evidence: options.evidence,
    writer,
    clock,
    migration,
  };
  ledgerStateStores.set(key, binding);
  return binding;
}

/** Remove the cutover binding (tests and explicit rollback to the JSON path). */
export function detachLedgerStateStore(
  ledgerPath: string = defaultLedgerPath(),
): void {
  ledgerStateStores.delete(resolve(ledgerPath));
}

/** True when this process already installed a ledger cutover for `ledgerPath`. */
export function isLedgerStateStoreAttached(
  ledgerPath: string = defaultLedgerPath(),
): boolean {
  return ledgerStateStores.has(resolve(ledgerPath));
}

function readLedgerFromStateStore(
  binding: LedgerStateStoreBinding,
  path: string,
): Ledger {
  // Catch the in-memory projection up with facts other processes appended.
  // Ledger updates are read-modify-write, so a stale projection would lose an
  // acknowledged revision.
  binding.store.rebuild();
  const records = readStateStoreDomainRecords({
    store: binding.store,
    evidence: binding.evidence,
  });
  const projected = projectStateStoreDomainRecords(records).ledger;
  if (projected === null) {
    throw new Error(
      `StateStore has no ledger document for ${path}; the cutover binding ` +
        "is inconsistent (fail closed)",
    );
  }
  return { path, tasks: projected.tasks };
}

export function loadLedger(path: string): Ledger {
  const binding = ledgerBinding(path);
  if (binding !== undefined) {
    return readLedgerFromStateStore(binding, path);
  }
  if (!existsSync(path)) {
    return { path, tasks: {} };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
  } catch (error) {
    throw new Error(
      `invalid JSON in ledger ${path}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  return parseLedger(raw, path);
}

/**
 * Ledger records written before the failure taxonomy have neither optional
 * field and stay readable. When either field is present it must be valid:
 * a malformed structured record fails closed instead of being guessed at.
 */
function parseLedger(raw: unknown, path: string): Ledger {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error(`invalid ledger ${path}: root must be an object`);
  }
  const record = raw as Record<string, unknown>;
  const rawTasks = record.tasks ?? {};
  if (typeof rawTasks !== "object" || rawTasks === null || Array.isArray(rawTasks)) {
    throw new Error(`invalid ledger ${path}: tasks must be an object`);
  }

  const tasks: Record<string, LedgerTaskRecord> = {};
  for (const [taskId, value] of Object.entries(rawTasks)) {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new Error(
        `invalid ledger ${path}: task ${taskId} must be an object`,
      );
    }
    const task = value as Record<string, unknown>;
    if (task.failure !== undefined) {
      const failure = parseFailureRecord(task.failure);
      if (!failure) {
        throw new Error(
          `invalid ledger ${path}: task ${taskId}.failure is not a valid ` +
            "failure record",
        );
      }
      task.failure = failure;
    }
    if (task.cost !== undefined) {
      const cost = parseCostTruth(task.cost);
      if (!cost) {
        throw new Error(
          `invalid ledger ${path}: task ${taskId}.cost is not a valid cost ` +
            "record",
        );
      }
      task.cost = cost;
    }
    tasks[taskId] = task as unknown as LedgerTaskRecord;
  }
  return { path, tasks };
}

export function saveLedger(ledger: Ledger): void {
  const binding = ledgerBinding(ledger.path);
  if (binding !== undefined) {
    // SQLite is the only write authority after the cutover. The legacy JSON
    // file stays exactly as imported: writing it too would create a second
    // authority and hide drift.
    binding.writer.appendLedger(
      { path: binding.relativePath, tasks: ledger.tasks },
      { at: binding.clock() },
    );
    return;
  }
  mkdirSync(dirname(ledger.path), { recursive: true });
  writeFileSync(
    ledger.path,
    JSON.stringify({ path: ledger.path, tasks: ledger.tasks }, null, 2) + "\n",
    "utf8",
  );
}

/** Serialize load-modify-save for one ledger path (parallel closed loops). */
const ledgerGates = new Map<string, Promise<unknown>>();
const LOCK_WAIT_MS = 10_000;
const STALE_LOCK_MS = 5 * 60_000;

export async function withLedgerLock<T>(
  path: string,
  fn: () => T | Promise<T>,
): Promise<T> {
  const prev = ledgerGates.get(path) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  const next = prev.then(() => gate);
  ledgerGates.set(path, next);
  await prev;
  let releaseFile: (() => void) | undefined;
  try {
    releaseFile = await acquireFileLock(path);
    return await fn();
  } finally {
    releaseFile?.();
    release();
    if (ledgerGates.get(path) === next) {
      ledgerGates.delete(path);
    }
  }
}

/** Load ledger, apply mutator, save — under lock. Returns mutator result. */
export async function updateLedger<T>(
  path: string,
  mutator: (ledger: Ledger) => T,
): Promise<T> {
  // Production cutover: when the path is `<repo>/.cliyard/ledger.json`, attach
  // ledger (+ journal) before the first write so saveLedger uses StateStore
  // facts instead of rewriting ledger.json. Non-repo fixture paths keep the
  // legacy JSON writer. Lazy import avoids a static cycle through migrate.
  try {
    const { ensureLedgerJournalCutoverSync, repoRootFromLedgerPath } =
      await import("../orchestration/control-domain-cutover.js");
    ensureLedgerJournalCutoverSync(repoRootFromLedgerPath(path));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!message.includes("cannot derive repoRoot from ledger path")) {
      throw error;
    }
  }
  return withLedgerLock(path, () => {
    const ledger = loadLedger(path);
    const out = mutator(ledger);
    saveLedger(ledger);
    return out;
  });
}

async function acquireFileLock(path: string): Promise<() => void> {
  const lockPath = `${path}.lock`;
  mkdirSync(dirname(path), { recursive: true });
  const token = `${process.pid}-${randomUUID()}`;
  const deadline = Date.now() + LOCK_WAIT_MS;

  while (true) {
    try {
      const fd = openSync(lockPath, "wx");
      writeFileSync(fd, `${token}\n`, "utf8");
      closeSync(fd);
      return () => {
        try {
          const current = readFileSync(lockPath, "utf8").trim();
          if (current === token) unlinkSync(lockPath);
        } catch {
          /* already released or replaced */
        }
      };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") throw error;
      try {
        const age = Date.now() - statSync(lockPath).mtimeMs;
        if (age > STALE_LOCK_MS) {
          unlinkSync(lockPath);
          continue;
        }
      } catch {
        continue;
      }
      if (Date.now() >= deadline) {
        throw new Error(`timed out waiting for ledger lock: ${lockPath}`);
      }
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
    }
  }
}

export function appendEvent(
  record: LedgerTaskRecord,
  type: string,
  detail?: string,
): void {
  record.events.push({
    at: new Date().toISOString(),
    type,
    status: record.status,
    detail,
  });
}

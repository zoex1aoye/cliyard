/**
 * StateStore v0 read path (design/statestore-v0.md).
 *
 * JSON files remain the write authority in P1. This module only reads them,
 * seeds a fresh StateStore fact log in memory, and reconstructs the read model
 * from that log. Nothing here writes `queue.json`, `runs/*.json` or
 * `ledger.json`, opens a daemon, or serves HTTP.
 *
 * Seeding is deterministic: every record receives a content-addressed evidence
 * reference, a timestamp copied from the source data and an event id derived
 * from the record identity. A fresh process against unchanged JSON truth
 * therefore rebuilds the same fact log and the same read view.
 *
 * Parity gate: status output is the existing `ControlSnapshot` value carried
 * through the projection. Verification compares it to the control snapshot
 * semantically (canonicalized deep-equal with an explicit float tolerance).
 * Byte-identical comparison exists only as a diagnostic and never decides
 * acceptance.
 */
import { createHash } from "node:crypto";
import { existsSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  buildControlSnapshot,
  type ControlSnapshot,
} from "../orchestration/control-snapshot.js";
import {
  type QueueControlEvent,
  type QueueEventJournalSummary,
} from "../orchestration/event-journal.js";
import {
  loadQueue,
  type QueueDocument,
} from "../orchestration/queue-store.js";
import {
  defaultLedgerPath,
  loadLedger,
  type Ledger,
  type LedgerEvent,
  type LedgerTaskRecord,
} from "../persistence/ledger.js";
import {
  loadRunManifest,
  supervisorPaths,
} from "../supervisor/store.js";
import type { RunManifest } from "../supervisor/types.js";
import {
  StateStore,
  createMemoryStateStoreDriver,
  type StateStoreDriver,
} from "./store.js";
import {
  validateEvidenceRef,
  type EvidenceRef,
  type EvidenceRow,
} from "./schema.js";

export const STATE_STORE_READ_VERSION = 1 as const;
export const DEFAULT_FLOAT_TOLERANCE = 1e-9;

const SEED_MEDIA_TYPE = "application/vnd.cliyard.statestore-read+json";
const SEED_EVENT_PREFIX = "seed";
const SOURCES = [
  "snapshot",
  "queue",
  "run",
  "ledger",
  "journal",
] as const;
export type StateStoreReadSource = (typeof SOURCES)[number];

const SOURCE_SET: ReadonlySet<string> = new Set(SOURCES);

export class StateStoreReadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StateStoreReadError";
  }
}

export interface StateStoreReadErrorDetail {
  source: string;
  message: string;
}

/**
 * One seed record. `payload` is the source data exactly as projected; large
 * payloads live in content-addressed evidence, never in the fact payload.
 */
export interface StateStoreSeedRecord {
  version: typeof STATE_STORE_READ_VERSION;
  source: StateStoreReadSource;
  id: string;
  at: string;
  payload: unknown;
}

/** Evidence byte store seam; `FileEvidenceStore` satisfies this shape. */
export interface StateStoreReadEvidenceStore {
  put(content: string | Uint8Array, mediaType: string): EvidenceRef;
  read(ref: EvidenceRef): Buffer;
}

/**
 * In-memory evidence store for the default read path. Evidence is
 * content-addressed and immutable, exactly like the file-backed store; a
 * process rebuild simply re-puts byte-identical objects.
 */
export class MemoryStateStoreEvidenceStore
  implements StateStoreReadEvidenceStore
{
  private readonly objects = new Map<string, Buffer>();

  put(content: string | Uint8Array, mediaType: string): EvidenceRef {
    const bytes =
      typeof content === "string" ? Buffer.from(content, "utf8") : Buffer.from(content);
    const contentHash = createHash("sha256").update(bytes).digest("hex");
    const ref = validateEvidenceRef({
      contentHash,
      byteLength: bytes.byteLength,
      mediaType,
      path: `sha256/${contentHash}`,
    });
    const existing = this.objects.get(contentHash);
    if (existing !== undefined) {
      if (!existing.equals(bytes)) {
        throw new StateStoreReadError(
          `evidence object ${contentHash} exists with different bytes`,
        );
      }
      return ref;
    }
    this.objects.set(contentHash, bytes);
    return ref;
  }

  read(ref: EvidenceRef): Buffer {
    const validated = validateEvidenceRef(ref);
    const bytes = this.objects.get(validated.contentHash);
    if (bytes === undefined) {
      throw new StateStoreReadError(
        `evidence object ${validated.contentHash} is missing from the read store`,
      );
    }
    return Buffer.from(bytes);
  }
}

export interface BuildStateStoreReadOptions {
  /** Observation time forwarded to the control snapshot builder. */
  now?: Date;
  journalLimit?: number;
  /**
   * Test/embedding seam: reuse an already-built authoritative snapshot instead
   * of sampling a second one. The projection is still written to and read back
   * from the StateStore.
   */
  controlSnapshot?: ControlSnapshot;
  /** Driver supplied by the caller; the store is closed before returning. */
  driver?: StateStoreDriver;
  /** Evidence store supplied by the caller; defaults to in-memory. */
  evidence?: StateStoreReadEvidenceStore;
}

export interface StateStoreReadStoreSummary {
  lastSeq: number;
  recordCount: number;
  factCount: number;
  /** Deterministic hash of the seed records; equal across fresh processes. */
  seedHash: string;
  sources: Record<StateStoreReadSource, number>;
}

export interface StateStoreReadEventsView {
  version: typeof STATE_STORE_READ_VERSION;
  repoRoot: string;
  store: StateStoreReadStoreSummary;
  journal: QueueEventJournalSummary;
  ledger: StateStoreLedgerProjection;
  errors: StateStoreReadErrorDetail[];
}

export interface StateStoreReadView {
  version: typeof STATE_STORE_READ_VERSION;
  repoRoot: string;
  observedAt: string;
  store: StateStoreReadStoreSummary;
  /** The control snapshot exactly as reconstructed from the projection. */
  status: ControlSnapshot;
  events: StateStoreReadEventsView;
}

/** Bounded read-only ledger projection carried through the StateStore. */
export interface StateStoreLedgerProjection {
  path: string;
  exists: boolean;
  tasks: StateStoreLedgerTask[];
  readError: string | null;
}

export interface StateStoreLedgerTask {
  taskId: string;
  status: LedgerTaskRecord["status"];
  repairCount: number;
  verdict: LedgerTaskRecord["verdict"];
  reason: string | null;
  sessionIds: string[];
  events: LedgerEvent[];
  lastEventAt: string | null;
  failure: LedgerTaskRecord["failure"] | null;
  cost: LedgerTaskRecord["cost"] | null;
}

interface JournalSeedMeta {
  version: 1;
  path: string;
  exists: boolean;
  totalEvents: number;
  malformedLines: number;
  lastEventAt: string | null;
  readError: string | null;
}

/**
 * Seed the JSON truth into a fresh StateStore and read the projection back.
 * All JSON reads are observational; no write path is touched.
 */
export async function buildStateStoreReadView(
  repoRootInput: string,
  options: BuildStateStoreReadOptions = {},
): Promise<StateStoreReadView> {
  const repoRoot = resolve(repoRootInput);
  const snapshot =
    options.controlSnapshot ??
    (await buildControlSnapshot(repoRoot, {
      now: options.now,
      journalLimit: options.journalLimit,
    }));
  if (resolve(snapshot.repoRoot) !== repoRoot) {
    throw new StateStoreReadError(
      `control snapshot belongs to ${resolve(snapshot.repoRoot)}, not ${repoRoot}`,
    );
  }

  const collected = collectSeedRecords(repoRoot, snapshot);
  const driver = options.driver ?? createMemoryStateStoreDriver();
  const evidence = options.evidence ?? new MemoryStateStoreEvidenceStore();
  const store = StateStore.open(driver);
  try {
    seedStateStore(store, evidence, repoRoot, collected.records);
    const rebuilt = readSeededRecords(store, evidence);
    const errors = [...collected.errors, ...rebuilt.errors];
    const sources = countSources(rebuilt.records);
    const recordCount = rebuilt.records.length;
    const summary: StateStoreReadStoreSummary = {
      lastSeq: store.lastSeq,
      recordCount,
      factCount: store.lastSeq,
      seedHash: seedHash(rebuilt.records),
      sources,
    };

    const status = readStatusRecord(rebuilt.records);
    const journal = readJournalRecord(rebuilt.records, repoRoot);
    const ledger = readLedgerRecord(rebuilt.records);
    return {
      version: STATE_STORE_READ_VERSION,
      repoRoot,
      observedAt: status.observedAt,
      store: summary,
      status,
      events: {
        version: STATE_STORE_READ_VERSION,
        repoRoot,
        store: summary,
        journal,
        ledger,
        errors,
      },
    };
  } finally {
    store.close();
  }
}

// ---------------------------------------------------------------------------
// Seed collection
// ---------------------------------------------------------------------------

interface CollectedSeed {
  records: StateStoreSeedRecord[];
  errors: StateStoreReadErrorDetail[];
}

function collectSeedRecords(
  repoRoot: string,
  snapshot: ControlSnapshot,
): CollectedSeed {
  const records: StateStoreSeedRecord[] = [];
  const errors: StateStoreReadErrorDetail[] = [];
  const observedAt = snapshot.observedAt;

  addRecord(records, {
    source: "snapshot",
    id: "control",
    at: observedAt,
    payload: snapshot,
  });

  try {
    const queueDocument: QueueDocument = loadQueue(repoRoot);
    addRecord(records, {
      source: "queue",
      id: "document",
      at: safeTimestamp(queueDocument.updatedAt, observedAt),
      payload: queueDocument,
    });
  } catch (error) {
    errors.push({ source: "queue", message: errorMessage(error) });
  }

  for (const manifest of scanRunManifests(repoRoot, errors)) {
    addRecord(records, {
      source: "run",
      id: manifest.runId,
      at: safeTimestamp(manifest.updatedAt, observedAt),
      payload: manifest,
    });
  }

  const ledgerPath = defaultLedgerPath(repoRoot);
  const ledgerExists = existsSync(ledgerPath);
  try {
    const ledger = loadLedger(ledgerPath);
    const projection = projectLedger(ledger, ledgerExists);
    addRecord(records, {
      source: "ledger",
      id: "document",
      at: safeTimestamp(ledgerLatestAt(ledger), observedAt),
      payload: projection,
    });
  } catch (error) {
    errors.push({ source: "ledger", message: errorMessage(error) });
    addRecord(records, {
      source: "ledger",
      id: "document",
      at: observedAt,
      payload: {
        path: ledgerPath,
        exists: ledgerExists,
        tasks: [],
        readError: errorMessage(error),
      } satisfies StateStoreLedgerProjection,
    });
  }

  addRecord(records, {
    source: "journal",
    id: "meta",
    at: observedAt,
    payload: {
      version: snapshot.journal.version,
      path: snapshot.journal.path,
      exists: snapshot.journal.exists,
      totalEvents: snapshot.journal.totalEvents,
      malformedLines: snapshot.journal.malformedLines,
      lastEventAt: snapshot.journal.lastEventAt,
      readError: snapshot.journal.readError,
    } satisfies JournalSeedMeta,
  });
  for (const event of snapshot.journal.events) {
    addRecord(records, {
      source: "journal",
      id: `event-${event.eventId}`,
      at: safeTimestamp(event.at, observedAt),
      payload: event,
    });
  }

  return { records, errors };
}

function addRecord(
  records: StateStoreSeedRecord[],
  record: Omit<StateStoreSeedRecord, "version">,
): void {
  records.push({ version: STATE_STORE_READ_VERSION, ...record });
}

function scanRunManifests(
  repoRoot: string,
  errors: StateStoreReadErrorDetail[],
): RunManifest[] {
  const runsDir = supervisorPaths(repoRoot).runsDir;
  let names: string[];
  try {
    names = readdirSync(runsDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      errors.push({ source: "run", message: errorMessage(error) });
    }
    return [];
  }

  const manifests: RunManifest[] = [];
  for (const name of names.sort()) {
    if (!name.endsWith(".json") || name === "active.json") continue;
    if (name.startsWith(".")) continue;
    const runId = name.slice(0, -".json".length);
    try {
      manifests.push(loadRunManifest(repoRoot, runId));
    } catch (error) {
      errors.push({ source: `run:${runId}`, message: errorMessage(error) });
    }
  }
  return manifests;
}

function projectLedger(
  ledger: Ledger,
  exists: boolean,
): StateStoreLedgerProjection {
  const tasks = Object.entries(ledger.tasks)
    .sort(([left], [right]) => compareStrings(left, right))
    .map(([taskId, record]) => projectLedgerTask(taskId, record));
  return {
    path: ledger.path,
    exists,
    tasks,
    readError: null,
  };
}

function projectLedgerTask(
  taskId: string,
  record: LedgerTaskRecord,
): StateStoreLedgerTask {
  const events = Array.isArray(record.events) ? record.events : [];
  return {
    taskId,
    status: record.status,
    repairCount: record.repairCount,
    verdict: record.verdict,
    reason: record.reason ?? null,
    sessionIds: Array.isArray(record.sessionIds) ? [...record.sessionIds] : [],
    events: events.map((event) => ({ ...event })),
    lastEventAt:
      events.length > 0 && typeof events.at(-1)?.at === "string"
        ? events.at(-1)!.at
        : null,
    failure: record.failure ?? null,
    cost: record.cost ?? null,
  };
}

function ledgerLatestAt(ledger: Ledger): string | null {
  let latest: string | null = null;
  for (const record of Object.values(ledger.tasks)) {
    for (const event of record.events ?? []) {
      if (typeof event.at === "string" && !Number.isNaN(Date.parse(event.at))) {
        if (latest === null || Date.parse(event.at) > Date.parse(latest)) {
          latest = event.at;
        }
      }
    }
  }
  return latest;
}

// ---------------------------------------------------------------------------
// Seeding
// ---------------------------------------------------------------------------

function seedStateStore(
  store: StateStore,
  evidence: StateStoreReadEvidenceStore,
  repoRoot: string,
  records: readonly StateStoreSeedRecord[],
): void {
  const workspaceId = `repo:${digest(repoRoot).slice(0, 32)}`;
  const seenAttempts = new Set<string>();
  records.forEach((record, index) => {
    const attemptId = attemptIdFor(record.source, record.id);
    if (seenAttempts.has(attemptId)) {
      throw new StateStoreReadError(
        `duplicate seed record ${record.source}:${record.id}`,
      );
    }
    seenAttempts.add(attemptId);
    const at = safeTimestamp(record.at, new Date(0).toISOString());
    const runtimeHandle = runtimeHandleFor(record.source, record.id);
    const envelope: StateStoreSeedRecord = {
      version: STATE_STORE_READ_VERSION,
      source: record.source,
      id: record.id,
      at,
      payload: record.payload,
    };
    const ref = evidence.put(canonicalJson(envelope), SEED_MEDIA_TYPE);

    store.append(
      {
        kind: "attempt.started",
        attemptId,
        payload: {
          backendType: "process-group",
          runtimeHandle,
          workspaceId,
          desiredState: "running",
          leaseDeadline: null,
        },
      },
      { at, eventId: seedEventId(index, record, "started") },
    );
    store.append(
      {
        kind: "attempt.observed-state-changed",
        attemptId,
        payload: { observedState: "exited" },
      },
      { at, eventId: seedEventId(index, record, "observed") },
    );
    store.append(
      {
        kind: "attempt.evidence-recorded",
        attemptId,
        payload: { evidence: [ref] },
      },
      { at, eventId: seedEventId(index, record, "evidence") },
    );
  });
}

function attemptIdFor(
  source: StateStoreReadSource,
  id: string,
): string {
  return `${source}.${digest(id).slice(0, 32)}`;
}

function runtimeHandleFor(
  source: StateStoreReadSource,
  id: string,
): string {
  return `seed:${source}:${digest(id).slice(0, 32)}`;
}

function seedEventId(
  index: number,
  record: StateStoreSeedRecord,
  kind: "started" | "observed" | "evidence",
): string {
  return `${SEED_EVENT_PREFIX}.${digest(
    `${index} ${record.source} ${record.id} ${kind}`,
  ).slice(0, 40)}`;
}

// ---------------------------------------------------------------------------
// Projection read-back
// ---------------------------------------------------------------------------

interface ReadBack {
  records: StateStoreSeedRecord[];
  errors: StateStoreReadErrorDetail[];
}

function readSeededRecords(
  store: StateStore,
  evidence: StateStoreReadEvidenceStore,
): ReadBack {
  const snapshot = store.snapshot();
  const evidenceByAttempt = new Map<string, EvidenceRow[]>();
  for (const row of snapshot.evidence) {
    const bucket = evidenceByAttempt.get(row.attemptId);
    if (bucket === undefined) {
      evidenceByAttempt.set(row.attemptId, [row]);
    } else {
      bucket.push(row);
    }
  }

  const rows: Array<{ seq: number; record: StateStoreSeedRecord }> = [];
  const errors: StateStoreReadErrorDetail[] = [];
  for (const attempt of snapshot.attempts) {
    const bucket = evidenceByAttempt.get(attempt.attemptId);
    if (bucket === undefined) {
      errors.push({
        source: attempt.runtimeHandle,
        message: "seeded attempt has no evidence record",
      });
      continue;
    }
    for (const row of bucket) {
      try {
        const ref = validateEvidenceRef({
          contentHash: row.contentHash,
          byteLength: row.byteLength,
          mediaType: row.mediaType,
          path: row.path,
        });
        const parsed = JSON.parse(evidence.read(ref).toString("utf8")) as unknown;
        const record = parseSeedRecord(parsed);
        rows.push({ seq: row.seq, record });
      } catch (error) {
        errors.push({
          source: attempt.runtimeHandle,
          message: errorMessage(error),
        });
      }
    }
  }
  rows.sort((left, right) => left.seq - right.seq);
  return { records: rows.map((row) => row.record), errors };
}

function parseSeedRecord(value: unknown): StateStoreSeedRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new StateStoreReadError("seed evidence must be a JSON object");
  }
  const record = value as Record<string, unknown>;
  if (record.version !== STATE_STORE_READ_VERSION) {
    throw new StateStoreReadError(
      `unsupported seed record version ${JSON.stringify(record.version)}`,
    );
  }
  if (typeof record.source !== "string" || !SOURCE_SET.has(record.source)) {
    throw new StateStoreReadError(
      `invalid seed record source ${JSON.stringify(record.source)}`,
    );
  }
  if (typeof record.id !== "string" || record.id.length === 0) {
    throw new StateStoreReadError("seed record id must be a non-empty string");
  }
  if (
    typeof record.at !== "string" ||
    Number.isNaN(Date.parse(record.at))
  ) {
    throw new StateStoreReadError("seed record at must be a timestamp");
  }
  if (!Object.hasOwn(record, "payload")) {
    throw new StateStoreReadError("seed record payload is missing");
  }
  return {
    version: STATE_STORE_READ_VERSION,
    source: record.source as StateStoreReadSource,
    id: record.id,
    at: record.at,
    payload: record.payload,
  };
}

function readStatusRecord(records: StateStoreSeedRecord[]): ControlSnapshot {
  const record = records.find(
    (candidate) => candidate.source === "snapshot" && candidate.id === "control",
  );
  if (record === undefined) {
    throw new StateStoreReadError(
      "the projection contains no control snapshot record",
    );
  }
  const status = record.payload as ControlSnapshot;
  if (
    typeof status !== "object" ||
    status === null ||
    typeof status.version !== "number" ||
    !Array.isArray(status.items)
  ) {
    throw new StateStoreReadError(
      "the projected control snapshot record is malformed",
    );
  }
  return status;
}

function readJournalRecord(
  records: StateStoreSeedRecord[],
  repoRoot: string,
): QueueEventJournalSummary {
  const metaRecord = records.find(
    (candidate) => candidate.source === "journal" && candidate.id === "meta",
  );
  const events = records
    .filter(
      (candidate) =>
        candidate.source === "journal" && candidate.id !== "meta",
    )
    .map((candidate) => candidate.payload as QueueControlEvent);
  const meta = (metaRecord?.payload ?? {}) as Partial<JournalSeedMeta>;
  return {
    version: 1,
    path: meta.path ?? join(repoRoot, ".cliyard", "queue-events", "events.jsonl"),
    exists: meta.exists ?? false,
    totalEvents: meta.totalEvents ?? events.length,
    malformedLines: meta.malformedLines ?? 0,
    events,
    lastEventAt:
      meta.lastEventAt ??
      (events.length > 0 ? events[events.length - 1]!.at : null),
    readError: meta.readError ?? null,
  };
}

function readLedgerRecord(
  records: StateStoreSeedRecord[],
): StateStoreLedgerProjection {
  const record = records.find(
    (candidate) => candidate.source === "ledger" && candidate.id === "document",
  );
  if (record === undefined) {
    return { path: "", exists: false, tasks: [], readError: "ledger seed missing" };
  }
  const projection = record.payload as StateStoreLedgerProjection;
  if (
    typeof projection !== "object" ||
    projection === null ||
    !Array.isArray(projection.tasks)
  ) {
    return {
      path: "",
      exists: false,
      tasks: [],
      readError: "ledger seed record is malformed",
    };
  }
  return projection;
}

function countSources(
  records: StateStoreSeedRecord[],
): Record<StateStoreReadSource, number> {
  const counts = {
    snapshot: 0,
    queue: 0,
    run: 0,
    ledger: 0,
    journal: 0,
  } satisfies Record<StateStoreReadSource, number>;
  for (const record of records) counts[record.source] += 1;
  return counts;
}

/**
 * Identity of the durable JSON truth the projection was seeded from. The
 * materialized control snapshot is excluded because it carries host-sampled
 * resources and read-time worker ages; those are observations, not truth. Two
 * fresh processes over unchanged JSON therefore agree on this hash.
 */
function seedHash(records: StateStoreSeedRecord[]): string {
  const hash = createHash("sha256");
  for (const record of records) {
    if (record.source === "snapshot") continue;
    hash.update(record.source);
    hash.update(" ");
    hash.update(record.id);
    hash.update(" ");
    hash.update(canonicalJson(record.payload));
    hash.update("\n");
  }
  return hash.digest("hex");
}

// ---------------------------------------------------------------------------
// Semantic parity (acceptance gate) and byte diagnostic
// ---------------------------------------------------------------------------

export interface SemanticDifference {
  path: string;
  kind: "type" | "value" | "number" | "missing" | "extra" | "array-length";
  expected: unknown;
  actual: unknown;
}

export interface SemanticComparison {
  /** Acceptance gate: canonicalized deep-equal within the float tolerance. */
  equal: boolean;
  /**
   * Diagnostic only. Raw JSON serialization equality; callers must never use
   * this to accept or reject a projection.
   */
  byteIdentical: boolean;
  differences: SemanticDifference[];
}

export interface SemanticCompareOptions {
  /** Absolute tolerance for finite numeric values. Defaults to 1e-9. */
  floatTolerance?: number;
}

/**
 * Compare two control snapshots semantically. Object key order and keys whose
 * value is `undefined` (JSON-absent) are ignored; arrays keep their order.
 * Numbers compare exactly first, then within the explicit absolute tolerance.
 */
export function compareControlSnapshotParity(
  expected: ControlSnapshot,
  actual: ControlSnapshot,
  options: SemanticCompareOptions = {},
): SemanticComparison {
  return compareSemanticValues(expected, actual, options);
}

/** Generic canonicalized deep-equal with the same float tolerance. */
export function compareSemanticValues(
  expected: unknown,
  actual: unknown,
  options: SemanticCompareOptions = {},
): SemanticComparison {
  const tolerance = normalizeTolerance(options.floatTolerance);
  const differences: SemanticDifference[] = [];
  collectDifferences(expected, actual, "$", tolerance, differences);
  return {
    equal: differences.length === 0,
    byteIdentical:
      JSON.stringify(expected ?? null) === JSON.stringify(actual ?? null),
    differences,
  };
}

/** Deterministic JSON: object keys sorted, `undefined` dropped like JSON. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) =>
      entry === undefined ? null : canonicalize(entry),
    );
  }
  if (typeof value === "object" && value !== null) {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      const entry = (value as Record<string, unknown>)[key];
      if (entry === undefined) continue;
      out[key] = canonicalize(entry);
    }
    return out;
  }
  if (typeof value === "number" && !Number.isFinite(value)) return null;
  return value;
}

function collectDifferences(
  expected: unknown,
  actual: unknown,
  path: string,
  tolerance: number,
  out: SemanticDifference[],
): void {
  if (expected === undefined && actual === undefined) return;
  if (expected === undefined) {
    out.push({ path, kind: "missing", expected, actual });
    return;
  }
  if (actual === undefined) {
    out.push({ path, kind: "extra", expected, actual });
    return;
  }
  if (expected === null || actual === null) {
    if (!Object.is(expected, actual)) {
      out.push({ path, kind: "value", expected, actual });
    }
    return;
  }
  if (typeof expected === "number" && typeof actual === "number") {
    if (Object.is(expected, actual)) return;
    if (
      Number.isFinite(expected) &&
      Number.isFinite(actual) &&
      Math.abs(expected - actual) <= tolerance
    ) {
      return;
    }
    out.push({ path, kind: "number", expected, actual });
    return;
  }
  if (Array.isArray(expected) || Array.isArray(actual)) {
    if (!Array.isArray(expected) || !Array.isArray(actual)) {
      out.push({ path, kind: "type", expected, actual });
      return;
    }
    if (expected.length !== actual.length) {
      out.push({
        path,
        kind: "array-length",
        expected: expected.length,
        actual: actual.length,
      });
    }
    const length = Math.min(expected.length, actual.length);
    for (let index = 0; index < length; index += 1) {
      collectDifferences(
        expected[index],
        actual[index],
        `${path}[${index}]`,
        tolerance,
        out,
      );
    }
    return;
  }
  if (typeof expected === "object" && typeof actual === "object") {
    const expectedRecord = expected as Record<string, unknown>;
    const actualRecord = actual as Record<string, unknown>;
    const expectedKeys = Object.keys(expectedRecord).filter(
      (key) => expectedRecord[key] !== undefined,
    );
    const actualKeys = Object.keys(actualRecord).filter(
      (key) => actualRecord[key] !== undefined,
    );
    const expectedSet = new Set(expectedKeys);
    const actualSet = new Set(actualKeys);
    for (const key of expectedKeys) {
      if (!actualSet.has(key)) {
        out.push({
          path: `${path}.${key}`,
          kind: "missing",
          expected: expectedRecord[key],
          actual: undefined,
        });
      }
    }
    for (const key of actualKeys) {
      if (!expectedSet.has(key)) {
        out.push({
          path: `${path}.${key}`,
          kind: "extra",
          expected: undefined,
          actual: actualRecord[key],
        });
      }
    }
    for (const key of expectedKeys) {
      if (!actualSet.has(key)) continue;
      collectDifferences(
        expectedRecord[key],
        actualRecord[key],
        `${path}.${key}`,
        tolerance,
        out,
      );
    }
    return;
  }
  if (!Object.is(expected, actual)) {
    out.push({ path, kind: "value", expected, actual });
  }
}

function normalizeTolerance(value: number | undefined): number {
  if (value === undefined) return DEFAULT_FLOAT_TOLERANCE;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new StateStoreReadError(
      "floatTolerance must be a non-negative finite number",
    );
  }
  return value;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

export interface StateStoreCliOptions {
  log?: (line: string) => void;
  cwd?: string;
  /** Test seam; defaults to the current clock. */
  now?: Date;
}

const CLI_USAGE = `Usage:
  cliyard statestore status --repo <path> [--json] [--journal-limit <n>]
  cliyard statestore events --repo <path> [--json] [--journal-limit <n>]

Read-only projection seeded from .cliyard/queue.json, .cliyard/runs/*.json,
.cliyard/ledger.json and the queue event journal. JSON files remain the write
authority; StateStore is only the read projection.`;

export async function runStateStoreCli(
  argv: string[],
  options: StateStoreCliOptions = {},
): Promise<number> {
  const log = options.log ?? ((line: string) => console.log(line));
  const [cmd, ...rest] = argv;
  if (!cmd || cmd === "-h" || cmd === "--help") {
    log(CLI_USAGE);
    return cmd ? 0 : 1;
  }
  if (cmd !== "status" && cmd !== "events") {
    log(`unknown statestore command: ${cmd}`);
    log(CLI_USAGE);
    return 1;
  }

  const repoRoot = resolve(
    arg("--repo", rest) ?? options.cwd ?? process.cwd(),
  );
  const asJson = has("--json", rest);
  const journalLimit = parseJournalLimit(arg("--journal-limit", rest));

  const view = await buildStateStoreReadView(repoRoot, {
    now: options.now,
    journalLimit,
  });

  if (asJson) {
    log(
      cmd === "status"
        ? JSON.stringify(view.status, null, 2)
        : JSON.stringify(view.events, null, 2),
    );
  } else if (cmd === "status") {
    printStatusView(view, log);
  } else {
    printEventsView(view.events, log);
  }
  return 0;
}

function printStatusView(
  view: StateStoreReadView,
  log: (line: string) => void,
): void {
  const counts = view.status.counts;
  log(`statestore status: ${view.repoRoot}`);
  log(
    `store: seq=${view.store.lastSeq} records=${view.store.recordCount} ` +
      `seed=${view.store.seedHash.slice(0, 12)}`,
  );
  log(
    `queue: total=${counts.total} pending=${counts.pending} ` +
      `running=${counts.running} completed=${counts.completed} ` +
      `blocked=${counts.blocked} cancelled=${counts.cancelled}`,
  );
  for (const item of view.status.items) {
    const run = item.run ? ` run=${item.run.runId}` : "";
    log(
      `  [${item.status}] ${item.id} ` +
        `attempts=${item.attempts}/${item.maxAttempts}${run}`,
    );
  }
  log(
    `journal: ${view.events.journal.totalEvents} events ` +
      `(${view.events.journal.malformedLines} malformed)`,
  );
  log(`ledger: ${view.events.ledger.tasks.length} tasks`);
  printErrors(view.events.errors, log);
}

function printEventsView(
  view: StateStoreReadEventsView,
  log: (line: string) => void,
): void {
  log(`statestore events: ${view.repoRoot}`);
  log(
    `store: seq=${view.store.lastSeq} records=${view.store.recordCount} ` +
      `seed=${view.store.seedHash.slice(0, 12)}`,
  );
  log(
    `journal (${view.journal.totalEvents} events, ` +
      `${view.journal.malformedLines} malformed):`,
  );
  for (const event of view.journal.events) {
    const item = event.itemId ? ` item=${event.itemId}` : "";
    const run = event.runId ? ` run=${event.runId}` : "";
    const status = event.status ? ` status=${event.status}` : "";
    log(`  ${event.at} ${event.type}${item}${run}${status}`);
  }
  log(`ledger (${view.ledger.tasks.length} tasks):`);
  for (const task of view.ledger.tasks) {
    log(
      `  ${task.taskId} ${task.status}` +
        (task.verdict ? ` verdict=${task.verdict}` : "") +
        ` events=${task.events.length}`,
    );
  }
  printErrors(view.errors, log);
}

function printErrors(
  errors: StateStoreReadErrorDetail[],
  log: (line: string) => void,
): void {
  for (const error of errors) {
    log(`degraded ${error.source}: ${error.message}`);
  }
}

function parseJournalLimit(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new StateStoreReadError(
      `--journal-limit must be a positive integer (got ${JSON.stringify(value)})`,
    );
  }
  return parsed;
}

function arg(flag: string, argv: string[]): string | undefined {
  const index = argv.indexOf(flag);
  if (index >= 0 && argv[index + 1] && !argv[index + 1]!.startsWith("--")) {
    return argv[index + 1];
  }
  const equals = argv.find((entry) => entry.startsWith(`${flag}=`));
  return equals?.slice(flag.length + 1);
}

function has(flag: string, argv: string[]): boolean {
  return argv.includes(flag);
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function safeTimestamp(value: unknown, fallback: string): string {
  if (
    typeof value === "string" &&
    value.trim() !== "" &&
    !Number.isNaN(Date.parse(value))
  ) {
    return value;
  }
  return fallback;
}

function digest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

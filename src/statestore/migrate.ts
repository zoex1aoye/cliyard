/**
 * One-shot, hash-verified import of the legacy JSON authority into the
 * StateStore write API (design/statestore-write-migration-v0.md).
 *
 * Single-writer cutover:
 * - the legacy JSON bytes are read once and hashed (`sourceHash`);
 * - the parsed truth is canonicalized and hashed (`contentHash`);
 * - every legacy record is appended through `StateStoreDomainWriter`;
 * - the imported state is read back and re-hashed before the marker is
 *   written;
 * - the marker records both hashes and the per-file source references.
 *
 * After a marker exists, `createLegacyJsonGuard` fails closed when the legacy
 * bytes drift (`StateStoreLegacyDriftError`, `needsHuman`). This module never
 * deletes or rewrites legacy JSON and never cuts over a consumer write path.
 *
 * Domain scope: follow-on cutovers handle the supervisor, queue and ledger
 * domains independently, so `domains` selects which authorities to import.
 * The default is all four. A marker that is a superset of the requested scope
 * counts as covering it, and drift is compared only within the requested
 * scope.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import {
  isQueueControlEvent,
  queueEventJournalPath,
  type QueueControlEvent,
} from "../orchestration/event-journal.js";
import {
  loadQueue,
  queuePaths,
  type QueueDocument,
} from "../orchestration/queue-store.js";
import {
  defaultLedgerPath,
  loadLedger,
  type Ledger,
} from "../persistence/ledger.js";
import {
  ACTIVE_RUN_FILE,
  getActiveRun,
  loadRunManifest,
  supervisorPaths,
} from "../supervisor/store.js";
import type {
  ActiveRunPointer,
  RunManifest,
} from "../supervisor/types.js";
import {
  LEGACY_SOURCE_DOMAINS,
  StateStoreDomainWriter,
  StateStoreLegacyDriftError,
  StateStoreMigrationRequiredError,
  StateStoreWriteError,
  StateStoreWriteValidationError,
  canonicalStateStoreJson,
  encodeStateStoreDomainRecord,
  normalizeDomainScope,
  projectStateStoreDomainRecords,
  readStateStoreDomainRecords,
  sha256Hex,
  type EncodedStateStoreDomainRecord,
  type LegacySourceDomain,
  type StateStoreDomainRecord,
  type StateStoreLegacyGuard,
  type StateStoreMigrationCounts,
  type StateStoreMigrationMarker,
  type StateStoreMigrationSource,
} from "./write.js";

/** Repo-relative ledger path; the ledger file never stores a host path. */
export const LEGACY_LEDGER_RELATIVE_PATH = ".cliyard/ledger.json";

const EPOCH_TIMESTAMP = new Date(0).toISOString();
const DOMAIN_ORDER: readonly LegacySourceDomain[] = LEGACY_SOURCE_DOMAINS;

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class StateStoreMigrationError extends StateStoreWriteError {
  constructor(message: string, code = "statestore.write.migration") {
    super(code, message);
    this.name = "StateStoreMigrationError";
  }
}

/** Imported bytes did not read back as the verified legacy truth. */
export class StateStoreMigrationVerificationError
  extends StateStoreMigrationError
{
  readonly expectedHash: string | undefined;
  readonly actualHash: string | undefined;

  constructor(
    message: string,
    expectedHash?: string,
    actualHash?: string,
  ) {
    super(message, "statestore.write.migration_verification");
    this.name = "StateStoreMigrationVerificationError";
    this.expectedHash = expectedHash;
    this.actualHash = actualHash;
  }
}

// ---------------------------------------------------------------------------
// Raw legacy sources
// ---------------------------------------------------------------------------

/**
 * Enumerate the raw bytes that make up one import scope, in a deterministic
 * order. Missing files are recorded as `exists: false`, so creating a file
 * after import is drift even when its logical content is empty.
 */
export function readLegacySourceRefs(
  repoRoot: string,
  domains: readonly LegacySourceDomain[] = LEGACY_SOURCE_DOMAINS,
): StateStoreMigrationSource[] {
  const root = resolveRepoRoot(repoRoot);
  const scope = normalizeDomainScope([...domains]);
  const sources: StateStoreMigrationSource[] = [];

  if (scope.includes("run")) {
    const paths = supervisorPaths(root);
    for (const runId of listRunIds(root)) {
      sources.push(
        readSource(
          root,
          "run",
          runId,
          join(paths.runsDir, `${runId}.json`),
        ),
      );
    }
    sources.push(
      readSource(root, "run", "active", paths.activePath),
    );
  }
  if (scope.includes("queue")) {
    sources.push(
      readSource(root, "queue", "queue", queuePaths(root).queuePath),
    );
  }
  if (scope.includes("ledger")) {
    sources.push(
      readSource(
        root,
        "ledger",
        "ledger",
        defaultLedgerPath(root),
      ),
    );
  }
  if (scope.includes("audit-event")) {
    sources.push(
      readSource(
        root,
        "audit-event",
        "journal",
        queueEventJournalPath(root),
      ),
    );
  }

  sources.sort(compareSources);
  return sources;
}

/** Deterministic hash over the raw-byte source references. */
export function hashLegacySources(
  sources: readonly StateStoreMigrationSource[],
): string {
  return sha256Hex(
    canonicalStateStoreJson({
      version: 1,
      sources: [...sources].sort(compareSources),
    }),
  );
}

function readSource(
  root: string,
  domain: LegacySourceDomain,
  id: string,
  absolutePath: string,
): StateStoreMigrationSource {
  const path = repoRelative(root, absolutePath);
  let bytes: Buffer;
  try {
    bytes = readFileSync(absolutePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return {
        path,
        domain,
        id,
        exists: false,
        contentHash: null,
        byteLength: 0,
      };
    }
    throw new StateStoreMigrationError(
      `cannot read legacy ${domain} source ${absolutePath}: ` +
        `${errorMessage(error)}`,
    );
  }
  return {
    path,
    domain,
    id,
    exists: true,
    contentHash: sha256Hex(bytes),
    byteLength: bytes.byteLength,
  };
}

function listRunIds(root: string): string[] {
  const runsDir = supervisorPaths(root).runsDir;
  let names: string[];
  try {
    names = readdirSync(runsDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw new StateStoreMigrationError(
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

// ---------------------------------------------------------------------------
// Parsed legacy truth
// ---------------------------------------------------------------------------

interface LegacyContentParts {
  runs: RunManifest[];
  activeRun: ActiveRunPointer | null;
  queue: QueueDocument | null;
  ledger: Ledger | null;
  auditEvents: QueueControlEvent[];
}

interface LegacyTruth extends LegacyContentParts {
  domains: LegacySourceDomain[];
  sources: StateStoreMigrationSource[];
  sourceHash: string;
  contentHash: string;
  malformedAuditLines: number;
}

function readLegacyTruth(
  root: string,
  scope: readonly LegacySourceDomain[],
): LegacyTruth {
  const before = readLegacySourceRefs(root, scope);

  const runs: RunManifest[] = [];
  let activeRun: ActiveRunPointer | null = null;
  if (scope.includes("run")) {
    const runsDir = supervisorPaths(root).runsDir;
    const seenRunIds = new Set<string>();
    for (const runId of listRunIds(root)) {
      let manifest: RunManifest;
      try {
        manifest = loadRunManifest(root, runId);
      } catch (error) {
        throw new StateStoreMigrationError(
          `cannot load run manifest ${runId}: ${errorMessage(error)}`,
        );
      }
      if (manifest.runId !== runId) {
        throw new StateStoreMigrationError(
          `run manifest ${join(runsDir, `${runId}.json`)} declares runId ` +
            `${manifest.runId}; refusing to import an ambiguous identity`,
        );
      }
      if (seenRunIds.has(manifest.runId)) {
        throw new StateStoreMigrationError(
          `duplicate run manifest for ${manifest.runId}`,
        );
      }
      seenRunIds.add(manifest.runId);
      runs.push(manifest);
    }
    try {
      activeRun = getActiveRun(root) ?? null;
    } catch (error) {
      throw new StateStoreMigrationError(
        `cannot load the active run pointer: ${errorMessage(error)}`,
      );
    }
  }

  let queue: QueueDocument | null = null;
  if (scope.includes("queue")) {
    try {
      queue = loadQueue(root);
    } catch (error) {
      throw new StateStoreMigrationError(
        `cannot load the queue document: ${errorMessage(error)}`,
      );
    }
  }

  let ledger: Ledger | null = null;
  if (scope.includes("ledger")) {
    try {
      const loaded = loadLedger(defaultLedgerPath(root));
      // The ledger file's logical identity is the repo-relative authority
      // path. Storing the host-absolute path would make the import hash
      // depend on where the repository happens to live.
      ledger = {
        path: LEGACY_LEDGER_RELATIVE_PATH,
        tasks: loaded.tasks,
      };
    } catch (error) {
      throw new StateStoreMigrationError(
        `cannot load the ledger document: ${errorMessage(error)}`,
      );
    }
  }

  let auditEvents: QueueControlEvent[] = [];
  let malformedAuditLines = 0;
  if (scope.includes("audit-event")) {
    const loaded = loadAuditEvents(root);
    auditEvents = loaded.events;
    malformedAuditLines = loaded.malformed;
  }

  const after = readLegacySourceRefs(root, scope);
  if (canonicalStateStoreJson(before) !== canonicalStateStoreJson(after)) {
    throw new StateStoreMigrationError(
      "legacy JSON changed while it was being imported; retry once the " +
        "other writer is quiescent (refusing a torn snapshot)",
    );
  }

  const content = buildLegacyContent(scope, {
    runs,
    activeRun,
    queue,
    ledger,
    auditEvents,
  });
  return {
    domains: [...scope],
    sources: after,
    sourceHash: hashLegacySources(after),
    contentHash: sha256Hex(canonicalStateStoreJson(content)),
    runs,
    activeRun,
    queue,
    ledger,
    auditEvents,
    malformedAuditLines,
  };
}

function loadAuditEvents(root: string): {
  events: QueueControlEvent[];
  malformed: number;
} {
  const path = queueEventJournalPath(root);
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { events: [], malformed: 0 };
    }
    throw new StateStoreMigrationError(
      `cannot read the audit event journal ${path}: ${errorMessage(error)}`,
    );
  }
  const events: QueueControlEvent[] = [];
  const seenEventIds = new Set<string>();
  let malformed = 0;
  for (const line of raw.split("\n")) {
    if (line.trim() === "") continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line) as unknown;
    } catch {
      malformed += 1;
      continue;
    }
    if (!isQueueControlEvent(parsed)) {
      malformed += 1;
      continue;
    }
    if (seenEventIds.has(parsed.eventId)) {
      throw new StateStoreMigrationError(
        `duplicate audit event id ${parsed.eventId} in ${path}`,
      );
    }
    seenEventIds.add(parsed.eventId);
    events.push(parsed);
  }
  return { events, malformed };
}

/** Canonical content document for one import scope (both sides of the hash). */
function buildLegacyContent(
  scope: readonly LegacySourceDomain[],
  parts: LegacyContentParts,
): Record<string, unknown> {
  const content: Record<string, unknown> = {
    version: 1,
    domains: [...scope],
  };
  if (scope.includes("run")) {
    content.runs = parts.runs;
    content.activeRun = parts.activeRun;
  }
  if (scope.includes("queue")) {
    content.queue = parts.queue;
  }
  if (scope.includes("ledger")) {
    content.ledger = parts.ledger;
  }
  if (scope.includes("audit-event")) {
    content.auditEvents = parts.auditEvents;
  }
  return content;
}

// ---------------------------------------------------------------------------
// Import records
// ---------------------------------------------------------------------------

/**
 * Build the exact record set for one truth snapshot. Timestamps prefer the
 * source value and fall back deterministically so an old JSON file with a
 * non-ISO timestamp is still importable without inventing a wall clock.
 */
function buildImportRecords(
  truth: LegacyTruth,
): EncodedStateStoreDomainRecord[] {
  const records: EncodedStateStoreDomainRecord[] = [];
  const scope = truth.domains;

  if (scope.includes("run")) {
    for (const manifest of truth.runs) {
      records.push(
        encodeStateStoreDomainRecord({
          kind: "run.manifest",
          id: manifest.runId,
          at: safeTimestamp(
            manifest.updatedAt,
            safeTimestamp(manifest.createdAt),
          ),
          payload: manifest,
        }),
      );
    }
    if (truth.activeRun !== null) {
      records.push(
        encodeStateStoreDomainRecord({
          kind: "run.active",
          id: "active",
          at: safeTimestamp(truth.activeRun.updatedAt),
          payload: truth.activeRun,
        }),
      );
    }
  }
  if (scope.includes("queue") && truth.queue !== null) {
    records.push(
      encodeStateStoreDomainRecord({
        kind: "queue.document",
        id: "queue",
        at: safeTimestamp(truth.queue.updatedAt),
        payload: truth.queue,
      }),
    );
  }
  if (scope.includes("ledger") && truth.ledger !== null) {
    records.push(
      encodeStateStoreDomainRecord({
        kind: "ledger.document",
        id: "ledger",
        at: latestLedgerTimestamp(truth.ledger),
        payload: truth.ledger,
      }),
    );
  }
  if (scope.includes("audit-event")) {
    for (const event of truth.auditEvents) {
      records.push(
        encodeStateStoreDomainRecord({
          kind: "audit-event.recorded",
          id: event.eventId,
          at: event.at,
          payload: event,
        }),
      );
    }
  }

  const seen = new Map<string, string>();
  for (const record of records) {
    const key = `${record.kind} ${record.id}`;
    const prior = seen.get(key);
    if (prior !== undefined) {
      throw new StateStoreMigrationError(
        `duplicate legacy record ${record.kind} ${record.id} in one import ` +
          "scope",
      );
    }
    seen.set(key, record.contentHash);
  }
  return records;
}

function latestLedgerTimestamp(ledger: Ledger): string {
  let best: { at: string; ms: number } | null = null;
  for (const value of Object.values(ledger.tasks)) {
    if (
      typeof value !== "object" ||
      value === null ||
      !Array.isArray((value as { events?: unknown }).events)
    ) {
      continue;
    }
    for (const event of (value as { events: unknown[] }).events) {
      if (
        typeof event !== "object" ||
        event === null ||
        Array.isArray(event)
      ) {
        continue;
      }
      const at = (event as { at?: unknown }).at;
      if (
        typeof at !== "string" ||
        at.length === 0 ||
        at.length > 64 ||
        at !== at.trim()
      ) {
        continue;
      }
      const ms = Date.parse(at);
      if (Number.isNaN(ms)) continue;
      if (
        best === null ||
        ms > best.ms ||
        (ms === best.ms && at > best.at)
      ) {
        best = { at, ms };
      }
    }
  }
  return best?.at ?? EPOCH_TIMESTAMP;
}

function safeTimestamp(value: unknown, fallback = EPOCH_TIMESTAMP): string {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (
      trimmed.length > 0 &&
      trimmed.length <= 64 &&
      !Number.isNaN(Date.parse(trimmed))
    ) {
      return trimmed;
    }
  }
  return fallback;
}

function importHashOf(
  records: readonly EncodedStateStoreDomainRecord[],
): string {
  return sha256Hex(
    canonicalStateStoreJson(
      records.map((record) => ({
        kind: record.kind,
        id: record.id,
        contentHash: record.contentHash,
      })),
    ),
  );
}

function countsOf(truth: LegacyTruth): StateStoreMigrationCounts {
  return {
    runs: truth.runs.length,
    queueItems: truth.queue?.items.length ?? 0,
    ledgerTasks:
      truth.ledger === null ? 0 : Object.keys(truth.ledger.tasks).length,
    auditEvents: truth.auditEvents.length,
    malformedAuditLines: truth.malformedAuditLines,
  };
}

// ---------------------------------------------------------------------------
// Migration
// ---------------------------------------------------------------------------

export interface MigrateLegacyJsonOptions {
  repoRoot: string;
  writer: StateStoreDomainWriter;
  /** Defaults to all four legacy authorities. */
  domains?: readonly LegacySourceDomain[];
  /** Marker timestamp boundary; defaults to host now. */
  at?: string;
}

export interface LegacyMigrationResult {
  /**
   * `already-imported` means the marker and the read-back state matched the
   * current legacy bytes; nothing was appended.
   */
  status: "imported" | "already-imported";
  domains: LegacySourceDomain[];
  sourceHash: string;
  contentHash: string;
  importHash: string;
  sources: StateStoreMigrationSource[];
  counts: StateStoreMigrationCounts;
  /** Records appended by this call (0 for an idempotent retry). */
  appendedRecords: number;
  /** Sequence of the visible import marker after this call. */
  markerSeq: number;
}

/**
 * Import the legacy JSON truth once, verify it, then record an import marker.
 * Re-running against unchanged legacy bytes is idempotent. Running after the
 * bytes changed fails closed with `StateStoreLegacyDriftError`.
 *
 * Call this with a writer that has no legacy guard installed, then install
 * `createLegacyJsonGuard` before accepting domain writes.
 */
export function migrateLegacyJson(
  options: MigrateLegacyJsonOptions,
): LegacyMigrationResult {
  if (
    typeof options !== "object" ||
    options === null ||
    options.writer === undefined
  ) {
    throw new StateStoreWriteValidationError(
      "migration requires a StateStoreDomainWriter",
      "options.writer",
    );
  }
  const root = resolveRepoRoot(options.repoRoot);
  const scope = normalizeDomainScope(
    options.domains ?? LEGACY_SOURCE_DOMAINS,
  );
  const truth = readLegacyTruth(root, scope);
  const expectedRecords = buildImportRecords(truth);
  const importHash = importHashOf(expectedRecords);
  const writer = options.writer;
  const readOptions = {
    store: writer.store,
    evidence: writer.evidence,
  };

  const before = readStateStoreDomainRecords(readOptions);
  const covering = findCoveringMarker(before, scope);
  if (covering !== undefined) {
    verifyImportedState(
      root,
      scope,
      truth,
      expectedRecords,
      before,
      covering,
    );
    return {
      status: "already-imported",
      domains: [...scope],
      sourceHash: truth.sourceHash,
      contentHash: truth.contentHash,
      importHash,
      sources: truth.sources,
      counts: countsOf(truth),
      appendedRecords: 0,
      markerSeq: covering.seq,
    };
  }

  let appendedRecords = 0;
  for (const record of expectedRecords) {
    if (writer.recordExists(record)) continue;
    writer.appendRecord(record);
    appendedRecords += 1;
  }

  const verifiedRecords = readStateStoreDomainRecords(readOptions);
  for (const record of expectedRecords) {
    if (!hasStoredRecord(verifiedRecords, record)) {
      throw new StateStoreMigrationVerificationError(
        `imported record ${record.kind} ${record.id} is missing after ` +
          "append",
        record.contentHash,
        undefined,
      );
    }
  }
  const projection = projectStateStoreDomainRecords(verifiedRecords);
  const storedContentHash = sha256Hex(
    canonicalStateStoreJson(
      buildLegacyContent(scope, {
        runs: projection.runs,
        activeRun: projection.activeRun,
        queue: projection.queue,
        ledger: projection.ledger,
        auditEvents: projection.auditEvents,
      }),
    ),
  );
  if (storedContentHash !== truth.contentHash) {
    throw new StateStoreMigrationVerificationError(
      "the StateStore projection does not match the legacy truth after " +
        "import; refusing to install a migration marker",
      truth.contentHash,
      storedContentHash,
    );
  }

  const importedAt = requiredTimestamp(
    options.at ?? new Date().toISOString(),
  );
  const marker: StateStoreMigrationMarker = {
    version: 1,
    importedAt,
    domains: [...scope],
    sourceHash: truth.sourceHash,
    contentHash: truth.contentHash,
    importHash,
    sources: truth.sources,
    counts: countsOf(truth),
  };
  writer.appendMigrationMarker(marker);

  const finalRecords = readStateStoreDomainRecords(readOptions);
  const installed = findCoveringMarker(finalRecords, scope);
  if (
    installed === undefined ||
    installed.payload.importHash !== importHash ||
    installed.payload.sourceHash !== truth.sourceHash
  ) {
    throw new StateStoreMigrationVerificationError(
      "the migration marker did not read back as written",
      importHash,
      installed?.payload.importHash,
    );
  }

  return {
    status: "imported",
    domains: [...scope],
    sourceHash: truth.sourceHash,
    contentHash: truth.contentHash,
    importHash,
    sources: truth.sources,
    counts: countsOf(truth),
    appendedRecords,
    markerSeq: installed.seq,
  };
}

function verifyImportedState(
  root: string,
  scope: readonly LegacySourceDomain[],
  truth: LegacyTruth,
  expectedRecords: readonly EncodedStateStoreDomainRecord[],
  records: readonly StateStoreDomainRecord[],
  marker: StateStoreDomainRecord<"migration.imported">,
): void {
  const expectedRefs = marker.payload.sources.filter((source) =>
    scope.includes(source.domain),
  );
  const expectedHash = hashLegacySources(expectedRefs);
  const actualHash = hashLegacySources(truth.sources);
  if (expectedHash !== actualHash) {
    throw new StateStoreLegacyDriftError({
      domains: scope,
      expectedSourceHash: expectedHash,
      actualSourceHash: actualHash,
      repoRoot: root,
      detail:
        "the import marker records different raw bytes than the current " +
        "legacy JSON.",
    });
  }

  for (const record of expectedRecords) {
    if (!hasStoredRecord(records, record)) {
      throw new StateStoreMigrationVerificationError(
        `previously imported record ${record.kind} ${record.id} is missing ` +
          "from the StateStore",
        record.contentHash,
        undefined,
      );
    }
  }

  const projection = projectStateStoreDomainRecords(records);
  const storedContentHash = sha256Hex(
    canonicalStateStoreJson(
      buildLegacyContent(scope, {
        runs: projection.runs,
        activeRun: projection.activeRun,
        queue: projection.queue,
        ledger: projection.ledger,
        auditEvents: projection.auditEvents,
      }),
    ),
  );
  if (storedContentHash !== truth.contentHash) {
    throw new StateStoreMigrationVerificationError(
      "the StateStore projection no longer matches the legacy truth; the " +
        "marker is present but the data diverged (needs human)",
      truth.contentHash,
      storedContentHash,
    );
  }
}

function hasStoredRecord(
  records: readonly StateStoreDomainRecord[],
  expected: EncodedStateStoreDomainRecord,
): boolean {
  return records.some(
    (record) =>
      record.kind === expected.kind &&
      record.id === expected.id &&
      record.contentHash === expected.contentHash,
  );
}

/**
 * Find the newest import marker whose domain scope covers `scope`. A marker
 * imported for a superset (for example all four domains) covers a later
 * per-domain cutover.
 */
export function findCoveringMarker(
  records: readonly StateStoreDomainRecord[],
  scope: readonly LegacySourceDomain[],
): StateStoreDomainRecord<"migration.imported"> | undefined {
  let best: StateStoreDomainRecord<"migration.imported"> | undefined;
  for (const record of records) {
    if (record.kind !== "migration.imported") continue;
    if (!scope.every((domain) => record.payload.domains.includes(domain))) {
      continue;
    }
    if (best === undefined) {
      best = record;
      continue;
    }
    const candidateMs = Date.parse(record.payload.importedAt);
    const bestMs = Date.parse(best.payload.importedAt);
    if (
      candidateMs > bestMs ||
      (candidateMs === bestMs && record.seq > best.seq)
    ) {
      best = record;
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// Guard
// ---------------------------------------------------------------------------

export interface CreateLegacyJsonGuardOptions {
  repoRoot: string;
  writer: StateStoreDomainWriter;
  /** Defaults to all four legacy authorities. */
  domains?: readonly LegacySourceDomain[];
}

/**
 * Fail-closed guard for post-import domain writes.
 *
 * - no covering marker -> `StateStoreMigrationRequiredError`;
 * - current raw bytes differ from the marker scope -> `StateStoreLegacyDriftError`
 *   with `needsHuman = true`.
 *
 * The guard re-reads and re-hashes the legacy files on every check; it never
 * caches a stale baseline.
 */
export function createLegacyJsonGuard(
  options: CreateLegacyJsonGuardOptions,
): StateStoreLegacyGuard {
  if (
    typeof options !== "object" ||
    options === null ||
    options.writer === undefined
  ) {
    throw new StateStoreWriteValidationError(
      "guard requires a StateStoreDomainWriter",
      "options.writer",
    );
  }
  const root = resolveRepoRoot(options.repoRoot);
  const scope = normalizeDomainScope(
    options.domains ?? LEGACY_SOURCE_DOMAINS,
  );
  const writer = options.writer;
  return {
    domains: [...scope],
    assertUnchanged(): void {
      const records = readStateStoreDomainRecords({
        store: writer.store,
        evidence: writer.evidence,
      });
      const marker = findCoveringMarker(records, scope);
      if (marker === undefined) {
        throw new StateStoreMigrationRequiredError(root, scope);
      }
      const expectedRefs = marker.payload.sources.filter((source) =>
        scope.includes(source.domain),
      );
      const expectedHash = hashLegacySources(expectedRefs);
      const actualHash = hashLegacySources(
        readLegacySourceRefs(root, scope),
      );
      if (expectedHash !== actualHash) {
        throw new StateStoreLegacyDriftError({
          domains: scope,
          expectedSourceHash: expectedHash,
          actualSourceHash: actualHash,
          repoRoot: root,
          detail:
            "a StateStore write was refused so no second authority wins.",
        });
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function resolveRepoRoot(repoRoot: unknown): string {
  if (
    typeof repoRoot !== "string" ||
    repoRoot.length === 0 ||
    repoRoot !== repoRoot.trim()
  ) {
    throw new StateStoreWriteValidationError(
      "repoRoot must be a non-empty path string",
      "repoRoot",
    );
  }
  return resolve(repoRoot);
}

function repoRelative(root: string, absolutePath: string): string {
  const rel = relative(root, absolutePath);
  return rel.split(sep).join("/");
}

function compareSources(
  left: StateStoreMigrationSource,
  right: StateStoreMigrationSource,
): number {
  const order =
    DOMAIN_ORDER.indexOf(left.domain) - DOMAIN_ORDER.indexOf(right.domain);
  if (order !== 0) return order;
  if (left.path !== right.path) return left.path < right.path ? -1 : 1;
  if (left.id !== right.id) return left.id < right.id ? -1 : 1;
  return 0;
}

function requiredTimestamp(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 64 ||
    value !== value.trim() ||
    Number.isNaN(Date.parse(value))
  ) {
    throw new StateStoreWriteValidationError(
      "timestamp must be a non-empty ISO-8601 string of at most 64 " +
        "characters",
      "at",
    );
  }
  return value;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * StateStore write API (design/statestore-write-migration-v0.md).
 *
 * P1b keeps the v0 fact schema frozen: the fact log describes attempts and
 * content-addressed evidence, not arbitrary domain documents. Run manifests,
 * the queue document, the ledger and audit events are therefore written as
 * typed, versioned envelopes into the content-addressed evidence channel and
 * referenced from `attempt.evidence-recorded` facts on synthetic "domain"
 * attempts:
 *
 *   domain.<run|queue|ledger|audit-event|migration>.<sha256(kind, id)[0..40]>
 *
 * The fact log stays small (identity, timestamp and one evidence reference);
 * the bytes are immutable and content-addressed. Replay remains deterministic
 * because the envelope carries every field, including the source timestamp,
 * and synthetic attempt identity is a pure function of `(kind, id)`.
 *
 * This module is the only writer. It does not cut over any consumer: the
 * supervisor, queue and ledger write paths continue to use JSON until their
 * own follow-on tasks.
 *
 * Single-writer discipline: once legacy JSON has been imported, a
 * `StateStoreLegacyGuard` runs before every domain append and fails closed
 * (`StateStoreLegacyDriftError`, `needsHuman`) if the legacy bytes changed.
 * The guard is constructed in `migrate.ts`; the interface lives here so the
 * writer and the migration share one boundary without a cycle.
 *
 * Durability seam: evidence bytes are written just before the fact that
 * references them. `FileEvidenceStore.put` does not fsync its directory, so a
 * crash between the two writes can leave an orphan object (harmless) or a
 * durable reference whose bytes are not yet durable. Reads fail closed with
 * `StateStoreCorruptionError` in the latter case. Closing that seam belongs to
 * the cutover tasks and `store.ts`, which this task must not modify.
 */
import { createHash, randomUUID } from "node:crypto";
import type {
  QueueControlEvent,
} from "../orchestration/event-journal.js";
import { isQueueControlEvent } from "../orchestration/event-journal.js";
import type { QueueDocument } from "../orchestration/queue-store.js";
import type { Ledger } from "../persistence/ledger.js";
import type {
  ActiveRunPointer,
  RunManifest,
} from "../supervisor/types.js";
import {
  StateStoreCorruptionError,
  StateStoreError,
  validateEvidenceRef,
  type EvidenceRef,
  type EvidenceRow,
} from "./schema.js";
import type { StateStore } from "./store.js";

export const STATE_STORE_DOMAIN_ENVELOPE_VERSION = 1 as const;
export const STATE_STORE_JSON_EXPORT_VERSION = 1 as const;
export const STATE_STORE_DOMAIN_MEDIA_TYPE =
  "application/vnd.cliyard.statestore-write+json";

/** Per-object cap aligned with the default `FileEvidenceStore` limit. */
export const MAX_DOMAIN_EVIDENCE_BYTES = 64 * 1024 * 1024;
const MAX_DOMAIN_DEPTH = 64;
const MAX_DOMAIN_NODES = 1_000_000;
const MAX_DOMAIN_ID_LENGTH = 256;
const MAX_TIMESTAMP_LENGTH = 64;

const DOMAIN_ATTEMPT_PREFIX = "domain";
const DEFAULT_WORKSPACE_ID = "domain:local";
const RUNTIME_HANDLE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@/-]*$/;
const WORKSPACE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@/-]*$/;
const CONTROL_CHARACTERS = /[\x00-\x1f\x7f]/;
const RUN_STATUSES: ReadonlySet<string> = new Set([
  "running",
  "interrupted",
  "completed",
  "blocked",
]);

/** Legacy JSON authorities that can be imported into the StateStore. */
export const LEGACY_SOURCE_DOMAINS = [
  "run",
  "queue",
  "ledger",
  "audit-event",
] as const;
export type LegacySourceDomain = (typeof LEGACY_SOURCE_DOMAINS)[number];

/** Envelope domains include the four authorities plus the import marker. */
export const STATE_STORE_DOMAIN_NAMES = [
  ...LEGACY_SOURCE_DOMAINS,
  "migration",
] as const;
export type StateStoreDomainName =
  (typeof STATE_STORE_DOMAIN_NAMES)[number];

export const STATE_STORE_DOMAIN_FACT_KINDS = [
  "run.manifest",
  "run.active",
  "queue.document",
  "ledger.document",
  "audit-event.recorded",
  "migration.imported",
] as const;
export type StateStoreDomainFactKind =
  (typeof STATE_STORE_DOMAIN_FACT_KINDS)[number];

const KIND_DOMAIN: Readonly<
  Record<StateStoreDomainFactKind, StateStoreDomainName>
> = {
  "run.manifest": "run",
  "run.active": "run",
  "queue.document": "queue",
  "ledger.document": "ledger",
  "audit-event.recorded": "audit-event",
  "migration.imported": "migration",
};

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** Base class for write-path and migration failures. */
export class StateStoreWriteError extends StateStoreError {
  constructor(code: string, message: string) {
    super(code, message);
    this.name = "StateStoreWriteError";
  }
}

export class StateStoreWriteValidationError extends StateStoreWriteError {
  readonly path: string | undefined;

  constructor(message: string, path?: string) {
    super(
      "statestore.write.validation",
      path === undefined ? message : `${message} (${path})`,
    );
    this.name = "StateStoreWriteValidationError";
    this.path = path;
  }
}

/**
 * The legacy JSON authority changed after its import snapshot was recorded.
 * This is never resolved silently: a human must decide which source wins and
 * re-baseline the marker. `needsHuman` is the machine-readable signal.
 */
export class StateStoreLegacyDriftError extends StateStoreWriteError {
  readonly domains: LegacySourceDomain[];
  readonly expectedSourceHash: string;
  readonly actualSourceHash: string;
  readonly repoRoot: string | undefined;
  readonly needsHuman = true as const;

  constructor(options: {
    domains: readonly LegacySourceDomain[];
    expectedSourceHash: string;
    actualSourceHash: string;
    repoRoot?: string;
    detail?: string;
  }) {
    super(
      "statestore.write.legacy_drift",
      `legacy JSON drifted after the StateStore import for ` +
        `${options.domains.join(", ") || "no domains"}: source bytes are ` +
        `not the imported snapshot. Refusing to choose a writable authority ` +
        `(needs human).` +
        (options.detail === undefined ? "" : ` ${options.detail}`),
    );
    this.name = "StateStoreLegacyDriftError";
    this.domains = [...options.domains];
    this.expectedSourceHash = options.expectedSourceHash;
    this.actualSourceHash = options.actualSourceHash;
    this.repoRoot = options.repoRoot;
  }
}

/** A write was attempted before the legacy truth was imported. */
export class StateStoreMigrationRequiredError extends StateStoreWriteError {
  readonly domains: LegacySourceDomain[];
  readonly repoRoot: string;

  constructor(repoRoot: string, domains: readonly LegacySourceDomain[]) {
    super(
      "statestore.write.migration_required",
      `legacy JSON for ${domains.join(", ")} has not been imported into the ` +
        `StateStore under ${repoRoot}; migrate before writing (fail closed)`,
    );
    this.name = "StateStoreMigrationRequiredError";
    this.repoRoot = repoRoot;
    this.domains = [...domains];
  }
}

// ---------------------------------------------------------------------------
// Typed domain envelopes
// ---------------------------------------------------------------------------

/** Marker payload proving one import snapshot and its source hashes. */
export interface StateStoreMigrationMarkerSource {
  /** Repo-relative POSIX path of the legacy source. */
  path: string;
  domain: LegacySourceDomain;
  /** Logical source id: runId, "active", "queue", "ledger" or "journal". */
  id: string;
  exists: boolean;
  /** SHA-256 of the raw bytes; null when the source did not exist. */
  contentHash: string | null;
  byteLength: number;
}

/** Alias used by migration code for one raw source reference. */
export type StateStoreMigrationSource = StateStoreMigrationMarkerSource;

export interface StateStoreMigrationCounts {
  runs: number;
  queueItems: number;
  ledgerTasks: number;
  auditEvents: number;
  malformedAuditLines: number;
}

export interface StateStoreMigrationMarker {
  version: typeof STATE_STORE_DOMAIN_ENVELOPE_VERSION;
  importedAt: string;
  /** Normalized (fixed-order, deduplicated) domain scope. */
  domains: LegacySourceDomain[];
  /** Hash over the raw-byte source references. */
  sourceHash: string;
  /** Hash over the canonical parsed truth. */
  contentHash: string;
  /** Hash over `(kind, id, contentHash)` for every imported record. */
  importHash: string;
  sources: StateStoreMigrationSource[];
  counts: StateStoreMigrationCounts;
}

export interface StateStoreDomainPayloadByKind {
  "run.manifest": RunManifest;
  "run.active": ActiveRunPointer;
  "queue.document": QueueDocument;
  "ledger.document": Ledger;
  "audit-event.recorded": QueueControlEvent;
  "migration.imported": StateStoreMigrationMarker;
}

export interface StateStoreDomainEnvelope<
  K extends StateStoreDomainFactKind = StateStoreDomainFactKind,
> {
  version: typeof STATE_STORE_DOMAIN_ENVELOPE_VERSION;
  domain: StateStoreDomainName;
  kind: K;
  id: string;
  /** Domain/source timestamp, not the append wall clock. */
  at: string;
  payload: StateStoreDomainPayloadByKind[K];
}

export interface StateStoreDomainRecordInput<
  K extends StateStoreDomainFactKind,
> {
  kind: K;
  id: string;
  at: string;
  payload: StateStoreDomainPayloadByKind[K];
}

interface EncodedDomainRecordBase<K extends StateStoreDomainFactKind> {
  domain: StateStoreDomainName;
  kind: K;
  id: string;
  at: string;
  payload: StateStoreDomainPayloadByKind[K];
  envelope: StateStoreDomainEnvelope<K>;
  /** Canonical JSON stored byte-for-byte as the evidence object. */
  json: string;
  contentHash: string;
  byteLength: number;
}

/**
 * A validated, canonical, content-addressed domain record that has not yet
 * been appended. `contentHash`/`byteLength` are the evidence reference values.
 */
export type EncodedStateStoreDomainRecord<
  K extends StateStoreDomainFactKind = StateStoreDomainFactKind,
> = {
  [P in K]: EncodedDomainRecordBase<P>;
}[K];

interface StateStoreDomainRecordBase<
  K extends StateStoreDomainFactKind,
> extends EncodedDomainRecordBase<K> {
  /** Fact sequence of the evidence reference. */
  seq: number;
  /** Synthetic attempt that namespaces this logical record. */
  attemptId: string;
  /** Fact timestamp (equals the envelope `at` for writer-produced records). */
  recordedAt: string;
}

/** A domain record read back from the projection and evidence store. */
export type StateStoreDomainRecord<
  K extends StateStoreDomainFactKind = StateStoreDomainFactKind,
> = {
  [P in K]: StateStoreDomainRecordBase<P>;
}[K];

/** Minimal content-addressed evidence seam used by the domain writer. */
export interface StateStoreDomainEvidenceStore {
  put(content: string | Uint8Array, mediaType: string): EvidenceRef;
  read(ref: EvidenceRef): Buffer;
}

/**
 * In-memory reference evidence store for tests and embedding. Production
 * callers use `FileEvidenceStore` from `store.ts`.
 */
export class MemoryDomainEvidenceStore
  implements StateStoreDomainEvidenceStore
{
  private readonly objects = new Map<string, Buffer>();

  put(content: string | Uint8Array, mediaType: string): EvidenceRef {
    const bytes =
      typeof content === "string" ? Buffer.from(content, "utf8") : Buffer.from(content);
    const contentHash = sha256Hex(bytes);
    const ref: EvidenceRef = {
      contentHash,
      byteLength: bytes.byteLength,
      mediaType,
      path: `sha256/${contentHash}`,
    };
    validateEvidenceRef(ref);
    this.objects.set(contentHash, bytes);
    return ref;
  }

  read(ref: EvidenceRef): Buffer {
    const validated = validateEvidenceRef(ref);
    const bytes = this.objects.get(validated.contentHash);
    if (bytes === undefined) {
      throw new StateStoreCorruptionError(
        `domain evidence object ${validated.contentHash} is missing`,
      );
    }
    return Buffer.from(bytes);
  }
}

// ---------------------------------------------------------------------------
// Canonical JSON and hashing
// ---------------------------------------------------------------------------

/**
 * Deterministic JSON: sorted object keys, `undefined` object fields dropped,
 * non-finite numbers normalized to `null`. Mirrors the read-path canonical
 * form so both sides of a comparison agree.
 */
export function canonicalStateStoreJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

export function sha256Hex(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

/** Stable synthetic attempt id for one logical domain record. */
export function domainRecordAttemptId(
  domain: StateStoreDomainName,
  kind: StateStoreDomainFactKind,
  id: string,
): string {
  const digest = sha256Hex(`${kind}|${id}`);
  return `${DOMAIN_ATTEMPT_PREFIX}.${domain}.${digest.slice(0, 40)}`;
}

/** Stable marker id for one import scope. */
export function migrationMarkerId(
  domains: readonly LegacySourceDomain[],
): string {
  return `scope:${domains.join("+")}`;
}

// ---------------------------------------------------------------------------
// Encoding and validation
// ---------------------------------------------------------------------------

export function encodeStateStoreDomainRecord<
  K extends StateStoreDomainFactKind,
>(
  input: StateStoreDomainRecordInput<K>,
): EncodedStateStoreDomainRecord<K> {
  if (
    typeof input !== "object" ||
    input === null ||
    !(STATE_STORE_DOMAIN_FACT_KINDS as readonly string[]).includes(input.kind)
  ) {
    throw new StateStoreWriteValidationError(
      `kind must be one of ${STATE_STORE_DOMAIN_FACT_KINDS.join(", ")}`,
      "kind",
    );
  }
  const domain = KIND_DOMAIN[input.kind];
  const id = validateDomainId(input.id, domain);
  const at = validateDomainTimestamp(input.at, "at");
  const payload = validateDomainPayload(input.kind, input.payload, id);
  assertBoundedJson(payload);
  const envelope: StateStoreDomainEnvelope<K> = {
    version: STATE_STORE_DOMAIN_ENVELOPE_VERSION,
    domain,
    kind: input.kind,
    id,
    at,
    payload: payload as StateStoreDomainPayloadByKind[K],
  };
  const json = canonicalStateStoreJson(envelope);
  const byteLength = Buffer.byteLength(json, "utf8");
  if (byteLength > MAX_DOMAIN_EVIDENCE_BYTES) {
    throw new StateStoreWriteValidationError(
      `domain record is ${byteLength} bytes; the limit is ` +
        `${MAX_DOMAIN_EVIDENCE_BYTES} bytes`,
      "payload",
    );
  }
  return {
    domain,
    kind: input.kind,
    id,
    at,
    payload: envelope.payload,
    envelope,
    json,
    contentHash: sha256Hex(json),
    byteLength,
  };
}

function validateDomainId(
  value: unknown,
  domain: StateStoreDomainName,
): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAX_DOMAIN_ID_LENGTH ||
    value !== value.trim() ||
    CONTROL_CHARACTERS.test(value)
  ) {
    throw new StateStoreWriteValidationError(
      `domain record id must be a non-empty string of at most ` +
        `${MAX_DOMAIN_ID_LENGTH} characters (${domain})`,
      "id",
    );
  }
  return value;
}

function validateDomainTimestamp(value: unknown, path: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAX_TIMESTAMP_LENGTH ||
    value !== value.trim() ||
    Number.isNaN(Date.parse(value))
  ) {
    throw new StateStoreWriteValidationError(
      `timestamp must be a non-empty ISO-8601 string of at most ` +
        `${MAX_TIMESTAMP_LENGTH} characters`,
      path,
    );
  }
  return value;
}

function validateDomainPayload(
  kind: StateStoreDomainFactKind,
  value: unknown,
  id: string,
): StateStoreDomainPayloadByKind[StateStoreDomainFactKind] {
  switch (kind) {
    case "run.manifest":
      return validateRunManifestPayload(value, id);
    case "run.active":
      return validateActiveRunPayload(value, id);
    case "queue.document":
      return validateQueuePayload(value);
    case "ledger.document":
      return validateLedgerPayload(value);
    case "audit-event.recorded":
      return validateAuditEventPayload(value, id);
    case "migration.imported":
      return validateMigrationMarkerPayload(value, id);
  }
  throw new StateStoreWriteValidationError(
    `unknown domain fact kind: ${String(kind)}`,
    "kind",
  );
}

function validateRunManifestPayload(
  value: unknown,
  id: string,
): RunManifest {
  const record = requireRecord(value, "run manifest", "payload");
  if (record.version !== 1) {
    invalid("run manifest version must be 1", "payload.version");
  }
  if (record.runId !== id) {
    invalid(
      `run manifest runId must match the record id ${id}`,
      "payload.runId",
    );
  }
  for (const key of [
    "planId",
    "repoRoot",
    "contractsPath",
    "contractsHash",
    "baseCommit",
    "integrationBranch",
    "integrationHead",
  ] as const) {
    requireText(record[key], `payload.${key}`);
  }
  if (typeof record.status !== "string" || !RUN_STATUSES.has(record.status)) {
    invalid(
      `run manifest status must be one of ${[...RUN_STATUSES].join(", ")}`,
      "payload.status",
    );
  }
  validateDomainTimestamp(record.createdAt, "payload.createdAt");
  validateDomainTimestamp(record.updatedAt, "payload.updatedAt");
  const owner = requireRecord(record.owner, "run owner", "payload.owner");
  if (
    typeof owner.pid !== "number" ||
    !Number.isSafeInteger(owner.pid) ||
    owner.pid < 1
  ) {
    invalid("run owner pid must be a positive integer", "payload.owner.pid");
  }
  requireText(owner.host, "payload.owner.host");
  requireRecord(record.tasks, "run tasks", "payload.tasks");
  return value as RunManifest;
}

function validateActiveRunPayload(
  value: unknown,
  id: string,
): ActiveRunPointer {
  if (id !== "active") {
    invalid("run.active record id must be active", "id");
  }
  const record = requireRecord(value, "active run pointer", "payload");
  if (record.version !== 1) {
    invalid("active run pointer version must be 1", "payload.version");
  }
  requireText(record.runId, "payload.runId");
  validateDomainTimestamp(record.updatedAt, "payload.updatedAt");
  return value as ActiveRunPointer;
}

function validateQueuePayload(value: unknown): QueueDocument {
  const record = requireRecord(value, "queue document", "payload");
  if (record.version !== 1) {
    invalid("queue document version must be 1", "payload.version");
  }
  validateDomainTimestamp(record.updatedAt, "payload.updatedAt");
  const items = record.items;
  if (!Array.isArray(items)) {
    invalid("queue items must be an array", "payload.items");
  }
  items.forEach((item, index) => {
    const entry = requireRecord(
      item,
      "queue item",
      `payload.items[${index}]`,
    );
    requireText(entry.id, `payload.items[${index}].id`);
  });
  return value as QueueDocument;
}

function validateLedgerPayload(value: unknown): Ledger {
  const record = requireRecord(value, "ledger document", "payload");
  requireText(record.path, "payload.path");
  requireRecord(record.tasks, "ledger tasks", "payload.tasks");
  return value as Ledger;
}

function validateAuditEventPayload(
  value: unknown,
  id: string,
): QueueControlEvent {
  if (!isQueueControlEvent(value)) {
    invalid(
      "audit event must be a valid bounded queue control event",
      "payload",
    );
  }
  if (value.eventId !== id) {
    invalid(
      `audit event eventId must match the record id ${id}`,
      "payload.eventId",
    );
  }
  return value;
}

function validateMigrationMarkerPayload(
  value: unknown,
  id: string,
): StateStoreMigrationMarker {
  const record = requireRecord(value, "migration marker", "payload");
  if (record.version !== 1) {
    invalid("migration marker version must be 1", "payload.version");
  }
  validateDomainTimestamp(record.importedAt, "payload.importedAt");
  const domains = normalizeDomainScope(record.domains);
  if (id !== migrationMarkerId(domains)) {
    invalid(
      `migration marker id must be ${migrationMarkerId(domains)}`,
      "id",
    );
  }
  for (const key of [
    "sourceHash",
    "contentHash",
    "importHash",
  ] as const) {
    if (
      typeof record[key] !== "string" ||
      !/^[0-9a-f]{64}$/.test(record[key] as string)
    ) {
      invalid(
        `migration marker ${key} must be a lowercase hex SHA-256 digest`,
        `payload.${key}`,
      );
    }
  }
  const sources = record.sources;
  if (!Array.isArray(sources)) {
    invalid("migration sources must be an array", "payload.sources");
  }
  sources.forEach((source, index) => {
    const path = `payload.sources[${index}]`;
    const entry = requireRecord(source, "migration source", path);
    requireText(entry.path, `${path}.path`);
    if (!(LEGACY_SOURCE_DOMAINS as readonly string[]).includes(
      entry.domain as string,
    )) {
      invalid(
        `migration source domain must be one of ` +
          `${LEGACY_SOURCE_DOMAINS.join(", ")}`,
        `${path}.domain`,
      );
    }
    requireText(entry.id, `${path}.id`);
    if (typeof entry.exists !== "boolean") {
      invalid("migration source exists must be a boolean", `${path}.exists`);
    }
    if (entry.exists) {
      if (
        typeof entry.contentHash !== "string" ||
        !/^[0-9a-f]{64}$/.test(entry.contentHash)
      ) {
        invalid(
          "migration source contentHash must be a lowercase hex SHA-256 digest",
          `${path}.contentHash`,
        );
      }
      if (
        typeof entry.byteLength !== "number" ||
        !Number.isSafeInteger(entry.byteLength) ||
        entry.byteLength < 0
      ) {
        invalid(
          "migration source byteLength must be a non-negative integer",
          `${path}.byteLength`,
        );
      }
    } else if (
      entry.contentHash !== null ||
      entry.byteLength !== 0
    ) {
      invalid(
        "a missing migration source must have contentHash null and byteLength 0",
        path,
      );
    }
  });
  const counts = requireRecord(
    record.counts,
    "migration counts",
    "payload.counts",
  );
  for (const key of [
    "runs",
    "queueItems",
    "ledgerTasks",
    "auditEvents",
    "malformedAuditLines",
  ] as const) {
    if (
      typeof counts[key] !== "number" ||
      !Number.isSafeInteger(counts[key]) ||
      (counts[key] as number) < 0
    ) {
      invalid(
        `migration count ${key} must be a non-negative integer`,
        `payload.counts.${key}`,
      );
    }
  }
  return value as StateStoreMigrationMarker;
}

/**
 * Normalize a domain scope: dedupe, reject unknown domains, and sort in the
 * canonical declaration order so hashes and marker ids are stable.
 */
export function normalizeDomainScope(
  value: unknown,
): LegacySourceDomain[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new StateStoreWriteValidationError(
      "domains must be a non-empty array",
      "domains",
    );
  }
  const selected = new Set<LegacySourceDomain>();
  for (const domain of value) {
    if (
      typeof domain !== "string" ||
      !(LEGACY_SOURCE_DOMAINS as readonly string[]).includes(domain)
    ) {
      throw new StateStoreWriteValidationError(
        `domains must contain only ${LEGACY_SOURCE_DOMAINS.join(", ")}`,
        "domains",
      );
    }
    selected.add(domain as LegacySourceDomain);
  }
  return LEGACY_SOURCE_DOMAINS.filter((domain) => selected.has(domain));
}

// ---------------------------------------------------------------------------
// Writer
// ---------------------------------------------------------------------------

/** Pre-append seam that makes legacy JSON drift fail closed. */
export interface StateStoreLegacyGuard {
  readonly domains: readonly LegacySourceDomain[];
  /** Throws when the import marker is missing or source bytes changed. */
  assertUnchanged(): void;
}

export interface StateStoreDomainWriterOptions {
  store: StateStore;
  evidence: StateStoreDomainEvidenceStore;
  /** Host boundary clock; defaults to `new Date().toISOString()`. */
  clock?: () => string;
  /** Host boundary event id; defaults to the store event-id provider. */
  newEventId?: () => string;
  /** Stable identity namespace for synthetic attempts. */
  workspaceId?: string;
  /** Optional drift guard invoked before every domain append. */
  legacyGuard?: StateStoreLegacyGuard;
}

export interface StateStoreDomainAppendOptions {
  /** Boundary override; defaults to the writer clock. */
  at?: string;
  /**
   * Optimistic concurrency against the sequence the caller observed before
   * this call. A synthesized `attempt.started` consumes one sequence, so the
   * evidence append then uses `expectedSeq + 1`.
   */
  expectedSeq?: number;
  /** Boundary override for the evidence fact event id. */
  eventId?: string;
}

export interface StateStoreDomainAppendResult {
  seq: number;
  eventId: string;
  recordedAt: string;
  attemptId: string;
  createdAttempt: boolean;
  domain: StateStoreDomainName;
  kind: StateStoreDomainFactKind;
  id: string;
  at: string;
  contentHash: string;
  byteLength: number;
}

/**
 * Typed writer for the four legacy JSON domains plus import markers.
 *
 * All writes are append-only. Re-appending the same content is idempotent at
 * the logical level: the evidence object and fact are duplicated, and the
 * projection keeps the latest reference for that logical record.
 */
export class StateStoreDomainWriter {
  readonly store: StateStore;
  readonly evidence: StateStoreDomainEvidenceStore;
  private readonly clock: () => string;
  private readonly newEventId: () => string;
  private readonly workspaceId: string;
  private legacyGuard: StateStoreLegacyGuard | undefined;
  private readonly knownAttempts = new Set<string>();

  constructor(options: StateStoreDomainWriterOptions) {
    if (
      typeof options !== "object" ||
      options === null ||
      options.store === undefined
    ) {
      throw new StateStoreWriteValidationError(
        "writer requires a StateStore",
        "options.store",
      );
    }
    if (
      options.evidence === undefined ||
      typeof options.evidence.put !== "function" ||
      typeof options.evidence.read !== "function"
    ) {
      throw new StateStoreWriteValidationError(
        "writer requires an evidence store with put/read",
        "options.evidence",
      );
    }
    const workspaceId = options.workspaceId ?? DEFAULT_WORKSPACE_ID;
    if (
      typeof workspaceId !== "string" ||
      workspaceId.length === 0 ||
      workspaceId.length > 256 ||
      workspaceId !== workspaceId.trim() ||
      !WORKSPACE_ID_PATTERN.test(workspaceId)
    ) {
      throw new StateStoreWriteValidationError(
        "workspaceId contains unsupported characters",
        "options.workspaceId",
      );
    }
    this.store = options.store;
    this.evidence = options.evidence;
    this.clock = options.clock ?? (() => new Date().toISOString());
    this.newEventId = options.newEventId ?? randomUUID;
    this.workspaceId = workspaceId;
    this.legacyGuard = options.legacyGuard;
    for (const attempt of this.store.snapshot().attempts) {
      this.knownAttempts.add(attempt.attemptId);
    }
  }

  /** Install, replace or clear the legacy drift guard. */
  setLegacyGuard(guard: StateStoreLegacyGuard | undefined): void {
    this.legacyGuard = guard;
  }

  getLegacyGuard(): StateStoreLegacyGuard | undefined {
    return this.legacyGuard;
  }

  appendRunManifest(
    manifest: RunManifest,
    options: StateStoreDomainAppendOptions = {},
  ): StateStoreDomainAppendResult {
    return this.appendTyped(
      "run.manifest",
      manifest.runId,
      manifest,
      options,
    );
  }

  appendActiveRun(
    pointer: ActiveRunPointer,
    options: StateStoreDomainAppendOptions = {},
  ): StateStoreDomainAppendResult {
    return this.appendTyped("run.active", "active", pointer, options);
  }

  appendQueue(
    document: QueueDocument,
    options: StateStoreDomainAppendOptions = {},
  ): StateStoreDomainAppendResult {
    return this.appendTyped("queue.document", "queue", document, options);
  }

  appendLedger(
    ledger: Ledger,
    options: StateStoreDomainAppendOptions = {},
  ): StateStoreDomainAppendResult {
    return this.appendTyped("ledger.document", "ledger", ledger, options);
  }

  appendAuditEvent(
    event: QueueControlEvent,
    options: StateStoreDomainAppendOptions = {},
  ): StateStoreDomainAppendResult {
    const encoded = encodeStateStoreDomainRecord({
      kind: "audit-event.recorded",
      id: event.eventId,
      at: options.at ?? this.clock(),
      payload: event,
    });
    // Event ids are immutable journal identities. Re-recording the same bytes
    // is idempotent; a different body under the same id would make the audit
    // projection ambiguous, so it is rejected before any fact is appended.
    const attemptId = domainRecordAttemptId(
      encoded.domain,
      encoded.kind,
      encoded.id,
    );
    const conflicting = this.store
      .evidence(attemptId)
      .some(
        (row) =>
          row.mediaType === STATE_STORE_DOMAIN_MEDIA_TYPE &&
          row.contentHash !== encoded.contentHash,
      );
    if (conflicting) {
      throw new StateStoreWriteValidationError(
        `audit event ${event.eventId} was already recorded with different ` +
          "content",
        "eventId",
      );
    }
    return this.appendRecord(encoded, options);
  }

  appendMigrationMarker(
    marker: StateStoreMigrationMarker,
    options: StateStoreDomainAppendOptions = {},
  ): StateStoreDomainAppendResult {
    const domains = normalizeDomainScope(marker.domains);
    return this.appendTyped(
      "migration.imported",
      migrationMarkerId(domains),
      { ...marker, domains },
      options,
    );
  }

  /**
   * Append a pre-encoded record. The record is re-encoded first, so a caller
   * cannot smuggle bytes that do not match their declared kind/id/payload.
   */
  appendRecord<K extends StateStoreDomainFactKind>(
    record: EncodedStateStoreDomainRecord<K>,
    options: StateStoreDomainAppendOptions = {},
  ): StateStoreDomainAppendResult {
    const reencoded = encodeStateStoreDomainRecord({
      kind: record.kind,
      id: record.id,
      at: record.at,
      payload: record.payload,
    });
    if (
      reencoded.json !== record.json ||
      reencoded.contentHash !== record.contentHash ||
      reencoded.byteLength !== record.byteLength
    ) {
      throw new StateStoreWriteValidationError(
        "encoded domain record does not match its canonical content hash",
        "record",
      );
    }
    return this.appendEncoded(reencoded, options);
  }

  /** True when the exact content is already referenced by the store. */
  recordExists<K extends StateStoreDomainFactKind>(
    record: EncodedStateStoreDomainRecord<K>,
  ): boolean {
    const reencoded = encodeStateStoreDomainRecord({
      kind: record.kind,
      id: record.id,
      at: record.at,
      payload: record.payload,
    });
    const attemptId = domainRecordAttemptId(
      reencoded.domain,
      reencoded.kind,
      reencoded.id,
    );
    return this.store
      .evidence(attemptId)
      .some((row) => row.contentHash === reencoded.contentHash);
  }

  private appendTyped<K extends StateStoreDomainFactKind>(
    kind: K,
    id: string,
    payload: StateStoreDomainPayloadByKind[K],
    options: StateStoreDomainAppendOptions,
  ): StateStoreDomainAppendResult {
    const at = options.at ?? this.clock();
    return this.appendRecord(
      encodeStateStoreDomainRecord({ kind, id, at, payload }),
      options,
    );
  }

  private appendEncoded<K extends StateStoreDomainFactKind>(
    record: EncodedStateStoreDomainRecord<K>,
    options: StateStoreDomainAppendOptions,
  ): StateStoreDomainAppendResult {
    this.legacyGuard?.assertUnchanged();
    const attemptId = domainRecordAttemptId(
      record.domain,
      record.kind,
      record.id,
    );
    const createdAttempt = !this.knownAttempts.has(attemptId);
    let evidenceExpectedSeq = options.expectedSeq;
    if (createdAttempt) {
      // The identity start and the evidence append are two store transactions
      // (the v0 seam exposes no multi-append transaction). The start is
      // idempotent, so a failed evidence append leaves only an unused
      // synthetic attempt; the next append reuses it.
      this.store.append(
        {
          kind: "attempt.started",
          attemptId,
          payload: {
            backendType: "process-group",
            runtimeHandle: `${DOMAIN_ATTEMPT_PREFIX}:${record.domain}:${sha256Hex(
              `${record.kind}|${record.id}`,
            ).slice(0, 40)}`,
            workspaceId: this.workspaceId,
            desiredState: "stopped",
            leaseDeadline: null,
          },
        },
        {
          at: record.at,
          eventId: this.newEventId(),
          expectedSeq: options.expectedSeq,
        },
      );
      this.knownAttempts.add(attemptId);
      if (options.expectedSeq !== undefined) {
        evidenceExpectedSeq = options.expectedSeq + 1;
      }
    }

    const ref = this.evidence.put(
      record.json,
      STATE_STORE_DOMAIN_MEDIA_TYPE,
    );
    if (
      ref.contentHash !== record.contentHash ||
      ref.byteLength !== record.byteLength
    ) {
      throw new StateStoreCorruptionError(
        `evidence store returned ${ref.contentHash}/${ref.byteLength} for ` +
          `domain record ${record.kind} ${record.id}; expected ` +
          `${record.contentHash}/${record.byteLength}`,
      );
    }

    const fact = this.store.append(
      {
        kind: "attempt.evidence-recorded",
        attemptId,
        payload: { evidence: [ref] },
      },
      {
        at: record.at,
        eventId: options.eventId ?? this.newEventId(),
        expectedSeq: evidenceExpectedSeq,
      },
    );
    return {
      seq: fact.seq,
      eventId: fact.eventId,
      recordedAt: fact.at,
      attemptId,
      createdAttempt,
      domain: record.domain,
      kind: record.kind,
      id: record.id,
      at: record.at,
      contentHash: record.contentHash,
      byteLength: record.byteLength,
    };
  }
}

// ---------------------------------------------------------------------------
// Reader, projection and read-only JSON export
// ---------------------------------------------------------------------------

export interface StateStoreDomainReadOptions {
  store: StateStore;
  evidence: StateStoreDomainEvidenceStore;
}

/**
 * Read every valid domain record from the projection, re-hashing each evidence
 * object. A missing object, byte-length mismatch or hash mismatch fails closed
 * with `StateStoreCorruptionError`; corrupted records are never skipped.
 */
export function readStateStoreDomainRecords(
  options: StateStoreDomainReadOptions,
): StateStoreDomainRecord[] {
  const { store, evidence } = options;
  if (store === undefined || evidence === undefined) {
    throw new StateStoreWriteValidationError(
      "read requires a StateStore and an evidence store",
      "options",
    );
  }
  const snapshot = store.snapshot();
  const rows: EvidenceRow[] = snapshot.evidence.filter(
    (row) => row.mediaType === STATE_STORE_DOMAIN_MEDIA_TYPE,
  );
  const records: StateStoreDomainRecord[] = [];
  for (const row of rows) {
    records.push(readDomainRecord(row, evidence));
  }
  records.sort((left, right) => left.seq - right.seq);
  return records;
}

function readDomainRecord(
  row: EvidenceRow,
  evidence: StateStoreDomainEvidenceStore,
): StateStoreDomainRecord {
  const ref: EvidenceRef = {
    contentHash: row.contentHash,
    byteLength: row.byteLength,
    mediaType: row.mediaType,
    path: row.path,
  };
  const bytes = evidence.read(ref);
  if (
    bytes.byteLength !== row.byteLength ||
    sha256Hex(bytes) !== row.contentHash
  ) {
    throw new StateStoreCorruptionError(
      `domain evidence ${row.contentHash} failed its content check`,
      row.seq,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString("utf8")) as unknown;
  } catch {
    throw new StateStoreCorruptionError(
      `domain evidence ${row.contentHash} is not valid JSON`,
      row.seq,
    );
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    Array.isArray(parsed)
  ) {
    throw new StateStoreCorruptionError(
      `domain evidence ${row.contentHash} is not an object`,
      row.seq,
    );
  }
  const envelope = parsed as Record<string, unknown>;
  if (envelope.version !== STATE_STORE_DOMAIN_ENVELOPE_VERSION) {
    throw new StateStoreCorruptionError(
      `domain evidence ${row.contentHash} has unsupported envelope version ` +
        `${String(envelope.version)}`,
      row.seq,
    );
  }
  const kind = envelope.kind;
  if (
    typeof kind !== "string" ||
    !(STATE_STORE_DOMAIN_FACT_KINDS as readonly string[]).includes(kind)
  ) {
    throw new StateStoreCorruptionError(
      `domain evidence ${row.contentHash} has an unknown kind`,
      row.seq,
    );
  }
  const domain = KIND_DOMAIN[kind as StateStoreDomainFactKind];
  if (envelope.domain !== domain) {
    throw new StateStoreCorruptionError(
      `domain evidence ${row.contentHash} names domain ` +
        `${String(envelope.domain)} for kind ${kind}`,
      row.seq,
    );
  }
  const expectedAttempt = domainRecordAttemptId(
    domain,
    kind as StateStoreDomainFactKind,
    typeof envelope.id === "string" ? envelope.id : "",
  );
  if (expectedAttempt !== row.attemptId) {
    throw new StateStoreCorruptionError(
      `domain evidence ${row.contentHash} is attached to attempt ` +
        `${row.attemptId}; expected ${expectedAttempt}`,
      row.seq,
    );
  }
  let encoded: EncodedStateStoreDomainRecord;
  try {
    encoded = encodeStateStoreDomainRecord({
      kind: kind as StateStoreDomainFactKind,
      id: envelope.id as string,
      at: envelope.at as string,
      payload: envelope.payload as never,
    });
  } catch (error) {
    throw new StateStoreCorruptionError(
      `domain evidence ${row.contentHash} is invalid: ` +
        `${error instanceof Error ? error.message : String(error)}`,
      row.seq,
    );
  }
  if (encoded.json !== bytes.toString("utf8")) {
    throw new StateStoreCorruptionError(
      `domain evidence ${row.contentHash} is not stored in canonical form`,
      row.seq,
    );
  }
  return {
    ...encoded,
    seq: row.seq,
    attemptId: row.attemptId,
    recordedAt: row.recordedAt,
  } as StateStoreDomainRecord;
}

/** Latest state per logical record, derived from the append order. */
export interface StateStoreDomainState {
  runs: RunManifest[];
  activeRun: ActiveRunPointer | null;
  queue: QueueDocument | null;
  ledger: Ledger | null;
  auditEvents: QueueControlEvent[];
  migrationMarkers: StateStoreMigrationMarker[];
}

export function projectStateStoreDomainRecords(
  records: readonly StateStoreDomainRecord[],
): StateStoreDomainState {
  const ordered = [...records].sort((left, right) => left.seq - right.seq);
  const runs = new Map<string, RunManifest>();
  let activeRun: ActiveRunPointer | null = null;
  let queue: QueueDocument | null = null;
  let ledger: Ledger | null = null;
  const auditEvents: QueueControlEvent[] = [];
  const auditByEventId = new Map<string, string>();
  const markers = new Map<string, StateStoreMigrationMarker>();

  for (const record of ordered) {
    switch (record.kind) {
      case "run.manifest":
        runs.set(record.id, record.payload);
        break;
      case "run.active":
        activeRun = record.payload;
        break;
      case "queue.document":
        queue = record.payload;
        break;
      case "ledger.document":
        ledger = record.payload;
        break;
      case "audit-event.recorded": {
        const canonical = canonicalStateStoreJson(record.payload);
        const prior = auditByEventId.get(record.payload.eventId);
        if (prior !== undefined && prior !== canonical) {
          throw new StateStoreCorruptionError(
            `audit event ${record.payload.eventId} was appended with ` +
              "conflicting content",
            record.seq,
          );
        }
        if (prior === undefined) {
          auditByEventId.set(record.payload.eventId, canonical);
          auditEvents.push(record.payload);
        }
        break;
      }
      case "migration.imported": {
        const id = migrationMarkerId(record.payload.domains);
        const prior = markers.get(id);
        if (
          prior !== undefined &&
          record.payload.importedAt < prior.importedAt
        ) {
          break;
        }
        markers.set(id, record.payload);
        break;
      }
    }
  }

  return {
    runs: [...runs.values()].sort((left, right) =>
      left.runId < right.runId ? -1 : left.runId > right.runId ? 1 : 0,
    ),
    activeRun,
    queue,
    ledger,
    auditEvents,
    migrationMarkers: [...markers.values()].sort((left, right) =>
      migrationMarkerId(left.domains) < migrationMarkerId(right.domains)
        ? -1
        : 1,
    ),
  };
}

export interface StateStoreJsonExport {
  version: typeof STATE_STORE_JSON_EXPORT_VERSION;
  /** Tooling may read this file; it must never treat it as writable truth. */
  readOnly: true;
  exportedAt: string;
  runs: RunManifest[];
  activeRun: ActiveRunPointer | null;
  queue: QueueDocument | null;
  ledger: Ledger | null;
  auditEvents: QueueControlEvent[];
  migrationMarkers: StateStoreMigrationMarker[];
}

export interface ExportStateStoreJsonOptions
  extends StateStoreDomainReadOptions {
  /** Boundary timestamp for `exportedAt`; defaults to host now. */
  at?: string;
}

/** Read-only projection export for tools that still consume JSON files. */
export function exportStateStoreJson(
  options: ExportStateStoreJsonOptions,
): StateStoreJsonExport {
  const state = projectStateStoreDomainRecords(
    readStateStoreDomainRecords(options),
  );
  const at = options.at ?? new Date().toISOString();
  return {
    version: STATE_STORE_JSON_EXPORT_VERSION,
    readOnly: true,
    exportedAt: validateDomainTimestamp(at, "at"),
    runs: state.runs,
    activeRun: state.activeRun,
    queue: state.queue,
    ledger: state.ledger,
    auditEvents: state.auditEvents,
    migrationMarkers: state.migrationMarkers,
  };
}

export interface StateStoreJsonExportFile {
  /** Repo-relative POSIX path (the legacy layout). */
  relativePath: string;
  content: string;
  readOnly: true;
}

/**
 * Convert an export into the legacy file layout, in memory. Nothing is written
 * to disk: tooling compatibility must not recreate a second write authority.
 */
export function exportStateStoreJsonFiles(
  exported: StateStoreJsonExport,
): StateStoreJsonExportFile[] {
  const files: StateStoreJsonExportFile[] = [];
  for (const run of exported.runs) {
    files.push({
      relativePath: `.cliyard/runs/${run.runId}.json`,
      content: `${JSON.stringify(run, null, 2)}\n`,
      readOnly: true,
    });
  }
  if (exported.activeRun !== null) {
    files.push({
      relativePath: ".cliyard/runs/active.json",
      content: `${JSON.stringify(exported.activeRun, null, 2)}\n`,
      readOnly: true,
    });
  }
  if (exported.queue !== null) {
    files.push({
      relativePath: ".cliyard/queue.json",
      content: `${JSON.stringify(exported.queue, null, 2)}\n`,
      readOnly: true,
    });
  }
  if (exported.ledger !== null) {
    files.push({
      relativePath: ".cliyard/ledger.json",
      content: `${JSON.stringify(exported.ledger, null, 2)}\n`,
      readOnly: true,
    });
  }
  if (exported.auditEvents.length > 0) {
    files.push({
      relativePath: ".cliyard/queue-events/events.jsonl",
      content: exported.auditEvents
        .map((event) => `${JSON.stringify(event)}\n`)
        .join(""),
      readOnly: true,
    });
  }
  return files;
}

// ---------------------------------------------------------------------------
// Serialization helpers
// ---------------------------------------------------------------------------

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

/**
 * Reject values that JSON would silently change: cycles, class instances,
 * functions/symbols/bigints and non-finite numbers. `undefined` is allowed and
 * dropped exactly like `JSON.stringify`.
 */
function assertBoundedJson(value: unknown): void {
  let nodes = 0;
  const stack = new Set<object>();
  const walk = (entry: unknown, depth: number, path: string): void => {
    nodes += 1;
    if (nodes > MAX_DOMAIN_NODES) {
      invalid(
        `domain payload exceeds ${MAX_DOMAIN_NODES} values`,
        "payload",
      );
    }
    if (depth > MAX_DOMAIN_DEPTH) {
      invalid(
        `domain payload exceeds ${MAX_DOMAIN_DEPTH} levels`,
        "payload",
      );
    }
    if (
      entry === null ||
      entry === undefined ||
      typeof entry === "string" ||
      typeof entry === "boolean"
    ) {
      return;
    }
    if (typeof entry === "number") {
      if (!Number.isFinite(entry)) {
        invalid("domain payload numbers must be finite", path);
      }
      return;
    }
    if (typeof entry !== "object") {
      invalid(
        `domain payload contains an unsupported ${typeof entry} value`,
        path,
      );
    }
    const object = entry as object;
    if (stack.has(object)) {
      invalid("domain payload contains a cycle", path);
    }
    stack.add(object);
    try {
      if (Array.isArray(object)) {
        object.forEach((child, index) => {
          walk(child, depth + 1, `${path}[${index}]`);
        });
        return;
      }
      const prototype = Object.getPrototypeOf(object);
      if (prototype !== Object.prototype && prototype !== null) {
        invalid(
          "domain payload objects must be plain JSON objects",
          path,
        );
      }
      for (const [key, child] of Object.entries(object)) {
        walk(child, depth + 1, `${path}.${key}`);
      }
    } finally {
      stack.delete(object);
    }
  };
  walk(value, 0, "payload");
}

function requireRecord(
  value: unknown,
  label: string,
  path: string,
): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    invalid(`${label} must be an object`, path);
  }
  return value as Record<string, unknown>;
}

function requireText(value: unknown, path: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value !== value.trim() ||
    CONTROL_CHARACTERS.test(value)
  ) {
    invalid("value must be a non-empty string without control characters", path);
  }
  return value;
}

function invalid(message: string, path?: string): never {
  throw new StateStoreWriteValidationError(message, path);
}

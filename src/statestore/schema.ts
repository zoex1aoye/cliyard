/**
 * StateStore v0 durable schema and bounded identity contract
 * (design/statestore-v0.md).
 *
 * The append-only fact log is the authority. Projection tables are derived and
 * may be discarded and rebuilt from the log whenever their format changes.
 *
 * Identity is `(attemptId, backendType, runtimeHandle, workspaceId)`.
 * `pid`/`pgid` are diagnostic observations only and must never be used to
 * match, adopt, supervise or kill a runtime. A runtime handle (launchd label,
 * systemd unit, Job Object id, process-group handle, ...) is the stable
 * authority; process ids can be reused by the OS.
 *
 * This module is pure: it validates values and describes storage. It never
 * reads the system clock, randomness or any existing JSON store.
 */

export const FACT_LOG_FORMAT_VERSION = 1 as const;
export const PROJECTION_FORMAT_VERSION = 1 as const;

/** Meta keys shared with the driver implementations. */
export const META_FACT_LOG_FORMAT = "factLogFormat";
export const META_PROJECTION_FORMAT = "projectionFormat";
export const META_PROJECTION_SEQ = "projectionSeq";

export const MAX_SEQ = Number.MAX_SAFE_INTEGER;
export const MAX_ATTEMPT_ID_LENGTH = 128;
export const MAX_EVENT_ID_LENGTH = 128;
export const MAX_RUNTIME_HANDLE_LENGTH = 256;
export const MAX_WORKSPACE_ID_LENGTH = 256;
export const MAX_TIMESTAMP_LENGTH = 64;
export const MAX_EVIDENCE_MEDIA_TYPE_LENGTH = 128;
export const MAX_EVIDENCE_PATH_LENGTH = 512;
export const MAX_EVIDENCE_REFS_PER_FACT = 64;
/** 1 TiB; larger artifacts belong outside the evidence directory as refs. */
export const MAX_EVIDENCE_BYTES = 1024 * 1024 * 1024 * 1024;
/**
 * Defense in depth: the payload holds structured facts and content-addressed
 * evidence refs only. Evidence bytes live in the content-addressed file store.
 */
export const MAX_FACT_PAYLOAD_BYTES = 32 * 1024;
/** Largest 32-bit process/group id; diagnostics are never identity. */
export const MAX_DIAGNOSTIC_ID = 2_147_483_647;

const ATTEMPT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const EVENT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const RUNTIME_HANDLE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@/-]*$/;
const WORKSPACE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@/-]*$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const MEDIA_TYPE_PATTERN =
  /^[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]{0,63}\/[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]{0,63}$/;
const EVIDENCE_PATH_SEGMENT = /^[A-Za-z0-9._-]+$/;
const CONTROL_CHARACTERS = /[\x00-\x1f\x7f]/;

export const EXECUTION_BACKEND_TYPES = [
  "process-group",
  "launchd",
  "systemd",
  "job-object",
  "microvm",
  "container",
] as const;
export type ExecutionBackendType =
  (typeof EXECUTION_BACKEND_TYPES)[number];

export const ATTEMPT_DESIRED_STATES = ["running", "stopped"] as const;
export type AttemptDesiredState = (typeof ATTEMPT_DESIRED_STATES)[number];

export const ATTEMPT_OBSERVED_STATES = [
  "unknown",
  "starting",
  "running",
  "stopping",
  "exited",
  "stopped",
  "lost",
] as const;
export type AttemptObservedState = (typeof ATTEMPT_OBSERVED_STATES)[number];

export const FACT_KINDS = [
  "attempt.started",
  "attempt.desired-state-changed",
  "attempt.observed-state-changed",
  "attempt.evidence-recorded",
] as const;
export type FactKind = (typeof FACT_KINDS)[number];

export interface AttemptDiagnostics {
  /** Diagnostic only. Never identity, supervision authority or a kill target. */
  pid: number | null;
  /** Diagnostic only. Never identity, supervision authority or a kill target. */
  pgid: number | null;
}

/** A reference to bytes stored in content-addressed evidence files. */
export interface EvidenceRef {
  /** Lowercase hex SHA-256 of the evidence bytes. */
  contentHash: string;
  byteLength: number;
  mediaType: string;
  /** Normalized relative path such as `sha256/<hash>`. */
  path: string;
}

export interface AttemptStartedPayload {
  backendType: ExecutionBackendType;
  runtimeHandle: string;
  workspaceId: string;
  desiredState: AttemptDesiredState;
  leaseDeadline: string | null;
}

export interface DesiredStateChangedPayload {
  desiredState: AttemptDesiredState;
  /** Absent keeps the current deadline; `null` clears it. */
  leaseDeadline?: string | null;
}

export interface ObservedStateChangedPayload {
  observedState: AttemptObservedState;
  /** Absent keeps the previous diagnostic values. */
  diagnostics?: AttemptDiagnostics;
}

export interface EvidenceRecordedPayload {
  evidence: EvidenceRef[];
}

export interface FactPayloadByKind {
  "attempt.started": AttemptStartedPayload;
  "attempt.desired-state-changed": DesiredStateChangedPayload;
  "attempt.observed-state-changed": ObservedStateChangedPayload;
  "attempt.evidence-recorded": EvidenceRecordedPayload;
}
export type FactPayload<K extends FactKind = FactKind> =
  FactPayloadByKind[K];

/** A fact exactly as validated and applied to the projection. */
interface StoredFactBase<K extends FactKind> {
  seq: number;
  eventId: string;
  /** Caller-supplied timestamp; the kernel never reads the clock. */
  at: string;
  kind: K;
  attemptId: string;
  payload: FactPayloadByKind[K];
}
export type StoredFact = {
  [K in FactKind]: StoredFactBase<K>;
}[FactKind];

/** Append input for `attempt.started`; normalization fills the defaults. */
export interface AttemptStartedInput {
  backendType: ExecutionBackendType;
  runtimeHandle: string;
  workspaceId: string;
  desiredState?: AttemptDesiredState;
  leaseDeadline?: string | null;
}

export interface FactInputByKind {
  "attempt.started": AttemptStartedInput;
  "attempt.desired-state-changed": DesiredStateChangedPayload;
  "attempt.observed-state-changed": ObservedStateChangedPayload;
  "attempt.evidence-recorded": EvidenceRecordedPayload;
}
export type FactInput<K extends FactKind = FactKind> = FactInputByKind[K];

/** A validated append request (validation fills defaults and bounds). */
export type AppendFactInput = {
  [K in FactKind]: {
    kind: K;
    attemptId: string;
    payload: FactInputByKind[K];
  };
}[FactKind];

/** Raw fact shape exchanged with drivers; `payload` is re-validated on read. */
export interface PersistedFact {
  seq: number;
  eventId: string;
  at: string;
  kind: string;
  attemptId: string;
  payload: unknown;
}

/** Derived row for one attempt. PID/PGID are diagnostics, not identity. */
export interface AttemptRow {
  attemptId: string;
  backendType: ExecutionBackendType;
  runtimeHandle: string;
  workspaceId: string;
  desiredState: AttemptDesiredState;
  observedState: AttemptObservedState;
  leaseDeadline: string | null;
  diagnostics: AttemptDiagnostics;
  updatedAt: string;
  lastSeq: number;
}

/** Derived row for one content-addressed evidence reference. */
export interface EvidenceRow {
  attemptId: string;
  contentHash: string;
  byteLength: number;
  mediaType: string;
  path: string;
  recordedAt: string;
  seq: number;
}

export class StateStoreError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "StateStoreError";
    this.code = code;
  }
}

export class StateStoreValidationError extends StateStoreError {
  readonly path: string | undefined;

  constructor(message: string, path?: string) {
    super(
      "statestore.validation",
      path === undefined ? message : `${message} (${path})`,
    );
    this.name = "StateStoreValidationError";
    this.path = path;
  }
}

export class StateStoreCorruptionError extends StateStoreError {
  readonly seq: number | undefined;

  constructor(message: string, seq?: number) {
    super("statestore.corrupt", message);
    this.name = "StateStoreCorruptionError";
    this.seq = seq;
  }
}

export class SequenceConflictError extends StateStoreError {
  readonly expectedSeq: number;
  readonly actualSeq: number;

  constructor(expectedSeq: number, actualSeq: number) {
    super(
      "statestore.sequence_conflict",
      `expected fact sequence ${expectedSeq} but the log is at ${actualSeq}`,
    );
    this.name = "SequenceConflictError";
    this.expectedSeq = expectedSeq;
    this.actualSeq = actualSeq;
  }
}

export class AttemptIdentityConflictError extends StateStoreError {
  readonly attemptId: string;

  constructor(attemptId: string, detail: string) {
    super(
      "statestore.identity_conflict",
      `attempt ${attemptId} stable identity conflict: ${detail}`,
    );
    this.name = "AttemptIdentityConflictError";
    this.attemptId = attemptId;
  }
}

export class UnknownAttemptError extends StateStoreError {
  readonly attemptId: string;

  constructor(attemptId: string) {
    super(
      "statestore.unknown_attempt",
      `attempt ${attemptId} has not been started in this fact log`,
    );
    this.name = "UnknownAttemptError";
    this.attemptId = attemptId;
  }
}

export class StateStoreDriverUnavailableError extends StateStoreError {
  constructor(message: string) {
    super("statestore.driver_unavailable", message);
    this.name = "StateStoreDriverUnavailableError";
  }
}

export class StateStoreClosedError extends StateStoreError {
  constructor() {
    super("statestore.closed", "the StateStore or its driver is closed");
    this.name = "StateStoreClosedError";
  }
}

export function isExecutionBackendType(
  value: unknown,
): value is ExecutionBackendType {
  return (
    typeof value === "string" &&
    (EXECUTION_BACKEND_TYPES as readonly string[]).includes(value)
  );
}

export function isAttemptDesiredState(
  value: unknown,
): value is AttemptDesiredState {
  return (
    typeof value === "string" &&
    (ATTEMPT_DESIRED_STATES as readonly string[]).includes(value)
  );
}

export function isAttemptObservedState(
  value: unknown,
): value is AttemptObservedState {
  return (
    typeof value === "string" &&
    (ATTEMPT_OBSERVED_STATES as readonly string[]).includes(value)
  );
}

export function isFactKind(value: unknown): value is FactKind {
  return (
    typeof value === "string" &&
    (FACT_KINDS as readonly string[]).includes(value)
  );
}

export function validateAttemptId(
  value: unknown,
  path = "attemptId",
): string {
  return boundedText(
    value,
    "attemptId",
    MAX_ATTEMPT_ID_LENGTH,
    ATTEMPT_ID_PATTERN,
    path,
  );
}

export function validateEventId(
  value: unknown,
  path = "eventId",
): string {
  return boundedText(
    value,
    "eventId",
    MAX_EVENT_ID_LENGTH,
    EVENT_ID_PATTERN,
    path,
  );
}

export function validateTimestamp(value: unknown, path = "at"): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAX_TIMESTAMP_LENGTH ||
    value !== value.trim() ||
    Number.isNaN(Date.parse(value))
  ) {
    invalid(
      `timestamp must be a non-empty ISO-8601 string of at most ` +
        `${MAX_TIMESTAMP_LENGTH} characters`,
      path,
    );
  }
  return value;
}

export function validateEvidenceRef(
  value: unknown,
  path = "evidence",
): EvidenceRef {
  const record = requireRecord(value, "evidence reference", path);
  rejectUnknownKeys(
    record,
    ["contentHash", "byteLength", "mediaType", "path"],
    "evidence reference",
    path,
  );
  const contentHash = record.contentHash;
  if (typeof contentHash !== "string" || !SHA256_PATTERN.test(contentHash)) {
    invalid(
      "contentHash must be a lowercase hex SHA-256 digest (64 characters)",
      `${path}.contentHash`,
    );
  }
  const byteLength = record.byteLength;
  if (
    typeof byteLength !== "number" ||
    !Number.isSafeInteger(byteLength) ||
    byteLength < 0 ||
    byteLength > MAX_EVIDENCE_BYTES
  ) {
    invalid(
      `byteLength must be an integer from 0 to ${MAX_EVIDENCE_BYTES}`,
      `${path}.byteLength`,
    );
  }
  const mediaType = boundedText(
    record.mediaType,
    "mediaType",
    MAX_EVIDENCE_MEDIA_TYPE_LENGTH,
    MEDIA_TYPE_PATTERN,
    `${path}.mediaType`,
  );
  return {
    contentHash,
    byteLength,
    mediaType,
    path: validateEvidencePath(record.path, `${path}.path`),
  };
}

export function validateFactPayload<K extends FactKind>(
  kind: K,
  value: unknown,
): FactPayloadByKind[K] {
  switch (kind) {
    case "attempt.started":
      return validateAttemptStartedPayload(value) as FactPayloadByKind[K];
    case "attempt.desired-state-changed":
      return validateDesiredStateChangedPayload(
        value,
      ) as FactPayloadByKind[K];
    case "attempt.observed-state-changed":
      return validateObservedStateChangedPayload(
        value,
      ) as FactPayloadByKind[K];
    case "attempt.evidence-recorded":
      return validateEvidenceRecordedPayload(value) as FactPayloadByKind[K];
  }
  throw new StateStoreValidationError(
    `unknown fact kind: ${String(kind)}`,
    "kind",
  );
}

/**
 * Validate a persisted fact, normalizing its payload. Rebuild and replay use
 * this exact contract, so a tampered or oversized payload cannot enter the
 * projection.
 */
export function validateStoredFact(value: unknown): StoredFact {
  const record = requireRecord(value, "fact", "fact");
  rejectUnknownKeys(
    record,
    ["seq", "eventId", "at", "kind", "attemptId", "payload"],
    "fact",
    "fact",
  );
  const seq = record.seq;
  if (
    typeof seq !== "number" ||
    !Number.isSafeInteger(seq) ||
    seq < 1 ||
    seq > MAX_SEQ
  ) {
    invalid(`seq must be an integer from 1 to ${MAX_SEQ}`, "fact.seq");
  }
  const eventId = validateEventId(record.eventId, "fact.eventId");
  const at = validateTimestamp(record.at, "fact.at");
  if (!isFactKind(record.kind)) {
    invalid(
      `kind must be one of ${FACT_KINDS.join(", ")}`,
      "fact.kind",
    );
  }
  const attemptId = validateAttemptId(record.attemptId, "fact.attemptId");
  const payload = validateFactPayload(record.kind, record.payload);
  const payloadBytes = Buffer.byteLength(JSON.stringify(payload), "utf8");
  if (payloadBytes > MAX_FACT_PAYLOAD_BYTES) {
    invalid(
      `fact payload is ${payloadBytes} bytes; the limit is ` +
        `${MAX_FACT_PAYLOAD_BYTES} bytes (large evidence belongs in ` +
        "content-addressed files)",
      "fact.payload",
    );
  }
  return {
    seq,
    eventId,
    at,
    kind: record.kind,
    attemptId,
    payload,
  } as StoredFact;
}

export function toPersistedFact(fact: StoredFact): PersistedFact {
  return {
    seq: fact.seq,
    eventId: fact.eventId,
    at: fact.at,
    kind: fact.kind,
    attemptId: fact.attemptId,
    payload: fact.payload,
  };
}

export function hasOwn(value: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function validateAttemptStartedPayload(
  value: unknown,
): AttemptStartedPayload {
  const path = "payload";
  const record = requireRecord(value, "attempt.started payload", path);
  rejectUnknownKeys(
    record,
    [
      "backendType",
      "runtimeHandle",
      "workspaceId",
      "desiredState",
      "leaseDeadline",
    ],
    "attempt.started payload",
    path,
  );
  if (!isExecutionBackendType(record.backendType)) {
    invalid(
      `backendType must be one of ${EXECUTION_BACKEND_TYPES.join(", ")}`,
      `${path}.backendType`,
    );
  }
  const runtimeHandle = boundedText(
    record.runtimeHandle,
    "runtimeHandle",
    MAX_RUNTIME_HANDLE_LENGTH,
    RUNTIME_HANDLE_PATTERN,
    `${path}.runtimeHandle`,
  );
  const workspaceId = boundedText(
    record.workspaceId,
    "workspaceId",
    MAX_WORKSPACE_ID_LENGTH,
    WORKSPACE_ID_PATTERN,
    `${path}.workspaceId`,
  );
  const desiredState = hasOwn(record, "desiredState")
    ? requireDesiredState(record.desiredState, `${path}.desiredState`)
    : "running";
  const leaseDeadline =
    !hasOwn(record, "leaseDeadline") || record.leaseDeadline === null
      ? null
      : validateTimestamp(record.leaseDeadline, `${path}.leaseDeadline`);
  return {
    backendType: record.backendType,
    runtimeHandle,
    workspaceId,
    desiredState,
    leaseDeadline,
  };
}

function validateDesiredStateChangedPayload(
  value: unknown,
): DesiredStateChangedPayload {
  const path = "payload";
  const record = requireRecord(
    value,
    "attempt.desired-state-changed payload",
    path,
  );
  rejectUnknownKeys(
    record,
    ["desiredState", "leaseDeadline"],
    "attempt.desired-state-changed payload",
    path,
  );
  const desiredState = requireDesiredState(
    record.desiredState,
    `${path}.desiredState`,
  );
  const payload: DesiredStateChangedPayload = { desiredState };
  if (hasOwn(record, "leaseDeadline")) {
    payload.leaseDeadline =
      record.leaseDeadline === null
        ? null
        : validateTimestamp(record.leaseDeadline, `${path}.leaseDeadline`);
  }
  return payload;
}

function validateObservedStateChangedPayload(
  value: unknown,
): ObservedStateChangedPayload {
  const path = "payload";
  const record = requireRecord(
    value,
    "attempt.observed-state-changed payload",
    path,
  );
  rejectUnknownKeys(
    record,
    ["observedState", "diagnostics"],
    "attempt.observed-state-changed payload",
    path,
  );
  if (!isAttemptObservedState(record.observedState)) {
    invalid(
      `observedState must be one of ${ATTEMPT_OBSERVED_STATES.join(", ")}`,
      `${path}.observedState`,
    );
  }
  const payload: ObservedStateChangedPayload = {
    observedState: record.observedState,
  };
  if (hasOwn(record, "diagnostics")) {
    const diagnosticsPath = `${path}.diagnostics`;
    const diagnostics = requireRecord(
      record.diagnostics,
      "diagnostics",
      diagnosticsPath,
    );
    rejectUnknownKeys(
      diagnostics,
      ["pid", "pgid"],
      "diagnostics",
      diagnosticsPath,
    );
    payload.diagnostics = {
      pid: hasOwn(diagnostics, "pid")
        ? validateDiagnosticId(diagnostics.pid, `${diagnosticsPath}.pid`)
        : null,
      pgid: hasOwn(diagnostics, "pgid")
        ? validateDiagnosticId(diagnostics.pgid, `${diagnosticsPath}.pgid`)
        : null,
    };
  }
  return payload;
}

function validateEvidenceRecordedPayload(
  value: unknown,
): EvidenceRecordedPayload {
  const path = "payload";
  const record = requireRecord(
    value,
    "attempt.evidence-recorded payload",
    path,
  );
  rejectUnknownKeys(
    record,
    ["evidence"],
    "attempt.evidence-recorded payload",
    path,
  );
  if (
    !Array.isArray(record.evidence) ||
    record.evidence.length === 0 ||
    record.evidence.length > MAX_EVIDENCE_REFS_PER_FACT
  ) {
    invalid(
      `evidence must be an array of 1-${MAX_EVIDENCE_REFS_PER_FACT} references`,
      `${path}.evidence`,
    );
  }
  const seen = new Set<string>();
  const evidence = record.evidence.map((entry, index) => {
    const ref = validateEvidenceRef(entry, `${path}.evidence[${index}]`);
    if (seen.has(ref.contentHash)) {
      invalid(
        `duplicate contentHash ${ref.contentHash} in one fact`,
        `${path}.evidence[${index}]`,
      );
    }
    seen.add(ref.contentHash);
    return ref;
  });
  return { evidence };
}

function requireDesiredState(
  value: unknown,
  path: string,
): AttemptDesiredState {
  if (!isAttemptDesiredState(value)) {
    invalid(
      `desiredState must be one of ${ATTEMPT_DESIRED_STATES.join(", ")}`,
      path,
    );
  }
  return value;
}

function validateDiagnosticId(value: unknown, path: string): number | null {
  if (value === null) return null;
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 0 ||
    value > MAX_DIAGNOSTIC_ID
  ) {
    invalid(
      `diagnostic id must be null or an integer from 0 to ` +
        `${MAX_DIAGNOSTIC_ID}`,
      path,
    );
  }
  return value;
}

function validateEvidencePath(value: unknown, path: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAX_EVIDENCE_PATH_LENGTH ||
    value !== value.trim() ||
    value.startsWith("/") ||
    value.includes("\\") ||
    CONTROL_CHARACTERS.test(value)
  ) {
    invalid(
      `evidence path must be a normalized relative path of at most ` +
        `${MAX_EVIDENCE_PATH_LENGTH} characters`,
      path,
    );
  }
  const segments = value.split("/");
  if (
    segments.some(
      (segment) =>
        segment === "" ||
        segment === "." ||
        segment === ".." ||
        !EVIDENCE_PATH_SEGMENT.test(segment),
    )
  ) {
    invalid(
      "evidence path must contain only normalized relative segments",
      path,
    );
  }
  return value;
}

function boundedText(
  value: unknown,
  label: string,
  maxLength: number,
  pattern: RegExp,
  path: string,
): string {
  if (typeof value !== "string") {
    invalid(`${label} must be a string`, path);
  }
  if (value.length === 0 || value.length > maxLength) {
    invalid(`${label} must be 1-${maxLength} characters`, path);
  }
  if (value !== value.trim()) {
    invalid(`${label} must not have leading or trailing whitespace`, path);
  }
  if (!pattern.test(value)) {
    invalid(`${label} contains unsupported characters`, path);
  }
  return value;
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

function rejectUnknownKeys(
  record: Record<string, unknown>,
  allowed: readonly string[],
  label: string,
  path: string,
): void {
  for (const key of Object.keys(record)) {
    if (!allowed.includes(key)) {
      invalid(
        `${label} has unsupported field ${key} (inline payloads and ` +
          "inline evidence are not stored in the fact log)",
        path === "" ? key : `${path}.${key}`,
      );
    }
  }
}

function invalid(message: string, path?: string): never {
  throw new StateStoreValidationError(message, path);
}

/**
 * Driver-owned tables. `state_facts` is append-only; everything else is a
 * projection that can be dropped and rebuilt from `state_facts`.
 */
export const STATE_STORE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS state_meta (
  key TEXT PRIMARY KEY NOT NULL,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS state_facts (
  seq INTEGER PRIMARY KEY NOT NULL,
  event_id TEXT NOT NULL UNIQUE,
  at TEXT NOT NULL,
  kind TEXT NOT NULL,
  attempt_id TEXT NOT NULL,
  payload TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS state_facts_attempt_idx
  ON state_facts (attempt_id, seq);
CREATE TABLE IF NOT EXISTS state_attempts (
  attempt_id TEXT PRIMARY KEY NOT NULL,
  backend_type TEXT NOT NULL,
  runtime_handle TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  desired_state TEXT NOT NULL,
  observed_state TEXT NOT NULL,
  lease_deadline TEXT,
  pid INTEGER,
  pgid INTEGER,
  updated_at TEXT NOT NULL,
  last_seq INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS state_evidence (
  attempt_id TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  byte_length INTEGER NOT NULL,
  media_type TEXT NOT NULL,
  path TEXT NOT NULL,
  recorded_at TEXT NOT NULL,
  seq INTEGER NOT NULL,
  PRIMARY KEY (attempt_id, content_hash)
);
CREATE INDEX IF NOT EXISTS state_evidence_hash_idx
  ON state_evidence (content_hash);
`;

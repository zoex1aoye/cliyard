/**
 * Deterministic projection kernel for the StateStore v0 fact log.
 *
 * Everything here is a pure function of the facts: no clock, randomness,
 * filesystem or network access. The same fact sequence must always produce the
 * same snapshot, which is what makes rebuild-from-log safe.
 */
import {
  AttemptIdentityConflictError,
  StateStoreCorruptionError,
  StateStoreValidationError,
  UnknownAttemptError,
  hasOwn,
  validateStoredFact,
  type AttemptDiagnostics,
  type AttemptRow,
  type EvidenceRow,
  type PersistedFact,
  type StoredFact,
} from "./schema.js";

/**
 * In-memory projection state. `attempts` is keyed by attempt id and
 * `evidence` by attempt id then content hash. `lastSeq` is the sequence of the
 * last applied fact.
 */
export interface ProjectionState {
  lastSeq: number;
  attempts: Map<string, AttemptRow>;
  evidence: Map<string, Map<string, EvidenceRow>>;
}

export interface ProjectionSnapshot {
  lastSeq: number;
  attempts: AttemptRow[];
  evidence: EvidenceRow[];
}

export function emptyProjection(): ProjectionState {
  return {
    lastSeq: 0,
    attempts: new Map(),
    evidence: new Map(),
  };
}

export function cloneProjection(state: ProjectionState): ProjectionState {
  const attempts = new Map<string, AttemptRow>();
  for (const [attemptId, row] of state.attempts) {
    attempts.set(attemptId, copyAttemptRow(row));
  }
  const evidence = new Map<string, Map<string, EvidenceRow>>();
  for (const [attemptId, bucket] of state.evidence) {
    const copied = new Map<string, EvidenceRow>();
    for (const [contentHash, row] of bucket) {
      copied.set(contentHash, { ...row });
    }
    evidence.set(attemptId, copied);
  }
  return { lastSeq: state.lastSeq, attempts, evidence };
}

/**
 * Apply one validated fact. The input is mutated for linear rebuild cost; the
 * caller decides whether to clone first. Sequences must be contiguous from 1,
 * so a log with gaps or out-of-order rows fails loudly instead of producing a
 * plausible but wrong projection.
 */
export function applyFact(
  state: ProjectionState,
  fact: StoredFact,
): void {
  if (fact.seq !== state.lastSeq + 1) {
    throw new StateStoreCorruptionError(
      `fact sequence ${fact.seq} is not contiguous after ${state.lastSeq}`,
      fact.seq,
    );
  }

  switch (fact.kind) {
    case "attempt.started":
      applyAttemptStarted(state, fact);
      break;
    case "attempt.desired-state-changed":
      applyDesiredStateChanged(state, fact);
      break;
    case "attempt.observed-state-changed":
      applyObservedStateChanged(state, fact);
      break;
    case "attempt.evidence-recorded":
      applyEvidenceRecorded(state, fact);
      break;
  }

  state.lastSeq = fact.seq;
}

/**
 * Rebuild a projection from raw facts. The result is deterministic and does
 * not consult any host boundary (clock, randomness or filesystem).
 */
export function replayFacts(
  facts: readonly PersistedFact[],
): ProjectionState {
  const state = emptyProjection();
  const seenEventIds = new Set<string>();
  for (const raw of facts) {
    const fact = validateStoredFact(raw);
    if (seenEventIds.has(fact.eventId)) {
      throw new StateStoreCorruptionError(
        `duplicate event id ${fact.eventId} at sequence ${fact.seq}`,
        fact.seq,
      );
    }
    seenEventIds.add(fact.eventId);
    applyFact(state, fact);
  }
  return state;
}

/** Stable, sorted, detached snapshot for comparison and read models. */
export function projectionSnapshot(
  state: ProjectionState,
): ProjectionSnapshot {
  const attempts = [...state.attempts.values()]
    .sort((left, right) => compareStrings(left.attemptId, right.attemptId))
    .map(copyAttemptRow);
  const evidence: EvidenceRow[] = [];
  for (const bucket of state.evidence.values()) {
    for (const row of bucket.values()) evidence.push({ ...row });
  }
  evidence.sort(
    (left, right) =>
      compareStrings(left.attemptId, right.attemptId) ||
      compareStrings(left.contentHash, right.contentHash),
  );
  return { lastSeq: state.lastSeq, attempts, evidence };
}

/** Evidence rows introduced by one fact; other kinds contribute none. */
export function evidenceRowsFromFact(fact: StoredFact): EvidenceRow[] {
  if (fact.kind !== "attempt.evidence-recorded") return [];
  return fact.payload.evidence.map((ref) => ({
    attemptId: fact.attemptId,
    contentHash: ref.contentHash,
    byteLength: ref.byteLength,
    mediaType: ref.mediaType,
    path: ref.path,
    recordedAt: fact.at,
    seq: fact.seq,
  }));
}

function applyAttemptStarted(
  state: ProjectionState,
  fact: Extract<StoredFact, { kind: "attempt.started" }>,
): void {
  const payload = fact.payload;
  const existing = state.attempts.get(fact.attemptId);
  if (existing !== undefined) {
    const identityMismatch =
      existing.backendType !== payload.backendType
        ? `backendType ${existing.backendType} -> ${payload.backendType}`
        : existing.runtimeHandle !== payload.runtimeHandle
          ? `runtimeHandle ${existing.runtimeHandle} -> ` +
            `${payload.runtimeHandle}`
          : existing.workspaceId !== payload.workspaceId
            ? `workspaceId ${existing.workspaceId} -> ${payload.workspaceId}`
            : null;
    if (identityMismatch !== null) {
      throw new AttemptIdentityConflictError(
        fact.attemptId,
        identityMismatch,
      );
    }
    // A repeated start with the same stable identity is an idempotent
    // observation, not a second attempt.
    existing.desiredState = payload.desiredState;
    existing.leaseDeadline = payload.leaseDeadline;
    existing.updatedAt = fact.at;
    existing.lastSeq = fact.seq;
    return;
  }

  state.attempts.set(fact.attemptId, {
    attemptId: fact.attemptId,
    backendType: payload.backendType,
    runtimeHandle: payload.runtimeHandle,
    workspaceId: payload.workspaceId,
    desiredState: payload.desiredState,
    observedState: "unknown",
    leaseDeadline: payload.leaseDeadline,
    diagnostics: { pid: null, pgid: null },
    updatedAt: fact.at,
    lastSeq: fact.seq,
  });
}

function applyDesiredStateChanged(
  state: ProjectionState,
  fact: Extract<StoredFact, { kind: "attempt.desired-state-changed" }>,
): void {
  const row = requireAttempt(state, fact.attemptId);
  row.desiredState = fact.payload.desiredState;
  if (hasOwn(fact.payload, "leaseDeadline")) {
    row.leaseDeadline = fact.payload.leaseDeadline ?? null;
  }
  row.updatedAt = fact.at;
  row.lastSeq = fact.seq;
}

function applyObservedStateChanged(
  state: ProjectionState,
  fact: Extract<StoredFact, { kind: "attempt.observed-state-changed" }>,
): void {
  const row = requireAttempt(state, fact.attemptId);
  row.observedState = fact.payload.observedState;
  if (fact.payload.diagnostics !== undefined) {
    // Diagnostics are copied but never used as identity.
    row.diagnostics = copyDiagnostics(fact.payload.diagnostics);
  }
  row.updatedAt = fact.at;
  row.lastSeq = fact.seq;
}

function applyEvidenceRecorded(
  state: ProjectionState,
  fact: Extract<StoredFact, { kind: "attempt.evidence-recorded" }>,
): void {
  const row = requireAttempt(state, fact.attemptId);
  let bucket = state.evidence.get(fact.attemptId);
  if (bucket === undefined) {
    bucket = new Map();
    state.evidence.set(fact.attemptId, bucket);
  }
  for (const ref of fact.payload.evidence) {
    const existing = bucket.get(ref.contentHash);
    if (
      existing !== undefined &&
      (existing.byteLength !== ref.byteLength ||
        existing.mediaType !== ref.mediaType ||
        existing.path !== ref.path)
    ) {
      throw new StateStoreValidationError(
        `content hash ${ref.contentHash} was recorded with different ` +
          "metadata",
        `evidence.${fact.attemptId}.${ref.contentHash}`,
      );
    }
    bucket.set(ref.contentHash, {
      attemptId: fact.attemptId,
      contentHash: ref.contentHash,
      byteLength: ref.byteLength,
      mediaType: ref.mediaType,
      path: ref.path,
      recordedAt: fact.at,
      seq: fact.seq,
    });
  }
  row.updatedAt = fact.at;
  row.lastSeq = fact.seq;
}

function requireAttempt(
  state: ProjectionState,
  attemptId: string,
): AttemptRow {
  const row = state.attempts.get(attemptId);
  if (row === undefined) throw new UnknownAttemptError(attemptId);
  return row;
}

function copyAttemptRow(row: AttemptRow): AttemptRow {
  return {
    ...row,
    diagnostics: copyDiagnostics(row.diagnostics),
  };
}

function copyDiagnostics(diagnostics: AttemptDiagnostics): AttemptDiagnostics {
  return { pid: diagnostics.pid, pgid: diagnostics.pgid };
}

/** Codepoint comparison; locale-independent, so replay stays deterministic. */
function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * Bounded queue-level audit events
 * (docs/NEXT_STEP_CONTROLLER.md, queue-event-journal-v0).
 *
 * Events are observational. They do not grant acceptance, change a
 * RunManifest, or replace queue state. Appends are best-effort so an
 * observability failure can never turn a durable queue mutation into an
 * ambiguous command failure.
 */
import { randomUUID } from "node:crypto";
import {
  appendFileSync,
  mkdirSync,
  readFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
  isCostState,
  isFailureCategory,
  isFailureStage,
  type CostState,
  type FailureCategory,
  type FailureStage,
} from "../failures.js";
import type { ExecutionRuntimeId } from "../execution/profile.js";

export const QUEUE_EVENT_VERSION = 1 as const;
/** Matches the failure record code bound in src/failures.ts. */
const MAX_FAILURE_CODE = 64;
export const QUEUE_EVENTS_DIR = "queue-events";
export const QUEUE_EVENTS_FILE = "events.jsonl";
export const DEFAULT_QUEUE_EVENT_LIMIT = 200;

/**
 * Bounds shared with `OperatorResolution` (design/queue-adoption-v1.md).
 * Kept local so the journal module has no dependency on queue storage.
 */
const MAX_ADOPTION_ID_LENGTH = 128;
const MAX_ADOPTION_APPROVED_BY_LENGTH = 128;
const MAX_ADOPTION_REASON_LENGTH = 1_000;
const MAX_ADOPTION_EVIDENCE_PATH_LENGTH = 4_096;
/** Full git object id: SHA-1 (40) or SHA-256 (64) repositories. */
const FULL_COMMIT_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;
const SHA256_PATTERN = /^[0-9a-f]{64}$/i;

export type QueueAdoptionSourceManifestStatus = "blocked" | "interrupted";

/**
 * Required bounded fields of `queue.item.adopted`. They round-trip the durable
 * `OperatorResolution`, which remains queue authority; the event only observes.
 */
export interface QueueAdoptionEventFields {
  itemId: string;
  runId: string;
  status: "completed";
  sourceManifestStatus: QueueAdoptionSourceManifestStatus;
  baseCommit: string;
  reviewedCommit: string;
  contractsHash: string;
  reviewEvidencePath: string;
  reviewEvidenceHash: string;
  approvedBy: string;
  reason: string;
}

export interface QueueAdoptionEvent extends QueueAdoptionEventFields {
  version: typeof QUEUE_EVENT_VERSION;
  eventId: string;
  at: string;
  type: "queue.item.adopted";
}

/** Fields that are valid only on `queue.item.adopted`. */
const ADOPTION_ONLY_FIELDS = [
  "sourceManifestStatus",
  "baseCommit",
  "reviewedCommit",
  "contractsHash",
  "reviewEvidencePath",
  "reviewEvidenceHash",
  "approvedBy",
] as const;

export type QueueControlEventType =
  | "queue.item.added"
  | "queue.retry"
  | "queue.cancel"
  | "queue.item.reconciled"
  | "queue.item.adopted"
  | "plan.materialized"
  | "attempt.started"
  | "run.started"
  | "run.resumed"
  | "provider.session.started"
  | "provider.session.ended"
  | "run.completed"
  | "run.blocked"
  | "run.interrupted"
  | "controller.started"
  | "controller.heartbeat"
  | "controller.stopped";

const EVENT_TYPES: ReadonlySet<string> = new Set([
  "queue.item.added",
  "queue.retry",
  "queue.cancel",
  "queue.item.reconciled",
  "queue.item.adopted",
  "plan.materialized",
  "attempt.started",
  "run.started",
  "run.resumed",
  "provider.session.started",
  "provider.session.ended",
  "run.completed",
  "run.blocked",
  "run.interrupted",
  "controller.started",
  "controller.heartbeat",
  "controller.stopped",
]);

export interface QueueControlEvent {
  version: typeof QUEUE_EVENT_VERSION;
  eventId: string;
  at: string;
  type: QueueControlEventType;
  itemId?: string;
  runId?: string;
  taskId?: string;
  sessionId?: string;
  attempt?: number;
  action?: string;
  status?: string;
  reason?: string;
  /**
   * Bounded failure/cost observation attached to `run.blocked`. These never
   * grant acceptance, authorize retry, or replace the RunManifest authority.
   */
  failureCategory?: FailureCategory;
  failureStage?: FailureStage;
  failureCode?: string;
  costState?: CostState;
  /** Bounded frozen execution/continuation summary. */
  executionProfileId?: string;
  runtimeId?: ExecutionRuntimeId;
  modelId?: string;
  providerId?: string;
  mappedProgress?: boolean;
  providerSessionResume?: boolean;
  deadlineAutoExtend?: boolean;
  deadlineMaxExtensions?: number;
  budgetAutoContinue?: boolean;
  budgetMaxContinuations?: number;
  /**
   * Adoption-only observation. Required as a complete set on
   * `queue.item.adopted` and rejected on every other event type.
   */
  sourceManifestStatus?: QueueAdoptionSourceManifestStatus;
  baseCommit?: string;
  reviewedCommit?: string;
  contractsHash?: string;
  reviewEvidencePath?: string;
  reviewEvidenceHash?: string;
  approvedBy?: string;
}

export interface AppendQueueEventInput {
  type: QueueControlEventType;
  at?: string;
  itemId?: string;
  runId?: string;
  taskId?: string;
  sessionId?: string;
  attempt?: number;
  action?: string;
  status?: string;
  reason?: string;
  failureCategory?: FailureCategory;
  failureStage?: FailureStage;
  failureCode?: string;
  costState?: CostState;
  executionProfileId?: string;
  runtimeId?: ExecutionRuntimeId;
  modelId?: string;
  providerId?: string;
  mappedProgress?: boolean;
  providerSessionResume?: boolean;
  deadlineAutoExtend?: boolean;
  deadlineMaxExtensions?: number;
  budgetAutoContinue?: boolean;
  budgetMaxContinuations?: number;
  sourceManifestStatus?: QueueAdoptionSourceManifestStatus;
  baseCommit?: string;
  reviewedCommit?: string;
  contractsHash?: string;
  reviewEvidencePath?: string;
  reviewEvidenceHash?: string;
  approvedBy?: string;
}

export interface QueueEventJournalSummary {
  version: 1;
  path: string;
  exists: boolean;
  totalEvents: number;
  malformedLines: number;
  events: QueueControlEvent[];
  lastEventAt: string | null;
  readError: string | null;
}

export function queueEventJournalPath(repoRoot: string): string {
  return join(
    resolve(repoRoot),
    ".cliyard",
    QUEUE_EVENTS_DIR,
    QUEUE_EVENTS_FILE,
  );
}

/**
 * Append one bounded event. Callers should normally use
 * `tryAppendQueueEvent`; this throwing form is useful for diagnostics/tests.
 */
export function appendQueueEvent(
  repoRoot: string,
  input: AppendQueueEventInput,
): QueueControlEvent {
  const event = normalizeQueueEvent(input);
  const path = queueEventJournalPath(repoRoot);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  appendFileSync(path, `${JSON.stringify(event)}\n`, "utf8");
  return event;
}

/** Best-effort journal append; journal failure never masks queue authority. */
export function tryAppendQueueEvent(
  repoRoot: string,
  input: AppendQueueEventInput,
): QueueControlEvent | undefined {
  try {
    return appendQueueEvent(repoRoot, input);
  } catch {
    return undefined;
  }
}

/**
 * Read the journal in insertion order. Malformed records are counted and
 * skipped. Only the newest `limit` valid records are returned, but counts and
 * `lastEventAt` still describe the full readable file.
 */
export function readQueueEventJournal(
  repoRoot: string,
  limit = DEFAULT_QUEUE_EVENT_LIMIT,
): QueueEventJournalSummary {
  const scan = scanQueueEventJournal(repoRoot);
  const normalizedLimit = normalizeEventLimit(limit);
  const events = scan.valid.slice(-normalizedLimit);
  return {
    version: 1,
    path: scan.path,
    exists: scan.exists,
    totalEvents: scan.valid.length,
    malformedLines: scan.malformedLines,
    events,
    lastEventAt:
      scan.valid.length > 0 ? scan.valid[scan.valid.length - 1]!.at : null,
    readError: scan.readError,
  };
}

/** Bounded adoption projection derived by filtering the unified journal. */
export interface QueueAdoptionEventSummary {
  version: 1;
  path: string;
  exists: boolean;
  totalEvents: number;
  malformedLines: number;
  events: QueueAdoptionEvent[];
  lastEventAt: string | null;
  readError: string | null;
}

/**
 * Filter `queue.item.adopted` records from the unified queue journal. The full
 * valid record set is scanned before applying the display limit so unrelated
 * recent events can never hide adoption observations.
 */
export function readQueueAdoptionEvents(
  repoRoot: string,
  limit = DEFAULT_QUEUE_EVENT_LIMIT,
): QueueAdoptionEventSummary {
  const scan = scanQueueEventJournal(repoRoot);
  const normalizedLimit = normalizeEventLimit(limit);
  const adoptions = scan.valid.filter(isQueueAdoptionEvent);
  return {
    version: 1,
    path: scan.path,
    exists: scan.exists,
    totalEvents: adoptions.length,
    malformedLines: scan.malformedLines,
    events: adoptions.slice(-normalizedLimit),
    lastEventAt:
      adoptions.length > 0 ? adoptions[adoptions.length - 1]!.at : null,
    readError: scan.readError,
  };
}

export function isQueueAdoptionEvent(
  value: unknown,
): value is QueueAdoptionEvent {
  return isQueueControlEvent(value) && value.type === "queue.item.adopted";
}

interface QueueEventJournalScan {
  path: string;
  exists: boolean;
  malformedLines: number;
  valid: QueueControlEvent[];
  readError: string | null;
}

function scanQueueEventJournal(repoRoot: string): QueueEventJournalScan {
  const path = queueEventJournalPath(repoRoot);
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return {
        path,
        exists: false,
        malformedLines: 0,
        valid: [],
        readError: null,
      };
    }
    return {
      path,
      exists: true,
      malformedLines: 0,
      valid: [],
      readError: errorMessage(error),
    };
  }

  const valid: QueueControlEvent[] = [];
  let malformedLines = 0;
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line) as unknown;
    } catch {
      malformedLines += 1;
      continue;
    }
    if (!isQueueControlEvent(parsed)) {
      malformedLines += 1;
      continue;
    }
    valid.push(parsed);
  }
  return { path, exists: true, malformedLines, valid, readError: null };
}

function normalizeEventLimit(limit: number): number {
  return Number.isInteger(limit) && limit > 0
    ? Math.min(limit, 5_000)
    : DEFAULT_QUEUE_EVENT_LIMIT;
}

export function isQueueControlEvent(
  value: unknown,
): value is QueueControlEvent {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  if (
    record.version !== QUEUE_EVENT_VERSION ||
    typeof record.eventId !== "string" ||
    !record.eventId.trim() ||
    typeof record.at !== "string" ||
    Number.isNaN(Date.parse(record.at)) ||
    typeof record.type !== "string" ||
    !EVENT_TYPES.has(record.type)
  ) {
    return false;
  }
  for (const key of [
    "itemId",
    "runId",
    "taskId",
    "sessionId",
    "action",
    "status",
    "reason",
    "failureCode",
    "executionProfileId",
    "modelId",
    "providerId",
  ] as const) {
    if (record[key] !== undefined && typeof record[key] !== "string") {
      return false;
    }
  }
  if (
    typeof record.failureCode === "string" &&
    (!record.failureCode.trim() ||
      record.failureCode.length > MAX_FAILURE_CODE)
  ) {
    return false;
  }
  for (const [key, max] of [
    ["executionProfileId", 128],
    ["modelId", 128],
    ["providerId", 128],
  ] as const) {
    if (
      typeof record[key] === "string" &&
      (!record[key].trim() || record[key].length > max)
    ) {
      return false;
    }
  }
  if (
    record.failureCategory !== undefined &&
    !isFailureCategory(record.failureCategory)
  ) {
    return false;
  }
  if (record.failureStage !== undefined && !isFailureStage(record.failureStage)) {
    return false;
  }
  if (record.costState !== undefined && !isCostState(record.costState)) {
    return false;
  }
  if (
    record.runtimeId !== undefined &&
    record.runtimeId !== "claude" &&
    record.runtimeId !== "codex"
  ) {
    return false;
  }
  for (const key of [
    "mappedProgress",
    "providerSessionResume",
    "deadlineAutoExtend",
    "budgetAutoContinue",
  ] as const) {
    if (record[key] !== undefined && typeof record[key] !== "boolean") {
      return false;
    }
  }
  for (const key of [
    "deadlineMaxExtensions",
    "budgetMaxContinuations",
  ] as const) {
    if (
      record[key] !== undefined &&
      (!Number.isInteger(record[key]) ||
        (record[key] as number) < 0 ||
        (record[key] as number) > 64)
    ) {
      return false;
    }
  }
  const commonValid =
    record.attempt === undefined ||
    (typeof record.attempt === "number" &&
      Number.isInteger(record.attempt) &&
      record.attempt >= 0);
  if (!commonValid) return false;

  if (record.type === "queue.item.adopted") {
    return isAdoptionEventRecord(record);
  }
  // Adoption-only fields fail closed on every unrelated event type.
  return !ADOPTION_ONLY_FIELDS.some((key) => record[key] !== undefined);
}

/**
 * Strict event-specific contract. Every adoption field is required, bounded
 * and secret-free; commit ids and hashes must be full digests.
 */
function isAdoptionEventRecord(record: Record<string, unknown>): boolean {
  if (record.status !== "completed") return false;
  if (
    record.sourceManifestStatus !== "blocked" &&
    record.sourceManifestStatus !== "interrupted"
  ) {
    return false;
  }
  for (const [key, max] of [
    ["itemId", MAX_ADOPTION_ID_LENGTH],
    ["runId", MAX_ADOPTION_ID_LENGTH],
    ["approvedBy", MAX_ADOPTION_APPROVED_BY_LENGTH],
    ["reason", MAX_ADOPTION_REASON_LENGTH],
    ["reviewEvidencePath", MAX_ADOPTION_EVIDENCE_PATH_LENGTH],
  ] as const) {
    const value = record[key];
    if (typeof value !== "string" || !value.trim() || value.length > max) {
      return false;
    }
    if (looksLikeSecret(value)) return false;
  }
  for (const key of ["baseCommit", "reviewedCommit"] as const) {
    const value = record[key];
    if (typeof value !== "string" || !FULL_COMMIT_PATTERN.test(value.trim())) {
      return false;
    }
  }
  for (const key of ["contractsHash", "reviewEvidenceHash"] as const) {
    const value = record[key];
    if (typeof value !== "string" || !SHA256_PATTERN.test(value.trim())) {
      return false;
    }
  }
  return true;
}

/** Mirrors the OperatorResolution credential guard for adoption text. */
function looksLikeSecret(value: string): boolean {
  return [
    /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/,
    /\bsk-[A-Za-z0-9_-]{16,}\b/,
    /\bsk_[A-Za-z0-9_-]{16,}\b/,
    /\bghp_[A-Za-z0-9]{20,}\b/,
    /\bgithub_pat_[A-Za-z0-9_]{20,}\b/,
    /\bAKIA[0-9A-Z]{16}\b/,
    /\bBearer\s+[A-Za-z0-9._-]{16,}/i,
    /\b(?:api[_-]?key|access[_-]?token|auth[_-]?token|token|passwd|password|secret)\b\s*[:=]\s*["']?[A-Za-z0-9._/+=-]{6,}/i,
  ].some((pattern) => pattern.test(value));
}

function normalizeQueueEvent(
  input: AppendQueueEventInput,
): QueueControlEvent {
  if (!EVENT_TYPES.has(input.type)) {
    throw new Error(`unknown queue event type: ${String(input.type)}`);
  }
  if (input.type !== "queue.item.adopted") {
    for (const key of ADOPTION_ONLY_FIELDS) {
      if (input[key] !== undefined) {
        throw new Error(
          `queue event ${input.type} must not carry adoption field ${key}`,
        );
      }
    }
  }
  const at = input.at ?? new Date().toISOString();
  if (Number.isNaN(Date.parse(at))) {
    throw new Error(`invalid queue event timestamp: ${at}`);
  }
  if (
    input.attempt !== undefined &&
    (!Number.isInteger(input.attempt) || input.attempt < 0)
  ) {
    throw new Error("queue event attempt must be a non-negative integer");
  }
  if (
    input.failureCategory !== undefined &&
    !isFailureCategory(input.failureCategory)
  ) {
    throw new Error(
      `invalid queue event failureCategory: ${String(input.failureCategory)}`,
    );
  }
  if (input.failureStage !== undefined && !isFailureStage(input.failureStage)) {
    throw new Error(
      `invalid queue event failureStage: ${String(input.failureStage)}`,
    );
  }
  if (input.costState !== undefined && !isCostState(input.costState)) {
    throw new Error(
      `invalid queue event costState: ${String(input.costState)}`,
    );
  }
  if (
    input.runtimeId !== undefined &&
    input.runtimeId !== "claude" &&
    input.runtimeId !== "codex"
  ) {
    throw new Error(`invalid queue event runtimeId: ${input.runtimeId}`);
  }
  for (const [label, value] of [
    ["deadlineMaxExtensions", input.deadlineMaxExtensions],
    ["budgetMaxContinuations", input.budgetMaxContinuations],
  ] as const) {
    if (
      value !== undefined &&
      (!Number.isInteger(value) || value < 0 || value > 64)
    ) {
      throw new Error(`queue event ${label} must be an integer from 0 to 64`);
    }
  }
  for (const [label, value] of [
    ["mappedProgress", input.mappedProgress],
    ["providerSessionResume", input.providerSessionResume],
    ["deadlineAutoExtend", input.deadlineAutoExtend],
    ["budgetAutoContinue", input.budgetAutoContinue],
  ] as const) {
    if (value !== undefined && typeof value !== "boolean") {
      throw new Error(`queue event ${label} must be a boolean`);
    }
  }
  if (input.type === "queue.item.adopted") {
    validateAdoptionEventInput(input);
  }
  const event: QueueControlEvent = {
    version: QUEUE_EVENT_VERSION,
    eventId: randomUUID(),
    at,
    type: input.type,
    ...optionalText("itemId", input.itemId, 128),
    ...optionalText("runId", input.runId, 128),
    ...optionalText("taskId", input.taskId, 128),
    ...optionalText("sessionId", input.sessionId, 160),
    ...(input.attempt !== undefined ? { attempt: input.attempt } : {}),
    ...optionalText("action", input.action, 32),
    ...optionalText("status", input.status, 64),
    ...optionalText("reason", input.reason, 1_000),
    ...(input.failureCategory !== undefined
      ? { failureCategory: input.failureCategory }
      : {}),
    ...(input.failureStage !== undefined
      ? { failureStage: input.failureStage }
      : {}),
    ...optionalText("failureCode", input.failureCode, MAX_FAILURE_CODE),
    ...(input.costState !== undefined ? { costState: input.costState } : {}),
    ...optionalText("executionProfileId", input.executionProfileId, 128),
    ...(input.runtimeId !== undefined ? { runtimeId: input.runtimeId } : {}),
    ...optionalText("modelId", input.modelId, 128),
    ...optionalText("providerId", input.providerId, 128),
    ...(input.mappedProgress !== undefined
      ? { mappedProgress: input.mappedProgress }
      : {}),
    ...(input.providerSessionResume !== undefined
      ? { providerSessionResume: input.providerSessionResume }
      : {}),
    ...(input.deadlineAutoExtend !== undefined
      ? { deadlineAutoExtend: input.deadlineAutoExtend }
      : {}),
    ...(input.deadlineMaxExtensions !== undefined
      ? { deadlineMaxExtensions: input.deadlineMaxExtensions }
      : {}),
    ...(input.budgetAutoContinue !== undefined
      ? { budgetAutoContinue: input.budgetAutoContinue }
      : {}),
    ...(input.budgetMaxContinuations !== undefined
      ? { budgetMaxContinuations: input.budgetMaxContinuations }
      : {}),
    ...(input.sourceManifestStatus !== undefined
      ? { sourceManifestStatus: input.sourceManifestStatus }
      : {}),
    ...optionalText("baseCommit", input.baseCommit, 64),
    ...optionalText("reviewedCommit", input.reviewedCommit, 64),
    ...optionalText("contractsHash", input.contractsHash, 64),
    ...optionalText(
      "reviewEvidencePath",
      input.reviewEvidencePath,
      MAX_ADOPTION_EVIDENCE_PATH_LENGTH,
    ),
    ...optionalText("reviewEvidenceHash", input.reviewEvidenceHash, 64),
    ...optionalText(
      "approvedBy",
      input.approvedBy,
      MAX_ADOPTION_APPROVED_BY_LENGTH,
    ),
  };
  // Fail closed before writing: adoption fields are required as an exact set,
  // and adoption-only fields are rejected on unrelated event types.
  if (!isQueueControlEvent(event)) {
    throw new Error(
      `queue event ${input.type} does not satisfy its bounded field contract`,
    );
  }
  return event;
}

/**
 * Validate adoption input before `optionalText` can trim or truncate it, so an
 * oversized or secret-bearing value is rejected rather than silently bounded.
 */
function validateAdoptionEventInput(input: AppendQueueEventInput): void {
  const text = (label: string, value: unknown, max: number): void => {
    if (typeof value !== "string" || !value.trim()) {
      throw new Error(`queue.item.adopted requires ${label}`);
    }
    if (value.length > max) {
      throw new Error(`queue.item.adopted ${label} exceeds ${max} characters`);
    }
    if (looksLikeSecret(value)) {
      throw new Error(`queue.item.adopted ${label} appears to contain a secret`);
    }
  };
  text("itemId", input.itemId, MAX_ADOPTION_ID_LENGTH);
  text("runId", input.runId, MAX_ADOPTION_ID_LENGTH);
  text("approvedBy", input.approvedBy, MAX_ADOPTION_APPROVED_BY_LENGTH);
  text("reason", input.reason, MAX_ADOPTION_REASON_LENGTH);
  text(
    "reviewEvidencePath",
    input.reviewEvidencePath,
    MAX_ADOPTION_EVIDENCE_PATH_LENGTH,
  );
  if (input.status !== "completed") {
    throw new Error('queue.item.adopted status must be "completed"');
  }
  if (
    input.sourceManifestStatus !== "blocked" &&
    input.sourceManifestStatus !== "interrupted"
  ) {
    throw new Error(
      "queue.item.adopted sourceManifestStatus must be blocked or interrupted",
    );
  }
  for (const [label, value] of [
    ["baseCommit", input.baseCommit],
    ["reviewedCommit", input.reviewedCommit],
  ] as const) {
    if (typeof value !== "string" || !FULL_COMMIT_PATTERN.test(value.trim())) {
      throw new Error(
        `queue.item.adopted ${label} must be a full git commit id ` +
          "(40 or 64 hex characters)",
      );
    }
  }
  for (const [label, value] of [
    ["contractsHash", input.contractsHash],
    ["reviewEvidenceHash", input.reviewEvidenceHash],
  ] as const) {
    if (typeof value !== "string" || !SHA256_PATTERN.test(value.trim())) {
      throw new Error(
        `queue.item.adopted ${label} must be a hex SHA-256 digest`,
      );
    }
  }
}

function optionalText<K extends keyof QueueControlEvent>(
  key: K,
  value: string | undefined,
  max: number,
): Partial<Pick<QueueControlEvent, K>> {
  if (typeof value !== "string" || !value.trim()) return {};
  const trimmed = value.trim();
  const bounded =
    trimmed.length <= max ? trimmed : `${trimmed.slice(0, max - 1)}…`;
  return { [key]: bounded } as Partial<Pick<QueueControlEvent, K>>;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

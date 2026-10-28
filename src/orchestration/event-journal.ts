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

export type QueueControlEventType =
  | "queue.item.added"
  | "queue.retry"
  | "queue.cancel"
  | "queue.item.reconciled"
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
  const path = queueEventJournalPath(repoRoot);
  const normalizedLimit =
    Number.isInteger(limit) && limit > 0
      ? Math.min(limit, 5_000)
      : DEFAULT_QUEUE_EVENT_LIMIT;
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return emptyJournal(path);
    }
    return {
      ...emptyJournal(path),
      exists: true,
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

  const events = valid.slice(-normalizedLimit);
  return {
    version: 1,
    path,
    exists: true,
    totalEvents: valid.length,
    malformedLines,
    events,
    lastEventAt:
      valid.length > 0 ? valid[valid.length - 1]!.at : null,
    readError: null,
  };
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
  return (
    record.attempt === undefined ||
    (typeof record.attempt === "number" &&
      Number.isInteger(record.attempt) &&
      record.attempt >= 0)
  );
}

function normalizeQueueEvent(
  input: AppendQueueEventInput,
): QueueControlEvent {
  if (!EVENT_TYPES.has(input.type)) {
    throw new Error(`unknown queue event type: ${String(input.type)}`);
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
  return {
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
  };
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

function emptyJournal(path: string): QueueEventJournalSummary {
  return {
    version: 1,
    path,
    exists: false,
    totalEvents: 0,
    malformedLines: 0,
    events: [],
    lastEventAt: null,
    readError: null,
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Versioned, bounded continuation evidence shared by workers and the
 * Supervisor. Deadline grants extend a live invocation's wall-clock timer;
 * budget continuations authorize a new invocation and never mutate a running
 * provider process. Neither kind changes the TaskContract or acceptance.
 */

export const DEADLINE_EXTENSION_POLICY_VERSION = 1 as const;
export const BUDGET_CONTINUATION_POLICY_VERSION = 1 as const;
export const TASK_EXTENSION_RECORD_VERSION = 1 as const;

/** Node timers do not reliably support delays beyond signed 32-bit ints. */
export const MAX_DEADLINE_TIMEOUT_MS = 2_147_483_647;
export const MAX_DEADLINE_EXTENSIONS = 64;
export const MAX_BUDGET_CONTINUATIONS = 64;
export const MAX_BUDGET_GUARD_USD = 1_000_000;
export const MAX_TASK_EXTENSIONS = 64;
export const MAX_HEALTHY_EVIDENCE = 16;
export const MAX_HEALTHY_EVIDENCE_LENGTH = 240;
export const MAX_EXTENSION_REASON_LENGTH = 500;
export const MAX_EXTENSION_ID_LENGTH = 128;
export const MAX_PROVIDER_SESSION_ID_LENGTH = 256;

const MAX_BUDGET_DECIMALS = 6;

export interface DeadlineExtensionPolicy {
  version: typeof DEADLINE_EXTENSION_POLICY_VERSION;
  baseTimeoutMs: number;
  extensionStepMs: number;
  maxExtensions: number;
  maxTotalTimeoutMs: number;
  healthyActivityWindowMs: number;
  autoExtend: boolean;
}

/**
 * The default keeps automatic deadline extension disabled. Callers must
 * explicitly opt in with a positive extension count and a compatible total.
 */
export const DEFAULT_DEADLINE_EXTENSION_POLICY: Readonly<DeadlineExtensionPolicy> =
  Object.freeze({
    version: DEADLINE_EXTENSION_POLICY_VERSION,
    baseTimeoutMs: 20 * 60_000,
    extensionStepMs: 5 * 60_000,
    maxExtensions: 0,
    maxTotalTimeoutMs: 20 * 60_000,
    healthyActivityWindowMs: 60_000,
    autoExtend: false,
  });

/**
 * A continuation guard is an additional amount above the invocation's prior
 * guard. The cumulative guard is the sum of those guards, never provider
 * balance or observed spend.
 */
export interface BudgetContinuationPolicy {
  version: typeof BUDGET_CONTINUATION_POLICY_VERSION;
  baseGuardUsd: number;
  continuationGuardUsd: number;
  maxContinuations: number;
  maxCumulativeGuardUsd: number;
  autoContinue: boolean;
  overshootReserveUsd: number;
}

/**
 * Automatic budget continuation spends no extra money unless explicitly
 * configured. The zero count is also the safe default for manual wiring.
 */
export const DEFAULT_BUDGET_CONTINUATION_POLICY: Readonly<BudgetContinuationPolicy> =
  Object.freeze({
    version: BUDGET_CONTINUATION_POLICY_VERSION,
    baseGuardUsd: 5,
    continuationGuardUsd: 5,
    maxContinuations: 0,
    maxCumulativeGuardUsd: 5,
    autoContinue: false,
    overshootReserveUsd: 0,
  });

interface TaskExtensionRecordBase {
  version: typeof TASK_EXTENSION_RECORD_VERSION;
  extensionId: string;
  attempt: number;
  source: "auto";
  requestedAt: string;
  grantedAt: string;
  reason: string;
  /** Bounded labels and timestamps for mapped assistant/tool events. */
  healthyEvidence: string[];
  providerSessionId?: string;
}

/**
 * Common durable shape. Kind-specific fields are optional here so existing
 * deadline consumers remain source-compatible; the parsers below enforce the
 * exact required subset for each kind.
 */
export interface TaskExtensionRecord extends TaskExtensionRecordBase {
  kind: "deadline" | "budget-continuation";
  extensionMs?: number;
  cumulativeTimeoutMs?: number;
  additionalGuardUsd?: number;
  cumulativeGuardUsd?: number;
  continuationIndex?: number;
}

export interface DeadlineTaskExtensionRecord
  extends TaskExtensionRecord {
  kind: "deadline";
  extensionMs: number;
  cumulativeTimeoutMs: number;
}

export interface BudgetContinuationTaskExtensionRecord
  extends TaskExtensionRecord {
  kind: "budget-continuation";
  providerSessionId: string;
  additionalGuardUsd: number;
  cumulativeGuardUsd: number;
  /** One-based position within this task attempt's budget continuation grant. */
  continuationIndex: number;
}

/** Parse one policy without repairing invalid or contradictory values. */
export function parseDeadlineExtensionPolicy(
  value: unknown,
): DeadlineExtensionPolicy | undefined {
  if (!isRecord(value)) return undefined;
  if (value.version !== DEADLINE_EXTENSION_POLICY_VERSION) return undefined;
  if (
    !isPositiveTimerMs(value.baseTimeoutMs) ||
    !isPositiveTimerMs(value.extensionStepMs) ||
    !isBoundedInteger(value.maxExtensions, MAX_DEADLINE_EXTENSIONS) ||
    !isPositiveTimerMs(value.maxTotalTimeoutMs) ||
    !isPositiveTimerMs(value.healthyActivityWindowMs) ||
    typeof value.autoExtend !== "boolean"
  ) {
    return undefined;
  }

  const baseTimeoutMs = value.baseTimeoutMs as number;
  const extensionStepMs = value.extensionStepMs as number;
  const maxExtensions = value.maxExtensions as number;
  const maxTotalTimeoutMs = value.maxTotalTimeoutMs as number;
  const healthyActivityWindowMs = value.healthyActivityWindowMs as number;
  const autoExtend = value.autoExtend;

  if (maxTotalTimeoutMs < baseTimeoutMs) return undefined;
  if (
    maxExtensions > 0 &&
    (!Number.isSafeInteger(baseTimeoutMs + extensionStepMs) ||
      baseTimeoutMs + extensionStepMs > maxTotalTimeoutMs)
  ) {
    return undefined;
  }
  if (autoExtend && maxExtensions === 0) return undefined;

  return {
    version: DEADLINE_EXTENSION_POLICY_VERSION,
    baseTimeoutMs,
    extensionStepMs,
    maxExtensions,
    maxTotalTimeoutMs,
    healthyActivityWindowMs,
    autoExtend,
  };
}

/** Parse one bounded budget-continuation policy without coercion. */
export function parseBudgetContinuationPolicy(
  value: unknown,
): BudgetContinuationPolicy | undefined {
  if (!isRecord(value)) return undefined;
  if (value.version !== BUDGET_CONTINUATION_POLICY_VERSION) return undefined;
  if (
    !isBoundedUsd(value.baseGuardUsd, false) ||
    !isBoundedUsd(value.continuationGuardUsd, false) ||
    !isBoundedInteger(value.maxContinuations, MAX_BUDGET_CONTINUATIONS) ||
    !isBoundedUsd(value.maxCumulativeGuardUsd, false) ||
    typeof value.autoContinue !== "boolean" ||
    !isBoundedUsd(value.overshootReserveUsd, true)
  ) {
    return undefined;
  }

  const baseGuardUsd = roundBudgetUsd(value.baseGuardUsd as number);
  const continuationGuardUsd = roundBudgetUsd(
    value.continuationGuardUsd as number,
  );
  const maxContinuations = value.maxContinuations as number;
  const maxCumulativeGuardUsd = roundBudgetUsd(
    value.maxCumulativeGuardUsd as number,
  );
  const autoContinue = value.autoContinue;
  const overshootReserveUsd = roundBudgetUsd(
    value.overshootReserveUsd as number,
  );

  if (
    maxCumulativeGuardUsd <
    roundBudgetUsd(baseGuardUsd + overshootReserveUsd)
  ) {
    return undefined;
  }
  if (
    maxContinuations > 0 &&
    roundBudgetUsd(
      roundBudgetUsd(baseGuardUsd + continuationGuardUsd) +
        overshootReserveUsd,
    ) >
      maxCumulativeGuardUsd
  ) {
    return undefined;
  }
  if (autoContinue && maxContinuations === 0) return undefined;

  return {
    version: BUDGET_CONTINUATION_POLICY_VERSION,
    baseGuardUsd,
    continuationGuardUsd,
    maxContinuations,
    maxCumulativeGuardUsd,
    autoContinue,
    overshootReserveUsd,
  };
}

/** Parse a positive, bounded CLI budget guard. */
export function parseBudgetGuardUsd(value: unknown): number | undefined {
  return isBoundedUsd(value, false)
    ? roundBudgetUsd(value as number)
    : undefined;
}

/**
 * Parse one extension grant. Unknown fields are dropped and ambiguous shapes
 * fail closed rather than being converted into a different grant kind.
 */
export function parseTaskExtensionRecord(
  value: unknown,
): TaskExtensionRecord | undefined {
  if (!isRecord(value)) return undefined;
  if (!isValidExtensionBase(value)) return undefined;

  if (value.kind === "deadline") {
    return parseDeadlineTaskExtensionRecord(value);
  }
  if (value.kind === "budget-continuation") {
    return parseBudgetContinuationTaskExtensionRecord(value);
  }
  return undefined;
}

function parseDeadlineTaskExtensionRecord(
  value: Record<string, unknown>,
): DeadlineTaskExtensionRecord | undefined {
  if (
    !isPositiveTimerMs(value.extensionMs) ||
    !isPositiveTimerMs(value.cumulativeTimeoutMs) ||
    (value.cumulativeTimeoutMs as number) < (value.extensionMs as number)
  ) {
    return undefined;
  }

  return {
    ...extensionBase(value),
    kind: "deadline",
    extensionMs: value.extensionMs as number,
    cumulativeTimeoutMs: value.cumulativeTimeoutMs as number,
  };
}

function parseBudgetContinuationTaskExtensionRecord(
  value: Record<string, unknown>,
): BudgetContinuationTaskExtensionRecord | undefined {
  if (
    !isBoundedUsd(value.additionalGuardUsd, false) ||
    !isBoundedUsd(value.cumulativeGuardUsd, false) ||
    !isBoundedInteger(value.continuationIndex, MAX_BUDGET_CONTINUATIONS) ||
    (value.continuationIndex as number) < 1 ||
    !isBoundedText(
      value.providerSessionId,
      MAX_PROVIDER_SESSION_ID_LENGTH,
    )
  ) {
    return undefined;
  }

  const additionalGuardUsd = roundBudgetUsd(
    value.additionalGuardUsd as number,
  );
  const cumulativeGuardUsd = roundBudgetUsd(
    value.cumulativeGuardUsd as number,
  );
  if (cumulativeGuardUsd < additionalGuardUsd) return undefined;

  return {
    ...extensionBase(value),
    kind: "budget-continuation",
    providerSessionId: value.providerSessionId as string,
    additionalGuardUsd,
    cumulativeGuardUsd,
    continuationIndex: value.continuationIndex as number,
  };
}

function isValidExtensionBase(value: Record<string, unknown>): boolean {
  if (
    value.version !== TASK_EXTENSION_RECORD_VERSION ||
    value.source !== "auto" ||
    !Number.isSafeInteger(value.attempt) ||
    (value.attempt as number) < 0 ||
    !isBoundedText(
      value.extensionId,
      MAX_EXTENSION_ID_LENGTH,
      /^[A-Za-z0-9][A-Za-z0-9._:-]*$/,
    ) ||
    !isTimestamp(value.requestedAt) ||
    !isTimestamp(value.grantedAt) ||
    Date.parse(value.grantedAt) < Date.parse(value.requestedAt) ||
    !isBoundedText(value.reason, MAX_EXTENSION_REASON_LENGTH) ||
    !Array.isArray(value.healthyEvidence) ||
    value.healthyEvidence.length === 0 ||
    value.healthyEvidence.length > MAX_HEALTHY_EVIDENCE
  ) {
    return false;
  }
  for (const evidence of value.healthyEvidence) {
    if (!isBoundedText(evidence, MAX_HEALTHY_EVIDENCE_LENGTH)) return false;
  }
  if (
    value.providerSessionId !== undefined &&
    !isBoundedText(
      value.providerSessionId,
      MAX_PROVIDER_SESSION_ID_LENGTH,
    )
  ) {
    return false;
  }
  return true;
}

function extensionBase(
  value: Record<string, unknown>,
): TaskExtensionRecordBase {
  return {
    version: TASK_EXTENSION_RECORD_VERSION,
    extensionId: value.extensionId as string,
    attempt: value.attempt as number,
    source: "auto",
    requestedAt: value.requestedAt as string,
    grantedAt: value.grantedAt as string,
    reason: value.reason as string,
    healthyEvidence: (value.healthyEvidence as unknown[]).map(
      (item) => item as string,
    ),
    ...(value.providerSessionId !== undefined
      ? { providerSessionId: value.providerSessionId as string }
      : {}),
  };
}

/**
 * Append without dropping evidence. Replaying the exact same extension id is
 * idempotent; reusing an id for different evidence is rejected.
 */
export function appendTaskExtensionRecord(
  existing: readonly TaskExtensionRecord[] | undefined,
  record: TaskExtensionRecord,
): TaskExtensionRecord[] {
  const parsed = parseTaskExtensionRecord(record);
  if (!parsed) throw new Error("invalid task extension record");
  const current = normalizeTaskExtensions(existing);
  const previous = current.find(
    (item) => item.extensionId === parsed.extensionId,
  );
  if (previous) {
    if (JSON.stringify(previous) !== JSON.stringify(parsed)) {
      throw new Error(
        `task extension id ${parsed.extensionId} has conflicting evidence`,
      );
    }
    return current;
  }
  if (parsed.kind === "budget-continuation") {
    const continuationConflict = current.find(
      (item) =>
        item.kind === "budget-continuation" &&
        item.attempt === parsed.attempt &&
        item.continuationIndex === parsed.continuationIndex,
    );
    if (continuationConflict) {
      throw new Error(
        `attempt ${parsed.attempt} already has budget continuation ` +
          `${parsed.continuationIndex}`,
      );
    }
  }
  if (current.length >= MAX_TASK_EXTENSIONS) {
    throw new Error(
      `task extension history is limited to ${MAX_TASK_EXTENSIONS} records`,
    );
  }
  return [...current, parsed];
}

export function mergeTaskExtensionRecords(
  existing: readonly TaskExtensionRecord[] | undefined,
  observed: readonly TaskExtensionRecord[] | undefined,
): TaskExtensionRecord[] {
  let merged = normalizeTaskExtensions(existing);
  for (const record of observed ?? []) {
    merged = appendTaskExtensionRecord(merged, record);
  }
  return merged;
}

function normalizeTaskExtensions(
  value: readonly TaskExtensionRecord[] | undefined,
): TaskExtensionRecord[] {
  if ((value?.length ?? 0) > MAX_TASK_EXTENSIONS) {
    throw new Error(
      `task extension history is limited to ${MAX_TASK_EXTENSIONS} records`,
    );
  }
  const normalized: TaskExtensionRecord[] = [];
  const ids = new Set<string>();
  const continuationIndexes = new Set<string>();
  for (const item of value ?? []) {
    const valid = parseTaskExtensionRecord(item);
    if (!valid) throw new Error("invalid existing task extension record");
    if (ids.has(valid.extensionId)) {
      throw new Error(
        `duplicate task extension id ${valid.extensionId}`,
      );
    }
    ids.add(valid.extensionId);
    if (valid.kind === "budget-continuation") {
      const continuityKey = `${valid.attempt}:${valid.continuationIndex}`;
      if (continuationIndexes.has(continuityKey)) {
        throw new Error(
          `duplicate budget continuation index ${valid.continuationIndex} ` +
            `for attempt ${valid.attempt}`,
        );
      }
      continuationIndexes.add(continuityKey);
    }
    normalized.push(valid);
  }
  return normalized;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPositiveTimerMs(value: unknown): value is number {
  return (
    Number.isSafeInteger(value) &&
    (value as number) > 0 &&
    (value as number) <= MAX_DEADLINE_TIMEOUT_MS
  );
}

function isBoundedInteger(value: unknown, max: number): value is number {
  return (
    Number.isSafeInteger(value) &&
    (value as number) >= 0 &&
    (value as number) <= max
  );
}

function isBoundedUsd(value: unknown, allowZero: boolean): value is number {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < (allowZero ? 0 : Number.MIN_VALUE) ||
    value > MAX_BUDGET_GUARD_USD
  ) {
    return false;
  }
  if (!allowZero && value === 0) return false;
  const scaled = value * 10 ** MAX_BUDGET_DECIMALS;
  return Math.abs(scaled - Math.round(scaled)) <= 1e-6;
}

function roundBudgetUsd(value: number): number {
  return Math.round(value * 10 ** MAX_BUDGET_DECIMALS) /
    10 ** MAX_BUDGET_DECIMALS;
}

function isTimestamp(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 64 &&
    !Number.isNaN(Date.parse(value))
  );
}

function isBoundedText(
  value: unknown,
  maxLength: number,
  pattern?: RegExp,
): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= maxLength &&
    !value.includes("\0") &&
    (pattern === undefined || pattern.test(value))
  );
}

/**
 * Versioned, bounded continuation evidence shared by workers and the
 * Supervisor. Deadline grants extend the cliyard-owned wall-clock timer only;
 * they never change provider budget, TaskContract or acceptance authority.
 */

export const DEADLINE_EXTENSION_POLICY_VERSION = 1 as const;
export const TASK_EXTENSION_RECORD_VERSION = 1 as const;

/** Node timers do not reliably support delays beyond signed 32-bit ints. */
export const MAX_DEADLINE_TIMEOUT_MS = 2_147_483_647;
export const MAX_DEADLINE_EXTENSIONS = 64;
export const MAX_TASK_EXTENSIONS = 64;
export const MAX_HEALTHY_EVIDENCE = 16;
export const MAX_HEALTHY_EVIDENCE_LENGTH = 240;
export const MAX_EXTENSION_REASON_LENGTH = 500;
export const MAX_EXTENSION_ID_LENGTH = 128;
export const MAX_PROVIDER_SESSION_ID_LENGTH = 256;

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

export interface TaskExtensionRecord {
  version: typeof TASK_EXTENSION_RECORD_VERSION;
  extensionId: string;
  attempt: number;
  kind: "deadline";
  source: "auto";
  requestedAt: string;
  grantedAt: string;
  reason: string;
  /** Bounded labels and timestamps for mapped assistant/tool events. */
  healthyEvidence: string[];
  providerSessionId?: string;
  extensionMs: number;
  cumulativeTimeoutMs: number;
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

/** Parse one deadline grant, dropping unknown fields and rejecting ambiguity. */
export function parseTaskExtensionRecord(
  value: unknown,
): TaskExtensionRecord | undefined {
  if (!isRecord(value)) return undefined;
  if (
    value.version !== TASK_EXTENSION_RECORD_VERSION ||
    value.kind !== "deadline" ||
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
    value.healthyEvidence.length > MAX_HEALTHY_EVIDENCE ||
    !isPositiveTimerMs(value.extensionMs) ||
    !isPositiveTimerMs(value.cumulativeTimeoutMs) ||
    (value.cumulativeTimeoutMs as number) < (value.extensionMs as number)
  ) {
    return undefined;
  }

  const healthyEvidence: string[] = [];
  for (const evidence of value.healthyEvidence) {
    if (!isBoundedText(evidence, MAX_HEALTHY_EVIDENCE_LENGTH)) {
      return undefined;
    }
    healthyEvidence.push(evidence);
  }

  let providerSessionId: string | undefined;
  if (value.providerSessionId !== undefined) {
    if (
      !isBoundedText(
        value.providerSessionId,
        MAX_PROVIDER_SESSION_ID_LENGTH,
      )
    ) {
      return undefined;
    }
    providerSessionId = value.providerSessionId;
  }

  return {
    version: TASK_EXTENSION_RECORD_VERSION,
    extensionId: value.extensionId as string,
    attempt: value.attempt as number,
    kind: "deadline",
    source: "auto",
    requestedAt: value.requestedAt as string,
    grantedAt: value.grantedAt as string,
    reason: value.reason as string,
    healthyEvidence,
    ...(providerSessionId !== undefined ? { providerSessionId } : {}),
    extensionMs: value.extensionMs as number,
    cumulativeTimeoutMs: value.cumulativeTimeoutMs as number,
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
  for (const item of value ?? []) {
    const valid = parseTaskExtensionRecord(item);
    if (!valid) throw new Error("invalid existing task extension record");
    if (ids.has(valid.extensionId)) {
      throw new Error(
        `duplicate task extension id ${valid.extensionId}`,
      );
    }
    ids.add(valid.extensionId);
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

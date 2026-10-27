/**
 * Worker failure taxonomy and cost truth
 * (design/failure-cost-truth-v0.md).
 *
 * This module is the single source for the failure/cost shapes, the
 * design-priority classifier, bounded credential-free failure messages,
 * fail-closed parsers and the cost aggregation/completeness helpers.
 *
 * Failure and cost are observational. Neither grants acceptance nor
 * authorizes an automatic retry, dispatch or merge.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export const FAILURE_CATEGORIES = [
  "budget_exhausted",
  "timeout",
  "provider_transient",
  "provider_auth",
  "provider_protocol",
  "worker_process_exit",
  "verifier_rejected",
  "policy_blocked",
  "resource_exhausted",
  "unknown",
] as const;

export type FailureCategory = (typeof FAILURE_CATEGORIES)[number];

export const FAILURE_STAGES = [
  "contract",
  "preflight",
  "spawn",
  "provider",
  "worker",
  "verifier",
  "policy",
  "unknown",
] as const;

export type FailureStage = (typeof FAILURE_STAGES)[number];

export interface FailureRecord {
  version: 1;
  category: FailureCategory;
  stage: FailureStage;
  code?: string;
  message: string;
  observedAt: string;
  retryableHint?: boolean;
}

export interface TokenUsage {
  inputTokens: number | null;
  outputTokens: number | null;
  cacheCreationInputTokens: number | null;
  cacheReadInputTokens: number | null;
}

export const COST_STATES = [
  "provider-reported",
  "cli-estimated",
  "usage-only",
  "unavailable",
] as const;

export type CostState = (typeof COST_STATES)[number];

export const COST_SOURCES = ["provider", "cli", "none"] as const;

export type CostSource = (typeof COST_SOURCES)[number];

export interface CostObservation {
  sessionId: string;
  state: CostState;
  source: CostSource;
  currency: string | null;
  amount: number | null;
  usage: TokenUsage | null;
  note?: string;
}

export interface CostTruth {
  version: 1;
  state: CostState;
  source: CostSource;
  authoritative: boolean;
  currency: string | null;
  amount: number | null;
  usage: TokenUsage | null;
  guardBudgetUsd: number | null;
  observations: CostObservation[];
  missing: string[];
}

export type CostCompleteness = "complete" | "partial" | "missing";

/** Bounds shared by creation and validation. */
export const MAX_FAILURE_MESSAGE = 400;
const MAX_FAILURE_CODE = 64;
const MAX_FAILURE_TEXT_SCAN = 8_000;
const MAX_SESSION_ID = 128;
const MAX_CURRENCY_LENGTH = 24;
const MAX_OBSERVATION_NOTE = 300;
const MAX_MISSING_REASON = 200;
const MAX_MISSING_REASONS = 128;

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

/**
 * Signals used to classify a failure. `text` is bounded and normalized by
 * {@link createFailureRecord}; it is never retained raw.
 */
export interface FailureSignals {
  /** Adapter/harness wall-clock timeout flag. Highest priority signal. */
  timedOut?: boolean;
  /** Raw worker process exit code (not the normalized AgentResult exit). */
  exitCode?: number | null;
  /** Terminating signal, when the worker was killed. */
  signal?: string | null;
  /** Bounded provider/worker error text used only for classification. */
  text?: string | null;
  /** The worker process could not be spawned at all. */
  spawnFailed?: boolean;
  /** The provider returned an is_error result. Stage hint when no category. */
  providerError?: boolean;
  /** A post-run check (for example git diff) failed after the worker ran. */
  postCheckFailed?: boolean;
  /** The provider result itself succeeded and a later verifier rejected it. */
  workerSucceeded?: boolean;
  verifierRejected?: boolean;
  /** Deterministic control-plane rejection before dispatch. */
  policyBlocked?: boolean;
  /**
   * Provider result subtype, for example `error_max_budget_usd`. Bounded and
   * credential-free before it can reach a failure record code.
   */
  subtype?: string;
  /** Explicit stage override. */
  stage?: FailureStage;
  /** Explicit machine code override, bounded to 64 characters. */
  code?: string;
  /** Advisory only; cannot trigger retry by itself. */
  retryableHint?: boolean;
  /** Additional operator context appended to the message, never classified. */
  messageDetail?: string;
  /** Injectable clock for deterministic records. */
  observedAt?: string | Date;
  timeoutMs?: number;
}

export interface FailureClassification {
  category: FailureCategory;
  stage: FailureStage;
}

const TIMEOUT_TEXT =
  /\b(?:timed?\s*out|timeout|deadline (?:exceeded|expired)|ETIMEDOUT|took too long|exceeded the time limit)\b/i;

// A 429/5xx is a transient provider failure even when its status text contains
// "timeout" (for example "504 Gateway Timeout"). Wall-clock timeouts arrive as
// the adapter flag or exit code 124; other timeout text wins unless a numeric
// transient status is also present.
const TRANSIENT_STATUS_TEXT = /\b(?:429|500|502|503|504|529)\b/;
const TRANSIENT_TEXT =
  /\b(?:429|500|502|503|504|529)\b|\b(?:rate.?limit(?:ed|ing)?|too many requests|overloaded|ECONNRESET|ECONNREFUSED|EPIPE|socket hang up|connection (?:to the API )?(?:was )?(?:lost|reset)|service (?:is )?unavailable|bad gateway|temporarily unavailable|try again(?: later)?|network (?:error|failure))\b/i;

const BUDGET_TEXT =
  /\b(?:budget[ _-]?(?:exhausted|exceeded|limit(?:[ _-]reached)?)|max(?:imum)?[ _-]?budget(?:[ _-](?:exceeded|reached))?|spending[ _-](?:limit|cap)|spend[ _-]limit|insufficient[ _](?:credits?|quota|balance|funds)|quota[ _](?:exhausted|exceeded|reached)|out of[ _](?:credits?|quota)|credit[ _]balance|billing[ _](?:hard[ _])?limit|usage[ _]limit(?:[ _](?:reached|exceeded))?|payment required)\b/i;

const AUTH_TEXT =
  /\b(?:401|403)\b|\bunauthori[sz]ed\b|\bunauthenticated\b|\bauthentication (?:failed|error|required)\b|\binvalid[ _-](?:api[ _-]?key|x-api-key|token|credentials?)\b|\bapi[ _-]?key[ _](?:is[ _])?(?:invalid|missing|expired|revoked)\b|\bpermission denied\b|\bforbidden\b|\bnot authorized\b|\btoken[ _](?:has[ _])?expired\b|\binvalid[ _]bearer\b|\boauth\b/i;

const RESOURCE_TEXT =
  /\bENOMEM\b|\bOOM(?:Killed)?\b|\bout[ _]of[ _]memory\b|\bheap[ _]out[ _]of[ _]memory\b|\bmemory[ _](?:limit|exhausted|allocation failed)\b|\bresource[ _]exhausted\b|\bENOSPC\b|\bno[ _]space[ _]left\b|\bEMFILE\b|\bENFILE\b|\btoo[ _]many[ _]open[ _]files\b|\bdisk[ _](?:full|space)\b|\bEAGAIN\b/i;

const PROTOCOL_TEXT =
  /\b(?:invalid|malformed|unexpected)[ _](?:json|jsonl|response|record|stream|message|payload)\b|\bjson[ _](?:parse|parsing)[ _]?(?:error|failed)\b|\bunexpected[ _]token\b|\bschema[ _](?:validation[ _])?(?:failed|mismatch)\b|\bprotocol[ _](?:error|violation|mismatch)\b|\bunsupported[ _](?:message|record|event)[ _]type\b|\bmissing[ _]required[ _](?:field|result)\b|\bstream[ _](?:ended|closed)[ _]before[ _](?:a[ _])?result\b|\bunexpected[ _]end[ _]of[ _](?:json|stream|input)\b|\b(?:400|422)[ _-]?(?:bad request|invalid|unprocessable)\b|\binvalid_request_error\b/i;

/**
 * Classify a failure using the design priority:
 *
 * timeout > budget > auth > resource > transient > protocol >
 * worker process exit > verifier > policy > unknown.
 *
 * A provider subtype is a direct signal, but it never outranks an explicit
 * wall-clock timeout. Only the known budget subtype changes the category;
 * unknown subtypes remain codes for the normal signal-based classification.
 */
export function classifyFailure(
  signals: FailureSignals = {},
): FailureClassification {
  const text =
    typeof signals.text === "string"
      ? signals.text.slice(-MAX_FAILURE_TEXT_SCAN)
      : "";
  const exitCode =
    typeof signals.exitCode === "number" && Number.isFinite(signals.exitCode)
      ? signals.exitCode
      : null;
  const signal =
    typeof signals.signal === "string" && signals.signal.trim()
      ? signals.signal.trim()
      : null;
  const subtype = normalizeFailureCode(signals.subtype);
  const transient = TRANSIENT_TEXT.test(text);
  const explicitTimeout =
    signals.timedOut === true ||
    exitCode === 124 ||
    (!TRANSIENT_STATUS_TEXT.test(text) && TIMEOUT_TEXT.test(text));
  const processFailed =
    signals.spawnFailed === true ||
    (exitCode !== null && exitCode !== 0) ||
    signal !== null;

  let category: FailureCategory;
  if (explicitTimeout) {
    category = "timeout";
  } else if (subtype === "error_max_budget_usd") {
    category = "budget_exhausted";
  } else if (BUDGET_TEXT.test(text)) {
    category = "budget_exhausted";
  } else if (AUTH_TEXT.test(text)) {
    category = "provider_auth";
  } else if (RESOURCE_TEXT.test(text)) {
    category = "resource_exhausted";
  } else if (transient) {
    category = "provider_transient";
  } else if (PROTOCOL_TEXT.test(text)) {
    category = "provider_protocol";
  } else if (processFailed) {
    category = "worker_process_exit";
  } else if (signals.verifierRejected === true && signals.workerSucceeded === true) {
    category = "verifier_rejected";
  } else if (signals.policyBlocked === true) {
    category = "policy_blocked";
  } else {
    category = "unknown";
  }

  return { category, stage: failureStage(category, signals, exitCode) };
}

function failureStage(
  category: FailureCategory,
  signals: FailureSignals,
  exitCode: number | null,
): FailureStage {
  if (signals.stage) return signals.stage;
  switch (category) {
    case "timeout":
      return signals.timedOut === true || exitCode === 124
        ? "worker"
        : "provider";
    case "budget_exhausted":
    case "provider_transient":
    case "provider_auth":
    case "provider_protocol":
      return "provider";
    case "resource_exhausted":
      return "worker";
    case "worker_process_exit":
      return signals.spawnFailed === true ? "spawn" : "worker";
    case "verifier_rejected":
      return "verifier";
    case "policy_blocked":
      return "policy";
    case "unknown":
      if (signals.providerError === true) return "provider";
      if (signals.postCheckFailed === true) return "worker";
      return "unknown";
  }
}

/**
 * Build a bounded, credential-free record. Unknown provider payload fields are
 * never copied: only the fields declared on FailureRecord leave this function.
 */
export function createFailureRecord(
  signals: FailureSignals = {},
): FailureRecord {
  const { category, stage } = classifyFailure(signals);
  const detail = signals.messageDetail
    ? boundFailureText(signals.messageDetail, 160)
    : "";
  const textPart = signals.text
    ? boundFailureText(
        signals.text,
        detail ? Math.floor(MAX_FAILURE_MESSAGE / 2) : MAX_FAILURE_MESSAGE,
      )
    : "";
  let message = textPart || defaultFailureMessage(category, signals);
  if (detail) message = message ? `${message} (${detail})` : detail;
  message = boundFailureText(message, MAX_FAILURE_MESSAGE);
  if (!message) message = "unclassified worker failure";

  const code = failureCode(category, signals);
  const retryableHint = signals.retryableHint ?? defaultRetryable(category);

  return {
    version: 1,
    category,
    stage,
    ...(code ? { code } : {}),
    message,
    observedAt: isoTime(signals.observedAt),
    retryableHint,
  };
}

function defaultFailureMessage(
  category: FailureCategory,
  signals: FailureSignals,
): string {
  switch (category) {
    case "budget_exhausted":
      return "provider reported budget exhaustion";
    case "timeout": {
      const timeoutMs = signals.timeoutMs;
      return Number.isFinite(timeoutMs) && (timeoutMs as number) > 0
        ? `worker timed out after ${Math.floor(timeoutMs as number)}ms`
        : "worker timed out";
    }
    case "provider_transient":
      return "provider reported a transient failure";
    case "provider_auth":
      return "provider rejected authentication or authorization";
    case "provider_protocol":
      return "provider protocol or parse incompatibility";
    case "worker_process_exit":
      if (signals.spawnFailed === true) return "worker process failed to start";
      if (typeof signals.signal === "string" && signals.signal.trim()) {
        return `worker process terminated by signal ${boundFailureText(signals.signal, 40)}`;
      }
      if (
        typeof signals.exitCode === "number" &&
        signals.exitCode !== 0 &&
        Number.isFinite(signals.exitCode)
      ) {
        return `worker process exited with code ${signals.exitCode}`;
      }
      return "worker process failed";
    case "verifier_rejected":
      return "verifier rejected the worker result";
    case "policy_blocked":
      return "blocked by policy";
    case "resource_exhausted":
      return "worker exhausted a system resource";
    case "unknown":
      if (signals.providerError === true)
        return "provider reported an unclassified error";
      if (signals.postCheckFailed === true) return "post-run check failed";
      return "unclassified worker failure";
  }
}

function defaultRetryable(category: FailureCategory): boolean {
  return (
    category === "provider_transient" ||
    category === "timeout" ||
    category === "resource_exhausted"
  );
}

function failureCode(
  category: FailureCategory,
  signals: FailureSignals,
): string | undefined {
  const explicit = normalizeFailureCode(signals.code);
  if (explicit) return explicit;
  // A wall-clock timeout outranks a provider subtype, including in the code.
  if (category === "timeout") return "timeout";
  // Preserve an unknown provider subtype as the bounded code without deriving
  // a category from it. A success subtype is not a failure code.
  const subtype = normalizeFailureCode(signals.subtype);
  if (subtype && subtype !== "success") return subtype;
  if (signals.spawnFailed === true) return "spawn_error";
  if (typeof signals.signal === "string" && signals.signal.trim()) {
    return sanitizeCode(`signal_${signals.signal}`);
  }
  if (
    typeof signals.exitCode === "number" &&
    signals.exitCode !== 0 &&
    Number.isFinite(signals.exitCode)
  ) {
    return sanitizeCode(`exit_${signals.exitCode}`);
  }
  return undefined;
}

/**
 * Normalize an untrusted subtype or code into the bounded, credential-free
 * code space. Raw provider subtypes are never retained beyond this shape.
 */
export function normalizeFailureCode(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  const code = sanitizeCode(trimmed);
  return code || undefined;
}

function sanitizeCode(value: string): string {
  const redacted = redactFailureSecrets(value).replace(
    // A subtype can glue a token directly to an identifier separator, where
    // the shared word-boundary patterns would miss it.
    /(?:sk-[A-Za-z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16})/g,
    "[redacted]",
  );
  return redacted
    .replace(/\s+/g, "_")
    .replace(/[^A-Za-z0-9_.:-]/g, "_")
    .slice(0, MAX_FAILURE_CODE);
}

function isoTime(value?: string | Date): string {
  if (value instanceof Date) {
    if (!Number.isNaN(value.getTime())) return value.toISOString();
  } else if (typeof value === "string") {
    const parsed = Date.parse(value);
    if (!Number.isNaN(parsed)) return new Date(parsed).toISOString();
  }
  return new Date().toISOString();
}

// ---------------------------------------------------------------------------
// Bounded, credential-free text
// ---------------------------------------------------------------------------

const SECRET_PATTERNS: ReadonlyArray<[RegExp, string]> = [
  [/\b(sk-[A-Za-z0-9_-]{8,})\b/g, "[redacted]"],
  [/\b(gh[pousr]_[A-Za-z0-9]{20,})\b/g, "[redacted]"],
  [/\b(xox[baprs]-[A-Za-z0-9-]{10,})\b/g, "[redacted]"],
  [/\b(AKIA[0-9A-Z]{16})\b/g, "[redacted]"],
  [/\bBearer\s+[A-Za-z0-9._~+/-]{8,}=*/gi, "Bearer [redacted]"],
  [
    /\b(api[_-]?key|access[_-]?token|client[_-]?secret|password|authorization)\b\s*[:=]\s*\S+/gi,
    "$1=[redacted]",
  ],
  [
    /("(?:api[_-]?key|access[_-]?token|client[_-]?secret|password|authorization)"\s*:\s*")[^"]*(")/gi,
    "$1[redacted]$2",
  ],
  [
    /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
    "[redacted private key]",
  ],
];

export function redactFailureSecrets(text: string): string {
  let redacted = text;
  for (const [pattern, replacement] of SECRET_PATTERNS) {
    redacted = redacted.replace(pattern, replacement);
  }
  return redacted;
}

/**
 * Collapse, redact and bound a text value. The tail is scanned because failure
 * records should preserve the final provider error, not the start of a
 * transcript.
 */
export function boundFailureText(
  text: unknown,
  max = MAX_FAILURE_MESSAGE,
): string {
  if (typeof text !== "string") return "";
  const limit = Number.isFinite(max) && max > 0 ? Math.floor(max) : 1;
  const collapsed = text
    .slice(-MAX_FAILURE_TEXT_SCAN)
    .replace(/\s+/g, " ")
    .trim();
  if (!collapsed) return "";
  const redacted = redactFailureSecrets(collapsed);
  if (!redacted) return "";
  return redacted.length <= limit
    ? redacted
    : `${redacted.slice(0, Math.max(0, limit - 1))}…`;
}

// ---------------------------------------------------------------------------
// Fail-closed parsers and validators
// ---------------------------------------------------------------------------

export function isFailureCategory(value: unknown): value is FailureCategory {
  return (
    typeof value === "string" &&
    (FAILURE_CATEGORIES as readonly string[]).includes(value)
  );
}

export function isFailureStage(value: unknown): value is FailureStage {
  return (
    typeof value === "string" &&
    (FAILURE_STAGES as readonly string[]).includes(value)
  );
}

export function isCostState(value: unknown): value is CostState {
  return (
    typeof value === "string" &&
    (COST_STATES as readonly string[]).includes(value)
  );
}

export function isCostSource(value: unknown): value is CostSource {
  return (
    typeof value === "string" &&
    (COST_SOURCES as readonly string[]).includes(value)
  );
}

/**
 * Parse and validate a durable failure record. Unknown fields are dropped and
 * any malformed required field fails closed to null.
 */
export function parseFailureRecord(value: unknown): FailureRecord | null {
  if (!isRecord(value) || value.version !== 1) return null;
  if (!isFailureCategory(value.category) || !isFailureStage(value.stage)) {
    return null;
  }
  if (typeof value.message !== "string") return null;
  const message = value.message.trim();
  if (!message || message.length > MAX_FAILURE_MESSAGE) return null;
  const observedAt = parseIsoTime(value.observedAt);
  if (!observedAt) return null;

  let code: string | undefined;
  if (value.code !== undefined) {
    if (typeof value.code !== "string") return null;
    const trimmed = value.code.trim();
    if (!trimmed || trimmed.length > MAX_FAILURE_CODE) return null;
    code = trimmed;
  }

  if (
    value.retryableHint !== undefined &&
    typeof value.retryableHint !== "boolean"
  ) {
    return null;
  }

  return {
    version: 1,
    category: value.category,
    stage: value.stage,
    ...(code ? { code } : {}),
    message,
    observedAt,
    ...(value.retryableHint !== undefined
      ? { retryableHint: value.retryableHint }
      : {}),
  };
}

export function isFailureRecord(value: unknown): value is FailureRecord {
  return parseFailureRecord(value) !== null;
}

/**
 * Parse token usage defensively. Accepts the provider's snake_case fields and
 * the internal camelCase shape; malformed fields become null. A usage object
 * with no valid numeric field is not usage at all and fails closed to null.
 */
export function parseTokenUsage(value: unknown): TokenUsage | null {
  if (!isRecord(value)) return null;
  const usage: TokenUsage = {
    inputTokens: firstTokenCount(value.input_tokens, value.inputTokens),
    outputTokens: firstTokenCount(value.output_tokens, value.outputTokens),
    cacheCreationInputTokens: firstTokenCount(
      value.cache_creation_input_tokens,
      value.cacheCreationInputTokens,
    ),
    cacheReadInputTokens: firstTokenCount(
      value.cache_read_input_tokens,
      value.cacheReadInputTokens,
    ),
  };
  return Object.values(usage).some((field) => field !== null) ? usage : null;
}

function firstTokenCount(...values: unknown[]): number | null {
  for (const value of values) {
    if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) {
      return value;
    }
  }
  return null;
}

/** Parse a non-negative finite currency amount; anything else is unavailable. */
export function parseCostAmount(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : null;
}

/**
 * Sum a set of usage observations. A field is only summed when every provided
 * usage reports a valid value; otherwise that field remains missing.
 */
export function sumTokenUsage(
  usages: ReadonlyArray<TokenUsage | null | undefined>,
): TokenUsage | null {
  const present = usages.filter(
    (usage): usage is TokenUsage => usage !== null && usage !== undefined,
  );
  if (present.length === 0) return null;
  const sumField = (key: keyof TokenUsage): number | null => {
    let total = 0;
    for (const usage of present) {
      const field = usage[key];
      if (
        typeof field !== "number" ||
        !Number.isSafeInteger(field) ||
        field < 0
      ) {
        return null;
      }
      total += field;
    }
    return total;
  };
  const summed: TokenUsage = {
    inputTokens: sumField("inputTokens"),
    outputTokens: sumField("outputTokens"),
    cacheCreationInputTokens: sumField("cacheCreationInputTokens"),
    cacheReadInputTokens: sumField("cacheReadInputTokens"),
  };
  return Object.values(summed).some((field) => field !== null)
    ? summed
    : null;
}

/**
 * Parse and validate one cost observation. Inconsistent state/source/amount
 * combinations fail closed rather than being repaired by guessing.
 */
export function parseCostObservation(value: unknown): CostObservation | null {
  if (!isRecord(value)) return null;
  if (typeof value.sessionId !== "string") return null;
  const sessionId = value.sessionId.trim();
  if (!sessionId || sessionId.length > MAX_SESSION_ID) return null;
  if (!isCostState(value.state) || !isCostSource(value.source)) return null;

  const amount = externalAmount(value.amount);
  if (!amount.ok) return null;
  const usage = externalUsage(value.usage);
  if (!usage.ok) return null;
  const currency = externalCurrency(value.currency);
  if (!currency.ok) return null;

  let note: string | undefined;
  if (value.note !== undefined) {
    if (
      typeof value.note !== "string" ||
      value.note.length > MAX_OBSERVATION_NOTE
    ) {
      return null;
    }
    const trimmed = value.note.trim();
    if (trimmed) note = trimmed;
  }

  switch (value.state) {
    case "provider-reported":
      // A provider amount without a currency is not attributable and must not
      // be presented as provider-reported.
      if (
        value.source !== "provider" ||
        amount.value === null ||
        currency.value === null
      ) {
        return null;
      }
      break;
    case "cli-estimated":
      if (value.source !== "cli" || amount.value === null) return null;
      break;
    case "usage-only":
      if (
        value.source !== "none" ||
        amount.value !== null ||
        usage.value === null
      ) {
        return null;
      }
      break;
    case "unavailable":
      if (
        value.source !== "none" ||
        amount.value !== null ||
        usage.value !== null
      ) {
        return null;
      }
      break;
  }

  return {
    sessionId,
    state: value.state,
    source: value.source,
    currency: currency.value,
    amount: amount.value,
    usage: usage.value,
    ...(note ? { note } : {}),
  };
}

export function isCostObservation(value: unknown): value is CostObservation {
  return parseCostObservation(value) !== null;
}

/** Parse and validate a durable CostTruth record; malformed input is null. */
export function parseCostTruth(value: unknown): CostTruth | null {
  if (!isRecord(value) || value.version !== 1) return null;
  if (!isCostState(value.state) || !isCostSource(value.source)) return null;
  if (typeof value.authoritative !== "boolean") return null;

  const amount = externalAmount(value.amount);
  if (!amount.ok) return null;
  const usage = externalUsage(value.usage);
  if (!usage.ok) return null;
  const currency = externalCurrency(value.currency);
  if (!currency.ok) return null;

  let guardBudgetUsd: number | null;
  if (value.guardBudgetUsd === null) {
    guardBudgetUsd = null;
  } else {
    const parsed = parseCostAmount(value.guardBudgetUsd);
    if (parsed === null) return null;
    guardBudgetUsd = parsed;
  }

  if (!Array.isArray(value.observations)) return null;
  const observations: CostObservation[] = [];
  for (const raw of value.observations) {
    const observation = parseCostObservation(raw);
    if (!observation) return null;
    observations.push(observation);
  }

  const missing = externalMissing(value.missing);
  if (!missing.ok) return null;

  switch (value.state) {
    case "provider-reported":
      if (value.source !== "provider" || amount.value === null) return null;
      if (value.authoritative) {
        // An authoritative provider total needs complete provenance: a known
        // currency, no amount/currency gap and no non-provider observation.
        if (currency.value === null) return null;
        if (
          missing.value.includes("cost.amount") ||
          missing.value.includes("cost.currency")
        ) {
          return null;
        }
        if (
          observations.some(
            (observation) => observation.state !== "provider-reported",
          )
        ) {
          return null;
        }
      }
      break;
    case "cli-estimated":
      if (
        value.source !== "cli" ||
        value.authoritative !== false ||
        amount.value === null
      ) {
        return null;
      }
      break;
    case "usage-only":
      if (
        value.source !== "none" ||
        value.authoritative !== false ||
        amount.value !== null ||
        usage.value === null
      ) {
        return null;
      }
      break;
    case "unavailable":
      if (
        value.source !== "none" ||
        value.authoritative !== false ||
        amount.value !== null ||
        usage.value !== null
      ) {
        return null;
      }
      break;
  }

  return {
    version: 1,
    state: value.state,
    source: value.source,
    authoritative: value.authoritative,
    currency: currency.value,
    amount: amount.value,
    usage: usage.value,
    guardBudgetUsd,
    observations,
    missing: missing.value,
  };
}

export function isCostTruth(value: unknown): value is CostTruth {
  return parseCostTruth(value) !== null;
}

// ---------------------------------------------------------------------------
// Cost construction and aggregation
// ---------------------------------------------------------------------------

export interface CostObservationInput {
  sessionId: string;
  /** Raw amount; malformed values become null rather than zero. */
  amount?: unknown;
  /** Raw usage record or an already-parsed TokenUsage. */
  usage?: unknown;
  currency?: string | null;
  /** Cost source when an amount is present. Defaults to the CLI. */
  source?: Extract<CostSource, "cli" | "provider">;
  note?: string;
}

export function createCostObservation(
  input: CostObservationInput,
): CostObservation {
  const rawSessionId =
    typeof input.sessionId === "string" ? input.sessionId.trim() : "";
  const sessionId = rawSessionId
    ? redactFailureSecrets(rawSessionId).replace(/\s+/g, " ").slice(0, MAX_SESSION_ID)
    : "";
  if (!sessionId) {
    throw new Error("cost observation requires a non-empty sessionId");
  }

  const parsedAmount = parseCostAmount(input.amount);
  const usage = parseTokenUsage(input.usage);
  const providerRequested = input.source === "provider";
  const parsedCurrency = normalizeCurrency(input.currency);
  // Provider-reported truth must be attributable. Without a currency the
  // amount is unusable, so fail closed to usage-only/unavailable instead of
  // emitting a provider observation the parser would reject.
  const amount =
    parsedAmount !== null && (!providerRequested || parsedCurrency !== null)
      ? parsedAmount
      : null;
  const source: CostSource =
    amount !== null ? (providerRequested ? "provider" : "cli") : "none";
  const state: CostState =
    amount !== null
      ? source === "provider"
        ? "provider-reported"
        : "cli-estimated"
      : usage !== null
        ? "usage-only"
        : "unavailable";
  const currency = amount !== null ? parsedCurrency : null;
  const note =
    input.note === undefined
      ? ""
      : boundFailureText(input.note, MAX_OBSERVATION_NOTE);

  return {
    sessionId,
    state,
    source,
    currency,
    amount,
    usage,
    ...(note ? { note } : {}),
  };
}

export interface CostTruthInput {
  observations?: CostObservation[];
  guardBudgetUsd?: number | null;
  /** Extra missing reasons, bounded and de-duplicated. */
  missing?: string[];
}

/**
 * Build one truth from provenance observations. Known amounts are summed into
 * a non-authoritative subtotal when their currencies agree; unknown values
 * remain missing. Mixed currencies are never combined.
 */
export function createCostTruth(input: CostTruthInput = {}): CostTruth {
  const observations: CostObservation[] = [];
  for (const raw of input.observations ?? []) {
    const observation = parseCostObservation(raw);
    if (!observation) {
      throw new Error("invalid cost observation");
    }
    observations.push(observation);
  }

  const missing = new Set<string>();
  if (observations.length === 0) missing.add("cost.observation");

  const amountObservations = observations.filter(
    (observation): observation is CostObservation & { amount: number } =>
      observation.amount !== null,
  );

  let amount: number | null = null;
  let currency: string | null = null;

  if (amountObservations.length === 0) {
    missing.add("cost.amount");
  } else {
    const knownCurrencies = new Set<string>();
    let unknownCurrency = false;
    for (const observation of amountObservations) {
      if (observation.currency === null) unknownCurrency = true;
      else knownCurrencies.add(observation.currency);
    }

    if (knownCurrencies.size > 1) {
      // Mixed currencies must not be combined. Provenance stays visible in
      // observations, but the aggregate amount is missing.
      missing.add("cost.amount");
      missing.add("cost.currency");
    } else {
      const total = amountObservations.reduce(
        (sum, observation) => sum + observation.amount,
        0,
      );
      amount =
        amountObservations.length === 1
          ? amountObservations[0].amount
          : roundAmount(total);
      currency =
        knownCurrencies.size === 1 && !unknownCurrency
          ? [...knownCurrencies][0]
          : null;
      if (currency === null) missing.add("cost.currency");
      if (amountObservations.length < observations.length) {
        missing.add("cost.amount");
      }
    }
  }

  const usageObservations = observations.filter(
    (observation): observation is CostObservation & { usage: TokenUsage } =>
      observation.usage !== null,
  );
  let usage: TokenUsage | null = null;
  if (usageObservations.length === 0) {
    missing.add("cost.usage");
  } else {
    const sumField = (key: keyof TokenUsage): number | null => {
      let total = 0;
      for (const observation of usageObservations) {
        const field = observation.usage[key];
        if (field === null) return null;
        total += field;
      }
      return total;
    };
    const summed: TokenUsage = {
      inputTokens: sumField("inputTokens"),
      outputTokens: sumField("outputTokens"),
      cacheCreationInputTokens: sumField("cacheCreationInputTokens"),
      cacheReadInputTokens: sumField("cacheReadInputTokens"),
    };
    if (Object.values(summed).some((field) => field !== null)) {
      usage = summed;
    }
    if (
      usage === null ||
      usageObservations.length < observations.length ||
      Object.values(summed).some((field) => field === null)
    ) {
      missing.add("cost.usage");
    }
  }

  const allProviderAmounts =
    amountObservations.length > 0 &&
    amountObservations.every(
      (observation) => observation.state === "provider-reported",
    );
  const providerOnlyObservations = observations.every(
    (observation) => observation.state === "provider-reported",
  );

  let state: CostState;
  let source: CostSource;
  let authoritative = false;
  if (amount !== null) {
    state = allProviderAmounts ? "provider-reported" : "cli-estimated";
    source = allProviderAmounts ? "provider" : "cli";
    authoritative =
      allProviderAmounts &&
      providerOnlyObservations &&
      currency !== null &&
      !missing.has("cost.amount") &&
      !missing.has("cost.currency");
  } else if (usage !== null) {
    state = "usage-only";
    source = "none";
  } else {
    state = "unavailable";
    source = "none";
  }

  const guardBudgetUsd =
    input.guardBudgetUsd === undefined || input.guardBudgetUsd === null
      ? null
      : parseCostAmount(input.guardBudgetUsd);

  const orderedMissing = canonicalMissing(missing);
  for (const reason of sanitizeMissing(input.missing)) {
    if (!orderedMissing.includes(reason)) orderedMissing.push(reason);
  }

  return {
    version: 1,
    state,
    source,
    authoritative,
    currency: amount !== null ? currency : null,
    amount,
    usage,
    guardBudgetUsd,
    observations,
    missing: orderedMissing,
  };
}

/**
 * Aggregate the cost truths of every worker session (including repairs and
 * internal retries). Unknown observations remain visible in provenance and in
 * `missing`; known amounts become a non-authoritative subtotal.
 */
export function aggregateCostTruth(
  costs: ReadonlyArray<CostTruth | null | undefined>,
  options: { guardBudgetUsd?: number | null; missing?: string[] } = {},
): CostTruth {
  const present = costs.filter((cost): cost is CostTruth => cost != null);
  const observations: CostObservation[] = [];
  const missing: string[] = [];

  for (let index = 0; index < present.length; index += 1) {
    const cost = present[index];
    if (cost.observations.length > 0) {
      observations.push(...cost.observations);
    } else if (cost.amount !== null || cost.usage !== null) {
      // Preserve a top-level-only truth without inventing a real session id.
      observations.push(
        createCostObservation({
          sessionId: `unattributed-${index + 1}`,
          amount: cost.amount,
          usage: cost.usage,
          currency: cost.currency,
          source: cost.source === "provider" ? "provider" : "cli",
          note: "aggregated without per-session provenance",
        }),
      );
      missing.push("cost.observation");
    }
    missing.push(...cost.missing);
  }

  let guardBudgetUsd: number | null;
  if (options.guardBudgetUsd !== undefined) {
    guardBudgetUsd = options.guardBudgetUsd;
  } else {
    guardBudgetUsd = null;
    for (const cost of present) {
      if (cost.guardBudgetUsd === null) continue;
      guardBudgetUsd =
        guardBudgetUsd === null
          ? cost.guardBudgetUsd
          : roundAmount(guardBudgetUsd + cost.guardBudgetUsd);
    }
  }

  return createCostTruth({
    observations,
    guardBudgetUsd,
    missing: [...missing, ...(options.missing ?? [])],
  });
}

/**
 * A truthful "no cost or usage was observed" value. Never coerces to zero.
 */
export function unavailableCostTruth(
  input: {
    sessionId?: string;
    guardBudgetUsd?: number | null;
    missing?: string[];
    note?: string;
  } = {},
): CostTruth {
  const observations = input.sessionId
    ? [
        createCostObservation({
          sessionId: input.sessionId,
          amount: null,
          usage: null,
          ...(input.note ? { note: input.note } : {}),
        }),
      ]
    : [];
  return createCostTruth({
    observations,
    guardBudgetUsd: input.guardBudgetUsd ?? null,
    missing: input.missing,
  });
}

/**
 * Completeness is about observed fields, not authority: a complete CLI
 * estimate still has `authoritative: false`.
 */
export function costCompleteness(
  cost: CostTruth | null | undefined,
): CostCompleteness {
  if (!cost || cost.state === "unavailable") return "missing";
  const usageComplete =
    cost.usage !== null &&
    Object.values(cost.usage).every((field) => field !== null);
  if (cost.amount !== null && usageComplete && cost.missing.length === 0) {
    return "complete";
  }
  return "partial";
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeCurrency(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed && trimmed.length <= MAX_CURRENCY_LENGTH ? trimmed : null;
}

type External<T> = { ok: true; value: T } | { ok: false };

function externalAmount(value: unknown): External<number | null> {
  if (value === null) return { ok: true, value: null };
  const amount = parseCostAmount(value);
  return amount === null ? { ok: false } : { ok: true, value: amount };
}

function externalUsage(value: unknown): External<TokenUsage | null> {
  if (value === null) return { ok: true, value: null };
  const usage = parseTokenUsage(value);
  return usage === null ? { ok: false } : { ok: true, value: usage };
}

function externalCurrency(value: unknown): External<string | null> {
  if (value === null) return { ok: true, value: null };
  const currency = normalizeCurrency(value);
  return currency === null ? { ok: false } : { ok: true, value: currency };
}

function externalMissing(value: unknown): External<string[]> {
  if (!Array.isArray(value) || value.length > MAX_MISSING_REASONS) {
    return { ok: false };
  }
  const missing: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") return { ok: false };
    const reason = item.trim();
    if (!reason || reason.length > MAX_MISSING_REASON) return { ok: false };
    if (!missing.includes(reason)) missing.push(reason);
  }
  return { ok: true, value: missing };
}

function sanitizeMissing(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const missing: string[] = [];
  for (const item of value) {
    if (missing.length >= MAX_MISSING_REASONS) break;
    if (typeof item !== "string") continue;
    const reason = boundFailureText(item, MAX_MISSING_REASON);
    if (reason && !missing.includes(reason)) missing.push(reason);
  }
  return missing;
}

function canonicalMissing(missing: ReadonlySet<string>): string[] {
  const ordered: string[] = [];
  for (const reason of [
    "cost.observation",
    "cost.amount",
    "cost.usage",
    "cost.currency",
  ]) {
    if (missing.has(reason)) ordered.push(reason);
  }
  return ordered;
}

function parseIsoTime(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : new Date(parsed).toISOString();
}

function roundAmount(value: number): number {
  return Math.round((value + Number.EPSILON) * 1e8) / 1e8;
}

/**
 * Deterministic Harness Eval v0 engine.
 *
 * A suite is untrusted data. It is validated before Git or any command is
 * touched. Every command is an argv array executed without a shell against a
 * fixed cwd; the runner bounds retained output, enforces a hard per-command
 * timeout and repeats every scenario exactly as configured. A scenario passes
 * only when every repetition matches its explicit zero/nonzero expectation.
 *
 * This module never calls a model provider. Request, token, cache, cost and
 * human-intervention metrics are `null`/`unavailable` with reasons, never zero.
 */
import { execFile, spawn } from "node:child_process";
import { mkdirSync, statSync, writeFileSync } from "node:fs";
import { isAbsolute, join, parse as parsePath, resolve } from "node:path";
import { promisify } from "node:util";
import {
  EVAL_COST_SOURCES,
  EVAL_COST_STATES,
  EVAL_EXPECTED_EXITS,
  EVAL_SCENARIO_STATUSES,
  HARNESS_EVAL_COMMIT_PATTERN,
  HARNESS_EVAL_COMPARISON_VERSION,
  HARNESS_EVAL_DEFAULT_MAX_OUTPUT_BYTES,
  HARNESS_EVAL_MAX_ARG_LENGTH,
  HARNESS_EVAL_MAX_ARGV_LENGTH,
  HARNESS_EVAL_MAX_COMMANDS_PER_SCENARIO,
  HARNESS_EVAL_MAX_ID_LENGTH,
  HARNESS_EVAL_MAX_OUTPUT_BYTES,
  HARNESS_EVAL_MAX_PURPOSE_LENGTH,
  HARNESS_EVAL_MAX_REPETITIONS,
  HARNESS_EVAL_MAX_SCENARIOS,
  HARNESS_EVAL_MAX_TIMEOUT_MS,
  HARNESS_EVAL_MIN_TIMEOUT_MS,
  HARNESS_EVAL_RUN_VERSION,
  HARNESS_EVAL_SAFE_ID_PATTERN,
  HARNESS_EVAL_SUITE_VERSION,
  type EvalCommandExecutor,
  type EvalCommandExecutorResult,
  type EvalCommandRequest,
  type EvalCommandResult,
  type EvalComparisonMissingMetric,
  type EvalCostTruth,
  type EvalGitInspector,
  type EvalGitState,
  type EvalMissingMetric,
  type EvalRepetition,
  type EvalRunRef,
  type EvalScenario,
  type EvalScenarioRun,
  type HarnessEvalComparison,
  type HarnessEvalMetrics,
  type HarnessEvalRun,
  type HarnessEvalSuite,
  type HarnessEvalSummary,
  type RunHarnessEvalOptions,
} from "./types.js";

const execFileAsync = promisify(execFile);
const MAX_RUN_ID_LENGTH = 160;
const MAX_LABEL_LENGTH = 64;
const MAX_MISSING_REASON_LENGTH = 300;
const MAX_MISSING_METRICS = 64;
const MAX_ERROR_LENGTH = 400;
const MAX_SIGNAL_LENGTH = 32;
const MAX_LOG_PATH_LENGTH = 4_096;
const RUN_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,159}$/;
const METRIC_PATH_PATTERN = /^[a-zA-Z][a-zA-Z0-9_.-]{0,127}$/;
const NUL = String.fromCharCode(0);
const CONTROL_TEXT_PATTERN = new RegExp(
  "[" +
    String.fromCharCode(0) +
    "-" +
    String.fromCharCode(8) +
    String.fromCharCode(11) +
    String.fromCharCode(12) +
    String.fromCharCode(14) +
    "-" +
    String.fromCharCode(31) +
    String.fromCharCode(127) +
    "]",
);

export class EvalValidationError extends Error {
  readonly code:
    | "malformed-suite"
    | "malformed-run"
    | "malformed-comparison"
    | "invalid-options"
    | "unsafe-path"
    | "invalid-git-state";

  constructor(code: EvalValidationError["code"], message: string) {
    super(message);
    this.name = "EvalValidationError";
    this.code = code;
  }
}

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function fail(code: EvalValidationError["code"], message: string): never {
  throw new EvalValidationError(code, message);
}

function isSafeId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= HARNESS_EVAL_MAX_ID_LENGTH &&
    HARNESS_EVAL_SAFE_ID_PATTERN.test(value)
  );
}

function isSafeRunId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= MAX_RUN_ID_LENGTH &&
    RUN_ID_PATTERN.test(value)
  );
}

function requireSafeId(
  value: unknown,
  field: string,
  code: EvalValidationError["code"] = "malformed-suite",
): string {
  if (!isSafeId(value)) {
    fail(
      code,
      `${field} must be a lower-case safe id (letters, digits, ., _, -)`,
    );
  }
  return value;
}

function requireBoundedText(
  value: unknown,
  field: string,
  maxLength: number,
  code: EvalValidationError["code"] = "malformed-suite",
  options: { allowControls?: boolean } = {},
): string {
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    value.length > maxLength ||
    (!options.allowControls && CONTROL_TEXT_PATTERN.test(value))
  ) {
    fail(code, `${field} must be a bounded non-empty string`);
  }
  return value;
}

function requireNonNegativeInteger(
  value: unknown,
  field: string,
  code: EvalValidationError["code"],
): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    fail(code, `${field} must be a non-negative integer`);
  }
  return value;
}

function requirePositiveBoundedInteger(
  value: unknown,
  field: string,
  min: number,
  max: number,
  code: EvalValidationError["code"],
): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < min ||
    value > max
  ) {
    fail(code, `${field} must be an integer between ${min} and ${max}`);
  }
  return value;
}

function parseExpectedExit(
  value: unknown,
  field: string,
  code: EvalValidationError["code"] = "malformed-suite",
): EvalScenario["expectedExit"] {
  if (
    typeof value !== "string" ||
    !(EVAL_EXPECTED_EXITS as readonly string[]).includes(value)
  ) {
    fail(code, `${field} must be "zero" or "nonzero"`);
  }
  return value as EvalScenario["expectedExit"];
}

function parseStatus(
  value: unknown,
  field: string,
  code: EvalValidationError["code"],
): "passed" | "failed" {
  if (
    typeof value !== "string" ||
    !(EVAL_SCENARIO_STATUSES as readonly string[]).includes(value)
  ) {
    fail(code, `${field} must be "passed" or "failed"`);
  }
  return value as "passed" | "failed";
}

function parseArgv(
  value: unknown,
  field: string,
  code: EvalValidationError["code"],
): string[] {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.length > HARNESS_EVAL_MAX_ARGV_LENGTH
  ) {
    fail(
      code,
      `${field} must be a non-empty argv array with at most ${HARNESS_EVAL_MAX_ARGV_LENGTH} entries`,
    );
  }
  const argv: string[] = [];
  for (const [index, raw] of value.entries()) {
    if (
      typeof raw !== "string" ||
      raw.length === 0 ||
      raw.length > HARNESS_EVAL_MAX_ARG_LENGTH ||
      raw.includes(NUL)
    ) {
      fail(
        code,
        `${field}[${index}] must be a bounded non-empty argument without NUL`,
      );
    }
    argv.push(raw);
  }
  // The executable is one argv token. Whitespace or shell operators there is
  // the signature of a shell string such as "npm test | tee out".
  if (/[\s;&|<>`$()]/.test(argv[0]!)) {
    fail(code, `${field}[0] must be an executable argv token, not shell text`);
  }
  return argv;
}

function parseScenario(
  value: unknown,
  field: string,
  code: EvalValidationError["code"] = "malformed-suite",
): EvalScenario {
  if (!isRecord(value)) fail(code, `${field} must be an object`);
  const id = requireSafeId(value.id, `${field}.id`, code);
  const category = requireSafeId(value.category, `${field}.category`, code);
  const purpose = requireBoundedText(
    value.purpose,
    `${field}.purpose`,
    HARNESS_EVAL_MAX_PURPOSE_LENGTH,
    code,
  );
  if (
    !Array.isArray(value.commands) ||
    value.commands.length === 0 ||
    value.commands.length > HARNESS_EVAL_MAX_COMMANDS_PER_SCENARIO
  ) {
    fail(
      code,
      `${field}.commands must contain between 1 and ${HARNESS_EVAL_MAX_COMMANDS_PER_SCENARIO} argv arrays`,
    );
  }
  const commands = value.commands.map((command, index) =>
    parseArgv(command, `${field}.commands[${index}]`, code),
  );
  const timeoutMsPerCommand = requirePositiveBoundedInteger(
    value.timeoutMsPerCommand,
    `${field}.timeoutMsPerCommand`,
    HARNESS_EVAL_MIN_TIMEOUT_MS,
    HARNESS_EVAL_MAX_TIMEOUT_MS,
    code,
  );
  const expectedExit = parseExpectedExit(
    value.expectedExit,
    `${field}.expectedExit`,
    code,
  );
  return {
    id,
    category,
    purpose,
    commands,
    timeoutMsPerCommand,
    expectedExit,
  };
}

/** Parse and validate a raw suite. Throws `EvalValidationError` on malformed data. */
export function parseHarnessEvalSuite(value: unknown): HarnessEvalSuite {
  if (!isRecord(value)) fail("malformed-suite", "suite must be an object");
  if (value.version !== HARNESS_EVAL_SUITE_VERSION) {
    fail(
      "malformed-suite",
      `suite.version must be ${HARNESS_EVAL_SUITE_VERSION}`,
    );
  }
  const id = requireSafeId(value.id, "suite.id");
  let label: string | undefined;
  if (value.label !== undefined) {
    label = requireBoundedText(value.label, "suite.label", MAX_LABEL_LENGTH);
  }
  if (
    !Array.isArray(value.scenarios) ||
    value.scenarios.length === 0 ||
    value.scenarios.length > HARNESS_EVAL_MAX_SCENARIOS
  ) {
    fail(
      "malformed-suite",
      `suite.scenarios must contain between 1 and ${HARNESS_EVAL_MAX_SCENARIOS} scenarios`,
    );
  }
  const seen = new Set<string>();
  const scenarios = value.scenarios.map((scenario, index) => {
    const parsed = parseScenario(scenario, `suite.scenarios[${index}]`);
    if (seen.has(parsed.id)) {
      fail("malformed-suite", `duplicate scenario id: ${parsed.id}`);
    }
    seen.add(parsed.id);
    return parsed;
  });
  return {
    version: HARNESS_EVAL_SUITE_VERSION,
    id,
    ...(label !== undefined ? { label } : {}),
    scenarios,
  };
}

function parseTimestamp(
  value: unknown,
  field: string,
  code: EvalValidationError["code"],
): string {
  if (typeof value !== "string") {
    fail(code, `${field} must be an ISO timestamp`);
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime()) || date.toISOString() !== value) {
    fail(code, `${field} must be a canonical ISO timestamp`);
  }
  return value;
}

function parseNullableCount(value: unknown, field: string): number | null {
  if (value === null) return null;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    fail("malformed-run", `${field} must be null or a non-negative integer`);
  }
  return value;
}

function parseCostTruth(value: unknown): EvalCostTruth {
  if (!isRecord(value)) fail("malformed-run", "metrics.cost must be an object");
  if (
    typeof value.state !== "string" ||
    !(EVAL_COST_STATES as readonly string[]).includes(value.state)
  ) {
    fail("malformed-run", "metrics.cost.state is invalid");
  }
  if (
    typeof value.source !== "string" ||
    !(EVAL_COST_SOURCES as readonly string[]).includes(value.source)
  ) {
    fail("malformed-run", "metrics.cost.source is invalid");
  }
  if (typeof value.authoritative !== "boolean") {
    fail("malformed-run", "metrics.cost.authoritative must be boolean");
  }
  const amount =
    value.amount === null
      ? null
      : typeof value.amount === "number" &&
          Number.isFinite(value.amount) &&
          value.amount >= 0
        ? value.amount
        : fail(
            "malformed-run",
            "metrics.cost.amount must be null or non-negative",
          );
  const currency =
    value.currency === null
      ? null
      : typeof value.currency === "string" &&
          value.currency.length >= 1 &&
          value.currency.length <= 12 &&
          /^[A-Za-z0-9._-]+$/.test(value.currency)
        ? value.currency
        : fail("malformed-run", "metrics.cost.currency is invalid");
  const state = value.state as EvalCostTruth["state"];
  if (state === "unavailable") {
    if (
      amount !== null ||
      currency !== null ||
      value.authoritative ||
      value.source !== "none"
    ) {
      fail(
        "malformed-run",
        "unavailable cost must have no amount, currency or authoritative source",
      );
    }
  }
  if (state === "usage-only" && (amount !== null || value.authoritative)) {
    fail("malformed-run", "usage-only cost must not claim an amount");
  }
  if (state === "provider-reported") {
    if (
      amount === null ||
      currency === null ||
      !value.authoritative ||
      value.source !== "provider"
    ) {
      fail(
        "malformed-run",
        "provider-reported cost requires amount, currency, provider source and authoritative=true",
      );
    }
  }
  if (state === "cli-estimated") {
    if (amount === null || value.authoritative || value.source !== "cli") {
      fail(
        "malformed-run",
        "cli-estimated cost requires a CLI source, amount and authoritative=false",
      );
    }
  }
  return {
    state,
    source: value.source as EvalCostTruth["source"],
    authoritative: value.authoritative,
    amount,
    currency,
  };
}

function parseMissingMetrics(value: unknown): EvalMissingMetric[] {
  if (!Array.isArray(value) || value.length > MAX_MISSING_METRICS) {
    fail(
      "malformed-run",
      `missing must be an array with at most ${MAX_MISSING_METRICS} entries`,
    );
  }
  const seen = new Set<string>();
  return value.map((raw, index) => {
    if (!isRecord(raw)) {
      fail("malformed-run", `missing[${index}] must be an object`);
    }
    if (
      typeof raw.metric !== "string" ||
      !METRIC_PATH_PATTERN.test(raw.metric)
    ) {
      fail("malformed-run", `missing[${index}].metric is invalid`);
    }
    if (seen.has(raw.metric)) {
      fail("malformed-run", `duplicate missing metric: ${raw.metric}`);
    }
    seen.add(raw.metric);
    const reason = requireBoundedText(
      raw.reason,
      `missing[${index}].reason`,
      MAX_MISSING_REASON_LENGTH,
      "malformed-run",
    );
    return { metric: raw.metric, reason };
  });
}

function parseRate(value: unknown, field: string): number {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < 0 ||
    value > 1
  ) {
    fail("malformed-run", `${field} must be a number between 0 and 1`);
  }
  return value;
}

function parseMetrics(value: unknown): HarnessEvalMetrics {
  if (!isRecord(value)) fail("malformed-run", "metrics must be an object");
  return {
    passRate: parseRate(value.passRate, "metrics.passRate"),
    repetitionPassRate: parseRate(
      value.repetitionPassRate,
      "metrics.repetitionPassRate",
    ),
    wallMs: requireNonNegativeInteger(
      value.wallMs,
      "metrics.wallMs",
      "malformed-run",
    ),
    requests: parseNullableCount(value.requests, "metrics.requests"),
    inputTokens: parseNullableCount(value.inputTokens, "metrics.inputTokens"),
    outputTokens: parseNullableCount(
      value.outputTokens,
      "metrics.outputTokens",
    ),
    cacheHits: parseNullableCount(value.cacheHits, "metrics.cacheHits"),
    cost: parseCostTruth(value.cost),
    humanInterventions: parseNullableCount(
      value.humanInterventions,
      "metrics.humanInterventions",
    ),
  };
}

function parseBoundedOutput(value: unknown, field: string): string {
  if (
    typeof value !== "string" ||
    Buffer.byteLength(value, "utf8") > HARNESS_EVAL_MAX_OUTPUT_BYTES + 16
  ) {
    fail("malformed-run", `${field} must be bounded text`);
  }
  return value;
}

function parseCommandResult(
  value: unknown,
  field: string,
  expectedExit: EvalScenario["expectedExit"],
): EvalCommandResult {
  if (!isRecord(value)) fail("malformed-run", `${field} must be an object`);
  const argv = parseArgv(value.argv, `${field}.argv`, "malformed-run");
  const exitCode =
    value.exitCode === null
      ? null
      : typeof value.exitCode === "number" &&
          Number.isSafeInteger(value.exitCode)
        ? value.exitCode
        : fail(
            "malformed-run",
            `${field}.exitCode must be null or an integer`,
          );
  const signal =
    value.signal === null
      ? null
      : typeof value.signal === "string" &&
          value.signal.length > 0 &&
          value.signal.length <= MAX_SIGNAL_LENGTH
        ? value.signal
        : fail(
            "malformed-run",
            `${field}.signal must be null or bounded text`,
          );
  if (typeof value.timedOut !== "boolean") {
    fail("malformed-run", `${field}.timedOut must be boolean`);
  }
  if (typeof value.matchedExpectation !== "boolean") {
    fail("malformed-run", `${field}.matchedExpectation must be boolean`);
  }
  const durationMs = requireNonNegativeInteger(
    value.durationMs,
    `${field}.durationMs`,
    "malformed-run",
  );
  const stdout = parseBoundedOutput(value.stdout, `${field}.stdout`);
  const stderr = parseBoundedOutput(value.stderr, `${field}.stderr`);
  const stdoutBytes = requireNonNegativeInteger(
    value.stdoutBytes,
    `${field}.stdoutBytes`,
    "malformed-run",
  );
  const stderrBytes = requireNonNegativeInteger(
    value.stderrBytes,
    `${field}.stderrBytes`,
    "malformed-run",
  );
  if (
    stdoutBytes < Buffer.byteLength(stdout, "utf8") ||
    stderrBytes < Buffer.byteLength(stderr, "utf8")
  ) {
    fail("malformed-run", `${field} byte counts disagree with retained output`);
  }
  if (
    typeof value.stdoutTruncated !== "boolean" ||
    typeof value.stderrTruncated !== "boolean" ||
    typeof value.outputTruncated !== "boolean"
  ) {
    fail("malformed-run", `${field} truncation flags must be boolean`);
  }
  if (
    value.outputTruncated !==
    (value.stdoutTruncated || value.stderrTruncated)
  ) {
    fail("malformed-run", `${field}.outputTruncated disagrees with streams`);
  }
  const error =
    value.error === null
      ? null
      : requireBoundedText(
          value.error,
          `${field}.error`,
          MAX_ERROR_LENGTH,
          "malformed-run",
          { allowControls: true },
        );
  if (
    typeof value.logPath !== "string" ||
    value.logPath.length === 0 ||
    value.logPath.length > MAX_LOG_PATH_LENGTH ||
    !isAbsolute(value.logPath) ||
    value.logPath.includes(NUL)
  ) {
    fail("malformed-run", `${field}.logPath must be an absolute bounded path`);
  }
  const matchedExpectation = commandMatched(
    expectedExit,
    value.timedOut,
    exitCode,
    signal,
    error,
  );
  if (matchedExpectation !== value.matchedExpectation) {
    fail(
      "malformed-run",
      `${field}.matchedExpectation disagrees with exit/timeout evidence`,
    );
  }
  return {
    argv,
    exitCode,
    signal,
    timedOut: value.timedOut,
    durationMs,
    matchedExpectation,
    stdout,
    stderr,
    stdoutBytes,
    stderrBytes,
    stdoutTruncated: value.stdoutTruncated,
    stderrTruncated: value.stderrTruncated,
    outputTruncated: value.outputTruncated,
    error,
    logPath: value.logPath,
  };
}

function parseRepetition(
  value: unknown,
  field: string,
  index: number,
  expectedExit: EvalScenario["expectedExit"],
): EvalRepetition {
  if (!isRecord(value)) fail("malformed-run", `${field} must be an object`);
  if (value.index !== index) {
    fail("malformed-run", `${field}.index must be ${index}`);
  }
  const status = parseStatus(value.status, `${field}.status`, "malformed-run");
  const durationMs = requireNonNegativeInteger(
    value.durationMs,
    `${field}.durationMs`,
    "malformed-run",
  );
  if (
    !Array.isArray(value.commands) ||
    value.commands.length === 0 ||
    value.commands.length > HARNESS_EVAL_MAX_COMMANDS_PER_SCENARIO
  ) {
    fail("malformed-run", `${field}.commands must be a non-empty array`);
  }
  const commands = value.commands.map((command, commandIndex) =>
    parseCommandResult(
      command,
      `${field}.commands[${commandIndex}]`,
      expectedExit,
    ),
  );
  const passedCommands = commands.filter(
    (command) => command.matchedExpectation,
  ).length;
  const failedCommands = commands.length - passedCommands;
  if (
    value.passedCommands !== passedCommands ||
    value.failedCommands !== failedCommands
  ) {
    fail("malformed-run", `${field} command counters disagree with commands`);
  }
  const computedStatus = failedCommands === 0 ? "passed" : "failed";
  if (status !== computedStatus) {
    fail("malformed-run", `${field}.status disagrees with commands`);
  }
  return {
    index,
    status,
    durationMs,
    passedCommands,
    failedCommands,
    commands,
  };
}

function parseScenarioRun(
  value: unknown,
  field: string,
  repetitions: number,
): EvalScenarioRun {
  if (!isRecord(value)) fail("malformed-run", `${field} must be an object`);
  const id = requireSafeId(value.id, `${field}.id`, "malformed-run");
  const category = requireSafeId(
    value.category,
    `${field}.category`,
    "malformed-run",
  );
  const purpose = requireBoundedText(
    value.purpose,
    `${field}.purpose`,
    HARNESS_EVAL_MAX_PURPOSE_LENGTH,
    "malformed-run",
  );
  const expectedExit = parseExpectedExit(
    value.expectedExit,
    `${field}.expectedExit`,
    "malformed-run",
  );
  const timeoutMsPerCommand = requirePositiveBoundedInteger(
    value.timeoutMsPerCommand,
    `${field}.timeoutMsPerCommand`,
    HARNESS_EVAL_MIN_TIMEOUT_MS,
    HARNESS_EVAL_MAX_TIMEOUT_MS,
    "malformed-run",
  );
  const status = parseStatus(value.status, `${field}.status`, "malformed-run");
  const durationMs = requireNonNegativeInteger(
    value.durationMs,
    `${field}.durationMs`,
    "malformed-run",
  );
  if (
    !Array.isArray(value.repetitions) ||
    value.repetitions.length !== repetitions
  ) {
    fail(
      "malformed-run",
      `${field}.repetitions must contain ${repetitions} entries`,
    );
  }
  const parsedRepetitions = value.repetitions.map((repetition, index) =>
    parseRepetition(
      repetition,
      `${field}.repetitions[${index}]`,
      index + 1,
      expectedExit,
    ),
  );
  const passedRepetitions = parsedRepetitions.filter(
    (repetition) => repetition.status === "passed",
  ).length;
  const failedRepetitions = parsedRepetitions.length - passedRepetitions;
  if (
    value.passedRepetitions !== passedRepetitions ||
    value.failedRepetitions !== failedRepetitions
  ) {
    fail("malformed-run", `${field} repetition counters disagree`);
  }
  const computedStatus = failedRepetitions === 0 ? "passed" : "failed";
  if (status !== computedStatus) {
    fail("malformed-run", `${field}.status disagrees with repetitions`);
  }
  return {
    id,
    category,
    purpose,
    expectedExit,
    timeoutMsPerCommand,
    status,
    durationMs,
    passedRepetitions,
    failedRepetitions,
    repetitions: parsedRepetitions,
  };
}

function rateMatches(value: unknown, expected: number): boolean {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    Math.abs(value - expected) <= 1e-9
  );
}

function parseSummary(
  value: unknown,
  scenarios: EvalScenarioRun[],
): HarnessEvalSummary {
  if (!isRecord(value)) fail("malformed-run", "summary must be an object");
  const scenarioCount = scenarios.length;
  const passedScenarios = scenarios.filter(
    (scenario) => scenario.status === "passed",
  ).length;
  const failedScenarios = scenarioCount - passedScenarios;
  const repetitionCount = scenarios.reduce(
    (sum, scenario) => sum + scenario.repetitions.length,
    0,
  );
  const passedRepetitions = scenarios.reduce(
    (sum, scenario) => sum + scenario.passedRepetitions,
    0,
  );
  const failedRepetitions = repetitionCount - passedRepetitions;
  const passRate = passedScenarios / scenarioCount;
  const repetitionPassRate = passedRepetitions / repetitionCount;
  for (const [field, expected] of [
    ["scenarioCount", scenarioCount],
    ["passedScenarios", passedScenarios],
    ["failedScenarios", failedScenarios],
    ["repetitionCount", repetitionCount],
    ["passedRepetitions", passedRepetitions],
    ["failedRepetitions", failedRepetitions],
  ] as const) {
    if (value[field] !== expected) {
      fail("malformed-run", `summary.${field} disagrees with scenarios`);
    }
  }
  if (!rateMatches(value.passRate, passRate)) {
    fail("malformed-run", "summary.passRate disagrees with scenarios");
  }
  if (!rateMatches(value.repetitionPassRate, repetitionPassRate)) {
    fail(
      "malformed-run",
      "summary.repetitionPassRate disagrees with scenarios",
    );
  }
  return {
    scenarioCount,
    passedScenarios,
    failedScenarios,
    repetitionCount,
    passedRepetitions,
    failedRepetitions,
    passRate,
    repetitionPassRate,
  };
}

function assertMissingReasons(
  metrics: HarnessEvalMetrics,
  missing: EvalMissingMetric[],
): void {
  const metricsWithReasons = new Set(missing.map((entry) => entry.metric));
  const nullable = [
    ["metrics.requests", metrics.requests],
    ["metrics.inputTokens", metrics.inputTokens],
    ["metrics.outputTokens", metrics.outputTokens],
    ["metrics.cacheHits", metrics.cacheHits],
    ["metrics.humanInterventions", metrics.humanInterventions],
  ] as const;
  for (const [metric, value] of nullable) {
    if (value === null && !metricsWithReasons.has(metric)) {
      fail("malformed-run", `${metric} is null without a missing reason`);
    }
  }
  if (
    metrics.cost.amount === null &&
    !metricsWithReasons.has("metrics.cost.amount")
  ) {
    fail(
      "malformed-run",
      "metrics.cost.amount is unavailable without a reason",
    );
  }
}

/** Parse and validate a persisted run. Malformed baselines fail closed. */
export function parseHarnessEvalRun(value: unknown): HarnessEvalRun {
  if (!isRecord(value)) fail("malformed-run", "run must be an object");
  if (value.version !== HARNESS_EVAL_RUN_VERSION) {
    fail("malformed-run", `run.version must be ${HARNESS_EVAL_RUN_VERSION}`);
  }
  if (!isSafeRunId(value.id)) fail("malformed-run", "run.id is unsafe");
  const id = value.id;
  const suiteId = requireSafeId(value.suiteId, "suiteId", "malformed-run");
  if (value.suiteVersion !== HARNESS_EVAL_SUITE_VERSION) {
    fail(
      "malformed-run",
      `run.suiteVersion must be ${HARNESS_EVAL_SUITE_VERSION}`,
    );
  }
  const label = requireSafeId(value.label, "label", "malformed-run");
  if (
    typeof value.commit !== "string" ||
    !HARNESS_EVAL_COMMIT_PATTERN.test(value.commit)
  ) {
    fail("malformed-run", "run.commit must be an exact lowercase Git commit");
  }
  const commit = value.commit;
  if (value.clean !== true) {
    fail("malformed-run", "run.clean must be true");
  }
  const repetitions = requirePositiveBoundedInteger(
    value.repetitions,
    "repetitions",
    1,
    HARNESS_EVAL_MAX_REPETITIONS,
    "malformed-run",
  );
  const startedAt = parseTimestamp(
    value.startedAt,
    "startedAt",
    "malformed-run",
  );
  const completedAt = parseTimestamp(
    value.completedAt,
    "completedAt",
    "malformed-run",
  );
  if (Date.parse(completedAt) < Date.parse(startedAt)) {
    fail("malformed-run", "completedAt must not precede startedAt");
  }
  const wallMs = requireNonNegativeInteger(
    value.wallMs,
    "wallMs",
    "malformed-run",
  );
  if (value.status !== "completed") {
    fail("malformed-run", "run.status must be completed");
  }
  if (
    !Array.isArray(value.scenarios) ||
    value.scenarios.length === 0 ||
    value.scenarios.length > HARNESS_EVAL_MAX_SCENARIOS
  ) {
    fail("malformed-run", "run.scenarios must be a non-empty bounded array");
  }
  const seen = new Set<string>();
  const scenarios = value.scenarios.map((scenario, index) => {
    const parsed = parseScenarioRun(
      scenario,
      `scenarios[${index}]`,
      repetitions,
    );
    if (seen.has(parsed.id)) {
      fail("malformed-run", `duplicate scenario id: ${parsed.id}`);
    }
    seen.add(parsed.id);
    return parsed;
  });
  const summary = parseSummary(value.summary, scenarios);
  const metrics = parseMetrics(value.metrics);
  if (metrics.wallMs !== wallMs) {
    fail("malformed-run", "metrics.wallMs must equal run.wallMs");
  }
  if (!rateMatches(metrics.passRate, summary.passRate)) {
    fail("malformed-run", "metrics.passRate disagrees with summary");
  }
  if (!rateMatches(metrics.repetitionPassRate, summary.repetitionPassRate)) {
    fail("malformed-run", "metrics.repetitionPassRate disagrees with summary");
  }
  const missing = parseMissingMetrics(value.missing);
  assertMissingReasons(metrics, missing);
  return {
    version: HARNESS_EVAL_RUN_VERSION,
    id,
    suiteId,
    suiteVersion: HARNESS_EVAL_SUITE_VERSION,
    label,
    commit,
    clean: true,
    repetitions,
    startedAt,
    completedAt,
    wallMs,
    status: "completed",
    scenarios,
    summary,
    metrics,
    missing,
  };
}

function commandMatched(
  expectedExit: EvalScenario["expectedExit"],
  timedOut: boolean,
  exitCode: number | null,
  signal: string | null,
  error: string | null = null,
): boolean {
  if (
    timedOut ||
    signal !== null ||
    exitCode === null ||
    exitCode < 0 ||
    error !== null
  ) {
    return false;
  }
  return expectedExit === "zero" ? exitCode === 0 : exitCode !== 0;
}

function validateRepoPath(raw: unknown, field: string): string {
  if (
    typeof raw !== "string" ||
    raw.length === 0 ||
    raw.length > 4_096 ||
    !isAbsolute(raw) ||
    raw.includes(NUL)
  ) {
    fail("unsafe-path", `${field} must be an absolute path`);
  }
  const resolved = resolve(raw);
  if (resolved === parsePath(resolved).root) {
    fail("unsafe-path", `${field} must not be the filesystem root`);
  }
  return resolved;
}

function validateOutputDir(raw: unknown): string {
  const outputDir = validateRepoPath(raw, "outputDir");
  let stats;
  try {
    stats = statSync(outputDir);
  } catch {
    return outputDir;
  }
  if (!stats.isDirectory()) {
    fail("unsafe-path", "outputDir must be a directory");
  }
  return outputDir;
}

function validateCwd(raw: unknown): string {
  const cwd = validateRepoPath(raw, "cwd");
  let stats;
  try {
    stats = statSync(cwd);
  } catch {
    fail("unsafe-path", "cwd must be an existing directory");
  }
  if (!stats.isDirectory()) fail("unsafe-path", "cwd must be a directory");
  return cwd;
}

function validateMaxOutputBytes(value: unknown): number {
  if (value === undefined) return HARNESS_EVAL_DEFAULT_MAX_OUTPUT_BYTES;
  return requirePositiveBoundedInteger(
    value,
    "maxOutputBytes",
    1,
    HARNESS_EVAL_MAX_OUTPUT_BYTES,
    "invalid-options",
  );
}

/** Default Git probe: exact HEAD plus a clean working tree and index. */
export const inspectEvalGitState: EvalGitInspector = async (cwd) => {
  let commit: string;
  let status: string;
  try {
    const head = await execFileAsync("git", ["rev-parse", "--verify", "HEAD"], {
      cwd,
      encoding: "utf8",
      timeout: 30_000,
      maxBuffer: 64 * 1_024,
    });
    commit = String(head.stdout).trim();
    const worktree = await execFileAsync(
      "git",
      ["status", "--porcelain=v1", "--untracked-files=normal"],
      {
        cwd,
        encoding: "utf8",
        timeout: 30_000,
        maxBuffer: 256 * 1_024,
      },
    );
    status = String(worktree.stdout);
  } catch (error) {
    fail(
      "invalid-git-state",
      `could not inspect Git repository: ${boundedError(error)}`,
    );
  }
  if (!HARNESS_EVAL_COMMIT_PATTERN.test(commit)) {
    fail("invalid-git-state", "git rev-parse did not return an exact commit");
  }
  const dirtyPaths = status
    .split(/\r?\n/)
    .filter((line) => line.length > 0)
    .slice(0, 100);
  return {
    commit,
    clean: dirtyPaths.length === 0,
    ...(dirtyPaths.length > 0 ? { dirtyPaths } : {}),
  };
};

function boundedError(error: unknown): string {
  const message =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : "unknown error";
  return message.replace(CONTROL_TEXT_PATTERN, " ").slice(0, MAX_ERROR_LENGTH);
}

function elapsedMs(since: number): number {
  return Math.max(0, Date.now() - since);
}

function truncateUtf8(value: string, maxBytes: number): string {
  const buffer = Buffer.from(value, "utf8");
  if (buffer.length <= maxBytes) return value;
  return buffer
    .subarray(0, maxBytes)
    .toString("utf8")
    .replace(/�$/, "");
}

function writeCommandLog(
  outputDir: string,
  scenarioId: string,
  repetitionIndex: number,
  commandIndex: number,
  details: {
    argv: string[];
    cwd: string;
    timeoutMs: number;
    exitCode: number | null;
    signal: string | null;
    timedOut: boolean;
    durationMs: number;
    stdout: string;
    stderr: string;
    error: string | null;
  },
): string {
  const dir = join(
    outputDir,
    "logs",
    scenarioId,
    `repetition-${repetitionIndex}`,
  );
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const logPath = join(dir, `command-${commandIndex}.log`);
  const lines = [
    `argv=${JSON.stringify(details.argv)}`,
    `cwd=${details.cwd}`,
    `timeoutMs=${details.timeoutMs}`,
    `exitCode=${details.exitCode === null ? "null" : String(details.exitCode)}`,
    `signal=${details.signal ?? "null"}`,
    `timedOut=${String(details.timedOut)}`,
    `durationMs=${String(details.durationMs)}`,
    ...(details.error ? [`error=${details.error}`] : []),
    "--- stdout ---",
    details.stdout,
    "--- stderr ---",
    details.stderr,
    "",
  ];
  writeFileSync(logPath, lines.join("\n"), { encoding: "utf8", mode: 0o600 });
  return logPath;
}

interface TimedExecution {
  result: EvalCommandExecutorResult;
  timedOut: boolean;
  error: string | null;
  durationMs: number;
}

async function executeWithTimeout(
  executor: EvalCommandExecutor,
  request: EvalCommandRequest,
  timeoutMs: number,
): Promise<TimedExecution> {
  const started = Date.now();
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  let coreTimedOut = false;
  const execution = Promise.resolve()
    .then(() => executor({ ...request, signal: controller.signal }))
    .then(
      (result) => ({ kind: "result" as const, result }),
      (error: unknown) => ({ kind: "error" as const, error }),
    );
  const outcome = await Promise.race([
    execution,
    new Promise<{ kind: "timeout" }>((resolveTimeout) => {
      timer = setTimeout(() => {
        coreTimedOut = true;
        controller.abort();
        resolveTimeout({ kind: "timeout" });
      }, timeoutMs);
    }),
  ]);
  if (timer !== undefined) clearTimeout(timer);
  const durationMs = elapsedMs(started);
  if (outcome.kind === "timeout") {
    return {
      result: { timedOut: true },
      timedOut: true,
      error: `command exceeded ${timeoutMs}ms`,
      durationMs,
    };
  }
  if (outcome.kind === "error") {
    return {
      result: {},
      timedOut: false,
      error: boundedError(outcome.error),
      durationMs,
    };
  }
  const executorError = normalizeExecutorError(outcome.result.error);
  return {
    result: outcome.result,
    timedOut: coreTimedOut || outcome.result.timedOut === true,
    error: executorError,
    durationMs,
  };
}

function normalizeExecutorError(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const bounded = boundedError(value);
  return bounded.trim().length === 0
    ? "executor reported an empty error"
    : bounded;
}

interface SanitizedExecution {
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
  stdoutBytes: number;
  stderrBytes: number;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  error: string | null;
}

function sanitizeExecutorResult(
  result: EvalCommandExecutorResult,
  maxOutputBytes: number,
  timedOut: boolean,
  error: string | null,
): SanitizedExecution {
  if (!isRecord(result)) {
    return {
      exitCode: null,
      signal: null,
      timedOut,
      stdout: "",
      stderr: "",
      stdoutBytes: 0,
      stderrBytes: 0,
      stdoutTruncated: false,
      stderrTruncated: false,
      error: error ?? "executor returned a non-object result",
    };
  }
  const exitCode =
    typeof result.exitCode === "number" && Number.isSafeInteger(result.exitCode)
      ? result.exitCode
      : null;
  const signal =
    typeof result.signal === "string" && result.signal.length > 0
      ? result.signal.slice(0, MAX_SIGNAL_LENGTH)
      : null;
  const rawStdout = typeof result.stdout === "string" ? result.stdout : "";
  const rawStderr = typeof result.stderr === "string" ? result.stderr : "";
  const rawStdoutBytes = Buffer.byteLength(rawStdout, "utf8");
  const rawStderrBytes = Buffer.byteLength(rawStderr, "utf8");
  const totalStdout =
    typeof result.stdoutBytes === "number" &&
    Number.isSafeInteger(result.stdoutBytes) &&
    result.stdoutBytes >= rawStdoutBytes
      ? result.stdoutBytes
      : rawStdoutBytes;
  const totalStderr =
    typeof result.stderrBytes === "number" &&
    Number.isSafeInteger(result.stderrBytes) &&
    result.stderrBytes >= rawStderrBytes
      ? result.stderrBytes
      : rawStderrBytes;
  const stdout = truncateUtf8(rawStdout, maxOutputBytes);
  const stderr = truncateUtf8(rawStderr, maxOutputBytes);
  return {
    exitCode,
    signal,
    timedOut: timedOut || result.timedOut === true,
    stdout,
    stderr,
    stdoutBytes: totalStdout,
    stderrBytes: totalStderr,
    stdoutTruncated:
      result.stdoutTruncated === true ||
      rawStdoutBytes > maxOutputBytes ||
      totalStdout > maxOutputBytes,
    stderrTruncated:
      result.stderrTruncated === true ||
      rawStderrBytes > maxOutputBytes ||
      totalStderr > maxOutputBytes,
    error,
  };
}

/**
 * Default executor. It spawns an argv array with `shell: false`, bounds both
 * streams while collecting and escalates SIGTERM to SIGKILL on timeout.
 */
export function createArgvCommandExecutor(): EvalCommandExecutor {
  return (request) =>
    new Promise<EvalCommandExecutorResult>((resolveExecution) => {
      const child = spawn(request.argv[0]!, request.argv.slice(1), {
        cwd: request.cwd,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env },
      });
      let stdout = "";
      let stderr = "";
      let stdoutBytes = 0;
      let stderrBytes = 0;
      let stdoutTruncated = false;
      let stderrTruncated = false;
      let timedOut = false;
      let settled = false;
      let timeoutTimer: NodeJS.Timeout | undefined;
      let killTimer: NodeJS.Timeout | undefined;

      const collect = (chunk: string, stream: "stdout" | "stderr"): void => {
        const byteLength = Buffer.byteLength(chunk, "utf8");
        if (stream === "stdout") {
          stdoutBytes += byteLength;
        } else {
          stderrBytes += byteLength;
        }
        const retained = stream === "stdout" ? stdout : stderr;
        const remaining = request.maxOutputBytes - Buffer.byteLength(retained);
        if (remaining > 0) {
          const bounded = truncateUtf8(chunk, remaining);
          if (stream === "stdout") stdout += bounded;
          else stderr += bounded;
        }
        if (byteLength > Math.max(0, remaining)) {
          if (stream === "stdout") stdoutTruncated = true;
          else stderrTruncated = true;
        }
      };

      const finish = (
        exitCode: number | null,
        signal: NodeJS.Signals | null,
        error?: string,
      ): void => {
        if (settled) return;
        settled = true;
        if (timeoutTimer !== undefined) clearTimeout(timeoutTimer);
        if (killTimer !== undefined) clearTimeout(killTimer);
        const effectiveError =
          error ??
          (timedOut
            ? `command exceeded ${request.timeoutMs}ms`
            : undefined);
        resolveExecution({
          exitCode,
          signal,
          timedOut,
          stdout,
          stderr,
          stdoutBytes,
          stderrBytes,
          stdoutTruncated,
          stderrTruncated,
          ...(effectiveError !== undefined ? { error: effectiveError } : {}),
        });
      };

      const terminate = (): void => {
        if (settled || timedOut) return;
        timedOut = true;
        child.kill("SIGTERM");
        killTimer = setTimeout(() => {
          child.kill("SIGKILL");
        }, 500);
      };

      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => collect(chunk, "stdout"));
      child.stderr.on("data", (chunk: string) => collect(chunk, "stderr"));
      child.on("error", (error) => {
        finish(null, null, boundedError(error));
      });
      child.on("close", (exitCode, signal) => finish(exitCode, signal));
      timeoutTimer = setTimeout(terminate, request.timeoutMs);
      request.signal.addEventListener("abort", terminate, { once: true });
      if (request.signal.aborted) terminate();
    });
}

function defaultMissingMetrics(): EvalMissingMetric[] {
  return [
    {
      metric: "metrics.requests",
      reason:
        "the v0 engine makes no model request; request count was not observed",
    },
    {
      metric: "metrics.inputTokens",
      reason:
        "no provider usage was observed; input token count is unavailable",
    },
    {
      metric: "metrics.outputTokens",
      reason:
        "no provider usage was observed; output token count is unavailable",
    },
    {
      metric: "metrics.cacheHits",
      reason:
        "no provider usage was observed; cache hit count is unavailable",
    },
    {
      metric: "metrics.cost.amount",
      reason:
        "no provider-reported or CLI-estimated cost observation was supplied",
    },
    {
      metric: "metrics.humanInterventions",
      reason: "human interventions are not instrumented in v0",
    },
  ];
}

function emptyMetrics(): HarnessEvalMetrics {
  return {
    passRate: 0,
    repetitionPassRate: 0,
    wallMs: 0,
    requests: null,
    inputTokens: null,
    outputTokens: null,
    cacheHits: null,
    cost: {
      state: "unavailable",
      source: "none",
      authoritative: false,
      amount: null,
      currency: null,
    },
    humanInterventions: null,
  };
}

function validateGitState(
  state: EvalGitState,
  cwd: string,
  expectedCommit: string,
): EvalGitState {
  if (!isRecord(state)) {
    fail("invalid-git-state", "Git inspector returned a malformed state");
  }
  if (
    typeof state.commit !== "string" ||
    !HARNESS_EVAL_COMMIT_PATTERN.test(state.commit)
  ) {
    fail("invalid-git-state", "Git inspector did not return an exact commit");
  }
  if (state.commit !== expectedCommit) {
    fail(
      "invalid-git-state",
      `repository HEAD ${state.commit} does not match the requested starting commit ${expectedCommit}`,
    );
  }
  if (state.clean !== true) {
    const dirty =
      Array.isArray(state.dirtyPaths) && state.dirtyPaths.length > 0
        ? `: ${state.dirtyPaths.slice(0, 10).join(", ")}`
        : "";
    fail(
      "invalid-git-state",
      `repository must be clean before an eval run${dirty} (cwd ${cwd})`,
    );
  }
  return { commit: state.commit, clean: true };
}

function computeSummary(scenarios: EvalScenarioRun[]): HarnessEvalSummary {
  const scenarioCount = scenarios.length;
  const passedScenarios = scenarios.filter(
    (scenario) => scenario.status === "passed",
  ).length;
  const repetitionCount = scenarios.reduce(
    (sum, scenario) => sum + scenario.repetitions.length,
    0,
  );
  const passedRepetitions = scenarios.reduce(
    (sum, scenario) => sum + scenario.passedRepetitions,
    0,
  );
  return {
    scenarioCount,
    passedScenarios,
    failedScenarios: scenarioCount - passedScenarios,
    repetitionCount,
    passedRepetitions,
    failedRepetitions: repetitionCount - passedRepetitions,
    passRate: passedScenarios / scenarioCount,
    repetitionPassRate: passedRepetitions / repetitionCount,
  };
}

/**
 * Execute a suite. The run fails closed before any command when the suite,
 * paths, repetitions, commit binding or Git cleanliness are invalid.
 */
export async function runHarnessEval(
  options: RunHarnessEvalOptions,
): Promise<HarnessEvalRun> {
  if (!isRecord(options)) {
    fail("invalid-options", "run options must be an object");
  }
  const suite = parseHarnessEvalSuite(options.suite);
  const cwd = validateCwd(options.cwd);
  const outputDir = validateOutputDir(options.outputDir);
  const label = requireSafeId(options.label, "label", "invalid-options");
  const repetitions = requirePositiveBoundedInteger(
    options.repetitions,
    "repetitions",
    1,
    HARNESS_EVAL_MAX_REPETITIONS,
    "invalid-options",
  );
  if (
    typeof options.commit !== "string" ||
    !HARNESS_EVAL_COMMIT_PATTERN.test(options.commit)
  ) {
    fail(
      "invalid-options",
      "commit must be an exact lowercase 40- or 64-character Git commit",
    );
  }
  const commit = options.commit;
  const maxOutputBytes = validateMaxOutputBytes(options.maxOutputBytes);
  const executor = options.executor ?? createArgvCommandExecutor();
  if (typeof executor !== "function") {
    fail("invalid-options", "executor must be a function");
  }
  const inspectGit = options.inspectGit ?? inspectEvalGitState;
  if (typeof inspectGit !== "function") {
    fail("invalid-options", "inspectGit must be a function");
  }
  if (options.now !== undefined && typeof options.now !== "function") {
    fail("invalid-options", "now must be a function");
  }
  const clock = options.now ?? (() => new Date());
  const started = clock();
  if (!(started instanceof Date) || Number.isNaN(started.getTime())) {
    fail("invalid-options", "now must return a valid Date");
  }

  let gitState: EvalGitState;
  try {
    gitState = await inspectGit(cwd);
  } catch (error) {
    if (error instanceof EvalValidationError) throw error;
    fail(
      "invalid-git-state",
      `Git inspection failed: ${boundedError(error)}`,
    );
  }
  validateGitState(gitState, cwd, commit);

  mkdirSync(outputDir, { recursive: true, mode: 0o700 });

  const startedMs = Date.now();
  const scenarioRuns: EvalScenarioRun[] = [];
  for (const scenario of suite.scenarios) {
    const scenarioStartedMs = Date.now();
    const repetitionRuns: EvalRepetition[] = [];
    for (
      let repetitionIndex = 1;
      repetitionIndex <= repetitions;
      repetitionIndex += 1
    ) {
      const repetitionStartedMs = Date.now();
      const commandRuns: EvalCommandResult[] = [];
      for (const [commandIndex, argv] of scenario.commands.entries()) {
        const request: EvalCommandRequest = {
          argv: [...argv],
          cwd,
          timeoutMs: scenario.timeoutMsPerCommand,
          maxOutputBytes,
          signal: new AbortController().signal,
        };
        const timed = await executeWithTimeout(
          executor,
          request,
          scenario.timeoutMsPerCommand,
        );
        const sanitized = sanitizeExecutorResult(
          timed.result,
          maxOutputBytes,
          timed.timedOut,
          timed.error,
        );
        const matchedExpectation = commandMatched(
          scenario.expectedExit,
          sanitized.timedOut,
          sanitized.exitCode,
          sanitized.signal,
          sanitized.error,
        );
        const logPath = writeCommandLog(
          outputDir,
          scenario.id,
          repetitionIndex,
          commandIndex + 1,
          {
            argv,
            cwd,
            timeoutMs: scenario.timeoutMsPerCommand,
            exitCode: sanitized.exitCode,
            signal: sanitized.signal,
            timedOut: sanitized.timedOut,
            durationMs: timed.durationMs,
            stdout: sanitized.stdout,
            stderr: sanitized.stderr,
            error: sanitized.error,
          },
        );
        commandRuns.push({
          argv: [...argv],
          exitCode: sanitized.exitCode,
          signal: sanitized.signal,
          timedOut: sanitized.timedOut,
          durationMs: timed.durationMs,
          matchedExpectation,
          stdout: sanitized.stdout,
          stderr: sanitized.stderr,
          stdoutBytes: sanitized.stdoutBytes,
          stderrBytes: sanitized.stderrBytes,
          stdoutTruncated: sanitized.stdoutTruncated,
          stderrTruncated: sanitized.stderrTruncated,
          outputTruncated:
            sanitized.stdoutTruncated || sanitized.stderrTruncated,
          error: sanitized.error,
          logPath,
        });
      }
      const passedCommands = commandRuns.filter(
        (command) => command.matchedExpectation,
      ).length;
      const failedCommands = commandRuns.length - passedCommands;
      repetitionRuns.push({
        index: repetitionIndex,
        status: failedCommands === 0 ? "passed" : "failed",
        durationMs: elapsedMs(repetitionStartedMs),
        passedCommands,
        failedCommands,
        commands: commandRuns,
      });
    }
    const passedRepetitions = repetitionRuns.filter(
      (repetition) => repetition.status === "passed",
    ).length;
    const failedRepetitions = repetitionRuns.length - passedRepetitions;
    scenarioRuns.push({
      id: scenario.id,
      category: scenario.category,
      purpose: scenario.purpose,
      expectedExit: scenario.expectedExit,
      timeoutMsPerCommand: scenario.timeoutMsPerCommand,
      status: failedRepetitions === 0 ? "passed" : "failed",
      durationMs: elapsedMs(scenarioStartedMs),
      passedRepetitions,
      failedRepetitions,
      repetitions: repetitionRuns,
    });
  }

  const wallMs = elapsedMs(startedMs);
  const summary = computeSummary(scenarioRuns);
  const completed = clock();
  if (!(completed instanceof Date) || Number.isNaN(completed.getTime())) {
    fail("invalid-options", "now must return a valid Date");
  }
  const completedAt =
    completed.getTime() >= started.getTime()
      ? completed.toISOString()
      : new Date(started.getTime() + wallMs).toISOString();
  const metrics = emptyMetrics();
  metrics.passRate = summary.passRate;
  metrics.repetitionPassRate = summary.repetitionPassRate;
  metrics.wallMs = wallMs;
  const run: HarnessEvalRun = {
    version: HARNESS_EVAL_RUN_VERSION,
    id: `${suite.id}.${label}.${commit.slice(0, 12)}`,
    suiteId: suite.id,
    suiteVersion: HARNESS_EVAL_SUITE_VERSION,
    label,
    commit,
    clean: true,
    repetitions,
    startedAt: started.toISOString(),
    completedAt,
    wallMs,
    status: "completed",
    scenarios: scenarioRuns,
    summary,
    metrics,
    missing: defaultMissingMetrics(),
  };
  // Parse our own result before returning it so internal shape drift becomes
  // visible as malformed evidence rather than silently persisted.
  return parseHarnessEvalRun(run);
}

function runRef(run: HarnessEvalRun, label: string, commit: string): EvalRunRef {
  return {
    label,
    commit,
    passRate: run.summary.passRate,
    wallMs: run.wallMs,
    passedScenarios: run.summary.passedScenarios,
    failedScenarios: run.summary.failedScenarios,
    scenarioCount: run.summary.scenarioCount,
    repetitionPassRate: run.summary.repetitionPassRate,
  };
}

/**
 * Compare two persisted runs. Suite identity/version, repetition counts and
 * scenario ids must match; commits are intentionally allowed to differ so a
 * real Harness change can be evaluated.
 */
export function compareHarnessEvalRuns(
  baselineValue: unknown,
  candidateValue: unknown,
): HarnessEvalComparison {
  const baseline = parseHarnessEvalRun(baselineValue);
  const candidate = parseHarnessEvalRun(candidateValue);
  if (baseline.suiteId !== candidate.suiteId) {
    fail(
      "malformed-comparison",
      `suite id mismatch: ${baseline.suiteId} != ${candidate.suiteId}`,
    );
  }
  if (baseline.suiteVersion !== candidate.suiteVersion) {
    fail(
      "malformed-comparison",
      `suite version mismatch: ${baseline.suiteVersion} != ${candidate.suiteVersion}`,
    );
  }
  if (baseline.repetitions !== candidate.repetitions) {
    fail(
      "malformed-comparison",
      `repetition count mismatch: ${baseline.repetitions} != ${candidate.repetitions}`,
    );
  }
  const baselineById = new Map(
    baseline.scenarios.map((scenario) => [scenario.id, scenario]),
  );
  const candidateById = new Map(
    candidate.scenarios.map((scenario) => [scenario.id, scenario]),
  );
  const baselineIds = [...baselineById.keys()].sort();
  const candidateIds = [...candidateById.keys()].sort();
  if (
    baselineIds.length !== candidateIds.length ||
    baselineIds.some((id, index) => id !== candidateIds[index])
  ) {
    fail(
      "malformed-comparison",
      "baseline and candidate must contain the same scenario ids",
    );
  }
  const flippedScenarios: string[] = [];
  const becamePassing: string[] = [];
  const becameFailing: string[] = [];
  for (const id of baselineIds) {
    const before = baselineById.get(id)!;
    const after = candidateById.get(id)!;
    if (before.status === after.status) continue;
    flippedScenarios.push(id);
    if (after.status === "passed") becamePassing.push(id);
    else becameFailing.push(id);
  }
  const missingByMetric = new Map<string, EvalComparisonMissingMetric>();
  const noteMissing = (
    metric: string,
    side: "baselineReason" | "candidateReason",
    reason: string,
  ): void => {
    const entry = missingByMetric.get(metric) ?? {
      metric,
      baselineReason: null,
      candidateReason: null,
    };
    entry[side] = reason;
    missingByMetric.set(metric, entry);
  };
  for (const entry of baseline.missing) {
    noteMissing(entry.metric, "baselineReason", entry.reason);
  }
  for (const entry of candidate.missing) {
    noteMissing(entry.metric, "candidateReason", entry.reason);
  }
  const missing = [...missingByMetric.values()].sort((left, right) =>
    left.metric < right.metric ? -1 : left.metric > right.metric ? 1 : 0,
  );
  const sameCommit = baseline.commit === candidate.commit;
  return {
    version: HARNESS_EVAL_COMPARISON_VERSION,
    suiteId: baseline.suiteId,
    suiteVersion: baseline.suiteVersion,
    repetitions: baseline.repetitions,
    interpretation: sameCommit
      ? "same-commit-repeatability"
      : "cross-commit-change",
    baseline: runRef(baseline, baseline.label, baseline.commit),
    candidate: runRef(candidate, candidate.label, candidate.commit),
    passRateDelta: candidate.summary.passRate - baseline.summary.passRate,
    wallMsDelta: candidate.wallMs - baseline.wallMs,
    flippedScenarios,
    becamePassing,
    becameFailing,
    missing,
    note: sameCommit
      ? "Baseline and candidate ran the same commit; any flip measures repeatability, not an improvement."
      : "Baseline and candidate ran different commits; review flipped scenarios and missing metrics before accepting the Harness change.",
  };
}

/** Alias used by callers that prefer the shorter verb. */
export const compareEvalRuns = compareHarnessEvalRuns;

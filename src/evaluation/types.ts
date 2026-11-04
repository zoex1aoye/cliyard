/**
 * Harness Eval v0 types (design/evidence-and-harness-eval-v0.md).
 *
 * The suite is data, never shell text: every command is an argv array. A run
 * binds an exact clean Git starting commit and records bounded observations.
 * Unavailable measurements stay `null`/`unavailable`; they are never zero.
 */

export const HARNESS_EVAL_SUITE_VERSION = 1 as const;
export const HARNESS_EVAL_RUN_VERSION = 1 as const;
export const HARNESS_EVAL_COMPARISON_VERSION = 1 as const;

export const EVAL_EXPECTED_EXITS = ["zero", "nonzero"] as const;
export type EvalExpectedExit = (typeof EVAL_EXPECTED_EXITS)[number];

export const EVAL_SCENARIO_STATUSES = ["passed", "failed"] as const;
export type EvalScenarioStatus = (typeof EVAL_SCENARIO_STATUSES)[number];

export const EVAL_RUN_STATUSES = ["completed"] as const;
export type EvalRunStatus = (typeof EVAL_RUN_STATUSES)[number];

export const EVAL_COST_STATES = [
  "provider-reported",
  "cli-estimated",
  "usage-only",
  "unavailable",
] as const;
export type EvalCostState = (typeof EVAL_COST_STATES)[number];

export const EVAL_COST_SOURCES = ["provider", "cli", "none"] as const;
export type EvalCostSource = (typeof EVAL_COST_SOURCES)[number];

/** Shared bounds. Parsing fails closed outside these values. */
export const HARNESS_EVAL_MAX_REPETITIONS = 50;
export const HARNESS_EVAL_MIN_TIMEOUT_MS = 1;
export const HARNESS_EVAL_MAX_TIMEOUT_MS = 600_000;
export const HARNESS_EVAL_MAX_SCENARIOS = 64;
export const HARNESS_EVAL_MAX_COMMANDS_PER_SCENARIO = 32;
export const HARNESS_EVAL_MAX_ARGV_LENGTH = 128;
export const HARNESS_EVAL_MAX_ARG_LENGTH = 4_096;
export const HARNESS_EVAL_MAX_ID_LENGTH = 64;
export const HARNESS_EVAL_MAX_PURPOSE_LENGTH = 500;
export const HARNESS_EVAL_DEFAULT_MAX_OUTPUT_BYTES = 8 * 1_024;
export const HARNESS_EVAL_MAX_OUTPUT_BYTES = 64 * 1_024;
export const HARNESS_EVAL_MAX_MARKDOWN_BYTES = 32 * 1_024;

/** Safe single path segment / report identifier. */
export const HARNESS_EVAL_SAFE_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;
export const HARNESS_EVAL_COMMIT_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

/** One deterministic suite scenario. Commands are argv arrays, never shell. */
export interface EvalScenario {
  id: string;
  category: string;
  purpose: string;
  commands: string[][];
  timeoutMsPerCommand: number;
  expectedExit: EvalExpectedExit;
}

export interface HarnessEvalSuite {
  version: typeof HARNESS_EVAL_SUITE_VERSION;
  id: string;
  label?: string;
  scenarios: EvalScenario[];
}

/** A request handed to the injected executor. `cwd` is fixed by the runner. */
export interface EvalCommandRequest {
  argv: string[];
  cwd: string;
  timeoutMs: number;
  maxOutputBytes: number;
  signal: AbortSignal;
}

/**
 * Executor result. A caller-injected executor may omit optional fields; the
 * core records timeouts, exit codes and output itself. Output is re-bounded by
 * the core even when an executor returns more than requested.
 */
export interface EvalCommandExecutorResult {
  exitCode?: number | null;
  signal?: string | null;
  timedOut?: boolean;
  stdout?: string;
  stderr?: string;
  /** Total bytes observed when an executor retained only a prefix. */
  stdoutBytes?: number;
  stderrBytes?: number;
  stdoutTruncated?: boolean;
  stderrTruncated?: boolean;
  error?: string;
}

export type EvalCommandExecutor = (
  request: EvalCommandRequest,
) => Promise<EvalCommandExecutorResult> | EvalCommandExecutorResult;

export interface EvalCommandResult {
  argv: string[];
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  durationMs: number;
  matchedExpectation: boolean;
  stdout: string;
  stderr: string;
  stdoutBytes: number;
  stderrBytes: number;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  outputTruncated: boolean;
  error: string | null;
  logPath: string;
}

export interface EvalRepetition {
  /** 1-based repetition index. */
  index: number;
  status: EvalScenarioStatus;
  durationMs: number;
  passedCommands: number;
  failedCommands: number;
  commands: EvalCommandResult[];
}

export interface EvalScenarioRun {
  id: string;
  category: string;
  purpose: string;
  expectedExit: EvalExpectedExit;
  timeoutMsPerCommand: number;
  status: EvalScenarioStatus;
  durationMs: number;
  passedRepetitions: number;
  failedRepetitions: number;
  repetitions: EvalRepetition[];
}

export interface EvalMissingMetric {
  metric: string;
  reason: string;
}

export interface EvalCostTruth {
  state: EvalCostState;
  source: EvalCostSource;
  authoritative: boolean;
  amount: number | null;
  currency: string | null;
}

export interface HarnessEvalMetrics {
  passRate: number;
  repetitionPassRate: number;
  wallMs: number;
  requests: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  cacheHits: number | null;
  cost: EvalCostTruth;
  humanInterventions: number | null;
}

export interface HarnessEvalSummary {
  scenarioCount: number;
  passedScenarios: number;
  failedScenarios: number;
  repetitionCount: number;
  passedRepetitions: number;
  failedRepetitions: number;
  passRate: number;
  repetitionPassRate: number;
}

export interface HarnessEvalRun {
  version: typeof HARNESS_EVAL_RUN_VERSION;
  id: string;
  suiteId: string;
  suiteVersion: typeof HARNESS_EVAL_SUITE_VERSION;
  label: string;
  /** Exact starting commit supplied by the caller and verified against Git. */
  commit: string;
  /** The repository was clean before any scenario ran. */
  clean: true;
  repetitions: number;
  startedAt: string;
  completedAt: string;
  wallMs: number;
  status: EvalRunStatus;
  scenarios: EvalScenarioRun[];
  summary: HarnessEvalSummary;
  metrics: HarnessEvalMetrics;
  missing: EvalMissingMetric[];
}

export interface EvalRunRef {
  label: string;
  commit: string;
  passRate: number;
  wallMs: number;
  passedScenarios: number;
  failedScenarios: number;
  scenarioCount: number;
  repetitionPassRate: number;
}

export interface EvalComparisonMissingMetric {
  metric: string;
  baselineReason: string | null;
  candidateReason: string | null;
}

export type EvalComparisonInterpretation =
  | "same-commit-repeatability"
  | "cross-commit-change";

export interface HarnessEvalComparison {
  version: typeof HARNESS_EVAL_COMPARISON_VERSION;
  suiteId: string;
  suiteVersion: typeof HARNESS_EVAL_SUITE_VERSION;
  repetitions: number;
  interpretation: EvalComparisonInterpretation;
  baseline: EvalRunRef;
  candidate: EvalRunRef;
  passRateDelta: number;
  wallMsDelta: number;
  /** Scenario ids whose pass/fail status differs between the two runs. */
  flippedScenarios: string[];
  becamePassing: string[];
  becameFailing: string[];
  missing: EvalComparisonMissingMetric[];
  note: string;
}

export interface EvalGitState {
  commit: string;
  clean: boolean;
  dirtyPaths?: string[];
}

export type EvalGitInspector = (cwd: string) => Promise<EvalGitState>;

export interface RunHarnessEvalOptions {
  /** Raw suite data; parsed and validated before any command runs. */
  suite: unknown;
  /** Repository working directory, fixed for every command. */
  cwd: string;
  /** Exact expected HEAD. A mismatch or dirty tree fails the run closed. */
  commit: string;
  label: string;
  repetitions: number;
  /** Caller-owned directory; all logs and reports stay below this path. */
  outputDir: string;
  /** Injected command executor. Defaults to an argv-only child-process runner. */
  executor?: EvalCommandExecutor;
  /** Injected Git probe; defaults to `git rev-parse` plus `git status`. */
  inspectGit?: EvalGitInspector;
  /** Per-stream retained byte bound. Defaults to 8 KiB. */
  maxOutputBytes?: number;
  /** Injectable clock for deterministic tests and report timestamps. */
  now?: () => Date;
}

export interface HarnessEvalReportPaths {
  jsonPath: string;
  markdownPath: string;
}

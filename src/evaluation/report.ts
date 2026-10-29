/**
 * Deterministic Harness Eval report rendering.
 *
 * JSON is canonicalized through the run parser so persisted evidence has a
 * stable shape. Markdown is human-readable but strictly bounded; command
 * output is reduced to one short inline snippet rather than copied wholesale.
 * Writers only create files below the caller-owned output directory.
 */
import { randomUUID } from "node:crypto";
import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, parse, resolve } from "node:path";
import {
  HARNESS_EVAL_COMMIT_PATTERN,
  HARNESS_EVAL_COMPARISON_VERSION,
  HARNESS_EVAL_MAX_MARKDOWN_BYTES,
  HARNESS_EVAL_MAX_REPETITIONS,
  HARNESS_EVAL_SAFE_ID_PATTERN,
  HARNESS_EVAL_SUITE_VERSION,
  type EvalCostTruth,
  type EvalMissingMetric,
  type EvalRunRef,
  type HarnessEvalComparison,
  type HarnessEvalReportPaths,
  type HarnessEvalRun,
} from "./types.js";
import { EvalValidationError, parseHarnessEvalRun } from "./core.js";

const MAX_INLINE_CHARS = 180;
const MAX_SNIPPET_CHARS = 240;
const MAX_REPORT_ID_CHARS = 120;
const MAX_MISSING_REASON_CHARS = 300;
const SAFE_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const METRIC_PATH_PATTERN = /^[a-zA-Z][a-zA-Z0-9_.-]{0,127}$/;
const CONTROL_TEXT_PATTERN = new RegExp(
  "[" +
    String.fromCharCode(0) +
    "-" +
    String.fromCharCode(31) +
    String.fromCharCode(127) +
    "]",
  "g",
);

function fail(message: string): never {
  throw new EvalValidationError("invalid-options", message);
}

function requireOutputDir(raw: unknown): string {
  if (
    typeof raw !== "string" ||
    raw.length === 0 ||
    !isAbsolute(raw) ||
    raw.includes(String.fromCharCode(0))
  ) {
    fail("outputDir must be an absolute path");
  }
  const outputDir = resolve(raw);
  if (outputDir === parse(outputDir).root) {
    fail("outputDir must not be the filesystem root");
  }
  let stats;
  try {
    stats = statSync(outputDir);
  } catch {
    stats = undefined;
  }
  if (stats !== undefined && !stats.isDirectory()) {
    fail("outputDir must be a directory");
  }
  return outputDir;
}

function canonicalRun(value: unknown): HarnessEvalRun {
  return parseHarnessEvalRun(value);
}

function isFiniteUnitRate(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isRunRef(value: unknown): value is EvalRunRef {
  if (typeof value !== "object" || value === null) return false;
  const ref = value as Partial<EvalRunRef>;
  if (
    typeof ref.label !== "string" ||
    !SAFE_ID_PATTERN.test(ref.label) ||
    typeof ref.commit !== "string" ||
    !HARNESS_EVAL_COMMIT_PATTERN.test(ref.commit) ||
    !isFiniteUnitRate(ref.passRate) ||
    !isFiniteUnitRate(ref.repetitionPassRate) ||
    !isCount(ref.wallMs) ||
    !isCount(ref.passedScenarios) ||
    !isCount(ref.failedScenarios) ||
    !isCount(ref.scenarioCount) ||
    ref.scenarioCount < 1 ||
    ref.passedScenarios + ref.failedScenarios !== ref.scenarioCount
  ) {
    return false;
  }
  return true;
}

function isSafeId(value: unknown): value is string {
  return typeof value === "string" && SAFE_ID_PATTERN.test(value);
}

function isSafeIdArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => isSafeId(entry));
}

function isSortedUnique(ids: string[]): boolean {
  const seen = new Set<string>();
  for (const [index, id] of ids.entries()) {
    if (seen.has(id)) return false;
    if (index > 0 && ids[index - 1]! >= id) return false;
    seen.add(id);
  }
  return true;
}

function canonicalRunRef(ref: EvalRunRef): EvalRunRef {
  return {
    label: ref.label,
    commit: ref.commit,
    passRate: ref.passRate,
    wallMs: ref.wallMs,
    passedScenarios: ref.passedScenarios,
    failedScenarios: ref.failedScenarios,
    scenarioCount: ref.scenarioCount,
    repetitionPassRate: ref.repetitionPassRate,
  };
}

function canonicalComparison(value: unknown): HarnessEvalComparison {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail("comparison must be an object");
  }
  const raw = value as Partial<HarnessEvalComparison>;
  if (raw.version !== HARNESS_EVAL_COMPARISON_VERSION) {
    fail(`comparison.version must be ${HARNESS_EVAL_COMPARISON_VERSION}`);
  }
  for (const field of ["suiteId", "interpretation", "note"] as const) {
    if (typeof raw[field] !== "string" || raw[field]!.trim().length === 0) {
      fail(`comparison.${field} must be a non-empty string`);
    }
  }
  const suiteId = raw.suiteId as string;
  const suiteVersion = raw.suiteVersion;
  const repetitions = raw.repetitions;
  const interpretation = raw.interpretation as HarnessEvalComparison["interpretation"];
  const note = raw.note as string;
  if (
    typeof suiteId !== "string" ||
    !HARNESS_EVAL_SAFE_ID_PATTERN.test(suiteId) ||
    raw.suiteVersion !== HARNESS_EVAL_SUITE_VERSION ||
    typeof repetitions !== "number" ||
    !Number.isSafeInteger(repetitions) ||
    repetitions < 1 ||
    repetitions > HARNESS_EVAL_MAX_REPETITIONS ||
    (interpretation !== "same-commit-repeatability" &&
      interpretation !== "cross-commit-change") ||
    !isSafeIdArray(raw.flippedScenarios) ||
    !isSortedUnique(raw.flippedScenarios) ||
    !isSafeIdArray(raw.becamePassing) ||
    !isSortedUnique(raw.becamePassing) ||
    !isSafeIdArray(raw.becameFailing) ||
    !isSortedUnique(raw.becameFailing) ||
    !Array.isArray(raw.missing) ||
    typeof raw.passRateDelta !== "number" ||
    !Number.isFinite(raw.passRateDelta) ||
    raw.passRateDelta < -1 ||
    raw.passRateDelta > 1 ||
    typeof raw.wallMsDelta !== "number" ||
    !Number.isFinite(raw.wallMsDelta) ||
    !isRunRef(raw.baseline) ||
    !isRunRef(raw.candidate)
  ) {
    fail("comparison is malformed");
  }
  const flipped = new Set(raw.flippedScenarios);
  const becamePassing = new Set(raw.becamePassing);
  const becameFailing = new Set(raw.becameFailing);
  if (
    becamePassing.size + becameFailing.size !== flipped.size ||
    [...becamePassing].some((id) => !flipped.has(id) || becameFailing.has(id)) ||
    [...becameFailing].some((id) => !flipped.has(id))
  ) {
    fail("comparison flip lists disagree with flippedScenarios");
  }
  const missingMetrics = new Set<string>();
  const missing = raw.missing.map((entry, index) => {
    if (
      typeof entry !== "object" ||
      entry === null ||
      typeof entry.metric !== "string" ||
      !METRIC_PATH_PATTERN.test(entry.metric) ||
      missingMetrics.has(entry.metric) ||
      (entry.baselineReason !== null &&
        !validMissingReason(entry.baselineReason)) ||
      (entry.candidateReason !== null &&
        !validMissingReason(entry.candidateReason)) ||
      (entry.baselineReason === null && entry.candidateReason === null)
    ) {
      fail(`comparison.missing[${index}] is malformed`);
    }
    missingMetrics.add(entry.metric);
    return {
      metric: entry.metric,
      baselineReason: entry.baselineReason,
      candidateReason: entry.candidateReason,
    };
  });
  return {
    version: HARNESS_EVAL_COMPARISON_VERSION,
    suiteId,
    suiteVersion: HARNESS_EVAL_SUITE_VERSION,
    repetitions,
    interpretation,
    baseline: canonicalRunRef(raw.baseline),
    candidate: canonicalRunRef(raw.candidate),
    passRateDelta: raw.passRateDelta,
    wallMsDelta: raw.wallMsDelta,
    flippedScenarios: [...raw.flippedScenarios],
    becamePassing: [...raw.becamePassing],
    becameFailing: [...raw.becameFailing],
    missing: missing.sort((left, right) =>
      left.metric < right.metric ? -1 : left.metric > right.metric ? 1 : 0,
    ),
    note,
  };
}

function validMissingReason(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    value.length <= MAX_MISSING_REASON_CHARS
  );
}

/** Stable, newline-terminated JSON for one run. */
export function serializeHarnessEvalRunJson(value: unknown): string {
  return `${JSON.stringify(canonicalRun(value), null, 2)}\n`;
}

/** Stable, newline-terminated JSON for a baseline/candidate comparison. */
export function serializeHarnessEvalComparisonJson(value: unknown): string {
  return `${JSON.stringify(canonicalComparison(value), null, 2)}\n`;
}

export const serializeEvalRunJson = serializeHarnessEvalRunJson;
export const serializeEvalComparisonJson = serializeHarnessEvalComparisonJson;

function percent(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function inlineText(value: unknown, maxChars = MAX_INLINE_CHARS): string {
  const text = typeof value === "string" ? value : String(value);
  const sanitized = text
    .replace(CONTROL_TEXT_PATTERN, " ")
    .replace(/\|/g, "\\|")
    .replace(/\s+/g, " ")
    .trim();
  return sanitized.length > maxChars
    ? `${sanitized.slice(0, maxChars)}...`
    : sanitized;
}

function codeText(value: unknown, maxChars = MAX_SNIPPET_CHARS): string {
  return inlineText(value, maxChars).replace(/`/g, "'");
}

function formatCost(cost: EvalCostTruth): string {
  if (cost.state === "unavailable") return "unavailable (no cost observation)";
  if (cost.amount === null) return `${cost.state} (amount unavailable)`;
  return `${cost.state}: ${cost.amount} ${cost.currency ?? ""}`.trim();
}

function metricLine(
  label: string,
  value: number | null,
  missing: EvalMissingMetric[],
  metric: string,
): string {
  if (value !== null) return `| ${label} | ${value} |`;
  const reason = missing.find((entry) => entry.metric === metric)?.reason;
  return `| ${label} | unavailable${reason ? ` - ${inlineText(reason)}` : ""} |`;
}

function outcomeCounts(
  run: HarnessEvalRun,
): { passed: number; failed: number; flaky: number } {
  return {
    passed: run.scenarios.filter((scenario) => scenario.status === "passed")
      .length,
    failed: run.scenarios.filter((scenario) => scenario.status === "failed")
      .length,
    flaky: run.scenarios.filter(
      (scenario) =>
        scenario.passedRepetitions > 0 && scenario.failedRepetitions > 0,
    ).length,
  };
}

function markdownHeader(run: HarnessEvalRun): string[] {
  return [
    `# Harness Eval: ${run.label}`,
    "",
    "Deterministic local Harness evaluation. This report makes no claim about",
    "paid model quality or provider-level context compaction.",
    "",
    `- Run: \`${run.id}\``,
    `- Suite: \`${run.suiteId}\` v${run.suiteVersion}`,
    `- Commit: \`${run.commit}\` (clean before run)`,
    `- Repetitions: ${run.repetitions}`,
    `- Started: ${run.startedAt}`,
    `- Completed: ${run.completedAt}`,
    `- Wall time: ${run.wallMs} ms`,
    `- Status: ${run.status}`,
    "",
  ];
}

function markdownSummary(run: HarnessEvalRun): string[] {
  const counts = outcomeCounts(run);
  return [
    "## Summary",
    "",
    `Scenarios: **${run.summary.passedScenarios}/${run.summary.scenarioCount} passed** (${percent(run.summary.passRate)}).`,
    `Repetitions: ${run.summary.passedRepetitions}/${run.summary.repetitionCount} passed (${percent(run.summary.repetitionPassRate)}).`,
    `Failed scenarios: ${counts.failed}; scenarios with mixed repetition outcomes: ${counts.flaky}.`,
    "",
  ];
}

function markdownMetrics(run: HarnessEvalRun): string[] {
  return [
    "## Observations",
    "",
    "| Metric | Value |",
    "| --- | --- |",
    metricLine(
      "Model requests",
      run.metrics.requests,
      run.missing,
      "metrics.requests",
    ),
    metricLine(
      "Input tokens",
      run.metrics.inputTokens,
      run.missing,
      "metrics.inputTokens",
    ),
    metricLine(
      "Output tokens",
      run.metrics.outputTokens,
      run.missing,
      "metrics.outputTokens",
    ),
    metricLine(
      "Cache hits",
      run.metrics.cacheHits,
      run.missing,
      "metrics.cacheHits",
    ),
    `| Cost | ${inlineText(formatCost(run.metrics.cost))} |`,
    metricLine(
      "Human interventions",
      run.metrics.humanInterventions,
      run.missing,
      "metrics.humanInterventions",
    ),
    "",
    "### Missing observations",
    "",
    ...(run.missing.length === 0
      ? ["None."]
      : run.missing.map(
          (entry) => `- \`${entry.metric}\`: ${inlineText(entry.reason)}`,
        )),
    "",
  ];
}

function markdownScenarios(run: HarnessEvalRun): string[] {
  const lines = [
    "## Scenarios",
    "",
    "| Scenario | Category | Status | Expected | Repetitions | Duration |",
    "| --- | --- | --- | --- | ---: | ---: |",
  ];
  for (const scenario of run.scenarios) {
    lines.push(
      `| \`${scenario.id}\` | ${scenario.category} | ${scenario.status} | ${scenario.expectedExit} | ${scenario.passedRepetitions}/${scenario.repetitions.length} | ${scenario.durationMs} ms |`,
    );
  }
  lines.push("");
  const failed = run.scenarios.filter(
    (scenario) => scenario.status === "failed",
  );
  if (failed.length > 0) {
    lines.push("### Failed repetition detail", "");
    for (const scenario of failed) {
      for (const repetition of scenario.repetitions) {
        if (repetition.status === "passed") continue;
        lines.push(
          `- \`${scenario.id}\` repetition ${repetition.index}: ${repetition.failedCommands}/${repetition.commands.length} command(s) missed the ${scenario.expectedExit} expectation.`,
        );
        for (const command of repetition.commands) {
          if (command.matchedExpectation) continue;
          const evidence = [
            command.timedOut ? "timed out" : null,
            command.exitCode === null
              ? "no exit code"
              : `exit ${command.exitCode}`,
            command.signal ? `signal ${command.signal}` : null,
            command.error ? `error: ${codeText(command.error)}` : null,
          ]
            .filter(Boolean)
            .join("; ");
          lines.push(
            `  - \`${codeText(command.argv.join(" "))}\`: ${inlineText(evidence)}`,
          );
          const snippet = command.stderr.trim() || command.stdout.trim();
          if (snippet) {
            lines.push(`    - output: \`${codeText(snippet)}\``);
          }
        }
      }
    }
    lines.push("");
  }
  return lines;
}

function boundMarkdown(markdown: string, maxBytes: number): string {
  if (Buffer.byteLength(markdown, "utf8") <= maxBytes) return markdown;
  const suffix = "\n\n_[truncated at report bound]_\n";
  const allowance = Math.max(0, maxBytes - Buffer.byteLength(suffix, "utf8"));
  let body = Buffer.from(markdown, "utf8")
    .subarray(0, allowance)
    .toString("utf8");
  while (Buffer.byteLength(body, "utf8") > allowance) {
    body = body.slice(0, -1);
  }
  body = body.replace(/�+$/, "");
  return `${body}${suffix}`;
}

function boundBytesOption(value: unknown): number {
  if (value === undefined) return HARNESS_EVAL_MAX_MARKDOWN_BYTES;
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 512 ||
    value > HARNESS_EVAL_MAX_MARKDOWN_BYTES
  ) {
    fail(
      `maxMarkdownBytes must be an integer between 512 and ${HARNESS_EVAL_MAX_MARKDOWN_BYTES}`,
    );
  }
  return value;
}

/** Render one bounded Markdown report. */
export function renderHarnessEvalRunMarkdown(
  value: unknown,
  maxMarkdownBytes?: number,
): string {
  const maxBytes = boundBytesOption(maxMarkdownBytes);
  const run = canonicalRun(value);
  const lines = [
    ...markdownHeader(run),
    ...markdownSummary(run),
    ...markdownMetrics(run),
    ...markdownScenarios(run),
  ];
  return boundMarkdown(`${lines.join("\n")}\n`, maxBytes);
}

export const renderEvalRunMarkdown = renderHarnessEvalRunMarkdown;

function refRow(ref: EvalRunRef): string {
  return `| \`${ref.commit}\` | ${ref.passedScenarios}/${ref.scenarioCount} (${percent(ref.passRate)}) | ${percent(ref.repetitionPassRate)} | ${ref.wallMs} ms |`;
}

/** Render one bounded baseline/candidate comparison report. */
export function renderHarnessEvalComparisonMarkdown(
  value: unknown,
  maxMarkdownBytes?: number,
): string {
  const maxBytes = boundBytesOption(maxMarkdownBytes);
  const comparison = canonicalComparison(value);
  const flips =
    comparison.flippedScenarios.length === 0
      ? ["No scenario status changed."]
      : comparison.flippedScenarios.map((id) => {
          if (comparison.becamePassing.includes(id)) {
            return `- \`${id}\`: failed -> passed`;
          }
          return `- \`${id}\`: passed -> failed`;
        });
  const missing =
    comparison.missing.length === 0
      ? ["None."]
      : comparison.missing.map((entry) => {
          const sides = [
            entry.baselineReason
              ? `baseline: ${inlineText(entry.baselineReason)}`
              : null,
            entry.candidateReason
              ? `candidate: ${inlineText(entry.candidateReason)}`
              : null,
          ]
            .filter(Boolean)
            .join("; ");
          return `- \`${entry.metric}\`: ${sides || "unavailable"}`;
        });
  const lines = [
    "# Harness Eval Comparison",
    "",
    `- Suite: \`${comparison.suiteId}\` v${comparison.suiteVersion}`,
    `- Repetitions: ${comparison.repetitions}`,
    `- Interpretation: ${comparison.interpretation}`,
    "",
    "| Run | Commit | Scenarios | Repetition pass rate | Wall time |",
    "| --- | --- | --- | ---: | ---: |",
    `| Baseline (${inlineText(comparison.baseline.label, MAX_REPORT_ID_CHARS)}) ${refRow(comparison.baseline)}`,
    `| Candidate (${inlineText(comparison.candidate.label, MAX_REPORT_ID_CHARS)}) ${refRow(comparison.candidate)}`,
    "",
    `Pass-rate delta: ${percent(comparison.passRateDelta)}. Wall-time delta: ${comparison.wallMsDelta} ms.`,
    "",
    "## Flipped scenarios",
    "",
    ...flips,
    "",
    "## Missing observations",
    "",
    ...missing,
    "",
    `> ${inlineText(comparison.note, 500)}`,
    "",
  ];
  return boundMarkdown(`${lines.join("\n")}\n`, maxBytes);
}

export const renderEvalComparisonMarkdown =
  renderHarnessEvalComparisonMarkdown;

function writeAtomic(path: string, content: string): void {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = join(
    dir,
    `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`,
  );
  try {
    const fd = openSync(tmp, "wx", 0o600);
    try {
      writeFileSync(fd, content, "utf8");
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, path);
  } catch (error) {
    try {
      unlinkSync(tmp);
    } catch {
      /* best-effort cleanup */
    }
    throw error;
  }
}

/** Write run.json and run.md below the caller-owned output directory. */
export function writeHarnessEvalRunReport(
  value: unknown,
  outputDir: string,
): HarnessEvalReportPaths {
  const run = canonicalRun(value);
  const dir = requireOutputDir(outputDir);
  const jsonPath = join(dir, "run.json");
  const markdownPath = join(dir, "run.md");
  writeAtomic(jsonPath, serializeHarnessEvalRunJson(run));
  writeAtomic(markdownPath, renderHarnessEvalRunMarkdown(run));
  return { jsonPath, markdownPath };
}

/** Write comparison.json and comparison.md below the output directory. */
export function writeHarnessEvalComparisonReport(
  value: unknown,
  outputDir: string,
): HarnessEvalReportPaths {
  const comparison = canonicalComparison(value);
  const dir = requireOutputDir(outputDir);
  const jsonPath = join(dir, "comparison.json");
  const markdownPath = join(dir, "comparison.md");
  writeAtomic(jsonPath, serializeHarnessEvalComparisonJson(comparison));
  writeAtomic(markdownPath, renderHarnessEvalComparisonMarkdown(comparison));
  return { jsonPath, markdownPath };
}

export const writeEvalRunReport = writeHarnessEvalRunReport;
export const writeEvalComparisonReport = writeHarnessEvalComparisonReport;

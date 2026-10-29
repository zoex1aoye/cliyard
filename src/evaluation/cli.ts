/**
 * `cliyard eval` CLI.
 *
 *   cliyard eval run --suite <path> --label <id> --repetitions <n> \
 *                   --out <dir> [--cwd <repo>] [--commit <sha>] [--json]
 *   cliyard eval compare --baseline <run.json> --candidate <run.json> \
 *                        --out <dir|file.json> [--json]
 *   cliyard eval handoff <fixture.json> [--json]
 *
 * Commands are argv arrays executed without a shell against a fixed cwd. The
 * run binds one exact clean Git commit; malformed suites, runs, ids and paths
 * fail closed before a scenario or Git probe runs. Reports stay below the
 * caller-owned output path. No provider call is made.
 */
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import {
  basename,
  dirname,
  extname,
  join,
  parse as parsePath,
  resolve,
} from "node:path";
import { promisify } from "node:util";
import {
  EvalValidationError,
  compareHarnessEvalRuns,
  inspectEvalGitState,
  runHarnessEval,
} from "./core.js";
import { runHandoffCli } from "./handoff.js";
import {
  renderHarnessEvalComparisonMarkdown,
  serializeHarnessEvalComparisonJson,
  serializeHarnessEvalRunJson,
  writeHarnessEvalComparisonReport,
  writeHarnessEvalRunReport,
} from "./report.js";
import { loadHarnessEvalSuiteFile } from "./scenarios.js";
import {
  HARNESS_EVAL_COMMIT_PATTERN,
  HARNESS_EVAL_MAX_OUTPUT_BYTES,
  HARNESS_EVAL_MAX_REPETITIONS,
  type EvalCommandExecutor,
  type EvalGitInspector,
  type EvalGitState,
  type HarnessEvalComparison,
  type HarnessEvalRun,
} from "./types.js";

const execFileAsync = promisify(execFile);
const MAX_CLI_PATH_LENGTH = 4_096;
const MAX_RUN_FILE_BYTES = 64 * 1024 * 1024;
const MAX_ERROR_LENGTH = 500;

export interface EvaluationCliOptions {
  log?: (line: string) => void;
  logError?: (line: string) => void;
  /** Base for resolving relative CLI paths; defaults to process.cwd(). */
  cwd?: string;
  /** Injectable clock, executor and Git probes for tests. */
  now?: () => Date;
  executor?: EvalCommandExecutor;
  inspectGit?: EvalGitInspector;
  resolveCommit?: (cwd: string) => Promise<string>;
}

class EvalCliUsageError extends Error {}

function usage(log: (line: string) => void): void {
  log(`cliyard eval — deterministic local Harness evaluation

Usage:
  cliyard eval run --suite <suite.json> --label <id> --repetitions <n>
                  --out <dir> [--cwd <repo>] [--commit <sha>] [--snapshot]
                  [--max-output-bytes <n>] [--json]
  cliyard eval compare --baseline <run.json> --candidate <run.json>
                       --out <dir|comparison.json> [--json]
  cliyard eval handoff <run-manifest-or-evidence-bundle.json> [--json]

Commands are argv arrays; no shell is used. A run requires a clean repository
and binds the exact HEAD commit (or --commit). --snapshot additionally binds
an uncommitted working tree by materializing it as a detached snapshot commit
and evaluating that exact content in a temporary worktree; the caller's
worktree and history are left untouched. --snapshot cannot be combined with
--commit. Metrics that were not observed stay null/unavailable. Exit codes:
0 success, 1 failed scenarios, 2 invalid input. This makes no paid-model
quality comparison.`);
}

/**
 * Run one eval subcommand. Prints a bounded diagnostic and returns 2 for
 * invalid input; never throws for user input.
 */
export async function runEvaluationCli(
  argv: string[],
  options: EvaluationCliOptions = {},
): Promise<number> {
  const log = options.log ?? ((line: string) => console.log(line));
  const logError = options.logError ?? ((line: string) => console.error(line));
  const baseCwd = options.cwd ?? process.cwd();
  try {
    if (argv.length === 0) {
      usage(logError);
      return 2;
    }
    let offset = 0;
    let snapshot = false;
    while (argv[offset] === "--snapshot") {
      snapshot = true;
      offset += 1;
    }
    const [subcommand, ...rest] = argv.slice(offset);
    if (subcommand === undefined) {
      usage(logError);
      return 2;
    }
    if (subcommand === "--help" || subcommand === "-h" || subcommand === "help") {
      usage(log);
      return 0;
    }
    if (subcommand === "run") {
      return await commandRun(rest, {
        ...options,
        baseCwd,
        log,
        logError,
        snapshot,
      });
    }
    if (snapshot) {
      throw new EvalCliUsageError("--snapshot is only valid for eval run");
    }
    if (subcommand === "compare") {
      return commandCompare(rest, { baseCwd, log, logError });
    }
    if (subcommand === "handoff") {
      return runHandoffCli(rest, { log, logError });
    }
    throw new EvalCliUsageError(`unknown eval subcommand ${JSON.stringify(subcommand)}`);
  } catch (error) {
    logError(`cliyard eval: ${boundedError(error)}`);
    return 2;
  }
}

// ---------------------------------------------------------------------------
// run
// ---------------------------------------------------------------------------

async function commandRun(
  argv: string[],
  context: {
    baseCwd: string;
    log: (line: string) => void;
    logError: (line: string) => void;
    now?: () => Date;
    executor?: EvalCommandExecutor;
    inspectGit?: EvalGitInspector;
    resolveCommit?: (cwd: string) => Promise<string>;
    snapshot?: boolean;
  },
): Promise<number> {
  const { values, flags } = parseFlags(argv, {
    "--suite": "value",
    "--label": "value",
    "--repetitions": "value",
    "--out": "value",
    "--cwd": "value",
    "--commit": "value",
    "--snapshot": "boolean",
    "--max-output-bytes": "value",
    "--json": "boolean",
  });
  const suite = loadHarnessEvalSuiteFile(requireValue(values, "--suite"), {
    cwd: context.baseCwd,
  });
  const label = requireValue(values, "--label");
  const repetitions = parseInteger(
    requireValue(values, "--repetitions"),
    "--repetitions",
    1,
    HARNESS_EVAL_MAX_REPETITIONS,
  );
  const outputDir = resolveOutputDirectory(
    requireValue(values, "--out"),
    context.baseCwd,
    "--out",
  );
  // Validate every option before materializing a snapshot worktree so a bad
  // flag cannot leave temporary Git state behind.
  const maxRaw = values.get("--max-output-bytes");
  const maxOutputBytes =
    maxRaw === undefined
      ? undefined
      : parseInteger(
          maxRaw,
          "--max-output-bytes",
          1,
          HARNESS_EVAL_MAX_OUTPUT_BYTES,
        );
  const cwdRaw = values.get("--cwd");
  const repoCwd =
    cwdRaw === undefined
      ? context.baseCwd
      : resolveExistingDirectory(cwdRaw, context.baseCwd, "--cwd");
  const snapshot = context.snapshot === true || flags.has("--snapshot");
  const explicitCommit = values.get("--commit");
  if (snapshot && explicitCommit !== undefined) {
    throw new EvalCliUsageError("--snapshot cannot be combined with --commit");
  }
  let commit: string;
  let runCwd = repoCwd;
  let cleanupSnapshot: (() => Promise<void>) | undefined;
  if (snapshot) {
    const state = await inspectEvalGitState(repoCwd);
    commit = state.commit;
    if (!state.clean) {
      const materialized = await materializeDirtySnapshot(
        repoCwd,
        state.commit,
      );
      runCwd = materialized.worktreePath;
      commit = materialized.commit;
      cleanupSnapshot = materialized.cleanup;
    }
  } else {
    commit =
      explicitCommit ??
      (await (context.resolveCommit ?? resolveHeadCommit)(repoCwd));
  }
  if (!HARNESS_EVAL_COMMIT_PATTERN.test(commit)) {
    throw new EvalValidationError(
      "invalid-options",
      "commit must be an exact lowercase 40- or 64-character Git commit",
    );
  }

  const baseInspector = context.inspectGit ?? inspectEvalGitState;
  const inspectGit =
    cleanupSnapshot === undefined
      ? baseInspector
      : async (inspectedCwd: string) =>
          tolerateSnapshotDependencyLink(await baseInspector(inspectedCwd));

  try {
    const run = await runHarnessEval({
      suite,
      cwd: runCwd,
      commit,
      label,
      repetitions,
      outputDir,
      executor: context.executor,
      inspectGit,
      maxOutputBytes,
      now: context.now,
    });
    const paths = writeHarnessEvalRunReport(run, outputDir);
    if (flags.has("--json")) {
      context.log(serializeHarnessEvalRunJson(run).trimEnd());
    } else {
      context.log(formatRunSummary(run, paths.jsonPath, paths.markdownPath));
    }
    return run.summary.failedScenarios === 0 ? 0 : 1;
  } finally {
    await cleanupSnapshot?.();
  }
}

interface SnapshotWorktree {
  commit: string;
  worktreePath: string;
  cleanup: () => Promise<void>;
}

/**
 * Materialize the current working tree (including untracked, non-ignored
 * files) as a detached commit object and check that exact tree out in a
 * temporary linked worktree. No branch, ref or working-tree state of the
 * caller is changed. The temporary worktree is the only place scenarios run.
 */
async function materializeDirtySnapshot(
  repoCwd: string,
  headCommit: string,
): Promise<SnapshotWorktree> {
  if (!HARNESS_EVAL_COMMIT_PATTERN.test(headCommit)) {
    throw new EvalValidationError(
      "invalid-git-state",
      "cannot snapshot an invalid HEAD commit",
    );
  }
  let root: string;
  try {
    root = mkdtempSync(join(tmpdir(), "cliyard-eval-snapshot-"));
  } catch {
    throw new EvalValidationError(
      "invalid-git-state",
      "cannot create a temporary snapshot directory",
    );
  }
  const indexFile = join(root, "index");
  const worktreePath = join(root, "worktree");
  const snapshotEnv = {
    ...process.env,
    GIT_INDEX_FILE: indexFile,
    GIT_AUTHOR_NAME: "cliyard-eval",
    GIT_AUTHOR_EMAIL: "cliyard-eval@localhost",
    GIT_COMMITTER_NAME: "cliyard-eval",
    GIT_COMMITTER_EMAIL: "cliyard-eval@localhost",
  };
  const git = (args: string[], useSnapshotIndex: boolean) =>
    execFileAsync("git", args, {
      cwd: repoCwd,
      encoding: "utf8",
      timeout: 60_000,
      maxBuffer: 16 * 1024 * 1024,
      env: useSnapshotIndex ? snapshotEnv : process.env,
    });
  const cleanup = async (): Promise<void> => {
    try {
      await git(["worktree", "remove", "--force", worktreePath], false);
    } catch {
      /* best-effort cleanup */
    }
    try {
      rmSync(root, { recursive: true, force: true });
    } catch {
      /* best-effort cleanup */
    }
  };
  try {
    await git(["read-tree", headCommit], true);
    await git(["add", "-A"], true);
    const tree = String((await git(["write-tree"], true)).stdout).trim();
    if (!/^[0-9a-f]{40,64}$/.test(tree)) {
      throw new Error("invalid tree id");
    }
    const commit = String(
      (
        await git(
          [
            "commit-tree",
            tree,
            "-p",
            headCommit,
            "-m",
            "cliyard eval snapshot of uncommitted work",
          ],
          true,
        )
      ).stdout,
    ).trim();
    if (!HARNESS_EVAL_COMMIT_PATTERN.test(commit)) {
      throw new Error("invalid snapshot commit id");
    }
    await git(["worktree", "add", "--detach", worktreePath, commit], false);
    linkDependencyCache(repoCwd, worktreePath);
    return { commit, worktreePath, cleanup };
  } catch {
    await cleanup();
    throw new EvalValidationError(
      "invalid-git-state",
      "cannot materialize the working tree as a clean snapshot commit",
    );
  }
}

/**
 * Scenario argv such as `node --import tsx` resolves bare specifiers from the
 * fixed cwd, and focused tests also reference `node_modules` by absolute path.
 * A snapshot worktree holds committed content only, so expose the caller's
 * installed dependency cache (ignored by Git) as a link without copying it or
 * binding it into the snapshot commit.
 */
function linkDependencyCache(repoCwd: string, worktreePath: string): void {
  const target = join(repoCwd, "node_modules");
  const link = join(worktreePath, "node_modules");
  if (existsSync(link) || !existsSync(target)) return;
  try {
    symlinkSync(target, link, "dir");
  } catch {
    /* Leave it absent; affected scenarios will report the failure. */
  }
}

/**
 * The snapshot worktree deliberately contains one untracked environment path:
 * the linked dependency cache. That link is not evaluated content, so it is
 * the only dirty entry a snapshot run tolerates. Any other dirt still fails
 * closed through the core's normal Git validation.
 */
function tolerateSnapshotDependencyLink(state: EvalGitState): EvalGitState {
  const dirtyPaths = state.dirtyPaths ?? [];
  if (state.clean || !dirtyPaths.includes("?? node_modules")) return state;
  const dirty = dirtyPaths.filter((line) => line !== "?? node_modules");
  return {
    commit: state.commit,
    clean: dirty.length === 0,
    ...(dirty.length > 0 ? { dirtyPaths: dirty } : {}),
  };
}

async function resolveHeadCommit(cwd: string): Promise<string> {
  try {
    const result = await execFileAsync(
      "git",
      ["rev-parse", "--verify", "HEAD"],
      { cwd, encoding: "utf8", timeout: 30_000, maxBuffer: 64 * 1024 },
    );
    return String(result.stdout).trim();
  } catch {
    throw new EvalValidationError(
      "invalid-git-state",
      "cannot resolve the repository HEAD commit",
    );
  }
}

function formatRunSummary(
  run: HarnessEvalRun,
  jsonPath: string,
  markdownPath: string,
): string {
  const lines = [
    `Harness eval ${run.id} completed at ${run.commit}.`,
    `Scenarios: ${run.summary.passedScenarios}/${run.summary.scenarioCount} passed; ` +
      `repetitions: ${run.summary.passedRepetitions}/${run.summary.repetitionCount} ` +
      `(${percent(run.summary.repetitionPassRate)}).`,
    `Wall time: ${run.wallMs} ms (${run.repetitions} repetition(s)).`,
    `Report: ${jsonPath}`,
    `Markdown: ${markdownPath}`,
  ];
  if (run.missing.length > 0) {
    lines.push(
      `Unavailable observations: ${run.missing.map((entry) => entry.metric).join(", ")}`,
    );
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// compare
// ---------------------------------------------------------------------------

function commandCompare(
  argv: string[],
  context: {
    baseCwd: string;
    log: (line: string) => void;
    logError: (line: string) => void;
  },
): number {
  const { values, flags } = parseFlags(argv, {
    "--baseline": "value",
    "--candidate": "value",
    "--out": "value",
    "--json": "boolean",
  });
  const baseline = readJsonFile(
    requireValue(values, "--baseline"),
    context.baseCwd,
    "baseline",
  );
  const candidate = readJsonFile(
    requireValue(values, "--candidate"),
    context.baseCwd,
    "candidate",
  );
  const outRaw = requireValue(values, "--out");
  const comparison = compareHarnessEvalRuns(baseline.value, candidate.value);
  const output = resolveComparisonOutput(outRaw, context.baseCwd);
  if (output.kind === "file") {
    if (
      output.jsonPath === baseline.path ||
      output.jsonPath === candidate.path
    ) {
      throw new EvalCliUsageError(
        "--out must not overwrite the baseline or candidate run",
      );
    }
    writeAtomicFile(
      output.jsonPath,
      serializeHarnessEvalComparisonJson(comparison),
    );
    writeAtomicFile(
      output.markdownPath,
      renderHarnessEvalComparisonMarkdown(comparison),
    );
    if (flags.has("--json")) {
      context.log(serializeHarnessEvalComparisonJson(comparison).trimEnd());
    } else {
      context.log(
        formatComparisonSummary(
          comparison,
          output.jsonPath,
          output.markdownPath,
        ),
      );
    }
    return 0;
  }
  const paths = writeHarnessEvalComparisonReport(comparison, output.dir);
  if (flags.has("--json")) {
    context.log(serializeHarnessEvalComparisonJson(comparison).trimEnd());
  } else {
    context.log(
      formatComparisonSummary(comparison, paths.jsonPath, paths.markdownPath),
    );
  }
  return 0;
}

function formatComparisonSummary(
  comparison: HarnessEvalComparison,
  jsonPath: string,
  markdownPath: string,
): string {
  const lines = [
    `Harness eval comparison (${comparison.interpretation}): ` +
      `${comparison.baseline.label} ${percent(comparison.baseline.passRate)} -> ` +
      `${comparison.candidate.label} ${percent(comparison.candidate.passRate)}.`,
    `Flipped scenarios: ${
      comparison.flippedScenarios.length === 0
        ? "none"
        : comparison.flippedScenarios.join(", ")
    }`,
    `Pass-rate delta: ${percent(comparison.passRateDelta)}; ` +
      `wall-time delta: ${comparison.wallMsDelta} ms.`,
    `Report: ${jsonPath}`,
    `Markdown: ${markdownPath}`,
  ];
  if (comparison.missing.length > 0) {
    lines.push(
      `Unavailable observations: ${comparison.missing
        .map((entry) => entry.metric)
        .join(", ")}`,
    );
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Paths and bounded I/O
// ---------------------------------------------------------------------------

interface NamedValue {
  path: string;
  value: unknown;
}

function readJsonFile(
  raw: string,
  baseCwd: string,
  label: string,
): NamedValue {
  const path = resolve(baseCwd, requirePathText(raw, label));
  if (path === parsePath(path).root) {
    throw new EvalValidationError(
      "unsafe-path",
      `${label} must not be the filesystem root`,
    );
  }
  let stats;
  try {
    stats = statSync(path);
  } catch {
    throw new EvalValidationError(
      "unsafe-path",
      `cannot read the ${label} file`,
    );
  }
  if (!stats.isFile()) {
    throw new EvalValidationError(
      "unsafe-path",
      `${label} must be a regular file`,
    );
  }
  if (stats.size > MAX_RUN_FILE_BYTES) {
    throw new EvalValidationError(
      "unsafe-path",
      `${label} exceeds the ${MAX_RUN_FILE_BYTES}-byte bound`,
    );
  }
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    throw new EvalValidationError(
      "unsafe-path",
      `cannot read the ${label} file`,
    );
  }
  try {
    return { path, value: JSON.parse(text) as unknown };
  } catch {
    throw new EvalValidationError(
      "malformed-run",
      `${label} is not valid JSON`,
    );
  }
}

function requirePathText(raw: string, label: string): string {
  if (
    raw.length === 0 ||
    raw.length > MAX_CLI_PATH_LENGTH ||
    raw.includes(String.fromCharCode(0))
  ) {
    throw new EvalValidationError(
      "unsafe-path",
      `${label} must be a bounded non-empty path`,
    );
  }
  return raw;
}

function resolveOutputDirectory(
  raw: string,
  baseCwd: string,
  flag: string,
): string {
  const path = resolve(baseCwd, requirePathText(raw, flag));
  if (path === parsePath(path).root) {
    throw new EvalValidationError(
      "unsafe-path",
      `${flag} must not be the filesystem root`,
    );
  }
  let stats;
  try {
    stats = statSync(path);
  } catch {
    return path;
  }
  if (!stats.isDirectory()) {
    throw new EvalValidationError("unsafe-path", `${flag} must be a directory`);
  }
  return path;
}

function resolveExistingDirectory(
  raw: string,
  baseCwd: string,
  flag: string,
): string {
  const path = resolve(baseCwd, requirePathText(raw, flag));
  if (path === parsePath(path).root) {
    throw new EvalValidationError(
      "unsafe-path",
      `${flag} must not be the filesystem root`,
    );
  }
  let stats;
  try {
    stats = statSync(path);
  } catch {
    throw new EvalValidationError(
      "unsafe-path",
      `${flag} must be an existing directory`,
    );
  }
  if (!stats.isDirectory()) {
    throw new EvalValidationError("unsafe-path", `${flag} must be a directory`);
  }
  return path;
}

type ComparisonOutput =
  | { kind: "dir"; dir: string }
  | { kind: "file"; jsonPath: string; markdownPath: string };

function resolveComparisonOutput(
  raw: string,
  baseCwd: string,
): ComparisonOutput {
  const path = resolve(baseCwd, requirePathText(raw, "--out"));
  if (path === parsePath(path).root) {
    throw new EvalValidationError(
      "unsafe-path",
      "--out must not be the filesystem root",
    );
  }
  const extension = extname(path);
  if (extension.toLowerCase() !== ".json") {
    let stats;
    try {
      stats = statSync(path);
    } catch {
      return { kind: "dir", dir: path };
    }
    if (!stats.isDirectory()) {
      throw new EvalValidationError(
        "unsafe-path",
        "--out must be a directory or a .json file path",
      );
    }
    return { kind: "dir", dir: path };
  }
  let stats;
  try {
    stats = statSync(path);
  } catch {
    stats = undefined;
  }
  if (stats !== undefined && !stats.isFile()) {
    throw new EvalValidationError(
      "unsafe-path",
      "--out .json path must not be an existing directory",
    );
  }
  const markdownPath = `${path.slice(0, path.length - extension.length)}.md`;
  return { kind: "file", jsonPath: path, markdownPath };
}

function writeAtomicFile(path: string, content: string): void {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = join(dir, `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`);
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

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

type FlagKind = "value" | "boolean";

function parseFlags(
  argv: string[],
  specs: Record<string, FlagKind>,
): { values: Map<string, string>; flags: Set<string> } {
  const values = new Map<string, string>();
  const flags = new Set<string>();
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]!;
    if (!token.startsWith("--") || token === "--") {
      throw new EvalCliUsageError(
        `unexpected argument ${JSON.stringify(token.slice(0, 80))}`,
      );
    }
    const equals = token.indexOf("=");
    const name = equals < 0 ? token : token.slice(0, equals);
    const inline = equals < 0 ? undefined : token.slice(equals + 1);
    const kind = specs[name];
    if (kind === undefined) {
      throw new EvalCliUsageError(`unknown flag ${name}`);
    }
    if (kind === "boolean") {
      if (inline !== undefined) {
        throw new EvalCliUsageError(`${name} does not take a value`);
      }
      if (flags.has(name)) {
        throw new EvalCliUsageError(`${name} may be specified only once`);
      }
      flags.add(name);
      continue;
    }
    if (values.has(name)) {
      throw new EvalCliUsageError(`${name} may be specified only once`);
    }
    let value = inline;
    if (value === undefined) {
      const next = argv[index + 1];
      if (next === undefined || next.startsWith("--")) {
        throw new EvalCliUsageError(`${name} requires a value`);
      }
      value = next;
      index += 1;
    }
    if (value.length === 0) {
      throw new EvalCliUsageError(`${name} requires a value`);
    }
    values.set(name, value);
  }
  return { values, flags };
}

function requireValue(values: Map<string, string>, flag: string): string {
  const value = values.get(flag);
  if (value === undefined) {
    throw new EvalCliUsageError(`${flag} is required`);
  }
  return value;
}

function parseInteger(
  raw: string,
  flag: string,
  min: number,
  max: number,
): number {
  if (!/^[0-9]+$/.test(raw)) {
    throw new EvalCliUsageError(
      `${flag} must be an integer between ${min} and ${max}`,
    );
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new EvalCliUsageError(
      `${flag} must be an integer between ${min} and ${max}`,
    );
  }
  return value;
}

function percent(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function boundedError(error: unknown): string {
  const message =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : "unknown error";
  return message.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").slice(0, MAX_ERROR_LENGTH);
}

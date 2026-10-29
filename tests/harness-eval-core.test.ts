import { after, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  EvalValidationError,
  compareHarnessEvalRuns,
  createArgvCommandExecutor,
  inspectEvalGitState,
  parseHarnessEvalRun,
  parseHarnessEvalSuite,
  runHarnessEval,
} from "../src/evaluation/core.js";
import {
  renderHarnessEvalComparisonMarkdown,
  renderHarnessEvalRunMarkdown,
  serializeHarnessEvalComparisonJson,
  serializeHarnessEvalRunJson,
  writeHarnessEvalComparisonReport,
  writeHarnessEvalRunReport,
} from "../src/evaluation/report.js";
import type {
  EvalCommandExecutor,
  EvalCommandRequest,
  EvalScenario,
  HarnessEvalRun,
} from "../src/evaluation/types.js";

const CLEAN_TIME = new Date("2026-10-29T00:00:00.000Z");
const COMMIT_A = "a".repeat(40);
const COMMIT_B = "b".repeat(40);
const cleanupRoots: string[] = [];

after(() => {
  for (const root of cleanupRoots) {
    rmSync(root, { recursive: true, force: true });
  }
});

function tempDir(prefix = "cliyard-harness-eval-"): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanupRoots.push(dir);
  return dir;
}

function scenario(overrides: Partial<EvalScenario> = {}): EvalScenario {
  return {
    id: "normal-work",
    category: "core",
    purpose: "exercise the deterministic engine",
    commands: [["node", "-e", "process.exit(0)"]],
    timeoutMsPerCommand: 1_000,
    expectedExit: "zero",
    ...overrides,
  };
}

function suiteOf(
  scenarios: EvalScenario[] = [scenario()],
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    version: 1,
    id: "harness-eval-core",
    scenarios,
    ...overrides,
  };
}

interface FixtureExecutors {
  executor: EvalCommandExecutor;
  calls: EvalCommandRequest[];
}

function codeSequence(
  codes: Array<number | null>,
  options: { stdout?: string; stderr?: string } = {},
): FixtureExecutors {
  let index = 0;
  const calls: EvalCommandRequest[] = [];
  return {
    calls,
    executor: async (request) => {
      calls.push({
        ...request,
        argv: [...request.argv],
      });
      const next = codes[index];
      index += 1;
      if (next === undefined) {
        throw new Error(`unexpected executor call ${index}`);
      }
      return {
        exitCode: next,
        stdout: options.stdout ?? "",
        stderr: options.stderr ?? "",
      };
    },
  };
}

function dirtyState(commit: string) {
  return async () => ({ commit, clean: false, dirtyPaths: [" M file.ts"] });
}

async function runFixture(options: {
  suite?: Record<string, unknown>;
  commit?: string;
  repetitions?: number;
  executor?: EvalCommandExecutor;
  outputDir?: string;
  cwd?: string;
  inspectGit?: (cwd: string) => Promise<{ commit: string; clean: boolean }>;
  maxOutputBytes?: number;
}): Promise<{ run: HarnessEvalRun; outputDir: string; cwd: string }> {
  const root = tempDir();
  const cwd = options.cwd ?? tempDir("cliyard-harness-eval-cwd-");
  const outputDir = options.outputDir ?? join(root, "out");
  const commit = options.commit ?? COMMIT_A;
  const run = await runHarnessEval({
    suite: options.suite ?? suiteOf(),
    cwd,
    outputDir,
    commit,
    label: "baseline",
    repetitions: options.repetitions ?? 1,
    executor: options.executor ?? (async () => ({ exitCode: 0 })),
    inspectGit:
      options.inspectGit ?? (async () => ({ commit, clean: true })),
    maxOutputBytes: options.maxOutputBytes,
    now: () => new Date(CLEAN_TIME),
  });
  return { run, outputDir, cwd };
}

function expectValidation(
  operation: () => unknown,
  code: EvalValidationError["code"],
  label: string,
): void {
  assert.throws(
    operation,
    (error) =>
      error instanceof EvalValidationError &&
      error.code === code &&
      error.message.length > 0,
    label,
  );
}

async function expectAsyncValidation(
  operation: Promise<unknown>,
  code: EvalValidationError["code"],
  label: string,
): Promise<void> {
  await assert.rejects(
    operation,
    (error) =>
      error instanceof EvalValidationError &&
      error.code === code &&
      error.message.length > 0,
    label,
  );
}

test("suite parser accepts argv arrays and fails closed on unsafe suite data", () => {
  const parsed = parseHarnessEvalSuite(suiteOf());
  assert.equal(parsed.version, 1);
  assert.equal(parsed.scenarios.length, 1);
  assert.deepEqual(parsed.scenarios[0]?.commands, [
    ["node", "-e", "process.exit(0)"],
  ]);

  const invalid: Array<[string, unknown]> = [
    ["non-object", "suite"],
    ["wrong version", suiteOf([scenario()], { version: 2 })],
    ["unsafe suite id", suiteOf([scenario()], { id: "../escape" })],
    ["no scenarios", suiteOf([], { scenarios: [] })],
    ["duplicate ids", suiteOf([scenario(), scenario()])],
    [
      "shell string in argv",
      suiteOf([scenario({ commands: [["node -e process.exit(0)"]] })]),
    ],
    ["empty argv", suiteOf([scenario({ commands: [[]] })])],
    ["empty command list", suiteOf([scenario({ commands: [] })])],
    [
      "unsafe scenario id",
      suiteOf([scenario({ id: "../normal-work" })]),
    ],
    [
      "invalid timeout",
      suiteOf([scenario({ timeoutMsPerCommand: 0 })]),
    ],
    [
      "invalid expected exit",
      suiteOf([
        scenario({
          expectedExit: "sometimes" as unknown as EvalScenario["expectedExit"],
        }),
      ]),
    ],
    [
      "empty purpose",
      suiteOf([scenario({ purpose: "   " })]),
    ],
    [
      "nul in argument",
      suiteOf([
        scenario({
          commands: [["node", `bad${String.fromCharCode(0)}arg`]],
        }),
      ]),
    ],
  ];
  for (const [label, value] of invalid) {
    expectValidation(
      () => parseHarnessEvalSuite(value),
      "malformed-suite",
      label,
    );
  }
});

test("run binds an exact clean commit and rejects wrong or dirty repositories", async () => {
  const repo = tempDir("cliyard-harness-eval-git-");
  execFileSync("git", ["init"], { cwd: repo });
  execFileSync("git", ["config", "user.email", "eval@example.test"], {
    cwd: repo,
  });
  execFileSync("git", ["config", "user.name", "Harness Eval"], { cwd: repo });
  writeFileSync(join(repo, "file.txt"), "clean\n");
  execFileSync("git", ["add", "."], { cwd: repo });
  execFileSync("git", ["commit", "-m", "fixture"], {
    cwd: repo,
    stdio: "ignore",
  });
  const commit = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: repo,
    encoding: "utf8",
  }).trim();
  const state = await inspectEvalGitState(repo);
  assert.equal(state.commit, commit);
  assert.equal(state.clean, true);

  const outputDir = join(tempDir(), "out");
  const run = await runHarnessEval({
    suite: suiteOf(),
    cwd: repo,
    outputDir,
    commit,
    label: "clean",
    repetitions: 1,
    executor: async () => ({ exitCode: 0 }),
    now: () => new Date(CLEAN_TIME),
  });
  assert.equal(run.commit, commit);
  assert.equal(run.clean, true);

  const wrongCommit = "c".repeat(40);
  await expectAsyncValidation(
    runHarnessEval({
      suite: suiteOf(),
      cwd: repo,
      outputDir: join(tempDir(), "out"),
      commit: wrongCommit,
      label: "wrong-commit",
      repetitions: 1,
      executor: async () => ({ exitCode: 0 }),
      now: () => new Date(CLEAN_TIME),
    }),
    "invalid-git-state",
    "wrong commit",
  );

  writeFileSync(join(repo, "dirty.txt"), "dirty\n");
  await expectAsyncValidation(
    runHarnessEval({
      suite: suiteOf(),
      cwd: repo,
      outputDir: join(tempDir(), "out"),
      commit,
      label: "dirty",
      repetitions: 1,
      executor: async () => ({ exitCode: 0 }),
      now: () => new Date(CLEAN_TIME),
    }),
    "invalid-git-state",
    "dirty repository",
  );

  await expectAsyncValidation(
    runFixture({
      inspectGit: dirtyState(COMMIT_A) as never,
      executor: async () => ({ exitCode: 0 }),
    }),
    "invalid-git-state",
    "injected dirty state",
  );
});

test("runner repeats scenarios, passes only when every repetition matches, and bounds output", async () => {
  const fixture = codeSequence([0, 0, 0, 0, 0, 1], {
    stdout: "x".repeat(200),
  });
  const suite = suiteOf([
    scenario({
      id: "normal-work",
      commands: [
        ["node", "-e", "process.exit(0)"],
        ["node", "-e", "process.exit(0)"],
      ],
      timeoutMsPerCommand: 321,
    }),
  ]);
  const { run, outputDir, cwd } = await runFixture({
    suite,
    repetitions: 3,
    executor: fixture.executor,
    maxOutputBytes: 16,
  });

  assert.equal(fixture.calls.length, 6);
  for (const call of fixture.calls) {
    assert.equal(call.cwd, cwd);
    assert.equal(call.timeoutMs, 321);
    assert.equal(call.maxOutputBytes, 16);
    assert.ok(call.signal instanceof AbortSignal);
  }
  assert.equal(run.status, "completed");
  assert.equal(run.repetitions, 3);
  assert.equal(run.scenarios[0]?.status, "failed");
  assert.equal(run.scenarios[0]?.passedRepetitions, 2);
  assert.equal(run.scenarios[0]?.failedRepetitions, 1);
  assert.deepEqual(
    run.scenarios[0]?.repetitions.map((repetition) => repetition.status),
    ["passed", "passed", "failed"],
  );
  assert.equal(run.summary.passRate, 0);
  assert.equal(run.summary.repetitionPassRate, 2 / 3);
  assert.equal(run.metrics.passRate, 0);
  assert.equal(run.metrics.wallMs, run.wallMs);
  assert.equal(run.metrics.requests, null);
  assert.equal(run.metrics.inputTokens, null);
  assert.equal(run.metrics.outputTokens, null);
  assert.equal(run.metrics.cacheHits, null);
  assert.equal(run.metrics.humanInterventions, null);
  assert.equal(run.metrics.cost.state, "unavailable");
  assert.equal(run.metrics.cost.amount, null);
  assert.deepEqual(
    run.missing.map((entry) => entry.metric),
    [
      "metrics.requests",
      "metrics.inputTokens",
      "metrics.outputTokens",
      "metrics.cacheHits",
      "metrics.cost.amount",
      "metrics.humanInterventions",
    ],
  );
  assert.ok(run.missing.every((entry) => entry.reason.length > 0));

  const first = run.scenarios[0]?.repetitions[0]?.commands[0];
  assert.ok(first);
  assert.equal(first.stdout, "x".repeat(16));
  assert.equal(first.stdoutBytes, 200);
  assert.equal(first.stdoutTruncated, true);
  assert.equal(first.outputTruncated, true);
  assert.equal(existsSync(first.logPath), true);
  assert.ok(first.logPath.startsWith(outputDir));
  assert.ok(readFileSync(first.logPath, "utf8").length < 2_000);

  // Persisted runs are parseable and cannot quietly become malformed evidence.
  const persisted = JSON.parse(serializeHarnessEvalRunJson(run)) as unknown;
  const parsed = parseHarnessEvalRun(persisted);
  assert.equal(parsed.id, run.id);
  assert.equal(parsed.summary.repetitionPassRate, 2 / 3);
});

test("explicit nonzero expectation passes; timeout and signal do not count as nonzero", async () => {
  const nonzero = await runFixture({
    suite: suiteOf([
      scenario({
        id: "expected-failure",
        expectedExit: "nonzero",
        commands: [["node", "-e", "process.exit(7)"]],
      }),
    ]),
    executor: async () => ({ exitCode: 7 }),
  });
  assert.equal(nonzero.run.scenarios[0]?.status, "passed");
  assert.equal(nonzero.run.summary.passRate, 1);

  const timedOut = await runFixture({
    suite: suiteOf([
      scenario({
        id: "timeout",
        expectedExit: "nonzero",
        timeoutMsPerCommand: 20,
        commands: [["node", "-e", "setTimeout(() => {}, 1000)"]],
      }),
    ]),
    executor: () =>
      new Promise((resolve) => {
        setTimeout(() => resolve({ exitCode: 1 }), 200);
      }),
  });
  const command = timedOut.run.scenarios[0]?.repetitions[0]?.commands[0];
  assert.equal(command?.timedOut, true);
  assert.equal(command?.matchedExpectation, false);
  assert.equal(command?.exitCode, null);
  assert.match(command?.error ?? "", /exceeded 20ms/);
  assert.equal(timedOut.run.scenarios[0]?.status, "failed");

  const executorError = await runFixture({
    executor: async () => ({ exitCode: 0, error: "executor failed" }),
  });
  assert.equal(executorError.run.scenarios[0]?.status, "failed");
  assert.equal(
    executorError.run.scenarios[0]?.repetitions[0]?.commands[0]?.error,
    "executor failed",
  );

  const nonzeroWithSignal = await runFixture({
    expectedExit: "nonzero",
    executor: async () => ({ exitCode: 2, signal: "SIGTERM" }),
  });
  assert.equal(nonzeroWithSignal.run.scenarios[0]?.status, "failed");

  const emptyError = await runFixture({
    executor: async () => ({ exitCode: 0, error: "  " }),
  });
  assert.equal(emptyError.run.scenarios[0]?.status, "failed");
  assert.equal(
    emptyError.run.scenarios[0]?.repetitions[0]?.commands[0]?.error,
    "executor reported an empty error",
  );
});

test("default executor runs argv without a shell and enforces its timeout", async () => {
  const { run } = await runFixture({
    suite: suiteOf([
      scenario({
        id: "argv",
        commands: [
          [
            process.execPath,
            "-e",
            "process.stdout.write(process.argv[1] ?? '')",
            "hello world",
          ],
        ],
      }),
      scenario({
        id: "timeout",
        timeoutMsPerCommand: 100,
        commands: [[process.execPath, "-e", "setTimeout(() => {}, 5000)"]],
      }),
    ]),
    maxOutputBytes: 64,
    executor: createArgvCommandExecutor(),
  });
  const argvCommand = run.scenarios[0]?.repetitions[0]?.commands[0];
  assert.equal(argvCommand?.exitCode, 0);
  assert.equal(argvCommand?.stdout, "hello world");
  assert.equal(run.scenarios[0]?.status, "passed");

  const timeoutCommand = run.scenarios[1]?.repetitions[0]?.commands[0];
  assert.equal(timeoutCommand?.timedOut, true);
  assert.equal(timeoutCommand?.exitCode, null);
  assert.equal(run.scenarios[1]?.status, "failed");
  assert.ok(run.wallMs < 5_000);
});

test("unsafe options and malformed repetitions fail before execution", async () => {
  const fixture = codeSequence([0]);
  const base = {
    suite: suiteOf(),
    cwd: tempDir(),
    outputDir: join(tempDir(), "out"),
    commit: COMMIT_A,
    label: "baseline",
    repetitions: 1,
    executor: fixture.executor,
    inspectGit: async () => ({ commit: COMMIT_A, clean: true }),
    now: () => new Date(CLEAN_TIME),
  };

  await expectAsyncValidation(
    runHarnessEval({ ...base, repetitions: 0 }),
    "invalid-options",
    "zero repetitions",
  );
  await expectAsyncValidation(
    runHarnessEval({ ...base, repetitions: 51 }),
    "invalid-options",
    "too many repetitions",
  );
  await expectAsyncValidation(
    runHarnessEval({ ...base, label: "../label" }),
    "invalid-options",
    "unsafe label",
  );
  await expectAsyncValidation(
    runHarnessEval({ ...base, commit: "ABC" }),
    "invalid-options",
    "invalid commit",
  );
  await expectAsyncValidation(
    runHarnessEval({ ...base, cwd: "relative" }),
    "unsafe-path",
    "relative cwd",
  );
  await expectAsyncValidation(
    runHarnessEval({ ...base, outputDir: "/" }),
    "unsafe-path",
    "root output",
  );
  await expectAsyncValidation(
    runHarnessEval({ ...base, outputDir: "relative-out" }),
    "unsafe-path",
    "relative output",
  );
  await expectAsyncValidation(
    runHarnessEval({
      ...base,
      suite: suiteOf([scenario({ timeoutMsPerCommand: 600_001 })]),
    }),
    "malformed-suite",
    "oversized timeout",
  );
  await expectAsyncValidation(
    runHarnessEval({
      ...base,
      inspectGit: async () => {
        throw new Error("git unavailable");
      },
    }),
    "invalid-git-state",
    "throwing Git inspector",
  );
  assert.equal(fixture.calls.length, 0);
});

test("baseline/candidate comparison reports flips across different exact commits", async () => {
  const scenarios = [
    scenario({ id: "alpha" }),
    scenario({ id: "beta" }),
    scenario({ id: "gamma" }),
  ];
  const baselineFixture = codeSequence([0, 1, 0]);
  const baseline = await runFixture({
    suite: suiteOf(scenarios),
    commit: COMMIT_A,
    executor: baselineFixture.executor,
  });
  const candidateFixture = codeSequence([0, 0, 1]);
  const candidate = await runFixture({
    suite: suiteOf(scenarios),
    commit: COMMIT_B,
    executor: candidateFixture.executor,
  });

  assert.notEqual(baseline.run.commit, candidate.run.commit);
  const comparison = compareHarnessEvalRuns(baseline.run, candidate.run);
  assert.equal(comparison.version, 1);
  assert.equal(comparison.suiteId, "harness-eval-core");
  assert.equal(comparison.interpretation, "cross-commit-change");
  assert.deepEqual(comparison.flippedScenarios, ["beta", "gamma"]);
  assert.deepEqual(comparison.becamePassing, ["beta"]);
  assert.deepEqual(comparison.becameFailing, ["gamma"]);
  assert.equal(comparison.baseline.commit, COMMIT_A);
  assert.equal(comparison.candidate.commit, COMMIT_B);
  assert.equal(comparison.passRateDelta, 0);
  assert.equal(comparison.missing.length, 6);
  assert.ok(comparison.missing.every((entry) => entry.baselineReason));
  assert.ok(comparison.missing.every((entry) => entry.candidateReason));
  assert.match(comparison.note, /different commits/);

  const sameCommit = compareHarnessEvalRuns(baseline.run, {
    ...baseline.run,
    label: "repeat",
    id: baseline.run.id.replace("baseline", "repeat"),
  });
  assert.equal(sameCommit.interpretation, "same-commit-repeatability");
  assert.deepEqual(sameCommit.flippedScenarios, []);
  assert.match(sameCommit.note, /same commit/);
});

test("comparison rejects incompatible suites, repetition counts and malformed baselines", async () => {
  const first = codeSequence([0]);
  const baseline = await runFixture({ executor: first.executor });

  const mismatchSuite = {
    ...baseline.run,
    suiteId: "other-suite",
  };
  expectValidation(
    () => compareHarnessEvalRuns(baseline.run, mismatchSuite),
    "malformed-comparison",
    "suite id mismatch",
  );

  const twoReps = await runFixture({
    repetitions: 2,
    executor: async () => ({ exitCode: 0 }),
  });
  expectValidation(
    () => compareHarnessEvalRuns(baseline.run, twoReps.run),
    "malformed-comparison",
    "repetition mismatch",
  );

  const missingScenario = {
    ...baseline.run,
    scenarios: [],
  };
  expectValidation(
    () => compareHarnessEvalRuns(missingScenario, baseline.run),
    "malformed-run",
    "empty baseline scenarios",
  );

  const missingReason = JSON.parse(
    JSON.stringify(baseline.run),
  ) as HarnessEvalRun;
  missingReason.missing = missingReason.missing.filter(
    (entry) => entry.metric !== "metrics.requests",
  );
  expectValidation(
    () => compareHarnessEvalRuns(missingReason, baseline.run),
    "malformed-run",
    "missing reason removed",
  );

  const brokenCounts = JSON.parse(
    JSON.stringify(baseline.run),
  ) as HarnessEvalRun;
  brokenCounts.scenarios[0]!.passedRepetitions = 0;
  expectValidation(
    () => parseHarnessEvalRun(brokenCounts),
    "malformed-run",
    "inconsistent counters",
  );

  const brokenCost = JSON.parse(
    JSON.stringify(baseline.run),
  ) as HarnessEvalRun;
  brokenCost.metrics.cost.amount = 1;
  expectValidation(
    () => parseHarnessEvalRun(brokenCost),
    "malformed-run",
    "unavailable cost with amount",
  );

  expectValidation(
    () => compareHarnessEvalRuns({ version: 1 }, baseline.run),
    "malformed-run",
    "truncated baseline",
  );
});

test("reports are deterministic, bounded and written only below the output directory", async () => {
  const { run, outputDir } = await runFixture({
    executor: async () => ({
      exitCode: 0,
      stdout: `line1\n${"[31m"}bounded | output[0m ${"y".repeat(500)}`,
      stderr: "warn\n",
    }),
  });
  const json = serializeHarnessEvalRunJson(run);
  const roundTrip = JSON.parse(json) as unknown;
  assert.equal(serializeHarnessEvalRunJson(roundTrip), json);
  assert.ok(json.endsWith("\n"));

  const markdown = renderHarnessEvalRunMarkdown(run);
  assert.match(markdown, /# Harness Eval: baseline/);
  assert.match(markdown, new RegExp(run.commit));
  assert.match(markdown, /unavailable/);
  assert.ok(Buffer.byteLength(markdown, "utf8") <= 32 * 1_024);
  assert.equal(markdown.includes(""), false);

  const tiny = renderHarnessEvalRunMarkdown(run, 512);
  assert.ok(Buffer.byteLength(tiny, "utf8") <= 512);
  assert.match(tiny, /truncated at report bound/);

  const paths = writeHarnessEvalRunReport(run, outputDir);
  assert.equal(paths.jsonPath, join(outputDir, "run.json"));
  assert.equal(paths.markdownPath, join(outputDir, "run.md"));
  assert.ok(paths.jsonPath.startsWith(outputDir));
  assert.ok(paths.markdownPath.startsWith(outputDir));
  assert.equal(readFileSync(paths.jsonPath, "utf8"), json);
  assert.equal(readFileSync(paths.markdownPath, "utf8"), markdown);

  const secondFixture = codeSequence([1]);
  const second = await runFixture({
    commit: COMMIT_B,
    executor: secondFixture.executor,
  });
  const comparison = compareHarnessEvalRuns(run, second.run);
  const comparisonJson = serializeHarnessEvalComparisonJson(comparison);
  assert.deepEqual(JSON.parse(comparisonJson), comparison);
  const comparisonMarkdown = renderHarnessEvalComparisonMarkdown(comparison);
  assert.match(comparisonMarkdown, /# Harness Eval Comparison/);
  assert.ok(Buffer.byteLength(comparisonMarkdown, "utf8") <= 32 * 1_024);
  const comparisonTiny = renderHarnessEvalComparisonMarkdown(
    comparison,
    512,
  );
  assert.ok(Buffer.byteLength(comparisonTiny, "utf8") <= 512);
  const comparisonPaths = writeHarnessEvalComparisonReport(
    comparison,
    outputDir,
  );
  assert.equal(
    readFileSync(comparisonPaths.jsonPath, "utf8"),
    `${JSON.stringify(comparison, null, 2)}\n`,
  );
  assert.equal(
    readFileSync(comparisonPaths.markdownPath, "utf8"),
    comparisonMarkdown,
  );

  expectValidation(
    () => writeHarnessEvalRunReport(run, "relative"),
    "invalid-options",
    "relative report directory",
  );

  const badRef = JSON.parse(JSON.stringify(comparison)) as HarnessEvalComparison;
  badRef.baseline.passRate = 2;
  expectValidation(
    () => serializeHarnessEvalComparisonJson(badRef),
    "invalid-options",
    "out-of-range comparison pass rate",
  );

  const badFlips = JSON.parse(
    JSON.stringify(comparison),
  ) as HarnessEvalComparison;
  badFlips.flippedScenarios = [...badFlips.flippedScenarios, "zzz"];
  expectValidation(
    () => serializeHarnessEvalComparisonJson(badFlips),
    "invalid-options",
    "flip list disagreement",
  );
});

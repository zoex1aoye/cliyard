import { after, test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  EvalValidationError,
  parseHarnessEvalRun,
  parseHarnessEvalSuite,
} from "../src/evaluation/core.js";
import { runEvaluationCli } from "../src/evaluation/cli.js";
import {
  HARNESS_EVAL_SUITE_FILE,
  MAX_HARNESS_EVAL_SUITE_BYTES,
  REQUIRED_SCENARIO_IDS,
  createHarnessEvalSuite,
} from "../src/evaluation/scenarios.js";
import { HARNESS_EVAL_MAX_MARKDOWN_BYTES } from "../src/evaluation/types.js";

const ROOT = dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
const CLI_PATH = join(ROOT, "src", "cli.ts");
// The CLI is spawned from a fixture cwd where `--import tsx` would not resolve.
const TSX_LOADER = join(ROOT, "node_modules", "tsx", "dist", "loader.mjs");
const cleanupRoots: string[] = [];

after(() => {
  for (const root of cleanupRoots) {
    rmSync(root, { recursive: true, force: true });
  }
});

function tempDir(prefix = "cliyard-eval-cli-"): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanupRoots.push(dir);
  return dir;
}

function runGit(cwd: string, args: string[]): string {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(
    result.status,
    0,
    `git ${args.join(" ")} failed: ${result.stderr}`,
  );
  return result.stdout.trim();
}

function createRepo(
  root: string,
  files: Record<string, string> = { "README.md": "fixture\n" },
): { dir: string; commit: string } {
  const dir = join(root, "repo");
  mkdirSync(dir, { recursive: true });
  runGit(dir, ["init", "-q"]);
  runGit(dir, ["config", "user.email", "eval@example.com"]);
  runGit(dir, ["config", "user.name", "Eval Test"]);
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(dir, name), content, "utf8");
  }
  return { dir, commit: commitAll(dir, "initial") };
}

function commitAll(dir: string, message: string): string {
  runGit(dir, ["add", "-A"]);
  runGit(dir, ["commit", "-q", "-m", message]);
  return runGit(dir, ["rev-parse", "HEAD"]);
}

interface ScenarioSpec {
  id: string;
  commands: string[][];
  category?: string;
  purpose?: string;
  timeoutMsPerCommand?: number;
  expectedExit?: "zero" | "nonzero";
}

function makeScenario(spec: ScenarioSpec): Record<string, unknown> {
  return {
    id: spec.id,
    category: spec.category ?? "cli",
    purpose: spec.purpose ?? `Exercise ${spec.id}.`,
    commands: spec.commands,
    timeoutMsPerCommand: spec.timeoutMsPerCommand ?? 60_000,
    expectedExit: spec.expectedExit ?? "zero",
  };
}

function writeSuiteFile(
  root: string,
  name: string,
  scenarios: Array<Record<string, unknown>>,
  overrides: Record<string, unknown> = {},
): string {
  const suite = {
    version: 1,
    id: "cli-suite",
    label: "CLI suite",
    scenarios,
    ...overrides,
  };
  writeFileSync(join(root, name), JSON.stringify(suite, null, 2), "utf8");
  return name;
}

interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

async function runCli(args: string[], baseCwd: string): Promise<CliResult> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const code = await runEvaluationCli(args, {
    cwd: baseCwd,
    log: (line) => stdout.push(line),
    logError: (line) => stderr.push(line),
  });
  return { code, stdout: stdout.join("\n"), stderr: stderr.join("\n") };
}

function runCliProcess(
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv = {},
): CliResult & { status: number | null } {
  const result = spawnSync(
    process.execPath,
    ["--import", TSX_LOADER, CLI_PATH, ...args],
    {
      cwd,
      encoding: "utf8",
      timeout: 120_000,
      env: { ...process.env, ...env },
    },
  );
  return {
    code: result.status ?? -1,
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

function parseRunOutput(result: CliResult, expectedCode = 0) {
  assert.equal(result.code, expectedCode, result.stderr);
  return parseHarnessEvalRun(JSON.parse(result.stdout));
}

// ---------------------------------------------------------------------------
// run
// ---------------------------------------------------------------------------

test("eval run executes argv without a shell at a fixed cwd and binds the exact clean commit", () => {
  const root = tempDir();
  const { dir: repo, commit } = createRepo(root);
  const argv = [
    "node",
    "-e",
    "const fs=require('fs');fs.writeFileSync('cwd-proof.txt',process.cwd());" +
      "process.stdout.write(process.cwd())",
  ];
  writeSuiteFile(root, "suite.json", [
    makeScenario({ id: "normal-work", commands: [argv] }),
    makeScenario({
      id: "expected-nonzero",
      commands: [["node", "-e", "process.exit(7)"]],
      expectedExit: "nonzero",
    }),
  ]);

  const result = runCliProcess(
    [
      "eval",
      "run",
      "--suite",
      "suite.json",
      "--label",
      "baseline",
      "--repetitions",
      "2",
      "--out",
      "out",
      "--cwd",
      "repo",
      "--json",
    ],
    root,
  );
  assert.equal(result.stderr, "");
  const run = parseRunOutput(result);

  assert.equal(run.label, "baseline");
  assert.equal(run.commit, commit);
  assert.equal(run.clean, true);
  assert.equal(run.repetitions, 2);
  assert.equal(run.status, "completed");
  assert.equal(run.summary.scenarioCount, 2);
  assert.equal(run.summary.passedScenarios, 2);
  assert.equal(run.summary.passedRepetitions, 4);
  assert.equal(run.metrics.passRate, 1);
  assert.equal(run.metrics.requests, null);
  assert.equal(run.metrics.inputTokens, null);
  assert.equal(run.metrics.outputTokens, null);
  assert.equal(run.metrics.cacheHits, null);
  assert.equal(run.metrics.humanInterventions, null);
  assert.equal(run.metrics.cost.state, "unavailable");
  assert.equal(run.metrics.cost.authoritative, false);
  assert.ok(run.missing.some((entry) => entry.metric === "metrics.requests"));
  assert.ok(run.missing.every((entry) => entry.reason.length > 0));

  const normal = run.scenarios.find((scenario) => scenario.id === "normal-work")!;
  assert.deepEqual(normal.repetitions[0]!.commands[0]!.argv, argv);
  assert.equal(normal.repetitions[0]!.commands[0]!.exitCode, 0);
  assert.equal(normal.repetitions[0]!.commands[0]!.stdout, realpathSync(repo));
  const nonzero = run.scenarios.find(
    (scenario) => scenario.id === "expected-nonzero",
  )!;
  assert.equal(nonzero.expectedExit, "nonzero");
  assert.equal(nonzero.repetitions[0]!.commands[0]!.exitCode, 7);
  assert.equal(nonzero.repetitions[0]!.commands[0]!.matchedExpectation, true);

  // The child ran in the requested repository, not in the CLI cwd.
  assert.equal(
    realpathSync(readFileSync(join(repo, "cwd-proof.txt"), "utf8")),
    realpathSync(repo),
  );

  const jsonText = readFileSync(join(root, "out", "run.json"), "utf8");
  const markdown = readFileSync(join(root, "out", "run.md"), "utf8");
  assert.deepEqual(JSON.parse(jsonText), JSON.parse(result.stdout));
  assert.ok(statSync(join(root, "out", "run.md")).size <= HARNESS_EVAL_MAX_MARKDOWN_BYTES);
  assert.match(markdown, /no claim about/);
  assert.match(markdown, /provider-level context compaction/);
});

test("a timed-out command fails the scenario and is reported as timed out", async () => {
  const root = tempDir();
  createRepo(root);
  writeSuiteFile(root, "suite.json", [
    makeScenario({
      id: "sleeps",
      commands: [["node", "-e", "setTimeout(() => {}, 30000)"]],
      timeoutMsPerCommand: 100,
    }),
  ]);
  const result = await runCli(
    [
      "run",
      "--suite",
      "suite.json",
      "--label",
      "timeout",
      "--repetitions",
      "1",
      "--out",
      "out",
      "--cwd",
      "repo",
      "--json",
    ],
    root,
  );
  const run = parseRunOutput(result, 1);
  assert.equal(run.summary.failedScenarios, 1);
  assert.equal(run.clean, true);
  const command = run.scenarios[0]!.repetitions[0]!.commands[0]!;
  assert.equal(command.timedOut, true);
  assert.match(command.error ?? "", /exceeded 100ms/);
  assert.equal(command.matchedExpectation, false);
  assert.ok(command.durationMs < 10_000);
});

test("stateful repetition failure is preserved instead of hidden by a pass", async () => {
  const root = tempDir();
  createRepo(root);
  const counter = join(root, "counter.txt");
  const script =
    "const fs=require('fs');const p=" +
    JSON.stringify(counter) +
    ";if(fs.existsSync(p)){process.exit(1)}fs.writeFileSync(p,'seen')";
  writeSuiteFile(root, "suite.json", [
    makeScenario({ id: "stateful", commands: [["node", "-e", script]] }),
  ]);
  const result = await runCli(
    [
      "run",
      "--suite",
      "suite.json",
      "--label",
      "flaky",
      "--repetitions",
      "2",
      "--out",
      "out",
      "--cwd",
      "repo",
      "--json",
    ],
    root,
  );
  const run = parseRunOutput(result, 1);
  const scenario = run.scenarios[0]!;
  assert.equal(scenario.status, "failed");
  assert.equal(scenario.passedRepetitions, 1);
  assert.equal(scenario.failedRepetitions, 1);
  assert.equal(run.summary.passedRepetitions, 1);
  assert.equal(run.summary.repetitionPassRate, 0.5);
});

test("command output and rendered reports stay bounded and keep trailing secrets out", async () => {
  const root = tempDir();
  createRepo(root);
  const secret = "SECRET_AFTER_BOUND_123456789";
  // Keep the secret out of argv: only bounded command output may expose it.
  const secretPath = join(root, "tail-secret.txt");
  writeFileSync(secretPath, secret, "utf8");
  const script =
    'process.stdout.write("A".repeat(12000) + ' +
    `require('fs').readFileSync(${JSON.stringify(secretPath)}, "utf8"))`;
  writeSuiteFile(root, "suite.json", [
    makeScenario({ id: "noisy", commands: [["node", "-e", script]] }),
  ]);
  const result = await runCli(
    [
      "run",
      "--suite",
      "suite.json",
      "--label",
      "bounded",
      "--repetitions",
      "1",
      "--out",
      "out",
      "--cwd",
      "repo",
      "--max-output-bytes",
      "1024",
      "--json",
    ],
    root,
  );
  const run = parseRunOutput(result);
  const command = run.scenarios[0]!.repetitions[0]!.commands[0]!;
  assert.equal(command.stdout.length, 1024);
  assert.equal(command.stdoutBytes, 12_000 + secret.length);
  assert.equal(command.stdoutTruncated, true);
  assert.equal(command.outputTruncated, true);
  assert.equal(command.stdout.includes(secret), false);

  const jsonText = readFileSync(join(root, "out", "run.json"), "utf8");
  const markdown = readFileSync(join(root, "out", "run.md"), "utf8");
  assert.equal(jsonText.includes(secret), false);
  assert.equal(markdown.includes(secret), false);
  assert.ok(statSync(join(root, "out", "run.md")).size <= HARNESS_EVAL_MAX_MARKDOWN_BYTES);
});

test("eval run fails closed on malformed suites, unsafe ids, paths and Git state", async () => {
  const root = tempDir();
  const { dir: repo, commit } = createRepo(root);
  writeSuiteFile(root, "suite.json", [
    makeScenario({ id: "ok", commands: [["node", "-e", "process.exit(0)"]] }),
  ]);
  writeFileSync(join(root, "bad-suite.json"), "{not json", "utf8");
  writeSuiteFile(root, "unsafe-id-suite.json", [
    makeScenario({ id: "Bad/Id", commands: [["node", "-e", "process.exit(0)"]] }),
  ]);
  writeSuiteFile(root, "shell-suite.json", [
    makeScenario({
      id: "shell-text",
      commands: [["node -e 'process.exit(0)'"]],
    }),
  ]);
  writeFileSync(join(root, "not-a-directory"), "file\n", "utf8");

  const runArgs = (out: string, extra: string[] = []) => [
    "run",
    "--suite",
    "suite.json",
    "--label",
    "fail-closed",
    "--repetitions",
    "1",
    "--out",
    out,
    "--cwd",
    "repo",
    ...extra,
  ];

  const cases: Array<{ name: string; args: string[]; pattern: RegExp }> = [
    {
      name: "malformed-suite",
      args: ["run", "--suite", "bad-suite.json", "--label", "x", "--repetitions", "1", "--out", "out-malformed-suite", "--cwd", "repo"],
      pattern: /not valid JSON/,
    },
    {
      name: "unsafe-suite-id",
      args: ["run", "--suite", "unsafe-id-suite.json", "--label", "x", "--repetitions", "1", "--out", "out-unsafe-id", "--cwd", "repo"],
      pattern: /safe id/,
    },
    {
      name: "shell-text",
      args: ["run", "--suite", "shell-suite.json", "--label", "x", "--repetitions", "1", "--out", "out-shell", "--cwd", "repo"],
      pattern: /shell text/,
    },
    {
      name: "unsafe-label",
      args: [
        "run",
        "--suite",
        "suite.json",
        "--label",
        "../escape",
        "--repetitions",
        "1",
        "--out",
        "out-unsafe-label",
        "--cwd",
        "repo",
      ],
      pattern: /safe id/,
    },
    {
      name: "zero-repetitions",
      args: [
        "run",
        "--suite",
        "suite.json",
        "--label",
        "x",
        "--repetitions",
        "0",
        "--out",
        "out-zero",
        "--cwd",
        "repo",
      ],
      pattern: /between 1 and 50/,
    },
    {
      name: "unknown-flag",
      args: runArgs("out-unknown", ["--bogus"]),
      pattern: /unknown flag/,
    },
    {
      name: "missing-suite",
      args: ["run", "--label", "x", "--repetitions", "1", "--out", "out-missing-suite", "--cwd", "repo"],
      pattern: /--suite is required/,
    },
    {
      name: "root-out",
      args: runArgs("/"),
      pattern: /filesystem root/,
    },
    {
      name: "out-is-file",
      args: runArgs("not-a-directory"),
      pattern: /must be a directory/,
    },
    {
      name: "wrong-commit",
      args: runArgs("out-wrong-commit", ["--commit", "e".repeat(40)]),
      pattern: /does not match/,
    },
  ];

  for (const item of cases) {
    const result = await runCli(item.args, root);
    assert.equal(result.code, 2, `${item.name}: ${result.stdout}${result.stderr}`);
    assert.equal(result.stdout, "", item.name);
    assert.match(result.stderr, item.pattern, item.name);
    assert.ok(result.stderr.length < 1_000, item.name);
    assert.equal(
      existsSync(join(root, `out-${item.name}`)),
      false,
      `${item.name} must not create its output directory`,
    );
  }

  writeFileSync(join(repo, "dirty.txt"), "dirty\n", "utf8");
  const dirty = await runCli(runArgs("out-dirty", ["--commit", commit]), root);
  assert.equal(dirty.code, 2);
  assert.match(dirty.stderr, /must be clean/);
  assert.equal(existsSync(join(root, "out-dirty")), false);
  rmSync(join(repo, "dirty.txt"));
});

// ---------------------------------------------------------------------------
// compare
// ---------------------------------------------------------------------------

test("eval compare reports flips across commits and supports dir and file output", async () => {
  const root = tempDir();
  const { dir: repo, commit: baselineCommit } = createRepo(root, {
    "README.md": "fixture\n",
    "alpha.ok": "alpha\n",
  });
  const check = (marker: string): string[] => [
    "node",
    "-e",
    `process.exit(require('fs').existsSync(${JSON.stringify(marker)})?0:1)`,
  ];
  writeSuiteFile(
    root,
    "flip-suite.json",
    [
      makeScenario({ id: "alpha", commands: [check("alpha.ok")] }),
      makeScenario({ id: "beta", commands: [check("beta.ok")] }),
    ],
    { id: "flip-suite" },
  );

  const run = (label: string, out: string, extra: string[] = []) =>
    runCli(
      [
        "run",
        "--suite",
        "flip-suite.json",
        "--label",
        label,
        "--repetitions",
        "1",
        "--out",
        out,
        "--cwd",
        "repo",
        "--json",
        ...extra,
      ],
      root,
    );

  const baseline = await run("base", "runs/base");
  assert.equal(baseline.code, 1, baseline.stderr);
  const baselineRun = parseHarnessEvalRun(JSON.parse(baseline.stdout));
  const baseRepeat = await run("base-repeat", "runs/base-repeat");
  assert.equal(baseRepeat.code, 1);
  assert.equal(
    parseHarnessEvalRun(JSON.parse(baseRepeat.stdout)).commit,
    baselineCommit,
  );

  const repeat = await runCli(
    [
      "compare",
      "--baseline",
      "runs/base/run.json",
      "--candidate",
      "runs/base-repeat/run.json",
      "--out",
      "comparisons/repeat",
      "--json",
    ],
    root,
  );
  assert.equal(repeat.code, 0, repeat.stderr);
  const repeatComparison = JSON.parse(repeat.stdout);
  assert.equal(repeatComparison.interpretation, "same-commit-repeatability");
  assert.deepEqual(repeatComparison.flippedScenarios, []);

  rmSync(join(repo, "alpha.ok"));
  writeFileSync(join(repo, "beta.ok"), "beta\n", "utf8");
  const candidateCommit = commitAll(repo, "flip markers");
  assert.notEqual(candidateCommit, baselineCommit);

  const candidate = await run("cand", "runs/cand");
  assert.equal(candidate.code, 1, candidate.stderr);
  const candidateRun = parseHarnessEvalRun(JSON.parse(candidate.stdout));
  assert.equal(candidateRun.commit, candidateCommit);

  const cross = await runCli(
    [
      "compare",
      "--baseline",
      "runs/base/run.json",
      "--candidate",
      "runs/cand/run.json",
      "--out",
      "comparisons/cross",
      "--json",
    ],
    root,
  );
  assert.equal(cross.code, 0, cross.stderr);
  const comparison = JSON.parse(cross.stdout);
  assert.equal(comparison.interpretation, "cross-commit-change");
  assert.deepEqual(comparison.flippedScenarios, ["alpha", "beta"]);
  assert.deepEqual(comparison.becameFailing, ["alpha"]);
  assert.deepEqual(comparison.becamePassing, ["beta"]);
  assert.equal(comparison.passRateDelta, 0);
  assert.equal(comparison.baseline.commit, baselineCommit);
  assert.equal(comparison.candidate.commit, candidateCommit);
  assert.ok(
    comparison.missing.some(
      (entry: { metric: string; baselineReason: string | null; candidateReason: string | null }) =>
        entry.metric === "metrics.requests" &&
        entry.baselineReason !== null &&
        entry.candidateReason !== null,
    ),
  );
  assert.deepEqual(
    JSON.parse(readFileSync(join(root, "comparisons/cross/comparison.json"), "utf8")),
    comparison,
  );
  assert.match(
    readFileSync(join(root, "comparisons/cross/comparison.md"), "utf8"),
    /alpha.*failed -> passed|alpha.*passed -> failed/,
  );

  const fileOut = await runCli(
    [
      "compare",
      "--baseline",
      "runs/base/run.json",
      "--candidate",
      "runs/cand/run.json",
      "--out",
      "comparisons/custom.json",
      "--json",
    ],
    root,
  );
  assert.equal(fileOut.code, 0, fileOut.stderr);
  assert.deepEqual(
    JSON.parse(readFileSync(join(root, "comparisons/custom.json"), "utf8")),
    JSON.parse(fileOut.stdout),
  );
  assert.ok(existsSync(join(root, "comparisons/custom.md")));
  assert.equal(existsSync(join(root, "comparisons/comparison.json")), false);
});

test("eval compare fails closed on malformed runs, mismatches and unsafe paths", async () => {
  const root = tempDir();
  const { dir: repo } = createRepo(root);
  writeSuiteFile(root, "suite.json", [
    makeScenario({ id: "alpha", commands: [["node", "-e", "process.exit(0)"]] }),
  ]);
  const run = (label: string, out: string, repetitions = "1") =>
    runCli(
      [
        "run",
        "--suite",
        "suite.json",
        "--label",
        label,
        "--repetitions",
        repetitions,
        "--out",
        out,
        "--cwd",
        "repo",
        "--json",
      ],
      root,
    );
  const baseline = await run("base", "runs/base");
  assert.equal(baseline.code, 0, baseline.stderr);
  const candidate = await run("cand", "runs/cand", "2");
  assert.equal(candidate.code, 0, candidate.stderr);
  const sameReps = await run("cand-same-reps", "runs/cand1");
  assert.equal(sameReps.code, 0, sameReps.stderr);

  writeFileSync(join(root, "bad-run.json"), "{not json", "utf8");
  writeFileSync(join(root, "empty-run.json"), "{}\n", "utf8");
  writeFileSync(join(root, "existing.txt"), "x\n", "utf8");
  const baselineText = readFileSync(join(root, "runs/base/run.json"), "utf8");

  const compare = (extra: string[]) => [
    "compare",
    "--baseline",
    "runs/base/run.json",
    "--candidate",
    "runs/cand1/run.json",
    ...extra,
  ];

  const cases: Array<{ name: string; args: string[]; pattern: RegExp }> = [
    {
      name: "malformed-json",
      args: [
        "compare",
        "--baseline",
        "bad-run.json",
        "--candidate",
        "runs/cand1/run.json",
        "--out",
        "cmp/bad",
        "--json",
      ],
      pattern: /not valid JSON/,
    },
    {
      name: "malformed-run",
      args: [
        "compare",
        "--baseline",
        "empty-run.json",
        "--candidate",
        "runs/cand1/run.json",
        "--out",
        "cmp/empty",
        "--json",
      ],
      pattern: /version/,
    },
    {
      name: "repetition-mismatch",
      args: [
        "compare",
        "--baseline",
        "runs/base/run.json",
        "--candidate",
        "runs/cand/run.json",
        "--out",
        "cmp/reps",
        "--json",
      ],
      pattern: /repetition count mismatch/,
    },
    {
      name: "overwrite-baseline",
      args: compare(["--out", "runs/base/run.json", "--json"]),
      pattern: /must not overwrite/,
    },
    {
      name: "root-out",
      args: compare(["--out", "/", "--json"]),
      pattern: /filesystem root/,
    },
    {
      name: "out-is-file",
      args: compare(["--out", "existing.txt", "--json"]),
      pattern: /directory or a .json file path/,
    },
    {
      name: "unknown-flag",
      args: compare(["--out", "cmp/unknown", "--json", "--bogus"]),
      pattern: /unknown flag/,
    },
  ];

  for (const item of cases) {
    const result = await runCli(item.args, root);
    assert.equal(result.code, 2, `${item.name}: ${result.stdout}${result.stderr}`);
    assert.equal(result.stdout, "", item.name);
    assert.match(result.stderr, item.pattern, item.name);
  }
  assert.equal(readFileSync(join(root, "runs/base/run.json"), "utf8"), baselineText);
  assert.equal(existsSync(join(root, "cmp")), false);
});

// ---------------------------------------------------------------------------
// handoff
// ---------------------------------------------------------------------------

test("eval handoff reconstructs the next action from a terminal fixture through the CLI", () => {
  const root = tempDir();
  const manifest = {
    version: 1,
    runId: "run-cli-handoff",
    planId: "cli-handoff",
    repoRoot: join(root, "repo"),
    contractsPath: join(root, "repo", "contracts.json"),
    contractsHash: "d".repeat(64),
    baseCommit: "a".repeat(40),
    integrationBranch: "cliyard/integration/cli-handoff",
    integrationHead: "c".repeat(40),
    status: "completed",
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T01:00:00.000Z",
    owner: { pid: 4321, host: "fixture-host" },
    prompt: "TOP SECRET handoff prompt",
    tasks: {
      "task-a": {
        taskId: "task-a",
        status: "accepted",
        accepted: true,
        resultCommit: "b".repeat(40),
        prompt: "TOP SECRET task prompt",
      },
    },
  };
  writeFileSync(
    join(root, "manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf8",
  );

  const result = runCliProcess(
    ["eval", "handoff", "manifest.json", "--json"],
    root,
  );
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stderr, "");
  const decision = JSON.parse(result.stdout) as {
    source: string;
    runId: string;
    nextAction: string;
    nextActionMatched: boolean;
    humanReviewRequired: boolean;
    sourceSha256: string;
  };
  assert.equal(decision.source, "run-manifest");
  assert.equal(decision.runId, "run-cli-handoff");
  assert.equal(decision.nextAction, "human-review");
  assert.equal(decision.nextActionMatched, true);
  assert.equal(decision.humanReviewRequired, true);
  assert.match(decision.sourceSha256, /^[0-9a-f]{64}$/);
  assert.equal(result.stdout.includes("TOP SECRET"), false);

  writeFileSync(
    join(root, "running.json"),
    `${JSON.stringify({ ...manifest, status: "running" }, null, 2)}\n`,
    "utf8",
  );
  const running = runCliProcess(
    ["eval", "handoff", "running.json", "--json"],
    root,
  );
  assert.equal(running.code, 2);
  assert.equal(running.stdout, "");
  assert.match(running.stderr, /running|terminal/i);
});

// ---------------------------------------------------------------------------
// examples and CLI wiring
// ---------------------------------------------------------------------------

test("the example suite is the canonical six-scenario suite with existing test files", () => {
  const suitePath = join(ROOT, HARNESS_EVAL_SUITE_FILE);
  const parsed = parseHarnessEvalSuite(JSON.parse(readFileSync(suitePath, "utf8")));
  assert.deepEqual(parsed, createHarnessEvalSuite());
  assert.equal(parsed.id, "cliyard-harness-v0");
  assert.deepEqual(
    parsed.scenarios.map((scenario) => scenario.id),
    [...REQUIRED_SCENARIO_IDS],
  );
  for (const scenario of parsed.scenarios) {
    assert.equal(scenario.expectedExit, "zero");
    assert.ok(scenario.commands.length >= 1);
    for (const argv of scenario.commands) {
      assert.equal(argv[0], "node");
      assert.ok(argv.includes("--test"));
      const testFile = argv[argv.length - 1]!;
      assert.match(testFile, /^tests\/[a-z0-9-]+\.test\.ts$/);
      assert.ok(existsSync(join(ROOT, testFile)), `${testFile} must exist`);
      // Node exits 0 when --test-name-pattern matches nothing (the test is
      // reported as skipped), so a renamed test would silently turn this
      // scenario green. Keep the pattern anchored to a real test title.
      const pattern = argv[argv.indexOf("--test-name-pattern") + 1]!;
      const source = readFileSync(join(ROOT, testFile), "utf8");
      assert.match(
        source,
        new RegExp(pattern),
        `${testFile} must still contain a test matching ${pattern}`,
      );
    }
  }
});

test("the harness-eval npm script composes with the verifier's trailing run", async () => {
  const pkg = JSON.parse(
    readFileSync(join(ROOT, "package.json"), "utf8"),
  ) as { scripts: Record<string, string> };
  const script = pkg.scripts["harness-eval"];
  assert.ok(script, "package.json must define harness-eval");
  const tokens = script.split(/\s+/);
  assert.deepEqual(tokens.slice(0, 3), ["tsx", "src/cli.ts", "eval"]);

  // `npm run harness-eval -- run ...` appends the verifier's argv after the
  // script; a leading --snapshot must compose with a following subcommand.
  const root = tempDir();
  const result = await runCli(
    [
      ...tokens.slice(3),
      "run",
      "--suite",
      "missing.json",
      "--label",
      "npm-script",
      "--repetitions",
      "1",
      "--out",
      "out-npm-script",
    ],
    root,
  );
  assert.equal(result.code, 2, result.stderr);
  assert.match(result.stderr, /cannot read suite file/);
});

test("src/cli.ts dispatches eval and the eval CLI prints bounded help", () => {
  const help = runCliProcess(["eval", "--help"], ROOT);
  assert.equal(help.code, 0);
  assert.match(help.stdout, /cliyard eval/);
  assert.match(help.stdout, /no shell is used/);

  const usage = runCliProcess(["eval"], ROOT);
  assert.equal(usage.code, 2);
  assert.equal(usage.stdout, "");
  assert.match(usage.stderr, /Usage:/);
});

test("loading a missing or oversized suite fails closed before Git", async () => {
  const root = tempDir();
  const result = await runCli(
    [
      "run",
      "--suite",
      "missing.json",
      "--label",
      "missing",
      "--repetitions",
      "1",
      "--out",
      "out",
    ],
    root,
  );
  assert.equal(result.code, 2);
  assert.match(result.stderr, /cannot read suite file/);
  assert.equal(existsSync(join(root, "out")), false);

  const oversizedPath = join(root, "oversized-suite.json");
  writeFileSync(oversizedPath, "{}\n", "utf8");
  truncateSync(oversizedPath, MAX_HARNESS_EVAL_SUITE_BYTES + 1);
  const oversized = await runCli(
    [
      "run",
      "--suite",
      "oversized-suite.json",
      "--label",
      "oversized",
      "--repetitions",
      "1",
      "--out",
      "out-oversized",
    ],
    root,
  );
  assert.equal(oversized.code, 2);
  assert.match(oversized.stderr, /exceeds/);
  assert.equal(existsSync(join(root, "out-oversized")), false);

  const nul = await runCli(
    [
      "run",
      "--suite",
      `bad${String.fromCharCode(0)}.json`,
      "--label",
      "nul",
      "--repetitions",
      "1",
      "--out",
      "out-nul",
    ],
    root,
  );
  assert.equal(nul.code, 2);
  assert.match(nul.stderr, /bounded non-empty path/);
  assert.equal(existsSync(join(root, "out-nul")), false);

  assert.throws(
    () =>
      parseHarnessEvalSuite({
        version: 1,
        id: "suite",
        scenarios: [],
      }),
    (error: unknown) =>
      error instanceof EvalValidationError &&
      error.code === "malformed-suite",
  );
});

test("eval run --snapshot binds uncommitted content as an exact detached commit", async () => {
  const root = tempDir();
  const { dir: repo } = createRepo(root);
  writeFileSync(join(repo, "dirty.txt"), "uncommitted\n", "utf8");
  writeSuiteFile(root, "snapshot-suite.json", [
    makeScenario({
      id: "snapshot-ok",
      commands: [
        [
          "node",
          "-e",
          "require('node:fs').writeFileSync('snapshot-proof.txt','ran')",
        ],
      ],
    }),
  ]);

  const result = await runCli(
    [
      "--snapshot",
      "run",
      "--suite",
      "snapshot-suite.json",
      "--label",
      "snapshot",
      "--repetitions",
      "1",
      "--out",
      "out-snapshot",
      "--cwd",
      "repo",
      "--json",
    ],
    root,
  );
  assert.equal(result.code, 0, result.stderr);
  const run = JSON.parse(result.stdout) as { commit: string };
  const head = runGit(repo, ["rev-parse", "HEAD"]);
  assert.notEqual(run.commit, head);
  assert.match(run.commit, /^[0-9a-f]{40}$/);
  assert.equal(runGit(repo, ["cat-file", "-t", run.commit]), "commit");
  // The bound commit is the content the scenario executed, and the caller's
  // worktree and history are untouched.
  assert.equal(runGit(repo, ["rev-parse", "HEAD"]), head);
  assert.equal(readFileSync(join(repo, "dirty.txt"), "utf8"), "uncommitted\n");
  assert.equal(existsSync(join(repo, "snapshot-proof.txt")), false);
  assert.match(runGit(repo, ["status", "--porcelain"]), /\?\? dirty\.txt/);
  assert.doesNotMatch(
    runGit(repo, ["worktree", "list"]),
    /cliyard-eval-snapshot/,
  );
});

test("eval run --snapshot tolerates only the linked dependency cache in the worktree", async () => {
  const root = tempDir();
  const { dir: repo } = createRepo(root, {
    "README.md": "fixture\n",
    ".gitignore": "node_modules/\n",
  });
  mkdirSync(join(repo, "node_modules", "fake-pkg"), { recursive: true });
  writeFileSync(
    join(repo, "node_modules", "fake-pkg", "index.js"),
    "module.exports = 1;\n",
    "utf8",
  );
  const head = runGit(repo, ["rev-parse", "HEAD"]);
  writeFileSync(join(repo, "dirty.txt"), "uncommitted\n", "utf8");
  writeSuiteFile(root, "snapshot-deps-suite.json", [
    makeScenario({
      id: "deps-ok",
      commands: [["node", "-e", "process.exit(0)"]],
    }),
  ]);

  const result = await runCli(
    [
      "--snapshot",
      "run",
      "--suite",
      "snapshot-deps-suite.json",
      "--label",
      "snapshot-deps",
      "--repetitions",
      "1",
      "--out",
      "out-snapshot-deps",
      "--cwd",
      "repo",
      "--json",
    ],
    root,
  );
  assert.equal(result.code, 0, result.stderr);
  const run = JSON.parse(result.stdout) as { commit: string };
  // The installed cache is linked for execution but never bound into the
  // exact snapshot commit, and the caller's repository stays untouched.
  assert.doesNotMatch(
    runGit(repo, ["ls-tree", "-r", "--name-only", run.commit]),
    /node_modules/,
  );
  assert.equal(runGit(repo, ["rev-parse", "HEAD"]), head);
  assert.equal(
    statSync(join(repo, "node_modules", "fake-pkg", "index.js")).isFile(),
    true,
  );
  assert.doesNotMatch(
    runGit(repo, ["worktree", "list"]),
    /cliyard-eval-snapshot/,
  );
});

test("eval run --snapshot fails closed when combined with --commit", async () => {
  const root = tempDir();
  const { dir: repo } = createRepo(root);
  writeSuiteFile(root, "snapshot-conflict-suite.json", [
    makeScenario({ id: "ok", commands: [["node", "-e", "process.exit(0)"]] }),
  ]);
  const result = await runCli(
    [
      "--snapshot",
      "run",
      "--suite",
      "snapshot-conflict-suite.json",
      "--label",
      "snapshot-conflict",
      "--repetitions",
      "1",
      "--out",
      "out-snapshot-conflict",
      "--cwd",
      "repo",
      "--commit",
      runGit(repo, ["rev-parse", "HEAD"]),
    ],
    root,
  );
  assert.equal(result.code, 2);
  assert.match(result.stderr, /cannot be combined/);
});

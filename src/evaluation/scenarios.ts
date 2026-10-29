/**
 * Deterministic Harness Eval v0 scenario suite.
 *
 * Every scenario reuses a real focused test family from this repository. The
 * suite is data: commands are argv arrays executed without a shell against the
 * repository root, so no prompt, provider or interactive terminal is involved.
 *
 * `examples/harness-eval/suite.json` is the on-disk projection of
 * `createHarnessEvalSuite()`; a test asserts the two stay identical.
 */
import { readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { EvalValidationError, parseHarnessEvalSuite } from "./core.js";
import {
  HARNESS_EVAL_SUITE_VERSION,
  type EvalScenario,
  type HarnessEvalSuite,
} from "./types.js";

export const HARNESS_EVAL_SCENARIO_SUITE_ID = "cliyard-harness-v0";
export const HARNESS_EVAL_SCENARIO_SUITE_LABEL = "cliyard harness eval v0";
export const HARNESS_EVAL_SUITE_FILE = "examples/harness-eval/suite.json";

/** Fail closed before parsing an unbounded suite file. */
export const MAX_HARNESS_EVAL_SUITE_BYTES = 1 * 1024 * 1024;
const MAX_SUITE_PATH_LENGTH = 4_096;

/** The six scenarios required by design/evidence-and-harness-eval-v0.md. */
export const REQUIRED_SCENARIO_IDS = [
  "normal-work",
  "high-fanout-process-tree",
  "verifier-timeout-and-extension",
  "controller-sigkill-recovery",
  "path-escape",
  "context-reload-handoff",
] as const;

export type RequiredScenarioId = (typeof REQUIRED_SCENARIO_IDS)[number];

/**
 * Invoke one focused Node test file through tsx. `--test` keeps the child's
 * exit code exact: a failing test file exits nonzero without any shell
 * wrapper.
 */
function focusedTest(file: string, testNamePattern: string): string[] {
  return [
    "node",
    "--import",
    "tsx",
    "--test",
    "--test-name-pattern",
    testNamePattern,
    file,
  ];
}

const SCENARIOS: readonly EvalScenario[] = [
  {
    id: "normal-work",
    category: "lifecycle",
    purpose:
      "A normal foreground Supervisor batch accepts its tasks, persists a " +
      "completed RunManifest and exposes a clean status checkpoint.",
    commands: [
      focusedTest("tests/loop.test.ts", "runClosedLoop happy path"),
    ],
    timeoutMsPerCommand: 300_000,
    expectedExit: "zero",
  },
  {
    id: "high-fanout-process-tree",
    category: "process",
    purpose:
      "A wide nested worker process group is captured, cleaned and persisted " +
      "with exact POSIX identities and bounded residual evidence.",
    commands: [
      focusedTest(
        "tests/worker-process-tree.test.ts",
        "cleans more than 16 external groups with a 512-member group",
      ),
    ],
    timeoutMsPerCommand: 600_000,
    expectedExit: "zero",
  },
  {
    id: "verifier-timeout-and-extension",
    category: "continuation",
    purpose:
      "Deadline extension, timeout and late-result evidence stay correct under " +
      "mapped activity. This deliberately includes the observed in-flight " +
      "checkpoint flake so repetition outcomes stay visible.",
    commands: [
      focusedTest(
        "tests/deadline-extension.test.ts",
        "(the same child timer|collect waits for an in-flight grant checkpoint)",
      ),
    ],
    timeoutMsPerCommand: 600_000,
    expectedExit: "zero",
  },
  {
    id: "controller-sigkill-recovery",
    category: "recovery",
    purpose:
      "A SIGKILLed controller's persisted top-level and nested worker groups " +
      "recover through exact identities, never through process-name matching.",
    commands: [
      focusedTest(
        "tests/worker-lease.test.ts",
        "recovers a controller-death fixture's 512-member nested group",
      ),
    ],
    timeoutMsPerCommand: 600_000,
    expectedExit: "zero",
  },
  {
    id: "path-escape",
    category: "boundary",
    purpose:
      "WorkspaceBoundary detects out-of-write-path changes after a wave and " +
      "rejects the affected task while preserving bounded evidence instead of " +
      "deleting it. This is guard-only detection, not write prevention.",
    commands: [
      focusedTest(
        "tests/workspace-boundary-integration.test.ts",
        "dirty wave rejects every task",
      ),
    ],
    timeoutMsPerCommand: 300_000,
    expectedExit: "zero",
  },
  {
    id: "context-reload-handoff",
    category: "context",
    purpose:
      "A fresh process reads only a terminal RunManifest/EvidenceBundle " +
      "fixture and reconstructs the next legal action. This simulates context " +
      "loss and does not claim provider-level compaction equivalence.",
    commands: [
      focusedTest(
        "tests/harness-eval-handoff.test.ts",
        "(a fresh process reconstructs|blocked retryable state resumes|an EvidenceBundle fixture is re-decided)",
      ),
    ],
    timeoutMsPerCommand: 300_000,
    expectedExit: "zero",
  },
];

/** Fresh suite object; callers may add scenarios but not mutate the canonical list. */
export function createHarnessEvalSuite(): HarnessEvalSuite {
  return {
    version: HARNESS_EVAL_SUITE_VERSION,
    id: HARNESS_EVAL_SCENARIO_SUITE_ID,
    label: HARNESS_EVAL_SCENARIO_SUITE_LABEL,
    scenarios: SCENARIOS.map((scenario) => ({
      ...scenario,
      commands: scenario.commands.map((argv) => [...argv]),
    })),
  };
}

export function listHarnessEvalScenarios(): EvalScenario[] {
  return createHarnessEvalSuite().scenarios;
}

/**
 * Load a suite file with a hard byte bound, then validate it through the same
 * parser the runner uses. Malformed JSON, unsafe ids and shell strings fail
 * closed before any command or Git probe runs.
 */
export function loadHarnessEvalSuiteFile(
  path: string,
  options: { cwd?: string } = {},
): HarnessEvalSuite {
  if (
    typeof path !== "string" ||
    path.length === 0 ||
    path.length > MAX_SUITE_PATH_LENGTH ||
    path.includes(String.fromCharCode(0))
  ) {
    throw new EvalValidationError(
      "unsafe-path",
      "suite path must be a bounded non-empty path",
    );
  }
  const resolved = resolve(options.cwd ?? process.cwd(), path);
  let stats;
  try {
    stats = statSync(resolved);
  } catch (error) {
    throw new EvalValidationError(
      "unsafe-path",
      `cannot read suite file: ${boundedError(error)}`,
    );
  }
  if (!stats.isFile()) {
    throw new EvalValidationError(
      "unsafe-path",
      `suite path is not a regular file: ${resolved}`,
    );
  }
  if (stats.size > MAX_HARNESS_EVAL_SUITE_BYTES) {
    throw new EvalValidationError(
      "unsafe-path",
      `suite file exceeds the ${MAX_HARNESS_EVAL_SUITE_BYTES}-byte bound`,
    );
  }
  let text: string;
  try {
    text = readFileSync(resolved, "utf8");
  } catch (error) {
    throw new EvalValidationError(
      "unsafe-path",
      `cannot read suite file: ${boundedError(error)}`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    throw new EvalValidationError(
      "malformed-suite",
      "suite file is not valid JSON",
    );
  }
  return parseHarnessEvalSuite(parsed);
}

/** Require the six design-mandated scenario ids without ordering assumptions. */
export function assertRequiredScenarios(suite: HarnessEvalSuite): void {
  const ids = new Set(suite.scenarios.map((scenario) => scenario.id));
  const missing = REQUIRED_SCENARIO_IDS.filter((id) => !ids.has(id));
  if (missing.length > 0) {
    throw new EvalValidationError(
      "malformed-suite",
      `suite is missing required scenarios: ${missing.join(", ")}`,
    );
  }
}

function boundedError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const controlPattern = /[\u0000-\u001f\u007f]/g;
  return message.replace(controlPattern, " ").slice(0, 300);
}

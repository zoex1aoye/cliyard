import { after, test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createFailureRecord } from "../src/failures.js";
import {
  MAX_HANDOFF_FIXTURE_BYTES,
  runHandoffCli,
  type HandoffDecision,
} from "../src/evaluation/handoff.js";
import { buildEvidenceBundle } from "../src/supervisor/evidence-bundle.js";
import type { RunManifest } from "../src/supervisor/types.js";

const HANDOFF_PATH = fileURLToPath(
  new URL("../src/evaluation/handoff.ts", import.meta.url),
);
// The fresh process runs in an empty cwd, so `--import tsx` would not resolve.
// Point it at the installed loader by absolute path instead.
const TSX_LOADER = fileURLToPath(
  new URL("../node_modules/tsx/dist/loader.mjs", import.meta.url),
);
const CREATED_AT = "2026-10-01T00:00:00.000Z";
const UPDATED_AT = "2026-10-01T01:00:00.000Z";
const OBSERVED_AT = "2026-10-01T00:30:00.000Z";
const BASE_COMMIT = "a".repeat(40);
const RESULT_COMMIT = "b".repeat(40);
const INTEGRATION_HEAD = "c".repeat(40);
const CONTRACTS_HASH = "d".repeat(64);
const cleanupRoots: string[] = [];

after(() => {
  for (const root of cleanupRoots) {
    rmSync(root, { recursive: true, force: true });
  }
});

function tempDir(prefix = "cliyard-handoff-"): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanupRoots.push(dir);
  return dir;
}

function manifestFixture(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    version: 1,
    runId: "run-handoff-1",
    planId: "handoff-v0",
    repoRoot: "/fixture/repo",
    contractsPath: "/fixture/repo/contracts.json",
    contractsHash: CONTRACTS_HASH,
    baseCommit: BASE_COMMIT,
    integrationBranch: "cliyard/integration/handoff-v0",
    integrationHead: INTEGRATION_HEAD,
    status: "completed",
    createdAt: CREATED_AT,
    updatedAt: UPDATED_AT,
    owner: { pid: 4242, host: "fixture-host" },
    tasks: {
      "task-a": {
        taskId: "task-a",
        status: "accepted",
        accepted: true,
        resultCommit: RESULT_COMMIT,
      },
    },
    ...overrides,
  };
}

function blockedManifest(retryable: boolean): Record<string, unknown> {
  return manifestFixture({
    status: "blocked",
    tasks: {
      "task-a": {
        taskId: "task-a",
        status: "rejected",
        accepted: false,
        failure: createFailureRecord({
          timedOut: true,
          stage: "worker",
          text: "worker timed out",
          retryableHint: retryable,
          observedAt: OBSERVED_AT,
        }),
      },
    },
  });
}

function writeFixture(
  dir: string,
  name: string,
  value: unknown,
): string {
  const path = join(dir, name);
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  return path;
}

interface FreshResult {
  status: number | null;
  stdout: string;
  stderr: string;
  cwd: string;
}

/**
 * Start a new process that reads exactly one fixture path. The process cwd is
 * an empty directory that shares no state with the fixture directory.
 */
function runFreshProcess(
  fixturePath: string,
  options: {
    args?: string[];
    env?: NodeJS.ProcessEnv;
  } = {},
): FreshResult {
  const cwd = tempDir("cliyard-handoff-cwd-");
  const result = spawnSync(
    process.execPath,
    [
      "--import",
      TSX_LOADER,
      HANDOFF_PATH,
      ...(options.args ?? [fixturePath, "--json"]),
    ],
    {
      cwd,
      encoding: "utf8",
      timeout: 60_000,
      env: {
        ...process.env,
        CLIYARD_HANDOFF_SECRET: "sk-handoff-secret-marker",
        ...options.env,
      },
    },
  );
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
    cwd,
  };
}

function parseDecision(result: FreshResult): HandoffDecision {
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, "");
  return JSON.parse(result.stdout) as HandoffDecision;
}

function expectFailure(result: FreshResult, pattern: RegExp): void {
  assert.notEqual(result.status, 0, "expected a nonzero exit");
  assert.equal(result.stdout, "");
  assert.match(result.stderr, pattern);
  assert.ok(result.stderr.length < 2_000);
}

// ---------------------------------------------------------------------------
// Fresh-process reconstruction
// ---------------------------------------------------------------------------

test("a fresh process reconstructs human-review from a terminal RunManifest fixture", () => {
  const dir = tempDir();
  const fixture = manifestFixture() as Record<string, unknown>;
  fixture.prompt = "TOP SECRET prompt sk-handoff-secret-marker";
  fixture.environment = { TOKEN: "TOP SECRET token" };
  const task = (fixture.tasks as Record<string, Record<string, unknown>>)[
    "task-a"
  ]!;
  task.prompt = "TOP SECRET task prompt";
  task.transcript = "TOP SECRET transcript";
  const fixturePath = writeFixture(dir, "run-handoff-1.json", fixture);

  const result = runFreshProcess(fixturePath);
  const decision = parseDecision(result);

  assert.equal(decision.version, 1);
  assert.equal(decision.source, "run-manifest");
  assert.equal(decision.runId, "run-handoff-1");
  assert.equal(decision.planId, "handoff-v0");
  assert.equal(decision.status, "completed");
  assert.equal(decision.terminal, true);
  assert.equal(decision.humanReviewRequired, true);
  assert.equal(decision.nextAction, "human-review");
  assert.equal(decision.nextActionMatched, true);
  assert.equal(decision.allowedActions.includes("review-diff"), true);
  assert.match(decision.contextReload, /not claimed/);
  assert.equal(decision.generatedAt, UPDATED_AT);
  assert.deepEqual(decision.repository, {
    baseCommit: BASE_COMMIT,
    integrationBranch: "cliyard/integration/handoff-v0",
    integrationHead: INTEGRATION_HEAD,
    resultCommits: [{ taskId: "task-a", resultCommit: RESULT_COMMIT }],
  });
  assert.deepEqual(decision.taskSummary, {
    total: 1,
    accepted: 1,
    rejected: 0,
    blocked: 0,
    cancelled: 0,
    unresolved: 0,
  });
  assert.equal(
    decision.evidence.manifestPath,
    ".cliyard/runs/run-handoff-1.json",
  );
  assert.match(decision.evidence.manifestHash, /^[0-9a-f]{64}$/);
  assert.ok(decision.missing.includes("task.task-a.cost"));
  assert.equal(
    decision.sourceSha256,
    createHash("sha256").update(readFileSync(fixturePath)).digest("hex"),
  );

  const serialized = result.stdout;
  assert.equal(serialized.includes("TOP SECRET"), false);
  assert.equal(serialized.includes("sk-handoff-secret-marker"), false);
  assert.equal(serialized.includes("CLIYARD_HANDOFF_SECRET"), false);
  // The child process wrote nothing into its only working directory.
  assert.deepEqual(readdirSync(result.cwd), []);
});

test("blocked retryable state resumes while a non-retryable failure needs inspection", () => {
  const dir = tempDir();
  const retryable = runFreshProcess(
    writeFixture(dir, "retryable.json", blockedManifest(true)),
  );
  const retryableDecision = parseDecision(retryable);
  assert.equal(retryableDecision.status, "blocked");
  assert.equal(retryableDecision.nextAction, "resume");
  assert.deepEqual(retryableDecision.allowedActions, [
    "inspect-evidence",
    "resume-run",
  ]);
  assert.equal(retryableDecision.taskSummary.rejected, 1);

  const terminal = runFreshProcess(
    writeFixture(dir, "terminal.json", blockedManifest(false)),
  );
  const terminalDecision = parseDecision(terminal);
  assert.equal(terminalDecision.nextAction, "inspect-failure");
  assert.match(terminalDecision.reason, /non-retryable/);

  const interrupted = runFreshProcess(
    writeFixture(
      dir,
      "interrupted.json",
      manifestFixture({
        runId: "run-handoff-interrupted",
        status: "interrupted",
        tasks: {
          "task-a": {
            taskId: "task-a",
            status: "running",
            accepted: false,
          },
        },
      }),
    ),
  );
  const interruptedDecision = parseDecision(interrupted);
  assert.equal(interruptedDecision.status, "interrupted");
  assert.equal(interruptedDecision.nextAction, "resume");
  assert.deepEqual(interruptedDecision.taskSummary, {
    total: 1,
    accepted: 0,
    rejected: 0,
    blocked: 0,
    cancelled: 0,
    unresolved: 1,
  });
  assert.ok(
    interruptedDecision.missing.includes("task.task-a.terminalStatus"),
  );
});

test("an EvidenceBundle fixture is re-decided instead of trusting nextAction", () => {
  const dir = tempDir();
  const cleanBundle = buildEvidenceBundle(
    manifestFixture() as unknown as RunManifest,
  );
  const lied = JSON.parse(JSON.stringify(cleanBundle)) as Record<string, any>;
  lied.nextAction = "needs-human";
  const liedDecision = parseDecision(
    runFreshProcess(writeFixture(dir, "bundle-lie.json", lied)),
  );
  assert.equal(liedDecision.source, "evidence-bundle");
  assert.equal(liedDecision.nextAction, "human-review");
  assert.equal(liedDecision.nextActionMatched, false);

  const violating = buildEvidenceBundle(
    manifestFixture({
      tasks: {
        "task-a": {
          taskId: "task-a",
          status: "accepted",
          accepted: true,
          resultCommit: RESULT_COMMIT,
          workspaceBoundary: {
            version: 1,
            status: "violation",
            enforcement: "guard-only",
            capturedAt: OBSERVED_AT,
            comparedAt: "2026-10-01T00:31:00.000Z",
            changes: [
              {
                rootIndex: 0,
                change: "modified",
                kind: "file",
                path: "src/outside.ts",
              },
            ],
          },
        },
      },
    }) as unknown as RunManifest,
  );
  const understated = JSON.parse(JSON.stringify(violating)) as Record<
    string,
    any
  >;
  understated.nextAction = "human-review";
  const understatedDecision = parseDecision(
    runFreshProcess(writeFixture(dir, "bundle-violation.json", understated)),
  );
  assert.equal(understatedDecision.nextAction, "needs-human");
  assert.equal(understatedDecision.nextActionMatched, false);
  assert.match(understatedDecision.reason, /workspace-boundary/);
});

// ---------------------------------------------------------------------------
// Fail-closed fixtures
// ---------------------------------------------------------------------------

test("malformed, unsafe and non-terminal fixtures fail closed", () => {
  const dir = tempDir();

  expectFailure(
    runFreshProcess(
      writeFixture(dir, "running.json", manifestFixture({ status: "running" })),
    ),
    /running|terminal/i,
  );

  const malformed = join(dir, "malformed.json");
  writeFileSync(malformed, "{not json", "utf8");
  expectFailure(runFreshProcess(malformed), /not valid JSON/);

  expectFailure(
    runFreshProcess(join(dir, "missing.json")),
    /cannot read/,
  );

  expectFailure(
    runFreshProcess(
      writeFixture(
        dir,
        "unsafe-id.json",
        manifestFixture({ runId: "../escape" }),
      ),
    ),
    /runId|unsafe/,
  );

  const directoryFixture = tempDir();
  expectFailure(
    runFreshProcess(directoryFixture),
    /not a regular file/,
  );

  const oversized = join(dir, "oversized.json");
  writeFileSync(oversized, "{}\n", "utf8");
  truncateSync(oversized, MAX_HANDOFF_FIXTURE_BYTES + 1);
  expectFailure(runFreshProcess(oversized), /exceeds/);

  const bundle = buildEvidenceBundle(
    manifestFixture() as unknown as RunManifest,
  ) as unknown as Record<string, any>;
  bundle.authority.grantsAcceptance = true;
  expectFailure(
    runFreshProcess(writeFixture(dir, "bundle-grants.json", bundle)),
    /grantsAcceptance/,
  );

  // Unknown flags and a missing fixture argument are usage errors, not panic.
  const usage = runFreshProcess("unused", { args: ["--unknown"] });
  assert.equal(usage.status, 2);
  assert.match(usage.stderr, /unknown flag/);
});

test("the handoff CLI help succeeds and a missing argument fails", () => {
  const help: string[] = [];
  assert.equal(runHandoffCli(["--help"], { log: (line) => help.push(line) }), 0);
  assert.match(help.join("\n"), /cliyard eval handoff/);

  const errors: string[] = [];
  assert.equal(
    runHandoffCli([], { logError: (line) => errors.push(line) }),
    2,
  );
  assert.match(errors.join("\n"), /expected exactly one fixture path/);
});

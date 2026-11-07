import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TaskContract } from "../src/contracts/schema.js";
import type { AgentAdapter, AgentResult } from "../src/agents/types.js";
import { runClosedLoop } from "../src/repair/loop.js";
import {
  createFixtureReviewer,
  isCleanReviewEnabled,
  listReviewSessions,
  loadReviewSession,
} from "../src/review/index.js";
import type { Verifier } from "../src/verification/verifier.js";

function contract(base: string): TaskContract {
  return {
    taskId: "review-accept-wire",
    version: 1,
    frozen: true,
    goals: ["ship safe change"],
    dependsOn: [],
    readPaths: ["README.md"],
    writePaths: ["src/"],
    sharedResources: [],
    baseCommit: base,
    verifyCommands: ["true"],
    maxRepairs: 0,
  };
}

function okAgent(): AgentResult {
  return {
    sessionId: "s1",
    exitCode: 0,
    touchedPaths: ["src/ok.txt"],
    logTail: "ok",
  };
}

function okWorker(): AgentAdapter {
  return {
    id: "fixture",
    discover: async () => ({ ok: true }),
    start: async () => ({ sessionId: "s1" }),
    collect: async () => okAgent(),
    cancel: async () => undefined,
  };
}

function okVerifier(): Verifier {
  return {
    run: async () => ({ ok: true, exitCode: 0, logTail: "verified" }),
  };
}

test("isCleanReviewEnabled respects flag and env", () => {
  assert.equal(isCleanReviewEnabled({ enabled: true }), true);
  assert.equal(
    isCleanReviewEnabled({ enabled: false }, { CLIYARD_CLEAN_REVIEW: "1" }),
    false,
  );
  assert.equal(
    isCleanReviewEnabled(undefined, { CLIYARD_CLEAN_REVIEW: "1" }),
    true,
  );
  assert.equal(isCleanReviewEnabled(undefined, {}), false);
});

test("opt-in clean review attaches observation; blocking findings do not flip accept", async () => {
  const repo = mkdtempSync(join(tmpdir(), "cliyard-raw-"));
  try {
    const c = contract("base-commit");
    const result = await runClosedLoop({
      contract: c,
      worker: okWorker(),
      verifier: okVerifier(),
      ledgerPath: join(repo, "ledger.json"),
      review: {
        enabled: true,
        controlRepoRoot: repo,
        worktree: repo,
        baseCommit: "base-commit",
        resolveArtifactCommit: async () => "artifact-commit",
        collectUnifiedDiff: async () =>
          "diff --git a/src/a.ts b/src/a.ts\n+broken\n",
        reviewer: createFixtureReviewer(),
        proposals: [
          {
            id: "f-block",
            requirementRef: "contract:review-accept-wire",
            severity: "blocking",
            problem: "missing check",
            location: { path: "src/a.ts", line: 1 },
            reason: "diff introduces broken without validation",
          },
        ],
      },
    });

    assert.equal(result.verdict, "accepted");
    assert.ok(result.review);
    assert.equal(result.review.findingCount, 1);
    assert.equal(result.review.blockingCount, 1);
    assert.deepEqual(result.review.findingIds, ["f-block"]);

    const sessions = listReviewSessions(repo);
    assert.equal(sessions.length, 1);
    const loaded = loadReviewSession(repo, result.review.reviewId);
    assert.equal(loaded?.findings[0]?.severity, "blocking");
    assert.equal(loaded?.findings[0]?.status, "proposed");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("default-off clean review leaves LoopResult.review undefined", async () => {
  const repo = mkdtempSync(join(tmpdir(), "cliyard-raw-"));
  try {
    writeFileSync(join(repo, "x.txt"), "x\n");
    const result = await runClosedLoop({
      contract: contract("base"),
      worker: okWorker(),
      verifier: okVerifier(),
      ledgerPath: join(repo, "ledger.json"),
    });
    assert.equal(result.verdict, "accepted");
    assert.equal(result.review, undefined);
    assert.equal(listReviewSessions(repo).length, 0);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

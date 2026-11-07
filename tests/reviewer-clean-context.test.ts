import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CleanReviewContextError,
  ReviewFindingError,
  ReviewSessionError,
  buildCleanReviewContext,
  createFixtureReviewer,
  createReviewSession,
  loadReviewSession,
  resolveFinding,
  validateReviewFinding,
} from "../src/review/index.js";

test("buildCleanReviewContext refuses chat / selfAssessment contamination", () => {
  assert.throws(
    () =>
      buildCleanReviewContext({
        artifactCommit: "abc",
        unifiedDiff: "diff --git a/x b/x\n",
        requirementRefs: ["design/x.md"],
        refuseExtras: { chat: "author said it is fine" },
      }),
    (error: unknown) =>
      error instanceof CleanReviewContextError &&
      /contaminated key: chat/.test(error.message),
  );
  assert.throws(
    () =>
      buildCleanReviewContext({
        artifactCommit: "abc",
        unifiedDiff: "diff --git a/x b/x\n",
        requirementRefs: ["design/x.md"],
        refuseExtras: { selfAssessment: "LGTM" },
      }),
    (error: unknown) =>
      error instanceof CleanReviewContextError &&
      /selfAssessment/.test(error.message),
  );
});

test("buildCleanReviewContext hashes canonical payload", () => {
  const a = buildCleanReviewContext({
    artifactCommit: "deadbeef",
    baseCommit: "cafebabe",
    unifiedDiff: "+ok\n",
    requirementRefs: ["req-1"],
    requirementText: "must validate findings",
    evidenceRefs: ["docs/evidence/x.md"],
  });
  const b = buildCleanReviewContext({
    artifactCommit: "deadbeef",
    baseCommit: "cafebabe",
    unifiedDiff: "+ok\n",
    requirementRefs: ["req-1"],
    requirementText: "must validate findings",
    evidenceRefs: ["docs/evidence/x.md"],
  });
  assert.equal(a.contextHash, b.contextHash);
  assert.match(a.contextHash, /^[a-f0-9]{64}$/);
});

test("validateReviewFinding refuses opinions without location or reason", () => {
  assert.throws(
    () =>
      validateReviewFinding({
        id: "f1",
        artifactCommit: "abc",
        requirementRef: "req",
        severity: "nit",
        problem: "style",
        location: { path: "" },
        reason: "because",
      }),
    (e: unknown) => e instanceof ReviewFindingError && /location\.path/.test(String(e)),
  );
  assert.throws(
    () =>
      validateReviewFinding({
        id: "f1",
        artifactCommit: "abc",
        requirementRef: "req",
        severity: "nit",
        problem: "style",
        location: { path: "src/x.ts" },
        reason: "  ",
      }),
    (e: unknown) => e instanceof ReviewFindingError && /reason/.test(String(e)),
  );
});

test("fixture reviewer proposes and resolves findings with audit trail", () => {
  const repo = mkdtempSync(join(tmpdir(), "cliyard-review-"));
  try {
    const context = buildCleanReviewContext({
      artifactCommit: "aaa111",
      unifiedDiff: "diff --git a/src/a.ts b/src/a.ts\n+broken\n",
      requirementRefs: ["design/reviewer-clean-context-v0.md"],
      evidenceRefs: ["docs/evidence/REVIEWER_CLEAN_CONTEXT_V0.md"],
    });
    const session = createReviewSession({
      repoRoot: repo,
      context,
      id: "review-fixture-1",
      now: () => "2026-11-07T12:00:00.000Z",
    });
    assert.equal(session.findings.length, 0);

    const reviewer = createFixtureReviewer();
    const proposed = reviewer.review(repo, session.id, context, [
      {
        id: "finding-1",
        requirementRef: "design/reviewer-clean-context-v0.md",
        severity: "blocking",
        problem: "missing validation",
        location: { path: "src/a.ts", line: 10 },
        reason: "diff introduces broken without a test",
      },
    ]);
    assert.equal(proposed.findings.length, 1);
    assert.equal(proposed.findings[0]!.status, "proposed");

    const confirmed = resolveFinding(repo, session.id, "finding-1", "confirm", {
      note: "human confirmed",
      now: () => "2026-11-07T12:05:00.000Z",
    });
    assert.equal(confirmed.findings[0]!.status, "confirmed");
    assert.equal(confirmed.events.length, 1);
    assert.equal(confirmed.events[0]!.from, "proposed");
    assert.equal(confirmed.events[0]!.to, "confirmed");

    const fixed = resolveFinding(repo, session.id, "finding-1", "fix", {
      now: () => "2026-11-07T12:10:00.000Z",
    });
    assert.equal(fixed.findings[0]!.status, "fixed");
    assert.equal(loadReviewSession(repo, session.id)?.findings[0]!.status, "fixed");

    assert.throws(
      () => resolveFinding(repo, session.id, "finding-1", "confirm"),
      (e: unknown) => e instanceof ReviewSessionError,
    );
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("proposeFindings refuses contextHash mismatch", () => {
  const repo = mkdtempSync(join(tmpdir(), "cliyard-review-"));
  try {
    const context = buildCleanReviewContext({
      artifactCommit: "abc",
      unifiedDiff: "+x\n",
      requirementRefs: ["r"],
    });
    createReviewSession({ repoRoot: repo, context, id: "review-hash" });
    const reviewer = createFixtureReviewer();
    const other = buildCleanReviewContext({
      artifactCommit: "abc",
      unifiedDiff: "+y\n",
      requirementRefs: ["r"],
    });
    assert.notEqual(context.contextHash, other.contextHash);
    assert.throws(
      () =>
        reviewer.review(repo, "review-hash", other, [
          {
            id: "f",
            requirementRef: "r",
            severity: "nit",
            problem: "p",
            location: { path: "a.ts" },
            reason: "r",
          },
        ]),
      (e: unknown) =>
        e instanceof ReviewSessionError && /contextHash mismatch/.test(String(e)),
    );
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

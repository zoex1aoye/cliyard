import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ModelReviewerError,
  buildCleanReviewContext,
  buildModelReviewPrompt,
  createModelReviewer,
  createReviewSession,
  loadReviewSession,
} from "../src/review/index.js";

function freshContext() {
  return buildCleanReviewContext({
    artifactCommit: "aaa111",
    baseCommit: "bbb222",
    unifiedDiff: "diff --git a/src/a.ts b/src/a.ts\n+broken\n",
    requirementRefs: ["req-auth"],
    requirementText: "must validate findings with location and reason",
    evidenceRefs: ["docs/evidence/x.md"],
  });
}

test("buildModelReviewPrompt stays CleanReviewContext-only", () => {
  const context = freshContext();
  const prompt = buildModelReviewPrompt(context);
  assert.match(prompt, /aaa111/);
  assert.match(prompt, /req-auth/);
  assert.match(prompt, /contextHash/);
  assert.doesNotMatch(prompt, /"chat"\s*:/);
  assert.doesNotMatch(prompt, /"selfAssessment"\s*:/);
  assert.doesNotMatch(prompt, /"transcript"\s*:/);
});

test("createModelReviewer persists validated findings from invoker JSON", async () => {
  const repo = mkdtempSync(join(tmpdir(), "cliyard-model-review-"));
  try {
    const context = freshContext();
    const session = createReviewSession({
      repoRoot: repo,
      context,
      id: "rev-model-1",
    });
    const reviewer = createModelReviewer({
      invoke: async ({ prompt }) => {
        assert.match(prompt, /clean-context-reviewer/);
        return JSON.stringify([
          {
            id: "f-block",
            requirementRef: "req-auth",
            severity: "blocking",
            problem: "missing check",
            location: { path: "src/a.ts", line: 1 },
            reason: "diff introduces broken without validation",
          },
        ]);
      },
    });

    const next = await reviewer.review(repo, session.id, context);
    assert.equal(next.findings.length, 1);
    assert.equal(next.findings[0]?.id, "f-block");
    assert.equal(next.findings[0]?.status, "proposed");
    assert.equal(
      loadReviewSession(repo, session.id)?.findings[0]?.severity,
      "blocking",
    );
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("createModelReviewer refuses opinions and contaminated finding keys", async () => {
  const repo = mkdtempSync(join(tmpdir(), "cliyard-model-review-"));
  try {
    const context = freshContext();
    createReviewSession({ repoRoot: repo, context, id: "rev-model-2" });

    const opinion = createModelReviewer({
      invoke: async () =>
        JSON.stringify([
          {
            id: "bad",
            requirementRef: "req-auth",
            severity: "nit",
            problem: "style",
            location: { path: "" },
            reason: "because",
          },
        ]),
    });
    await assert.rejects(
      () => opinion.review(repo, "rev-model-2", context),
      (error: unknown) =>
        error instanceof ModelReviewerError && /location\.path/.test(error.message),
    );

    const contaminated = createModelReviewer({
      invoke: async () =>
        JSON.stringify([
          {
            id: "c1",
            requirementRef: "req-auth",
            severity: "nit",
            problem: "x",
            location: { path: "src/a.ts" },
            reason: "y",
            chat: "author said ok",
          },
        ]),
    });
    await assert.rejects(
      () => contaminated.review(repo, "rev-model-2", context),
      (error: unknown) =>
        error instanceof ModelReviewerError &&
        /contaminated key: chat/.test(error.message),
    );

    assert.equal(loadReviewSession(repo, "rev-model-2")?.findings.length, 0);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("fenced JSON responses parse; empty array is allowed", async () => {
  const repo = mkdtempSync(join(tmpdir(), "cliyard-model-review-"));
  try {
    const context = freshContext();
    createReviewSession({ repoRoot: repo, context, id: "rev-model-3" });
    const reviewer = createModelReviewer({
      invoke: async () => "Here you go:\n```json\n[]\n```\n",
    });
    const next = await reviewer.review(repo, "rev-model-3", context);
    assert.equal(next.findings.length, 0);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

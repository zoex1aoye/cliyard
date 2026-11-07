# Reviewer acceptance-flow wire v0

> After model Reviewer adapter land (`d47f26e` / PR #21). Residual from
> `docs/CURRENT_STATE.md` item 7: attach clean review to the closed loop —
> **opt-in**, observational only.

## Problem

Fixture and model Reviewers exist, but `runClosedLoop` / `codex-batch` never
open a durable review session or attach a bounded observation to
`LoopResult` / RunManifest. Acceptance still has no clean-context review
step on the path.

## Fix (v0)

1. **`ReviewObservation`** — bounded `{ reviewId, contextHash, findingCount,
   blockingCount, findingIds[] }` (no transcripts, no finding bodies in the
   manifest field).
2. **`runAcceptanceReview`** — from worktree + contract: resolve artifact
   commit, collect bounded unified diff vs `baseCommit`, build
   CleanReviewContext (goals as requirementText; refuse chat keys), create
   session, run injected `Reviewer` (default fixture with empty proposals).
3. **Opt-in loop/batch wire** — `LoopOptions.review` /
   `CodexBatchOptions.cleanReview` or `CLIYARD_CLEAN_REVIEW=1`. After
   `verify.ok`, run review **before** recording accepted; findings **never**
   flip the verdict. Thread `LoopResult.review` → RunManifest `task.review`.
4. **Tests + evidence** — enable gate; observation on accept; verdict
   unchanged with blocking fixture finding; CURRENT_STATE/ROADMAP/README.

## Non-goals

- Do not default-on for every production batch.
- Do not let findings accept, reject, or merge.
- Do not call a live provider in default tests.
- Do not replace Verifier / VerificationTask.

# Model-backed Reviewer adapter v0

> After admission queue wire land (`b88889d` / PR #20). Residual from
> `docs/CURRENT_STATE.md` item 7: fixture Reviewer has no model path.

## Problem

`createFixtureReviewer` validates injected findings only. There is no adapter
that turns a **CleanReviewContext** into structured `ReviewFinding`s via a
provider/CLI, while still refusing chat/self-assessment contamination and
never granting acceptance.

## Fix (v0)

1. **`Reviewer` interface** — shared `review(repoRoot, reviewId, context)`
   contract; fixture reviewer remains the deterministic path.
2. **`createModelReviewer`** — builds a secret-free prompt from
   CleanReviewContext fields only (diff, requirement refs/text, evidence
   refs, commits, contextHash). Invokes an injected `ModelReviewInvoker`
   (tests / optional CLI wrapper). Parses a JSON findings array; each entry
   validated with `validateReviewFinding`; opinions fail closed (whole
   response refused if any invalid when `strict`, or skipped with audit when
   `strict=false` — default **strict**).
3. **Persist** — valid findings go through existing `proposeFindings` with
   `expectedContextHash`.
4. **Non-authority** — findings never accept, merge, or rewrite RunManifest.
5. **Tests + evidence** — invoker returns structured JSON; refuses
   chat-shaped invoker payloads; refuses location-less opinions; CURRENT_STATE
   / ROADMAP / README bilingual.

## Non-goals

- Do not wire into the acceptance / closed-loop path yet.
- Do not call a live provider in default tests.
- Do not auto-confirm findings or auto-merge.
- Do not embed API keys, endpoint URLs, or full provider transcripts in the
  durable session.
- Do not replace Verifier / VerificationTask.

# Clean-context Reviewer v0

> After VerificationTask batch wire land (`3d88342` / PR #15). Priority item 7
> in `docs/CURRENT_STATE.md`. Semantics from
> `design/continuous-harness-v2.md` §ReviewFinding.

## Problem

There is no control-plane ReviewFinding model, no clean review context that
excludes author chat / self-assessment, and no durable audit of
proposed → confirmed/rejected/fixed. Acceptance still risks leaking Worker
conversation into “review”.

## Fix (v0)

1. **`ReviewFinding`** — id, artifactCommit, requirementRef, severity
   (`blocking` | `should-fix` | `nit`), problem, location `{ path, line? }`,
   reason, status (`proposed` | `confirmed` | `rejected` | `fixed`), optional
   resolution. Findings missing location or reason are rejected as opinions.
2. **`CleanReviewContext`** — exact unified diff (bounded), approved
   requirement text/refs, bounded evidence refs only. Builder **refuses**
   fields named for chat transcripts, prompts, or author self-assessment.
3. **Durable review session** — `.cliyard/reviews/<reviewId>.json` with atomic
   write; propose findings against a frozen context hash; confirm / reject /
   fix transitions with audited timestamps (no silent status rewrite).
4. **Fixture reviewer** — deterministic `createFixtureReviewer` that emits
   structured findings from injected input (no model call in v0). Production
   model-backed reviewer is a follow-up.
5. **Tests + evidence** — reject chat-tainted context; reject location-less
   findings; status transitions; CURRENT_STATE / ROADMAP update.

## Non-goals

- Do not call a provider/LLM in this slice.
- Do not auto-merge or auto-accept from findings.
- Do not implement human intervention ledger or SkillPack.
- Do not replace Verifier / VerificationTask.

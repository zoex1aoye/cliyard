# Model-backed Reviewer adapter v0 — evidence

> Measured 2026-11-07 (Asia/Shanghai).
>
> Branch: `cursor/reviewer-model-adapter-v0-0da8`.
> Plan: `design/reviewer-model-adapter-v0.plan.json`.
> Accepted integration base: `b88889d` (admission queue wire / PR #20).

## 1. What landed

- Shared `Reviewer` interface; fixture reviewer aligned to it.
- `createModelReviewer` + `buildModelReviewPrompt` — CleanReviewContext-only
  prompt; injectable `ModelReviewInvoker`; strict JSON findings parse;
  `validateReviewFinding` + `proposeFindings`.
- Contaminated finding keys (`chat`, transcripts, …) refused.
- Findings remain non-authoritative (no acceptance / merge).

## 2. Commands

```bash
npm run build   # exit 0
npx tsx --test tests/reviewer-model-adapter.test.ts tests/reviewer-clean-context.test.ts
# → tests 9 / pass 9 / fail 0
```

## 3. Non-claims

- Not wired into acceptance / closed-loop yet.
- Default tests use an injected invoker — no live provider call.
- No auto-confirm / auto-merge; no provider transcript persistence.

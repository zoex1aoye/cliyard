# Reviewer acceptance-flow wire v0 — evidence

> Measured 2026-11-07 (Asia/Shanghai).
>
> Branch: `cursor/reviewer-acceptance-wire-0da8`.
> Plan: `design/reviewer-acceptance-wire-v0.plan.json`.
> Accepted integration base: `d47f26e` (model Reviewer / PR #21).

## 1. What landed

- `ReviewObservation` (bounded ids/counts only) + parse guard on RunManifest.
- `runAcceptanceReview` — CleanReviewContext from worktree diff + contract;
  default fixture Reviewer; injectable reviewer/proposals.
- Opt-in: `LoopOptions.review` / `CodexBatchOptions.cleanReview` /
  `CLIYARD_CLEAN_REVIEW=1` (default off).
- After `verify.ok`, review runs **before** accept; findings **never** flip
  verdict. `LoopResult.review` → `task.review`.

## 2. Commands

```bash
npm run build   # exit 0
npx tsx --test tests/reviewer-acceptance-wire.test.ts \
  tests/reviewer-model-adapter.test.ts tests/reviewer-clean-context.test.ts
# → tests 12 / pass 12 / fail 0
```

## 3. Non-claims

- Clean review remains **opt-in**, not default-on.
- Findings do not accept, reject, or merge.
- No live provider call in default tests.

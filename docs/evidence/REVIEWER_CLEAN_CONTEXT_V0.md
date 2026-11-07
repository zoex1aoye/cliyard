# Clean-context Reviewer v0 — evidence

> Measured 2026-11-07 (Asia/Shanghai).
>
> Branch: `cursor/reviewer-clean-context-v0-0da8`.
> Plan: `design/reviewer-clean-context-v0.plan.json`.
> Accepted integration base: `3d88342` (VT batch wire / PR #15).

## 1. What landed

- `ReviewFinding` model with severity/status enums; opinions without
  `location.path` or `reason` are refused.
- `buildCleanReviewContext` — exact diff + requirements + evidence refs only;
  refuses chat / prompt / selfAssessment contamination keys; durable
  `contextHash`.
- Durable review sessions under `.cliyard/reviews/<id>.json` with audited
  confirm / reject / fix transitions.
- `createFixtureReviewer` — deterministic, **no model/provider call**.

## 2. Commands

```bash
npm run build   # exit 0
npx tsx --test tests/reviewer-clean-context.test.ts
# → tests 5 / pass 5 / fail 0
```

## 3. Non-claims

- No LLM-backed reviewer in this slice.
- Findings never grant acceptance or merge.
- Human intervention ledger and SkillPack remain follow-ups.

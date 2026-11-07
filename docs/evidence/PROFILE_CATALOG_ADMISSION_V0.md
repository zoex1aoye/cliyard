# ProfileCatalog + hierarchical admission v0 — evidence

> Measured 2026-11-07 (Asia/Shanghai).
>
> Branch: `cursor/profile-catalog-admission-v0-0da8`.
> Plan: `design/profile-catalog-admission-v0.plan.json`.
> Accepted integration base: `8e33df3` (SkillPack / PR #18).

## 1. What landed

- Durable `ProfileCatalog` at `.cliyard/profile-catalog.json`
  (`activateProfile` / `listProfiles` / `removeProfile` /
  `setBindingCapacity`).
- Profiles go through `parseExecutionProfile` — URL / secret-like fields
  refused.
- Unknown `configuredMax` ⇒ `effectiveProfilePermit = 1` (probe).
- `admitHierarchical` conjunctive `min()` across scopes; null limits
  skipped and never treated as infinity; explainable `reasons[]`.
- Warm-start `3` is **not** a product constant in this module.

## 2. Commands

```bash
npm run build   # exit 0
npx tsx --test tests/profile-catalog-admission.test.ts
# → tests 4 / pass 4 / fail 0
```

## 3. Non-claims

- No learned 429 auto-scale ramp.
- No queue auto-dispatch from this module.
- No hard-coded provider brand concurrency tables.
- No 24h unattended parallel delivery claim.

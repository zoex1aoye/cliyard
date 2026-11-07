# Execution routing (Routing B) v0 — evidence

> Measured 2026-11-07 (Asia/Shanghai).
>
> Branch: `cursor/execution-routing-v0-0da8`.
> Plan: `design/execution-routing-v0.plan.json`.
> Accepted integration base: `a5d1c47` (acceptance-flow Reviewer / PR #22).

## 1. What landed

- `selectExecutionProfile` over **activated** ProfileCatalog only.
- Capability filter (`mappedProgress` / `providerSessionResume`).
- Preference scoring + stable `profileId` tie-break; explainable
  `reasons[]` / `candidates[]`.
- Optional `respectAdmission` (unknown still allows 1-probe).
- Durable `.cliyard/routing/decisions.jsonl` helper.
- PRODUCT_STRATEGY naming: this is **Routing B**; Routing A deferred.

## 2. Commands

```bash
npm run build   # exit 0
npx tsx --test tests/execution-routing.test.ts \
  tests/profile-catalog-admission.test.ts tests/admission-queue-wire.test.ts
# → tests 11 / pass 11 / fail 0
```

## 3. Non-claims

- No queue auto-dispatch from this module.
- No learned 429 ramp / telemetry scoring.
- No Routing A (design elaborator attribution).
- No brand quota tables; no unbounded parallel claim.

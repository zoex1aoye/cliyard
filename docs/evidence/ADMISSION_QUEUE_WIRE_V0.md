# Admission queue wire v0 — evidence

> Measured 2026-11-07 (Asia/Shanghai).
>
> Branch: `cursor/admission-queue-wire-0da8`.
> Plan: `design/admission-queue-wire-v0.plan.json`.
> Accepted integration base: `1993cc4` (ProfileCatalog / PR #19).

## 1. What landed

- `evaluateQueueAdmission` — activated ProfileCatalog required; unknown
  permit=1; conjunctive scopes from running-item counts + optional
  `globalTaskLimit`.
- Opt-in: `QueueRunOptions.admission.enabled` or `CLIYARD_ADMISSION=1`
  (default off).
- Deny ⇒ `stopped=admission-denied`, candidate stays **pending** (no
  attempt increment); durable `.cliyard/admission/decisions.jsonl`.
- Observation on `QueueRunSummary.admission`.

## 2. Commands

```bash
npm run build   # exit 0
npx tsx --test tests/admission-queue-wire.test.ts tests/profile-catalog-admission.test.ts
# → tests 8 / pass 8 / fail 0
```

## 3. Non-claims

- Admission remains **opt-in**, not default-on.
- No learned 429 ramp; no queue parallelization.
- Warm-start `3` is not a product constant here.
- No 24h unattended delivery claim.

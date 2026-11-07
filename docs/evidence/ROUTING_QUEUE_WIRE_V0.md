# Routing B → queue wire v0 — evidence

> Measured 2026-11-07 (Asia/Shanghai).
>
> Branch: `cursor/routing-queue-wire-0da8`.
> Plan: `design/routing-queue-wire-v0.plan.json`.
> Accepted integration base: `73b7e50` (execution routing / PR #23).

## 1. What landed

- `isQueueRoutingEnabled` — `QueueRoutingOptions.enabled` or
  `CLIYARD_ROUTING=1` / `true` (default off).
- Add-time wire in `resolveExecutionFreeze`: when routing is enabled and no
  `executionProfilePath` is supplied, call `selectExecutionProfile` (preferences
  from worker/model); persist the selected activated profile; append
  `.cliyard/routing/decisions.jsonl`. Fail closed — never invent a legacy
  profile under routing mode.
- Run-time wire in `runQueue`: when routing is enabled, require the item’s
  `executionProfile.profileId` to be activated (optional `respectAdmission`);
  deny ⇒ `stopped=routing-denied`, item stays **pending** (no attempt bump).
- Tests: `tests/routing-queue-wire.test.ts`.

## 2. Commands

```bash
npm run build   # exit 0
npx tsx --test tests/routing-queue-wire.test.ts tests/execution-routing.test.ts
# → tests 7 / pass 7 / fail 0
```

## 3. Non-claims

- Routing remains **opt-in**, not default-on.
- No silent rebind of a supplied profile file at dispatch.
- No Routing A (design attribution).
- No learned 429 ramp; no unbounded parallel / auto-dispatch wave claim.

# Admission queue wire v0

> After ProfileCatalog land (`1993cc4` / PR #19). Residual from
> `docs/CURRENT_STATE.md` item 10: consult hierarchical admission before
> foreground queue dispatch — **opt-in** first.

## Problem

`admitHierarchical` and ProfileCatalog exist, but `runQueue` still dispatches
ready items without consulting activated binding capacity. Unknown provider
bindings are never held to the 1-probe rule at the queue boundary.

## Fix (v0)

1. **`evaluateQueueAdmission`** — pure gate over catalog + queue running
   counts: profile must be activated; unknown `configuredMax` ⇒ permit 1;
   conjunctive scopes for global concurrent items + profile permit; optional
   operator `globalTaskLimit`. Explainable decision; never invent brand quotas.
2. **Opt-in wire** — `QueueRunOptions.admission.enabled` or
   `CLIYARD_ADMISSION=1`. Default off (sequential queue behavior unchanged).
3. **Deny semantics** — stop the invocation with `stopped=admission-denied`,
   leave the candidate **pending** (no attempt increment). Capacity may free
   later; this is not a permanent policy block.
4. **Observation** — durable `.cliyard/admission/decisions.jsonl` (bounded
   reasons); optional fields on `QueueRunSummary`. No new queue-event type
   and no RunManifest rewrite.
5. **Tests + evidence** — enable gate, unknown permit=1, deny leaves pending;
   CURRENT_STATE / ROADMAP / README touch.

## Non-goals

- Do not enable admission by default.
- Do not learn 429 ramps or auto-scale permits.
- Do not parallelize the sequential foreground queue.
- Do not hard-code warm-start `3` as a product constant.
- Do not claim 24h unattended delivery.

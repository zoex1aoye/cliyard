# Routing B → queue wire v0

> After execution routing land (`73b7e50` / PR #23). Residual from
> `docs/CURRENT_STATE.md` item 10: queue wire for router — **opt-in**.

## Problem

`selectExecutionProfile` exists, but `queue add` still falls back to
`createLegacyExecutionProfile` when no profile file is given, and `queue run`
never checks that the item’s profile is activated in the catalog.

## Fix (v0)

1. **`isQueueRoutingEnabled`** — `QueueRoutingOptions.enabled` or
   `CLIYARD_ROUTING=1` (default off).
2. **Add-time wire** — in `resolveExecutionFreeze`, when routing is enabled
   and no `executionProfilePath` is supplied, call `selectExecutionProfile`
   (preferences from `--worker` / `--model`); persist the selected activated
   profile; append `.cliyard/routing/decisions.jsonl`. Fail closed if none
   selected (do not invent a legacy profile).
3. **Run-time wire** — when routing is enabled, before dispatch: require the
   item’s `executionProfile.profileId` to be activated; optionally
   `respectAdmission`. On failure stop with `stopped=routing-denied`, leave
   item **pending** (no attempt increment). Append decision observation.
4. **Tests + evidence** — add without file uses catalog; empty catalog fails;
   run-time deny leaves pending; CURRENT_STATE/ROADMAP/README bilingual.

## Non-goals

- Do not enable routing by default.
- Do not silently rebind a supplied profile file at dispatch.
- Do not implement Routing A (design attribution).
- Do not learn 429 ramps or auto-dispatch parallel waves.

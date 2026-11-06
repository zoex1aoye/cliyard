# Estimate-plan telemetry calibration v0

> Status: Plan approved for freeze (human directed 2026-11-06).

## Problem

`estimate-plan` still maps S/M/L/XL to a static WinUI-era guard table
(`$1/$4/$8/$12`). Self-host evidence shows those guards under-predict real
CLI-estimated spend for control-plane work (L tasks exhausted `$5`/`$10`
guards; several accepted tasks landed between `$5`–`$12`). Operators then
either under-budget attempts or invent ad-hoc envelopes outside the estimator.

Full `task-estimation-v1` (complexity signals, profile keys, live attempt
ingest) remains the target. This slice is the cheap lever: feed the already
documented non-authoritative CLI cost samples into the controller estimator.

## Fix

1. Add a versioned, hand-curated telemetry catalog of documented
   `cli-estimated` USD observations with evidence-path provenance. Samples are
   labeled by the same S/M/L/XL size the heuristic classifier already emits.
2. Calibrate `guardBudgetUsd` per size as
   `ceil_to_cent(P75(samples) * 1.25)` when that size has enough samples
   (`n >= 3`); otherwise keep the static floor and mark confidence `low`.
3. Surface `calibration` metadata on each task estimate and the plan summary:
   `basis`, `sampleSize`, `confidence`, `p75Usd`, `margin`, and whether the
   static floor was used. Never mark CLI samples authoritative. Never invent
   provider balance, quota or invoice totals.
4. Keep size scoring, turns/wall/token heuristic ranges, and public-price CNY
   reference ranges unchanged in this slice.

## Non-goals

- No Plan complexity-signal schema.
- No live ingest from `.cliyard/runs` (catalog is curated from evidence docs).
- No provider-reported pricing or balance claims.
- No automatic admission or budget approval from the estimate.
- No change to CostTruth / RunManifest acceptance authority.

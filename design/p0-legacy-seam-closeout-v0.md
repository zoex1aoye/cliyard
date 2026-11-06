# P0 legacy-seam closeout (authority) v0

> Status: Plan approved for freeze (human directed 2026-11-06).

## Problem

Roadmap G0 / P0 requires: repair attempt cost-truth, merge pilot closeout, then
**declare the freeze list**. Code for those repairs is already reachable from
`codex/supervisor-v0-baseline` (cost-truth resume retention `c5714db`, pilot
foundation integration `fb665ab`, plus later P2b and self-iteration sediment).
What is still wrong is the **authority layer**:

- `docs/CURRENT_STATE.md` still lists pilot-closeout bullets as open work even
  though the implementations and macOS evidence exist on mainline.
- The historical missing first attempt of run `6919db6d` /
  `task-budget-ledger` is documented in narrative but not as an explicit
  StateStore-import constraint, so a future JSON→SQLite import could treat
  `$25.281975` as complete.
- The §7.1 freeze list in `design/delivery-control-plane-v2.md` is not yet
  mirrored into the single status page as an operative rule.
- Open PRs #1–#4 (integration gate, P2b regressions, estimate calibration,
  Linux POSIX hardening) are not yet human-merged; this Plan does not merge
  them.

## Fix

1. Refresh `docs/CURRENT_STATE.md` so priority item 1 reflects implemented /
   evidenced / still-human-gated facts, points at exact commits, and names the
   next executable slice as **P1 StateStore** only after human merge of the
   open stack and DCP v2 review.
2. Add `docs/evidence/COST_TRUTH_HISTORICAL_MISSING.md` that marks run
   `6919db6d-9948-42f4-b5d6-04111f5d0dba` / task `task-budget-ledger` attempt 0
   as `unavailable` / must appear in `missing` on any StateStore import; do not
   rewrite the historical RunManifest.
3. Add `docs/P0_LEGACY_SEAM_FREEZE.md` declaring the operative freeze list
   (JSON stores, foreground Supervisor feature surface, PID-as-authority
   registry, DSH monitor feature surface) effective once a human merges the
   pending stack onto mainline; until then it is the intended freeze, not yet
   binding on unmerged branches.
4. Update `docs/ROADMAP.md` P0 section to “awaiting human merge / freeze
   declaration” rather than “implement repairs”.

## Non-goals

- No automatic merge or push of open PRs.
- No StateStore SQLite implementation (that is P1).
- No RunManifest history rewrite.
- No claim that supervised pilot is ready.
- No DCP v2 approval substitute — human review of
  `design/delivery-control-plane-v2.md` remains required before P1 Plans are
  frozen for dispatch.

# Ledger + event-journal production cutover v0

> Status: Plan approved for freeze (human directed 2026-11-06: merge #7 then
> start next).

## Problem

P1b landed `attachLedgerStateStore` and `attachQueueEventStateStore` with tests
(`a4a0b5e`, measured in `docs/evidence/STATESTORE_WRITE_CUTOVER.md` §8), but no
production entrypoint calls them. `saveLedger` / `appendQueueEvent` still write
`.cliyard/ledger.json` and `.cliyard/queue-events/events.jsonl` directly when
unbound.

## Fix

1. Add a process-scoped control-domain cutover helper that opens the same
   durable store file the queue uses (`.cliyard/state.db` / fallback facts),
   attaches ledger + audit-event domains once per repo, and keeps the store
   open for the process lifetime.
2. Export a sync journal attach that accepts an already-loaded migrate API so
   production paths can attach without the async dynamic-import cycle.
3. Call the ensure helper from `updateLedger` and from queue mutation /
   queue-runner entrypoints before any ledger or journal write, so production
   traffic uses StateStore facts; legacy JSON stays as imported bytes (drift
   fail-closed).
4. Record evidence and note residuals in CURRENT_STATE (no claim that every
   test helper path is cut over).

## Non-goals

- No merge of supervisor run store and queue store into one file.
- No deletion of legacy JSON files.
- No OS sandbox / P3 product work.
- No daemon-owned dispatch.

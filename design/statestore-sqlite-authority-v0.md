# StateStore SQLite authority + status realign v0

> Status: Plan approved for freeze (human directed 2026-11-06: 「开一刀吧」).

## Problem

1. StateStore v0 (`cdde392`), write cutover P1b (`1fd737f`), daemon + Control API
   P2a (`1f4be2d`), and ExecutionSupervisor P2b (`6f9e550`) are already on
   `codex/supervisor-v0-baseline`, but `docs/CURRENT_STATE.md`, `docs/ROADMAP.md`
   and the READMEs still describe P1 StateStore as the next slice.
2. `better-sqlite3` was never declared in `package.json`. Production paths fall
   back to the JSON-file StateStore driver; SQLite tests were skipped. Enabling
   the native driver also exposed a real bug: `createBetterSqlite3Driver` opens
   the DB without creating the parent directory, so a fresh `.cliyard/state.db`
   fails with `Cannot open database because the directory does not exist`.

## Fix

1. Declare `better-sqlite3` as a runtime dependency; mkdir the DB parent before
   open; re-run StateStore focused suites with SQLite exercised; record evidence.
2. Refresh CURRENT_STATE / ROADMAP / README(+zh-CN) so P1/P1b/P2a/P2b are marked
   implemented on mainline, SQLite is the intended durable backend when the
   native module is present, and the next executable slice is named honestly
   (ledger/journal production attach + P3 sandbox/verification prep; DCP v2
   human review remains open).

## Non-goals

- No ledger / event-journal production attach cutover in this slice.
- No launchd backend, Windows Job Object, or OS sandbox.
- No claim that supervised pilot is ready.
- No DCP v2 approval substitute.

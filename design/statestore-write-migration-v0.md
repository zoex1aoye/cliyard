# StateStore Write Migration (P1b) — draft

> Draft 2026-11-04. Not frozen, not dispatched. Cutover strategy and JSON
> retention need design confirmation before freeze.

## Purpose

After P1 read parity, move the write authority from JSON files to the SQLite
StateStore with a single-writer cutover. Git-versioned design/plan/contracts
stay in Git and are untouched.

## Current write authorities

| Domain | Files | Lock |
|---|---|---|
| Run manifest | `.cliyard/runs/<runId>.json`, `.cliyard/runs/active.json` | supervisor file lock |
| Queue | `.cliyard/queue.json` | queue file lock |
| Ledger | `.cliyard/ledger.json` | ledger file lock |
| Audit events | `.cliyard/queue-events/events.jsonl` | append-only |

## Strategy

Single-writer cutover: the SQLite facts log becomes the authority for run,
queue, ledger and event state. On the first run after upgrade, the existing
JSON is imported into the store and verified; afterwards JSON is read-only
legacy and must not be written. File locks are replaced by SQLite transactions
plus the optimistic concurrency the core already provides.

## Open decisions

- Migration trigger and drift handling: if legacy JSON changes after import,
  fail closed with `needs_human` rather than silently preferring either side.
- JSON retention: keep a read-only export for tooling compatibility, or drop
  it after soak evidence. Default: keep as read-only export, never as truth.
- Rollback: keep the JSON path intact until cutover parity and recovery
  evidence exists, then deprecate (do not delete history).

## Risks

- Dual truth during transition: mitigated by read-only JSON after import and
  fail-closed drift detection.
- Durability regression at the moment of cutover: mitigated by importing,
  verifying a hash, then writing SQLite with fsync before any dispatch.

## Non-goals

- No daemon or HTTP server (P2).
- No schema changes to TaskContract or EvidenceBundle.
- No deletion of legacy JSON files or history.

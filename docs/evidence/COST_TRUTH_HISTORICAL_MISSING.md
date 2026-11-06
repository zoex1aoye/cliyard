# Cost Truth: Historical Missing Attempt

> Recorded: 2026-11-06 (Asia/Shanghai).
> Authority: import constraint for any future StateStore / SQLite migration.
> Does **not** rewrite any RunManifest, EvidenceBundle or queue record.

## Scope

| Field | Value |
| --- | --- |
| Run id | `6919db6d-9948-42f4-b5d6-04111f5d0dba` |
| Plan | `pilot-safety-reliability-v1` |
| Task id | `task-budget-ledger` |
| Attempt | `0` (first worker attempt; exit 1) |
| Integration branch | `cliyard/integration/6919db6d-9948-42f4-b5d6-04111f5d0dba` |
| Task merge | `fb665ab` (`task-budget-ledger`) |
| Cost-truth retention merge | `c5714db` (Supervisor resume retention; accepted) |
| Narrative evidence | [PILOT_FOUNDATION_RELIABILITY.md](./PILOT_FOUNDATION_RELIABILITY.md) |

## Fact

The first `task-budget-ledger` worker attempt exited 1 after a provider API
error (`Connection closed mid-response`). The RunManifest retained both
attempts, but the task-level cost aggregate recorded only the second session's
observation. The first attempt has **no cost observation**.

That absence is `unavailable`, not `$0`. Any aggregate that lists only the
second session and claims `missing: []` under-reports the run.

The recorded non-authoritative CLI-estimated run total `$25.281975` therefore
covers only observed sessions. It must not be imported as a complete run cost.

## StateStore import constraint

Before or during any JSON → SQLite / StateStore migration of this run:

1. Do **not** rewrite the historical RunManifest bytes.
2. On import, materialize an explicit missing entry for
   `run=6919db6d-9948-42f4-b5d6-04111f5d0dba` /
   `task=task-budget-ledger` / `attempt=0` with cost state `unavailable`.
3. Keep that attempt in the run-level `missing` set (or equivalent) so
   `missing: []` is false for the imported record.
4. Do not invent an amount, currency or observation for attempt 0.
5. Do not treat `$25.281975` as authoritative or as the full session set.

## Non-claims

- This document does not repair or re-aggregate the historical run.
- Resume retention `c5714db` prevents the same drop on future resumes; it does
  not backfill this closed run.
- No provider balance, invoice or authoritative-cost claim is made here.

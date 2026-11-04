# Cost Truth: Supervisor Resume Retention v0

> Status: Plan only, not frozen and not dispatched.

## Problem

Supervisor resume rebuilds unfinished tasks as `ready` and runs
`delete task.cost` in the reconciliation path (`src/supervisor/cli.ts`, around
the `resume` branch). The abandoned attempt's structured cost observations are
dropped, so the run-level EvidenceBundle under-reports total cost and falsely
claims `missing: []`.

Observed: run `6919db6d-9948-42f4-b5d6-04111f5d0dba`, `task-budget-ledger`
ran two attempts (exit 1 then 0); only the resumed session's observation
survives in the aggregate.

## Fix intent

Retain the abandoned attempt's cost as prior-attempt provenance. On task
completion, merge the abandoned and the new attempt's observations through
`aggregateCostTruth` so every real session appears and any unavailable
abandoned session is listed in `missing`. Never attribute an abandoned
observation to the new attempt's session id.

## Non-goals

- No `CostTruth` schema or authority change.
- No change to the closed-loop (`src/repair/loop.ts`) aggregation, which is
  already correct.
- No provider balance, invoice or authoritative-cost claim.
- No Node version change.

## Acceptance

- A resume fixture shows the interrupted attempt's observation surviving in
  the final task cost and staying separate from the new attempt's observation.
- An unavailable abandoned session appears in `missing`, not silently dropped.
- Focused tests and a full build pass.

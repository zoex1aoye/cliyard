# P2b full-suite regression fix v0

> Status: Plan approved for freeze (human directed 2026-11-06).

## Problem

After the P2b ExecutionSupervisor merge (`6f9e550`), focused task verifies were
green while the integrated tree showed four full-suite failures:

1. **queue.json drift** — `tests/queue-execution-profile.test.ts`
   (`new items always freeze a deterministic profile and legacy records remain
   readable`) hand-edits `.cliyard/queue.json` to simulate a legacy item. After
   the StateStore cutover that file is a derived export; `saveQueue` /
   `assertQueueExportInSync` correctly refuse the drift.
2. **fail-closed RuntimeHandle (×2)** — `tests/supervisor-resume.test.ts`
   (`resume stops an expired fail-closed worker lease…` and
   `resume preserves a durable unit while stopping a legacy fail-closed unit`).
   Fixture leases omit `lease.runtime`. Recovery now treats RuntimeHandle as
   the only authority, so missing runtime is `needs_human` and blocks resume.
3. **deadline batch blocked** — `tests/deadline-extension.test.ts`
   (`batch checkpoint precedes worker completion…`) runs a real Supervisor
   start on a fixture repo without `package.json`. The new integration gate
   defaults on for production paths and fails `npm test`/`npm run build` there,
   flipping `allAccepted` to false even though the task is accepted. Separately
   retain awareness of the older in-flight checkpoint flake; this slice makes
   the gate fixture-safe so the batch assertion is deterministic again.

## Fix

- Seed fail-closed (and shared) fixture leases with a canonical
  `processGroupRuntimeHandle` so recovery has real authority, matching
  production lease writes.
- Rewrite the legacy-profile queue test to append the legacy-shaped document
  through `saveQueue` instead of hand-editing the export.
- When the default integration gate would run and the integration worktree has
  no `package.json`, skip the gate with an explicit skipped record (fixture /
  non-Node trees). Real Node projects keep `npm test` then `npm run build`.

## Non-goals

- No change to RuntimeHandle authority rules for production recovery.
- No weakening of StateStore drift fail-closed behavior.
- No estimate-plan telemetry calibration (next slice).
- No pre-dispatch base preflight (follow-up to integration-suite-gate).

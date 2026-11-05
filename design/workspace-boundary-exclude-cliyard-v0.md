# Workspace boundary excludes .cliyard control state v0

> Status: Plan only, not frozen and not dispatched.

## Problem

Test suites create ledger fixtures such as `.cliyard/ledger-master-test.json`,
but `DEFAULT_EXCLUDED_CONTROL_PATHS` lists only `.cliyard/ledger.json` plus a
few `.cliyard/*` subdirectories. Those other mutable control-plane files are
reported as protected-root changes and block tasks. Observed on run
`4809f45a-59ba-4058-9a4f-08b2533606b8` for both `runtime-handle-authority` and
`continuity-policy`.

## Fix

Exclude the `.cliyard` directory as a whole from the default boundary
protections: it is control-plane mutable state, not protected source. Source
roots (`src`, `design`, `docs`, `plugins`, `tests`, `examples`, `package.json`)
remain protected.

## Non-goals

- No weakening of source/design/evidence protection.
- No change to write-path auditing or evidence hashes.

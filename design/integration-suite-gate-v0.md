# Integration full-suite gate v0

> Status: Plan only, not frozen and not dispatched.

## Problem

A run is reported `allAccepted` as soon as every task passes its focused
verifyCommands. Cross-task regressions only appear when the complete suite runs
on the integrated tree, which today happens after merge. Observed on the P2b
merge: three focused-passing tasks produced four full-suite failures
(queue JSON drift, fail-closed runtime-handle gaps, plus the deadline flake).

## Fix

Add a deterministic integration gate: after all tasks are accepted and merged
into the integration worktree, run the complete test suite and build on that
worktree before finalizing. A failing gate command must:

- set the run status to `blocked` (never `completed`/`allAccepted`);
- record a structured gate failure (commands, exit code, log tail);
- leave the accepted task verdicts untouched;
- require human review.

The gate is a bounded shell command, never routed through a model. The
per-task focused verifyCommands stay unchanged. A pre-dispatch preflight
(build + full suite on the base before dispatch) is a follow-up, not this slice.

## Non-goals

- No model involvement in the gate.
- No change to per-task focused verification.
- No change to accepted-task verdicts on gate failure.

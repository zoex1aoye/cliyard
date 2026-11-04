# Process-tree identity-reuse classification v0

> Status: Plan only, not frozen and not dispatched.

## Problem

Nested process-group cleanup treats an external group whose leader identity has
changed or been reused as `residualGroups=1` / `cleanupCompleteness=incomplete`,
which rejects the whole task. Observed on run
`b86cf3e0-1922-4513-a80c-f1f32e8cb7bc`: group 22198 was classified as a worker
descendant, but at cleanup time its leader identity resolved to an unrelated
macOS WebKit `WebContent.xpc` process (pid reuse). The exact-identity guard
correctly refused to signal, but the refusal was then counted as a leak even
though `residualCount=0`.

## Fix intent

When a tracked group's leader identity has changed or been reused, classify it
as **vanished/reused evidence**, not as a residual failure. The safety
invariant does not change: never signal an unverified group, and never do a
broad or name-based kill.

Before classifying as vanished, check the remaining rows. If any remaining row
still matches a sampled worker-descendant identity, the outcome stays
`needs_human` (never auto-accept). The existing "leader absent while members
remain" fail-closed branch stays unchanged.

## Non-goals

- No signal to an identity-reused group.
- No weakening of `compareProcessIdentity` or the exact-identity guard.
- No change to the worker-lease recovery path.
- No broad/name-based kill.

## Acceptance

- A pid-reuse fixture (leader `startedAt` changed, rows present) proves no
  signal is sent and the outcome is vanished evidence, not residual.
- A remaining-descendant match in the same fixture still yields `needs_human`.
- The existing absent-leader fail-closed behavior still passes.

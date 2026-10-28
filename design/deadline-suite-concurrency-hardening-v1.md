# Deadline Suite Concurrency Hardening v1

> Recorded: 2026-10-28
>
> Status: blocker found after merging the first in-flight fixture repair with
> the unified adoption journal

## Problem

Two full-suite runs on the combined integration exposed different
deadline-extension failures:

```text
collect waits for an in-flight grant checkpoint past child exit
a rejected persistence callback denies the grant
```

Each test passes in isolation, and fixes to one have not made repeated full
suite runs stable. The common issue is test fixtures that depend on exact
child startup and event-loop arrival times relative to policy deadlines.

## Decision

Audit the entire `tests/deadline-extension.test.ts` file as one set. Tests that
intentionally exercise successful extension should use observable readiness,
continuous mapped activity, markers, or explicit child process state instead
of assuming that one startup assistant record remains fresh after a fixed
delay.

The diagnostic timeout may be generous. The policy timer under test must not
be lengthened merely to hide a fixture race.

## Tests that require special scrutiny

- healthy mapped activity and extension persistence;
- result after the extended deadline still loses;
- max extensions and cumulative timeout bounds;
- timer re-arm after asynchronous persistence;
- callback rejection denies the grant;
- collect waits for in-flight persistence after child exit;
- default-off policy;
- supervisor checkpoint integration.

## Acceptance

1. Every successful-extension fixture provides fresh mapped progress until its
   intended callback signal.
2. Failure cases continue to prove timeout or denial, not a missing fixture
   event.
3. No test is skipped or made todo.
4. The deadline file passes repeatedly under concurrent local load.
5. The full suite passes three consecutive times on one HEAD.
6. No production deadline semantics or adoption/journal behavior changes
   unless a deterministic production race proves the need.

## Non-goals

- no WorkerLease or owner-death work;
- no timeout policy change;
- no journal behavior change;
- no daemon or soak framework;
- no removal of late-result or callback-rejection coverage.

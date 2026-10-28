# Deadline In-flight Grant Stability v1

> Recorded: 2026-10-28
>
> Status: blocker found during independent review of the adoption-journal slice

## Observed failure

The full `npm test` suite under normal local concurrency failed once with:

```text
collect waits for an in-flight grant checkpoint past child exit
```

The same focused test passed in isolation. The test currently waits up to two
seconds for the extension callback to start after process spawn:

```text
fixture result target: ~900ms after child script starts
base deadline:         600ms
callback wait:        2,000ms
```

Under full-suite load, Node process startup and event-loop scheduling can move
the observable callback past that wait window even when the production
deadline/persistence mechanism is functioning.

## Decision

Do not merge a red full-suite result. Stabilize the test by synchronizing on
observable state or an explicit marker rather than assuming child startup and
callback latency fit a fixed wall-clock window.

The test must continue to prove:

1. deadline evaluation starts the grant callback;
2. the child can exit while the asynchronous grant persistence is pending;
3. `collect()` remains unresolved until the grant is persisted;
4. the persisted one-generation extension moves the deadline to the expected
   cumulative value;
5. releasing persistence permits the successful result and extension evidence;
6. a result after the active deadline still loses to timeout.

## Implementation rule

First determine whether the failure is test-only timing or a real production
race. Prefer event-driven fixture readiness and separately generous deadlines.
Change `src/agents/claude.ts` only if a deterministic failing test proves a
production state-machine race.

## Non-goals

- no skipped or removed test;
- no weakened timeout semantics;
- no longer arbitrary production sleeps;
- no journal/adoption behavior changes;
- no WorkerLease/profile/admission work.

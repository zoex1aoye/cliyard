# Nested registry and live cleanup boundary v1.2

> Status: Plan only; not dispatched.
>
> Reviewed implementation base:
> `a9d6e0072703bd805d7eb33b629f0f9337337cb3`.

## Observed third failure

Cutover run `d4c96416-51b8-48b5-9f26-f1119f90784e` started Supervisor from the
reviewed v1.1 draft itself and completed a documentation-only task with:

- focused 62/62;
- build pass;
- complete suite 461/461 in 25.999 seconds;
- only the four allowed documentation paths changed;
- WorkspaceBoundary clean.

It was still rejected with:

```text
process_tree_cleanup_failed
descendant snapshot exceeded a bounded nested registry limit
residualCount=0
signalledGroups=0
```

The live lease contained 16 persisted groups, including one real 513-member
group, plus truncated fallback evidence. The process tree existed while the
Worker test/tool activity was active, but no residual process group remained
after the run.

## Root cause

The reviewed v1.1 implementation conflates two different questions:

1. **Can this live controller enumerate and clean the currently reachable
   process tree safely?**
2. **Can a future controller reconstruct complete ownership after this
   controller dies, using only the bounded lease?**

The durable registry must be bounded because the lease must remain small.
Live process-table inspection is allowed to see more entries than the lease can
persist. A truncated durable registry therefore means "controller-death
recovery is incomplete", not automatically "the current live cleanup failed".

## Goal

Separate cleanup completeness from durable recovery completeness.

### Live cleanup

- Use the current validated process-table snapshot, bounded by the existing
  8,192-row table cap.
- Enumerate all currently reachable external process groups for cleanup,
  independently of the 16-group persistence cap.
- Prefer guarded negative-pgid cleanup for each group with a fresh exact
  `pid === pgid` leader.
- Keep exact-pid fallback for ungrouped descendants under its existing signal
  bound.
- Re-read membership before and after signals.
- Mark cleanup failed only for incomplete current inspection, an unsafe group,
  an over-bound ungrouped live target set, or residual exact processes.
- A bounded/truncated **persisted** registry alone must not fail a cleanup that
  proves all currently reachable groups gone.

### Controller-death recovery

- Preserve fail-closed behavior for a truncated durable registry.
- Never infer ownership from a pgid alone after controller death.
- Require exact persisted group leader identity and fresh membership guards.
- Report `needs_human` when the persisted set cannot prove completeness.

## Evidence model

Add separate fields or states equivalent to:

```text
cleanupCompleteness: complete | incomplete | unsupported
durableRecoveryCompleteness: complete | truncated
```

Or preserve the existing record shape with equally explicit bounded fields.
The exact naming may follow existing storage conventions, but the two meanings
must not collapse into one `cleanupState`.

Required examples:

- live cleanup sees 40 external groups, kills all exact groups, persists only
  16: cleanup complete, durable recovery truncated;
- live cleanup sees an ungrouped live target set above its signal bound:
  cleanup incomplete/failed;
- controller restarts with the truncated 40-group lease: `needs_human`, no
  signal;
- a persisted group leader is reused: no signal.

## Required tests

1. A real live Worker tree with more than 16 external groups and a 512-member
   group cleans successfully; only the bounded registry is truncated.
2. Durable recovery from the resulting truncated lease is `needs_human` and
   sends no signal.
3. A high-fan-out run with zero residual processes does not get rejected only
   because its bounded lease is truncated.
4. Incomplete live process-table inspection still fails closed.
5. Reused leader identity and unsafe/self group guards remain unchanged.
6. Existing exact-pid fallback, parser, status, lease and Supervisor tests
   remain green.

## Non-goals

- No unbounded lease.
- No unbounded process-table scan.
- No signal without fresh process-group ownership proof.
- No Windows or cross-host recovery.
- No verifier timeout change.
- No OS write sandbox.
- No automatic acceptance or merge.

## Next-run provenance

The implementation should start from reviewed v1.1 draft `a9d6e00`. Its code
already provides exact nested group ownership but still confuses live cleanup
with durable-registry completeness. A subsequent validation run should load
Supervisor from the new reviewed v1.2 draft if the outer manager itself needs
to be exercised.

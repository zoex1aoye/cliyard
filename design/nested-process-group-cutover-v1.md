# Nested process-group cutover evidence v1

> Status: Plan only.
>
> Reviewed cutover base:
> `a9d6e00` on
> `cliyard/mvsbxg7y-nested-process-group-compaction-core`.

## Context

Two self-host attempts produced valid reviewed drafts but were rejected by the
old process-tree manager loaded from accepted code:

1. `0c199514-b24e-4f7a-a855-f2b8eb4484b4` implemented exact nested identities;
2. `e2e4825c-a9d7-4b0b-9cb1-e8c25ad075c5` implemented nested group compaction.

Both drafts passed independent focused tests, build and complete suite. Both
runs failed because the external controller still used the accepted
`9a38174` manager and hit the 256 related-process limit while the Worker ran a
legitimate high-fan-out test suite.

The second reviewed draft now contains:

- exact nested group leaders;
- guarded nested negative-pgid cleanup;
- controller-death recovery of persisted groups;
- real live and controller-death tests with 512 members;
- focused 62/62, build pass, complete 461/461 in 25.89 seconds.

## Cutover goal

Use the reviewed draft itself as the Supervisor code for one documentation-only
run. This is the first execution that can validate the new outer process-tree
manager in a real Worker lifecycle.

The run must:

- start from reviewed draft `a9d6e00`;
- load Supervisor/Worker process ownership from that reviewed draft;
- target the main checkout;
- retain a clean WorkspaceBoundary record;
- run focused tests, build and complete suite;
- complete without `descendant snapshot exceeds 256 related processes`;
- produce a RunManifest process-tree record with nested group evidence;
- leave no active worker/runtime process or lease.

## Documentation task

The task may modify only documentation:

- add `docs/evidence/NESTED_PROCESS_GROUP_OWNERSHIP.md`;
- update `design/worker-process-tree-v1.md`;
- update `README.md`;
- update `docs/NEXT_STEP_CONTROLLER.md`.

It must record only measured facts, exact commands and remaining limits. It
must not claim:

- Windows or cross-host ownership;
- recovery of descendants never observed before controller death;
- OS filesystem write prevention;
- a fix to the separate verifier command timeout margin;
- acceptance simply because a reviewed draft was used as orchestrator.

## Why this is necessary

The code-under-change cannot make the process that launches it use itself.
Without a separate cutover run from a reviewed draft, every high-fan-out
implementation run remains exposed to the old manager and can be rejected
even when the new implementation is correct.

This run is still not an automatic merge. Manual review remains required after
the evidence is produced.

# Nested process-group ownership v1.1

> Status: Plan only.
>
> Reviewed draft base:
> `af76d3a33793a8b9c2d6f5a1009c7f899c3dc74c`.
>
> Original accepted code base:
> `9a38174a872d70b7a250225c31fa7ce4efdcf06e`.

## Observed failure

The first self-host run,
`0c199514-b24e-4f7a-a855-f2b8eb4484b4`, produced a controller-death nested
process implementation and passed independent tests:

- focused worker/process tree tests: 56/56;
- build: pass;
- complete suite: 455/455 in 26.08 seconds;
- no changed path outside the four frozen write paths;
- WorkspaceBoundary: clean;
- no test process groups remained after the run.

The task was nevertheless rejected because its process-tree cleanup hit the
existing `MAX_SAMPLED_DESCENDANTS=256` bound while the worker's legitimate test
runner had a large nested process group. The run therefore failed closed:

```text
process_tree_cleanup_failed
descendant snapshot exceeds 256 related processes
residualCount=0
```

The 2,274-line reviewed draft is preserved at `af76d3a`; it is not accepted.

The first independent verifier also timed out on `npm test` at its fixed 30
second command limit. The same suite then passed in 26.08 seconds. That is a
separate verifier timeout-margin gap, not evidence that the tests are invalid.

## Why a larger PID cap is not enough

The exact-pid design remains useful for ungrouped descendants, but treating
every member of a large nested process group as an independent recovery target:

- exhausts bounded snapshots under legitimate test fan-out;
- makes recovery truncate even when one exact group leader proves ownership;
- cannot guarantee enough signal slots for a high-fan-out build/test runner.

Raising 256 to another arbitrary number only moves the cliff.

## Goal

Represent descendants outside the managed worker group at two levels:

1. a bounded registry of external process groups with exact group-leader
   identities;
2. a bounded exact-pid fallback set for descendants that do not have a
   provable group leader.

Normal cleanup and controller-death recovery may signal an external group only
after the same exact-leader and group-membership safety checks used for the
top-level worker group.

## Durable shape

Extend the reviewed draft's `WorkerNestedProcesses` evidence
backward-compatibly:

```ts
interface WorkerNestedGroup {
  pgid: number;
  leader: RuntimeProcessIdentity; // pid === pgid
  observedMemberCount: number;
  lastObservedAt: string;
}

interface WorkerNestedProcesses {
  version: 1;
  host: string;
  observedCount: number;
  truncated: boolean;
  lastObservedAt: string;
  groups: WorkerNestedGroup[];        // max 16
  identities: RuntimeProcessIdentity[]; // ungrouped fallback, max 32
}
```

Rules:

- `leader.pid === leader.pgid`.
- A group entry is not authority until the exact leader identity is captured.
- Members of a known group do not consume the 32 exact-pid fallback slots.
- A group can have an observed member count above the persistence bound because
  recovery obtains fresh membership from the OS and signals the group as a unit.
- Missing `groups` keeps the reviewed draft and legacy leases readable.
- Malformed groups, duplicate pgids, a leader that is not `pid === pgid`, or a
  group whose host differs from the lease host fail closed.

## Sampling

The descendant sampler continues to walk only a process table rooted at the
exact top-level worker identity.

For each descendant outside the managed worker group:

- if its pid equals its pgid, record the exact leader identity;
- otherwise, attach its pgid to a bounded observed-group set;
- a group receives a leader only when the leader row itself is observed;
- a group without a leader remains unresolved and cannot authorize a group
  signal;
- ungrouped external pids remain exact-pid fallback candidates;
- the walk is bounded by the process-table row cap, but a large number of
  members in one owned group does not by itself make the registry truncated.

The existing observer still replays the latest bounded snapshot and never
signals.

## Cleanup while the controller is alive

Before signalling:

1. take a fresh validated process-table snapshot;
2. merge exact group-leader observations;
3. stop the sampler;
4. persist the refreshed group/fallback registry before any signal.

For every external group:

1. capture the group leader by pid;
2. require exact `pid + pgid + lstart` equality, with `pid === pgid`;
3. list current group members;
4. require every member to report the same pgid;
5. refuse cliyard's own pid/group and any group containing the recovery process;
6. send `SIGTERM` to the negative pgid, then `SIGKILL` after the bounded grace
   only if the same guard still holds;
7. verify no exact member remains.

Groups with no exact leader use the reviewed draft's exact-pid fallback. More
than 32 fallback targets, more than 16 groups, malformed membership, or an
uninspectable group fails closed.

The process-tree record adds a `nested-process-group` signal scope and bounded
group counts. A group signal is not represented as N descendant-pid signals.

## Controller-death recovery

The reviewed draft's controller-death path is extended:

1. a persisted external group with matching exact leader identity is eligible
   for a guarded negative-pgid signal;
2. an external group whose leader is absent but whose members remain cannot use
   an unproven group signal; only complete exact-pid fallback evidence may be
   used, otherwise `needs_human`;
3. a reused pgid/leader pid with a different `lstart` is never signalled;
4. nested group signals are persisted before they are sent;
5. the lease becomes `released` only after all observed groups and fallback
   pids are proven gone.

## Required tests

1. A real detached nested group with 512 members is represented by one exact
   group leader and cleaned through one bounded group path, without a 256-PID
   truncation failure.
2. The same group is recovered after controller death from durable lease
   evidence.
3. A reused group-leader pid with a different `lstart` is untouched.
4. A group leader that exited while members remain does not authorize a group
   signal; an incomplete fallback stays `needs_human`.
5. Mixed group and ungrouped descendants are cleaned with the correct signal
   scopes.
6. Existing exact-pid, normal cleanup, parser, lease and Supervisor tests remain
   green.
7. The focused process/lease files, build and complete suite pass.

## Non-goals

- No Windows Job Objects or cross-host recovery.
- No process-name matching, port matching or broad scan.
- No signal to a nested group without a fresh exact leader/member guard.
- No OS write sandbox.
- No automatic resume or RunManifest rewrite.
- No attempt to change the verifier's 30 second command timeout in this task;
  that remains a separate P1 follow-up.

## Self-host provenance

The implementation run starts from reviewed draft `af76d3a`, which already
contains the rejected exact-pid implementation, while the control CLI is
loaded from accepted `9a38174`. The reviewed draft is task history, not an
accepted integration. The new run must preserve the existing draft and must not
rewrite the blocked RunManifest.

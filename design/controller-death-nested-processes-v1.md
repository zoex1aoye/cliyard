# Controller-death nested process ownership v1

> Status: Plan only; no implementation is claimed.
>
> Accepted source base:
> `9a38174a872d70b7a250225c31fa7ce4efdcf06e`.
>
> Target checkout: the main cliyard checkout.

## Problem

WorkerProcessTree v1.1 discovers descendants that leave the worker's dedicated
POSIX process group while the cliyard controller is alive. It cleans those
descendants by exact pid and records bounded nested evidence.

That evidence currently exists only in controller memory until the worker
cleanup completes. WorkerLease persists the top-level worker
`pid`/`pgid`/`lstart`, but not the nested descendant identities. If the
controller is killed before cleanup:

- the top-level worker group can be recovered by the existing lease;
- a descendant that created its own group/session cannot be recovered;
- if the top-level leader is already gone, current recovery returns
  `needs_human` even when a previously observed nested identity is still alive.

This is the remaining P0 process-ownership gap. It is not the same problem as
OS write prevention or cross-host cleanup.

## Goal

Persist a bounded, exact nested-descendant registry while the controller is
alive, then use that registry after controller death to recover only processes
whose complete `pid + pgid + OS start identity` still match.

The recovery must remain safe when:

- the top-level worker leader has exited;
- the controller is dead;
- a pid was reused;
- the registry is incomplete or truncated;
- the recovery process itself or cliyard's own group is encountered.

## Non-goals

- No OS write sandbox or credential/network isolation.
- No Windows Job Object parity.
- No cross-host recovery.
- No process-name matching, broad `ps` scan, `pkill`, or port-based kill.
- No daemon, automatic resume, stdout reattachment or RunManifest rewrite.
- No claim that a nested child is recoverable when it was never observed and
  persisted before controller death.
- No change to TaskContract acceptance semantics.

## Durable nested registry

WorkerLease remains backward-compatible version 1. Add one optional,
all-or-nothing field:

```ts
interface WorkerLeaseNestedProcesses {
  version: 1;
  host: string;
  observedCount: number;
  truncated: boolean;
  lastObservedAt: string;
  identities: RuntimeProcessIdentity[];
}

interface WorkerLease {
  // existing fields remain immutable
  nestedProcesses?: WorkerLeaseNestedProcesses;
}
```

Rules:

- `identities` is deduplicated by pid and bounded to 32.
- `observedCount` may be larger than the persisted list.
- Once more than 32 exact descendant identities are observed, `truncated` is
  true and the registry is evidence only; it does not authorize recovery.
- Missing `nestedProcesses` preserves old lease behavior.
- A malformed, partial or host-mismatched registry fails the lease parser
  closed.
- No command line, prompt, environment, provider output or secret is stored.

## Live sampling to lease

The managed worker process exposes a bounded observer for exact
external-descendant snapshots. The observer:

- is fed only by validated process-table snapshots rooted at the exact worker
  identity;
- emits changed snapshots after the existing 250 ms-or-slower sampler;
- immediately replays the current snapshot to a new subscriber;
- contains exact identities, count/truncation state and observation time;
- never performs a kill.

The WorkerLease attacher subscribes only after the immutable controller/worker
identity is durably written. Changes are persisted atomically with mode `0600`
and serialized so older snapshots cannot overwrite newer observations.

Persistence failure is not silently ignored. It must make the lease handle
unhealthy; the adapter/scheduler must stop or reject the invocation rather than
accept a worker whose nested ownership was not durable.

The final process cleanup may enrich evidence with the already accepted
process-tree record, but it must not fabricate identities or overwrite the
durable registry with an empty snapshot.

## Controller-death recovery

Recovery applies only on the same host and only after the exact controller
identity is proven dead.

For a lease with `nestedProcesses`:

1. Reject `truncated` or structurally incomplete registries with
   `needs_human`; send no signal.
2. If the top-level worker leader is still present, require its exact identity
   before refreshing descendants or signalling its dedicated group.
3. If the top-level leader is absent, continue through the durable nested
   registry rather than immediately failing. The absent leader never
   authorizes a negative-pgid signal.
4. Before terminating a live top-level group, take a bounded fresh
   process-table snapshot rooted at its exact leader and merge newly observed
   descendants. This preserves parent relationships before signal-driven
   reparenting.
5. For every persisted nested identity, fresh-capture the pid:
   - exact match: eligible as a recovery root;
   - absence: the recorded process is gone;
   - mismatch: the original process is gone and the reused pid is unrelated,
     so it is never signalled.
6. Recursively extend each matching nested root through the bounded process
   table snapshot. Every newly discovered pid must retain an exact identity.
7. Any snapshot error, malformed row, incomplete graph or over-bound target set
   fails the recovery closed before any signal.
8. Persist the refreshed exact target set to the lease before signalling. If
   that checkpoint cannot be persisted, preserve all processes.
9. Clean the verified top-level group with the existing guarded group path when
   its exact leader is present.
10. Send `SIGTERM` to nested targets by exact pid only. After the bounded grace,
    re-read each identity and escalate only exact matches to `SIGKILL`.
11. Re-read all targets after the final grace. A still-matching live target is
    residual and prevents `released`.

The lease becomes `released` only when all observed/reachable targets are
proven gone. The recovery report includes exact signal scopes, refreshed
observed count, truncation state and `resumeNeeded`.

## Status and evidence

Read-only WorkerLease status exposes:

- whether a nested registry exists;
- observed count and persisted identity count;
- truncation state;
- latest observation timestamp;
- current exact-live / gone / reused counts when inspection is available.

Status remains advisory and must not mutate the lease or RunManifest.

## Required acceptance matrix

### Core invariants

1. Legacy version-1 leases without nested evidence still parse and recover as
   before.
2. A subscriber receives the current bounded external descendant snapshot and
   later changed snapshots.
3. The lease persist path remains atomic, `0600`, secret-free and backward
   compatible.
4. A write failure after subscription stops/rejects the invocation.
5. Truncated or malformed nested evidence yields `needs_human` with no signal.

### Real POSIX scenarios

1. A controller creates a worker; the worker creates a detached nested helper;
   the lease persists the helper identity before the controller is SIGKILLed.
2. A new recovery process proves the controller dead, the top-level leader
   absent, revalidates the nested helper identity and terminates only that
   exact helper.
3. A top-level group and nested helper are both cleaned without broad scans.
4. A reused nested pid with a different OS start identity is untouched.
5. Recovery failure leaves the lease non-released and preserves evidence.

### Regression

- Existing process-tree, worker-lease and Supervisor focused suites pass.
- `npm run build` passes.
- The complete test suite passes at the exact accepted integration head.

## Self-host provenance

The implementation run is controlled by cliyard loaded from accepted
integration `9a38174`, while targeting the main checkout. The code added by
this Plan cannot be used by the same run; it becomes available only after
manual review and merge. The run must still produce a non-null
WorkspaceBoundary record because accepted `c04bb96` is an ancestor of
`9a38174`.

The current main checkout contains newer governance documents that are not
ancestors of `9a38174`. This is recorded as a separate provenance gap. It does
not change the code base for this run, but it must be considered during manual
integration.

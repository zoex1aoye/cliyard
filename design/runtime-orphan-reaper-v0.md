# Runtime Orphan Reaper v0 Design

> Revision: runtime-orphan-reaper-v0
>
> Scope: single host, local repository, RuntimeManager-created service groups

## Problem

RuntimeManager normally stops services in `finally` and signal handlers.
`SIGKILL`, host death, or a crash before cleanup can leave:

- a detached service process group still listening on its leased port;
- a stale port lease whose owner process is gone;
- a RuntimeManifest stuck at `cleanup: pending` or `running`.

Simply deleting a stale lease is unsafe because it can hide a live orphan.
Simply killing every process group mentioned by JSON is also unsafe because of
PID reuse and tampered/stale manifests.

## Safety rule

> Reclaim only what can be proven to belong to this runtime; otherwise retain
> the evidence and report `needs_human`.

A runtime is eligible for reconciliation only when all of these hold:

1. the manifest host equals the current host;
2. the recorded owner process is no longer alive;
3. the manifest is not already `cleanup: complete`;
4. every unfinished service has an exact matching port lease;
5. service `pid` equals recorded `pgid`;
6. the service leader still exists and its exact persisted process identity
   (`pid`, `pgid`, OS start identity) matches the manifest;
7. no other live runtime manifest references the same service group or port.

If the leader is already gone but the group still has members, ownership cannot
be proven from the leader identity. V0 must report `needs_human` and leave the
group/lease untouched.

## Persisted identity

RuntimeManifest adds:

```ts
interface RuntimeProcessIdentity {
  pid: number;
  pgid: number;
  /** Stable OS-reported process start identity, not merely wall-clock now(). */
  startedAt: string;
}

interface RuntimeOwner {
  pid: number;
  host: string;
}
```

The manifest root records `owner`.

Each service records:

```ts
{
  pid?: number;
  pgid?: number;
  processIdentity?: RuntimeProcessIdentity;
}
```

The identity is captured from `ps -p <pid> -o pgid=,lstart=` immediately after
spawn. It is not inferred from the time RuntimeManager happened to persist JSON.

## Reaper API

Safety planning and process mutation are separate modules:

- `src/runtime/reaper.ts`: read-only manifest/lease/process preflight and safe
  candidate classification;
- `src/runtime/reaper-execute.ts`: executes only preflight-approved plans.

```ts
reapOrphanedRuntimes(repoRoot, options?): Promise<RuntimeReapReport>
```

The preflight result for one runtime is one of:

- `safe_to_reap`: every unfinished service passed exact correlation;
- `needs_human`: at least one identity/correlation/prerequisite is uncertain;
- `skip`: completed, already reconciled, or foreign-host with no local action.

The preflight module never sends signals, releases leases, or mutates manifests.

Report shape:

```ts
interface RuntimeReapReport {
  scanned: number;
  reaped: RuntimeRecoveryRecord[];
  needsHuman: RuntimeRecoveryRecord[];
  skipped: RuntimeRecoveryRecord[];
}
```

Record states:

- `reaped`: process group stopped, port confirmed free, exact lease released,
  manifest finalized with recovery evidence;
- `needs_human`: identity/correlation incomplete or unsafe;
- `skipped`: not orphaned, complete, or foreign host with no local action.

The reaper is single-writer via:

```text
<repoRoot>/.cliyard/runtime/reaper.lock
```

## Reconciliation order

For one runtime:

1. read manifest and all port leases;
2. preflight every unfinished service;
3. if any service is uncertain, change nothing;
4. otherwise send `SIGTERM` to each proven process group in reverse service
   order;
5. wait for group exit, escalate to `SIGKILL` after the grace period;
6. confirm the leased port is bindable on `127.0.0.1`;
7. release the exact lease;
8. write recovery evidence and final cleanup state atomically.

Never release a lease before the proven process group is gone and its port is
no longer serving.

## Recovery evidence

RuntimeManifest adds an optional record:

```ts
interface RuntimeRecoveryRecord {
  state: "reaped" | "needs_human" | "skipped";
  reason: string;
  at: string;
  reaperPid: number;
  reaperHost: string;
  services: Array<{
    name: string;
    pgid?: number;
    action: "terminated" | "already-exited" | "preserved";
    portReleased: boolean;
  }>;
}
```

Failure to terminate, failure to free a port, or failure to release a lease
must leave `cleanup: failed` and return `needs_human`; it must never be
reported as successfully reaped.

## Supervisor integration

Add:

```bash
cliyard supervisor reap --repo <path> [--json]
```

Also invoke reconciliation:

- after a new supervisor acquires its exclusive repo lock and before creating a
  new run;
- after `resume` acquires the repo lock and before updating the manifest to
  `running`.

If any candidate returns `needs_human`, start/resume must fail closed and print
the runtime IDs and reasons. `status` remains read-only; it may report recovery
records already persisted, but never performs reconciliation.

## Non-goals

- No cross-host remote kill.
- No heuristic pattern matching against command lines.
- No kill when only the process group number seems familiar.
- No process-group reaping after the leader has exited and ownership cannot be
  proven.
- No lease garbage collection that hides a possibly live service.
- No daemon or periodic background reaper.

## Tests

1. capture and compare exact leader pid/pgid/start identity;
2. manager persists owner and service identity;
3. a real helper process starts a detached service, then is SIGKILLed;
4. reaper proves ownership, terminates the group, frees the port and lease,
   and writes evidence;
5. changed start identity yields `needs_human` and preserves group/lease;
6. foreign-host owner yields `skipped`/`needs_human` without kill;
7. mismatched lease yields `needs_human`;
8. completed runtime is skipped;
9. preflight never mutates processes, leases or manifests;
10. concurrent reapers are serialized;
11. supervisor start/resume fails closed while a candidate needs human review.

## Success definition

```text
owner gone
  + exact manifest/lease correlation
  + exact pid/pgid/start identity
  → safe reaping and lease release

anything else
  → evidence preserved + needs_human
```

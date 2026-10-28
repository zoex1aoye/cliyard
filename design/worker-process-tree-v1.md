# Worker process tree v1.1

Closes the timeout descendant-cleanup gap recorded in
[`docs/evidence/CONTINUATION_SELF_HOST.md`](../docs/evidence/CONTINUATION_SELF_HOST.md)
§2.4: a worker CLI could time out, the adapter killed the direct child, and
verifier test processes started by that CLI kept running.

Version 1.1 extends the accepted v1 dedicated-group design to descendants that
leave that group by calling `setsid` (a detached test runner, a background
server). v1 only signalled the top-level group and therefore leaked the nested
group. v1.1 discovers and cleans those descendants while the worker leader is
alive, using exact `(pid, pgid, lstart)` identities. It does **not** close
controller-death recovery of nested groups; see [Platform limits](#platform-limits).

## Problem

An adapter previously owned exactly one PID. A worker CLI (Claude, Codex, or a
shell fixture) may start long-lived descendants — test runners, shells,
background servers. Signalling only the direct child:

- leaves descendants running (the observed leak), and
- can hang result collection, because descendants inherit the worker's stdio
  pipes, so the `close` event may never fire.

Name matching (`pkill -f`) and workspace-wide scans are not kill authority: a
name can match unrelated processes, and a scan can race. The manager therefore
uses OS process-group ownership with an exactly captured identity.

## Managed process group

On POSIX (macOS/Linux), `WorkerProcessTreeManager.spawn` starts the worker with
`detached: true`. Node then calls `setsid` for the child, so:

- the worker is the leader of a new dedicated process group;
- `pgid === child.pid`;
- every descendant that does not deliberately create a new group inherits it.

Immediately after spawn — before any cleanup wait — the manager starts
`ProcessInspector.capture(pid)` (`ps -o pid=,pgid=,lstart=`). The captured
`(pid, pgid, lstart)` is the exact worker identity. `ProcessInspector` is
read-only; the only mutating operations in this design are signals sent after
the guards below.

## Descendants that leave the group

`ProcessInspector.snapshotProcessTable()` takes one bounded read-only
`ps -A -o pid= -o ppid= -o pgid= -o lstart=` snapshot. It refuses malformed
rows, duplicate pids, and tables above 8,192 rows instead of returning a
partial relationship graph. Linux kernel-thread rows (`pgid 0`) are valid table
evidence but are never tracked as signal candidates; a pid-0 idle/kernel-task
row is skipped, since it can never be the worker or its descendant. The worker
manager walks the graph recursively from the leader (BFS over `ppid`), never by
process name.

While the leader is alive and has a captured identity, a low-frequency sampler
(default 250 ms; values below 250 ms are rejected) records bounded descendant
identities. Sampling is stopped on leader exit and at the start of cleanup. A
snapshot contributes only when its root row still matches the captured
`(pid, pgid, lstart)`; a reused pid therefore never contributes descendants.

A descendant whose `pgid` differs from the managed group may be in its own
session/group. Such an **external descendant** is handled by exact pid, not by
signalling its group:

1. It must have been observed in a validated snapshot.
2. Before any signal, `capture(pid)` is re-read and must match the recorded
   `(pid, pgid, lstart)` exactly.
3. It must not be pid 1, cliyard itself, or in cliyard's own process group.
4. Signals are sent with `process.kill(pid, …)`, never `kill(-pgid, …)`, and
   never `pkill`, process names, or workspace heuristics.
5. At most 32 external descendants are signalled; 64 identities are tracked,
   256 pids observed, 32 identities and 16 group ids persisted. Exceeding a
   bound makes nested cleanup fail closed rather than incomplete.

`nestedCleanup.state` is `none` (nothing external was observed), `clean`
(observed but already gone), `terminated` (at least one exact descendant pid was
signalled and is gone), or `failed` (identity, revalidation, or bounds stayed
ambiguous). A failed **worker** remains the primary failure; a failed nested
cleanup fails an otherwise successful result closed.

## Cleanup semantics

`ManagedWorkerProcess.cleanup(reason)` is idempotent. The first call fixes
`cleanupReason` (`child-close`, `timeout`, `cancel`, `spawn-error`); concurrent
and later calls resolve with the same terminal outcome. It never rejects.

The manager starts cleanup on the child's `exit` event, not only on `close`:
resident descendants can hold stdio open forever, so `close` may never arrive.
Adapter timers and `session.cancel()` await the same promise.

POSIX procedure:

1. Wait for the identity capture.
2. Require a dedicated group:
   - captured identity present → it must be `identity.pid === pid` and
     `identity.pgid === pid`, else fail closed;
   - identity absent (leader exited before `ps` read it) → list members of the
     freshly spawned `pid`; an empty group is clean, and a non-empty group is
     trusted only when every member still reports `pgid === pid`
     (`captureSource: "pgid-reservation"`). Anything else fails closed.
3. Stop the descendant sampler and take a fresh process-table snapshot rooted
   at the leader. Merge exact external descendants; a snapshot whose root no
   longer matches the captured identity contributes nothing.
4. Revalidate and `SIGTERM` external descendants by exact pid, bounded by the
   32-target cap and the same term grace.
5. Re-list the managed group. Empty → group clean, no group signal.
6. Run the safety guard (below). Refusal → group failed.
7. `SIGTERM` to `-pgid`, wait up to the bounded term grace.
8. Members remain → re-run the same guard against fresh membership, `SIGKILL`
   to `-pgid`, wait up to the bounded kill grace.
9. Group empty → `terminated`. Non-empty after SIGKILL, or any ambiguity →
   `failed` with the observed residual identities.
10. External descendants still alive after SIGTERM are re-read and, only on an
    exact identity match, sent `SIGKILL` by exact pid; a bounded wait follows.
    An unreadable or changed identity is residual and fails nested cleanup.

Fail-closed paths still send `SIGTERM`/`SIGKILL` to the **exact direct child**
(scope `pid`), never to a group, so an adapter cannot hang waiting for a close
event that the cleanup path could not produce. This is a liveness fallback, not
a claim that the tree was cleaned.

## Signal safety guard

A process-group signal is sent only when all of these hold against a fresh
listing taken immediately before the signal:

- `pgid === spawned leader pid` and `pgid > 1`;
- `pgid !== process.pid` (cliyard itself);
- no member has `pid === process.pid`;
- every member reports the same `pgid`;
- cliyard's own group id is known from `ps` and differs from `pgid`;
- when an exact leader identity was captured, the member with that pid still
  matches `(pid, pgid, lstart)`.

Any failure is a refusal: the record becomes `failed`, not a best guess.

An external descendant signal additionally requires, immediately before the
signal:

- a validated snapshot observation with this exact recorded identity;
- a fresh `capture(pid)` whose `(pid, pgid, lstart)` matches that identity;
- `pgid !== managed pgid`, `pgid !== cliyard's group`, and `pid !== process.pid`;
- a positive pid above 1, within the 32-descendant signal bound.

There is no `pkill`, process-name match, workspace scan, broad process scan, or
cross-host signal path. Signals to external descendants are exact-pid only.

## Record

`WorkerProcessRecord` (version 1) is credential-free and bounded:

| field | meaning |
| --- | --- |
| `host` | host where the tree was observed; evidence is meaningful only there |
| `pid`, `pgid` | direct child pid and known dedicated group id |
| `identity` | exact `(pid, pgid, lstart)` when capturable |
| `captureSource` | `ps-exact`, `pgid-reservation`, `none`, `unsupported` |
| `captureSupport` | `posix-process-group`, `windows-exact-child`, `unsupported-platform` |
| `cleanupReason` | `child-close`, `timeout`, `cancel`, `spawn-error` |
| `cleanupState` | `clean`, `terminated`, `failed`, `unsupported` |
| `signals` | bounded signal attempts with scope and result |
| `residualMembers` | bounded observed residual identities |
| `residualCount` | true observed residual count, even when the list is bounded |
| `observedExternalDescendants` | bounded exact identities observed outside the managed group |
| `observedExternalDescendantCount` | true observed external pid count, even when bounded |
| `observedExternalGroups` | bounded external process-group ids seen for those descendants |
| `nestedCleanup` | `none`/`clean`/`terminated`/`failed` plus observed/signalled/residual counts |
| `exitCode`, `exitSignal` | direct child exit status |
| `startedAt`, `closedAt`, `cleanedAt`, `detail` | timestamps and bounded detail |

Version 1 stays readable: all four nested fields are optional, and records
written before v1.1 parse unchanged. The parser rejects partial evidence (a
list without its count, a count without groups or nested outcome, duplicate
pids/groups, inconsistent counters) and over-limit arrays.

Bounds: 32 residual identities, 64 signal records, 32 external descendant
identities, 16 external group ids, 600 characters of detail, 16 records per
worker result, 32 tree records per manifest task. In-memory bounds are 64
tracked descendants, 256 observed descendant pids, 32 exact-pid signal targets,
and an 8,192-row process-table snapshot. Sampling is no faster than 250 ms. No
prompt, command line, environment, or secret is recorded.

## Fail-closed aggregation

- The Claude and Codex adapters collect the record for every invocation. If a
  worker otherwise succeeded but a tree record is `failed`, the adapter returns
  exit code 1 with a separate `cleanupFailure`
  (`stage: "worker"`, `code: "process_tree_cleanup_failed"`); a genuine worker
  failure remains the primary `failure`.
- The closed repair loop enforces the same rule independently: it parses the
  adapter's records, rejects malformed ones with
  `process_tree_record_invalid`, persists bounded evidence, records
  `process.tree` / `process.cleanup` ledger events, and never accepts on worker
  success alone when cleanup failed.
- The RunManifest task stores `processTrees` and `cleanupFailure`. Parsing is
  strict: a non-array, over-limit, or malformed record raises `RunManifestError`
  instead of silently dropping evidence. Batch checkpoints append bounded
  records, and supervisor status renders the latest state/reason/residual count.
- Cleanup failure does not change TaskContract acceptance rules or path
  verification; it only prevents a success result from being treated as
  successful. RuntimeManager services are not touched.

## Platform limits

- **macOS/Linux** with `ps`: full POSIX group capture and cleanup.
- **Windows**: no POSIX process group is created (`detached` is not claimed).
  The record says `windows-exact-child` / `unsupported`; only the exact direct
  child is ever signalled, and descendants are explicitly out of scope. This is
  a documented limitation, not an equivalent cleanup.
- **Other platforms without `ps`**: same exact-child limitation, recorded as
  `unsupported-platform`.
- **Cross-host**: nothing here signals or proves cleanup on another host. The
  record's `host` scopes the evidence; a foreign-host record is not cleanup
  authority.
- **Abrupt orchestrator death**: if cliyard is SIGKILLed (or otherwise cannot
  run JavaScript), no in-process cleanup runs. A detached worker group survives
  that event. WorkerLease v1 recovery knows only the top-level worker
  `pid`/`pgid`/identity; it has no record of nested groups created with
  `setsid`. **Controller-death recovery of nested groups is not closed by
  v1.1.** It is the next process-ownership follow-up; do not read the v1.1
  nested cleanup as a durable recovery claim. Normal child exit, timeout,
  cancel, and spawn error are covered because the sampler and final snapshot
  run in-process before the controller dies.
- **Descendants that call `setsid` while the controller runs**: they leave the
  managed group by design, but v1.1 discovers them through the bounded
  process-table snapshot and cleans each one by exact pid after revalidation.
  It never follows them by process name.

## Tests

`tests/worker-process-tree.test.ts` uses real detached Node fixtures that spawn
helper processes. Real-group tests are skipped on `win32`; the Windows mode is
exercised as a simulated platform. See
[`docs/evidence/WORKER_PROCESS_TREE.md`](../docs/evidence/WORKER_PROCESS_TREE.md)
for the exact cases and observed results.

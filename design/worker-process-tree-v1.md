# Worker process tree v1

Closes the timeout descendant-cleanup gap recorded in
[`docs/evidence/CONTINUATION_SELF_HOST.md`](../docs/evidence/CONTINUATION_SELF_HOST.md)
§2.4: a worker CLI could time out, the adapter killed the direct child, and
verifier test processes started by that CLI kept running.

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
read-only; the only mutating operation in this design is the final signal to a
group that has passed every guard below.

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
3. Re-list the group. Empty → `clean`, no signal.
4. Run the safety guard (below). Refusal → fail closed.
5. `SIGTERM` to `-pgid`, wait up to the bounded term grace.
6. Members remain → re-run the same guard against fresh membership, `SIGKILL`
   to `-pgid`, wait up to the bounded kill grace.
7. Empty → `terminated`. Non-empty after SIGKILL, or any ambiguity → `failed`
   with the observed residual identities.

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

Any failure is a refusal: the record becomes `failed`, not a best guess. There
is no `pkill`, process-name match, workspace scan, or cross-host signal path.

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
| `exitCode`, `exitSignal` | direct child exit status |
| `startedAt`, `closedAt`, `cleanedAt`, `detail` | timestamps and bounded detail |

Bounds: 32 residual identities, 8 signal records, 600 characters of detail,
16 records per worker result, 32 tree records per manifest task. No prompt,
command line, environment, or secret is recorded.

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
  that event. An in-flight invocation has no durable record to recover from,
  and name-based reaping is prohibited, so this design does not claim cleanup
  after SIGKILL. Normal exit, timeout, cancel and spawn error are covered.

- A descendant that deliberately calls `setsid` leaves the managed group by
  design; the manager reports what the group contained and never follows it by
  name.

## Tests

`tests/worker-process-tree.test.ts` uses real detached Node fixtures that spawn
helper processes. Real-group tests are skipped on `win32`; the Windows mode is
exercised as a simulated platform. See
[`docs/evidence/WORKER_PROCESS_TREE.md`](../docs/evidence/WORKER_PROCESS_TREE.md)
for the exact cases and observed results.

# Evidence: managed worker process trees (v1.1)

Task: `worker-process-tree-v1.1`. Design:
[`design/worker-process-tree-v1.md`](../../design/worker-process-tree-v1.md).

## Gap being closed

[`docs/evidence/CONTINUATION_SELF_HOST.md`](CONTINUATION_SELF_HOST.md) §2.4
recorded that a Codex worker timed out, the adapter killed the direct child, and
verifier test processes started by that worker remained running. The prior
adapters owned one PID and had no process-group ownership proof.

v1 closed the leak for descendants that stayed in the worker's dedicated
process group. v1.1 closes the remaining in-process leak: a descendant that
calls `setsid` (or a test runner that detaches) creates its own process group,
so killing the top-level group leaves the nested group alive. v1.1 discovers
those descendants while the leader is alive and cleans them by exact pid.
Controller-death recovery of such nested groups remains open and is explicitly
not claimed.

## Implementation

- `src/runtime/process.ts` — read-only
  `ProcessInspector.snapshotProcessTable()`: one bounded
  `ps -A -o pid= -o ppid= -o pgid= -o lstart=` snapshot with malformed-row,
  duplicate-pid, and 8,192-row fail-closed bounds.
- `src/agents/process-tree.ts` — `WorkerProcessTreeManager`: POSIX detached
  spawn, immediate exact identity capture, bounded `WorkerProcessRecord`,
  idempotent cleanup, dedicated-group safety guard, fail-closed record parser;
  v1.1 adds a 250 ms-minimum descendant sampler, validated snapshot merging,
  exact-pid revalidation and SIGTERM→SIGKILL for external-group descendants,
  and bounded nested evidence. The top-level group path is unchanged.
- `src/agents/claude.ts`, `src/agents/codex.ts` — spawn through the manager;
  clean the managed group on normal close, timeout and cancel; return records
  and a structured `cleanupFailure`; `cancel`/timers await the same cleanup.
- `src/agents/types.ts` — `AgentResult.processTrees`, `AgentResult.cleanupFailure`.
- `src/repair/loop.ts` — parses and bounds records, enforces fail-closed success
  (independent of adapter behavior), persists them, emits ledger events.
- `src/supervisor/types.ts`, `src/supervisor/store.ts` — RunManifest task
  `processTrees` / `cleanupFailure` with strict load-time validation.
- `src/scheduler/codex-batch.ts` — bounded checkpoint persistence for accepted
  and rejected tasks.
- `src/supervisor/cli.ts` — supervisor status shows the latest tree state,
  cleanup reason and residual count, plus any cleanup failure.

## Tests

`tests/worker-process-tree.test.ts` uses real detached Node fixtures that spawn
helper processes (a leader script and `setInterval` helpers). Real-group tests
are skipped on `win32`; Windows behavior is tested as a simulated platform. Run:

```sh
npx tsx --test tests/worker-process-tree.test.ts
```

Observed on 2026-10-28 (macOS, Node via `tsx`): 22 tests, 22 pass, 0 fail.

| # | Test | Proves |
| --- | --- | --- |
| 1 | captures the exact dedicated process-group identity immediately after spawn | real child has `pgid === pid`; `captureSource: ps-exact`; exact identity persisted; group SIGTERM recorded; `terminated` |
| 2 | cleans residual descendants after normal leader exit (prior leak reproduction) | leader spawns a helper and exits; helper stays alive in the group; `child-close` cleanup observes and terminates it — this is the §2.4 leak |
| 3 | timeout cleanup terminates helper descendants | timeout path signals the group and the helper dies; no `descendant-pid` signal and no nested fields (same-group path unchanged) |
| 4 | cancel cleanup terminates helper descendants and is idempotent | concurrent `cancel`/`timeout` and a later `child-close` return the same record, same reason, no duplicate signals; helper dies |
| 5 | escalates SIGTERM to SIGKILL only when the managed group ignores SIGTERM | signal sequence is exactly `SIGTERM:process-group`, `SIGKILL:process-group` after the bounded grace; both leader and helper die |
| 6 | bounds residual evidence while reporting the true count | 34 residual helpers: persisted list is 32 identities, `residualCount` is the true 34, signals stay bounded; all helpers die |
| 7 | takes a bounded process-table snapshot with ppid links for a live tree | real snapshot is pid-sorted and records the helper's `ppid === leader pid` and `pgid === leader pgid`, with a non-empty exact `lstart` |
| 8 | timeout cleanup kills a descendant that created its own process group | detached helper has `pgid === helper pid !== managed pgid`; cleanup records its exact identity and external group, sends a `descendant-pid` SIGTERM, and both the top-level group and exact nested group are gone |
| 9 | cancel cleanup kills a descendant that created its own process group | same real leak reproduction through the cancel path; both groups gone, nested evidence `terminated` |
| 10 | cleans a sampled nested descendant after the leader dies before cleanup | leader is SIGKILLed after two 250 ms sampler periods; the helper was already tracked, so `child-close` cleanup revalidates and kills it by exact pid even though no final leader-rooted snapshot is possible |
| 11 | refuses a changed identity and never signals the unrelated live process | snapshot forge keeps the unrelated pid/pgid but changes `lstart`; revalidation refuses, `cleanupState: failed`, nested evidence failed, no `descendant-pid` signal, and the unrelated process stays alive |
| 12 | process-table snapshots fail closed on malformed rows, duplicates and bounds | fake `ps` rows: valid rows parse and sort; a Linux kernel-thread row with `pgid 0` is retained as table evidence but never becomes a signal candidate; the pid-0 idle task is skipped; malformed rows reject, duplicate pids reject, `maxEntries: 1` rejects rather than truncating, invalid bounds reject, win32 rejects |
| 13 | fails closed and stays parseable when nested cleanup cannot complete | the cleanup snapshot observes a real detached helper, then group inspection fails; `cleanupState: failed`, nested evidence failed, no `descendant-pid` signal was authorized, and `parseWorkerProcessRecord` returns the same record |
| 14 | uses the reserved spawned pgid when the leader exited before identity capture | with worker identity unavailable, cleanup trusts `pgid = spawned pid` only because remaining members reserve it (`pgid-reservation`); helper dies |
| 15 | fails closed when group inspection stays ambiguous | `ps` failure → `cleanupState: failed`, `treeOk: false`, `process_tree_cleanup_failed`; the exact child is still signalled (pid scope) so adapters cannot hang; record parses |
| 16 | refuses to signal a group that matches cliyard's own group | with the guard's own-group fact simulated, cleanup refuses, fails closed, sends only pid-scope signals, and the group helper stays alive — cliyard's group is never signalled |
| 17 | win32 mode records the exact-child limitation and never claims a group | `windows-exact-child` / `unsupported`, no pgid, only pid-scope signals; a helper intentionally survives the unsupported scope |
| 18 | both adapters clean helper descendants left after a normal worker exit | real Claude and Codex adapter paths with a shell worker that backgrounds a Node helper holding stdio: normal close records `child-close` → `terminated`, helper dies, result stays exit 0 |
| 19 | manifest round-trips process-tree evidence and rejects malformed records | `processTrees` + `cleanupFailure` survive save/load; invalid state, oversize residual list, invalid reason, and malformed signal entries raise `RunManifestError` |
| 20 | legacy process-tree records stay readable and nested evidence is validated | pre-v1.1 version-1 records parse unchanged; nested records round-trip; partial evidence, mismatched counters, duplicate groups, over-limit arrays, and malformed signal scopes are rejected |
| 21 | closed loop rejects worker success when tree cleanup failed | adapter reports exit 0 + `cleanupState: failed`; the loop independently derives `cleanupFailure`, rejects despite a passing verifier, keeps the record, and reports `process_tree_cleanup_failed` |
| 22 | closed loop rejects malformed process-tree records | an unparseable record yields `process_tree_record_invalid` and a rejected verdict instead of silent acceptance |

Test 18 is the adapter-level end-to-end check for the earlier failure mode: the
shell exits 0 while its Node helper still holds the stdout pipe. Cleanup is
started from the child `exit` event (not `close`), signals the dedicated group,
and only then does `close` fire. Without group cleanup this test hangs or leaves
the helper running.

Tests 8–10 are the v1.1 leak reproduction: the helper is spawned with
`detached: true`, so the OS creates a second process group. A group-only
cleanup (the v1 behavior) would leave that helper running after both timeout and
cancel. Tests 8 and 9 prove it is gone in both paths through the fresh cleanup
snapshot; test 10 proves the sampler retains the evidence when the leader dies
first. Test 11 proves a forged/reused pid+pgid with a different `lstart` is
refused and the unrelated live process is untouched. Test 13 proves an
incomplete nested cleanup fails the result closed and still emits a record the
version-1 parser accepts, rather than emitting evidence that cannot round-trip.

## Self-host ordering

The queue worker that implemented this slice still ran through the previous
adapter, because the new process-tree manager did not yet exist at dispatch
time. Its completed RunManifest therefore correctly has no `processTrees`
record for that invocation. The first live process-tree record will be produced
by the next worker run after this merge. Real OS process-group tests in the
slice provide the cleanup evidence; the implementation run is not retroactively
labeled with evidence it could not produce.

## Post-merge production-path smoke (v1 top-level scope)

A credential-free smoke used the merged Supervisor and Claude adapter path with
an executable fake stream-json worker in a disposable Git repository. The fake
worker spawned a background Node helper, wrote the allowed artifact and emitted
a successful result before exiting. The helper inherited the worker's dedicated
process group and remained alive after its leader exited. This smoke predates
v1.1 and therefore did not create a `setsid` nested group; the nested lifecycle
evidence is the real detached-helper test set above, not this smoke.

Observed RunManifest evidence:

```text
run: completed
task: accepted
capture: ps-exact
worker pid/pgid: 46742 / 46742
cleanup reason: child-close
cleanup state: terminated
residual helper: 46771 (pgid 46742)
signal: SIGTERM process-group
cleanup failure: null
helper alive after Supervisor return: false
```

This is a real process-group cleanup through Supervisor, verifier and
RunManifest persistence. It called no provider API and did not claim a paid
worker session.

## Suite and build

```sh
npx tsx --test tests/worker-process-tree.test.ts  # 22 tests, 22 pass, 0 fail
npm test                                          # 440 tests, 440 pass, 0 fail
npm run build                                     # tsc -p tsconfig.json, clean
```

Both runs observed on 2026-10-28 (macOS, Node via `tsx`).

## Limits (not overclaimed)

- Cleanup covers POSIX process groups and exact-pid nested descendants only
  where `ps` identity/process-table inspection is supported (macOS, Linux).
  Windows and other platforms record `unsupported` and signal only the exact
  direct child; this is a documented limitation, not equivalent cleanup.
- Descendants that create their own session/process group are followed only
  while cliyard's controller process is running. Discovery is snapshot-based
  and bounded; there is no name matching or broad scan. A descendant that
  leaves and is gone before the next 250 ms sample, or exceeds a bound, cannot
  be cleaned; over-bound observations fail closed.
- If the leader and all descendants exit before evidence can be collected, the
  record is `clean` with `captureSource: none`; if members remain but the
  spawned pgid cannot be proven reserved, cleanup fails closed.
- No cross-host cleanup is claimed. Records are evidence for the host recorded
  in the record.
- If cliyard itself is SIGKILLed while a worker runs, no in-process cleanup can
  run and the detached worker group survives. WorkerLease v1 persists only the
  top-level worker `pid`/`pgid`/identity; it has no nested-group registry, so
  recovery after controller death **cannot** clean a group created with
  `setsid`. Nested-group recovery after controller death is not closed by
  v1.1 and is the next process-ownership follow-up. Do not read the nested
  cleanup tests as a durable recovery claim. Normal exit, timeout, cancel and
  spawn error are covered by this design.
- No `pkill`, process-name matching, workspace-wide scan, daemon, TaskContract
  acceptance change, path-verification change, or RuntimeManager service
  termination is involved.

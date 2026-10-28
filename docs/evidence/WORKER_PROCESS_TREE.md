# Evidence: managed worker process trees

Task: `managed-worker-process-tree`. Design:
[`design/worker-process-tree-v1.md`](../../design/worker-process-tree-v1.md).

## Gap being closed

[`docs/evidence/CONTINUATION_SELF_HOST.md`](CONTINUATION_SELF_HOST.md) §2.4
recorded that a Codex worker timed out, the adapter killed the direct child, and
verifier test processes started by that worker remained running. The prior
adapters owned one PID and had no process-group ownership proof.

## Implementation

- `src/agents/process-tree.ts` — `WorkerProcessTreeManager`: POSIX detached
  spawn, immediate exact identity capture, bounded `WorkerProcessRecord`,
  idempotent cleanup, dedicated-group safety guard, fail-closed record parser.
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

Observed on 2026-10-28 (macOS, Node via `tsx`): 14 tests, 14 pass, 0 fail.

| # | Test | Proves |
| --- | --- | --- |
| 1 | captures the exact dedicated process-group identity immediately after spawn | real child has `pgid === pid`; `captureSource: ps-exact`; exact identity persisted; group SIGTERM recorded; `terminated` |
| 2 | cleans residual descendants after normal leader exit (prior leak reproduction) | leader spawns a helper and exits; helper stays alive in the group; `child-close` cleanup observes and terminates it — this is the §2.4 leak |
| 3 | timeout cleanup terminates helper descendants | timeout path signals the group and the helper dies |
| 4 | cancel cleanup terminates helper descendants and is idempotent | concurrent `cancel`/`timeout` and a later `child-close` return the same record, same reason, no duplicate signals; helper dies |
| 5 | escalates SIGTERM to SIGKILL only when the managed group ignores SIGTERM | signal sequence is exactly `SIGTERM:process-group`, `SIGKILL:process-group` after the bounded grace; both leader and helper die |
| 6 | bounds residual evidence while reporting the true count | 34 residual helpers: persisted list is 32 identities, `residualCount` is the true 34, signals stay bounded; all helpers die |
| 7 | uses the reserved spawned pgid when the leader exited before identity capture | with worker identity unavailable, cleanup trusts `pgid = spawned pid` only because remaining members reserve it (`pgid-reservation`); helper dies |
| 8 | fails closed when group inspection stays ambiguous | `ps` failure → `cleanupState: failed`, `treeOk: false`, `process_tree_cleanup_failed`; the exact child is still signalled (pid scope) so adapters cannot hang; record parses |
| 9 | refuses to signal a group that matches cliyard's own group | with the guard's own-group fact simulated, cleanup refuses, fails closed, sends only pid-scope signals, and the group helper stays alive — cliyard's group is never signalled |
| 10 | win32 mode records the exact-child limitation and never claims a group | `windows-exact-child` / `unsupported`, no pgid, only pid-scope signals; a helper intentionally survives the unsupported scope |
| 11 | both adapters clean helper descendants left after a normal worker exit | real Claude and Codex adapter paths with a shell worker that backgrounds a Node helper holding stdio: normal close records `child-close` → `terminated`, helper dies, result stays exit 0 |
| 12 | manifest round-trips process-tree evidence and rejects malformed records | `processTrees` + `cleanupFailure` survive save/load; invalid state, oversize residual list, invalid reason, and malformed signal entries raise `RunManifestError` |
| 13 | closed loop rejects worker success when tree cleanup failed | adapter reports exit 0 + `cleanupState: failed`; the loop independently derives `cleanupFailure`, rejects despite a passing verifier, keeps the record, and reports `process_tree_cleanup_failed` |
| 14 | closed loop rejects malformed process-tree records | an unparseable record yields `process_tree_record_invalid` and a rejected verdict instead of silent acceptance |

Test 11 is the adapter-level end-to-end check for the prior failure mode: the
shell exits 0 while its Node helper still holds the stdout pipe. Cleanup is
started from the child `exit` event (not `close`), signals the dedicated group,
and only then does `close` fire. Without group cleanup this test hangs or leaves
the helper running.

## Self-host ordering

The queue worker that implemented this slice still ran through the previous
adapter, because the new process-tree manager did not yet exist at dispatch
time. Its completed RunManifest therefore correctly has no `processTrees`
record for that invocation. The first live process-tree record will be produced
by the next worker run after this merge. Real OS process-group tests in the
slice provide the cleanup evidence; the implementation run is not retroactively
labeled with evidence it could not produce.

## Post-merge production-path smoke

A credential-free smoke used the merged Supervisor and Claude adapter path with
an executable fake stream-json worker in a disposable Git repository. The fake
worker spawned a background Node helper, wrote the allowed artifact and emitted
a successful result before exiting. The helper inherited the worker's dedicated
process group and remained alive after its leader exited.

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
npm test        # 362 tests, 362 pass, 0 fail (2026-10-28)
npm run build   # tsc -p tsconfig.json, clean
```

## Limits (not overclaimed)

- Cleanup covers POSIX process groups only where `ps` identity/group inspection
  is supported (macOS, Linux). Windows and other platforms record
  `unsupported` and signal only the exact direct child; this is a documented
  limitation, not equivalent cleanup.
- A descendant that creates its own session/process group leaves the managed
  group by design; the manager reports the observed group and never follows it
  by name.
- If the leader and all descendants exit before evidence can be collected, the
  record is `clean` with `captureSource: none`; if members remain but the
  spawned pgid cannot be proven reserved, cleanup fails closed.
- No cross-host cleanup is claimed. Records are evidence for the host recorded
  in the record.
- If cliyard itself is SIGKILLed while a worker runs, no in-process cleanup can
  run and the detached worker group survives. No in-flight worker identity is
  persisted, so resume cannot safely kill it and name-based reaping is
  prohibited. Tests and operators that SIGKILL an orchestrator must clean their
  own fixture workers explicitly; normal exit, timeout, cancel and spawn error
  are covered by this design.
- No `pkill`, process-name matching, workspace-wide scan, daemon, TaskContract
  acceptance change, path-verification change, or RuntimeManager service
  termination is involved.

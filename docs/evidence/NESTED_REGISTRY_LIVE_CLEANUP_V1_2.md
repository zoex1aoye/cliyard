# Evidence: nested registry live cleanup v1.2 cutover

> Measured 2026-10-29 on macOS 27.0 (Darwin 27.0.0), Node `v20.20.2`,
> `tsx v4.23.15`, host `paofujianlaide-MacBook.local`.
>
> Cutover run: `3b07e58b-57a7-48d8-84cd-d6818478884a`.
> Reviewed implementation base: `fac4606107141f6eb243e9308d7fc044f4255b9e`.
>
> This document records observed behavior only. It does not accept, merge or
> push the reviewed draft, and it does not convert any earlier rejected run
> into an accepted integration.

## Result in one paragraph

v1.2 separates two facts that v1.1 conflated: whether the current controller
can prove the currently reachable process tree gone, and whether a bounded
durable lease could let a future controller recover that tree after controller
death. In this cutover, Supervisor and the outer Worker process-tree manager
were loaded from reviewed draft `fac4606`, and this is the first outer Worker
lifecycle managed by that v1.2 code. From the cutover worktree at `fac4606`,
the focused process-tree/lease tests passed **65/65** in **9,886.658625 ms**
(wall **10.101 s**), `npm run build` passed, and the complete suite passed
**464/464** in **26,234.164459 ms** (wall **26.389 s**). The v1.2 tests prove a
real 20-group, 512-member live tree is cleaned with zero residual while only the
persisted 16-group registry is truncated, current inspection failure still
fails closed, and controller-death recovery from the resulting truncated lease
is `needs_human` with **zero** group and pid signals. During this cutover
Worker's own focused test activity, its outer v1.2 lease reached
`truncated: true` with 16 persisted groups while the Worker continued. Terminal
outer cleanup evidence is written by the Supervisor after this Worker exits and
is therefore not claimed inside this document; the authoring-time snapshot and
the exact fields to verify are recorded below.

## Lineage and separation of runs

Three distinct artifacts must not be collapsed:

| Stage | Run / commit | Code that managed the outer Worker | Observed outcome |
| --- | --- | --- | --- |
| Rejected implementation run | `d058568e-2d24-4cb9-a878-4ed360201aac`, base `a18b46c` | `a18b46c` (pre-v1.2 manager) | Task `nested-live-cleanup-separation` rejected with `process_tree_cleanup_failed`; `residualCount=0`, `signalledGroups=0`, 16 persisted groups, `truncated=true`. It was **not** accepted. |
| Independent review of the four-path draft | Draft preserved at `fac4606` on `cliyard/mvt1n5la-nested-live-cleanup-separation` | Not applicable (review, not a run) | Focused **65/65**, build pass, complete suite **464/464 in 25.98 s**, only the four frozen write paths changed, `WorkspaceBoundary` clean, no residual fixture processes found by exact worktree/helper path check. Recorded in the cutover design; it did not accept the draft. |
| This cutover run | `3b07e58b-57a7-48d8-84cd-d6818478884a`, base `fac4606` | `fac4606` (reviewed v1.2 code) | First outer Worker lifecycle managed by v1.2. Authoring-time: focused **65/65**, build pass, complete suite **464/464**; outer lease `active`, durable registry `truncated`, 16 groups persisted, Worker still running. Terminal cleanup/path/boundary/cost records follow run close. |

### Rejected implementation run is not retroactively successful

`d058568e` produced the v1.2 source and test draft from `a18b46c`, but its
outer Supervisor was still loaded from `a18b46c`. That manager intentionally
failed when the bounded durable registry was truncated, even though the current
tree was already gone. The RunManifest recorded:

```text
task: nested-live-cleanup-separation
status: rejected, accepted: false
reason: implement failed: exitCode=1
failure.code: process_tree_cleanup_failed
message: unclassified worker failure (process-tree cleanup failed
         (ps-exact, residual=0, nested=failed/0):
         descendant snapshot exceeded a bounded nested registry limit)
observedExternalDescendantCount: 256
observedExternalGroups: 16 (persisted; registry truncated)
nestedCleanup: state=failed, signalledGroups=0, residualGroups=0
pathAudits.outsideWritePaths: []
WorkspaceBoundary: clean
cost: USD 6.445692, state cli-estimated, authoritative=false
```

The four changed paths were
`src/agents/process-tree.ts`, `src/agents/worker-lease.ts`,
`tests/worker-process-tree.test.ts` and `tests/worker-lease.test.ts`. The
draft was reviewed and preserved at `fac4606`; the run remains blocked
history.

### Why this cutover is the first v1.2-managed outer lifecycle

The cutover Supervisor's working directory was the implementation worktree
`/Users/x1aoye/Documents/pers-project/cliyard/.cliyard/worktrees/mvt1n5la-nested-live-cleanup-separation`,
whose `HEAD` was verified as
`fac4606107141f6eb243e9308d7fc044f4255b9e`:

```text
git -C .../mvt1n5la-nested-live-cleanup-separation rev-parse HEAD
fac4606107141f6eb243e9308d7fc044f4255b9e
```

The RunManifest also records `baseCommit` and `integrationHead` as `fac4606`.
Earlier outer Workers were managed by `a9d6e00` (v1.1) or `a18b46c`
(pre-v1.2); this is the first one where the Supervisor and its process-tree
manager are the reviewed v1.2 code. The cutover task itself ran in a child
worktree at the same base:

```text
/Users/x1aoye/Documents/pers-project/cliyard/.cliyard/worktrees/mvt20btb-nested-registry-live-cleanup-v1-2-cutove
branch: cliyard/mvt20btb-nested-registry-live-cleanup-v1-2-cutove
HEAD:   fac4606107141f6eb243e9308d7fc044f4255b9e
```

## What v1.2 changed

- `WorkerCleanupCompleteness = "complete" | "incomplete" | "unsupported"` and
  `WorkerDurableRecoveryCompleteness = "complete" | "truncated"` are separate
  record fields, carried by the process record, nested cleanup evidence, lease
  cleanup evidence and status projection.
- Live cleanup enumerates external groups from the current validated process
  table, capped by the existing 8,192-row inspectable table limit
  (`MAX_LIVE_NESTED_GROUPS = MAX_PROCESS_TABLE_ROWS = 8,192`). It is not capped
  by the 16-group persistence bound.
- The durable nested registry remains bounded: at most 16 groups, at most 32
  external descendant identities, and at most 256 sampled descendants. Crossing
  a persistence bound sets `truncated` for recovery; it does not by itself fail
  live cleanup.
- Each current external group is cleaned with a guarded negative-pgid signal
  only after fresh proof: `pid === pgid` leader identity, a fresh exact capture,
  fresh membership in the same group, the exact leader present, and refusal of
  cliyard's own pid/group, the managed worker group and pid 1. Membership is
  re-read before and after signals.
- Exact-pid fallback remains for truly ungrouped external descendants, under
  the existing 32-live-target signal bound.
- `cleanupState: "failed"` maps to `cleanupCompleteness: "incomplete"`;
  `unsupported` maps to `unsupported`; terminal `clean`/`terminated` records
  map to `complete`. `durableRecoveryCompleteness` is derived separately from
  registry truncation.
- Controller-death recovery still refuses a truncated or structurally
  incomplete registry before any signal: action `preserved`, outcome
  `needs_human`, no group signal and no exact-pid signal.

## Commands and measured results

All commands ran from
`/Users/x1aoye/Documents/pers-project/cliyard/.cliyard/worktrees/mvt20btb-nested-registry-live-cleanup-v1-2-cutove`
at `HEAD fac4606107141f6eb243e9308d7fc044f4255b9e`.

### Focused worker process-tree and worker-lease tests

```sh
npx tsx --test tests/worker-process-tree.test.ts tests/worker-lease.test.ts
```

```text
exit: 0
# tests 65
# pass 65
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 9886.658625
wall: 10.101 s
```

The v1.2-specific focused results were:

| Test | Result | Duration |
| --- | --- | --- |
| `a live >16-group worker releases a complete cleanup with a truncated durable lease` | pass | 1,061.633333 ms |
| `recovery rejects a truncated nested registry without any signal` | pass | 4.089709 ms |
| `cleans more than 16 external groups with a 512-member group and only truncates durable recovery` | pass | 1,194.505292 ms |
| `incomplete current process-table inspection still fails closed` | pass | 395.021709 ms |

Existing exact-identity and guard tests remained green inside the same 65/65,
including `refuses a changed identity and never signals the unrelated live
process`, `recovery never signals a reused nested group leader`, `an absent
nested group leader never authorizes a group signal` and
`recovery never signals a reused nested pid`.

### Build

```sh
npm run build
```

```text
> cliyard@0.1.0 build
> tsc -p tsconfig.json
exit: 0
wall: 1.109 s
```

### Complete suite

```sh
npm test
```

```text
exit: 0
# tests 464
# pass 464
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 26234.164459
wall: 26.389 s
```

This is one local run, not a CI, flake-rate or long-duration stability claim.

## Observed v1.2 cleanup evidence

### Real 20-group tree with a 512-member group

The process-tree test spawned 20 real detached group leaders; the first owned
512 helper members. It observed the persisted registry truncate to 16 groups
(`snapshot.truncated === true`, `groups.length === 16`) while the live process
table still contained all 20 groups. It then cleaned with reason `timeout` and
observed:

```text
treeOk: true
cleanupState: terminated
cleanupCompleteness: complete
durableRecoveryCompleteness: truncated
nestedCleanup.state: terminated
nestedCleanup.observedGroups: >= 20
nestedCleanup.signalledGroups: >= 20
nestedCleanup.residualGroups: 0
nestedCleanup.residualDescendants: 0
persisted observedExternalGroups.length: 16
parser round-trip: equal to the emitted record
a nested-process-group signal for the 512-member group: present
all 20 external groups: no live members, leader not alive
```

This is the measured resolution of the third observed failure: the live cleanup
is complete even though the durable registry is truncated.

### Truncated durable recovery is `needs_human` with no signal

The lease test repeated a real 20-group fixture (including a 512-member group),
attached a production lease, waited for `nestedProcesses.truncated: true`, and
cleaned it through `managed.cleanup("timeout")` plus `handle.update(...)`.
Observed lease evidence:

```text
lease.state: released
cleanup.processTreeState: terminated
cleanup.cleanupCompleteness: complete
cleanup.durableRecoveryCompleteness: truncated
nestedProcesses.truncated: true
nestedProcesses.groups.length: 16
all 20 fixture groups: dead, no members
```

The same test rewrote that lease as `active` with no terminal cleanup, then ran
`recoverWorkerLeases` with recording signal functions. Recovery observed:

```text
report.needsHuman: 1
report.recovered: 0
group kill calls: 0
exact-pid kill calls: 0
entry.action: preserved
entry.nested.truncated: true
entry.reason: matches /truncated/
lease after recovery: state active
recovery[0].outcome: needs_human
```

Recovery did not infer ownership from any persisted group id and sent no
signal. This is the v1.2 rule: truncated durable evidence authorizes nothing.

### Incomplete live inspection still fails closed

The incomplete-inspection test let a real nested group be observed, then made
the process-table snapshot fail during cleanup. Observed:

```text
treeOk: false
cleanupState: failed
cleanupCompleteness: incomplete
nestedCleanup.state: failed
nestedCleanup.cleanupCompleteness: incomplete
detail: matches /snapshot the worker process tree/
descendant-pid signals: none
parser round-trip: equal to the emitted record
```

### This cutover Worker's own outer lifecycle

At `2026-10-29T04:40:42.775Z`, while this documentation task was still running
and after it executed the focused tests, the outer lease at
`.cliyard/worker-leases/3b07e58b-57a7-48d8-84cd-d6818478884a/nested-registry-live-cleanup-v1.2-cutover-evidence/0b353eeb-ef69-49e2-b2b2-f3a4516ec1d5.json`
contained:

```text
state: active
worker: pid 9750, pgid 9750, captureMode posix-group
worker.osStartIdentity: Thu Oct 29 04:39:16 2026
controller: pid 9131, identity started Thu Oct 29 04:39:15 2026
nestedProcesses.version: 1
nestedProcesses.truncated: true
nestedProcesses.groups.length: 16
nestedProcesses.lastObservedAt: 2026-10-29T04:40:42.775Z
persisted group member counts: up to 35
```

The persisted groups correspond to external groups created by the focused test
activity in this worktree (for example pgids 710, 1703, 2211, 2580, 5465, 7089,
7380, 8756, 9923, 10309, 12201, 12458, 13637, 13774 and 14055 at the snapshot).
This is the v1.2 bounded durable registry in a real outer lifecycle: it was
truncated, the Worker continued, and the documented live-cleanup test evidence
shows why that truncation alone must not fail cleanup. It is pre-cleanup
evidence, not a terminal cleanup record.

After the focused and complete suites, an exact `ps -o pid= -g <pgid>` check
for each of those 16 persisted pgids (710, 1703, 2211, 2580, 5465, 7089, 7380,
8756, 9923, 10309, 12201, 12458, 13637, 13774, 14055) returned **0 members**
for every group. This is an exact-group check of the lease's persisted ids, not
a process-name or workspace-wide scan. It shows no surviving fixture groups
from the measured test activity at authoring time; it is not the outer Worker's
terminal cleanup proof.

The outer RunManifest at authoring time recorded:

```text
runId: 3b07e58b-57a7-48d8-84cd-d6818478884a
planId: nested-registry-live-cleanup-v1.2-cutover
baseCommit: fac4606107141f6eb243e9308d7fc044f4255b9e
integrationHead: fac4606107141f6eb243e9308d7fc044f4255b9e
status: running
task status: running, accepted: false
attemptWorktree: .../mvt20btb-nested-registry-live-cleanup-v1-2-cutove
attemptBaseCommit: fac4606107141f6eb243e9308d7fc044f4255b9e
```

### Terminal outer evidence is separate from this authoring snapshot

This document is written by the Worker while it is still alive. The Supervisor
writes the terminal `processTrees` record, path audit, `WorkspaceBoundary`
comparison and cost after the Worker exits. Those terminal values are therefore
**not claimed here**. The authoritative post-exit checks are:

```sh
node -e 'const j=require("/Users/x1aoye/Documents/pers-project/cliyard/.cliyard/runs/3b07e58b-57a7-48d8-84cd-d6818478884a.json"); const t=j.tasks["nested-registry-live-cleanup-v1.2-cutover-evidence"]; console.log(JSON.stringify({status:j.status, task:t.status, accepted:t.accepted, processTrees:t.processTrees, pathAudits:t.pathAudits, workspaceBoundary:t.workspaceBoundary, cost:t.cost}, null, 2))'
```

The terminal `processTrees` record must show a non-failed live cleanup
(`cleanupCompleteness: "complete"`, `residualCount: 0`), with
`durableRecoveryCompleteness` reported independently; the path audit must show
only `docs/evidence/NESTED_REGISTRY_LIVE_CLEANUP_V1_2.md` outside no allowed
paths; and `WorkspaceBoundary` must be read from its own record, not inferred
from this document. If any of those differ, the discrepancy is the evidence.

At authoring time, after adding this document, `git status --short` in the
cutover worktree showed exactly:

```text
?? docs/evidence/NESTED_REGISTRY_LIVE_CLEANUP_V1_2.md
?? node_modules
```

`git diff --stat` was empty, so no tracked source, test, contract or Plan file
was modified. That is a local working-tree observation, not a substitute for
the Supervisor's post-exit path audit or boundary record.

## Cost truth

The rejected implementation run `d058568e` recorded CLI-estimated cost
**USD 6.445692**, `state: cli-estimated`, `authoritative: false`, against a
USD 18 guard. It is not billing truth and is not evidence of success.

The cutover run's per-task cost was not yet recorded at authoring time. The
cutover Supervisor was launched with `--max-budget-usd 12`; when the attempt
closes, its cost record must be read with the same caution: CLI-estimated,
non-authoritative, and not proof of acceptance.

## Limits (not overclaimed)

- **Bounded durable registry.** Only 16 groups and 32 external descendant
  identities are persisted. A larger observed set makes durable recovery
  `truncated`; it does not make the live cleanup complete by itself.
- **Bounded live inspection.** Live cleanup uses a process-table snapshot
  capped at 8,192 rows. Exceeding that bound, malformed/duplicate rows, an
  uninspectable snapshot, an unprovable group identity, or an ungrouped live
  target set above 32 fails closed as incomplete.
- **No Windows recovery.** v1.2 is POSIX process-group code. Windows records
  `unsupported` and only the exact child is signalled; no Windows Job Object or
  Windows process-tree parity is claimed. The real-group tests skip on `win32`.
- **No cross-host recovery.** Leases are same-host evidence. A foreign-host
  controller/worker is skipped and reported; no cross-host inspection, kill or
  recovery exists.
- **No recovery of never-observed groups.** Recovery can act only on exact
  identities that were observed and persisted before controller death. A group
  that appears and disappears between 250 ms samples, or after the controller
  is already dead, is not recoverable. If the registry cannot prove
  completeness, recovery remains `needs_human` and signals nothing.
- **No OS write sandbox.** `WorkspaceBoundary` is a guard-only detection layer;
  it does not prevent writes, inspect credentials, isolate the network or
  provide a sandbox. Its record, when produced, is evidence of what was
  observed, not enforcement.
- **No automatic acceptance or merge.** Passing tests and a completed cleanup
  do not accept the reviewed draft or this task. The draft at `fac4606` is not
  an accepted integration; no merge or push is performed here.
- **No 24-hour soak or stability claim.** The focused suite took about 10
  seconds and the complete suite about 26 seconds in one local run. That is a
  single cutover measurement, not a long-duration soak, flake-rate study or CI
  matrix.
- **No broad process authority.** No process-name matching, port scan or
  workspace-wide process search is used as kill authority. Cleanup is by
  guarded exact external groups and bounded exact pids.
- **No stdout resume.** Controller-death recovery terminates verified groups
  and reports a resume need; it does not reattach output or auto-resume an
  attempt.
- **Coverage boundary.** Some recovery guard branches remain implemented but
  not separately isolated by committed tests, as recorded in
  [`WORKER_LEASE.md`](WORKER_LEASE.md). The v1.2 evidence here covers the
  truncated-registry, high-fan-out, incomplete-inspection and reused-identity
  paths exercised by the focused set, not every branch.

## Conclusion

v1.2 delivers the intended separation in code and in measured behavior:

- live cleanup of a real 20-group, 512-member tree completed with zero
  residual while the durable registry persisted only 16 groups and reported
  `truncated`;
- durable recovery from that truncated lease returned `needs_human` and sent no
  signal;
- incomplete live inspection still failed closed;
- reused/unsafe identities remained protected;
- this cutover run loaded the reviewed v1.2 code from `fac4606` and is the first
  outer Worker lifecycle managed by it.

The rejected implementation run `d058568e` remains rejected history, the
four-path draft remains a reviewed but unaccepted draft, and this cutover's
terminal cleanup, boundary and cost records must be read from its RunManifest
after the Worker exits. No Windows, cross-host, unobserved-group recovery, OS
write sandbox, automatic acceptance/merge or 24-hour soak support is claimed.

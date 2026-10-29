# Known Gaps and Next Safety Work

> Priority superseded 2026-10-29: use
> [CURRENT_STATE.md](./CURRENT_STATE.md) for the current order. This file remains
> the incident and evidence record for the process-ownership investigation.
>
> Recorded: 2026-10-28
>
> Integrated by the v1.2 merge:
> WorkspaceBoundary v1 `c04bb96ea98004493b4d88cc5cbe56e052fa0915` and
> WorkerProcessTree v1.1 `9a38174a872d70b7a250225c31fa7ce4efdcf06e`;
> nested registry live cleanup v1.2 code `fac4606` and cutover evidence
> `7b4544f`.

## Current state

WorkspaceBoundary v1 has passed its task verifier:

- focused tests: 76/76;
- complete suite: 432/432;
- no worker path-audit escape;
- no active worker lease or Supervisor lock at completion.

WorkspaceBoundary v1 is a guard-only detection layer. It does not prevent
writes. A later WorkerProcessTree v1.1 run launched the Supervisor from the
accepted WorkspaceBoundary code and produced a non-null clean guard record, so
real self-host execution is now measured.

WorkerProcessTree v1.1 has also passed its task verifier:

- focused process/WB/Supervisor set: 89/89;
- complete suite: 440/440;
- no worker path-audit escape;
- no active worker lease, Supervisor lock or test helper left behind.

The original `workspace-boundary-v1` run remains blocked history. Manual
adoption would have been the wrong model because its timed-out integration
worktree still needed code, tests and evidence changes. A new Supervisor run
was started from the reviewed draft (`3645c4c`) and produced the accepted
`c04bb96` integration head instead.

## Newly observed P0 issues

### 1. Nested worker process groups can escape cleanup

The first Codex implementation run timed out while its worker had started a
repository-wide test command. The timeout cleaned the recorded CLI process
group `8783`, but a nested shell/test group `99841` remained alive and
reparented to PID 1. The leaked group contained the full Vitest/Node runner and
esbuild helper processes, all with a worktree cwd.

The orphan was read-only inspected, proven to contain only that run's worktree
processes, then terminated as the exact group `99841`. No process-name or broad
scan was used.

This disproves the broad implication that a WorkerLease/POSIX group always owns
the complete worker process tree. A CLI or test runner can create a new session
or process group. WorkerProcessTree v1.1 now covers, while the top-level leader
is alive or its relation was sampled before exit:

- the dedicated top-level worker group;
- descendants that stayed in that group.

It still does not cover:

- descendants that created a separate group/session while the leader was
  alive;
- nested groups after a controller is already dead and the parent relation has
  been lost.

### 2. Self-host code provenance lag

The process that orchestrates a change loads cliyard from the main checkout, not
from the task's worktree. Therefore the run that implements a control-plane
feature cannot exercise that new code unless the CLI is explicitly launched
from an already accepted integration worktree.

The WorkerProcessTree v1.1 run launched the Supervisor from `c04bb96` while
targeting the main checkout. Its RunManifest contains a non-null
`workspaceBoundary: clean` record, proving real self-host execution.

### 3. Accepted integration and governance history have diverged

The accepted process-tree integration head is
`9a38174a872d70b7a250225c31fa7ce4efdcf06e`. The main checkout's WorkerLease
documentation commit `53cc0a2e72cd159b1caf1d1c6e3c79baad941ef3`,
the committed `.agents` rules/skills, and their follow-up documentation are not
ancestors of that integration head.

Consequences:

- a task worktree based on `9a38174` contains the accepted process code but not
  the latest governance documents;
- the next self-host run must not pretend the two histories are interchangeable;
- manual integration must preserve the accepted code and the newer governance
  files instead of fast-forwarding one side over the other.

This is a provenance/integration gap, not a reason to dispatch from the main
checkout's older process implementation.

## Existing P0/P1 gaps

| Priority | Gap | Current state | Next action |
|---|---|---|---|
| P0 | Live nested descendant process groups | Closed for live/sampled trees: WorkerProcessTree v1.1 cleans exact external descendants on timeout/cancel | Keep measured regressions |
| P0 | OS write prevention | WorkspaceBoundary detects after the fact | Provider-neutral SandboxProvider |
| P0 | Controller-death recovery of nested groups | Lease stores the top-level worker group only | Follow after live-leader cleanup |
| P1 | WorkspaceBoundary evidence parser consistency | Optional digest fields are format-checked but not fully cross-validated against add/remove/modify semantics | Harden with the next boundary schema change |
| P1 | Active RunManifest trust | The exact current manifest is excluded because extension checkpoints legitimately update it | Keep explicit; do not widen the exclusion |
| P1 | Guard policy configuration | Extra roots, exclusions and caps exist in the core but are not exposed through Project config/CLI | Expose a versioned policy when prevention is designed |
| P1 | Large/ignored trees | The guard walks physical entries and fails closed at 100,000 entries; it does not use `.gitignore` | Profile real Java/Flutter/Rust repositories before changing defaults |
| P1 | Credential and network isolation | Guard hashes files and never inspects credentials, sockets or network traffic | SandboxProvider capability phases |
| P1 | Accepted integration/main governance divergence | `9a38174` has accepted process code but not current main governance docs; both branches carry non-overlapping reviewed changes | Preserve both lineages during manual integration; do not reset either side |
| P0 | ProfileCatalog and real binding activation | ExecutionProfile is frozen, but endpoint/account activation is not verified | After process safety |
| P0 | Per-run ownership and hierarchical admission | Queue is still sequential with a repo-global Supervisor lock | After routing prerequisites |
| P0 | Stable Control API | Internal control snapshot exists; no versioned client-neutral API/event stream | After routing/parallel semantics |
| P1 | Automatic attempt policy/controller | Retry remains explicit; no controller heartbeat or lookahead loop | After the prerequisites above |
| P2 | Windows Job Objects and dynamic routing scores | Not implemented | Later |

## Decision

The live-leader nested-process gap is closed by WorkerProcessTree v1.1. The
remaining process-ownership gap is controller death after a nested group has
already detached from the top-level worker.

The next implementation priority is **controller-death nested process
ownership**, because WorkerLease still persists only the top-level worker group.
That slice must extend the lease/store/recovery protocol without weakening
exact identity checks.

Immediately after it, implement the provider-neutral **SandboxProvider** for OS
write prevention. ProfileCatalog and grid admission remain behind process and
filesystem safety.

## Planned v1 slice

The next Plan is:

- [controller-death-nested-processes-v1.md](../design/controller-death-nested-processes-v1.md);
- [controller-death-nested-processes-v1.plan.json](../design/controller-death-nested-processes-v1.plan.json).

It has two sequential tasks:

1. `controller-death-nested-core`: persist exact sampled nested identities in
   WorkerLease and extend exact-identity recovery when the top-level leader is
   gone.
2. `controller-death-nested-evidence`: document only the measured behavior after
   the core task is accepted.

The core task intentionally excludes SandboxProvider, Windows Job Objects,
cross-host recovery, automatic resume and RunManifest rewriting.

## First self-host attempt observation

Run `0c199514-b24e-4f7a-a855-f2b8eb4484b4` executed
`controller-death-nested-core`; the dependent evidence task remained blocked.
The run was rejected by process cleanup, not by code assertions:

```text
process_tree_cleanup_failed
descendant snapshot exceeds 256 related processes
residualCount=0
```

Independent post-run review measured focused **56/56**, build pass, complete
suite **455/455** in **26.08 s**, no changed path outside the four frozen
`writePaths`, `WorkspaceBoundary=clean`, and no surviving process groups from
the recorded test fixtures. The reviewed draft is preserved at
`af76d3a33793a8b9c2d6f5a1009c7f899c3dc74c` but is not accepted.

Two follow-up gaps were confirmed:

| Priority | Gap | Evidence | Next action |
|---|---|---|---|
| P0 | Exact-pid nested ownership does not scale to a large owned group | A legitimate test command produced more than 256 external descendants; cleanup failed closed despite zero residual after the run | Compact ownership by nested pgid with exact leader identity and guarded group signals |
| P1 | Verifier command timeout has little headroom | Initial verifier `npm test` timed out at 30 s; an independent full run passed in 26.08 s | Add per-command or project-level verifier timeout policy before relying on full-suite commands as near-limit gates |

The next Plan is:

- [nested-process-group-ownership-v1.1.md](../design/nested-process-group-ownership-v1.1.md);
- [nested-process-group-ownership-v1.1.plan.json](../design/nested-process-group-ownership-v1.1.plan.json).

It starts from reviewed draft `af76d3a`, not from an accepted integration.
That provenance must remain explicit; the draft is not silently promoted to
accepted code.

## Second self-host attempt and cutover

The nested-group Plan run
`e2e4825c-a9d7-4b0b-9cb1-e8c25ad075c5` produced the group-compaction
implementation and passed independent focused **62/62**, build and complete
suite **461/461** in **25.89 s**, including real 512-member live and
controller-death fixtures. It was nevertheless rejected by the same 256-PID
failure because the outer Worker was still launched by accepted `9a38174`
code, not by the implementation in its own worktree.

The reviewed v1.1 draft is preserved at
`a9d6e00` on
`cliyard/mvsbxg7y-nested-process-group-compaction-core`. It is a reviewed
cutover base, not an accepted integration.

The next Plan is documentation-only and must run with Supervisor loaded from
that reviewed draft:

- [nested-process-group-cutover-v1.md](../design/nested-process-group-cutover-v1.md);
- [nested-process-group-cutover-v1.plan.json](../design/nested-process-group-cutover-v1.plan.json).

This is required to prove the new outer manager can own a high-fan-out Worker
lifecycle. It does not retroactively accept the two blocked RunManifests.

## Third cutover attempt and registry-boundary gap

Cutover run `d4c96416-51b8-48b5-9f26-f1119f90784e` did load Supervisor from
reviewed draft `a9d6e00`. Its documentation-only Worker passed focused 62/62,
build and complete 461/461 in 25.999 seconds, changed only the four allowed
documentation paths, and had a clean WorkspaceBoundary.

It was still rejected because the live lease reached the bounded 16-group
registry while the current process table was complete enough to enumerate the
groups. The recorded outcome had zero residual processes and zero group
signals:

```text
process_tree_cleanup_failed
descendant snapshot exceeded a bounded nested registry limit
residualCount=0
signalledGroups=0
```

This exposes a P0 design error: live cleanup completeness and durable
controller-death recovery completeness are not the same condition. The live
cleanup may enumerate all currently reachable groups within the 8,192-row table
cap, while the lease must remain bounded. A truncated lease can make future
controller-death recovery `needs_human`; it must not by itself reject a live
cleanup that proves all current groups gone.

The next Plan is prepared but not dispatched:

- [nested-registry-live-cleanup-v1.2.md](../design/nested-registry-live-cleanup-v1.2.md);
- [nested-registry-live-cleanup-v1.2.plan.json](../design/nested-registry-live-cleanup-v1.2.plan.json).

Before another paid self-host run, review whether this live-cleanup versus
durable-recovery separation is the intended semantic boundary.

## Next-run execution rule

For subsequent self-host runs:

- commit the design/Plan files first;
- compile and commit contracts from the accepted integration base;
- launch the Supervisor CLI from the latest accepted integration worktree,
  while targeting the main checkout;
- require a non-null guard record for the produced run;
- keep the worktrees and require manual diff review before merge.
## 2026-10-29 route correction

The v1.2 Plan was frozen, dispatched and validated through a second cutover run
loaded from the reviewed implementation draft. Its code base is `fac4606`; the
cutover integration candidate is `7b4544f`. The implemented distinction is:

```text
live cleanup completeness
durable controller-death recovery completeness
```

After v1.2, the next evidence gap is not ProfileCatalog. It is Harness Eval v0,
because prompt, Skill, background-task and review changes need a repeated
pinned baseline before routing automation can safely amplify them. Current
ordering and release gates are in `CURRENT_STATE.md`.

## 2026-10-29 closeout run and DSH compatibility gaps

Closeout run `c4d786ec-2dbe-449f-a65e-a23c6a6d673e` remained blocked after the
wrapper implementation itself passed focused 33/33, build and an independently
reviewed 513/513 complete suite. The run is rejected for infrastructure
reasons, not promoted from the candidate worktree.

| Priority | Gap | Evidence | Next action |
|---|---|---|---|
| P0 | High-fanout external-group cleanup | Cleanup tracked 1,302 groups; `listGroupMembers` ran a full process-table scan per group, and one vanished group's inspection timed out after 5 seconds | Read one bounded process-table snapshot per cleanup cycle, project exact pgids in memory, and retain a bounded race retry |
| P0 | DSH plugin compatibility is unmeasured | Local DSH is `0.2.1-rc.3`; upstream rc.4 is low risk, while alpha.2 requires Node 24.9 and changes tool/session/model APIs | Add a DSH/Node compatibility matrix and `engines.dsh`; keep core Node 20 |
| P0 | Monitor output is not safely rendered | `plugins/dsh-cliyard/lib/monitor.js` interpolates ledger fields into `innerHTML` | Render through DOM/text nodes or typed components, add CSP, and authenticate future action endpoints |
| P1 | Verifier command timeout | Mainline suite is 464/464 in 26.45 seconds against a fixed 30-second verifier limit; the candidate suite took 28.01 seconds | Add contract/project-level verifier command timeout |
| P1 | Guard budget resets across repair attempts | The rejected task recorded two `$16` invocation guards and `guardBudgetUsd=32`, while the per-invocation cumulative policy did not span attempts | Build a task-level budget ledger used by initial and repair invocations |
| P1 | No client-neutral Control API | The plugin reads one ledger file and its `watchLedger` callback is currently a no-op | Add snapshot/event/status/projection APIs with replay cursors and client conformance tests |
| P1 | DSH features overlap without an integration seam | Forge, Statistics and `subagent_oar` now cover adjacent UI/worker capabilities | Reuse or link; keep contracts, evidence, budgets and integration verdict in cliyard |

DSH-specific source review and non-claims are recorded in
[evidence/DSH_0_2_2_ALPHA_2_REVIEW.md](evidence/DSH_0_2_2_ALPHA_2_REVIEW.md).

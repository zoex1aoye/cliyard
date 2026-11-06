# cliyard Current State

> Verified: 2026-11-06 (Asia/Shanghai)
>
> This page is the single current-status authority for implementation order,
> known gaps and the next executable slice. Product rationale remains in
> `KEY_MIND.md`, `PRODUCT_STRATEGY_V2.md` and
> `design/continuous-harness-v2.md`; those documents must not maintain a second
> competing "current next step". Architecture direction for the rewrite is
> `design/delivery-control-plane-v2.md` (reviewed draft; human approval still
> required before P1 Plans are frozen for dispatch).

Git history, frozen contracts, RunManifest and evidence remain the authorities
for exact code and run facts. This page summarizes their current relationship.

## Status vocabulary

- **merged**: reachable from the checked-out mainline branch.
- **accepted, not integrated**: task evidence supports the commit, but a human
  integration decision has not merged it into the mainline.
- **reviewed draft**: tests passed in a rejected or interrupted run, but cleanup,
  lineage or acceptance evidence is incomplete.
- **implemented**: code and tests exist on the named commit.
- **design only**: intended behavior and gates are specified, not executable.
- **unverified**: no current measurement proves the claim.

`accepted` never means auto-merged. A green task does not prove that the next
self-host controller loaded the new code.

## Lineage at this checkpoint

- Mainline branch: `codex/supervisor-v0-baseline` tip `a0609e8` (PR stack
  #1–#5 landed 2026-11-06 Asia/Shanghai).
- Pilot safety reliability closeout run
  `6919db6d-9948-42f4-b5d6-04111f5d0dba` is accepted and merged: closeout merge
  `c1d0dbb`, integration head includes `fb665ab` (`task-budget-ledger`). Evidence:
  [PILOT_FOUNDATION_RELIABILITY.md](evidence/PILOT_FOUNDATION_RELIABILITY.md).
- Cost-truth Supervisor resume retention is accepted and merged at `c5714db`.
  The historical missing first attempt of that pilot run is recorded as an
  import constraint in
  [COST_TRUTH_HISTORICAL_MISSING.md](evidence/COST_TRUTH_HISTORICAL_MISSING.md);
  the RunManifest is not rewritten.
- Legacy-seam freeze:
  [P0_LEGACY_SEAM_FREEZE.md](P0_LEGACY_SEAM_FREEZE.md) (**binding** on mainline
  after land `a0609e8`).
- WorkspaceBoundary v1 is accepted at `c04bb96` but is not an ancestor of all
  current governance commits.
- WorkerProcessTree v1.1 is accepted at `9a38174` but is not merged into the
  current mainline.
- Controller-death nested-process drafts `af76d3a` and `a9d6e00` are reviewed
  drafts, not accepted integration.
- The v1.2 implementation draft is `fac4606`; its cutover run
  `3b07e58b-57a7-48d8-84cd-d6818478884a` completed with accepted evidence and
  integration head `7b4544f`. It is merged into the mainline by `14db47f`.
- EvidenceBundle/Harness Eval implementation run `0517d3ba` remains blocked
  history. Both root drafts completed full 473/473 locally, but the outer
  manager reused a vanished nested-group leader PID and rejected cleanup with
  `residualCount=0`.
- Continuation run `cd40095a-8b11-4f11-8856-76d1d9f01d2f` is blocked overall.
  Its EvidenceBundle integration and Harness Eval CLI tasks are accepted at
  `b1fb9ac` and `f546a54`; the integration head is `3abbc79`. Its evidence task
  is rejected, with a retained draft worktree. That head is not the current
  mainline tip.
- Closeout run `c4d786ec-2dbe-449f-a65e-a23c6a6d673e` remains blocked history;
  the later pilot foundation run supersedes its open reliability items for
  process-table batch cleanup, verifier timeout policy, budget ledger, DSH
  monitor hardening and Harness Eval wrapper/evidence closeout.
- Node baseline remains 20. Node 22, SRT and OS permission experiments require a
  separate decision.
- DSH is still a replaceable cockpit, not a control-plane dependency. See
  [DSH_0_2_2_ALPHA_2_REVIEW.md](evidence/DSH_0_2_2_ALPHA_2_REVIEW.md).

## Implemented and measured on the mainline

- durable foreground Supervisor, atomic RunManifest and integration checkpoint;
- Plan compiler, frozen TaskContract, write/path audit and Worktree isolation;
- Plan-backed queue, manual adoption and run-id binding;
- read-only queue status, event journal and resource/provider snapshots;
- structured failure taxonomy and explicit cost truth, including Supervisor
  resume retention of abandoned-attempt observations (`c5714db`);
- health-gated deadline extension and opted-in budget continuation with a
  cumulative task-level budget ledger (`fb665ab` / pilot closeout);
- bounded process-table cleanup projection, explicit verifier command timeout
  policy, DSH monitor CSP / non-string HTML path, and Harness Eval wrapper
  semantics from the pilot foundation closeout (`c1d0dbb`);
- WorkerLease v1 for same-host top-level POSIX group recovery;
- RuntimeManager with leased loopback ports, readiness and cleanup records;
- Task Architect that only produces a human-reviewable Plan.

These facts do not imply parallel queue operation, dynamic routing, OS security,
24-hour unattended operation or full process-tree recovery.

## Accepted but not integrated

### WorkspaceBoundary v1

Commit `c04bb96` measures protected-root before/after integrity detection. It is
guard-only: it does not prevent filesystem writes, credential access or network
egress, and it cannot detect a write that was reverted before comparison.

### WorkerProcessTree v1.1

Commit `9a38174` tracks and cleans live/sampled nested descendants with exact
POSIX identity and bounded process-table evidence. It does not yet provide a
complete durable recovery path after controller death for nested groups.

### Nested registry live cleanup v1.2

Implementation draft `fac4606` separates live cleanup completeness from durable
recovery completeness. The independently reviewed focused set is **65/65**,
build passes and the complete suite is **464/464**.

Cutover run `3b07e58b` loaded Supervisor from that draft, targeted the main
checkout and produced integration candidate `7b4544f`, now integrated by
merge commit `14db47f`:

- path audit: only `docs/evidence/NESTED_REGISTRY_LIVE_CLEANUP_V1_2.md`;
- WorkspaceBoundary: clean;
- process cleanup: `cleanupCompleteness=complete`,
  `durableRecoveryCompleteness=truncated`, `residualCount=0`;
- 297 live external groups observed, only 16 persisted;
- CLI-estimated cost: `$2.006743`, non-authoritative.

The evidence document was authored while its Worker was alive, so it correctly
marks its own terminal cleanup as pending and points to the RunManifest. The
RunManifest contains those terminal fields. That mismatch is the next durable
evidence-model gap: final evidence must be synthesized by the controller after
Worker exit rather than requiring the Worker to predict its own post-exit
record.

### Controller EvidenceBundle and Harness Eval CLI

The accepted integration head `3abbc79` contains the controller-owned terminal
EvidenceBundle, `eval run/compare/handoff`, six local scenarios and their
focused tests. Both component tasks are accepted, but the overall continuation
run remains blocked and the evidence task remains rejected. This base is not
merged into the mainline.

## Blocked history

The earlier controller-death attempts exposed a design error, not merely a test
failure:

```text
live cleanup completeness
  !=
durable controller-death recovery completeness
```

A bounded WorkerLease may deliberately omit later external groups. That
truncation means a future controller cannot reconstruct the complete ownership
set and must return `needs_human`; it does not prove that a live controller with
a complete current process-table snapshot failed to clean the reachable tree.

Implementation run `d058568e` remains rejected history even though it produced
the reviewed draft. The v1.2 cutover now demonstrates the corrected semantics;
neither earlier RunManifest is retroactively accepted.

## Current priority

The order is a dependency order, not a promise of parallel delivery. The
full rationale and open decisions live in
[delivery-control-plane-v2.md](../design/delivery-control-plane-v2.md); this
list is its summary. Steps 2+ each start only after a human-approved Plan.

0. **Human review of Delivery Control Plane v2** — approve or amend the
   native-first execution design before any P1 Plan is frozen for dispatch.
   Still open.

1. **P0 legacy-seam closeout (authority)** — **complete on mainline**
   (`a0609e8`).
   - Pilot foundation reliability: **implemented / merged** (`c1d0dbb`,
     integration includes `fb665ab`). Bounded process-table cleanup, verifier
     timeout policy, cumulative budget ledger, DSH monitor hardening and
     Harness Eval wrapper/evidence closeout are on the ancestry. See
     [PILOT_FOUNDATION_RELIABILITY.md](evidence/PILOT_FOUNDATION_RELIABILITY.md).
   - Cost-truth resume retention: **implemented / merged** (`c5714db`).
   - Historical missing attempt: **marked** in
     [COST_TRUTH_HISTORICAL_MISSING.md](evidence/COST_TRUTH_HISTORICAL_MISSING.md)
     for StateStore import; RunManifest not rewritten.
   - Freeze list: **binding** in
     [P0_LEGACY_SEAM_FREEZE.md](P0_LEGACY_SEAM_FREEZE.md) after land of PRs
     #1–#5.
   - No further P0 implementation slice is queued.

2. **P1 StateStore SQLite boundary** — **next executable implementation slice**
   after DCP v2 review.
   Move task/attempt/event state from JSON files to SQLite behind one store
   interface, using the ExecutionHandle schema (runtime handle authority,
   PID diagnostic only) from delivery-control-plane-v2. Keep design, plans
   and contracts in Git and evidence in run/attempt directories. Import must
   honor the historical missing-attempt constraint above.

3. **Daemon boundary and Control API**
   Split the foreground-only Supervisor into `cliyardd` (Node 20) plus an
   independent ExecutionSupervisor (containerd shim model). Expose a
   versioned Control API with snapshots and event replay. The controller
   never owns process trees.

4. **ExecutionSupervisor macOS backend + runtime conformance**
   POSIX process group + launchd backend with explicit capability labels,
   plus a conformance suite covering setsid escape, orphan grandchildren,
   controller kill/re-attach and cleanup. Linux systemd-run and Windows Job
   Object backends follow the same interface.

5. **SandboxAdapter + nono (native-first)**
   Wrap a fixed nono version behind `SandboxAdapter` with a capability gate:
   refuse or require explicit approval when a task's requirements exceed the
   backend; never silently downgrade. Sandbox reports enter EvidenceBundle.
   MXC stays an evaluation candidate for native Windows.

6. **Background VerificationTask**
   Decouple long verification from Worker lifecycle. Persist owner, artifact
   commit, output offset, delivered latch, timeout, liveness and startup
   recovery, with explicit `queued/running/stopping/succeeded/failed/canceled/
   lost` states.

7. **Clean-context Reviewer**
   Review only the exact diff, approved requirement and bounded test/runtime
   evidence. Persist structured `ReviewFinding` records and verify every finding
   against code before repair.

8. **Human intervention ledger**
   Record Retry, Judge, Approve, Carry, Trigger and Stand-in interventions so
   design work can reduce repeated manual steps without treating silence or
   abandonment as success.

9. **SkillPack provenance**
   Version the rule/skill input by id, digest, entrypoint and capability. A run
   must be able to answer which instructions influenced its behavior.

10. **ProfileCatalog, routing and hierarchical admission**
   Route only among activated provider/account/model/CLI bindings. Unknown
   concurrency begins with one probe; CPU/RAM/runtime/port/provider limits apply
   globally to queue items and Plan waves.

## Actual-project readiness

These are capability gates, not date estimates or a percentage score.

| Use mode | Current assessment | Gate before use |
|---|---|---|
| Supervised single-repository pilot | Near, but not yet recommended | Complete DCP v2 review and keep human Plan/diff gates; do not claim readiness from P0 land alone |
| Small-team real project | Not ready | Add background verification, OS-level write isolation, authenticated Control API/event replay, stable DSH compatibility, and intervention history |
| Parallel multi-module delivery | Not ready | Background verifier, per-run ownership, provider/runtime admission, deterministic integration lineage and measured DSH/UI lifecycle behavior |
| Overnight or 24-hour unattended operation | Far | Durable controller/daemon recovery, complete process ownership, provider quota/balance handling, bounded soak, incident recovery and an auditable human-escalation path |

Candidate pilot envelope after the reliability and monitor-security gates:

- one trusted repository on one macOS host;
- Claude Code using the currently exercised DeepSeek compatibility profile,
  with no production guarantee for other models or providers;
- one foreground Supervisor or explicitly sequenced runs;
- human Plan approval, human diff review and no automatic merge or push;
- no claim of OS sandboxing, unlimited parallel work or unattended operation.

The first credible supervised pilot should start only after item 0 (DCP v2
review) has a human decision. Priority item 1 is complete on mainline. Team use
additionally requires the background verifier, sandbox, clean-context review
and authenticated event/action API gates.

## Release gates

Before claiming a continuously working harness:

- every controller restart resumes from disk rather than chat history;
- every background verifier survives Worker exit and has startup recovery;
- a clean-context review is independent of the author's session;
- one controlled eval shows no must-not-break regression;
- sandbox and cleanup evidence bind to exact identities and commits;
- terminal evidence is assembled after Worker exit, path audit, cleanup and cost
  finalization;
- human interventions and their outcomes are auditable;
- parallel admission is observed, not hard-coded to three;
- accepted branches still require a human integration decision;
- a bounded soak has evidence. Until then, "24-hour continuous delivery" is a
  target, not a capability claim.


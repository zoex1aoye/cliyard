# cliyard Current State

> Verified: 2026-10-29
>
> This page is the single current-status authority for implementation order,
> known gaps and the next executable slice. Product rationale remains in
> `KEY_MIND.md`, `PRODUCT_STRATEGY_V2.md` and
> `design/continuous-harness-v2.md`; those documents must not maintain a second
> competing "current next step".

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

- Mainline branch: `codex/supervisor-v0-baseline`.
- v1.2 Plan commit: `36dd985`; implementation contracts commit: `ddfde41`.
- v1.2 cutover Plan commit: `90b516e`; cutover contracts commit: `74b54b9`.
- WorkspaceBoundary v1 is accepted at `c04bb96` but is not an ancestor of all
  current governance commits.
- WorkerProcessTree v1.1 is accepted at `9a38174` but is not merged into the
  current mainline.
- Controller-death nested-process drafts `af76d3a` and `a9d6e00` are reviewed
  drafts, not accepted integration.
- The v1.2 implementation draft is `fac4606`; its cutover run
  `3b07e58b-57a7-48d8-84cd-d6818478884a` completed with accepted evidence and
  integration head `7b4544f`. It is merged into the mainline by `14db47f`.
- Post-merge build passed. The first complete-suite run was **463/464** because
  the deadline-extension in-flight checkpoint timed out once; that file then
  passed **13/13**, and a second complete run passed **464/464**. This is an
  observed flake, not a stable-green claim.
- No active Supervisor lock, queue lock or WorkerLease remained after the
  cutover. Historic leases include released and cleanup-failed records; they
  must not be erased or rewritten.
- Node baseline remains 20. Node 22, SRT and OS permission experiments require a
  separate decision.

## Implemented and measured on the mainline

- durable foreground Supervisor, atomic RunManifest and integration checkpoint;
- Plan compiler, frozen TaskContract, write/path audit and Worktree isolation;
- Plan-backed queue, manual adoption and run-id binding;
- read-only queue status, event journal and resource/provider snapshots;
- structured failure taxonomy and explicit cost truth;
- health-gated deadline extension and opted-in budget continuation;
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

The order is a dependency order, not a promise of parallel delivery.

1. **Controller EvidenceBundle + Harness Eval v0**
   The next Plan adds a controller-owned final evidence bundle and a repeated,
   deterministic local Harness eval. It includes the observed deadline flake as
   a scenario and does not hide missing provider metrics.

2. **Background VerificationTask**
   Decouple long verification from Worker lifecycle. Persist owner, artifact
   commit, output offset, delivered latch, timeout, liveness and startup
   recovery, with explicit `queued/running/stopping/succeeded/failed/canceled/
   lost` states.

3. **SandboxProvider**
   Add a provider-neutral OS isolation boundary. WorkspaceBoundary remains the
   fallback detector. Candidate backends include SPACE, microsandbox and
   platform-native wrappers; Node 22-only permission APIs are not assumed.

4. **Clean-context Reviewer**
   Review only the exact diff, approved requirement and bounded test/runtime
   evidence. Persist structured `ReviewFinding` records and verify every finding
   against code before repair.

5. **Human intervention ledger**
   Record Retry, Judge, Approve, Carry, Trigger and Stand-in interventions so
   design work can reduce repeated manual steps without treating silence or
   abandonment as success.

6. **SkillPack provenance**
   Version the rule/skill input by id, digest, entrypoint and capability. A run
   must be able to answer which instructions influenced its behavior.

7. **ProfileCatalog, routing and hierarchical admission**
   Route only among activated provider/account/model/CLI bindings. Unknown
   concurrency begins with one probe; CPU/RAM/runtime/port/provider limits apply
   globally to queue items and Plan waves.

8. **Versioned Control API and replaceable UI**
   Stabilize a local API/SSE event model before making DSH or another GUI the
   product entry. UI clients display and request actions; they are never
   authority.

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


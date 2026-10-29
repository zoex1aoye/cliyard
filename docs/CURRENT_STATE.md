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
- Latest Plan-only commit: `8da5da8` (`docs: plan live cleanup recovery
  separation`).
- WorkspaceBoundary v1 is accepted at `c04bb96` but is not an ancestor of all
  current governance commits.
- WorkerProcessTree v1.1 is accepted at `9a38174` but is not merged into the
  current mainline.
- Controller-death nested-process drafts `af76d3a` and `a9d6e00` are reviewed
  drafts, not accepted integration.
- The v1.2 Plan in this change is not frozen or dispatched until its separate
  contracts commit exists.
- No active Supervisor lock, queue lock or WorkerLease was observed at the start
  of this checkpoint. Historic leases include released and cleanup-failed
  records; they must not be erased or rewritten.
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

## Reviewed but blocked

The three controller-death attempts exposed a design error, not merely a test
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

The next executable slice is therefore
`design/nested-registry-live-cleanup-v1.2.plan.json`. It must preserve a bounded
lease while allowing complete, exact live cleanup to succeed.

## Current priority

The order is a dependency order, not a promise of parallel delivery.

1. **v1.2 cleanup/recovery separation**  
   Close the current self-host blocker and add real >16-group, 512-member-group
   and truncated-recovery tests.

2. **Harness Eval v0**  
   Create repeated, pinned baselines for normal work, high fanout, verifier
   timeout, controller SIGKILL, path escape, compaction/handoff and budget
   continuation. Measure pass rate, flipped tasks, requests, tokens, cache,
   wall time, cost truth and human interventions.

3. **Background VerificationTask**  
   Decouple long verification from Worker lifecycle. Persist owner, artifact
   commit, output offset, delivered latch, timeout, liveness and startup
   recovery, with explicit `queued/running/stopping/succeeded/failed/canceled/
   lost` states.

4. **SandboxProvider**  
   Add a provider-neutral OS isolation boundary. WorkspaceBoundary remains the
   fallback detector. Candidate backends include SPACE, microsandbox and
   platform-native wrappers; Node 22-only permission APIs are not assumed.

5. **Clean-context Reviewer**  
   Review only the exact diff, approved requirement and bounded test/runtime
   evidence. Persist structured `ReviewFinding` records and verify every finding
   against code before repair.

6. **Human intervention ledger**  
   Record Retry, Judge, Approve, Carry, Trigger and Stand-in interventions so
   design work can reduce repeated manual steps without treating silence or
   abandonment as success.

7. **SkillPack provenance**  
   Version the rule/skill input by id, digest, entrypoint and capability. A run
   must be able to answer which instructions influenced its behavior.

8. **ProfileCatalog, routing and hierarchical admission**  
   Route only among activated provider/account/model/CLI bindings. Unknown
   concurrency begins with one probe; CPU/RAM/runtime/port/provider limits apply
   globally to queue items and Plan waves.

9. **Versioned Control API and replaceable UI**  
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
- human interventions and their outcomes are auditable;
- parallel admission is observed, not hard-coded to three;
- accepted branches still require a human integration decision;
- a bounded soak has evidence. Until then, "24-hour continuous delivery" is a
  target, not a capability claim.


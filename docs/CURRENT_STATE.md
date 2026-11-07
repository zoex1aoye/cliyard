# cliyard Current State

> Verified: 2026-11-07 (Asia/Shanghai) — SkillPack provenance merged
> (`8e33df3` / PR #18); ProfileCatalog + hierarchical admission v0 on branch
> (see evidence).
>
> This page is the single current-status authority for implementation order,
> known gaps and the next executable slice. Product rationale remains in
> `KEY_MIND.md`, `PRODUCT_STRATEGY_V2.md` and
> `design/continuous-harness-v2.md`; those documents must not maintain a second
> competing "current next step". Architecture direction for the rewrite is
> `design/delivery-control-plane-v2.md` (reviewed draft; human approval still
> required before further P3+ Plans are frozen for dispatch).

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

- Mainline branch: `codex/supervisor-v0-baseline` (includes PR stack #1–#6 and
  earlier accepted merges below). Tip moves with each land; do not treat a
  stale SHA in chat as authority — use `git rev-parse HEAD` on the branch.
- **P0** closeout and freeze binding: land `a0609e8` / docs `d0a85a1`; freeze
  list [P0_LEGACY_SEAM_FREEZE.md](P0_LEGACY_SEAM_FREEZE.md).
- **P1** StateStore v0 merged at `cdde392` (core + read projection).
- **P1b** StateStore write cutover merged at `1fd737f` (supervisor run + queue
  single-writer; JSON exports derived). Evidence:
  [STATESTORE_WRITE_CUTOVER.md](evidence/STATESTORE_WRITE_CUTOVER.md).
- **P2a** daemon + read-only Control API merged at `1f4be2d` (`src/daemon/`).
- **P2b** ExecutionSupervisor v0 merged at `6f9e550` (`src/execution/`,
  RuntimeHandle authority + continuity + conformance).
- **SQLite dependency**: `better-sqlite3` is now declared; fresh DB parent
  mkdir is fixed; focused SQLite evidence in
  [STATESTORE_SQLITE_AUTHORITY.md](evidence/STATESTORE_SQLITE_AUTHORITY.md).
  JSON-file fallback remains when the native module is unavailable.
- Pilot closeout `c1d0dbb` / `fb665ab` and cost-truth retention `c5714db` remain
  on the ancestry. Historical missing attempt import constraint:
  [COST_TRUTH_HISTORICAL_MISSING.md](evidence/COST_TRUTH_HISTORICAL_MISSING.md).
- WorkspaceBoundary v1 (`c04bb96`) and WorkerProcessTree v1.1 (`9a38174`) are
  accepted lineage pieces; controller-death nested-process drafts `af76d3a` /
  `a9d6e00` remain reviewed drafts, not closed recovery.
- Node baseline remains `>=20`. DSH is a replaceable cockpit. See
  [DSH_0_2_2_ALPHA_2_REVIEW.md](evidence/DSH_0_2_2_ALPHA_2_REVIEW.md).

## Implemented and measured on the mainline

- durable foreground Supervisor, atomic RunManifest and integration checkpoint;
- Plan compiler, frozen TaskContract, write/path audit and Worktree isolation;
- Plan-backed queue, manual adoption and run-id binding;
- **StateStore** event-sourced facts + projection (`cdde392`) with supervisor
  run + queue write authority cutover (`1fd737f`); intended durable backend is
  SQLite via `better-sqlite3` when installed;
- **`cliyardd`** + read-only Control API (`1f4be2d`);
- **ExecutionSupervisor** interface + RuntimeHandle authority + continuity
  policy + conformance suite (`6f9e550`);
- structured failure taxonomy and cost truth (including resume retention
  `c5714db`);
- pilot foundation reliability closeout (`c1d0dbb` / `fb665ab`);
- WorkerLease v1, RuntimeManager, Task Architect, deterministic integration
  gate, estimate-plan telemetry calibration, Linux verifier process-group
  timeout reclaim.

These facts do not imply parallel queue operation, dynamic routing, OS sandbox,
24-hour unattended operation, launchd/Job Object parity, or authenticated
Control API write/action endpoints.

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
list is its summary. New slices start only after a human-approved Plan.

0. **Human review of Delivery Control Plane v2** — approve or amend the
   native-first execution design before further P3+ Plans are frozen for
   dispatch. Still open.

1. **P0 legacy-seam closeout** — **complete** (`a0609e8`, freeze binding).

2. **P1 / P1b StateStore** — **complete on mainline** (`cdde392`, `1fd737f`).
   SQLite driver declared and measured
   ([STATESTORE_SQLITE_AUTHORITY.md](evidence/STATESTORE_SQLITE_AUTHORITY.md)).
   Ledger + event-journal **production attach** wired
   ([LEDGER_JOURNAL_PRODUCTION_CUTOVER.md](evidence/LEDGER_JOURNAL_PRODUCTION_CUTOVER.md));
   control-plane StateStore path **unified** on `.cliyard/state.db`
   ([STATESTORE_PATH_UNIFY.md](evidence/STATESTORE_PATH_UNIFY.md));
   honor
   [COST_TRUTH_HISTORICAL_MISSING.md](evidence/COST_TRUTH_HISTORICAL_MISSING.md)
   on any remaining import. Residual: non-repo fixture ledger paths still use
   JSON (unit-test only).

3. **P2a daemon + Control API** — **complete on mainline** (`1f4be2d`).
   Read-only `/v1/status|events|runs` remains. Authenticated write/action
   endpoints and daemon-owned dispatch are **deferred** (P5 human-machine /
   Control API write surface), not a blocking residual before P3.

4. **P2b ExecutionSupervisor** — **complete on mainline** (`6f9e550`).
   Residual: launchd / systemd-run / Windows Job Object backends beyond the
   POSIX process-group capability label; controller-death nested-group recovery
   still open.

5. **P3 SandboxAdapter + nono (native-first)** — **v0 + P3b + P3c batch wire
   landed**: provider-neutral `SandboxAdapter`, capability gate, nono pin
   **`v0.81.0`**, observational `SandboxReport`, `nono wrap` argv builder,
   filesystem-enforcement measurement (Landlock-honest), opt-in
   `processTree.spawn({ sandboxWrap })`, and production wire
   (`prepareWorkerSandbox` → codex/claude spawn → `LoopResult.sandbox` →
   RunManifest `task.sandbox`) behind `sandbox.enabled` /
   `CLIYARD_SANDBOX=1`. Evidence:
   [SANDBOX_ADAPTER_NONO_V0.md](evidence/SANDBOX_ADAPTER_NONO_V0.md),
   [SANDBOX_NONO_WORKER_WRAP.md](evidence/SANDBOX_NONO_WORKER_WRAP.md),
   [SANDBOX_BATCH_WIRE.md](evidence/SANDBOX_BATCH_WIRE.md).
   Filesystem isolation is `partial` only when measurement passes; otherwise
   `unsupported`. This host has Landlock active; an early `/tmp`-based probe
   was a false negative (fixed to home-scoped measure). Residual: default-on
   wrap for every production batch (still opt-in); network/credential
   measurement; microVM tier. WorkspaceBoundary remains the independent
   post-run detection fallback.

6. **Background VerificationTask** — **v0 + opt-in batch wire merged**
   (`0fadc1a`, `3d88342`): durable `.cliyard/verification/`, detached worker
   PG, offset + delivery latch, startup orphan → `lost`,
   `createBackgroundVerifier` / `CLIYARD_BACKGROUND_VERIFY=1` / manifest
   `task.verification`. Evidence:
   [VERIFICATION_TASK_V0.md](evidence/VERIFICATION_TASK_V0.md),
   [VERIFICATION_BATCH_WIRE.md](evidence/VERIFICATION_BATCH_WIRE.md).
   Residual: default-on background verify; RuntimeManager-backed verify
   services; cascade stop of owned tasks.

7. **Clean-context Reviewer** — **v0 merged** (`56c1bd2`):
   `ReviewFinding`, chat-free `CleanReviewContext`, durable
   `.cliyard/reviews/`, fixture reviewer (no model). Evidence:
   [REVIEWER_CLEAN_CONTEXT_V0.md](evidence/REVIEWER_CLEAN_CONTEXT_V0.md).
   Residual: model-backed reviewer adapter; wire into acceptance flow.

8. **Human intervention ledger** — **v0 merged** (`0d96d61`): six roles,
   durable `.cliyard/interventions/`, secret-refusing reasons, observational
   only. Evidence:
   [INTERVENTION_LEDGER_V0.md](evidence/INTERVENTION_LEDGER_V0.md).
   Residual: automation of repeated Retry/Carry/Trigger; Control API surface.

9. **SkillPack provenance** — **v0 merged** (`8e33df3`): digest
   `.agents/skills`, durable pack snapshot + run binding. Evidence:
   [SKILLPACK_PROVENANCE_V0.md](evidence/SKILLPACK_PROVENANCE_V0.md).
   Residual: RunManifest field; eval-gated default pack promotion.

10. **ProfileCatalog, routing and hierarchical admission** — **v0 on
    branch**: activated `.cliyard/profile-catalog.json`, unknown binding
    permit=1, conjunctive `admitHierarchical`. Evidence:
    [PROFILE_CATALOG_ADMISSION_V0.md](evidence/PROFILE_CATALOG_ADMISSION_V0.md).
    Residual: queue/scheduler wire; learned 429 ramp; routing A/B.

## Actual-project readiness

These are capability gates, not date estimates or a percentage score.

| Use mode | Current assessment | Gate before use |
|---|---|---|
| Supervised single-repository pilot | Near, but not yet recommended | Complete DCP v2 review; land P3 sandbox gate; keep human Plan/diff gates; do not claim readiness from P1–P2b land alone |
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
review) has a human decision and P3 sandbox / background verification gates
are credible. P0–P2b are on mainline; residual attach and backend gaps remain.
Team use additionally requires clean-context review and authenticated
event/action API gates.

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


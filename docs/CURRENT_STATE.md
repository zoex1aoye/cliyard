# cliyard Current State

> Verified: 2026-11-08 (Asia/Shanghai) — **stop-loss**: active MVP line is
> **DSH / Cordis plugin** (`dsh-plugin-cliyard`), not further self-built
> runtime/OS ownership. Mainline through PR #24 (`ba2f458`) is inventory.
> Routing A PR is **parked**. Contract draft:
> [dsh-plugin-cliyard-taskcontract-v0.md](../design/dsh-plugin-cliyard-taskcontract-v0.md).
> Roadmap: [ROADMAP.md](ROADMAP.md) · MVP detail:
> [dsh-plugin-mvp-roadmap-v0.md](../design/dsh-plugin-mvp-roadmap-v0.md).
>
> This page is the single current-status authority for implementation order,
> known gaps and the next executable slice. Product rationale remains in
> `KEY_MIND.md`, `PRODUCT_STRATEGY_V2.md` and
> `design/continuous-harness-v2.md`; those documents must not maintain a second
> competing "current next step". Native-first DCP v2
> (`design/delivery-control-plane-v2.md`) stays a reviewed draft under the
> **frozen** line — not the active MVP build order.

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

**Active build order = DSH plugin MVP (M0–M4).** See [ROADMAP.md](ROADMAP.md).
Do not start new mainline knives that deepen the frozen inventory below.

### Active — dsh-plugin-cliyard

Detail: [dsh-plugin-mvp-roadmap-v0.md](../design/dsh-plugin-mvp-roadmap-v0.md).
Master persona: [dsh-master-persona-v0.md](../design/dsh-master-persona-v0.md).

0. **M0 TaskContract shell** — **landed** in `95146d2` (PR #27): JSON Schema +
   `examples/mvp/code-local-cli.mock.contract.json` + `src/mvp/taskcontract.ts`.
   Evidence: [MVP_M0_CONTRACT_PERSONA.md](evidence/MVP_M0_CONTRACT_PERSONA.md).

1. **M0.5 Master system persona** — **landed** in `95146d2` (PR #27):
   `dsh-cliyard` mounts `cliyard:master-persona` via `ctx.systemPrompt.section`
   when present. Live DSH profile smoke still outstanding.

2. **M1 idle spin + cwd lock** — **landed** in `12db03b` (PR #28):
   `cliyard mvp-test` / `cliyard_mvp_test`: frozen mock contract → worktree →
   `local-cli` spawn with cwd lock; trunk product paths untouched. Evidence:
   [MVP_M1_IDLE_SPIN.md](evidence/MVP_M1_IDLE_SPIN.md).

3. **M2 dispose + optional wrap** — **next**: Cordis/`AbortSignal` dispose
   kills tracked child (+ process group); optional docker/low-priv stays
   default-off. Not Landlock as MVP path.

4. **M3 Compiler + `/freeze`** — session → Plan → human freeze → immutable bytes.

5. **M4 demos** — code local-CLI + one second scene on the same schema.

Soul kept: design-as-truth, workspace cage, deterministic verify, human freeze.
Infrastructure borrowed: DSH session/LLM, Cordis dispose, community worktree/CLI
bridges where they do not own acceptance authority.

### Frozen — mainline inventory (do not deepen for MVP)

P0–P4 work already on `codex/supervisor-v0-baseline` through `ba2f458`
remains valid history and optional later reuse. While the plugin MVP is
active, treat the following as **frozen**, not next knives:

- **StateStore / SQLite ledger deepen** — complete through path unify; freeze
  further event-sourcing productization for MVP.
- **Daemon write/auth, launchd / Job Object, nested process-tree reclaim** —
  freeze.
- **Landlock / nono default-on productization** — opt-in code may stay; freeze
  as MVP dependency.
- **RuntimeManager port-lease productization** — freeze for MVP.
- **Routing A / Architect wire / default-on admission / learned 429** —
  Routing A PR **parked**; no further P4 knives until MVP evidence exists.

Evidence pointers for inventory (not active order):
[STATESTORE_SQLITE_AUTHORITY.md](evidence/STATESTORE_SQLITE_AUTHORITY.md),
[SANDBOX_BATCH_WIRE.md](evidence/SANDBOX_BATCH_WIRE.md),
[VERIFICATION_BATCH_WIRE.md](evidence/VERIFICATION_BATCH_WIRE.md),
[REVIEWER_ACCEPTANCE_WIRE_V0.md](evidence/REVIEWER_ACCEPTANCE_WIRE_V0.md),
[ROUTING_QUEUE_WIRE_V0.md](evidence/ROUTING_QUEUE_WIRE_V0.md).

Native-first DCP v2 human review remains open as a **later** unfreeze gate,
not a blocker for M1 plugin idle-spin.

## Actual-project readiness

These are capability gates, not date estimates or a percentage score.

| Use mode | Current assessment | Gate before use |
|---|---|---|
| DSH plugin idle-spin (M1) | **Landed** (`12db03b`) | Evidence: MVP_M1_IDLE_SPIN; next gate is M2 dispose |
| DSH plugin dispose (M2) | **Active target** | Cancel kills child; no zombie; wrap default-off |
| Supervised local-CLI pilot via DSH | Not ready | M1–M2 green; human `/freeze`; one real `local-cli` target |
| Multi-scene creator demo (novel/drama) | Not ready | M3–M4 on same TaskContract shell |
| Legacy mainline unsupervised / 24h | Far (frozen path) | Not MVP; do not claim from P0–P4 inventory alone |

Candidate MVP envelope:

- develop as **dsh-plugin-cliyard** on DSH/Cordis;
- local CLI dispatch is the highest-priority driver (`local-cli`);
- workspace cage via `git worktree` / assets + `writeRoots`;
- process reclaim via Cordis dispose, not a custom ownership ledger;
- human Plan approve + `/freeze`; no auto-merge;
- no claim of default-on OS sandbox, unbounded parallel, or 24h unattended.

## Release gates

### MVP gates (active)

Before claiming the DSH plugin MVP works:

- M1: mock contract spawn locks `cwd` to workspace; trunk untouched;
- M2: cancel/dispose reclaims the child on the exercised OS;
- M3: human `/freeze` produces immutable TaskContract bytes;
- M4: at least two scenes demo on the same schema;
- no secrets/absolute tool paths in contracts;
- accepted plugin demos still require human review before any mainline unfreeze.

### Frozen-line gates (not MVP blockers)

The older continuous-harness gates (disk resume, background verifier survival,
clean-context review, Landlock identity bind, parallel admission observation,
24h soak) remain **targets for a later unfreeze**, not prerequisites for M1.


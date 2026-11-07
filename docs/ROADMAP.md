# Development Roadmap

> Updated 2026-11-07 (Asia/Shanghai). Sequencing map only; the current
> implementation order remains the authority in
> [CURRENT_STATE.md](./CURRENT_STATE.md). The architecture this map follows is
> [delivery-control-plane-v2.md](../design/delivery-control-plane-v2.md).

## Endpoint

> 用 cliyard 开一个 **Vue 项目**，定制开发 **iOS 26 液态玻璃（Liquid Glass）
> 主题的 TDesign 组件库**，全程有可用的人机面：人只开头定方向与边界、中间
> 在看板可视、结尾审证据后合入。

The endpoint has three inseparable parts:

1. a working control plane that turns design into evidence (already the core);
2. a **human-machine interface** — a task board, dependency view, event stream,
   evidence, approval and cost read through one Control API;
3. a real delivery proof — the Liquid Glass TDesign Vue component library built
   through the tool itself.

## Phases

| Phase | Status on mainline | Deliverable | Deferred / residual |
|---|---|---|---|
| P0 封刀 | **complete** | Cost-truth + pilot closeout + stack land; freeze binding | — |
| P1 StateStore | **complete** (`cdde392`) | SQLite event-sourced store + read projection | — |
| P1b write cutover | **complete** (`1fd737f` + production ledger/journal attach + path unify) | Run + queue + ledger + journal single-writer on `.cliyard/state.db` | — |
| P2a daemon + Control API | **complete** (`1f4be2d`) | `cliyardd` + read-only `/v1/status|events|runs` | Write/auth + daemon-owned dispatch deferred to P5 |
| P2b ExecutionSupervisor | **complete** (`6f9e550`) | RuntimeHandle authority + continuity + conformance | launchd / systemd-run / Job Object backends |
| P3 沙箱 + 独立验收 + 干净裁决 | **model Reviewer adapter on PR** | Opt-in sandbox + VT + Reviewer + interventions + SkillPack on mainline | acceptance-flow Reviewer wire; default-on VT/sandbox |
| P4 路由 + 分层并行 | **catalog + opt-in queue gate merged** | Catalog + unknown probe=1; `CLIYARD_ADMISSION=1` | default-on; routing A/B; learned ramp |
| P5 人机面 | pending | Web console over Control API; DSH thin client | desktop packaging |
| P6 终点验收 | pending | Vue + Liquid Glass TDesign through the tool itself | — |

## Phase detail

### P0 — close the legacy seam (complete)

See [P0_LEGACY_SEAM_FREEZE.md](./P0_LEGACY_SEAM_FREEZE.md). Binding on mainline.

### P1 / P1b — StateStore (complete; residual attach)

Merged: `cdde392`, `1fd737f`. `better-sqlite3` is the declared durable driver;
JSON-file fallback remains when the native module is missing. Evidence:
[STATESTORE_WRITE_CUTOVER.md](./evidence/STATESTORE_WRITE_CUTOVER.md),
[STATESTORE_SQLITE_AUTHORITY.md](./evidence/STATESTORE_SQLITE_AUTHORITY.md).

Ledger/journal production attach evidence:
[LEDGER_JOURNAL_PRODUCTION_CUTOVER.md](./evidence/LEDGER_JOURNAL_PRODUCTION_CUTOVER.md).
Path unification evidence:
[STATESTORE_PATH_UNIFY.md](./evidence/STATESTORE_PATH_UNIFY.md).
Honor
[COST_TRUTH_HISTORICAL_MISSING.md](./evidence/COST_TRUTH_HISTORICAL_MISSING.md)
on import. Canonical authority is `.cliyard/state.db` for all control domains.

### P2a / P2b — daemon and execution layer (complete; residual backends)

Merged: `1f4be2d`, `6f9e550`. Foreground Supervisor may still dispatch; daemon
owns read API and state lease. ExecutionSupervisor establishes RuntimeHandle
authority; launchd-class backends and nested controller-death recovery remain.

### P3 — sandbox, verification, review

P3 adapter v0 + P3b wrap/measure + P3c batch wire: SandboxAdapter + nono
`v0.81.0` pin + capability gate + observational SandboxReport + `nono wrap`
helper + filesystem enforcement measurement + opt-in
`prepareWorkerSandbox` / `CLIYARD_SANDBOX=1` production spawn wire
([SANDBOX_ADAPTER_NONO_V0.md](./evidence/SANDBOX_ADAPTER_NONO_V0.md),
[SANDBOX_NONO_WORKER_WRAP.md](./evidence/SANDBOX_NONO_WORKER_WRAP.md),
[SANDBOX_BATCH_WIRE.md](./evidence/SANDBOX_BATCH_WIRE.md)).
VerificationTask v0 (durable model, detached runner, recovery → `lost`):
[VERIFICATION_TASK_V0.md](./evidence/VERIFICATION_TASK_V0.md).
Opt-in batch wire (`createBackgroundVerifier` /
`CLIYARD_BACKGROUND_VERIFY=1`):
[VERIFICATION_BATCH_WIRE.md](./evidence/VERIFICATION_BATCH_WIRE.md).
Clean-context Reviewer v0 (findings + chat-free context + durable session):
[REVIEWER_CLEAN_CONTEXT_V0.md](./evidence/REVIEWER_CLEAN_CONTEXT_V0.md).
Model-backed Reviewer adapter v0 (injectable CleanReviewContext-only path):
[REVIEWER_MODEL_ADAPTER_V0.md](./evidence/REVIEWER_MODEL_ADAPTER_V0.md).
Human intervention ledger v0 (six roles, secret-free durable events):
[INTERVENTION_LEDGER_V0.md](./evidence/INTERVENTION_LEDGER_V0.md).
SkillPack provenance v0 (skill digests + run binding):
[SKILLPACK_PROVENANCE_V0.md](./evidence/SKILLPACK_PROVENANCE_V0.md).
Next within P3 residuals: acceptance-flow Reviewer wire; default-on VT/sandbox.

### P4 — routing and hierarchical parallelism

ProfileCatalog + hierarchical admission v0 (activated catalog, unknown
permit=1, conjunctive min):
[PROFILE_CATALOG_ADMISSION_V0.md](./evidence/PROFILE_CATALOG_ADMISSION_V0.md).
Opt-in queue wire (`CLIYARD_ADMISSION=1`, deny ⇒ pending):
[ADMISSION_QUEUE_WIRE_V0.md](./evidence/ADMISSION_QUEUE_WIRE_V0.md).
Residual: default-on gate; routing A/B; learned 429 ramp. Admission must
keep considering provider quota, CPU/RAM, ports and non-overlapping write
scope — none of those are auto-unlimited.

### P5 — human-machine interface

A local web console reads the versioned Control API: board, DAG, event replay,
evidence bundles, approval actions and cost truth. DSH stays a replaceable
entry; the console is the endpoint UI.

### P6 — endpoint acceptance

The Vue + Liquid Glass TDesign component library is the acceptance driver:
frozen glass tokens and material layers first, then parallel reference
components, verified by build, unit tests, same-viewport screenshots, axe and
`prefers-reduced-motion`, accepted only through clean review and human diff.

## Non-goals until the endpoint

- OS sandbox before a human-reviewed P3 Plan (after DCP v2 review).
- dynamic routing before background verification and clean review.
- desktop packaging or multi-user UI before the web console proves the read
  model.
- Claiming SQLite write authority for ledger/journal before those entrypoints
  attach.

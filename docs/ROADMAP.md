# Development Roadmap

> Updated 2026-11-06. Sequencing map only; the current implementation order
> remains the authority in [CURRENT_STATE.md](./CURRENT_STATE.md). The
> architecture this map follows is
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
| P1b write cutover | **complete** (`1fd737f` + production ledger/journal attach) | Run + queue + ledger + journal single-writer; JSON derived exports | Supervisor/queue DB unification |
| P2a daemon + Control API | **complete** (`1f4be2d`) | `cliyardd` + read-only `/v1/status|events|runs` | Authenticated actions; daemon-owned dispatch |
| P2b ExecutionSupervisor | **complete** (`6f9e550`) | RuntimeHandle authority + continuity + conformance | launchd / systemd-run / Job Object backends |
| P3 沙箱 + 独立验收 + 干净裁决 | **next** | nono SandboxAdapter + background VerificationTask + clean-context Reviewer | microVM tier |
| P4 路由 + 分层并行 | pending | ProfileCatalog activation + routing A/B + hierarchical admission | — |
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
Honor
[COST_TRUTH_HISTORICAL_MISSING.md](./evidence/COST_TRUTH_HISTORICAL_MISSING.md)
on import. Residual: supervisor runtime store and queue `state.db` remain
separate files.

### P2a / P2b — daemon and execution layer (complete; residual backends)

Merged: `1f4be2d`, `6f9e550`. Foreground Supervisor may still dispatch; daemon
owns read API and state lease. ExecutionSupervisor establishes RuntimeHandle
authority; launchd-class backends and nested controller-death recovery remain.

### P3 — sandbox, verification, review (next after DCP v2 review)

nono behind SandboxAdapter with a capability gate (no silent downgrade);
verification decoupled from worker lifecycle (background VerificationTask,
leased ports, readiness); structured ReviewFinding with clean context.

### P4 — routing and hierarchical parallelism

Activated profile bindings only; routing A (design elaboration) and routing B
(execution) are deterministic, audited decisions. Admission considers provider
quota, CPU/RAM, ports and non-overlapping write scope.

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

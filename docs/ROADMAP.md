# Development Roadmap

> Draft 2026-11-04. Sequencing map only; the current implementation order
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

| Phase | Deliverable | Unblocks | Deferred |
|---|---|---|---|
| P0 封刀 | Cost-truth + pilot closeout + stack #1–#5 on mainline; freeze binding | Reliable self-host loop during the rewrite | — |
| P1 StateStore 地基 | SQLite event-sourced store + read projection + CLI status/events | Observability and recovery stop depending on JSON files | JSON write-path migration |
| P2 daemon + 执行层 | `cliyardd` + Control API + ExecutionSupervisor (macOS) + RuntimeHandle authority + conformance suite | Restart-safe tasks, OS-owned process trees | — |
| P3 沙箱 + 独立验收 + 干净裁决 | nono SandboxAdapter + background VerificationTask + clean-context Reviewer | Falsifiable acceptance and OS write isolation | microVM tier |
| P4 路由 + 分层并行 | ProfileCatalog activation + routing A/B + hierarchical admission | Dynamic CLI/model selection; intra-branch parallelism | — |
| P5 人机面 | Web console (React + Vite) over Control API; DSH demoted to thin client | The endpoint's human-machine interface | desktop packaging |
| P6 终点验收 | Open a real Vue project; build Liquid Glass TDesign components (foundation → parallel P0 components → same-viewport screenshot + a11y + reduce-motion → human review) | Full loop proven on a real project | — |

## Phase detail

### P0 — close the legacy seam (complete on mainline)

Cost-truth resume retention (`c5714db`), pilot safety reliability closeout
(`c1d0dbb` / `fb665ab`), and PR stack #1–#5 are on
`codex/supervisor-v0-baseline` (land `a0609e8`). The historical missing attempt
is recorded in
[evidence/COST_TRUTH_HISTORICAL_MISSING.md](./evidence/COST_TRUTH_HISTORICAL_MISSING.md).
The freeze list in [P0_LEGACY_SEAM_FREEZE.md](./P0_LEGACY_SEAM_FREEZE.md) is
**binding**. No further P0 implementation work is queued.

### P1 — StateStore foundation (next plan after DCP v2 review)

SQLite append-only facts log + projection, deterministic kernel (clock/random
injected), optimistic concurrency, rebuild without migrations. A read-only
projection seeds from the existing JSON truth and exposes `status --json` /
`events`; JSON write-path migration is the following slice, only after read
parity is proven.

P1 decisions (recorded in `design/statestore-v0.md`):

- driver: minimal `StateStoreDriver` interface, `better-sqlite3` default on
  Node 20; `node:sqlite` is deferred (Node 22+ only), keeping Node coupling
  weak through the interface;
- surface: CLI-only read commands in P1, HTTP Control API in P2 (`cliyardd`);
- parity gate: semantic equivalence (canonicalized deep-equal with float
  tolerance); byte-identical comparison is diagnostic only, never the gate.

### P2 — daemon and execution layer

`cliyardd` owns state; the ExecutionSupervisor owns execution units via
RuntimeHandle (launchd label / systemd unit / Job Object), with PID diagnostic
only. A per-backend conformance suite proves cancel and restart semantics.

### P3 — sandbox, verification, review

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

- SQLite write-path migration before read parity (P1b, after P1).
- OS sandbox before the ExecutionSupervisor/conformance slice (P3 after P2).
- dynamic routing before background verification and clean review.
- desktop packaging or multi-user UI before the web console proves the read
  model.

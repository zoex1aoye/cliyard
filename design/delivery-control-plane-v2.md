# Delivery Control Plane v2: native-first execution and supervisor decoupling

> Recorded: 2026-10-30. Status: reviewed draft awaiting human approval.
> Not frozen, not dispatched.
>
> Supersedes `continuous-harness-v2.md` for execution-layer, process-lifecycle
> and sandbox design. Product rationale remains in `PRODUCT_STRATEGY_V2.md`
> and `KEY_MIND.md`. The current implementation order is owned by
> [CURRENT_STATE.md](../docs/CURRENT_STATE.md).

## 1. Why this document exists

After four rounds of process-tree ownership work (`WorkerProcessTree`
v1.1/v1.2 lineage), an external review proposed two contradictory execution
routes:

- Route A, container-first: one Linux OCI container per Task Attempt,
  Colima + Docker Engine API on macOS, Podman later. Requires the user to
  install a container runtime.
- Route B, native-first: no Docker prerequisite. Native OS sandbox (`nono`)
  is the default policy executor; `MXC` is a future cross-platform candidate;
  containers/VMs/microVMs are optional enhanced tiers for high-risk work.

User decision on 2026-10-30: **Route B**. Docker, containers and VMs are
optional enhanced execution backends, never a usage prerequisite. This
document encodes Route B together with the previously converged conclusions.

## 2. Three orthogonal concerns

The platform must keep these separate; one adapter must not be asked to solve
all three:

1. **Sandbox security** — what a Worker may read/write, and which network and
   system resources it may touch.
2. **Process lifecycle** — however deep the descendant tree, cancellation
   must leave nothing running, and a crashed controller must be able to find
   its execution units again.
3. **Execution environment** — which OS, toolchains, runtimes and
   dependencies the Worker needs.

A sandbox limits permissions; it does not clean escaped descendant processes.
`nono` and `MXC` cover concern 1. The `ExecutionSupervisor` covers concern 2.
The backend matrix in §6 covers concern 3.

## 3. Decisions

### D1. Native-first, no Docker prerequisite (user decision, 2026-10-30)

Default execution uses the operating system's native sandbox and process
management. Containers and microVMs are optional higher-isolation tiers.

### D2. Control plane stays Node 20; Go only as platform shims

The control plane keeps its 47k-line TypeScript / 38k-line test base and the
pinned Node 20 baseline. The observed process-ownership pain is an OS-layer
problem, not a language problem. Go enters only where Node cannot reach:

- Windows Job Objects via a small Go shim (`go-winjob`), held by an
  independent runner service, not by the controller.
- A future `MXC` helper, if the JSON native executor path is insufficient.

Full control-plane rewrite in Go remains an open decision with explicit
trigger criteria in §9.

### D3. The controller never owns process trees (containerd shim model)

`cliyardd` owns task DAG, state, budget and review decisions. A separate
`ExecutionSupervisor` creates, inspects, cancels, collects and recovers
execution units. The controller reconciles against a stable `RuntimeHandle`;
PID/PGID are diagnostic only.

### D4. Continuity is an explicit per-task policy

Two modes, selected in the contract, never by accident of process exit:

- `fail-closed`: supervisor stops the unit when the lease expires; task is
  `interrupted`, never auto-accepted. Default for sensitive work.
- `durable`: execution survives controller restart, re-attached by handle,
  bounded by hard time and resource limits. For long, independently
  verifiable builds.

Controller crash and user cancel are distinct events and must stay distinct.

### D5. Backend order follows the real host

macOS first (the daily driver), then Windows+WSL, then Linux native. Do not
implement Linux systemd first on a machine that cannot run it.

### D6. Sandbox tiers with a capability gate

`SandboxAdapter` declares `Capabilities()`. A task whose requirements exceed
the current backend must be refused or require explicit human approval; it
must never silently downgrade to host privileges.

### D7. Persistence: SQLite StateStore, versioned files, evidence dirs

- SQLite: tasks, attempts, events, evidence references.
- Git: design, plans, contracts, ADRs.
- Filesystem: logs, diffs, test reports, screenshots by run/attempt id.

The attempt cost-truth defect (missing first-attempt ledger entry) must be
repaired before any StateStore migration, so the wrong aggregate is not
carried into the new store.

### D8. Per-backend runtime-conformance suite

Each backend must pass a conformance suite covering: `setsid()` escape,
orphaned grandchildren, closed output pipes, controller kill and re-attach,
resource limits, PTY/temp/handle cleanup, and non-interference with a
parallel task. macOS results must state the known process-group limits.

### D9. Sandbox report is evidence

Backend and version, applied policy hash, mounts, network policy, start/exit
status, resource usage and violation records go into the EvidenceBundle.

## 4. Target architecture

```text
human / cockpit (DSH plugin, CLI, later TUI/Web)
                    |
        cliyardd (Node 20 control plane daemon)
     plan/contracts, DAG, state machine, budget, review decisions
                    |
       +------------+------------+
       |                         |
ExecutionSupervisor         SandboxAdapter
create/inspect/cancel        (nono | MXC | microVM)
collect/destroy/recover      fs/network/resource policy
       |                         |
       +------------+------------+
                ExecutionCell
  worker CLI + descendants + output streams
        + worktree + leased ports
                    |
   EvidenceStore (files per run/attempt)
        + StateStore (SQLite)
```

The DSH plugin is a replaceable cockpit. Business state lives only in
StateStore and evidence, never in a chat session or plugin UI.

## 5. ExecutionHandle: persisted identity

```text
attempt_id          runtime_type         runtime_handle
workspace_id        design_revision      base_commit
desired_state       observed_state       lease_deadline
exit_result         evidence_bundle_ref
```

`runtime_handle` is platform-specific and stable: launchd job label,
systemd unit name, Job Object id or VM/container id. Controller restart runs
reconciliation: read desired state, query the runtime, compare, then
re-attach, stop, recover or mark interrupted — each step recorded as an
event. A vanished process is never assumed successful; a rerun always gets a
new Attempt ID.

## 6. Backend matrix

| Host | Default backend | Notes |
|---|---|---|
| macOS | POSIX process group + launchd job | Capability label: process group is not full descendant-tree containment; microVM tier for high-risk work |
| Windows | WSL2 → Linux backend | Native Windows evaluated via MXC later, not in the first MVP |
| Linux | `systemd-run --user --unit=<attempt-id>` transient unit, `KillMode=control-group` | Uses the systemd CLI, no D-Bus library dependency |
| High-risk | microVM backend (Brig or SPACE) | Optional tier, never a prerequisite |

WSL lifecycle limit: closing WSL stops its processes. Recovery must discover
interrupted tasks; it must not promise survival across WSL shutdown.

## 7. Module map

Keep: contract schema and freeze, Plan compiler, worktree manager,
EvidenceBundle, failure taxonomy, Task Architect, self-host iteration
workflow, RuntimeManager with leased ports.

Rebuild: JSON-file persistence → SQLite StateStore; foreground-only
Supervisor → daemon + versioned Control API with event replay.

New: ExecutionSupervisor interface + macOS backend; SandboxAdapter + nono
backend (fixed version); runtime-conformance suite; `execution.continuity`
field in contracts; MXC probe (later).

### 7.1 Discard early, keep, freeze rule

The direction pulls toward v2 now. Components that will be replaced must stop
accepting new features; where a rewrite is certain, start it instead of
patching the legacy seam.

| Verdict | Components |
|---|---|
| Discard / rewrite on v2 seams | JSON-file state stores (`ledger.json`, `queue.json`, `runs/*.json`) -> SQLite event-sourced StateStore; foreground-only Supervisor + `runQueue` entrypoints -> `cliyardd` clients; WorkerLease PGID-as-authority -> RuntimeHandle (PID/PGID diagnostic only); per-group `ps` process-tree registry -> OS-managed execution unit + conformance suite; DSH monitor innerHTML -> Control API read client |
| Keep (port, do not rewrite) | contract schema and freeze; Plan compiler; worktree manager; EvidenceBundle; failure taxonomy; cost truth; RuntimeManager ports/readiness; path audit; self-host workflow; skills and docs |
| Freeze rule | After the pilot-closeout merge, no new features land on the JSON stores, foreground Supervisor, PID registry or the dev monitor. New work targets the v2 seams; the legacy path receives only safety-blocker patches until replaced. |

The pilot-closeout `process-table-batch-cleanup` task is a safety patch on a
discard-bound component. It is accepted and must be merged to protect the
self-host loop during the rewrite, then that seam is frozen. The cost-truth
fix is portable and carries into the SQLite evidence aggregation unchanged.

## 8. Phasing

Every step is Plan-first: design doc → human approval → frozen contracts →
self-host dispatch → human diff gate.

1. **G0 (legacy seam final cut)**: repair the attempt cost-truth defect,
   human-review and merge the pilot-closeout integration, then declare the
   freeze list in §7.1. No further features land on the legacy seams after
   this point.
2. **P1 StateStore**: SQLite event-sourced boundary (append-only facts +
   projection) with the ExecutionHandle schema, read-only status/event
   projection and JSON import. Observability grows on this base, not on the
   JSON stores.
3. **P2 daemon**: `cliyardd` + Control API + ExecutionSupervisor macOS
   backend + conformance suite.
4. **P3 sandbox**: nono SandboxAdapter + sandbox acceptance tests + sandbox
   evidence in bundles.
5. **P4 roles**: background VerificationTask, clean-context Reviewer,
   Deploy/Test as deterministic runners.
6. **P5 Windows**: MXC / native-Windows evaluation after macOS conformance
   passes.
7. **P6 routing**: ProfileCatalog activation, hierarchical admission and
   quality/cost metrics.

## 9. Non-claims

- "No Docker required" does not mean no platform requirements; missing
  kernel/platform capabilities must fail loudly, not run unsandboxed.
- nono is pre-1.0; it must be version-pinned behind our adapter and its
  cleanup behavior verified separately.
- macOS process groups are not equivalent to Linux cgroups; the platform
  must say so in capability declarations and conformance evidence.
- Containers and microVMs reduce risk but are not proof against kernel
  vulnerabilities.
- No 24-hour unattended claim until bounded soak evidence exists.

## 10. Open decisions

- Trigger criteria for a full Go control-plane rewrite (default: only if Node
  shims fail conformance).
- nono version pin and upgrade re-evaluation procedure.
- MXC adoption criteria (native Windows support, policy schema fit).
- Default microVM provider: Brig vs SPACE.

## 11. Next steps

Human review of this document. After approval, compile a reviewable Plan with
the `cliyard-design-to-plan` skill, commit Plan and design together, then
freeze contracts and dispatch through the self-host workflow.

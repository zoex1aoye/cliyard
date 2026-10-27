# cliyard

Thin orchestrator for coding CLIs: **Windows entry → WSL workers**, capability-based, **no Docker required**.

North star: stop babysitting AI. **CLI + local Control API = stable product boundary**；**DSH = current MVP cockpit, not the control plane**；cliyard owns contracts, routing, isolation, gates and ledger. State lives on disk—not in a collapsing chat.

**第一步用户故事：** [docs/USER_STORY_STEP1.md](docs/USER_STORY_STEP1.md)  
**End state (Linus-shaped):** [docs/VISION.md](docs/VISION.md) §3.
**Product thesis / competitive boundary:** [docs/KEY_MIND.md](docs/KEY_MIND.md).
**Strategy v2 / routing, parallel dispatch and replaceable entry:** [docs/PRODUCT_STRATEGY_V2.md](docs/PRODUCT_STRATEGY_V2.md).
**V1 walking skeleton:** [docs/KEY_MIND_MVP.md](docs/KEY_MIND_MVP.md).
**Continuous multi-wave trial:** [docs/CONTINUOUS_TRIAL.md](docs/CONTINUOUS_TRIAL.md).
**WinUI 3 × TDesign pilot:** [docs/WINUI3_TDESIGN_PILOT.md](docs/WINUI3_TDESIGN_PILOT.md).
**Task sizing and cost estimation:** [docs/TASK_ESTIMATION.md](docs/TASK_ESTIMATION.md).
**Harness boundaries and DSH replacement strategy:** [docs/HARNESS_BOUNDARIES.md](docs/HARNESS_BOUNDARIES.md).
**Supervisor v0 operations:** [docs/SUPERVISOR_V0.md](docs/SUPERVISOR_V0.md) — durable foreground runs, recovery, limitations, safe self-hosting.
**Foreground orchestration queue v0:** [docs/evidence/ORCHESTRATION_QUEUE.md](docs/evidence/ORCHESTRATION_QUEUE.md) — explicit-approval queue over frozen contracts, dependency-ordered sequential dispatch, blocked stop/continue, retry/resume, stale-running reconciliation and queue-lock evidence. No daemon; RunManifest remains task authority.
**Plan-backed chained queue base v0:** [docs/evidence/PLAN_BACKED_CHAIN.md](docs/evidence/PLAN_BACKED_CHAIN.md) — `queue add-plan` snapshots an approved Plan, materializes queue-owned contracts at a pinned root HEAD or the completed upstream RunManifest `integrationHead`, and proves downstream worktree/integration ancestry in three real Claude Code + DeepSeek two-item chains. Fail-closed, idempotent, one linear dependency; no daemon.
**Pinned-base chained read context v0:** [docs/evidence/CHAINED_READ_CONTEXT.md](docs/evidence/CHAINED_READ_CONTEXT.md) — explicit downstream `readPaths` are validated against the exact shared contracts `baseCommit` with a Git object lookup, not the control checkout. Measured by focused tests and one real Claude Code + DeepSeek two-item chain (2/2, 13.953 s) whose downstream task read `foundation.txt` from the upstream base. No copying, automatic approval or daemon.
**RuntimeManager v0:** [docs/RUNTIME_MANAGER.md](docs/RUNTIME_MANAGER.md) — finite local services, leased ports, runtime manifest/evidence, cleanup, limitations.
**Runtime orphan recovery:** [docs/RUNTIME_ORPHAN_RECOVERY.md](docs/RUNTIME_ORPHAN_RECOVERY.md) — exact-identity preflight, exact lease-owner PID, `runtimeId`-bearing recovery records, `supervisor reap`, start/resume reconciliation, evidence-preserving gaps.
**Runtime failure drills:** [docs/evidence/RUNTIME_FAILURE_DRILLS.md](docs/evidence/RUNTIME_FAILURE_DRILLS.md) — three measured failure scenarios in independent child processes, report, leases, ports.
**Attempt continuity, worker progress, abnormal drill recovery:** [docs/evidence/ATTEMPT_CONTINUITY_PROGRESS.md](docs/evidence/ATTEMPT_CONTINUITY_PROGRESS.md) — measured rejected-attempt reuse, `--fresh-attempt`, live stream events, heartbeats, read-only status, and timed-out drill recovery.
**Task Architect evidence:** [docs/evidence/TASK_ARCHITECT.md](docs/evidence/TASK_ARCHITECT.md) — measured read-only Plan production (fake-worker guards plus one real Claude Code + DeepSeek smoke), human review gate and limitations.
**Control snapshot, event journal and resource snapshot v0:** [docs/evidence/CONTROL_SNAPSHOT.md](docs/evidence/CONTROL_SNAPSHOT.md) — read-only `queue status` joins queue, RunManifest, task, worker progress and line-age evidence; queue mutations append bounded audit events; host resources are sampled and provider capacity/quota/balance/pricing remain explicitly unknown until observed.
**Next iteration:** [docs/NEXT_ITERATION.md](docs/NEXT_ITERATION.md) — the revised order is failure taxonomy/cost truth, CLI+model execution-profile routing, a shared hierarchical admission broker, parallel queue + Plan-wave execution, a stable local Control API with a thin DSH cockpit, then DesignRevision/EvidenceBundle and finally look-ahead control. The scheduler warm start is 3 concurrent tasks; it is not a provider permit. Provider concurrency, quota, balance and price are learned per execution binding, while CPU/RAM, runtime, port and rate-limit feedback constrain a calibrated hard bound. Unknown bindings begin with one in-flight probe. Product rationale/build-vs-borrow is in [docs/PRODUCT_STRATEGY_V2.md](docs/PRODUCT_STRATEGY_V2.md), admission design in [design/dynamic-parallel-admission-v0.md](design/dynamic-parallel-admission-v0.md), and operational gaps in [docs/NEXT_STEP_CONTROLLER.md](docs/NEXT_STEP_CONTROLLER.md). Daemon, cross-host execution, SQLite, automatic main merge and unlimited concurrency remain non-goals.

## What we want (ideal)

```text
Human: versioned requirements + visual/design evidence
   → UI client (DSH now; own/Paseo-compatible later): review Plan
   → cliyard Control API: freeze contracts + select CLI/model profile
   → parallel admission: isolated worktrees/runs → independent evidence
   → human/integration gate: review-worthy accepted diffs
```

## What works today

- **Darwin MVP:** mock closed loop, DAG, `mock-batch` (parallel ready-wave), optional `--real-verify`, JSON ledger
- **Master spike (S1):** `plugins/dsh-cliyard` + `npm run master-monitor` / `master-dispatch`
- **Plan bridge:** structured Plan → validated/frozen contracts → isolated dispatch, also exposed to DSH as the `cliyard_plan_dispatch` agent tool
- **Task Architect v0 (read-only Plan producer):** `npm run architect -- --repo <target> --design <committed-design.md> --plan-id <id> [--json]` requires a clean target and a tracked, repo-relative design; Claude runs in `plan` permission mode with only Read/Grep/Glob, and post-run guards reject touched paths, a changed worktree, a moved HEAD or an invalid Plan. With the default output it writes only `<target>/.cliyard/plans/<planId>.json` — never contracts, worktrees, runs, dispatch, merge or push. The Plan is for human review; freezing and dispatch remain explicit later steps.
- **Codex worker spike (S2):** `npm run codex-batch -- … --dry-run` (real Codex without `--dry-run`)
- **Claude Code + DeepSeek worker:** `claude-ds` + `npm run claude-batch`
- **Continuous waves:** independent ready tasks execute in parallel within an integration branch; accepted task branches are snapshotted and merged sequentially, then the next dependent wave starts from the new integration head. This intra-item parallelism exists, but still needs first-class task/resource admission and two-level observability.
- **Supervisor v0 (durable foreground):** `supervisor start/status/resume/reap/stop`, atomic JSON RunManifest, integration-branch checkpoint, one-lock recovery; resume skips accepted tasks (no daemon, no SQLite)
- **Foreground orchestration queue v0 (explicit approval):** `queue add/add-plan/list/retry/cancel/run` over frozen contracts or approved Plans. Contract-backed `add` freezes the contracts path and SHA-256 at add; `run` dispatches ready items one at a time through the existing Supervisor, stops at the first blocked item by default, and with `--continue-on-blocked` keeps independent work moving while dependants become blocked. Blocked items retry explicitly (`start` when no run exists, otherwise `resume --retry-rejected`); a same-host stale queue lock is reclaimed and a `running` item with a recorded run id reconciles against its RunManifest. The queue never approves or rewrites contracts and never rewrites a RunManifest. Completed and cancelled items are monotonic. Sequential, same-host, foreground only.
- **Control snapshot + queue event journal v0:** `queue status [--json]` is read-only and joins item state, Plan/materialization lineage, the latest RunManifest/tasks, queue and supervisor liveness, latest worker progress, retry policy and a host resource sample. Missing manifests and malformed journal lines are reported as degraded evidence; they never become success. Queue add/retry/cancel, Plan materialization, dispatch, blocking and provider session boundaries append bounded events to `.cliyard/queue-events/events.jsonl`. Provider profiles are unresolved until an `ExecutionProfile` exists: capacity, quota, balance and pricing are `unknown/null`, never filled from a public nominal number.
- **Plan-backed chained queue base v0:** `queue add-plan <plan.json> --repo <path> --id <id> [--depends-on <id>]` snapshots an explicitly approved Plan (absolute path + SHA-256) and requires the Plan id to equal the queue id. A root item pins the repository HEAD captured at add; a dependent item waits for its one upstream to complete, then compiles the Plan deterministically at that RunManifest's `integrationHead` into a queue-owned artifact under `.cliyard/queue/materialized/` before any attempt increment or Supervisor start. Retry/resume re-verifies the recorded Plan hash, artifact bytes, base and upstream lineage; a changed Plan, artifact or upstream evidence blocks instead of being substituted. The downstream integration branch starts at the upstream head, so the upstream `integrationHead` is an ancestor of the downstream one. A downstream task may declare an upstream-produced file explicitly in `readPaths`; preflight proves it against that pinned base. One linear dependency only; no automatic Plan generation/approval, no multi-parent integration/merge queue, no parallel dispatch or daemon.
- **Pinned-base read context v0:** `validateReadContexts` receives the contracts' resolved shared base and proves each explicit `readPath` with `git cat-file -e <base>:<path>`. `.`, a genuinely missing optional `AGENTS.md` and paths produced by tasks in the same contracts document keep their exemptions. A path visible only as an untracked control-checkout file still fails with the untracked-context error, and a file tracked at current `HEAD` but absent at the pinned base is rejected. Nothing is copied from the control checkout; the worker worktree is created at the same pinned base.
- **Attempt continuity + worker progress v0 (foreground):** a rejected task checkpoints its exact worktree, branch and base and keeps the dirty draft even without `--keep-worktrees`; default `resume --retry-rejected` reuses that draft, while `--fresh-attempt` deliberately starts a clean worktree. Claude `stream-json` events are appended to `.cliyard/worker-events/<runId>/<taskId>.jsonl` and shown read-only by `supervisor status`, with heartbeats during provider silence. Events are observational only; no conversation resume, daemon or SQLite
- **RuntimeManager v0 (single host):** finite verification services started from the exact task worktree, leased `127.0.0.1` ports, HTTP readiness, URL env injection into `verifyCommands`, runtime manifest + service logs, process-group cleanup; no daemon, SQLite, or browser evidence
- **Runtime orphan recovery v0 (single host):** persisted owner/pid/pgid/OS start identity, exact lease-owner PID correlation, read-only preflight, `supervisor reap`, automatic `start`/`resume` reconciliation, exact lease release after group exit, `runtimeId`-bearing recovery records; `needs_human` instead of heuristic kills. No daemon or cross-host kill
- **Runtime failure drills v0:** `npm run runtime-drill` runs readiness-timeout, verify-failure and cleanup-failure in three independent child processes, writes a versioned JSON report plus per-scenario manifests/logs/leases, and verifies the service/port is clean afterward. A timed-out/abnormal child is terminated (SIGTERM → bounded SIGKILL) and its proven orphan runtime is reconciled by the exact reaper; the recovery is persisted in the report, while the abnormal scenario itself still reports failure. Diagnostic only — no daemon
- **Windows track:** `doctor` / `run` / `batch` via WSL (deferred for CodeBuddy E2E)

Not yet: durable worker-failure taxonomy and cost truth, CLI+model execution-profile routing, dynamic hierarchical admission, bounded inter-item and intra-item parallel dispatch, a stable local Control API, a reusable DesignRevision/EvidenceBundle, a self-owned fallback UI, or a supervised look-ahead controller/daemon. Windows CodeBuddy parallel E2E, JetBrains PSI, Docker, cross-host execution, SQLite manifests, unlimited parallel runtimes, multi-parent integration/merge queue and provider-conversation resume also remain unclaimed. The current queue is explicit-approval, sequential, same-host and foreground; the current task DAG can run independent ready tasks concurrently but lacks a shared CPU/RAM/provider/runtime admission broker. Plan-backed items deterministically compile contracts from an already-approved Plan; v0 supports only one linear queue dependency. Explicit downstream `readPaths` are validated at the pinned contracts base. Task Architect produces a human-reviewable Plan only; it does **not** freeze contracts or dispatch automatically.

Measured suite (2026-10-27, ControlSnapshot working tree on `3776c09`):
`npm run build` exit `0`, the new queue-control file **5/5** (532.4 ms), and
three consecutive `npm test` runs **245/245**
(12714.5 ms, 12842.7 ms, 12601.6 ms). The control file also passed a 20-run
focused stress loop. The previous read-context baseline was
240/240 on `390d61e`; its focused 5/5, Plan-backed 31/31 and real-provider
chain evidence remain historical measurements. This round adds five
control-snapshot tests. One
real Claude Code + DeepSeek two-item chain with downstream
`readPaths: ["foundation.txt"]` completed 2/2 in 13.953 s, captured the live
downstream worktree at the upstream `integrationHead` with `foundation.txt`
present and `upper.txt` absent, observed the worker reading that file, and
verified both final files plus integration ancestry (exit `0`). Three earlier
chains without explicit readPaths (17.2 s, 24.6 s and 21.4 s) remain historical
measurements. These are single local macOS results, not a long-term flake-rate,
cost or CI claim. Evidence:
[docs/evidence/CHAINED_READ_CONTEXT.md](docs/evidence/CHAINED_READ_CONTEXT.md),
[docs/evidence/PLAN_BACKED_CHAIN.md](docs/evidence/PLAN_BACKED_CHAIN.md),
[docs/evidence/ORCHESTRATION_QUEUE.md](docs/evidence/ORCHESTRATION_QUEUE.md),
[docs/evidence/TASK_ARCHITECT.md](docs/evidence/TASK_ARCHITECT.md),
[docs/evidence/ATTEMPT_CONTINUITY_PROGRESS.md](docs/evidence/ATTEMPT_CONTINUITY_PROGRESS.md),
[docs/evidence/CONTROL_SNAPSHOT.md](docs/evidence/CONTROL_SNAPSHOT.md) and
[docs/evidence/RUNTIME_FAILURE_DRILLS.md](docs/evidence/RUNTIME_FAILURE_DRILLS.md);
per-run hardening durations and acceptance matrix:
[docs/RUNTIME_ORPHAN_RECOVERY.md](docs/RUNTIME_ORPHAN_RECOVERY.md#verification).

Hardening measured in the pre-drill baseline: a lease must be owned by the exact
runtime owner PID (live or dead mismatch → `needs_human`); every new recovery
record carries its `runtimeId` and the Supervisor reads it directly instead of
matching reason text; `src/supervisor` contains no NUL bytes; and the seven
runtime test files that start real processes or bind real ports use disjoint
static port pools (22000–22699; the drill file takes a 90-port window,
test-only — not cross-repository port coordination).

## Recommended layout

Keep the **app repo on the WSL filesystem** (e.g. `~/work/my-app`), not `/mnt/c/...`.

```text
Windows PowerShell
  cliyard doctor | run | batch
       │
       ▼
  wsl.exe -d <distro> --cd <linux-repo> -- bash -lc '…'
       │
       ├─ git worktree add …
       └─ codebuddy | claude | codex …
```

## Local MVP (macOS mock)

On Darwin there is no `wsl.exe`. Use the Route C mock control plane (no WSL / CodeBuddy / Docker):

```bash
npm install --registry https://registry.npmjs.org/
npm test
npm run mock-loop                                          # fail verify once → repair → accept (mock verifier)
npm run mock-loop -- --fail-verify-times 0                 # happy path
npm run mock-loop -- --fail-verify-times 3                 # exhaust maxRepairs → reject (exit 1)
npm run mock-loop -- --briefing-dir .cliyard/briefing      # also write briefing/<taskId>.md
# Optional real shell verify (still mock worker; no WSL):
npm run mock-loop -- examples/real-verify.contract.json --real-verify --fail-verify-times 0
# RuntimeManager v0: finite service + leased URL gate (mock worker, real shell verify):
npm run mock-loop -- examples/runtime-verifier.contract.json --real-verify --fail-verify-times 0
# Override the default 19000-19999 lease range if it is busy:
CLIYARD_PORT_RANGE=21800-21899 npm run mock-loop -- \
  examples/runtime-verifier.contract.json --real-verify --fail-verify-times 0
# Runtime failure drills v0: three rejection paths in independent child processes
npm run runtime-drill -- --out .cliyard/runtime-drills/manual --port-base 22800 --json
# Output must be missing or empty; omit --out/--port-base for the defaults.
# Multi-task mock scheduler (dependsOn / DAG; parallel ready-wave):
npm run mock-batch -- examples/mock-batch.chain.json
npm run mock-batch -- examples/mock-batch.parallel.json

# Master monitor + dispatch (S1; no DSH required for demo)
npm run master-monitor          # http://127.0.0.1:3927/
npm run master-dispatch         # configured worker batch (Claude by default) → ledger

# Codex dual worktree (S2); --dry-run skips API
npm run codex-batch -- examples/codex-batch.parallel.json --dry-run

# Claude Code + DeepSeek probe and worker smoke
claude-ds -p 'Reply exactly with PROBE_OK.'
npm run claude-batch -- examples/claude-smoke.contract.json --repo /path/to/temp-git-repo

# Task Architect v0: read-only Plan from a committed design (clean target)
npm run architect -- --repo /path/to/clean-target \
  --design design/feature.md --plan-id feature --json
# Writes only <target>/.cliyard/plans/<planId>.json; review it, then use the
# existing plan compiler/plan-dispatch and Supervisor explicitly.

# Plan → contract file → optional dispatch (distinct parallel writePaths required)
npm run plan-dispatch -- examples/glass-parallel.plan.json --repo ../ui-prototype
npm run plan-dispatch -- examples/glass-parallel.plan.json --repo ../ui-prototype \
  --dispatch --worker codex --model deepseek-flash --dry-run
# Remove --dry-run for a real Codex run. Codex worktrees are kept by default.
# Add --background to return a pid/log receipt immediately; ledger remains the truth.

# Glass sibling trial (../ui-prototype)
npm run glass-dry
npm run glass-dispatch   # deepseek-flash, keep worktrees

# Durable Supervisor v0 (foreground; atomic JSON RunManifest; no daemon / SQLite)
npm run dev -- supervisor start <contracts.json> --repo <scratch-repo> --worker claude
npm run dev -- supervisor status --repo <scratch-repo> --json
npm run dev -- supervisor resume --repo <scratch-repo>   # after interruption
# Rejected retry reuses the recorded dirty worktree by default:
npm run dev -- supervisor resume --repo <scratch-repo> --retry-rejected
# Discard that draft and start a clean worktree:
npm run dev -- supervisor resume --repo <scratch-repo> --retry-rejected --fresh-attempt
npm run dev -- supervisor stop --repo <scratch-repo>     # cooperative SIGTERM
npm run dev -- supervisor reap --repo <scratch-repo> --json  # orphan runtime recovery
# start/resume also reconcile proven orphan runtimes automatically and fail
# closed when a runtime needs human review.
# After `npm run build`: node dist/cli.js supervisor …

# Foreground orchestration queue v0 (explicit approval over frozen contracts
# or approved Plans)
npm run dev -- queue add <contracts.json> --repo <scratch-repo> --id <queue-id> \
  --worker claude [--depends-on <id>] [--max-attempts n] [--json]
npm run dev -- queue add-plan <plan.json> --repo <scratch-repo> --id <queue-id> \
  [--depends-on <queue-id>] [--worker claude] [--model id] \
  [--max-attempts n] [--json]
npm run dev -- queue list --repo <scratch-repo> [--json]
npm run dev -- queue status --repo <scratch-repo> [--json]
npm run dev -- queue run --repo <scratch-repo> [--continue-on-blocked] \
  [--max-dispatches n] [--json]
npm run dev -- queue retry <queue-id> --repo <scratch-repo> [--json]
npm run dev -- queue cancel <queue-id> --repo <scratch-repo> [--json]
# Plan items support at most one dependency. A root item pins the HEAD captured
# at add-plan; a dependent item materializes at the upstream completed
# RunManifest integrationHead. Changing the Plan blocks; it is never auto-approved.
# Default run stops at the first blocked item; --continue-on-blocked runs
# independent items and blocks dependants. No daemon, parallel dispatch or dry-run.
# After `npm run build`: node dist/cli.js queue …
```

By default, `architect` writes only `<target>/.cliyard/plans/<planId>.json`
(`--out` may select another path); it writes no contracts and dispatches
nothing. After human review, plan compile writes
`<target>/.cliyard/plans/<planId>.json` and
`<target>/.cliyard/contracts/<planId>.contracts.json`. The control plane
resolves `HEAD` to a commit, freezes each contract, and rejects unknown deps,
cycles, repo-external paths, and overlapping task `writePaths`.

Ledger: `<target>/.cliyard/ledger.json` (gitignored).  
Task Architect artifact: `<target>/.cliyard/plans/<planId>.json` (gitignored;
human-reviewable Plan only — no contracts, runs or dispatch).
Supervisor state: `<target>/.cliyard/runs/<runId>.json` + `active.json` + `supervisor.lock`
(gitignored); accepted tasks, the integration head and rejected-attempt
worktree/branch/base fields are checkpointed there. Worker progress is
append-only at `<target>/.cliyard/worker-events/<runId>/<taskId>.jsonl`
(gitignored, advisory only; never run authority).
Supervisor details: [docs/SUPERVISOR_V0.md](docs/SUPERVISOR_V0.md) — foreground only, JSON manifest, manual review/merge, no daemon or SQLite; attempt reuse is worktree continuity, not provider-conversation resume.
Queue state: `<target>/.cliyard/queue.json` + `<target>/.cliyard/queue.lock`
(gitignored). Contract-backed items freeze their contracts path and SHA-256 at
`queue add`; changed or missing bytes block instead of dispatching.
Plan-backed items freeze the approved Plan path/SHA-256 at `queue add-plan`, a
pinned root base (`planBaseCommit`) or the completed upstream RunManifest
`integrationHead`, and a queue-owned contracts artifact at
`<target>/.cliyard/queue/materialized/<queue-id>/<base>-<plan-hash>.contracts.json`
(gitignored; hash verified on every retry/resume). The queue coordinates
Supervisor runs only: it never writes a RunManifest. Contract-backed dependency
ordering does not chain integration branches (each run uses its own frozen
`baseCommit`); Plan-backed v0 chains exactly one linear base, so the upstream
`integrationHead` is an ancestor of the downstream head. Multi-parent
integration and a merge queue are not implemented. Same-host stale locks are
reclaimed; foreign-host locks fail closed. Details and measured crash windows:
[docs/evidence/ORCHESTRATION_QUEUE.md](docs/evidence/ORCHESTRATION_QUEUE.md)
and [docs/evidence/PLAN_BACKED_CHAIN.md](docs/evidence/PLAN_BACKED_CHAIN.md).
Queue audit events are appended to
`<target>/.cliyard/queue-events/events.jsonl` (gitignored). They are bounded,
best-effort observations only; `queue status` reads them but never appends or
rewrites them.

Runtime evidence: `<target>/.cliyard/runtime/<runtimeId>/runtime-manifest.json`
plus `<service>.log` and `data/<service>/`; port leases live in
`<target>/.cliyard/runtime/port-leases.json`; orphan reconciliation serializes
through `<target>/.cliyard/runtime/reaper.lock` (all gitignored). A completed
recovery writes a `recovery` record carrying its `runtimeId` into the runtime
manifest. Lease correlation requires the lease owner PID to equal the manifest
owner PID; a live or dead mismatch is `needs_human`. Runtime services are finite
and single-host; details and limitations:
[docs/RUNTIME_MANAGER.md](docs/RUNTIME_MANAGER.md) and
[docs/RUNTIME_ORPHAN_RECOVERY.md](docs/RUNTIME_ORPHAN_RECOVERY.md). No daemon,
SQLite, Playwright/axe, screenshot, or a11y evidence is produced; orphan
recovery is never cross-host.

Failure-drill evidence:
`<target>/.cliyard/runtime-drills/<UTC>-<pid>/runtime-failure-drills.json` plus
per-scenario `child.log`, `child-result.json`, runtime manifests, service logs
and lease stores (gitignored). An abnormal scenario records its child
termination and exact-reaper recovery under `abnormalRecovery`; it is never
reinterpreted as accepted. Measured summary and artifact layout:
[docs/evidence/RUNTIME_FAILURE_DRILLS.md](docs/evidence/RUNTIME_FAILURE_DRILLS.md)
and [docs/RUNTIME_MANAGER.md](docs/RUNTIME_MANAGER.md#runtime-failure-drills).
Glass 实机：[docs/GLASS_TRIAL.md](docs/GLASS_TRIAL.md) · DSH 插件：[plugins/dsh-cliyard/README.md](plugins/dsh-cliyard/README.md).
Claude + DeepSeek：[docs/CLAUDE_DEEPSEEK_WORKER.md](docs/CLAUDE_DEEPSEEK_WORKER.md).

`npm run doctor` / `run` / `batch` need Windows+WSL — expect failure on macOS.

## Quick start (Windows)

```powershell
cd \\wsl$\Ubuntu\home\<you>\cliyard
npm install
copy config.example.yaml config.yaml

npm run doctor
npm run run-task -- --repo ~/work/my-app --prompt "…" --worker codebuddy --model gpt-5 --dry-run
npm run batch -- examples/module.tasks.yaml --dry-run
```

- Step-1 user story: [docs/USER_STORY_STEP1.md](docs/USER_STORY_STEP1.md)  
- Vision: [docs/VISION.md](docs/VISION.md)  
- MVP plan: [docs/MVP_IMPLEMENTATION_PLAN.md](docs/MVP_IMPLEMENTATION_PLAN.md)  
- OSS landscape: [docs/OSS_LANDSCAPE.md](docs/OSS_LANDSCAPE.md) · [docs/SCAFFOLD_FROM_OSS.md](docs/SCAFFOLD_FROM_OSS.md)

## Building blocks

| Concern | Brick | Role |
|---------|--------|------|
| Bridge | `wsl.exe` | Windows → Linux |
| Isolation | `git worktree` | Parallel without shared dirty tree |
| Workers | CodeBuddy / Claude / Codex | BYO install + login |
| Verification runtime | RuntimeManager v0 | Leased 127.0.0.1 ports, HTTP readiness, manifest, cleanup |
| Later | Workflow-style ledger, verify gates | Master without fat context |
| Later | tree-sitter MCP / JetBrains headless | Optional semantic accept |
| Optional | Docker | Never required |

## License

Apache-2.0 (planned) — TBD on first public release.

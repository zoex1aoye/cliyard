# cliyard

Thin orchestrator for coding CLIs: **Windows entry → WSL workers**, capability-based, **no Docker required**.

North star: stop babysitting AI. **Master 壳 = DeepSeek Harness GUI**；**cliyard = 控制面**（契约 / 隔离 / 门禁 / ledger）。State lives on disk—not in a collapsing chat.

**第一步用户故事：** [docs/USER_STORY_STEP1.md](docs/USER_STORY_STEP1.md)  
**End state (Linus-shaped):** [docs/VISION.md](docs/VISION.md) §3.
**Product thesis / competitive boundary:** [docs/KEY_MIND.md](docs/KEY_MIND.md).
**V1 walking skeleton:** [docs/KEY_MIND_MVP.md](docs/KEY_MIND_MVP.md).
**Continuous multi-wave trial:** [docs/CONTINUOUS_TRIAL.md](docs/CONTINUOUS_TRIAL.md).
**WinUI 3 × TDesign pilot:** [docs/WINUI3_TDESIGN_PILOT.md](docs/WINUI3_TDESIGN_PILOT.md).
**Task sizing and cost estimation:** [docs/TASK_ESTIMATION.md](docs/TASK_ESTIMATION.md).
**Harness boundaries and DSH replacement strategy:** [docs/HARNESS_BOUNDARIES.md](docs/HARNESS_BOUNDARIES.md).
**Supervisor v0 operations:** [docs/SUPERVISOR_V0.md](docs/SUPERVISOR_V0.md) — durable foreground runs, recovery, limitations, safe self-hosting.
**Foreground orchestration queue v0:** [docs/evidence/ORCHESTRATION_QUEUE.md](docs/evidence/ORCHESTRATION_QUEUE.md) — explicit-approval queue over frozen contracts, dependency-ordered sequential dispatch, blocked stop/continue, retry/resume, stale-running reconciliation and queue-lock evidence. No daemon; RunManifest remains task authority.
**RuntimeManager v0:** [docs/RUNTIME_MANAGER.md](docs/RUNTIME_MANAGER.md) — finite local services, leased ports, runtime manifest/evidence, cleanup, limitations.
**Runtime orphan recovery:** [docs/RUNTIME_ORPHAN_RECOVERY.md](docs/RUNTIME_ORPHAN_RECOVERY.md) — exact-identity preflight, exact lease-owner PID, `runtimeId`-bearing recovery records, `supervisor reap`, start/resume reconciliation, evidence-preserving gaps.
**Runtime failure drills:** [docs/evidence/RUNTIME_FAILURE_DRILLS.md](docs/evidence/RUNTIME_FAILURE_DRILLS.md) — three measured failure scenarios in independent child processes, report, leases, ports.
**Attempt continuity, worker progress, abnormal drill recovery:** [docs/evidence/ATTEMPT_CONTINUITY_PROGRESS.md](docs/evidence/ATTEMPT_CONTINUITY_PROGRESS.md) — measured rejected-attempt reuse, `--fresh-attempt`, live stream events, heartbeats, read-only status, and timed-out drill recovery.
**Task Architect evidence:** [docs/evidence/TASK_ARCHITECT.md](docs/evidence/TASK_ARCHITECT.md) — measured read-only Plan production (fake-worker guards plus one real Claude Code + DeepSeek smoke), human review gate and limitations.
**Next iteration:** [docs/NEXT_ITERATION.md](docs/NEXT_ITERATION.md) — Task Architect v0 and the foreground orchestration queue are implemented; the next gap is a supervised foreground long-run controller/daemon decision after queue semantics are proven. Daemon, cross-host, browser evidence, SQLite, parallel admission and automatic main merge remain non-goals.

## What we want (ideal)

```text
Human: requirements + prototype in DeepSeek Harness
   → Master plugin (dsh-cliyard): Plan → TaskContract → dispatch
   → cliyard: pick CLI → worktree isolation → gates → accept | repair≤N
   → Monitor: ledger statuses
   → Human returns: review-worthy diffs
```

## What works today

- **Darwin MVP:** mock closed loop, DAG, `mock-batch` (parallel ready-wave), optional `--real-verify`, JSON ledger
- **Master spike (S1):** `plugins/dsh-cliyard` + `npm run master-monitor` / `master-dispatch`
- **Plan bridge:** structured Plan → validated/frozen contracts → isolated dispatch, also exposed to DSH as the `cliyard_plan_dispatch` agent tool
- **Task Architect v0 (read-only Plan producer):** `npm run architect -- --repo <target> --design <committed-design.md> --plan-id <id> [--json]` requires a clean target and a tracked, repo-relative design; Claude runs in `plan` permission mode with only Read/Grep/Glob, and post-run guards reject touched paths, a changed worktree, a moved HEAD or an invalid Plan. With the default output it writes only `<target>/.cliyard/plans/<planId>.json` — never contracts, worktrees, runs, dispatch, merge or push. The Plan is for human review; freezing and dispatch remain explicit later steps.
- **Codex worker spike (S2):** `npm run codex-batch -- … --dry-run` (real Codex without `--dry-run`)
- **Claude Code + DeepSeek worker:** `claude-ds` + `npm run claude-batch`
- **Continuous waves:** accepted work enters an integration branch before dependent tasks start
- **Supervisor v0 (durable foreground):** `supervisor start/status/resume/reap/stop`, atomic JSON RunManifest, integration-branch checkpoint, one-lock recovery; resume skips accepted tasks (no daemon, no SQLite)
- **Foreground orchestration queue v0 (explicit approval):** `queue add/list/retry/cancel/run` over frozen contracts, with the contracts path and SHA-256 frozen at add. `run` dispatches ready items one at a time through the existing Supervisor, stops at the first blocked item by default, and with `--continue-on-blocked` keeps independent work moving while dependants become blocked. Blocked items retry explicitly (`start` when no run exists, otherwise `resume --retry-rejected`); a same-host stale queue lock is reclaimed and a `running` item with a recorded run id reconciles against its RunManifest. The queue never approves or rewrites contracts and never rewrites a RunManifest. Completed and cancelled items are monotonic. Sequential, same-host, foreground only.
- **Attempt continuity + worker progress v0 (foreground):** a rejected task checkpoints its exact worktree, branch and base and keeps the dirty draft even without `--keep-worktrees`; default `resume --retry-rejected` reuses that draft, while `--fresh-attempt` deliberately starts a clean worktree. Claude `stream-json` events are appended to `.cliyard/worker-events/<runId>/<taskId>.jsonl` and shown read-only by `supervisor status`, with heartbeats during provider silence. Events are observational only; no conversation resume, daemon or SQLite
- **RuntimeManager v0 (single host):** finite verification services started from the exact task worktree, leased `127.0.0.1` ports, HTTP readiness, URL env injection into `verifyCommands`, runtime manifest + service logs, process-group cleanup; no daemon, SQLite, or browser evidence
- **Runtime orphan recovery v0 (single host):** persisted owner/pid/pgid/OS start identity, exact lease-owner PID correlation, read-only preflight, `supervisor reap`, automatic `start`/`resume` reconciliation, exact lease release after group exit, `runtimeId`-bearing recovery records; `needs_human` instead of heuristic kills. No daemon or cross-host kill
- **Runtime failure drills v0:** `npm run runtime-drill` runs readiness-timeout, verify-failure and cleanup-failure in three independent child processes, writes a versioned JSON report plus per-scenario manifests/logs/leases, and verifies the service/port is clean afterward. A timed-out/abnormal child is terminated (SIGTERM → bounded SIGKILL) and its proven orphan runtime is reconciled by the exact reaper; the recovery is persisted in the report, while the abnormal scenario itself still reports failure. Diagnostic only — no daemon
- **Windows track:** `doctor` / `run` / `batch` via WSL (deferred for CodeBuddy E2E)

Not yet: **a supervised foreground long-run controller/daemon decision** (the next gap after the explicit foreground queue), Windows CodeBuddy parallel E2E, JetBrains PSI, Docker, Multica runtime, Supervisor daemon/background service, daemon-based or periodic orphan cleanup, cross-host runtime recovery, automatic reaping of leader-dead process groups, cross-repository port coordination, SQLite manifests, Playwright/axe/screenshot or a11y evidence, unlimited parallel runtimes, and a resumed provider conversation (attempt reuse is worktree continuity only). The queue is explicit-approval, sequential, same-host and foreground; it adds no daemon, background scheduler, parallel admission, cross-host coordination or automatic `main` merge. Task Architect produces a human-reviewable Plan only; it does **not** freeze contracts or dispatch automatically. The completed Task Architect, queue, attempt-continuity/progress and failure-drill slices add none of the other items.

Measured suite (2026-10-27, HEAD `20b9a64`): `npm run build` passes; the focused
orchestration queue file is **13/13** (1892.0 ms), and `npm test` is **205/205**
in one run (11022.6 ms). The full run includes the prior attempt-continuity,
runtime/recovery and Task Architect groups plus the new queue tests; those
other groups were not separately re-run this round. These are local macOS
results, not a long-term flake-rate or CI claim. Evidence:
[docs/evidence/ORCHESTRATION_QUEUE.md](docs/evidence/ORCHESTRATION_QUEUE.md),
[docs/evidence/TASK_ARCHITECT.md](docs/evidence/TASK_ARCHITECT.md),
[docs/evidence/ATTEMPT_CONTINUITY_PROGRESS.md](docs/evidence/ATTEMPT_CONTINUITY_PROGRESS.md)
and [docs/evidence/RUNTIME_FAILURE_DRILLS.md](docs/evidence/RUNTIME_FAILURE_DRILLS.md);
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

# Foreground orchestration queue v0 (explicit approval over frozen contracts)
npm run dev -- queue add <contracts.json> --repo <scratch-repo> --id <queue-id> \
  --worker claude [--depends-on <id>] [--max-attempts n] [--json]
npm run dev -- queue list --repo <scratch-repo> [--json]
npm run dev -- queue run --repo <scratch-repo> [--continue-on-blocked] \
  [--max-dispatches n] [--json]
npm run dev -- queue retry <queue-id> --repo <scratch-repo> [--json]
npm run dev -- queue cancel <queue-id> --repo <scratch-repo> [--json]
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
(gitignored). Each item freezes its contracts path and SHA-256 at `queue add`;
changed or missing bytes block instead of dispatching. The queue coordinates
Supervisor runs only: it never writes a RunManifest, and dependency ordering
does not chain integration branches (each run uses its own frozen
`baseCommit`). Same-host stale locks are reclaimed; foreign-host locks fail
closed. Details and measured crash windows:
[docs/evidence/ORCHESTRATION_QUEUE.md](docs/evidence/ORCHESTRATION_QUEUE.md).

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

# cliyard

**Design-to-Evidence Delivery Control Plane**

cliyard is **not** another coding agent, and **not** a chat-backed IDE/GUI.

It turns human design into a reviewable Plan, frozen contracts, isolated execution, and independent acceptance evidence — with recoverable verdicts on disk. Codex / Claude Code / Qwen Code / OpenCode / CodeBuddy are replaceable Workers; DSH or a future web console are replaceable UI clients.

中文版：[README.zh-CN.md](README.zh-CN.md)

```text
Human design & tradeoffs
  → reviewed Plan
  → frozen TaskContract
  → capability match, admission, isolated execution
  → independent acceptance evidence
  → human diff review / integration
  → recoverable next step
```

**Current implementation status, priority, and release gates live only in
[docs/CURRENT_STATE.md](docs/CURRENT_STATE.md).**  
Collaboration entry: [AGENTS.md](AGENTS.md). Roadmap overview: [docs/ROADMAP.md](docs/ROADMAP.md).

## Principles

1. **Design is truth; chat is not.** Plan / Contract / Git / RunManifest / evidence are authoritative.
2. **Done requires evidence.** Worker self-reports, heartbeats, and exit 0 are not `accepted`.
3. **Workers are replaceable; capability routes.** No hard bind to one CLI, model, or subscription.
4. **Humans keep design authority and irreversible decisions.** Plan approval, contract freeze, merge, and push are never silent system actions.
5. **Long tasks are a system property.** Models, GUIs, and Supervisors may exit; durable design, leases, evidence, and verdicts must not.

Product thesis: [docs/KEY_MIND.md](docs/KEY_MIND.md).  
Strategy / routing: [docs/PRODUCT_STRATEGY_V2.md](docs/PRODUCT_STRATEGY_V2.md).  
Execution rewrite (awaits human approval): [design/delivery-control-plane-v2.md](design/delivery-control-plane-v2.md).

## Ideal loop

```text
Human: versioned requirements / visuals / bounds
  → UI client (DSH plugin today; Control API console later)
  → cliyard: freeze contracts + select CLI/model profile
  → isolated worktrees / runtimes → independent Verifier / gates
  → human review of accepted diffs → merge (irreversible)
```

The end state is not “auto-merge to main.” It is: **humans set direction and final review; the control plane owns dispatch, calibration, and machine gates.**

## Where we are on the roadmap

Authoritative detail: [docs/CURRENT_STATE.md](docs/CURRENT_STATE.md) · overview: [docs/ROADMAP.md](docs/ROADMAP.md).

| Phase | Mainline | Notes |
|---|---|---|
| **P0** legacy closeout | **done** | Freeze binding |
| **P1 / P1b** StateStore | **done** | SQLite authority + ledger/journal attach + `.cliyard/state.db` unify |
| **P2a / P2b** daemon + ExecutionSupervisor | **done** | Read-only Control API; RuntimeHandle (launchd / Job Object residual) |
| **P3** sandbox + independent verify + clean review | **in progress** | Sandbox opt-in + VT + Reviewer + intervention ledger + SkillPack **on mainline** |
| **P4** routing / admission | **in progress** | ProfileCatalog + hierarchical admission v0 **open PR** |
| **P5** human-machine UI | pending | Control API console |
| **P6** endpoint acceptance | pending | Vue Liquid Glass TDesign via the tool |

**Next after ProfileCatalog lands:** queue/scheduler admission wire and/or model-backed Reviewer (not default-on sandbox / unbounded parallel).

## What works today (honest)

On mainline today (foreground Supervisor, single-repo lock, sequential queue — details in CURRENT_STATE):

- Plan compile and frozen TaskContract; write-path / path audit; git worktree isolation
- Foreground Supervisor: atomic RunManifest, integration checkpoint, resume / reap / recover-workers
- Explicit-approval foreground queue: `add` / `add-plan` / `run` / `retry` / `adopt`
- RuntimeManager: loopback port leases, readiness, runtime manifest, cleanup
- WorkerLease + process-tree cleanup (POSIX; controller-death nested-group recovery still open)
- WorkspaceBoundary v1: **detection-only** protected-root integrity (independent of sandbox)
- **Opt-in OS sandbox (P3):** nono `v0.81.0` pin, Landlock-honest measure, `CLIYARD_SANDBOX=1` / `sandbox.enabled` worker wrap (not default-on; no network/credential measure)
- **Background VerificationTask (P3):** durable `.cliyard/verification/`, detached runner, recovery → `lost`; opt-in `CLIYARD_BACKGROUND_VERIFY=1` batch wire
- **Clean-context Reviewer v0:** `ReviewFinding` + chat-free context + durable `.cliyard/reviews/` (fixture reviewer; no model yet)
- **Human intervention ledger v0:** six roles, durable `.cliyard/interventions/`, secret-refusing reasons (observational)
- **SkillPack provenance v0:** `.agents/skills` digests + durable pack snapshot + run binding
- Failure taxonomy and cost truth (resume retains abandoned attempts; historical missing has an import constraint)
- Task Architect: produces a human-reviewable Plan only — never freezes or dispatches
- Deterministic integration full-suite gate, estimate-plan telemetry calibration, Linux verifier process-group timeout reclaim
- **StateStore** (`cdde392` / `1fd737f`): event-sourced facts + projection; run/queue/ledger/journal write authority on `.cliyard/state.db` when SQLite is available
- **`cliyardd` + read-only Control API** (`1f4be2d`) and **ExecutionSupervisor / RuntimeHandle** (`6f9e550`)

**P0–P2b are closed on mainline.** P3 through SkillPack is on mainline (sandbox/VT **opt-in**); ProfileCatalog admission v0 is the open P4 slice.

## What we do not claim

- Not default-on OS write prevention; not credential / network isolation (Boundary remains post-hoc detection)
- Not a dispatch-owning daemon, cross-host recovery, Windows Job Object parity, or 24-hour unattended operation
- Not automatic Plan approval, automatic `main` merge, or unbounded parallelism
- Not production-ready dynamic routing / queue-wired hierarchical admission (catalog v0 exists; no learned ramp)
- Not a model-backed Reviewer; intervention ledger automation / Control API write not shipped
- Not a recommended supervised pilot yet — DCP v2 still needs a human decision; P3 residuals remain

Adjacent products: [docs/OSS_LANDSCAPE.md](docs/OSS_LANDSCAPE.md).  
Unlike ThinkRail-style agentic IDEs built around one coding engine, cliyard is an **engine-agnostic delivery control plane** with a replaceable human surface.

## Quick start

Requires Node `>=20` and whatever Worker CLIs you intend to use (optional for mocks).

```bash
npm install
npm run build
npm test

# Read-only: Plan from a committed design (no freeze, no dispatch)
npm run architect -- --repo /path/to/clean-target \
  --design design/feature.md --plan-id feature --json

# After human Plan review: compile/freeze contracts (does not start a run)
npm run plan-dispatch -- path/to/approved.plan.json --repo /path/to/target

# Foreground Supervisor (single-repo lock; no daemon)
npm run dev -- supervisor start path/to/contracts.json --repo /path/to/target --worker claude
npm run dev -- supervisor status --repo /path/to/target --json
npm run dev -- supervisor resume --repo /path/to/target

# Explicit-approval queue
npm run dev -- queue add-plan path/to/approved.plan.json --repo /path/to/target --id my-item
npm run dev -- queue run --repo /path/to/target
npm run dev -- queue status --repo /path/to/target --json
```

Mock loop (no real Worker):

```bash
npm run mock-loop
npm run mock-batch -- examples/mock-batch.parallel.json
```

Windows + WSL entrypoints (`doctor` / `run` / `batch`) still exist, but they are **not** the product lead story; local macOS/Linux foreground control plane is the current main path.

State lives under the target repo’s `.cliyard/` (gitignored): `runs/`, `queue.json`, `worker-leases/`, `runtime/`, etc.  
**RunManifest is task authority**; the queue only coordinates; chat is never authority.

## Doc map

| Want | Read |
|---|---|
| Where we are / what’s next | [docs/CURRENT_STATE.md](docs/CURRENT_STATE.md) |
| How to collaborate in this repo | [AGENTS.md](AGENTS.md) |
| Phase roadmap (P0–P6) | [docs/ROADMAP.md](docs/ROADMAP.md) |
| Product thesis | [docs/KEY_MIND.md](docs/KEY_MIND.md) |
| Parallel / routing / entry strategy | [docs/PRODUCT_STRATEGY_V2.md](docs/PRODUCT_STRATEGY_V2.md) |
| Execution rewrite (awaits human approval) | [design/delivery-control-plane-v2.md](design/delivery-control-plane-v2.md) |
| P0 freeze surface | [docs/P0_LEGACY_SEAM_FREEZE.md](docs/P0_LEGACY_SEAM_FREEZE.md) |
| Supervisor / Runtime ops | [docs/SUPERVISOR_V0.md](docs/SUPERVISOR_V0.md), [docs/RUNTIME_MANAGER.md](docs/RUNTIME_MANAGER.md) |
| Evidence & measurements | [docs/evidence/](docs/evidence/) (one-shot measurements; do not replace CURRENT_STATE) |

Standing rules: [`.agents/rules/`](.agents/rules/). Task SOPs: [`.agents/skills/`](.agents/skills/).  
`.cursor/rules` and `.cursor/skills` are symlinks to the same source — do not duplicate bodies.

## Building blocks

| Concern | Brick | Note |
|---|---|---|
| Design / intent | Plan + TaskContract | Human-reviewed, then frozen; change ⇒ new version |
| Isolation | git worktree + writePaths | No shared dirty tree; path audit catches overshoot |
| Execution | Replaceable Worker CLIs | BYO install + login |
| Runtime verification | RuntimeManager | Leased ports, readiness, cleanup |
| Task authority | RunManifest | accepted/rejected live only here |
| Coordination | Foreground queue | Explicit approval; sequential today |
| Human surface | DSH plugin (replaceable) | Never the sole store of contracts/evidence |
| Durable state | StateStore (`better-sqlite3`) | Run/queue/ledger/journal on `.cliyard/state.db` |
| Daemon / read API | `cliyardd` | Read-only Control API; not dispatch owner yet |
| Execution identity | ExecutionSupervisor / RuntimeHandle | PID/PGID diagnostic only |
| Safety boundary | WorkspaceBoundary + opt-in SandboxAdapter/nono | Detect always; OS wrap opt-in (`CLIYARD_SANDBOX`) |
| Independent verify | VerificationTask + optional background Verifier | Detached PG; shell verify still default |
| Clean review | ReviewFinding / CleanReviewContext (v0) | Fixture reviewer; model adapter next |
| Human interventions | Intervention ledger (v0) | Six roles; observational; no auto-execute |
| Skill provenance | SkillPack digests (v0) | `.agents/skills` → pack digest + run binding |
| Admission | ProfileCatalog + hierarchical admit (v0) | Unknown binding permit=1; not queue-wired yet |

## License

Apache-2.0 (planned) — finalize on first public release.

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

**Stop-loss (2026-11-08):** active MVP is **`dsh-plugin-cliyard`** on DSH/Cordis — not more self-built SQLite / Landlock / port-lease / process-tree ownership. Contract draft: [design/dsh-plugin-cliyard-taskcontract-v0.md](design/dsh-plugin-cliyard-taskcontract-v0.md).

| Track | Status | Notes |
|---|---|---|
| **M0** TaskContract shell | **on PR** | Schema + mock fixture + validator |
| **M0.5** Master system persona | **on PR** | `dsh-cliyard` systemPrompt mount (unit) |
| **M1** idle spin + cwd lock | **next** | `/cliyard-test` mock → worktree → `local-cli` spawn |
| **M2** dispose + optional wrap | pending | Cordis dispose; optional docker/low-priv |
| **M3** Compiler + `/freeze` | pending | Session → Plan → human freeze |
| **M4** three-scene demos | pending | code / novel / drama on one schema |
| Mainline P0–P4 inventory | **frozen for MVP** | Kept through `ba2f458`; Routing A parked |

**Next:** M0 schema fixture + M0.5 persona mount → M1 idle spin. Detail: [design/dsh-plugin-mvp-roadmap-v0.md](design/dsh-plugin-mvp-roadmap-v0.md).

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
- **Clean-context Reviewer v0:** `ReviewFinding` + chat-free context + durable `.cliyard/reviews/` (fixture + model adapter; opt-in `CLIYARD_CLEAN_REVIEW=1` acceptance wire)
- **Human intervention ledger v0:** six roles, durable `.cliyard/interventions/`, secret-refusing reasons (observational)
- **SkillPack provenance v0:** `.agents/skills` digests + durable pack snapshot + run binding
- Failure taxonomy and cost truth (resume retains abandoned attempts; historical missing has an import constraint)
- Task Architect: produces a human-reviewable Plan only — never freezes or dispatches
- Deterministic integration full-suite gate, estimate-plan telemetry calibration, Linux verifier process-group timeout reclaim
- **StateStore** (`cdde392` / `1fd737f`): event-sourced facts + projection; run/queue/ledger/journal write authority on `.cliyard/state.db` when SQLite is available
- **`cliyardd` + read-only Control API** (`1f4be2d`) and **ExecutionSupervisor / RuntimeHandle** (`6f9e550`)

**Mainline P0–P4 inventory exists** (opt-in gates through queue-wired Routing B at `ba2f458`) but is **frozen for MVP deepen**. Active work is the DSH plugin track (M0–M4).

## What we do not claim

- Not that the DSH plugin MVP already runs — M0 is draft; M1 evidence not yet landed
- Not default-on OS write prevention; not credential / network isolation
- Not a dispatch-owning daemon, Job Object parity, or 24-hour unattended operation
- Not automatic Plan approval, automatic `main` merge, or unbounded parallelism
- Not continuing Landlock / SQLite ledger / process-tree ownership as the MVP path
- Not unfreezing mainline modules without plugin demo evidence + a new human Plan

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
| Clean review | ReviewFinding / CleanReviewContext (v0) | Fixture + model adapter; opt-in accept wire |
| Human interventions | Intervention ledger (v0) | Six roles; observational; no auto-execute |
| Skill provenance | SkillPack digests (v0) | `.agents/skills` → pack digest + run binding |
| Admission | ProfileCatalog + opt-in queue gate (v0) | Unknown binding permit=1; `CLIYARD_ADMISSION=1` |
| Execution routing | Routing B + opt-in queue wire (v0) | `CLIYARD_ROUTING=1`; activated catalog; deny ⇒ pending |

## License

Apache-2.0 (planned) — finalize on first public release.

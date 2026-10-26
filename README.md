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
**Next iteration:** [docs/NEXT_ITERATION.md](docs/NEXT_ITERATION.md) — Supervisor v0 verification and safe self-hosting.

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
- **Codex worker spike (S2):** `npm run codex-batch -- … --dry-run` (real Codex without `--dry-run`)
- **Claude Code + DeepSeek worker:** `claude-ds` + `npm run claude-batch`
- **Continuous waves:** accepted work enters an integration branch before dependent tasks start
- **Supervisor v0 (durable foreground):** `supervisor start/status/resume/stop`, atomic JSON RunManifest, integration-branch checkpoint, one-lock recovery; resume skips accepted tasks (no daemon, no SQLite)
- **Windows track:** `doctor` / `run` / `batch` via WSL (deferred for CodeBuddy E2E)

Not yet: Windows CodeBuddy parallel E2E, JetBrains PSI, Docker, Multica runtime, Supervisor daemon/background service, SQLite manifests.

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
npm run dev -- supervisor stop --repo <scratch-repo>     # cooperative SIGTERM
# After `npm run build`: node dist/cli.js supervisor …
```

Plan compile writes `<target>/.cliyard/plans/<planId>.json` and
`<target>/.cliyard/contracts/<planId>.contracts.json`. The control plane
resolves `HEAD` to a commit, freezes each contract, and rejects unknown deps,
cycles, repo-external paths, and overlapping task `writePaths`.

Ledger: `<target>/.cliyard/ledger.json` (gitignored).  
Supervisor state: `<target>/.cliyard/runs/<runId>.json` + `active.json` + `supervisor.lock`
(gitignored); accepted tasks and the integration head are checkpointed there.
Supervisor details: [docs/SUPERVISOR_V0.md](docs/SUPERVISOR_V0.md) — foreground only, JSON manifest, manual review/merge, no daemon or SQLite.
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
| Later | Workflow-style ledger, verify gates | Master without fat context |
| Later | tree-sitter MCP / JetBrains headless | Optional semantic accept |
| Optional | Docker | Never required |

## License

Apache-2.0 (planned) — TBD on first public release.

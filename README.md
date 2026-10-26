# cliyard

Thin orchestrator for coding CLIs: **Windows entry → WSL workers**, capability-based, **no Docker required**.

North star (why this exists): stop babysitting AI with endless confirmations and course-corrections. A thin **Master** should dispatch, steer against a frozen contract, and accept/reject; workers run to a **verifiable** done. State lives on disk—not in a collapsing chat.

**End state (Linus-shaped):** you hand requirements/description to Master; when you return to review, the artifact is something you’d be willing to seriously accept (or reject with evidence)—not a derailed chat. See **[docs/VISION.md](docs/VISION.md)** §3（对标 Linus）.

## What we want (ideal)

```text
Human (Linus seat): requirements / description / taste bar
   → Master: split → pick CLI/model → dispatch → gates → accept | repair≤N | human
   → Workers: worktree + CodeBuddy/Claude/Codex (same account OK, capped parallel)
   → Human returns: review-worthy diffs + tests + notes (satisfied ≠ bug-free forever)
```

## What v0 does today

- Entry on **Windows** (`cliyard`); workers inside **WSL**
- Isolation = **git worktree** + each CLI’s own sandbox/permissions
- `doctor` / `run` / `batch` (taskfile with per-task `model` + `paths`)
- Same-account parallel CodeBuddy with `max_parallel` (default 2)

Not yet: Master LLM loop, verify/repair state machine, JetBrains PSI, Docker.

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

## Quick start (Windows)

```powershell
cd \\wsl$\Ubuntu\home\<you>\cliyard
npm install
copy config.example.yaml config.yaml

npm run doctor
npm run run-task -- --repo ~/work/my-app --prompt "…" --worker codebuddy --model gpt-5 --dry-run
npm run batch -- examples/module.tasks.yaml --dry-run
```

- Module trial: [docs/TOMORROW.md](docs/TOMORROW.md)  
- Vision / principles: [docs/VISION.md](docs/VISION.md)  
- MVP plan (phase A review): [docs/MVP_IMPLEMENTATION_PLAN.md](docs/MVP_IMPLEMENTATION_PLAN.md)

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

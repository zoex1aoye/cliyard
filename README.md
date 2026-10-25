# cliyard

Thin orchestrator for **real-world validation** on **Windows + WSL**:

- Entry on **Windows** (`cliyard`)
- Workers run **inside WSL** (Claude Code / Codex / CodeBuddy — whatever is installed)
- **No Docker required**; isolation = git worktree + each CLI’s own sandbox/permissions
- Capability discovery → route → dispatch → collect summary

JetBrains PSI / heavy ADE are **out of scope for v0**.

## Recommended layout on your machine

Keep the **git repo inside the WSL filesystem** (e.g. `~/work/my-app`), not under `/mnt/c/...`.  
Windows only hosts the harness CLI; all `git` / agent CLIs run via `wsl.exe`.

```text
Windows PowerShell
  cliyard doctor | run
       │
       ▼
  wsl.exe -d <distro> --cd <linux-repo> -- bash -lc '…'
       │
       ├─ git worktree add …
       └─ claude | codex | codebuddy …
```

## Quick start (on Windows)

```powershell
# 1) Node 20+ on Windows
cd \\wsl$\Ubuntu\home\<you>\cliyard
npm install
copy config.example.yaml config.yaml

# 2) Probe WSL + CLIs
npm run doctor

# 3) Single task (optional --model)
npm run run-task -- --repo ~/work/my-app --prompt "Add a healthcheck endpoint" --worker codebuddy --model gpt-5 --dry-run

# 4) Parallel batch from taskfile (same-account CodeBuddy; default max_parallel=2)
npm run batch -- examples/module.tasks.yaml --dry-run
```

See `docs/TOMORROW.md` for the module workflow (AI reads docs → taskfile → batch).

## v0 building blocks

| Concern | Brick | Role in v0 |
|---------|--------|------------|
| Process bridge | `wsl.exe` (Microsoft) | Windows → Linux exec |
| File isolation | `git worktree` | Parallel tasks without shared dirty tree |
| Worker CLIs | Claude Code / Codex / CodeBuddy | Actual coding agents (BYO install + login) |
| Optional later | oneharness, dmux, ACP | Unify flags / richer TUI |
| Optional later | tree-sitter MCP | Light code map for Master |
| Optional later | JetBrains headless / MCP | Semantic accept only |

## What v0 proves

1. Doctor sees your distro + which CLIs exist in WSL  
2. One task → one worktree → one WSL CLI run  
3. Result summary: branch, `git diff --stat`, exit code  
4. You can tune prompts / permission flags on real projects  

Not yet: multi-worker fan-out UI, Master LLM loop, JetBrains, Docker.

## License

Apache-2.0 (planned) — TBD on first public release.

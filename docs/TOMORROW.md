# Tomorrow: module parallel with same-account CodeBuddy

## Flow

1. Put **requirements + prototype** in the target repo (WSL filesystem).
2. Ask an AI (short session) to **only** emit a taskfile from those docs — no code edits.
3. Review `paths` / `model` / overlap.
4. Run cliyard batch (Windows entry → WSL CodeBuddy).

```powershell
cd <cliyard>
copy config.example.yaml config.yaml
npm install
npm run doctor

# Dry-run: see worktree + codebuddy commands
npm run batch -- examples/module.tasks.yaml --dry-run

# Real run (edit examples/module.tasks.yaml first: repo, models, paths)
npm run batch -- path\to\your.tasks.yaml --max-parallel 2
```

## Tips

- Same account → shared quota; start with `max_parallel: 2`.
- Non-overlapping `paths` reduces merge pain.
- Model ids: use whatever `codebuddy` accepts (`--model`); dry-run first.
- After batch: `git worktree list` inside the app repo; review each `cliyard/...` branch.

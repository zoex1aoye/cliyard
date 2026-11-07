# MVP M1 — idle spin + cwd lock

> After M0/M0.5 land (`95146d2` / PR #27).
> Gate from [dsh-plugin-mvp-roadmap-v0.md](./dsh-plugin-mvp-roadmap-v0.md).

## Goal

Run a **frozen** local-CLI TaskContract in an isolated `git worktree`:

1. Validate contract (`driver.kind=local-cli`, `workspace.kind=git-worktree`).
2. `git worktree add` at `workspace.path` from `baseRef`.
3. `spawn(argv, { cwd: absoluteWorktree })` — never repoRoot.
4. Run `verify.commands` with `cwd=workspace`.
5. Assert main checkout stays clean (writes only inside worktree).

Surface: `cliyard mvp-test` (+ optional DSH tool `cliyard_mvp_test`).

## Non-goals

- No LLM / real claude|codex yet (fixture uses `custom:echo-ok`).
- No Landlock; no process-tree ownership ledger (M2 dispose comes next).
- No `/freeze` compiler (M3).
- Do not auto-merge or remove worktree when `keepWorkspace: true`.

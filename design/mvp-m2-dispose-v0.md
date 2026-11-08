# MVP M2 — dispose child on cancel

> After M1 lands (`12db03b` / PR #28).
> Gate from [dsh-plugin-mvp-roadmap-v0.md](./dsh-plugin-mvp-roadmap-v0.md).

## Goal

When a local-cli idle-spin child is cancelled or the Cordis/plugin context
disposes, the child process (and its process group when detached) exits and
does not remain as a zombie / orphan sleep.

1. Track the spawned child PID from idle-spin.
2. On `AbortSignal` / explicit dispose: SIGTERM then SIGKILL (bounded grace).
3. Prefer killing the process group (`-pid`) when the child was spawned
   detached so `sh -c 'sleep …'` descendants die too.
4. DSH plugin `ctx.on('dispose')` and in-flight `cliyard_mvp_test` share the
   same dispose registry.
5. Optional wrap (`docker` / low-priv) remains **default off** — document +
   refuse unknown wrap modes; do not claim OS sandbox.

Surface: extend `cliyard mvp-test --cancel-after-ms N` + unit tests that prove
a long `sleep` is dead after dispose.

## Non-goals

- No Landlock / nono default-on.
- No pid+pgid+lstart ownership ledger or nested-group controller-death recovery
  (those stay frozen mainline inventory).
- No `/freeze` compiler (M3).
- No real Claude/Codex yet.
- Do not auto-merge or delete `keepWorkspace` worktrees on dispose
  (dispose kills the **child**, not the worktree).

## Acceptance

- Spawn a long-running fixture (`sleep`); abort/dispose; `kill -0` fails
  (process gone) within a small bound.
- Normal idle-spin without cancel still passes M1 cwd + trunkClean checks.
- Wrap / sandbox productization stays opt-in and off by default.

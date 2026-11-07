# MVP M1 — idle-spin evidence

> Measured 2026-11-08 (Asia/Shanghai).
>
> Branch: `cursor/mvp-m1-idle-spin-0da8`.
> Plan: `design/mvp-m1-idle-spin-v0.plan.json`.
> Contracts: `design/mvp-m1-idle-spin-v0.contracts.json`.
> Accepted integration base: `95146d2` (M0/M0.5 / PR #27).

## 1. What landed

- `src/mvp/idle-spin.ts` — frozen local-cli TaskContract → `git worktree add`
  → `spawn(argv, { cwd: worktree })` → verify → trunk product-clean check
- `src/mvp/cli.ts` + `cliyard mvp-test` / `npm run mvp-test`
- DSH tool `cliyard_mvp_test` via `plugins/dsh-cliyard/lib/idle-spin-bridge.js`
- Fixture: `examples/mvp/code-local-cli.mock.contract.json`
- Tests: `tests/mvp-idle-spin.test.ts`

## 2. Commands

```bash
npm run build
npx tsx --test tests/mvp-idle-spin.test.ts
# → 4 pass (cwd lock, unfrozen refuse, repoRoot refuse, porcelain filter)
npm run mvp-test -- --json   # against a git repo with the fixture contract
```

## 3. Measured behaviour

- Child `cwd` equals absolute worktree path; never `repoRoot`.
- Worker write `.cliyard/mvp-echo/hello.txt` appears only inside the worktree.
- Trunk `git status --porcelain` may show `?? .cliyard/` (control-plane
  worktree container); `trunkClean` ignores `.cliyard/` and the worktree path,
  and fails closed on any other product dirty lines.

## 4. Non-claims

- No real Claude/Codex spawn yet (`custom:echo-ok` fixture only).
- No Cordis dispose / process reclaim (M2).
- No `/freeze` compiler (M3).
- No Landlock / SQLite deepen / unbounded parallel / 24h unattended.
- Live DSH session smoke of `cliyard_mvp_test` still outstanding.

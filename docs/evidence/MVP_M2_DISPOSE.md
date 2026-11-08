# MVP M2 — dispose evidence

> Measured 2026-11-08 (Asia/Shanghai).
>
> Branch: `cursor/mvp-m2-dispose-0da8`.
> Plan: `design/mvp-m2-dispose-v0.plan.json`.
> Contracts: `design/mvp-m2-dispose-v0.contracts.json`.
> Accepted integration base: `12db03b` (M1 / PR #28).

## 1. What landed

- `src/mvp/dispose.ts` — `disposeChild` (SIGTERM→SIGKILL, optional process
  group), `DisposeRegistry`, wrap refuse helper
- `src/mvp/idle-spin.ts` — detached local-cli spawn + `AbortSignal` dispose
- CLI: `cliyard mvp-test --cancel-after-ms N`
- Fixture: `examples/mvp/code-local-cli.sleep.contract.json`
- Plugin: `dispose-registry.js` + `ctx.on('dispose')` aborts in-flight
  `cliyard_mvp_test`; bridge kills child process group on abort
- Tests: `tests/mvp-dispose.test.ts`

## 2. Commands

```bash
npm run build
npx tsx --test tests/mvp-dispose.test.ts tests/mvp-idle-spin.test.ts
# → dispose + idle-spin focused suites green
```

## 3. Measured behaviour (Linux)

- Detached `sleep 30` dies after `disposeChild` (`kill -0` fails).
- Idle-spin with AbortSignal / registry.disposeAll marks `disposed=true` and
  leaves no live `spawnPid`.
- `sandbox.mode=docker|low-priv` refused (default-off); `none` allowed.

## 4. Non-claims

- Not a pid+pgid+lstart ownership ledger or nested-group controller-death
  recovery.
- No Landlock / default-on OS sandbox.
- No `/freeze` (M3); no real Claude/Codex.
- Live DSH Cordis dispose smoke still outstanding (unit + CLI proven).

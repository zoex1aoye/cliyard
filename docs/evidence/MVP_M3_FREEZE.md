# MVP M3 — compile + freeze evidence

> Measured 2026-11-08 (Asia/Shanghai).
>
> Branch: `cursor/mvp-m3-freeze-0da8`.
> Plan: `design/mvp-m3-freeze-v0.plan.json`.
> Contracts: `design/mvp-m3-freeze-v0.contracts.json`.
> Accepted integration base: `e0f6bb6` (M2 / PR #29).

## 1. What landed

- `src/mvp/compile.ts` — Plan → unfrozen local-cli drafts (`frozen: false`)
- `src/mvp/freeze.ts` — human freeze + `.sha256` sidecar + immutability check
- CLI: `cliyard mvp-compile`, `cliyard mvp-freeze`
- DSH tools: `cliyard_mvp_compile`, `cliyard_mvp_freeze`
- Fixture plan: `examples/mvp/echo.plan.json`
- idle-spin refuses unfrozen; hash mismatch fails closed when sidecar present
- Tests: `tests/mvp-freeze.test.ts`

## 2. Commands

```bash
npm run build
npx tsx --test tests/mvp-freeze.test.ts tests/mvp-idle-spin.test.ts
npx tsx src/cli.ts mvp-compile examples/mvp/echo.plan.json --out /tmp/mvp-drafts --json
npx tsx src/cli.ts mvp-freeze /tmp/mvp-drafts/mvp-echo-from-plan.draft.contract.json \
  --out /tmp/mvp-echo.frozen.contract.json --json
```

## 3. Non-claims

- No auto-approve Plan; no auto-dispatch on compile.
- No coding-model compiler.
- Not a deepen of mainline `plan-dispatch` / queue freeze.
- M4 real CLI demos still outstanding.

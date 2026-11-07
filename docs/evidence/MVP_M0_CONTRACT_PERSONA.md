# MVP M0 + M0.5 — evidence

> Measured 2026-11-08 (Asia/Shanghai).
>
> Branch: `cursor/mvp-m0-contract-persona-0da8`.
> Plan: `design/mvp-m0-contract-persona-v0.plan.json`.
> Accepted integration base: `d64ca4c` (stop-loss roadmap / PR #26).

## 1. What landed

- JSON Schema: `design/dsh-plugin-cliyard-taskcontract-v0.schema.json`
- Mock code fixture: `examples/mvp/code-local-cli.mock.contract.json`
- Hand validator: `src/mvp/taskcontract.ts` (rejects absolute `driver.target`)
- Master persona load + mount helper: `src/mvp/master-persona.ts`
- Plugin mount: `plugins/dsh-cliyard/lib/master-persona.js` on apply when
  `ctx.systemPrompt` exists

## 2. Commands

```bash
npm run build   # exit 0
npx tsx --test tests/mvp-taskcontract.test.ts tests/mvp-master-persona.test.ts
# → pass
```

## 3. Non-claims

- No `/cliyard-test` spawn yet (M1).
- Persona mount is unit-proven against a fake `systemPrompt`; live DSH session
  check is still outstanding on a real profile.
- No Landlock / SQLite / process-tree deepen.

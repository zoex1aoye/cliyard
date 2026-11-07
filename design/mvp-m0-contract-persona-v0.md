# MVP M0 + M0.5 — TaskContract schema & Master persona mount

> After roadmap stop-loss land (`d64ca4c` / PR #26).
> Stages from [dsh-plugin-mvp-roadmap-v0.md](./dsh-plugin-mvp-roadmap-v0.md).

## Goals

1. **M0** — JSON Schema + code-scene mock fixture + pure-TS validator
   (`src/mvp/taskcontract.ts`). Fail closed on absolute `driver.target`.
2. **M0.5** — Mount Master persona into DSH via `ctx.systemPrompt.section`
   when available; no-op outside DSH. Source text from
   `design/dsh-master-persona-v0.prompt.txt`.

## Non-goals

- No `/cliyard-test` spawn yet (M1).
- No dispose wire beyond existing plugin dispose (M2).
- No Compiler / `/freeze` CLI (M3).
- Do not deepen SQLite / Landlock / process-tree.

## Verify

```bash
npm run build
npx tsx --test tests/mvp-taskcontract.test.ts tests/mvp-master-persona.test.ts
```

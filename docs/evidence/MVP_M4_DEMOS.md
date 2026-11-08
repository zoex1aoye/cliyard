# MVP M4 — dual-scene demos evidence

> Measured 2026-11-08 (Asia/Shanghai).
>
> Branch: `cursor/mvp-m4-demos-0da8`.
> Plan: `design/mvp-m4-demos-v0.plan.json`.
> Contracts: `design/mvp-m4-demos-v0.contracts.json`.
> Accepted integration base: `e4f2f86` (M3 / PR #30).

## 1. What landed

- idle-spin supports `workspace.kind=assets` (mkdir cage + cwd lock)
- Plans: `examples/mvp/code-codex.plan.json` (target `codex`) and
  `examples/mvp/novel-ep1.plan.json` (scene=novel, assets)
- `cliyard mvp-demo` / DSH `cliyard_mvp_demo`: compile → freeze → spin →
  `.cliyard/mvp-demo/status.json`
- Tests: `tests/mvp-demo.test.ts`

## 2. Commands

```bash
npm run build
npx tsx --test tests/mvp-demo.test.ts tests/mvp-freeze.test.ts tests/mvp-idle-spin.test.ts
# fixture repo:
npx tsx src/cli.ts mvp-demo --repo <git-repo> --json
```

## 3. Measured behaviour

- Both scenes `ok` on a temp git fixture.
- This environment had **no** `codex`/`claude`/`opencode` on PATH →
  `codexMode=standin` recorded (not a live model session).
- Novel scene wrote `episodes/ep1.md` under the assets cage via local-cli
  stand-in (not live `dsh-llm`).

## 4. Non-claims

- No auto-merge to main.
- No live Codex/Claude/OpenCode model session claimed when binary missing.
- No live DSH LLM novel generation.
- MVP plugin line M0–M4 demo envelope is evidence-ready for human review;
  mainline inventory remains frozen until a new unfreeze Plan.

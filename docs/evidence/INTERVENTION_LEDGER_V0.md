# Human intervention ledger v0 — evidence

> Measured 2026-11-07 (Asia/Shanghai).
>
> Branch: `cursor/intervention-ledger-v0-0da8`.
> Plan: `design/intervention-ledger-v0.plan.json`.
> Accepted integration base: `56c1bd2` (Reviewer v0 / PR #16).

## 1. What landed

- `HumanInterventionEvent` with six roles (`retry` / `judge` / `approve` /
  `carry` / `trigger` / `stand-in`) and four outcomes.
- Durable `.cliyard/interventions/<id>.json` + `index.jsonl`.
- `recordIntervention` / `resolveIntervention` with secret-like reason
  refusal and one-shot resolve from `unresolved`.
- Observational only — never acceptance / merge / Plan authority.

## 2. Commands

```bash
npm run build   # exit 0
npx tsx --test tests/intervention-ledger.test.ts
# → tests 4 / pass 4 / fail 0
```

## 3. Non-claims

- No auto Retry/Carry/Trigger execution.
- No SkillPack; no Control API write endpoints; no model call.

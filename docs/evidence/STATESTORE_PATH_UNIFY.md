# StateStore path unification — evidence

> Measured 2026-11-06 (Asia/Shanghai) on Linux 6.12.113+ x86_64,
> Node `v22.23.4`.
>
> Branch: `cursor/statestore-path-unify-0da8`.
> Plan: `design/statestore-path-unify-v0.plan.json`.
>
> Observational only.

## 1. What changed

- `src/statestore/paths.ts` — canonical `.cliyard/state.db` (+ evidence /
  fallback), legacy `runtime/statestore` one-shot relocate, dual-authority
  fail-closed.
- Supervisor, daemon, queue and control-domain cutover all resolve through
  `resolveControlStatePaths`.
- Control API write/auth remains deferred (documented in CURRENT_STATE /
  ROADMAP); not implemented here.

## 2. Commands

```bash
npm run build   # exit 0
npx tsx --test \
  tests/statestore-path-unify.test.ts \
  tests/supervisor-store.test.ts \
  tests/supervisor-resume.test.ts \
  tests/orchestration-queue.test.ts \
  tests/ledger-lock.test.ts
# → tests 49 / pass 49 / fail 0
```

## 3. Authority statement

After this land, the durable control-plane StateStore file for run, queue,
ledger and audit-event domains is `.cliyard/state.db` (or the JSON-file
fallback under `.cliyard/state-fallback/`). A repository that only has legacy
`.cliyard/runtime/statestore/` bytes is relocated once on first resolve. A
repository that has both layouts fails closed with `needs human`.

## 4. Non-claims

- No authenticated Control API write surface.
- No automatic merge of two populated authorities.
- No P3 sandbox claim.

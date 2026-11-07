# Human intervention ledger v0

> After clean-context Reviewer land (`56c1bd2` / PR #16). Priority item 8 in
> `docs/CURRENT_STATE.md`. Semantics from
> `design/continuous-harness-v2.md` §HumanInterventionEvent.

## Problem

Human interventions (retry, judge, approve, carry, trigger, stand-in) happen in
chat or ad-hoc ops, with no durable, secret-free audit trail bound to run/loop
identity. Without a ledger, harness eval and acceptance cannot count or replay
interventions as facts.

## Fix (v0)

1. **`HumanInterventionEvent`** — id, optional `runId`, required `loopId`,
   `role` ∈ {retry, judge, approve, carry, trigger, stand-in}, `reason`,
   `outcome` ∈ {unresolved, resolved, rejected, obsolete}, optional
   `artifactRef`, `observedAt`, optional `resolvedAt` / `resolutionNote`.
2. **Durable ledger** — atomic JSON records under
   `.cliyard/interventions/<id>.json` plus append-only
   `.cliyard/interventions/index.jsonl` for ordered listing.
3. **API** — `recordIntervention`, `resolveIntervention` (unresolved →
   resolved|rejected|obsolete only), `listInterventions` / `loadIntervention`.
   Reasons and notes are bounded and scanned for obvious secret patterns
   (API keys / bearer tokens) — refuse rather than store.
4. **Observational only** — never grants acceptance, merge, or Plan approval.
5. **Tests + evidence** — six roles recordable; invalid transitions refused;
   secret-like reason refused; CURRENT_STATE / ROADMAP / README touch.

## Non-goals

- Do not auto-execute Retry/Carry/Trigger automation.
- Do not implement SkillPack provenance.
- Do not wire interventions into Control API write endpoints.
- Do not call a model.

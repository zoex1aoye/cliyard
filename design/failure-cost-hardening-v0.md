# Failure/Cost Truth Hardening v0

> Date: 2026-10-27
>
> Status: human review found two pre-merge gaps after the first self-host run

## 1. Findings

The first self-host run completed after two explicit retries, but exposed two
truth gaps in the implementation.

### 1.1 Claude budget subtype was lost

Claude Code stream-json result records can carry a bounded `subtype`, such as:

```text
error_max_budget_usd
```

The current adapter preserves `is_error`, `result`, usage and
`total_cost_usd`, but drops `subtype`. A budget rejection with an empty
`result` text can therefore fall through to `unknown` or
`worker_process_exit`, defeating the most important known failure case.

### 1.2 Provider authority was not validated strictly enough

`createCostTruth` correctly makes provider authority depend on complete
amount and currency. The parser still accepted some records that constructors
would not emit as authoritative:

- `provider-reported` with a null currency;
- `authoritative: true` while `missing` still contains `cost.amount` or
  `cost.currency`;
- non-empty observations that are not provider-sourced under an authoritative
  provider total.

RunManifest and ledger parsing must fail closed rather than trust those shapes.

## 2. Scope

Implementation changes:

```text
src/failures.ts
src/agents/claude.ts
tests/failure-taxonomy.test.ts
tests/claude-failure-cost.test.ts
docs/evidence/FAILURE_COST_TRUTH.md
```

No changes to:

- the ten-category taxonomy;
- automatic retry policy;
- run authorization, routing, admission or parallelism;
- provider quota/balance discovery;
- RunManifest authority.

## 3. Required behavior

1. Preserve a bounded Claude result subtype through the adapter.
2. Classify `error_max_budget_usd` as `budget_exhausted` with stage `provider`
   and code `error_max_budget_usd`, unless an explicit wall-clock timeout
   outranks it.
3. Preserve an otherwise unknown bounded subtype as the failure code without
   inventing a category.
4. `provider-reported` observations must carry a non-null currency.
5. An authoritative provider total must have:
   - a provider source;
   - a non-null amount and currency;
   - no `cost.amount` or `cost.currency` missing reason;
   - observations that are empty or all provider-reported.
6. Existing CLI-estimated, usage-only and unavailable behavior remains
   unchanged.
7. Malformed records fail closed; old records remain readable.

## 4. Acceptance

```bash
npm run build
npx tsx --test tests/failure-taxonomy.test.ts
npx tsx --test tests/claude-failure-cost.test.ts
npm test
```

Tests must cover:

- budget subtype with empty result text;
- timeout precedence over budget subtype;
- unknown subtype preserved only as a bounded code;
- provider-reported null-currency rejection;
- authoritative true with incomplete amount/currency rejection;
- authoritative provider total with non-provider observation rejection;
- valid provider-reported round trip;
- valid CLI-estimated null-currency behavior remains non-authoritative.

The evidence document records the self-host findings and measured test counts.

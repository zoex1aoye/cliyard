# Worker Failure Taxonomy and Cost Truth v0 — Measured Evidence

> Date: 2026-10-27
>
> Environment: macOS (Darwin 27.0.0), Node `v20.20.2`, npm `10.8.2`,
> cliyard HEAD `ac9dc8d` (failure-cost-hardening-docs merged; this evidence
> correction is uncommitted).
>
> Scope: the shared failure/cost shapes, the classifier and parsers, the
> Claude/Codex adapter observations, closed-loop aggregation, durable
> RunManifest checkpoints, queue pre-dispatch failures, status surfaces and the
> bounded event journal. These are local measurements, not a CI result, a
> flake-rate claim, a DeepSeek invoice, or a provider-balance measurement.
>
> Verification has two separate parts. The implementation is covered by
> fixture-based tests: the adapter tests spawn temporary fake CLI executables
> that emit shaped result records, start no real provider session and incur no
> billing. Those tests prove classification, parsing and persistence behavior;
> they do not prove provider billing, balance, authorization, routing or
> production transcript compatibility. Separately, the v0 and hardening tasks
> were implemented through cliyard's own queue with real Claude Code sessions
> over the DeepSeek Anthropic-compatible endpoint; §2.3 records those runs, the
> legacy path's `implement failed: exitCode=1` reports, and the failed first
> attempts' CLI-side budget usage: 9.939564 USD of a `$10` guard for
> `failure-cost-durable` and 4.883416 USD of a `$5` guard for
> `failure-cost-docs`. Those are per-attempt CLI budget observations, not task
> totals or provider invoices. Those real sessions did not exercise the new
> subtype-aware adapter path, and no provider invoice, balance or
> provider-reported cost was checked. The prior v0 round was measured at
> HEAD `69f62de` and is preserved as historical evidence in §2.1; §2.2 measures
> the post-review hardening tree at `fa2694b`.

Failure and cost are **observational**. They do not grant acceptance, authorize
an automatic retry, change dispatch, or replace the RunManifest as the
task-level authority. No DeepSeek billing or balance authority is claimed, and
no run-level authoritative cost total exists in v0. The real self-host amounts
in §2.3 are non-authoritative CLI-side budget observations, not provider
invoices, bills or balances.

## 1. Implemented

### 1.1 Failure taxonomy

`src/failures.ts` is the single source for the exact ten-category enum:

```text
budget_exhausted
timeout
provider_transient
provider_auth
provider_protocol
worker_process_exit
verifier_rejected
policy_blocked
resource_exhausted
unknown
```

Failure stages are:

```text
contract | preflight | spawn | provider | worker | verifier | policy | unknown
```

Classification priority, highest first:

```text
timeout
  > budget_exhausted
  > provider_auth
  > resource_exhausted
  > provider_transient
  > provider_protocol
  > worker_process_exit
  > verifier_rejected
  > policy_blocked
  > unknown
```

Signals in order:

- an adapter timeout flag, exit code `124`, or (when no numeric transient
  status is present) timeout text produces `timeout`;
- budget/auth/resource text outranks transient status text;
- `429`/`500`/`502`/`503`/`504`/`529` and transport phrases such as
  `ECONNRESET`, `overloaded` or `rate limit` produce `provider_transient`;
  `504 Gateway Timeout` therefore stays transient, not `timeout`;
- malformed JSON/stream/protocol text produces `provider_protocol`;
- a non-zero exit, terminating signal or spawn failure with no stronger signal
  produces `worker_process_exit`;
- `verifier_rejected` requires `workerSucceeded === true` and
  `verifierRejected === true`. A worker process failure is never relabeled as a
  verifier rejection, even when the verifier also fails afterward;
- a deterministic pre-dispatch rejection produces `policy_blocked`;
- anything unrecognized fails closed to `unknown`.

Provider result subtypes (hardening round):

- the Claude adapter retains only a normalized, bounded, credential-free
  `subtype` from the result record; the raw provider value is not retained;
- `error_max_budget_usd` is a direct budget signal and produces
  `budget_exhausted` with stage `provider` and code `error_max_budget_usd`;
- an explicit wall-clock timeout still outranks the subtype. The adapter
  timeout flag or exit `124` produces `timeout` / `worker`; non-transient
  timeout text produces `timeout` / `provider`. In both cases the code is
  `timeout`, even when the result also carried `error_max_budget_usd`;
- no other subtype changes the category. A bounded unknown subtype is retained
  as the failure `code` (for example `error_max_turns`) when the category is
  not `timeout` and no explicit code is supplied, while the category comes from
  the ordinary signals. `success` is never used as a failure code;
- an explicit `code` wins over a subtype for the record code, and a non-string
  or empty subtype contributes no code;
- subtype text is normalized into the bounded code space (whitespace runs
  become `_`), secret-redacted (including tokens glued directly to an
  identifier prefix) and capped at 64 characters.

Exact subtype precedence covered by the focused tests:

| Signals | Category | Stage | Code |
|---------|----------|-------|------|
| `error_max_budget_usd`, exit `1` | `budget_exhausted` | `provider` | `error_max_budget_usd` |
| `error_max_budget_usd` + timeout flag or exit `124` | `timeout` | `worker` | `timeout` |
| `error_max_budget_usd` + timeout text, exit `1` | `timeout` | `provider` | `timeout` |
| another subtype, exit `1`, no stronger text | `worker_process_exit` (fixture) | `worker` | the subtype |
| `success`, exit `1` | `worker_process_exit` | `worker` | `exit_1` |
| explicit `code` + other subtype, exit `1` | `worker_process_exit` | `worker` | the explicit code |

The subtype is an additional budget signal, not a priority change: it does not
move `budget_exhausted` above `timeout` in the design order.

Each `FailureRecord` is version `1` with `category`, `stage`, optional `code`,
bounded `message`, `observedAt` and an advisory `retryableHint`:

| Bound | Value |
|-------|-------|
| Failure message | 400 characters |
| Failure code | 64 characters |
| Tokenized text scanned | last 8,000 characters |
| Observation session id | 128 characters |
| Observation note | 300 characters |
| Currency label | 24 characters |
| Missing reason | 200 characters |
| Missing reasons per cost | 128 |

Only the declared fields leave `createFailureRecord`; unknown payload fields are
never copied. Text is whitespace-collapsed, tail-scanned and secret-redacted
(`sk-…`, `ghp_…`, `xox…`, `AKIA…`, Bearer tokens, API-key/token/password
assignments and private-key blocks). Default codes are `timeout`,
`spawn_error`, `signal_<name>`, `exit_<n>`, or a sanitized explicit code.
`retryableHint` defaults to `true` only for `provider_transient`, `timeout`
and `resource_exhausted`; it is advisory and cannot trigger a retry.

### 1.2 Cost truth

`CostTruth` has exactly four states:

| State | Source | Amount | Usage | Authoritative |
|-------|--------|--------|-------|---------------|
| `provider-reported` | `provider` | non-null | optional | only when source is provider, amount and currency are non-null, no amount/currency missing reason exists, and observations are empty or all provider-reported |
| `cli-estimated` | `cli` | non-null | optional | always `false` |
| `usage-only` | `none` | `null` | non-null | always `false` |
| `unavailable` | `none` | `null` | `null` | always `false` |

Sources are exactly `provider | cli | none`. A `CostTruth` also carries
`observations[]` (per-session provenance), `missing[]` reasons, and
`guardBudgetUsd`.

Rules enforced by construction and by the fail-closed parser:

- missing cost is `unavailable`, never coerced to zero;
- a zero explicitly emitted by the CLI is preserved as zero but remains
  non-authoritative;
- malformed amounts/usage become `null`, not zero or a guessed value;
- a `provider-reported` observation requires a provider source, a non-null
  amount and a non-null currency. A null or undefined currency is rejected even
  when the aggregate carries a currency;
- an authoritative `provider-reported` total requires a provider source,
  non-null amount and currency, no `cost.amount` or `cost.currency` missing
  reason, and `observations[]` that is empty or entirely `provider-reported`.
  `cost.usage` may still be missing: authority is financial attribution, not
  field completeness;
- a non-authoritative provider total may omit currency (for example with
  empty observations) but can never be marked authoritative. A `cli-estimated`
  record with an unknown currency is likewise valid only as non-authoritative;
- construction fails closed to the same rules: a provider-sourced amount with
  no currency is not emitted as a provider observation. It becomes
  `usage-only` when usage exists, otherwise `unavailable`, with `amount: null`
  and `source: "none"`, so the constructor cannot produce a record its own
  parser rejects;
- `provider-reported` is type/parser support only. The current Claude and
  Codex integrations emit no provider-reported cost;
- a `usage-only` record keeps tokens even when cost is absent;
- mixed currencies are never combined; the aggregate amount becomes `null` and
  `cost.amount` / `cost.currency` are recorded as missing;
- known CLI estimates may be summed into a non-authoritative observed
  subtotal; unknown components stay in `missing`;
- `guardBudgetUsd` records the configured `--max-budget-usd` guard, not spend;
  aggregation sums recorded guards unless an explicit guard is supplied.

Completeness is about observed fields, not authority:

```text
complete = amount present
           + all four token fields present
           + no missing reasons
partial  = some cost/usage evidence exists but is incomplete
missing  = no CostTruth, or state is unavailable
```

A `complete` CLI estimate still has `authoritative: false`.

### 1.3 Adapter behavior

Claude Code over the DeepSeek Anthropic-compatible endpoint:

- `total_cost_usd` is persisted as `state: "cli-estimated"`,
  `source: "cli"`, `authoritative: false`; it is never labelled a DeepSeek
  invoice, bill or available balance;
- top-level `usage` is persisted independently; when absent or malformed,
  per-model `modelUsage` records are aggregated;
- cost absent + tokens present → `usage-only`; both absent or malformed →
  `unavailable`;
- every provider session started by the adapter (including its own transient
  retries) contributes one observation; retry sessions are aggregated;
- the configured `maxBudgetUsd` is recorded as `guardBudgetUsd`, not spend;
- a missing result record produces `unavailable` with a bounded note such as
  "worker exited with code N before a result record", never `$0`;
- the normalized result subtype is retained on the internal result and passed
  to failure classification; the raw subtype text is not retained;
- a timeout is classified before provider text as `timeout/worker`; spawn,
  cwd and process failures produce bounded spawn/preflight/worker records.

Codex:

- a non-zero exit with no stronger signal produces `worker_process_exit`;
- its wall-clock timeout produces `timeout` (exit `124`);
- cost is `unavailable` because this CLI integration exposes no usage, with a
  bounded observation note.

The mock adapter may omit both optional fields; the closed loop then applies
the same fallback classifier.

### 1.4 Durable integration

`RunTaskState` carries optional `failure` and `cost`:

- accepted task: persist `cost`, no `failure`;
- rejected task: persist both `failure` and `cost`;
- dependency-blocked/skipped task: persist `policy_blocked` with stage
  `policy` and no fabricated cost;
- a new attempt clears the prior attempt's `failure`/`cost` before dispatch;
- accepted cost is checkpointed before the task worktree is cleaned up, so it
  survives cleanup;
- the closed loop aggregates every worker session it started, including
  repairs;
- the queue stores `failure` on a `QueueItem` only for a deterministic
  pre-dispatch block with no RunManifest. A dispatched run's failure/cost lives
  only in its RunManifest, which the queue never rewrites;
- absent optional fields keep legacy manifests, ledgers and queue records
  readable; malformed structured fields fail closed with a clear parse error.

### 1.5 Observation surfaces

`supervisor status --json` passes through each task's `failure` and `cost`.
Human output prints one line per task carrying either observation, for example:

```text
task task: rejected failure=budget_exhausted/provider (exit_1) cost=cli-estimated 0.07 USD (observed, non-authoritative) missing=cost.usage
task missing: rejected cost=unavailable missing=cost.amount,cost.usage
```

An amount is printed only when observed. Missing cost is never rendered as
`$0`.

`queue status [--json]` adds:

- per-item and per-run-task `failure`/`cost`;
- non-zero durable failure-category counts (`failureCounts`);
- an observed cost snapshot with `authoritative: false`, `state`,
  `completeness`, `currency`, `amount`, `usage` and `missing`.

The snapshot uses a RunManifest task failure as the primary decision signal;
text heuristics remain only for legacy records. A QueueItem failure is counted
only when no RunManifest exists, so one dispatched task is not double-counted.
The run-level cost is always `authoritative: false`, even when every
observation is provider-reported.

`run.blocked` journal events carry bounded `failureCategory`, `failureStage`,
`failureCode` and `costState`. Journal validation uses the same enums; unknown
categories or malformed lines are counted and skipped. Appends are
best-effort and cannot change queue/run authority.

### 1.6 No automatic retry

This slice adds no automatic retry, routing, admission or parallel dispatch:

- the closed loop rejects immediately on a non-zero worker exit; it does not
  retry worker failures;
- verifier rejection uses the pre-existing bounded `maxRepairs` repair path,
  not taxonomy-driven retry;
- `retryableHint` cannot trigger anything;
- the queue marks a failed dispatch `blocked`; retrying requires an explicit
  `queue retry` and then `queue run`;
- Supervisor resume requires an explicit `resume --retry-rejected`;
- the Claude adapter keeps its pre-existing bounded transient retry
  (`maxTransientRetries`, default `2`, exponential 1 s/2 s) for transport and
  `429`/5xx signals. The taxonomy does not add or remove retries; after retry
  exhaustion the adapter returns the final structured failure and aggregates
  every session's cost.

### 1.7 Post-review hardening

Review of the v0 slice identified two gaps. The hardening task closed both
without changing any taxonomy value, stage, cost state, retry, acceptance,
routing, admission or queue behavior.

#### Finding 1 — the Claude result subtype was discarded

Before: the adapter parsed `is_error`, `result`, usage and cost but dropped the
provider result `subtype`, and the classifier had no subtype signal. A budget
stop therefore depended on matching provider prose. No test proved that a
wall-clock timeout outranks a provider subtype or that an unknown subtype is
preserved without inventing a category.

Fix:

- the adapter normalizes and retains the subtype, then passes it to
  `createFailureRecord`;
- `error_max_budget_usd` maps to `budget_exhausted` / `provider` with code
  `error_max_budget_usd`, after explicit timeout and before text matching;
- every other subtype remains a bounded code only, unless an explicit code or
  a timeout code applies; `success` is not a failure code;
- codes are capped at 64 characters, and secret-shaped tokens are redacted
  even when glued to an identifier separator.

Measured coverage: one new core taxonomy test and four new Claude adapter
tests, listed in §2.6. The adapter tests use temporary fake CLI executables.

#### Finding 2 — provider cost authority was too permissive

Before: a `provider-reported` observation could be parsed without a currency,
and an `authoritative` provider total could carry a missing amount/currency
reason or non-provider observations. The constructor could also emit a
currencyless provider observation; tightening the parser alone would have made
that constructor output invalid, so construction was changed in the same task
to fail closed.

Fix:

- provider observations require a currency;
- authoritative provider totals require a provider source, non-null amount and
  currency, no `cost.amount`/`cost.currency` missing reason, and observations
  that are empty or all provider-reported;
- non-authoritative provider and CLI records with an unknown currency remain
  parseable but cannot claim authority;
- construction downgrades a currencyless provider amount to
  `usage-only`/`unavailable` instead of emitting it.

Measured coverage: one new core taxonomy test with positive and negative
cases, plus the existing cost construction/parser tests, listed in §2.6.

The hardening added no provider billing, balance, authorization, routing,
automatic retry or provider-call behavior. The subtype and authority tests use
in-memory records and temporary fake CLI executables; the real self-host
sessions that implemented the slice are recorded separately in §2.3.

## 2. Measured verification

Two fixture measurement rounds are recorded. §2.1 is the historical v0 round
at HEAD `69f62de`. §2.2 is the post-review hardening round at HEAD `fa2694b`;
its counts are the current claims. §2.3 records the separate real self-host
execution that built and hardened the slice. All commands were run from the
cliyard checkout on 2026-10-27.

### 2.1 Prior v0 round (historical, HEAD 69f62de)

Commands:

```bash
npm run build
npx tsx --test tests/failure-taxonomy.test.ts
npx tsx --test tests/claude-failure-cost.test.ts
npx tsx --test tests/supervisor-failure-cost.test.ts
npx tsx --test tests/queue-control-snapshot.test.ts
npx tsx --test tests/failure-taxonomy.test.ts tests/claude-failure-cost.test.ts \
  tests/supervisor-failure-cost.test.ts tests/queue-control-snapshot.test.ts
npm test
```

Observed results:

```text
build:                         exit 0
failure taxonomy:              14/14 pass in 85.7 ms
claude failure/cost:           17/17 pass in 11694.1 ms
supervisor failure/cost:       12/12 pass in 1134.9 ms
queue control snapshot:        7/7 pass in 733.3 ms
combined focused:              50/50 pass in 9991.6 ms
full suite:                    290/290 pass in 14175.8 ms
```

The focused counts were reproduced in a second run (same 14/17/12/7 and
50/50); durations vary between local runs. The full-suite count is 45 tests
above the prior 245-test baseline: 14 failure-taxonomy tests, 17 Claude adapter
failure/cost tests, 12 supervisor/queue durable tests and 2 additional
queue-control tests. The previous `245/245` measurement is historical, not a
claim about this round. This subsection is retained as historical evidence and
is superseded by §2.2 for the post-review tree.

### 2.2 Hardening round (HEAD fa2694b)

The hardening task changed only `src/failures.ts`, `src/agents/claude.ts` and
the two focused test files; the durable paths were not modified.

Commands:

```bash
npm run build
npx tsx --test tests/failure-taxonomy.test.ts
npx tsx --test tests/claude-failure-cost.test.ts
npx tsx --test tests/supervisor-failure-cost.test.ts
npx tsx --test tests/queue-control-snapshot.test.ts
npx tsx --test tests/failure-taxonomy.test.ts tests/claude-failure-cost.test.ts \
  tests/supervisor-failure-cost.test.ts tests/queue-control-snapshot.test.ts
npm test
git diff --check
```

Observed results:

```text
build:                         exit 0
failure taxonomy:              16/16 pass in 99.1 ms
claude failure/cost:           21/21 pass in 16394.1 ms
supervisor failure/cost:       12/12 pass in 1115.5 ms
queue control snapshot:        7/7 pass in 761.4 ms
combined focused:              56/56 pass in 14892.2 ms
full suite:                    296/296 pass in 15085.5 ms
git diff --check:              exit 0 (documentation diff)
```

The focused counts were reproduced in a second run (same 16/21/12/7 and
56/56; combined 14998.9 ms). The full suite was re-run at 296/296 in
14827.2 ms. Durations vary between local runs. The full suite is 51 tests
above the 245 baseline and 6 above the v0 round's 290: 2 new failure-taxonomy
tests and 4 new Claude adapter tests. The 14/17/12/7, 50/50 and 290/290 counts
in §2.1 are historical, not the current claim.

The §2.1 and §2.2 test commands use temporary fake CLI executables and
in-memory records. They invoke no real provider, incur no billing and query no
balance; no real self-host transcript was parsed by the new subtype path. Real
provider sessions were used to build the slice, recorded separately in §2.3.

### 2.3 Real self-host execution (historical)

The slice itself was built by cliyard's own queue and Supervisor using the real
Claude Code adapter over the DeepSeek Anthropic-compatible endpoint, not the
fixture binaries. Two plan runs are relevant:

```text
plan failure-cost-truth-v0        run 9bfa2611-858c-4fdb-859b-6f6929f81baf
                                  base 7193df6, completed 2026-10-27T15:35:06Z
plan failure-cost-hardening-v0    run 4a374965-cda2-49d6-b2d1-cc48ebdbaae5
                                  base f06fea4, completed 2026-10-27T15:51:54Z
```

What the real execution showed:

- `failure-cost-core` was accepted in the first queue attempt.
- `failure-cost-durable`'s first implementation attempt returned a non-zero
  worker result. The legacy path — the control plane predated the durable
  integration (run base `7193df6`) — reported only
  `implement failed: exitCode=1`, with no structured failure category, stage or
  code and no persisted cost. An explicit `queue retry` resumed the same run,
  reused the task's existing dirty worktree, and started a new provider
  session; that attempt was accepted and committed `64578d5`.
- `failure-cost-docs` showed the same pattern one queue attempt later: the
  first implementation attempt was reported as `implement failed: exitCode=1`,
  the queue retry reused the dirty worktree with a new provider session, and
  the retry was accepted and committed `3930fd2`.
- The failed first `failure-cost-durable` attempt used 9.939564 of its `$10`
  CLI budget guard; the failed first `failure-cost-docs` attempt used 4.883416
  of its `$5` guard. These are Claude Code's own non-authoritative CLI-side
  budget observations (`budget_usd.used` against `budget_usd.total`) for those
  failed sessions, not provider invoices, bills, balances, persisted
  `CostTruth` records or provider-reported cost; the guards are configured
  caps, not spend. They are not task-level or run-level totals, and the
  accepted retries were separate provider sessions.
- The hardening plan required one verifier repair before acceptance.
  `failure-cost-hardening-core` was rejected by the verifier once, then
  accepted after a repair session (two provider sessions in total, ledger
  `repairCount: 1`, committed `58471b6`); `failure-cost-hardening-docs` was
  accepted after one provider session with no repair (committed `9bb60f5`).

Boundary: these real sessions ran against control-plane code that predated the
subtype hardening, so they did not exercise the new subtype-aware adapter path.
That path is covered by the fake CLI fixtures described in §2.2 and §2.6, with
in-memory unit coverage for the classifier; no new real provider session
exercised it before merge. The real execution also did not persist or surface
structured failure/cost through the new durable fields (its run manifests carry
neither), and no provider billing, invoice or balance was checked. The legacy
`implement failed: exitCode=1` text is the reporting gap this slice addresses;
the observed CLI-side budget usage alone does not establish the legacy
failure's category.

### 2.4 Exact enums (printed from the current build)

```text
FAILURE_CATEGORIES=["budget_exhausted","timeout","provider_transient","provider_auth","provider_protocol","worker_process_exit","verifier_rejected","policy_blocked","resource_exhausted","unknown"]
FAILURE_STAGES=["contract","preflight","spawn","provider","worker","verifier","policy","unknown"]
COST_STATES=["provider-reported","cli-estimated","usage-only","unavailable"]
COST_SOURCES=["provider","cli","none"]
```

### 2.5 Representative durable outputs (observed in the v0 round)

The durable output-producing paths did not change in the hardening task. These
outputs were observed in the v0 round and are retained as historical evidence.

`supervisor status` human output from a scratch RunManifest with one budget
rejection and one missing-cost task (exact lines observed; scratch paths
omitted because they are not part of the claim):

```text
task budget-task: rejected failure=budget_exhausted/provider (exit_1) cost=cli-estimated 0.07 USD (observed, non-authoritative) missing=cost.usage
task missing-cost-task: rejected cost=unavailable missing=cost.amount,cost.usage
```

Representative `queue status` human output from a scratch pre-dispatch block
after the frozen contracts bytes changed (exact excerpt; scratch path
abbreviated):

```text
failure categories: policy_blocked 1
cost: unavailable; non-authoritative; completeness missing; missing cost.observation, cost.amount, cost.usage
pre  blocked  next=inspect-and-retry  ready=no  worker=claude  attempts=0/3
  failure: policy_blocked/policy (contracts_mismatch)
  decision: policy — contracts changed: <scratch>/contracts.json (expected sha256 …, found …)
```

The corresponding `queue run` reported `dispatched=0`; the item was blocked
before any attempt increment or Supervisor call.

### 2.6 Focused coverage

The focused and durable tests prove:

- the enum contains exactly the ten design categories, all eight stages, and
  the four cost states;
- priority: adapter timeout beats budget text, `124` beats auth text, budget
  beats auth, auth beats transient, resource beats transient, `504 Gateway
  Timeout` stays transient, protocol beats process exit, process exit when
  nothing stronger, signals/spawn, and verifier rejection only after worker
  success;
- a worker failure is never relabeled `verifier_rejected`;
- failure records are credential-free and bounded; injected
  `rawPayload`/`prompt`/`authHeader` fields do not leave the function;
- parsers fail closed on wrong version, unknown enums, empty/oversized
  messages, invalid timestamps/codes/booleans, inconsistent state/source/amount
  combinations, and malformed observations; unknown fields are dropped;
- explicit zero cost and zero usage survive; malformed cost/usage do not become
  zero; token-only, amount-only, partial and mixed-currency aggregates keep
  missing reasons;
- provider-reported cost requires currency at the observation level, and is
  authoritative only with provider source, non-null amount/currency, no
  amount/currency missing reason, and empty or all-provider observations;
  non-authoritative provider and CLI records with unknown currency stay
  non-authoritative; a CLI estimate is always non-authoritative;
- construction downgrades a currencyless provider amount to `usage-only` (or
  `unavailable`) instead of emitting a provider observation the parser would
  reject;
- provider result subtypes: `error_max_budget_usd` classifies
  `budget_exhausted`/`provider` with code `error_max_budget_usd`; an explicit
  timeout signal (flag, exit `124` or non-transient timeout text) outranks it
  in category and code; unknown subtypes are preserved as bounded codes
  without inventing a category; `success` is not a code; an explicit code
  wins; subtype length is bounded and glued secret-shaped tokens are redacted;
- the Claude adapter forwards the normalized subtype and adds no retry for
  the budget/auth/resource/protocol cases: a fake budget result yields one
  attempt, and a fixture that emits the budget subtype then hangs yields
  `timeout`/`worker` with code `timeout`;
- Claude preserves top-level usage and falls back to `modelUsage`; a timeout
  and spawn failure carry structured categories and unavailable cost; failures
  retain bounded provider text but no secrets or raw payloads;
- Codex distinguishes process exit and timeout and reports unavailable cost;
- the closed loop aggregates repair cost, persists accepted cost without
  failure, persists rejected failure+cost, distinguishes verifier rejection,
  and falls back to `worker_process_exit` when the adapter omits fields;
- accepted cost survives the RunManifest checkpoint and worktree cleanup;
  worker/verifier failures checkpoint distinctly and dependants become
  `policy_blocked` without cost;
- legacy ledger/manifest/queue records load; malformed structured fields throw
  clear errors; a valid policy failure round-trips;
- `supervisor status --json` and human output expose failure/cost without
  fabricating amounts; unavailable cost is not printed as zero;
- a pre-dispatch block is durable without a RunManifest, journaled, visible in
  `queue status`, and cleared by `queue retry`;
- a dispatched run's failure/cost is journaled from the manifest while the
  QueueItem stays free of a duplicated failure and the manifest is not
  rewritten;
- dependency propagation journals bounded `policy_blocked` fields;
- event fields are bounded and validated, and a malformed category is counted
  as a malformed journal line;
- `queue status` prefers durable run categories over stale item text and
  reports non-authoritative cost; mixed currencies are not combined;
- the adapter tests are temporary fake CLI executables emitting shaped result
  records. They verify adapter behavior only; the fixture tests themselves
  start no real provider session and involve no invoice, balance,
  authorization result or self-host transcript. This is separate from the real
  self-host execution in §2.3; no real provider session exercised the new
  subtype-aware path before merge.

## 3. Acceptance matrix

Design acceptance items from
[design/failure-cost-truth-v0.md](../../design/failure-cost-truth-v0.md) §11:

| # | Requirement | Status | Measured coverage |
|---|-------------|--------|-------------------|
| 1 | Every newly rejected dispatched task has a non-empty structured failure | Implemented | Claude/Codex adapters emit one; Claude maps the normalized budget subtype; closed-loop fallback covers field-less adapters; RunManifest checkpoint test asserts the record |
| 2 | Worker failure and verifier rejection are distinguishable | Implemented | Priority tests + supervisor checkpoint test: worker exit stays `provider_auth`/`worker_process_exit`; only post-success rejection is `verifier_rejected` |
| 3 | Missing cost is `unavailable`, not zero | Implemented | Cost construction/parser tests; Claude missing-field test; status tests assert `amount: null` and no `$0` |
| 4 | Claude compatibility cost is explicitly non-authoritative | Implemented | `cli-estimated`, `source: cli`, `authoritative: false` asserted for explicit zero, normal amount and retry aggregation; provider authority tests reject currencyless and mixed-provenance totals |
| 5 | Token usage survives when cost does not | Implemented | `usage-only` tests at core and Claude adapter levels; malformed-cost/valid-usage case |
| 6 | RunManifest remains acceptance authority | Implemented | Queue reads manifest failure/cost without rewriting; QueueItem failure only for no-manifest pre-dispatch blocks; control snapshot dedup test |
| 7 | Queue status shows failure/cost without mutating authority | Implemented | Read-only tests compare queue and journal bytes; status tests show failure counts and non-authoritative cost |
| 8 | Existing manifests and queue files remain backward compatible | Implemented | Legacy record tests load absent fields; malformed present fields fail closed with clear parse errors |
| 9 | Existing build and full suite remain green | Implemented | Hardening round (§2.2): `npm run build` exit `0`; full `npm test` 296/296; combined focused 56/56 |
| 10 | No daemon, automatic retry, routing, admission or parallel dispatch introduced | Implemented (verified by code/test scope) | Queue remains sequential foreground; no retry path uses `retryableHint`; only the pre-existing Claude transient retry remains; tests assert a non-transient category does not add an attempt |

Separately from the fixture counts, acceptance of the implementation tasks was
observed in the real self-host execution (§2.3): `failure-cost-durable` and
`failure-cost-docs` each required a queue retry after
`implement failed: exitCode=1`, and `failure-cost-hardening-core` required one
verifier repair before acceptance. Those are execution facts, not fixture test
results, and they add no billing, balance or provider-authority evidence.

## 4. Limits and boundaries

- **No billing or balance authority.** `cli-estimated` is Claude Code's own
  `total_cost_usd`, not a DeepSeek invoice, bill, quota or balance. The
  9.939564 USD and 4.883416 USD observations in §2.3 are the failed first
  attempts' non-authoritative CLI-side budget usage, not provider-reported
  cost. No provider quota/balance discovery is implemented.
- **Fixture-based implementation verification.** The adapter tests spawn
  temporary fake CLI executables and assert on shaped result records. Those
  fixture tests start no real Claude/DeepSeek session, incur no billing, and
  observe no balance, authorization or routing result; no real self-host
  transcript was parsed by the new subtype path. This does not mean no real
  provider execution occurred: §2.3 records the real queue-driven sessions that
  built the slice. Neither the fixtures nor those real runs establish provider
  billing, balance, authorization or routing truth. No raw fixture or
  transcript payload is copied into this document.
- **Real self-host execution is not billing evidence.** The real runs in §2.3
  produced observed CLI-side budget usage and included the non-zero exits and
  verifier repair described there; the tasks were accepted only through the
  existing queue retry and repair paths. The 9.939564 USD and 4.883416 USD
  amounts from the failed first attempts are not a DeepSeek invoice, bill,
  quota, available balance or provider-reported cost; no invoice or balance was
  queried. The failed attempts' `$10` and `$5` guards are configured caps, not
  spend.
- **No run-level authoritative total.** Supervisor tasks expose per-task cost;
  the control snapshot's run-wide cost is always `authoritative: false`, even
  when every observation is provider-reported. Known CLI amounts may form an
  observed subtotal only when currencies agree.
- **`guardBudgetUsd` is a guard, not spend.** It records the configured budget
  cap. Summing guards across sessions or tasks is not expected or actual cost.
- **No built-in provider-reported cost source.** The type/parser supports
  `provider-reported` under the hardened authority rules in §1.2, but the
  current Claude and Codex integrations emit `cli-estimated`, `usage-only` or
  `unavailable` only.
- **Classification is bounded heuristics.** It uses process signals, a bounded
  tail of provider/worker text, and the bounded Claude result subtype. Only
  `error_max_budget_usd` changes a category; other subtypes are codes, not
  categories. Unusual provider prose can still fall to `unknown` or, when a
  process also failed, `worker_process_exit`. It is not a model-quality
  judgment and retains no raw provider payload, prompt, file content, auth
  header or transcript.
- **Verifier rejection is post-success only.** A worker process failure keeps
  its stronger category even if verification later fails.
- **Cost completeness is field-level.** Mixed currencies are never combined;
  an unknown currency prevents currency attribution; missing reasons remain
  explicit. There is no cross-provider billing reconciliation.
- **No automatic retry.** `retryableHint` is advisory. The closed loop retries
  only verifier failures via the pre-existing `maxRepairs` repair path; the
  queue requires explicit `queue retry`; Supervisor requires explicit
  `resume --retry-rejected`. The Claude adapter's pre-existing bounded
  transient retry (default `2`) is unchanged and is not taxonomy-driven.
- **No routing, admission, parallel dispatch, daemon or Control API.** Queue
  dispatch remains sequential, same-host and foreground. Failure/cost do not
  feed a scheduler.
- **Local measurement.** These are local macOS runs and focused fixtures, not
  a CI result, long-term flake rate, provider invoice, cost forecast or
  cross-host claim. The v0 and hardening rounds were measured separately at
  different HEADs, as recorded in §2.1 and §2.2. The real self-host execution
  is a separate local run recorded in §2.3.

## 5. Links

Design authority:

- [design/failure-cost-truth-v0.md](../../design/failure-cost-truth-v0.md)

Source:

- [src/failures.ts](../../src/failures.ts)
- [src/agents/claude.ts](../../src/agents/claude.ts)
- [src/agents/codex.ts](../../src/agents/codex.ts)
- [src/repair/loop.ts](../../src/repair/loop.ts)
- [src/persistence/ledger.ts](../../src/persistence/ledger.ts)
- [src/scheduler/codex-batch.ts](../../src/scheduler/codex-batch.ts)
- [src/supervisor/types.ts](../../src/supervisor/types.ts)
- [src/supervisor/cli.ts](../../src/supervisor/cli.ts)
- [src/orchestration/queue-runner.ts](../../src/orchestration/queue-runner.ts)
- [src/orchestration/control-snapshot.ts](../../src/orchestration/control-snapshot.ts)
- [src/orchestration/event-journal.ts](../../src/orchestration/event-journal.ts)

Tests:

- [tests/failure-taxonomy.test.ts](../../tests/failure-taxonomy.test.ts)
- [tests/claude-failure-cost.test.ts](../../tests/claude-failure-cost.test.ts)
- [tests/supervisor-failure-cost.test.ts](../../tests/supervisor-failure-cost.test.ts)
- [tests/queue-control-snapshot.test.ts](../../tests/queue-control-snapshot.test.ts)

Operator documentation:

- [README.md](../../README.md)
- [docs/SUPERVISOR_V0.md](../SUPERVISOR_V0.md)
- [docs/CLAUDE_DEEPSEEK_WORKER.md](../CLAUDE_DEEPSEEK_WORKER.md)
- [docs/TASK_ESTIMATION.md](../TASK_ESTIMATION.md)
- [docs/NEXT_ITERATION.md](../NEXT_ITERATION.md)
- [docs/NEXT_STEP_CONTROLLER.md](../NEXT_STEP_CONTROLLER.md)
- [docs/evidence/ORCHESTRATION_QUEUE.md](ORCHESTRATION_QUEUE.md)

Prior observability slice (its "failure taxonomy and cost truth are not
implemented" limit predates this work and is superseded here):

- [docs/evidence/CONTROL_SNAPSHOT.md](CONTROL_SNAPSHOT.md)

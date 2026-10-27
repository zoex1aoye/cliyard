# Worker Failure Taxonomy and Cost Truth v0 — Measured Evidence

> Date: 2026-10-27
>
> Environment: macOS (Darwin 27.0.0), Node `v20.20.2`, npm `10.8.2`,
> cliyard HEAD `69f62de`.
>
> Scope: the shared failure/cost shapes, the classifier and parsers, the
> Claude/Codex adapter observations, closed-loop aggregation, durable
> RunManifest checkpoints, queue pre-dispatch failures, status surfaces and the
> bounded event journal. These are single local runs, not a CI result, a
> flake-rate claim, a DeepSeek invoice, or a provider-balance measurement.

Failure and cost are **observational**. They do not grant acceptance, authorize
an automatic retry, change dispatch, or replace the RunManifest as the
task-level authority. No DeepSeek billing or balance authority is claimed, and
no run-level authoritative cost total exists in v0.

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
| `provider-reported` | `provider` | non-null | optional | only when every amount observation is provider-reported and amount/currency are complete |
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
- provider-reported authority requires a complete amount/currency, not merely
  a provider label;
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

## 2. Measured verification

Commands were run from the cliyard checkout on 2026-10-27. Code is at HEAD
`69f62de`; this round's documentation changes are uncommitted.

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
above the prior 245-test baseline: 14 new
failure-taxonomy tests, 17 new Claude adapter failure/cost tests, 12 new
supervisor/queue durable tests, and 2 additional queue-control tests. The
previous `245/245` measurement is historical, not this round's claim.

Exact enums printed from the built module:

```text
FAILURE_CATEGORIES=["budget_exhausted","timeout","provider_transient","provider_auth","provider_protocol","worker_process_exit","verifier_rejected","policy_blocked","resource_exhausted","unknown"]
FAILURE_STAGES=["contract","preflight","spawn","provider","worker","verifier","policy","unknown"]
COST_STATES=["provider-reported","cli-estimated","usage-only","unavailable"]
COST_SOURCES=["provider","cli","none"]
```

Representative `supervisor status` human output from a scratch RunManifest with
one budget rejection and one missing-cost task (exact lines observed; scratch
paths omitted because they are not part of the claim):

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

The focused tests prove:

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
- provider-reported cost is authoritative only when amount/currency complete;
  a CLI estimate is always non-authoritative;
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
  reports non-authoritative cost; mixed currencies are not combined.

## 3. Acceptance matrix

Design acceptance items from
[design/failure-cost-truth-v0.md](../../design/failure-cost-truth-v0.md) §11:

| # | Requirement | Status | Measured coverage |
|---|-------------|--------|-------------------|
| 1 | Every newly rejected dispatched task has a non-empty structured failure | Implemented | Claude/Codex adapters emit one; closed-loop fallback covers field-less adapters; RunManifest checkpoint test asserts the record |
| 2 | Worker failure and verifier rejection are distinguishable | Implemented | Priority tests + supervisor checkpoint test: worker exit stays `provider_auth`/`worker_process_exit`; only post-success rejection is `verifier_rejected` |
| 3 | Missing cost is `unavailable`, not zero | Implemented | Cost construction/parser tests; Claude missing-field test; status tests assert `amount: null` and no `$0` |
| 4 | Claude compatibility cost is explicitly non-authoritative | Implemented | `cli-estimated`, `source: cli`, `authoritative: false` asserted for explicit zero, normal amount and retry aggregation |
| 5 | Token usage survives when cost does not | Implemented | `usage-only` tests at core and Claude adapter levels; malformed-cost/valid-usage case |
| 6 | RunManifest remains acceptance authority | Implemented | Queue reads manifest failure/cost without rewriting; QueueItem failure only for no-manifest pre-dispatch blocks; control snapshot dedup test |
| 7 | Queue status shows failure/cost without mutating authority | Implemented | Read-only tests compare queue and journal bytes; status tests show failure counts and non-authoritative cost |
| 8 | Existing manifests and queue files remain backward compatible | Implemented | Legacy record tests load absent fields; malformed present fields fail closed with clear parse errors |
| 9 | Existing build and full suite remain green | Implemented | `npm run build` exit `0`; full `npm test` 290/290; combined focused 50/50 |
| 10 | No daemon, automatic retry, routing, admission or parallel dispatch introduced | Implemented (verified by code/test scope) | Queue remains sequential foreground; no retry path uses `retryableHint`; only the pre-existing Claude transient retry remains; tests assert a non-transient category does not add an attempt |

## 4. Limits and boundaries

- **No billing or balance authority.** `cli-estimated` is Claude Code's own
  `total_cost_usd`, not a DeepSeek invoice, bill, quota or balance. No
  provider quota/balance discovery is implemented.
- **No run-level authoritative total.** Supervisor tasks expose per-task cost;
  the control snapshot's run-wide cost is always `authoritative: false`, even
  when every observation is provider-reported. Known CLI amounts may form an
  observed subtotal only when currencies agree.
- **`guardBudgetUsd` is a guard, not spend.** It records the configured budget
  cap. Summing guards across sessions or tasks is not expected or actual cost.
- **No built-in provider-reported cost source.** The type/parser supports
  `provider-reported`, but the current Claude and Codex integrations emit
  `cli-estimated`, `usage-only` or `unavailable` only.
- **Classification is bounded heuristics.** It uses process signals and a
  bounded tail of provider/worker text. Unusual provider prose can fall to
  `unknown` or, when a process also failed, `worker_process_exit`. It is not a
  model-quality judgment and retains no raw provider payload, prompt, file
  content, auth header or transcript.
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
- **Single local measurement.** These are one local macOS run and focused
  fixtures. They are not a CI result, long-term flake rate, provider invoice,
  cost forecast or cross-host claim.

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

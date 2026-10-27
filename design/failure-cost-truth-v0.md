# Worker Failure Taxonomy and Cost Truth v0

> Date: 2026-10-27
>
> Status: design for human approval before Plan generation and dispatch

## 1. Problem

Current workers expose only:

```text
exitCode
touchedPaths
bounded logTail
optional finalText
```

The closed loop then collapses every non-zero worker result into
`implement failed: exitCode=<n>`. RunManifest stores only that free-text
`reason`. This loses:

- whether the provider rejected auth, hit a budget, timed out, returned a
  transient 429/5xx, or violated the stream protocol;
- whether the worker process failed independently of the provider;
- whether acceptance failed because of the verifier;
- token usage that the provider/CLI actually emitted;
- the difference between CLI-estimated cost and authoritative provider cost;
- whether cost is missing instead of zero.

The next control-plane steps need these facts for safe retry policy,
admission, status and cost reporting. They must not infer them from final prose
after the fact.

## 2. Goals

1. Produce a bounded, secret-free, machine-readable failure record for every
   rejected task.
2. Preserve provider/CLI token and cost observations when available.
3. Distinguish authoritative provider cost from CLI estimates and unknown
   cost.
4. Persist the records through the existing RunManifest without breaking old
   manifests.
5. Expose failure/cost through `supervisor status` and `queue status`.
6. Keep failure and cost observational. Neither grants acceptance nor authorizes
   automatic retry, dispatch or merge.

## 3. Non-goals

- no automatic retry policy based on taxonomy in this slice;
- no provider quota/balance discovery;
- no claim that Claude Code `total_cost_usd` is the DeepSeek subscription bill;
- no cross-provider billing reconciliation;
- no queue-item or Plan-task parallel execution;
- no Control API, daemon, SQLite, browser evidence or merge automation;
- no raw provider payload retention;
- no provider-session resume.

## 4. Failure taxonomy

Use one shared enum:

```ts
type FailureCategory =
  | "budget_exhausted"
  | "timeout"
  | "provider_transient"
  | "provider_auth"
  | "provider_protocol"
  | "worker_process_exit"
  | "verifier_rejected"
  | "policy_blocked"
  | "resource_exhausted"
  | "unknown";
```

Classification priority, highest first:

1. explicit timeout (`124`, adapter timeout flag, timeout text);
2. budget exhaustion;
3. authentication/authorization;
4. resource exhaustion such as ENOMEM/OOM;
5. rate limit/transient provider failure;
6. protocol/parse incompatibility;
7. non-zero worker process with no stronger signal;
8. verifier rejection after a successful worker result;
9. pre-dispatch policy/contract/attempt block;
10. unknown.

`policy_blocked` is for deterministic control-plane rejection, not model
quality. `verifier_rejected` is reserved for checks run after the worker
returns success. A worker process failure must never be relabeled as verifier
rejection merely because the verifier also fails afterward.

### 4.1 Failure record

```ts
interface FailureRecord {
  version: 1;
  category: FailureCategory;
  stage:
    | "contract"
    | "preflight"
    | "spawn"
    | "provider"
    | "worker"
    | "verifier"
    | "policy"
    | "unknown";
  code?: string;
  message: string;
  observedAt: string;
  retryableHint?: boolean;
}
```

Rules:

- `message` is bounded and credential-free; do not persist raw payloads,
  prompts, file contents, auth headers or complete provider transcripts;
- preserve a bounded final provider error text when one is available;
- `retryableHint` is advisory and cannot trigger retry by itself;
- parsers must fail closed to `unknown` rather than guesses;
- old manifests without this field remain readable.

## 5. Cost truth

### 5.1 Observation types

```ts
interface TokenUsage {
  inputTokens: number | null;
  outputTokens: number | null;
  cacheCreationInputTokens: number | null;
  cacheReadInputTokens: number | null;
}

interface CostTruth {
  version: 1;
  state:
    | "provider-reported"
    | "cli-estimated"
    | "usage-only"
    | "unavailable";
  source: "provider" | "cli" | "none";
  authoritative: boolean;
  currency: string | null;
  amount: number | null;
  usage: TokenUsage | null;
  guardBudgetUsd: number | null;
  observations: Array<{
    sessionId: string;
    state: CostTruth["state"];
    source: CostTruth["source"];
    currency: string | null;
    amount: number | null;
    usage: TokenUsage | null;
    note?: string;
  }>;
  missing: string[];
}
```

### 5.2 Claude Code + DeepSeek compatibility rules

Claude Code stream-json may report:

```text
total_cost_usd
usage.input_tokens
usage.output_tokens
usage.cache_creation_input_tokens
usage.cache_read_input_tokens
modelUsage
```

Under the DeepSeek Anthropic-compatible endpoint:

- persist `total_cost_usd` as `state: "cli-estimated"`;
- set `authoritative: false`;
- never label it the DeepSeek invoice or available balance;
- persist token usage independently when present;
- if cost is absent but tokens exist, use `state: "usage-only"`;
- if both are absent, use `state: "unavailable"`; never coerce to `$0`;
- a zero value explicitly emitted by the CLI is preserved as zero, but remains
  non-authoritative.

The configured `maxBudgetUsd` is recorded as `guardBudgetUsd`, not as spend.

### 5.3 Aggregation

The closed loop aggregates every worker session it starts, including repairs:

- unknown amounts remain missing;
- known CLI estimates may be summed into a non-authoritative observed subtotal;
- mixed currencies must not be combined;
- task-level summary must preserve observation provenance and missing reasons;
- accepted tasks keep their cost; rejected tasks keep both failure and cost.

No run-level authoritative total is claimed in v0. Supervisor and queue status
may show an observed CLI-estimated subtotal plus completeness/missing state.

## 6. Adapter contract

Extend `AgentResult` with optional structured fields:

```ts
interface AgentResult {
  // existing fields unchanged
  failure?: FailureRecord;
  cost?: CostTruth;
}
```

Claude adapter:

- parse known numeric result fields defensively;
- classify timeout before spawning/result parsing;
- classify auth/budget/rate-limit/protocol/process failure from bounded
  normalized text;
- retain final provider text only through existing `finalText`;
- do not alter transient retry behavior in this slice;
- after retry exhaustion, return the final structured failure.

Codex adapter:

- return `worker_process_exit`/`timeout` when detectable;
- return `cost: unavailable` unless its CLI explicitly provides usage;
- preserve existing behavior and output.

Mock adapter may omit both fields; loop fallbacks classify it normally.

## 7. Durable integration

Add optional fields to `RunTaskState`:

```ts
failure?: FailureRecord;
cost?: CostTruth;
```

Add optional queue-item failure metadata only for deterministic pre-dispatch
blocks that have no RunManifest:

```ts
failure?: FailureRecord;
```

When a dispatched run fails, RunManifest remains the task authority; queue
status reads its failure rather than inventing a second authority.

Extend `LedgerTaskRecord` and `LoopResult` with optional failure/cost so the
closed loop can carry truth from adapter to checkpoint.

Checkpoint rules:

- accepted task: persist `cost`, no failure;
- rejected task: persist both `failure` and `cost`;
- skipped/dependency-blocked task: persist `policy_blocked` with stage `policy`;
- old queue/manifest/ledger records parse unchanged;
- invalid optional structured fields fail closed with a clear parse error.

## 8. Observation surfaces

### Supervisor status JSON

Tasks already include `RunTaskState`; the new fields should pass through.
Human output should print one line per task with failure category or cost
state, never a fabricated amount.

### Queue status JSON/human

Add:

- per-task `failure` and `cost`;
- failure category counts;
- cost completeness: complete/partial/missing;
- observed non-authoritative CLI-estimated USD subtotal when available;
- `authoritative: false` and missing reasons.

The ControlSnapshot decision classifier may use the durable failure category
as the primary signal. The existing text heuristics remain only a fallback for
legacy records.

## 9. Queue event journal

`run.blocked` events include:

```text
failureCategory
failureStage
failureCode
costState
```

These fields are bounded observations. Event append failure still cannot
change queue/run authority.

## 10. Tests

Core:

- classify budget, timeout, auth, 429/5xx, protocol, process exit, resource and
  unknown with precedence;
- parse Claude usage/cost, including partial, zero, malformed and missing data;
- prove secret/raw payload fields are not copied into the bounded record;
- transient retry still works and final exhaustion carries the category.

Durable:

- rejected worker failure survives Supervisor checkpoint; verifier rejection is
  distinct;
- accepted task cost survives checkpoint and worktree cleanup;
- repair sessions aggregate token/cost observations;
- old manifests/ledger/queue records remain readable;
- malformed structured records fail closed;
- `supervisor status --json` and `queue status --json` expose the fields;
- blocked pre-dispatch policy failure is durable without a RunManifest;
- event journal includes bounded failure/cost fields;
- no automatic retry is introduced.

Regression:

```bash
npm run build
npx tsx --test tests/failure-taxonomy.test.ts
npx tsx --test tests/supervisor-failure-cost.test.ts
npx tsx --test tests/queue-control-snapshot.test.ts
npm test
```

## 11. Acceptance

1. Every newly rejected dispatched task has a non-empty structured failure.
2. Worker failure and verifier rejection are distinguishable.
3. Missing cost is `unavailable`, not zero.
4. Claude compatibility cost is explicitly non-authoritative.
5. Token usage survives when cost does not.
6. RunManifest remains acceptance authority.
7. Queue status shows failure/cost without mutating authority.
8. Existing manifests and queue files remain backward compatible.
9. Existing build and full suite remain green.
10. No daemon, automatic retry, routing, admission or parallel dispatch is
    introduced.

## 12. Planned task boundaries

```text
failure-cost-core
  -> failure-cost-durable
       -> failure-cost-docs
```

Expected write scopes:

```text
core:
  src/failures.ts
  src/agents/types.ts
  src/agents/claude.ts
  src/agents/codex.ts
  tests/failure-taxonomy.test.ts
  tests/claude-failure-cost.test.ts

durable:
  src/persistence/ledger.ts
  src/repair/loop.ts
  src/scheduler/codex-batch.ts
  src/supervisor/types.ts
  src/supervisor/store.ts
  src/supervisor/cli.ts
  src/orchestration/queue-store.ts
  src/orchestration/queue-runner.ts
  src/orchestration/control-snapshot.ts
  src/orchestration/event-journal.ts
  tests/supervisor-failure-cost.test.ts
  tests/queue-control-snapshot.test.ts

docs:
  README.md
  docs/NEXT_ITERATION.md
  docs/NEXT_STEP_CONTROLLER.md
  docs/SUPERVISOR_V0.md
  docs/CLAUDE_DEEPSEEK_WORKER.md
  docs/TASK_ESTIMATION.md
  docs/evidence/FAILURE_COST_TRUTH.md
```

The implementation worker may narrow these paths if existing structure makes a
file unnecessary, but must not write outside them or modify this design.

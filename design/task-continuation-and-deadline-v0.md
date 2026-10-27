# Task Budget Continuation and Deadline Extension v0

> Date: 2026-10-28
>
> Status: implemented in v0. Health-gated deadline extension and same-session
> budget continuation are policy-gated and default off. See
> [DEADLINE_EXTENSION.md](../docs/evidence/DEADLINE_EXTENSION.md),
> [BUDGET_CONTINUATION.md](../docs/evidence/BUDGET_CONTINUATION.md) and
> [CONTINUATION_SELF_HOST.md](../docs/evidence/CONTINUATION_SELF_HOST.md).

## 1. Question

When the supervisor can prove that a task is making healthy progress, should
it be allowed to:

1. continue after the provider budget guard is exhausted;
2. extend the worker wall-clock deadline?

Answer:

```text
deadline: extendable in-process because cliyard owns the timer
budget:   not mutable in-process; continuation requires a new CLI invocation
          with a larger guard, optionally resuming the same provider session
```

Neither operation grants acceptance or changes the TaskContract.

## 2. Measured provider behavior

A disposable Claude Code + DeepSeek probe was run on 2026-10-28.

First invocation:

```text
--session-id 2d187a73-f41d-4f1b-85a9-15c928964dce
--max-budget-usd 0.000001
result subtype = error_max_budget_usd
result session_id = 2d187a73-f41d-4f1b-85a9-15c928964dce
reported total_cost_usd = 0.007955
```

Second invocation:

```text
--resume 2d187a73-f41d-4f1b-85a9-15c928964dce
--max-budget-usd 0.05
result subtype = success
result = PROBE_PHASE_TWO_CONTINUED
reported total_cost_usd = 0.00189
```

Observed facts:

- the same provider conversation can resume after a budget rejection;
- the new invocation accepts a new budget guard;
- the provider session id is stable across both invocations;
- the old `--max-budget-usd` process cannot be modified in place;
- the guard is not a strict preflight hard limit: the first single model call
  cost `$0.007955` despite a `$0.000001` guard.

The probe does not prove available account balance, invoice price or that every
provider/CLI combination supports session resume.

## 3. Budget continuation semantics

Use the term **budget continuation**, not "top-up":

```text
running provider invocation
  -> provider returns error_max_budget_usd
  -> checkpoint failure/cost/session id
  -> policy checks
  -> optional grant
  -> same-session --resume with a new guard
  -> aggregate observations under the same task
```

The process is no longer running when the grant is applied. Nothing can extend
the budget of an active invocation.

### 3.1 Eligibility

Automatic or operator-approved continuation requires all of:

- failure category is exactly `budget_exhausted`;
- no timeout, auth, protocol, policy or verifier failure outranks it;
- provider session id is recorded and non-empty;
- exact attempt worktree and branch still validate;
- task is not accepted;
- meaningful progress evidence exists before exhaustion;
- the user preauthorized an auto-continuation envelope, or an operator grants
  one explicitly;
- continuation count and cumulative guard are below policy limits;
- the target execution profile supports session resume or explicitly falls
  back to a new session over the same worktree.

### 3.2 Progress evidence

"Task is running" is insufficient. At least one of:

- a mapped `assistant` event;
- a `tool.start` or `tool.result`;
- a verified worktree path change;
- a fresh file/build output associated with the attempt.

Thinking-token traffic alone proves provider liveness, not task progress. It
may justify one manual extension but not unlimited automatic spending.

### 3.3 Limits

```ts
interface BudgetRenewalPolicy {
  version: 1;
  baseGuardUsd: number;
  continuationGuardUsd: number;
  maxContinuations: number;
  maxCumulativeGuardUsd: number;
  autoContinue: boolean; // default false
  overshootReserveUsd: number;
}
```

Rules:

- default auto-continuation is off;
- each grant is persisted before the resumed invocation;
- a grant is idempotent by task + attempt + continuation index;
- max attempts and max continuations are separate counters;
- session-resume failure does not consume another grant silently;
- each resumed provider session contributes its own cost observation;
- raw provider output is not copied into the extension record;
- a continuation is not a verifier repair and does not reset `maxRepairs`.

Because a budget guard can overshoot by one provider request, `baseGuardUsd`
should reserve `overshootReserveUsd` below the actual spend ceiling. The
reserve is a safety estimate, not a promised hard cap.

## 4. Deadline extension semantics

Claude and Codex timeouts are cliyard-owned `setTimeout` timers. They can be
rescheduled while the child is alive.

```ts
interface DeadlinePolicy {
  version: 1;
  baseTimeoutMs: number;
  extensionStepMs: number;
  maxExtensions: number;
  maxTotalTimeoutMs: number;
  healthyActivityWindowMs: number;
  autoExtend: boolean; // default false until calibration
}
```

### 4.1 Healthy extension gate

Grant time only when:

- child or provider process is alive;
- last mapped assistant/tool event is newer than
  `healthyActivityWindowMs`;
- there is no current error/retry storm;
- task attempt has not exceeded `maxExtensions` or `maxTotalTimeoutMs`;
- budget guard is not already exhausted;
- an auto-extension policy was preauthorized or an operator explicitly grants
  the extension.

A process with only `waiting for provider output` heartbeats does not qualify
for automatic extension. One provider-active thinking window may qualify for
manual review when tool progress already occurred.

### 4.2 Interaction with budget

A time extension does not add money. Conversely, budget continuation starts a
new provider invocation with its own timeout, but the attempt's total task
deadline still applies.

Persist both:

```text
perInvocationDeadline
maxTaskAttemptDeadline
```

## 5. Control path

The Supervisor holds its repository lock for the entire worker run. A separate
extension command must therefore write a dedicated, lock-free control request,
not mutate RunManifest concurrently.

Proposed layout:

```text
.cliyard/control/runs/<runId>/<taskId>.json
```

Request:

```ts
interface ExtensionRequest {
  version: 1;
  requestId: string;
  runId: string;
  taskId: string;
  attemptId: string;
  kind: "deadline" | "budget-continuation";
  requestedAt: string;
  reason: string;
  grant:
    | { extensionMs: number }
    | { additionalGuardUsd: number };
}
```

The active adapter/controller polls the exact file, validates it against the
current run/task/attempt, and emits an extension event. The Supervisor
checkpoints the accepted grant at its next safe boundary. Unknown, stale or
foreign request ids are ignored and audited.

The control file never grants acceptance and never edits the frozen contract.

## 6. Status and audit

RunManifest task extensions:

```ts
interface TaskExtensionRecord {
  version: 1;
  kind: "deadline" | "budget-continuation";
  requestedAt: string;
  grantedAt: string;
  reason: string;
  healthyEvidence: string[];
  providerSessionId?: string;
  extensionMs?: number;
  additionalGuardUsd?: number;
  cumulativeGuardUsd?: number;
  continuationIndex?: number;
}
```

Status must show:

- current deadline and remaining time;
- base / extension / total timeout;
- budget guard and continuation count;
- last meaningful progress age;
- healthy / stale / waiting classification;
- why extension is eligible or denied;
- all grants and their source.

## 7. Default policy

Safety-first v0:

```text
auto deadline extension:      off
manual deadline extension:    allowed after health check
auto budget continuation:     off
manual budget continuation:   allowed after budget_exhausted
max deadline extensions:      0 by default until configured
max budget continuations:     0 by default until configured
```

After a bounded soak, users may explicitly preauthorize:

```text
time:   +10 min, max 2 extensions, max 60 min task attempt
budget: +$5, max 1 continuation, max $15 cumulative guard
```

No default may spend additional money without explicit policy.

## 8. Tests

Fake provider tests:

- budget subtype preserves session id and cost;
- resumed invocation uses `--resume <same-id>` and larger guard;
- continuation grant is persisted before resume;
- continuation denies auth/timeout/verifier failures;
- extension denial when stale or only waiting heartbeats;
- healthy deadline extension reschedules and records old/new deadline;
- max extensions, max total time and cumulative guard are enforced;
- request replay is idempotent;
- restart after clean budget exhaustion can resume from manifest;
- active process restart cannot claim conversation resume without a persisted
  session id;
- extension never changes task acceptance.

Real provider smoke:

1. force one cheap `error_max_budget_usd`;
2. resume same session with a larger guard;
3. verify the same session id and continued result;
4. record only measured CLI cost observations, never an invoice claim.

## 9. Acceptance

1. Active CLI budget flags are never described as dynamically mutable.
2. Budget continuation uses a new invocation and same session when supported.
3. Timeout extension only occurs while the child is alive and progress is
   healthy.
4. Waited/stalled providers do not gain indefinite time.
5. All grants are bounded, preauthorized or explicit, idempotent and audited.
6. Budget and time envelopes are separate.
7. Extension is never acceptance evidence.
8. Defaults spend no additional money.

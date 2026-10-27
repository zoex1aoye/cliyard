# Health-Gated Budget Continuation v0 - Measured Evidence

> Date: 2026-10-28
>
> Environment: macOS Darwin arm64, Node `v20.20.2`
>
> Scope: local executable fake-CLI tests for the Claude adapter, shared
> continuation records, closed-loop forwarding, RunManifest checkpoints and
> Supervisor CLI/status. No real Claude, DeepSeek or other provider API was
> called for this implementation slice.

Budget continuation starts a new provider invocation after the previous
process has stopped. It never increases the active process's guard, changes a
`TaskContract`, grants acceptance, resets repairs, or selects another
CLI/model. The exact task worktree remains in use.

`total_cost_usd` remains a non-authoritative CLI estimate. Every guard value
below is a local CLI protection setting, not provider balance, invoice price,
quota, available credit, or a strict hard cap. A provider request can overshoot
a guard; `overshootReserveUsd` is only a bounded safety margin.

## 1. Shared model

`src/agents/continuation.ts` owns version `1` budget policy and extension
shapes:

```ts
interface BudgetContinuationPolicy {
  version: 1;
  baseGuardUsd: number;
  continuationGuardUsd: number;
  maxContinuations: number;
  maxCumulativeGuardUsd: number;
  autoContinue: boolean;
  overshootReserveUsd: number;
}

interface BudgetContinuationTaskExtensionRecord {
  version: 1;
  extensionId: string;
  attempt: number;
  kind: "budget-continuation";
  source: "auto";
  requestedAt: string;
  grantedAt: string;
  reason: string;
  healthyEvidence: string[];
  providerSessionId: string;
  additionalGuardUsd: number;
  cumulativeGuardUsd: number;
  continuationIndex: number;
}
```

`TaskExtensionRecord` now carries both deadline and budget kind-specific
fields as optional common fields for source compatibility; the fail-closed
parser requires the exact fields for each kind. Deadline records retain their
previous fields and parser behavior. Budget records require a provider session
id, non-empty mapped progress evidence, a one-based continuation index, and
positive additional/cumulative guards.

Defaults spend no additional money:

```text
baseGuardUsd:              5
continuationGuardUsd:      5
maxContinuations:          0
maxCumulativeGuardUsd:     5
autoContinue:              false
overshootReserveUsd:       0
```

The parsers reject contradictory or malformed values instead of repairing
them. `maxContinuations` is bounded to `0..64`, and budget amounts use at most
six decimal places with a finite bounded ceiling.

## 2. Claude eligibility and invocation order

The Claude adapter's execution capability reports
`supportsProviderSessionResume: true`. A grant is considered only when all of
the following hold after an invocation has stopped:

1. The policy has `autoContinue === true` and the invocation is below
   `maxContinuations`.
2. `AgentStartInput.onExtension` is present.
3. The final structured outcome is `is_error: true` with subtype exactly
   `error_max_budget_usd`.
4. The adapter did not observe a wall-clock timeout, a terminating signal, an
   unresolved provider error/retry, malformed JSON-shaped stream output, auth,
   transient, protocol, policy, resource or timeout text.
5. The changed-path audit did not fail and did not find a path outside the
   frozen task's `writePaths`.
6. At least one mapped `assistant`, `tool.start` or `tool.result` event was
   observed in that invocation. Heartbeats and thinking-token records alone do
   not qualify.
7. A non-empty provider session id is available. The adapter prefers the
   `session_id` reported by stream-json and otherwise uses the exact fresh
   session id supplied through `--session-id`.
8. The next cumulative guard plus `overshootReserveUsd` does not exceed
   `maxCumulativeGuardUsd`.

The guard arithmetic is:

```text
first invocation guard = baseGuardUsd
next cumulative guard = prior cumulative guard + continuationGuardUsd
resumed CLI guard = next cumulative guard
room check = next cumulative guard + overshootReserveUsd
             <= maxCumulativeGuardUsd
```

The extension record is constructed and passed to `onExtension` before any
resumed process starts. A rejected callback is not a grant: the adapter records
no budget extension and does not spawn the continuation. Once the callback
resolves, the adapter adds the record and runs:

```text
claude ... --resume <provider-session-id> --max-budget-usd <larger-cumulative-guard>
```

No `--session-id` is included on the resumed invocation. The same prompt,
TaskContract, cwd/worktree and branch remain in effect. Existing transient
retry behavior still starts a fresh provider session; a budget continuation is
never implemented as a transient retry. A failure of the resumed invocation
does not generate a second grant or silently fall back to a fresh session.

Every CLI invocation, including transient retries and resumed invocations,
contributes a cost observation. The final result keeps the available provider
session id and extension history. If the last invocation is another clean
`error_max_budget_usd`, the final failure remains
`budget_exhausted`/`provider` with code `error_max_budget_usd`.

## 3. Batch, CLI and manifest plumbing

`CodexBatchOptions` now carries `maxBudgetUsd` and `budgetPolicy`. The batch
constructs the Claude adapter with those values and forwards the common
`onExtension` callback through `runClosedLoop`. A RunManifest-backed callback
appends the exact budget record to `RunTaskState.extensions` with an atomic
checkpoint only while the task is `running`.

Supervisor `start` and `resume`, plus `claude-batch`, accept:

```text
--max-budget-usd <positive decimal>
--auto-continue-budget
--continuation-guard-usd <positive decimal>
--max-budget-continuations <0..64>
--max-cumulative-budget-guard-usd <positive decimal>
--budget-overshoot-reserve-usd <non-negative decimal>
```

Duplicate value flags, a value attached to `--auto-continue-budget`,
non-positive guards, too many continuations, automatic continuation with zero
grants, and a cumulative guard that cannot cover the next grant plus reserve
are rejected before worker dispatch. Budget flags on a Codex worker are
rejected rather than ignored.

Proving only `--max-budget-usd` sets the initial guard without enabling
continuation. Providing continuation settings without
`--auto-continue-budget` records a policy but remains default-off at runtime.

Human Supervisor status includes total extension count and, when present:

```text
budget-extensions=<count>
last budget continuation=<timestamp> +<additional> cumulative-guard-usd=<guard>
```

JSON status and the RunManifest retain the full `extensions` array. Existing
deadline-only human output and manifest compatibility remain unchanged.

## 4. Fixture coverage

`tests/budget-continuation.test.ts` uses temporary executable fake Claude
commands and temporary Git repositories. It covers:

| Scenario | Expected observation |
|----------|----------------------|
| Clean budget exhaustion after mapped progress | first call uses `--session-id` with guard 1; second uses the same id as `--resume` with guard 2 |
| Persistence ordering | resumed process reads the already-checkpointed extension before it can succeed |
| Cost aggregation | both invocations appear as separate non-authoritative CLI observations |
| No mapped progress | one invocation, no callback, final code `error_max_budget_usd` |
| Auth, protocol, policy and wrong subtypes | no callback and no resumed invocation |
| Timeout | wall-clock timeout wins; no budget grant |
| Outside write path | grant denied before resume |
| Maximum continuations | stops after the configured count |
| Repeated grants | two records, cumulative guards 2 and 3, and three cost observations aggregate |
| Overshoot reserve | denies a grant when no cumulative room remains |
| Persistence rejection | one invocation only; no extension record |
| Resume process failure | persisted grant remains, no additional grant |
| Defaults | automatic continuation is off and zero continuations stays inert |
| RunManifest/status | budget record round-trips; human and JSON status expose it |
| Supervisor pipeline | fake provider verifies manifest persistence before same-session resume |

## 5. Exact checks

Run from this worktree:

| Command | Result |
|---------|--------|
| `npm run build` | pass, exit `0` |
| `node --import tsx --test tests/budget-continuation.test.ts` | 15/15 pass |
| Affected existing and new regression group with `--test-concurrency=1` (11 files) | 90/90 pass, 64,809.1 ms |
| `node --import tsx --test tests/*.test.ts` | not a clean repository-wide result: unrelated child-CLI tests hit sandbox IPC `EPERM`, runtime drills could not bind their fixed ports, and the run was terminated after runtime-test children stopped making progress |

The repository's local `tsx` executable attempted to open a temporary IPC pipe
and received sandbox `EPERM`; tests were therefore invoked through
`node --import tsx --test`, which runs the same TypeScript files without the
CLI wrapper. Test timing remains host-load sensitive because the fixtures use
real short wall-clock timers.

## 6. Limits and non-goals

- Fake stream-json fixtures establish the cliyard state machine and ordering.
  They do not prove every installed Claude Code version or
  Anthropic-compatible provider supports `--resume` or session/cost semantics.
- Cost aggregation sums CLI estimates; it is not an account total, invoice or
  authoritative spend ledger.
- A CLI guard can overshoot by at least one provider request. The reserve is a
  configured safety estimate, not an enforcement boundary.
- A successful resume proves local command/stream handling, not provider
  balance or future quota.
- Deadline extension remains the prior live-timer behavior and is not changed
  by this slice. Budget and time grants remain separate.
- Manual control files, daemon/cross-host resume, route/model fallback, SQLite
  migration, historical manifest migration and automatic merge remain out of
  scope.
- Auth, transient, timeout, protocol, policy, verifier and path failures do not
  receive automatic budget grants. Existing transient retry behavior is
  unchanged and remains separate.

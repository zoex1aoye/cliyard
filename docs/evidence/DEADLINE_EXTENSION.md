# Health-Gated Deadline Extension v0 — Measured Evidence

> Date: 2026-10-28
>
> Environment: macOS Darwin 27.0.0 arm64, Node `v20.20.2`, npm `10.8.2`,
> source base `1011359`.
>
> Scope: local fixture tests for the Claude stream-json adapter, shared
> continuation records, closed-loop forwarding, RunManifest checkpoints and
> supervisor CLI/status. No real Claude, Codex, DeepSeek or other provider API
> was called, and no provider billing or account state was observed.

Deadline extension adds wall-clock execution time only. It does not grant task
acceptance, change a `TaskContract`, change verifier authority, reset repairs,
increase the provider budget guard, or add provider budget continuation. The
RunManifest remains the task-state authority.

## 1. Implemented contract

`src/agents/continuation.ts` owns version `1` shared shapes and fail-closed
parsers:

```ts
interface DeadlineExtensionPolicy {
  version: 1;
  baseTimeoutMs: number;
  extensionStepMs: number;
  maxExtensions: number;
  maxTotalTimeoutMs: number;
  healthyActivityWindowMs: number;
  autoExtend: boolean;
}

interface TaskExtensionRecord {
  version: 1;
  extensionId: string;
  attempt: number;
  kind: "deadline";
  source: "auto";
  requestedAt: string;
  grantedAt: string;
  reason: string;
  healthyEvidence: string[];
  providerSessionId?: string;
  extensionMs: number;
  cumulativeTimeoutMs: number;
}
```

The default is disabled:

```text
baseTimeoutMs:            1,200,000
extensionStepMs:            300,000
maxExtensions:                    0
maxTotalTimeoutMs:        1,200,000
healthyActivityWindowMs:     60,000
autoExtend:                   false
```

The parsers do not repair malformed or contradictory input. A positive
extension count must fit at least one extension step within
`maxTotalTimeoutMs`; automatic extension cannot be enabled with
`maxExtensions = 0`. Records require non-empty, ordered timestamps and
healthy evidence, a non-negative attempt, a valid deadline extension id, a
positive extension and cumulative timeout, and valid optional provider
session identity.

## 2. Eligibility and persistence order

The Claude adapter treats only mapped `assistant`, `tool.start` and
`tool.result` events as meaningful task progress. It tracks only the newest
such event. `session.start`, `heartbeat`, `waiting`, provider
`system/thinking_tokens`, and generic JSON records can prove process traffic
but cannot qualify an automatic grant.

At the cliyard-owned wall-clock deadline, a grant requires all of the
following at that point:

1. `policy.autoExtend === true`;
2. an `AgentStartInput.onExtension` callback is present;
3. the provider child is alive and has not emitted a final result;
4. the newest mapped assistant/tool event is no older than
   `healthyActivityWindowMs`;
5. no provider `error` or `retry` remains unresolved; later mapped
   assistant/tool progress resolves it;
6. the next extension is below both `maxExtensions` and
   `maxTotalTimeoutMs`.

If any gate fails, the existing timeout path terminates the child. Provider
`--max-budget-usd` arguments are unchanged.

The adapter constructs one exact `TaskExtensionRecord`, awaits that exact
record's `onExtension` callback, and only after the callback resolves updates
its extension count/history and arms the same live child against the remaining
extension time. The extended timer uses the prior absolute deadline plus
`extensionStepMs`; persistence delay therefore consumes the new window rather
than silently adding a second full window. `collect()` also waits for an
already-in-flight checkpoint before it can resolve, so a child exit cannot let
acceptance outrun persistence.

A callback rejection is a denial. The adapter records no grant in its result,
marks the invocation fail-closed, and terminates a still-running child. A
callback failure after the child exits still cannot turn the pending grant
into an accepted extension.

## 3. Supervisor and manifest plumbing

`CodexBatchOptions.deadlinePolicy` forwards a policy to the Claude adapter.
`runClosedLoop` validates and forwards the extension callback, accumulates
successful grants across repairs, and returns them through
`AgentResult.extensions`/`LoopResult.extensions`.

For a RunManifest-backed batch, the callback writes the exact grant to
`RunTaskState.extensions` through an atomic manifest checkpoint before the
adapter can re-arm its timer. A task that is no longer `running` denies the
grant. Accepted and rejected task checkpoints preserve the already-written
history. Older manifests without `extensions` remain readable; a present
array is structurally validated and duplicate extension ids are rejected.

Supervisor `start` and `resume` accept:

```text
--timeout-ms <positive integer>
--auto-extend-deadline
--deadline-extension-ms <positive integer>
--max-deadline-extensions <0..64>
--max-total-timeout-ms <positive integer>
--healthy-activity-window-ms <positive integer>
```

Invalid values, duplicate value flags, a boolean-flag value, a total below the
base timeout, an extension step that cannot fit, and automatic extension with
zero grants are rejected before lock acquisition or worker dispatch. Human
status appends `extensions=<count>` and the last grant's timestamp, extension
size and cumulative timeout. JSON already carries the task's extension array.

## 4. Fixture coverage

`tests/deadline-extension.test.ts` uses temporary executable fake Claude
commands that emit stream-json-shaped records and temporary Git repositories.
It covers:

| Scenario | Expected observation |
|----------|----------------------|
| Healthy mapped activity | one exact grant, same child completes after base timeout |
| Thinking tokens/heartbeat only | no grant; timeout |
| Provider error storm | unresolved error blocks grant; timeout |
| `maxExtensions = 1` | exactly one grant, then timeout |
| `maxTotalTimeoutMs` | grants stop at the cumulative cap |
| Async callback ordering | timer extension occurs only after callback resolution |
| Child exits during async callback | `collect()` remains pending until checkpoint resolves |
| Callback rejection | no extension record; fail-closed timeout |
| Default policy plus callback | callback is never invoked; timeout |
| Manifest round trip and malformed evidence | exact history reloads; legacy absence loads; malformed evidence fails closed |
| CLI validation | contradictory/duplicate policy flags fail before dispatch and lock creation |
| Batch/status integration | grant is visible in the manifest before the fake provider emits its result; JSON/human status expose history |

The batch fixture reads the on-disk manifest from inside the fake provider
before emitting its final result. This directly checks the required
persistence-before-finish ordering.

## 5. Exact checks

Run from this worktree on 2026-10-28:

| Command | Result |
|---------|--------|
| `npm run build` | pass, exit `0` |
| `npx tsx --test tests/deadline-extension.test.ts` | 12/12 pass, 17,345.1 ms |
| Relevant Claude/loop/supervisor/batch regression group (9 files) | 63/63 pass, 17,425.8 ms |
| `npm test` | 320/320 pass, 18,098.5 ms |

The regression group was:

```text
tests/claude-adapter.test.ts
tests/claude-progress.test.ts
tests/claude-failure-cost.test.ts
tests/loop.test.ts
tests/supervisor-store.test.ts
tests/supervisor-cli.test.ts
tests/supervisor-resume.test.ts
tests/continuous-batch.test.ts
tests/mock-batch.test.ts
```

The repository-wide run was repeated after an independent review fixed a
deadline/result event-loop race. A final successful result that had already
settled before its deadline is allowed to close, while an error result or a
result observed after its deadline still loses to the explicit wall-clock
timeout. This preserves the existing
`wall-clock timeout outranks budget subtype` rule.

The first self-host attempt of this Plan hit Codex's still-unimplemented
10-minute adapter deadline after it had written the source and focused tests
but before it wrote this evidence document. The queue retained the exact run
id and dirty worktree, and a manual queue retry resumed that worktree. This is
recorded as motivation for deadline extension, not as proof that this new
policy was active during the first attempt. Codex remains fail-closed in this
slice.

## 6. Limits and non-goals

- Fixture records are deliberately shaped like Claude stream-json, but they do
  not prove compatibility with every real provider/CLI version or transcript
  shape.
- Short timer fixtures can be affected by host load. They establish the state
  machine and ordering in single local runs, not a long-term flake rate.
- Node timers cannot promise exact millisecond scheduling; the recorded
  cumulative deadline is the policy bound, while OS scheduling can delay the
  callback that observes it.
- A deadline extension does not increase token/cost budget and cannot rescue a
  budget-exhausted invocation.
- The deadline policy is supplied on start/resume; it is not a new durable
  RunManifest authority. Extension records are durable evidence only.
- Codex remains fail-closed at its configured base timeout because its adapter
  has no mapped meaningful-progress stream and therefore does not receive the
  Claude extension callback.
- Budget continuation, provider `--resume`, manual control files, daemon
  operation, cross-host extension, automatic main merge and historical
  RunManifest migration are out of scope.

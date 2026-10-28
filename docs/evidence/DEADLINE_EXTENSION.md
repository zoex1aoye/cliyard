# Health-Gated Deadline Extension v0 — Measured Evidence

> Date: 2026-10-28
>
> Environment: macOS Darwin 27.0.0 arm64, 10-core host, Node `v20.20.2`,
> npm `10.8.2`. The v0 measurements were first recorded on source base
> `1011359`; this revision records the deadline-suite concurrency hardening on
> HEAD `b976d98` plus the working-tree fixture changes described below.
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

## 4. Fixture strategy and coverage

`tests/deadline-extension.test.ts` uses temporary executable fake Claude
commands that emit stream-json-shaped records and temporary Git repositories.
The fake binary is a `/bin/sh` wrapper. This slice audited and changed the
fixtures as one set instead of patching one test:

- **Startup-independent healthy evidence.** Tests that must be eligible for a
  grant use `assistant: "continuous"`: the shell emits one mapped record
  immediately (before Node starts) and then a background loop writes another
  every 50 ms from process start. The loop polls the process-group leader PID
  (`$$`, stable across `exec`), so it stops when the leader exits and the
  adapter still observes `close` promptly. Healthy evidence no longer depends
  on Node startup or on one startup record remaining fresh.
- **Marker-gated completion.** Grant callbacks write marker files. Children
  perform their next action (append the changed path, emit a result, exit, or
  keep waiting) only after the intended marker. The async-persistence tests
  hold a promise inside the callback, assert that `collect()` stays pending
  while it is unresolved, then release it and require the same child to
  finish.
- **Short policy timers with event-driven fixtures.** The base deadline is a
  process-startup margin only: 1,500 ms for grant tests and 1,200-1,500 ms for
  denial tests. The shell stream has already emitted mapped activity before
  `exec node`, so this margin covers shell scheduling rather than Node boot.
  Steps of 2,500-3,000 ms are used where the child only has to complete after
  the grant, so they add no wall-clock time; steps of 600-900 ms are used only
  where the test waits for the following deadline (`maxExtensions`,
  `maxTotalTimeoutMs` and the late-result case) and therefore does contribute
  to run time. The exact policy values, cumulative bounds and ordering remain
  the assertions under test.
- **Late results cannot win by closing early.** The post-deadline fixture
  schedules its result about 1.5 s after the grant (the extended deadline is
  base + 900 ms) and stays alive for 2 s after emitting it. The normal path
  kills the child at the extended deadline; if the host delays the deadline
  callback, the adapter still sees a live child and a result observed after
  the deadline, rather than a queued close that would let the result win.
- **Denial fixtures cannot win by finishing early.** The thinking-token,
  provider-error, default-off and callback-rejection fixtures sleep for a
  bounded 10 s and then emit an unreachable success result. Their policy
  deadlines (1.2-1.5 s) therefore kill a live child, so timeout is provable
  and a lost kill becomes a visible late-success assertion failure instead of
  a hang. Thinking tokens are the only fixture with no mapped assistant
  record; the error, default-off and rejection fixtures supply fresh mapped
  evidence so denial proves the specific gate.
- **Diagnostic waits.** The 10 s diagnostic bounds cover only lost callback,
  pid, or exit signals; child-side marker and keep-alive bounds are also 10 s.
  They are never the policy schedule under test.
- **Supervisor integration.** The batch fixture polls the on-disk run manifest
  until the Supervisor's grant checkpoint is visible, then records the
  manifest-at-result marker and emits its result. Checkpoint persistence
  before worker completion is proved without a fixed child schedule.

Coverage:

| Scenario | Expected observation |
|----------|----------------------|
| Healthy mapped activity | one exact grant (`extensionMs 3000`, cumulative `4500`), same child completes after the base deadline |
| Result after the extended deadline | one grant; the result is scheduled 1.5 s after the grant, past the 2400 ms extended deadline, and the child outlives it; timeout at 2400 ms |
| Thinking tokens/heartbeat only | no mapped evidence though unmapped traffic starts with the shell; timeout |
| Provider error storm | fresh mapped prelude record plus unresolved error blocks grant; live child is killed at timeout |
| `maxExtensions = 1` | exactly one grant at cumulative `2100` ms, then timeout |
| `maxTotalTimeoutMs` | grants stop at cumulative `2300` and `3100` ms; timeout |
| Async callback ordering | `collect()` pending while persistence is held; child completes only after persistence resolves and the timer re-arms |
| Child exits during async callback | `collect()` remains pending past child exit until the checkpoint resolves; then success with the exact record |
| Callback rejection | callback invoked once; no extension record; the live child is killed fail-closed at the base deadline |
| Default policy plus continuous activity and callback | callback never invoked; timeout |
| Manifest round trip and malformed evidence | exact history reloads; legacy absence loads; malformed evidence fails closed |
| CLI validation | contradictory/duplicate policy flags fail before dispatch and lock creation |
| Batch/status integration | grant is visible in the manifest before the fake provider emits its result; JSON/human status expose history |

## 5. Measured verification

All commands ran from this worktree on 2026-10-28, on HEAD `b976d98` plus the
working-tree fixture changes described in section 4. Durations are local
test-runner values; they are not a CI, long-duration flake-rate or cost claim.

| Command | Result |
|---------|--------|
| `npm run build` | pass, exit `0` |
| `node --import tsx --test tests/deadline-extension.test.ts` (unloaded, final fixtures) | 13/13 pass, 21,691.4 ms |
| Focused file, five consecutive runs with seven CPU burners active | 13/13 pass in each run (65/65 focused checks); 22,380.3-22,524.9 ms per run |
| `npm test` (full suite, run 1) | 375/375 pass, 23,014.8 ms |
| `npm test` (full suite, run 2) | 375/375 pass, 22,830.0 ms |
| `npm test` (full suite, run 3) | 375/375 pass, 23,002.8 ms |

The five focused runs were sequential; seven local Node CPU-burner processes
(`while (Date.now() < end) {}`) kept seven of the 10 cores busy for the whole
campaign. The burners were stopped before the three full-suite runs. These are
local concurrency stresses, not CI or a longer flake-rate observation, and no
more than these three full-suite runs were measured.

The first fixture-hardening revision used 3,000 ms base deadlines and
5,000 ms extension steps for the successful-extension tests. That kept the
fixtures stable but raised the focused file to about 40 s, exceeding the 30 s
finite-command bound the verifier applies to `node --import tsx --test
tests/deadline-extension.test.ts`. Since the shell stream is already emitting
before Node boots, the base deadline only needs to cover shell scheduling:
the final fixtures use 1,500 ms bases (1,200 ms for the policy-disabled
denial) and keep short only the steps a test actually waits through. The
focused file now finishes in about 22 s including test-process startup. Policy
timers were shortened, never lengthened, and no timeout-after-deadline
assertion was relaxed.

Before this fixture overhaul, two consecutive full-suite runs on the combined
adoption-journal baseline exposed different failures:

```text
collect waits for an in-flight grant checkpoint past child exit
a rejected persistence callback denies the grant
```

Each passed in isolation. The common cause was a fixture whose child startup
or single startup mapped record raced the policy deadline, not a production
deadline-state race. This slice rebuilt the extension-eligible and denial
fixtures as one set: a shell-level continuous mapped stream, marker-gated
completion, late results that cannot win by closing early, denial children
that outlive their deadlines, and diagnostic-only waits. The three full-suite
runs above are after that rebuild and the final policy-timer revision. No
deterministic production race was proved, so `src/agents/claude.ts` is
unchanged; timeout-after-deadline semantics and adoption/journal behavior are
unchanged.

The final successful result handling remains as previously recorded: a result
that had already settled before its deadline is allowed to close, while an
error result or a result observed after its deadline still loses to the
explicit wall-clock timeout. This preserves the existing
`wall-clock timeout outranks budget subtype` rule.

Historical note: the first self-host attempt of the original Plan hit Codex's
still-unimplemented 10-minute adapter deadline after writing source and focused
tests but before the evidence document. The queue retained the exact run id and
dirty worktree, and a manual queue retry resumed that worktree. That remains
motivation for deadline extension, not proof this policy was active during the
first attempt. Codex remains fail-closed in this slice.

## 6. Limits and non-goals

- The continuous stream is a fixture technique, not production behavior. A
  fixture cannot emit provider output before the OS schedules it, and the
  policy timer starts at spawn. Extension-eligible fixtures use a 1,500 ms
  base deadline plus a shell record written before Node starts; if the host
  does not schedule the fake `/bin/sh` process and the test process does not
  consume that record within 1.5 s, the first grant can still be missed. On
  this host a shell-level first-record probe measured 4-9 ms both unloaded and
  with seven CPU burners active, so 1.5 s is a large startup margin, not a
  guarantee. Once the stream is running, freshness no longer depends on Node
  or a fixed delay: a record arrives every 50 ms and the 10 s healthy window
  covers the policy deadlines used here.
- Marker polling (10-20 ms), the 50 ms shell stream and the 250-400 ms
  "collect stayed pending" probes add bounded latency. The re-arm and in-flight
  fixtures use 2,500 ms extension steps, leaving about 2 s of extension time
  after releasing persistence, so a probe would have to stretch by more than
  that to fail closed at re-arm. No such stretch was observed in the measured
  runs. A lost marker or keep-alive becomes a 10 s child-side failure and a
  10 s diagnostic failure; neither is the policy timing under test.
- Node timers cannot promise exact millisecond scheduling. The recorded
  cumulative deadline is the policy bound while OS scheduling can delay the
  callback that observes it. Two effects are inherent to the short policy
  timers used here. First, if the first deadline callback is delayed by more
  than an extension step, the adapter records the grant and fails closed
  immediately instead of re-arming; `maxExtensions` still observes one grant
  and a timeout, while `maxTotalTimeoutMs` would observe only one of its two
  expected grants and fail. The 600-800 ms steps used by those tests tolerate
  a first-callback delay far larger than the measured local scheduling
  jitter, but they are not a hard bound. Second, the late-result fixture
  schedules its result about 1.5 s after the grant and keeps the child alive
  2 s after emitting it, so a deadline callback delayed beyond that life
  extension could let a queued close win; the fixture does not force that
  branch deterministically.
- The tests establish the state machine and ordering on one local host across
  the five focused loaded runs and three measured full-suite runs above. They
  do not establish a CI result, a long-duration flake rate, cross-host
  behavior, or compatibility with every real provider/CLI version.
- Fixture records are deliberately shaped like Claude stream-json, but they do
  not prove every provider or transcript shape.
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

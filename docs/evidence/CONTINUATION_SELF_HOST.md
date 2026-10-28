# Continuation Self-Host Findings

> Date: 2026-10-28
>
> Scope: observed results from implementing queue run binding, worker-exit path
> audits, health-gated deadline extension and budget continuation through
> cliyard's own worktree and Supervisor paths.

## 1. Completed slices

The first parallel batch implemented two independent tasks:

```text
queue-first-run-binding
worker-exit-path-audit
```

The run-binding task needed one verifier repair. The path-audit task passed on
its first worker result. Both were then merged and the independent full suite
reached `301/301`.

The queue path was exercised again with the real first-start binding:

```text
queue item: deadline-extension-v0
status: running
workers: 1/3
lastRunId: 143b58d5-6b5b-44df-9dfc-133b2517b3c2
```

The id was already visible while the worker was live; it no longer required
reading `active.json` or waiting for the Supervisor to return.

After deadline implementation was merged, budget continuation was implemented
from a fresh materialized baseline through `supervisor start` with a 30-minute
execution window. It was accepted with all ten changed paths inside the
contract write scope.

## 2. Observed defects

### 2.1 The shipped DeepSeek model alias was rejected

The first attempt used the documented `deepseek-flash[1m]`. The current
Anthropic-compatible endpoint returned:

```text
The supported API model names are deepseek-flash, deepseek-v4-pro,
but you passed deepseek-flash[1m].
```

The executable default, launcher, DSH shipped patch and current operating
documentation now use `deepseek-flash`. Historical evidence retains the old
alias as a record of past observations.

### 2.2 `codex-batch --worker claude` was silently ignored

The command entrypoint already selects Codex; a later `--worker claude`
override was ignored, so the run used Codex even though the operator requested
Claude. `codex-batch` and `claude-batch` now reject `--worker` and direct the
operator to the matching command. This is covered by a CLI regression test.

### 2.3 Queue items cannot carry continuation policy

Deadline and budget policies are accepted by Supervisor start/resume and the
worker batch CLIs, but `QueueItem` has no durable policy fields and the queue
runner does not pass the flags. A normal `queue run` therefore cannot opt a
Plan into deadline extension or budget continuation.

Status: closed for frozen policy transport. New queue items persist a
secret-free `ExecutionProfile` and optional deadline/budget envelope, show
their capability gate in status, and pass the exact values to Supervisor start
or resume. Dynamic routing and admission remain separate work.

### 2.4 A timeout did not prove descendant cleanup

At the time of the observation, a Codex worker timed out at its 10-minute
default while its verifier had started child test processes. The direct worker
child was terminated, but several test descendants remained reparented and
required explicit cleanup.

Status: closed for normal close, timeout, cancel and spawn error on macOS/Linux.
Claude and Codex workers now run in dedicated POSIX process groups, capture the
exact OS identity, clean residual descendants after the leader exits, and fail
closed on ambiguous group evidence. Windows remains exact-child-only and
abrupt SIGKILL of cliyard itself remains unrecoverable. See
[WORKER_PROCESS_TREE.md](WORKER_PROCESS_TREE.md).

A post-merge production-path smoke left a helper alive after the fake worker
leader exited; Supervisor persisted an exact `pid=pgid=46742` process group,
recorded residual helper `46771`, sent `SIGTERM` to the group, and returned with
the helper dead and the task accepted.

### 2.5 Human takeover cannot finalize the old queue item

The first deadline worker wrote useful code and tests, then timed out before
the evidence document. Independent review completed the remaining work and
merged it, but the original queue item remained `blocked`. There is no
operator path to attach reviewed commits, rerun the frozen verification and
mark that exact RunManifest accepted without pretending the original worker
succeeded.

The downstream budget item was started from a fresh baseline instead. This is
safe but leaves queue lineage incomplete. A future `queue adopt` or
`supervisor accept-reviewed` operation needs explicit operator authority,
exact commit verification and an audit record.

### 2.6 Status is not yet a complete continuation console

Persisted extensions are visible, but status does not yet show:

- current invocation and total-attempt deadlines;
- remaining wall-clock time;
- last meaningful progress age and healthy/stale classification;
- budget guard, spend observation and continuation headroom;
- why an extension was denied;
- whether the worker process tree is still alive.

These are monitor/read-model gaps, not reasons to grant acceptance.

## 3. Current safe operating rule

Use continuation only when the execution profile is capable and the task has
real task progress, not merely heartbeat traffic.

Direct Claude Supervisor example:

```bash
npx tsx src/cli.ts supervisor start contracts.json --repo . \
  --worker claude --model deepseek-flash \
  --timeout-ms 1200000 \
  --auto-extend-deadline \
  --deadline-extension-ms 300000 \
  --max-deadline-extensions 2 \
  --max-total-timeout-ms 1800000 \
  --healthy-activity-window-ms 60000 \
  --max-budget-usd 5 \
  --auto-continue-budget \
  --continuation-guard-usd 5 \
  --max-budget-continuations 2 \
  --max-cumulative-budget-guard-usd 20 \
  --budget-overshoot-reserve-usd 2
```

Both automatic policies default off. Budget continuation is a new
same-session CLI invocation, never an in-place mutation of a running process.
The configured guard is not a provider balance or strict hard cap.

## 4. Verification

Final independent control-worktree checks:

```text
npm run build   pass
npm test        362/362 pass
```

The real CLI resume probe proved current Claude Code + DeepSeek accepts:

```text
first:  --session-id <id> --max-budget-usd 0.000001 -> error_max_budget_usd
second: --resume <id>     --max-budget-usd 0.05     -> success
```

The first reported `total_cost_usd` was `$0.10665`, confirming that the guard
can overshoot by at least one provider request.

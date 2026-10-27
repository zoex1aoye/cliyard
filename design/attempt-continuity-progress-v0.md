# Attempt Continuity and Worker Progress v0

> Revision: attempt-continuity-progress-v0
>
> Scope: foreground Supervisor, local git worktrees, Claude Code stream events

## Why

The Runtime failure-drill self-host run exposed two recovery gaps:

1. Claude exhausted a `$8` budget after writing complete documentation. The
   task was correctly rejected, but the dirty rejected worktree was not part of
   the durable run state. Retrying required a fresh worktree and repeated work.
2. Claude buffered its final JSON result, so a multi-minute worker showed only
   `running`; operators could not distinguish model reasoning, file edits and
   test execution from a stalled provider request.

A third, narrower gap was also recorded: if a `runtime-drill` child timed out
after starting a detached service, the parent did not reconcile that service.

## Goal

```text
rejected worker
  → persist exact attempt worktree/branch/base
  → retain the dirty worktree as a draft
  → resume retry in that worktree by default
  → fresh worktree only when explicitly requested

Claude stream-json
  → parse progress incrementally
  → append task-scoped worker events
  → show the latest event in supervisor status
  → emit a heartbeat while waiting

abnormal runtime-drill child
  → terminate the child
  → exact orphan preflight/executor
  → recover only proven service groups and leases
  → persist the recovery evidence in the drill result
```

This is foreground recovery and observability. It is not a daemon, remote
worker protocol, task architect or cloud orchestration.

## Attempt continuity

Add optional `RunTaskState` fields:

```ts
interface RunTaskState {
  attemptWorktree?: string;
  attemptBranch?: string;
  attemptBaseCommit?: string;
  attemptStartedAt?: string;
  attemptRejectedAt?: string;
}
```

Rules:

- A task with a Supervisor RunManifest checkpoints its exact worktree, branch
  and base after the worktree is created and before the worker starts.
- A rejected task retains those fields and its dirty worktree even when
  `--keep-worktrees` was not supplied.
- An accepted task merges its snapshot and clears its attempt fields.
- `resume --retry-rejected` reuses a matching rejected attempt by default.
- `--fresh-attempt` explicitly discards continuity and creates a clean
  worktree. `--fresh-attempt` and `--reuse-attempt` are mutually exclusive.
- `--reuse-attempt` is accepted as an explicit assertion of the default.
- Reuse fails closed rather than silently discarding a recorded draft when:
  - the path is not a directory registered as a git worktree;
  - the path escapes `<repo>/.cliyard/worktrees/`;
  - the branch differs from the checkpoint;
  - worktree `HEAD` differs from the checkpointed integration base;
  - the task has no `attemptRejectedAt`;
  - the stored attempt is associated with another run.
- `--fresh-attempt` is the recovery path for a missing or invalid draft.

Only rejected attempts are reusable. An active interrupted worker may still
exist, so `resume` must not attach a second worker to it without a separate
process-ownership design.

`supervisor status --json` exposes reusable attempt metadata. Human status
prints each reusable task/path.

## Worker progress

Claude Code is invoked with:

```text
--output-format stream-json --verbose
```

The adapter parses complete JSONL records incrementally and retains the final
`type: "result"` record for acceptance. It must remain compatible with a plain
single-JSON result for fixture/provider compatibility.

Worker progress event:

```ts
interface WorkerProgressEvent {
  version: 1;
  at: string;
  source: string;
  taskId: string;
  sessionId: string;
  type:
    | "session.start"
    | "assistant"
    | "tool.start"
    | "tool.result"
    | "heartbeat"
    | "result"
    | "retry"
    | "error";
  phase: "starting" | "thinking" | "tool" | "finishing" | "waiting" | "ending";
  message: string;
  detail?: string;
}
```

Events are written immediately to:

```text
<repo>/.cliyard/worker-events/<runId>/<taskId>.jsonl
```

They do not wait for a RunManifest checkpoint. Each line is one complete JSON
object. Event content is bounded and must not contain credentials or full file
contents.

Claude emits:

- `session.start` when the worker initialized;
- assistant text summaries;
- `tool.start` / `tool.result` with tool name and bounded detail;
- `heartbeat` at a fixed interval while waiting for the next provider event;
- `retry` for transient provider retry;
- `result` at completion;
- `error` on spawn/provider failure.

`supervisor status` is read-only. It reads the latest valid event for each task,
returns a structured `workerProgress` array, and prints the newest event in
human output. Missing, malformed or stale event files never change run status.

## Runtime-drill abnormal cleanup

The failure-drill parent already knows the exact scratch control root for each
scenario. After a child exits non-zero, or is terminated for timeout, the parent
must:

1. ensure the child has exited;
2. run the existing exact orphan executor against that scenario's control root;
3. include the recovery report in `runtime-failure-drills.json`;
4. re-run the normal manifest/log/process/port checks after recovery;
5. fail the drill if recovery needs human review or cannot clean the proven
   runtime.

The parent must never send an unverified signal to a service group. Normal
cleanup and abnormal recovery remain separate evidence paths.

For timeout handling, send `SIGTERM` first, wait a bounded grace period, then
send `SIGKILL` to the child. Recovery starts only after the child is gone.

A test-only environment hook may make the child hang after readiness so this
path is exercised without changing the public runtime-drill CLI.

## Non-goals

- No daemon, periodic scheduler, cloud queue or 24-hour background claim.
- No concurrent attach to an interrupted active worker.
- No resume of a provider conversation merely because it shares a worktree.
- No SQLite.
- No cross-host process recovery.
- No browser/Playwright/axe evidence.
- No Task Architect implementation in this slice.
- No automatic merge to `main` or push.

## Acceptance

```text
Run A: {attempt-continuity, drill-abnormal-recovery}  [parallel]
Run B: worker-progress-heartbeat
Both:
  → docs/evidence
```

1. A rejected dirty worktree is persisted and survives a real process exit.
2. Default retry uses the same worktree and sees the prior draft.
3. `--fresh-attempt` creates a different clean worktree.
4. Invalid/tampered attempts fail closed.
5. Accepted work clears attempt metadata and cannot be rerun.
6. Claude stream events appear before the worker process exits.
7. Provider silence produces heartbeat events without claiming success.
8. `supervisor status` reads progress without mutating run state.
9. A timed-out drill child's proven service is reaped after the child exits.
10. The drill report preserves the abnormal recovery and proves the port free.
11. Focused tests, the full suite and the TypeScript build pass.
12. Documentation records only measured behavior and retains all existing
    daemon, cross-host, SQLite, browser and admission non-goals.


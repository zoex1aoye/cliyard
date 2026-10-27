# Durable Orchestration Queue v0

> Revision: durable-orchestration-v0
>
> Scope: explicit foreground queue of approved, frozen contract files

## Goal

Move from one Supervisor run at a time to a durable queue of approved runs:

```text
approved contracts
  → queue add (immutable hash)
  → queue run (foreground)
  → existing Supervisor start / resume
  → completed | blocked | interrupted
  → next ready queue item
```

The queue coordinates existing Supervisor runs. It does not replace the run
manifest, verifier, worktree, runtime or worker event systems.

## Why this precedes a daemon

The queue must first prove the continuous state machine in a foreground,
inspectable form:

- what is next;
- why it is not running;
- which exact run represents an item;
- whether to start or resume;
- what happens after blocked work.

Only after these semantics are stable should a launchd/systemd/daemon wrapper
be considered.

## Storage

```text
<repo>/.cliyard/queue.json
<repo>/.cliyard/queue.lock
```

Queue JSON is atomically replaced. Mutations and dispatching are serialized by
an exclusive same-host lock. A same-host lock whose owner PID is dead is
stale and may be reclaimed; foreign hosts fail closed.

Queue item:

```ts
interface QueueItem {
  id: string;
  contractsPath: string;
  contractsHash: string;
  worker: "claude" | "codex";
  model?: string;
  dependsOn: string[];
  status: "pending" | "running" | "completed" | "blocked" | "cancelled";
  attempts: number;
  maxAttempts: number;
  runIds: string[];
  lastRunId?: string;
  nextAction: "start" | "resume";
  createdAt: string;
  updatedAt: string;
  reason?: string;
}
```

The contracts path and SHA-256 are frozen at `queue add`. A changed or missing
file blocks dispatch; the queue never silently runs different contracts under
the same item id.

## Commands

```bash
cliyard queue add <contracts.json> --repo <path> --id <queue-id> \
  [--depends-on <id>]... [--worker claude|codex] [--model id] \
  [--max-attempts <n>] [--json]

cliyard queue list --repo <path> [--json]
cliyard queue retry <queue-id> --repo <path> [--json]
cliyard queue cancel <queue-id> --repo <path> [--json]
cliyard queue run --repo <path> [--continue-on-blocked] \
  [--max-dispatches <n>] [--json]
```

Queue ids and dependency references are explicit. Unknown dependencies and
cycles fail at mutation time.

## Run semantics

An item is ready when:

- status is `pending`;
- all dependencies are `completed`;
- the frozen contracts hash still matches;
- attempt count is below its limit.

Dispatch uses the existing Supervisor CLI:

- `nextAction: "start"` → `supervisor start <contracts> --repo <repo>`;
- `nextAction: "resume"` → `supervisor resume --run <lastRunId> --retry-rejected`.

The queue records `running` and atomically persists it before dispatch. The
active RunManifest remains the task-level authority.

After dispatch:

- exit `0` and a completed RunManifest → queue item `completed`;
- interrupted/rejected/blocked RunManifest → queue item `blocked`, while
  retaining `lastRunId` and allowing an explicit `queue retry`;
- changed/missing contracts, invalid dependency state or queue lock ambiguity
  → blocked with exact reason.

`queue retry` returns a blocked item to ready with `nextAction: "resume"` when
a run exists, otherwise `"start"`. It does not rewrite RunManifest.

Completion is monotonic: completed and cancelled items are never dispatched
again.

## Continue policy

Default `queue run` stops after the first blocked item.

With `--continue-on-blocked`, independent items may continue, but any item
depending on a blocked/cancelled item becomes blocked. This makes failure
propagation explicit rather than skipping dependencies.

`--max-dispatches N` bounds one foreground invocation without discarding
remaining pending work.

## Crash recovery

If the queue runner dies while an item is `running`, the next `queue run`
detects the stale queue lock and reconciles the item against its recorded
RunManifest:

- completed run → item completed;
- resumable interrupted/blocked run with attempts remaining → item pending,
  `nextAction: "resume"`;
- missing or ambiguous run evidence → blocked, preserving the reason.

The queue does not start a fresh supervisor run when it can prove an existing
run should be resumed.

## Non-goals

- No daemon, launchd, systemd, cron or background service.
- No automatic approval or contract creation.
- No automatic push/merge to `main`.
- No cross-repository queue.
- No SQLite.
- No priority preemption.
- No parallel queue items or cross-run runtime admission scheduler.
- No automatic model/budget escalation.

## Acceptance

```text
orchestration-queue-core
  → orchestration-queue-docs
```

1. Queue add freezes contracts hash and rejects id/dependency/cycle errors.
2. Queue run starts ready items in dependency order.
3. Completed items never rerun.
4. A blocked item stops by default; independent work can continue explicitly.
5. Dependants of blocked work become blocked.
6. Queue retry resumes the existing run where possible.
7. A stale running item reconciles against its RunManifest.
8. Changed contracts fail closed.
9. Queue lock serializes concurrent runs and stale same-host locks recover.
10. Existing Supervisor, continuity, progress, Task Architect and drill tests
    remain green.


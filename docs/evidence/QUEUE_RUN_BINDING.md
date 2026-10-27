# Queue First-Run Binding — Implementation and Evidence

> Date: 2026-10-28
>
> Scope: close the first-live-dispatch gap in
> `design/selfhost-iteration-v0.md` section 2.2. The queue remains a
> foreground dispatch coordinator; `RunManifest` remains the task authority.
> No parallel dispatch, daemon, push, main-branch merge or historical queue
> rewrite is introduced.

## 1. Implementation facts

For a `start`, `src/orchestration/queue-runner.ts` now allocates a
`randomUUID()` run id before invoking the Supervisor. In one atomic queue
write it records:

- `status: "running"`;
- the incremented `attempts`;
- `lastRunId` equal to the allocated id;
- the same id in `runIds`.

The runner receives a persisted item snapshot whose `lastRunId` is that id.
`QueueSupervisorRequest.runId` remains resume-only, preserving the existing
injected-runner contract. The queue does not wait for a Supervisor summary or
consult `active.json` to discover the start id.

`src/supervisor/cli.ts` accepts `--run-id <id>` for `supervisor start`. When
it is absent, `start` still generates `randomUUID()`. When present, the CLI
passes the value into the existing supervisor lock and manifest creation path;
the store retains responsibility for the path-safe id validation and
duplicate-manifest rejection. `resume` remains keyed by `--run`.

`createQueueSupervisorRunner()` now reads the start id from
`request.item.lastRunId` and maps:

- `start` to `start ... --run-id <preallocated-id>`;
- `resume` to `resume ... --run <existing-id>`.

After the runner returns or throws, the queue checks the manifest at the
assigned id:

- If that manifest exists, the binding is preserved. An interrupted or failed
  manifest leaves the item blocked with `nextAction=resume`.
- If a start created no manifest at the assigned id, the speculative
  `lastRunId` and `runIds` entry are removed. The item becomes retryable with
  `nextAction=start`.
- Missing-manifest reconciliation applies the same rule to a queue item left
  `running` by a process crash. The attempted id remains visible in the
  reconciliation record, but it is not retained as a resumable run binding.
- An unreadable or identity-mismatched manifest still fails closed rather than
  being treated as a new start.

The queue never writes or repairs a `RunManifest`. It reads the explicit
manifest by run id to classify dispatch outcomes and crash recovery.

## 2. Focused tests

File: `tests/queue-run-binding.test.ts`

| Test | Proof |
|------|-------|
| `a start run id is durable before the runner returns and keys the manifest` | Reads `queue.json` inside the injected runner and observes `running`, attempt `1`, matching `lastRunId`/`runIds`; the request snapshot and manifest use the same id while the legacy resume-only `request.runId` remains empty. |
| `the real start runner passes --run-id while resume keeps --run` | Captures the real adapter arguments: `start` includes `--run-id`, while `resume` includes `--run` and excludes `--run-id`. |
| `supervisor start honors --run-id and the manifest store rejects unsafe ids and collisions` | A dry-run start persists exactly the caller id; a repeated id and an unsafe id are rejected by the existing store path. |
| `a crash-like start with a durable manifest is reconciled by its explicit id` | A persisted `running` queue item with a dead-owner manifest reconciles and resumes the same explicit id. |
| `a start failure before manifest creation falls back to a fresh start` | Both a returned failure and a thrown runner failure clear the dangling binding; explicit retry dispatches `start` with a new id. |

Commands run from this worktree:

```text
npm run build
# exit 0

node --import tsx --test tests/queue-run-binding.test.ts
# 5 passed, 0 failed

node --import tsx --test \
  tests/queue-run-binding.test.ts \
  tests/orchestration-queue.test.ts \
  tests/supervisor-cli.test.ts
# 28 passed, 0 failed
```

The broader queue/supervisor/Plan-backed regression command was:

```text
node --import tsx --test \
  tests/queue-run-binding.test.ts \
  tests/orchestration-queue.test.ts \
  tests/supervisor-cli.test.ts \
  tests/queue-control-snapshot.test.ts \
  tests/plan-backed-queue-core.test.ts \
  tests/plan-backed-queue-cli.test.ts
```

Result: 50 tests, 50 passed, 0 failed.

The first repair run exposed the existing Plan-backed assertion at
`tests/plan-backed-queue-core.test.ts:600`, which expects `request.runId` to
remain `undefined` for a start. The repair preserves that resume-only request
field and passes the start binding through the persisted
`request.item.lastRunId`; no existing test outside `writePaths` was edited.

## 3. Compatibility behavior

- Existing callers may omit `--run-id` from `supervisor start`; random UUID
  generation is unchanged.
- Existing `resume`, status, stop and manifest-version behavior is unchanged.
- Queue dispatch always makes an explicit start id durable in
  `item.lastRunId` and the adapter supplies it through `--run-id`. The
  adapter's legacy `active.json` fallback is reachable only for direct callers
  whose item has no start id; it is not used by the queue path.
- A legacy injected queue runner may report a different explicit run id when
  it predates `--run-id`. The queue adapter still reports the preallocated id,
  and the queue root path uses the real Supervisor CLI with the exact id.
- Existing queue `version: 1`, `RunManifest` version and `TaskContract` shape
  are unchanged.

## 4. Remaining limits

- Queue state and RunManifest creation are separate durable writes, not one
  cross-file transaction. The ordering makes the queue binding visible first;
  if the Supervisor never creates the manifest, recovery clears the binding
  and retries from `start`.
- Crash reconciliation is foreground and runs when the next `queue run`
  acquires the queue lock. It is not a daemon or background monitor.
- The queue still dispatches one item at a time. This change does not make
  multiple active pointers safe or support parallel queue dispatch.
- Historical queue records are not migrated. Only a current dispatch or a
  `running` item being reconciled receives the new missing-manifest handling.
- The full repository suite could not complete in this sandbox: child CLI
  tests hit `EPERM` creating `tsx` IPC pipes, and runtime fixtures could not
  bind their fixed local ports. Those results are not claimed as passes.
- No real provider run was required for this binding change. The tests use
  scratch Git repositories, a dry-run Supervisor and explicit injected
  runner evidence.

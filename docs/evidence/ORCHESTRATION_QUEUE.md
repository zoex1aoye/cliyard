# Orchestration Queue v0 — Measured Evidence

> Date: 2026-10-27
>
> Environment: macOS (Darwin 27.0.0), Node `v20.20.2`, cliyard HEAD
> `20b9a641b053df74f4a5e592a62d32500fcc4d4f`, Claude Code `2.1.185`
> through `claude-ds`.
>
> Scope: a **foreground, explicit-approval queue** over frozen contract files.
> Measurements use scratch Git repositories under
> `/tmp/cliyard-queue-evidence/`, a local fixture provider on the real CLI
> path, the injected queue runner in the focused test file, and one real
> Claude Code + DeepSeek smoke. These are single local runs, not a CI result,
> a flake-rate claim, or a 24-hour/daemon claim.

The queue is **not a daemon** and does not add background execution. One
`queue run` invocation owns the queue lock, dispatches at most one item at a
time, and exits. The **RunManifest remains the task-level authority**; the
queue only persists item state and reads the manifest to classify an outcome.
It never approves contracts, creates contracts, or rewrites a RunManifest.
The workflow requires each item to be an explicitly approved, already-frozen
contracts file or — for the later `queue add-plan` source kind — an explicitly
approved Plan whose contracts are compiled deterministically before dispatch.
`queue add` records its resolved path and exact SHA-256; it does not itself
check the `frozen` flag, so a non-frozen contract is rejected by the
Supervisor at dispatch and the item is blocked.

The original queue documentation pass changed only `README.md`,
`docs/NEXT_ITERATION.md`, `docs/SUPERVISOR_V0.md` and this file; the later
Plan-backed documentation pass also added
[docs/evidence/PLAN_BACKED_CHAIN.md](PLAN_BACKED_CHAIN.md). No source, test or
design-authority file was changed. Scratch repositories, fixtures and logs are
outside the repository and are not committed.

> **Superseded limitation (2026-10-27):** the measurements below are for
> **contract-backed** queue items and remain accurate for that source kind.
> The later Plan-backed chained queue base adds `queue add-plan`; a Plan-backed
> dependent compiles at the completed upstream RunManifest `integrationHead`,
> so its integration branch does retain the upstream head as an ancestor (one
> linear dependency only). Three real Claude Code + DeepSeek Plan-backed chains
> completed 2/2 (17.2 s, 24.6 s and 21.4 s). See
> [PLAN_BACKED_CHAIN.md](PLAN_BACKED_CHAIN.md). The current full suite is
> 236/236 with 31 new Plan-backed tests; the 13/13 and 205/205 counts below are
> this document's historical HEAD `20b9a64` measurement.

## 1. Build and test counts

Run from the cliyard checkout:

| Command | Result | Test-runner duration |
|---------|--------|----------------------|
| `npm run build` | exit `0` | — |
| `npx tsx --test tests/orchestration-queue.test.ts` | 13/13 pass | 1892.0 ms |
| `npm test` (full suite) | 205/205 pass | 11022.6 ms |

`tests/orchestration-queue.test.ts` has 13 top-level tests. The full suite
includes the queue tests and all prior Supervisor, attempt-continuity,
worker-progress, Task Architect, runtime and drill groups. Those other groups
were not separately re-run this round; their tests passed as part of the
205-test run. The result is one local macOS run, not a repeated-run flake rate
or a CI claim.

## 2. Injected path (focused tests)

The focused file drives `runQueue` through the injected
`QueueSupervisorRunner` seam, through `runQueueCli`, and (one test) through a
spawned top-level `src/cli.ts queue` process. Its 13 tests cover:

| Test | What it proves |
|------|----------------|
| `queue add freezes contracts identity and rejects unsafe ids and dependencies` | Path/SHA-256 frozen at add; duplicate/invalid ids, unknown deps and cycles rejected; missing contracts rejected |
| `queue add/list emit JSON and human summaries through the CLI` | `add`/`list` JSON and human output; dependency recorded |
| `queue run dispatches in dependency order and persists running before dispatch` | Injected runner observes persisted `running` and `attempts=1` before every call; completed items are monotonic and a second run rewrites nothing |
| `--max-dispatches bounds one invocation without discarding pending work` | Bound stops dispatch, leaves `pending`; a later run continues |
| `cancelled items are monotonic and are never dispatched` | Cancel is terminal; retry of cancelled refuses |
| `default queue run stops at the first blocked item` | One dispatch, stop reason, later items stay pending |
| `default queue run stops before work queued behind an existing block` | A durable block stops a later run; `--continue-on-blocked` can still run independent work |
| `--continue-on-blocked keeps independent work moving and blocks dependants` | Independent item completes; dependant is blocked transitively with exact reason |
| `queue retry resumes the recorded run and falls back to start without one` | Blocked→pending; `nextAction=resume` with a run id, `start` without one; retry does not rewrite the run |
| `changed or missing contracts fail closed before dispatch` | Zero dispatches, zero attempts, both blocked |
| `a stale queue lock is reclaimed and running items reconcile against their RunManifest` | Completed→completed, interrupted/blocked→pending resume, missing/capped/live-owner→blocked; manifest bytes unchanged |
| `queue lock serializes concurrent runs and fails closed on foreign or invalid owners` | Stale same-host lock reclaimed; live lock serialized; foreign/invalid lock fails closed; two concurrent runs dispatch each item once |
| `queue run JSON/human summaries and top-level cliyard queue wiring` | CLI exit codes, JSON summary, retry/cancel output, `src/cli.ts` queue wiring |

The injected test uses constructed RunManifests with run ids. Section 8 adds
real-process crash measurements, including the **no-run-id crash window** that
the injected test does not cover.

## 3. Measurement fixtures

Scratch root: `/tmp/cliyard-queue-evidence/`.

```text
fake-claude.cjs                 local fixture provider used on the real CLI path
repo-a/                         dependency order + completion + monotonic rerun
repo-b/                         blocked stop + --continue-on-blocked
repo-c/                         blocked -> queue retry -> resume same run
repo-d/                         SIGKILL during start (no run id recorded)
repo-d2/                        SIGKILL during resume (recorded run id)
repo-e/                         changed and missing contracts
repo-f/                         one real Claude Code + DeepSeek smoke
```

Every scratch repository is a fresh `git init` with one committed
`README.md`. Contracts are single-task `{ "contracts": [...] }` files with
`frozen: true`, `sharedResources: []`, a pinned full `baseCommit`, and
`maxRepairs: 0`.

The fixture provider is an executable Node script outside every target
repository. It parses `Task:` and `Write only under:` from the worker prompt,
appends the task id to `CLIYARD_TEST_WORKER_LOG`, writes its declared file and
emits one stream-json result. `CLIYARD_TEST_BLOCK_TASK` makes it write a
marker and then sleep forever, which provides a real in-flight worker for lock
and crash measurements. It is a **fixture provider**, not a real model.

CLI commands below use the built CLI:

```bash
npm run build
node dist/cli.js queue ...
```

`npm run dev -- queue ...` is equivalent before a build. All queue commands
were run from the cliyard checkout with `--repo <scratch-repo>`.

## 4. Add, list and frozen identity

Scenario A (`repo-a`), adding three approved contracts:

```bash
npm run dev -- queue add "$A/contracts/setup.json" --repo "$A" \
  --id setup --worker claude --model fixture-model --json
npm run dev -- queue add "$A/contracts/build.json" --repo "$A" \
  --id build --depends-on setup --worker claude --model fixture-model --json
npm run dev -- queue add "$A/contracts/solo.json" --repo "$A" \
  --id solo --worker claude --model fixture-model --json
```

Adding `build` before `setup` failed at mutation time with exit `1` and:

```text
queue item "build" depends on unknown item "setup"
```

`queue list` before any run:

```text
queue: 3 item(s) — pending 3 / running 0 / completed 0 / blocked 0 / cancelled 0
setup  pending  next=start  worker=claude/fixture-model  attempts=0/3  deps=-  run=-
  contracts: /tmp/cliyard-queue-evidence/repo-a/contracts/setup.json (sha256 a19001b507b18144822414b0e4d8c1ca26c0b3f527ab621187e86e3a75628ddf)
build  pending  next=start  worker=claude/fixture-model  attempts=0/3  deps=setup  run=-
  contracts: /tmp/cliyard-queue-evidence/repo-a/contracts/build.json (sha256 81ba5f8211846b3059b1245a68b1d97ccb1f919274d1cc6c816beb5d4061ca8b)
solo  pending  next=start  worker=claude/fixture-model  attempts=0/3  deps=-  run=-
  contracts: /tmp/cliyard-queue-evidence/repo-a/contracts/solo.json (sha256 152dd585023399398fd5c4c59c20d0f414920efbcc9e690a0e9177abb7704527)
```

The corresponding `queue.json` item (first item, exact fields):

```json
{
  "id": "setup",
  "contractsPath": "/tmp/cliyard-queue-evidence/repo-a/contracts/setup.json",
  "contractsHash": "a19001b507b18144822414b0e4d8c1ca26c0b3f527ab621187e86e3a75628ddf",
  "worker": "claude",
  "model": "fixture-model",
  "dependsOn": [],
  "status": "pending",
  "attempts": 0,
  "maxAttempts": 3,
  "runIds": [],
  "nextAction": "start",
  "createdAt": "2026-10-27T12:27:49.869Z",
  "updatedAt": "2026-10-27T12:27:49.869Z"
}
```

Queue state lives at `<repo>/.cliyard/queue.json`; the lock is
`<repo>/.cliyard/queue.lock`. cliyard's repository `.gitignore` ignores
`.cliyard/`; the scratch repositories were temporary and not committed.
`queue add` resolves a relative contracts path against `--repo` and hashes the
exact bytes.

## 5. Dependency order and completion

Run (fixture provider, real CLI and default Supervisor runner):

```bash
export CLIYARD_CLAUDE_BINARY=/tmp/cliyard-queue-evidence/fake-claude.cjs
export CLIYARD_CLAUDE_MAX_CONCURRENT=1
export CLIYARD_TEST_WORKER_LOG="$A/worker-calls.log"
node dist/cli.js queue run --repo "$A" --json
```

Exit `0`. The worker log recorded:

```text
setup-task
build-task
solo-task
```

Selected summary:

```json
{
  "dispatched": 3,
  "stopped": "idle",
  "dispatches": [
    { "id": "setup", "action": "start", "runId": "02c9c966-1298-4c9d-9fdc-3241099688d3", "exitCode": 0, "status": "completed" },
    { "id": "build", "action": "start", "runId": "799fc283-d2b1-44a5-ba76-485ec44e3cbe", "exitCode": 0, "status": "completed" },
    { "id": "solo", "action": "start", "runId": "7b269384-6d7b-4b9a-8b6e-6af76ca5cfe7", "exitCode": 0, "status": "completed" }
  ],
  "counts": { "total": 3, "pending": 0, "running": 0, "completed": 3, "blocked": 0, "cancelled": 0 }
}
```

Final queue items (selected fields):

```json
[
  { "id": "setup", "status": "completed", "attempts": 1, "nextAction": "resume", "runIds": ["02c9c966-1298-4c9d-9fdc-3241099688d3"] },
  { "id": "build", "status": "completed", "attempts": 1, "nextAction": "resume", "dependsOn": ["setup"], "runIds": ["799fc283-d2b1-44a5-ba76-485ec44e3cbe"] },
  { "id": "solo", "status": "completed", "attempts": 1, "nextAction": "resume", "runIds": ["7b269384-6d7b-4b9a-8b6e-6af76ca5cfe7"] }
]
```

Each run produced its own integration branch:

```text
cliyard/integration/02c9c966-1298-4c9d-9fdc-3241099688d3
cliyard/integration/799fc283-d2b1-44a5-ba76-485ec44e3cbe
cliyard/integration/7b269384-6d7b-4b9a-8b6e-6af76ca5cfe7
```

A second `queue run` dispatched `0` items, stopped `idle`, and left the queue
file byte-identical:

```text
queue sha before=73d66777dc8a2cb699079dc64a35f75d23b29b416682c1c54281caabe129a30a
queue sha after =73d66777dc8a2cb699079dc64a35f75d23b29b416682c1c54281caabe129a30a
worker calls after second run: 3
```

Observed dependency semantics:

- `queue add` rejects an unknown dependency and rejects cycles; an item is
  ready only when every dependency is `completed`.
- Dispatch order is dependency-consistent queue insertion order. Because
  `add` requires dependencies to exist first, a queue created only through
  `add` is already in a valid topological insertion order; the runner's
  traversal still places dependencies before dependants.
- For **contract-backed** items a dependency gates **dispatch and failure
  propagation**, not the next run's base. (Plan-backed `queue add-plan` items
  are different: a dependent's base is the upstream completed RunManifest
  `integrationHead`; see [PLAN_BACKED_CHAIN.md](PLAN_BACKED_CHAIN.md).) In
  scenario A, `build`'s integration branch does not contain `setup`'s accepted
  commit:

  ```text
  setup integration: 69fea5f init -> b143074 setup-task -> 7d204b2 merge
  build integration: 69fea5f init -> f8fb71f build-task -> d1981fe merge
  is setup head an ancestor of build head? no
  ```

  Every **contract-backed** queue item dispatches the Supervisor with its own
  frozen `contractsPath` and `baseCommit`. For contract-backed items, chaining
  code changes across queue items requires contracts pinned to a base that
  already contains the earlier work (normally after human review/merge); the
  queue itself does not synthesize that base. Plan-backed items are the
  exception: the queue compiles the dependent at the completed upstream
  RunManifest `integrationHead` (see
  [PLAN_BACKED_CHAIN.md](PLAN_BACKED_CHAIN.md)).
- `nextAction` remains `resume` after completion in the stored item, but a
  completed item is never dispatched again.

## 6. Blocked stop and `--continue-on-blocked`

Scenario B: `blocker` (verify fails), `dependent` (depends on `blocker`),
`independent`. The fixture worker runs, but the blocker's verify command
checks a nonexistent gate file, so the Supervisor rejects the task with
`maxRepairs=0`.

Default run:

```bash
node dist/cli.js queue run --repo "$B" --json
```

Exit `1`; one dispatch; worker log `fail-task`; result:

```json
{
  "dispatched": 1,
  "stopped": "blocked",
  "reason": "item \"blocker\" blocked: run bf753af6-ef7d-4e00-8c9c-24c1fecdf28e blocked with rejected task(s): fail-task (verify failed and maxRepairs=0 exhausted)",
  "counts": { "total": 3, "pending": 2, "running": 0, "completed": 0, "blocked": 1, "cancelled": 0 }
}
```

Final states after that run: `blocker=blocked` (attempts `1`, `lastRunId`
recorded, `nextAction=resume`), `dependent=pending`, `independent=pending`.
The independent item was ready but was **not** dispatched behind the block.

Then:

```bash
node dist/cli.js queue run --repo "$B" --continue-on-blocked --json
```

Exit `1` (a blocked item remains); one dispatch (`independent`, completed);
worker log now `fail-task independent-task`. Result:

```json
{
  "dispatched": 1,
  "stopped": "idle",
  "propagated": [
    { "id": "dependent", "reason": "dependency \"blocker\" is blocked" }
  ],
  "dispatches": [
    { "id": "independent", "action": "start", "runId": "b06439e9-e5ef-471e-9eb5-3dbd5da505bb", "exitCode": 0, "status": "completed" }
  ],
  "counts": { "total": 3, "pending": 0, "running": 0, "completed": 1, "blocked": 2, "cancelled": 0 }
}
```

`dependent` went from `pending` to `blocked` with
`dependency "blocker" is blocked` and was never dispatched. The flag continues
independent work; it does not retry the blocked item.

## 7. Queue retry and resume

Scenario C: one item `retryable` whose verify requires
`retry-task.txt` and an external gate file. The first run rejects the task and
blocks the item:

```json
{
  "dispatched": 1,
  "stopped": "blocked",
  "dispatches": [
    {
      "id": "retryable",
      "action": "start",
      "runId": "4746e8f6-0681-4be6-a2b6-778da6566611",
      "exitCode": 1,
      "status": "blocked",
      "reason": "run 4746e8f6-0681-4be6-a2b6-778da6566611 blocked with rejected task(s): retry-task (verify failed and maxRepairs=0 exhausted)"
    }
  ],
  "counts": { "total": 1, "pending": 0, "running": 0, "completed": 0, "blocked": 1, "cancelled": 0 }
}
```

The stored item has `attempts=1`, `lastRunId`/`runIds` containing that run,
`nextAction=resume`. `supervisor status --run <id> --json` showed the rejected
task with its attempt worktree and a `reusableAttempts` entry; the supervisor
lock was `free`. The queue retry path writes only the queue document; the
manifest stayed on the same run and was later advanced by the Supervisor
resume.

`queue retry` returned the item to pending without dispatching:

```json
{
  "id": "retryable",
  "contractsPath": "/tmp/cliyard-queue-evidence/repo-c/contracts/retry.json",
  "contractsHash": "6abd43cd3b8dc5d89a5178f719a18bc6ec5097e7cb9bf9292f390bfdb2df253b",
  "worker": "claude",
  "model": "fixture-model",
  "dependsOn": [],
  "status": "pending",
  "attempts": 1,
  "maxAttempts": 3,
  "runIds": ["4746e8f6-0681-4be6-a2b6-778da6566611"],
  "lastRunId": "4746e8f6-0681-4be6-a2b6-778da6566611",
  "nextAction": "resume",
  "createdAt": "2026-10-27T12:28:11.253Z",
  "updatedAt": "2026-10-27T12:28:11.636Z"
}
```

The retry was measured before the gate existed; the gate was then created
before the second run:

```bash
node dist/cli.js queue retry retryable --repo "$C" --json
printf 'gate\n' > "$C/gate"
node dist/cli.js queue run --repo "$C" --json
```

The run dispatched `resume` for the **same** run id and completed:

```json
{
  "dispatched": 1,
  "stopped": "idle",
  "dispatches": [
    {
      "id": "retryable",
      "action": "resume",
      "runId": "4746e8f6-0681-4be6-a2b6-778da6566611",
      "exitCode": 0,
      "status": "completed"
    }
  ],
  "counts": { "total": 1, "pending": 0, "running": 0, "completed": 1, "blocked": 0, "cancelled": 0 }
}
```

Final item: `attempts=2`, `runIds` still contains only
`4746e8f6-0681-4be6-a2b6-778da6566611`. The worker was invoked twice
(`retry-task retry-task`). Resume used the Supervisor's
`resume --run <id> --retry-rejected` path; the queue does not rewrite task
state or the provider conversation.

The focused test also covers the fallback: when a blocked item has no recorded
run id, `queue retry` leaves `nextAction=start` and the next dispatch starts a
new run.

## 8. Stale running recovery

Two crash points were measured with real processes and `SIGKILL` of the queue
process group (queue process, Supervisor work and fixture worker).

### 8.1 Crash during `start` before a run id is recorded — blocked

Scenario D: one `crashy` item. A detached `queue run` was started with a
blocking fixture worker (effective child command shown; it was launched in its
own process group):

```bash
CLIYARD_TEST_BLOCK_TASK=crash-task CLIYARD_TEST_MARKER="$D/crash-started" \
  node dist/cli.js queue run --repo "$D" --json
```

(The host value below is normalized to `<this-host>`; the lock recorded
`hostname()` on the same machine.) While it was active:

- the item was `running`, `attempts=1`, `nextAction=start`, with **no**
  `lastRunId`/`runIds` yet;
- the queue lock existed:
  ```json
  {
    "pid": 11156,
    "host": "<this-host>",
    "token": "574bf651-e8b8-447e-8f8e-581046d0943b",
    "acquiredAt": "2026-10-27T12:31:47.631Z"
  }
  ```
- `queue list` read the queue while the lock was held;
- a second `queue run --max-dispatches 1` exited `1` after **5072 ms** with:
  ```text
  queue lock held by pid 11156 on <this-host>
  ```
- the RunManifest existed at `.cliyard/runs/85ccce65-1c79-43f5-9653-78a27cb20dd1.json`
  with `status=running`, owner pid `11156`, and the task `running`.

The process group was then `SIGKILL`ed. The queue lock file remained on disk,
the queue item remained `running` with attempts `1` and no run id, and the
manifest remained `running` with a dead owner. The next run:

```bash
node dist/cli.js queue run --repo "$D" --json
```

exited `1` and returned:

```json
{
  "reconciled": [
    {
      "id": "crashy",
      "from": "running",
      "to": "blocked",
      "reason": "running item has no recorded run id"
    }
  ],
  "dispatched": 0,
  "stopped": "blocked",
  "dispatches": [],
  "counts": { "total": 1, "pending": 0, "running": 0, "completed": 0, "blocked": 1, "cancelled": 0 }
}
```

The stale same-host lock was reclaimed and removed. The RunManifest remained
`running` with a dead owner because the queue had no recorded run id and did
not consult `.cliyard/runs/active.json`; queue reconciliation itself does not
write manifests (the focused test also asserts manifest bytes are unchanged).
The stored item has no run id, so
`queue retry` would set `nextAction=start` (the focused test covers that
fallback) and the abandoned manifest is not resumed by this path. This is a
measured **crash window/limitation**, not a daemon recovery claim.

### 8.2 Crash during `resume` with a recorded run id — reconciled and resumed

Scenario D2: first run blocks (same gate technique), recording run
`b3600511-bd74-42e9-8ce9-8c1a39b51812` and `attempts=1`. `queue retry` made
the item pending with `nextAction=resume`. A detached resume dispatch then
started with a blocking fixture worker:

```bash
CLIYARD_TEST_BLOCK_TASK=crash-task CLIYARD_TEST_MARKER="$D2/crash-started" \
  node dist/cli.js queue run --repo "$D2" --json
```

While active:

- item `running`, `attempts=2`, `lastRunId` set to the recorded run;
- manifest `running`, owner pid `11808`;
- queue lock held with token `e6d2a6bb-ffd9-4824-8fd7-7f18f70bd59b`.

After `SIGKILL` of the process group, the lock and `running` item remained,
and the manifest still said `running` with a dead owner. The gate file was
created, and the next run:

```bash
node dist/cli.js queue run --repo "$D2" --json
```

exited `0`:

```json
{
  "reconciled": [
    {
      "id": "crashy",
      "from": "running",
      "to": "pending",
      "runId": "b3600511-bd74-42e9-8ce9-8c1a39b51812"
    }
  ],
  "dispatched": 1,
  "stopped": "idle",
  "dispatches": [
    {
      "id": "crashy",
      "action": "resume",
      "runId": "b3600511-bd74-42e9-8ce9-8c1a39b51812",
      "exitCode": 0,
      "status": "completed"
    }
  ],
  "counts": { "total": 1, "pending": 0, "running": 0, "completed": 1, "blocked": 0, "cancelled": 0 }
}
```

Final item: `attempts=3`, same single `runId`, `nextAction=resume`. The worker
was invoked three times in total (`crash-task crash-task crash-task`). The
manifest ended `completed`, task `accepted`, and the integration branch
contained `crash.txt` (`export const task = 'crash-task';`). The queue lock
was removed. The queue read the manifest for classification and never rewrote
it; the completing write came from the Supervisor resume.

### Lock evidence summary

| Observation | Scenario | Result |
|-------------|----------|--------|
| Mutations/dispatch serialized by `queue.lock` | A/B/C/D/D2 | lock created for run, removed on completion |
| `queue list` while a run holds the lock | D | read succeeded |
| Second `queue run` while a live same-host owner holds the lock | D | waited 5072 ms, exit `1`, exact owner message |
| Stale same-host lock after `SIGKILL` | D | left on disk, reclaimed by the next run |
| Stale same-host lock after `SIGKILL` | D2 | left on disk, reclaimed; item reconciled against manifest and resumed |
| Foreign-host and invalid locks fail closed | focused tests | no CLI measurement this round |
| Concurrent foreground runs dispatch each item once | focused tests | no CLI measurement this round |

## 9. Changed and missing contracts fail closed

Scenario E: two approved contracts were added, then one file was edited and
the other was deleted before dispatch.

```bash
printf '\n# changed after approval\n' >> "$E/contracts/changed.json"
rm "$E/contracts/removed.json"
node dist/cli.js queue run --repo "$E" --continue-on-blocked --json
```

Exit `1`, `dispatched=0`, `dispatches=[]`, both items blocked, `attempts=0`:

```json
{
  "dispatched": 0,
  "stopped": "idle",
  "dispatches": [],
  "counts": { "total": 2, "pending": 0, "running": 0, "completed": 0, "blocked": 2, "cancelled": 0 }
}
```

Recorded reasons:

```text
changed: contracts changed: /tmp/cliyard-queue-evidence/repo-e/contracts/changed.json (expected sha256 bdb841acdb6307c9b0dbe294da4659d4de58ed44223a8a5946605c73b31333da, found 33e5e7a4bfbd08499773d300ee31ebca5b1f2230fce8a11f4342a2435c122730)
removed: contracts file is missing or unreadable: /tmp/cliyard-queue-evidence/repo-e/contracts/removed.json (ENOENT: no such file or directory, open '/tmp/cliyard-queue-evidence/repo-e/contracts/removed.json')
```

No worker log was created, no `runs/` directory existed, and the queue lock
was removed. The queue never silently dispatched different bytes under the
same item id.

## 10. Real Claude Code + DeepSeek smoke

Scenario F: one explicit item, one task, real `claude-ds` launch with model
`deepseek-flash[1m]` and `CLIYARD_CLAUDE_MAX_BUDGET_USD=1`:

```bash
unset CLIYARD_CLAUDE_BINARY
export CLIYARD_CLAUDE_MAX_BUDGET_USD=1
node dist/cli.js queue add "$F/contracts/real.json" --repo "$F" \
  --id real-deepseek --worker claude --model 'deepseek-flash[1m]' --json
node dist/cli.js queue run --repo "$F" --json
```

Exit `0`, wall time **4810 ms**, one dispatch. The task asked for `real.txt`
containing exactly `queue-real`; verification was `test -f real.txt` and
`grep -qx queue-real real.txt`.

Observed:

```json
{
  "dispatched": 1,
  "stopped": "idle",
  "dispatches": [
    {
      "id": "real-deepseek",
      "action": "start",
      "runId": "4ad00164-bb6d-4111-bfe8-88b74493a547",
      "exitCode": 0,
      "status": "completed"
    }
  ],
  "counts": { "total": 1, "pending": 0, "running": 0, "completed": 1, "blocked": 0, "cancelled": 0 }
}
```

Final queue item:

```json
{
  "version": 1,
  "updatedAt": "2026-10-27T12:32:54.834Z",
  "items": [
    {
      "id": "real-deepseek",
      "contractsPath": "/tmp/cliyard-queue-evidence/repo-f/contracts/real.json",
      "contractsHash": "cc10f189010ebb6080a128e2be777822f71d218aaef03ebe75ab68e169ad844f",
      "worker": "claude",
      "model": "deepseek-flash[1m]",
      "dependsOn": [],
      "status": "completed",
      "attempts": 1,
      "maxAttempts": 3,
      "runIds": ["4ad00164-bb6d-4111-bfe8-88b74493a547"],
      "lastRunId": "4ad00164-bb6d-4111-bfe8-88b74493a547",
      "nextAction": "resume",
      "createdAt": "2026-10-27T12:32:50.007Z",
      "updatedAt": "2026-10-27T12:32:54.834Z"
    }
  ]
}
```

The RunManifest ended `completed` with `real-task` accepted and result commit
`c8e2b34393530acef3f7a497ec17d8b96a07f7ba`; the integration branch
`cliyard/integration/4ad00164-bb6d-4111-bfe8-88b74493a547` merged it, and
`git show refs/heads/cliyard/integration/<runId>:real.txt` returned
`queue-real`. Seven worker events were recorded:
`session.start,tool.start,tool.result,tool.start,tool.result,assistant,result`.

The CLI output did not report actual provider cost, so no dollar amount is
claimed; the `$1` cap is the only cost bound recorded here. This is a single
short smoke and does not establish model quality, long-run behavior, cost or
flake rate.

## 11. What was measured and what was not

Measured on this date:

- build, focused queue tests and full suite;
- injected runner persistence/order/blocked/retry/reconcile assertions;
- real CLI add/list/run/retry paths on scratch repositories with a fixture
  provider (cancel/retry CLI behavior is also covered by focused tests);
- dependency-consistent dispatch, completion and monotonic rerun;
- `queue run` exit codes: `0` for runs with no blocked item (A, C second run,
  F), `1` when any item is blocked (B, C first run, E); the focused test covers
  `0` with pending work after `--max-dispatches`;
- default blocked stop and explicit `--continue-on-blocked` propagation;
- blocked retry and same-run resume (`--retry-rejected`);
- live same-host queue lock serialization and stale-lock reclamation;
- `SIGKILL` crash during start (no run id) and during resume (run id known),
  including exact reconciliation outcomes;
- changed and missing contracts failing closed with zero dispatches;
- one real Claude Code + DeepSeek queue-to-integration smoke;
- queue files remaining under `.cliyard/`; RunManifest unchanged by queue
  reconciliation.

Not measured / not claimed:

- a daemon, background service, launchd/systemd/cron, periodic scan, or 24h
  unattended operation;
- cross-host queue coordination or cross-host lock reclamation;
- SQLite or any store other than the atomic JSON queue;
- parallel dispatch or CPU/memory/browser admission scheduling;
- automatic approval, contract creation, model/budget escalation, push or
  merge to `main`;
- browser/Playwright/axe/screenshot evidence;
- queue dry-run (the queue has no `--dry-run`; measured dispatches used a
  fixture provider or the real provider);
- a queue-owned stop command for a live run; the measured crash used
  `SIGKILL` of the process group;
- foreign-host/invalid-lock and concurrent-run behavior on the real CLI
  (covered by focused tests);
- provider-conversation resume (attempt reuse is worktree continuity only);
- long-run flake rates, cost accuracy or Plan/queue quality.

## 12. Remaining limitations

- **Foreground only.** `queue run` is the process; closing the terminal or
  killing the host stops it. There is no daemon to restart it and no 24h
  claim.
- **Explicit approval only.** Every item is either an operator-added contracts
  file that the workflow expects to be already frozen, or an explicitly
  approved Plan added with `queue add-plan`; the queue does not approve,
  create, edit or freeze contracts or Plans. `queue add` does not validate the
  `frozen` flag; the Supervisor does at dispatch, and a non-frozen contract
  becomes a blocked item. Changed or missing contract bytes block instead of
  being re-read, and a changed Plan/materialization blocks the Plan item.
- **One item at a time.** Dispatch is strictly sequential. There is no
  parallel admission or cross-run runtime scheduler.
- **Contract-backed dependencies gate dispatch, not code state.** Each
  contract-backed Supervisor run uses its own frozen contract base, so a
  contract-backed dependant does not automatically contain its dependency's
  integration branch (measured in scenario A). Plan-backed items are the
  exception: `queue add-plan` compiles at the upstream completed RunManifest
  `integrationHead` and supports one linear dependency. Multi-parent
  integration, a merge queue and automatic main merge remain absent.
- **Start crash window.** If the queue dies after persisting `running` but
  before recording the Supervisor run id, reconciliation is fail-closed:
  the item becomes `blocked` with `running item has no recorded run id`, the
  RunManifest may remain `running`, and retry starts a new run. The queue does
  not discover the manifest through `active.json`. A crash during `resume`
  with a recorded run id reconciles to `pending` and resumes the same run.
- **No queue history / GC / update.** Completed and cancelled items remain in
  `queue.json`; queue ids cannot be reused; there is no command to replace a
  frozen contracts file or an approved Plan in place. Changed contracts or
  Plans require a new item.
- **Same-host lock only.** A same-host dead-PID lock is reclaimed; a
  foreign-host lock fails closed, and liveness on another host cannot be
  proven. The lock coordinates cliyard processes, not external actors.
- **No queue-level cancellation of a live dispatch.** `queue cancel` is a
  locked mutation; while a live run owns the queue lock, it cannot acquire the
  lock and fails. Stopping an active run is a process signal/lock recovery
  operation, not a queue command. (The 5 s wait applies to `queue run` only;
  the live-lock wait was measured there.)
- **JSON, not SQLite.** The queue is one atomically replaced JSON document.
  There is no transaction across queue and RunManifest, and no cross-run
  query layer.
- **Advisory progress.** Worker event streams remain observational; the queue
  does not consume them for acceptance.
- **No automatic main merge or push.** The integration branches remain local
  and manual review/merge is required.
- **Real-provider evidence is one 4.8 s smoke.** It is not a quality, cost,
  failure-rate or long-run benchmark.
- **Tests are local and single-run.** 13/13 focused and 205/205 full-suite
  results on macOS are not a CI or flake-rate claim.

## 13. Non-goals and next step

The queue does not change these non-goals: no daemon/background service, no
24-hour unattended claim, no cross-host recovery or shared storage, no SQLite,
no browser evidence, no parallel admission scheduling, and no automatic push
or `main` merge.

Queue semantics are now measured in the foreground, and the later Plan-backed
chained queue base measures one linear code dependency. The **next step is a
decision about a supervised foreground long-run controller/daemon**, only
after Plan-backed chain semantics are accepted. No such controller or daemon
is implemented or claimed by this evidence; any future background execution
model requires its own design and acceptance.

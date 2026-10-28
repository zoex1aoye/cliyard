# Next Steps: Observability, Routing and Parallel Delivery

> Recorded: 2026-10-27
>
> Baseline: `3065ad9` / `selfhost/chained-read-context-complete`
>
> Implementation update (2026-10-28): `queue status`, the queue event journal,
> the read-only resource/provider snapshot, worker failure taxonomy/cost
> truth, **queue manual adoption v1**, run binding, worker path audit,
> health-gated budget continuation/deadline extension, and deadline-fixture
> stability are implemented. The next P0 slice is **WorkerLease persisted at
> spawn plus controller owner-death recovery**. Only after that: secret-free
> `ProfileCatalog` with real binding activation, per-run Supervisor ownership,
> and fixed hierarchical admission. Windows Job Object ownership and dynamic
> routing scores stay behind those prerequisites. Evidence:
> [evidence/QUEUE_ADOPTION.md](evidence/QUEUE_ADOPTION.md),
> [evidence/CONTROL_SNAPSHOT.md](evidence/CONTROL_SNAPSHOT.md) and
> [evidence/FAILURE_COST_TRUTH.md](evidence/FAILURE_COST_TRUTH.md).

## Decision

The next capability is **design-aware parallel delivery with deterministic
CLI + model routing**. A foreground long-run controller remains valuable, but
it is neither the first product milestone nor a substitute for parallel
scheduling and trustworthy acceptance.

The self-hosting runs also showed that the control plane needs a stronger
read-only operational view and machine-readable failure classification first.
Without those, both a controller and a parallel scheduler would still require
a human to manually join queue items, RunManifests, worker events, provider
sessions, execution bindings, attempt limits and block reasons.

The implementation order was revised after the competitive and entry review:

```text
queue observe / status (implemented)
  -> worker failure taxonomy + cost truth (implemented)
  -> live first-run identity + failed-attempt path audit (implemented)
  -> healthy budget continuation + deadline extension (implemented)
  -> queue manual adoption / OperatorResolution (implemented)
  -> deadline fixture stability (implemented)
  -> telemetry-backed task estimates (design only)
  -> WorkerLease persisted at spawn + controller owner-death recovery (NEXT)
  -> secret-free ProfileCatalog + real endpoint/account binding activation
  -> per-run Supervisor ownership + short control-store locks
  -> fixed hierarchical admission for queue items + Plan ready waves
  -> Windows Job Object ProcessOwnerProvider
  -> telemetry-backed dynamic routing score + adaptive ramp/backoff
  -> parallel queue + Plan-wave v0
  -> stable local Control API + DSH better-sidebar cockpit
  -> DesignRevision + EvidenceBundle/verdict
  -> look-ahead foreground controller
  -> bounded soak
  -> daemon/launchd/systemd decision
```

Adoption and the deadline fixture are closed. They do **not** authorize
parallel dispatch, profile activation, admission, Windows parity or dynamic
scoring; those remain separate prerequisites in the order above.

The controller is an event-loop over durable files. It must rehydrate from
disk on every cycle and must not depend on an LLM's context staying alive.
Queue JSON and RunManifest remain the authorities; controller state, progress,
events and heartbeats are observational.

The controller is deliberately late: it automates scheduling and acceptance,
so those semantics must be correct first. Routing, parallel admission and
entry selection are specified in
[PRODUCT_STRATEGY_V2.md](PRODUCT_STRATEGY_V2.md).

## Implemented since this plan was recorded

### Queue manual adoption v1 (2026-10-28)

`queue adopt <queue-id> --repo <path> --run <run-id> --artifact
<full-git-sha> --evidence <evidence.json> --approved-by <operator> --reason
<text>` closes one blocked item after a human reviewed and integrated its
work. The source blocked/interrupted `RunManifest` remains historical truth;
the queue stores a separately versioned `OperatorResolution` in `queue.json`
and appends a bounded `queue.item.adopted` event. `queue status` reports
`completion: "adopted"` while retaining the blocked run and its unaccepted
tasks.

Preconditions are fail-closed: exact `lastRunId`, unchanged frozen contracts
(and approved Plan for Plan-backed items), a full reviewed commit that
descends from the pinned base and is contained by current `HEAD`, and bounded
secret-free review evidence with at least one successful command. Re-adoption
is idempotent only for a byte-identical resolution identity; any difference is
rejected. Plan-backed dependants record `upstreamAdoptedCommit` and use the
reviewed commit as their base unless a valid completed upstream integration
head contains it.

Measured on integration HEAD `ce1157a`: build exit `0`; queue-adoption focused
**8/8** (2539.7 ms); deadline-extension focused **13/13** (23601.98 ms); full
suite **371/371** (24411.1 ms, 0 fail). Evidence:
[evidence/QUEUE_ADOPTION.md](evidence/QUEUE_ADOPTION.md).

This slice does **not** implement WorkerLease at spawn, owner-death recovery,
profile activation, admission, parallel dispatch, Windows parity or a daemon.

## Immediate next slices

### 1. `queue-observe-v0` (P0)

**Status: implemented in the read-only CLI slice.**

Add one read-only projection that joins:

```text
QueueItem
  + materialization lineage
  + last RunManifest
  + task states and attempt identity
  + latest worker event/session
  + current queue/controller lock state
```

Proposed command:

```bash
cliyard queue status --repo <path> [--json]
```

Minimum fields:

- item state, next action, attempts/max attempts and retryability;
- Plan hash, root/materialized base and upstream integration head;
- run id, manifest status, accepted/blocked task counts and integration head;
- latest worker session, event type, event age and explicit stale/unknown state;
- current block reason and whether a human/verifier/infrastructure decision is
  required;
- provider-session generation count when an attempt spans multiple sessions;
- exact observed-at time.

This command must be read-only and must not mark stale work healthy merely
because a file exists.

### 2. `queue-event-journal-v0` (P0)

**Status: implemented with bounded fields and best-effort appends.**

Append bounded queue-level events to:

```text
<repo>/.cliyard/queue-events/events.jsonl
```

Candidate event types:

```text
plan.materialized
attempt.started
run.started | run.resumed
provider.session.started | provider.session.ended
run.completed | run.blocked | run.interrupted
queue.retry | queue.cancel
controller.started | controller.heartbeat | controller.stopped
```

The journal is audit/observation only. It is not contract authority, not
acceptance evidence and not a replacement for RunManifest.

### 3. `worker-failure-taxonomy-v0` (P0)

**Status: implemented 2026-10-27 (`failure-cost-core` + `failure-cost-durable`).**

Every newly rejected dispatched task carries a bounded, secret-free
`FailureRecord`. The taxonomy has exactly ten categories:

```text
budget_exhausted
timeout
provider_transient
provider_auth
provider_protocol
worker_process_exit
verifier_rejected
policy_blocked
resource_exhausted
unknown
```

Stages are `contract | preflight | spawn | provider | worker | verifier | policy | unknown`.
Priority is timeout > budget > auth > resource > transient >
protocol > worker process exit > verifier > policy > unknown. `verifier_rejected`
requires a successful worker result; a worker process failure is never
relabeled as a verifier rejection. Records preserve a bounded final provider
error while dropping raw payloads, prompts, file contents and auth headers;
`retryableHint` is advisory only.

`CostTruth` has exactly four states: `provider-reported`, `cli-estimated`,
`usage-only` and `unavailable`, with per-session observations, token usage,
explicit `missing` reasons and `guardBudgetUsd`. Claude Code `total_cost_usd` is
`cli-estimated` with `authoritative: false`; it is never a DeepSeek invoice,
bill or balance. Missing cost stays `unavailable`, never `$0`. The configured
budget is a guard, not spend.

The RunManifest task is the durable authority for a dispatched run; the queue
stores a `policy_blocked` failure only for a deterministic pre-dispatch block
with no manifest. `supervisor status` and `queue status` expose failure/cost
read-only, and `run.blocked` events carry bounded category/stage/code/cost
state. No automatic retry, routing, admission or parallel dispatch is
introduced. The Claude adapter's pre-existing bounded transient retry is
unchanged; after exhaustion it returns the final structured failure.

Measured at that slice: focused failure/cost 50/50, full suite 290/290,
`npm run build` exit 0. The current integrated suite is **371/371**
(2026-10-28, HEAD `ce1157a`). Evidence:
[evidence/FAILURE_COST_TRUTH.md](evidence/FAILURE_COST_TRUTH.md).

### 4. Audited attempt-policy recovery (P1)

Add an explicit operator command rather than hand-editing `.cliyard/queue.json`:

```bash
cliyard queue extend-attempts <id> --to <n> --reason <text>
```

It should persist who/what changed the policy, old/new values, timestamp and
reason, while still requiring `queue retry` before another dispatch.

### 5. WorkerLease at spawn + owner-death recovery (P0, next)

This is the safety prerequisite for every later parallel slice. Persist a
durable `WorkerLease` as soon as the worker identity exists, not after
`collect()` returns. The lease must record run/task/attempt/profile, the
controller's pid/host/process identity, the worker's pid/pgid/OS start
identity/capture mode, workspace, timestamps and cleanup state.

Controller-death policy:

- a new controller reads the lease and verifies exact worker identity;
- if the owned group is alive: terminate only that exact group, preserve the
  worktree and prior evidence, and resume through an explicit new attempt or
  provider-session continuation;
- if the group is gone: inspect artifacts and verify only what can be proven;
- ambiguous identity or cleanup: `needs_human`; never guess from pid, pgid or
  process name alone.

Reattaching to an orphaned CLI's old stdout is not a v1 promise. If the worker
must outlive the controller, that requires an external guardian/OS service
manager and a separate evidence protocol. No durable `WorkerLease` or
owner-death recovery exists today, and manual adoption is not a substitute.

### 6. `ProfileCatalog` + real binding activation (P0 after WorkerLease)

Model the three real deployment shapes:

- many models + many CLIs;
- many models + one usable CLI;
- one model + many CLIs.

Routing is deterministic feasibility filtering and binding selection; an LLM
may recommend but does not own the persisted decision. A selected profile is
**not** proof that an endpoint or account was activated: the adapter must
return or persist a binding activation result before dispatch. Persist runtime,
endpoint/account binding, model, capabilities, health, observed
quota/concurrency, balance/price states, cost and fallback in dispatch
provenance. Unknown capacity, balance or price is an explicit state and cannot
inherit a public nominal number from the model name. Dynamic scoring stays
disabled until activation and fixed admission are measured. See
[PRODUCT_STRATEGY_V2.md](PRODUCT_STRATEGY_V2.md#4-execution-model).

### 7. Parallel Supervisor/queue spike (P0 after WorkerLease and activation)

Current queue and Supervisor are sequential and repo-global. Only after
WorkerLease/owner-death recovery and real profile activation, choose between
per-item isolated control clones and per-run Supervisor ownership with short
Git-control locks. Define multiple `running` items, independent run
manifests/worktrees/branches, provider/model slots, runtime/port leases,
blocked isolation and independent crash recovery.

This is the direct replacement for the developer's multiple terminal-tab
workflow. See
[PRODUCT_STRATEGY_V2.md](PRODUCT_STRATEGY_V2.md#5-parallel-queue-v0-requirement).

The spike must cover both parallel axes:

- queue items / branches running concurrently;
- independent Plan tasks inside one item running as parallel ready waves.

The second axis already exists partially through `readyIds` + `Promise.all`,
but lacks first-class task caps, global provider/runtime admission, two-level
status visibility and explicit merge semantics. Do not build a new intra-item
scheduler from scratch; harden the existing wave scheduler and place both axes
under one admission controller.

The Plan compiler also needs a concurrency-aware write-path rule: overlapping
paths are safe only when a transitive dependency makes the tasks serialize;
otherwise they must be rejected or routed through a future integration
envelope.

### 8. Fixed hierarchical admission (P0 after profile activation and per-run ownership)

Admission must be conjunctive across queue-item slot, task slot,
execution-profile slot, runtime/device slot, port/browser/database lease and
budget/host capacity. Multiple local maxima must never multiply into an
unbounded worker burst. An unknown profile starts with one in-flight probe,
not a public nominal concurrency value. Add fixed limits for both queue items
and Plan ready waves before any adaptive policy; this is the last gate before
bounded parallel dispatch.

### 9. Dynamic admission calibration (P0 after fixed admission)

Implement a shared broker before enabling adaptive scaling. It must combine:

- host CPU/memory pressure and safety reserve;
- per-task/profile resource history;
- runtime/browser/port capacity;
- runtime-observed provider/model concurrency and provider feedback, including
  429, `Retry-After`, quota headers and balance responses;
- item and global task limits.

`3` is the scheduler warm start, not a claim about any subscription. An
unobserved execution binding starts with one in-flight probe. Ramp to 4/5/6
only through measured stable windows and an audited policy; decrease
immediately on 429, memory pressure, swap growth or OOM. Provider balance,
quota and price remain binding-specific and may be `unknown`.
The detailed design is
[design/dynamic-parallel-admission-v0.md](../design/dynamic-parallel-admission-v0.md).

### 10. `foreground-controller-v0` (P1)

Add a finite-process controller command, tentatively:

```bash
cliyard queue watch --repo <path> --poll-ms 2000
```

V0 behavior:

- one same-host controller lock; stale lock recovery only when ownership is
  provably dead;
- acquire/release the existing queue lock per `runQueue` invocation rather than
  holding it while idle;
- poll durable queue state, so newly approved items and explicit retries added
  by the operator are discovered without restarting the controller;
- publish controller heartbeat/state in a separate non-authoritative file;
- stop cleanly on SIGINT/SIGTERM;
- accept bounded test flags such as `--max-cycles`;
- never approve Plans, freeze contracts, merge, push or mark acceptance.

V0 should not auto-retry verifier rejections. The failure taxonomy now exists,
but automatic retry remains unimplemented: it requires an explicit attempt
policy, a reason code, an attempt bound and an audit record.

### 9. Long-run verification

Before any daemon claim:

- cycle tests that add a queue item while the controller is idle;
- interrupted-controller recovery;
- blocked-item no-spin/backoff;
- provider failure, verifier rejection and policy block classification;
- bounded local soak with repeated fake-worker successes and injected failures;
- measured memory/fd/process growth, lock release and no-op stability.

Only after those measurements should launchd/systemd/nohup packaging be
considered as an external process-lifecycle concern.

## Gaps observed in the self-hosting runs

| Priority | Gap | Observed evidence | Consequence | Planned closure |
|----------|-----|-------------------|-------------|-----------------|
| P0 | Queue has no single live status projection | Needed to manually join `queue.json`, RunManifest, `worker-events`, ledger and Git refs | Human must run forensics to know what is happening | `queue status` projection |
| P0 | Queue is sequential although the original pain is managing several terminal/branch lines | Current queue and Supervisor allow one item and one repo-global run at a time | Throughput remains limited by manual terminal switching or by a serial queue | parallel Supervisor/queue spike + bounded parallel v0 |
| P0 | Worker/model binding is fixed too early | Queue items store `worker` and optional `model` at add time | Cannot route across multi-model subscriptions, single-CLI limits or one-model/multi-CLI availability | `ExecutionProfile` feasibility + scoring |
| P0 | No stable client-neutral Control API | Current DSH plugin reads a batch ledger and starts its own monitor | DSH becomes a de facto entry dependency and cannot show complete authority state | versioned local API + SSE/NDJSON |
| P0 | Provider failures are not machine-classified | Three documentation attempts ended after several minutes with only `worker failed`; no final `is_error` or budget classification was retained | Cannot distinguish budget, network, provider protocol or worker failure automatically | **Closed by failure/cost v0:** durable ten-category `FailureRecord` plus bounded final provider detail |
| P0 | The default `$5` budget limit was discovered by repeated provider exits | The same docs task completed only after increasing budget to `$12` | Wasted attempts/time and nearly exhausted queue retry budget | **Closed by failure/cost v0:** `budget_exhausted` category; per-task `guardBudgetUsd` records the configured guard (not spend) |
| P0 | First active queue dispatch has no bound run id | Real run showed `status=running`, `attempts=1`, but queue `run=null`; Supervisor held the actual run | Operator must leave the single control view; unsafe once multiple runs exist | **Closed by queue run binding v0:** the run id is bound before worker execution (see [evidence/QUEUE_RUN_BINDING.md](evidence/QUEUE_RUN_BINDING.md)) |
| P0 | Failed attempts can retain files outside frozen write scope | A budget-exhausted docs attempt left `NEXT_STEP_CONTROLLER.md.tmp...` in its reusable worktree | Retry may inherit non-contract artifacts; normal path gate was skipped by non-zero exit | **Closed by worker exit path audit v0:** paths are audited after every worker exit and reused worktrees are re-audited (see [evidence/WORKER_EXIT_PATH_AUDIT.md](evidence/WORKER_EXIT_PATH_AUDIT.md)) |
| P1 | Budget and time cannot be extended from healthy live state | Real tasks exhausted guards; current CLI exposes failure only at exit and the Supervisor has no extension control path | Operators retry a whole attempt and lose/reconstruct context | **Closed by continuation v0:** same-session budget continuation and health-gated deadline extension are preauthorized and audited (see [evidence/BUDGET_CONTINUATION.md](evidence/BUDGET_CONTINUATION.md), [evidence/DEADLINE_EXTENSION.md](evidence/DEADLINE_EXTENSION.md)) |
| P0 | A blocked run had no formal reviewed-work resolution | Operators manually merged reviewed work while the RunManifest stayed blocked | Ad-hoc recovery could hide the original failure or fake task acceptance | **Closed by queue manual adoption v1:** separate versioned `OperatorResolution`; source RunManifest remains historical truth (see [evidence/QUEUE_ADOPTION.md](evidence/QUEUE_ADOPTION.md)) |
| P0 | No durable worker identity is written at spawn | Process-group cleanup exists, but ownership is not recoverable if cliyard itself is `SIGKILL`ed | A detached worker group cannot be safely reattached or terminated by a new controller | **Next:** persist `WorkerLease` at spawn; exact-identity owner-death recovery; ambiguous identity `needs_human` |
| P0 | Controller death has no recovery policy | `SIGKILL` cannot run in-process cleanup; `active.json`/process name alone do not prove worker ownership | Unattended parallel work could leave orphan groups or kill the wrong process | Same WorkerLease slice: verify identity, terminate only the owned group, preserve worktree/evidence |
| P0 | No profile catalog or real binding activation | Queue items carry `worker`/optional `model`; selection is not proof an endpoint/account is active | Routing would choose a label without a measured activation result | Secret-free `ProfileCatalog` + adapter activation result before dispatch |
| P0 | No fixed hierarchical admission | Queue items are dispatched one at a time; intra-item waves lack shared caps | Enabling parallel dispatch would multiply local maxima into an unbounded burst | Fixed conjunctive admission for queue items + Plan ready waves; unknown profile starts at one probe |
| P2 | Windows process-tree ownership is absent | Runtime group semantics are proven on macOS only; no Job Object provider | Windows parity cannot be claimed | Windows Job Object `ProcessOwnerProvider` after WorkerLease/profile/fixed admission |
| P2 | Routing scores have no measured telemetry | No provider-reported cost, quota or stable telemetry history exists | Dynamic scoring would optimize unmeasured labels | Deterministic scoring only after activation, fixed admission and measured telemetry |
| P1 | Task estimates are static heuristics rather than telemetry | Estimated L tasks `$8 / 6–15 min`; real attempts exhausted `$10` or `$5` guards and several tasks needed continuation | Misleading budget/time expectations and poor admission inputs | [task-estimation-v1.md](../design/task-estimation-v1.md): LLM supplies complexity signals, controller calculates calibrated ranges |
| P0 | Attempt maximum cannot be changed through an audited command | During recovery, `maxAttempts` was manually changed from 3 to 4 in `.cliyard/queue.json` | Operator recovery bypasses a first-class control-plane path | audited `extend-attempts` command |
| P1 | Provider session restarts are not first-class UI state | One queue attempt moved to a new worker session id and appended to the same task event file | Requires inspecting raw JSONL to understand whether the worker revived | session-generation events and aggregate status |
| P1 | `queue run --json` is terminal-only | It emits the final summary after dispatch finishes | External monitor cannot incrementally observe a long dispatch | event journal and/or streaming status |
| P1 | No foreground controller heartbeat exists yet | Only Supervisor and worker heartbeats exist during an active run | Idle controller, dead controller and blocked controller are indistinguishable | controller lock + heartbeat/status file |
| P1 | Controller auto-retry policy is undefined | Queue currently blocks provider/worker failures for explicit retry | Safe automation is impossible without classification | Taxonomy implemented; automatic retry still gated on an audited attempt policy |
| P2 | Worker events are advisory and lack retention | Append-only diagnostic files are useful but can grow indefinitely | Long-run operational cost and forensic noise | bounded event schema; deferred rotation/GC |
| P2 | Actual provider cost is unavailable | Only the configured budget cap and a separate probe cost were observed | Cost estimation remains approximate | Partially closed: four-state `CostTruth` with `cli-estimated`/`usage-only`/`unavailable`; no provider-reported source or DeepSeek bill yet |
| P2 | Tests are local single runs | No CI, flake-rate or multi-hour soak exists | Cannot claim unattended stability | focused soak then CI/nightly |
| P2 | Queue supports one linear Plan dependency | Multi-parent integration remains unimplemented | Branches cannot be composed automatically | separate integration-envelope/merge-queue design |
| P2 | Artifacts and attempts accumulate | No queue history/event/artifact GC exists | Long-running disk usage is unbounded | retention policy after event volume is measured |
| P3 | Cross-platform/process lifecycle remains uneven | Runtime group semantics are proven on macOS; Windows parity is absent | Controller portability is unproven | separate platform verification |

## Non-negotiable safety rules

- Progress, heartbeats, controller state and queue events never grant
  acceptance.
- RunManifest remains task authority; queue remains dispatch coordination.
- A blocked/interrupted RunManifest is historical truth. Manual adoption writes
  a separate versioned `OperatorResolution`; it never rewrites the run, marks
  its tasks accepted, or pretends the worker succeeded.
- Verifier rejection always requires inspection, repair or explicit retry.
- Automatic retry must be narrower than the queue's generic retry action and
  must have a reason code, attempt bound and audit record.
- No automatic Plan approval, contract freeze, merge to `main` or push.
- No daemon or 24-hour unattended claim before the controller and bounded soak
  are measured.

## Definition of ready for the controller

The controller slice is ready to start when:

1. `queue status --json` can explain the current item without manual file
   joining. **Implemented.**
2. Infrastructure failure, verifier rejection and policy blocking have distinct
   reason codes. **Implemented** as the ten-category, eight-stage
   `FailureRecord`; policy blocks use `policy_blocked` with a bounded code.
3. Operator-driven attempt extension is audited and does not dispatch by
   itself. **Not implemented.**
4. The monitoring projection is demonstrably read-only. **Implemented.**
5. The existing suite remains green. **Implemented** at **371/371**
   (2026-10-28, HEAD `ce1157a`).
6. A durable `WorkerLease` is persisted at spawn, and exact-identity
   owner-death recovery is measured, including `needs_human` for ambiguous
   ownership. **Not implemented; next prerequisite.**
7. A secret-free `ProfileCatalog` and real endpoint/account binding activation
   are measured. **Not implemented.**
8. Execution routing can select CLI and model separately from current
   endpoint/model/runtime capability and availability. **Not implemented.**
9. Fixed hierarchical admission bounds multiple queue items and intra-item
   ready waves; an unknown profile starts at one in-flight probe.
   **Not implemented.**
10. Admission combines host/provider/runtime capacity and explains the binding
    limit; the warm-start value 3 is not hardcoded as a permanent cap.
    **Not implemented.**
11. Queue manual adoption closes a reviewed blocked item without rewriting the
    source RunManifest or accepting its tasks. **Implemented.**
12. Windows Job Object parity and dynamic scoring are not controller-start
    prerequisites, but neither may be represented as done. **Not implemented.**

Conditions 1, 2, 4, 5 and 11 are met. Conditions 3 and 6-10 and 12 remain
open; the controller is not ready to start. Parallel work must not begin
before conditions 6-10 are measured.

# Next Step: Observability Before Foreground Controller

> Recorded: 2026-10-27
>
> Baseline: `3065ad9` / `selfhost/chained-read-context-complete`

## Decision

The next capability is still a **foreground long-run controller**, not an
unbounded autonomous agent and not yet a production daemon.

However, the controller should not be the first edit. The self-hosting runs
showed that the control plane needs a stronger read-only operational view and
machine-readable failure classification first. Without those, a controller
would repeatedly poll durable state but still require a human to manually join
queue items, RunManifests, worker events, provider sessions, attempt limits and
block reasons.

The implementation order is therefore:

```text
queue observe / status
  -> worker failure taxonomy
  -> audited attempt-policy recovery
  -> foreground queue controller
  -> bounded long-run soak
  -> daemon/launchd/systemd decision
```

The controller is an event-loop over durable files. It must rehydrate from
disk on every cycle and must not depend on an LLM's context staying alive.
Queue JSON and RunManifest remain the authorities; controller state, progress,
events and heartbeats are observational.

## Immediate next slices

### 1. `queue-observe-v0` (P0)

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

Capture a bounded, secret-free failure class in worker/run evidence:

```text
budget_exhausted
timeout
provider_transient
provider_auth
provider_protocol
worker_process_exit
verifier_rejected
policy_blocked
unknown
```

The adapter must preserve the provider's final bounded error text when one is
available. A provider process disappearing near a budget boundary must not
remain indistinguishable from a verifier rejection or a model-quality failure.

### 4. Audited attempt-policy recovery (P1)

Add an explicit operator command rather than hand-editing `.cliyard/queue.json`:

```bash
cliyard queue extend-attempts <id> --to <n> --reason <text>
```

It should persist who/what changed the policy, old/new values, timestamp and
reason, while still requiring `queue retry` before another dispatch.

### 5. `foreground-controller-v0` (P1)

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

V0 should not auto-retry verifier rejections. Automatic retry is introduced
only after the failure taxonomy can prove an infrastructure failure and only
within an explicit attempt policy.

### 6. Long-run verification

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
| P0 | Provider failures are not machine-classified | Three documentation attempts ended after several minutes with only `worker failed`; no final `is_error` or budget classification was retained | Cannot distinguish budget, network, provider protocol or worker failure automatically | failure taxonomy + bounded final provider detail |
| P0 | The default `$5` budget limit was discovered by repeated provider exits | The same docs task completed only after increasing budget to `$12` | Wasted attempts/time and nearly exhausted queue retry budget | expose configured budget in status; classify budget exhaustion |
| P0 | Attempt maximum cannot be changed through an audited command | During recovery, `maxAttempts` was manually changed from 3 to 4 in `.cliyard/queue.json` | Operator recovery bypasses a first-class control-plane path | audited `extend-attempts` command |
| P1 | Provider session restarts are not first-class UI state | One queue attempt moved to a new worker session id and appended to the same task event file | Requires inspecting raw JSONL to understand whether the worker revived | session-generation events and aggregate status |
| P1 | `queue run --json` is terminal-only | It emits the final summary after dispatch finishes | External monitor cannot incrementally observe a long dispatch | event journal and/or streaming status |
| P1 | No foreground controller heartbeat exists yet | Only Supervisor and worker heartbeats exist during an active run | Idle controller, dead controller and blocked controller are indistinguishable | controller lock + heartbeat/status file |
| P1 | Controller auto-retry policy is undefined | Queue currently blocks provider/worker failures for explicit retry | Safe automation is impossible without classification | explicit infrastructure-only retry policy |
| P2 | Worker events are advisory and lack retention | Append-only diagnostic files are useful but can grow indefinitely | Long-run operational cost and forensic noise | bounded event schema; deferred rotation/GC |
| P2 | Actual provider cost is unavailable | Only the configured budget cap and a separate probe cost were observed | Cost estimation remains approximate | provider-reported usage when available |
| P2 | Tests are local single runs | No CI, flake-rate or multi-hour soak exists | Cannot claim unattended stability | focused soak then CI/nightly |
| P2 | Queue supports one linear Plan dependency | Multi-parent integration remains unimplemented | Branches cannot be composed automatically | separate integration-envelope/merge-queue design |
| P2 | Artifacts and attempts accumulate | No queue history/event/artifact GC exists | Long-running disk usage is unbounded | retention policy after event volume is measured |
| P3 | Cross-platform/process lifecycle remains uneven | Runtime group semantics are proven on macOS; Windows parity is absent | Controller portability is unproven | separate platform verification |

## Non-negotiable safety rules

- Progress, heartbeats, controller state and queue events never grant
  acceptance.
- RunManifest remains task authority; queue remains dispatch coordination.
- Verifier rejection always requires inspection, repair or explicit retry.
- Automatic retry must be narrower than the queue's generic retry action and
  must have a reason code, attempt bound and audit record.
- No automatic Plan approval, contract freeze, merge to `main` or push.
- No daemon or 24-hour unattended claim before the controller and bounded soak
  are measured.

## Definition of ready for the controller

The controller slice is ready to start when:

1. `queue status --json` can explain the current item without manual file
   joining.
2. Infrastructure failure, verifier rejection and policy blocking have distinct
   reason codes.
3. Operator-driven attempt extension is audited and does not dispatch by
   itself.
4. The monitoring projection is demonstrably read-only.
5. The existing 240-test suite remains green.

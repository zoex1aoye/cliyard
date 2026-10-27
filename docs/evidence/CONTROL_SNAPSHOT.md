# Control Snapshot, Queue Event Journal and Resource Snapshot v0

> Date: 2026-10-27
>
> Scope: read-only queue observation and non-authoritative capacity evidence

## 1. Implemented

### Read-only control snapshot

```bash
cliyard queue status --repo <repo> [--json]
```

The projection joins:

```text
QueueItem
  + Plan / contracts / materialization lineage
  + latest RunManifest and task states
  + latest worker progress event per task
  + queue and supervisor lock ownership
  + bounded queue audit events
  + host resource sample
  + unresolved execution-profile capacity
```

Each item exposes its durable status, readiness, observed next action, attempt
count, retryability, decision category, run identity, task counts, worker
session and stale indicator. Missing RunManifests, malformed worker events and
journal damage are reported as degraded evidence.

`queue status` is strictly read-only. It never reconciles a stale item,
reclaims a lock, appends an event, changes a RunManifest or grants acceptance.

### Queue event journal

Queue lifecycle observations append one JSON object per line to:

```text
<repo>/.cliyard/queue-events/events.jsonl
```

Current event types include item add/retry/cancel/reconcile, Plan
materialization, attempt/run start, provider session start/end, run
completed/blocked and reserved controller lifecycle records. Text fields are
bounded. Writes are best-effort after durable queue authority has been saved,
so a journal failure cannot make a successful queue mutation appear
ambiguous.

The journal is audit/observation only. It is not contract authority, run
authority or acceptance evidence.

### Resource and provider snapshot

The snapshot includes CPU count/load, conservative free-memory estimates,
memory-pressure state, active task attempts and per-worker/model in-flight
observations. Unmeasured values stay `null`/`unknown`; missing data is never
treated as free capacity.

Provider capacity is keyed by an unresolved runtime/model binding until a real
`ExecutionProfile` supplies endpoint/account provenance. For every unresolved
binding:

```text
configuredMax       = null
learnedSafeInFlight = null
quota               = unknown
balance             = unknown
pricing             = unknown
```

No public nominal concurrency, price or balance is filled in from a model
name. The scheduler warm start `3`, if used later, is a demand budget rather
than a provider permit. An unknown binding starts with one in-flight probe and
can grow only from runtime observations and provider feedback.

## 2. Measured verification

Commands run on 2026-10-27 from the cliyard root:

```bash
npm run build
npx tsx --test tests/queue-control-snapshot.test.ts
npm test
npm run dev -- queue status --repo . --json
```

Observed results:

```text
build:                         exit 0
queue-control focused:         5/5 pass in 532.4 ms
queue-control stress:          20/20 consecutive runs pass
full suite run 1:              245/245 pass in 12714.5 ms
full suite run 2:              245/245 pass in 12842.7 ms
full suite run 3:              245/245 pass in 12601.6 ms
live queue status:             exit 0, 3 completed historical items
live queue lock:               free
live provider capacity:        configuredMax=null, learnedSafeInFlight=null
live provider quota/balance:   unknown
```

The focused tests prove:

- an empty repository remains unmodified by `queue status`;
- queue, contracts lineage, RunManifest/tasks and latest valid worker progress
  are joined without changing queue or journal bytes;
- a `running` item with no live queue lock is surfaced as an infrastructure
  decision, not mistaken for healthy progress;
- missing manifests and malformed journal lines produce visible damage while
  the command still returns a read-only snapshot;
- add/dispatch/block/retry/cancel append lifecycle events;
- provider `session.start`, `result` and `error` progress append provider
  lifecycle events;
- unresolved provider capacity, quota, balance and pricing remain unknown.

One earlier full-suite run on the same final code reported one failure, but the
captured console was truncated before the failing case and the focused suite
immediately passed 20 consecutive runs. Three subsequent full runs passed
245/245. This is local evidence, not a flake-free or CI claim.

## 3. Limits

- `queue status` is a CLI projection, not yet the versioned local Control API
  or event stream.
- There is no controller lock/heartbeat or look-ahead controller in this slice.
- Failure taxonomy and cost truth are not implemented. Decision categories in
  the snapshot are explicitly read-only display heuristics until a durable
  reason code exists.
- The portable resource sampler does not measure memory pressure, swap,
  active runtime services, browsers or leased ports. Those remain unknown.
- The journal is append-only with bounded fields but no retention/rotation.
- Provider capacity learning, admission decisions and dynamic concurrency are
  not implemented.
- The queue remains sequential; intra-item ready waves still need a shared
  global admission broker.

## 4. Next

The next ordered slice is durable worker-failure taxonomy plus cost truth:
distinguish budget exhaustion, timeout, transient provider failure, auth,
protocol failure, worker exit, verifier rejection, policy block, resource
exhaustion and unknown; preserve bounded provider detail and per-profile
reported/estimated/missing cost.

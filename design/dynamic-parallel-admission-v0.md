# Dynamic Parallel Admission v0

> Date: 2026-10-27
>
> Scope: bounded, adaptive concurrency across queue-item and Plan-task levels
>
> Implementation note (2026-10-27): the read-only host/provider snapshot and
> unresolved-binding representation exist in
> `src/runtime/resource-snapshot.ts`; the admission broker, learned provider
> permits and dynamic ramp are not implemented.

## 1. Goal

Replace the implicit constant concurrency budget with a deterministic admission
controller that chooses how many task attempts may run at once from:

- available CPU and RAM;
- runtime/build/browser working sets;
- runtime-observed provider concurrency and health;
- account/subscription quota, balance, price and retry feedback;
- per-item, per-runtime and global policy;
- current queue demand;
- budget and latency targets.

The initial value `3` is a scheduler demand warm start, not a permanent
product constant and not a provider concurrency assumption. The selected
concurrency must be observable, explainable, recoverable and adjustable
without editing code.

## 2. Measured local baseline

Measured on the development Mac during design review:

```text
logical CPUs:       10
physical CPUs:      10
RAM:                16 GiB
memory free:        ~69% at sample time
load average:       1.62 / 1.59 / 1.61
swap usage:         0 at sample time
```

The machine currently runs Codex desktop, DSH desktop, browser/music clients and
other applications. These were not all idle, so raw free RAM is not a sufficient
capacity signal.

An earlier documentation snapshot listed nominal model concurrency:

```text
deepseek-flash: 2500
deepseek-v4-pro: 500
```

Those numbers are not runtime capacity. They can change by subscription,
account, endpoint, region, model and time; the control plane may also be used
with providers that publish no concurrency figure at all. They must never be
compiled into admission logic or treated as permission to dispatch. On the
current single host, process memory, builds, browsers, disk I/O and CPU bursts
are still independent constraints.

## 3. Hierarchical capacity

Scheduling has three scopes:

```text
global host/provider budget
  -> queue item / branch budget
       -> Plan task ready-wave budget
            -> runtime/port/browser budget
```

A task may start only when it has admitted tokens from every applicable scope.
Limits are conjunctive, never multiplicative:

```text
effective =
  min(
    maxParallelItems,
    maxParallelTasksGlobal,
    maxParallelTasksPerItem,
    executionProfileCapacity,
    providerCapacity,
    runtimeCapacity,
    memoryCapacity,
    cpuCapacity,
    visualCapacity,
    portCapacity,
    budgetCapacity,
    userHardLimit
  )
```

For example, `3 items x 3 tasks per item` must still be bounded by one global
task/profile/resource budget.

## 4. Resource model

### 4.1 Host snapshot

Persist a versioned, non-authoritative sample:

```ts
interface ResourceSnapshot {
  version: 1;
  at: string;
  host: string;
  cpu: {
    logicalCpus: number;
    load1: number;
    load5: number;
    load15: number;
    processCpuPercent?: number;
  };
  memory: {
    totalBytes: number;
    availableBytesEstimate: number;
    pressure: "normal" | "warning" | "critical" | "unknown";
    swapUsedBytes?: number;
    swapDeltaBytes?: number;
  };
  runtime: {
    activeTaskAttempts: number | null;
    activeRuntimeServices: number | null;
    activeBrowsers: number | null;
    leasedPorts: number | null;
  };
  provider: Array<{
    executionProfileId: string;
    capacity: {
      configuredMax: number | null;
      learnedSafeInFlight: number | null;
      limitSource:
        | "operator"
        | "provider-reported"
        | "observed"
        | "unknown";
      confidence: "none" | "low" | "medium" | "high";
    };
    observedInFlight: number | null;
    recent429: number | null;
    recentRetryAfterMs: number | null;
    quota: {
      state: "known" | "unknown" | "stale" | "unsupported";
      remaining?: number;
      unit?: string;
      observedAt?: string;
    };
    balance: {
      state: "known" | "unknown" | "stale" | "unsupported";
      remaining?: number;
      currency?: string;
      observedAt?: string;
    };
    pricing: {
      state: "known" | "unknown" | "stale" | "unsupported";
      inputPerMillion?: number;
      outputPerMillion?: number;
      currency?: string;
      observedAt?: string;
    };
  }>;
}
```

Cross-platform acquisition must be behind a host adapter. macOS may use
`sysctl`, `vm_stat`, `memory_pressure` and process sampling; Linux may use
`/proc`, cgroups and PSI. Missing metrics remain `unknown`; they cannot be
treated as free capacity.

### 4.2 Task cost model

Each attempt records:

- execution profile: CLI + endpoint + model;
- task size/capability class;
- peak RSS, CPU time and wall time;
- runtime/build/browser child usage when available;
- provider tokens, cost and request count;
- outcome, 429/5xx/timeout/OOM signals.

Admission initially uses conservative per-profile weights. Historical P90/P95
values gradually replace static weights. Estimates must be keyed by task kind
and execution profile; a documentation task and a full frontend build are not
equivalent.

## 5. Provider/model admission

Provider capacity is an observed token bucket independent of task concurrency:

```text
provider permit = min(
  operator hard limit,                  // null when not configured
  learned safe in-flight count,         // null until observed
  provider-reported remaining capacity, // optional
  rate-limit token state
)
```

Rules:

- capacity, quota, price and balance belong to an execution binding, not to a
  provider brand or model name alone;
- the binding identity includes endpoint/account reference, subscription when
  known, protocol, model and CLI/runtime compatibility;
- `null` means unknown, never unlimited and never a substitute for a public
  documentation number;
- an unobserved binding starts with one in-flight probe, even when the global
  scheduler warm start is greater than one;
- capacity rises only after clean observations; every provider response that
  reports remaining quota or rate-limit state is evidence for that binding;
- pricing and balance are fetched or reported when the adapter supports it;
  otherwise the UI and routing provenance say `unknown`, and cost is never
  synthesized from another subscription or provider;
- a balance or quota that cannot be checked is a routing uncertainty. Policy
  may allow it with an explicit cost cap, but unattended execution must fail
  closed when the task requires a known budget;
- nominal provider concurrency does not override local resource limits;
- 429 and `Retry-After` reduce the active budget immediately;
- transient 5xx and connection failures increase backoff but do not prove that
  concurrency was too high;
- unknown provider health fails closed to the last known safe concurrency;
- one worker task may create multiple provider requests; adapter-level request
  limiting remains required;
- provider concurrency is tracked per `ExecutionProfile`, not per CLI brand
  alone.

## 6. Control loop

Suggested loop:

```text
sample resources every 2-5s
  -> reclaim stale leases
  -> compute hard capacity
  -> compute safe target with hysteresis
  -> admit ready tasks up to target
  -> record AdmissionDecision
```

Task acquisition order:

1. durable queue readiness;
2. DAG/task readiness;
3. item slot;
4. global task slot;
5. execution-profile slot;
6. runtime/browser slot;
7. port lease;
8. attempt checkpoint;
9. dispatch.

All leases are released in `finally` semantics after task verification and
cleanup.

## 7. Adaptive policy

Default state for v0:

```text
schedulerWarmStart = 3
unknownExecutionProfilePermit = 1
minimum = 1
hard max = configurable; initial proposal 6, subject to calibration
auto scale = recommendation first, then enabled after soak
```

The scheduler may have three ready slots while an unknown provider binding has
only one permit. These are separate limits and are combined conjunctively.

### Increase

Increase the desired target by one only after a stable window:

- no 429/5xx spike;
- no memory warning or swap increase;
- load and active CPU remain below the safety band;
- recent task latency is not degraded;
- at least N completed attempts at the current level;
- cooldown has elapsed.

### Decrease

Decrease immediately when:

- provider returns 429/Retry-After;
- memory pressure becomes warning/critical;
- swap grows materially;
- OOM or service startup failure suggests resource exhaustion;
- per-core load stays above the critical band;
- latency or queue wait doubles without model-side cause.

Use additive increase and multiplicative decrease with cooldowns to avoid
oscillation. Scaling must never cancel accepted work or discard attempts.

## 8. Admission evidence

Persist every decision:

```ts
interface AdmissionDecision {
  version: 1;
  at: string;
  itemId: string;
  taskId: string;
  executionProfileId: string;
  admitted: boolean;
  effectiveLimit: number;
  activeBefore: number;
  constraints: Record<string, number | string | null>;
  reason: string;
  resourceSnapshotId: string;
}
```

The projection must answer:

- why a task is waiting;
- which limit is binding;
- whether the system is ramping, cooling down or fixed;
- current provider/local headroom;
- historical resource use of similar tasks.

Admission evidence is not acceptance evidence.

## 9. Calibration through cliyard itself

The next self-host iteration should use the tool to measure its own capacity:

1. run controlled fake/short tasks at fixed concurrency 3;
2. capture CPU, RSS, swap, provider requests/429 and runtime usage;
3. ramp to 4, 5 and 6 only through the audited policy after stable windows;
4. run at least one real Claude Code + DeepSeek batch;
5. record which limit binds first;
6. set host/profile defaults from measured evidence;
7. ensure a restart rehydrates the last safe concurrency and does not start at
   an unsafe peak.

This is controlled calibration, not an intentional overload test.

## 10. Acceptance

1. Current `3` remains the default scheduler warm start until calibration
   evidence exists; it is never used as a provider subscription assumption.
2. Concurrency is selected by a shared broker and cannot be multiplied by
   independent Supervisor processes.
3. Queue-item and Plan-wave limits are enforced together.
4. Provider/profile limits, unknown quota/balance/price, CPU, RAM, runtime and
   port limits are visible and explain the binding constraint.
5. 429 or memory pressure reduces concurrency without losing durable work.
6. CPU/RAM headroom allows a measured ramp above 3 after the stable window.
7. A restart restores policy and last safe target from disk.
8. The UI explains the binding limit and next scale decision.
9. Fixed manual concurrency remains available as a deterministic override.
10. No unlimited-concurrency or 24-hour claim follows from a short calibration.

## 11. Non-goals

- intentionally oversubscribing the host to discover failure;
- treating advertised provider concurrency as available local capacity;
- treating a public price, quota or concurrency figure as current permission
  for an unknown subscription;
- dynamic concurrency based only on instantaneous free RAM;
- scaling through worker cancellation or attempt loss;
- automatic merge of parallel accepted branches;
- cross-host resource pooling;
- daemon/24-hour claims before this controller survives bounded soak.

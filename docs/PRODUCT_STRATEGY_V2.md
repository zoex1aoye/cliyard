# Product Strategy v2: Parallel Delivery, Execution Routing and Replaceable Entry

> Recorded: 2026-10-27
>
> Baseline: `selfhost/chained-read-context-complete`

## 1. Revised definition

Key Mind / cliyard is not an agent terminal multiplexer and not a chat GUI.

> **Key Mind / cliyard is a model- and CLI-neutral, design-driven parallel
> delivery control plane.** It turns versioned design intent into approved
> contracts, routes each ready task to an available and suitable CLI + model
> execution profile, runs independent branches in isolated workspaces, and
> accepts only independently verified evidence before human integration.

Chinese:

> **Key Mind / cliyard 是模型与 CLI 中立的、设计驱动的并行交付控制面。**
> 它把版本化设计编译成可执行契约，为每个 ready task 选择当前可用且合适的
> CLI + 模型执行组合，在隔离工作区并行执行，并以独立证据和人工裁决接入项目。

The queue and controller are implementation mechanisms. The product value is:

```text
human design authority
  -> parallel project delivery
  -> independent evidence
  -> human-controlled integration
```

## 2. User starting point

The original practical pain was not "we need more autonomous agents." It was:

```text
several terminals
  -> several branches/worktrees
  -> repeated context reconstruction
  -> manual switching between development lines
  -> low effective throughput
```

Therefore parallel dispatch is not a later optimization. It is a first-class
product requirement. The target is not unlimited concurrency; it is enough
parallelism to remove terminal-tab management while preserving isolation,
resource safety, lineage and human review.

## 3. Four control-plane problems

### 3.1 Design authority

The control plane must preserve:

```text
designRevision
  -> approved Plan hash
  -> frozen TaskContract hash
  -> baseCommit
  -> run / attempt
  -> evidence
  -> verdict
  -> integrationHead
```

Chat history and provider sessions are not project authority.

### 3.2 Execution routing

A queue item must not assume one fixed worker/model pair. Routing must support
three real deployment shapes.

#### Shape A: one subscription/API exposes many models and several CLIs can use it

```text
models M = {m1, m2, ...}
CLIs C = {claude-code, codex, opencode, ...}
bindings = feasible combinations from M x C
```

The router may choose both CLI and model.

#### Shape B: one subscription/API exposes many models but only one CLI can use it

```text
CLI = fixed
models = {fast, reasoning, long-context, vision, ...}
```

The router chooses the model inside the available runtime.

#### Shape C: only one model is available, but several CLIs can be configured with it

```text
model = fixed
CLIs = {claude-code, codex, opencode, ...}
```

The router chooses the runtime by protocol compatibility, tool use, context
handling, reliability, observed pass rate, cost and concurrency.

### 3.3 Admission and parallel execution

Ready work may run concurrently only after deterministic admission:

- independent base/dependency;
- non-overlapping write scope;
- available CLI + model execution profile;
- observed provider/model rate-limit, quota and balance budget;
- CPU/memory/runtime slot;
- isolated port/runtime lease;
- no conflicting shared resource;
- attempt/budget policy.

Dependent Plan items remain serialized by their upstream `integrationHead`.
Parallel queue items open separate integration lines; they do not merge into
one another without an explicit integration decision.

Parallelism is hierarchical. Multiple branches may run together, and within one
branch's Plan, independent tasks may also run together:

```text
workspace
  -> queue items / branches                 (inter-item parallelism)
       -> Plan task DAG ready wave           (intra-item parallelism)
            -> worker-internal subagents     (worker-owned, optional)
```

### 3.4 Evidence and adjudication

Worker completion is not acceptance. Evidence must come from the exact result
snapshot and include the required build, runtime, browser, visual, a11y and
artifact checks. The final merge remains a human/integration-queue decision.

## 4. Execution model

### 4.1 Core objects

Proposed routing model:

```ts
interface ProviderEndpoint {
  id: string;
  protocol: "anthropic" | "openai" | "openai-compatible" | "acp" | string;
  baseUrl?: string;
  authRef: string;             // env/Keychain reference, never the secret
  accountBindingId: string;    // distinguishes subscriptions/accounts
  models: ModelDescriptor[];
  quota: QuotaState;           // known/unknown/stale/unsupported
  balance: BalanceState;
  rateLimit: RateLimitState;
  health: EndpointHealth;
}

interface WorkerRuntime {
  id: "claude-code" | "codex" | "opencode" | "qwen-code" | string;
  supportedProtocols: string[];
  capabilities: WorkerCapabilities;
  availability: RuntimeAvailability;
}

interface ExecutionProfile {
  id: string;
  runtimeId: WorkerRuntime["id"];
  endpointId: ProviderEndpoint["id"];
  modelId: string;
  flags?: Record<string, string | number | boolean>;
  admissionPolicy?: {
    operatorHardMax?: number;  // absent means unknown, not unlimited
    unknownBindingProbe?: number;
  };
  budgetPolicy?: BudgetPolicy;
}

interface TaskRequirements {
  contextTokens?: number;
  vision?: boolean;
  structuredTools?: boolean;
  codeScale?: "small" | "medium" | "large";
  reasoning?: "low" | "medium" | "high";
  latencyPreference?: "fast" | "balanced" | "quality";
  costCeiling?: number;
  requiredCapabilities?: string[];
}
```

`QueueItem` should eventually store a routing policy and the resolved
`ExecutionProfile`, not just `worker` plus `model`.

Provider capacity, balance, quota and price are observed per execution binding
(`endpoint/account binding + model + compatible CLI`). A public documentation
number or another subscription's configuration is never evidence of current
permission. Unknown values remain explicit, and an unknown binding gets one
in-flight probe before any learned ramp.

### 4.2 Deterministic routing

Routing should be deterministic control-plane logic:

```text
TaskRequirements
  + approved Contract
  + current health/quota/concurrency
  -> reject infeasible profiles
  -> score feasible profiles
  -> persist selected profile and rationale
  -> dispatch
```

The router may ask an LLM for a recommendation, but the persisted decision must
be mechanically checked and reproducible. The selected profile, rejected hard
constraints, estimated cost and actual reported usage become run provenance.

Suggested scoring dimensions:

- hard capability fit;
- observed task-type pass rate;
- context fit;
- provider/model health and rate limit;
- concurrency availability;
- measured cost and latency;
- user preference and policy;
- fallback order.

## 5. Parallel queue v0 requirement

Current queue and Supervisor are effectively sequential:

- one repo-global Supervisor lock;
- one active run pointer;
- one queue dispatch at a time.

Parallel queue v0 therefore requires an explicit architecture change, not
merely launching `runQueue` multiple times.

### 5.1 Required semantics

- dispatch up to `maxParallelItems`;
- allow multiple `running` queue items;
- each item has its own run id, worktree, integration branch and evidence;
- queue state mutations use short locks; long worker execution does not hold
  the queue lock;
- dependent Plan items wait for the required upstream accepted head;
- independent items never share a mutable workspace;
- blocked/failed items do not stop unrelated ready work automatically;
- no automatic merge between parallel successful items.

### 5.2 Supervisor lock decision required

Two possible implementations:

| Option | Description | Tradeoff |
|---|---|---|
| Per-item isolated control clone | each queue item gets a clone/rebased workspace and its own supervisor | strongest isolation, more disk/network/copy cost |
| Per-run Supervisor ownership | replace repo-global lock with run-level locks + short Git-control locks | less duplication, but requires careful ref/worktree concurrency and active-run model changes |

This must be a design spike before implementation. Do not remove the global
Supervisor lock opportunistically.

### 5.3 Parallel acceptance

At minimum:

1. three independent queue items execute concurrently;
2. each has a distinct branch, worktree, run id, event stream and runtime port;
3. `maxParallelItems` is enforced;
4. provider/model concurrency and runtime slots are independently bounded;
5. one blocked item does not corrupt or silently block independent items;
6. no accepted branch is auto-merged into another branch;
7. crash recovery can reconcile every `running` item independently;
8. the UI shows lanes/slots instead of pretending there is one global run.

### 5.4 Intra-branch task parallelism

The current scheduler already has a partial implementation:

- `readyIds` derives the currently runnable DAG nodes;
- every ready wave is dispatched with `Promise.all`;
- task worktrees in one wave start from the same integration head;
- accepted wave results are snapshotted and merged into the integration
  worktree sequentially;
- failed tasks retain attempt metadata while independent siblings may still be
  accepted;
- `continuous-batch` tests already prove `foundation -> left/right -> upper`.

This is the correct execution primitive, but it is not yet a complete product
capability because:

- all ready tasks are launched without a first-class task concurrency cap;
- the Claude adapter has a process-local concurrency limit, but there is no
  shared scheduler across queue items;
- provider/model limits, runtime slots and task slots are not one admission
  model;
- queue/UI status does not clearly represent branch wave, task slots and
  sibling outcomes;
- write-path overlap is rejected instead of being resolved by a merge envelope;
- worker-internal subagent parallelism is delegated to the harness and is not
  controlled by cliyard.

#### Recommended Plan shape for v0

Keep the Plan flat and express hierarchy with dependencies and optional
`moduleId`/`scope` metadata:

```text
module-a-foundation
  -> module-a-ui
  -> module-a-api

module-b-foundation
  -> module-b-ui
  -> module-b-api
```

`module-a-ui` and `module-a-api` can run in the same ready wave if their write
paths are disjoint. Module A and module B may also run in the same wave. This
avoids a nested Plan schema while preserving module-level ownership.

If tasks in one module must modify the same files, they must be serialized in
v0. The current Plan compiler is stricter than necessary: it rejects every
write-path overlap across the whole Plan, even when the tasks have an explicit
dependency order and can never share a ready wave. The target rule is:

```text
overlap + no transitive dependency -> reject (cannot isolate safely)
overlap + transitive dependency    -> serialize in dependency order
no overlap                         -> eligible for the same ready wave
```

Parallel overlapping patches still require a future integration-envelope or
merge-queue design. The compiler change must be tested against diamonds and
transitive dependency cases so it cannot accidentally admit concurrent unsafe
writers.

#### Hierarchical admission

Every task attempt must acquire all applicable slots:

```text
queue-item slot
task slot (per item and global)
execution-profile slot (CLI + endpoint + model)
runtime slot
port lease
optional browser/visual slot
```

The scheduler must not multiply independent limits accidentally. For example,
`maxParallelItems=3` and `maxParallelTasksPerItem=3` must not create an
unbounded nine-worker burst; a global task/profile/runtime limit still applies.

Candidate limits:

```text
maxParallelItems
maxParallelTasksPerItem
maxParallelTasksGlobal
maxParallelRuntimes
maxParallelVisualChecks
maxConcurrentByExecutionProfile
```

#### Intra-branch acceptance

1. one queue item with a four-task DAG dispatches only its current ready wave;
2. two independent tasks execute concurrently within the configured task cap;
3. two queue items execute concurrently and obey the global task/profile cap;
4. integration merges are deterministic and sequential within each item;
5. sibling failure does not erase an accepted sibling's evidence;
6. a blocked dependent task never runs, while unrelated ready work may proceed;
7. rate-limit, runtime and port admission are global, not per-supervisor silos;
8. crash recovery reconstructs every item/task wave independently.

### 5.5 Dynamic capacity and provider feedback

Parallelism is selected by one admission broker from host CPU/RAM pressure,
runtime/browser slots, queue-item/task scope, observed provider/model
capacity and budget. The scheduler default `3` is a demand warm start, not a
provider permit and not a permanent limit.

Use:

```text
warm start = 3
unknown execution binding permit = 1
minimum = 1
hard max = configurable and calibrated
policy = additive ramp / multiplicative backoff with cooldowns
```

Provider capacity, quota, balance and price are per execution binding: account
or subscription, endpoint, model and CLI compatibility. Public documentation
figures are historical references, not current permission. Unknown values stay
unknown and begin with one in-flight probe. A 10-core/16 GiB host also has its
own independent CPU, memory, runtime, browser and port limits; observed 429,
`Retry-After`, quota headers and balance responses reduce the provider's learned
safe in-flight count immediately.

See
[dynamic-parallel-admission-v0.md](../design/dynamic-parallel-admission-v0.md)
for the resource model, admission decision record and calibration protocol.

## 6. Entry strategy: Control API first, UI second

DSH is currently an MVP shell, not the product boundary. If DSH stops
maintaining a compatible plugin API, cliyard must continue to work.

### 6.1 Stable entry layers

```text
CLI
  -> stable local Control API / SDK
       -> DSH plugin
       -> self-owned Web UI
       -> Paseo/other UI adapter
```

The first stable interface should be a local, read-mostly API:

```text
GET  /v1/projects
GET  /v1/status
GET  /v1/items/:id
GET  /v1/runs/:id
GET  /v1/evidence/:id
GET  /v1/events             (SSE or NDJSON)
POST /v1/actions/...        (explicit human actions only)
```

All DTOs must be versioned and independent of DSH/Cordis.

### 6.2 UI decision

Do not choose DSH as the only UI and do not build a full IDE.

Recommended sequence:

1. CLI + JSON status remains fully functional.
2. A local Control API exposes the unified project/queue/run/evidence view.
3. DSH `dsh-cliyard` becomes a thin Control API client, initially registered
   as a `dsh-better-sidebar` tab.
4. Add a minimal self-owned browser UI for the same read-only views and
   essential human actions.
5. If desktop integration is later required, wrap the same web UI with Tauri
   or Electron; do not make the desktop shell the authority.

The self-owned UI is a **minimal control/observer surface**, not an editor,
terminal or generic chat client.

### 6.3 Why not a DSH-only plugin

- DSH is developer preview and may change plugin APIs.
- Cordis internals and host routes can drift.
- A GUI-only entry makes automation and recovery dependent on the GUI.
- Cliyard needs a client-neutral event/status contract for Paseo or another UI.

### 6.4 Why not immediately build a full own UI

- Multi-agent boards, file editors, diff viewers and terminals already exist.
- UI breadth is not the current differentiation.
- The control API and evidence model should stabilize before a custom UI.

### 6.5 Concrete v0 selection

- **Backend/API:** Node.js + TypeScript, reusing the existing cliyard control
  plane, with a loopback-only HTTP API and JSON/SSE event stream.
- **CLI:** first-class and always usable; it must not depend on the UI server.
- **First cockpit:** thin DSH plugin using `dsh-better-sidebar.registerTab`.
- **Fallback Web UI:** React + Vite consuming the same versioned Control API.
  Keep it read-only first, then add explicit human actions.
- **Desktop wrapper:** defer. If tray, notifications or app lifecycle become
  necessary, wrap the same web UI with Tauri or Electron.
- **Do not use a full-stack web framework as the control plane.** The UI is a
  client; task authority remains in cliyard.

This keeps the first cockpit fast while preventing DSH from becoming a hard
dependency.

## 7. Differentiation and build-vs-borrow

### 7.1 Build here

- `DesignRevision` and approval semantics.
- Plan/contract deterministic compilation and provenance.
- CLI/model execution-profile routing.
- parallel admission and dependency/base lineage.
- attempt/lease/recovery policy.
- independent Evidence Bundle and verdict.
- project-level event ledger and human integration gate.

### 7.2 Borrow or integrate

| Need | Existing support to reuse | Decision |
|---|---|---|
| UI shell and sidebar tabs | [DSH `dsh-better-sidebar`](https://github.com/omdsh-dev/DSH-better-sidebar) | use as optional cockpit base |
| Context/token/agent-fleet view | [DSH `dsh-context`](https://github.com/bowenliang123/dsh-context) | deep-link and borrow UX/data-model ideas |
| Ambient master status | [DSH `dsh-pet`](https://github.com/zhu1090093659/dsh-pet) | optional read-only status mirror |
| Account balance/quota widget | [DeepSeek whale widget](https://github.com/MeteorNOX/DeepSeek-Balance-Whale-Widget) | borrow accounting concepts, do not make it task authority |
| Event wakeup/notification | [DSH `dsh-sentinel`](https://github.com/fuhefei/dsh-sentinel) | external event adapter |
| Worktree/diff/PR UI | [`dsh-better-workspaces`](https://github.com/ds-hu/dsh-better-workspaces) or better-sidebar Git | do not rebuild |
| Multi-CLI execution and workflow | Cezar (MIT) | reference; potential integration/adapter |
| Team issue board/daemon | Multica | reference/adapter after license review |
| Multi-agent server/control center | OpenHands Agent Canvas | worker/backend integration option |
| Multi-device daemon/plugin SDK | Paseo | possible alternative shell or runtime |
| Durable multi-host workflow | Temporal / Restate | defer until file state is insufficient |
| Visual/browser/a11y evidence | Playwright / axe-core | direct dependency |
| Spec workflow | Spec Kit / OpenSpec | reference input/template, not control authority |

### 7.3 Do not rebuild

- terminal emulator or PTY manager;
- code editor;
- generic diff viewer;
- Git client UI;
- model SDKs;
- generic agent loop;
- chat UI;
- team issue tracker;
- generic file browser;
- account-wide balance dashboard.

### 7.4 Anti-reinvention checklist

Before implementing a new subsystem, record:

1. Which layer is this: model, worker harness, UI, durable runtime, verification
   primitive or cliyard domain semantic?
2. Name at least two maintained open-source/commercial comparables.
3. Can the capability be reached through SDK, API, MCP, ACP, plugin or CLI JSON?
4. What is the license, release cadence, issue activity and bus factor?
5. What exact domain requirement is still missing after integration?
6. Is the missing part cliyard's differentiation, or merely UI/runtime plumbing?
7. What is the exit strategy if the dependency changes or stops maintenance?
8. What small adapter/conformance test proves the integration?

Default rule:

```text
mature adjacent component
  -> adapter/integration first
  -> narrowly scoped extension second
  -> fork only when extension points cannot satisfy the requirement
  -> build from scratch only for cliyard's domain-specific control semantics
```

Forking a large harness/UI requires an explicit ADR with upstream tracking,
patch ownership, upgrade tests and an exit plan.

## 8. Adjusted next-work order

The earlier "observability -> foreground controller" ordering is too narrow.
The revised execution order is:

```text
1. [implemented] ControlSnapshot + event journal + resource telemetry
2. Failure taxonomy/cost + ExecutionProfile routing
3. Parallel Supervisor/queue architecture spike
4. Shared hierarchical admission broker with fixed limits
5. Parallel queue + Plan-wave v0, warm start 3
6. Measured adaptive ramp/backoff and calibration
7. DSH better-sidebar cockpit + stable Control API client
8. DesignRevision + EvidenceBundle/verdict v0
9. Look-ahead scheduler/foreground controller
10. Bounded soak and process-manager/daemon decision
```

The controller is deliberately late because it automates whatever gates and
scheduling semantics already exist. Automating weak acceptance only creates
faster technical debt.

## 9. Product acceptance effect

The tool is useful when a developer can:

1. define a design revision rather than open several terminal tabs;
2. let cliyard select feasible CLI/model profiles;
3. run independent branches within explicit concurrency/resource limits;
4. inspect every branch's design lineage, attempts, cost and evidence;
5. receive only evidence-backed accepted branches for human integration;
6. close DSH, lose a provider session or restart the host without losing the
   project's design/task/evidence state.

## 10. Non-goals

- unlimited parallel agents;
- automatic merge to `main`;
- one universal subscription or provider assumption;
- hard-coded Claude/DeepSeek as the only execution profile;
- a DSH-only product;
- a full IDE or chat client;
- daemon/24-hour claim before parallel recovery and soak evidence;
- reimplementing mature worker, Git, editor, terminal or board components.

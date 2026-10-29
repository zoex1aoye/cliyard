# Continuous harness v2: from foreground runs to a resumable delivery loop

> Status: approved design direction; executable slices are still separately
> planned, frozen and dispatched.
>
> Recorded: 2026-10-29

## 1. Hypothesis

The remaining bottleneck is not the maximum duration of one model call. Modern
Agent Harnesses can run for a long time, compact context and resume provider
sessions. The missing layer is a **resumable delivery loop** that owns:

- versioned design and Plan intent;
- dependency-aware task admission;
- worker and verifier lifecycles that are independent of chat;
- exact evidence and clean-context review;
- explicit human intervention and integration decisions;
- cold recovery after model, Worker, controller or GUI termination.

One model context is a workbench. Durable project files are the memory. A
controller may exit, compact or be replaced; the next controller must rebuild
the same next action from Plan, contracts, queue, RunManifest, evidence and the
intervention ledger.

## 2. Corrected system boundary

```text
human design authority
  -> versioned Design Pack
  -> reviewed Plan
  -> frozen TaskContracts
  -> durable controller cycle
       -> admission
       -> Worker attempt
       -> background VerificationTask
       -> clean-context review
       -> verdict
       -> human/integration decision
       -> next ready work
```

The controller is an event loop over durable state, not an omnipotent long-lived
chat. Worker, verifier and reviewer are separate execution roles with separate
lifecycles and evidence.

## 3. New durable objects

These are proposed control-plane objects. Naming may change only through a
versioned design and migration; behavior must not be hidden in prompt text.

### VerificationTask

```ts
interface VerificationTask {
  id: string;
  runId: string;
  taskId: string;
  artifactCommit: string;
  contractsHash: string;
  specVersion: number;
  commands: string[];
  runtimeRequirements?: string[];
  status:
    | "queued"
    | "running"
    | "stopping"
    | "succeeded"
    | "failed"
    | "canceled"
    | "lost";
  ownerIdentity?: ProcessIdentity;
  output: { uri: string; offset: number };
  deliveredAt?: string;
  startedAt?: string;
  endedAt?: string;
  lastError?: FailureRecord;
  evidenceRefs: string[];
}
```

Required semantics:

- starts from the exact artifact commit, never a Worker preview;
- survives Worker exit;
- records output offsets and an idempotent delivery latch;
- startup recovery marks uncertain work `lost`/`needs_human`, never `running`
  forever or `succeeded` by inference;
- timeout does not reset when output is read;
- process ownership, port leases, runtime data and browser profiles are explicit;
- stopping a parent session cascades only to exactly owned tasks.

### ReviewFinding

```ts
interface ReviewFinding {
  id: string;
  artifactCommit: string;
  requirementRef: string;
  severity: "blocking" | "should-fix" | "nit";
  problem: string;
  location: { path: string; line?: number };
  reason: string;
  status: "proposed" | "confirmed" | "rejected" | "fixed";
  resolution?: string;
}
```

The reviewer receives only the exact diff, approved requirement and bounded
test/runtime evidence. It does not inherit the author's conversation or
self-assessment. Findings without a location and reason are opinions.

### HarnessEvalRun

```ts
interface HarnessEvalRun {
  id: string;
  baselineId: string;
  candidateId: string;
  fixtureCommit: string;
  modelAndHarness: string;
  repetitions: number;
  metrics: {
    passRate: number;
    flippedTasks: string[];
    requests: number;
    inputTokens: number;
    outputTokens: number;
    cacheHits: number;
    wallMs: number;
    costTruth: string;
    humanInterventions: number;
  };
  decision: "keep" | "revert" | "iterate";
  evidenceRefs: string[];
}
```

Run one change at a time, reread trajectories for flipped tasks and repeat noisy
Agent tasks. A higher average does not excuse a must-not-break failure.

### HumanInterventionEvent

```ts
interface HumanInterventionEvent {
  id: string;
  runId?: string;
  loopId: string;
  role: "retry" | "judge" | "approve" | "carry" | "trigger" | "stand-in";
  reason: string;
  outcome: "unresolved" | "resolved" | "rejected" | "obsolete";
  artifactRef?: string;
  observedAt: string;
}
```

The goal is not zero human input. It is to keep design and irreversible decisions
with humans while turning repeated Retry, Carry, Trigger and mechanical Judge
work into checks, skills, scripts or bounded automation.

### SkillPack

```ts
interface SkillPack {
  id: string;
  version: string;
  digest: string;
  entrypoint: string;
  skills: Array<{ name: string; digest: string; entrypoint: string }>;
  compatibility: { harnesses: string[]; minControlPlaneVersion?: string };
}
```

A run records the SkillPack digest. Updating a skill is a harness change and
needs validation against the eval fixtures before it becomes the default.

### HandoffPacket

At every durable transition the controller can materialize a bounded handoff:
goal, accepted base, decisions, constraints, ruled-out approaches, current
evidence, blockers and exact next action. A fresh controller session reads this
packet and source authorities, then checks that its intended action is still
legal.

## 4. Lifecycle separation

```text
Worker attempt
  -> result/commit or structured failure
  -> verification queued independently
  -> verifier/runtime evidence
  -> clean-context review
  -> verdict
  -> repair, next wave, human decision or block
```

Worker exit is not verification. Verification exit is not review. Review
completion is not integration. Each transition has a distinct owner, timeout,
retry policy and durable record.

The controller must be able to stop between any two arrows and reconstruct the
next legal action from disk.

## 5. Continuity and context

Long-horizon behavior comes from this loop:

1. persist a bounded checkpoint after every state transition;
2. stop or compact a model session before it becomes the only source of truth;
3. start a fresh controller/reviewer session from exact files when drift is
   detected;
4. re-read Git lineage, queue state and evidence before dispatch;
5. carry forward only decisions and the next action, never a transcript.

Compaction is allowed and expected. It is not a recovery mechanism by itself.
The safe recovery source is the durable project state.

## 6. Routing and parallelism remain important, but later

Dynamic CLI/model routing and hierarchical parallelism are still product goals.
They become safe only after verification, review, sandbox and ownership
semantics are stable. A fast scheduler over weak acceptance creates technical
debt faster.

The eventual admission model includes:

- queue-item slot;
- task slot per item and globally;
- execution-profile slot per provider/account/model/CLI binding;
- runtime, port, browser and visual slots;
- host CPU/RAM/disk pressure;
- budget, deadline and continuation policy.

Provider concurrency, quota, balance and price are per activated binding. They
are never inferred from a public nominal limit. Unknown bindings begin with one
in-flight probe. `3` is a warm-start example, not a permanent cap.

## 7. Build, borrow and exit strategy

### Keep as cliyard differentiation

- Design/Plan/Contract lineage;
- deterministic ready-state and dependency semantics;
- execution ownership and recovery;
- independent evidence and verdict;
- human intervention ledger;
- provider-neutral routing and admission;
- human-controlled integration.

### Reuse through adapters

| Need | Reference | Decision |
|---|---|---|
| Background command/task lifecycle | MiniMax Code `local-runtime/background-task` | borrow state machine and recovery invariants; implement in cliyard's persisted model |
| Harness experiments and clean review | MiniMax `mcode-stack` | adopt checklist/eval structure; keep deterministic control-plane records |
| Meta-harness and sandbox SPI | Omnigent | reference interface and policy decomposition; do not make it authority |
| Strong microVM sandbox | Perplexity SPACE | candidate `SandboxProvider` backend; prove through an adapter and conformance tests |
| Self-hosted monitoring | Mission Control | borrow read model/event UX ideas; keep Control API client-neutral |
| Dev-box daemon and service lifecycle | Shipyard | borrow process/service persistence patterns; no UI lock-in |
| Worktree-oriented delivery workflow | Genie, pi-dynamic-workflows | reference end-to-end workflows; preserve cliyard's evidence lineage |
| Long-horizon event isolation and sandboxing | DeerFlow | compare RunEvent isolation and provider admission; no wholesale fork |
| File-based crash recovery | planning-with-files | adopt Plan re-injection and completion-gate ideas where they improve recovery |

Every borrowed component must have a version pin, license record, conformance
test and exit path. Do not fork a large harness to obtain one feature.

## 8. GitHub observations, 2026-10-29

These are current observations, not permanent product claims.

- [MiniMax Code](https://github.com/MiniMax-AI/minimax-code) became public on
  2026-10-28 under a first-party MIT default. It exposes a detailed
  background-task model with owner, output offsets, delivery latch, startup
  recovery and session stop cascades. Its Node 22.19+ source baseline is not a
  reason to change cliyard's Node 20 decision.
- [mcode-stack](https://github.com/MiniMax-AI/mcode-stack) was created on
  2026-10-28. Its most relevant skills are harness experiments, clean-context
  independent review, long-command checks, handoff and lifting loops.
- [Omnigent](https://github.com/omnigent-ai/omnigent) released v0.20.0 on
  2026-10-28 and continues rapid updates. It is an alpha meta-harness with
  policy, multi-harness and sandbox-provider abstractions.
- [Perplexity SPACE](https://github.com/perplexityai/SPACE) is active under
  Apache-2.0. Its HTTP/SSE service exposes Firecracker microVM sandbox,
  command-session and lifecycle operations suitable for adapter comparison.
- [Mission Control](https://github.com/builderz-labs/mission-control) continues
  active updates. It is the closest self-hosted task/review/spend/skills
  monitoring comparison but remains a UI/control-plane overlap rather than the
  design-to-evidence authority.
- [Shipyard](https://github.com/cosscom/shipyard) released v0.3.31 on
  2026-10-27 and updated on 2026-10-28. It demonstrates persistent dev-box
  service/worktree operation after closing a GUI.
- [Genie](https://github.com/automagik-dev/genie) continues wish -> plan ->
  worktree execution -> review -> PR flows. It overlaps delivery workflow, not
  the contract/evidence truth model.
- [pi-dynamic-workflows](https://github.com/QuintinShaw/pi-dynamic-workflows)
  released v3.15.0 on 2026-10-27 with journaled resume, worktrees, routing and
  cost accounting.
- [planning-with-files](https://github.com/OthmanAdi/planning-with-files)
  released v3.26.0 on 2026-10-28 with subagent isolation and repair hooks.
- [DeerFlow](https://github.com/bytedance/deer-flow) remains highly active and
  updated its long-horizon harness around RunEvent isolation, model request
  admission and sandbox/context/subagent boundaries.

No reviewed project currently closes the full cliyard loop. The market is
converging on Agent orchestration, sandbox adapters and monitoring surfaces,
which lowers the value of rebuilding those components and raises the value of
the design-to-evidence contract between them.

## 9. Execution order and exit criteria

### P0: v1.2 cleanup/recovery separation

Exit criteria:

- bounded durable registry;
- complete exact live cleanup can succeed without persistence truncation
  causing rejection;
- truncated durable evidence makes controller recovery `needs_human`;
- real >16-group and 512-member fixtures leave no residual;
- all existing path, lease and process tests remain green.

### P0: Harness Eval v0

Exit criteria:

- pinned fixture repository and at least six end-to-end scenarios;
- repeated baseline/candidate runs;
- pass, flipped-task, request/token/cache/time/cost and human-intervention
  metrics;
- a written decision record for every harness or prompt change.

### P0: Background VerificationTask

Exit criteria:

- Worker can exit while verification continues;
- verification output is incrementally readable;
- startup recovery and stop cascade have real fixtures;
- uncertain tasks become `lost`/`needs_human`;
- no orphan process, port lease or unread result after compaction.

### P0: SandboxProvider

Exit criteria:

- provider-neutral capability and lifecycle interface;
- at least one real OS write-prevention backend proven through conformance tests;
- protected control roots, network and credentials have explicit capability
  truth;
- WorkspaceBoundary remains the independent post-run fallback.

### P1: Reviewer, interventions and SkillPack

Exit criteria:

- clean reviewer context and structured findings;
- confirmed/rejected findings auditable against code;
- all six human intervention roles represented without secrets;
- SkillPack digest present in every run provenance record.

### P1: Routing, admission and Control API/UI

Start only after the earlier safety and evidence gates. The UI is a client of a
versioned API and cannot become durable state.

## 10. Non-goals

- claiming unbounded context, unlimited concurrency or guaranteed 24-hour
  operation;
- replacing mature model SDKs, editors, diff viewers, terminal emulators or Git;
- treating a GUI session as project truth;
- auto-approving Plans, auto-merging accepted work or making an LLM the
  scheduler;
- adopting a large experimental harness into the critical path before its
  adapter and exit strategy are proven.


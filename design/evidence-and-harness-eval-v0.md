# EvidenceBundle and Harness Eval v0

> Status: Plan only; not frozen or dispatched.
>
> Accepted implementation base:
> `14db47f8c4b46f1452f70576d65c981ef9b419ce` (the v1.2 merge).
>
> Frozen contracts use the docs-only mainline descendant containing this Plan
> as their exact read-context base. Source and test code at that base remain
> identical to `14db47f`; no implementation change occurs between the accepted
> merge and contract freeze.

Self-host provenance: the Supervisor will start from the code accepted at
`14db47f` while targeting the main checkout. Code produced by this Plan cannot
be exercised by the same Supervisor invocation that creates it. A later
cutover run is required to prove automatic terminal EvidenceBundle generation
in the outer lifecycle; the implementation run can prove the pure builder,
CLI tests, eval runner and local scenario suite.

## 1. Why this is next

The v1.2 implementation and cutover are now integrated, but the cutover exposed
two remaining P0 evidence gaps:

1. A Worker-authored evidence document cannot contain its own post-exit process
   cleanup, final path audit, WorkspaceBoundary comparison or cost. The current
   RunManifest contains those facts, but there is no single final evidence
   artifact assembled by the controller after settlement.
2. There is no reproducible Harness Eval that can detect regressions or flakes
   across prompt, Skill, cleanup, timeout, cancellation and recovery changes.
   The first post-merge full suite run failed the deadline-extension in-flight
   checkpoint once; the focused file then passed 13/13 and a second full run
   passed 464/464. That is an observed flake, not a stable-green claim.

Without both pieces, every later change to prompts, routing, sandboxing or
background verification relies on anecdotes and Worker self-reports.

## 2. User story

After a Supervisor run reaches a terminal state, a human or UI can open one
versioned evidence bundle that identifies:

```text
Plan / contracts / manifest identity
base / result / integration commits
final task states and verdicts
path audits
process / lease / workspace-boundary records
verification and runtime evidence
known cost truth and missing measurements
the next legal human or controller action
```

Changing a Harness prompt, Skill Pack, process manager, timeout policy or
recovery path can then be evaluated against repeated deterministic local
scenarios. The result records pass rate, flipped scenarios, wall time and
which metrics were unavailable. A GUI is not required for any of it.

## 3. EvidenceBundle v0

### Identity and location

```text
version: 1
path: <repo>/.cliyard/evidence/<runId>.json
```

The bundle is a deterministic projection of the terminal RunManifest plus
small, validated repository facts. RunManifest remains task authority; the
bundle is the controller-owned final review artifact and may be regenerated
if it is missing or damaged.

The bundle contains:

- `runId`, `planId`, terminal run status and generation time;
- contracts path/hash and RunManifest path/hash;
- base commit, integration branch/head and each task `resultCommit`;
- normalized task verdicts, failures, costs, path audits, process trees and
  WorkspaceBoundary records;
- runtime recovery references already persisted by RuntimeManager;
- `missing`: required facts that could not be observed;
- `humanReviewRequired`: always true for accepted work in v0;
- `nextAction`: a bounded recommendation such as `human-review`,
  `inspect-failure`, `resume` or `needs-human`.

No prompt, provider transcript, environment dump, credential, file content or
unbounded log is copied into the bundle. Bounded references to existing evidence
files are allowed.

### Finalization semantics

- A running manifest cannot produce a final bundle.
- A completed or blocked run can.
- The controller writes the bundle after Worker exit, path audit, process
  cleanup, WorkspaceBoundary comparison and cost checkpoint have returned.
- Writes are atomic (`temp + rename`), bounded and idempotent for byte-identical
  source facts.
- If automatic generation fails after a terminal RunManifest exists, the next
  `supervisor evidence` or completed-run `resume` can reconstruct it. Status
  must report missing/invalid evidence as degraded rather than success.
- The bundle never changes task acceptance, rewrites a RunManifest or authorizes
  merge.

## 4. Harness Eval v0

### Scope

V0 evaluates cliyard's deterministic local Harness behavior. It does not call a
paid model and does not claim model-quality comparison. Later versions can add
real ExecutionProfiles while preserving the same report shape.

A suite describes scenarios with argv arrays, never shell strings:

```ts
interface EvalScenario {
  id: string;
  category: string;
  purpose: string;
  commands: string[][];
  timeoutMsPerCommand: number;
  expectedExit: "zero" | "nonzero";
}
```

The runner:

- requires a clean repository and exact starting commit;
- repeats every scenario a configured number of times;
- runs commands with a fixed cwd, bounded output retention and hard timeouts;
- records each repetition's exit, duration and bounded log path;
- treats a scenario as passing only when every repetition matches its expected
  exit;
- records unavailable request/token/cache/cost observations explicitly;
- compares a baseline run with a candidate run and reports flipped scenarios.

### Required scenario suite

```text
normal-work
high-fanout-process-tree
verifier-timeout-and-extension
controller-sigkill-recovery
path-escape
context-reload-handoff
```

The first five reuse real existing test families. `context-reload-handoff`
starts a fresh process that reads only a terminal RunManifest/EvidenceBundle
fixture and reconstructs the next action, simulating context loss without
claiming provider-level compaction equivalence.

The known deadline-extension flake is deliberately included. Repeated execution
must expose it as pass/fail variation instead of hiding it behind one green run.

### Report semantics

`HarnessEvalRun` records:

- suite id/version, label, exact Git commit, repetitions and timestamps;
- scenario and repetition results;
- pass rate and flipped scenario ids;
- wall time, request count, token usage, cache hits, cost truth and human
  intervention count;
- a `missing` list for every metric that was not observed.

Unavailable measurements are `null`/`unknown`, never zero. A baseline and
candidate from the same code may be used to validate repeatability; the first
report must say that this is not evidence of an improvement.

## 5. Task graph

```text
wave 1 (parallel)
  controller-evidence-bundle
  harness-eval-core

wave 2 (parallel)
  supervisor-evidence-integration  [controller-evidence-bundle]
  harness-eval-cli-and-suite       [controller-evidence-bundle, harness-eval-core]

wave 3
  harness-eval-v0-evidence         [both wave-2 tasks]
```

Write ownership:

```text
controller-evidence-bundle:
  src/supervisor/evidence-bundle.ts
  tests/evidence-bundle.test.ts

harness-eval-core:
  src/evaluation/types.ts
  src/evaluation/core.ts
  src/evaluation/report.ts
  tests/harness-eval-core.test.ts

supervisor-evidence-integration:
  src/supervisor/cli.ts
  tests/supervisor-cli.test.ts
  tests/supervisor-evidence-bundle.test.ts

harness-eval-cli-and-suite:
  src/cli.ts
  src/evaluation/cli.ts
  src/evaluation/scenarios.ts
  src/evaluation/handoff.ts
  tests/harness-eval-cli.test.ts
  tests/harness-eval-handoff.test.ts
  examples/harness-eval/suite.json
  package.json

harness-eval-v0-evidence:
  docs/evidence/HARNESS_EVAL_V0.md
```

## 6. Acceptance

The slice is acceptable only if:

1. a completed or blocked terminal manifest produces a deterministic,
   credential-free EvidenceBundle;
2. missing/invalid final evidence is visible rather than treated as success;
3. an evidence bundle can be regenerated without rewriting the RunManifest;
4. the eval runner repeats six bounded scenarios and records every failure;
5. baseline/candidate comparison reports flipped scenarios and missing metrics;
6. a fresh process reconstructs the next action from the handoff fixture;
7. focused, build and complete suites pass;
8. the final self-host run leaves path/process/boundary/cost evidence.

One green repeat is not a flake-rate claim. The deadline-extension scenario must
show its actual repetition-level outcomes.

## 7. Non-goals

- no paid real-model quality evaluation in v0;
- no automatic prompt or Skill optimization;
- no LLM-as-judge;
- no background daemon or scheduler;
- no dynamic routing or concurrency calibration;
- no OS sandbox;
- no automatic acceptance, merge or push;
- no claim that a local test scenario equals provider-level compaction.


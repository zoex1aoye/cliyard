# Task Budget and Duration Estimation v1

> Date: 2026-10-28
>
> Status: design proposal; no automatic admission or scheduling change yet

## 1. Current state

The current Task Architect Plan schema carries task intent, paths, verification
commands and repair count. It does not carry a provider budget or wall-clock
promise.

`estimate-plan` then calculates:

```text
S/M/L/XL from deterministic feature weights
fixed turns, wall-minute, output-token and guard-budget ranges
public-price reference ranges
```

The ranges were calibrated from an early WinUI trial and are no longer strong
predictors of self-hosted control-plane work. In the measured failure/cost run:

```text
estimated L-task wall time:     6-15 min each
estimated L-task guard:         $8 each
actual durable first attempt:   ~6.9 min, used $9.939564 / $10 and failed
actual docs first attempt:      ~3.5 min, used $4.883416 / $5 and failed
actual core accepted:           ~13.6 min
task completion with retries:   several tasks exceeded one 6-15 min attempt
```

The estimator did not model:

- the per-attempt CLI guard versus a task-level retry envelope;
- budget exhaustion and worktree retry;
- provider session startup and tool/build verification overhead;
- repair probability;
- different cost/latency by execution profile;
- task-type history from this project.

The exact LLM wording is not the only defect: the current code already replaces
LLM prose with static heuristics. Prompt-only changes would produce a more
plausible-looking but equally uncalibrated number.

## 2. Decide what the model should estimate

Split three responsibilities:

```text
Architect LLM
  -> task decomposition and evidence requirements

Complexity review LLM
  -> categorical complexity signals and uncertainty

Estimator controller
  -> numeric time, token, cost and guard ranges from telemetry
```

The model should not own dollar amounts, provider balance, concurrency or a
wall-clock promise. Those depend on runtime/profile data the model cannot
observe reliably.

## 3. Proposed structured complexity input

Add optional schema metadata to each Plan task:

```ts
interface TaskComplexitySignals {
  version: 1;
  taskKind:
    | "docs"
    | "schema"
    | "implementation"
    | "test"
    | "verification"
    | "migration"
    | "integration"
    | "investigation"
    | "mixed";
  changeSurface:
    | "single-file"
    | "few-files"
    | "multi-module"
    | "repository-wide";
  evidenceBurden: "none" | "unit" | "build" | "runtime" | "visual";
  stateMatrix: "none" | "small" | "medium" | "large";
  uncertainty: "low" | "medium" | "high";
  riskFlags: Array<
    | "unknown-codebase"
    | "cross-module"
    | "public-api"
    | "migration"
    | "concurrent-write-risk"
    | "runtime-service"
    | "visual-verification"
    | "security-sensitive"
  >;
  rationale: string;
  evidencePaths: string[];
}
```

Rules:

- `evidencePaths` must be existing repo-relative paths used to justify the
  classification;
- the LLM must not emit `budgetUsd`, `wallMinutes`, token counts, pass
  probability or provider balance;
- unknown repository context must produce `uncertainty: high`, not invented
  precision;
- schema validation rejects unsupported values and empty evidence for
  non-trivial signals.

## 4. Architect / complexity prompt contract

Suggested prompt block:

```text
Decompose the approved design into the smallest independently verifiable tasks.
For each task, classify only observable complexity signals. Do not estimate
money, time, tokens, provider quota or pass probability.

Use the repository to justify:
- task kind;
- change surface;
- required evidence type;
- state/test matrix size;
- uncertainty and risk flags;
- the paths supporting each classification.

If evidence is insufficient, state high uncertainty. Never make up hidden code
or provider behavior. The controller, not the model, will calculate numeric
estimates from historical telemetry.
```

This belongs in:

- Task Architect system prompt;
- any DSH/planning prompt that proposes tasks;
- the JSON schema and plan validator.

## 5. Controller estimator

### 5.1 Measurement key

Use historical attempts keyed by:

```text
taskKind
changeSurface
evidenceBurden
stateMatrix
uncertainty
runtimeId
endpointBinding
modelId
```

Do not pool Claude, Codex, different endpoints or subscriptions without an
explicit fallback hierarchy.

### 5.2 Metrics

For each observed attempt record:

- wall duration from attempt start to worker result;
- verifier duration;
- queue wait;
- turns/tool calls when available;
- input/output/cache tokens;
- CLI-estimated cost and missing state;
- provider-reported cost when available;
- repair count and failure category;
- peak RSS/CPU/runtime usage when available;
- outcome and acceptance.

Compute robust p50/p90 values, sample count and success/repair rates. Do not use
a mean dominated by budget-exhausted outliers.

### 5.3 Numeric outputs

Task estimate:

```text
workerWallP50/P90
verifierWallP50/P90
queueWaitP50/P90 (live state, not historical task cost)
tokenP50/P90
repairProbability
perAttemptGuard
taskGuardEnvelope
confidence
sampleSize
basis
```

`perAttemptGuard` is bounded by the selected execution profile and user cap.
`taskGuardEnvelope` must model explicit retries/repairs:

```text
maxGuard =
  perAttemptGuard
  * (1 + expectedRepairs)
  * queueMaxAttemptsOrPolicyFactor
```

It is a safety envelope, not predicted spend. Display the assumptions. Never
infer subscription balance or price from another binding.

### 5.4 Cold start

When profile-specific history is insufficient:

1. use a conservative task-kind fallback;
2. show `confidence: low` and `sampleSize`;
3. do not tighten guard based on apparent speed;
4. learn after completion without retroactively claiming prediction accuracy.

Suggested minimum:

```text
direct profile:   n >= 10 completed attempts
task-kind prior:  n >= 20 completed attempts
otherwise:        conservative cold-start range
```

### 5.5 LLM calibration adjustment

If an LLM is used after the telemetry baseline, it may apply a bounded
multiplier or flag:

```text
0.8x / 1.0x / 1.3x / 1.8x
```

It must cite task evidence and may never override hard provider/resource caps.
The multiplier is persisted with rationale and evaluated against later actuals.
If calibration error does not improve, remove the LLM adjustment.

## 6. Duration semantics

Report separately:

```text
queue wait
worker wall time
verifier/runtime time
repair attempts
human wait
integration wait
```

Do not state one "task takes 10 minutes" number that hides retries and waiting.
A user-facing estimate should look like:

```text
worker: 8-14 min p50-p90
verification: 1-3 min
repairs: 35% historical chance; envelope up to 3 attempts
queue wait: unknown / current observed range
confidence: medium (n=17)
```

## 7. Prompt regression checks

Prompt evaluation fixtures should verify:

- the model never outputs budget/duration fields;
- high uncertainty is chosen for ambiguous designs;
- evidence paths are real;
- schema rejects invented provider capacity, balance or billing;
- a complex runtime/browser task is not classified as simple docs;
- deterministic controller output is unchanged by irrelevant prose.

## 8. Rollout

```text
1. Add complexity signals to Plan schema, optional and backward-compatible.
2. Update Task Architect prompt and validation fixtures.
3. Add telemetry aggregation by execution profile and task class.
4. Return estimator output with confidence/sample size; keep heuristic fallback.
5. Compare predicted p50/p90 with actuals for a bounded sample.
6. Add optional LLM multiplier only if measured error improves.
7. Connect estimates to admission/reporting; never to automatic budget approval.
```

## 9. Acceptance

1. No numeric budget/time estimate is accepted directly from free-form LLM
   prose.
2. Plan complexity signals are structured, evidence-backed and optional for old
   Plans.
3. The controller exposes per-attempt guard and task retry envelope separately.
4. Estimates show confidence, sample size, basis and missing data.
5. Known CLI cost remains non-authoritative; balance remains unknown unless a
   provider adapter reports it.
6. Completed attempts feed calibration without changing acceptance authority.
7. The estimate can explain why it changed after new telemetry.

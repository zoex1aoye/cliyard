# Queue ExecutionProfile and Continuation Policy v0

> Date: 2026-10-28
>
> Status: implemented v0. Queue add freezes one bounded execution identity and
> an optional continuation envelope. Queue run passes those persisted values to
> the Supervisor without consulting the current environment.

## 1. Problem

The queue previously stored only `worker` plus an optional `model`. Deadline
and budget policy flags were accepted by the Supervisor, but the queue had no
durable way to carry them. A normal `queue run` therefore could not opt a task
into continuation, and there was no stable object describing whether the
chosen runtime supported mapped progress or provider-session resume.

This slice closes that gap without adding routing:

```text
queue add / add-plan
  -> validate and freeze ExecutionProfile
  -> validate and freeze optional QueueContinuationPolicy
  -> persist both in QueueItem
  -> read-only pre-dispatch compatibility check
  -> map the same frozen values to Supervisor start or resume argv
```

The RunManifest remains task/run authority. The TaskContract remains acceptance
authority. A profile selects how work is dispatched; it does not alter what
counts as accepted.

## 2. Invariants

1. Every newly added queue item owns an `executionProfile`.
2. When a profile exists, queue `worker` equals `profile.runtimeId` and queue
   `model` equals `profile.modelId`.
3. Legacy items without either field remain readable. They use their recorded
   `worker`/optional `model`; they are not silently upgraded or rewritten.
4. The continuation policy is optional. If present, it requires a profile.
5. Profile files and policy files are read once at add time. Their paths and
   later bytes are not dispatch authority.
6. Profile and policy values are immutable across retry and resume.
7. Current environment variables do not supply queue worker, model, budget or
   deadline values at dispatch time.
8. `endpointRef` and `accountBindingId` are opaque bounded references. Raw
   endpoint URLs, API keys, tokens and account secrets are never valid fields.
9. An incompatible policy blocks before the Supervisor is called.
10. Capabilities are derived from the runtime implementation, not trusted from
    profile input.

## 3. ExecutionProfile v1

```ts
type ExecutionRuntimeId = "claude" | "codex";

interface ExecutionCapabilities {
  mappedProgress: boolean;
  providerSessionResume: boolean;
}

interface ExecutionProfile {
  version: 1;
  profileId: string;
  runtimeId: ExecutionRuntimeId;
  modelId: string;
  providerId: string;
  endpointRef?: string;
  accountBindingId?: string;
  capabilities: ExecutionCapabilities;
}
```

The profile file accepted by `--execution-profile` uses the same fields. It may
omit `capabilities`; they are derived. If present, capabilities must exactly
match the derived values or parsing fails.

```json
{
  "version": 1,
  "profileId": "profile-team-claude",
  "runtimeId": "claude",
  "modelId": "deepseek-v4-pro",
  "providerId": "deepseek",
  "endpointRef": "endpoint-team-main",
  "accountBindingId": "account-team"
}
```

The normalized persisted object adds capabilities:

```json
{
  "version": 1,
  "profileId": "profile-team-claude",
  "runtimeId": "claude",
  "modelId": "deepseek-v4-pro",
  "providerId": "deepseek",
  "endpointRef": "endpoint-team-main",
  "accountBindingId": "account-team",
  "capabilities": {
    "mappedProgress": true,
    "providerSessionResume": true
  }
}
```

### 3.1 Bounds and references

- Profile IDs, provider IDs, endpoint refs and account binding IDs are 1-128
  characters and match ASCII identifier syntax.
- Model IDs are 1-128 characters and allow common provider/model separators.
- Profile and policy JSON files are limited to 64 KiB.
- Unknown fields fail closed, including `apiKey`, `token`, `baseUrl` and other
  accidental credential fields.
- String values containing URL syntax (`://`) or obvious credential markers
  are rejected.

### 3.2 Runtime capability matrix

| Runtime | `mappedProgress` | `providerSessionResume` | Reason |
|---|---:|---:|---|
| Claude | true | true | Claude stream-json supplies assistant/tool progress, and the measured same-session budget resume path exists. |
| Codex | false | false | The current adapter has no mapped meaningful-progress stream or queue-supported provider-session resume. |

Capability truth is intentionally runtime-level in v0. It does not claim that
every model, account, endpoint or provider supports the same behavior.

### 3.3 Deterministic defaults

If no profile file is supplied, `queue add` and `queue add-plan` derive a
profile from explicit `--worker`/`--model` or these defaults:

| Runtime | Model | Provider | Default endpointRef |
|---|---|---|---|
| `claude` | `deepseek-flash` | `deepseek` | `deepseek-claude-default` |
| `codex` | `deepseek-v4-pro` | `deepseek` | `deepseek-codex-default` |

An explicit model that does not use the `deepseek-*` namespace is frozen with
`providerId: "unknown"` and `endpointRef: "unknown-default-endpoint"`. The
control plane does not infer a provider from an arbitrary model name.

The derived `profileId` is:

```text
queue-<runtimeId>-<first 20 hex chars of sha256(canonical identity)>
```

The canonical identity contains version, runtime, model, provider, endpoint
reference and optional account binding. Examples:

```text
queue-claude-a263a2bd05dd6ff5e8a7
queue-codex-20a894822600a00f2b93
```

No environment fallback participates in this derivation.

## 4. QueueContinuationPolicy v1

The canonical queue policy wraps the existing bounded deadline and budget
policies:

```ts
interface QueueContinuationPolicy {
  version: 1;
  deadlineExtension?: DeadlineExtensionPolicy;
  budgetContinuation?: BudgetContinuationPolicy;
}

interface DeadlineExtensionPolicy {
  version: 1;
  baseTimeoutMs: number;
  extensionStepMs: number;
  maxExtensions: number;
  maxTotalTimeoutMs: number;
  healthyActivityWindowMs: number;
  autoExtend: boolean;
}

interface BudgetContinuationPolicy {
  version: 1;
  baseGuardUsd: number;
  continuationGuardUsd: number;
  maxContinuations: number;
  maxCumulativeGuardUsd: number;
  autoContinue: boolean;
  overshootReserveUsd: number;
}
```

At least one nested policy is required. Input aliases `deadline`, `budget`,
`deadlinePolicy` and `budgetPolicy` are normalized to the canonical names, but
only one spelling for each nested policy may be present.

Example:

```json
{
  "version": 1,
  "deadlineExtension": {
    "version": 1,
    "baseTimeoutMs": 1200000,
    "extensionStepMs": 300000,
    "maxExtensions": 2,
    "maxTotalTimeoutMs": 1800000,
    "healthyActivityWindowMs": 60000,
    "autoExtend": true
  },
  "budgetContinuation": {
    "version": 1,
    "baseGuardUsd": 5,
    "continuationGuardUsd": 5,
    "maxContinuations": 2,
    "maxCumulativeGuardUsd": 20,
    "autoContinue": true,
    "overshootReserveUsd": 2
  }
}
```

The dollar values are guards, not spend, balance, quota or a strict provider
hard cap. A budget continuation is a new invocation; it does not mutate an
running process.

## 5. Durable QueueItem shape

New items persist:

```json
{
  "id": "delivery-item",
  "worker": "claude",
  "model": "deepseek-flash",
  "executionProfile": {
    "version": 1,
    "profileId": "queue-claude-a263a2bd05dd6ff5e8a7",
    "runtimeId": "claude",
    "modelId": "deepseek-flash",
    "providerId": "deepseek",
    "endpointRef": "deepseek-claude-default",
    "capabilities": {
      "mappedProgress": true,
      "providerSessionResume": true
    }
  },
  "continuationPolicy": {
    "version": 1,
    "deadlineExtension": {
      "version": 1,
      "baseTimeoutMs": 1200000,
      "extensionStepMs": 300000,
      "maxExtensions": 2,
      "maxTotalTimeoutMs": 1800000,
      "healthyActivityWindowMs": 60000,
      "autoExtend": true
    }
  }
}
```

Other existing QueueItem fields are omitted from this example only for
readability.

`saveQueue` re-parses the document. A worker/model mirror mismatch, malformed
profile, malformed policy, false capability assertion, unknown secret-bearing
field or policy without a profile fails the queue load instead of dispatching.

## 6. CLI behavior

Both item sources accept the same flags:

```bash
cliyard queue add contracts.json --repo . --id item \
  [--worker claude|codex] [--model MODEL] \
  [--execution-profile profile.json] \
  [--continuation-policy policy.json] [--json]

cliyard queue add-plan plan.json --repo . --id item \
  [--worker claude|codex] [--model MODEL] \
  [--execution-profile profile.json] \
  [--continuation-policy policy.json] [--json]
```

When `--execution-profile` is present:

- its `runtimeId` and `modelId` are authoritative;
- an explicit different `--worker` or `--model` is rejected;
- an explicit equal value is accepted;
- omitted worker/model values are filled from the profile.

When no profile file is present, worker/model flags derive the deterministic
profile described in section 3.3. The source file paths are never persisted.

## 7. Pre-dispatch compatibility

`checkQueueItemExecutionPolicy` is read-only and is called both by queue status
and by the queue runner before dispatch.

| Frozen condition | Result |
|---|---|
| No profile and no continuation policy | Legacy dispatch allowed. |
| Continuation policy without profile | Block: `execution_profile_required`. |
| Invalid profile/policy or mirror mismatch | Block before Supervisor. |
| `deadlineExtension.autoExtend=true` without mapped progress | Block: `mapped_progress_required`. |
| Any budget continuation policy without provider-session resume | Block: `provider_session_resume_required`. |
| Codex plus budget continuation | Block: `provider_session_resume_required`; the Supervisor error is not the guard. |

The block is persisted as a deterministic queue-item failure only because no
RunManifest exists. Once a run is dispatched, its RunManifest remains failure
authority.

## 8. Supervisor argv mapping

The queue runner applies the following to both `start` and
`resume --retry-rejected`:

| Frozen value | Supervisor argv |
|---|---|
| `profile.runtimeId` | `--worker <runtimeId>` |
| `profile.modelId` | `--model <modelId>` |
| `deadlineExtension.baseTimeoutMs` | `--timeout-ms` |
| `deadlineExtension.extensionStepMs` | `--deadline-extension-ms` |
| `deadlineExtension.maxExtensions` | `--max-deadline-extensions` |
| `deadlineExtension.maxTotalTimeoutMs` | `--max-total-timeout-ms` |
| `deadlineExtension.healthyActivityWindowMs` | `--healthy-activity-window-ms` |
| `deadlineExtension.autoExtend=true` | `--auto-extend-deadline` |
| `budgetContinuation.baseGuardUsd` | `--max-budget-usd` |
| `budgetContinuation.continuationGuardUsd` | `--continuation-guard-usd` |
| `budgetContinuation.maxContinuations` | `--max-budget-continuations` |
| `budgetContinuation.maxCumulativeGuardUsd` | `--max-cumulative-budget-guard-usd` |
| `budgetContinuation.overshootReserveUsd` | `--budget-overshoot-reserve-usd` |
| `budgetContinuation.autoContinue=true` | `--auto-continue-budget` |

False booleans emit no flag because the Supervisor has no explicit false
switch. Every value flag is emitted whenever its nested policy exists.

## 9. Status and events

`queue status --json` adds a read-only `execution` projection per item:

```json
{
  "execution": {
    "frozen": true,
    "profileId": "queue-claude-a263a2bd05dd6ff5e8a7",
    "runtimeId": "claude",
    "modelId": "deepseek-flash",
    "providerId": "deepseek",
    "endpointRef": "deepseek-claude-default",
    "accountBindingId": null,
    "capabilities": {
      "mappedProgress": true,
      "providerSessionResume": true
    },
    "continuation": {
      "deadlineExtension": {
        "baseTimeoutMs": 1200000,
        "extensionStepMs": 300000,
        "maxExtensions": 2,
        "maxTotalTimeoutMs": 1800000,
        "healthyActivityWindowMs": 60000,
        "autoExtend": true
      },
      "budgetContinuation": null
    },
    "policyCheck": {
      "ok": true
    }
  }
}
```

Human queue/status output shows the profile identity, capabilities and compact
deadline/budget summary.

Bounded lifecycle events may include:

```text
executionProfileId
runtimeId
modelId
providerId
mappedProgress
providerSessionResume
deadlineAutoExtend
deadlineMaxExtensions
budgetAutoContinue
budgetMaxContinuations
```

Events expose summaries only. They do not contain policy source paths, raw
endpoint URLs, API keys, tokens or account secrets.

## 10. Retry and resume

Retry changes only queue status/action and clears a pre-dispatch failure. Resume
checks the existing run and contracts identity as before. Neither path rewrites
the execution profile or continuation policy.

Source profile/policy files may change or disappear after add. Existing queue
items continue with their persisted objects. The Supervisor receives those
exact persisted values on every new start or repeat resume.

## 11. Acceptance evidence

Focused coverage:

```text
tests/queue-execution-profile.test.ts
```

Covered cases:

- profile normalization and deterministic defaults;
- invalid versions, unknown secret fields, URL refs and false capabilities;
- missing source paths in durable queue bytes;
- `add` and `add-plan` file input;
- explicit worker/model conflict rejection;
- legacy queue readability;
- exact profile/policy persistence through block, retry and resume;
- all deadline/budget argv flags on start and resume;
- Codex budget and automatic-deadline incompatibility before dispatch;
- worker/model, capability and reference tampering;
- JSON/human status projection and bounded event fields.

Exact commands and measured results are recorded in
[QUEUE_EXECUTION_PROFILE.md](../docs/evidence/QUEUE_EXECUTION_PROFILE.md).

## 12. Limits and non-goals

- No dynamic profile scoring, fallback routing or model-selection heuristic.
- No admission counts, profile concurrency broker or parallel queue dispatch.
- No secret storage. References are opaque identifiers only.
- No profile/policy mutation on retry or resume.
- No process-tree identity or descendant cleanup.
- No change to RunManifest acceptance authority or TaskContract.
- No dispatch-time environment fallback for frozen values.
- No manual continuation control files or local extension command.
- No daemon.
- Capability values are runtime-level and can overstate support for a specific
  account or endpoint until a future binding-aware capability probe exists.
- A supplied profile's explicit `profileId` is an operator label; v0 does not
  cryptographically sign or hash-protect the mutable queue JSON.

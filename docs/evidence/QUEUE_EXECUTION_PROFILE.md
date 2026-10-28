# Queue ExecutionProfile and Continuation Policy Evidence

> Date: 2026-10-28
>
> Scope: local TypeScript build, focused tests and existing queue regression
> suites. No paid provider call, runtime service or dynamic routing was used.

## 1. Implemented behavior

Queue add now freezes a versioned execution identity in every new item:

```json
{
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
}
```

The deterministic Codex default is:

```json
{
  "version": 1,
  "profileId": "queue-codex-20a894822600a00f2b93",
  "runtimeId": "codex",
  "modelId": "deepseek-v4-pro",
  "providerId": "deepseek",
  "endpointRef": "deepseek-codex-default",
  "capabilities": {
    "mappedProgress": false,
    "providerSessionResume": false
  }
}
```

`queue add` and `queue add-plan` accept:

```text
--execution-profile <profile.json>
--continuation-policy <policy.json>
```

Files are parsed once under the queue lock. Only bounded normalized objects are
persisted; source paths are omitted. A profile's runtime/model are authoritative
and conflict with explicit `--worker`/`--model` values is rejected.

Without a profile file, the default worker/model pair is frozen deterministically:

```text
claude -> deepseek-flash
codex  -> deepseek-v4-pro
```

No environment variable supplies this queue identity.

## 2. Continuation boundary

The optional queue policy contains bounded deadline and/or budget policies.
Retry and resume preserve the exact persisted objects. Source policy files may
change after add without changing dispatch behavior.

The runner maps every value to both Supervisor start and resume:

```text
--timeout-ms
--deadline-extension-ms
--max-deadline-extensions
--max-total-timeout-ms
--healthy-activity-window-ms
--auto-extend-deadline
--max-budget-usd
--continuation-guard-usd
--max-budget-continuations
--max-cumulative-budget-guard-usd
--budget-overshoot-reserve-usd
--auto-continue-budget
```

False opt-in booleans have no Supervisor flag. All value flags are passed when
their nested policy exists.

The queue performs a read-only, pre-dispatch compatibility check:

| Condition | Deterministic result |
|---|---|
| continuation policy without profile | `execution_profile_required` |
| worker/model does not mirror profile | load fails closed |
| false capability in persisted profile | load fails closed |
| automatic deadline without mapped progress | `mapped_progress_required` |
| budget continuation without provider-session resume | `provider_session_resume_required` |
| Codex plus budget continuation | blocked before Supervisor invocation |

The pre-dispatch block stores an item failure only because no RunManifest exists.
After dispatch, RunManifest remains failure authority.

## 3. Legacy compatibility

Queue records created before this change may omit `executionProfile`,
`continuationPolicy` and `model`. They remain readable. The runner continues to
use the recorded worker and optional model and does not infer current model or
continuation values from the environment.

All newly added items have `executionProfile`; when it exists, persisted
`worker` and `model` must exactly equal `runtimeId` and `modelId`.

## 4. Control projection

`queue status --json` exposes an `execution` projection with:

- `profileId`;
- runtime, model and provider;
- opaque endpoint/account references;
- mapped-progress and session-resume capabilities;
- deadline/budget summary;
- read-only `policyCheck`.

Human queue/status output includes the profile, capabilities and continuation
summary.

Bounded `queue.item.added`, `attempt.started`, `run.started`, `run.resumed` and
block/completion events carry profile and continuation summary fields. They do
not carry source paths, endpoint URLs or secrets.

## 5. Verification performed

Build:

```bash
npm run build
```

Result:

```text
exit 0
```

The managed sandbox prevented `npx tsx` from creating its temporary IPC socket
(`EPERM`). Tests were therefore launched through Node's native runner with the
same installed `tsx` loader:

```bash
node --import tsx --test tests/queue-execution-profile.test.ts
node --import tsx --test tests/orchestration-queue.test.ts
node --import tsx --test tests/queue-run-binding.test.ts
node --import tsx --test tests/queue-control-snapshot.test.ts
node --import tsx --test tests/plan-backed-queue-cli.test.ts
node --import tsx --test tests/*queue*.test.ts
```

Observed focused results:

```text
queue-execution-profile: 10/10 pass
orchestration-queue:     13/13 pass
queue-run-binding:        5/5 pass
queue-control-snapshot:   7/7 pass
plan-backed-queue-cli:    5/5 pass
queue family:            50/50 pass
```

The queue-family command covered orchestration core, Plan-backed queue core
and CLI, queue control snapshot, run binding and the new execution-profile
suite.

## 6. Covered checks

`tests/queue-execution-profile.test.ts` proves:

- deterministic profile defaults and derived capabilities;
- bounded fail-closed parsing;
- rejection of secret-like fields, URL refs and false capabilities;
- no source path or secret in persisted queue bytes;
- profile file input through both `queue add` and `queue add-plan`;
- explicit worker/model conflict rejection;
- legacy queue records without profiles;
- exact profile/policy persistence through blocked, retry and resumed dispatch;
- every deadline/budget value flag on both start and resume;
- dispatch ignores hostile current environment values;
- Codex budget and automatic-deadline blocks before a runner call;
- tampered worker/model/capability/reference rejection on load;
- human/JSON status and bounded event projection.

Existing queue tests continue to cover dependency order, run binding,
reconciliation, control snapshot and Plan materialization.

## 7. Limits

- No real provider request was made for this slice.
- Capabilities are runtime-level, not endpoint/account binding-level.
- No dynamic routing, score, fallback or admission count.
- No queue parallelism.
- No cryptographic integrity/signature for mutable queue JSON; malformed or
  mirror-inconsistent state is rejected, but a writer able to modify every
  field could intentionally define another syntactically valid frozen profile.
- No process-tree cleanup or descendant identity.
- No manual continuation control file.
- No daemon.
- Budget guards remain guards, not balance, invoice or strict hard-cap claims.

## 8. Full-suite limitation

A broad `node --import tsx --test tests/*.test.ts` attempt was aborted after
the managed sandbox produced unrelated environment failures:

- tests that independently spawn `npx tsx` hit the same temporary IPC
  `EPERM`;
- runtime tests could not bind their static loopback port ranges and reported
  `no available port`.

Those failures occurred outside the changed queue modules and made a truthful
full-suite pass count unavailable in this session. The 50/50 queue-family run,
the five focused existing suites listed above, and the TypeScript build are the
accepted local evidence for this slice. Runtime services remain Verifier-owned.

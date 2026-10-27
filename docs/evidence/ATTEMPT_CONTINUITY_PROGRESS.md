# Attempt Continuity, Worker Progress, and Abnormal Drill Recovery — Measured Evidence

> Date: 2026-10-27
>
> Environment: macOS (Darwin 27.0.0), Node `v20.20.2`, npm `10.8.2`,
> checkout HEAD `3093508`.
>
> Scope: one foreground Supervisor on one local git repository, a local
> stream-json fixture provider, and one scratch runtime-drill root. This is a
> checked-in summary of one local measurement. It is **not** a real
> DeepSeek/Claude provider run, a CI result, a long-term flake rate, or a
> 24-hour/daemon claim.

This document records only observed output. Raw scratch artifacts remained
outside the repository (`/tmp/cliyard-continuity-evidence/`) and were not
committed.

## Commands and results at a glance

Run from the repository root on the measurement date:

| Command | Result | Test-runner duration |
|---------|--------|----------------------|
| `npm run build` | pass | — |
| `npx tsx --test tests/supervisor-attempt-reuse.test.ts tests/claude-progress.test.ts tests/supervisor-worker-progress.test.ts tests/runtime-failure-drills.test.ts` | 13/13 pass | 9769.2 ms |
| Runtime/recovery group (13 files, listed in §6) | 81/81 pass | 9968.0 ms |
| `npm test` (full suite) | 177/177 pass | 10887.8 ms |

These are single local runs. The manual CLI and drill measurements below were
executed separately from those test commands.

## Measurement fixtures

Two scratch Git repositories were created, each with one frozen contract:

```json
{
  "taskId": "draft-task",
  "version": 1,
  "frozen": true,
  "goals": ["Produce a draft, then a final artifact"],
  "dependsOn": [],
  "readPaths": ["."],
  "writePaths": ["draft.txt", "final.txt"],
  "sharedResources": [],
  "baseCommit": "<scratch-repo HEAD>",
  "verifyCommands": ["test -f final.txt"],
  "maxRepairs": 0
}
```

A temporary executable referenced through `CLIYARD_CLAUDE_BINARY` supplied
real stream-json-shaped records (`system`, `assistant` with `tool_use`,
`user` with `tool_result`, `result`). Its first invocation wrote `draft.txt`;
its second invocation wrote `final.txt`. It appended
`{attempt, cwd, draftSeen}` to a log outside the worktree so the measurement
could prove which worktree a retry attached to. It stayed silent for 2000 ms
after `tool_result`, and the adapter was configured with
`CLIYARD_CLAUDE_HEARTBEAT_MS=200` so a finite run would exercise heartbeats.
The production default remains 15000 ms.

This fixture tests the adapter/CLI/supervisor path. It is not evidence about
the real provider's timing, model behavior, cost, or output quality.

The manual CLI runs used this environment; the fresh repository used its own
log and counter paths:

```bash
export CLIYARD_CLAUDE_BINARY=/tmp/cliyard-continuity-evidence/fake-claude
export FAKE_CLAUDE_LOG=/tmp/cliyard-continuity-evidence/logs/reuse-worker.jsonl
export FAKE_CLAUDE_COUNTER=/tmp/cliyard-continuity-evidence/logs/reuse-counter
export CLIYARD_CLAUDE_HEARTBEAT_MS=200
export FAKE_CLAUDE_SILENCE_MS=2000
```

## 1. Rejected attempt and default reuse

Scratch repo base commit: `a9ce87d580175820ab81bc3325ff57852a3fe3fc`.

### First attempt rejects and checkpoints the dirty attempt

```bash
cd <cliyard checkout>
node dist/cli.js supervisor start contracts.json \
  --repo /tmp/cliyard-continuity-evidence/reuse --worker claude --verbose
```

Exit code `1`. Observed output (excerpt):

```text
[claude-batch] start draft-task
[claude-batch] worktree draft-task → /tmp/cliyard-continuity-evidence/reuse/.cliyard/worktrees/mvqlw342-draft-task
  implement: exit=0
    ... "fixture attempt 1: starting clean" ... "file_path":"draft.txt" ...
    [claude] changed: draft.txt
  verify: ok=false
    [shell-verify] exit=1: test -f final.txt
  status → rejected
[claude-batch] rejected draft-task: verify failed and maxRepairs=0 exhausted
...
"status": "blocked",
"accepted": 0,
"pending": 1,
```

The run id was `b2f9ce50-25ee-4c0d-84f2-8bcbf5891cb5`. The persisted task:

```json
{
  "taskId": "draft-task",
  "status": "rejected",
  "accepted": false,
  "reason": "verify failed and maxRepairs=0 exhausted",
  "attemptWorktree": "/tmp/cliyard-continuity-evidence/reuse/.cliyard/worktrees/mvqlw342-draft-task",
  "attemptBranch": "cliyard/mvqlw342-draft-task",
  "attemptBaseCommit": "a9ce87d580175820ab81bc3325ff57852a3fe3fc",
  "attemptStartedAt": "2026-10-27T11:32:32.094Z",
  "attemptRejectedAt": "2026-10-27T11:32:34.845Z"
}
```

The rejected worktree was not removed even though `--keep-worktrees` was not
passed. It was still registered as a git worktree, `HEAD` equalled the
recorded base, its branch equalled the recorded branch, and its untracked
`draft.txt` contained:

```text
draft from attempt 1
```

Read-only `supervisor status --json` exposed exactly one reusable attempt:

```json
[
  {
    "taskId": "draft-task",
    "worktree": "/tmp/cliyard-continuity-evidence/reuse/.cliyard/worktrees/mvqlw342-draft-task",
    "branch": "cliyard/mvqlw342-draft-task",
    "baseCommit": "a9ce87d580175820ab81bc3325ff57852a3fe3fc",
    "startedAt": "2026-10-27T11:32:32.094Z",
    "rejectedAt": "2026-10-27T11:32:34.845Z"
  }
]
```

Human status printed the same attempt as:

```text
reusable attempt: draft-task /tmp/cliyard-continuity-evidence/reuse/.cliyard/worktrees/mvqlw342-draft-task (cliyard/mvqlw342-draft-task @ a9ce87d580175820ab81bc3325ff57852a3fe3fc; rejected 2026-10-27T11:32:34.845Z)
```

### Default retry reuses the same worktree and sees the draft

```bash
node dist/cli.js supervisor resume --repo /tmp/cliyard-continuity-evidence/reuse \
  --run b2f9ce50-25ee-4c0d-84f2-8bcbf5891cb5 \
  --worker claude --retry-rejected --verbose
```

Exit code `0`. The key observed line was:

```text
[claude-batch] reuse attempt worktree draft-task → /tmp/cliyard-continuity-evidence/reuse/.cliyard/worktrees/mvqlw342-draft-task
```

The fixture's own invocation log proved the retry attached to the recorded
worktree and could see the prior draft:

```json
{"attempt":1,"cwd":"/private/tmp/cliyard-continuity-evidence/reuse/.cliyard/worktrees/mvqlw342-draft-task","draftSeen":false,"at":"2026-10-27T11:32:32.515Z"}
{"attempt":2,"cwd":"/private/tmp/cliyard-continuity-evidence/reuse/.cliyard/worktrees/mvqlw342-draft-task","draftSeen":true,"at":"2026-10-27T11:32:54.741Z"}
```

(`/private/tmp` is macOS's real path for `/tmp`; the same worktree is meant.)

The run completed. `resultCommit` was
`80f2661a195e1e9dcb8b41fd141723bbeff3f515`; `integrationHead` was
`625230749754eedfb0893b20cb26c50205a6ceca`. The final task contained only
`taskId`, `status: "accepted"`, `accepted: true`, and `resultCommit`; all five
attempt fields were absent. The integration branch contained both artifacts:

```text
$ git -C /tmp/cliyard-continuity-evidence/reuse \
    show cliyard/integration/b2f9ce50-25ee-4c0d-84f2-8bcbf5891cb5:draft.txt
draft from attempt 1
$ git -C /tmp/cliyard-continuity-evidence/reuse \
    show cliyard/integration/b2f9ce50-25ee-4c0d-84f2-8bcbf5891cb5:final.txt
final from attempt 2
```

The accepted worktree was removed, and final status showed
`reusableAttempts: []`.

**Observed behavior:** default `resume --retry-rejected` reuses the recorded
dirty worktree. It does not resume a provider conversation; only the worktree
and its files are continuous. No conversation/session state from the first
provider process was reused.

## 2. `--fresh-attempt` deliberately discards the draft

Second scratch repo base commit: `e8836cb2d6d8e00b0ddb611acb17dcfd8c24fb45`.

The first `supervisor start` again rejected after writing `draft.txt` and
recorded an attempt (run `610afe48-e58c-4689-b355-c1274b5cd746`, worktree
`.../mvqlwx3l-draft-task`, rejected at `2026-10-27T11:33:13.310Z`).

```bash
node dist/cli.js supervisor resume --repo /tmp/cliyard-continuity-evidence/fresh \
  --run 610afe48-e58c-4689-b355-c1274b5cd746 \
  --worker claude --retry-rejected --fresh-attempt --verbose
```

Exit code `0`. This time the observed line was a **new** worktree rather than
`reuse attempt worktree`:

```text
[claude-batch] worktree draft-task → /tmp/cliyard-continuity-evidence/fresh/.cliyard/worktrees/mvqlx4be-draft-task
```

The fixture log showed a different cwd and no draft:

```json
{"attempt":1,"cwd":"/private/tmp/cliyard-continuity-evidence/fresh/.cliyard/worktrees/mvqlwx3l-draft-task","draftSeen":false,"at":"2026-10-27T11:33:10.985Z"}
{"attempt":2,"cwd":"/private/tmp/cliyard-continuity-evidence/fresh/.cliyard/worktrees/mvqlx4be-draft-task","draftSeen":false,"at":"2026-10-27T11:33:20.342Z"}
```

The discarded draft stayed on disk (`discarded_draft_present=true`), which is
consistent with the current no-worktree-GC limitation. The integration branch
contained `final.txt` from attempt 2 and **no** `draft.txt`
(`draft_in_integration=false`). The final task again had no attempt fields.
`resultCommit` was `c9be895db1b4553409ad8554091788202669a954`;
`integrationHead` was `3386629fea0c239c49702aa1191655af87d5e3c4`.

**Observed behavior:** `--fresh-attempt` intentionally discards the recorded
attempt, creates a clean worktree at the current integration base, and leaves
the old draft on disk rather than deleting it.

## 3. Fail-closed reuse checks

The focused suite
`tests/supervisor-attempt-reuse.test.ts` passed 4/4. Beyond the default/fresh
flows above, it asserts these measured test-level behaviors:

- a pre-feature manifest without attempt fields still loads, while a malformed
  `attemptWorktree` type is rejected at the store boundary;
- `--reuse-attempt` and `--fresh-attempt` together fail before dispatch
  (`mutually exclusive`), with zero worker dispatches;
- a recorded worktree outside `<repo>/.cliyard/worktrees/`, a branch mismatch,
  and a missing `attemptRejectedAt` each fail the resume before any dispatch;
- accepted work clears attempt metadata, `reusableAttempts` becomes empty, and
  the recorded draft and final artifact are in the integration branch. (A
  completed run is not reopened by `resume`; that is existing Supervisor
  behavior outside this file's attempt-specific assertions.)

The implementation additionally fails closed for an unregistered worktree, a
worktree `HEAD` that no longer matches `attemptBaseCommit`, an attempt recorded
by another task or run, and missing or malformed attempt identity fields. The
focused test exercises the three tamper cases listed above; it does not
exercise every one of these additional conditions as a separate test.

## 4. Live stream events, heartbeat, and read-only status

Events were appended to:

```text
/tmp/cliyard-continuity-evidence/reuse/.cliyard/worker-events/b2f9ce50-25ee-4c0d-84f2-8bcbf5891cb5/draft-task.jsonl
```

Representative observed lines from the rejected first attempt (one complete
JSON object per line):

```json
{"version":1,"at":"2026-10-27T11:32:32.101Z","source":"claude","taskId":"draft-task","sessionId":"59150391-dab7-4d18-87bb-c45d4c71869c","type":"session.start","phase":"starting","message":"worker started"}
{"version":1,"at":"2026-10-27T11:32:32.517Z","source":"claude","taskId":"draft-task","sessionId":"59150391-dab7-4d18-87bb-c45d4c71869c","type":"assistant","phase":"thinking","message":"fixture attempt 1: starting clean"}
{"version":1,"at":"2026-10-27T11:32:32.517Z","source":"claude","taskId":"draft-task","sessionId":"59150391-dab7-4d18-87bb-c45d4c71869c","type":"tool.start","phase":"tool","message":"tool Write started","detail":"path draft.txt"}
{"version":1,"at":"2026-10-27T11:32:32.818Z","source":"claude","taskId":"draft-task","sessionId":"59150391-dab7-4d18-87bb-c45d4c71869c","type":"tool.result","phase":"tool","message":"Write finished","detail":"ok (2 chars)"}
{"version":1,"at":"2026-10-27T11:32:33.616Z","source":"claude","taskId":"draft-task","sessionId":"59150391-dab7-4d18-87bb-c45d4c71869c","type":"heartbeat","phase":"waiting","message":"waiting for provider output","detail":"idle 1s"}
{"version":1,"at":"2026-10-27T11:32:34.819Z","source":"claude","taskId":"draft-task","sessionId":"59150391-dab7-4d18-87bb-c45d4c71869c","type":"result","phase":"ending","message":"worker completed","detail":"fixture attempt 1 done (draftSeen=false)"}
```

### Status while the worker was still running

While the worker process was alive, this read-only command was polled roughly
every 100 ms:

```bash
node dist/cli.js supervisor status --repo /tmp/cliyard-continuity-evidence/reuse \
  --run b2f9ce50-25ee-4c0d-84f2-8bcbf5891cb5 --json
```

Two observed snapshots:

```json
{
  "status": "running",
  "accepted": 0,
  "pending": 1,
  "workerProgress": [
    {
      "taskId": "draft-task",
      "event": {
        "version": 1,
        "at": "2026-10-27T11:32:32.517Z",
        "source": "claude",
        "taskId": "draft-task",
        "sessionId": "59150391-dab7-4d18-87bb-c45d4c71869c",
        "type": "tool.start",
        "phase": "tool",
        "message": "tool Write started",
        "detail": "path draft.txt"
      },
      "ageMs": 140,
      "stale": false
    }
  ]
}
```

```json
{
  "status": "running",
  "accepted": 0,
  "pending": 1,
  "workerProgress": [
    {
      "taskId": "draft-task",
      "event": {
        "version": 1,
        "at": "2026-10-27T11:32:33.616Z",
        "source": "claude",
        "taskId": "draft-task",
        "sessionId": "59150391-dab7-4d18-87bb-c45d4c71869c",
        "type": "heartbeat",
        "phase": "waiting",
        "message": "waiting for provider output",
        "detail": "idle 1s"
      },
      "ageMs": 6,
      "stale": false
    }
  ]
}
```

The run stayed `running` with `accepted: 0` while progress was visible. A
heartbeat is a waiting observation; it does not mark the task accepted,
successful, or healthy.

During the fresh-run's live status read, the manifest hash was identical
before and after the status call:

```text
live_status_manifest_before=66c3eb647a4ad37780a5e4a26772cc4e3e04c8b913d8d31c0dbdf3fce1b235b9
live_status_manifest_after =66c3eb647a4ad37780a5e4a26772cc4e3e04c8b913d8d31c0dbdf3fce1b235b9
```

A separate status read against the blocked reuse run also left the manifest
hash unchanged (`51726d63...` before and after). Status did not mutate the
manifest in either measured case.

### Human status after rejection

```text
status: blocked
tasks: accepted 0 / pending 1 / total 1
worker progress: draft-task 2026-10-27T11:32:34.819Z result/ending worker completed - fixture attempt 1 done (draftSeen=false)
reusable attempt: draft-task /tmp/cliyard-continuity-evidence/reuse/.cliyard/worktrees/mvqlw342-draft-task (cliyard/mvqlw342-draft-task @ a9ce87d580175820ab81bc3325ff57852a3fe3fc; rejected 2026-10-27T11:32:34.845Z)
```

### Append-only event log

The event log is append-only and spans attempts of the same task. In the reuse
run it contained: `2 session.start`, `2 assistant`, `2 tool.start`,
`2 tool.result`, `39 heartbeat`, and `2 result` records across the rejected
and resumed attempts. The fresh run's log contained `37 heartbeat` records.
`status` showed only the latest valid event per task.

**Observed behavior:** stream records become visible while the worker is still
running; provider silence produces heartbeat records; `status` reads and
renders the latest event without changing run state. Events are observational
only: acceptance still came from the worker result plus verifier, and stale or
malformed event files cannot change status (covered by the focused tests).

## 5. Timed-out drill child recovery

The public runtime-drill CLI does not expose a child timeout. The measurement
invoked the same `runRuntimeDrill` implementation with `childTimeoutMs: 5000`
and used the documented test-only hang hook:

```bash
CLIYARD_RUNTIME_DRILL_TEST_HANG_AFTER_READY=cleanup-failure \
npx tsx /tmp/cliyard-continuity-evidence/run-abnormal-drill.mts
```

with `outDir: /tmp/cliyard-continuity-evidence/drill-abnormal`,
`portBase: 24800`, and `childTimeoutMs: 5000`. The measurement entry point
called:

```ts
const report = await runRuntimeDrill({
  outDir: "/tmp/cliyard-continuity-evidence/drill-abnormal",
  portBase: 24800,
  childTimeoutMs: 5_000,
  log: (line) => console.log(line),
});
```

The hook applies only to the `cleanup-failure` child, which hangs after
readiness while its service is live and ignores `SIGTERM`.

Observed output:

```text
[runtime-drill] readiness-timeout: ports 24800-24829 (scratch /tmp/cliyard-continuity-evidence/drill-abnormal/readiness-timeout)
[runtime-drill] readiness-timeout: PASS (child exit 0, 1324ms)
[runtime-drill] verify-failure: ports 24830-24859 (scratch /tmp/cliyard-continuity-evidence/drill-abnormal/verify-failure)
[runtime-drill] verify-failure: PASS (child exit 0, 274ms)
[runtime-drill] cleanup-failure: ports 24860-24889 (scratch /tmp/cliyard-continuity-evidence/drill-abnormal/cleanup-failure)
[runtime-drill] timeout: orphan executor scanned 1, reaped 1, needs_human 0, skipped 0
[runtime-drill] cleanup-failure: FAIL (child exit none, 6009ms) recovery=reaped=1
[runtime-drill] report: /tmp/cliyard-continuity-evidence/drill-abnormal/runtime-failure-drills.json
{
  "status": "fail",
  "summary": {
    "total": 3,
    "passed": 2,
    "failed": 1
  },
  "portBase": 24800
}
```

The report was generated at `2026-10-27T11:33:44.732Z`.

| Scenario | Child PID | Exit / signal | Timed out | Duration | Abnormal recovery |
|----------|-----------|---------------|-----------|----------|-------------------|
| `readiness-timeout` | 80592 | 0 / none | no | 1324 ms | `null` (normal path) |
| `verify-failure` | 80629 | 0 / none | no | 274 ms | `null` (normal path) |
| `cleanup-failure` | 80660 | none / `SIGKILL` | yes | 6009 ms | trigger `timeout`, executed |

The abnormal-child termination evidence was:

```json
{
  "sigtermSent": true,
  "sigkillSent": true,
  "termGraceMs": 1000,
  "killGraceMs": 2000,
  "exited": true,
  "detail": "child exceeded 5000ms; SIGTERM sent to child pid; SIGKILL sent to child pid after 1000ms; child exited"
}
```

The child log confirmed the hook armed both stages:

```text
[runtime-drill-child] cleanup-failure: test hook hanging after readiness
[runtime-drill-child] cleanup-failure: test hook ignoring SIGTERM after readiness
```

### Exact orphan executor result

The parent started recovery only after the child was gone, then ran the
existing exact orphan executor against the scenario's scratch control root.
Its report:

```json
{
  "runtimeId": "drill-cleanup-failure-attempt-1",
  "state": "reaped",
  "reason": "owner pid 80660 is not running on this host; 1 service(s) proven live, 0 already exited; terminated 1 group(s), 0 already exited, released 1 exact lease(s); all leased ports bindable",
  "at": "2026-10-27T11:33:44.726Z",
  "reaperPid": 80590,
  "reaperHost": "paofujianlaide-MacBook.local",
  "services": [
    {
      "name": "web",
      "pgid": 80661,
      "action": "terminated",
      "portReleased": true
    }
  ]
}
```

The child ran for the 5000 ms timeout plus the 1000 ms SIGTERM grace and was
reported with a 6009 ms duration and signal `SIGKILL`. Executor totals:
`scanned=1, reaped=1, needsHuman=0, skipped=0`. The persisted runtime manifest
was finalized with:

```json
{
  "runtimeId": "drill-cleanup-failure-attempt-1",
  "cleanup": "complete",
  "stoppedAt": "2026-10-27T11:33:44.726Z",
  "failureReason": null,
  "recovery": {
    "runtimeId": "drill-cleanup-failure-attempt-1",
    "state": "reaped",
    "services": [
      { "name": "web", "pgid": 80661, "action": "terminated", "portReleased": true }
    ]
  }
}
```

The service leader PID/PGID was `80661`, leased port `24860`. After recovery:
the service process and process group were gone, `lsof` showed no listener on
`24860`, the lease store was `{"version":1,"leases":[]}`, and the drill's
post-recovery checks passed for `manifest-cleanup`,
`manifest-recovery-reaped`, `services-process-gone`,
`services-process-group-gone`, `services-port-free`, and `lease-count`.

The manifest's service `signal` and `exitedAt` remained `null` because the
service group was terminated externally by the reaper after the owning child
was killed; the recovery record is the termination evidence in this path.

**Why the report is `fail`:** an abnormal child fails the drill's
`child-exit` check by construction, so the `cleanup-failure` scenario and the
report are `fail` even though all recovery and cleanup checks pass. That is
the intended contrast: the drill never reinterprets a timed-out child as a
passing scenario, and a recovery that needed human review would fail the
recovery checks as well. The normal `readiness-timeout` and `verify-failure`
children kept `abnormalRecovery: null`.

**Exact-rules boundary:** the parent signalled only the drill child PID
(SIGTERM, 1 s grace, SIGKILL). It never signalled the service group. The
executor re-proved owner death, exact pid/pgid/start identity and exact lease
ownership before terminating the group and releasing the lease. In this run
there were zero `needs_human` records.

## 6. Test counts

The focused command and the runtime/recovery group:

```text
npx tsx --test tests/supervisor-attempt-reuse.test.ts tests/claude-progress.test.ts tests/supervisor-worker-progress.test.ts tests/runtime-failure-drills.test.ts
  → 13/13 pass (9769.2 ms)

npx tsx --test tests/contract-runtime.test.ts tests/runtime-ports.test.ts tests/runtime-manager.test.ts tests/runtime-manager-identity.test.ts tests/runtime-process.test.ts tests/runtime-verifier.test.ts tests/runtime-owner-lease-safety.test.ts tests/runtime-recovery-record.test.ts tests/runtime-reaper-plan.test.ts tests/runtime-reaper.test.ts tests/supervisor-runtime-reaper.test.ts tests/supervisor-runtime-recovery-record.test.ts tests/runtime-failure-drills.test.ts
  → 81/81 pass (9968.0 ms)
```

Per-file focused counts: `supervisor-attempt-reuse` 4, `claude-progress` 3,
`supervisor-worker-progress` 3, `runtime-failure-drills` 3.

Full suite:

```text
npm test → 177/177 pass (10887.8 ms)
```

`npm run build` passed before these runs. These are single local runs; they
are not a repeated-run flake rate, CI result, or cross-host claim.

The earlier [RUNTIME_FAILURE_DRILLS.md](RUNTIME_FAILURE_DRILLS.md) records the
suite counts for its own run (2 drill tests, 166 total) and remains the
per-scenario evidence for that run. Those counts are historical; the current
counts are the ones above.

## 7. Remaining limitations

- **Rejected attempts only.** Only a task with a recorded rejection and
  `attemptRejectedAt` is reusable. An interrupted active worker is not
  attached to a second worker; there is no process-ownership design for that.
- **Worktree continuity, not conversation continuity.** Reuse attaches a new
  worker process to the same worktree. Provider conversation/session state is
  not resumed.
- **Fail-closed by design.** A recorded attempt that is missing metadata,
  unregistered, escaping, branch-mismatched, HEAD-mismatched, cross-task, or
  cross-run is refused; the explicit recovery is `--fresh-attempt`. The
  focused test covers a subset of these conditions as separate cases.
- **No worktree garbage collection.** A discarded draft remains on disk after
  `--fresh-attempt`; accepted worktrees are removed (unless kept), but retained
  rejected drafts, runs, branches and manifests accumulate.
- **Events are advisory.** Worker progress is not run authority, is not
  checkpointed with the manifest, has no retention/rotation policy, and only
  the latest valid event per task is shown. `stale` is display-only.
- **Heartbeat is a silence observation.** It shows the adapter is still
  waiting for provider output; it does not prove provider health, progress
  quality, or eventual success.
- **Fixture evidence.** The live progress and continuity measurements used a
  local stream-json fixture, not a real DeepSeek/Claude provider. Provider
  timing, retries, cost and output behavior were not measured here.
- **Drill timeout hook is test-only.** The public CLI does not expose
  `childTimeoutMs`; abnormal-path evidence uses the documented test-only
  environment hook.
- **Abnormal recovery is foreground.** It is tied to the drill parent, not a
  daemon or periodic scanner. It only acts after the abnormal child is gone
  and only through the exact orphan executor's proof rules.
- **No 24-hour/daemon claim.** The supervisor remains foreground and
  single-host; nothing here was run for an extended period.

## 8. Non-goals preserved

This slice does not add and must not be read as evidence for:

- a supervisor daemon, periodic scheduler, background queue, or 24-hour
  unattended operation;
- cross-host runtime recovery, remote kill, or a shared lease store;
- SQLite or another state-store migration (state remains atomic JSON);
- Playwright, axe, screenshot, browser, or accessibility evidence;
- CPU/memory/browser admission scheduling or unlimited parallel runtimes;
- production, cross-run, or cross-repository port coordination;
- automatic merge to `main`, automatic push, or automatic worktree GC;
- Task Architect implementation.

**Next capability:** Task Architect. Durable continuous orchestration remains
a later, separately designed gap. Neither is implemented by this slice.

## Related documents

- [Supervisor v0 operations](../SUPERVISOR_V0.md)
- [RuntimeManager v0](../RUNTIME_MANAGER.md)
- [Next iteration](../NEXT_ITERATION.md)
- Design: [attempt continuity and worker progress v0](../../design/attempt-continuity-progress-v0.md)
- Prior drill evidence: [runtime failure drills](RUNTIME_FAILURE_DRILLS.md)

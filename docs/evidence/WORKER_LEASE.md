# Evidence: WorkerLease v1 and same-host controller-death recovery

Task: `worker-lease-evidence`. Design:
[`design/worker-lease-v1.md`](../../design/worker-lease-v1.md). Implementation:
`src/agents/worker-lease.ts`, with spawn/cleanup integration in
`src/agents/claude.ts`, `src/agents/codex.ts`, `src/repair/loop.ts`,
`src/scheduler/codex-batch.ts` and `src/supervisor/cli.ts`.

Measured on 2026-10-28 at integrated HEAD
`e6f922e46a6ad85416958ef7463467229851247c` (the merge of
`worker-lease-core` into the integration branch), macOS 27.0 (Darwin 27.0.0),
Node `v20.20.2` via `tsx`.

This document records observed behavior only. It does not claim Windows group
parity, cross-host cleanup, stdout reattachment, automatic resume or daemon
support.

## Result in one paragraph

Every Supervisor-backed Claude or Codex invocation writes one strict,
credential-free lease immediately after spawn, persists the exact POSIX
`(pid, pgid, lstart)` identity before its result is accepted, and updates the
same lease with the terminal process-tree cleanup outcome. A separate,
same-host `supervisor recover-workers` command reads those leases, proves
controller death and exact worker identity, and only then terminates the
dedicated worker process group. Live owners, foreign hosts, identity
mismatches, unknown identities and malformed records never signal a process.
Recovery reports a resume need; it never edits a `RunManifest` and never marks a
task accepted.

## Store and schema

One lease is stored per spawned CLI invocation at:

```text
<repo>/.cliyard/worker-leases/<runId>/<taskId>/<leaseId>.json
```

`leaseId` is a random UUID. Directories are created `0700`; the file is written
`0600` through a temporary file, `fsync` and atomic `rename`. The store is
gitignored with the rest of `.cliyard/`.

The exact schema (`WorkerLease` in `src/agents/worker-lease.ts`) is:

```ts
interface WorkerLease {
  version: 1;
  leaseId: string;                 // safe path segment
  repoRoot: string;                // absolute; must equal the resolved store root
  runId: string;
  taskId: string;
  attempt: number;                 // non-negative integer
  invocationId: string;            // unique per spawned CLI invocation
  controller: {
    pid: number;
    host: string;
    identity: RuntimeProcessIdentity; // { pid, pgid, startedAt } captured at attach
  };
  worker: {
    pid?: number;                  // absent only if spawn failed before an OS pid
    pgid?: number;
    osStartIdentity?: string;      // exact `ps lstart`; never synthesized
    captureMode: "posix-group" | "windows-exact-child";
  };
  workspace: string;
  startedAt: string;
  updatedAt: string;
  state: "active" | "released" | "cleanup-failed" | "unknown";
  cleanupReason?: "child-close" | "timeout" | "cancel" | "spawn-error" | "recovery";
  cleanedAt?: string;
  cleanup?: {
    processTreeState: "clean" | "terminated" | "failed" | "unsupported";
    captureSource: "ps-exact" | "pgid-reservation" | "none" | "unsupported";
    residualCount: number;
    signalCount: number;
    detail?: string;
  };
  recovery?: Array<{
    version: 1;
    at: string;
    reaperPid: number;
    reaperHost: string;
    action:
      | "terminated"
      | "already-exited"
      | "preserved"
      | "live-owner"
      | "foreign-host"
      | "invalid";
    outcome: "recovered" | "needs_human" | "skipped";
    reason: string;
    signals: Array<{
      signal: "SIGTERM" | "SIGKILL";
      scope: "process-group";
      at: string;
      result: "sent" | "failed";
      detail?: string;
    }>;
    residualCount?: number;
  }>;
}
```

The lease never contains a prompt, command line, environment value, credential,
provider payload or raw worker output. The focused test serializes an active
lease and asserts that none of `prompt`, `command`, `environment` or `secret`
appears.

### Exact bounds

| Item | Measured bound |
| --- | --- |
| Store | `<repo>/.cliyard/worker-leases/<runId>/<taskId>/<leaseId>.json` |
| `runId` / `taskId` / `leaseId` | `^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$` |
| Lease file | ≤ 65,536 bytes (`MAX_WORKER_LEASE_BYTES`) |
| Leases scanned per status/recovery | ≤ 512 (`MAX_WORKER_LEASES_SCAN`); `truncated` reported |
| Recovery records per lease | ≤ 8 (`MAX_WORKER_LEASE_RECOVERY`) |
| Signal records per recovery record | ≤ 8 |
| Recovery reason / cleanup detail | ≤ 600 chars, whitespace-collapsed (`MAX_WORKER_LEASE_DETAIL`) |
| `invocationId` | 1–128 chars |
| `workspace` | 1–4096 chars |
| `controller.host` / `reaperHost` | 1–256 chars |
| `worker.osStartIdentity` | 1–128 chars |
| Counters (`residualCount`, `signalCount`) | integer 0–100,000 |
| Timestamps | non-empty, ≤ 64 chars, parseable |
| Default recovery grace | 2,000 ms SIGTERM, 1,000 ms SIGKILL, 50 ms poll |
| Status `degradedReasons` | first 32 rendered |

Parsing is strict and fail-closed: a wrong version, unknown state/reason/action
or outcome, relative `repoRoot`, unsafe path segment, missing controller
identity, `pgid` without `pid`, `osStartIdentity` without `pid` + `pgid`,
unparseable timestamp, oversized file or a record whose run/task/lease identity
does not match its storage path is rejected. Malformed leases are never repaired
or trusted; status reports them as degraded and recovery reports
`needs_human`/`invalid`.

### Captured real lease

This lease was produced by the production `createWorkerLeaseAttacher` around a
real detached Node helper in a disposable Git repository. Only the temporary
path and host are abbreviated; other values are verbatim.

```json
{
  "version": 1,
  "leaseId": "1a05eb1f-e462-4d2a-a39b-f03eb7f434b6",
  "repoRoot": "<temp-repo>",
  "runId": "run-sample",
  "taskId": "task-sample",
  "attempt": 0,
  "invocationId": "inv-sample",
  "controller": {
    "pid": 53983,
    "host": "<host>",
    "identity": {
      "pid": 53983,
      "pgid": 53980,
      "startedAt": "Wed Oct 28 06:58:07 2026"
    }
  },
  "worker": {
    "pid": 54057,
    "pgid": 54057,
    "captureMode": "posix-group",
    "osStartIdentity": "Wed Oct 28 06:58:07 2026"
  },
  "workspace": "<temp-repo>",
  "startedAt": "2026-10-28T06:58:07.757Z",
  "updatedAt": "2026-10-28T06:58:07.765Z",
  "state": "active"
}
```

After the production cleanup path (`managed.cleanup("child-close")` followed by
`handle.update(outcome)`), the same file read back as: state `released`,
cleanup reason `child-close`, process-tree state `terminated`, capture source
`ps-exact`, `signalCount` 1. The immutable fields were unchanged.

## Spawn and cleanup write points

1. **Run-scoped wiring.** `codex-batch` creates the attacher only when a
   Supervisor-backed `RunManifest` exists (`requestedManifest`), using that
   manifest's `runId`. Standalone, mock and dry-run paths pass no lease sink.
   `runClosedLoop` forwards the callback into both adapters.
2. **Immediately after spawn.** Each adapter starts `attacher(...)` right after
   `WorkerProcessTreeManager.spawn`, before parsing output or accepting a
   result. The attacher first captures the controller's own exact identity
   (`process.pid`, host, `ps` identity). It then writes a provisional lease:
   - POSIX: `worker.pid` and `worker.pgid = pid` (the managed process is a
     detached group leader), `state: "active"`;
   - no OS pid: no `worker.pid`, `state: "unknown"`.
3. **Exact identity before return.** The attacher awaits
   `managed.captureIdentity()`, then atomically rewrites the same file with
   `worker.pgid` and `worker.osStartIdentity` when the observed pid matches the
   spawned pid. A capture error, absent identity or pid mismatch leaves
   `state: "unknown"`; no identity is guessed or synthesized. The adapter's
   `finishLease` awaits attachment, so a result cannot resolve before this
   write has finished or failed.
4. **Fail closed on persistence failure.** If controller capture or any lease
   write fails, the attacher calls `managed.cleanup("spawn-error")` and rejects.
   The adapter repeats the idempotent cleanup and rejects the attempt. The
   focused test `a lease write failure stops the managed worker and rejects`
   causes `mkdir` to fail and observes cleanup reason `["spawn-error"]`; the
   adapter-level test makes the callback reject and observes a real worker plus
   helper die with `exitCode: 1`, `failure.stage: "spawn"`,
   `failure.code: "spawn_error"`.
5. **Terminal cleanup update.** Adapters call
   `handle.update(processTreeOutcome)` after the managed cleanup on normal close,
   timeout, cancel and spawn error. Normal close uses `child-close`; the timeout
   timer uses `timeout`; `cancel` uses `cancel`; spawn/error paths use
   `spawn-error`. `update` re-reads the file, verifies every immutable identity
   field, applies the cleanup evidence, and atomically writes the same lease.
   Repeated updates are idempotent.

The resulting lifecycle state is derived, not accepted from the worker:

- `cleanup-failed` when `treeOk` is false or process-tree cleanup state is
  `failed`;
- `unknown` when the lease is not a POSIX group capture, the cleanup outcome has
  no POSIX group support, exact pid/pgid/start identity is missing, or capture
  source is `none`/`unsupported` (a short-lived worker never becomes
  `released`);
- `released` otherwise.

Measured lifecycle tests: exact identity plus idempotent cleanup update; timeout
and cancel persisted on the same lease; spawn-error persisted with `unknown`;
short-lived worker stays `unknown` with no `osStartIdentity`; another focused
test runs real Claude and Codex adapter paths with fake CLI binaries and observes
one `released`/`child-close` lease each with `worker.pid === worker.pgid` and a
real `osStartIdentity`.

## Status projection

`supervisor status` adds a read-only `workerLeases` projection:

- counts `active`, `released`, `cleanupFailed`, `unknown`, `malformed`, `total`;
- latest lease per task, with task, attempt, invocation, controller state
  (`alive`, `dead`, `foreign-host`, `unknown`), worker identity/capture mode,
  cleanup reason and latest observation;
- `missing` for a task that has durable attempt evidence or is
  `running`/`verifying`/`repairing` but has no valid lease;
- `degraded` plus reasons for malformed records, missing expected leases or a
  truncated scan.

It is observational only: it never changes counts, `effectiveStatus`, task
acceptance or the manifest. The test
`supervisor status JSON exposes the bounded worker lease projection` observes
one active lease for `task-a`, no lease for `task-b` reported as missing/degraded,
and an accepted task with no lease not reported as missing.

## Controller-death recovery

Command:

```bash
cliyard supervisor recover-workers --repo <path> [--run <run-id>] [--json]
```

It is a one-shot same-host command. It does not acquire the Supervisor lock or
run a service. `--run` limits the scan; `--json` prints the full
`WorkerLeaseRecoveryReport`. The command prints the report and returns `0`;
`needs_human` is report data, not an exit code, so an operator or script must
inspect `needsHuman`/`entries`.

For each bounded lease the observed decision order is:

1. Non-`active` leases are skipped and preserved.
2. Malformed records become `needs_human`/`invalid`; the file is untouched.
3. A controller host that is not this host (after trim/case normalization) is
   skipped as `foreign-host` without controller inspection or any signal.
4. Controller liveness: same-host pid liveness, then exact identity capture.
   `match` is a live owner; `mismatch` means the recorded controller identity is
   gone (the pid now belongs to an unrelated process) and is treated as dead; an
   uninspectable controller is `unknown` and is preserved as `needs_human`.
5. For a dead controller, recovery requires all of: capture mode `posix-group`,
   exact `pid`, `pgid`, `osStartIdentity`, and `pgid === pid` (the worker was the
   dedicated group leader). The current leader identity must still be
   capturable and must match the lease exactly.
6. Group membership is re-listed and guarded: valid pgid greater than 1, not
   cliyard's own pid/group, every member in the same pgid, no member is the
   recovery process, and the exact leader identity is present and matching.
7. `SIGTERM` is sent to the negative pgid (`process.kill(-pgid, …)`), then
   recovery polls for up to 2,000 ms. If members remain it re-runs the guard and
   sends `SIGKILL`, polling up to 1,000 ms.
8. Recovered groups are reported as `recovered`/`terminated` (or
   `already-exited`), the lease becomes `released` with cleanup reason
   `recovery`, a bounded recovery record is appended, and the task invocation is
   listed in `resumeNeeded`.
9. Any missing/mismatched identity, failed signal, uninspectable membership or
   residual group after SIGKILL yields `needs_human`/`preserved`; the lease and
   processes remain except that a verified-but-still-residual group records
   `cleanup-failed`. No signal is ever sent without the exact identity proof.

Recovery writes only the lease. It never writes a `RunManifest`, never marks a
task accepted and never starts a replacement attempt. The real SIGKILL fixture
asserts that no `.cliyard/runs` directory is created by recovery.

### Safety matrix

| Case | Observed decision | Signals | Lease/process effect | Evidence |
| --- | --- | --- | --- | --- |
| Live owner: same-host controller pid and exact identity match | `skipped` / `live-owner` | none | Lease file byte-identical; processes untouched | Focused test `recovery skips a live matching controller and preserves the lease` |
| Dead owner: controller gone, verified dedicated POSIX group alive | `recovered` / `terminated` | group `SIGTERM`, then group `SIGKILL` only if the TERM grace expires | Group gone; lease `released`, reason `recovery`, recovery record, `resumeNeeded` | Focused fake-inspector test `recovery escalates TERM to KILL only inside the verified group`; real SIGKILL fixture below |
| Wrong host: controller host is foreign | `skipped` / `foreign-host` | none | No controller inspection; lease untouched | Focused test `recovery skips a foreign-host controller without inspection` |
| Identity mismatch: worker pid exists but exact OS start identity differs | `needs_human` / `preserved` | none | Lease stays `active`; processes preserved; recovery record appended | Focused test `recovery preserves processes on a mismatched or missing worker identity` |
| Unknown identity: worker lease has no exact pid/pgid/start identity | `needs_human` / `preserved` | none | Lease stays `active`; no identity invented | Same focused test; short-lived-lease test keeps `state: "unknown"` |
| Unknown identity: leader identity absent before recovery can prove it | `needs_human` / `preserved` | none | Processes and lease preserved | Implemented guard; this branch is not directly isolated by a committed test |
| Controller pid alive but recorded identity differs | Treated as dead, then the full exact-worker-identity path applies | none unless worker identity also matches | Worker group preserved unless all worker proofs pass | Implemented decision; not directly isolated by a committed test |
| Controller liveness/identity uninspectable | `needs_human` / `preserved` | none | Lease untouched; no recovery record appended | Implemented decision; not directly isolated by a committed test |
| POSIX group | Only `pgid === pid` with exact leader identity and consistent membership is signalled; cliyard's own pid/group is refused | group-only | Verified group terminated; otherwise preserved | Real fixture uses a real detached group; guard rejection branches are not all separately tested |
| Windows exact-child | `needs_human` / `preserved`; no recoverable POSIX group | none | Lease preserved; no group claim | Implemented guard (`captureMode !== "posix-group"`); no Windows run or test was performed in this slice |
| Malformed lease | `needs_human` / `invalid` | none | File untouched | Focused test `malformed leases are degraded evidence and recovery needs a human` |
| Already released/skipped lease | `skipped` / `preserved` | none | Lease unchanged | Focused test `recovery is idempotent after a lease is released` |
| Verified group already gone with leader still capturable | `recovered` / `already-exited` | none | Lease `released`, `resumeNeeded` | Implemented branch; not directly isolated by a committed test |

Recovery evidence is append-only and bounded to 8 records. A failure to persist
that evidence is reported (`leaseUpdated: false` and an amended reason) without
pretending the decision did not happen; it does not change `RunManifest`.

## Real SIGKILL fixture

Test:
`a new recover-workers invocation kills only a SIGKILLed controller's exact worker group`
(POSIX only; skipped on `win32`).

The fixture starts a controller child process that:

1. spawns a real detached Node helper through `WorkerProcessTreeManager`;
2. attaches a real lease through `createWorkerLeaseAttacher`;
3. writes `ready.json` containing the controller pid, worker pid and lease path;
4. idles.

The test waits for readiness, reads the lease and asserts it is `active` with the
helper pid and an exact `osStartIdentity`. It then sends `SIGKILL` to the
controller without any cleanup, waits until the controller is dead, and asserts
the helper is still alive and the lease is still `active`.

A fresh CLI invocation then runs:

```bash
node --import tsx src/cli.ts supervisor recover-workers \
  --repo <fixture-repo> --run run-real-recovery --json
```

Measured assertions:

- CLI exit `0`;
- report `recovered: 1`, `needsHuman: 0`;
- `resumeNeeded[0].taskId: "task-real"`;
- entry action `terminated`, worker state `terminated`;
- the real helper is no longer alive;
- the lease reads back `released`, cleanup reason `recovery`,
  `recovery[0].action: "terminated"`;
- no `.cliyard/runs` directory exists, proving recovery did not create or rewrite
  a `RunManifest`.

The isolated fixture passed `1/1` in 241.49 ms; it is also part of the focused
suite below. No stdout was reattached and no provider API was called.

## Test and build record

Commands run from the worktree at HEAD
`e6f922e46a6ad85416958ef7463467229851247c`:

```text
npm run build
  exit 0

node --import tsx --test tests/worker-lease.test.ts
  tests 19, pass 19, fail 0, skipped 0, duration 4652.976708 ms

node --import tsx --test --test-name-pattern="SIGKILLed controller" tests/worker-lease.test.ts
  SIGKILL fixture: pass 1, fail 0, duration 241.492208 ms (18 pattern-skips)

npm test
  tests 394, pass 394, fail 0, cancelled 0, skipped 0, duration 25657.976208 ms
```

The 19 focused tests are the 19 new `tests/worker-lease.test.ts` tests; the
previous recorded full-suite count of 375 plus these 19 equals the measured 394.
This is one local macOS run, not a CI, flake-rate or long-term stability claim.

## Limits (not overclaimed)

- **Same host only.** Foreign-host leases are skipped and reported; no
  cross-host inspection, kill or cleanup is implemented.
- **POSIX group only.** Recovery refuses `windows-exact-child` (and any other
  non-POSIX capture) and preserves the lease. Windows Job Objects and Windows
  process-tree parity are not implemented; no Windows execution was measured.
- **No stdout reattachment.** Recovery terminates an orphaned group and reports
  a resume need; it never reattaches the old CLI stream.
- **No automatic resume.** `resumeNeeded` is report data. A new attempt or
  provider-session continuation remains an explicit operator/Supervisor action.
- **No worker survival guarantee.** A worker may exit before identity capture;
  the lease then remains `unknown` and cannot be safely recovered by identity.
- **`RunManifest` remains task authority.** The lease and recovery report are
  observational evidence. Neither recovery nor status marks tasks accepted or
  rewrites run/task state.
- **No daemon.** `recover-workers` is a one-shot foreground command. There is no
  supervisor service, periodic scan or background reconciliation.
- **Coverage gaps.** The `already-exited` branch, controller-identity-mismatch
  branch, uninspectable-controller branch and most dedicated-group guard
  rejection branches are implemented but not directly isolated by the committed
  lease tests. The realistic case where the leader is already absent before
  recovery observes it is deliberately `needs_human`, not `already-exited`.
- **Truncated scans do not stop recovery.** A scan over 512 leases sets
  `truncated` and recovery processes only the leases it read; no completeness
  claim is made for larger stores.
- **Evidence persistence failure is not hidden.** If recovery cannot append its
  observation, the report says the lease was not updated; the process decision
  is still reported.
- **Standalone and mock batches do not write leases.** Only Supervisor-backed
  runs (`requestedManifest`) create the attacher; this slice did not add lease
  semantics to standalone workflows.
- **No paid provider run.** Adapter evidence uses fake CLI binaries; the real
  controller-death fixture uses real Node processes. Lease capture itself is
  credential-free and never stores provider output.
- **Not a green-gate claim.** One full-suite run passed locally; no CI,
  multi-run flake rate, soak or cross-platform matrix exists.

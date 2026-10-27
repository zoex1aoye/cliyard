# RuntimeManager v0

> Status: implemented (single host, local repository, finite verification services).
>
> Design authority: [design/runtime-manager-v0.md](../design/runtime-manager-v0.md).
> This document describes the behavior that is actually implemented in
> `src/runtime/types.ts`, `src/runtime/ports.ts`, `src/runtime/manager.ts`, and
> `src/verification/verifier.ts`.
>
> Crash recovery for runtime services lives in a separate component:
> [RUNTIME_ORPHAN_RECOVERY.md](RUNTIME_ORPHAN_RECOVERY.md).

RuntimeManager moves service lifecycle and temporary-port ownership out of
Workers and into the Verifier. A Worker may create a server entry point; it
must not start a long-lived service or choose an acceptance port.

```text
Worker exits
  → implement gate + path gate pass
  → PortAllocator leases one 127.0.0.1 port per runtimeId + service
  → RuntimeManager starts each service from the exact task worktree
  → HTTP readiness succeeds (process alive, expected status, before deadline)
  → verifyCommands run with service URL env vars
  → RuntimeManifest + service logs persisted under the control repo
  → whole service process group stopped, port release confirmed, leases released
```

This is a single-host, single-repository facility. It is not a daemon, queue,
cloud runtime, or browser-test runner.

If the control process is hard-killed while services are running,
RuntimeManager cannot run its cleanup. The detached group, stale lease, and
unfinished manifest are reconciled by the separate orphan reaper, which is
invoked explicitly or by a new supervisor `start`/`resume`; it never runs as a
daemon. See [RUNTIME_ORPHAN_RECOVERY.md](RUNTIME_ORPHAN_RECOVERY.md).

## Quick start

The checked-in example starts one finite Node HTTP service with an inline
script and gates acceptance on the leased URL:

```bash
npm run mock-loop -- examples/runtime-verifier.contract.json \
  --real-verify --fail-verify-times 0
```

No Worker CLI is required for that command; the mock Worker supplies the
implement result and the shell Verifier starts the real runtime. `mock-loop`
builds the shell Verifier with defaults, so the control repo and service
worktree are the current directory; run it from the repository root. Optional
port range override:

```bash
CLIYARD_PORT_RANGE=21800-21899 npm run mock-loop -- \
  examples/runtime-verifier.contract.json --real-verify --fail-verify-times 0
```

After the run, the acceptance `runtimeId` is
`runtime-verifier-smoke-attempt-1`, and the generated evidence is under:

```text
.cliyard/runtime/runtime-verifier-smoke-attempt-1/
  runtime-manifest.json
  web.log
  data/web/
.cliyard/runtime/port-leases.json      # empty after cleanup
```

This example was run on 2026-10-27 with `CLIYARD_PORT_RANGE=21850-21899` in a
temporary working directory: verdict `accepted`, final manifest
`cleanup: "complete"`, the leased port was free afterward, and
`port-leases.json` was empty.

The same contract can be used with `claude-batch`/`codex-batch` against a real
repository. In that path the service starts from the task worktree and
`verifyCommands` run there too.

## Runtime failure drills

`cliyard runtime-drill` drives the three known RuntimeManager failure paths in
three independent OS child processes:

| Scenario | Expected result |
|----------|-----------------|
| `readiness-timeout` | The service listens but never reaches the expected status; `verifyCommands` are skipped and the runtime is stopped. |
| `verify-failure` | Readiness succeeds, then a `verifyCommand` exits with code 7. |
| `cleanup-failure` | Readiness succeeds, then an injected lease-release failure rejects the runtime API with `RuntimeCleanupError`. |

```bash
npm run runtime-drill -- --out <directory> --port-base 22800 --json
npm run dev -- runtime-drill --out <directory> --port-base 22800
node dist/cli.js runtime-drill --out <directory> --port-base 22800 --json
```

Defaults: `--out .cliyard/runtime-drills/<UTC timestamp>-<pid>/`, port base
`22800`. Each scenario owns a disjoint 30-port subrange (`base..base+29`,
`base+30..base+59`, `base+60..base+89`); the whole range is validated before
any child starts. The output directory must be missing or empty.

Artifact layout:

```text
<out>/
  runtime-failure-drills.json          version-1 report: verdicts, child pids,
                                       manifests, ports, leases and checks;
                                       abnormalRecovery when the parent had to
                                       terminate/reconcile a child
  <scenario>/
    child.log
    child-result.json                  child-observed evidence and self-checks
    control/.cliyard/runtime/<runtimeId>/
      runtime-manifest.json
      web.log
      data/web/
    worktree/                          fixture service and verify scripts
```

The parent independently checks each child exit status, the persisted manifest,
service logs, process and process-group state, port bindability, and the lease
store. The command exits `0` only when all three scenarios match their expected
failure and retain evidence; an expected task rejection is never reinterpreted
as acceptance. An abnormal child always leaves its scenario failing (see
below), so even a successful recovery does not turn the report into a pass.

Measured on 2026-10-27 for the normal path: 3/3 scenarios passed, every service
was gone and every leased port was free afterward, and `cleanup-failure`
retained exactly one lease as failed-cleanup evidence while its service was
gone and its port free. Full details:
[docs/evidence/RUNTIME_FAILURE_DRILLS.md](evidence/RUNTIME_FAILURE_DRILLS.md).

### Abnormal child recovery

If a drill child times out, is signalled, fails to spawn, or exits non-zero,
the parent takes a separate recovery path:

1. It terminates only the drill **child PID** — `SIGTERM`, a 1 s grace, then
   `SIGKILL`, with a bounded wait after the kill. It never signals a service
   process group itself.
2. Recovery starts only after the child is gone. A live child leaves
   `executed: false` and an error, which fails the drill.
3. The existing exact orphan executor runs against that scenario's scratch
   control root. It re-proves owner death, exact pid/pgid/start identity and
   exact lease ownership before terminating anything.
4. The recovery report is persisted under `abnormalRecovery` in
   `runtime-failure-drills.json` (trigger, termination evidence, executor
   report or error).
5. The normal manifest/log/process/port/lease checks are re-run against the
   recovered state. Any `needs_human` record or failed cleanup fails the
   scenario.
6. An abnormal child still fails the drill's `child-exit` check by design, so
   it is never reinterpreted as accepted or as a passing scenario.

The public CLI does not expose a child timeout. The abnormal path is exercised
through the test-only environment hook
`CLIYARD_RUNTIME_DRILL_TEST_HANG_AFTER_READY`, which makes the selected child
hang after readiness and ignore `SIGTERM`; tests pair it with a short
`childTimeoutMs` in `runRuntimeDrill`.

Measured on 2026-10-27 with `portBase: 24800`, `childTimeoutMs: 5000`, and the
hook selecting `cleanup-failure`: the report was `fail` with
`{ total: 3, passed: 2, failed: 1 }` (the timeout scenario cannot pass its
child-exit check). The abnormal child timed out at 5000 ms, ignored the 1000 ms
SIGTERM grace, and was recorded as signal `SIGKILL` with duration 6009 ms; the
executor reported `scanned=1, reaped=1, needs_human=0, skipped=0` for
`drill-cleanup-failure-attempt-1`; the manifest ended with
`cleanup: "complete"` and a `reaped` recovery record; leases were `0`; the
service process/group was gone and port `24860` was free. The service manifest's
`signal`/`exitedAt` stayed `null` because the reaper terminated the group
externally after the child died; the recovery record is the termination
evidence. Exact commands, output and the child-log hook lines:
[docs/evidence/ATTEMPT_CONTINUITY_PROGRESS.md](evidence/ATTEMPT_CONTINUITY_PROGRESS.md).

The drill is a foreground diagnostic and regression tool. It is not a daemon,
cross-host runner, browser-evidence producer, or production port coordinator,
and it does not change the orphan reaper's ownership or `needs_human` rules.

## RuntimeSpec contract

`TaskContract.runtime` is optional. When absent, verification keeps the
previous static behavior. When present, the contract loader and plan compiler
validate it and preserve it unchanged on the frozen contract.

```ts
interface RuntimeSpec {
  services: RuntimeServiceSpec[];
}

interface RuntimeServiceSpec {
  name: string;
  command: string[];
  cwd?: string;
  portEnv?: string;
  urlEnv?: string;
  readiness?: {
    path?: string;
    expectedStatus?: number;
    timeoutMs?: number;
  };
}
```

| Field | Required | Meaning | Default / validation |
|-------|----------|---------|----------------------|
| `services` | yes | Non-empty list of finite services. | Empty/missing is rejected. |
| `name` | yes | Unique service name, also used as a path segment and env-var suffix. | Starts with a letter/digit; only letters, digits, `.`, `_`, `-`; max 64 in a contract (RuntimeManager accepts up to 128). |
| `command` | yes | argv array, never a shell string. | Non-empty array of non-empty strings; no NUL. |
| `cwd` | no | Working directory for the service. | Contract requires a repository-relative path with no `..`; RuntimeManager resolves it under the task worktree and rejects escapes. |
| `portEnv` | no | Environment variable that receives the leased port. | `PORT`. Must be a valid env name. |
| `urlEnv` | no | Extra compatibility alias for the service URL. | none. Must be a valid env name. |
| `readiness.path` | no | Absolute HTTP path probed for readiness. | `/`. Must start with one `/`, no whitespace or backslash. |
| `readiness.expectedStatus` | no | HTTP status that means ready. | `200`. Contracts require a positive integer; RuntimeManager enforces 100–599. |
| `readiness.timeoutMs` | no | Readiness deadline. | `30000`. Positive number. |

Notes:

- Unknown fields are ignored, not rejected; only the fields above are read.
- `runtime: null` is treated as absent by the contract loader and plan compiler.
- Plan compilation prefixes validation errors with the task path (for example
  `tasks[0].runtime.services[0].command`) and does not rewrite the spec.
- A service-specific `cwd` must stay inside the task worktree. It cannot point
  at the control repository or a sibling task worktree.

Example service:

```json
{
  "runtime": {
    "services": [
      {
        "name": "web",
        "command": ["node", "server.cjs"],
        "portEnv": "PORT",
        "urlEnv": "WEB_URL",
        "readiness": {
          "path": "/health",
          "expectedStatus": 200,
          "timeoutMs": 10000
        }
      }
    ]
  }
}
```

### Environment variables

For each service, the suffix is the uppercase service name with every run of
non-alphanumeric characters replaced by `_` and leading/trailing `_` removed.
For example `web` → `WEB`, `api-server` → `API_SERVER`, `web.api` → `WEB_API`.

| Variable | Received by | Value |
|----------|-------------|-------|
| `CLIYARD_<SUFFIX>_URL` | Every service process **and** every `verifyCommand` | `http://127.0.0.1:<leased-port>` |
| `<urlEnv>` (when configured) | Every service process **and** every `verifyCommand` | Same URL as above |
| `<portEnv>` (default `PORT`) | That service process only | Leased port as a string |
| `CLIYARD_<SUFFIX>_DATA_DIR` | That service process only | `<runtimeDir>/data/<service>` |
| `CLIYARD_PORT_RANGE` | PortAllocator (control process) | Lease range override, see below |

Additional rules:

- Every service receives every service's URL variable, so services can call
  each other from their first request.
- `verifyCommands` receive the base verifier environment plus URL variables
  only. They do not receive `portEnv` or the `DATA_DIR` variable unless those
  were already present in the base environment.
- An alias may not collide with another service's injected URL variable.
- A `portEnv` may not collide with an injected URL variable; the spec is
  rejected because the URL would otherwise be masked.
- Services are expected to bind `127.0.0.1` and honor `portEnv`. The manager
  probes `127.0.0.1:<leased-port>`; it cannot discover a service that chooses a
  different port.

## Port leases

The default lease range is **19000–19999** (inclusive). Override it with
`CLIYARD_PORT_RANGE="start-end"` or with the allocator's explicit `range`
option; an explicit option wins over the environment.

- `"19000-19999"` → valid range.
- `"19080-19080"` → valid single-port range.
- Values must be integers with `1 <= start <= end <= 65535`; otherwise startup
  fails with a range error.

Persistent paths, relative to the control repository root:

```text
.cliyard/runtime/port-leases.json   lease store (version 1, JSON)
.cliyard/runtime/port-leases.lock   cross-process mutation lock
```

Lease identity is `runId:service`; RuntimeManager passes its `runtimeId` as
`runId`. A lease records `key`, `runId`, `service`, `host` (`127.0.0.1`),
`port`, owner `pid`, and `acquiredAt`.

The recorded `pid` is the control-process PID that acquired the lease. Orphan
recovery requires `lease.pid === manifest.owner.pid`; any other owner — live or
dead — is `needs_human`. A dead third-party lease is evidence, not permission to
reap. See [RUNTIME_ORPHAN_RECOVERY.md](RUNTIME_ORPHAN_RECOVERY.md).

Allocation semantics:

- Load–modify–save and bind probes run under one cross-process lock
  (`O_EXCL`, owner pid/host/token in the lock file, 15 s default wait). A
  same-host lock whose owner pid is gone is reclaimed; a foreign or unreadable
  lock is abandoned only after 5 minutes of age.
- Re-allocating the same `runtimeId + service` while the recorded owner pid is
  alive returns the same lease and port.
- A lease whose owner pid is gone is reclaimable on the same host; liveness is
  local-pid-based, so this store must not be shared across machines. This is an
  allocation concern; orphan recovery additionally requires
  `lease.pid === manifest.owner.pid`.
- A port is checked by binding `127.0.0.1:<port>` (2 s probe timeout) and is
  reserved before the service spawns.
- Occupied ports are skipped. If the range is exhausted,
  `NoAvailablePortError` fails startup.
- Release is idempotent and removes only the exact lease.
- The store is replaced atomically through a temp file and `rename`, so readers
  see a complete old or new store.
- A corrupt or unsupported-version store is reported and never overwritten.

Probe-then-reserve has a deliberate race: an unleased process can bind the port
between the probe and the child's bind. RuntimeManager handles **one**
`EADDRINUSE` retry per service. Evidence is a spawn error with code
`EADDRINUSE`, or a child that exited and whose new log tail contains
`EADDRINUSE`. The failed lease is released, the old port is held while the
allocator picks a different port, and the service is started again. A second
`EADDRINUSE` fails the runtime.

Lease range size is a concurrency bound, not a promise of unlimited parallel
runtimes: each running service needs one port, and host CPU/memory limits still
apply. There is no admission scheduler.

## Startup, readiness, and verify commands

The shell Verifier runs runtime services only after:

1. the Worker's implement result has `exitCode === 0`, and
2. the path gate passes (`touchedPaths` do not overshoot `writePaths`).

Mock verification and batch `--dry-run` never start a runtime.

Startup procedure:

1. Validate the worktree exists and is a directory.
2. Validate the RuntimeSpec.
3. Create `.cliyard/runtime/<runtimeId>/` and `data/`.
4. Allocate a lease for every service and persist an initial manifest.
5. Spawn services **sequentially**, each in its own process group on POSIX,
   with stdout/stderr appended to `<runtimeId>/<service>.log`. The log begins
   with the runtime id, service name, start time, argv, and cwd.
6. Wait for readiness service by service.
7. Persist the ready manifest and return a session.

Readiness is ready only when all of these hold:

- the child process is still alive;
- `GET <url><readiness.path>` returns exactly `expectedStatus` before the
  deadline;
- the child is still alive immediately after that response.

Readiness probes use HTTP only, do not follow redirects, ignore the response
body, and are recorded in the manifest. The default poll interval is 100 ms;
each request is capped at 2 s or the remaining deadline. Probe history is kept
when the single `EADDRINUSE` retry changes the port. Readiness failure includes
the service log tail in the error and stops all started services before
`verifyCommands` run.

Once ready, every `verifyCommand` runs with the runtime URL variables above.
Commands run sequentially, stop at the first failure/timeout, and share the
verifier's `cwd` (the task worktree in batch/supervisor runs). A runtime without
`verifyCommands` is accepted when the runtime is ready, cleanup succeeds, and
the path gate passed.

If runtime startup fails, `verifyCommands` are skipped, verification fails, and
the manifest (when it exists) is returned as evidence.

## Artifacts and evidence

All runtime evidence lives under the **control repository**, not inside the
disposable task worktree:

```text
<repoRoot>/.cliyard/runtime/<runtimeId>/
  runtime-manifest.json
  <service>.log
  data/<service>/
```

`runtimeId` defaults to `<taskId>-attempt-<n>` and must be a safe single path
segment. The shell Verifier derives `<prefix>-<taskId>-attempt-<n>` when given a
prefix (the Supervisor passes its `runId`), sanitizes unsupported characters,
and truncates to 128 characters. `attempt` is 1-based and increments per
verification call, so a repair gets a new runtime directory.

`<repoRoot>/.cliyard/runtime/port-leases.lock` guards lease-store mutations;
`<repoRoot>/.cliyard/runtime/reaper.lock` exists only while orphan
reconciliation is running.

Manifest shape (version 1):

```jsonc
{
  "version": 1,
  "runtimeId": "run-42-task-web-attempt-1",
  "taskId": "task-web",
  "attempt": 1,
  "worktree": "/path/to/task-worktree",
  "owner": { "pid": 12345, "host": "workstation" },
  // "artifactHash": "<sha256>",  // optional; the shell Verifier does not set it
  "services": [
    {
      "name": "web",
      "host": "127.0.0.1",
      "port": 19000,
      "pid": 1234,
      "pgid": 1234,
      "processIdentity": {
        "pid": 1234,
        "pgid": 1234,
        "startedAt": "Mon Oct 27 10:00:00 2026"
      },
      "url": "http://127.0.0.1:19000",
      "healthUrl": "http://127.0.0.1:19000/health",
      "logPath": ".../web.log",
      "dataDir": ".../data/web",
      "readinessAttempts": [
        { "at": "ISO-8601", "url": ".../health", "status": 200, "ok": true }
      ],
      "startedAt": "ISO-8601",
      "exitedAt": "ISO-8601",
      "exitCode": null,
      "signal": "SIGTERM",
      "error": "optional failure detail"
    }
  ],
  "startedAt": "ISO-8601",
  "stoppedAt": "ISO-8601",
  "cleanup": "complete",       // pending | running | complete | failed
  "failureReason": "optional",
  "recovery": {                // optional; written only by the orphan reaper
    "runtimeId": "run-42-task-web-attempt-1", // new records; legacy may omit
    "state": "reaped",         // reaped | needs_human | skipped
    "reason": "...",
    "at": "ISO-8601",
    "reaperPid": 23456,
    "reaperHost": "workstation",
    "services": [
      {
        "name": "web",
        "pgid": 1234,
        "action": "terminated", // terminated | already-exited | preserved
        "portReleased": true
      }
    ]
  }
}
```

Recovery identity fields:

- `owner.host` is `os.hostname()`, not the `127.0.0.1` bind host recorded on a
  port lease. Manifests written before this field existed have no owner and
  fail closed during orphan recovery.
- `pid` and `pgid` are recorded immediately after spawn; POSIX services are
  spawned detached, so the leader pid is the group id and the two must be
  equal. `processIdentity` is captured at the same time from
  `ps -p <pid> -o pid=,pgid=,lstart=` and persisted before readiness.
- `processIdentity.startedAt` is the OS-reported start identity, not
  `manifest.startedAt` or any wall-clock value. It is what distinguishes the
  original process from a reused PID. The field is absent when identity capture
  is unsupported (for example on Windows), and absence means unknown.
- `recovery.runtimeId` names the runtime the record describes. Every new
  executor record sets it. It is optional only for records written before the
  field existed; `status` then falls back to the manifest `runtimeId`, then the
  runtime directory name. The Supervisor does not reconstruct ids from reason
  text.
- `recovery` is appended by the orphan reaper during reconciliation; it is not
  written by the normal RuntimeManager path.

The Verifier returns `VerifyResult.runtime` with `runtimeId`, `manifestPath`,
and the manifest for in-process callers. The ledger stores the verification log
(`lastVerifyLog`) but does **not** embed the runtime manifest; the manifest file
above is the durable runtime evidence. Runtime artifacts and the lease store are
under gitignored `.cliyard/` and have no retention policy.

## Cleanup

Cleanup is owned by the control path and uses `finally` semantics:

1. Stop services in reverse start order.
2. On POSIX, send `SIGTERM` to the full service process group; wait up to 5 s.
3. Escalate to `SIGKILL` and wait up to 5 s; kill surviving helpers.
4. Confirm the leased port no longer accepts connections (up to 5 s, 50 ms
   polls). This check is skipped when the failure was a foreign `EADDRINUSE`
   listener.
5. Release the lease.
6. Persist the final manifest with `cleanup: "complete"` or `"failed"` and a
   `stoppedAt` timestamp.

The shell Verifier calls `session.stop()` even when a verify command fails or
the command loop throws. A cleanup failure makes verification fail even if the
commands passed. `RuntimeManager.run()` applies the same guarantee around a
callback and reports an `AggregateError` if the callback and cleanup both fail.
`session.stop()` is idempotent; repeated calls return the same final manifest.

On startup failure, cleanup runs before the `RuntimeStartError` is surfaced.
It attempts to stop every started group and release every allocated lease; if
cleanup itself fails, that failure is appended to the surfaced error.

`SIGKILL`, host death, and any `process.exit` path that bypasses the verifier's
`finally` do not run this sequence. They can leave a detached group, a stale
lease, and a manifest at `cleanup: "pending"`/`"running"`. Cleanup is not
retried by a daemon; the orphan reaper is the recovery path.

## Orphan recovery integration

`RuntimeManager` records the `owner`, service `pid`/`pgid`, and exact
`processIdentity` needed by orphan recovery. The destructive work is performed
by a separate reaper and is never automatic in the background:

```bash
# Explicit reconciliation of every runtime manifest in the repository
cliyard supervisor reap --repo <path> [--json]

# start and resume reconcile proven orphans after acquiring the supervisor
# lock and before creating a run or marking a run running
cliyard supervisor start <contracts.json> --repo <path> --worker claude
cliyard supervisor resume --repo <path> --worker claude
```

Reconciliation has three outcomes:

| Outcome | Runtime effect |
|---------|----------------|
| `reaped` | Proven groups stopped or already exited, ports confirmed bindable, exact leases released, manifest finalized `cleanup: "complete"` with a recovery record. |
| `needs_human` | Any identity, group, port, lease, or manifest uncertainty. Evidence is preserved; executor-detected failures leave `cleanup: "failed"` when the recovery record can be written. `start`/`resume` fail closed while the candidate remains unsafe. |
| `skipped` | No local action: already complete/reaped, foreign-host owner, or owner still alive. |

A `safe_to_reap` plan also requires exact lease ownership: the lease PID must
equal `manifest.owner.pid`. A lease owned by a different PID is `needs_human`
whether that PID is alive or dead, and the process group, lease, and manifest
are preserved.

`status` is read-only and only exposes recovery records already persisted in
runtime manifests. It never scans, signals, releases, or rewrites.

The safety rule, persisted identity fields, crash windows, incident checklist,
and remaining gaps are documented in
[RUNTIME_ORPHAN_RECOVERY.md](RUNTIME_ORPHAN_RECOVERY.md).

## Integration behavior

| Situation | Runtime started? | Verification result |
|-----------|------------------|---------------------|
| No `runtime` in contract | No | Existing static verify behavior |
| Mock verifier / batch `--dry-run` | No | Mock/path-gate behavior; runtime ignored |
| Worker implement exit != 0 | No | Rejected before runtime |
| Path overshoot | No | Rejected before runtime |
| Runtime not ready | Yes, then stopped | Fail; `verifyCommands` skipped; manifest evidence when available |
| Commands fail | Yes, then stopped | Fail with command exit code |
| Cleanup fails | Yes | Fail even if commands passed |
| Ready + commands pass | Yes, then stopped | Accept |
| Ready + no `verifyCommands` | Yes, then stopped | Accept when cleanup and path gate pass |

## Current limitations

- **Single host / local repo only.** Port liveness uses local pids; do not share
  the lease store over a network filesystem. Orphan recovery is local-only too:
  a foreign-host owner is `skipped`, never killed remotely.
- **Crash cleanup requires reconciliation.** A hard kill or a bypassed
  `finally` leaves the group, lease, and manifest behind; there is no daemon or
  periodic retry. Run `supervisor reap` or the next `start`/`resume` to
  reconcile it.
- **Leader-dead groups need a human.** If the recorded leader exited but its
  process group still has members, ownership cannot be proven; the reaper
  reports `needs_human` and preserves the group and lease.
- **No daemon-based cleanup.** Reconciliation is explicit or tied to
  `start`/`resume`; nothing sweeps orphans while cliyard is idle.
- **Finite services only.** Each acceptance attempt gets one runtime; all
  services are stopped at the end. There is no daemon, background service,
  queue, or cloud runtime.
- **No SQLite.** State is atomic JSON (`port-leases.json`,
  `runtime-manifest.json`); there is no database or manifest retention.
- **No Docker or remote sandbox.**
- **No Playwright, axe, screenshot, or accessibility evidence.** Readiness is a
  single HTTP status check; browser and a11y evidence are out of scope.
- **Concurrency is bounded, not unlimited.** The default range has 1000 ports;
  each service consumes one, and there is no CPU/memory/browser admission
  scheduler. Two runtimes can hold different ports concurrently when the range
  and host allow it, but this is not an unbounded parallelism claim.
- **Probe-then-reserve can race.** Only one `EADDRINUSE` retry per service is
  implemented. A service that ignores `portEnv`, binds another port, or binds
  only IPv6 will fail readiness.
- **HTTP only.** No HTTPS, TCP-only readiness, custom health protocols, auth,
  or redirect following.
- **Fixed host.** Probes and leases use `127.0.0.1`; the host is not
  configurable.
- **Fixed shutdown.** Only process-group `SIGTERM` → `SIGKILL` is supported; no
  per-service shutdown command.
- **Windows differences.** Services are not spawned into a POSIX process group;
  cleanup kills the direct child only, so grandchildren may survive. Process
  identity capture and group inspection are unsupported on Windows, so orphan
  recovery cannot prove ownership and reports `needs_human` for candidates.
- **Logs are append-only.** No rotation or size cap; the manifest normally
  stores paths and readiness probe history, while failure messages may embed a
  bounded log tail.
- **PID reuse and exact lease ownership.** A lease owner is considered live
  while its pid exists; pid reuse can delay reclamation of a dead owner's lease.
  Orphan recovery requires `lease.pid === manifest.owner.pid` and compares the
  exact persisted `pid`/`pgid`/OS start identity, reporting `needs_human` on a
  mismatch rather than signalling the reused PID. A lease owned by a different
  dead PID is also `needs_human`.
- **No automatic merge** to any branch and no automatic push.
- The shell Verifier does not populate `artifactHash`; it is available only to
  direct `RuntimeManager` callers that pass one.

## Verification

Measured on 2026-10-27 in this worktree (macOS, HEAD `3093508`). The current
suite includes the attempt-continuity/progress tests and the failure-drill
tests:

```text
npm run build                                     → pass
focused attempt/progress/drill group (4 files)    → 13/13 pass (9769.2 ms)
runtime/recovery-focused group (13 files)         → 81/81 pass (9968.0 ms)
npm test (full suite)                             → 177/177 pass (10887.8 ms)
```

These are single local runs. They are not a repeated-run flake rate or CI
claim. The measured drill evidence and per-scenario results are in
[docs/evidence/RUNTIME_FAILURE_DRILLS.md](evidence/RUNTIME_FAILURE_DRILLS.md);
that document records the suite counts for its own earlier run (2 drill tests,
166 total), which are historical. The current counts are the ones above. The
abnormal-child recovery measurement is in
[docs/evidence/ATTEMPT_CONTINUITY_PROGRESS.md](evidence/ATTEMPT_CONTINUITY_PROGRESS.md).

Historical pre-drill baseline (same day, before the drill tests were added):
`npm test` reported 164/164 in five consecutive runs, each a separate `npm test`
process run sequentially in this worktree. Test-runner durations were 8.39 s,
8.16 s, 8.04 s, 8.14 s, and 8.25 s; no flakes were observed. This is local
evidence, not a long-term flake rate or CI claim.

Runtime and recovery-focused suites (81 tests across 13 files; 78 of them
predate the drill tests):

```text
tests/contract-runtime.test.ts                     10
tests/runtime-ports.test.ts                        10
tests/runtime-manager.test.ts                       8
tests/runtime-manager-identity.test.ts              5
tests/runtime-process.test.ts                       8
tests/runtime-verifier.test.ts                      5
tests/runtime-owner-lease-safety.test.ts            3
tests/runtime-recovery-record.test.ts               3
tests/runtime-reaper-plan.test.ts                   9
tests/runtime-reaper.test.ts                       10
tests/supervisor-runtime-reaper.test.ts             5
tests/supervisor-runtime-recovery-record.test.ts    2
tests/runtime-failure-drills.test.ts                3
```

The 13-file group was run once this iteration; earlier standalone runs are
historical.

The seven runtime test files that start real processes or bind real ports take
static, disjoint port pools from `tests/test-port-ranges.ts` (22000–22699; 100
ports per file, except the 90-port drill window); the shell-verifier tests keep
21400–21499 and 21500–21599. The
helper asserts overlap/inversion at import time and throws on pool exhaustion
when a range is taken; every allocation still goes through the real
`PortAllocator` probe/retry path inside the assigned pool.
This only prevents overlaps between test files in this repository; it is not a
production port registry, cross-run coordinator, or cross-repository claim.

Process-level coverage includes a real detached RuntimeManager service whose
owner is `SIGKILL`ed, `SIGTERM` → `SIGKILL` escalation, leader-dead groups,
foreign port listeners, concurrent reaper serialization, supervisor
`reap`/`start`/`resume` run in separate child processes, exact lease-owner
correlation (equal dead owner safe; live or dead third-party owner
`needs_human` with evidence preserved), and `runtimeId`-bearing recovery
records for reaped, skipped, and needs_human buckets, including legacy records
without an id.

The failure-drill suite additionally runs `readiness-timeout`,
`verify-failure`, and `cleanup-failure` in three independent child processes.
The normal-path checked run passed 3/3: two scenarios finished with
`cleanup: "complete"` and empty lease stores; the cleanup-failure scenario
finished with `cleanup: "failed"`, one retained lease, and a failed release;
all three services were gone and all three ports were free afterward. See
[docs/evidence/RUNTIME_FAILURE_DRILLS.md](evidence/RUNTIME_FAILURE_DRILLS.md).

The same file also exercises the timed-out abnormal path through the test-only
hang hook. In the measured abnormal run the report was `fail` with
`{ total: 3, passed: 2, failed: 1 }` — the abnormal child cannot pass its
child-exit check — while the parent's recovery checks passed: the child was
SIGKILLed after SIGTERM was ignored, the exact executor reaped the proven
service group and exact lease, the manifest became `cleanup: "complete"` with
a `reaped` recovery record, and the port was free. Exact commands and output:
[docs/evidence/ATTEMPT_CONTINUITY_PROGRESS.md](evidence/ATTEMPT_CONTINUITY_PROGRESS.md).

Earlier acceptance drills (2026-10-27, before the reaper iteration):

- the checked-in example was accepted on leased port `21850`, produced
  `cleanup: "complete"`, and released the port;
- two complete acceptance processes overlapped for about 1.5 seconds and used
  ports `21900` and `21901`, with distinct runtime manifests and an empty lease
  store after both stopped;
- a real Claude Code + DeepSeek Worker accepted the runtime contract in a
  scratch Git repository. Its verifier used leased port `19000`, the service
  exited with `SIGTERM`, `cleanup` was `complete`, and the Worker changed only
  `runtime-smoke.txt`.

A byte scan of `src/` found no NUL bytes, including `src/supervisor/cli.ts`;
the supervisor recovery-record test also asserts its report output contains no
NUL delimiter.

## Related documents

- Design: [design/runtime-manager-v0.md](../design/runtime-manager-v0.md)
- Failure drill evidence: [docs/evidence/RUNTIME_FAILURE_DRILLS.md](evidence/RUNTIME_FAILURE_DRILLS.md)
- Attempt/progress/abnormal recovery evidence: [docs/evidence/ATTEMPT_CONTINUITY_PROGRESS.md](evidence/ATTEMPT_CONTINUITY_PROGRESS.md)
- Orphan recovery: [docs/RUNTIME_ORPHAN_RECOVERY.md](RUNTIME_ORPHAN_RECOVERY.md)
- Supervisor integration: [docs/SUPERVISOR_V0.md](SUPERVISOR_V0.md)
- Next iteration: [docs/NEXT_ITERATION.md](NEXT_ITERATION.md) — Task Architect
  is the next capability; durable continuous orchestration follows
- Example: [examples/runtime-verifier.contract.json](../examples/runtime-verifier.contract.json)

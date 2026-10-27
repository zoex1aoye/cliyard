# RuntimeManager v0

> Status: implemented (single host, local repository, finite verification services).
>
> Design authority: [design/runtime-manager-v0.md](../design/runtime-manager-v0.md).
> This document describes the behavior that is actually implemented in
> `src/runtime/types.ts`, `src/runtime/ports.ts`, `src/runtime/manager.ts`, and
> `src/verification/verifier.ts`.

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

Allocation semantics:

- Load–modify–save and bind probes run under one cross-process lock
  (`O_EXCL`, owner pid/host/token in the lock file, 15 s default wait). A
  same-host lock whose owner pid is gone is reclaimed; a foreign or unreadable
  lock is abandoned only after 5 minutes of age.
- Re-allocating the same `runtimeId + service` while the recorded owner pid is
  alive returns the same lease and port.
- A lease whose owner pid is gone is reclaimable on the same host; liveness is
  local-pid-based, so this store must not be shared across machines.
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

Manifest shape (version 1):

```jsonc
{
  "version": 1,
  "runtimeId": "run-42-task-web-attempt-1",
  "taskId": "task-web",
  "attempt": 1,
  "worktree": "/path/to/task-worktree",
  // "artifactHash": "<sha256>",  // optional; the shell Verifier does not set it
  "services": [
    {
      "name": "web",
      "host": "127.0.0.1",
      "port": 19000,
      "pid": 1234,
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
  "failureReason": "optional"
}
```

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
  the lease store over a network filesystem.
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
  cleanup kills the direct child only, so grandchildren may survive.
- **Logs are append-only.** No rotation or size cap; the manifest normally
  stores paths and readiness probe history, while failure messages may embed a
  bounded log tail.
- **PID reuse.** A lease owner is considered live while its pid exists; pid
  reuse can delay reclamation of a dead owner's lease.
- **No automatic merge** to any branch and no automatic push.
- The shell Verifier does not populate `artifactHash`; it is available only to
  direct `RuntimeManager` callers that pass one.

## Verification

Measured on 2026-10-27 in this worktree:

```text
npm run build   → pass
npm test        → 119 tests, 119 pass
```

Runtime-focused suites (33 tests):

```text
tests/runtime-ports.test.ts      10
tests/runtime-manager.test.ts     8
tests/runtime-verifier.test.ts    5
tests/contract-runtime.test.ts   10
```

The measured suite size is **119**, not the earlier 105-test estimate. One
initial full-suite run launched concurrently with `npm run build` reported
118/119; two subsequent isolated full runs passed 119/119, and the runtime
suites passed three consecutive repetitions.

Additional process-level drills on 2026-10-27:

- the checked-in example was accepted on leased port `21850`, produced
  `cleanup: "complete"`, and released the port;
- two complete acceptance processes overlapped for about 1.5 seconds and used
  ports `21900` and `21901`, with distinct runtime manifests and an empty lease
  store after both stopped;
- a real Claude Code + DeepSeek Worker accepted the runtime contract in a
  scratch Git repository. Its verifier used leased port `19000`, the service
  exited with `SIGTERM`, `cleanup` was `complete`, and the Worker changed only
  `runtime-smoke.txt`.

## Related documents

- Design: [design/runtime-manager-v0.md](../design/runtime-manager-v0.md)
- Supervisor integration: [docs/SUPERVISOR_V0.md](SUPERVISOR_V0.md)
- Next iteration: [docs/NEXT_ITERATION.md](NEXT_ITERATION.md)
- Example: [examples/runtime-verifier.contract.json](../examples/runtime-verifier.contract.json)

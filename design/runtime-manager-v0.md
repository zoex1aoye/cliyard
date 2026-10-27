# RuntimeManager v0 Design

> Revision: runtime-manager-v0
>
> Scope: single host, local repository, finite verification services

## Goal

Move service lifecycle and temporary-port ownership out of Workers and into the
Verifier control path.

```text
Worker exits
  → PortAllocator leases one port per runId + service
  → RuntimeManager starts the service from the exact worktree
  → readiness succeeds
  → verifyCommands run with service URLs in their environment
  → Evidence/runtime manifest is persisted
  → whole service process group is stopped
  → ports become reusable
```

The worker may create a server entry point, but it must not start a long-lived
service or choose an acceptance port.

## Non-goals

- No daemon, queue, or cloud runtime.
- No SQLite migration.
- No Docker or remote sandbox.
- No Playwright, screenshots, or axe integration in this slice.
- No admission scheduler for CPU, memory, or browser concurrency.
- No automatic merge to `main`.

## RuntimeSpec

```ts
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

interface RuntimeSpec {
  services: RuntimeServiceSpec[];
}
```

Rules:

- `name` is unique within a task and safe as a path segment.
- `command` is an argv array, not a shell string.
- Relative `cwd` is resolved inside the task worktree.
- Services bind `127.0.0.1` by default.
- A service-specific URL is exposed as
  `CLIYARD_<UPPER_SNAKE_SERVICE>_URL`.
- `urlEnv` adds an explicit compatibility variable for verify commands.
- `portEnv` overrides the port variable passed to the service process.
- Missing readiness path defaults to `/`; missing status defaults to `200`;
  missing timeout defaults to 30 seconds.

Example:

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

## PortAllocator

Default range: `19000-19999`, override with `CLIYARD_PORT_RANGE`.

Store:

```text
<repoRoot>/.cliyard/runtime/port-leases.json
<repoRoot>/.cliyard/runtime/port-leases.lock
```

Lease identity:

```ts
interface PortLease {
  key: string;
  runId: string;
  service: string;
  host: "127.0.0.1";
  port: number;
  pid: number;
  acquiredAt: string;
}
```

Semantics:

- The store is mutated under one cross-process lock.
- Re-allocating the same live `runId + service` returns the same port.
- A port is reserved before the service spawns.
- Availability is checked by binding `127.0.0.1:port`.
- A detected unbound port can still race before child binding; the manager must
  retry with a different port when the child exits because of `EADDRINUSE`.
- Release is idempotent and only removes the exact lease.
- Stale owner-PID leases may be reclaimed on the same host.

V0 deliberately uses probe-then-start. A future framework-specific adapter can
use `listen(0)` where the service reports its actual bound port.

## RuntimeManager

Artifacts:

```text
<repoRoot>/.cliyard/runtime/<runtimeId>/
  runtime-manifest.json
  <service>.log
  data/<service>/
```

Runtime identity is deterministic per acceptance attempt, for example
`<supervisor-run-id>-<task-id>-attempt-<n>`.

`RuntimeManifest` records:

- runtimeId, taskId, attempt, worktree;
- services with host, leased port, pid, URL, log path, data dir;
- readiness attempts;
- start/stop timestamps;
- exit codes and cleanup state;
- failure reason.

Startup is considered ready only when all of these hold:

1. the child process is still alive;
2. the readiness URL returns the expected HTTP status;
3. the readiness deadline has not expired.

Cleanup runs in `finally` semantics:

1. terminate the service process group;
2. wait for exit;
3. confirm the leased port no longer accepts connections;
4. release the lease;
5. persist final runtime state and log paths.

## Contract and Verifier integration

`TaskContract.runtime` is optional. Plan compilation preserves and validates it.
No runtime means existing static verification behavior is unchanged.

The shell verifier:

- receives both worktree `cwd` and repository-level artifact root;
- starts runtime services only after the Worker exits and path gate passes;
- injects service URL variables into every `verifyCommands` environment;
- returns the RuntimeManifest as evidence;
- always stops services after verification, including rejection/failure;
- never starts runtime for dry-run/mock verification.

Runtime evidence lives under the control repository's `.cliyard`, not inside
the disposable task snapshot.

## Required tests

1. Two allocators in separate processes cannot lease the same port.
2. Reacquiring the same live key returns the same lease.
3. Release makes the port available again.
4. Occupied ports are skipped.
5. Two services in one runtime receive different ports.
6. Readiness failure captures logs and avoids running verifyCommands.
7. Successful readiness exposes `WEB_URL` and runs an HTTP assertion.
8. Cleanup leaves no listening service process.
9. Plan → Contract preserves runtime and rejects malformed specs.
10. Existing non-runtime contracts keep current behavior.

## Acceptance

```text
rt-port-lease
  → { rt-runtime-manager, rt-contract-runtime }  [parallel]
  → rt-verifier-runtime
  → rt-docs
```

The slice is complete when a command such as
`curl "$WEB_URL/health"` can be a verification gate, two acceptance runs can
hold different ports concurrently, and every run removes its service process
group before being accepted.

# Runtime Failure Drills v0

> Revision: runtime-failure-drills-v0
>
> Scope: single host, local scratch repositories, finite verification services

## Goal

Turn the three known RuntimeManager failure paths into one repeatable diagnostic
command:

```text
cliyard runtime-drill
  → spawn one independent OS process per scenario
  → record the observed failure, final manifest, service identity and command verdict
  → prove the service port is free after cleanup
  → preserve logs, leases and manifests as evidence
  → exit non-zero if any scenario does not match its expected contract
```

The command is a diagnostic and regression tool. It does not become a daemon,
runtime supervisor, browser runner or production queue.

## Scenarios

| Scenario | Expected failure | Required evidence |
|----------|------------------|-------------------|
| `readiness-timeout` | The service listens but never reaches the expected HTTP status before the deadline. `verifyCommands` must not run. | Rejected verifier verdict, skipped command record, readiness attempts, service log path, pid/pgid, cleanup state. |
| `verify-failure` | Readiness succeeds, then a `verifyCommand` exits with a non-zero code (for example 7). | Rejected verdict, exact command exit code, command log, ready manifest, service log path, pid/pgid, cleanup state. |
| `cleanup-failure` | The service reaches readiness but the leased-port release step throws. | The runtime API rejects, the persisted manifest says `cleanup: "failed"`, and the failure reason names the release fault. |

For every scenario:

- the service process must be gone and its leased port must be bindable again;
- the child process must end cleanly after detecting the expected failure;
- no failed attempt may report an accepted verdict;
- the RuntimeManifest and service log must remain available for inspection.

The cleanup-failure scenario deliberately leaves its failed lease record in the
scratch control directory as evidence. It verifies that the process and port
were cleaned up even though the cleanup operation is correctly reported as
failed.

## Independent processes

The top-level drill command starts a fresh child process for each scenario. Each
child gets its own scratch control repository, worktree and explicit port range.
The child exits `0` only when the expected failure was observed with all
necessary evidence. A mismatch exits non-zero.

The parent checks the child exit status and the machine-readable report. A
successful parent exit means all children passed; it does not reinterpret an
expected task rejection as an accepted task.

## CLI

```bash
cliyard runtime-drill
cliyard runtime-drill --out <directory> --port-base <start> --json
npm run runtime-drill -- --out <directory> --port-base <start>
```

Defaults:

- output: `.cliyard/runtime-drills/<UTC timestamp>-<pid>/`
- port base: `22800`

The output directory contains:

```text
<out>/
  runtime-failure-drills.json
  readiness-timeout/
    control/.cliyard/runtime/<runtimeId>/runtime-manifest.json
    control/.cliyard/runtime/<runtimeId>/web.log
    worktree/
  verify-failure/
    ...
  cleanup-failure/
    ...
```

The JSON report is versioned and includes, at minimum:

- scenario name, pass/fail status and expected failure;
- child pid, exit code, signal and duration;
- runtime id, manifest path, cleanup state and failure reason;
- service pid, pgid, port and log path when a service started;
- verify command results and whether the expected command was skipped;
- final port-free result and remaining lease count.

## Port isolation

The checked-in test that drives the drill uses a static pool in
`tests/test-port-ranges.ts`. The pooled range must not overlap another runtime
test file or the shell-verifier ranges.

Each child receives a disjoint subrange:

```text
readiness-timeout  base .. base + 29
verify-failure     base + 30 .. base + 59
cleanup-failure    base + 60 .. base + 89
```

The command validates the range before spawning any child. This is test/drill
isolation only; it is not a production or cross-repository port coordinator.

## Non-goals

- No daemon, periodic scan or 24-hour background execution.
- No cross-host recovery or remote process kill.
- No browser, Playwright, screenshot or axe evidence.
- No SQLite or cloud execution.
- No CPU/memory/browser admission scheduler.
- No weakened reaper ownership rules.
- No automatic merge to `main`.

## Acceptance

```text
failure-drill-runner
  → failure-drill-docs
```

1. Three scenarios run in three independent child processes.
2. Readiness timeout skips `verifyCommands`, rejects and leaves a complete
   cleanup manifest with readiness and log evidence.
3. Verify-command exit code 7 rejects and leaves a complete cleanup manifest.
4. Cleanup release failure rejects with `cleanup: "failed"`; it never reports
   acceptance.
5. Every scenario confirms its service port is free afterward.
6. The drill writes a machine-readable report and retains per-scenario evidence.
7. The focused drill test, the full suite and the TypeScript build pass.
8. Documentation records measured results and does not expand capability claims.


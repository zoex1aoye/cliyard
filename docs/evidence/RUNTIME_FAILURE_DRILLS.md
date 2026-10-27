# Runtime Failure Drills — Measured Evidence

> Date: 2026-10-27 (report generated `2026-10-27T05:43:36.561Z`)
>
> Environment: macOS (Darwin 27.0.0), Node `v20.20.2`, repository HEAD `29db75b`.
>
> Scope: single host, scratch control repositories, finite verification
> services. This is a checked-in summary of one local run; raw artifacts remain
> under the gitignored `.cliyard/runtime-drills/` directory and are not
> committed.

## Command

Run from the repository root:

```bash
npm run runtime-drill -- \
  --out .cliyard/runtime-drills/20261027T054334Z-manual-54770 \
  --port-base 22800 --json
```

The command exited `0`. It wrote the version-1 machine-readable report:

```text
.cliyard/runtime-drills/20261027T054334Z-manual-54770/
  runtime-failure-drills.json
  readiness-timeout/
    child.log
    child-result.json
    control/.cliyard/runtime/drill-readiness-timeout-attempt-1/
      runtime-manifest.json
      web.log
      data/web/
    control/.cliyard/runtime/port-leases.json
    worktree/
  verify-failure/
    child.log
    child-result.json
    control/.cliyard/runtime/drill-verify-failure-attempt-1/
      runtime-manifest.json
      web.log
      data/web/
    control/.cliyard/runtime/port-leases.json
    worktree/
  cleanup-failure/
    child.log
    child-result.json
    control/.cliyard/runtime/drill-cleanup-failure-attempt-1/
      runtime-manifest.json
      web.log
      data/web/
    control/.cliyard/runtime/port-leases.json
    worktree/
```

`port-leases.json` existed under every scenario control directory; the first
two were empty after cleanup, and the third retained one lease as described
below.

## Verdict

```text
runtime-drill: 3/3 scenarios passed
report status: pass
report summary: { total: 3, passed: 3, failed: 0 }
```

No scenario reported an accepted verdict. The parent re-validated every child
exit status, child result, persisted manifest, service log, process group, port,
and lease store independently of the child's own checks.

| Scenario | Verdict | Accepted | Rejection observed | Parent checks |
|----------|---------|----------|--------------------|---------------|
| `readiness-timeout` | pass | no | yes (shell verifier rejected) | 36/36 |
| `verify-failure` | pass | no | yes (shell verifier rejected) | 35/35 |
| `cleanup-failure` | pass | no | yes (`RuntimeCleanupError`) | 33/33 |

## Independent child processes

Each scenario ran in its own OS child process with a disjoint 30-port subrange
(22800–22829, 22830–22859, 22860–22889) and separate scratch control
directory and worktree.

| Scenario | Child PID | Exit code | Signal | Timed out | Duration | `child.log` |
|----------|-----------|-----------|--------|-----------|----------|-------------|
| `readiness-timeout` | 54804 | 0 | none | no | 1323 ms | `[runtime-drill-child] readiness-timeout pass` |
| `verify-failure` | 54836 | 0 | none | no | 273 ms | `[runtime-drill-child] verify-failure pass` |
| `cleanup-failure` | 54869 | 0 | none | no | 140 ms | `[runtime-drill-child] cleanup-failure pass` |

Each scenario also wrote `child-result.json`; its self-checks passed
20/20, 18/18, and 18/18 respectively. The child PIDs differ from their service
PIDs, confirming that each scenario's runtime service was a separate process
under an independently observed child.

## Scenario evidence

Common service outcome for all three scenarios: the service exited with
`signal: "SIGTERM"`, `exitCode: null`, a recorded `exitedAt`, the leader PID
equaled the PGID, the process and process group were gone, and the leased port
was bindable again.

| Field | `readiness-timeout` | `verify-failure` | `cleanup-failure` |
|-------|---------------------|------------------|-------------------|
| `runtimeId` | `drill-readiness-timeout-attempt-1` | `drill-verify-failure-attempt-1` | `drill-cleanup-failure-attempt-1` |
| Service PID / PGID | 54805 / 54805 | 54837 / 54837 | 54870 / 54870 |
| Leased port | 22800 | 22830 | 22860 |
| Readiness attempts | 12 (first `ECONNREFUSED`, then 503 × 11) | 2 (`ECONNREFUSED`, then 200) | 2 (`ECONNREFUSED`, then 200) |
| `cleanup` | `complete` | `complete` | `failed` |
| `failureReason` | `service "web" is not ready within 1200ms ... expected status 200, received 503` plus log tail | `null` | `cleanup: service "web" lease: injected lease release failure` |
| Leases after run | 0 | 0 | 1 (intentional evidence) |
| Process / group gone | yes / yes | yes / yes | yes / yes |
| Port free | yes | yes | yes |
| Service log | `web.log` present, contains `listening` | `web.log` present, contains `listening` | `web.log` present, contains `listening` |

### `readiness-timeout`

The service listened on `127.0.0.1:22800` but returned HTTP 503 for `/health`
against the expected 200 until the 1200 ms deadline. Readiness probes were
recorded in the manifest. The shell Verifier rejected with exit code `1` and
skipped the verify command (`[shell-verify] skipped; runtime not ready`); the
`verify-ran.marker` was absent and the command record was marked skipped. The
runtime was stopped, cleanup completed, and the manifest retained the service
log tail in `failureReason`.

### `verify-failure`

Readiness succeeded with HTTP 200 on the second probe. The verify command ran,
wrote `verify-ran.marker`, and exited with code `7`; the verifier verdict was
rejected with exit code `7` and the command record preserved exit code `7`.
Cleanup completed and no failure reason was written (the runtime itself did not
fail).

### `cleanup-failure`

The service became ready on `127.0.0.1:22860`, then `RuntimeManager.run()`
rejected with `RuntimeCleanupError` because the injected allocator release threw
`injected lease release failure`. The manifest was persisted with
`cleanup: "failed"` and the same failure reason. The runtime API did not report
acceptance. `verify` evidence is not applicable for this scenario.

## Port release

The parent's report recorded `runtime.portFree: true` and
`services[0].portFree: true` for all three scenarios, and
`processGone`/`processGroupGone: true` for every service. An independent
post-run check found no listeners:

```text
lsof -nP -iTCP:22800 -iTCP:22830 -iTCP:22860 -sTCP:LISTEN
→ no listeners on 22800/22830/22860
```

The cleanup-failure port is free even though lease release failed: the service
group is stopped before the release step, and the release failure is reported
instead of being hidden.

## Lease behavior

- `readiness-timeout` and `verify-failure`: `port-leases.json` was
  `{"version":1,"leases":[]}` after cleanup.
- `cleanup-failure`: exactly one lease was intentionally retained as evidence:

```json
{
  "key": "drill-cleanup-failure-attempt-1:web",
  "runId": "drill-cleanup-failure-attempt-1",
  "service": "web",
  "host": "127.0.0.1",
  "port": 22860,
  "pid": 54869,
  "acquiredAt": "2026-10-27T05:43:36.499Z"
}
```

The retained lease PID equals the manifest owner PID and the scenario child PID
(54869). The service itself was gone and the port was free; the lease remains as
failed-cleanup evidence for the ordinary reconciliation rules. Deleting it to
make the drill look cleaner would destroy evidence.

## Cleanup and failure states

| Scenario | Final `cleanup` | `stoppedAt` | Failure surfaced? |
|----------|-----------------|-------------|-------------------|
| `readiness-timeout` | `complete` | recorded | yes — rejection, verify skipped |
| `verify-failure` | `complete` | recorded | yes — rejection, command exit 7 |
| `cleanup-failure` | `failed` | recorded | yes — `RuntimeCleanupError` |

All manifests remained on disk with `owner`, service `pid`/`pgid`,
`processIdentity`, readiness history, and log paths. The drill did not remove
any scenario directory.

## Build and test counts

Measured once each on 2026-10-27 in this worktree (build and the focused drill
file just before the drill run; the focused group and full suite after it):

| Check | Result | Test-runner duration |
|-------|--------|----------------------|
| `npm run build` | pass | — |
| `npx tsx --test tests/runtime-failure-drills.test.ts` | 2/2 pass | 1981.8 ms |
| Runtime/recovery-focused group (13 files) | 80/80 pass | 3150.8 ms |
| `npm test` (full suite) | 166/166 pass | 8194.6 ms |

The focused group is the previous 12 runtime/recovery files (78 tests) plus
`tests/runtime-failure-drills.test.ts` (2 tests). These are single local runs,
not a repeated-run flake-rate or CI claim.

## Boundaries

This drill is a foreground diagnostic. It does not add a daemon, periodic scan,
cross-host recovery, browser/Playwright/axe/screenshot evidence, SQLite, Docker,
or CPU/memory/browser admission scheduling. Its three scenarios are deliberate:
a 503 readiness target, an exit-7 verify command, and an injected allocator
release fault. They are not production port coordination, and the
cleanup-failure result does not weaken the reaper's `needs_human` rules.

Related documents: [RUNTIME_MANAGER.md](../RUNTIME_MANAGER.md),
[RUNTIME_ORPHAN_RECOVERY.md](../RUNTIME_ORPHAN_RECOVERY.md),
[design/runtime-failure-drills-v0.md](../../design/runtime-failure-drills-v0.md).

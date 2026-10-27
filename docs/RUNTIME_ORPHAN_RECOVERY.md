# Runtime Orphan Recovery

> Status: implemented (single host, local repository, macOS/Linux process identity).
>
> Design authority: [design/runtime-orphan-reaper-v0.md](../design/runtime-orphan-reaper-v0.md).
> Hardening: [design/runtime-orphan-hardening.md](../design/runtime-orphan-hardening.md).
> This document describes the behavior implemented in `src/runtime/process.ts`,
> `src/runtime/reaper.ts` (read-only preflight), `src/runtime/reaper-execute.ts`
> (destructive executor), and `src/supervisor/cli.ts` (`supervisor reap` and
> start/resume integration).
>
> Companion documents: [RUNTIME_MANAGER.md](RUNTIME_MANAGER.md) (normal runtime
> lifecycle) and [SUPERVISOR_V0.md](SUPERVISOR_V0.md) (durable foreground runs).

RuntimeManager runs cleanup in `finally`, so a normal acceptance attempt stops
its service groups, confirms the leased ports, releases the leases, and writes
a final manifest. A hard kill (`SIGKILL`), host death, or any exit path that
bypasses that `finally` can instead leave:

- a detached service process group still listening on its leased port;
- a port lease whose recorded owner process is gone;
- a `RuntimeManifest` stuck at `cleanup: "pending"`, `"running"`, or `"failed"`.

The orphan reaper reconciles exactly those situations. It is not a daemon, does
not poll in the background, and never performs a cross-host kill.

```text
orphan evidence
  → read-only preflight (manifest + exact lease + process identity)
  → safe_to_reap?
      yes → SIGTERM/SIGKILL proven groups → confirm ports → release exact
            leases → persist recovery record + cleanup state
      no  → needs_human; preserve process groups, leases and manifests
  → skip when there is no local action (complete, already reaped, foreign
    host, or owner still alive)
```

## Safety rule

> Reclaim only what can be proven to belong to this runtime; otherwise retain
> the evidence and report `needs_human`.

A runtime is eligible only when every one of these holds:

1. The manifest parses and its `runtimeId` matches its directory name.
2. The manifest is not already `cleanup: "complete"` and was not already
   reconciled with `recovery.state: "reaped"`.
3. `owner` is valid and the owner host is this host.
4. The owner PID is provably gone on this host. Liveness uses signal 0;
   only `ESRCH` proves death. `EPERM` counts as alive.
5. The lease store is readable.
6. For every service that was started (it has a persisted `pid` or an exact
   lease):
   - an exact matching lease exists;
   - the service has a persisted `pid` and `pgid`, and `pgid === pid`;
   - the leader is either still alive with an exact
     `pid` + `pgid` + OS start-identity match, or gone with a provably empty
     process group.
   A service with neither a persisted `pid` nor a lease contributes no local
   action; an empty manifest is handled the same way.
7. No other unfinished runtime manifest references the same leader PID,
   process group, or bind port.
8. No additional lease exists under this `runtimeId` without a matching
   manifest service.
9. The exact lease owner PID equals the manifest owner PID
   (`lease.pid === manifest.owner.pid`). Any mismatch is `needs_human`,
   whether the lease owner is live or dead.

Anything else is `needs_human`: a missing legacy identity, a reused PID, a
leader that exited while group members remain, a competing manifest, a port
still held by a foreign listener, or a lease that changed during recovery.

The reaper never:

- kills a process group merely because its number appears in JSON;
- releases a lease before the proven group is gone and the port is bindable;
- infers process identity from wall-clock time or from the group number;
- matches command lines or scans for "looks like a cliyard service";
- releases leases as garbage collection while a service may still be alive;
- acts on a runtime owned by another host.

## Hardening changes

The current revision incorporates four correctness fixes from
[design/runtime-orphan-hardening.md](../design/runtime-orphan-hardening.md):

- **Exact lease owner PID.** Preflight previously ignored a lease owned by a
  different *dead* PID. It now requires `lease.pid === manifest.owner.pid`; a
  live or dead mismatch is `needs_human`, and the group, lease, and manifest are
  preserved.
- **`runtimeId` in recovery evidence.** New executor records carry the runtime
  id themselves. `supervisor reap` reports from the executor report directly,
  without a second preflight or reason-keyed id reconstruction; `status` uses
  the record id first and falls back to the manifest id, then the directory name,
  for legacy records.
- **Text-clean Supervisor source.** Blocked-candidate de-duplication uses a
  JSON-encoded key rather than a NUL-delimited string. At this revision a byte
  scan of `src/` found no NUL bytes.
- **Disjoint test port pools.** Runtime test files that bind real ports use
  static, non-overlapping pools (`tests/test-port-ranges.ts`). This is test-run
  isolation only; it does not coordinate ports across runs or repositories.

Measured evidence is in [Verification](#verification).

## Persisted identity fields

The manifest root records the process that owned the runtime:

```jsonc
{
  "version": 1,
  "runtimeId": "runtime-e2e",
  "taskId": "task-e2e",
  "attempt": 1,
  "worktree": "/path/to/task-worktree",
  "owner": { "pid": 12345, "host": "workstation" },
  "services": [
    {
      "name": "web",
      "host": "127.0.0.1",
      "port": 19000,
      "pid": 23456,
      "pgid": 23456,
      "processIdentity": {
        "pid": 23456,
        "pgid": 23456,
        "startedAt": "Mon Oct 27 10:00:00 2026"
      },
      "url": "http://127.0.0.1:19000",
      "healthUrl": "http://127.0.0.1:19000/health",
      "logPath": ".../web.log",
      "dataDir": ".../data/web",
      "readinessAttempts": [],
      "startedAt": "2026-10-27T10:00:00.000Z"
    }
  ],
  "startedAt": "2026-10-27T10:00:00.000Z",
  "cleanup": "complete",
  "recovery": {
    "runtimeId": "runtime-e2e",
    "state": "reaped",
    "reason": "...",
    "at": "2026-10-27T10:05:00.000Z",
    "reaperPid": 34567,
    "reaperHost": "workstation",
    "services": [
      {
        "name": "web",
        "pgid": 23456,
        "action": "terminated",
        "portReleased": true
      }
    ]
  }
}
```

| Field | Meaning |
|-------|---------|
| `owner.pid` | PID of the control process that started the runtime. |
| `owner.host` | `os.hostname()` of that process. This is **not** the `127.0.0.1` bind host recorded on a `PortLease`. |
| `services[].pid` | Leader PID reported immediately after spawn. |
| `services[].pgid` | Process group to stop as a unit. POSIX services are spawned detached, so the leader PID is the group id and the two fields must be equal. |
| `processIdentity.pid`, `processIdentity.pgid` | Must match the service `pid`/`pgid`. |
| `processIdentity.startedAt` | OS-reported start identity from `ps -p <pid> -o pid=,pgid=,lstart=`, whitespace-normalized. It is captured immediately after spawn with `LC_ALL=C`, `LANG=C`, and `TZ=UTC`. It is never derived from manifest write time. |
| `services[].startedAt` | Wall-clock bookkeeping only; never used for ownership. |
| `recovery` | Optional record written by the reaper. Legacy manifests do not have it. |
| `recovery.runtimeId` | Runtime this record describes. Optional only in records written before the field existed; every new executor record sets it. |

Persistence timing matters:

- The manager writes the initial manifest with no service PIDs before the first
  spawn.
- Immediately after spawn it records `pid`, `pgid`, and `processIdentity`, then
  persists **before** readiness. A crash during the readiness wait therefore
  leaves usable evidence.
- On the one `EADDRINUSE` retry, the old spawn evidence is cleared before the
  replacement process starts.
- If process identity capture is unsupported (Windows) or returns no identity,
  the service may still have `pid` and `pgid`, but not `processIdentity`. A live
  leader then cannot be proven and fails closed; a provably empty group with an
  exact lease may still be classified `already-exited`.

Identity capture requires macOS or Linux and a working `ps`. Missing or partial
identity is `unknown`, never a match.

### Exact lease correlation

A service lease must match all of:

```text
lease.runId     === manifest.runtimeId
lease.service   === service.name
lease.key       === `${runtimeId}:${service.name}`
lease.host      === "127.0.0.1"
lease.port      === service.port
lease.pid       === manifest.owner.pid
```

The lease must also be owned by the manifest owner PID:
`lease.pid === manifest.owner.pid`. Any mismatch is `needs_human`, whether the
lease owner is live or dead. A dead third-party owner does not prove this
runtime's service; the process group, lease, and manifest are preserved for
human review.

The lease store is single-host. Liveness and identity are local concepts; do
not share `.cliyard/runtime` across machines or network filesystems.

## When reconciliation runs

| Trigger | Command | Order | `needs_human` behavior |
|---------|---------|-------|------------------------|
| Explicit | `supervisor reap --repo <path> [--json]` | Any time; no supervisor run required | Reports it, preserves evidence, exits `0` |
| New run | `supervisor start …` | After contract/base resolution and after acquiring `.cliyard/supervisor.lock`, before creating a RunManifest | Fails closed, creates no run, releases the lock |
| Resume | `supervisor resume …` | After contracts/base/integration/rejected checks and after acquiring the lock, before marking the run `running` or dispatching | Fails closed, leaves the RunManifest unchanged and releases the lock |
| Status | `supervisor status …` | Never reconciles | Reads persisted recovery records only |

There is no periodic scan, daemon, or background cleanup. If nothing invokes
`reap`, `start`, or `resume`, an orphan stays untouched.

`start` and `resume` reconcile even with `--dry-run`, because reconciliation is
part of taking ownership of the repository, not part of worker dispatch. Their
existing preconditions still run first: a contract/base/integration failure
prevents reconciliation from running at all.

`reap` does not take the supervisor repository lock; it uses the reaper lock
and skips runtimes whose owner is still alive. `start`/`resume` hold the
supervisor lock while they reconcile, then take the reaper lock inside the
executor.

### Reaper lock

```text
<repoRoot>/.cliyard/runtime/reaper.lock
```

- Created with `O_EXCL`, mode `0600`, containing reaper PID, host, token, and
  acquisition time.
- The executor acquires it **before** its preflight and holds it until all
  planned actions and evidence writes finish. Concurrent reapers are
  serialized; a second reaper observes the first one's finalized manifests
  instead of planning from stale evidence.
- Default wait is 15 seconds, then `RuntimeReaperLockError`.
- A same-host lock whose owner PID is dead is cleared immediately.
- A foreign or unreadable lock is left alone until its file age exceeds 5
  minutes.

## Preflight classification

`preflightOrphanedRuntimes(repoRoot)` is read-only. It reads manifests, the
lease store, and process state. It never sends a signal, probes a port,
releases a lease, or writes a manifest.

One runtime yields exactly one plan:

| Plan state | Meaning |
|------------|---------|
| `safe_to_reap` | The owner is dead and every recorded service passed exact correlation; the executor may act. |
| `needs_human` | At least one prerequisite, identity, or correlation is missing, unknown, mismatched, or ambiguous. Change nothing. |
| `skip` | No local action: `cleanup: "complete"`, already reaped, foreign owner host, owner still alive, or empty runtime with no local work. |

Service-level actions inside a plan:

| Action | Meaning |
|--------|---------|
| `terminate` | Leader is alive with an exact identity match and no competing manifest; the group may be stopped. |
| `already-exited` | Leader is gone and the process group is empty; the exact lease may be released without signalling. |
| `none` | The service was never started and holds no lease. |
| `preserve` | Identity or correlation is uncertain; leave the process and lease untouched. |

Preflight rules, in order:

1. A runtime directory without `runtime-manifest.json` is ignored.
2. Invalid JSON, unsupported manifest version, invalid cleanup state, duplicate
   service names, invalid ports/PIDs, or a `runtimeId` that does not match the
   directory name is `needs_human`.
3. `cleanup: "complete"` or `recovery.state: "reaped"` is `skip`. The reaper
   treats these as terminal and does not re-verify their services.
   `cleanup: "failed"` and an existing `needs_human` recovery record are not
   terminal: they are re-evaluated on every run.
4. A missing or invalid `owner` is `needs_human`; a runtime without owner
   identity is "potentially active" because death cannot be proven.
5. A foreign owner host is `skip`; no local action is attempted.
6. A live owner PID on this host is `skip`; it is not an orphan.
7. An unreadable lease store makes every candidate `needs_human`.
8. Per service:
   - service host other than `127.0.0.1` → `preserve`;
   - no `pid` but an exact lease exists → `preserve` (it may have started
     before the manifest was updated);
   - no `pid` and no lease → `none`;
   - missing `pgid` or `pgid !== pid` → `preserve`;
   - no exact lease → `preserve`;
   - lease owner PID differs from the manifest owner PID (live or dead)
     → `preserve`;
   - legacy manifest with no identity: live leader → `preserve`; non-empty
     group → `preserve`; provably empty group → `already-exited`;
   - identity capture failure → `preserve`;
   - exact identity match: `terminate`, unless a competing unfinished manifest
     references the same PID, group, or port, in which case `preserve`;
   - identity mismatch (for example a reused PID) → `preserve`;
   - identity unknown while the PID still appears alive → `preserve`;
   - leader gone but group has members → `preserve`;
   - leader gone and group empty → `already-exited`, subject to the competing
     manifest check.
9. A lease under this `runtimeId` with no matching manifest service is
   `needs_human`.
10. If no service problems remain, the plan is `safe_to_reap`, even when the
    manifest recorded zero services.

A completed or reaped manifest is skipped even if its directory still contains
logs or data; that is evidence, not a live runtime claim.

## Execution and recovery evidence

The executor may act only on `safe_to_reap` plans. For one runtime it:

1. re-verifies the leader identity immediately before signalling;
2. sends `SIGTERM` to each proven process group in reverse service order;
3. waits 5 seconds, escalates to `SIGKILL`, and waits another 5 seconds;
4. confirms every affected leased port binds on `127.0.0.1` (5-second deadline,
   50 ms polls) after its group is gone;
5. re-reads the lease store and releases only exact preflight-correlated
   leases;
6. re-reads the manifest, sets its single `recovery` field to the new record,
   and replaces the file atomically via temp file + `fsync` + `rename`.

Failure semantics:

- If any service cannot be terminated or its group cannot be inspected, the
  runtime is `needs_human`.
- Port and lease checks are skipped when a service has already failed.
- When the record can be persisted, any failure finalizes
  `cleanup: "failed"` and appends a `reaper: …` suffix to `failureReason`. The
  runtime remains available for a later human-reviewed attempt.
- Leases are not released after an earlier stage fails. Within the release
  stage itself, exact leases already released before a later lease failure stay
  released; the runtime is still reported `needs_human`.
- A port that remains unbindable after its group is gone is `needs_human` and
  its lease is preserved.
- A lease whose key/runId/service/host/port/pid/acquiredAt changed since
  preflight is not released; the runtime is `needs_human`.
- If persisting the recovery record fails after processes or leases were
  cleaned up, the returned record is `needs_human` and the reason says the
  evidence could not be persisted. The code never claims `reaped` in that case.
- When the recovery record can be persisted, an executor `needs_human` result
  finalizes `cleanup: "failed"`. If persistence itself fails, the manifest may
  retain its previous cleanup state, but the returned record is still
  `needs_human`.
- A `skip` or preflight-only `needs_human` writes nothing at all; the manifest
  and leases stay byte-identical.

### Recovery record

```ts
interface RuntimeRecoveryRecord {
  /** Optional only in legacy records; every new executor record sets it. */
  runtimeId?: string;
  state: "reaped" | "needs_human" | "skipped";
  reason: string;
  at: string;
  reaperPid: number;
  reaperHost: string;
  services: Array<{
    name: string;
    pgid?: number;
    action: "terminated" | "already-exited" | "preserved";
    portReleased: boolean;
  }>;
}
```

Every new executor record carries its `runtimeId`, including report-only
`skipped` and preflight `needs_human` records; persisted manifest records carry
it too. Records written before the field existed remain readable. `status` uses
the record id first, then falls back to the manifest `runtimeId`, then the
runtime directory name. The Supervisor never reconstructs ids by matching state
or reason text.

On `reaped`, the manifest is finalized with `cleanup: "complete"` and a
`stoppedAt` timestamp (the existing value is retained; otherwise the recovery
time is used). On executor `needs_human`, it is finalized with
`cleanup: "failed"` when the record can be persisted.

The manifest holds one optional `recovery` object. A later reconciliation
replaces it; this is not an append-only history. Preserve earlier evidence by
copying the manifest before re-running the reaper.

The executor only persists records for `safe_to_reap` plans. It never persists
`skipped` or preflight-only `needs_human` records. A later `reap` run
re-evaluates those runtimes from their existing evidence.

### Report shape

```ts
interface RuntimeReapReport {
  scanned: number;                 // manifest files examined, including invalid ones
  reaped: RuntimeRecoveryRecord[];
  needsHuman: RuntimeRecoveryRecord[];
  skipped: RuntimeRecoveryRecord[];
}
```

The report buckets are `reaped`, `needsHuman`, and `skipped`. The persisted
record states are `reaped`, `needs_human`, and `skipped`; the bundled executor
writes only `reaped` and its own `needs_human` records to disk.

Execution records carry their `runtimeId`; `--json` prints the report as-is.
The human-readable output labels each record from its own `runtimeId` and does
not match state or reason text. The Supervisor's `reap` reporting uses the
executor report directly and does not run a second preflight. Report keys and
lines are plain strings; the Supervisor source contains no NUL delimiters
(blocked-candidate de-duplication uses a JSON-encoded key).

## Supervisor commands

```bash
# Explicit reconciliation of every runtime manifest under .cliyard/runtime
npm run dev -- supervisor reap --repo <path>
npm run dev -- supervisor reap --repo <path> --json
node dist/cli.js supervisor reap --repo <path> --json

# Automatic reconciliation, then normal run/resume behavior
npm run dev -- supervisor start <contracts.json> --repo <path> --worker claude
npm run dev -- supervisor resume --repo <path> --worker claude

# Read-only: shows persisted recovery records, never reconciles
npm run dev -- supervisor status --repo <path> --json
```

`reap` returns `0` after a completed scan, including when the report contains
`needs_human` candidates; read the output. Lock acquisition or scan failures
surface as process errors (exit `1`). Human output prints summary counts and one
line per record, plus one line per service action.

`start` and `resume` fail closed when **either** the read-only preflight or the
executor reports a `needs_human` candidate. The error lists runtime ids and
reasons and points at `supervisor reap --repo <path> --json`. `start` creates
no RunManifest, does not set the active pointer, and releases the supervisor
lock after the failure; `resume` leaves the run unchanged (for example
`interrupted`) and releases the lock.

`status` reads `recovery` records from every runtime manifest under
`.cliyard/runtime` (not only the selected run) and exposes them as
`runtimeRecovery` in `--json`. The record's own `runtimeId` wins; for legacy
records without one, `status` falls back to the manifest `runtimeId`, then the
runtime directory name. It does not run preflight, signal, release, or write.
Preflight-only and `skipped` results are not persisted, so they do not appear
in `status`.

## Process-level incident workflow

Use this sequence when a supervisor is killed, `start`/`resume` fails closed,
or a runtime manifest is left unfinished.

### 1. Preserve evidence before intervening

`supervisor reap` is destructive for `safe_to_reap` candidates. Copy the
artifacts **before** running it. There is no CLI preflight-only mode; the
library `preflightOrphanedRuntimes()` is read-only, but operators normally
preserve a bundle first.

```bash
REPO=/path/to/control
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
EVIDENCE=/tmp/cliyard-incident-$STAMP
mkdir -p "$EVIDENCE"

# Runtime manifests, logs, data, lease store, and locks
cp -a "$REPO/.cliyard/runtime" "$EVIDENCE/runtime"
cp -a "$REPO/.cliyard/runs" "$EVIDENCE/runs" 2>/dev/null || true
cp -a "$REPO/.cliyard/supervisor.lock" "$EVIDENCE/supervisor.lock" 2>/dev/null || true
cp -a "$REPO/.cliyard/runtime/reaper.lock" "$EVIDENCE/reaper.lock" 2>/dev/null || true

hostname > "$EVIDENCE/hostname.txt"
date -u > "$EVIDENCE/date.txt"
git -C "$REPO" rev-parse HEAD > "$EVIDENCE/head.txt" 2>/dev/null || true
ps -axo pid,ppid,pgid,lstart,command > "$EVIDENCE/ps.txt"
```

Also capture, for each affected runtime/port:

- `npm run dev -- supervisor status --repo "$REPO" --json` (read-only);
- the manifest `cleanup`, `owner`, service `pid`/`pgid`/`processIdentity`, and
  `recovery` fields;
- the exact lease entries for the `runtimeId`;
- `lsof -nP -iTCP:<port>` on macOS or `ss -ltnp` on Linux;
- the service log tail and manifest hashes;
- the supervisor RunManifest and lock owner, if a run is involved.

Do not edit or delete `runtime-manifest.json`, `port-leases.json`, service logs,
or the reaper/supervisor lock files as part of diagnosis.

### 2. Identify and verify ownership

Determine whether the manifest owner is this host and whether the owner PID is
still alive. If the owner is alive, it is not an orphan: prefer letting the
verifier finish rather than killing it and creating a new orphan. A cooperative
`supervisor stop` sends `SIGTERM` to the supervisor process, so re-check for
leftover services with `reap` afterward.

If the owner is dead, compare the persisted identity with the live process:

```bash
ps -p <pid> -o pid=,pgid=,lstart=
ps -axo pid,ppid,pgid,lstart,command | awk '$3 == <pgid>'
```

Do not kill a group based only on the `pgid` value in JSON.

### 3. Run the reaper and read the states

After the evidence bundle is complete, run:

```bash
npm run dev -- supervisor reap --repo "$REPO" --json
```

| Result | Meaning | Operator action |
|--------|---------|-----------------|
| `reaped` | Groups stopped or already exited, leased ports bindable, exact leases released, manifest `cleanup: "complete"` with a recovery record. | Confirm the record and lease store, then `resume`/`start` as appropriate. |
| `needs_human` | Any identity, group, port, lease, manifest, or persistence uncertainty. Evidence is preserved. Executor failures normally leave `cleanup: "failed"`; preflight-only failures write nothing. | Do not delete or edit the lease/manifest. Inspect the reason, fix the underlying condition, and rerun `reap`. If ownership still cannot be proven, escalate manually. |
| `skipped` | No local action: complete, already reaped, foreign host, or owner alive. | None. For a foreign host, act on that host only; this host will not kill it. |

`needs_human` is not a failure of the scan; it is the safety outcome. It blocks
`start`/`resume` while preflight continues to classify the candidate as unsafe.

### 4. Recover and retain

After `reaped`, verify:

- `cleanup` is `complete`;
- the `recovery` record names each group and whether its lease was released;
- `port-leases.json` no longer contains those exact leases;
- each released port binds on `127.0.0.1`;
- service logs and the manifest are still present for the incident record.

Then `resume` the run or `start` a new one. If `resume` still fails closed,
re-run `reap --json`; a competing manifest, a new foreign listener, or a
changed lease can turn a previously safe runtime into `needs_human`.

### Incident checklist

- [ ] Copy `.cliyard/runtime`, `.cliyard/runs`, the supervisor lock, and the
      reaper lock, if present, before running the destructive reaper.
- [ ] Record hostname, UTC time, repository HEAD, `ps` group rows, listener
      ownership, manifest/lease hashes, and log tails.
- [ ] Save `supervisor status --json`; note that it never reconciles.
- [ ] Confirm owner host and owner PID liveness; do not treat a foreign-host
      owner as locally dead.
- [ ] Compare persisted `pid`/`pgid`/`processIdentity.startedAt` with `ps`.
- [ ] Do not kill a process group from an unverified manifest or pgid alone.
- [ ] Run `supervisor reap --json` and retain its complete output.
- [ ] Never delete a lease or edit a manifest to make `needs_human` disappear.
- [ ] Do not clear `reaper.lock` manually unless no reaper is running and the
      lock is provably stale.
- [ ] After `reaped`, verify `cleanup: "complete"`, the recovery record, the
      empty leases, and port bindability before resuming.

### Failure drills and incident evidence

`cliyard runtime-drill` (measured results:
[docs/evidence/RUNTIME_FAILURE_DRILLS.md](evidence/RUNTIME_FAILURE_DRILLS.md))
exercises three `RuntimeManager` failure paths in scratch repositories:

| Scenario | Final state |
|----------|-------------|
| `readiness-timeout` | Rejected, `cleanup: "complete"`, empty lease store. |
| `verify-failure` | Rejected with command exit 7, `cleanup: "complete"`, empty lease store. |
| `cleanup-failure` | Rejected with `RuntimeCleanupError`, `cleanup: "failed"`, one lease intentionally retained. |

The drill is a manager-failure regression tool, not a reaper or supervisor
recovery drill. Its scenarios use deliberate faults (503 readiness, exit 7, an
injected allocator release failure), and its manifests contain the same
owner/PID/PGID/identity/lease fields as a real runtime. Still:

- The retained `cleanup-failure` lease is evidence. It has the scenario child's
  PID as both lease owner and manifest owner, while the service process and
  port are already clean. Do not delete that lease or edit the manifest to make
  the drill look tidier.
- A real repository showing `cleanup: "failed"` and a retained lease is an
  incident, not a drill result. Follow sections 1–4 above: preserve the bundle
  first, then run `supervisor reap --json` and act only on `reaped`,
  `needs_human`, or `skipped`.
- The drill does not relax any safety rule. Exact lease ownership
  (`lease.pid === manifest.owner.pid`), exact process identity, competing
  manifests, leader-dead groups, and every other `needs_human` condition apply
  unchanged. A drill pass is not evidence that an orphan can be killed.
- Drill evidence is single-host scratch evidence. It is not a cross-host,
  daemon, browser, SQLite, or admission-scheduling claim, and it does not
  replace an incident bundle.

## Crash-window matrix

| Situation | Runtime evidence | Reaper classification |
|-----------|------------------|-----------------------|
| Owner `SIGKILL`ed after readiness, service group alive | Owner dead, exact identity persisted, exact lease present | `safe_to_reap` → `terminated` |
| Owner exits before spawn evidence is persisted | Lease exists; service has no `pid` | `needs_human`; evidence preserved |
| Owner killed after the service exited and before cleanup | Leader gone, group empty, lease present | `safe_to_reap` → `already-exited` |
| Leader gone but helper still in the group | Leader identity cannot prove group ownership | `needs_human`; group and lease preserved |
| PID reused by an unrelated process | Persisted identity differs | `needs_human`; no signal |
| Lease owner PID differs from the manifest owner PID | Exact lease ownership fails; the third-party owner may be dead or live | `needs_human`; group, lease, and manifest preserved |
| Manifest without a valid `owner` | Owner identity absent | `needs_human` (unless already complete/reaped) |
| Legacy service without `processIdentity` | Live leader cannot be correlated; an empty group has nothing to signal | `needs_human` if the leader is live or the group is non-empty; `already-exited` if the group is empty |
| Manifest from another host | Owner host differs | `skip`; no local action |
| Another unfinished manifest shares the pid/pgid/port | Ownership ambiguous | `needs_human` |
| Group gone but a foreign listener owns the port | Port not bindable after group exit | `needs_human`; lease preserved |
| Normal cleanup completed | `cleanup: "complete"` | `skip` |
| Previous reaper already reconciled | `recovery.state: "reaped"` | `skip` |

## Limitations and remaining gaps

- **Single host only.** A manifest owned by another host is `skip`; there is no
  remote kill and no cross-host recovery. Do not share the runtime directory or
  lease store across hosts or network filesystems. Because the owner host is
  `os.hostname()`, a hostname change also makes a previously local manifest
  look foreign, and this host will not reap it.
- **Lease evidence can be pruned before reconciliation.** `PortAllocator` drops
  dead-owner leases when it reserves a new port. If an unrelated run allocates
  first, the exact lease correlation disappears and preflight reports
  `needs_human`. `start`/`resume` reconcile before their own batch allocates,
  but there is no global lock against other processes using the same repository.
- **Missing manifests are not inferred.** A runtime directory without
  `runtime-manifest.json` is ignored. A lease with no corresponding manifest
  service has no process identity to correlate, so the reaper does not touch
  it.
- **Leader-dead groups remain manual.** If the recorded leader has exited but
  the process group still has members, ownership cannot be proven from the
  persisted identity. The reaper reports `needs_human` and preserves the group
  and lease. There is no cgroup/session/command-line heuristic.
- **PID reuse is deliberately conservative.** A reused PID yields an identity
  mismatch and `needs_human`; the original process cannot be reclaimed
  automatically.
- **Exact lease ownership is required.** A lease acquired by any PID other than
  the manifest owner is `needs_human`, even when that PID is already dead. A
  dead third-party lease cannot be reclaimed automatically.
- **Legacy manifests fail closed.** Manifests without `owner` or service
  `processIdentity` cannot be proven orphaned; a live group is `needs_human`.
  An already-empty group with a valid lease may still be classified
  `already-exited`.
- **No daemon or periodic cleanup.** Reconciliation happens only when an
  operator runs `reap`, or a new supervisor `start`/`resume` acquires its lock.
  A crash with no subsequent supervisor activity leaves the orphan in place.
- **`start`/`resume` are the only automatic triggers.** A completed or skipped
  runtime is not re-verified; `cleanup: "complete"` and `recovery.state:
  "reaped"` are trusted as terminal evidence.
- **`needs_human` is not persisted for preflight-only results.** It appears in
  `reap` output and blocks `start`/`resume`, but `status` can only show records
  that were actually written. Inspect `reap --json` for the full picture.
- **Partial execution is possible.** If a later service or lease operation
  fails, earlier proven groups may already be stopped and earlier exact leases
  may already be released. The runtime is still reported `needs_human`, with
  `cleanup: "failed"` when the recovery record can be written; leases that were
  not released are preserved.
- **Port confirmation can be defeated by a foreign listener.** If another
  process grabs the port after the group exits, the reaper refuses to release
  the lease and reports `needs_human`.
- **Process identity requires macOS or Linux and `ps`.** Windows has no
  `processIdentity` capture, and the manager does not create a POSIX process
  group there. Group inspection is also unsupported, so Windows orphan
  candidates are `needs_human`; reaping is effectively unavailable on Windows.
- **No manifest/log retention policy.** Recovery stores one `recovery` object
  in the existing manifest and leaves logs/data in place. `.cliyard/` is
  gitignored and unbounded.
- **`reap` reports success of the scan, not absence of hazards.** It exits `0`
  when the report contains `needs_human`; an operator must read the report and
  `start`/`resume` will still fail closed.
- **Not a supervisor recovery mechanism.** The reaper reconciles runtime
  services and leases. The supervisor's own RunManifest/lock recovery remains
  the `status`/`resume`/`stop` workflow in [SUPERVISOR_V0.md](SUPERVISOR_V0.md).
- **Failure drills are not recovery drills.** `runtime-drill` exercises
  RuntimeManager rejection and cleanup reporting in scratch repositories. Its
  `cleanup-failure` lease is intentional evidence; the drill does not create,
  classify, or reap a real orphan, and a passing drill does not lower any
  `needs_human` threshold.
- **Signal/exit-path caveat.** RuntimeManager cleanup runs in the verifier's
  `finally`; a hard kill or a `process.exit` path that bypasses that `finally`
  can leave an orphan. That is exactly why the reaper exists.

## Verification

Measured on 2026-10-27 in this worktree (macOS). The current suite includes the
failure-drill tests:

```text
npm run build                                      → pass
npx tsx --test tests/runtime-failure-drills.test.ts → 2/2 pass (1981.8 ms)
runtime/recovery-focused group (13 files)          → 80/80 pass (3150.8 ms)
npm test                                           → 166/166 pass (8194.6 ms)
```

These are single local runs, not a repeated-run flake rate or CI claim. Drill
results: [docs/evidence/RUNTIME_FAILURE_DRILLS.md](evidence/RUNTIME_FAILURE_DRILLS.md).

Pre-drill hardening baseline (same day, before the drill tests were added):
five consecutive full-suite runs, each a separate `npm test` process run
sequentially in this worktree:

| Run | Result | Test-runner duration |
|-----|--------|----------------------|
| 1 | 164/164 pass | 8.39 s |
| 2 | 164/164 pass | 8.16 s |
| 3 | 164/164 pass | 8.04 s |
| 4 | 164/164 pass | 8.14 s |
| 5 | 164/164 pass | 8.25 s |

No flakes were observed in those five runs. This is local macOS evidence, not a
long-term flake rate or CI claim.

Runtime and recovery-focused suites (80 tests across 13 files; 78 of them
predate the drill test):

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
tests/runtime-failure-drills.test.ts                2
```

Each of those files also passed when run alone once during the earlier
measurement (and the drill file passed alone in this run).

The seven runtime test files that start real processes or bind real ports take
static, disjoint port pools from `tests/test-port-ranges.ts` (22000–22699; 100
ports per file, except the 90-port drill window); the shell-verifier tests keep
21400–21499 and 21500–21599. The
helper asserts overlap/inversion at import time and throws on pool exhaustion
when a range is taken; every allocation still goes through the real
`PortAllocator` probe/retry path inside the assigned pool.
This only prevents overlaps between test files in this repository; it is not a
production port registry, cross-run coordinator, or cross-repository claim.

Process-level coverage in those tests includes a real detached RuntimeManager
HTTP service whose owner process is `SIGKILL`ed, escalation from `SIGTERM` to
`SIGKILL`, a leader-dead group that must stay `needs_human`, a port held by a
foreign listener, concurrent reaper serialization, supervisor `reap`, `start`,
and `resume` run as separate child processes, exact lease-owner correlation,
and `runtimeId`-bearing recovery records for reaped, skipped, and needs_human
buckets.

The separate `runtime-drill` suite runs `readiness-timeout`, `verify-failure`,
and `cleanup-failure` in three independent child processes. In the measured
run, all three passed; the first two ended `cleanup: "complete"` with empty
lease stores, and `cleanup-failure` ended `cleanup: "failed"` with exactly one
retained lease while its service was gone and its port was free. Those are
manager-failure results, not reaper results; no orphan was reaped by the drill.

Design test intent coverage:

| Design test | Covered by |
|-------------|------------|
| Capture and compare exact pid/pgid/start identity | `runtime-process` |
| Manager persists owner and service identity | `runtime-manager-identity` |
| Real process starts a detached service, then owner is `SIGKILL`ed | `runtime-reaper` real E2E |
| Prove ownership, terminate, free port and lease, write evidence | `runtime-reaper` real E2E |
| Changed start identity → `needs_human`, preserve | `runtime-reaper` + `runtime-reaper-plan` |
| Foreign-host owner → skip/`needs_human`, no kill | `runtime-reaper` + `runtime-reaper-plan` |
| Mismatched lease → `needs_human` | `runtime-reaper` + `runtime-reaper-plan` |
| Completed runtime skipped | `runtime-reaper` |
| Preflight never mutates | `runtime-reaper-plan` |
| Concurrent reapers serialized | `runtime-reaper` |
| Supervisor start/resume fail closed | `supervisor-runtime-reaper` |

Hardening acceptance
([design/runtime-orphan-hardening.md](../design/runtime-orphan-hardening.md)):

| Acceptance | Evidence |
|------------|----------|
| Dead or live lease PID mismatch is `needs_human` | `runtime-owner-lease-safety` (3/3): equal dead owner is safe; dead and live third-party owners both preserve the group, lease, and byte-identical manifest |
| Executor recovery records and manifests contain `runtimeId` | `runtime-recovery-record` (3/3): reaped, skipped, and needs_human records; the persisted record matches the report; legacy records remain readable |
| Supervisor output does not infer ids from reasons | `supervisor-runtime-recovery-record` (2/2): colliding reasons stay distinctly labelled; `status` prefers the record id and falls back for legacy records |
| Supervisor source is text-clean (no embedded NUL) | byte scan of `src/` found no NUL bytes; the report test asserts no NUL delimiter in output |
| `npm test` passes five consecutive isolated runs (pre-drill baseline) | 5 × 164/164 on 2026-10-27, no flakes observed |
| RuntimeManager, reaper, and Supervisor suites remain green | current full suite 166/166; 80 runtime/recovery-focused tests across 13 files (78 pre-drill + 2 drill) |

No cross-host recovery or daemon-based cleanup is claimed or tested.

## Related documents

- Design: [design/runtime-orphan-reaper-v0.md](../design/runtime-orphan-reaper-v0.md)
- Hardening: [design/runtime-orphan-hardening.md](../design/runtime-orphan-hardening.md)
- Failure drill evidence: [docs/evidence/RUNTIME_FAILURE_DRILLS.md](evidence/RUNTIME_FAILURE_DRILLS.md)
- Normal runtime lifecycle: [docs/RUNTIME_MANAGER.md](RUNTIME_MANAGER.md)
- Supervisor run recovery: [docs/SUPERVISOR_V0.md](SUPERVISOR_V0.md)
- Next iteration: [docs/NEXT_ITERATION.md](NEXT_ITERATION.md)

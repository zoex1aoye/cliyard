# WorkerLease v1

> Recorded: 2026-10-28
>
> Status: implementation slice following execution-authority-v1

## 1. Goal

Make worker ownership recoverable when the cliyard controller process exits
without running cleanup, especially after `SIGKILL`.

The lease answers:

- which run/task/attempt owns this worker invocation;
- which controller process and host created it;
- the exact worker pid, pgid and OS start identity;
- whether the process tree is active, cleaned or ambiguous;
- whether a later controller may terminate it.

## 2. Storage

One immutable-identity lease is stored as:

```text
<repo>/.cliyard/worker-leases/<runId>/<taskId>/<leaseId>.json
```

Identity fields are never rewritten after capture. A separate atomic update
may change lifecycle fields (`active`, `released`, `cleanup-failed`, `unknown`)
and append cleanup evidence.

The lease is observational coordination, not acceptance authority.

## 3. Shape

```ts
interface WorkerLease {
  version: 1;
  leaseId: string;
  repoRoot: string;
  runId: string;
  taskId: string;
  attempt: number;
  invocationId: string;
  controller: {
    pid: number;
    host: string;
    identity: RuntimeProcessIdentity;
  };
  worker: {
    pid: number;
    pgid?: number;
    osStartIdentity?: string;
    captureMode: "posix-group" | "windows-exact-child";
  };
  workspace: string;
  startedAt: string;
  updatedAt: string;
  state: "active" | "released" | "cleanup-failed" | "unknown";
  cleanupReason?: "child-close" | "timeout" | "cancel" | "spawn-error" | "recovery";
  cleanedAt?: string;
}
```

No prompt, command line, environment value, credential or raw provider output
belongs in the lease.

## 4. Write points

1. A run/task attempt checkpoints its planned worktree before worker spawn.
2. Immediately after the worker is spawned, the adapter observes the managed
   process and persists a provisional lease with pid/pgid.
3. As soon as OS identity capture resolves, the exact identity is persisted
   before the worker result can be accepted.
4. Normal child close, timeout, cancel and spawn error update the lease with
   cleanup state.
5. A short-lived process may exit before exact identity capture. Its lease
   remains `unknown`, never fabricated from a recycled pid.

Lease persistence failure before a durable identity is a fail-closed worker
failure: the owned process should be stopped rather than left untracked.

## 5. Controller-death recovery

Add an explicit same-host command:

```bash
cliyard supervisor recover-workers --repo <path> [--run <run-id>] [--json]
```

For each active lease:

1. read bounded, strictly validated lease data;
2. if controller host is foreign, skip and report unsupported;
3. compare controller pid + OS start identity;
4. if the controller is still alive, preserve the lease and skip;
5. if the controller is dead and exact worker identity is proven:
   - terminate only the dedicated worker process group;
   - wait for exit, escalating within the existing process-tree bounds;
   - persist recovery cleanup evidence;
   - report the owning run/task as requiring resume, never as accepted;
6. if the leader/group identity is absent, mismatched or ambiguous:
   - `needs_human`;
   - preserve the lease and process tree.

Do not reattach to an orphaned CLI stdout. Recovery terminates and makes the
attempt explicitly resumable. RunManifest status and task acceptance are not
rewritten by worker recovery.

## 6. Status

`supervisor status` exposes bounded worker leases for the requested run:

- active/released/cleanup-failed/unknown counts;
- task/attempt/invocation;
- controller alive/dead/foreign/unknown;
- worker identity and capture mode;
- cleanup state and latest observation.

Malformed or missing leases are reported as degraded evidence and never turn a
run successful.

## 7. Acceptance

1. Each real worker invocation writes a lease before its result is accepted.
2. Normal exits and timeout/cancel cleanup update the same lease.
3. A fixture controller is SIGKILLed while a detached worker helper survives.
4. Recovery proves controller death and worker identity, terminates only that
   exact group, and records the result.
5. A live owner, wrong identity, wrong host or missing identity never kills.
6. RunManifest remains the task authority.
7. Windows remains exact-child/needs-human until Job Objects exist; no parity
   claim.
8. Build and full suite pass.

## 8. Non-goals

- no stdout reattachment;
- no worker survival guarantee after controller death;
- no Windows Job Object implementation in this slice;
- no cross-host kill;
- no daemon;
- no parallel queue dispatch;
- no automatic resume inside recovery;
- no dynamic routing or admission.

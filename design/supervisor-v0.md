# Supervisor v0 Design

> Revision: supervisor-v0
>
> Scope: single local repository

## Goal

Make an interrupted worker batch resumable without rerunning accepted tasks.

## RunManifest

```ts
interface RunManifest {
  version: 1
  runId: string
  planId: string
  repoRoot: string
  contractsPath: string
  contractsHash: string
  baseCommit: string
  integrationBranch: string
  integrationHead: string
  status: "running" | "interrupted" | "completed" | "blocked"
  createdAt: string
  updatedAt: string
  owner: { pid: number; host: string }
  tasks: Record<string, {
    taskId: string
    status: string
    runId?: string
    accepted: boolean
    resultCommit?: string
    reason?: string
  }>
}
```

## Storage

```text
<target>/.cliyard/runs/<runId>.json
<target>/.cliyard/runs/active.json
<target>/.cliyard/supervisor.lock
```

Manifest writes use temp file + rename. Supervisor lock is exclusive and records
PID, host, runId and timestamp.

## Commands

```bash
cliyard supervisor start <contracts.json> --repo <path> [--worker claude]
cliyard supervisor status --repo <path> [--run <id>]
cliyard supervisor resume --repo <path> [--run <id>]
cliyard supervisor stop --repo <path> [--run <id>]
```

`start` may run in foreground for V0. Backgrounding is a separate slice.

## Resume rules

- Reject if contracts hash differs.
- Reject if base commit differs.
- Reject if integration branch does not exist.
- Do not rerun tasks with `accepted=true`.
- Retry rejected tasks only when explicitly requested.
- Rebuild pending/ready from contract DAG and accepted set.
- Lock is released on normal exit and stale lock can be diagnosed by status.

## State transitions

```text
running
  → checkpoint after accepted task
  → completed when all accepted
  → blocked when dependencies cannot progress
  → interrupted on signal / stale owner
```

V0 does not need a network daemon. It must first prove durable resume semantics.


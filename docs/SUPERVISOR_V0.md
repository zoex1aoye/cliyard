# Supervisor v0 — Durable Foreground Runs

> Status: implemented (Supervisor v0 slice) — 2026-10-26
> Design authority: [design/supervisor-v0.md](../design/supervisor-v0.md)
> Scope: one local git repository, one supervisor at a time

Supervisor v0 makes a worker batch resumable. It persists a **RunManifest** in
the target repository, checkpoints every accepted task and the integration
head, and after a crash replays only the unfinished part of the contract DAG.

It is deliberately **not** a service:

- `start` and `resume` run in the foreground and hold a lock until they exit;
- state is atomic JSON, not SQLite;
- accepted work lands on a local integration branch, never directly on `main`;
- there is no background daemon, no scheduler process, and no claim of 24h
  unattended operation.

## 1. What v0 guarantees

| Guarantee | v0 behavior |
|-----------|-------------|
| Durable checkpoint | A manifest is written after every accepted or rejected task. |
| No accepted-task rerun | `resume` skips every task with `accepted: true`. |
| Recoverable integration state | Accepted snapshots are merged into `cliyard/integration/<runId>`; the branch is the recovery checkpoint. |
| Preconditions before dispatch | Resume refuses changed contracts, a moved base commit, a missing integration branch, or an unreviewed rejected task. |
| One writer per repo | `.cliyard/supervisor.lock` is created with `O_EXCL` and records run id, PID, host and timestamp. |
| Diagnosable interruption | `status` reports a stale owner as `interrupted` without mutating the run. |

`status` is read-only and is always safe to run. Of the supervisor commands,
only `start` and `resume` dispatch workers.

## 2. Commands

```bash
cliyard supervisor start <contracts.json> --repo <path> [--worker claude|codex]
                              [--model id] [--plan-id id] [--ledger path]
                              [--dry-run] [--keep-worktrees] [--verbose]
cliyard supervisor status --repo <path> [--run id] [--json]
cliyard supervisor resume --repo <path> [--run id] [--worker claude|codex]
                          [--model id] [--dry-run] [--keep-worktrees]
                          [--retry-rejected] [--force] [--verbose]
cliyard supervisor stop --repo <path> [--run id] [--force]
```

Run the same commands through the repository scripts before a build:

```bash
npm run dev -- supervisor start <contracts.json> --repo <path> --worker claude
npm run dev -- supervisor status --repo <path> --json
```

After `npm run build`, use `node dist/cli.js supervisor …`, or the installed
`cliyard` binary.

### Common options

| Flag | Meaning |
|------|---------|
| `--repo <path>` | Target git repository. Defaults to the current directory. |
| `--run <id>` | Select a manifest. `status`, `resume` and `stop` default to the run recorded in `.cliyard/runs/active.json`. |
| `--worker claude\|codex` | Worker adapter. Defaults to `claude`; no other worker is accepted by the supervisor. |
| `--model <id>` | Forwarded to the worker adapter. |
| `--ledger <path>` | Dispatch ledger. Defaults to `<repo>/.cliyard/ledger.json`. |
| `--dry-run` | Use the mock worker and mock verifier. Verify commands are **not** executed, but real git branches and checkpoints are still created. Rehearsal only. |
| `--keep-worktrees` | Keep task and integration worktrees after the batch. |
| `--verbose` | Forward scheduler progress to stdout. |

### `start`

```bash
cliyard supervisor start <contracts.json> --repo <path> --worker claude
```

- `<contracts.json>` is resolved relative to `--repo`. JSON arrays,
  `{ "contracts": [...] }`, a single contract, and YAML taskfiles are accepted;
  every contract must be `frozen: true`, use an empty `sharedResources`, and
  have write paths that do not overlap another task's.
- All contracts must resolve to one shared base commit. `baseCommit` is
  normally a full commit SHA; the symbolic `HEAD` works only while the
  repository HEAD does not move. Pin a full SHA for resumable runs.
- The run id is a fresh UUID. The plan id is `--plan-id`, or the contracts file
  basename without its extension. The integration branch is always
  `cliyard/integration/<runId>`.
- The supervisor acquires `.cliyard/supervisor.lock` **before** writing the
  manifest, so a held lock never leaves a half-started run behind.
- Execution is foreground. `SIGINT` / `SIGTERM` mark the manifest
  `interrupted`, release the lock and exit 130 / 143.
- Exit code is `0` only when the final manifest status is `completed`.
  Rejections, blocked tasks, or an exception return `1`.

### `status`

```bash
cliyard supervisor status --repo <path> [--run <id>] [--json]
```

Read-only. Reports the manifest status, the effective status, task counts,
integration branch and recorded head, lock state and owner, last checkpoint,
the last accepted task in manifest order, and the contracts hash.

`effectiveStatus` is `interrupted` when the manifest still says `running` but
the owner PID is gone on the same host. A hard-killed supervisor therefore
shows as interrupted even though its last durable status is `running`. When the
owner is on another host, `ownerAlive` is `null` and liveness cannot be proven;
the manifest status is reported as-is.

Exit code is `0` for any readable run, including interrupted or blocked runs.
A missing or malformed manifest is an error.

### `resume`

```bash
cliyard supervisor resume --repo <path> [--run <id>] [--worker claude]
```

`resume` never takes a contracts argument: it uses the absolute path and
SHA-256 recorded in the manifest. It runs these checks in order, before any
worker dispatch:

1. The manifest is readable and not already `completed` (a completed run is a
   no-op, exit `0`).
2. The contracts file is byte-identical to the recorded SHA-256.
3. The contracts still resolve to the manifest's `baseCommit`.
4. The integration branch `refs/heads/<integrationBranch>` exists.
5. If any non-accepted task is `rejected`, `--retry-rejected` is required.
6. The supervisor lock can be acquired.

After the lock, the manifest is marked `running`, ownership is updated to the
current process, and every non-accepted task is reset to `ready`. The worker
batch then rebuilds waves from the contract DAG and re-checks that:

- the manifest belongs to this repository;
- every tracked task still exists in the contracts;
- the integration branch contains the recorded `integrationHead`;
- every accepted task's `resultCommit` is contained in the integration branch.

If any check fails, nothing is dispatched.

Flags specific to resume:

- `--retry-rejected` — explicitly retry rejected (and other non-accepted)
  tasks. Retry is all-or-nothing; there is no per-task selection.
- `--force` — replace an **invalid** lock file. It does not override a live
  lock, and it does not skip contracts/base/integration checks.

Exit code is `0` only for a completed run (including the already-completed
no-op); otherwise `1`.

> Do not use `--dry-run` to resume a real run. Mock verification can mark
> remaining tasks accepted and merge mock snapshots into the integration
> branch. Use a scratch repository for rehearsals.

### `stop`

```bash
cliyard supervisor stop --repo <path> [--run <id>] [--force]
```

Cooperative shutdown of the run that owns the lock:

- If the lock belongs to a different run, `stop` refuses, even with `--force`.
- If the owner is this process, it refuses to signal itself unless `--force`
  is given; with `--force` it skips the signal, drops the lock and marks the
  run `interrupted`.
- If the owner is alive on the same host, it sends `SIGTERM` and waits up to
  5 seconds for exit. It does not escalate to `SIGKILL`.
- If the owner is on another host, liveness cannot be checked; `--force` is
  required after confirming the owner exited.
- A stale lock (same host, dead PID) is cleared automatically.
- An invalid lock is removed only with `--force`.
- Finally, a `running` manifest is marked `interrupted`.

`stop` removes the lock, not the worktrees or the integration branch. Resume
afterwards if the work is still wanted. Exit code is `0` after the stop
sequence; an error (wrong run, unresponsive owner, still-held lock without
`--force`) returns `1`.

## 3. On-disk state

```text
<repo>/.cliyard/runs/<runId>.json      RunManifest checkpoint
<repo>/.cliyard/runs/active.json       pointer to the run used by default
<repo>/.cliyard/supervisor.lock        exclusive supervisor ownership
<repo>/.cliyard/ledger.json            dispatch ledger (default)
<repo>/.cliyard/worktrees/<id>-…       transient task / integration worktrees
<repo> refs/heads/cliyard/integration/<runId>   integration checkpoint
```

`.cliyard/` is gitignored. Manifests and the active pointer are written through
a same-directory temp file plus `rename`, with `fsync` before the rename. A
reader sees either the previous complete checkpoint or the new one, never a
partially written JSON file. The lock file is created directly with `O_EXCL`
and mode `0600`, then populated with the owner record.

### RunManifest

```json
{
  "version": 1,
  "runId": "9d0c…",
  "planId": "supervisor-selfhost-1",
  "repoRoot": "/abs/path/to/repo",
  "contractsPath": "/abs/path/to/repo/design/selfhost.contracts.json",
  "contractsHash": "hex-sha256-digest",
  "baseCommit": "full-git-sha",
  "integrationBranch": "cliyard/integration/9d0c…",
  "integrationHead": "full-git-sha",
  "status": "running",
  "createdAt": "2026-10-26T00:00:00.000Z",
  "updatedAt": "2026-10-26T00:01:00.000Z",
  "owner": { "pid": 12345, "host": "workstation" },
  "tasks": {
    "manifest-store": {
      "taskId": "manifest-store",
      "status": "accepted",
      "accepted": true,
      "resultCommit": "full-git-sha"
    }
  }
}
```

| Field | Meaning |
|-------|---------|
| `version` | Manifest schema version. v0 reads and writes only version `1`. |
| `runId` | UUID; also used in manifest path, lock owner and integration branch. |
| `planId` | Human label from `--plan-id` or the contracts basename. Not a foreign key to a stored plan. |
| `repoRoot` | Absolute repository root. Immutable. |
| `contractsPath` | Absolute contracts path recorded at creation; resume hashes this exact file. |
| `contractsHash` | Bare hex SHA-256 of the contracts file **bytes**. Any edit invalidates the run. |
| `baseCommit` | The single resolved base commit shared by all contracts. |
| `integrationBranch` | `cliyard/integration/<runId>`; the durable integration checkpoint. |
| `integrationHead` | Last commit checkpointed on the integration branch. Updated after each accepted task and at finalization. |
| `status` | `running`, `interrupted`, `completed`, or `blocked`. |
| `createdAt`, `updatedAt` | ISO timestamps. `updatedAt` is the last checkpoint time. |
| `owner` | PID and host of the supervisor that last wrote the manifest. |
| `tasks` | Map of task id to task state. |

Task state:

| Field | Meaning |
|-------|---------|
| `taskId` | Contract task id. |
| `status` | A task status such as `ready`, `accepted`, `rejected`, or `blocked`. |
| `accepted` | Resume authority. `resume` never redispatches `true`. |
| `resultCommit` | Snapshot commit produced by the accepted task and merged into the integration branch. |
| `reason` | Rejection reason or `blocked: dependencies not accepted`. |
| `runId` | Reserved for worker-run correlation; the v0 checkpoint path does not populate it. |

`runId`, `repoRoot` and `version` are immutable; the store rejects a mutation
that changes any of them. All other manifest fields are written only by the
supervisor/batch checkpoint path.

`active.json` is `{ "version": 1, "runId": "…", "updatedAt": "…" }`. `start`
and `resume` set it; `stop` does not clear it. When `--run` is omitted,
`status`, `resume` and `stop` fall back to it.

## 4. Lifecycle and checkpointing

```text
start / resume
      │
      ▼
   running ── accepted tasks only, none pending ──▶ completed
      │
      ├── rejected / no ready task ────────────────▶ blocked
      │
      ├── SIGINT / SIGTERM / thrown error ────────▶ interrupted
      └── SIGKILL / host death ────────────────────▶ running on disk,
                                                    reported as interrupted
```

1. `start` validates the contracts, resolves the shared base, acquires the
   lock, writes the manifest and sets the active pointer.
2. The batch creates or reattaches the integration worktree. A fresh run
   creates the integration branch at `integrationHead` (initially the base
   commit). A resume reuses the existing branch and verifies ancestry.
3. Ready tasks are taken wave by wave from the contract DAG. Each task gets an
   isolated worktree based on the current integration head.
4. After the worker exits, the verifier runs the contract's `verifyCommands`.
   On acceptance, only the declared `writePaths` are snapshotted into a task
   commit and merged into the integration branch.
5. Immediately after the merge, the manifest is checkpointed with
   `accepted: true`, `resultCommit`, and the new `integrationHead`. A rejected
   task is checkpointed with `accepted: false` and a reason; nothing is merged.
6. The loop continues until every task is accepted or no ready task remains.
   Tasks that cannot progress are written as `blocked` with
   `blocked: dependencies not accepted`.
7. The final checkpoint sets `integrationHead` and marks the run `completed`
   only when every task was accepted; otherwise it is `blocked`.
8. Worktrees are removed unless `--keep-worktrees` was given. With a manifest,
   the integration worktree is removed but the **branch is kept** as the
   checkpoint. The lock is released on normal exit, on a thrown error and on
   the signal handlers.

The ledger records dispatch/repair history. The RunManifest is the resume
authority; the ledger is not used to decide what to rerun.

### Crash windows

- **Crash before any accepted task:** the task remains non-accepted and is
  rerun on resume. The integration branch may not exist yet; in that case
  `resume` rejects (see limitations) and a new run is required.
- **Crash after a worker accepted and its snapshot was merged, but before the
  checkpoint write:** the commit is on the integration branch but the manifest
  does not yet record it. Resume reruns that task. This is an **at-least-once**
  window; accepted checkpoints themselves are never rerun.
- **Crash after a checkpoint:** the accepted task and integration head are
  durable. Resume continues from the next ready wave.
- **Hard kill (`SIGKILL`) after a checkpoint:** the manifest stays `running`,
  the lock stays behind. `status` reports it as `interrupted`; `resume` clears
  the stale lock and continues.
- **Crash after final checkpoint but before cleanup:** the run is already
  `completed`. Worktrees can be pruned; the integration branch is the result.

## 5. Lock and recovery semantics

### Lock states

| State | Condition | `status` | `start` | `resume` |
|-------|-----------|----------|---------|----------|
| `free` | No lock file | reports free | acquires | acquires |
| `held` | Same host, owner PID alive | reports owner | fails | fails |
| `held` (remote) | Owner host differs; liveness unknowable | reports remote owner | fails | fails |
| `stale` | Same host, owner PID gone | reports stale | **fails** (no auto-clear) | clears, then acquires |
| `invalid` | Unreadable/corrupt lock JSON | reports invalid | fails | fails unless `--force` |

`start` never clears an existing lock. Recover a stale lock with `resume`
(automatic) or `stop` (explicit), then start a new run if that is what you
want.

The lock is a coordination mechanism between cliyard processes, not a security
boundary. External git operations or manual file edits can still invalidate a
run. Normal release and `stop --force` remove a lock only while its valid owner
record still matches what was inspected; a replacement lock with a different
record is not deleted. An invalid lock has no owner record to compare.

### Resume preconditions

A resume is refused, before dispatch, when:

| Condition | Error / response |
|-----------|------------------|
| No manifest / no active run | `run manifest not found` or `no active supervisor run` |
| Manifest version unknown or malformed | manifest parse error |
| Run already `completed` | no-op, exit `0` |
| Contracts file bytes changed | `contracts hash mismatch` |
| Contracts base resolves to a different commit | `base commit changed` |
| Integration branch missing | `cannot resume without the integration checkpoint` |
| Rejected task present without `--retry-rejected` | lists rejected tasks and exits |
| Another supervisor holds the lock | `SupervisorLockHeldError` |
| Invalid lock without `--force` | asks for `--force` |
| Integration branch lost recorded head / accepted commit | hard error before dispatch |

### Recovery playbook

| Symptom | Meaning | Action |
|---------|---------|--------|
| `effectiveStatus: interrupted`, lock `stale` | Owner died; lock left behind | `resume` (auto-clears) or `stop` |
| `effectiveStatus: interrupted`, lock `free` | Owner died; lock already released | `resume` |
| `status: blocked`, tasks `rejected` | Verification failed | Read `reason` and the ledger; fix the environment or failure; `resume --retry-rejected` |
| `status: blocked`, tasks `blocked` | Dependencies never accepted | Fix the rejected dependency and retry; if the contract itself is wrong, start a new run |
| Lock held by a live PID | A supervisor is working | Wait; do not start or resume |
| Lock held on another host | Liveness cannot be checked | Confirm on that host, then `stop --force` and `resume` |
| Lock `invalid` | Corrupt lock file | Inspect the file and confirm no supervisor is running; `resume --force` (or remove the lock manually) |
| Lock exists, no manifest | Crash between lock and manifest write | Inspect the lock, confirm the PID is gone, remove the file manually |
| Integration branch missing | Checkpoint lost | Do not guess; restore the ref or abandon the run and start a new one |
| Contracts hash mismatch | Contracts were edited | Restore the exact bytes, or start a new run with the corrected contracts |
| Base commit changed | `HEAD` moved or contract base changed | Restore the repository/contracts, or start a new run |

A rejected task caused by a bad contract cannot be fixed in place: the
contracts file is immutable for the run, and editing it breaks the hash
precondition. Fix the inputs and start a new run, or restore the original
contracts bytes and retry the task against the same frozen contract.

## 6. Limitations

- **Foreground only.** The supervisor process is the run. Closing the terminal
  or losing the host stops it; no daemon restarts it. V0 is not 24h unattended
  infrastructure.
- **JSON, not SQLite.** Each checkpoint rewrites the whole manifest. There is
  no cross-run query, no transaction layer beyond atomic file replacement, and
  no migration path yet.
- **One repository, one owner.** The lock is per repository root. Two
  supervisors cannot operate on the same repository, even for different runs.
- **Same-host liveness only.** A remote-host lock is treated as held;
  `resume` cannot override it. Confirm the remote owner is gone, then
  `stop --force` and resume. A running manifest whose owner is remote and whose
  lock is already missing cannot be proven dead.
- **No automatic integration to `main`.** The integration branch is local and
  the final merge is manual. Nothing is pushed.
- **No manual task surgery.** There is no command to accept, reject, edit or
  selectively retry one task. Acceptance comes from the worker plus verifier;
  retry applies to all non-accepted tasks.
- **Contracts are frozen per run.** Any byte change invalidates resume. A bad
  contract means a new run.
- **Completed runs are closed.** `resume` will not reopen a completed run, even
  with `--retry-rejected`. Start a new run to redo work.
- **At-least-once crash window.** A crash between merge and checkpoint can
  rerun an otherwise accepted task. Work is not lost; it can be regenerated.
- **No worktree/manifest garbage collection.** Runs, branches, manifests and
  any kept worktrees accumulate. Cleanup is manual.
- **Worker set is claude or codex.** CodeBuddy is not wired into the
  supervisor path.
- **Dry-run is not verification.** It uses mock worker/verifier output, skips
  real `verifyCommands`, and still writes branches/checkpoints. Never mix a
  dry-run resume into a run you intend to merge.
- **Cooperative stop.** `stop` sends `SIGTERM` to a same-host owner and waits
  5 seconds; it does not escalate to `SIGKILL`.
- **PID-based liveness.** A recycled PID could be mistaken for the owner. Use
  `status --json` to inspect the lock's run id and acquisition timestamp when
  in doubt.
- **No backgrounding, multi-tenant, remote execution, Web/GUI or
  RuntimeManager.** These remain outside v0.

## 7. Verification evidence

On 2026-10-27 in this checkout:

```text
npm run build   → pass
npm test        → 86/86 pass
```

The supervisor suites cover manifest durability, active pointer, atomic writes,
lock exclusivity/staleness, contracts/base rejection, `start`/`status`/
`resume`/`stop`, and an interruption scenario where the first wave is accepted,
the second wave's dispatch fails, a new scheduler invocation reloads the
manifest from disk, and only unfinished tasks run.

The CLI suite also launches a separate Supervisor process with a controlled
worker, waits until the first task is checkpointed and the second task is
running, then sends `SIGKILL` to the whole process group. A new process reads
`effectiveStatus=interrupted` and `lock=stale`; `resume` clears the stale lock,
starts only the unfinished task, preserves the accepted task commit, and
finishes with the integration branch containing both outputs.

## 8. Safe tool self-hosting procedure

Goal: use the **stable** cliyard to change cliyard itself, with reviewable
diffs and a rollback path. This remains a manual merge procedure. The first
Supervisor v0 implementation was produced through the older plan-dispatch
control path and reviewed before merge; a live self-hosting run owned by the
new Supervisor remains the next proof.

### Roles

| Role | Location | Rule |
|------|----------|------|
| Control checkout | Frozen baseline commit | Runs the stable supervisor. Workers must not modify it. |
| Contract + plan | Committed before `start` (plan in B, contracts in C) | Immutable for the run; `baseCommit` pinned to a full SHA. |
| Task worktrees | `<repo>/.cliyard/worktrees/<id>-…` | The only place workers write source code. |
| Integration branch | `cliyard/integration/<runId>` | Accepted snapshots only; human-reviewed before merge. |
| Human reviewer | Outside the worker loop | Reviews, runs final gates, merges manually. |

### Hard rules

1. The supervisor process and its checkout are never modified by a worker.
2. Workers write only inside their task worktrees. No task may write
   `.cliyard/supervisor.lock`, `.cliyard/runs/*`, the control checkout, or
   outside the repository.
3. The contracts file and its base commit are frozen before `start`; do not
   edit either while the run is active.
4. Every task has disjoint `writePaths`, empty `sharedResources`, and a size
   that is not XL. Split XL work first.
5. Every task has verification that runs in its worktree and is hermetic. Do
   not run `npm install`/`npm ci` or otherwise mutate dependencies in
   `verifyCommands`: cliyard may link the control checkout's `node_modules`
   into task worktrees, so dependency mutation there can leak back. The
   integration review runs the full build and test suite as the final gate.
6. Never hot-reload the running supervisor. Stop the run, merge, restart.
7. Automatic merge to `main` is forbidden. A human merges after review.
8. The new supervisor's first boot is read-only: `--help`, `status`, and a
   dry-run/scratch interruption drill before it owns a real run.
9. Keep the previous baseline ref and binary until the new version passes.
10. Test recovery by interrupting a real process, not only by throwing inside
    a state object.

### Phase A — freeze a reproducible baseline

```bash
cd /path/to/cliyard-control
git status --short          # source tree must be clean; only ignored artifacts and dependency symlinks may remain
npm run build
npm test
git rev-parse HEAD           # this is the base commit (B)
```

Commit or tag B through the normal review process. The design pack and plan
source must be part of B so workers see them in their worktrees. Then compile
the frozen contracts from B to a **tracked** path:

```bash
npm run estimate-plan -- design/selfhost-1.plan.json
npm run plan-dispatch -- design/selfhost-1.plan.json --repo . \
  --out design/selfhost-1.contracts.json
git add design/selfhost-1.contracts.json
```

`plan-dispatch` without `--dispatch` only compiles and validates. It resolves
the current `HEAD` into every contract's `baseCommit` (B), rejects unknown
dependencies, cycles, repo-external paths and overlapping `writePaths`. Commit
the contracts as a separate commit **C**; record both B (the run base) and C
(the contracts commit) as the baseline evidence. The integration branch starts
at B, so it contains the design pack and plan but not the generated contracts
commit — that is expected; the manifest records the contracts path and hash.

Baseline gate:

- [ ] `npm run build` and `npm test` pass on the baseline.
- [ ] The worktree is clean apart from ignored artifacts and dependency
      symlinks.
- [ ] Design and plan are committed in B; contracts are committed in C.
- [ ] Every contract is `frozen: true`, uses one pinned base SHA, and has
      disjoint write paths.
- [ ] `estimate-plan` shows no XL task.
- [ ] The control checkout has a usable `node_modules` directory that git
      ignores, so task worktrees can link dependencies. A symlinked
      `node_modules`, as used by some cliyard worktrees, is not detected as
      ignored and will not be linked.
- [ ] The stable supervisor will run from the control checkout, not from a
      task worktree.

### Phase B — rehearse in a scratch repository

Do not rehearse in the control checkout. Clone it to a disposable location and
run the stable tool against that clone. `start` resolves a relative contracts
path against `--repo`, so use an absolute path that points inside the clone:

```bash
git clone /path/to/cliyard-control /tmp/cliyard-selfhost-rehearsal
CONTRACTS=/tmp/cliyard-selfhost-rehearsal/design/selfhost-1.contracts.json
npm run dev -- supervisor start "$CONTRACTS" \
  --repo /tmp/cliyard-selfhost-rehearsal --worker claude --dry-run
npm run dev -- supervisor status --repo /tmp/cliyard-selfhost-rehearsal --json
```

The dry run exercises lock acquisition, manifest creation, DAG waves,
checkpointing, integration commits and cleanup. Because mock verification does
not run the contract's real `verifyCommands`, a completed dry run is **not**
evidence that the change works.

### Phase C — dispatch the real self-host run

From the frozen control checkout:

```bash
npm run dev -- supervisor start design/selfhost-1.contracts.json \
  --repo /path/to/cliyard-control --worker claude
```

Operate the run:

```bash
# Observe from another terminal; status is read-only.
npm run dev -- supervisor status --repo /path/to/cliyard-control --json

# After a crash or signal:
npm run dev -- supervisor resume --repo /path/to/cliyard-control --worker claude

# Only after fixing an environmental failure; retries all non-accepted tasks:
npm run dev -- supervisor resume --repo /path/to/cliyard-control --retry-rejected

# Abort cooperatively:
npm run dev -- supervisor stop --repo /path/to/cliyard-control
```

Rules during the run:

- Do not edit the control checkout, contracts, or the supervisor source.
- Do not merge anything into `main`.
- Do not run `resume --dry-run` against this run.
- Do not remove `.cliyard/` or the integration branch.
- If a task rejects because the contract is wrong, stop and start a new run
  with corrected contracts; do not edit the running contracts.

### Phase D — validate the integration branch

The run's result is the integration branch, not the control working tree.
Inspect it in a separate review worktree:

```bash
git log --oneline <baseCommit>..cliyard/integration/<runId>
git diff <baseCommit>...cliyard/integration/<runId> --stat
git worktree add /tmp/cliyard-review cliyard/integration/<runId>
cd /tmp/cliyard-review
npm ci
npm run build
npm test
test -f design/supervisor-v0.md   # design authority still present as expected
```

If the integration worktree is still attached because `--keep-worktrees` was
used, inspect it there instead of adding a second worktree for the same
branch.

Review gates:

- [ ] `npm run build` and `npm test` pass on the integration branch. The suite
      includes the pre-existing baseline tests plus the new tests.
- [ ] Every changed file is within a declared `writePaths` entry.
- [ ] No supervisor state, ledger, lock, secret or generated artifact was
      committed into the integration branch.
- [ ] No task modified the design authority files unless that was an explicit,
      reviewed deliverable.
- [ ] The diff is reviewable task by task; rejection reasons are understood.
- [ ] `status --json` shows all tasks accepted, `completed`, and the expected
      integration head.

Then drill the new supervisor's first boot without giving it a real run:

```bash
node /tmp/cliyard-review/dist/cli.js supervisor --help
node /tmp/cliyard-review/dist/cli.js supervisor status \
  --repo /tmp/cliyard-selfhost-rehearsal --json
# Optional: run the process-level interruption drill in a fresh scratch repo.
```

The new supervisor must pass the read-only/status and `--dry-run` gates before
it is allowed to own a real run.

### Phase E — human review, merge and restart

1. Review the task commits and integration diff against the contracts.
2. Merge the integration branch through the normal branch/review process. Do
   not auto-merge and do not push on the worker's behalf.
3. Re-run `npm run build` and `npm test` on the merged commit.
4. Stop the old supervisor, replace the control checkout, and start the new
   version from the merged commit.
5. Record the evidence for the next iteration: run id, contracts hash, base
   commit, integration branch and head, task list, test output, review
   decision.
6. Keep the previous baseline ref and binary until the new version has
   completed at least one supervised run.

### Abort and rollback

- Baseline tests fail or the tree is dirty: do not start.
- Contracts overlap, include `sharedResources`, or have an XL task: do not
  start; fix the plan and recompile.
- A task rejects repeatedly: stop, inspect the ledger and task reason; fix the
  environment only if the contract is still correct, then
  `resume --retry-rejected`.
- The integration branch lost the recorded head or an accepted commit: do not
  force; restore the ref or abandon the run.
- The new supervisor fails its first boot: roll back to the previous baseline
  ref and binary. Do not use the failing version to repair itself.
- The run cannot be trusted: `stop`, keep the manifests and branch for
  diagnosis, and start a fresh run from the old baseline.

## 9. Related documents

- [design/supervisor-v0.md](../design/supervisor-v0.md) — design authority.
- [docs/NEXT_ITERATION.md](NEXT_ITERATION.md) — current status and the next
  verification/self-hosting iteration.
- [README.md](../README.md) — command overview.
- [docs/KEY_MIND.md](KEY_MIND.md) — product thesis and the supervisor's role.

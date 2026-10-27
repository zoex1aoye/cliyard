# Plan-backed Chained Queue Base v0 — Measured Evidence

> Date: 2026-10-27
>
> Environment: macOS (Darwin 27.0.0), Node `v20.20.2`, cliyard HEAD
> `7cbd33d781616a2f921373335dd0516013a4a657`, Claude Code `2.1.185` through
> `claude-ds`, model `deepseek-flash[1m]`.
>
> Scope: one linear queue dependency whose downstream contracts are compiled
> deterministically from an explicitly approved Plan at the completed upstream
> RunManifest `integrationHead`. Measurements use scratch Git repositories under
> `/tmp/cliyard-pbc-evidence/`, `/tmp/cliyard-pbc-docs.xfARmU/`,
> `/tmp/cliyard-pbc-verify.ECxtih/` and `/tmp/cliyard-pbc-neg.WM94V1/`, the
> focused test suites, and three real Claude Code + DeepSeek two-item chains. The third chain and the test counts
> below were re-measured during the final documentation pass on the same HEAD.
> These are single local runs, not a CI, flake-rate, cost, quality or
> 24-hour/daemon claim.
>
> Update 2026-10-27 (later): the explicit upstream `readPaths` failure in §9
> was fixed by pinned-base read-context validation and re-measured separately
> in [CHAINED_READ_CONTEXT.md](CHAINED_READ_CONTEXT.md). All measurements below
> remain the historical runs at HEAD `7cbd33d`.

This document measures the implementation described by
[design/plan-backed-chain-v0.md](../../design/plan-backed-chain-v0.md). No
source, test, contract, run or design-authority file was changed by this
documentation task. Scratch repositories and logs are outside the repository
and are not committed.

The queue is still **not a daemon**. `queue run` is a foreground, sequential
command. The **RunManifest remains the task-level authority**; the queue never
writes a RunManifest. Plan-backed materialization is deterministic contract
compilation from an already-approved Plan — it is **not** automatic Plan
generation or approval. A Plan item's contracts do not exist until immediately
before its first dispatch.

## 1. Source model and commands

`queue add-plan` snapshots one approved Plan. `planPath` presence is the
source discriminator; there is no `source` field and legacy contract-backed
items keep their existing v1 fields.

```bash
cliyard queue add-plan <plan.json> --repo <path> --id <queue-id> \
  [--depends-on <id>] \
  [--worker claude|codex] [--model <id>] [--max-attempts <n>] [--json]
```

- A **root** Plan item persists `planBaseCommit`, the exact repository `HEAD`
  resolved once by `queue add-plan`.
- A **dependent** Plan item records no root base. Its base is selected at
  dispatch from the single upstream item's last completed RunManifest
  `integrationHead`.
- A Plan item has at most **one** queue dependency in v0. A dependent Plan item
  may depend on either a Plan-backed or a contract-backed item; the upstream
  item's recorded contracts identity is the evidence link.
- `queue add <contracts.json>` is unchanged and keeps its own frozen
  `contractsPath`/`contractsHash`/`baseCommit` behavior. Contract-backed items
  may still have several dependencies; they do not chain code bases.

`queue list`, `retry`, `cancel` and `run` apply to both source kinds and print
Plan identity, pinned/materialized base, upstream lineage, generated contracts
path and contracts hash.

## 2. Build and test counts

Run from the cliyard checkout:

| Command | Result | Test-runner duration |
|---------|--------|----------------------|
| `npm run build` | exit `0` | — |
| `npx tsx --test tests/plan-backed-materializer.test.ts` | 16/16 pass | 1587.0 ms |
| `npx tsx --test tests/plan-backed-queue-core.test.ts` | 10/10 pass | 4196.9 ms |
| `npx tsx --test tests/plan-backed-queue-cli.test.ts` | 5/5 pass | 728.5 ms |
| `npm test` (full suite) | 236/236 pass | 12420.3 ms |

Focused total is 31/31 across three separate commands (not one combined run).
The full suite includes these 31 tests plus all prior supervisor,
queue, attempt-continuity/progress, Task Architect, runtime and drill groups.
Those other groups were not separately re-run this round. Results are one local
macOS run, not a repeated-run flake rate or a CI claim.

## 3. `queue add-plan` validation and snapshot

Measured through the built CLI on a fresh scratch repository
(`/tmp/cliyard-pbc-neg.WM94V1/repo`; no worker was invoked for any rejection,
and the durable queue was unchanged after the failed adds):

| Input | Exit | Recorded message |
|-------|------|------------------|
| `--id ../escape` | `1` | `invalid queue id: "../escape" (use letters, digits, '.', '_' or '-', max 128 characters)` |
| duplicate id `good` | `1` | `duplicate queue id "good"` |
| unknown `--depends-on missing` | `1` | `queue item "orphan" depends on unknown item "missing"` |
| two `--depends-on` values | `1` | `plan-backed queue item "multi" supports at most one dependency in v0 (got 2)` |
| Plan declares `declared`, `--id mismatch` | `1` | `Plan id mismatch: Plan declares "declared", queue item id is "mismatch"` |
| missing Plan file | `1` | `Plan file is missing or unreadable: … (ENOENT …)` |
| malformed JSON Plan | `1` | `cannot parse Plan …: invalid Plan JSON: …` |
| invalid Plan schema (`tasks: []`) | `1` | `invalid Plan …: tasks: must be a non-empty array of module plans` |
| unsafe task write path (`../escape.txt`) | `1` | `invalid Plan …: must stay inside the repository and be relative …` |
| overlapping task write paths | `1` | `invalid Plan …: "b" overlaps "a" at same.txt …` |
| `--max-attempts 0` | `1` | `queue: --max-attempts must be a positive integer (got 0)` |

After all eleven failed mutations, the durable queue was byte-identical
(SHA-256 `07a9e3516d3886d5ac906578a3643b3a8380ba6bf9c39a411ab573407c9c2a88`)
and still contained only the single `good` item. Invalid schema, unsafe paths
and overlapping writes are rejected by the existing `compilePlan` at add time;
the plan-backed code does not reimplement those rules.

The focused tests additionally measure: a missing Plan on `add-plan`; a
durable dependency cycle; and a failed add never appending a partial item. The
CLI focused file exercises unsafe id, malformed/invalid Plan, Plan-id
mismatch, unknown dependency and more than one dependency through
`runQueueCli` and leaves the queue at `["good", "second"]`.

The mutation performs these steps under the queue lock:

1. Validate the queue id, duplicate ids and `planPath`.
2. Read the Plan bytes exactly once, hash them with SHA-256, then parse.
3. Reject more than one dependency, unknown dependencies and cycles.
4. Resolve the repository `HEAD` to a full commit SHA.
5. Compile the Plan with the existing `compilePlan` at that HEAD.
6. Require `compiled.planId === queue id`.
7. Persist `planPath`, `planHash`, `planId`, and — for a root item only —
   `planBaseCommit`. Nothing is materialized or dispatched.

The persisted root base is exact and pinned. A focused test adds a root Plan
item, commits a later file, and confirms the stored `planBaseCommit` stays at
the original HEAD; a materializer test proves a root materialization still uses
that older commit after HEAD moves. `rootBaseCommit` accepts only a full
40/64-hex commit that git resolves to exactly that commit; `HEAD`, a branch,
an abbreviated hash, a fake hash and a blob id all fail closed. A dependent
item has no `planBaseCommit`; the queue document rejects one if present.

Example captured before the first real run:

```json
{
  "id": "foundation",
  "planPath": "/tmp/cliyard-pbc-evidence/repo-real2/plans/foundation.plan.json",
  "planHash": "73f16573b9b01960b1dcdc2def028afa93c2b22204bf5c55dac1d0c41a6a0266",
  "planId": "foundation",
  "planBaseCommit": "aab0f9a6863a304c9d717db661ab392b2fc98765",
  "dependsOn": [],
  "status": "pending",
  "attempts": 0
}
```

`materialization` is absent until the first dispatch. The add output from the
final pass (third run) had the same fields and likewise no `materialization`.

## 4. Materialization artifact and hash

Immediately before dispatch — after dependency readiness and before
`running`/the attempt increment/Supervisor start — the runner:

1. Verifies the Plan file still matches the frozen SHA-256.
2. Parses and compiles it with the existing `compilePlan`.
3. Requires the Plan id to equal the queue item's Plan id.
4. Selects the base (root pinned commit, or upstream completed manifest head)
   with exact git resolution.
5. Writes or byte-verifies the queue-owned artifact at:

```text
<repo>/.cliyard/queue/materialized/<queue-id>/<base>-<plan-hash>.contracts.json
```

The artifact is deterministic JSON (two-space indent plus one trailing
newline) with exactly `planId`, `contracts` and `provenance`. There is no
timestamp or other volatile field in the artifact. `materializedAt` is stored
only in the queue item's metadata.

Measured successful upper artifact (selected fields; the full artifact is on
disk in the scratch repo):

```json
{
  "planId": "upper",
  "contracts": [
    {
      "taskId": "upper-task",
      "version": 1,
      "frozen": true,
      "baseCommit": "7472e562b31ad265db877630c0a8c54bf328d4e3",
      "readPaths": [".", "AGENTS.md", "upper.txt"],
      "writePaths": ["upper.txt"],
      "sharedResources": [],
      "verifyCommands": [
        "test -f foundation.txt",
        "grep -qx foundation-ok foundation.txt",
        "test -f upper.txt",
        "grep -qx upper-ok upper.txt"
      ],
      "maxRepairs": 1
    }
  ],
  "provenance": {
    "queueId": "upper",
    "planPath": "/tmp/cliyard-pbc-evidence/repo-real2/plans/upper.plan.json",
    "planHash": "39788376c52a200d0aca3e51e5b4e2a09c89b54d400af2311d915de1090a310f",
    "planId": "upper",
    "baseCommit": "7472e562b31ad265db877630c0a8c54bf328d4e3",
    "upstreamQueueId": "foundation",
    "upstreamRunId": "e9064d14-729d-462d-b873-a22dd7929ff1",
    "upstreamIntegrationHead": "7472e562b31ad265db877630c0a8c54bf328d4e3"
  }
}
```

Measured identity for the first chain:

| Item | Artifact SHA-256 | Queue `contractsHash` | RunManifest `contractsHash` |
|------|------------------|-----------------------|------------------------------|
| `foundation` | `bb86ca3a65ef5e1d50feabffd94bc03bd05fcc55e63ee10aa7d5ab50a659406b` | same | same |
| `upper` | `b11ec152b1352cafd2fb289a881cffa71e41c1f3a6b9f3d85a09cd50d6b321b8` | same | same |

The artifact path and hash include the base and Plan hash, so a different Plan
or base is a different artifact. The embedded absolute `planPath` also means
the same Plan content in a different repository produces different bytes; the
artifact is deterministic for the same lineage, not globally content-addressed
by Plan alone.

The write path is create-only: a temp file plus hard link, never an overwrite.
If an artifact already exists with different bytes, materialization fails
closed and leaves it untouched. Queue document parsing revalidates the
materialization: the artifact path must be the deterministic path for
`<repo, id, base, planHash>`; root `baseCommit` must equal `planBaseCommit`;
a dependent base must equal `upstreamIntegrationHead`; upstream ids must match
the queue dependency; and a root materialization must not record upstream
lineage.

## 5. Upstream lineage and base selection

Measured with a separate local Supervisor + fixture-provider test and then with
the real provider:

- The dependent base is exactly the completed upstream RunManifest
  `integrationHead`. `materializePlan` requires the upstream item to be
  `completed`, with a recorded `lastRunId`; the manifest must be readable,
  `completed`, carry that exact run id, and match the upstream item's frozen
  contracts path/hash byte-for-byte.
- `integrationHead` and the manifest `baseCommit` must be exact full commits
  that git resolves unchanged, and the manifest base must be an ancestor of
  the integration head.
- The materializer ignores current repository `HEAD`, the active run pointer,
  similarly named branches and unaccepted worker commits. A focused test points
  the active pointer at an unrelated completed run and creates a branch named
  after the upstream item; the dependent still selects the upstream manifest
  head.
- A blocked, cancelled or missing upstream, a missing/non-completed manifest,
  changed contracts identity, a forged/renamed manifest run id, a symbolic or
  unresolvable integration head, or a non-ancestral manifest base all block
  before dispatch and before the attempt increment.

Measured real chain:

```text
foundation run e9064d14-729d-462d-b873-a22dd7929ff1
  baseCommit       aab0f9a6863a304c9d717db661ab392b2fc98765  (H0, pinned at add-plan)
  integrationHead  7472e562b31ad265db877630c0a8c54bf328d4e3
  status           completed

upper materialization (computed at 13:21:16.728Z, after foundation completed)
  baseCommit                  7472e562b31ad265db877630c0a8c54bf328d4e3
  upstreamQueueId             foundation
  upstreamRunId               e9064d14-729d-462d-b873-a22dd7929ff1
  upstreamIntegrationHead     7472e562b31ad265db877630c0a8c54bf328d4e3

upper run 7dd1f88c-6944-480e-94c3-9574d7a14e0e
  baseCommit       7472e562b31ad265db877630c0a8c54bf328d4e3
  integrationHead  215232315a8d4afb18a3ddec7f7d5866feb1e891
  status           completed
```

Foundation completed at `13:21:16.698Z`; the upper materialization was recorded
at `13:21:16.728Z` and its Supervisor run was created at `13:21:16.776Z`.
The dependent materialization therefore did not exist before its upstream was
completed. The queue's materialization was persisted before the upper
`running`/attempt write and before the Supervisor call.

## 6. Idempotency, retry and resume

- The same `(Plan hash, base)` pair produces the same path and bytes. A focused
  test calls materialization twice with a later `materializedAt`: the artifact
  bytes and inode are unchanged, and only the returned metadata timestamp
  differs. The recorded queue materialization is reused, not rewritten.
- A retry/rematerialization of an item with a changed Plan blocks with `Plan
  hash mismatch`; the recorded artifact is not rewritten. Restoring the exact
  Plan bytes allows the same run to resume.
- Once a run id exists, retry selects `resume`; the runner verifies the
  recorded materialization and then requires the RunManifest to still match
  the item's `planId`, exact contracts path, exact contracts hash and
  materialized base. It never compiles new contracts under a live or
  resumable run. If a resume is requested with no recorded materialization,
  the item is blocked instead of rematerializing.
- The focused retry test measured: first dispatch leaves an interrupted run
  (`attempts=1`, artifact inode unchanged); a changed Plan blocks at
  `attempts=1` with the same materialization; after restoring the Plan,
  `queue retry` updates the item without rewriting the run, and the next run
  resumes the **same run id**, receives the same materialization, completes
  (`attempts=2`), and leaves the artifact bytes and inode unchanged.
- A changed Plan or base is a new queue item and a new Supervisor run. The
  queue has no in-place Plan/contract update, no queue history and no artifact
  GC.

The real-provider chain did not exercise retry/resume; that behavior is
measured by the focused queue-core test through the real queue store,
materializer and Supervisor-manifest checks, with an injected Supervisor
result. It is not a real-provider retry measurement.

## 7. Fail-closed matrix

"Before dispatch" means no Supervisor `start/resume`, no `running` write for
this attempt, and no attempt increment. Some failures can still leave a
queue-created materialization or a Supervisor manifest; those are stated
explicitly.

| Stage | Condition | Outcome | Evidence |
|-------|-----------|---------|----------|
| add-plan | unsafe/duplicate id, unknown dependency, >1 dependency, cycle | mutation rejected; queue unchanged | CLI measurement; focused tests |
| add-plan | Plan missing, unreadable, malformed JSON, invalid schema, Plan id ≠ item id | mutation rejected; no artifact | CLI measurement; focused tests |
| add-plan | repository HEAD unresolvable | mutation rejected | source; focused materializer revision tests |
| materialization | Plan missing/changed hash/parse or compile failure | `blocked`, attempts unchanged, no artifact written for this attempt | CLI changed-Plan measurement: `dispatched=0`, `attempts=0`, no `runs/`, no materialized dir |
| materialization | root base not exact/resolvable | `blocked`, no artifact | focused materializer tests |
| materialization | upstream not completed / no run id / no contracts identity | `blocked`; dependent not dispatched | focused core tests (blocked, cancelled, missing) |
| materialization | upstream manifest missing, unreadable, non-completed, wrong run id, wrong contracts identity | `blocked`, no artifact | focused materializer tests |
| materialization | upstream `integrationHead` symbolic/unresolvable, or manifest base not an ancestor | `blocked`, no artifact | focused materializer tests |
| materialization | artifact exists with different bytes | `blocked`; existing artifact untouched | focused materializer/core tests |
| reuse | Plan hash, recorded artifact, base, upstream lineage or artifact provenance changed | `blocked`, no dispatch, attempts unchanged | focused core tests (changed Plan, changed/missing artifact) |
| resume | `nextAction=resume` or a run id exists, but no materialization is recorded | `blocked`; no compile substituted | source path; focused stale-running test `stale-bare` blocks with `plan materialization is not recorded` |
| resume | RunManifest unreadable, wrong run id/repo/planId/contracts/base | `blocked`, no dispatch | source verification; focused retry test covers the positive same-run path |
| stale running | recorded run completed | item `completed` | focused stale-running test |
| stale running | materialization/run evidence fails verification | item `blocked`, attempts unchanged | focused tampered/stale-bare tests |
| stale running | no recorded run id | item `blocked` (`running item has no recorded run id`) | existing queue behavior; focused tests |
| dispatch gate | attempt limit reached | item `blocked` | existing queue behavior |
| document load | Plan item with missing/extra lineage fields or non-deterministic artifact path | queue load/save rejected | source; focused legacy/layout tests |

## 8. Integration ancestry and downstream worktree

Local Supervisor test (fixture provider, not a real model) measured:

- Upper materialization base equals foundation RunManifest `integrationHead`.
- Upper RunManifest `baseCommit` equals that same head.
- `git merge-base --is-ancestor <foundationHead> <upperHead>` exits `0`.
- The downstream integration branch contains both `foundation.txt` and
  `upper.txt`; the fixture worker also failed its task if the upstream file was
  absent from its worktree.

The first real Claude Code + DeepSeek two-item chain (successful attempt)
additionally measured the **live** downstream worktree before the worker wrote
its output:

```text
capturedAt = 2026-10-27T13:21:16Z
worktree   = /tmp/cliyard-pbc-evidence/repo-real2/.cliyard/worktrees/mvqprxo5-upper-task
git HEAD   = 7472e562b31ad265db877630c0a8c54bf328d4e3  (foundation integrationHead)
files      = README.md, foundation.txt
foundation.txt = foundation-ok
upper.txt  = absent at capture
status     = clean
git log    = 7472e56 Merge branch 'cliyard/mvqprrf0-foundation-task' into cliyard/integration/e9064d14-…
             9633412 cliyard snapshot: foundation-task
             aab0f9a init
```

The downstream worktree therefore started with the upstream accepted file, not
just the empty repository base. Its declared verify commands also ran in that
worktree and required `foundation.txt` to contain `foundation-ok`; the run
completed. After acceptance:

```text
downstream branch files: README.md, foundation.txt, upper.txt
foundation.txt: foundation-ok
upper.txt:      upper-ok
git merge-base --is-ancestor 7472e56… 2152323…  → exit 0
git log 7472e56..2152323:
  2152323 Merge branch 'cliyard/mvqprxo5-upper-task' into cliyard/integration/7dd1f88c-…
  2f42a4a cliyard snapshot: upper-task
```

The downstream branch adds only the upper task commit and the integration
merge on top of the upstream head. This is a **linear one-dependency** chain;
it is not multi-parent integration or a merge queue.

## 9. Real Claude Code + DeepSeek smokes

Commands (scratch repo `repo-real2`; `H0` is the committed initial HEAD):

```bash
unset CLIYARD_CLAUDE_BINARY
export CLIYARD_CLAUDE_MAX_BUDGET_USD=1
export CLIYARD_CLAUDE_MAX_CONCURRENT=1

node dist/cli.js queue add-plan "$R/plans/foundation.plan.json" --repo "$R" \
  --id foundation --worker claude --model 'deepseek-flash[1m]' --json
node dist/cli.js queue add-plan "$R/plans/upper.plan.json" --repo "$R" \
  --id upper --depends-on foundation --worker claude \
  --model 'deepseek-flash[1m]' --json
node dist/cli.js queue run --repo "$R" --json
```

The upper Plan task asked for `upper.txt` containing exactly `upper-ok` and its
`verifyCommands` required `foundation.txt` with `foundation-ok` in the task
worktree. No `readPaths` named the upstream file; this run predates the
pinned-base read-context fix (see §9.1).

Result: exit `0`, wall time **17.2 s** (`13:21:08.622Z` → `13:21:25.861Z`),
`dispatched=2`, `stopped=idle`, counts `completed=2`, `blocked=0`.

| Item | Run | Base commit | Integration head | Artifact SHA-256 |
|------|-----|-------------|------------------|------------------|
| `foundation` | `e9064d14-729d-462d-b873-a22dd7929ff1` | `aab0f9a6863a304c9d717db661ab392b2fc98765` | `7472e562b31ad265db877630c0a8c54bf328d4e3` | `bb86ca3a65ef5e1d50feabffd94bc03bd05fcc55e63ee10aa7d5ab50a659406b` |
| `upper` | `7dd1f88c-6944-480e-94c3-9574d7a14e0e` | `7472e562b31ad265db877630c0a8c54bf328d4e3` | `215232315a8d4afb18a3ddec7f7d5866feb1e891` | `b11ec152b1352cafd2fb289a881cffa71e41c1f3a6b9f3d85a09cd50d6b321b8` |

Worker-event files exist for both runs. The upper run's 19 events included
`session.start`, `tool.start`/`tool.result` pairs, an `assistant` event and a
final `result` whose text began `Done. - Created upper.txt…`. The CLI did not
report actual provider cost; the `$1` cap is the only cost bound recorded here.

**Second confirmation run (same HEAD, 24.6 s).** A fresh scratch repository
`/tmp/cliyard-pbc-docs.xfARmU/repo` (H0
`726fa94e4ce93f8c62869ff9b02be7cf449f04ed`) ran the same two Plans with the
same `claude-ds` / `deepseek-flash[1m]` setup and `$1` cap: exit `0`,
`dispatched=2`, `completed=2`, wall time **24.554 s**
(`13:26:23.953Z` → `13:26:48.507Z`). Foundation run
`568d7e1d-2828-4984-b5bd-abe5cfd06b0f` completed at `13:26:39.455Z` with
`integrationHead` `8e2e8b99a744e86d311cdbc153207187dc6515ba`; upper
materialized at that exact head at `13:26:39.486Z` (the upper RunManifest was
created at `13:26:39.533Z`) and run
`78e0d1fb-fc88-456e-995d-f33bffa48a03` ended at
`464c8cc1c567afad074b311d2cc8c18b5052f06c`. Artifact SHA-256 values were
`31a6c4143dca92a8af6b91df42c1f4435f776f7c9c2c4990035a034e6e591e82`
(foundation) and
`6b3f849a1693653c462773afe07e478953137144f253203a17208782b14001a3` (upper).
The live upper worktree (`.cliyard/worktrees/mvqpyupj-upper-task`) was captured
at `13:26:39Z` with `HEAD=8e2e8b99…`, `foundation.txt=foundation-ok` and no
`upper.txt`; its 22 worker events ended in `result`. The final branch contained
`README.md`, `foundation.txt` and `upper.txt` (`upper-ok`), and
`git merge-base --is-ancestor 8e2e8b99… 464c8cc1…` exited `0`. A second
`queue run` dispatched `0` items and left the queue file SHA-256 at
`45e41d885859aafb898bc01b22f4b6bb0686af7be72bd4f97a8644ae49c984d3`;
retrying the completed foundation item exited `1`.

**Third confirmation run (final documentation pass, same HEAD, 21.4 s).** A new
scratch repository `/tmp/cliyard-pbc-verify.ECxtih/repo` (H0
`f110f528185315add54c61a15eecff9d7be45681`) re-ran the same two approved Plans
with the same `claude-ds` / `deepseek-flash[1m]` setup and `$1` cap. The
commands were the same `queue add-plan` / `queue run` invocations with
`R=/tmp/cliyard-pbc-verify.ECxtih/repo` and the two Plan files copied into
`$R/plans/`. `queue run` exited `0`, `dispatched=2`, counts `completed=2`, wall
time **21.4 s** (measured 21,435 ms; `13:31:32.707Z` → `13:31:54.144Z`); the
summary recorded `13:31:32.759Z` → `13:31:54.127Z`. Foundation run
`d2bce17f-5874-4549-aca6-ee9fdce15884` completed at `13:31:44.210Z` with
`integrationHead 51e50a0940adf88a5b05474309053b5d34edad7f`. The upper
materialization was recorded at `13:31:44.240Z` — after the upstream completion
and before the upper RunManifest was created at `13:31:44.288Z` — at base
`51e50a09…`. Upper run `43791d67-803f-4c0a-a0e7-6aed1b212133` completed at
`13:31:54.096Z` with `baseCommit` `51e50a09…` and
`integrationHead` `6bafdc0a97ff07627b3ae813490ff8740660d6e6`. Artifact
SHA-256 values were
`ebc24188ae2b0d565e777d75550580e9ed6d9f359993c5f776fea484b51cba61`
(foundation) and
`ceb58a719768d38504d852ecd078dbbdf0087708dc92060cc77822d55be9068e` (upper);
each equals the item's recorded `contractsHash` and its RunManifest
`contractsHash`.

The live upper worktree (`.cliyard/worktrees/mvqq5duy-upper-task`) was captured
at `13:31:44.510Z` with `HEAD=51e50a09…`, files `README.md` and
`foundation.txt` (`foundation-ok`), no `upper.txt`, and a clean status. Its 17
worker events ended in a `result` event. The final branch contained `README.md`,
`foundation.txt` (`foundation-ok`) and `upper.txt` (`upper-ok`);
`git merge-base --is-ancestor 51e50a09… 6bafdc0a…` exited `0`, and the range
added only the upper snapshot commit and the integration merge. A second
`queue run` dispatched `0` items and left the queue file SHA-256 at
`6c4613c57fe474e878f5808968d9bdaf31a0aa6dbc6f07e47d9c3efde9102d39`;
`queue retry foundation` exited `1` with `completed items never run again`.

### 9.1 Read-context follow-up (fixed after this measurement)

An earlier attempt on `repo-real` declared `readPaths: ["foundation.txt"]` on
the upper task and was blocked **before creating a worker worktree** with:

```text
worker-batch: readPath not found: foundation.txt
```

Preflight then checked the control checkout; the file existed only on the
foundation integration branch. The materialized base and upstream lineage were
exact.

That failure is fixed. Explicit read paths are now proved against the exact
shared contracts `baseCommit`; the untracked, optional-`AGENTS.md`,
task-produced and `.` rules are unchanged. A new real Claude Code + DeepSeek
two-item chain with the same explicit read path completed 2/2 in 13.953 s,
captured the live downstream worktree at the upstream `integrationHead` with
`foundation.txt` present and `upper.txt` absent, observed the worker reading
the file, and verified both final files with integration ancestry exit `0`.
Exact IDs, hashes, commands and limits:
[CHAINED_READ_CONTEXT.md](CHAINED_READ_CONTEXT.md).

The three chains above used no explicit upstream `readPaths` and do not
exercise this fix.

## 10. Completed monotonicity and rerun

After the first successful chain, a second `queue run` exited `0` with
`dispatched=0`, `stopped=idle`, and the queue file byte-identical:

```text
queue sha256 before = 0294aac3e3a5668d225989ec1fcafa6c161324321c60415cde5a9da4252a6115
queue sha256 after  = 0294aac3e3a5668d225989ec1fcafa6c161324321c60415cde5a9da4252a6115
```

`queue retry foundation` exited `1` with
`queue item "foundation" is completed; completed items never run again`.
Completed and cancelled items remain monotonic.

## 11. Acceptance status against the design

These are measurements, not a human acceptance decision.

| # | Design acceptance item | Measured status |
|---|------------------------|-----------------|
| 1 | add-plan rejects unsafe ids, unknown/cyclic dependencies, malformed Plans, Plan-id mismatches and >1 dependency | Measured: CLI rejection matrix + focused tests |
| 2 | root item materializes at the captured HEAD and completes through the existing Supervisor path | Measured: real foundation run + local Supervisor test |
| 3 | dependent materializes only after the upstream completes, at its RunManifest `integrationHead` | Measured: real timestamps/bases + focused tests |
| 4 | dependent worker worktree contains the upstream accepted file/commit | Measured: live real worktree captured with `foundation.txt`; downstream verify passed |
| 5 | downstream integration branch contains upstream + downstream work; upstream head is an ancestor | Measured: real branch contents and `merge-base --is-ancestor` exit 0 |
| 6 | blocked/cancelled/missing/interrupted/ambiguous upstream never yields a synthesized base or dispatch | Measured for blocked/cancelled/missing queue items and non-completed/ambiguous manifests in focused tests; no direct real interrupted-upstream run |
| 7 | changed approved Plan fails closed before Supervisor start | Measured: CLI `dispatched=0`, `attempts=0`, no run directory |
| 8 | recorded materialization stays byte-identical while retrying; changed Plan cannot be substituted | Measured in focused retry test (injected Supervisor result), bytes and inode unchanged |
| 9 | existing contract-backed behavior and prior tests remain green | Measured: legacy parsing test + full suite 236/236 |
| 10 | real chain through Claude Code + DeepSeek proves downstream worktree/ancestry | Measured: three successful two-item real runs (17.2 s, 24.6 s and 21.4 s), each with live downstream worktree and ancestry; the earlier readPaths dispatch failure is fixed and re-measured with explicit readPaths in [CHAINED_READ_CONTEXT.md](CHAINED_READ_CONTEXT.md) |

## 12. Measured and not measured

Measured on this date:

- build, three focused Plan-backed files and the full suite;
- add-plan snapshot, pinned root base and the rejection matrix;
- deterministic artifact path/bytes/provenance and recorded/file hash equality;
- byte-identical re-materialization and changed-Plan/artifact fail-closed;
- dependent base from the completed upstream manifest head, with exact
  run/contracts/head/ancestry checks;
- no synthesized base for blocked, cancelled, missing and non-completed
  upstream evidence (focused tests);
- retry selecting the same run and the same recorded materialization
  (injected Supervisor result);
- three real two-item Plan→Plan chains through Claude Code + DeepSeek (17.2 s,
  24.6 s and 21.4 s), including live downstream worktrees, final branch
  contents and integration ancestry;
- completed-item monotonicity and byte-identical no-op rerun.

Not measured / not claimed:

- multi-parent integration, merge queue, conflict resolution or speculative
  rebase (rejected/absent by design);
- parallel dispatch, a daemon, scheduler loop, periodic scan or 24h operation;
- cross-host queues, shared storage or cross-host lock recovery;
- SQLite or non-JSON state;
- automatic Plan generation or approval, automatic contract freeze, automatic
  push or automatic merge to `main`;
- provider-conversation continuation (attempt reuse is worktree continuity);
- a real-provider retry/failure drill (retry/resume was measured with the
  injected runner; the earlier readPaths dispatch failure was not a retry
  measurement and is fixed and re-measured separately in
  [CHAINED_READ_CONTEXT.md](CHAINED_READ_CONTEXT.md));
- upstream source-kind combinations other than Plan→Plan in a real run;
- a real interrupted-upstream materialization attempt;
- artifact GC, retention, history or queue compaction;
- long-run behavior, flake rate, actual provider cost or model quality.

## 13. Limitations and non-goals

- **One linear dependency.** A Plan item may have zero or one queue dependency;
  more than one is rejected at `add-plan`. Multi-parent integration and merge
  queues are not implemented.
- **Explicit approval, not generation.** The Plan is approved by a human before
  `add-plan`; the queue freezes its bytes but never creates, reviews, edits or
  approves a Plan. `compilePlan` is deterministic contract compilation, not
  autonomy.
- **Changing inputs means a new item/run.** A changed Plan, root base or
  materialized artifact blocks; a changed Plan/base cannot be substituted into
  an existing run. There is no in-place update or queue history/GC.
- **Artifacts accumulate.** `.cliyard/queue/materialized/` keeps one artifact
  per lineage; cleanup is manual. `materializedAt` is queue metadata only.
- **Plan id is the queue id.** v0 requires the declared Plan id to equal the
  queue item id.
- **Contract-backed items keep their own base.** The chained-base behavior
  applies only to Plan-backed items. Contract-backed queue items still do not
  chain integration branches.
- **Read context is pinned.** Explicit readPaths are validated against the
  shared contracts base; the earlier control-checkout behavior is fixed and
  measured separately in
  [CHAINED_READ_CONTEXT.md](CHAINED_READ_CONTEXT.md).
- **Foreground, sequential, same-host.** No daemon, parallel dispatch,
  cross-host coordination or SQLite. The RunManifest remains task authority;
  the queue never rewrites it.
- **No automatic push/main merge, no provider-session continuation.**

The next gap is the **decision on a supervised foreground long-run
controller/daemon after Plan-backed chain semantics are accepted**. It is not
implemented or claimed here; any background execution model needs its own
design and acceptance.

# Pinned-base Read Context v0 — Measured Evidence

> Date: 2026-10-27
>
> Environment: macOS 27.0.0, Node `v20.20.2`, cliyard HEAD
> `390d61eb656a7144d22a9d430ec6b8245c40eafe`, Claude Code `2.1.185`
> through `claude-ds`, model `deepseek-flash[1m]`.
>
> Scope: explicit `readPaths` validated against the shared contracts
> `baseCommit`, measured by focused tests and one real Claude Code + DeepSeek
> two-item Plan-backed queue chain in
> `/tmp/cliyard-crc-evidence.j5O3Hs/`. These are single local runs, not a CI,
> flake-rate, cost, quality or 24-hour/daemon claim.

This document measures the implementation described by
[design/chained-read-context-v0.md](../../design/chained-read-context-v0.md).
No source or test behavior was changed by this documentation task; the design
document's status was updated to point here. The scratch repository and logs
are outside the repository and are not committed.

The queue is still **not a daemon**, Plan approval/contract freeze stays
explicit, and the RunManifest remains the task-level authority.

## 1. Defect and fix

Before this change, `validateReadContexts` resolved explicit `readPaths`
against the control repository's working tree. A downstream Plan materialized
at the completed upstream `integrationHead` could therefore be rejected for a
file that existed at that base but not in the control checkout. The earlier
Plan-backed chain evidence measured that failure before a worker worktree
existed:

```text
worker-batch: readPath not found: foundation.txt
```

The current preflight is pinned to the exact commit the worker worktree is
created from. In `src/scheduler/codex-batch.ts`:

- `runCodexBatch` requires one shared base and calls
  `validateReadContexts(repoRoot, contracts, sharedBase)`
  (`src/scheduler/codex-batch.ts:497`, `:508`).
- `validateReadContexts` (`:1131`) keeps the existing exemptions:
  - `.` is accepted without an object lookup;
  - a path produced by any task's `writePaths` in the same contracts document
    is accepted;
  - a path visible only as an untracked control-checkout file still fails with
    the existing untracked-context error;
  - a genuinely missing optional `AGENTS.md` is still tolerated.
- Every other explicit read path is proven with
  `pathExistsAtCommit(repoRoot, baseCommit, readPath)` (`:1150`), which runs
  `git cat-file -e <commit>:<path>` (`:1177`).
- A path tracked in the control checkout but absent at the pinned base fails
  with `readPath "…" is absent from contracts base …`.
- Nothing is copied from the control checkout into a worktree.

The control checkout is not the worker base. In the measured chain below, the
control checkout stayed on `main` with no `foundation.txt`, while the exact
pinned base tree contained it.

## 2. Build and tests

Run from this cliyard checkout at HEAD `390d61e`:

| Command | Result | Test-runner duration |
|---------|--------|----------------------|
| `npm run build` | exit `0` | — |
| `npx tsx --test tests/context-preflight.test.ts` | 5/5 pass | 1174.5 ms |
| `npx tsx --test tests/plan-backed-queue-core.test.ts` | 10/10 pass | 2824.9 ms |
| `npx tsx --test tests/plan-backed-materializer.test.ts` | 16/16 pass | 1613.6 ms |
| `npx tsx --test tests/plan-backed-queue-cli.test.ts` | 5/5 pass | 718.2 ms |
| `npm test` (full suite) | 240/240 pass | 12730.5 ms |

The four focused files total 36/36 across four separate commands (the three
Plan-backed files are 31/31). The cited full suite was one local run at this
HEAD and includes these files; it reports 240 tests because
`tests/context-preflight.test.ts` grew from one test to five. A second
verification run after the documentation edits also passed 240/240
(12709.8 ms). The prior Plan-backed documentation measured 236/236 before
those four tests existed. These are not a repeated-run flake rate or a CI
claim.

The focused read-context tests measure:

1. A contracts set pinned to an older commit passes when the current checkout
   and `HEAD` have removed the file; the worker worktree is created at that
   pinned base and can read `design/upstream.md`
   (`tests/context-preflight.test.ts:89`).
2. A file added after the pinned base but present at current `HEAD` fails with
   `readPath "later.md" is absent from contracts base`
   (`tests/context-preflight.test.ts:128`).
3. A path visible only as an untracked control-checkout file still fails with
   the untracked-context error (`tests/context-preflight.test.ts:154`).
4. `.` and a missing optional `AGENTS.md` remain valid
   (`tests/context-preflight.test.ts:183`).
5. A path produced by an earlier task in the same contracts document remains
   valid, and the downstream worktree reads it
   (`tests/context-preflight.test.ts:205`).

The updated local Supervisor test declares the upstream artifact explicitly on
the downstream task (`readPaths: ["foundation.txt"]`,
`tests/plan-backed-queue-core.test.ts:1193`), runs the real queue and
Supervisor path with a fixture worker, and asserts that the materialized
downstream contract carries that read path (`:1323`), that the downstream
worktree sees the upstream accepted file, and that the upstream
`integrationHead` is an ancestor of the downstream head (`:1328`). It uses a
fixture provider, not a real model.

## 3. Real two-item chain setup

Scratch repository `/tmp/cliyard-crc-evidence.j5O3Hs/repo`:

```text
69da0bc init
a2b1e74 add approved foundation and upper Plans   (add-time HEAD / foundation planBaseCommit)
```

The approved Plans were committed before `queue add-plan`; their bytes were
frozen by the queue:

| Plan | SHA-256 |
|------|---------|
| `plans/foundation.plan.json` | `c9c772b0f9891cc10af5dd43881314f05fcd2de9bdba4e36e25b1a8ad6ff9e92` |
| `plans/upper.plan.json` | `65dfffdaf2c8af9fb9b15d62d9210891ebf8a9a3a8cd5cca3d90b29fdb8729c2` |

The foundation task writes `foundation.txt` and verifies
`grep -qx foundation-ok foundation.txt`. The upper task declares exactly
`readPaths: ["foundation.txt"]`, writes `upper.txt`, and verifies both
`foundation.txt` (`foundation-ok`) and `upper.txt` (`upper-ok`) in the task
worktree. Neither task commits, pushes or merges.

A provider probe before dispatch returned `PROBE_OK` with
`modelUsage.deepseek-flash[1m]` and a reported probe cost of `$0.00707`. The
chain commands were:

```bash
unset CLIYARD_CLAUDE_BINARY
export CLIYARD_CLAUDE_MAX_BUDGET_USD=1
export CLIYARD_CLAUDE_MAX_CONCURRENT=1

node dist/cli.js queue add-plan "$R/plans/foundation.plan.json" --repo "$R" \
  --id foundation --worker claude --model 'deepseek-flash[1m]' --json
node dist/cli.js queue add-plan "$R/plans/upper.plan.json" --repo "$R" \
  --id upper --depends-on foundation --worker claude \
  --model 'deepseek-flash[1m]' --json
node dist/cli.js queue list --repo "$R" --json
node dist/cli.js queue run --repo "$R" --json
```

The default Claude binary is `claude-ds`
(`src/agents/claude.ts:79-80`); `CLIYARD_CLAUDE_BINARY` was unset. The queue
recorded:

```text
foundation  planBaseCommit a2b1e7480152d0b20e4278f104d2079c9faf8ec7
upper       no root base; dependsOn ["foundation"]
```

`queue run` exited `0` with `dispatched=2`, `stopped=idle`, counts
`completed=2`, `blocked=0`, and a measured wall time of **13,953 ms**
(wrapper `13:48:07Z` → `13:48:21Z`; summary `13:48:07.661Z` →
`13:48:21.560Z`). Both runs were action `start`, attempts `1`.

## 4. Live downstream worktree before `upper.txt`

The watcher captured the downstream worktree as soon as it appeared, before
the upper worker wrote its output:

```text
capturedAt      2026-10-27T13:48:15Z (whole-second timestamp)
worktree        /tmp/cliyard-crc-evidence.j5O3Hs/repo/.cliyard/worktrees/mvqqqmlf-upper
git HEAD        e5a7af691c3d0b76a1489f9c3df973dbaf59409f
                (= foundation RunManifest integrationHead)
top-level files .git, README.md, foundation.txt, plans
git status      clean (empty porcelain)
foundation.txt  foundation-ok
upper.txt       ABSENT
git log         e5a7af6 Merge branch 'cliyard/mvqqqgo4-foundation' into
                         cliyard/integration/500fb7d2-…
                3428180 cliyard snapshot: foundation
                a2b1e74 add approved foundation and upper Plans
                69da0bc init
```

The queue state copied at that moment showed `upper` as `running`, attempt
`1`, with materialization base
`e5a7af691c3d0b76a1489f9c3df973dbaf59409f`, upstream run
`500fb7d2-9526-45b8-8a87-649911cfcf7f`, and artifact SHA-256
`8443dbc31d57e59ddc0692b85151c5da4936593c24dc8e7b40f67b0488677dbf`.

This is the key contrast with the pre-fix check:

```text
control checkout branch          main
control checkout HEAD            a2b1e748… (never received foundation.txt)
control foundation.txt           ABSENT
control tracked foundation.txt   0 entries
git cat-file -e e5a7af69…:foundation.txt
                                 YES (the pinned base tree contains it)
```

The upper worker events then show the file being read from that worktree
before `upper.txt` was written:

```text
13:48:15.495Z  session.start
13:48:17.176Z  tool.start  Read  …/worktrees/mvqqqmlf-upper/foundation.txt
13:48:17.188Z  tool.result Read  ok (18 chars)
13:48:18.352Z  tool.start  Write …/worktrees/mvqqqmlf-upper/upper.txt
13:48:18.361Z  tool.result Write ok (185 chars)
13:48:21.370Z  result      "Read foundation.txt — it contains foundation-ok.
                           Created upper.txt containing exactly upper-ok…"
```

The captured absence of `upper.txt` therefore precedes the recorded Write at
`13:48:18.352Z`; the Read event at `13:48:17.176Z` is also later than the
whole-second capture marker.

## 5. Materialized bases, final branch and ancestry

Materialization happened after the upstream completed and before the upper
run was created:

```text
13:48:15.299Z  foundation RunManifest updated (completed)
13:48:15.329Z  upper materialized at e5a7af69…
13:48:15.377Z  upper RunManifest created
13:48:15.495Z  upper worker session.start
```

| Item | Run | Base commit | Integration head | Artifact SHA-256 |
|------|-----|-------------|------------------|------------------|
| `foundation` | `500fb7d2-9526-45b8-8a87-649911cfcf7f` | `a2b1e7480152d0b20e4278f104d2079c9faf8ec7` | `e5a7af691c3d0b76a1489f9c3df973dbaf59409f` | `74174538d5b6fc00101e2a68f659bd4100f6eab8a0388f13c7c725304c28a1e8` |
| `upper` | `9654fe81-7999-4d28-a3e1-c2592492d765` | `e5a7af691c3d0b76a1489f9c3df973dbaf59409f` | `ed1432a2ed348b65fc6c5eabf2b474dd4bbbe2a8` | `8443dbc31d57e59ddc0692b85151c5da4936593c24dc8e7b40f67b0488677dbf` |

Each artifact SHA-256 equals the queue item's recorded `contractsHash` and its
RunManifest `contractsHash`. The upper materialized contract contains exactly:

```json
"readPaths": ["foundation.txt"]
```

and its provenance records `upstreamQueueId: "foundation"`,
`upstreamRunId: "500fb7d2-…"` and
`upstreamIntegrationHead: "e5a7af69…"`.

The final downstream integration branch contained:

```text
README.md
foundation.txt   foundation-ok
plans/
upper.txt        upper-ok
```

`git merge-base --is-ancestor e5a7af69… ed1432a2…` exited `0`. The range
`e5a7af69..ed1432a2` added only the upper snapshot commit
`ec45234 cliyard snapshot: upper` and the integration merge
`ed1432a Merge branch 'cliyard/mvqqqmlf-upper' into
cliyard/integration/9654fe81-…`. After acceptance the scratch repository had
only its main worktree; the task worktrees had been removed.

A second `queue run` dispatched `0` items with `stopped=idle` and left the
queue file byte-identical (SHA-256
`972b26f095fe3176d818bc92820494db89819ee0eb91165b92bceb530bc728df` before and
after).

## 6. Acceptance status against the design

These are measurements, not a human acceptance decision.

| # | Design acceptance item | Measured status |
|---|------------------------|-----------------|
| 1 | A contracts set pinned to an older commit passes after the current checkout no longer has the file | Measured: focused test 1; worktree at the pinned base reads the file |
| 2 | The worker worktree is created at that pinned base and can read the file | Measured: focused test 1; real downstream worktree HEAD equals the foundation head and contains `foundation.txt` |
| 3 | A path visible only as an untracked current-checkout file still fails | Measured: focused test 3, existing untracked-context error |
| 4 | A file added after the pinned base but present at current `HEAD` fails | Measured: focused test 2, `absent from contracts base` |
| 5 | `.` and missing optional `AGENTS.md` keep existing behavior | Measured: focused test 4 |
| 6 | Internal task-produced read paths continue to pass | Measured: focused test 5 |
| 7 | A Plan-backed two-item chain can declare the upstream file in downstream `readPaths` and complete through the real Supervisor and Claude Code + DeepSeek | Measured: one real chain, 2/2, 13.953 s, explicit `readPaths: ["foundation.txt"]`, live worktree and Read event |
| 8 | Existing contract-backed behavior and prior tests remain green | Measured: full suite 240/240, Plan-backed focused 31/31, `npm run build` exit `0` |

## 7. Measured and not measured

Measured on this date:

- build exit `0`, the four focused test files and the full 240-test run;
- the five read-context scenarios and the local Supervisor chain with an
  explicit downstream `readPath` (fixture worker);
- one real Claude Code + DeepSeek two-item Plan chain with
  `readPaths: ["foundation.txt"]`: 2/2, 13.953 s;
- the live downstream worktree at the upstream `integrationHead`, with
  `foundation.txt` present, `upper.txt` absent and a clean status;
- the worker's Read of that file before its Write of `upper.txt`;
- materialized bases, artifact/queue/manifest hash equality, final branch
  contents and integration ancestry (exit `0`);
- byte-identical no-op rerun and completed-item monotonicity.

Not measured / not claimed:

- a live negative chain (missing or later-added read path); that behavior is
  measured only by focused tests at this HEAD;
- a real-provider retry/resume or failure drill for this fix;
- multi-parent integration, merge queue, parallel dispatch, a daemon,
  periodic scanning or 24-hour operation;
- cross-host queues, shared storage, cross-host lock recovery or SQLite;
- automatic Plan generation, approval, contract freeze, push or `main` merge;
- provider-conversation continuation (attempt reuse is worktree continuity);
- actual provider cost for the chain. The CLI did not report it; only the
  `$1` per-worker budget cap is recorded. The probe's `$0.00707` is a separate
  probe cost, not the chain cost;
- long-run behavior, flake rate or model quality.

## 8. Limitations and non-goals

- **One shared base.** The preflight still requires all contracts in one
  document to share one base commit; it does not introduce per-task bases.
- **No copying.** A read path must exist at the pinned base or be produced by
  a task in the same contracts document. A control-checkout file is never
  copied into a worktree.
- **Untracked safety unchanged.** A path visible only as an untracked
  control-checkout file still fails; a tracked file absent at the pinned base
  also fails.
- **Explicit approval remains.** The queue consumes already-approved Plans;
  it does not generate, approve or freeze them.
- **Foreground and linear.** No daemon, parallel dispatch, multi-parent
  integration, cross-host queue or SQLite is added. The upstream
  `integrationHead` is the single downstream base; ancestry is linear.
- **No automatic push or `main` merge**, and no provider-session continuation.

No capability beyond the measured pinned-base read-context behavior is claimed.

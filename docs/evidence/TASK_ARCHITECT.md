# Task Architect v0 — Measured Evidence

> Date: 2026-10-27
>
> Environment: macOS (Darwin 27.0.0), Node `v20.20.2`, cliyard HEAD
> `3bc56e4`, Claude Code `2.1.185` through `claude-ds`.
>
> Scope: one short-lived, read-only Task Architect command on scratch Git
> repositories. Measurements cover a fake stream-json worker on the CLI paths,
> deterministic Plan validation and guards, and one real Claude Code +
> DeepSeek smoke. These are single local runs, not a CI result, a flake-rate
> claim, or a Plan-quality benchmark.

Task Architect only produces a human-reviewable Plan. It never freezes
contracts, writes contracts, creates worktrees or runs, dispatches a Supervisor,
merges code, or pushes. The human path after a successful run remains:

```text
review/edit Plan
  → existing plan compiler / contract freeze
  → explicit Supervisor start
```

## 1. Commands and test counts

Run from the cliyard checkout:

| Command | Result | Test-runner duration |
|---------|--------|----------------------|
| `npm run build` | exit `0` | — |
| `npx tsx --test tests/architect.test.ts` | 14/14 pass | 2193.3 ms |
| `npm test` (full suite) | 191/191 pass | 11236.8 ms |

Re-runs during the documentation repair on the same HEAD also passed: focused
architect 14/14 (2699.1 ms), full suite 191/191 (11090.9 ms), and
`npm run build`.

The architect file has 11 top-level tests; Node reports 14 tests because the
invalid-Plan test contains three subtests. The full suite includes the prior
177 tests, including the 81-test runtime/recovery group and the 13-test
attempt-continuity/progress/drill group. Those two groups were **not separately
re-run** this round; their tests passed as part of the 191-test run.

`npm run architect -- --help` exited `1` and printed the read-only usage,
including `--design`, `--plan-id`, `permission mode "plan"` and the line
`No contracts, worktrees, dispatch`.

The focused architect tests cover clean Plan production, fenced Plan JSON,
dirty preflight, touched paths, a worktree change during the run, a moved HEAD,
invalid JSON/schema/cycles, tracked/repo-relative design rules, CLI help, JSON
summary and human output. The worktree-change guard is covered only by these
tests, because a real-adapter fake worker that changes git state also produces
a reported touched path first. The CLI measurements below exercise the same
runner with an external fake worker, including the invalid-Plan and moved-HEAD
paths.

## 2. Measurement fixtures

Scratch target repository: `/tmp/cliyard-task-architect-target`, base commit
`f836c4b7220ac6d207415ad35a4ba1dd35da4265`. It contains:

```text
.gitignore                 (.cliyard/ and design/untracked.md ignored)
src/app.ts
design/slugify.md          998 bytes, committed
```

The design asks for two tasks: implement `slugify` plus tests, then document
it; the second task depends on the first. The worktree was clean before every
measured run.

The fake worker was an executable Node script outside the target repository at
`/tmp/cliyard-task-architect-evidence/fake-claude.js`. It appended its `cwd`
and `argv` to a log and emitted one stream-json result record:

```json
{"type":"result","is_error":false,"result":"<Plan JSON string>"}
```

`FAKE_MODE` selected the Plan, invalid JSON, empty schema, cycle, overlap,
touched-path, commit, or provider-error behavior. `FAKE_PLAN_ID` controlled the
`planId` inside the returned Plan. Temporary artifacts and logs stayed under
`/tmp/cliyard-task-architect-evidence/` and were not committed.

## 3. Read-only worker configuration and a validated Plan

Command for the valid fake-worker run:

```bash
export CLIYARD_CLAUDE_BINARY=/tmp/cliyard-task-architect-evidence/fake-claude.js
export FAKE_CLAUDE_LOG=/tmp/cliyard-task-architect-evidence/fake-claude.log
REPO=/tmp/cliyard-task-architect-target

FAKE_MODE=plan FAKE_PLAN_ID=architect-fake \
  npm run architect -- --repo "$REPO" --design design/slugify.md \
    --plan-id architect-fake --model fake-model --json
```

Exit code `0`. Observed JSON summary:

```json
{
  "ok": true,
  "planId": "architect-fake",
  "repoRoot": "/private/tmp/cliyard-task-architect-target",
  "baseCommit": "f836c4b7220ac6d207415ad35a4ba1dd35da4265",
  "designPath": "design/slugify.md",
  "designBytes": 998,
  "designTruncated": false,
  "planPath": "/private/tmp/cliyard-task-architect-target/.cliyard/plans/architect-fake.json",
  "taskIds": ["slugify-implementation", "slugify-docs"],
  "worker": "claude",
  "sessionId": "12004c8e-6f19-4ab6-9819-5449a2f86b5a",
  "touchedPaths": []
}
```

The fake worker's logged invocation proved the adapter configuration and cwd:

```text
cwd: /private/tmp/cliyard-task-architect-target
--output-format stream-json --verbose --model fake-model
--permission-mode plan --allowedTools Read,Grep,Glob
--max-budget-usd 20 --no-chrome
```

(`--max-budget-usd 20` came from the ambient fake-worker environment and is not
the architect default; the real smoke below overrides the cap to `$1`.)

The prompt also carried the committed design inside a `<<<DESIGN ... DESIGN>>>`
fence and the hard rules: only Read/Grep/Glob, no file writes, no commands,
no commit/push/merge/worktree/contract/dispatch, and exactly one Plan JSON
object.

The only artifact written was
`.cliyard/plans/architect-fake.json`:

```json
{
  "planId": "architect-fake",
  "tasks": [
    {
      "taskId": "slugify-implementation",
      "goal": "Implement slugify and its unit tests",
      "nonGoals": ["Do not change src/app.ts"],
      "dependsOn": [],
      "readPaths": ["src/app.ts"],
      "writePaths": ["src/slugify.ts", "tests/slugify.test.ts"],
      "verifyCommands": ["node --import tsx --test tests/slugify.test.ts"],
      "maxRepairs": 1
    },
    {
      "taskId": "slugify-docs",
      "goal": "Document slugify",
      "nonGoals": ["Do not edit src/slugify.ts"],
      "dependsOn": ["slugify-implementation"],
      "readPaths": ["src/slugify.ts"],
      "writePaths": ["docs/slugify.md"],
      "verifyCommands": ["node -e \"process.exit(0)\""],
      "maxRepairs": 1
    }
  ]
}
```

Human output was also measured with a second fake-worker run (same exports):

```bash
FAKE_MODE=plan FAKE_PLAN_ID=architect-human \
  npm run architect -- --repo "$REPO" --design design/slugify.md \
    --plan-id architect-human
```

Exit code `0`; output:

```text
Task Architect: Plan written
  plan:     architect-human
  artifact: /private/tmp/cliyard-task-architect-target/.cliyard/plans/architect-human.json
  repo:     /private/tmp/cliyard-task-architect-target
  base:     f836c4b7220ac6d207415ad35a4ba1dd35da4265
  design:   design/slugify.md (998 bytes)
  tasks:    slugify-implementation, slugify-docs
  worker:   claude session 059b393c-889f-4cf6-86f0-e7cf75c3b865
  touched:  (none)

Read-only control plane: no contracts, worktrees, dispatch, merge or push.
```

### Read-only evidence after the valid run

Captured before and after the first valid run:

```text
beforeHead=f836c4b7220ac6d207415ad35a4ba1dd35da4265
afterHead=f836c4b7220ac6d207415ad35a4ba1dd35da4265
refsEqual=yes
designShaEqual=yes
statusBefore=0 lines
statusAfter=0 lines
worktrees: only /private/tmp/cliyard-task-architect-target on refs/heads/main
artifacts: .cliyard/plans/architect-fake.json
forbiddenDirs: contracts=absent runs=absent worktrees=absent runtime=absent
```

After the human and real runs, the final target state was:

```text
.cliyard/plans/architect-fake.json
.cliyard/plans/architect-human.json
.cliyard/plans/architect-real.json

contracts=absent
runs=absent
worktrees=absent
runtime=absent
worker-events=absent
ledger.json=absent

HEAD=f836c4b7220ac6d207415ad35a4ba1dd35da4265
refs/heads/main=f836c4b7220ac6d207415ad35a4ba1dd35da4265
git status --porcelain: exit 0, no lines
worktree list: only the main worktree on refs/heads/main
design SHA-256=7b0719fccd9839e07b9af0a374d204b68ec1ea353435ca2f6e4f8617f150e393
```

No contract file, Supervisor manifest, integration branch, task worktree,
runtime, ledger, or worker-event log was created. No merge or push occurred.

## 4. Guards and validation failures

The shared command shape was:

```bash
CLIYARD_CLAUDE_BINARY=/tmp/cliyard-task-architect-evidence/fake-claude.js \
FAKE_MODE=<mode> FAKE_PLAN_ID=<id> FAKE_CLAUDE_LOG=/tmp/cliyard-task-architect-evidence/fake-claude.log \
  npm run architect -- --repo /tmp/cliyard-task-architect-target \
    --design design/slugify.md --plan-id <id> --json
```

Each failure exited `1` and wrote no Plan artifact.

| Case | Trigger | Stage | Observed error |
|------|---------|-------|----------------|
| Dirty target | `dirty.txt` untracked before the run | `preflight` | `target worktree is not clean:\n?? dirty.txt` |
| Touched path | fake worker wrote `rogue.txt` | `validation` | `worker touched paths (must be empty): rogue.txt` |
| Moved HEAD | fake worker made an empty commit | `validation` | `HEAD moved during the architect run: f836c4b… -> e12bb48…` |
| Invalid JSON | final text was `I could not produce a Plan.` | `validation` | `invalid Plan JSON: Unexpected token 'I', "I could no"... is not valid JSON` |
| Empty schema | `{"planId": …, "tasks": []}` | `validation` | `invalid Plan: tasks: must be a non-empty array of module plans` |
| Dependency cycle | `a → b → a` | `validation` | `invalid Plan: tasks.dependsOn: dependency cycle: a → b → a` |
| Overlapping writes | both tasks wrote `src/shared.ts` | `validation` | `invalid Plan: tasks[1].writePaths: "b" overlaps "a" at src/shared.ts; current isolated worktrees do not compose overlapping edits` |
| Untracked design | ignored `design/untracked.md` | `preflight` | `design document is not tracked by git: design/untracked.md` |
| Design escape | `--design ../outside.md` | `preflight` | `design path must be repository-relative and stay inside the target repository (received "../outside.md")` |
| Invalid plan id | `--plan-id '../bad id'` | `preflight` | `invalid --plan-id "../bad id": must start with a letter or digit and contain only letters, digits, '.', '_' or '-' (max 64)` |
| Non-git target | empty `/tmp/cliyard-task-architect-not-a-repo` | `preflight` | `target is not a git repository: … (fatal: not a git repository …)` |
| planId mismatch | worker returned `someone-else` for `--plan-id architect-mismatch` | `validation` | `worker returned planId "someone-else" but --plan-id is "architect-mismatch"` |
| Worker error | fake provider exited `3` with no result | `worker` | `worker exited with code 1: fake provider failure` |
| Design overwrite | absolute `--out "$REPO/design/slugify.md"` | `artifact` | `refusing to overwrite the design document: design/slugify.md` |

For the dirty, invalid-plan-id, and non-git cases the fake-worker log had **0
invocations**, so those preflight failures happened before any worker started.

Guards covered by the focused test file rather than these CLI fixtures:

- a worktree change appearing during the run is rejected before parsing
  (`architect: a worktree change during the run is rejected`);
- a worker-reported touch and a moved HEAD are also unit-tested independently
  of the real adapter;
- invalid JSON/schema/cycle cases are subtests of
  `architect: invalid JSON, schema, and cycles are rejected`.

### `--out` resolution caveat

An explicit **relative** `--out design/slugify.md` was resolved against the
control process's current directory, not the target repository. In this
measurement it wrote the Plan under the cliyard checkout instead of the target.
That file was removed immediately; it was not a tracked file and no source or
test file was changed. The design-overwrite guard fired only when the
**absolute** target design path was supplied. Use an absolute `--out` when
choosing a non-default location.

## 5. Real Claude Code + DeepSeek smoke

Command, with the ambient fake-worker variables removed and a $1 budget cap:

```bash
REPO=/tmp/cliyard-task-architect-target
env -u CLIYARD_CLAUDE_BINARY -u FAKE_MODE -u FAKE_CLAUDE_LOG -u FAKE_PLAN_ID \
  CLIYARD_CLAUDE_MAX_BUDGET_USD=1 \
  npm run architect -- --repo "$REPO" --design design/slugify.md \
    --plan-id architect-real --model 'deepseek-flash[1m]' --json
```

Result: exit `0`, wall time **16 seconds**, one run. The worker was the real
`claude-ds` launcher (Claude Code `2.1.185`) with the DeepSeek
Anthropic-compatible endpoint and model `deepseek-flash[1m]`. The architect
summary does not report actual provider cost, so no dollar amount is claimed;
the $1 cap is the only cost bound recorded here.

Observed summary:

```json
{
  "ok": true,
  "planId": "architect-real",
  "repoRoot": "/private/tmp/cliyard-task-architect-target",
  "baseCommit": "f836c4b7220ac6d207415ad35a4ba1dd35da4265",
  "designPath": "design/slugify.md",
  "designBytes": 998,
  "designTruncated": false,
  "planPath": "/private/tmp/cliyard-task-architect-target/.cliyard/plans/architect-real.json",
  "taskIds": ["slugify-implementation", "slugify-docs"],
  "worker": "claude",
  "sessionId": "1d6e4a2a-7fdc-4b0a-9c51-a7cd9fb3ff1c",
  "touchedPaths": []
}
```

The model-produced Plan passed deterministic compilation. Its content is
reproduced below from the artifact (JSON formatting normalized for
readability):

```json
{
  "planId": "architect-real",
  "tasks": [
    {
      "taskId": "slugify-implementation",
      "goal": "Create src/slugify.ts exporting slugify(input: string): string that lowercases the input, replaces each run of non-alphanumeric ASCII characters with a single hyphen, and trims leading/trailing hyphens; create tests/slugify.test.ts using node:test with at least three cases covering \"Hello World\" -> \"hello-world\", punctuation runs, and leading/trailing separators.",
      "nonGoals": [
        "Do not edit src/app.ts",
        "Do not modify design/slugify.md",
        "Do not add external dependencies",
        "Do not create docs/slugify.md"
      ],
      "dependsOn": [],
      "readPaths": ["design/slugify.md", "src/app.ts"],
      "writePaths": ["src/slugify.ts", "tests/slugify.test.ts"],
      "verifyCommands": ["node --import tsx --test tests/slugify.test.ts"],
      "maxRepairs": 1
    },
    {
      "taskId": "slugify-docs",
      "goal": "Create docs/slugify.md documenting the slugify function contract and examples, matching the behavior implemented in src/slugify.ts.",
      "nonGoals": [
        "Do not edit src/slugify.ts",
        "Do not edit tests/slugify.test.ts",
        "Do not modify src/app.ts",
        "Do not modify design/slugify.md"
      ],
      "dependsOn": ["slugify-implementation"],
      "readPaths": ["design/slugify.md", "src/slugify.ts"],
      "writePaths": ["docs/slugify.md"],
      "verifyCommands": ["test -s docs/slugify.md"],
      "maxRepairs": 1
    }
  ]
}
```

Before and after the real run: HEAD stayed
`f836c4b7220ac6d207415ad35a4ba1dd35da4265`, `git status --porcelain` stayed
empty, `touchedPaths` was empty, the design hash was unchanged, and the only
new file was the Plan artifact under `.cliyard/plans/`.

This is a short single-provider smoke. It establishes that the real Claude
Code stream result is parsed, the read-only configuration completes, and this
design yields a valid two-task Plan. It does **not** establish Plan quality,
long-duration behavior, provider-failure coverage, or a cost/flake rate.

## 6. What was and was not exercised

Measured on this date:

- the CLI help path and JSON/human success output;
- the read-only Claude adapter flags (`plan` permission mode; Read/Grep/Glob);
- dirty, touched-path, moved-HEAD, design-tracking, design-escape, invalid-id,
  non-git, planId-mismatch, worker-error and artifact-collision guards;
- deterministic rejection of invalid JSON, empty schema, dependency cycles and
  overlapping write paths;
- a real Claude Code + DeepSeek Plan generation;
- no contracts, worktrees, runs, integration branches, ledgers, runtime
  records, merges or pushes.

Not measured / not claimed:

- a direct shell attempt by the worker (the allowed-tool set excludes Bash);
- transient writes that are reverted before the post-run checks;
- real-provider failure, timeout or retry behavior;
- Plan quality against human-authored Plans;
- execution of the generated Plan;
- anything after the human gate (contract freeze, dispatch, Supervisor run).

## 7. Remaining limitations

- **Enforcement is permission configuration plus post-run git checks.** The
  Claude worker is started with `permission-mode=plan` and only Read, Grep and
  Glob, but the control plane's independent checks are `touchedPaths`, a
  byte-identical worktree status, and an unchanged HEAD. A worker that writes
  and fully reverts a file before exiting could evade the state comparison;
  there is no filesystem-level or reflog audit.
- **Only the Claude worker exists.** `--worker` accepts only `claude` in v0.
  There is no Codex or CodeBuddy architect adapter.
- **The artifact is a Plan candidate, not a contract.** It has no frozen
  contracts, no contract base commit, no scheduler state and no execution
  authority. A human must review/edit it, run the existing compiler/freeze
  path, and explicitly start a Supervisor.
- **No automatic contract freeze or dispatch.** This is intentional, not a
  missing button. By default the command writes only
  `.cliyard/plans/<planId>.json`; an explicit `--out` selects another path.
- **Relative `--out` is caller-CWD-relative.** Prefer an absolute path; the
  design-overwrite guard compares the resolved path against the design path.
- **Design input is capped at 64 KiB.** Larger documents are truncated and the
  summary reports `designTruncated: true`; there is no chunking or retrieval.
- **No quality benchmark or failure matrix.** One real provider smoke and the
  focused fixtures do not establish plan correctness or robustness across
  providers/designs.
- **No plan retention/GC.** Repeated runs accumulate plan artifacts.
- **No dispatch, daemon, cross-host, SQLite, browser evidence or admission
  scheduling.** The next independent gap is **durable continuous
  orchestration**, not a Task Architect extension. The existing non-goals
  remain: no background daemon, no cross-host recovery, no SQLite, no
  Playwright/axe/screenshot evidence, no CPU/memory/browser admission
  scheduling, no automatic push or `main` merge.
- **Test evidence is local and single-run.** 14/14 architect tests and 191/191
  full-suite tests passed once on macOS; this is not a CI or long-term flake
  claim.

# Task Architect v0

> Revision: task-architect-v0
>
> Scope: short-lived, read-only Plan producer under human review

## Why

The Supervisor can execute frozen contracts durably, but a human or Master still
has to translate detailed design into a dependency-aware Plan. Keeping that
translation in the long-lived Master context creates exactly the context and
calibration burden this project is trying to remove.

Task Architect is therefore a short-lived, read-only role:

```text
committed design document + clean target repository
  → read-only architectural analysis
  → one Plan JSON candidate
  → deterministic validation
  → persisted plan artifact
  → human/Master review
  → existing plan compiler or Supervisor dispatch
```

It is not a second long-lived agent and it does not grant execution authority.

## CLI

```bash
cliyard architect \
  --repo <target-repo> \
  --design <repo-relative-design.md> \
  --plan-id <safe-plan-id> \
  [--worker claude] \
  [--model <id>] \
  [--out <plan.json>] \
  [--json]
```

Defaults:

- worker: `claude`;
- model: Claude adapter default (`deepseek-flash[1m]` through `claude-ds`);
- output: `<target>/.cliyard/plans/<planId>.json`.

The command is foreground and finite. It does not run the Plan.

## Read-only guarantee

Before invoking the worker, the control plane requires:

1. the target is a git repository;
2. `git status --porcelain` is empty;
3. the design path exists, is tracked by git, and is inside the repository;
4. `HEAD` resolves to one exact base commit.

The Claude adapter is configured with:

```text
permission-mode = plan
allowed tools = Read, Grep, Glob
```

After the worker exits, the control plane requires:

- worker exit code `0`;
- `touchedPaths` is empty;
- `git status --porcelain` is still empty;
- the final worker text contains a parseable Plan JSON.

If any check fails, no Plan artifact is written.

## Plan validation

The candidate passes the existing deterministic `compilePlan` path with the
resolved base commit. This validates:

- plan and task ids;
- non-empty goals and acceptance commands;
- repository-relative read/write paths;
- dependency existence and acyclicity;
- no overlapping write paths;
- unsupported shared resources;
- TaskContract/runtime shape.

Task Architect does not invent a second schema.

## Human gate

Task Architect writes only the reviewed Plan candidate:

```text
<target>/.cliyard/plans/<planId>.json
```

It does **not** write contracts, start a Supervisor run, dispatch a worker,
create a worktree, merge code, or push.

The next explicit actions remain:

```text
review/edit Plan
  → plan compiler / freeze contracts
  → Supervisor start
```

## Output contract

The worker is instructed to return only:

```json
{
  "planId": "safe-plan-id",
  "tasks": [
    {
      "taskId": "safe-task-id",
      "goal": "one concrete deliverable",
      "nonGoals": ["scope boundary"],
      "dependsOn": [],
      "readPaths": ["path/to/context"],
      "writePaths": ["path/to/output"],
      "verifyCommands": ["finite command"],
      "maxRepairs": 1
    }
  ]
}
```

The CLI result reports the validated plan path, base commit, task ids, worker
session, and touched paths (which must be empty).

## Non-goals

- No automatic design-document editing.
- No automatic contract freeze.
- No automatic dispatch.
- No long-lived architect process or daemon.
- No design authority over the human.
- No unbounded extra tool access.
- No SQLite, cloud queue or browser evidence.
- No Task Architect quality benchmark in v0.

## Acceptance

```text
architect-read-only-runner
  → architect-docs
```

1. A clean repo and committed design produce a validated Plan artifact.
2. A dirty repo is rejected before the worker starts.
3. A worker that touches any path is rejected and writes no Plan.
4. Invalid JSON, invalid schema, cycles, or overlapping writes are rejected.
5. The command never creates contracts, worktrees, runs or integration branches.
6. The CLI has a JSON summary and human-readable help/output.
7. Existing plan compilation, Supervisor, progress and attempt continuity tests
   remain green.
8. Documentation records measured real-worker behavior and limitations.


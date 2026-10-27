# Chained Read Context v0

> Revision: chained-read-context-v0
>
> Scope: validate worker read context against the pinned contracts base

## Current gap

Plan-backed queue chains correctly materialize downstream contracts at the
completed upstream `integrationHead`. A downstream Plan can therefore see an
upstream-produced file in its worker worktree.

However, `validateReadContexts` currently checks explicit `readPaths` against
the control repository's current working tree:

```text
upstream adds foundation.txt and is accepted
downstream contracts base = upstream integrationHead
downstream readPaths includes foundation.txt
preflight checks control checkout at an older HEAD
preflight fails: readPath not found
```

This is a false negative. The worker worktree would be created at the
downstream contracts base and would contain the file; the control checkout is
not the worker base.

## Goal

Resolve and validate read context against the exact, already-resolved shared
contracts `baseCommit`:

```text
resolved contracts base B
  -> git object B:readPath exists
  -> worker worktree at B contains readPath
  -> preflight passes
```

The control repository's current `HEAD`, working tree and index do not decide
whether a tracked path exists in a task worktree.

## Rules

- `.` remains valid without an object lookup.
- The default optional `AGENTS.md` remains tolerated when it does not exist at
  the contracts base, preserving existing contracts.
- A path produced by any task in the same contracts document may be referenced
  before it exists at the base; internal dependency waves create it.
- Every other explicit `readPath` must exist in the tree of the exact resolved
  shared base commit.
- A current-checkout file that is untracked or absent from the contracts base
  is not accepted silently. The existing untracked-context error remains for
  a path visible only in the control working tree.
- A file tracked in the current checkout but absent at the pinned base is also
  rejected; it will be absent from the worker worktree.
- URL, shell, verifier, write-path and Git-diff gates are unchanged.

## Acceptance

1. A contracts set pinned to an older commit whose tree contains
   `design/upstream.md` passes even when the current checkout no longer has
   that file.
2. The worker worktree is created at that pinned base and can read the file.
3. A path visible only as an untracked current-checkout file still fails with
   the existing untracked-context error.
4. A file added after the pinned base but present at current `HEAD` fails as
   absent from the worker base.
5. `.` and missing optional `AGENTS.md` keep their existing behavior.
6. Internal task-produced read paths continue to pass within one contracts
   run.
7. A Plan-backed two-item chain can declare the upstream-produced file in the
   downstream task's explicit `readPaths` and complete through the real
   Supervisor and Claude Code + DeepSeek path.
8. Existing contract-backed behavior and all prior tests remain green.

## Non-goals

- No automatic path creation or copying from the control checkout.
- No relaxation of untracked/missing read-context safety.
- No worker access outside the worktree.
- No change to contract compilation, Plan approval, queue lineage or
  RunManifest authority.
- No multi-parent integration, daemon, parallel dispatch, cross-host queue or
  SQLite.

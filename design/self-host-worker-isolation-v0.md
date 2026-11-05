# Self-host worker isolation v0

> Status: Plan only, not frozen and not dispatched.

## Problem

Observed on run `4809f45a-59ba-4058-9a4f-08b2533606b8`: the
`execution-interface` attempt wrote `src/execution/*.ts`,
`tests/execution-interface.test.ts` and `dist/execution/*` into the main
checkout instead of its task worktree, and the WorkspaceBoundary guard then
reported a protected-root violation. The dispatch code already passes an
absolute worktree cwd, so the defect is an execution-isolation gap that must be
made fail-fast rather than silently corrupting the authority checkout.

## Required invariants

1. The worker spawn cwd and the verifier cwd must be the absolute task
   worktree path, never the repository root. Abort before spawn when the cwd
   is missing, relative, or resolves to the repository root.
2. The WorkspaceBoundary authority snapshot for a task targets the task
   worktree, not the repository root.
3. Build output under `dist/` is excluded from the boundary comparison.

## Non-goals

- No weakening of exact-identity process safety or write-path auditing.
- No change to TaskContract or EvidenceBundle semantics.
- No launchd, Windows or sandbox backends.

## Acceptance

- A worker cwd that resolves to the repository root aborts with a cwd-guard
  error before any write.
- The boundary captures and compares the task worktree.
- A newly added `dist/` file no longer triggers a violation.

# Background VerificationTask v0 — evidence

> Measured 2026-11-07 (Asia/Shanghai) on Linux, Node present.
>
> Branch: `cursor/verification-task-v0-0da8`.
> Plan: `design/verification-task-v0.plan.json`.
> Accepted integration base before this slice: `1a930e4` (P3c merge / PR #13).

## 1. What landed

- Durable `VerificationTask` model (`task-types`) with `lost` status,
  `output.{uri,offset}`, idempotent `deliveredAt`, and optional
  `ownerIdentity` (`RuntimeProcessIdentity`).
- Atomic JSON store under `.cliyard/verification/<id>.json`.
- Detached worker process group runner bound to a caller-supplied worktree
  already at `artifactCommit` (runner does not invent a checkout).
- Startup recovery: `running`/`stopping` without a live matching identity →
  `lost` (never `succeeded` by inference).
- Focused fixtures for offset, delivery latch, parent-exit survival, orphan
  recovery, and failed command status.

## 2. Commands

```bash
npm run build   # exit 0
npx tsx --test tests/verification-task.test.ts
# → tests 4 / pass 4 / fail 0
```

## 3. Non-claims

- `createShellVerifier` / `runClosedLoop` verify path is **not** replaced yet
  (batch wire is a follow-up).
- No Reviewer, Harness Eval scenarios, RuntimeManager services, or OS sandbox
  claims in this slice.
- VerificationTask status alone never grants acceptance.

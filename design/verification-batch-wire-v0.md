# VerificationTask batch wire v0

> After VerificationTask v0 land (`0fadc1a` / PR #14). Residual from
> `docs/CURRENT_STATE.md` item 6: replace synchronous shell verify inside the
> closed loop / batch — **opt-in** first.

## Problem

`VerificationTask` can run detached with durable offset/recovery, but
`runClosedLoop` and `codex-batch` still call `createShellVerifier` only. There
is no Verifier adapter over VerificationTask, no batch opt-in, no recovery at
batch start, and no observational verify identity on `LoopResult` /
RunManifest.

## Fix (v0)

1. **`createBackgroundVerifier`** — implements `Verifier`; on `run`:
   path-overshoot fail-closed; refuse contracts with `runtime` (RuntimeManager
   verify services stay on shell path); start VerificationTask at the caller
   worktree (HEAD must equal `artifactCommit`); await terminal; mark
   `deliveredAt` once; map to `VerifyResult` and attach a bounded
   `verification` observation.
2. **Opt-in batch/loop wire** — `CodexBatchOptions.backgroundVerification`
   (or `CLIYARD_BACKGROUND_VERIFY=1`); when set (and not dry-run), use
   background verifier instead of shell; call `recoverVerificationTasks` once
   at batch start. Default remains shell verifier.
3. **Thread observation** — `VerifyResult.verification?` →
   `LoopResult.verification?` → RunManifest `task.verification` on
   accept/reject checkpoints.
4. **Tests + evidence** — fixture background verify success/fail; recovery
   invoked; dry-run stays on mock; CURRENT_STATE/ROADMAP update.

## Non-goals

- Do not default-on for every production batch.
- Do not move RuntimeManager-backed verify into VerificationTask.
- Do not implement Reviewer or cascade-stop of sibling tasks.
- Do not grant acceptance from VerificationTask status alone (loop verdict
  rules unchanged).

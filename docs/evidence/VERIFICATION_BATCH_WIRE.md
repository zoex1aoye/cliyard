# VerificationTask opt-in batch wire v0 — evidence

> Measured 2026-11-07 (Asia/Shanghai).
>
> Branch: `cursor/verification-batch-wire-0da8`.
> Plan: `design/verification-batch-wire-v0.plan.json`.
> Accepted integration base: `0fadc1a` (VT v0 / PR #14).

## 1. What landed

- `createBackgroundVerifier` — Verifier over detached VerificationTask;
  refuses `contract.runtime`; attaches `VerifyResult.verification`.
- Opt-in: `CodexBatchOptions.backgroundVerification` or
  `CLIYARD_BACKGROUND_VERIFY=1` (dry-run stays mock; default remains shell).
- `recoverVerificationTasks` at batch start when enabled.
- `LoopResult.verification` → RunManifest `task.verification` on
  accept/reject.

## 2. Commands

```bash
npm run build   # exit 0
npx tsx --test tests/verification-batch-wire.test.ts tests/verification-task.test.ts
# → tests 9 / pass 9 / fail 0
```

## 3. Non-claims

- Background verify is still **opt-in**, not default-on.
- No RuntimeManager services inside VerificationTask.
- No Reviewer / stop-cascade; VT status alone never grants acceptance.

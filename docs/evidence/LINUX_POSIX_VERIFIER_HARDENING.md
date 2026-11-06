# Linux POSIX verifier and process-tree hardening — evidence

> Measured 2026-11-06 22:44 Asia/Shanghai on Linux 6.12.113+ x86_64,
> Node `v22.23.4`, cloud agent host.
>
> Branch: `cursor/linux-posix-verifier-hardening-0da8`.
> Plan: `design/linux-posix-verifier-hardening-v0.plan.json`.
> Contracts SHA-256:
> `71c5fcb3d50093158568055de63135d57a78c8592d290347bf90fc62fff93eff`.
>
> This document records Linux observations only. It does not accept, merge or
> authorize pilot use, and it does not claim OS sandboxing.

## 1. Why this measurement existed

Pilot-safety closeout already shipped contract `verifyTimeoutMs` and batched
process-table cleanup on a macOS evidence lane. On this Linux host the focused
suite previously failed:

| Test | Pre-fix observation |
|---|---|
| `createShellVerifier: contract timeout overrides the option per command` | Wall clock ~5005 ms; `sleep 5` grandchild survived shell `SIGTERM` |
| `bounds residual evidence while reporting the true count` | `residualCount` under-reported while helpers were still spawning |
| `cleans more than 16 external groups with a 512-member group…` | `listGroupMembers` saw fewer than 513 members before nested sleeps finished |

Isolated probe before the fix:

```text
spawn("sleep 5", { shell: true }); child.kill("SIGTERM") after 150ms
→ close after ~5005ms (grandchild survived)

spawn("sleep 5", { shell: true, detached: true }); process.kill(-pid, "SIGTERM") after 150ms
→ close after ~155ms (process group stopped)
```

## 2. Code changes under test

- `src/verification/verifier.ts`: POSIX verifyCommands spawn `detached` and
  timeout signals `-pid` with SIGTERM, then SIGKILL after 200 ms. Windows keeps
  direct pid kill. Legacy default remains 30 s when `verifyTimeoutMs` is absent.
- `tests/worker-process-tree.test.ts`: residual and 512-member nested-group
  tests wait until expected membership is observable before asserting.

## 3. Focused commands and results

```bash
npx tsx --test --test-timeout=180000 --test-concurrency=1 \
  --test-name-pattern='contract timeout overrides|option timeout is the fallback|bounds residual evidence|cleans more than 16 external groups with a 512-member' \
  tests/verifier-shell.test.ts tests/worker-process-tree.test.ts
npm run build
```

| Result | Value |
|---|---|
| Focused tests | **4/4 pass** in **1.84 s** wall |
| Contract timeout override | **153 ms** (was ~5005 ms) |
| Residual bounds | pass |
| 20 groups / 512-member nested | pass in **610 ms** after membership wait |
| `npm run build` | pass |

## 4. Explicit non-claims

- No systemd-run / launchd / daemon packaging was exercised.
- No Windows Job Object parity.
- No change to CostTruth authority or acceptance rules.
- Supervised pilot readiness is unchanged: this is a Linux correctness lane for
  already-designed pilot-safety pieces, not a pilot-ready declaration.

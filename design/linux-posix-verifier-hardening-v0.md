# Linux POSIX verifier and process-tree hardening v0

> Status: Plan approved for freeze (human directed 2026-11-06).
>
> Environment: Linux 6.12.x x86_64 cloud agent host.

## Problem

Pilot-safety closeout already landed process-table batch cleanup and contract
`verifyTimeoutMs` on the mainline lineage, but Linux measurement exposes two
gaps that macOS evidence did not catch:

1. **Verifier shell timeout does not stop shell children on Linux.**
   `createShellVerifier` spawns `verifyCommands` with `{ shell: true }` and
   calls `child.kill("SIGTERM")` on timeout. On this host that signals only the
   shell; a `sleep 5` grandchild keeps running (~5000 ms). The contract-timeout
   override test therefore fails the wall-clock assertion even when the log
   claims `TIMEOUT`.
2. **High-fanout process-tree fixtures race the host.**
   Residual-bound and 20×512 nested-group tests assert membership immediately
   after helper pid files appear. Helper pid appearance does not guarantee the
   large nested sleeps are visible in `ps` yet, so `listGroupMembers` /
   `residualCount` under-report on a slower Linux scheduler.

Both are Linux-visible correctness/test-hygiene issues. They block a credible
Linux evidence lane for the pilot closeout.

## Fix

1. On non-Windows, spawn verifier shell commands in their own process group and
   on timeout signal the **group** (`kill(-pid, SIGTERM)`), with a short
   SIGKILL escalation. Keep Windows behavior as direct pid signal. Timeout must
   remain a verifier failure (exit 124), never accepted evidence.
2. In `tests/worker-process-tree.test.ts`, wait until the expected group
   membership / helper count is observable before asserting residual bounds or
   the 512-member nested group. Do not weaken exact-identity or fail-closed
   cleanup semantics.
3. Record Linux measurement evidence under
   `docs/evidence/LINUX_POSIX_VERIFIER_HARDENING.md` with host, Node, commands
   and pass/fail counts.

## Non-goals

- No systemd-run / launchd / daemon work.
- No Windows Job Object parity.
- No change to DEFAULT_VERIFY_TIMEOUT_MS (30s) for legacy contracts.
- No claim that supervised pilot is ready or that OS sandbox exists.
- No lowering of MAX_PROCESS_TREE_MEMBERS or durable registry bounds.

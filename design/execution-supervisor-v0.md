# ExecutionSupervisor v0 (P2b) — draft

> Draft 2026-11-05. Not frozen, not dispatched.

## Purpose

Introduce the containerd-shim-style execution boundary: a platform-neutral
`ExecutionSupervisor` interface and a stable `RuntimeHandle` authority that
replaces PID/PGID as the recovery identity, plus an explicit per-task
`execution.continuity` policy and a runtime-conformance suite. This is the
process-ownership fix for the class of cleanup races we kept hitting.

## Decisions

- Interface: `Start / Inspect / Attach / Stop / Collect / Destroy` with
  capability declarations (descendant control, restart recovery, resource
  limits, filesystem/network isolation).
- RuntimeHandle authority: a stable handle (backend type + handle string such
  as a launchd label or exact `pgid:startedAt`), with PID/PGID diagnostic only.
- Continuity: contract field `execution.continuity` with `fail-closed`
  (default) and `durable` (re-attach after controller restart, hard-limited).
- macOS backend in this slice: POSIX process group + exact identity, with an
  honest capability label (not full descendant-tree containment). launchd
  integration is the following slice.

## Non-goals

- No launchd plist/job integration in this slice.
- No Windows Job Object or cross-host recovery.
- No OS filesystem/network sandbox (P3).

## Risks

- `worker-lease.ts` and `process-tree.ts` are the most delicate files; the
  authority migration must preserve exact-identity safety and fail-closed
  behavior, and the identity-reuse classification landed in P2a must stay.

# Runtime Orphan Hardening

> Revision: runtime-orphan-hardening
>
> Scope: correctness issues found while dogfooding Runtime orphan recovery

## Findings

### 1. Lease owner PID was not exact

Preflight accepted a lease whose dead `pid` differed from the manifest owner
PID. A dead third-party owner could therefore be ignored while the manifest
authorized a kill by port/group correlation.

New rule:

```text
lease.pid === manifest.owner.pid
```

Any mismatch is `needs_human`, regardless of whether the lease PID is alive.

### 2. Recovery reports lost runtime identity

`RuntimeRecoveryRecord` had no `runtimeId`. The Supervisor reconstructed IDs by
matching state + reason strings against a second preflight. That is ambiguous
under concurrent changes and introduced a literal NUL delimiter in source.

New rule:

- recovery records carry optional `runtimeId` for backward compatibility;
- every new executor record writes it;
- Supervisor uses the record directly and never reconstructs IDs by reason.

### 3. Test port blocks could overlap

Six runtime test files selected a free ephemeral port, closed it, and expanded
it into a custom range. Separate test processes could select the same range.
Because their lease stores were repository-local, both allocators were allowed
to reserve the same host port. One test could then perform readiness against
the other test's HTTP service.

New rule:

- test files get disjoint static port pools;
- a shared helper advances within the assigned pool;
- a pool never overlaps another runtime test file;
- tests still go through the real PortAllocator probe/retry path within their
  pool.

## Tasks

```text
{owner-exact, recovery-runtime-id, test-port-isolation}  [parallel]
  → supervisor-record-consumption
  → docs/evidence
```

## Non-goals

- No global cross-repository production port registry.
- No change to the product's single-host/single-repository v0 scope.
- No weakening of `needs_human`.
- No daemon or SQLite.

## Acceptance

1. Dead or live lease PID mismatch is `needs_human`.
2. Executor recovery records and manifests contain their runtimeId.
3. Supervisor output does not infer IDs from reasons.
4. Supervisor source is text-clean (no embedded NUL).
5. `npm test` passes five consecutive isolated runs.
6. RuntimeManager, reaper and Supervisor suites all remain green.

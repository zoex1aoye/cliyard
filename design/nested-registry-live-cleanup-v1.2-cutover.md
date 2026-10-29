# Nested registry live-cleanup v1.2 cutover

> Status: Plan for a documentation-only cutover run.
>
> Reviewed implementation base:
> `fac4606107141f6eb243e9308d7fc044f4255b9e`.

## Context

Implementation run `d058568e-2d24-4cb9-a878-4ed360201aac` produced the v1.2
separation from base `a18b46c`.

The implementation result itself was reviewed independently:

- focused process/lease tests: 65/65;
- build: pass;
- complete suite: 464/464 in 25.98 seconds;
- only the four frozen write paths changed;
- WorkspaceBoundary: clean;
- no residual fixture processes found by an exact worktree/helper path check.

The run was still rejected with `process_tree_cleanup_failed` because its outer
Supervisor was loaded from `a18b46c`, whose manager intentionally fails when the
bounded durable registry is truncated. The RunManifest recorded:

- `residualCount=0`;
- `signalledGroups=0`;
- a truncated 16-group registry;
- at least one real high-fanout group;
- CLI-estimated cost `$6.445692`, non-authoritative.

The reviewed implementation is preserved at `fac4606` on
`cliyard/mvt1n5la-nested-live-cleanup-separation`. It is a draft, not accepted
integration.

## Cutover goal

Load the Supervisor and outer Worker manager from `fac4606` and target the main
checkout. A documentation-only task must run focused tests, build and the full
suite, then complete without the old
`descendant snapshot exceeded a bounded nested registry limit` rejection.

Required behavior:

- live cleanup may enumerate all reachable groups within the existing
  process-table cap;
- the durable lease remains bounded;
- a truncated persisted registry is reported separately;
- no current residual process or group remains;
- controller-death recovery from truncated evidence still returns
  `needs_human` and sends no signal;
- the RunManifest retains exact process-tree, path, boundary and cost evidence.

## Documentation task

Add only:

```text
docs/evidence/NESTED_REGISTRY_LIVE_CLEANUP_V1_2.md
```

Record exact commands, test counts, duration, lineage, eventual RunManifest
cleanup evidence, cost truth and remaining limitations. The document must
separate:

- implementation-run failure before cutover;
- reviewed implementation measurements;
- cutover-run evidence produced by the new outer manager.

## Non-goals

- no source or test modification in the cutover task;
- no automatic acceptance, merge or push;
- no Windows or cross-host recovery;
- no recovery claim for nested groups never observed before controller death;
- no OS write sandbox, credential isolation or network isolation;
- no claim that one cutover is a 24-hour soak.


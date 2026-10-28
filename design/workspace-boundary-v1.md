# WorkspaceBoundary v1

> Status: implementation contract
>
> Date: 2026-10-28
>
> Priority: P0 safety prerequisite for parallel and unattended delivery

## Problem

Changing a worker CLI's `cwd` to a task worktree is not a filesystem boundary.
During the WorkerLease self-host run, a worker modified a source file in the
main control checkout while its task worktree was elsewhere. The existing path
audit only inspected the task worktree and therefore did not observe that
authority-checkout mutation.

WorkspaceBoundary v1 is a detection slice. It does not claim to prevent writes.
Its purpose is to make unexpected protected-root mutations fail closed before a
worker result can be accepted.

## Scope

The slice has two ordered tasks:

1. Build a deterministic protected-root snapshot and comparison core.
2. Run the guard around every parallel worker wave, persist bounded evidence in
   `RunManifest`, reject affected results when the boundary is dirty or cannot
   be inspected, and expose the evidence through Supervisor status.

Provider-specific prevention is explicitly deferred. A future
`SandboxProvider` may wrap worker processes with Codex Sandbox, Anthropic
Sandbox Runtime, bubblewrap/Landlock, or a container. That provider must sit
behind a separate normalized interface and may not change this evidence model.

## Protected roots

The default policy protects:

- tracked, modified and untracked files in the authority checkout;
- the important Git common-directory state: `HEAD`, `index`, `packed-refs`,
  `config`, hooks and refs;
- control authority files under `.cliyard` such as contracts, plans,
  RunManifests and `queue.json`.

The control plane legitimately mutates these while a worker runs, so they are
excluded from comparison:

- `.cliyard/worktrees/`;
- `.cliyard/runtime/`;
- `.cliyard/worker-events/`;
- `.cliyard/worker-leases/`;
- `.cliyard/queue-events/`;
- `.cliyard/logs/`;
- the configured ledger path.

No result may infer safety from a clean task worktree alone.

## Snapshot model

The core must:

- accept explicit absolute protected roots and exclusions;
- never follow symlinks outside a protected root;
- detect added, removed and modified regular files, symlinks and directory
  layout;
- use a content digest for regular files rather than trusting timestamps;
- keep full snapshots in memory only;
- persist only bounded path-level change evidence, never file contents;
- normalize evidence paths and reject absolute paths, traversal and control
  characters;
- report an inspection error rather than silently returning clean;
- cap records, paths and diagnostics so a hostile or noisy tree cannot create
  unbounded RunManifest state.

The guard is intentionally conservative. If a protected root cannot be
snapshotted, or a configured cap is exceeded, the result is an inspection
failure and all worker results in that wave fail closed.

## Batch semantics

For each parallel ready wave:

1. Capture one boundary snapshot after attempt worktrees and read-context checks
   are ready, but before any worker starts.
2. Run every worker in the wave.
3. Capture the post-wave snapshot before any accepted task is merged or the
   RunManifest is advanced.
4. Compare snapshots.
5. Persist one bounded `WorkspaceBoundaryRecord` for every task in the wave.
6. If the boundary is dirty or inspection failed, no task in that wave may be
   accepted or merged.

A worker that already failed keeps its original structured failure. A successful
worker result is converted to a `policy_blocked` failure with a stable code:

- `workspace_boundary_violation`;
- `workspace_boundary_inspection_failed`.

The guard never deletes, reverts or hides an unexpected change. The operator
must inspect it.

## Test seam

`CodexBatchOptions` may accept an injected boundary guard factory for
deterministic integration tests. The production default must not silently
become a no-op. Tests may inject clean, dirty and failing guards without
writing outside their temporary repositories.

## Verification

Required evidence:

- focused core tests for clean, modified, added, removed, symlink, exclusion,
  path sanitization and bounded-failure behavior;
- integration tests proving a clean wave accepts, a dirty wave rejects every
  active task without merge, and an inspection error fails closed;
- manifest round-trip and legacy-manifest compatibility;
- human and JSON status projections;
- `npm run build` and the complete test suite.

## Non-goals

- No OS sandbox or write prevention.
- No provider selection, SRT, Node version change or dependency installation.
- No filesystem rollback.
- No automatic deletion of unexpected files.
- No protection claim for reverted writes or reads that leave no persistent
  filesystem change.
- No complete hashing claim for every ignored dependency/build directory; those
  require explicit protected roots or a future prevention provider.
- No change to task acceptance based only on progress, heartbeat or status.

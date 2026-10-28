# WorkspaceBoundary v1

> Status: **implemented — guard-only detection** (2026-10-28)
>
> Date: 2026-10-28
>
> Priority: P0 safety prerequisite for parallel and unattended delivery
>
> Evidence: [../docs/evidence/WORKSPACE_BOUNDARY.md](../docs/evidence/WORKSPACE_BOUNDARY.md)

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

For a Supervisor-backed batch, the **exact active RunManifest** path
(`runManifestPath(repoRoot, requestedManifest.runId)`) is also excluded from
the in-flight comparison: deadline and budget extension checkpoints
legitimately rewrite it while workers run. This is a trusted control-plane
path, not worker evidence, and the exclusion is one exact file. Every other
RunManifest, the runs directory layout, `queue.json`, plans/contracts,
authority source and protected Git state remain guarded. A plain batch without
a requested manifest gains no `.cliyard/runs` exclusion.

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

## Implementation status

Implemented on 2026-10-28:

- protected-root snapshot/compare core in
  `src/agents/workspace-boundary.ts` with content digests, symlink-target
  digests, directory layout, deterministic ordering, bounded evidence and
  fail-closed caps;
- per-wave capture/compare in `src/scheduler/codex-batch.ts`, bounded
  `WorkspaceBoundaryRecord` persistence for every task in the wave, stable
  policy failure codes and status projection;
- exact active RunManifest exclusion for `requestedManifest.runId`; a sibling
  RunManifest change is still a violation and a plain batch has no
  `.cliyard/runs` exclusion;
- fail-closed hardening: every control character is sanitized (not only the
  first), and null/undefined/non-object snapshot map values return a bounded
  inspection failure instead of an uncontrolled `TypeError`;
- deterministic integration coverage for active-manifest changes, sibling
  manifest changes, plain batches, dirty/inspection-error waves, capture and
  compare failures, and the production guard.

Measured evidence and exact limitations:
[../docs/evidence/WORKSPACE_BOUNDARY.md](../docs/evidence/WORKSPACE_BOUNDARY.md).
Focused boundary set 76/76 in clean repeated runs; complete suite 432/432
green. Repeated local full runs hit only pre-existing
`deadline-extension.test.ts` timing flakes, which reproduce with that file run
alone and are unrelated to this slice; no workspace-boundary test failed.

The remaining safety gap is **prevention**. A future provider-neutral
`SandboxProvider` (Codex Sandbox, Anthropic Sandbox Runtime,
bubblewrap/Landlock or a container) must wrap worker processes behind a
separate normalized interface and must not change this evidence model. Until
then this slice is detection only, not OS sandboxing, credential isolation or
network isolation.

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

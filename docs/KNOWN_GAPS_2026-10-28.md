# Known Gaps and Next Safety Work

> Recorded: 2026-10-28
>
> Accepted, not yet merged: WorkspaceBoundary v1
> `c04bb96ea98004493b4d88cc5cbe56e052fa0915` on
> `cliyard/integration/workspace-boundary-v1-finish`

## Current state

WorkspaceBoundary v1 has passed its task verifier:

- focused tests: 76/76;
- complete suite: 432/432;
- no worker path-audit escape;
- no active worker lease or Supervisor lock at completion.

It is a guard-only detection layer. It does not prevent writes and has not yet
been exercised by a control-plane process that loads the new implementation.

The original `workspace-boundary-v1` run remains blocked history. Manual
adoption would have been the wrong model because its timed-out integration
worktree still needed code, tests and evidence changes. A new Supervisor run
was started from the reviewed draft (`3645c4c`) and produced the accepted
`c04bb96` integration head instead.

## Newly observed P0 issues

### 1. Nested worker process groups can escape cleanup

The first Codex implementation run timed out while its worker had started a
repository-wide test command. The timeout cleaned the recorded CLI process
group `8783`, but a nested shell/test group `99841` remained alive and
reparented to PID 1. The leaked group contained the full Vitest/Node runner and
esbuild helper processes, all with a worktree cwd.

The orphan was read-only inspected, proven to contain only that run's worktree
processes, then terminated as the exact group `99841`. No process-name or broad
scan was used.

This disproves the broad implication that a WorkerLease/POSIX group always owns
the complete worker process tree. A CLI or test runner can create a new session
or process group. Current cleanup covers:

- the dedicated top-level worker group;
- descendants that stayed in that group.

It does not cover:

- descendants that created a separate group/session while the leader was
  alive;
- nested groups after a controller is already dead and the parent relation has
  been lost.

### 2. Self-host code provenance lag

The process that orchestrates a change loads cliyard from the main checkout, not
from the task's worktree. Therefore the run that implements a control-plane
feature cannot exercise that new code unless the CLI is explicitly launched
from an already accepted integration worktree.

The next run should launch the accepted WorkspaceBoundary implementation from
`c04bb96` while targeting the main checkout. Its RunManifest must contain
non-null `workspaceBoundary` evidence; only then is real self-host execution
proven.

## Existing P0/P1 gaps

| Priority | Gap | Current state | Next action |
|---|---|---|---|
| P0 | Nested descendant process groups | Observed real orphan `99841`; only top-level group is leased/cleaned | WorkerProcessTree v1.1 |
| P0 | OS write prevention | WorkspaceBoundary detects after the fact | Provider-neutral SandboxProvider |
| P0 | Controller-death recovery of nested groups | Lease stores the top-level worker group only | Follow after live-leader cleanup |
| P1 | WorkspaceBoundary evidence parser consistency | Optional digest fields are format-checked but not fully cross-validated against add/remove/modify semantics | Harden with the next boundary schema change |
| P1 | Active RunManifest trust | The exact current manifest is excluded because extension checkpoints legitimately update it | Keep explicit; do not widen the exclusion |
| P1 | Guard policy configuration | Extra roots, exclusions and caps exist in the core but are not exposed through Project config/CLI | Expose a versioned policy when prevention is designed |
| P1 | Large/ignored trees | The guard walks physical entries and fails closed at 100,000 entries; it does not use `.gitignore` | Profile real Java/Flutter/Rust repositories before changing defaults |
| P1 | Credential and network isolation | Guard hashes files and never inspects credentials, sockets or network traffic | SandboxProvider capability phases |
| P0 | ProfileCatalog and real binding activation | ExecutionProfile is frozen, but endpoint/account activation is not verified | After process safety |
| P0 | Per-run ownership and hierarchical admission | Queue is still sequential with a repo-global Supervisor lock | After routing prerequisites |
| P0 | Stable Control API | Internal control snapshot exists; no versioned client-neutral API/event stream | After routing/parallel semantics |
| P1 | Automatic attempt policy/controller | Retry remains explicit; no controller heartbeat or lookahead loop | After the prerequisites above |
| P2 | Windows Job Objects and dynamic routing scores | Not implemented | Later |

## Decision

The next slice is **WorkerProcessTree v1.1**:

1. Add a bounded process-table inspection capability on macOS/Linux.
2. Track descendants of a live managed worker, including those that create a
   separate process group.
3. Revalidate exact process identity before signalling.
4. Clean those exact descendants on timeout/cancel while preserving the
   existing dedicated-group behavior.
5. Record bounded descendant evidence and fail closed on ambiguity.

This ranks first because it fixes an observed safety regression in code already
claimed as complete. SandboxProvider prevention remains the next P0 safety
slice after nested process ownership has a measured fix.

## Next-run execution rule

For the next self-host run:

- commit the design/Plan files first;
- compile and commit contracts from the accepted integration base;
- launch the Supervisor CLI from the accepted WorkspaceBoundary integration
  worktree, while targeting the main checkout;
- require a non-null guard record for the produced run;
- keep the worktrees and require manual diff review before merge.

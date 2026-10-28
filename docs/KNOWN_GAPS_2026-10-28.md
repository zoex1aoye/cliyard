# Known Gaps and Next Safety Work

> Recorded: 2026-10-28
>
> Accepted, not yet merged:
> WorkspaceBoundary v1 `c04bb96ea98004493b4d88cc5cbe56e052fa0915` and
> WorkerProcessTree v1.1 `9a38174a872d70b7a250225c31fa7ce4efdcf06e`

## Current state

WorkspaceBoundary v1 has passed its task verifier:

- focused tests: 76/76;
- complete suite: 432/432;
- no worker path-audit escape;
- no active worker lease or Supervisor lock at completion.

WorkspaceBoundary v1 is a guard-only detection layer. It does not prevent
writes. A later WorkerProcessTree v1.1 run launched the Supervisor from the
accepted WorkspaceBoundary code and produced a non-null clean guard record, so
real self-host execution is now measured.

WorkerProcessTree v1.1 has also passed its task verifier:

- focused process/WB/Supervisor set: 89/89;
- complete suite: 440/440;
- no worker path-audit escape;
- no active worker lease, Supervisor lock or test helper left behind.

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
or process group. WorkerProcessTree v1.1 now covers, while the top-level leader
is alive or its relation was sampled before exit:

- the dedicated top-level worker group;
- descendants that stayed in that group.

It still does not cover:

- descendants that created a separate group/session while the leader was
  alive;
- nested groups after a controller is already dead and the parent relation has
  been lost.

### 2. Self-host code provenance lag

The process that orchestrates a change loads cliyard from the main checkout, not
from the task's worktree. Therefore the run that implements a control-plane
feature cannot exercise that new code unless the CLI is explicitly launched
from an already accepted integration worktree.

The WorkerProcessTree v1.1 run launched the Supervisor from `c04bb96` while
targeting the main checkout. Its RunManifest contains a non-null
`workspaceBoundary: clean` record, proving real self-host execution.

## Existing P0/P1 gaps

| Priority | Gap | Current state | Next action |
|---|---|---|---|
| P0 | Live nested descendant process groups | Closed for live/sampled trees: WorkerProcessTree v1.1 cleans exact external descendants on timeout/cancel | Keep measured regressions |
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

The live-leader nested-process gap is closed by WorkerProcessTree v1.1. The
remaining process-ownership gap is controller death after a nested group has
already detached from the top-level worker.

The next implementation priority is **controller-death nested process
ownership**, because WorkerLease still persists only the top-level worker group.
That slice must extend the lease/store/recovery protocol without weakening
exact identity checks.

Immediately after it, implement the provider-neutral **SandboxProvider** for OS
write prevention. ProfileCatalog and grid admission remain behind process and
filesystem safety.

## Next-run execution rule

For subsequent self-host runs:

- commit the design/Plan files first;
- compile and commit contracts from the accepted integration base;
- launch the Supervisor CLI from the latest accepted integration worktree,
  while targeting the main checkout;
- require a non-null guard record for the produced run;
- keep the worktrees and require manual diff review before merge.

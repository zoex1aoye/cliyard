# WorkspaceBoundary v1 evidence

> Status: **implemented — guard-only detection**
>
> Date: 2026-10-28
>
> Design authority: [design/workspace-boundary-v1.md](../../design/workspace-boundary-v1.md)
>
> Implementation: `src/agents/workspace-boundary.ts`,
> `src/scheduler/codex-batch.ts`
>
> Tests: `tests/workspace-boundary.test.ts`,
> `tests/workspace-boundary-integration.test.ts`,
> `tests/supervisor-cli.test.ts`, `tests/budget-continuation.test.ts`,
> `tests/deadline-extension.test.ts`

## What this slice is

WorkspaceBoundary v1 is a **detection** slice. It makes an unexpected mutation
of the authority checkout fail closed before any worker result in the affected
wave can be accepted or merged. It is not write prevention, not an OS sandbox
and not credential or network isolation.

The slice closes the gap observed during WorkerLease self-hosting: a worker's
`cwd` was a task worktree, but the worker wrote into the main control checkout,
and the existing worktree path audit could not see it.

## Exact behavior

### Protected roots and entries

The per-wave policy is provider-neutral. A wave guards:

- the authority checkout (`repoRoot`) as the first protected root;
- optional extra roots supplied to the policy;
- regular files by SHA-256 **content** digest, never by timestamp;
- symlinks by their link target, never by following them;
- directory presence and directory layout changes.

Important Git common-directory state is protected: `.git/HEAD`, `.git/index`,
`.git/packed-refs`, `.git/config`, `.git/hooks/**` and `.git/refs/**`. Other
Git state (objects, reflogs and per-worktree state) is excluded so normal Git
activity alone does not dirty the boundary.

Control authority stays protected: `.cliyard/contracts`, plans, `queue.json`,
and every RunManifest other than the one exact active manifest described below.

### Default control-plane exclusions

The following mutable control-plane paths are excluded from comparison:

- `.cliyard/worktrees/`
- `.cliyard/runtime/`
- `.cliyard/worker-events/`
- `.cliyard/worker-leases/`
- `.cliyard/queue-events/`
- `.cliyard/logs/`
- `.cliyard/ledger.json` and the configured ledger path
- `.git` except the important Git state listed above

No exclusion is read from `.gitignore`; only explicit policy and immutable
defaults apply.

### Active RunManifest exception

The control plane legitimately checkpoints the **current** run while a worker
is running: deadline and budget extension grants are persisted into
`.cliyard/runs/<runId>.json` through the run-scoped `onExtension` callback.

For a Supervisor-backed batch, the per-wave policy therefore excludes exactly
`runManifestPath(repoRoot, requestedManifest.runId)` — one absolute file path,
nothing broader. This is trusted control-plane state, not worker output.

The exception does not widen:

- every other RunManifest under `.cliyard/runs/` remains guarded; a sibling
  manifest added or modified during a wave is a violation;
- the `.cliyard/runs` directory itself remains guarded, so a new manifest is
  visible as an added entry;
- `queue.json`, contracts, plans, authority source and protected Git state
  remain guarded;
- a plain batch without a `runManifest` gains **no** `.cliyard/runs` exclusion
  at all.

### Wave lifecycle

For each ready wave:

1. Create/reuse every attempt worktree and checkpoint the attempt identity.
2. Capture one protected-root snapshot after the worktrees exist and before
   any worker starts.
3. Dispatch every worker in the wave.
4. Capture the post-wave snapshot **before** any result is accepted, merged or
   checkpointed past the wave.
5. Compare before/after snapshots.
6. Persist one bounded `WorkspaceBoundaryRecord` per task in the wave.

If the comparison is not clean:

- every successful worker result in the wave becomes a `policy_blocked`
  rejection (`workspace_boundary_violation` for a dirty tree,
  `workspace_boundary_inspection_failed` when inspection failed);
- no task in the wave is accepted or merged, and the integration head does not
  advance;
- a worker that already failed keeps its original structured failure;
- the guard never deletes, reverts or hides an unexpected change; the operator
  inspects it.

The evidence record is `version: 1`, `enforcement: "guard-only"`, bounded
path-level changes with digests, optional bounded error text, and capture /
compare timestamps. Full snapshots stay in memory.

### Fail-closed semantics

- Capture failure (unreadable root, unsupported entry type, entry/path cap)
  fails the whole wave **before dispatch**; no worker runs.
- A `capture()` or `compare()` that throws (including an injected guard) is
  converted to `inspection_failed`; it can never become clean.
- An invalid injected guard factory returns a hard error; enforcement has no
  silent disable path.
- More than `maxChanges` changes returns `inspection_failed` with bounded
  evidence instead of a truncated "clean".
- Comparison over different roots, unsafe evidence paths, malformed entry
  kinds/digests, non-string keys or null/undefined/non-object map values returns
  `inspection_failed`; malformed input never throws an uncontrolled TypeError.
- Every control character in diagnostics is replaced (not only the first) and
  diagnostics are truncated to a bounded length before persistence.
- Caps: `maxEntriesPerRoot=100000`, `maxChanges=1024`,
  `maxPathLength=4096`, `maxDiagnosticLength=2048`.

## Verification

Environment: macOS (`darwin`, Darwin 27.0.0), Node `v20.20.2`, `tsx` from the
existing dev dependencies. No dependency, Node version or runtime change.

Command:

```text
npx tsx --test tests/workspace-boundary.test.ts \
  tests/workspace-boundary-integration.test.ts \
  tests/budget-continuation.test.ts \
  tests/deadline-extension.test.ts \
  tests/supervisor-cli.test.ts
```

Focused results (the same five files, repeated; run 1 used the exact verify
order above):

| Run | Tests | Pass | Fail | Duration |
|-----|-------|------|------|----------|
| 1 | 76 | 76 | 0 | 24799.9 ms |
| 2 | 76 | 76 | 0 | 24715.8 ms |
| 3 (host under load) | 76 | 74 | 2 | 22499.4 ms |
| 4 | 76 | 76 | 0 | 24734.4 ms |

The 76 focused tests are 24 boundary core + 14 boundary integration + 10
supervisor CLI + 15 budget continuation + 13 deadline extension. The two
failures in the loaded repeat were `deadline-extension.test.ts`
"maxExtensions bounds repeated healthy grants" and "maxTotalTimeoutMs bounds
cumulative healthy grants"; no workspace-boundary test failed.

`npm run build` (`tsc -p tsconfig.json`) exits `0`.

Full suite: `npm test` (432 tests) produced **432/432 pass, 0 fail** on two
captured runs (25866.4 ms and 25941.0 ms). Two other repetitions produced
431/432 (24205.7 ms) and 431/432 (34095.0 ms), both from pre-existing
`deadline-extension.test.ts`
timing tests ("maxTotalTimeoutMs bounds cumulative healthy grants" and
"collect waits for an in-flight grant checkpoint past child exit"). The same
file failed 1 of 6 isolated runs on the same host ("maxTotalTimeoutMs bounds
cumulative healthy grants" and "the same child timer is re-armed only after
async persistence resolves"), so the flake is independent of this slice. The
previous verifier rejection was the same class of timing flake — that run's
only failure was `deadline-extension.test.ts` "a result after the extended
deadline still loses to timeout" (expected the 3700 ms extended deadline but
observed the base 2500 ms timeout); every workspace-boundary test passed. This
is one local observation on a shared host, not a flake-rate claim.

New coverage in this slice:

- clean wave accepts and persists `clean` guard-only records;
- the **active** RunManifest may change during a wave (simulated extension
  checkpoint) and the wave still accepts;
- a **different** RunManifest changed during the wave is a violation with that
  path in the bounded evidence;
- a plain batch without a requested manifest keeps every RunManifest guarded;
- dirty and inspection-error waves reject every task without merge;
- capture failure skips dispatch;
- a thrown compare failure after the wave fails closed with bounded evidence
  and no merge or acceptance;
- malformed snapshot map values and multiple control characters are bounded;
- the production guard observes an authority-checkout write and never deletes
  or reverts it;
- SIGKILL/resume keeps the same recovery assertions with its fixture marker and
  worker call log under the excluded `.cliyard/logs` path.

## Explicit limitations

- **Guard-only detection.** Unexpected writes are observed and fail the wave
  closed; they are not prevented. A worker can still write before the
  post-wave comparison, and the operator must inspect the change.
- **The active RunManifest is trusted control-plane state.** Its content is
  excluded from the in-flight comparison because deadline and budget extension
  grants legitimately rewrite it. Integrity of that manifest relies on the
  existing Supervisor checkpoint path, not on this guard.
- **Ignored dependency/build trees are not automatically covered.** The guard
  does not parse `.gitignore`. Ignored trees are only compared when they are
  physical entries under a protected root and within the caps; otherwise they
  require explicit protected roots or a future prevention provider.
- **Reverted writes are not detectable.** A file changed and restored between
  the two snapshots has the same digest; reads and transient writes that leave
  no persistent filesystem change are invisible.
- **Concurrent changes are attributed to the whole wave.** Any protected-root
  change observed during the wave is reported against every task in that wave,
  even if only one worker (or the control plane outside the extension path)
  caused it. Narrower attribution is not claimed.
- **Not OS sandboxing.** There is no kernel-level write confinement,
  `SandboxProvider`, SRT, Codex Sandbox, bubblewrap/Landlock or container
  isolation. The gap between detection and prevention remains.
- **Not credential isolation or network isolation.** The guard reads file
  metadata/content digests and never inspects credentials, environment
  variables, sockets, network traffic or provider sessions.
- **No automatic remediation.** Nothing is auto-reverted, auto-deleted or
  hidden. Evidence stays on disk for operator review.
- **No completeness claim for enormous trees.** Entry and change caps fail
  closed rather than returning a partial clean verdict.

## Next safety task

The remaining P0 safety gap is **prevention**: a provider-neutral
`SandboxProvider` that wraps worker processes with an OS-level filesystem
boundary without changing this evidence model. Until that exists,
WorkspaceBoundary v1 must be described as guard-only detection, never as
containment.

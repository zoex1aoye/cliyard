# Worker Exit Path Audit

Date: 2026-10-28

## Scope

This change closes the failed-exit and reused-worktree gap described in
`design/selfhost-iteration-v0.md` section 2.3.

The audit is evidence, not an acceptance authority. It records changed paths
after every worker exit, including non-zero exits, but it does not rewrite the
worker's structured failure, grant acceptance, or replace verifier policy.

## Behavior

`src/agents/path-scope.ts` provides the shared pure audit:

- repository-relative path separators are normalized to `/`;
- exact `writePaths` entries are allowed;
- descendants are allowed only when the write path is explicitly directory-like
  with a trailing `/` or `\`;
- absolute paths, backslash/UNC rooted paths, drive-qualified paths, NULs, and
  any `..` segment are outside scope;
- changed and outside-scope evidence is deduplicated and capped.

Claude and Codex adapters now return `changedPathsError` when
`collectChangedPaths` fails. A collection error remains separate from the
provider/worker failure already represented by `AgentResult.failure`.

`runClosedLoop` audits every collected worker result before inspecting its exit
code. A rejected worker keeps its original failure category, such as
`budget_exhausted` or `provider_auth`, even if the same exit also has an
outside-scope path or a changed-path collection error.

Manifest-backed batches checkpoint cumulative `RunTaskState.pathAudits`
evidence for accepted and rejected results. The store treats the field as
optional for backward compatibility, but rejects malformed present evidence.
Records retain at most 64 worker exits, 128 changed paths, 128 outside-scope
paths, and 2,000 characters of collection error detail.

Before a rejected worktree is reused, the batch collects changes from that
attempt's recorded base and audits them against the current contract. Any
outside-scope path or collection failure aborts before worker invocation. The
error includes the observed changed/outside paths or collection error, and
leaves the worktree untouched.

## Tests

Focused coverage is in `tests/worker-exit-path-audit.test.ts`:

- a failed budget exit with an outside-scope temporary file records audit
  evidence while preserving the budget failure;
- accepted exits retain normalized audit evidence;
- traversal, absolute, and drive-qualified paths are rejected, while
  directory-like scopes allow descendants and exact file scopes do not;
- Claude and Codex expose a changed-path collection failure in its own result
  field;
- legacy manifests without `pathAudits` remain readable and malformed present
  records fail closed;
- accepted batch results checkpoint audit evidence;
- a reused rejected worktree with an unexpected file fails before the worker
  factory is invoked, and the file remains on disk.

Run the focused suite with:

```text
node --import tsx --test tests/worker-exit-path-audit.test.ts
```

## Validation

- `./node_modules/.bin/tsc -p tsconfig.json --noEmit` passed.
- The focused suite passed 7/7 tests.
- Adjacent `supervisor-attempt-reuse`, `supervisor-failure-cost`,
  `supervisor-store`, `codex-paths`, and `claude-adapter` suites passed 28/28
  tests.

The validation used temporary repositories and fixture workers. No runtime
service was intentionally started by the focused path-audit tests.

## Why automatic cleanup is forbidden

An unexpected untracked path is not proof that the orchestrator owns it.
Deleting it automatically could destroy human edits, editor recovery data, or
files created by a process whose ownership is ambiguous. The safe recovery is
an explicit operator decision: inspect the evidence, preserve the draft, and
choose a fresh attempt when appropriate. Automatic cleanup would also hide the
condition that this audit is intended to make durable.

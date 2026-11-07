# Background VerificationTask v0

> After P3c land (`1a930e4` / PR #13). Priority item 6 in
> `docs/CURRENT_STATE.md`. Semantics from
> `design/continuous-harness-v2.md` §VerificationTask.

## Problem

Verification today is synchronous inside `runClosedLoop`: the Worker session
must stay coupled to shell verify. There is no independent verification
identity, no durable output offset, no delivery latch, and no startup recovery
that marks uncertain in-flight verify as `lost` / `needs_human`.

## Fix (v0)

1. **Model** — `VerificationTask` record matching continuous-harness v2
   (id, runId, taskId, artifactCommit, contractsHash, specVersion, commands,
   status including `lost`, optional `ownerIdentity`, `output.{uri,offset}`,
   `deliveredAt` / `startedAt` / `endedAt`, `lastError`, `evidenceRefs`).
2. **Durable store** — JSON files under
   `<repoRoot>/.cliyard/verification/<id>.json` with atomic write; load by id
   and list for recovery. Observational only; never grants acceptance.
3. **Runner** — start a detached verify process group for finite commands at
   an exact worktree cwd bound to `artifactCommit` (caller supplies verified
   cwd; runner does not invent a checkout). Append stdout/stderr to the output
   URI, advance `offset`, persist identity, set terminal status
   (`succeeded`/`failed`/`canceled`). `deliveredAt` is set once (idempotent
   latch) when the controller first observes a terminal record.
4. **Startup recovery** — `recoverVerificationTasks(repoRoot)`: any
   `running`/`stopping` task whose `ownerIdentity` is missing or no longer
   matches a live process becomes `lost` with a structured failure; never
   rewrite to `succeeded` by inference; never leave forever-`running`.
5. **Proof** — focused tests: output offset advances; delivery latch once;
   parent-exit simulation leaves verify process owned by task identity;
   recovery marks orphaned running → `lost`. Evidence doc + CURRENT_STATE /
   ROADMAP update.

## Non-goals

- Do not replace `createShellVerifier` / `runClosedLoop` verify path yet
  (batch wire is a follow-up once the model is proven).
- Do not implement clean-context Reviewer or Harness Eval scenarios.
- Do not claim OS sandbox; do not start unbounded services without
  RuntimeManager (v0 commands are finite argv shells only).
- Do not auto-accept tasks from verification status alone.
- No Windows Job Object parity in this slice.

## Acceptance without evidence

Without green focused tests + recovery fixture + evidence path, do not claim
background verification, Worker-exit survival, or startup recovery.

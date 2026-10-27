# Failure/Cost Evidence Correction v0

> Date: 2026-10-27
>
> Status: docs-only correction found during human integration review

## 1. Problem

The failure/cost evidence document says the verification is fixture-based and
then states that no real Claude/DeepSeek session was started or billed. That
second statement is false for the overall iteration.

Real Claude Code + DeepSeek sessions were used to execute:

```text
failure-cost-truth-v0
  attempt 1: core accepted; durable hit the $10 guard
  attempt 2: durable accepted; docs hit the $5 guard
  attempt 3: docs accepted

failure-cost-hardening-v0
  core required one verifier repair, then accepted
  docs accepted
```

The implementation tests themselves are fixture-based, and the new
subtype-aware adapter code was not exercised by a real provider session before
merge. Those two statements must be separated.

## 2. Observed transcript evidence

Human review inspected the local Claude session transcripts after the blocked
queue attempts. Bounded budget attachments showed:

```text
failure-cost-durable: used $9.939564 / $10, remaining $0.060436
failure-cost-docs:    used $4.883416 / $5,  remaining $0.116584
```

The legacy queue/RunManifest path still reported:

```text
implement failed: exitCode=1
```

That mismatch motivated the post-review subtype hardening and remains useful
evidence for why the taxonomy is needed.

No raw transcript, prompt, file content or secret is copied into the evidence.

## 3. Required correction

Update only `docs/evidence/FAILURE_COST_TRUTH.md` so it:

1. distinguishes real self-host execution from fixture-based implementation
   verification;
2. records the two observed budget guard uses above;
3. records that the legacy path blurred both into `implement failed:
   exitCode=1`;
4. records that retries reused worktrees and completed with new provider
   sessions;
5. states that the hardening subtype path is covered by fixtures and was not
   exercised by a new real provider session before merge;
6. makes no DeepSeek billing, balance or invoice claim;
7. preserves existing test counts and historical measurements.

No source, test, schema or runtime behavior changes are authorized.

## 4. Acceptance

```bash
rg -q 'self-host' docs/evidence/FAILURE_COST_TRUTH.md
rg -q '9\\.939564' docs/evidence/FAILURE_COST_TRUTH.md
rg -q '4\\.883416' docs/evidence/FAILURE_COST_TRUTH.md
rg -q 'implement failed: exitCode=1' docs/evidence/FAILURE_COST_TRUTH.md
rg -q 'worktree' docs/evidence/FAILURE_COST_TRUTH.md
git diff --check
npm test
```

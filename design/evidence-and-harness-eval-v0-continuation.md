# EvidenceBundle and Harness Eval v0 continuation

> Status: continuation Plan; not frozen or dispatched.
>
> Reviewed continuation base:
> `12948692e130df130eab077621931e8b2f5bb776`.

## Why a continuation Plan exists

The first implementation run `0517d3ba-39f7-4b19-b9a3-bfa34caadd73` produced
two valid root drafts:

- `a026345` for the pure controller EvidenceBundle;
- `91369d4` for the Harness Eval core.

Independent review measured focused 9/9, build pass and full 473/473 for each
implementation after one known deadline-extension retry.

Both runs were nevertheless rejected by a separate outer process-cleanup race:
a sampled nested group leader PID was reused after its group disappeared. The
cleanup record had `residualCount=0` but refused to signal the old, empty
`pgid`, so the task was marked cleanup-failed.

The reviewed continuation base `1294869` contains:

- both accepted-for-review implementation drafts;
- a minimal fix that treats a reused leader plus an empty old `pgid` as clean;
- a focused regression proving a reused leader with a live old group still
  fails closed and remains untouched;
- focused 29/29, build and complete suite 483/483.

The original blocked RunManifest is not rewritten or adopted.

## Scope

This continuation implements only the remaining tasks:

```text
wave 1 (parallel)
  supervisor-evidence-integration
  harness-eval-cli-and-suite

wave 2
  harness-eval-v0-evidence
```

The EvidenceBundle core and Eval core are already present at the continuation
base and must not be reimplemented.

## Self-host provenance

The Supervisor is loaded from reviewed continuation base `1294869` while
targeting the main checkout. That is the first control-plane run in this
iteration to include the reviewed A/B drafts and the pid-reuse cleanup fix.
It is still not an accepted integration, and the original blocked run remains
historical truth.

## Non-goals

- no rewriting the earlier blocked RunManifest;
- no paid real-model quality eval;
- no LLM judge or automatic prompt optimization;
- no dynamic routing, admission or daemon;
- no OS write sandbox;
- no automatic merge or push.


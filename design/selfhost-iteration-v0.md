# Self-Host Iteration Findings v0

> Date: 2026-10-27/28
>
> Context: failure taxonomy and cost truth were implemented through cliyard's
> own Task Architect → approved Plan → queue → Claude Code + DeepSeek path.

## 1. Outcome

The queue now has six completed Plan-backed items in total. This iteration
added three of them, and its final integration branch includes the original
failure/cost slice, a post-review hardening pass, and a docs-only evidence
correction.

Measured results:

```text
failure-cost-truth-v0:       3/3 tasks accepted, 3 queue attempts
failure-cost-hardening-v0:   2/2 tasks accepted, 1 queue attempt
failure-cost-evidence-fix:   1/1 task accepted, 2 queue attempts
final independent full suite: 296/296
```

The exercise intentionally retained real budget exhaustion, worktree reuse,
verifier repair, and a human integration review instead of rewriting the
history into a single successful run.

## 2. Three practical defects

### 2.1 Budget exhaustion collapsed to exit code 1

Observed:

```text
failure-cost-durable:
  Claude budget attachment: used $9.939564 / $10, remaining $0.060436
  legacy RunManifest reason: implement failed: exitCode=1

failure-cost-docs:
  Claude budget attachment: used $4.883416 / $5, remaining $0.116584
  legacy RunManifest reason: implement failed: exitCode=1
```

Consequences:

- operator cannot distinguish budget exhaustion from a code/test failure;
- retry decisions are based on guesswork;
- duration and cost reports undercount failed work;
- the same provider result had to be investigated in local provider
  transcripts outside cliyard.

Implemented correction on the integration branch:

- structured `FailureRecord`;
- `budget_exhausted`, timeout, auth, transient, protocol, process, verifier,
  policy, resource and unknown categories;
- Claude `error_max_budget_usd` subtype preservation after review hardening;
- bounded provider detail and non-authoritative cost truth.

Status before merge: implemented and independently tested, not yet merged into
the current branch.

### 2.2 First dispatch is invisible to the queue projection

Observed on the first real queue attempt:

```text
queue item: running
queue attempts: 1
queue status run: null
active Supervisor run: 9bfa2611-858c-4fdb-859b-6f6929f81baf
```

`lastRunId` is persisted only after the Supervisor runner returns. During the
first active dispatch, an operator must switch to `supervisor status` or infer
the run from `active.json`.

Consequences:

- the promised single control view is incomplete;
- a monitor cannot reliably attach to the first live run;
- concurrent queue work would make inference from a single active pointer
  unsafe.

Status: open. The failure/cost slice improves terminal failure truth but does
not close this live-run binding gap.

Required direction:

- bind the queue item to the new run id before worker execution returns;
- prefer an explicit preallocated run id passed into Supervisor `start`;
- keep a compatibility path for the existing CLI;
- never infer a run from `active.json` when multiple runs are possible.

### 2.3 Failed attempts can retain path-outside-write-scope temp files

Observed during a docs task that exhausted its budget:

```text
docs/NEXT_STEP_CONTROLLER.md.tmp.33075.d6472a8bc100
```

The file was not an intended document. It was an editor temp artifact outside
the exact frozen `writePaths`. The worker failed before the normal verifier path
gate ran, so the attempt worktree retained the file. Human review removed that
exact file before worktree reuse.

Consequences:

- a reused dirty worktree can contain non-contract files;
- a later retry may accidentally include them without independent review;
- budget failures bypass verification that would normally report a path
  overshoot.

Status: open.

Required direction:

- run the path-scope audit for every worker exit, including non-zero exits;
- classify path overshoot in a rejected attempt while preserving the draft;
- on resume, re-audit the reused worktree before worker start;
- report unexpected temp files explicitly;
- do not auto-delete arbitrary untracked files when ownership is uncertain.

## 3. Additional observations

- Queue retries correctly reused the dirty worktree and started a new provider
  session; no accepted code was lost.
- A verifier-level test flake in the hardening task was repaired within the
  task's `maxRepairs=1` policy; the accepted branch contains the repaired test.
- The local integration workspace is the only source of complete provider
  budget observations until the new cost truth is merged; the legacy adapter
  is running its own replacement, so the new subtype path did not classify the
  real sessions that built it.
- Human review found and removed the docs-only false statement that no real
  provider session had run.

## 4. Priority

```text
P0: merge and dogfood structured failure/cost truth
P0: close first-run queue run-id binding
P0: path-scope audit on failed and reused attempts
P1: replace static task estimate numbers with telemetry-backed estimation
```

The estimation problem is specified separately in
[task-estimation-v1.md](task-estimation-v1.md).

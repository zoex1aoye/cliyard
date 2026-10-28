# Queue Manual Adoption v1 — Measured Evidence

> Date: 2026-10-28
>
> Environment: macOS (Darwin 27.0.0), Node `v20.20.2`, cliyard HEAD
> `ce1157a43ddf176f4e5aa6f62b554fc8192c34d6` (integration of
> `manual-queue-adoption` `b7f7d9e` and `deadline-fixture-stability`
> `c57d591`).
>
> Scope: the first `OperatorResolution` slice of
> [design/execution-authority-v1.md](../../design/execution-authority-v1.md),
> specified by [design/queue-adoption-v1.md](../../design/queue-adoption-v1.md).
> This evidence closure changes documentation only. Product behavior and tests
> were implemented by the two upstream slices and are not modified here.

Manual adoption closes one **blocked** queue item whose work an operator has
already reviewed and integrated by hand. It is the first formal
`OperatorResolution` path. It does not make the source run successful, does
not accept its tasks, and does not rewrite history.

## 1. Authority boundary

The source `RunManifest` remains **historical truth**. A blocked or
interrupted manifest stays blocked or interrupted after adoption; its task
states, contract identity, base commit and integration fields are unchanged.
Adoption records a **separately versioned queue resolution** in
`<repo>/.cliyard/queue.json`:

- the queue item becomes terminally `completed`;
- `QueueItem.resolution` records what an operator reviewed and why;
- `queue status` distinguishes this as `completion: "adopted"` while still
  showing the underlying run and its unaccepted tasks;
- downstream Plan materialization may use the reviewed commit only through an
  explicit adopted-lineage path.

This slice does **not** provide: parallel queue dispatch, dynamic routing or
scoring, profile activation, admission control, Windows process-tree parity,
daemon/cross-host recovery, automatic push, or automatic merge to `main`. It
does not mutate a historical blocked run.

## 2. Exact operator workflow

### 2.1 Command surface

Measured from `npx tsx src/cli.ts queue --help` on this HEAD:

```text
cliyard queue adopt <queue-id> --repo <path> --run <run-id>
                  --artifact <full-git-sha> --evidence <evidence.json>
                  --approved-by <operator> --reason <text> [--json]
```

`--json` prints the persisted `QueueItem` including `resolution`. Human output
prints `completed-by-adoption` plus the reviewed commit, pinned base, evidence
hash, approval identity and reason.

### 2.2 Preconditions checked before the queue changes

Adoption fails closed unless all of the following hold:

1. The queue item exists and is `blocked`.
2. `item.lastRunId` equals `--run`.
3. The item has a frozen contracts identity, and the contracts file still
   hashes to that identity.
4. The source `RunManifest` loads, belongs to the same repository, has the
   same run id, is still `blocked` or `interrupted`, and agrees with the item's
   contracts path and hash.
5. For a Plan-backed item, the approved Plan bytes still match the frozen Plan
   hash, the item was dispatched at least once (a materialization exists), and
   the source manifest base equals the materialized base.
6. `--artifact` is an exact full Git commit id (40 or 64 lowercase hex
   characters). Branches, `HEAD`, symbolic revisions, abbreviated ids and
   unknown objects never pass.
7. The reviewed commit is a descendant of or equal to the source manifest's
   pinned base, and an ancestor of or equal to the current `HEAD`.
8. `--evidence` is a valid v1 review-evidence file with at least one
   `exitCode: 0` command.
9. When evidence records `reviewedCommit`, it equals the resolved `--artifact`.

### 2.3 Operator procedure

1. Inspect the blocked item read-only:

   ```bash
   cliyard queue status --repo <path> [--json]
   ```

2. Review and integrate the work manually. Commit it; record the **full**
   reviewed commit id, not a branch or abbreviated id.
3. Run the checks you want recorded on that reviewed commit. Write the
   evidence JSON (section 3) with each command, its exit code and the SHA-256
   of the exact observed output. Do not put raw output in the file.
4. Adopt:

   ```bash
   cliyard queue adopt <queue-id> --repo <path> --run <run-id> \
     --artifact <full-reviewed-commit> --evidence <review-evidence.json> \
     --approved-by <operator> --reason "<why this work is accepted>" [--json]
   ```

5. Confirm the result:

   ```text
   queue item <queue-id>: completed-by-adoption (source run <run-id>)
   ...
   adoption: manual adoption of run <run-id> (blocked)
   reviewed commit: <reviewed-commit> (pinned base <base-commit>)
   evidence: <absolute-evidence-path> (sha256 <evidence-hash>)
   approved by <operator> at <approvedAt>: <reason>
   ```

6. `queue status` now reports the item as `completed (adopted)` and retains
   the blocked run inspection. `queue retry` and `queue cancel` reject the
   completed item.

Repeating an identical command is idempotent. Repeating it with any changed
resolution identity fails closed and leaves the existing resolution intact.

## 3. Review evidence v1

The evidence file is UTF-8 JSON with a strict allow-list at every level.
Unknown fields fail closed so raw logs, prompts and secrets cannot be smuggled
in beside the evidence.

```json
{
  "version": 1,
  "reviewedAt": "2026-10-28T10:00:00.000Z",
  "reviewedCommit": "<optional full reviewed commit id>",
  "commands": [
    {
      "command": "npm test -- queue",
      "exitCode": 0,
      "outputSha256": "<sha256 of the exact observed output>",
      "notes": "optional, bounded"
    }
  ],
  "notes": "optional, bounded"
}
```

Rules enforced by `parseReviewEvidence`:

- `version` must be `1`.
- `reviewedAt` must be a parseable ISO-8601 timestamp.
- `reviewedCommit`, when present, must be a full commit id and must equal the
  adopted `--artifact`.
- `commands` has at least one and at most 64 entries. Each entry requires a
  non-empty bounded `command`, an integer `exitCode` from -255 to 255, and a
  hex SHA-256 `outputSha256`. Raw output is never accepted.
- At least one command must have `exitCode: 0`.
- Text fields are rejected when they match obvious credential patterns:
  private-key blocks, `sk-` / `sk_`, `ghp_`, `github_pat_`, `AKIA`, bearer
  tokens, and `api_key` / token / password / secret assignments.

The exact bytes of the evidence file are hashed with SHA-256. Reformatting the
file changes `reviewEvidenceHash`, so idempotent re-adoption requires
byte-identical evidence.

| Field | Bound |
| --- | --- |
| Evidence file | 64 KiB (`MAX_REVIEW_EVIDENCE_BYTES`) |
| Evidence commands | 64 |
| `command` | 2,000 characters; non-empty |
| Command `notes` / top-level `notes` | 2,000 characters each |
| Evidence path | 4,096 characters |
| `approvedBy` | 128 characters |
| `reason` | 1,000 characters |
| `exitCode` | integer in -255..255 |
| Commit ids | exactly 40 or 64 hex characters |
| Hashes | 64 hex characters |

## 4. Persisted resolution and idempotency

`QueueItem.resolution` is optional and versioned:

```ts
interface OperatorResolution {
  version: 1;
  kind: "manual-adoption";
  queueItemId: string;
  sourceRunId: string;
  sourceManifestStatus: "blocked" | "interrupted";
  baseCommit: string;
  contractsHash: string;
  reviewedCommit: string;
  reviewEvidencePath: string;
  reviewEvidenceHash: string;
  approvedBy: string;
  approvedAt: string;
  reason: string;
}
```

`baseCommit` is the source manifest's pinned base; `contractsHash` is the
frozen contracts identity; `reviewEvidencePath` is the absolute path read at
adoption time; `approvedAt` is queue time when the resolution was first
created. On adoption the item becomes `completed`, its pending
`reason`/`failure` are cleared, and `attempts`, `runIds` and `lastRunId` are
preserved. Retry and cancel already reject completed items, so adoption
inherits monotonicity.

A persisted resolution is parsed fail-closed: version must be `1`, kind must
be `manual-adoption`, `queueItemId` must equal the item id, `sourceRunId` must
equal the item's `lastRunId`, `sourceManifestStatus` must be `blocked` or
`interrupted`, commit and hash shapes are exact, `approvedAt` must parse, and
the item must be `completed` for a resolution to exist.

Repeating adoption succeeds only when every resolution identity field is
byte-equivalent: version, kind, queue item id, source run id, source manifest
status, base commit, contracts hash, reviewed commit, evidence path, evidence
hash, `approvedBy` and `reason`. `approvedAt` is excluded so a retried command
does not churn the record. Any difference is rejected and the existing
resolution is left in place. Re-adoption re-validates the current queue item,
contracts, Plan, evidence, commit ancestry and source manifest; an identity
that no longer validates cannot be re-confirmed.

## 5. Dependent lineage rules

A completed-by-adoption item still satisfies its dependants, but a Plan-backed
dependant records explicit adopted lineage:

```ts
interface QueuePlanMaterialization {
  // ...existing fields
  upstreamAdoptedCommit?: string;
}
```

Base selection for a dependent whose upstream is adopted:

1. The upstream resolution must still match the upstream item: queue id,
   source run id (equal to the upstream item's run binding) and frozen
   contracts hash.
2. The resolution's `baseCommit` must be an ancestor of or equal to its
   `reviewedCommit`; otherwise materialization fails closed.
3. The source `RunManifest` integration head is usable as the base only when:
   the manifest loads, is `completed`, belongs to the repository, still agrees
   with the upstream contracts identity, its full `integrationHead` resolves
   to an exact commit, its own base is an ancestor of that head, and the head
   contains the adopted `reviewedCommit`.
4. Otherwise the adopted `reviewedCommit` is the base. A source manifest that
   remains `blocked` is deliberately not treated as a completed run.
5. The original dependency edge stays intact: materialization and artifact
   provenance record `upstreamQueueId`, `upstreamRunId`,
   `upstreamAdoptedCommit`, and `upstreamIntegrationHead` when that head was
   selected. Reuse verification requires these fields to match the resolution
   and the recorded base.

The deterministic artifact path remains
`.cliyard/queue/materialized/<id>/<base>-<planhash>.contracts.json`; the base
is the selected commit. Existing artifacts are never overwritten: a compile
that differs from recorded bytes fails closed.

## 6. Status and event examples

### 6.1 Status

The focused test drives `runQueueCli(["status", ...])` and asserts the human
labels and JSON fields below. Values in angle brackets are placeholders; the
test fixture uses a blocked source run named `run-blocked-root` with zero
tasks. The item status line continues with `next/ready/worker/attempts` fields
(elided here); the test asserts its `root  completed (adopted)` prefix.

```text
adoptions: 1 event(s), 0 malformed
root  completed (adopted)  next=none  ready=…  worker=…  attempts=…
  adoption: manual adoption of run run-blocked-root (blocked)
  reviewed commit: <40-hex-reviewed-commit> (pinned base <40-hex-base>)
  evidence: /abs/path/evidence.json (sha256 <64-hex-evidence-hash>)
  approved by operator-a at <ISO-8601>: <reason>
  run: run-blocked-root  blocked  tasks=0/0
```

The status JSON retains both the adopted completion and the untouched run:

```json
{
  "status": "completed",
  "completion": "adopted",
  "resolution": {
    "version": 1,
    "kind": "manual-adoption",
    "queueItemId": "root",
    "sourceRunId": "run-blocked-root",
    "sourceManifestStatus": "blocked",
    "baseCommit": "<sha>",
    "contractsHash": "<sha256>",
    "reviewedCommit": "<sha>",
    "reviewEvidencePath": "/abs/path/evidence.json",
    "reviewEvidenceHash": "<sha256>",
    "approvedBy": "operator-a",
    "approvedAt": "<ISO-8601>",
    "reason": "<reason>"
  },
  "run": {
    "runId": "run-blocked-root",
    "status": "blocked",
    "effectiveStatus": "blocked",
    "accepted": 0
  },
  "retryable": false,
  "observedNextAction": "none",
  "decision": { "category": "none" }
}
```

`queue.adoptionEvents` exposes the bounded adoption stream in the same status
projection. A malformed line is counted, not treated as success.

### 6.2 Event

Each successful **first** adoption appends one bounded JSON line to
`<repo>/.cliyard/queue-events/adoptions.jsonl`:

```json
{
  "version": 1,
  "eventId": "<uuid>",
  "at": "<approvedAt>",
  "type": "queue.item.adopted",
  "itemId": "root",
  "runId": "run-blocked-root",
  "status": "completed",
  "sourceManifestStatus": "blocked",
  "baseCommit": "<sha>",
  "reviewedCommit": "<sha>",
  "contractsHash": "<sha256>",
  "reviewEvidencePath": "/abs/path/evidence.json",
  "reviewEvidenceHash": "<sha256>",
  "approvedBy": "operator-a",
  "reason": "<reason>"
}
```

The stream is append-only and bounded by construction (closed fields plus the
evidence limits above). A journal write failure is observability-only and
never turns a successful adoption into a failure; `queue.json` remains
authoritative for adoption state. Review command text and output are never
written to this event.

## 7. Fail-closed behavior measured by focused tests

| Case | Result |
| --- | --- |
| Item is `pending`, `running`, `cancelled` or `completed` without a matching resolution | rejected; queue bytes unchanged |
| `--run` does not equal `item.lastRunId` | rejected; queue bytes unchanged |
| Queue item does not exist | rejected |
| Frozen contracts bytes changed | rejected as `frozen contracts changed` |
| Approved Plan bytes changed | rejected as `approved Plan changed` |
| Source manifest is not `blocked`/`interrupted`, wrong repo, wrong run id, or mismatched contracts/base | rejected before any state change |
| Plan-backed item has no materialization | rejected; never dispatched under frozen contracts |
| Evidence is invalid JSON, wrong version, or has an unknown field | rejected |
| Evidence has no successful command, non-integer exit code, or malformed digest | rejected |
| Evidence contains a credential pattern | rejected |
| Evidence has more than 64 commands or exceeds 64 KiB | rejected before parsing |
| Evidence `reviewedCommit` is abbreviated or differs from `--artifact` | rejected |
| `--artifact` is a branch, `HEAD`, abbreviated, unknown, outside `HEAD` lineage, or not a descendant of the pinned base | rejected |
| Evidence path, evidence bytes, `approvedBy` or `reason` differ on re-adoption | rejected as a different resolution identity |
| Persisted resolution is wrong-version, item-mismatched, wrong source status, malformed commit/date, or attached to a non-completed item | queue parse fails closed; document is not rewritten |
| Recorded adopted lineage is tampered after a dependent already materialized | dependent blocks before dispatch; runner calls `0`; recorded materialization unchanged |

Observability exceptions are deliberately narrow: only the adoption event
append is best-effort. All authority-bearing changes above are fail-closed.

## 8. Measured verification

All commands were run from this worktree on 2026-10-28. Durations are local
single-run test-runner values; they are not a CI, flake-rate or cost claim.

| Command | Result | Test-runner duration |
| --- | --- | --- |
| `npm run build` | exit `0` | — |
| `npx tsx --test tests/queue-adoption.test.ts` | 8/8 pass | 2539.7 ms |
| `npx tsx --test tests/deadline-extension.test.ts` | 13/13 pass | 23601.98 ms |
| `npm test` (full suite) | 371/371 pass, 0 fail | 24411.1 ms |

The full suite includes both upstream slices and all prior Supervisor, queue,
Plan-backed, read-context, failure/cost, runtime and drill groups. Before the
two slices the recorded baseline was 361/362 with the deadline fixture red.
This integration closes the fixture and adds 8 adoption tests plus 1 new
deadline test, yielding the measured 371/371. Counts were not re-run a second
time in this closure; the single local run is the evidence.

### Deadline-fixture stability

`deadline-fixture-stability` changed only
`tests/deadline-extension.test.ts`; no production deadline semantics changed.
The original 2.2-second fixture raced child startup and IO against the final
deadline. The stabilized test:

- has the child wait for a marker written by the grant callback instead of
  sleeping on a fixed schedule;
- uses a wider test policy (`baseTimeoutMs 3000`, `extensionStepMs 2000`,
  `healthyActivityWindowMs 10000`), asserting one exact grant with
  `extensionMs 2000` and `cumulativeTimeoutMs 5000`;
- adds a negative test proving that a result arriving after the extended
  deadline still loses to `timeout` (`timed out after 5000ms`).

Focused result: 13/13 pass, including the new late-result test.

## 9. Remaining gaps and next order

This slice closes manual adoption only. The execution-authority chain still
lacks, in required order:

1. **WorkerLease persisted at spawn and owner-death recovery.** The controller
   must persist exact worker identity as soon as it exists, not after
   `collect()`; a new controller must verify identity before terminating an
   owned group, preserve the worktree and evidence, and return `needs_human`
   for ambiguous identity. This is the safety prerequisite for any parallel
   execution.
2. **Profile catalog and real binding activation.** A secret-free
   `ProfileCatalog`, endpoint/account activation result and deterministic
   hard filtering must exist before routing can claim a real profile switch.
3. **Per-run Supervisor ownership plus short control-store locks.**
4. **Fixed hierarchical admission** across queue items and Plan ready waves,
   with conjunctive limits and unknown-capacity probes starting at one.
5. **Windows Job Object `ProcessOwnerProvider`.**
6. **Telemetry-backed dynamic routing/scoring**, only after profile activation,
   fixed admission and measured telemetry exist.

Manual adoption does not create a `WorkerLease`, does not activate a profile,
does not admit parallel work, and does not make Windows or dynamic scoring
ready.

## 10. Files changed

Upstream `manual-queue-adoption` (`b7f7d9e`):
`design/queue-adoption-v1.md`, `src/orchestration/cli.ts`,
`src/orchestration/control-snapshot.ts`,
`src/orchestration/queue-runner.ts`, `src/orchestration/queue-store.ts` and
`tests/queue-adoption.test.ts`.

Upstream `deadline-fixture-stability` (`c57d591`):
`tests/deadline-extension.test.ts` only.

This documentation closure changes only:
`docs/evidence/QUEUE_ADOPTION.md`, `README.md`,
`docs/NEXT_ITERATION.md` and `docs/NEXT_STEP_CONTROLLER.md`.

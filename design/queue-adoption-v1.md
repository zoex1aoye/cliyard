# Queue manual adoption v1

Status: slice of `design/execution-authority-v1.md`.

Manual adoption is the first formal `OperatorResolution` path. It closes one
blocked queue item whose work an operator has already reviewed and integrated
by hand. It never mutates a `RunManifest`, never marks rejected tasks accepted,
and never rewrites history.

## Command

```
cliyard queue adopt <queue-id> --repo <path> --run <run-id> \
  --artifact <full-git-sha> --evidence <review-evidence.json> \
  --approved-by <operator> --reason <text> [--json]
```

`--json` prints the persisted `QueueItem` including its resolution. Human
output reports `completed-by-adoption` and shows the reviewed commit, pinned
base, evidence hash and approval reason. `queue status` additionally reports
`completion: "adopted"` and retains the underlying run inspection and its
unaccepted tasks.

## Preconditions

Adoption fails closed unless all of the following hold:

1. The queue item exists and is `blocked`.
2. `item.lastRunId` equals `--run`.
3. The item has a frozen contracts identity and the contracts file still
   hashes to it.
4. The source `RunManifest` loads, belongs to the same repository, has the same
   run id, still has status `blocked` or `interrupted`, and agrees with the
   item's contracts path and hash.
5. For a Plan-backed item, the approved Plan bytes still match the frozen Plan
   hash, the item was dispatched at least once (materialization is recorded),
   and the source manifest base equals the materialized base.
6. `--artifact` is a full git commit id (40 or 64 lowercase hex characters).
   Git must resolve it to that exact commit. Branch names, `HEAD`, symbolic
   revisions and abbreviated ids never pass.
7. The reviewed commit must be a descendant of or equal to the source
   manifest's pinned base, and an ancestor of or equal to the current `HEAD`.
8. Review evidence is valid under the schema below and contains at least one
   command with `exitCode: 0`.
9. When the evidence records `reviewedCommit`, it must equal the resolved
   `--artifact`.

The source manifest is validated and then left untouched. Its status remains
`blocked`/`interrupted`; the queue records the resolution separately. Task
acceptance in the run is unchanged.

## Review evidence v1

The evidence file is UTF-8 JSON with a strict allow-list at every level.
Unknown fields fail closed so raw logs, prompts and secrets cannot be smuggled
in next to the evidence.

```json
{
  "version": 1,
  "reviewedAt": "2026-10-28T10:00:00.000Z",
  "reviewedCommit": "<optional full commit id>",
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

* `version` must be `1`.
* `reviewedAt` must be a parseable ISO-8601 timestamp.
* `reviewedCommit`, when present, must be a full commit id and must equal the
  adopted artifact.
* `commands` has at least one and at most 64 entries. Each entry requires a
  non-empty bounded `command`, an integer `exitCode` from -255 to 255, and a
  hex SHA-256 `outputSha256`. Output itself is never accepted.
* At least one command must have `exitCode: 0`.
* Text fields are rejected when they match obvious credential patterns
  (private-key blocks, `sk-`/`sk_`, `ghp_`, `github_pat_`, `AKIA`, bearer
  tokens, and `api_key`/`token`/`password`/`secret` assignments).

The exact bytes of the evidence file are hashed with SHA-256. Reformatting the
file changes the recorded `reviewEvidenceHash`.

### Limits

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

## Persisted resolution

`QueueItem.resolution` is optional and versioned. A resolved item must be
`completed`, and its resolution must be item-bound.

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
created. The queue item becomes `completed`, its pending `reason`/`failure`
are cleared, and attempts and run ids are preserved. Retry and cancel already
reject completed items, so adoption inherits the existing monotonicity.

### Idempotency

Repeating the command succeeds only when every resolution identity field is
byte-equivalent: version, kind, queue item id, source run id, source manifest
status, base commit, contracts hash, reviewed commit, evidence path, evidence
hash, `approvedBy` and `reason`. `approvedAt` is excluded so a retried command
does not churn the record. Any difference is rejected and the existing
resolution is left in place. Re-adoption re-validates the current queue item,
contracts, Plan, evidence, commit ancestry and source manifest; an identity that
no longer validates cannot be re-confirmed.

## Event

Each successful first adoption appends exactly one bounded
`queue.item.adopted` JSON line to the unified queue journal:

```text
<repo>/.cliyard/queue-events/events.jsonl
```

There is no second adoption stream and no `adoptions.jsonl` writer or reader.

```json
{
  "version": 1,
  "eventId": "<uuid>",
  "at": "<approvedAt>",
  "type": "queue.item.adopted",
  "itemId": "build",
  "runId": "run-123",
  "status": "completed",
  "sourceManifestStatus": "blocked",
  "baseCommit": "<sha>",
  "reviewedCommit": "<sha>",
  "contractsHash": "<sha256>",
  "reviewEvidencePath": "/abs/evidence.json",
  "reviewEvidenceHash": "<sha256>",
  "approvedBy": "operator",
  "reason": "reviewed and integrated"
}
```

The event is append-only and bounded by construction. In addition to the
common queue-event fields, `queue.item.adopted` requires the complete set
above: `itemId`, `runId`, `status: "completed"`, `sourceManifestStatus`
(`blocked` or `interrupted`), `baseCommit`, `reviewedCommit`, `contractsHash`,
`reviewEvidencePath`, `reviewEvidenceHash`, `approvedBy` and `reason`.

Event-specific validation:

* every adoption field is required; a missing field is rejected on append and
  makes an existing line malformed on read;
* adoption-only fields (`sourceManifestStatus`, `baseCommit`, `reviewedCommit`,
  `contractsHash`, `reviewEvidencePath`, `reviewEvidenceHash`, `approvedBy`)
  are rejected on every other event type, both when appending and when
  reading;
* `baseCommit` and `reviewedCommit` are full Git object ids (40 or 64 hex
  characters); `contractsHash` and `reviewEvidenceHash` are hex SHA-256
  digests (64 hex characters);
* `itemId` and `runId` are at most 128 characters, `approvedBy` at most 128,
  `reason` at most 1,000 and `reviewEvidencePath` at most 4,096; text fields
  are non-empty and use the same obvious-credential rejection as
  `OperatorResolution`;
* an oversized or secret-bearing value is rejected rather than silently
  truncated; malformed, incomplete or misplaced lines are counted as journal
  malformed lines and never appear as adoption observations.

A journal write failure is observability-only and never turns a successful
adoption into a failure; the resolution in `queue.json` remains authoritative
for adoption state. Queue status exposes `queue.adoptionEvents` (JSON) by
filtering the unified journal for `queue.item.adopted` and prints an
`adoptions:` summary line. The projection scans the full valid record set
before applying its bounded display window, so unrelated recent events cannot
hide adoption observations; malformed-line counts remain visible.

## Dependent semantics

An adopted item still satisfies its dependants as `completed`, but a
Plan-backed dependant records explicit adopted lineage in its materialization:

```ts
interface QueuePlanMaterialization {
  // ...existing fields
  upstreamAdoptedCommit?: string;
}
```

Selection for a dependent whose upstream is adopted:

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
4. Otherwise the adopted `reviewedCommit` is the base.
5. The original dependency edge stays intact: the materialization records
   `upstreamQueueId`, `upstreamRunId`, `upstreamAdoptedCommit`, and
   `upstreamIntegrationHead` whenever that head was selected. The artifact
   provenance embeds the same fields, and reuse verification requires them to
   match the resolution and the recorded base.

The deterministic artifact path remains
`.cliyard/queue/materialized/<id>/<base>-<planhash>.contracts.json`; the base is
the selected commit. Existing artifacts are never overwritten: a compile that
differs from recorded bytes fails closed.

## Non-goals

* No `RunManifest` mutation, no task acceptance changes, no status rewrite.
* No adoption of pending, running, cancelled, completed or unknown items.
* No abbreviated commits, branches or symbolic refs.
* No raw logs, prompts, secrets or unbounded output in evidence.
* No parallel dispatch, dynamic routing, daemon or push behavior.

WorkerLease persisted at spawn plus controller owner-death recovery remains
the next implementation slice; adoption does not provide either.

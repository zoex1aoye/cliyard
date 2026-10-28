# Adoption Journal Unification v1

> Recorded: 2026-10-28
>
> Status: required cleanup before WorkerLease implementation

## 1. Problem

`queue adopt` currently records its durable `OperatorResolution` in
`queue.json`, but appends observability events to a second
`.cliyard/queue-events/adoptions.jsonl` stream because the initial slice could
not modify the closed queue-event registry.

That creates two queue log locations and makes future monitoring, retention,
malformed-line accounting and Control API event streaming depend on an
unnecessary special case.

## 2. Decision

There is one queue journal:

```text
<repo>/.cliyard/queue-events/events.jsonl
```

New adoption events use:

```text
queue.item.adopted
```

The event is bounded and observational. `queue.json` remains the authority for
`OperatorResolution`; a failed journal append must not turn a successful,
already-persisted adoption into an ambiguous command result.

## 3. Event contract

In addition to the common queue-event fields, `queue.item.adopted` requires:

```ts
interface QueueAdoptionEventFields {
  itemId: string;
  runId: string;
  status: "completed";
  sourceManifestStatus: "blocked" | "interrupted";
  baseCommit: string;
  reviewedCommit: string;
  contractsHash: string;
  reviewEvidencePath: string;
  reviewEvidenceHash: string;
  approvedBy: string;
  reason: string;
}
```

Validation rules:

- all fields are required for `queue.item.adopted`;
- adoption-only fields are rejected on unrelated event types;
- commit ids are full Git object ids;
- hashes are SHA-256 values;
- approved-by, reason and evidence path use the same bounds as
  `OperatorResolution`;
- raw logs, prompts or secrets remain forbidden;
- malformed records stay observable as journal malformed-line counts and never
  grant acceptance.

## 4. Status projection

`queue status` keeps the convenient `queue.adoptionEvents` projection, but it
is derived by filtering the unified journal:

```text
events.jsonl
  -> validate QueueControlEvent
  -> filter queue.item.adopted
  -> bounded adoption summary
```

The projection must not read `adoptions.jsonl` after this migration. There is
no second adoption truth.

## 5. Compatibility

The feature is local and has no measured production adoption records. This
cleanup removes the dedicated writer and reader rather than preserving an
unnecessary compatibility protocol.

Existing queue records containing `OperatorResolution` remain valid. Only the
observability stream moves.

## 6. Acceptance

1. New adoption appends exactly one `queue.item.adopted` record to
   `events.jsonl`.
2. No new `adoptions.jsonl` is created.
3. `queue status.adoptionEvents` and human output derive from the unified
   journal.
4. Adoption-only fields fail closed when malformed or attached to another
   event type.
5. Existing queue journal readers and all queue/adoption tests remain green.
6. Full build and test suite pass after integration.

## 7. Non-goals

- no change to `OperatorResolution` semantics;
- no adoption of a historical blocked item;
- no WorkerLease, profile activation or admission;
- no log rotation or retention policy;
- no raw verification output in the journal;
- no daemon or Control API in this slice.

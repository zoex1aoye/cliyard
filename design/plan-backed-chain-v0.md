# Plan-backed Chained Queue Base v0

> Revision: plan-backed-chain-v0
>
> Scope: one linear code dependency between explicitly approved queue items

## Current gap

Foreground queue v0 orders dispatch and propagates failure, but every item
uses its own already-frozen contracts and `baseCommit`. Therefore:

```text
item A accepted at integration head HA
item B still starts from B's old baseCommit
item B cannot see A's accepted code
```

This is dispatch dependency, not code dependency. It cannot support the
foundational sequence requested by the product:

```text
foundation accepted
  -> upper layer planned against the foundation
  -> upper layer accepted on top of it
```

## Goal

Add a v0 Plan-backed queue item that materializes fresh frozen contracts from
an explicitly approved Plan immediately before dispatch:

```text
approved Plan P
  + queue dependency A (completed)
  + A's RunManifest.integrationHead HA
  -> deterministic compilePlan(P, baseCommit=HA)
  -> queue-owned contracts artifact
  -> Supervisor start
  -> B accepted on a branch containing A and B
```

The Plan remains human authority. Queue materialization is deterministic
contract compilation, not automatic Plan generation or approval.

## Source model

Existing contract-backed items keep their current behavior and fields. A new
Plan-backed item records:

```ts
interface QueuePlanMaterialization {
  // Approved Plan identity.
  planPath: string;
  planHash: string;
  planId: string;

  // Base selected by deterministic queue lineage.
  baseCommit: string;
  upstreamQueueId?: string;
  upstreamRunId?: string;
  upstreamIntegrationHead?: string;

  // Generated contracts selected for this exact attempt chain.
  contractsPath: string;
  contractsHash: string;
  materializedAt: string;
}
```

The queue item retains its common worker/model/status/attempt/dependency
fields. `queue add-plan` snapshots the approved Plan path and SHA-256 at
mutation time. Changing the Plan file blocks dispatch until the operator
explicitly replaces the queue item or removes its queue state.

The initial root base for a Plan-backed item with no queue dependency is the
repository HEAD captured by `queue add-plan`. It is persisted so later
unrelated branch movement cannot silently change that item's base.

## Commands

```bash
cliyard queue add-plan <plan.json> --repo <path> --id <queue-id> \
  [--depends-on <upstream-queue-id>] \
  [--worker claude|codex] [--model <id>] [--max-attempts <n>] [--json]
```

`queue list`, `retry`, `cancel` and `run` apply to both source kinds. Human and
JSON output must identify the Plan hash, materialized base, upstream lineage,
generated contracts path and contracts hash.

Existing `queue add <contracts.json>` remains byte-for-byte frozen and
backward compatible.

## Dependency rule

Plan-backed queue items may have zero or one queue-level dependency in v0.

- Zero: compile at the initial HEAD captured by `queue add-plan`.
- One: wait for that item to complete, load its last RunManifest, and compile
  at that manifest's `integrationHead`.
- More than one: reject at `queue add-plan`; multi-parent integration belongs
  to a later integration-envelope/merge-queue design.

Contract-backed items retain the existing multi-dependency dispatch graph.
A Plan-backed item may depend on either source kind. In both cases the
dependency's RunManifest is the base evidence.

No item may infer a base from the active repository HEAD, the active run
pointer, a similarly named branch, or a worker commit that has not been
accepted into a completed RunManifest.

## Materialization

Before an attempt can dispatch:

1. Verify the approved Plan file still matches its frozen SHA-256.
2. Parse and validate the Plan with the existing `compilePlan`.
3. Verify the Plan id matches the queue item.
4. For a dependent item, require exactly one completed upstream with a
   readable RunManifest, matching run id, contracts identity and a resolvable
   `integrationHead`.
5. Compile every Plan task at that exact base.
6. Atomically write a queue-owned contracts artifact under:

   ```text
   <repo>/.cliyard/queue/materialized/<queue-id>/<base>-<plan-hash>.contracts.json
   ```

7. Hash the exact artifact bytes and persist the materialization metadata
   before starting Supervisor.

The generated contracts artifact includes provenance in addition to the
existing `{ planId, contracts }` fields. The queue stores the generated
contracts hash separately; the Supervisor and RunManifest continue to freeze
and verify the exact bytes.

Materialization is idempotent for the same Plan hash and base. A retry of an
already-started run must keep the RunManifest's exact contracts and base. It
must not rematerialize contracts under a live or resumable run.

## Failure semantics

Materialization fails closed and blocks the queue item before any Supervisor
start or attempt increment when:

- the approved Plan is missing, changed or invalid;
- its Plan id does not match the queue item;
- dependencies are incomplete, blocked, cancelled or more than one;
- the upstream item has no completed run id;
- the upstream RunManifest is missing, not completed, belongs to different
  frozen contracts, or has no resolvable integration head;
- the materialized artifact is missing or changed after being recorded;
- the Plan or base lineage cannot be proven exactly.

Once a run id exists, queue retry resumes that exact RunManifest and contracts.
It never silently swaps in newly compiled contracts. A different Plan or base
requires a new queue item and a new Supervisor run.

## Example

```text
queue item foundation
  source: Plan foundation.plan.json
  dependency: none
  base: repository HEAD H0
  run: RA
  integrationHead: HA

queue item upper-layer
  source: Plan upper-layer.plan.json
  dependency: foundation
  base: HA
  materialized contracts: compiled at HA
  run: RB
  integrationHead: HB (contains HA and RB)
```

The worker worktree for `upper-layer` must contain every accepted change from
`foundation`. Its integration branch must retain `HA` as an ancestor and add
only the upper-layer task commits plus the integration merge.

## Non-goals

- No automatic Plan generation or approval.
- No automatic merge or push to the repository's main branch.
- No multi-parent integration, merge queue, conflict resolver or speculative
  rebase.
- No parallel queue dispatch.
- No daemon, scheduler loop, retry timer or 24-hour availability claim.
- No cross-host queue or remote worker execution.
- No mutation of an existing RunManifest after it is created.
- No provider-session continuation.
- No SQLite or state-store migration.

## Acceptance

1. `queue add-plan` rejects unsafe ids, unknown/cyclic dependencies, malformed
   Plans, Plan-id mismatches and more than one queue dependency.
2. A root Plan-backed item materializes at the captured HEAD and completes
   through the existing Supervisor path.
3. A dependent Plan-backed item materializes only after its upstream item is
   completed, using the upstream RunManifest `integrationHead`.
4. The dependent worker's worktree contains the upstream accepted file or
   commit.
5. The dependent integration branch includes upstream and downstream work:
   upstream `integrationHead` is an ancestor of downstream
   `integrationHead`.
6. A blocked, cancelled, missing, interrupted or ambiguous upstream never
   yields a synthesized base or a dispatch attempt.
7. A changed approved Plan fails closed before Supervisor start.
8. A recorded materialization remains byte-identical while retrying the same
   run; a changed Plan cannot be substituted into that run.
9. Existing contract-backed queue behavior and all prior tests remain green.
10. A real chain smoke through Claude Code + DeepSeek proves the downstream
    worktree sees the upstream accepted artifact and the integration ancestry
    is correct.

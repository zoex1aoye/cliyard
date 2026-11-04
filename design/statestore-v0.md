# StateStore v0: SQLite event-sourced foundation

> Draft 2026-11-04. Not frozen, not dispatched. Scope needs design confirmation.

## Purpose

Introduce the SQLite event-sourced StateStore behind one interface, with a
read-only projection that proves parity against the existing JSON truth, so
observability and recovery stop depending on `ledger.json` / `queue.json` /
`runs/*.json`. This is P1 of [ROADMAP.md](../docs/ROADMAP.md).

## Borrowed discipline

From Agent Autoloop's kernel (reviewed 2026-11-04): append-only facts log and
projection commit in one transaction; optimistic concurrency by sequence;
rebuild from the log on format change instead of migration scripts; clock and
randomness injected at the host boundary so the kernel stays deterministic.
Large evidence stays in content-addressed files, never in the facts log.

## Scope (draft)

1. `statestore-core`: the SQLite facts log + projection + rebuild + conflict
   detection, with ExecutionHandle/RuntimeHandle-shaped rows. No consumer yet.
2. `statestore-read`: seed the store from the current JSON truth on startup and
   expose `status --json` / `events` backed by the projection, verified against
   the existing control-snapshot output for parity.

## Explicitly deferred

- JSON write-path migration (single-writer cutover to SQLite): P1b, only after
  read parity is proven.
- `cliyardd` daemon and HTTP Control API: P2.
- Sandbox, background verifier, clean reviewer, routing: P3/P4.

## Decisions (2026-11-04)

- **SQLite driver**: a minimal `StateStoreDriver` interface, default
  `better-sqlite3` (synchronous, file-backed, WAL, fsync-durable) for Node 20.
  No `node:sqlite` requirement: it is unavailable on Node 20 and would force
  Node 22+. A future `node:sqlite` implementation can replace the default
  without touching consumers, which is what keeps the Node coupling weak.
- **status/events surface in P1**: CLI only (`status --json`, `events`),
  read-only. The HTTP Control API belongs to P2, owned by `cliyardd`; P1 must
  not introduce a half-owned server process.
- **Parity gate**: semantic equivalence as the acceptance criterion
  (canonicalized deep-equal with an explicit float tolerance); byte-identical
  comparison is available only as an optional diagnostic, never the gate.

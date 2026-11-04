# Daemon + Control API v0 (P2a) — draft

> Draft 2026-11-04. Not frozen, not dispatched.

## Purpose

Introduce `cliyardd`, a long-running Node 20 process that owns the StateStore
and serves a versioned, read-only Control API. This is the observability and
state-ownership foundation for the human-machine interface (P5) and for the
ExecutionSupervisor (P2b).

The foreground Supervisor keeps dispatching for now; `cliyardd` does not yet
own actions. P2b moves execution-unit lifecycle and authenticated actions into
the daemon.

## Decisions

- HTTP: Node built-in `node:http`, no framework dependency.
- Bind: `127.0.0.1` TCP with an ephemeral/leased port, not a fixed port.
- API shape, versioned and read-only in this slice:
  - `GET /v1/status` — authoritative snapshot with an opaque version token;
  - `GET /v1/events` — NDJSON with a replay cursor (`?after=`), bounded;
  - `GET /v1/runs/:runId` — one run's manifest + evidence reference.
- Auth: none in P2a; localhost-only. Authenticated actions come in P2b/P3.
- Single-instance: a store-backed lease prevents two daemons owning one repo.

## Risks

- Two processes (foreground Supervisor + daemon) can touch the same SQLite
  file. Mitigate with WAL and the existing optimistic sequence check; the
  daemon must not hold a write transaction while idle.
- Read-only API must never mutate state or change acceptance; it reads the
  StateStore projection and the existing control snapshot only.

## Non-goals (P2b and later)

- ExecutionSupervisor and RuntimeHandle authority (P2b).
- `execution.continuity` contract field (P2b).
- Authenticated write/action endpoints.
- SSE; NDJSON replay first.
- Sandbox, routing, background verifier.

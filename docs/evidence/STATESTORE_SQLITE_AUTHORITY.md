# StateStore SQLite authority — evidence

> Measured 2026-11-06 (Asia/Shanghai) on Linux 6.12.113+ x86_64,
> Node `v22.23.4`, npm `10.9.9`, host cloud-agent VM.
>
> Branch: `cursor/statestore-sqlite-authority-0da8`.
> Plan: `design/statestore-sqlite-authority-v0.plan.json`.
> Dependency: `better-sqlite3@11.10.0` declared in `package.json`.
>
> This document records observed behavior only. It does not accept, merge or
> authorize pilot use.

## 1. Why this measurement existed

StateStore v0 and the P1b write cutover were already on mainline, but
`better-sqlite3` was never declared. Production opens fell back to the
JSON-file driver; the three SQLite tests in `tests/statestore.test.ts` were
skipped. After installing the native module, queue/read fixtures failed on a
fresh repo because `createBetterSqlite3Driver` opened `.cliyard/state.db`
without creating `.cliyard/`.

## 2. Code under test

- `package.json` / `package-lock.json`: `better-sqlite3` as a runtime dependency.
- `src/statestore/store.ts` (`createBetterSqlite3Driver`): `mkdirSync(dirname(path),
  { recursive: true, mode: 0o700 })` before `new Database(...)` for non-memory
  paths. `:memory:` unchanged. `StateStoreDriverUnavailableError` fallback when
  the native module is missing remains.

## 3. Commands and results

```bash
node -e "require('better-sqlite3'); console.log('ok')"
# → ok

npx tsx --test \
  tests/statestore.test.ts \
  tests/statestore-read.test.ts \
  tests/statestore-write.test.ts
# → tests 32 / pass 31 / fail 0 / skipped 1
```

The single skip is intentional:
`file driver reports a typed unavailable error without better-sqlite3`
(`# SKIP better-sqlite3 is installed`).

Exercised SQLite cases that previously skipped now pass, including:

- `driver swapability: default better-sqlite3 file driver`
- `better-sqlite3 persists facts and projection across connections with WAL`
- `openFileStateStore is the default durable entry point`

`npm run build` exits `0`.

## 4. Authority statement (scoped)

When `better-sqlite3` is installed:

- Opening a file-backed StateStore through `openFileStateStore` /
  `createBetterSqlite3Driver` creates the parent directory and uses WAL +
  `synchronous=FULL`.
- Supervisor / queue / daemon paths that prefer SQLite can select the native
  driver instead of the JSON-file fallback.

When the native module is missing, the typed unavailable error and JSON-file
fallback behavior are unchanged.

## 5. Non-claims

- Does **not** claim ledger or event-journal production writers are attached
  (attach APIs exist; entrypoints may still write JSON directly).
- Does **not** delete legacy JSON exports or rewrite historical RunManifests.
- Does **not** claim daemon owns dispatch, OS sandboxing, launchd parity, or
  supervised-pilot readiness.
- Does **not** replace [STATESTORE_WRITE_CUTOVER.md](./STATESTORE_WRITE_CUTOVER.md);
  that document remains the P1b cutover measurement (JSON-file backend at the
  time).

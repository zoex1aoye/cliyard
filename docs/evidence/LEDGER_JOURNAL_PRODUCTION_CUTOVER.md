# Ledger + event-journal production cutover — evidence

> Measured 2026-11-06 (Asia/Shanghai) on Linux 6.12.113+ x86_64,
> Node `v22.23.4`, `better-sqlite3@11.10.0`.
>
> Branch: `cursor/ledger-journal-cutover-0da8`.
> Plan: `design/ledger-journal-production-cutover-v0.plan.json`.
>
> Observational only. Does not authorize pilot use.

## 1. What changed

- `src/orchestration/control-domain-cutover.ts` — process-scoped open of
  `.cliyard/state.db`, `ensureLedgerJournalCutoverSync`, hook registration into
  queue-store, `resetControlDomainCutover` for tests.
- `attachQueueEventStateStoreWithMigrate` — sync journal attach seam.
- Production entry: `updateLedger` (repo-shaped paths), `queue-runner` /
  `mutateQueueDocument` / `saveQueue` via registered hook, queue CLI side-effect
  import of the cutover module.

## 2. Commands

```bash
npm run build   # exit 0
npx tsx --test tests/ledger-lock.test.ts tests/statestore-write.test.ts
# → tests 16 / pass 16 / fail 0
```

Includes
`production ensure imports once; later writes leave legacy JSON untouched`.

## 3. Authority statement (scoped)

After `ensureLedgerJournalCutoverSync(repoRoot)` (or any path that loads the
cutover module so the queue-store hook is registered):

- `updateLedger` / `saveLedger` for `<repo>/.cliyard/ledger.json` append
  StateStore facts; legacy ledger bytes stay at the imported snapshot.
- `appendQueueEvent` / `tryAppendQueueEvent` append StateStore facts; legacy
  `events.jsonl` bytes stay at the imported snapshot.
- Legacy drift still fails closed (`StateStoreLegacyDriftError`, `needsHuman`).

## 4. Non-claims

- Does not unify supervisor `.cliyard/runtime/statestore` with queue `state.db`.
- Does not delete legacy JSON.
- Non-repo fixture ledger paths (unit tests) still use the JSON writer.
- Does not claim OS sandbox, daemon-owned dispatch, or supervised pilot readiness.

# StateStore write cutover — evidence

> Measured 2026-11-04 on macOS 27.0 (Darwin 27.0.0, arm64), Node `v20.20.2`,
> npm `10.8.2`, Git `2.54.0 (Apple Git-157)`, host
> `paofujianlaide-MacBook.local`. Times below are UTC unless noted.
>
> Run: `78348b45-ed71-4433-b512-63b3683ca93b`
> (`statestore-write-migration-v0`, status `running` at measurement time).
> Integration head: `8001c2e783a078e225e93d98ba75bb09f7e14dac`.
> Run base: `4f7672c94e3d9042a649a7bd4d7af160bd726404`.
> Frozen contracts SHA-256:
> `9cb2f0b6f668bbd1add5c8b2e64bbc39ccde649dfddba03bbfb06492e9f0ba61`
> (matches the value recorded in the run manifest).
>
> This document records observed behavior only. It does not accept, merge or
> push the integration candidate, and it does not authorize pilot use.

## 0. What this document is and is not

- It is the measured closeout for the four accepted cutover tasks: migration
  hashes, path audits, process cleanup, a complete two-task iteration driven
  through the cut-over supervisor entrypoint, read-projection parity,
  resume-after-restart, and JSON drift handling.
- It is **not** a claim that a provider-backed self-host iteration ran on the
  new code. The controller that produced this run was launched from the main
  checkout (`/Users/x1aoye/Documents/pers-project/cliyard`, PID `24499`, cwd
  confirmed by `lsof`) at `7f6c061`, which predates every cutover commit. None
  of `560dd73`, `982132f`, `947e488` or `a4a0b5e` is an ancestor of `7f6c061`.
  All write-path evidence below comes from fresh processes importing the code
  at integration head `8001c2e`; the real run's orchestration did not load it.
- It is **not** a claim that SQLite was exercised. `better-sqlite3` is not
  installed in this workspace, so the measured StateStore backend is its
  `json-file` fallback and the three SQLite tests are skipped. No
  `state.sqlite` or `state.db` file was created anywhere in these measurements.
- It is **not** a claim that the ledger and event journal are cut over. Their
  attachment APIs exist and are tested, but no production entrypoint calls
  them (§8).
- It is **not** a claim that the JSON stores are deleted. They remain in place
  as derived exports where cut over, and as write targets where not.
- It is **not** a claim of daemon operation, sandboxing or 24-hour behavior.

## 1. Result in one paragraph

The four cutover tasks are accepted and merged into integration head
`8001c2e`; every path audit recorded `outsideWritePaths: []`, every recorded
process cleanup ended with `residualCount: 0`, and every WorkspaceBoundary
record was `clean` (guard-only). The real repository's legacy state was
imported in-memory from the new code and produced stable content/import hashes
under two different marker clocks: 39 runs (`7c16829a…`), 14 queue items
(`26f2ed62…`), 56 ledger tasks (`0009aca8…`) and 188 audit events
(`9f0c5e76…`). A scratch repository seeded with pre-cutover JSON was driven
through `supervisor start` in one process and `supervisor resume` in a fresh
process: the first process imported the legacy run once
(`importHash 958b298f…`), accepted `foundation` and was interrupted before
`upper`; the second process dispatched only `upper`, preserved the accepted
commit, and completed the run at integration head `4538e2ef…`. The read
projection compared semantically equal to the control snapshot (`equal: true`,
`byteIdentical: false`, `differences: 0`) and wrote no JSON file. Tampering
either the run export or the queue export failed closed with
`StateStoreLegacyDriftError` (`statestore.write.legacy_drift`,
`needsHuman: true`), appended no fact, and preserved the tampered bytes; restoring
the export allowed the next write. The full test inventory was 588/593 pass,
2 fail and 3 skip; one failure is a deterministic queue legacy-drift test, one
is a timing flake that passes alone. The contract verify commands passed
(29/32 focused with 3 SQLite skips; `npm run build` clean).

**Authority statement (scoped to the measured cutovers).** For supervisor run
manifests and the queue document, the StateStore is now the single write
authority and `.cliyard/runs/*.json` and `.cliyard/queue.json` are read-only,
derived legacy exports. In the intended deployment that authority is SQLite; in
this environment the measured durable authority was the StateStore's atomic
JSON-file fallback because `better-sqlite3` is absent. The same statement is
**not** true for the ledger or the event journal: no production path attaches
their StateStore bindings, so those JSON files are still written directly.
A blanket claim that SQLite is now the write authority for the whole control
plane is not supported by these measurements.

## 2. Lineage and exact identities

| Fact | Value |
| --- | --- |
| Plan | `statestore-write-migration-v0` |
| Contracts file | `design/statestore-write-migration-v0.contracts.json` |
| Contracts SHA-256 | `9cb2f0b6f668bbd1add5c8b2e64bbc39ccde649dfddba03bbfb06492e9f0ba61` |
| Run manifest `contractsHash` | `9cb2f0b6f668bbd1add5c8b2e64bbc39ccde649dfddba03bbfb06492e9f0ba61` (matches) |
| Run base commit | `4f7672c94e3d9042a649a7bd4d7af160bd726404` |
| Integration branch | `cliyard/integration/78348b45-ed71-4433-b512-63b3683ca93b` |
| Integration head | `8001c2e783a078e225e93d98ba75bb09f7e14dac` |
| Run status at measurement | `running` |
| Run owner | PID `24499`, host `paofujianlaide-MacBook.local` |
| Controller provenance | main checkout `7f6c061`, predates all cutover commits |

Accepted task commits, recorded path audits and the commit diffs (checked with
`git show --name-only`) agree:

| Task | Result commit | Changed paths | Outside write paths |
| --- | --- | --- | --- |
| `statestore-write-api` | `560dd737e2ebd2cf4d5787b09664130451ccc1f2` | `src/statestore/migrate.ts`, `src/statestore/write.ts`, `tests/statestore-write.test.ts` | `[]` |
| `supervisor-write-cutover` | `982132fa24f87bf29cfa837f197521eb16bd3927` | `src/supervisor/store.ts`, `tests/supervisor-resume.test.ts`, `tests/supervisor-store.test.ts` | `[]` |
| `queue-write-cutover` | `947e48806d36f027851889cd640a85b7bd7943d5` | `src/orchestration/queue-store.ts`, `tests/orchestration-queue.test.ts` | `[]` |
| `ledger-event-cutover` | `a4a0b5e63d2bd576785b4b59e3ba2b64ef8d275c` | `src/orchestration/event-journal.ts`, `src/persistence/ledger.ts`, `tests/ledger-lock.test.ts` | `[]` |

Every commit is an ancestor of integration head `8001c2e` (verified with
`git merge-base --is-ancestor`). The integration head is the merge of the four
task branches. This evidence worktree is at `8001c2e` with only `node_modules`
untracked before this document was written.

## 3. Legacy import hashes — real repository

Method: a scratch, uncommitted script imported the new modules from integration
head `8001c2e`, opened an in-memory StateStore
(`StateStore.open(createMemoryStateStoreDriver())`), and ran
`migrateLegacyJson` once per domain against the real repository root. Nothing
was written to the repository; these are hypothetical import hashes for the
current bytes, not an applied migration. The real repository still has no
`.cliyard/runtime/statestore`, `.cliyard/state.db`, `.cliyard/state-fallback`,
`.cliyard/queue.export-meta.json` or `.cliyard/state-evidence` (checked after
measurement).

| Domain | Imported records | Sources | `sourceHash` | `contentHash` | `importHash` |
| --- | --- | --- | --- | --- | --- |
| run | 39 runs | 40 | `5b4d820ca6eff002aaabf1177ff0e2af63f74300c61d50bb77e74b73a8815d75` | `bf2ca6950ffebfbe39ffc5b15590ba8f81c6c7d99591d703d3c871ef0cfa5c74` | `7c16829a90d0e8813246ca142c86f24bd2dd470a8c97c6761b955bfddad5ca82` |
| queue | 14 items | 1 | `16efa1347bc8fbd4833525eaff2a354345bafebc1b0b96460c6805bef5d4c2dc` | `5e2adcfdb82fa1cb092a5790ceaa0e7e5089f71a55096efaaf50b568410009d1` | `26f2ed6265e1b198b5904be6b788de79c576c1c00fbd1e8d5375b2f8222ea74e` |
| ledger | 56 tasks | 1 | `6210f38034ec6b36fb166f55aa115f802f12ca37dbd637f7d08ec0901503a75e` | `a777ba163470f1a0a0c38c6cd74a110ba30b5ba23c6689279e953721aa54bfce` | `0009aca8ff6345e0f544433c15d094fec5683f5c2f661aab4f8de31cd4c28e75` |
| audit-event | 188 events, 0 malformed | 1 | `dfd48e7c9e7159566d02730ad603390c32abea0f8948e54eb5d227877f2560d9` | `f6859863b2e454af5c1ce15e963ee3e0efb42037e778f9e1d7f70a61d0c6a16e` | `9f0c5e7641ed1827bfa16807efbf906c6edbd2883286372b32b4b38b4f54dbdc` |

The 40 run sources are the 39 run-manifest JSON files plus `active.json`.
Raw-input SHA-256 values bound by those imports:

| Input | SHA-256 | Bytes |
| --- | --- | --- |
| `.cliyard/queue.json` | `93646b13cde1c8774ff79c21180bb4548ace28c1df2e0d887b95022e6bebfd64` | 26,687 |
| `.cliyard/ledger.json` | `a14c3a1eed26ce3c90a6a7a7ecb869dc826e331fc32597bb9773ba2bc0b41647` | 2,424,677 |
| `.cliyard/queue-events/events.jsonl` | `76a2d6c3cf20a97be2366805f380b4feefaa983b0a49f5caa5f52e6df30401a1` | 58,543 |
| `.cliyard/runs/active.json` | `730d331c53a7521e09f74ea560dc19b0885e3fc420549e73e1284ec2b44adcbd` | 113 |
| `.cliyard/runs/78348b45-….json` (controller run) | `a242026875236f7a45a743e916d0db9f27018b6364c02a1fa1324e5a83dfeb6d` | 15,247 |

The aggregate source hash recomputed from the referenced bytes matched the
migration's recorded value in every domain, and the migration marker's
`importHash` equaled the returned `importHash` for every domain. The measurement was repeated with the
marker clock changed from `2026-11-04T00:00:00.000Z` to
`2026-11-03T01:23:45.678Z`; the marker `importedAt` changed as expected while
`sourceHash`, `contentHash` and `importHash` stayed byte-identical in all four
domains. This is consistent with `importHash` hashing only
`{kind, id, contentHash}` records. The run manifest of the live controller run
was part of the measured source set; the repository is live, so the hashes bind
the bytes at measurement time.

## 4. A complete iteration through the cut-over entrypoint

This is the closest available measurement to the requested self-host
iteration. It is a complete two-task run driven through the real
`runSupervisorCli` entrypoint with the cut-over store code, but with an
injected fixture worker: no provider was called and no model cost was
incurred. It is therefore **not** a provider-backed self-host iteration.

Setup: a temporary git repository (base
`3c687a5c1e799a7901551fefe48ae4e6e340e8bb`) with two contracts,
`foundation` → `upper`, and pre-cutover JSON state written by the legacy
formats: one run manifest plus `active.json`, one queue item, one ledger task,
and a journal seeded with an `attempt.started` record. Creating the queue item
itself also appended a `queue.item.added` line through the JSONL path, so the
journal held 2 lines before the iteration. The StateStore directories created
while seeding were removed so the first cut-over write had to import the JSON.

### 4.1 First process — `start`, interrupted

- Migration on first write: `importedRuns: 1`, `importedAt`
  `2026-11-04T15:06:05.528Z`, `sourceHash`
  `beb44015179799e5b29a1f690fd464eb12ac2489eacc6ae748cd919e91820741`,
  `contentHash`
  `b2d326a069a6d326875691e9ef60466016df530b3a41bcf28ab1b4e31a61eb65`,
  `importHash`
  `958b298fe041aba29d6c8790b1dadcaffacb49d39072696c8bf461146577e038`.
  These fixture hashes are path-dependent and differ from the real-repository
  hashes in §3.
- Dispatch order was `foundation`, then `upper`; the fixture worker threw while
  starting `upper`. `foundation` was accepted with result commit
  `fa15ebc8a8a9ca0b277dfb69fd405999832032aa`; `upper` remained
  `running`/unaccepted; run status became `interrupted`; integration head was
  `46b6963a83d854251df39c5893ec9722a5fcf752`. The supervisor StateStore held
  14 facts (`lastSeq 14`) and the run export SHA-256 was
  `08daf35ffa6a5b40c73ba40cda61675b6bcfee6009151ebc336542f34bf5664d`.

### 4.2 Second, fresh process — `resume`, completed

- The resume process dispatched only `upper` (`startOrder: ["upper"]`,
  `waves: [["upper"]]`), proving the accepted `foundation` checkpoint was read
  from durable state rather than regenerated. Exit code `0`.
- `upper` was accepted with result commit
  `898eb5189317dcd3ab2e4470ea1fa1ee22cdafc8`; run status `completed`;
  integration head `4538e2ef7b88c6060273cc339f84c81fe2e45565`.
  `foundation` kept result commit `fa15ebc8…`.
- StateStore facts grew monotonically from 14 to 20 (`lastSeq 20`); the
  completed run export SHA-256 was
  `f75c4b9e9f1f8b3065ef2111a2d17cab2d638bd69ed0909d42d983cd17f6b176`
  (2,844 bytes).
- Evidence bundle state `present`, `degraded: false`, run manifest hash
  `f75c4b9e…`, next action `human-review`, `humanReviewRequired: true`. It
  reports two missing facts, `task.foundation.processTrees` and
  `task.upper.processTrees`, because the fixture worker created no OS process
  tree. Path audits in the fixture recorded `changedPaths` `["foundation.ts"]`
  and `["upper.ts"]` with `outsideWritePaths: []`.

### 4.3 Measured runtime state

- Supervisor StateStore backend: `json-file`. `state.sqlite` was absent;
  `.cliyard/runtime/statestore/facts.json` existed and held the facts.
- Queue StateStore backend: the fallback driver. `.cliyard/state.db` was
  absent; `.cliyard/state-fallback/facts.json` existed after the first queue
  write. Evidence blobs lived under `.cliyard/state-evidence/` (queue) and
  `.cliyard/runtime/statestore/evidence/` (supervisor).
- `.cliyard/queue.json` was rewritten as a derived export (1,010 → 1,941 bytes
  after one item was added). `.cliyard/runs/iteration.json` and `active.json`
  were rewritten as derived exports. `.cliyard/ledger.json` and
  `.cliyard/queue-events/events.jsonl` were also rewritten, but by their
  unconverted JSON paths (§8).

## 5. Read-projection parity

Measured in a fresh process against the completed fixture iteration:

- `compareControlSnapshotParity(snapshot, view.status)` returned `equal: true`,
  `byteIdentical: false`, `differences: 0`. Both sides carried the same
  `observedAt` (`2026-11-04T15:06:06.605Z`).
- The projection reported sources `{snapshot: 1, queue: 1, run: 2, ledger: 1,
  journal: 3}`, `recordCount: 8`, `factCount: 24`, `journalTotal: 2`,
  `ledgerTasks: 3`, and `errors: 0`.
- Byte inequality is expected and is not the gate: the projection round-trips
  through canonical JSON, so key order differs. The parity gate is semantic
  comparison with float tolerance.
- All five JSON write paths (queue, queue export metadata, ledger, journal,
  run exports) were byte-identical before and after `buildStateStoreReadView`;
  the queue export metadata file was absent both before and after. The read
  projection still seeds from JSON; this measurement shows it agrees with the
  StateStore-backed writes, not that it reads the StateStore authority.

## 6. Resume after restart and export recovery

- The interrupted run resumed in a new process from durable run state, as
  described in §4.2. The export was present, and `loadRunManifest` reads the
  export first and falls back to the StateStore projection only when it is
  missing; the accepted checkpoint was not regenerated.
- After completion, the JSON run export was deleted and the run was loaded
  again in a fresh process. The StateStore projection returned the same
  `completed` status, the same integration head `4538e2ef…`, and canonically
  identical task records. Ordered/byte equality was `false` because the
  projection emits task object keys in sorted order while the export preserves
  insertion order; the values were identical. The next checkpoint rewrote
  `iteration.json`.
- Deleting the run export and then calling `updateRunManifest` did **not**
  rewrite `active.json`; the active pointer export stayed missing after the
  checkpoint. The write still succeeded because a missing active export is
  treated as recoverable. This is an observed recovery gap, not a failure of
  the run state.
- Deleting `.cliyard/queue.json` and calling `loadQueue` alone returned an
  empty queue (the read path does not rebuild from the StateStore). The next
  mutation (`addQueueItem`) rewrote the export from the StateStore authority
  and preserved all prior items: `legacy-item`, `second-item`, `after-restore`,
  plus the new item. Rebuilding therefore happens on the next write, not on a
  read.

## 7. JSON drift handling

Both cut-over stores fail closed when a JSON export no longer matches the
StateStore.

| Store | Tamper | Observed error | Facts before → after drift | Bytes preserved | Recovery |
| --- | --- | --- | --- | --- | --- |
| supervisor run export | changed one task's `status` in `iteration.json` | `StateStoreLegacyDriftError`, code `statestore.write.legacy_drift`, `needsHuman: true` | 20 → 20 (last seq 20 → 20) | yes | restored export, next write succeeded, facts 21 |
| queue export | changed one item's `status` in `queue.json` | `StateStoreLegacyDriftError`, code `statestore.write.legacy_drift`, `needsHuman: true` | 5 → 5 (last seq 5 → 5) | yes | restored export, next add succeeded, facts 6 |

The supervisor message combined two checks: the legacy source-bytes snapshot
check and the export-versus-record check. The queue message reported that
`queue.json` was not the exported StateStore projection. In both cases no fact
was appended, the tampered bytes remained on disk for inspection, and a write
only proceeded after the original export bytes were restored. No drift was
auto-merged or silently overwritten.

## 8. What is not yet on the StateStore write path

- `attachLedgerStateStore` and `attachQueueEventStateStore` are defined in
  `src/persistence/ledger.ts` and `src/orchestration/event-journal.ts`. Their
  only callers in this tree are tests (`tests/ledger-lock.test.ts`, six and
  five call sites respectively). No production entrypoint attaches them.
- Direct evidence from the iteration: `.cliyard/ledger.json` changed on the
  JSON path from SHA-256 `f22b0934…` (after phase 1) to `9cbe2ac3…` (after
  phase 2) and ended with tasks `foundation`, `legacy-task` and `upper`, all
  accepted. If the ledger were on the StateStore path, that content would have
  appeared as ledger records in the queue StateStore.
- Evidence-blob domains decoded from the fallback stores were:
  queue store `["migration", "queue"]`; supervisor store
  `["migration", "run"]`. No `ledger` or `audit-event` domain records were
  present.
- `.cliyard/queue-events/events.jsonl` was appended throughout: one
  `attempt.started` event and three `queue.item.added` events were present at
  inspection time. `addQueueItem` still emits its journal event through the
  JSONL append path.
- Therefore, in the default CLI path today, the ledger and event journal
  remain JSON write targets. Only supervisor run state and the queue document
  have StateStore write authority.

## 9. SQLite backend status

`better-sqlite3` is not installed (`MODULE_NOT_FOUND`), so `openFileStateStore`
and the supervisor/queue file drivers take their fallback paths:

- The three code paths that require the native module are skipped in the
  contract suite: "driver swapability: default better-sqlite3 file driver",
  "better-sqlite3 persists facts and projection across connections with WAL"
  and "openFileStateStore is the default durable entry point" — each reported
  `# SKIP better-sqlite3 is not installed in this workspace`.
- The measured durable StateStore backend in the iteration was `json-file`
  (supervisor) and the queue fallback driver. The source comment on the
  supervisor fallback states it preserves append-only facts/atomic commit but
  does not add cross-process writer locking; SQLite transactions remain the
  only multi-process claim. That claim was not exercised.

## 10. Test and build evidence

Contract verify commands, run at integration head `8001c2e`:

| Command | Result |
| --- | --- |
| `npx tsx --test tests/statestore.test.ts tests/statestore-write.test.ts tests/statestore-read.test.ts` | 32 tests, 29 pass, 3 skip, 0 fail (skips are the SQLite tests above) |
| `npm run build` (`tsc -p tsconfig.json`) | exit 0 |

Additional focused suites run at the same head: supervisor store/resume 16/16,
orchestration queue 35/35, ledger lock 19/19.

The complete test inventory was run in three alphabetical partitions:

| Partition | Tests | Pass | Fail | Skip |
| --- | --- | --- | --- | --- |
| `[a-i]` | 178 | 177 | 1 | 0 |
| `[j-r]` | 191 | 190 | 1 | 0 |
| `[s-z]` | 224 | 221 | 0 | 3 |
| **Total** | **593** | **588** | **2** | **3** |

Both failures were re-run in isolation:

- `tests/deadline-extension.test.ts` — "healthy mapped activity persists one
  exact grant before extending" failed only in the grouped run (worker
  timeout) and passed **13/13** alone. Treat as a timing flake.
- `tests/queue-execution-profile.test.ts` — "new items always freeze a
  deterministic profile and legacy records remain readable" failed **9/10**
  when run alone, with `StateStoreLegacyDriftError`: the test writes
  `queue.json` directly after the queue StateStore has been initialized, so the
  cutover treats that write as legacy drift. This is a deterministic
  test/cutover interaction, not a flake, and is a real remaining failure at the
  integration head.

Parity is not claimed from the focused suites alone; §5 records the parity
measurement from the complete iteration, and the two failing tests above remain
unfixed.

## 11. Process cleanup recorded for the accepted tasks

These records come from the real controller run (pre-cutover code, per §0).

| Task | PID | Signals | Cleanup state / completeness | Durable recovery | Residuals | WorkspaceBoundary | Cost |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `statestore-write-api` | 25221 | SIGTERM nested pgid 43833 | terminated / complete | truncated | `residualCount: 0`, members `[]`, residual groups 0 | clean, guard-only | 8.022892 USD, cli-estimated, non-authoritative |
| `supervisor-write-cutover` | 46454 | SIGTERM nested pgid 71337 | terminated / complete | truncated | `residualCount: 0`, members `[]`, residual groups 0 | clean, guard-only | 12.003350 USD, cli-estimated, non-authoritative |
| `queue-write-cutover` | 46487 | SIGTERM nested pgids 192, 71249 | terminated / complete | truncated | `residualCount: 0`, members `[]`, residual groups 0 | clean, guard-only | 10.392325 USD, cli-estimated, non-authoritative |
| `ledger-event-cutover` | 46520 | none | clean / complete | truncated | `residualCount: 0`, members `[]`, residual groups 0 | clean, guard-only | 5.259895 USD, cli-estimated, non-authoritative |

All four `durableRecoveryCompleteness` values are `truncated`; none of the
records claims a durable multi-process recovery.

## 12. Remaining gaps

1. **Daemon.** No long-running daemon supervisor was started or measured. Only
   finite foreground processes ran.
2. **Sandbox.** No OS sandbox exists. WorkspaceBoundary is recorded as
   `guard-only`; it compares observable changes, it does not confine them.
3. **Background verifier.** No background or asynchronous verifier was used.
   Verification remained the finite commands recorded above.
4. **Clean reviewer.** No independent reviewer was run; the evidence bundle's
   next action is `human-review`.
5. **SQLite backend unexercised.** `better-sqlite3` is absent, so SQLite
   transactions, WAL behavior and cross-process locking are unmeasured; the
   measured authority is the fallback driver.
6. **Ledger and event journal not attached.** Their cutover code exists and is
   tested, but production still writes JSON (§8).
7. **Active pointer export recovery.** A missing `active.json` is not rewritten
   by `updateRunManifest` (§6).
8. **Queue export recovery is write-triggered.** `loadQueue` alone returns an
   empty queue after the export is deleted; the export is rebuilt only on the
   next mutation (§6).
9. **No provider-backed self-host iteration on the new code.** The real
   controller ran from pre-cutover `7f6c061`; the measured iteration used an
   injected fixture worker.
10. **Deterministic queue test failure.** `tests/queue-execution-profile.test.ts`
    fails 9/10 alone at the integration head (§10).
11. **The real repository is not migrated.** It has no StateStore directories;
    §3 hashes come from an in-memory migration of its current bytes.

## 13. Reproduction

All commands run from this worktree at `8001c2e`:

```sh
npx tsx --test tests/statestore.test.ts tests/statestore-write.test.ts tests/statestore-read.test.ts
npm run build
```

The real-repository import measurement used an uncommitted scratch script that
opened an in-memory StateStore and ran `migrateLegacyJson` per domain against
the real root with `at` set to `2026-11-04T00:00:00.000Z` and again to
`2026-11-03T01:23:45.678Z` for the clock-independence check. The end-to-end
iteration used a second uncommitted scratch harness that created a temporary
git repository, seeded pre-cutover JSON, and spawned fresh Node processes for
`seed`, `start`, `inspect`, `resume`, `parity`, queue writes, drift tests and
export-rebuild tests. Neither script is part of the repository and no
repository file other than this document was written.

## 14. Non-claims

- No daemon, sandbox or 24-hour operation is claimed.
- No claim is made that JSON stores are deleted; they remain as derived exports
  where cut over and as write targets where not.
- No claim is made that a paid model or provider-backed self-host iteration ran
  on the new code.
- No claim is made that the ledger or event journal are on the StateStore write
  path.
- No claim is made that SQLite itself was exercised; the fallback backend was.
- No claim is made that the integration candidate should be merged. `accepted`
  means the evidence is ready for human review, not auto-merged.

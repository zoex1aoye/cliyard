# Harness Eval v0 — Evidence Closeout

> Date: 2026-10-29
>
> Environment: macOS Darwin 27.0.0 arm64, Node `v20.20.2`, npm `10.8.2`.
>
> Source identity: integration head `0924d4ce5ad3023a396a5ead8beca6db745168a9`,
> tree `b148dfba0977a4d784c53b308721eed63c6395ec`, branch
> `cliyard/mvtj7bho-harness-eval-evidence-closeout`.
>
> Scope: deterministic local Harness scenarios executed through the npm
> `harness-eval` wrapper with two repetitions per scenario. The suite makes no
> paid model request and no provider API call; its unavailable provider metrics
> are recorded below.

## 0. What this evidence does and does not show

- Baseline and candidate were collected from the **same source tree**. This is a
  same-tree repeatability experiment, **not** evidence of a Harness improvement,
  model improvement or provider-quality comparison.
- `context-reload-handoff` and the handoff fixture below simulate context loss
  by reading only fixture bytes. They do **not** claim provider-level context
  compaction equivalence.
- Every observed scenario result is reported as recorded. No scenario was
  rerun or retried to obtain a greener result. In this sample no repetition
  failed, timed out or flipped; that is a sample fact, not a flake-rate claim.
- The generated eval reports below are observations. They are not a second
  task-owned source tree and they do not grant acceptance, merge or push.

## 1. Repository and tool identities

| Fact | Value |
| --- | --- |
| HEAD commit | `0924d4ce5ad3023a396a5ead8beca6db745168a9` |
| HEAD tree | `b148dfba0977a4d784c53b308721eed63c6395ec` |
| Commit date | `2026-10-29T20:40:35+08:00` |
| Working-tree state at start and after all measurements | `?? node_modules` only |
| `node_modules` | symlink to `/Users/x1aoye/Documents/pers-project/cliyard/node_modules` |
| Node / npm | `v20.20.2` / `10.8.2` |
| npm wrapper script | `harness-eval`: `tsx src/cli.ts eval --snapshot --record-only` |

Source file hashes used by this evidence (SHA-256):

| File | SHA-256 |
| --- | --- |
| `examples/harness-eval/suite.json` | `9d8213e8013de54b4521a50c54999aab1a91e53ad726c8e62fe852b2aa983784` |
| `package.json` | `c0b1d3045f6d7f94e541c21f3c42046b06f03c818091d3c0149d0cb2fe4f39e3` |
| `src/evaluation/cli.ts` | `aeed91c6fba1bdce7b011cf830d15e434e37fa826d08eb1919b39ce24504e7b7` |
| `src/evaluation/scenarios.ts` | `71b71b04b19f3bc8c8f9e6bd0470f6f5c9339af3f625ea3bc959c852233be203` |
| `src/evaluation/handoff.ts` | `5c16d816293ed0571ca2e9759269e8fad7d76a2d1476d80e808382124f815672` |
| `src/supervisor/evidence-bundle.ts` | `cfe8ec8b182299d6516733981044d933f94a4c37d3d7105909f3e4e3971c70e0` |

### Snapshot commits bound by the wrapper

The wrapper injects `--snapshot`, so each run materialized the working tree
into a detached snapshot commit and executed scenarios only inside a temporary
worktree. The caller's worktree and history were not changed.

| Run | Snapshot commit | Parent | Tree id |
| --- | --- | --- | --- |
| baseline | `4c212d0b9663a7cb5191126f652f0740954d741e` | `0924d4c…` | `2484e57646e207b9444e82964c6a996bd160a569` |
| candidate | `0fa9b9f3e7e6b591d5f876f133d91858fec33c18` | `0924d4c…` | `2484e57646e207b9444e82964c6a996bd160a569` |

Both snapshot trees are identical: 318 tracked entries, and
`git diff 0924d4c 4c212d0b` reports exactly one added entry:

```text
A	node_modules        (120000 symlink, blob b7554b4561caf90424f6fbb0d7b22b53256f915d)
```

The two snapshot commits have the same parent and the same tree id, but their
commit ids differ. `eval compare` classifies commits by commit id, so it
reported `interpretation = "cross-commit-change"`. That field is a mechanical
commit-id comparison here, not a source change. The identical tree id is the
authoritative same-content fact for this experiment.

Leftover temporary worktrees observed in `git worktree list` were created at
`13:32:05` and `13:44:34` local time (commits `146f961` and `55073ad`), roughly
seven hours before this run at `20:41`. They are pre-existing artifacts of
earlier experiments, their ownership is not certain, and they were left
untouched. No `cliyard-eval-snapshot-*` directory newer than the baseline start
remained after this run, so both of this run's snapshot worktrees were cleaned
up.

## 2. Exact commands and outcomes

All commands ran from the worktree root. Wall times are `/usr/bin/time -p`
`real` values.

| # | Command | Exit | Wall |
| --- | --- | --- | --- |
| 1 | `npm run build` (pre-run gate) | 0 | 1.15 s |
| 2 | `npm run harness-eval -- run --suite examples/harness-eval/suite.json --label baseline --repetitions 2 --out .cliyard/evals/harness-v0/baseline --cwd "$PWD"` | 0 | 14.50 s |
| 3 | `npm run harness-eval -- run --suite examples/harness-eval/suite.json --label candidate --repetitions 2 --out .cliyard/evals/harness-v0/candidate --cwd "$PWD"` | 0 | 14.43 s |
| 4 | `npm run harness-eval -- compare --baseline .cliyard/evals/harness-v0/baseline/run.json --candidate .cliyard/evals/harness-v0/candidate/run.json --out .cliyard/evals/harness-v0/comparison` | 0 | 0.20 s |
| 5 | `npm run harness-eval -- handoff /tmp/cliyard-harness-eval-handoff-v0/fixtures/bundle-clean.json --json` | 0 | not recorded |
| 6 | `npm run test:harness-eval` | 0 | 3.98 s |
| 7 | `npm run build` (final gate) | 0 | 1.16 s |
| 8 | `npm test` | 0 | 26.50 s |

Command 2–5 prove wrapper composition: `--snapshot` and `--record-only` were
injected before the appended subcommand; `run` used them, while `compare` and
`handoff` accepted and ignored them and still succeeded.

## 3. Baseline report

- Report: `.cliyard/evals/harness-v0/baseline/run.json`
  (SHA-256 `afac8bde581c28aa10395fefb11853c7dcef881c67b2bd37dc7fee89dbd28f6d`)
- Markdown: `.cliyard/evals/harness-v0/baseline/run.md`
  (SHA-256 `3d5dd706fb8280fe2237a17476d55edf08a5ad594b1d63832b86e15d5908d07a`)
- Run id: `cliyard-harness-v0.baseline.4c212d0b9663`
- Bound commit: `4c212d0b9663a7cb5191126f652f0740954d741e` (`clean=true`)
- Window: `2026-10-29T12:41:32.515Z` → `2026-10-29T12:41:46.605Z`
- Scenarios: **6/6 passed**; repetitions: **12/12 passed** (100.0%)
- Eval-internal wall: **14,063 ms**

| Scenario | Status | Repetitions | Rep 1 | Rep 2 | Scenario time |
| --- | --- | ---: | ---: | ---: | ---: |
| `normal-work` | passed | 2/2 | 138 ms, exit 0 | 105 ms, exit 0 | 243 ms |
| `high-fanout-process-tree` | passed | 2/2 | 986 ms, exit 0 | 939 ms, exit 0 | 1,925 ms |
| `verifier-timeout-and-extension` | passed | 2/2 | 4,054 ms, exit 0 | 4,033 ms, exit 0 | 8,087 ms |
| `controller-sigkill-recovery` | passed | 2/2 | 957 ms, exit 0 | 905 ms, exit 0 | 1,862 ms |
| `path-escape` | passed | 2/2 | 417 ms, exit 0 | 393 ms, exit 0 | 810 ms |
| `context-reload-handoff` | passed | 2/2 | 575 ms, exit 0 | 561 ms, exit 0 | 1,136 ms |

Every command had `timedOut=false`, `signal=null`, `error=null` and
`matchedExpectation=true`.

## 4. Candidate report

- Report: `.cliyard/evals/harness-v0/candidate/run.json`
  (SHA-256 `cc88c6113f0f3775b345f4490f81a8513fb5e687e9d7a8801505e9e1e8699756`)
- Markdown: `.cliyard/evals/harness-v0/candidate/run.md`
  (SHA-256 `424635074d798123def2d29b48642ca4ec42588de6bdc19642d086b7e5325fbb`)
- Run id: `cliyard-harness-v0.candidate.0fa9b9f3e7e6`
- Bound commit: `0fa9b9f3e7e6b591d5f876f133d91858fec33c18` (`clean=true`)
- Window: `2026-10-29T12:41:48.835Z` → `2026-10-29T12:42:02.902Z`
- Scenarios: **6/6 passed**; repetitions: **12/12 passed** (100.0%)
- Eval-internal wall: **14,041 ms**

| Scenario | Status | Repetitions | Rep 1 | Rep 2 | Scenario time |
| --- | --- | ---: | ---: | ---: | ---: |
| `normal-work` | passed | 2/2 | 131 ms, exit 0 | 107 ms, exit 0 | 238 ms |
| `high-fanout-process-tree` | passed | 2/2 | 972 ms, exit 0 | 958 ms, exit 0 | 1,930 ms |
| `verifier-timeout-and-extension` | passed | 2/2 | 4,061 ms, exit 0 | 4,024 ms, exit 0 | 8,085 ms |
| `controller-sigkill-recovery` | passed | 2/2 | 959 ms, exit 0 | 914 ms, exit 0 | 1,873 ms |
| `path-escape` | passed | 2/2 | 409 ms, exit 0 | 392 ms, exit 0 | 801 ms |
| `context-reload-handoff` | passed | 2/2 | 574 ms, exit 0 | 540 ms, exit 0 | 1,114 ms |

Every command had `timedOut=false`, `signal=null`, `error=null` and
`matchedExpectation=true`.

## 5. Baseline/candidate comparison

- Report: `.cliyard/evals/harness-v0/comparison/comparison.json`
  (SHA-256 `aa18a7b445fb91238811595ce928080873a473827f27f524062bca623a67998d`)
- Markdown: `.cliyard/evals/harness-v0/comparison/comparison.md`
  (SHA-256 `8efcb4bb57b35a6f520f22fb8b6a01814893b551efa747955e66b780b85f1c58`)
- `interpretation`: `cross-commit-change` (snapshot commit ids differ; tree ids
  are identical — see section 1)
- Pass rate: 100.0% → 100.0%; pass-rate delta `0`
- Repetition pass rate: 100.0% → 100.0%
- Flipped scenarios: **none** (`flippedScenarios: []`, `becamePassing: []`,
  `becameFailing: []`)
- Wall-time delta: **−22 ms** (14,063 ms → 14,041 ms)
- Missing observations on both sides: `metrics.cacheHits`, `metrics.cost.amount`,
  `metrics.humanInterventions`, `metrics.inputTokens`, `metrics.outputTokens`,
  `metrics.requests`

Because both runs bound the same tree `2484e576…`, the zero flip count and
zero pass-rate delta measure repeatability of this local suite. They do not
measure a Harness change.

## 6. Failure, timeout and flake truth

- No failed scenario, failed repetition, timeout, signal, error or flip occurred
  in this sample (24 evaluated command executions across both runs). The reports
  therefore contain no failed-repetition detail; nothing was omitted or
  averaged.
- No scenario was rerun to replace a result. The only repetitions are the two
  configured for each scenario per run.
- **`verifier-timeout-and-extension`**: this scenario deliberately includes the
  historically observed in-flight grant-checkpoint flake. It passed **4/4**
  repetitions here (4.05 s / 4.03 s / 4.06 s / 4.02 s). Four passes do not
  disprove the known flake or establish a flake rate. Documented history in
  `docs/CURRENT_STATE.md`: the first post-merge complete-suite run was 463/464
  because the deadline-extension in-flight checkpoint timed out once; that file
  then passed 13/13, and a second complete run passed 464/464.
- **`high-fanout-process-tree`**: passed **4/4** repetitions (0.99 s / 0.94 s /
  0.97 s / 0.96 s). `docs/CURRENT_STATE.md` documents broader cleanup history,
  not this focused test: one closeout wrapper task was rejected because the
  outer Worker cleanup could not prove one vanished external group after a
  5-second `ps` timeout, and another documented failure observed 1,302 external
  groups and one inspection timeout after its leader disappeared. This scenario
  runs the narrower "cleans more than 16 external groups with a 512-member
  group" test. No failure was observed here, and four passes do not establish a
  flake rate.
- The complete suite ran in 26.35 s internal / 26.50 s wall. That remains close
  to the verifier's fixed 30-second command timeout documented in
  `docs/CURRENT_STATE.md`; no timeout occurred in this run, but the headroom
  risk is unchanged.

## 7. EvidenceBundle handoff fixture — rebuild and fresh-process check

The fixture operations below are local. The fixture input is a terminal
`completed` RunManifest; the clean EvidenceBundle was produced by the current
builder (`buildEvidenceBundle`), not copied from an old artifact.

Manifest fixture (`manifest.json`), serialized as `JSON.stringify(value, null, 2)`
plus a trailing newline:

```json
{
  "version": 1,
  "runId": "run-harness-eval-v0-fixture",
  "planId": "harness-eval-v0",
  "repoRoot": "/fixture/repo",
  "contractsPath": "/fixture/repo/contracts.json",
  "contractsHash": "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
  "baseCommit": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "integrationBranch": "cliyard/integration/harness-eval-v0",
  "integrationHead": "cccccccccccccccccccccccccccccccccccccccc",
  "status": "completed",
  "createdAt": "2026-10-29T00:00:00.000Z",
  "updatedAt": "2026-10-29T01:00:00.000Z",
  "owner": { "pid": 4242, "host": "fixture-host" },
  "tasks": {
    "task-a": {
      "taskId": "task-a",
      "status": "accepted",
      "accepted": true,
      "resultCommit": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
    }
  }
}
```

Builder command (scratch directory outside the repository):

```bash
node --import "$PWD/node_modules/tsx/dist/loader.mjs" \
  /tmp/cliyard-harness-eval-handoff-v0/build-fixture.mjs \
  /tmp/cliyard-harness-eval-handoff-v0/fixtures
```

The builder wrote `manifest.json`, then:

- `bundle-clean.json` = `buildEvidenceBundle(manifest)` with default options
  (deterministic `generatedAt` = manifest `updatedAt`);
- `bundle-tampered-next.json` = clean bundle with `nextAction` changed to
  `needs-human`;
- `bundle-tampered-authority.json` = clean bundle with
  `authority.grantsAcceptance` changed to `true`;
- `bundle-tampered-violation.json` = bundle built from the same manifest plus an
  accepted-task `workspaceBoundary` with `status: "violation"`, then a persisted
  `nextAction` changed to `human-review`.

### Fixture source hashes (SHA-256)

| Fixture | SHA-256 |
| --- | --- |
| `manifest.json` | `71e8ded8f00fd5406a5d2498090ca851dc4a767145ad2a851f28a6b27d5238e1` |
| `bundle-clean.json` | `611e37dc24c80c6675b8bee6cce725f6109e063dcc8f59ef9e7b14827a76e320` |
| `bundle-tampered-next.json` | `6ed8aa49f7eb64041fc27fa932b415dfea6e20159f744d2d7f2737205437c499` |
| `bundle-tampered-authority.json` | `6b93cde024e55e93153ffcd097b8fd5f5fb9469945015cf924a4d1d1100695e5` |
| `bundle-tampered-violation.json` | `74042e4a503451de755aaa5a0378f807b36e24fecb725b8e150e2149092851f7` |

The clean bundle records `nextAction = human-review`,
`authority.manifest.hash = 71e8ded8…` (equal to the `manifest.json` SHA-256
above), and `missing = ["task.task-a.cost", "task.task-a.pathAudits",
"task.task-a.processTrees", "task.task-a.workspaceBoundary"]`. Missing
observations are listed; they are not silently treated as zero.

### Fresh-process handoff CLI

Each fixture was read in a new process whose cwd was an empty directory:

```bash
node --import <repo>/node_modules/tsx/dist/loader.mjs \
  <repo>/src/evaluation/handoff.ts <fixture> --json
```

| Fixture | Exit | `source` | Recomputed `nextAction` | `nextActionMatched` |
| --- | ---: | --- | --- | --- |
| `manifest.json` | 0 | `run-manifest` | `human-review` | `true` |
| `bundle-clean.json` | 0 | `evidence-bundle` | `human-review` | `true` |
| `bundle-tampered-next.json` | 0 | `evidence-bundle` | `human-review` | **`false`** |
| `bundle-tampered-violation.json` | 0 | `evidence-bundle` | `needs-human` | **`false`** |
| `bundle-tampered-authority.json` | 2 | — (rejected) | — | — |

- Each successful decision's `sourceSha256` equalled the fixture's SHA-256
  above, so the decision is bound to exactly the bytes that were read.
- The clean and manifest runs both selected `human-review` with allowed actions
  `review-diff`, `review-evidence`, `decide-integration`.
- `bundle-tampered-next.json` persisted `needs-human` but the recomputed action
  was `human-review`; the persisted value was not trusted and the disagreement
  was reported (`nextActionMatched=false`).
- `bundle-tampered-violation.json` persisted `human-review` but the
  workspace-boundary violation forced `needs-human` with reason
  "Terminal evidence records a workspace-boundary violation or inspection error."
- `bundle-tampered-authority.json` failed closed with exit 2, empty stdout and
  stderr `cliyard eval handoff: authority.grantsAcceptance must be false`; no
  decision was produced.
- Before and after the runs the empty cwd contained no entries: the fresh
  process read only the fixture and wrote nothing.
- The same clean fixture through the npm wrapper
  (`npm run harness-eval -- handoff … --json`, global options ignored) exited 0
  with `source=evidence-bundle`, `sourceSha256=611e37dc…`,
  `nextAction=human-review`, `nextActionMatched=true`.
- Every decision carried
  `contextReload = "fixture-only reconstruction; provider-level compaction is not claimed"`.

The handoff scratch directory `/tmp/cliyard-harness-eval-handoff-v0` is not
repository state and may not persist; the manifest, mutations, builder version
(source hash `cfe8ec8b…`) and hashes above are the reproducible definition.

## 8. Verification gates

| Gate | Command | Result | Time |
| --- | --- | --- | --- |
| Build (pre-run) | `npm run build` | pass | 1.15 s |
| Focused eval tests | `npm run test:harness-eval` | **34/34 pass**, 0 fail | 3.86 s internal / 3.98 s wall |
| Build (final) | `npm run build` | pass | 1.16 s |
| Complete suite | `npm test` | **539/539 pass**, 0 fail, 0 cancelled | 26.35 s internal / 26.50 s wall |

No focused or full-suite test failed in these runs. This is one observation at
one tree; it is not a stable-green or flake-rate claim.

## 9. Unavailable measurements

The v0 engine makes no model request, so these metrics are `null`/unavailable
with explicit reasons in both reports (never zero):

| Metric | Reason recorded in the report |
| --- | --- |
| `metrics.requests` | the v0 engine makes no model request; request count was not observed |
| `metrics.inputTokens` | no provider usage was observed; input token count is unavailable |
| `metrics.outputTokens` | no provider usage was observed; output token count is unavailable |
| `metrics.cacheHits` | no provider usage was observed; cache hit count is unavailable |
| `metrics.cost.amount` | no provider-reported or CLI-estimated cost observation was supplied |
| `metrics.humanInterventions` | human interventions are not instrumented in v0 |

Cost state is `unavailable`, source `none`, authoritative `false`. No provider
billing, quota, balance or price was observed.

## 10. Boundaries and non-claims

- No source, test, Plan or contract file was modified. The only non-ignored
  repository file written by this task is this document. Generated eval reports
  and per-command logs live under the Git-ignored
  `.cliyard/evals/harness-v0/` directory (24 bounded command logs plus the six
  report files listed above).
- Before this document was written, and again after all measurement commands,
  `git status --porcelain=v1 --untracked-files=all` reported only
  `?? node_modules`; writing this document adds
  `?? docs/evidence/HARNESS_EVAL_V0.md`. `HEAD` remained `0924d4c`.
- The snapshot commit contains the untracked `node_modules` symlink because the
  wrapper materializes untracked non-ignored files. That symlink is an
  execution dependency link, not evaluated source and not a source change.
- No OS sandbox is claimed. `path-escape` uses WorkspaceBoundary guard-only
  detection; it does not prevent filesystem writes.
- No provider-level compaction, model-quality improvement, automatic
  acceptance, merge or push is claimed.
- The two pre-existing leftover snapshot worktrees noted in section 1 were not
  removed because their ownership is uncertain and unattributed data must not
  be deleted.

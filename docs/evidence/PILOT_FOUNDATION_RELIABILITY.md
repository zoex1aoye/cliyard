# Pilot foundation reliability — evidence

> Measured 2026-10-29 on macOS 27.0 (Darwin 27.0.0, arm64), Node `v20.20.2`,
> npm `10.8.2`, `tsx v4.23.15`, host `paofujianlaide-MacBook.local`.
>
> Run: `6919db6d-9948-42f4-b5d6-04111f5d0dba` (`pilot-safety-reliability-v1`).
> Integration branch: `cliyard/integration/6919db6d-9948-42f4-b5d6-04111f5d0dba`.
> Integration head: `fb665abd4cf135e4b3b2f3819114d263de60f793`.
> Frozen contracts SHA-256:
> `0c3ad9b1fb886ef28bcfcd00dd7d309f900d4342df8346f482c28509fe406275`.
>
> This document records observed behavior only. It does not accept, merge or
> push the integration candidate, and it does not authorize pilot use.

## 0. What this document is and is not

- It is the evidence closeout for six accepted foundation tasks merged into one
  integration branch. It records their code identity, path audits, focused
  behavior, run-level cleanup/guard records, and an exhaustive test inventory at
  the integration head.
- It is **not** a claim that the pilot is accepted, that the integration branch
  may be merged to `main`, that the system ran for 24 hours, or that an OS
  sandbox exists.
- At authoring time the run status was `running` and task
  `pilot-foundation-evidence` was `running` with no terminal path audit,
  process-tree, WorkspaceBoundary or cost record yet. Those fields are produced
  by the controller after Worker exit. Their absence here is not evidence that
  they passed.
- `accepted` in this repository means the task evidence is ready for human
  review. It never means auto-merged.

## 1. Result in one paragraph

Six foundation tasks were accepted and merged into integration head
`fb665abd4cf135e4b3b2f3819114d263de60f793`: verifier command timeout
(`215c272`), batched process-table cleanup (`989b9e8`), task-level budget ledger
(`46e1eb5`), DSH plugin hardening (`c8200e7`), Harness Eval wrapper semantics
(`eb860e6`), and Harness Eval evidence closeout (`58c8c3d`). Every accepted task
path audit reported `outsideWritePaths: []`, every WorkspaceBoundary record was
`clean` (guard-only), and every recorded process cleanup ended with
`residualCount: 0`. The complete test inventory at the integration head passed
**544/544** in three shell-expanded alphabetical groups (`178 + 181 + 185`) with
group wall times of **25.94 s**, **12.61 s** and **13.56 s**; `npm run build`
passed in **1.22 s**. Focused suites passed 13/13 (DSH plugin), 33/33
(process-tree), 41/41 (budget), 27/27 (verifier timeout) and 34/34 (Harness
Eval). The six accepted changes were not loaded by the controller that produced
this run; that provenance limitation and the remaining blockers are recorded in
sections 2, 4, 6 and 10.

## 2. Lineage and exact identities

| Fact | Value |
| --- | --- |
| Plan | `design/pilot-safety-reliability-v1.plan.json` |
| Plan SHA-256 | `9a8843a3c182f8d877d97100b646a9b4e71ae7bfda5df2516e3ee6aaf5e394a6` |
| Frozen contracts | `design/pilot-safety-reliability-v1.contracts.json` |
| Contracts SHA-256 | `0c3ad9b1fb886ef28bcfcd00dd7d309f900d4342df8346f482c28509fe406275` |
| Run manifest `contractsHash` | `0c3ad9b1fb886ef28bcfcd00dd7d309f900d4342df8346f482c28509fe406275` (matches the file) |
| Run base commit | `8b5f9f1f362b951cd0b66b534eba8c71a9faaba4` |
| Accepted implementation base | `3abbc7952389d8f7337377238bc7d3a0bc3808a6` |
| Integration branch | `cliyard/integration/6919db6d-9948-42f4-b5d6-04111f5d0dba` |
| Integration head | `fb665abd4cf135e4b3b2f3819114d263de60f793` |
| Integration head tree | `889cdba82a034dddf5106ed6e5354b75f5cde789` |
| Task attempt base | `fb665abd4cf135e4b3b2f3819114d263de60f793` |
| Current branch | `cliyard/mvtjt2ys-pilot-foundation-evidence` |

The run base `8b5f9f1` is a docs-composed base on top of accepted code
`3abbc79`. Each accepted task was implemented in its own worktree and merged
into the integration branch by the merge commits below. No merge to the
repository's mainline branch is observed or claimed here.

| Task | Task branch | Accepted result commit | Integration merge commit |
| --- | --- | --- | --- |
| `verifier-command-timeout` | `cliyard/mvtipatu-verifier-command-timeout` | `215c272f97c8066f11da4a9287dd5ec4813a1f98` | `8ace4a2a6857d555828fff6ec6a44afad1a38b06` |
| `process-table-batch-cleanup` | `cliyard/mvtipaw6-process-table-batch-cleanup` | `989b9e87cb248c5d4f23d23bcbb8275665601210` | `1f32d6224cb29f26c674be6361f28fd010f6b156` |
| `task-budget-ledger` | `cliyard/mvtipayj-task-budget-ledger` | `46e1eb5d35f92c6d90069a7d628be6ce4367b7e7` | `fb665abd4cf135e4b3b2f3819114d263de60f793` |
| `dsh-plugin-hardening` | `cliyard/mvtipb0x-dsh-plugin-hardening` | `c8200e7fe8d7011521d946085779f223bed5d691` | `79bfd6d8818db25d4e6a9db79f932fc86e5e8077` |
| `harness-eval-wrapper-semantics` | `cliyard/mvtipb39-harness-eval-wrapper-semantics` | `eb860e674bbdab1d26ad876d9a67bb2aeaa038a5` | `0924d4ce5ad3023a396a5ead8beca6db745168a9` |
| `harness-eval-evidence-closeout` | `cliyard/mvtj7bho-harness-eval-evidence-closeout` | `58c8c3d7ebed69c5f15225cff596b533e80442ff` | `b60a5ddea533471a374a8f003d9d92a8f178a857` |

Every accepted result commit is an ancestor of the integration head (checked
with `git merge-base --is-ancestor`). The integration head is a merge commit
whose parents are `b60a5dd` and `46e1eb5`.

### Self-host provenance

The Plan records that the running Supervisor was old code. The run base
`8b5f9f1` predates every task implementation commit listed above, and one
Supervisor process cannot load code that was produced later inside task
worktrees. Therefore this run proves task-local implementation behavior and
produces reviewable artifacts, but it does **not** prove that the new verifier
timeout, batched cleanup, or task-level budget ledger were loaded by the
controller that produced the run. Those behaviors are established by the
focused tests at the integration head, not by the controller's own execution.

## 3. Path audits

The RunManifest retained these controller path audits. `outsideWritePaths` was
empty in every record.

| Task | Audit exit | Changed paths (in contract scope) | Outside |
| --- | ---: | --- | --- |
| `verifier-command-timeout` | 0 | `src/contracts/fromTaskfile.ts`, `src/contracts/schema.ts`, `src/planner/plan.ts`, `src/verification/verifier.ts`, `tests/contract-runtime.test.ts`, `tests/plan.test.ts`, `tests/verifier-shell.test.ts` | none |
| `process-table-batch-cleanup` | 0 | `src/agents/process-tree.ts`, `tests/worker-process-tree.test.ts` | none |
| `task-budget-ledger` attempt 1 | 1 | `src/agents/claude.ts`, `src/agents/continuation.ts`, `src/agents/types.ts`, `src/repair/loop.ts` | none |
| `task-budget-ledger` attempt 2 | 0 | the same four files plus `tests/budget-continuation.test.ts`, `tests/claude-failure-cost.test.ts` | none |
| `dsh-plugin-hardening` | 0 | `plugins/dsh-cliyard/index.js`, `plugins/dsh-cliyard/lib/monitor.js`, `plugins/dsh-cliyard/package.json`, `tests/master-plugin.test.ts` | none |
| `harness-eval-wrapper-semantics` | 0 | `package.json`, `src/evaluation/cli.ts`, `tests/harness-eval-cli.test.ts` | none |
| `harness-eval-evidence-closeout` | 0 | `docs/evidence/HARNESS_EVAL_V0.md` | none |

The first `task-budget-ledger` worker attempt exited 1 after a provider error
(`API Error: Connection closed mid-response. The response above may be
incomplete.`) and had changed only the four in-scope source files at audit time.
The task was retried; the second worker completed all six in-scope paths and
passed verification. Both attempt records remain in the manifest. The manifest's
task cost records one observation for the second session only; the first
attempt's cost is not recorded and must be treated as unknown, not zero.

### Additional integration-level audit

A read-only diff audit from the run base to the integration head found **23**
changed paths. The union of the six foundation task `writePaths` (excluding this
evidence task) is exactly those 23 paths: **no extra path and no missing path**.
The union including this task is 24 paths; the only missing path is
`docs/evidence/PILOT_FOUNDATION_RELIABILITY.md`, which is this task's sole write
path and is being authored now. This is a supplementary audit, not a substitute
for the controller path audits above.

### WorkspaceBoundary

Every accepted task recorded `status: "clean"`, `enforcement: "guard-only"` and
`changes: []`. This is after-the-fact protected-root integrity detection only.
It does not prevent filesystem writes, credential access or network egress, and
it is not an OS sandbox. The `pilot-foundation-evidence` task's boundary record
did not exist at authoring time.

## 4. High-fanout external-group cleanup

### Strategy at the integration head

`src/agents/process-tree.ts` (`cleanNestedGroups`,
`cleanNestedGroupsFromTable`, `snapshotGroupMemberships`) changes the cleanup
contract from one process-table listing per external group to bounded snapshots:

- When the inspector exposes `snapshotProcessTable`, each cleanup phase takes
  one bounded `ps -A` snapshot (`MAX_PROCESS_TABLE_ROWS`) and projects exact
  membership for every observed pgid in memory.
- The phases are initial inspection, TERM wait, escalation revalidation and
  KILL wait. No per-group `listGroupMembers` and no per-group leader capture run
  on this path.
- Exact leader identity, own-group exclusion, negative-pgid signaling and
  fail-closed behavior are retained. A missing leader with members remaining, a
  changed/reused identity, a snapshot failure or an incomplete table yields a
  residual group and fails cleanup closed.
- Inspectors without `snapshotProcessTable` keep the legacy exact single-group
  path. Windows remains an exact-child limitation; it does not claim POSIX group
  ownership.

Focused `tests/worker-process-tree.test.ts` passed **33/33** in **12.46 s**
wall (internal 12,274.78 ms). Relevant observed assertions:

- 40 external groups: `listCalls` contained only the managed leader pid; no
  per-group leader capture occurred; snapshot calls stayed between 3 and 8;
  exactly 40 exact negative-pgid `SIGTERM` signals were sent; residual groups
  and descendants were 0.
- A leader that disappears before batched cleanup fails closed: the intact group
  was cleaned, the leaderless group was never signaled, and cleanup state was
  `failed` with one residual group.
- A leader that disappears between `SIGTERM` and escalation refuses `SIGKILL`.
- The legacy per-group inspector fallback is retained when snapshots are
  unavailable.
- `win32` mode records the exact-child limitation and never claims a group.

### Outcomes recorded in this run

The controller that produced these records was the pre-existing Supervisor, not
the batched implementation above (section 2). These are therefore legacy-path
outcomes, retained as run evidence; they are not proof that the batched path ran
in this run.

| Task | Attempts | Cleanup state | Completeness | Durable recovery | Persisted external groups | Nested observed / signaled / residual | Signals | Residual count |
| --- | ---: | --- | --- | --- | ---: | --- | --- | ---: |
| `verifier-command-timeout` | 1 | clean | complete | truncated | 16 | 501 / 0 / 0 | none | 0 |
| `process-table-batch-cleanup` | 1 | clean | complete | truncated | 16 | 446 / 0 / 0 | none | 0 |
| `task-budget-ledger` attempt 1 | 1 | clean | complete | complete | not recorded | no nested record | none | 0 |
| `task-budget-ledger` attempt 2 | 1 | clean | complete | truncated | 16 | 673 / 0 / 0 | none | 0 |
| `dsh-plugin-hardening` | 1 | clean | complete | complete | 4 | 4 / 0 / 0 | none | 0 |
| `harness-eval-wrapper-semantics` | 1 | clean | complete | truncated | 16 | 165 / 0 / 0 | none | 0 |
| `harness-eval-evidence-closeout` | 1 | terminated | complete | truncated | 16 | 274 / 1 / 0 | `SIGTERM` to nested pgid `46386` | 0 |

Every cleanup ended with `residualCount: 0` and `cleanupCompleteness: complete`.
`durableRecoveryCompleteness: truncated` means a future controller-death
recovery could not reconstruct the complete ownership set and must return
`needs_human`; it is not a claim of complete recovery. The only signal in the
run manifest is one exact nested-group `SIGTERM`; no positive-pid, name-based or
broad kill appears in the records. The first `task-budget-ledger` attempt lacks
a nested-group record, so its nested cleanliness is less evidenced than the
other attempts.

## 5. Verifier command timeout

### Behavior at the integration head

`src/contracts/schema.ts` defines:

- `DEFAULT_VERIFY_TIMEOUT_MS = 30_000` for contracts without the field;
- `MAX_VERIFY_TIMEOUT_MS = 600_000` (10 minutes);
- `verifyTimeoutMs` must be a positive safe integer no greater than 600,000, or
  contract validation fails.

`src/verification/verifier.ts` resolves the per-command timeout as
`contract.verifyTimeoutMs ?? opts.timeoutMs ?? 30_000` and applies it to each
`verifyCommand`. A timeout sends `SIGTERM`, records exit code `124`, stops
remaining commands and is classified as a verifier failure; it is never accepted
evidence. Plan compilation and Taskfile defaults accept the same field. Runtime
readiness `runtime.services[].readiness.timeoutMs` remains a separate setting.

Focused tests `verifier-shell + plan + fromTaskfile` passed **27/27** in
**1.44 s** wall (internal 1,249.97 ms), covering the legacy 30-second default,
the verifier-option fallback, contract override, invalid values, Plan
round-trip, timeout classification and repair exhaustion.

### What this run actually exercised

All seven frozen contracts omit `verifyTimeoutMs`; the field is absent in
`design/pilot-safety-reliability-v1.contracts.json`. The running controller also
predates the field (section 2). Therefore this run used the legacy 30-second
default for every task; it did not prove an explicit contract timeout
end-to-end. The implementation is proven by the focused tests at the
integration head.

The timeout headroom risk remains visible: the `[a-i]` exhaustive group took
**25.94 s** wall against the 30-second default, leaving about **4.06 s**. That is
why the complete inventory was split into three groups rather than run as one
`npm test`.

Observed worker concurrency matched the Plan's conservative limit: at most
**two** worker processes were alive at once. Although five wave-1 tasks were
ready, the observed worker process intervals never overlapped more than two at a
time; later tasks started as earlier ones closed.

## 6. Task-level budget guard

### Behavior at the integration head

`src/agents/types.ts`, `src/agents/continuation.ts`, `src/agents/claude.ts` and
`src/repair/loop.ts` add a bounded `TaskBudgetContinuationState` (`taskId`,
`cumulativeGuardUsd`, `continuationCount`, `maxCumulativeGuardUsd`). The repair
loop threads the state through every attempt and rejects a reported ledger that
would decrease the cumulative guard, decrease the continuation count, or change
the maximum. Cost aggregation records the cumulative guard as
`guardBudgetUsd` separately from CLI-estimated cost, usage-only cost and
unavailable cost. A repair or continuation cannot silently reset the task
envelope.

Focused `budget-continuation + claude-failure-cost` passed **41/41** in
**19.75 s** wall (internal 19,563.86 ms). Observed cases include:

- a `$1.5` task envelope bounds an initial attempt plus its repair: final
  `cumulativeGuardUsd = 1.5`, `maxCumulativeGuardUsd = 1.5`;
- a budget continuation after a repair cannot reset the ledger: final
  `cumulativeGuardUsd = 3`, `maxCumulativeGuardUsd = 3`;
- a repair ledger that would reset the envelope is rejected; the prior ledger
  survives (`cumulativeGuardUsd = 1`, `maxCumulativeGuardUsd = 2`);
- exhaustion, denied policy, wrong-provider failure, timeout, outside-path
  change, grant persistence failure and resume failure keep their existing
  bounded semantics.

### What this run actually recorded

The running controller did not load the ledger (section 2). The RunManifest at
this run base has no task-cumulative budget field. Each task record shows
`guardBudgetUsd: 10`, one CLI cost observation and
`state: "cli-estimated"`, `authoritative: false`. `task-budget-ledger` was
attempted twice: the first worker failed with a provider API connection error
and has no cost observation; the second completed with an estimated
`$5.338021`. The six recorded observations total **`$25.281975`**, which excludes
the unknown first attempt and is **not** a provider bill, balance or quota.
No budget continuation grant is recorded in the run manifest.

This is direct evidence that the task-cumulative envelope was a real gap in the
controller that produced the run. It is fixed and tested at the integration
head, but not exercised end-to-end by this run.

## 7. DSH plugin safety and compatibility

`plugins/dsh-cliyard` was hardened without changing the core Node baseline.

### Safe rendering and headers

- `lib/monitor.js` serves a static document shell plus separate `/app.js` and
  `/app.css`; ledger values are written with `textContent` only.
- The served response carries
  `Content-Security-Policy: default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
  plus `cross-origin-resource-policy: same-origin`, `referrer-policy:
  no-referrer`, `x-content-type-options: nosniff`, `x-frame-options: DENY` and
  `cache-control: no-store`.
- A test feeds malicious ledger text (`"><script>alert(1)</script>`) through the
  client renderer and asserts that no `innerHTML` write occurs and the text is
  rendered as data.

### Compatibility and routing

- `plugins/dsh-cliyard/package.json` declares `engines.node: ">=20"` and
  `engines.dsh: "0.2.1-rc.3"`. The exact pinned value is the local version the
  plugin was developed against; it does not claim `0.2.2-alpha.2` or any alpha
  compatibility. The cliyard root package remains `engines.node: ">=20"`.
- The model-visible tool accepts only a configured `executionProfileId` alias.
  Aliases map server-side to worker/model values; unknown aliases and
  `worker`/`model`/permission injection are rejected, and the alias cannot be
  combined with a direct worker/model override. Existing standalone API
  defaults remain.

Focused `tests/master-plugin.test.ts` passed **13/13** in **1.19 s** wall
(internal 1,008.23 ms).

### Not measured

The plugin was not loaded into DSH during this run. Upstream `0.2.1-rc.4` and
`0.2.2-alpha.2` were not installed or conformance-tested. Alpha.2 declares
Node.js `>=24.9` and contains Session, model-routing, Cordis and tool API
changes per
[DSH_0_2_2_ALPHA_2_REVIEW.md](./DSH_0_2_2_ALPHA_2_REVIEW.md); none of that is
verified here. `engines.dsh` is a compatibility declaration, not a host run.

## 8. Harness Eval evidence

The closeout task produced
[`docs/evidence/HARNESS_EVAL_V0.md`](./HARNESS_EVAL_V0.md), SHA-256
`8bbbcbfdb5d9458d7e85a1dfb5a3283bbd33ea23e1ccb41d2323e57871d3718a`
(verified against both the working tree and `HEAD`). Its source identity was
integration head `0924d4ce5ad3023a396a5ead8beca6db745168a9`, tree
`b148dfba0977a4d784c53b308721eed63c6395ec`.

The generated reports were retained in the closeout worktree
`.cliyard/worktrees/mvtj7bho-harness-eval-evidence-closeout/.cliyard/evals/harness-v0/`.
They are Git-ignored observation artifacts, not files in the integration
commit; the document hashes are the durable binding. Their hashes were re-read
on 2026-10-29 and match the evidence document:

| Artifact | SHA-256 |
| --- | --- |
| `baseline/run.json` | `afac8bde581c28aa10395fefb11853c7dcef881c67b2bd37dc7fee89dbd28f6d` |
| `baseline/run.md` | `3d5dd706fb8280fe2237a17476d55edf08a5ad594b1d63832b86e15d5908d07a` |
| `candidate/run.json` | `cc88c6113f0f3775b345f4490f81a8513fb5e687e9d7a8801505e9e1e8699756` |
| `candidate/run.md` | `424635074d798123def2d29b48642ca4ec42588de6bdc19642d086b7e5325fbb` |
| `comparison/comparison.json` | `aa18a7b445fb91238811595ce928080873a473827f27f524062bca623a67998d` |
| `comparison/comparison.md` | `8efcb4bb57b35a6f520f22fb8b6a01814893b551efa747955e66b780b85f1c58` |

Observed scenario results: baseline **6/6 scenarios, 12/12 repetitions**;
candidate **6/6 scenarios, 12/12 repetitions**; comparison interpretation
`cross-commit-change` (different snapshot commit ids, identical tree
`2484e57646e207b9444e82964c6a996bd160a569`); no flipped, newly passing or newly
failing scenarios; missing provider metrics recorded as unavailable. Focused
Eval tests passed **34/34** in **4.06 s** wall (internal 3,882.22 ms). The
closeout document's complete suite was **539/539** at its own tree; the current
integration adds the `task-budget-ledger` tests and measures **544/544** below.

The experiment is same-tree repeatability, not a Harness or model improvement.
No failed repetition was observed in this sample; that is a sample fact, not a
flake-rate claim. The evidence document's source identity is `0924d4c`; the
final integration head `fb665ab` adds only `task-budget-ledger` after it. The
Eval-relevant source hashes listed in the document (`package.json`,
`src/evaluation/cli.ts`, `src/evaluation/scenarios.ts`,
`src/evaluation/handoff.ts`, `src/supervisor/evidence-bundle.ts`) are unchanged
at the integration head.

## 9. Exhaustive test inventory and build

Commands ran from the task worktree at integration head `fb665ab`. The patterns
are shell-expanded; together they cover all 62 `tests/*.test.ts` files
(`tests/test-port-ranges.ts` is a helper, not a `.test.ts`). No `npm test`
single-command run was used.

| Group | Files | Tests | Pass | Fail | Internal duration | Wall (`/usr/bin/time -p`) |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| `npx tsx --test tests/[a-i]*.test.ts` | 21 | 178 | 178 | 0 | 25,748.75 ms | **25.94 s** |
| `npx tsx --test tests/[j-r]*.test.ts` | 24 | 181 | 181 | 0 | 12,418.98 ms | **12.61 s** |
| `npx tsx --test tests/[s-z]*.test.ts` | 17 | 185 | 185 | 0 | 13,373.40 ms | **13.56 s** |
| **Total** | **62** | **544** | **544** | **0** | **51,541.13 ms** | **52.11 s** |

`npm run build` (TypeScript) exited 0 in **1.22 s** wall. No `not ok` line
appears in any group log; every group reported `# cancelled 0`, `# skipped 0`
and `# todo 0`. Group `[a-i]` is the closest to the legacy 30-second verifier
limit at 25.94 s; the other groups have larger headroom.

### Focused suites used as task evidence

| Suite | Tests | Pass | Fail | Wall |
| --- | ---: | ---: | ---: | ---: |
| `tests/master-plugin.test.ts` | 13 | 13 | 0 | 1.19 s |
| `tests/worker-process-tree.test.ts` | 33 | 33 | 0 | 12.46 s |
| `tests/budget-continuation.test.ts tests/claude-failure-cost.test.ts` | 41 | 41 | 0 | 19.75 s |
| `tests/verifier-shell.test.ts tests/plan.test.ts tests/fromTaskfile.test.ts` | 27 | 27 | 0 | 1.44 s |
| `tests/harness-eval-core.test.ts tests/harness-eval-cli.test.ts tests/harness-eval-handoff.test.ts` | 34 | 34 | 0 | 4.06 s |

### Before/after state

Before this document was written, `git status --porcelain=v1
--untracked-files=all` reported only `?? node_modules` (an execution dependency
symlink), and `HEAD` was `fb665abd4cf135e4b3b2f3819114d263de60f793`. Writing
this document adds `?? docs/evidence/PILOT_FOUNDATION_RELIABILITY.md`; this task
writes only that path, and no source, test, Plan or contract file was modified.

## 10. Remaining blockers and residual gaps

These are capability gates, not a percentage score. None is closed by this
document.

| Blocker | Observed current state |
| --- | --- |
| Background verifier | Not implemented. Verification remains coupled to the Worker lifecycle; there is no independent `VerificationTask` with startup recovery, output offsets and delivered state. |
| SandboxProvider | Not implemented. WorkspaceBoundary remains guard-only after-the-fact detection; there is no OS write prevention, credential isolation or network isolation. |
| Control API | Not implemented. There is no versioned snapshot/event/status/projection client surface with replay cursors; the DSH plugin still reads one ledger file and its `watchLedger` callback is a no-op. |
| DSH alpha2 runtime conformance | Not measured. The local app is `0.2.1-rc.3`; rc.4 and alpha.2 were not loaded. Alpha.2 requires Node `>=24.9` and changes Session, model-routing, Cordis and tool APIs. `engines.dsh: "0.2.1-rc.3"` declares only the developed-against version, not a host conformance result. |
| Provider balance/quota | Unknown. Only a local guard (`guardBudgetUsd`, `$10` per invocation in this run) and non-authoritative CLI estimates exist (recorded total `$25.281975`). The first `task-budget-ledger` attempt has no cost observation. No provider-reported balance, quota, price or concurrency was observed. |
| Windows process ownership | Not implemented. `win32` mode records an exact-child limitation and does not claim POSIX group ownership; there is no Windows Job Object equivalent. |
| Bounded soak | Not performed. No multi-hour or 24-hour soak evidence exists; "24-hour continuous delivery" remains a target. |

Additional residual gaps visible in this evidence:

- The controller that produced this run did not load the six fixes. A later
  run must prove them in the loaded controller; this document does not.
- The task-cumulative budget envelope is tested but was not exercised by this
  run; the manifest records per-invocation `guardBudgetUsd: 10`.
- The first `task-budget-ledger` attempt failed on a provider API connection
  error; its cost is unknown and its nested cleanup record is absent.
- The `[a-i]` exhaustive group took 25.94 s against the legacy 30-second
  verifier window. Splitting groups avoids the single-command limit but does not
  create timeout headroom for a full-suite command.
- The DSH plugin was not run in a DSH host; CSP/rendering/profile behavior is
  unit-tested only.
- Repeated same-tree Harness Eval runs passed in this sample, but no flake rate
  is established; the historical deadline-extension flake remains documented in
  `docs/CURRENT_STATE.md`.

## 11. Non-claims and human review gate

- **No pilot acceptance.** The run was still `running` when this document was
  authored, and `pilot-foundation-evidence` was still `running`.
- **No merge authorization.** All six tasks are merged only into the integration
  branch named above, not into the mainline branch. A human must review every
  diff, the integration head, the path audits, cleanup evidence and this
  document before any merge decision.
- **No 24-hour operation.** No bounded soak was run.
- **No OS sandboxing.** WorkspaceBoundary detects protected-root changes after
  the fact; it does not prevent writes, credential access or network egress.
- **No model or provider quality claim.** Harness Eval v0 is a deterministic
  local same-tree repeatability experiment; it made no paid model request.
- **No provider cost, balance or quota claim.** All cost figures are
  CLI-estimated, non-authoritative and may be incomplete.
- **No retroactive acceptance.** Earlier blocked or rejected runs remain
  rejected history; this document does not promote them.
- Worktrees and branches are retained for human diff review. `accepted` means
  evidence is ready for review, not that the change is merged or safe to deploy.

## Appendix A. Group composition (62 test files)

`[a-i]` (21): `architect`, `assemble`, `budget-continuation`, `claude-adapter`,
`claude-failure-cost`, `claude-progress`, `codex-batch-dry`, `codex-paths`,
`context-preflight`, `continuous-batch`, `contract-runtime`, `dag`,
`deadline-extension`, `dependency-link`, `estimate`, `evidence-bundle`,
`failure-taxonomy`, `fromTaskfile`, `harness-eval-cli`, `harness-eval-core`,
`harness-eval-handoff` (all `.test.ts`).

`[j-r]` (24): `ledger-lock`, `loop`, `master-plugin`, `mock-batch`,
`orchestration-queue`, `parallel-batch`, `plan-backed-materializer`,
`plan-backed-queue-cli`, `plan-backed-queue-core`, `plan`, `queue-adoption`,
`queue-control-snapshot`, `queue-execution-profile`, `queue-run-binding`,
`runtime-failure-drills`, `runtime-manager-identity`, `runtime-manager`,
`runtime-owner-lease-safety`, `runtime-ports`, `runtime-process`,
`runtime-reaper-plan`, `runtime-reaper`, `runtime-recovery-record`,
`runtime-verifier` (all `.test.ts`).

`[s-z]` (17): `status`, `supervisor-attempt-reuse`, `supervisor-cli`,
`supervisor-evidence-bundle`, `supervisor-failure-cost`, `supervisor-resume`,
`supervisor-runtime-reaper`, `supervisor-runtime-recovery-record`,
`supervisor-store`, `supervisor-worker-progress`, `verifier-shell`,
`worker-commands`, `worker-exit-path-audit`, `worker-lease`,
`worker-process-tree`, `workspace-boundary-integration`, `workspace-boundary`
(all `.test.ts`).

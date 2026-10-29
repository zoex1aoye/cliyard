# Pilot safety and reliability v1

> Status: Plan only; not frozen and not dispatched.
>
> Accepted implementation lineage:
> `3abbc7952389d8f7337377238bc7d3a0bc3808a6`.

## Purpose

Close the smallest set of reliability and safety gaps that currently prevents a
supervised single-repository pilot from being credible. The pilot must still
retain human Plan approval, human diff review and manual merge/push.

This Plan does not claim that background verification, OS sandboxing, dynamic
routing, parallel queue operation or 24-hour unattended delivery are complete.

## Observed evidence

- Run `c4d786ec-2dbe-449f-a65e-a23c6a6d673e` was blocked after an outer
  process-tree cleanup could not prove one vanished external group. Cleanup
  tracked 1,302 groups while membership inspection launched a full process-table
  read per group.
- The current mainline complete suite is 464/464 in 26.45 seconds against a
  fixed 30-second verifier command timeout.
- The rejected wrapper candidate accumulated two `$16` invocation guards across
  its initial attempt and one repair. The per-invocation cumulative policy did
  not span the repair lifecycle.
- The harness-eval npm wrapper still injects `--snapshot` before appended
  `run`/`compare`/`handoff` tails in the accepted code, so compare and handoff
  reject the injected option.
- The current DSH monitor interpolates ledger values into `innerHTML`, has no
  CSP, and the DSH plugin does not declare a tested `engines.dsh` range.

Authoritative detail is in `docs/CURRENT_STATE.md`,
`docs/KNOWN_GAPS_2026-10-28.md` and
`docs/evidence/DSH_0_2_2_ALPHA_2_REVIEW.md`.

## Goals

1. Make verifier command timeout explicit and bounded without weakening the
   default 30-second behavior for legacy contracts.
2. Make high-fanout external-group cleanup use bounded process-table snapshots
   rather than one full `ps` invocation per group, while retaining exact
   identity checks and fail-closed behavior.
3. Make configured guard budget cumulative across initial and repair
   invocations for one task, without treating the guard as provider-reported
   cost or balance.
4. Harden the DSH development plugin: safe DOM rendering, CSP, explicit tested
   DSH compatibility, and configured execution-profile aliases instead of
   model-controlled worker/model selection.
5. Restore experiment collection semantics for the npm `harness-eval` wrapper
   while keeping raw Eval commands strict.
6. Produce repeatable Harness Eval evidence and one final pilot-gate evidence
   document tied to exact commits and commands.

## Non-goals

- No background VerificationTask in this Plan.
- No OS filesystem or network sandbox.
- No dynamic routing, ProfileCatalog activation, parallel queue or daemon.
- No Control API implementation; this Plan only fixes plugin-local safety and
  compatibility metadata.
- No automatic merge, push, Plan approval or contract rewrite.
- No provider-reported cost, quota or balance claim.
- No DSH alpha2 runtime compatibility claim unless it is actually measured.

## Task graph

```text
wave 1, independent:
  verifier-command-timeout
  process-table-batch-cleanup
  task-budget-ledger
  dsh-plugin-hardening
  harness-eval-wrapper-semantics

wave 2:
  harness-eval-wrapper-semantics
    -> harness-eval-evidence-closeout

wave 3:
  all prior tasks
    -> pilot-foundation-evidence
```

The worker runner may start at most two Claude invocations concurrently for
this Plan. That is a local warm-start and not a provider quota claim.

## Path ownership

| Task | Exclusive write paths |
|---|---|
| `verifier-command-timeout` | `src/contracts/schema.ts`, `src/contracts/fromTaskfile.ts`, `src/planner/plan.ts`, `src/verification/verifier.ts`, `tests/contract-runtime.test.ts`, `tests/plan.test.ts`, `tests/verifier-shell.test.ts` |
| `process-table-batch-cleanup` | `src/agents/process-tree.ts`, `tests/worker-process-tree.test.ts` |
| `task-budget-ledger` | `src/agents/types.ts`, `src/agents/continuation.ts`, `src/agents/claude.ts`, `src/repair/loop.ts`, `tests/budget-continuation.test.ts`, `tests/claude-failure-cost.test.ts` |
| `dsh-plugin-hardening` | `plugins/dsh-cliyard/index.js`, `plugins/dsh-cliyard/lib/monitor.js`, `plugins/dsh-cliyard/package.json`, `tests/master-plugin.test.ts` |
| `harness-eval-wrapper-semantics` | `src/evaluation/cli.ts`, `tests/harness-eval-cli.test.ts`, `package.json` |
| `harness-eval-evidence-closeout` | `docs/evidence/HARNESS_EVAL_V0.md` |
| `pilot-foundation-evidence` | `docs/evidence/PILOT_FOUNDATION_RELIABILITY.md` |

No two tasks share a write path.

## Acceptance matrix

| Gate | Required observation |
|---|---|
| Legacy verifier behavior | Missing timeout still uses 30 seconds; invalid explicit values fail validation |
| Explicit timeout | A contract/Plan timeout overrides the verifier default per command; timeout remains a verifier failure |
| Cleanup scaling | High-fanout cleanup uses bounded table snapshots without a per-group `ps` command and still refuses identity ambiguity |
| Cleanup truth | Snapshot/inspection failure stays fail-closed; no broad or name-based kill |
| Budget lifecycle | Guard continuation/repair cannot silently reset the configured task cumulative guard |
| Budget truth | Guard remains a local cap, CLI-estimated/usage-only/unavailable cost semantics stay unchanged |
| Plugin safety | Ledger text is rendered without dynamic `innerHTML`; CSP is present; malicious task strings cannot become markup |
| Plugin compatibility | `engines.dsh` describes only tested/declared compatibility; Node 20 core remains unchanged |
| Plugin routing | Model-visible tool selects configured profile aliases and cannot inject arbitrary worker/model/permission values |
| Eval wrapper | `run`, `compare` and `handoff` compose through npm; record-only preserves failures; raw Eval exits stay strict |
| Eval repeatability | Baseline/candidate use two repetitions; failed repetitions and flips remain visible |
| Evidence | Exact commits, hashes, grouped full-suite commands, timings, cleanup and cost truth are recorded |

## Execution constraints

- Node 20 for cliyard core and verification.
- Claude Code with `deepseek-flash` for this self-host run.
- At most two concurrent Claude invocations as a conservative local warm start.
- 30-minute base deadline, one 10-minute healthy extension and a 40-minute
  total deadline.
- `$10` base guard, one `$5` budget continuation and a `$16` cumulative guard
  envelope with a `$1` overshoot reserve.
- No runtime service or default project port is required.
- Focused task verification stays below the current verifier timeout. Final
  evidence runs the complete test inventory in three alphabetical groups
  because the new timeout policy cannot be loaded by the already-running
  controller in this same run.
- Keep every task and integration worktree.

## Estimation and calibration

Run `npm run estimate-plan -- design/pilot-safety-reliability-v1.plan.json`
before commit. The static estimator is a planning aid only.

The estimator classifies every task as M:

| Task | turns | wall time | static guard |
|---|---:|---:|---:|
| verifier command timeout | 20-40 | 4-9 min | $4 |
| process-table batch cleanup | 20-40 | 4-9 min | $4 |
| task budget ledger | 20-40 | 4-9 min | $4 |
| DSH plugin hardening | 20-40 | 4-9 min | $4 |
| Eval wrapper semantics | 20-40 | 4-9 min | $4 |
| Eval evidence closeout | 20-40 | 4-9 min | $4 |
| Pilot foundation evidence | 20-40 | 4-9 min | $4 |

The aggregate static guard is `$28`. It is not a quote and is below the
observed historical cost of the wrapper repair path, so the self-host dispatch
uses a separate bounded envelope. Until this Plan's budget ledger fix becomes
the loaded controller in a later run, those limits apply per invocation rather
than across every repair.

Historical calibration:

- The wrapper task consumed a non-authoritative CLI estimate of about `$10.05`
  across one implementation and one repair.
- The current complete suite is near the fixed command timeout, so task
  verification uses focused files and the final task uses exhaustive groups.
- Provider balance, quota, price and safe concurrency remain unknown.

## Self-host provenance

Contracts must be compiled from a docs-composed base built from accepted code
`3abbc79` plus the committed Plan and current authority documents. The running
Supervisor is still old code. Therefore this run may prove task-local behavior
and produce reviewable artifacts, but it cannot claim that its own accepted
changes were loaded by the supervisor that produced them.

## Human review gate

`accepted` means the task evidence is ready for human inspection. It does not
authorize merge, push or pilot use. A person must review all diffs, the
integration head, cleanup evidence and the final pilot-gate document.

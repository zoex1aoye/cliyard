# Harness Eval evidence closeout

> Status: Plan only; not frozen or dispatched.
>
> Accepted implementation base:
> `3abbc7952389d8f7337377238bc7d3a0bc3808a6`.
>
> Target checkout: `codex/supervisor-v0-baseline`.

## Why this continuation exists

Run `cd40095a-8b11-4f11-8856-76d1d9f01d2f` is blocked overall. Two tasks
were accepted and integrated into the implementation base:

- `supervisor-evidence-integration` at
  `b1fb9ac25c8f0822f11779f123c0023c4df098ae`;
- `harness-eval-cli-and-suite` at
  `f546a547dd2b29c95a9a59fa9a62f9096317634f`.

The third task, `harness-eval-v0-evidence`, is rejected. Its draft worktree is
retained and is not an accepted artifact.

The accepted EvidenceBundle integration and Harness Eval CLI exposed two
remaining wrapper semantics during the first evidence run:

1. `npm run harness-eval` always injects `--snapshot`. That is correct for
   `run`, but compare/handoff commands become invalid.
2. Repeated experiments must preserve a scenario failure in the report without
   turning the collection command into an infrastructure failure. The raw
   `cliyard eval` command must still return a strict nonzero exit when a
   scenario fails.

The first baseline sample already caught a real deadline-extension flake:
5/6 scenarios and 11/12 repetitions passed, with one repetition timing out.
The correct behavior is to keep that failed report, continue comparison, and
make the failure visible; not to rerun until green or hide it in an average.

This Plan closes the immediately preceding Harness Eval evidence gate. It does
not advance to background verification, routing or sandbox work before the
current evidence gate is trustworthy.

## Goals

### Wrapper semantics

- `harness-eval` is an experiment collection wrapper.
- It enables snapshot materialization for dirty source worktrees.
- It records scenario failures and exits zero only when a complete report was
  produced.
- Malformed input, Git/snapshot errors, unsafe paths and execution
  infrastructure failures remain nonzero.
- `--snapshot` is valid for `run`; when supplied globally by the wrapper it is
  ignored by compare/handoff.
- Raw `cliyard eval run` remains strict: any failed scenario exits nonzero.

### Evidence closeout

After the wrapper fix:

- run baseline and candidate with two repetitions each;
- compare reports;
- preserve any failed repetition and flipped scenarios;
- rebuild and verify fresh-process handoff;
- record exact hashes and paths in `docs/evidence/HARNESS_EVAL_V0.md`;
- run focused, build and full suite.

## Task graph

```text
harness-eval-wrapper-semantics       ready wave 1
  -> harness-eval-v0-evidence-closeout  ready wave 2
```

There is no parallel wave. The dependency is real: collecting evidence through
the broken wrapper would reproduce the observed failure and create a second
misleading document.

## Path ownership

| Task | Exclusive write paths |
|---|---|
| `harness-eval-wrapper-semantics` | `src/evaluation/cli.ts`, `tests/harness-eval-cli.test.ts`, `package.json` |
| `harness-eval-v0-evidence-closeout` | `docs/evidence/HARNESS_EVAL_V0.md` |

Neither task may edit Eval core, the suite, Supervisor behavior, the Plan or the
contracts. Generated `.cliyard/evals` artifacts are observations, not a second
task-owned source tree.

## Acceptance matrix

| Gate | Must observe |
|---|---|
| npm composition | `harness-eval` composes with `run`, `compare` and `handoff`; only `run` uses snapshot materialization |
| exit semantics | record-only collection exits 0 only after a complete report; raw `eval run` remains strictly nonzero on scenario failure; infrastructure failures remain nonzero |
| regression tests | focused Eval tests, build and complete suite pass on the accepted artifact |
| repeatability | baseline and candidate each run two repetitions for all six scenarios; compare succeeds through the wrapper |
| failure truth | every failed repetition and flipped scenario remains in the report and evidence document |
| context reload | a fresh process reconstructs `nextAction` from a terminal fixture using only fixture bytes; both clean and tampered outcomes are recorded |
| provenance | exact commands, code identities, report hashes and unavailable metrics are in the evidence document |
| boundaries | path audit reports no writes outside contract-owned paths; process cleanup and WorkspaceBoundary are recorded without claiming OS isolation |

Baseline and candidate at the same tree are a repeatability experiment. They are
not evidence of a Harness improvement, model quality or provider-level
compaction.

## Estimates and execution constraints

`estimate-plan` heuristically classifies both tasks as M:

- wrapper semantics: 20–40 turns, 4–9 minutes, `$4` Claude guard;
- evidence closeout: 20–40 turns, 4–9 minutes, `$4` Claude guard.

The second estimate is explicitly under-calibrated. The rejected evidence
attempt took about 20 minutes and reported a non-authoritative Claude CLI
estimate of `$12.616913` against a `$16` guard. Those figures are historical
observations, not a DeepSeek bill, current provider price or balance.

Dispatch will therefore use conservative bounded policy rather than treating
the heuristic `$8` aggregate guard as a quote:

- Node 20;
- Claude Code with `deepseek-flash`;
- one serial task at a time;
- 30-minute base deadline, one 10-minute health-gated extension step and a
  40-minute total deadline;
- `$16` base guard, one allowed `$8` budget continuation and a `$25`
  cumulative guard envelope bounded by the provider-independent local guard;
- retain task and integration worktrees for human review.

Provider concurrency, balance, quota and actual price remain unknown until
observed. No default service port or shared runtime is required by this Plan.

## Non-goals

- no eval-core behavior change;
- no timeout-policy change;
- no hiding or retrying away a failure;
- no paid model quality evaluation;
- no daemon, routing or sandbox.

## Review and stop conditions

The run stops without merge on any changed contract, base mismatch, write-path
overrun, WorkspaceBoundary violation, cleanup failure, missing report, or
evidence claim not supported by a command. A failed scenario may be accepted as
recorded experiment evidence, but it may not be omitted, averaged away or
reported as success. `accepted` still requires a human diff review; this Plan
does not authorize merge or push.

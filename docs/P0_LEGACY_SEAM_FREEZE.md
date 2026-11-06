# P0 Legacy Seam Freeze

> Recorded: 2026-11-06 (Asia/Shanghai).
> Source: [delivery-control-plane-v2.md](../design/delivery-control-plane-v2.md) §7.1.
> Status: **binding** on `codex/supervisor-v0-baseline` after human merge of
> PR stack #1–#5 (landed tip `a0609e8`, 2026-11-06 Asia/Shanghai).

## Why

P0 closes the legacy seam so the rewrite can proceed without adding features to
surfaces that v2 will replace. Code for pilot closeout and cost-truth resume
retention is already on the mainline ancestry (`c1d0dbb` / `fb665ab`,
`c5714db`). Authority docs and this freeze declaration were the remaining P0
gap.

## Freeze list (operative once binding)

After the pending stack is human-merged, **no new features** land on:

| Seam | Freeze meaning | Replacement target |
| --- | --- | --- |
| JSON-file state stores (`ledger.json`, `queue.json`, `runs/*.json`, related `.cliyard` JSON) | No new write-path features or schema expansions beyond safety blockers | P1 StateStore (SQLite event-sourced) |
| Foreground Supervisor / `runQueue` feature surface | No new orchestration features on the foreground-only entry | P2 `cliyardd` + Control API |
| PID / PGID-as-authority registry | No new ownership features that treat PID/PGID as recovery authority | RuntimeHandle authority (PID/PGID diagnostic only) |
| DSH / dev monitor feature surface | No new monitor product features on the string-HTML / plugin path | Control API read client / replaceable UI |

## Still allowed until replaced

- Safety-blocker patches on the frozen seams (security, data loss, incorrect
  cost truth, process-cleanup fail-closed).
- Port/keep work from §7.1 (contracts, Plan compiler, worktree manager,
  EvidenceBundle, failure taxonomy, cost truth, RuntimeManager, path audit,
  self-host workflow, skills and docs).
- New work that targets the v2 seams listed in delivery-control-plane-v2.

## Binding evidence

Merged and reachable from `codex/supervisor-v0-baseline`:

1. [#1 deterministic integration full-suite gate](https://github.com/zoex1aoye/cliyard/pull/1)
2. [#2 P2b full-suite regression fix](https://github.com/zoex1aoye/cliyard/pull/2)
3. [#3 estimate-plan telemetry calibration](https://github.com/zoex1aoye/cliyard/pull/3)
4. [#4 Linux POSIX verifier / process-tree hardening](https://github.com/zoex1aoye/cliyard/pull/4)
5. [#5 P0 authority closeout](https://github.com/zoex1aoye/cliyard/pull/5)

Land commit: `a0609e8` (`merge: land PR stack #2–#5 onto supervisor baseline`).
The freeze is binding on mainline; only safety-blocker patches may touch the
listed seams until their v2 replacements land.

## Explicit non-claims

- This file does not approve Delivery Control Plane v2; human review of that
  design remains required before P1 Plans are frozen for dispatch.
- This file does not claim supervised pilot readiness.
- This file does not merge PRs or rewrite history.

# StateStore path unification v0

> Residual closeout after ledger/journal production attach. Not P3.

## Problem

Two durable StateStore locations coexist:

| Writer | Path |
|---|---|
| Supervisor / daemon | `.cliyard/runtime/statestore/state.sqlite` (+ `facts.json` fallback) |
| Queue / ledger / journal | `.cliyard/state.db` (+ `state-fallback/` / `state-evidence/`) |

Domain facts can therefore land in different files. That residual was called out
after P1b / ledger-journal cutover.

## Fix

1. Canonical authority: `.cliyard/state.db`, evidence `.cliyard/state-evidence/`,
   JSON-file fallback under `.cliyard/state-fallback/`.
2. Shared path helper in `src/statestore/paths.ts`; supervisor, daemon, queue
   and control-domain cutover all resolve through it.
3. One-shot relocate when only the legacy supervisor directory has bytes:
   move `state.sqlite` → `state.db`, `facts.json` → fallback, `evidence/` →
   `state-evidence/`, write a `RELOCATED.json` marker under the legacy dir.
4. Fail closed (`needsHuman`) when both canonical and legacy authorities have
   durable bytes — never pick a silent winner.

## Non-goals

- No authenticated Control API write surface (deferred; read API stays as-is).
- No P3 sandbox / VerificationTask.
- No deletion of legacy JSON domain exports (`runs/*.json`, `queue.json`, …).
- No claim that every historical repo has been relocated; relocate is
  first-open best effort with fail-closed dual-authority detection.

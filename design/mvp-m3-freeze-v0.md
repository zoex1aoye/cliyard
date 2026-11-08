# MVP M3 — Plan draft compiler + human `/freeze`

> After M2 lands (`e0f6bb6` / PR #29).
> Gate from [dsh-plugin-mvp-roadmap-v0.md](./dsh-plugin-mvp-roadmap-v0.md).

## Goal

Close the Plan → Contract gate for the DSH plugin MVP:

1. **Compile** an MVP Plan JSON into **unfrozen** local-cli TaskContract draft(s)
   (`frozen: false`, no `frozenAt`).
2. **Freeze** (human `/freeze` equivalent): set `frozen: true` + `frozenAt`,
   validate with `assertLocalCliTaskContract`, persist bytes, write a
   `.sha256` sidecar.
3. **Refuse dispatch** of unfrozen contracts (idle-spin already requires
   `frozen=true`; keep that fail-closed).
4. **Immutability**: after freeze, silent byte edits fail the sidecar hash
   check until a new `contractId` / version is frozen.

Surfaces: `cliyard mvp-compile`, `cliyard mvp-freeze`, optional DSH tools
`cliyard_mvp_compile` / `cliyard_mvp_freeze`.

## Non-goals

- Do not auto-approve Plans or auto-dispatch on compile.
- Do not call coding models (compiler is deterministic JSON reshape).
- Do not deepen mainline `plan-dispatch` / queue freeze productization.
- Do not implement M4 real CLI demos.
- Do not auto-merge.

## Acceptance

- Compile produces draft with `frozen: false`.
- Freeze writes `frozen`/`frozenAt` + valid schema + sha256 sidecar.
- `mvp-test` / idle-spin rejects unfrozen drafts.
- Tampering frozen bytes without re-freeze fails hash check.

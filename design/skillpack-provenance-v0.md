# SkillPack provenance v0

> After intervention ledger land (`0d96d6` / PR #17). Priority item 9 in
> `docs/CURRENT_STATE.md`. Semantics from
> `design/continuous-harness-v2.md` §SkillPack.

## Problem

Rules/skills under `.agents/` are execution inputs, but runs do not record a
digest of which SkillPack (id, version, entrypoint, per-skill digests) was in
force. Without provenance, harness changes cannot be audited against a run.

## Fix (v0)

1. **`SkillPack` model** — id, version, digest, entrypoint, `skills[]`
   `{ name, digest, entrypoint }`, `compatibility.harnesses` (+ optional
   `minControlPlaneVersion`).
2. **`buildSkillPackFromAgentsDir`** — scan `<repo>/.agents/skills/*/SKILL.md`
   (and optional pack manifest if present); SHA-256 file digests; pack digest
   over canonical skill list; refuse empty packs / path escape.
3. **Durable snapshot** — write `.cliyard/skillpacks/<id>@<version>.json`
   atomically; `loadSkillPack` / `listSkillPacks`.
4. **Run binding helper** — `bindSkillPackDigest(runId, pack)` returns a
   bounded provenance record suitable for later RunManifest attach (v0 stores
   under `.cliyard/skillpacks/bindings/<runId>.json` without rewriting
   RunManifest schema yet).
5. **Tests + evidence** — fixture skills dir; digest stable; escape refused;
   CURRENT_STATE / ROADMAP / README touch.

## Non-goals

- Do not require eval-fixture gates before recording a digest (noted as
  residual for default SkillPack promotion).
- Do not mutate `.agents/` content.
- Do not implement ProfileCatalog / routing.
- Do not call a model.

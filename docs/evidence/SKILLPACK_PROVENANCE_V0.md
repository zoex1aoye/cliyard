# SkillPack provenance v0 — evidence

> Measured 2026-11-07 (Asia/Shanghai).
>
> Branch: `cursor/skillpack-provenance-v0-0da8`.
> Plan: `design/skillpack-provenance-v0.plan.json`.
> Accepted integration base: `0d96d61` (intervention ledger / PR #17).

## 1. What landed

- `SkillPack` model with per-skill SHA-256 digests and pack digest.
- `buildSkillPackFromAgentsDir` scans `.agents/skills/*/SKILL.md`, refuses
  escaping symlinks and empty packs.
- Durable snapshots under `.cliyard/skillpacks/<id>@<version>.json`.
- Run bindings under `.cliyard/skillpacks/bindings/<runId>.json` (RunManifest
  schema attach deferred).

## 2. Commands

```bash
npm run build   # exit 0
npx tsx --test tests/skillpack-provenance.test.ts
# → tests 3 / pass 3 / fail 0
```

## 3. Non-claims

- No eval-gated default SkillPack promotion.
- No `.agents/` mutation; no ProfileCatalog; no RunManifest field yet.

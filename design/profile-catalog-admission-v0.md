# ProfileCatalog + hierarchical admission v0

> After SkillPack land (`8e33df3` / PR #18). Priority item 10 in
> `docs/CURRENT_STATE.md`. Direction from
> `design/dynamic-parallel-admission-v0.md` and existing
> `src/execution/profile.ts` / `src/runtime/resource-snapshot.ts`.

## Problem

ExecutionProfile exists for queue items, and resource snapshots can record
unknown capacity, but there is no activated ProfileCatalog and no
conjunctive hierarchical admission decision that keeps unknown provider
bindings at **1 in-flight probe** instead of treating warm-start `3` as a
hard permanent limit.

## Fix (v0)

1. **`ProfileCatalog`** — durable activated profiles
   (`.cliyard/profile-catalog.json`): add/get/list/remove using existing
   `parseExecutionProfile` / secret-free rules; refuse credential-like fields.
2. **Binding capacity** — per `profileId`: `configuredMax: number | null`
   and `limitSource`. When `configuredMax` is null/unknown →
   `effectivePermit = 1` (probe). Never invent public nominal quotas.
3. **`admitHierarchical`** — conjunctive `min()` over scopes that are present:
   global task budget, per-item task budget, profile permit, optional host
   CPU/RAM hints from a ResourceSnapshot. Missing scopes stay `null` and are
   skipped (not treated as infinity). Decision is explainable
   (`admitted`, `effective`, `limitingScope`, `reasons[]`).
4. **Warm start note** — document that `3` is only a scheduler demand sample,
   not encoded as a permanent product constant in this module.
5. **Tests + evidence** — unknown profile → 1 permit; conjunctive min;
   refuse secrets; CURRENT_STATE / ROADMAP / README touch.

## Non-goals

- Do not implement learned ramp / 429 auto-scale broker.
- Do not dispatch the queue automatically from this module.
- Do not hard-code provider brand concurrency tables.
- Do not claim 24h unattended parallel delivery.

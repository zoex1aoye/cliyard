# Execution routing (Routing B) v0

> After acceptance-flow Reviewer wire land (`a5d1c47` / PR #22).
> Residual from `docs/CURRENT_STATE.md` item 10 and
> `docs/PRODUCT_STRATEGY_V2.md` §3.1–3.2.
>
> Naming: PRODUCT_STRATEGY calls this **Routing B** (execution attribution).
> **Routing A** (design/Plan attribution) stays a later slice.

## Problem

ProfileCatalog and opt-in admission exist, but there is no deterministic,
audited selector that chooses an **activated** ExecutionProfile from task
capability requirements. Queue items still assume an operator-supplied
profile; “which CLI + model” is not a control-plane decision.

## Fix (v0)

1. **`TaskRoutingRequirements`** — secret-free needs: optional
   `requireMappedProgress`, `requireProviderSessionResume`, preferred
   `runtimeId` / `providerId` / `modelId` (preferences, not inventions).
2. **`selectExecutionProfile`** — candidates = activated catalog only;
   exclude capability mismatches; score preferred matches; stable
   tie-break on `profileId`; explainable
   `{ selected, candidates, reasons[] }` (or `none` / `blocked`).
3. **Optional capacity hint** — when `respectAdmission` is set, skip
   profiles whose effective remaining permit is 0 (unknown still allows
   the 1-probe). Does not dispatch and does not invent brand quotas.
4. **Durable observation** — optional append to
   `.cliyard/routing/decisions.jsonl` (bounded reasons; no secrets).
5. **Tests + evidence** — capability filter, preference ranking, empty
   catalog fail-closed; CURRENT_STATE / ROADMAP / README bilingual.

## Non-goals

- Do not implement Routing A (design elaborator attribution).
- Do not auto-dispatch queue items or mutate queue state.
- Do not learn 429 ramps or dynamic scoring from telemetry.
- Do not hard-code provider brand concurrency tables.
- Do not claim unbounded parallel delivery.

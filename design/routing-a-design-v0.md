# Routing A — design elaborator attribution v0

> After router→queue wire land (`ba2f458` / PR #24). Residual from
> `docs/CURRENT_STATE.md` item 10 and `docs/PRODUCT_STRATEGY_V2.md` §3.1:
> **Routing A** (who writes the design/Plan draft).

## Problem

Routing B selects an activated ExecutionProfile for task *execution*, and the
queue can opt into that selector. There is still no deterministic, audited
control-plane decision for *design elaboration* attribution — who drafts the
Plan — distinct from Master intent ownership and from Worker execution.

## Fix (v0)

1. **`DesignRoutingRequirements`** — secret-free needs: optional
   `mode` (`routine` | `elevated`), preferred `runtimeId` / `providerId` /
   `modelId` / `profileId`. `elevated` is an operator signal only; this module
   never ranks models by name as “stronger”.
2. **`selectDesignElaboratorProfile`** — candidates = activated ProfileCatalog
   only; optional preferredProfileId exact match; otherwise preference score +
   stable `profileId` tie-break (same discipline as Routing B). Explainable
   `{ selected, candidates, reasons[], mode }`. Fail closed on empty catalog.
3. **Durable observation** — append to `.cliyard/routing/decisions.jsonl` with
   `role: "design-elaborator"` (extend record shape; Routing B rows omit role
   or use `"execution"`).
4. **Exports + tests + evidence** — `src/admission/design-routing.ts`;
   CURRENT_STATE / ROADMAP / README (+ zh) bilingual.

## Authority invariant

Master retains intent ownership, Plan review/finalize, freeze and dispatch.
Routing A only attributes the *draft* elaborator binding. An LLM may recommend
a mode/profile; only the control plane persists the decision.

## Non-goals

- Do not auto-approve Plans, freeze contracts, or dispatch workers.
- Do not invent model-strength tables from brand/model names.
- Do not wire Task Architect / Master CLI yet (later opt-in slice).
- Do not learn 429 ramps or claim unbounded parallel delivery.
- Do not enable Routing A by default as a product gate.

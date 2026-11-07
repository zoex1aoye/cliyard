# Routing A — design elaborator attribution v0 — evidence

> Measured 2026-11-07 (Asia/Shanghai).
>
> Branch: `cursor/routing-a-design-v0-0da8`.
> Plan: `design/routing-a-design-v0.plan.json`.
> Accepted integration base: `ba2f458` (router→queue wire / PR #24).

## 1. What landed

- `selectDesignElaboratorProfile` over **activated** ProfileCatalog only.
- `DesignRoutingRequirements`: `mode` (`routine` | `elevated`) + preferences /
  `preferredProfileId`. Elevated without preferences **fails closed** — no
  model-strength invention from brand/model names.
- Decision carries `role: "design-elaborator"`; durable
  `.cliyard/routing/decisions.jsonl` record may include `role`.
- Master/human freeze authority unchanged; no Architect/CLI wire in this slice.

## 2. Commands

```bash
npm run build   # exit 0
npx tsx --test tests/routing-a-design.test.ts tests/execution-routing.test.ts
# → tests 6 / pass 6 / fail 0
```

## 3. Non-claims

- No auto Plan approve / contract freeze / worker dispatch.
- No Task Architect or Master CLI opt-in wire yet.
- No learned 429 ramp; no unbounded parallel claim.
- Routing A remains a selector, not a default-on product gate.

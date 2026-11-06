# SandboxAdapter + nono v0 — evidence

> Measured 2026-11-06 (Asia/Shanghai) on Linux 6.12.113+ x86_64,
> Node `v22.23.4`.
>
> Branch: `cursor/sandbox-adapter-nono-v0-0da8`.
> Plan: `design/sandbox-adapter-nono-v0.plan.json`.
>
> Observational only. Does not authorize pilot use or claim OS write prevention.

## 1. What landed

- `src/sandbox/` — `SandboxAdapter`, capability gate, `SandboxReport`,
  `UnavailableSandboxAdapter`, `NonoSandboxAdapter` pinned to **nono
  `v0.81.0`** (`nolabs-ai/nono`).
- Optional observational `sandbox` on `RunTaskState` and EvidenceBundle task
  projection (never grants acceptance).
- Focused tests for gate ranks, pin mismatch → unavailable, fake binary
  version probe, and evidence projection.

## 2. Commands

```bash
npm run build   # exit 0
npx tsx --test tests/sandbox-adapter.test.ts tests/evidence-bundle.test.ts
# → tests 16 / pass 16 / fail 0
```

## 3. Authority / honesty

| Claim | Status |
|---|---|
| Capability gate refuses silent downgrade | Measured in unit tests |
| nono version pin `0.81.0` | Declared; probe mismatches become unavailable |
| OS write prevention of worker descendants | **Not claimed** — P3b |
| Worker wrap via `nono run` | **Not claimed** — P3b |
| WorkspaceBoundary still guard-only fallback | Unchanged |

## 4. Non-claims

- Version probe ≠ measured sandbox conformance.
- No MXC / microVM.
- No automatic Plan approval or merge.

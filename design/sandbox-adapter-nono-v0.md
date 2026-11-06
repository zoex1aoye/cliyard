# SandboxAdapter + nono v0 (P3)

> Human directed 2026-11-06: residual path unify merged; start P3 main slice.
> Direction from `design/delivery-control-plane-v2.md` §D6/D9 and §8 P3.

## Problem

WorkspaceBoundary is guard-only detection. There is no OS write-prevention
adapter, no capability gate that refuses silent downgrade, and no sandbox
report in evidence. DCP v2 requires a provider-neutral `SandboxAdapter` with
a pinned `nono` backend.

## Fix (v0)

1. Provider-neutral `SandboxAdapter` with honest `Capabilities()`, prepare /
   release lifecycle hooks, and a bounded `SandboxReport`.
2. Deterministic capability gate (same rank semantics as ExecutionSupervisor):
   requirements that exceed the backend → refuse or require explicit human
   approval; never silent host downgrade.
3. `NonoSandboxAdapter` pinned to **nono `v0.81.0`**
   (`nolabs-ai/nono`). Probe `nono --version`; mismatch or missing binary →
   unavailable backend with `unsupported` isolation claims.
4. Optional `sandbox` field on `RunTaskState` / EvidenceBundle task projection
   so reports can enter evidence without granting acceptance.
5. Focused acceptance tests for gate, pin probe, unavailable path, and report
   shape. Live `nono run` worker wrap is **out of scope** for v0 (P3b).

## Non-goals

- No silent unsandboxed fallback when filesystem isolation is required.
- No MXC / microVM backends.
- No claim that probing nono equals measured write prevention of every
  descendant (conformance wrap lands in P3b).
- No automatic Plan approval or merge.
- WorkspaceBoundary remains the independent post-run detection fallback.

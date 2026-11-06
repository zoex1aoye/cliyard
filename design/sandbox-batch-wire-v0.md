# P3c — sandbox production wire into worker batch

> Follows P3b wrap/measure (`enforced: true` on Landlock hosts after
> home-scoped probe fix).

## Problem

`SandboxAdapter`, capability gate, measurement and `spawn({ sandboxWrap })`
exist, but codex/claude batch never calls them. Workers still start bare.

## Fix

1. `prepareWorkerSandbox(...)` helper: select/create nono adapter, `prepare`,
   return `{ ok, report, wrap }` or a structured refusal.
2. Opt-in on `CodexWorkerOptions` / `ClaudeWorkerOptions` and batch
   `WorkerBatchOptions.sandbox` (or `CLIYARD_SANDBOX=1`). Dry-run stays
   unwrapped. When enabled and prepare fails/gaps → attempt fails closed with
   a sandbox failure record (no silent host downgrade).
3. Pass `sandboxWrap` into `processTree.spawn`; attach `SandboxReport` on
   `AgentResult` → `LoopResult` → RunManifest `task.sandbox`.
4. Focused tests with fixture worker + injected measurement/prepare.
5. Live smoke on this host: enable sandbox, wrap a finite shell write probe
   under pinned nono (Cursor CLI used when present as optional worker binary;
   otherwise nono-wrapped `/bin/sh` is the measured acceptance path here).

## Non-goals

- No force-enable for every CI dry-run.
- No network/credential measurement.
- No MXC/microVM.
- WorkspaceBoundary remains independent post-run detection.

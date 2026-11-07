# P3c sandbox production batch wire — evidence

> Measured 2026-11-07 (Asia/Shanghai) on Linux 6.12.113+ x86_64,
> Node present, pinned nono `v0.81.0` at `/tmp/nono-pin/nono`.
>
> Branch: `cursor/sandbox-batch-wire-0da8`.
> Plan: `design/sandbox-batch-wire-v0.plan.json`.
> Contracts: `design/sandbox-batch-wire-v0.contracts.json`.

## 1. What landed

- `src/sandbox/worker-wire.ts` — `prepareWorkerSandbox`,
  `createSandboxRefusalFailure`, `isWorkerSandboxEnabled`,
  `wrapWorkerCommand` (opt-in via `sandbox.enabled` or `CLIYARD_SANDBOX=1`).
- Codex / Claude adapters prepare before spawn, fail closed on gaps, pass
  `sandboxWrap` into `processTree.spawn`, attach `SandboxReport` on
  `AgentResult` (including refuse and spawn-error paths when prepare ran).
- `LoopResult.sandbox` threaded from the last valid worker report;
  `CodexBatchOptions.sandbox` forwarded into adapters; RunManifest
  `task.sandbox` checkpointed on accept/reject.
- Dry-run remains unwrapped.
- Focused tests + live smoke (Cursor CLI absent on this host; acceptance used
  nono-wrapped `/bin/sh`).

## 2. Commands

```bash
npm run build   # exit 0
npx tsx --test tests/sandbox-batch-wire.test.ts tests/sandbox-wrap.test.ts
# → tests 10 / pass 10 / fail 0
npx tsx scripts/sandbox-p3c-smoke.ts
# → prepareStatus=prepared, filesystemIsolation=partial,
#    allowWriteOk=true, denyWriteHeld=true, p3c smoke ok
```

## 3. Live smoke facts

- Landlock enforcement held: outside-allow write returned Permission denied;
  inside-allow write persisted.
- `cursorCli: null` — Cursor CLI was not on PATH; shell probe under pinned
  nono is the measured acceptance path here (optional CURSOR_CLI /
  CLIYARD_WORKER_BINARY when present).

## 4. Non-claims

- Sandbox is still **opt-in**, not default-on for every batch.
- No network/credential isolation measurement.
- No claim that Cursor CLI itself was executed on this host.
- WorkspaceBoundary remains independent post-run detection.

# P3b nono worker wrap + filesystem measurement — evidence

> Measured 2026-11-07 (Asia/Shanghai) on Linux 6.12.113+ x86_64,
> Node `v22.23.4`, pinned nono `v0.81.0`.
>
> Branch: `cursor/sandbox-nono-worker-wrap-0da8`.
> Plan: `design/sandbox-nono-worker-wrap-v0.plan.json`.

## 1. What landed

- `buildNonoWrapCommand` / `applySandboxWrapToSpawn` — opt-in `nono wrap`
  argv for worker embedding.
- `measureNonoFilesystemEnforcement` — allow-inside must succeed; outside
  write must not persist.
- `NonoSandboxAdapter` sets `filesystemIsolation` to `partial` only when
  measurement passes; otherwise `unsupported` with an honest note.
- `WorkerProcessTreeManager.spawn({ sandboxWrap })` optional rewrite.
- Focused tests **13/13** with sandbox-adapter suite.

## 2. Commands

```bash
npm run build   # exit 0
npx tsx --test tests/sandbox-wrap.test.ts tests/sandbox-adapter.test.ts
# → tests 13 / pass 13 / fail 0
```

## 3. Host measurement (this cloud image)

`/sys/kernel/security/landlock` is absent. Live probe against the pinned
`nono` binary reports `enforced: false` because an outside-allow write still
persists. Therefore this host must not claim filesystem isolation; the
adapter correctly keeps `filesystemIsolation: "unsupported"` and the
capability gate refuses tasks that require `partial`/`full`.

## 4. Non-claims

- No default-on wrap for every codex-batch worker.
- No network/credential enforcement measurement.
- No claim of Landlock/seatbelt on hosts where the probe fails.
- WorkspaceBoundary remains guard-only post-run detection.

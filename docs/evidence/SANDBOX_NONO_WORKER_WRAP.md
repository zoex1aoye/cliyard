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

Landlock **is** compiled in and active (`CONFIG_SECURITY_LANDLOCK=y`, LSM list
includes `landlock`). An early false negative came from placing the allow/deny
probe under `/tmp`, which nono includes in its default system grants — outside
writes still succeeded and looked like "no enforcement".

After moving the probe under `~/.cache/cliyard/nono-measure-*`, the same pinned
nono `v0.81.0` reports `enforced: true` on this host (allow write ok, deny
write held). `/sys/kernel/security/landlock` may be absent as a directory even
when the LSM is loaded; use the syscall / measurement, not that path alone.

## 4. Non-claims

- No default-on wrap for every codex-batch worker.
- No network/credential enforcement measurement.
- No claim of Landlock/seatbelt on hosts where the probe fails.
- WorkspaceBoundary remains guard-only post-run detection.

# P3b — nono worker wrap + write-prevention measure

> Follows merged P3 adapter v0 (`SandboxAdapter` + pin `v0.81.0`).

## Problem

v0 only probes `nono --version`. It does not wrap worker CLIs and does not
measure whether the host can enforce filesystem isolation. On kernels without
Landlock (observed in this cloud image), `nono run -a …` may still allow
writes outside the allowlist — claiming `partial` isolation from a version
probe alone would be dishonest.

## Fix

1. `buildNonoWrapCommand` — argv for `nono wrap -a <workspace> [-r <repo>] --
   <worker> …` (silent, allow-cwd when needed).
2. `measureNonoFilesystemEnforcement` — spawn a tiny probe under the pinned
   binary: write inside allowlist must succeed; write outside must fail or the
   outside file must be absent. Record a bounded measurement report.
3. Upgrade `NonoSandboxAdapter` / selection so filesystem capability is
   `partial` only when measurement passes; otherwise `unsupported` with an
   honest note (e.g. missing Landlock). Capability gate still refuses silent
   downgrade when a task requires isolation.
4. Optional spawn wrap helper used by worker process-tree spawn when an
   enabled sandbox prepare result is `prepared` (feature flag /
   `SandboxSpawnOptions`); default remains unwrapped so existing runs do not
   break.
5. Focused tests: argv shape; measurement fails closed without Landlock /
   with a stub binary; gate refuses `filesystemIsolation: full|partial` when
   measurement says unsupported. Live pass on Landlock hosts is recorded when
   available, otherwise `skipped` with reason.
6. Evidence + CURRENT_STATE: P3b wrap helper + measurement landed; enforced
   isolation only claimed where measured.

## Non-goals

- No MXC / microVM.
- No claim of enforcement on hosts without Landlock/seatbelt.
- No automatic enablement for every codex-batch run (opt-in wrap).
- WorkspaceBoundary remains the post-run detection fallback.

# DeepSeek Harness 0.2.2-alpha.2 review

> Reviewed: 2026-10-29
>
> This note records upstream facts and cliyard-specific implications. It is not
> a compatibility claim and does not make DSH a control-plane authority.

## Version evidence

- The installed macOS application reports `0.2.1-rc.3`.
- npm dist-tags at review time were `latest=0.2.1-rc.2`,
  `next=0.2.1-rc.4`, and `alpha=0.2.2-alpha.2`.
- The upstream `master` head was `f3803c96974ad4a94195fb97e5c637e9c2a3afe3`,
  the `dsh-v0.2.2-alpha.2` release commit.
- `0.2.1-rc.4` only fixes diagnostic output leaking into ACP stdout.
- `0.2.2-alpha.2` declares Node.js `>=24.9.0` and contains compatibility
  breaking Session, Model Routing, Cordis and tool APIs.

Primary sources:

- <https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.2.1-rc.4>
- <https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.2.2-alpha.2>
- <https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-alpha.2/docs/architecture.zh.md>

## Relevant upstream changes

### Session and client architecture

- Session snapshots, event-log subscriptions, runtime status and event
  projections now have separate access paths.
- Initialization events can be subscribed before their publication completes,
  and cancellation waits for acquired resources to clean up.
- Session projection registration returns an asynchronous handle with owned
  state and disposal.

The useful semantic is not Cordis-specific: durable snapshot, ordered events
with cursor replay, lightweight status and rebuildable projections are separate
DTOs. cliyard should expose the same distinction without exposing DSH internals.

### Tools and model selection

- Tools can be admitted per step through registration conditions.
- Prompt assembly and execution consume the same resolved tool set.
- A step freezes its provider, model and reasoning selection before prompt
  assembly. `agent/request` can no longer reroute the model.
- Native and PTC execution are explicit executor plugins; custom callers use
  `tools.resolve` and `tools.executable`.

This supports cliyard's pending rule that an approved ExecutionProfile is
frozen at admission and cannot silently change during a request retry.

### Worktrees, change requests and statistics

- The experimental Forge bundle adds provider-neutral PR/MR status, diff,
  worktree and merge surfaces.
- Forge checks merge rules, bounds polling and refuses a merge when the
  confirmed head SHA is stale.
- The Statistics view derives context, cache, model, tool and retry metrics
  from session events. Unknown windows show `—` instead of inventing values.

cliyard should reuse these UI and provider patterns, not duplicate them. Its own
run events should expose task wait, model, tool, verifier, repair, runtime and
human-wait durations using the same observation-versus-estimate discipline.

### External CLI delegation

The experimental `subagent_oar` tool can delegate a single independent text
task to local Codex or Claude Code. Its documented limits are material:

- one-shot only, with no continue or resume;
- no structured output or progress stream;
- no DSH-managed descendant process cleanup;
- no task-level evidence or acceptance;
- native file changes before cancellation are retained.

It is a useful reference for exposing frozen runtime aliases to a model. It is
not a substitute for cliyard contracts, WorkerLease, Verifier or RunManifest.

### Plugins and security

- Plugin packages can expose rich details, update third-party versions, and
  restore the prior version after some hot-update failures.
- Plugin compatibility uses `engines.dsh` before falling back to DSH peer
  dependencies.
- Web Fetch may now reach loopback, private networks and cloud metadata hosts;
  deployments must enforce their own network policy.
- DSH explicitly remains developer-preview software without a security audit
  or trustworthy sole sandbox.

## cliyard impact

| Area | Current cliyard state | Required adjustment | Priority |
|---|---|---|---|
| DSH compatibility | Desktop rc3; plugin untested against rc4/alpha2 | Add a DSH version matrix, `engines.dsh`, and a Node 24.9 plugin lane while keeping core Node 20 | P0 |
| Cockpit UI | Standalone HTML monitor plus empty ledger-watch callback | Consume a versioned Control API; use native `sidebarRightTabs` or a browser tab | P1 |
| Control observations | Ledger/status snapshots are not a client-neutral event stream | Add snapshot version, ordered event cursor, reconnect replay and rebuildable projections | P1 |
| Worker selection | Plugin tool exposes free-form worker/model values | Accept a configured, frozen `executionProfileId`; keep arbitrary flags out of model input | P0 |
| Progress metrics | No task-level model/tool/verifier/runtime timeline | Derive metrics from durable events; mark missing observations unknown | P1 |
| Git integration | Worktree path audit and branches exist, but no provider seam | Add reviewed-head-aware forge/PR references; reuse DSH Forge rather than build it | P2 |
| Generic delegation | cliyard owns contracts, verification and recovery | Do not adopt `subagent_oar` as orchestrator; borrow only its constrained alias model | Decision |
| Dashboard security | Task and event fields are interpolated into `innerHTML` | Remove string HTML assembly, add CSP and authenticate future action APIs | P0 |

## Compatibility decision

- Keep the cliyard core and `engines.node >=20`.
- Treat DSH host/runtime compatibility as an adapter concern.
- Do not silently move linked plugins to alpha2.
- `0.2.1-rc.4` is the low-risk next compatibility target.
- `0.2.2-alpha.2` stays experimental until plugin load, tool registration,
  cancellation, lifecycle cleanup and a Control API client pass conformance
  tests under Node 24.9.
- `dsh-better-sidebar` becomes an optional enhancement. Native sidebar support
  should be evaluated first and pinned to tested DSH versions.

## Unverified

- The current plugin has not been loaded into rc4 or alpha2.
- No Node 24.9 compatibility run exists.
- Native sidebar registration and DSH Forge integration are not implemented.
- DSH's statistics and Forge views are not cliyard acceptance evidence.
- No claim is made that alpha2 stabilizes the developer-preview plugin API.

# dsh-cliyard — Master plugin for DeepSeek Harness

Thin bridge: **DSH GUI = Master 壳**，**cliyard = 控制面**。  
用户故事：[docs/USER_STORY_STEP1.md](../../docs/USER_STORY_STEP1.md).

## Compatibility status

- Current local DSH Desktop: `0.2.1-rc.3`.
- The plugin has not been conformance-tested against `0.2.1-rc.4` or
  `0.2.2-alpha.2`.
- cliyard core remains on Node 20. DSH alpha2 uses Node 24.9 or newer, so its
  host/runtime compatibility must be tested as a separate plugin lane.
- Native DSH sidebar tabs replace the assumption that
  `dsh-better-sidebar` must be the first cockpit. The third-party sidebar
  remains optional until native tab compatibility is measured.

See [DSH 0.2.2-alpha.2 review](../../docs/evidence/DSH_0_2_2_ALPHA_2_REVIEW.md).

## Without DSH (macOS demo)

From the cliyard repo root:

```bash
# Terminal A — monitor console (reads .cliyard/ledger.json)
npm run master-monitor

# Terminal B — dispatch two parallel tasks through the configured worker
npm run master-dispatch
# → opens http://127.0.0.1:3927/ after monitor is up; refresh to see status

# S2 dry (Codex adapter + worktrees, no API):
npm run master-dispatch -- --worker codex

# Claude Code + DeepSeek dry-run:
npm run master-dispatch -- --worker claude

# Plan bridge: compile first, dispatch second
npm run master-dispatch -- \
  --plan examples/glass-parallel.plan.json \
  --repo ~/Documents/pers-project/ui-prototype
npm run master-dispatch -- \
  --plan examples/glass-parallel.plan.json \
  --repo ~/Documents/pers-project/ui-prototype \
  --dispatch --worker claude --model 'deepseek-flash' \
  --real-worker --keep-worktrees
```

## With DeepSeek Harness

```bash
# requires dsh CLI (npx @deepseek-ai/dsh …)
dsh plugin --profile web add link:"$(pwd)/plugins/dsh-cliyard"
dsh web
```

On load the plugin starts the monitor on `monitorPort` (default **3927**) and exposes `ctx.cliyard.dispatch()`, `.dispatchPlan()` and `.snapshot()`.
It also registers the agent tool **`cliyard_plan_dispatch`**. Ask DSH to turn
the reviewed module requirements into that tool's structured Plan; call it
once with `dispatch: false` to compile, then with `dispatch: true` to run.
The model call can set `dryRun: false` only when a real worker run is intended.
Tool dispatch is backgrounded: the call returns pid + log path immediately and
the monitor/ledger remain the source of truth for running → accepted/rejected.

The tool is expected after restarting an already-running Desktop app; changing
linked plugin source does not guarantee an active Host module is reloaded.

## Config (`cordis.patch.yml`)

| key | default |
|-----|---------|
| `controlRoot` | this cliyard checkout |
| `repoRoot` / `targetRepo` | cliyard checkout unless configured |
| `defaultContracts` | `examples/mock-batch.parallel.json` |
| `ledgerPath` | `.cliyard/ledger.json` |
| `defaultWorker` | shipped patch: `claude`; package fallback: `mock` |
| `model` | shipped patch: `deepseek-flash` |
| `keepWorktrees` | `true` |
| `monitorPort` | `3927` |
| `masterPersonaPath` | default `design/dsh-master-persona-v0.prompt.txt` under control repo |

## Master persona (M0.5)

On load, if the host exposes `ctx.systemPrompt.section`, the plugin mounts
`cliyard:master-persona` from `design/dsh-master-persona-v0.prompt.txt`
(system layer — stronger than `AGENTS.md` guidance). Override with
`masterPersonaPath`. Without `systemPrompt`, mount is skipped and logged.

Local-CLI TaskContract schema / mock fixture (M0):

- `design/dsh-plugin-cliyard-taskcontract-v0.schema.json`
- `examples/mvp/code-local-cli.mock.contract.json`
- `src/mvp/taskcontract.ts`

## Design rules

- Control truth = frozen contracts, RunManifest and EvidenceBundle in cliyard;
  the ledger is progress history, and DSH chat is never authority.
- Parallel isolation = cliyard worktrees + non-overlapping `writePaths`, not DSH Jobs.
- Plugin stays thin; DSH API churn should not rewrite the control plane.
- `controlRoot` (cliyard) and `repoRoot` (business repo) are deliberately
  separate; a linked plugin located in cliyard can manage a sibling target.
- Current worker-batch `dependsOn` orders starts but does **not** merge an upstream
  worktree into a dependent worktree. Use independent tasks for this slice;
  dependent modules need a separate integration/composition step.

## Known limitations before production use

- The bundled HTML monitor is a development cockpit, not an authenticated
  production UI. It currently interpolates ledger fields into HTML and must be
  replaced by a typed Control API client before it handles untrusted task text.
- The plugin watches one ledger file. It does not yet expose the unified
  RunManifest, EvidenceBundle, WorkerLease, runtime and cost view.
- `cliyard_plan_dispatch` still accepts `worker`/`model`; it should move to
  frozen `executionProfileId` values so the model cannot alter permissions or
  routes.
- Tool dispatch is backgrounded, but state delivery is still polling/ledger
  based rather than a replayable Control API event stream.

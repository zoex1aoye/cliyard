# Development Roadmap

> Updated 2026-11-08 (Asia/Shanghai). Sequencing map only; the current
> implementation order remains the authority in
> [CURRENT_STATE.md](./CURRENT_STATE.md).
>
> **Stop-loss:** MVP = **DSH / Cordis plugin** (`dsh-plugin-cliyard`).
> Detail roadmap (savings, borrow/build, stage gates):
> [dsh-plugin-mvp-roadmap-v0.md](../design/dsh-plugin-mvp-roadmap-v0.md).
> Contract:
> [dsh-plugin-cliyard-taskcontract-v0.md](../design/dsh-plugin-cliyard-taskcontract-v0.md).
> Master persona:
> [dsh-master-persona-v0.md](../design/dsh-master-persona-v0.md).

## Endpoint (unchanged user story)

> 在 DSH 里整理 Plan → 人冻结契约 → **派本机 CLI** 到隔离 worktree →
> 监控状态 → 独立 verify → 人审合入。  
> Cordis/DSH 只提供会话、dispose、跨平台壳；不替代本机 Worker。

Canonical story: [USER_STORY_STEP1.md](./USER_STORY_STEP1.md).  
Prototypes: [design/prototypes/step1-user-story/](../design/prototypes/step1-user-story/).

## What the stop-loss saves

| Frozen (do not deepen for MVP) | Replaced by |
|---|---|
| SQLite ledger / event-sourcing deepen | Cordis memory + stock persist |
| Landlock / nono default-on productization | cwd cage; optional docker/low-priv |
| Port-lease RuntimeManager productization | Out of MVP envelope |
| Process-tree pid/pgid/lstart ownership | `subCtx.on('dispose')` |
| Routing A–B / admission product deepen | Contract `driver.target` registry |
| Home-grown Master chat / agent loop | DSH session + system persona |

**Still ours:** Master persona text, TaskContract freeze, CLI↔contract bind,
writeRoots semantics, human merge gate, deterministic verify.

## Active MVP stages

| Stage | Status | Gate |
|---|---|---|
| **M0** TaskContract shell | **implemented (PR)** | Schema + mock fixture + validator |
| **M0.5** Master system persona | **implemented (PR)** | Plugin mounts systemPrompt section when host provides it |
| **M1** Idle spin + cwd lock | **landed** (`12db03b` / PR #28) | `/cliyard-test`: worktree + `local-cli` spawn; trunk clean |
| **M2** Dispose (+ optional wrap) | **next implement** | Cancel kills child; no Landlock claim |
| **M3** Compiler + `/freeze` | pending | No dispatch without human freeze |
| **M4** Demo (code CLI + second scene) | pending | Same schema; human review; no auto-merge |

```text
DSH / Cordis
  └── dsh-plugin-cliyard
        ├── master persona (systemPrompt)
        ├── compiler → Plan.json
        ├── contract → /freeze → TaskContract.json
        └── drivers → local-cli | (later) dsh-llm | external-api
              └── verify → dispose
```

Borrow first where listed in the MVP doc (§3): conductor / worktrees /
prompt-layer / proof·verify. Do not copy auto-merge-to-main boards.

## Frozen mainline inventory

P0–P4 through `ba2f458` stay as optional later reuse. Routing A PR **parked**.
Unfreeze only after M1–M4 demo evidence + a new human Plan.

## Non-goals until MVP demo

- 24h unattended / auto-merge main / unbounded parallel claims
- Deepening SQLite / Landlock / port lease / process-tree ownership
- Treating chat as design or acceptance truth

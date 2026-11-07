# Development Roadmap

> Updated 2026-11-08 (Asia/Shanghai). Sequencing map only; the current
> implementation order remains the authority in
> [CURRENT_STATE.md](./CURRENT_STATE.md).
>
> **Stop-loss (2026-11-08):** MVP execution moves to a **DSH / Cordis plugin**
> (`dsh-plugin-cliyard`). Further self-built SQLite ledger deepening, Landlock
> C++ / nono-as-default, loopback port-lease productization, and process-tree
> ownership hardening are **frozen** — kept as mainline inventory, not the
> next build line. Soul retained: design-as-truth, workspace cage
> (git worktree / assets), deterministic verify, human freeze.

## Endpoint (unchanged ambition)

> 用控制面把设计变成可验收证据：人定方向与边界、中间可视、结尾审证据后合入。
> 场景不绑死在「写代码」——代码 / 小说 / 短剧共用同一套契约编译与派发哲学。

Three inseparable parts:

1. a working control shell that turns design into evidence;
2. a human-machine surface (DSH session first; later optional console);
3. real delivery proofs across at least one coding and one creator scene.

## Active line — DSH plugin MVP

Authoritative contract draft:
[dsh-plugin-cliyard-taskcontract-v0.md](../design/dsh-plugin-cliyard-taskcontract-v0.md).

| Stage | Status | Deliverable | Non-goals |
|---|---|---|---|
| **M0** 契约面 | **draft on disk** | 全场景 `TaskContract` 外壳 + `driver.kind` 三态 | 不重开 Routing / StateStore 刀 |
| **M1** 空转 + 目录锁 | **next** | DSH `/cliyard-test`：mock 契约 → worktree/assets → `local-cli` spawn(`cwd`) | 不接 LLM 编译；不写自研进程树 |
| **M2** dispose + 可选沙箱包裹 | pending | Cordis `subCtx.on('dispose')` 回收；可选 docker/low-priv wrap | 不绑 Landlock C++；不宣称默认-on OS sandbox |
| **M3** Compiler + `/freeze` | pending | `ctx.cliyardCompiler` + `ctx.cliyardContract`；会话 → Plan → 冻结 | 不自动批准 Plan；不自动合入 |
| **M4** 三场景 Driver 演示 | pending | code=`local-cli`；novel=`dsh-llm`；drama=`external-api` 各一条可演示闭环 | 不自研多模态运行时 |

```text
DSH / Cordis 运行时（会话、LLM、dispose、跨平台）
  └── dsh-plugin-cliyard
        ├── compiler   → Plan.json
        ├── contract   → /freeze → TaskContract.json
        └── drivers    → local-cli | dsh-llm | external-api
              └── verify（纯命令）→ dispose
```

### M1 detail (immediate)

- Mock frozen contract (`driver.kind=local-cli`, target allowlisted registry id).
- `workspace.kind=git-worktree` → `git worktree add`; spawn with `cwd=workspace.path`.
- Prove the tool reads/writes only under `writeRoots`; trunk untouched.
- Cancel path: dispose kills child — no custom PID/PGID identity ledger.

### M2–M4 detail

- **M2:** high-frequency cancel/error; Windows/macOS/Linux dispose evidence;
  optional command intercept wrap (docker / low-priv), still opt-in.
- **M3:** compile samples/pseudo/Demo prompts into Plan; human `/freeze`
  validates schema and writes `frozen`/`frozenAt`.
- **M4:** one demo each for code / novel / drama using the same contract shell.

## Frozen line — mainline inventory (do not deepen for MVP)

These already exist on `codex/supervisor-v0-baseline` and stay as evidence /
optional later reuse. **Do not schedule new knives** that expand them while
the DSH plugin MVP is the active line.

| Inventory | Mainline tip / notes | MVP stance |
|---|---|---|
| P0 legacy closeout | complete | keep |
| P1/P1b StateStore + SQLite | complete | **freeze deepen**; Cordis memory + stock persist for MVP |
| P2a/P2b daemon + ExecutionSupervisor | complete | **freeze** launchd/Job Object / nested reclaim work |
| P3 sandbox/VT/Reviewer/ledger/SkillPack | opt-in on mainline | **freeze** Landlock/nono-default productization |
| P4 catalog + admission + Routing B + queue wire | merged through `ba2f458` | **park**; Routing A PR stays unmerged unless revived |
| RuntimeManager port leases / process-tree ownership | present | **freeze** for MVP; dispose + cwd cage instead |

Historical phase notes and evidence links remain under `docs/evidence/` and
older CURRENT_STATE sections; they are not the active build order.

## After MVP evidence

1. Show the DSH plugin demo (isolation + dispose + at least two scenes) as
   design evidence to the cliyard line / community.
2. Decide: thin-shell stay-in-DSH, Cordis-extractable standalone, or selective
   re-attach of frozen mainline modules behind the same TaskContract shell.
3. Only then unfreeze a mainline module — and only with a new human-approved
   Plan that names what evidence the plugin already proved.

## Non-goals until MVP demo

- Deepening SQLite event-sourcing / ledger cutover.
- Native Landlock C++ binding or default-on nono wrap as the MVP path.
- Port allocator / process-tree start-identity reclaim as MVP blockers.
- Unbounded parallel, auto-merge, 24h unattended claims.
- Claiming DSH plugin MVP is done before M1 isolation spawn evidence exists.

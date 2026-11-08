# dsh-plugin-cliyard — MVP 路线图 v0

> Approved direction 2026-11-08 (Asia/Shanghai).
> Authority summary: [docs/ROADMAP.md](../docs/ROADMAP.md) ·
> [docs/CURRENT_STATE.md](../docs/CURRENT_STATE.md).
> User story: [docs/USER_STORY_STEP1.md](../docs/USER_STORY_STEP1.md).
> Contract: [dsh-plugin-cliyard-taskcontract-v0.md](./dsh-plugin-cliyard-taskcontract-v0.md).
> Master persona: [dsh-master-persona-v0.md](./dsh-master-persona-v0.md).

## 1. 用户故事（不变）

**作为**用 DSH 当 Master 的开发者，  
**我想**在 DSH 里把需求+原型整理成 Plan，冻结后**派给本机 code agent CLI**，
多模块并行且 worktree 隔离，并在监控台看状态，  
**以便**人只定方向与审证据，不必开多个工人聊天窗，也不在同一目录打架。

Cordis/DSH 选型**不改故事**，只改谁提供会话、dispose、跨平台壳。

## 2. 比「泥沼路线」省下什么

| 泥沼里会做的 | MVP 怎么规避 | 省下什么 |
|---|---|---|
| 加深 SQLite 事件溯源 / Ledger 写权威 | Cordis 内存上下文 + 现成落盘/ledger 投影 | 状态机与迁移工程 |
| Landlock C++ / nono 默认-on 产品化 | 阶段用 cwd 笼子；可选 docker/low-priv wrap | 原生沙箱绑定与测量矩阵 |
| RuntimeManager 端口租约产品化 | MVP 不跑多服务验收依赖默认端口 | 端口分配/lease 子系统 |
| 进程树 pid+pgid+lstart ownership 回收 | `subCtx.on('dispose')` 杀子进程 | 跨 OS 精确回收与 nested-group |
| ProfileCatalog / Routing A-B 产品化加深 | 契约内 `driver.target` 注册表 id；人/Master 选 CLI | 动态路由与 admission 产品 |
| 自研 Master 对话引擎 / Web 控制台先行 | DSH 会话 + sidebar/监控可借 | 人机面与 agent loop |
| 自研 worktree 全套 | 借 `dsh-worktrees` / `worktree-mgr` 原语 | 重复造笼子 |
| 自研「派到 11 家 CLI」协议 | 对照/可借 `dsh-agent-conductor` | 转交适配器重复劳动 |

**仍必须自己握的（不省）：** Master system 人设文案、TaskContract freeze、
本机 CLI↔契约绑定、`writeRoots` 审计语义、人合入门、确定性 verify。

## 3. 可借 / 必自研

| 能力 | 可借 | 必自研（权威在我们） |
|---|---|---|
| 会话 / dispose / 跨平台 | DSH + Cordis | — |
| Master system 人设挂载 | `dsh-system-prompt`；可先借 `dsh-prompt-layer` | **人设正文**（见 persona 文档） |
| 项目引导 | `AGENTS.md` 链 / `dsh-custom-instructions` | 仓库细则内容 |
| Plan→Freeze 契约 | — | **Schema + `/freeze` + 不可静默改字节** |
| 派本机 CLI | `dsh-agent-conductor`、`dsh-claude-cli` | **注册表 + 契约 argv/cwd** |
| worktree | `dsh-worktrees`、`worktree-mgr` | **与契约 writeRoots 绑定** |
| 并行蜂群/工厂 | `dsh-taskswarm`、`dsh-factory`（对照） | 不抄自动合入；依赖/隔离规则我们定 |
| 看板 UX | `dsh-taskboard`、kanban（对照） | 状态投影；禁止默认 auto-merge main |
| 独立验收探针 | `dsh-proof`、`dsh-verify` | 契约 `verify.commands` 权威 |
| 侧栏 / Forge / workspaces UI | better-sidebar、context、Forge… | 监控数据源仍是契约/ledger |

## 4. MVP 阶段（技术门禁，不估日历工期）

```text
M0 契约面 ──► M0.5 Master persona ──► M1 空转+cwd锁
                                    ──► M2 dispose(+可选wrap)
                                    ──► M3 Compiler+/freeze
                                    ──► M4 双场景可演示
```

| 阶段 | 交付物 | 验收门禁 | 明确不做 |
|---|---|---|---|
| **M0** | TaskContract 外壳定稿 + JSON Schema | **landed** `95146d2` / PR #27 | 不写派发实现 |
| **M0.5** | Master system persona 挂上 DSH | **landed** `95146d2` (unit); live DSH smoke TBD | 不改 DSH agent loop |
| **M1** | `/cliyard-test`：mock 契约 → worktree → `local-cli` spawn | **landed** `12db03b` / PR #28 | 不接 LLM 编译；不自研进程树 |
| **M2** | Cordis dispose 回收；可选 docker/low-priv | 取消/异常后子进程退出；无僵尸 | 不绑 Landlock；不宣称默认-on OS sandbox |
| **M3** | Compiler 出 Plan；人 `/freeze` | 未确认不能派发；freeze 后改字节需新版本 | 不自动批准 Plan |
| **M4** | 至少 **code 本机 CLI** + 另一场景（novel 或第二 CLI）各一条 Demo | 同一 Schema；人审证据；不合入 main | 不自研多模态运行时；不自动合入 |

并行建议：M0.5 可与 M1 准备并行（人设不阻塞空转夹具）。M2 必须在真 spawn 之后。M3 依赖 M0 Schema。M4 依赖 M1–M3。

## 5. 每阶段最小产物清单

### M0
- [x] `design/dsh-plugin-cliyard-taskcontract-v0.md`
- [x] `design/dsh-plugin-cliyard-taskcontract-v0.schema.json`
- [x] code 场景 mock fixture JSON (`examples/mvp/code-local-cli.mock.contract.json`)
- [x] hand validator `src/mvp/taskcontract.ts`

### M0.5
- [x] `design/dsh-master-persona-v0.md` + `.prompt.txt`
- [x] `dsh-cliyard` `systemPrompt.section` mount (unit-tested; live DSH smoke TBD)

### M1
- [x] DSH 命令/工具 `/cliyard-test`（或等价）— `cliyard mvp-test` / `cliyard_mvp_test`
- [x] worktree create + spawn `cwd` 锁
- [x] 证据：主干 clean、子目录有写入、exit code — [MVP_M1_IDLE_SPIN.md](../docs/evidence/MVP_M1_IDLE_SPIN.md)

### M2
- [x] `AbortSignal` / Cordis `dispose` → SIGTERM/SIGKILL（含 process group）
- [x] 取消用例证据（至少一 OS — Linux unit/CLI）— [MVP_M2_DISPOSE.md](../docs/evidence/MVP_M2_DISPOSE.md)
- [x] 可选 wrap 开关（默认关；docker/low-priv 拒绝启用）

### M3
- [ ] Plan JSON 草稿输出
- [ ] `/freeze` 写 `frozen`/`frozenAt` + schema 校验
- [ ] 未 freeze 拒绝 dispatch

### M4
- [ ] code：`local-cli` → claude/codex/opencode 之一
- [ ] 第二故事：第二 CLI 或 `dsh-llm` 小说最小条
- [ ] 监控可读状态（可借侧栏；数据我们供）

## 6. 反哺主线的条件（之后才解冻）

只有当 M1–M4 有可演示证据时，才允许新 Plan 解冻主线库存模块
（StateStore / Landlock / process-tree 等），且逐项证明插件路径不足。

## 7. 非目标（整段 MVP）

- 24h 无人值守、自动合入 main、无限并行宣称
- 加深 SQLite ledger / Landlock / 端口租约 / 精确进程树 ownership
- Routing A PR 合入作为 MVP 依赖
- 把 DSH 聊天当成设计或验收真相

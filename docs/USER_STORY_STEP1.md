# 第一步用户故事：DeepSeek Harness 作 Master

> 与 [VISION.md](./VISION.md)、[MVP_IMPLEMENTATION_PLAN.md](./MVP_IMPLEMENTATION_PLAN.md) §10 配套。  
> 锁定日期：2026-10-26。

## 用户故事

**作为**用 DeepSeek Harness 当 Master 的开发者，  
**我想**在 Master（DSH GUI）里把某一模块的**需求 + 原型**整理成 **Plan**，再由 Master **派发给合适的 code agent CLI** 去执行；接着对**另一模块**同样整理 Plan 并派发——两路**并行**且 **worktree/工作区互相隔离**；我能在 **监控台**看到各任务状态（running / verifying / repairing / accepted / rejected）。  
**以便**人只在 Master 里定方向与看进度，不必开两个聊天窗当工人，也不在同一目录里并行打架。

## 验收标准（Step 1 Done）

1. 在 DSH 会话中产出/确认两份 Plan → 落到可校验的 `TaskContract`（或 taskfile→contract）。
2. Master 触发派发后，两任务并行；目录/worktree 不重叠。
3. 监控台能反映 cliyard ledger（至少任务 id、状态、repair 次数、最近事件），无需翻终端才知道进度。
4. 失败走有限 repair 或 rejected，而不是无限聊纠偏。

## 明确不做（第一步之外）

- 自动合入主线、Multica 整包、JetBrains PSI。
- Master 自己写大段业务代码（Master 薄；Worker 厚）。
- Windows WSL/CodeBuddy 真连为后续步骤；本机 Darwin 先用 **mock worker** 证 GUI↔控制面，再换 **Codex CLI** 作第一真 Worker。

## 职责切分

| 层 | 归属 | 职责 |
|----|------|------|
| Master 壳 | DeepSeek Harness Web | 会话、需求/原型整理对话、插件 UI、监控展示 |
| Master 插件 | `plugins/dsh-cliyard` | Plan→Contract、选 worker、调 cliyard、订阅读 ledger |
| 控制面 | cliyard Route C | schema、DAG、闭环、ledger、可选 `--real-verify`、CLI adapter |
| Worker | 外部 CLI | Codex / CodeBuddy / … 在隔离 worktree 执行 |

```text
人 → DSH GUI（整理 Plan）
       ↓
  dsh-cliyard 插件（dispatch + monitor）
       ↓
  cliyard 控制面（契约 / DAG / ledger）
       ├─ Worker A @ worktree A
       └─ Worker B @ worktree B
```

**状态出聊天**：业务真相在 `.cliyard/ledger.json`；DSH 会话只做人机面与短摘要。  
**并行隔离**：以 cliyard worktree + paths 不重叠为准；不把 DSH 单会话 Jobs/子 Agent 当成多 CLI 隔离。

## Spike 路径

| Spike | 内容 | 入口 |
|-------|------|------|
| **S1** | DSH 插件 dispatch → `mock-batch`；监控读 ledger | 见 `plugins/dsh-cliyard/README.md` |
| **S2** | 同路径换 Codex CLI worker；双 worktree | `npm run codex-batch` + 插件 worker=`codex` |
| **S2.5** | 结构化 Plan → 冻结契约 → 可选 dispatch；DSH 暴露 `cliyard_plan_dispatch` | `npm run plan-dispatch` / 插件工具 |
| **S2.6** | Claude Code + DeepSeek first worker | `claude-ds` + `npm run claude-batch` |
| 其后 | Windows + CodeBuddy；真实 verify；选模型策略 | — |

## 相关命令（控制面，不依赖 DSH）

```bash
npm run mock-batch -- examples/mock-batch.parallel.json   # 两独立任务并行 mock
npm run codex-batch -- examples/codex-batch.parallel.json # S2：Codex + worktree（需本机 codex）
npm run plan-dispatch -- examples/glass-parallel.plan.json --repo ../ui-prototype
```

实机 Glass 试跑（兄弟仓 `ui-prototype`）：见 [GLASS_TRIAL.md](./GLASS_TRIAL.md)。

## S2.5 已落地的边界

- DSH 模型负责把聊天需求整理成结构化 Plan；控制面不猜测自然语言。
- `src/planner` 负责确定性编译：解析 HEAD、去重、依赖/环检查、路径越界与写路径重叠检查。
- 编译产物固定写到目标仓 `.cliyard/plans` 和 `.cliyard/contracts`，派发仍由 cliyard 执行。
- DSH 工具默认只编译；只有显式 `dispatch: true` 才启动 Worker，且默认仍是 dry-run。
- 工具派发采用后台进程，聊天只拿 PID/日志回执；进度继续从 ledger 与监控台读取。
- 当前 Codex worktree 的 `dependsOn` 只控制启动顺序，不会把上游 worktree 的改动合入下游；本切片优先使用互不依赖、写路径不重叠的模块任务。

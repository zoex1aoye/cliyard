# 开源/商业相邻产品对照（选型纪要）

> 目的：不要假设 cliyard 必须自研完整编排器；先分层看清「已解决什么」，再定差异化。  
> 与 [VISION.md](./VISION.md)、[MVP_IMPLEMENTATION_PLAN.md](./MVP_IMPLEMENTATION_PLAN.md) 配套。
> 产品命题、Codex/Claude Code/WorkBuddy/Qwen 边界与更完整的开源支撑矩阵见 [KEY_MIND.md](./KEY_MIND.md)。
> Harness、Master Shell 与控制面的分层及 DSH 替换策略见 [HARNESS_BOUNDARIES.md](./HARNESS_BOUNDARIES.md)。
> 2026-10-27 的并行派发、CLI+模型路由、入口与 DSH 插件复用决策见
> [PRODUCT_STRATEGY_V2.md](./PRODUCT_STRATEGY_V2.md)。

## 三类能力层

| 层 | 问题 | 代表 |
|----|------|------|
| **调度与隔离** | 多 CLI、worktree、队列、状态看板 | Multica、Cezar、Agetor、Paseo、dmux |
| **规划—实现—验证闭环** | 独立 Verifier、失败回退、有限重试 | Cezar workflows、zeroshot 类、vloop |
| **共享工程上下文与任务状态** | briefing 出聊天、账本、交接文件 | ai-orchestrator（chair + briefing 文件）、Ouroboros ledger |

**ACP** = 编辑器↔Agent 通信协议，不是编排替代品；可作未来 Adapter 选项。

## 优先核对结论（公开文档）

### Multica（[multica-ai/multica](https://github.com/multica-ai/multica)）

- **明确列出** `codebuddy` 为受支持 CLI（另有 Claude/Codex/Cursor 等约 26 种）。
- 任务看板、运行日志、审核中、重试/超时、自托管（Docker + **PostgreSQL**）、本地 daemon 拉起本机已登录 CLI。
- 有 [multica-cli](https://github.com/multica-ai/multica-cli) skill：可在 Codex/Claude/Cursor 里驱动 Multica。
- 许可：**Multica License**（Apache-2.0 并入 + 托管/商业嵌入附加条件）——**非纯 MIT**；采用前读 LICENSE。
- 重量：**偏重**（Go 后端 + Next + PG）。适合「整套协作层」；未必适合「薄本地控制层」。

### Cezar（[open-mercato/cezar](https://github.com/open-mercato/cezar)）

- MIT；**无 DB**，状态在 `.ai/cezar/` 文件；YAML workflow（implement → verify command → onFail retry）。
- Worktree 隔离；Autonomous 模式；人工审核门槛；`npx cezar-run`。
- 文档列出的 runner：claude / codex / copilot / cursor / junie / opencode / pi —— **未列 CodeBuddy**。
- 价值：研究 **YAML 闭环与失败回退**；不能默认替换 CodeBuddy 调用链。

### ai-orchestrator（[RobBrautigam/ai-orchestrator](https://github.com/RobBrautigam/ai-orchestrator)）

- MIT；方法论 + 模板 + 少量 Python 检查脚本；**chair 不写功能，只派工与 fold briefing 文件**。
- 与 VISION「状态出聊天」高度同构；可直接借鉴 briefing/queue 文件约定，几乎零平台成本。

### Cursor Agents / Devin / Copilot coding agent（商业对照）

- 趋势：任务生命周期 + 隔离环境 + 验证 + PR 交付。
- **仅「多 Agent 并行」** 已逐渐成为 IDE 基础设施 → cliyard 正面竞争收益低。
- 我们的差异：保留 **CodeBuddy(+DeepSeek) 已有授权** + **DeepSeek Harness 作 Master 壳** + cliyard 本地控制面 + 工程认知长期方向。  
- Cursor/Codex 仍可作**开发本仓库**的工具，**不再默认**当终端用户 Master。

### DeepSeek Harness（[deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)）

- 开源 agent harness；**everything-is-a-plugin**（Cordis）；`npx @deepseek-ai/dsh web` → 本机 Web GUI。
- 适合做人机面：**整理 Plan、插件监控、会话**；不替代 cliyard 的契约/DAG/worktree/ledger。
- 社区已有 workbench / HUD / agent-board 等监控插件可对照；我们的 Master 插件见 `plugins/dsh-cliyard`。
- 风险：developer preview，API 可能 breaking → 插件保持薄，**业务状态只信 cliyard 磁盘**。

## 三条路线

| 路线 | 做法 | 何时选 |
|------|------|--------|
| **A** 采用现成编排器 | 先实测 Multica（CodeBuddy 匹配）；Cezar 作轻量工作流对照 | 调度/看板/日志已够，不愿养平台 |
| **B** cliyard 二次开发 | 移植 Cezar/ai-orchestrator 的契约与闭环，保留现有 WSL 桥 | A 过重/许可证不合 |
| **C** 工程控制层 + DSH Master 壳 | **DSH GUI=Master**；cliyard=契约+隔离+Verifier+ledger；插件桥接 | **现行主路径** |

**当前倾向：** **C**（DSH 壳 + cliyard 控制面）。Multica 仅对照，不进运行时依赖。见 [USER_STORY_STEP1.md](./USER_STORY_STEP1.md)。

## 对比试验矩阵（建议同一多模块需求跑一遍）

| 维度 | Multica | Cezar | cliyard + DSH |
|------|---------|-------|---------------|
| CodeBuddy | 文档列出，须实测 | 未确认 | adapters（Windows 第二步） |
| Master 壳 | Multica UI / skill | CLI | **DeepSeek Harness GUI + 插件** |
| 任务状态/日志 | 强 | 本地文件 | JSON ledger + 插件监控 |
| 部署重量 | 高（PG/Docker） | 低 | 可控（无 PG） |
| 许可证 | 附加条件 | MIT | 自有 + DSH 上游 |
| 工程认知深度集成 | 需自扩 | 需自扩 | 长期差异化 |

任务样例：两模块需求+原型 → DSH 整理两份 Plan → 并行隔离派 Codex/CodeBuddy → 监控台看 ledger → 人验收。

# 开源/商业相邻产品对照（选型纪要）

> 2026-10-29：近期项目对比与路线结论已补到文末；当前优先级只以
> [CURRENT_STATE.md](./CURRENT_STATE.md) 为准，完整设计见
> [continuous-harness-v2.md](../design/continuous-harness-v2.md)。
>
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
- 2026-10-29 复核：本机为 `0.2.1-rc.3`；上游 rc.4 仅修 ACP stdout，
  alpha2 增加原生 sidebar、Forge、Statistics、外部 Codex/Claude 委派和插件
  更新，但要求 Node 24.9 并含多项 breaking API。cliyard 继续作为控制面，
  插件按 DSH 版本做 adapter/conformance，详见
  [evidence/DSH_0_2_2_ALPHA_2_REVIEW.md](evidence/DSH_0_2_2_ALPHA_2_REVIEW.md)。

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

## 2026-10-29 recent GitHub check

This is a time-bounded comparison based on repository metadata, README,
release and recent commit inspection. Versions and activity are observations,
not adoption commitments.

| Project | Observed recent state | Relevant capability | cliyard decision |
|---|---|---|---|
| [MiniMax Code](https://github.com/MiniMax-AI/minimax-code) | Open-sourced 2026-10-28; first-party default MIT; active | Detailed background-task lifecycle, output offsets, startup recovery, session cascade, compaction | Borrow lifecycle invariants; do not make it the control plane or raise cliyard from Node 20 |
| [MiniMax mcode-stack](https://github.com/MiniMax-AI/mcode-stack) | Created 2026-10-28; MIT; active skill/workflow stack | Harness experiments, clean independent review, long-command audit, handoff, lifting loops | Adopt as eval/review methodology and future SkillPack source |
| [Omnigent](https://github.com/omnigent-ai/omnigent) | v0.20.0 on 2026-10-28; Apache-2.0; alpha | Meta-harness, multi-agent/harness adapters, policy, sandbox providers | Reference interface and policy decomposition; no authority dependency |
| [SPACE](https://github.com/perplexityai/SPACE) | Active 2026-10-29 updates; Apache-2.0 | Firecracker microVM sandbox over HTTP/SSE, lifecycle and output sessions | Strong candidate behind cliyard `SandboxProvider`; conformance probe first |
| [Mission Control](https://github.com/builderz-labs/mission-control) | Active 2026-10-28 updates; MIT | Self-hosted task/review/spend/skills control surface, REST/MCP/SSE | UI/read-model reference; not design evidence authority |
| [Shipyard](https://github.com/cosscom/shipyard) | v0.3.31 on 2026-10-27; active 2026-10-28; MIT | Dev-box daemon, worktrees, terminals, services, automations, desktop GUI | Borrow service persistence/observability patterns; avoid GUI lock-in |
| [Genie](https://github.com/automagik-dev/genie) | Active 2026-10-28; MIT | Design interview -> parallel worktrees -> independent review -> PR | Closest delivery workflow reference; compare evidence and recovery semantics |
| [pi-dynamic-workflows](https://github.com/QuintinShaw/pi-dynamic-workflows) | v3.15.0 on 2026-10-27; MIT | Code-mode subagents, journaled resume, worktree, model routing, cost | Reference journal/resume and routing UX; no wholesale adoption |
| [planning-with-files](https://github.com/OthmanAdi/planning-with-files) | v3.26.0 on 2026-10-28; MIT | File-backed plans, crash recovery, completion gate, subagent isolation | Borrow recovery/completion-gate patterns |
| [DeerFlow](https://github.com/bytedance/deer-flow) | Highly active 2026-10-29; MIT | Long-horizon harness, RunEvent isolation, model request admission, sandbox/context/subagents | Compare event isolation/admission; avoid large fork |

The market is rapidly covering worktrees, multi-Agent boards, daemons, sandbox
providers and model routing. Those are no longer sufficient differentiators by
themselves. cliyard should buy/adapt those layers and keep its investment in
the deterministic connection between design authority, frozen execution
boundaries, independent evidence and human integration.

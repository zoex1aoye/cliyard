# 开源/商业相邻产品对照（选型纪要）

> 目的：不要假设 cliyard 必须自研完整编排器；先分层看清「已解决什么」，再定差异化。  
> 与 [VISION.md](./VISION.md)、[MVP_IMPLEMENTATION_PLAN.md](./MVP_IMPLEMENTATION_PLAN.md) 配套。

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
- 我们的差异：保留 **CodeBuddy(+DeepSeek) 已有授权** + Cursor 作 Master + 本地工程认知长期方向。

## 三条路线

| 路线 | 做法 | 何时选 |
|------|------|--------|
| **A** 采用现成编排器 | 先实测 Multica（CodeBuddy 匹配）；Cezar 作轻量工作流对照 | 调度/看板/日志已够，不愿养平台 |
| **B** cliyard 二次开发 | 移植 Cezar/ai-orchestrator 的契约与闭环，保留现有 WSL 桥 | A 过重/许可证不合/Cursor 无法当 Master |
| **C** 只做工程控制层 | Cursor=Master；cliyard=任务记录+路径保护+Verifier+报告；并行可后接 | 最小兼容现工作流 |

**当前倾向：** 先量 A（Multica）与 C 的差距 → 不够再 B。不要默认维护完整编排平台；差异化留给 **工程上下文与本地验收协议**。

## 对比试验矩阵（建议同一多模块需求跑一遍）

| 维度 | Multica | Cezar | cliyard(C/B) |
|------|---------|-------|--------------|
| CodeBuddy | 文档列出，须实测 | 未确认 | 现有 adapters |
| Cursor 保持 Master | 须验证（CLI skill/API） | 须验证 | 设计目标 |
| 任务状态/日志 | 强 | 本地文件 | 待建/薄 |
| 部署重量 | 高（PG/Docker） | 低 | 可控 |
| 许可证 | 附加条件 | MIT | 自有 |
| 工程认知深度集成 | 需自扩 | 需自扩 | 长期差异化 |

任务样例：Spring Boot 多模块跨模块接口 + DTO + 测试；要求：Cursor 规划与验收、CodeBuddy 执行、记 diff、独立测、失败由 Cursor 决定是否修、不破坏未提交改动。

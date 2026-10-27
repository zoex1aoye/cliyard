# Key Mind：设计驱动的 AI 工程交付控制面

> 状态：产品命题与竞品/能力地图
>
> 核验日期：2026-10-26

## 1. 一句话定义

**Key Mind 不是另一个 coding agent，也不是另一个聊天/任务 GUI。**

Key Mind 是一层可恢复的工程控制面：

> 把人的视觉风格、详细设计、约束和验收标准变成版本化契约；把契约变成可认领任务；把任务按能力路由给不同 coding CLI；把执行结果变成独立可验证的证据；在失败、上下文压缩或进程重启后继续把项目送到可审、可合入的状态。

产品类别可以叫：

**Design-to-Evidence Delivery Control Plane**

中文：

**设计到证据的 AI 工程交付控制面**

2026-10-27 战略补充把“并行派发”和“CLI + 模型执行组合路由”提升为核心产品能力，
并把 DSH 明确降为可替换 UI Client。修订后的完整定义、三种订阅/API 场景、
并行队列和自有入口决策见
[PRODUCT_STRATEGY_V2.md](./PRODUCT_STRATEGY_V2.md)。

Harness / Master Shell / Key Mind 的边界、DSH 的可替换性和开源选型见
[HARNESS_BOUNDARIES.md](./HARNESS_BOUNDARIES.md)。

一句话记忆：

> **Codex / Claude Code / Qwen Code 负责做事，WorkBuddy / DSH / 自有 Web UI 负责交互；Key Mind 负责根据设计与当前可用 CLI + 模型组合，并行派发一群可替换的做事者，并在人的设计权威下持续交付可验收结果。**

## 2. 五条不可妥协的原则

1. **设计是真相，聊天不是真相。**
   视觉、交互、接口、边界和验收必须有版本，并能在任何新会话中恢复。

2. **长任务是系统属性，不是单模型属性。**
   模型、GUI、Worker 和 Supervisor 可以重启；设计版本、任务状态、租约、证据和裁决不能丢。

3. **Worker 可替换，能力决定路由。**
   Codex、Claude Code、CodeBuddy、Qwen Code、OpenCode 都只是执行器。选择谁由任务能力、上下文、视觉需求、可用额度和历史通过率决定。

4. **完成必须带证据。**
   Worker 自报完成无效。验收由独立 Verifier 从精确代码快照重跑，包含运行态、视觉、a11y 和失败现场。

5. **人只保留设计权与不可逆决策权。**
   人确认视觉方向、关键取舍和最终合入；Supervisor 不应该要求人持续盯进程或重复校准方向。

## 3. 我们要完成的工作

### 3.1 设计阶段

人和设计 Agent 把想法整理成：

- 视觉风格与 token
- 组件 anatomy / variants / states
- 接口、数据与不变量
- non-goals 和 forbidden actions
- 依赖图与共享资源
- acceptance matrix
- 目标视口和运行方式

Design Pack 必须版本化。任务必须绑定 `designRevision`，不能只绑定一句聊天 prompt。

### 3.2 准入与派发

Gateway 机械检查：

- 设计是否冻结
- 依赖是否满足
- 写路径是否冲突
- 是否需要共享资源锁
- Worker 能力是否匹配
- 运行槽位、端口、预算是否可用
- 验收证据是否已定义

只有全部通过，任务才进入 `ready`。

### 3.3 执行与验收

Worker 在隔离 worktree/sandbox 中执行，产出代码和过程证据。

Verifier 在 Worker 结束后启动新的运行态：

```text
静态门禁
  → 端口/运行资源租约
  → build/preview 服务
  → readiness
  → E2E / a11y / 同视口截图
  → Evidence Bundle
  → 进程清理
  → verdict
```

### 3.4 恢复与连续运行

系统持续工作依赖：

- 持久任务队列
- claim / lease / heartbeat
- checkpoint 和 Resume Pack
- 崩溃恢复
- 失败重试上限
- 限流、预算、watchdog
- integration queue

不是依赖一个会话绝不遗忘。

## 4. 我们明确不是什么

- 不训练基础模型。
- 不做通用聊天客户端。
- 不做 WorkBuddy 式全办公套件。
- 不和教育办公、文档、表格、PPT 的广度竞争。
- 不自研 IDE 作为第一优先级。
- 不把无限并行 Agent 当产品卖点。
- 不把自动合入 main 当成无人值守的默认结果。
- 不把 `dependsOn` 只当启动顺序；真实依赖必须基于已集成的上游 commit。

## 5. 竞品能力边界

这些产品都在快速演进，以下只描述截至核验日期公开资料能够支持的能力，不假设它们永远不变。

| 产品 | 已经很强 | 仍不是 Key Mind 的核心承诺 |
|---|---|---|
| **ChatGPT / Codex** | 多入口 coding agent；长任务目标可暂停、恢复、调整；项目与对话；Git worktrees；计划任务和 background 运行 | 跨厂商设计治理、独立验收证据、Worker 能力市场、项目级交付裁决仍不是其核心数据模型 |
| **Claude Code** | 终端/IDE/桌面/Web；多会话、云端长任务、并行任务、定时任务；Agent SDK、hooks、subagents、权限体系 | 仍是 Claude 生态内的 agent 产品；不提供厂商中立的跨 CLI 任务控制面和统一验收协议 |
| **WorkBuddy** | 自然语言规划执行；多任务并行；文档/表格/PPT 等结果交付；项目资料、技能、连接器；包含代码开发场景 | 主要价值是通用 AI 办公工作台；不是以组件设计版本、代码证据、隔离服务和合入队列为中心的工程控制面 |
| **Qwen Code** | 开源 coding agent；Agent Teams、subagents；worktrees；headless、SDK、实验性 daemon；多模型协议 | 仍以 Agent 运行时为中心；没有把设计修订、独立 Verifier、任务租约和 Evidence Bundle 组成唯一项目真相 |
| **QwenWork / 千问办公** | 办公任务编排、模板、企业 IM/文档/知识库等流程闭环 | 通用办公广度不是 Key Mind 的主战场；工程级代码验收不是其首要产品面 |
| **Multica / Cezar / 类似编排器** | 多 CLI、任务看板、worktree、状态、重试、YAML workflow、briefing | 多数解决“派发与运行”，较少统一解决设计权威、视觉证据、跨 CLI 验收与恢复语义 |

> “Qwen Workbench”在公开官方页面中没有找到可以稳定核对的独立产品名。
>
> 本文把可核对的 **Qwen Code** 作为 coding agent 对照，把 **QwenWork** 作为办公工作台对照，不臆测一个未确认产品的功能缺口。

### 5.1 Codex 已经商品化的能力

官方文档明确支持：

- [Long-running work](https://developers.openai.com/codex/long-running-work)：长任务目标、暂停/恢复、持续 steer 和查看状态。
- [Git worktrees](https://developers.openai.com/codex/environments/git-worktrees)：多个独立 chat 在 worktree 中并行，减少对本地工作区干扰。
- [Projects and chats](https://developers.openai.com/codex/projects)：组织长期项目、共享文件/指令、本地文件夹上下文。
- [Scheduled tasks](https://developers.openai.com/codex/automations)：定时或事件触发的后台任务，可选择独立 worktree。

因此以下能力不能作为我们的独特卖点：

- worktree 并行
- 长任务暂停与恢复
- 定时触发
- 项目级文件上下文
- 单厂商内多 chat / subagent

我们真正要补的是这些能力之上的**设计契约、跨厂商策略、独立证据和项目级恢复控制**。

### 5.2 Claude Code 已经商品化的能力

Claude Code 官方 overview 已把 coding agent 扩展到终端、IDE、桌面和 Web，并明确提到多会话、并行任务、长期任务和定时任务。

不能把“Claude 有一个桌面 App”或“能开多个 session”当作 Key Mind 的差异化。

### 5.3 WorkBuddy 已经商品化的能力

WorkBuddy 官方简介明确包含：

- 自主规划与执行
- 多任务并行
- 本地文件操作
- 结果交付与验收
- 项目协作、技能、连接器
- 文档、表格、PPT 和代码开发

Key Mind 若想竞争，必须选择**工程深度**，不能选择“办公能力更多”。

## 6. 真正缺的共同层

这些产品都在补 agent 本身，但项目交付仍存在五个断点。

### 6.1 设计版本与任务版本断裂

聊天里的决定很容易漂移；代码里的设计又分散在注释、规则和提交历史中。

Key Mind 要把二者绑定：

```text
designRevision
  → componentContract
  → taskContract
  → artifact
  → evidence
  → verdict
```

### 6.2 Ready space 不明确

“已经讨论过”不等于“可以执行”。

Key Mind 的 `ready` 必须通过准入检查，避免把矛盾和未确认设计高速执行成技术债。

### 6.3 Worker 选择不透明

一个模型/CLI 不适合所有任务。

Key Mind 要按以下因素路由：

- 视觉输入能力
- 代码推理强度
- 上下文窗口
- 工具/沙箱能力
- session/resume 能力
- 价格、速度和额度
- 该任务类型的历史通过率

### 6.4 完成与验收断裂

Agent 的“完成”经常只是退出码 0。

Key Mind 需要：

- 精确 commit / artifact hash
- 独立运行态
- build/E2E/a11y/视觉证据
- P0/P1/P2 偏差
- `accepted_with_gap` 和 `needs_human`
- 证据失效和重验规则

### 6.5 连续性与一致性断裂

长时间运行会经历：

- 模型上下文压缩
- GUI 关闭
- Worker 崩溃
- Supervisor 重启
- 限流
- 设计变更

Key Mind 要让“重启”成为正常状态转换，而不是人工救火。

## 7. Key Mind 的闭环

```text
人的视觉/产品意图
        +
现有项目与原型证据
        ↓
Design Pack（版本化）
        ↓
Contract Compiler + Admission Gateway
        ↓
Ready Queue + Claim / Lease
        ↓
Capability Router
   ├─ Codex
   ├─ Claude Code
   ├─ CodeBuddy
   ├─ Qwen Code
   └─ OpenCode
        ↓
隔离 Workspace + Runtime
        ↓
Independent Verifier
        ↓
Evidence Bundle + Adjudication
        ↓
Repair / Human / Integration
        ↓
Design and Ledger updated
```

状态的唯一真相在控制面，不在聊天。

## 8. 开源与商业项目支撑

支撑分三档：

- **A 直接复用**：现在就可以作为技术基础。
- **B 选择性接入**：适合后续演进，但不进入第一版关键路径。
- **R 参考/对照**：借鉴数据模型和交互，不把整包变成依赖。

### 8.1 设计与规格

| 能力 | 支撑项目 | 档位 | 我们保留什么 |
|---|---|---|---|
| Spec → plan → tasks | [GitHub Spec Kit](https://github.com/github/spec-kit) | B/R | 绑定视觉设计版本、组件矩阵和运行证据 |
| Change proposal + specs + tasks | [OpenSpec](https://github.com/Fission-AI/OpenSpec) | B/R | 需求变更影响分析、任务失效和跨仓库锁定 |
| 产品/架构/交付流程 | [BMad Method](https://github.com/bmad-code-org/BMAD-METHOD) | R | 每个设计角色如何验证，不是只生成文档 |
| 商业 spec-driven IDE | [Kiro](https://kiro.dev/) | R | 保持 provider/IDE 中立，不绑定单 IDE |
| ADR / decision log | [adr-tools](https://github.com/npryce/adr-tools) 类方案 | A/R | 决策与任务、证据、设计修订的关联 |

Key Mind 不重新发明“写规格”，而是补：

> 规格如何成为可执行且不可自行漂移的契约，以及完成后如何用证据证明没有偏离。

### 8.2 持久任务与运行

| 能力 | 支撑项目 | 档位 | 我们保留什么 |
|---|---|---|---|
| Durable workflow / event history | [Temporal](https://temporal.io/) | B | 项目语义、Worker registry、evidence/adjudication |
| 持久后台任务 | [Inngest](https://www.inngest.com/) / [Trigger.dev](https://trigger.dev/) / [Restate](https://restate.dev/) | B | 多 CLI 执行器、隔离 worktree、验收模型 |
| 单机任务队列 | SQLite WAL / [pg-boss](https://github.com/timgit/pg-boss) / [BullMQ](https://docs.bullmq.io/) | A/B | claim、lease、attempt、heartbeat 的业务约束 |
| 事件账本 | PostgreSQL + outbox / append-only event log | A | task/run/evidence 的项目级事件模型 |

本地 MVP 推荐：

```text
SQLite WAL
  → task / run / event / claim / lease / runtime / evidence / verdict
```

单机与多机之间的选择：

- 单机单用户：SQLite + 文件锁 + 原子状态转换足够起步。
- 多机/团队：PostgreSQL + lease/heartbeat；规模更大再考虑 Temporal/Restate。

不要一开始为了“看起来企业级”引入完整 Temporal 集群。

### 8.3 Agent 编排与 coding worker

| 能力 | 支撑项目 | 档位 | 我们保留什么 |
|---|---|---|---|
| 多 CLI、任务看板和运行状态 | [Multica](https://github.com/multica-ai/multica) | R | 设计契约、运行证据、跨 CLI 验收；注意非纯 MIT 许可 |
| YAML implement → verify → retry | [Cezar](https://github.com/open-mercato/cezar) | R | 视觉/UI 验收、租约恢复、能力路由 |
| briefing / chair 不写代码 | [ai-orchestrator](https://github.com/RobBrautigam/ai-orchestrator) | R | Resume Pack、任务 DAG 和证据绑定 |
| 开源 coding agent + daemon | [Qwen Code](https://github.com/QwenLM/qwen-code) | A/B | 将其作为 Worker Adapter，不让其成为控制面 |
| 开源 coding agent / server | [OpenCode](https://github.com/anomalyco/opencode) | A/B | 统一 start/status/cancel/collect 接口 |
| 通用 Agent SDK | [Claude Agent SDK](https://docs.claude.com/en/api/agent-sdk/overview) / [Codex SDK](https://developers.openai.com/codex/codex-sdk) | B | 不锁定单一模型供应商；项目身份和验收由我们掌握 |
| Sandbox / evaluation | [OpenHands](https://github.com/All-Hands-AI/OpenHands) / [SWE-agent](https://github.com/SWE-agent/SWE-agent) | R | 项目级设计验收和 UI 运行态，不只看 benchmark |

### 8.4 隔离、运行与视觉验收

| 能力 | 支撑项目 | 档位 | 我们保留什么 |
|---|---|---|---|
| 代码隔离 | Git worktree | A | base/artifact commit、分支生命周期和 integration queue |
| 服务/依赖隔离 | [Docker](https://www.docker.com/) / [Testcontainers](https://testcontainers.com/) | B | 每 run 端口、数据目录和 RuntimeManifest |
| 远程执行环境 | E2B / Daytona / Modal 等 | B | Worker capability 和验收证据协议 |
| 浏览器自动化 | [Playwright](https://playwright.dev/) | A | 同视口、状态矩阵、端口租约和证据归档 |
| a11y | [axe-core](https://github.com/dequelabs/axe-core) | A | 与设计验收矩阵和人工签收联动 |
| 视觉回归 | Storybook + Chromatic / Percy / Lost Pixel 等 | B/R | 本地/跨 CLI 运行时和可审计 evidence bundle |
| 进程管理 | systemd / launchd / 容器进程管理 | A | Worker lease、heartbeat、watchdog 和进程树清理 |

### 8.5 UI、可观测与协议

| 能力 | 支撑项目 | 档位 | 我们保留什么 |
|---|---|---|---|
| 可替换 Master 壳 | [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) + Cordis | A/B | 业务真相在 cliyard；GUI 可关闭、可替换 |
| 工具互操作 | MCP | A | Worker capability 与安全权限策略 |
| Agent 进程协议 | ACP / 各 CLI SDK | B | 统一生命周期、lease 和项目身份 |
| 运行观测 | OpenTelemetry | B | task/run/evidence 项目语义 |
| Agent trace / eval | Langfuse / Arize Phoenix / LangSmith 等 | R/B | 验收证据不能只依赖 trace，还要有可复现运行与截图 |

## 9. 采用策略

### 直接采用，不自研

- Git worktree
- SQLite/PostgreSQL
- Playwright + axe-core
- OpenTelemetry
- MCP / ACP / CLI SDK
- systemd / launchd / 容器进程管理

### 选择性接入

- Spec Kit / OpenSpec 作为设计文档模板来源
- DSH/Cordis 作为一个 GUI 壳
- Temporal/Restate 在恢复复杂度真正上升后
- Qwen Code / OpenCode / Codex / Claude Code 作为 Worker
- Testcontainers / Docker 用于多服务验收

### 只学习，不整包依赖

- WorkBuddy
- Multica
- Cezar
- ai-orchestrator
- Kiro
- 各厂商专属 Agent 平台

## 10. 护城河与商品化边界

### 正在商品化，不能当护城河

- 聊天 UI
- CLI 封装
- Git worktree 并行
- 单次 agent session
- 基础 subagents
- 简单 DAG
- Retry 和 timeout
- 普通任务看板
- 单厂商模型选择

### Key Mind 应该拥有的护城河

1. **设计版本 → 任务 → 证据 → verdict 的可追踪链。**
2. **跨 CLI 的能力路由和统一 Worker 生命周期。**
3. **运行态验收协议：端口 lease、进程树、独立数据、截图和 a11y。**
4. **可恢复控制面：lease、heartbeat、Resume Pack、崩溃恢复。**
5. **UI/视觉项目的验收知识：不是只要 build 绿。**
6. **项目级决策、风险和修复历史，而不是聊天历史。**

最大的难点不是“会派发”，而是：

> **什么叫这块设计已经完成且值得人认真审查？**

谁把这套验收语义做成可执行、可恢复、跨 Agent 的系统，谁才拥有真正的控制面。

## 11. V1 聚焦边界

V1 不应覆盖所有软件和办公任务。

可执行的 V1 walking skeleton、数据模型、首个真实任务和里程碑见 [KEY_MIND_MVP.md](./KEY_MIND_MVP.md)。

建议先锁定：

**设计密集型、可运行、可截图、多组件的前端项目。**

以 `ui-prototype` 为第一条完整样板：

- Glass 组件设计版本
- token/层级/状态矩阵
- 组件级 TaskContract
- Codex/Claude/Qwen Code Worker
- 独立 build/preview 运行态
- Playwright 截图和 axe a11y
- Evidence Bundle
- 人工视觉签收
- repair 与 integration

这条闭环跑稳后，再把同一控制面推广到：

- 后端 API
- 多服务系统
- 数据迁移
- 文档/设计交付
- 其他办公任务

## 12. 下一阶段必须证明的事实

1. 同一设计版本能被任意新 Master 会话准确恢复。
2. Gateway 不会把未决设计或冲突写路径放进 ready。
3. 相同任务只能被一个 Worker 原子认领。
4. Worker 崩溃后 lease 到期，任务可恢复且不重复提交。
5. Verifier 能从精确 artifact 启动隔离服务并产出完整证据。
6. 两个并行 run 的端口、数据目录、浏览器 profile 互不污染。
7. 视觉未测时不会误标 accepted。
8. Master/GUI 重启后继续处理剩余任务。
9. 设计修订能标记受影响任务，而不是继续执行旧契约。
10. 人看到的是一份可审证据，而不是一屏过程聊天。

## 13. 最终 Key Mind

```text
不是让一个 Agent 永远醒着，
而是让整个项目永远有可恢复的下一步。

不是让 Worker 自己说完成，
而是让 Verifier 用同一份契约和可复现证据裁决。

不是绑定一个 CLI，
而是让能力驱动地选择 Codex / Claude / CodeBuddy / Qwen / OpenCode。

不是多做几个 Agent，
而是让人的设计真正成为可执行、可追踪、可验收的系统。
```


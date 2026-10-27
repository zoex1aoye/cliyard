# Harness 边界、DSH 定位与可替换选型

> 状态：架构决策记录
>
> 日期：2026-10-26

## 1. 核心结论

Key Mind / cliyard 不是又一个 Agent Harness。

它位于 Agent Harness 之上：

```text
模型
  → Agent Harness：session、上下文、工具、权限、sandbox
  → Master Shell：GUI、任务卡、会话、插件
  → Key Mind 控制面：设计版本、契约、队列、lease、验收、integration
```

一句话：

> **Codex、Claude Code、Qwen Code、OpenCode 是 Worker Runtime；DSH 是候选 Master Shell；cliyard 是独立 Control Plane。**

DSH 当前适合做 MVP 人机面，但不是最终架构的可靠性边界。

2026-10-27 的入口决策进一步明确：先稳定 CLI + 本地 Control API / SSE，
DSH 只做薄客户端；之后增加最小自有 Web UI 作为 DSH 停止维护时的后备。
并行调度、CLI + 模型路由和产品边界见
[PRODUCT_STRATEGY_V2.md](./PRODUCT_STRATEGY_V2.md)。

## 2. 四类能力不能混为一谈

| 层 | 解决的问题 | 代表 |
|---|---|---|
| 模型 | 推理、视觉、代码能力 | DeepSeek、Claude、GPT、Qwen |
| Agent Harness | 单 Agent loop、工具调用、上下文、权限、subagent | Codex、Claude Code、Qwen Code、OpenCode |
| Master Shell | GUI、会话、任务卡、插件、人工操作 | DSH、WorkBuddy、自定义 Web UI |
| Delivery Control Plane | 设计修订、TaskContract、队列、lease、证据、裁决、集成 | Key Mind / cliyard |

现有产品经常同时覆盖相邻两层，但它们的可靠性边界仍在各自的控制范围内。

Key Mind 不应该重写 Agent Harness，也不应该把 GUI 当调度真相。

## 3. 我们自研什么

这些是产品的稳定内核：

1. Design Pack 与 `designRevision`。
2. Plan → TaskContract 的确定性编译。
3. ready queue、DAG、claim、lease、heartbeat、recovery。
4. Worker capability routing。
5. Runtime/port/evidence/verifier。
6. accepted snapshot 与 integration queue。
7. 项目级事件账本和 resume pack。
8. 人的设计裁决与不可逆节点。

这些能力不能绑在 DSH 插件、某个 CLI prompt 或某个模型的 session 生命周期里。

## 4. 可以站在哪些“巨人”上

### Codex

官方公开接口包括：

- [Codex App Server](https://developers.openai.com/codex/app-server)
- [Codex SDK](https://developers.openai.com/codex/codex-sdk)
- [Git worktrees](https://developers.openai.com/codex/environments/git-worktrees)
- [Long-running work](https://developers.openai.com/codex/long-running-work)
- [Scheduled tasks](https://developers.openai.com/codex/automations)

适合：

- 高质量 coding worker；
- SDK/App Server 模式下的结构化任务生命周期；
- 本地 worktree 与长任务能力。

不承担：

- 跨 CLI 的 Worker registry；
- 设计版本治理；
- 独立 Evidence Bundle；
- 项目级 integration/verdict。

### Claude Code

官方 [Agent SDK](https://code.claude.com/docs/en/agent-sdk/overview) 提供 sessions、hooks、subagents、MCP、permissions 和工具控制。

适合：

- 高质量 coding worker；
- 生命周期 hooks；
- 多 Agent 与自定义工具接入。

限制：

- Claude Code 官方不支持、也不审计通过 gateway 运行非 Claude 模型；
- 当前 Claude Code + DeepSeek 是 DeepSeek compatibility mode，不能假设所有 Claude 特性等价可用。

因此该组合只能存在于 Worker Adapter 内，不能泄漏成控制面的事实模型。

### Qwen Code

[Qwen Code](https://github.com/QwenLM/qwen-code) 是开源 coding agent，公开能力包括：

- Agent Teams、SubAgents；
- worktrees、MCP、Computer Use；
- headless、TypeScript/Python/Java SDK；
- 实验性 `qwen serve` daemon，通过 HTTP + SSE（ACP）；
- OpenAI/Anthropic/Gemini/Qwen 和多 provider。

适合：

- 第二家 Worker Adapter；
- ACP/daemon 的结构化集成验证；
- 开源可控性和自托管实验。

风险：

- daemon/ACP 仍标 experimental；
- 需要固定版本并跑 conformance test。

### OpenCode

[OpenCode](https://github.com/anomalyco/opencode) 是开源 coding agent。

公开接口包括：

- [Server](https://opencode.ai/docs/server/)：headless HTTP server、OpenAPI 3.1、SSE event stream；
- [SDK](https://opencode.ai/docs/sdk/)：类型化 JS/TS client；
- [Plugins](https://opencode.ai/docs/plugins/)：工具、权限、session、compaction hooks；
- session fork/abort/diff/summarize/prompt_async 等 API。

适合：

- 结构化 Worker Adapter；
- 用 OpenAPI/SSE 代替 CLI 文本解析；
- 需要自定义工具和 session 生命周期控制的场景。

风险：

- Desktop/Beta 和 API 演进；
- 插件生态与插件 API 成熟度需要版本验证。

### DeepSeek Harness / DSH

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)：

- MIT；
- everything-is-a-plugin；
- 基于 Cordis；
- 具备 Headless、Web、Desktop、插件、工具、session、UI 扩展等能力。

适合：

- MVP 的 Master Shell；
- 设计对话；
- 插件式监控台；
- 人机操作入口。

风险：

- 官方明确为 **developer preview**；
- 明确会有 compatibility-breaking changes；
- Desktop profile 由 Electron 应用管理；
- UI 插件、Host API、工具 API 可能变化。

## 5. DSH 的正确使用方式

当前：

```text
DSH GUI
  └─ dsh-cliyard plugin（薄）
       └─ HTTP/CLI 调 cliyard
            └─ 唯一业务状态
```

禁止：

- 把 task/ledger/contract 状态只存在 DSH session；
- 在 DSH 插件内实现调度器；
- 让 DSH Jobs 替代 cliyard worktree/queue；
- 把业务逻辑写进 Cordis 回调；
- 依赖未公开的 DSH 内部 DOM 或私有 API。

允许：

- 把 DSH 当作 Control API 的一个 UI Client；
- 用插件展示任务、证据、设计修订和人工动作；
- DSH 崩溃或替换后，Supervisor 和 Worker 继续运行。

## 6. 未来 UI 的三种路线

| 路线 | 优点 | 风险 | 定位 |
|---|---|---|---|
| 继续 DSH 插件 | 快速、已有插件能力、可复用会话 | developer preview、API 漂移 | MVP / 参考 Master |
| 自研 Web UI | 稳定控制、完全定制、部署自由 | 开发成本、重造交互基础 | 长期产品面 |
| 接入 WorkBuddy/QwenWork 类工作台 | 现成办公生态 | 商业锁定、能力边界不透明 | 特定集成，不押注 |

建议：控制 API 先稳定，UI 后决定。DSH 和自研 Web UI 都只是 UI Client。

推荐入口顺序：

1. CLI 始终可独立运行；
2. 本地版本化 Control API + event stream；
3. DSH `dsh-better-sidebar` 薄插件作为第一 cockpit；
4. 最小自有浏览器 UI 作为平台替代与恢复入口；
5. 需要桌面集成时，用 Tauri/Electron 包装同一 Web UI，不重写业务层。

自有入口只做项目状态、队列、run、证据和人工动作，不重做编辑器、终端、
diff、Git 或通用聊天。

## 7. 稳定接口设计

### 7.1 WorkerAdapter

控制面只依赖能力，不依赖品牌：

```ts
interface WorkerAdapter {
  id: string
  probe(): Promise<WorkerCapabilities>
  start(input: WorkerTask): Promise<WorkerSession>
  stream(sessionId: string): AsyncIterable<WorkerEvent>
  status(sessionId: string): Promise<WorkerStatus>
  resume?(sessionId: string): Promise<WorkerSession>
  cancel(sessionId: string, reason: string): Promise<void>
  collect(sessionId: string): Promise<WorkerResult>
}
```

Capability 至少包含：

- vision；
- structured events；
- session resume；
- cancellation；
- model selection；
- MCP / tools；
- sandbox/permissions；
- provider / account；
- concurrency limit。

### 7.2 MasterShell

GUI 不直接操作 Worker：

```ts
interface ControlClient {
  listTasks()
  inspectTask(id)
  enqueuePlan(plan)
  approveTask(id)
  retryTask(id)
  cancelTask(id)
  subscribeEvents()
  getEvidence(runId)
}
```

DSH / 自研 Web / 未来其他 UI 共用这一层。

### 7.3 ProtocolAdapter

按可用优先级：

1. 官方 SDK / App Server；
2. local daemon + OpenAPI/SSE/ACP；
3. structured CLI JSON；
4. PTY / 文本解析（最后手段）。

不能因为 MVP 用 CLI，就把 CLI 文本格式写成永久协议。

## 8. 不要陷入悬崖

### 悬崖 1：DSH 成为真相源

后果：App 更新、插件 API 改变、GUI 关闭导致项目不可恢复。

防线：DSH 只调用 Control API；所有状态在 cliyard。

### 悬崖 2：把 CLI 文本当 API

后果：输出格式、提示词、ANSI、错误码一变更就全断。

防线：能上 SDK/daemon 的 Harness 不上文本解析。

### 悬崖 3：绑定单一 Agent 厂商

后果：模型额度、价格、能力或政策变化导致系统不可用。

防线：Worker registry；至少两家 ability probe；能力路由。

### 悬崖 4：Fork 大 Harness

后果：长期维护上游、内部 API 和 UI 兼容。

防线：不 fork；使用官方扩展点、SDK、MCP/ACP。

### 悬崖 5：把 LLM 当调度器

后果：重复派发、预算失控、不可复现。

防线：确定性 queue、lease、state machine；LLM 只做规划与裁决建议。

### 悬崖 6：实验性 API 进入核心

后果：升级即破坏。

防线：adapter 内部隔离；固定版本；conformance test；可以回退。

## 9. 选型评分

每个候选 Harness 按以下维度评分：

| 维度 | 权重 |
|---|---:|
| 结构化生命周期 | 20 |
| session resume / cancel | 15 |
| worktree / sandbox / permission | 15 |
| tool/MCP/自定义能力 | 10 |
| 多 provider / model neutrality | 10 |
| SDK/daemon API 稳定性 | 10 |
| 日志与事件可观测性 | 10 |
| license / deployment / self-host | 10 |

硬门槛：

- 无 headless 或结构化输出，不能做长任务 Worker；
- 无 cancel，不能进入自动调度；
- 无明确退出与事件，不能 accepted；
- API 不稳定且无 adapter 回退，不进入控制面核心。

## 10. 推荐路线

### 现在

- Supervisor + control state 独立于 DSH。
- Claude Code + DeepSeek 作为第一 Worker。
- DSH 作为可选 MVP Shell。

### 下一阶段

- 增加第二个 Worker Adapter：优先 OpenCode 或 Qwen Code；
- 使用其 server/SDK/daemon API，而不是仅拼 CLI；
- 为两个 adapter 跑同一组 conformance tests。

### 再下一阶段

- Control API 稳定后，自研最小 Web Monitor；
- 同一 Control API 同时供 DSH 和自研 UI 使用；
- 用真实使用数据决定 DSH 是否继续作为主 Shell。

## 11. 最终判断

我们要站在巨人肩膀上，但不把巨人当地基：

```text
借 Harness 的 agent loop
借 SDK/daemon 的结构化接口
借 DSH/Cordis 的 UI 插件能力
借 MCP/ACP 的互操作协议
借 Playwright/axe 的验证能力

自研设计契约、队列、lease、恢复、证据、裁决和集成
```

最终产品不能依赖“DSH 一直稳定”或“某个 CLI 永远存在”。

真正的稳定边界是：

> **任何 UI 可以关，任何 Worker 可以换，任何模型 session 可以死；项目控制状态、证据和下一步仍然存在。**


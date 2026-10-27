# Claude Code + DeepSeek Worker

> 状态：本机已验证
>
> 日期：2026-10-26
>
> Claude Code：2.1.185
>
> 模型：`deepseek-flash`

## 1. 安装方式

Claude Code 已通过 npm 安装在当前 Node 20 环境：

```bash
npm install -g @anthropic-ai/claude-code
claude --version
```

不要把 DeepSeek 配置覆盖到全局 `claude` 命令上。当前机器已执行
`claude auth logout` 并移除 Anthropic 登录；DeepSeek 只通过独立启动器：

```text
~/.local/bin/claude-ds
```

该启动器只做当前进程的 provider 切换，不改仓库文件，不写入 API Key。

## 2. DeepSeek 配置

启动器优先读取：

```text
DEEPSEEK_API_KEY
```

macOS 上若 GUI 启动时没有继承终端环境，回退读取 Keychain：

```text
service: cliyard-deepseek
account: current macOS user
```

Key 明文不进入仓库、不打印到日志。

然后设置：

```bash
export ANTHROPIC_BASE_URL=https://api.deepseek.com/anthropic
export ANTHROPIC_AUTH_TOKEN="$DEEPSEEK_API_KEY"
export ANTHROPIC_MODEL='deepseek-flash'
export ANTHROPIC_DEFAULT_OPUS_MODEL='deepseek-flash'
export ANTHROPIC_DEFAULT_SONNET_MODEL='deepseek-flash'
export ANTHROPIC_DEFAULT_HAIKU_MODEL='deepseek-flash'
export CLAUDE_CODE_SUBAGENT_MODEL='deepseek-flash'
export CLAUDE_CODE_EFFORT_LEVEL=max
export CLAUDE_CODE_AUTO_COMPACT_WINDOW=786432
```

2026-10-28 的真实 DeepSeek Anthropic-compatible endpoint 返回：

```text
The supported API model names are deepseek-flash, deepseek-v4-pro,
but you passed deepseek-flash[1m].
```

因此当前启动器和 cliyard 默认值已改为 `deepseek-flash`。历史 evidence 中
保留的 `deepseek-flash[1m]` 是当时实测记录，不应继续作为可执行配置。

来源：

- [DeepSeek: Integrate with Claude Code](https://api-docs.deepseek.com/quick_start/agent_integrations/claude_code)
- [Claude Code: LLM gateways](https://code.claude.com/docs/en/llm-gateway)

Claude Code 官方明确不支持和审计“通过网关路由到非 Claude 模型”的兼容行为；这里使用的是 DeepSeek 提供的 Anthropic-compatible API。升级 Claude Code 后应重新跑 probe 和真实 Worker smoke。

## 3. Probe

```bash
claude-ds -p 'Reply exactly with PROBE_OK and nothing else.' \
  --output-format json --tools '' --max-budget-usd 0.05
```

期望：

```text
is_error=false
result=PROBE_OK
modelUsage has deepseek-flash
```

## 4. Cliyard Worker

```bash
npm run claude-batch -- \
  examples/claude-smoke.contract.json \
  --repo /path/to/temp-git-repo \
  --keep-worktrees
```

本机 2026-10-26 实测：

- Claude Code 调用 DeepSeek 成功。
- 在隔离 worktree 创建 `worker-smoke.txt`。
- Git diff 只包含契约允许路径。
- shell verifier 通过后进入 accepted。
- 单次短任务曾观察到约 `$0.15` 的 Claude Code CLI 估算值；这是
  non-authoritative 的 `cli-estimated`，不是 DeepSeek 账单或余额。

计划任务 `maxBudgetUsd` 默认 5 美元，可用
`CLIYARD_CLAUDE_MAX_BUDGET_USD` 覆盖。生产 Worker 应使用更低单次预算，
并通过 repair/task 规则扩大，不应无限重试。

较早的 DeepSeek 文档快照列出过 `deepseek-flash: 2500`、
`deepseek-v4-pro: 500`。这些数字是历史参考，不是当前订阅的可用容量，
也不会进入 cliyard 的默认并发。账号、endpoint、订阅层级、余额和区域都
可能改变限制，未来也可能出现文档未给出数字的 provider。

`CLIYARD_CLAUDE_MAX_CONCURRENT` 默认 3 只是本机全局 warm start。每个未知
执行绑定先使用单并发探针；调度器必须根据 provider 返回的额度/限流信息、
429、`Retry-After` 和实测成功窗口学习安全在途数。余额、价格和额度无法
读取时记录 `unknown`，不能当成无限或免费。连接重置、超时和 5xx 由
adapter 做有限指数退避重试，不能直接证明并发过高。

## 4.1 失败分类与成本真相（v0）

失败记录使用共享的十类枚举：`budget_exhausted`、`timeout`、
`provider_transient`、`provider_auth`、`provider_protocol`、
`worker_process_exit`、`verifier_rejected`、`policy_blocked`、
`resource_exhausted`、`unknown`。优先级为 timeout > budget > auth >
resource > transient > protocol > worker process exit > verifier > policy >
unknown；worker 进程失败绝不会因为 verifier 随后也失败而被改写成
`verifier_rejected`。记录只保留有限、脱敏的最终 provider 文本
（message ≤400 字符），不保留原始 payload、prompt、文件内容或认证头。
`retryableHint` 只是提示，不能触发重试。

Claude Code 的 `total_cost_usd` 记为 `state: "cli-estimated"`、
`authoritative: false`，不是 DeepSeek 账单、余额或额度。四种成本状态为
`provider-reported`、`cli-estimated`、`usage-only`、`unavailable`；token
usage 独立保留，CLI 显式输出的 0 保留为 0 但仍非权威；缺失或畸形成本为
`unavailable`/`null`，绝不写成 0。配置的 `maxBudgetUsd` 记为
`guardBudgetUsd`（保护上限），不是实际花费。重试和 repair 的每个 provider
session 都会进入 observation，已知金额只在同币种内合并为非权威 subtotal，
未知项保留在 `missing`。

adapter 原有的有限 transient retry 保持不变（默认 2 次，指数退避，仅针对
连接重置、超时和 429/5xx）；taxonomy 不增加也不移除重试，重试耗尽后返回
最终结构化失败。控制面没有自动 retry、路由或并行派发；queue 需要显式
`queue retry`，Supervisor 需要显式 `resume --retry-rejected`。dispatched run
的 failure/cost 以 RunManifest task 为权威；queue 只为没有 RunManifest 的
确定性 pre-dispatch block 保存 item-level failure。实测：focused
failure/cost 50/50、full suite 290/290、build exit 0；详见
[docs/evidence/FAILURE_COST_TRUTH.md](evidence/FAILURE_COST_TRUTH.md)。

## 4.2 预算续接（v0）

预算续接不是“给正在运行的进程加钱”。Claude 进程退出后，cliyard 只有在新
调用使用更大的 `--max-budget-usd` 时才能继续；旧进程的活动 guard 不会原地
改变。默认关闭，默认 continuation 数为 0。

policy 的 guard 计算是：

```text
首次调用 guard = baseGuardUsd
下一次累计 guard = 上次累计 guard + continuationGuardUsd
恢复调用 guard = 下一次累计 guard
空间检查 = 下一次累计 guard + overshootReserveUsd
           <= maxCumulativeGuardUsd
```

只有同时满足以下条件才 grant：

- 当前 invocation 已停止，最终结构化结果是 `is_error=true`，subtype 精确为
  `error_max_budget_usd`；
- 没有 timeout、signal、未解决 error/retry、malformed JSON stream、auth、
  transient、protocol、policy、resource 或 changed-path 失败；
- 该 invocation 已映射至少一个 `assistant`、`tool.start` 或 `tool.result`
  事件；thinking token 和 heartbeat 不算任务进度；
- 有 provider session id、`onExtension` callback、`autoContinue=true`；
- continuation 数量未耗尽，且累计 guard 加 overshoot reserve 仍在
  `maxCumulativeGuardUsd` 内；
- 当前 task 仍是未接受的 running task，worktree/branch/contract 未改变。

grant 先通过 `onExtension` 写入 RunManifest 的 `extensions`；callback 成功后
adapter 才启动：

```bash
claude ... --resume <provider-session-id> \
  --max-budget-usd <larger-cumulative-guard>
```

第二次调用不再传 `--session-id`。cwd/worktree、branch、prompt 和
TaskContract 保持原样。callback 失败、resume 进程失败或 resume 输出不满足
policy 时，不会自动再 grant 一次，也不会静默改成一个新的 provider session。
原有 transient retry 仍使用 fresh session；它和 budget continuation 是两条
独立路径。没有 RunManifest-backed `onExtension` 的普通 batch 会在 grant
前 fail closed，不会因为缺少持久化目标而继续启动新调用。

每个 initial、transient retry 和 resumed invocation 都保留独立 cost
observation。CLI 报告的 session id 会被保留；最终仍是
`error_max_budget_usd` 时，failure 仍是 `budget_exhausted` /
`provider`，code 为 `error_max_budget_usd`。

Supervisor `start`/`resume` 和 `claude-batch` 接受：

```text
--max-budget-usd <positive decimal>
--auto-continue-budget
--continuation-guard-usd <positive decimal>
--max-budget-continuations <0..64>
--max-cumulative-budget-guard-usd <positive decimal>
--budget-overshoot-reserve-usd <non-negative decimal>
```

参数在 lock 和 worker dispatch 前校验。只传 `--max-budget-usd` 时只设置首次
guard；需要显式 `--auto-continue-budget` 且 continuation 数大于 0。
Codex worker 不接受这些 budget continuation flags。

`total_cost_usd` 始终是 non-authoritative CLI estimate。guard 不是
DeepSeek/Claude 的余额、发票价格、额度或严格 hard cap；单次 provider 请求
可以 overshoot，reserve 只是保守估计。fake-CLI 行为、测试结果和限制见
[docs/evidence/BUDGET_CONTINUATION.md](evidence/BUDGET_CONTINUATION.md)。

本 slice 的最终检查：`npm run build` 通过，focused budget fake-CLI
15/15，受影响回归串行 90/90，合入后独立 `npm test` 338/338 通过。
真实 `deepseek-flash` resume probe 也确认同一 session 可在更大 guard 下继续；
该 probe 的 `$0.000001` guard 实际报告了 `$0.10665`，再次证明 guard 不是
严格 hard cap。

## 5. Plan / DSH

```bash
npm run plan-dispatch -- plan.json \
  --repo /path/to/target \
  --dispatch --worker claude --model 'deepseek-flash' --background
```

DSH 插件的 shipped patch 当前默认：

```text
defaultWorker: claude
model: deepseek-flash
```

仍然需要重启已有 DSH Desktop 进程，新的 Host 模块和工具才会重新加载。

## 6. 权限边界

Worker adapter 默认：

```text
permissionMode: acceptEdits
allowedTools: Read, Edit, Write, Bash
maxBudgetUsd: 5
timeoutMs: 20 minutes
auto budget continuation: false
max budget continuations: 0
```

运行前提：

- 只在 cliyard 管理的 worktree 中运行。
- Worker 不得 commit、push、merge。
- 最终验收由独立 verifier 执行。
- 如任务必须使用 `bypassPermissions`，应显式配置并只放在一次性 sandbox 中。

DeepSeek Anthropic compatibility 会忽略部分 Anthropic 字段，例如 `cache_control`、`mcp_servers` 等。不能假设 Claude Code 的所有原生能力都被 provider 等价支持。

## 7. 当前选择

第一 Worker：**Claude Code + DeepSeek flash 1M**。

备用 Worker：**Codex + DeepSeek**。

两者共享 TaskContract、worktree、Git diff gate、verifier 和 ledger。


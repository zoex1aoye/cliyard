# Claude Code + DeepSeek Worker

> 状态：本机已验证
>
> 日期：2026-10-26
>
> Claude Code：2.1.185
>
> 模型：`deepseek-flash[1m]`

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
export ANTHROPIC_MODEL='deepseek-flash[1m]'
export ANTHROPIC_DEFAULT_OPUS_MODEL='deepseek-flash[1m]'
export ANTHROPIC_DEFAULT_SONNET_MODEL='deepseek-flash[1m]'
export ANTHROPIC_DEFAULT_HAIKU_MODEL='deepseek-flash'
export CLAUDE_CODE_SUBAGENT_MODEL='deepseek-flash'
export CLAUDE_CODE_EFFORT_LEVEL=max
export CLAUDE_CODE_AUTO_COMPACT_WINDOW=786432
```

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
modelUsage has deepseek-flash[1m]
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
- 单次短任务实测约 `$0.15`；Claude Code 的 system/tool prompt 占主要输入成本。

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

## 5. Plan / DSH

```bash
npm run plan-dispatch -- plan.json \
  --repo /path/to/target \
  --dispatch --worker claude --model 'deepseek-flash[1m]' --background
```

DSH 插件的 shipped patch 当前默认：

```text
defaultWorker: claude
model: deepseek-flash[1m]
```

仍然需要重启已有 DSH Desktop 进程，新的 Host 模块和工具才会重新加载。

## 6. 权限边界

Worker adapter 默认：

```text
permissionMode: acceptEdits
allowedTools: Read, Edit, Write, Bash
maxBudgetUsd: 5
timeoutMs: 20 minutes
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


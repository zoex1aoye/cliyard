# Glass 实机试跑（ui-prototype × cliyard × DSH）

兄弟仓：[ui-prototype](../../ui-prototype)（README 自称 Glass UI Prototype；目录名不是 `glass-ui-prototype`）。

## 已接线

| 项 | 值 |
|----|-----|
| DSH CLI | `/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh`（0.2.1-rc.3） |
| Profile | `desktop` + `web` 已 `plugin add link:…/plugins/dsh-cliyard` |
| 目标仓 | `…/pers-project/ui-prototype` |
| 并行契约 | `cliyard/examples/glass-parallel.contracts.json`（Empty + Skeleton a11y，paths 不重叠） |
| Plan bridge | `cliyard/examples/glass-parallel.plan.json`；DSH 工具 `cliyard_plan_dispatch` |

## 本机命令

```bash
export DSH="/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh"
export GLASS="$HOME/Documents/pers-project/ui-prototype"
export CLIYARD="$HOME/Documents/pers-project/cliyard"

# 监控台
cd "$CLIYARD" && npm run master-monitor
# → http://127.0.0.1:3927/

# 干跑：双 worktree + Codex dry（不改真文件语义，写 stub 后清 worktree）
cd "$CLIYARD" && npm run codex-batch -- \
  examples/glass-parallel.contracts.json \
  --repo "$GLASS" --dry-run

# 新入口：先把 Plan 编成契约；这一步不会启动 Worker
cd "$CLIYARD" && npm run plan-dispatch -- \
  examples/glass-parallel.plan.json \
  --repo "$GLASS"

# Plan → 契约 → Codex dry dispatch
cd "$CLIYARD" && npm run plan-dispatch -- \
  examples/glass-parallel.plan.json \
  --repo "$GLASS" \
  --dispatch --worker codex --model deepseek-flash --dry-run

# Claude Code + DeepSeek first worker
cd "$CLIYARD" && npm run plan-dispatch -- \
  examples/glass-parallel.plan.json \
  --repo "$GLASS" \
  --dispatch --worker claude --model 'deepseek-flash' --dry-run

# 真跑：DeepSeek flash 双任务并行隔离（写 Empty / Skeleton）
cd "$CLIYARD" && npm run codex-batch -- \
  examples/glass-parallel.contracts.json \
  --repo "$GLASS" \
  --model deepseek-flash \
  --keep-worktrees

# 或经 Master 插件 CLI
cd "$CLIYARD" && npm run master-dispatch -- \
  --worker codex --repo "$GLASS" \
  --contracts examples/glass-parallel.contracts.json \
  --real-codex --keep-worktrees
```

DSH Desktop：重启 App 或 `dsh --profile desktop` 后插件应加载；监控默认端口 **3927**。
Plan 编译会写 `$GLASS/.cliyard/plans/glass-parallel-a11y.json` 与
`$GLASS/.cliyard/contracts/glass-parallel-a11y.contracts.json`。

## 验收看什么

1. Monitor 里 `glass-empty-a11y` / `glass-skeleton-a11y` 状态走向 accepted。  
2. 两个 worktree 路径不同（`.cliyard/worktrees/…`）。  
3. 主工作区 diff 仅触及各自 `writePaths`（合入前人工审）。
4. 生成契约的 `baseCommit` 是完整 commit SHA，`frozen=true`，且两任务 `dependsOn=[]`、写路径不重叠。

## 2026-10-26 实跑记录

- **DSH**：Desktop App 自带 CLI `…/runtime/cli/bin/dsh` **0.2.1-rc.3**；`desktop`/`web` 已 link `dsh-cliyard`。
- **目录名**：兄弟仓是 `ui-prototype`（Glass UI Prototype），不是 `glass-ui-prototype`。
- **`npm run glass-dry`**：双 worktree 并行 → accepted。
- **`npm run glass-dispatch`**（`deepseek-flash`，~59s）：两任务均 **accepted**；改动在独立 worktree：
  - Empty：`role="status"` on `t-empty`
  - Skeleton：`aria-busy` / `aria-hidden` when `loading`
- Monitor：`http://127.0.0.1:3927/`（ledger = `ui-prototype/.cliyard/ledger.json`）
- 主仓 `main` 工作区未被改写；合入需从 worktree cherry-pick / merge。
- 注意：git worktree **不复制** `node_modules`，worker 内完整 `vue-tsc` build 会缺依赖——契约 verify 用轻量 grep；完整 build 仍在主工作区跑。
- Plan bridge 已把业务仓（`repoRoot`）与控制面仓（`controlRoot`）拆开；此前插件按 `--repo "$GLASS"` 会误去业务仓找 `src/cli.ts`，现已由测试覆盖。

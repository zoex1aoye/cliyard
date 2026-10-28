---
name: cliyard-self-host-iteration
description: Use when using cliyard itself to plan, freeze, dispatch and review the next cliyard iteration, with Plan-first commits, accepted-integration provenance and a mandatory human diff gate.
---

# Cliyard Self-host Iteration

## Goal

用当前已验收的 cliyard 能力推动下一轮工具迭代，并从真实执行中记录缺口。

核心闭环：

```text
现状与缺口
  → 设计说明
  → 已审阅 Plan
  → accepted-base frozen contracts
  → Supervisor / queue
  → evidence
  → 人工审 diff
  → 新的 accepted integration
```

## 0. Preflight

```bash
git status --short --branch
git rev-parse HEAD
git worktree list
node --version
```

再以只读方式检查：

- 最新 accepted integration branch/worktree；
- 是否有 active Supervisor lock、queue lock、WorkerLease、runtime 或孤儿；
- Plan、contracts、known gaps 和相关 evidence 的当前版本；
- 用户是否已经授权 commit、派发、保留 worktree，但没有授权自动合入。

没有用户明确授权派发时，本轮只停在 Plan/缺口整理。

## 1. Record the Gap

先写事实，不先写方案：

- 观察到的症状和复现命令；
- 影响、风险、优先级；
- 当前实现 vs 设计目标；
- 修复后必须测量的 invariant；
- 明确 non-goals。

更新已有权威文档；不要另造一份重复真相。

## 2. Produce the Plan

使用 `cliyard-design-to-plan`：

- 按可验收单元拆任务；
- 明确 write paths、依赖、验收与运行证据；
- 让基础能力先于消费它的上层；
- 只把真实独立任务放进同一 parallel wave；
- 用估算识别 XL 和预算/时长风险。

在 Plan 中写明本轮 self-host provenance：

- 从哪个 accepted integration commit 启动控制面；
- 目标是主 checkout；
- 新代码在本 run 后才可能用于下一次 self-host；
- 本 run 若包含 boundary/process 能力，RunManifest 必须显示对应真实证据。

## 3. Commit Plan First

如果用户已要求在 Plan 后派发：

1. 只提交设计说明、Plan、缺口文档；
2. 确认 Plan commit 和目标 branch；
3. 再进入契约编译。

如果没有提交授权，交付 Plan 后停止并请用户确认。

## 4. Freeze Contracts from the Accepted Base

使用 `cliyard-contract-freeze`。

关键要求：

- 在最新 accepted integration worktree 的代码上编译；
- contracts 的 `baseCommit` 是 accepted integration 完整 SHA；
- 目标是主 checkout 的待审文件；
- Plan 与 contracts 分两个 commit；
- 记录 contracts byte hash；
- 不把当前 task worktree 中尚未接受的实现当作 orchestrator。

如果选择 queue：

- 先确认 `queue add-plan` pin 的 root base 确实是本次 accepted base；
- 不满足就不要为了“走 queue”而接受错误 base。

## 5. Dispatch

从 accepted integration worktree 启动 control-plane CLI，目标仍是主 checkout：

```bash
cd <latest-accepted-integration-worktree>
npx tsx src/cli.ts supervisor start <target>/design/<id>.contracts.json \
  --repo <target-main-checkout> \
  --worker <claude|codex> \
  --model <model-id> \
  --keep-worktrees
```

真实命令可因 worker/profile/continuation policy 不同而变化；以当前 CLI help 为准。
如果需要 queue 的多 item 协调，先用 `queue status --json` 检查 binding 和 base，
再显式 `queue run`；不要假设 queue 已经是并行 daemon。

记录：

- runId；
- contracts hash；
- worker/model/profile；
- start/resume 命令；
- 监控路径或 status 查询；
- 预期 evidence。

## 6. Monitor and Recover

- 用只读 `status` 观察 manifest、progress、failure、cost、lease 和 lock。
- progress 活跃不等于 acceptance；heartbeat 不等于项目进展。
- timeout/budget 只有在有界、健康且可审计的 policy 下才能续期。
- controller death 后用精确 lease identity 恢复；身份不明则 `needs_human`。
- 不对未知进程做 broad kill，不删除 dirty worktree，不重写失败 RunManifest。

## 7. Review Before Merge

用 `cliyard-acceptance-review`：

- Plan/contract hash；
- commit lineage；
- path audit；
- focused/full tests；
- workspace boundary；
- nested process/lease/runtime cleanup；
- visual/runtime evidence；
- cost/failure truth；
- known gaps。

默认保留 task/integration worktree。向用户交付可合入 commit 和 diff 摘要，
只有用户明确要求时才 merge、push 或清理。

## 8. Feed Findings Back

如果本轮暴露新缺陷：

- 写具体观察和证据，不只在聊天里说；
- 判断是实现 bug、测试盲点、tooling 缺口、设计错误还是运行安全边界；
- 更新 known gaps/evidence；
- 下一轮仍从最新 accepted integration 起跑；
- 同一问题重复出现时，更新本 Skill 或对应 rule，避免靠记忆纠正。

## Current Priority Guard

截至 2026-10-28，不绕开安全前置直接做动态并行或长驻 daemon。

优先闭环：

1. controller-death nested process ownership；
2. provider-neutral `SandboxProvider`；
3. ProfileCatalog + activation；
4. per-run ownership + hierarchical admission；
5. versioned Control API/event stream。

在未测量完成前，不宣称 24 小时无人值守、全量并行或 OS 沙箱已具备。

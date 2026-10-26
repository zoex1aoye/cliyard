# Key Mind 连续多任务试验协议

> 目标：验证系统不会因为“这一轮完成”而停下，而是根据设计依赖继续下一轮。
>
> 原则：先验证确定性 DAG 连续执行，再验证 Master 生成下一轮任务。

## 1. 连续不等于无限聊天

Key Mind 的连续性由外层循环保证：

```text
读取持久状态
  → 恢复过期 lease
  → 计算 ready 任务
  → 派发本轮
  → 等待完成
  → 独立验收
  → 合入可接受的产物
  → 更新设计覆盖与未完成缺口
  → 进入下一轮
```

模型可以每轮更换或重启；Supervisor 和状态机器不能结束。

有两种连续模式：

| 模式 | 下一轮任务来源 | 首版是否实现 |
|---|---|---|
| 反应式连续 | 设计包中预先定义、依赖 satisfied 后解锁 | **先实现** |
| 生成式连续 | Master 读取证据和设计缺口，生成新 TaskContract | 后续实现 |

第一版不能把随机生成新任务和可靠调度混在一起，否则失败原因不可分辨。

## 2. Cursor multitask 与 Key Mind 的差异

| Cursor multitask | Key Mind |
|---|---|
| 用户发起一批独立任务 | Supervisor 持有整个项目循环 |
| 任务结束即本轮结束 | accepted 任务解锁后续 DAG |
| 各 Agent 结果等待人工合流 | 接受结果进入 integration queue，成为下一轮基线 |
| 没有公开项目租约与恢复状态 | claim、lease、heartbeat、resume |
| 批次之间由人继续操作 | 无 ready 任务时进入 reconcile/planning，不是默认退出 |
| 没有统一验收证据 | Evidence Bundle + Verifier + verdict |

## 3. 已修的产物传递阻塞

早期 `claude-batch` / `codex-batch` 会从同一个 base commit 创建多个 worktree，
下游 Worker 看不到上游 worktree 的 diff。

例如：

```text
T1 创建 foundation.ts
T2 dependsOn T1，verify: test -f foundation.ts
```

旧实现下 T2 会失败，因为它仍从旧 base commit 起步。

连续构建必须增加以下之一：

- 每个依赖链共享一个 lane worktree。
- accepted 任务生成临时 snapshot commit，下一轮从 integration branch 起步。
- 将 accepted patch 应用到下游 worktree，并记录 patch/tree hash。

现已实现：

```text
task branch
  → accepted snapshot
  → integration branch
  → dependent worktree starts from integration commit
```

临时 task/integration commit 只存在于 cliyard 分支，不自动改动用户 default branch。
实现入口见 `src/scheduler/codex-batch.ts`，回归测试见
`tests/continuous-batch.test.ts`。

## 4. 第一阶段：确定性连续执行 fixture

先使用临时 Git 仓，不启用真实 Claude API。

### T1 · Foundation

```text
创建 foundation.ts
verify foundation.ts 存在
```

### T2 · Left wing

```text
dependsOn: T1
读取 foundation.ts
创建 left.ts
verify foundation.ts + left.ts 存在
```

### T3 · Right wing

```text
dependsOn: T1
读取 foundation.ts
创建 right.ts
verify foundation.ts + right.ts 存在
```

### T4 · Upper floor

```text
dependsOn: T2, T3
读取 left.ts + right.ts
创建 upper.ts
verify 四个文件都存在
```

预期执行：

```text
Wave 1: T1
Wave 2: T2 + T3
Wave 3: T4
stop: all accepted
```

这不是一次并行 batch 结束，而是三个连续 ready wave。

### 失败用例

- T1 rejected：T2/T3 不得启动，T4 不得启动。
- T2 rejected：T3 可以完成，T4 必须 blocked。
- 进程重启：已 accepted 的 T1/T3 不重跑。
- 重复 claim：同一任务只能有一个有效 lease。

## 5. 第二阶段：真实 Claude Worker

fixture 通过后，再跑真实 Claude + DeepSeek，但只选低风险任务。

建议试验设计修订：

```text
designRevision: glass-status-surface-v1
```

任务图：

```text
T1 状态面 token / 设计契约
       │
       ├──────────────┐
       ▼              ▼
T2 GlassEmpty     T3 GlassSkeleton
status semantics  busy/decorative semantics
       │              │
       └──────┬───────┘
              ▼
T4 Lab /data 状态示例
              ▼
T5 同视口截图 + axe + 验收报告
```

约束：

- T1 独占 `theme.css`。
- T2/T3 写路径不重叠。
- T4 必须基于 T2/T3 已合入的状态。
- T5 从精确 artifact 启动 preview，使用临时端口。
- 在独立 experiment worktree 中进行，不直接改 `ui-prototype/main`。

## 6. Supervisor 连续循环

```text
loop:
  recoverExpiredLeases()
  reconcileRunningRuns()
  verifyCompletedWorkers()
  integrateAcceptedTasks()
  refreshReadyTasks()

  if blockedNeedsHuman:
      stop and notify
  if readyTasks:
      dispatchReadyWave()
      continue
  if runningTasks:
      waitForEvent()
      continue
  if accepted covers design:
      stop with converged
  if noProgress:
      invokePlannerForNextWave()
      admissionReview(nextWave)
      continue
```

必须设置：

- `maxRounds`
- `maxWallClock`
- `maxParallelWorkers`
- `maxTotalBudget`
- `noProgressThreshold`
- `repeatedFailureThreshold`

## 7. 动态规划何时加入

确定性 DAG 全部 accepted 后，Master 才进入生成式下一轮：

1. 读取冻结设计和 Acceptance Matrix。
2. 读取已完成任务与 Evidence Bundle。
3. 找出未覆盖 acceptance item。
4. 提出下一组 Plan。
5. Gateway 校验路径、依赖、资源和证据。
6. 若只是既定设计内的拆分，可自动入 ready。
7. 若修改视觉方向或设计权威，进入 `needs_human`。

Master 不能根据聊天情绪随意增加范围。

## 8. 可用性指标

一条试验必须记录：

```text
wave count
用户介入次数
任务重复执行次数
accepted / rejected / blocked
每轮耗时与成本
上游产物可见率
verification evidence completeness
restart recovery time
设计 acceptance coverage
```

最小通过标准：

1. 无需用户催促，自动从 Wave 1 进入 Wave 2/3。
2. Wave 2/3 能读取 Wave 1 产物。
3. Wave 4 只在前置图全部 accepted 后启动。
4. accepted 结果进入新基线，不依赖旧 worktree 手工 cherry-pick。
5. 关闭 GUI 不影响 Supervisor。
6. 杀死 Supervisor/Worker 后可恢复，不重复执行。
7. 全部轮次结束后给出设计覆盖率与证据清单。

## 9. 第一刀（已完成）

连续 fixture test：

```text
T1 creates foundation.ts
T2 dependsOn T1 and verifies foundation.ts exists
```

实现 integration baseline 后，fixture 现在达到：

```text
Wave 1 accepted
Wave 2 accepted
Wave 3 accepted
converged
```

这条测试通过后，才值得花真实 Claude 额度跑 Glass 实验。

## 10. 设计上下文必须进入基线

Git worktree 只包含所选 commit 中已跟踪的文件。

主工作区里未提交或未跟踪的 `.agents/tmp-*`、设计草稿、原型说明，不会自动出现在 Worker worktree。

因此正式派发至少满足：

- Design Pack 已在目标分支提交；或
- Gateway 显式复制并记录 read-only context pack；或
- 缺失 readPath 直接让任务 `blocked`，不能静默继续。

本机 WinUI Wave 0 审计已经观察到这一现象：主工作区存在的临时 WinUI 方案文件，在 worktree 中缺失。


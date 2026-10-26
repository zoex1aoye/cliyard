# 下一迭代：Supervisor v0 与工具自举

> 日期：2026-10-26
>
> 结论：下一刀只做持久 Supervisor，不扩 GUI、模型或组件数量。

## 1. 为什么现在做 Supervisor

当前已经证明：

- Plan → frozen Contract；
- DAG 多 wave；
- accepted 产物进入 integration baseline；
- Claude Code + DeepSeek Worker；
- 独立 worktree；
- build / shell verify；
- background dispatch；
- 跨进程 ledger 锁；
- 任务成本/轮次估算。

但还缺最关键的生产能力：

```text
Supervisor 进程结束
  → 下一次必须重新发起完整 batch
  → 已完成任务可能重跑
  → integration checkpoint 需要人手工管理
```

因此下一迭代只有一条主线：

> **让 Supervisor 能从持久 run manifest 恢复未完成工作，并继续下一 wave。**

## 2. V0 范围

包含：

- 单仓、本机 Supervisor；
- 持久 RunManifest；
- accepted task checkpoint；
- integration branch checkpoint；
- 单 Supervisor 锁；
- `start / status / resume`；
- 进程中断后的恢复；
- 无 ready 任务时明确进入 completed / blocked。

不包含：

- SQLite 迁移；
- Web/GUI 改版；
- RuntimeManager；
- 自动合入 default branch；
- 第二家 Worker；
- 生成式重新规划；
- 多租户/云执行。

V0 先使用原子 JSON manifest + 现有文件锁验证恢复语义；SQLite 在并发和查询需求被真实逼出后再迁移。

## 3. 自举原则

用现有工具迭代工具本身：

```text
当前稳定 Supervisor/CLI
  → 读取新版本 Design Pack
  → 生成 frozen Plan
  → 派给 Claude Worker
  → 新版本只存在于 worktree
  → 在 worktree 跑旧测试 + 新测试
  → accepted snapshot
  → 人工审阅
  → 合入新版本
  → 重启后由新 Supervisor 接管
```

安全规则：

1. 正在运行的 Supervisor 代码不被 Worker 修改。
2. 新代码必须通过旧测试和新测试。
3. 运行中不得热重载任务控制面。
4. accepted 后人工合并，不自动改 main。
5. 恢复测试必须模拟 Supervisor 中断，而不只是单测状态对象。
6. 新 Supervisor 第一次启动必须支持 `--dry-run` 或 read-only status。

## 4. 开始自举前的前置条件

1. 当前 cliyard 工作树通过 `npm test` 和 `npm run build`。
2. 当前工作树冻结为可复现 baseline commit。
3. Design Pack 与 Plan 进入 baseline。
4. 使用 `estimate-plan` 检查任务粒度。
5. 任何 XL 任务先拆分。

当前仓库还存在大量未提交实现，因此未冻结前不能安全派发“工具改自身”的任务。

## 5. 完成标准

1. `supervisor start` 创建 RunManifest。
2. 每个 accepted task 后写 checkpoint。
3. `supervisor status` 能看到 completed / running / pending。
4. 中断后 `supervisor resume` 不重跑 accepted task。
5. resume 使用已有 integration branch。
6. plan/base/contracts hash 不一致时拒绝 resume。
7. 两个 Supervisor 同时启动只有一个取得锁。
8. 所有现有测试继续通过。
9. 新增中断恢复测试。

## 6. 下一步顺序

```text
1. 冻结 baseline
2. 估算 Supervisor Plan
3. dry-run dispatch
4. Claude 实现 manifest/store
5. Claude 实现 resume loop
6. Claude 接入 start/status/resume
7. verifier + 中断恢复测试
8. 人工审阅
9. 合入并重启
```


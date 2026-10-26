# 下一迭代：Supervisor v0 验收收口与安全自举

> 日期：2026-10-27（更新）
>
> 结论：Supervisor v0 已实现，真实进程级 SIGKILL 恢复 E2E 已通过。下一步让新 Supervisor 接管一次真实自举，再决定是否需要后台化；不扩 daemon、SQLite、Web/GUI 或多租户。

## 0. 当前状态

Supervisor v0 已落地（单仓、本机、前台）：

- `cliyard supervisor start / status / resume / stop`；
- 持久 RunManifest（原子 JSON）；
- 每个 accepted / rejected task 后写 checkpoint；
- integration branch 作为恢复检查点；
- accepted task 不会在 resume 时重跑；
- 单 Supervisor 锁、stale/invalid lock 诊断与显式恢复；
- contracts hash、base commit、integration branch 前置检查；
- `--retry-rejected` 显式重试被拒任务；
- 前台信号处理：SIGINT/SIGTERM 标记 interrupted 并释放锁；
- 真实独立进程 SIGKILL 后，新进程能识别 stale lock，并只恢复未完成 wave。

明确未落地：

- 后台 daemon / 24h 常驻；
- SQLite（仍为原子 JSON manifest）；
- 自动合入 default branch；
- Web/GUI、RuntimeManager、多租户/云执行；
- 第二家 Supervisor Worker（仅 claude / codex）。

验证（2026-10-27，本工作树）：

```text
npm run build   → 通过
npm test        → 86/86 通过
```

操作语义、RunManifest 字段、锁状态、恢复手册和自举步骤见
[docs/SUPERVISOR_V0.md](SUPERVISOR_V0.md)。

## 1. V0 完成标准对照

| # | 原完成标准 | 状态 |
|---|------------|------|
| 1 | `supervisor start` 创建 RunManifest | 已实现 |
| 2 | 每个 accepted task 后写 checkpoint | 已实现；rejected task 也写 checkpoint |
| 3 | `supervisor status` 能看到 completed / running / pending | 已实现；另报告 `effectiveStatus`、blocked、锁与 integration head |
| 4 | 中断后 `supervisor resume` 不重跑 accepted task | 已实现；进程内中断测试覆盖 |
| 5 | resume 使用已有 integration branch | 已实现；缺失、head 不包含或 accepted commit 不在分支上会拒绝 |
| 6 | plan/base/contracts hash 不一致时拒绝 resume | 已实现；contracts 按字节 hash，base 必须解析到同一 commit |
| 7 | 两个 Supervisor 同时启动只有一个取得锁 | 已实现；`O_EXCL` 锁 + 测试覆盖 |
| 8 | 所有现有测试继续通过 | 已实现；86/86 |
| 9 | 新增中断恢复测试 | 已实现；进程内注入和真实独立进程 SIGKILL/restart 均覆盖 |

## 2. 下一迭代范围

只做三件事：

1. **进程级中断恢复 E2E（已完成）**
   - 独立 supervisor 进程在第二 wave 运行时整进程组 SIGKILL；
   - `status --json` 报告 `interrupted` / `stale` lock；
   - `resume` 只派发未完成任务；
   - accepted task 的 commit 保持不变；
   - 完成后 integration branch 与 manifest 一致。

2. **冻结 baseline 并完成一次安全自举（人工执行）**
   - 按 [SUPERVISOR_V0.md §8](SUPERVISOR_V0.md#8-safe-tool-self-hosting-procedure) 执行；
   - 稳定 Supervisor 从冻结的 control checkout 运行；
   - 新代码只存在于 worktree，accepted 后进入 integration branch；
   - integration 上跑旧测试 + 新测试；
   - 人工审阅后手工 merge；
   - 新 Supervisor 第一次启动只做 read-only / dry-run 演练，再接管真实 run。

3. **记录证据并收口文档**
   - 记录 runId、contracts hash、base commit、integration branch/head、任务结果、测试输出、审阅结论；
   - 只按实际结果更新 README / NEXT_ITERATION / SUPERVISOR_V0。

不在本迭代范围：

- daemon / 后台常驻 / 24h 无人值守；
- SQLite 或其他状态存储迁移；
- 自动合入 main；
- Web/GUI 改版；
- RuntimeManager；
- 第二家 Worker；
- 多租户/云执行。

## 3. 自举安全规则

完整命令与检查表见
[SUPERVISOR_V0.md §8](SUPERVISOR_V0.md#8-safe-tool-self-hosting-procedure)。最小规则：

1. 正在运行的 Supervisor 代码不被 Worker 修改；Supervisor 只从冻结的 control checkout 启动。
2. Worker 只写自己的 task worktree；不得写 `.cliyard/supervisor.lock`、`.cliyard/runs/*`、control checkout 或仓库外路径。
3. contracts 与 base commit 在 `start` 前冻结；运行中不编辑 contracts，不改 base。
4. 所有 task 的 `writePaths` 互不重叠，`sharedResources` 为空，不使用 XL 任务。
5. accepted 后先进入 integration branch，不自动改 main；必须人工审阅后 merge。
6. 运行中不热重载任务控制面；先 stop，再 merge，再重启。
7. 新代码必须通过 baseline 旧测试和新增测试；恢复测试必须模拟真实进程中断。
8. 新 Supervisor 第一次启动必须支持只读 `status` 和 `--dry-run`。
9. 保留旧 baseline ref 与旧二进制，失败可回滚。

## 4. 开始自举前的前置条件

1. 当前工作树通过 `npm run build` 和 `npm test`（本次已通过）。
2. 当前工作树冻结为可复现的 baseline commit/tag；实现快照与本次文档改动都需进入 baseline 并由人工提交/打标签。除本次文档文件外，未跟踪项只有 `node_modules` 符号链接（忽略规则未覆盖符号链接，不应提交）。
3. Design Pack 与 Plan 进入 baseline B；冻结 contracts 写到受版本控制的路径并单独提交（C），`baseCommit` 使用完整 SHA。
4. 使用 `estimate-plan` 检查任务粒度；任何 XL 任务先拆分。
5. contracts 的 `writePaths` 互不重叠，`sharedResources` 为空，verifyCommands 能在 worktree 内独立运行。
6. 稳定 Supervisor 从 control checkout 运行，并从 baseline 启动；不要从 task worktree 运行。
7. 保留旧版本 ref 与二进制，作为回滚路径。

## 5. 完成标准

1. 进程级 kill/restart E2E 已通过；accepted task 不被重跑。
2. 至少一次工具自举 run 在 integration branch 上得到 accepted 结果，且旧测试 + 新测试通过。
3. 人工审阅完成，手工 merge；没有自动合入 main 或自动 push。
4. 新 Supervisor 的 read-only / `--dry-run` 首次启动检查通过。
5. 文档按真实结果记录 runId、branch、commit、测试输出与审阅结论。
6. 所有现有测试继续通过。
7. 全文不宣称 daemon、24h 常驻或 SQLite 支持。

## 6. 下一步顺序

```text
1. [已完成] Verifier 进程级 kill/restart E2E
2. 冻结 baseline commit/tag
3. estimate-plan + 编译并提交 contracts
4. scratch repo dry-run 演练
5. 真实 self-host supervisor run（stop/resume 演练）
6. integration branch build + test + 人工 diff 审阅
7. 新 Supervisor read-only / dry-run 首启动
8. 人工 merge + 重启
9. 记录证据，再决定是否需要后台化或 SQLite
```

后台化和 SQLite 只有在真实并发/查询/常驻需求出现后才进入设计；当前不作为 v0 能力或承诺。

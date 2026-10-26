# Key Mind V1：Walking Skeleton

> 目标：先证明一条最小但真实的交付链，不先扩 GUI 和 Worker 数量。  
> 配套：[KEY_MIND.md](./KEY_MIND.md)、[MASTER_OPERATING_MODEL.md](./MASTER_OPERATING_MODEL.md)

连续多任务与多轮构造的试验协议见 [CONTINUOUS_TRIAL.md](./CONTINUOUS_TRIAL.md)。

## 1. 第一条闭环要证明什么

第一条闭环必须同时证明四件事：

1. 任务来自版本化设计，而不是聊天里的临时 prompt。
2. 同一任务只能被一个 Worker 认领，可以崩溃恢复。
3. Verifier 从 Worker 后的精确代码状态启动独立运行态。
4. accepted 必须带 build、运行、a11y 和视觉证据。

第一条闭环只允许：

- 一个目标仓：`ui-prototype`
- 一个 Worker Adapter：Claude Code + DeepSeek
- 一个 Verifier
- 一个 Supervisor
- 一个真实任务
- 一个设计修订

多 CLI、完整 GUI、自动合入和团队多租户后置。

## 2. 第一个真实用例

选择 `GlassEmpty` 的低风险可访问性任务：

```text
taskId: glass-empty-status
goal: 为 Quiet Empty 根元素增加 status 语义
writePaths:
  - glass-frontend/src/components/glass/GlassEmpty.vue
verify:
  - npm run build
  - DOM 中存在 role="status"
  - /data 页无新增 a11y 严重问题
evidence:
  - build log
  - Playwright DOM 断言
  - same-viewport screenshot
  - axe result
```

选择标准：

- 真实修改项目代码，不是纯 mock。
- 单文件写入，冲突面小。
- 有可执行 DOM 验收。
- 需要实际启动 Vite 服务，能验证运行态和端口租约。
- 即使失败也容易回退，不阻塞大范围设计工作。

## 3. 本轮不做什么

- 不接 Claude Code、CodeBuddy、Qwen Code、OpenCode。
- 不做完整 DSH 页面。
- 不做自动合入 main。
- 不做基于语义模型的复杂验收。
- 不做多目标仓。
- 不做权限后台、团队租户和云端执行。

先把单机单仓的可靠性做对。

## 4. 目标结构

```text
Design Pack
  ↓
TaskContract + RuntimeSpec
  ↓
SQLite/WAL任务与租约
  ↓
Supervisor daemon
  ↓
Claude Code + DeepSeek Worker Adapter
  ↓
worktree
  ↓
RuntimeManager
  ├─ dependency cache
  ├─ port lease
  ├─ build
  ├─ preview
  └─ readiness
  ↓
Verifier + Evidence Bundle
  ↓
Monitor / human
```

## 5. MVP 数据模型

最小 SQLite 表：

```text
tasks
  id, design_revision, status, priority, spec_json,
  created_at, updated_at

dependencies
  task_id, depends_on, required_status

runs
  id, task_id, attempt, worker, model, workspace,
  base_commit, patch_hash, started_at, ended_at, exit_code

leases
  task_id, owner, token, expires_at, heartbeat_at

events
  id, run_id, type, payload_json, created_at

runtimes
  id, run_id, service, host, port, pid, status,
  health_url, log_path, started_at, ended_at

evidence
  id, run_id, kind, path, sha256, metadata_json

verdicts
  id, run_id, result, reason, evidence_ids_json, created_at
```

`ledger.json` 可以继续作为只读展示缓存，但不再承担 claim/lease 的事务职责。

## 6. Milestones

### M0：设计与状态契约

交付：

- `DesignRevision` 文档
- `TaskContract` 增加 `designRevision`
- `RuntimeSpec` 草案
- `EvidenceSpec` 草案
- SQLite schema 与迁移

完成标准：

- 未冻结设计不能进入 ready。
- 任务能追溯到设计修订和验收矩阵。

### M1：持久队列与 Supervisor

交付：

- `enqueue`
- `claim`
- `heartbeat`
- `release`
- `recover`
- headless supervisor loop

完成标准：

- 两个 supervisor 同时启动，只有一个能 claim 同一任务。
- lease 到期后任务可重新 claim。
- 重启后不重复启动已 accepted 的任务。

### M2：Workspace 和 Worker

交付：

- 唯一 worktree
- base commit / patch hash
- 依赖缓存策略
- Claude Code + DeepSeek adapter 接入
- worker log 与 session 元数据落盘

完成标准：

- Worker 在独立 worktree 修改唯一文件。
- 主工作区不被改写。
- Worker 崩溃后 run 状态可见，任务可重派。

### M3：RuntimeManager 与 PortAllocator

交付：

- 持久端口 lease
- `127.0.0.1` 绑定探测
- `EADDRINUSE` 重试
- build/preview 启动
- readiness
- 进程组清理

完成标准：

- 两个 run 同时运行不冲突。
- 服务日志、端口、健康 URL 写入 `runtimeManifest`。
- Verifier 结束后无遗留监听进程。

### M4：独立 Verifier 与 Evidence Bundle

交付：

- build 门禁
- Playwright DOM / 截图
- axe 检查
- evidence hash 与目录
- accepted / accepted_with_gap / rejected / needs_human

完成标准：

- Worker 退出码 0 但证据缺失时不能 accepted。
- 相同代码快照可重复得到同一类验收结论。

### M5：监控与真实任务

交付：

- 监控展示设计修订、任务、run、runtime、evidence、verdict
- 一条真实 `glass-empty-status` accepted diff
- 一次 verify fail → repair → accepted
- 一次 supervisor/worker 重启恢复

完成标准：

- 人从监控能回答“做了什么、证据在哪、为什么通过/失败、下一步是什么”。

## 7. 依赖缓存

`ui-prototype` 的 worktree 不包含 `node_modules`。

不允许每个 worktree 无脑重装。

建议：

```text
package-lock.json hash
  → shared dependency cache
  → worktree node_modules symlink
```

规则：

- 锁文件未变：只读复用缓存。
- 锁文件变化：依赖安装成为独立资源锁任务。
- verifier 不使用主工作区中可能被手工修改的依赖。
- 缓存版本和 hash 写入 RuntimeManifest。

## 8. RuntimeSpec 草案

```json
{
  "services": [
    {
      "name": "web",
      "command": ["npm", "run", "preview", "--", "--host", "127.0.0.1", "--port", "${PORT}"],
      "cwd": "glass-frontend",
      "portEnv": "PORT",
      "readiness": {
        "path": "/",
        "expectedStatus": 200,
        "timeoutMs": 30000
      }
    }
  ],
  "browser": {
    "viewport": { "width": 1440, "height": 900 },
    "routes": ["/data"],
    "colorSchemes": ["light", "dark"]
  }
}
```

Build 属于静态门禁，preview 属于运行态验收，两者分开记录。

## 9. 第一轮实现顺序

建议按以下顺序改代码：

1. `src/persistence/sqlite.ts`
2. `src/supervisor/queue.ts`
3. `src/supervisor/daemon.ts`
4. `src/runtime/ports.ts`
5. `src/runtime/manager.ts`
6. `src/verification/evidence.ts`
7. `src/agents/claude.ts` lifecycle 接入
8. monitor 读取控制面视图

不要先做新 UI 页面。

## 10. 首轮验收测试

1. 未冻结 design revision 的任务不能 enqueue。
2. 两个进程同时 claim，只有一个成功。
3. Worker 中途 kill，lease 到期后可重派。
4. Supervisor 重启后继续 ready 任务。
5. 两个 preview 使用不同端口和浏览器 profile。
6. preview 启动失败时保存日志和端口记录。
7. build 失败时不启动浏览器验收。
8. 无截图或 a11y 结果时只能 `accepted_with_gap`。
9. repair attempt 使用新 run，不复用旧服务。
10. 清理后端口不再监听，进程树不存在。

## 11. 完成定义

V1 walking skeleton 完成不是“能派发一个任务”，而是：

> 在一个人为杀死 Supervisor 和 Worker 的测试里，系统仍能从一个已冻结设计版本恢复，认出唯一未完成的任务，启动新的隔离 Worker 和运行态，产出可审证据，并给出不会自我美化的 verdict。

这条链跑通后，才值得接第二个 coding CLI。


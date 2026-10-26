# Master 持续开发模型：设计、派发与独立运行验收

> 状态：设计原则
>
> 日期：2026-10-26

## 1. 产品定位

Master 不是“一个靠超长上下文连续清醒 24 小时的 GUI”，而是一套可恢复的开发运营系统：

- 人负责视觉方向、详细设计、关键决策和最终视觉签收。
- Supervisor 负责持久状态、任务队列、租约、恢复、预算和 watchdog。
- Gateway 负责准入检查、能力匹配、限流和派发。
- Master/Planner Agent 负责设计整理、任务拆分、冲突解释和裁决建议。
- Worker 负责在隔离工作区实现，不能自我验收。
- Verifier 负责从精确代码状态启动运行态，重跑门禁和视觉验收。
- Integration Queue 负责按依赖合入、冲突停机和合入后复验。
- GUI 只展示和操作控制面；控制面关闭 GUI 后仍能工作。

产品的可靠承诺不是“模型不会忘”，而是：

> 模型会话、GUI、Supervisor 或 Worker 可以退出；设计版本、任务状态、运行租约、证据和裁决不会丢，下一轮可以从磁盘和控制面恢复。

## 2. 持久真相分层

| 层 | 内容 | 真相位置 |
|---|---|---|
| 设计真相 | specs、ADR、视觉 token、组件契约、验收矩阵 | 版本化设计工作区 |
| 运行真相 | task、attempt、run、event、lease、runtime、verdict | 控制面数据库 |
| 代码真相 | base commit、task branch、artifact commit、diff | Git |
| 证据真相 | build、测试、截图、a11y、日志、偏差清单 | artifact/evidence bundle |

聊天、prompt 和临时日志都不是最终真相。Resume Pack 是索引，恢复时必须重新核对设计版本、控制面和 Git 状态。

## 3. 任务状态与准入

建议保留以下宏观状态：

```text
draft
  → ready
  → claimed
  → running
  → verifying
  → repairing（有限次）
  → accepted | rejected | blocked | needs_human | cancelled
```

运行态启动属于 `verifying` 内部生命周期，不需要为每个子步骤永久增加顶层状态：

```text
static_gates
  → runtime_lease
  → runtime_starting
  → runtime_ready
  → runtime_checks
  → evidence_frozen
  → runtime_stopping
  → verdict
```

只有以下条件全部满足，任务才能进入 `ready`：

- 设计版本已冻结，`designRevision` 明确。
- 目标、non-goals、公开 API、状态矩阵和验收材料完整。
- 依赖已接受。
- `writePaths` 不重叠，或者共享资源锁已经获得安排。
- 运行态和视觉证据要求已定义。
- Worker 能力、预算、超时和 lease 可用。
- 没有未决 P0 设计问题。

GUI 中的“已确认待办空间”应当只对应 `ready`，不能把 `draft` 或模糊需求直接派发。

## 4. 运行测试放在哪个环节

运行测试和浏览器验收属于 **Verifier 阶段**，不属于实现 Worker 的可信验收阶段。

推荐顺序：

1. Worker 在隔离 worktree 完成实现，产出代码状态和过程说明。
2. Verifier 先跑不需要服务的静态门禁：
   - typecheck
   - build
   - unit test
   - 静态 a11y / token / 路径检查
3. 静态门禁通过后，Verifier 从同一代码快照申请运行租约。
4. Verifier 启动前端、API 和其他依赖服务。
5. 等待真实 readiness，而不是固定 `sleep N`。
6. 执行 smoke、E2E、API、视觉截图、a11y 和交互检查。
7. 冻结证据包并停止整棵进程树。
8. Verifier 写入 verdict；Master 在契约范围内裁决。
9. 需要 repair 时重新产生 attempt 和运行租约，不复用旧服务。
10. 接受后的 commit 进入 Integration Queue，在合入点再跑一次必要的 smoke/visual regression。

Worker 可以为了自己开发而启动服务，但那是：

```text
worker_preview
```

它不能直接成为：

```text
acceptance_runtime
```

验收必须在 Worker 进程结束后重新启动，避免隐藏状态、热更新残留、旧进程、被手工修改的数据库或未记录的环境变量污染证据。

运行验收应优先启动构建产物或 preview/start 模式，而不是带热更新的长期 dev server：

```text
build artifact
  → preview/start --port <leased-port>
  → readiness
  → browser checks
```

只有产品确实依赖 dev-only 能力时才使用 dev server，并在证据中明确记录。

## 5. 默认端口不是执行身份

项目约定端口 `9080` 是开发便利值，不是并行运行时的唯一身份。每个 Worker/Verifier run 必须获得独立运行环境。

```text
project default port: 9080
run A: web=19080, api=19081, db=19082
run B: web=19090, api=19091, db=19092
```

实际端口可以不同，但必须满足：

- 由 Supervisor 的 Port Allocator 统一分配，而不是各 Worker 自己猜。
- 分配给 `runId + serviceName`，并持久化为 lease。
- 通过环境变量或 CLI 参数注入，例如 `PORT`、`VITE_PORT`、`API_PORT`。
- 不鼓励 Worker 直接改写源码中的端口常量。
- 默认只监听 `127.0.0.1`。
- 服务退出、进程组清理完成后再释放端口。

如果框架支持 `listen(0)` 并输出实际端口，应优先使用操作系统分配。对于“先探测端口、再启动子进程”的方式，需要处理 `EADDRINUSE` 重试，因为探测与真正绑定之间存在竞态。

单机 MVP 可以采用：

- 配置专用范围，例如 `19000–19999`。
- 控制面保存 `{runId, service, host, port, pid, leaseUntil}`。
- 启动前绑定探测可用性。
- 子进程若报告 `EADDRINUSE`，立即废弃该分配并重试。
- lease 到期且进程树已不存在时回收。

## 6. 一个 Run 的运行清单

每个 attempt 应生成持久化 `RuntimeManifest`：

```json
{
  "runId": "run-...",
  "taskId": "glass-button-states",
  "attempt": 1,
  "worktree": "/.../.cliyard/worktrees/...",
  "artifactHash": "<exact code snapshot>",
  "services": [
    {
      "name": "web",
      "host": "127.0.0.1",
      "port": 19080,
      "pid": 12345,
      "healthUrl": "http://127.0.0.1:19080/",
      "logPath": "/.../.cliyard/logs/run-.../web.log",
      "dataDir": "/.../.cliyard/runtime/run-.../data/web"
    }
  ],
  "browser": {
    "profileDir": "/.../.cliyard/runtime/run-.../browser",
    "viewport": { "width": 1440, "height": 900 }
  }
}
```

前端、API、数据库、缓存、浏览器 profile、上传目录和临时数据都必须按 run 隔离。

## 7. Readiness 与清理

启动成功不等于运行可用。至少检查：

1. 进程仍存活。
2. 目标端口处于监听状态。
3. readiness URL 返回预期 HTTP 状态。
4. 前端资源加载成功。
5. 必要的后端/数据库依赖可用。

启动失败要保存：

- 命令行和脱敏后的环境变量
- stdout/stderr
- 端口分配记录
- health check 尝试
- 退出码和进程树状态

验收结束必须在 `finally` 语义下：

- 终止完整进程组，而不是只杀父 PID。
- 等待端口实际释放。
- 停止浏览器和测试执行器。
- 保留日志、截图和证据。
- 按策略清理临时数据库/profile，或作为失败现场保留。

## 8. 并行验收的限制

端口不冲突后，验收不一定可以无限并行。还要限制：

- CPU 和内存
- 浏览器实例数量
- 截图/视觉模型并发
- API 限流和外部服务配额
- 磁盘和临时数据库
- 依赖相同迁移或共享 fixture 的任务

因此需要独立的 `maxParallelRuntimes` 和 `maxParallelVisualChecks`。端口分配器和运行槽位是两个不同资源。

如果浏览器要求同源 Cookie、CORS 或认证，推荐给每个 run 启动一个独立反向代理端口：

```text
run proxy :19080
  → web service :internal-a
  → api service :internal-b
```

浏览器只访问 run 的代理地址，避免把内部服务端口硬编码进测试。

## 9. 验收证据

运行验收不能只保存退出码。Evidence Bundle 至少包含：

```text
designRevision
taskContract
baseCommit / artifactHash
runtimeManifest（端口、URL、进程摘要）
static gate results
runtime logs tail
HTTP smoke results
E2E / API test results
a11y results
same-viewport screenshots
Light / Dark screenshots
component state matrix
token / visual diff
P0/P1/P2 findings
unverified items
verdict and adjudication reason
```

没有取得同视口渲染证据时，状态只能是 `accepted_with_gap` 或 `needs_human`，不能宣称视觉验收完成。

## 10. 验收条件

这套设计至少需要通过：

1. 同一任务两次并行验收使用不同端口和临时数据目录。
2. 服务启动失败会回传完整证据，不会误判 accepted。
3. Worker 关闭后，Verifier 能从精确代码快照独立启动服务。
4. Verifier 被杀后，lease 到期可回收，端口和进程最终清理。
5. 两个并行 run 使用不同浏览器 profile，不串 Cookie/localStorage。
6. 端口被外部进程占用时能重试或明确 `blocked`。
7. 验收结束后没有遗留监听进程。
8. 修复 attempt 不复用上一轮脏服务。
9. 共享数据库迁移等资源不会被并行任务同时执行。
10. 合入后的 integration commit 再跑必要 smoke/visual regression。

## 11. 禁止项

- 把项目默认端口 `9080` 当作全局唯一验收入口。
- 让 Worker 自己起服务并自己截图后直接 accepted。
- 用固定 `sleep` 代替 readiness。
- 直接杀父进程却遗留 Vite、Node、浏览器或子服务。
- 多个 run 共享同一个数据库、上传目录或浏览器 profile。
- 因端口可用就取消运行并发上限。
- 在运行失败时删除全部现场，导致无法裁决。


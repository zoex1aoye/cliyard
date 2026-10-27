# 下一迭代：Task Architect 与持久化持续编排

> 日期：2026-10-27（更新）
>
> 结论：RuntimeManager v0、Runtime Orphan Reaper v0、orphan hardening、
> **runtime failure drills v0**，以及 **attempt continuity / worker progress /
> drill abnormal recovery v0** 均已实现。本轮实测：focus 组
> （attempt reuse、Claude progress、worker progress、failure drills 四个文件）
> **13/13**，runtime/恢复相关 **81/81**（13 个文件），完整套件 **177/177**，
> `npm run build` 通过。failure drill 的正常路径仍为 3/3；超时异常路径报告
> 2/3（`cleanup-failure` 子进程超时，按设计不能通过 child-exit 检查），但
> 精确 reaper 回收 1 个 runtime、0 个 `needs_human`，manifest 收尾为
> `cleanup: "complete"` + `reaped`，端口与 lease 均已核实干净。
>
> 下一具体能力：**Task Architect**。**持久化持续编排（durable continuous
> orchestration）** 是其后独立的缺口。两者尚未实现，需要各自的设计与验收；
> 本轮文档不把它们写成已完成能力。
>
> 本轮明确不引入 daemon、跨主机回收、浏览器证据、SQLite、准入调度或
> 24 小时无人值守声明。attempt reuse 只是 worktree 连续性（不是 provider
> 会话续跑）；worker progress 只是观察信息；drill 异常回收只走既有精确
> reaper 规则，不改变 `needs_human` 规则。

## 0. 当前状态

已落地（单机、本机仓库、有限服务）：

- **Attempt Continuity v0**
  - RunManifest 的 task 增加可选 `attemptWorktree`、`attemptBranch`、
    `attemptBaseCommit`、`attemptStartedAt`、`attemptRejectedAt`；
  - worktree 创建后、worker 启动前写入 checkpoint；rejected 保留脏 worktree
    （即使未传 `--keep-worktrees`），accepted 清除全部 attempt 字段并删除
    worktree（除非传了 `--keep-worktrees`）；
  - `resume --retry-rejected` 默认复用已记录且校验通过的 rejected attempt；
    `--reuse-attempt` 是默认行为的显式写法；`--fresh-attempt` 显式丢弃 draft
    并新建干净 worktree；两者互斥且在任何派发前拒绝；
  - 复用 fail closed：路径不在 `.cliyard/worktrees/` 下、未注册为 git
    worktree、分支或 HEAD 与 checkpoint 不符、缺少 rejection 元数据、或
    attempt 属于其他 task/run，均拒绝且不派发；`--fresh-attempt` 是恢复路径；
  - 只复用 rejected attempt；不会给 interrupted active worker 再挂一个
    worker；复用是 worktree 连续性，不恢复 provider 会话；
  - `status` 只读暴露 `reusableAttempts`，human 输出打印每个可复用 attempt。
- **Worker Progress v0**
  - Claude Code 使用 `--output-format stream-json --verbose`，增量解析完整
    JSONL，保留最终 `type: "result"` 记录用于验收；仍兼容 plain single-JSON；
  - 事件立即 append 到 `.cliyard/worker-events/<runId>/<taskId>.jsonl`，每条
    一个完整 JSON 对象；同一 task 跨 attempt append-only；
  - 类型为 `session.start` / `assistant` / `tool.start` / `tool.result` /
    `heartbeat` / `result` / `retry` / `error`；阶段为 `starting` /
    `thinking` / `tool` / `finishing` / `waiting` / `ending`；
  - provider 静默时按固定间隔产生 `heartbeat`（默认 15 s，
    `CLIYARD_CLAUDE_HEARTBEAT_MS` 可覆盖）；heartbeat 只表示仍在等待，不表示
    成功、健康或进度质量；
  - `status` 只读读取每个 task 最新有效事件，返回 `workerProgress`
    （含 `ageMs` 和 display-only `stale`），human 输出最新事件；missing、
    malformed、foreign-task 或 stale 文件不改变 run status；
  - 事件文本 bounded/redacted，tool input 只保留 path/program 元数据，tool
    output 只记录大小；事件不是 acceptance authority，无 retention/rotation；
  - 本轮用本地 stream-json fixture 实测：assistant/tool 事件在 worker 退出前
    可见，provider 静默产生 heartbeat，`status` 前后 manifest hash 不变。
- **PortAllocator**
  - 默认端口范围 `19000-19999`，可用 `CLIYARD_PORT_RANGE="start-end"` 覆盖；
  - `.cliyard/runtime/port-leases.json` + `.cliyard/runtime/port-leases.lock`；
  - 跨进程锁、原子替换、占用探测、同 key 复用、死 owner 回收；
  - `EADDRINUSE` 证据触发每个服务一次换端口重试。
- **RuntimeManager**
  - argv 形式的 `RuntimeSpec`，从确切 task worktree 启动；
  - 每个服务注入 `CLIYARD_<SERVICE>_URL`、可选 `urlEnv`、`portEnv`
    （默认 `PORT`）和 `CLIYARD_<SERVICE>_DATA_DIR`；
  - 子进程存活 + HTTP 期望状态 + 未超时才算 ready；
  - `<repoRoot>/.cliyard/runtime/<runtimeId>/runtime-manifest.json`、服务日志和
    `data/<service>/`；
  - SIGTERM → SIGKILL 整个进程组、确认端口释放、释放租约、持久化最终 manifest；
  - 启动时写入 `owner`；spawn 后立即持久化 `pid`、`pgid` 和 `processIdentity`
    （`ps` 的 `pid`/`pgid`/`lstart`），并在 readiness 前再次写盘。
- **Runtime Orphan Reaper v0**
  - `src/runtime/process.ts`：精确进程身份采集与比较；`ps` 不可用或身份缺失
    一律视为 `unknown`，绝不猜测；
  - `src/runtime/reaper.ts`：只读 preflight，不回信号、不探测端口、不释放租约、
    不写 manifest；分类为 `safe_to_reap` / `needs_human` / `skip`；
  - `src/runtime/reaper-execute.ts`：只执行 preflight 批准的计划；再次核对身份后
    SIGTERM → SIGKILL 已证明的进程组，确认端口可绑定，才释放精确匹配的租约，
    最后原子写入 `recovery` 记录和 `cleanup: "complete" | "failed"`；
  - `.cliyard/runtime/reaper.lock` 串行化并发 reaper；同主机死 owner 的锁可清理，
    外来/不可读锁至少 5 分钟后才按年龄放弃；
  - `cliyard supervisor reap --repo <path> [--json]` 显式回收；
  - `start` 在取得 supervisor 锁后、创建 RunManifest 前自动对账；`resume`
    在检查 contracts/base/integration 并取得锁后、标记 `running` 前自动对账；
    任一 `needs_human` 都 fail closed：`start` 不创建 run，`resume` 不改
    RunManifest，两者都不派发；
  - `status` 只读，仅展示已持久化的 `recovery` 记录，从不执行对账；
  - 不做跨主机 kill，不按命令行模式匹配，不在无法证明归属时杀进程或删租约；
  - 租约 owner 必须精确等于 manifest owner（`lease.pid ===
    manifest.owner.pid`）；dead 或 live 的第三方 owner 均为 `needs_human`，
    进程组、租约和 manifest 原样保留；
  - 新 executor record 写入 `runtimeId`（reaped / needs_human，以及报告中的
    skipped）；manifest 持久化同一记录；legacy 无 `runtimeId` 的记录仍可读，
    `status` 依次回退到 manifest `runtimeId` 和目录名；
  - `src/supervisor/cli.ts` 不再做第二次 preflight、不按 state/reason 反推 id，
    源码不含 NUL 分隔符。
- **Runtime Failure Drills v0**
  - `cliyard runtime-drill [--out <dir>] [--port-base <start>] [--json]`；
    默认输出 `.cliyard/runtime-drills/<UTC timestamp>-<pid>/`，默认端口基址
    `22800`；
  - 三个场景分别在独立 OS 子进程中运行，各占互不重叠的 30 端口子区间
    （`base..base+29`、`+30..+59`、`+60..+89`）；端口范围在启动任何子进程
    前整体校验；
  - `readiness-timeout`：服务 503、readiness 超时、verifyCommands 跳过；
  - `verify-failure`：readiness 成功、verifyCommand exit 7；
  - `cleanup-failure`：readiness 成功、注入 lease release 故障，
    `RuntimeCleanupError`，manifest `cleanup: "failed"`；
  - 父进程独立复核子进程退出码、manifest、服务日志、进程/进程组、端口可绑定
    性和 lease store；
  - 输出 `runtime-failure-drills.json`（version 1）及每个场景的
    `child.log`、`child-result.json`、`control/` 和 `worktree/`；
  - 正常路径实测 3/3 通过；三个服务均退出、三个端口均可重新绑定；前两个场景
    lease store 为空，cleanup-failure 保留 1 条证据 lease。详见
    [docs/evidence/RUNTIME_FAILURE_DRILLS.md](evidence/RUNTIME_FAILURE_DRILLS.md)。
- **Runtime Drill Abnormal Recovery v0**
  - 子进程 timeout、被 signal、非零退出或 spawn 失败时，父进程只对 drill
    **child PID** 执行 SIGTERM → 1 s 宽限 → SIGKILL（再等 2 s），不直接
    signal service group；
  - 只有 child 确认消失后，才对返回的 scratch control root 运行既有 exact
    orphan executor；结果写入报告 `abnormalRecovery`（trigger、
    childTermination、executed、executor report/error）；
  - 回收后重跑 manifest/log/process/port/lease 检查；`needs_human` 或无法
    清理会使 drill 失败；异常 child 仍不能通过 child-exit 检查，绝不被解释为
    accepted；
  - 实测：`portBase 24800`、`childTimeoutMs 5000`、test-only hook 选择
    `cleanup-failure`，报告 `fail` / `{ total: 3, passed: 2, failed: 1 }`；
    child 5000 ms 超时、忽略 1000 ms SIGTERM 宽限后记录为 SIGKILL（duration
    6009 ms）；executor `scanned=1, reaped=1, needs_human=0, skipped=0`；
    manifest `cleanup: "complete"` + `recovery.state: "reaped"`；
    lease 0，端口 24860 可绑定；service manifest 的 `signal`/`exitedAt` 为
    null（组由 reaper 外部终止），这是本轮实测细节；
  - hook `CLIYARD_RUNTIME_DRILL_TEST_HANG_AFTER_READY` 仅为测试用，public
    CLI 不暴露 `childTimeoutMs`。详见
    [docs/evidence/ATTEMPT_CONTINUITY_PROGRESS.md](evidence/ATTEMPT_CONTINUITY_PROGRESS.md)。
- **测试端口隔离（`test port` pools）**
  - 七个会启动真实进程或绑定真实端口的 runtime 测试文件使用
    `tests/test-port-ranges.ts` 的静态、互不重叠端口池（22000–22699；六个文件
    各 100 个，failure drill 为 90 端口窗口）；shell verifier 保留 21400–21499
    与 21500–21599；
  - 池在 import 时断言反转/重叠，取范围时对池耗尽抛错；每次分配仍走真实
    `PortAllocator` 探测与重试；
  - 仅限本仓库测试进程隔离，不是生产、跨 run 或跨仓库端口协调。
- **Shell Verifier**
  - 只在 Worker implement 成功且 path gate 通过后启动 runtime；
  - URL 变量注入所有 `verifyCommands`；
  - 无论命令成功、失败还是抛错都执行 `stop()`；cleanup 失败也会使验收失败；
  - mock verifier 和 batch `--dry-run` 永不启动 runtime。
- **Contract / Plan**
  - `TaskContract.runtime` 可选；plan 编译保留并校验，畸形 spec 在派发前拒绝；
  - 无 runtime 的 contract 保持原有静态验证行为。
- **示例**
  - [examples/runtime-verifier.contract.json](../examples/runtime-verifier.contract.json)
    使用内联 Node 服务，verifyCommand 直接请求租约 URL 的 `/health`。

明确未落地：

- **Task Architect**（结构化任务架构 / 契约生成）：下一具体能力，需要独立
  设计与验收；
- **durable continuous orchestration**（持久化持续编排）：Task Architect
  之后的独立缺口，需要独立设计与验收；
- provider 会话续跑：attempt reuse 只复用 worktree/draft，不恢复 provider
  对话；也不会给 interrupted active worker 再挂一个 worker；
- 自动 worktree/manifest GC：`--fresh-attempt` 丢弃的 draft、保留的 rejected
  worktree、run/branch/manifest 都会累积，需手工清理；
- worker event 的 retention/rotation 或长期查询；事件只是 append-only 观察
  信息，不是 run authority；
- 跨主机 runtime 回收或远程 kill；外来 host 的 runtime 只会 `skip`，主机名变化
  也会使旧 manifest 看起来属于外来 host；
- 第三方 dead owner 租约的自动回收（按 hardening 规则只能 `needs_human` 并保留
  证据）；
- leader 已退出但进程组仍有成员时的自动回收（只能 `needs_human` 并保留证据）；
- 无关 run 在回收前分配端口时清理死 owner 租约，导致关联证据消失，只能
  `needs_human`；
- 缺少 manifest 的 runtime 目录或租约不会被推断回收；
- daemon / 周期扫描 / 24h 无人值守 / 后台队列；
- Windows 的 POSIX 进程组等价清理与进程身份采集；
- SQLite（仍为原子 JSON）；
- Playwright、axe、截图或无障碍证据；
- Docker / 远程沙箱；
- CPU/内存/浏览器并发准入调度或“无限并行 runtime”；
- 自动合入 main、自动 push；
- HTTPS、TCP-only readiness、自定义优雅关闭命令或日志轮转；
- 生产级、跨 run 或跨仓库端口协调（测试端口池不是该能力）；
- CI 或跨主机上的长期 flake 率结论（当前只有本机单次与历史连续 5 次运行）。

正常清理、崩溃后的证据字段、分类规则、事故清单和限制详见
[docs/RUNTIME_ORPHAN_RECOVERY.md](RUNTIME_ORPHAN_RECOVERY.md)；RuntimeManager
的正常生命周期与 failure drill 用法见
[docs/RUNTIME_MANAGER.md](RUNTIME_MANAGER.md)；failure drill 的实测结果见
[docs/evidence/RUNTIME_FAILURE_DRILLS.md](evidence/RUNTIME_FAILURE_DRILLS.md)；
attempt continuity、worker progress 与异常 drill 回收的实测结果见
[docs/evidence/ATTEMPT_CONTINUITY_PROGRESS.md](evidence/ATTEMPT_CONTINUITY_PROGRESS.md)。
Supervisor 的 attempt/progress 操作语义见
[docs/SUPERVISOR_V0.md](SUPERVISOR_V0.md)。

## 1. 孤儿回收验收对照

设计要求与实际覆盖：

| # | 设计要求 | 状态 | 覆盖 |
|---|----------|------|------|
| 1 | 采集并比较精确 leader pid/pgid/start identity | 已实现 | `runtime-process`：身份采集、精确比较、缺失即 unknown |
| 2 | Manager 持久化 owner 与服务身份 | 已实现 | `runtime-manager-identity`：owner、pid==pgid、readiness 前写盘、失败启动保留、EADDRINUSE 重试替换身份 |
| 3 | 真实进程启动 detached 服务后被 SIGKILL | 已实现 | `runtime-reaper`：真实 RuntimeManager HTTP 服务，owner 进程被 SIGKILL 后服务仍存活 |
| 4 | reaper 证明归属、终止组、释放端口/租约、写证据 | 已实现 | `runtime-reaper`：终止、端口可绑定、精确租约清空、manifest `cleanup=complete` |
| 5 | 启动身份变化 → `needs_human` 且保留组/租约 | 已实现 | `runtime-reaper` + `runtime-reaper-plan` |
| 6 | 外来 host owner → skip/`needs_human`，不 kill | 已实现 | `runtime-reaper` + `runtime-reaper-plan` |
| 7 | 租约不匹配 → `needs_human` | 已实现 | `runtime-reaper` + `runtime-reaper-plan` |
| 8 | 已完成 runtime 被 skip | 已实现 | `runtime-reaper` |
| 9 | preflight 不改变进程、租约、manifest | 已实现 | `runtime-reaper-plan`：字节级不变 |
| 10 | 并发 reaper 串行化 | 已实现 | `runtime-reaper`：reaper lock |
| 11 | supervisor start/resume 在 `needs_human` 时 fail closed | 已实现 | `supervisor-runtime-reaper`：子进程级 CLI |
| 12 | leader 消失但组内仍有成员时保留证据 | 已实现 | `runtime-reaper` + `runtime-reaper-plan`：`needs_human`，不杀 |
| 13 | 租约 owner PID 必须等于 manifest owner；dead/live 不符均 `needs_human` | 已实现 | `runtime-owner-lease-safety`：相同 dead owner 可回收；dead/live 第三方 owner 均保留组、租约和字节级不变的 manifest |
| 14 | recovery record 与 manifest 自带 `runtimeId`；legacy 记录可读 | 已实现 | `runtime-recovery-record`：reaped/skipped/needs_human；持久化记录与报告一致；无 id legacy 记录可读 |
| 15 | Supervisor 不按 state/reason 反推 id，输出无 NUL | 已实现 | `supervisor-runtime-recovery-record`：相同 reason 的多个 runtime 标签仍正确；`status` 优先记录 id 并支持 legacy 回退 |
| 16 | runtime 测试文件端口池互不重叠 | 已实现 | `test-port-ranges`：import 时断言；12 个 runtime/恢复文件（drill 前）单独运行全部通过 |

failure drill 的设计验收对照
（[design/runtime-failure-drills-v0.md](../design/runtime-failure-drills-v0.md)）：

| # | 设计要求 | 状态 | 实测覆盖 |
|---|----------|------|----------|
| 1 | 三个场景在三个独立子进程中运行 | 已实现 | 子进程 PID 54804 / 54836 / 54869，均 exit 0、无信号、无超时 |
| 2 | readiness timeout 跳过 verifyCommands、拒绝并保留证据 | 已实现 | 12 次 readiness 尝试（ECONNREFUSED + 11×503）；命令 skipped；marker 不存在；`cleanup: "complete"` |
| 3 | verify exit 7 拒绝并保留 complete cleanup | 已实现 | verifier 与命令均 exit 7；marker 存在；`cleanup: "complete"`；lease 0 |
| 4 | cleanup release 失败拒绝、`cleanup: "failed"`、绝不 accepted | 已实现 | `RuntimeCleanupError`；failureReason 含注入故障；`cleanup: "failed"` |
| 5 | 每个场景服务端口事后可绑定 | 已实现 | 22800 / 22830 / 22860 均 `portFree=true`；事后 `lsof` 无监听 |
| 6 | 机器可读报告 + 每场景证据 | 已实现 | `runtime-failure-drills.json`、`child.log`、`child-result.json`、manifest/log/lease |
| 7 | focused drill、full suite 与 build 通过 | 已实现 | drill 文件 3/3、full suite 177/177、build pass |
| 8 | 文档只记录实测结果、不扩大能力 | 已实现 | [docs/evidence/RUNTIME_FAILURE_DRILLS.md](evidence/RUNTIME_FAILURE_DRILLS.md) 与本轮文档更新 |

本轮 attempt continuity / worker progress / drill abnormal recovery 的设计验收
对照（[design/attempt-continuity-progress-v0.md](../design/attempt-continuity-progress-v0.md)）：

| # | 设计要求 | 状态 | 实测覆盖 |
|---|----------|------|----------|
| 1 | rejected dirty worktree 被持久化并跨真实进程退出保留 | 已实现 | start exit 1 后 worktree 仍注册，draft 在盘，manifest 五个 attempt 字段完整 |
| 2 | 默认重试使用同一 worktree 并看到 prior draft | 已实现 | verbose `reuse attempt worktree`；fixture 两次 cwd 相同，第二次 `draftSeen=true` |
| 3 | `--fresh-attempt` 创建不同的干净 worktree | 已实现 | 新 cwd，`draftSeen=false`；旧 draft 保留；integration 不含 draft |
| 4 | 非法/篡改 attempt fail closed | 已实现（测试级） | focused test：路径逃逸、分支不符、缺 `attemptRejectedAt`、互斥 flag；0 次派发 |
| 5 | accepted 清除 attempt 元数据且 completed run 不被重跑 | 已实现 | 最终 task 只剩 accepted/resultCommit；worktree 删除；`reusableAttempts=[]`；既有 completed resume no-op |
| 6 | Claude stream 事件在 worker 退出前出现 | 已实现 | live status 在 worker 运行时显示 `tool.start`；focused test 在 collect 完成前断言 |
| 7 | provider 静默产生 heartbeat，且不声称成功 | 已实现 | 200 ms heartbeat 配置下 39 个 heartbeat；status 仍 `running`/`accepted=0` |
| 8 | `status` 读取 progress 而不改变 run state | 已实现 | live status 前后 manifest sha256 相同；focused test 断言 manifest/event 字节不变 |
| 9 | 超时 drill child 的已证明 service 在 child 退出后被回收 | 已实现 | child SIGKILL(6009 ms)；executor scanned 1 / reaped 1 / needs_human 0 |
| 10 | drill report 保留异常回收并证明端口 free | 已实现 | `abnormalRecovery` 持久化；manifest `cleanup=complete`+`reaped`；lease 0；24860 free |
| 11 | focused tests、full suite、TypeScript build 通过 | 已实现 | 13/13、177/177、build pass；runtime 组 81/81 |
| 12 | 文档只记录实测行为并保留全部非目标 | 已实现 | [docs/evidence/ATTEMPT_CONTINUITY_PROGRESS.md](evidence/ATTEMPT_CONTINUITY_PROGRESS.md) 与四份文档更新 |

未覆盖的能力不会被写成“已实现”：跨主机回收、leader-dead 自动 kill、daemon
周期回收、Windows 进程身份、生产或跨仓库端口协调、Task Architect、durable
continuous orchestration、provider 会话续跑、自动 worktree GC。

## 2. 验证（2026-10-27，本工作树，macOS）

当前套件（包含 attempt continuity / worker progress 与 failure drill 测试）：

```text
npm run build                                      → 通过
focused attempt/progress/drill group（4 个文件）   → 13/13 通过（9769.2 ms）
runtime/恢复 focused group（13 个文件）            → 81/81 通过（9968.0 ms）
npm test（完整套件）                               → 177/177 通过（10887.8 ms）
```

以上均为本机单次运行；这是本机 macOS 证据，不是长期 flake 率、CI 或跨主机
结论。failure drill 实测细节（子进程、场景、端口、lease）见
[docs/evidence/RUNTIME_FAILURE_DRILLS.md](evidence/RUNTIME_FAILURE_DRILLS.md)；
attempt continuity、worker progress 与异常 drill 回收的实测细节见
[docs/evidence/ATTEMPT_CONTINUITY_PROGRESS.md](evidence/ATTEMPT_CONTINUITY_PROGRESS.md)。

本轮另外做了 CLI 级实测（使用本地 stream-json fixture，不是真实
DeepSeek/Claude provider）：一次 rejected attempt 在默认 resume 中复用同一
worktree（第二次 `draftSeen=true`），一次 `--fresh-attempt` 使用不同 worktree
（`draftSeen=false`），live `status` 在 worker 运行时显示 `tool.start` 与
heartbeat，且 status 前后 manifest hash 不变。异常 drill 以
`CLIYARD_RUNTIME_DRILL_TEST_HANG_AFTER_READY=cleanup-failure`、
`childTimeoutMs 5000`、`portBase 24800` 运行：报告 2/3（超时场景按设计
fail），child 被 SIGKILL，exact executor `scanned=1/reaped=1/needs_human=0/
skipped=0`，manifest `cleanup=complete` + `reaped`，lease 0，端口 24860 free。

历史基线：drill 前的 hardening 阶段（同日）5 次独立 `npm test` 顺序执行，
均为 164/164：

| 次数 | 结果 | test-runner duration |
|------|------|----------------------|
| 1 | 164/164 通过 | 8.39 s |
| 2 | 164/164 通过 | 8.16 s |
| 3 | 164/164 通过 | 8.04 s |
| 4 | 164/164 通过 | 8.14 s |
| 5 | 164/164 通过 | 8.25 s |

当时未观察到 flake；这不是长期 flake 率或 CI 结论。

Runtime/恢复相关 81 项（13 个文件；其中 78 项为 drill 测试前已有）：

```text
tests/contract-runtime.test.ts                     10
tests/runtime-ports.test.ts                        10
tests/runtime-manager.test.ts                       8
tests/runtime-manager-identity.test.ts              5
tests/runtime-process.test.ts                       8
tests/runtime-verifier.test.ts                      5
tests/runtime-owner-lease-safety.test.ts            3
tests/runtime-recovery-record.test.ts               3
tests/runtime-reaper-plan.test.ts                   9
tests/runtime-reaper.test.ts                       10
tests/supervisor-runtime-reaper.test.ts             5
tests/supervisor-runtime-recovery-record.test.ts    2
tests/runtime-failure-drills.test.ts                3
```

13 文件组本轮运行一次；更早的单独运行结果只作为历史记录。

端口隔离：七个会启动真实进程或绑定真实端口的 runtime 测试文件从
`tests/test-port-ranges.ts` 取静态、互不重叠的端口池（22000–22699；六个文件
各 100 个，failure drill 取 22600–22699 的 90 端口窗口）；shell verifier 保留
21400–21499 与 21500–21599。helper 在 import 时断言反转/重叠，取范围时对池
耗尽抛错；每次分配仍走真实 `PortAllocator` 探测/重试。该机制只防止本仓库
测试文件互相重叠，不是生产端口注册表、跨 run 协调器或跨仓库能力。

进程级覆盖包括：真实 detached RuntimeManager 服务 + owner SIGKILL、SIGTERM 不退出
时的 SIGKILL 升级、leader 已死但组内仍有成员、外部进程占用端口、并发 reaper
串行化，`reap`/`start`/`resume` 作为独立子进程运行，精确租约 owner 关联
（相同 dead owner 可回收；dead/live 第三方 owner 均为 `needs_human` 且证据原样
保留），reaped/skipped/needs_human 三类的 `runtimeId` recovery record
（包含无 id 的 legacy 记录仍可读），以及三个 independent failure-drill 子进程
（readiness 超时、verify exit 7、注入 cleanup release 故障）。`src/` 字节扫描
未发现 NUL；Supervisor 输出测试也断言无 NUL 分隔符。没有跨主机或 daemon
清理演练，也没有相应能力声明；failure drill 不是 reaper 演练，不改变
`needs_human` 规则。

此前 RuntimeManager v0（reaper 之前）的验收证据仍然有效：checked-in example
在租约端口上 accepted 且 `cleanup=complete`；两个重叠验收使用不同端口并各自
留下独立 manifest；真实 Claude + DeepSeek scratch run 只修改
`runtime-smoke.txt`，服务以 `SIGTERM` 结束，租约表为空。本轮没有重跑这些外部
Worker 验收演练，因此不把它们当作 drill、reaper 或跨主机证据。

## 3. 下一迭代范围

已完成的 RuntimeManager v0、Orphan Reaper v0、hardening、failure drills v0，以及
attempt continuity / worker progress / drill abnormal recovery v0 不在下一迭代
重复。下一具体能力是 **Task Architect**；其后的独立缺口是 **持久化持续编排
（durable continuous orchestration）**：

1. **Task Architect（下一具体能力）**
   - 把需求/计划转成结构化任务架构与可冻结契约（在现有 plan bridge 之上补齐
     设计缺口）；
   - 需要独立设计与验收，本文档不预写实现细节。
2. **持久化持续编排（Task Architect 之后）**
   - 跨 wave 的持久状态与连续推进；
   - 需要独立设计与验收；本轮不把它写成已完成能力。

对本轮已完成的 attempt continuity / progress / drill 切片，以下仍是明确
非目标，不得用本轮结果反推为已实现：

- daemon、周期扫描、后台常驻或 24 小时无人值守；
- 跨主机回收、远程 kill 或共享租约存储；
- Playwright、axe、截图或无障碍证据；
- SQLite 或其他状态存储迁移；
- CPU/内存/浏览器并发准入调度或无限并行 runtime；
- 生产级、跨 run 或跨仓库端口协调（测试端口池只服务本仓库测试文件）；
- provider 会话续跑或把 second worker 挂到 interrupted active worker；
- 自动 worktree/manifest GC（`--fresh-attempt` 丢弃的 draft 会保留）；
- worker event 的 retention/rotation 或作为 acceptance authority；
- leader-dead 进程组的启发式回收；
- Docker / 远程沙箱 / 多租户 / 云执行；
- 自动合入 main 或自动 push；
- HTTPS / 认证 / TCP-only readiness；
- Windows POSIX 进程组等价清理；
- 自定义优雅关闭命令或日志轮转。

Attempt reuse 是 worktree 连续性，不是 provider 会话续跑；worker progress 是
观察信息，不是验收依据；“持久化持续编排”仍是后续独立缺口，不是本轮 daemon
声明。若未来设计需要后台执行模型，必须单独设计和验收，不能从本切片的单机
前台证据推导出来。

## 4. 完成标准

RuntimeManager / reaper / hardening（已完成）：

1. [已完成] RuntimeManager v0 的端口、readiness、manifest、cleanup 和 shell
   Verifier 集成测试通过。
2. [已完成] 正常验收后 manifest `cleanup=complete`，端口释放，租约存储为空。
3. [已完成] 两个重叠验收使用不同端口，manifest 路径互不冲突。
4. [已完成] Supervisor SIGKILL 后，可证明归属的孤儿 runtime 与 stale lease 被
   安全回收；无法证明时报告 `needs_human`，不盲目 kill。跨主机仍不在范围内。
5. [已完成] 租约 owner PID 必须精确等于 manifest owner；dead/live 不符均
   `needs_human`，进程组、租约和 manifest 保留。
6. [已完成] 新 recovery record 携带 `runtimeId` 并持久化；Supervisor 直接使用
   记录 id，不按 reason 反推；legacy 记录仍可读；源码无 NUL。
7. [已完成] runtime 测试文件使用不重叠静态端口池；不宣称生产或跨仓库端口
   协调。

Failure drills v0（已完成）：

8. [已完成] 三个场景在三个独立子进程中运行；child PID、exit code、signal、
   duration 均记录在报告中。
9. [已完成] readiness timeout 跳过 `verifyCommands`，拒绝，保留 readiness、
   log、pid/pgid 证据，并最终 `cleanup: "complete"`。
10. [已完成] verify-command exit 7 拒绝并保留 `cleanup: "complete"`。
11. [已完成] cleanup release 失败以 `RuntimeCleanupError` 拒绝，
    `cleanup: "failed"`，绝不 accepted；服务进程和端口仍已清理。
12. [已完成] 每个场景确认服务进程/进程组消失且租约端口可绑定；cleanup-failure
    保留 1 条 lease 作为证据。
13. [已完成] 机器可读报告与 per-scenario 证据保留；父进程独立复核。
14. [已完成] drill 文件 3/3（含超时异常回收）、full suite 177/177、
    `npm run build` 通过。
15. [已完成] 文档只记录实测结果；daemon、跨主机、浏览器证据、SQLite 与
    准入调度仍为非目标。

Attempt continuity / worker progress / drill abnormal recovery v0（已完成）：

16. [已完成] rejected attempt 在 worker 启动前 checkpoint 精确
    worktree/branch/base/startedAt；真实进程退出后脏 worktree 与 draft 仍保留。
17. [已完成] 默认 `resume --retry-rejected` 复用同一 worktree 并看到 prior
    draft；`--reuse-attempt` 显式断言默认；`--fresh-attempt` 使用不同、
    干净的 worktree。
18. [已完成] 非法/篡改 attempt 在派发前 fail closed；accepted 清除全部
    attempt 字段，worktree 删除（除非 `--keep-worktrees`），
    `reusableAttempts` 为空。
19. [已完成] Claude stream-json 事件在 worker 运行时可见；provider 静默产生
    heartbeat，且不把等待解释为成功。
20. [已完成] `status` 读取 progress 不改变 manifest/event 字节；
    missing/malformed/stale 事件不改变 run status。
21. [已完成] 超时 drill child 被 SIGTERM→SIGKILL 终止；child 消失后由既有
    exact reaper 回收已证明 service group 与精确 lease；报告持久化
    `abnormalRecovery`。
22. [已完成] 异常 child 绝不被解释为 accepted；manifest 收尾
    `cleanup: "complete"` + `recovery.state: "reaped"`，`needs_human=0`，
    端口 free，lease 0。
23. [已完成] focused 13/13、runtime 组 81/81、full suite 177/177、
    `npm run build` 通过。
24. [已完成] 文档只记录实测行为，保留 daemon、跨主机、SQLite、浏览器证据、
    准入调度与 24 小时声明等全部非目标；Task Architect 未实现。

下一缺口（未完成）：

25. [未完成] Task Architect：独立设计与验收。
26. [未完成] 持久化持续编排：独立设计与验收。

## 5. 下一步顺序

```text
1. [已完成] RuntimeManager v0 实现
2. [已完成] Runtime Orphan Reaper v0：preflight + executor + supervisor 集成
3. [已完成] hardening：精确 lease owner、record runtimeId、Supervisor 无 NUL、
            测试端口池；完整套件连续 5 次 164/164
4. [已完成] Runtime failure drills v0：三个独立子进程、报告、证据、端口/lease
            验证；当时 focused 2/2、full 166/166、build 通过
5. [已完成] 文档按实测结果更新：README / NEXT_ITERATION / RUNTIME_MANAGER /
            RUNTIME_ORPHAN_RECOVERY / docs/evidence/RUNTIME_FAILURE_DRILLS.md
6. [已完成] Attempt continuity / worker progress / drill abnormal recovery v0：
            默认复用 + --fresh-attempt + 篡改 fail-closed、stream events +
            heartbeat、status 只读、超时 drill 精确回收；focused 13/13、
            runtime 81/81、full 177/177、build 通过
7. [已完成] 本轮文档更新：README / NEXT_ITERATION / SUPERVISOR_V0 /
            RUNTIME_MANAGER / docs/evidence/ATTEMPT_CONTINUITY_PROGRESS.md
8. 下一迭代：Task Architect（独立设计与验收）
9. 后续：durable continuous orchestration（独立设计与验收）
10. 不重复已完成切片；不新增 daemon、跨主机、浏览器证据、SQLite、准入调度、
    provider 会话续跑、自动 worktree GC 或 24 小时声明
```

## 6. 上一迭代状态

Supervisor v0（前台、原子 JSON RunManifest、进程级 SIGKILL 恢复）已完成，
其操作语义与自举手册见 [docs/SUPERVISOR_V0.md](SUPERVISOR_V0.md)。当前完整套件
包含 supervisor、attempt continuity/progress 与 runtime/drill 测试
（177/177 通过）。本轮没有引入 daemon 或 SQLite，也没有把 supervisor 的
后台化列入计划。attempt reuse 是 worktree 连续性，worker progress 是观察
信息；两者都不改变验收权威。RuntimeManager、Orphan Reaper、hardening、
failure drills 与 attempt continuity/progress/异常 drill 回收均已收口；
下一具体能力是 Task Architect，之后是持久化持续编排。

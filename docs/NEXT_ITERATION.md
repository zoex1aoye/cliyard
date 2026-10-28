# 下一迭代：观测、执行路由与有界并行（Controller 后置）

> 日期：2026-10-27（更新）
>
> 结论：RuntimeManager v0、Runtime Orphan Reaper v0、orphan hardening、
> **runtime failure drills v0**、**attempt continuity / worker progress /
> drill abnormal recovery v0**、**Task Architect v0（只读 Plan 生产者）**、
> **Foreground Orchestration Queue v0（显式批准、前台队列）**、
> **Plan-backed Chained Queue Base v0（单条线性依赖）**、
> **Chained Read Context v0（readPaths 对齐 pinned base）**、
> **ControlSnapshot/event/resource v0**，以及
> **Worker Failure Taxonomy / Cost Truth v0** 均已实现。
> 最终实测（2026-10-27，failure/cost 工作树，代码 HEAD `69f62de`）：
> `npm run build` exit `0`；failure taxonomy focused **14/14**（85.7 ms）、
> Claude failure/cost **17/17**（11694.1 ms）、supervisor failure/cost
> **12/12**（1134.9 ms）、queue control **7/7**（733.3 ms）；combined
> focused **50/50**（9991.6 ms）；完整套件 **290/290**（14175.8 ms）。
> 计数在第二次 focused 运行中复现；本地耗时会有波动。
> 较早 HEAD `390d61e` 的 read-context focused 5/5（1174.5 ms）、Plan-backed
> queue core 10/10（2824.9 ms）、materializer 16/16（1613.6 ms）、queue CLI
> 5/5（718.2 ms）、完整套件 240/240（12730.5 ms）保留为历史实测；同一 HEAD
> 新跑一次真实 Claude Code + DeepSeek 两 item chain，downstream
> `readPaths: ["foundation.txt"]`，**13.953 s 完成 2/2**；在 foundation
> `integrationHead` 上实时捕获 downstream worktree：`foundation.txt` 存在、
> `upper.txt` 尚不存在；worker 随后从该 worktree 读取 `foundation.txt` 再写
> `upper.txt`；最终 branch 含两文件，ancestry exit 0，no-op rerun
> `dispatched=0` 且 queue 文件 SHA-256 不变。此前三次未显式 readPaths 的
> chain（17.2 s、24.6 s、21.4 s）保留为历史实测。Task Architect 只产出
> 供人类审查的 Plan；Plan-backed queue 只对**已批准** Plan 做确定性编译，
> **不会自动生成或批准 Plan**。
>
> 当时的下一步：在 **Plan-backed chain 语义被实测证明并接受后**，对
> **受监督的前台长时运行控制器/daemon 做出决策**；该顺序已被下一条后续记录
> 调整。本轮不实现 daemon，也不声称 24 小时无人值守。
>
> **2026-10-27 后续记录：** 自举运行暴露了 progress/status 聚合、provider
> 失败分类、预算可见性和 attempts 变更审计缺口。执行顺序调整为
> **`queue status` 观测底座 → failure taxonomy/cost（已完成）→ CLI + 模型
> 执行组合路由 → 并行 Supervisor/queue admission → Control API + DSH 薄
> cockpit → DesignRevision/EvidenceBundle → foreground controller →
> bounded soak → daemon 决策**。controller 被有意后置，避免自动化尚未可信
> 的验收。
> 产品定位、并行动机和替换入口见
> [PRODUCT_STRATEGY_V2.md](PRODUCT_STRATEGY_V2.md)，运行缺口见
> [NEXT_STEP_CONTROLLER.md](NEXT_STEP_CONTROLLER.md)。
>
> **2026-10-27 ControlSnapshot v0 已完成：** `queue status` 现在只读拼合
> queue、Plan/materialization、RunManifest/task、worker progress、lock 与
> 资源快照；queue 生命周期写入 bounded event journal。未知 provider 执行
> 绑定的 capacity/quota/balance/pricing 保持 `null/unknown`，不继承公开
> 并发或价格。本轮 `npm run build` exit 0，queue-control focused 5/5，
> 完整套件连续三次 245/245（12714.5 / 12842.7 / 12601.6 ms）。证据见
> [evidence/CONTROL_SNAPSHOT.md](evidence/CONTROL_SNAPSHOT.md)。
>
> **2026-10-27 failure/cost v0 已完成：** 十类 failure taxonomy、四态
> `CostTruth`、RunManifest task checkpoint、`supervisor status` /
> `queue status` 观察面、queue `run.blocked` bounded 字段与 fail-closed
> 解析均已实现。Claude Code `total_cost_usd` 明确为 non-authoritative
> `cli-estimated`；`guardBudgetUsd` 是保护上限而不是花费；缺失成本保持
> `unavailable`/`missing`，绝不写成 0；没有自动重试、路由、准入或并行派发。
> 下一步是 CLI + 模型执行组合路由。证据见
> [evidence/FAILURE_COST_TRUTH.md](evidence/FAILURE_COST_TRUTH.md)。
>
> **2026-10-28 合并后复核：** failure/cost integration 已合入；build 通过、
> full suite 296/296。真实自举暴露三个待修缺口：首次 dispatch 期间 queue
> 没有 run id；失败 attempt 可留下 writePaths 外的 editor 临时文件；预算和
> 时长估计仍是静态启发式。下一步先补 queue run binding、每次 worker exit
> 的 path audit，以及 health-gated budget continuation / deadline extension，
> 再做 CLI + 模型路由。预算续跑与延时设计见
> [task-continuation-and-deadline-v0.md](../design/task-continuation-and-deadline-v0.md)，
> 遥测估算见 [task-estimation-v1.md](../design/task-estimation-v1.md)，缺陷
> 汇总见 [selfhost-iteration-v0.md](../design/selfhost-iteration-v0.md)。
>
> **2026-10-28 execution authority review：** queue policy、continuation、
> worker path audit 和 POSIX process-tree cleanup 已合入。当前
> `npm run build` 通过，但完整套件在本机为 **361/362**：
> `deadline-extension.test.ts` 的 2.2 秒 fixture 窗口在 Node 启动和 IO
> 后越过最终 deadline。该失败已单独复现，不能当作绿色门禁。
>
> 下一阶段按“执行权威链”推进，而不是同时铺开所有缺口：
>
> ```text
> [已完成] queue adoption / OperatorResolution
>   -> [已完成] deadline fixture stability
>   -> [下一步] WorkerLease persisted at spawn + controller-death policy
>   -> ProfileCatalog + real binding activation
>   -> per-run Supervisor ownership + short control locks
>   -> fixed hierarchical queue / Plan-wave admission
>   -> Windows Job Object ProcessOwnerProvider
>   -> telemetry-backed dynamic routing score
> ```
>
> 人工 adopt 不得改写原 blocked RunManifest；它必须作为独立、不可变的
> `OperatorResolution` 记录 reviewed commit、冻结 contracts identity、复核
> evidence hash、批准人和原因。动态评分必须晚于真实 profile 激活和准入，
> 否则只是在尚未实际切换 binding 的情况下选择一个标签。Windows 完整进程树
> 与 cliyard 自身 SIGKILL 恢复都归入 `ProcessOwnerProvider` /
> `WorkerLease` 边界；具体决定见
> [execution-authority-v1.md](../design/execution-authority-v1.md)。
>
> **2026-10-28 queue adoption closure：** `manual-queue-adoption`
> (`b7f7d9e`) 与 `deadline-fixture-stability` (`c57d591`) 已合入
> integration HEAD `ce1157a`。queue manual adoption v1 已实现：`queue
> adopt` 只关闭一个 blocked item，要求精确 run binding、未变化的 frozen
> contracts/approved Plan、full reviewed commit 位于 pinned base 与当前 HEAD
> 的 lineage 中，以及 bounded、secret-free 的 review evidence；它写入独立
> 版本化的 `OperatorResolution`，原 blocked/interrupted RunManifest 保持历史
> 真相，task 不被标记 accepted。`queue status` 显示 `completed (adopted)`，
> Plan-backed dependant 使用显式 adopted lineage。实测：`npm run build`
> exit 0；queue-adoption focused **8/8**（2539.7 ms）；deadline-extension
> focused **13/13**（23601.98 ms）；完整套件 **371/371**（24411.1 ms，
> 0 fail）。此前记录的 **361/362** 红门禁已关闭：stabilized fixture 改用
> grant callback marker 握手，并新增一个 late-result 仍判 timeout 的测试。
> adoption 不启用并行派发、动态路由、profile 激活、准入、Windows parity
> 或 daemon。下一步顺序明确为 **WorkerLease at spawn + owner-death
> recovery → ProfileCatalog + 真实 binding activation → per-run Supervisor
> ownership + short control locks → fixed hierarchical admission → Windows
> Job Object → telemetry-backed dynamic scoring**。证据见
> [evidence/QUEUE_ADOPTION.md](evidence/QUEUE_ADOPTION.md)。
>
> 当前已完成能力仍不包含 daemon/后台服务、跨主机回收、浏览器证据、SQLite、
> 有界并行准入和多父 integration/merge queue；其中 **CLI + 模型路由、有界
> 并行派发和 EvidenceBundle 已升级为下一阶段目标**，不代表当前已经实现。
> 自动 push 或自动合入 main 仍是长期人工门禁。
> attempt reuse 只是 worktree 连续性（不是 provider 会话续跑）；worker
> progress 只是观察信息；drill 异常回收只走既有精确 reaper 规则。

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
- **Task Architect v0（只读 Plan 生产者）**
  - `cliyard architect --repo <target> --design <repo-relative-design.md>
    --plan-id <id> [--worker claude] [--model <id>] [--out <plan.json>] [--json]`；
    默认 worker `claude`、模型 `deepseek-flash`、输出
    `<target>/.cliyard/plans/<planId>.json`；前台有限命令，不运行 Plan；
  - preflight：目标必须是 git repo、worktree 干净、design 已 tracked 且在
    repo 内、HEAD 解析为精确 base commit；任何失败都在 worker 启动前拒绝；
  - worker 配置 `permission-mode=plan`、`allowedTools=Read,Grep,Glob`；prompt
    明确禁止写文件、执行命令、commit/push/merge、创建 worktree、写 contracts
    或派发；design 以 fenced text 注入，超过 64 KiB 截断并在结果中报告；
  - post-run：worker exit 0、`touchedPaths` 为空、worktree status 与运行前
    字节相同、HEAD 未移动、final text 可解析；候选 Plan 复用既有
    `compilePlan` 校验 plan/task id、goals/verifyCommands、repo-relative
    paths、dependsOn/cycle、writePaths overlap、sharedResources 和 runtime
    shape；
  - 默认只写 `.cliyard/plans/<planId>.json`（`--out` 可指定其他路径）；
    不写 contracts、不建 worktree/run/integration branch、不
    dispatch/merge/push；design 文件本身不会被覆盖（绝对 `--out` 指向
    design 时拒绝）；
  - 实测：valid fake Plan、human 输出、dirty（0 次 worker 调用）、touched path、
    moved HEAD、未跟踪 design、越界 design、非法 plan id、非 git target、
    invalid JSON、空 schema、cycle、overlap、planId mismatch、worker 非零退出、
    design overwrite；真实 Claude Code + DeepSeek 16 s smoke 生成合法 Plan，
    `touchedPaths=[]`，HEAD/status/design hash 不变，最终只有三个 plan
    artifact，没有 contracts/runs/worktrees/runtime/ledger；
  - 已知操作 caveat：显式相对 `--out` 按调用者当前目录解析，不是 target
    repo；非默认位置应使用绝对路径。实测细节与限制见
    [docs/evidence/TASK_ARCHITECT.md](evidence/TASK_ARCHITECT.md)。
  - Human gate：Plan 必须经过 review/edit → 既有 plan compiler/freeze →
    显式 Supervisor start；Task Architect 不自动冻结契约或派发。
- **Foreground Orchestration Queue v0（显式批准的前台队列）**
  - `cliyard queue add/list/retry/cancel/run`；`add` 将 contracts path 解析为
    绝对路径并冻结精确字节的 SHA-256；拒绝重复/非法 id、未知依赖和环；
    不校验 contracts 是否 frozen（由 Supervisor 在派发时 fail closed）；
  - 存储 `<repo>/.cliyard/queue.json` + `<repo>/.cliyard/queue.lock`
    （均 gitignored）；queue JSON 原子替换，mutation 和 dispatch 由同主机
    `O_EXCL` 锁串行化；
  - `queue run` 是前台、顺序命令：一个 invocation 一次派发一个 item，
    先持久化 `running` 并递增 `attempts`，再调用既有 Supervisor CLI
    （新 item 用 `start`，已有 run 用 `resume --retry-rejected`）；
    完成要求 Supervisor exit `0` 且 RunManifest `completed`；
  - 默认在第一个 blocked item 停止；`--continue-on-blocked` 继续独立
    item，并把 blocked/cancelled 的依赖者传递标记为 blocked；
  - `queue retry` 把 blocked 恢复为 pending：有 run id 时
    `nextAction=resume`，否则 `start`；不改写 RunManifest；
    completed/cancelled 永不重跑；
  - 同主机 stale queue lock 可回收；stale `running` item 按已记录的 run id
    对账：completed→completed、可恢复的 interrupted/blocked→pending/resume、
    缺失/attempts 用尽/owner 仍活或远端→blocked；若崩溃发生在记录 run id
    之前则 fail closed 为 blocked（真实 SIGKILL 实测的 start 崩溃窗口），
    queue 不会通过 `active.json` 猜测 run；
  - changed/missing contracts 在派发前 blocked，`attempts` 保持 0；
    **contract-backed** item 的依赖只决定派发顺序和失败传播，不串联
    integration branch/base；Plan-backed item 的串联行为见下一条；
  - 明确非 daemon、非并行、单仓库单主机、JSON 而非 SQLite；
    `RunManifest` 仍是 task-level authority，queue 从不写 RunManifest；
  - 实测命令、queue JSON、真实 SIGKILL 恢复、lock 证据、真实 DeepSeek
    smoke 与限制见
    [docs/evidence/ORCHESTRATION_QUEUE.md](evidence/ORCHESTRATION_QUEUE.md)。
- **Plan-backed Chained Queue Base v0（单条线性依赖）**
  - `queue add-plan <plan.json> --repo <path> --id <id> [--depends-on <id>]
    [--worker claude|codex] [--model <id>] [--max-attempts <n>] [--json]`；
    add 时在 queue lock 下只读一次 Plan，冻结绝对路径 + SHA-256，
    要求 Plan id 等于 queue id；root item 持久化 add 时捕获的精确 HEAD
    （`planBaseCommit`），dependent item 不记录 root base；
  - 拒绝 unsafe/重复 id、未知依赖、环、超过一个依赖、缺失/不可读/
    malformed/invalid Plan、Plan id mismatch；`queue add` 的 v1 契约 item
    格式与行为不变；
  - 首次派发前（attempt +1 与 Supervisor start 之前）校验 Plan hash，用既有
    `compilePlan` 在精确 base 上编译：root 用 pinned HEAD，dependent 只用
    已完成上游 RunManifest 的 `integrationHead`（并校验 run id、冻结
    contracts identity、manifest base ancestry）；产物固定写到
    `.cliyard/queue/materialized/<id>/<base>-<plan-hash>.contracts.json`，
    内容为确定性 `{planId, contracts, provenance}`，无时间戳；queue 记录
    artifact SHA-256；
  - retry/resume 只校验和复用已记录 materialization，不重新编译；changed
    Plan/artifact/upstream evidence 一律 blocked；同一 run 的 contracts/base
    不可替换；不同 Plan/base 需要新 queue item 和新的 run；
  - dependent 的 Supervisor `baseCommit` 等于上游 `integrationHead`，因此
    上游 head 是下游 integration head 的祖先；只支持 one linear dependency，
    不做多父 integration/merge queue；
  - 实测（focused 31/31、当时 full 236/236、三次真实 Claude Code +
    DeepSeek 2-item chain 17.2 s / 24.6 s / 21.4 s、实时下游 worktree、
    ancestry、artifact hash、fail-closed matrix）见
    [docs/evidence/PLAN_BACKED_CHAIN.md](evidence/PLAN_BACKED_CHAIN.md)；
    该文档记录的 readPaths caveat 已由下一条修复。
- **Queue Manual Adoption v1（OperatorResolution）**
  - `queue adopt <queue-id> --repo <path> --run <run-id> --artifact
    <full-git-sha> --evidence <review-evidence.json> --approved-by <operator>
    --reason <text> [--json]`；只接受 blocked item，且 `lastRunId` 必须等于
    `--run`；
  - 校验 frozen contracts（Plan-backed 还校验 approved Plan、
    materialization 与 source manifest base）、source RunManifest 的
    blocked/interrupted 状态及 repo/run/contracts 一致性；`--artifact`
    必须是 40 或 64 位 full commit，且是 pinned base 的后代、当前 HEAD 的
    祖先或相等；
  - review evidence v1 是严格 allow-list：version 1、ISO `reviewedAt`、
    1..64 条 command、至少一条 `exitCode: 0`、`outputSha256` 为 hex
    SHA-256，文本 bounded 且拒绝明显凭据；evidence 文件上限 64 KiB，按
    精确字节计算 SHA-256；
  - 成功后 item 变 `completed`，保留 attempts/runIds，清除 pending
    reason/failure；`resolution` 记录 source run/status、base、
    contracts hash、reviewed commit、evidence path/hash、
    approvedBy/approvedAt、reason；
  - 重复 adopt 仅在同一 resolution identity 的全部字段 byte-equal 时幂等
    （`approvedAt` 除外）；任何差异 fail closed；原 RunManifest 与 task
    acceptance 均不改变，retry/cancel 仍拒绝 completed item；
  - 首次成功 append 一条 bounded `queue.item.adopted` 到
    `.cliyard/queue-events/adoptions.jsonl`；journal 写失败只影响观测，
    `queue.json` 仍是 adoption authority；`queue status` 暴露
    `completion: "adopted"` 与 bounded adoption events；
  - Plan-backed dependant 的 materialization 记录 `upstreamAdoptedCommit`；
    source manifest 未 completed 时以 reviewed commit 为 base，只有合法
    completed `integrationHead` 包含 reviewed commit 时才使用该 head；
  - 实测 focused 8/8（2539.7 ms）、full 371/371（24411.1 ms）、
    `npm run build` exit 0；见
    [evidence/QUEUE_ADOPTION.md](evidence/QUEUE_ADOPTION.md)。
- **Chained Read Context v0（pinned base）**
  - `validateReadContexts` 现在接收 contracts 的精确 shared `baseCommit`，
    对每个非豁免显式 `readPath` 执行 `git cat-file -e <base>:<path>`；
    control checkout/HEAD/index 不再决定 worker 能否读取。worker worktree
    本就创建在同一 pinned base 上，因此 preflight 与工作树一致。
  - `.`、缺失的可选 `AGENTS.md`、同一 contracts 文档内 task-produced 路径
    保留原豁免；仅存在于 control worktree 的 untracked 文件仍按原
    untracked-context 错误拒绝；tracked 于当前 HEAD 但不在 pinned base 的
    文件同样拒绝；不从 control checkout 复制任何文件。
  - 实测：read-context focused 5/5、Plan-backed queue core 10/10（含
    downstream 显式 readPaths 的本地 Supervisor chain）、materializer 16/16、
    queue CLI 5/5、当时 full 240/240、build exit 0；一次真实 Claude Code +
    DeepSeek 2-item chain（downstream `readPaths: ["foundation.txt"]`）
    13.953 s 完成 2/2，实时捕获的 downstream worktree HEAD 为 upstream
    `integrationHead`，含 `foundation.txt`、无 `upper.txt`；worker 先在
    13:48:17.176Z Read 该文件，再在 13:48:18.352Z Write `upper.txt`；最终
    branch 含两文件，ancestry exit 0；no-op rerun `dispatched=0` 且 queue
    文件 SHA-256 不变。
  - 单次本机运行，不是 CI/flake/成本结论；不新增 daemon、并行、多父、
    跨主机或 SQLite。证据见
    [docs/evidence/CHAINED_READ_CONTEXT.md](evidence/CHAINED_READ_CONTEXT.md)。
- **ControlSnapshot / event journal / resource snapshot v0**
  - `queue status --repo <path> [--json]` 只读拼合 queue item、Plan/
    materialization、RunManifest/task、worker progress、queue/supervisor
    lock、decision hint 与 host resource sample；不回收 lock、不改
    manifest、不写 journal、不改变验收。
  - queue add/retry/cancel/reconcile、Plan materialization、attempt/run
    start、provider session start/end、completed/blocked 追加到
    `.cliyard/queue-events/events.jsonl`；字段有界，写失败不反向影响已
    持久化的 queue mutation。
  - provider 容量、quota、balance、pricing 按未解析的 worker/model binding
    保持 `null/unknown`；公开的 provider 并发数字不进入默认容量。未知绑定
    后续准入先走单并发探针，再依据 provider 反馈和实测窗口增长。
  - 实测：queue-control focused 5/5、focused 20 次压力循环通过、当时 full
    连续三次 245/245（12714.5 / 12842.7 / 12601.6 ms）、build exit 0；
    本轮 full 290/290；证据见
    [docs/evidence/CONTROL_SNAPSHOT.md](evidence/CONTROL_SNAPSHOT.md)。
- **Worker Failure Taxonomy / Cost Truth v0**
  - `src/failures.ts` 是唯一来源。十类 `FailureCategory` 精确为
    `budget_exhausted`、`timeout`、`provider_transient`、`provider_auth`、
    `provider_protocol`、`worker_process_exit`、`verifier_rejected`、
    `policy_blocked`、`resource_exhausted`、`unknown`；八个 stage 为
    `contract`、`preflight`、`spawn`、`provider`、`worker`、`verifier`、
    `policy`、`unknown`。优先级为 timeout > budget > auth > resource >
    transient > protocol > worker process exit > verifier > policy > unknown。
    worker 进程失败不会因为 verifier 随后也失败而被改写成
    `verifier_rejected`。
  - `FailureRecord` 只包含 version、category、stage、可选 code、≤400 字符
    message、observedAt 和 advisory `retryableHint`。文本只扫描尾部
    8,000 字符并折叠、脱敏、截断；不保留 raw payload、prompt、文件内容、
    认证头或完整 transcript，未知字段不会离开构造函数。`retryableHint`
    只是提示，不能触发重试。
  - `CostTruth` 只有四态：`provider-reported`、`cli-estimated`、
    `usage-only`、`unavailable`；source 为 `provider`/`cli`/`none`。
    每条记录保留 per-session `observations`、token usage、显式 `missing`
    reasons 和 `guardBudgetUsd`。
  - Claude Code `total_cost_usd` 记为 `cli-estimated` 且
    `authoritative: false`，不是 DeepSeek 账单、余额或额度；token usage
    独立保留；CLI 显式输出的 0 保留为 0 但仍非权威；缺失或畸形成本为
    `unavailable`/`null`，绝不写成 0。顶层 usage 缺失时聚合
    `modelUsage`。重试和 repair 的每个 provider session 都进入
    observation；已知金额只在同币种内合并为非权威 subtotal，未知项保留在
    `missing`，混合币种绝不相加。
  - Codex 只在能检测到时返回 `worker_process_exit`/`timeout`，成本为
    `unavailable`。adapter 原有的有限 transient retry 保持不变（默认 2
    次、指数退避、仅针对连接重置/超时/429/5xx）；taxonomy 不增加也不
    移除重试，重试耗尽后返回最终结构化失败。
  - RunManifest task 增加可选 `failure`/`cost`：accepted 只保留 cost；
    rejected 同时保留 failure 和 cost；dependency-blocked 为
    `policy_blocked`/`policy`/`dependency_blocked` 且不伪造 cost；新
    attempt 清除上一 attempt 的 observation。旧 manifest/ledger/queue
    记录仍可读，malformed 字段 fail closed 并给出明确 parse error。
  - queue 的 `run.blocked` journal 只携带 bounded
    `failureCategory`/`failureStage`/`failureCode`/`costState`；
    RunManifest 仍是 task authority，dispatched run 的 failure 不复制到
    QueueItem。`supervisor status` 与 `queue status` 只读展示 failure/cost，
    金额只在观测到时显示，非权威 subtotal 永不冒充 run-level 权威成本。
  - 没有自动 retry、路由、准入或并行派发：queue 需要显式 `queue retry`，
    Supervisor 需要显式 `resume --retry-rejected`；controller/daemon 仍
    未实现。
  - 实测：failure taxonomy focused 14/14、Claude failure/cost 17/17、
    supervisor failure/cost 12/12、queue control 7/7、combined 50/50；
    完整套件 290/290；`npm run build` exit 0。证据见
    [docs/evidence/FAILURE_COST_TRUTH.md](evidence/FAILURE_COST_TRUTH.md)。
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

明确未落地 / 已知限制：

- **受监督的前台长时控制器/daemon（下一步决策，未实现）**：本轮只证明了
  前台、显式批准、顺序 queue 的语义；没有 daemon、后台调度、周期扫描、
  自动推进或 24 小时无人值守。是否引入由 **Plan-backed chain 语义被接受后**
  的独立决策与验收决定，不能从本轮结果反推；
- **queue v0 的已知限制**：一次一个 item，无并行准入；**contract-backed**
  依赖只决定派发/失败传播，不串联 integration branch/base；**Plan-backed
  依赖**则编译在上游 `integrationHead` 上，且只支持单条线性链（多父/merge
  queue 未实现），changed Plan/artifact 需新 item，
  materialized artifact 无 GC；显式 `readPaths` 现在按 pinned contracts base
  验证（原 control-checkout caveat 已修复，见
  [docs/evidence/CHAINED_READ_CONTEXT.md](evidence/CHAINED_READ_CONTEXT.md)）；
  manual adoption 只关闭一个已 blocked/interrupted 的 reviewed item，不自动
  接受 task、不自动 retry、不启用并行；**WorkerLease at spawn /
  owner-death recovery、ProfileCatalog 真实激活和 fixed admission 均未
  实现**；
  没有 queue 级 `--dry-run`、
  活动 run 的 stop 命令、history/compaction/GC 或 contract 原地更新；
  start 阶段若在记录 run id 前崩溃，stale item 会 fail closed 为 blocked；
  同主机锁可回收，外来主机锁 fail closed；状态是 JSON，不是 SQLite；
  不会自动生成/批准 Plan，也不做 provider 会话续跑或多父 integration；
- **自动契约冻结 / 自动派发（明确非目标）**：Task Architect 只产出
  human-reviewable Plan；必须经人类 review/edit → 原 plan compiler/freeze →
  显式 Supervisor start，不存在自动 freeze 或自动 dispatch；queue 也只接受
  已显式加入的 frozen contracts，不会自动批准或创建；
- **相对 `--out` 的 target-relative 语义（v0 限制）**：v0 按调用者 CWD
  解析；非默认位置应传绝对路径（见 evidence 的 caveat）；
- provider 会话续跑：attempt reuse 只复用 worktree/draft，不恢复 provider
  对话；也不会给 interrupted active worker 再挂一个 worker；
- 自动 worktree/manifest GC：`--fresh-attempt` 丢弃的 draft、保留的 rejected
  worktree、run/branch/manifest 都会累积，需手工清理；
- worker event 的 retention/rotation 或长期查询；事件只是 append-only 观察
  信息，不是 run authority；
- **failure/cost 的边界**：`cli-estimated` 是 Claude Code 的
  `total_cost_usd`，不是 DeepSeek 账单、余额或额度；当前内置 adapter 不产生
  `provider-reported`，也没有 run-level 权威总成本。`guardBudgetUsd` 是配置的
  保护上限，不是实际花费；逐 session/task 相加不是预计账单。分类是基于进程
  信号和有限文本的启发式，未知会落到 `unknown`；缺失成本保持
  `unavailable`/`missing`，绝不写成 0。失败/成本只是观察信息，不授权自动
  retry、路由或准入；
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
- “无限并行 runtime”仍是明确非目标；**有界 CPU/内存/runtime/provider
  并发准入已升级为下一阶段 P0**，当前未实现；
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
Orchestration queue 的实测命令、queue JSON、崩溃窗口、lock 证据与真实
provider smoke 见
[docs/evidence/ORCHESTRATION_QUEUE.md](evidence/ORCHESTRATION_QUEUE.md)。
Supervisor 的 attempt/progress 以及 queue 的操作语义见
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
| 7 | focused drill、full suite 与 build 通过 | 已实现 | drill 文件 3/3、当时 full suite 177/177、build pass；该切片当时完整套件 240/240；本轮 full 290/290 |
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
| 11 | focused tests、full suite、TypeScript build 通过 | 已实现 | 该切片 13/13；当时完整套件 177/177、build pass；新增 Task Architect 后当时 191/191；该切片当时 240/240；本轮 290/290 |
| 12 | 文档只记录实测行为并保留全部非目标 | 已实现 | [docs/evidence/ATTEMPT_CONTINUITY_PROGRESS.md](evidence/ATTEMPT_CONTINUITY_PROGRESS.md) 与四份文档更新 |

本轮 Task Architect v0 的设计验收对照
（[design/task-architect-v0.md](../design/task-architect-v0.md)）：

| # | 设计要求 | 状态 | 实测覆盖 |
|---|----------|------|----------|
| 1 | clean repo + committed design → validated Plan artifact | 已实现 | fake valid Plan 与真实 Claude Code + DeepSeek smoke 均生成两任务 Plan；复用 `compilePlan` 通过；只写 `.cliyard/plans/architect-*.json` |
| 2 | dirty repo rejected before worker starts | 已实现 | `?? dirty.txt` → preflight；fake worker **0 次调用**；无 artifact |
| 3 | worker touches any path → rejected, no Plan | 已实现 | `rogue.txt` → validation；worktree-change 另由 focused test 覆盖 |
| 4 | invalid JSON/schema/cycles/overlapping writes rejected | 已实现 | 四种错误均 exit 1、stage `validation`、无 artifact；错误文本见 evidence |
| 5 | never creates contracts/worktrees/runs/integration branches | 已实现 | 最终只有 3 个 plan artifact；HEAD、refs、worktree list 不变；contracts/runs/worktrees/runtime/ledger 均 absent |
| 6 | JSON summary and human-readable help/output | 已实现 | `--json`、human 输出、`--help` 均实测；另有 focused CLI tests |
| 7 | existing plan/Supervisor/progress tests remain green | 已实现 | 当时完整套件 191/191；该切片当时 240/240；本轮 290/290；`npm run build` 通过 |
| 8 | documentation records measured real-worker behavior and limitations | 已实现 | [docs/evidence/TASK_ARCHITECT.md](evidence/TASK_ARCHITECT.md) 与 README/NEXT_ITERATION/SUPERVISOR_V0 更新 |
| 9 | additional fail-closed guards | 已实现 | 未跟踪/越界 design、非法 plan id、非 git target、planId mismatch、worker 非零退出、design overwrite；preflight 失败均 0 次 worker 调用 |
| 10 | real Claude Code + DeepSeek smoke | 已实现（单次） | 16 s、exit 0、两任务 Plan、`touchedPaths=[]`；HEAD/status/design hash 不变；cost 未由 CLI 报告，仅记录 $1 budget cap |

Task Architect v0 已实现；它只产出 human-reviewable Plan，不自动冻结契约或
派发。Foreground Orchestration Queue v0 也已实现；它只消费显式加入的 frozen
contracts，不自动批准、冻结或改写 contracts，也不写 RunManifest。

本轮 orchestration queue v0 的设计验收对照
（[design/durable-orchestration-v0.md](../design/durable-orchestration-v0.md)）：

| # | 设计要求 | 状态 | 实测覆盖 |
|---|----------|------|----------|
| 1 | queue add 冻结 contracts hash，并拒绝 id/依赖/环错误 | 已实现 | add 冻结 SHA-256；未知依赖 exit 1；focused 覆盖重复/非法 id、环和缺失文件；changed/missing 在派发前 blocked 且 attempts=0 |
| 2 | queue run 按依赖顺序启动 ready item | 已实现 | 真实 CLI worker 顺序 `setup-task → build-task → solo-task`；未完成的依赖者不派发 |
| 3 | completed item 永不重跑 | 已实现 | 第二次 run dispatched=0、stopped=idle，queue 文件 SHA-256 不变 |
| 4 | blocked 默认停止；显式继续独立工作 | 已实现 | 默认 1 次派发后 stopped=blocked；`--continue-on-blocked` 完成 independent |
| 5 | blocked 的依赖者变为 blocked | 已实现 | dependent 记录 `dependency "blocker" is blocked`，未派发 |
| 6 | queue retry 尽可能 resume 已有 run | 已实现 | retry → pending/resume；下一次 run 用同一 run id `resume --retry-rejected` 并完成；focused 覆盖无 run id 时回退 start |
| 7 | stale running item 按 RunManifest 对账 | 已实现（含 fail-closed 窗口） | 真实 SIGKILL：有 run id 时 running→pending→同 run resume→completed；无 run id 时 running→blocked（见限制） |
| 8 | changed contracts fail closed | 已实现 | 修改/删除后 0 次派发、attempts=0、无 worker log、无 runs 目录 |
| 9 | queue lock 串行化并回收同主机 stale lock | 已实现 | live lock 下第二次 run 等待 5072 ms 后 exit 1；SIGKILL 后 stale lock 被下一次 run 回收；foreign/invalid 由 focused test 覆盖 |
| 10 | 既有 Supervisor/continuity/progress/Task Architect/drill 测试保持绿色 | 已实现 | 当时完整套件 205/205；加入 Plan-backed 后当时 236/236；该切片当时 240/240；本轮 290/290；`npm run build` 通过 |

本轮 Plan-backed chained queue base v0 的设计验收对照
（[design/plan-backed-chain-v0.md](../design/plan-backed-chain-v0.md)）：

| # | 设计要求 | 状态 | 实测覆盖 |
|---|----------|------|----------|
| 1 | add-plan 拒绝 unsafe/重复 id、未知/环依赖、malformed/invalid Plan、Plan id 不匹配和 >1 依赖 | 已实现 | CLI 拒绝矩阵（失败 add 后 queue 文件 SHA-256 不变）+ focused tests |
| 2 | root item 在 add 时 pinned 的 HEAD 上 materialize 并走既有 Supervisor | 已实现 | 真实 foundation run；focused pinned-base/HEAD-move 测试 |
| 3 | dependent 只在上游 completed 后按其 RunManifest `integrationHead` materialize | 已实现 | 三次真实 chain 的时间戳/base + focused blocked/cancelled/missing 上游 |
| 4 | downstream worker worktree 含上游 accepted 文件/commit | 已实现 | 三次真实 chain 实时捕获 `foundation.txt`；downstream verifyCommands 在 worktree 中通过 |
| 5 | downstream integration branch 含上下游工作，上游 head 是下游 head 的祖先 | 已实现 | 真实 branch 内容 + `git merge-base --is-ancestor` exit 0（三次） |
| 6 | blocked/cancelled/missing/interrupted/ambiguous 上游不合成 base、不派发 | 已实现 | focused 覆盖 blocked/cancelled/missing 队列项与非 completed/ambiguous manifest；无真实 interrupted 上游演练 |
| 7 | changed approved Plan 在 Supervisor start 前 fail closed | 已实现 | CLI：`dispatched=0`、`attempts=0`、无 runs/materialized/worker events |
| 8 | 已记录 materialization 在 retry 中 byte-identical；changed Plan 不可替换 | 已实现 | focused retry：bytes/inode 不变、same-run resume；不是真实 provider retry |
| 9 | 既有 contract-backed 行为与全部旧测试保持绿色 | 已实现 | legacy parsing test + 当时 full suite 236/236；该切片当时 240/240；本轮 290/290；`npm run build` 通过 |
| 10 | 真实 Claude Code + DeepSeek chain 证明 downstream worktree 与 ancestry | 已实现 | 三次真实 2/2（17.2 s、24.6 s、21.4 s）；第三次 live worktree `51e50a09…` 含 `foundation.txt`，ancestry exit 0 |

本轮 Chained Read Context v0 的设计验收对照
（[design/chained-read-context-v0.md](../design/chained-read-context-v0.md)）：

| # | 设计要求 | 状态 | 实测覆盖 |
|---|----------|------|----------|
| 1 | pinned 旧 base 仍含文件时通过，即使当前 checkout 已移除 | 已实现 | focused test：worktree 在 pinned base 读取 `design/upstream.md` |
| 2 | worker worktree 在 pinned base 创建并可读 | 已实现 | focused test + 真实 downstream worktree HEAD = foundation head 且含 `foundation.txt` |
| 3 | 仅 untracked 的当前 checkout 文件仍失败 | 已实现 | focused test，保留原 untracked-context 错误 |
| 4 | 当前 HEAD 有、pinned base 无的文件失败 | 已实现 | focused test，`absent from contracts base` |
| 5 | `.` 与缺失可选 `AGENTS.md` 行为不变 | 已实现 | focused test |
| 6 | 同一 contracts 文档内 task-produced read path 继续通过 | 已实现 | focused test |
| 7 | Plan-backed 2-item chain 可在 downstream 显式声明 upstream 文件并通过真实 Supervisor + Claude Code + DeepSeek | 已实现 | 真实 chain 2/2、13.953 s、`readPaths: ["foundation.txt"]`、实时 worktree + worker Read event |
| 8 | 既有 contract-backed 行为与全部旧测试保持绿色 | 已实现 | 该切片当时 full 240/240、Plan-backed focused 31/31、`npm run build` exit 0 |

未覆盖的能力不会被写成“已实现”：跨主机回收、leader-dead 自动 kill、
daemon 周期回收、Windows 进程身份、生产或跨仓库端口协调、自动契约冻结/自动
派发、自动 push/合入 main、provider 会话续跑、自动 worktree GC，以及本轮
未实现的受监督前台长时控制器/daemon。

## 2. 验证

### 2026-10-28 Queue Manual Adoption v1 + deadline fixture stability

集成 HEAD `ce1157a`（`manual-queue-adoption` `b7f7d9e` +
`deadline-fixture-stability` `c57d591`，macOS，Node `v20.20.2`）：

```text
npm run build                                          → exit 0
focused queue adoption                                 → 8/8 通过（2539.7 ms）
focused deadline extension                             → 13/13 通过（23601.98 ms）
npm test（完整套件）                                   → 371/371 通过（24411.1 ms，0 fail）
```

371 由本次集成的 8 个 adoption 测试、1 个新的 deadline late-result 负例和
此前记录 362 项组成；此前 `361/362` 的 deadline fixture 红门禁已关闭。
stabilized fixture 改用 grant callback marker 握手，不再用固定 sleep 与最终
deadline 竞速，并断言 late result 仍然 timeout。以上为单次本机运行；不构成
CI、长期 flake 率或跨主机结论。测试通过方式与证据边界见
[evidence/QUEUE_ADOPTION.md](evidence/QUEUE_ADOPTION.md)。

### 2026-10-27 历史基线（failure/cost 工作树）

当前套件（包含 failure/cost、chained read context、Plan-backed chain、queue、
Task Architect、attempt continuity / worker progress 与 failure drill 测试）：

```text
npm run build                                          → exit 0
focused failure taxonomy                               → 14/14 通过（85.7 ms）
focused Claude failure/cost                            → 17/17 通过（11694.1 ms）
focused supervisor failure/cost                        → 12/12 通过（1134.9 ms）
focused queue control snapshot                         → 7/7 通过（733.3 ms）
focused failure/cost combined                          → 50/50 通过（9991.6 ms）
npm test（完整套件）                                   → 290/290 通过（14175.8 ms）
```

focused 计数在第二次运行中复现；本地耗时会有波动。290 项比上一
ControlSnapshot 基线 245/245 多 45 项（14 taxonomy + 17 Claude adapter +
12 durable supervisor/queue + 2 queue-control）。较早的
Chained Read Context v0 真实 chain（HEAD `390d61e`）：scratch repo
`/tmp/cliyard-crc-evidence.j5O3Hs/repo`，foundation plan base `a2b1e74…`，
upper downstream `readPaths: ["foundation.txt"]`；13.953 s 完成 2/2。
foundation `integrationHead e5a7af69…` 被 upper materialization/Supervisor
`baseCommit` 精确采用；`13:48:15Z` 捕获的 live downstream worktree HEAD 为
`e5a7af69…`，含 `foundation.txt`（`foundation-ok`）、无 `upper.txt`，status
clean；upper worker 在 `13:48:17.176Z` Read 该文件、在 `13:48:18.352Z`
Write `upper.txt`。最终 upper branch 含 `README.md`、`foundation.txt`、
`plans/`、`upper.txt`（`upper-ok`），ancestry exit 0；no-op rerun
`dispatched=0`，queue 文件 SHA-256 前后均为 `972b26f0…`。exact commands、
IDs、hash 与限制见
[docs/evidence/CHAINED_READ_CONTEXT.md](evidence/CHAINED_READ_CONTEXT.md)。

此前真实 Claude Code + DeepSeek 三次 two-item chain（均未显式 readPaths）
完成 2/2（17.2 s、24.6 s、21.4 s），保留为历史记录。第二次 foundation
`integrationHead 8e2e8b99…` 被 upper 的 materialization/Supervisor
`baseCommit` 精确采用；运行时捕获的 downstream worktree HEAD 为
`8e2e8b99…` 且含 `foundation.txt`（`foundation-ok`）；upper integration
head `464c8cc1…` 含两个文件，上游 head 是下游 head 的祖先（ancestry exit
0）。第三次（最终文档复核）在 `/tmp/cliyard-pbc-verify.ECxtih/repo` 用同一
对 Plan 重跑：21.4 s、H0 `f110f528…`、foundation head `51e50a09…`、upper
head `6bafdc0a…`；`13:31:44Z` 捕获的 live downstream worktree HEAD 为上游
head 且含 `foundation.txt`，ancestry exit 0；随后再次 `queue run` 为 no-op
（queue sha `6c4613c5…`），completed retry exit 1。exact commands、artifact
hash、fail-closed matrix 见
[docs/evidence/PLAN_BACKED_CHAIN.md](evidence/PLAN_BACKED_CHAIN.md)；其中记录的
readPaths caveat 已被修复并单独实测，见
[docs/evidence/CHAINED_READ_CONTEXT.md](evidence/CHAINED_READ_CONTEXT.md)。

以上均为本机单次运行；这是本机 macOS 证据，不是长期 flake 率、CI 或跨主机
结论。完整套件包含此前的 attempt/progress/drill 组、runtime/恢复组、Task
Architect 组、queue 组和 Plan-backed 组；本轮单独重跑了 read-context 与三个
Plan-backed focused 文件，其他组未单独重跑，全部 240 项在完整运行中通过。
更早 HEAD `3bc56e4` 的记录是 architect focused 14/14（2193.3 ms）与 full
suite 191/191（11236.8 ms）；本轮没有重跑 architect focused。failure drill
实测细节（子进程、场景、端口、lease）见
[docs/evidence/RUNTIME_FAILURE_DRILLS.md](evidence/RUNTIME_FAILURE_DRILLS.md)；
attempt continuity、worker progress 与异常 drill 回收的实测细节见
[docs/evidence/ATTEMPT_CONTINUITY_PROGRESS.md](evidence/ATTEMPT_CONTINUITY_PROGRESS.md)；
Task Architect 的 fake-worker/真实 provider 实测见
[docs/evidence/TASK_ARCHITECT.md](evidence/TASK_ARCHITECT.md)。

Task Architect 的 CLI 实测使用 `/tmp` scratch target（base
`f836c4b7220ac6d207415ad35a4ba1dd35da4265`）：fake worker 的 valid Plan、
human 输出，以及 dirty（0 次 worker 调用）、touched path、moved HEAD、
未跟踪/越界 design、非法 plan id、非 git target、invalid JSON、空 schema、
cycle、overlap、planId mismatch、worker 非零退出和 design overwrite 均按预期
拒绝且不写 Plan。有效运行只写 `.cliyard/plans/`；HEAD、refs、worktree list、
design hash 和 `git status` 均不变，没有 contracts/runs/worktrees/runtime/
ledger。真实 Claude Code + DeepSeek（`claude-ds`、`deepseek-flash[1m]`，$1
budget cap）在 16 s 内生成合法两任务 Plan，`touchedPaths=[]`，HEAD/status
不变；CLI 不报告实际费用。相对 `--out` 按调用者 CWD 解析，已在 evidence
中记录为 caveat。Task Architect 不冻结契约、不派发。

本轮另外做了 attempt continuity 的 CLI 级实测（使用本地 stream-json fixture，
不是真实 DeepSeek/Claude provider）：一次 rejected attempt 在默认 resume 中复用同一
worktree（第二次 `draftSeen=true`），一次 `--fresh-attempt` 使用不同 worktree
（`draftSeen=false`），live `status` 在 worker 运行时显示 `tool.start` 与
heartbeat，且 status 前后 manifest hash 不变。异常 drill 以
`CLIYARD_RUNTIME_DRILL_TEST_HANG_AFTER_READY=cleanup-failure`、
`childTimeoutMs 5000`、`portBase 24800` 运行：报告 2/3（超时场景按设计
fail），child 被 SIGKILL，exact executor `scanned=1/reaped=1/needs_human=0/
skipped=0`，manifest `cleanup=complete` + `reaped`，lease 0，端口 24860 free。

本轮 orchestration queue 的 CLI 级实测（`/tmp` scratch repos；除最后一项外
均使用本地 fixture provider，不是真实 DeepSeek/Claude provider）：

- 依赖/完成：真实 CLI worker 顺序 `setup-task → build-task → solo-task`，
  3/3 completed；第二次 run dispatched=0 且 queue 文件 SHA-256 不变；三个
  item 各生成独立 integration branch；
- 依赖只决定派发：`build` 的 integration branch 不含 `setup` 的 accepted
  commit（两者基于同一 base，但 setup head 不是 build head 的祖先）；
- blocked：默认只派发 blocker 后停止（dependent/independent 保持 pending）；
  `--continue-on-blocked` 完成 independent，dependent 记录
  `dependency "blocker" is blocked`；
- retry/resume：blocked item（attempts 1、run id 已记录）→ `queue retry` →
  pending/resume → 下一次 run 用**同一 run id** `resume --retry-rejected`
  并 completed（attempts 2）；
- 真实 SIGKILL：start 阶段（尚未记录 run id）对账为 blocked
  `running item has no recorded run id`；resume 阶段（已记录 run id）对账为
  pending，并继续同一 run → completed（attempts 3）；两次 stale 同主机 lock
  均被下一次 run 回收；
- lock：live 同主机 owner 持锁时，第二个 `queue run` 等待 **5072 ms** 后
  exit 1，不派发；`queue list` 在持锁期间可只读；
- changed/missing contracts：0 次派发、attempts 0、无 worker log、无 runs
  目录；
- 真实 Claude Code + DeepSeek（`claude-ds`、`deepseek-flash[1m]`，$1 cap）：
  4810 ms、completed，integration branch 含 `real.txt` 内容 `queue-real`；
  CLI 不报告实际费用。

完整命令、queue JSON、lock 证据和崩溃窗口见
[docs/evidence/ORCHESTRATION_QUEUE.md](evidence/ORCHESTRATION_QUEUE.md)。

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

已完成的 RuntimeManager v0、Orphan Reaper v0、hardening、failure drills v0、
attempt continuity / worker progress / drill abnormal recovery v0、Task
Architect v0、**Foreground Orchestration Queue v0**、
**Plan-backed Chained Queue Base v0**、**Queue Manual Adoption v1**、
**Chained Read Context v0**、**ControlSnapshot/event/resource v0**，以及
**Worker Failure Taxonomy / Cost Truth v0**，加上 deadline fixture
stability，不在下一迭代重复。
下一具体步骤严格按执行权威链，而不是同时铺开：
**WorkerLease persisted at spawn + controller owner-death recovery →
ProfileCatalog + 真实 binding activation → per-run Supervisor ownership +
short control locks → fixed hierarchical admission → Windows Job Object →
telemetry-backed dynamic scoring**。adoption 只关闭 blocked item，不启用并行、
路由或准入；Windows 与动态评分不得越过前三项前置。

1. **WorkerLease persisted at spawn + owner-death recovery（P0，下一步，未实现）**
   - worker 身份一可用就持久化 lease，而不是等 `collect()` 返回才写；
   - lease 记录 run/task/attempt/profile、controller pid/host/identity、
     worker pid/pgid/osStartIdentity/captureMode、workspace、createdAt/
     heartbeatAt、cleanup 状态；
   - controller 被 SIGKILL 后，新 controller 读取 lease 并精确核对身份；
     仅对仍存活且已证明归属的 group 执行终止，保留 worktree 与既有证据，
     通过显式新 attempt 或 provider session continuation 继续；group 已消失
     则检查 artifacts 并只验收可证明的部分；身份或清理不明确一律
     `needs_human`，绝不按 pid/pgid/进程名猜测；
   - 不承诺重接旧 CLI stdout；若 worker 必须比 controller 活得更久，需要
     外部 guardian/OS service manager 与单独证据协议；
   - 这是任何并行执行的安全前置；当前没有 durable WorkerLease，也没有
     cliyard 自身 SIGKILL 后的 owner-death 恢复。
2. **ProfileCatalog + 真实 binding activation（P0，WorkerLease 之后）**
   - 建立 secret-free `ProfileCatalog`，持久化 `ExecutionProfile`、
     endpoint/账号绑定和能力；
   - 路由先做 deterministic hard filtering + operator preference；LLM 可以
     建议但不能拥有持久化 RouteDecision；
   - adapter 必须返回或持久化 binding activation 结果后才允许 dispatch；
     未激活、未知容量或未知账户状态 fail closed；不继承公开并发数字；
   - profile selection 不等于 endpoint/account 已激活，二者必须分开记录。
3. **Per-run Supervisor ownership + short control-store locks（P0）**
   - 替换 repo-global 长持有 Supervisor ownership 的模型；每个 run 独立
     ownership，控制存储锁只覆盖短操作；
   - 必须先做独立架构 spike，不能直接并发调用现有 `runQueue`；
   - 明确多 `running` item 的独立 manifest/worktree/branch、blocked 隔离
     与独立崩溃恢复。
4. **Fixed hierarchical admission（P0，profile 激活与 per-run ownership 之后）**
   - 准入是合取限制：queue-item slot + task slot + execution-profile slot +
     runtime/device slot + port/browser/database lease + budget/host
     capacity；
   - 未知 profile capacity 先走单并发 probe；多个局部 max 不得相乘成无界
     worker burst；
   - 同时覆盖 queue item 并行与 Plan ready-wave 并行，不能只做其中一条轴；
   - 先固定上限，之后才允许基于实测遥测的 ramp/backoff；动态评分必须晚于
     本项和真实 binding activation。
5. **CLI + 模型执行组合路由与有界并行派发（P0，前置完成后）**
   - 支持三类现实场景：多模型 + 多 CLI、单 CLI + 多模型、单模型 + 多 CLI；
   - 持久化 `ExecutionProfile`、endpoint/账号绑定、路由硬约束、评分依据、
     fallback，以及 `provider-reported`/`cli-estimated`/`usage-only`/
     `unavailable` 四态成本；缺失成本保持 `missing`，不写成 0；
   - provider 并发、额度、余额和价格必须按执行绑定运行时探测；公开文档数字
     不是当前订阅容量。未知绑定先单并发探针；
   - 将有界并行列为首要用户价值，替代人工维护多个终端/branch；
   - 并行前检查独立依赖、非重叠 write scope、provider/model 并发、runtime
     slot 和端口 lease；依赖任务仍按上游 integrationHead 串行；
   - Plan 编译器的写路径规则改为“无传递依赖的重叠拒绝、有传递依赖的重叠
     按序串行”，从而支持同模块子任务既并行又安全串行；
   - 只有 WorkerLease/owner-death、profile activation 与 fixed admission
     完成后，才允许开启并行。
6. **Control API、可替换入口与外部 UI（P0/P1，未实现）**
   - CLI 与版本化本地 Control API / event stream 是稳定入口；
   - DSH 只做薄 cockpit，优先注册 `dsh-better-sidebar` tab；
   - 后续最小自有 Web UI 复用同一 API，DSH 停止维护不影响控制面；
   - 不自研完整编辑器、终端、diff、Git 或聊天客户端。
7. **受监督的前台长时控制器（路由/并行/证据之后，未实现）**
   - controller 每轮从磁盘 rehydrate，不依赖 LLM 长上下文；空闲时释放
     queue lock，并等待新批准 item 或显式 retry；
   - failure taxonomy 已可用，但没有自动 retry；自动 retry 仍需显式
     attempt policy 和审计记录；
   - 先证明 foreground look-ahead scheduling、controller lock/heartbeat、
     clean shutdown 和 bounded soak，再做 daemon/launchd/systemd 决策；
   - 本轮不把它写成已完成能力，也不声称 24 小时无人值守。
8. **显式批准的人类门禁保持不变**
   - Task Architect 只产出 human-reviewable Plan，不自动冻结契约、不自动
     派发、不 merge、不 push；
   - 路径仍是 review/edit Plan → 既有 plan compiler/freeze → 显式
     Supervisor start；
   - queue 只接受显式加入的 frozen contracts 或显式加入的已批准 Plan；
     不自动批准、冻结或创建契约/Plan；
   - Task Architect 和 queue 都不是 contract/run authority。
9. **queue v0 的顺序限制进入下一阶段改造**
   - 当前一次一个 item 是已完成 v0 的事实，不是最终产品约束；
   - 下一阶段新增有界并行准入，但不承诺无限并行；
   - **contract-backed** 依赖仍只决定派发/失败传播，不串联 integration
     branch/base；**Plan-backed** 已实现单条线性依赖的 base 串联；多父
     integration/merge queue 仍后置；
   - 不新增 queue dry-run、活动 run 的 stop、history/GC 或 contract 原地更新；
   - 不新增 daemon、跨主机锁或 SQLite。

对本轮已完成的 Task Architect / queue / Plan-backed chain / attempt
continuity / progress / drill 切片，以下仍是明确非目标，不得用本轮结果反推为
已实现：

- daemon、周期扫描、后台常驻或 24 小时无人值守（须先有上述独立决策）；
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
- 自动契约冻结或自动派发；Task Architect 只写 Plan，queue 只消费已批准项；
- 自动合入 main 或自动 push；
- HTTPS / 认证 / TCP-only readiness；
- Windows POSIX 进程组等价清理；
- 自定义优雅关闭命令或日志轮转。

Attempt reuse 是 worktree 连续性，不是 provider 会话续跑；worker progress 是
观察信息，不是验收依据；Task Architect 只产出 Plan；queue 是前台、显式批准、
顺序队列，不是契约或运行权威，也不是 daemon。manual adoption 是人工复核后的
queue 终态，不是自动接受、自动重试或并行派发。下一步先补 **WorkerLease at
spawn + owner-death recovery**，再做 **ProfileCatalog/真实 binding
activation**、per-run ownership 和 **fixed hierarchical admission**；只有这些
完成后才允许开启有界并行。Windows Job Object 与 telemetry-backed dynamic
scoring 分别排在其后。EvidenceBundle 与 look-ahead controller 再后；daemon
必须最后经过独立设计、soak 和验收，不能从当前单机顺序队列证据推导出来。

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
14. [已完成] drill 文件 3/3（含超时异常回收）、当时 full suite 177/177、
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
23. [已完成] focused 13/13、runtime 组 81/81、当时 full suite 177/177、
    `npm run build` 通过。
24. [已完成] 文档只记录实测行为，保留 daemon、跨主机、SQLite、浏览器证据、
    准入调度与 24 小时声明等全部非目标。

Task Architect v0（已完成）：

25. [已完成] clean repo + committed design → validated Plan artifact；fake
    valid Plan 与真实 Claude Code + DeepSeek smoke 均通过 `compilePlan`。
26. [已完成] dirty worktree、未跟踪/越界 design、非 git target、非法 plan id
    在 worker 启动前 fail closed；dirty/non-git/invalid-id 的 fake worker 调用
    次数为 0。
27. [已完成] worker 非零退出、touched paths、worktree 变化、moved HEAD、
    invalid JSON、空 schema、cycle、overlap、planId mismatch、design
    overwrite 均拒绝且不写 Plan。
28. [已完成] 有效运行默认只写 `.cliyard/plans/<planId>.json`（`--out` 可覆盖
    路径）；没有 contracts、worktrees、runs、integration branches、ledger、
    dispatch、merge 或 push；Plan 必须经人类 review → compiler/freeze →
    显式 Supervisor start。
29. [已完成] architect focused 14/14、完整套件 191/191、`npm run build`
    通过。
30. [已完成] 真实 Claude Code + DeepSeek smoke：16 s、exit 0、两任务 Plan、
    `touchedPaths=[]`、HEAD/status/design hash 不变。
31. [已完成] 文档只记录实测行为与限制，保留全部非目标。

Foreground Orchestration Queue v0（已完成）：

32. [已完成] `queue add/list/retry/cancel/run`；add 冻结 contracts path 与
    SHA-256，拒绝重复/非法 id、未知依赖和环。
33. [已完成] `queue run` 前台顺序派发 ready item；`running`/`attempts` 在
    调用 Supervisor 前持久化；完成要求 exit 0 且 RunManifest completed。
34. [已完成] 默认 blocked 停止；`--continue-on-blocked` 继续独立 item，并将
    blocked/cancelled 的依赖者传递标记为 blocked。
35. [已完成] completed/cancelled 单调；retry 有 run id 时 resume 同一 run，
    无 run id 时 start；queue 不改写 RunManifest。
36. [已完成] 同主机 stale queue lock 回收；live lock 串行化（第二个 run
    5072 ms 后 exit 1）；foreign/invalid lock fail closed（focused test）。
37. [已完成] stale running 对账：有 run id → pending/resume 并完成同一 run；
    无 run id → blocked fail closed（两处真实 SIGKILL）。
38. [已完成] changed/missing contracts 在派发前 blocked，attempts=0，
    无 worker log、无 runs 目录。
39. [已完成] queue focused 13/13、当时完整套件 205/205、`npm run build`
    通过；真实 Claude Code + DeepSeek smoke 4810 ms completed。
40. [已完成] 文档只记录实测行为与限制，保留全部非目标，并明确 queue 是
    前台显式批准队列，不是 daemon；RunManifest 仍是 task authority。

Plan-backed Chained Queue Base v0（已完成）：

41. [已完成] `queue add-plan` 在 queue lock 下读取一次已批准 Plan，冻结
    绝对路径 + SHA-256，root item 持久化 add 时捕获的精确 HEAD；拒绝
    unsafe/重复 id、未知/环、>1 依赖、缺失/不可读/malformed/invalid Plan
    和 Plan id mismatch；失败的 add 不留下 partial item。
42. [已完成] dependent 只读取 completed 上游 RunManifest 的
    `integrationHead`，并校验 run id、contracts identity 和 base ancestry；
    blocked/cancelled/missing/non-completed/ambiguous 上游均 fail closed，
    attempts 不变且不派发。
43. [已完成] materialization 在 attempts+1 和 Supervisor start 之前完成并
    持久化；artifact 路径/bytes/provenance 确定，queue 与 RunManifest 的
    contractsHash 一致。
44. [已完成] retry/resume 只复用已记录 materialization 和同一 run；changed
    Plan/artifact/upstream evidence 均 blocked；artifact bytes/inode 不变。
45. [已完成] downstream Supervisor `baseCommit` = 上游 `integrationHead`；
    上游 head 是下游 head 的祖先；downstream worktree/branch 含上游
    accepted 文件。
46. [已完成] 三次真实 Claude Code + DeepSeek two-item chain 均 2/2
    （17.2 s、24.6 s、21.4 s）；第三次（最终文档复核）实时 downstream
    worktree、branch 内容和 ancestry 均实测，completed 后第二次 run 为
    byte-identical no-op，completed retry exit 1。
47. [已完成] 当时 focused 31/31、完整套件 236/236、`npm run build` 通过；
    文档记录 readPaths caveat、非目标和真实 provider 的限制。该 caveat
    后由 Chained Read Context v0 修复。

Chained Read Context v0（已完成）：

48. [已完成] `validateReadContexts` 接收 contracts 的精确 shared
    `baseCommit`，对非豁免显式 `readPath` 执行
    `git cat-file -e <base>:<path>`；control checkout/HEAD/index 不再决定
    worker 能否读取；不从 control checkout 复制文件。
49. [已完成] `.`、缺失可选 `AGENTS.md`、同一 contracts 文档内 task-produced
    路径保留原豁免；仅 untracked 的 control-checkout 文件仍按原
    untracked-context 错误拒绝；tracked 于当前 HEAD 但不在 pinned base 的
    文件拒绝。
50. [已完成] focused 覆盖：pinned 旧 base 在当前 HEAD 移除后仍通过并在
    worktree 读取；base 之后新增、当前 HEAD 存在的文件失败；untracked-only
    失败；`.`/AGENTS.md 与 task-produced 路径保持通过。
51. [已完成] 真实 Claude Code + DeepSeek 2-item chain：downstream
    `readPaths: ["foundation.txt"]`，foundation plan base `a2b1e74…`，
    upper base/upstream head `e5a7af69…`；13.953 s 完成 2/2。
52. [已完成] 在 `13:48:15Z` 实时捕获 downstream worktree：HEAD =
    upstream `integrationHead`，`foundation.txt` 存在，`upper.txt` 不存在，
    status clean。
53. [已完成] worker 在 `13:48:17.176Z` Read `foundation.txt`、在
    `13:48:18.352Z` Write `upper.txt`；最终 branch 含两文件，ancestry
    exit 0；artifact/queue/manifest hash 一致；no-op rerun byte-identical。
54. [已完成] 该切片 read-context focused 5/5、Plan-backed focused 31/31、
    当时完整套件 240/240、`npm run build` exit 0。
55. [已完成] 文档只记录实测行为；PLAN_BACKED_CHAIN 的 readPaths caveat
    已替换为 measured fix 链接，非目标保持不变。

当前状态与缺口：

56. [已完成] 只读 `queue status` 聚合、queue event journal 与 host/resource
    snapshot；未知 provider 执行绑定不填并发、额度、余额或价格。该切片
    queue-control focused 5/5、当时 full 245/245、build 通过；本轮 full
    290/290；见 [evidence/CONTROL_SNAPSHOT.md](evidence/CONTROL_SNAPSHOT.md)。
57. [已完成] provider failure taxonomy + cost truth v0：十类枚举
    （budget_exhausted、timeout、provider_transient、provider_auth、
    provider_protocol、worker_process_exit、verifier_rejected、
    policy_blocked、resource_exhausted、unknown）、八个 stage、四态
    `CostTruth`、per-session provenance、显式 `missing`、
    `guardBudgetUsd`、RunManifest checkpoint、`supervisor status` /
    `queue status` 观察面与 bounded journal 字段。CLI estimate 非权威，
    缺失成本不写成 0，无自动 retry。focused 50/50、full 290/290、build
    exit 0；见
    [evidence/FAILURE_COST_TRUTH.md](evidence/FAILURE_COST_TRUTH.md)。
58. [未完成] 增加 audited attempt-policy 操作，禁止依赖手工修改
    `.cliyard/queue.json` 扩大 attempts。
59. [未完成] 实现 CLI + 模型 `ExecutionProfile` 路由，覆盖多模型/多 CLI 的
    三种真实部署场景。
60. [未完成] 建立共享 hierarchical admission broker：结合 CPU/RAM、runtime/
    port/browser、provider/model 运行时观测和预算动态选择并行数。`3` 只作为
    scheduler warm start，不是 provider permit；未知绑定先单并发探针，
    通过受控 calibration 调整 hard max，429、内存压力、swap 或 OOM 时立即
    降并发。设计见
    [dynamic-parallel-admission-v0.md](../design/dynamic-parallel-admission-v0.md)。
61. [未完成] 完成并行 Supervisor/queue 架构 spike，再基于共享 broker 实现
    有界并行派发：独立 branch/worktree/run/evidence、资源准入和分别恢复；
    同时把现有 Plan ready-wave 任务并行纳入统一 admission，不能只做
    queue item 并行。
62. [未完成] 先稳定本地 Control API/event stream；DSH 只做薄 cockpit，
    最小自有 Web UI 作为平台不可用时的后备入口。
63. [未完成] 在路由和并行语义稳定后，实现 DesignRevision/EvidenceBundle，
    再引入 look-ahead foreground controller、bounded soak 和 daemon 决策。

执行权威链下一批：

64. [已完成] Queue Manual Adoption v1：`queue adopt` 只接受 blocked item 与
    精确 run binding；校验 frozen contracts/approved Plan、source
    blocked/interrupted manifest 和 full-commit lineage；写入独立版本化
    `OperatorResolution`，原 RunManifest 保持历史真相、task 不标记 accepted；
    bounded secret-free evidence、identity 幂等、adoption event 与
    `completion: "adopted"` status；Plan-backed dependant 记录
    `upstreamAdoptedCommit`。focused 8/8（2539.7 ms）、full 371/371
    （24411.1 ms）、build exit 0；见
    [evidence/QUEUE_ADOPTION.md](evidence/QUEUE_ADOPTION.md)。
65. [已完成] Deadline fixture stability：test-only marker 握手替代固定
    sleep，拓宽 fixture 窗口，并新增 late-result 仍 timeout 的负例；
    deadline-extension focused 13/13（23601.98 ms），完整套件 371/371；
    生产 deadline 语义未改变。
66. [未完成] 在任何并行执行之前持久化 WorkerLease at spawn，并定义
    controller owner-death recovery：精确身份校验、仅终止已证明归属的
    group、保留 worktree/证据、模糊身份 `needs_human`；不承诺重接旧
    stdout，也不承诺 worker 跨 controller 存活。
67. [未完成] 建立 secret-free ProfileCatalog 并证明真实 endpoint/account
    binding activation；profile selection 不等于激活，未激活或未知容量
    fail closed。
68. [未完成] 将 repo-global 长持有 Supervisor ownership 改为 per-run
    ownership + short control-store locks；先架构 spike，不能直接并发
    调用现有 `runQueue`。
69. [未完成] 建立 fixed hierarchical admission：queue item、task、profile、
    runtime/device、port/browser/database lease 与 budget/host capacity
    合取限制；未知 profile 先单并发 probe；同时覆盖 queue item 与 Plan
    ready-wave 两条并行轴。
70. [未完成] 在 66-69 之后增加 Windows Job Object
    `ProcessOwnerProvider`；在那之前不得声称 Windows 进程树等价。
71. [未完成] 在 67-69 和真实遥测之后增加 dynamic routing score 与自适应
    ramp/backoff；`3` 只是 scheduler warm start，不是 provider permit。

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
            runtime 81/81、当时 full 177/177、build 通过
7. [已完成] 该轮文档更新：README / NEXT_ITERATION / SUPERVISOR_V0 /
            RUNTIME_MANAGER / docs/evidence/ATTEMPT_CONTINUITY_PROGRESS.md
8. [已完成] Task Architect v0：只读 preflight/worker/post-run guards、
            deterministic Plan validation、仅 plan artifact；focused 14/14、
            full 191/191、build 通过；真实 Claude Code + DeepSeek 16 s smoke
9. [已完成] Task Architect 本轮文档更新：README / NEXT_ITERATION /
            SUPERVISOR_V0 / docs/evidence/TASK_ARCHITECT.md
10. [已完成] Foreground Orchestration Queue v0：frozen contracts hash、
            依赖顺序、blocked 停止/继续、retry/resume、stale running 对账、
            queue lock；focused 13/13、full 205/205、build 通过；
            真实 SIGKILL 两处崩溃窗口 + 真实 DeepSeek smoke
11. [已完成] 该轮 queue 文档更新：README / NEXT_ITERATION / SUPERVISOR_V0 /
            docs/evidence/ORCHESTRATION_QUEUE.md
12. [已完成] Plan-backed Chained Queue Base v0：add-plan snapshot/validation、
            pinned root base、完成上游 RunManifest integrationHead lineage、
            deterministic materialization、retry/resume、fail-closed matrix；
            focused 31/31、full 236/236、build 通过；三次真实 Claude Code +
            DeepSeek two-item chain 2/2（17.2/24.6/21.4 s）
13. [已完成] 该轮 Plan-backed 文档更新：README / NEXT_ITERATION /
            SUPERVISOR_V0 / docs/evidence/ORCHESTRATION_QUEUE.md /
            docs/evidence/PLAN_BACKED_CHAIN.md
14. [已完成] Chained Read Context v0：readPaths 按精确 shared base 验证、
            untracked/optional-AGENTS/task-produced 规则不变；focused 5/5 +
            Plan-backed 31/31、当时 full 240/240、build exit 0；一次真实
            Claude Code + DeepSeek chain 显式 downstream readPaths 2/2
            （13.953 s），实时 worktree + Read event + ancestry
15. [已完成] 本轮 read-context 文档更新：README / NEXT_ITERATION /
            design/chained-read-context-v0.md /
            docs/evidence/PLAN_BACKED_CHAIN.md /
            docs/evidence/CHAINED_READ_CONTEXT.md
16. [已完成] ControlSnapshot/event/resource v0：只读 queue status、event
            journal、未知 provider capacity；focused 5/5、当时 full 245/245、
            build 通过；本轮 full 290/290
17. [已完成] Worker failure taxonomy + cost truth v0：十类枚举、四态成本、
            RunManifest checkpoint、status/journal 观察面、无自动 retry；
            focused 50/50、full 290/290、build exit 0
18. [已完成] Queue Manual Adoption v1 + deadline fixture stability：
            OperatorResolution/evidence/lineage/status/event；focused 8/8、
            deadline focused 13/13、full 371/371、build exit 0
19. 下一步 P0：WorkerLease persisted at spawn + controller owner-death
            recovery（精确身份、保留证据、模糊身份 needs_human）
20. 然后：secret-free ProfileCatalog + 真实 endpoint/account binding
            activation → per-run Supervisor ownership + short control locks
21. 再然后：fixed hierarchical admission → 固定上限有界并行 v0
            （warm start 3 只是调度初值）
22. 之后：Windows Job Object ProcessOwnerProvider（不得提前）
23. 再后：基于实测遥测的 adaptive ramp/backoff（不得早于前两项）
24. 接着：Control API、DSH thin cockpit、最小自有 Web UI
25. 最后：DesignRevision/EvidenceBundle、look-ahead controller、soak、
            daemon 决策
26. 不重复已完成切片；不新增 daemon、跨主机、SQLite、无限并行、自动合入
    main、provider 会话续跑、自动契约冻结或 24 小时声明
```

## 6. 上一迭代状态

Supervisor v0（前台、原子 JSON RunManifest、进程级 SIGKILL 恢复）已完成，
其操作语义与自举手册见 [docs/SUPERVISOR_V0.md](SUPERVISOR_V0.md)。当前完整套件
包含 failure/cost、chained read context、Plan-backed chain、queue manual
adoption、queue、Task Architect、supervisor、attempt
continuity/progress、ControlSnapshot、deadline extension 与
runtime/drill 测试（**371/371** 通过，2026-10-28，HEAD `ce1157a`）。
本轮没有引入 daemon 或 SQLite，也没有把 supervisor 或 queue 的后台化列入
计划。attempt reuse 是 worktree 连续性，worker progress 是观察信息；
failure/cost 也是观察信息，不授权自动 retry；Task Architect 只产出 Plan；
queue 消费显式加入的 frozen contracts 或已批准 Plan，但不生成、批准或冻结
它们；三个组件都不改变验收权威。manual adoption 记录人工复核后的
`OperatorResolution`，原 blocked/interrupted RunManifest 保持历史真相，task
不标记 accepted。RuntimeManager、Orphan Reaper、hardening、failure drills、
attempt continuity/progress/异常 drill 回收、Task Architect、Foreground
Orchestration Queue、Plan-backed Chained Queue Base、Queue Manual Adoption
v1、Chained Read Context、ControlSnapshot/event 与 Worker Failure
Taxonomy/Cost Truth 均已收口；下一阶段严格先做 **WorkerLease at spawn +
owner-death recovery**，再做 **ProfileCatalog/真实 binding activation**、
per-run ownership 和 **fixed hierarchical admission**，然后才是有界并行、
Windows Job Object 和 dynamic scoring；Control API 与
DesignRevision/EvidenceBundle 再后，look-ahead controller 与 daemon 决策最后。

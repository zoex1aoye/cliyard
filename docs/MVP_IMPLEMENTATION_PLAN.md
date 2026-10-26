# cliyard MVP 实施计划

基于仓库代码与本机实测。**后续开发以 MVP 实践驱动**：先在本机跑通并扩展可运行切片，再按反馈调整方案；不以「阶段 B–H 愿景清单」为默认推进节奏。

> 历史：§1–§9 保留阶段 A 审查快照（对照早期 `main`）。§0 与 §10 为 **2026-10-26 macOS+Codex 实测后** 的现行工作约定。

---

## 0. 本机已验证（macOS + Codex）

**环境**：Darwin `arm64`，Node `v20.20.2`，无 `wsl.exe`；Codex `v0.163.0` + `deepseek-v4-pro` 可用。  
**Route C 裁决不变**：薄控制面为本机默认路径；Multica 仅作镜像对照，不接入运行时。  
**本机默认入口**：`npm test` + `npm run mock-loop`（非 `doctor`/`run`/`batch`）。

### 命令与结果（2026-10-26）

| 命令 | 结果 | 退出码 |
|------|------|--------|
| `npm install --registry https://registry.npmjs.org/` | 依赖就绪（tsx/typescript） | 0 |
| `npm test` | 4/4 通过（`core/status` 转换表） | 0 |
| `npm run mock-loop`（默认 `failVerifyTimes=1`） | implement → verify fail → repair → accept；写 `.cliyard/ledger.json` | 0 |
| `npm run mock-loop -- --fail-verify-times 0` | 一次 verify 即 `accepted` | 0 |
| `npm run mock-loop -- --fail-verify-times 3` | `maxRepairs=2` 耗尽 → `rejected` | **1**（预期） |
| `npx tsx src/cli.ts --help` | 打印含 `mock-loop` 的 usage | 1（usage 约定） |
| `npm run doctor` | `wslOk: false`，notes 提示须 Windows+WSL | **2**（预期） |
| `npm run batch -- examples/module.tasks.yaml --dry-run` | 仍走 `discover`/WSL，本机失败 | 非 0（预期） |
| `codex exec -m deepseek-v4-pro`（短探针） | 回复 `MVP_OK` | 0 |

### 已落地的 Route C 薄层（本机可跑）

```text
src/core/status.ts           # 九态 + 合法转换
src/contracts/schema.ts      # TaskContract validate + JSON 加载
src/agents/{types,mock}.ts   # AgentAdapter + Mock
src/verification/verifier.ts # Mock + optional shell verifier（--real-verify）
src/repair/loop.ts           # implement → verify → repair≤N → accept|reject
src/persistence/ledger.ts    # JSON 文件账本（.cliyard/ledger.json）
src/scheduler/{dag,mock-batch}.ts  # readyIds + multi-task mock scheduler
src/mock-loop.ts + cli mock-loop / mock-batch
examples/mock.contract.json · real-verify.contract.json · mock-batch.*.json
tests/*.test.ts
```

`wsl` / `discover` / `adapters` / `batch` **未改**；Windows 路径仍为第二轨。

### 实践反馈（据此排下一切片）

1. Mock 闭环与状态机在 Darwin 上已够用；M1–M6 后下一刀再看 SQLite / 真实 CLI。  
2. `doctor`/`batch` 在无 WSL 时不可用——本机勿假装测桥；文档与脚本入口须把 mock-loop / mock-batch 标成 Darwin MVP。  
3. Ledger 已是 JSON 文件（对齐 SCAFFOLD「先文件账本」）；**暂不引入 SQLite**，直到恢复场景逼出来。  
4. M5/M6 已落地：真 shell verify 为 opt-in；多任务 mock 调度尊重 `dependsOn`。

---

## 1. 当前模块结构及职责（阶段 A 快照）

> 下表反映审查时点；§0 已列出此后新增的 mock 控制面。

仓库为极薄 TypeScript 单体（审查时无 `tests/`；现已有 `tests/status.test.ts` + mock-loop）。

| 路径 | 职责 | 证据 |
|------|------|------|
| `src/cli.ts` | CLI 入口：`doctor` / `run` / `batch`；参数解析与进程退出码 | 命令枚举与 usage |
| `src/config.ts` | 加载 `config.yaml`（手写子集解析器）→ `HarnessConfig` | distro、workers、permission、worktree_dir、max_parallel |
| `src/types.ts` | 类型：`HarnessConfig`、`Capabilities`、`RunTaskInput/Result`、`TaskFile*` | **无** Run/Task 状态机、无 TaskContract、无 Event |
| `src/discover.ts` | WSL 内探测 `git` + `claude`/`codex`/`codebuddy`；`pickWorker` | `command -v`；无版本/能力矩阵 |
| `src/wsl.ts` | `wsl.exe -d … -- bash -lc <string>`；`shellQuote` | 超时 kill；**命令为字符串拼接** |
| `src/adapters.ts` | `buildWorkerCommand(worker, opts)` → 各 CLI 原生 flags（含 `--model`） | 纯命令构造，**无** 进程生命周期 / sessionId |
| `src/run.ts` | 单任务：discover → worktree add → 跑 CLI → `git diff --stat` | 基线为 `HEAD`；paths 仅进 prompt；无越界检查 |
| `src/batch.ts` | 任务队列 + `max_parallel` worker 池；全任务立刻可跑 | **无 DAG**、无依赖、无持久化 |
| `src/taskfile.ts` | 手写 YAML 子集 → `TaskFile`；`buildPrompt` 拼契约文件与 paths | 无 schema 校验；无 dependsOn / verify cmds |
| `config.example.yaml` / `examples/module.tasks.yaml` | 配置与示例契约雏形 | 人写 taskfile，非 Master 生成 |
| `docs/VISION.md` 等 | 愿景与试跑说明 | 与 MVP 目标对齐，但实现未跟上 |
| `package.json` | scripts：`doctor`/`run-task`/`batch`；**无 test 脚本** | 构建：`tsc` |

逻辑上可映射为：`agents/`≈discover+adapters，`workspace/`≈run 内嵌 git，`scheduler/`≈batch 极简版，`cli/`≈cli.ts。**尚无** core / planner / verification / integration / persistence / context / tests。

---

## 2. 功能清单：已实现 / 部分实现 / 未实现

对照 MVP「必须实现」10 条与方案正文。

### 已实现（可复用）

| 能力 | 现状 |
|------|------|
| Windows→WSL 执行桥 | `wslExec` |
| CLI 存在性探测 | `discover` + `doctor` |
| 单/多任务启动本机 CLI | `run` / `batch` + adapters（claude/codex/codebuddy） |
| 每任务独立 worktree + 分支 | `git worktree add -b cliyard/<id>` |
| 并发上限 | `max_parallel`（默认 2） |
| 任务级 model / permission / paths（提示） | taskfile + `buildPrompt` |
| 退出码 + diffstat + 日志尾 | `RunTaskResult` |
| dry-run | 不建 worktree、只打印命令 |

### 部分实现（需扩展，勿重写）

| 能力 | 缺口 |
|------|------|
| 「任务契约」 | 仅有 YAML 字段；**无版本冻结、无 JSON Schema、无验收命令、无禁止操作、无共享资源声明**；paths **只写进 prompt，不强制执行** |
| 「调度」 | 平面队列并行；**无 dependsOn / DAG / ready 门闩 / 资源预约** |
| 「Adapter」 | 仅命令字符串；**无 session、cancel、结构化 collect、能力声明对象** |
| 「Worktree 生命周期」 | 只 create+run；**无统一清理策略、无基线 commit 记录、无「未提交不得丢弃」、无越界 diff 校验** |
| 「上下文」 | contract_files 路径列表；**无项目结构摘要、无 AGENTS.md 装载、无前置任务成果注入、无版本校验** |
| 「进程管理」 | 有超时 reject；**无 cancel 命令、无异常分类、无日志落盘路径持久化、字符串 shell 有注入/转义风险** |
| 「CLI UX」 | doctor/run/batch；**无 plan/status/inspect/verify/retry/cancel/integrate/recover** |

### 未实现（需新增）

| 能力 | 说明 |
|------|------|
| Master Planner | 无 LLM 调用、无计划 JSON、无确定性校验器 |
| Task/Run 状态机 | 无 `draft…accepted` 枚举与合法转换 |
| SQLite + Event | 无持久化、无恢复 |
| Independent Verifier | 无构建/测试重跑；exitCode===0 即「结束」≠ accepted |
| Repair 循环 | 无 |
| Integration Queue | 无集成分支、无串行合并、无冲突停机 |
| 共享资源串行 / 陈旧基线检测 | 无 |
| 路径越界拒绝验收 | 无 |
| 测试体系 | **零测试文件**；无 Mock Adapter |
| Project 模型 | 无 build/test commands 登记 |

---

## 3. 现有模块 ↔ 目标架构映射

| 目标逻辑模块 | 现有落点 | MVP 策略 |
|--------------|----------|----------|
| `core/` | `types.ts` 碎片 | **新增** `src/core/`（status、errors、events）；扩展而非替换 types |
| `planner/` | 无（人写 taskfile） | **新增**；输出兼容/升级后的 TaskContract |
| `scheduler/` | `batch.ts` | **重构扩展** batch → DAG scheduler；保留 max_parallel |
| `agents/` | `discover.ts` + `adapters.ts` | **接口化** Adapter；discover 扩能力字段；保留三家命令映射 |
| `workspace/` | `run.ts` 内联 git | **抽出** worktree 模块；run 变为调用方 |
| `context/` | `buildPrompt` | **新增** 轻量组装；复用 contract_files |
| `verification/` | 无（仅 diffstat） | **新增**；与 worker 进程分离 |
| `integration/` | 无 | **新增** |
| `persistence/` | 无 | **新增** SQLite |
| `cli/` | `cli.ts` | **扩展** 子命令；保持 doctor/run/batch 兼容或薄封装 |
| `tests/` | 无 | **新增**；Mock Adapter 优先 |

原则：**复用优先**——不引入 LangGraph/完整 Agent 框架；不 fork JetBrains；不重写 WSL 桥。

---

## 4. 需要修改的文件及原因

| 文件 | 修改原因 |
|------|----------|
| `src/types.ts` | 增加 Run/Task/TaskContract/Event/Status；保留旧 TaskFile 作导入/兼容层 |
| `src/adapters.ts` | 改为 `AgentAdapter` 接口；`buildWorkerCommand` 降为实现细节；补 cancel/超时/日志路径 |
| `src/discover.ts` | 返回更富 `Capability`（version 可选、nonInteractive、supportsModelFlag） |
| `src/wsl.ts` | 增加更安全的执行 API（优先 argv 数组 + `wsl.exe … -- cmd args`）；保留 `shellQuote` 兼容层 |
| `src/run.ts` | 拆出 workspace；记录 `baseCommit`；调用 verifier 钩子（阶段 E 接线） |
| `src/batch.ts` | 演进为 scheduler 入口或薄包装「无依赖时退化为现逻辑」 |
| `src/taskfile.ts` | 升级 schema（dependsOn、verify、sharedResources）；或 JSON 契约为主、YAML 为糖 |
| `src/cli.ts` | 增加 plan/status/inspect/verify/retry/cancel/integrate/recover |
| `src/config.ts` | Project 默认分支、integrationBranch、sqlite 路径、repair 上限、Master provider |
| `package.json` | 加 `better-sqlite3` 或 `node:sqlite`、测试 runner（`node:test` 或 vitest）、`test`/`test:integration` scripts |
| `README.md` / `docs/VISION.md` | 阶段 H 同步；VISION §7 与本计划交叉链接 |
| `.gitignore` | 忽略 `.cliyard/data/*.db`、run artifacts（若落在仓内） |

---

## 5. 需要新增的模块及接口（最小集）

目录建议在现有 `src/` 下渐进增加（不必一次建齐空壳）：

```text
src/core/status.ts          # TaskStatus 枚举 + 合法转换表
src/core/errors.ts
src/core/events.ts          # EventType + append helper 签名
src/persistence/db.ts       # SQLite open/migrate
src/persistence/store.ts    # Run/Task/Contract/Event CRUD（事务内写状态+事件）
src/contracts/schema.ts     # TaskContract JSON Schema + validate()
src/contracts/fromTaskfile.ts  # TaskFile → TaskContract[] 适配（复用现 YAML）
src/workspace/worktree.ts   # create/inspect/diffPaths/cleanupPolicy
src/agents/types.ts         # AgentAdapter 接口
src/agents/mock.ts          # Mock Adapter（测试）
src/agents/codebuddy.ts …   # 包装现有 buildWorkerCommand
src/scheduler/dag.ts        # 环检测、ready 集合
src/scheduler/scheduler.ts  # 派发、租约、恢复入口
src/verification/verifier.ts
src/integration/queue.ts
src/planner/planner.ts      # LLM 调用 + 确定性校验（阶段 G）
src/context/assemble.ts     # 按 task 组装 briefing
tests/…                     # 单元 + 集成（temp git + mock）
```

### 关键接口草图（实现时可微调）

```ts
interface AgentAdapter {
  id: WorkerId | "mock";
  discover(): Promise<AgentCapability>;
  start(input: AgentStartInput): Promise<{ sessionId: string }>;
  getStatus(sessionId: string): Promise<"running" | "exited" | "unknown">;
  collect(sessionId: string): Promise<AgentResult>;
  cancel(sessionId: string): Promise<void>;
}

interface TaskContract {
  taskId: string;
  version: number;
  frozen: boolean;
  goals: string[];
  nonGoals?: string[];
  dependsOn: string[];
  readPaths: string[];
  writePaths: string[];
  sharedResources: string[]; // 互斥键，如 "db:migrations"
  baseCommit: string;
  verifyCommands: string[];
  deliverables?: string[];
  forbidden?: string[];
  maxRepairs: number;
}
```

状态枚举采用方案建议：  
`draft | ready | running | verifying | repairing | accepted | blocked | rejected | cancelled`  
（与 VISION 中 `needs_human` 对齐：可用 `blocked` + reason 码，或增补枚举值——**建议阶段 B 定稿时二选一写死**。）

---

## 6. 技术风险、兼容性与测试方案

### 风险

| 风险 | 影响 | 缓解 |
|------|------|------|
| `bash -lc` 字符串命令 | 注入/转义错误 | 逐步改为 argv；prompt 走文件/`--system-prompt-file` 减少巨参 |
| 手写 YAML 解析脆弱 | 契约升级易碎 | 契约主存 JSON；YAML 仅导入；加 schema 测试 |
| 真实 CLI 不稳定/要额度 | CI 无法跑 E2E | **Mock Adapter 为默认测试路径**；真实 CLI 标 `optional` |
| WSL 仅 Windows 可测桥 | 本机 mac 开发测不全 | 单元测不依赖 WSL；集成测用 mock exec；可选 GitHub Windows runner |
| better-sqlite3 原生编译 | Windows/WSL Node 差异 | 优先评估 Node 22+ `node:sqlite`；或纯 JS `sql.js` 作后备 |
| CodeBuddy `-p` 强依赖 skip-permissions | 安全边界 | 契约 + 越界检查 + 仅操作 cliyard 分支；文档强调风险 |
| 并行同账号限流 | 假失败 | scheduler 按 agent 配额；blocked 区分 rate-limit |
| 无基线/越界检查时「成功」误导 | 质量假象 | 阶段 D/E 前不宣称 accepted |

### 兼容性

- 保留 `cliyard doctor|run|batch`：batch 在「无 dependsOn」时可走旧并行语义。  
- `examples/module.tasks.yaml` 经适配器升级为 Contract（缺字段填默认：`dependsOn=[]`，`verifyCommands` 可空→验收仅路径+exit）。  
- 不强制 Docker；不绑单厂商私有 API。

### 测试方案（对应方案 §14）

1. **单元**：DAG 环、状态转换、路径越界、repair 上限、契约 schema、资源预约。  
2. **集成**：临时 git 仓 + Mock Adapter（成功/失败/超时/崩溃/争用文件/合并冲突/中途「重启」恢复）。  
3. **E2E（可选）**：小多模块仓 + 真实 CLI，单独 `npm run test:e2e:real`。  
4. **回归**：现有 `tsc --noEmit`；阶段 B 起 `npm test` 必须绿。

---

## 7. 按依赖排序的开发任务（对齐阶段 B–H）

与方案 §16 一致，细化为可勾选任务：

### 阶段 B — 核心模型与持久化

1. 定稿 `TaskStatus` + 转换表 + failure reason 码。  
2. `TaskContract` schema + validate。  
3. SQLite schema（runs/tasks/deps/contracts/events/verifications）+ 迁移。  
4. Store：事务内「改状态 + 写事件」。  
5. 单元测试覆盖 B。  
6. **不**接真实 LLM / 不改 batch 行为（可只加库）。

### 阶段 C — 调度与 Adapter

1. `AgentAdapter` 接口；Mock Adapter。  
2. 将 claude/codex/codebuddy 迁入 adapter（复用 `buildWorkerCommand`）。  
3. DAG ready 计算；scheduler 循环；并发与「同 task 不双派」。  
4. session 元数据入库；超时/cancel API。  
5. `batch` 改为「加载契约 → 写入 Run → scheduler」或保留旧入口调新核。  
6. 集成测试：两 Mock 并行。

### 阶段 D — Worktree 与写入控制

1. 抽出 `workspace/worktree.ts`；记录 `baseCommit`。  
2. diff 路径 ⊆ `writePaths` 检查。  
3. `sharedResources` 互斥预约。  
4. 陈旧基线：集成前/验收前对比。  
5. 清理策略：未提交变更不自动 discard。

### 阶段 E — Verifier 与修复

1. Verifier 跑 `verifyCommands`；写 verification 记录（含 commit/hash）。  
2. Worker 成功 ≠ accepted。  
3. `verifying → repairing → verifying`，`maxRepairs`。  
4. 环境类失败 → `blocked`。  
5. 代码变更使旧 verification 失效。

### 阶段 F — Integration Queue

1. 串行合并到 `integrationBranch`（配置项）。  
2. 依赖序；冲突停机保留现场。  
3. 合并后复验；通过才允许推到 test branch 门禁。  
4. 禁止 force-push / 动用户主工作区。

### 阶段 G — Master Planner 与 CLI 闭环

1. 可配置 Master（API 或本机某 CLI `-p` JSON）。  
2. 计划确定性校验（方案 §5）。  
3. 默认人工 `plan` 确认后 `run`。  
4. CLI：status/inspect/verify/retry/cancel/integrate/recover。

### 阶段 H — 端到端与文档

1. fixture 多模块仓演示。  
2. 更新 README；链接本计划与 VISION。  
3. 对照方案 §15 验收清单逐项打勾。

---

## 8. 关键设计决策（请确认）

以下决策影响阶段 B 起的接口形状；**请确认或改定后再开 B**。

| # | 决策 | 建议 | 理由 |
|---|------|------|------|
| D1 | 布局 | **渐进加 `src/<area>/`，不一次性微服务/大搬家** | 复用现有文件；diff 可读 |
| D2 | 契约格式 | **SQLite 存 JSON Contract；YAML taskfile 仅作导入** | 手写 YAML 解析已脆；schema 更好测 |
| D3 | 状态枚举 | 采用方案九态；**`needs_human` 映射为 `blocked` + reason=`needs_human`** | 少枚举分叉；查询简单 |
| D4 | SQLite | 优先 **`node:sqlite`（Node≥22）**，否则 `better-sqlite3` | 少原生编译痛；Windows+WSL 友好 |
| D5 | 执行桥 | 保留 WSL 为默认；Adapter 内藏 `wslExec`；**新增安全 argv API，旧字符串 API 标 deprecated** | 不打断现 doctor/run |
| D6 | paths 强制 | **验收阶段硬校验 diff⊆writePaths**；运行中靠 briefing（MVP 不做文件系统 ban） | 实现成本低；与「独立 Verifier」一致 |
| D7 | 旧 `batch` | **保留命令**；内部改走「无依赖 DAG」路径，行为对用户近似 | 明天试跑脚本不立刻作废 |
| D8 | Master 位置 | **阶段 G 再接 LLM**；B–F 用夹具/人手 Contract 驱动 | 先把确定性内核做对 |
| D9 | 测试 runner | **`node:test` + tsx`**，零额外框架（可再议 vitest） | 依赖最少 |
| D10 | 集成目标 | 默认只写 `cliyard/integrate/<runId>` 类分支；**动用户 defaultBranch 需显式确认** | 保护用户工作区 |

### 最小改动原则（执行约束）

1. 能复用的模块（WSL、discover、adapters 命令映射、worktree add、max_parallel）必须复用。  
2. LLM 不拥有调度/权限/验收控制权。  
3. 每阶段必须带测试；未跑测不得宣称通过。  
4. 不引入大型 Agent 编排框架；不把 JetBrains/AST 合并列入 MVP。

---

## 9. 阶段 A 结论（历史）

审查时点仓库是 **可用的「发现 + worktree + 多 CLI 并行发射器」**。此后 §0 已在 Darwin 落地契约/状态机/Mock 闭环/JSON 账本；缺口变为：**briefing、DAG、真实 verifier shell、worktree 强制、Windows 桥实测**。

~~推荐路径：按 B→H 等待确认后开 B。~~ → 见 **§10**（MVP 实践切片）。

---

## 10. 现行约定：MVP 实践切片（取代「等阶段 B」）

**原则**：每一刀必须本机可跑（`npm test` 和/或 `npm run mock-loop` / 新 CLI）；跑通再调计划。Route C 不变；**Master 壳 = DeepSeek Harness**；Multica 不进依赖。用户故事：[USER_STORY_STEP1.md](./USER_STORY_STEP1.md)。

### 已完成切片（M1–M6）

| # | 切片 | 状态 |
|---|------|------|
| M1–M4 | 闭环单测 / TaskFile→Contract / briefing / DAG | **done** |
| M5 | 可选 shell verify（`--real-verify`） | **done** |
| M6 | 多任务 mock 调度 + ledger | **done** — ready 集 **并行** |

### 下一步切片（DSH Master）

| # | 切片 | 验收 | 状态 |
|---|------|------|------|
| S1 | `plugins/dsh-cliyard`：dispatch → `mock-batch`；监控读 ledger | 插件 README + `npm run master-dispatch` / `master-monitor` | **done**（本机可无 DSH 演示；`dsh plugin add link:…` 可选） |
| S2 | Codex CLI worker + 双 worktree 并行隔离 | `npm run codex-batch` + fixture；ledger 可见 | **done**（需本机 `codex`） |
| S2.5 | Plan → Contract → dispatch bridge；DSH agent tool | `npm run plan-dispatch` + 兄弟仓工具测试；overlap/path/graph 负例 | **done**（结构化 Plan 由 DSH 模型生成） |
| S2.6 | Claude Code + DeepSeek Worker | `claude-ds` probe + `npm run claude-batch` 真实临时仓 accepted | **done**（Claude Code 2.1.185 / `deepseek-flash[1m]`） |
| S3 | Windows + CodeBuddy 真连 | doctor / run / batch | **deferred** |

默认继续 JSON ledger；不做 SQLite，直到恢复场景逼出。

**实践微调**

- Master：**DSH GUI**，非 Cursor。Cursor/Codex 可开发本仓。
- 并行隔离：**cliyard worktree + paths**，不以 DSH Jobs 冒充。
- M6：同一 ready 波次 `Promise.all` 并行；ledger 写带锁。
- `npm test` 覆盖 status / loop / fromTaskfile / assemble / dag / verifier-shell / mock-batch / ledger-lock / codex-adapter（dry）/ Plan bridge / 真实 Git diff 路径门禁。
- Plan bridge 是唯一新的一站式入口：结构化 Plan → 冻结契约文件 → 可选 worktree dispatch；控制面拒绝重叠写路径。
- `codex-batch` 在创建 worktree 前解析真实 base commit 并做 DAG/路径预检；Codex 完成后按 Git diff 取真实 touched paths。
- 当前 `dependsOn` 只提供启动顺序，不自动把上游 worktree diff 带入下游；真实依赖模块仍需独立 integration 切片。

### 明确推迟到 Windows + WSL + CodeBuddy

- `cliyard doctor` 真实 ping / worker 探测  
- `run` / `batch` 真实 WSL worktree + CodeBuddy  
- CodeBuddy 同账号并行与 permission 边界  
- Multica 对照试跑（若仍需要）  
- 多模块真实仓 E2E  

### 与旧阶段 B–H 的关系

§7 的 B–H 仍作 **能力地图**。映射：M1–M6 ≈ 控制面核；S1–S2 ≈ 原 G「薄 Master」的 DSH 版；原 D/F/H 等 Windows 或 S3。

D1–D10（§8）仍有效：**D4 SQLite 延后**；**D5 WSL 默认仅 Windows**；**D8 Master = DSH + 插件**（不再等「阶段 G 再接 LLM」空窗）。

---

*现行入口：§0 实测 + §10 切片。改计划先改本节，勿先写大阶段。*

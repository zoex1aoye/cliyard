# 从 OSS 搭骨架：Codex spike 内的选型与 1–2 周落地计划

> 配套：[VISION.md](./VISION.md)、[MVP_IMPLEMENTATION_PLAN.md](./MVP_IMPLEMENTATION_PLAN.md)、[OSS_LANDSCAPE.md](./OSS_LANDSCAPE.md)。
> 本文只新增设计文档，不改应用代码。

## 1. spike 环境声明：就是 Codex（DeepSeek via Codex）

本次研究/验证的运行环境就是本会话的 Codex：DeepSeek 经 Codex 驱动，运行在 macOS（`Darwin`），没有 `wsl.exe`，也不要求 Windows+WSL 或 CodeBuddy 先跑。

这带来两个直接后果，后文全部按此安排：

1. 现有 `src/wsl.ts` 的 `wsl.exe` 执行桥在本机无法真实调用；`discover()` 会走到 "wsl ping failed" 的注释分支。spike 阶段只验证控制面逻辑，执行桥用 stub/mock，不假装已测过真实桥。
2. 真实 Windows→WSL 桥、真实 CodeBuddy 派发、真实仓库 worktree、同账号并行配额，这几项只能留到回 Windows 环境后验证，在本文第 5 节单独列为「later」。

spike 的机器事实：`uname -s` = `Darwin`，`wsl.exe` 不存在，Node `v20.20.2`。因此本阶段所有「执行」都以 `--dry-run` 或 mock 为准；能跑的是类型、schema、状态机、闭环脚本这些确定性部分。

## 2. 主推荐：Route C（cliyard 薄控制面）

三条路线（A=采用 Multica；C=cliyard 薄控制面；B=演进为完整编排器）里，主推荐是 **C**，A 作为对照试跑，B 作为「C 不够、A 又不合适」时的后备。

理由：

- C 与 VISION 的「清醒 Master → 可证伪验收」完全同构：Master 只派发/校准/裁决，状态在磁盘，不把全过程塞进上下文。
- C 能直接复用仓库里已经跑通的四块：`src/wsl.ts`（执行桥）、`src/discover.ts`（能力发现）、`src/adapters.ts`（CLI 命令映射）、`src/batch.ts`（并行发射器）。
- C 用自有许可证（README 计划 Apache-2.0），不背 Multica License 的托管/商业附加条款；也不引入 Go + Next + PostgreSQL 的部署重量。
- 我们的差异化在「工程上下文 + 本地验收协议」，这块天然属于 C，而不是某个现成看板。

1 天 Codex spike 后，按以下标准做最终裁决：

| 标准 | 若成立 | 结论 |
|------|--------|------|
| Multica 真实支持 CodeBuddy（文档列出，须实测） | 否 | A 出局，转 C |
| Multica License 附加条款可接受 | 否 | A 出局，转 C |
| 愿意承担 PG + Docker 自托管重量 | 否 | A 出局，转 C |
| Codex/Cursor 能借 multica-cli skill 继续当 Master | 否 | A 不满足「Cursor 当 Master」，转 C |
| 我们仍要自己的工程上下文 + 本地验收协议 | 是 | 无论如何都保留 C |
| C 的控制面被证明要长成完整 DAG/集成队列且不值得自养 | 是 | 才考虑 B |

一句话：**用 Multica 当镜子，把它的 run/task/retry/timeout 语义学进 C，而不是把 Multica 整个接进来。**

1 天 Codex spike 建议产出四样东西，其中前三样本会话内可完成：

1. 一份 A/C 差距表：CodeBuddy 匹配、Cursor 当 Master、状态/日志、部署重量、许可证、工程认知深度六列。
2. 一份 `TaskContract` 字段草案（第 4 节），配套 JSON Schema。
3. 一个用 Mock Adapter + 临时 git 仓跑通的最小闭环脚本。
4. 一份裁决记录：把上面的表格逐项打勾，写下最终选 C 还是 A。

## 3. 1–2 周骨架：学什么、不重建什么

### 3.1 从 Multica trial 学

- run/task/status 数据模型：task → run → verdict，retry 上限、timeout、run log 尾巴。
- 看板里「审核中 / 通过 / 打回」的人审门槛，对应 VISION 的 `accept | reject | needs_human`。
- `multica-cli` 的「薄驱动 skill」形态：Master 只发指令，不自写业务代码。
- 落地映射：`task{id,status}` / `run{id,worker,model,exitCode,diffStat,logTail}` / `verdict{accepted,rejected,needs_human}`；retry 上限与 timeout 直接进契约。

### 3.2 从 Cezar YAML 学

- 最小闭环：`implement` → `verify`（一条命令）→ `onFail: retry`，失败回退而不是长聊。
- 状态落在文件（`.ai/cezar/`），无 DB——先照做，用 JSON 文件账本，暂不引 SQLite。
- worktree 隔离 + Autonomous 模式 + 人工审核门槛。
- 注意：Cezar 未列 CodeBuddy，只学它的闭环，不整包替换我们的调用链。
- onFail 语义收窄成三档：`retry`（≤ maxRepairs）、`stop`、`human`；`stop` 即 VISION 的 `rejected`，`human` 即 `needs_human`。

### 3.3 从 ai-orchestrator 学

- chair 不写功能，只派工并 fold briefing 文件；与「状态出聊天」同构。
- briefing/queue 文件约定：每轮只喂短摘要，新会话 + 自包含 resume pack。
- 几乎零平台成本，直接抄字段与文件命名。
- briefing 文件最小形状：`briefing/<taskId>.md` = 目标 + 边界（read/write paths）+ 验收命令 + 上轮 verdict 摘要；新会话只读这一份，不重放全程对话。

### 3.4 cliyard 明确不重建

- `src/wsl.ts`：执行桥继续当默认；只在内部做 argv 化，不重写。
- `src/discover.ts`：能力发现继续用，只给 `Capability` 加 `version` / `supportsModelFlag`。
- `src/adapters.ts`：`buildWorkerCommand` 保留为适配器实现细节，不外发重写。
- `src/batch.ts`：无依赖时退化为现有并行语义，不推倒。
- `src/taskfile.ts`：YAML 继续当导入糖，`TaskFile → TaskContract` 适配。
- 不重建：完整 Agent 框架、JetBrains PSI / tree-sitter 语义层、Docker 编排、GUI/聊天窗、PostgreSQL 后端、CodeBuddy 权限系统。

### 3.5 两周节奏（1–2 周骨架）

- 第 1 周：通读 Multica/Cezar/ai-orchestrator → 定 `TaskContract` + 状态机 → Mock Adapter 跑通「contract → run → verify」。
- 第 2 周：补 `repair ≤ N` 循环、JSON 文件账本、briefing 组装；`batch` 在无 `dependsOn` 时退化为现有并行语义，不改行为。
- 第 2 周末：对照第 5 节「later」清单，把需要 Windows 的部分显式挂起，不在 Codex 环境硬测。

## 4. 最小 Route-C 文件布局（复用既有模块）

```text
src/
  cli.ts                 # 复用：新增 plan/status/verify/retry 子命令入口
  config.ts              # 复用：加 ledger 路径 / repair 上限 / 集成分支
  types.ts               # 扩展：TaskContract / TaskStatus / Event，保留 TaskFile
  wsl.ts                 # 复用：默认执行桥；只收敛注入/转义
  discover.ts            # 复用：Capability 增 version / supportsModelFlag
  adapters.ts            # 复用：buildWorkerCommand 外包为 AgentAdapter
  run.ts                 # 复用：单任务 worktree add + 执行 + diffstat
  batch.ts               # 复用：无 dependsOn 时走旧并行路径
  taskfile.ts            # 复用：TaskFile → TaskContract 适配入口
  core/status.ts         # 新增：状态枚举 + 合法转换表
  contracts/schema.ts    # 新增：TaskContract JSON Schema + validate()
  context/assemble.ts    # 新增：自包含 briefing（借 ai-orchestrator）
  verification/verifier.ts # 新增：verifyCommands 独立重跑
  repair/loop.ts         # 新增：verify → repair ≤ maxRepairs
  persistence/ledger.ts  # 新增：JSON 文件账本（先无 DB）
  workspace/worktree.ts  # 抽出：baseCommit + diff⊆writePaths
tests/
  mock-adapter.test.ts   # Mock Adapter 驱动全链路（不碰真实 CLI）
  status.test.ts
  contract.test.ts
```

复用原则：`wsl/discover/adapters/batch` 四个模块继续当脊梁，新目录只挂「契约 + 验收 + 修复 + 账本 + briefing」五个薄层；`src/run.ts` 里 `git worktree add -b cliyard/<id>` 的现有逻辑原样保留。

关键接口草图（与 MVP_IMPLEMENTATION_PLAN §5 对齐，实现时可微调）：

```ts
interface TaskContract {
  taskId: string;
  version: number;
  frozen: boolean;
  goals: string[];
  nonGoals?: string[];
  dependsOn: string[];
  readPaths: string[];
  writePaths: string[];
  sharedResources: string[];   // 互斥键，如 "db:migrations"
  baseCommit: string;
  verifyCommands: string[];
  forbidden?: string[];
  maxRepairs: number;
}

interface AgentAdapter {
  id: WorkerId | "mock";
  discover(): Promise<AgentCapability>;
  start(input: AgentStartInput): Promise<{ sessionId: string }>;
  collect(sessionId: string): Promise<AgentResult>;
  cancel(sessionId: string): Promise<void>;
}
```

`src/adapters.ts` 的 `buildWorkerCommand` 降为 `start` 的实现细节，三家命令映射原样保留；`src/discover.ts` 的 `pickWorker` 原样保留，只扩充 `Capability` 字段。

## 5. Multica spike 清单（Codex 现在能做的 / 留到 Windows+CodeBuddy 的）

### 现在（本 Codex / macOS 会话内）

- [x] 通读 Multica README 与 LICENSE，记录 run/task/retry/timeout 数据模型。（见 OSS_LANDSCAPE）
- [ ] 核对 multica-cli skill 如何让 Codex/Claude/Cursor 当 Master。
- [ ] 在本地（无 Windows 依赖）试跑 Multica（如可行），确认 CodeBuddy 是真实支持还是仅文档列出。
- [x] 抽取 Cezar 的 implement→verify→onFail retry 最小字段，落成 `TaskContract`（`src/contracts/schema.ts` + `examples/mock.contract.json`）。
- [ ] 抽取 ai-orchestrator 的 briefing/queue 文件约定（下一刀：assemble briefing）。
- [x] 写裁决记录：主推 Route C；Multica 作镜像。（见本文 §2）
- [x] Mock Adapter 闭环：`npm run mock-loop`（contract → implement → verify → repair≤N）；本机 2026-10-26 已绿。尚缺 TaskFile→Contract 与真 git worktree。
- [ ] 记录 multica-cli 的入参/出参 JSON 形态，评估能否把 Codex/Cursor 接成 Master 的驱动。
- [x] `verify` + onFail 语义进 `contracts/schema.ts` + `repair/loop.ts`；状态机单测已有；闭环单测待补（MVP §10 M1）。

### 稍后（必须回 Windows+WSL+CodeBuddy）

- [ ] `cliyard doctor` 真实 WSL ping 与 CodeBuddy 探测（本机无 `wsl.exe`）。
- [ ] 真实仓库 worktree add + CodeBuddy 同账号并行，含配额与 `--dangerously-skip-permissions` 边界。
- [ ] Multica 与 CodeBuddy 真实连线（仅当 A 进入试跑）。
- [ ] 真实多模块样例（Spring Boot 跨模块 + DTO + 测试）多路并行 + 人看 diff 验收。

## 6. 非目标

- 不改写现有应用代码；本文只新增文档。
- 不在 Codex 环境硬跑 Windows+WSL 桥；用 stub/mock，真实桥留到 Windows。
- 不在本 spike 内接 JetBrains PSI / tree-sitter 语义验收。
- 不把 PostgreSQL/Docker 变成硬依赖。
- 不实现完整 Agent 框架、GUI 或聊天窗。
- 不做自动完美合入，未经确认不动用户 `defaultBranch`。
- 不整包复制 Multica 后端，只采纳其状态/重试/超时语义。
- 不把调度/权限/验收控制权交给 LLM（LLM 只当 planner 咨询，不做裁决器）。

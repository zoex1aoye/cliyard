# AGENTS.md — cliyard 工程协作入口

> 本文件回答“这个仓库是什么、真相在哪里、任务该走哪条流程”。
> 常驻纪律在 `.agents/rules/`，任务 SOP 在 `.agents/skills/`。
> `.cursor/rules` 与 `.cursor/skills` 只是指向同一份源的软链接。

## 1. 项目身份

cliyard 不是另一个 coding agent，也不是以聊天会话为真相的 GUI。

它是一个 **Design-to-Evidence Delivery Control Plane**：

```text
人的设计与取舍
  → 已审阅 Plan
  → 冻结 TaskContract
  → 能力匹配、准入与隔离执行
  → 独立验收证据
  → 人工审查 diff / 合入
  → 可恢复的下一步
```

Codex、Claude Code、Qwen Code、OpenCode、CodeBuddy 等是可替换 Worker；
DSH、WorkBuddy 或未来自有 Web UI 是可替换人机入口；cliyard 负责设计版本、
契约、队列、运行身份、证据、裁决和集成边界。

回复默认使用中文。代码、命令、标识符和已采用英文撰写的证据文档保留原文。

## 2. 真相分层

| 层 | 权威内容 | 当前落点 |
|---|---|---|
| 设计真相 | 目标、视觉/接口约束、non-goals、验收矩阵 | Git 中的 `design/`、`docs/` 与目标项目设计文件 |
| 任务意图 | 人已审阅的 Plan | 版本化 `.plan.json` 与配套设计说明 |
| 执行契约 | `TaskContract` | 冻结 JSON；旧任务还可能引用 Plan SHA-256 |
| 调度协调 | queue item、attempt、run binding | `.cliyard/queue.json`、`.cliyard/queue-events/` |
| 任务权威 | `RunManifest` 与各 task 的 accepted/rejected 状态 | `.cliyard/runs/<runId>.json` |
| 观测信号 | worker progress、heartbeat、lease、cost | `.cliyard/worker-events/`、`worker-leases/`、RunManifest |
| 代码真相 | base、branch、diff、artifact/integration commit | Git |
| 验收真相 | 测试、路径审计、运行态、截图、偏差、verdict | RunManifest、RuntimeManifest、证据文档 |

聊天、prompt、终端输出、progress heartbeat 都不是任务完成证明。

## 3. 默认认知

- **Plan-first**：详细设计先整理成可审阅 Plan；Plan 未获人确认，不冻结契约、不派发。
- **Contract-first**：Worker 只能执行冻结契约；契约变更产生新版本、新 hash 和新审查。
- **Human-owned irreversible decisions**：Plan 批准、契约冻结、合入、推送、历史改写均不能由 Agent 自行决定。
- **Evidence over claims**：Worker 自报完成无效；验收证据必须绑定精确代码状态。
- **Replaceable execution**：按运行时、模型、能力、可用性、额度和历史证据路由；不绑定单一 CLI 或订阅。
- **Recoverable project**：模型、Worker、Supervisor 或 GUI 可以退出，磁盘上的设计、任务、租约、证据和裁决不能丢。
- **Current implementation is narrower than the target**：当前 Supervisor 是前台运行、单仓库锁；queue 顺序派发；
  没有 daemon、无限并行、自动 Plan 批准、自动合入 `main`、跨宿主恢复或 Windows Job Object 等价能力。

## 4. 任务路由

| 要做的事 | 先读 |
|---|---|
| 把需求/设计拆成 Plan | `.agents/skills/cliyard-design-to-plan/SKILL.md` |
| 审阅并冻结 Plan 为契约 | `.agents/skills/cliyard-contract-freeze/SKILL.md` |
| 为 CLI + model 选择执行 profile | `.agents/skills/cliyard-execution-routing/SKILL.md` |
| 设计或运行需要服务的验收 | `.agents/skills/cliyard-runtime-verification/SKILL.md` |
| 审 diff、证据和裁决 | `.agents/skills/cliyard-acceptance-review/SKILL.md` |
| 用 cliyard 迭代 cliyard | `.agents/skills/cliyard-self-host-iteration/SKILL.md` |
| 判断权限、真相与不可逆边界 | `.agents/rules/control-plane-authority.mdc` |
| 改动文件、进程、端口或运行态 | `.agents/rules/execution-safety.mdc` |
| 设计并行、路由或准入 | `.agents/rules/parallel-routing-admission.mdc` |
| 判断 accepted / rejected / needs_human | `.agents/rules/evidence-acceptance.mdc` |
| 提交、分支、worktree、自举来源 | `.agents/rules/git-selfhost.mdc` |

`.mdc` 规则不保证被所有 harness 自动加载；进入相关工作前必须按上表显式读取。

## 5. 红线

1. **不跳过 Plan**：不能用一段聊天 prompt 直接替代 Plan；Plan 要说明目标、边界、验收和不做什么。
2. **不擅自冻结或派发**：Plan → Contract 必须经过人的明确确认；派发前确认 base commit、write paths、runtime 和证据要求。
3. **不只杀父进程**：进程回收必须使用持久化的精确 `pid + pgid + OS start identity`；身份不明时 `needs_human`，
   禁止按进程名、端口或模糊匹配大面积 kill。
4. **不共享运行现场**：并行验收不能共用默认端口、数据目录、数据库、浏览器 profile 或未隔离的 service。
5. **不隐藏未知**：provider 并发、quota、balance、pricing、运行槽位未知时明确写 `unknown/null`；
   未知 ExecutionProfile 从 1 个 in-flight probe 开始，`3` 只是 warm start，不是永久上限。
6. **不把检测说成预防**：WorkspaceBoundary 当前是运行前后 protected-root 完整性检查，不是 OS sandbox，也不隔离凭据和网络。
7. **不删除不确定归属的数据**：path overshoot、孤儿进程、dirty attempt 和 worktree 都先保留证据；清理必须精确、可审计。
8. **不自动执行不可逆动作**：没有用户明确指令，不 commit、不 push、不 merge、不改写共享历史、不关闭或修改用户改动。
9. **不夸大完成度**：必须区分已实现、已测量、仅检测、设计目标、已知缺口和未验证项。
10. **保持 Node 20 基线**：当前 `engines.node = >=20`；Node 22、`--permission`、SRT 等只在用户明确批准后试验。
11. **工具迭代工具必须用对来源**：用 cliyard 改 cliyard 时，从最新已验收 integration worktree 启动控制面，
    目标仓库仍是主 checkout；任务分支里的新代码不能声称已在同一次 run 中自举验证。
12. **保留人工合入门**：accepted 表示证据足以进入人工审查，不等于自动合入；worktree 默认保留到 diff 审完。

## 6. 当前安全与能力事实

截至 2026-10-28：

- WorkspaceBoundary v1 已验收但尚未合入当前主分支；它是 fail-closed 检测层。
- WorkerProcessTree v1.1 已验收但尚未合入；它覆盖 live/sampled nested descendants，不覆盖 controller death 后已脱钩的 nested group。
- 最高优先级仍未闭环项：controller-death nested process ownership、OS write prevention 的
  provider-neutral `SandboxProvider`、ProfileCatalog/真实 binding activation、per-run ownership 与分层 admission、
  版本化 Control API/event stream。
- 完整事实、分支和验证计数只以 [KNOWN_GAPS_2026-10-28.md](docs/KNOWN_GAPS_2026-10-28.md)
  与相关 evidence 为准；不要把本节的摘要当作动态状态缓存。

## 7. 常用验证

```bash
git status --short --branch
node --version
npm run build
npm test
```

只改 `.agents/`、`AGENTS.md`、软链接或说明文档时，不把 Skill 校验冒充产品构建或视觉验收；
仍应验证 frontmatter、目录名、引用路径、软链接目标和 Git diff。

## 8. 目录映射

```text
cliyard/
├── AGENTS.md
├── .agents/
│   ├── rules/       # 常驻纪律、权限、安全、证据边界
│   └── skills/      # 可复用任务 SOP
├── .cursor/
│   ├── rules   -> ../.agents/rules
│   └── skills  -> ../.agents/skills
├── design/          # Plan、设计说明、冻结 contracts
├── docs/            # 产品、架构、缺口、操作与 evidence
├── src/             # 控制面实现
└── tests/           # 可执行约束与回归证据
```

同一规则或 SOP 只允许一个正文来源。Cursor、Codex 或其他入口只能读取或链接 `.agents/`，
不得复制第二份正文形成双真相。

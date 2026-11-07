# cliyard

**Design-to-Evidence Delivery Control Plane**  
设计到证据的 AI 工程交付控制面。

cliyard **不是**另一个 coding agent，也 **不是**以聊天为真相的 IDE/GUI。

它负责把人的设计变成可审 Plan、冻结契约、隔离执行、独立验收，并在磁盘上留下可恢复的裁决；Codex / Claude Code / Qwen Code / OpenCode / CodeBuddy 等只是可替换 Worker，DSH 或未来自有 Web UI 只是可替换人机入口。

English: [README.md](README.md)

```text
人的设计与取舍
  → 已审阅 Plan
  → 冻结 TaskContract
  → 能力匹配、准入与隔离执行
  → 独立验收证据
  → 人工审查 diff / 合入
  → 可恢复的下一步
```

**当前实现状态、优先级与 release gate 只以
[docs/CURRENT_STATE.md](docs/CURRENT_STATE.md) 为准。**  
协作入口：[AGENTS.md](AGENTS.md)。路线图概览：[docs/ROADMAP.md](docs/ROADMAP.md)。

## 一句话原则

1. **设计是真相，聊天不是真相。** Plan / Contract / Git / RunManifest / 证据才权威。
2. **完成必须带证据。** Worker 自报完成、heartbeat、exit 0 都不等于 accepted。
3. **Worker 可替换，能力决定路由。** 不绑定单一 CLI、模型或订阅。
4. **人只保留设计权与不可逆决策。** Plan 批准、契约冻结、合入、推送不能由系统擅自做。
5. **长任务是系统属性。** 模型、GUI、Supervisor 可以退出；磁盘上的设计、租约、证据和裁决不能丢。

产品命题与竞品边界见 [docs/KEY_MIND.md](docs/KEY_MIND.md)；  
策略与路由见 [docs/PRODUCT_STRATEGY_V2.md](docs/PRODUCT_STRATEGY_V2.md)；  
执行层改写方向见 [design/delivery-control-plane-v2.md](design/delivery-control-plane-v2.md)（仍待人工批准）。

## 理想闭环

```text
人：版本化需求 / 视觉 / 边界
  → UI client（当前 DSH 插件；目标自有 Control API 控制台）
  → cliyard：冻结契约 + 选择 CLI/模型 profile
  → 隔离 worktree / runtime → 独立 Verifier / 门禁
  → 人审 accepted diff → 合入（不可逆）
```

终点不是「无人自动合入 main」，而是：**人只定方向与终审，中间派工、校准、机器门禁交给控制面。**

## 路线图进行到哪

权威细节：[docs/CURRENT_STATE.md](docs/CURRENT_STATE.md) · 概览：[docs/ROADMAP.md](docs/ROADMAP.md)。

| 阶段 | 主线 | 说明 |
|---|---|---|
| **P0** 封刀 | **完成** | 冻结面已绑定 |
| **P1 / P1b** StateStore | **完成** | SQLite 权威 + ledger/journal 挂接 + `.cliyard/state.db` 统一 |
| **P2a / P2b** daemon + ExecutionSupervisor | **完成** | 只读 Control API；RuntimeHandle（launchd / Job Object 仍残留） |
| **P3** 沙箱 + 独立验收 + 干净裁决 | **进行中** | 沙箱/VT/Reviewer/ledger/SkillPack **已在主线**；acceptance-flow Reviewer 挂接 **开 PR 中** |
| **P4** 路由 / 准入 | **进行中** | ProfileCatalog + opt-in queue 准入 **已在主线** |
| **P5** 人机面 | 未开始 | Control API 控制台 |
| **P6** 终点验收 | 未开始 | 用工具交付 Vue Liquid Glass TDesign |

**acceptance-flow Reviewer 合入后的下一刀：** routing A/B，和/或 default-on review/VT（不是无限并行）。

## 今天能做什么（诚实版）

已在主线可用（前台、单仓库锁、顺序 queue；细节与证据见 CURRENT_STATE）：

- Plan 编译与冻结 TaskContract；write-path / path audit；git worktree 隔离
- 前台 Supervisor：原子 RunManifest、integration checkpoint、resume / reap / recover-workers
- 显式批准的 foreground queue：`add` / `add-plan` / `run` / `retry` / `adopt`
- RuntimeManager：本机 loopback 端口租约、readiness、runtime manifest、清理
- WorkerLease + 进程树清理（POSIX；controller-death 嵌套组恢复仍未闭环）
- WorkspaceBoundary v1：**检测型**保护根完整性（与 sandbox 独立）
- **Opt-in OS 沙箱（P3）：** nono `v0.81.0` pin、Landlock 诚实测量、`CLIYARD_SANDBOX=1` / `sandbox.enabled` worker wrap（非默认开启；无网络/凭据测量）
- **Background VerificationTask（P3）：** 耐久 `.cliyard/verification/`、detached runner、恢复标 `lost`；opt-in `CLIYARD_BACKGROUND_VERIFY=1` batch wire
- **Clean-context Reviewer v0：** `ReviewFinding` + 无聊天上下文 + 耐久 `.cliyard/reviews/`（fixture + model adapter；opt-in `CLIYARD_CLEAN_REVIEW=1` acceptance wire）
- **Human intervention ledger v0：** 六角色、耐久 `.cliyard/interventions/`、拒收密钥型 reason（仅观测）
- **SkillPack provenance v0：** `.agents/skills` digests + 耐久 pack 快照 + run binding
- 失败分类与成本真相（含 resume 保留 abandoned attempt；历史 missing 有导入约束）
- Task Architect：只产出供人审的 Plan，不自动冻结或派发
- 确定性 integration full-suite gate、estimate-plan telemetry 校准、Linux verifier 进程组超时回收
- **StateStore**（`cdde392` / `1fd737f`）：事件溯源 facts + projection；SQLite 可用时 run/queue/ledger/journal 写权威在 `.cliyard/state.db`
- **`cliyardd` + 只读 Control API**（`1f4be2d`）与 **ExecutionSupervisor / RuntimeHandle**（`6f9e550`）

**P0–P2b 已在主线封完。** P3 至 SkillPack + ProfileCatalog/admission gate 已上主线（沙箱/VT/admission/review 为 **opt-in**）；当前打开切片是 acceptance-flow Reviewer wire（P3 残留）。

## 今天还不能宣称什么

- 不是默认开启的 OS 写保护；不是凭据 / 网络隔离（Boundary 仍是事后检测）
- 不是拥有派发权的 daemon、跨宿主恢复、Windows Job Object 对等、24 小时无人值守
- 不是自动批准 Plan、自动合入 `main`、无限并行
- 不是已完成的动态路由 / default-on 分层 admission 生产就绪（catalog + opt-in queue gate 已有；无 learned ramp）
- 不是 default-on / live-CLI Reviewer（opt-in acceptance wire 已有）；intervention ledger 自动化 / Control API 写面尚未交付
- 不是 supervised pilot「已推荐」——仍差 DCP v2 人工决策与 P3 残留门禁

对照表与相邻产品见 [docs/OSS_LANDSCAPE.md](docs/OSS_LANDSCAPE.md)。  
与 ThinkRail 一类「围绕单一 coding engine 的 agentic IDE」不同：cliyard 做的是 **engine-agnostic 的交付控制面**，人机面可替换。

## 快速开始

要求：Node `>=20`，本机已安装并登录你要用的 Worker CLI（可选）。

```bash
npm install
npm run build
npm test

# 只读：从已提交设计产出供人审的 Plan（不冻结、不派发）
npm run architect -- --repo /path/to/clean-target \
  --design design/feature.md --plan-id feature --json

# 人审 Plan 后：编译/冻结契约（不自动开跑）
npm run plan-dispatch -- path/to/approved.plan.json --repo /path/to/target

# 前台 Supervisor（单仓库锁；无 daemon）
npm run dev -- supervisor start path/to/contracts.json --repo /path/to/target --worker claude
npm run dev -- supervisor status --repo /path/to/target --json
npm run dev -- supervisor resume --repo /path/to/target

# 显式批准的队列
npm run dev -- queue add-plan path/to/approved.plan.json --repo /path/to/target --id my-item
npm run dev -- queue run --repo /path/to/target
npm run dev -- queue status --repo /path/to/target --json
```

Mock 闭环（不依赖真实 Worker）：

```bash
npm run mock-loop
npm run mock-batch -- examples/mock-batch.parallel.json
```

Windows + WSL 入口（`doctor` / `run` / `batch`）仍可用，但 **已不是产品主叙事**；本机 macOS/Linux 前台控制面才是当前主路径。

状态落在目标仓库的 `.cliyard/`（gitignored）：`runs/`、`queue.json`、`worker-leases/`、`runtime/` 等。  
**RunManifest 是任务权威**；queue 只做协调；聊天不是权威。

## 文档地图

| 想了解 | 去读 |
|---|---|
| 现在做到哪、下一步做什么 | [docs/CURRENT_STATE.md](docs/CURRENT_STATE.md) |
| 怎么在本仓库协作 | [AGENTS.md](AGENTS.md) |
| 阶段路线（P0–P6） | [docs/ROADMAP.md](docs/ROADMAP.md) |
| 产品命题 | [docs/KEY_MIND.md](docs/KEY_MIND.md) |
| 并行 / 路由 / 入口策略 | [docs/PRODUCT_STRATEGY_V2.md](docs/PRODUCT_STRATEGY_V2.md) |
| 执行层改写（待人工批准） | [design/delivery-control-plane-v2.md](design/delivery-control-plane-v2.md) |
| P0 冻结面 | [docs/P0_LEGACY_SEAM_FREEZE.md](docs/P0_LEGACY_SEAM_FREEZE.md) |
| Supervisor / Runtime 操作 | [docs/SUPERVISOR_V0.md](docs/SUPERVISOR_V0.md)、[docs/RUNTIME_MANAGER.md](docs/RUNTIME_MANAGER.md) |
| 证据与测量 | [docs/evidence/](docs/evidence/)（单次测量，不替代 CURRENT_STATE） |

常驻纪律在 [`.agents/rules/`](.agents/rules/)，任务 SOP 在 [`.agents/skills/`](.agents/skills/)。  
`.cursor/rules` 与 `.cursor/skills` 是指向同一源的软链接，不要复制第二份正文。

## 积木

| 关注点 | 落点 | 说明 |
|---|---|---|
| 设计 / 意图 | Plan + TaskContract | 人审后冻结；变更即新版本 |
| 隔离 | git worktree + writePaths | 并行不共享脏树；path audit 验越界 |
| 执行 | 可替换 Worker CLI | BYO 安装与登录 |
| 运行态验收 | RuntimeManager | 租约端口、readiness、清理 |
| 任务权威 | RunManifest | accepted/rejected 只写这里 |
| 协调 | foreground queue | 显式批准；当前顺序派发 |
| 人机面 | DSH 插件（可替换） | 不持有契约/证据唯一真相 |
| 耐久状态 | StateStore（`better-sqlite3`） | run/queue/ledger/journal 落在 `.cliyard/state.db` |
| Daemon / 读 API | `cliyardd` | 只读 Control API；尚未拥有派发 |
| 执行身份 | ExecutionSupervisor / RuntimeHandle | PID/PGID 仅诊断 |
| 安全边界 | WorkspaceBoundary + opt-in SandboxAdapter/nono | 检测常在；OS wrap opt-in（`CLIYARD_SANDBOX`） |
| 独立验收 | VerificationTask + 可选 background Verifier | Detached PG；默认仍 shell verify |
| 干净裁决 | ReviewFinding / CleanReviewContext（v0） | Fixture + model adapter；opt-in accept wire |
| 人工干预 | Intervention ledger（v0） | 六角色；仅观测；不自动执行 |
| Skill 溯源 | SkillPack digests（v0） | `.agents/skills` → pack digest + run binding |
| 准入 | ProfileCatalog + opt-in queue gate（v0） | 未知 binding permit=1；`CLIYARD_ADMISSION=1` |

## License

Apache-2.0（planned）— 首次公开发布时再定稿。

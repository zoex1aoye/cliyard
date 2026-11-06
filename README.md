# cliyard

**Design-to-Evidence Delivery Control Plane**  
设计到证据的 AI 工程交付控制面。

cliyard **不是**另一个 coding agent，也 **不是**以聊天为真相的 IDE/GUI。

它负责把人的设计变成可审 Plan、冻结契约、隔离执行、独立验收，并在磁盘上留下可恢复的裁决；Codex / Claude Code / Qwen Code / OpenCode / CodeBuddy 等只是可替换 Worker，DSH 或未来自有 Web UI 只是可替换人机入口。

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

## 今天能做什么（诚实版）

已在主线可用（前台、单仓库锁、顺序 queue；细节与证据见 CURRENT_STATE）：

- Plan 编译与冻结 TaskContract；write-path / path audit；git worktree 隔离
- 前台 Supervisor：原子 RunManifest、integration checkpoint、resume / reap / recover-workers
- 显式批准的 foreground queue：`add` / `add-plan` / `run` / `retry` / `adopt`
- RuntimeManager：本机 loopback 端口租约、readiness、runtime manifest、清理
- WorkerLease + 进程树清理（POSIX；controller-death 嵌套组恢复仍未闭环）
- WorkspaceBoundary v1：**检测型**保护根完整性（不是 OS sandbox）
- 失败分类与成本真相（含 resume 保留 abandoned attempt；历史 missing 有导入约束）
- Task Architect：只产出供人审的 Plan，不自动冻结或派发
- 确定性 integration full-suite gate、estimate-plan telemetry 校准、Linux verifier 进程组超时回收

**P0 已封刀。** 遗留 JSON store / 前台 Supervisor / PID-as-authority / DSH monitor
功能面已冻结，见 [docs/P0_LEGACY_SEAM_FREEZE.md](docs/P0_LEGACY_SEAM_FREEZE.md)。  
下一执行切片：人工审完 Delivery Control Plane v2 后做 **P1 StateStore**。

## 今天还不能宣称什么

- 不是 OS 级写保护 / 凭据隔离 / 网络隔离（Boundary 只是事后检测）
- 不是 daemon、跨宿主恢复、Windows Job Object 对等、24 小时无人值守
- 不是自动批准 Plan、自动合入 `main`、无限并行
- 不是已完成的动态路由 / ProfileCatalog 实装 / 分层 admission 生产就绪
- 不是 supervised pilot「已推荐」——仍差 DCP v2 人工决策与后续门禁

对照表与相邻产品（含 Multica、Cezar、DSH 等）见 [docs/OSS_LANDSCAPE.md](docs/OSS_LANDSCAPE.md)。  
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
| 安全边界 | WorkspaceBoundary → 未来 SandboxAdapter | 今日检测，明日 OS 写隔离 |

## License

Apache-2.0（planned）— 首次公开发布时再定稿。

---
name: cliyard-design-to-plan
description: Use when turning a discussed product or engineering design into a reviewable cliyard Plan with task dependencies, write boundaries, acceptance evidence, estimates and execution constraints; stop before contract freeze or dispatch.
---

# Cliyard Design to Plan

## Outcome

把一个仍处于聊天、设计文档或原型中的需求，整理成人和 Master 都能审阅的 Plan。

本 Skill 的终点是：

- 一份版本化设计说明；
- 一份通过结构校验的 Plan JSON；
- 一份待确认列表与估算；
- 人明确批准或要求修改。

本 Skill 不冻结 contracts、不创建 queue item、不启动 Worker。

## Inputs

先读：

- 根目录 `AGENTS.md`；
- 用户指定的设计、视觉、原型和接口证据；
- 目标仓库现状与相关组件/模块；
- [KEY_MIND.md](../../../docs/KEY_MIND.md)；
- [MASTER_OPERATING_MODEL.md](../../../docs/MASTER_OPERATING_MODEL.md)；
- [TASK_ESTIMATION.md](../../../docs/TASK_ESTIMATION.md)；
- [PRODUCT_STRATEGY_V2.md](../../../docs/PRODUCT_STRATEGY_V2.md) 中与路由、并行有关的章节。

不要先读整个仓库。先按路径、组件名、接口名和 Git 历史定位相关区域。

## Procedure

1. **固定设计意图**
   - 写出目标用户故事、可观察结果、设计权威来源和明确 non-goals。
   - 区分已确认、推断、待确认；不要把推断写成用户决定。
   - 视觉任务记录目标视口、主题、关键状态和对照材料。

2. **识别真实代码边界**
   - 搜索现有实现、测试、契约和 evidence，避免为同一能力造第二套组件。
   - 标出共享 token、API、schema、迁移、fixture、运行服务和配置。
   - 共享资源当前不能由 Supervisor 自动加锁；发现共享写资源时先拆分或标为 blocked 设计项。

3. **按可验收单元拆分**
   - 先地基，再上层；但不能为了“看起来有序”制造伪依赖。
   - 同一 task 最好能在一个 bounded attempt 内完成一个可独立判断的结果。
   - 估算为 XL 时优先拆成实现、演示/集成、证据/文档等可独立验收单元。
   - 只有真实代码依赖才写入 `dependsOn`；下游必须基于已接受上游 commit。

4. **分配读写路径**
   - `writePaths` 使用仓库相对路径；同一 Plan 中任何两个任务都不能重叠。
   - `readPaths` 明确 Worker 必须参考的权威文件。
   - 禁止用 `src/`、仓库根或空路径掩盖“还没想清楚要改哪里”。

5. **定义验收**
   - 至少包含一条有限、非交互、可重复的 `verifyCommands`。
   - 静态验收写 build/typecheck/test/path check。
   - 需要服务时写 runtime、readiness、lease port 和数据隔离要求。
   - 视觉任务写同视口截图、Light/Dark、状态矩阵和偏差输出。
   - 明确指出“无证据时什么状态也不能宣称”。

6. **标注执行约束**
   - 任务是否需要视觉、长上下文、工具、provider-session resume 或特定 CLI capability。
   - 当前 binding 的 quota/balance/price 未观测时写 unknown。
   - 并行只基于不重叠 write paths 和同一 integration base；不要写死并发 3 或固定模型。

7. **估算成本、时长、轮次**
   - 运行 `npm run estimate-plan -- <plan.json>` 获取启发式 ranges。
   - 把结果当作 planning aid，不是报价、余额或 provider 事实。
   - `guardBudgetUsd` 是本地护栏；真实 cost 用 `provider-reported`、`cli-estimated`、
     `usage-only` 或 `unavailable` 表达。
   - 历史 evidence 比静态公式优先；没有 telemetry 时明确“未校准”。

8. **写 Plan 并请人审**
   - 设计说明建议写到 `design/<iteration-id>.md`。
   - Plan 建议写到 `design/<iteration-id>.plan.json`。
   - 不再继续冻结或派发，除非用户明确批准。

## Plan 最小结构

```json
{
  "planId": "feature-v1",
  "tasks": [
    {
      "taskId": "foundation",
      "goal": "One acceptance-sized implementation outcome",
      "nonGoals": ["Explicitly excluded work"],
      "dependsOn": [],
      "readPaths": ["AGENTS.md", "path/to/authority"],
      "writePaths": ["path/to/owned/file-or-directory"],
      "verifyCommands": ["finite non-interactive command"],
      "maxRepairs": 1
    }
  ]
}
```

需要运行服务时按 [runtime-manager-v0.md](../../../design/runtime-manager-v0.md)
增加 `runtime`，使用 argv 命令、repo-relative cwd、leased port 环境变量和 readiness。

## Plan Quality Gate

- 每个任务有单一可判断结果，不靠“顺便完成”扩大范围。
- 目标、non-goals、允许路径、验收和不做什么都清楚。
- 依赖图无环；依赖描述真实代码先后。
- 所有 `writePaths` 不重叠，且不写绝对路径。
- 验收命令不会开始交互、无限等待或依赖未声明的默认端口。
- runtime/visual 证据要求与任务风险匹配。
- 成本、时长、轮次有范围和校准来源，不伪装成精确值。
- 未决 P0 设计问题已经列出，而不是留给 Worker 猜。

## Output

向用户交付：

- Plan 路径；
- 任务图与可并行的 ready wave；
- 写路径所有权；
- 验收矩阵；
- 估算与未知项；
- 需要人确认的取舍；
- 明确声明“尚未冻结、尚未派发”。

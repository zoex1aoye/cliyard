---
name: cliyard-acceptance-review
description: Use to independently review a cliyard run, worktree or integration branch against its Plan, frozen contracts, tests, path audit, runtime evidence and current known gaps before recommending acceptance or merge.
---

# Cliyard Acceptance Review

## Stance

先把结论当作未知。读取代码、Git lineage、RunManifest 和证据，再给 verdict。

默认只读审查；除非用户要求修复，不修改 queue、RunManifest、commit、branch 或 Worker 现场。

## Inputs

确认：

- runId、Plan、contracts path/hash；
- task branch、base commit、integration branch/head；
- claimed verdict 和原有 failure/cost；
- 目标仓库当前 `git status`；
- evidence 文档和测试命令。

如果输入不完整，先列出缺失证据；不要从 `active.json` 或聊天推断多重 run 的身份。

## Review Checklist

### 1. Authority and lineage

- Plan 的字节/commit 与派发前记录一致。
- contracts 的 SHA-256、base commit 与 RunManifest 一致。
- task branch 从正确 base 创建；integration commit 是已接受任务的合法后代。
- queue binding 和 RunManifest 指向同一 run；没有把 adopted 当 accepted。

### 2. Scope

```bash
git -C <worktree> status --short
git -C <worktree> diff --name-status <base>...<artifact>
```

逐项检查：

- 所有 changed paths 位于 `writePaths`；
- 没有 contract 未授权的 temp、cache、secret、配置或主 checkout 写入；
- reused dirty worktree 的旧文件已重新审计；
- 没有删除或覆盖用户既有改动。

### 3. Verification

- 查看实际 command、exit code、focused/full test 数量和时间。
- 在需要时从 artifact 独立重跑 focused tests；集成审查再跑 build/full suite。
- 测试失败、未运行、被跳过和 flaky 历史都必须写清。
- 不以文档声称、Worker 摘要或单个 exit 0 代替可复现证据。

### 4. Runtime and process

- acceptance runtime 从 exact artifact 启动，而不是复用 worker preview。
- 使用 leased port、独立数据和独立 browser profile。
- readiness 真实通过；没有固定 sleep 假通过。
- RuntimeManifest cleanup 完整；端口可重新绑定。
- 检查 active WorkerLease、Supervisor/queue lock、进程组和 nested groups。
- 发现孤儿时只读确认 cwd 与精确身份；身份不明则 `needs_human`，禁止 broad kill。

### 5. Product and visual evidence

- 验收矩阵逐项对应契约。
- 视觉任务有目标视口、主题/状态截图和偏差清单。
- 未取得同视口渲染证据时，不宣称视觉完成。
- a11y、交互稳定性、错误态、空态、loading/disabled 等适用状态已覆盖。

### 6. Known gaps

对照 [KNOWN_GAPS_2026-10-28.md](../../../docs/KNOWN_GAPS_2026-10-28.md)：

- 结果是否被错误描述成 OS sandbox、完整进程树恢复、动态路由或全量并行；
- 是否存在新的 P0/P1 安全缺口；
- 是否把 `accepted_with_gap` 写成完整闭环。

## Verdict Format

```text
decision: accepted | accepted_with_gap | rejected | blocked | needs_human
contract:
base / artifact / integration:
tests:
scope audit:
runtime / process:
visual / a11y:
cost / failure truth:
known gaps:
required follow-up:
merge recommendation:
```

## Merge Gate

即使 verdict 是 accepted：

- 默认保留 worktree；
- 给出待合入 commit 和 diff 范围；
- 明确 merge 后的 smoke/visual regression；
- 等用户明确指示后再 merge 或 push；
- 不自动改写 RunManifest、queue 或历史结果。

## False-positive Guards

- 测试命令被 timeout、budget 或 auth 截断：不是 verifier success。
- 只跑 focused tests：不能宣称完整回归。
- 端口仍被占用或有 active lease：不满足 runtime cleanup。
- path audit 没越界：不能证明 OS 写预防已经存在。
- `WorkspaceBoundary=clean`：只是 snapshot 未检测到变化。
- `queue.completed(adopted)`：不是 Worker/Verifier 成功。

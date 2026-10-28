---
name: cliyard-contract-freeze
description: Use after a cliyard Plan has human approval to compile and audit frozen TaskContracts at an exact accepted integration base; do not use to invent requirements or dispatch work.
---

# Cliyard Contract Freeze

## Preconditions

只有以下条件全部成立才开始：

- 用户已审阅并明确批准 Plan；
- Plan 文件已进入 Git，且字节不会再静默变化；
- 已确认 latest accepted integration worktree 和完整 base commit；
- 目标仓库工作树状态已检查，用户现有修改不会被覆盖；
- 契约需要的运行、视觉和证据条件已经明确。

任一条件不满足时停在 Plan/设计阶段。

## Freeze Procedure

1. **锁定来源**
   - 记录 Plan 路径、Plan commit 或 SHA-256。
   - 记录 accepted integration branch、worktree 和完整 base commit。
   - 避免让 `HEAD` 在编译期间移动。

2. **用控制面编译**
   优先在 accepted integration code 上运行 `plan-dispatch` 的 compile-only 路径，
   将 Plan 解析为完整 `TaskContract`。典型形式：

   ```bash
   cd <accepted-integration-worktree>
   npx tsx src/cli.ts plan-dispatch <target>/design/<id>.plan.json \
     --repo <accepted-integration-worktree> \
     --out <target>/design/<id>.contracts.json
   ```

   不要加 `--dispatch`。确认真实命令、cwd 和输出路径后再执行。

3. **审生成契约**
   每个 task 至少检查：

   - 唯一、安全的 `taskId`；
   - `frozen: true`、版本和完整 `baseCommit`；
   - `goals`、`nonGoals`、`deliverables`、`forbidden` 足以指导 Worker；
   - `dependsOn` 无环且表达真实代码依赖；
   - `readPaths` 指向权威输入；
   - `writePaths` 非空、repo-relative、任务间无重叠；
   - `sharedResources` 为空；如不为空，当前不得派发；
   - `verifyCommands` 有限、非交互并可产生明确 exit 结果；
   - `runtime` 只使用 argv、repo-relative cwd、leased port 和 readiness；
   - `maxRepairs` 有界。

4. **检查估算**
   ```bash
   npm run estimate-plan -- <plan.json>
   ```
   XL 或高风险任务应回退拆分。估算不是 provider 报价；guard、CLI estimate 和真实 cost 分开记录。

5. **冻结与提交**
   - 将已验证 contracts 作为独立变更审阅。
   - 若用户已授权提交，contracts 使用独立 commit；不要和实现修改混在一起。
   - 记录 contracts 文件 SHA-256，后续 queue/supervisor 必须验证它未变化。
   - Plan 或 contracts 后续需要修改时，产生新版本和新 hash；禁止覆盖已派发的冻结字节。

## Queue-specific Caveat

`queue add-plan` 会为 root item pin 住调用时目标仓库的 `HEAD`。
如果自举要求基于 accepted integration 而不是主 checkout 当前 HEAD：

- 先检查 pinned base；
- 确认它就是 intended accepted base；
- 否则不要用 `queue add-plan` 代替从 accepted integration 冻结 contracts。

## Stop Conditions

遇到以下任一项即停：

- Plan 未批准或仍有 P0 设计问题；
- base commit 不明确、不可达或不是已接受 lineage；
- task write paths 重叠；
- acceptance command 依赖未声明的服务、共享状态、默认端口或人工交互；
- runtime/visual 要求无法被 verifier 执行；
- 需要手动编辑生成契约却无法重新验证；
- 需要 shared-resource lock，但当前控制面尚未实现。

## Output

报告：

- Plan hash / commit；
- base commit 与 integration lineage；
- contracts 路径、SHA-256；
- task DAG 与 ready waves；
- path ownership；
- verify/runtime/visual gate；
- 明确声明“已冻结，但尚未派发”。

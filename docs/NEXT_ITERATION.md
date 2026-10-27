# 下一迭代：RuntimeManager v0 验收与收口

> 日期：2026-10-27（更新）
>
> 结论：RuntimeManager v0 已实现，端口租约、RuntimeSpec、HTTP readiness、
> manifest/evidence、进程组清理和 shell Verifier 集成均有测试覆盖。实测完整套件
> **119/119 通过**；计划中的 105 条只是早期估计，未被实现确认，不再采用。
> 下一步只做真实 Worker 的 runtime contract 演练与失败演练，然后按实测结果收口。
> 本迭代不扩 daemon、SQLite、Playwright/axe/截图/无障碍证据、Docker 或无限并发。

## 0. 当前状态

已落地（单机、本机仓库、有限服务）：

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
  - SIGTERM → SIGKILL 整个进程组、确认端口释放、释放租约、持久化最终 manifest。
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

- 后台 daemon / 24h 常驻 / 队列 / 云执行；
- SQLite（仍为原子 JSON）；
- Playwright、axe、截图或无障碍证据；
- Docker / 远程沙箱；
- CPU/内存/浏览器并发准入调度或“无限并行 runtime”；
- 自动合入 main、自动 push；
- HTTPS、TCP-only readiness、自定义优雅关闭命令；
- Windows 下的 POSIX 进程组等价清理。

操作语义、manifest 字段、环境变量、清理顺序和完整限制见
[docs/RUNTIME_MANAGER.md](RUNTIME_MANAGER.md)。

## 1. V0 完成标准对照

设计要求的 10 项测试与实际覆盖：

| # | 设计要求 | 状态 | 覆盖 |
|---|----------|------|------|
| 1 | 两个独立进程的 allocator 不能租到同一端口 | 已实现 | `runtime-ports`: separate live processes never lease the same port |
| 2 | 同一 live key 重新分配返回同一租约 | 已实现 | `runtime-ports`: allocate persists a lease and reuses it for the same live runId+service |
| 3 | release 后端口重新可用 | 已实现 | `runtime-ports`: release is idempotent…and frees the port |
| 4 | 已占用端口被跳过 | 已实现 | `runtime-ports`: a separate process skips an occupied port |
| 5 | 同一 runtime 的两个服务拿到不同端口 | 已实现 | `runtime-manager`: starts two services with leased ports… |
| 6 | readiness 失败保留日志且不跑 verifyCommands | 已实现 | `runtime-manager` + `runtime-verifier` readiness failure tests |
| 7 | readiness 成功后暴露 `WEB_URL` 并执行 HTTP 断言 | 已实现 | `runtime-verifier`: exposes WEB_URL, persists manifest, releases port |
| 8 | cleanup 后没有遗留监听进程 | 已实现 | `runtime-manager` 进程组测试 + `runtime-verifier` 端口探测 |
| 9 | Plan → Contract 保留 runtime 并拒绝畸形 spec | 已实现 | `contract-runtime`（10 项） |
| 10 | 无 runtime 的 contract 行为不变 | 已实现 | `runtime-verifier` static test + 完整套件 |

设计验收中的“两个验收同时持有不同端口”目前由独立进程端口租约测试支撑；
两个完整验收并发的端到端演练仍列入下一迭代，不把它算作已完成。“每次验收前清理
服务进程组”由 cleanup 测试覆盖。它仍是单机范围，不构成无限并发承诺。

## 2. 验证（2026-10-27，本工作树）

```text
npm run build   → 通过
npm test        → 119/119 通过
```

Runtime 相关 33 项：

```text
tests/runtime-ports.test.ts       10
tests/runtime-manager.test.ts      8
tests/runtime-verifier.test.ts     5
tests/contract-runtime.test.ts    10
```

实测套件大小是 **119**，不是早期计划的 105。首次完整运行与 `npm run build`
并行时出现过一次 118/119；随后两次独立完整运行均为 119/119，runtime 相关套件
连续三次 33/33。记录时以可复现的实测结果为准，不宣称 105。

## 3. 下一迭代范围

只做三件事：

1. **真实 Worker 的 runtime contract 演练（scratch repo）**
   - 使用 `claude-batch` 或 `codex-batch` 在临时 git 仓库运行本仓库的示例 contract
     或等价的最小 contract；
   - 服务必须是有限进程并绑定租约端口；
   - verifyCommand 必须通过 `CLIYARD_<SERVICE>_URL`（或 `urlEnv`）请求租约 URL；
   - 检查 manifest 的 `cleanup`、`exitCode`/`signal`、日志路径和租约释放。

2. **并发与失败演练**
   - 两个验收同时运行，确认拿到不同端口且互不覆盖 manifest；
   - readiness 超时：确认 verifyCommands 被跳过、日志被捕获、无遗留监听；
   - 端口被外部占用：确认一次 `EADDRINUSE` 重试或明确失败，且最终释放租约；
   - verifyCommand 失败：确认 runtime 仍被停止，cleanup 状态可审计；
   - cleanup 失败路径：确认验收失败而不是静默接受。

3. **记录证据并收口文档**
   - 记录 `runtimeId`、端口、manifest 路径、测试输出和失败演练结果；
   - 只按实测结果更新 README / NEXT_ITERATION / RUNTIME_MANAGER；
   - 发现文档与实现不一致时先修文档，不扩大能力声明。

## 4. 不在本迭代范围

- daemon / 后台常驻 / 24h 无人值守；
- SQLite 或其他状态存储迁移；
- Playwright、axe、截图或无障碍证据；
- Docker / 远程沙箱 / 多租户 / 云执行；
- 无限并行 runtime 或 CPU/内存/浏览器准入调度；
- 自动合入 main 或自动 push；
- HTTPS / 认证 / TCP-only readiness；
- Windows POSIX 进程组等价清理；
- 自定义优雅关闭命令或日志轮转。

## 5. 完成标准

1. 至少一次真实 Worker 的 runtime contract 在 scratch repo 被接受，且
   verifyCommand 确实请求了租约 URL。
2. 验收后 manifest `cleanup` 为 `complete`，端口不再监听，租约存储为空。
3. 两个并发 runtime 使用不同端口，manifest 路径互不冲突。
4. readiness 失败、verifyCommand 失败和 cleanup 失败均有可审计结果。
5. `npm run build` 与 `npm test` 通过，并记录实测测试数（当前为 119）。
6. 文档不宣称 daemon、SQLite、Playwright/axe、截图/无障碍证据或无限并发。

## 6. 下一步顺序

```text
1. [已完成] RuntimeManager v0 实现 + 119/119 测试
2. 创建 scratch repo 与最小 runtime contract
3. 真实 Worker dry-run（确认 worktree、writePaths、contract 校验）
4. 真实 Worker runtime 验收，检查 manifest / 日志 / 租约
5. 两个并发 runtime 演练
6. readiness / EADDRINUSE / verify / cleanup 失败演练
7. 按实测结果收口 README / NEXT_ITERATION / RUNTIME_MANAGER
8. 人工审阅后再决定是否扩大范围
```

## 7. 上一迭代状态

Supervisor v0（前台、原子 JSON RunManifest、进程级 SIGKILL 恢复）已完成，
其操作语义与自举手册见 [docs/SUPERVISOR_V0.md](SUPERVISOR_V0.md)。当前完整套件
仍包含 supervisor 测试（119/119 通过）。本轮没有引入 daemon 或 SQLite，也没有
把 supervisor 的后台化列入计划。

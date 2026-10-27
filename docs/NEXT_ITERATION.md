# 下一迭代：RuntimeManager v0 验收与收口

> 日期：2026-10-27（更新）
>
> 结论：RuntimeManager v0 已实现，端口租约、RuntimeSpec、HTTP readiness、
> manifest/evidence、进程组清理和 shell Verifier 集成均有测试覆盖。实测完整套件
> **119/119 通过**；计划中的 105 条只是早期估计，未被实现确认，不再采用。
> 真实 Worker、完整并发验收和 checked-in example 均已通过。下一迭代只处理
> Supervisor 在 runtime 服务运行期间被强制杀死后的孤儿服务、stale port lease 与
> 恢复审计；不扩 daemon、SQLite 或浏览器证据。
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

“两个验收同时持有不同端口”既由独立进程端口租约测试覆盖，也由完整验收并发演练
补证：两个约 1.5 秒重叠的 mock Worker + real verifier 分别使用 `21900` 与
`21901`，manifest 路径独立，结束后租约表为空。它仍是单机范围，不构成无限并发承诺。

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

### 自举与运行态证据

- 新 Supervisor 自举 run：`294092fb-0710-4a78-98b3-c6e7b299a8c1`；
- base commit：`53e3712a35e64552f95ca97fbaf1df4c8f4a5f49`；
- integration branch：
  `cliyard/integration/294092fb-0710-4a78-98b3-c6e7b299a8c1`；
- integration head：`9f760e119e7835d21ad1527b2aedd43bf9c72f2e`；
- 5/5 accepted，0 blocked，0 repair；`rt-runtime-manager` 与
  `rt-contract-runtime` 并行执行；
- checked-in example 使用 `21850` accepted，`cleanup=complete`，端口释放；
- 真实 Claude + DeepSeek scratch run 使用 `19000` accepted，Worker 只修改
  `runtime-smoke.txt`，服务以 `SIGTERM` 结束，租约表为空。

## 3. 下一迭代范围

只做三件事：

1. **Runtime 崩溃回收**
   - Supervisor 在 readiness 或 verifyCommand 期间被 SIGKILL；
   - 新进程根据 RuntimeManifest 和 port lease 识别孤儿服务组；
   - 只有在同一 host、owner pid 已死且服务 pid/group 可证明属于该 runtime 时回收；
   - stale lease 在孤儿组终止后才释放；
   - 无法证明归属时报告 `needs_human`，不盲目 kill。

2. **进程级失败演练**
   - readiness 超时与 verifyCommand 失败在独立进程中被观察；
   - 外部端口竞争触发一次换端口或明确失败；
   - cleanup 失败不得静默 accepted；
   - 恢复过程保留原日志、端口、pid 和裁决理由。

3. **记录证据并收口文档**
   - 记录旧 runtimeId、孤儿 pid/group、租约、清理动作和最终测试输出；
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

1. [已完成] 真实 Worker runtime contract 在 scratch repo accepted，并使用租约 URL。
2. [已完成] 正常验收后 manifest `cleanup=complete`，端口释放，租约存储为空。
3. [已完成] 两个重叠验收使用不同端口，manifest 路径互不冲突。
4. Supervisor SIGKILL 后，孤儿 runtime 与 stale lease 可安全识别、回收或升级人工。
5. readiness、verifyCommand 与 cleanup 失败均有可审计进程级结果。
6. `npm run build` 与 `npm test` 通过，并记录实测测试数（当前为 119）。
7. 文档不宣称 daemon、SQLite、Playwright/axe、截图/无障碍证据或无限并发。

## 6. 下一步顺序

```text
1. [已完成] RuntimeManager v0 实现 + 119/119 测试
2. [已完成] 新 Supervisor 自举 RuntimeManager，5/5 accepted
3. [已完成] scratch repo 的真实 Claude + DeepSeek runtime 验收
4. [已完成] 两个完整 runtime 验收并发，端口 21900 / 21901
5. [已完成] checked-in example、manifest、cleanup 和租约释放
6. 增加 supervisor SIGKILL runtime orphan reaper
7. 做进程级 readiness / verify / cleanup 失败演练
8. 合并并记录第二份 runtime 证据
```

## 7. 上一迭代状态

Supervisor v0（前台、原子 JSON RunManifest、进程级 SIGKILL 恢复）已完成，
其操作语义与自举手册见 [docs/SUPERVISOR_V0.md](SUPERVISOR_V0.md)。当前完整套件
仍包含 supervisor 测试（119/119 通过）。本轮没有引入 daemon 或 SQLite，也没有
把 supervisor 的后台化列入计划。

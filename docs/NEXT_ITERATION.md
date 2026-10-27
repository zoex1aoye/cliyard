# 下一迭代：RuntimeManager v0 与孤儿回收收口

> 日期：2026-10-27（更新）
>
> 结论：RuntimeManager v0 与 Runtime Orphan Reaper v0 均已实现。端口租约、
> RuntimeSpec、HTTP readiness、manifest/evidence、进程组清理、精确进程身份、
> 只读 preflight、`supervisor reap` 以及 start/resume 自动对账均有测试覆盖。
> 实测完整套件 **156/156 通过**，runtime/恢复相关 **70 项通过**。
>
> 剩余缺口明确保留：不做跨主机回收；leader 已退出但组内仍有成员时只能
> `needs_human`；Windows 无法采集进程身份；没有 daemon 或周期扫描。下一迭代
> 只补进程级失败演练和事故证据流程，不扩大能力声明。
>
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
  - SIGTERM → SIGKILL 整个进程组、确认端口释放、释放租约、持久化最终 manifest；
  - 启动时写入 `owner`；spawn 后立即持久化 `pid`、`pgid` 和 `processIdentity`
    （`ps` 的 `pid`/`pgid`/`lstart`），并在 readiness 前再次写盘。
- **Runtime Orphan Reaper v0**
  - `src/runtime/process.ts`：精确进程身份采集与比较；`ps` 不可用或身份缺失
    一律视为 `unknown`，绝不猜测；
  - `src/runtime/reaper.ts`：只读 preflight，不回信号、不探测端口、不释放租约、
    不写 manifest；分类为 `safe_to_reap` / `needs_human` / `skip`；
  - `src/runtime/reaper-execute.ts`：只执行 preflight 批准的计划；再次核对身份后
    SIGTERM → SIGKILL 已证明的进程组，确认端口可绑定，才释放精确匹配的租约，
    最后原子写入 `recovery` 记录和 `cleanup: "complete" | "failed"`；
  - `.cliyard/runtime/reaper.lock` 串行化并发 reaper；同主机死 owner 的锁可清理，
    外来/不可读锁至少 5 分钟后才按年龄放弃；
  - `cliyard supervisor reap --repo <path> [--json]` 显式回收；
  - `start` 在取得 supervisor 锁后、创建 RunManifest 前自动对账；`resume`
    在检查 contracts/base/integration 并取得锁后、标记 `running` 前自动对账；
    任一 `needs_human` 都 fail closed：`start` 不创建 run，`resume` 不改
    RunManifest，两者都不派发；
  - `status` 只读，仅展示已持久化的 `recovery` 记录，从不执行对账；
  - 不做跨主机 kill，不按命令行模式匹配，不在无法证明归属时杀进程或删租约。
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

- 跨主机 runtime 回收或远程 kill；外来 host 的 runtime 只会 `skip`，主机名变化
  也会使旧 manifest 看起来属于外来 host；
- leader 已退出但进程组仍有成员时的自动回收（只能 `needs_human` 并保留证据）；
- 无关 run 在回收前分配端口时清理死 owner 租约，导致关联证据消失，只能
  `needs_human`；
- 缺少 manifest 的 runtime 目录或租约不会被推断回收；
- daemon / 周期扫描 / 24h 无人值守 / 后台队列；
- Windows 的 POSIX 进程组等价清理与进程身份采集；
- SQLite（仍为原子 JSON）；
- Playwright、axe、截图或无障碍证据；
- Docker / 远程沙箱；
- CPU/内存/浏览器并发准入调度或“无限并行 runtime”；
- 自动合入 main、自动 push；
- HTTPS、TCP-only readiness、自定义优雅关闭命令或日志轮转。

正常清理、崩溃后的证据字段、分类规则、事故清单和限制详见
[docs/RUNTIME_ORPHAN_RECOVERY.md](RUNTIME_ORPHAN_RECOVERY.md)；RuntimeManager
的正常生命周期见 [docs/RUNTIME_MANAGER.md](RUNTIME_MANAGER.md)。

## 1. 孤儿回收验收对照

设计要求与实际覆盖：

| # | 设计要求 | 状态 | 覆盖 |
|---|----------|------|------|
| 1 | 采集并比较精确 leader pid/pgid/start identity | 已实现 | `runtime-process`：身份采集、精确比较、缺失即 unknown |
| 2 | Manager 持久化 owner 与服务身份 | 已实现 | `runtime-manager-identity`：owner、pid==pgid、readiness 前写盘、失败启动保留、EADDRINUSE 重试替换身份 |
| 3 | 真实进程启动 detached 服务后被 SIGKILL | 已实现 | `runtime-reaper`：真实 RuntimeManager HTTP 服务，owner 进程被 SIGKILL 后服务仍存活 |
| 4 | reaper 证明归属、终止组、释放端口/租约、写证据 | 已实现 | `runtime-reaper`：终止、端口可绑定、精确租约清空、manifest `cleanup=complete` |
| 5 | 启动身份变化 → `needs_human` 且保留组/租约 | 已实现 | `runtime-reaper` + `runtime-reaper-plan` |
| 6 | 外来 host owner → skip/`needs_human`，不 kill | 已实现 | `runtime-reaper` + `runtime-reaper-plan` |
| 7 | 租约不匹配 → `needs_human` | 已实现 | `runtime-reaper` + `runtime-reaper-plan` |
| 8 | 已完成 runtime 被 skip | 已实现 | `runtime-reaper` |
| 9 | preflight 不改变进程、租约、manifest | 已实现 | `runtime-reaper-plan`：字节级不变 |
| 10 | 并发 reaper 串行化 | 已实现 | `runtime-reaper`：reaper lock |
| 11 | supervisor start/resume 在 `needs_human` 时 fail closed | 已实现 | `supervisor-runtime-reaper`：子进程级 CLI |
| 12 | leader 消失但组内仍有成员时保留证据 | 已实现 | `runtime-reaper` + `runtime-reaper-plan`：`needs_human`，不杀 |

未覆盖的能力不会被写成“已实现”：跨主机回收、leader-dead 自动 kill、daemon
周期回收、Windows 进程身份。

## 2. 验证（2026-10-27，本工作树）

```text
npm run build   → 通过
npm test        → 156/156 通过
```

Runtime/恢复相关 70 项：

```text
tests/runtime-ports.test.ts               10
tests/runtime-manager.test.ts              8
tests/runtime-verifier.test.ts             5
tests/contract-runtime.test.ts            10
tests/runtime-manager-identity.test.ts     5
tests/runtime-process.test.ts              8
tests/runtime-reaper-plan.test.ts          9
tests/runtime-reaper.test.ts              10
tests/supervisor-runtime-reaper.test.ts    5
```

进程级覆盖包括：真实 detached RuntimeManager 服务 + owner SIGKILL、SIGTERM 不退出
时的 SIGKILL 升级、leader 已死但组内仍有成员、外部进程占用端口、并发 reaper
串行化，以及 `reap`/`start`/`resume` 作为独立子进程运行。没有跨主机或 daemon
清理演练，也没有相应能力声明。

此前 RuntimeManager v0（reaper 之前）的运行证据仍然有效：checked-in example
在租约端口上 accepted 且 `cleanup=complete`；两个重叠验收使用不同端口并各自
留下独立 manifest；真实 Claude + DeepSeek scratch run 只修改
`runtime-smoke.txt`，服务以 `SIGTERM` 结束，租约表为空。本轮没有重跑这些外部
Worker 演练，因此不把它们当作 reaper 或跨主机证据。

## 3. 下一迭代范围

只做两件事：

1. **进程级失败演练**
   - 在独立进程中分别观察 readiness 超时、verifyCommand 失败和 cleanup 失败；
   - 确认失败路径不静默 accepted，原日志、端口、pid/pgid 与裁决理由都保留；
   - 对 `needs_human` 路径做一次 scratch repo 事故演练，按
     [RUNTIME_ORPHAN_RECOVERY.md](RUNTIME_ORPHAN_RECOVERY.md) 的证据清单操作。

2. **证据与文档复核**
   - 只按实测结果更新 README / NEXT_ITERATION / RUNTIME_MANAGER /
     RUNTIME_ORPHAN_RECOVERY；
   - 记录旧 runtimeId、owner、pid/pgid、租约、动作、端口和最终测试输出；
   - 若文档与实现不一致，先修文档，不扩大能力声明；
   - 保持“无 daemon、无 SQLite、无跨主机、无浏览器证据”的边界。

不在本迭代范围：

- 跨主机回收、远程 kill 或共享租约存储；
- leader-dead 进程组的启发式回收；
- daemon / 周期扫描 / 后台常驻；
- SQLite 或其他状态存储迁移；
- Playwright、axe、截图或无障碍证据；
- Docker / 远程沙箱 / 多租户 / 云执行；
- 无限并行 runtime 或 CPU/内存/浏览器准入调度；
- 自动合入 main 或自动 push；
- HTTPS / 认证 / TCP-only readiness；
- Windows POSIX 进程组等价清理；
- 自定义优雅关闭命令或日志轮转。

## 4. 完成标准

1. [已完成] RuntimeManager v0 的端口、readiness、manifest、cleanup 和 shell
   Verifier 集成测试通过。
2. [已完成] 正常验收后 manifest `cleanup=complete`，端口释放，租约存储为空。
3. [已完成] 两个重叠验收使用不同端口，manifest 路径互不冲突。
4. [已完成] Supervisor SIGKILL 后，可证明归属的孤儿 runtime 与 stale lease 被
   安全回收；无法证明时报告 `needs_human`，不盲目 kill。跨主机仍不在范围内。
5. [部分完成] readiness 失败与 verify 失败已有可审计结果与测试；cleanup 失败
   的独立进程演练，以及三者的分别进程级演练，仍属于下一迭代。
6. [已完成] `npm run build` 与 `npm test` 通过，完整套件实测 156/156，
   runtime/恢复相关 70/70。
7. [已完成] 文档不宣称 daemon、SQLite、Playwright/axe、截图/无障碍证据、
   无限并发、跨主机回收或 leader-dead 自动回收。

## 5. 下一步顺序

```text
1. [已完成] RuntimeManager v0 实现
2. [已完成] Runtime Orphan Reaper v0：preflight + executor + supervisor 集成
3. [已完成] 完整套件 156/156；runtime/恢复 70/70
4. [已完成] 真实 owner SIGKILL、SIGTERM 升级、leader-dead、外占端口、
            并发 reaper 与 start/resume fail-closed 测试
5. 下一迭代：独立进程中的 readiness / verify / cleanup 失败演练
6. 下一迭代：按事故清单做 scratch repo 证据演练并记录实测输出
7. 复核文档，不新增跨主机、daemon 或 leader-dead 自动回收声明
```

## 6. 上一迭代状态

Supervisor v0（前台、原子 JSON RunManifest、进程级 SIGKILL 恢复）已完成，
其操作语义与自举手册见 [docs/SUPERVISOR_V0.md](SUPERVISOR_V0.md)。当前完整套件
包含 supervisor 测试（156/156 通过）。本轮没有引入 daemon 或 SQLite，也没有
把 supervisor 的后台化列入计划。

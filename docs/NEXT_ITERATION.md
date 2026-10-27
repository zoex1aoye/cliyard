# 下一迭代：RuntimeManager v0、孤儿回收与 hardening 收口

> 日期：2026-10-27（更新）
>
> 结论：RuntimeManager v0、Runtime Orphan Reaper v0 与 orphan hardening 均已
> 实现。端口租约、RuntimeSpec、HTTP readiness、manifest/evidence、进程组清理、
> 精确进程身份、精确租约 owner、只读 preflight、`supervisor reap`、
> start/resume 自动对账和 `runtimeId` recovery record 均有测试覆盖。
> 实测完整套件 **164/164 通过（连续 5 次）**，runtime/恢复相关 **78 项通过**。
>
> 本轮 hardening 的四项修复：租约 owner PID 必须精确等于 manifest owner；新
> recovery record 自带 `runtimeId`，Supervisor 不再按 reason 反推；Supervisor
> 源码无 NUL；runtime 测试文件使用互不重叠的静态端口池。5 次独立全量运行均
> 164/164，本轮未观察到 flake。
>
> 剩余缺口明确保留：不做跨主机回收；leader 已退出但组内仍有成员时只能
> `needs_human`；Windows 无法采集进程身份；没有 daemon 或周期扫描；测试端口
> 池只解决本仓库测试文件之间的冲突，不是生产或跨仓库端口协调。下一迭代只补
> 进程级失败演练和事故证据流程，不扩大能力声明。
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
  - 不做跨主机 kill，不按命令行模式匹配，不在无法证明归属时杀进程或删租约；
  - 租约 owner 必须精确等于 manifest owner（`lease.pid ===
    manifest.owner.pid`）；dead 或 live 的第三方 owner 均为 `needs_human`，
    进程组、租约和 manifest 原样保留；
  - 新 executor record 写入 `runtimeId`（reaped / needs_human，以及报告中的
    skipped）；manifest 持久化同一记录；legacy 无 `runtimeId` 的记录仍可读，
    `status` 依次回退到 manifest `runtimeId` 和目录名；
  - `src/supervisor/cli.ts` 不再做第二次 preflight、不按 state/reason 反推 id，
    源码不含 NUL 分隔符。
- **测试端口隔离（`test port` pools）**
  - 六个会启动真实进程或绑定真实端口的 runtime 测试文件使用
    `tests/test-port-ranges.ts` 的静态、互不重叠端口池（22000–22599，每个文件
    100 个）；shell verifier 保留 21400–21499 与 21500–21599；
  - 池在 import 时断言反转/重叠，取范围时对池耗尽抛错；每次分配仍走真实
    `PortAllocator` 探测与重试；
  - 仅限本仓库测试进程隔离，不是生产、跨 run 或跨仓库端口协调。
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
- 第三方 dead owner 租约的自动回收（按 hardening 规则只能 `needs_human` 并保留
  证据）；
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
- HTTPS、TCP-only readiness、自定义优雅关闭命令或日志轮转；
- 生产级、跨 run 或跨仓库端口协调（测试端口池不是该能力）；
- CI 或跨主机上的长期 flake 率结论（本轮只有本机连续 5 次全量运行）。

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
| 13 | 租约 owner PID 必须等于 manifest owner；dead/live 不符均 `needs_human` | 已实现 | `runtime-owner-lease-safety`：相同 dead owner 可回收；dead/live 第三方 owner 均保留组、租约和字节级不变的 manifest |
| 14 | recovery record 与 manifest 自带 `runtimeId`；legacy 记录可读 | 已实现 | `runtime-recovery-record`：reaped/skipped/needs_human；持久化记录与报告一致；无 id legacy 记录可读 |
| 15 | Supervisor 不按 state/reason 反推 id，输出无 NUL | 已实现 | `supervisor-runtime-recovery-record`：相同 reason 的多个 runtime 标签仍正确；`status` 优先记录 id 并支持 legacy 回退 |
| 16 | runtime 测试文件端口池互不重叠 | 已实现 | `test-port-ranges`：import 时断言；12 个 runtime/恢复文件单独运行全部通过 |

未覆盖的能力不会被写成“已实现”：跨主机回收、leader-dead 自动 kill、daemon
周期回收、Windows 进程身份、生产或跨仓库端口协调。

## 2. 验证（2026-10-27，本工作树，macOS）

```text
npm run build   → 通过
npm test        → 164/164 通过，连续 5 次
```

5 次全量运行均为独立的 `npm test` 进程，在本工作树顺序执行：

| 次数 | 结果 | test-runner duration |
|------|------|----------------------|
| 1 | 164/164 通过 | 8.44 s |
| 2 | 164/164 通过 | 8.45 s |
| 3 | 164/164 通过 | 8.17 s |
| 4 | 164/164 通过 | 8.29 s |
| 5 | 164/164 通过 | 8.16 s |

本轮未观察到 flake；这是本机 macOS 证据，不是长期 flake 率或 CI 结论。

Runtime/恢复相关 78 项（12 个文件）：

```text
tests/contract-runtime.test.ts                     10
tests/runtime-ports.test.ts                        10
tests/runtime-manager.test.ts                       8
tests/runtime-manager-identity.test.ts              5
tests/runtime-process.test.ts                       8
tests/runtime-verifier.test.ts                      5
tests/runtime-owner-lease-safety.test.ts            3
tests/runtime-recovery-record.test.ts               3
tests/runtime-reaper-plan.test.ts                   9
tests/runtime-reaper.test.ts                       10
tests/supervisor-runtime-reaper.test.ts             5
tests/supervisor-runtime-recovery-record.test.ts    2
```

上述 12 个文件另在本轮各单独运行一次，全部通过。

端口隔离：六个会启动真实进程或绑定真实端口的 runtime 测试文件从
`tests/test-port-ranges.ts` 取静态、互不重叠的端口池（22000–22599，每个文件
100 个）；shell verifier 保留 21400–21499 与 21500–21599。helper 在 import 时
断言反转/重叠，取范围时对池耗尽抛错；每次分配仍走真实 `PortAllocator`
探测/重试。该机制只防止本仓库测试文件互相重叠，不是生产端口注册表、跨 run
协调器或跨仓库能力。

进程级覆盖包括：真实 detached RuntimeManager 服务 + owner SIGKILL、SIGTERM 不退出
时的 SIGKILL 升级、leader 已死但组内仍有成员、外部进程占用端口、并发 reaper
串行化，`reap`/`start`/`resume` 作为独立子进程运行，精确租约 owner 关联
（相同 dead owner 可回收；dead/live 第三方 owner 均为 `needs_human` 且证据原样
保留），以及 reaped/skipped/needs_human 三类的 `runtimeId` recovery record
（包含无 id 的 legacy 记录仍可读）。`src/` 字节扫描未发现 NUL；Supervisor 输出
测试也断言无 NUL 分隔符。没有跨主机或 daemon 清理演练，也没有相应能力声明。

此前 RuntimeManager v0（reaper 之前）的运行证据仍然有效：checked-in example
在租约端口上 accepted 且 `cleanup=complete`；两个重叠验收使用不同端口并各自
留下独立 manifest；真实 Claude + DeepSeek scratch run 只修改
`runtime-smoke.txt`，服务以 `SIGTERM` 结束，租约表为空。本轮没有重跑这些外部
Worker 演练，因此不把它们当作 reaper 或跨主机证据。

## 3. 下一迭代范围

本轮 hardening 已完成，不在下一迭代重复。下一迭代只做两件事：

1. **进程级失败演练**
   - 在独立进程中分别观察 readiness 超时、verifyCommand 失败和 cleanup 失败；
   - 确认失败路径不静默 accepted，原日志、端口、pid/pgid 与裁决理由都保留；
   - 对 `needs_human` 路径做一次 scratch repo 事故演练，按
     [RUNTIME_ORPHAN_RECOVERY.md](RUNTIME_ORPHAN_RECOVERY.md) 的证据清单操作。

2. **证据与文档复核**
   - 只按实测结果更新 README / NEXT_ITERATION / RUNTIME_MANAGER /
     RUNTIME_ORPHAN_RECOVERY；
   - 记录旧 runtimeId、owner、pid/pgid、租约、动作、端口和最终测试输出；
   - 复核 hardening 证据（精确 lease owner、record runtimeId、NUL 扫描、
     连续 5 次运行），不把 5 次本机结果写成 CI 或长期 flake 结论；
   - 若文档与实现不一致，先修文档，不扩大能力声明；
   - 保持“无 daemon、无 SQLite、无跨主机、无浏览器证据”的边界。

不在本迭代范围：

- 生产、跨 run 或跨仓库端口协调（测试端口池只服务本仓库测试文件）；
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
6. [已完成] `npm run build` 与 `npm test` 通过，完整套件连续 5 次实测
   164/164，runtime/恢复相关 78/78。
7. [已完成] 文档不宣称 daemon、SQLite、Playwright/axe、截图/无障碍证据、
   无限并发、跨主机回收或 leader-dead 自动回收。
8. [已完成] 租约 owner PID 必须精确等于 manifest owner；dead/live 不符均
   `needs_human`，进程组、租约和 manifest 保留。
9. [已完成] 新 recovery record 携带 `runtimeId` 并持久化；Supervisor 直接使用
   记录 id，不按 reason 反推；legacy 记录仍可读；源码无 NUL。
10. [已完成] 六个 runtime 测试文件使用不重叠静态端口池；5 次连续全量运行
    未观察到 flake；不宣称生产或跨仓库端口协调。

## 5. 下一步顺序

```text
1. [已完成] RuntimeManager v0 实现
2. [已完成] Runtime Orphan Reaper v0：preflight + executor + supervisor 集成
3. [已完成] 完整套件连续 5 次 164/164；runtime/恢复 78/78
4. [已完成] 真实 owner SIGKILL、SIGTERM 升级、leader-dead、外占端口、
            并发 reaper、start/resume fail-closed，以及本轮 hardening
            （精确 lease owner、record runtimeId、Supervisor 无 NUL、测试端口池）
5. 下一迭代：独立进程中的 readiness / verify / cleanup 失败演练
6. 下一迭代：按事故清单做 scratch repo 证据演练并记录实测输出
7. 复核文档，不新增跨主机、daemon、生产/跨仓库端口协调或 leader-dead
   自动回收声明
```

## 6. 上一迭代状态

Supervisor v0（前台、原子 JSON RunManifest、进程级 SIGKILL 恢复）已完成，
其操作语义与自举手册见 [docs/SUPERVISOR_V0.md](SUPERVISOR_V0.md)。当前完整套件
包含 supervisor 测试（164/164 通过）。本轮没有引入 daemon 或 SQLite，也没有
把 supervisor 的后台化列入计划。

---
name: cliyard-execution-routing
description: Use when selecting a CLI and model execution profile for cliyard tasks, designing provider-neutral routing, or planning bounded hierarchical parallelism across bindings with unknown capacity.
---

# Cliyard Execution Routing

## Goal

为任务选择“当前实际可用且能力匹配”的 CLI + model + provider binding；
同时保持 provider-neutral、secret-free、可审计和 fail-closed。

路由不是固定选择某个品牌，也不是让 LLM 直接决定系统并发。

## Model the Binding

至少分开表达：

- runtime/CLI；
- model；
- provider；
- opaque endpoint/account binding reference；
- capabilities；
- observed concurrency、quota、balance、pricing、latency 与 pass rate。

不得持久化 API key、endpoint URL、cookie、账号数据或完整 provider transcript。

## Three Real-world Shapes

```text
A: 一个 API/订阅有多个模型，多个 CLI 能消费
B: 一个 API/订阅有多个模型，但只有一个 CLI 能消费
C: 只有一个模型，但多个 CLI 可以配置它
```

选择步骤：

1. 从任务 Plan 提取能力需求：代码、视觉、长上下文、工具、结构化输出、会话恢复、运行时长。
2. 列出当前 really active bindings；未做 activation 的 profile 只是候选标签。
3. 排除 capability 不兼容项。
4. 依据已知 quota/balance/cost 和 current health 过滤。
5. 对 unknown binding 只发一个 probe。
6. 记录 deterministic routing reason、profile、估计和后续观测。

## Current ExecutionProfile

当前实现中的 profile 可包含：

```json
{
  "version": 1,
  "profileId": "queue-codex-...",
  "runtimeId": "codex",
  "modelId": "deepseek-v4-pro",
  "providerId": "deepseek",
  "endpointRef": "opaque-reference",
  "accountBindingId": "opaque-reference",
  "capabilities": {
    "mappedProgress": false,
    "providerSessionResume": false
  }
}
```

capabilities 必须由 runtime 实现推导并校验，不能由 profile 文件随意声明。
只有实际支持的组合才允许 deadline auto-extension 或 budget continuation。

## Admission

并行容量是多个约束的最小值，不是某一个并发数字：

```text
queue item limit
task limit per item
global task limit
runtime limit
visual/browser limit
CPU / RAM / disk pressure
port and data isolation
provider binding capacity
budget and attempt policy
```

两级并行：

- inter-item：多个 branch/queue item；
- intra-item：单 Plan 的 ready wave。

两级共享全局硬约束。未知 provider profile 初始 in-flight=1；
`3` 只可作为 warm start。收到 429、rate-limit、额度或资源反馈后再校准。

## Deterministic Inputs

路由建议至少记录：

```text
task requirements
approved contract
candidate profiles
capability match
known capacity / unknown
host and runtime pressure
estimated cost/time
actual cost/usage after run
failure category
routing decision and reason
```

LLM 可以提供 complexity signals 和取舍解释；机械准入、并发上限、
budget guard 和最终路由记录应由控制面计算。

## Do Not Claim

以下能力当前不能声称已实现：

- 完整 `ProfileCatalog`；
- endpoint/account 的真实 activation；
- 基于长期 telemetry 的动态评分；
- 全局分层 parallel admission；
- 无限 provider 并发；
- 从订阅名称推导当前限额、余额或单价。

本 Skill 可以用于设计下一步和审查 profile 合法性，但真实派发仍受当前代码能力限制。

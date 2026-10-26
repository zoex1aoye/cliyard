# 任务拆分、费用、耗时与轮次估算

> 依据：2026-10-26 WinUI 3 Key Mind 实跑与 DeepSeek 官方价格页。  
> 工具：`npm run estimate-plan -- <plan.json>`

## 1. 一个任务应该是什么

任务不是“一个文件”“一个组件”或“一段聊天”，而是：

> **一个可以独立裁决 accepted/rejected 的交付单元。**

一个任务应满足：

- 一个主要能力或一个明确修复；
- 一个 artifact family；
- 一组不冲突的 writePaths；
- 少量可执行 verifyCommands；
- 一个可理解的成功/失败原因；
- repair 时能明确知道要改什么。

如果一个任务同时包含：

- 设计决策；
- 多个组件；
- Demo；
- build；
- 浏览器验收；
- 集成与视觉回归；

通常已经过大。

## 2. 四档任务规模

| 档位 | 典型范围 | turns | 耗时 | Claude guard | DeepSeek 实费（空闲） | 处理 |
|---|---|---:|---:|---:|---:|---|
| S | 文档、小修、单属性、单测试 | 5–15 | 1–4 分钟 | $1 | ¥0.03–0.20 | 直接派发 |
| M | 单组件实现或 Demo/QA 单项 | 20–40 | 4–9 分钟 | $4 | ¥0.20–0.60 | 直接派发 |
| L | 单组件 + Demo + 多状态 + build | 35–70 | 6–15 分钟 | $8 | ¥0.30–1.20 | 可派发，优先拆 Demo/QA |
| XL | 多组件、共享基础、跨模块、复杂集成 | 60–120 | 12–30 分钟 | $12 | ¥0.80–2.50 | 默认先拆 |

这些是计划区间，不是报价。

## 3. 本次实跑校准

| 任务 | turns | 耗时 | Claude 本地 cost | output tokens | 实际特征 |
|---|---:|---:|---:|---:|---|
| Foundation | 24 | 约 5 分钟 | $2.17 | 58.5K | 470 行 token、一次 build |
| WinButton | 66 | 约 12 分 20 秒 | $7.05 | 128.1K | 四 variant、三尺寸、Demo、多状态 |
| WinTextField | 45 | 约 6 分 13 秒 | $3.23 | 65.2K | wrapper、ARIA、Demo、多状态 |
| 三路 API reset | 16–19 | 约 99 秒 | $0.66–0.74 | 13–14K | 未产出可接受 artifact |

结论：

- turns 与实际耗时强相关，但 output token 更决定模型实费；
- Demo 和复杂状态会显著增加 turns；
- 传输失败也会消耗 token，却没有形成 accepted artifact；
- Claude Code 的 `total_cost_usd` 不可直接当作 DeepSeek 账单。

## 4. 两种成本口径

### Claude guard budget

`--max-budget-usd` 是 Claude Code 的本地停机保护，用于防止 runaway：

```text
S: $1
M: $4
L: $8
XL: 先拆，不直接 dispatch
```

这个数字故意保守，不等于实际扣费。

### DeepSeek token cost

DeepSeek 官方 `deepseek-flash` 价格：

```text
缓存命中输入：¥0.02 / 百万 tokens（空闲）
缓存未命中输入：¥1 / 百万 tokens（空闲）
输出：¥4 / 百万 tokens（空闲）
高峰：全部 ×2
```

公式：

```text
CNY =
  cache_hit_tokens / 1_000_000 * 0.02
  + uncached_input_tokens / 1_000_000 * 1
  + output_tokens / 1_000_000 * 4
```

按空闲价格粗算本次已 accepted 任务：

- Foundation：约 **¥0.31**
- WinButton：约 **¥0.73**
- WinTextField：约 **¥0.38**

而 Claude 本地保护值合计约 **$12.46**。数量级不同，必须分开记录。

## 5. 拆分模板

复杂组件不要写成一个 XL task，按以下边界拆：

```text
D1 API / design contract
  → public props, slots, events, states, non-goals

I1 implementation
  → one component file

D2 demo/lab
  → one demo file, depends on I1

V1 runtime/visual evidence
  → screenshots, a11y, known deviations, depends on D2

A1 assembly
  → barrel/export/navigation only, depends on all accepted pieces
```

### 什么时候可以合并

以下是合理的单任务组合：

- 一个组件文件 + 对应 Demo；
- 一个 foundation token 文件 + build；
- 一个 assembly 任务更新 barrel 和 App；
- 一个小修复 + 一个小测试。

### 什么时候必须拆

- 多个独立组件；
- 同时修改 theme 和多个消费者；
- 同时实现业务逻辑和视觉验收；
- 多个公共资源需要串行；
- task 预计超过 70 turns；
- verifyCommands 超过 7 条且对应不同证据类型；
- 同一任务有多个可独立打回的验收目标。

## 6. 预算与并发

- DeepSeek `deepseek-flash` 官方并发 2500，不是 3。
- 本机默认 `CLIYARD_CLAUDE_MAX_CONCURRENT=3` 是 CPU、内存和成本保护。
- 429 才表示 provider 并发不足。
- ECONNRESET、超时和 5xx 由 adapter 做有限重试。
- 任务总预算按所有 ready tasks 的 guard budget 求和。
- wall-clock 不等于总预算时长；parallel 时要按 wave 计算最大值，再累加 wave。

## 7. 工具使用

```bash
npm run estimate-plan -- plan.json
```

输出每个任务：

```text
size
score
turns range
wall time range
output token range
guard budget
DeepSeek CNY range（空闲/高峰）
recommended repair budget
complexity drivers
split recommendation
```

该估算器是启发式规则，后续应逐步用每类任务的真实 turns、tokens、耗时和
repair 历史替换固定区间。


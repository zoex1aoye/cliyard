# cliyard 愿景与目标

本文记录我们要解决什么问题、理想效果是什么，以及和开源编排实践对齐的设计原则。实现以本文为准逐步逼近；v0 只覆盖其中一部分。

---

## 1. 要解决的痛点

在真实全栈 / 多模块开发里，最耗人的不是「AI 会不会写代码」，而是：

1. **一直确认**：权限弹窗、半途提问、每一步等你点头。  
2. **方向漂移**：做着做着偏离需求/原型，人要反复把 AI 拉回来。  
3. **上下文崩坏**：主会话又派工又改代码，轮次一长就中断、遗忘、胡改。  
4. **并行打架**：多路同时改同一工作区，文件冲突、难以验收。

我们要的不是再自研一个聊天窗口，而是：**一个清醒的管家（Master）把任务送到验收，人只在契约与不可逆节点出场。**

**Master 壳 = [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（GUI + everything-is-a-plugin）**；  
**cliyard = 薄控制面**（契约、DAG、隔离、verify、ledger）。人在 DSH 里整理 Plan 与看监控；派发与状态真相在磁盘。第一步用户故事见 [USER_STORY_STEP1.md](./USER_STORY_STEP1.md)。

持续运行、独立运行态验收、临时端口租约和并行验收原则见 [MASTER_OPERATING_MODEL.md](./MASTER_OPERATING_MODEL.md)。
Harness 边界与 DSH 可替换性见 [HARNESS_BOUNDARIES.md](./HARNESS_BOUNDARIES.md)。

---

## 2. 理想效果（成功长什么样）

```text
人：在 DeepSeek Harness GUI 放好需求 / 原型 / 边界
        ↓
Master 壳（DSH）+ Master 插件（dsh-cliyard）：整理 Plan → TaskContract → 派发
        ↓
cliyard 控制面：选 CLI / 模型 / 强度 → worktree 隔离 → 门禁与摘要 → 接受 | 打回 | 有限重修
        ↓
Workers（厚）：各自 worktree + 各家 CLI（Codex / CodeBuddy / …）
        ↓
Verifier：重跑测试/build 等（不信任 Worker 自报「已通过」）
        ↓
监控台（DSH 插件）：读 ledger；人审合入 / 上线（不可逆）
```

理想体验：

- **少打断**：无人值守权限 + 可执行验收，代替人肉确认。  
- **少纠偏**：方向写进冻结契约（paths、验收命令、反例）；漂了就 reject/requeue，而不是长聊劝说。  
- **Master 不中断**：状态在磁盘（taskfile / ledger / 状态机），不在超长对话里；每轮只喂短摘要，或新会话 + resume pack。  
- **并行可控**：多模块 Plan 可连续派发；worktree + paths 不重叠；并发有上限（配额共用）。  
- **验收可证伪**：有命令、有 diff、有退出码；「我说做完了」不算数。  
- **监控可见**：不必翻终端才知道 running / verifying / repairing / accepted / rejected。

尚不作为第一步必达：自动完美合入、JetBrains PSI、强制 Docker、Windows WSL/CodeBuddy 真连（第二步再接）。

---

## 3. 终点对标：Linus 式验收

公开案例（Linux page-cache 相关系列，Claude Code 辅助）：Linus 在 **本人方向** 下用 LLM 产出代码、测试与说明初稿，**自己跑测量**，再交给社区审；审稿仍可能抓出 race，再打回或交给更熟该子系统的维护者。

这不是「全自动合入主线」，而是：

```text
专家定意图与品味 → AI 出高密度、可审的草稿 → 硬验收（测量/审稿）→ 不满意就打回
```

### 他实际 vs 我们要的终点

| | Linus 公开现状 | cliyard 终点愿景 |
|--|----------------|------------------|
| 谁当导演 | 人自己盯着 CLI/助手 | **Master** 当清醒管家 |
| 人干什么 | 方向、测量、社区审 | **给需求和描述**；回来做最终验收 |
| 中间过程 | 人仍可能频繁介入 | 契约 + 派发 + gate + 有限重修 |
| 「满意」 | 够格拿去认真审；仍可能有缺陷 | 回来看到的是 **愿意认真认领去审** 的结果 |

终点句：

> **像 Linus 那样只提供意图与品味标准；像维护者那样只做最终验收；中间的派工、校准、机器门禁交给 Master，使人不必一直确认、把漂了的方向拉回来。**

### 「回来会满意」至少包含

1. **契约清晰**：问题、边界、不可破坏的不变量（业务/接口/目录；内核语境下则是并发与内存模型等）。  
2. **可证伪产物**：代码 + 测试 + 说明（类 cover letter）+ 本地测量或日志。  
3. **独立硬审**：gate 重跑；最好另模型/另角色只读审；人主要看摘要与 diff。  
4. **允许打回**：race / 偏航 → reject、有限 repair、或 `needs_human`——**满意包含「不合格被拦住」**。  
5. **人只出两次场**：开头定需求；结尾验收（及不可逆合入）。

「满意」≠ 免免审、零缺陷；= **达到专家愿意认真审、且大概率接近可合入的质量**，而不是一堆半成品聊天记录。

AI 放大执行；品味与最终责任仍在人；Master 负责让中间过程不再烦人。

---

## 4. 角色分工

| 角色 | 职责 | 不做什么 |
|------|------|----------|
| **人** | 定/改契约；审不可逆（合主支、发布） | 不当逐步陪聊纠偏员 |
| **Master** | 壳在 DSH GUI；插件派发/校准/裁决；状态信 cliyard ledger | 不自己写大段业务代码；不把全程轨迹塞进上下文；不以 DSH Jobs 冒充多 CLI 隔离 |
| **Worker** | 在隔离 worktree 内实现 | 不改契约、不越权改 paths 外文件 |
| **Verifier** | 独立重跑 gate；可选另一模型只读审 | 不当实现者 |

校准方式优先：**新会话 + 自包含 briefing**（类 Paseo handoff/advisor），而不是在原会话里越聊越偏。

---

## 5. 设计原则（向开源实践对齐）

行业里靠谱的编排（CodeBuddy/Claude Workflows、orchestration-playbook、vloop、Ouroboros、Paseo skills 等）共同点是：

1. **确认 → 门禁**：bypass/沙箱减少人点；绿不绿看 exit code。  
2. **方向 → 契约**：无合同不派工；边界与验收写死。  
3. **上下文 → 账本**：计划与中间结果在脚本/DB/文件；LLM 会话保持薄。  
4. **完成 → 外证**：Worker 自报无效；验收侧重跑；有限轮 repair，防止无限修。  
5. **并行 → 隔离**：worktree/分支；同模块串行，跨模块才并行。  
6. **Docker 可选**：不强制；优先本机已有 CLI + OS 沙箱（Seatbelt/bwrap 等）。

反模式：

- 一个超长会话既当 Master 又当唯一 Worker。  
- 用「再解释一遍需求」代替打回重派。  
- 把并行 shell 当产品，却没有契约与验收。

---

## 6. 目标闭环（产品状态机）

单任务理想路径：

```text
draft → dispatched → running → verify → (repair ≤ N) → accepted | rejected | blocked | needs_human
```

批量：多个任务并行到 `verify/accepted`，再由人或 Master 策略合入。

Master 每轮只需：

- 当前任务卡（或 id）  
- 上次 verdict / gate 输出摘要  
- diffstat / 失败日志尾  

不必重放 Worker 全程对话。

---

## 7. 与当前实现（v0）的差距

| 已有 | 尚未有 / 进行中 |
|------|------------------|
| Darwin mock 闭环、DAG、`mock-batch`、ledger、可选 shell verify、Plan→Contract bridge | 自然语言 Plan 仍由 DSH 模型整理；目前没有独立的 planner 模型/UI 表单 |
| Windows → WSL 桥、`doctor`、`run`/`batch` | CodeBuddy 真连与同账号并行（第二步） |
| Codex worker spike（本机） | 语义验收（轻索引 / JetBrains 按需） |

路线：见 [USER_STORY_STEP1.md](./USER_STORY_STEP1.md) Spike S1→S2 → Windows/CodeBuddy；细节 [MVP_IMPLEMENTATION_PLAN.md](./MVP_IMPLEMENTATION_PLAN.md) §10。

---

## 8. 一句话

**DeepSeek Harness = Master 壳（GUI + 插件）；cliyard = 多 CLI 控制面（契约 / 隔离 / 门禁 / ledger）。状态出聊天，人把需求与原型交给 Master，派给合适的 code agent CLI 并行隔离执行，在监控台看进度——回来验收的应是愿意认真认领的结果（Linus 式终点）。**

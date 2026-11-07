# Step 1 用户故事 · 原型对齐稿

> 对应 [`docs/USER_STORY_STEP1.md`](../../../docs/USER_STORY_STEP1.md)。
> 目的：确认「DSH/Cordis 借壳 ≠ 改用户故事」——仍是本机 CLI 派发。

## 怎么看

打开同目录 `index.html`（五屏可切换），或直接看 JPG：

| 屏 | 文件 | 对齐什么 |
|---|---|---|
| 01 端到端流 | `cliyard-proto-01-flow.jpg` | Plan → Freeze → local CLI → Verify → 人合入 |
| 02 Plan 会话 | `cliyard-proto-02-plan-session.jpg` | DSH 里整理 Plan；聊天非真相 |
| 03 冻结派发 | `cliyard-proto-03-freeze-dispatch.jpg` | 契约锁死；派本机 CLI @ worktree |
| 04 并行监控 | `cliyard-proto-04-parallel-monitor.jpg` | 两路隔离并行；状态可见 |
| 05 证据合入 | `cliyard-proto-05-evidence-merge.jpg` | 证据可审；合入仍是人 |

## 刻意没有画的

- 自动合入 `main`
- 平台内置 coding engine 替代本机 CLI
- Landlock / 端口租约 / SQLite 作为用户可见主路径

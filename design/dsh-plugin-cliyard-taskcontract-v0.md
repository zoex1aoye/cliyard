# dsh-plugin-cliyard — 全场景 TaskContract v0（草案）

> Status: `reviewed-draft` candidate (2026-11-08 Asia/Shanghai).
> Active roadmap authority: [docs/ROADMAP.md](../docs/ROADMAP.md) M0–M4;
> [docs/CURRENT_STATE.md](../docs/CURRENT_STATE.md).
>
> 止损前提：作为 **DSH 插件** 借壳；冷冻自研 SQLite ledger / Landlock /
> 端口租约 / 进程树 ownership。真相只留：设计 → 冻结契约 → 场景驱动执行 →
> 确定性验收。底层会话、LLM、dispose、跨平台由 DSH/Cordis 承担。

## 1. 契约在流水线里的位置

```text
DSH 会话（样本 / 伪代码 / Demo 提示）
  → ctx.cliyardCompiler   产出 Plan.json（未冻结）
  → 人审 + /freeze
  → ctx.cliyardContract   产出 frozen TaskContract.json（本 Schema）
  → 场景 Driver（code | novel | drama）
  → verify（纯命令/断言，不经模型）
  → Cordis subCtx.dispose 回收
```

Plan 是可改的对话产物；**TaskContract 是冻结后不可静默改字节的执行边界**。

## 2. 拍板（相对上一稿）

| 问题 | 决定 |
|---|---|
| `cli.target` / 执行入口 | **注册表 id**，禁止契约内写本机绝对路径 |
| 文风 / 伪代码 / Demo 样本 | **权威在 `intent.assets[]`**；派发时由 Driver 投影到 prompt / stdin / API body |
| 多步 | **Plan → `contracts[]`**，每步一张可单独 freeze 的契约；契约内不设 `steps[]` |
| 执行器形态 | 用 **`driver.kind`** 区分，不全塞进 `spawn`：本机 CLI / DSH LLM / 外部 API |

## 3. 通用外壳（所有场景必填）

```json
{
  "contractVersion": 1,
  "contractId": "ep3-draft",
  "scene": "novel",
  "frozen": true,
  "frozenAt": "2026-11-07T16:20:00+08:00",
  "planId": "creator-batch-11",
  "dependsOn": [],

  "intent": {
    "goal": "按既定文风写第 3 集草稿",
    "nonGoals": ["不改写第 1–2 集", "不发布"],
    "acceptance": ["episodes/ep3.md 存在", "文风 checklist 通过"],
    "assets": [
      {
        "id": "voice-sample",
        "kind": "text",
        "path": "samples/voice.md",
        "role": "style"
      }
    ]
  },

  "workspace": {
    "kind": "assets",
    "path": ".cliyard/assets/ep3-draft",
    "writeRoots": ["episodes/ep3.md"],
    "snapshotFrom": "samples/voice.md"
  },

  "driver": {
    "kind": "dsh-llm",
    "target": "dsh.chat",
    "timeoutSec": 1800
  },

  "sandbox": { "mode": "none" },

  "verify": {
    "commands": [
      { "argv": ["test", "-f", "episodes/ep3.md"], "cwd": "workspace" }
    ]
  },

  "cleanup": {
    "onCancel": "dispose-child",
    "keepWorkspace": true
  }
}
```

### 外壳字段

| 字段 | 含义 | 规则 |
|---|---|---|
| `contractVersion` | Schema 版本 | 目前恒为 `1` |
| `contractId` | 稳定 id | 同 Plan 内唯一；可作 worktree/assets 目录名 |
| `scene` | 场景标签 | `code` \| `novel` \| `drama`（路由/展示用；执行以 `driver` 为准） |
| `frozen` / `frozenAt` | 冻结标记 | `/freeze` 写入；之后改字节必须新版本 |
| `planId` | 来源 Plan | 可追溯，非执行权威 |
| `dependsOn` | 上游 `contractId[]` | 真实产物依赖；不是启动顺序装饰 |
| `intent` | 设计真相 | 人/Master 所有；含 `assets[]` |
| `workspace` | 磁盘笼子 | `git-worktree` 或 `assets`；`writeRoots` 必填 |
| `driver` | 谁执行 | 见 §4；`target` 为注册表 id |
| `sandbox` | 可选包裹 | 阶段 1 默认 `none`；`docker` / `low-priv` 后加 |
| `verify` | 确定性门禁 | 纯 argv；不经模型 |
| `cleanup` | 取消语义 | Cordis `dispose` 杀子进程/取消请求；默认保留 workspace |

### `intent.assets[]`

| 字段 | 说明 |
|---|---|
| `id` | 契约内引用名 |
| `kind` | `text` \| `image` \| `video` \| `audio` \| `code` \| `url` |
| `path` 或 `uri` | 二选一；`path` 相对仓库或 workspace |
| `role` | `style` \| `spec` \| `reference` \| `input` \| `fixture` |

Driver **只读** assets；不得把临时 stdin 当成唯一真相。

### `workspace`

| `kind` | 用途 | 阶段 1 |
|---|---|---|
| `git-worktree` | 代码交付；`baseRef` 必填 | `git worktree add` |
| `assets` | 小说/短剧等非 git 主线资产 | `mkdir`；可选 `snapshotFrom` |

`path` 即 Driver 的工作根（CLI 的 `cwd`，或文件产出根）。`writeRoots` 相对 `path`，越界即失败。

## 4. `driver` 三形态（场景共用）

`driver.kind` 判别；公共字段：`target`（注册表 id）、`timeoutSec`。

### 4.1 `local-cli` — 本机 CLI（最高优先级 / 阶段 1 空转）

```json
{
  "driver": {
    "kind": "local-cli",
    "target": "claude",
    "argv": ["-p", "Only write under writeRoots; follow intent."],
    "stdin": {
      "mode": "assets",
      "assetIds": ["spec-pseudo"]
    },
    "env": { "CLIYARD_RUN_MODE": "contract" },
    "timeoutSec": 1800
  }
}
```

- `target`：`claude` \| `codex` \| `opencode` \| `custom:<name>`（解析在 DSH tool registry）
- `stdin.mode`：`none` \| `json-assets` \| `text-assets` \| `raw`（`raw` 仅测试用）
- 禁止契约写可执行文件绝对路径

### 4.2 `dsh-llm` — 借 DSH 会话/Worker（小说等）

```json
{
  "driver": {
    "kind": "dsh-llm",
    "target": "dsh.chat",
    "systemAssetIds": ["voice-sample"],
    "userPromptTemplate": "根据 style assets 写 {{goal}}，只输出到 writeRoots。",
    "output": { "path": "episodes/ep3.md", "format": "markdown" },
    "timeoutSec": 1800
  }
}
```

不自研对话引擎；只声明用哪些 assets 当 system/style，产出落到 `workspace.path`。

### 4.3 `external-api` — 多模态 / 第三方（短剧等）

```json
{
  "driver": {
    "kind": "external-api",
    "target": "multimodal.render",
    "request": {
      "templateId": "storyboard-v1",
      "styleAssetIds": ["look-ref"],
      "scriptAssetIds": ["beat-sheet"]
    },
    "output": { "path": "renders/ep3/", "format": "files" },
    "timeoutSec": 3600
  }
}
```

`target` 仍是注册表 id；密钥只在 DSH/Cordis 配置，**永不进契约**。

## 5. 三场景最小实例

### 代码（local-cli + git-worktree）

```json
{
  "contractVersion": 1,
  "contractId": "fix-login-rate-limit",
  "scene": "code",
  "frozen": true,
  "frozenAt": "2026-11-07T16:20:00+08:00",
  "planId": "auth-hardening",
  "dependsOn": [],
  "intent": {
    "goal": "为 /login 增加简单速率限制",
    "nonGoals": ["不改注册流", "不做分布式限流"],
    "acceptance": ["单测通过", "手工 curl 429 可复现"],
    "assets": [
      { "id": "spec-pseudo", "kind": "code", "path": "design/login-rate-limit.md", "role": "spec" }
    ]
  },
  "workspace": {
    "kind": "git-worktree",
    "path": ".cliyard/worktrees/fix-login-rate-limit",
    "baseRef": "main",
    "writeRoots": ["src/auth/", "tests/auth/"]
  },
  "driver": {
    "kind": "local-cli",
    "target": "claude",
    "argv": ["-p", "Implement the frozen contract; write only under writeRoots."],
    "stdin": { "mode": "assets", "assetIds": ["spec-pseudo"] },
    "env": { "CLIYARD_RUN_MODE": "contract" },
    "timeoutSec": 2400
  },
  "sandbox": { "mode": "none" },
  "verify": {
    "commands": [
      { "argv": ["npm", "test", "--", "tests/auth/rate-limit.test.ts"], "cwd": "workspace" }
    ]
  },
  "cleanup": { "onCancel": "dispose-child", "keepWorkspace": true }
}
```

### 小说（dsh-llm + assets）

见 §3 外壳示例。

### 短剧（external-api + assets）

```json
{
  "contractVersion": 1,
  "contractId": "drama-ep1-storyboard",
  "scene": "drama",
  "frozen": true,
  "frozenAt": "2026-11-07T16:20:00+08:00",
  "planId": "short-drama-pilot",
  "dependsOn": [],
  "intent": {
    "goal": "根据分镜与画风参考生成第 1 集关键镜头静帧",
    "nonGoals": ["不做配音", "不调色成片"],
    "acceptance": ["renders/ep1/ 下至少 6 张静帧", "画风与 look-ref 一致（人工签收）"],
    "assets": [
      { "id": "beat-sheet", "kind": "text", "path": "scripts/ep1-beats.md", "role": "spec" },
      { "id": "look-ref", "kind": "image", "path": "refs/look.png", "role": "style" }
    ]
  },
  "workspace": {
    "kind": "assets",
    "path": ".cliyard/assets/drama-ep1-storyboard",
    "writeRoots": ["renders/ep1/"]
  },
  "driver": {
    "kind": "external-api",
    "target": "multimodal.render",
    "request": {
      "templateId": "storyboard-v1",
      "styleAssetIds": ["look-ref"],
      "scriptAssetIds": ["beat-sheet"]
    },
    "output": { "path": "renders/ep1/", "format": "files" },
    "timeoutSec": 3600
  },
  "sandbox": { "mode": "none" },
  "verify": {
    "commands": [
      { "argv": ["sh", "-c", "test $(ls renders/ep1 | wc -l) -ge 6"], "cwd": "workspace" }
    ]
  },
  "cleanup": { "onCancel": "dispose-child", "keepWorkspace": true }
}
```

## 6. 与旧 cliyard TaskContract 的关系

| 旧字段 | 本草案 |
|---|---|
| `goals` / `nonGoals` / `verifyCommands` / `writePaths` / `frozen` | 保留语义 → `intent` / `verify` / `workspace.writeRoots` |
| `baseCommit` | 仅 `workspace.kind=git-worktree` 时用 `baseRef`（解析在 freeze 时落成精确 SHA，可由插件写入旁路证据，不强制进契约） |
| `runtime` / `execution` continuity | **删除**（冷冻） |
| ProfileCatalog / admission / Routing A-B | **不进契约**；DSH 侧配置/拦截可选 |
| RunManifest / SQLite ledger | **不进契约**；阶段 1 用 Cordis 内存 + 现成落盘即可 |

反哺原仓库时：用本 Schema 证明「薄契约 + 可替换 Driver」足够跑通；旧硬核运行时保持冷冻，不作为 MVP 依赖。

## 7. 插件侧最小服务面（契约消费者）

1. **`ctx.cliyardCompiler`** — 会话 → 未冻结 Plan（含建议 `contracts[]` 草稿）
2. **`ctx.cliyardContract`** — `/freeze`：校验 Schema、写 `frozen/frozenAt`、拒绝缺 `writeRoots`/`driver.target`
3. **Drivers** — 按 `driver.kind` 分发；统一 `workspace.path` 为产出根；统一 `verify`；统一 `dispose`

阶段 1 只实现 `local-cli` + `/cliyard-test` mock 契约空转，不接 LLM 编译。

## 8. 非目标（再次冷冻）

- 自研进程树 identity / 端口租约 / SQLite 事件溯源
- 契约内密钥、绝对路径、endpoint URL
- 自动合入 `main`、自动 Plan 批准
- 默认-on OS sandbox / 无限并行 / 24h 无人值守宣称

## 9. 待你确认即可冻结为「插件契约面」

若无异议，下一动作只做文档级冻结（仍不写实现）：

1. 本文件改名为正式草案并标 `status: reviewed-draft`
2. 补一份 JSON Schema（`design/dsh-plugin-cliyard-taskcontract-v0.schema.json`）供 `/freeze` 校验
3. 阶段 1 mock 契约夹具（code 场景 `local-cli` + `echo`/`git`）

**不**重开 Routing / StateStore / Landlock 刀。

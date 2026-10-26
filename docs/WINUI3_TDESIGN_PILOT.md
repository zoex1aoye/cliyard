# WinUI 3 × TDesign 组件库试点

> 目标项目：`../ui-prototype`
>
> 定位：基于现有 Glass/TDesign 资产，形成一套 WinUI 3-inspired Web 设计语言，而非复制原生 Windows 控件。

## 1. 现状判断

`ui-prototype` 已经具备做试点的真实基础：

- 54 个 `Glass*` Vue 组件。
- `glass-frontend/src/styles/theme.css` 是视觉 token 权威。
- 已有 Mica、Acrylic、LayerFill、Overlay、Density、Tone 等规则。
- 已有 10 个 Lab 页面承载状态矩阵和 Living Demo。
- 已有 WinUI 3 容器栈、Surface/Mica、Mica/Acrylic 映射研究。
- 已有 `output/qa/*` 证据文档。
- `AGENTS.md` 明确禁止魔法色、第二 UI 库、修改 `node_modules` 和自动 commit。

因此不应该另建一套平行的前端工程，也不应该重写 54 个组件。

第一版应：

> 在现有 Glass TDesign 壳内冻结 WinUI 3 语言层，选取少量高杠杆组件形成参考实现，再扩展到完整组件库。

## 2. 设计命名边界

该项目应称为：

**WinUI 3-inspired / Fluent Web Components on TDesign**

不能宣称：

- 原生 WinUI 3。
- 像素级复刻 Windows OS。
- 真实复现 Mica 在桌面窗口系统中的采样行为。

Web 端能做的是：

- 语义化使用 Mica / Acrylic / Solid / Smoke 角色。
- 使用 Fluent 式层级、密度、圆角、焦点、动效和颜色克制。
- 用浏览器同视口截图验证设计意图。

## 3. 设计语言地基

地基必须先于组件任务冻结。

### 3.1 层级

```text
L0 Window / wallpaper field
L1 Mica / application base
L2 Region / PageHeader / navigation band
L3 Panel / Card / content plate
L4 Transient overlay / flyout / dialog
```

### 3.2 材料

| WinUI 角色 | Web 语义 | 使用范围 |
|---|---|---|
| Mica | 高遮罩、轻染、弱/无 blur | 应用基础面 |
| Acrylic | 透底、blur、saturate | 瞬态浮层、局部导航、Flyout |
| Solid / Smoke | 高不透明焦点面 | Dialog、表单、需要可读性的内容 |
| Empty / Transparent | 无边底 | 排版、稀疏操作区 |

### 3.3 控件尺度

首版使用现有仓库密度作为候选，不直接照搬 Windows 控件尺寸：

```text
Field / Pill: 38px
Regular control: 42px
Compact control: 32px
FAB: 52px
```

### 3.4 交互

- hover：轻微 lift / wash，不做大幅色散。
- pressed：回弹或轻压，不改变布局 bounds。
- focus-visible：高对比可见 ring。
- disabled / loading：锁定交互，不依赖颜色单一表达。
- reduce motion 时移除位移、旋转和循环装饰。

### 3.5 颜色

- 主色用于 action、selection、focus。
- 大面积 surface 只做轻 tint。
- 状态色用于含义，不做装饰渐变。
- 所有颜色必须落到 token。

## 4. 组件分层

### P0 参考组件

先选能覆盖大部分语言规则的组件：

1. `GlassButton`
2. `GlassInput`
3. `GlassSelect`
4. `GlassPanel`
5. `GlassDialog`
6. `GlassTable`

这些组件覆盖：

- 控件密度
- action hierarchy
- Mica/Acrylic/Solid
- 键盘焦点
- loading / disabled / error
- overlay
- 数据密集面

### P1 扩展

- Navigation: Tabs / Steps / Breadcrumb / Menu
- Feedback: Alert / Message / Notification / Progress / Skeleton
- Form: FormPane / Date / Time / Radio / validation
- Data: List / Descriptions / Empty / Statistic / Avatar

## 5. 连续任务图

```text
W0 Design Contract（人 + Master）
  │
  ▼
W1 Foundation
  theme semantics / material roles / density / focus / motion
  │
  ├──────────────┬──────────────┬──────────────┐
  ▼              ▼              ▼              ▼
W2 Button      W2 Input       W2 Panel       W2 Dialog
  │              │              │              │
  └──────────────┴──────┬───────┴──────────────┘
                        ▼
W3 Table / Data composition
                        ▼
W4 Lab integration + WinUI reference pages
                        ▼
W5 Runtime visual / a11y verification
                        ▼
W6 Design coverage reconciliation
```

### W0 · Design Contract

产物：

```text
design/winui3-tdesign/foundation.md
design/winui3-tdesign/component-matrix.md
design/winui3-tdesign/acceptance.md
```

人工确认后才能 freeze。

### W1 · Foundation

写路径：

```text
glass-frontend/src/styles/theme.css
glass-frontend/src/styles/winui3-tokens.css（如决定新增）
```

共享资源锁：

```text
theme:tokens
```

验收：

- token build。
- 无组件魔法色。
- Light / Dark 均有语义值。
- 不允许组件并行修改 foundation 文件。

### W2 · Reference Components

每个任务独占组件文件 + 对应 Lab 文件：

```text
GlassButton.vue + LabActionsView.vue
GlassInput.vue + LabInputsView.vue
GlassPanel.vue + LabLayoutView.vue
GlassDialog.vue + LabOverlayView.vue
```

依赖：

```text
W1 accepted
```

可以并行，但必须：

- writePaths 不重叠。
- 不修改共享 theme。
- 使用 foundation acceptance matrix。

### W3 · Composition

`GlassTable` 等复杂组件依赖 Button/Input/Panel 的公开行为与 token。

### W4 · Lab

创建 WinUI 3 profile 的独立 Lab 入口或现有页面中的 profile selector。

不能在第一轮擅自重排现有 DocsShell IA。

### W5 · Evidence

必须产出：

- build log。
- 目标路由。
- 1440×900 Light / Dark 截图。
- default / hover / focus-visible / pressed / disabled / loading / error。
- axe 结果。
- token diff。
- 未测项。

## 6. 用 Key Mind 启动试点

派发前必须把 W0 设计文件提交到 experiment branch。Git worktree 不会自动携带主工作区中未提交/未跟踪的 `.agents/tmp-*` 设计草稿。

### 第一步：设计文件

先人工和 Master 把 W0 写入目标工作区，不派 Worker。

### 第二步：编译契约

```bash
npm run plan-dispatch -- design/winui3.plan.json \
  --repo ../ui-prototype
```

检查：

- designRevision
- dependsOn
- writePaths
- sharedResources
- verifyCommands

### 第三步：Dry run

```bash
npm run plan-dispatch -- design/winui3.plan.json \
  --repo ../ui-prototype \
  --dispatch --worker claude \
  --dry-run --background
```

dry-run 只验证调度、依赖和工作区，不验证真实 UI。

### 第四步：真实执行

```bash
npm run plan-dispatch -- design/winui3.plan.json \
  --repo ../ui-prototype \
  --dispatch --worker claude \
  --model 'deepseek-flash[1m]' --background
```

只派已冻结的 Wave。

### 第五步：人审与 integration

检查：

- 每轮是否自动进入下一轮。
- 上游 token 是否被下游组件看到。
- Lab 是否只改约定文件。
- 是否存在越界 diff。
- 是否所有视觉证据齐全。

## 7. 第一个最小试点

不要一次实现 54 个组件。

第一轮只做：

```text
F0 WinUI 3 foundation contract
F1 Button
F2 Input
F3 Panel
F4 Lab reference section
F5 visual evidence
```

其中 F1/F2/F3 可以并行；F4 等三者 accepted；F5 等 F4。

跑通后再扩 Dialog、Table、Navigation 和 Feedback。

## 8. 当前工具前置

连续构造 baseline 已支持：

```text
accepted task
  → snapshot commit
  → integration branch
  → dependent worktree from new baseline
```

仍需补：

- Supervisor daemon。
- durable claim / lease / heartbeat。
- RuntimeManager 与临时端口。
- Playwright / axe evidence bundle。

因此第一轮工具试点应分为：

1. 无 API 的连续 DAG fixture。
2. Claude + DeepSeek 的真实小任务。
3. WinUI 3 单组件实现。
4. 运行态视觉验收。
5. 才扩成组件库。

## 9. 完成标准

WinUI 3 TDesign P0 完成的最低标准：

1. Foundation token 冻结。
2. 6 个参考组件可独立演示。
3. Light / Dark 均运行。
4. 键盘与 focus-visible 可用。
5. 状态矩阵完整。
6. 同视口视觉证据完整。
7. 组件不直接引用 TDesign 内部 DOM 或魔法色。
8. Lab IA 不被擅自改变。
9. 连续任务链无需用户重复派发。
10. 人只需处理设计裁决和最终视觉签收。


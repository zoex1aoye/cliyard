# 模块并行试跑（Windows + WSL + CodeBuddy）

对齐愿景见 [VISION.md](VISION.md)。本页只谈「明天怎么试」；理想闭环里的 Master 验收 / 有限重修尚未实现，先验证 **契约 → taskfile → 并行 worktree**。

## 流程

1. 目标仓库放在 **WSL 文件系统**；写入需求 / 原型路径。  
2. 短会话让 AI **只生成** taskfile（不要改业务代码）——对应愿景里「人定契约，AI 读说明再操作」。  
3. 人扫一眼 `paths` 是否重叠、`model` 是否合理。  
4. `cliyard batch` 派多路同账号 CodeBuddy。

```powershell
cd <cliyard>
copy config.example.yaml config.yaml
npm install
npm run doctor

npm run batch -- examples/module.tasks.yaml --dry-run
npm run batch -- path\to\your.tasks.yaml --max-parallel 2
```

## 预期结果（本阶段）

- 多条 `cliyard/...` 分支 + 各 worktree 内的 diff  
- JSON：每任务 `exitCode` / `diffStat` / `model`  
- 主工作区尽量干净  

尚未自动：verify gate、reject 重修、Master 裁决。验收暂时靠人看 diff。

## Tips

- 同账号配额共用，先 `max_parallel: 2`。  
- `paths` 不重叠，合入更省事。  
- model id 以本机 `codebuddy` 为准；先 dry-run。  
- 清理：`git worktree list` → `git worktree remove …` → 删分支。

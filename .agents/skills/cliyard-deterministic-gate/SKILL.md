---
name: cliyard-deterministic-gate
description: Use to run cliyard deterministic gates (build, full suite, path/boundary) at pre-dispatch and pre-merge; gates are shell-only and never routed through a model.
---

# Cliyard Deterministic Gate

## Outcome

在派发前和合入前，用纯 shell 命令确定性地验证 base / integration 是绿的，失败即挡住下一步。

## Pre-dispatch preflight

- 在 base 上跑 `npm run build` 和全量 `npm test`；
- 校验 WorkspaceBoundary 策略（`dist/`、`.cliyard/` 按目录排除）；
- 不绿则不派发，先确定性修 base。

## Pre-merge integration gate

- 所有任务 accepted 后，在 integration worktree 上跑全量套件 + build；
- 失败：run 标 blocked/needs_human，记录每条命令、退出码和日志尾；
- 不改写已 accepted 的任务 verdict；
- 门禁永远纯 shell，不经过模型。

## Rules

- focused tests 通过不等于全量回归；
- 门禁失败是确定性事实，不是模型建议，必须挡住 merge。

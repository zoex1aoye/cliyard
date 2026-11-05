---
name: cliyard-cost-truth-audit
description: Use to audit cliyard run cost truth before acceptance or merge: attempt accumulation, missing sessions, guard vs provider vs CLI cost, and aggregate coverage.
---

# Cliyard Cost Truth Audit

## Outcome

只读判断一个 run 的成本记录是否诚实、完整，并给出该成本证据是否可接受的结论。

## Checks

- 每个 task 的 attempt 成本是否累积，而不是被后续 attempt 覆盖；
- 中断、resume、provider 错误的场次是否显式标 `missing`，绝不静默丢弃或当 `$0`；
- run 级聚合是否覆盖每一场真实 session；
- `guardBudgetUsd` 是否与 `provider-reported` / `cli-estimated` / `usage-only` /
  `unavailable` 分开记录；
- 是否存在被错误包装成精确金额的 guard 或 CLI 估计。

只读审查：不修改 RunManifest、ledger、queue 或 evidence。

## Verdict

- `complete`：无缺失场、聚合覆盖全部 session、来源清晰；
- `partial`：有缺失场但已显式标出；
- `missing`：无法判断或状态 `unavailable`。

## Notes

- guard budget 是本地护栏，不是 provider 账单或余额；
- Claude CLI `total_cost_usd` 是非权威估计；
- 不推断 provider 余额、quota 或发票。

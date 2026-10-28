---
name: cliyard-runtime-verification
description: Use when a cliyard task needs build or preview services, browser checks, API readiness, leased ports, isolated runtime data, process cleanup or runtime evidence for acceptance.
---

# Cliyard Runtime Verification

## Principle

Worker 为了开发而启动的服务是 `worker_preview`，不能作为 acceptance runtime。

验收必须在 Worker 退出并且 path gate 通过后，从精确代码快照重新启动：

```text
static gates
  → runtime lease
  → exact-snapshot service start
  → process + port + readiness checks
  → smoke/E2E/API/a11y/visual checks
  → evidence freeze
  → process-tree cleanup + port release
  → verdict
```

## Contract Shape

只使用 argv 命令，不使用 shell command string。服务必须从任务 worktree cwd 启动，
端口由 RuntimeManager 分配并注入环境变量。

```json
{
  "runtime": {
    "services": [
      {
        "name": "web",
        "command": ["node", "scripts/serve.mjs"],
        "cwd": ".",
        "portEnv": "PORT",
        "urlEnv": "WEB_URL",
        "readiness": {
          "path": "/health",
          "expectedStatus": 200,
          "timeoutMs": 30000
        }
      }
    ]
  }
}
```

应用代码必须读取注入的 `PORT`，不要改写成项目默认端口。

## Runtime Procedure

1. Worker 实现并退出；先跑静态 build/typecheck/test。
2. 检查 exact artifact、write-path audit 和任务 worktree identity。
3. 为 `runtimeId + service` 申请 `127.0.0.1` 端口 lease。
4. 在任务 worktree 的精确 snapshot 上启动服务，记录 pid、pgid、OS start identity、log 和 data dir。
5. 等真实 readiness；检查进程仍活、端口监听、URL 状态和必要依赖。
6. 将 `WEB_URL` 等注入每条 `verifyCommands`；运行 E2E、API、a11y、截图和视觉对照。
7. 在 `finally` 语义下停止完整进程树，等待端口释放，再释放 lease。
8. 固化 RuntimeManifest、日志、截图、失败现场和 cleanup 结果。

## Isolation

每个 run/task/attempt 独立：

- 前端/API/数据库端口；
- database/schema 或临时数据目录；
- cache/upload/temp；
- browser profile 和 cookie/localStorage；
- service logs 和 readiness evidence。

多服务需要同源 cookie/CORS 时，优先为每个 run 使用独立反向代理地址；
不要让测试硬编码内部默认端口。

## Useful Commands

```bash
npm run mock-loop -- examples/runtime-verifier.contract.json \
  --real-verify --fail-verify-times 0

npm run runtime-drill -- --out <new-empty-dir> --port-base <disjoint-range> --json
```

测试/诊断端口池必须互不重叠。失败后确认没有监听进程或残留 lease。

## Failure Rules

- readiness 失败：保存日志，不运行依赖该服务的 verifyCommands，verdict 不是 accepted。
- 端口被占：重新 lease 或明确 blocked；不强行杀外部进程。
- cleanup 失败：保留现场，标 `cleanup-failed`/`needs_human`，不得宣称完成。
- 身份缺失或记录冲突：不 kill，交给人审。
- 只有端口可用：不能证明运行并发可无限扩大；还需 runtime/browser/CPU/provider admission。

## Evidence

至少保留：

- runtimeId、taskId、attempt、worktree、artifact identity；
- 每服务 host、leased port、pid/pgid/identity、URL、log、data dir；
- readiness attempts；
- smoke/E2E/a11y/visual 结果；
- cleanup 状态、exit code、failure reason；
- 目标视口截图和未验证项。

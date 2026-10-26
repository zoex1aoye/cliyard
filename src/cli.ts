#!/usr/bin/env node
import { loadConfig } from "./config.js";
import { discover } from "./discover.js";
import { runTask } from "./run.js";
import { runBatch } from "./batch.js";
import { loadTaskFile } from "./taskfile.js";
import { runMockLoopCli } from "./mock-loop.js";
import { runMockBatchCli } from "./scheduler/mock-batch.js";
import {
  runClaudeBatchCli,
  runCodexBatchCli,
} from "./scheduler/codex-batch.js";
import { runPlanDispatchCli } from "./planner/cli.js";
import { runEstimatePlanCli } from "./planner/estimate-cli.js";
import type { PermissionIntent, WorkerId } from "./types.js";

function usage(): never {
  console.log(`cliyard — control plane (+ Darwin Master spikes)

Usage:
  cliyard doctor
  cliyard run --repo <linux-path> --prompt "<task>" [--worker auto|claude|codex|codebuddy]
              [--model <id>] [--permission accept|bypass] [--dry-run]
  cliyard batch <taskfile.yaml> [--dry-run] [--max-parallel N]
  cliyard mock-loop [contract.json] [--fail-verify-times N] [--ledger path]
                    [--briefing-dir path] [--real-verify]
  cliyard mock-batch <contracts.json|taskfile.yaml> [--ledger path] [--real-verify]
                     [--fail-verify-times N]
  cliyard codex-batch <contracts.json> [--repo path] [--ledger path] [--model id]
                     [--dry-run] [--keep-worktrees]
  cliyard claude-batch <contracts.json> [--repo path] [--ledger path] [--model id]
                      [--dry-run] [--keep-worktrees]
  cliyard plan-dispatch <plan.json|-> --repo path [--dispatch]
                       [--worker claude|codex|mock] [--model id] [--out path]
                       [--ledger path] [--dry-run] [--cleanup]
  cliyard estimate-plan <plan.json|->

Master (DeepSeek Harness plugin / local demo):
  npm run master-monitor
  npm run master-dispatch
  See docs/USER_STORY_STEP1.md and plugins/dsh-cliyard/README.md
`);
  process.exit(1);
}

function arg(flag: string, argv: string[]): string | undefined {
  const i = argv.indexOf(flag);
  if (i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--")) return argv[i + 1];
  const eq = argv.find((a) => a.startsWith(`${flag}=`));
  return eq?.slice(flag.length + 1);
}

function has(flag: string, argv: string[]): boolean {
  return argv.includes(flag);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  if (!cmd || cmd === "-h" || cmd === "--help") usage();

  const cfg = loadConfig();

  if (cmd === "doctor") {
    const caps = await discover(cfg);
    console.log(JSON.stringify(caps, null, 2));
    if (!caps.wslOk) process.exit(2);
    const anyWorker = Object.values(caps.workers).some((w) => w?.ok);
    process.exit(anyWorker ? 0 : 3);
  }

  if (cmd === "run") {
    const rest = argv.slice(1);
    const repo = arg("--repo", rest) ?? cfg.default_repo ?? usage();
    const prompt = arg("--prompt", rest);
    if (!prompt) usage();
    const worker = (arg("--worker", rest) ?? "auto") as WorkerId | "auto";
    const permission = (arg("--permission", rest) ??
      cfg.permission) as PermissionIntent;
    const model = arg("--model", rest);
    const dryRun = has("--dry-run", rest);

    const result = await runTask(cfg, {
      repo,
      prompt,
      worker,
      permission,
      model,
      dryRun,
    });
    console.log(JSON.stringify(result, null, 2));
    process.exit(result.exitCode === 0 ? 0 : 1);
  }

  if (cmd === "batch") {
    const rest = argv.slice(1);
    const filePath = rest.find((a) => !a.startsWith("--"));
    if (!filePath) usage();
    const dryRun = has("--dry-run", rest);
    const maxRaw = arg("--max-parallel", rest);
    const file = loadTaskFile(filePath);
    const results = await runBatch(cfg, file, {
      dryRun,
      maxParallel: maxRaw ? Number(maxRaw) : undefined,
    });
    console.log(JSON.stringify(results, null, 2));
    const failed = results.some((r) => r.exitCode !== 0);
    process.exit(failed ? 1 : 0);
  }

  if (cmd === "mock-loop") {
    await runMockLoopCli(argv.slice(1));
    return;
  }

  if (cmd === "mock-batch") {
    await runMockBatchCli(argv.slice(1));
    return;
  }

  if (cmd === "codex-batch") {
    await runCodexBatchCli(argv.slice(1));
    return;
  }

  if (cmd === "claude-batch") {
    await runClaudeBatchCli(argv.slice(1));
    return;
  }

  if (cmd === "plan-dispatch") {
    await runPlanDispatchCli(argv.slice(1));
    return;
  }

  if (cmd === "estimate-plan") {
    runEstimatePlanCli(argv.slice(1));
    return;
  }

  usage();
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});

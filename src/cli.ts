#!/usr/bin/env node
import { loadConfig } from "./config.js";
import { discover } from "./discover.js";
import { runTask } from "./run.js";
import { runBatch } from "./batch.js";
import { loadTaskFile } from "./taskfile.js";
import type { PermissionIntent, WorkerId } from "./types.js";

function usage(): never {
  console.log(`cliyard — Windows entry, WSL workers

Usage:
  cliyard doctor
  cliyard run --repo <linux-path> --prompt "<task>" [--worker auto|claude|codex|codebuddy]
              [--model <id>] [--permission accept|bypass] [--dry-run]
  cliyard batch <taskfile.yaml> [--dry-run] [--max-parallel N]

Examples (PowerShell):
  npm run doctor
  npm run run-task -- --repo ~/work/my-app --prompt "Add README section" --worker codebuddy --model gpt-5 --dry-run
  npm run batch -- examples/module.tasks.yaml --dry-run
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

  usage();
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});

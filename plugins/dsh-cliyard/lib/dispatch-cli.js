#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { dispatchBatch, dispatchPlan } from "./dispatch.js";

function arg(flag, argv) {
  const i = argv.indexOf(flag);
  if (i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--")) {
    return argv[i + 1];
  }
  return undefined;
}

const argv = process.argv.slice(2);
if (argv.includes("-h") || argv.includes("--help")) {
  console.log(`dsh-cliyard-dispatch — Master bridge into cliyard

Usage:
  node lib/dispatch-cli.js --plan plan.json --repo <target> --dispatch
                           [--worker claude|codex|mock] [--model id]
                           [--real-worker] [--keep-worktrees] [--background]

  node lib/dispatch-cli.js --contracts contracts.json --repo <target>
                           [--worker claude|codex|mock] [--model id]
                           [--real-worker] [--keep-worktrees]

Common options:
  --control-root <cliyard checkout>  Defaults to this plugin's repository
  --ledger <path>                    Defaults to <target>/.cliyard/ledger.json

Plan mode compiles only unless --dispatch is present. Worker dispatch is
dry-run unless --real-worker is present. --real-codex is accepted as a
backward-compatible alias.
`);
  process.exit(0);
}

const planFile = arg("--plan", argv);
const workerRaw = arg("--worker", argv) ?? "mock";
if (
  workerRaw !== "mock" &&
  workerRaw !== "codex" &&
  workerRaw !== "claude"
) {
  throw new Error("--worker must be claude, codex or mock");
}
const worker = workerRaw;
const realWorker =
  argv.includes("--real-worker") ||
  argv.includes("--real-codex") ||
  argv.includes("--real-claude");
const common = {
  controlRoot: arg("--control-root", argv),
  targetRepo: arg("--repo", argv),
  ledgerPath: arg("--ledger", argv),
  worker,
  model: arg("--model", argv),
  dryRun: !realWorker,
  keepWorktrees: argv.includes("--keep-worktrees"),
  background: argv.includes("--background"),
};

let result;
if (planFile) {
  const absolute = resolve(planFile);
  result = await dispatchPlan({
    ...common,
    plan: JSON.parse(readFileSync(absolute, "utf8")),
    dispatch: argv.includes("--dispatch"),
  });
} else {
  result = await dispatchBatch({
    ...common,
    contracts: arg("--contracts", argv),
  });
}

process.stdout.write(result.stdout);
if (result.stderr) process.stderr.write(result.stderr);
console.log(
  JSON.stringify(
    {
      ok: result.ok,
      exitCode: result.exitCode,
      worker: result.worker,
      controlRoot: result.controlRoot,
      targetRepo: result.targetRepo,
      ledgerPath: result.ledgerPath,
      model: result.model,
    },
    null,
    2,
  ),
);
process.exit(result.exitCode);

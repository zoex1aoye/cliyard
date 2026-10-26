import { runPlanBridge, loadPlanFile, type PlanWorker } from "./bridge.js";

function arg(flag: string, argv: string[]): string | undefined {
  const i = argv.indexOf(flag);
  if (i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--")) {
    return argv[i + 1];
  }
  const eq = argv.find((item) => item.startsWith(`${flag}=`));
  return eq?.slice(flag.length + 1);
}

function positionalArg(argv: string[]): string | undefined {
  const valueFlags = new Set([
    "--repo",
    "--out",
    "--ledger",
    "--worker",
    "--model",
  ]);
  for (let i = 0; i < argv.length; i++) {
    const value = argv[i]!;
    if (value === "-") return value;
    if (value.startsWith("--")) {
      if (valueFlags.has(value)) i += 1;
      continue;
    }
    return value;
  }
  return undefined;
}

function usage(): never {
  console.log(`cliyard plan-dispatch — Plan → contracts → optional dispatch

Usage:
  cliyard plan-dispatch <plan.json|-> --repo <target-repo> [--dispatch]
                        [--worker claude|codex|mock] [--model id] [--out path]
                        [--ledger path] [--dry-run] [--background] [--cleanup]

Plan shape:
  {
    "planId": "glass-a11y",
    "tasks": [{
      "taskId": "glass-empty-a11y",
      "goal": "Add status semantics ...",
      "nonGoals": ["Do not redesign the component"],
      "dependsOn": [],
      "readPaths": ["AGENTS.md", "src/components/Card.vue"],
      "writePaths": ["src/components/Card.vue"],
      "verifyCommands": ["grep -q 'role=' src/components/Card.vue"],
      "maxRepairs": 1
    }]
  }

The control plane resolves HEAD, freezes contracts, rejects overlapping
writePaths, and writes .cliyard/plans + .cliyard/contracts under the target.
Without --dispatch this command only compiles and validates.
Codex worktrees are kept by default; use --cleanup to remove them.
With --background, dispatch returns a pid/log receipt while ledger carries
the durable task state.
`);
  process.exit(1);
}

export async function runPlanDispatchCli(argv: string[]): Promise<void> {
  if (argv.includes("-h") || argv.includes("--help") || argv.length === 0) {
    usage();
  }

  const planFile = positionalArg(argv);
  if (!planFile) usage();
  const repo = arg("--repo", argv);
  if (!repo) {
    throw new Error("plan-dispatch requires --repo <target-repo>");
  }

  const workerRaw = arg("--worker", argv) ?? "claude";
  if (
    workerRaw !== "claude" &&
    workerRaw !== "codex" &&
    workerRaw !== "mock"
  ) {
    throw new Error("--worker must be claude, codex or mock");
  }

  const result = await runPlanBridge({
    repoRoot: repo,
    plan: loadPlanFile(planFile),
    contractsPath: arg("--out", argv),
    ledgerPath: arg("--ledger", argv),
    worker: workerRaw as PlanWorker,
    model: arg("--model", argv),
    dispatch: argv.includes("--dispatch"),
    dryRun: argv.includes("--dry-run"),
    background: argv.includes("--background"),
    keepWorktrees: !argv.includes("--cleanup"),
    verbose: false,
  });

  console.log(JSON.stringify(result, null, 2));
  process.exit(result.ok ? 0 : 1);
}

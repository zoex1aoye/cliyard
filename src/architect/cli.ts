import {
  ArchitectError,
  runArchitect,
  type ArchitectRunResult,
} from "./runner.js";

function arg(flag: string, argv: string[]): string | undefined {
  const i = argv.indexOf(flag);
  if (i >= 0 && argv[i + 1] && !argv[i + 1]!.startsWith("--")) {
    return argv[i + 1];
  }
  const eq = argv.find((item) => item.startsWith(`${flag}=`));
  return eq?.slice(flag.length + 1);
}

function usage(): never {
  console.log(`cliyard architect — read-only Plan producer (Task Architect v0)

Usage:
  cliyard architect --repo <target-repo> --design <repo-relative-design.md>
                    --plan-id <safe-plan-id> [--worker claude] [--model <id>]
                    [--out <plan.json>] [--json]

Preflight:
  The target must be a git repository with a clean worktree. --design must be
  a committed, tracked path inside that repository. HEAD is resolved to one
  exact base commit before any worker starts.

Worker:
  claude with permission mode "plan" and only Read, Grep and Glob. The worker
  returns Plan JSON; it is never allowed to write files.

Output:
  A validated Plan artifact at <target>/.cliyard/plans/<planId>.json, or the
  explicit --out path. No contracts, worktrees, dispatch, merge or push are
  created. Review the Plan before compiling contracts or starting a Supervisor.
`);
  process.exit(1);
}

export async function runArchitectCli(argv: string[]): Promise<void> {
  if (argv.length === 0 || argv.includes("-h") || argv.includes("--help")) {
    usage();
  }
  const json = argv.includes("--json");

  try {
    const repoRoot = arg("--repo", argv);
    const designPath = arg("--design", argv);
    const planId = arg("--plan-id", argv);
    if (!repoRoot) {
      throw new ArchitectError(
        "preflight",
        "architect requires --repo <target-repo>",
      );
    }
    if (!designPath) {
      throw new ArchitectError(
        "preflight",
        "architect requires --design <repo-relative-design.md>",
      );
    }
    if (!planId) {
      throw new ArchitectError(
        "preflight",
        "architect requires --plan-id <safe-plan-id>",
      );
    }
    const worker = arg("--worker", argv) ?? "claude";
    if (worker !== "claude") {
      throw new ArchitectError(
        "preflight",
        "architect v0 supports only --worker claude",
      );
    }

    const result = await runArchitect({
      repoRoot,
      designPath,
      planId,
      model: arg("--model", argv),
      outPath: arg("--out", argv),
    });

    if (json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      printHuman(result);
    }
  } catch (error) {
    const stage = error instanceof ArchitectError ? error.stage : "unexpected";
    const detail = error instanceof Error ? error.message : String(error);
    if (json) {
      console.log(JSON.stringify({ ok: false, stage, error: detail }, null, 2));
    } else {
      console.error(`architect: ${stage}: ${detail}`);
    }
    process.exitCode = 1;
  }
}

function printHuman(result: ArchitectRunResult): void {
  const designNote = result.designTruncated ? " (truncated)" : "";
  console.log(
    [
      "Task Architect: Plan written",
      `  plan:     ${result.planId}`,
      `  artifact: ${result.planPath}`,
      `  repo:     ${result.repoRoot}`,
      `  base:     ${result.baseCommit}`,
      `  design:   ${result.designPath} (${result.designBytes} bytes${designNote})`,
      `  tasks:    ${result.taskIds.join(", ")}`,
      `  worker:   ${result.worker} session ${result.sessionId}`,
      "  touched:  (none)",
      "",
      "Read-only control plane: no contracts, worktrees, dispatch, merge or push.",
    ].join("\n"),
  );
}

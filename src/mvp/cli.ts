/**
 * cliyard mvp-test — M1 idle-spin CLI (no DSH required).
 */
import { resolve } from "node:path";
import { runIdleSpinFromFile } from "./idle-spin.js";

function arg(flag: string, argv: string[]): string | undefined {
  const i = argv.indexOf(flag);
  if (i >= 0 && argv[i + 1] && !argv[i + 1]!.startsWith("--")) {
    return argv[i + 1];
  }
  const eq = argv.find((item) => item.startsWith(`${flag}=`));
  return eq?.slice(flag.length + 1);
}

function usage(): never {
  console.log(`cliyard mvp-test — M1 idle-spin (worktree + local-cli cwd lock)

Usage:
  cliyard mvp-test --repo <git-repo> [contract.json]
                   [--replace-existing] [--json]

Default contract: examples/mvp/code-local-cli.mock.contract.json

Spawns driver.argv with cwd = absolute worktree path (never repoRoot).
`);
  process.exit(1);
}

export async function runMvpTestCli(argv: string[]): Promise<void> {
  if (argv.includes("-h") || argv.includes("--help")) usage();
  const json = argv.includes("--json");
  const replaceExisting = argv.includes("--replace-existing");
  const repo = arg("--repo", argv);
  if (!repo) {
    console.error("mvp-test requires --repo <git-repo>");
    process.exitCode = 1;
    return;
  }

  let contractPath = "examples/mvp/code-local-cli.mock.contract.json";
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--repo") {
      i += 1;
      continue;
    }
    if (a.startsWith("--repo=")) continue;
    if (a === "--json" || a === "--replace-existing") continue;
    if (a.startsWith("-")) continue;
    contractPath = a;
    break;
  }

  try {
    const result = await runIdleSpinFromFile({
      repoRoot: resolve(repo),
      contractPath: resolve(contractPath),
      replaceExisting,
    });
    if (json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log(
        [
          result.ok ? "mvp-test: ok" : "mvp-test: failed",
          `  contract:   ${result.contractId}`,
          `  target:     ${result.target}`,
          `  worktree:   ${result.worktreePath}`,
          `  spawnCwd:   ${result.spawnCwd}`,
          `  spawnExit:  ${result.spawnExitCode}`,
          `  trunkClean: ${result.trunkClean}`,
          `  kept:       ${result.keptWorkspace}`,
          ...(result.error ? [`  error:      ${result.error}`] : []),
        ].join("\n"),
      );
    }
    if (!result.ok) process.exitCode = 1;
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    if (json) {
      console.log(JSON.stringify({ ok: false, error: detail }, null, 2));
    } else {
      console.error(`mvp-test: ${detail}`);
    }
    process.exitCode = 1;
  }
}

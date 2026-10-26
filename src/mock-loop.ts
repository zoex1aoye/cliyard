/**
 * Route C Darwin spike entry: mock worker + mock (or optional real) verifier closed loop.
 * No WSL / CodeBuddy / Docker.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { loadContractJson } from "./contracts/schema.js";
import { createMockAdapter } from "./agents/mock.js";
import {
  createMockVerifier,
  createShellVerifier,
  wantsRealVerify,
} from "./verification/verifier.js";
import { runClosedLoop } from "./repair/loop.js";
import { defaultLedgerPath } from "./persistence/ledger.js";
import { writeBriefingFile } from "./context/assemble.js";

function usage(): never {
  console.log(`cliyard mock-loop — Route C closed loop (mock worker; Darwin-safe)

Usage:
  cliyard mock-loop [contract.json] [--fail-verify-times N] [--ledger path]
                    [--briefing-dir path] [--real-verify]

Defaults:
  contract: examples/mock.contract.json
  fail-verify-times: 1  (mock verifier only; first verify fails → one repair → accept)
  ledger: .cliyard/ledger.json
  briefing-dir: omitted (no file). Pass a dir to write briefing/<taskId>.md
  verify: Mock (default). Pass --real-verify or CLIYARD_REAL_VERIFY=1 to spawn
          contract.verifyCommands on the local shell (ignores mock fail markers).
`);
  process.exit(1);
}

function arg(flag: string, argv: string[]): string | undefined {
  const i = argv.indexOf(flag);
  if (i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--")) return argv[i + 1];
  const eq = argv.find((a) => a.startsWith(`${flag}=`));
  return eq?.slice(flag.length + 1);
}

/** First non-flag token that is not a value belonging to a prior --flag. */
function positionalArg(argv: string[]): string | undefined {
  const valueFlags = new Set([
    "--fail-verify-times",
    "--ledger",
    "--briefing-dir",
  ]);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      if (valueFlags.has(a)) i += 1;
      continue;
    }
    return a;
  }
  return undefined;
}

export async function runMockLoopCli(argv: string[]): Promise<void> {
  if (argv.includes("-h") || argv.includes("--help")) usage();

  const positional = positionalArg(argv);
  const contractPath = resolve(positional ?? "examples/mock.contract.json");
  const failRaw = arg("--fail-verify-times", argv);
  const failVerifyTimes = failRaw !== undefined ? Number(failRaw) : 1;
  const ledgerPath = arg("--ledger", argv) ?? defaultLedgerPath();
  const briefingDirRaw = arg("--briefing-dir", argv);
  const realVerify = wantsRealVerify(argv);

  if (!Number.isInteger(failVerifyTimes) || failVerifyTimes < 0) {
    throw new Error("--fail-verify-times must be a non-negative integer");
  }

  const contract = loadContractJson(readFileSync(contractPath, "utf8"));
  console.log(`mock-loop contract=${contractPath}`);
  console.log(`  taskId=${contract.taskId} maxRepairs=${contract.maxRepairs}`);
  console.log(
    `  verifier=${realVerify ? "shell" : "mock"} failVerifyTimes=${failVerifyTimes} ledger=${ledgerPath}`,
  );
  if (realVerify && failVerifyTimes > 0) {
    console.log(
      "  note: --fail-verify-times is ignored by shell verifier (commands decide)",
    );
  }

  if (briefingDirRaw !== undefined) {
    const briefingDir = resolve(briefingDirRaw);
    const briefingPath = writeBriefingFile(contract, briefingDir);
    console.log(`  briefing=${briefingPath}`);
  }
  console.log("");

  const result = await runClosedLoop({
    contract,
    worker: createMockAdapter({ failVerifyTimes }),
    verifier: realVerify ? createShellVerifier() : createMockVerifier(),
    ledgerPath,
    verbose: true,
  });

  console.log("");
  console.log(JSON.stringify(result, null, 2));
  process.exit(result.verdict === "accepted" ? 0 : 1);
}

/**
 * Thin adapter from the DSH Master shell to the cliyard control plane.
 *
 * `controlRoot` is where cliyard lives; `repoRoot`/`targetRepo` is the business
 * repository that receives worktrees and ledger state. Keeping these separate
 * is what allows a linked plugin to manage a sibling project.
 */
import { spawn } from "node:child_process";
import { isAbsolute, resolve } from "node:path";
import {
  cliyardEntry,
  resolveControlRoot,
  resolveRepoRoot,
} from "./paths.js";

/**
 * @param {{
 *   repoRoot?: string,
 *   targetRepo?: string,
 *   controlRoot?: string,
 *   contracts?: string,
 *   worker?: "mock" | "codex" | "claude",
 *   ledgerPath?: string,
 *   model?: string,
 *   dryRun?: boolean,
 *   keepWorktrees?: boolean,
 * }} opts
 */
export async function dispatchBatch(opts = {}) {
  const controlRoot = resolveControlRoot(opts.controlRoot);
  const targetRepo = resolveRepoRoot(
    opts.targetRepo ?? opts.repoRoot ?? controlRoot,
  );
  const contractInput =
    opts.contracts ??
    resolve(controlRoot, "examples/mock-batch.parallel.json");
  const contracts = isAbsolute(contractInput)
    ? contractInput
    : resolve(controlRoot, contractInput);
  const worker = opts.worker ?? "mock";
  const ledgerPath =
    opts.ledgerPath ?? resolve(targetRepo, ".cliyard/ledger.json");
  const entry = cliyardEntry(controlRoot);

  const args =
    worker === "mock"
      ? [
          entry,
          "mock-batch",
          contracts,
          "--ledger",
          ledgerPath,
        ]
      : [
          entry,
          `${worker}-batch`,
          contracts,
          "--repo",
          targetRepo,
          "--ledger",
          ledgerPath,
          ...(opts.model ? ["--model", opts.model] : []),
          ...(opts.dryRun === false ? [] : ["--dry-run"]),
          ...(opts.keepWorktrees ? ["--keep-worktrees"] : []),
        ];

  const result = await runCli({ controlRoot, args });
  return {
    ...result,
    controlRoot,
    repoRoot: targetRepo,
    targetRepo,
    contracts,
    worker,
    ledgerPath,
    model: opts.model,
  };
}

/**
 * Compile a structured Plan into frozen contracts and optionally dispatch it.
 *
 * @param {{
 *   plan: unknown,
 *   repoRoot?: string,
 *   targetRepo?: string,
 *   controlRoot?: string,
 *   contractsPath?: string,
 *   ledgerPath?: string,
 *   worker?: "mock" | "codex" | "claude",
 *   model?: string,
 *   dispatch?: boolean,
 *   dryRun?: boolean,
 *   keepWorktrees?: boolean,
 *   background?: boolean,
 * }} opts
 */
export async function dispatchPlan(opts) {
  if (opts?.plan === undefined) {
    throw new Error("dispatchPlan requires a Plan object");
  }
  const controlRoot = resolveControlRoot(opts.controlRoot);
  const targetRepo = resolveRepoRoot(
    opts.targetRepo ?? opts.repoRoot ?? controlRoot,
  );
  const worker = opts.worker ?? "claude";
  const ledgerPath =
    opts.ledgerPath ?? resolve(targetRepo, ".cliyard/ledger.json");
  const entry = cliyardEntry(controlRoot);

  const args = [
    entry,
    "plan-dispatch",
    "-",
    "--repo",
    targetRepo,
    "--ledger",
    ledgerPath,
    "--worker",
    worker,
    ...(opts.contractsPath ? ["--out", opts.contractsPath] : []),
    ...(opts.model ? ["--model", opts.model] : []),
    ...(opts.dispatch ? ["--dispatch"] : []),
    ...(opts.dryRun ? ["--dry-run"] : []),
    ...(opts.background ? ["--background"] : []),
    ...(opts.keepWorktrees === false ? ["--cleanup"] : []),
  ];

  const result = await runCli({
    controlRoot,
    args,
    input: JSON.stringify(opts.plan),
  });
  return {
    ...result,
    controlRoot,
    repoRoot: targetRepo,
    targetRepo,
    worker,
    ledgerPath,
    model: opts.model,
  };
}

function runCli({ controlRoot, args, input }) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn("npx", ["tsx", ...args], {
      cwd: controlRoot,
      env: process.env,
      stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (data) => {
      stdout += String(data);
    });
    child.stderr.on("data", (data) => {
      stderr += String(data);
    });
    child.on("error", reject);
    child.on("close", (code) => {
      resolvePromise({
        ok: code === 0,
        exitCode: code ?? 1,
        stdout,
        stderr,
      });
    });
    if (input !== undefined) {
      child.stdin.end(input);
    }
  });
}

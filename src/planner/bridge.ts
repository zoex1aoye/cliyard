/**
 * One bridge from a reviewed Plan to persisted contracts and an optional
 * isolated dispatch. Control-plane safety checks run before any worker starts.
 */
import { spawn } from "node:child_process";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createMockAdapter } from "../agents/mock.js";
import { defaultLedgerPath } from "../persistence/ledger.js";
import { runCodexBatch } from "../scheduler/codex-batch.js";
import { runMockBatch } from "../scheduler/mock-batch.js";
import type { RunManifest } from "../supervisor/types.js";
import { createMockVerifier } from "../verification/verifier.js";
import {
  compilePlan,
  defaultContractsPath,
  defaultPlanArtifactPath,
  makeContractDocument,
  parsePlanJson,
  writeJsonArtifact,
  type CompiledPlan,
} from "./plan.js";

export type PlanWorker = "claude" | "codex" | "mock";

export interface PlanBridgeOptions {
  repoRoot: string;
  plan: unknown;
  contractsPath?: string;
  ledgerPath?: string;
  worker?: PlanWorker;
  model?: string;
  dispatch?: boolean;
  dryRun?: boolean;
  keepWorktrees?: boolean;
  /** Validate and compile synchronously, then launch the worker detached. */
  background?: boolean;
  verbose?: boolean;
  /**
   * Optional durable checkpoint forwarded to the worker batch. Foreground
   * claude/codex dispatch only; background jobs and mock workers cannot carry
   * an in-memory manifest.
   */
  runManifest?: RunManifest;
}

export interface PlanBridgeResult {
  ok: boolean;
  planId: string;
  repoRoot: string;
  baseCommit: string;
  planPath: string;
  contractsPath: string;
  taskIds: string[];
  warnings: string[];
  dispatched: boolean;
  dispatchJob?: {
    pid: number;
    logPath: string;
    startedAt: string;
  };
  dispatchResult?: {
    allAccepted: boolean;
    startOrder: string[];
    waves: string[][];
    ledgerPath: string;
    worktrees: { taskId: string; path: string; branch: string }[];
    results: {
      taskId: string;
      verdict: "accepted" | "rejected";
      status: string;
      repairCount: number;
      reason: string;
    }[];
    skipped: { taskId: string; reason: string }[];
    integration?: {
      path: string;
      branch: string;
      head: string;
    };
    manifest?: RunManifest;
  };
}

export async function runPlanBridge(
  opts: PlanBridgeOptions,
): Promise<PlanBridgeResult> {
  const repoRoot = resolve(opts.repoRoot);
  assertGitRepository(repoRoot);

  const baseCommit = await resolveHeadCommit(repoRoot);
  const plan = compilePlan(opts.plan, { baseCommit });
  const warnings = await collectDirtyWorktreeWarnings(repoRoot);

  const planPath = writeJsonArtifact(
    defaultPlanArtifactPath(repoRoot, plan.planId),
    opts.plan,
  );
  const contractsPath = writeJsonArtifact(
    opts.contractsPath ?? defaultContractsPath(repoRoot, plan.planId),
    makeContractDocument(plan),
  );

  const shouldDispatch = opts.dispatch === true;
  if (!shouldDispatch) {
    return bridgeResult({
      plan,
      repoRoot,
      planPath,
      contractsPath,
      warnings,
      dispatched: false,
    });
  }

  const worker = opts.worker ?? "claude";
  const ledgerPath =
    opts.ledgerPath ?? defaultLedgerPath(repoRoot);

  if (opts.runManifest && opts.background === true) {
    throw new Error(
      "plan bridge: run manifest checkpointing is not available for " +
        "background dispatch",
    );
  }

  if (opts.background === true) {
    const job = startBackgroundWorker({
      repoRoot,
      contractsPath,
      ledgerPath,
      worker,
      model: opts.model,
      dryRun: opts.dryRun === true,
      keepWorktrees: opts.keepWorktrees !== false,
      planId: plan.planId,
    });
    return bridgeResult({
      plan,
      repoRoot,
      planPath,
      contractsPath,
      warnings,
      dispatched: true,
      dispatchJob: job,
    });
  }

  if (worker === "mock") {
    if (opts.runManifest) {
      throw new Error(
        "plan bridge: run manifest checkpointing requires a claude or " +
          "codex worker",
      );
    }
    const result = await runMockBatch({
      contracts: plan.contracts,
      createWorker: () => createMockAdapter({ failVerifyTimes: 0 }),
      verifier: createMockVerifier(),
      ledgerPath,
      verbose: opts.verbose,
    });
    return bridgeResult({
      plan,
      repoRoot,
      planPath,
      contractsPath,
      warnings,
      dispatched: true,
      dispatchResult: {
        allAccepted: result.allAccepted,
        startOrder: result.startOrder,
        waves: [],
        results: [],
        skipped: [],
        ledgerPath: result.ledgerPath,
        worktrees: [],
      },
    });
  }

  const result = await runCodexBatch({
    contractsPath,
    repoRoot,
    ledgerPath,
    worker,
    model: opts.model,
    dryRun: opts.dryRun === true,
    keepWorktrees: opts.keepWorktrees !== false,
    verbose: opts.verbose,
    runManifest: opts.runManifest,
  });
  return bridgeResult({
    plan,
    repoRoot,
    planPath,
    contractsPath,
    warnings,
    dispatched: true,
    dispatchResult: {
      allAccepted: result.allAccepted,
      startOrder: result.startOrder,
      waves: result.waves,
      ledgerPath: result.ledgerPath,
      worktrees: result.worktrees,
      results: result.results.map((task) => ({
        taskId: task.taskId,
        verdict: task.verdict,
        status: task.status,
        repairCount: task.repairCount,
        reason: task.reason,
      })),
      skipped: result.skipped,
      integration: result.integration,
      manifest: result.manifest,
    },
  });
}

export function loadPlanFile(path: string): unknown {
  if (path === "-") {
    return parsePlanJson(readFileSync(0, "utf8"));
  }
  const absolute = resolve(path);
  if (!existsSync(absolute)) {
    throw new Error(`Plan file not found: ${absolute}`);
  }
  return parsePlanJson(readFileSync(absolute, "utf8"));
}

function bridgeResult(opts: {
  plan: CompiledPlan;
  repoRoot: string;
  planPath: string;
  contractsPath: string;
  warnings: string[];
  dispatched: boolean;
  dispatchJob?: PlanBridgeResult["dispatchJob"];
  dispatchResult?: PlanBridgeResult["dispatchResult"];
}): PlanBridgeResult {
  const ok =
    !opts.dispatched ||
    opts.dispatchJob !== undefined ||
    opts.dispatchResult?.allAccepted === true;
  return {
    ok,
    planId: opts.plan.planId,
    repoRoot: opts.repoRoot,
    baseCommit: opts.plan.baseCommit,
    planPath: opts.planPath,
    contractsPath: opts.contractsPath,
    taskIds: opts.plan.contracts.map((contract) => contract.taskId),
    warnings: opts.warnings,
    dispatched: opts.dispatched,
    dispatchJob: opts.dispatchJob,
    dispatchResult: opts.dispatchResult,
  };
}

function startBackgroundWorker(opts: {
  repoRoot: string;
  contractsPath: string;
  ledgerPath: string;
  worker: PlanWorker;
  model?: string;
  dryRun: boolean;
  keepWorktrees: boolean;
  planId: string;
}): NonNullable<PlanBridgeResult["dispatchJob"]> {
  const moduleRoot = resolve(
    dirname(fileURLToPath(import.meta.url)),
    "../..",
  );
  const sourceEntry = join(moduleRoot, "src", "cli.ts");
  const distEntry = join(moduleRoot, "dist", "cli.js");
  const useSource = existsSync(sourceEntry);
  const entry = useSource ? sourceEntry : distEntry;
  if (!existsSync(entry)) {
    throw new Error(`cliyard CLI entry not found under ${moduleRoot}`);
  }

  const workerArgs =
    opts.worker === "mock"
      ? [
          "mock-batch",
          opts.contractsPath,
          "--ledger",
          opts.ledgerPath,
        ]
      : [
          `${opts.worker}-batch`,
          opts.contractsPath,
          "--repo",
          opts.repoRoot,
          "--ledger",
          opts.ledgerPath,
          ...(opts.model ? ["--model", opts.model] : []),
          ...(opts.dryRun ? ["--dry-run"] : []),
          ...(opts.keepWorktrees ? ["--keep-worktrees"] : []),
        ];

  const command = useSource ? "npx" : process.execPath;
  const args = useSource
    ? ["tsx", entry, ...workerArgs]
    : [entry, ...workerArgs];
  const logDir = join(opts.repoRoot, ".cliyard", "logs");
  mkdirSync(logDir, { recursive: true });
  const startedAt = new Date().toISOString();
  const logPath = join(
    logDir,
    `${opts.planId}-${startedAt.replaceAll(":", "-")}.log`,
  );
  const fd = openSync(logPath, "a");
  const child = spawn(command, args, {
    cwd: moduleRoot,
    env: process.env,
    detached: true,
    stdio: ["ignore", fd, fd],
  });
  closeSync(fd);
  if (!child.pid) {
    throw new Error("background cliyard worker did not return a pid");
  }
  child.unref();
  return { pid: child.pid, logPath, startedAt };
}

function assertGitRepository(repoRoot: string): void {
  if (!existsSync(repoRoot)) {
    throw new Error(`target repo not found: ${repoRoot}`);
  }
  if (!existsSync(resolve(repoRoot, ".git"))) {
    throw new Error(`target is not a git repository: ${repoRoot}`);
  }
}

function resolveHeadCommit(repoRoot: string): Promise<string> {
  return runGit(repoRoot, ["rev-parse", "HEAD"]).then((out) => {
    const commit = out.trim();
    if (!/^[0-9a-f]{40,64}$/i.test(commit)) {
      throw new Error(`git rev-parse HEAD returned an invalid commit: ${commit}`);
    }
    return commit;
  });
}

async function collectDirtyWorktreeWarnings(
  repoRoot: string,
): Promise<string[]> {
  const status = (await runGit(repoRoot, [
    "status",
    "--porcelain",
    "--untracked-files=normal",
  ])).trim();
  if (!status) return [];
  return [
    "target worktree has uncommitted changes; isolated workers start from " +
      "HEAD and will not see those changes",
  ];
}

function runGit(repoRoot: string, args: string[]): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn("git", args, {
      cwd: repoRoot,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolvePromise(stdout);
        return;
      }
      reject(
        new Error(
          `git ${args.join(" ")} failed: ${(stderr || stdout).trim()}`,
        ),
      );
    });
  });
}

/**
 * S2: multi-task batch with Codex workers in isolated git worktrees.
 * Ready-wave runs in parallel; each task has its own worktree + verifier cwd.
 */
import {
  existsSync,
  lstatSync,
  symlinkSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { createClaudeAdapter } from "../agents/claude.js";
import { createCodexAdapter } from "../agents/codex.js";
import type { AgentAdapter } from "../agents/types.js";
import {
  createMockVerifier,
  createShellVerifier,
} from "../verification/verifier.js";
import { defaultLedgerPath } from "../persistence/ledger.js";
import { runClosedLoop, type LoopResult } from "../repair/loop.js";
import {
  addWorktree,
  removeWorktree,
  type WorktreeHandle,
} from "../workspace/worktree.js";
import { findCycle, readyIds, type DagNode } from "./dag.js";
import { loadContractsInput } from "./mock-batch.js";

export interface CodexBatchOptions {
  contractsPath: string;
  repoRoot?: string;
  ledgerPath?: string;
  /** Worker family sharing the worktree scheduler. */
  worker?: "codex" | "claude";
  model?: string;
  dryRun?: boolean;
  keepWorktrees?: boolean;
  verbose?: boolean;
  /** Test/integration seam: replace the real CLI adapter for one worktree. */
  workerFactory?: (
    worker: "codex" | "claude",
    cwd: string,
  ) => AgentAdapter;
}

export interface CodexBatchResult {
  results: LoopResult[];
  skipped: { taskId: string; reason: string }[];
  startOrder: string[];
  waves: string[][];
  ledgerPath: string;
  allAccepted: boolean;
  worktrees: { taskId: string; path: string; branch: string }[];
  integration: {
    path: string;
    branch: string;
    head: string;
  };
}

export async function runCodexBatch(
  opts: CodexBatchOptions,
): Promise<CodexBatchResult> {
  const repoRoot = resolve(opts.repoRoot ?? process.cwd());
  const ledgerPath = opts.ledgerPath ?? defaultLedgerPath(repoRoot);
  const contracts = await resolveContractBases(
    repoRoot,
    loadContractsInput(opts.contractsPath),
  );
  validateDispatchGraph(contracts);
  await validateReadContexts(repoRoot, contracts);
  const sharedBase = contracts[0]?.baseCommit;
  if (
    !sharedBase ||
    contracts.some((contract) => contract.baseCommit !== sharedBase)
  ) {
    throw new Error(
      "worker-batch requires one shared base commit for all tasks",
    );
  }
  const handles = new Map<string, WorktreeHandle>();
  const workerKind = opts.worker ?? "codex";
  const dryRun = opts.dryRun === true;
  const log = opts.verbose
    ? (s: string) => console.log(s)
    : (_s: string) => undefined;

  const nodes: DagNode[] = contracts.map((c) => ({
    id: c.taskId,
    dependsOn: c.dependsOn,
  }));
  const cycle = findCycle(nodes);
  if (!cycle.ok) {
    throw new Error(`codex-batch: cycle ${cycle.cycle.join(" → ")}`);
  }

  const integration = await addWorktree({
    repoRoot,
    taskId: "integration",
    baseCommit: sharedBase,
  });
  await linkDependencies(repoRoot, integration.worktreePath, log);
  log(
    `[${workerKind}-batch] integration ${integration.branch} → ${integration.worktreePath}`,
  );

  try {
    const byId = new Map(contracts.map((c) => [c.taskId, c]));
    const pending = new Set(contracts.map((c) => c.taskId));
    const accepted = new Set<string>();
    const results: LoopResult[] = [];
    const skipped: { taskId: string; reason: string }[] = [];
    const startOrder: string[] = [];
    const waves: string[][] = [];

    while (pending.size > 0) {
      const ready = readyIds(nodes, accepted).filter((id) => pending.has(id));
      if (ready.length === 0) {
        for (const id of [...pending]) {
          skipped.push({
            taskId: id,
            reason: "blocked: dependencies not accepted",
          });
          pending.delete(id);
        }
        break;
      }

      for (const id of ready) {
        startOrder.push(id);
        log(`[${workerKind}-batch] start ${id}`);
      }

      const integrationBase = await gitHead(integration.worktreePath);
      waves.push([...ready]);
      for (const id of ready) {
        const handle = await addWorktree({
          repoRoot,
          taskId: id,
          baseCommit: integrationBase,
        });
        handles.set(id, handle);
        await linkDependencies(repoRoot, handle.worktreePath, log);
        log(
          `[${workerKind}-batch] worktree ${id} → ${handle.worktreePath}`,
        );
      }

      const waveResults = await Promise.all(
        ready.map(async (id) => {
          const contract = {
            ...byId.get(id)!,
            baseCommit: integrationBase,
          };
          const wt = handles.get(id)!;
          const worker =
            opts.workerFactory?.(workerKind, wt.worktreePath) ??
            (workerKind === "claude"
              ? createClaudeAdapter({
                  cwd: wt.worktreePath,
                  model: opts.model,
                  dryRun,
                })
              : createCodexAdapter({
                  cwd: wt.worktreePath,
                  model: opts.model,
                  dryRun,
                }));
          const verifier = dryRun
            ? createMockVerifier()
            : createShellVerifier({ cwd: wt.worktreePath });
          return runClosedLoop({
            contract,
            worker,
            verifier,
            ledgerPath,
            verbose: opts.verbose,
          });
        }),
      );

      for (let i = 0; i < ready.length; i++) {
        const id = ready[i]!;
        const result = waveResults[i]!;
        results.push(result);
        pending.delete(id);
        if (result.verdict === "accepted") {
          accepted.add(id);
          const snapshot = await snapshotTask(
            handles.get(id)!,
            id,
            byId.get(id)!.writePaths,
          );
          await mergeAcceptedTask(
            integration.worktreePath,
            handles.get(id)!,
            snapshot,
          );
          log(`[${workerKind}-batch] accepted ${id}`);
        } else {
          log(`[${workerKind}-batch] rejected ${id}: ${result.reason}`);
        }
      }
    }

    return {
      results,
      skipped,
      startOrder,
      waves,
      ledgerPath,
      allAccepted:
        skipped.length === 0 && results.every((r) => r.verdict === "accepted"),
      worktrees: [...handles.values()].map((h) => ({
        taskId: h.taskId,
        path: h.worktreePath,
        branch: h.branch,
      })),
      integration: {
        path: integration.worktreePath,
        branch: integration.branch,
        head: await gitHead(integration.worktreePath),
      },
    };
  } finally {
    if (!opts.keepWorktrees) {
      await removeWorktree(integration, { force: true }).catch(() => undefined);
      for (const h of handles.values()) {
        await removeWorktree(h, { force: true }).catch(() => undefined);
      }
    }
  }
}

async function linkDependencies(
  repoRoot: string,
  worktreePath: string,
  log: (message: string) => void,
): Promise<void> {
  const source = join(repoRoot, "node_modules");
  const target = join(worktreePath, "node_modules");
  if (!existsSync(source) || existsSync(target)) return;

  const ignored = await git(repoRoot, [
    "check-ignore",
    "-q",
    "node_modules",
  ]).catch(() => ({ exitCode: 1, stdout: "", stderr: "" }));
  if (ignored.exitCode !== 0) {
    log(
      "[worker-batch] node_modules is not ignored; dependency link skipped",
    );
    return;
  }

  symlinkSync(
    source,
    target,
    process.platform === "win32" ? "junction" : "dir",
  );
  const stat = lstatSync(target);
  if (!stat.isSymbolicLink()) {
    throw new Error(`dependency link is not a symlink: ${target}`);
  }
  log(`[worker-batch] dependencies ${target} → ${source}`);
}

async function validateReadContexts(
  repoRoot: string,
  contracts: ReturnType<typeof loadContractsInput>,
): Promise<void> {
  const producedPaths = contracts.flatMap((contract) => contract.writePaths);
  const readPaths = [...new Set(contracts.flatMap((contract) => contract.readPaths))];

  for (const readPath of readPaths) {
    if (readPath === ".") continue;
    const absolute = join(repoRoot, readPath);
    if (!existsSync(absolute)) {
      if (readPath === "AGENTS.md") continue;
      if (producedPaths.some((writePath) => pathsOverlap(readPath, writePath))) {
        continue;
      }
      throw new Error(`worker-batch: readPath not found: ${readPath}`);
    }

    const tracked = await git(repoRoot, ["ls-files", "--", readPath]);
    if (
      !tracked.stdout.trim() &&
      !producedPaths.some((writePath) => pathsOverlap(readPath, writePath))
    ) {
      throw new Error(
        `worker-batch: readPath "${readPath}" is untracked and will be absent ` +
          "from worker worktrees; commit it or produce it as a task artifact",
      );
    }
  }
}

async function snapshotTask(
  handle: WorktreeHandle,
  taskId: string,
  writePaths: string[],
): Promise<string> {
  const snapshotPaths: string[] = [];
  for (const writePath of writePaths) {
    const tracked = await git(handle.worktreePath, [
      "ls-files",
      "--",
      writePath,
    ]);
    if (
      existsSync(join(handle.worktreePath, writePath)) ||
      tracked.stdout.trim()
    ) {
      snapshotPaths.push(writePath);
    }
  }
  if (snapshotPaths.length === 0) {
    return (await git(handle.worktreePath, ["rev-parse", "HEAD"])).stdout.trim();
  }

  const status = await git(handle.worktreePath, [
    "status",
    "--porcelain",
    "--untracked-files=all",
    "--",
    ...snapshotPaths,
  ]);
  if (status.stdout.trim()) {
    await git(handle.worktreePath, ["add", "-A", "--", ...snapshotPaths]);
    await git(handle.worktreePath, [
      "-c",
      "user.name=cliyard",
      "-c",
      "user.email=cliyard@localhost",
      "commit",
      "-m",
      `cliyard snapshot: ${taskId}`,
    ]);
  }
  return (await git(handle.worktreePath, ["rev-parse", "HEAD"])).stdout.trim();
}

async function mergeAcceptedTask(
  integrationPath: string,
  task: WorktreeHandle,
  snapshot: string,
): Promise<void> {
  const taskHead = (
    await git(task.worktreePath, ["rev-parse", "HEAD"])
  ).stdout.trim();
  if (taskHead !== snapshot) {
    throw new Error(`task snapshot changed unexpectedly: ${task.taskId}`);
  }
  const base = (
    await git(integrationPath, ["rev-parse", "HEAD"])
  ).stdout.trim();
  const merged = await git(integrationPath, [
    "merge-base",
    "--is-ancestor",
    snapshot,
    base,
  ]).catch(() => ({ exitCode: 1, stdout: "", stderr: "" }));
  if (merged.exitCode === 0) return;
  await git(integrationPath, [
    "-c",
    "user.name=cliyard",
    "-c",
    "user.email=cliyard@localhost",
    "merge",
    "--no-ff",
    "--no-edit",
    task.branch,
  ]);
}

async function gitHead(cwd: string): Promise<string> {
  return (await git(cwd, ["rev-parse", "HEAD"])).stdout.trim();
}

async function git(
  cwd: string,
  args: string[],
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn("git", args, {
      cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
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
      const result = {
        exitCode: code ?? 1,
        stdout,
        stderr,
      };
      if (result.exitCode !== 0) {
        reject(
          new Error(
            `git ${args.join(" ")} failed: ${
              (stderr || stdout).trim() || `exit ${result.exitCode}`
            }`,
          ),
        );
      } else {
        resolvePromise(result);
      }
    });
  });
}

async function resolveContractBases(
  repoRoot: string,
  contracts: ReturnType<typeof loadContractsInput>,
) {
  return Promise.all(
    contracts.map(async (contract) => ({
      ...contract,
      baseCommit: await resolveGitCommit(
        repoRoot,
        contract.baseCommit || "HEAD",
      ),
    })),
  );
}

function validateDispatchGraph(
  contracts: ReturnType<typeof loadContractsInput>,
): void {
  const byId = new Map<string, (typeof contracts)[number]>();
  for (const contract of contracts) {
    if (byId.has(contract.taskId)) {
      throw new Error(`codex-batch: duplicate taskId ${contract.taskId}`);
    }
    if (!contract.frozen) {
      throw new Error(`codex-batch: task ${contract.taskId} is not frozen`);
    }
    byId.set(contract.taskId, contract);
    if (contract.sharedResources.length > 0) {
      throw new Error(
        `codex-batch: task ${contract.taskId} uses sharedResources, ` +
          "but resource locking is not implemented",
      );
    }
  }
  for (const contract of contracts) {
    for (const dependency of contract.dependsOn) {
      if (!byId.has(dependency)) {
        throw new Error(
          `codex-batch: task ${contract.taskId} depends on unknown task ${dependency}`,
        );
      }
    }
  }

  for (let i = 0; i < contracts.length; i++) {
    for (let j = i + 1; j < contracts.length; j++) {
      const left = contracts[i]!;
      const right = contracts[j]!;
      for (const a of left.writePaths) {
        for (const b of right.writePaths) {
          if (pathsOverlap(a, b)) {
            throw new Error(
              `codex-batch: writePaths overlap between ${left.taskId} (${a}) ` +
                `and ${right.taskId} (${b}); isolated worktrees do not compose edits`,
            );
          }
        }
      }
    }
  }
}

function pathsOverlap(left: string, right: string): boolean {
  const a = left.replace(/\/+$/, "");
  const b = right.replace(/\/+$/, "");
  return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}

function resolveGitCommit(repoRoot: string, revision: string): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(
      "git",
      ["rev-parse", "--verify", `${revision}^{commit}`],
      {
        cwd: repoRoot,
        env: process.env,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
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
      const commit = stdout.trim();
      if (code === 0 && /^[0-9a-f]{40,64}$/i.test(commit)) {
        resolvePromise(commit);
        return;
      }
      reject(
        new Error(
          `codex-batch: cannot resolve baseCommit "${revision}": ` +
            `${(stderr || stdout).trim() || `git exited ${code}`}`,
        ),
      );
    });
  });
}

function usage(worker: "codex" | "claude" = "codex"): never {
  console.log(`cliyard ${worker}-batch — parallel ${worker} workers in git worktrees

Usage:
  cliyard ${worker}-batch <contracts.json> [--repo path] [--ledger path]
                         [--model id] [--dry-run] [--keep-worktrees]

Defaults:
  codex model: deepseek-v4-pro (or CLIYARD_CODEX_MODEL)
  claude model: deepseek-flash[1m] (or CLIYARD_CLAUDE_MODEL)
  --dry-run: stub files in worktree (no worker API); for tests / offline
  ledger: <repo>/.cliyard/ledger.json
`);
  process.exit(1);
}

function arg(flag: string, argv: string[]): string | undefined {
  const i = argv.indexOf(flag);
  if (i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--")) return argv[i + 1];
  const eq = argv.find((a) => a.startsWith(`${flag}=`));
  return eq?.slice(flag.length + 1);
}

export async function runCodexBatchCli(argv: string[]): Promise<void> {
  await runWorkerBatchCli(argv, "codex");
}

export async function runClaudeBatchCli(argv: string[]): Promise<void> {
  await runWorkerBatchCli(argv, "claude");
}

async function runWorkerBatchCli(
  argv: string[],
  worker: "codex" | "claude",
): Promise<void> {
  if (argv.includes("-h") || argv.includes("--help") || argv.length === 0) {
    usage(worker);
  }
  const file = positionalArg(argv);
  if (!file) usage(worker);

  const result = await runCodexBatch({
    contractsPath: file!,
    repoRoot: arg("--repo", argv),
    ledgerPath: arg("--ledger", argv),
    worker,
    model: arg("--model", argv),
    dryRun: argv.includes("--dry-run") || process.env.CLIYARD_CODEX_DRY === "1",
    keepWorktrees:
      argv.includes("--keep-worktrees") ||
      process.env.CLIYARD_KEEP_WORKTREES === "1",
    verbose: true,
  });

  console.log(
    JSON.stringify(
      {
        startOrder: result.startOrder,
        waves: result.waves,
        allAccepted: result.allAccepted,
        worktrees: result.worktrees,
        results: result.results.map((r) => ({
          taskId: r.taskId,
          verdict: r.verdict,
          status: r.status,
          repairCount: r.repairCount,
          reason: r.reason,
        })),
        skipped: result.skipped,
        ledgerPath: result.ledgerPath,
      },
      null,
      2,
    ),
  );
  process.exit(result.allAccepted ? 0 : 1);
}

function positionalArg(argv: string[]): string | undefined {
  const valueFlags = new Set(["--repo", "--ledger", "--model"]);
  for (let i = 0; i < argv.length; i++) {
    const value = argv[i]!;
    if (value.startsWith("--")) {
      if (valueFlags.has(value)) i += 1;
      continue;
    }
    return value;
  }
  return undefined;
}

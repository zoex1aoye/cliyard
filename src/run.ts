import type {
  HarnessConfig,
  RunTaskInput,
  RunTaskResult,
} from "./types.js";
import { discover, pickWorker } from "./discover.js";
import { buildWorkerCommand } from "./adapters.js";
import { shellQuote, wslExec } from "./wsl.js";

function slug(s: string): string {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 40) || "task"
  );
}

export async function runTask(
  cfg: HarnessConfig,
  input: RunTaskInput,
): Promise<RunTaskResult> {
  const caps = await discover(cfg);
  if (!caps.wslOk) {
    throw new Error(`WSL not ready: ${caps.notes.join("; ")}`);
  }
  if (!caps.gitOk) throw new Error("git missing in WSL");

  const worker = pickWorker(cfg, caps, input.worker);
  const permission = input.permission ?? cfg.permission;
  const repo = input.repo;
  const taskId = input.taskId ?? slug(input.prompt);
  const id = `${Date.now().toString(36)}-${taskId}`;
  const branch = `cliyard/${id}`;
  const worktreeRel = `${cfg.worktree_dir}/${id}`;

  const workerCmd = buildWorkerCommand(worker, {
    prompt: input.prompt,
    permission,
    model: input.model,
    fallbackModel: input.fallbackModel,
  });

  const setup = [
    `set -euo pipefail`,
    `cd ${shellQuote(repo)}`,
    `test -d .git || test -f .git`,
    `mkdir -p ${shellQuote(cfg.worktree_dir)}`,
    `git worktree add -b ${shellQuote(branch)} ${shellQuote(worktreeRel)} HEAD`,
    `echo WORKTREE=$(cd ${shellQuote(worktreeRel)} && pwd)`,
  ].join(" && ");

  if (input.dryRun) {
    return {
      taskId,
      worker,
      model: input.model,
      worktreePath: `${repo}/${worktreeRel}`,
      branch,
      exitCode: 0,
      diffStat: "(dry-run)",
      logTail: `Would run in worktree:\n${workerCmd}`,
    };
  }

  const setupRes = await wslExec(setup, {
    distro: cfg.distro,
    timeoutMs: 60_000,
  });
  if (setupRes.code !== 0) {
    throw new Error(
      `worktree setup failed:\n${setupRes.stderr || setupRes.stdout}`,
    );
  }

  const worktreePath =
    setupRes.stdout.match(/WORKTREE=(.+)/)?.[1]?.trim() ??
    `${repo}/${worktreeRel}`;

  const runScript = [
    `set -euo pipefail`,
    `cd ${shellQuote(worktreePath)}`,
    `echo "=== cliyard worker=${worker} model=${input.model ?? "default"} ==="`,
    workerCmd,
  ].join("\n");

  const runRes = await wslExec(runScript, {
    distro: cfg.distro,
    timeoutMs: 30 * 60_000,
  });

  const diff = await wslExec(
    `cd ${shellQuote(worktreePath)} && git diff --stat HEAD && git status -sb`,
    { distro: cfg.distro, timeoutMs: 30_000 },
  );

  const log = (runRes.stdout + "\n" + runRes.stderr).trim();
  return {
    taskId,
    worker,
    model: input.model,
    worktreePath,
    branch,
    exitCode: runRes.code,
    diffStat: (diff.stdout || diff.stderr).trim(),
    logTail: log.slice(-4000),
  };
}

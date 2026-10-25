import type { HarnessConfig, RunTaskResult, TaskFile } from "./types.js";
import { runTask } from "./run.js";
import { buildPrompt } from "./taskfile.js";

export interface BatchOptions {
  dryRun?: boolean;
  maxParallel?: number;
}

export async function runBatch(
  cfg: HarnessConfig,
  file: TaskFile,
  opts: BatchOptions = {},
): Promise<RunTaskResult[]> {
  const max =
    opts.maxParallel ??
    file.shared?.max_parallel ??
    cfg.max_parallel ??
    2;
  const contracts = file.shared?.contract_files ?? [];
  const results: RunTaskResult[] = [];
  const queue = [...file.tasks];

  const workers: Promise<void>[] = [];
  const runNext = async (): Promise<void> => {
    while (queue.length) {
      const task = queue.shift();
      if (!task) return;
      const result = await runTask(cfg, {
        repo: file.repo,
        prompt: buildPrompt(task, contracts),
        worker: task.worker ?? file.shared?.worker ?? "codebuddy",
        permission: task.permission ?? file.shared?.permission ?? cfg.permission,
        model: task.model,
        fallbackModel: task.fallback_model,
        taskId: task.id,
        paths: task.paths,
        dryRun: opts.dryRun,
      });
      results.push(result);
      console.error(
        `[cliyard] done ${task.id} exit=${result.exitCode} worker=${result.worker} model=${result.model ?? "-"}`,
      );
    }
  };

  const n = Math.min(max, file.tasks.length);
  for (let i = 0; i < n; i++) workers.push(runNext());
  await Promise.all(workers);

  // Preserve taskfile order in output
  const byId = new Map(results.map((r) => [r.taskId, r]));
  return file.tasks.map((t) => byId.get(t.id)!).filter(Boolean);
}

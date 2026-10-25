import type { PermissionIntent, WorkerId } from "./types.js";
import { shellQuote } from "./wsl.js";

export interface WorkerCommandOptions {
  prompt: string;
  permission: PermissionIntent;
  model?: string;
  fallbackModel?: string;
}

/**
 * Map harness intent → CLI-native argv.
 * Prefer each product's own sandbox/permission flags; do not wrap Docker here.
 */
export function buildWorkerCommand(
  worker: WorkerId,
  opts: WorkerCommandOptions,
): string {
  const q = shellQuote(opts.prompt);
  const modelFlag = opts.model ? `--model ${shellQuote(opts.model)}` : "";
  const fallbackFlag = opts.fallbackModel
    ? `--fallback-model ${shellQuote(opts.fallbackModel)}`
    : "";

  switch (worker) {
    case "claude": {
      const perm =
        opts.permission === "bypass"
          ? "--permission-mode bypassPermissions"
          : "--permission-mode acceptEdits";
      return [`claude -p ${q}`, modelFlag, perm].filter(Boolean).join(" ");
    }
    case "codex": {
      const sandbox =
        opts.permission === "bypass"
          ? "--sandbox danger-full-access"
          : "--sandbox workspace-write";
      const approval =
        opts.permission === "bypass"
          ? "--ask-for-approval never"
          : "--ask-for-approval on-failure";
      return [`codex exec`, modelFlag, sandbox, approval, q]
        .filter(Boolean)
        .join(" ");
    }
    case "codebuddy": {
      // CodeBuddy: -p with file/tool use requires --dangerously-skip-permissions.
      const perm =
        opts.permission === "bypass"
          ? "--permission-mode bypassPermissions"
          : "--permission-mode acceptEdits";
      return [
        `codebuddy -p ${q}`,
        modelFlag,
        fallbackFlag,
        perm,
        "--dangerously-skip-permissions",
      ]
        .filter(Boolean)
        .join(" ");
    }
    default: {
      const _exhaustive: never = worker;
      return _exhaustive;
    }
  }
}

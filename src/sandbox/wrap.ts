/**
 * Build `nono wrap` argv for worker CLI embedding
 * (design/sandbox-nono-worker-wrap-v0.md).
 *
 * `nono wrap` execs into the child so the sandbox parent disappears — suitable
 * for process-tree ownership of the worker itself.
 */
import type { SandboxReport } from "./types.js";

export interface NonoWrapCommandInput {
  /** Absolute path to the pinned nono binary (or `nono` on PATH). */
  nonoBinary?: string;
  /** Directories granted read+write (typically the task worktree). */
  allowDirs: readonly string[];
  /** Optional read-only directories (typically the repo root). */
  readDirs?: readonly string[];
  /** Worker program path. */
  command: string;
  /** Worker argv (without the program). */
  args?: readonly string[];
  /** Pass `--allow-cwd` (default true for non-interactive hosts). */
  allowCwd?: boolean;
  /** Pass `-s` / `--silent` (default true). */
  silent?: boolean;
}

export interface NonoWrapCommand {
  command: string;
  args: string[];
}

/**
 * Build the argv that replaces a direct worker spawn with a sandboxed wrap.
 */
export function buildNonoWrapCommand(
  input: NonoWrapCommandInput,
): NonoWrapCommand {
  if (typeof input.command !== "string" || input.command.trim() === "") {
    throw new Error("nono wrap requires a non-empty worker command");
  }
  if (!Array.isArray(input.allowDirs) || input.allowDirs.length === 0) {
    throw new Error("nono wrap requires at least one allow directory");
  }
  for (const dir of input.allowDirs) {
    if (typeof dir !== "string" || dir.trim() === "") {
      throw new Error("nono wrap allowDirs entries must be non-empty strings");
    }
  }
  const nono = input.nonoBinary?.trim() || "nono";
  const args: string[] = ["wrap"];
  if (input.silent !== false) args.push("-s");
  if (input.allowCwd !== false) args.push("--allow-cwd");
  for (const dir of input.allowDirs) {
    args.push("-a", dir);
  }
  for (const dir of input.readDirs ?? []) {
    if (typeof dir !== "string" || dir.trim() === "") {
      throw new Error("nono wrap readDirs entries must be non-empty strings");
    }
    args.push("-r", dir);
  }
  args.push("--", input.command, ...(input.args ?? []));
  return { command: nono, args };
}

/**
 * When a prepare report is `prepared`, rewrite spawn to go through nono wrap.
 * Otherwise return the original command/args unchanged (opt-in only).
 */
export function applySandboxWrapToSpawn(
  command: string,
  args: readonly string[],
  options: {
    report: SandboxReport;
    workspaceRoot: string;
    repoRoot?: string;
    nonoBinary?: string;
  },
): NonoWrapCommand {
  if (options.report.status !== "prepared") {
    return { command, args: [...args] };
  }
  if (options.report.backendType !== "nono") {
    return { command, args: [...args] };
  }
  return buildNonoWrapCommand({
    nonoBinary: options.nonoBinary,
    allowDirs: [options.workspaceRoot],
    readDirs:
      options.repoRoot !== undefined ? [options.repoRoot] : undefined,
    command,
    args,
  });
}

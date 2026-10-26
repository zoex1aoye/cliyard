/**
 * Local (Darwin/Linux) git worktree helpers for Codex worker isolation.
 * Windows WSL worktrees remain in src/run.ts.
 */
import { spawn } from "node:child_process";
import { mkdirSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";

export interface WorktreeSpec {
  repoRoot: string;
  taskId: string;
  /** Relative dir under repo, default `.cliyard/worktrees/<taskId>` */
  worktreeDir?: string;
  baseCommit?: string;
}

export interface WorktreeHandle {
  taskId: string;
  branch: string;
  worktreePath: string;
  repoRoot: string;
}

function run(
  cmd: string,
  args: string[],
  cwd: string,
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(cmd, args, { cwd, env: process.env });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => {
      stdout += String(d);
    });
    child.stderr.on("data", (d) => {
      stderr += String(d);
    });
    child.on("error", reject);
    child.on("close", (code) => {
      resolvePromise({ code: code ?? 1, stdout, stderr });
    });
  });
}

function slug(s: string): string {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 40) || "task"
  );
}

export async function addWorktree(spec: WorktreeSpec): Promise<WorktreeHandle> {
  const repoRoot = resolve(spec.repoRoot);
  const gitDir = join(repoRoot, ".git");
  if (!existsSync(gitDir)) {
    throw new Error(`worktree: not a git repo: ${repoRoot}`);
  }

  const id = `${Date.now().toString(36)}-${slug(spec.taskId)}`;
  const branch = `cliyard/${id}`;
  const rel =
    // Each dispatch gets a reviewable, collision-free worktree. Keeping a
    // previous run must not block an identical taskId from running later.
    spec.worktreeDir ?? join(".cliyard", "worktrees", id);
  const worktreePath = resolve(repoRoot, rel);
  const base = spec.baseCommit ?? "HEAD";

  mkdirSync(resolve(repoRoot, ".cliyard", "worktrees"), { recursive: true });

  // Remove stale worktree dir registration if any
  await run("git", ["worktree", "prune"], repoRoot);

  const add = await run(
    "git",
    ["worktree", "add", "-b", branch, worktreePath, base],
    repoRoot,
  );
  if (add.code !== 0) {
    throw new Error(
      `git worktree add failed:\n${add.stderr || add.stdout}`,
    );
  }

  return { taskId: spec.taskId, branch, worktreePath, repoRoot };
}

export async function removeWorktree(
  handle: WorktreeHandle,
  opts?: { force?: boolean },
): Promise<void> {
  const args = ["worktree", "remove"];
  if (opts?.force) args.push("--force");
  args.push(handle.worktreePath);
  const res = await run("git", args, handle.repoRoot);
  if (res.code !== 0) {
    // Best-effort: prune
    await run("git", ["worktree", "prune"], handle.repoRoot);
  }
  await run("git", ["branch", "-D", handle.branch], handle.repoRoot).catch(
    () => undefined,
  );
}

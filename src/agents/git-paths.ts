import { spawn } from "node:child_process";

/** Paths changed relative to a task baseline, including non-ignored files. */
export async function collectChangedPaths(
  cwd: string,
  baseCommit: string,
): Promise<{ paths: string[]; error?: string }> {
  const diff = await runGit(cwd, [
    "diff",
    "--name-only",
    "-z",
    baseCommit,
    "--",
  ]);
  if (diff.code !== 0) {
    return {
      paths: [],
      error:
        (diff.stderr || diff.stdout).trim() ||
        `git diff exited ${diff.code}`,
    };
  }
  const untracked = await runGit(cwd, [
    "ls-files",
    "--others",
    "--exclude-standard",
    "-z",
  ]);
  if (untracked.code !== 0) {
    return {
      paths: [],
      error:
        (untracked.stderr || untracked.stdout).trim() ||
        `git ls-files exited ${untracked.code}`,
    };
  }
  const paths = new Set<string>();
  for (const value of `${diff.stdout}\0${untracked.stdout}`.split("\0")) {
    if (
      value &&
      value !== "node_modules" &&
      !value.startsWith("node_modules/")
    ) {
      paths.add(value);
    }
  }
  return { paths: [...paths] };
}

function runGit(
  cwd: string,
  args: string[],
): Promise<{ code: number; stdout: string; stderr: string }> {
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
      resolvePromise({ code: code ?? 1, stdout, stderr });
    });
  });
}

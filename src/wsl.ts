import { spawn } from "node:child_process";

export interface WslExecOptions {
  distro: string;
  cwd?: string;
  timeoutMs?: number;
}

export interface WslExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Run a command string inside WSL via bash -lc. */
export function wslExec(
  command: string,
  opts: WslExecOptions,
): Promise<WslExecResult> {
  const args = ["-d", opts.distro];
  if (opts.cwd) {
    args.push("--cd", opts.cwd);
  }
  args.push("--", "bash", "-lc", command);

  return new Promise((resolvePromise, reject) => {
    const child = spawn("wsl.exe", args, {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => {
      stdout += d.toString("utf8");
    });
    child.stderr.on("data", (d: Buffer) => {
      stderr += d.toString("utf8");
    });

    const timer =
      opts.timeoutMs &&
      setTimeout(() => {
        child.kill();
        reject(new Error(`wsl timeout after ${opts.timeoutMs}ms: ${command}`));
      }, opts.timeoutMs);

    child.on("error", (err) => {
      if (timer) clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      resolvePromise({ code: code ?? 1, stdout, stderr });
    });
  });
}

export function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

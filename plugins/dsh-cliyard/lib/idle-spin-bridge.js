/**
 * Thin bridge: DSH tool → `npx tsx src/cli.ts mvp-test` in controlRoot.
 * Plain ESM (Cordis plugin; no TypeScript syntax).
 * M2: AbortSignal / cancel-after kills the bridge child process group.
 */
import { spawn } from "node:child_process";
import { resolve } from "node:path";

/**
 * @param {number} pid
 * @param {NodeJS.Signals} signal
 */
function tryKill(pid, signal) {
  try {
    process.kill(pid, signal);
    return true;
  } catch {
    return false;
  }
}

/**
 * @param {import('node:child_process').ChildProcess} child
 */
function killBridgeChild(child) {
  const pid = child.pid;
  if (!pid) return;
  // Bridge spawns npx detached=false but we still try group then pid.
  tryKill(-pid, "SIGTERM");
  tryKill(pid, "SIGTERM");
  setTimeout(() => {
    tryKill(-pid, "SIGKILL");
    tryKill(pid, "SIGKILL");
  }, 50);
}

/**
 * @param {{
 *   controlRoot: string,
 *   repoRoot: string,
 *   contractPath?: string,
 *   replaceExisting?: boolean,
 *   cancelAfterMs?: number,
 *   signal?: AbortSignal,
 * }} input
 * @returns {Promise<{ code: number, stdout: string, stderr: string, disposed?: boolean }>}
 */
export function runMvpTestViaCli(input) {
  const args = [
    "tsx",
    "src/cli.ts",
    "mvp-test",
    "--repo",
    resolve(input.repoRoot),
    "--json",
  ];
  if (input.replaceExisting) args.push("--replace-existing");
  if (
    typeof input.cancelAfterMs === "number" &&
    Number.isFinite(input.cancelAfterMs)
  ) {
    args.push("--cancel-after-ms", String(input.cancelAfterMs));
  }
  if (input.contractPath) args.push(resolve(input.contractPath));

  return new Promise((resolvePromise, reject) => {
    if (input.signal?.aborted) {
      resolvePromise({
        code: 1,
        stdout: "",
        stderr: "aborted before mvp-test spawn",
        disposed: true,
      });
      return;
    }

    const child = spawn("npx", args, {
      cwd: resolve(input.controlRoot),
      env: process.env,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let disposed = false;
    let settled = false;

    const finish = (code) => {
      if (settled) return;
      settled = true;
      input.signal?.removeEventListener("abort", onAbort);
      resolvePromise({
        code: code ?? 1,
        stdout,
        stderr,
        ...(disposed ? { disposed: true } : {}),
      });
    };

    const onAbort = () => {
      disposed = true;
      killBridgeChild(child);
    };
    input.signal?.addEventListener("abort", onAbort, { once: true });

    child.stdout.on("data", (d) => {
      stdout += String(d);
    });
    child.stderr.on("data", (d) => {
      stderr += String(d);
    });
    child.on("error", (err) => {
      input.signal?.removeEventListener("abort", onAbort);
      reject(err);
    });
    child.on("close", (code) => {
      finish(code);
    });
  });
}

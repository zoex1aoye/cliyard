/**
 * Thin bridge: DSH tool → mvp-demo CLI.
 * Plain ESM (no TypeScript syntax).
 */
import { spawn } from "node:child_process";
import { resolve } from "node:path";

/**
 * @param {{
 *   controlRoot: string,
 *   repoRoot: string,
 *   planPaths?: string[],
 * }} input
 * @returns {Promise<{ code: number, stdout: string, stderr: string }>}
 */
export function runMvpDemoViaCli(input) {
  const args = [
    "tsx",
    "src/cli.ts",
    "mvp-demo",
    "--repo",
    resolve(input.repoRoot),
    "--json",
  ];
  for (const p of input.planPaths ?? []) {
    args.push(resolve(p));
  }
  return new Promise((resolvePromise, reject) => {
    const child = spawn("npx", args, {
      cwd: resolve(input.controlRoot),
      env: process.env,
    });
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

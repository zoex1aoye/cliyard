/**
 * Thin bridge: DSH tool → `npx tsx src/cli.ts mvp-test` in controlRoot.
 * Plain ESM (Cordis plugin; no TypeScript syntax).
 */
import { spawn } from "node:child_process";
import { resolve } from "node:path";

/**
 * @param {{
 *   controlRoot: string,
 *   repoRoot: string,
 *   contractPath?: string,
 *   replaceExisting?: boolean,
 * }} input
 * @returns {Promise<{ code: number, stdout: string, stderr: string }>}
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
  if (input.contractPath) args.push(resolve(input.contractPath));
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

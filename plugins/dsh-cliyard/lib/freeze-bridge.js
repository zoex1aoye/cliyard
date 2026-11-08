/**
 * Thin bridge: DSH tools → mvp-compile / mvp-freeze CLI.
 * Plain ESM (no TypeScript syntax).
 */
import { spawn } from "node:child_process";
import { resolve } from "node:path";

/**
 * @param {{
 *   controlRoot: string,
 *   args: string[],
 * }} input
 * @returns {Promise<{ code: number, stdout: string, stderr: string }>}
 */
function runCli(input) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn("npx", ["tsx", "src/cli.ts", ...input.args], {
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

/**
 * @param {{
 *   controlRoot: string,
 *   planPath: string,
 *   outDir: string,
 * }} input
 */
export function runMvpCompileViaCli(input) {
  return runCli({
    controlRoot: input.controlRoot,
    args: [
      "mvp-compile",
      resolve(input.planPath),
      "--out",
      resolve(input.outDir),
      "--json",
    ],
  });
}

/**
 * @param {{
 *   controlRoot: string,
 *   draftPath: string,
 *   outPath: string,
 * }} input
 */
export function runMvpFreezeViaCli(input) {
  return runCli({
    controlRoot: input.controlRoot,
    args: [
      "mvp-freeze",
      resolve(input.draftPath),
      "--out",
      resolve(input.outPath),
      "--json",
    ],
  });
}

import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";

const here = dirname(fileURLToPath(import.meta.url));

/** cliyard control-plane root (plugins/dsh-cliyard/lib → ../../..) */
export function defaultControlRoot() {
  return resolve(here, "../../..");
}

/** Backward-compatible alias. Prefer defaultControlRoot for clarity. */
export function defaultRepoRoot() {
  return defaultControlRoot();
}

export function resolveControlRoot(configured) {
  if (configured && configured !== ".") {
    return resolve(configured);
  }
  return defaultControlRoot();
}

/**
 * Target business repo whose worktrees/ledger are managed.
 * Falls back to the cliyard repo for standalone demos.
 */
export function resolveRepoRoot(configured) {
  if (configured && configured !== ".") {
    return resolve(configured);
  }
  return defaultControlRoot();
}

export function cliyardEntry(controlRoot) {
  const tsxCli = join(controlRoot, "src", "cli.ts");
  if (existsSync(tsxCli)) return tsxCli;
  const dist = join(controlRoot, "dist", "cli.js");
  if (existsSync(dist)) return dist;
  throw new Error(`cliyard CLI not found under ${controlRoot}`);
}

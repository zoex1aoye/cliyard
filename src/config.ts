import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import type { HarnessConfig, WorkerId } from "./types.js";

const DEFAULTS: HarnessConfig = {
  distro: "Ubuntu",
  workers: ["codebuddy", "claude", "codex"],
  permission: "accept",
  worktree_dir: ".cliyard/worktrees",
};

/** Minimal YAML subset: key: value and nested workers list. Good enough for v0. */
export function loadConfig(cwd = process.cwd()): HarnessConfig {
  const path = resolve(cwd, "config.yaml");
  if (!existsSync(path)) return { ...DEFAULTS };

  const text = readFileSync(path, "utf8");
  const cfg: HarnessConfig = { ...DEFAULTS, workers: [...DEFAULTS.workers] };

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, "").trimEnd();
    if (!line.trim()) continue;

    const m = line.match(/^([a-z_]+):\s*(.*)$/i);
    if (!m) continue;
    const key = m[1];
    const val = m[2].trim().replace(/^["']|["']$/g, "");

    if (key === "distro" && val) cfg.distro = val;
    if (key === "default_repo" && val) cfg.default_repo = val;
    if (key === "permission" && (val === "accept" || val === "bypass")) {
      cfg.permission = val;
    }
    if (key === "worktree_dir" && val) cfg.worktree_dir = val;
  }

  const workers: WorkerId[] = [];
  let inWorkers = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, "");
    if (/^\s*workers:\s*$/.test(line)) {
      inWorkers = true;
      continue;
    }
    if (inWorkers) {
      const item = line.match(/^\s*-\s+(\w+)\s*$/);
      if (item && isWorkerId(item[1])) {
        workers.push(item[1]);
        continue;
      }
      if (line.trim() && !line.startsWith(" ") && !line.startsWith("\t")) {
        inWorkers = false;
      }
    }
  }
  if (workers.length) cfg.workers = workers;

  return cfg;
}

function isWorkerId(s: string): s is WorkerId {
  return s === "claude" || s === "codex" || s === "codebuddy";
}

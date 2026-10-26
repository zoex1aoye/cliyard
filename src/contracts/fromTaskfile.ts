/**
 * TaskFile YAML → TaskContract adapter (Route C import path).
 * Missing Route C fields get deterministic defaults; output must pass validateContract.
 */
import { loadTaskFile } from "../taskfile.js";
import type { TaskFile, TaskFileItem } from "../types.js";
import { validateContract, type TaskContract } from "./schema.js";

export interface FromTaskfileOptions {
  /** Frozen contract version (default 1). */
  version?: number;
  baseCommit?: string;
  maxRepairs?: number;
  /** Applied when taskfile has no verify commands (default []). */
  verifyCommands?: string[];
  /** Mark contracts frozen for dispatch (default true). */
  frozen?: boolean;
}

const DEFAULTS = {
  version: 1,
  baseCommit: "HEAD",
  maxRepairs: 2,
  frozen: true,
  verifyCommands: [] as string[],
} as const;

/**
 * Convert one TaskFileItem (+ shared context) into a validated TaskContract.
 */
export function taskItemToContract(
  item: TaskFileItem,
  file: TaskFile,
  opts: FromTaskfileOptions = {},
): TaskContract {
  const version = opts.version ?? DEFAULTS.version;
  const baseCommit = opts.baseCommit ?? DEFAULTS.baseCommit;
  const maxRepairs = opts.maxRepairs ?? DEFAULTS.maxRepairs;
  const frozen = opts.frozen ?? DEFAULTS.frozen;
  const verifyCommands = opts.verifyCommands ?? [...DEFAULTS.verifyCommands];

  const writePaths = item.paths?.length ? [...item.paths] : [];
  const contractFiles = file.shared?.contract_files ?? [];
  const readPaths = unique([
    ...contractFiles,
    ...writePaths,
  ]);

  const goals = [firstGoalLine(item.prompt)];
  const raw = {
    taskId: item.id,
    version,
    frozen,
    goals,
    dependsOn: [] as string[],
    readPaths: readPaths.length ? readPaths : ["."],
    writePaths,
    sharedResources: [] as string[],
    baseCommit,
    verifyCommands,
    maxRepairs,
  };

  const result = validateContract(raw);
  if (!result.ok) {
    const detail = result.issues
      .map((i) => `${i.path || "(root)"}: ${i.message}`)
      .join("; ");
    throw new Error(`TaskFile item "${item.id}" → invalid TaskContract: ${detail}`);
  }
  return result.contract;
}

/** Convert all tasks in a TaskFile to TaskContract[]. */
export function taskFileToContracts(
  file: TaskFile,
  opts: FromTaskfileOptions = {},
): TaskContract[] {
  return file.tasks.map((t) => taskItemToContract(t, file, opts));
}

/** Load YAML taskfile and adapt to TaskContract[]. */
export function loadTaskFileAsContracts(
  path: string,
  opts: FromTaskfileOptions = {},
): TaskContract[] {
  return taskFileToContracts(loadTaskFile(path), opts);
}

function firstGoalLine(prompt: string): string {
  const line = prompt
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  if (!line) throw new Error("task prompt is empty");
  return line;
}

function unique(xs: string[]): string[] {
  return [...new Set(xs)];
}

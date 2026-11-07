/**
 * Durable VerificationTask JSON store under
 * `<repoRoot>/.cliyard/verification/<id>.json`.
 */
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  isVerificationTask,
  type VerificationTask,
} from "./task-types.js";

export const VERIFICATION_DIR_NAME = "verification" as const;

export function verificationDir(repoRoot: string): string {
  return join(repoRoot, ".cliyard", VERIFICATION_DIR_NAME);
}

export function verificationTaskPath(repoRoot: string, id: string): string {
  if (!/^[A-Za-z0-9._-]+$/.test(id)) {
    throw new Error(`invalid verification task id: ${id}`);
  }
  return join(verificationDir(repoRoot), `${id}.json`);
}

export function ensureVerificationDir(repoRoot: string): string {
  const dir = verificationDir(repoRoot);
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function saveVerificationTask(
  repoRoot: string,
  task: VerificationTask,
): void {
  if (!isVerificationTask(task)) {
    throw new Error("refusing to persist invalid VerificationTask");
  }
  ensureVerificationDir(repoRoot);
  const path = verificationTaskPath(repoRoot, task.id);
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(task, null, 2)}\n`, "utf8");
  renameSync(tmp, path);
}

export function loadVerificationTask(
  repoRoot: string,
  id: string,
): VerificationTask | null {
  const path = verificationTaskPath(repoRoot, id);
  if (!existsSync(path)) return null;
  const raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
  if (!isVerificationTask(raw)) {
    throw new Error(`invalid VerificationTask at ${path}`);
  }
  return raw;
}

export function listVerificationTasks(repoRoot: string): VerificationTask[] {
  const dir = verificationDir(repoRoot);
  if (!existsSync(dir)) return [];
  const out: VerificationTask[] = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".json")) continue;
    if (name.includes(".tmp")) continue;
    const id = name.slice(0, -".json".length);
    const task = loadVerificationTask(repoRoot, id);
    if (task) out.push(task);
  }
  out.sort((a, b) => a.id.localeCompare(b.id));
  return out;
}

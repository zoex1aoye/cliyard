/**
 * Start a detached VerificationTask worker process group
 * (design/verification-task-v0.md).
 */
import { spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { ProcessInspector } from "../runtime/process.js";
import {
  VERIFICATION_TASK_SPEC_VERSION,
  isTerminalVerificationStatus,
  type VerificationTask,
} from "./task-types.js";
import {
  ensureVerificationDir,
  loadVerificationTask,
  saveVerificationTask,
  verificationDir,
  verificationTaskPath,
} from "./task-store.js";

export interface StartVerificationTaskInput {
  repoRoot: string;
  /** Absolute task worktree cwd; must already be at artifactCommit. */
  worktreeCwd: string;
  runId: string;
  taskId: string;
  artifactCommit: string;
  contractsHash: string;
  commands: string[];
  runtimeRequirements?: string[];
  evidenceRefs?: string[];
  id?: string;
  /** Injected clock (tests). */
  now?: () => string;
  /** Injected inspector (tests). */
  inspector?: ProcessInspector;
}

export interface StartVerificationTaskResult {
  task: VerificationTask;
  /** Detached worker pid (process group leader on POSIX). */
  workerPid: number;
}

function assertAbsoluteDir(path: string, label: string): void {
  if (typeof path !== "string" || path.trim() === "") {
    throw new Error(`${label} must be a non-empty path`);
  }
  if (!path.startsWith("/")) {
    throw new Error(`${label} must be an absolute path`);
  }
  if (!existsSync(path) || !statSync(path).isDirectory()) {
    throw new Error(`${label} must be an existing directory`);
  }
}

function resolveHead(cwd: string): string | null {
  const result = spawnSync("git", ["rev-parse", "HEAD"], {
    cwd,
    encoding: "utf8",
  });
  if (result.status !== 0) return null;
  return (result.stdout || "").trim() || null;
}

/**
 * Build the detached worker script. Uses only Node builtins so it can run
 * without compiling the control-plane package into the worktree.
 */
function buildWorkerSource(input: {
  repoRoot: string;
  taskId: string;
  taskPath: string;
  outputPath: string;
  worktreeCwd: string;
}): string {
  return `#!/usr/bin/env node
"use strict";
const { spawnSync } = require("node:child_process");
const { appendFileSync, readFileSync, renameSync, writeFileSync, existsSync } = require("node:fs");

const taskPath = ${JSON.stringify(input.taskPath)};
const outputPath = ${JSON.stringify(input.outputPath)};
const worktreeCwd = ${JSON.stringify(input.worktreeCwd)};

function load() {
  return JSON.parse(readFileSync(taskPath, "utf8"));
}
function save(task) {
  const tmp = taskPath + "." + process.pid + ".tmp";
  writeFileSync(tmp, JSON.stringify(task, null, 2) + "\\n", "utf8");
  renameSync(tmp, taskPath);
}
function append(chunk) {
  appendFileSync(outputPath, chunk, "utf8");
  const task = load();
  task.output = task.output || { uri: outputPath, offset: 0 };
  task.output.offset = Buffer.byteLength(
    existsSync(outputPath) ? readFileSync(outputPath) : Buffer.alloc(0),
  );
  save(task);
}

let task = load();
task.status = "running";
task.startedAt = task.startedAt || new Date().toISOString();
save(task);

const commands = Array.isArray(task.commands) ? task.commands : [];
let failed = false;
let lastCode = 0;
for (const command of commands) {
  append("$ " + command + "\\n");
  const result = spawnSync("/bin/sh", ["-c", command], {
    cwd: worktreeCwd,
    encoding: "utf8",
    env: process.env,
  });
  if (result.stdout) append(result.stdout);
  if (result.stderr) append(result.stderr);
  lastCode = result.status === null ? 1 : result.status;
  append("[exit " + String(lastCode) + "]\\n");
  if (lastCode !== 0) {
    failed = true;
    break;
  }
}

task = load();
task.status = failed ? "failed" : "succeeded";
task.endedAt = new Date().toISOString();
if (failed) {
  task.lastError = {
    version: 1,
    category: "verifier_rejected",
    stage: "verifier",
    code: "verification_command_failed",
    message: "verification command failed with exit " + String(lastCode),
    observedAt: task.endedAt,
    retryableHint: false,
  };
}
task.output.offset = Buffer.byteLength(
  existsSync(outputPath) ? readFileSync(outputPath) : Buffer.alloc(0),
);
save(task);
process.exit(failed ? 1 : 0);
`;
}

/**
 * Persist a queued task and start a detached worker process group.
 * Caller must supply an absolute worktree already at `artifactCommit`.
 */
export async function startVerificationTask(
  input: StartVerificationTaskInput,
): Promise<StartVerificationTaskResult> {
  assertAbsoluteDir(input.repoRoot, "repoRoot");
  assertAbsoluteDir(input.worktreeCwd, "worktreeCwd");
  if (input.commands.length === 0) {
    throw new Error("VerificationTask requires at least one command");
  }
  const head = resolveHead(input.worktreeCwd);
  if (head === null || head !== input.artifactCommit) {
    throw new Error(
      `worktree HEAD ${head ?? "(unknown)"} does not match artifactCommit ${input.artifactCommit}`,
    );
  }

  const now = input.now ?? (() => new Date().toISOString());
  const id = input.id ?? `vt-${randomUUID()}`;
  ensureVerificationDir(input.repoRoot);
  const taskDir = join(verificationDir(input.repoRoot), id);
  mkdirSync(taskDir, { recursive: true });
  const outputPath = join(taskDir, "output.log");
  const workerPath = join(taskDir, "worker.cjs");
  const taskPath = verificationTaskPath(input.repoRoot, id);

  writeFileSync(outputPath, "", "utf8");
  writeFileSync(
    workerPath,
    buildWorkerSource({
      repoRoot: input.repoRoot,
      taskId: id,
      taskPath,
      outputPath,
      worktreeCwd: input.worktreeCwd,
    }),
    "utf8",
  );

  const task: VerificationTask = {
    id,
    runId: input.runId,
    taskId: input.taskId,
    artifactCommit: input.artifactCommit,
    contractsHash: input.contractsHash,
    specVersion: VERIFICATION_TASK_SPEC_VERSION,
    commands: [...input.commands],
    ...(input.runtimeRequirements
      ? { runtimeRequirements: [...input.runtimeRequirements] }
      : {}),
    status: "queued",
    output: { uri: outputPath, offset: 0 },
    evidenceRefs: [...(input.evidenceRefs ?? [])],
    worktreeCwd: input.worktreeCwd,
  };
  saveVerificationTask(input.repoRoot, task);

  // Detached POSIX process group; stdio ignored so the parent can exit.
  const child = spawn(process.execPath, [workerPath], {
    cwd: input.worktreeCwd,
    detached: true,
    stdio: "ignore",
    env: process.env,
  });
  if (child.pid === undefined) {
    throw new Error("failed to spawn verification worker");
  }
  child.unref();

  const inspector = input.inspector ?? new ProcessInspector();
  // Brief settle so ps can observe the leader.
  let identity = await inspector.capture(child.pid);
  for (let i = 0; i < 10 && identity === undefined; i += 1) {
    await new Promise((r) => setTimeout(r, 20));
    identity = await inspector.capture(child.pid);
  }

  const started: VerificationTask = {
    ...task,
    status: "running",
    startedAt: now(),
    ...(identity ? { ownerIdentity: identity } : {}),
  };
  saveVerificationTask(input.repoRoot, started);
  return { task: started, workerPid: child.pid };
}

/**
 * Idempotent delivery latch: first observation of a terminal task sets
 * `deliveredAt`. Subsequent calls leave the timestamp unchanged.
 */
export function markVerificationDelivered(
  repoRoot: string,
  id: string,
  now: () => string = () => new Date().toISOString(),
): VerificationTask {
  const task = loadVerificationTask(repoRoot, id);
  if (!task) throw new Error(`unknown verification task: ${id}`);
  if (!isTerminalVerificationStatus(task.status)) {
    throw new Error(
      `cannot deliver non-terminal verification task ${id} (${task.status})`,
    );
  }
  if (task.deliveredAt !== undefined) return task;
  const next: VerificationTask = { ...task, deliveredAt: now() };
  saveVerificationTask(repoRoot, next);
  return next;
}

/**
 * Poll the durable record until terminal or timeout.
 */
export async function awaitVerificationTask(
  repoRoot: string,
  id: string,
  options: { timeoutMs?: number; pollMs?: number } = {},
): Promise<VerificationTask> {
  const timeoutMs = options.timeoutMs ?? 30_000;
  const pollMs = options.pollMs ?? 50;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const task = loadVerificationTask(repoRoot, id);
    if (!task) throw new Error(`unknown verification task: ${id}`);
    if (isTerminalVerificationStatus(task.status)) return task;
    if (Date.now() >= deadline) {
      throw new Error(`verification task ${id} timed out in status ${task.status}`);
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }
}

/** Test helper: force-write a status without spawning (recovery fixtures). */
export function putVerificationTaskForTest(
  repoRoot: string,
  task: VerificationTask,
): void {
  saveVerificationTask(repoRoot, task);
}

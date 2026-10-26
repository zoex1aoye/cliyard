export type WorkerId = "claude" | "codex" | "codebuddy";

/** Re-export Route C contract / status for consumers; see contracts/ + core/. */
export type { TaskContract } from "./contracts/schema.js";
export type { TaskStatus } from "./core/status.js";

export type PermissionIntent = "accept" | "bypass";

export interface HarnessConfig {
  distro: string;
  default_repo?: string;
  workers: WorkerId[];
  permission: PermissionIntent;
  worktree_dir: string;
  /** Max parallel CodeBuddy (or other) workers; same account shares quota. */
  max_parallel?: number;
}

export interface Capabilities {
  distro: string;
  wslOk: boolean;
  workers: Partial<Record<WorkerId, { path: string; ok: boolean }>>;
  gitOk: boolean;
  notes: string[];
}

export interface RunTaskInput {
  repo: string;
  prompt: string;
  worker: WorkerId | "auto";
  permission?: PermissionIntent;
  dryRun?: boolean;
  /** CLI model id, e.g. codebuddy --model */
  model?: string;
  fallbackModel?: string;
  /** Stable id for branch/worktree naming */
  taskId?: string;
  /** Hint paths for the worker prompt (isolation contract) */
  paths?: string[];
}

export interface RunTaskResult {
  taskId?: string;
  worker: WorkerId;
  model?: string;
  worktreePath: string;
  branch: string;
  exitCode: number;
  diffStat: string;
  logTail: string;
}

export interface TaskFileShared {
  contract_files?: string[];
  permission?: PermissionIntent;
  worker?: WorkerId | "auto";
  max_parallel?: number;
}

export interface TaskFileItem {
  id: string;
  model?: string;
  fallback_model?: string;
  paths?: string[];
  prompt: string;
  worker?: WorkerId | "auto";
  permission?: PermissionIntent;
}

export interface TaskFile {
  repo: string;
  shared?: TaskFileShared;
  tasks: TaskFileItem[];
}

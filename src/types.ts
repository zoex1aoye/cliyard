export type WorkerId = "claude" | "codex" | "codebuddy";

export type PermissionIntent = "accept" | "bypass";

export interface HarnessConfig {
  distro: string;
  default_repo?: string;
  workers: WorkerId[];
  permission: PermissionIntent;
  worktree_dir: string;
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
}

export interface RunTaskResult {
  worker: WorkerId;
  worktreePath: string;
  branch: string;
  exitCode: number;
  diffStat: string;
  logTail: string;
}

/**
 * Supervisor v0 durable state (design/supervisor-v0.md).
 *
 * One RunManifest per local run, stored at
 * `<repoRoot>/.cliyard/runs/<runId>.json`. The manifest is the resume
 * authority: accepted tasks and the integration head must survive a
 * supervisor process restart.
 */
import type { TaskStatus } from "../core/status.js";

export const RUN_MANIFEST_VERSION = 1 as const;
export const ACTIVE_RUN_VERSION = 1 as const;

export type RunStatus = "running" | "interrupted" | "completed" | "blocked";

export interface RunOwner {
  pid: number;
  host: string;
}

export interface RunTaskState {
  taskId: string;
  status: TaskStatus;
  /** Worker/closed-loop run id, when the task was dispatched. */
  runId?: string;
  accepted: boolean;
  resultCommit?: string;
  reason?: string;
}

export interface RunManifest {
  version: typeof RUN_MANIFEST_VERSION;
  runId: string;
  planId: string;
  repoRoot: string;
  contractsPath: string;
  contractsHash: string;
  baseCommit: string;
  integrationBranch: string;
  integrationHead: string;
  status: RunStatus;
  createdAt: string;
  updatedAt: string;
  owner: RunOwner;
  tasks: Record<string, RunTaskState>;
}

/** `<repoRoot>/.cliyard/runs/active.json` — points at the latest run. */
export interface ActiveRunPointer {
  version: typeof ACTIVE_RUN_VERSION;
  runId: string;
  updatedAt: string;
}

/** `<repoRoot>/.cliyard/supervisor.lock` — exclusive supervisor ownership. */
export interface SupervisorLockInfo {
  runId: string;
  pid: number;
  host: string;
  acquiredAt: string;
}

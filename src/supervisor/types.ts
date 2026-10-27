/**
 * Supervisor v0 durable state (design/supervisor-v0.md).
 *
 * One RunManifest per local run, stored at
 * `<repoRoot>/.cliyard/runs/<runId>.json`. The manifest is the resume
 * authority: accepted tasks and the integration head must survive a
 * supervisor process restart.
 */
import type { TaskStatus } from "../core/status.js";
import type { CostTruth, FailureRecord } from "../failures.js";

export const RUN_MANIFEST_VERSION = 1 as const;
export const ACTIVE_RUN_VERSION = 1 as const;
export const MAX_PATH_AUDITS = 64;
export const MAX_PATH_AUDIT_PATHS = 128;
export const MAX_PATH_AUDIT_ERROR_LENGTH = 2_000;

export type RunStatus = "running" | "interrupted" | "completed" | "blocked";

export interface RunOwner {
  pid: number;
  host: string;
}

/**
 * Bounded, non-authoritative evidence for one worker exit. Path observations
 * never grant acceptance or replace the worker's structured failure.
 */
export interface PathAuditRecord {
  /** 0-based attempt index within the closed-loop invocation. */
  attempt: number;
  observedAt: string;
  /** Normalized worker exit code returned by the adapter. */
  exitCode: number;
  changedPaths: string[];
  outsideWritePaths: string[];
  changedPathsError?: string;
}

export interface RunTaskState {
  taskId: string;
  status: TaskStatus;
  /** Worker/closed-loop run id, when the task was dispatched. */
  runId?: string;
  accepted: boolean;
  resultCommit?: string;
  reason?: string;
  /**
   * Durable attempt continuity (design/attempt-continuity-progress-v0.md).
   * Checkpointed after the worktree is created and before the worker starts.
   * A rejected attempt keeps all fields plus `attemptRejectedAt`; acceptance
   * clears them.
   */
  attemptWorktree?: string;
  attemptBranch?: string;
  attemptBaseCommit?: string;
  attemptStartedAt?: string;
  /** Present only while the attempt is rejected and eligible for reuse. */
  attemptRejectedAt?: string;
  /**
   * Durable structured failure for a rejected or policy-blocked task. The
   * RunManifest is the task authority; a dispatched task never duplicates
   * this record into its QueueItem.
   */
  failure?: FailureRecord;
  /**
   * Aggregated cost truth for every worker session this task started,
   * including repairs. Preserved for accepted and rejected tasks, including
   * after the attempt worktree is cleaned up.
   */
  cost?: CostTruth;
  /**
   * Cumulative bounded path evidence for every worker exit observed for this
   * task. Older manifests may omit this field.
   */
  pathAudits?: PathAuditRecord[];
}

/** A rejected attempt whose worktree still validates for reuse. */
export interface ReusableAttempt {
  taskId: string;
  worktree: string;
  branch: string;
  baseCommit: string;
  startedAt: string;
  rejectedAt: string;
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

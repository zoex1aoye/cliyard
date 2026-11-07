/**
 * Background VerificationTask v0 model
 * (design/verification-task-v0.md, continuous-harness-v2).
 *
 * Observational only — status never grants acceptance by itself.
 */
import type { FailureRecord } from "../failures.js";
import type { RuntimeProcessIdentity } from "../runtime/types.js";
import { isProcessIdentity } from "../runtime/process.js";
import { isFailureRecord } from "../failures.js";

export const VERIFICATION_TASK_SPEC_VERSION = 1 as const;

export const VERIFICATION_TASK_STATUSES = [
  "queued",
  "running",
  "stopping",
  "succeeded",
  "failed",
  "canceled",
  "lost",
] as const;

export type VerificationTaskStatus = (typeof VERIFICATION_TASK_STATUSES)[number];

export interface VerificationTaskOutput {
  /** Absolute or repo-relative URI/path of the append-only output log. */
  uri: string;
  /** Byte offset already durable in the output file. */
  offset: number;
}

export interface VerificationTask {
  id: string;
  runId: string;
  taskId: string;
  artifactCommit: string;
  contractsHash: string;
  specVersion: typeof VERIFICATION_TASK_SPEC_VERSION;
  commands: string[];
  runtimeRequirements?: string[];
  status: VerificationTaskStatus;
  ownerIdentity?: RuntimeProcessIdentity;
  output: VerificationTaskOutput;
  deliveredAt?: string;
  startedAt?: string;
  endedAt?: string;
  lastError?: FailureRecord;
  evidenceRefs: string[];
  /** Absolute worktree cwd the runner was bound to (caller-supplied). */
  worktreeCwd: string;
}

export function isVerificationTaskStatus(
  value: unknown,
): value is VerificationTaskStatus {
  return (
    typeof value === "string" &&
    (VERIFICATION_TASK_STATUSES as readonly string[]).includes(value)
  );
}

export function isTerminalVerificationStatus(
  status: VerificationTaskStatus,
): boolean {
  return (
    status === "succeeded" ||
    status === "failed" ||
    status === "canceled" ||
    status === "lost"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function isVerificationTask(value: unknown): value is VerificationTask {
  if (!isRecord(value)) return false;
  if (typeof value.id !== "string" || value.id.trim() === "") return false;
  if (typeof value.runId !== "string" || value.runId.trim() === "") return false;
  if (typeof value.taskId !== "string" || value.taskId.trim() === "") return false;
  if (typeof value.artifactCommit !== "string" || value.artifactCommit.trim() === "") {
    return false;
  }
  if (typeof value.contractsHash !== "string") return false;
  if (value.specVersion !== VERIFICATION_TASK_SPEC_VERSION) return false;
  if (
    !Array.isArray(value.commands) ||
    !value.commands.every((c) => typeof c === "string" && c.trim() !== "")
  ) {
    return false;
  }
  if (!isVerificationTaskStatus(value.status)) return false;
  if (!isRecord(value.output)) return false;
  if (typeof value.output.uri !== "string" || value.output.uri.trim() === "") {
    return false;
  }
  if (
    typeof value.output.offset !== "number" ||
    !Number.isInteger(value.output.offset) ||
    value.output.offset < 0
  ) {
    return false;
  }
  if (!Array.isArray(value.evidenceRefs)) return false;
  if (
    !value.evidenceRefs.every((r) => typeof r === "string")
  ) {
    return false;
  }
  if (typeof value.worktreeCwd !== "string" || value.worktreeCwd.trim() === "") {
    return false;
  }
  if (
    value.ownerIdentity !== undefined &&
    !isProcessIdentity(value.ownerIdentity)
  ) {
    return false;
  }
  if (value.lastError !== undefined && !isFailureRecord(value.lastError)) {
    return false;
  }
  for (const key of ["deliveredAt", "startedAt", "endedAt"] as const) {
    if (value[key] !== undefined && typeof value[key] !== "string") return false;
  }
  if (
    value.runtimeRequirements !== undefined &&
    (!Array.isArray(value.runtimeRequirements) ||
      !value.runtimeRequirements.every((r) => typeof r === "string"))
  ) {
    return false;
  }
  return true;
}

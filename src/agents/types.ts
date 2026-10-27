import type { TaskContract } from "../contracts/schema.js";

export type AgentAdapterId = "mock" | "claude" | "codex" | "codebuddy";

export type WorkerProgressType =
  | "session.start"
  | "assistant"
  | "tool.start"
  | "tool.result"
  | "heartbeat"
  | "result"
  | "retry"
  | "error";

export type WorkerProgressPhase =
  | "starting"
  | "thinking"
  | "tool"
  | "finishing"
  | "waiting"
  | "ending";

/**
 * One bounded, credential-free progress observation from a worker.
 * Versioned so a future reader can refuse an unknown shape instead of
 * guessing at fields. Written findings live under
 * `.cliyard/worker-events/<runId>/<taskId>.jsonl`; they are advisory and never
 * grant acceptance or verdict authority.
 */
export interface WorkerProgressEvent {
  version: 1;
  at: string;
  source: string;
  taskId: string;
  sessionId: string;
  type: WorkerProgressType;
  phase: WorkerProgressPhase;
  message: string;
  detail?: string;
}

const WORKER_PROGRESS_TYPES: ReadonlySet<string> = new Set([
  "session.start",
  "assistant",
  "tool.start",
  "tool.result",
  "heartbeat",
  "result",
  "retry",
  "error",
]);

const WORKER_PROGRESS_PHASES: ReadonlySet<string> = new Set([
  "starting",
  "thinking",
  "tool",
  "finishing",
  "waiting",
  "ending",
]);

export function isWorkerProgressEvent(
  value: unknown,
): value is WorkerProgressEvent {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    record.version === 1 &&
    typeof record.at === "string" &&
    !Number.isNaN(Date.parse(record.at)) &&
    typeof record.source === "string" &&
    typeof record.taskId === "string" &&
    typeof record.sessionId === "string" &&
    typeof record.type === "string" &&
    WORKER_PROGRESS_TYPES.has(record.type) &&
    typeof record.phase === "string" &&
    WORKER_PROGRESS_PHASES.has(record.phase) &&
    typeof record.message === "string" &&
    (record.detail === undefined || typeof record.detail === "string")
  );
}

export interface AgentCapability {
  id: AgentAdapterId;
  ok: boolean;
  version?: string;
  supportsModelFlag?: boolean;
  notes: string[];
}

export interface AgentStartInput {
  contract: TaskContract;
  /** 0-based attempt; repair bumps this */
  attempt: number;
  briefing?: string;
  /** Independent verifier output from the immediately preceding attempt. */
  priorFailure?: {
    attempt: number;
    verifyLog: string;
  };
  /**
   * Advisory live progress sink. Implementations must treat a throwing sink as
   * a no-op: progress can never block or fail a worker attempt.
   */
  onProgress?: (event: WorkerProgressEvent) => void;
}

export interface AgentResult {
  sessionId: string;
  exitCode: number;
  /** Mock / real: paths touched under writePaths */
  touchedPaths: string[];
  logTail: string;
  /**
   * Complete final provider result text, when the adapter captures one.
   * Unlike logTail it is not truncated, so callers can parse a full Plan.
   */
  finalText?: string;
  /** Hint for mock verifier scenarios */
  mockMeta?: { intendedVerifyFail?: boolean };
}

export interface AgentAdapter {
  id: AgentAdapterId;
  discover(): Promise<AgentCapability>;
  start(input: AgentStartInput): Promise<{ sessionId: string }>;
  collect(sessionId: string): Promise<AgentResult>;
  cancel(sessionId: string): Promise<void>;
}

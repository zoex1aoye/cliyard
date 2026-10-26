import type { TaskContract } from "../contracts/schema.js";

export type AgentAdapterId = "mock" | "claude" | "codex" | "codebuddy";

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
}

export interface AgentResult {
  sessionId: string;
  exitCode: number;
  /** Mock / real: paths touched under writePaths */
  touchedPaths: string[];
  logTail: string;
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

import type {
  AgentAdapter,
  AgentCapability,
  AgentResult,
  AgentStartInput,
} from "./types.js";

export interface MockWorkerOptions {
  /**
   * Fail verify this many times before succeeding (drives repair loop).
   * Default 1 → first implement "fails" verify, then repair succeeds.
   */
  failVerifyTimes?: number;
  /** If true, implement itself exits non-zero (hard reject path). */
  implementCrash?: boolean;
}

interface Session {
  input: AgentStartInput;
  result: AgentResult;
}

/**
 * Darwin-safe worker: no WSL, no real CLI. Simulates implement + artifacts.
 */
export function createMockAdapter(opts: MockWorkerOptions = {}): AgentAdapter {
  const failVerifyTimes = opts.failVerifyTimes ?? 1;
  const sessions = new Map<string, Session>();
  let seq = 0;

  return {
    id: "mock",

    async discover(): Promise<AgentCapability> {
      return {
        id: "mock",
        ok: true,
        version: "0.1.0-mock",
        supportsModelFlag: false,
        notes: ["mock adapter; no WSL/CLI spawn"],
      };
    },

    async start(input: AgentStartInput): Promise<{ sessionId: string }> {
      const sessionId = `mock-${Date.now().toString(36)}-${++seq}`;
      const attempt = input.attempt;
      const shouldFailVerify = attempt < failVerifyTimes;
      const writeHit = input.contract.writePaths[0] ?? "src/";

      if (opts.implementCrash) {
        sessions.set(sessionId, {
          input,
          result: {
            sessionId,
            exitCode: 1,
            touchedPaths: [],
            logTail: `[mock] implement crashed on attempt ${attempt}`,
          },
        });
        return { sessionId };
      }

      sessions.set(sessionId, {
        input,
        result: {
          sessionId,
          exitCode: 0,
          touchedPaths: [`${writeHit.replace(/\/?$/, "/")}${input.contract.taskId}.ts`],
          logTail: [
            `[mock] implement ok attempt=${attempt}`,
            `[mock] goals: ${input.contract.goals.join("; ")}`,
            shouldFailVerify
              ? `[mock] planted verify-fail marker (repairs left)`
              : `[mock] planted verify-pass marker`,
          ].join("\n"),
          mockMeta: { intendedVerifyFail: shouldFailVerify },
        },
      });
      return { sessionId };
    },

    async collect(sessionId: string): Promise<AgentResult> {
      const s = sessions.get(sessionId);
      if (!s) throw new Error(`unknown mock session: ${sessionId}`);
      return s.result;
    },

    async cancel(sessionId: string): Promise<void> {
      sessions.delete(sessionId);
    },
  };
}

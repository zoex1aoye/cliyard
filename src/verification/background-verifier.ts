/**
 * Opt-in Verifier backed by Background VerificationTask
 * (design/verification-batch-wire-v0.md).
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import type { AgentResult } from "../agents/types.js";
import type { TaskContract } from "../contracts/schema.js";
import {
  awaitVerificationTask,
  markVerificationDelivered,
  startVerificationTask,
} from "./task-runner.js";
import type { VerificationTaskStatus } from "./task-types.js";
import type { Verifier, VerifyResult } from "./verifier.js";

export interface VerificationObservation {
  id: string;
  status: VerificationTaskStatus;
  outputOffset: number;
  deliveredAt?: string;
}

export interface BackgroundVerifierOptions {
  /** Control repository for `.cliyard/verification/` durability. */
  repoRoot: string;
  /** Absolute task worktree cwd (must already be at artifact commit). */
  worktree: string;
  /** Run id for durable binding (default `standalone`). */
  runId?: string;
  /** Contracts hash for durable binding (default `unknown`). */
  contractsHash?: string;
  /** Await timeout for the detached worker (default 120_000). */
  timeoutMs?: number;
  /** Resolve artifact commit (default: `git rev-parse HEAD` in worktree). */
  resolveArtifactCommit?: (worktree: string) => string;
}

function pathOvershoot(contract: TaskContract, agent: AgentResult): boolean {
  return agent.touchedPaths.some(
    (p) =>
      !contract.writePaths.some(
        (w) => p === w || p.startsWith(w.replace(/\/?$/, "/")),
      ),
  );
}

function defaultArtifactCommit(worktree: string): string {
  const result = spawnSync("git", ["rev-parse", "HEAD"], {
    cwd: worktree,
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(
      `cannot resolve artifact commit: ${(result.stderr || result.stdout || "").trim()}`,
    );
  }
  const head = (result.stdout || "").trim();
  if (!head) throw new Error("cannot resolve artifact commit: empty HEAD");
  return head;
}

function observationFromTask(task: {
  id: string;
  status: VerificationTaskStatus;
  output: { offset: number };
  deliveredAt?: string;
}): VerificationObservation {
  return {
    id: task.id,
    status: task.status,
    outputOffset: task.output.offset,
    ...(task.deliveredAt !== undefined
      ? { deliveredAt: task.deliveredAt }
      : {}),
  };
}

export function isVerificationObservation(
  value: unknown,
): value is VerificationObservation {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const v = value as Record<string, unknown>;
  if (typeof v.id !== "string" || v.id.trim() === "") return false;
  if (typeof v.status !== "string" || v.status.trim() === "") return false;
  if (
    typeof v.outputOffset !== "number" ||
    !Number.isInteger(v.outputOffset) ||
    v.outputOffset < 0
  ) {
    return false;
  }
  if (v.deliveredAt !== undefined && typeof v.deliveredAt !== "string") {
    return false;
  }
  return true;
}

/**
 * Verifier that starts a detached VerificationTask and waits for terminal
 * status. Opt-in only; contracts with `runtime` are refused (shell path).
 */
export function createBackgroundVerifier(
  opts: BackgroundVerifierOptions,
): Verifier {
  const runId = opts.runId ?? "standalone";
  const contractsHash = opts.contractsHash ?? "unknown";
  const timeoutMs = opts.timeoutMs ?? 120_000;
  const resolveArtifact =
    opts.resolveArtifactCommit ?? defaultArtifactCommit;

  return {
    async run(contract, agent): Promise<VerifyResult> {
      if (agent.exitCode !== 0) {
        return {
          ok: false,
          exitCode: 1,
          commandResults: contract.verifyCommands.map((command) => ({
            command,
            exitCode: 1,
            log: `[background-verify] skipped; implement exitCode=${agent.exitCode}`,
          })),
          logTail: `[background-verify] skipped; implement exitCode=${agent.exitCode}`,
        };
      }
      if (pathOvershoot(contract, agent)) {
        return {
          ok: false,
          exitCode: 2,
          commandResults: [
            {
              command: "(path-audit)",
              exitCode: 2,
              log: `[background-verify] FAIL path overshoot: ${agent.touchedPaths.join(", ")}`,
            },
          ],
          logTail: `[background-verify] FAIL path overshoot: ${agent.touchedPaths.join(", ")}`,
        };
      }
      if (contract.runtime !== undefined) {
        return {
          ok: false,
          exitCode: 1,
          commandResults: contract.verifyCommands.map((command) => ({
            command,
            exitCode: 1,
            log: "[background-verify] refused: contract.runtime requires shell verifier",
          })),
          logTail:
            "[background-verify] refused: contract.runtime requires shell verifier / RuntimeManager",
        };
      }

      let artifactCommit: string;
      try {
        artifactCommit = resolveArtifact(opts.worktree);
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        return {
          ok: false,
          exitCode: 1,
          commandResults: [],
          logTail: `[background-verify] ${detail}`,
        };
      }

      try {
        const { task } = await startVerificationTask({
          repoRoot: opts.repoRoot,
          worktreeCwd: opts.worktree,
          runId,
          taskId: contract.taskId,
          artifactCommit,
          contractsHash,
          commands: [...contract.verifyCommands],
        });
        const terminal = await awaitVerificationTask(opts.repoRoot, task.id, {
          timeoutMs,
        });
        const delivered = markVerificationDelivered(opts.repoRoot, terminal.id);
        const logTail = (() => {
          try {
            return readFileSync(delivered.output.uri, "utf8").slice(-6000);
          } catch {
            return `[background-verify] status=${delivered.status}`;
          }
        })();
        const commandResults = contract.verifyCommands.map((command) => ({
          command,
          exitCode: delivered.status === "succeeded" ? 0 : 1,
          log: `[background-verify] ${delivered.status} id=${delivered.id}`,
        }));
        return {
          ok: delivered.status === "succeeded",
          exitCode: delivered.status === "succeeded" ? 0 : 1,
          commandResults,
          logTail,
          verification: observationFromTask(delivered),
        };
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        return {
          ok: false,
          exitCode: 1,
          commandResults: [],
          logTail: `[background-verify] ${detail}`,
        };
      }
    },
  };
}

export function isBackgroundVerificationEnabled(
  options: { backgroundVerification?: boolean } | undefined,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (options?.backgroundVerification === true) return true;
  if (options?.backgroundVerification === false) return false;
  return (
    env.CLIYARD_BACKGROUND_VERIFY === "1" ||
    env.CLIYARD_BACKGROUND_VERIFY === "true"
  );
}

/**
 * Codex CLI worker (Darwin/Linux). Uses `codex exec -m <model>`.
 * Default model: deepseek-v4-pro (DeepSeek provider via Codex login).
 */
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { collectChangedPaths } from "./git-paths.js";
import {
  attachProcessTreeEvidence,
  firstWorkerCleanupFailure,
  recordWorkerProcessTree,
  WorkerProcessTreeManager,
  type ManagedWorkerProcess,
  type WorkerProcessRecord,
} from "./process-tree.js";
import {
  boundFailureText,
  createFailureRecord,
  unavailableCostTruth,
} from "../failures.js";
import type {
  AgentAdapter,
  AgentCapability,
  AgentResult,
  AgentStartInput,
} from "./types.js";
import type {
  WorkerLeaseAttacher,
  WorkerLeaseHandle,
} from "./worker-lease.js";

interface LeaseInvocation {
  attacher: WorkerLeaseAttacher;
  taskId: string;
  attempt: number;
  invocationId: string;
  workspace: string;
}

export interface CodexWorkerOptions {
  /** Working directory (worktree path). Required for real runs. */
  cwd: string;
  /** Default: `codex`. Overridable for deterministic fixture tests. */
  binary?: string;
  model?: string;
  /** Extra args after `codex exec` (before prompt). */
  extraArgs?: string[];
  /** Timeout ms (default 10 min). */
  timeoutMs?: number;
  /**
   * Dry mode: do not spawn codex; write a marker file under writePaths[0]
   * so shell verify can pass in CI without API.
   */
  dryRun?: boolean;
}

interface Session {
  input: AgentStartInput;
  result?: AgentResult;
  promise: Promise<AgentResult>;
}

function runCodex(
  binary: string,
  cwd: string,
  model: string,
  prompt: string,
  extraArgs: string[],
  timeoutMs: number,
  processTree: WorkerProcessTreeManager,
  onSpawn: (managed: ManagedWorkerProcess) => void,
  lease?: LeaseInvocation,
): Promise<{
  code: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  signal: NodeJS.Signals | null;
  processTree: WorkerProcessRecord;
}> {
  return new Promise((resolvePromise, reject) => {
    const args = ["exec", "-m", model, ...extraArgs, prompt];
    const managed = processTree.spawn(binary, args, {
      cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const child = managed.child;
    onSpawn(managed);
    let leaseHandle: WorkerLeaseHandle | undefined;
    let leaseError: Error | undefined;
    const leaseAttached = (async (): Promise<void> => {
      if (!lease) return;
      try {
        leaseHandle = await lease.attacher({
          taskId: lease.taskId,
          attempt: lease.attempt,
          invocationId: lease.invocationId,
          workspace: lease.workspace,
          managed,
        });
      } catch (error) {
        leaseError = error instanceof Error ? error : new Error(String(error));
        // The attacher stops the worker on persistence failure; repeat the
        // idempotent cleanup so every adapter path is fail-closed.
        const outcome = await managed.cleanup("spawn-error");
        leaseError = attachProcessTreeEvidence(leaseError, outcome);
      }
    })();
    const finishLease = async (
      outcome: Parameters<WorkerLeaseHandle["update"]>[0],
    ): Promise<Error | undefined> => {
      await leaseAttached;
      if (leaseError) return leaseError;
      if (!leaseHandle) return undefined;
      try {
        await leaseHandle.update(outcome);
        return undefined;
      } catch (error) {
        return attachProcessTreeEvidence(error, outcome);
      }
    };
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      // Terminate the dedicated group (POSIX). The close handler awaits the
      // same idempotent cleanup before the result is observable.
      void managed.cleanup("timeout");
    }, timeoutMs);
    child.stdout?.on("data", (d) => {
      stdout += String(d);
    });
    child.stderr?.on("data", (d) => {
      stderr += String(d);
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      void (async () => {
        const outcome = await managed.cleanup("spawn-error");
        const leaseFailure = await finishLease(outcome);
        reject(
          leaseFailure
            ? leaseFailure
            : attachProcessTreeEvidence(err, outcome),
        );
      })();
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      void (async () => {
        const outcome = await managed.cleanup(
          timedOut ? "timeout" : "child-close",
        );
        const leaseFailure = await finishLease(outcome);
        if (leaseFailure) {
          reject(leaseFailure);
          return;
        }
        resolvePromise({
          code: timedOut ? 124 : (code ?? 1),
          stdout,
          stderr,
          timedOut,
          signal,
          processTree: outcome.record,
        });
      })();
    });
  });
}

export function createCodexAdapter(opts: CodexWorkerOptions): AgentAdapter {
  const binary = opts.binary ?? "codex";
  const model = opts.model ?? process.env.CLIYARD_CODEX_MODEL ?? "deepseek-v4-pro";
  const timeoutMs = opts.timeoutMs ?? 10 * 60_000;
  const sessions = new Map<string, Session>();
  const managers = new Map<string, ManagedWorkerProcess>();
  const processTree = new WorkerProcessTreeManager();
  let seq = 0;

  return {
    id: "codex",

    async discover(): Promise<AgentCapability> {
      const notes: string[] = [`model=${model}`, `cwd=${opts.cwd}`];
      if (opts.dryRun) notes.push("dryRun=true");
      let ok = opts.dryRun === true;
      if (!opts.dryRun) {
        try {
          const which = await new Promise<number>((resolve) => {
            const c = spawn(binary, ["--version"], { stdio: "ignore" });
            c.on("close", (code) => resolve(code ?? 1));
            c.on("error", () => resolve(1));
          });
          ok = which === 0;
          if (!ok) notes.push("codex CLI not found or failed --version");
        } catch {
          notes.push("codex discover error");
        }
      }
      return {
        id: "codex",
        ok,
        supportsModelFlag: true,
        notes,
      };
    },

    async start(input: AgentStartInput): Promise<{ sessionId: string }> {
      const sessionId = `codex-${Date.now().toString(36)}-${++seq}`;
      const prompt = [
        input.briefing ?? "",
        `Task: ${input.contract.taskId}`,
        `Goals:\n- ${input.contract.goals.join("\n- ")}`,
        input.contract.nonGoals?.length
          ? `Non-goals:\n- ${input.contract.nonGoals.join("\n- ")}`
          : "",
        `Read first:\n- ${input.contract.readPaths.join("\n- ")}`,
        `Write only under: ${input.contract.writePaths.join(", ")}`,
        `Do not modify paths outside writePaths.`,
        "Do not start a long-running dev server. Run only finite build, typecheck or test commands; the Verifier owns runtime services.",
        input.priorFailure
          ? `Previous verifier failure:\n${input.priorFailure.verifyLog.slice(-4000)}`
          : "",
        input.attempt > 0
          ? `This is repair attempt ${input.attempt}. Fix prior verify failure.`
          : "",
      ]
        .filter(Boolean)
        .join("\n\n");

      const promise = (async (): Promise<AgentResult> => {
        if (opts.dryRun) {
          const { mkdirSync, writeFileSync, appendFileSync, existsSync } =
            await import("node:fs");
          const { join, dirname, extname } = await import("node:path");
          const writeRoot = input.contract.writePaths[0] ?? "src/";
          const target = join(opts.cwd, writeRoot);
          const looksLikeFile = Boolean(extname(writeRoot));
          if (looksLikeFile) {
            mkdirSync(dirname(target), { recursive: true });
            if (existsSync(target)) {
              appendFileSync(target, "\n", "utf8");
            } else {
              writeFileSync(
                target,
                `/* cliyard dry-run: ${input.contract.taskId} */\n`,
                "utf8",
              );
            }
            return {
              sessionId,
              exitCode: 0,
              touchedPaths: [writeRoot],
              logTail: `[codex-dry] touched ${target}`,
            };
          }
          mkdirSync(target, { recursive: true });
          const file = join(target, "README.md");
          writeFileSync(
            file,
            `# ${input.contract.taskId}\n\nDry-run Codex stub.\n`,
            "utf8",
          );
          return {
            sessionId,
            exitCode: 0,
            touchedPaths: [`${writeRoot.replace(/\/?$/, "/")}README.md`],
            logTail: `[codex-dry] wrote ${file}`,
          };
        }

        if (!existsSync(opts.cwd)) {
          return {
            sessionId,
            exitCode: 1,
            touchedPaths: [],
            logTail: `[codex] cwd missing: ${opts.cwd}`,
            failure: createFailureRecord({
              exitCode: 1,
              stage: "preflight",
              code: "cwd_missing",
              text: "worker cwd is missing",
            }),
          };
        }

        const processTrees: WorkerProcessRecord[] = [];
        try {
          const res = await runCodex(
            binary,
            opts.cwd,
            model,
            prompt,
            opts.extraArgs ?? [],
            timeoutMs,
            processTree,
            (managed) => {
              managers.set(sessionId, managed);
            },
            input.onWorkerLease
              ? {
                  attacher: input.onWorkerLease,
                  taskId: input.contract.taskId,
                  attempt: input.attempt,
                  invocationId: randomUUID(),
                  workspace: opts.cwd,
                }
              : undefined,
          );
          recordWorkerProcessTree(processTrees, res.processTree);
          let changed: Awaited<ReturnType<typeof collectChangedPaths>>;
          try {
            changed = await collectChangedPaths(
              opts.cwd,
              input.contract.baseCommit,
            );
          } catch (error) {
            changed = {
              paths: [],
              error: error instanceof Error ? error.message : String(error),
            };
          }
          const changedLog = changed.error
            ? `\n[codex] git diff failed: ${changed.error}`
            : changed.paths.length
              ? `\n[codex] changed: ${changed.paths.join(", ")}`
              : "\n[codex] changed: (none)";
          const workerFailed =
            res.timedOut || res.code !== 0 || Boolean(changed.error);
          // Ambiguous tree cleanup makes an otherwise successful worker fail
          // closed; a worker failure stays the primary failure and cleanup is
          // kept as separate resource evidence.
          const cleanupFailure = firstWorkerCleanupFailure(processTrees);
          const detail = [
            res.stderr.trim(),
            changed.error ? `git diff failed: ${changed.error}` : "",
          ]
            .filter(Boolean)
            .join("; ");
          return {
            sessionId,
            exitCode:
              res.code !== 0
                ? res.code
                : changed.error || cleanupFailure
                  ? 1
                  : 0,
            touchedPaths: changed.paths,
            ...(changed.error
              ? {
                  changedPathsError: boundFailureText(changed.error, 2_000),
                }
              : {}),
            logTail:
              (res.stdout + "\n" + res.stderr).trim().slice(-4000) +
              changedLog,
            ...(workerFailed
              ? {
                  failure: createFailureRecord({
                    timedOut: res.timedOut,
                    exitCode: res.code,
                    signal: res.signal,
                    timeoutMs,
                    stage: "worker",
                    postCheckFailed:
                      Boolean(changed.error) &&
                      !res.timedOut &&
                      res.code === 0,
                    ...(detail ? { messageDetail: detail } : {}),
                  }),
                }
              : cleanupFailure
                ? { failure: cleanupFailure }
                : {}),
            ...(cleanupFailure ? { cleanupFailure } : {}),
            ...(processTrees.length > 0
              ? { processTrees: [...processTrees] }
              : {}),
          };
        } catch (e) {
          const message = e instanceof Error ? e.message : String(e);
          const carrier = e as {
            processTree?: WorkerProcessRecord;
            cleanupFailure?: ReturnType<typeof firstWorkerCleanupFailure>;
          };
          if (carrier.processTree) {
            recordWorkerProcessTree(processTrees, carrier.processTree);
          }
          const cleanupFailure =
            carrier.cleanupFailure ?? firstWorkerCleanupFailure(processTrees);
          return {
            sessionId,
            exitCode: 1,
            touchedPaths: [],
            logTail: `[codex] spawn error: ${message}`,
            failure: createFailureRecord({
              spawnFailed: true,
              stage: "spawn",
              code: "spawn_error",
              messageDetail: `spawn error: ${message}`,
            }),
            ...(cleanupFailure ? { cleanupFailure } : {}),
            ...(processTrees.length > 0
              ? { processTrees: [...processTrees] }
              : {}),
          };
        }
      })();

      sessions.set(sessionId, { input, promise });
      return { sessionId };
    },

    async collect(sessionId: string): Promise<AgentResult> {
      const s = sessions.get(sessionId);
      if (!s) throw new Error(`unknown codex session: ${sessionId}`);
      if (!s.result) {
        const result = await s.promise;
        s.result = result.cost
          ? result
          : {
              ...result,
              cost: unavailableCostTruth({
                sessionId,
                note: "codex CLI exposes no token or cost usage",
              }),
            };
      }
      return s.result;
    },

    async cancel(sessionId: string): Promise<void> {
      const managed = managers.get(sessionId);
      if (managed) {
        // Await the same idempotent cleanup the close/timeout paths use.
        await managed.cleanup("cancel");
        managers.delete(sessionId);
      }
      sessions.delete(sessionId);
    },
  };
}

export { collectChangedPaths } from "./git-paths.js";

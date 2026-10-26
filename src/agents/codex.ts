/**
 * Codex CLI worker (Darwin/Linux). Uses `codex exec -m <model>`.
 * Default model: deepseek-v4-pro (DeepSeek provider via Codex login).
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { collectChangedPaths } from "./git-paths.js";
import type {
  AgentAdapter,
  AgentCapability,
  AgentResult,
  AgentStartInput,
} from "./types.js";

export interface CodexWorkerOptions {
  /** Working directory (worktree path). Required for real runs. */
  cwd: string;
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
  cwd: string,
  model: string,
  prompt: string,
  extraArgs: string[],
  timeoutMs: number,
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolvePromise, reject) => {
    const args = ["exec", "-m", model, ...extraArgs, prompt];
    const child = spawn("codex", args, {
      cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
    }, timeoutMs);
    child.stdout.on("data", (d) => {
      stdout += String(d);
    });
    child.stderr.on("data", (d) => {
      stderr += String(d);
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolvePromise({ code: code ?? 1, stdout, stderr });
    });
  });
}

export function createCodexAdapter(opts: CodexWorkerOptions): AgentAdapter {
  const model = opts.model ?? process.env.CLIYARD_CODEX_MODEL ?? "deepseek-v4-pro";
  const timeoutMs = opts.timeoutMs ?? 10 * 60_000;
  const sessions = new Map<string, Session>();
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
            const c = spawn("codex", ["--version"], { stdio: "ignore" });
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
          };
        }

        try {
          const res = await runCodex(
            opts.cwd,
            model,
            prompt,
            opts.extraArgs ?? [],
            timeoutMs,
          );
          const changed = await collectChangedPaths(
            opts.cwd,
            input.contract.baseCommit,
          );
          const changedLog = changed.error
            ? `\n[codex] git diff failed: ${changed.error}`
            : changed.paths.length
              ? `\n[codex] changed: ${changed.paths.join(", ")}`
              : "\n[codex] changed: (none)";
          return {
            sessionId,
            exitCode: changed.error ? 1 : res.code,
            touchedPaths: changed.paths,
            logTail:
              (res.stdout + "\n" + res.stderr).trim().slice(-4000) +
              changedLog,
          };
        } catch (e) {
          return {
            sessionId,
            exitCode: 1,
            touchedPaths: [],
            logTail: `[codex] spawn error: ${e instanceof Error ? e.message : e}`,
          };
        }
      })();

      sessions.set(sessionId, { input, promise });
      return { sessionId };
    },

    async collect(sessionId: string): Promise<AgentResult> {
      const s = sessions.get(sessionId);
      if (!s) throw new Error(`unknown codex session: ${sessionId}`);
      if (!s.result) s.result = await s.promise;
      return s.result;
    },

    async cancel(sessionId: string): Promise<void> {
      sessions.delete(sessionId);
    },
  };
}

export { collectChangedPaths } from "./git-paths.js";

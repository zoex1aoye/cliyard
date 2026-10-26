/**
 * Claude Code worker using the DeepSeek Anthropic-compatible endpoint.
 *
 * The default binary is `claude-ds`, a user-level launcher that sets the
 * DeepSeek base URL/model variables without overwriting a normal Anthropic
 * `claude` login.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { collectChangedPaths } from "./git-paths.js";
import type {
  AgentAdapter,
  AgentCapability,
  AgentResult,
  AgentStartInput,
} from "./types.js";

export type ClaudePermissionMode =
  | "acceptEdits"
  | "auto"
  | "bypassPermissions"
  | "default"
  | "dontAsk"
  | "plan";

export interface ClaudeWorkerOptions {
  cwd: string;
  /** Default: CLIYARD_CLAUDE_BINARY or `claude-ds`. */
  binary?: string;
  /** Default: CLIYARD_CLAUDE_MODEL or `deepseek-flash[1m]`. */
  model?: string;
  permissionMode?: ClaudePermissionMode;
  allowedTools?: string[];
  extraArgs?: string[];
  timeoutMs?: number;
  maxBudgetUsd?: number;
  maxTransientRetries?: number;
  dryRun?: boolean;
}

interface Session {
  input: AgentStartInput;
  child?: ChildProcess;
  result?: AgentResult;
  promise: Promise<AgentResult>;
}

const DEFAULT_TOOLS = ["Read", "Edit", "Write", "Bash"];
const configuredConcurrency = Number(
  process.env.CLIYARD_CLAUDE_MAX_CONCURRENT,
);
const maxConcurrentRuns =
  Number.isFinite(configuredConcurrency) && configuredConcurrency > 0
    ? Math.floor(configuredConcurrency)
    : 3;
let activeRuns = 0;
const runWaiters: (() => void)[] = [];

export function createClaudeAdapter(opts: ClaudeWorkerOptions): AgentAdapter {
  const binary =
    opts.binary ??
    process.env.CLIYARD_CLAUDE_BINARY ??
    "claude-ds";
  const model =
    opts.model ??
    process.env.CLIYARD_CLAUDE_MODEL ??
    "deepseek-flash[1m]";
  const permissionMode = opts.permissionMode ?? "acceptEdits";
  const allowedTools = opts.allowedTools ?? DEFAULT_TOOLS;
  const timeoutMs = opts.timeoutMs ?? 20 * 60_000;
  const configuredBudget = Number(
    process.env.CLIYARD_CLAUDE_MAX_BUDGET_USD,
  );
  const maxBudgetUsd =
    opts.maxBudgetUsd ??
    (Number.isFinite(configuredBudget) && configuredBudget > 0
      ? configuredBudget
      : 5);
  const maxTransientRetries = opts.maxTransientRetries ?? 2;
  const sessions = new Map<string, Session>();

  return {
    id: "claude",

    async discover(): Promise<AgentCapability> {
      const notes = [
        `binary=${binary}`,
        `provider=deepseek`,
        `model=${model}`,
        `cwd=${opts.cwd}`,
        `permissionMode=${permissionMode}`,
      ];
      if (opts.dryRun) notes.push("dryRun=true");

      const ok = opts.dryRun === true || (await commandWorks(binary));
      if (!ok) {
        notes.push(`${binary} not found or failed --version`);
      }
      return {
        id: "claude",
        ok,
        supportsModelFlag: true,
        notes,
      };
    },

    async start(input: AgentStartInput): Promise<{ sessionId: string }> {
      const sessionId = randomUUID();
      const prompt = buildPrompt(input);

      const promise = (async (): Promise<AgentResult> => {
        if (opts.dryRun) {
          return writeDryRunResult(opts.cwd, input, sessionId);
        }
        if (!existsSync(opts.cwd)) {
          return {
            sessionId,
            exitCode: 1,
            touchedPaths: [],
            logTail: `[claude] cwd missing: ${opts.cwd}`,
          };
        }

        try {
          const retryNotes: string[] = [];
          let res!: { code: number; stdout: string; stderr: string };
          let parsed: ReturnType<typeof parseClaudeJson>;
          for (let retry = 0; ; retry += 1) {
            res = await withClaudeSlot(() =>
              runClaude({
                binary,
                cwd: opts.cwd,
                model,
                permissionMode,
                allowedTools,
                extraArgs: opts.extraArgs ?? [],
                timeoutMs,
                maxBudgetUsd,
                sessionId: randomUUID(),
                prompt,
                onSpawn: (child) => {
                  const session = sessions.get(sessionId);
                  if (session) session.child = child;
                },
              }),
            );
            parsed = parseClaudeJson(res.stdout);
            if (
              !isTransientClaudeFailure(res, parsed) ||
              retry >= maxTransientRetries
            ) {
              break;
            }
            const waitMs = 1000 * 2 ** retry;
            retryNotes.push(
              `[claude] transient failure; retry ${retry + 1}/${maxTransientRetries} in ${waitMs}ms`,
            );
            await delay(waitMs);
          }
          const changed = await collectChangedPaths(
            opts.cwd,
            input.contract.baseCommit,
          );
          const changedLog = changed.error
            ? `\n[claude] git diff failed: ${changed.error}`
            : changed.paths.length
              ? `\n[claude] changed: ${changed.paths.join(", ")}`
              : "\n[claude] changed: (none)";
          const output = [...retryNotes, res.stdout, res.stderr]
            .filter(Boolean)
            .join("\n")
            .trim()
            .slice(-6000);
          return {
            sessionId,
            exitCode:
              changed.error || res.code !== 0 || parsed?.is_error
                ? 1
                : 0,
            touchedPaths: changed.paths,
            logTail: `${output}${changedLog}`,
          };
        } catch (e) {
          return {
            sessionId,
            exitCode: 1,
            touchedPaths: [],
            logTail: `[claude] spawn error: ${
              e instanceof Error ? e.message : e
            }`,
          };
        }
      })();

      sessions.set(sessionId, { input, promise });
      return { sessionId };
    },

    async collect(sessionId: string): Promise<AgentResult> {
      const session = sessions.get(sessionId);
      if (!session) throw new Error(`unknown claude session: ${sessionId}`);
      session.result ??= await session.promise;
      return session.result;
    },

    async cancel(sessionId: string): Promise<void> {
      const session = sessions.get(sessionId);
      if (!session) return;
      session.child?.kill("SIGTERM");
      sessions.delete(sessionId);
    },
  };
}

function withClaudeSlot<T>(fn: () => Promise<T>): Promise<T> {
  return new Promise<T>((resolvePromise, reject) => {
    const run = async () => {
      try {
        resolvePromise(await fn());
      } catch (error) {
        reject(error);
      } finally {
        const next = runWaiters.shift();
        if (next) next();
        else activeRuns -= 1;
      }
    };
    if (activeRuns < maxConcurrentRuns) {
      activeRuns += 1;
      void run();
    } else {
      runWaiters.push(() => {
        void run();
      });
    }
  });
}

function isTransientClaudeFailure(
  result: { code: number; stdout: string; stderr: string },
  parsed: ReturnType<typeof parseClaudeJson>,
): boolean {
  if (!parsed?.is_error && result.code === 0) return false;
  const message = `${parsed?.result ?? ""}\n${result.stderr}\n${result.stdout}`;
  return /ECONNRESET|connection to the API was lost|ETIMEDOUT|timed out|timeout|429|502|503|504|overloaded|rate.?limit/i.test(
    message,
  );
}

function delay(ms: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

function buildPrompt(input: AgentStartInput): string {
  return [
    input.briefing ?? "",
    `Task: ${input.contract.taskId}`,
    `Goals:\n- ${input.contract.goals.join("\n- ")}`,
    input.contract.nonGoals?.length
      ? `Non-goals:\n- ${input.contract.nonGoals.join("\n- ")}`
      : "",
    `Read first:\n- ${input.contract.readPaths.join("\n- ")}`,
    `Write only under:\n- ${input.contract.writePaths.join("\n- ")}`,
    "Do not modify paths outside writePaths.",
    "Do not commit, push, merge, or change the design authority files.",
    "Do not start a long-running dev server. Run only finite build, typecheck or test commands; the Verifier owns runtime services.",
    input.priorFailure
      ? `Previous verifier failure:\n${input.priorFailure.verifyLog.slice(-4000)}`
      : "",
    input.attempt > 0
      ? `This is repair attempt ${input.attempt}. Fix the previous failed acceptance.`
      : "",
  ]
    .filter(Boolean)
    .join("\n\n");
}

function runClaude(opts: {
  binary: string;
  cwd: string;
  model: string;
  permissionMode: ClaudePermissionMode;
  allowedTools: string[];
  extraArgs: string[];
  timeoutMs: number;
  maxBudgetUsd: number;
  sessionId: string;
  prompt: string;
  onSpawn: (child: ChildProcess) => void;
}): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolvePromise, reject) => {
    const args = [
      "-p",
      opts.prompt,
      "--output-format",
      "json",
      "--model",
      opts.model,
      "--permission-mode",
      opts.permissionMode,
      "--allowedTools",
      opts.allowedTools.join(","),
      "--session-id",
      opts.sessionId,
      "--max-budget-usd",
      String(opts.maxBudgetUsd),
      "--no-chrome",
      ...opts.extraArgs,
    ];
    const child = spawn(opts.binary, args, {
      cwd: opts.cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    opts.onSpawn(child);
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, opts.timeoutMs);
    child.stdout.on("data", (data) => {
      stdout += String(data);
    });
    child.stderr.on("data", (data) => {
      stderr += String(data);
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolvePromise({
        code: timedOut ? 124 : (code ?? 1),
        stdout,
        stderr,
      });
    });
  });
}

function parseClaudeJson(
  stdout: string,
): { is_error?: boolean; result?: string } | undefined {
  try {
    const value = JSON.parse(stdout.trim()) as {
      is_error?: boolean;
      result?: string;
    };
    return value;
  } catch {
    return undefined;
  }
}

function commandWorks(binary: string): Promise<boolean> {
  return new Promise((resolvePromise) => {
    const child = spawn(binary, ["--version"], { stdio: "ignore" });
    child.on("error", () => resolvePromise(false));
    child.on("close", (code) => resolvePromise(code === 0));
  });
}

async function writeDryRunResult(
  cwd: string,
  input: AgentStartInput,
  sessionId: string,
): Promise<AgentResult> {
  const { mkdirSync, writeFileSync, appendFileSync } = await import("node:fs");
  const { dirname, extname, join } = await import("node:path");
  const writeRoot = input.contract.writePaths[0] ?? "src/";
  const target = join(cwd, writeRoot);
  if (extname(writeRoot)) {
    mkdirSync(dirname(target), { recursive: true });
    if (existsSync(target)) {
      appendFileSync(target, "\n", "utf8");
    } else {
      writeFileSync(
        target,
        `/* cliyard claude dry-run: ${input.contract.taskId} */\n`,
        "utf8",
      );
    }
    return {
      sessionId,
      exitCode: 0,
      touchedPaths: [writeRoot],
      logTail: `[claude-dry] touched ${target}`,
    };
  }
  mkdirSync(target, { recursive: true });
  const file = join(target, "README.md");
  writeFileSync(file, `# ${input.contract.taskId}\n\nClaude dry-run stub.\n`);
  return {
    sessionId,
    exitCode: 0,
    touchedPaths: [`${writeRoot.replace(/\/?$/, "/")}README.md`],
    logTail: `[claude-dry] wrote ${file}`,
  };
}

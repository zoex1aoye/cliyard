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
  WorkerProgressEvent,
  WorkerProgressPhase,
  WorkerProgressType,
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
  /**
   * Emit a heartbeat after this much provider silence.
   * Default: CLIYARD_CLAUDE_HEARTBEAT_MS or 15000ms.
   */
  heartbeatMs?: number;
  dryRun?: boolean;
}

interface Session {
  input: AgentStartInput;
  child?: ChildProcess;
  result?: AgentResult;
  promise: Promise<AgentResult>;
}

const DEFAULT_TOOLS = ["Read", "Edit", "Write", "Bash"];
const DEFAULT_HEARTBEAT_MS = 15_000;
/** Bounded summaries: progress must stay small and credential-free. */
const MAX_PROGRESS_MESSAGE = 240;
const MAX_PROGRESS_DETAIL = 300;
const MAX_TRACKED_TOOLS = 128;
/** Only the tail is kept for logs/retry heuristics; the result is parsed live. */
const MAX_RAW_STDOUT = 256_000;
const MAX_PENDING_LINE = 1_000_000;
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
  const configuredHeartbeat = Number(
    process.env.CLIYARD_CLAUDE_HEARTBEAT_MS,
  );
  const requestedHeartbeat =
    opts.heartbeatMs ??
    (Number.isFinite(configuredHeartbeat) && configuredHeartbeat > 0
      ? configuredHeartbeat
      : DEFAULT_HEARTBEAT_MS);
  const heartbeatMs =
    Number.isFinite(requestedHeartbeat) && requestedHeartbeat > 0
      ? Math.floor(requestedHeartbeat)
      : DEFAULT_HEARTBEAT_MS;
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
      const emit = createProgressEmitter(
        input.onProgress,
        input.contract.taskId,
        sessionId,
      );

      const promise = (async (): Promise<AgentResult> => {
        if (opts.dryRun) {
          emit({
            type: "session.start",
            phase: "starting",
            message: "worker started (dry-run)",
          });
          const result = await writeDryRunResult(opts.cwd, input, sessionId);
          emit({
            type: "result",
            phase: "ending",
            message: result.exitCode === 0 ? "worker completed" : "worker failed",
          });
          return result;
        }
        if (!existsSync(opts.cwd)) {
          emit({
            type: "error",
            phase: "ending",
            message: "worker cwd is missing",
            detail: opts.cwd,
          });
          return {
            sessionId,
            exitCode: 1,
            touchedPaths: [],
            logTail: `[claude] cwd missing: ${opts.cwd}`,
          };
        }

        try {
          const retryNotes: string[] = [];
          let res!: ClaudeRunResult;
          let parsed: ClaudeResult | undefined;
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
                heartbeatMs,
                sessionId: randomUUID(),
                prompt,
                emit,
                onSpawn: (child) => {
                  const session = sessions.get(sessionId);
                  if (session) session.child = child;
                  emit({
                    type: "session.start",
                    phase: "starting",
                    message: "worker started",
                  });
                },
              }),
            );
            parsed = res.result;
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
            emit({
              type: "retry",
              phase: "waiting",
              message:
                `transient provider failure; retry ` +
                `${retry + 1}/${maxTransientRetries} in ${waitMs}ms`,
            });
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
          const message = e instanceof Error ? e.message : String(e);
          emit({
            type: "error",
            phase: "ending",
            message: "worker failed to start",
            detail: message,
          });
          return {
            sessionId,
            exitCode: 1,
            touchedPaths: [],
            logTail: `[claude] spawn error: ${message}`,
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
  parsed: ClaudeResult | undefined,
): boolean {
  if (!parsed?.is_error && result.code === 0) return false;
  // With a result record, judge only the provider's own error text. Raw
  // stream-json stdout also contains assistant/tool progress, where a word
  // like "timeout" is not a provider failure.
  const message = parsed
    ? `${parsed.result ?? ""}\n${result.stderr}`
    : `${result.stderr}\n${result.stdout}`;
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

/** The fields the acceptance and transient-retry logic needs from a result. */
interface ClaudeResult {
  is_error?: boolean;
  result?: string;
}

interface ClaudeRunResult {
  code: number;
  stdout: string;
  stderr: string;
  /** Final `type: "result"` record, when the provider emitted one. */
  result?: ClaudeResult;
}

type ProgressEmitter = (draft: {
  type: WorkerProgressType;
  phase: WorkerProgressPhase;
  message: string;
  detail?: string;
}) => void;

interface StreamContext {
  emit: ProgressEmitter;
  /** tool_use id → tool name, so tool results carry a readable label. */
  toolNames: Map<string, string>;
  onResult: (record: ClaudeResult) => void;
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
  heartbeatMs: number;
  sessionId: string;
  prompt: string;
  emit: ProgressEmitter;
  onSpawn: (child: ChildProcess) => void;
}): Promise<ClaudeRunResult> {
  return new Promise((resolvePromise, reject) => {
    const args = [
      "-p",
      opts.prompt,
      "--output-format",
      "stream-json",
      "--verbose",
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
    /** Incomplete trailing JSONL line; flushed when the child closes. */
    let pending = "";
    let result: ClaudeResult | undefined;
    let resultEmitted = false;
    let timedOut = false;
    let settled = false;
    let lastProviderEventAt = Date.now();
    const context: StreamContext = {
      emit: opts.emit,
      toolNames: new Map(),
      onResult: (record) => {
        result = record;
        if (resultEmitted) return;
        resultEmitted = true;
        const failed = record.is_error === true;
        const text = typeof record.result === "string" ? record.result : "";
        opts.emit({
          type: "result",
          phase: "ending",
          message: failed ? "worker failed" : "worker completed",
          ...(text ? { detail: text } : {}),
        });
      },
    };

    const handleLine = (line: string): void => {
      const trimmed = line.trim();
      if (!trimmed) return;
      let parsed: unknown;
      try {
        parsed = JSON.parse(trimmed) as unknown;
      } catch {
        // A non-JSON log line is not a provider event; ignore it.
        return;
      }
      if (!isRecord(parsed)) return;
      handleClaudeRecord(parsed, context);
    };

    const heartbeatTimer = setInterval(() => {
      const idleMs = Date.now() - lastProviderEventAt;
      if (idleMs < opts.heartbeatMs) return;
      opts.emit({
        type: "heartbeat",
        phase: "waiting",
        message: "waiting for provider output",
        detail: `idle ${Math.round(idleMs / 1000)}s`,
      });
    }, Math.max(25, Math.floor(opts.heartbeatMs / 2)));
    heartbeatTimer.unref?.();

    const timeoutTimer = setTimeout(() => {
      timedOut = true;
      opts.emit({
        type: "error",
        phase: "ending",
        message: `worker timed out after ${opts.timeoutMs}ms`,
      });
      child.kill("SIGTERM");
    }, opts.timeoutMs);

    const cleanup = (): void => {
      clearInterval(heartbeatTimer);
      clearTimeout(timeoutTimer);
    };

    child.stdout?.on("data", (data) => {
      const text = String(data);
      lastProviderEventAt = Date.now();
      stdout = appendBounded(stdout, text, MAX_RAW_STDOUT);
      pending += text;
      let newline = pending.indexOf("\n");
      while (newline >= 0) {
        const line = pending.slice(0, newline);
        pending = pending.slice(newline + 1);
        handleLine(line);
        newline = pending.indexOf("\n");
      }
      if (pending.length > MAX_PENDING_LINE) {
        // A single unterminated line larger than the hard bound is not a
        // usable JSONL record; drop it rather than buffering without limit.
        pending = "";
      }
    });
    child.stderr?.on("data", (data) => {
      stderr = appendBounded(stderr, String(data), MAX_RAW_STDOUT);
    });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (pending.trim()) handleLine(pending);
      pending = "";
      if (!result) {
        // Plain single-JSON compatibility: one complete result object with no
        // JSONL framing (and possibly no `type`) still counts as the result.
        const fallback = parseClaudeJson(stdout);
        if (fallback) context.onResult(fallback);
      }
      const exitCode = timedOut ? 124 : (code ?? 1);
      if (!result && !timedOut && exitCode !== 0) {
        opts.emit({
          type: "error",
          phase: "ending",
          message: `provider exited with code ${exitCode}`,
        });
      }
      resolvePromise({ code: exitCode, stdout, stderr, result });
    });
  });
}

function handleClaudeRecord(
  record: Record<string, unknown>,
  context: StreamContext,
): void {
  const type = typeof record.type === "string" ? record.type : undefined;

  if (
    type === "result" ||
    (type === undefined &&
      ("is_error" in record || typeof record.result === "string"))
  ) {
    context.onResult({
      ...(typeof record.is_error === "boolean"
        ? { is_error: record.is_error }
        : {}),
      ...(typeof record.result === "string" ? { result: record.result } : {}),
    });
    return;
  }

  if (type === "assistant") {
    const message = record.message;
    if (!isRecord(message) || !Array.isArray(message.content)) return;
    const texts: string[] = [];
    const tools: { name: string; detail?: string }[] = [];
    for (const block of message.content) {
      if (!isRecord(block)) continue;
      if (block.type === "text" && typeof block.text === "string") {
        texts.push(block.text);
        continue;
      }
      if (block.type !== "tool_use" || typeof block.name !== "string") continue;
      const name = block.name.trim() || "tool";
      if (typeof block.id === "string" && block.id) {
        context.toolNames.set(block.id, name);
        if (context.toolNames.size > MAX_TRACKED_TOOLS) {
          const oldest = context.toolNames.keys().next().value;
          if (oldest !== undefined) context.toolNames.delete(oldest);
        }
      }
      const detail = summarizeToolInput(block.input);
      tools.push({ name, ...(detail ? { detail } : {}) });
    }
    const summary = texts.join(" ").trim();
    if (summary) {
      context.emit({
        type: "assistant",
        phase: "thinking",
        message: summary,
      });
    }
    for (const tool of tools) {
      context.emit({
        type: "tool.start",
        phase: "tool",
        message: `tool ${tool.name} started`,
        ...(tool.detail ? { detail: tool.detail } : {}),
      });
    }
    return;
  }

  if (type === "user") {
    // stream-json reports tool results as user-role records.
    const message = record.message;
    if (!isRecord(message) || !Array.isArray(message.content)) return;
    for (const block of message.content) {
      if (!isRecord(block) || block.type !== "tool_result") continue;
      const toolUseId =
        typeof block.tool_use_id === "string" ? block.tool_use_id : undefined;
      const name = (toolUseId && context.toolNames.get(toolUseId)) || "tool";
      const size = toolResultSize(block.content);
      context.emit({
        type: "tool.result",
        phase: "tool",
        message: `${name} finished`,
        detail: `${block.is_error === true ? "error" : "ok"}${
          size > 0 ? ` (${size} chars)` : ""
        }`,
      });
    }
    return;
  }

  if (type === "error") {
    const error = isRecord(record.error) ? record.error : undefined;
    const detail =
      error && typeof error.message === "string"
        ? error.message
        : typeof record.message === "string"
          ? record.message
          : undefined;
    context.emit({
      type: "error",
      phase: "ending",
      message: "provider error",
      ...(detail ? { detail } : {}),
    });
  }
}

/** Only path/program metadata is surfaced; file contents and argv are not. */
function summarizeToolInput(input: unknown): string | undefined {
  if (!isRecord(input)) return undefined;
  for (const key of ["file_path", "path", "notebook_path"]) {
    const value = input[key];
    if (typeof value === "string" && value.trim()) return `path ${value}`;
  }
  if (typeof input.command === "string") {
    const program = input.command.trim().split(/\s+/)[0];
    if (program) return `command ${program}`;
  }
  return undefined;
}

function toolResultSize(content: unknown): number {
  if (typeof content === "string") return content.length;
  if (!Array.isArray(content)) return 0;
  let size = 0;
  for (const block of content) {
    if (!isRecord(block)) continue;
    if (typeof block.text === "string") size += block.text.length;
  }
  return size;
}

function createProgressEmitter(
  onProgress: ((event: WorkerProgressEvent) => void) | undefined,
  taskId: string,
  sessionId: string,
): ProgressEmitter {
  return (draft) => {
    if (!onProgress) return;
    const message = boundProgressText(draft.message, MAX_PROGRESS_MESSAGE);
    if (!message) return;
    const detail =
      draft.detail === undefined
        ? undefined
        : boundProgressText(draft.detail, MAX_PROGRESS_DETAIL);
    const event: WorkerProgressEvent = {
      version: 1,
      at: new Date().toISOString(),
      source: "claude",
      taskId,
      sessionId,
      type: draft.type,
      phase: draft.phase,
      message,
      ...(detail ? { detail } : {}),
    };
    try {
      onProgress(event);
    } catch {
      // Progress is advisory; a broken sink must not fail the worker.
    }
  };
}

/** Collapse, redact and bound text so an event can never carry a secret blob. */
function boundProgressText(text: string, max: number): string {
  const collapsed = redactSecrets(
    text.slice(0, 8_000).replace(/\s+/g, " ").trim(),
  );
  if (collapsed.length <= max) return collapsed;
  return `${collapsed.slice(0, max - 1)}…`;
}

const SECRET_PATTERNS: ReadonlyArray<[RegExp, string]> = [
  [/\b(sk-[A-Za-z0-9_-]{8,})\b/g, "[redacted]"],
  [/\b(gh[pousr]_[A-Za-z0-9]{20,})\b/g, "[redacted]"],
  [/\b(xox[baprs]-[A-Za-z0-9-]{10,})\b/g, "[redacted]"],
  [/\b(AKIA[0-9A-Z]{16})\b/g, "[redacted]"],
  [/\bBearer\s+[A-Za-z0-9._~+/-]{16,}=*/gi, "Bearer [redacted]"],
  [
    /\b(api[_-]?key|access[_-]?token|client[_-]?secret|password)\b\s*[:=]\s*\S+/gi,
    "$1=[redacted]",
  ],
];

function redactSecrets(text: string): string {
  let redacted = text;
  for (const [pattern, replacement] of SECRET_PATTERNS) {
    redacted = redacted.replace(pattern, replacement);
  }
  return redacted;
}

function appendBounded(
  current: string,
  addition: string,
  max: number,
): string {
  const next = current + addition;
  return next.length > max ? next.slice(-max) : next;
}

function parseClaudeJson(stdout: string): ClaudeResult | undefined {
  try {
    const value = JSON.parse(stdout.trim()) as unknown;
    if (!isRecord(value)) return undefined;
    // Only a result-shaped object counts; an unrelated single JSON record
    // must not be mistaken for successful completion.
    if (
      value.type !== "result" &&
      typeof value.result !== "string" &&
      typeof value.is_error !== "boolean"
    ) {
      return undefined;
    }
    return {
      ...(typeof value.is_error === "boolean"
        ? { is_error: value.is_error }
        : {}),
      ...(typeof value.result === "string" ? { result: value.result } : {}),
    };
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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

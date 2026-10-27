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
import { auditPathScope } from "./path-scope.js";
import {
  boundFailureText,
  classifyFailure,
  createCostObservation,
  createCostTruth,
  createFailureRecord,
  normalizeFailureCode,
  parseCostAmount,
  parseTokenUsage,
  sumTokenUsage,
  unavailableCostTruth,
  type CostObservation,
  type FailureRecord,
  type TokenUsage,
} from "../failures.js";
import {
  parseBudgetContinuationPolicy,
  parseBudgetGuardUsd,
  parseDeadlineExtensionPolicy,
  TASK_EXTENSION_RECORD_VERSION,
  type BudgetContinuationPolicy,
  type DeadlineExtensionPolicy,
  type TaskExtensionRecord,
} from "./continuation.js";
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
  /** Default: CLIYARD_CLAUDE_MODEL or `deepseek-flash`. */
  model?: string;
  permissionMode?: ClaudePermissionMode;
  allowedTools?: string[];
  extraArgs?: string[];
  timeoutMs?: number;
  maxBudgetUsd?: number;
  maxTransientRetries?: number;
  /**
   * Opt-in budget continuation policy. A grant starts a new CLI invocation
   * against the same worktree and, when eligible, the same provider session.
   */
  budgetPolicy?: BudgetContinuationPolicy;
  /**
   * Opt-in deadline extension policy. When omitted, the existing fixed timeout
   * remains in force and automatic extension stays disabled.
   */
  deadlinePolicy?: DeadlineExtensionPolicy;
  /**
   * Emit one heartbeat per this interval while the child is alive.
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
    "deepseek-flash";
  const permissionMode = opts.permissionMode ?? "acceptEdits";
  const allowedTools = opts.allowedTools ?? DEFAULT_TOOLS;
  const deadlinePolicy =
    opts.deadlinePolicy === undefined
      ? undefined
      : parseDeadlineExtensionPolicy(opts.deadlinePolicy);
  if (opts.deadlinePolicy !== undefined && !deadlinePolicy) {
    throw new Error("invalid Claude deadline extension policy");
  }
  const budgetPolicy =
    opts.budgetPolicy === undefined
      ? undefined
      : parseBudgetContinuationPolicy(opts.budgetPolicy);
  if (opts.budgetPolicy !== undefined && !budgetPolicy) {
    throw new Error("invalid Claude budget continuation policy");
  }
  if (
    deadlinePolicy &&
    opts.timeoutMs !== undefined &&
    opts.timeoutMs !== deadlinePolicy.baseTimeoutMs
  ) {
    throw new Error(
      "Claude timeoutMs contradicts deadlinePolicy.baseTimeoutMs",
    );
  }
  const timeoutMs =
    deadlinePolicy?.baseTimeoutMs ?? opts.timeoutMs ?? 20 * 60_000;
  const configuredBudget = Number(
    process.env.CLIYARD_CLAUDE_MAX_BUDGET_USD,
  );
  const requestedBudget =
    opts.maxBudgetUsd ??
    budgetPolicy?.baseGuardUsd ??
    (Number.isFinite(configuredBudget) && configuredBudget > 0
      ? configuredBudget
      : 5);
  const maxBudgetUsd = parseBudgetGuardUsd(requestedBudget);
  if (maxBudgetUsd === undefined) {
    throw new Error(
      "Claude maxBudgetUsd must be a positive, bounded USD amount",
    );
  }
  if (
    budgetPolicy &&
    opts.maxBudgetUsd !== undefined &&
    maxBudgetUsd !== budgetPolicy.baseGuardUsd
  ) {
    throw new Error(
      "Claude maxBudgetUsd contradicts budgetPolicy.baseGuardUsd",
    );
  }
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
        supportsProviderSessionResume: true,
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
            failure: createFailureRecord({
              exitCode: 1,
              stage: "preflight",
              code: "cwd_missing",
              text: "worker cwd is missing",
            }),
            cost: unavailableCostTruth({
              sessionId,
              guardBudgetUsd: maxBudgetUsd,
              note: "worker cwd is missing",
            }),
          };
        }

        const retryNotes: string[] = [];
        /** Every provider invocation started by this attempt, including retries. */
        const observations: CostObservation[] = [];
        const extensionState: DeadlineGrantState = {
          extensionCount: 0,
          cumulativeTimeoutMs: timeoutMs,
          records: [],
        };
        let cumulativeGuardUsd = maxBudgetUsd;
        try {
          let res!: ClaudeRunResult;
          let parsed: ClaudeResult | undefined;
          let continuationCount = 0;
          let launch: ClaudeSessionLaunch = {
            kind: "fresh",
            sessionId: randomUUID(),
          };

          for (;;) {
            /**
             * Existing transient retries remain fresh sessions. Budget
             * continuation is a separate outer loop and never masquerades as
             * a transient retry.
             */
            for (let retry = 0; ; retry += 1) {
              const invocationLaunch =
                retry === 0
                  ? launch
                  : ({ kind: "fresh", sessionId: randomUUID() } as const);
              res = await withClaudeSlot(() =>
                runClaude({
                  binary,
                  cwd: opts.cwd,
                  model,
                  permissionMode,
                  allowedTools,
                  extraArgs: opts.extraArgs ?? [],
                  timeoutMs,
                  attempt: input.attempt,
                  ...(deadlinePolicy ? { deadlinePolicy } : {}),
                  ...(input.onExtension
                    ? { onExtension: input.onExtension }
                    : {}),
                  extensionState,
                  maxBudgetUsd: cumulativeGuardUsd,
                  heartbeatMs,
                  launch: invocationLaunch,
                  prompt,
                  emit,
                  onSpawn: (child) => {
                    const session = sessions.get(sessionId);
                    if (session) session.child = child;
                    emit({
                      type: "session.start",
                      phase: "starting",
                      message:
                        invocationLaunch.kind === "resume"
                          ? "worker resumed provider session"
                          : "worker started",
                    });
                  },
                }),
              );
              parsed = res.result;
              observations.push(
                recordAttemptCost(invocationLaunch.sessionId, res),
              );
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

            const nextCumulativeGuardUsd =
              budgetPolicy === undefined
                ? cumulativeGuardUsd
                : roundBudgetGuard(
                    cumulativeGuardUsd + budgetPolicy.continuationGuardUsd,
                  );
            if (
              !canConsiderBudgetContinuation({
                result: res,
                policy: budgetPolicy,
                onExtension: input.onExtension,
                continuationCount,
                nextCumulativeGuardUsd,
              })
            ) {
              break;
            }

            /**
             * A changed-path collection failure or out-of-contract change
             * before the grant denies the grant. The final collection below
             * remains the normal exit audit.
             */
            let boundaryChanged: Awaited<
              ReturnType<typeof collectChangedPaths>
            >;
            try {
              boundaryChanged = await collectChangedPaths(
                opts.cwd,
                input.contract.baseCommit,
              );
            } catch (error) {
              boundaryChanged = {
                paths: [],
                error: error instanceof Error ? error.message : String(error),
              };
            }
            const boundaryAudit = boundaryChanged.error
              ? undefined
              : auditPathScope(
                  input.contract.writePaths,
                  boundaryChanged.paths,
                );
            if (
              boundaryChanged.error ||
              !boundaryAudit ||
              boundaryAudit.outsideWritePaths.length > 0
            ) {
              break;
            }

            const policy = budgetPolicy!;
            const progress = res.meaningfulProgress!;
            const providerSessionId = res.providerSessionId!;
            const requestedAt = new Date().toISOString();
            const continuation: TaskExtensionRecord = {
              version: TASK_EXTENSION_RECORD_VERSION,
              extensionId: randomUUID(),
              attempt: input.attempt,
              kind: "budget-continuation",
              source: "auto",
              requestedAt,
              grantedAt: requestedAt,
              reason:
                `mapped ${progress.type} progress before clean ` +
                "error_max_budget_usd",
              healthyEvidence: [`${progress.type}@${progress.at}`],
              providerSessionId,
              additionalGuardUsd: policy.continuationGuardUsd,
              cumulativeGuardUsd: nextCumulativeGuardUsd,
              continuationIndex: continuationCount + 1,
            };

            try {
              await input.onExtension!(continuation);
            } catch (error) {
              const detail =
                error instanceof Error ? error.message : String(error);
              emit({
                type: "error",
                phase: "ending",
                message: "budget continuation persistence failed",
                detail: boundProgressText(detail, MAX_PROGRESS_DETAIL),
              });
              // The failed callback is not a grant, and no resumed process may
              // start after this point.
              break;
            }

            extensionState.records.push(continuation);
            continuationCount += 1;
            cumulativeGuardUsd = nextCumulativeGuardUsd;
            retryNotes.push(
              `[claude] budget continuation ${continuationCount}/` +
                `${policy.maxContinuations}; provider session resumed`,
            );
            launch = {
              kind: "resume",
              sessionId: providerSessionId,
            };
          }
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
            ? `\n[claude] git diff failed: ${changed.error}`
            : changed.paths.length
              ? `\n[claude] changed: ${changed.paths.join(", ")}`
              : "\n[claude] changed: (none)";
          const output = [...retryNotes, res.stdout, res.stderr]
            .filter(Boolean)
            .join("\n")
            .trim()
            .slice(-6000);
          const failed =
            Boolean(changed.error) ||
            res.code !== 0 ||
            parsed?.is_error === true;
          const failure = failed
            ? buildClaudeFailure({
                res,
                ...(parsed ? { parsed } : {}),
                ...(changed.error ? { changedError: changed.error } : {}),
                timeoutMs: res.deadlineTimeoutMs,
              })
            : undefined;
          return {
            sessionId,
            ...(res.providerSessionId
              ? { providerSessionId: res.providerSessionId }
              : {}),
            exitCode: failed ? 1 : 0,
            touchedPaths: changed.paths,
            ...(changed.error
              ? {
                  changedPathsError: boundFailureText(changed.error, 2_000),
                }
              : {}),
            logTail: `${output}${changedLog}`,
            ...(typeof parsed?.result === "string" && parsed.result
              ? { finalText: parsed.result }
              : {}),
            ...(failure ? { failure } : {}),
            ...(extensionState.records.length > 0
              ? {
                  extensions: extensionState.records.map((record) => ({
                    ...record,
                    healthyEvidence: [...record.healthyEvidence],
                  })),
                }
              : {}),
            cost: createCostTruth({
              observations,
              guardBudgetUsd: cumulativeGuardUsd,
            }),
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
            failure: createFailureRecord({
              spawnFailed: true,
              stage: "spawn",
              code: "spawn_error",
              messageDetail: `spawn error: ${message}`,
            }),
            ...(extensionState.records.length > 0
              ? {
                  extensions: extensionState.records.map((record) => ({
                    ...record,
                    healthyEvidence: [...record.healthyEvidence],
                  })),
                }
              : {}),
            cost:
              observations.length > 0
                ? createCostTruth({
                    observations,
                    guardBudgetUsd: cumulativeGuardUsd,
                  })
                : unavailableCostTruth({
                    sessionId,
                    guardBudgetUsd: cumulativeGuardUsd,
                    note: "worker failed to start",
                  }),
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

function canConsiderBudgetContinuation(input: {
  result: ClaudeRunResult;
  policy: BudgetContinuationPolicy | undefined;
  onExtension: AgentStartInput["onExtension"];
  continuationCount: number;
  nextCumulativeGuardUsd: number;
}): boolean {
  const { result, policy } = input;
  const parsed = result.result;
  if (
    policy?.autoContinue !== true ||
    !input.onExtension ||
    input.continuationCount >= policy.maxContinuations ||
    result.timedOut ||
    result.signal !== null ||
    result.code === 124 ||
    (result.code !== 0 && result.code !== 1) ||
    result.unresolvedProviderError ||
    result.protocolFailure ||
    Boolean(result.errorText) ||
    !parsed ||
    parsed.is_error !== true ||
    parsed.subtype !== "error_max_budget_usd" ||
    !result.providerSessionId ||
    !result.meaningfulProgress ||
    roundBudgetGuard(
      input.nextCumulativeGuardUsd + policy.overshootReserveUsd,
    ) > policy.maxCumulativeGuardUsd
  ) {
    return false;
  }

  // An exact budget subtype is insufficient when the same outcome also
  // carries an auth, protocol, policy, transient, resource or timeout signal.
  const bareClassification = classifyFailure({
    text: [parsed.result ?? "", result.stderr].filter(Boolean).join("\n"),
  });
  if (
    bareClassification.category !== "unknown" &&
    bareClassification.category !== "budget_exhausted"
  ) {
    return false;
  }
  return !hasNonBudgetFailureSignal(
    `${parsed.result ?? ""}\n${result.stderr}`,
  );
}

function hasNonBudgetFailureSignal(text: string): boolean {
  return (
    /\b(?:401|403|429|500|502|503|504|529)\b/i.test(text) ||
    /\b(?:unauthori[sz]ed|unauthenticated|api[ _-]?key|invalid[ _-]?token|permission denied|forbidden|oauth|authentication (?:failed|error|required))\b/i.test(
      text,
    ) ||
    /\b(?:timed?\s*out|timeout|ETIMEDOUT|ECONNRESET|overloaded|rate.?limit|service unavailable|bad gateway)\b/i.test(
      text,
    ) ||
    /\b(?:invalid|malformed|unexpected)[ _](?:json|jsonl|response|record|stream|schema|payload)|protocol[ _](?:error|violation|mismatch)|unsupported[ _](?:record|event)[ _]type\b/i.test(
      text,
    ) ||
    /\b(?:policy[ _-]?(?:blocked|denied|violation)|not[ _-]permitted|out[ _-]of[ _-]scope|changed[ _-]paths?[ _-]failed)\b/i.test(
      text,
    )
  );
}

function roundBudgetGuard(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

/**
 * Preserve one provider session's cost/usage observation. An absent result
 * record yields `unavailable`, never zero.
 */
function recordAttemptCost(
  requestedSessionId: string,
  res: ClaudeRunResult,
): CostObservation {
  const parsed = res.result;
  const reportedSessionId = res.providerSessionId;
  const sessionId =
    reportedSessionId && reportedSessionId.length <= 128
      ? reportedSessionId
      : requestedSessionId;
  if (!parsed) {
    const note = res.timedOut
      ? "worker timed out before a result record"
      : res.code !== 0
        ? `worker exited with code ${res.code} before a result record`
        : "provider emitted no result record";
    return createCostObservation({ sessionId, note });
  }
  return createCostObservation({
    sessionId,
    amount: parsed.totalCostUsd,
    usage: parsed.usage,
    currency: parsed.totalCostUsd !== null ? "USD" : null,
    source: "cli",
    ...(parsed.totalCostUsd === null && parsed.usage === null
      ? { note: "result record had no cost or usage" }
      : {}),
  });
}

/** Build the final structured failure from bounded provider text only. */
function buildClaudeFailure(input: {
  res: ClaudeRunResult;
  parsed?: ClaudeResult;
  changedError?: string;
  timeoutMs: number;
}): FailureRecord {
  const providerErrorTexts =
    input.parsed?.is_error === true
      ? [input.parsed.result, input.res.errorText]
      : [input.res.errorText];
  const text = [...providerErrorTexts, input.res.stderr]
    .filter((part): part is string => Boolean(part && part.trim()))
    .join("\n");
  return createFailureRecord({
    timedOut: input.res.timedOut,
    exitCode: input.res.code,
    signal: input.res.signal,
    timeoutMs: input.timeoutMs,
    text,
    ...(input.parsed?.subtype ? { subtype: input.parsed.subtype } : {}),
    providerError: input.parsed?.is_error === true && input.res.code === 0,
    postCheckFailed:
      Boolean(input.changedError) &&
      input.parsed?.is_error !== true &&
      input.res.code === 0,
    ...(input.changedError
      ? { messageDetail: `git diff failed: ${input.changedError}` }
      : {}),
  });
}

/** Extract only the known result fields; raw provider payloads are dropped. */
function toClaudeResult(record: Record<string, unknown>): ClaudeResult {
  const subtype = normalizeFailureCode(record.subtype);
  const providerSessionId = parseProviderSessionId(record.session_id);
  return {
    ...(typeof record.is_error === "boolean"
      ? { is_error: record.is_error }
      : {}),
    ...(typeof record.result === "string" ? { result: record.result } : {}),
    ...(subtype ? { subtype } : {}),
    ...(providerSessionId ? { providerSessionId } : {}),
    usage: parseClaudeUsage(record),
    totalCostUsd: parseCostAmount(record.total_cost_usd),
  };
}

function parseProviderSessionId(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 256 || trimmed.includes("\0")) {
    return undefined;
  }
  return trimmed;
}

/**
 * Top-level `usage` is preferred. When absent or malformed, aggregate the
 * per-model `modelUsage` records without retaining their raw fields.
 */
function parseClaudeUsage(
  record: Record<string, unknown>,
): TokenUsage | null {
  const direct = parseTokenUsage(record.usage);
  if (direct) return direct;
  if (!isRecord(record.modelUsage)) return null;
  const perModel: TokenUsage[] = [];
  for (const value of Object.values(record.modelUsage)) {
    if (!isRecord(value)) continue;
    const usage = parseTokenUsage(value);
    if (usage) perModel.push(usage);
  }
  return sumTokenUsage(perModel);
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
    input.contract.writePaths.length > 0
      ? `Write only under:\n- ${input.contract.writePaths.join("\n- ")}`
      : "Write only under: nothing — this is a read-only task; do not create or modify files.",
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

/** The fields the acceptance, failure and cost logic needs from a result. */
interface ClaudeResult {
  is_error?: boolean;
  result?: string;
  /**
   * Bounded, credential-free result subtype (for example
   * `error_max_budget_usd`). The raw provider value is never retained.
   */
  subtype?: string;
  /** Provider conversation id, when the CLI reported one. */
  providerSessionId?: string;
  /** Parsed token usage; null when the record carried none. */
  usage: TokenUsage | null;
  /** `total_cost_usd` as emitted by the CLI; null when absent or malformed. */
  totalCostUsd: number | null;
}

interface ClaudeRunResult {
  code: number;
  stdout: string;
  stderr: string;
  /** Final `type: "result"` record, when the provider emitted one. */
  result?: ClaudeResult;
  /** True when the adapter's wall-clock timeout fired. */
  timedOut: boolean;
  /** Terminating signal, when the child was killed. */
  signal: NodeJS.Signals | null;
  /** Bounded text from provider `error` records, when any. */
  errorText?: string;
  /** Last provider conversation id observed in stream-json. */
  providerSessionId?: string;
  /** Newest mapped assistant/tool event before this invocation ended. */
  meaningfulProgress?: {
    type: "assistant" | "tool.start" | "tool.result";
    at: string;
  };
  /** True when an error/retry has not been followed by mapped progress. */
  unresolvedProviderError: boolean;
  /** True when a JSON-shaped provider line could not be parsed. */
  protocolFailure: boolean;
  /** Deadline in force when this invocation stopped. */
  deadlineTimeoutMs: number;
}

type ClaudeSessionLaunch =
  | { kind: "fresh"; sessionId: string }
  | { kind: "resume"; sessionId: string };

interface DeadlineGrantState {
  extensionCount: number;
  cumulativeTimeoutMs: number;
  records: TaskExtensionRecord[];
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
  /** Bounded provider error text; never a raw payload. */
  onProviderError: (text: string) => void;
}

function runClaude(opts: {
  binary: string;
  cwd: string;
  model: string;
  permissionMode: ClaudePermissionMode;
  allowedTools: string[];
  extraArgs: string[];
  timeoutMs: number;
  attempt: number;
  deadlinePolicy?: DeadlineExtensionPolicy;
  onExtension?: (
    extension: TaskExtensionRecord,
  ) => void | Promise<void>;
  extensionState: DeadlineGrantState;
  maxBudgetUsd: number;
  heartbeatMs: number;
  launch: ClaudeSessionLaunch;
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
      ...(opts.launch.kind === "resume"
        ? ["--resume", opts.launch.sessionId]
        : ["--session-id", opts.launch.sessionId]),
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
    let resultEmittedAtMs: number | undefined;
    let timedOut = false;
    let settled = false;
    let childClosed = false;
    /** The invocation may not finish while a grant is being persisted. */
    let deadlineEvaluation: Promise<void> | undefined;
    /**
     * Provider JSON records since the previous heartbeat, including records
     * (`system/thinking_tokens`, etc.) that map to no progress event. A
     * bounded count keeps a chatty provider from producing an event per token.
     */
    let recordsSinceHeartbeat = 0;
    let lastProviderRecordAt = Date.now();
    let lastRecordLabel = "";
    let providerErrorText = "";
    let reportedProviderSessionId: string | undefined;
    let protocolFailure = false;
    let lastMeaningful:
      | {
          type: "assistant" | "tool.start" | "tool.result";
          at: string;
          atMs: number;
        }
      | undefined;
    let meaningfulProgressAtResult:
      | {
          type: "assistant" | "tool.start" | "tool.result";
          at: string;
        }
      | undefined;
    let unresolvedError = false;
    const trackedEmit: ProgressEmitter = (draft) => {
      if (
        draft.type === "assistant" ||
        draft.type === "tool.start" ||
        draft.type === "tool.result"
      ) {
        const atMs = Date.now();
        lastMeaningful = {
          type: draft.type,
          at: new Date(atMs).toISOString(),
          atMs,
        };
        unresolvedError = false;
      } else if (draft.type === "error" || draft.type === "retry") {
        unresolvedError = true;
      }
      opts.emit(draft);
    };
    const context: StreamContext = {
      emit: trackedEmit,
      toolNames: new Map(),
      onResult: (record) => {
        result = record;
        if (resultEmitted) return;
        if (lastMeaningful) {
          meaningfulProgressAtResult = {
            type: lastMeaningful.type,
            at: lastMeaningful.at,
          };
        }
        resultEmitted = true;
        resultEmittedAtMs = Date.now();
        const failed = record.is_error === true;
        const text = typeof record.result === "string" ? record.result : "";
        opts.emit({
          type: "result",
          phase: "ending",
          message: failed ? "worker failed" : "worker completed",
          ...(text ? { detail: text } : {}),
        });
      },
      onProviderError: (text) => {
        providerErrorText = boundFailureText(text, 2_000);
      },
    };

    const handleLine = (line: string): void => {
      const trimmed = line.trim();
      if (!trimmed) return;
      let parsed: unknown;
      try {
        parsed = JSON.parse(trimmed) as unknown;
      } catch {
        // JSON-shaped malformed output is protocol evidence. Plain log lines
        // are not provider events and remain ignorable.
        if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
          protocolFailure = true;
        }
        return;
      }
      if (!isRecord(parsed)) {
        if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
          protocolFailure = true;
        }
        return;
      }
      const parsedSessionId = parseProviderSessionId(parsed.session_id);
      if (parsedSessionId) reportedProviderSessionId = parsedSessionId;
      // Any complete provider record counts as activity, even when it maps to
      // no visible event (notably `system/thinking_tokens`).
      lastProviderRecordAt = Date.now();
      recordsSinceHeartbeat += 1;
      lastRecordLabel = describeProviderRecord(parsed);
      handleClaudeRecord(parsed, context);
    };

    // A provider can stream only unmapped records while the worker is alive.
    // Emit one bounded heartbeat per interval so status never mistakes that
    // traffic for silence; never emit one event per token.
    const heartbeatTimer = setInterval(() => {
      // The result record already ended the observable run; a heartbeat after
      // it would replace progress/ending in status with a weaker observation.
      if (resultEmitted) return;
      if (recordsSinceHeartbeat > 0) {
        const count = recordsSinceHeartbeat;
        recordsSinceHeartbeat = 0;
        opts.emit({
          type: "heartbeat",
          phase: "thinking",
          message: "provider active",
          detail: `${count} record${count === 1 ? "" : "s"} since last heartbeat${
            lastRecordLabel ? `; last ${lastRecordLabel}` : ""
          }`,
        });
        return;
      }
      const idleMs = Date.now() - lastProviderRecordAt;
      opts.emit({
        type: "heartbeat",
        phase: "waiting",
        message: "waiting for provider output",
        detail: `idle ${Math.max(1, Math.ceil(idleMs / 1000))}s`,
      });
    }, Math.max(25, Math.floor(opts.heartbeatMs)));
    heartbeatTimer.unref?.();

    let deadlineTimeoutMs = opts.extensionState.cumulativeTimeoutMs;
    let deadlineAtMs = 0;
    let timeoutTimer: NodeJS.Timeout | undefined;
    const killForTimeout = (): void => {
      if (settled || childClosed) return;
      timedOut = true;
      opts.emit({
        type: "error",
        phase: "ending",
        message: `worker timed out after ${deadlineTimeoutMs}ms`,
      });
      child.kill("SIGTERM");
    };
    const armDeadline = (
      delayMs: number,
      cumulativeMs: number,
      targetAtMs = Date.now() + delayMs,
    ): void => {
      deadlineTimeoutMs = cumulativeMs;
      deadlineAtMs = targetAtMs;
      if (timeoutTimer) clearTimeout(timeoutTimer);
      timeoutTimer = setTimeout(() => {
        deadlineEvaluation = evaluateDeadline();
      }, delayMs);
    };
    const evaluateDeadline = async (): Promise<void> => {
      // A close that beat the deadline callback is terminal. An error result
      // or a result emitted after the deadline still loses to the explicit
      // wall-clock timeout; a successful in-time result may finish closing.
      if (settled || childClosed) return;
      if (resultEmitted) {
        if (
          result?.is_error !== true &&
          resultEmittedAtMs !== undefined &&
          resultEmittedAtMs <= deadlineAtMs
        ) {
          return;
        }
        killForTimeout();
        return;
      }
      const now = Date.now();
      const policy = opts.deadlinePolicy;
      const childAlive =
        child.exitCode === null &&
        child.signalCode === null &&
        child.killed === false;
      const evidenceFresh =
        policy !== undefined &&
        lastMeaningful !== undefined &&
        now >= lastMeaningful.atMs &&
        now - lastMeaningful.atMs <= policy.healthyActivityWindowMs;
      const withinCount =
        policy !== undefined &&
        opts.extensionState.extensionCount < policy.maxExtensions;
      const withinTotal =
        policy !== undefined &&
        opts.extensionState.cumulativeTimeoutMs + policy.extensionStepMs <=
          policy.maxTotalTimeoutMs;
      if (
        policy?.autoExtend !== true ||
        !opts.onExtension ||
        !childAlive ||
        !evidenceFresh ||
        unresolvedError ||
        !withinCount ||
        !withinTotal
      ) {
        killForTimeout();
        return;
      }

      const requestedAt = new Date(now).toISOString();
      const extendedDeadlineAtMs = deadlineAtMs + policy.extensionStepMs;
      const cumulativeTimeoutMs =
        opts.extensionState.cumulativeTimeoutMs + policy.extensionStepMs;
      const extension: TaskExtensionRecord = {
        version: TASK_EXTENSION_RECORD_VERSION,
        extensionId: randomUUID(),
        attempt: opts.attempt,
        kind: "deadline",
        source: "auto",
        requestedAt,
        grantedAt: new Date().toISOString(),
        reason:
          `mapped ${lastMeaningful!.type} activity within ` +
          `${policy.healthyActivityWindowMs}ms at wall-clock deadline`,
        healthyEvidence: [
          `${lastMeaningful!.type}@${lastMeaningful!.at}`,
        ],
        providerSessionId:
          reportedProviderSessionId ?? opts.launch.sessionId,
        extensionMs: policy.extensionStepMs,
        cumulativeTimeoutMs,
      };

      try {
        await opts.onExtension(extension);
      } catch (error) {
        // A completed child does not turn failed persistence into a grant.
        // Keep the invocation fail-closed even if the child exited while the
        // checkpoint was pending.
        timedOut = true;
        if (settled) return;
        const detail = error instanceof Error ? error.message : String(error);
        opts.emit({
          type: "error",
          phase: "ending",
          message: "deadline extension persistence failed",
          detail: boundProgressText(detail, MAX_PROGRESS_DETAIL),
        });
        if (childClosed) return;
        killForTimeout();
        return;
      }

      // Persistence completed before the live child receives a new deadline.
      opts.extensionState.extensionCount += 1;
      opts.extensionState.cumulativeTimeoutMs = cumulativeTimeoutMs;
      opts.extensionState.records.push(extension);
      if (settled || childClosed) return;
      const remainingMs = extendedDeadlineAtMs - Date.now();
      if (remainingMs <= 0) {
        deadlineAtMs = extendedDeadlineAtMs;
        killForTimeout();
        return;
      }
      armDeadline(
        remainingMs,
        cumulativeTimeoutMs,
        extendedDeadlineAtMs,
      );
    };

    const cleanup = (): void => {
      clearInterval(heartbeatTimer);
      if (timeoutTimer) clearTimeout(timeoutTimer);
    };
    armDeadline(opts.timeoutMs, opts.extensionState.cumulativeTimeoutMs);

    child.stdout?.on("data", (data) => {
      const text = String(data);
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
        if (
          pending.trimStart().startsWith("{") ||
          pending.trimStart().startsWith("[")
        ) {
          protocolFailure = true;
        }
        pending = "";
      }
    });
    child.stderr?.on("data", (data) => {
      stderr = appendBounded(stderr, String(data), MAX_RAW_STDOUT);
    });
    child.on("error", (error) => {
      if (settled) return;
      childClosed = true;
      settled = true;
      cleanup();
      reject(error);
    });
    child.on("close", (code, signal) => {
      void (async () => {
        if (settled) return;
        childClosed = true;
        if (pending.trim()) handleLine(pending);
        pending = "";
        if (!result) {
          // Plain single-JSON compatibility: one complete result object with
          // no JSONL framing (and possibly no `type`) still counts as result.
          const fallback = parseClaudeJson(stdout);
          if (fallback) context.onResult(fallback);
        }
        // A deadline may have fired just before close. Keep collect() pending
        // until the exact grant is durably checkpointed or denied.
        if (deadlineEvaluation) await deadlineEvaluation;
        if (settled) return;
        settled = true;
        cleanup();
        const exitCode = timedOut ? 124 : (code ?? 1);
        if (!result && !timedOut && exitCode !== 0) {
          opts.emit({
            type: "error",
            phase: "ending",
            message: `provider exited with code ${exitCode}`,
          });
        }
        resolvePromise({
          code: exitCode,
          stdout,
          stderr,
          result,
          timedOut,
          signal,
          deadlineTimeoutMs,
          providerSessionId:
            reportedProviderSessionId ??
            result?.providerSessionId ??
            opts.launch.sessionId,
          ...(meaningfulProgressAtResult
            ? { meaningfulProgress: meaningfulProgressAtResult }
            : {}),
          unresolvedProviderError: unresolvedError,
          protocolFailure,
          ...(providerErrorText ? { errorText: providerErrorText } : {}),
        });
      })();
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
    context.onResult(toClaudeResult(record));
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
    if (detail) context.onProviderError(detail);
    return;
  }

  if (type === "retry") {
    const subtype =
      typeof record.subtype === "string" ? record.subtype.trim() : "";
    context.emit({
      type: "retry",
      phase: "waiting",
      message: "provider requested a retry",
      ...(subtype ? { detail: subtype.slice(0, MAX_PROGRESS_DETAIL) } : {}),
    });
  }
}

/**
 * A heartbeat-detail label for a provider record. Only the record type and
 * subtype are surfaced (bounded below), never its message or token content.
 */
function describeProviderRecord(record: Record<string, unknown>): string {
  const type = typeof record.type === "string" ? record.type.trim() : "";
  const subtype =
    typeof record.subtype === "string" ? record.subtype.trim() : "";
  const label = [type, subtype].filter(Boolean).join("/");
  return label ? label.slice(0, 48) : "record";
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
    return toClaudeResult(value);
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

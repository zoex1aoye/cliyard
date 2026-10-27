/**
 * Task Architect v0: a short-lived, read-only Plan producer.
 *
 * The control plane owns every mutation. The worker only reads the target
 * repository through Read/Grep/Glob and returns one Plan JSON candidate; this
 * module validates that candidate and persists the Plan artifact. It never
 * freezes contracts, creates worktrees, dispatches workers, merges, or pushes.
 */
import { spawn } from "node:child_process";
import {
  closeSync,
  existsSync,
  fstatSync,
  openSync,
  readSync,
  realpathSync,
  statSync,
} from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { createClaudeAdapter } from "../agents/claude.js";
import type {
  AgentAdapter,
  AgentResult,
  AgentStartInput,
} from "../agents/types.js";
import type { TaskContract } from "../contracts/schema.js";
import {
  compilePlan,
  defaultPlanArtifactPath,
  parsePlanJson,
  PlanValidationError,
  writeJsonArtifact,
  type CompiledPlan,
} from "../planner/plan.js";

/** The only tools the architect worker may use. */
export const ARCHITECT_ALLOWED_TOOLS = ["Read", "Grep", "Glob"] as const;
export const ARCHITECT_PERMISSION_MODE = "plan" as const;
/** Design text is capped so a huge document cannot crowd out the worker. */
export const MAX_DESIGN_BYTES = 64 * 1024;

const PLAN_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;
const DESIGN_FENCE_OPEN = "<<<DESIGN";
const DESIGN_FENCE_CLOSE = "DESIGN>>>";

export type ArchitectStage =
  | "preflight"
  | "worker"
  | "validation"
  | "artifact";

export class ArchitectError extends Error {
  readonly stage: ArchitectStage;

  constructor(stage: ArchitectStage, message: string) {
    super(message);
    this.name = "ArchitectError";
    this.stage = stage;
  }
}

export interface ArchitectWorkerConfig {
  cwd: string;
  model?: string;
  permissionMode: typeof ARCHITECT_PERMISSION_MODE;
  allowedTools: readonly string[];
}

export type ArchitectWorkerFactory = (
  config: ArchitectWorkerConfig,
) => AgentAdapter;

export interface ArchitectRunOptions {
  /** Target git repository root, or any path inside it. */
  repoRoot: string;
  /** Committed, repository-relative design document. */
  designPath: string;
  /** Requested Plan id; also the default artifact filename. */
  planId: string;
  model?: string;
  /** Explicit artifact path; defaults under `<target>/.cliyard/plans/`. */
  outPath?: string;
  /** Test seam: substitutes the default Claude adapter. */
  createWorker?: ArchitectWorkerFactory;
}

export interface ArchitectRunResult {
  ok: true;
  planId: string;
  repoRoot: string;
  baseCommit: string;
  designPath: string;
  designBytes: number;
  designTruncated: boolean;
  planPath: string;
  taskIds: string[];
  worker: "claude";
  sessionId: string;
  touchedPaths: string[];
}

interface DesignDocument {
  /** Normalized repository-relative path. */
  path: string;
  realPath: string;
  text: string;
  bytes: number;
  truncated: boolean;
}

/**
 * Produce one validated Plan artifact from a committed design document.
 *
 * Every check runs before the corresponding authority is granted: preflight
 * checks happen before the worker is created, post-run read-only checks happen
 * before the Plan is parsed, and parsing/compilation happens before the
 * artifact is written.
 */
export async function runArchitect(
  opts: ArchitectRunOptions,
): Promise<ArchitectRunResult> {
  const planId = opts.planId?.trim();
  if (!planId || !PLAN_ID_PATTERN.test(planId)) {
    throw new ArchitectError(
      "preflight",
      `invalid --plan-id ${JSON.stringify(opts.planId ?? "")}: must start ` +
        "with a letter or digit and contain only letters, digits, '.', '_' " +
        "or '-' (max 64)",
    );
  }

  const repoRoot = await resolveRepoRoot(opts.repoRoot);
  const baseCommit = await resolveHeadCommit(repoRoot);
  const beforeStatus = await readWorktreeStatus(repoRoot);
  if (beforeStatus !== "") {
    throw new ArchitectError(
      "preflight",
      `target worktree is not clean:\n${bound(beforeStatus.trim(), 800)}`,
    );
  }

  const design = await resolveDesignDocument(repoRoot, opts.designPath);

  const workerConfig: ArchitectWorkerConfig = {
    cwd: repoRoot,
    ...(opts.model ? { model: opts.model } : {}),
    permissionMode: ARCHITECT_PERMISSION_MODE,
    allowedTools: ARCHITECT_ALLOWED_TOOLS,
  };

  let worker: AgentAdapter;
  try {
    worker = (opts.createWorker ?? createDefaultWorker)(workerConfig);
  } catch (error) {
    throw new ArchitectError(
      "worker",
      `could not create the architect worker: ${message(error)}`,
    );
  }

  const input = buildArchitectInput({
    planId,
    repoRoot,
    baseCommit,
    design,
  });

  let sessionId: string | undefined;
  let result: AgentResult;
  try {
    ({ sessionId } = await worker.start(input));
    result = await worker.collect(sessionId);
  } catch (error) {
    if (sessionId) {
      await worker.cancel(sessionId).catch(() => {
        // Cancellation is best effort; the original error is authoritative.
      });
    }
    throw new ArchitectError(
      "worker",
      `architect worker failed: ${message(error)}`,
    );
  }

  if (result.exitCode !== 0) {
    throw new ArchitectError(
      "worker",
      `worker exited with code ${result.exitCode}: ` +
        bound(result.logTail.trim(), 600),
    );
  }
  if (result.touchedPaths.length > 0) {
    throw new ArchitectError(
      "validation",
      "worker touched paths (must be empty): " +
        bound(result.touchedPaths.join(", "), 600),
    );
  }
  const afterStatus = await readWorktreeStatus(repoRoot);
  if (afterStatus !== beforeStatus) {
    throw new ArchitectError(
      "validation",
      "target worktree changed during the architect run:\n" +
        bound(afterStatus.trim() || "(empty status)", 800),
    );
  }
  const afterHead = await resolveHeadCommit(repoRoot);
  if (afterHead !== baseCommit) {
    throw new ArchitectError(
      "validation",
      `HEAD moved during the architect run: ${baseCommit} -> ${afterHead}`,
    );
  }

  const finalText = result.finalText;
  if (!finalText || !finalText.trim()) {
    throw new ArchitectError(
      "validation",
      "worker produced no final text to parse as Plan JSON",
    );
  }
  const rawPlan = extractPlanJson(finalText);

  let compiled: CompiledPlan;
  try {
    compiled = compilePlan(rawPlan, { baseCommit });
  } catch (error) {
    if (error instanceof PlanValidationError) {
      throw new ArchitectError("validation", error.message);
    }
    throw new ArchitectError("validation", message(error));
  }
  if (compiled.planId !== planId) {
    throw new ArchitectError(
      "validation",
      `worker returned planId "${compiled.planId}" but --plan-id is "${planId}"`,
    );
  }

  const requestedOut =
    opts.outPath !== undefined && opts.outPath.trim() !== ""
      ? resolve(opts.outPath)
      : defaultPlanArtifactPath(repoRoot, planId);
  if (samePath(requestedOut, design.realPath)) {
    throw new ArchitectError(
      "artifact",
      `refusing to overwrite the design document: ${design.path}`,
    );
  }

  let planPath: string;
  try {
    planPath = writeJsonArtifact(requestedOut, rawPlan);
  } catch (error) {
    throw new ArchitectError(
      "artifact",
      `failed to write Plan artifact: ${message(error)}`,
    );
  }

  return {
    ok: true,
    planId,
    repoRoot,
    baseCommit,
    designPath: design.path,
    designBytes: design.bytes,
    designTruncated: design.truncated,
    planPath,
    taskIds: compiled.contracts.map((contract) => contract.taskId),
    worker: "claude",
    sessionId: result.sessionId,
    touchedPaths: result.touchedPaths,
  };
}

function createDefaultWorker(config: ArchitectWorkerConfig): AgentAdapter {
  return createClaudeAdapter({
    cwd: config.cwd,
    ...(config.model ? { model: config.model } : {}),
    permissionMode: config.permissionMode,
    allowedTools: [...config.allowedTools],
  });
}

function buildArchitectInput(opts: {
  planId: string;
  repoRoot: string;
  baseCommit: string;
  design: DesignDocument;
}): AgentStartInput {
  const { planId, repoRoot, baseCommit, design } = opts;
  const contract: TaskContract = {
    taskId: planId,
    version: 1,
    frozen: true,
    goals: [
      `Produce one Plan JSON candidate for planId "${planId}" from the ` +
        `committed design document ${design.path}.`,
    ],
    nonGoals: [
      "Do not modify any file.",
      "Do not run commands, commit, push, merge, create worktrees, write contracts, or dispatch.",
    ],
    dependsOn: [],
    readPaths: [design.path],
    writePaths: [],
    sharedResources: [],
    baseCommit,
    verifyCommands: [],
    maxRepairs: 0,
  };

  return {
    contract,
    attempt: 0,
    briefing: buildBriefing({ planId, repoRoot, baseCommit, design }),
  };
}

function buildBriefing(opts: {
  planId: string;
  repoRoot: string;
  baseCommit: string;
  design: DesignDocument;
}): string {
  const { planId, repoRoot, baseCommit, design } = opts;
  const sizeNote = design.truncated
    ? `, truncated to the first ${MAX_DESIGN_BYTES} bytes`
    : "";
  return [
    "You are the cliyard Task Architect v0: a short-lived, read-only Plan producer.",
    "",
    `Target repository: ${repoRoot}`,
    `Base commit: ${baseCommit}`,
    `Plan id: ${planId}`,
    `Design document: ${design.path}`,
    "",
    "Hard rules:",
    "- Inspect the repository only with the Read, Grep and Glob tools.",
    "- Do not create, edit, or delete files. Do not run shell commands.",
    "- Do not commit, push, merge, create worktrees, write contracts, or dispatch.",
    "- Your final message must contain exactly one Plan JSON object and no other content. A single fenced JSON block is acceptable.",
    `- The top-level planId must be "${planId}".`,
    "- Each task needs taskId, goal (or goals), writePaths, and at least one verifyCommand.",
    "- dependsOn must reference taskIds in this Plan and must be acyclic.",
    "- writePaths must be repository-relative and must not overlap between tasks.",
    "- Do not use sharedResources; it is unsupported.",
    "",
    "Plan schema:",
    "{",
    `  "planId": "${planId}",`,
    '  "tasks": [',
    "    {",
    '      "taskId": "safe-task-id",',
    '      "goal": "one concrete deliverable",',
    '      "nonGoals": ["scope boundary"],',
    '      "dependsOn": [],',
    '      "readPaths": ["path/to/context"],',
    '      "writePaths": ["path/to/output"],',
    '      "verifyCommands": ["finite command"],',
    '      "maxRepairs": 1',
    "    }",
    "  ]",
    "}",
    "",
    `Committed design document (${design.bytes} bytes${sizeNote}):`,
    DESIGN_FENCE_OPEN,
    design.text,
    DESIGN_FENCE_CLOSE,
  ].join("\n");
}

async function resolveRepoRoot(input: string): Promise<string> {
  const candidate = resolve(input);
  if (!existsSync(candidate)) {
    throw new ArchitectError(
      "preflight",
      `target repo not found: ${candidate}`,
    );
  }
  const result = await runGit(candidate, [
    "rev-parse",
    "--show-toplevel",
  ]);
  if (result.code !== 0) {
    throw new ArchitectError(
      "preflight",
      `target is not a git repository: ${candidate}` +
        (bound((result.stderr || result.stdout).trim(), 300)
          ? ` (${bound((result.stderr || result.stdout).trim(), 300)})`
          : ""),
    );
  }
  const root = result.stdout.trim();
  if (!root) {
    throw new ArchitectError(
      "preflight",
      `could not resolve the target repository root: ${candidate}`,
    );
  }
  return resolve(root);
}

async function resolveHeadCommit(repoRoot: string): Promise<string> {
  const result = await runGit(repoRoot, ["rev-parse", "HEAD"]);
  if (result.code !== 0) {
    throw new ArchitectError(
      "preflight",
      `could not resolve HEAD in ${repoRoot}: ` +
        bound((result.stderr || result.stdout).trim(), 300),
    );
  }
  const commit = result.stdout.trim();
  if (!/^[0-9a-f]{40,64}$/i.test(commit)) {
    throw new ArchitectError(
      "preflight",
      `git rev-parse HEAD returned an invalid commit: ${commit}`,
    );
  }
  return commit;
}

async function resolveDesignDocument(
  repoRoot: string,
  input: string,
): Promise<DesignDocument> {
  const designPath = normalizeRepoRelativePath(input);
  if (!designPath) {
    throw new ArchitectError(
      "preflight",
      `design path must be repository-relative and stay inside the target ` +
        `repository (received ${JSON.stringify(input)})`,
    );
  }

  const absolutePath = resolve(repoRoot, designPath);
  if (!existsSync(absolutePath) || !statSync(absolutePath).isFile()) {
    throw new ArchitectError(
      "preflight",
      `design document not found: ${designPath}`,
    );
  }

  const tracked = await runGit(repoRoot, [
    "ls-files",
    "--error-unmatch",
    "--",
    designPath,
  ]);
  if (tracked.code !== 0) {
    throw new ArchitectError(
      "preflight",
      `design document is not tracked by git: ${designPath}`,
    );
  }

  let realRoot: string;
  let realPath: string;
  try {
    realRoot = realpathSync(repoRoot);
    realPath = realpathSync(absolutePath);
  } catch (error) {
    throw new ArchitectError(
      "preflight",
      `could not resolve the design document: ${message(error)}`,
    );
  }
  const inside = relative(realRoot, realPath);
  if (
    inside === "" ||
    inside === ".." ||
    inside.startsWith(`..${sep}`) ||
    isAbsolute(inside)
  ) {
    throw new ArchitectError(
      "preflight",
      `design document resolves outside the target repository: ${designPath}`,
    );
  }

  const bounded = readBoundedText(absolutePath, MAX_DESIGN_BYTES);
  if (!bounded.text.trim()) {
    throw new ArchitectError(
      "preflight",
      `design document is empty: ${designPath}`,
    );
  }
  return {
    path: designPath,
    realPath,
    text: bounded.text,
    bytes: bounded.bytes,
    truncated: bounded.truncated,
  };
}

function normalizeRepoRelativePath(value: string): string | undefined {
  if (
    !value.trim() ||
    value.includes("\0") ||
    isAbsolute(value) ||
    /^[a-zA-Z]:[\\/]/.test(value) ||
    value.startsWith("\\\\")
  ) {
    return undefined;
  }
  const segments = value
    .replace(/\\/g, "/")
    .split("/")
    .filter((segment) => segment.length > 0 && segment !== ".");
  if (segments.length === 0 || segments.some((s) => s === "..")) {
    return undefined;
  }
  return segments.join("/");
}

function readBoundedText(
  absolutePath: string,
  maxBytes: number,
): { text: string; bytes: number; truncated: boolean } {
  const fd = openSync(absolutePath, "r");
  try {
    const bytes = fstatSync(fd).size;
    const toRead = Math.min(bytes, maxBytes);
    const buffer = Buffer.alloc(toRead);
    let offset = 0;
    while (offset < toRead) {
      const read = readSync(fd, buffer, offset, toRead - offset, offset);
      if (read <= 0) break;
      offset += read;
    }
    return {
      text: buffer.subarray(0, offset).toString("utf8"),
      bytes,
      truncated: bytes > toRead,
    };
  } finally {
    closeSync(fd);
  }
}

/**
 * Accept a plain Plan JSON document, a fenced JSON block (optionally surrounded
 * by prose), or a single JSON object embedded in prose. The last parseable
 * candidate wins so a worker's final answer is preferred over examples.
 */
function extractPlanJson(text: string): unknown {
  let parseError: string;
  try {
    return parsePlanJson(text);
  } catch (error) {
    parseError = message(error);
  }

  const fences: string[] = [];
  const fencePattern = /```(?:json)?[ \t]*\r?\n([\s\S]*?)```/gi;
  let match: RegExpExecArray | null;
  while ((match = fencePattern.exec(text)) !== null) {
    if (match[1]) fences.push(match[1]);
  }
  for (let i = fences.length - 1; i >= 0; i -= 1) {
    try {
      return parsePlanJson(fences[i]!);
    } catch {
      // Try the next candidate.
    }
  }

  const firstBrace = text.indexOf("{");
  const lastBrace = text.lastIndexOf("}");
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    try {
      return parsePlanJson(text.slice(firstBrace, lastBrace + 1));
    } catch {
      // Fall through to the original parse error for a stable message.
    }
  }

  throw new ArchitectError("validation", parseError);
}

function normalizeRealpath(path: string): string | undefined {
  try {
    return realpathSync(path);
  } catch {
    return undefined;
  }
}

function samePath(left: string, right: string): boolean {
  const leftReal = normalizeRealpath(left);
  const rightReal = normalizeRealpath(right);
  if (leftReal && rightReal) return leftReal === rightReal;
  return resolve(left) === resolve(right);
}

async function readWorktreeStatus(repoRoot: string): Promise<string> {
  const result = await runGit(repoRoot, [
    "status",
    "--porcelain",
    "--untracked-files=normal",
  ]);
  if (result.code !== 0) {
    throw new ArchitectError(
      "preflight",
      `git status failed in ${repoRoot}: ` +
        bound((result.stderr || result.stdout).trim(), 300),
    );
  }
  return result.stdout;
}

function runGit(
  cwd: string,
  args: string[],
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn("git", args, {
      cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (data) => {
      stdout += String(data);
    });
    child.stderr?.on("data", (data) => {
      stderr += String(data);
    });
    child.on("error", reject);
    child.on("close", (code) => {
      resolvePromise({ code: code ?? 1, stdout, stderr });
    });
  });
}

function bound(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1)}…`;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

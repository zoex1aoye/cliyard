/**
 * Context-reload handoff v0.
 *
 * Given only one terminal RunManifest or EvidenceBundle fixture, reconstruct
 * the next legal action without reading repository state, worker events,
 * prompts, transcripts or any ambient context. This simulates a fresh process
 * after context loss; it makes no provider-level compaction claim.
 *
 * The fixture is untrusted input. It is size-bounded, validated field by field
 * and projected into a small deterministic decision. A bundle's persisted
 * `nextAction` is never trusted as authority: the action is recomputed from
 * bounded terminal facts and a disagreement is reported.
 */
import { createHash } from "node:crypto";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildEvidenceBundle,
  EvidenceBundleError,
  EvidenceBundleNotTerminalError,
  type EvidenceBundle,
  type EvidenceNextAction,
  type EvidenceTerminalStatus,
} from "../supervisor/evidence-bundle.js";
import type { RunManifest } from "../supervisor/types.js";

export const HANDOFF_VERSION = 1;
/** Same bound as a finalized EvidenceBundle. */
export const MAX_HANDOFF_FIXTURE_BYTES = 16 * 1024 * 1024;
export const MAX_HANDOFF_TASKS = 256;
export const MAX_HANDOFF_MISSING = 2_048;
export const MAX_HANDOFF_PATH_LENGTH = 4_096;
const MAX_ID_LENGTH = 128;
const MAX_PLAN_ID_LENGTH = 256;
const MAX_TASK_ID_LENGTH = 128;
const MAX_BRANCH_LENGTH = 1_024;
const MAX_MISSING_LENGTH = 300;
const MAX_TIMESTAMP_LENGTH = 64;
const MAX_PROCESS_TREES = 32;

const RUN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const COMMIT_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/i;
const CONTROL_PATTERN = /[\u0000-\u001f\u007f-\u009f]/;

const TERMINAL_STATUSES: readonly EvidenceTerminalStatus[] = [
  "completed",
  "blocked",
  "interrupted",
];
const TASK_STATUSES = new Set([
  "draft",
  "ready",
  "running",
  "verifying",
  "repairing",
  "accepted",
  "blocked",
  "rejected",
  "cancelled",
]);
const NEXT_ACTIONS: readonly EvidenceNextAction[] = [
  "human-review",
  "inspect-failure",
  "resume",
  "needs-human",
];
const BOUNDARY_STATUSES = ["clean", "violation", "inspection_error"] as const;
const CLEANUP_STATES = new Set(["clean", "terminated", "failed", "unsupported"]);

export type HandoffSource = "run-manifest" | "evidence-bundle";

export interface HandoffTaskCommit {
  taskId: string;
  resultCommit: string;
}

export interface HandoffTaskSummary {
  total: number;
  accepted: number;
  rejected: number;
  blocked: number;
  cancelled: number;
  unresolved: number;
}

export interface HandoffDecision {
  version: typeof HANDOFF_VERSION;
  source: HandoffSource;
  /** SHA-256 of the exact fixture bytes that were read. */
  sourceSha256: string;
  runId: string;
  planId: string;
  status: EvidenceTerminalStatus;
  terminal: true;
  humanReviewRequired: true;
  /** Recomputed from terminal facts; never copied from a bundle's nextAction. */
  nextAction: EvidenceNextAction;
  /** False when the fixture persisted a different nextAction. */
  nextActionMatched: boolean;
  reason: string;
  allowedActions: string[];
  repository: {
    baseCommit: string;
    integrationBranch: string;
    integrationHead: string;
    resultCommits: HandoffTaskCommit[];
  };
  taskSummary: HandoffTaskSummary;
  evidence: {
    manifestPath: string;
    manifestHash: string;
  };
  missing: string[];
  contextReload: string;
  generatedAt: string;
}

export class HandoffError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

export class HandoffInputError extends HandoffError {}

/** A running or non-terminal fixture cannot produce a final handoff. */
export class HandoffNotTerminalError extends HandoffInputError {}

export interface HandoffCliOptions {
  log?: (line: string) => void;
  logError?: (line: string) => void;
}

// ---------------------------------------------------------------------------
// Bounded fixture parsing
// ---------------------------------------------------------------------------

interface TaskView {
  taskId: string;
  status: string;
  accepted: boolean;
  resultCommit: string | null;
  hasFailure: boolean;
  failureRetryable: boolean | null;
  hasCleanupFailure: boolean;
  boundaryStatus: (typeof BOUNDARY_STATUSES)[number] | null;
  processCleanupFailed: boolean;
}

interface BundleView {
  generatedAt: string;
  runId: string;
  planId: string;
  status: EvidenceTerminalStatus;
  createdAt: string;
  updatedAt: string;
  manifestPath: string;
  manifestHash: string;
  contractsVerified: boolean | null;
  baseCommit: string;
  integrationBranch: string;
  integrationHead: string;
  integrationHeadVerified: boolean | null;
  tasks: TaskView[];
  missing: string[];
  persistedNextAction: EvidenceNextAction;
}

/** Read, bound and parse one fixture path. Never reads repository state. */
export function readHandoffFixture(
  path: string,
  options: { cwd?: string } = {},
): { value: unknown; sourceSha256: string; resolvedPath: string } {
  if (
    typeof path !== "string" ||
    path.length === 0 ||
    path.length > MAX_HANDOFF_PATH_LENGTH ||
    path.includes(String.fromCharCode(0))
  ) {
    throw new HandoffInputError("fixture path must be a bounded non-empty path");
  }
  const resolved = resolve(options.cwd ?? process.cwd(), path);
  let stats;
  try {
    stats = statSync(resolved);
  } catch {
    throw new HandoffInputError("cannot read the handoff fixture");
  }
  if (!stats.isFile()) {
    throw new HandoffInputError("handoff fixture is not a regular file");
  }
  if (stats.size > MAX_HANDOFF_FIXTURE_BYTES) {
    throw new HandoffInputError(
      `handoff fixture exceeds the ${MAX_HANDOFF_FIXTURE_BYTES}-byte bound`,
    );
  }
  let bytes: Buffer;
  try {
    bytes = readFileSync(resolved);
  } catch {
    throw new HandoffInputError("cannot read the handoff fixture");
  }
  const sourceSha256 = createHash("sha256").update(bytes).digest("hex");
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString("utf8")) as unknown;
  } catch {
    throw new HandoffInputError("handoff fixture is not valid JSON");
  }
  return { value, sourceSha256, resolvedPath: resolved };
}

/**
 * Reconstruct the decision from a parsed fixture. `sourceSha256` binds the
 * exact bytes the caller read.
 */
export function reconstructHandoff(
  value: unknown,
  sourceSha256: string,
): HandoffDecision {
  if (!isRecord(value)) {
    throw new HandoffInputError("handoff fixture must be a JSON object");
  }
  if (typeof sourceSha256 !== "string" || !SHA256_PATTERN.test(sourceSha256)) {
    throw new HandoffInputError("sourceSha256 must be a SHA-256 digest");
  }

  const isBundle = isRecord(value.authority);
  const view = isBundle
    ? parseBundleView(value)
    : viewFromEvidenceBundle(buildBundleFromManifest(value));

  const { nextAction, problem } = decide(view);
  const nextActionMatched = view.persistedNextAction === nextAction;
  const resultCommits = view.tasks
    .filter(
      (task): task is TaskView & { resultCommit: string } =>
        task.resultCommit !== null,
    )
    .map((task) => ({
      taskId: task.taskId,
      resultCommit: task.resultCommit,
    }))
    .sort((left, right) =>
      left.taskId < right.taskId ? -1 : left.taskId > right.taskId ? 1 : 0,
    );

  return {
    version: HANDOFF_VERSION,
    source: isBundle ? "evidence-bundle" : "run-manifest",
    sourceSha256,
    runId: view.runId,
    planId: view.planId,
    status: view.status,
    terminal: true,
    humanReviewRequired: true,
    nextAction,
    nextActionMatched,
    reason: reasonFor(nextAction, problem),
    allowedActions: allowedActions(nextAction),
    repository: {
      baseCommit: view.baseCommit,
      integrationBranch: view.integrationBranch,
      integrationHead: view.integrationHead,
      resultCommits,
    },
    taskSummary: summarizeTasks(view.tasks),
    evidence: {
      manifestPath: view.manifestPath,
      manifestHash: view.manifestHash,
    },
    missing: [...view.missing],
    contextReload:
      "fixture-only reconstruction; provider-level compaction is not claimed",
    generatedAt: view.generatedAt,
  };
}

/** File-level entry point used by the fresh-process handoff test. */
export function reconstructHandoffFile(
  path: string,
  options: { cwd?: string } = {},
): HandoffDecision {
  const fixture = readHandoffFixture(path, options);
  return reconstructHandoff(fixture.value, fixture.sourceSha256);
}

function buildBundleFromManifest(value: Record<string, unknown>): EvidenceBundle {
  try {
    return buildEvidenceBundle(value as unknown as RunManifest);
  } catch (error) {
    if (error instanceof EvidenceBundleNotTerminalError) {
      throw new HandoffNotTerminalError(
        "a running RunManifest cannot produce a handoff decision",
      );
    }
    if (error instanceof EvidenceBundleError) {
      throw new HandoffInputError(boundedMessage(error.message));
    }
    throw error;
  }
}

function viewFromEvidenceBundle(bundle: EvidenceBundle): BundleView {
  return {
    generatedAt: bundle.generatedAt,
    runId: bundle.run.runId,
    planId: bundle.run.planId,
    status: bundle.run.status,
    createdAt: bundle.run.createdAt,
    updatedAt: bundle.run.updatedAt,
    manifestPath: bundle.authority.manifest.path,
    manifestHash: bundle.authority.manifest.hash,
    contractsVerified: bundle.authority.contracts.verified,
    baseCommit: bundle.repository.baseCommit,
    integrationBranch: bundle.repository.integrationBranch,
    integrationHead: bundle.repository.integrationHead,
    integrationHeadVerified: bundle.repository.integrationHeadVerified,
    tasks: bundle.tasks.map((task) => ({
      taskId: task.taskId,
      status: task.status,
      accepted: task.accepted,
      resultCommit: task.resultCommit,
      hasFailure: task.failure !== null,
      failureRetryable: task.failure?.retryableHint ?? null,
      hasCleanupFailure: task.cleanupFailure !== null,
      boundaryStatus: task.workspaceBoundary?.status ?? null,
      processCleanupFailed: task.processTrees.some(
        (record) => record.cleanupState === "failed",
      ),
    })),
    missing: [...bundle.missing],
    persistedNextAction: bundle.nextAction,
  };
}

/**
 * Strict projection of a persisted EvidenceBundle. Only the fields this
 * decision needs are accepted; anything malformed fails closed.
 */
function parseBundleView(value: Record<string, unknown>): BundleView {
  if (value.version !== 1) {
    throw new HandoffInputError("EvidenceBundle version must be 1");
  }
  const run = requireRecord(value.run, "run");
  if (run.terminal !== true) {
    throw new HandoffNotTerminalError(
      "a non-terminal EvidenceBundle cannot produce a handoff decision",
    );
  }
  const status = requireTerminalStatus(run.status);
  const runId = requireRunId(run.runId);
  const planId = requireBoundedText(run.planId, "run.planId", MAX_PLAN_ID_LENGTH);
  const generatedAt = requireTimestamp(value.generatedAt, "generatedAt");
  const createdAt = requireTimestamp(run.createdAt, "run.createdAt");
  const updatedAt = requireTimestamp(run.updatedAt, "run.updatedAt");

  const authority = requireRecord(value.authority, "authority");
  if (authority.taskAuthority !== "run-manifest") {
    throw new HandoffInputError('authority.taskAuthority must be "run-manifest"');
  }
  for (const flag of [
    "grantsAcceptance",
    "authorizesMerge",
    "replacesVerification",
  ] as const) {
    if (authority[flag] !== false) {
      throw new HandoffInputError(`authority.${flag} must be false`);
    }
  }
  const manifest = requireRecord(authority.manifest, "authority.manifest");
  const expectedManifestPath = `.cliyard/runs/${runId}.json`;
  const manifestPath = requireBoundedText(
    manifest.path,
    "authority.manifest.path",
    MAX_HANDOFF_PATH_LENGTH,
  );
  if (manifestPath !== expectedManifestPath) {
    throw new HandoffInputError(
      "authority.manifest.path must identify this run's RunManifest",
    );
  }
  const manifestHash = requireHash(manifest.hash, "authority.manifest.hash");
  const contracts = requireRecord(authority.contracts, "authority.contracts");
  const contractsVerified = requireBooleanOrNull(
    contracts.verified,
    "authority.contracts.verified",
  );

  const repository = requireRecord(value.repository, "repository");
  const baseCommit = requireCommit(repository.baseCommit, "repository.baseCommit");
  const integrationBranch = requireBoundedText(
    repository.integrationBranch,
    "repository.integrationBranch",
    MAX_BRANCH_LENGTH,
  );
  const integrationHead = requireCommit(
    repository.integrationHead,
    "repository.integrationHead",
  );
  const integrationHeadVerified = requireBooleanOrNull(
    repository.integrationHeadVerified,
    "repository.integrationHeadVerified",
  );

  if (value.humanReviewRequired !== true) {
    throw new HandoffInputError("humanReviewRequired must be true");
  }
  const persistedNextAction = requireNextAction(value.nextAction);
  const missing = requireMissing(value.missing);
  const tasks = requireTasks(value.tasks);

  return {
    generatedAt,
    runId,
    planId,
    status,
    createdAt,
    updatedAt,
    manifestPath,
    manifestHash,
    contractsVerified,
    baseCommit,
    integrationBranch,
    integrationHead,
    integrationHeadVerified,
    tasks,
    missing,
    persistedNextAction,
  };
}

function requireTasks(value: unknown): TaskView[] {
  if (!Array.isArray(value) || value.length > MAX_HANDOFF_TASKS) {
    throw new HandoffInputError(
      `tasks must be an array with at most ${MAX_HANDOFF_TASKS} entries`,
    );
  }
  const seen = new Set<string>();
  return value.map((raw, index) => {
    const label = `tasks[${index}]`;
    const task = requireRecord(raw, label);
    const taskId = requireBoundedText(
      task.taskId,
      `${label}.taskId`,
      MAX_TASK_ID_LENGTH,
    );
    if (seen.has(taskId)) {
      throw new HandoffInputError(`duplicate taskId ${JSON.stringify(taskId)}`);
    }
    seen.add(taskId);
    if (typeof task.status !== "string" || !TASK_STATUSES.has(task.status)) {
      throw new HandoffInputError(`${label}.status must be a known task status`);
    }
    if (typeof task.accepted !== "boolean") {
      throw new HandoffInputError(`${label}.accepted must be boolean`);
    }
    if (task.accepted !== (task.status === "accepted")) {
      throw new HandoffInputError(`${label} accepted/status disagree`);
    }
    const resultCommit =
      task.resultCommit === null
        ? null
        : requireCommit(task.resultCommit, `${label}.resultCommit`);

    let failureRetryable: boolean | null = null;
    const hasFailure = task.failure !== null;
    if (hasFailure) {
      const failure = requireRecord(task.failure, `${label}.failure`);
      if (failure.retryableHint !== undefined) {
        if (typeof failure.retryableHint !== "boolean") {
          throw new HandoffInputError(
            `${label}.failure.retryableHint must be boolean`,
          );
        }
        failureRetryable = failure.retryableHint;
      }
    }
    const hasCleanupFailure = task.cleanupFailure !== null;
    if (hasCleanupFailure) {
      requireRecord(task.cleanupFailure, `${label}.cleanupFailure`);
    }

    let boundaryStatus: TaskView["boundaryStatus"] = null;
    if (task.workspaceBoundary !== null) {
      const boundary = requireRecord(
        task.workspaceBoundary,
        `${label}.workspaceBoundary`,
      );
      if (boundary.version !== 1) {
        throw new HandoffInputError(`${label}.workspaceBoundary.version must be 1`);
      }
      if (
        typeof boundary.status !== "string" ||
        !(BOUNDARY_STATUSES as readonly string[]).includes(boundary.status)
      ) {
        throw new HandoffInputError(
          `${label}.workspaceBoundary.status is invalid`,
        );
      }
      if (boundary.enforcement !== "guard-only") {
        throw new HandoffInputError(
          `${label}.workspaceBoundary.enforcement must be "guard-only"`,
        );
      }
      boundaryStatus = boundary.status as TaskView["boundaryStatus"];
    }

    if (
      !Array.isArray(task.processTrees) ||
      task.processTrees.length > MAX_PROCESS_TREES
    ) {
      throw new HandoffInputError(
        `${label}.processTrees must be a bounded array`,
      );
    }
    let processCleanupFailed = false;
    for (const [treeIndex, treeRaw] of task.processTrees.entries()) {
      const tree = requireRecord(
        treeRaw,
        `${label}.processTrees[${treeIndex}]`,
      );
      if (
        typeof tree.cleanupState !== "string" ||
        !CLEANUP_STATES.has(tree.cleanupState)
      ) {
        throw new HandoffInputError(
          `${label}.processTrees[${treeIndex}].cleanupState is invalid`,
        );
      }
      if (tree.cleanupState === "failed") processCleanupFailed = true;
    }

    return {
      taskId,
      status: task.status,
      accepted: task.accepted,
      resultCommit,
      hasFailure,
      failureRetryable,
      hasCleanupFailure,
      boundaryStatus,
      processCleanupFailed,
    };
  });
}

function requireMissing(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > MAX_HANDOFF_MISSING) {
    throw new HandoffInputError(
      `missing must be an array with at most ${MAX_HANDOFF_MISSING} entries`,
    );
  }
  return value.map((entry, index) =>
    requireBoundedText(entry, `missing[${index}]`, MAX_MISSING_LENGTH),
  );
}

// ---------------------------------------------------------------------------
// Decision
// ---------------------------------------------------------------------------

type HandoffProblem = "authority" | "workspace-boundary" | "cleanup" | "task";

function decide(view: BundleView): {
  nextAction: EvidenceNextAction;
  problem: HandoffProblem | null;
} {
  const authorityProblem =
    view.contractsVerified === false || view.integrationHeadVerified === false;
  const boundaryProblem = view.tasks.some(
    (task) => task.boundaryStatus !== null && task.boundaryStatus !== "clean",
  );
  const cleanupProblem = view.tasks.some(
    (task) => task.hasCleanupFailure || task.processCleanupFailed,
  );
  const taskProblem =
    (view.status === "completed" &&
      (view.tasks.length === 0 || view.tasks.some((task) => !task.accepted))) ||
    view.tasks.some((task) => task.accepted && task.resultCommit === null) ||
    view.tasks.some((task) => task.accepted && task.hasFailure) ||
    view.tasks.some(
      (task) =>
        !task.accepted &&
        (task.status === "blocked" || task.status === "rejected") &&
        !task.hasFailure &&
        !task.hasCleanupFailure,
    );

  if (authorityProblem) return { nextAction: "needs-human", problem: "authority" };
  if (boundaryProblem) {
    return { nextAction: "needs-human", problem: "workspace-boundary" };
  }
  if (cleanupProblem) return { nextAction: "needs-human", problem: "cleanup" };
  if (taskProblem) return { nextAction: "needs-human", problem: "task" };
  if (view.status === "completed") {
    return { nextAction: "human-review", problem: null };
  }
  if (view.status === "blocked") {
    const retryable = view.tasks.some(
      (task) => task.failureRetryable === true,
    );
    return retryable
      ? { nextAction: "resume", problem: null }
      : { nextAction: "inspect-failure", problem: null };
  }
  return { nextAction: "resume", problem: null };
}

function reasonFor(
  action: EvidenceNextAction,
  problem: HandoffProblem | null,
): string {
  switch (action) {
    case "human-review":
      return "All tasks are settled with recorded evidence; human review and integration remain a human decision.";
    case "resume":
      return "The terminal run has resumable retryable state; resume from persisted facts.";
    case "inspect-failure":
      return "The blocked run has a non-retryable failure; inspect the recorded failure before acting.";
    case "needs-human":
      switch (problem) {
        case "authority":
          return "Terminal evidence has an unverified contract or integration-head observation.";
        case "workspace-boundary":
          return "Terminal evidence records a workspace-boundary violation or inspection error.";
        case "cleanup":
          return "Terminal evidence records failed process cleanup.";
        default:
          return "Terminal evidence has unresolved task acceptance, result-commit or failure facts.";
      }
  }
}

function allowedActions(action: EvidenceNextAction): string[] {
  switch (action) {
    case "human-review":
      return ["review-diff", "review-evidence", "decide-integration"];
    case "resume":
      return ["inspect-evidence", "resume-run"];
    case "inspect-failure":
      return ["inspect-failure", "review-evidence"];
    case "needs-human":
      return ["human-inspect", "do-not-auto-resume"];
  }
}

function summarizeTasks(tasks: TaskView[]): HandoffTaskSummary {
  const summary: HandoffTaskSummary = {
    total: tasks.length,
    accepted: 0,
    rejected: 0,
    blocked: 0,
    cancelled: 0,
    unresolved: 0,
  };
  for (const task of tasks) {
    switch (task.status) {
      case "accepted":
        summary.accepted += 1;
        break;
      case "rejected":
        summary.rejected += 1;
        break;
      case "blocked":
        summary.blocked += 1;
        break;
      case "cancelled":
        summary.cancelled += 1;
        break;
      default:
        summary.unresolved += 1;
    }
  }
  return summary;
}

// ---------------------------------------------------------------------------
// Small validators
// ---------------------------------------------------------------------------

function requireRecord(
  value: unknown,
  field: string,
): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new HandoffInputError(`${field} must be an object`);
  }
  return value;
}

function requireBoundedText(
  value: unknown,
  field: string,
  max: number,
): string {
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    value.length > max ||
    CONTROL_PATTERN.test(value)
  ) {
    throw new HandoffInputError(`${field} must be a bounded non-empty string`);
  }
  return value;
}

function requireRunId(value: unknown): string {
  if (typeof value !== "string" || !RUN_ID_PATTERN.test(value)) {
    throw new HandoffInputError("run.runId is unsafe");
  }
  return value;
}

function requireCommit(value: unknown, field: string): string {
  if (typeof value !== "string" || !COMMIT_PATTERN.test(value)) {
    throw new HandoffInputError(
      `${field} must be a full lowercase 40- or 64-character commit`,
    );
  }
  return value;
}

function requireHash(value: unknown, field: string): string {
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) {
    throw new HandoffInputError(`${field} must be a SHA-256 hex digest`);
  }
  return value.toLowerCase();
}

function requireTimestamp(value: unknown, field: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAX_TIMESTAMP_LENGTH ||
    Number.isNaN(Date.parse(value))
  ) {
    throw new HandoffInputError(`${field} must be a timestamp`);
  }
  return value;
}

function requireBooleanOrNull(value: unknown, field: string): boolean | null {
  if (value !== null && typeof value !== "boolean") {
    throw new HandoffInputError(`${field} must be boolean or null`);
  }
  return value;
}

function requireTerminalStatus(value: unknown): EvidenceTerminalStatus {
  if (
    typeof value !== "string" ||
    !(TERMINAL_STATUSES as readonly string[]).includes(value)
  ) {
    throw new HandoffInputError(
      "run.status must be completed, blocked or interrupted",
    );
  }
  return value as EvidenceTerminalStatus;
}

function requireNextAction(value: unknown): EvidenceNextAction {
  if (
    typeof value !== "string" ||
    !(NEXT_ACTIONS as readonly string[]).includes(value)
  ) {
    throw new HandoffInputError("nextAction is invalid");
  }
  return value as EvidenceNextAction;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function boundedMessage(message: string): string {
  return message
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
    .slice(0, 400);
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function usage(log: (line: string) => void): void {
  log(`cliyard eval handoff <fixture.json> [--json]

Reads one terminal RunManifest or EvidenceBundle fixture and reconstructs the
next legal action without repository or provider context.`);
}

function isMainModule(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return (
      realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url))
    );
  } catch {
    return false;
  }
}

/**
 * `eval handoff` entry point. Exit 0 when a decision was reconstructed, 2 when
 * the fixture is unsafe, malformed or non-terminal.
 */
export function runHandoffCli(
  argv: string[],
  options: HandoffCliOptions = {},
): number {
  const log = options.log ?? ((line: string) => console.log(line));
  const logError = options.logError ?? ((line: string) => console.error(line));
  if (argv.includes("--help") || argv.includes("-h")) {
    usage(log);
    return 0;
  }
  const json = argv.includes("--json");
  const positional: string[] = [];
  for (const token of argv) {
    if (token === "--json") continue;
    if (token.startsWith("-")) {
      logError(`cliyard eval handoff: unknown flag ${token}`);
      return 2;
    }
    positional.push(token);
  }
  if (positional.length !== 1) {
    logError("cliyard eval handoff: expected exactly one fixture path");
    return 2;
  }
  let decision: HandoffDecision;
  try {
    decision = reconstructHandoffFile(positional[0]!);
  } catch (error) {
    logError(
      `cliyard eval handoff: ${boundedMessage(
        error instanceof Error ? error.message : String(error),
      )}`,
    );
    return 2;
  }
  if (json) {
    log(serializeHandoffDecision(decision).trimEnd());
  } else {
    log(`handoff: run ${decision.runId} (${decision.status}) -> ${decision.nextAction}`);
    log(`reason: ${decision.reason}`);
    log(`allowed actions: ${decision.allowedActions.join(", ")}`);
    if (!decision.nextActionMatched) {
      log("note: persisted nextAction disagreed; the action was recomputed");
    }
    log(`source: ${decision.source} sha256:${decision.sourceSha256}`);
    log(`repository: base ${decision.repository.baseCommit} integration ${decision.repository.integrationHead}`);
    if (decision.missing.length > 0) {
      log(`missing observations: ${decision.missing.join(", ")}`);
    }
    log(decision.contextReload);
  }
  return 0;
}

/** Deterministic, newline-terminated JSON for one handoff decision. */
export function serializeHandoffDecision(decision: HandoffDecision): string {
  return `${JSON.stringify(decision, null, 2)}\n`;
}

if (isMainModule()) {
  process.exitCode = runHandoffCli(process.argv.slice(2));
}

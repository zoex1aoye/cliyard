/**
 * Controller-owned EvidenceBundle v0
 * (design/evidence-and-harness-eval-v0.md).
 *
 * A bundle is a deterministic, bounded, credential-free projection of a
 * terminal RunManifest plus independently validated repository facts. It is
 * written to `<repoRoot>/.cliyard/evidence/<runId>.json` after the Worker,
 * path audit, process cleanup, WorkspaceBoundary comparison and cost
 * checkpoint have settled.
 *
 * Authority rules:
 * - RunManifest remains the only task authority. The bundle copies the
 *   manifest's accepted flags and verdicts; it never grants acceptance,
 *   rewrites a manifest, replaces verification or authorizes merge.
 * - A `running` manifest cannot produce a final bundle. `completed`,
 *   `blocked` and `interrupted` are terminal for evidence purposes.
 * - Unknown task, failure, cost, process-tree or manifest fields are never
 *   copied. Only the bounded fields declared below enter the bundle, so a
 *   prompt, transcript, environment dump, credential or file content cannot
 *   leak through a nested record.
 * - Serialization is deterministic for byte-identical source facts. The
 *   default generation time is the terminal manifest's `updatedAt`, so
 *   rebuilding from the same manifest produces byte-identical output.
 */

import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import type { TaskStatus } from "../core/status.js";
import {
  aggregateCostTruth,
  boundFailureText,
  normalizeFailureCode,
  parseCostTruth,
  parseFailureRecord,
  redactFailureSecrets,
  type CostObservation,
  type CostTruth,
  type FailureRecord,
  MAX_FAILURE_MESSAGE,
} from "../failures.js";
import {
  MAX_PROCESS_TREE_DETAIL,
  parseWorkerProcessRecord,
  type WorkerProcessRecord,
} from "../agents/process-tree.js";
import { normalizeEvidencePath } from "../agents/workspace-boundary.js";
import {
  MAX_PATH_AUDITS,
  MAX_PATH_AUDIT_ERROR_LENGTH,
  MAX_PATH_AUDIT_PATHS,
  MAX_PROCESS_TREES,
  MAX_WORKSPACE_BOUNDARY_CHANGES,
  MAX_WORKSPACE_BOUNDARY_ERROR_LENGTH,
  MAX_WORKSPACE_BOUNDARY_PATH_LENGTH,
  RUN_MANIFEST_VERSION,
  WORKSPACE_BOUNDARY_RECORD_VERSION,
  type PathAuditRecord,
  type RunManifest,
  type WorkspaceBoundaryChangeRecord,
  type WorkspaceBoundaryRecord,
} from "./types.js";
import { RUNS_DIR, SUPERVISOR_DIR } from "./store.js";

export const EVIDENCE_BUNDLE_VERSION = 1 as const;
export const EVIDENCE_DIR = "evidence";

/**
 * Fail-closed projection bounds. The RunManifest schema does not cap the task
 * count and some persisted free-text fields, so the bundle refuses input it
 * cannot project within these bounds instead of silently truncating evidence.
 */
export const MAX_EVIDENCE_TASKS = 256;
export const MAX_EVIDENCE_TASK_ID_LENGTH = 128;
export const MAX_EVIDENCE_PLAN_ID_LENGTH = 256;
export const MAX_EVIDENCE_PATH_LENGTH = 4_096;
export const MAX_EVIDENCE_BRANCH_LENGTH = 1_024;
export const MAX_EVIDENCE_REASON_LENGTH = 2_000;
export const MAX_EVIDENCE_MISSING = 2_048;
export const MAX_EVIDENCE_COST_OBSERVATIONS = 256;
export const MAX_EVIDENCE_BUNDLE_BYTES = 16 * 1024 * 1024;

const RUN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/i;
const COMMIT_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f-\u009f]/;
const CONTROL_CHARACTER_PATTERN_GLOBAL = /[\u0000-\u001f\u007f-\u009f]/g;
const MAX_SESSION_ID_LENGTH = 128;
const MAX_CURRENCY_LENGTH = 24;
const MAX_OBSERVATION_NOTE_LENGTH = 300;
const MAX_MISSING_REASON_LENGTH = 200;

const TASK_STATUSES: ReadonlySet<string> = new Set<TaskStatus>([
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

/** Task states that are settled enough to describe a terminal run. */
const SETTLED_TASK_STATUSES: ReadonlySet<string> = new Set<TaskStatus>([
  "accepted",
  "blocked",
  "rejected",
  "cancelled",
]);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type EvidenceTerminalStatus = "completed" | "blocked" | "interrupted";

export type EvidenceNextAction =
  | "human-review"
  | "inspect-failure"
  | "resume"
  | "needs-human";

export type EvidenceTaskVerdict =
  | "accepted"
  | "rejected"
  | "blocked"
  | "cancelled"
  | "unresolved";

/**
 * Repository facts the caller observed independently of the RunManifest.
 * Both are optional; an absent fact is recorded as `null` rather than guessed.
 */
export interface EvidenceRepositoryFacts {
  /** SHA-256 of the frozen contracts file, when it was freshly checked. */
  contractsHash?: string;
  /** Current HEAD commit of the integration branch, when it was resolved. */
  integrationHead?: string;
}

export interface BuildEvidenceBundleOptions {
  /**
   * Generation timestamp. Defaults to the terminal manifest's `updatedAt` so
   * rebuilds from identical facts stay byte-identical.
   */
  generatedAt?: string;
  /** Independently validated repository facts (never copied raw). */
  facts?: EvidenceRepositoryFacts;
}

export interface EvidenceManifestIdentity {
  /** Repository-relative RunManifest path. */
  path: string;
  /** SHA-256 of the manifest's supervisor-store serialization. */
  hash: string;
  algorithm: "sha256";
}

export interface EvidenceContractsIdentity {
  /** Path recorded by the RunManifest (absolute or repository-relative). */
  path: string;
  /** Hash recorded by the RunManifest, lowercased. */
  hash: string;
  /** Freshly observed hash, when the caller supplied one. */
  observedHash: string | null;
  /** `null` when no fresh hash was observed. */
  verified: boolean | null;
}

export interface EvidenceRepositoryIdentity {
  baseCommit: string;
  integrationBranch: string;
  integrationHead: string;
  /** Freshly observed integration head, when the caller supplied one. */
  observedIntegrationHead: string | null;
  /** `null` when no fresh head was observed. */
  integrationHeadVerified: boolean | null;
}

/**
 * One task verdict. `status` and `accepted` are copied from the RunManifest;
 * `verdict` is the normalized controller reading, never a new acceptance.
 */
export interface EvidenceTask {
  taskId: string;
  status: TaskStatus;
  verdict: EvidenceTaskVerdict;
  accepted: boolean;
  resultCommit: string | null;
  reason: string | null;
  failure: FailureRecord | null;
  cleanupFailure: FailureRecord | null;
  /** Per-task cost truth; `null` means no cost record was persisted. */
  cost: CostTruth | null;
  pathAudits: PathAuditRecord[];
  processTrees: WorkerProcessRecord[];
  workspaceBoundary: WorkspaceBoundaryRecord | null;
}

export interface EvidenceBundle {
  version: typeof EVIDENCE_BUNDLE_VERSION;
  generatedAt: string;
  run: {
    runId: string;
    planId: string;
    status: EvidenceTerminalStatus;
    terminal: true;
    createdAt: string;
    updatedAt: string;
  };
  authority: {
    taskAuthority: "run-manifest";
    grantsAcceptance: false;
    authorizesMerge: false;
    replacesVerification: false;
    manifest: EvidenceManifestIdentity;
    contracts: EvidenceContractsIdentity;
  };
  repository: EvidenceRepositoryIdentity;
  tasks: EvidenceTask[];
  /** Aggregate cost truth; unknown values stay null and appear in `missing`. */
  cost: CostTruth;
  /** Required observations that were unavailable, sorted and deduplicated. */
  missing: string[];
  humanReviewRequired: true;
  nextAction: EvidenceNextAction;
}

export interface EvidenceBundleWriteResult {
  bundle: EvidenceBundle;
  /** Absolute path of the written bundle. */
  path: string;
  /** UTF-8 byte length of the deterministic serialization. */
  byteLength: number;
  /** `false` when an identical bundle already existed and was left untouched. */
  written: boolean;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class EvidenceBundleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/** Malformed options or repository facts. */
export class EvidenceBundleInputError extends EvidenceBundleError {}

/** Malformed or unsupported RunManifest content. */
export class EvidenceBundleManifestError extends EvidenceBundleError {}

/** A running manifest cannot produce a final bundle. */
export class EvidenceBundleNotTerminalError extends EvidenceBundleManifestError {}

export class EvidenceBundleWriteError extends EvidenceBundleError {}

// ---------------------------------------------------------------------------
// Builder
// ---------------------------------------------------------------------------

/**
 * Build a final EvidenceBundle from a terminal RunManifest. Pure: the input
 * manifest and every nested record are only read, never mutated.
 */
export function buildEvidenceBundle(
  manifest: RunManifest,
  options: BuildEvidenceBundleOptions = {},
): EvidenceBundle {
  if (options === null || typeof options !== "object" || Array.isArray(options)) {
    throw new EvidenceBundleInputError("options must be an object");
  }

  const identity = readTerminalManifest(manifest);
  const generatedAt =
    options.generatedAt === undefined
      ? identity.updatedAt
      : requireTimestamp(options.generatedAt, "generatedAt");
  const facts = readRepositoryFacts(options.facts);

  const missing = new Set<string>();
  if (identity.taskEntries.length === 0) missing.add("run.tasks");

  const tasks = identity.taskEntries
    .map((task) => projectTask(task, identity.status, missing))
    .sort((first, second) => compareStrings(first.taskId, second.taskId));

  for (let index = 1; index < tasks.length; index++) {
    if (tasks[index]!.taskId === tasks[index - 1]!.taskId) {
      throw new EvidenceBundleManifestError(
        `duplicate taskId ${JSON.stringify(tasks[index]!.taskId)}`,
      );
    }
  }

  if (tasks.length > MAX_EVIDENCE_TASKS) {
    throw new EvidenceBundleManifestError(
      `tasks must contain at most ${MAX_EVIDENCE_TASKS} records`,
    );
  }

  const contracts = buildContractsIdentity(identity, facts);
  const repository = buildRepositoryIdentity(identity, facts);

  const cost = sanitizeCostTruth(
    aggregateCostTruth(
      tasks
        .map((task) => task.cost)
        .filter((truth): truth is CostTruth => truth !== null),
    ),
  );

  if (missing.size > MAX_EVIDENCE_MISSING) {
    throw new EvidenceBundleError(
      `missing observation list exceeds ${MAX_EVIDENCE_MISSING} entries`,
    );
  }
  const missingList = [...missing].sort(compareStrings);

  const authorityProblem =
    contracts.verified === false ||
    repository.integrationHeadVerified === false;
  const boundaryProblem = tasks.some(
    (task) =>
      task.workspaceBoundary !== null &&
      task.workspaceBoundary.status !== "clean",
  );
  const cleanupProblem = tasks.some(
    (task) =>
      task.cleanupFailure !== null ||
      task.processTrees.some((record) => record.cleanupState === "failed"),
  );
  const taskProblem =
    (identity.status === "completed" &&
      (tasks.length === 0 || tasks.some((task) => !task.accepted))) ||
    tasks.some((task) => task.accepted && task.resultCommit === null) ||
    tasks.some((task) => task.accepted && task.failure !== null) ||
    tasks.some(
      (task) =>
        !task.accepted &&
        (task.verdict === "blocked" || task.verdict === "rejected") &&
        task.failure === null &&
        task.cleanupFailure === null,
    );

  const bundle: EvidenceBundle = {
    version: EVIDENCE_BUNDLE_VERSION,
    generatedAt,
    run: {
      runId: identity.runId,
      planId: identity.planId,
      status: identity.status,
      terminal: true,
      createdAt: identity.createdAt,
      updatedAt: identity.updatedAt,
    },
    authority: {
      taskAuthority: "run-manifest",
      grantsAcceptance: false,
      authorizesMerge: false,
      replacesVerification: false,
      manifest: {
        path: `${SUPERVISOR_DIR}/${RUNS_DIR}/${identity.runId}.json`,
        hash: runManifestHash(manifest),
        algorithm: "sha256",
      },
      contracts,
    },
    repository,
    tasks,
    cost,
    missing: missingList,
    humanReviewRequired: true,
    nextAction: selectNextAction(
      identity.status,
      authorityProblem,
      boundaryProblem,
      cleanupProblem,
      taskProblem,
      tasks,
    ),
  };

  assertBundleSize(bundle);
  return bundle;
}

/**
 * Deterministic supervisor-store serialization used for the manifest hash.
 * The store writes two-space JSON plus a trailing newline.
 */
export function runManifestHash(manifest: RunManifest): string {
  let serialized: string;
  try {
    serialized = `${JSON.stringify(manifest, null, 2)}\n`;
  } catch (error) {
    throw new EvidenceBundleManifestError(
      `cannot serialize RunManifest for hashing: ${errorMessage(error)}`,
    );
  }
  return createHash("sha256").update(serialized, "utf8").digest("hex");
}

/** Deterministic evidence bytes; identical bundles serialize identically. */
export function serializeEvidenceBundle(bundle: EvidenceBundle): string {
  return `${JSON.stringify(bundle, null, 2)}\n`;
}

// ---------------------------------------------------------------------------
// Writer
// ---------------------------------------------------------------------------

/** Absolute bundle path for a safe run id. */
export function evidenceBundlePath(repoRoot: string, runId: string): string {
  const root = requireText(
    repoRoot,
    "repoRoot",
    MAX_EVIDENCE_PATH_LENGTH,
    "repository root",
  );
  assertSafeRunId(runId);
  return join(resolve(root), SUPERVISOR_DIR, EVIDENCE_DIR, `${runId}.json`);
}

/**
 * Write the bundle atomically (same-directory temp file + rename). A
 * byte-identical existing bundle is left untouched, so repeated writes are
 * idempotent. The manifest is only read, never rewritten.
 */
export function writeEvidenceBundle(
  repoRoot: string,
  manifest: RunManifest,
  options: BuildEvidenceBundleOptions = {},
): EvidenceBundleWriteResult {
  const root = resolve(
    requireText(
      repoRoot,
      "repoRoot",
      MAX_EVIDENCE_PATH_LENGTH,
      "repository root",
    ),
  );
  const bundle = buildEvidenceBundle(manifest, options);
  if (resolve(manifest.repoRoot) !== root) {
    throw new EvidenceBundleManifestError(
      `RunManifest repoRoot ${JSON.stringify(manifest.repoRoot)} does not match ` +
        `the requested repository ${JSON.stringify(root)}`,
    );
  }

  const path = evidenceBundlePath(root, manifest.runId);
  const content = serializeEvidenceBundle(bundle);
  const bytes = Buffer.from(content, "utf8");

  if (existingContentMatches(path, bytes)) {
    return {
      bundle,
      path,
      byteLength: bytes.byteLength,
      written: false,
    };
  }

  const dir = dirname(path);
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  } catch (error) {
    throw new EvidenceBundleWriteError(
      `cannot create evidence directory ${dir}: ${errorMessage(error)}`,
    );
  }

  const tmp = join(dir, `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`);
  try {
    const fd = openSync(tmp, "wx", 0o600);
    try {
      writeFileSync(fd, content, "utf8");
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, path);
  } catch (error) {
    try {
      unlinkSync(tmp);
    } catch {
      /* best-effort cleanup */
    }
    throw new EvidenceBundleWriteError(
      `cannot write evidence bundle ${path}: ${errorMessage(error)}`,
    );
  }

  return {
    bundle,
    path,
    byteLength: bytes.byteLength,
    written: true,
  };
}

// ---------------------------------------------------------------------------
// Manifest validation
// ---------------------------------------------------------------------------

interface TerminalManifestIdentity {
  runId: string;
  planId: string;
  repoRoot: string;
  contractsPath: string;
  contractsHash: string;
  baseCommit: string;
  integrationBranch: string;
  integrationHead: string;
  status: EvidenceTerminalStatus;
  createdAt: string;
  updatedAt: string;
  taskEntries: unknown[];
}

function readTerminalManifest(value: unknown): TerminalManifestIdentity {
  if (!isRecord(value)) {
    throw new EvidenceBundleManifestError("RunManifest must be an object");
  }
  if (value.version !== RUN_MANIFEST_VERSION) {
    throw new EvidenceBundleManifestError(
      `unsupported RunManifest version ${JSON.stringify(value.version)} ` +
        `(expected ${RUN_MANIFEST_VERSION})`,
    );
  }
  if (value.status === "running") {
    throw new EvidenceBundleNotTerminalError(
      "a running RunManifest cannot produce a final EvidenceBundle",
    );
  }
  if (
    value.status !== "completed" &&
    value.status !== "blocked" &&
    value.status !== "interrupted"
  ) {
    throw new EvidenceBundleManifestError(
      `invalid terminal RunManifest status ${JSON.stringify(value.status)}`,
    );
  }

  const runId = requireText(
    value.runId,
    "runId",
    MAX_EVIDENCE_TASK_ID_LENGTH,
    "run id",
  );
  assertSafeRunId(runId);

  if (!isRecord(value.tasks)) {
    throw new EvidenceBundleManifestError(
      "RunManifest tasks must be an object",
    );
  }
  const taskEntries = Object.values(value.tasks);
  if (taskEntries.length > MAX_EVIDENCE_TASKS) {
    throw new EvidenceBundleManifestError(
      `RunManifest tasks must contain at most ${MAX_EVIDENCE_TASKS} records`,
    );
  }

  if (!isRecord(value.owner)) {
    throw new EvidenceBundleManifestError(
      "RunManifest owner must be an object",
    );
  }
  if (
    typeof value.owner.pid !== "number" ||
    !Number.isInteger(value.owner.pid) ||
    value.owner.pid < 1
  ) {
    throw new EvidenceBundleManifestError(
      "RunManifest owner.pid must be a positive integer",
    );
  }
  requireText(value.owner.host, "owner.host", 256, "owner host");

  return {
    runId,
    planId: requireText(
      value.planId,
      "planId",
      MAX_EVIDENCE_PLAN_ID_LENGTH,
      "plan id",
    ),
    repoRoot: requireText(
      value.repoRoot,
      "repoRoot",
      MAX_EVIDENCE_PATH_LENGTH,
      "repository root",
    ),
    contractsPath: requireText(
      value.contractsPath,
      "contractsPath",
      MAX_EVIDENCE_PATH_LENGTH,
      "contracts path",
    ),
    contractsHash: requireHash(value.contractsHash, "contractsHash"),
    baseCommit: requireCommit(value.baseCommit, "baseCommit"),
    integrationBranch: requireText(
      value.integrationBranch,
      "integrationBranch",
      MAX_EVIDENCE_BRANCH_LENGTH,
      "integration branch",
    ),
    integrationHead: requireCommit(
      value.integrationHead,
      "integrationHead",
    ),
    status: value.status,
    createdAt: requireTimestamp(value.createdAt, "createdAt"),
    updatedAt: requireTimestamp(value.updatedAt, "updatedAt"),
    taskEntries,
  };
}

function readRepositoryFacts(value: unknown): EvidenceRepositoryFacts {
  if (value === undefined) return {};
  if (!isRecord(value)) {
    throw new EvidenceBundleInputError("facts must be an object");
  }
  try {
    const facts: EvidenceRepositoryFacts = {};
    if (value.contractsHash !== undefined) {
      facts.contractsHash = requireHash(
        value.contractsHash,
        "facts.contractsHash",
      );
    }
    if (value.integrationHead !== undefined) {
      facts.integrationHead = requireCommit(
        value.integrationHead,
        "facts.integrationHead",
      );
    }
    return facts;
  } catch (error) {
    if (error instanceof EvidenceBundleManifestError) {
      throw new EvidenceBundleInputError(error.message);
    }
    throw error;
  }
}

function buildContractsIdentity(
  identity: TerminalManifestIdentity,
  facts: EvidenceRepositoryFacts,
): EvidenceContractsIdentity {
  const observed = facts.contractsHash ?? null;
  return {
    path: identity.contractsPath,
    hash: identity.contractsHash,
    observedHash: observed,
    verified: observed === null ? null : observed === identity.contractsHash,
  };
}

function buildRepositoryIdentity(
  identity: TerminalManifestIdentity,
  facts: EvidenceRepositoryFacts,
): EvidenceRepositoryIdentity {
  const observed = facts.integrationHead ?? null;
  return {
    baseCommit: identity.baseCommit,
    integrationBranch: identity.integrationBranch,
    integrationHead: identity.integrationHead,
    observedIntegrationHead: observed,
    integrationHeadVerified:
      observed === null ? null : observed === identity.integrationHead,
  };
}

// ---------------------------------------------------------------------------
// Task projection
// ---------------------------------------------------------------------------

function projectTask(
  value: unknown,
  runStatus: EvidenceTerminalStatus,
  missing: Set<string>,
): EvidenceTask {
  if (!isRecord(value)) {
    throw new EvidenceBundleManifestError("task must be an object");
  }
  const taskId = requireText(
    value.taskId,
    "task.taskId",
    MAX_EVIDENCE_TASK_ID_LENGTH,
    "task id",
  );
  const label = `task.${taskId}`;
  const status = requireTaskStatus(value.status, `${label}.status`);
  if (typeof value.accepted !== "boolean") {
    throw new EvidenceBundleManifestError(
      `${label}.accepted must be boolean`,
    );
  }
  const accepted = value.accepted;
  if (accepted && status !== "accepted") {
    throw new EvidenceBundleManifestError(
      `${label} is accepted but has status ${JSON.stringify(status)}`,
    );
  }
  if (!accepted && status === "accepted") {
    throw new EvidenceBundleManifestError(
      `${label} has status accepted but is not accepted`,
    );
  }

  const resultCommit =
    value.resultCommit === undefined
      ? null
      : requireCommit(value.resultCommit, `${label}.resultCommit`);
  const reason =
    value.reason === undefined
      ? null
      : boundedReason(value.reason, `${label}.reason`);
  const failure = projectFailure(value.failure, `${label}.failure`);
  const cleanupFailure = projectFailure(
    value.cleanupFailure,
    `${label}.cleanupFailure`,
  );
  const cost = projectCost(value.cost, `${label}.cost`);
  const pathAudits = projectPathAudits(
    value.pathAudits,
    `${label}.pathAudits`,
  );
  const processTrees = projectProcessTrees(
    value.processTrees,
    `${label}.processTrees`,
  );
  const workspaceBoundary = projectWorkspaceBoundary(
    value.workspaceBoundary,
    `${label}.workspaceBoundary`,
  );

  const verdict: EvidenceTaskVerdict = accepted
    ? "accepted"
    : status === "rejected"
      ? "rejected"
      : status === "blocked"
        ? "blocked"
        : status === "cancelled"
          ? "cancelled"
          : "unresolved";

  if (!SETTLED_TASK_STATUSES.has(status)) {
    missing.add(`${label}.terminalStatus`);
  }
  if (runStatus === "completed" && !accepted) {
    missing.add(`${label}.acceptance`);
  }
  if (accepted) {
    if (resultCommit === null) missing.add(`${label}.resultCommit`);
    if (pathAudits.length === 0) missing.add(`${label}.pathAudits`);
    if (processTrees.length === 0) missing.add(`${label}.processTrees`);
    if (workspaceBoundary === null) missing.add(`${label}.workspaceBoundary`);
    if (cost === null) missing.add(`${label}.cost`);
  } else if (
    (verdict === "blocked" || verdict === "rejected") &&
    failure === null &&
    cleanupFailure === null
  ) {
    missing.add(`${label}.failure`);
  }

  return {
    taskId,
    status,
    verdict,
    accepted,
    resultCommit,
    reason,
    failure,
    cleanupFailure,
    cost,
    pathAudits,
    processTrees,
    workspaceBoundary,
  };
}

function projectFailure(value: unknown, label: string): FailureRecord | null {
  if (value === undefined) return null;
  const failure = parseFailureRecord(value);
  if (!failure) {
    throw new EvidenceBundleManifestError(
      `${label} is not a valid failure record`,
    );
  }
  return sanitizeFailure(failure);
}

function projectCost(value: unknown, label: string): CostTruth | null {
  if (value === undefined) return null;
  const cost = parseCostTruth(value);
  if (!cost) {
    throw new EvidenceBundleManifestError(
      `${label} is not a valid cost record`,
    );
  }
  if (cost.observations.length > MAX_EVIDENCE_COST_OBSERVATIONS) {
    throw new EvidenceBundleManifestError(
      `${label}.observations must contain at most ` +
        `${MAX_EVIDENCE_COST_OBSERVATIONS} records`,
    );
  }
  return sanitizeCostTruth(cost);
}

function projectPathAudits(
  value: unknown,
  label: string,
): PathAuditRecord[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new EvidenceBundleManifestError(`${label} must be an array`);
  }
  if (value.length > MAX_PATH_AUDITS) {
    throw new EvidenceBundleManifestError(
      `${label} must contain at most ${MAX_PATH_AUDITS} records`,
    );
  }

  return value.map((raw, index) => {
    const at = `${label}[${index}]`;
    if (!isRecord(raw)) {
      throw new EvidenceBundleManifestError(`${at} must be an object`);
    }
    const attempt = raw.attempt;
    if (
      typeof attempt !== "number" ||
      !Number.isInteger(attempt) ||
      attempt < 0
    ) {
      throw new EvidenceBundleManifestError(
        `${at}.attempt must be a non-negative integer`,
      );
    }
    const exitCode = raw.exitCode;
    if (typeof exitCode !== "number" || !Number.isInteger(exitCode)) {
      throw new EvidenceBundleManifestError(
        `${at}.exitCode must be an integer`,
      );
    }
    const changedPaths = projectPathList(
      raw.changedPaths,
      `${at}.changedPaths`,
    );
    const outsideWritePaths = projectPathList(
      raw.outsideWritePaths,
      `${at}.outsideWritePaths`,
    );

    let changedPathsError: string | undefined;
    if (raw.changedPathsError !== undefined) {
      if (
        typeof raw.changedPathsError !== "string" ||
        raw.changedPathsError.length === 0 ||
        raw.changedPathsError.length > MAX_PATH_AUDIT_ERROR_LENGTH
      ) {
        throw new EvidenceBundleManifestError(
          `${at}.changedPathsError must be a bounded non-empty string`,
        );
      }
      const sanitized = sanitizeDiagnostic(
        raw.changedPathsError,
        MAX_PATH_AUDIT_ERROR_LENGTH,
      );
      if (sanitized) changedPathsError = sanitized;
    }

    return {
      attempt,
      observedAt: requireTimestamp(raw.observedAt, `${at}.observedAt`),
      exitCode,
      changedPaths,
      outsideWritePaths,
      ...(changedPathsError !== undefined ? { changedPathsError } : {}),
    };
  });
}

function projectPathList(value: unknown, label: string): string[] {
  if (!Array.isArray(value)) {
    throw new EvidenceBundleManifestError(`${label} must be an array`);
  }
  if (value.length > MAX_PATH_AUDIT_PATHS) {
    throw new EvidenceBundleManifestError(
      `${label} must contain at most ${MAX_PATH_AUDIT_PATHS} paths`,
    );
  }
  return value.map((entry, index) => {
    if (
      typeof entry !== "string" ||
      entry.length === 0 ||
      entry.includes("\0")
    ) {
      throw new EvidenceBundleManifestError(
        `${label}[${index}] must be a non-empty path string`,
      );
    }
    if (entry.length > MAX_EVIDENCE_PATH_LENGTH) {
      throw new EvidenceBundleManifestError(
        `${label}[${index}] exceeds the ${MAX_EVIDENCE_PATH_LENGTH}-character ` +
          "evidence path bound",
      );
    }
    return sanitizeEvidenceText(entry, MAX_EVIDENCE_PATH_LENGTH);
  });
}

function projectProcessTrees(
  value: unknown,
  label: string,
): WorkerProcessRecord[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new EvidenceBundleManifestError(`${label} must be an array`);
  }
  if (value.length > MAX_PROCESS_TREES) {
    throw new EvidenceBundleManifestError(
      `${label} must contain at most ${MAX_PROCESS_TREES} records`,
    );
  }
  return value.map((raw, index) => {
    const record = parseWorkerProcessRecord(raw);
    if (!record) {
      throw new EvidenceBundleManifestError(
        `${label}[${index}] is not a valid worker process-tree record`,
      );
    }
    return sanitizeProcessTree(record);
  });
}

function projectWorkspaceBoundary(
  value: unknown,
  label: string,
): WorkspaceBoundaryRecord | null {
  if (value === undefined) return null;
  if (!isRecord(value)) {
    throw new EvidenceBundleManifestError(`${label} must be an object`);
  }
  if (value.version !== WORKSPACE_BOUNDARY_RECORD_VERSION) {
    throw new EvidenceBundleManifestError(
      `${label}.version must be ${WORKSPACE_BOUNDARY_RECORD_VERSION}`,
    );
  }
  if (
    value.status !== "clean" &&
    value.status !== "violation" &&
    value.status !== "inspection_error"
  ) {
    throw new EvidenceBundleManifestError(
      `${label}.status must be clean, violation or inspection_error`,
    );
  }
  if (value.enforcement !== "guard-only") {
    throw new EvidenceBundleManifestError(
      `${label}.enforcement must be "guard-only"`,
    );
  }

  const changes = projectBoundaryChanges(
    value.changes,
    `${label}.changes`,
  );

  let error: string | undefined;
  if (value.error !== undefined) {
    if (
      typeof value.error !== "string" ||
      value.error.length === 0 ||
      value.error.length > MAX_WORKSPACE_BOUNDARY_ERROR_LENGTH
    ) {
      throw new EvidenceBundleManifestError(
        `${label}.error must be a bounded non-empty string`,
      );
    }
    const sanitized = sanitizeDiagnostic(
      value.error,
      MAX_WORKSPACE_BOUNDARY_ERROR_LENGTH,
    );
    if (sanitized) error = sanitized;
  }

  return {
    version: WORKSPACE_BOUNDARY_RECORD_VERSION,
    status: value.status,
    enforcement: "guard-only",
    capturedAt: requireTimestamp(value.capturedAt, `${label}.capturedAt`),
    comparedAt: requireTimestamp(value.comparedAt, `${label}.comparedAt`),
    changes,
    ...(error !== undefined ? { error } : {}),
  };
}

function projectBoundaryChanges(
  value: unknown,
  label: string,
): WorkspaceBoundaryChangeRecord[] {
  if (!Array.isArray(value)) {
    throw new EvidenceBundleManifestError(`${label} must be an array`);
  }
  if (value.length > MAX_WORKSPACE_BOUNDARY_CHANGES) {
    throw new EvidenceBundleManifestError(
      `${label} must contain at most ${MAX_WORKSPACE_BOUNDARY_CHANGES} records`,
    );
  }

  return value.map((raw, index) => {
    const at = `${label}[${index}]`;
    if (!isRecord(raw)) {
      throw new EvidenceBundleManifestError(`${at} must be an object`);
    }
    const rootIndex = raw.rootIndex;
    if (
      typeof rootIndex !== "number" ||
      !Number.isInteger(rootIndex) ||
      rootIndex < 0
    ) {
      throw new EvidenceBundleManifestError(
        `${at}.rootIndex must be a non-negative integer`,
      );
    }
    if (
      raw.change !== "added" &&
      raw.change !== "removed" &&
      raw.change !== "modified"
    ) {
      throw new EvidenceBundleManifestError(
        `${at}.change must be added, removed or modified`,
      );
    }
    if (
      raw.kind !== "file" &&
      raw.kind !== "symlink" &&
      raw.kind !== "directory"
    ) {
      throw new EvidenceBundleManifestError(
        `${at}.kind must be file, symlink or directory`,
      );
    }
    if (
      typeof raw.path !== "string" ||
      raw.path.length === 0 ||
      raw.path.length > MAX_WORKSPACE_BOUNDARY_PATH_LENGTH ||
      normalizeEvidencePath(raw.path) !== raw.path
    ) {
      throw new EvidenceBundleManifestError(
        `${at}.path must be a bounded, safe root-relative evidence path`,
      );
    }

    const change: WorkspaceBoundaryChangeRecord = {
      rootIndex,
      change: raw.change,
      kind: raw.kind,
      path: sanitizeEvidenceText(
        raw.path,
        MAX_WORKSPACE_BOUNDARY_PATH_LENGTH,
      ),
    };
    if (raw.beforeDigest !== undefined) {
      change.beforeDigest = requireDigest(
        raw.beforeDigest,
        `${at}.beforeDigest`,
      );
    }
    if (raw.afterDigest !== undefined) {
      change.afterDigest = requireDigest(
        raw.afterDigest,
        `${at}.afterDigest`,
      );
    }
    return change;
  });
}

// ---------------------------------------------------------------------------
// Sanitizers (credential-free, bounded, non-mutating)
// ---------------------------------------------------------------------------

function sanitizeFailure(failure: FailureRecord): FailureRecord {
  const code =
    failure.code === undefined ? undefined : normalizeFailureCode(failure.code);
  const message =
    sanitizeDiagnostic(failure.message, MAX_FAILURE_MESSAGE) ||
    "unclassified failure";
  return {
    version: 1,
    category: failure.category,
    stage: failure.stage,
    ...(code ? { code } : {}),
    message,
    observedAt: failure.observedAt,
    ...(failure.retryableHint !== undefined
      ? { retryableHint: failure.retryableHint }
      : {}),
  };
}

function sanitizeCostTruth(cost: CostTruth): CostTruth {
  const observations: CostObservation[] = cost.observations.map(
    (observation, index) => {
      const sessionId =
        sanitizeEvidenceText(observation.sessionId, MAX_SESSION_ID_LENGTH) ||
        `redacted-session-${index + 1}`;
      const currency =
        observation.currency === null
          ? null
          : sanitizeEvidenceText(
              observation.currency,
              MAX_CURRENCY_LENGTH,
            ) || null;
      const usage =
        observation.usage === null
          ? null
          : {
              inputTokens: observation.usage.inputTokens,
              outputTokens: observation.usage.outputTokens,
              cacheCreationInputTokens:
                observation.usage.cacheCreationInputTokens,
              cacheReadInputTokens: observation.usage.cacheReadInputTokens,
            };
      const note =
        observation.note === undefined
          ? undefined
          : sanitizeDiagnostic(
              observation.note,
              MAX_OBSERVATION_NOTE_LENGTH,
            );
      return {
        sessionId,
        state: observation.state,
        source: observation.source,
        currency,
        amount: observation.amount,
        usage,
        ...(note ? { note } : {}),
      };
    },
  );

  const missing: string[] = [];
  for (const reason of cost.missing) {
    const sanitized = sanitizeEvidenceText(
      reason,
      MAX_MISSING_REASON_LENGTH,
    );
    if (sanitized && !missing.includes(sanitized)) missing.push(sanitized);
  }

  return {
    version: 1,
    state: cost.state,
    source: cost.source,
    authoritative: cost.authoritative,
    currency:
      cost.currency === null
        ? null
        : sanitizeEvidenceText(cost.currency, MAX_CURRENCY_LENGTH) || null,
    amount: cost.amount,
    guardBudgetUsd: cost.guardBudgetUsd,
    observations,
    usage:
      cost.usage === null
        ? null
        : {
            inputTokens: cost.usage.inputTokens,
            outputTokens: cost.usage.outputTokens,
            cacheCreationInputTokens: cost.usage.cacheCreationInputTokens,
            cacheReadInputTokens: cost.usage.cacheReadInputTokens,
          },
    missing,
  };
}

function sanitizeProcessTree(
  record: WorkerProcessRecord,
): WorkerProcessRecord {
  const signals = record.signals.map((signal) => {
    const { detail, ...rest } = signal;
    const sanitized =
      detail === undefined
        ? undefined
        : sanitizeDiagnostic(detail, MAX_PROCESS_TREE_DETAIL);
    return {
      ...rest,
      ...(sanitized ? { detail: sanitized } : {}),
    };
  });

  const { detail: rawDetail, exitSignal: rawExitSignal, ...rest } = record;
  const detail =
    rawDetail === undefined
      ? undefined
      : sanitizeDiagnostic(rawDetail, MAX_PROCESS_TREE_DETAIL);
  const exitSignal =
    rawExitSignal === undefined
      ? undefined
      : sanitizeEvidenceText(rawExitSignal, 64);

  let nestedCleanup: WorkerProcessRecord["nestedCleanup"];
  if (record.nestedCleanup !== undefined) {
    const {
      detail: nestedDetail,
      ...nestedRest
    } = record.nestedCleanup;
    const sanitized =
      nestedDetail === undefined
        ? undefined
        : sanitizeDiagnostic(nestedDetail, MAX_PROCESS_TREE_DETAIL);
    nestedCleanup = {
      ...nestedRest,
      ...(sanitized ? { detail: sanitized } : {}),
    };
  }

  return {
    ...rest,
    signals,
    ...(detail ? { detail } : {}),
    ...(exitSignal ? { exitSignal } : {}),
    ...(nestedCleanup !== undefined ? { nestedCleanup } : {}),
  };
}

function boundedReason(value: unknown, label: string): string {
  if (typeof value !== "string") {
    throw new EvidenceBundleManifestError(`${label} must be a string`);
  }
  const bounded = sanitizeDiagnostic(value, MAX_EVIDENCE_REASON_LENGTH);
  if (!bounded) {
    throw new EvidenceBundleManifestError(
      `${label} must contain observable text`,
    );
  }
  return bounded;
}

/**
 * Collapse, redact and bound diagnostic text. Control characters are removed
 * before redaction so persisted evidence stays safe on any terminal.
 */
function sanitizeDiagnostic(value: string, max: number): string {
  const cleaned = value.replace(
    CONTROL_CHARACTER_PATTERN_GLOBAL,
    "�",
  );
  return boundFailureText(cleaned, max);
}

/** Redact and bound arbitrary evidence text without collapsing whitespace. */
function sanitizeEvidenceText(value: string, max: number): string {
  const cleaned = value.replace(
    CONTROL_CHARACTER_PATTERN_GLOBAL,
    "�",
  );
  const redacted = redactFailureSecrets(cleaned);
  if (redacted.length <= max) return redacted;
  return `${redacted.slice(0, Math.max(0, max - 1))}…`;
}

// ---------------------------------------------------------------------------
// Next action
// ---------------------------------------------------------------------------

function selectNextAction(
  status: EvidenceTerminalStatus,
  authorityProblem: boolean,
  boundaryProblem: boolean,
  cleanupProblem: boolean,
  taskProblem: boolean,
  tasks: readonly EvidenceTask[],
): EvidenceNextAction {
  if (
    authorityProblem ||
    boundaryProblem ||
    cleanupProblem ||
    taskProblem
  ) {
    return "needs-human";
  }
  if (status === "completed") return "human-review";
  if (status === "blocked") {
    return tasks.some((task) => task.failure?.retryableHint === true)
      ? "resume"
      : "inspect-failure";
  }
  return "resume";
}

// ---------------------------------------------------------------------------
// Small validators
// ---------------------------------------------------------------------------

function requireText(
  value: unknown,
  field: string,
  max: number,
  label = field,
): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new EvidenceBundleManifestError(
      `${field} must be a non-empty ${label}`,
    );
  }
  if (value.length > max) {
    throw new EvidenceBundleManifestError(
      `${field} exceeds the ${max}-character bound`,
    );
  }
  if (CONTROL_CHARACTER_PATTERN.test(value)) {
    throw new EvidenceBundleManifestError(
      `${field} must not contain control characters`,
    );
  }
  return value;
}

function requireHash(value: unknown, field: string): string {
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) {
    throw new EvidenceBundleManifestError(
      `${field} must be a SHA-256 hex digest`,
    );
  }
  return value.toLowerCase();
}

function requireDigest(value: unknown, field: string): string {
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) {
    throw new EvidenceBundleManifestError(
      `${field} must be a SHA-256 hex digest`,
    );
  }
  return value.toLowerCase();
}

function requireCommit(value: unknown, field: string): string {
  if (typeof value !== "string" || !COMMIT_PATTERN.test(value)) {
    throw new EvidenceBundleManifestError(
      `${field} must be a full 40- or 64-character hex commit`,
    );
  }
  return value.toLowerCase();
}

function requireTimestamp(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 64) {
    throw new EvidenceBundleManifestError(`${field} must be a timestamp`);
  }
  if (Number.isNaN(Date.parse(value))) {
    throw new EvidenceBundleManifestError(`${field} must be a timestamp`);
  }
  return value;
}

function requireTaskStatus(value: unknown, field: string): TaskStatus {
  if (typeof value !== "string" || !TASK_STATUSES.has(value)) {
    throw new EvidenceBundleManifestError(
      `${field} must be a known task status`,
    );
  }
  return value as TaskStatus;
}

function assertSafeRunId(runId: string): void {
  if (typeof runId !== "string" || !RUN_ID_PATTERN.test(runId)) {
    throw new EvidenceBundleManifestError(
      `invalid runId: ${JSON.stringify(runId)}`,
    );
  }
}

function assertBundleSize(bundle: EvidenceBundle): void {
  let serialized: string;
  try {
    serialized = serializeEvidenceBundle(bundle);
  } catch (error) {
    throw new EvidenceBundleError(
      `EvidenceBundle is not serializable: ${errorMessage(error)}`,
    );
  }
  const size = Buffer.byteLength(serialized, "utf8");
  if (size > MAX_EVIDENCE_BUNDLE_BYTES) {
    throw new EvidenceBundleError(
      `EvidenceBundle exceeds the ${MAX_EVIDENCE_BUNDLE_BYTES}-byte bound`,
    );
  }
}

function existingContentMatches(path: string, bytes: Buffer): boolean {
  let size: number;
  try {
    const stats = statSync(path);
    if (!stats.isFile()) return false;
    size = stats.size;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw new EvidenceBundleWriteError(
      `cannot inspect evidence bundle ${path}: ${errorMessage(error)}`,
    );
  }
  if (size !== bytes.byteLength) return false;
  try {
    return readFileSync(path).equals(bytes);
  } catch (error) {
    throw new EvidenceBundleWriteError(
      `cannot read evidence bundle ${path}: ${errorMessage(error)}`,
    );
  }
}

function compareStrings(first: string, second: string): number {
  return first < second ? -1 : first > second ? 1 : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

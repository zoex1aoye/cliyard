/**
 * Durable foreground orchestration queue storage
 * (design/durable-orchestration-v0.md).
 *
 * Layout, relative to the repository root:
 *
 *   .cliyard/queue.json   ordered queue items
 *   .cliyard/queue.lock   exclusive queue ownership
 *
 * Queue JSON is replaced atomically. Mutations take the queue lock, so two
 * foreground commands cannot interleave a read-modify-write. The lock records
 * pid/host/token; a same-host lock whose owner is dead is stale and may be
 * reclaimed. A foreign-host or unreadable lock fails closed.
 *
 * The queue only coordinates Supervisor runs. It never writes a RunManifest.
 */
import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { hostname } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { compilePlan, parsePlanJson } from "../planner/plan.js";
import { findCycle } from "../scheduler/dag.js";
import {
  isProcessAlive,
  isSameHost,
  loadRunManifest,
  SUPERVISOR_DIR,
} from "../supervisor/store.js";
import {
  parseFailureRecord,
  type FailureRecord,
} from "../failures.js";
import { materializedContractsPath } from "./plan-materializer.js";
import { tryAppendQueueEvent } from "./event-journal.js";
import {
  parseQueueContinuationPolicy,
  type QueueContinuationPolicy,
} from "../agents/continuation.js";
import {
  createLegacyExecutionProfile,
  executionProfileEventFields,
  executionProfileMirrorReason,
  parseExecutionProfile,
  type ExecutionProfile,
  type ExecutionRuntimeId,
} from "../execution/profile.js";

export const QUEUE_VERSION = 1 as const;
export const QUEUE_FILE = "queue.json";
export const QUEUE_LOCK_FILE = "queue.lock";
export const DEFAULT_MAX_ATTEMPTS = 3;

/** First formal operator resolution format (design/queue-adoption-v1.md). */
export const OPERATOR_RESOLUTION_VERSION = 1 as const;
export const REVIEW_EVIDENCE_VERSION = 1 as const;
export const MAX_REVIEW_EVIDENCE_BYTES = 64 * 1024;
export const MAX_REVIEW_EVIDENCE_COMMANDS = 64;
export const MAX_REVIEW_COMMAND_LENGTH = 2_000;
export const MAX_REVIEW_NOTES_LENGTH = 2_000;
export const MAX_REVIEW_EVIDENCE_PATH_LENGTH = 4_096;
export const MAX_APPROVED_BY_LENGTH = 128;
export const MAX_ADOPTION_REASON_LENGTH = 1_000;

/** Queue ids are explicit labels and must be safe path/manifest identifiers. */
const QUEUE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/i;
/** Exact full git object id: SHA-1 (40) or SHA-256 (64) repositories. */
const FULL_COMMIT_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;
/** Matches the Supervisor's exact run-id shape. */
const RUN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export type QueueItemStatus =
  | "pending"
  | "running"
  | "completed"
  | "blocked"
  | "cancelled";
export type QueueNextAction = "start" | "resume";
export type QueueWorker = "claude" | "codex";

/**
 * Queue metadata for one Plan-backed item, matching
 * `QueuePlanMaterialization` in design/plan-backed-chain-v0.md. It is
 * persisted only after the deterministic artifact exists and has been hashed.
 */
export interface QueuePlanMaterialization {
  planPath: string;
  planHash: string;
  planId: string;
  baseCommit: string;
  upstreamQueueId?: string;
  upstreamRunId?: string;
  upstreamIntegrationHead?: string;
  contractsPath: string;
  contractsHash: string;
  materializedAt: string;
  /**
   * Explicit adopted lineage: the upstream item's reviewed commit. Present
   * only when the dependency was completed by an OperatorResolution.
   */
  upstreamAdoptedCommit?: string;
}

export type OperatorResolutionManifestStatus = "blocked" | "interrupted";

/**
 * Immutable operator acceptance of manually reviewed work
 * (design/execution-authority-v1.md §6, design/queue-adoption-v1.md).
 *
 * A resolution is separate from the RunManifest. It never rewrites the source
 * run, never marks a rejected task accepted, and never claims the worker
 * succeeded. The queue item becomes terminally completed through this record.
 */
export interface OperatorResolution {
  version: typeof OPERATOR_RESOLUTION_VERSION;
  kind: "manual-adoption";
  queueItemId: string;
  sourceRunId: string;
  sourceManifestStatus: OperatorResolutionManifestStatus;
  /** The source RunManifest baseCommit (full object id, lowercase). */
  baseCommit: string;
  /** Frozen contracts identity the source run was dispatched under. */
  contractsHash: string;
  /** Exact reviewed Git commit integrated by the operator (full object id). */
  reviewedCommit: string;
  reviewEvidencePath: string;
  /** SHA-256 of the exact evidence file bytes. */
  reviewEvidenceHash: string;
  approvedBy: string;
  approvedAt: string;
  reason: string;
}

/**
 * One accepted queue item.
 *
 * Contract-backed items (the only v0 legacy kind) carry the frozen
 * `contractsPath`/`contractsHash` captured at `queue add`. Plan-backed items
 * are discriminated by `planPath` presence and carry the approved Plan
 * identity instead; their contracts identity exists only in `materialization`
 * once dispatch has compiled it. `planId` is the supervisor plan label for
 * contract items and must equal `id` for Plan items.
 */
export interface QueueItem {
  id: string;
  /** Contract-backed items only. */
  contractsPath?: string;
  contractsHash?: string;
  /** Plan-backed items only; its presence is the source discriminator. */
  planPath?: string;
  /** Plan-backed items only: exact SHA-256 of the approved Plan bytes. */
  planHash?: string;
  planId?: string;
  /** Plan-backed root items only: the HEAD pinned by `queue add-plan`. */
  planBaseCommit?: string;
  /** Plan-backed items only: the exact materialized attempt-chain identity. */
  materialization?: QueuePlanMaterialization;
  worker: QueueWorker;
  /**
   * Frozen v1 execution identity for every newly added item. Legacy queue
   * records may omit it and retain their worker/model behavior.
   */
  executionProfile?: ExecutionProfile;
  /** Frozen queue-owned Supervisor continuation envelope. */
  continuationPolicy?: QueueContinuationPolicy;
  /** Exact mirror of profile.runtimeId when executionProfile is present. */
  model?: string;
  /**
   * Present only for a completed-by-adoption item. The source RunManifest is
   * untouched and remains the authority for what the worker actually did.
   */
  resolution?: OperatorResolution;
  dependsOn: string[];
  status: QueueItemStatus;
  attempts: number;
  maxAttempts: number;
  runIds: string[];
  lastRunId?: string;
  nextAction: QueueNextAction;
  createdAt: string;
  updatedAt: string;
  reason?: string;
  /**
   * Durable structured failure for a deterministic pre-dispatch block only.
   * A dispatched run's failure lives in its RunManifest; the queue never
   * duplicates it or overrides that authority. Cleared by retry.
   */
  failure?: FailureRecord;
}

/** Frozen contracts path/hash for one queue item, whatever its source kind. */
export interface QueueContractsIdentity {
  contractsPath: string;
  contractsHash: string;
}

export type PlanBackedQueueItem = QueueItem & {
  planPath: string;
  planHash: string;
  planId: string;
  contractsPath?: undefined;
  contractsHash?: undefined;
};

/** `planPath` presence is the v0 source discriminator; no source field exists. */
export function isPlanBackedQueueItem(
  item: QueueItem,
): item is PlanBackedQueueItem {
  return typeof item.planPath === "string" && item.planPath.trim() !== "";
}

/** True for a terminal queue item completed through manual adoption. */
export function isAdoptedQueueItem(
  item: QueueItem,
): item is QueueItem & { resolution: OperatorResolution } {
  return item.resolution !== undefined;
}

/**
 * Exact frozen contracts identity for dispatch and lineage checks. A Plan item
 * has none until its materialization has been recorded.
 */
export function queueItemContractsIdentity(
  item: QueueItem,
): QueueContractsIdentity | undefined {
  if (isPlanBackedQueueItem(item)) {
    if (!item.materialization) return undefined;
    return {
      contractsPath: item.materialization.contractsPath,
      contractsHash: item.materialization.contractsHash,
    };
  }
  if (
    typeof item.contractsPath === "string" &&
    typeof item.contractsHash === "string"
  ) {
    return {
      contractsPath: item.contractsPath,
      contractsHash: item.contractsHash,
    };
  }
  return undefined;
}

export interface QueueDocument {
  version: typeof QUEUE_VERSION;
  updatedAt: string;
  items: QueueItem[];
}

/** `<repo>/.cliyard/queue.lock` — exclusive foreground queue ownership. */
export interface QueueLockInfo {
  pid: number;
  host: string;
  token: string;
  acquiredAt: string;
}

export interface QueuePaths {
  repoRoot: string;
  cliyardDir: string;
  queuePath: string;
  lockPath: string;
}

export function queuePaths(repoRoot: string): QueuePaths {
  const root = resolve(repoRoot);
  const cliyardDir = join(root, SUPERVISOR_DIR);
  return {
    repoRoot: root,
    cliyardDir,
    queuePath: join(cliyardDir, QUEUE_FILE),
    lockPath: join(cliyardDir, QUEUE_LOCK_FILE),
  };
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class QueueStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

export class QueueValidationError extends QueueStoreError {}

export class QueueItemNotFoundError extends QueueStoreError {
  constructor(
    readonly id: string,
    readonly path: string,
  ) {
    super(`queue item not found: ${id} (${path})`);
  }
}

export class QueueLockError extends QueueStoreError {}

export class QueueLockHeldError extends QueueLockError {
  constructor(
    readonly lockPath: string,
    readonly owner: QueueLockInfo | undefined,
    readonly state: "held" | "invalid",
    readonly detail?: string,
  ) {
    super(
      state === "invalid"
        ? `queue lock ${lockPath} is invalid` +
            (detail ? `: ${detail}` : "") +
            "; inspect it and clean it up manually"
        : owner
          ? `queue lock held by pid ${owner.pid} on ${owner.host}` +
            (detail ? ` (${detail})` : "")
          : `queue lock is held at ${lockPath}` +
            (detail ? `: ${detail}` : ""),
    );
    this.name = "QueueLockHeldError";
  }
}

// ---------------------------------------------------------------------------
// Contracts hash
// ---------------------------------------------------------------------------

/** SHA-256 of a file's exact bytes. Read failures are validation errors. */
export function hashFileSha256(filePath: string): string {
  let bytes: Buffer;
  try {
    bytes = readFileSync(filePath);
  } catch (error) {
    throw new QueueValidationError(
      `contracts file is missing or unreadable: ${resolve(filePath)} ` +
        `(${errorMessage(error)})`,
    );
  }
  return createHash("sha256").update(bytes).digest("hex");
}

export interface QueueContractsCheck {
  ok: boolean;
  contractsPath: string;
  expected: string;
  actual: string | null;
  reason?: string;
}

/** Compare the frozen item hash with the current contracts bytes. */
export function checkQueueContracts(
  item: Pick<QueueItem, "contractsPath" | "contractsHash">,
): QueueContractsCheck {
  const contractsPath = item.contractsPath;
  const expected = item.contractsHash;
  if (typeof contractsPath !== "string" || typeof expected !== "string") {
    return {
      ok: false,
      contractsPath: contractsPath ?? "",
      expected: expected ?? "",
      actual: null,
      reason: "contracts identity is missing for this queue item",
    };
  }
  let actual: string;
  try {
    actual = hashFileSha256(contractsPath);
  } catch (error) {
    return {
      ok: false,
      contractsPath,
      expected,
      actual: null,
      reason: errorMessage(error),
    };
  }
  if (actual !== expected) {
    return {
      ok: false,
      contractsPath,
      expected,
      actual,
      reason:
        `contracts changed: ${contractsPath} ` +
        `(expected sha256 ${expected}, found ${actual})`,
    };
  }
  return {
    ok: true,
    contractsPath,
    expected,
    actual,
  };
}

// ---------------------------------------------------------------------------
// Queue document
// ---------------------------------------------------------------------------

function emptyQueue(): QueueDocument {
  return {
    version: QUEUE_VERSION,
    updatedAt: new Date(0).toISOString(),
    items: [],
  };
}

/** Load the queue. A missing queue file is an empty queue. */
export function loadQueue(repoRoot: string): QueueDocument {
  const path = queuePaths(repoRoot).queuePath;
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return emptyQueue();
    }
    throw new QueueStoreError(
      `cannot read queue ${path}: ${errorMessage(error)}`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch (error) {
    throw new QueueValidationError(
      `invalid JSON in queue ${path}: ${errorMessage(error)}`,
    );
  }
  return parseQueueDocument(parsed, path, resolve(repoRoot));
}

/** Validate and atomically replace the queue JSON. */
export function saveQueue(repoRoot: string, document: QueueDocument): void {
  const root = resolve(repoRoot);
  const normalized = parseQueueDocument(document, "queue", root);
  writeJsonAtomic(queuePaths(root).queuePath, normalized);
}

export interface QueueCounts {
  total: number;
  pending: number;
  running: number;
  completed: number;
  blocked: number;
  cancelled: number;
}

export function queueCounts(document: QueueDocument): QueueCounts {
  const counts: QueueCounts = {
    total: document.items.length,
    pending: 0,
    running: 0,
    completed: 0,
    blocked: 0,
    cancelled: 0,
  };
  for (const item of document.items) counts[item.status] += 1;
  return counts;
}

// ---------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------

export interface AddQueueItemInput {
  id: string;
  /** Resolved against the repository root when relative. */
  contractsPath: string;
  dependsOn?: string[];
  worker?: QueueWorker;
  model?: string;
  /** Parsed once under the queue lock and persisted; the path is never stored. */
  executionProfilePath?: string;
  /** Parsed once under the queue lock and persisted; the path is never stored. */
  continuationPolicyPath?: string;
  planId?: string;
  maxAttempts?: number;
}

/**
 * Add one approved contracts file. The contracts path is made absolute and
 * hashed under the queue lock so the frozen identity matches the bytes the
 * operator approved.
 */
export function addQueueItem(
  repoRoot: string,
  input: AddQueueItemInput,
): QueueItem {
  const root = resolve(repoRoot);
  return withQueueLock(root, () => {
    const document = loadQueue(root);
    assertSafeQueueId(input.id, "queue id");
    if (document.items.some((item) => item.id === input.id)) {
      throw new QueueValidationError(
        `duplicate queue id ${JSON.stringify(input.id)}`,
      );
    }
    if (typeof input.contractsPath !== "string" || !input.contractsPath.trim()) {
      throw new QueueValidationError("contractsPath must be a non-empty string");
    }
    const contractsPath = isAbsolute(input.contractsPath)
      ? resolve(input.contractsPath)
      : resolve(root, input.contractsPath);
    if (!existsSync(contractsPath)) {
      throw new QueueValidationError(
        `contracts file not found: ${contractsPath}`,
      );
    }
    const contractsHash = hashFileSha256(contractsPath);

    const dependsOn = uniqueStrings(input.dependsOn ?? []);
    for (const dependency of dependsOn) {
      assertSafeQueueId(dependency, "dependency id");
      if (!document.items.some((item) => item.id === dependency)) {
        throw new QueueValidationError(
          `queue item ${JSON.stringify(input.id)} depends on unknown item ` +
            JSON.stringify(dependency),
        );
      }
    }
    const cycle = findCycle([
      ...document.items.map((item) => ({
        id: item.id,
        dependsOn: item.dependsOn,
      })),
      { id: input.id, dependsOn },
    ]);
    if (!cycle.ok) {
      throw new QueueValidationError(
        `dependency cycle: ${cycle.cycle.join(" -> ")}`,
      );
    }

    const execution = resolveExecutionFreeze(root, input);
    const maxAttempts = input.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
    validateMaxAttemptsInput(maxAttempts);

    const planId = optionalNonEmpty(input.planId);
    const at = now();
    const item: QueueItem = {
      id: input.id,
      contractsPath,
      contractsHash,
      ...(planId !== undefined ? { planId } : {}),
      worker: execution.worker,
      model: execution.model,
      executionProfile: execution.executionProfile,
      ...(execution.continuationPolicy !== undefined
        ? { continuationPolicy: execution.continuationPolicy }
        : {}),
      dependsOn,
      status: "pending",
      attempts: 0,
      maxAttempts,
      runIds: [],
      nextAction: "start",
      createdAt: at,
      updatedAt: at,
    };
    document.items.push(item);
    document.updatedAt = at;
    saveQueue(root, document);
    tryAppendQueueEvent(root, {
      type: "queue.item.added",
      at,
      itemId: item.id,
      status: item.status,
      action: item.nextAction,
      ...executionProfileEventFields(
        item.executionProfile,
        item.continuationPolicy,
      ),
    });
    return item;
  });
}

export interface AddPlanQueueItemInput {
  id: string;
  /** Resolved against the repository root when relative. */
  planPath: string;
  dependsOn?: string[];
  worker?: QueueWorker;
  model?: string;
  /** Parsed once under the queue lock and persisted; the path is never stored. */
  executionProfilePath?: string;
  /** Parsed once under the queue lock and persisted; the path is never stored. */
  continuationPolicyPath?: string;
  maxAttempts?: number;
}

/**
 * Add one explicitly approved Plan. The Plan is read exactly once under the
 * queue lock, snapshotted as an absolute path plus SHA-256, parsed and compiled
 * at the repository HEAD captured by this mutation. Nothing is materialized or
 * dispatched here: the queue only persists the human authority.
 */
export function addPlanQueueItem(
  repoRoot: string,
  input: AddPlanQueueItemInput,
): QueueItem {
  const root = resolve(repoRoot);
  return withQueueLock(root, () => {
    const document = loadQueue(root);
    assertSafeQueueId(input.id, "queue id");
    if (document.items.some((item) => item.id === input.id)) {
      throw new QueueValidationError(
        `duplicate queue id ${JSON.stringify(input.id)}`,
      );
    }
    if (typeof input.planPath !== "string" || !input.planPath.trim()) {
      throw new QueueValidationError("planPath must be a non-empty string");
    }
    const planPath = isAbsolute(input.planPath)
      ? resolve(input.planPath)
      : resolve(root, input.planPath);

    let planBytes: Buffer;
    try {
      planBytes = readFileSync(planPath);
    } catch (error) {
      throw new QueueValidationError(
        `Plan file is missing or unreadable: ${planPath} ` +
          `(${errorMessage(error)})`,
      );
    }
    const planHash = sha256Hex(planBytes);
    let parsed: unknown;
    try {
      parsed = parsePlanJson(planBytes.toString("utf8"));
    } catch (error) {
      throw new QueueValidationError(
        `cannot parse Plan ${planPath}: ${errorMessage(error)}`,
      );
    }

    const dependsOn = uniqueStrings(input.dependsOn ?? []);
    if (dependsOn.length > 1) {
      throw new QueueValidationError(
        `plan-backed queue item ${JSON.stringify(input.id)} supports at most ` +
          `one dependency in v0 (got ${dependsOn.length})`,
      );
    }
    for (const dependency of dependsOn) {
      assertSafeQueueId(dependency, "dependency id");
      if (!document.items.some((item) => item.id === dependency)) {
        throw new QueueValidationError(
          `queue item ${JSON.stringify(input.id)} depends on unknown item ` +
            JSON.stringify(dependency),
        );
      }
    }
    const cycle = findCycle([
      ...document.items.map((item) => ({
        id: item.id,
        dependsOn: item.dependsOn,
      })),
      { id: input.id, dependsOn },
    ]);
    if (!cycle.ok) {
      throw new QueueValidationError(
        `dependency cycle: ${cycle.cycle.join(" -> ")}`,
      );
    }

    // The root base is the HEAD captured by this mutation. It is persisted
    // only for root items; a dependent base comes from the upstream run.
    const planBaseCommit = resolveRepositoryHead(root);
    let compiled: ReturnType<typeof compilePlan>;
    try {
      compiled = compilePlan(parsed, { baseCommit: planBaseCommit });
    } catch (error) {
      throw new QueueValidationError(
        `invalid Plan ${planPath}: ${errorMessage(error)}`,
      );
    }
    // v0 Plan-id invariant: the approved Plan id is the queue item id.
    if (compiled.planId !== input.id) {
      throw new QueueValidationError(
        `Plan id mismatch: Plan declares ${JSON.stringify(compiled.planId)}, ` +
          `queue item id is ${JSON.stringify(input.id)}`,
      );
    }

    const execution = resolveExecutionFreeze(root, input);
    const maxAttempts = input.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
    validateMaxAttemptsInput(maxAttempts);
    const at = now();
    const item: QueueItem = {
      id: input.id,
      planPath,
      planHash,
      planId: compiled.planId,
      ...(dependsOn.length === 0 ? { planBaseCommit } : {}),
      worker: execution.worker,
      model: execution.model,
      executionProfile: execution.executionProfile,
      ...(execution.continuationPolicy !== undefined
        ? { continuationPolicy: execution.continuationPolicy }
        : {}),
      dependsOn,
      status: "pending",
      attempts: 0,
      maxAttempts,
      runIds: [],
      nextAction: "start",
      createdAt: at,
      updatedAt: at,
    };
    document.items.push(item);
    document.updatedAt = at;
    saveQueue(root, document);
    tryAppendQueueEvent(root, {
      type: "queue.item.added",
      at,
      itemId: item.id,
      status: item.status,
      action: item.nextAction,
      ...executionProfileEventFields(
        item.executionProfile,
        item.continuationPolicy,
      ),
    });
    return item;
  });
}

/**
 * Return a blocked item to pending. `nextAction` is `resume` whenever a run id
 * is recorded, otherwise `start`. A pending item is already retryable.
 */
export function retryQueueItem(repoRoot: string, id: string): QueueItem {
  const root = resolve(repoRoot);
  return withQueueLock(root, () => {
    const document = loadQueue(root);
    const item = requireQueueItem(document, root, id);
    if (item.status === "completed") {
      throw new QueueValidationError(
        `queue item ${JSON.stringify(id)} is completed; ` +
          "completed items never run again",
      );
    }
    if (item.status === "cancelled") {
      throw new QueueValidationError(
        `queue item ${JSON.stringify(id)} is cancelled; ` +
          "cancelled items never run again",
      );
    }
    if (item.status === "running") {
      throw new QueueValidationError(
        `queue item ${JSON.stringify(id)} is running (or stale); ` +
          "run `cliyard queue run` to reconcile it before retrying",
      );
    }
    if (item.status === "pending") return item;

    const at = now();
    item.status = "pending";
    item.nextAction = item.lastRunId ? "resume" : "start";
    delete item.reason;
    // A pre-dispatch failure describes the blocked attempt, not the retry.
    // Dispatched-run failures live in the RunManifest and are never copied.
    delete item.failure;
    item.updatedAt = at;
    document.updatedAt = at;
    saveQueue(root, document);
    tryAppendQueueEvent(root, {
      type: "queue.retry",
      at,
      itemId: item.id,
      ...(item.lastRunId !== undefined ? { runId: item.lastRunId } : {}),
      attempt: item.attempts,
      status: item.status,
      action: item.nextAction,
    });
    return item;
  });
}

/**
 * Cancel an item. Completed and already-cancelled items are monotonic; a stale
 * running item may be cancelled because holding the queue lock proves no queue
 * dispatch is active.
 */
export function cancelQueueItem(repoRoot: string, id: string): QueueItem {
  const root = resolve(repoRoot);
  return withQueueLock(root, () => {
    const document = loadQueue(root);
    const item = requireQueueItem(document, root, id);
    if (item.status === "completed") {
      throw new QueueValidationError(
        `queue item ${JSON.stringify(id)} is completed; ` +
          "completed items never run again",
      );
    }
    if (item.status === "cancelled") return item;

    const at = now();
    item.status = "cancelled";
    item.reason = "cancelled";
    item.updatedAt = at;
    document.updatedAt = at;
    saveQueue(root, document);
    tryAppendQueueEvent(root, {
      type: "queue.cancel",
      at,
      itemId: item.id,
      ...(item.lastRunId !== undefined ? { runId: item.lastRunId } : {}),
      attempt: item.attempts,
      status: item.status,
    });
    return item;
  });
}

// ---------------------------------------------------------------------------
// Manual adoption / OperatorResolution
// ---------------------------------------------------------------------------

/** One reviewed check command. Raw output is never stored, only its hash. */
export interface ReviewEvidenceCommand {
  command: string;
  exitCode: number;
  /** SHA-256 of the exact command output bytes the reviewer observed. */
  outputSha256: string;
  notes?: string;
}

/** Versioned, bounded, secret-free manual review evidence. */
export interface ReviewEvidence {
  version: typeof REVIEW_EVIDENCE_VERSION;
  reviewedAt: string;
  /** Optional binding: when present it must equal the adopted commit. */
  reviewedCommit?: string;
  commands: ReviewEvidenceCommand[];
  notes?: string;
}

interface ParsedReviewEvidence {
  path: string;
  bytes: Buffer;
  hash: string;
  evidence: ReviewEvidence;
}

export interface AdoptQueueItemInput {
  id: string;
  /** Exact source run id; must equal the item's recorded lastRunId. */
  runId: string;
  /** Full reviewed commit id integrated into the current HEAD. */
  artifact: string;
  /** Review evidence JSON path; relative paths resolve against the repo. */
  evidencePath: string;
  approvedBy: string;
  reason: string;
}

/**
 * Adopt one blocked queue item whose work was manually reviewed and integrated.
 *
 * The source RunManifest is read as evidence only and never rewritten. The
 * queue item becomes terminally `completed` with an immutable
 * `OperatorResolution`; repeated adoption is accepted only for a byte-equal
 * resolution identity.
 */
export function adoptQueueItem(
  repoRoot: string,
  input: AdoptQueueItemInput,
): QueueItem {
  const root = resolve(repoRoot);
  return withQueueLock(root, () => {
    const document = loadQueue(root);
    const item = requireQueueItem(document, root, input.id);
    const runId = requireRunId(input.runId);
    const approvedBy = requireAdoptionText(
      input.approvedBy,
      "--approved-by",
      MAX_APPROVED_BY_LENGTH,
    );
    const reason = requireAdoptionText(
      input.reason,
      "--reason",
      MAX_ADOPTION_REASON_LENGTH,
    );
    // Evidence bytes are hashed exactly as supplied. Missing, oversized,
    // malformed or secret-bearing evidence fails before any state change.
    const evidence = readReviewEvidenceFile(root, input.evidencePath);

    if (item.resolution !== undefined) {
      if (item.status !== "completed") {
        throw new QueueValidationError(
          `queue item ${JSON.stringify(item.id)} has an adoption resolution ` +
            `but is ${item.status}; refusing to mutate it`,
        );
      }
      const candidate = buildAdoptionResolution(
        root,
        item,
        {
          runId,
          artifact: input.artifact,
          approvedBy,
          reason,
          evidence,
        },
        item.resolution.approvedAt,
      );
      assertSameResolutionIdentity(item.resolution, candidate);
      return item;
    }

    if (item.status !== "blocked") {
      throw new QueueValidationError(
        `queue item ${JSON.stringify(item.id)} is ${item.status}; ` +
          "only a blocked item with a reviewed run may be adopted",
      );
    }
    if (item.lastRunId !== runId) {
      throw new QueueValidationError(
        `queue item ${JSON.stringify(item.id)} lastRunId ` +
          `${JSON.stringify(item.lastRunId ?? null)} does not match ` +
          `--run ${JSON.stringify(runId)}`,
      );
    }

    const at = now();
    const resolution = buildAdoptionResolution(
      root,
      item,
      {
        runId,
        artifact: input.artifact,
        approvedBy,
        reason,
        evidence,
      },
      at,
    );

    item.status = "completed";
    item.resolution = resolution;
    delete item.reason;
    delete item.failure;
    item.nextAction = item.lastRunId ? "resume" : "start";
    item.updatedAt = at;
    document.updatedAt = at;
    saveQueue(root, document);
    // Observability only: resolution in queue.json is the durable authority.
    tryAppendQueueEvent(root, {
      type: "queue.item.adopted",
      at: resolution.approvedAt,
      itemId: resolution.queueItemId,
      runId: resolution.sourceRunId,
      status: "completed",
      sourceManifestStatus: resolution.sourceManifestStatus,
      baseCommit: resolution.baseCommit,
      reviewedCommit: resolution.reviewedCommit,
      contractsHash: resolution.contractsHash,
      reviewEvidencePath: resolution.reviewEvidencePath,
      reviewEvidenceHash: resolution.reviewEvidenceHash,
      approvedBy: resolution.approvedBy,
      reason: resolution.reason,
    });
    return item;
  });
}

interface AdoptionEvidenceInput {
  runId: string;
  artifact: string;
  approvedBy: string;
  reason: string;
  evidence: ParsedReviewEvidence;
}

function buildAdoptionResolution(
  repoRoot: string,
  item: QueueItem,
  input: AdoptionEvidenceInput,
  approvedAt: string,
): OperatorResolution {
  if (item.lastRunId !== input.runId) {
    throw new QueueValidationError(
      `queue item ${JSON.stringify(item.id)} lastRunId ` +
        `${JSON.stringify(item.lastRunId ?? null)} does not match ` +
        `--run ${JSON.stringify(input.runId)}`,
    );
  }

  let manifest: RunManifestLike;
  try {
    manifest = loadRunManifest(repoRoot, input.runId);
  } catch (error) {
    throw new QueueValidationError(
      `cannot load source RunManifest ${JSON.stringify(input.runId)}: ` +
        `${errorMessage(error)}`,
    );
  }
  if (manifest.runId !== input.runId) {
    throw new QueueValidationError(
      `source RunManifest run id ${JSON.stringify(manifest.runId)} does not ` +
        `match --run ${JSON.stringify(input.runId)}`,
    );
  }
  if (resolve(manifest.repoRoot) !== resolve(repoRoot)) {
    throw new QueueValidationError(
      `source run ${JSON.stringify(input.runId)} belongs to ` +
        `${resolve(manifest.repoRoot)}, not ${resolve(repoRoot)}`,
    );
  }
  if (manifest.status !== "blocked" && manifest.status !== "interrupted") {
    throw new QueueValidationError(
      `source RunManifest ${JSON.stringify(input.runId)} is ` +
        `${manifest.status}; only blocked or interrupted runs may be adopted`,
    );
  }

  const identity = queueItemContractsIdentity(item);
  if (!identity) {
    throw new QueueValidationError(
      `queue item ${JSON.stringify(item.id)} has no frozen contracts identity`,
    );
  }
  const contractsHash = identity.contractsHash.toLowerCase();
  let artifactHash: string;
  try {
    artifactHash = hashFileBytes(identity.contractsPath, "contracts file");
  } catch (error) {
    throw new QueueValidationError(errorMessage(error));
  }
  if (artifactHash !== contractsHash) {
    throw new QueueValidationError(
      `frozen contracts changed: ${identity.contractsPath} ` +
        `(expected sha256 ${identity.contractsHash}, found ${artifactHash})`,
    );
  }
  if (
    resolve(manifest.contractsPath) !== resolve(identity.contractsPath) ||
    manifest.contractsHash.toLowerCase() !== contractsHash
  ) {
    throw new QueueValidationError(
      `source RunManifest ${JSON.stringify(input.runId)} contracts identity ` +
        "does not match the item's frozen contracts",
    );
  }

  if (isPlanBackedQueueItem(item)) {
    if (!item.materialization) {
      throw new QueueValidationError(
        `plan-backed item ${JSON.stringify(item.id)} has no recorded ` +
          "materialization; it was never dispatched under frozen contracts",
      );
    }
    let planHash: string;
    try {
      planHash = hashFileBytes(item.planPath, "approved Plan file");
    } catch (error) {
      throw new QueueValidationError(errorMessage(error));
    }
    if (planHash !== item.planHash.toLowerCase()) {
      throw new QueueValidationError(
        `approved Plan changed: ${item.planPath} (expected sha256 ` +
          `${item.planHash}, found ${planHash})`,
      );
    }
    if (
      manifest.baseCommit.toLowerCase() !==
      item.materialization.baseCommit.toLowerCase()
    ) {
      throw new QueueValidationError(
        `source RunManifest base ${manifest.baseCommit} does not match the ` +
          `materialized base ${item.materialization.baseCommit}`,
      );
    }
  }

  const baseCommit = resolveExactCommit(
    repoRoot,
    manifest.baseCommit,
    "source RunManifest baseCommit",
  );
  const reviewedCommit = resolveExactCommit(
    repoRoot,
    input.artifact,
    "--artifact",
  );
  const head = resolveRepositoryHead(repoRoot);
  assertAncestorOrEqual(
    repoRoot,
    baseCommit,
    reviewedCommit,
    `reviewed commit ${reviewedCommit} is not a descendant of the pinned ` +
      `source base ${baseCommit}`,
  );
  assertAncestorOrEqual(
    repoRoot,
    reviewedCommit,
    head,
    `reviewed commit ${reviewedCommit} is not an ancestor of or equal to ` +
      `the current HEAD ${head}`,
  );
  const evidenceCommit = input.evidence.evidence.reviewedCommit;
  if (
    evidenceCommit !== undefined &&
    evidenceCommit.toLowerCase() !== reviewedCommit
  ) {
    throw new QueueValidationError(
      `review evidence reviewedCommit ${evidenceCommit} does not match ` +
        `--artifact ${reviewedCommit}`,
    );
  }

  return {
    version: OPERATOR_RESOLUTION_VERSION,
    kind: "manual-adoption",
    queueItemId: item.id,
    sourceRunId: input.runId,
    sourceManifestStatus: manifest.status,
    baseCommit,
    contractsHash,
    reviewedCommit,
    reviewEvidencePath: input.evidence.path,
    reviewEvidenceHash: input.evidence.hash,
    approvedBy: input.approvedBy,
    approvedAt,
    reason: input.reason,
  };
}

/** Minimal structural view of the Supervisor manifest fields read here. */
interface RunManifestLike {
  runId: string;
  repoRoot: string;
  contractsPath: string;
  contractsHash: string;
  baseCommit: string;
  status: string;
}

const RESOLUTION_KEYS = [
  "version",
  "kind",
  "queueItemId",
  "sourceRunId",
  "sourceManifestStatus",
  "baseCommit",
  "contractsHash",
  "reviewedCommit",
  "reviewEvidencePath",
  "reviewEvidenceHash",
  "approvedBy",
  "approvedAt",
  "reason",
] as const;

const RESOLUTION_IDENTITY_FIELDS: ReadonlyArray<keyof OperatorResolution> = [
  "version",
  "kind",
  "queueItemId",
  "sourceRunId",
  "sourceManifestStatus",
  "baseCommit",
  "contractsHash",
  "reviewedCommit",
  "reviewEvidencePath",
  "reviewEvidenceHash",
  "approvedBy",
  "reason",
];

function assertSameResolutionIdentity(
  existing: OperatorResolution,
  candidate: OperatorResolution,
): void {
  for (const field of RESOLUTION_IDENTITY_FIELDS) {
    if (existing[field] !== candidate[field]) {
      throw new QueueValidationError(
        `queue item ${JSON.stringify(existing.queueItemId)} is already ` +
          `adopted with a different ${field}; refusing to replace the ` +
          "existing OperatorResolution",
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Review evidence parsing
// ---------------------------------------------------------------------------

const REVIEW_EVIDENCE_KEYS = [
  "version",
  "reviewedAt",
  "reviewedCommit",
  "commands",
  "notes",
] as const;
const REVIEW_COMMAND_KEYS = [
  "command",
  "exitCode",
  "outputSha256",
  "notes",
] as const;

function readReviewEvidenceFile(
  repoRoot: string,
  evidencePath: string,
): ParsedReviewEvidence {
  if (typeof evidencePath !== "string" || !evidencePath.trim()) {
    throw new QueueValidationError("--evidence must be a non-empty path");
  }
  const absolutePath = isAbsolute(evidencePath)
    ? resolve(evidencePath)
    : resolve(repoRoot, evidencePath);
  if (absolutePath.length > MAX_REVIEW_EVIDENCE_PATH_LENGTH) {
    throw new QueueValidationError(
      `review evidence path exceeds ${MAX_REVIEW_EVIDENCE_PATH_LENGTH} ` +
        `characters: ${absolutePath}`,
    );
  }
  let bytes: Buffer;
  try {
    bytes = readFileSync(absolutePath);
  } catch (error) {
    throw new QueueValidationError(
      `review evidence file is missing or unreadable: ${absolutePath} ` +
        `(${errorMessage(error)})`,
    );
  }
  if (bytes.byteLength > MAX_REVIEW_EVIDENCE_BYTES) {
    throw new QueueValidationError(
      `review evidence exceeds the ${MAX_REVIEW_EVIDENCE_BYTES}-byte v1 ` +
        `bound: ${absolutePath}`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString("utf8")) as unknown;
  } catch (error) {
    throw new QueueValidationError(
      `review evidence is not valid JSON: ${absolutePath} ` +
        `(${errorMessage(error)})`,
    );
  }
  const evidence = parseReviewEvidence(parsed, absolutePath);
  return {
    path: absolutePath,
    bytes,
    hash: createHash("sha256").update(bytes).digest("hex"),
    evidence,
  };
}

/** Strict allow-list evidence schema; raw logs and unknown fields fail closed. */
export function parseReviewEvidence(
  raw: unknown,
  source = "review evidence",
): ReviewEvidence {
  if (!isRecord(raw)) {
    throw new QueueValidationError(`${source} must be a JSON object`);
  }
  assertOnlyKeys(raw, REVIEW_EVIDENCE_KEYS, source);
  if (raw.version !== REVIEW_EVIDENCE_VERSION) {
    throw new QueueValidationError(
      `${source} version must be ${REVIEW_EVIDENCE_VERSION} ` +
        `(got ${JSON.stringify(raw.version)})`,
    );
  }
  if (typeof raw.reviewedAt !== "string" || Number.isNaN(Date.parse(raw.reviewedAt))) {
    throw new QueueValidationError(
      `${source} reviewedAt must be an ISO-8601 timestamp`,
    );
  }
  let reviewedCommit: string | undefined;
  if (raw.reviewedCommit !== undefined) {
    const candidate =
      typeof raw.reviewedCommit === "string"
        ? raw.reviewedCommit.trim().toLowerCase()
        : "";
    if (!FULL_COMMIT_PATTERN.test(candidate)) {
      throw new QueueValidationError(
        `${source} reviewedCommit must be a full git commit hash ` +
          "(40 or 64 hex characters)",
      );
    }
    reviewedCommit = candidate;
  }
  if (
    !Array.isArray(raw.commands) ||
    raw.commands.length === 0 ||
    raw.commands.length > MAX_REVIEW_EVIDENCE_COMMANDS
  ) {
    throw new QueueValidationError(
      `${source} commands must be a non-empty array of at most ` +
        `${MAX_REVIEW_EVIDENCE_COMMANDS} entries`,
    );
  }

  const commands: ReviewEvidenceCommand[] = [];
  for (const [index, value] of raw.commands.entries()) {
    commands.push(
      parseReviewEvidenceCommand(value, `${source}.commands[${index}]`),
    );
  }
  if (!commands.some((command) => command.exitCode === 0)) {
    throw new QueueValidationError(
      `${source} must record at least one successful command (exitCode 0)`,
    );
  }
  const notes =
    raw.notes === undefined
      ? undefined
      : requireBoundedSecretFreeText(
          raw.notes,
          `${source}.notes`,
          MAX_REVIEW_NOTES_LENGTH,
        );

  return {
    version: REVIEW_EVIDENCE_VERSION,
    reviewedAt: raw.reviewedAt,
    ...(reviewedCommit !== undefined ? { reviewedCommit } : {}),
    commands,
    ...(notes !== undefined ? { notes } : {}),
  };
}

function parseReviewEvidenceCommand(
  raw: unknown,
  source: string,
): ReviewEvidenceCommand {
  if (!isRecord(raw)) {
    throw new QueueValidationError(`${source} must be an object`);
  }
  assertOnlyKeys(raw, REVIEW_COMMAND_KEYS, source);
  const command = requireBoundedSecretFreeText(
    raw.command,
    `${source}.command`,
    MAX_REVIEW_COMMAND_LENGTH,
  );
  if (
    !Number.isInteger(raw.exitCode) ||
    (raw.exitCode as number) < -255 ||
    (raw.exitCode as number) > 255
  ) {
    throw new QueueValidationError(
      `${source}.exitCode must be an integer from -255 to 255`,
    );
  }
  if (
    typeof raw.outputSha256 !== "string" ||
    !SHA256_PATTERN.test(raw.outputSha256.trim())
  ) {
    throw new QueueValidationError(
      `${source}.outputSha256 must be a hex SHA-256 digest`,
    );
  }
  const notes =
    raw.notes === undefined
      ? undefined
      : requireBoundedSecretFreeText(
          raw.notes,
          `${source}.notes`,
          MAX_REVIEW_NOTES_LENGTH,
        );
  return {
    command,
    exitCode: raw.exitCode as number,
    outputSha256: raw.outputSha256.trim().toLowerCase(),
    ...(notes !== undefined ? { notes } : {}),
  };
}

function assertOnlyKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  source: string,
): void {
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!allowedSet.has(key)) {
      throw new QueueValidationError(
        `${source} contains unsupported field ${JSON.stringify(key)}; ` +
          "raw logs, prompts and secrets are never accepted",
      );
    }
  }
}

/**
 * Reviewer-provided text is bounded and must not embed obvious credentials.
 * Output is never accepted, so this only guards summaries and command labels.
 */
function requireBoundedSecretFreeText(
  value: unknown,
  source: string,
  maxLength: number,
): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new QueueValidationError(`${source} must be a non-empty string`);
  }
  if (value.length > maxLength) {
    throw new QueueValidationError(
      `${source} exceeds the ${maxLength}-character v1 bound`,
    );
  }
  if (looksLikeSecret(value)) {
    throw new QueueValidationError(
      `${source} appears to contain a credential; review evidence must be ` +
        "secret-free",
    );
  }
  return value.trim();
}

function looksLikeSecret(value: string): boolean {
  return [
    /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/,
    /\bsk-[A-Za-z0-9_-]{16,}\b/,
    /\bsk_[A-Za-z0-9_-]{16,}\b/,
    /\bghp_[A-Za-z0-9]{20,}\b/,
    /\bgithub_pat_[A-Za-z0-9_]{20,}\b/,
    /\bAKIA[0-9A-Z]{16}\b/,
    /\bBearer\s+[A-Za-z0-9._-]{16,}/i,
    /\b(?:api[_-]?key|access[_-]?token|auth[_-]?token|token|passwd|password|secret)\b\s*[:=]\s*["']?[A-Za-z0-9._/+=-]{6,}/i,
  ].some((pattern) => pattern.test(value));
}

function requireRunId(value: string): string {
  if (typeof value !== "string" || !RUN_ID_PATTERN.test(value.trim())) {
    throw new QueueValidationError(
      `--run must be a valid run id (got ${JSON.stringify(value)})`,
    );
  }
  return value.trim();
}

function requireAdoptionText(
  value: string,
  label: string,
  maxLength: number,
): string {
  return requireBoundedSecretFreeText(value, label, maxLength);
}

// ---------------------------------------------------------------------------
// Git object proofs
// ---------------------------------------------------------------------------

function hashFileBytes(path: string, label: string): string {
  let bytes: Buffer;
  try {
    bytes = readFileSync(path);
  } catch (error) {
    throw new QueueValidationError(
      `${label} is missing or unreadable: ${path} (${errorMessage(error)})`,
    );
  }
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * Require a full object id and prove Git resolves it to that exact commit.
 * Abbreviated ids, branch names and symbolic revisions never pass.
 */
function resolveExactCommit(
  repoRoot: string,
  value: string,
  label: string,
): string {
  const candidate =
    typeof value === "string" ? value.trim().toLowerCase() : "";
  if (!FULL_COMMIT_PATTERN.test(candidate)) {
    throw new QueueValidationError(
      `${label} must be an exact full git commit hash ` +
        `(40 or 64 hex characters), got ${JSON.stringify(value)}`,
    );
  }
  const result = spawnSync(
    "git",
    ["rev-parse", "--verify", "--quiet", `${candidate}^{commit}`],
    { cwd: repoRoot, encoding: "utf8" },
  );
  if (result.error !== undefined || result.status !== 0) {
    throw new QueueValidationError(
      `cannot resolve ${label} ${JSON.stringify(candidate)} as a commit in ` +
        `${repoRoot}`,
    );
  }
  const resolved = result.stdout.trim().toLowerCase();
  if (resolved !== candidate) {
    throw new QueueValidationError(
      `${label} ${JSON.stringify(candidate)} did not resolve to the exact ` +
        `commit (got ${JSON.stringify(resolved)})`,
    );
  }
  return resolved;
}

function assertAncestorOrEqual(
  repoRoot: string,
  ancestor: string,
  descendant: string,
  message: string,
): void {
  const result = spawnSync(
    "git",
    ["merge-base", "--is-ancestor", ancestor, descendant],
    { cwd: repoRoot, encoding: "utf8" },
  );
  if (result.error !== undefined || result.status === null) {
    throw new QueueValidationError(
      `cannot prove Git ancestry of ${ancestor} in ${descendant}: ` +
        `${result.error?.message ?? "git did not run"}`,
    );
  }
  if (result.status === 1) {
    throw new QueueValidationError(message);
  }
  if (result.status !== 0) {
    throw new QueueValidationError(
      `cannot prove Git ancestry of ${ancestor} in ${descendant} ` +
        `(git exited ${result.status})`,
    );
  }
}

// ---------------------------------------------------------------------------
// Exclusive queue lock
// ---------------------------------------------------------------------------

export type QueueLockState = "free" | "held" | "stale" | "invalid";

export interface QueueLockInspection {
  state: QueueLockState;
  path: string;
  lock?: QueueLockInfo;
  reason?: string;
}

export interface QueueLockHandle {
  path: string;
  lock: QueueLockInfo;
  /** Idempotent; removes the lock only if this handle still owns it. */
  release(): void;
}

export function inspectQueueLock(repoRoot: string): QueueLockInspection {
  const path = queuePaths(repoRoot).lockPath;
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { state: "free", path };
    }
    return {
      state: "invalid",
      path,
      reason: `cannot read lock: ${errorMessage(error)}`,
    };
  }

  let lock: QueueLockInfo;
  try {
    lock = parseQueueLock(JSON.parse(raw) as unknown);
  } catch (error) {
    return {
      state: "invalid",
      path,
      reason: `invalid lock content: ${errorMessage(error)}`,
    };
  }

  if (!isSameHost(lock.host)) {
    return {
      state: "held",
      path,
      lock,
      reason: `lock owner is on ${lock.host}; liveness cannot be checked`,
    };
  }
  if (!isProcessAlive(lock.pid)) {
    return {
      state: "stale",
      path,
      lock,
      reason: `owner pid ${lock.pid} is not running`,
    };
  }
  return { state: "held", path, lock };
}

/**
 * Acquire the queue lock without waiting. Invalid, foreign-host and live
 * same-host locks fail closed. A stale same-host lock is reclaimed, but only
 * when its recorded token still matches what was inspected.
 */
export function acquireQueueLock(repoRoot: string): QueueLockHandle {
  const root = resolve(repoRoot);
  const { cliyardDir, lockPath } = queuePaths(root);
  mkdirSync(cliyardDir, { recursive: true });

  const info: QueueLockInfo = {
    pid: process.pid,
    host: hostname(),
    token: randomUUID(),
    acquiredAt: now(),
  };
  const content = JSON.stringify(info, null, 2) + "\n";

  // The loop handles two benign races: the owner released between O_EXCL and
  // inspection, or another process reclaimed the stale lock first.
  for (let attempt = 0; attempt < 5; attempt += 1) {
    let fd: number;
    try {
      fd = openSync(lockPath, "wx", 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        throw new QueueLockError(
          `cannot create queue lock ${lockPath}: ${errorMessage(error)}`,
        );
      }
      const inspection = inspectQueueLock(root);
      if (inspection.state === "free") continue;
      if (inspection.state === "stale") {
        reclaimStaleQueueLock(inspection);
        continue;
      }
      throw new QueueLockHeldError(
        inspection.path,
        inspection.lock,
        inspection.state === "invalid" ? "invalid" : "held",
        inspection.reason,
      );
    }

    try {
      writeFileSync(fd, content, "utf8");
      fsyncSync(fd);
    } catch (error) {
      try {
        closeSync(fd);
      } catch {
        /* ignore */
      }
      try {
        unlinkSync(lockPath);
      } catch {
        /* ignore */
      }
      throw new QueueLockError(
        `cannot write queue lock ${lockPath}: ${errorMessage(error)}`,
      );
    }
    closeSync(fd);

    let released = false;
    return {
      path: lockPath,
      lock: info,
      release() {
        if (released) return;
        released = true;
        try {
          if (readFileSync(lockPath, "utf8") === content) {
            unlinkSync(lockPath);
          }
        } catch {
          /* already released or replaced */
        }
      },
    };
  }
  throw new QueueLockError(
    `queue lock ${lockPath} changed while acquiring; try again`,
  );
}

export interface QueueLockWaitOptions {
  /** Total time to wait for a live same-host owner. Defaults to 5000 ms. */
  timeoutMs?: number;
  /** Poll interval while waiting. Defaults to 25 ms. */
  pollMs?: number;
}

/**
 * Acquire the queue lock, waiting for a live same-host owner to release it.
 * Foreign-host and invalid locks still fail immediately.
 */
export async function acquireQueueLockWithWait(
  repoRoot: string,
  options: QueueLockWaitOptions = {},
): Promise<QueueLockHandle> {
  const timeoutMs = options.timeoutMs ?? 5_000;
  const pollMs = options.pollMs ?? 25;
  const deadline = Date.now() + Math.max(0, timeoutMs);

  for (;;) {
    try {
      return acquireQueueLock(repoRoot);
    } catch (error) {
      if (!(error instanceof QueueLockHeldError) || error.state !== "held") {
        throw error;
      }
      // A remote owner can never become provably free on this host.
      if (!error.owner || !isSameHost(error.owner.host)) throw error;
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw error;
      await sleep(Math.min(pollMs, remaining));
    }
  }
}

export function withQueueLock<T>(
  repoRoot: string,
  fn: (lock: QueueLockHandle) => T,
): T;
export function withQueueLock<T>(
  repoRoot: string,
  fn: (lock: QueueLockHandle) => Promise<T>,
): Promise<T>;
export function withQueueLock<T>(
  repoRoot: string,
  fn: (lock: QueueLockHandle) => T | Promise<T>,
): T | Promise<T> {
  const lock = acquireQueueLock(repoRoot);
  try {
    const result = fn(lock);
    if (isPromiseLike(result)) {
      // Keep the lock until async work settles.
      return Promise.resolve(result).finally(() => lock.release());
    }
    lock.release();
    return result;
  } catch (error) {
    lock.release();
    throw error;
  }
}

export async function withQueueLockWait<T>(
  repoRoot: string,
  fn: (lock: QueueLockHandle) => T | Promise<T>,
  options: QueueLockWaitOptions = {},
): Promise<T> {
  const lock = await acquireQueueLockWithWait(repoRoot, options);
  try {
    return await fn(lock);
  } finally {
    lock.release();
  }
}

/** Remove a lock whose same-host owner is provably gone. */
export function clearStaleQueueLock(repoRoot: string): boolean {
  const inspection = inspectQueueLock(repoRoot);
  if (inspection.state !== "stale") return false;
  reclaimStaleQueueLock(inspection);
  return true;
}

function reclaimStaleQueueLock(inspection: QueueLockInspection): void {
  if (!inspection.lock) return;
  try {
    const raw = readFileSync(inspection.path, "utf8");
    const current = parseQueueLock(JSON.parse(raw) as unknown);
    if (current.token === inspection.lock.token) {
      unlinkSync(inspection.path);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    // Content changed or became unreadable: leave it for the next inspection.
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function requireQueueItem(
  document: QueueDocument,
  repoRoot: string,
  id: string,
): QueueItem {
  const item = document.items.find((candidate) => candidate.id === id);
  if (!item) {
    throw new QueueItemNotFoundError(
      id,
      queuePaths(repoRoot).queuePath,
    );
  }
  return item;
}

function assertSafeQueueId(value: string, label: string): void {
  if (typeof value !== "string" || !QUEUE_ID_PATTERN.test(value)) {
    throw new QueueValidationError(
      `invalid ${label}: ${JSON.stringify(value)} ` +
        "(use letters, digits, '.', '_' or '-', max 128 characters)",
    );
  }
}

interface ExecutionFreezeInput {
  worker?: QueueWorker;
  model?: string;
  executionProfilePath?: string;
  continuationPolicyPath?: string;
}

interface ExecutionFreeze {
  worker: QueueWorker;
  model: string;
  executionProfile: ExecutionProfile;
  continuationPolicy?: QueueContinuationPolicy;
}

/**
 * Normalize profile and policy files once, under the queue lock. The returned
 * objects contain only bounded values and opaque references; source paths are
 * intentionally absent from the durable item.
 */
function resolveExecutionFreeze(
  repoRoot: string,
  input: ExecutionFreezeInput,
): ExecutionFreeze {
  if (input.model !== undefined && !input.model.trim()) {
    throw new QueueValidationError("model must be a non-empty string");
  }
  let executionProfile: ExecutionProfile | undefined;
  if (input.executionProfilePath !== undefined) {
    const parsed = parseJsonFileAtAdd(
      repoRoot,
      input.executionProfilePath,
      "execution profile",
    );
    executionProfile = parseExecutionProfile(parsed);
    if (!executionProfile) {
      throw new QueueValidationError(
        "execution profile file is not a valid, secret-free v1 profile",
      );
    }
    if (
      input.worker !== undefined &&
      input.worker !== executionProfile.runtimeId
    ) {
      throw new QueueValidationError(
        `--worker ${input.worker} conflicts with execution profile ` +
          `runtimeId ${executionProfile.runtimeId}`,
      );
    }
    const requestedModel = optionalNonEmpty(input.model);
    if (
      requestedModel !== undefined &&
      requestedModel !== executionProfile.modelId
    ) {
      throw new QueueValidationError(
        `--model ${requestedModel} conflicts with execution profile ` +
          `modelId ${executionProfile.modelId}`,
      );
    }
  }

  let continuationPolicy: QueueContinuationPolicy | undefined;
  if (input.continuationPolicyPath !== undefined) {
    const parsed = parseJsonFileAtAdd(
      repoRoot,
      input.continuationPolicyPath,
      "continuation policy",
    );
    continuationPolicy = parseQueueContinuationPolicy(parsed);
    if (!continuationPolicy) {
      throw new QueueValidationError(
        "continuation policy file is not a valid, secret-free v1 policy",
      );
    }
  }

  const runtimeId: ExecutionRuntimeId = input.worker ?? "claude";
  validateWorkerInput(runtimeId);
  const profile =
    executionProfile ??
    createLegacyExecutionProfile({
      runtimeId,
      ...(optionalNonEmpty(input.model) !== undefined
        ? { modelId: optionalNonEmpty(input.model)! }
        : {}),
    });
  return {
    worker: profile.runtimeId,
    model: profile.modelId,
    executionProfile: profile,
    ...(continuationPolicy !== undefined ? { continuationPolicy } : {}),
  };
}

function parseJsonFileAtAdd(
  repoRoot: string,
  inputPath: string,
  label: string,
): unknown {
  if (typeof inputPath !== "string" || !inputPath.trim()) {
    throw new QueueValidationError(`${label} path must be non-empty`);
  }
  const path = isAbsolute(inputPath)
    ? resolve(inputPath)
    : resolve(repoRoot, inputPath);
  let bytes: Buffer;
  try {
    bytes = readFileSync(path);
  } catch (error) {
    throw new QueueValidationError(
      `${label} file is missing or unreadable: ${path} ` +
        `(${errorMessage(error)})`,
    );
  }
  if (bytes.byteLength > 64 * 1024) {
    throw new QueueValidationError(
      `${label} file exceeds the 64 KiB v1 bound: ${path}`,
    );
  }
  try {
    return JSON.parse(bytes.toString("utf8")) as unknown;
  } catch (error) {
    throw new QueueValidationError(
      `${label} file is not valid JSON: ${path} (${errorMessage(error)})`,
    );
  }
}

function validateWorkerInput(worker: QueueWorker): void {
  if (worker !== "claude" && worker !== "codex") {
    throw new QueueValidationError(
      `--worker must be claude or codex (got ${String(worker)})`,
    );
  }
}

function validateMaxAttemptsInput(maxAttempts: number): void {
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
    throw new QueueValidationError(
      `maxAttempts must be a positive integer (got ${String(maxAttempts)})`,
    );
  }
}

function sha256Hex(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Resolve the repository HEAD exactly once at queue-mutation time. */
function resolveRepositoryHead(repoRoot: string): string {
  const result = spawnSync("git", ["rev-parse", "--verify", "HEAD^{commit}"], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  if (result.error !== undefined || result.status !== 0) {
    const detail =
      result.error?.message ||
      (result.stderr || result.stdout).trim() ||
      `git exited ${result.status}`;
    throw new QueueValidationError(
      `cannot resolve repository HEAD in ${repoRoot}: ${detail}`,
    );
  }
  const head = result.stdout.trim().toLowerCase();
  if (!FULL_COMMIT_PATTERN.test(head)) {
    throw new QueueValidationError(
      `repository HEAD did not resolve to a full commit hash: ` +
        JSON.stringify(result.stdout.trim()),
    );
  }
  return head;
}

function optionalNonEmpty(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function now(): string {
  return new Date().toISOString();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPromiseLike<T>(value: T | Promise<T>): value is Promise<T> {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { then?: unknown }).then === "function"
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function parseQueueLock(raw: unknown): QueueLockInfo {
  if (
    !isRecord(raw) ||
    !Number.isInteger(raw.pid) ||
    (raw.pid as number) <= 0 ||
    typeof raw.host !== "string" ||
    !raw.host.trim() ||
    typeof raw.token !== "string" ||
    !raw.token.trim() ||
    typeof raw.acquiredAt !== "string" ||
    !raw.acquiredAt.trim()
  ) {
    throw new QueueLockError(
      "lock must be { pid, host, token, acquiredAt }",
    );
  }
  return {
    pid: raw.pid as number,
    host: raw.host,
    token: raw.token,
    acquiredAt: raw.acquiredAt,
  };
}

function parseQueueDocument(
  raw: unknown,
  source: string,
  repoRoot: string,
): QueueDocument {
  if (!isRecord(raw)) {
    throw new QueueValidationError(`${source}: queue must be an object`);
  }
  if (raw.version !== QUEUE_VERSION) {
    throw new QueueValidationError(
      `${source}: unsupported queue version ${JSON.stringify(raw.version)} ` +
        `(expected ${QUEUE_VERSION})`,
    );
  }
  if (typeof raw.updatedAt !== "string" || !raw.updatedAt.trim()) {
    throw new QueueValidationError(
      `${source}: updatedAt must be a non-empty string`,
    );
  }
  if (!Array.isArray(raw.items)) {
    throw new QueueValidationError(`${source}: items must be an array`);
  }

  const items: QueueItem[] = [];
  const ids = new Set<string>();
  for (const [index, value] of raw.items.entries()) {
    const item = parseQueueItem(
      value,
      `${source}: items[${index}]`,
      repoRoot,
    );
    if (ids.has(item.id)) {
      throw new QueueValidationError(
        `${source}: duplicate queue id ${JSON.stringify(item.id)}`,
      );
    }
    ids.add(item.id);
    items.push(item);
  }
  assertQueueGraph(items, source);
  return { version: QUEUE_VERSION, updatedAt: raw.updatedAt, items };
}

function parseQueueItem(
  raw: unknown,
  source: string,
  repoRoot: string,
): QueueItem {
  if (!isRecord(raw)) {
    throw new QueueValidationError(`${source}: item must be an object`);
  }
  if (typeof raw.id !== "string" || !QUEUE_ID_PATTERN.test(raw.id)) {
    throw new QueueValidationError(
      `${source}: invalid queue id ${JSON.stringify(raw.id)}`,
    );
  }

  // `planPath` presence is the only source discriminator. Legacy
  // contract-backed items never define it.
  const planBacked = raw.planPath !== undefined;
  let contractsPath: string | undefined;
  let contractsHash: string | undefined;
  let planPath: string | undefined;
  let planHash: string | undefined;
  let planId: string | undefined;
  let planBaseCommit: string | undefined;

  if (planBacked) {
    if (typeof raw.planPath !== "string" || !raw.planPath.trim()) {
      throw new QueueValidationError(
        `${source}: planPath must be a non-empty string`,
      );
    }
    if (raw.contractsPath !== undefined || raw.contractsHash !== undefined) {
      throw new QueueValidationError(
        `${source}: plan-backed item must not define a top-level contracts identity`,
      );
    }
    planPath = raw.planPath;
    if (
      typeof raw.planHash !== "string" ||
      !SHA256_PATTERN.test(raw.planHash)
    ) {
      throw new QueueValidationError(
        `${source}: planHash must be a hex SHA-256 digest`,
      );
    }
    planHash = raw.planHash;
    if (typeof raw.planId !== "string" || !QUEUE_ID_PATTERN.test(raw.planId)) {
      throw new QueueValidationError(
        `${source}: planId must be a safe queue id for a plan-backed item`,
      );
    }
    if (raw.planId !== raw.id) {
      throw new QueueValidationError(
        `${source}: planId ${JSON.stringify(raw.planId)} must equal queue id ` +
          `${JSON.stringify(raw.id)}`,
      );
    }
    planId = raw.planId;
    if (raw.planBaseCommit !== undefined) {
      if (
        typeof raw.planBaseCommit !== "string" ||
        !FULL_COMMIT_PATTERN.test(raw.planBaseCommit)
      ) {
        throw new QueueValidationError(
          `${source}: planBaseCommit must be a full git commit hash ` +
            "(40 or 64 hex characters)",
        );
      }
      planBaseCommit = raw.planBaseCommit;
    }
  } else {
    for (const field of [
      "planHash",
      "planBaseCommit",
      "materialization",
    ] as const) {
      if (raw[field] !== undefined) {
        throw new QueueValidationError(
          `${source}: ${field} requires planPath (plan-backed items only)`,
        );
      }
    }
    if (typeof raw.contractsPath !== "string" || !raw.contractsPath.trim()) {
      throw new QueueValidationError(
        `${source}: contractsPath must be a non-empty string`,
      );
    }
    if (
      typeof raw.contractsHash !== "string" ||
      !SHA256_PATTERN.test(raw.contractsHash)
    ) {
      throw new QueueValidationError(
        `${source}: contractsHash must be a hex SHA-256 digest`,
      );
    }
    contractsPath = raw.contractsPath;
    contractsHash = raw.contractsHash;
    if (raw.planId !== undefined && typeof raw.planId !== "string") {
      throw new QueueValidationError(`${source}: planId must be a string`);
    }
    planId = raw.planId as string | undefined;
  }

  if (raw.worker !== "claude" && raw.worker !== "codex") {
    throw new QueueValidationError(
      `${source}: worker must be claude or codex`,
    );
  }
  if (raw.status === undefined || !QUEUE_STATUSES.includes(raw.status as QueueItemStatus)) {
    throw new QueueValidationError(
      `${source}: invalid status ${JSON.stringify(raw.status)}`,
    );
  }
  if (raw.nextAction !== "start" && raw.nextAction !== "resume") {
    throw new QueueValidationError(
      `${source}: nextAction must be start or resume`,
    );
  }
  if (
    !Array.isArray(raw.dependsOn) ||
    raw.dependsOn.some((dependency) => typeof dependency !== "string")
  ) {
    throw new QueueValidationError(
      `${source}: dependsOn must be a string array`,
    );
  }
  if (
    !Number.isInteger(raw.attempts) ||
    (raw.attempts as number) < 0
  ) {
    throw new QueueValidationError(
      `${source}: attempts must be a non-negative integer`,
    );
  }
  if (
    !Number.isInteger(raw.maxAttempts) ||
    (raw.maxAttempts as number) < 1
  ) {
    throw new QueueValidationError(
      `${source}: maxAttempts must be a positive integer`,
    );
  }
  if (
    !Array.isArray(raw.runIds) ||
    raw.runIds.some((runId) => typeof runId !== "string")
  ) {
    throw new QueueValidationError(`${source}: runIds must be a string array`);
  }
  for (const field of ["createdAt", "updatedAt"] as const) {
    if (typeof raw[field] !== "string" || !raw[field].trim()) {
      throw new QueueValidationError(
        `${source}: ${field} must be a non-empty string`,
      );
    }
  }
  for (const field of ["lastRunId", "reason", "model"] as const) {
    if (raw[field] !== undefined && typeof raw[field] !== "string") {
      throw new QueueValidationError(
        `${source}: ${field} must be a string`,
      );
    }
  }
  let executionProfile: ExecutionProfile | undefined;
  if (raw.executionProfile !== undefined) {
    executionProfile = parseExecutionProfile(raw.executionProfile);
    if (!executionProfile) {
      throw new QueueValidationError(
        `${source}: executionProfile is not a valid, secret-free v1 profile`,
      );
    }
  }
  let continuationPolicy: QueueContinuationPolicy | undefined;
  if (raw.continuationPolicy !== undefined) {
    continuationPolicy = parseQueueContinuationPolicy(
      raw.continuationPolicy,
    );
    if (!continuationPolicy) {
      throw new QueueValidationError(
        `${source}: continuationPolicy is not a valid, secret-free v1 policy`,
      );
    }
  }
  if (continuationPolicy !== undefined && executionProfile === undefined) {
    throw new QueueValidationError(
      `${source}: continuationPolicy requires an executionProfile`,
    );
  }
  const mirrorReason = executionProfileMirrorReason(
    executionProfile,
    raw.worker,
    raw.model as string | undefined,
  );
  if (mirrorReason !== undefined) {
    throw new QueueValidationError(`${source}: ${mirrorReason}`);
  }
  // Optional for legacy items; when present the record must validate fully.
  let failure: FailureRecord | undefined;
  if (raw.failure !== undefined) {
    const parsed = parseFailureRecord(raw.failure);
    if (!parsed) {
      throw new QueueValidationError(
        `${source}: failure is not a valid failure record`,
      );
    }
    failure = parsed;
  }

  const dependsOn = uniqueStrings(raw.dependsOn as string[]);
  const runIds = uniqueStrings(raw.runIds as string[]);
  let resolution: OperatorResolution | undefined;
  if (raw.resolution !== undefined) {
    resolution = parseOperatorResolution(
      raw.resolution,
      `${source}.resolution`,
      raw.id,
      raw.lastRunId as string | undefined,
    );
    if (raw.status !== "completed") {
      throw new QueueValidationError(
        `${source}: resolution requires a completed queue item (got ` +
          `${JSON.stringify(raw.status)})`,
      );
    }
  }

  if (planBacked) {
    if (dependsOn.length === 0) {
      if (planBaseCommit === undefined) {
        throw new QueueValidationError(
          `${source}: root plan-backed item requires planBaseCommit`,
        );
      }
    } else if (dependsOn.length === 1) {
      if (planBaseCommit !== undefined) {
        throw new QueueValidationError(
          `${source}: dependent plan-backed item must not define ` +
            "planBaseCommit",
        );
      }
    } else {
      throw new QueueValidationError(
        `${source}: plan-backed item supports at most one dependency`,
      );
    }

    const materialization =
      raw.materialization === undefined
        ? undefined
        : parsePlanMaterialization(
            raw.materialization,
            `${source}.materialization`,
            {
              repoRoot,
              id: raw.id,
              planPath: planPath as string,
              planHash: planHash as string,
              planId: planId as string,
              ...(planBaseCommit !== undefined ? { planBaseCommit } : {}),
              dependsOn,
            },
          );

    return {
      id: raw.id,
      planPath: planPath as string,
      planHash: planHash as string,
      planId: planId as string,
      ...(planBaseCommit !== undefined ? { planBaseCommit } : {}),
      ...(materialization !== undefined ? { materialization } : {}),
      worker: executionProfile?.runtimeId ?? raw.worker,
      ...(executionProfile !== undefined
        ? {
            model: executionProfile.modelId,
            executionProfile,
          }
        : {
            ...(raw.model !== undefined
              ? { model: raw.model as string }
              : {}),
          }),
      ...(continuationPolicy !== undefined ? { continuationPolicy } : {}),
      dependsOn,
      status: raw.status as QueueItemStatus,
      attempts: raw.attempts as number,
      maxAttempts: raw.maxAttempts as number,
      runIds,
      ...(raw.lastRunId !== undefined
        ? { lastRunId: raw.lastRunId as string }
        : {}),
      nextAction: raw.nextAction,
      createdAt: raw.createdAt as string,
      updatedAt: raw.updatedAt as string,
      ...(raw.reason !== undefined ? { reason: raw.reason as string } : {}),
      ...(failure !== undefined ? { failure } : {}),
      ...(resolution !== undefined ? { resolution } : {}),
    };
  }

  return {
    id: raw.id,
    contractsPath: contractsPath as string,
    contractsHash: contractsHash as string,
    ...(planId !== undefined ? { planId } : {}),
    worker: executionProfile?.runtimeId ?? raw.worker,
    ...(executionProfile !== undefined
      ? {
          model: executionProfile.modelId,
          executionProfile,
        }
      : {
          ...(raw.model !== undefined
            ? { model: raw.model as string }
            : {}),
        }),
    ...(continuationPolicy !== undefined ? { continuationPolicy } : {}),
    dependsOn,
    status: raw.status as QueueItemStatus,
    attempts: raw.attempts as number,
    maxAttempts: raw.maxAttempts as number,
    runIds,
    ...(raw.lastRunId !== undefined
      ? { lastRunId: raw.lastRunId as string }
      : {}),
    nextAction: raw.nextAction,
    createdAt: raw.createdAt as string,
    updatedAt: raw.updatedAt as string,
    ...(raw.reason !== undefined ? { reason: raw.reason as string } : {}),
    ...(failure !== undefined ? { failure } : {}),
    ...(resolution !== undefined ? { resolution } : {}),
  };
}

function parseOperatorResolution(
  raw: unknown,
  source: string,
  itemId: string,
  lastRunId: string | undefined,
): OperatorResolution {
  if (!isRecord(raw)) {
    throw new QueueValidationError(`${source} must be an object`);
  }
  assertOnlyKeys(raw, RESOLUTION_KEYS, source);
  if (raw.version !== OPERATOR_RESOLUTION_VERSION) {
    throw new QueueValidationError(
      `${source}.version must be ${OPERATOR_RESOLUTION_VERSION}`,
    );
  }
  if (raw.kind !== "manual-adoption") {
    throw new QueueValidationError(
      `${source}.kind must be "manual-adoption"`,
    );
  }
  if (raw.queueItemId !== itemId) {
    throw new QueueValidationError(
      `${source}.queueItemId must equal the queue item id ${JSON.stringify(itemId)}`,
    );
  }
  if (
    typeof raw.sourceRunId !== "string" ||
    !RUN_ID_PATTERN.test(raw.sourceRunId)
  ) {
    throw new QueueValidationError(`${source}.sourceRunId is not a valid run id`);
  }
  if (lastRunId === undefined) {
    throw new QueueValidationError(
      `${source} requires the queue item lastRunId`,
    );
  }
  if (raw.sourceRunId !== lastRunId) {
    throw new QueueValidationError(
      `${source}.sourceRunId must equal the item lastRunId`,
    );
  }
  if (
    raw.sourceManifestStatus !== "blocked" &&
    raw.sourceManifestStatus !== "interrupted"
  ) {
    throw new QueueValidationError(
      `${source}.sourceManifestStatus must be blocked or interrupted`,
    );
  }
  for (const field of ["baseCommit", "reviewedCommit"] as const) {
    if (
      typeof raw[field] !== "string" ||
      !FULL_COMMIT_PATTERN.test(raw[field] as string)
    ) {
      throw new QueueValidationError(
        `${source}.${field} must be a full git commit hash ` +
          "(40 or 64 hex characters)",
      );
    }
  }
  for (const field of ["contractsHash", "reviewEvidenceHash"] as const) {
    if (
      typeof raw[field] !== "string" ||
      !SHA256_PATTERN.test(raw[field] as string)
    ) {
      throw new QueueValidationError(
        `${source}.${field} must be a hex SHA-256 digest`,
      );
    }
  }
  if (
    typeof raw.reviewEvidencePath !== "string" ||
    !raw.reviewEvidencePath.trim() ||
    raw.reviewEvidencePath.length > MAX_REVIEW_EVIDENCE_PATH_LENGTH
  ) {
    throw new QueueValidationError(
      `${source}.reviewEvidencePath must be a bounded non-empty path`,
    );
  }
  if (typeof raw.approvedAt !== "string" || Number.isNaN(Date.parse(raw.approvedAt))) {
    throw new QueueValidationError(
      `${source}.approvedAt must be an ISO-8601 timestamp`,
    );
  }
  const approvedBy = requireBoundedSecretFreeText(
    raw.approvedBy,
    `${source}.approvedBy`,
    MAX_APPROVED_BY_LENGTH,
  );
  const reason = requireBoundedSecretFreeText(
    raw.reason,
    `${source}.reason`,
    MAX_ADOPTION_REASON_LENGTH,
  );
  return {
    version: OPERATOR_RESOLUTION_VERSION,
    kind: "manual-adoption",
    queueItemId: itemId,
    sourceRunId: raw.sourceRunId,
    sourceManifestStatus: raw.sourceManifestStatus,
    baseCommit: (raw.baseCommit as string).toLowerCase(),
    contractsHash: (raw.contractsHash as string).toLowerCase(),
    reviewedCommit: (raw.reviewedCommit as string).toLowerCase(),
    reviewEvidencePath: raw.reviewEvidencePath,
    reviewEvidenceHash: (raw.reviewEvidenceHash as string).toLowerCase(),
    approvedBy,
    approvedAt: raw.approvedAt,
    reason,
  };
}

interface PlanMaterializationItemContext {
  repoRoot: string;
  id: string;
  planPath: string;
  planHash: string;
  planId: string;
  planBaseCommit?: string;
  dependsOn: string[];
}

function parsePlanMaterialization(
  raw: unknown,
  source: string,
  item: PlanMaterializationItemContext,
): QueuePlanMaterialization {
  if (!isRecord(raw)) {
    throw new QueueValidationError(
      `${source}: materialization must be an object`,
    );
  }

  const planPath = requireNonEmptyField(raw.planPath, `${source}.planPath`);
  if (resolve(planPath) !== resolve(item.planPath)) {
    throw new QueueValidationError(
      `${source}.planPath must match the item planPath ${item.planPath}`,
    );
  }
  const planHash = requireNonEmptyField(raw.planHash, `${source}.planHash`);
  if (!SHA256_PATTERN.test(planHash)) {
    throw new QueueValidationError(
      `${source}.planHash must be a hex SHA-256 digest`,
    );
  }
  if (planHash.toLowerCase() !== item.planHash.toLowerCase()) {
    throw new QueueValidationError(
      `${source}.planHash must match the item planHash`,
    );
  }
  const planId = requireNonEmptyField(raw.planId, `${source}.planId`);
  if (planId !== item.planId) {
    throw new QueueValidationError(
      `${source}.planId must match the item planId ${item.planId}`,
    );
  }
  const baseCommit = requireNonEmptyField(
    raw.baseCommit,
    `${source}.baseCommit`,
  );
  if (!FULL_COMMIT_PATTERN.test(baseCommit)) {
    throw new QueueValidationError(
      `${source}.baseCommit must be a full git commit hash`,
    );
  }
  const contractsPath = requireNonEmptyField(
    raw.contractsPath,
    `${source}.contractsPath`,
  );
  const contractsHash = requireNonEmptyField(
    raw.contractsHash,
    `${source}.contractsHash`,
  );
  if (!SHA256_PATTERN.test(contractsHash)) {
    throw new QueueValidationError(
      `${source}.contractsHash must be a hex SHA-256 digest`,
    );
  }
  const materializedAt = requireNonEmptyField(
    raw.materializedAt,
    `${source}.materializedAt`,
  );

  const upstreamQueueId = optionalStringField(
    raw.upstreamQueueId,
    `${source}.upstreamQueueId`,
  );
  const upstreamRunId = optionalStringField(
    raw.upstreamRunId,
    `${source}.upstreamRunId`,
  );
  const upstreamIntegrationHead = optionalStringField(
    raw.upstreamIntegrationHead,
    `${source}.upstreamIntegrationHead`,
  );
  const upstreamAdoptedCommit = optionalStringField(
    raw.upstreamAdoptedCommit,
    `${source}.upstreamAdoptedCommit`,
  );
  if (
    upstreamAdoptedCommit !== undefined &&
    !FULL_COMMIT_PATTERN.test(upstreamAdoptedCommit)
  ) {
    throw new QueueValidationError(
      `${source}.upstreamAdoptedCommit must be a full git commit hash`,
    );
  }

  if (item.dependsOn.length === 0) {
    if (
      item.planBaseCommit === undefined ||
      baseCommit.toLowerCase() !== item.planBaseCommit.toLowerCase()
    ) {
      throw new QueueValidationError(
        `${source}.baseCommit must equal the root planBaseCommit`,
      );
    }
    if (
      upstreamQueueId !== undefined ||
      upstreamRunId !== undefined ||
      upstreamIntegrationHead !== undefined ||
      upstreamAdoptedCommit !== undefined
    ) {
      throw new QueueValidationError(
        `${source}: root materialization must not record upstream lineage`,
      );
    }
  } else {
    const dependency = item.dependsOn[0]!;
    if (upstreamQueueId !== dependency) {
      throw new QueueValidationError(
        `${source}.upstreamQueueId must equal the item dependency ` +
          JSON.stringify(dependency),
      );
    }
    if (upstreamRunId === undefined) {
      throw new QueueValidationError(
        `${source}.upstreamRunId is required for a dependent item`,
      );
    }
    if (upstreamIntegrationHead !== undefined) {
      if (!FULL_COMMIT_PATTERN.test(upstreamIntegrationHead)) {
        throw new QueueValidationError(
          `${source}.upstreamIntegrationHead must be a full git commit hash`,
        );
      }
    }
    if (upstreamAdoptedCommit !== undefined) {
      // Explicit adopted lineage: the base is an optional usable integration
      // head that contains the reviewed commit, else the reviewed commit.
      if (upstreamIntegrationHead !== undefined) {
        if (
          upstreamIntegrationHead.toLowerCase() !== baseCommit.toLowerCase()
        ) {
          throw new QueueValidationError(
            `${source}.baseCommit must equal upstreamIntegrationHead`,
          );
        }
      } else if (
        upstreamAdoptedCommit.toLowerCase() !== baseCommit.toLowerCase()
      ) {
        throw new QueueValidationError(
          `${source}.baseCommit must equal upstreamAdoptedCommit`,
        );
      }
    } else {
      if (upstreamIntegrationHead === undefined) {
        throw new QueueValidationError(
          `${source}.upstreamIntegrationHead is required for a dependent item`,
        );
      }
      if (
        upstreamIntegrationHead.toLowerCase() !== baseCommit.toLowerCase()
      ) {
        throw new QueueValidationError(
          `${source}.baseCommit must equal upstreamIntegrationHead`,
        );
      }
    }
  }

  let expectedContractsPath: string;
  try {
    expectedContractsPath = materializedContractsPath(
      item.repoRoot,
      item.id,
      baseCommit,
      item.planHash,
    );
  } catch (error) {
    throw new QueueValidationError(
      `${source}: invalid queue id for materialization: ${errorMessage(error)}`,
    );
  }
  if (resolve(contractsPath) !== resolve(expectedContractsPath)) {
    throw new QueueValidationError(
      `${source}.contractsPath must be the deterministic artifact path ` +
        expectedContractsPath,
    );
  }

  return {
    planPath,
    planHash,
    planId,
    baseCommit,
    ...(upstreamQueueId !== undefined ? { upstreamQueueId } : {}),
    ...(upstreamRunId !== undefined ? { upstreamRunId } : {}),
    ...(upstreamIntegrationHead !== undefined
      ? { upstreamIntegrationHead }
      : {}),
    ...(upstreamAdoptedCommit !== undefined
      ? { upstreamAdoptedCommit: upstreamAdoptedCommit.toLowerCase() }
      : {}),
    contractsPath,
    contractsHash,
    materializedAt,
  };
}

function requireNonEmptyField(value: unknown, source: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new QueueValidationError(`${source} must be a non-empty string`);
  }
  return value;
}

function optionalStringField(
  value: unknown,
  source: string,
): string | undefined {
  if (value === undefined) return undefined;
  return requireNonEmptyField(value, source);
}

const QUEUE_STATUSES: readonly QueueItemStatus[] = [
  "pending",
  "running",
  "completed",
  "blocked",
  "cancelled",
];

function assertQueueGraph(items: QueueItem[], source: string): void {
  const ids = new Set(items.map((item) => item.id));
  for (const item of items) {
    for (const dependency of item.dependsOn) {
      if (!ids.has(dependency)) {
        throw new QueueValidationError(
          `${source}: queue item ${JSON.stringify(item.id)} depends on ` +
            `unknown item ${JSON.stringify(dependency)}`,
        );
      }
    }
  }
  const cycle = findCycle(
    items.map((item) => ({ id: item.id, dependsOn: item.dependsOn })),
  );
  if (!cycle.ok) {
    throw new QueueValidationError(
      `${source}: dependency cycle: ${cycle.cycle.join(" -> ")}`,
    );
  }
}

/** Write JSON through a same-directory temp file, then rename atomically. */
function writeJsonAtomic(path: string, value: unknown): void {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true });
  const tmp = join(
    dir,
    `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`,
  );
  try {
    const fd = openSync(tmp, "wx", 0o600);
    try {
      writeFileSync(fd, JSON.stringify(value, null, 2) + "\n", "utf8");
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
    throw error;
  }
}

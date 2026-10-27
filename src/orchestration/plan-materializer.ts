/**
 * Deterministic Plan → queue-owned contracts materialization
 * (design/plan-backed-chain-v0.md).
 *
 * The approved Plan remains human authority. This module only proves that:
 *   - the Plan bytes still match the frozen SHA-256;
 *   - the base comes from a pinned root commit or a completed upstream run;
 *   - the compiled contracts for that exact (base, Plan) pair are byte-stable.
 *
 * It never persists queue state, starts the Supervisor, creates worktrees or
 * dispatches work. It never infers a base from the active run pointer, current
 * HEAD, a branch name, or a worker commit that no completed RunManifest has
 * accepted.
 */
import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  closeSync,
  fsyncSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import type { TaskContract } from "../contracts/schema.js";
import { compilePlan, parsePlanJson } from "../planner/plan.js";
import { loadRunManifest } from "../supervisor/store.js";
import type { RunManifest } from "../supervisor/types.js";
import type { QueueItemStatus } from "./queue-store.js";

export const MATERIALIZED_QUEUE_DIR = join(
  ".cliyard",
  "queue",
  "materialized",
);

/** Queue ids are explicit labels and must be safe path segments. */
const QUEUE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/i;
/** Exact full git object id: SHA-1 (40) or SHA-256 (64) repositories. */
const FULL_COMMIT_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Frozen upstream evidence copied from the completed queue item. The
 * RunManifest loaded from `lastRunId` must agree with every field.
 */
export interface PlanUpstreamEvidence {
  queueId: string;
  status: QueueItemStatus;
  lastRunId?: string;
  contractsPath: string;
  contractsHash: string;
}

export interface MaterializePlanInput {
  repoRoot: string;
  queueId: string;
  planPath: string;
  /** Frozen SHA-256 of the exact Plan file bytes. */
  planHash: string;
  /** Plan id the queue item expects the Plan to declare. */
  planId: string;
  /** Pinned base for a root item. Exactly one of this and `upstream`. */
  rootBaseCommit?: string;
  /** Completed upstream lineage for a dependent item. */
  upstream?: PlanUpstreamEvidence;
  /** Recorded in returned metadata only; never written into the artifact. */
  materializedAt: string;
}

/** Provenance embedded in the queue-owned contracts artifact. */
export interface PlanMaterializationProvenance {
  queueId: string;
  planPath: string;
  planHash: string;
  planId: string;
  baseCommit: string;
  upstreamQueueId?: string;
  upstreamRunId?: string;
  upstreamIntegrationHead?: string;
}

/** Exact artifact document: no timestamp or other volatile fields. */
export interface MaterializedPlanContracts {
  planId: string;
  contracts: TaskContract[];
  provenance: PlanMaterializationProvenance;
}

/**
 * Queue metadata for one Plan-backed item, matching
 * `QueuePlanMaterialization` in design/plan-backed-chain-v0.md.
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
}

export class PlanMaterializationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PlanMaterializationError";
  }
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

/**
 * `<repo>/.cliyard/queue/materialized/<queue-id>/<base>-<plan-hash>.contracts.json`
 *
 * `baseCommit` and `planHash` are normalized to lowercase hex so the file name
 * is deterministic for the same lineage.
 */
export function materializedContractsPath(
  repoRoot: string,
  queueId: string,
  baseCommit: string,
  planHash: string,
): string {
  assertSafeQueueId(queueId, "queue id");
  return join(
    resolve(repoRoot),
    MATERIALIZED_QUEUE_DIR,
    queueId,
    `${baseCommit.toLowerCase()}-${planHash.toLowerCase()}.contracts.json`,
  );
}

// ---------------------------------------------------------------------------
// Materialization
// ---------------------------------------------------------------------------

/**
 * Verify the approved Plan, select the exact base, compile every Plan task,
 * and atomically create or byte-verify the queue-owned contracts artifact.
 */
export function materializePlan(
  input: MaterializePlanInput,
): QueuePlanMaterialization {
  if (input === null || typeof input !== "object") {
    throw new PlanMaterializationError("materialization input must be an object");
  }

  const repoRoot = requireNonEmpty(input.repoRoot, "repoRoot");
  const queueId = requireNonEmpty(input.queueId, "queueId");
  assertSafeQueueId(queueId, "queue id");
  const planId = requireNonEmpty(input.planId, "planId");
  const planHash = normalizeSha256(input.planHash, "planHash");
  const materializedAt = requireNonEmpty(
    input.materializedAt,
    "materializedAt",
  );

  const hasRoot = input.rootBaseCommit !== undefined;
  const hasUpstream = input.upstream !== undefined;
  if (hasRoot === hasUpstream) {
    throw new PlanMaterializationError(
      "exactly one of rootBaseCommit or upstream evidence is required",
    );
  }

  const resolvedRoot = resolve(repoRoot);
  const planText = readPlanOnce(input.planPath, resolvedRoot, planHash);

  const selection = hasRoot
    ? selectRootBase(resolvedRoot, input.rootBaseCommit as string)
    : selectUpstreamBase(resolvedRoot, input.upstream as PlanUpstreamEvidence);

  const compiled = compileVerifiedPlan(planText, planId, selection.baseCommit);

  const provenance: PlanMaterializationProvenance = {
    queueId,
    planPath: planText.absolutePath,
    planHash,
    planId: compiled.planId,
    baseCommit: selection.baseCommit,
    ...(selection.upstreamQueueId !== undefined
      ? { upstreamQueueId: selection.upstreamQueueId }
      : {}),
    ...(selection.upstreamRunId !== undefined
      ? { upstreamRunId: selection.upstreamRunId }
      : {}),
    ...(selection.upstreamIntegrationHead !== undefined
      ? { upstreamIntegrationHead: selection.upstreamIntegrationHead }
      : {}),
  };
  const artifact: MaterializedPlanContracts = {
    planId: compiled.planId,
    contracts: compiled.contracts,
    provenance,
  };

  const contractsPath = materializedContractsPath(
    resolvedRoot,
    queueId,
    selection.baseCommit,
    planHash,
  );
  const expectedBytes = Buffer.from(
    `${JSON.stringify(artifact, null, 2)}\n`,
    "utf8",
  );
  const artifactBytes = writeOrVerifyArtifact(contractsPath, expectedBytes);

  return {
    planPath: planText.absolutePath,
    planHash,
    planId: compiled.planId,
    baseCommit: selection.baseCommit,
    ...(selection.upstreamQueueId !== undefined
      ? { upstreamQueueId: selection.upstreamQueueId }
      : {}),
    ...(selection.upstreamRunId !== undefined
      ? { upstreamRunId: selection.upstreamRunId }
      : {}),
    ...(selection.upstreamIntegrationHead !== undefined
      ? { upstreamIntegrationHead: selection.upstreamIntegrationHead }
      : {}),
    contractsPath,
    contractsHash: sha256(artifactBytes),
    materializedAt,
  };
}

// ---------------------------------------------------------------------------
// Plan verification
// ---------------------------------------------------------------------------

interface VerifiedPlan {
  absolutePath: string;
  text: string;
}

/** Read the Plan exactly once; the hash covers the same bytes we parse. */
function readPlanOnce(
  planPathInput: string,
  repoRoot: string,
  expectedHash: string,
): VerifiedPlan {
  const rawPath = requireNonEmpty(planPathInput, "planPath");
  const absolutePath = isAbsolute(rawPath)
    ? resolve(rawPath)
    : resolve(repoRoot, rawPath);

  let bytes: Buffer;
  try {
    bytes = readFileSync(absolutePath);
  } catch (error) {
    throw new PlanMaterializationError(
      `Plan file is missing or unreadable: ${absolutePath} ` +
        `(${errorMessage(error)})`,
    );
  }

  const actualHash = sha256(bytes);
  if (actualHash !== expectedHash) {
    throw new PlanMaterializationError(
      `Plan hash mismatch for ${absolutePath}: ` +
        `expected sha256 ${expectedHash}, found ${actualHash}`,
    );
  }
  return { absolutePath, text: bytes.toString("utf8") };
}

function compileVerifiedPlan(
  planText: VerifiedPlan,
  expectedPlanId: string,
  baseCommit: string,
): { planId: string; contracts: TaskContract[] } {
  let parsed: unknown;
  try {
    parsed = parsePlanJson(planText.text);
  } catch (error) {
    throw new PlanMaterializationError(
      `cannot parse Plan ${planText.absolutePath}: ${errorMessage(error)}`,
    );
  }

  let compiled: ReturnType<typeof compilePlan>;
  try {
    compiled = compilePlan(parsed, { baseCommit });
  } catch (error) {
    throw new PlanMaterializationError(
      `invalid Plan ${planText.absolutePath}: ${errorMessage(error)}`,
    );
  }

  if (compiled.planId !== expectedPlanId) {
    throw new PlanMaterializationError(
      `Plan id mismatch: Plan declares ${JSON.stringify(compiled.planId)}, ` +
        `queue item expects ${JSON.stringify(expectedPlanId)}`,
    );
  }
  return { planId: compiled.planId, contracts: compiled.contracts };
}

// ---------------------------------------------------------------------------
// Base selection
// ---------------------------------------------------------------------------

interface BaseSelection {
  baseCommit: string;
  upstreamQueueId?: string;
  upstreamRunId?: string;
  upstreamIntegrationHead?: string;
}

function selectRootBase(repoRoot: string, rootBaseCommit: string): BaseSelection {
  return {
    baseCommit: resolveExactCommit(
      repoRoot,
      rootBaseCommit,
      "root baseCommit",
    ),
  };
}

/**
 * A dependent base is the completed upstream RunManifest's integration head.
 * The manifest is addressed by its recorded run id; the active run pointer,
 * current HEAD and branch names are never consulted.
 */
function selectUpstreamBase(
  repoRoot: string,
  upstream: PlanUpstreamEvidence,
): BaseSelection {
  if (upstream === null || typeof upstream !== "object") {
    throw new PlanMaterializationError("upstream evidence must be an object");
  }
  const upstreamQueueId = requireNonEmpty(
    upstream.queueId,
    "upstream queueId",
  );
  assertSafeQueueId(upstreamQueueId, "upstream queue id");

  if (upstream.status !== "completed") {
    throw new PlanMaterializationError(
      `upstream queue item ${JSON.stringify(upstreamQueueId)} is not ` +
        `completed (status: ${String(upstream.status)})`,
    );
  }

  const lastRunId = requireNonEmpty(upstream.lastRunId, "upstream lastRunId");
  const evidenceContractsPath = requireNonEmpty(
    upstream.contractsPath,
    "upstream contractsPath",
  );
  const evidenceContractsHash = normalizeSha256(
    upstream.contractsHash,
    "upstream contractsHash",
  );

  let manifest: RunManifest;
  try {
    manifest = loadRunManifest(repoRoot, lastRunId);
  } catch (error) {
    throw new PlanMaterializationError(
      `cannot load upstream RunManifest ${JSON.stringify(lastRunId)}: ` +
        `${errorMessage(error)}`,
    );
  }

  if (manifest.status !== "completed") {
    throw new PlanMaterializationError(
      `upstream RunManifest ${JSON.stringify(lastRunId)} is not completed ` +
        `(status: ${manifest.status})`,
    );
  }
  if (manifest.runId !== lastRunId) {
    throw new PlanMaterializationError(
      `upstream RunManifest run id ${JSON.stringify(manifest.runId)} does ` +
        `not match recorded lastRunId ${JSON.stringify(lastRunId)}`,
    );
  }

  const manifestContractsPath = isAbsolute(manifest.contractsPath)
    ? resolve(manifest.contractsPath)
    : resolve(resolve(manifest.repoRoot), manifest.contractsPath);
  const expectedContractsPath = isAbsolute(evidenceContractsPath)
    ? resolve(evidenceContractsPath)
    : resolve(repoRoot, evidenceContractsPath);
  if (
    manifestContractsPath !== expectedContractsPath ||
    manifest.contractsHash.toLowerCase() !== evidenceContractsHash
  ) {
    throw new PlanMaterializationError(
      `upstream RunManifest ${JSON.stringify(lastRunId)} contracts identity ` +
        "does not match the frozen upstream evidence",
    );
  }

  const integrationHead = resolveExactCommit(
    repoRoot,
    manifest.integrationHead,
    "upstream integrationHead",
  );
  const manifestBase = resolveExactCommit(
    repoRoot,
    manifest.baseCommit,
    "upstream manifest baseCommit",
  );
  assertAncestor(repoRoot, manifestBase, integrationHead);

  return {
    baseCommit: integrationHead,
    upstreamQueueId,
    upstreamRunId: lastRunId,
    upstreamIntegrationHead: integrationHead,
  };
}

// ---------------------------------------------------------------------------
// Artifact write / verify
// ---------------------------------------------------------------------------

/**
 * Reuse an existing artifact only when its bytes equal the deterministic
 * compile. Otherwise fail closed and leave the recorded file untouched.
 */
function writeOrVerifyArtifact(path: string, expectedBytes: Buffer): Buffer {
  const existing = readArtifact(path);
  if (existing !== undefined) {
    if (!existing.equals(expectedBytes)) {
      throw changedArtifactError(path);
    }
    return existing;
  }

  try {
    writeArtifactNoClobber(path, expectedBytes);
  } catch (error) {
    throw new PlanMaterializationError(
      `cannot write materialized contracts artifact ${path}: ` +
        `${errorMessage(error)}`,
    );
  }

  // A concurrent writer may have won the link race. Verify final bytes either
  // way; this also proves the file we hash is the file we intended to write.
  const written = readArtifact(path);
  if (written === undefined || !written.equals(expectedBytes)) {
    throw changedArtifactError(path);
  }
  return written;
}

function readArtifact(path: string): Buffer | undefined {
  try {
    return readFileSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new PlanMaterializationError(
      `cannot read materialized contracts artifact ${path}: ` +
        `${errorMessage(error)}`,
    );
  }
}

/**
 * Write through a same-directory temp file and hard-link it into place. The
 * link fails with EEXIST instead of overwriting a recorded artifact.
 */
function writeArtifactNoClobber(path: string, bytes: Buffer): void {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true });
  const temporary = join(
    dir,
    `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`,
  );

  let fd: number | undefined;
  try {
    fd = openSync(temporary, "wx", 0o600);
    writeFileSync(fd, bytes);
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;

    try {
      linkSync(temporary, path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      // Lost the race; the caller re-reads and compares exact bytes.
    }
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        /* best-effort cleanup */
      }
    }
    try {
      unlinkSync(temporary);
    } catch {
      /* best-effort cleanup */
    }
  }
}

function changedArtifactError(path: string): PlanMaterializationError {
  return new PlanMaterializationError(
    `materialized contracts artifact changed or is ambiguous: ${path}; ` +
      "refusing to overwrite",
  );
}

// ---------------------------------------------------------------------------
// Git proofs
// ---------------------------------------------------------------------------

/**
 * Require a full object id and prove git resolves it to that exact commit.
 * No symbolic revision (HEAD, branch, abbreviated hash) is accepted.
 */
function resolveExactCommit(
  repoRoot: string,
  value: string,
  label: string,
): string {
  const candidate = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (!FULL_COMMIT_PATTERN.test(candidate)) {
    throw new PlanMaterializationError(
      `${label} must be an exact full git commit hash ` +
        `(40 or 64 hex characters), got ${JSON.stringify(value)}`,
    );
  }

  const result = git(repoRoot, [
    "rev-parse",
    "--verify",
    "--quiet",
    `${candidate}^{commit}`,
  ]);
  if (result.error !== undefined || result.status !== 0) {
    throw new PlanMaterializationError(
      `cannot resolve ${label} ${JSON.stringify(candidate)} as a commit in ` +
        `${repoRoot}` +
        (gitDetail(result) !== "" ? ` (${gitDetail(result)})` : ""),
    );
  }
  const resolved = result.stdout.trim().toLowerCase();
  if (resolved !== candidate) {
    throw new PlanMaterializationError(
      `${label} ${JSON.stringify(candidate)} did not resolve to the exact ` +
        `commit (got ${JSON.stringify(resolved)})`,
    );
  }
  return resolved;
}

function assertAncestor(
  repoRoot: string,
  ancestor: string,
  descendant: string,
): void {
  const result = git(repoRoot, [
    "merge-base",
    "--is-ancestor",
    ancestor,
    descendant,
  ]);
  if (result.error !== undefined || result.status === null) {
    throw new PlanMaterializationError(
      `cannot prove ancestry of ${ancestor} in ${descendant}: ` +
        `${gitDetail(result) || "git did not run"}`,
    );
  }
  if (result.status === 1) {
    throw new PlanMaterializationError(
      `upstream manifest base ${ancestor} is not an ancestor of ` +
        `integration head ${descendant}`,
    );
  }
  if (result.status !== 0) {
    throw new PlanMaterializationError(
      `cannot prove ancestry of ${ancestor} in ${descendant} ` +
        `(git exited ${result.status}): ${gitDetail(result)}`,
    );
  }
}

function git(repoRoot: string, args: string[]) {
  return spawnSync("git", args, { cwd: repoRoot, encoding: "utf8" });
}

function gitDetail(result: ReturnType<typeof git>): string {
  if (result.error !== undefined) return result.error.message;
  return (result.stderr || result.stdout || "").trim();
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function normalizeSha256(value: unknown, field: string): string {
  if (typeof value !== "string" || !SHA256_PATTERN.test(value.trim())) {
    throw new PlanMaterializationError(
      `${field} must be a hex SHA-256 digest`,
    );
  }
  return value.trim().toLowerCase();
}

function requireNonEmpty(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new PlanMaterializationError(`${field} must be a non-empty string`);
  }
  return value.trim();
}

function assertSafeQueueId(value: string, label: string): void {
  if (!QUEUE_ID_PATTERN.test(value)) {
    throw new PlanMaterializationError(
      `invalid ${label}: ${JSON.stringify(value)} ` +
        "(use letters, digits, '.', '_' or '-', max 128 characters)",
    );
  }
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

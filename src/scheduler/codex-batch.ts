/**
 * S2: multi-task batch with Codex workers in isolated git worktrees.
 * Ready-wave runs in parallel; each task has its own worktree + verifier cwd.
 */
import {
  appendFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
  symlinkSync,
} from "node:fs";
import { hostname } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { spawn } from "node:child_process";
import { createClaudeAdapter } from "../agents/claude.js";
import { createCodexAdapter } from "../agents/codex.js";
import {
  BUDGET_CONTINUATION_POLICY_VERSION,
  DEFAULT_BUDGET_CONTINUATION_POLICY,
  MAX_BUDGET_CONTINUATIONS,
  MAX_BUDGET_GUARD_USD,
  appendTaskExtensionRecord,
  mergeTaskExtensionRecords,
  parseBudgetContinuationPolicy,
  parseBudgetGuardUsd,
  parseDeadlineExtensionPolicy,
  type BudgetContinuationPolicy,
  type DeadlineExtensionPolicy,
  type TaskExtensionRecord,
} from "../agents/continuation.js";
import { collectChangedPaths } from "../agents/git-paths.js";
import { auditPathScope } from "../agents/path-scope.js";
import type { WorkerProcessRecord } from "../agents/process-tree.js";
import {
  isWorkerProgressEvent,
  type AgentAdapter,
  type WorkerProgressEvent,
} from "../agents/types.js";
import {
  createMockVerifier,
  createShellVerifier,
} from "../verification/verifier.js";
import { defaultLedgerPath } from "../persistence/ledger.js";
import { createFailureRecord } from "../failures.js";
import { runClosedLoop, type LoopResult } from "../repair/loop.js";
import {
  assertContractsHash,
  resolveContractsPath,
  runManifestPath,
  updateRunManifest,
} from "../supervisor/store.js";
import {
  MAX_PATH_AUDITS,
  MAX_PROCESS_TREES,
  type PathAuditRecord,
  type ReusableAttempt,
  type RunManifest,
  type RunTaskState,
} from "../supervisor/types.js";
import {
  addWorktree,
  removeWorktree,
  type WorktreeHandle,
} from "../workspace/worktree.js";
import { findCycle, readyIds, type DagNode } from "./dag.js";
import { loadContractsInput } from "./mock-batch.js";
import { tryAppendQueueEvent } from "../orchestration/event-journal.js";

export interface CodexBatchOptions {
  contractsPath: string;
  repoRoot?: string;
  ledgerPath?: string;
  /** Worker family sharing the worktree scheduler. */
  worker?: "codex" | "claude";
  model?: string;
  dryRun?: boolean;
  keepWorktrees?: boolean;
  verbose?: boolean;
  /**
   * Opt-in wall-clock extension policy. Claude may extend a live child after a
   * durable callback. Codex remains fail-closed and only receives the base
   * timeout because it has no mapped meaningful-progress stream.
   */
  deadlinePolicy?: DeadlineExtensionPolicy;
  /**
   * Claude-only budget continuation policy. Grants are persisted through the
   * same run-scoped onExtension checkpoint as deadline extensions.
   */
  budgetPolicy?: BudgetContinuationPolicy;
  /** Initial Claude CLI --max-budget-usd guard. */
  maxBudgetUsd?: number;
  /** Test/integration seam: replace the real CLI adapter for one worktree. */
  workerFactory?: (
    worker: "codex" | "claude",
    cwd: string,
  ) => AgentAdapter;
  /**
   * Durable Supervisor checkpoint (RunManifest). When provided, the batch:
   *   - rejects changed contracts or a changed base commit,
   *   - checks work out of the recorded integration branch,
   *   - skips tasks already accepted in the manifest,
   *   - rebuilds pending/ready work from the contract DAG,
   *   - checkpoints the exact attempt worktree/branch/base before dispatch,
   *   - writes a checkpoint after every task result.
   * The manifest must already be persisted (see createRunManifest), and the
   * caller owns the supervisor lock for the duration of the batch.
   */
  runManifest?: RunManifest;
  /**
   * Resume a rejected task in its recorded worktree instead of creating a
   * clean one. Validation is fail-closed; pass false (fresh) to discard the
   * recorded draft and start a new worktree.
   */
  reuseAttempts?: boolean;
}

export interface CodexBatchResult {
  results: LoopResult[];
  skipped: { taskId: string; reason: string }[];
  startOrder: string[];
  waves: string[][];
  ledgerPath: string;
  allAccepted: boolean;
  worktrees: { taskId: string; path: string; branch: string }[];
  integration: {
    path: string;
    branch: string;
    head: string;
  };
  /** Final checkpoint, when the batch ran with `runManifest`. */
  manifest?: RunManifest;
}

// ---------------------------------------------------------------------------
// Worker progress events
// ---------------------------------------------------------------------------

const SAFE_EVENT_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/** `<repo>/.cliyard/worker-events/<runId>` — advisory progress, not authority. */
export function workerEventsDir(repoRoot: string, runId: string): string {
  return join(resolve(repoRoot), ".cliyard", "worker-events", runId);
}

export function workerEventLogPath(
  repoRoot: string,
  runId: string,
  taskId: string,
): string {
  return join(workerEventsDir(repoRoot, runId), `${taskId}.jsonl`);
}

/**
 * Append one complete JSONL record immediately, before any RunManifest
 * checkpoint. Progress is advisory: an unwritable path or malformed event is
 * ignored so it can never change a task verdict or run status.
 */
export function appendWorkerProgressEvent(
  repoRoot: string,
  runId: string,
  event: WorkerProgressEvent,
): void {
  if (
    !SAFE_EVENT_SEGMENT.test(runId) ||
    !SAFE_EVENT_SEGMENT.test(event.taskId) ||
    !isWorkerProgressEvent(event)
  ) {
    return;
  }
  const bounded: WorkerProgressEvent = {
    version: 1,
    at: event.at,
    source: clipEventText(event.source, 64),
    taskId: event.taskId,
    sessionId: clipEventText(event.sessionId, 128),
    type: event.type,
    phase: event.phase,
    message: clipEventText(event.message, 500),
    ...(event.detail === undefined
      ? {}
      : { detail: clipEventText(event.detail, 1_000) }),
  };
  try {
    mkdirSync(workerEventsDir(repoRoot, runId), {
      recursive: true,
      mode: 0o700,
    });
    appendFileSync(
      workerEventLogPath(repoRoot, runId, event.taskId),
      `${JSON.stringify(bounded)}\n`,
      "utf8",
    );
    if (
      bounded.type === "session.start" ||
      bounded.type === "result" ||
      bounded.type === "error"
    ) {
      tryAppendQueueEvent(repoRoot, {
        type:
          bounded.type === "session.start"
            ? "provider.session.started"
            : "provider.session.ended",
        at: bounded.at,
        runId,
        taskId: bounded.taskId,
        sessionId: bounded.sessionId,
        status: bounded.type,
      });
    }
  } catch {
    /* progress is best-effort; never fail the task */
  }
}

function clipEventText(value: string, max: number): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max - 1)}…`;
}

// ---------------------------------------------------------------------------
// Attempt continuity
// ---------------------------------------------------------------------------

interface RecordedAttemptFields {
  worktree: string;
  branch: string;
  baseCommit: string;
  startedAt: string;
  rejectedAt: string;
}

function recordedAttempt(task: RunTaskState): RecordedAttemptFields | undefined {
  if (
    task.attemptWorktree === undefined &&
    task.attemptBranch === undefined &&
    task.attemptBaseCommit === undefined &&
    task.attemptStartedAt === undefined &&
    task.attemptRejectedAt === undefined
  ) {
    return undefined;
  }
  return {
    worktree: task.attemptWorktree ?? "",
    branch: task.attemptBranch ?? "",
    baseCommit: task.attemptBaseCommit ?? "",
    startedAt: task.attemptStartedAt ?? "",
    rejectedAt: task.attemptRejectedAt ?? "",
  };
}

/**
 * A task records a rejection when it is marked rejected (or still carries
 * attemptRejectedAt) and has at least one attempt field to inspect.
 */
export function isRejectedAttempt(task: RunTaskState): boolean {
  return (
    !task.accepted &&
    (task.status === "rejected" || task.attemptRejectedAt !== undefined) &&
    recordedAttempt(task) !== undefined
  );
}

export type AttemptInspection =
  | { ok: true; attempt: ReusableAttempt }
  | { ok: false; reason: string };

/**
 * Validate a recorded rejected attempt before attaching a worker to it.
 *
 * Fail-closed by design: a path outside `.cliyard/worktrees`, an unregistered
 * worktree, a branch mismatch, a moved HEAD or missing rejection metadata all
 * reject reuse. The explicit recovery is a fresh attempt.
 */
export async function inspectRejectedAttempt(
  repoRoot: string,
  manifest: RunManifest,
  task: RunTaskState,
): Promise<AttemptInspection> {
  const fields = recordedAttempt(task);
  if (!fields) return { ok: false, reason: "no attempt was recorded" };

  const missing: string[] = [];
  if (!fields.worktree) missing.push("attemptWorktree");
  if (!fields.branch) missing.push("attemptBranch");
  if (!fields.baseCommit) missing.push("attemptBaseCommit");
  if (!fields.startedAt) missing.push("attemptStartedAt");
  if (!fields.rejectedAt) missing.push("attemptRejectedAt");
  if (missing.length > 0) {
    return { ok: false, reason: `missing ${missing.join(", ")}` };
  }

  if (task.accepted) {
    return { ok: false, reason: "task is already accepted" };
  }
  if (task.runId && task.runId !== manifest.runId) {
    return {
      ok: false,
      reason: `attempt is associated with run ${task.runId}, not ${manifest.runId}`,
    };
  }
  if (Number.isNaN(Date.parse(fields.startedAt))) {
    return { ok: false, reason: "attemptStartedAt is not a timestamp" };
  }
  if (Number.isNaN(Date.parse(fields.rejectedAt))) {
    return { ok: false, reason: "attemptRejectedAt is not a timestamp" };
  }
  if (!/^[0-9a-f]{40,64}$/i.test(fields.baseCommit)) {
    return {
      ok: false,
      reason: `attemptBaseCommit is not a full commit sha: ${fields.baseCommit}`,
    };
  }
  if (
    fields.branch.startsWith("-") ||
    fields.branch.startsWith("refs/") ||
    /\s/.test(fields.branch)
  ) {
    return {
      ok: false,
      reason: `invalid attempt branch ${JSON.stringify(fields.branch)}`,
    };
  }

  const root = resolve(repoRoot);
  const worktreesRoot = resolve(root, ".cliyard", "worktrees");
  const worktree = resolve(root, fields.worktree);
  if (!isPathInside(worktreesRoot, worktree)) {
    return {
      ok: false,
      reason: `attempt worktree ${worktree} is outside ${worktreesRoot}`,
    };
  }
  if (!existsSync(worktree) || !statSync(worktree).isDirectory()) {
    return {
      ok: false,
      reason: `attempt worktree ${worktree} is not a directory`,
    };
  }

  // A draft belongs to one task. Sharing a path or branch would let two
  // workers mutate the same worktree.
  for (const other of Object.values(manifest.tasks)) {
    if (other.taskId === task.taskId) continue;
    if (
      other.attemptWorktree &&
      samePath(resolve(root, other.attemptWorktree), worktree)
    ) {
      return {
        ok: false,
        reason: `attempt worktree is also recorded for task ${other.taskId}`,
      };
    }
    if (other.attemptBranch && other.attemptBranch === fields.branch) {
      return {
        ok: false,
        reason: `attempt branch is also recorded for task ${other.taskId}`,
      };
    }
  }

  // A worktree belongs to exactly one stored run. Sharing one across run
  // manifests would let a second supervisor attach to the same draft.
  const otherRun = findAttemptInOtherRun(root, manifest, worktree, fields.branch);
  if (otherRun) {
    return {
      ok: false,
      reason:
        `attempt is associated with run ${otherRun.runId} ` +
        `(task ${otherRun.taskId}), not ${manifest.runId}`,
    };
  }

  const registered = (await listWorktrees(root)).find((entry) =>
    samePath(entry.path, worktree),
  );
  const branchRef = `refs/heads/${fields.branch}`;
  if (!registered) {
    return {
      ok: false,
      reason: `attempt worktree ${worktree} is not a registered git worktree`,
    };
  }
  if (registered.branch !== branchRef) {
    return {
      ok: false,
      reason:
        `attempt worktree branch ${registered.branch ?? "<detached>"} ` +
        `does not match recorded branch ${fields.branch}`,
    };
  }

  const head = await gitRaw(worktree, [
    "rev-parse",
    "--verify",
    "HEAD^{commit}",
  ]);
  if (head.exitCode !== 0) {
    return {
      ok: false,
      reason:
        `cannot read attempt worktree HEAD: ` +
        `${(head.stderr || head.stdout).trim() || `git exited ${head.exitCode}`}`,
    };
  }
  const headCommit = head.stdout.trim().toLowerCase();
  if (headCommit !== fields.baseCommit.toLowerCase()) {
    return {
      ok: false,
      reason:
        `attempt worktree HEAD ${headCommit} does not match recorded ` +
        `base ${fields.baseCommit}`,
    };
  }

  return {
    ok: true,
    attempt: {
      taskId: task.taskId,
      worktree,
      branch: fields.branch,
      baseCommit: fields.baseCommit.toLowerCase(),
      startedAt: fields.startedAt,
      rejectedAt: fields.rejectedAt,
    },
  };
}

/** Read-only helper for `supervisor status`; invalid attempts are omitted. */
export async function listReusableAttempts(
  repoRoot: string,
  manifest: RunManifest,
): Promise<ReusableAttempt[]> {
  const attempts: ReusableAttempt[] = [];
  for (const task of Object.values(manifest.tasks)) {
    if (!isRejectedAttempt(task)) continue;
    const inspection = await inspectRejectedAttempt(repoRoot, manifest, task);
    if (inspection.ok) attempts.push(inspection.attempt);
  }
  return attempts.sort((left, right) =>
    left.taskId.localeCompare(right.taskId),
  );
}

/** Look for the same worktree/branch recorded by a different run manifest. */
function findAttemptInOtherRun(
  root: string,
  manifest: RunManifest,
  worktree: string,
  branch: string,
): { runId: string; taskId: string } | undefined {
  const runsDir = join(root, ".cliyard", "runs");
  let entries: string[];
  try {
    entries = readdirSync(runsDir);
  } catch {
    return undefined;
  }
  for (const entry of entries) {
    if (!entry.endsWith(".json") || entry === "active.json") continue;
    if (entry === `${manifest.runId}.json`) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(join(runsDir, entry), "utf8"));
    } catch {
      continue;
    }
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      Array.isArray(parsed)
    ) {
      continue;
    }
    const record = parsed as {
      runId?: unknown;
      tasks?: unknown;
    };
    if (typeof record.runId !== "string" || !record.tasks) continue;
    if (record.runId === manifest.runId) continue;
    if (typeof record.tasks !== "object" || Array.isArray(record.tasks)) {
      continue;
    }
    for (const [taskId, rawTask] of Object.entries(
      record.tasks as Record<string, unknown>,
    )) {
      if (typeof rawTask !== "object" || rawTask === null) continue;
      const task = rawTask as Record<string, unknown>;
      const otherTaskId =
        typeof task.taskId === "string" ? task.taskId : taskId;
      if (
        typeof task.attemptWorktree === "string" &&
        task.attemptWorktree.trim() !== "" &&
        samePath(resolve(root, task.attemptWorktree), worktree)
      ) {
        return { runId: record.runId, taskId: otherTaskId };
      }
      if (
        typeof task.attemptBranch === "string" &&
        task.attemptBranch !== "" &&
        task.attemptBranch === branch
      ) {
        return { runId: record.runId, taskId: otherTaskId };
      }
    }
  }
  return undefined;
}

function canonicalPath(path: string): string {
  const resolved = resolve(path);
  try {
    return realpathSync(resolved);
  } catch {
    return resolved;
  }
}

function samePath(left: string, right: string): boolean {
  return canonicalPath(left) === canonicalPath(right);
}

function isPathInside(parent: string, child: string): boolean {
  const rel = relative(canonicalPath(parent), canonicalPath(child));
  return (
    rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)
  );
}

export async function runCodexBatch(
  opts: CodexBatchOptions,
): Promise<CodexBatchResult> {
  const deadlinePolicy =
    opts.deadlinePolicy === undefined
      ? undefined
      : parseDeadlineExtensionPolicy(opts.deadlinePolicy);
  if (opts.deadlinePolicy !== undefined && !deadlinePolicy) {
    throw new Error("worker-batch: invalid deadline extension policy");
  }
  const budgetPolicy =
    opts.budgetPolicy === undefined
      ? undefined
      : parseBudgetContinuationPolicy(opts.budgetPolicy);
  if (opts.budgetPolicy !== undefined && !budgetPolicy) {
    throw new Error("worker-batch: invalid budget continuation policy");
  }
  const maxBudgetUsd =
    opts.maxBudgetUsd === undefined
      ? budgetPolicy?.baseGuardUsd
      : parseBudgetGuardUsd(opts.maxBudgetUsd);
  if (opts.maxBudgetUsd !== undefined && maxBudgetUsd === undefined) {
    throw new Error(
      "worker-batch: maxBudgetUsd must be a positive, bounded USD amount",
    );
  }
  if (
    budgetPolicy &&
    maxBudgetUsd !== undefined &&
    maxBudgetUsd !== budgetPolicy.baseGuardUsd
  ) {
    throw new Error(
      "worker-batch: maxBudgetUsd contradicts budgetPolicy.baseGuardUsd",
    );
  }
  if (
    (budgetPolicy !== undefined || opts.maxBudgetUsd !== undefined) &&
    (opts.worker ?? "codex") !== "claude"
  ) {
    throw new Error(
      "worker-batch: budget continuation is supported only by Claude",
    );
  }
  const repoRoot = resolve(opts.repoRoot ?? process.cwd());
  const contractsPath = resolveContractsPath(repoRoot, opts.contractsPath);
  const ledgerPath = opts.ledgerPath ?? defaultLedgerPath(repoRoot);
  const requestedManifest = opts.runManifest;
  if (requestedManifest) {
    validateManifestIdentity(repoRoot, contractsPath, requestedManifest);
  }

  const contracts = await resolveContractBases(
    repoRoot,
    loadContractsInput(contractsPath),
  );
  validateDispatchGraph(contracts);
  const sharedBase = contracts[0]?.baseCommit;
  if (
    !sharedBase ||
    contracts.some((contract) => contract.baseCommit !== sharedBase)
  ) {
    throw new Error(
      "worker-batch requires one shared base commit for all tasks",
    );
  }
  // Read context is proven against the exact commit every worker worktree is
  // created from, never against the control checkout or its HEAD.
  await validateReadContexts(repoRoot, contracts, sharedBase);
  if (requestedManifest) {
    validateManifestTasks(requestedManifest, contracts, sharedBase);
  }

  // Validate every reusable rejected attempt before creating the integration
  // worktree or dispatching any worker, so a tampered draft fails closed
  // without side effects. `reuseAttempts: false` is the explicit fresh path
  // and intentionally skips validation.
  const reuseAttempts = opts.reuseAttempts === true;
  const reusable = new Map<string, ReusableAttempt>();
  if (requestedManifest && reuseAttempts) {
    for (const contract of contracts) {
      const task = requestedManifest.tasks[contract.taskId];
      if (!task || !isRejectedAttempt(task)) continue;
      const inspection = await inspectRejectedAttempt(
        repoRoot,
        requestedManifest,
        task,
      );
      if (!inspection.ok) {
        throw new Error(
          `worker-batch: task ${contract.taskId} has an invalid rejected ` +
            `attempt (${inspection.reason}); rerun with --fresh-attempt to ` +
            "discard the recorded draft",
        );
      }
      const changed = await collectChangedPaths(
        inspection.attempt.worktree,
        inspection.attempt.baseCommit,
      );
      const audit = auditPathScope(
        contract.writePaths,
        changed.paths,
      );
      if (changed.error || audit.outsideWritePaths.length > 0) {
        const detail = changed.error
          ? `changed-path collection failed: ${JSON.stringify(changed.error)}`
          : "paths outside contract write scope: " +
            JSON.stringify(audit.outsideWritePaths);
        throw new Error(
          `worker-batch: task ${contract.taskId} rejected attempt cannot be ` +
            `reused before worker dispatch (${detail}; changedPaths=` +
            `${JSON.stringify(audit.changedPaths)}). No files were removed; ` +
            "rerun with --fresh-attempt to leave that draft behind",
        );
      }
      reusable.set(contract.taskId, inspection.attempt);
    }
  }

  const handles = new Map<string, WorktreeHandle>();
  /** Worktrees whose dirty draft must survive this invocation's cleanup. */
  const retained = new Set<string>();
  /** Exact attempt metadata checkpointed before each worker starts. */
  const attemptRecords = new Map<
    string,
    { worktree: string; branch: string; baseCommit: string; startedAt: string }
  >();
  const workerKind = opts.worker ?? "codex";
  const dryRun = opts.dryRun === true;
  const log = opts.verbose
    ? (s: string) => console.log(s)
    : (_s: string) => undefined;

  const nodes: DagNode[] = contracts.map((c) => ({
    id: c.taskId,
    dependsOn: c.dependsOn,
  }));
  const cycle = findCycle(nodes);
  if (!cycle.ok) {
    throw new Error(`codex-batch: cycle ${cycle.cycle.join(" → ")}`);
  }

  let checkpoint = requestedManifest;
  const integration = checkpoint
    ? await ensureIntegrationWorktree(repoRoot, checkpoint, log)
    : await addWorktree({
        repoRoot,
        taskId: "integration",
        baseCommit: sharedBase,
      });
  await linkDependencies(repoRoot, integration.worktreePath, log);
  log(
    `[${workerKind}-batch] integration ${integration.branch} → ${integration.worktreePath}`,
  );

  try {
    if (checkpoint) {
      const integrationHead = await gitHead(integration.worktreePath);
      checkpoint = checkpointManifest(repoRoot, checkpoint, (manifest) => {
        manifest.status = "running";
        manifest.owner = { pid: process.pid, host: hostname() };
        manifest.integrationHead = integrationHead;
        for (const contract of contracts) {
          const task: RunTaskState = manifest.tasks[contract.taskId] ?? {
            taskId: contract.taskId,
            status: "ready",
            accepted: false,
          };
          if (!task.accepted && task.status !== "rejected") {
            // A previous owner may have died mid-task; rebuild it as ready.
            // Rejected status is kept so resume can decide whether to reuse or
            // discard the recorded attempt before this dispatch overwrites it.
            // The prior attempt's failure/cost do not describe the new attempt.
            task.status = "ready";
            delete task.reason;
            delete task.failure;
            delete task.cost;
          }
          manifest.tasks[contract.taskId] = task;
        }
      });
    }

    const byId = new Map(contracts.map((c) => [c.taskId, c]));
    const accepted = new Set<string>();
    if (checkpoint) {
      for (const contract of contracts) {
        if (checkpoint.tasks[contract.taskId]?.accepted) {
          accepted.add(contract.taskId);
        }
      }
    }
    const pending = new Set(
      contracts
        .map((contract) => contract.taskId)
        .filter((taskId) => !accepted.has(taskId)),
    );
    const results: LoopResult[] = [];
    const skipped: { taskId: string; reason: string }[] = [];
    const startOrder: string[] = [];
    const waves: string[][] = [];

    while (pending.size > 0) {
      const ready = readyIds(nodes, accepted).filter((id) => pending.has(id));
      if (ready.length === 0) {
        for (const id of [...pending]) {
          skipped.push({
            taskId: id,
            reason: "blocked: dependencies not accepted",
          });
          pending.delete(id);
        }
        break;
      }

      for (const id of ready) {
        startOrder.push(id);
        log(`[${workerKind}-batch] start ${id}`);
      }

      const integrationBase = await gitHead(integration.worktreePath);
      waves.push([...ready]);
      for (const id of ready) {
        const reuse = reusable.get(id);
        let handle: WorktreeHandle;
        if (reuse) {
          handle = {
            taskId: id,
            branch: reuse.branch,
            worktreePath: reuse.worktree,
            repoRoot,
          };
          // Keep the pre-existing draft if this invocation fails before a new
          // result is checkpointed.
          retained.add(id);
          log(
            `[${workerKind}-batch] reuse attempt worktree ${id} → ` +
              handle.worktreePath,
          );
        } else {
          handle = await addWorktree({
            repoRoot,
            taskId: id,
            baseCommit: integrationBase,
          });
          log(
            `[${workerKind}-batch] worktree ${id} → ${handle.worktreePath}`,
          );
        }
        handles.set(id, handle);

        // Checkpoint the exact worktree, branch and base before the worker
        // starts. A reused worktree keeps its original base, which may be
        // older than the current integration head; acceptance merges it like
        // any other task branch.
        const attemptBaseCommit = reuse
          ? reuse.baseCommit
          : await gitHead(handle.worktreePath);
        const attemptStartedAt = new Date().toISOString();
        attemptRecords.set(id, {
          worktree: handle.worktreePath,
          branch: handle.branch,
          baseCommit: attemptBaseCommit,
          startedAt: attemptStartedAt,
        });
        if (checkpoint) {
          checkpoint = checkpointManifest(repoRoot, checkpoint, (manifest) => {
            const task: RunTaskState = manifest.tasks[id] ?? {
              taskId: id,
              status: "ready",
              accepted: false,
            };
            task.status = "running";
            task.accepted = false;
            delete task.reason;
            // A new attempt supersedes the previous structured observation.
            delete task.failure;
            delete task.cost;
            task.attemptWorktree = handle.worktreePath;
            task.attemptBranch = handle.branch;
            task.attemptBaseCommit = attemptBaseCommit;
            task.attemptStartedAt = attemptStartedAt;
            delete task.attemptRejectedAt;
            manifest.tasks[id] = task;
          });
        }
        await linkDependencies(repoRoot, handle.worktreePath, log);
      }

      const waveResults = await Promise.all(
        ready.map(async (id) => {
          const contract = {
            ...byId.get(id)!,
            baseCommit: attemptRecords.get(id)!.baseCommit,
          };
          const wt = handles.get(id)!;
          const worker =
            opts.workerFactory?.(workerKind, wt.worktreePath) ??
            (workerKind === "claude"
              ? createClaudeAdapter({
                  cwd: wt.worktreePath,
                  model: opts.model,
                  dryRun,
                  ...(maxBudgetUsd !== undefined ? { maxBudgetUsd } : {}),
                  ...(budgetPolicy ? { budgetPolicy } : {}),
                  ...(deadlinePolicy ? { deadlinePolicy } : {}),
                })
              : createCodexAdapter({
                  cwd: wt.worktreePath,
                  model: opts.model,
                  dryRun,
                  ...(deadlinePolicy
                    ? { timeoutMs: deadlinePolicy.baseTimeoutMs }
                    : {}),
                }));
          // Dry-run stays on the mock verifier, so it never starts a runtime.
          // Real verification gets both the control repository (manifest,
          // logs, leases) and the exact task worktree (service cwd).
          const verifier = dryRun
            ? createMockVerifier()
            : createShellVerifier({
                cwd: wt.worktreePath,
                repoRoot,
                worktree: wt.worktreePath,
                ...(requestedManifest !== undefined
                  ? { runtimeIdPrefix: requestedManifest.runId }
                  : {}),
              });
          return runClosedLoop({
            contract,
            worker,
            verifier,
            ledgerPath,
            verbose: opts.verbose,
            ...(checkpoint &&
              (deadlinePolicy || budgetPolicy) &&
              workerKind === "claude"
              ? {
                  onExtension: async (
                    extension: TaskExtensionRecord,
                  ): Promise<void> => {
                    checkpoint = checkpointManifest(
                      repoRoot,
                      checkpoint!,
                      (manifest) => {
                        const task = manifest.tasks[id];
                        if (!task || task.status !== "running") {
                          throw new Error(
                            `cannot persist task extension for ${id}: ` +
                              "task is not running",
                          );
                        }
                        task.extensions = appendTaskExtensionRecord(
                          task.extensions,
                          extension,
                        );
                      },
                    );
                  },
                }
              : {}),
            // Only a manifest-backed Supervisor run has a run-scoped progress
            // log. The event is appended during dispatch, not at checkpoint.
            ...(requestedManifest
              ? {
                  onProgress: (event: WorkerProgressEvent) =>
                    appendWorkerProgressEvent(
                      repoRoot,
                      requestedManifest.runId,
                      event,
                    ),
                }
              : {}),
          });
        }),
      );

      for (let i = 0; i < ready.length; i++) {
        const id = ready[i]!;
        const result = waveResults[i]!;
        results.push(result);
        pending.delete(id);
        if (result.verdict === "accepted") {
          accepted.add(id);
          const snapshot = await snapshotTask(
            handles.get(id)!,
            id,
            byId.get(id)!.writePaths,
          );
          await mergeAcceptedTask(
            integration.worktreePath,
            handles.get(id)!,
            snapshot,
          );
          if (checkpoint) {
            const integrationHead = await gitHead(integration.worktreePath);
            checkpoint = checkpointManifest(
              repoRoot,
              checkpoint,
              (manifest) => {
                // Acceptance clears every attempt field; the snapshot is the
                // durable result and the worktree has no further value. Cost
                // is checkpointed before cleanup so it survives the removed
                // worktree. Accepted tasks carry no failure.
                manifest.tasks[id] = {
                  taskId: id,
                  status: "accepted",
                  accepted: true,
                  resultCommit: snapshot,
                  pathAudits: mergePathAudits(
                    manifest.tasks[id]?.pathAudits,
                    result.pathAudits,
                  ),
                  ...processTreeFields(
                    manifest.tasks[id]?.processTrees,
                    result.processTrees,
                  ),
                  ...taskExtensionFields(
                    manifest.tasks[id]?.extensions,
                    result.extensions,
                  ),
                  ...(result.cost !== undefined ? { cost: result.cost } : {}),
                };
                manifest.integrationHead = integrationHead;
              },
            );
          }
          retained.delete(id);
          log(`[${workerKind}-batch] accepted ${id}`);
        } else {
          // Every dispatched task was prepared above and has exact metadata.
          const attempt = attemptRecords.get(id)!;
          const rejectedAt = new Date().toISOString();
          if (checkpoint) {
            checkpoint = checkpointManifest(
              repoRoot,
              checkpoint,
              (manifest) => {
                // Keep the dirty worktree and exact attempt metadata so a
                // later resume can reuse this draft.
                const task: RunTaskState = {
                  taskId: id,
                  status: result.status,
                  accepted: false,
                  reason: result.reason,
                  // Rejection keeps both the structured failure and the cost
                  // of every attempt, including repairs, alongside the draft.
                  ...(result.failure !== undefined
                    ? { failure: result.failure }
                    : {}),
                  ...(result.cleanupFailure !== undefined
                    ? { cleanupFailure: result.cleanupFailure }
                    : {}),
                  ...(result.cost !== undefined ? { cost: result.cost } : {}),
                  attemptWorktree: attempt.worktree,
                  attemptBranch: attempt.branch,
                  attemptBaseCommit: attempt.baseCommit,
                  attemptStartedAt: attempt.startedAt,
                  attemptRejectedAt: rejectedAt,
                  pathAudits: mergePathAudits(
                    manifest.tasks[id]?.pathAudits,
                    result.pathAudits,
                  ),
                  ...processTreeFields(
                    manifest.tasks[id]?.processTrees,
                    result.processTrees,
                  ),
                  ...taskExtensionFields(
                    manifest.tasks[id]?.extensions,
                    result.extensions,
                  ),
                };
                manifest.tasks[id] = task;
              },
            );
            // Only a Supervisor checkpoint makes a draft durable state. A
            // plain batch keeps its existing --keep-worktrees behavior.
            retained.add(id);
          }
          log(`[${workerKind}-batch] rejected ${id}: ${result.reason}`);
        }
      }
    }

    const finalHead = await gitHead(integration.worktreePath);
    const allAccepted =
      skipped.length === 0 && results.every((r) => r.verdict === "accepted");
    if (checkpoint) {
      checkpoint = checkpointManifest(repoRoot, checkpoint, (manifest) => {
        manifest.integrationHead = finalHead;
        for (const item of skipped) {
          const task: RunTaskState = manifest.tasks[item.taskId] ?? {
            taskId: item.taskId,
            status: "ready",
            accepted: false,
          };
          task.status = "blocked";
          task.accepted = false;
          task.reason = item.reason;
          // A dependency block never dispatched a worker: persist a
          // deterministic policy failure, never a fabricated cost.
          task.failure = createFailureRecord({
            policyBlocked: true,
            stage: "policy",
            code: "dependency_blocked",
            messageDetail: item.reason,
          });
          delete task.cost;
          manifest.tasks[item.taskId] = task;
        }
        manifest.status = allAccepted ? "completed" : "blocked";
      });
    }

    return {
      results,
      skipped,
      startOrder,
      waves,
      ledgerPath,
      allAccepted,
      worktrees: [...handles.values()].map((h) => ({
        taskId: h.taskId,
        path: h.worktreePath,
        branch: h.branch,
      })),
      integration: {
        path: integration.worktreePath,
        branch: integration.branch,
        head: finalHead,
      },
      ...(checkpoint ? { manifest: checkpoint } : {}),
    };
  } finally {
    if (!opts.keepWorktrees) {
      for (const h of handles.values()) {
        // A rejected (or reused, not-yet-accepted) draft is durable run
        // state. It survives cleanup even without --keep-worktrees.
        if (retained.has(h.taskId)) continue;
        await removeWorktree(h, { force: true }).catch(() => undefined);
      }
      if (requestedManifest) {
        // The integration branch is the durable resume checkpoint.
        await removeWorktreeKeepBranch(integration).catch(() => undefined);
      } else {
        await removeWorktree(integration, { force: true }).catch(
          () => undefined,
        );
      }
    }
  }
}

function mergePathAudits(
  existing: PathAuditRecord[] | undefined,
  observed: PathAuditRecord[],
): PathAuditRecord[] {
  return [...(existing ?? []), ...observed].slice(-MAX_PATH_AUDITS);
}

/** Bounded cumulative process-tree evidence, newest last. */
function processTreeFields(
  existing: WorkerProcessRecord[] | undefined,
  observed: WorkerProcessRecord[] | undefined,
): { processTrees?: WorkerProcessRecord[] } {
  const merged = [...(existing ?? []), ...(observed ?? [])].slice(
    -MAX_PROCESS_TREES,
  );
  return merged.length > 0 ? { processTrees: merged } : {};
}

function taskExtensionFields(
  existing: TaskExtensionRecord[] | undefined,
  observed: TaskExtensionRecord[],
): { extensions?: TaskExtensionRecord[] } {
  const extensions = mergeTaskExtensionRecords(existing, observed);
  return extensions.length > 0 ? { extensions } : {};
}

/**
 * Resume preconditions that only need the manifest and the contracts file.
 * These run before any worktree is created or worker dispatched.
 */
function validateManifestIdentity(
  repoRoot: string,
  contractsPath: string,
  manifest: RunManifest,
): void {
  const manifestRoot = resolve(manifest.repoRoot);
  if (manifestRoot !== repoRoot) {
    throw new Error(
      `worker-batch: run ${manifest.runId} belongs to ${manifestRoot}, ` +
        `not ${repoRoot}`,
    );
  }
  const requestedPath = resolveContractsPath(repoRoot, contractsPath);
  const recordedPath = resolveContractsPath(repoRoot, manifest.contractsPath);
  if (requestedPath !== recordedPath) {
    throw new Error(
      `worker-batch: contracts path changed for run ${manifest.runId}: ` +
        `manifest has ${recordedPath}, batch was given ${requestedPath}`,
    );
  }
  if (!existsSync(runManifestPath(repoRoot, manifest.runId))) {
    throw new Error(
      `worker-batch: run manifest ${manifest.runId} is not persisted; ` +
        "create it with createRunManifest before dispatching",
    );
  }
  // Hash the recorded absolute path so resume is independent of the cwd.
  assertContractsHash({ ...manifest, contractsPath: recordedPath });
}

function validateManifestTasks(
  manifest: RunManifest,
  contracts: ReturnType<typeof loadContractsInput>,
  sharedBase: string,
): void {
  if (manifest.baseCommit !== sharedBase) {
    throw new Error(
      `worker-batch: base commit changed for run ${manifest.runId}: ` +
        `manifest has ${manifest.baseCommit}, contracts resolve to ${sharedBase}`,
    );
  }
  const contractIds = new Set(contracts.map((contract) => contract.taskId));
  for (const taskId of Object.keys(manifest.tasks)) {
    if (!contractIds.has(taskId)) {
      throw new Error(
        `worker-batch: run ${manifest.runId} tracks task ${taskId}, ` +
          "which is not present in the contracts",
      );
    }
  }
}

function checkpointManifest(
  repoRoot: string,
  manifest: RunManifest,
  mutate: (manifest: RunManifest) => void,
): RunManifest {
  return updateRunManifest(repoRoot, manifest.runId, mutate);
}

interface ListedWorktree {
  path: string;
  branch?: string;
}

/**
 * Attach to the recorded integration branch, creating it on a fresh run.
 * A resume must never silently lose accepted work, so a missing branch or a
 * branch that no longer contains the recorded head is a hard error.
 */
async function ensureIntegrationWorktree(
  repoRoot: string,
  manifest: RunManifest,
  log: (message: string) => void,
): Promise<WorktreeHandle> {
  const branch = manifest.integrationBranch;
  await gitRaw(repoRoot, ["worktree", "prune"]).catch(() => undefined);
  const existing = (await listWorktrees(repoRoot)).find(
    (entry) => entry.branch === `refs/heads/${branch}`,
  );

  const branchRef = await gitRaw(repoRoot, [
    "rev-parse",
    "--verify",
    `refs/heads/${branch}^{commit}`,
  ]);
  const branchHead =
    branchRef.exitCode === 0 ? branchRef.stdout.trim() : undefined;
  const accepted = Object.values(manifest.tasks).filter(
    (task) => task.accepted,
  );

  if (!branchHead) {
    if (manifest.status !== "running" || accepted.length > 0) {
      throw new Error(
        `worker-batch: integration branch ${branch} is missing for run ` +
          `${manifest.runId} (${accepted.length} accepted task(s)); ` +
          "cannot resume without the integration checkpoint",
      );
    }
    await resolveGitCommit(repoRoot, manifest.integrationHead);
    log(
      `[worker-batch] create integration branch ${branch} ` +
        `at ${manifest.integrationHead}`,
    );
    return addIntegrationWorktree(
      repoRoot,
      branch,
      manifest.integrationHead,
      true,
    );
  }

  const recorded = await gitRaw(repoRoot, [
    "merge-base",
    "--is-ancestor",
    manifest.integrationHead,
    branchHead,
  ]);
  if (recorded.exitCode !== 0) {
    throw new Error(
      `worker-batch: integration branch ${branch} does not contain the ` +
        `recorded head ${manifest.integrationHead} for run ${manifest.runId}`,
    );
  }
  for (const task of accepted) {
    if (!task.resultCommit) continue;
    const contained = await gitRaw(repoRoot, [
      "merge-base",
      "--is-ancestor",
      task.resultCommit,
      branchHead,
    ]);
    if (contained.exitCode !== 0) {
      throw new Error(
        `worker-batch: accepted task ${task.taskId} commit ` +
          `${task.resultCommit} is not contained in integration branch ${branch}`,
      );
    }
  }
  if (existing) {
    log(
      `[worker-batch] reuse integration worktree ${existing.path} (${branch})`,
    );
    return {
      taskId: "integration",
      branch,
      worktreePath: existing.path,
      repoRoot,
    };
  }
  log(`[worker-batch] resume integration branch ${branch}`);
  return addIntegrationWorktree(repoRoot, branch, branch, false);
}

async function addIntegrationWorktree(
  repoRoot: string,
  branch: string,
  startPoint: string,
  createBranch: boolean,
): Promise<WorktreeHandle> {
  const id = `${Date.now().toString(36)}-integration`;
  const worktreePath = resolve(repoRoot, join(".cliyard", "worktrees", id));
  mkdirSync(resolve(repoRoot, ".cliyard", "worktrees"), { recursive: true });
  await git(
    repoRoot,
    createBranch
      ? ["worktree", "add", "-b", branch, worktreePath, startPoint]
      : ["worktree", "add", worktreePath, startPoint],
  );
  return { taskId: "integration", branch, worktreePath, repoRoot };
}

async function listWorktrees(repoRoot: string): Promise<ListedWorktree[]> {
  const result = await git(repoRoot, ["worktree", "list", "--porcelain"]);
  const entries: ListedWorktree[] = [];
  let current: ListedWorktree | undefined;
  for (const line of result.stdout.split("\n")) {
    if (line.startsWith("worktree ")) {
      current = { path: line.slice("worktree ".length) };
      entries.push(current);
    } else if (line.startsWith("branch ") && current) {
      current.branch = line.slice("branch ".length);
    } else if (line === "") {
      current = undefined;
    }
  }
  return entries;
}

/** Drop the integration worktree but keep the branch as the checkpoint. */
async function removeWorktreeKeepBranch(
  handle: WorktreeHandle,
): Promise<void> {
  const removed = await gitRaw(handle.repoRoot, [
    "worktree",
    "remove",
    "--force",
    handle.worktreePath,
  ]);
  if (removed.exitCode !== 0) {
    await gitRaw(handle.repoRoot, ["worktree", "prune"]);
  }
}

async function linkDependencies(
  repoRoot: string,
  worktreePath: string,
  log: (message: string) => void,
): Promise<void> {
  const source = join(repoRoot, "node_modules");
  const target = join(worktreePath, "node_modules");
  if (!existsSync(source) || existsSync(target)) return;

  const ignored = await git(repoRoot, [
    "check-ignore",
    "-q",
    "node_modules",
  ]).catch(() => ({ exitCode: 1, stdout: "", stderr: "" }));
  if (ignored.exitCode !== 0) {
    log(
      "[worker-batch] node_modules is not ignored; dependency link skipped",
    );
    return;
  }

  symlinkSync(
    source,
    target,
    process.platform === "win32" ? "junction" : "dir",
  );
  const stat = lstatSync(target);
  if (!stat.isSymbolicLink()) {
    throw new Error(`dependency link is not a symlink: ${target}`);
  }
  log(`[worker-batch] dependencies ${target} → ${source}`);
}

async function validateReadContexts(
  repoRoot: string,
  contracts: ReturnType<typeof loadContractsInput>,
  baseCommit: string,
): Promise<void> {
  const producedPaths = contracts.flatMap((contract) => contract.writePaths);
  const readPaths = [...new Set(contracts.flatMap((contract) => contract.readPaths))];

  for (const readPath of readPaths) {
    // The repository root exists in every worktree without a lookup.
    if (readPath === ".") continue;
    // A task in this contracts document creates the path in its own wave; it
    // may legitimately be referenced before it exists at the shared base.
    if (producedPaths.some((writePath) => pathsOverlap(readPath, writePath))) {
      continue;
    }
    // The worker worktree is created at this exact commit, so the tree of the
    // pinned base - not the control checkout or its HEAD - decides whether the
    // path is readable by the worker.
    if (await pathExistsAtCommit(repoRoot, baseCommit, readPath)) continue;

    // A path visible only in the control working tree is never copied into a
    // worktree; keep the existing untracked-context error.
    const visibleInCheckout = existsSync(join(repoRoot, readPath));
    if (visibleInCheckout) {
      const tracked = await git(repoRoot, ["ls-files", "--", readPath]);
      if (!tracked.stdout.trim()) {
        throw new Error(
          `worker-batch: readPath "${readPath}" is untracked and will be absent ` +
            "from worker worktrees; commit it or produce it as a task artifact",
        );
      }
    }
    // The default AGENTS.md is optional only when it is genuinely missing.
    // A file that is tracked in the current checkout but absent at the pinned
    // base would still be absent from the worker worktree.
    if (readPath === "AGENTS.md" && !visibleInCheckout) continue;
    throw new Error(
      `worker-batch: readPath "${readPath}" is absent from contracts base ` +
        `${baseCommit} and will be absent from worker worktrees; pin the base ` +
        "to a commit that contains it or produce it as a task artifact",
    );
  }
}

/** True when `path` exists in the exact tree of `commit` (blob or tree). */
async function pathExistsAtCommit(
  repoRoot: string,
  commit: string,
  path: string,
): Promise<boolean> {
  const result = await gitRaw(repoRoot, [
    "cat-file",
    "-e",
    `${commit}:${path}`,
  ]);
  return result.exitCode === 0;
}

async function snapshotTask(
  handle: WorktreeHandle,
  taskId: string,
  writePaths: string[],
): Promise<string> {
  const snapshotPaths: string[] = [];
  for (const writePath of writePaths) {
    const tracked = await git(handle.worktreePath, [
      "ls-files",
      "--",
      writePath,
    ]);
    if (
      existsSync(join(handle.worktreePath, writePath)) ||
      tracked.stdout.trim()
    ) {
      snapshotPaths.push(writePath);
    }
  }
  if (snapshotPaths.length === 0) {
    return (await git(handle.worktreePath, ["rev-parse", "HEAD"])).stdout.trim();
  }

  const status = await git(handle.worktreePath, [
    "status",
    "--porcelain",
    "--untracked-files=all",
    "--",
    ...snapshotPaths,
  ]);
  if (status.stdout.trim()) {
    await git(handle.worktreePath, ["add", "-A", "--", ...snapshotPaths]);
    await git(handle.worktreePath, [
      "-c",
      "user.name=cliyard",
      "-c",
      "user.email=cliyard@localhost",
      "commit",
      "-m",
      `cliyard snapshot: ${taskId}`,
    ]);
  }
  return (await git(handle.worktreePath, ["rev-parse", "HEAD"])).stdout.trim();
}

async function mergeAcceptedTask(
  integrationPath: string,
  task: WorktreeHandle,
  snapshot: string,
): Promise<void> {
  const taskHead = (
    await git(task.worktreePath, ["rev-parse", "HEAD"])
  ).stdout.trim();
  if (taskHead !== snapshot) {
    throw new Error(`task snapshot changed unexpectedly: ${task.taskId}`);
  }
  const base = (
    await git(integrationPath, ["rev-parse", "HEAD"])
  ).stdout.trim();
  const merged = await git(integrationPath, [
    "merge-base",
    "--is-ancestor",
    snapshot,
    base,
  ]).catch(() => ({ exitCode: 1, stdout: "", stderr: "" }));
  if (merged.exitCode === 0) return;
  await git(integrationPath, [
    "-c",
    "user.name=cliyard",
    "-c",
    "user.email=cliyard@localhost",
    "merge",
    "--no-ff",
    "--no-edit",
    task.branch,
  ]);
}

async function gitHead(cwd: string): Promise<string> {
  return (await git(cwd, ["rev-parse", "HEAD"])).stdout.trim();
}

async function git(
  cwd: string,
  args: string[],
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const result = await gitRaw(cwd, args);
  if (result.exitCode !== 0) {
    throw new Error(
      `git ${args.join(" ")} failed: ${
        (result.stderr || result.stdout).trim() || `exit ${result.exitCode}`
      }`,
    );
  }
  return result;
}

/** Like `git`, but returns the exit code instead of throwing on non-zero. */
async function gitRaw(
  cwd: string,
  args: string[],
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn("git", args, {
      cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (data) => {
      stdout += String(data);
    });
    child.stderr.on("data", (data) => {
      stderr += String(data);
    });
    child.on("error", reject);
    child.on("close", (code) => {
      resolvePromise({ exitCode: code ?? 1, stdout, stderr });
    });
  });
}

async function resolveContractBases(
  repoRoot: string,
  contracts: ReturnType<typeof loadContractsInput>,
) {
  return Promise.all(
    contracts.map(async (contract) => ({
      ...contract,
      baseCommit: await resolveGitCommit(
        repoRoot,
        contract.baseCommit || "HEAD",
      ),
    })),
  );
}

function validateDispatchGraph(
  contracts: ReturnType<typeof loadContractsInput>,
): void {
  const byId = new Map<string, (typeof contracts)[number]>();
  for (const contract of contracts) {
    if (byId.has(contract.taskId)) {
      throw new Error(`codex-batch: duplicate taskId ${contract.taskId}`);
    }
    if (!contract.frozen) {
      throw new Error(`codex-batch: task ${contract.taskId} is not frozen`);
    }
    byId.set(contract.taskId, contract);
    if (contract.sharedResources.length > 0) {
      throw new Error(
        `codex-batch: task ${contract.taskId} uses sharedResources, ` +
          "but resource locking is not implemented",
      );
    }
  }
  for (const contract of contracts) {
    for (const dependency of contract.dependsOn) {
      if (!byId.has(dependency)) {
        throw new Error(
          `codex-batch: task ${contract.taskId} depends on unknown task ${dependency}`,
        );
      }
    }
  }

  for (let i = 0; i < contracts.length; i++) {
    for (let j = i + 1; j < contracts.length; j++) {
      const left = contracts[i]!;
      const right = contracts[j]!;
      for (const a of left.writePaths) {
        for (const b of right.writePaths) {
          if (pathsOverlap(a, b)) {
            throw new Error(
              `codex-batch: writePaths overlap between ${left.taskId} (${a}) ` +
                `and ${right.taskId} (${b}); isolated worktrees do not compose edits`,
            );
          }
        }
      }
    }
  }
}

function pathsOverlap(left: string, right: string): boolean {
  const a = left.replace(/\/+$/, "");
  const b = right.replace(/\/+$/, "");
  return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}

function resolveGitCommit(repoRoot: string, revision: string): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(
      "git",
      ["rev-parse", "--verify", `${revision}^{commit}`],
      {
        cwd: repoRoot,
        env: process.env,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (data) => {
      stdout += String(data);
    });
    child.stderr.on("data", (data) => {
      stderr += String(data);
    });
    child.on("error", reject);
    child.on("close", (code) => {
      const commit = stdout.trim();
      if (code === 0 && /^[0-9a-f]{40,64}$/i.test(commit)) {
        resolvePromise(commit);
        return;
      }
      reject(
        new Error(
          `codex-batch: cannot resolve baseCommit "${revision}": ` +
            `${(stderr || stdout).trim() || `git exited ${code}`}`,
        ),
      );
    });
  });
}

function usage(worker: "codex" | "claude" = "codex"): never {
  console.log(`cliyard ${worker}-batch — parallel ${worker} workers in git worktrees

Usage:
  cliyard ${worker}-batch <contracts.json> [--repo path] [--ledger path]
                         [--model id] [--dry-run] [--keep-worktrees]
                         ${worker === "claude"
                           ? `[--max-budget-usd usd] [--auto-continue-budget]
                         [--continuation-guard-usd usd]
                         [--max-budget-continuations n]
                         [--max-cumulative-budget-guard-usd usd]
                         [--budget-overshoot-reserve-usd usd]`
                           : ""}

Defaults:
  codex model: deepseek-v4-pro (or CLIYARD_CODEX_MODEL)
  claude model: deepseek-flash (or CLIYARD_CLAUDE_MODEL)
  --dry-run: stub files in worktree (no worker API); for tests / offline
  ledger: <repo>/.cliyard/ledger.json
`);
  process.exit(1);
}

function arg(flag: string, argv: string[]): string | undefined {
  const i = argv.indexOf(flag);
  if (i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--")) return argv[i + 1];
  const eq = argv.find((a) => a.startsWith(`${flag}=`));
  return eq?.slice(flag.length + 1);
}

export async function runCodexBatchCli(argv: string[]): Promise<void> {
  await runWorkerBatchCli(argv, "codex");
}

export async function runClaudeBatchCli(argv: string[]): Promise<void> {
  await runWorkerBatchCli(argv, "claude");
}

async function runWorkerBatchCli(
  argv: string[],
  worker: "codex" | "claude",
): Promise<void> {
  if (argv.includes("-h") || argv.includes("--help") || argv.length === 0) {
    usage(worker);
  }
  const file = positionalArg(argv);
  if (!file) usage(worker);
  const requestedWorker = arg("--worker", argv);
  if (requestedWorker !== undefined) {
    throw new Error(
      `worker-batch: ${worker}-batch does not accept --worker; ` +
        `use ${requestedWorker}-batch instead`,
    );
  }
  const budget = budgetSettingsFromArgs(argv, worker);

  const result = await runCodexBatch({
    contractsPath: file!,
    repoRoot: arg("--repo", argv),
    ledgerPath: arg("--ledger", argv),
    worker,
    model: arg("--model", argv),
    dryRun: argv.includes("--dry-run") || process.env.CLIYARD_CODEX_DRY === "1",
    keepWorktrees:
      argv.includes("--keep-worktrees") ||
      process.env.CLIYARD_KEEP_WORKTREES === "1",
    ...(budget.maxBudgetUsd !== undefined
      ? { maxBudgetUsd: budget.maxBudgetUsd }
      : {}),
    ...(budget.budgetPolicy !== undefined
      ? { budgetPolicy: budget.budgetPolicy }
      : {}),
    verbose: true,
  });

  console.log(
    JSON.stringify(
      {
        startOrder: result.startOrder,
        waves: result.waves,
        allAccepted: result.allAccepted,
        worktrees: result.worktrees,
        results: result.results.map((r) => ({
          taskId: r.taskId,
          verdict: r.verdict,
          status: r.status,
          repairCount: r.repairCount,
          reason: r.reason,
        })),
        skipped: result.skipped,
        ledgerPath: result.ledgerPath,
      },
      null,
      2,
    ),
  );
  process.exit(result.allAccepted ? 0 : 1);
}

function positionalArg(argv: string[]): string | undefined {
  const valueFlags = new Set([
    "--repo",
    "--ledger",
    "--model",
    "--worker",
    ...BUDGET_VALUE_FLAGS,
  ]);
  for (let i = 0; i < argv.length; i++) {
    const value = argv[i]!;
    if (value.startsWith("--")) {
      if (valueFlags.has(value)) i += 1;
      continue;
    }
    return value;
  }
  return undefined;
}

const BUDGET_VALUE_FLAGS = [
  "--max-budget-usd",
  "--continuation-guard-usd",
  "--max-budget-continuations",
  "--max-cumulative-budget-guard-usd",
  "--budget-overshoot-reserve-usd",
] as const;

function budgetSettingsFromArgs(
  argv: string[],
  worker: "codex" | "claude",
): {
  maxBudgetUsd?: number;
  budgetPolicy?: BudgetContinuationPolicy;
} {
  const autoOccurrences = flagOccurrences("--auto-continue-budget", argv);
  if (autoOccurrences.length > 1) {
    throw new Error(
      "worker-batch: --auto-continue-budget may be specified only once",
    );
  }
  if (autoOccurrences.some((value) => value.includes("="))) {
    throw new Error(
      "worker-batch: --auto-continue-budget does not accept a value",
    );
  }
  const anyBudgetFlag =
    autoOccurrences.length > 0 ||
    BUDGET_VALUE_FLAGS.some(
      (flag) => flagOccurrences(flag, argv).length > 0,
    );
  if (anyBudgetFlag && worker !== "claude") {
    throw new Error(
      "worker-batch: budget flags are supported only by claude-batch",
    );
  }

  const maxBudgetUsd = moneyFlag("--max-budget-usd", argv, false);
  const continuationGuardUsd = moneyFlag(
    "--continuation-guard-usd",
    argv,
    false,
  );
  const maxContinuations = integerFlag(
    "--max-budget-continuations",
    argv,
  );
  const requestedMaxCumulative = moneyFlag(
    "--max-cumulative-budget-guard-usd",
    argv,
    false,
  );
  const overshootReserveUsd = moneyFlag(
    "--budget-overshoot-reserve-usd",
    argv,
    true,
  );
  const autoContinue = autoOccurrences.length === 1;
  const hasPolicyFlag =
    autoContinue ||
    continuationGuardUsd !== undefined ||
    maxContinuations !== undefined ||
    requestedMaxCumulative !== undefined ||
    overshootReserveUsd !== undefined;
  if (!hasPolicyFlag) return maxBudgetUsd !== undefined ? { maxBudgetUsd } : {};

  const baseGuardUsd =
    maxBudgetUsd ?? DEFAULT_BUDGET_CONTINUATION_POLICY.baseGuardUsd;
  const continuation =
    continuationGuardUsd ??
    DEFAULT_BUDGET_CONTINUATION_POLICY.continuationGuardUsd;
  const maximum =
    maxContinuations ??
    DEFAULT_BUDGET_CONTINUATION_POLICY.maxContinuations;
  const reserve =
    overshootReserveUsd ??
    DEFAULT_BUDGET_CONTINUATION_POLICY.overshootReserveUsd;
  const cumulative =
    requestedMaxCumulative ??
    roundMoney(baseGuardUsd + continuation * maximum + reserve);

  if (autoContinue && maximum === 0) {
    throw new Error(
      "worker-batch: --auto-continue-budget requires " +
        "--max-budget-continuations > 0",
    );
  }
  if (cumulative > MAX_BUDGET_GUARD_USD) {
    throw new Error(
      `worker-batch: max cumulative budget guard must be at most ` +
        `${MAX_BUDGET_GUARD_USD}`,
    );
  }
  const policy = parseBudgetContinuationPolicy({
    version: BUDGET_CONTINUATION_POLICY_VERSION,
    baseGuardUsd,
    continuationGuardUsd: continuation,
    maxContinuations: maximum,
    maxCumulativeGuardUsd: cumulative,
    autoContinue,
    overshootReserveUsd: reserve,
  });
  if (!policy) {
    throw new Error(
      "worker-batch: invalid budget continuation policy; positive guards, " +
        "a cumulative guard covering continuation plus overshoot reserve, " +
        "and 0..64 continuations are required",
    );
  }
  return { maxBudgetUsd: baseGuardUsd, budgetPolicy: policy };
}

function integerFlag(flag: string, argv: string[]): number | undefined {
  const occurrences = flagOccurrences(flag, argv);
  if (occurrences.length === 0) return undefined;
  if (occurrences.length > 1) {
    throw new Error(`worker-batch: ${flag} may be specified only once`);
  }
  const raw = arg(flag, argv);
  if (
    raw === undefined ||
    !/^(?:0|[1-9]\d*)$/.test(raw) ||
    !Number.isSafeInteger(Number(raw)) ||
    Number(raw) > MAX_BUDGET_CONTINUATIONS
  ) {
    throw new Error(
      `worker-batch: ${flag} requires an integer from 0 to ` +
        `${MAX_BUDGET_CONTINUATIONS}`,
    );
  }
  return Number(raw);
}

function moneyFlag(
  flag: string,
  argv: string[],
  allowZero: boolean,
): number | undefined {
  const occurrences = flagOccurrences(flag, argv);
  if (occurrences.length === 0) return undefined;
  if (occurrences.length > 1) {
    throw new Error(`worker-batch: ${flag} may be specified only once`);
  }
  const raw = arg(flag, argv);
  if (
    raw === undefined ||
    !/^(?:0|[1-9]\d*)(?:\.\d{1,6})?$/.test(raw)
  ) {
    throw new Error(
      `worker-batch: ${flag} requires a non-negative USD amount with at ` +
        "most 6 decimal places",
    );
  }
  const value = Number(raw);
  if (
    !Number.isFinite(value) ||
    value > MAX_BUDGET_GUARD_USD ||
    (!allowZero && value === 0)
  ) {
    throw new Error(
      `worker-batch: ${flag} requires a ` +
        `${allowZero ? "non-negative" : "positive"} bounded USD amount`,
    );
  }
  return value;
}

function flagOccurrences(flag: string, argv: string[]): string[] {
  return argv.filter(
    (value) => value === flag || value.startsWith(`${flag}=`),
  );
}

function roundMoney(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

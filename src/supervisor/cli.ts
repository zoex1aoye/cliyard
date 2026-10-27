/**
 * Supervisor v0 CLI: foreground `start` / `resume`, read-only `status`,
 * orphan-runtime `reap`, and a cooperative `stop`.
 *
 * Durability lives in the RunManifest store; the worker batch persists a
 * checkpoint after every accepted task. `resume` reloads that manifest, checks
 * the contracts / base / integration preconditions, and dispatches only tasks
 * that are not accepted yet.
 *
 * `start` and `resume` reconcile orphaned runtime processes after acquiring the
 * repository lock and before creating or marking a run. Any runtime that needs
 * human review fails the command closed (design/runtime-orphan-reaper-v0.md).
 */
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync, unlinkSync, type Dirent } from "node:fs";
import { hostname } from "node:os";
import { basename, extname, join, resolve } from "node:path";
import type { TaskContract } from "../contracts/schema.js";
import { RUNTIME_MANIFEST_FILE } from "../runtime/manager.js";
import { portAllocatorPaths } from "../runtime/ports.js";
import {
  preflightOrphanedRuntimes,
  type RuntimeReapPlanState,
} from "../runtime/reaper.js";
import {
  reapOrphanedRuntimes,
  type RuntimeReapReport,
} from "../runtime/reaper-execute.js";
import type {
  RuntimeCleanupState,
  RuntimeRecoveryRecord,
} from "../runtime/types.js";
import {
  runCodexBatch,
  type CodexBatchOptions,
  type CodexBatchResult,
} from "../scheduler/codex-batch.js";
import { loadContractsInput } from "../scheduler/mock-batch.js";
import {
  acquireSupervisorLock,
  assertContractsHash,
  clearStaleSupervisorLock,
  createRunManifest,
  getActiveRunId,
  inspectRun,
  inspectSupervisorLock,
  isProcessAlive,
  isSameHost,
  loadRunManifest,
  setActiveRun,
  SupervisorLockHeldError,
  updateRunManifest,
  type RunInspection,
  type SupervisorLockHandle,
  type SupervisorLockInspection,
} from "./store.js";
import type {
  RunManifest,
  RunOwner,
  RunStatus,
  RunTaskState,
  SupervisorLockInfo,
} from "./types.js";

const STOP_TIMEOUT_MS = 5_000;

export interface SupervisorCliOptions {
  /** Output sink; defaults to console.log. */
  log?: (line: string) => void;
  /** Test seam forwarded to the worker batch. */
  workerFactory?: CodexBatchOptions["workerFactory"];
  /**
   * The real CLI installs SIGINT/SIGTERM handlers so a foreground run is
   * checkpointed as interrupted before exit. Tests that drive the CLI
   * in-process can disable them.
   */
  signalHandling?: boolean;
}

/** A recovery record already persisted in a runtime manifest. */
export interface SupervisorRuntimeRecovery {
  runtimeId: string;
  cleanup?: RuntimeCleanupState;
  recovery: RuntimeRecoveryRecord;
}

export interface SupervisorStatus {
  runId: string;
  planId: string;
  status: RunStatus;
  repoRoot: string;
  contractsPath: string;
  contractsHash: string;
  baseCommit: string;
  integrationBranch: string;
  integrationHead: string;
  integrationBranchHead: string | null;
  accepted: number;
  pending: number;
  blocked: number;
  total: number;
  tasks: RunTaskState[];
  owner: RunOwner;
  ownerAlive: boolean | null;
  interrupted: boolean;
  /** `interrupted` when a running manifest's owner is gone, else `status`. */
  effectiveStatus: RunStatus;
  activeRunId: string | null;
  lock: {
    state: SupervisorLockInspection["state"];
    path: string;
    owner: SupervisorLockInfo | null;
    reason: string | null;
  };
  /** Timestamp of the last manifest checkpoint write. */
  lastCheckpoint: string;
  lastAccepted: RunTaskState | null;
  /** Recovery evidence persisted by earlier reaper runs; never reconciled here. */
  runtimeRecovery: SupervisorRuntimeRecovery[];
}

export async function runSupervisorCli(
  argv: string[],
  options: SupervisorCliOptions = {},
): Promise<number> {
  const log = options.log ?? ((line: string) => console.log(line));
  const [cmd, ...rest] = argv;
  if (!cmd) {
    printUsage(log);
    return 1;
  }
  if (cmd === "-h" || cmd === "--help") {
    printUsage(log);
    return 0;
  }

  switch (cmd) {
    case "start":
      return startCommand(rest, options, log);
    case "status":
      return statusCommand(rest, options, log);
    case "resume":
      return resumeCommand(rest, options, log);
    case "reap":
      return reapCommand(rest, options, log);
    case "stop":
      return stopCommand(rest, options, log);
    default:
      log(`unknown supervisor command: ${cmd}`);
      printUsage(log);
      return 1;
  }
}

// ---------------------------------------------------------------------------
// start
// ---------------------------------------------------------------------------

async function startCommand(
  rest: string[],
  options: SupervisorCliOptions,
  log: (line: string) => void,
): Promise<number> {
  const repoRoot = repoFrom(rest);
  const contractsArg = positionalArg(rest);
  if (!contractsArg) {
    log("supervisor start: missing <contracts.json>");
    printUsage(log);
    return 1;
  }

  const contractsPath = resolve(repoRoot, contractsArg);
  const contracts = loadContractsInput(contractsPath);
  const baseCommit = resolveSharedBaseCommit(repoRoot, contracts);
  const runId = randomUUID();
  const planId =
    arg("--plan-id", rest) ?? basename(contractsPath, extname(contractsPath));
  const integrationBranch = `cliyard/integration/${runId}`;

  // Acquire before writing the manifest so a held lock never leaves a
  // half-started run behind.
  const lock = acquireSupervisorLock(repoRoot, runId);
  let manifest: RunManifest;
  try {
    // Reconcile orphaned runtimes only once this supervisor owns the repo. Any
    // runtime needing human review fails the start before a run is created.
    await reconcileOrphansBeforeRun(repoRoot, "start");
    manifest = createRunManifest(repoRoot, {
      runId,
      planId,
      contractsPath,
      baseCommit,
      integrationBranch,
      tasks: contracts.map((contract) => contract.taskId),
    });
  } catch (error) {
    lock.release();
    throw error;
  }

  return executeRun({
    repoRoot,
    manifest,
    lock,
    rest,
    options,
    log,
    resumed: false,
  });
}

// ---------------------------------------------------------------------------
// resume
// ---------------------------------------------------------------------------

async function resumeCommand(
  rest: string[],
  options: SupervisorCliOptions,
  log: (line: string) => void,
): Promise<number> {
  const repoRoot = repoFrom(rest);
  const manifest = loadRunManifest(repoRoot, arg("--run", rest));

  if (manifest.status === "completed") {
    log(`run ${manifest.runId} is already completed; nothing to resume`);
    return 0;
  }

  // Resume preconditions run before the lock or any dispatch.
  assertContractsHash(manifest);
  const contracts = loadContractsInput(manifest.contractsPath);
  const baseCommit = resolveSharedBaseCommit(repoRoot, contracts);
  if (baseCommit !== manifest.baseCommit) {
    throw new Error(
      `supervisor resume: base commit changed for run ${manifest.runId}: ` +
        `manifest has ${manifest.baseCommit}, contracts resolve to ${baseCommit}`,
    );
  }
  assertIntegrationBranch(repoRoot, manifest);

  const rejected = Object.values(manifest.tasks).filter(
    (task) => !task.accepted && task.status === "rejected",
  );
  if (rejected.length > 0 && !has("--retry-rejected", rest)) {
    throw new Error(
      `supervisor resume: run ${manifest.runId} has rejected task(s) ` +
        `${rejected.map((task) => task.taskId).join(", ")}; ` +
        "rerun with --retry-rejected to retry them",
    );
  }

  const lock = acquireResumeLock(repoRoot, manifest, has("--force", rest));
  let resumed: RunManifest;
  try {
    // Reconcile before marking the run running so unsafe orphan evidence can
    // never coexist with a newly dispatched batch.
    await reconcileOrphansBeforeRun(repoRoot, "resume");
    setActiveRun(repoRoot, manifest.runId);
    resumed = updateRunManifest(repoRoot, manifest.runId, (current) => {
      current.status = "running";
      current.owner = { pid: process.pid, host: hostname() };
      for (const task of Object.values(current.tasks)) {
        if (!task.accepted) {
          // A previous owner may have died mid-task; rebuild it as ready.
          task.status = "ready";
          delete task.reason;
        }
      }
    });
  } catch (error) {
    lock.release();
    throw error;
  }

  return executeRun({
    repoRoot,
    manifest: resumed,
    lock,
    rest,
    options,
    log,
    resumed: true,
  });
}

function acquireResumeLock(
  repoRoot: string,
  manifest: RunManifest,
  force: boolean,
): SupervisorLockHandle {
  const inspection = inspectSupervisorLock(repoRoot);
  if (inspection.state === "held") {
    throw new SupervisorLockHeldError(
      inspection.path,
      inspection.lock,
      inspection.reason ?? "another supervisor owns this repository",
    );
  }
  if (inspection.state === "stale") {
    // Recovery is explicit: the owner is provably gone.
    clearStaleSupervisorLock(repoRoot);
  }
  if (inspection.state === "invalid" && !force) {
    throw new Error(
      `supervisor resume: unreadable supervisor lock ${inspection.path}` +
        (inspection.reason ? ` (${inspection.reason})` : "") +
        "; rerun with --force to replace it",
    );
  }
  return acquireSupervisorLock(repoRoot, manifest.runId, {
    force: force && inspection.state === "invalid",
  });
}

function assertIntegrationBranch(
  repoRoot: string,
  manifest: RunManifest,
): void {
  const head = tryResolveCommit(
    repoRoot,
    `refs/heads/${manifest.integrationBranch}`,
  );
  if (!head) {
    throw new Error(
      `supervisor resume: integration branch ${manifest.integrationBranch} ` +
        `is missing for run ${manifest.runId}; ` +
        "cannot resume without the integration checkpoint",
    );
  }
}

// ---------------------------------------------------------------------------
// status
// ---------------------------------------------------------------------------

async function statusCommand(
  rest: string[],
  _options: SupervisorCliOptions,
  log: (line: string) => void,
): Promise<number> {
  const repoRoot = repoFrom(rest);
  const inspection = inspectRun(repoRoot, arg("--run", rest));
  const lock = inspectSupervisorLock(repoRoot);
  const status = buildStatus(repoRoot, inspection, lock);

  if (has("--json", rest)) {
    log(JSON.stringify(status, null, 2));
  } else {
    printStatus(status, log);
  }
  return 0;
}

function buildStatus(
  repoRoot: string,
  inspection: RunInspection,
  lock: SupervisorLockInspection,
): SupervisorStatus {
  const manifest = inspection.manifest;
  const tasks = Object.values(manifest.tasks);
  const counts = taskCounts(manifest);
  const lastAccepted = tasks.filter((task) => task.accepted).pop() ?? null;
  const branchHead = tryResolveCommit(
    repoRoot,
    `refs/heads/${manifest.integrationBranch}`,
  );

  return {
    runId: manifest.runId,
    planId: manifest.planId,
    status: manifest.status,
    repoRoot: manifest.repoRoot,
    contractsPath: manifest.contractsPath,
    contractsHash: manifest.contractsHash,
    baseCommit: manifest.baseCommit,
    integrationBranch: manifest.integrationBranch,
    integrationHead: manifest.integrationHead,
    integrationBranchHead: branchHead ?? null,
    accepted: counts.accepted,
    pending: counts.pending,
    blocked: counts.blocked,
    total: counts.total,
    tasks: tasks.map((task) => ({ ...task })),
    owner: manifest.owner,
    ownerAlive: inspection.ownerAlive,
    interrupted: inspection.interrupted,
    effectiveStatus: inspection.interrupted ? "interrupted" : manifest.status,
    activeRunId: getActiveRunId(repoRoot) ?? null,
    lock: {
      state: lock.state,
      path: lock.path,
      owner: lock.lock ?? null,
      reason: lock.reason ?? null,
    },
    lastCheckpoint: manifest.updatedAt,
    lastAccepted: lastAccepted ? { ...lastAccepted } : null,
    // Read-only: expose evidence written by previous reaper runs; status never
    // plans, signals, releases a lease, or rewrites a manifest.
    runtimeRecovery: readRuntimeRecoveryRecords(repoRoot),
  };
}

function printStatus(
  status: SupervisorStatus,
  log: (line: string) => void,
): void {
  log(`runId: ${status.runId}`);
  log(`planId: ${status.planId}`);
  log(
    `status: ${status.effectiveStatus}` +
      (status.interrupted ? " (stale owner; resumable)" : ""),
  );
  const blockedNote =
    status.blocked > 0 ? ` (blocked ${status.blocked})` : "";
  log(
    `tasks: accepted ${status.accepted} / pending ${status.pending} / ` +
      `total ${status.total}${blockedNote}`,
  );
  let branchNote = " (branch missing)";
  if (status.integrationBranchHead) {
    branchNote =
      status.integrationBranchHead === status.integrationHead
        ? ""
        : ` (branch head ${status.integrationBranchHead})`;
  }
  log(
    `integration: ${status.integrationBranch} @ ` +
      `${status.integrationHead}${branchNote}`,
  );
  log(`lock: ${formatLock(status.lock)}`);
  const alive =
    status.ownerAlive === null
      ? " (remote host)"
      : status.ownerAlive
        ? " (alive)"
        : " (not running)";
  log(`owner: pid ${status.owner.pid} on ${status.owner.host}${alive}`);
  log(`last checkpoint: ${status.lastCheckpoint}`);
  if (status.runtimeRecovery.length === 0) {
    log("runtime recovery: none");
  } else {
    for (const entry of status.runtimeRecovery) {
      log(
        `runtime recovery: ${entry.runtimeId} ${entry.recovery.state} ` +
          `at ${entry.recovery.at} - ${entry.recovery.reason}`,
      );
    }
  }
  if (status.lastAccepted) {
    const commit = status.lastAccepted.resultCommit
      ? ` @ ${status.lastAccepted.resultCommit}`
      : "";
    log(`last accepted: ${status.lastAccepted.taskId}${commit}`);
  }
  log(
    `contracts: ${status.contractsPath} (sha256 ${status.contractsHash})`,
  );
  log(`repo: ${status.repoRoot}`);
}

function formatLock(
  lock: SupervisorStatus["lock"],
): string {
  if (lock.state === "free") return "free";
  if (lock.state === "invalid") {
    return `invalid${lock.reason ? ` (${lock.reason})` : ""}`;
  }
  const owner = lock.owner;
  if (!owner) return lock.state;
  if (lock.state === "stale") {
    return `stale (pid ${owner.pid} on ${owner.host} is not running)`;
  }
  if (!isSameHost(owner.host)) {
    return `held by run ${owner.runId} pid ${owner.pid} on ${owner.host} (remote host)`;
  }
  const alive = isProcessAlive(owner.pid) ? "" : " (not running)";
  return `held by run ${owner.runId} pid ${owner.pid} on ${owner.host}${alive}`;
}

// ---------------------------------------------------------------------------
// stop
// ---------------------------------------------------------------------------

async function stopCommand(
  rest: string[],
  _options: SupervisorCliOptions,
  log: (line: string) => void,
): Promise<number> {
  const repoRoot = repoFrom(rest);
  const manifest = loadRunManifest(repoRoot, arg("--run", rest));
  const force = has("--force", rest);
  const initial = inspectSupervisorLock(repoRoot);

  if (initial.lock && initial.lock.runId !== manifest.runId) {
    throw new Error(
      `supervisor stop: supervisor lock is held by run ${initial.lock.runId} ` +
        `(pid ${initial.lock.pid}), not ${manifest.runId}`,
    );
  }

  if (initial.state === "held" && initial.lock) {
    const owner = initial.lock;
    if (owner.pid === process.pid) {
      if (!force) {
        throw new Error(
          `supervisor stop: lock ${initial.path} is owned by this process; ` +
            "refusing to signal itself (use --force to drop the lock)",
        );
      }
    } else if (!isSameHost(owner.host)) {
      if (!force) {
        throw new Error(
          `supervisor stop: owner pid ${owner.pid} is on ${owner.host}; ` +
            "liveness cannot be checked (use --force after confirming it exited)",
        );
      }
    } else if (isProcessAlive(owner.pid)) {
      try {
        process.kill(owner.pid, "SIGTERM");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      }
      const stopped = await waitFor(
        () => !isProcessAlive(owner.pid),
        STOP_TIMEOUT_MS,
      );
      if (!stopped) {
        throw new Error(
          `supervisor stop: owner pid ${owner.pid} did not exit within ` +
            `${STOP_TIMEOUT_MS}ms`,
        );
      }
    }
  }

  let lock = inspectSupervisorLock(repoRoot);
  if (lock.state === "stale") {
    clearStaleSupervisorLock(repoRoot);
    lock = inspectSupervisorLock(repoRoot);
  }
  if (lock.state !== "free") {
    if (!force) {
      throw new Error(
        `supervisor stop: supervisor lock is still held at ${lock.path}` +
          (lock.reason ? ` (${lock.reason})` : ""),
      );
    }
    removeLockIfOwned(lock);
    lock = inspectSupervisorLock(repoRoot);
  }

  const updated = updateRunManifest(repoRoot, manifest.runId, (current) => {
    if (current.status === "running") current.status = "interrupted";
  });
  log(`stopped run ${updated.runId}: status ${updated.status}`);
  log(
    `lock: ${formatLock({
      state: lock.state,
      path: lock.path,
      owner: lock.lock ?? null,
      reason: lock.reason ?? null,
    })}`,
  );
  return 0;
}

function removeLockIfOwned(lock: SupervisorLockInspection): void {
  try {
    if (lock.lock) {
      const current = JSON.parse(
        readFileSync(lock.path, "utf8"),
      ) as SupervisorLockInfo;
      if (
        current.runId !== lock.lock.runId ||
        current.pid !== lock.lock.pid ||
        current.acquiredAt !== lock.lock.acquiredAt
      ) {
        throw new Error(
          `supervisor stop: lock ${lock.path} changed while stopping; ` +
            "refusing to remove it",
        );
      }
    }
    unlinkSync(lock.path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
  }
  return predicate();
}

// ---------------------------------------------------------------------------
// Orphan runtime reconciliation
// ---------------------------------------------------------------------------

interface AnnotatedRecoveryRecord {
  group: "reaped" | "needsHuman" | "skipped";
  runtimeId?: string;
  record: RuntimeRecoveryRecord;
}

interface BlockedRuntime {
  runtimeId?: string;
  reason: string;
}

interface ReconciliationOutcome {
  report: RuntimeReapReport;
  records: AnnotatedRecoveryRecord[];
  blocked: BlockedRuntime[];
}

async function reapCommand(
  rest: string[],
  _options: SupervisorCliOptions,
  log: (line: string) => void,
): Promise<number> {
  const repoRoot = repoFrom(rest);
  const outcome = await reconcileRuntimeOrphans(repoRoot);

  if (has("--json", rest)) {
    log(JSON.stringify(outcome.report, null, 2));
  } else {
    printReconciliation(outcome, log);
  }
  return 0;
}

/**
 * Run the destructive reaper and annotate its records with runtime ids.
 *
 * Preflight runs first (read-only) because the executor report intentionally
 * carries recovery records without ids; plans are the only source for
 * `needs_human`/`skip` decisions that change nothing on disk. Records persisted
 * by the executor are matched back to their manifest.
 */
async function reconcileRuntimeOrphans(
  repoRoot: string,
): Promise<ReconciliationOutcome> {
  const preflight = await preflightOrphanedRuntimes(repoRoot);
  const report = await reapOrphanedRuntimes(repoRoot);
  const persisted = readRuntimeRecoveryRecords(repoRoot);

  const planIds = new Map<string, string[]>();
  for (const plan of preflight.plans) {
    const key = planKey(plan.state, plan.reason);
    const ids = planIds.get(key);
    if (ids === undefined) planIds.set(key, [plan.runtimeId]);
    else ids.push(plan.runtimeId);
  }
  const takePlanId = (
    state: RuntimeReapPlanState,
    reason: string,
  ): string | undefined => planIds.get(planKey(state, reason))?.shift();

  const usedPersisted = new Set<number>();
  const takePersistedId = (
    record: RuntimeRecoveryRecord,
  ): string | undefined => {
    for (let index = 0; index < persisted.length; index += 1) {
      if (usedPersisted.has(index)) continue;
      if (sameRecovery(persisted[index].recovery, record)) {
        usedPersisted.add(index);
        return persisted[index].runtimeId;
      }
    }
    return undefined;
  };

  const annotate = (
    group: AnnotatedRecoveryRecord["group"],
    records: readonly RuntimeRecoveryRecord[],
    planState?: RuntimeReapPlanState,
  ): AnnotatedRecoveryRecord[] =>
    records.map((record) => {
      const runtimeId =
        takePersistedId(record) ??
        (planState === undefined
          ? undefined
          : takePlanId(planState, record.reason));
      return {
        group,
        ...(runtimeId !== undefined ? { runtimeId } : {}),
        record,
      };
    });

  const records: AnnotatedRecoveryRecord[] = [
    ...annotate("reaped", report.reaped),
    ...annotate("needsHuman", report.needsHuman, "needs_human"),
    ...annotate("skipped", report.skipped, "skip"),
  ];

  const blocked: BlockedRuntime[] = [];
  const blockedKeys = new Set<string>();
  const addBlocked = (runtimeId: string | undefined, reason: string): void => {
    const key = `${runtimeId ?? ""} ${reason}`;
    if (blockedKeys.has(key)) return;
    blockedKeys.add(key);
    blocked.push({ ...(runtimeId !== undefined ? { runtimeId } : {}), reason });
  };
  for (const plan of preflight.needsHuman) {
    addBlocked(plan.runtimeId, plan.reason);
  }
  for (const entry of records) {
    if (entry.group === "needsHuman") addBlocked(entry.runtimeId, entry.record.reason);
  }

  return { report, records, blocked };
}

async function reconcileOrphansBeforeRun(
  repoRoot: string,
  command: "start" | "resume",
): Promise<void> {
  const outcome = await reconcileRuntimeOrphans(repoRoot);
  if (outcome.blocked.length === 0) return;

  const detail = outcome.blocked
    .map(
      (entry) =>
        `${entry.runtimeId ?? "<unidentified runtime>"}: ${entry.reason}`,
    )
    .join("; ");
  throw new Error(
    `supervisor ${command}: orphan runtime reconciliation needs human review ` +
      `for ${outcome.blocked.length} candidate(s): ${detail}; ` +
      "resolve the preserved runtime evidence, then rerun " +
      `(inspect with "cliyard supervisor reap --repo ${repoRoot} --json")`,
  );
}

function printReconciliation(
  outcome: ReconciliationOutcome,
  log: (line: string) => void,
): void {
  const { report } = outcome;
  log(`scanned: ${report.scanned}`);
  log(`reaped: ${report.reaped.length}`);
  log(`needs human: ${report.needsHuman.length}`);
  log(`skipped: ${report.skipped.length}`);
  for (const entry of outcome.records) {
    const label = entry.group === "needsHuman" ? "needs human" : entry.group;
    log(
      `${label}${entry.runtimeId ? ` ${entry.runtimeId}` : ""}: ` +
        entry.record.reason,
    );
    for (const service of entry.record.services) {
      log(
        `  service ${service.name}: ${service.action}` +
          (service.portReleased ? " (port lease released)" : ""),
      );
    }
  }
}

function planKey(state: RuntimeReapPlanState, reason: string): string {
  return `${state} ${reason}`;
}

function sameRecovery(
  a: RuntimeRecoveryRecord,
  b: RuntimeRecoveryRecord,
): boolean {
  if (
    a.state !== b.state ||
    a.reason !== b.reason ||
    a.at !== b.at ||
    a.reaperPid !== b.reaperPid ||
    a.reaperHost !== b.reaperHost ||
    a.services.length !== b.services.length
  ) {
    return false;
  }
  return a.services.every((service, index) => {
    const other = b.services[index]!;
    return (
      service.name === other.name &&
      service.pgid === other.pgid &&
      service.action === other.action &&
      service.portReleased === other.portReleased
    );
  });
}

/** Read persisted recovery evidence without planning or mutating anything. */
function readRuntimeRecoveryRecords(
  repoRoot: string,
): SupervisorRuntimeRecovery[] {
  const runtimeDir = portAllocatorPaths(repoRoot).runtimeDir;
  let entries: Dirent[];
  try {
    entries = readdirSync(runtimeDir, { withFileTypes: true });
  } catch {
    // Status/read-only callers must stay usable without runtime state.
    return [];
  }

  const records: SupervisorRuntimeRecovery[] = [];
  for (const entry of entries
    .filter((candidate) => candidate.isDirectory())
    .sort((a, b) => a.name.localeCompare(b.name))) {
    const path = join(runtimeDir, entry.name, RUNTIME_MANIFEST_FILE);
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    } catch {
      continue;
    }
    if (!isRecord(parsed)) continue;
    const recovery = parsed.recovery;
    if (!isRuntimeRecoveryRecord(recovery)) continue;

    const runtimeId =
      typeof parsed.runtimeId === "string" && parsed.runtimeId.trim() !== ""
        ? parsed.runtimeId
        : entry.name;
    const cleanup = isRuntimeCleanupState(parsed.cleanup)
      ? parsed.cleanup
      : undefined;
    records.push({
      runtimeId,
      ...(cleanup !== undefined ? { cleanup } : {}),
      recovery,
    });
  }
  return records;
}

function isRuntimeCleanupState(value: unknown): value is RuntimeCleanupState {
  return (
    value === "pending" ||
    value === "running" ||
    value === "complete" ||
    value === "failed"
  );
}

function isRuntimeRecoveryRecord(
  value: unknown,
): value is RuntimeRecoveryRecord {
  if (!isRecord(value)) return false;
  return (
    (value.state === "reaped" ||
      value.state === "needs_human" ||
      value.state === "skipped") &&
    typeof value.reason === "string" &&
    typeof value.at === "string" &&
    typeof value.reaperPid === "number" &&
    typeof value.reaperHost === "string" &&
    Array.isArray(value.services)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// ---------------------------------------------------------------------------
// Shared batch execution
// ---------------------------------------------------------------------------

interface ExecuteRunInput {
  repoRoot: string;
  manifest: RunManifest;
  lock: SupervisorLockHandle;
  rest: string[];
  options: SupervisorCliOptions;
  log: (line: string) => void;
  resumed: boolean;
}

async function executeRun(input: ExecuteRunInput): Promise<number> {
  const { repoRoot, manifest, lock, rest, options, log, resumed } = input;
  const removeSignals = installSignalHandlers(
    repoRoot,
    manifest.runId,
    lock,
    options,
  );

  try {
    const result = await runCodexBatch({
      contractsPath: manifest.contractsPath,
      repoRoot,
      ledgerPath:
        arg("--ledger", rest) ?? join(repoRoot, ".cliyard", "ledger.json"),
      worker: workerFrom(rest),
      model: arg("--model", rest),
      dryRun: has("--dry-run", rest),
      keepWorktrees: has("--keep-worktrees", rest),
      verbose: has("--verbose", rest),
      runManifest: manifest,
      workerFactory: options.workerFactory,
    });
    const finalManifest =
      result.manifest ?? loadRunManifest(repoRoot, manifest.runId);
    log(JSON.stringify(summarizeRun(finalManifest, result, resumed), null, 2));
    return finalManifest.status === "completed" ? 0 : 1;
  } catch (error) {
    markInterrupted(repoRoot, manifest.runId);
    throw error;
  } finally {
    removeSignals();
    lock.release();
  }
}

function summarizeRun(
  manifest: RunManifest,
  result: CodexBatchResult,
  resumed: boolean,
): Record<string, unknown> {
  const counts = taskCounts(manifest);
  return {
    runId: manifest.runId,
    planId: manifest.planId,
    status: manifest.status,
    resumed,
    accepted: counts.accepted,
    pending: counts.pending,
    blocked: counts.blocked,
    total: counts.total,
    startOrder: result.startOrder,
    waves: result.waves,
    skipped: result.skipped,
    allAccepted: result.allAccepted,
    integration: result.integration,
    integrationHead: manifest.integrationHead,
    tasks: Object.values(manifest.tasks).map((task) => ({ ...task })),
    ledgerPath: result.ledgerPath,
  };
}

function taskCounts(manifest: RunManifest): {
  total: number;
  accepted: number;
  pending: number;
  blocked: number;
} {
  const tasks = Object.values(manifest.tasks);
  const accepted = tasks.filter((task) => task.accepted).length;
  return {
    total: tasks.length,
    accepted,
    pending: tasks.length - accepted,
    blocked: tasks.filter(
      (task) => !task.accepted && task.status === "blocked",
    ).length,
  };
}

function installSignalHandlers(
  repoRoot: string,
  runId: string,
  lock: SupervisorLockHandle,
  options: SupervisorCliOptions,
): () => void {
  if (options.signalHandling === false) return () => undefined;

  const shutdown = (code: number) => {
    markInterrupted(repoRoot, runId);
    lock.release();
    process.exit(code);
  };
  const onSigint = () => shutdown(130);
  const onSigterm = () => shutdown(143);
  process.on("SIGINT", onSigint);
  process.on("SIGTERM", onSigterm);
  return () => {
    process.off("SIGINT", onSigint);
    process.off("SIGTERM", onSigterm);
  };
}

function markInterrupted(repoRoot: string, runId: string): void {
  try {
    updateRunManifest(repoRoot, runId, (manifest) => {
      if (manifest.status === "running") manifest.status = "interrupted";
    });
  } catch {
    /* best-effort: existing checkpoints are already durable */
  }
}

// ---------------------------------------------------------------------------
// Argument / git helpers
// ---------------------------------------------------------------------------

function repoFrom(argv: string[]): string {
  return resolve(arg("--repo", argv) ?? process.cwd());
}

function workerFrom(argv: string[]): "codex" | "claude" {
  const raw = arg("--worker", argv) ?? "claude";
  if (raw !== "codex" && raw !== "claude") {
    throw new Error(`supervisor: --worker must be codex or claude (got ${raw})`);
  }
  return raw;
}

function resolveSharedBaseCommit(
  repoRoot: string,
  contracts: TaskContract[],
): string {
  if (contracts.length === 0) {
    throw new Error("supervisor: contracts contain no tasks");
  }
  const bases = new Set<string>();
  for (const contract of contracts) {
    bases.add(resolveCommit(repoRoot, contract.baseCommit?.trim() || "HEAD"));
  }
  if (bases.size !== 1) {
    throw new Error(
      "supervisor: all contracts must resolve to one base commit; got " +
        [...bases].join(", "),
    );
  }
  return [...bases][0]!;
}

function resolveCommit(repoRoot: string, revision: string): string {
  const result = git(repoRoot, [
    "rev-parse",
    "--verify",
    `${revision}^{commit}`,
  ]);
  if (result.status !== 0) {
    throw new Error(
      `supervisor: cannot resolve git revision "${revision}" in ${repoRoot}: ` +
        ((result.stderr || result.stdout).trim() ||
          `git exited ${result.status}`),
    );
  }
  return result.stdout.trim();
}

function tryResolveCommit(
  repoRoot: string,
  revision: string,
): string | undefined {
  const result = git(repoRoot, [
    "rev-parse",
    "--verify",
    `${revision}^{commit}`,
  ]);
  return result.status === 0 ? result.stdout.trim() : undefined;
}

function git(cwd: string, args: string[]) {
  return spawnSync("git", args, { cwd, encoding: "utf8" });
}

function arg(flag: string, argv: string[]): string | undefined {
  const i = argv.indexOf(flag);
  if (i >= 0 && argv[i + 1] !== undefined && !argv[i + 1]!.startsWith("--")) {
    return argv[i + 1];
  }
  const eq = argv.find((value) => value.startsWith(`${flag}=`));
  return eq?.slice(flag.length + 1);
}

function has(flag: string, argv: string[]): boolean {
  return argv.includes(flag);
}

const VALUE_FLAGS = new Set([
  "--repo",
  "--run",
  "--worker",
  "--model",
  "--ledger",
  "--plan-id",
]);

function positionalArg(argv: string[]): string | undefined {
  for (let i = 0; i < argv.length; i += 1) {
    const value = argv[i]!;
    if (value.startsWith("--")) {
      if (VALUE_FLAGS.has(value)) i += 1;
      continue;
    }
    return value;
  }
  return undefined;
}

function printUsage(log: (line: string) => void): void {
  log(`cliyard supervisor — durable foreground supervisor (V0)

Usage:
  cliyard supervisor start <contracts.json> --repo <path> [--worker claude|codex]
                                [--model id] [--plan-id id] [--ledger path]
                                [--dry-run] [--keep-worktrees] [--verbose]
  cliyard supervisor status --repo <path> [--run id] [--json]
  cliyard supervisor resume --repo <path> [--run id] [--worker claude|codex]
                            [--model id] [--dry-run] [--keep-worktrees]
                            [--retry-rejected] [--force] [--verbose]
  cliyard supervisor reap --repo <path> [--json]
  cliyard supervisor stop --repo <path> [--run id] [--force]

Foreground only: start/resume hold .cliyard/supervisor.lock until exit.
Resume rejects changed contracts, a moved base commit, or a missing
integration branch, and never reruns accepted tasks.
Start/resume reap proven orphaned runtimes after acquiring the lock and fail
closed when any runtime needs human review. Status only reads persisted
recovery records; it never reconciles.`);
}

/**
 * Managed worker CLI process trees (design/worker-process-tree-v1.md).
 *
 * A worker CLI may start long-lived descendants (test runners, shells). Killing
 * only the direct child leaves those descendants reparented and still running.
 * On POSIX the worker CLI is therefore spawned `detached`, which makes it the
 * leader of a dedicated process group. The exact `(pid, pgid, lstart)` identity
 * is captured immediately after spawn with the read-only
 * {@link ProcessInspector}; cleanup then signals only that dedicated group.
 *
 * Descendants can escape that group by creating their own session/group
 * (`setsid`, a detached test runner). While the worker leader is alive, a
 * low-frequency bounded sampler records the recursively related descendants
 * from process-table snapshots. At cleanup a fresh snapshot is merged, and each
 * observed external-group descendant is revalidated by exact
 * `(pid, pgid, lstart)` and signalled by exact pid only.
 *
 * Safety rules:
 * - A group signal requires `pgid === worker pid` (the dedicated group created
 *   by `setsid`), a re-listed membership that still belongs to it, and proof
 *   that the group is not cliyard's own group. Anything less fails closed.
 * - Descendant snapshots are rooted at the worker leader and are used only
 *   when its exact identity still matches; a reused pid never contributes
 *   descendants.
 * - An external descendant is signalled only after a fresh identity re-read
 *   matches pid, pgid and lstart, and only when it is neither in the managed
 *   group nor in cliyard's group.
 * - No `pkill`, process-name matching or workspace-wide scan is ever used.
 * - The record never carries the command line, prompt, environment or an
 *   unbounded process list.
 * - Windows has no POSIX process group here. The record states that limitation
 *   and cleanup only ever signals the exact direct child.
 */
import {
  spawn,
  type ChildProcess,
  type SpawnOptions,
} from "node:child_process";
import {
  MAX_PROCESS_TABLE_ROWS,
  ProcessInspector,
  compareProcessIdentity,
  isProcessIdentity,
  isProcessPid,
  type ProcessGroupMember,
  type ProcessTableEntry,
  type ProcessTableSnapshotOptions,
} from "../runtime/process.js";
import type { RuntimeProcessIdentity } from "../runtime/types.js";
import {
  boundFailureText,
  createFailureRecord,
  type FailureRecord,
} from "../failures.js";

export const WORKER_PROCESS_RECORD_VERSION = 1 as const;
/** Maximum persisted process-tree records for one worker result/attempt. */
export const MAX_WORKER_PROCESS_RECORDS = 16;
/** Maximum persisted residual member identities in one record. */
export const MAX_PROCESS_TREE_MEMBERS = 32;
/** Maximum persisted signal attempts in one record. */
export const MAX_PROCESS_TREE_SIGNALS = 64;
/** Maximum persisted free-form detail length. */
export const MAX_PROCESS_TREE_DETAIL = 600;
/** Hard bound for the observed residual count (evidence only). */
export const MAX_PROCESS_TREE_RESIDUAL_COUNT = 100_000;
/** Maximum exact external descendant identities persisted in one record. */
export const MAX_PERSISTED_EXTERNAL_DESCENDANTS = 32;
/** Maximum external process-group ids persisted in one record. */
export const MAX_PERSISTED_EXTERNAL_GROUPS = 16;
/** Maximum external descendant pids observed per worker (evidence count). */
export const MAX_SAMPLED_DESCENDANTS = 256;
/** Maximum descendant identities tracked in memory per worker. */
export const MAX_TRACKED_DESCENDANTS = 64;
/** Maximum external descendants signalled individually in one cleanup. */
export const MAX_NESTED_SIGNAL_TARGETS = 32;
/** Descendant sampling is deliberately slower than cleanup polling. */
export const MIN_DESCENDANT_POLL_MS = 250;
export const DEFAULT_DESCENDANT_POLL_MS = MIN_DESCENDANT_POLL_MS;
export const DEFAULT_TERM_GRACE_MS = 2_000;
export const DEFAULT_KILL_GRACE_MS = 1_000;
export const DEFAULT_POLL_MS = 50;

export type WorkerCleanupReason =
  | "child-close"
  | "timeout"
  | "cancel"
  | "spawn-error";

/**
 * Terminal cleanup state.
 * - `clean`: nothing in the managed group needed a signal.
 * - `terminated`: at least one signal was delivered and the group is gone.
 * - `failed`: identity, inspection or termination stayed ambiguous; a success
 *   result must fail closed.
 * - `unsupported`: this platform has no managed group (Windows); only the
 *   direct child was ever signaled. This is a documented limitation, not a
 *   claim that descendants were cleaned.
 */
export type WorkerCleanupState = "clean" | "terminated" | "failed" | "unsupported";

/**
 * - `ps-exact`: exact leader identity captured immediately after spawn.
 * - `pgid-reservation`: the leader had already exited, and the dedicated group
 *   id was proven to still be reserved by remaining members.
 * - `none`: no process was created, or the group was already empty.
 * - `unsupported`: the platform has no inspectable process group.
 */
export type WorkerCaptureSource =
  | "ps-exact"
  | "pgid-reservation"
  | "none"
  | "unsupported";

export type WorkerCaptureSupport =
  | "posix-process-group"
  | "windows-exact-child"
  | "unsupported-platform";

/**
 * - `process-group`: the dedicated managed worker group.
 * - `pid`: the exact direct worker child (Windows/exact-child fallback).
 * - `descendant-pid`: one revalidated external-group descendant pid.
 */
export type WorkerProcessSignalScope = "process-group" | "pid" | "descendant-pid";

export interface WorkerProcessSignalRecord {
  signal: "SIGTERM" | "SIGKILL";
  scope: WorkerProcessSignalScope;
  /** Present only for `descendant-pid`: the exact signalled pid. */
  pid?: number;
  at: string;
  result: "sent" | "failed";
  detail?: string;
}

/**
 * - `none`: no external-group descendant was ever observed.
 * - `clean`: observed external descendants were already gone at cleanup.
 * - `terminated`: at least one exact descendant pid was signalled and is gone.
 * - `failed`: nested cleanup stayed ambiguous; a success result fails closed.
 */
export type WorkerNestedCleanupState = "none" | "clean" | "terminated" | "failed";

/** Bounded outcome of cleaning descendants that left the managed group. */
export interface WorkerNestedCleanupEvidence {
  state: WorkerNestedCleanupState;
  /** External descendant pids observed by the sampler/cleanup snapshot. */
  observedDescendants: number;
  /** Exact descendant pids that received at least one signal. */
  signalledDescendants: number;
  /** External descendant pids that could not be proven gone. */
  residualDescendants: number;
  detail?: string;
}

/**
 * Bounded, credential-free evidence for one managed worker process tree.
 * `identity` is the exact OS-reported leader identity when it was capturable.
 *
 * Version 1 stays readable by older readers: the external-descendant fields
 * and `nestedCleanup` are optional and only written when observed.
 */
export interface WorkerProcessRecord {
  version: typeof WORKER_PROCESS_RECORD_VERSION;
  host: string;
  /** Direct worker child pid; absent only when it never spawned. */
  pid?: number;
  /** Dedicated process-group id when known. Never guessed. */
  pgid?: number;
  identity?: RuntimeProcessIdentity;
  captureSource: WorkerCaptureSource;
  captureSupport: WorkerCaptureSupport;
  cleanupReason: WorkerCleanupReason;
  cleanupState: WorkerCleanupState;
  signals: WorkerProcessSignalRecord[];
  /** Bounded residual group members observed while cleaning. */
  residualMembers: RuntimeProcessIdentity[];
  /** Actual residual member count observed (may exceed the bounded list). */
  residualCount: number;
  /** Bounded exact identities of descendants observed outside the group. */
  observedExternalDescendants?: RuntimeProcessIdentity[];
  /** Actual external descendant pid count (may exceed the bounded list). */
  observedExternalDescendantCount?: number;
  /** Bounded external process-group ids observed for those descendants. */
  observedExternalGroups?: number[];
  /** Nested cleanup outcome; absent when external descendants were never observed. */
  nestedCleanup?: WorkerNestedCleanupEvidence;
  exitCode?: number;
  exitSignal?: string;
  startedAt: string;
  closedAt?: string;
  cleanedAt?: string;
  detail?: string;
}

export interface WorkerProcessCleanupOutcome {
  record: WorkerProcessRecord;
  /**
   * `false` only when cleanup remained ambiguous/failed. A `true` outcome may
   * still carry the documented Windows limitation (`unsupported`).
   */
  treeOk: boolean;
}

/** The read-only subset of ProcessInspector this module needs. */
export interface WorkerProcessTreeInspector {
  readonly host: string;
  readonly supported: boolean;
  isAlive(pid: number | undefined): boolean;
  capture(pid: number | undefined): Promise<RuntimeProcessIdentity | undefined>;
  listGroupMembers(pgid: number | undefined): Promise<ProcessGroupMember[]>;
  /**
   * Optional so older inspectors keep compiling. Without it, descendants that
   * left the managed group cannot be discovered; the documented limitation is
   * preserved instead of guessing.
   */
  snapshotProcessTable?(
    options?: ProcessTableSnapshotOptions,
  ): Promise<ProcessTableEntry[]>;
}

export interface WorkerProcessTreeManagerOptions {
  inspector?: WorkerProcessTreeInspector;
  /** Platform gate; defaults to `process.platform`. Tests may simulate it. */
  platform?: NodeJS.Platform;
  termGraceMs?: number;
  killGraceMs?: number;
  pollMs?: number;
  /**
   * Descendant sampler interval. Values below
   * {@link MIN_DESCENDANT_POLL_MS} are rejected; never a tight poll.
   */
  descendantPollMs?: number;
}

export interface WorkerProcessIdentityCapture {
  identity?: RuntimeProcessIdentity;
  /** Bounded capture error; identity stays absent when capture did not prove it. */
  error?: string;
}

export interface ManagedWorkerProcess {
  readonly child: ChildProcess;
  readonly pid: number | undefined;
  /** Platform capture mode for this managed invocation. */
  readonly captureSupport: WorkerCaptureSupport;
  /**
   * Exact OS identity captured immediately after spawn. Resolves with no
   * identity (never a guessed one) when the process was too short-lived or the
   * platform cannot inspect process groups.
   */
  captureIdentity(): Promise<WorkerProcessIdentityCapture>;
  /**
   * Idempotent cleanup. The first call fixes the recorded reason; concurrent
   * and later calls resolve with the same outcome. Never rejects.
   */
  cleanup(reason: WorkerCleanupReason): Promise<WorkerProcessCleanupOutcome>;
}

interface CaptureResult {
  identity: RuntimeProcessIdentity | undefined;
  error?: string;
}

interface NestedPlan {
  /** External descendants that were revalidated and sent SIGTERM. */
  targets: RuntimeProcessIdentity[];
  /** External descendants that could not be safely signalled. */
  refused: RuntimeProcessIdentity[];
  failure?: string;
}

interface DescendantCheck {
  kind: "safe" | "skipped" | "gone" | "refused";
  identity?: RuntimeProcessIdentity;
  reason?: string;
}

interface GroupCleanupOutcome {
  state: "clean" | "terminated" | "failed";
  residual: RuntimeProcessIdentity[];
  failure?: string;
}

const CLEANUP_REASONS: ReadonlySet<string> = new Set<WorkerCleanupReason>([
  "child-close",
  "timeout",
  "cancel",
  "spawn-error",
]);
const TERMINAL_STATES: ReadonlySet<string> = new Set<WorkerCleanupState>([
  "clean",
  "terminated",
  "failed",
  "unsupported",
]);
const NESTED_STATES: ReadonlySet<string> = new Set<WorkerNestedCleanupState>([
  "none",
  "clean",
  "terminated",
  "failed",
]);
const CAPTURE_SOURCES: ReadonlySet<string> = new Set<WorkerCaptureSource>([
  "ps-exact",
  "pgid-reservation",
  "none",
  "unsupported",
]);
const CAPTURE_SUPPORTS: ReadonlySet<string> = new Set<WorkerCaptureSupport>([
  "posix-process-group",
  "windows-exact-child",
  "unsupported-platform",
]);

/** Shared manager: one per adapter (or test) is sufficient. */
export class WorkerProcessTreeManager {
  readonly platform: NodeJS.Platform;
  readonly inspector: WorkerProcessTreeInspector;
  readonly termGraceMs: number;
  readonly killGraceMs: number;
  readonly pollMs: number;
  readonly descendantPollMs: number;
  private ownGroupIdPromise: Promise<number | undefined> | undefined;

  constructor(options: WorkerProcessTreeManagerOptions = {}) {
    if (options === null || typeof options !== "object") {
      throw new Error("WorkerProcessTreeManager options must be an object");
    }
    this.platform = options.platform ?? process.platform;
    this.inspector = options.inspector ?? new ProcessInspector();
    if (typeof this.inspector.host !== "string" || !this.inspector.host) {
      throw new Error("WorkerProcessTreeManager inspector has no host");
    }
    this.termGraceMs = positiveBound(
      options.termGraceMs,
      DEFAULT_TERM_GRACE_MS,
      "termGraceMs",
    );
    this.killGraceMs = positiveBound(
      options.killGraceMs,
      DEFAULT_KILL_GRACE_MS,
      "killGraceMs",
    );
    this.pollMs = positiveBound(options.pollMs, DEFAULT_POLL_MS, "pollMs");
    this.descendantPollMs = boundedInterval(
      options.descendantPollMs,
      DEFAULT_DESCENDANT_POLL_MS,
      MIN_DESCENDANT_POLL_MS,
      "descendantPollMs",
    );
  }

  /** Whether POSIX group capture/inspection is available here. */
  get posixGroups(): boolean {
    return this.platform !== "win32" && this.inspector.supported;
  }

  /** Whether a bounded process-table snapshot can discover descendants. */
  get descendantInspection(): boolean {
    return (
      this.posixGroups &&
      typeof this.inspector.snapshotProcessTable === "function"
    );
  }

  captureSupport(): WorkerCaptureSupport {
    if (this.platform === "win32") return "windows-exact-child";
    return this.posixGroups ? "posix-process-group" : "unsupported-platform";
  }

  /**
   * Spawn a worker CLI detached on POSIX so it leads a dedicated group. The
   * Windows spawn stays in the caller's console; no group is claimed.
   */
  spawn(
    command: string,
    args: readonly string[] = [],
    options: SpawnOptions = {},
  ): ManagedWorkerProcess {
    if (typeof command !== "string" || command.trim() === "") {
      throw new Error("worker command must be a non-empty string");
    }
    const child = spawn(command, [...args], {
      ...options,
      detached: this.platform !== "win32",
    });
    return this.manage(child);
  }

  /** Adopt an already-spawned child (for example a test fixture). */
  manage(child: ChildProcess): ManagedWorkerProcess {
    if (child === null || typeof child !== "object") {
      throw new Error("managed worker child must be a ChildProcess");
    }
    if (child.pid !== undefined && !isProcessPid(child.pid)) {
      throw new Error("managed worker child has an invalid pid");
    }
    return new ManagedWorkerProcessImpl(this, child);
  }

  /**
   * cliyard's own process-group id, cached. Used only to refuse a group signal
   * that could touch the orchestrator. A failed lookup fails closed.
   */
  ownGroupId(): Promise<number | undefined> {
    this.ownGroupIdPromise ??= this.inspector
      .capture(process.pid)
      .then((identity) => (identity ? identity.pgid : undefined))
      .catch(() => undefined);
    return this.ownGroupIdPromise;
  }

  listMembers(pgid: number): Promise<ProcessGroupMember[]> {
    return this.inspector.listGroupMembers(pgid);
  }

  /**
   * Call the optional snapshot with its owning inspector as `this`; the
   * concrete ProcessInspector method relies on instance state.
   */
  snapshotTable(
    options: ProcessTableSnapshotOptions = {},
  ): Promise<ProcessTableEntry[]> {
    const snapshot = this.inspector.snapshotProcessTable;
    if (!snapshot) {
      return Promise.reject(
        new Error("process-table snapshots are unavailable for this inspector"),
      );
    }
    return snapshot.call(this.inspector, options);
  }

  isAlive(pid: number | undefined): boolean {
    return this.inspector.isAlive(pid);
  }
}

class ManagedWorkerProcessImpl implements ManagedWorkerProcess {
  readonly child: ChildProcess;
  private readonly manager: WorkerProcessTreeManager;
  private readonly startedAt: string;
  private readonly capturePromise: Promise<CaptureResult>;
  private readonly captureSupportValue: WorkerCaptureSupport;
  private readonly signals: WorkerProcessSignalRecord[] = [];
  private readonly trackedDescendants = new Map<number, RuntimeProcessIdentity>();
  private readonly observedExternalPids = new Set<number>();
  private readonly observedExternal = new Map<number, RuntimeProcessIdentity>();
  private readonly observedExternalGroupIds = new Set<number>();
  private readonly signalledDescendantPids = new Set<number>();
  private nestedCleanup: WorkerNestedCleanupEvidence | undefined;
  private samplerLeader: RuntimeProcessIdentity | undefined;
  private samplerTimer: NodeJS.Timeout | undefined;
  private samplerInFlight: Promise<void> | undefined;
  private samplerStopped = false;
  private samplerError: string | undefined;
  private residualMembers: RuntimeProcessIdentity[] = [];
  private residualCount = 0;
  private closedAt: string | undefined;
  private exitCode: number | undefined;
  private exitSignal: string | undefined;
  private spawnErrorText: string | undefined;
  private cleanupReason: WorkerCleanupReason | undefined;
  private cleanupPromise: Promise<WorkerProcessCleanupOutcome> | undefined;
  private outcome: WorkerProcessCleanupOutcome | undefined;

  constructor(manager: WorkerProcessTreeManager, child: ChildProcess) {
    this.manager = manager;
    this.child = child;
    this.startedAt = new Date().toISOString();
    this.captureSupportValue = manager.captureSupport();
    // Start identity capture synchronously after spawn: first, so the ps child
    // observes the worker before an extremely short CLI can exit.
    this.capturePromise = this.startCapture();
    if (manager.descendantInspection) {
      void this.capturePromise.then((capture) => {
        // Sampling needs a proven leader identity: a bare pid may be reused.
        if (
          capture.identity &&
          capture.identity.pid === this.child.pid &&
          this.closedAt === undefined &&
          this.cleanupPromise === undefined
        ) {
          this.startSampler(capture.identity);
        }
      });
    }
    child.on("exit", (code, signal) => {
      if (this.closedAt === undefined) {
        this.closedAt = new Date().toISOString();
        this.exitCode = code ?? undefined;
        this.exitSignal = signal ?? undefined;
      }
      // No further descendant scan is useful once the leader exited, and a reused
      // pid must never be followed. Cleanup awaits any in-flight sample.
      void this.stopSampler();
      // Residual descendants may keep the stdio pipes open; clean the managed
      // group immediately instead of waiting for a close that may never come.
      void this.cleanup("child-close");
    });
    child.on("error", (error) => {
      if (this.spawnErrorText === undefined) {
        this.spawnErrorText = error instanceof Error ? error.message : String(error);
      }
      void this.cleanup("spawn-error");
    });
  }

  get pid(): number | undefined {
    return this.child.pid;
  }

  get captureSupport(): WorkerCaptureSupport {
    return this.captureSupportValue;
  }

  captureIdentity(): Promise<WorkerProcessIdentityCapture> {
    return this.capturePromise.then((capture) => ({
      ...(capture.identity ? { identity: copyIdentity(capture.identity) } : {}),
      ...(capture.error !== undefined
        ? { error: boundDetail(capture.error) }
        : {}),
    }));
  }

  cleanup(reason: WorkerCleanupReason): Promise<WorkerProcessCleanupOutcome> {
    if (!this.cleanupPromise) {
      this.cleanupReason = reason;
      this.cleanupPromise = this.run(reason).catch(async (error) => {
        await this.stopSampler();
        return this.finishFailed(
          reason,
          `cleanup crashed: ${errorText(error)}`,
          undefined,
          undefined,
          "none",
        );
      });
    }
    return this.cleanupPromise;
  }

  private async startCapture(): Promise<CaptureResult> {
    if (!this.manager.posixGroups || !isProcessPid(this.child.pid)) {
      return { identity: undefined };
    }
    try {
      const identity = await this.manager.inspector.capture(this.child.pid);
      return { identity };
    } catch (error) {
      return { identity: undefined, error: errorText(error) };
    }
  }

  /**
   * Start the low-frequency descendant sampler. It never runs without a proven
   * leader identity: walking a bare, possibly reused pid could attribute an
   * unrelated process tree to this worker.
   */
  private startSampler(leader: RuntimeProcessIdentity): void {
    if (
      this.samplerStopped ||
      this.samplerTimer !== undefined ||
      this.manager.descendantInspection === false
    ) {
      return;
    }
    this.samplerLeader = copyIdentity(leader);
    const tick = (): void => {
      if (this.samplerStopped || this.samplerInFlight !== undefined) return;
      this.samplerInFlight = this.sampleOnce()
        .catch((error) => {
          this.noteSamplerError(`descendant sampling failed: ${errorText(error)}`);
        })
        .finally(() => {
          this.samplerInFlight = undefined;
        });
    };
    tick();
    this.samplerTimer = setInterval(tick, this.manager.descendantPollMs);
    // Cleanup-driven workers must not keep a finished process alive.
    this.samplerTimer.unref();
  }

  private async sampleOnce(): Promise<void> {
    const leader = this.samplerLeader;
    if (!leader || !this.manager.descendantInspection || this.samplerStopped) {
      return;
    }
    const table = await this.manager.snapshotTable({
      maxEntries: MAX_PROCESS_TABLE_ROWS,
    });
    if (this.samplerStopped) return;
    const result = this.recordSnapshot(table, leader.pid, leader.pgid, leader);
    if (result === "invalid-root") {
      // The leader exited or the pid was reused. Stop immediately; the tracked
      // identities are revalidated individually before cleanup signals them.
      this.haltSampler();
      return;
    }
    if (result === "incomplete") {
      this.noteSamplerError(
        `descendant snapshot exceeds ${MAX_SAMPLED_DESCENDANTS} related processes`,
      );
    }
  }

  /** Stop scheduling samples and wait for any in-flight sample to finish. */
  private stopSampler(): Promise<void> {
    this.haltSampler();
    return this.samplerInFlight ?? Promise.resolve();
  }

  private haltSampler(): void {
    this.samplerStopped = true;
    if (this.samplerTimer !== undefined) {
      clearInterval(this.samplerTimer);
      this.samplerTimer = undefined;
    }
  }

  private noteSamplerError(detail: string): void {
    this.samplerError ??= detail;
  }

  /**
   * Merge one bounded process-table snapshot into the tracked descendant set.
   *
   * Returns `invalid-root` when the snapshot does not contain this exact
   * leader identity; such a snapshot contributes nothing. Relationship rows are
   * walked only from that validated root.
   */
  private recordSnapshot(
    table: readonly ProcessTableEntry[],
    rootPid: number,
    managedPgid: number,
    expected: RuntimeProcessIdentity | undefined,
  ): "ok" | "invalid-root" | "incomplete" {
    if (!expected) return "invalid-root";
    const children = new Map<number, ProcessTableEntry[]>();
    let root: ProcessTableEntry | undefined;
    for (const entry of table) {
      if (entry.pid === rootPid) {
        root = entry;
        continue;
      }
      const siblings = children.get(entry.ppid);
      if (siblings) siblings.push(entry);
      else children.set(entry.ppid, [entry]);
    }
    if (!root || compareProcessIdentity(expected, root) !== "match") {
      return "invalid-root";
    }

    const queue = [rootPid];
    const seen = new Set<number>([rootPid]);
    let visited = 0;
    while (queue.length > 0) {
      const parent = queue.shift() as number;
      for (const child of children.get(parent) ?? []) {
        if (seen.has(child.pid)) continue;
        seen.add(child.pid);
        visited += 1;
        if (visited > MAX_SAMPLED_DESCENDANTS) return "incomplete";
        this.noteDescendant(child, managedPgid);
        queue.push(child.pid);
      }
    }
    return "ok";
  }

  private noteDescendant(
    entry: ProcessTableEntry,
    managedPgid: number,
  ): void {
    // A row with pgid 0 is a kernel thread (Linux). It cannot be a user
    // descendant and cannot carry a revalidatable identity, so it never
    // enters the tracked/signal candidate set.
    if (!isProcessPid(entry.pgid)) return;
    if (isProcessPid(entry.pid) && entry.pid > 1 && entry.pid !== process.pid) {
      if (
        this.trackedDescendants.has(entry.pid) ||
        this.trackedDescendants.size < MAX_TRACKED_DESCENDANTS
      ) {
        this.trackedDescendants.set(entry.pid, copyIdentity(entry));
      }
    }
    if (entry.pgid === managedPgid) return;
    if (!isProcessPid(entry.pid) || entry.pid <= 1 || entry.pid === process.pid) {
      return;
    }
    if (this.observedExternalPids.size < MAX_SAMPLED_DESCENDANTS) {
      this.observedExternalPids.add(entry.pid);
    }
    // Keep the in-memory candidate set at the sampled-pid bound, not the
    // smaller persistence bound: every observed external pid must reach
    // `prepareNested`, which fails closed when more than the 32-target signal
    // bound exist. Persistence is sliced separately in `build`.
    if (
      this.observedExternal.has(entry.pid) ||
      this.observedExternal.size < MAX_SAMPLED_DESCENDANTS
    ) {
      this.observedExternal.set(entry.pid, copyIdentity(entry));
    }
    if (
      this.observedExternalGroupIds.has(entry.pgid) ||
      this.observedExternalGroupIds.size < MAX_PERSISTED_EXTERNAL_GROUPS
    ) {
      this.observedExternalGroupIds.add(entry.pgid);
    }
  }

  /**
   * Fresh cleanup snapshot. Only a snapshot whose root still matches the
   * captured leader identity contributes; tracked observations remain the
   * fallback when the leader already exited.
   */
  private async refreshDescendants(
    leader: RuntimeProcessIdentity | undefined,
    managedPgid: number,
  ): Promise<{ refreshed: boolean; failure?: string }> {
    if (!this.manager.descendantInspection || !leader) {
      return { refreshed: false };
    }
    try {
      const table = await this.manager.snapshotTable({
        maxEntries: MAX_PROCESS_TABLE_ROWS,
      });
      const result = this.recordSnapshot(
        table,
        leader.pid,
        managedPgid,
        leader,
      );
      if (result === "ok") return { refreshed: true };
      if (result === "incomplete") {
        return {
          refreshed: true,
          failure:
            `descendant snapshot exceeds ${MAX_SAMPLED_DESCENDANTS} related ` +
            "processes; refusing an incomplete nested cleanup",
        };
      }
      // The snapshot did not contain the leader. Distinguish "already exited"
      // from a ps inconsistency: only a still-matching live identity is
      // ambiguous; an absent or changed identity means the leader is gone and
      // the tracked observations remain the fallback.
      let observed: RuntimeProcessIdentity | undefined;
      try {
        observed = await this.manager.inspector.capture(leader.pid);
      } catch (error) {
        return {
          refreshed: false,
          failure:
            "cannot revalidate the worker leader after the process-tree " +
            `snapshot: ${errorText(error)}`,
        };
      }
      if (
        observed &&
        compareProcessIdentity(leader, observed) === "match"
      ) {
        return {
          refreshed: false,
          failure:
            "cannot revalidate the worker leader in the final process-tree snapshot",
        };
      }
      return { refreshed: false };
    } catch (error) {
      return {
        refreshed: false,
        failure: `cannot snapshot the worker process tree: ${errorText(error)}`,
      };
    }
  }

  /**
   * External descendant candidates: the latest tracked identity per pid,
   * including bounded evidence recorded after the tracked map filled up.
   */
  private externalCandidates(
    managedPgid: number,
  ): RuntimeProcessIdentity[] {
    const union = new Map<number, RuntimeProcessIdentity>(
      this.observedExternal,
    );
    for (const [pid, identity] of this.trackedDescendants) {
      union.set(pid, identity);
    }
    const candidates: RuntimeProcessIdentity[] = [];
    for (const identity of union.values()) {
      if (identity.pgid === managedPgid) continue;
      if (identity.pid === process.pid || identity.pid <= 1) continue;
      candidates.push(copyIdentity(identity));
    }
    candidates.sort((first, second) => first.pid - second.pid);
    return candidates;
  }

  /**
   * Revalidate one external candidate and send SIGTERM by exact pid. Identity
   * mismatches, cliyard's group, pid 1 and cliyard itself are refusals.
   */
  private async prepareNested(
    candidates: readonly RuntimeProcessIdentity[],
    managedPgid: number,
    leaderPid: number,
    priorFailure: string | undefined,
  ): Promise<NestedPlan> {
    let failure = priorFailure;
    const targets: RuntimeProcessIdentity[] = [];
    const refused: RuntimeProcessIdentity[] = [];
    // Cheap liveness pre-filter: evidence can retain identities from earlier
    // samples. Only a pid that is still alive consumes a signal slot; a live
    // pid that cannot be revalidated later is still a refusal.
    const live = candidates.filter((candidate) =>
      this.manager.isAlive(candidate.pid),
    );
    if (live.length === 0) {
      return { targets, refused, ...(failure ? { failure } : {}) };
    }
    if (live.length > MAX_NESTED_SIGNAL_TARGETS) {
      return {
        targets,
        refused: live.slice(0, MAX_NESTED_SIGNAL_TARGETS),
        failure:
          failure ??
          `external descendants exceed the ${MAX_NESTED_SIGNAL_TARGETS}-process ` +
            "signal bound; refusing an incomplete nested cleanup",
      };
    }
    let ownGroupId: number | undefined;
    try {
      ownGroupId = await this.manager.ownGroupId();
    } catch {
      ownGroupId = undefined;
    }
    for (const candidate of live) {
      if (candidate.pid === leaderPid) continue;
      if (candidate.pid === process.pid || candidate.pid <= 1) {
        refused.push(candidate);
        failure ??= `refusing to signal unsafe external pid ${candidate.pid}`;
        continue;
      }
      if (!isProcessPid(ownGroupId) || candidate.pgid === process.pid) {
        refused.push(candidate);
        failure ??=
          "cannot prove external descendants differ from cliyard's process group";
        continue;
      }
      if (candidate.pgid === ownGroupId) {
        refused.push(candidate);
        failure ??= "refusing external descendants in cliyard's process group";
        continue;
      }
      const check = await this.validateDescendant(
        candidate,
        managedPgid,
        ownGroupId,
      );
      if (check.kind === "safe" && check.identity) {
        const signaled = this.signalDescendant(check.identity, "SIGTERM");
        if (signaled === "sent") targets.push(check.identity);
        if (signaled === "error") {
          refused.push(check.identity);
          failure ??=
            `SIGTERM to external descendant pid ${check.identity.pid} failed`;
        }
      } else if (check.kind === "refused") {
        refused.push(candidate);
        failure ??= check.reason ?? "external descendant could not be validated";
      }
      // `skipped`: re-read showed it back in the managed group; the group
      // signal path owns it. `gone`: nothing to signal.
    }
    return { targets, refused, ...(failure ? { failure } : {}) };
  }

  /**
   * Re-read one candidate's exact identity. `skipped` means it is (again) in
   * the managed group; `gone` means the pid is absent; `refused` means the
   * identity cannot authorize a signal.
   */
  private async validateDescendant(
    candidate: RuntimeProcessIdentity,
    managedPgid: number,
    ownGroupId: number,
  ): Promise<DescendantCheck> {
    let observed: RuntimeProcessIdentity | undefined;
    try {
      observed = await this.manager.inspector.capture(candidate.pid);
    } catch (error) {
      return {
        kind: "refused",
        reason:
          `cannot revalidate external descendant pid ${candidate.pid}: ` +
          errorText(error),
      };
    }
    if (!observed) {
      if (this.manager.isAlive(candidate.pid)) {
        return {
          kind: "refused",
          reason:
            `external descendant pid ${candidate.pid} is alive but its ` +
            "identity could not be re-read",
        };
      }
      return { kind: "gone" };
    }
    if (compareProcessIdentity(candidate, observed) !== "match") {
      return {
        kind: "refused",
        reason:
          `external descendant pid ${candidate.pid} identity changed or was reused`,
      };
    }
    if (observed.pgid === ownGroupId || observed.pgid === process.pid) {
      return {
        kind: "refused",
        reason:
          `refusing external descendant pid ${observed.pid} in cliyard's process group`,
      };
    }
    if (observed.pgid === managedPgid) return { kind: "skipped" };
    return { kind: "safe", identity: copyIdentity(observed) };
  }

  private signalDescendant(
    identity: RuntimeProcessIdentity,
    signal: "SIGTERM" | "SIGKILL",
  ): "sent" | "gone" | "error" {
    if (
      !isProcessPid(identity.pid) ||
      identity.pid <= 1 ||
      identity.pid === process.pid
    ) {
      return "error";
    }
    try {
      process.kill(identity.pid, signal);
      this.signalledDescendantPids.add(identity.pid);
      this.recordSignal({
        signal,
        scope: "descendant-pid",
        pid: identity.pid,
        at: new Date().toISOString(),
        result: "sent",
      });
      return "sent";
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return "gone";
      this.recordSignal({
        signal,
        scope: "descendant-pid",
        pid: identity.pid,
        at: new Date().toISOString(),
        result: "failed",
        detail: boundDetail(errorText(error)),
      });
      return "error";
    }
  }

  private async run(reason: WorkerCleanupReason): Promise<WorkerProcessCleanupOutcome> {
    const pid = this.child.pid;
    if (!isProcessPid(pid)) {
      // ENOENT and friends: no process was created, so there is no tree.
      return this.finish("clean", "none", reason);
    }
    if (!this.manager.posixGroups) {
      return this.cleanupWithoutGroups(reason, pid);
    }

    const capture = await this.capturePromise;
    if (capture.error !== undefined) {
      await this.stopSampler();
      return this.failClosed(
        reason,
        `process identity capture failed: ${capture.error}`,
        undefined,
        undefined,
        "none",
      );
    }

    let pgid: number;
    let identity: RuntimeProcessIdentity | undefined;
    let source: WorkerCaptureSource;
    if (capture.identity) {
      identity = capture.identity;
      if (identity.pid !== pid || identity.pgid !== pid) {
        // The child is not leading the dedicated group we asked for. Signalling
        // `identity.pgid` could hit the parent's group; refuse.
        await this.stopSampler();
        return this.failClosed(
          reason,
          "captured identity does not prove a dedicated process group",
          undefined,
          identity,
          "none",
        );
      }
      pgid = identity.pgid;
      source = "ps-exact";
    } else {
      // The leader exited before `ps` could read it. The only acceptable
      // fallback is the freshly spawned group id, and only when remaining
      // members still reserve it. Otherwise fail closed.
      let members: ProcessGroupMember[];
      try {
        members = await this.manager.listMembers(pid);
      } catch (error) {
        await this.stopSampler();
        return this.failClosed(
          reason,
          `cannot inspect the dedicated process group: ${errorText(error)}`,
          pid,
          undefined,
          "none",
        );
      }
      if (members.length === 0) {
        // Nothing remains to signal.
        await this.stopSampler();
        return this.finish("clean", "none", reason, { pgid: pid });
      }
      if (!members.every((member) => member.pgid === pid)) {
        await this.stopSampler();
        return this.failClosed(
          reason,
          "remaining group members do not reserve the spawned group id",
          undefined,
          undefined,
          "none",
        );
      }
      pgid = pid;
      source = "pgid-reservation";
    }

    // Freeze descendant evidence before deriving the final target set. A
    // sample already in flight is awaited so its last observation is included.
    await this.stopSampler();
    const refresh = await this.refreshDescendants(identity, pgid);
    const nestedPriorFailure =
      refresh.failure ?? (refresh.refreshed ? undefined : this.samplerError);

    let members: ProcessGroupMember[];
    try {
      members = await this.manager.listMembers(pgid);
    } catch (error) {
      return this.failClosed(
        reason,
        `cannot inspect the managed process group: ${errorText(error)}`,
        pgid,
        identity,
        source,
      );
    }

    // Nested targets are committed (SIGTERM) before the group signal so a
    // descendant that leaves the group during group cleanup is still covered.
    const candidates = this.externalCandidates(pgid);
    let plan: NestedPlan;
    try {
      plan = await this.prepareNested(candidates, pgid, pid, nestedPriorFailure);
    } catch (error) {
      plan = {
        targets: [],
        refused: candidates,
        failure: `nested cleanup crashed: ${errorText(error)}`,
      };
    }

    const group = await this.cleanManagedGroup(pgid, pid, identity, members);
    const nested = await this.settleNested({
      targets: plan.targets,
      refused: plan.refused,
      managedPgid: pgid,
      failure: plan.failure,
    });
    this.nestedCleanup = nested.evidence;

    const state: WorkerCleanupState =
      group.state === "failed" || nested.evidence?.state === "failed"
        ? "failed"
        : group.state === "terminated" ||
            nested.evidence?.state === "terminated"
          ? "terminated"
          : "clean";
    const detail = combineDetail(group.failure, nested.failure);
    if (state === "failed") {
      // Preserve the adapter's ability to observe a child close; an exact pid
      // signal cannot touch an unrelated group.
      await this.terminateExactChild();
      return this.finishFailed(
        reason,
        detail ?? "process-tree cleanup failed",
        pgid,
        identity,
        source,
      );
    }
    return this.finish(state, source, reason, {
      ...(identity ? { identity } : {}),
      pgid,
      ...(detail !== undefined ? { detail } : {}),
    });
  }

  /**
   * The existing dedicated-group path: SIGTERM, bounded wait, SIGKILL. Only
   * members that stayed in the group are handled here.
   */
  private async cleanManagedGroup(
    pgid: number,
    leaderPid: number,
    identity: RuntimeProcessIdentity | undefined,
    members: ProcessGroupMember[],
  ): Promise<GroupCleanupOutcome> {
    let residual = this.residualOf(members, leaderPid);
    // Record the true residual count before the member list is bounded.
    this.noteResidual(residual);
    if (members.length === 0) return { state: "clean", residual };

    const guard = await this.groupSignalAllowed(pgid, leaderPid, identity, members);
    if (!guard.ok) {
      return { state: "failed", residual, failure: guard.reason };
    }

    const term = this.signalGroup(pgid, "SIGTERM");
    if (term === "error") {
      return {
        state: "failed",
        residual,
        failure: "SIGTERM to the managed process group failed",
      };
    }
    if (term === "sent") {
      try {
        members = await this.waitForEmpty(pgid, this.manager.termGraceMs);
      } catch (error) {
        return {
          state: "failed",
          residual,
          failure:
            "managed process group became uninspectable after SIGTERM: " +
            errorText(error),
        };
      }
      if (members.length === 0) return { state: "terminated", residual: [] };
      const observed = this.residualOf(members, leaderPid);
      this.noteResidual(observed);
      residual = mergeResidual(residual, observed);
      const killGuard = await this.groupSignalAllowed(pgid, leaderPid, identity, members);
      if (!killGuard.ok) {
        return { state: "failed", residual, failure: killGuard.reason };
      }
      const kill = this.signalGroup(pgid, "SIGKILL");
      if (kill === "error") {
        return {
          state: "failed",
          residual,
          failure: "SIGKILL to the managed process group failed",
        };
      }
      if (kill === "gone") return { state: "terminated", residual };
      try {
        members = await this.waitForEmpty(pgid, this.manager.killGraceMs);
      } catch (error) {
        return {
          state: "failed",
          residual,
          failure:
            "managed process group became uninspectable after SIGKILL: " +
            errorText(error),
        };
      }
      if (members.length === 0) return { state: "terminated", residual: [] };
      const remaining = this.residualOf(members, leaderPid);
      this.noteResidual(remaining);
      return {
        state: "failed",
        residual: mergeResidual(residual, remaining),
        failure: `managed process group still has ${members.length} member(s) after SIGKILL`,
      };
    }

    // The group disappeared between listing and signalling; verify and finish.
    try {
      members = await this.manager.listMembers(pgid);
    } catch {
      return {
        state: "failed",
        residual,
        failure: "managed process group disappeared and could not be re-inspected",
      };
    }
    if (members.length === 0) return { state: "clean", residual: [] };
    return {
      state: "failed",
      residual,
      failure: "managed process group could not be signalled",
    };
  }

  /**
   * Wait for SIGTERM'd external descendants, escalate each still-exact pid to
   * SIGKILL, and bound the wait for both phases.
   */
  private async settleNested(options: {
    targets: readonly RuntimeProcessIdentity[];
    refused: readonly RuntimeProcessIdentity[];
    managedPgid: number;
    failure?: string;
  }): Promise<{
    evidence?: WorkerNestedCleanupEvidence;
    failure?: string;
  }> {
    let failure = options.failure;
    const residual = new Set<number>();
    for (const identity of options.refused) {
      if (this.manager.isAlive(identity.pid)) residual.add(identity.pid);
    }
    const hadNestedWork =
      this.observedExternalPids.size > 0 ||
      options.targets.length > 0 ||
      options.refused.length > 0 ||
      failure !== undefined;
    if (!hadNestedWork) return {};

    let ownGroupId: number | undefined;
    try {
      ownGroupId = await this.manager.ownGroupId();
    } catch {
      ownGroupId = undefined;
    }

    let pending = await this.waitForDescendants(
      options.targets,
      Date.now() + this.manager.termGraceMs,
    );
    const killed: RuntimeProcessIdentity[] = [];
    for (const item of pending) {
      if (item.ambiguous) {
        failure ??=
          `external descendant pid ${item.identity.pid} could not be ` +
          "revalidated after SIGTERM";
        residual.add(item.identity.pid);
        continue;
      }
      if (!isProcessPid(ownGroupId)) {
        failure ??=
          "cannot prove external descendants differ from cliyard's process group";
        residual.add(item.identity.pid);
        continue;
      }
      const check = await this.validateDescendant(
        item.identity,
        options.managedPgid,
        ownGroupId,
      );
      if (check.kind === "safe" && check.identity) {
        const signaled = this.signalDescendant(check.identity, "SIGKILL");
        if (signaled === "sent") killed.push(check.identity);
        if (signaled === "error") {
          failure ??=
            `SIGKILL to external descendant pid ${check.identity.pid} failed`;
          residual.add(check.identity.pid);
        }
      } else if (check.kind === "refused") {
        failure ??= check.reason ?? "external descendant could not be validated";
        residual.add(item.identity.pid);
      } else if (check.kind === "skipped") {
        failure ??=
          `external descendant pid ${item.identity.pid} moved into the ` +
          "managed group during cleanup";
        residual.add(item.identity.pid);
      }
      // `gone`: the descendant exited before escalation.
    }

    if (killed.length > 0) {
      const survivors = await this.waitForDescendants(
        killed,
        Date.now() + this.manager.killGraceMs,
      );
      for (const item of survivors) {
        failure ??=
          `external descendant pid ${item.identity.pid} survived SIGKILL ` +
          "or could not be revalidated";
        residual.add(item.identity.pid);
      }
    }

    const observedDescendants = this.observedExternalPids.size;
    const signalledDescendants = this.signalledDescendantPids.size;
    const state: WorkerNestedCleanupState =
      failure !== undefined
        ? "failed"
        : observedDescendants === 0
          ? "none"
          : signalledDescendants === 0
            ? "clean"
            : "terminated";
    return {
      evidence: {
        state,
        observedDescendants,
        signalledDescendants,
        residualDescendants: residual.size,
        ...(failure !== undefined ? { detail: boundDetail(failure) } : {}),
      },
      ...(failure !== undefined ? { failure } : {}),
    };
  }

  /**
   * Poll exact descendant liveness/identity until every target is gone or the
   * deadline passes. A live pid whose identity cannot be re-read is reported as
   * ambiguous, never as gone.
   */
  private async waitForDescendants(
    targets: readonly RuntimeProcessIdentity[],
    deadline: number,
  ): Promise<
    { identity: RuntimeProcessIdentity; ambiguous: boolean }[]
  > {
    let pending = targets.map((identity) => ({ identity, ambiguous: false }));
    for (;;) {
      const next: typeof pending = [];
      for (const item of pending) {
        if (!this.manager.isAlive(item.identity.pid)) continue;
        let observed: RuntimeProcessIdentity | undefined;
        try {
          observed = await this.manager.inspector.capture(item.identity.pid);
        } catch {
          next.push({ identity: item.identity, ambiguous: true });
          continue;
        }
        if (!observed) {
          next.push({ identity: item.identity, ambiguous: true });
          continue;
        }
        if (compareProcessIdentity(item.identity, observed) !== "match") {
          next.push({ identity: item.identity, ambiguous: true });
          continue;
        }
        next.push({ identity: item.identity, ambiguous: false });
      }
      pending = next;
      if (pending.length === 0 || Date.now() >= deadline) return pending;
      await sleep(
        Math.min(this.manager.pollMs, Math.max(1, deadline - Date.now())),
      );
    }
  }

  /**
   * Windows and platforms without `ps`-backed group inspection: only the
   * exact direct child can be managed. No group ownership is claimed.
   */
  private async cleanupWithoutGroups(
    reason: WorkerCleanupReason,
    pid: number,
  ): Promise<WorkerProcessCleanupOutcome> {
    if (reason !== "child-close") {
      await this.terminateExactChild();
    }
    return this.finish("unsupported", "unsupported", reason, {
      pgid: undefined,
      detail:
        this.captureSupportValue === "windows-exact-child"
          ? "win32 has no managed POSIX process group; only the direct child was signalled"
          : `no process-group inspection on ${this.manager.platform}; only the direct child was signalled`,
    });
  }

  /** Signal the exact child only, with a bounded SIGTERM → SIGKILL fallback. */
  private async terminateExactChild(): Promise<void> {
    const pid = this.child.pid;
    if (!isProcessPid(pid)) return;
    if (!this.childAlive()) return;
    this.signalPid("SIGTERM");
    if (await this.waitForChildExit(this.manager.termGraceMs)) return;
    if (!this.childAlive()) return;
    this.signalPid("SIGKILL");
    await this.waitForChildExit(this.manager.killGraceMs);
  }

  private childAlive(): boolean {
    return (
      this.child.exitCode === null &&
      this.child.signalCode === null &&
      this.manager.isAlive(this.child.pid)
    );
  }

  private signalPid(signal: "SIGTERM" | "SIGKILL"): void {
    try {
      const sent = this.child.kill(signal);
      this.recordSignal({
        signal,
        scope: "pid",
        at: new Date().toISOString(),
        result: sent ? "sent" : "failed",
        ...(sent ? {} : { detail: "child already exited" }),
      });
    } catch (error) {
      this.recordSignal({
        signal,
        scope: "pid",
        at: new Date().toISOString(),
        result: "failed",
        detail: boundDetail(errorText(error)),
      });
    }
  }

  private waitForChildExit(graceMs: number): Promise<boolean> {
    return new Promise<boolean>((resolveWait) => {
      const check = (): boolean => {
        if (this.child.exitCode !== null || this.child.signalCode !== null) {
          resolveWait(true);
          return true;
        }
        return false;
      };
      if (check()) return;
      const deadline = Date.now() + graceMs;
      const tick = (): void => {
        if (check()) return;
        if (Date.now() >= deadline) {
          resolveWait(false);
          return;
        }
        setTimeout(tick, Math.min(this.manager.pollMs, 25));
      };
      setTimeout(tick, Math.min(this.manager.pollMs, 25));
    });
  }

  private residualOf(
    members: readonly ProcessGroupMember[],
    leaderPid: number,
  ): RuntimeProcessIdentity[] {
    return members
      .filter((member) => member.pid !== leaderPid)
      .map((member) => ({
        pid: member.pid,
        pgid: member.pgid,
        startedAt: member.startedAt,
      }));
  }

  /**
   * A group signal is allowed only when every safety fact still holds against a
   * fresh membership listing. Any ambiguity is a refusal, not a guess.
   */
  private async groupSignalAllowed(
    pgid: number,
    leaderPid: number,
    identity: RuntimeProcessIdentity | undefined,
    members: readonly ProcessGroupMember[],
  ): Promise<{ ok: true } | { ok: false; reason: string }> {
    if (!isProcessPid(pgid) || pgid <= 1) {
      return { ok: false, reason: "refusing an invalid process-group id" };
    }
    if (pgid !== leaderPid) {
      return {
        ok: false,
        reason: "refusing a process group not led by the spawned worker",
      };
    }
    if (pgid === process.pid) {
      return { ok: false, reason: "refusing cliyard's own process id as a group" };
    }
    if (members.length === 0) {
      return { ok: false, reason: "process group membership disappeared" };
    }
    if (members.some((member) => member.pgid !== pgid)) {
      return {
        ok: false,
        reason: "process group membership is inconsistent with the managed group",
      };
    }
    if (members.some((member) => member.pid === process.pid)) {
      return { ok: false, reason: "refusing a group that contains cliyard itself" };
    }
    const ownGroupId = await this.manager.ownGroupId();
    if (!isProcessPid(ownGroupId)) {
      return {
        ok: false,
        reason: "cannot prove the managed group differs from cliyard's group",
      };
    }
    if (ownGroupId === pgid) {
      return { ok: false, reason: "refusing cliyard's own process group" };
    }
    if (identity) {
      const leader = members.find((member) => member.pid === identity.pid);
      if (leader && compareProcessIdentity(identity, leader) !== "match") {
        return {
          ok: false,
          reason: "the group leader identity no longer matches the spawned worker",
        };
      }
    }
    return { ok: true };
  }

  private signalGroup(
    pgid: number,
    signal: "SIGTERM" | "SIGKILL",
  ): "sent" | "gone" | "error" {
    try {
      process.kill(-pgid, signal);
      this.recordSignal({
        signal,
        scope: "process-group",
        at: new Date().toISOString(),
        result: "sent",
      });
      return "sent";
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ESRCH") {
        // The group emptied between listing and signalling.
        return "gone";
      }
      this.recordSignal({
        signal,
        scope: "process-group",
        at: new Date().toISOString(),
        result: "failed",
        detail: boundDetail(errorText(error)),
      });
      return "error";
    }
  }

  private async waitForEmpty(
    pgid: number,
    graceMs: number,
  ): Promise<ProcessGroupMember[]> {
    const deadline = Date.now() + graceMs;
    for (;;) {
      const members = await this.manager.listMembers(pgid);
      if (members.length === 0) return members;
      if (Date.now() >= deadline) return members;
      await sleep(Math.min(this.manager.pollMs, Math.max(1, deadline - Date.now())));
    }
  }

  private async failClosed(
    reason: WorkerCleanupReason,
    detail: string,
    pgid: number | undefined,
    identity: RuntimeProcessIdentity | undefined,
    source: WorkerCaptureSource,
    residual: RuntimeProcessIdentity[] = [],
  ): Promise<WorkerProcessCleanupOutcome> {
    // Preserve the ability of the adapter to observe a child close: an exact
    // PID signal is always safe and cannot touch an unrelated group.
    await this.terminateExactChild();
    return this.finishFailed(reason, detail, pgid, identity, source, residual);
  }

  private recordSignal(record: WorkerProcessSignalRecord): void {
    this.signals.push(record);
    if (this.signals.length > MAX_PROCESS_TREE_SIGNALS) {
      this.signals.splice(0, this.signals.length - MAX_PROCESS_TREE_SIGNALS);
    }
  }

  private noteResidual(members: readonly RuntimeProcessIdentity[]): void {
    if (members.length === 0) return;
    // Keep the true observed count even when the persisted list is bounded.
    this.residualCount = Math.max(this.residualCount, members.length);
    this.residualMembers = mergeResidual(this.residualMembers, members);
  }

  private finish(
    state: Exclude<WorkerCleanupState, "failed">,
    source: WorkerCaptureSource,
    reason: WorkerCleanupReason,
    options: {
      pgid?: number;
      identity?: RuntimeProcessIdentity;
      residual?: RuntimeProcessIdentity[];
      detail?: string;
    } = {},
  ): WorkerProcessCleanupOutcome {
    if (options.residual) this.noteResidual(options.residual);
    return this.build(state, source, reason, options);
  }

  private finishFailed(
    reason: WorkerCleanupReason,
    detail: string,
    pgid: number | undefined,
    identity: RuntimeProcessIdentity | undefined,
    source: WorkerCaptureSource,
    residual: RuntimeProcessIdentity[] = [],
  ): WorkerProcessCleanupOutcome {
    if (residual.length > 0) this.noteResidual(residual);
    return this.build("failed", source, reason, {
      ...(pgid !== undefined ? { pgid } : {}),
      ...(identity !== undefined ? { identity } : {}),
      detail,
    });
  }

  private build(
    state: WorkerCleanupState,
    source: WorkerCaptureSource,
    reason: WorkerCleanupReason,
    options: {
      pgid?: number;
      identity?: RuntimeProcessIdentity;
      detail?: string;
    },
  ): WorkerProcessCleanupOutcome {
    if (this.outcome) return this.outcome;
    const identity = options.identity
      ? copyIdentity(options.identity)
      : undefined;
    // An early fail-closed path can skip `settleNested` after the sampler
    // already observed external descendants. Persist that as a failed nested
    // cleanup instead of emitting evidence the record parser must reject
    // (external evidence and `nestedCleanup` are all-or-nothing).
    const observedExternal = this.observedExternalPids.size;
    const nestedCleanup =
      this.nestedCleanup ??
      (observedExternal > 0
        ? {
            state: "failed" as const,
            observedDescendants: observedExternal,
            signalledDescendants: this.signalledDescendantPids.size,
            residualDescendants: Math.max(
              0,
              observedExternal - this.signalledDescendantPids.size,
            ),
            detail: boundDetail("nested cleanup did not complete"),
          }
        : undefined);
    const record: WorkerProcessRecord = {
      version: WORKER_PROCESS_RECORD_VERSION,
      host: this.manager.inspector.host,
      ...(isProcessPid(this.child.pid) ? { pid: this.child.pid } : {}),
      ...(isProcessPid(options.pgid) ? { pgid: options.pgid } : {}),
      ...(identity ? { identity } : {}),
      captureSource: source,
      captureSupport: this.captureSupportValue,
      cleanupReason: reason,
      cleanupState: state,
      signals: this.signals.map((signal) => ({ ...signal })),
      residualMembers: this.residualMembers.map((member) => ({ ...member })),
      residualCount: this.residualCount,
      ...(this.observedExternalPids.size > 0
        ? {
            observedExternalDescendants: [...this.observedExternal.values()]
              .sort((first, second) => first.pid - second.pid)
              .slice(0, MAX_PERSISTED_EXTERNAL_DESCENDANTS)
              .map((identity) => copyIdentity(identity)),
            observedExternalDescendantCount: this.observedExternalPids.size,
            observedExternalGroups: [...this.observedExternalGroupIds].sort(
              (first, second) => first - second,
            ),
          }
        : {}),
      ...(nestedCleanup !== undefined
        ? { nestedCleanup: { ...nestedCleanup } }
        : {}),
      ...(this.exitCode !== undefined ? { exitCode: this.exitCode } : {}),
      ...(this.exitSignal !== undefined ? { exitSignal: this.exitSignal } : {}),
      startedAt: this.startedAt,
      ...(this.closedAt !== undefined ? { closedAt: this.closedAt } : {}),
      cleanedAt: new Date().toISOString(),
      ...(options.detail
        ? { detail: boundDetail(options.detail) }
        : this.spawnErrorText
          ? { detail: boundDetail(`spawn error: ${this.spawnErrorText}`) }
          : {}),
    };
    const outcome: WorkerProcessCleanupOutcome = {
      record,
      treeOk: state !== "failed",
    };
    this.outcome = outcome;
    return outcome;
  }
}

/**
 * `true` when the persisted record must make an otherwise successful result
 * fail closed.
 */
export function isWorkerProcessCleanupFailure(
  record: WorkerProcessRecord,
): boolean {
  return record.cleanupState === "failed";
}

/** Structured, bounded failure for a failed/ambiguous process-tree cleanup. */
export function createProcessTreeCleanupFailure(
  record: WorkerProcessRecord,
): FailureRecord {
  return createFailureRecord({
    stage: "worker",
    code: "process_tree_cleanup_failed",
    messageDetail:
      `process-tree cleanup ${record.cleanupState}` +
      ` (${record.captureSource}, residual=${record.residualCount}` +
      (record.nestedCleanup
        ? `, nested=${record.nestedCleanup.state}/${record.nestedCleanup.residualDescendants}`
        : "") +
      ")" +
      (record.detail ? `: ${record.detail}` : ""),
  });
}

/** First failed record's structured failure, if any. */
export function firstWorkerCleanupFailure(
  records: readonly WorkerProcessRecord[],
): FailureRecord | undefined {
  const failed = records.find(isWorkerProcessCleanupFailure);
  return failed ? createProcessTreeCleanupFailure(failed) : undefined;
}

/** Append a record, keeping only the newest bounded set. */
export function recordWorkerProcessTree(
  records: WorkerProcessRecord[],
  record: WorkerProcessRecord,
): void {
  records.push(record);
  if (records.length > MAX_WORKER_PROCESS_RECORDS) {
    records.splice(0, records.length - MAX_WORKER_PROCESS_RECORDS);
  }
}

/** Attach bounded cleanup evidence to a spawn error carried to the adapter. */
export function attachProcessTreeEvidence(
  error: unknown,
  outcome: WorkerProcessCleanupOutcome,
): Error {
  const carrier =
    error instanceof Error ? error : new Error(String(error));
  try {
    const extended = carrier as Error & {
      processTree?: WorkerProcessRecord;
      cleanupFailure?: FailureRecord;
    };
    extended.processTree = outcome.record;
    if (isWorkerProcessCleanupFailure(outcome.record)) {
      extended.cleanupFailure = createProcessTreeCleanupFailure(outcome.record);
    }
  } catch {
    // A frozen error object still propagates; process-tree evidence is
    // preserved separately in the adapter whenever possible.
  }
  return carrier;
}

/**
 * Validate and normalize a persisted record. Malformed records return
 * `undefined` so a reader fails closed instead of guessing at cleanup state.
 */
export function parseWorkerProcessRecord(
  value: unknown,
): WorkerProcessRecord | undefined {
  if (!isRecord(value) || value.version !== WORKER_PROCESS_RECORD_VERSION) {
    return undefined;
  }
  if (
    typeof value.host !== "string" ||
    value.host.trim() === "" ||
    value.host.length > 256
  ) {
    return undefined;
  }
  const pid = parseOptionalPid(value.pid);
  if (pid === null) return undefined;
  const pgid = parseOptionalPid(value.pgid);
  if (pgid === null) return undefined;

  let identity: RuntimeProcessIdentity | undefined;
  if (value.identity !== undefined) {
    if (!isProcessIdentity(value.identity)) return undefined;
    identity = copyIdentity(value.identity);
  }
  if (
    typeof value.captureSource !== "string" ||
    !CAPTURE_SOURCES.has(value.captureSource) ||
    typeof value.captureSupport !== "string" ||
    !CAPTURE_SUPPORTS.has(value.captureSupport) ||
    typeof value.cleanupReason !== "string" ||
    !CLEANUP_REASONS.has(value.cleanupReason) ||
    typeof value.cleanupState !== "string" ||
    !TERMINAL_STATES.has(value.cleanupState)
  ) {
    return undefined;
  }

  const signals = parseSignals(value.signals);
  if (!signals) return undefined;
  const residual = parseResidualMembers(value.residualMembers);
  if (!residual) return undefined;
  if (
    typeof value.residualCount !== "number" ||
    !Number.isInteger(value.residualCount) ||
    value.residualCount < residual.length ||
    value.residualCount > MAX_PROCESS_TREE_RESIDUAL_COUNT
  ) {
    return undefined;
  }

  const external = parseExternalEvidence(
    value.observedExternalDescendants,
    value.observedExternalDescendantCount,
  );
  if (!external) return undefined;
  const externalGroups = parseExternalGroups(
    value.observedExternalGroups,
    external.count !== undefined,
  );
  if (externalGroups === null) return undefined;
  const nested = parseNestedCleanup(value.nestedCleanup, external.count);
  if (nested === null) return undefined;

  if (!isTimestamp(value.startedAt)) return undefined;
  if (value.closedAt !== undefined && !isTimestamp(value.closedAt)) return undefined;
  if (value.cleanedAt !== undefined && !isTimestamp(value.cleanedAt)) return undefined;

  let exitCode: number | undefined;
  if (value.exitCode !== undefined) {
    if (typeof value.exitCode !== "number" || !Number.isInteger(value.exitCode)) {
      return undefined;
    }
    exitCode = value.exitCode;
  }
  let exitSignal: string | undefined;
  if (value.exitSignal !== undefined) {
    if (!isBoundedText(value.exitSignal, 64)) return undefined;
    exitSignal = value.exitSignal;
  }
  let detail: string | undefined;
  if (value.detail !== undefined) {
    if (!isBoundedText(value.detail, MAX_PROCESS_TREE_DETAIL)) return undefined;
    detail = value.detail;
  }

  return {
    version: WORKER_PROCESS_RECORD_VERSION,
    host: value.host,
    ...(pid !== undefined ? { pid } : {}),
    ...(pgid !== undefined ? { pgid } : {}),
    ...(identity ? { identity } : {}),
    captureSource: value.captureSource as WorkerCaptureSource,
    captureSupport: value.captureSupport as WorkerCaptureSupport,
    cleanupReason: value.cleanupReason as WorkerCleanupReason,
    cleanupState: value.cleanupState as WorkerCleanupState,
    signals,
    residualMembers: residual,
    residualCount: value.residualCount,
    ...(external.count !== undefined &&
    external.descendants !== undefined &&
    externalGroups !== undefined &&
    nested !== undefined
      ? {
          observedExternalDescendants: external.descendants,
          observedExternalDescendantCount: external.count,
          observedExternalGroups: externalGroups,
          nestedCleanup: nested,
        }
      : {}),
    ...(exitCode !== undefined ? { exitCode } : {}),
    ...(exitSignal !== undefined ? { exitSignal } : {}),
    startedAt: value.startedAt,
    ...(value.closedAt !== undefined ? { closedAt: value.closedAt } : {}),
    ...(value.cleanedAt !== undefined ? { cleanedAt: value.cleanedAt } : {}),
    ...(detail !== undefined ? { detail } : {}),
  };
}

function parseSignals(raw: unknown): WorkerProcessSignalRecord[] | undefined {
  if (!Array.isArray(raw) || raw.length > MAX_PROCESS_TREE_SIGNALS) {
    return undefined;
  }
  const signals: WorkerProcessSignalRecord[] = [];
  for (const value of raw) {
    if (!isRecord(value)) return undefined;
    const signal = value.signal;
    const scope = value.scope;
    const result = value.result;
    if (
      (signal !== "SIGTERM" && signal !== "SIGKILL") ||
      (scope !== "process-group" &&
        scope !== "pid" &&
        scope !== "descendant-pid") ||
      (result !== "sent" && result !== "failed") ||
      !isTimestamp(value.at)
    ) {
      return undefined;
    }
    let pid: number | undefined;
    if (scope === "descendant-pid") {
      if (!isProcessPid(value.pid)) return undefined;
      pid = value.pid;
    } else if (value.pid !== undefined) {
      return undefined;
    }
    let detail: string | undefined;
    if (value.detail !== undefined) {
      if (!isBoundedText(value.detail, MAX_PROCESS_TREE_DETAIL)) return undefined;
      detail = value.detail;
    }
    signals.push({
      signal,
      scope,
      ...(pid !== undefined ? { pid } : {}),
      at: value.at,
      result,
      ...(detail !== undefined ? { detail } : {}),
    });
  }
  return signals;
}

function parseResidualMembers(
  raw: unknown,
): RuntimeProcessIdentity[] | undefined {
  if (!Array.isArray(raw) || raw.length > MAX_PROCESS_TREE_MEMBERS) {
    return undefined;
  }
  const members: RuntimeProcessIdentity[] = [];
  for (const value of raw) {
    if (!isProcessIdentity(value)) return undefined;
    members.push(copyIdentity(value));
  }
  return members;
}

interface ParsedExternalEvidence {
  descendants?: RuntimeProcessIdentity[];
  count?: number;
}

/**
 * Optional external-descendant evidence is all-or-nothing: a list without its
 * observed count (or vice versa) is malformed, not partially trustworthy.
 */
function parseExternalEvidence(
  descendantsRaw: unknown,
  countRaw: unknown,
): ParsedExternalEvidence | undefined {
  if (descendantsRaw === undefined && countRaw === undefined) return {};
  if (descendantsRaw === undefined || countRaw === undefined) return undefined;
  if (
    !Array.isArray(descendantsRaw) ||
    descendantsRaw.length === 0 ||
    descendantsRaw.length > MAX_PERSISTED_EXTERNAL_DESCENDANTS
  ) {
    return undefined;
  }
  if (
    typeof countRaw !== "number" ||
    !Number.isInteger(countRaw) ||
    countRaw < descendantsRaw.length ||
    countRaw < 1 ||
    countRaw > MAX_SAMPLED_DESCENDANTS
  ) {
    return undefined;
  }
  const descendants: RuntimeProcessIdentity[] = [];
  const seen = new Set<number>();
  for (const value of descendantsRaw) {
    if (!isProcessIdentity(value) || seen.has(value.pid)) return undefined;
    seen.add(value.pid);
    descendants.push(copyIdentity(value));
  }
  return { descendants, count: countRaw };
}

/** `null` for invalid, `undefined` for validly absent. */
function parseExternalGroups(
  raw: unknown,
  required: boolean,
): number[] | null | undefined {
  if (raw === undefined) return required ? null : undefined;
  if (!required) return null;
  if (
    !Array.isArray(raw) ||
    raw.length === 0 ||
    raw.length > MAX_PERSISTED_EXTERNAL_GROUPS
  ) {
    return null;
  }
  const groups: number[] = [];
  const seen = new Set<number>();
  for (const value of raw) {
    if (!isProcessPid(value) || seen.has(value)) return null;
    seen.add(value);
    groups.push(value);
  }
  return groups;
}

/** `null` for invalid, `undefined` for validly absent. */
function parseNestedCleanup(
  raw: unknown,
  externalCount: number | undefined,
): WorkerNestedCleanupEvidence | null | undefined {
  if (raw === undefined) return externalCount === undefined ? undefined : null;
  if (externalCount === undefined || !isRecord(raw)) return null;
  if (typeof raw.state !== "string" || !NESTED_STATES.has(raw.state)) {
    return null;
  }
  const state = raw.state as WorkerNestedCleanupState;
  const observed = raw.observedDescendants;
  const signalled = raw.signalledDescendants;
  const residual = raw.residualDescendants;
  if (
    typeof observed !== "number" ||
    !Number.isInteger(observed) ||
    observed !== externalCount ||
    typeof signalled !== "number" ||
    !Number.isInteger(signalled) ||
    signalled < 0 ||
    signalled > observed ||
    typeof residual !== "number" ||
    !Number.isInteger(residual) ||
    residual < 0 ||
    residual > observed
  ) {
    return null;
  }
  if (
    state === "none" ||
    (state === "terminated" && signalled === 0) ||
    (state === "clean" && signalled !== 0) ||
    (state !== "failed" && residual !== 0)
  ) {
    return null;
  }
  let detail: string | undefined;
  if (raw.detail !== undefined) {
    if (!isBoundedText(raw.detail, MAX_PROCESS_TREE_DETAIL)) return null;
    detail = raw.detail;
  }
  return {
    state,
    observedDescendants: observed,
    signalledDescendants: signalled,
    residualDescendants: residual,
    ...(detail !== undefined ? { detail } : {}),
  };
}

/** `undefined` for absent, `null` for invalid. */
function parseOptionalPid(value: unknown): number | undefined | null {
  if (value === undefined) return undefined;
  if (!isProcessPid(value)) return null;
  return value;
}

function copyIdentity(identity: RuntimeProcessIdentity): RuntimeProcessIdentity {
  return {
    pid: identity.pid,
    pgid: identity.pgid,
    startedAt: identity.startedAt,
  };
}

function isTimestamp(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 64 &&
    !Number.isNaN(Date.parse(value))
  );
}

function isBoundedText(value: unknown, max: number): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= max &&
    !value.includes("\0")
  );
}

function boundDetail(text: string): string {
  return boundFailureText(text.replace(/\s+/g, " ").trim(), MAX_PROCESS_TREE_DETAIL);
}

function combineDetail(
  first: string | undefined,
  second: string | undefined,
): string | undefined {
  const parts = [first, second].filter(
    (part): part is string => typeof part === "string" && part !== "",
  );
  if (parts.length === 0) return undefined;
  return boundDetail(parts.join("; "));
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function positiveBound(
  value: number | undefined,
  fallback: number,
  name: string,
): number {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} must be a positive number`);
  }
  return Math.floor(value);
}

function boundedInterval(
  value: number | undefined,
  fallback: number,
  minimum: number,
  name: string,
): number {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value) || value < minimum) {
    throw new Error(`${name} must be a number at least ${minimum}`);
  }
  return Math.floor(value);
}

function sleep(ms: number): Promise<void> {
  return new Promise<void>((resolveSleep) => {
    setTimeout(resolveSleep, Math.max(1, ms));
  });
}

/** Union of observed residual identities, deduplicated by pid and bounded. */
function mergeResidual(
  first: readonly RuntimeProcessIdentity[],
  second: readonly RuntimeProcessIdentity[],
): RuntimeProcessIdentity[] {
  const seen = new Set<number>();
  const merged: RuntimeProcessIdentity[] = [];
  for (const member of [...first, ...second]) {
    if (seen.has(member.pid)) continue;
    seen.add(member.pid);
    merged.push({ ...member });
    if (merged.length >= MAX_PROCESS_TREE_MEMBERS) break;
  }
  return merged;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

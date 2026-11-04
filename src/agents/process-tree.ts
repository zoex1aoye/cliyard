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
 * from process-table snapshots. An external process group is represented once,
 * by its exact leader identity (`pid === pgid`), so a legitimate test runner
 * with hundreds of members stays one bounded unit. Descendants without an
 * observed group leader stay exact-pid fallback candidates.
 *
 * Safety rules:
 * - A group signal requires `pgid === worker pid` (the dedicated group created
 *   by `setsid`), a re-listed membership that still belongs to it, and proof
 *   that the group is not cliyard's own group. Anything less fails closed.
 * - A nested external-group signal additionally requires a persisted exact
 *   leader identity, a fresh exact match from a bounded process-table
 *   projection (or `capture(leader.pid)` for the legacy single-group
 *   inspector), and a fresh membership projection whose leader row still
 *   matches. The group is signalled as one unit; its members are never
 *   individual signal authority.
 * - When bounded process-table snapshots are available, every observed pgid is
 *   projected from one snapshot per cleanup phase instead of one full `ps -A`
 *   membership listing per group. The legacy per-group inspector path remains
 *   for inspectors without snapshots.
 * - Descendant snapshots are rooted at the worker leader and are used only
 *   when its exact identity still matches; a reused pid never contributes
 *   descendants.
 * - An ungrouped external descendant is signalled only after a fresh identity
 *   re-read matches pid, pgid and lstart, and only when it is neither in the
 *   managed group nor in cliyard's group.
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
/** Maximum owned nested process groups represented in one registry. */
export const MAX_NESTED_GROUPS = MAX_PERSISTED_EXTERNAL_GROUPS;
/**
 * Maximum external groups one live cleanup can enumerate. This is independent
 * of the durable registry bound: a live process table is already capped at
 * {@link MAX_PROCESS_TABLE_ROWS}, and cleanup must see every group the current
 * snapshot can prove rather than only the first {@link MAX_NESTED_GROUPS}.
 */
export const MAX_LIVE_NESTED_GROUPS = MAX_PROCESS_TABLE_ROWS;
/** Upper bound for an observed nested group's member count (evidence only). */
export const MAX_NESTED_GROUP_MEMBERS = 100_000;
/**
 * Maximum exact member identities retained for proven external groups. This is
 * evidence for the reuse guard only: a group whose sampled members exceed the
 * bound is never classified as vanished, because an unrecorded member could
 * still be present in the remaining rows.
 */
export const MAX_SAMPLED_GROUP_MEMBERS = MAX_PROCESS_TABLE_ROWS;
/** Maximum ungrouped external descendant pids observed per worker. */
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
 * - `descendant-pid`: one revalidated ungrouped external descendant pid.
 * - `nested-process-group`: one guarded external group, by negative pgid.
 */
export type WorkerProcessSignalScope =
  | "process-group"
  | "pid"
  | "descendant-pid"
  | "nested-process-group";

export interface WorkerProcessSignalRecord {
  signal: "SIGTERM" | "SIGKILL";
  scope: WorkerProcessSignalScope;
  /** Present only for `descendant-pid`: the exact signalled pid. */
  pid?: number;
  /** Present only for `nested-process-group`: the signalled group id. */
  pgid?: number;
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

/**
 * Completeness of the *live* cleanup against the current process table.
 * - `complete`: every currently reachable external group was proven gone (or
 *   no external group was reachable).
 * - `incomplete`: current inspection was ambiguous, a live group could not be
 *   proven gone, or the live target set exceeded its signal bound.
 * - `unsupported`: this platform has no managed POSIX group.
 */
export type WorkerCleanupCompleteness = "complete" | "incomplete" | "unsupported";

/**
 * Completeness of the *durable* bounded registry for controller-death
 * recovery. `truncated` means the persisted lease cannot prove complete nested
 * ownership; it says nothing about whether the live cleanup succeeded.
 */
export type WorkerDurableRecoveryCompleteness = "complete" | "truncated";

/**
 * One external process group whose leader row was observed outside the managed
 * worker group. `leader.pid === leader.pgid` by construction; the entry is not
 * signal authority until cleanup re-proves that exact identity plus fresh
 * membership.
 */
export interface WorkerNestedGroup {
  pgid: number;
  leader: RuntimeProcessIdentity;
  /** Highest member count observed for the group (leader included). */
  observedMemberCount: number;
  lastObservedAt: string;
}

/**
 * Bounded, credential-free snapshot of descendants that left the managed
 * group. It is evidence only: no snapshot ever authorizes a signal by itself.
 *
 * `observedCount` is the true observed *ungrouped* descendant count and may be
 * larger than the persisted `identities` list. Members of an owned group are
 * represented by `groups`, never by individual fallback identities. `truncated`
 * is `true` once a bound is exceeded or a snapshot could not prove a complete
 * relationship graph; a truncated snapshot must never authorize recovery.
 *
 * `groups` is optional so reviewed-draft and legacy v1 evidence keeps parsing
 * unchanged. A group with a member count above the persistence bound is still
 * one bounded unit because cleanup re-lists fresh membership from the OS.
 */
export interface WorkerNestedProcesses {
  version: 1;
  host: string;
  observedCount: number;
  truncated: boolean;
  lastObservedAt: string;
  groups?: WorkerNestedGroup[];
  identities: RuntimeProcessIdentity[];
}

/** Bounded outcome of cleaning descendants that left the managed group. */
export interface WorkerNestedCleanupEvidence {
  state: WorkerNestedCleanupState;
  /** Ungrouped external descendant pids observed by the sampler/cleanup snapshot. */
  observedDescendants: number;
  /** Exact ungrouped descendant pids that received at least one signal. */
  signalledDescendants: number;
  /** Ungrouped external descendant pids that could not be proven gone. */
  residualDescendants: number;
  /** Exact-led external groups considered during cleanup. */
  observedGroups?: number;
  /** External groups that received at least one negative-pgid signal. */
  signalledGroups?: number;
  /** External groups that could not be proven gone. */
  residualGroups?: number;
  /**
   * External groups whose exact leader identity no longer matched at cleanup
   * and whose remaining rows carried no sampled worker descendant. They are
   * evidence only: no signal was sent to them and they are not residual.
   */
  vanishedGroups?: number;
  /** Live cleanup completeness, independent of the durable registry bound. */
  cleanupCompleteness?: WorkerCleanupCompleteness;
  /** Whether the bounded durable registry covers every observation. */
  durableRecoveryCompleteness?: WorkerDurableRecoveryCompleteness;
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
  /**
   * Live cleanup completeness. A `cleanupState: "terminated"` record may carry
   * `cleanupCompleteness: "complete"` while the durable registry below is
   * truncated; the two meanings are deliberately independent.
   */
  cleanupCompleteness?: WorkerCleanupCompleteness;
  /** Completeness of the bounded persisted nested registry for recovery. */
  durableRecoveryCompleteness?: WorkerDurableRecoveryCompleteness;
  signals: WorkerProcessSignalRecord[];
  /** Bounded residual group members observed while cleaning. */
  residualMembers: RuntimeProcessIdentity[];
  /** Actual residual member count observed (may exceed the bounded list). */
  residualCount: number;
  /** Bounded ungrouped exact identities observed outside the group. */
  observedExternalDescendants?: RuntimeProcessIdentity[];
  /** Actual ungrouped external descendant pid count (may exceed the list). */
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
  /**
   * Read-only bounded observer for descendants that left the managed group.
   *
   * The current snapshot is replayed synchronously to a new subscriber, and
   * only changed snapshots from validated process-table samples are emitted
   * afterwards. This observer never signals a process. Optional so a custom
   * ManagedWorkerProcess (for example a test fake) keeps compiling; without
   * it no durable nested evidence can be observed.
   */
  observeExternalDescendants?(
    listener: (snapshot: WorkerNestedProcesses) => void | Promise<void>,
  ): () => void;
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

/** Bounded result of cleaning every exact-led external group. */
interface NestedGroupCleanupOutcome {
  observed: number;
  signalled: number;
  residual: number;
  /** Groups whose leader identity was reused and that were never signalled. */
  vanished: number;
  failure?: string;
}

/**
 * Per-group state while table-batched cleanup moves through its snapshot
 * phases. `signalled` means at least one group signal was attempted; `gone`
 * is set only when a fresh snapshot no longer contains the group.
 */
interface TableGroupOutcome {
  gone: boolean;
  signalled: boolean;
  /** Leader identity was reused and no sampled worker descendant remained. */
  vanished?: boolean;
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
const CLEANUP_COMPLETENESS_STATES: ReadonlySet<string> =
  new Set<WorkerCleanupCompleteness>(["complete", "incomplete", "unsupported"]);
const DURABLE_RECOVERY_COMPLETENESS_STATES: ReadonlySet<string> =
  new Set<WorkerDurableRecoveryCompleteness>(["complete", "truncated"]);
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
  private readonly observedGroups = new Map<number, WorkerNestedGroup>();
  /**
   * Exact identities of sampled members of proven external groups. Signals are
   * authorized by group, so member identities are compacted out of the normal
   * registries; this bounded evidence still lets cleanup prove whether a
   * reused group id remains occupied by a known worker descendant.
   */
  private readonly sampledGroupMembers = new Map<
    number,
    Map<number, RuntimeProcessIdentity>
  >();
  /** Groups whose sampled member identities exceeded the evidence bound. */
  private readonly incompleteGroupMemberSamples = new Set<number>();
  private sampledGroupMemberCount = 0;
  private readonly observedExternalGroupIds = new Set<number>();
  private readonly signalledDescendantPids = new Set<number>();
  private readonly signalledGroupIds = new Set<number>();
  private readonly residualGroupIds = new Set<number>();
  private readonly nestedSnapshotListeners = new Set<
    (snapshot: WorkerNestedProcesses) => void | Promise<void>
  >();
  private nestedSnapshot: WorkerNestedProcesses | undefined;
  private nestedSnapshotKey: string | undefined;
  private nestedObservedAt: string | undefined;
  /**
   * A *durable registry* bound was exceeded. This marks the persisted snapshot
   * truncated (controller-death recovery is incomplete) but never fails a live
   * cleanup that can still prove the current tree gone.
   */
  private durableTruncated = false;
  /** The live group view itself exceeded the process-table bound. */
  private liveIncomplete = false;
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

  /**
   * Subscribe to the bounded external-descendant snapshot. The current
   * snapshot is replayed immediately; later emissions happen only when the
   * validated snapshot content changes. This path is observational and never
   * signals a process.
   */
  observeExternalDescendants(
    listener: (snapshot: WorkerNestedProcesses) => void,
  ): () => void {
    if (typeof listener !== "function") {
      throw new Error("nested descendant observer requires a listener function");
    }
    this.nestedSnapshotListeners.add(listener);
    if (this.nestedSnapshot) {
      void this.notifyNestedListener(listener, this.nestedSnapshot);
    }
    return () => {
      this.nestedSnapshotListeners.delete(listener);
    };
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
        "live external group view exceeded the process-table bound",
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
    const wasLiveIncomplete = this.liveIncomplete;
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

    // The walk is bounded by the bounded process-table snapshot itself, not by
    // an arbitrary descendant-pid cap: a legitimate nested test runner may own
    // hundreds of members and still be one bounded group unit.
    const external: ProcessTableEntry[] = [];
    const queue = [rootPid];
    const seen = new Set<number>([rootPid]);
    while (queue.length > 0) {
      const parent = queue.shift() as number;
      for (const child of children.get(parent) ?? []) {
        if (seen.has(child.pid)) continue;
        seen.add(child.pid);
        queue.push(child.pid);
        if (
          !isProcessPid(child.pid) ||
          !isProcessPid(child.pgid) ||
          child.pid <= 1 ||
          child.pid === process.pid ||
          child.pgid === managedPgid
        ) {
          continue;
        }
        external.push(child);
      }
    }

    const observedAt = new Date().toISOString();

    // First pass: exact group leaders. A leader is authoritative only when the
    // observed row itself proves `pid === pgid`; a reused group id keeps the
    // first exact leader and marks the *durable* registry truncated instead of
    // silently promoting a new process to ownership.
    //
    // The live group view is bounded only by the process-table snapshot, not
    // by the lease persistence bound: cleanup must be able to prove every
    // currently reachable group gone even when only 16 can be persisted.
    for (const leader of external) {
      if (leader.pid !== leader.pgid || !isProcessIdentity(leader)) continue;
      const existing = this.observedGroups.get(leader.pgid);
      if (existing) {
        if (compareProcessIdentity(existing.leader, leader) !== "match") {
          this.durableTruncated = true;
        } else {
          existing.lastObservedAt = observedAt;
        }
        continue;
      }
      if (this.observedGroups.size >= MAX_LIVE_NESTED_GROUPS) {
        // More distinct groups than a full process table: the live view can no
        // longer be complete, so this is the one group bound that fails live
        // cleanup.
        this.liveIncomplete = true;
        this.durableTruncated = true;
        continue;
      }
      this.observedGroups.set(leader.pgid, {
        pgid: leader.pgid,
        leader: copyIdentity(leader),
        observedMemberCount: 1,
        lastObservedAt: observedAt,
      });
    }

    // Observed-group ids, including groups whose leader row was not observed.
    // These are persisted as bounded evidence only; exceeding the persistence
    // bound truncates durable recovery and never fails the live cleanup.
    for (const entry of external) {
      if (this.observedExternalGroupIds.has(entry.pgid)) continue;
      if (this.observedExternalGroupIds.size >= MAX_LIVE_NESTED_GROUPS) {
        this.durableTruncated = true;
        continue;
      }
      this.observedExternalGroupIds.add(entry.pgid);
    }

    // Members of a known group never consume fallback slots. Counts are
    // evidence only; cleanup re-lists fresh OS membership before any signal.
    const counts = new Map<number, number>();
    for (const entry of external) {
      if (!this.observedGroups.has(entry.pgid)) continue;
      counts.set(entry.pgid, (counts.get(entry.pgid) ?? 0) + 1);
      // The leader identity already lives on the group; retain member
      // identities as bounded evidence for the reuse guard.
      if (entry.pid !== entry.pgid) this.noteGroupMemberIdentity(entry);
    }
    for (const [pgid, count] of counts) {
      const group = this.observedGroups.get(pgid);
      if (!group) continue;
      group.observedMemberCount = Math.max(
        group.observedMemberCount,
        Math.min(count, MAX_NESTED_GROUP_MEMBERS),
      );
    }

    // A pid first observed as ungrouped may later belong to a proven group.
    // Group membership always wins over stale exact-pid fallback evidence.
    for (const [pid, identity] of [...this.observedExternal]) {
      if (!this.observedGroups.has(identity.pgid)) continue;
      this.observedExternal.delete(pid);
      this.observedExternalPids.delete(pid);
      this.trackedDescendants.delete(pid);
    }

    for (const entry of external) {
      if (this.observedGroups.has(entry.pgid)) continue;
      this.noteUngroupedDescendant(entry);
    }
    this.publishNestedSnapshot();
    return this.liveIncomplete && !wasLiveIncomplete ? "incomplete" : "ok";
  }

  /**
   * Record one external descendant that has no proven group leader as an
   * exact-pid fallback candidate.
   */
  private noteUngroupedDescendant(entry: ProcessTableEntry): void {
    if (
      !isProcessPid(entry.pid) ||
      !isProcessPid(entry.pgid) ||
      entry.pid <= 1 ||
      entry.pid === process.pid
    ) {
      return;
    }
    if (!this.observedExternalPids.has(entry.pid)) {
      if (this.observedExternalPids.size >= MAX_SAMPLED_DESCENDANTS) {
        // The ungrouped evidence registry is truncated for durable recovery.
        // Live cleanup still fails closed later if more than
        // MAX_NESTED_SIGNAL_TARGETS of the tracked set are alive, which is the
        // only ungrouped-fallback bound that governs live signals.
        this.durableTruncated = true;
        return;
      }
      this.observedExternalPids.add(entry.pid);
    }
    // Keep the in-memory candidate set at the sampled-pid bound, not the
    // smaller persistence bound: every observed external pid must reach
    // `prepareNested`, which fails closed above the 32-target signal bound.
    if (
      this.observedExternal.has(entry.pid) ||
      this.observedExternal.size < MAX_SAMPLED_DESCENDANTS
    ) {
      this.observedExternal.set(entry.pid, copyIdentity(entry));
    }
    if (
      this.trackedDescendants.has(entry.pid) ||
      this.trackedDescendants.size < MAX_TRACKED_DESCENDANTS
    ) {
      this.trackedDescendants.set(entry.pid, copyIdentity(entry));
    }
  }

  /**
   * Retain one exact sampled member identity of a proven external group.
   *
   * This is evidence only and never authorizes a signal. A pid can only be one
   * live process at a time, so the latest identity for a pid replaces the
   * previous one. Once the evidence bound is exceeded the group becomes
   * ineligible for vanished classification: an unrecorded member could still
   * match a remaining row.
   */
  private noteGroupMemberIdentity(entry: ProcessTableEntry): void {
    if (!isProcessIdentity(entry)) return;
    let members = this.sampledGroupMembers.get(entry.pgid);
    if (members === undefined) {
      if (this.sampledGroupMemberCount >= MAX_SAMPLED_GROUP_MEMBERS) {
        this.incompleteGroupMemberSamples.add(entry.pgid);
        return;
      }
      members = new Map<number, RuntimeProcessIdentity>();
      this.sampledGroupMembers.set(entry.pgid, members);
    }
    if (!members.has(entry.pid)) {
      if (this.sampledGroupMemberCount >= MAX_SAMPLED_GROUP_MEMBERS) {
        this.incompleteGroupMemberSamples.add(entry.pgid);
        return;
      }
      this.sampledGroupMemberCount += 1;
    }
    members.set(entry.pid, copyIdentity(entry));
  }

  /**
   * Whether any remaining row of a group whose leader identity changed still
   * matches a sampled worker-descendant identity.
   *
   * Truncated member evidence is treated as a match: classifying the group as
   * vanished without complete evidence would auto-accept a possible survivor.
   */
  private remainingRowsMatchSampledDescendant(
    group: WorkerNestedGroup,
    rows: readonly RuntimeProcessIdentity[],
  ): boolean {
    if (this.incompleteGroupMemberSamples.has(group.pgid)) return true;
    const members = this.sampledGroupMembers.get(group.pgid);
    for (const row of rows) {
      if (compareProcessIdentity(group.leader, row) === "match") return true;
      const sampledMember = members?.get(row.pid);
      if (
        sampledMember !== undefined &&
        compareProcessIdentity(sampledMember, row) === "match"
      ) {
        return true;
      }
      const sampledExternal = this.observedExternal.get(row.pid);
      if (
        sampledExternal !== undefined &&
        compareProcessIdentity(sampledExternal, row) === "match"
      ) {
        return true;
      }
      const sampledTracked = this.trackedDescendants.get(row.pid);
      if (
        sampledTracked !== undefined &&
        compareProcessIdentity(sampledTracked, row) === "match"
      ) {
        return true;
      }
    }
    return false;
  }

  /**
   * Whether the bounded durable registry omits observations the live cleanup
   * can still see. This is recovery completeness only; it never fails a live
   * cleanup by itself.
   */
  private durableRegistryTruncated(): boolean {
    return (
      this.durableTruncated ||
      this.observedGroups.size > MAX_NESTED_GROUPS ||
      this.observedExternalGroupIds.size > MAX_PERSISTED_EXTERNAL_GROUPS ||
      this.observedExternalPids.size > MAX_PERSISTED_EXTERNAL_DESCENDANTS
    );
  }

  /**
   * Build the bounded snapshot from tracked external observations. Returns
   * `undefined` until something external was observed or a bound was exceeded
   * (an empty snapshot is not evidence).
   */
  private buildNestedSnapshot(): WorkerNestedProcesses | undefined {
    const observedCount = this.observedExternalPids.size;
    const groups = [...this.observedGroups.values()]
      .sort((first, second) => first.pgid - second.pgid)
      .slice(0, MAX_NESTED_GROUPS)
      .map(copyNestedGroup);
    const truncated = this.durableRegistryTruncated();
    if (observedCount === 0 && groups.length === 0 && !truncated) {
      return undefined;
    }
    return {
      version: 1,
      host: this.manager.inspector.host,
      observedCount,
      truncated,
      lastObservedAt: this.nestedObservedAt ?? this.startedAt,
      groups,
      identities: [...this.observedExternal.values()]
        .filter((identity) => !this.observedGroups.has(identity.pgid))
        .sort((first, second) => first.pid - second.pid)
        .slice(0, MAX_PERSISTED_EXTERNAL_DESCENDANTS)
        .map(copyIdentity),
    };
  }

  /** Emit only when the bounded snapshot content actually changed. */
  private publishNestedSnapshot(): void {
    const candidate = this.buildNestedSnapshot();
    if (!candidate) return;
    if (nestedSnapshotKey(candidate) === this.nestedSnapshotKey) return;
    const snapshot = this.snapshotNow();
    if (!snapshot) return;
    for (const listener of [...this.nestedSnapshotListeners]) {
      void this.notifyNestedListener(listener, snapshot);
    }
  }

  /** Replace the current snapshot and stamp its observation time. */
  private snapshotNow(): WorkerNestedProcesses | undefined {
    const candidate = this.buildNestedSnapshot();
    if (!candidate) return undefined;
    const observedAt = new Date().toISOString();
    const snapshot: WorkerNestedProcesses = {
      ...candidate,
      lastObservedAt: observedAt,
    };
    this.nestedObservedAt = observedAt;
    this.nestedSnapshotKey = nestedSnapshotKey(snapshot);
    this.nestedSnapshot = snapshot;
    return snapshot;
  }

  private async notifyNestedListener(
    listener: (snapshot: WorkerNestedProcesses) => void | Promise<void>,
    snapshot: WorkerNestedProcesses,
  ): Promise<void> {
    try {
      await listener(copyNestedProcesses(snapshot));
    } catch {
      // A subscriber failure must never break cleanup or the sampler.
    }
  }

  /**
   * Re-notify observers with the freshest registry and await their durable
   * persistence before any nested signal. Sampler emissions are fire-and-
   * forget; this is the only awaited path.
   */
  private async flushNestedSnapshot(): Promise<
    { ok: true } | { ok: false; failure: string }
  > {
    const snapshot = this.snapshotNow();
    if (!snapshot) return { ok: true };
    const failures: string[] = [];
    await Promise.all(
      [...this.nestedSnapshotListeners].map(async (listener) => {
        try {
          await listener(copyNestedProcesses(snapshot));
        } catch (error) {
          failures.push(errorText(error));
        }
      }),
    );
    if (failures.length > 0) {
      return {
        ok: false,
        failure: `nested evidence could not be persisted: ${failures[0]}`,
      };
    }
    return { ok: true };
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
        // Only the live group view exceeding the process-table bound lands
        // here; a truncated durable registry does not fail live cleanup.
        return {
          refreshed: true,
          failure:
            "live external group view exceeded the process-table bound; " +
            "refusing an incomplete nested cleanup",
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
      // Members (and the leader) of a proven external group are one bounded
      // group unit; they are never individual exact-pid targets.
      if (this.observedGroups.has(identity.pgid)) continue;
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

  /**
   * Clean every exact-led external group as one guarded unit. Groups run
   * concurrently so the bounded term/kill grace applies once, not once per
   * group. Any group that cannot be proven gone stays residual, except a group
   * whose leader identity was reused and whose rows carry no sampled worker
   * descendant: that is vanished evidence, never a signal target.
   *
   * With bounded process-table snapshots available, all observed pgids are
   * projected from one snapshot per cleanup phase. A high-fanout external group
   * set therefore never launches one full `ps -A` listing per group. Inspectors
   * without snapshots keep the exact single-group path.
   */
  private async cleanNestedGroups(
    managedPgid: number,
    skipReason: string | undefined,
  ): Promise<NestedGroupCleanupOutcome> {
    const groups = [...this.observedGroups.values()].sort(
      (first, second) => first.pgid - second.pgid,
    );
    if (groups.length === 0) {
      return { observed: 0, signalled: 0, residual: 0, vanished: 0 };
    }
    if (skipReason !== undefined) {
      for (const group of groups) this.residualGroupIds.add(group.pgid);
      return {
        observed: groups.length,
        signalled: 0,
        residual: groups.length,
        vanished: 0,
        failure: skipReason,
      };
    }
    let ownGroupId: number | undefined;
    try {
      ownGroupId = await this.manager.ownGroupId();
    } catch {
      ownGroupId = undefined;
    }
    if (this.manager.descendantInspection) {
      return this.cleanNestedGroupsFromTable(groups, managedPgid, ownGroupId);
    }
    // Legacy fallback: no bounded snapshot source, so inspect one group at a
    // time. Exact identity and membership guards are unchanged.
    const results = await Promise.all(
      groups.map((group) =>
        this.cleanNestedGroup(group, managedPgid, ownGroupId),
      ),
    );
    let signalled = 0;
    let residual = 0;
    let vanished = 0;
    let failure: string | undefined;
    results.forEach((result, index) => {
      if (result.signalled) signalled += 1;
      if (result.vanished) {
        // Never signalled and not residual: the persisted group is gone and
        // the reused id carries no sampled worker descendant.
        vanished += 1;
        failure ??= result.failure;
        return;
      }
      if (!result.gone) {
        residual += 1;
        const group = groups[index];
        if (group) this.residualGroupIds.add(group.pgid);
      }
      failure ??= result.failure;
    });
    return {
      observed: groups.length,
      signalled,
      residual,
      vanished,
      ...(failure !== undefined ? { failure } : {}),
    };
  }

  /**
   * Table-batched external-group cleanup.
   *
   * Each phase takes one bounded snapshot and projects exact leader identity
   * plus membership for every observed pgid: initial inspection, the TERM
   * wait, escalation revalidation and the KILL wait. No per-group listing or
   * per-group leader capture runs on this path. A snapshot failure, a missing
   * leader with members remaining and an unclean group stay residual and fail
   * the cleanup closed. A reused identity is never signalled: it becomes
   * vanished evidence unless a remaining row still matches a sampled worker
   * descendant, in which case it stays needs_human.
   */
  private async cleanNestedGroupsFromTable(
    groups: readonly WorkerNestedGroup[],
    managedPgid: number,
    ownGroupId: number | undefined,
  ): Promise<NestedGroupCleanupOutcome> {
    const outcomes = new Map<number, TableGroupOutcome>();
    const fail = (
      group: WorkerNestedGroup,
      failure: string,
      signalled = false,
    ): void => {
      outcomes.set(group.pgid, { gone: false, signalled, failure });
    };

    // Phase 1: leader identity and membership for every pgid from one table.
    let memberships: Map<number, ProcessTableEntry[]>;
    try {
      memberships = await this.snapshotGroupMemberships(
        groups.map((group) => group.pgid),
      );
    } catch (error) {
      for (const group of groups) {
        fail(
          group,
          `cannot snapshot external process groups: ${errorText(error)}`,
        );
      }
      return this.summarizeTableGroups(groups, outcomes);
    }

    const awaitingTerm: WorkerNestedGroup[] = [];
    const vanishedOnTerm: WorkerNestedGroup[] = [];
    for (const group of groups) {
      const inspection = await this.inspectGroupRows(
        group,
        memberships.get(group.pgid) ?? [],
        managedPgid,
        ownGroupId,
        "inspect",
      );
      if (!inspection.ok) {
        fail(group, inspection.reason);
        continue;
      }
      if (inspection.gone) {
        outcomes.set(group.pgid, { gone: true, signalled: false });
        continue;
      }
      if (inspection.vanished) {
        outcomes.set(group.pgid, {
          gone: false,
          signalled: false,
          vanished: true,
        });
        continue;
      }
      const term = this.signalNestedGroup(group.pgid, "SIGTERM");
      if (term === "error") {
        fail(group, `SIGTERM to external group ${group.pgid} failed`);
        continue;
      }
      if (term === "gone") {
        // ESRCH alone never proves a group gone: a fresh projection must still
        // show that no member remains.
        vanishedOnTerm.push(group);
        continue;
      }
      awaitingTerm.push(group);
    }

    if (vanishedOnTerm.length > 0) {
      let verification: Map<number, ProcessTableEntry[]>;
      try {
        verification = await this.snapshotGroupMemberships(
          vanishedOnTerm.map((group) => group.pgid),
        );
      } catch (error) {
        for (const group of vanishedOnTerm) {
          fail(
            group,
            `external group ${group.pgid} disappeared and could not be ` +
              `re-inspected: ${errorText(error)}`,
          );
        }
        verification = new Map();
      }
      for (const group of vanishedOnTerm) {
        if (outcomes.has(group.pgid)) continue;
        const rows = verification.get(group.pgid) ?? [];
        if (rows.length === 0) {
          outcomes.set(group.pgid, { gone: true, signalled: false });
        } else {
          fail(
            group,
            `external group ${group.pgid} disappeared while member(s) remain`,
          );
        }
      }
    }

    await this.settleTerminatedGroups(
      awaitingTerm,
      managedPgid,
      ownGroupId,
      outcomes,
    );
    return this.summarizeTableGroups(groups, outcomes);
  }

  /**
   * Wait for TERM'd groups from shared snapshots, then revalidate each
   * survivor's exact leader and membership before a guarded SIGKILL.
   */
  private async settleTerminatedGroups(
    groups: readonly WorkerNestedGroup[],
    managedPgid: number,
    ownGroupId: number | undefined,
    outcomes: Map<number, TableGroupOutcome>,
  ): Promise<void> {
    if (groups.length === 0) return;
    const wait = await this.waitForGroupsEmpty(groups, this.manager.termGraceMs);
    if (wait.error !== undefined) {
      for (const group of groups) {
        outcomes.set(group.pgid, {
          gone: false,
          signalled: true,
          failure:
            `external group ${group.pgid} became uninspectable after ` +
            `SIGTERM: ${wait.error}`,
        });
      }
      return;
    }
    const survivors: WorkerNestedGroup[] = [];
    for (const group of groups) {
      if (wait.survivors.has(group.pgid)) survivors.push(group);
      else outcomes.set(group.pgid, { gone: true, signalled: true });
    }
    if (survivors.length === 0) return;

    // One fresh snapshot supplies both the exact leader revalidation and the
    // kill-phase membership guard for every survivor.
    const awaitingKill: WorkerNestedGroup[] = [];
    const vanishedOnKill: WorkerNestedGroup[] = [];
    for (const group of survivors) {
      const inspection = await this.inspectGroupRows(
        group,
        wait.survivors.get(group.pgid) ?? [],
        managedPgid,
        ownGroupId,
        "escalate",
      );
      if (!inspection.ok) {
        outcomes.set(group.pgid, {
          gone: false,
          signalled: true,
          failure: inspection.reason,
        });
        continue;
      }
      if (inspection.gone) {
        outcomes.set(group.pgid, { gone: true, signalled: true });
        continue;
      }
      const kill = this.signalNestedGroup(group.pgid, "SIGKILL");
      if (kill === "error") {
        outcomes.set(group.pgid, {
          gone: false,
          signalled: true,
          failure: `SIGKILL to external group ${group.pgid} failed`,
        });
        continue;
      }
      if (kill === "gone") {
        vanishedOnKill.push(group);
        continue;
      }
      awaitingKill.push(group);
    }

    if (vanishedOnKill.length > 0) {
      let verification: Map<number, ProcessTableEntry[]>;
      try {
        verification = await this.snapshotGroupMemberships(
          vanishedOnKill.map((group) => group.pgid),
        );
      } catch (error) {
        for (const group of vanishedOnKill) {
          outcomes.set(group.pgid, {
            gone: false,
            signalled: true,
            failure:
              `external group ${group.pgid} disappeared and could not be ` +
              `re-inspected after SIGKILL: ${errorText(error)}`,
          });
        }
        verification = new Map();
      }
      for (const group of vanishedOnKill) {
        if (outcomes.has(group.pgid)) continue;
        if ((verification.get(group.pgid) ?? []).length === 0) {
          outcomes.set(group.pgid, { gone: true, signalled: true });
          continue;
        }
        outcomes.set(group.pgid, {
          gone: false,
          signalled: true,
          failure:
            `external group ${group.pgid} disappeared while member(s) remain`,
        });
      }
    }

    if (awaitingKill.length === 0) return;
    const afterKill = await this.waitForGroupsEmpty(
      awaitingKill,
      this.manager.killGraceMs,
    );
    if (afterKill.error !== undefined) {
      for (const group of awaitingKill) {
        outcomes.set(group.pgid, {
          gone: false,
          signalled: true,
          failure:
            `external group ${group.pgid} became uninspectable after ` +
            `SIGKILL: ${afterKill.error}`,
        });
      }
      return;
    }
    for (const group of awaitingKill) {
      const rows = afterKill.survivors.get(group.pgid);
      if (rows === undefined) {
        outcomes.set(group.pgid, { gone: true, signalled: true });
      } else {
        outcomes.set(group.pgid, {
          gone: false,
          signalled: true,
          failure:
            `external group ${group.pgid} still has ${rows.length} member(s) ` +
            "after SIGKILL",
        });
      }
    }
  }

  /**
   * Re-prove one persisted group from a fresh projection. The leader row must
   * exist with the exact persisted `(pid, pgid, startedAt)`, membership must
   * still belong to the group, and the group must be provably distinct from
   * cliyard's and the managed worker's group. Anything less fails closed.
   */
  private async inspectGroupRows(
    group: WorkerNestedGroup,
    rows: readonly ProcessTableEntry[],
    managedPgid: number,
    ownGroupId: number | undefined,
    phase: "inspect" | "escalate",
  ): Promise<
    | { ok: true; gone: boolean; vanished?: boolean }
    | { ok: false; reason: string }
  > {
    const pgid = group.pgid;
    if (rows.length === 0) return { ok: true, gone: true };
    const leaderRow = rows.find((row) => row.pid === pgid);
    if (!leaderRow) {
      return {
        ok: false,
        reason:
          phase === "escalate"
            ? `external group ${pgid} leader identity is no longer exact ` +
              "after SIGTERM; refusing SIGKILL"
            : `external group ${pgid} leader is absent while ` +
              `${rows.length} member(s) remain`,
      };
    }
    const observed: RuntimeProcessIdentity = {
      pid: leaderRow.pid,
      pgid: leaderRow.pgid,
      startedAt: leaderRow.startedAt,
    };
    const comparison = compareProcessIdentity(group.leader, observed);
    if (comparison !== "match") {
      if (phase === "escalate") {
        return {
          ok: false,
          reason:
            `external group ${pgid} leader identity is no longer exact ` +
            "after SIGTERM; refusing SIGKILL",
        };
      }
      if (comparison !== "mismatch") {
        // No complete evidence that the persisted identity was replaced.
        return {
          ok: false,
          reason:
            `external group ${pgid} leader identity could not be compared; ` +
            "refusing a group signal",
        };
      }
      if (this.remainingRowsMatchSampledDescendant(group, rows)) {
        return {
          ok: false,
          reason:
            `external group ${pgid} leader identity changed or was reused ` +
            "and a sampled worker descendant remains; refusing a group signal",
        };
      }
      // The persisted exact group is gone; the pid/pgid now belongs to an
      // unrelated process. No signal is authorized. This is vanished evidence,
      // not a residual leak.
      return { ok: true, gone: false, vanished: true };
    }
    // The projection guarantees `row.pgid === pgid`; the guard re-checks the
    // exact leader row, cliyard's own group/id and membership consistency.
    const guard = await this.nestedGroupSignalAllowed(
      group.leader,
      observed,
      rows,
      managedPgid,
      ownGroupId,
    );
    if (!guard.ok) return guard;
    return { ok: true, gone: false };
  }

  /** Merge per-group phase outcomes into bounded cleanup counters/evidence. */
  private summarizeTableGroups(
    groups: readonly WorkerNestedGroup[],
    outcomes: ReadonlyMap<number, TableGroupOutcome>,
  ): NestedGroupCleanupOutcome {
    let signalled = 0;
    let residual = 0;
    let vanished = 0;
    let failure: string | undefined;
    for (const group of groups) {
      const outcome = outcomes.get(group.pgid);
      if (outcome === undefined) {
        // Every observed group must reach an outcome. A missing one is an
        // internal ambiguity, never a clean group.
        residual += 1;
        this.residualGroupIds.add(group.pgid);
        failure ??= `external group ${group.pgid} was not inspected`;
        continue;
      }
      if (outcome.signalled) signalled += 1;
      if (outcome.vanished) {
        // Leader identity was reused and no sampled worker descendant remains.
        // The unverified group was never signalled and is not residual.
        vanished += 1;
        continue;
      }
      if (outcome.gone) continue;
      residual += 1;
      this.residualGroupIds.add(group.pgid);
      failure ??=
        outcome.failure ?? `external group ${group.pgid} was not proven gone`;
    }
    return {
      observed: groups.length,
      signalled,
      residual,
      vanished,
      ...(failure !== undefined ? { failure } : {}),
    };
  }

  /**
   * Project membership for the requested pgids from one bounded process-table
   * snapshot, sharing a single `ps -A` scan across every group in a phase.
   */
  private async snapshotGroupMemberships(
    pgids: readonly number[],
  ): Promise<Map<number, ProcessTableEntry[]>> {
    const table = await this.manager.snapshotTable({
      maxEntries: MAX_PROCESS_TABLE_ROWS,
    });
    return projectGroupMembers(table, new Set(pgids));
  }

  /**
   * Poll one shared snapshot until every group is gone or the grace deadline
   * passes, and return the last observed membership for each survivor. A
   * snapshot failure is reported instead of treating an uninspectable group as
   * gone.
   */
  private async waitForGroupsEmpty(
    groups: readonly WorkerNestedGroup[],
    graceMs: number,
  ): Promise<{
    survivors: Map<number, ProcessTableEntry[]>;
    error?: string;
  }> {
    const pgids = groups.map((group) => group.pgid);
    const deadline = Date.now() + graceMs;
    for (;;) {
      let memberships: Map<number, ProcessTableEntry[]>;
      try {
        memberships = await this.snapshotGroupMemberships(pgids);
      } catch (error) {
        return { survivors: new Map(), error: errorText(error) };
      }
      const survivors = new Map<number, ProcessTableEntry[]>();
      for (const group of groups) {
        const rows = memberships.get(group.pgid);
        if (rows !== undefined && rows.length > 0) {
          survivors.set(group.pgid, rows);
        }
      }
      if (survivors.size === 0 || Date.now() >= deadline) {
        return { survivors };
      }
      await sleep(
        Math.min(this.manager.pollMs, Math.max(1, deadline - Date.now())),
      );
    }
  }

  private async cleanNestedGroup(
    group: WorkerNestedGroup,
    managedPgid: number,
    ownGroupId: number | undefined,
  ): Promise<{
    gone: boolean;
    signalled: boolean;
    vanished?: boolean;
    failure?: string;
  }> {
    const pgid = group.pgid;
    let leader: RuntimeProcessIdentity | undefined;
    try {
      leader = await this.manager.inspector.capture(group.leader.pid);
    } catch (error) {
      return {
        gone: false,
        signalled: false,
        failure:
          `cannot revalidate external group ${pgid} leader: ${errorText(error)}`,
      };
    }
    if (!leader) {
      // An absent leader never authorizes a group signal. Verify whether any
      // exact member remains so the outcome is evidence, not a guess.
      try {
        const members = await this.manager.listMembers(pgid);
        if (members.length === 0) return { gone: true, signalled: false };
        return {
          gone: false,
          signalled: false,
          failure:
            `external group ${pgid} leader is absent while ` +
            `${members.length} member(s) remain`,
        };
      } catch (error) {
        return {
          gone: false,
          signalled: false,
          failure:
            `external group ${pgid} could not be inspected after its leader ` +
            `disappeared: ${errorText(error)}`,
        };
      }
    }
    const comparison = compareProcessIdentity(group.leader, leader);
    if (comparison !== "match" || leader.pid !== leader.pgid) {
      // The leader PID may have been reused after the original group exited.
      // In that case the persisted pgid is already empty and no signal is
      // needed. Only fail closed when the original group still has members.
      try {
        const members = await this.manager.listMembers(pgid);
        if (members.length === 0) return { gone: true, signalled: false };
        if (comparison === "mismatch") {
          if (this.remainingRowsMatchSampledDescendant(group, members)) {
            return {
              gone: false,
              signalled: false,
              failure:
                `external group ${pgid} leader identity changed or was reused ` +
                "and a sampled worker descendant remains; refusing a group signal",
            };
          }
          // The persisted group is gone and no sampled worker descendant
          // remains under the reused id. Never signal the unverified group;
          // record it as vanished evidence instead of a residual leak.
          return { gone: false, signalled: false, vanished: true };
        }
      } catch (error) {
        return {
          gone: false,
          signalled: false,
          failure:
            `external group ${pgid} leader identity changed and the old ` +
            `group could not be inspected: ${errorText(error)}`,
        };
      }
      return {
        gone: false,
        signalled: false,
        failure:
          `external group ${pgid} leader identity changed or was reused; ` +
          "refusing a group signal",
      };
    }

    let members: ProcessGroupMember[];
    try {
      members = await this.manager.listMembers(pgid);
    } catch (error) {
      return {
        gone: false,
        signalled: false,
        failure:
          `cannot inspect external group ${pgid}: ${errorText(error)}`,
      };
    }
    if (members.length === 0) return { gone: true, signalled: false };

    const guard = await this.nestedGroupSignalAllowed(
      group.leader,
      leader,
      members,
      managedPgid,
      ownGroupId,
    );
    if (!guard.ok) {
      return { gone: false, signalled: false, failure: guard.reason };
    }

    const term = this.signalNestedGroup(pgid, "SIGTERM");
    if (term === "error") {
      return {
        gone: false,
        signalled: false,
        failure: `SIGTERM to external group ${pgid} failed`,
      };
    }
    if (term === "gone") {
      try {
        members = await this.manager.listMembers(pgid);
      } catch (error) {
        return {
          gone: false,
          signalled: false,
          failure:
            `external group ${pgid} disappeared and could not be ` +
            `re-inspected: ${errorText(error)}`,
        };
      }
      if (members.length === 0) return { gone: true, signalled: false };
      return {
        gone: false,
        signalled: false,
        failure:
          `external group ${pgid} disappeared while member(s) remain`,
      };
    }
    try {
      members = await this.waitForEmpty(pgid, this.manager.termGraceMs);
    } catch (error) {
      return {
        gone: false,
        signalled: true,
        failure:
          `external group ${pgid} became uninspectable after SIGTERM: ` +
          errorText(error),
      };
    }
    if (members.length === 0) return { gone: true, signalled: true };

    // Escalation needs the same fresh exact leader guard, not the evidence
    // that authorized SIGTERM.
    let revalidated: RuntimeProcessIdentity | undefined;
    try {
      revalidated = await this.manager.inspector.capture(group.leader.pid);
    } catch (error) {
      return {
        gone: false,
        signalled: true,
        failure:
          `cannot revalidate external group ${pgid} leader after SIGTERM: ` +
          errorText(error),
      };
    }
    if (
      !revalidated ||
      compareProcessIdentity(group.leader, revalidated) !== "match"
    ) {
      return {
        gone: false,
        signalled: true,
        failure:
          `external group ${pgid} leader identity is no longer exact after ` +
          "SIGTERM; refusing SIGKILL",
      };
    }
    const killGuard = await this.nestedGroupSignalAllowed(
      group.leader,
      revalidated,
      members,
      managedPgid,
      ownGroupId,
    );
    if (!killGuard.ok) {
      return { gone: false, signalled: true, failure: killGuard.reason };
    }
    const kill = this.signalNestedGroup(pgid, "SIGKILL");
    if (kill === "error") {
      return {
        gone: false,
        signalled: true,
        failure: `SIGKILL to external group ${pgid} failed`,
      };
    }
    if (kill === "gone") {
      try {
        members = await this.manager.listMembers(pgid);
      } catch (error) {
        return {
          gone: false,
          signalled: true,
          failure:
            `external group ${pgid} disappeared and could not be ` +
            `re-inspected after SIGKILL: ${errorText(error)}`,
        };
      }
      if (members.length === 0) return { gone: true, signalled: true };
      return {
        gone: false,
        signalled: true,
        failure:
          `external group ${pgid} disappeared while member(s) remain`,
      };
    }
    try {
      members = await this.waitForEmpty(pgid, this.manager.killGraceMs);
    } catch (error) {
      return {
        gone: false,
        signalled: true,
        failure:
          `external group ${pgid} became uninspectable after SIGKILL: ` +
          errorText(error),
      };
    }
    if (members.length === 0) return { gone: true, signalled: true };
    return {
      gone: false,
      signalled: true,
      failure:
        `external group ${pgid} still has ${members.length} member(s) ` +
        "after SIGKILL",
    };
  }

  /**
   * A negative-pgid signal is allowed only when the persisted leader, a fresh
   * capture and a fresh membership listing all prove the same exact group,
   * and the group is provably not cliyard's or the recovery process's.
   */
  private async nestedGroupSignalAllowed(
    expected: RuntimeProcessIdentity,
    observed: RuntimeProcessIdentity,
    members: readonly ProcessGroupMember[],
    managedPgid: number,
    ownGroupId: number | undefined,
  ): Promise<{ ok: true } | { ok: false; reason: string }> {
    const pgid = expected.pgid;
    if (
      !isProcessPid(pgid) ||
      pgid <= 1 ||
      expected.pid !== pgid ||
      observed.pid !== pgid ||
      observed.pgid !== pgid
    ) {
      return {
        ok: false,
        reason: "refusing an invalid or non-exact nested group leader",
      };
    }
    if (pgid === process.pid) {
      return { ok: false, reason: "refusing cliyard's own process id as a group" };
    }
    if (pgid === managedPgid) {
      return {
        ok: false,
        reason: "refusing the managed worker group as a nested group",
      };
    }
    if (!isProcessPid(ownGroupId) || ownGroupId === pgid) {
      return {
        ok: false,
        reason:
          "cannot prove the nested group differs from cliyard's process group",
      };
    }
    if (compareProcessIdentity(expected, observed) !== "match") {
      return {
        ok: false,
        reason: "the nested group leader identity no longer matches",
      };
    }
    if (members.length === 0) {
      return { ok: false, reason: "nested group membership disappeared" };
    }
    if (members.some((member) => member.pgid !== pgid)) {
      return {
        ok: false,
        reason: "nested group membership is inconsistent with the group id",
      };
    }
    if (members.some((member) => member.pid === process.pid || member.pid <= 1)) {
      return {
        ok: false,
        reason: "refusing a nested group that contains cliyard itself",
      };
    }
    const leader = members.find((member) => member.pid === pgid);
    if (!leader || compareProcessIdentity(expected, leader) !== "match") {
      return {
        ok: false,
        reason: "the exact nested group leader is absent from fresh membership",
      };
    }
    return { ok: true };
  }

  private signalNestedGroup(
    pgid: number,
    signal: "SIGTERM" | "SIGKILL",
  ): "sent" | "gone" | "error" {
    if (!isProcessPid(pgid) || pgid <= 1 || pgid === process.pid) {
      return "error";
    }
    try {
      process.kill(-pgid, signal);
      this.signalledGroupIds.add(pgid);
      this.recordSignal({
        signal,
        scope: "nested-process-group",
        pgid,
        at: new Date().toISOString(),
        result: "sent",
      });
      return "sent";
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return "gone";
      this.recordSignal({
        signal,
        scope: "nested-process-group",
        pgid,
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
    // The refreshed group/fallback registry must be durable before any nested
    // signal. A failed flush keeps nested signals unsent and fails closed while
    // the top-level managed group is still cleaned.
    const flush = await this.flushNestedSnapshot();
    const nestedPriorFailure = combineDetail(
      refresh.failure ?? (refresh.refreshed ? undefined : this.samplerError),
      flush.ok ? undefined : flush.failure,
    );

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
    if (!flush.ok) {
      plan = {
        targets: [],
        refused: candidates,
        failure: nestedPriorFailure,
      };
    } else {
      try {
        plan = await this.prepareNested(candidates, pgid, pid, nestedPriorFailure);
      } catch (error) {
        plan = {
          targets: [],
          refused: candidates,
          failure: `nested cleanup crashed: ${errorText(error)}`,
        };
      }
    }

    // External groups are one guarded unit each; their members never enter the
    // exact-pid plan above.
    const nestedGroups = await this.cleanNestedGroups(
      pgid,
      flush.ok ? undefined : flush.failure,
    );
    const group = await this.cleanManagedGroup(pgid, pid, identity, members);
    const nested = await this.settleNested({
      targets: plan.targets,
      refused: plan.refused,
      managedPgid: pgid,
      failure: plan.failure,
      nestedGroups,
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
    nestedGroups: NestedGroupCleanupOutcome;
  }): Promise<{
    evidence?: WorkerNestedCleanupEvidence;
    failure?: string;
  }> {
    let failure = combineDetail(
      options.failure,
      options.nestedGroups.failure,
    );
    const residual = new Set<number>();
    for (const identity of options.refused) {
      if (this.manager.isAlive(identity.pid)) residual.add(identity.pid);
    }
    const hadNestedWork =
      this.observedExternalPids.size > 0 ||
      this.observedGroups.size > 0 ||
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
    const observedGroups = this.observedGroups.size;
    const signalledGroups = this.signalledGroupIds.size;
    const residualGroups = this.residualGroupIds.size;
    const vanishedGroups = options.nestedGroups.vanished;
    const state: WorkerNestedCleanupState =
      failure !== undefined
        ? "failed"
        : observedDescendants === 0 && observedGroups === 0
          ? "none"
          : signalledDescendants === 0 && signalledGroups === 0
            ? "clean"
            : "terminated";
    return {
      evidence: {
        state,
        observedDescendants,
        signalledDescendants,
        residualDescendants: residual.size,
        ...(observedGroups > 0
          ? {
              observedGroups,
              signalledGroups,
              residualGroups,
              ...(vanishedGroups > 0 ? { vanishedGroups } : {}),
            }
          : {}),
        cleanupCompleteness:
          failure !== undefined ? "incomplete" : "complete",
        durableRecoveryCompleteness: this.durableRegistryTruncated()
          ? "truncated"
          : "complete",
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
    const observedGroups = this.observedGroups.size;
    const nestedCleanup =
      this.nestedCleanup ??
      (observedExternal > 0 || observedGroups > 0
        ? {
            state: "failed" as const,
            observedDescendants: observedExternal,
            signalledDescendants: this.signalledDescendantPids.size,
            residualDescendants: Math.max(
              0,
              observedExternal - this.signalledDescendantPids.size,
            ),
            ...(observedGroups > 0
              ? {
                  observedGroups,
                  signalledGroups: this.signalledGroupIds.size,
                  // No group was verified gone on this early path.
                  residualGroups: observedGroups,
                }
              : {}),
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
      // The live outcome and the durable registry bound are separate facts:
      // a complete live cleanup may leave a truncated recovery registry.
      cleanupCompleteness:
        state === "unsupported"
          ? "unsupported"
          : state === "failed"
            ? "incomplete"
            : "complete",
      durableRecoveryCompleteness: this.durableRegistryTruncated()
        ? "truncated"
        : "complete",
      signals: this.signals.map((signal) => ({ ...signal })),
      residualMembers: this.residualMembers.map((member) => ({ ...member })),
      residualCount: this.residualCount,
      ...(this.observedExternalPids.size > 0 ||
      this.observedExternalGroupIds.size > 0
        ? {
            ...(this.observedExternalPids.size > 0
              ? {
                  observedExternalDescendants: [...this.observedExternal.values()]
                    .filter(
                      (identity) => !this.observedGroups.has(identity.pgid),
                    )
                    .sort((first, second) => first.pid - second.pid)
                    .slice(0, MAX_PERSISTED_EXTERNAL_DESCENDANTS)
                    .map((identity) => copyIdentity(identity)),
                  observedExternalDescendantCount:
                    this.observedExternalPids.size,
                }
              : {}),
            observedExternalGroups: [...this.observedExternalGroupIds]
              .sort((first, second) => first - second)
              .slice(0, MAX_PERSISTED_EXTERNAL_GROUPS),
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
  let cleanupCompleteness: WorkerCleanupCompleteness | undefined;
  if (value.cleanupCompleteness !== undefined) {
    if (
      typeof value.cleanupCompleteness !== "string" ||
      !CLEANUP_COMPLETENESS_STATES.has(value.cleanupCompleteness)
    ) {
      return undefined;
    }
    cleanupCompleteness =
      value.cleanupCompleteness as WorkerCleanupCompleteness;
  }
  let durableRecoveryCompleteness:
    | WorkerDurableRecoveryCompleteness
    | undefined;
  if (value.durableRecoveryCompleteness !== undefined) {
    if (
      typeof value.durableRecoveryCompleteness !== "string" ||
      !DURABLE_RECOVERY_COMPLETENESS_STATES.has(
        value.durableRecoveryCompleteness,
      )
    ) {
      return undefined;
    }
    durableRecoveryCompleteness =
      value.durableRecoveryCompleteness as WorkerDurableRecoveryCompleteness;
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
  const nested = parseNestedCleanup(
    value.nestedCleanup,
    external.count,
    externalGroups !== undefined,
  );
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
    ...(cleanupCompleteness !== undefined ? { cleanupCompleteness } : {}),
    ...(durableRecoveryCompleteness !== undefined
      ? { durableRecoveryCompleteness }
      : {}),
    signals,
    residualMembers: residual,
    residualCount: value.residualCount,
    ...(external.count !== undefined && external.descendants !== undefined
      ? {
          observedExternalDescendants: external.descendants,
          observedExternalDescendantCount: external.count,
        }
      : {}),
    ...(externalGroups !== undefined
      ? { observedExternalGroups: externalGroups }
      : {}),
    ...(nested !== undefined ? { nestedCleanup: nested } : {}),
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
        scope !== "descendant-pid" &&
        scope !== "nested-process-group") ||
      (result !== "sent" && result !== "failed") ||
      !isTimestamp(value.at)
    ) {
      return undefined;
    }
    let pid: number | undefined;
    let pgid: number | undefined;
    if (scope === "descendant-pid") {
      if (!isProcessPid(value.pid) || value.pgid !== undefined) {
        return undefined;
      }
      pid = value.pid;
    } else if (scope === "nested-process-group") {
      if (!isProcessPid(value.pgid) || value.pgid <= 1 || value.pid !== undefined) {
        return undefined;
      }
      pgid = value.pgid;
    } else if (value.pid !== undefined || value.pgid !== undefined) {
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
      ...(pgid !== undefined ? { pgid } : {}),
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
  groupsPresent: boolean,
): WorkerNestedCleanupEvidence | null | undefined {
  const externalPresent = externalCount !== undefined;
  const groupsOnly = !externalPresent && groupsPresent;
  if (raw === undefined) {
    return externalPresent || groupsOnly ? null : undefined;
  }
  if (!externalPresent && !groupsPresent) return null;
  if (!isRecord(raw)) return null;
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
    observed !== (externalCount ?? 0) ||
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
  const hasGroupCounters =
    raw.observedGroups !== undefined ||
    raw.signalledGroups !== undefined ||
    raw.residualGroups !== undefined ||
    raw.vanishedGroups !== undefined;
  let observedGroups: number | undefined;
  let signalledGroups: number | undefined;
  let residualGroups: number | undefined;
  let vanishedGroups: number | undefined;
  if (hasGroupCounters) {
    if (!groupsPresent) return null;
    observedGroups = raw.observedGroups as number;
    signalledGroups = raw.signalledGroups as number;
    residualGroups = raw.residualGroups as number;
    if (
      !Number.isInteger(observedGroups) ||
      observedGroups < 1 ||
      // Live cleanup counters are bounded by the process-table snapshot, not
      // by the smaller durable-registry persistence bound.
      observedGroups > MAX_LIVE_NESTED_GROUPS ||
      !Number.isInteger(signalledGroups) ||
      signalledGroups < 0 ||
      signalledGroups > observedGroups ||
      !Number.isInteger(residualGroups) ||
      residualGroups < 0 ||
      residualGroups > observedGroups
    ) {
      return null;
    }
    if (raw.vanishedGroups !== undefined) {
      vanishedGroups = raw.vanishedGroups as number;
      if (
        !Number.isInteger(vanishedGroups) ||
        vanishedGroups < 0 ||
        vanishedGroups > observedGroups
      ) {
        return null;
      }
    }
  } else if (groupsOnly) {
    // A group-only record must carry its bounded group counters; legacy
    // records with exact-pid evidence stay readable without them.
    return null;
  }
  const signalledTotal = signalled + (signalledGroups ?? 0);
  const residualTotal = residual + (residualGroups ?? 0);
  if (
    (state === "none" && (observed !== 0 || (observedGroups ?? 0) !== 0)) ||
    (state === "terminated" && signalledTotal === 0) ||
    (state === "clean" && signalledTotal !== 0) ||
    (state !== "failed" && residualTotal !== 0)
  ) {
    return null;
  }
  let cleanupCompleteness: WorkerCleanupCompleteness | undefined;
  if (raw.cleanupCompleteness !== undefined) {
    if (
      typeof raw.cleanupCompleteness !== "string" ||
      !CLEANUP_COMPLETENESS_STATES.has(raw.cleanupCompleteness)
    ) {
      return null;
    }
    cleanupCompleteness =
      raw.cleanupCompleteness as WorkerCleanupCompleteness;
  }
  let durableRecoveryCompleteness:
    | WorkerDurableRecoveryCompleteness
    | undefined;
  if (raw.durableRecoveryCompleteness !== undefined) {
    if (
      typeof raw.durableRecoveryCompleteness !== "string" ||
      !DURABLE_RECOVERY_COMPLETENESS_STATES.has(
        raw.durableRecoveryCompleteness,
      )
    ) {
      return null;
    }
    durableRecoveryCompleteness =
      raw.durableRecoveryCompleteness as WorkerDurableRecoveryCompleteness;
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
    ...(observedGroups !== undefined
      ? {
          observedGroups,
          signalledGroups: signalledGroups as number,
          residualGroups: residualGroups as number,
          ...(vanishedGroups !== undefined ? { vanishedGroups } : {}),
        }
      : {}),
    ...(cleanupCompleteness !== undefined ? { cleanupCompleteness } : {}),
    ...(durableRecoveryCompleteness !== undefined
      ? { durableRecoveryCompleteness }
      : {}),
    ...(detail !== undefined ? { detail } : {}),
  };
}

/**
 * Project per-pgid membership from one bounded process-table snapshot.
 *
 * The projection is fail-closed: an oversized table, a duplicate/invalid pid or
 * a row for a requested group without a complete exact identity invalidates the
 * whole snapshot, because a silently dropped member would make a live group
 * look gone. Membership is keyed only by the row's exact pgid.
 */
function projectGroupMembers(
  table: readonly ProcessTableEntry[],
  pgids: ReadonlySet<number>,
): Map<number, ProcessTableEntry[]> {
  if (table.length > MAX_PROCESS_TABLE_ROWS) {
    throw new Error(
      `process table exceeds ${MAX_PROCESS_TABLE_ROWS} rows; refusing a ` +
        "partial group projection",
    );
  }
  const seen = new Set<number>();
  const memberships = new Map<number, ProcessTableEntry[]>();
  for (const entry of table) {
    const entryPid: unknown = entry.pid;
    if (
      typeof entryPid !== "number" ||
      !Number.isInteger(entryPid) ||
      entryPid <= 0 ||
      seen.has(entryPid)
    ) {
      throw new Error(
        `process table contains a duplicate or invalid pid ` +
          `${String(entryPid)}`,
      );
    }
    seen.add(entryPid);
    if (!pgids.has(entry.pgid)) continue;
    const identityCandidate: unknown = entry;
    if (!isProcessIdentity(identityCandidate)) {
      throw new Error(
        `process table row for pid ${entryPid} has no exact identity`,
      );
    }
    const rows = memberships.get(entry.pgid);
    if (rows) rows.push(entry);
    else memberships.set(entry.pgid, [entry]);
  }
  return memberships;
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

function copyNestedGroup(group: WorkerNestedGroup): WorkerNestedGroup {
  return {
    pgid: group.pgid,
    leader: copyIdentity(group.leader),
    observedMemberCount: group.observedMemberCount,
    lastObservedAt: group.lastObservedAt,
  };
}

function copyNestedProcesses(
  snapshot: WorkerNestedProcesses,
): WorkerNestedProcesses {
  return {
    version: 1,
    host: snapshot.host,
    observedCount: snapshot.observedCount,
    truncated: snapshot.truncated,
    lastObservedAt: snapshot.lastObservedAt,
    ...(snapshot.groups !== undefined
      ? { groups: snapshot.groups.map(copyNestedGroup) }
      : {}),
    identities: snapshot.identities.map(copyIdentity),
  };
}

function nestedSnapshotKey(snapshot: WorkerNestedProcesses): string {
  return JSON.stringify([
    snapshot.host,
    snapshot.observedCount,
    snapshot.truncated,
    (snapshot.groups ?? []).map((group) => [
      group.pgid,
      group.leader.pid,
      group.leader.pgid,
      group.leader.startedAt,
      group.observedMemberCount,
    ]),
    snapshot.identities.map((identity) => [
      identity.pid,
      identity.pgid,
      identity.startedAt,
    ]),
  ]);
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

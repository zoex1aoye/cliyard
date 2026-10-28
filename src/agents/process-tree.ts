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
 * Safety rules:
 * - A group signal requires `pgid === worker pid` (the dedicated group created
 *   by `setsid`), a re-listed membership that still belongs to it, and proof
 *   that the group is not cliyard's own group. Anything less fails closed.
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
  ProcessInspector,
  compareProcessIdentity,
  isProcessIdentity,
  isProcessPid,
  type ProcessGroupMember,
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
export const MAX_PROCESS_TREE_SIGNALS = 8;
/** Maximum persisted free-form detail length. */
export const MAX_PROCESS_TREE_DETAIL = 600;
/** Hard bound for the observed residual count (evidence only). */
export const MAX_PROCESS_TREE_RESIDUAL_COUNT = 100_000;
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

export interface WorkerProcessSignalRecord {
  signal: "SIGTERM" | "SIGKILL";
  scope: "process-group" | "pid";
  at: string;
  result: "sent" | "failed";
  detail?: string;
}

/**
 * Bounded, credential-free evidence for one managed worker process tree.
 * `identity` is the exact OS-reported leader identity when it was capturable.
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
}

export interface WorkerProcessTreeManagerOptions {
  inspector?: WorkerProcessTreeInspector;
  /** Platform gate; defaults to `process.platform`. Tests may simulate it. */
  platform?: NodeJS.Platform;
  termGraceMs?: number;
  killGraceMs?: number;
  pollMs?: number;
}

export interface ManagedWorkerProcess {
  readonly child: ChildProcess;
  readonly pid: number | undefined;
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
  }

  /** Whether POSIX group capture/inspection is available here. */
  get posixGroups(): boolean {
    return this.platform !== "win32" && this.inspector.supported;
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

  isAlive(pid: number | undefined): boolean {
    return this.inspector.isAlive(pid);
  }
}

class ManagedWorkerProcessImpl implements ManagedWorkerProcess {
  readonly child: ChildProcess;
  private readonly manager: WorkerProcessTreeManager;
  private readonly startedAt: string;
  private readonly capturePromise: Promise<CaptureResult>;
  private readonly captureSupport: WorkerCaptureSupport;
  private readonly signals: WorkerProcessSignalRecord[] = [];
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
    this.captureSupport = manager.captureSupport();
    // Start identity capture synchronously after spawn: first, so the ps child
    // observes the worker before an extremely short CLI can exit.
    this.capturePromise = this.startCapture();
    child.on("exit", (code, signal) => {
      if (this.closedAt === undefined) {
        this.closedAt = new Date().toISOString();
        this.exitCode = code ?? undefined;
        this.exitSignal = signal ?? undefined;
      }
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

  cleanup(reason: WorkerCleanupReason): Promise<WorkerProcessCleanupOutcome> {
    if (!this.cleanupPromise) {
      this.cleanupReason = reason;
      this.cleanupPromise = this.run(reason).catch((error) =>
        this.finishFailed(
          reason,
          `cleanup crashed: ${errorText(error)}`,
          undefined,
          undefined,
          "none",
        ),
      );
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
        return this.finish("clean", "none", reason, { pgid: pid });
      }
      if (!members.every((member) => member.pgid === pid)) {
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
    if (members.length === 0) {
      return this.finish("clean", source, reason, {
        ...(identity ? { identity } : {}),
        pgid,
      });
    }

    let residual = this.residualOf(members, pid);
    // Record the true residual count before the member list is bounded.
    this.noteResidual(residual);
    const guard = await this.groupSignalAllowed(pgid, pid, identity, members);
    if (!guard.ok) {
      return this.failClosed(reason, guard.reason, pgid, identity, source, residual);
    }

    const term = this.signalGroup(pgid, "SIGTERM");
    if (term === "error") {
      return this.failClosed(
        reason,
        "SIGTERM to the managed process group failed",
        pgid,
        identity,
        source,
        residual,
      );
    }
    if (term === "sent") {
      members = await this.waitForEmpty(pgid, this.manager.termGraceMs);
      if (members.length === 0) {
        return this.finish("terminated", source, reason, {
          ...(identity ? { identity } : {}),
          pgid,
          residual,
        });
      }
      const observed = this.residualOf(members, pid);
      this.noteResidual(observed);
      residual = mergeResidual(residual, observed);
      const killGuard = await this.groupSignalAllowed(pgid, pid, identity, members);
      if (!killGuard.ok) {
        return this.failClosed(
          reason,
          killGuard.reason,
          pgid,
          identity,
          source,
          residual,
        );
      }
      const kill = this.signalGroup(pgid, "SIGKILL");
      if (kill === "error") {
        return this.failClosed(
          reason,
          "SIGKILL to the managed process group failed",
          pgid,
          identity,
          source,
          residual,
        );
      }
      members = await this.waitForEmpty(pgid, this.manager.killGraceMs);
      if (members.length === 0) {
        return this.finish("terminated", source, reason, {
          ...(identity ? { identity } : {}),
          pgid,
          residual,
        });
      }
      const remaining = this.residualOf(members, pid);
      return this.finishFailed(
        reason,
        `managed process group still has ${members.length} member(s) after SIGKILL`,
        pgid,
        identity,
        source,
        mergeResidual(residual, remaining),
      );
    }

    // The group disappeared between listing and signalling; verify and finish.
    try {
      members = await this.manager.listMembers(pgid);
    } catch {
      return this.finishFailed(
        reason,
        "managed process group disappeared and could not be re-inspected",
        pgid,
        identity,
        source,
        residual,
      );
    }
    if (members.length === 0) {
      return this.finish("clean", source, reason, {
        ...(identity ? { identity } : {}),
        pgid,
      });
    }
    return this.failClosed(
      reason,
      "managed process group could not be signalled",
      pgid,
      identity,
      source,
      residual,
    );
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
        this.captureSupport === "windows-exact-child"
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
    const record: WorkerProcessRecord = {
      version: WORKER_PROCESS_RECORD_VERSION,
      host: this.manager.inspector.host,
      ...(isProcessPid(this.child.pid) ? { pid: this.child.pid } : {}),
      ...(isProcessPid(options.pgid) ? { pgid: options.pgid } : {}),
      ...(identity ? { identity } : {}),
      captureSource: source,
      captureSupport: this.captureSupport,
      cleanupReason: reason,
      cleanupState: state,
      signals: this.signals.map((signal) => ({ ...signal })),
      residualMembers: this.residualMembers.map((member) => ({ ...member })),
      residualCount: this.residualCount,
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
      ` (${record.captureSource}, residual=${record.residualCount})` +
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
      (scope !== "process-group" && scope !== "pid") ||
      (result !== "sent" && result !== "failed") ||
      !isTimestamp(value.at)
    ) {
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

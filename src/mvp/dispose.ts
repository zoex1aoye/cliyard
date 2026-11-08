/**
 * MVP M2 dispose: kill a tracked local-cli child (and its process group).
 *
 * Not a pid+pgid+lstart ownership ledger — Cordis/AbortSignal cancel only.
 */
import { spawn } from "node:child_process";

export type DisposeReason = "abort" | "timeout" | "explicit" | "plugin-dispose";

export interface DisposeResult {
  pid: number;
  disposed: boolean;
  reason: DisposeReason;
  usedProcessGroup: boolean;
  signals: string[];
  aliveAfter: boolean;
}

export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function tryKill(pid: number, signal: NodeJS.Signals): boolean {
  try {
    process.kill(pid, signal);
    return true;
  } catch {
    return false;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Dispose a child. Prefer process-group kill (`-pid`) when `processGroup` is
 * true (detached spawn). Grace period then SIGKILL.
 */
export async function disposeChild(input: {
  pid: number;
  reason: DisposeReason;
  processGroup?: boolean;
  graceMs?: number;
}): Promise<DisposeResult> {
  const pid = input.pid;
  const processGroup = input.processGroup === true;
  const graceMs = Math.max(0, input.graceMs ?? 50);
  const signals: string[] = [];

  if (!isProcessAlive(pid)) {
    return {
      pid,
      disposed: true,
      reason: input.reason,
      usedProcessGroup: processGroup,
      signals,
      aliveAfter: false,
    };
  }

  const targets = processGroup ? [-pid, pid] : [pid];
  for (const target of targets) {
    if (tryKill(target, "SIGTERM")) signals.push(`SIGTERM:${target}`);
  }
  if (graceMs > 0) await sleep(graceMs);

  if (isProcessAlive(pid)) {
    for (const target of targets) {
      if (tryKill(target, "SIGKILL")) signals.push(`SIGKILL:${target}`);
    }
    await sleep(20);
  }

  const aliveAfter = isProcessAlive(pid);
  return {
    pid,
    disposed: !aliveAfter,
    reason: input.reason,
    usedProcessGroup: processGroup,
    signals,
    aliveAfter,
  };
}

export type TrackedChild = {
  pid: number;
  processGroup: boolean;
  dispose: (reason: DisposeReason) => Promise<DisposeResult>;
};

/**
 * In-flight child registry for plugin / multi-run dispose.
 */
export class DisposeRegistry {
  private readonly children = new Map<number, TrackedChild>();

  register(child: TrackedChild): () => void {
    this.children.set(child.pid, child);
    return () => {
      this.children.delete(child.pid);
    };
  }

  size(): number {
    return this.children.size;
  }

  async disposeAll(
    reason: DisposeReason = "plugin-dispose",
  ): Promise<DisposeResult[]> {
    const list = [...this.children.values()];
    const results: DisposeResult[] = [];
    for (const child of list) {
      results.push(await child.dispose(reason));
      this.children.delete(child.pid);
    }
    return results;
  }
}

/** Shared registry used by CLI/plugin bridges in-process. */
export const defaultDisposeRegistry = new DisposeRegistry();

/**
 * Refuse unknown wrap modes. MVP wrap stays default-off.
 */
export function assertWrapDisabledOrKnown(mode: string | undefined): void {
  const m = (mode ?? "none").trim().toLowerCase();
  if (m === "none" || m === "") return;
  if (m === "docker" || m === "low-priv") {
    throw new Error(
      `mvp wrap mode "${m}" is reserved but default-off in M2; unset sandbox/wrap to none`,
    );
  }
  throw new Error(`unknown mvp wrap mode: ${m}`);
}

/**
 * Helper for tests: spawn a detached sleep and return pid.
 */
export function spawnDetachedSleep(
  seconds: number,
  cwd: string,
): Promise<{
  pid: number;
  done: Promise<number>;
}> {
  return new Promise((resolve, reject) => {
    const child = spawn("sleep", [String(seconds)], {
      cwd,
      detached: true,
      stdio: "ignore",
    });
    child.on("error", reject);
    const pid = child.pid;
    if (!pid) {
      reject(new Error("spawnDetachedSleep: missing pid"));
      return;
    }
    child.unref();
    resolve({
      pid,
      done: new Promise((res) => {
        child.on("close", (code) => res(code ?? 1));
      }),
    });
  });
}

import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import type { TaskStatus } from "../core/status.js";
import type { TaskContract } from "../contracts/schema.js";
import {
  parseCostTruth,
  parseFailureRecord,
  type CostTruth,
  type FailureRecord,
} from "../failures.js";

export interface LedgerEvent {
  at: string;
  type: string;
  status?: TaskStatus;
  detail?: string;
}

export interface LedgerTaskRecord {
  taskId: string;
  status: TaskStatus;
  repairCount: number;
  contract: TaskContract;
  events: LedgerEvent[];
  sessionIds: string[];
  lastVerifyLog?: string;
  verdict?: "accepted" | "rejected";
  reason?: string;
  /**
   * Structured failure observation for a rejected task. Absent on accepted
   * tasks and on records written before the failure taxonomy.
   */
  failure?: FailureRecord;
  /**
   * Aggregated cost truth for every worker session this task started,
   * including repairs. CLI estimates remain non-authoritative.
   */
  cost?: CostTruth;
}

export interface Ledger {
  path: string;
  tasks: Record<string, LedgerTaskRecord>;
}

export function defaultLedgerPath(cwd = process.cwd()): string {
  return join(cwd, ".cliyard", "ledger.json");
}

export function loadLedger(path: string): Ledger {
  if (!existsSync(path)) {
    return { path, tasks: {} };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
  } catch (error) {
    throw new Error(
      `invalid JSON in ledger ${path}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  return parseLedger(raw, path);
}

/**
 * Ledger records written before the failure taxonomy have neither optional
 * field and stay readable. When either field is present it must be valid:
 * a malformed structured record fails closed instead of being guessed at.
 */
function parseLedger(raw: unknown, path: string): Ledger {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error(`invalid ledger ${path}: root must be an object`);
  }
  const record = raw as Record<string, unknown>;
  const rawTasks = record.tasks ?? {};
  if (typeof rawTasks !== "object" || rawTasks === null || Array.isArray(rawTasks)) {
    throw new Error(`invalid ledger ${path}: tasks must be an object`);
  }

  const tasks: Record<string, LedgerTaskRecord> = {};
  for (const [taskId, value] of Object.entries(rawTasks)) {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new Error(
        `invalid ledger ${path}: task ${taskId} must be an object`,
      );
    }
    const task = value as Record<string, unknown>;
    if (task.failure !== undefined) {
      const failure = parseFailureRecord(task.failure);
      if (!failure) {
        throw new Error(
          `invalid ledger ${path}: task ${taskId}.failure is not a valid ` +
            "failure record",
        );
      }
      task.failure = failure;
    }
    if (task.cost !== undefined) {
      const cost = parseCostTruth(task.cost);
      if (!cost) {
        throw new Error(
          `invalid ledger ${path}: task ${taskId}.cost is not a valid cost ` +
            "record",
        );
      }
      task.cost = cost;
    }
    tasks[taskId] = task as unknown as LedgerTaskRecord;
  }
  return { path, tasks };
}

export function saveLedger(ledger: Ledger): void {
  mkdirSync(dirname(ledger.path), { recursive: true });
  writeFileSync(
    ledger.path,
    JSON.stringify({ path: ledger.path, tasks: ledger.tasks }, null, 2) + "\n",
    "utf8",
  );
}

/** Serialize load-modify-save for one ledger path (parallel closed loops). */
const ledgerGates = new Map<string, Promise<unknown>>();
const LOCK_WAIT_MS = 10_000;
const STALE_LOCK_MS = 5 * 60_000;

export async function withLedgerLock<T>(
  path: string,
  fn: () => T | Promise<T>,
): Promise<T> {
  const prev = ledgerGates.get(path) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  const next = prev.then(() => gate);
  ledgerGates.set(path, next);
  await prev;
  let releaseFile: (() => void) | undefined;
  try {
    releaseFile = await acquireFileLock(path);
    return await fn();
  } finally {
    releaseFile?.();
    release();
    if (ledgerGates.get(path) === next) {
      ledgerGates.delete(path);
    }
  }
}

/** Load ledger, apply mutator, save — under lock. Returns mutator result. */
export async function updateLedger<T>(
  path: string,
  mutator: (ledger: Ledger) => T,
): Promise<T> {
  return withLedgerLock(path, () => {
    const ledger = loadLedger(path);
    const out = mutator(ledger);
    saveLedger(ledger);
    return out;
  });
}

async function acquireFileLock(path: string): Promise<() => void> {
  const lockPath = `${path}.lock`;
  mkdirSync(dirname(path), { recursive: true });
  const token = `${process.pid}-${randomUUID()}`;
  const deadline = Date.now() + LOCK_WAIT_MS;

  while (true) {
    try {
      const fd = openSync(lockPath, "wx");
      writeFileSync(fd, `${token}\n`, "utf8");
      closeSync(fd);
      return () => {
        try {
          const current = readFileSync(lockPath, "utf8").trim();
          if (current === token) unlinkSync(lockPath);
        } catch {
          /* already released or replaced */
        }
      };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") throw error;
      try {
        const age = Date.now() - statSync(lockPath).mtimeMs;
        if (age > STALE_LOCK_MS) {
          unlinkSync(lockPath);
          continue;
        }
      } catch {
        continue;
      }
      if (Date.now() >= deadline) {
        throw new Error(`timed out waiting for ledger lock: ${lockPath}`);
      }
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
    }
  }
}

export function appendEvent(
  record: LedgerTaskRecord,
  type: string,
  detail?: string,
): void {
  record.events.push({
    at: new Date().toISOString(),
    type,
    status: record.status,
    detail,
  });
}

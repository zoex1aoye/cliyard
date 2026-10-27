/**
 * Durable single-host port leases for verification runtimes.
 *
 * Layout, relative to the repository root:
 *
 *   .cliyard/runtime/port-leases.json   lease store
 *   .cliyard/runtime/port-leases.lock   cross-process mutation lock
 *
 * Every load-modify-save runs while holding the lock (O_EXCL, owner-pid
 * checked), and the store is replaced through a temp file + rename. Two
 * allocator processes therefore cannot lease the same live port.
 *
 * Lease liveness is the recorded owner pid. Because v0 leases are scoped to one
 * machine, a lease whose pid is gone is reclaimable by any later allocator.
 *
 * V0 deliberately probes then reserves; a child can still lose the bind race to
 * an unleased process. The RuntimeManager handles that by retrying on
 * `EADDRINUSE` with a different port.
 */
import { randomUUID } from "node:crypto";
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
import { createServer } from "node:net";
import { hostname } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { isProcessAlive, isSameHost } from "../supervisor/store.js";
import {
  PORT_LEASE_STORE_VERSION,
  RUNTIME_HOST,
  type PortLease,
  type PortLeaseStore,
  type RuntimeHost,
} from "./types.js";

export const PORT_LEASES_FILE = "port-leases.json";
export const PORT_LEASES_LOCK_FILE = "port-leases.lock";

export const DEFAULT_PORT_RANGE: Readonly<PortRange> = {
  start: 19000,
  end: 19999,
};

const DEFAULT_LOCK_WAIT_MS = 15_000;
const LOCK_POLL_MS = 20;
/** Age after which a lock with an unreadable/foreign owner is abandoned. */
const UNKNOWN_OWNER_STALE_MS = 5 * 60_000;
const PORT_PROBE_TIMEOUT_MS = 2_000;
const LEASE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export interface PortRange {
  start: number;
  end: number;
}

export interface PortAllocatorPaths {
  repoRoot: string;
  runtimeDir: string;
  storePath: string;
  lockPath: string;
}

export interface PortAllocatorOptions {
  /** Repository whose `.cliyard/runtime` receives the lease store. */
  repoRoot: string;
  /** Explicit range (`"19000-19999"` or `{ start, end }`). */
  range?: string | PortRange;
  /** Environment source for `CLIYARD_PORT_RANGE` (default `process.env`). */
  env?: NodeJS.ProcessEnv;
  /** Lease owner pid (default `process.pid`). */
  pid?: number;
  /** Lease-owner liveness probe (default {@link isProcessAlive}). */
  isAlive?: (pid: number) => boolean;
  /** Port availability probe (default {@link probePort}). */
  isPortAvailable?: (port: number) => Promise<boolean>;
  /** Maximum wait for the cross-process lease lock. */
  lockTimeoutMs?: number;
}

export class PortAllocatorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

export class PortRangeError extends PortAllocatorError {}

export class PortLeaseStoreError extends PortAllocatorError {}

export class PortLeaseLockError extends PortAllocatorError {}

export class NoAvailablePortError extends PortAllocatorError {
  constructor(
    readonly runId: string,
    readonly service: string,
    readonly range: PortRange,
  ) {
    super(
      `no available port in ${range.start}-${range.end} ` +
        `for runId ${JSON.stringify(runId)} service ${JSON.stringify(service)}`,
    );
  }
}

export function portAllocatorPaths(repoRoot: string): PortAllocatorPaths {
  const root = resolve(repoRoot);
  const runtimeDir = join(root, ".cliyard", "runtime");
  return {
    repoRoot: root,
    runtimeDir,
    storePath: join(runtimeDir, PORT_LEASES_FILE),
    lockPath: join(runtimeDir, PORT_LEASES_LOCK_FILE),
  };
}

/** Stable lease identity; both segments reject `:` so keys stay unambiguous. */
export function portLeaseKey(runId: string, service: string): string {
  assertLeaseId(runId, "runId");
  assertLeaseId(service, "service");
  return `${runId}:${service}`;
}

/**
 * Parse `CLIYARD_PORT_RANGE` or an explicit `"start-end"` value.
 * A single-port range (`"19080-19080"`) is valid.
 */
export function parsePortRange(value: string): PortRange {
  if (typeof value !== "string") {
    throw new PortRangeError("port range must be a string");
  }
  const match = /^\s*(\d{1,5})\s*-\s*(\d{1,5})\s*$/.exec(value);
  if (!match) {
    throw new PortRangeError(
      `invalid port range ${JSON.stringify(value)}: expected "start-end"`,
    );
  }
  return validatePortRange({
    start: Number(match[1]),
    end: Number(match[2]),
  });
}

export function validatePortRange(range: PortRange): PortRange {
  if (
    !Number.isInteger(range.start) ||
    !Number.isInteger(range.end) ||
    range.start < 1 ||
    range.end > 65535 ||
    range.start > range.end
  ) {
    throw new PortRangeError(
      `invalid port range ${range.start}-${range.end}: ` +
        "expected integers with 1 <= start <= end <= 65535",
    );
  }
  return { start: range.start, end: range.end };
}

/**
 * Probe bind availability on 127.0.0.1. An occupied, privileged, or otherwise
 * unbindable port is reported as unavailable rather than thrown.
 */
export function probePort(
  port: number,
  host: RuntimeHost = RUNTIME_HOST,
): Promise<boolean> {
  return new Promise((resolvePromise) => {
    const server = createServer();
    let settled = false;
    let timer: NodeJS.Timeout;
    const settle = (available: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolvePromise(available);
    };
    timer = setTimeout(() => {
      try {
        server.close();
      } catch {
        /* not listening */
      }
      settle(false);
    }, PORT_PROBE_TIMEOUT_MS);

    // A stray connection must not hold the probe server open past its close.
    server.on("connection", (socket) => socket.destroy());
    server.once("error", () => {
      try {
        server.close();
      } catch {
        /* not listening */
      }
      settle(false);
    });
    server.listen({ host, port, exclusive: true }, () => {
      server.close((error) => settle(!error));
    });
  });
}

/**
 * Single-host, durable port allocator.
 *
 * All mutation is serialized through `<runtimeDir>/port-leases.lock`, including
 * bind probes. A port is reserved in the store before `allocate()` resolves.
 */
export class PortAllocator {
  readonly repoRoot: string;
  readonly paths: PortAllocatorPaths;
  readonly range: PortRange;

  private readonly ownerPid: number;
  private readonly alive: (pid: number) => boolean;
  private readonly probe: (port: number) => Promise<boolean>;
  private readonly lockTimeoutMs: number;

  constructor(options: PortAllocatorOptions) {
    if (
      !options ||
      typeof options.repoRoot !== "string" ||
      !options.repoRoot.trim()
    ) {
      throw new PortAllocatorError("repoRoot must be a non-empty string");
    }
    const env = options.env ?? process.env;
    this.repoRoot = resolve(options.repoRoot);
    this.paths = portAllocatorPaths(this.repoRoot);
    this.range =
      options.range === undefined
        ? parsePortRangeOrDefault(env.CLIYARD_PORT_RANGE)
        : typeof options.range === "string"
          ? parsePortRange(options.range)
          : validatePortRange(options.range);

    const pid = options.pid ?? process.pid;
    if (!Number.isInteger(pid) || pid <= 0) {
      throw new PortAllocatorError("pid must be a positive integer");
    }
    this.ownerPid = pid;
    this.alive = options.isAlive ?? isProcessAlive;
    this.probe = options.isPortAvailable ?? probePort;

    const timeout = options.lockTimeoutMs ?? DEFAULT_LOCK_WAIT_MS;
    if (!Number.isFinite(timeout) || timeout <= 0) {
      throw new PortAllocatorError("lockTimeoutMs must be a positive number");
    }
    this.lockTimeoutMs = timeout;
  }

  /**
   * Lease a port for `runId + service`.
   *
   * A live lease for the same pair is returned unchanged. Dead-owner leases are
   * pruned, then the first unleased port that binds on 127.0.0.1 is reserved.
   */
  async allocate(runId: string, service: string): Promise<PortLease> {
    const key = portLeaseKey(runId, service);
    return this.withLock(async () => {
      const store = this.loadStore();
      const existing = store.leases.find((lease) => lease.key === key);
      if (existing && this.alive(existing.pid)) {
        return { ...existing };
      }

      // Single-host store: a dead owner can no longer hold its reservation.
      const leases = store.leases.filter((lease) => this.alive(lease.pid));
      const reserved = new Set(leases.map((lease) => lease.port));
      const port = await this.findAvailablePort(reserved);
      if (port === undefined) {
        throw new NoAvailablePortError(runId, service, this.range);
      }

      const lease: PortLease = {
        key,
        runId,
        service,
        host: RUNTIME_HOST,
        port,
        pid: this.ownerPid,
        acquiredAt: new Date().toISOString(),
      };
      leases.push(lease);
      this.saveStore({ version: PORT_LEASE_STORE_VERSION, leases });
      return { ...lease };
    });
  }

  /**
   * Remove one exact lease. Releasing an already-removed or superseded lease is
   * a no-op, so cleanup can run in `finally` without extra state.
   */
  async release(lease: PortLease): Promise<boolean> {
    if (!lease || typeof lease !== "object") {
      throw new PortAllocatorError("lease must be an object");
    }
    return this.withLock(() => {
      const store = this.loadStore();
      const index = store.leases.findIndex((entry) =>
        isSameLease(entry, lease),
      );
      if (index === -1) return false;
      store.leases.splice(index, 1);
      this.saveStore(store);
      return true;
    });
  }

  /** Current persisted leases, ordered by port. Reads never need the lock. */
  list(): PortLease[] {
    return this.loadStore()
      .leases.map((lease) => ({ ...lease }))
      .sort((a, b) => a.port - b.port || a.key.localeCompare(b.key));
  }

  private async findAvailablePort(
    reserved: Set<number>,
  ): Promise<number | undefined> {
    for (let port = this.range.start; port <= this.range.end; port += 1) {
      if (reserved.has(port)) continue;
      if (await this.probe(port)) return port;
    }
    return undefined;
  }

  private async withLock<T>(fn: () => T | Promise<T>): Promise<T> {
    const release = await acquireLeaseLock(
      this.paths.lockPath,
      this.lockTimeoutMs,
    );
    try {
      return await fn();
    } finally {
      release();
    }
  }

  private loadStore(): PortLeaseStore {
    return readLeaseStore(this.paths.storePath);
  }

  private saveStore(store: PortLeaseStore): void {
    writeLeaseStore(this.paths.storePath, store);
  }
}

// ---------------------------------------------------------------------------
// Store persistence
// ---------------------------------------------------------------------------

function parsePortRangeOrDefault(value: string | undefined): PortRange {
  if (value === undefined) return { ...DEFAULT_PORT_RANGE };
  return parsePortRange(value);
}

function readLeaseStore(path: string): PortLeaseStore {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { version: PORT_LEASE_STORE_VERSION, leases: [] };
    }
    throw new PortLeaseStoreError(
      `cannot read port lease store ${path}: ${errorMessage(error)}`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch (error) {
    throw new PortLeaseStoreError(
      `invalid JSON in port lease store ${path}: ${errorMessage(error)}`,
    );
  }
  return parseLeaseStore(parsed, path);
}

function parseLeaseStore(raw: unknown, source: string): PortLeaseStore {
  if (!isRecord(raw)) {
    throw new PortLeaseStoreError(
      `${source}: lease store must be an object`,
    );
  }
  if (raw.version !== PORT_LEASE_STORE_VERSION) {
    throw new PortLeaseStoreError(
      `${source}: unsupported version ${JSON.stringify(raw.version)} ` +
        `(expected ${PORT_LEASE_STORE_VERSION})`,
    );
  }
  if (!Array.isArray(raw.leases)) {
    throw new PortLeaseStoreError(`${source}: leases must be an array`);
  }

  const leases: PortLease[] = [];
  const keys = new Set<string>();
  const ports = new Set<number>();
  raw.leases.forEach((entry, index) => {
    const lease = parseLease(entry, `${source}: leases[${index}]`);
    if (keys.has(lease.key)) {
      throw new PortLeaseStoreError(
        `${source}: duplicate lease key ${JSON.stringify(lease.key)}`,
      );
    }
    if (ports.has(lease.port)) {
      throw new PortLeaseStoreError(
        `${source}: duplicate leased port ${lease.port}`,
      );
    }
    keys.add(lease.key);
    ports.add(lease.port);
    leases.push(lease);
  });
  return { version: PORT_LEASE_STORE_VERSION, leases };
}

function parseLease(raw: unknown, source: string): PortLease {
  if (!isRecord(raw)) {
    throw new PortLeaseStoreError(`${source}: lease must be an object`);
  }
  for (const field of [
    "key",
    "runId",
    "service",
    "host",
    "acquiredAt",
  ] as const) {
    if (typeof raw[field] !== "string" || !(raw[field] as string).trim()) {
      throw new PortLeaseStoreError(
        `${source}: ${field} must be a non-empty string`,
      );
    }
  }
  if (raw.host !== RUNTIME_HOST) {
    throw new PortLeaseStoreError(
      `${source}: host must be ${JSON.stringify(RUNTIME_HOST)}`,
    );
  }
  if (
    !Number.isInteger(raw.port) ||
    (raw.port as number) < 1 ||
    (raw.port as number) > 65535
  ) {
    throw new PortLeaseStoreError(
      `${source}: port must be an integer between 1 and 65535`,
    );
  }
  if (!Number.isInteger(raw.pid) || (raw.pid as number) <= 0) {
    throw new PortLeaseStoreError(
      `${source}: pid must be a positive integer`,
    );
  }
  if (Number.isNaN(Date.parse(raw.acquiredAt as string))) {
    throw new PortLeaseStoreError(
      `${source}: acquiredAt must be a valid timestamp`,
    );
  }
  if (raw.key !== `${raw.runId}:${raw.service}`) {
    throw new PortLeaseStoreError(
      `${source}: key must be "runId:service"`,
    );
  }
  return {
    key: raw.key as string,
    runId: raw.runId as string,
    service: raw.service as string,
    host: RUNTIME_HOST,
    port: raw.port as number,
    pid: raw.pid as number,
    acquiredAt: raw.acquiredAt as string,
  };
}

/** Atomic replace; readers see either the old or the new complete store. */
function writeLeaseStore(path: string, store: PortLeaseStore): void {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true });
  const tmp = join(
    dir,
    `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`,
  );
  try {
    const fd = openSync(tmp, "wx", 0o600);
    try {
      writeFileSync(fd, JSON.stringify(store, null, 2) + "\n", "utf8");
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

// ---------------------------------------------------------------------------
// Cross-process lock
// ---------------------------------------------------------------------------

interface LeaseLockInfo {
  pid: number;
  host: string;
  token: string;
  acquiredAt: string;
}

async function acquireLeaseLock(
  lockPath: string,
  timeoutMs: number,
): Promise<() => void> {
  mkdirSync(dirname(lockPath), { recursive: true });
  const token = `${process.pid}-${randomUUID()}`;
  const content =
    JSON.stringify({
      pid: process.pid,
      host: hostname(),
      token,
      acquiredAt: new Date().toISOString(),
    } satisfies LeaseLockInfo) + "\n";
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    let fd: number;
    try {
      fd = openSync(lockPath, "wx", 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (clearStaleLeaseLock(lockPath)) continue;
      if (Date.now() >= deadline) {
        throw new PortLeaseLockError(
          `timed out waiting for port lease lock: ${lockPath}`,
        );
      }
      await delay(LOCK_POLL_MS);
      continue;
    }

    try {
      writeFileSync(fd, content, "utf8");
      fsyncSync(fd);
      closeSync(fd);
    } catch (error) {
      try {
        closeSync(fd);
      } catch {
        /* already closed or invalid */
      }
      try {
        unlinkSync(lockPath);
      } catch {
        /* ignore */
      }
      throw error;
    }

    let released = false;
    return () => {
      if (released) return;
      released = true;
      try {
        if (readFileSync(lockPath, "utf8") === content) {
          unlinkSync(lockPath);
        }
      } catch {
        /* already released or replaced */
      }
    };
  }
}

/** Remove the lock only when its owner is provably gone. */
function clearStaleLeaseLock(lockPath: string): boolean {
  let raw: string;
  try {
    raw = readFileSync(lockPath, "utf8");
  } catch (error) {
    // Vanished between open() and read(): retry acquisition immediately.
    return (error as NodeJS.ErrnoException).code === "ENOENT";
  }

  let info: LeaseLockInfo | undefined;
  try {
    info = parseLockInfo(JSON.parse(raw) as unknown);
  } catch {
    info = undefined;
  }

  let stale: boolean;
  if (info && isSameHost(info.host)) {
    // Same host: pid liveness is authoritative even for an old lock.
    stale = !isProcessAlive(info.pid);
  } else {
    // Foreign or unreadable owner: only age can prove abandonment.
    try {
      stale = Date.now() - statSync(lockPath).mtimeMs > UNKNOWN_OWNER_STALE_MS;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "ENOENT";
    }
  }
  if (!stale) return false;

  try {
    // Do not unlink a fresh lock another waiter installed after our check.
    if (readFileSync(lockPath, "utf8") !== raw) return false;
    unlinkSync(lockPath);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT";
  }
}

function parseLockInfo(raw: unknown): LeaseLockInfo {
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
    throw new PortAllocatorError("invalid lease lock");
  }
  return {
    pid: raw.pid as number,
    host: raw.host,
    token: raw.token,
    acquiredAt: raw.acquiredAt,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function assertLeaseId(value: string, field: string): void {
  if (typeof value !== "string" || !LEASE_ID_PATTERN.test(value)) {
    throw new PortAllocatorError(
      `invalid ${field} ${JSON.stringify(value)}: ` +
        "must match [A-Za-z0-9][A-Za-z0-9._-]* (max 128 chars)",
    );
  }
}

function isSameLease(a: PortLease, b: PortLease): boolean {
  return (
    a.key === b.key &&
    a.runId === b.runId &&
    a.service === b.service &&
    a.host === b.host &&
    a.port === b.port &&
    a.pid === b.pid &&
    a.acquiredAt === b.acquiredAt
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

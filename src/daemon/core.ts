/**
 * cliyardd core (P2a): the durable single-instance daemon skeleton.
 *
 * Scope of this slice, and nothing beyond it:
 *
 * - open the StateStore authority for one repository;
 * - take a store-backed, cross-process single-instance lease;
 * - bind a 127.0.0.1 TCP socket on an ephemeral (or explicit) port;
 * - report the bound address and pid;
 * - on stop, close the listener, release the lease and close the store.
 *
 * Read-only discipline: the daemon never appends a fact and never writes run,
 * queue, ledger or evidence state. It touches the StateStore only through its
 * projection (opened once, read-only) and through one dedicated `state_meta`
 * key holding the lease. Opening the store may rebuild the projection, which
 * is the store's own repair path, not domain state.
 *
 * There is deliberately no HTTP server, no action endpoint and no
 * ExecutionSupervisor here. Accepted TCP connections are closed immediately:
 * the socket exists only so the process has a real, observable bound address.
 *
 * Backend selection mirrors the supervisor: `better-sqlite3` when the optional
 * native module is installed, otherwise the durable JSON fact-log fallback at
 * `.cliyard/state-fallback/facts.json` (canonical control StateStore layout;
 * legacy `runtime/statestore` is relocated once). The fallback driver below is
 * a local copy of the supervisor's private `JsonFileStateStoreDriver` with the
 * same on-disk shape; it differs in one required way: meta writes are durable
 * on their own, because the daemon lease is meta-only.
 *
 * Cross-process lease safety: the lease record lives in the store. On SQLite
 * the check-and-set runs in one IMMEDIATE transaction. The JSON fallback has
 * no cross-process transactions, so a short-lived exact-owner lock file
 * serializes daemon lease operations and every operation opens a fresh driver
 * to observe the bytes currently on disk. That lock only excludes other
 * daemon lease operations: the foreground supervisor's JSON writes do not
 * honor it, so the fallback carries the supervisor's single-process
 * limitation (the SQLite authority is the multi-process default).
 */
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { hostname } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import {
  SUPERVISOR_DIR,
  isProcessAlive,
  isSameHost,
} from "../supervisor/store.js";
import { resolveControlStatePaths } from "../statestore/paths.js";
import {
  META_PROJECTION_FORMAT,
  META_PROJECTION_SEQ,
  StateStore,
  StateStoreClosedError,
  StateStoreCorruptionError,
  StateStoreDriverUnavailableError,
  createBetterSqlite3Driver,
  type AttemptRow,
  type EvidenceRow,
  type PersistedFact,
  type StateStoreDriver,
  type StateStoreTransaction,
} from "../statestore/store.js";

export const DAEMON_CONTROL_HOST = "127.0.0.1" as const;
export const DAEMON_LEASE_VERSION = 1 as const;
export const DAEMON_LEASE_META_KEY = "daemon.lease";
export const DAEMON_LEASE_LOCK_FILE = "daemon-lease.lock";

const HOLDER_ID_MAX_LENGTH = 128;
const LEASE_HOST_MAX_LENGTH = 256;
const LEASE_REPO_ROOT_MAX_LENGTH = 4096;
const LEASE_TIMESTAMP_MAX_LENGTH = 64;
const LEASE_IDENTITY_MAX_LENGTH = 256;
const LOCK_POLL_MS = 15;
const DEFAULT_LOCK_TIMEOUT_MS = 2_000;
const UNKNOWN_LOCK_OWNER_STALE_MS = 5 * 60_000;

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class DaemonError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/** The repository already has a live daemon lease. */
export class DaemonLeaseHeldError extends DaemonError {
  constructor(readonly inspection: DaemonLeaseInspection) {
    const lease = inspection.lease;
    super(
      lease === null
        ? "another cliyardd holds the repository lease"
        : `another cliyardd holds the repository lease: pid ${lease.pid} ` +
            `on ${lease.host} (${inspection.state})`,
    );
  }
}

/** The lease record on disk cannot be trusted; fail closed (needs human). */
export class DaemonLeaseCorruptError extends DaemonError {
  constructor(detail: string) {
    super(`daemon lease is unreadable; refusing to guess: ${detail}`);
  }
}

export class DaemonLeaseLockError extends DaemonError {}

/** Both StateStore authority files exist; a human must choose. */
export class DaemonStateConflictError extends DaemonError {}

/** The lease backend needs an existing StateStore authority but found none. */
export class DaemonStoreUnavailableError extends DaemonError {}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

export interface DaemonStatePaths {
  repoRoot: string;
  cliyardDir: string;
  stateDir: string;
  /** SQLite authority (preferred) — `.cliyard/state.db`. */
  sqlitePath: string;
  /** Durable JSON fallback authority. */
  factsPath: string;
  leaseLockPath: string;
}

export function daemonStatePaths(repoRoot: string): DaemonStatePaths {
  const { paths } = resolveControlStatePaths(repoRoot);
  return {
    repoRoot: paths.repoRoot,
    cliyardDir: paths.cliyardDir,
    stateDir: paths.stateDir,
    sqlitePath: paths.dbPath,
    factsPath: paths.fallbackFactsPath,
    // Keep the lease lock beside the fallback directory so SQLite and
    // JSON-file backends share one serialization point under `.cliyard`.
    leaseLockPath: join(paths.fallbackDir, DAEMON_LEASE_LOCK_FILE),
  };
}

// ---------------------------------------------------------------------------
// Lease model
// ---------------------------------------------------------------------------

export interface DaemonAddress {
  host: typeof DAEMON_CONTROL_HOST;
  port: number;
}

export interface DaemonLeaseRecord {
  version: typeof DAEMON_LEASE_VERSION;
  holderId: string;
  pid: number;
  /** Operating-system hostname of the lease owner. */
  host: string;
  repoRoot: string;
  startedAt: string;
  /** OS-reported start identity; null when it could not be captured. */
  processStartIdentity: string | null;
  address: DaemonAddress;
}

export type DaemonLeaseState =
  | "free"
  | "held"
  | "stale"
  | "foreign-host"
  | "invalid";

export interface DaemonLeaseInspection {
  state: DaemonLeaseState;
  lease: DaemonLeaseRecord | null;
  /** null when liveness was not probed (free, foreign host or invalid). */
  holderAlive: boolean | null;
  /**
   * null when no identity check was possible. `false` means the recorded
   * identity does not match the live pid (pid reuse); treat as stale.
   */
  identityVerified: boolean | null;
  detail: string | null;
}

export interface DaemonLeaseCheckOptions {
  isAlive?: (pid: number) => boolean;
  readStartIdentity?: (pid: number) => string | null;
}

export interface DaemonLeaseInput {
  holderId: string;
  pid: number;
  host: string;
  repoRoot: string;
  startedAt: string;
  processStartIdentity: string | null;
  address: DaemonAddress;
}

/**
 * Lease operations are the daemon's only writes. They are injected so the
 * daemon core can run against an in-memory driver in tests while the CLI uses
 * fresh file-backed drivers per operation.
 */
export interface DaemonLeaseOps {
  inspect(options?: DaemonLeaseCheckOptions): Promise<DaemonLeaseInspection>;
  acquire(
    input: DaemonLeaseInput,
    options?: DaemonLeaseCheckOptions,
  ): Promise<DaemonLeaseRecord>;
  release(lease: DaemonLeaseRecord): Promise<boolean>;
  close(): void;
}

const EMPTY_INSPECTION: DaemonLeaseInspection = {
  state: "free",
  lease: null,
  holderAlive: null,
  identityVerified: null,
  detail: null,
};

export function readProcessStartIdentity(pid: number): string | null {
  if (!Number.isInteger(pid) || pid <= 0 || process.platform === "win32") {
    return null;
  }
  // `ps lstart` is the same OS-reported identity the runtime layer uses. A
  // failed capture stays null: "unknown", never a guessed identity.
  const result = spawnSync("ps", ["-p", String(pid), "-o", "lstart="], {
    encoding: "utf8",
    timeout: 2_000,
  });
  if (result.error !== undefined || result.status !== 0) return null;
  const normalized = result.stdout.trim().replace(/\s+/g, " ");
  return normalized.length === 0 ? null : normalized;
}

/** Evaluate one lease against host, pid liveness and OS start identity. */
export function evaluateDaemonLease(
  lease: DaemonLeaseRecord,
  options: DaemonLeaseCheckOptions = {},
): DaemonLeaseInspection {
  if (!isSameHost(lease.host)) {
    return {
      state: "foreign-host",
      lease,
      holderAlive: null,
      identityVerified: null,
      detail: `lease host ${JSON.stringify(lease.host)} is not this host`,
    };
  }

  const isAlive = options.isAlive ?? isProcessAlive;
  if (!isAlive(lease.pid)) {
    return {
      state: "stale",
      lease,
      holderAlive: false,
      identityVerified: null,
      detail: `lease owner pid ${lease.pid} is not running`,
    };
  }

  if (lease.processStartIdentity !== null) {
    const capture = options.readStartIdentity ?? readProcessStartIdentity;
    const current = capture(lease.pid);
    if (current !== null && current !== lease.processStartIdentity) {
      return {
        state: "stale",
        lease,
        holderAlive: true,
        identityVerified: false,
        detail:
          `pid ${lease.pid} was reused: recorded start identity ` +
          `${JSON.stringify(lease.processStartIdentity)} but now ` +
          `${JSON.stringify(current)}`,
      };
    }
    return {
      state: "held",
      lease,
      holderAlive: true,
      identityVerified: current === null ? null : true,
      detail: null,
    };
  }

  // No recorded identity: the exact pid is still owned, but reuse cannot be
  // ruled out. Callers that act on the process (daemon stop) must fail closed.
  return {
    state: "held",
    lease,
    holderAlive: true,
    identityVerified: null,
    detail: "lease has no recorded OS process start identity",
  };
}

function parseDaemonLease(raw: string): DaemonLeaseRecord {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch (error) {
    throw new DaemonLeaseCorruptError(
      `lease is not valid JSON (${errorMessage(error)})`,
    );
  }
  if (!isRecord(parsed)) {
    throw new DaemonLeaseCorruptError("lease must be an object");
  }
  if (parsed.version !== DAEMON_LEASE_VERSION) {
    throw new DaemonLeaseCorruptError(
      `unsupported lease version ${JSON.stringify(parsed.version)}`,
    );
  }
  const holderId = requireLeaseText(
    parsed.holderId,
    "holderId",
    HOLDER_ID_MAX_LENGTH,
  );
  const host = requireLeaseText(parsed.host, "host", LEASE_HOST_MAX_LENGTH);
  const repoRoot = requireLeaseText(
    parsed.repoRoot,
    "repoRoot",
    LEASE_REPO_ROOT_MAX_LENGTH,
  );
  const startedAt = requireLeaseText(
    parsed.startedAt,
    "startedAt",
    LEASE_TIMESTAMP_MAX_LENGTH,
  );
  if (Number.isNaN(Date.parse(startedAt))) {
    throw new DaemonLeaseCorruptError("startedAt must be a timestamp");
  }
  if (!Number.isInteger(parsed.pid) || (parsed.pid as number) <= 0) {
    throw new DaemonLeaseCorruptError("pid must be a positive integer");
  }
  if (
    parsed.processStartIdentity !== null &&
    (typeof parsed.processStartIdentity !== "string" ||
      parsed.processStartIdentity.length === 0 ||
      parsed.processStartIdentity.length > LEASE_IDENTITY_MAX_LENGTH)
  ) {
    throw new DaemonLeaseCorruptError(
      "processStartIdentity must be a bounded non-empty string or null",
    );
  }
  if (!isRecord(parsed.address)) {
    throw new DaemonLeaseCorruptError("address must be an object");
  }
  if (parsed.address.host !== DAEMON_CONTROL_HOST) {
    throw new DaemonLeaseCorruptError(
      `address.host must be ${DAEMON_CONTROL_HOST}`,
    );
  }
  if (
    !Number.isInteger(parsed.address.port) ||
    (parsed.address.port as number) < 1 ||
    (parsed.address.port as number) > 65535
  ) {
    throw new DaemonLeaseCorruptError(
      "address.port must be an integer between 1 and 65535",
    );
  }
  return {
    version: DAEMON_LEASE_VERSION,
    holderId,
    pid: parsed.pid as number,
    host,
    repoRoot,
    startedAt,
    processStartIdentity: parsed.processStartIdentity as string | null,
    address: {
      host: DAEMON_CONTROL_HOST,
      port: parsed.address.port as number,
    },
  };
}

function requireLeaseText(
  value: unknown,
  field: string,
  maxLength: number,
): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maxLength ||
    value !== value.trim() ||
    /[\x00-\x1f\x7f]/.test(value)
  ) {
    throw new DaemonLeaseCorruptError(
      `${field} must be a non-empty trimmed string of at most ` +
        `${maxLength} characters`,
    );
  }
  return value;
}

function inspectionFromRaw(
  raw: string | undefined,
  options: DaemonLeaseCheckOptions,
): DaemonLeaseInspection {
  if (raw === undefined) return { ...EMPTY_INSPECTION };
  let lease: DaemonLeaseRecord;
  try {
    lease = parseDaemonLease(raw);
  } catch (error) {
    return {
      state: "invalid",
      lease: null,
      holderAlive: null,
      identityVerified: null,
      detail: errorMessage(error),
    };
  }
  return evaluateDaemonLease(lease, options);
}

// ---------------------------------------------------------------------------
// Lease stores
// ---------------------------------------------------------------------------

/**
 * Lease operations over an already-open driver. Test/embedding seam; the CLI
 * uses {@link createFileLeaseOps} so each operation sees current bytes.
 */
export function createDriverLeaseOps(
  driver: StateStoreDriver,
  options: { lockPath?: string | null } = {},
): DaemonLeaseOps {
  const lockPath = options.lockPath ?? null;
  return {
    inspect: async (check = {}) =>
      inspectionFromRaw(
        driver.transaction((tx) => tx.getMeta(DAEMON_LEASE_META_KEY)),
        check,
      ),
    acquire: async (input, check = {}) =>
      withLeaseLock(lockPath, () =>
        driver.transaction((tx) => {
          const inspection = inspectionFromRaw(
            tx.getMeta(DAEMON_LEASE_META_KEY),
            check,
          );
          assertAcquirable(inspection);
          const record = buildLeaseRecord(input);
          tx.setMeta(DAEMON_LEASE_META_KEY, JSON.stringify(record));
          return record;
        }),
      ),
    release: async (lease) =>
      withLeaseLock(lockPath, () =>
        driver.transaction((tx) => releaseInTransaction(tx, lease)),
      ),
    close: () => {
      /* the caller owns the driver */
    },
  };
}

/**
 * Lease operations against the file-backed authority. A fresh driver is opened
 * for every operation (and closed afterwards) so the JSON fallback never acts
 * on a stale in-memory meta map.
 */
export function createFileLeaseOps(
  paths: DaemonStatePaths,
  options: { lockPath?: string | null } = {},
): DaemonLeaseOps {
  const lockPath =
    options.lockPath === undefined ? paths.leaseLockPath : options.lockPath;
  return {
    inspect: async (check = {}) => {
      const opened = openAuthorityDriver(paths, false);
      if (opened === null) return { ...EMPTY_INSPECTION };
      try {
        return inspectionFromRaw(
          opened.driver.transaction((tx) => tx.getMeta(DAEMON_LEASE_META_KEY)),
          check,
        );
      } finally {
        opened.driver.close();
      }
    },
    acquire: async (input, check = {}) =>
      withLeaseLock(lockPath, () => {
        const opened = openAuthorityDriver(paths, false);
        if (opened === null) {
          throw new DaemonStoreUnavailableError(
            `no StateStore authority exists under ${paths.stateDir}; ` +
              "open the store before taking the daemon lease",
          );
        }
        try {
          return opened.driver.transaction((tx) => {
            const inspection = inspectionFromRaw(
              tx.getMeta(DAEMON_LEASE_META_KEY),
              check,
            );
            assertAcquirable(inspection);
            const record = buildLeaseRecord(input);
            tx.setMeta(DAEMON_LEASE_META_KEY, JSON.stringify(record));
            return record;
          });
        } finally {
          opened.driver.close();
        }
      }),
    release: async (lease) =>
      withLeaseLock(lockPath, () => {
        const opened = openAuthorityDriver(paths, false);
        if (opened === null) return false;
        try {
          return opened.driver.transaction((tx) =>
            releaseInTransaction(tx, lease),
          );
        } finally {
          opened.driver.close();
        }
      }),
    close: () => {
      /* operations open and close their own drivers */
    },
  };
}

function buildLeaseRecord(input: DaemonLeaseInput): DaemonLeaseRecord {
  const record: DaemonLeaseRecord = {
    version: DAEMON_LEASE_VERSION,
    holderId: input.holderId,
    pid: input.pid,
    host: input.host,
    repoRoot: input.repoRoot,
    startedAt: input.startedAt,
    processStartIdentity: input.processStartIdentity,
    address: {
      host: DAEMON_CONTROL_HOST,
      port: input.address.port,
    },
  };
  // Round-trip through the parser so a malformed acquisition can never make
  // the lease unreadable for the next process.
  parseDaemonLease(JSON.stringify(record));
  return record;
}

function assertAcquirable(inspection: DaemonLeaseInspection): void {
  switch (inspection.state) {
    case "free":
    case "stale":
      return;
    case "invalid":
      throw new DaemonLeaseCorruptError(
        inspection.detail ?? "lease record is invalid",
      );
    case "held":
    case "foreign-host":
      throw new DaemonLeaseHeldError(inspection);
  }
}

function releaseInTransaction(
  tx: StateStoreTransaction,
  lease: DaemonLeaseRecord,
): boolean {
  const raw = tx.getMeta(DAEMON_LEASE_META_KEY);
  if (raw === undefined) return false;
  const current = parseDaemonLease(raw);
  // Delete only the exact lease this process installed. A successor with a
  // recycled holder id is still distinguishable by its acquisition time.
  if (
    current.holderId !== lease.holderId ||
    current.pid !== lease.pid ||
    current.startedAt !== lease.startedAt
  ) {
    return false;
  }
  tx.deleteMeta(DAEMON_LEASE_META_KEY);
  return true;
}

// ---------------------------------------------------------------------------
// Store handle
// ---------------------------------------------------------------------------

export interface DaemonStoreHandle {
  readonly store: StateStore;
  readonly leases: DaemonLeaseOps;
  readonly backend: string;
  readonly storePath: string | null;
  close(): void;
}

export interface OpenDaemonStoreOptions {
  /** Lease lock override; null disables the cross-process lease lock. */
  leaseLockPath?: string | null;
}

/**
 * Open the repository's StateStore authority and its lease seam.
 *
 * The daemon owns both: `close()` releases neither implicitly, so callers must
 * release the lease first (the daemon does that on stop).
 */
export function openDaemonStore(
  repoRoot: string,
  options: OpenDaemonStoreOptions = {},
): DaemonStoreHandle {
  const paths = daemonStatePaths(repoRoot);
  mkdirSync(paths.stateDir, { recursive: true, mode: 0o700 });
  const opened = openAuthorityDriver(paths, true);
  if (opened === null) {
    throw new DaemonStoreUnavailableError(
      `could not open a StateStore authority under ${paths.stateDir}`,
    );
  }
  let store: StateStore;
  try {
    store = StateStore.open(opened.driver);
  } catch (error) {
    opened.driver.close();
    throw error;
  }
  const leases = createFileLeaseOps(paths, {
    lockPath: options.leaseLockPath,
  });
  return {
    store,
    leases,
    backend: opened.driver.kind,
    storePath: opened.storePath,
    close: () => {
      try {
        leases.close();
      } finally {
        store.close();
      }
    },
  };
}

interface OpenedAuthority {
  driver: StateStoreDriver;
  storePath: string;
}

function openAuthorityDriver(
  paths: DaemonStatePaths,
  create: boolean,
): OpenedAuthority | null {
  const hasSqlite = existsSync(paths.sqlitePath);
  const hasFacts = existsSync(paths.factsPath);
  if (hasSqlite && hasFacts) {
    throw new DaemonStateConflictError(
      `both ${paths.sqlitePath} and ${paths.factsPath} exist; refusing to ` +
        "choose between two StateStore authorities (needs human)",
    );
  }
  if (hasSqlite) {
    return initializeDriver(
      createBetterSqlite3Driver({ path: paths.sqlitePath }),
      paths.sqlitePath,
    );
  }
  if (hasFacts) {
    return initializeDriver(
      new JsonFactLogDriver(paths.factsPath),
      paths.factsPath,
    );
  }
  if (!create) return null;
  try {
    return initializeDriver(
      createBetterSqlite3Driver({ path: paths.sqlitePath }),
      paths.sqlitePath,
    );
  } catch (error) {
    if (!(error instanceof StateStoreDriverUnavailableError)) throw error;
    return initializeDriver(
      new JsonFactLogDriver(paths.factsPath),
      paths.factsPath,
    );
  }
}

function initializeDriver(
  driver: StateStoreDriver,
  storePath: string,
): OpenedAuthority {
  try {
    driver.initialize();
    return { driver, storePath };
  } catch (error) {
    driver.close();
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Cross-process lease lock
// ---------------------------------------------------------------------------

interface LeaseLockInfo {
  version: 1;
  pid: number;
  host: string;
  token: string;
  acquiredAt: string;
}

async function withLeaseLock<T>(
  lockPath: string | null,
  work: () => T | Promise<T>,
): Promise<T> {
  const release = await acquireLeaseLockFile(lockPath);
  try {
    return await work();
  } finally {
    release();
  }
}

async function acquireLeaseLockFile(
  lockPath: string | null,
): Promise<() => void> {
  if (lockPath === null) return () => {};
  mkdirSync(dirname(lockPath), { recursive: true, mode: 0o700 });
  const token = `${process.pid}-${randomUUID()}`;
  const content =
    JSON.stringify({
      version: 1,
      pid: process.pid,
      host: hostname(),
      token,
      acquiredAt: new Date().toISOString(),
    } satisfies LeaseLockInfo) + "\n";
  const deadline = Date.now() + DEFAULT_LOCK_TIMEOUT_MS;

  for (;;) {
    let fd: number;
    try {
      fd = openSync(lockPath, "wx", 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (clearStaleLeaseLock(lockPath)) continue;
      if (Date.now() >= deadline) {
        throw new DaemonLeaseLockError(
          `timed out waiting for the daemon lease lock: ${lockPath}`,
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
        /* already closed */
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
        if (readFileSync(lockPath, "utf8") === content) unlinkSync(lockPath);
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
    return (error as NodeJS.ErrnoException).code === "ENOENT";
  }

  let owner: LeaseLockInfo | undefined;
  try {
    const parsed = JSON.parse(raw) as unknown;
    owner =
      isRecord(parsed) &&
      Number.isInteger(parsed.pid) &&
      (parsed.pid as number) > 0 &&
      typeof parsed.host === "string" &&
      typeof parsed.token === "string"
        ? (parsed as unknown as LeaseLockInfo)
        : undefined;
  } catch {
    owner = undefined;
  }

  let stale: boolean;
  if (owner !== undefined && isSameHost(owner.host)) {
    stale = !isProcessAlive(owner.pid);
  } else {
    try {
      stale =
        Date.now() - statSync(lockPath).mtimeMs > UNKNOWN_LOCK_OWNER_STALE_MS;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "ENOENT";
    }
  }
  if (!stale) return false;

  try {
    if (readFileSync(lockPath, "utf8") !== raw) return false;
    unlinkSync(lockPath);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT";
  }
}

// ---------------------------------------------------------------------------
// Daemon lifecycle
// ---------------------------------------------------------------------------

export type DaemonRunState =
  | "starting"
  | "running"
  | "stopping"
  | "stopped";

export interface DaemonInfo {
  pid: number;
  address: DaemonAddress;
  /** Convenience form: `127.0.0.1:<port>`. */
  addressText: string;
  repoRoot: string;
  storePath: string | null;
  backend: string;
  holderId: string;
  startedAt: string;
}

export interface StartDaemonOptions {
  repoRoot: string;
  /** 0 (default) asks the OS for an ephemeral port. */
  port?: number;
  /** Owner pid; defaults to `process.pid` (test seam). */
  pid?: number;
  /** OS hostname recorded in the lease; defaults to `os.hostname()`. */
  hostname?: string;
  holderId?: string;
  now?: () => string;
  /** Store factory seam; the daemon owns and closes the returned handle. */
  openStore?: (repoRoot: string) => DaemonStoreHandle;
  isAlive?: (pid: number) => boolean;
  readStartIdentity?: (pid: number) => string | null;
}

export interface DaemonStopResult {
  pid: number;
  address: DaemonAddress;
  reason: string;
  leaseReleased: boolean;
  storeClosed: boolean;
  errors: string[];
}

export class CliyardDaemon {
  readonly info: DaemonInfo;
  private readonly handle: DaemonStoreHandle;
  private readonly server: Server;
  private readonly sockets: ReadonlySet<Socket>;
  private readonly lease: DaemonLeaseRecord;
  private runState: DaemonRunState = "running";
  private stopPromise: Promise<DaemonStopResult> | null = null;
  private stoppedResult: DaemonStopResult | null = null;
  private readonly stoppedWaiters: Array<(result: DaemonStopResult) => void> = [];

  constructor(options: {
    info: DaemonInfo;
    handle: DaemonStoreHandle;
    server: Server;
    sockets: ReadonlySet<Socket>;
    lease: DaemonLeaseRecord;
  }) {
    this.info = options.info;
    this.handle = options.handle;
    this.server = options.server;
    this.sockets = options.sockets;
    this.lease = options.lease;
  }

  get state(): DaemonRunState {
    return this.runState;
  }

  get store(): StateStore {
    return this.handle.store;
  }

  /** P2a has no protocol: accepted sockets are closed immediately. */
  get address(): DaemonAddress {
    return { ...this.info.address };
  }

  /**
   * Graceful shutdown: stop accepting, release the lease, close the store.
   * Idempotent; every caller receives the same result.
   */
  stop(reason = "stop"): Promise<DaemonStopResult> {
    if (this.stopPromise !== null) return this.stopPromise;
    this.stopPromise = this.performStop(reason);
    return this.stopPromise;
  }

  /** Resolves when the daemon has stopped for any reason. */
  waitForStop(): Promise<DaemonStopResult> {
    if (this.stoppedResult !== null) {
      return Promise.resolve(this.stoppedResult);
    }
    return new Promise((resolvePromise) => {
      this.stoppedWaiters.push(resolvePromise);
    });
  }

  private async performStop(reason: string): Promise<DaemonStopResult> {
    this.runState = "stopping";
    const errors: string[] = [];

    try {
      await closeServer(this.server, this.sockets);
    } catch (error) {
      errors.push(`close listener: ${errorMessage(error)}`);
    }

    let leaseReleased = false;
    try {
      leaseReleased = await this.handle.leases.release(this.lease);
    } catch (error) {
      errors.push(`release lease: ${errorMessage(error)}`);
    }

    let storeClosed = false;
    try {
      this.handle.close();
      storeClosed = true;
    } catch (error) {
      errors.push(`close store: ${errorMessage(error)}`);
    }

    const result: DaemonStopResult = {
      pid: this.info.pid,
      address: { ...this.info.address },
      reason,
      leaseReleased,
      storeClosed,
      errors,
    };
    this.runState = "stopped";
    this.stoppedResult = result;
    for (const waiter of this.stoppedWaiters.splice(0)) waiter(result);
    return result;
  }
}

export async function startDaemon(
  options: StartDaemonOptions,
): Promise<CliyardDaemon> {
  const repoRoot = resolve(options.repoRoot);
  assertRepoRoot(repoRoot);
  const port = options.port ?? 0;
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new DaemonError(
      `port must be an integer from 0 to 65535 (got ${String(port)})`,
    );
  }
  const pid = options.pid ?? process.pid;
  if (!Number.isInteger(pid) || pid <= 0) {
    throw new DaemonError("pid must be a positive integer");
  }
  const host = options.hostname ?? hostname();
  const now = options.now ?? (() => new Date().toISOString());
  const holderId = options.holderId ?? randomUUID();
  const readIdentity =
    options.readStartIdentity ?? readProcessStartIdentity;

  const handle = (options.openStore ?? openDaemonStore)(repoRoot);
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    // No protocol and no action surface in P2a. Accept, then close.
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    socket.on("error", () => {});
    socket.end();
  });

  let lease: DaemonLeaseRecord | null = null;
  try {
    await listen(server, DAEMON_CONTROL_HOST, port);
    const address = boundAddress(server);
    const startedAt = now();
    lease = await handle.leases.acquire(
      {
        holderId,
        pid,
        host,
        repoRoot,
        startedAt,
        processStartIdentity: readIdentity(pid),
        address,
      },
      {
        isAlive: options.isAlive,
        readStartIdentity: options.readStartIdentity,
      },
    );

    const info: DaemonInfo = {
      pid,
      address: { ...address },
      addressText: `${address.host}:${address.port}`,
      repoRoot,
      storePath: handle.storePath,
      backend: handle.backend,
      holderId,
      startedAt,
    };
    const daemon = new CliyardDaemon({
      info,
      handle,
      server,
      sockets,
      lease,
    });
    server.on("error", (error) => {
      if (daemon.state !== "running") return;
      void daemon.stop(`server-error: ${errorMessage(error)}`);
    });
    return daemon;
  } catch (error) {
    await closeServer(server, sockets).catch(() => {});
    if (lease !== null) {
      await handle.leases.release(lease).catch(() => {});
    }
    try {
      handle.close();
    } catch {
      /* the original error is the useful one */
    }
    throw error;
  }
}

function assertRepoRoot(repoRoot: string): void {
  let stat;
  try {
    stat = statSync(repoRoot);
  } catch (error) {
    throw new DaemonError(
      `repository root is not readable: ${repoRoot} (${errorMessage(error)})`,
    );
  }
  if (!stat.isDirectory()) {
    throw new DaemonError(`repository root is not a directory: ${repoRoot}`);
  }
}

function listen(server: Server, host: string, port: number): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const onError = (error: Error): void => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = (): void => {
      server.off("error", onError);
      resolvePromise();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen({ host, port, exclusive: true });
  });
}

function boundAddress(server: Server): DaemonAddress {
  const address = server.address();
  if (
    address === null ||
    typeof address === "string" ||
    address.address !== DAEMON_CONTROL_HOST ||
    !Number.isInteger(address.port) ||
    address.port < 1 ||
    address.port > 65535
  ) {
    throw new DaemonError(
      `unexpected bound address: ${JSON.stringify(address)}`,
    );
  }
  return { host: DAEMON_CONTROL_HOST, port: address.port };
}

function closeServer(
  server: Server,
  sockets: ReadonlySet<Socket> = new Set(),
): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    try {
      server.close((error) => {
        if (error !== undefined) reject(error);
        else resolvePromise();
      });
    } catch (error) {
      reject(error);
      return;
    }
    // P2a has no protocol; a client that never completes the close must not
    // block release of the lease. Destroy tracked sockets so `close` settles.
    for (const socket of sockets) socket.destroy();
  });
}

// ---------------------------------------------------------------------------
// Durable JSON fact-log fallback driver
// ---------------------------------------------------------------------------

/**
 * Mirrors the supervisor's private fallback driver: one atomically replaced
 * JSON file with `{ version: 1, meta, facts }`, projection rows rebuilt on
 * open and never persisted. The single intended difference is that meta
 * writes (the lease) are committed on their own; the supervisor's copy only
 * persists meta alongside a fact append.
 *
 * Like the supervisor's copy, this backend does not provide multi-process
 * transactions. The daemon's lease critical section is therefore guarded by
 * the exact-owner lock file above.
 */
export class JsonFactLogDriver implements StateStoreDriver {
  readonly kind = "json-file";

  private readonly facts = new Map<number, PersistedFact>();
  private readonly eventIds = new Set<string>();
  private readonly meta = new Map<string, string>();
  private readonly attempts = new Map<string, AttemptRow>();
  private readonly evidence = new Map<string, EvidenceRow>();
  private last = 0;
  private initialized = false;
  private inTransaction = false;
  private dirty = false;
  private closed = false;

  constructor(private readonly filePath: string) {}

  initialize(): void {
    this.assertOpen();
    if (this.initialized) return;
    this.initialized = true;

    let raw: string;
    try {
      raw = readFileSync(this.filePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw new StateStoreCorruptionError(
        `cannot read StateStore facts ${this.filePath}: ${errorMessage(error)}`,
      );
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw) as unknown;
    } catch (error) {
      throw new StateStoreCorruptionError(
        `invalid JSON in StateStore facts ${this.filePath}: ` +
          errorMessage(error),
      );
    }
    if (
      !isRecord(parsed) ||
      parsed.version !== 1 ||
      !Array.isArray(parsed.facts)
    ) {
      throw new StateStoreCorruptionError(
        `StateStore facts ${this.filePath} must be { version: 1, facts: [] }`,
      );
    }

    if (parsed.meta !== undefined) {
      if (!isRecord(parsed.meta)) {
        throw new StateStoreCorruptionError(
          `StateStore facts ${this.filePath} contain invalid metadata`,
        );
      }
      for (const [key, value] of Object.entries(parsed.meta)) {
        if (typeof value !== "string") {
          throw new StateStoreCorruptionError(
            `StateStore facts ${this.filePath} contain invalid metadata for ` +
              `${key}`,
          );
        }
        this.meta.set(key, value);
      }
    }

    for (const candidate of parsed.facts) {
      if (
        !isRecord(candidate) ||
        !Number.isSafeInteger(candidate.seq) ||
        (candidate.seq as number) < 1 ||
        typeof candidate.eventId !== "string" ||
        candidate.eventId.length === 0 ||
        typeof candidate.at !== "string" ||
        typeof candidate.kind !== "string" ||
        typeof candidate.attemptId !== "string" ||
        !("payload" in candidate)
      ) {
        throw new StateStoreCorruptionError(
          `StateStore facts ${this.filePath} contain an invalid record`,
        );
      }
      const fact = candidate as unknown as PersistedFact;
      if (this.facts.has(fact.seq)) {
        throw new StateStoreCorruptionError(
          `StateStore facts ${this.filePath} contain duplicate sequence ` +
            `${fact.seq}`,
          fact.seq,
        );
      }
      if (this.eventIds.has(fact.eventId)) {
        throw new StateStoreCorruptionError(
          `StateStore facts ${this.filePath} contain duplicate event id ` +
            `${fact.eventId}`,
          fact.seq,
        );
      }
      this.facts.set(fact.seq, { ...fact });
      this.eventIds.add(fact.eventId);
      if (fact.seq > this.last) this.last = fact.seq;
    }
    for (let seq = 1; seq <= this.last; seq += 1) {
      if (!this.facts.has(seq)) {
        throw new StateStoreCorruptionError(
          `StateStore facts ${this.filePath} are not contiguous at sequence ` +
            `${seq}`,
          seq,
        );
      }
    }
  }

  transaction<T>(work: (tx: StateStoreTransaction) => T): T {
    this.assertOpen();
    if (!this.initialized) {
      throw new StateStoreCorruptionError(
        "StateStoreDriver.initialize() must run before transaction()",
      );
    }
    if (this.inTransaction) {
      throw new StateStoreCorruptionError(
        "StateStore driver transactions cannot nest",
      );
    }
    const snapshot = this.capture();
    this.inTransaction = true;
    this.dirty = false;
    try {
      const result = work(this.transactionApi);
      if (this.dirty) this.persist();
      return result;
    } catch (error) {
      this.restore(snapshot);
      throw error;
    } finally {
      this.inTransaction = false;
      this.dirty = false;
    }
  }

  close(): void {
    this.closed = true;
  }

  private readonly transactionApi: StateStoreTransaction = {
    getMeta: (key) => {
      this.assertOpen();
      return this.meta.get(key);
    },
    setMeta: (key, value) => {
      this.assertOpen();
      this.meta.set(key, value);
      this.dirty = true;
    },
    deleteMeta: (key) => {
      this.assertOpen();
      if (this.meta.delete(key)) this.dirty = true;
    },
    lastSeq: () => {
      this.assertOpen();
      return this.last;
    },
    readFacts: (afterSeq, limit) => {
      this.assertOpen();
      if (!Number.isSafeInteger(afterSeq) || afterSeq < 0) {
        throw new StateStoreCorruptionError(
          "afterSeq must be a non-negative safe integer",
        );
      }
      if (!Number.isSafeInteger(limit) || limit < 1) {
        throw new StateStoreCorruptionError(
          "limit must be a positive safe integer",
        );
      }
      return [...this.facts.values()]
        .filter((fact) => fact.seq > afterSeq)
        .sort((left, right) => left.seq - right.seq)
        .slice(0, limit)
        .map((fact) => ({ ...fact }));
    },
    appendFact: (fact) => {
      this.assertOpen();
      if (fact.seq !== this.last + 1) {
        throw new StateStoreCorruptionError(
          `StateStore fact sequence ${fact.seq} is not contiguous after ` +
            `${this.last}`,
          fact.seq,
        );
      }
      if (this.eventIds.has(fact.eventId)) {
        throw new StateStoreCorruptionError(
          `StateStore event id ${fact.eventId} already exists`,
          fact.seq,
        );
      }
      this.facts.set(fact.seq, { ...fact });
      this.eventIds.add(fact.eventId);
      this.last = fact.seq;
      this.dirty = true;
    },
    clearProjection: () => {
      this.assertOpen();
      this.attempts.clear();
      this.evidence.clear();
      this.meta.delete(META_PROJECTION_FORMAT);
      this.meta.delete(META_PROJECTION_SEQ);
      this.dirty = true;
    },
    readAttempts: () => {
      this.assertOpen();
      return [...this.attempts.values()]
        .sort((left, right) =>
          compareStrings(left.attemptId, right.attemptId),
        )
        .map((row) => ({ ...row }));
    },
    putAttempt: (row) => {
      this.assertOpen();
      this.attempts.set(row.attemptId, { ...row });
    },
    readEvidence: () => {
      this.assertOpen();
      return [...this.evidence.values()]
        .sort(
          (left, right) =>
            compareStrings(left.attemptId, right.attemptId) ||
            compareStrings(left.contentHash, right.contentHash),
        )
        .map((row) => ({ ...row }));
    },
    putEvidence: (row) => {
      this.assertOpen();
      this.evidence.set(`${row.attemptId} ${row.contentHash}`, { ...row });
    },
  };

  private assertOpen(): void {
    if (this.closed) throw new StateStoreClosedError();
  }

  private capture(): {
    facts: Map<number, PersistedFact>;
    eventIds: Set<string>;
    meta: Map<string, string>;
    attempts: Map<string, AttemptRow>;
    evidence: Map<string, EvidenceRow>;
    last: number;
  } {
    return {
      facts: new Map(
        [...this.facts].map(([seq, fact]) => [seq, { ...fact }]),
      ),
      eventIds: new Set(this.eventIds),
      meta: new Map(this.meta),
      attempts: new Map(
        [...this.attempts].map(([key, row]) => [key, { ...row }]),
      ),
      evidence: new Map(
        [...this.evidence].map(([key, row]) => [key, { ...row }]),
      ),
      last: this.last,
    };
  }

  private restore(snapshot: {
    facts: Map<number, PersistedFact>;
    eventIds: Set<string>;
    meta: Map<string, string>;
    attempts: Map<string, AttemptRow>;
    evidence: Map<string, EvidenceRow>;
    last: number;
  }): void {
    this.facts.clear();
    for (const [seq, fact] of snapshot.facts) this.facts.set(seq, fact);
    this.eventIds.clear();
    for (const eventId of snapshot.eventIds) this.eventIds.add(eventId);
    this.meta.clear();
    for (const [key, value] of snapshot.meta) this.meta.set(key, value);
    this.attempts.clear();
    for (const [key, row] of snapshot.attempts) this.attempts.set(key, row);
    this.evidence.clear();
    for (const [key, row] of snapshot.evidence) this.evidence.set(key, row);
    this.last = snapshot.last;
  }

  private persist(): void {
    // Derived projection rows are rebuilt from the fact log on every open.
    const meta: Record<string, string> = {};
    for (const [key, value] of this.meta) {
      if (key === META_PROJECTION_FORMAT || key === META_PROJECTION_SEQ) {
        continue;
      }
      meta[key] = value;
    }
    writeJsonAtomic(this.filePath, {
      version: 1,
      meta,
      facts: [...this.facts.values()].sort(
        (left, right) => left.seq - right.seq,
      ),
    });
  }
}

function writeJsonAtomic(path: string, value: unknown): void {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
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

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

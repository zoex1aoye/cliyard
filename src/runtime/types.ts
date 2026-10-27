/**
 * RuntimeManager v0 shared shapes (design/runtime-manager-v0.md).
 *
 * `RuntimeSpec` is the frozen, argv-based service description. `PortLease` is
 * the durable single-host port reservation. `RuntimeManifest` is the persisted
 * record of one acceptance runtime; it lives under
 * `<repoRoot>/.cliyard/runtime/<runtimeId>/runtime-manifest.json`.
 */

export const RUNTIME_HOST = "127.0.0.1" as const;
export const RUNTIME_MANIFEST_VERSION = 1 as const;
export const PORT_LEASE_STORE_VERSION = 1 as const;

export type RuntimeHost = typeof RUNTIME_HOST;

export interface RuntimeReadinessSpec {
  /** Defaults to `/`. */
  path?: string;
  /** Defaults to `200`. */
  expectedStatus?: number;
  /** Defaults to 30 seconds. */
  timeoutMs?: number;
}

export interface RuntimeServiceSpec {
  /** Unique within a task and safe as a path segment. */
  name: string;
  /** argv array, never a shell string. */
  command: string[];
  /** Relative paths are resolved inside the task worktree. */
  cwd?: string;
  /** Environment variable that receives the leased port. */
  portEnv?: string;
  /** Extra compatibility variable that receives the service URL. */
  urlEnv?: string;
  readiness?: RuntimeReadinessSpec;
}

export interface RuntimeSpec {
  services: RuntimeServiceSpec[];
}

/**
 * One port reservation for a `runId + service` pair.
 *
 * `host` is always the bind host, not the lease owner's machine: the store is
 * single-host in v0. `pid` is the allocating process that owns the lease.
 */
export interface PortLease {
  /** `${runId}:${service}` */
  key: string;
  runId: string;
  service: string;
  host: RuntimeHost;
  port: number;
  pid: number;
  acquiredAt: string;
}

/** `<repoRoot>/.cliyard/runtime/port-leases.json` */
export interface PortLeaseStore {
  version: typeof PORT_LEASE_STORE_VERSION;
  leases: PortLease[];
}

export interface RuntimeReadinessAttempt {
  at: string;
  url: string;
  /** HTTP status when a response was received. */
  status?: number;
  ok: boolean;
  error?: string;
}

export type RuntimeCleanupState =
  | "pending"
  | "running"
  | "complete"
  | "failed";

export interface RuntimeServiceManifest {
  name: string;
  host: RuntimeHost;
  port: number;
  pid?: number;
  url: string;
  healthUrl: string;
  logPath: string;
  dataDir: string;
  readinessAttempts: RuntimeReadinessAttempt[];
  startedAt?: string;
  exitedAt?: string;
  exitCode?: number | null;
  signal?: string | null;
  error?: string;
}

export interface RuntimeManifest {
  version: typeof RUNTIME_MANIFEST_VERSION;
  runtimeId: string;
  taskId: string;
  attempt: number;
  worktree: string;
  /** Exact code snapshot the runtime was started from, when known. */
  artifactHash?: string;
  services: RuntimeServiceManifest[];
  startedAt: string;
  stoppedAt?: string;
  cleanup: RuntimeCleanupState;
  failureReason?: string;
}

/**
 * Read-only orphan recovery preflight (design/runtime-orphan-reaper-v0.md).
 *
 * Safety rule: reclaim only what can be proven to belong to this runtime;
 * otherwise preserve the evidence and report `needs_human`.
 *
 * This module scans `<repoRoot>/.cliyard/runtime/<runtimeId>/runtime-manifest.json`,
 * correlates every started service with its exact `PortAllocator` lease, and
 * inspects the recorded process group. It never signals a process, releases a
 * lease, probes a port, or writes a manifest — the destructive executor lives in
 * `reaper-execute.ts` and may only act on `safe_to_reap` plans from here.
 *
 * One runtime yields exactly one plan:
 *
 *   safe_to_reap — owner dead, every started service proven (live with an exact
 *                  identity match, or already exited with an empty group), and
 *                  no other unfinished manifest references the group or port;
 *   needs_human  — any prerequisite is missing, unknown, mismatched, or
 *                  ambiguous (including legacy manifests that are potentially
 *                  active and any competing manifest);
 *   skip         — complete, already reconciled, foreign-host, still-owned, or
 *                  empty runtime with no local action.
 */
import { readdirSync, readFileSync, type Dirent } from "node:fs";
import { join, resolve } from "node:path";
import { RUNTIME_MANIFEST_FILE } from "./manager.js";
import { PortAllocator, portAllocatorPaths } from "./ports.js";
import {
  ProcessInspector,
  compareProcessIdentity,
  isProcessIdentity,
  isProcessPid,
  isRuntimeOwner,
} from "./process.js";
import {
  RUNTIME_HOST,
  RUNTIME_MANIFEST_VERSION,
  type PortLease,
  type RuntimeCleanupState,
  type RuntimeManifest,
  type RuntimeOwner,
  type RuntimeProcessIdentity,
  type RuntimeServiceManifest,
} from "./types.js";

const CLEANUP_STATES: ReadonlySet<RuntimeCleanupState> = new Set([
  "pending",
  "running",
  "complete",
  "failed",
]);

export class RuntimeReaperError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

// ---------------------------------------------------------------------------
// Public shapes
// ---------------------------------------------------------------------------

/**
 * - `safe_to_reap`: every started service passed exact correlation.
 * - `needs_human`: at least one prerequisite, identity, or correlation is
 *   uncertain; nothing may be touched.
 * - `skip`: no local action (complete, already reconciled, foreign host, or a
 *   runtime whose owner is still alive).
 */
export type RuntimeReapPlanState = "safe_to_reap" | "needs_human" | "skip";

/**
 * Proposed action for one service. Only meaningful when the plan state is
 * `safe_to_reap`; executors must ignore actions on any other plan.
 */
export type RuntimeReapServiceAction =
  /** Leader is alive with an exact identity match; the group may be stopped. */
  | "terminate"
  /** No process remains; the exact lease may be released without signalling. */
  | "already-exited"
  /** Service never started and holds no lease; nothing to do. */
  | "none"
  /** Identity/correlation is uncertain; preserve the process and lease. */
  | "preserve";

export interface RuntimeReapServicePlan {
  name: string;
  pid?: number;
  pgid?: number;
  /** Exact persisted identity used for the correlation, when valid. */
  processIdentity?: RuntimeProcessIdentity;
  /** Exact correlated lease, when one exists. */
  lease?: PortLease;
  action: RuntimeReapServiceAction;
  /** Why this service received its classification. */
  reason: string;
}

export interface RuntimeReapPlan {
  runtimeId: string;
  manifestPath: string;
  state: RuntimeReapPlanState;
  /** Summary reason; for `needs_human` every blocking problem is included. */
  reason: string;
  /** Parsed manifest, absent only when the manifest could not be read/parsed. */
  manifest?: RuntimeManifest;
  services: RuntimeReapServicePlan[];
  /** Exact leases correlated with this runtime's services (evidence). */
  leases: PortLease[];
  /** Blocking problems that produced `needs_human`. */
  problems: string[];
}

export interface RuntimeReapPreflightReport {
  /** Number of runtime manifest files examined (valid and invalid). */
  scanned: number;
  /** One plan per scanned runtime, ordered by runtime directory name. */
  plans: RuntimeReapPlan[];
  safeToReap: RuntimeReapPlan[];
  needsHuman: RuntimeReapPlan[];
  skipped: RuntimeReapPlan[];
}

/** Minimal read-only lease source; `PortAllocator` satisfies this. */
export interface RuntimeReapLeaseSource {
  list(): PortLease[];
}

export interface RuntimeReapPreflightOptions {
  /** Local hostname for same-host checks (default `os.hostname()`). */
  host?: string;
  /** Process inspector override (default a `ProcessInspector` for `host`). */
  inspector?: ProcessInspector;
  /** Lease source override (default a read-only `PortAllocator`). */
  allocator?: RuntimeReapLeaseSource;
}

// ---------------------------------------------------------------------------
// Preflight
// ---------------------------------------------------------------------------

/**
 * Scan every runtime manifest under `<repoRoot>/.cliyard/runtime` and classify
 * it without mutating any process, lease, or manifest.
 */
export async function preflightOrphanedRuntimes(
  repoRoot: string,
  options: RuntimeReapPreflightOptions = {},
): Promise<RuntimeReapPreflightReport> {
  if (typeof repoRoot !== "string" || repoRoot.trim() === "") {
    throw new RuntimeReaperError("repoRoot must be a non-empty string");
  }
  if (options === null || typeof options !== "object") {
    throw new RuntimeReaperError("options must be an object");
  }

  const root = resolve(repoRoot);
  const inspector =
    options.inspector ?? new ProcessInspector({ host: options.host });

  let allocator: RuntimeReapLeaseSource | undefined;
  let leaseError: string | undefined;
  if (options.allocator !== undefined) {
    if (typeof options.allocator.list !== "function") {
      throw new RuntimeReaperError("allocator must implement list()");
    }
    allocator = options.allocator;
  } else {
    try {
      allocator = new PortAllocator({ repoRoot: root });
    } catch (error) {
      // An unusable default allocator is a correlation failure for candidates,
      // not a reason to stop scanning completed/foreign runtimes.
      leaseError = `port lease store is unavailable: ${errorMessage(error)}`;
    }
  }

  let leases: PortLease[] | undefined;
  if (allocator !== undefined) {
    try {
      const listed = allocator.list();
      if (!Array.isArray(listed)) {
        throw new RuntimeReaperError("allocator.list() did not return an array");
      }
      leases = listed;
    } catch (error) {
      leaseError = `cannot read port leases: ${errorMessage(error)}`;
    }
  }

  const runtimeDir = portAllocatorPaths(root).runtimeDir;
  const scanned = scanRuntimeManifests(runtimeDir);

  const plans: RuntimeReapPlan[] = [];
  for (const entry of scanned) {
    plans.push(
      await classifyManifest(entry, scanned, inspector, leases, leaseError),
    );
  }

  return {
    scanned: plans.length,
    plans,
    safeToReap: plans.filter((plan) => plan.state === "safe_to_reap"),
    needsHuman: plans.filter((plan) => plan.state === "needs_human"),
    skipped: plans.filter((plan) => plan.state === "skip"),
  };
}

async function classifyManifest(
  entry: ScannedManifest,
  scanned: readonly ScannedManifest[],
  inspector: ProcessInspector,
  leases: PortLease[] | undefined,
  leaseError: string | undefined,
): Promise<RuntimeReapPlan> {
  const base: PlanBase = {
    runtimeId: entry.manifest?.runtimeId ?? entry.dirName,
    manifestPath: entry.manifestPath,
    ...(entry.manifest !== undefined ? { manifest: entry.manifest } : {}),
    services: [],
    leases: [],
    problems: [],
  };

  if (entry.error !== undefined) {
    return needsHumanPlan(base, [entry.error]);
  }
  const manifest = entry.manifest!;

  if (manifest.runtimeId !== entry.dirName) {
    return needsHumanPlan(base, [
      `manifest runtimeId ${JSON.stringify(manifest.runtimeId)} does not match ` +
        `its directory ${JSON.stringify(entry.dirName)}`,
    ]);
  }

  if (manifest.cleanup === "complete") {
    return skipPlan(base, "cleanup is complete; nothing to reconcile");
  }
  if (manifest.recovery?.state === "reaped") {
    return skipPlan(
      base,
      "runtime was already reconciled by a previous reaper run",
    );
  }

  const owner = manifest.owner;
  if (!isRuntimeOwner(owner)) {
    return needsHumanPlan(base, [
      "manifest has no valid owner identity; the runtime is potentially " +
        "active and orphan status cannot be proven",
    ]);
  }

  const ownerState = inspector.ownerState(owner);
  if (ownerState === "foreign-host") {
    return skipPlan(
      base,
      `owner host ${JSON.stringify(owner.host)} is not local host ` +
        `${JSON.stringify(inspector.host)}; no local action`,
    );
  }
  if (ownerState === "alive") {
    return skipPlan(
      base,
      `owner pid ${owner.pid} is still running on this host; not an orphan`,
    );
  }
  if (ownerState !== "dead") {
    return needsHumanPlan(base, [
      "owner identity is invalid; orphan status cannot be proven",
    ]);
  }

  if (leases === undefined) {
    return needsHumanPlan(base, [
      leaseError ?? "port leases are unavailable; services cannot be correlated",
    ]);
  }

  const services: RuntimeReapServicePlan[] = [];
  const correlated: PortLease[] = [];
  const problems: string[] = [];

  for (const service of manifest.services) {
    const assessment = await assessService(
      entry,
      manifest,
      service,
      owner,
      inspector,
      leases,
      scanned,
    );
    services.push(assessment.plan);
    problems.push(...assessment.problems);
    if (assessment.lease !== undefined) correlated.push(assessment.lease);
  }

  // A lease under this runtime id that no manifest service owns is evidence of
  // a service that may have started before the manifest was updated.
  const matchedKeys = new Set(correlated.map((lease) => lease.key));
  const extraLeases = leases.filter(
    (lease) =>
      lease.runId === manifest.runtimeId && !matchedKeys.has(lease.key),
  );
  if (extraLeases.length > 0) {
    problems.push(
      `runtime holds port lease(s) with no matching manifest service: ` +
        extraLeases.map((lease) => `${lease.key}@${lease.port}`).join(", "),
    );
  }

  if (problems.length > 0) {
    return needsHumanPlan(
      { ...base, services, leases: correlated },
      problems,
    );
  }

  const terminated = services.filter(
    (service) => service.action === "terminate",
  ).length;
  const alreadyExited = services.filter(
    (service) => service.action === "already-exited",
  ).length;
  const summary = [`owner pid ${owner.pid} is not running on this host`];
  if (services.length === 0) {
    summary.push("no services were recorded");
  } else {
    summary.push(
      `${terminated} service(s) proven live, ${alreadyExited} already exited`,
    );
  }

  return {
    ...base,
    state: "safe_to_reap",
    reason: summary.join("; "),
    services,
    leases: correlated,
    problems: [],
  };
}

// ---------------------------------------------------------------------------
// Per-service correlation
// ---------------------------------------------------------------------------

interface ServiceAssessment {
  plan: RuntimeReapServicePlan;
  problems: string[];
  lease?: PortLease;
}

async function assessService(
  entry: ScannedManifest,
  manifest: RuntimeManifest,
  service: RuntimeServiceManifest,
  owner: RuntimeOwner,
  inspector: ProcessInspector,
  leases: readonly PortLease[],
  scanned: readonly ScannedManifest[],
): Promise<ServiceAssessment> {
  const name = JSON.stringify(service.name);
  const lease = leases.find((candidate) =>
    isExactLease(candidate, manifest.runtimeId, service),
  );
  const base = {
    name: service.name,
    ...(service.pid !== undefined ? { pid: service.pid } : {}),
    ...(service.pgid !== undefined ? { pgid: service.pgid } : {}),
    ...(isProcessIdentity(service.processIdentity)
      ? { processIdentity: service.processIdentity }
      : {}),
    ...(lease !== undefined ? { lease } : {}),
  };

  const preserve = (reason: string): ServiceAssessment => ({
    plan: { ...base, action: "preserve", reason },
    problems: [reason],
    ...(lease !== undefined ? { lease } : {}),
  });

  if (service.host !== RUNTIME_HOST) {
    return preserve(
      `service ${name} bind host ${JSON.stringify(service.host)} is not ` +
        `${JSON.stringify(RUNTIME_HOST)}; its lease cannot be correlated`,
    );
  }

  if (service.pid === undefined) {
    if (lease !== undefined) {
      return preserve(
        `service ${name} holds port lease ${lease.key}@${lease.port} but has ` +
          "no persisted pid/pgid/identity; it may have started before the " +
          "manifest was updated",
      );
    }
    return {
      plan: {
        ...base,
        action: "none",
        reason: `service ${name} was never started and holds no lease`,
      },
      problems: [],
    };
  }

  if (service.pgid === undefined || service.pgid !== service.pid) {
    return preserve(
      `service ${name} pid ${service.pid} does not equal its persisted pgid ` +
        `${service.pgid ?? "missing"}; group ownership is not provable`,
    );
  }
  const pgid = service.pgid;
  const pid = service.pid;

  if (lease === undefined) {
    return preserve(
      `service ${name} (pid ${pid}) has no exact port lease for ` +
        `${RUNTIME_HOST}:${service.port}`,
    );
  }

  // Exact ownership: the lease must have been acquired by the manifest owner.
  // A mismatch is never safe, even when the third-party owner is already dead;
  // the dead owner's lease does not prove this runtime's service. Preserve the
  // group, lease, and manifest for human review.
  if (lease.pid !== owner.pid) {
    const liveness = inspector.isAlive(lease.pid) ? "live" : "dead";
    return preserve(
      `service ${name} lease ${lease.key}@${lease.port} is owned by ${liveness} ` +
        `pid ${lease.pid}, not the runtime owner pid ${owner.pid}; exact lease ` +
        "ownership cannot be proven",
    );
  }

  const expected = service.processIdentity;
  if (!isProcessIdentity(expected)) {
    // Legacy manifest: absence of identity is unknown, never a match. Only a
    // provably empty group may still be treated as already exited.
    if (inspector.isAlive(pid)) {
      return preserve(
        `service ${name} pid ${pid} is alive but the manifest has no exact ` +
          "persisted process identity; ownership cannot be proven",
      );
    }
    const members = await inspectGroup(inspector, pgid, name);
    if (typeof members === "string") return preserve(members);
    if (members.length > 0) {
      return preserve(
        `service ${name} leader pid ${pid} is gone but process group ${pgid} ` +
          `still has ${members.length} member(s); ownership cannot be proven`,
      );
    }
    return alreadyExited(
      entry,
      service,
      scanned,
      `service ${name} leader pid ${pid} is gone and process group ${pgid} ` +
        "is empty; nothing to signal",
      lease,
      base,
    );
  }

  let observed: RuntimeProcessIdentity | undefined;
  try {
    observed = await inspector.capture(pid);
  } catch (error) {
    return preserve(
      `service ${name} process identity cannot be inspected: ` +
        errorMessage(error),
    );
  }

  const comparison = compareProcessIdentity(expected, observed);
  if (comparison === "match") {
    const competitors = findCompetingManifests(entry, service, scanned);
    if (competitors.length > 0) {
      return preserve(competingReason(name, competitors));
    }
    return {
      plan: {
        ...base,
        action: "terminate",
        reason:
          `service ${name} leader pid ${pid} in process group ${pgid} ` +
          `matches the persisted identity (started ${expected.startedAt}); ` +
          "safe to terminate",
      },
      problems: [],
      lease,
    };
  }

  if (comparison === "mismatch") {
    return preserve(
      `service ${name} pid ${pid} identity changed since it was recorded ` +
        `(persisted ${describeIdentity(expected)}, observed ` +
        `${describeIdentity(observed)}); refusing to signal a reused pid`,
    );
  }

  // `unknown`: the expected identity is valid, so `ps` saw no leader row.
  if (observed !== undefined) {
    return preserve(
      `service ${name} process identity is incomplete or invalid ` +
        `(persisted ${describeIdentity(expected)}, observed ` +
        `${describeIdentity(observed)}); ownership cannot be proven`,
    );
  }
  if (inspector.isAlive(pid)) {
    // Contradictory evidence: the pid exists but no identity could be read.
    return preserve(
      `service ${name} pid ${pid} still appears alive but no exact process ` +
        "identity could be captured; ownership cannot be proven",
    );
  }

  const members = await inspectGroup(inspector, pgid, name);
  if (typeof members === "string") return preserve(members);
  if (members.length > 0) {
    return preserve(
      `service ${name} leader pid ${pid} has exited but process group ${pgid} ` +
        `still has ${members.length} member(s); ownership cannot be proven`,
    );
  }

  return alreadyExited(
    entry,
    service,
    scanned,
    `service ${name} leader pid ${pid} is gone and process group ${pgid} is ` +
      "empty; already exited",
    lease,
    base,
  );
}

async function alreadyExited(
  entry: ScannedManifest,
  service: RuntimeServiceManifest,
  scanned: readonly ScannedManifest[],
  reason: string,
  lease: PortLease,
  base: Omit<RuntimeReapServicePlan, "action" | "reason">,
): Promise<ServiceAssessment> {
  const competitors = findCompetingManifests(entry, service, scanned);
  if (competitors.length > 0) {
    const competing = competingReason(
      JSON.stringify(service.name),
      competitors,
    );
    return {
      plan: { ...base, lease, action: "preserve", reason: competing },
      problems: [competing],
      lease,
    };
  }

  return {
    plan: { ...base, lease, action: "already-exited", reason },
    problems: [],
    lease,
  };
}

/** Returns members, or a problem string when `ps` cannot be trusted. */
async function inspectGroup(
  inspector: ProcessInspector,
  pgid: number,
  name: string,
): Promise<RuntimeProcessIdentity[] | string> {
  try {
    return await inspector.listGroupMembers(pgid);
  } catch (error) {
    return (
      `service ${name} process group ${pgid} cannot be inspected: ` +
      errorMessage(error)
    );
  }
}

// ---------------------------------------------------------------------------
// Competing manifests
// ---------------------------------------------------------------------------

interface CompetingManifest {
  runtimeId: string;
  matches: string[];
}

/**
 * Another unfinished manifest that references the same process group, leader
 * pid, or bind port makes ownership non-exclusive. Completed and already-reaped
 * manifests are historical evidence and are ignored (their ports may be reused).
 */
function findCompetingManifests(
  current: ScannedManifest,
  service: RuntimeServiceManifest,
  scanned: readonly ScannedManifest[],
): CompetingManifest[] {
  const competitors: CompetingManifest[] = [];
  for (const other of scanned) {
    if (
      other.manifest === undefined ||
      other.manifestPath === current.manifestPath ||
      isReconciled(other.manifest)
    ) {
      continue;
    }
    const matches: string[] = [];
    for (const otherService of other.manifest.services) {
      if (
        service.pid !== undefined &&
        otherService.pid === service.pid &&
        !matches.includes(`pid ${service.pid}`)
      ) {
        matches.push(`pid ${service.pid}`);
      }
      if (
        service.pgid !== undefined &&
        otherService.pgid === service.pgid &&
        !matches.includes(`pgid ${service.pgid}`)
      ) {
        matches.push(`pgid ${service.pgid}`);
      }
      if (
        otherService.host === service.host &&
        otherService.port === service.port &&
        !matches.includes(`port ${service.port}`)
      ) {
        matches.push(`port ${service.port}`);
      }
    }
    if (matches.length > 0) {
      competitors.push({
        runtimeId: other.manifest.runtimeId,
        matches,
      });
    }
  }
  return competitors;
}

function competingReason(
  name: string,
  competitors: readonly CompetingManifest[],
): string {
  const detail = competitors
    .map((entry) => `${entry.runtimeId} (${entry.matches.join(", ")})`)
    .join(", ");
  return (
    `service ${name} is also referenced by unfinished runtime manifest(s): ` +
    `${detail}; ownership is not exclusive`
  );
}

function isReconciled(manifest: RuntimeManifest): boolean {
  return (
    manifest.cleanup === "complete" || manifest.recovery?.state === "reaped"
  );
}

// ---------------------------------------------------------------------------
// Manifest scanning and parsing
// ---------------------------------------------------------------------------

interface ScannedManifest {
  /** Runtime directory name; also the fallback runtime id for invalid JSON. */
  dirName: string;
  manifestPath: string;
  manifest?: RuntimeManifest;
  /** Read/parse/validation failure; a plan for this runtime is `needs_human`. */
  error?: string;
}

function scanRuntimeManifests(runtimeDir: string): ScannedManifest[] {
  let entries: Dirent[];
  try {
    entries = readdirSync(runtimeDir, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw new RuntimeReaperError(
      `cannot scan runtime directory ${runtimeDir}: ${errorMessage(error)}`,
    );
  }

  const scanned: ScannedManifest[] = [];
  for (const entry of entries
    .filter((candidate) => candidate.isDirectory())
    .sort((a, b) => a.name.localeCompare(b.name))) {
    const manifestPath = join(runtimeDir, entry.name, RUNTIME_MANIFEST_FILE);

    let raw: string;
    try {
      raw = readFileSync(manifestPath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      scanned.push({
        dirName: entry.name,
        manifestPath,
        error:
          `cannot read runtime manifest ${manifestPath}: ` +
          errorMessage(error),
      });
      continue;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw) as unknown;
    } catch (error) {
      scanned.push({
        dirName: entry.name,
        manifestPath,
        error:
          `invalid JSON in runtime manifest ${manifestPath}: ` +
          errorMessage(error),
      });
      continue;
    }

    try {
      scanned.push({
        dirName: entry.name,
        manifestPath,
        manifest: parseRuntimeManifest(parsed, manifestPath),
      });
    } catch (error) {
      scanned.push({
        dirName: entry.name,
        manifestPath,
        error: errorMessage(error),
      });
    }
  }
  return scanned;
}

/**
 * Validate only the fields preflight relies on. Optional evidence
 * (`processIdentity`, `owner`) is parsed but validated at use time so legacy
 * manifests stay readable and fail closed instead of being rejected blindly.
 */
function parseRuntimeManifest(
  raw: unknown,
  source: string,
): RuntimeManifest {
  if (!isRecord(raw)) {
    throw new RuntimeReaperError(`${source}: manifest must be an object`);
  }
  if (raw.version !== RUNTIME_MANIFEST_VERSION) {
    throw new RuntimeReaperError(
      `${source}: unsupported manifest version ${JSON.stringify(raw.version)} ` +
        `(expected ${RUNTIME_MANIFEST_VERSION})`,
    );
  }
  if (typeof raw.runtimeId !== "string" || raw.runtimeId.trim() === "") {
    throw new RuntimeReaperError(
      `${source}: runtimeId must be a non-empty string`,
    );
  }
  if (
    typeof raw.cleanup !== "string" ||
    !CLEANUP_STATES.has(raw.cleanup as RuntimeCleanupState)
  ) {
    throw new RuntimeReaperError(
      `${source}: invalid cleanup state ${JSON.stringify(raw.cleanup)}`,
    );
  }
  if (!Array.isArray(raw.services)) {
    throw new RuntimeReaperError(`${source}: services must be an array`);
  }

  const names = new Set<string>();
  raw.services.forEach((service, index) => {
    const at = `${source}: services[${index}]`;
    if (!isRecord(service)) {
      throw new RuntimeReaperError(`${at}: service must be an object`);
    }
    if (typeof service.name !== "string" || service.name.trim() === "") {
      throw new RuntimeReaperError(
        `${at}: name must be a non-empty string`,
      );
    }
    if (names.has(service.name)) {
      throw new RuntimeReaperError(
        `${source}: duplicate service name ${JSON.stringify(service.name)}`,
      );
    }
    names.add(service.name);

    if (typeof service.host !== "string" || service.host.trim() === "") {
      throw new RuntimeReaperError(
        `${at}: host must be a non-empty string`,
      );
    }
    if (
      !Number.isInteger(service.port) ||
      (service.port as number) < 1 ||
      (service.port as number) > 65535
    ) {
      throw new RuntimeReaperError(
        `${at}: port must be an integer between 1 and 65535`,
      );
    }
    for (const field of ["pid", "pgid"] as const) {
      if (service[field] !== undefined && !isProcessPid(service[field])) {
        throw new RuntimeReaperError(
          `${at}: ${field} must be a positive integer when present`,
        );
      }
    }
  });

  return raw as unknown as RuntimeManifest;
}

// ---------------------------------------------------------------------------
// Plan construction
// ---------------------------------------------------------------------------

interface PlanBase {
  runtimeId: string;
  manifestPath: string;
  manifest?: RuntimeManifest;
  services: RuntimeReapServicePlan[];
  leases: PortLease[];
  problems: string[];
}

function needsHumanPlan(
  base: PlanBase,
  problems: readonly string[],
): RuntimeReapPlan {
  return {
    ...base,
    state: "needs_human",
    reason: problems.join("; "),
    problems: [...problems],
  };
}

function skipPlan(base: PlanBase, reason: string): RuntimeReapPlan {
  return {
    ...base,
    state: "skip",
    reason,
    problems: [],
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isExactLease(
  lease: PortLease,
  runtimeId: string,
  service: RuntimeServiceManifest,
): boolean {
  return (
    lease.runId === runtimeId &&
    lease.service === service.name &&
    lease.key === `${runtimeId}:${service.name}` &&
    lease.host === RUNTIME_HOST &&
    service.host === RUNTIME_HOST &&
    lease.port === service.port
  );
}

function describeIdentity(
  identity: RuntimeProcessIdentity | undefined,
): string {
  if (identity === undefined) return "no running process";
  return (
    `pid ${identity.pid} pgid ${identity.pgid} started ` +
    JSON.stringify(identity.startedAt)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

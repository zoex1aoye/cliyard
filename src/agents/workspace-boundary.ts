/**
 * WorkspaceBoundary v1 detection core (design/workspace-boundary-v1.md).
 *
 * This module captures deterministic protected-root snapshots and compares
 * them without ever writing to disk, spawning processes, reading environment
 * variables or collecting credentials. A snapshot hashes regular files by
 * SHA-256 content, records symlinks by their link target, and records
 * directory presence. Symlinks are never followed, so a link can never pull
 * the walk outside a protected root. Full snapshots exist in memory only;
 * callers receive bounded, sanitized path-level change records.
 *
 * Inspection is fail-closed: an unreadable root, an unsupported entry type,
 * unsafe evidence or any exceeded safety cap raises an explicit
 * `WorkspaceBoundaryInspectionError` instead of reporting a clean boundary.
 */

import { createHash } from "node:crypto";
import { createReadStream, type Dirent, type Dir } from "node:fs";
import { lstat, opendir, readlink } from "node:fs/promises";
import { isAbsolute, join, resolve, sep } from "node:path";

export const DEFAULT_MAX_ENTRIES_PER_ROOT = 100_000;
export const DEFAULT_MAX_CHANGES = 1_024;
export const DEFAULT_MAX_PATH_LENGTH = 4_096;
export const DEFAULT_MAX_DIAGNOSTIC_LENGTH = 2_048;

/**
 * Control-plane mutable paths excluded by default
 * (design/workspace-boundary-v1.md, design/workspace-boundary-exclude-cliyard-v0.md).
 *
 * `.git` is excluded wholesale and then re-included selectively: the
 * important common-directory state (`HEAD`, `index`, `packed-refs`, `config`,
 * `hooks`, `refs`) is protected while objects, logs and per-worktree state
 * are not hashed.
 *
 * `.cliyard` is the control plane's mutable state directory, not protected
 * source. Its ledgers (including per-task and test-fixture variants such as
 * `.cliyard/ledger-master-test.json`), queue state, plans, contracts,
 * evidence, worktrees, runtime state and event logs may be created or
 * rewritten while a worker runs, so the whole directory is excluded from
 * comparison. RunManifest files under `.cliyard/runs/` remain protected task
 * authority (design/workspace-boundary-v1.md); a caller may exclude the exact
 * active manifest while the control plane checkpoints it.
 *
 * `dist` is the TypeScript build output (`npm run build`). Workers and
 * verifiers may legitimately compile in their task worktree, so build output
 * is never boundary evidence.
 */
export const DEFAULT_EXCLUDED_CONTROL_PATHS: readonly string[] = Object.freeze([
  ".git",
  ".cliyard",
  "dist",
]);

/**
 * Excluded container directories that are still traversed so protected
 * descendants can be inspected. The containers themselves are never recorded
 * as snapshot entries, so creating `.cliyard` (or `.cliyard/runs`) during a
 * run is not boundary evidence.
 */
const EXCLUDED_TRAVERSAL_PATHS: readonly string[] = Object.freeze([
  ".cliyard",
  ".cliyard/runs",
]);

/**
 * RunManifest files are task authority, not disposable control state. Every
 * manifest except the caller-excluded active one stays protected.
 */
const RUN_MANIFEST_PATH_PATTERN = /^\.cliyard\/runs\/[^/]+\.json$/;

/** Important Git common-directory state protected despite the `.git` exclusion. */
const DEFAULT_GIT_STATE_PATHS: readonly string[] = Object.freeze([
  ".git/HEAD",
  ".git/index",
  ".git/packed-refs",
  ".git/config",
  ".git/hooks",
  ".git/refs",
]);

/** C0 controls, DEL, and C1 controls are never evidence-safe. */
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f-\u009f]/;
const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/;

/**
 * Global variant of `CONTROL_CHARACTER_PATTERN`. `String.replace` with a
 * non-global pattern replaces only the first match, leaving later control
 * characters in persisted diagnostics.
 */
const CONTROL_CHARACTER_PATTERN_GLOBAL = new RegExp(
  CONTROL_CHARACTER_PATTERN.source,
  "g",
);

export const DEFAULT_WORKSPACE_BOUNDARY_CAPS: Required<WorkspaceBoundaryCaps> =
  Object.freeze({
    maxEntriesPerRoot: DEFAULT_MAX_ENTRIES_PER_ROOT,
    maxChanges: DEFAULT_MAX_CHANGES,
    maxPathLength: DEFAULT_MAX_PATH_LENGTH,
    maxDiagnosticLength: DEFAULT_MAX_DIAGNOSTIC_LENGTH,
  });

export interface WorkspaceBoundaryCaps {
  /** Enumerated entries counted per protected root before the cap fails closed. */
  maxEntriesPerRoot?: number;
  /** Change records persisted in a comparison before the cap fails closed. */
  maxChanges?: number;
  /** Maximum length of an evidence path in characters. */
  maxPathLength?: number;
  /** Maximum length of diagnostic text in inspection errors. */
  maxDiagnosticLength?: number;
}

export interface WorkspaceBoundaryPolicy {
  /** Authority checkout root; must be an absolute path. */
  authorityRoot: string;
  /** Optional additional absolute roots protected in full. */
  extraRoots?: readonly string[];
  /**
   * Excluded paths. Relative entries apply to every protected root;
   * absolute entries must lie inside a protected root. Entries match the
   * path itself and, for directories, every descendant.
   */
  excludedPaths?: readonly string[];
  /** Configured ledger path; absolute, or relative to the authority root. */
  ledgerPath?: string;
  caps?: WorkspaceBoundaryCaps;
}

export type WorkspaceBoundaryEntryKind = "file" | "symlink" | "directory";
export type WorkspaceBoundaryChangeKind = "added" | "removed" | "modified";
export type WorkspaceBoundaryStatus = "clean" | "dirty" | "inspection_failed";

/** One snapshot entry. Digests are hashes only; content is never retained. */
export interface WorkspaceBoundarySnapshotEntry {
  kind: WorkspaceBoundaryEntryKind;
  /** Root-relative evidence-safe path, normalized to `/` separators. */
  path: string;
  /** SHA-256 hex of file content or of the symlink link target. */
  digest?: string;
}

/** In-memory-only snapshot; never persisted in this module. */
export interface WorkspaceBoundarySnapshot {
  /** Absolute protected roots in policy order (index 0 is the authority root). */
  readonly roots: readonly string[];
  /** Internal key to entry map; keys are `paddedRootIndex \0 relativePath`. */
  readonly entries: ReadonlyMap<string, WorkspaceBoundarySnapshotEntry>;
}

/** Bounded path-level change evidence; never contains file contents. */
export interface WorkspaceBoundaryChange {
  /** Index into the policy root list; 0 is the authority root. */
  rootIndex: number;
  change: WorkspaceBoundaryChangeKind;
  /** Kind of the entry in the after snapshot (or before snapshot for removals). */
  kind: WorkspaceBoundaryEntryKind;
  /** Root-relative normalized evidence path. */
  path: string;
  beforeDigest?: string;
  afterDigest?: string;
}

export type WorkspaceBoundaryComparison =
  | { status: "clean"; changes: [] }
  | { status: "dirty"; changes: WorkspaceBoundaryChange[] }
  | { status: "inspection_failed"; error: string; changes: WorkspaceBoundaryChange[] };

export class WorkspaceBoundaryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

export class WorkspaceBoundaryPolicyError extends WorkspaceBoundaryError {}

/** Raised when a root cannot be inspected or a safety cap is exceeded. */
export class WorkspaceBoundaryInspectionError extends WorkspaceBoundaryError {}

/**
 * Return a safe root-relative evidence path, or `undefined` when the value is
 * absolute, drive-qualified, traverses upward, contains control characters,
 * or is empty.
 */
export function normalizeEvidencePath(value: string): string | undefined {
  if (typeof value !== "string" || value.length === 0) return undefined;
  if (CONTROL_CHARACTER_PATTERN.test(value)) return undefined;

  const slashPath = value.replace(/\\/g, "/");
  if (
    slashPath.startsWith("/") ||
    slashPath.startsWith("//") ||
    /^[A-Za-z]:/.test(slashPath)
  ) {
    return undefined;
  }

  const segments = slashPath
    .split("/")
    .filter((segment) => segment.length > 0 && segment !== ".");
  if (segments.length === 0 || segments.includes("..")) return undefined;
  return segments.join("/");
}

/**
 * Bounded diagnostic text: control characters are replaced so error messages
 * can be persisted safely, and the result is truncated to `maxLength`.
 */
export function sanitizeDiagnosticText(value: unknown, maxLength: number): string {
  const text = typeof value === "string" ? value : String(value);
  const cleaned = text.replace(CONTROL_CHARACTER_PATTERN_GLOBAL, "\uFFFD");
  return cleaned.length <= maxLength ? cleaned : cleaned.slice(0, maxLength);
}

export interface ResolvedWorkspaceBoundaryPolicy {
  /** Absolute, deduplicated protected roots; index 0 is the authority root. */
  readonly roots: readonly string[];
  readonly rootExclusions: readonly RootExclusions[];
  readonly caps: Required<WorkspaceBoundaryCaps>;
}

export interface RootExclusions {
  /** Root-relative exclusion prefixes shared by every root. */
  readonly relative: readonly string[];
  /** Absolute exclusion prefixes applying to this root only. */
  readonly absolute: readonly string[];
}

/**
 * Validate and normalize a policy. Duplicate roots are removed, and a root
 * strictly inside an earlier root is dropped because the earlier root already
 * covers it. The authority root is always kept first.
 */
export function resolveWorkspaceBoundaryPolicy(
  policy: WorkspaceBoundaryPolicy,
): ResolvedWorkspaceBoundaryPolicy {
  if (policy === null || typeof policy !== "object") {
    throw new WorkspaceBoundaryPolicyError("policy must be an object");
  }
  const authorityRoot = resolveRootPath(policy.authorityRoot, "authorityRoot");
  if (policy.extraRoots !== undefined && !Array.isArray(policy.extraRoots)) {
    throw new WorkspaceBoundaryPolicyError("extraRoots must be an array");
  }
  const extraRoots = (policy.extraRoots ?? []).map((root, index) =>
    resolveRootPath(root, `extraRoots[${index}]`),
  );

  const roots: string[] = [authorityRoot];
  for (const extra of extraRoots) {
    const covered = roots.some(
      (root) => extra === root || extra.startsWith(`${root}${sep}`),
    );
    if (!covered) roots.push(extra);
  }

  const caps = resolveCaps(policy.caps);
  const rootExclusions = resolveRootExclusions(policy, roots);
  return { roots, rootExclusions, caps };
}

export interface TaskWorkspaceBoundaryPolicyInput {
  /** Absolute task worktree path; becomes the authority root. */
  worktreePath: string;
  /** Configured ledger path, when it lies inside the worktree. */
  ledgerPath?: string;
  /**
   * Contract write paths owned by the worker. They are excluded by absolute
   * path so legitimate task output is never reported as boundary evidence.
   * Write-path auditing remains the authority for those paths.
   */
  writePaths?: readonly string[];
}

/**
 * Build the authority policy for one task attempt
 * (design/self-host-worker-isolation-v0.md invariant 2).
 *
 * The authority snapshot targets the exact task worktree rather than the
 * repository root. The repository-root wave guard remains a separate
 * defense-in-depth check for the authority checkout. Contract write paths are
 * excluded per worktree, and build output under `dist/` is excluded by the
 * default control-path set.
 */
export function taskWorkspaceBoundaryPolicy(
  input: TaskWorkspaceBoundaryPolicyInput,
): WorkspaceBoundaryPolicy {
  const worktreePath = resolveRootPath(input.worktreePath, "worktreePath");
  const excluded = new Set<string>();
  for (const raw of input.writePaths ?? []) {
    if (typeof raw !== "string") continue;
    // A contract that owns the whole worktree has no path-level boundary
    // evidence; the worker path audit still applies.
    if (raw.replace(/[\\/]+$/, "") === ".") {
      excluded.add(worktreePath);
      continue;
    }
    const relativePath = normalizeEvidencePath(raw);
    if (relativePath === undefined) continue;
    excluded.add(join(worktreePath, relativePath));
  }
  return {
    authorityRoot: worktreePath,
    ...(input.ledgerPath !== undefined ? { ledgerPath: input.ledgerPath } : {}),
    ...(excluded.size > 0
      ? { excludedPaths: [...excluded].sort() }
      : {}),
  };
}

/**
 * Capture a full snapshot for every protected root. Throws
 * `WorkspaceBoundaryInspectionError` when any root cannot be read or any
 * configured safety cap is exceeded. The returned snapshot exists in memory
 * only and contains digests, never file contents.
 */
export async function captureWorkspaceBoundary(
  policy: WorkspaceBoundaryPolicy,
): Promise<WorkspaceBoundarySnapshot> {
  return captureResolved(resolveWorkspaceBoundaryPolicy(policy));
}

/**
 * Compare two snapshots and return bounded path-level change records.
 *
 * Added, removed and modified entries (files, symlinks and directories) are
 * detected; changes are ordered deterministically by (rootIndex, path). When
 * the snapshots disagree about the protected roots, contain unsafe evidence,
 * or produce more changes than `maxChanges`, the result is
 * `inspection_failed` rather than a clean or silently truncated answer.
 */
export function compareWorkspaceBoundary(
  before: WorkspaceBoundarySnapshot,
  after: WorkspaceBoundarySnapshot,
  options: { maxChanges?: number } = {},
): WorkspaceBoundaryComparison {
  const maxChanges = options.maxChanges ?? DEFAULT_MAX_CHANGES;
  if (!Number.isInteger(maxChanges) || maxChanges < 0) {
    throw new WorkspaceBoundaryPolicyError("maxChanges must be an integer >= 0");
  }
  if (!isSnapshot(before) || !isSnapshot(after)) {
    throw new WorkspaceBoundaryPolicyError(
      "before and after must be WorkspaceBoundarySnapshot objects",
    );
  }
  if (!sameRoots(before.roots, after.roots)) {
    return {
      status: "inspection_failed",
      error: "cannot compare snapshots over different protected roots",
      changes: [],
    };
  }
  const unsafe = validateSnapshot(before) ?? validateSnapshot(after);
  if (unsafe !== undefined) {
    return { status: "inspection_failed", error: unsafe, changes: [] };
  }

  const keys = new Set([...before.entries.keys(), ...after.entries.keys()]);
  const changes: WorkspaceBoundaryChange[] = [];
  for (const key of [...keys].sort()) {
    const previous = before.entries.get(key);
    const current = after.entries.get(key);
    if (previous === undefined && current !== undefined) {
      const change: WorkspaceBoundaryChange = {
        rootIndex: keyRootIndex(key),
        change: "added",
        kind: current.kind,
        path: current.path,
      };
      if (current.digest !== undefined) change.afterDigest = current.digest;
      changes.push(change);
    } else if (previous !== undefined && current === undefined) {
      const change: WorkspaceBoundaryChange = {
        rootIndex: keyRootIndex(key),
        change: "removed",
        kind: previous.kind,
        path: previous.path,
      };
      if (previous.digest !== undefined) change.beforeDigest = previous.digest;
      changes.push(change);
    } else if (
      previous !== undefined &&
      current !== undefined &&
      (previous.kind !== current.kind || previous.digest !== current.digest)
    ) {
      const change: WorkspaceBoundaryChange = {
        rootIndex: keyRootIndex(key),
        change: "modified",
        kind: current.kind,
        path: current.path,
      };
      if (previous.digest !== undefined) change.beforeDigest = previous.digest;
      if (current.digest !== undefined) change.afterDigest = current.digest;
      changes.push(change);
    }
  }

  if (changes.length === 0) return { status: "clean", changes: [] };
  if (changes.length > maxChanges) {
    return {
      status: "inspection_failed",
      error: `change record cap exceeded: ${changes.length} changes (maxChanges=${maxChanges})`,
      changes: changes.slice(0, maxChanges),
    };
  }
  return { status: "dirty", changes };
}

/**
 * Stateful capture/compare pair for a fixed policy. `capture` must complete
 * before worker work begins; `compare` recaptures the boundary afterwards and
 * fails closed (`inspection_failed`) when recapture or comparison fails.
 */
export class WorkspaceBoundaryGuard {
  private readonly resolved: ResolvedWorkspaceBoundaryPolicy;
  private snapshot: WorkspaceBoundarySnapshot | undefined;

  constructor(policy: WorkspaceBoundaryPolicy) {
    this.resolved = resolveWorkspaceBoundaryPolicy(policy);
  }

  /** Normalized, deduplicated protected roots (authority root first). */
  get roots(): readonly string[] {
    return this.resolved.roots;
  }

  get caps(): Required<WorkspaceBoundaryCaps> {
    return this.resolved.caps;
  }

  /** Throws `WorkspaceBoundaryInspectionError` when inspection fails. */
  async capture(): Promise<void> {
    this.snapshot = await captureResolved(this.resolved);
  }

  async compare(): Promise<WorkspaceBoundaryComparison> {
    const before = this.snapshot;
    if (before === undefined) {
      return {
        status: "inspection_failed",
        error: "workspace boundary snapshot has not been captured",
        changes: [],
      };
    }
    let after: WorkspaceBoundarySnapshot;
    try {
      after = await captureResolved(this.resolved);
    } catch (error) {
      return {
        status: "inspection_failed",
        error: inspectionMessage(error, this.resolved.caps.maxDiagnosticLength),
        changes: [],
      };
    }
    return compareWorkspaceBoundary(before, after, {
      maxChanges: this.resolved.caps.maxChanges,
    });
  }
}

async function captureResolved(
  resolved: ResolvedWorkspaceBoundaryPolicy,
): Promise<WorkspaceBoundarySnapshot> {
  const entries = new Map<string, WorkspaceBoundarySnapshotEntry>();
  for (let rootIndex = 0; rootIndex < resolved.roots.length; rootIndex += 1) {
    const rootEntries = await walkRoot(
      resolved.roots[rootIndex],
      rootIndex,
      resolved.rootExclusions[rootIndex],
      resolved.caps,
    );
    for (const [key, entry] of rootEntries) entries.set(key, entry);
  }
  return { roots: [...resolved.roots], entries: new Map(entries) };
}

interface WalkState {
  /** Enumerated dirents counted per root, including excluded entries. */
  count: number;
}

async function walkRoot(
  root: string,
  rootIndex: number,
  exclusions: RootExclusions,
  caps: Required<WorkspaceBoundaryCaps>,
): Promise<Map<string, WorkspaceBoundarySnapshotEntry>> {
  const entries = new Map<string, WorkspaceBoundarySnapshotEntry>();
  const state: WalkState = { count: 0 };
  let rootStats;
  try {
    rootStats = await lstat(root);
  } catch (error) {
    throw toInspectionError(caps, "inspect protected root", root, error);
  }
  if (!rootStats.isDirectory()) {
    throw new WorkspaceBoundaryInspectionError(
      sanitizeDiagnosticText(
        `protected root is not a directory: ${root}`,
        caps.maxDiagnosticLength,
      ),
    );
  }
  await walkDirectory(root, "", rootIndex, exclusions, caps, entries, state);
  return entries;
}

async function walkDirectory(
  absDir: string,
  relDir: string,
  rootIndex: number,
  exclusions: RootExclusions,
  caps: Required<WorkspaceBoundaryCaps>,
  entries: Map<string, WorkspaceBoundarySnapshotEntry>,
  state: WalkState,
): Promise<void> {
  let dirHandle: Dir;
  try {
    dirHandle = await opendir(absDir);
  } catch (error) {
    throw toInspectionError(caps, "inspect protected root", absDir, error);
  }

  const dirents: Dirent[] = [];
  try {
    for await (const dirent of dirHandle) {
      state.count += 1;
      if (state.count > caps.maxEntriesPerRoot) {
        throw new WorkspaceBoundaryInspectionError(
          `protected root entry cap exceeded (maxEntriesPerRoot=${caps.maxEntriesPerRoot})`,
        );
      }
      dirents.push(dirent);
    }
  } catch (error) {
    await dirHandle.close().catch(() => undefined);
    if (error instanceof WorkspaceBoundaryInspectionError) throw error;
    throw toInspectionError(caps, "enumerate directory", absDir, error);
  }
  await dirHandle.close().catch(() => undefined);

  dirents.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const dirent of dirents) {
    const relPath = relDir === "" ? dirent.name : `${relDir}/${dirent.name}`;
    const absPath = join(absDir, dirent.name);

    // Excluded entries are never inspected: they are not classified, hashed
    // or recursed into, so a FIFO, socket or unreadable file under a mutable
    // control-plane path cannot fail the inspection. Excluded containers such
    // as `.cliyard` are traversed without being recorded so protected
    // descendants (RunManifests) can still be compared.
    const protection = entryProtection(absPath, relPath, exclusions);
    if (protection === "skip") continue;
    if (protection === "recurse") {
      if (dirent.isDirectory()) {
        await walkDirectory(absPath, relPath, rootIndex, exclusions, caps, entries, state);
      }
      continue;
    }

    if (CONTROL_CHARACTER_PATTERN.test(dirent.name)) {
      throw new WorkspaceBoundaryInspectionError(
        sanitizeDiagnosticText(
          `unsafe entry name in protected root ${absDir}: control characters are not evidence-safe`,
          caps.maxDiagnosticLength,
        ),
      );
    }
    if (relPath.length > caps.maxPathLength) {
      throw new WorkspaceBoundaryInspectionError(
        `entry path exceeds cap (maxPathLength=${caps.maxPathLength})`,
      );
    }
    const kind = await classifyEntry(absPath, dirent, caps);

    const entry: WorkspaceBoundarySnapshotEntry = { kind, path: relPath };
    if (kind === "file") entry.digest = await hashFile(absPath, caps);
    if (kind === "symlink") entry.digest = await hashLinkTarget(absPath, caps);
    entries.set(entryKey(rootIndex, relPath), entry);

    if (kind === "directory") {
      await walkDirectory(absPath, relPath, rootIndex, exclusions, caps, entries, state);
    }
  }
}

async function classifyEntry(
  absPath: string,
  dirent: Dirent,
  caps: Required<WorkspaceBoundaryCaps>,
): Promise<WorkspaceBoundaryEntryKind> {
  if (dirent.isFile()) return "file";
  if (dirent.isDirectory()) return "directory";
  if (dirent.isSymbolicLink()) return "symlink";

  let stats;
  try {
    stats = await lstat(absPath);
  } catch (error) {
    throw toInspectionError(caps, "stat entry", absPath, error);
  }
  if (stats.isFile()) return "file";
  if (stats.isDirectory()) return "directory";
  if (stats.isSymbolicLink()) return "symlink";
  throw new WorkspaceBoundaryInspectionError(
    sanitizeDiagnosticText(
      `unsupported entry type in protected root: ${absPath}`,
      caps.maxDiagnosticLength,
    ),
  );
}

type EntryProtection = "include" | "recurse" | "skip";

/**
 * Classify a dirent for the walk. Important Git state wins over the `.git`
 * exclusion. The `.cliyard` exclusion is wholesale for mutable control state,
 * but the container and the runs directory are traversed so RunManifest
 * authority files stay protected.
 */
function entryProtection(
  absPath: string,
  relPath: string,
  exclusions: RootExclusions,
): EntryProtection {
  if (isGitStatePath(relPath)) return "include";
  for (const exclusion of exclusions.absolute) {
    if (absPath === exclusion || absPath.startsWith(`${exclusion}${sep}`)) {
      return "skip";
    }
  }
  let controlStateExcluded = false;
  for (const exclusion of exclusions.relative) {
    if (relPath === exclusion || relPath.startsWith(`${exclusion}/`)) {
      // A caller-provided exclusion narrower than the default `.cliyard`
      // entry still wins; the RunManifest re-inclusion is only a default.
      if (exclusion !== ".cliyard") return "skip";
      controlStateExcluded = true;
    }
  }
  if (controlStateExcluded) {
    if (EXCLUDED_TRAVERSAL_PATHS.includes(relPath)) return "recurse";
    if (RUN_MANIFEST_PATH_PATTERN.test(relPath)) return "include";
    return "skip";
  }
  return "include";
}

function isGitStatePath(relPath: string): boolean {
  if (relPath === ".git") return true;
  return (
    DEFAULT_GIT_STATE_PATHS.includes(relPath) ||
    relPath.startsWith(".git/hooks/") ||
    relPath.startsWith(".git/refs/")
  );
}

function hashFile(
  absPath: string,
  caps: Required<WorkspaceBoundaryCaps>,
): Promise<string> {
  return new Promise<string>((resolveHash, rejectHash) => {
    const hash = createHash("sha256");
    const stream = createReadStream(absPath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", (error) =>
      rejectHash(toInspectionError(caps, "read file", absPath, error)),
    );
    stream.on("end", () => resolveHash(hash.digest("hex")));
  });
}

async function hashLinkTarget(
  absPath: string,
  caps: Required<WorkspaceBoundaryCaps>,
): Promise<string> {
  let target: string;
  try {
    target = await readlink(absPath);
  } catch (error) {
    throw toInspectionError(caps, "read symlink", absPath, error);
  }
  return createHash("sha256").update(target, "utf8").digest("hex");
}

function toInspectionError(
  caps: Required<WorkspaceBoundaryCaps>,
  action: string,
  target: string,
  error: unknown,
): WorkspaceBoundaryInspectionError {
  const errno = (error as NodeJS.ErrnoException | undefined)?.code;
  const detail = error instanceof Error ? error.message : String(error);
  const codePart = typeof errno === "string" && errno !== "" ? `: ${errno}` : "";
  return new WorkspaceBoundaryInspectionError(
    sanitizeDiagnosticText(
      `cannot ${action} ${target}${codePart}: ${detail}`,
      caps.maxDiagnosticLength,
    ),
  );
}

function inspectionMessage(error: unknown, maxLength: number): string {
  if (error instanceof WorkspaceBoundaryInspectionError) {
    return sanitizeDiagnosticText(error.message, maxLength);
  }
  return sanitizeDiagnosticText(error, maxLength);
}

function entryKey(rootIndex: number, relPath: string): string {
  return `${String(rootIndex).padStart(6, "0")}\u0000${relPath}`;
}

function keyRootIndex(key: string): number {
  const separator = key.indexOf("\u0000");
  return separator === -1 ? Number.NaN : Number(key.slice(0, separator));
}

function resolveRootPath(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new WorkspaceBoundaryPolicyError(`${label} must be a non-empty string`);
  }
  if (CONTROL_CHARACTER_PATTERN.test(value)) {
    throw new WorkspaceBoundaryPolicyError(
      `${label} must not contain control characters`,
    );
  }
  if (!isAbsolute(value)) {
    throw new WorkspaceBoundaryPolicyError(`${label} must be an absolute path`);
  }
  return resolve(value);
}

function resolveCaps(
  caps: WorkspaceBoundaryCaps | undefined,
): Required<WorkspaceBoundaryCaps> {
  const source = caps ?? {};
  if (typeof source !== "object" || source === null) {
    throw new WorkspaceBoundaryPolicyError("caps must be an object");
  }
  return {
    maxEntriesPerRoot: capValue(
      source.maxEntriesPerRoot,
      "maxEntriesPerRoot",
      DEFAULT_MAX_ENTRIES_PER_ROOT,
      1,
    ),
    maxChanges: capValue(source.maxChanges, "maxChanges", DEFAULT_MAX_CHANGES, 0),
    maxPathLength: capValue(
      source.maxPathLength,
      "maxPathLength",
      DEFAULT_MAX_PATH_LENGTH,
      1,
    ),
    maxDiagnosticLength: capValue(
      source.maxDiagnosticLength,
      "maxDiagnosticLength",
      DEFAULT_MAX_DIAGNOSTIC_LENGTH,
      0,
    ),
  };
}

function capValue(
  value: number | undefined,
  label: string,
  fallback: number,
  minimum: number,
): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < minimum) {
    throw new WorkspaceBoundaryPolicyError(
      `${label} must be an integer >= ${minimum}`,
    );
  }
  return value;
}

function resolveRootExclusions(
  policy: WorkspaceBoundaryPolicy,
  roots: readonly string[],
): RootExclusions[] {
  const relative = new Set<string>(DEFAULT_EXCLUDED_CONTROL_PATHS);
  const absolute = new Set<string>();

  for (const raw of policy.excludedPaths ?? []) {
    if (typeof raw !== "string" || raw.trim() === "") {
      throw new WorkspaceBoundaryPolicyError(
        "excludedPaths entries must be non-empty strings",
      );
    }
    if (CONTROL_CHARACTER_PATTERN.test(raw)) {
      throw new WorkspaceBoundaryPolicyError(
        "excluded paths must not contain control characters",
      );
    }
    if (isAbsolute(raw)) {
      const absPath = resolve(raw);
      if (
        !roots.some(
          (root) => absPath === root || absPath.startsWith(`${root}${sep}`),
        )
      ) {
        throw new WorkspaceBoundaryPolicyError(
          `absolute excluded path ${JSON.stringify(raw)} is not inside a protected root`,
        );
      }
      absolute.add(absPath);
      continue;
    }
    const relPath = normalizeEvidencePath(raw);
    if (relPath === undefined) {
      throw new WorkspaceBoundaryPolicyError(
        `excluded path ${JSON.stringify(raw)} must be a safe relative path`,
      );
    }
    relative.add(relPath);
  }

  const ledger = resolveLedgerPath(policy.ledgerPath, roots[0]);
  if (
    ledger !== undefined &&
    roots.some((root) => ledger === root || ledger.startsWith(`${root}${sep}`))
  ) {
    // A configured ledger outside every protected root is a no-op exclusion.
    absolute.add(ledger);
  }

  const relativeSorted = [...relative].sort();
  const absoluteSorted = [...absolute].sort();
  return roots.map((root) => ({
    relative: relativeSorted,
    absolute: absoluteSorted.filter(
      (absPath) => absPath === root || absPath.startsWith(`${root}${sep}`),
    ),
  }));
}

function resolveLedgerPath(
  value: unknown,
  authorityRoot: string,
): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.trim() === "") {
    throw new WorkspaceBoundaryPolicyError("ledgerPath must be a non-empty string");
  }
  if (CONTROL_CHARACTER_PATTERN.test(value)) {
    throw new WorkspaceBoundaryPolicyError(
      "ledgerPath must not contain control characters",
    );
  }
  return isAbsolute(value) ? resolve(value) : resolve(join(authorityRoot, value));
}

function isSnapshot(value: unknown): value is WorkspaceBoundarySnapshot {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<WorkspaceBoundarySnapshot>;
  return (
    Array.isArray(candidate.roots) &&
    candidate.entries instanceof Map &&
    candidate.roots.every((root) => typeof root === "string")
  );
}

function sameRoots(a: readonly string[], b: readonly string[]): boolean {
  return (
    a.length === b.length && a.every((root, index) => root === b[index])
  );
}

/** Returns a bounded reason when snapshot evidence is not safe to expose. */
function validateSnapshot(snapshot: WorkspaceBoundarySnapshot): string | undefined {
  const rootCount = snapshot.roots.length;
  for (const [key, entry] of snapshot.entries) {
    // A caller-supplied Map can contain anything at runtime; malformed values
    // must produce bounded evidence, never an uncontrolled TypeError.
    if (typeof key !== "string") return "unsafe snapshot entry key";
    if (entry === null || typeof entry !== "object") {
      return "invalid snapshot entry value";
    }
    const separator = key.indexOf("\u0000");
    if (separator <= 0) return "unsafe snapshot entry key";
    const rootIndex = Number(key.slice(0, separator));
    if (
      !Number.isInteger(rootIndex) ||
      rootIndex < 0 ||
      rootIndex >= rootCount ||
      entry.path !== key.slice(separator + 1)
    ) {
      return "snapshot entry does not match its protected root";
    }
    if (
      typeof entry.kind !== "string" ||
      (entry.kind !== "file" &&
        entry.kind !== "symlink" &&
        entry.kind !== "directory")
    ) {
      return "unsupported snapshot entry kind";
    }
    if (normalizeEvidencePath(entry.path) !== entry.path) {
      return `unsafe snapshot entry path ${JSON.stringify(entry.path)}`;
    }
    const needsDigest = entry.kind === "file" || entry.kind === "symlink";
    if (needsDigest && !isDigest(entry.digest)) {
      return `missing content digest for snapshot entry ${JSON.stringify(entry.path)}`;
    }
    if (!needsDigest && entry.digest !== undefined) {
      return `unexpected digest for directory entry ${JSON.stringify(entry.path)}`;
    }
  }
  return undefined;
}

function isDigest(value: unknown): value is string {
  return typeof value === "string" && SHA256_HEX_PATTERN.test(value);
}

/**
 * Canonical control-plane StateStore paths
 * (design/statestore-path-unify-v0.md).
 *
 * One durable authority for run + queue + ledger + audit-event domains:
 * `.cliyard/state.db` (SQLite) with `.cliyard/state-evidence/` and a JSON-file
 * fallback under `.cliyard/state-fallback/`.
 *
 * Legacy supervisor/daemon layout under `.cliyard/runtime/statestore/` is
 * relocated once when it is the only durable authority; dual authorities fail
 * closed.
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { StateStoreCorruptionError } from "./store.js";

export const CONTROL_PLANE_DIR = ".cliyard";

/** Canonical SQLite authority file (queue layout; also used by supervisor). */
export const CONTROL_STATE_DB_FILE = "state.db";
export const CONTROL_STATE_EVIDENCE_DIR = "state-evidence";
export const CONTROL_STATE_FALLBACK_DIR = "state-fallback";
export const CONTROL_STATE_FALLBACK_FACTS_FILE = "facts.json";
export const CONTROL_STATE_FALLBACK_LOCK_FILE = "facts.lock";

/**
 * Pre-unify supervisor/daemon layout. Kept as constants for relocate and
 * dual-authority detection only — new opens must not write here.
 */
export const LEGACY_SUPERVISOR_STATE_DIR = "runtime/statestore";
export const LEGACY_SUPERVISOR_SQLITE_FILE = "state.sqlite";
export const LEGACY_SUPERVISOR_FACTS_FILE = "facts.json";
export const LEGACY_SUPERVISOR_EVIDENCE_DIR = "evidence";
export const LEGACY_RELOCATED_MARKER_FILE = "RELOCATED.json";

export const CONTROL_STATE_PATHS_VERSION = 1 as const;

export interface ControlStatePaths {
  repoRoot: string;
  cliyardDir: string;
  /** Directory that holds the SQLite file when present (`.cliyard`). */
  stateDir: string;
  dbPath: string;
  evidenceDir: string;
  fallbackDir: string;
  fallbackFactsPath: string;
  fallbackLockPath: string;
  /** Legacy supervisor state directory (detection / relocate only). */
  legacyStateDir: string;
  legacySqlitePath: string;
  legacyFactsPath: string;
  legacyEvidenceDir: string;
  legacyRelocatedMarkerPath: string;
}

export interface ControlStateResolveResult {
  paths: ControlStatePaths;
  /** True when this call performed a one-shot legacy → canonical relocate. */
  relocated: boolean;
}

export interface LegacyRelocateMarker {
  version: typeof CONTROL_STATE_PATHS_VERSION;
  relocatedAt: string;
  from: {
    sqlitePath: string | null;
    factsPath: string | null;
    evidenceDir: string | null;
  };
  to: {
    dbPath: string | null;
    fallbackFactsPath: string | null;
    evidenceDir: string | null;
  };
}

export function controlStatePaths(repoRoot: string): ControlStatePaths {
  const root = resolve(repoRoot);
  const cliyardDir = join(root, CONTROL_PLANE_DIR);
  const fallbackDir = join(cliyardDir, CONTROL_STATE_FALLBACK_DIR);
  const legacyStateDir = join(cliyardDir, LEGACY_SUPERVISOR_STATE_DIR);
  return {
    repoRoot: root,
    cliyardDir,
    stateDir: cliyardDir,
    dbPath: join(cliyardDir, CONTROL_STATE_DB_FILE),
    evidenceDir: join(cliyardDir, CONTROL_STATE_EVIDENCE_DIR),
    fallbackDir,
    fallbackFactsPath: join(fallbackDir, CONTROL_STATE_FALLBACK_FACTS_FILE),
    fallbackLockPath: join(fallbackDir, CONTROL_STATE_FALLBACK_LOCK_FILE),
    legacyStateDir,
    legacySqlitePath: join(legacyStateDir, LEGACY_SUPERVISOR_SQLITE_FILE),
    legacyFactsPath: join(legacyStateDir, LEGACY_SUPERVISOR_FACTS_FILE),
    legacyEvidenceDir: join(legacyStateDir, LEGACY_SUPERVISOR_EVIDENCE_DIR),
    legacyRelocatedMarkerPath: join(
      legacyStateDir,
      LEGACY_RELOCATED_MARKER_FILE,
    ),
  };
}

function pathExists(path: string): boolean {
  return existsSync(path);
}

function isNonEmptyFile(path: string): boolean {
  if (!pathExists(path)) return false;
  try {
    return statSync(path).isFile() && statSync(path).size > 0;
  } catch {
    return false;
  }
}

function isNonEmptyDir(path: string): boolean {
  if (!pathExists(path)) return false;
  try {
    const st = statSync(path);
    if (!st.isDirectory()) return false;
    // Presence of the directory after a prior write is enough — evidence may
    // be empty briefly, but we only treat it as authority when paired with a
    // durable fact log (checked by the caller).
    return true;
  } catch {
    return false;
  }
}

function hasCanonicalAuthority(paths: ControlStatePaths): boolean {
  return (
    isNonEmptyFile(paths.dbPath) || isNonEmptyFile(paths.fallbackFactsPath)
  );
}

function hasLegacyAuthority(paths: ControlStatePaths): boolean {
  if (pathExists(paths.legacyRelocatedMarkerPath)) {
    // Relocate already completed; leftover empty dirs are not an authority.
    return false;
  }
  return (
    isNonEmptyFile(paths.legacySqlitePath) ||
    isNonEmptyFile(paths.legacyFactsPath)
  );
}

function ensureParentDir(path: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
}

function movePath(from: string, to: string): void {
  ensureParentDir(to);
  if (pathExists(to)) {
    throw new StateStoreCorruptionError(
      `cannot relocate ${from} onto existing ${to} (needs human)`,
    );
  }
  renameSync(from, to);
}

/**
 * Resolve the single control StateStore layout for `repoRoot`.
 *
 * - Only legacy present → one-shot relocate into the canonical layout.
 * - Both present → fail closed.
 * - Only canonical / neither → return canonical paths unchanged.
 */
export function resolveControlStatePaths(
  repoRoot: string,
  options: { now?: () => string } = {},
): ControlStateResolveResult {
  const paths = controlStatePaths(repoRoot);
  const canonical = hasCanonicalAuthority(paths);
  const legacy = hasLegacyAuthority(paths);

  if (canonical && legacy) {
    throw new StateStoreCorruptionError(
      `both ${paths.dbPath} (or fallback) and legacy ` +
        `${paths.legacyStateDir} hold durable StateStore bytes; refusing to ` +
        "choose between two authorities (needs human)",
    );
  }

  if (!legacy) {
    return { paths, relocated: false };
  }

  const now = options.now?.() ?? new Date().toISOString();
  const from = {
    sqlitePath: isNonEmptyFile(paths.legacySqlitePath)
      ? paths.legacySqlitePath
      : null,
    factsPath: isNonEmptyFile(paths.legacyFactsPath)
      ? paths.legacyFactsPath
      : null,
    evidenceDir: isNonEmptyDir(paths.legacyEvidenceDir)
      ? paths.legacyEvidenceDir
      : null,
  };
  const to = {
    dbPath: null as string | null,
    fallbackFactsPath: null as string | null,
    evidenceDir: null as string | null,
  };

  mkdirSync(paths.cliyardDir, { recursive: true, mode: 0o700 });

  if (from.sqlitePath !== null) {
    movePath(from.sqlitePath, paths.dbPath);
    to.dbPath = paths.dbPath;
  }
  if (from.factsPath !== null) {
    movePath(from.factsPath, paths.fallbackFactsPath);
    to.fallbackFactsPath = paths.fallbackFactsPath;
  }
  if (from.evidenceDir !== null) {
    if (pathExists(paths.evidenceDir)) {
      // Canonical evidence already exists without a fact log — refuse rather
      // than merge opaque object stores.
      throw new StateStoreCorruptionError(
        `cannot relocate legacy evidence onto existing ${paths.evidenceDir} ` +
          "(needs human)",
      );
    }
    movePath(from.evidenceDir, paths.evidenceDir);
    to.evidenceDir = paths.evidenceDir;
  }

  const marker: LegacyRelocateMarker = {
    version: CONTROL_STATE_PATHS_VERSION,
    relocatedAt: now,
    from,
    to,
  };
  mkdirSync(paths.legacyStateDir, { recursive: true, mode: 0o700 });
  writeFileSync(
    paths.legacyRelocatedMarkerPath,
    `${JSON.stringify(marker, null, 2)}\n`,
    "utf8",
  );

  // Drop an empty leftover legacy directory tree when safe (marker remains).
  try {
    if (pathExists(paths.legacySqlitePath)) rmSync(paths.legacySqlitePath);
    if (pathExists(paths.legacyFactsPath)) rmSync(paths.legacyFactsPath);
  } catch {
    /* marker is the durable record; leftover empty files are non-authority */
  }

  return { paths, relocated: true };
}

/** Read the relocate marker when present (tests / diagnostics). */
export function readLegacyRelocateMarker(
  repoRoot: string,
): LegacyRelocateMarker | null {
  const path = controlStatePaths(repoRoot).legacyRelocatedMarkerPath;
  if (!pathExists(path)) return null;
  const raw = JSON.parse(readFileSync(path, "utf8")) as LegacyRelocateMarker;
  return raw;
}

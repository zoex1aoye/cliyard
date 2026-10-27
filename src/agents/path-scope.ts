/**
 * Pure path-scope evidence for worker changes.
 *
 * This is deliberately independent of verifier and acceptance policy. It
 * normalizes repository-relative separators, rejects unsafe paths, and reports
 * bounded evidence that can be checkpointed after any worker exit.
 */

export const DEFAULT_MAX_PATH_SCOPE_PATHS = 128;

export interface PathScopeAudit {
  /** Changed paths with repository-relative separators normalized to `/`. */
  changedPaths: string[];
  /** Changed paths which are unsafe or outside the declared write scope. */
  outsideWritePaths: string[];
}

export interface PathScopeAuditOptions {
  /** Maximum number of entries retained in each evidence list. */
  maxPaths?: number;
}

/**
 * Audit changed paths against contract write paths.
 *
 * A write path allows an exact match. A write path with a trailing `/` or `\`
 * is directory-like and also allows descendants. Absolute paths, backslash
 * rooted paths, drive-qualified paths, NULs, and any `..` segment are rejected
 * even when they would otherwise string-match a scope.
 */
export function auditPathScope(
  writePaths: readonly string[],
  changedPaths: readonly string[],
  options: PathScopeAuditOptions = {},
): PathScopeAudit {
  const maxPaths = normalizeMaxPaths(options.maxPaths);
  const scopes = writePaths.flatMap((writePath) => {
    const normalized = normalizeRepositoryRelativePath(writePath);
    if (!normalized) return [];
    return [
      {
        path: normalized,
        directoryLike: /[\\/]$/.test(writePath),
      },
    ];
  });

  const changed = new Set<string>();
  const outside = new Set<string>();
  for (const changedPath of changedPaths) {
    const normalized = normalizeRepositoryRelativePath(changedPath);
    const evidence = normalized ?? pathEvidence(changedPath);
    changed.add(evidence);

    if (
      !normalized ||
      !scopes.some(
        (scope) =>
          normalized === scope.path ||
          (scope.directoryLike &&
            normalized.startsWith(`${scope.path}/`)),
      )
    ) {
      outside.add(evidence);
    }
  }

  return {
    changedPaths: [...changed].slice(0, maxPaths),
    outsideWritePaths: [...outside].slice(0, maxPaths),
  };
}

/** Descriptive alias for callers that frame the operation around changes. */
export const auditChangedPaths = auditPathScope;

/**
 * Return a safe repository-relative path, or `undefined` when the path is
 * absolute, traverses upward, or is otherwise not representable as a non-empty
 * repository-relative path.
 */
export function normalizeRepositoryRelativePath(
  value: string,
): string | undefined {
  if (typeof value !== "string" || value.includes("\0")) return undefined;

  const slashPath = value.replace(/\\/g, "/");
  if (
    slashPath.startsWith("/") ||
    /^[A-Za-z]:/.test(slashPath) ||
    slashPath.startsWith("//")
  ) {
    return undefined;
  }

  const segments = slashPath
    .split("/")
    .filter((segment) => segment.length > 0 && segment !== ".");
  if (segments.length === 0 || segments.includes("..")) return undefined;
  return segments.join("/");
}

function pathEvidence(value: string): string {
  if (value === "") return ".";
  return value.replace(/\\/g, "/").replace(/\0/g, "\\0");
}

function normalizeMaxPaths(value: number | undefined): number {
  if (value === undefined) return DEFAULT_MAX_PATH_SCOPE_PATHS;
  if (!Number.isInteger(value) || value < 0) {
    throw new Error("maxPaths must be a non-negative integer");
  }
  return value;
}

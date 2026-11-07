/**
 * Hierarchical admission: conjunctive min across scopes
 * (design/profile-catalog-admission-v0.md).
 */
import {
  UNKNOWN_EXECUTION_PROFILE_PERMIT,
  type HierarchicalAdmissionDecision,
  type HierarchicalAdmissionRequest,
  type ProfileBindingCapacity,
} from "./types.js";

function remainingOf(limit: number | null, inUse: number): number | null {
  if (limit === null) return null;
  return Math.max(0, limit - inUse);
}

/**
 * Resolve the effective permit for a catalog binding.
 * Unknown / null configuredMax ⇒ UNKNOWN_EXECUTION_PROFILE_PERMIT (1).
 */
export function effectiveProfilePermit(
  capacity: ProfileBindingCapacity | undefined,
): number {
  if (!capacity || capacity.configuredMax === null) {
    return UNKNOWN_EXECUTION_PROFILE_PERMIT;
  }
  return capacity.configuredMax;
}

/**
 * Conjunctive hierarchical admission.
 * Missing/null limits never become infinity — they contribute an explanatory
 * block rather than raising capacity. Known limits use remaining = limit - inUse;
 * the effective remaining is the min across scopes that have a finite limit.
 */
export function admitHierarchical(
  request: HierarchicalAdmissionRequest,
): HierarchicalAdmissionDecision {
  const units =
    request.request === undefined || request.request === null
      ? 1
      : request.request;
  const reasons: string[] = [];

  if (
    typeof units !== "number" ||
    !Number.isInteger(units) ||
    units < 1
  ) {
    return {
      admitted: false,
      request: Number.isFinite(units as number) ? (units as number) : 0,
      effective: null,
      limitingScope: null,
      remaining: null,
      reasons: ["request must be a positive integer"],
    };
  }

  if (!Array.isArray(request.scopes) || request.scopes.length === 0) {
    return {
      admitted: false,
      request: units,
      effective: null,
      limitingScope: null,
      remaining: null,
      reasons: ["at least one admission scope is required"],
    };
  }

  let effective: number | null = null;
  let limitingScope: HierarchicalAdmissionDecision["limitingScope"] = null;
  let anyFinite = false;

  for (const scope of request.scopes) {
    if (
      typeof scope.inUse !== "number" ||
      !Number.isInteger(scope.inUse) ||
      scope.inUse < 0
    ) {
      reasons.push(`${scope.name}: invalid inUse`);
      return {
        admitted: false,
        request: units,
        effective: null,
        limitingScope: scope.name,
        remaining: null,
        reasons,
      };
    }

    if (scope.limit === null) {
      reasons.push(
        `${scope.name}: limit unknown — not treated as infinity (probe/block only)`,
      );
      continue;
    }

    if (
      typeof scope.limit !== "number" ||
      !Number.isInteger(scope.limit) ||
      scope.limit < 0
    ) {
      reasons.push(`${scope.name}: invalid limit`);
      return {
        admitted: false,
        request: units,
        effective: null,
        limitingScope: scope.name,
        remaining: null,
        reasons,
      };
    }

    anyFinite = true;
    const rem = remainingOf(scope.limit, scope.inUse)!;
    reasons.push(
      `${scope.name}: limit=${scope.limit} inUse=${scope.inUse} remaining=${rem}`,
    );
    if (effective === null || rem < effective) {
      effective = rem;
      limitingScope = scope.name;
    }
  }

  if (!anyFinite) {
    reasons.push(
      "no finite scope limit — admission blocked (unknown ≠ unlimited)",
    );
    return {
      admitted: false,
      request: units,
      effective: null,
      limitingScope: null,
      remaining: null,
      reasons,
    };
  }

  const remaining = effective ?? 0;
  const admitted = remaining >= units;
  if (!admitted) {
    reasons.push(
      `denied: need ${units}, effective remaining ${remaining} (limited by ${limitingScope})`,
    );
  } else {
    reasons.push(
      `admitted: need ${units}, effective remaining ${remaining} (limited by ${limitingScope})`,
    );
  }

  return {
    admitted,
    request: units,
    effective: remaining,
    limitingScope,
    remaining,
    reasons,
  };
}

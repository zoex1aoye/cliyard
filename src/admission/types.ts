/**
 * ProfileCatalog and hierarchical admission shapes
 * (design/profile-catalog-admission-v0.md).
 */
import type { ExecutionProfile } from "../execution/profile.js";

export const PROFILE_CATALOG_VERSION = 1 as const;
export const UNKNOWN_EXECUTION_PROFILE_PERMIT = 1 as const;

export type BindingLimitSource =
  | "operator"
  | "provider-reported"
  | "observed"
  | "unknown";

export interface ProfileBindingCapacity {
  profileId: string;
  /** null means unknown — effective permit is UNKNOWN_EXECUTION_PROFILE_PERMIT. */
  configuredMax: number | null;
  limitSource: BindingLimitSource;
  inFlight: number;
}

export interface ProfileCatalogRecord {
  version: typeof PROFILE_CATALOG_VERSION;
  updatedAt: string;
  profiles: ExecutionProfile[];
  capacities: ProfileBindingCapacity[];
}

export type AdmissionScopeName =
  | "globalTasks"
  | "itemTasks"
  | "profilePermit"
  | "hostCpu"
  | "hostMemory";

export interface AdmissionScopeLimit {
  name: AdmissionScopeName;
  limit: number | null;
  inUse: number;
}

export interface HierarchicalAdmissionRequest {
  scopes: AdmissionScopeLimit[];
  /** Units requested (default 1). */
  request?: number;
}

export interface HierarchicalAdmissionDecision {
  admitted: boolean;
  request: number;
  effective: number | null;
  limitingScope: AdmissionScopeName | null;
  remaining: number | null;
  reasons: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function isProfileBindingCapacity(
  value: unknown,
): value is ProfileBindingCapacity {
  if (!isRecord(value)) return false;
  if (typeof value.profileId !== "string" || value.profileId.trim() === "") {
    return false;
  }
  if (
    value.configuredMax !== null &&
    (typeof value.configuredMax !== "number" ||
      !Number.isInteger(value.configuredMax) ||
      value.configuredMax < 1)
  ) {
    return false;
  }
  if (
    value.limitSource !== "operator" &&
    value.limitSource !== "provider-reported" &&
    value.limitSource !== "observed" &&
    value.limitSource !== "unknown"
  ) {
    return false;
  }
  if (
    typeof value.inFlight !== "number" ||
    !Number.isInteger(value.inFlight) ||
    value.inFlight < 0
  ) {
    return false;
  }
  return true;
}

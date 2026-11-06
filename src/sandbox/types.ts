/**
 * SandboxAdapter shared types (design/sandbox-adapter-nono-v0.md).
 *
 * Capability ranks mirror ExecutionSupervisor: full > partial > unsupported.
 * A non-empty capability gap means refuse or escalate to a human — never
 * silently run with host privileges when isolation was required.
 */
export const SANDBOX_BACKEND_TYPES = [
  "nono",
  "unavailable",
  "mock",
] as const;
export type SandboxBackendType = (typeof SANDBOX_BACKEND_TYPES)[number];

export const SANDBOX_CAPABILITY_SUPPORT = [
  "full",
  "partial",
  "unsupported",
] as const;
export type SandboxCapabilitySupport =
  (typeof SANDBOX_CAPABILITY_SUPPORT)[number];

export const MAX_SANDBOX_NOTES = 16;
export const MAX_SANDBOX_NOTE_LENGTH = 240;
export const MAX_SANDBOX_POLICY_HASH_LENGTH = 128;
export const MAX_SANDBOX_VERSION_LENGTH = 64;
export const MAX_SANDBOX_DETAIL_LENGTH = 2_000;
export const MAX_SANDBOX_VIOLATIONS = 64;
export const MAX_SANDBOX_VIOLATION_LENGTH = 512;

export const SANDBOX_REPORT_VERSION = 1 as const;

export interface SandboxCapabilities {
  backendType: SandboxBackendType;
  /** Pinned or discovered backend version; null when unavailable. */
  backendVersion: string | null;
  filesystemIsolation: SandboxCapabilitySupport;
  networkIsolation: SandboxCapabilitySupport;
  credentialIsolation: SandboxCapabilitySupport;
  /** Bounded operator notes. Never secrets. */
  notes: readonly string[];
}

export interface SandboxRequirements {
  filesystemIsolation?: SandboxCapabilitySupport;
  networkIsolation?: SandboxCapabilitySupport;
  credentialIsolation?: SandboxCapabilitySupport;
}

export type SandboxReportStatus =
  | "prepared"
  | "refused"
  | "unavailable"
  | "violation"
  | "released";

/**
 * Observational sandbox evidence. Never grants acceptance, merge or path
 * audit success by itself.
 */
export interface SandboxReport {
  version: typeof SANDBOX_REPORT_VERSION;
  backendType: SandboxBackendType;
  backendVersion: string | null;
  /** SHA-256 hex of the applied policy bytes when a policy was prepared. */
  policyHash: string | null;
  status: SandboxReportStatus;
  capabilities: SandboxCapabilities;
  /** Capability gaps that caused refusal; empty when none. */
  gaps: string[];
  /** Bounded violation / diagnostic lines; never file contents or secrets. */
  violations: string[];
  capturedAt: string;
  detail?: string;
}

export function isSandboxBackendType(
  value: unknown,
): value is SandboxBackendType {
  return (
    typeof value === "string" &&
    (SANDBOX_BACKEND_TYPES as readonly string[]).includes(value)
  );
}

export function isSandboxCapabilitySupport(
  value: unknown,
): value is SandboxCapabilitySupport {
  return (
    value === "full" || value === "partial" || value === "unsupported"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(
  allowed: readonly string[],
  value: Record<string, unknown>,
): boolean {
  const set = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!set.has(key)) return false;
  }
  return true;
}

function isBoundedText(value: unknown, max: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max;
}

export function isSandboxCapabilities(
  value: unknown,
): value is SandboxCapabilities {
  if (!isRecord(value)) return false;
  if (
    !hasOnlyKeys(
      [
        "backendType",
        "backendVersion",
        "filesystemIsolation",
        "networkIsolation",
        "credentialIsolation",
        "notes",
      ],
      value,
    )
  ) {
    return false;
  }
  if (!isSandboxBackendType(value.backendType)) return false;
  if (
    value.backendVersion !== null &&
    (typeof value.backendVersion !== "string" ||
      value.backendVersion.length === 0 ||
      value.backendVersion.length > MAX_SANDBOX_VERSION_LENGTH)
  ) {
    return false;
  }
  if (
    !isSandboxCapabilitySupport(value.filesystemIsolation) ||
    !isSandboxCapabilitySupport(value.networkIsolation) ||
    !isSandboxCapabilitySupport(value.credentialIsolation)
  ) {
    return false;
  }
  if (!Array.isArray(value.notes) || value.notes.length > MAX_SANDBOX_NOTES) {
    return false;
  }
  return value.notes.every((note) =>
    isBoundedText(note, MAX_SANDBOX_NOTE_LENGTH),
  );
}

export function isSandboxReport(value: unknown): value is SandboxReport {
  if (!isRecord(value)) return false;
  if (
    !hasOnlyKeys(
      [
        "version",
        "backendType",
        "backendVersion",
        "policyHash",
        "status",
        "capabilities",
        "gaps",
        "violations",
        "capturedAt",
        "detail",
      ],
      value,
    )
  ) {
    return false;
  }
  if (value.version !== SANDBOX_REPORT_VERSION) return false;
  if (!isSandboxBackendType(value.backendType)) return false;
  if (
    value.backendVersion !== null &&
    (typeof value.backendVersion !== "string" ||
      value.backendVersion.length === 0 ||
      value.backendVersion.length > MAX_SANDBOX_VERSION_LENGTH)
  ) {
    return false;
  }
  if (
    value.policyHash !== null &&
    (typeof value.policyHash !== "string" ||
      value.policyHash.length === 0 ||
      value.policyHash.length > MAX_SANDBOX_POLICY_HASH_LENGTH)
  ) {
    return false;
  }
  if (
    value.status !== "prepared" &&
    value.status !== "refused" &&
    value.status !== "unavailable" &&
    value.status !== "violation" &&
    value.status !== "released"
  ) {
    return false;
  }
  if (!isSandboxCapabilities(value.capabilities)) return false;
  if (!Array.isArray(value.gaps) || !value.gaps.every((g) => typeof g === "string")) {
    return false;
  }
  if (
    !Array.isArray(value.violations) ||
    value.violations.length > MAX_SANDBOX_VIOLATIONS ||
    !value.violations.every(
      (v) => typeof v === "string" && v.length <= MAX_SANDBOX_VIOLATION_LENGTH,
    )
  ) {
    return false;
  }
  if (typeof value.capturedAt !== "string" || Number.isNaN(Date.parse(value.capturedAt))) {
    return false;
  }
  if (
    value.detail !== undefined &&
    (typeof value.detail !== "string" ||
      value.detail.length === 0 ||
      value.detail.length > MAX_SANDBOX_DETAIL_LENGTH)
  ) {
    return false;
  }
  return true;
}

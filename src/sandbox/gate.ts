/**
 * Deterministic sandbox capability gate
 * (design/sandbox-adapter-nono-v0.md, DCP v2 §D6).
 */
import type {
  SandboxCapabilities,
  SandboxCapabilitySupport,
  SandboxRequirements,
} from "./types.js";

function capabilityRank(level: SandboxCapabilitySupport): number {
  if (level === "full") return 2;
  if (level === "partial") return 1;
  return 0;
}

/**
 * Return human-readable gaps when `requirements` exceed `capabilities`.
 * A non-empty result must refuse the task or escalate for explicit human
 * approval — never silently downgrade to host privileges.
 */
export function sandboxCapabilityGaps(
  capabilities: SandboxCapabilities,
  requirements: SandboxRequirements,
): string[] {
  const gaps: string[] = [];
  const keys = [
    "filesystemIsolation",
    "networkIsolation",
    "credentialIsolation",
  ] as const;
  for (const key of keys) {
    const required = requirements[key];
    if (required === undefined) continue;
    if (capabilityRank(capabilities[key]) < capabilityRank(required)) {
      gaps.push(
        `${key} requires ${required}, backend ${capabilities.backendType} ` +
          `declares ${capabilities[key]}`,
      );
    }
  }
  return gaps;
}

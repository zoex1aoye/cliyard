/**
 * Bounded SandboxReport builders (design/sandbox-adapter-nono-v0.md).
 */
import { createHash } from "node:crypto";
import type { SandboxPrepareRequest } from "./adapter.js";
import { sandboxCapabilityGaps } from "./gate.js";
import {
  MAX_SANDBOX_DETAIL_LENGTH,
  MAX_SANDBOX_VIOLATIONS,
  MAX_SANDBOX_VIOLATION_LENGTH,
  SANDBOX_REPORT_VERSION,
  type SandboxCapabilities,
  type SandboxReport,
  type SandboxReportStatus,
  type SandboxRequirements,
} from "./types.js";

export function hashSandboxPolicy(
  policyBytes: Uint8Array | string | undefined,
): string | null {
  if (policyBytes === undefined) return null;
  const buf =
    typeof policyBytes === "string"
      ? Buffer.from(policyBytes, "utf8")
      : Buffer.from(policyBytes);
  return createHash("sha256").update(buf).digest("hex");
}

export function buildSandboxReport(input: {
  capabilities: SandboxCapabilities;
  requirements?: SandboxRequirements;
  status: SandboxReportStatus;
  policyHash?: string | null;
  violations?: readonly string[];
  detail?: string;
  capturedAt?: string;
}): SandboxReport {
  const gaps = sandboxCapabilityGaps(
    input.capabilities,
    input.requirements ?? {},
  );
  const violations = (input.violations ?? [])
    .map((line) => line.slice(0, MAX_SANDBOX_VIOLATION_LENGTH))
    .slice(0, MAX_SANDBOX_VIOLATIONS);
  const report: SandboxReport = {
    version: SANDBOX_REPORT_VERSION,
    backendType: input.capabilities.backendType,
    backendVersion: input.capabilities.backendVersion,
    policyHash: input.policyHash ?? null,
    status: input.status,
    capabilities: input.capabilities,
    gaps,
    violations,
    capturedAt: input.capturedAt ?? new Date().toISOString(),
  };
  if (input.detail !== undefined && input.detail.length > 0) {
    report.detail = input.detail.slice(0, MAX_SANDBOX_DETAIL_LENGTH);
  }
  return report;
}

export function prepareSandboxReport(
  capabilities: SandboxCapabilities,
  request: SandboxPrepareRequest,
): SandboxReport {
  const gaps = sandboxCapabilityGaps(capabilities, request.requirements);
  const status =
    capabilities.backendType === "unavailable"
      ? "unavailable"
      : gaps.length > 0
        ? "refused"
        : "prepared";
  return buildSandboxReport({
    capabilities,
    requirements: request.requirements,
    status,
    policyHash: hashSandboxPolicy(request.policyBytes),
    capturedAt: request.now?.() ?? new Date().toISOString(),
    detail:
      status === "prepared"
        ? `sandbox prepared for workspace ${request.workspaceRoot}`
        : status === "refused"
          ? `sandbox refused: ${gaps.join("; ")}`
          : "sandbox backend unavailable",
  });
}

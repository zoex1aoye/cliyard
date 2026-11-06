/**
 * SandboxAdapter public surface (design/sandbox-adapter-nono-v0.md).
 */
export type {
  SandboxAdapter,
  SandboxPrepareRequest,
  SandboxPrepareResult,
} from "./adapter.js";
export { sandboxCapabilityGaps } from "./gate.js";
export {
  buildSandboxReport,
  hashSandboxPolicy,
  prepareSandboxReport,
} from "./report.js";
export { NONO_PINNED_VERSION } from "./pin.js";
export {
  NONO_SANDBOX_ID,
  NonoSandboxAdapter,
  nonoSandboxCapabilities,
  probeNonoBinary,
  type NonoProbeResult,
  type NonoSandboxAdapterOptions,
} from "./nono.js";
export {
  measureNonoFilesystemEnforcement,
  writeNonEnforcingNonoStub,
  type MeasureNonoFilesystemEnforcementOptions,
  type NonoFilesystemEnforcementMeasurement,
} from "./measure.js";
export {
  applySandboxWrapToSpawn,
  buildNonoWrapCommand,
  type NonoWrapCommand,
  type NonoWrapCommandInput,
} from "./wrap.js";
export {
  UNAVAILABLE_SANDBOX_ID,
  UnavailableSandboxAdapter,
  unavailableSandboxCapabilities,
} from "./unavailable.js";
export {
  MAX_SANDBOX_DETAIL_LENGTH,
  MAX_SANDBOX_NOTES,
  MAX_SANDBOX_NOTE_LENGTH,
  MAX_SANDBOX_POLICY_HASH_LENGTH,
  MAX_SANDBOX_VERSION_LENGTH,
  MAX_SANDBOX_VIOLATIONS,
  MAX_SANDBOX_VIOLATION_LENGTH,
  SANDBOX_BACKEND_TYPES,
  SANDBOX_CAPABILITY_SUPPORT,
  SANDBOX_REPORT_VERSION,
  isSandboxBackendType,
  isSandboxCapabilities,
  isSandboxCapabilitySupport,
  isSandboxReport,
  type SandboxBackendType,
  type SandboxCapabilities,
  type SandboxCapabilitySupport,
  type SandboxReport,
  type SandboxReportStatus,
  type SandboxRequirements,
} from "./types.js";

import type { SandboxAdapter } from "./adapter.js";
import { sandboxCapabilityGaps } from "./gate.js";
import { NonoSandboxAdapter } from "./nono.js";
import type { SandboxRequirements } from "./types.js";
import { UnavailableSandboxAdapter } from "./unavailable.js";

export interface SelectSandboxAdapterOptions {
  /** Prefer nono when the pinned binary is present (default true). */
  preferNono?: boolean;
  binaryPath?: string;
  /** Injected nono adapter factory (tests). */
  createNono?: () => SandboxAdapter;
}

/**
 * Select a sandbox adapter. When `preferNono` is true (default), try the
 * pinned nono binary; otherwise return unavailable. Callers that require
 * isolation must still run {@link sandboxCapabilityGaps} and refuse on gaps.
 */
export function selectSandboxAdapter(
  options: SelectSandboxAdapterOptions = {},
): SandboxAdapter {
  if (options.preferNono === false) {
    return new UnavailableSandboxAdapter(
      "nono preference disabled; no OS sandbox backend selected",
    );
  }
  if (options.createNono) return options.createNono();
  return NonoSandboxAdapter.create({ binaryPath: options.binaryPath });
}

/**
 * True when the selected adapter can satisfy `requirements` without gaps.
 */
export function sandboxAdapterSatisfies(
  adapter: SandboxAdapter,
  requirements: SandboxRequirements,
): boolean {
  return sandboxCapabilityGaps(adapter.capabilities(), requirements).length === 0;
}

/**
 * Provider-neutral SandboxAdapter seam (design/sandbox-adapter-nono-v0.md).
 */
import type {
  SandboxCapabilities,
  SandboxReport,
  SandboxRequirements,
} from "./types.js";

export interface SandboxPrepareRequest {
  /** Absolute task worktree / workspace root the sandbox may write. */
  workspaceRoot: string;
  /** Absolute repository root (control plane lives here; usually read-only). */
  repoRoot: string;
  requirements: SandboxRequirements;
  /** Optional opaque policy document bytes hash input. */
  policyBytes?: Uint8Array | string;
  now?: () => string;
}

export interface SandboxPrepareResult {
  /** True when the backend can run under the requested requirements. */
  ok: boolean;
  report: SandboxReport;
}

/**
 * Sandbox backends prepare an isolation context, expose honest capabilities,
 * and emit observational reports. They never grant task acceptance.
 */
export interface SandboxAdapter {
  readonly id: string;
  capabilities(): SandboxCapabilities;
  prepare(request: SandboxPrepareRequest): Promise<SandboxPrepareResult>;
  release(report: SandboxReport): Promise<SandboxReport>;
}

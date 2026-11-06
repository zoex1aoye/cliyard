/**
 * Honest unavailable sandbox backend — declares unsupported isolation and
 * never claims OS write prevention (design/sandbox-adapter-nono-v0.md).
 */
import type { SandboxAdapter, SandboxPrepareRequest, SandboxPrepareResult } from "./adapter.js";
import { prepareSandboxReport } from "./report.js";
import type { SandboxCapabilities, SandboxReport } from "./types.js";

export const UNAVAILABLE_SANDBOX_ID = "sandbox.unavailable" as const;

export function unavailableSandboxCapabilities(
  detailNote = "no OS sandbox backend is active in this process",
): SandboxCapabilities {
  return {
    backendType: "unavailable",
    backendVersion: null,
    filesystemIsolation: "unsupported",
    networkIsolation: "unsupported",
    credentialIsolation: "unsupported",
    notes: [detailNote],
  };
}

export class UnavailableSandboxAdapter implements SandboxAdapter {
  readonly id = UNAVAILABLE_SANDBOX_ID;
  private readonly caps: SandboxCapabilities;

  constructor(detailNote?: string) {
    this.caps = unavailableSandboxCapabilities(detailNote);
  }

  capabilities(): SandboxCapabilities {
    return this.caps;
  }

  async prepare(request: SandboxPrepareRequest): Promise<SandboxPrepareResult> {
    const report = prepareSandboxReport(this.caps, request);
    return { ok: false, report };
  }

  async release(report: SandboxReport): Promise<SandboxReport> {
    return {
      ...report,
      status: "released",
      capturedAt: new Date().toISOString(),
    };
  }
}

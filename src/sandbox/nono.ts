/**
 * Nono SandboxAdapter — version-pinned probe backend
 * (design/sandbox-adapter-nono-v0.md).
 *
 * nono is pre-1.0. This adapter pins `v0.81.0` and only declares isolation
 * capabilities when `nono --version` matches that pin. A version probe is
 * **not** measured write-prevention evidence; worker wrap lands in P3b.
 */
import { spawnSync } from "node:child_process";
import type { SandboxAdapter, SandboxPrepareRequest, SandboxPrepareResult } from "./adapter.js";
import { prepareSandboxReport } from "./report.js";
import type { SandboxCapabilities, SandboxReport } from "./types.js";
import { UnavailableSandboxAdapter } from "./unavailable.js";

/** Pinned nono CLI release (nolabs-ai/nono). Re-evaluate before bumping. */
export const NONO_PINNED_VERSION = "0.81.0" as const;
export const NONO_SANDBOX_ID = "sandbox.nono" as const;

export interface NonoProbeResult {
  available: boolean;
  version: string | null;
  binaryPath: string | null;
  detail: string;
}

export interface NonoSandboxAdapterOptions {
  /** Override binary path (tests). Defaults to `nono` on PATH. */
  binaryPath?: string;
  /** Injected probe (tests). */
  probe?: () => NonoProbeResult;
  /**
   * When false (default), a failed pin probe yields an Unavailable adapter
   * instead of claiming nono capabilities.
   */
  allowMismatchedVersion?: boolean;
}

function parseNonoVersion(stdout: string): string | null {
  const text = stdout.trim();
  if (!text) return null;
  const match = text.match(/(\d+\.\d+\.\d+)/);
  return match?.[1] ?? null;
}

/**
 * Probe a nono binary. Never throws; missing/broken binaries return
 * `available: false`.
 */
export function probeNonoBinary(
  binaryPath = "nono",
): NonoProbeResult {
  try {
    const result = spawnSync(binaryPath, ["--version"], {
      encoding: "utf8",
      timeout: 5_000,
      env: process.env,
    });
    if (result.error) {
      return {
        available: false,
        version: null,
        binaryPath: null,
        detail: `nono probe failed: ${result.error.message}`,
      };
    }
    if (result.status !== 0) {
      return {
        available: false,
        version: null,
        binaryPath: null,
        detail:
          `nono --version exited ${String(result.status)}: ` +
          `${(result.stderr || result.stdout || "").trim().slice(0, 200)}`,
      };
    }
    const version = parseNonoVersion(result.stdout || "");
    if (version === null) {
      return {
        available: false,
        version: null,
        binaryPath,
        detail: "nono --version did not report a semver",
      };
    }
    return {
      available: true,
      version,
      binaryPath,
      detail: `nono ${version} at ${binaryPath}`,
    };
  } catch (error) {
    return {
      available: false,
      version: null,
      binaryPath: null,
      detail:
        error instanceof Error ? error.message : `nono probe error: ${String(error)}`,
    };
  }
}

export function nonoSandboxCapabilities(
  version: string,
): SandboxCapabilities {
  return {
    backendType: "nono",
    backendVersion: version,
    // Honest: pin match proves the binary, not measured write prevention of
    // every descendant. Declare partial until P3b conformance wrap lands.
    filesystemIsolation: "partial",
    networkIsolation: "partial",
    credentialIsolation: "partial",
    notes: [
      `pinned nono ${NONO_PINNED_VERSION}; version probe is not write-prevention proof`,
      "worker CLI wrap through `nono run` is deferred to P3b",
    ],
  };
}

export class NonoSandboxAdapter implements SandboxAdapter {
  readonly id = NONO_SANDBOX_ID;
  private readonly caps: SandboxCapabilities;
  private readonly probe: NonoProbeResult;

  private constructor(caps: SandboxCapabilities, probe: NonoProbeResult) {
    this.caps = caps;
    this.probe = probe;
  }

  /**
   * Create a nono adapter when the pinned binary is present; otherwise return
   * an UnavailableSandboxAdapter with the probe detail.
   */
  static create(
    options: NonoSandboxAdapterOptions = {},
  ): SandboxAdapter {
    const probe =
      options.probe?.() ??
      probeNonoBinary(options.binaryPath ?? "nono");
    if (!probe.available || probe.version === null) {
      return new UnavailableSandboxAdapter(probe.detail);
    }
    if (
      probe.version !== NONO_PINNED_VERSION &&
      options.allowMismatchedVersion !== true
    ) {
      return new UnavailableSandboxAdapter(
        `nono version ${probe.version} does not match pin ` +
          `${NONO_PINNED_VERSION}; refusing to claim sandbox capabilities`,
      );
    }
    return new NonoSandboxAdapter(
      nonoSandboxCapabilities(probe.version),
      probe,
    );
  }

  capabilities(): SandboxCapabilities {
    return this.caps;
  }

  /** Expose the last probe for diagnostics / tests. */
  lastProbe(): NonoProbeResult {
    return this.probe;
  }

  async prepare(request: SandboxPrepareRequest): Promise<SandboxPrepareResult> {
    const report = prepareSandboxReport(this.caps, request);
    return { ok: report.status === "prepared", report };
  }

  async release(report: SandboxReport): Promise<SandboxReport> {
    return {
      ...report,
      status: "released",
      capturedAt: new Date().toISOString(),
    };
  }
}

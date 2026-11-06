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
import { measureNonoFilesystemEnforcement } from "./measure.js";
import { NONO_PINNED_VERSION } from "./pin.js";
import { prepareSandboxReport } from "./report.js";
import type { SandboxCapabilities, SandboxReport } from "./types.js";
import { UnavailableSandboxAdapter } from "./unavailable.js";

export { NONO_PINNED_VERSION } from "./pin.js";
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
  /**
   * Injected filesystem-enforcement measurement (tests). When omitted, runs
   * {@link measureNonoFilesystemEnforcement} against the probed binary.
   */
  measureFilesystem?: () => {
    enforced: boolean;
    detail: string;
  };
  /**
   * Skip the live enforcement probe (tests that only care about pin). Prefer
   * leaving this unset in production so capabilities stay honest.
   */
  skipFilesystemMeasurement?: boolean;
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
  options: {
    filesystemEnforced: boolean;
    enforcementDetail?: string;
  } = { filesystemEnforced: false },
): SandboxCapabilities {
  const filesystemIsolation = options.filesystemEnforced
    ? "partial"
    : "unsupported";
  const notes = [
    `pinned nono ${NONO_PINNED_VERSION}`,
    options.filesystemEnforced
      ? "filesystem enforcement measured on this host (partial; not full descendant proof)"
      : options.enforcementDetail ??
        "filesystem enforcement not measured/failed; isolation unsupported",
    "opt-in worker wrap via buildNonoWrapCommand / applySandboxWrapToSpawn",
  ];
  return {
    backendType: "nono",
    backendVersion: version,
    filesystemIsolation,
    // Network/credential mediation is not measured in P3b; stay unsupported.
    networkIsolation: "unsupported",
    credentialIsolation: "unsupported",
    notes,
  };
}

export class NonoSandboxAdapter implements SandboxAdapter {
  readonly id = NONO_SANDBOX_ID;
  private readonly caps: SandboxCapabilities;
  private readonly probe: NonoProbeResult;
  private readonly filesystemEnforced: boolean;

  private constructor(
    caps: SandboxCapabilities,
    probe: NonoProbeResult,
    filesystemEnforced: boolean,
  ) {
    this.caps = caps;
    this.probe = probe;
    this.filesystemEnforced = filesystemEnforced;
  }

  /**
   * Create a nono adapter when the pinned binary is present; otherwise return
   * an UnavailableSandboxAdapter with the probe detail. Filesystem isolation
   * is `partial` only after a passing enforcement measurement.
   */
  static create(
    options: NonoSandboxAdapterOptions = {},
  ): SandboxAdapter {
    const binaryPath = options.binaryPath ?? "nono";
    const probe = options.probe?.() ?? probeNonoBinary(binaryPath);
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

    let filesystemEnforced = false;
    let enforcementDetail =
      "filesystem enforcement measurement skipped";
    if (options.skipFilesystemMeasurement === true) {
      filesystemEnforced = false;
    } else if (options.measureFilesystem) {
      const measured = options.measureFilesystem();
      filesystemEnforced = measured.enforced;
      enforcementDetail = measured.detail;
    } else {
      const measured = measureNonoFilesystemEnforcement({
        binaryPath: probe.binaryPath ?? binaryPath,
      });
      filesystemEnforced = measured.enforced;
      enforcementDetail = measured.detail;
    }

    return new NonoSandboxAdapter(
      nonoSandboxCapabilities(probe.version, {
        filesystemEnforced,
        enforcementDetail,
      }),
      probe,
      filesystemEnforced,
    );
  }

  capabilities(): SandboxCapabilities {
    return this.caps;
  }

  /** Expose the last probe for diagnostics / tests. */
  lastProbe(): NonoProbeResult {
    return this.probe;
  }

  /** Whether the last create() measurement reported enforcement. */
  filesystemEnforcementMeasured(): boolean {
    return this.filesystemEnforced;
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

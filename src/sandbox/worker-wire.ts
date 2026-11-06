/**
 * Production wire: prepare a sandbox for one worker spawn
 * (design/sandbox-batch-wire-v0.md).
 */
import {
  createFailureRecord,
  type FailureRecord,
} from "../failures.js";
import type { SandboxPrepareResult } from "./adapter.js";
import { NonoSandboxAdapter } from "./nono.js";
import type { SandboxReport, SandboxRequirements } from "./types.js";
import { UnavailableSandboxAdapter } from "./unavailable.js";
import {
  applySandboxWrapToSpawn,
  type NonoWrapCommand,
} from "./wrap.js";

export interface WorkerSandboxOptions {
  /** Explicit enable. When omitted, `CLIYARD_SANDBOX=1` enables. */
  enabled?: boolean;
  requirements?: SandboxRequirements;
  nonoBinary?: string;
  /** Repository root (read grant). Defaults omitted when unset. */
  repoRoot?: string;
  /**
   * Injected adapter factory (tests). Production uses pinned nono (+ measure).
   */
  createAdapter?: () => import("./adapter.js").SandboxAdapter;
}

export interface PreparedWorkerSandbox {
  ok: boolean;
  report: SandboxReport;
  /** Present only when prepare succeeded and wrap should be applied. */
  wrap?: {
    report: SandboxReport;
    workspaceRoot: string;
    repoRoot?: string;
    nonoBinary?: string;
  };
}

export function isWorkerSandboxEnabled(
  options: WorkerSandboxOptions | undefined,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (options?.enabled === true) return true;
  if (options?.enabled === false) return false;
  return env.CLIYARD_SANDBOX === "1" || env.CLIYARD_SANDBOX === "true";
}

/**
 * Default requirements when sandbox is enabled: require measured filesystem
 * partial isolation. Hosts that cannot enforce will refuse (fail closed).
 */
export const DEFAULT_WORKER_SANDBOX_REQUIREMENTS: SandboxRequirements = {
  filesystemIsolation: "partial",
};

export async function prepareWorkerSandbox(input: {
  workspaceRoot: string;
  options?: WorkerSandboxOptions;
  now?: () => string;
}): Promise<PreparedWorkerSandbox | null> {
  if (!isWorkerSandboxEnabled(input.options)) return null;

  const adapter =
    input.options?.createAdapter?.() ??
    NonoSandboxAdapter.create({
      binaryPath: input.options?.nonoBinary,
    });

  // If create() returned unavailable (pin miss), capabilities stay unsupported.
  const requirements =
    input.options?.requirements ?? DEFAULT_WORKER_SANDBOX_REQUIREMENTS;
  const prepared: SandboxPrepareResult = await adapter.prepare({
    workspaceRoot: input.workspaceRoot,
    repoRoot: input.options?.repoRoot ?? input.workspaceRoot,
    requirements,
    now: input.now,
  });

  if (!prepared.ok || prepared.report.status !== "prepared") {
    return { ok: false, report: prepared.report };
  }

  return {
    ok: true,
    report: prepared.report,
    wrap: {
      report: prepared.report,
      workspaceRoot: input.workspaceRoot,
      ...(input.options?.repoRoot !== undefined
        ? { repoRoot: input.options.repoRoot }
        : {}),
      ...(input.options?.nonoBinary !== undefined
        ? { nonoBinary: input.options.nonoBinary }
        : {}),
    },
  };
}

/** Structured failure when sandbox prepare refuses the attempt. */
export function createSandboxRefusalFailure(
  report: SandboxReport,
): FailureRecord {
  const gaps =
    report.gaps.length > 0 ? report.gaps.join("; ") : report.detail ?? "refused";
  return createFailureRecord({
    policyBlocked: true,
    stage: "policy",
    code: "sandbox_refused",
    messageDetail: `sandbox refused (${report.backendType}/${report.status}): ${gaps}`,
    retryableHint: false,
  });
}

/** Apply wrap to a command when prepare succeeded. */
export function wrapWorkerCommand(
  command: string,
  args: readonly string[],
  prepared: PreparedWorkerSandbox,
): NonoWrapCommand {
  if (!prepared.ok || prepared.wrap === undefined) {
    return { command, args: [...args] };
  }
  return applySandboxWrapToSpawn(command, args, prepared.wrap);
}

/** Test/helper: force an unavailable adapter. */
export function createUnavailableWorkerAdapter(
  detail?: string,
): import("./adapter.js").SandboxAdapter {
  return new UnavailableSandboxAdapter(detail);
}

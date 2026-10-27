import { spawn } from "node:child_process";
import type { TaskContract } from "../contracts/schema.js";
import type { AgentResult } from "../agents/types.js";
import {
  RuntimeManager,
  RuntimeStartError,
  type RuntimeSession,
} from "../runtime/manager.js";
import type { RuntimeManifest, RuntimeSpec } from "../runtime/types.js";

/** Persisted RuntimeManifest returned as evidence for runtime verification. */
export interface VerifyRuntimeEvidence {
  runtimeId: string;
  manifestPath: string;
  manifest: RuntimeManifest;
}

export interface VerifyResult {
  ok: boolean;
  exitCode: number;
  commandResults: { command: string; exitCode: number; log: string }[];
  logTail: string;
  /** Present when a contract runtime was started for this verification. */
  runtime?: VerifyRuntimeEvidence;
}

export interface Verifier {
  run(contract: TaskContract, agent: AgentResult): Promise<VerifyResult>;
}

export interface ShellVerifierOptions {
  /** Working directory for verifyCommands (default: process.cwd()). */
  cwd?: string;
  /** Per-command timeout in ms (default 30_000). */
  timeoutMs?: number;
  /**
   * Control repository that receives the runtime manifest, service logs and
   * port leases under `<repoRoot>/.cliyard/runtime` (default: process.cwd()).
   * This must not be the disposable task worktree.
   */
  repoRoot?: string;
  /**
   * Exact task worktree runtime services start from (default: `cwd`).
   * verifyCommands already run in `cwd`.
   */
  worktree?: string;
  /**
   * Prefix for deterministic runtime ids, normally the supervisor run id.
   * Ids become `<prefix>-<taskId>-attempt-<n>`; without a prefix RuntimeManager
   * defaults to `<taskId>-attempt-<n>`.
   */
  runtimeIdPrefix?: string;
  /** Base environment for verifyCommands (default: process.env). */
  env?: NodeJS.ProcessEnv;
}

function pathOvershoot(contract: TaskContract, agent: AgentResult): boolean {
  return agent.touchedPaths.some(
    (p) =>
      !contract.writePaths.some(
        (w) => p === w || p.startsWith(w.replace(/\/?$/, "/")),
      ),
  );
}

/**
 * Mock verifier: does not shell out. Honors agent.mockMeta or simply
 * checks exitCode===0 and writePaths non-empty touch.
 */
export function createMockVerifier(): Verifier {
  return {
    async run(contract, agent): Promise<VerifyResult> {
      const commandResults = contract.verifyCommands.map((command) => {
        if (agent.exitCode !== 0) {
          return {
            command,
            exitCode: 1,
            log: `[mock-verify] skipped; implement exitCode=${agent.exitCode}`,
          };
        }
        if (agent.mockMeta?.intendedVerifyFail) {
          return {
            command,
            exitCode: 1,
            log: `[mock-verify] FAIL (simulated): ${command}`,
          };
        }
        if (pathOvershoot(contract, agent)) {
          return {
            command,
            exitCode: 2,
            log: `[mock-verify] FAIL path overshoot: ${agent.touchedPaths.join(", ")}`,
          };
        }
        return {
          command,
          exitCode: 0,
          log: `[mock-verify] PASS: ${command}`,
        };
      });

      // No verify commands → path-only gate
      if (commandResults.length === 0) {
        const ok =
          agent.exitCode === 0 &&
          !agent.mockMeta?.intendedVerifyFail &&
          agent.touchedPaths.length > 0;
        return {
          ok,
          exitCode: ok ? 0 : 1,
          commandResults: [],
          logTail: ok
            ? "[mock-verify] no verifyCommands; path gate passed"
            : "[mock-verify] no verifyCommands; path/implement gate failed",
        };
      }

      const failed = commandResults.find((r) => r.exitCode !== 0);
      return {
        ok: !failed,
        exitCode: failed?.exitCode ?? 0,
        commandResults,
        logTail: commandResults.map((r) => r.log).join("\n"),
      };
    },
  };
}

/**
 * Real Darwin/local shell verifier: spawns each contract.verifyCommands via
 * the system shell. Ignores agent.mockMeta (use createMockVerifier for that).
 * Opt-in only — Mock remains the default for mock-loop.
 *
 * Contracts with `runtime` get RuntimeManager services started from the exact
 * task worktree after the implement and path gates pass. Service URLs are
 * injected into every verifyCommand, the manifest is persisted under the
 * control repository, and the runtime is always stopped before returning.
 * Contracts without `runtime` keep the original static behavior.
 */
export function createShellVerifier(opts: ShellVerifierOptions = {}): Verifier {
  const cwd = opts.cwd;
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const env = opts.env ?? process.env;
  const repoRoot = opts.repoRoot ?? process.cwd();
  const worktree = opts.worktree ?? cwd ?? process.cwd();
  let runtimeAttempts = 0;

  async function runRuntime(
    contract: TaskContract,
    runtime: RuntimeSpec,
  ): Promise<VerifyResult> {
    runtimeAttempts += 1;
    const attempt = runtimeAttempts;
    const runtimeId = prefixedRuntimeId(
      opts.runtimeIdPrefix,
      contract.taskId,
      attempt,
    );

    let manager: RuntimeManager;
    try {
      manager = new RuntimeManager({
        repoRoot,
        worktree,
        taskId: contract.taskId,
        attempt,
        ...(runtimeId !== undefined ? { runtimeId } : {}),
        env,
      });
    } catch (error) {
      const detail = errorMessage(error);
      return {
        ok: false,
        exitCode: 1,
        commandResults: skippedCommands(
          contract.verifyCommands,
          `runtime setup failed: ${detail}`,
        ),
        logTail:
          "[shell-verify] runtime setup failed; verifyCommands were not run\n" +
          detail,
      };
    }

    let session: RuntimeSession;
    try {
      session = await manager.start(runtime);
    } catch (error) {
      const detail = errorMessage(error);
      const manifest =
        error instanceof RuntimeStartError ? error.manifest : undefined;
      return {
        ok: false,
        exitCode: 1,
        commandResults: skippedCommands(
          contract.verifyCommands,
          "runtime not ready",
        ),
        logTail:
          `[shell-verify] runtime ${manager.runtimeId} not ready; ` +
          `verifyCommands were not run\n${detail}`,
        ...(manifest !== undefined
          ? { runtime: runtimeEvidence(manager, manifest) }
          : {}),
      };
    }

    const commandResults: VerifyResult["commandResults"] = [];
    let commandError: unknown;
    let cleanupError: unknown;
    let manifest = session.manifest;

    try {
      const runtimeEnv: NodeJS.ProcessEnv = { ...env, ...session.env };
      commandResults.push(
        ...(await runVerifyCommands(contract, {
          cwd,
          timeoutMs,
          env: runtimeEnv,
        })),
      );
    } catch (error) {
      commandError = error;
    } finally {
      // Cleanup owns the process group and every lease; it must run even when
      // a command or the loop itself failed.
      try {
        manifest = await session.stop();
      } catch (error) {
        cleanupError = error;
        manifest = session.manifest;
      }
    }

    const failed = commandResults.find((r) => r.exitCode !== 0);
    const lines = commandResults.map((r) => r.log);
    if (contract.verifyCommands.length === 0) {
      lines.push("[shell-verify] runtime ready; no verifyCommands; path gate passed");
    }
    if (commandError !== undefined) {
      lines.push(
        `[shell-verify] command execution failed: ${errorMessage(commandError)}`,
      );
    }
    if (cleanupError !== undefined) {
      lines.push(
        `[shell-verify] runtime cleanup failed: ${errorMessage(cleanupError)}`,
      );
    }
    const ok =
      failed === undefined &&
      commandError === undefined &&
      cleanupError === undefined;

    return {
      ok,
      exitCode: failed?.exitCode ?? (ok ? 0 : 1),
      commandResults,
      logTail: lines.join("\n"),
      runtime: runtimeEvidence(manager, manifest),
    };
  }

  // The path gate must pass before any runtime service starts; no runtime is
  // ever created for mock verification because that path uses createMockVerifier.
  return {
    async run(contract, agent): Promise<VerifyResult> {
      if (agent.exitCode !== 0) {
        return {
          ok: false,
          exitCode: 1,
          commandResults: contract.verifyCommands.map((command) => ({
            command,
            exitCode: 1,
            log: `[shell-verify] skipped; implement exitCode=${agent.exitCode}`,
          })),
          logTail: `[shell-verify] skipped; implement exitCode=${agent.exitCode}`,
        };
      }

      if (pathOvershoot(contract, agent)) {
        const log = `[shell-verify] FAIL path overshoot: ${agent.touchedPaths.join(", ")}`;
        return {
          ok: false,
          exitCode: 2,
          commandResults: contract.verifyCommands.map((command) => ({
            command,
            exitCode: 2,
            log,
          })),
          logTail: log,
        };
      }

      if (contract.runtime !== undefined) {
        return runRuntime(contract, contract.runtime);
      }

      if (contract.verifyCommands.length === 0) {
        const ok = agent.touchedPaths.length > 0;
        return {
          ok,
          exitCode: ok ? 0 : 1,
          commandResults: [],
          logTail: ok
            ? "[shell-verify] no verifyCommands; path gate passed"
            : "[shell-verify] no verifyCommands; path gate failed",
        };
      }

      const commandResults = await runVerifyCommands(contract, {
        cwd,
        timeoutMs,
        env,
      });
      const failed = commandResults.find((r) => r.exitCode !== 0);
      return {
        ok: !failed,
        exitCode: failed?.exitCode ?? 0,
        commandResults,
        logTail: commandResults.map((r) => r.log).join("\n"),
      };
    },
  };
}

async function runVerifyCommands(
  contract: TaskContract,
  opts: { cwd?: string; timeoutMs: number; env: NodeJS.ProcessEnv },
): Promise<VerifyResult["commandResults"]> {
  const commandResults: VerifyResult["commandResults"] = [];
  for (const command of contract.verifyCommands) {
    const r = await runLocalShell(command, opts);
    const combined = [r.stdout, r.stderr].filter(Boolean).join("\n").trim();
    const log = r.timedOut
      ? `[shell-verify] TIMEOUT (${opts.timeoutMs}ms): ${command}`
      : `[shell-verify] exit=${r.exitCode}: ${command}${combined ? `\n${combined}` : ""}`;
    commandResults.push({
      command,
      exitCode: r.timedOut ? 124 : r.exitCode,
      log,
    });
    if (r.timedOut || r.exitCode !== 0) break;
  }
  return commandResults;
}

function skippedCommands(
  commands: string[],
  reason: string,
): VerifyResult["commandResults"] {
  const log = `[shell-verify] skipped; ${reason}`;
  return commands.map((command) => ({ command, exitCode: 1, log }));
}

function runtimeEvidence(
  manager: RuntimeManager,
  manifest: RuntimeManifest,
): VerifyRuntimeEvidence {
  return {
    runtimeId: manager.runtimeId,
    manifestPath: manager.manifestPath,
    manifest,
  };
}

const RUNTIME_ID_LIMIT = 128;

/**
 * Deterministic per-attempt runtime id, sanitized to the RuntimeManager path
 * segment pattern. Returns undefined to accept the manager's default.
 */
function prefixedRuntimeId(
  prefix: string | undefined,
  taskId: string,
  attempt: number,
): string | undefined {
  if (prefix === undefined || prefix.trim() === "") return undefined;
  const raw = `${prefix}-${taskId}-attempt-${attempt}`;
  const safe = raw
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^[^A-Za-z0-9]+/, "");
  if (safe === "") return undefined;
  return safe.slice(0, RUNTIME_ID_LIMIT);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** True when CLI flag or CLIYARD_REAL_VERIFY env opts into shell verify. */
export function wantsRealVerify(
  argv: string[] = [],
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (argv.includes("--real-verify")) return true;
  const v = env.CLIYARD_REAL_VERIFY;
  return v === "1" || v === "true" || v === "yes";
}

interface ShellRunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

function runLocalShell(
  command: string,
  opts: { cwd?: string; timeoutMs: number; env: NodeJS.ProcessEnv },
): Promise<ShellRunResult> {
  return new Promise((resolvePromise) => {
    const child = spawn(command, {
      shell: true,
      cwd: opts.cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: opts.env,
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, opts.timeoutMs);

    child.stdout.on("data", (d: Buffer) => {
      stdout += d.toString("utf8");
    });
    child.stderr.on("data", (d: Buffer) => {
      stderr += d.toString("utf8");
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      resolvePromise({
        exitCode: 1,
        stdout,
        stderr: stderr || String(err),
        timedOut: false,
      });
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      resolvePromise({
        exitCode: code ?? 1,
        stdout,
        stderr,
        timedOut,
      });
    });
  });
}

import { spawn } from "node:child_process";
import type { TaskContract } from "../contracts/schema.js";
import type { AgentResult } from "../agents/types.js";

export interface VerifyResult {
  ok: boolean;
  exitCode: number;
  commandResults: { command: string; exitCode: number; log: string }[];
  logTail: string;
}

export interface Verifier {
  run(contract: TaskContract, agent: AgentResult): Promise<VerifyResult>;
}

export interface ShellVerifierOptions {
  /** Working directory for verifyCommands (default: process.cwd()). */
  cwd?: string;
  /** Per-command timeout in ms (default 30_000). */
  timeoutMs?: number;
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
 */
export function createShellVerifier(opts: ShellVerifierOptions = {}): Verifier {
  const cwd = opts.cwd;
  const timeoutMs = opts.timeoutMs ?? 30_000;

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

      const commandResults: VerifyResult["commandResults"] = [];
      for (const command of contract.verifyCommands) {
        const r = await runLocalShell(command, { cwd, timeoutMs });
        const combined = [r.stdout, r.stderr].filter(Boolean).join("\n").trim();
        const log = r.timedOut
          ? `[shell-verify] TIMEOUT (${timeoutMs}ms): ${command}`
          : `[shell-verify] exit=${r.exitCode}: ${command}${combined ? `\n${combined}` : ""}`;
        commandResults.push({
          command,
          exitCode: r.timedOut ? 124 : r.exitCode,
          log,
        });
        if (r.timedOut || r.exitCode !== 0) break;
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
  opts: { cwd?: string; timeoutMs: number },
): Promise<ShellRunResult> {
  return new Promise((resolvePromise) => {
    const child = spawn(command, {
      shell: true,
      cwd: opts.cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
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

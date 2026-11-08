/**
 * MVP M1 idle-spin + M2 dispose: worktree → spawn(cwd) → AbortSignal kill.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import {
  assertWrapDisabledOrKnown,
  defaultDisposeRegistry,
  disposeChild,
  type DisposeReason,
  type DisposeRegistry,
  type DisposeResult,
} from "./dispose.js";
import { assertFrozenImmutable } from "./freeze.js";
import {
  assertLocalCliTaskContract,
  type LocalCliTaskContract,
} from "./taskcontract.js";

export interface IdleSpinResult {
  ok: boolean;
  contractId: string;
  target: string;
  repoRoot: string;
  worktreePath: string;
  branch: string;
  spawnCwd: string;
  spawnExitCode: number;
  spawnPid?: number;
  verify: Array<{ argv: string[]; exitCode: number }>;
  trunkClean: boolean;
  keptWorkspace: boolean;
  disposed: boolean;
  disposeReason?: DisposeReason;
  dispose?: DisposeResult;
  error?: string;
}

function runGit(
  repoRoot: string,
  args: string[],
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn("git", args, {
      cwd: repoRoot,
      env: process.env,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => {
      stdout += String(d);
    });
    child.stderr.on("data", (d) => {
      stderr += String(d);
    });
    child.on("error", reject);
    child.on("close", (code) => {
      resolvePromise({ code: code ?? 1, stdout, stderr });
    });
  });
}

function spawnCommand(input: {
  argv: string[];
  cwd: string;
  env?: Record<string, string>;
  timeoutSec: number;
  signal?: AbortSignal;
  /** Detach into its own process group so dispose can kill descendants. */
  detached?: boolean;
  registry?: DisposeRegistry;
}): Promise<{
  code: number;
  stdout: string;
  stderr: string;
  pid?: number;
  disposed: boolean;
  disposeReason?: DisposeReason;
  dispose?: DisposeResult;
}> {
  const [cmd, ...args] = input.argv;
  if (!cmd) {
    return Promise.reject(new Error("argv must be non-empty"));
  }
  if (input.signal?.aborted) {
    return Promise.resolve({
      code: 1,
      stdout: "",
      stderr: "aborted before spawn",
      disposed: true,
      disposeReason: "abort",
    });
  }

  const detached = input.detached === true;
  const registry = input.registry;

  return new Promise((resolvePromise, reject) => {
    const child = spawn(cmd, args, {
      cwd: input.cwd,
      env: { ...process.env, ...(input.env ?? {}) },
      detached,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const pid = child.pid;
    let stdout = "";
    let stderr = "";
    let disposed = false;
    let disposeReason: DisposeReason | undefined;
    let disposeInfo: DisposeResult | undefined;
    let disposeInFlight: Promise<void> | undefined;
    let unregister: (() => void) | undefined;
    let settled = false;

    const finish = (code: number) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      input.signal?.removeEventListener("abort", onAbort);
      unregister?.();
      resolvePromise({
        code,
        stdout,
        stderr,
        ...(pid ? { pid } : {}),
        disposed,
        ...(disposeReason ? { disposeReason } : {}),
        ...(disposeInfo ? { dispose: disposeInfo } : {}),
      });
    };

    const requestDispose = (reason: DisposeReason): Promise<void> => {
      if (!pid) return Promise.resolve();
      if (disposeInFlight) return disposeInFlight;
      disposed = true;
      disposeReason = reason;
      disposeInFlight = (async () => {
        disposeInfo = await disposeChild({
          pid,
          reason,
          processGroup: detached,
        });
      })();
      return disposeInFlight;
    };

    if (pid && registry) {
      unregister = registry.register({
        pid,
        processGroup: detached,
        dispose: async (reason) => {
          await requestDispose(reason);
          return (
            disposeInfo ?? {
              pid,
              disposed: true,
              reason,
              usedProcessGroup: detached,
              signals: [],
              aliveAfter: false,
            }
          );
        },
      });
    }

    const onAbort = () => {
      void requestDispose("abort");
    };
    input.signal?.addEventListener("abort", onAbort, { once: true });

    const timer = setTimeout(() => {
      void requestDispose("timeout");
    }, Math.max(1, input.timeoutSec) * 1000);

    child.stdout?.on("data", (d) => {
      stdout += String(d);
    });
    child.stderr?.on("data", (d) => {
      stderr += String(d);
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      input.signal?.removeEventListener("abort", onAbort);
      unregister?.();
      reject(err);
    });
    child.on("close", (code) => {
      const exitCode = code ?? 1;
      if (disposeInFlight) {
        void disposeInFlight.finally(() => finish(exitCode));
      } else {
        finish(exitCode);
      }
    });
  });
}

function slug(id: string): string {
  return (
    id
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 48) || "task"
  );
}

/**
 * Product dirty lines on the trunk checkout.
 * Control-plane `.cliyard/` (worktree containers, leases) is expected and ignored.
 * Also ignore the worktree path itself when nested under the repo.
 */
export function productPorcelainLines(
  porcelain: string,
  repoRoot: string,
  worktreePath: string,
): string[] {
  const root = resolve(repoRoot);
  const wt = resolve(worktreePath);
  const lines = porcelain
    .split(/\r?\n/)
    .map((l) => l.trimEnd())
    .filter((l) => l.length > 0);

  return lines.filter((line) => {
    // porcelain: XY PATH or XY ORIG -> PATH
    const pathPart = line.slice(3);
    const arrow = pathPart.indexOf(" -> ");
    const rel = (arrow >= 0 ? pathPart.slice(arrow + 4) : pathPart).replace(
      /^"+|"+$/g,
      "",
    );
    if (rel === ".cliyard" || rel.startsWith(".cliyard/")) return false;
    const abs = resolve(root, rel);
    if (abs === wt || abs.startsWith(wt + "/")) return false;
    return true;
  });
}

function trunkProductClean(
  before: string,
  after: string,
  repoRoot: string,
  worktreePath: string,
): boolean {
  const a = productPorcelainLines(before, repoRoot, worktreePath).join("\n");
  const b = productPorcelainLines(after, repoRoot, worktreePath).join("\n");
  return a === b;
}

export function loadContractFile(path: string): LocalCliTaskContract {
  const raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
  const contract = assertLocalCliTaskContract(raw);
  if (!contract.frozen) {
    throw new Error("idle-spin requires frozen=true");
  }
  // M3: if a sha256 sidecar exists, refuse silently mutated frozen bytes.
  assertFrozenImmutable(path);
  return contract;
}

/**
 * Prepare worktree, spawn local-cli argv with cwd locked to the worktree,
 * run verify commands, and check that the main checkout stayed clean.
 */
export async function runIdleSpin(input: {
  repoRoot: string;
  contract: LocalCliTaskContract;
  /** When true, remove an existing worktree at the same path first. */
  replaceExisting?: boolean;
  /** M2: abort cancels the local-cli child (process group). */
  signal?: AbortSignal;
  /** Override dispose registry (defaults to shared in-process registry). */
  registry?: DisposeRegistry;
}): Promise<IdleSpinResult> {
  const repoRoot = resolve(input.repoRoot);
  const contract = input.contract;
  const registry = input.registry ?? defaultDisposeRegistry;

  if (!contract.frozen) {
    throw new Error("idle-spin requires frozen=true");
  }
  if (contract.driver.kind !== "local-cli") {
    throw new Error(`idle-spin requires driver.kind=local-cli (got ${String(contract.driver.kind)})`);
  }
  if (contract.workspace.kind !== "git-worktree") {
    throw new Error("idle-spin v0 requires workspace.kind=git-worktree");
  }
  assertWrapDisabledOrKnown(contract.sandbox?.mode);
  if (!existsSync(join(repoRoot, ".git"))) {
    throw new Error(`not a git repository: ${repoRoot}`);
  }

  const relPath = contract.workspace.path;
  if (isAbsolute(relPath)) {
    throw new Error("workspace.path must be repo-relative");
  }
  const worktreePath = resolve(repoRoot, relPath);
  if (worktreePath === repoRoot) {
    throw new Error("workspace.path must not resolve to repoRoot");
  }
  const baseRef =
    typeof contract.workspace.baseRef === "string" &&
    contract.workspace.baseRef.trim() !== ""
      ? contract.workspace.baseRef.trim()
      : "HEAD";
  const branch = `cliyard/mvp/${slug(contract.contractId)}`;
  const argv = contract.driver.argv as string[];
  const timeoutSec = Number(contract.driver.timeoutSec) || 60;
  const env =
    contract.driver.env && typeof contract.driver.env === "object"
      ? (contract.driver.env as Record<string, string>)
      : undefined;
  const keepWorkspace = contract.cleanup.keepWorkspace !== false;

  const before = await runGit(repoRoot, ["status", "--porcelain"]);
  if (before.code !== 0) {
    throw new Error(`git status failed: ${before.stderr || before.stdout}`);
  }

  mkdirSync(resolve(repoRoot, ".cliyard", "worktrees"), { recursive: true });
  await runGit(repoRoot, ["worktree", "prune"]);

  if (existsSync(worktreePath)) {
    if (input.replaceExisting) {
      await runGit(repoRoot, ["worktree", "remove", "--force", worktreePath]);
      await runGit(repoRoot, ["branch", "-D", branch]).catch(() => undefined);
    } else {
      throw new Error(
        `worktree path already exists: ${worktreePath} (pass replaceExisting)`,
      );
    }
  }

  // Drop leftover branch name if previous force-remove left it.
  await runGit(repoRoot, ["branch", "-D", branch]).catch(() => undefined);

  const add = await runGit(repoRoot, [
    "worktree",
    "add",
    "-b",
    branch,
    worktreePath,
    baseRef,
  ]);
  if (add.code !== 0) {
    throw new Error(`git worktree add failed:\n${add.stderr || add.stdout}`);
  }

  let spawnExitCode = 1;
  let spawnPid: number | undefined;
  let disposed = false;
  let disposeReason: DisposeReason | undefined;
  let disposeInfo: DisposeResult | undefined;
  let error: string | undefined;
  try {
    const spawned = await spawnCommand({
      argv,
      cwd: worktreePath,
      env,
      timeoutSec,
      signal: input.signal,
      detached: true,
      registry,
    });
    spawnExitCode = spawned.code;
    spawnPid = spawned.pid;
    disposed = spawned.disposed;
    disposeReason = spawned.disposeReason;
    disposeInfo = spawned.dispose;
    if (spawned.disposed) {
      error = `disposed (${spawned.disposeReason ?? "abort"})`;
    } else if (spawned.code !== 0) {
      error = `spawn exit ${spawned.code}: ${spawned.stderr || spawned.stdout}`;
    }
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
    spawnExitCode = 1;
  }

  const verify: Array<{ argv: string[]; exitCode: number }> = [];
  if (spawnExitCode === 0 && !disposed) {
    for (const cmd of contract.verify.commands) {
      const cwd =
        cmd.cwd === "repo" ? repoRoot : worktreePath;
      if (cwd === repoRoot && cmd.cwd !== "repo") {
        // fail closed — never verify in repoRoot unless explicit
        verify.push({ argv: cmd.argv, exitCode: 1 });
        error = error ?? "verify refused: cwd would be repoRoot";
        continue;
      }
      try {
        const res = await spawnCommand({
          argv: cmd.argv,
          cwd,
          timeoutSec: Math.min(timeoutSec, 120),
          signal: input.signal,
          detached: false,
        });
        verify.push({ argv: cmd.argv, exitCode: res.code });
        if (res.disposed) {
          disposed = true;
          disposeReason = res.disposeReason;
          disposeInfo = res.dispose;
          error = error ?? `disposed during verify (${res.disposeReason})`;
        } else if (res.code !== 0 && !error) {
          error = `verify failed (${cmd.argv.join(" ")}): exit ${res.code}`;
        }
      } catch (err) {
        verify.push({ argv: cmd.argv, exitCode: 1 });
        error =
          error ??
          (err instanceof Error ? err.message : String(err));
      }
    }
  }

  const after = await runGit(repoRoot, ["status", "--porcelain"]);
  const trunkClean =
    after.code === 0 &&
    trunkProductClean(before.stdout, after.stdout, repoRoot, worktreePath);
  if (!trunkClean && !error) {
    const leaked = productPorcelainLines(
      after.stdout,
      repoRoot,
      worktreePath,
    ).join("\n");
    error = `trunk product dirty after idle-spin:\n${leaked || after.stdout}`;
  }

  if (!keepWorkspace) {
    await runGit(repoRoot, ["worktree", "remove", "--force", worktreePath]);
    await runGit(repoRoot, ["branch", "-D", branch]).catch(() => undefined);
  }

  const verifyOk =
    !disposed &&
    spawnExitCode === 0 &&
    verify.length === contract.verify.commands.length &&
    verify.every((v) => v.exitCode === 0);

  return {
    ok: verifyOk && trunkClean && !error,
    contractId: contract.contractId,
    target: String(contract.driver.target),
    repoRoot,
    worktreePath,
    branch,
    spawnCwd: worktreePath,
    spawnExitCode,
    ...(spawnPid !== undefined ? { spawnPid } : {}),
    verify,
    trunkClean,
    keptWorkspace: keepWorkspace,
    disposed,
    ...(disposeReason ? { disposeReason } : {}),
    ...(disposeInfo ? { dispose: disposeInfo } : {}),
    ...(error ? { error } : {}),
  };
}

export async function runIdleSpinFromFile(input: {
  repoRoot: string;
  contractPath: string;
  replaceExisting?: boolean;
  signal?: AbortSignal;
  registry?: DisposeRegistry;
}): Promise<IdleSpinResult> {
  const contract = loadContractFile(input.contractPath);
  return runIdleSpin({
    repoRoot: input.repoRoot,
    contract,
    ...(input.replaceExisting !== undefined
      ? { replaceExisting: input.replaceExisting }
      : {}),
    ...(input.signal ? { signal: input.signal } : {}),
    ...(input.registry ? { registry: input.registry } : {}),
  });
}

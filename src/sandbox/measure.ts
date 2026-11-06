/**
 * Measure whether a pinned nono binary actually enforces filesystem
 * isolation on this host (design/sandbox-nono-worker-wrap-v0.md).
 *
 * A version probe is not enough: kernels without Landlock (observed in some
 * cloud images) may still allow writes outside the allowlist.
 */
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NONO_PINNED_VERSION } from "./pin.js";

export interface NonoFilesystemEnforcementMeasurement {
  enforced: boolean;
  nonoVersion: string | null;
  binaryPath: string;
  /** Inside-allow write succeeded. */
  allowWriteOk: boolean;
  /** Outside-allow path remained absent (or write failed). */
  denyWriteHeld: boolean;
  detail: string;
  measuredAt: string;
}

export interface MeasureNonoFilesystemEnforcementOptions {
  binaryPath?: string;
  /** Injected runner for tests. */
  run?: (argv: string[], cwd: string) => {
    status: number | null;
    stdout: string;
    stderr: string;
  };
  now?: () => string;
}

/**
 * Run a bounded allow/deny write probe under `nono wrap`.
 */
export function measureNonoFilesystemEnforcement(
  options: MeasureNonoFilesystemEnforcementOptions = {},
): NonoFilesystemEnforcementMeasurement {
  const binaryPath = options.binaryPath?.trim() || "nono";
  const measuredAt = options.now?.() ?? new Date().toISOString();
  const root = mkdtempSync(join(tmpdir(), "cliyard-nono-measure-"));
  const allowDir = join(root, "allow");
  const denyDir = join(root, "deny");
  mkdirSync(allowDir, { recursive: true });
  mkdirSync(denyDir, { recursive: true });
  const allowFile = join(allowDir, "inside.txt");
  const denyFile = join(denyDir, "outside.txt");
  // Script writes inside allowlist then attempts outside; prints markers.
  const script = [
    `echo inside > "${allowFile}"`,
    `echo outside > "${denyFile}" 2>/dev/null || true`,
    `if [ -f "${allowFile}" ]; then echo ALLOW_OK; else echo ALLOW_FAIL; fi`,
    `if [ -f "${denyFile}" ]; then echo DENY_LEAK; else echo DENY_HELD; fi`,
  ].join("; ");

  try {
    const argv = [
      "wrap",
      "-s",
      "--allow-cwd",
      "-a",
      allowDir,
      "--",
      "/bin/sh",
      "-c",
      script,
    ];
    const result =
      options.run?.(argv, root) ??
      (() => {
        const child = spawnSync(binaryPath, argv, {
          cwd: root,
          encoding: "utf8",
          timeout: 15_000,
          env: process.env,
        });
        return {
          status: child.status,
          stdout: child.stdout ?? "",
          stderr: child.stderr ?? "",
        };
      })();

    const output = `${result.stdout}\n${result.stderr}`;
    const allowWriteOk =
      output.includes("ALLOW_OK") ||
      (existsSync(allowFile) &&
        readFileSync(allowFile, "utf8").includes("inside"));
    const denyWriteHeld =
      output.includes("DENY_HELD") || !existsSync(denyFile);
    // If the deny file exists with content, enforcement failed.
    if (existsSync(denyFile)) {
      // prefer filesystem truth over markers
    }
    const denyLeaked = existsSync(denyFile);
    const enforced = allowWriteOk && !denyLeaked && denyWriteHeld;

    let version: string | null = null;
    try {
      const ver = spawnSync(binaryPath, ["--version"], {
        encoding: "utf8",
        timeout: 5_000,
      });
      const match = (ver.stdout || "").match(/(\d+\.\d+\.\d+)/);
      version = match?.[1] ?? null;
    } catch {
      version = null;
    }

    const detail = enforced
      ? `nono filesystem enforcement measured ok (pin ${NONO_PINNED_VERSION})`
      : denyLeaked
        ? "outside-allow write persisted; host likely lacks Landlock/seatbelt enforcement"
        : !allowWriteOk
          ? "inside-allow write failed; sandbox probe inconclusive"
          : `enforcement probe inconclusive (status=${String(result.status)})`;

    return {
      enforced,
      nonoVersion: version,
      binaryPath,
      allowWriteOk,
      denyWriteHeld: !denyLeaked,
      detail,
      measuredAt,
    };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/** Test helper: write a stub nono that never enforces. */
export function writeNonEnforcingNonoStub(path: string): void {
  writeFileSync(
    path,
    `#!/bin/sh
# stub nono: pretend wrap and run the trailing command without isolation
if [ "$1" = "--version" ]; then echo "nono ${NONO_PINNED_VERSION}"; exit 0; fi
if [ "$1" = "wrap" ]; then
  while [ "$#" -gt 0 ]; do
    if [ "$1" = "--" ]; then shift; break; fi
    shift
  done
  exec "$@"
fi
exit 1
`,
    "utf8",
  );
  chmodSync(path, 0o755);
}

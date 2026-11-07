#!/usr/bin/env npx tsx
/**
 * P3c live smoke: prepareWorkerSandbox + nono wrap of a finite shell probe.
 *
 * Cursor CLI is preferred when `cursor` / CURSOR_CLI / CLIYARD_WORKER_BINARY
 * is present; otherwise pinned nono wraps `/bin/sh` (this host's acceptance
 * path when Cursor CLI is absent from PATH).
 */
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
  NONO_PINNED_VERSION,
  prepareWorkerSandbox,
  wrapWorkerCommand,
} from "../src/sandbox/index.js";

function resolveNonoBinary(): string {
  const candidates = [
    process.env.CLIYARD_NONO_BINARY,
    "/tmp/nono-pin/nono",
    join(homedir(), ".local", "bin", "nono"),
    "nono",
  ].filter((v): v is string => typeof v === "string" && v.trim() !== "");
  for (const c of candidates) {
    if (c === "nono") {
      const which = spawnSync("which", ["nono"], { encoding: "utf8" });
      if (which.status === 0 && which.stdout.trim()) return which.stdout.trim();
      continue;
    }
    if (existsSync(c)) return c;
  }
  throw new Error("pinned nono binary not found (expected /tmp/nono-pin/nono)");
}

function resolveOptionalCursorCli(): string | null {
  const candidates = [
    process.env.CURSOR_CLI,
    process.env.CLIYARD_WORKER_BINARY,
    "cursor",
  ].filter((v): v is string => typeof v === "string" && v.trim() !== "");
  for (const c of candidates) {
    if (c.includes("/")) {
      if (existsSync(c)) return c;
      continue;
    }
    const which = spawnSync("which", [c], { encoding: "utf8" });
    if (which.status === 0 && which.stdout.trim()) return which.stdout.trim();
  }
  return null;
}

async function main(): Promise<void> {
  const nonoBinary = resolveNonoBinary();
  const version = spawnSync(nonoBinary, ["--version"], { encoding: "utf8" });
  if (version.status !== 0) {
    throw new Error(`nono --version failed: ${version.stderr || version.stdout}`);
  }
  const reported = (version.stdout || "").trim();
  if (!reported.includes(NONO_PINNED_VERSION)) {
    throw new Error(
      `nono pin mismatch: want ${NONO_PINNED_VERSION}, got ${reported}`,
    );
  }

  const cursorCli = resolveOptionalCursorCli();
  const work = mkdtempSync(join(homedir(), ".cache", "cliyard", "p3c-smoke-"));
  const allowDir = join(work, "allow");
  const denyDir = join(work, "deny");
  mkdirSync(allowDir, { recursive: true });
  mkdirSync(denyDir, { recursive: true });
  const allowMarker = join(allowDir, "ok.txt");
  const denyMarker = join(denyDir, "should-not.txt");

  try {
    const prepared = await prepareWorkerSandbox({
      workspaceRoot: allowDir,
      options: {
        enabled: true,
        repoRoot: work,
        nonoBinary,
      },
    });
    if (!prepared || !prepared.ok) {
      throw new Error(
        `prepare refused: ${prepared?.report.gaps.join("; ") ?? "null"} ` +
          `(status=${prepared?.report.status ?? "n/a"})`,
      );
    }

    const shellProbe = [
      "#!/bin/sh",
      `printf 'inside\\n' > ${JSON.stringify(allowMarker)}`,
      `printf 'outside\\n' > ${JSON.stringify(denyMarker)} || true`,
      "exit 0",
      "",
    ].join("\n");
    const probePath = join(work, "probe.sh");
    writeFileSync(probePath, shellProbe, { mode: 0o755 });

    const wrapped = wrapWorkerCommand("/bin/sh", [probePath], prepared);
    const run = spawnSync(wrapped.command, wrapped.args, {
      cwd: allowDir,
      encoding: "utf8",
      env: process.env,
      timeout: 15_000,
    });

    const allowOk = existsSync(allowMarker);
    const denyHeld = !existsSync(denyMarker);
    const evidence = {
      pin: NONO_PINNED_VERSION,
      nonoBinary,
      cursorCli: cursorCli ?? null,
      cursorCliNote:
        cursorCli === null
          ? "Cursor CLI not on PATH; acceptance used nono-wrapped /bin/sh"
          : "Cursor CLI present (optional worker binary; shell probe still used for FS measure)",
      prepareStatus: prepared.report.status,
      filesystemIsolation: prepared.report.capabilities.filesystemIsolation,
      wrapCommand: wrapped.command,
      wrapArgvHead: wrapped.args.slice(0, 8),
      probeExit: run.status,
      allowWriteOk: allowOk,
      denyWriteHeld: denyHeld,
      stderr: (run.stderr || "").trim().slice(0, 400),
      measuredAt: new Date().toISOString(),
    };

    if (
      prepared.report.capabilities.filesystemIsolation !== "partial" ||
      !allowOk ||
      !denyHeld ||
      run.status !== 0
    ) {
      console.error(JSON.stringify(evidence, null, 2));
      throw new Error("p3c smoke failed: wrap did not enforce partial FS isolation");
    }

    console.log(JSON.stringify(evidence, null, 2));
    console.log("p3c smoke ok");
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { takeTestPortRange } from "./test-port-ranges.js";
import { probePort } from "../src/runtime/ports.js";
import {
  DRILL_CLEANUP_RELEASE_FAULT,
  DRILL_SCENARIOS,
  RUNTIME_FAILURE_DRILL_FILE,
  RUNTIME_FAILURE_DRILL_REPORT_VERSION,
  type RuntimeFailureDrillReport,
} from "../src/runtime/failure-drills.js";
import { isProcessAlive } from "../src/supervisor/store.js";
import type { RuntimeManifest } from "../src/runtime/types.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const CLI_PATH = fileURLToPath(new URL("../src/cli.ts", import.meta.url));

interface CliRun {
  status: number | null;
  stdout: string;
  stderr: string;
}

function runCli(args: string[]): Promise<CliRun> {
  return new Promise<CliRun>((resolveRun, rejectRun) => {
    const child = spawn(
      process.execPath,
      ["--import", "tsx", CLI_PATH, ...args],
      {
        cwd: ROOT,
        env: { ...process.env },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", rejectRun);
    child.on("close", (status) => resolveRun({ status, stdout, stderr }));
  });
}

function readManifest(path: string): RuntimeManifest {
  return JSON.parse(readFileSync(path, "utf8")) as RuntimeManifest;
}

function readLeaseCount(controlDir: string): number {
  const path = join(controlDir, ".cliyard", "runtime", "port-leases.json");
  if (!existsSync(path)) return 0;
  const store = JSON.parse(readFileSync(path, "utf8")) as {
    leases: unknown[];
  };
  return store.leases.length;
}

test("runtime-drill CLI runs three isolated failure scenarios and retains evidence", async () => {
  const outDir = mkdtempSync(join(tmpdir(), "cliyard-runtime-drill-"));
  const { start: portBase } = takeTestPortRange("runtime-failure-drills", 90);
  try {
    const run = await runCli([
      "runtime-drill",
      "--out",
      outDir,
      "--port-base",
      String(portBase),
      "--json",
    ]);
    assert.equal(run.status, 0, run.stderr || run.stdout);

    const report = JSON.parse(run.stdout) as RuntimeFailureDrillReport;
    assert.equal(report.version, RUNTIME_FAILURE_DRILL_REPORT_VERSION);
    assert.equal(report.kind, "runtime-failure-drills");
    assert.equal(report.status, "pass");
    assert.equal(report.portBase, portBase);
    assert.equal(report.outDir, outDir);
    assert.deepEqual(report.summary, { total: 3, passed: 3, failed: 0 });
    assert.deepEqual(
      report.scenarios.map((scenario) => scenario.name),
      [...DRILL_SCENARIOS],
    );

    const reportPath = join(outDir, RUNTIME_FAILURE_DRILL_FILE);
    assert.equal(existsSync(reportPath), true, "missing report file");
    assert.deepEqual(
      JSON.parse(readFileSync(reportPath, "utf8")) as RuntimeFailureDrillReport,
      report,
    );

    assert.equal(
      report.portBase,
      portBase,
      "the drill must use the explicit base",
    );

    for (const [index, scenario] of report.scenarios.entries()) {
      assert.equal(scenario.status, "pass", JSON.stringify(scenario.checks));
      assert.equal(scenario.accepted, false);
      assert.equal(scenario.rejectionObserved, true);
      assert.equal(scenario.child.exitCode, 0);
      assert.equal(scenario.child.signal, null);
      assert.equal(scenario.child.timedOut, false);
      assert.ok(scenario.child.pid, "child pid must be recorded");
      assert.ok(scenario.child.durationMs >= 0);
      assert.ok(scenario.checks.every((check) => check.ok));
      assert.ok(scenario.artifacts.scenarioDir.startsWith(outDir));
      assert.equal(existsSync(scenario.child.logPath), true);
      assert.equal(existsSync(scenario.child.resultPath), true);
      assert.equal(existsSync(scenario.artifacts.controlDir), true);
      assert.equal(existsSync(scenario.artifacts.worktreeDir), true);

      // Each child owns a disjoint 30-port subrange.
      const expectedStart = portBase + index * 30;
      const port = scenario.runtime?.services[0]?.port ?? 0;
      assert.ok(
        port >= expectedStart && port <= expectedStart + 29,
        `port ${port} is outside ${expectedStart}-${expectedStart + 29}`,
      );

      assert.ok(scenario.runtime, `missing runtime evidence for ${scenario.name}`);
      assert.equal(scenario.runtime.manifestExists, true);
      assert.equal(scenario.runtime.portFree, true);
      assert.equal(scenario.runtime.processGone, true);
      assert.equal(scenario.artifacts.manifestPath, scenario.runtime.manifestPath);
      assert.ok(existsSync(scenario.runtime.manifestPath));
      assert.ok(existsSync(scenario.runtime.leaseStorePath));

      const manifest = readManifest(scenario.runtime.manifestPath);
      const service = manifest.services[0]!;
      assert.equal(manifest.runtimeId, scenario.runtime.runtimeId);
      assert.equal(service.pid, scenario.runtime.services[0]?.pid);
      assert.equal(service.pgid, service.pid);
      assert.ok(service.pid);
      assert.equal(isProcessAlive(service.pid!), false, "service survived");
      assert.equal(service.signal, "SIGTERM");
      assert.ok(service.exitedAt);
      assert.equal(await probePort(service.port), true);
      assert.equal(existsSync(service.logPath), true);
      assert.match(readFileSync(service.logPath, "utf8"), /listening/);
      assert.equal(
        readLeaseCount(scenario.artifacts.controlDir),
        scenario.name === "cleanup-failure" ? 1 : 0,
      );

      if (scenario.name === "readiness-timeout") {
        assert.equal(scenario.verify?.verdictOk, false);
        assert.equal(scenario.verify?.verifyCommandsSkipped, true);
        assert.equal(scenario.verify?.verifyCommandsRan, false);
        assert.ok(
          scenario.verify?.commandResults.every((result) => result.skipped),
        );
        assert.equal(scenario.verify?.markerExists, false);
        assert.equal(
          existsSync(join(scenario.artifacts.worktreeDir, "verify-ran.marker")),
          false,
          "verifyCommands must not run on readiness timeout",
        );
        assert.equal(manifest.cleanup, "complete");
        assert.match(manifest.failureReason ?? "", /not ready/);
        assert.ok(service.readinessAttempts.length > 0);
        assert.ok(service.readinessAttempts.every((attempt) => !attempt.ok));
        assert.ok(
          service.readinessAttempts.some((attempt) => attempt.status === 503),
        );
        assert.equal(scenario.runtime.leaseCount, 0);
      }

      if (scenario.name === "verify-failure") {
        assert.equal(scenario.verify?.verdictOk, false);
        assert.equal(scenario.verify?.exitCode, 7);
        assert.equal(scenario.verify?.verifyCommandsRan, true);
        assert.equal(scenario.verify?.verifyCommandsSkipped, false);
        assert.equal(
          scenario.verify?.commandResults.at(-1)?.exitCode,
          7,
          "the verify command exit code must be preserved",
        );
        assert.equal(scenario.verify?.markerExists, true);
        assert.equal(
          existsSync(join(scenario.artifacts.worktreeDir, "verify-ran.marker")),
          true,
        );
        assert.equal(manifest.cleanup, "complete");
        assert.equal(scenario.runtime.failureReason, null);
        assert.equal(scenario.runtime.leaseCount, 0);
      }

      if (scenario.name === "cleanup-failure") {
        assert.equal(scenario.rejectionName, "RuntimeCleanupError");
        assert.equal(scenario.verify, null);
        assert.equal(manifest.cleanup, "failed");
        assert.match(
          manifest.failureReason ?? "",
          new RegExp(DRILL_CLEANUP_RELEASE_FAULT),
        );
        assert.match(
          scenario.runtime.failureReason ?? "",
          new RegExp(DRILL_CLEANUP_RELEASE_FAULT),
        );
        assert.equal(scenario.runtime.leaseCount, 1);
        // The failed lease is intentionally retained as evidence.
        const store = JSON.parse(
          readFileSync(scenario.runtime.leaseStorePath, "utf8"),
        ) as { leases: Array<{ key: string }> };
        assert.deepEqual(
          store.leases.map((lease) => lease.key),
          [`${scenario.runtime.runtimeId}:web`],
        );
        // Even a ready service with completed callback work is never accepted.
        assert.equal(scenario.accepted, false);
      }
    }
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
});

test("runtime-drill validates the whole port range before spawning children", async () => {
  const outDir = mkdtempSync(join(tmpdir(), "cliyard-runtime-drill-invalid-"));
  try {
    const run = await runCli([
      "runtime-drill",
      "--out",
      outDir,
      "--port-base",
      "65530",
      "--json",
    ]);
    assert.notEqual(run.status, 0);
    assert.match(run.stderr, /maximum TCP port|requires ports/);
    assert.equal(existsSync(join(outDir, RUNTIME_FAILURE_DRILL_FILE)), false);
    assert.deepEqual(
      DRILL_SCENARIOS.filter((name) => existsSync(join(outDir, name))),
      [],
    );
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
});

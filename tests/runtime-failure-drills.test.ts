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
  DRILL_HANG_AFTER_READY_ENV,
  DRILL_SCENARIOS,
  RUNTIME_FAILURE_DRILL_FILE,
  RUNTIME_FAILURE_DRILL_REPORT_VERSION,
  runRuntimeDrill,
  type RuntimeFailureDrillReport,
} from "../src/runtime/failure-drills.js";
import { isProcessAlive } from "../src/supervisor/store.js";
import type { RuntimeManifest } from "../src/runtime/types.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const CLI_PATH = fileURLToPath(new URL("../src/cli.ts", import.meta.url));

let drillPortBase: number | undefined;

/**
 * The drill needs 90 ports (three disjoint 30-port subranges) and this file's
 * pool is 100 ports, so only one drill window fits. Node runs tests in a file
 * sequentially and each drill waits for all of its children, so a later test
 * can reuse the base after the previous drill released every port.
 */
function takeDrillPortBase(): number {
  drillPortBase ??= takeTestPortRange("runtime-failure-drills", 90).start;
  return drillPortBase;
}

/**
 * How long the post-drill port assertions wait for a port to become bindable.
 *
 * The static drill pool (22600-22699) is shared by every checkout that runs
 * these tests on this host, so a concurrent drill can hold a port for a couple
 * of seconds right after this drill releases it. A single probe would then
 * report a false failure for a service that really is gone. A leaked service
 * never releases its port, so the deadline still fails the test.
 */
const PORT_FREE_TIMEOUT_MS = 15_000;
const PORT_FREE_POLL_MS = 100;

async function waitForPortFree(port: number): Promise<boolean> {
  const deadline = Date.now() + PORT_FREE_TIMEOUT_MS;
  for (;;) {
    if (await probePort(port)) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((resolveDelay) => {
      setTimeout(resolveDelay, PORT_FREE_POLL_MS);
    });
  }
}

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
  const portBase = takeDrillPortBase();
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
      assert.equal(
        scenario.abnormalRecovery,
        null,
        "the normal path must not run abnormal recovery",
      );
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
      assert.equal(
        await waitForPortFree(service.port),
        true,
        `port ${service.port} was not free after cleanup`,
      );
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

test("runtime-drill recovers a child that hangs after readiness", async () => {
  const outDir = mkdtempSync(join(tmpdir(), "cliyard-runtime-drill-abnormal-"));
  const portBase = takeDrillPortBase();
  const previousHook = process.env[DRILL_HANG_AFTER_READY_ENV];
  process.env[DRILL_HANG_AFTER_READY_ENV] = "cleanup-failure";
  try {
    // A short timeout keeps the focused test fast. The hook only applies to
    // cleanup-failure, so the other two scenarios still take the normal path.
    const report = await runRuntimeDrill({
      outDir,
      portBase,
      childTimeoutMs: 5_000,
    });

    assert.equal(report.status, "fail");
    assert.deepEqual(report.summary, { total: 3, passed: 2, failed: 1 });

    const scenario = report.scenarios.find(
      (entry) => entry.name === "cleanup-failure",
    );
    assert.ok(scenario, "missing cleanup-failure scenario");

    // The abnormal child is terminated, never accepted.
    assert.equal(scenario.status, "fail");
    assert.equal(scenario.accepted, false);
    assert.equal(scenario.child.timedOut, true);
    assert.ok(scenario.child.pid, "child pid must be recorded");
    assert.equal(
      isProcessAlive(scenario.child.pid),
      false,
      "the drill child survived termination",
    );
    assert.equal(scenario.child.signal, "SIGKILL");
    assert.match(
      readFileSync(scenario.child.logPath, "utf8"),
      /test hook hanging after readiness/,
      "the test-only hang hook must be what armed the timeout",
    );
    assert.match(
      readFileSync(scenario.child.logPath, "utf8"),
      /test hook ignoring SIGTERM/,
      "the hook must ignore SIGTERM so the parent escalates to SIGKILL",
    );
    assert.equal(
      scenario.checks.find((check) => check.id === "child-exit")?.ok,
      false,
    );
    assert.equal(
      scenario.checks.find((check) => check.id === "not-accepted")?.ok,
      true,
    );

    const recovery = scenario.abnormalRecovery;
    assert.ok(recovery, "abnormalRecovery must be persisted");
    assert.equal(recovery.trigger, "timeout");
    assert.equal(recovery.executed, true);
    assert.equal(recovery.error, null);
    assert.equal(
      recovery.controlDir,
      scenario.artifacts.controlDir,
      "recovery must scan this scenario's scratch control root",
    );
    assert.equal(recovery.childTermination.sigtermSent, true);
    assert.equal(
      recovery.childTermination.sigkillSent,
      true,
      "the hook ignores SIGTERM, so the parent must escalate to SIGKILL",
    );
    assert.equal(recovery.childTermination.exited, true);
    assert.match(recovery.childTermination.detail ?? "", /SIGKILL/);

    // The exact orphan executor, not the parent, proved ownership and reaped
    // the service group and lease.
    const executor = recovery.report;
    assert.ok(executor, "missing executor report");
    assert.equal(executor.needsHuman.length, 0);
    assert.equal(executor.skipped.length, 0);
    assert.equal(executor.reaped.length, 1);
    const record = executor.reaped[0]!;
    assert.equal(record.state, "reaped");
    assert.equal(record.runtimeId, scenario.runtime?.runtimeId);
    assert.equal(record.services.length, 1);
    assert.equal(record.services[0]?.action, "terminated");
    assert.equal(record.services[0]?.portReleased, true);

    // The drill's own post-recovery checks agree with the executor report.
    for (const id of [
      "manifest-cleanup",
      "manifest-recovery-reaped",
      "services-process-gone",
      "services-process-group-gone",
      "services-port-free",
      "abnormal-recovery-no-needs-human",
      "abnormal-recovery-complete",
      "not-accepted",
    ]) {
      assert.equal(
        scenario.checks.find((check) => check.id === id)?.ok,
        true,
        `${id} must pass after recovery`,
      );
    }

    // Normal manifest/log/process/port checks were re-run after recovery.
    const runtime = scenario.runtime;
    assert.ok(runtime, "missing post-recovery runtime evidence");
    assert.equal(runtime.manifestExists, true);
    assert.equal(runtime.cleanup, "complete");
    assert.equal(runtime.processGone, true);
    assert.equal(runtime.portFree, true);
    assert.equal(runtime.leaseCount, 0);
    assert.equal(scenario.artifacts.manifestPath, runtime.manifestPath);
    assert.ok(existsSync(runtime.manifestPath));
    assert.ok(existsSync(runtime.leaseStorePath));

    const manifest = readManifest(runtime.manifestPath);
    assert.equal(manifest.cleanup, "complete");
    assert.equal(manifest.recovery?.state, "reaped");
    assert.equal(manifest.recovery?.runtimeId, runtime.runtimeId);
    const service = manifest.services[0]!;
    assert.equal(isProcessAlive(service.pid!), false, "service survived");
    assert.equal(service.pgid, service.pid);
    assert.ok(service.pgid, "service pgid must be recorded");
    if (process.platform !== "win32") {
      // The service is spawned detached, so its leader pid is the group id.
      assert.throws(
        () => process.kill(-service.pgid!, 0),
        { code: "ESRCH" },
        "service process group survived recovery",
      );
    }
    assert.equal(
      await waitForPortFree(service.port),
      true,
      "service port is not free",
    );
    assert.equal(readLeaseCount(scenario.artifacts.controlDir), 0);
    assert.equal(existsSync(service.logPath), true);
    assert.match(readFileSync(service.logPath, "utf8"), /listening/);

    // The persisted report preserves the abnormal recovery section.
    const diskReport = JSON.parse(
      readFileSync(join(outDir, RUNTIME_FAILURE_DRILL_FILE), "utf8"),
    ) as RuntimeFailureDrillReport;
    assert.deepEqual(diskReport, report);
    assert.deepEqual(
      diskReport.scenarios.find((entry) => entry.name === "cleanup-failure")
        ?.abnormalRecovery,
      recovery,
    );

    // Only the armed scenario took the abnormal path.
    for (const name of ["readiness-timeout", "verify-failure"] as const) {
      const other = report.scenarios.find((entry) => entry.name === name);
      assert.ok(other);
      assert.equal(other.status, "pass", JSON.stringify(other.checks));
      assert.equal(other.abnormalRecovery, null);
    }
  } finally {
    if (previousHook === undefined) {
      delete process.env[DRILL_HANG_AFTER_READY_ENV];
    } else {
      process.env[DRILL_HANG_AFTER_READY_ENV] = previousHook;
    }
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

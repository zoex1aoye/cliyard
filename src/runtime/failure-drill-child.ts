/**
 * One scenario of `cliyard runtime-drill` (design/runtime-failure-drills-v0.md).
 *
 * The parent starts this entry in a fresh OS process for each scenario and
 * supplies an isolated scratch control repository, worktree and port subrange.
 * The child creates the fixture service and verify command, drives the real
 * RuntimeManager (directly or through the shell Verifier), collects the
 * observed failure plus cleanup evidence, and writes `child-result.json`.
 *
 * The child exits 0 only when every expected check passes. The parent still
 * re-checks the exit status, the report, the persisted manifest, the lease
 * store and the final port/process state independently.
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentResult } from "../agents/types.js";
import type { TaskContract } from "../contracts/schema.js";
import { createShellVerifier } from "../verification/verifier.js";
import {
  RuntimeCleanupError,
  RuntimeManager,
  type RuntimePortAllocator,
} from "./manager.js";
import { PortAllocator, parsePortRange, probePort } from "./ports.js";
import type {
  RuntimeCleanupState,
  RuntimeManifest,
  RuntimeSpec,
} from "./types.js";
import {
  DRILL_CLEANUP_RELEASE_FAULT,
  DRILL_EXPECTED_FAILURES,
  DRILL_HANG_AFTER_READY_ENV,
  DRILL_SCENARIOS,
  type DrillCheck,
  type DrillChildResult,
  type DrillCommandResult,
  type DrillObservedEvidence,
  type DrillRuntimeEvidence,
  type DrillScenarioName,
  type DrillServiceEvidence,
  type DrillVerifyEvidence,
} from "./failure-drills.js";

interface ChildArgs {
  scenario: DrillScenarioName;
  scenarioDir: string;
  controlDir: string;
  worktreeDir: string;
  portRange: { start: number; end: number };
}

interface ScenarioOutcome {
  checks: DrillCheck[];
  observed: DrillObservedEvidence;
}

interface DrillFixtures {
  serverScript: string;
  writeMarkerScript: string;
  exit7Script: string;
}

const HEALTH_TIMEOUT_MS = 5_000;
const READINESS_TIMEOUT_MS = 1_200;
const READINESS_POLL_MS = 100;
const STOP_GRACE_MS = 2_000;
const PORT_RELEASE_TIMEOUT_MS = 3_000;
const LOG_TAIL_BYTES = 2_048;

const SERVER_SOURCE = String.raw`
const http = require("node:http");

const port = Number(process.env.PORT);
const healthStatus = Number(process.env.DRILL_HEALTH_STATUS || "200");

const server = http.createServer((req, res) => {
  console.log(req.method + " " + req.url);
  if (req.url === "/health") {
    res.writeHead(healthStatus, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: healthStatus === 200 }));
    return;
  }
  res.writeHead(200, { "content-type": "text/plain" });
  res.end("runtime drill");
});

server.listen(port, "127.0.0.1", () => {
  console.log("drill service listening on " + port);
});
`;

const WRITE_MARKER_SOURCE = String.raw`
const fs = require("node:fs");
const marker = process.argv[2];
fs.writeFileSync(marker, "verify command ran\n", "utf8");
console.log("drill verify command ran");
`;

const EXIT7_SOURCE = String.raw`
const fs = require("node:fs");
const marker = process.argv[2];
fs.writeFileSync(marker, "verify command ran\n", "utf8");
console.error("drill verify command exits 7");
process.exit(7);
`;

async function main(): Promise<void> {
  const startedAt = Date.now();
  let args: ChildArgs | undefined;
  let checks: DrillCheck[] = [];
  let observed = emptyObserved();
  let error: string | null = null;

  try {
    args = parseArgs(process.argv.slice(2));
    mkdirSync(args.scenarioDir, { recursive: true });
    mkdirSync(args.controlDir, { recursive: true });
    mkdirSync(args.worktreeDir, { recursive: true });

    const outcome =
      args.scenario === "cleanup-failure"
        ? await runCleanupFailure(args)
        : await runVerifierScenario(args);
    checks = outcome.checks;
    observed = outcome.observed;
  } catch (caught) {
    error = errorMessage(caught);
    checks = [...checks, { id: "scenario-error", ok: false, detail: error }];
  }

  if (args === undefined) {
    console.error(`[runtime-drill-child] ${error ?? "invalid arguments"}`);
    process.exitCode = 2;
    return;
  }

  const finishedAt = Date.now();
  const result: DrillChildResult = {
    version: 1,
    scenario: args.scenario,
    expectedFailure: DRILL_EXPECTED_FAILURES[args.scenario],
    status:
      error === null && checks.length > 0 && checks.every((entry) => entry.ok)
        ? "pass"
        : "fail",
    startedAt: new Date(startedAt).toISOString(),
    finishedAt: new Date(finishedAt).toISOString(),
    durationMs: finishedAt - startedAt,
    checks,
    observed,
    artifacts: {
      scenarioDir: args.scenarioDir,
      controlDir: args.controlDir,
      worktreeDir: args.worktreeDir,
      childResultPath: join(args.scenarioDir, "child-result.json"),
    },
    error,
  };

  writeFileSync(
    result.artifacts.childResultPath,
    JSON.stringify(result, null, 2) + "\n",
    "utf8",
  );
  console.log(`[runtime-drill-child] ${args.scenario} ${result.status}`);
  process.exitCode = result.status === "pass" ? 0 : 1;
}

// ---------------------------------------------------------------------------
// Verifier scenarios: readiness timeout and verify-command exit 7
// ---------------------------------------------------------------------------

async function runVerifierScenario(
  args: ChildArgs,
): Promise<ScenarioOutcome> {
  const scenario = args.scenario as "readiness-timeout" | "verify-failure";
  const fixtures = writeFixtures(args.worktreeDir);
  const markerPath = join(args.worktreeDir, "verify-ran.marker");
  rmSync(markerPath, { force: true });

  const healthStatus = scenario === "readiness-timeout" ? 503 : 200;
  const readinessTimeout =
    scenario === "readiness-timeout"
      ? READINESS_TIMEOUT_MS
      : HEALTH_TIMEOUT_MS;
  const verifyScript =
    scenario === "readiness-timeout"
      ? fixtures.writeMarkerScript
      : fixtures.exit7Script;
  const verifyCommand = [
    shellQuote(process.execPath),
    shellQuote(verifyScript),
    shellQuote(markerPath),
  ].join(" ");

  const contract: TaskContract = {
    taskId:
      scenario === "readiness-timeout"
        ? "drill-readiness-timeout"
        : "drill-verify-failure",
    version: 1,
    frozen: true,
    goals: [
      scenario === "readiness-timeout"
        ? "observe a readiness deadline without running verifyCommands"
        : "observe a verify command exiting 7 after readiness",
    ],
    dependsOn: [],
    readPaths: ["."],
    writePaths: ["src/"],
    sharedResources: [],
    baseCommit: "HEAD",
    verifyCommands: [verifyCommand],
    maxRepairs: 0,
    runtime: {
      services: [
        {
          name: "web",
          command: [process.execPath, fixtures.serverScript],
          urlEnv: "WEB_URL",
          readiness: {
            path: "/health",
            expectedStatus: 200,
            timeoutMs: readinessTimeout,
          },
        },
      ],
    },
  };

  const verifier = createShellVerifier({
    cwd: args.worktreeDir,
    repoRoot: args.controlDir,
    worktree: args.worktreeDir,
    env: {
      ...process.env,
      CLIYARD_PORT_RANGE: `${args.portRange.start}-${args.portRange.end}`,
      DRILL_HEALTH_STATUS: String(healthStatus),
    },
  });

  const result = await verifier.run(contract, okAgent());
  const markerExists = existsSync(markerPath);
  const commandResults: DrillCommandResult[] = result.commandResults.map(
    (entry) => ({
      command: entry.command,
      exitCode: entry.exitCode,
      skipped: entry.log.startsWith("[shell-verify] skipped"),
      log: entry.log,
    }),
  );
  const verify: DrillVerifyEvidence = {
    verdictOk: result.ok,
    exitCode: result.exitCode,
    verifyCommandsSkipped:
      commandResults.length > 0 &&
      commandResults.every((entry) => entry.skipped),
    verifyCommandsRan: commandResults.some((entry) => !entry.skipped),
    markerPath,
    markerExists,
    commandResults,
  };

  const runtime = result.runtime
    ? await collectRuntimeEvidence(
        args.controlDir,
        result.runtime.runtimeId,
        result.runtime.manifestPath,
        result.runtime.manifest,
      )
    : null;

  const observed: DrillObservedEvidence = {
    accepted: result.ok,
    rejectionObserved: result.ok === false,
    rejectionName: null,
    rejectionMessage: result.logTail,
    verify,
    runtime,
    failureReason: runtime?.failureReason ?? null,
  };

  const checks: DrillCheck[] = [
    {
      id: "verifier-rejected",
      ok: result.ok === false,
      detail: `ok=${result.ok} exit=${result.exitCode}`,
    },
    { id: "not-accepted", ok: observed.accepted === false },
    ...runtimeChecks(runtime, {
      cleanup: "complete",
      leaseCount: 0,
      readiness:
        scenario === "readiness-timeout" ? "never-ready" : "ready",
      ...(scenario === "readiness-timeout"
        ? { failureReason: /not ready/i }
        : {}),
    }),
  ];

  if (scenario === "readiness-timeout") {
    checks.push({
      id: "verify-commands-skipped",
      ok: verify.verifyCommandsSkipped && !verify.verifyCommandsRan,
      detail: `skipped=${verify.verifyCommandsSkipped} ran=${verify.verifyCommandsRan}`,
    });
    checks.push({
      id: "verify-command-records",
      ok:
        commandResults.length === contract.verifyCommands.length &&
        commandResults.every((entry) => entry.skipped),
      detail: `${commandResults.length} command record(s)`,
    });
    checks.push({
      id: "verify-marker-absent",
      ok: markerExists === false,
      detail: markerPath,
    });
    checks.push({
      id: "verifier-rejection-exit",
      ok: result.exitCode !== 0,
      detail: `exit=${result.exitCode}`,
    });
  } else {
    checks.push({
      id: "verifier-exit-7",
      ok: result.exitCode === 7,
      detail: `exit=${result.exitCode}`,
    });
    checks.push({
      id: "verify-command-exit-7",
      ok:
        commandResults.length > 0 &&
        commandResults[commandResults.length - 1]?.exitCode === 7,
    });
    checks.push({
      id: "verify-commands-ran",
      ok: verify.verifyCommandsRan && !verify.verifyCommandsSkipped,
    });
    checks.push({
      id: "verify-marker-present",
      ok: markerExists === true,
      detail: markerPath,
    });
  }

  return { checks, observed };
}

// ---------------------------------------------------------------------------
// Cleanup-failure scenario
// ---------------------------------------------------------------------------

async function runCleanupFailure(args: ChildArgs): Promise<ScenarioOutcome> {
  const fixtures = writeFixtures(args.worktreeDir);
  const inner = new PortAllocator({
    repoRoot: args.controlDir,
    range: args.portRange,
  });
  let releaseAttempts = 0;
  const allocator: RuntimePortAllocator = {
    allocate: (runId, service) => inner.allocate(runId, service),
    async release(): Promise<boolean> {
      releaseAttempts += 1;
      throw new Error(DRILL_CLEANUP_RELEASE_FAULT);
    },
  };

  const manager = new RuntimeManager({
    repoRoot: args.controlDir,
    worktree: args.worktreeDir,
    taskId: "drill-cleanup-failure",
    attempt: 1,
    runtimeId: "drill-cleanup-failure-attempt-1",
    allocator,
    env: { ...process.env, DRILL_HEALTH_STATUS: "200" },
    readinessPollMs: 25,
    stopGraceMs: STOP_GRACE_MS,
    portReleaseTimeoutMs: PORT_RELEASE_TIMEOUT_MS,
  });

  const spec: RuntimeSpec = {
    services: [
      {
        name: "web",
        command: [process.execPath, fixtures.serverScript],
        urlEnv: "WEB_URL",
        readiness: {
          path: "/health",
          expectedStatus: 200,
          timeoutMs: HEALTH_TIMEOUT_MS,
        },
      },
    ],
  };

  let callbackRan = false;
  let rejection: unknown;
  try {
    await manager.run(spec, async () => {
      callbackRan = true;
      // Test-only: hang after readiness while the service is still live, so a
      // parent timeout leaves a real orphan for the exact executor to reap.
      await maybeHangAfterReadiness(args.scenario);
    });
  } catch (error) {
    rejection = error;
  }

  const runtime = await collectRuntimeEvidence(
    args.controlDir,
    manager.runtimeId,
    manager.manifestPath,
    readManifestIfAny(manager.manifestPath) ?? undefined,
  );

  const observed: DrillObservedEvidence = {
    // The callback may have completed, but the runtime API must never report
    // acceptance when cleanup failed.
    accepted: callbackRan && rejection === undefined,
    rejectionObserved: rejection !== undefined,
    rejectionName: rejection instanceof Error ? rejection.name : null,
    rejectionMessage:
      rejection === undefined ? null : errorMessage(rejection),
    verify: null,
    runtime,
    failureReason: runtime?.failureReason ?? null,
  };

  const checks: DrillCheck[] = [
    {
      id: "runtime-rejected",
      ok: rejection !== undefined,
      detail:
        rejection === undefined
          ? "manager.run resolved"
          : observed.rejectionName ?? "unknown rejection",
    },
    {
      id: "cleanup-error",
      ok: rejection instanceof RuntimeCleanupError,
      detail:
        rejection instanceof Error ? rejection.constructor.name : "no rejection",
    },
    {
      id: "release-attempted",
      ok: releaseAttempts > 0,
      detail: `${releaseAttempts} release attempt(s)`,
    },
    { id: "not-accepted", ok: observed.accepted === false },
    { id: "verify-not-applicable", ok: observed.verify === null },
    ...runtimeChecks(runtime, {
      cleanup: "failed",
      leaseCount: 1,
      readiness: "ready",
      failureReason: new RegExp(DRILL_CLEANUP_RELEASE_FAULT),
    }),
  ];

  return { checks, observed };
}

/**
 * Test-only abnormal-recovery hook.
 *
 * Only the cleanup-failure scenario reaches this point: it drives
 * RuntimeManager directly, and the manager callback runs after readiness but
 * before cleanup. When the hook selects this scenario the child stops here
 * forever and ignores SIGTERM, forcing the parent through its bounded SIGKILL
 * escalation and then the exact orphan executor. The hook does nothing unless
 * the test-only environment variable is set for this scenario.
 */
async function maybeHangAfterReadiness(
  scenario: DrillScenarioName,
): Promise<void> {
  const raw = process.env[DRILL_HANG_AFTER_READY_ENV];
  if (raw === undefined || raw.trim() === "") return;
  const target = raw.trim();
  if (target !== scenario && target !== "1" && target !== "all") return;

  process.on("SIGTERM", () => {
    console.log(
      `[runtime-drill-child] ${scenario}: test hook ignoring SIGTERM ` +
        "after readiness",
    );
  });
  console.log(
    `[runtime-drill-child] ${scenario}: test hook hanging after readiness`,
  );
  await new Promise<void>(() => {
    /* intentionally never settles */
  });
}

// ---------------------------------------------------------------------------
// Evidence
// ---------------------------------------------------------------------------

async function collectRuntimeEvidence(
  controlDir: string,
  runtimeId: string,
  manifestPath: string,
  fallbackManifest: RuntimeManifest | undefined,
): Promise<DrillRuntimeEvidence> {
  let manifest = fallbackManifest;
  let manifestExists = false;
  try {
    const parsed = JSON.parse(readFileSync(manifestPath, "utf8")) as unknown;
    if (
      isRecord(parsed) &&
      typeof parsed.runtimeId === "string" &&
      typeof parsed.cleanup === "string" &&
      Array.isArray(parsed.services)
    ) {
      manifest = parsed as unknown as RuntimeManifest;
      manifestExists = true;
    }
  } catch {
    // Keep the in-memory fallback; manifestExists stays false.
  }

  const services: DrillServiceEvidence[] = [];
  for (const service of manifest?.services ?? []) {
    const pid = typeof service.pid === "number" ? service.pid : null;
    const pgid = typeof service.pgid === "number" ? service.pgid : null;
    const port =
      typeof service.port === "number" && Number.isInteger(service.port)
        ? service.port
        : 0;
    const logPath = typeof service.logPath === "string" ? service.logPath : "";
    const logExists = logPath !== "" && existsSync(logPath);
    const attempts = Array.isArray(service.readinessAttempts)
      ? service.readinessAttempts
      : [];
    const statuses = attempts.map((attempt) =>
      typeof attempt.status === "number" ? attempt.status : null,
    );

    let portFree = false;
    if (port > 0) {
      try {
        portFree = await probePort(port);
      } catch {
        portFree = false;
      }
    }

    services.push({
      name: service.name,
      started: pid !== null && pgid !== null,
      pid,
      pgid,
      port,
      logPath,
      logExists,
      logTail: logExists ? readLogTail(logPath) : "",
      processGone: pid !== null ? !isProcessAlive(pid) : false,
      processGroupGone: processGroupGone(pgid),
      portFree,
      readinessAttempts: attempts.length,
      readinessOk: attempts.some((attempt) => attempt.ok === true),
      readinessStatuses: statuses,
    });
  }

  const leaseStore = readLeaseStore(controlDir);
  return {
    runtimeId,
    manifestPath,
    manifestExists,
    cleanup: (manifest?.cleanup as RuntimeCleanupState | undefined) ?? null,
    failureReason: manifest?.failureReason ?? null,
    leaseCount: leaseStore.count,
    leaseStorePath: leaseStore.path,
    services,
    processGone:
      services.length > 0 && services.every((service) => service.processGone),
    portFree:
      services.length > 0 && services.every((service) => service.portFree),
  };
}

function runtimeChecks(
  runtime: DrillRuntimeEvidence | null,
  expected: {
    cleanup: RuntimeCleanupState;
    leaseCount: number;
    failureReason?: RegExp;
    readiness: "ready" | "never-ready";
  },
): DrillCheck[] {
  const checks: DrillCheck[] = [];
  const check = (id: string, ok: boolean, detail?: string): void => {
    checks.push(detail === undefined ? { id, ok } : { id, ok, detail });
  };

  check("runtime-evidence", runtime !== null);
  if (runtime === null) return checks;

  check("manifest-persisted", runtime.manifestExists, runtime.manifestPath);
  check(
    "manifest-cleanup",
    runtime.cleanup === expected.cleanup,
    `cleanup=${runtime.cleanup ?? "null"} expected=${expected.cleanup}`,
  );
  check(
    "lease-count",
    runtime.leaseCount === expected.leaseCount,
    `leases=${runtime.leaseCount} expected=${expected.leaseCount}`,
  );
  if (expected.failureReason !== undefined) {
    check(
      "failure-reason",
      expected.failureReason.test(runtime.failureReason ?? ""),
      runtime.failureReason ?? "missing",
    );
  }

  check(
    "services-present",
    runtime.services.length > 0,
    `${runtime.services.length} service(s)`,
  );
  for (const service of runtime.services) {
    check(
      `service-${service.name}-started`,
      service.started,
      `pid=${String(service.pid)} pgid=${String(service.pgid)}`,
    );
    check(
      `service-${service.name}-process-gone`,
      service.processGone,
      `pid=${String(service.pid)}`,
    );
    check(
      `service-${service.name}-process-group-gone`,
      service.processGroupGone,
      `pgid=${String(service.pgid)}`,
    );
    check(
      `service-${service.name}-port-free`,
      service.portFree,
      `port=${service.port}`,
    );
    check(
      `service-${service.name}-log`,
      service.logExists && service.logTail.length > 0,
      service.logPath,
    );
  }

  const service = runtime.services[0];
  if (expected.readiness === "never-ready") {
    check(
      "readiness-attempts",
      service !== undefined && service.readinessAttempts > 0,
      `${service?.readinessAttempts ?? 0} attempt(s)`,
    );
    check(
      "readiness-never-ready",
      service !== undefined && service.readinessOk === false,
    );
    check(
      "readiness-status-503",
      service !== undefined && service.readinessStatuses.includes(503),
      JSON.stringify(service?.readinessStatuses ?? []),
    );
  } else {
    check(
      "readiness-attempts",
      service !== undefined && service.readinessAttempts > 0,
      `${service?.readinessAttempts ?? 0} attempt(s)`,
    );
    check(
      "readiness-ready",
      service !== undefined && service.readinessOk === true,
    );
  }

  return checks;
}

function readManifestIfAny(path: string): RuntimeManifest | null {
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (
      isRecord(raw) &&
      typeof raw.runtimeId === "string" &&
      Array.isArray(raw.services)
    ) {
      return raw as unknown as RuntimeManifest;
    }
  } catch {
    /* evidence may be absent after a setup failure */
  }
  return null;
}

function readLeaseStore(controlDir: string): {
  count: number;
  path: string;
} {
  const path = join(controlDir, ".cliyard", "runtime", "port-leases.json");
  if (!existsSync(path)) return { count: 0, path };
  const raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
  if (!isRecord(raw) || !Array.isArray(raw.leases)) {
    throw new Error(`invalid port lease store: ${path}`);
  }
  return { count: raw.leases.length, path };
}

function readLogTail(path: string, maxBytes = LOG_TAIL_BYTES): string {
  try {
    const content = readFileSync(path, "utf8");
    return content.slice(Math.max(0, content.length - maxBytes));
  } catch {
    return "";
  }
}

function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function processGroupGone(pgid: number | null): boolean {
  if (pgid === null) return false;
  if (process.platform === "win32") return true;
  try {
    process.kill(-pgid, 0);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ESRCH";
  }
}

// ---------------------------------------------------------------------------
// Fixtures and arguments
// ---------------------------------------------------------------------------

function writeFixtures(worktreeDir: string): DrillFixtures {
  const fixtures = {
    serverScript: join(worktreeDir, "drill-server.cjs"),
    writeMarkerScript: join(worktreeDir, "drill-write-marker.cjs"),
    exit7Script: join(worktreeDir, "drill-exit-7.cjs"),
  };
  writeFileSync(fixtures.serverScript, SERVER_SOURCE, "utf8");
  writeFileSync(fixtures.writeMarkerScript, WRITE_MARKER_SOURCE, "utf8");
  writeFileSync(fixtures.exit7Script, EXIT7_SOURCE, "utf8");
  return fixtures;
}

function okAgent(): AgentResult {
  return {
    sessionId: "runtime-failure-drill",
    exitCode: 0,
    touchedPaths: ["src/drill.txt"],
    logTail: "ok",
  };
}

function parseArgs(argv: string[]): ChildArgs {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!flag.startsWith("--") || value === undefined || value === "") {
      throw new Error(
        `invalid runtime-drill child arguments near ${JSON.stringify(flag)}`,
      );
    }
    values.set(flag, value);
  }

  const scenario = values.get("--scenario");
  if (
    scenario === undefined ||
    !DRILL_SCENARIOS.includes(scenario as DrillScenarioName)
  ) {
    throw new Error(
      `unknown runtime-drill scenario ${JSON.stringify(scenario)}`,
    );
  }

  const scenarioDir = requirePath(values, "--scenario-dir");
  const controlDir = requirePath(values, "--control");
  const worktreeDir = requirePath(values, "--worktree");
  const range = parsePortRange(values.get("--port-range") ?? "");

  return {
    scenario: scenario as DrillScenarioName,
    scenarioDir,
    controlDir,
    worktreeDir,
    portRange: range,
  };
}

function requirePath(
  values: Map<string, string>,
  flag: string,
): string {
  const value = values.get(flag);
  if (value === undefined || value === "") {
    throw new Error(`${flag} is required`);
  }
  return resolve(value);
}

function emptyObserved(): DrillObservedEvidence {
  return {
    accepted: false,
    rejectionObserved: false,
    rejectionName: null,
    rejectionMessage: null,
    verify: null,
    runtime: null,
    failureReason: null,
  };
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

function isDirectEntry(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  const self = fileURLToPath(import.meta.url);
  try {
    return realpathSync(entry) === realpathSync(self);
  } catch {
    return resolve(entry) === self;
  }
}

if (isDirectEntry()) {
  void main();
}

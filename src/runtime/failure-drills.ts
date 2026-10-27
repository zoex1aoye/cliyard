/**
 * Runtime failure drills v0 (design/runtime-failure-drills-v0.md).
 *
 * One `cliyard runtime-drill` invocation runs three known RuntimeManager
 * rejection paths in three independent OS child processes:
 *
 *   readiness-timeout  service listens but never returns the expected status
 *   verify-failure     readiness succeeds, verifyCommand exits 7
 *   cleanup-failure    readiness succeeds, injected lease release throws
 *
 * Each child owns a scratch control repository, worktree and explicit port
 * subrange under the output directory. A child exits 0 only when it observed
 * its expected rejection together with the required evidence. This module is
 * the orchestrator and report layer: it validates the port range before any
 * child starts, independently re-checks child exit status plus the persisted
 * manifest, service logs, process state, port state and lease store, and writes
 * the versioned `runtime-failure-drills.json` report.
 *
 * The drill is a foreground diagnostic. It is not a daemon, scanner, browser
 * runner or production port coordinator.
 */
import { spawn, type ChildProcess } from "node:child_process";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import {
  extname,
  isAbsolute,
  join,
  relative,
  resolve,
} from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { probePort } from "./ports.js";
import type { RuntimeCleanupState, RuntimeManifest } from "./types.js";

export const RUNTIME_FAILURE_DRILL_REPORT_VERSION = 1 as const;
export const RUNTIME_FAILURE_DRILL_FILE = "runtime-failure-drills.json";

export const DRILL_SCENARIOS = [
  "readiness-timeout",
  "verify-failure",
  "cleanup-failure",
] as const;
export type DrillScenarioName = (typeof DRILL_SCENARIOS)[number];

/** Each scenario owns a disjoint subrange; the design reserves 30 ports each. */
export const DRILL_PORTS_PER_SCENARIO = 30;
export const DRILL_DEFAULT_PORT_BASE = 22800;
export const DRILL_CHILD_TIMEOUT_MS = 90_000;

/** The allocator release fault injected by the cleanup-failure scenario. */
export const DRILL_CLEANUP_RELEASE_FAULT =
  "injected lease release failure";

export const DRILL_EXPECTED_FAILURES: Readonly<
  Record<DrillScenarioName, string>
> = {
  "readiness-timeout":
    "runtime readiness times out; verifyCommands are skipped and the service is stopped",
  "verify-failure":
    "readiness succeeds and the verify command exits with code 7",
  "cleanup-failure":
    "the runtime API rejects after an injected lease release failure",
};

// ---------------------------------------------------------------------------
// Child → parent evidence
// ---------------------------------------------------------------------------

export interface DrillCheck {
  id: string;
  ok: boolean;
  detail?: string;
}

export interface DrillCommandResult {
  command: string;
  exitCode: number;
  skipped: boolean;
  log: string;
}

export interface DrillServiceEvidence {
  name: string;
  started: boolean;
  pid: number | null;
  pgid: number | null;
  port: number;
  logPath: string;
  logExists: boolean;
  logTail: string;
  processGone: boolean;
  processGroupGone: boolean;
  portFree: boolean;
  readinessAttempts: number;
  readinessOk: boolean;
  readinessStatuses: Array<number | null>;
}

export interface DrillRuntimeEvidence {
  runtimeId: string;
  manifestPath: string;
  manifestExists: boolean;
  cleanup: RuntimeCleanupState | null;
  failureReason: string | null;
  leaseCount: number;
  leaseStorePath: string;
  services: DrillServiceEvidence[];
  processGone: boolean;
  portFree: boolean;
}

export interface DrillVerifyEvidence {
  verdictOk: boolean;
  exitCode: number | null;
  verifyCommandsSkipped: boolean;
  verifyCommandsRan: boolean;
  markerPath: string;
  markerExists: boolean;
  commandResults: DrillCommandResult[];
}

export interface DrillObservedEvidence {
  accepted: boolean;
  rejectionObserved: boolean;
  rejectionName: string | null;
  rejectionMessage: string | null;
  verify: DrillVerifyEvidence | null;
  runtime: DrillRuntimeEvidence | null;
  failureReason: string | null;
}

export interface DrillChildResult {
  version: 1;
  scenario: DrillScenarioName;
  expectedFailure: string;
  status: "pass" | "fail";
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  checks: DrillCheck[];
  observed: DrillObservedEvidence;
  artifacts: {
    scenarioDir: string;
    controlDir: string;
    worktreeDir: string;
    childResultPath: string;
  };
  error: string | null;
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

export interface RuntimeFailureDrillServiceReport {
  name: string;
  pid: number | null;
  pgid: number | null;
  port: number;
  logPath: string;
  logExists: boolean;
  processGone: boolean;
  processGroupGone: boolean;
  portFree: boolean;
  readinessAttempts: number;
  readinessOk: boolean;
  readinessStatuses: Array<number | null>;
}

export interface RuntimeFailureDrillRuntimeReport {
  runtimeId: string;
  manifestPath: string;
  manifestExists: boolean;
  cleanup: RuntimeCleanupState | null;
  failureReason: string | null;
  leaseCount: number;
  leaseStorePath: string;
  services: RuntimeFailureDrillServiceReport[];
  processGone: boolean;
  portFree: boolean;
}

export interface RuntimeFailureDrillVerifyReport {
  verdictOk: boolean;
  exitCode: number | null;
  verifyCommandsSkipped: boolean;
  verifyCommandsRan: boolean;
  markerPath: string;
  markerExists: boolean;
  commandResults: DrillCommandResult[];
}

export interface RuntimeFailureDrillScenarioReport {
  name: DrillScenarioName;
  expectedFailure: string;
  status: "pass" | "fail";
  /** True only if the attempted runtime/verification reported acceptance. */
  accepted: boolean;
  rejectionObserved: boolean;
  rejectionName: string | null;
  child: {
    pid: number | null;
    exitCode: number | null;
    signal: string | null;
    durationMs: number;
    timedOut: boolean;
    logPath: string;
    resultPath: string;
  };
  checks: DrillCheck[];
  runtime: RuntimeFailureDrillRuntimeReport | null;
  verify: RuntimeFailureDrillVerifyReport | null;
  artifacts: {
    scenarioDir: string;
    controlDir: string;
    worktreeDir: string;
    manifestPath: string | null;
    serviceLogPaths: string[];
    leaseStorePath: string | null;
  };
  failureReason: string | null;
}

export interface RuntimeFailureDrillReport {
  version: typeof RUNTIME_FAILURE_DRILL_REPORT_VERSION;
  kind: "runtime-failure-drills";
  generatedAt: string;
  outDir: string;
  portBase: number;
  status: "pass" | "fail";
  summary: {
    total: number;
    passed: number;
    failed: number;
  };
  scenarios: RuntimeFailureDrillScenarioReport[];
}

// ---------------------------------------------------------------------------
// Port isolation
// ---------------------------------------------------------------------------

/**
 * Disjoint scenario subrange:
 *   readiness-timeout  base .. base + 29
 *   verify-failure     base + 30 .. base + 59
 *   cleanup-failure    base + 60 .. base + 89
 */
export function drillScenarioPortRange(
  portBase: number,
  scenario: DrillScenarioName,
): { start: number; end: number } {
  const index = DRILL_SCENARIOS.indexOf(scenario);
  if (index === -1) {
    throw new Error(`unknown runtime drill scenario ${JSON.stringify(scenario)}`);
  }
  const start = portBase + index * DRILL_PORTS_PER_SCENARIO;
  return { start, end: start + DRILL_PORTS_PER_SCENARIO - 1 };
}

/** Validate the whole drill range before any child process is spawned. */
export function validateDrillPortBase(portBase: number): void {
  if (!Number.isInteger(portBase) || portBase < 1) {
    throw new Error(
      `runtime-drill port base must be a positive integer, got ${String(portBase)}`,
    );
  }
  const lastPort =
    portBase + DRILL_SCENARIOS.length * DRILL_PORTS_PER_SCENARIO - 1;
  if (lastPort > 65535) {
    throw new Error(
      `runtime-drill port base ${portBase} requires ports ${portBase}-${lastPort}, ` +
        `but the maximum TCP port is 65535`,
    );
  }
}

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

export interface RuntimeDrillOptions {
  /** Output directory; must be missing or empty. */
  outDir?: string;
  /** First port of the three disjoint scenario subranges (default 22800). */
  portBase?: number;
  /** Per-child hard timeout (default 90s). */
  childTimeoutMs?: number;
  /** Progress sink; the JSON report is never written here. */
  log?: (line: string) => void;
}

export async function runRuntimeDrill(
  options: RuntimeDrillOptions = {},
): Promise<RuntimeFailureDrillReport> {
  const portBase = options.portBase ?? DRILL_DEFAULT_PORT_BASE;
  validateDrillPortBase(portBase);

  const timeoutMs = options.childTimeoutMs ?? DRILL_CHILD_TIMEOUT_MS;
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
    throw new Error("runtime-drill childTimeoutMs must be a positive integer");
  }

  const outDir = resolve(options.outDir ?? defaultOutDir());
  prepareOutputDirectory(outDir);
  const launch = resolveChildLaunch();
  const log = options.log ?? (() => {});

  const scenarios: RuntimeFailureDrillScenarioReport[] = [];
  for (const name of DRILL_SCENARIOS) {
    const scenarioDir = join(outDir, name);
    const controlDir = join(scenarioDir, "control");
    const worktreeDir = join(scenarioDir, "worktree");
    mkdirSync(scenarioDir, { recursive: true });

    const range = drillScenarioPortRange(portBase, name);
    log(
      `[runtime-drill] ${name}: ports ${range.start}-${range.end} ` +
        `(scratch ${scenarioDir})`,
    );

    const child = await runChild(launch, {
      scenario: name,
      scenarioDir,
      controlDir,
      worktreeDir,
      range,
      timeoutMs,
    });
    let report: RuntimeFailureDrillScenarioReport;
    try {
      report = await evaluateScenario(
        name,
        scenarioDir,
        controlDir,
        worktreeDir,
        child,
      );
    } catch (error) {
      report = errorScenarioReport(
        name,
        scenarioDir,
        controlDir,
        worktreeDir,
        child,
        errorMessage(error),
      );
    }
    scenarios.push(report);
    log(
      `[runtime-drill] ${name}: ${report.status.toUpperCase()} ` +
        `(child exit ${child.exitCode ?? "none"}, ${child.durationMs}ms)`,
    );
  }

  const passed = scenarios.filter((scenario) => scenario.status === "pass")
    .length;
  const report: RuntimeFailureDrillReport = {
    version: RUNTIME_FAILURE_DRILL_REPORT_VERSION,
    kind: "runtime-failure-drills",
    generatedAt: new Date().toISOString(),
    outDir,
    portBase,
    status: passed === scenarios.length ? "pass" : "fail",
    summary: {
      total: scenarios.length,
      passed,
      failed: scenarios.length - passed,
    },
    scenarios,
  };

  writeFileSync(
    join(outDir, RUNTIME_FAILURE_DRILL_FILE),
    JSON.stringify(report, null, 2) + "\n",
    "utf8",
  );
  log(`[runtime-drill] report: ${join(outDir, RUNTIME_FAILURE_DRILL_FILE)}`);
  return report;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

export interface RuntimeDrillCliOptions {
  /** Human output sink; defaults to console.log. */
  log?: (line: string) => void;
}

const DRILL_USAGE = `Usage:
  cliyard runtime-drill [--out <directory>] [--port-base <start>] [--json]

Runs readiness-timeout, verify-failure and cleanup-failure in separate child
processes and writes runtime-failure-drills.json plus per-scenario evidence.
Defaults: --out .cliyard/runtime-drills/<UTC>-<pid>, --port-base 22800
(three disjoint 30-port subranges).`;

export async function runRuntimeDrillCli(
  argv: string[],
  options: RuntimeDrillCliOptions = {},
): Promise<number> {
  const log = options.log ?? ((line: string) => console.log(line));
  let outDir: string | undefined;
  let portBase: number | undefined;
  let json = false;

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--json") {
      json = true;
      continue;
    }
    if (token === "-h" || token === "--help") {
      log(DRILL_USAGE);
      return 0;
    }
    if (token === "--out") {
      outDir = optionValue(argv, index + 1, "--out");
      index += 1;
      continue;
    }
    if (token.startsWith("--out=")) {
      outDir = token.slice("--out=".length);
      if (outDir === "") throw new Error("--out requires a value");
      continue;
    }
    if (token === "--port-base") {
      portBase = parsePortBaseArg(optionValue(argv, index + 1, "--port-base"));
      index += 1;
      continue;
    }
    if (token.startsWith("--port-base=")) {
      portBase = parsePortBaseArg(token.slice("--port-base=".length));
      continue;
    }
    throw new Error(
      `unknown runtime-drill argument ${JSON.stringify(token)}\n\n${DRILL_USAGE}`,
    );
  }

  const report = await runRuntimeDrill({
    ...(outDir !== undefined ? { outDir } : {}),
    ...(portBase !== undefined ? { portBase } : {}),
    log: json ? () => {} : log,
  });

  if (json) {
    log(JSON.stringify(report, null, 2));
  } else {
    printHumanReport(report, log);
  }
  return report.status === "pass" ? 0 : 1;
}

function printHumanReport(
  report: RuntimeFailureDrillReport,
  log: (line: string) => void,
): void {
  const { passed, total } = report.summary;
  log(`runtime-drill: ${passed}/${total} scenarios passed`);
  for (const scenario of report.scenarios) {
    const runtime = scenario.runtime;
    const details = [
      `runtime=${runtime?.runtimeId ?? "none"}`,
      `cleanup=${runtime?.cleanup ?? "none"}`,
      `leases=${runtime?.leaseCount ?? "none"}`,
      `port-free=${runtime?.portFree === true ? "yes" : "no"}`,
    ].join(" ");
    log(
      `  ${scenario.status.toUpperCase().padEnd(4)} ${scenario.name.padEnd(17)} ` +
        `(${scenario.child.durationMs}ms, child exit ` +
        `${scenario.child.exitCode ?? "none"}) ${details}`,
    );
  }
  log(`report: ${join(report.outDir, RUNTIME_FAILURE_DRILL_FILE)}`);
}

function optionValue(
  argv: string[],
  index: number,
  flag: string,
): string {
  const value = argv[index];
  if (value === undefined || value === "" || value.startsWith("--")) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

function parsePortBaseArg(raw: string): number {
  if (!/^\d+$/.test(raw)) {
    throw new Error(
      `--port-base must be a positive integer, got ${JSON.stringify(raw)}`,
    );
  }
  return Number(raw);
}

// ---------------------------------------------------------------------------
// Child process
// ---------------------------------------------------------------------------

interface ChildLaunch {
  command: string;
  args: string[];
}

interface ChildRun {
  pid: number | null;
  exitCode: number | null;
  signal: string | null;
  durationMs: number;
  timedOut: boolean;
  timeoutMs: number;
  spawnError?: string;
}

function defaultOutDir(): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return resolve(
    ".cliyard",
    "runtime-drills",
    `${stamp}-${process.pid}`,
  );
}

function prepareOutputDirectory(outDir: string): void {
  if (existsSync(outDir)) {
    const info = statSync(outDir);
    if (!info.isDirectory()) {
      throw new Error(`runtime-drill output path is not a directory: ${outDir}`);
    }
    if (readdirSync(outDir).length > 0) {
      throw new Error(
        `runtime-drill output directory is not empty: ${outDir}`,
      );
    }
  }
  mkdirSync(outDir, { recursive: true });
}

/**
 * The child shares this module's extension: `.js` when running from `dist`,
 * `.ts` when the CLI runs through tsx. The tsx loader is resolved absolutely so
 * the child's scenario directory does not need a node_modules tree.
 */
function resolveChildLaunch(): ChildLaunch {
  const self = fileURLToPath(import.meta.url);
  const extension = extname(self);
  const entry = fileURLToPath(
    new URL(`./failure-drill-child${extension}`, import.meta.url),
  );

  if (extension === ".ts") {
    let loader: string;
    try {
      loader = createRequire(import.meta.url).resolve("tsx");
    } catch {
      throw new Error(
        "runtime-drill is running from TypeScript sources but tsx is not " +
          "resolvable; run the built CLI or install tsx",
      );
    }
    return {
      command: process.execPath,
      args: ["--import", pathToFileURL(loader).href, entry],
    };
  }

  return { command: process.execPath, args: [entry] };
}

function runChild(
  launch: ChildLaunch,
  params: {
    scenario: DrillScenarioName;
    scenarioDir: string;
    controlDir: string;
    worktreeDir: string;
    range: { start: number; end: number };
    timeoutMs: number;
  },
): Promise<ChildRun> {
  return new Promise<ChildRun>((resolveRun) => {
    const startedAt = Date.now();
    const logPath = join(params.scenarioDir, "child.log");
    const fd = openSync(logPath, "a", 0o600);

    let child: ChildProcess;
    try {
      child = spawn(
        launch.command,
        [
          ...launch.args,
          "--scenario",
          params.scenario,
          "--scenario-dir",
          params.scenarioDir,
          "--control",
          params.controlDir,
          "--worktree",
          params.worktreeDir,
          "--port-range",
          `${params.range.start}-${params.range.end}`,
        ],
        {
          cwd: params.scenarioDir,
          env: { ...process.env },
          stdio: ["ignore", fd, fd],
        },
      );
    } catch (error) {
      closeSync(fd);
      resolveRun({
        pid: null,
        exitCode: null,
        signal: null,
        durationMs: Date.now() - startedAt,
        timedOut: false,
        timeoutMs: params.timeoutMs,
        spawnError: errorMessage(error),
      });
      return;
    }
    closeSync(fd);

    let settled = false;
    let timedOut = false;
    let timer: NodeJS.Timeout | undefined;
    const finish = (
      exitCode: number | null,
      signal: NodeJS.Signals | null,
      spawnError?: string,
    ): void => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      resolveRun({
        pid: child.pid ?? null,
        exitCode,
        signal,
        durationMs: Date.now() - startedAt,
        timedOut,
        timeoutMs: params.timeoutMs,
        ...(spawnError !== undefined ? { spawnError } : {}),
      });
    };

    timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill("SIGKILL");
      } catch {
        /* already exited */
      }
    }, params.timeoutMs);

    child.once("error", (error) => finish(null, null, errorMessage(error)));
    child.once("close", (code, signal) => finish(code, signal));
  });
}

// ---------------------------------------------------------------------------
// Independent validation of one scenario
// ---------------------------------------------------------------------------

async function evaluateScenario(
  name: DrillScenarioName,
  scenarioDir: string,
  controlDir: string,
  worktreeDir: string,
  run: ChildRun,
): Promise<RuntimeFailureDrillScenarioReport> {
  const checks: DrillCheck[] = [];
  const check = (id: string, ok: boolean, detail?: string): void => {
    checks.push(detail === undefined ? { id, ok } : { id, ok, detail });
  };

  const resultPath = join(scenarioDir, "child-result.json");
  const childLogPath = join(scenarioDir, "child.log");

  check(
    "child-exit",
    run.spawnError === undefined &&
      !run.timedOut &&
      run.exitCode === 0 &&
      run.signal === null,
    run.spawnError ??
      (run.timedOut
        ? `child timed out after ${run.timeoutMs}ms`
        : `exit=${String(run.exitCode)} signal=${String(run.signal)}`),
  );
  check("child-log-present", existsSync(childLogPath), childLogPath);

  let childResult: DrillChildResult | undefined;
  if (!existsSync(resultPath)) {
    check("child-result-present", false, resultPath);
  } else {
    try {
      childResult = parseChildResult(resultPath, name);
      check("child-result-present", true, resultPath);
    } catch (error) {
      check("child-result-present", false, errorMessage(error));
    }
  }

  let accepted = false;
  let rejectionObserved = false;
  let rejectionName: string | null = null;
  let runtimeReport: RuntimeFailureDrillRuntimeReport | null = null;
  let verifyReport: RuntimeFailureDrillVerifyReport | null = null;
  let failureReason: string | null = null;

  if (childResult !== undefined) {
    check("child-status", childResult.status === "pass", childResult.status);
    const failedChildChecks = childResult.checks
      .filter((entry) => !entry.ok)
      .map((entry) => entry.id);
    check(
      "child-self-checks",
      childResult.checks.length > 0 && failedChildChecks.length === 0,
      failedChildChecks.join(", "),
    );
    check(
      "child-expected-failure",
      childResult.expectedFailure === DRILL_EXPECTED_FAILURES[name],
    );

    const observed = childResult.observed;
    accepted = observed.accepted;
    rejectionObserved = observed.rejectionObserved;
    rejectionName = observed.rejectionName;
    check("rejection-observed", observed.rejectionObserved === true);
    check("not-accepted", observed.accepted === false);
    if (name === "cleanup-failure") {
      check(
        "cleanup-rejection",
        observed.rejectionName === "RuntimeCleanupError",
        observed.rejectionName ?? "no rejection",
      );
      check(
        "cleanup-rejection-fault",
        (observed.rejectionMessage ?? "").includes(DRILL_CLEANUP_RELEASE_FAULT),
        observed.rejectionMessage ?? "no rejection message",
      );
    }

    const observedRuntime = observed.runtime;
    check("child-runtime-evidence", observedRuntime !== null);
    if (observedRuntime !== null) {
      const manifestPath = observedRuntime.manifestPath;
      const manifestContained =
        typeof manifestPath === "string" &&
        manifestPath.trim() !== "" &&
        isInside(controlDir, manifestPath);
      check("manifest-path-contained", manifestContained, manifestPath);

      let manifest: RuntimeManifest | undefined;
      if (manifestContained) {
        try {
          manifest = readManifest(manifestPath);
          check(
            "manifest-runtime-id",
            manifest.runtimeId === observedRuntime.runtimeId,
            manifest.runtimeId,
          );
          check("manifest-persisted", true, manifestPath);
        } catch (error) {
          check("manifest-persisted", false, errorMessage(error));
        }
      }

      const serviceReports: RuntimeFailureDrillServiceReport[] = [];
      for (const service of manifest?.services ?? []) {
        const pid = typeof service.pid === "number" ? service.pid : null;
        const pgid = typeof service.pgid === "number" ? service.pgid : null;
        const port =
          typeof service.port === "number" && Number.isInteger(service.port)
            ? service.port
            : 0;
        const logPath =
          typeof service.logPath === "string" ? service.logPath : "";
        const logContained =
          logPath !== "" && isInside(controlDir, logPath);
        const logExists = logContained && existsSync(logPath);
        const attempts = Array.isArray(service.readinessAttempts)
          ? service.readinessAttempts
          : [];
        const statuses = attempts.map((attempt) =>
          typeof attempt.status === "number" ? attempt.status : null,
        );
        const portFree = port > 0 ? await probePort(port) : false;
        const processGone = pid !== null ? !isProcessAlive(pid) : false;
        const groupGone = processGroupGone(pgid);

        serviceReports.push({
          name: service.name,
          pid,
          pgid,
          port,
          logPath,
          logExists,
          processGone,
          processGroupGone: groupGone,
          portFree,
          readinessAttempts: attempts.length,
          readinessOk: attempts.some((attempt) => attempt.ok === true),
          readinessStatuses: statuses,
        });
      }

      check(
        "services-started",
        serviceReports.length > 0 &&
          serviceReports.every((entry) => entry.pid !== null && entry.pgid !== null),
        `${serviceReports.length} service(s)`,
      );
      check(
        "services-process-gone",
        serviceReports.length > 0 &&
          serviceReports.every((entry) => entry.processGone),
      );
      check(
        "services-process-group-gone",
        serviceReports.length > 0 &&
          serviceReports.every((entry) => entry.processGroupGone),
      );
      check(
        "services-port-free",
        serviceReports.length > 0 &&
          serviceReports.every((entry) => entry.portFree),
      );
      check(
        "services-log-present",
        serviceReports.length > 0 &&
          serviceReports.every((entry) => entry.logExists),
      );

      const expectedCleanup: RuntimeCleanupState =
        name === "cleanup-failure" ? "failed" : "complete";
      if (manifest !== undefined) {
        check(
          "manifest-cleanup",
          manifest.cleanup === expectedCleanup,
          manifest.cleanup,
        );
        check(
          "manifest-cleanup-child",
          observedRuntime.cleanup === manifest.cleanup,
          `disk=${manifest.cleanup} child=${String(observedRuntime.cleanup)}`,
        );
        failureReason = manifest.failureReason ?? null;
      }
      const failureReasonText =
        manifest?.failureReason ?? observedRuntime.failureReason ?? null;
      if (name === "readiness-timeout") {
        check(
          "failure-reason-readiness",
          /not ready/i.test(failureReasonText ?? ""),
          failureReasonText ?? "missing",
        );
      }
      if (name === "verify-failure") {
        check(
          "failure-reason-verify",
          failureReasonText === null || failureReasonText === "",
          failureReasonText ?? "",
        );
      }
      if (name === "cleanup-failure") {
        check(
          "failure-reason-cleanup",
          (failureReasonText ?? "").includes(DRILL_CLEANUP_RELEASE_FAULT),
          failureReasonText ?? "missing",
        );
      }

      let leaseCount = -1;
      let leaseStorePath = "";
      try {
        const leaseStore = readLeaseStore(controlDir);
        leaseCount = leaseStore.count;
        leaseStorePath = leaseStore.path;
        check("lease-store-readable", true, leaseStorePath);
      } catch (error) {
        check("lease-store-readable", false, errorMessage(error));
      }
      const expectedLeaseCount = name === "cleanup-failure" ? 1 : 0;
      check(
        "lease-count",
        leaseCount === expectedLeaseCount,
        `leases=${leaseCount} expected=${expectedLeaseCount}`,
      );
      check(
        "lease-count-child",
        observedRuntime.leaseCount === leaseCount,
        `disk=${leaseCount} child=${observedRuntime.leaseCount}`,
      );

      const service = serviceReports[0];
      if (name === "readiness-timeout") {
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
          "readiness-status-observed",
          service !== undefined && service.readinessStatuses.includes(503),
          JSON.stringify(service?.readinessStatuses ?? []),
        );
      } else {
        check(
          "readiness-ready",
          service !== undefined && service.readinessOk === true,
        );
      }

      runtimeReport = {
        runtimeId: observedRuntime.runtimeId,
        manifestPath: observedRuntime.manifestPath,
        manifestExists: manifest !== undefined,
        cleanup: manifest?.cleanup ?? observedRuntime.cleanup,
        failureReason: failureReasonText,
        leaseCount,
        leaseStorePath,
        services: serviceReports,
        processGone:
          serviceReports.length > 0 &&
          serviceReports.every((entry) => entry.processGone),
        portFree:
          serviceReports.length > 0 &&
          serviceReports.every((entry) => entry.portFree),
      };
      check(
        "child-port-free",
        observedRuntime.portFree === true && runtimeReport.portFree,
      );
      check(
        "child-process-gone",
        observedRuntime.processGone === true && runtimeReport.processGone,
      );
    }

    const observedVerify = observed.verify;
    check(
      "child-verify-evidence",
      name === "cleanup-failure"
        ? observedVerify === null
        : observedVerify !== null,
    );
    if (observedVerify !== null) {
      verifyReport = {
        verdictOk: observedVerify.verdictOk === true,
        exitCode:
          typeof observedVerify.exitCode === "number"
            ? observedVerify.exitCode
            : null,
        verifyCommandsSkipped: observedVerify.verifyCommandsSkipped === true,
        verifyCommandsRan: observedVerify.verifyCommandsRan === true,
        markerPath: observedVerify.markerPath,
        markerExists: observedVerify.markerExists === true,
        commandResults: observedVerify.commandResults,
      };
    }

    if (name === "readiness-timeout") {
      check(
        "verify-rejected",
        verifyReport !== null && verifyReport.verdictOk === false,
      );
      check(
        "verify-commands-skipped",
        verifyReport !== null &&
          verifyReport.verifyCommandsSkipped &&
          !verifyReport.verifyCommandsRan,
      );
      check(
        "verify-command-records",
        verifyReport !== null &&
          verifyReport.commandResults.length > 0 &&
          verifyReport.commandResults.every((entry) => entry.skipped),
      );
      check(
        "verify-marker-absent",
        verifyReport !== null && verifyReport.markerExists === false,
      );
    }

    if (name === "verify-failure") {
      check(
        "verify-rejected",
        verifyReport !== null && verifyReport.verdictOk === false,
      );
      check(
        "verifier-exit-nonzero",
        verifyReport !== null &&
          verifyReport.exitCode !== null &&
          verifyReport.exitCode !== 0,
        String(verifyReport?.exitCode),
      );
      check(
        "verify-command-exit-7",
        verifyReport !== null &&
          verifyReport.commandResults.length > 0 &&
          verifyReport.commandResults[verifyReport.commandResults.length - 1]
            ?.exitCode === 7,
      );
      check(
        "verify-commands-ran",
        verifyReport !== null &&
          verifyReport.verifyCommandsRan &&
          !verifyReport.verifyCommandsSkipped,
      );
      check(
        "verify-marker-present",
        verifyReport !== null && verifyReport.markerExists === true,
      );
    }

    if (name === "cleanup-failure") {
      check("verify-not-applicable", verifyReport === null);
    }

    check(
      "artifacts-scenario-present",
      existsSync(scenarioDir),
      scenarioDir,
    );
    check("artifacts-control-present", existsSync(controlDir), controlDir);
    check("artifacts-worktree-present", existsSync(worktreeDir), worktreeDir);
  }

  const status = checks.every((entry) => entry.ok) ? "pass" : "fail";
  return {
    name,
    expectedFailure: DRILL_EXPECTED_FAILURES[name],
    status,
    accepted,
    rejectionObserved,
    rejectionName,
    child: {
      pid: run.pid,
      exitCode: run.exitCode,
      signal: run.signal,
      durationMs: run.durationMs,
      timedOut: run.timedOut,
      logPath: childLogPath,
      resultPath,
    },
    checks,
    runtime: runtimeReport,
    verify: verifyReport,
    artifacts: {
      scenarioDir,
      controlDir,
      worktreeDir,
      manifestPath: runtimeReport?.manifestPath ?? null,
      serviceLogPaths:
        runtimeReport?.services.map((service) => service.logPath) ?? [],
      leaseStorePath: runtimeReport?.leaseStorePath ?? null,
    },
    failureReason,
  };
}

function errorScenarioReport(
  name: DrillScenarioName,
  scenarioDir: string,
  controlDir: string,
  worktreeDir: string,
  run: ChildRun,
  error: string,
): RuntimeFailureDrillScenarioReport {
  return {
    name,
    expectedFailure: DRILL_EXPECTED_FAILURES[name],
    status: "fail",
    accepted: false,
    rejectionObserved: false,
    rejectionName: null,
    child: {
      pid: run.pid,
      exitCode: run.exitCode,
      signal: run.signal,
      durationMs: run.durationMs,
      timedOut: run.timedOut,
      logPath: join(scenarioDir, "child.log"),
      resultPath: join(scenarioDir, "child-result.json"),
    },
    checks: [{ id: "evaluation-error", ok: false, detail: error }],
    runtime: null,
    verify: null,
    artifacts: {
      scenarioDir,
      controlDir,
      worktreeDir,
      manifestPath: null,
      serviceLogPaths: [],
      leaseStorePath: null,
    },
    failureReason: null,
  };
}

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

function parseChildResult(
  path: string,
  expected: DrillScenarioName,
): DrillChildResult {
  const raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
  if (!isRecord(raw)) {
    throw new Error("child result must be an object");
  }
  if (raw.version !== 1) {
    throw new Error(
      `unsupported child result version ${JSON.stringify(raw.version)}`,
    );
  }
  if (raw.scenario !== expected) {
    throw new Error(
      `child result is for ${JSON.stringify(raw.scenario)}, expected ` +
        JSON.stringify(expected),
    );
  }
  if (raw.status !== "pass" && raw.status !== "fail") {
    throw new Error("child result status must be pass or fail");
  }
  if (!Array.isArray(raw.checks)) {
    throw new Error("child result checks must be an array");
  }
  if (!isRecord(raw.observed)) {
    throw new Error("child result observed must be an object");
  }
  if (!isRecord(raw.artifacts)) {
    throw new Error("child result artifacts must be an object");
  }
  return raw as unknown as DrillChildResult;
}

function readManifest(path: string): RuntimeManifest {
  const raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
  if (
    !isRecord(raw) ||
    typeof raw.runtimeId !== "string" ||
    typeof raw.cleanup !== "string" ||
    !Array.isArray(raw.services)
  ) {
    throw new Error(`invalid runtime manifest: ${path}`);
  }
  return raw as unknown as RuntimeManifest;
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

function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but belongs to another user.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function processGroupGone(pgid: number | null): boolean {
  if (pgid === null) return false;
  // Windows services are not spawned into a POSIX process group.
  if (process.platform === "win32") return true;
  try {
    process.kill(-pgid, 0);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ESRCH";
  }
}

function isInside(root: string, target: string): boolean {
  const rel = relative(resolve(root), resolve(target));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import type { TaskContract } from "../src/contracts/schema.js";
import type { AgentResult } from "../src/agents/types.js";
import type { RuntimeManifest } from "../src/runtime/types.js";
import {
  createMockVerifier,
  createShellVerifier,
} from "../src/verification/verifier.js";
import { probePort } from "../src/runtime/ports.js";
import { createMockAdapter } from "../src/agents/mock.js";
import { runCodexBatch } from "../src/scheduler/codex-batch.js";

// Dedicated ranges keep these tests away from the runtime suite's default
// 19000-19999 leases (test files run in parallel processes).
const VERIFIER_PORT_RANGE = "21400-21499";
const BATCH_PORT_RANGE = "21500-21599";

/**
 * Finite fixture service. It binds the leased PORT, reports its own cwd, and
 * can be told to answer readiness with a non-200 status.
 */
const FIXTURE_SERVER_SOURCE = String.raw`
const http = require("node:http");

const port = Number(process.env.PORT);
const healthStatus = Number(process.env.HEALTH_STATUS || "200");

const server = http.createServer((req, res) => {
  console.log("request " + req.method + " " + req.url + " cwd=" + process.cwd());
  if (req.url === "/health") {
    res.writeHead(healthStatus, { "content-type": "application/json" });
    res.end(
      JSON.stringify({ ok: healthStatus === 200, cwd: process.cwd(), pid: process.pid }),
    );
    return;
  }
  res.writeHead(404, { "content-type": "text/plain" });
  res.end("not found");
});

server.listen(port, "127.0.0.1", () => {
  console.log("listening " + port + " cwd=" + process.cwd());
});
`;

/**
 * Runs as a verifyCommand from the task worktree. Proves both URL variables
 * are injected, that the service answered, and that both the service and the
 * command ran in the exact task worktree (not the control repository).
 */
const ASSERT_URL_SOURCE = String.raw`
const assert = require("node:assert/strict");
const fs = require("node:fs");

async function main() {
  const base = process.env.WEB_URL;
  assert.ok(base, "WEB_URL was not injected");
  assert.equal(
    base,
    process.env.CLIYARD_WEB_URL,
    "CLIYARD_WEB_URL does not match WEB_URL",
  );
  assert.match(base, /^http:\/\/127\.0\.0\.1:\d+$/);

  const response = await fetch(base + "/health");
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.ok, true);
  assert.equal(body.cwd, process.cwd(), "service cwd is not the task worktree");

  fs.writeFileSync("verify-ran.marker", String(body.pid));
  console.log("WEB_URL verified: " + base);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
`;

const WRITE_MARKER_SOURCE = String.raw`
require("node:fs").writeFileSync("readiness-failure-ran.marker", "ran");
console.log("verify command ran");
`;

function makeDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function makeWorktree(files: Record<string, string>): string {
  const dir = makeDir("cliyard-runtime-verify-wt-");
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(dir, name), content);
  }
  return dir;
}

function runtimeContract(overrides: Partial<TaskContract> = {}): TaskContract {
  return {
    taskId: "runtime-verify",
    version: 1,
    frozen: true,
    goals: ["verify the runtime service through its URL"],
    dependsOn: [],
    readPaths: ["."],
    writePaths: ["src/app/"],
    sharedResources: [],
    baseCommit: "HEAD",
    verifyCommands: ["node assert-url.cjs"],
    maxRepairs: 1,
    runtime: {
      services: [
        {
          name: "web",
          command: [process.execPath, "server.cjs"],
          urlEnv: "WEB_URL",
          readiness: {
            path: "/health",
            expectedStatus: 200,
            timeoutMs: 10_000,
          },
        },
      ],
    },
    ...overrides,
  };
}

function okAgent(overrides: Partial<AgentResult> = {}): AgentResult {
  return {
    sessionId: "runtime-session",
    exitCode: 0,
    touchedPaths: ["src/app/runtime-verify.ts"],
    logTail: "ok",
    ...overrides,
  };
}

test("shell verifier: runtime exposes WEB_URL, persists the manifest, releases the port", async () => {
  const worktree = makeWorktree({
    "server.cjs": FIXTURE_SERVER_SOURCE,
    "assert-url.cjs": ASSERT_URL_SOURCE,
  });
  const repoRoot = makeDir("cliyard-runtime-verify-repo-");
  try {
    const verifier = createShellVerifier({
      cwd: worktree,
      repoRoot,
      worktree,
      runtimeIdPrefix: "run-42",
      env: { ...process.env, CLIYARD_PORT_RANGE: VERIFIER_PORT_RANGE },
    });

    const result = await verifier.run(runtimeContract(), okAgent());

    assert.equal(result.ok, true, result.logTail);
    assert.equal(result.exitCode, 0);
    assert.match(result.logTail, /WEB_URL verified/);
    assert.ok(result.runtime, "verifier must return runtime evidence");

    const { runtime } = result;
    assert.equal(runtime.runtimeId, "run-42-runtime-verify-attempt-1");
    assert.equal(runtime.manifest.taskId, "runtime-verify");
    assert.equal(runtime.manifest.attempt, 1);
    assert.equal(runtime.manifest.worktree, resolve(worktree));
    assert.equal(runtime.manifest.cleanup, "complete");
    assert.equal(runtime.manifest.failureReason, undefined);
    assert.equal(runtime.manifest.services.length, 1);

    const service = runtime.manifest.services[0]!;
    assert.equal(service.name, "web");
    assert.equal(service.url, `http://127.0.0.1:${service.port}`);
    assert.equal(service.healthUrl, `${service.url}/health`);
    assert.ok(service.pid);
    assert.ok(service.readinessAttempts.some((attempt) => attempt.ok));

    // The manifest lives under the control repository, not the worktree.
    assert.equal(
      runtime.manifestPath,
      join(
        resolve(repoRoot),
        ".cliyard",
        "runtime",
        runtime.runtimeId,
        "runtime-manifest.json",
      ),
    );
    const persisted = JSON.parse(
      readFileSync(runtime.manifestPath, "utf8"),
    ) as RuntimeManifest;
    // JSON persistence drops undefined keys; compare the serialized shape.
    assert.deepEqual(
      persisted,
      JSON.parse(JSON.stringify(runtime.manifest)) as RuntimeManifest,
    );
    assert.equal(existsSync(join(worktree, ".cliyard", "runtime")), false);

    // Service logs are captured with the exact worktree as cwd.
    const serviceLog = readFileSync(service.logPath, "utf8");
    assert.match(serviceLog, /listening \d+ cwd=/);
    assert.match(serviceLog, /request GET \/health/);
    // tmpdir() may be a symlinked path on macOS; compare the real worktree.
    assert.ok(serviceLog.includes(`cwd=${realpathSync(worktree)}`));

    // The verifyCommand ran in the worktree and saw the same service pid.
    const markerPath = join(worktree, "verify-ran.marker");
    assert.equal(existsSync(markerPath), true, "verifyCommand did not run");
    assert.equal(readFileSync(markerPath, "utf8"), String(service.pid));

    // Cleanup terminated the service and released the lease.
    assert.equal(await probePort(service.port), true);
    const leaseStorePath = join(
      repoRoot,
      ".cliyard",
      "runtime",
      "port-leases.json",
    );
    if (existsSync(leaseStorePath)) {
      const store = JSON.parse(readFileSync(leaseStorePath, "utf8")) as {
        leases: unknown[];
      };
      assert.deepEqual(store.leases, []);
    }
  } finally {
    rmSync(worktree, { recursive: true, force: true });
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("shell verifier: readiness failure skips verifyCommands and captures service logs", async () => {
  const worktree = makeWorktree({
    "server.cjs": FIXTURE_SERVER_SOURCE,
    "write-marker.cjs": WRITE_MARKER_SOURCE,
  });
  const repoRoot = makeDir("cliyard-runtime-verify-repo-");
  try {
    const verifier = createShellVerifier({
      cwd: worktree,
      repoRoot,
      worktree,
      env: {
        ...process.env,
        HEALTH_STATUS: "503",
        CLIYARD_PORT_RANGE: VERIFIER_PORT_RANGE,
      },
    });

    const result = await verifier.run(
      runtimeContract({
        verifyCommands: ["node write-marker.cjs"],
        runtime: {
          services: [
            {
              name: "web",
              command: [process.execPath, "server.cjs"],
              urlEnv: "WEB_URL",
              readiness: {
                path: "/health",
                expectedStatus: 200,
                timeoutMs: 600,
              },
            },
          ],
        },
      }),
      okAgent(),
    );

    assert.equal(result.ok, false);
    assert.equal(result.exitCode, 1);
    assert.match(result.logTail, /not ready/);
    assert.match(result.logTail, /expected status 200, received 503/);

    // The verifyCommand must not have executed.
    assert.equal(
      existsSync(join(worktree, "readiness-failure-ran.marker")),
      false,
    );
    assert.equal(result.commandResults.length, 1);
    assert.match(
      result.commandResults[0]!.log,
      /skipped; runtime not ready/,
    );

    assert.ok(result.runtime, "failed startup must still return evidence");
    const { manifest } = result.runtime;
    assert.equal(manifest.cleanup, "complete");
    assert.match(manifest.failureReason ?? "", /not ready/);

    const service = manifest.services[0]!;
    assert.match(service.error ?? "", /not ready/);
    assert.ok(service.readinessAttempts.length > 0);
    assert.ok(service.readinessAttempts.every((attempt) => !attempt.ok));

    // Logs prove the service did start, and its port is free again.
    assert.match(readFileSync(service.logPath, "utf8"), /listening \d+/);
    assert.equal(await probePort(service.port), true);
  } finally {
    rmSync(worktree, { recursive: true, force: true });
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("mock verifier: runtime contracts never start services", async () => {
  const repoRoot = makeDir("cliyard-runtime-verify-repo-");
  try {
    const result = await createMockVerifier().run(
      runtimeContract({
        verifyCommands: ["true"],
        runtime: {
          services: [
            {
              name: "web",
              command: [process.execPath, "missing-server.cjs"],
            },
          ],
        },
      }),
      okAgent(),
    );

    assert.equal(result.ok, true);
    assert.equal(result.runtime, undefined);
    assert.equal(existsSync(join(repoRoot, ".cliyard")), false);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("shell verifier: contracts without runtime keep static verification", async () => {
  const worktree = makeWorktree({});
  const repoRoot = makeDir("cliyard-runtime-verify-repo-");
  try {
    const verifier = createShellVerifier({ cwd: worktree, repoRoot, worktree });
    const result = await verifier.run(
      runtimeContract({ runtime: undefined, verifyCommands: ["true"] }),
      okAgent(),
    );

    assert.equal(result.ok, true);
    assert.equal(result.runtime, undefined);
    assert.equal(existsSync(join(repoRoot, ".cliyard")), false);
  } finally {
    rmSync(worktree, { recursive: true, force: true });
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("codex-batch: shell verifier receives the control repo and exact task worktree", async () => {
  const repo = makeDir("cliyard-runtime-batch-");
  const previousRange = process.env.CLIYARD_PORT_RANGE;
  process.env.CLIYARD_PORT_RANGE = BATCH_PORT_RANGE;
  try {
    spawnSync("git", ["init"], { cwd: repo, stdio: "ignore" });
    spawnSync("git", ["config", "user.email", "t@t.com"], {
      cwd: repo,
      stdio: "ignore",
    });
    spawnSync("git", ["config", "user.name", "t"], {
      cwd: repo,
      stdio: "ignore",
    });
    writeFileSync(join(repo, "README.md"), "# tmp\n");
    writeFileSync(join(repo, "server.cjs"), FIXTURE_SERVER_SOURCE);
    writeFileSync(join(repo, "assert-url.cjs"), ASSERT_URL_SOURCE);
    spawnSync("git", ["add", "."], { cwd: repo, stdio: "ignore" });
    spawnSync("git", ["commit", "-m", "init"], { cwd: repo, stdio: "ignore" });

    const contractsPath = join(repo, "contracts.json");
    writeFileSync(
      contractsPath,
      JSON.stringify({
        contracts: [
          {
            taskId: "batch-runtime",
            version: 1,
            frozen: true,
            goals: ["verify runtime through the scheduler"],
            dependsOn: [],
            readPaths: ["."],
            writePaths: ["src/app/"],
            sharedResources: [],
            baseCommit: "HEAD",
            verifyCommands: ["node assert-url.cjs"],
            maxRepairs: 0,
            runtime: {
              services: [
                {
                  name: "web",
                  command: [process.execPath, "server.cjs"],
                  urlEnv: "WEB_URL",
                  readiness: {
                    path: "/health",
                    expectedStatus: 200,
                    timeoutMs: 10_000,
                  },
                },
              ],
            },
          },
        ],
      }),
    );

    const result = await runCodexBatch({
      contractsPath,
      repoRoot: repo,
      ledgerPath: join(repo, ".cliyard", "ledger.json"),
      dryRun: false,
      keepWorktrees: true,
      workerFactory: () => createMockAdapter({ failVerifyTimes: 0 }),
    });

    assert.equal(result.allAccepted, true);
    assert.equal(result.results[0]!.verdict, "accepted");

    const worktreePath = result.worktrees[0]!.path;
    assert.equal(existsSync(worktreePath), true);
    assert.equal(existsSync(join(worktreePath, "verify-ran.marker")), true);

    // Without a supervisor checkpoint the runtime id defaults to
    // <taskId>-attempt-<n>, and it is persisted in the control repository.
    const manifestPath = join(
      repo,
      ".cliyard",
      "runtime",
      "batch-runtime-attempt-1",
      "runtime-manifest.json",
    );
    assert.equal(existsSync(manifestPath), true, `missing ${manifestPath}`);
    const manifest = JSON.parse(
      readFileSync(manifestPath, "utf8"),
    ) as RuntimeManifest;
    assert.equal(manifest.taskId, "batch-runtime");
    assert.equal(manifest.worktree, resolve(worktreePath));
    assert.equal(manifest.cleanup, "complete");

    const service = manifest.services[0]!;
    assert.equal(await probePort(service.port), true);
  } finally {
    if (previousRange === undefined) {
      delete process.env.CLIYARD_PORT_RANGE;
    } else {
      process.env.CLIYARD_PORT_RANGE = previousRange;
    }
    rmSync(repo, { recursive: true, force: true });
  }
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  AgentAdapter,
  AgentResult,
  AgentStartInput,
  WorkerProgressEvent,
} from "../src/agents/types.js";
import type { TaskContract } from "../src/contracts/schema.js";
import {
  runSupervisorCli,
  WORKER_PROGRESS_STALE_MS,
} from "../src/supervisor/cli.js";
import {
  createRunManifest,
  getActiveRunId,
  loadRunManifest,
  runManifestPath,
} from "../src/supervisor/store.js";

function runGit(repo: string, args: string[]): string {
  const result = spawnSync("git", args, { cwd: repo, encoding: "utf8" });
  assert.equal(
    result.status,
    0,
    `git ${args.join(" ")} failed: ${result.stderr}`,
  );
  return result.stdout.trim();
}

function initRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), "cliyard-worker-progress-"));
  runGit(repo, ["init"]);
  runGit(repo, ["config", "user.email", "t@t.com"]);
  runGit(repo, ["config", "user.name", "t"]);
  writeFileSync(join(repo, "README.md"), "# fixture\n");
  runGit(repo, ["add", "."]);
  runGit(repo, ["commit", "-m", "init"]);
  return repo;
}

function contract(
  repo: string,
  taskId: string,
  writePath: string,
): TaskContract {
  return {
    taskId,
    version: 1,
    frozen: true,
    goals: [`Create ${writePath}`],
    dependsOn: [],
    readPaths: ["."],
    writePaths: [writePath],
    sharedResources: [],
    baseCommit: runGit(repo, ["rev-parse", "HEAD"]),
    verifyCommands: [`test -f ${writePath}`],
    maxRepairs: 0,
  };
}

function writeContracts(
  repo: string,
  contracts: TaskContract[],
): string {
  const path = join(repo, "contracts.json");
  writeFileSync(path, `${JSON.stringify({ contracts }, null, 2)}\n`, "utf8");
  return path;
}

function parseJson(lines: string[]): Record<string, any> {
  return JSON.parse(lines.join("\n")) as Record<string, any>;
}

function progressEvent(
  overrides: Partial<WorkerProgressEvent> & {
    taskId: string;
    message: string;
  },
): WorkerProgressEvent {
  return {
    version: 1,
    at: new Date().toISOString(),
    source: "fixture",
    sessionId: "fixture-session",
    type: "assistant",
    phase: "thinking",
    ...overrides,
  };
}

function eventsDir(repo: string, runId: string): string {
  return join(repo, ".cliyard", "worker-events", runId);
}

function writeEventLog(
  repo: string,
  runId: string,
  taskId: string,
  lines: string[],
): string {
  const dir = eventsDir(repo, runId);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${taskId}.jsonl`);
  writeFileSync(path, lines.join("\n") + "\n", "utf8");
  return path;
}

function jsonl(event: WorkerProgressEvent): string {
  return JSON.stringify(event);
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 10_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
  }
  throw new Error(`timed out after ${timeoutMs}ms`);
}

test("worker progress is appended during dispatch and status reads it without mutation", async () => {
  const repo = initRepo();
  let startPromise: Promise<number> | undefined;
  let releaseCollect!: () => void;
  const collectGate = new Promise<void>((resolvePromise) => {
    releaseCollect = resolvePromise;
  });
  try {
    const contractsPath = writeContracts(repo, [
      contract(repo, "foundation", "foundation.ts"),
    ]);
    const harness: {
      seenBeforeCollect: WorkerProgressEvent[];
      collectEntered: boolean;
      cwd?: string;
    } = { seenBeforeCollect: [], collectEntered: false };

    const workerFactory = (
      _worker: "codex" | "claude",
      cwd: string,
    ): AgentAdapter => {
      harness.cwd = cwd;
      let input: AgentStartInput | undefined;
      return {
        id: "claude",
        async discover() {
          return {
            id: "claude",
            ok: true,
            supportsModelFlag: true,
            notes: ["progress fixture"],
          };
        },
        async start(startInput: AgentStartInput) {
          input = startInput;
          startInput.onProgress?.({
            version: 1,
            at: new Date().toISOString(),
            source: "fixture",
            taskId: startInput.contract.taskId,
            sessionId: "fixture-session",
            type: "session.start",
            phase: "starting",
            message: "fixture worker started",
          });
          startInput.onProgress?.({
            version: 1,
            at: new Date().toISOString(),
            source: "fixture",
            taskId: startInput.contract.taskId,
            sessionId: "fixture-session",
            type: "assistant",
            phase: "thinking",
            message: "fixture assistant visible early",
          });
          return { sessionId: "fixture-session" };
        },
        async collect(sessionId: string): Promise<AgentResult> {
          assert.ok(input, "collect before start");
          const runDirs = readdirSync(join(repo, ".cliyard", "worker-events"));
          assert.equal(runDirs.length, 1);
          const logPath = join(
            eventsDir(repo, runDirs[0]!),
            `${input.contract.taskId}.jsonl`,
          );
          assert.ok(
            existsSync(logPath),
            "progress must be appended before collect completes",
          );
          harness.seenBeforeCollect = readFileSync(logPath, "utf8")
            .trim()
            .split("\n")
            .map((line) => JSON.parse(line) as WorkerProgressEvent);

          // The sink keeps working during collect and is still synchronous.
          input.onProgress?.({
            version: 1,
            at: new Date().toISOString(),
            source: "fixture",
            taskId: input.contract.taskId,
            sessionId: "fixture-session",
            type: "tool.start",
            phase: "tool",
            message: "tool Edit started",
            detail: "path foundation.ts",
          });
          // Hold the worker open so the test can read status while it runs.
          harness.collectEntered = true;
          await collectGate;
          writeFileSync(
            join(cwd, "foundation.ts"),
            "export const foundation = true;\n",
          );
          return {
            sessionId,
            exitCode: 0,
            touchedPaths: ["foundation.ts"],
            logTail: "fixture wrote foundation.ts",
          };
        },
        async cancel() {},
      };
    };

    const out: string[] = [];
    startPromise = runSupervisorCli(
      ["start", contractsPath, "--repo", repo, "--dry-run"],
      {
        log: (line) => out.push(line),
        signalHandling: false,
        workerFactory,
      },
    );
    await waitFor(() => harness.collectEntered);
    const runId = getActiveRunId(repo);
    assert.ok(runId, "active run must be recorded before collect");
    const logPath = join(eventsDir(repo, runId), "foundation.jsonl");
    assert.ok(existsSync(logPath), "progress log must exist during dispatch");

    // Status is safe while the worker is still running: it reads the latest
    // event without touching the manifest or the event log.
    try {
      const liveManifestBytes = readFileSync(
        runManifestPath(repo, runId),
        "utf8",
      );
      const liveEventBytes = readFileSync(logPath, "utf8");
      const liveOut: string[] = [];
      assert.equal(
        await runSupervisorCli(
          ["status", "--repo", repo, "--run", runId, "--json"],
          { log: (line) => liveOut.push(line), signalHandling: false },
        ),
        0,
      );
      const live = parseJson(liveOut);
      assert.equal(live.status, "running");
      assert.equal(live.accepted, 0);
      const liveProgress = (live.workerProgress as Record<string, any>[]).find(
        (entry) => entry.taskId === "foundation",
      );
      assert.ok(liveProgress, "status must expose live worker progress");
      assert.equal(liveProgress.event.type, "tool.start");
      assert.equal(liveProgress.event.message, "tool Edit started");
      assert.equal(liveProgress.stale, false);
      assert.equal(
        readFileSync(runManifestPath(repo, runId), "utf8"),
        liveManifestBytes,
      );
      assert.equal(readFileSync(logPath, "utf8"), liveEventBytes);
    } finally {
      releaseCollect();
    }

    const code = await startPromise;
    assert.equal(code, 0);
    const summary = parseJson(out);
    assert.equal(summary.runId, runId);
    assert.equal(summary.status, "completed");

    assert.deepEqual(
      harness.seenBeforeCollect.map((event) => event.type),
      ["session.start", "assistant"],
      "start events must already be durable inside collect",
    );

    const manifest = loadRunManifest(repo, runId);
    const manifestPath = runManifestPath(repo, runId);
    const manifestBytes = readFileSync(manifestPath, "utf8");
    const eventBytes = readFileSync(logPath, "utf8");

    const statusOut: string[] = [];
    const statusCode = await runSupervisorCli(
      ["status", "--repo", repo, "--run", runId, "--json"],
      { log: (line) => statusOut.push(line), signalHandling: false },
    );
    assert.equal(statusCode, 0);
    const status = parseJson(statusOut);
    assert.equal(status.status, "completed");
    assert.equal(status.accepted, 1);
    assert.equal(status.pending, 0);
    assert.equal(status.workerProgress.length, 1);
    const progress = status.workerProgress[0] as Record<string, any>;
    assert.equal(progress.taskId, "foundation");
    assert.equal(progress.event.type, "tool.start");
    assert.equal(progress.event.message, "tool Edit started");
    assert.equal(progress.stale, false);
    assert.ok(progress.ageMs >= 0);
    assert.equal(status.lastCheckpoint, manifest.updatedAt);

    const humanOut: string[] = [];
    await runSupervisorCli(["status", "--repo", repo, "--run", runId], {
      log: (line) => humanOut.push(line),
      signalHandling: false,
    });
    const text = humanOut.join("\n");
    assert.match(text, /worker progress: foundation /);
    assert.match(text, /tool Edit started/);
    assert.match(text, /path foundation\.ts/);

    // Status is strictly read-only for both the manifest and the event log.
    assert.equal(readFileSync(manifestPath, "utf8"), manifestBytes);
    assert.equal(readFileSync(logPath, "utf8"), eventBytes);
  } finally {
    // Releasing is idempotent; it unblocks collect even if the test failed
    // before reaching the explicit release.
    releaseCollect();
    await startPromise?.catch(() => undefined);
    rmSync(repo, { recursive: true, force: true });
  }
});

test("a live stream-json provider is visible through supervisor status", async () => {
  const repo = initRepo();
  const binRoot = mkdtempSync(join(tmpdir(), "cliyard-worker-progress-bin-"));
  const previousBinary = process.env.CLIYARD_CLAUDE_BINARY;
  let startPromise: Promise<number> | undefined;
  try {
    const contractsPath = writeContracts(repo, [
      contract(repo, "foundation", "foundation.ts"),
    ]);
    const binary = join(binRoot, "fake-stream-provider");
    writeFileSync(
      binary,
      `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
(async () => {
  console.log(JSON.stringify({ type: "system", subtype: "init" }));
  console.log(JSON.stringify({
    type: "assistant",
    message: {
      role: "assistant",
      content: [
        { type: "text", text: "writing foundation.ts" },
        {
          type: "tool_use",
          id: "tool-live",
          name: "Write",
          input: { file_path: "foundation.ts" }
        }
      ]
    }
  }));
  await delay(1000);
  fs.writeFileSync(
    path.join(process.cwd(), "foundation.ts"),
    "export const foundation = true;\\n"
  );
  console.log(JSON.stringify({
    type: "result",
    is_error: false,
    result: "live fixture done"
  }));
})();
`,
    );
    chmodSync(binary, 0o755);
    process.env.CLIYARD_CLAUDE_BINARY = binary;

    const out: string[] = [];
    startPromise = runSupervisorCli(
      ["start", contractsPath, "--repo", repo, "--worker", "claude"],
      { log: (line) => out.push(line), signalHandling: false },
    );

    let runId: string | undefined;
    let logPath = "";
    await waitFor(() => {
      runId = getActiveRunId(repo);
      if (!runId) return false;
      logPath = join(eventsDir(repo, runId), "foundation.jsonl");
      return (
        existsSync(logPath) &&
        readFileSync(logPath, "utf8").includes('"type":"tool.start"')
      );
    });
    assert.ok(runId);

    // The provider is still alive; status must expose its progress without
    // touching the manifest or the append-only event log.
    const manifestPath = runManifestPath(repo, runId);
    const manifestBytes = readFileSync(manifestPath, "utf8");
    const eventBytes = readFileSync(logPath, "utf8");
    const statusOut: string[] = [];
    assert.equal(
      await runSupervisorCli(
        ["status", "--repo", repo, "--run", runId, "--json"],
        { log: (line) => statusOut.push(line), signalHandling: false },
      ),
      0,
    );
    const status = parseJson(statusOut);
    assert.equal(status.status, "running");
    assert.equal(status.accepted, 0);
    const progress = (status.workerProgress as Record<string, any>[]).find(
      (entry) => entry.taskId === "foundation",
    );
    assert.ok(progress, "live stream progress missing from status");
    assert.equal(progress.event.type, "tool.start");
    assert.equal(progress.event.source, "claude");
    assert.match(progress.event.message, /Write/);
    assert.equal(progress.stale, false);
    assert.equal(readFileSync(manifestPath, "utf8"), manifestBytes);
    assert.equal(readFileSync(logPath, "utf8"), eventBytes);

    const code = await startPromise;
    assert.equal(code, 0);
    const summary = parseJson(out);
    assert.equal(summary.runId, runId);
    assert.equal(summary.status, "completed");

    // The final event is the result record, and the event log is one JSON
    // object per line.
    const finalLines = readFileSync(logPath, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as WorkerProgressEvent);
    assert.equal(finalLines.at(-1)?.type, "result");
    assert.ok(finalLines.every((event) => event.version === 1));
  } finally {
    await startPromise?.catch(() => undefined);
    if (previousBinary === undefined) {
      delete process.env.CLIYARD_CLAUDE_BINARY;
    } else {
      process.env.CLIYARD_CLAUDE_BINARY = previousBinary;
    }
    rmSync(binRoot, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  }
});

test("malformed, missing and stale progress files never alter run status", async () => {
  const repo = initRepo();
  try {
    const contractsPath = writeContracts(repo, [
      contract(repo, "foundation", "foundation.ts"),
      contract(repo, "left", "left.ts"),
    ]);
    const manifest = createRunManifest(repo, {
      planId: "worker-progress-fixture",
      contractsPath,
      baseCommit: runGit(repo, ["rev-parse", "HEAD"]),
      integrationBranch: "cliyard/integration/worker-progress-fixture",
      tasks: ["foundation", "left"],
    });
    const manifestPath = runManifestPath(repo, manifest.runId);
    const manifestBytes = readFileSync(manifestPath, "utf8");
    const now = Date.now();

    writeEventLog(repo, manifest.runId, "foundation", [
      jsonl(
        progressEvent({
          taskId: "foundation",
          message: "old assistant event",
          at: new Date(now - 2 * WORKER_PROGRESS_STALE_MS).toISOString(),
        }),
      ),
      "{ this is not json",
      jsonl(
        progressEvent({
          taskId: "foundation",
          type: "heartbeat",
          phase: "waiting",
          message: "waiting for provider output",
          at: new Date(now).toISOString(),
        }),
      ),
      // A valid event attributed to another task must not be adopted.
      jsonl(
        progressEvent({
          taskId: "left",
          message: "foreign task event",
          at: new Date(now + 1_000).toISOString(),
        }),
      ),
    ]);
    // Garbage-only file: no valid event, no progress row.
    writeEventLog(repo, manifest.runId, "left", ["not-json", "{}"]);
    // Event files for tasks outside the manifest are ignored.
    writeEventLog(repo, manifest.runId, "upper", [
      jsonl(progressEvent({ taskId: "upper", message: "untracked task" })),
    ]);

    const statusOut: string[] = [];
    assert.equal(
      await runSupervisorCli(
        ["status", "--repo", repo, "--run", manifest.runId, "--json"],
        { log: (line) => statusOut.push(line), signalHandling: false },
      ),
      0,
    );
    const status = parseJson(statusOut);
    assert.equal(status.status, "running");
    assert.equal(status.effectiveStatus, "running");
    assert.equal(status.accepted, 0);
    assert.equal(status.pending, 2);
    assert.equal(status.workerProgress.length, 1);
    assert.equal(status.workerProgress[0].taskId, "foundation");
    assert.equal(status.workerProgress[0].event.type, "heartbeat");
    assert.equal(status.workerProgress[0].event.message, "waiting for provider output");
    assert.equal(status.workerProgress[0].stale, false);
    assert.equal(readFileSync(manifestPath, "utf8"), manifestBytes);

    const humanOut: string[] = [];
    await runSupervisorCli(
      ["status", "--repo", repo, "--run", manifest.runId],
      { log: (line) => humanOut.push(line), signalHandling: false },
    );
    const human = humanOut.join("\n");
    assert.match(human, /worker progress: foundation /);
    assert.match(human, /waiting for provider output/);
    assert.doesNotMatch(human, /untracked task/);
    assert.doesNotMatch(human, /foreign task event/);

    // Stale is a display-only age flag.
    writeEventLog(repo, manifest.runId, "foundation", [
      jsonl(
        progressEvent({
          taskId: "foundation",
          message: "very old event",
          at: new Date(
            now - WORKER_PROGRESS_STALE_MS - 5_000,
          ).toISOString(),
        }),
      ),
    ]);
    const staleOut: string[] = [];
    await runSupervisorCli(
      ["status", "--repo", repo, "--run", manifest.runId, "--json"],
      { log: (line) => staleOut.push(line), signalHandling: false },
    );
    const stale = parseJson(staleOut);
    assert.equal(stale.status, "running");
    assert.equal(stale.accepted, 0);
    assert.equal(stale.workerProgress[0].stale, true);
    assert.ok(
      stale.workerProgress[0].ageMs >= WORKER_PROGRESS_STALE_MS,
      "age must be derived from the event timestamp",
    );

    // Missing files simply hide progress.
    rmSync(eventsDir(repo, manifest.runId), { recursive: true, force: true });
    const missingOut: string[] = [];
    await runSupervisorCli(
      ["status", "--repo", repo, "--run", manifest.runId, "--json"],
      { log: (line) => missingOut.push(line), signalHandling: false },
    );
    const missing = parseJson(missingOut);
    assert.deepEqual(missing.workerProgress, []);
    assert.equal(missing.status, "running");
    assert.equal(missing.accepted, 0);
    assert.equal(missing.pending, 2);
    assert.equal(readFileSync(manifestPath, "utf8"), manifestBytes);

    const missingHuman: string[] = [];
    await runSupervisorCli(
      ["status", "--repo", repo, "--run", manifest.runId],
      { log: (line) => missingHuman.push(line), signalHandling: false },
    );
    assert.match(missingHuman.join("\n"), /worker progress: none/);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

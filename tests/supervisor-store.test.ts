import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { hostname, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { StateStoreLegacyDriftError } from "../src/statestore/write.js";
import {
  acquireSupervisorLock,
  assertContractsHash,
  checkContractsHash,
  clearActiveRun,
  clearStaleSupervisorLock,
  computeContractsHash,
  ContractsHashMismatchError,
  createRunManifest,
  getActiveRun,
  getActiveRunId,
  inspectRun,
  inspectSupervisorLock,
  inspectSupervisorStateStore,
  loadRunManifest,
  markRunInterrupted,
  NoActiveRunError,
  runManifestPath,
  RunNotFoundError,
  saveRunManifest,
  setActiveRun,
  supervisorPaths,
  supervisorStatePaths,
  SupervisorLockHeldError,
  updateRunManifest,
  withSupervisorLock,
  type CreateRunManifestInput,
} from "../src/supervisor/store.js";

const BASE_COMMIT = "a".repeat(40);
const RESULT_COMMIT = "b".repeat(40);

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function writeContracts(repo: string, marker = "v1"): string {
  const path = join(repo, "contracts.json");
  writeFileSync(
    path,
    JSON.stringify(
      {
        taskId: "task-a",
        version: 1,
        frozen: true,
        goals: [`supervise ${marker}`],
        dependsOn: [],
        readPaths: [],
        writePaths: ["src/supervisor/store.ts"],
        sharedResources: [],
        baseCommit: BASE_COMMIT,
        verifyCommands: [],
        maxRepairs: 0,
      },
      null,
      2,
    ) + "\n",
    "utf8",
  );
  return path;
}

function baseInput(
  contractsPath: string,
  overrides: Partial<CreateRunManifestInput> = {},
): CreateRunManifestInput {
  return {
    planId: "supervisor-v0",
    contractsPath,
    baseCommit: BASE_COMMIT,
    integrationBranch: "cliyard/integration/sv0",
    tasks: ["task-a", "task-b"],
    ...overrides,
  };
}

async function withTempRepo(
  fn: (repo: string) => void | Promise<void>,
): Promise<void> {
  const repo = mkdtempSync(join(tmpdir(), "cliyard-supervisor-"));
  try {
    await fn(repo);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
}

/** Spawn a process and return its pid after it has exited and been reaped. */
async function exitedPid(): Promise<number> {
  const child = spawn(process.execPath, ["-e", "process.exit(0)"], {
    stdio: "ignore",
  });
  assert.ok(child.pid);
  await once(child, "exit");
  return child.pid;
}

async function waitForFile(path: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!existsSync(path)) {
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${path}`);
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
  }
}

// ---------------------------------------------------------------------------
// Create / load / save / active pointer
// ---------------------------------------------------------------------------

test("create writes a manifest, hashes contracts, and activates the run", async () => {
  await withTempRepo((repo) => {
    const contractsPath = writeContracts(repo);
    const manifest = createRunManifest(repo, baseInput(contractsPath));

    assert.equal(manifest.version, 1);
    assert.equal(manifest.status, "running");
    assert.equal(manifest.planId, "supervisor-v0");
    assert.equal(manifest.repoRoot, repo);
    assert.equal(manifest.contractsPath, contractsPath);
    assert.equal(manifest.contractsHash, computeContractsHash(contractsPath));
    assert.equal(manifest.baseCommit, BASE_COMMIT);
    assert.equal(manifest.integrationHead, BASE_COMMIT);
    assert.equal(manifest.owner.pid, process.pid);
    assert.equal(manifest.owner.host, hostname());
    assert.deepEqual(Object.keys(manifest.tasks).sort(), ["task-a", "task-b"]);
    assert.equal(manifest.tasks["task-a"]!.status, "ready");
    assert.equal(manifest.tasks["task-a"]!.accepted, false);

    assert.ok(existsSync(runManifestPath(repo, manifest.runId)));
    assert.deepEqual(loadRunManifest(repo, manifest.runId), manifest);
    assert.deepEqual(loadRunManifest(repo), manifest);

    const active = getActiveRun(repo);
    assert.equal(active?.runId, manifest.runId);
    assert.equal(active?.version, 1);
    assert.equal(getActiveRunId(repo), manifest.runId);

    // save() is the explicit checkpoint path; load() must see the new state.
    manifest.status = "completed";
    saveRunManifest(manifest);
    assert.equal(loadRunManifest(repo, manifest.runId).status, "completed");
  });
});

test("update persists accepted-task checkpoints in a complete file", async () => {
  await withTempRepo(async (repo) => {
    const contractsPath = writeContracts(repo);
    const manifest = createRunManifest(repo, baseInput(contractsPath));

    const updated = updateRunManifest(repo, manifest.runId, (current) => {
      current.tasks["task-a"] = {
        taskId: "task-a",
        status: "accepted",
        accepted: true,
        resultCommit: RESULT_COMMIT,
      };
      current.integrationHead = RESULT_COMMIT;
    });

    assert.equal(updated.tasks["task-a"]!.accepted, true);
    assert.equal(updated.tasks["task-b"]!.accepted, false);
    assert.equal(updated.integrationHead, RESULT_COMMIT);
    assert.ok(
      Date.parse(updated.updatedAt) >= Date.parse(updated.createdAt),
      "updatedAt must not precede createdAt",
    );

    const reloaded = loadRunManifest(repo, manifest.runId);
    assert.equal(reloaded.tasks["task-a"]!.resultCommit, RESULT_COMMIT);
    assert.equal(reloaded.tasks["task-a"]!.status, "accepted");

    // Atomic writers must not leave temp files behind.
    const leftovers = readdirSync(supervisorPaths(repo).runsDir).filter((name) =>
      name.endsWith(".tmp"),
    );
    assert.deepEqual(leftovers, []);

    // A concurrent reader must never parse a truncated manifest.
    await assertConcurrentReaderSeesCompleteManifests(repo, manifest.runId);
  });
});

test("active run lookup follows create, switches, and clears", async () => {
  await withTempRepo((repo) => {
    const contractsPath = writeContracts(repo);
    const runA = createRunManifest(
      repo,
      baseInput(contractsPath, { runId: "run-a" }),
    );
    const runB = createRunManifest(
      repo,
      baseInput(contractsPath, { runId: "run-b" }),
    );

    assert.equal(getActiveRunId(repo), runB.runId);
    assert.equal(loadRunManifest(repo).runId, runB.runId);

    // Clearing a non-active run must not disturb the pointer.
    assert.equal(clearActiveRun(repo, runA.runId), false);
    assert.equal(getActiveRunId(repo), runB.runId);

    assert.equal(clearActiveRun(repo, runB.runId), true);
    assert.equal(getActiveRunId(repo), undefined);
    assert.throws(() => loadRunManifest(repo), NoActiveRunError);

    // The manifest is still addressable by id after the pointer is gone.
    assert.equal(loadRunManifest(repo, runB.runId).runId, runB.runId);

    setActiveRun(repo, runA.runId);
    assert.equal(getActiveRunId(repo), runA.runId);
    assert.throws(() => setActiveRun(repo, "missing"), RunNotFoundError);
    assert.throws(
      () =>
        createRunManifest(repo, baseInput(contractsPath, { runId: runA.runId })),
      /already exists/,
    );
  });
});

// ---------------------------------------------------------------------------
// Contracts hash
// ---------------------------------------------------------------------------

test("contracts hash mismatch is detectable and blocks resume", async () => {
  await withTempRepo((repo) => {
    const contractsPath = writeContracts(repo);
    const manifest = createRunManifest(repo, baseInput(contractsPath));

    const before = checkContractsHash(manifest);
    assert.deepEqual(before, {
      ok: true,
      contractsPath,
      expected: manifest.contractsHash,
      actual: computeContractsHash(contractsPath),
    });
    assert.doesNotThrow(() => assertContractsHash(manifest));

    writeContracts(repo, "v2-changed");

    const after = checkContractsHash(manifest);
    assert.equal(after.ok, false);
    assert.notEqual(after.actual, manifest.contractsHash);
    assert.throws(
      () => assertContractsHash(manifest),
      (error: unknown) =>
        error instanceof ContractsHashMismatchError &&
        error.contractsPath === contractsPath &&
        error.expected === manifest.contractsHash &&
        error.actual === after.actual,
    );
  });
});

// ---------------------------------------------------------------------------
// Exclusive lock and stale/interrupted detection
// ---------------------------------------------------------------------------

test("supervisor lock is exclusive and records its owner", async () => {
  await withTempRepo(async (repo) => {
    const contractsPath = writeContracts(repo);
    const manifest = createRunManifest(repo, baseInput(contractsPath));
    const { lockPath } = supervisorPaths(repo);

    const lock = acquireSupervisorLock(repo, manifest.runId);

    const onDisk = JSON.parse(readFileSync(lockPath, "utf8")) as {
      runId: string;
      pid: number;
      host: string;
      acquiredAt: string;
    };
    assert.equal(onDisk.runId, manifest.runId);
    assert.equal(onDisk.pid, process.pid);
    assert.equal(onDisk.host, hostname());
    assert.ok(!Number.isNaN(Date.parse(onDisk.acquiredAt)));

    const held = inspectSupervisorLock(repo);
    assert.equal(held.state, "held");
    assert.equal(held.lock?.runId, manifest.runId);

    assert.throws(
      () => acquireSupervisorLock(repo, "other-run"),
      (error: unknown) =>
        error instanceof SupervisorLockHeldError &&
        error.owner?.runId === manifest.runId &&
        error.owner.pid === process.pid,
    );

    lock.release();
    assert.equal(inspectSupervisorLock(repo).state, "free");
    lock.release(); // idempotent

    // A later owner can acquire after release.
    const second = acquireSupervisorLock(repo, "other-run");
    assert.equal(inspectSupervisorLock(repo).lock?.runId, "other-run");
    second.release();

    // withSupervisorLock releases on both success and failure.
    await withSupervisorLock(repo, "with-run", (acquired) => {
      assert.equal(acquired.lock.runId, "with-run");
    });
    assert.equal(inspectSupervisorLock(repo).state, "free");
    await assert.rejects(
      withSupervisorLock(repo, "crash-run", () => {
        throw new Error("boom");
      }),
      /boom/,
    );
    assert.equal(inspectSupervisorLock(repo).state, "free");
  });
});

test("stale lock and interrupted run are detected but not auto-reclaimed", async () => {
  await withTempRepo(async (repo) => {
    const deadPid = await exitedPid();
    const contractsPath = writeContracts(repo);
    const manifest = createRunManifest(
      repo,
      baseInput(contractsPath, {
        owner: { pid: deadPid, host: hostname() },
      }),
    );
    const { lockPath } = supervisorPaths(repo);
    writeFileSync(
      lockPath,
      JSON.stringify({
        runId: manifest.runId,
        pid: deadPid,
        host: hostname(),
        acquiredAt: new Date().toISOString(),
      }) + "\n",
      "utf8",
    );

    const staleLock = inspectSupervisorLock(repo);
    assert.equal(staleLock.state, "stale");
    assert.equal(staleLock.lock?.pid, deadPid);
    assert.match(staleLock.reason ?? "", /not running/);

    // Strict exclusivity: a stale lock must be cleared explicitly first.
    assert.throws(
      () => acquireSupervisorLock(repo, manifest.runId),
      SupervisorLockHeldError,
    );

    const interrupted = inspectRun(repo, manifest.runId);
    assert.equal(interrupted.ownerAlive, false);
    assert.equal(interrupted.interrupted, true);

    const marked = markRunInterrupted(repo, manifest.runId);
    assert.equal(marked.status, "interrupted");
    assert.equal(
      loadRunManifest(repo, manifest.runId).status,
      "interrupted",
    );
    // Idempotent, and no longer "interrupted" because the state is explicit.
    assert.equal(markRunInterrupted(repo, manifest.runId).status, "interrupted");
    assert.equal(inspectRun(repo, manifest.runId).interrupted, false);

    assert.equal(clearStaleSupervisorLock(repo), true);
    assert.equal(inspectSupervisorLock(repo).state, "free");
    assert.equal(clearStaleSupervisorLock(repo), false);

    const reclaimed = acquireSupervisorLock(repo, "resumed-run");
    assert.equal(inspectSupervisorLock(repo).state, "held");
    reclaimed.release();
  });
});

test("force acquisition replaces an unreadable lock", async () => {
  await withTempRepo((repo) => {
    const contractsPath = writeContracts(repo);
    const manifest = createRunManifest(repo, baseInput(contractsPath));
    const { lockPath } = supervisorPaths(repo);
    writeFileSync(lockPath, "not-json\n", "utf8");

    assert.equal(inspectSupervisorLock(repo).state, "invalid");
    assert.throws(
      () => acquireSupervisorLock(repo, manifest.runId),
      SupervisorLockHeldError,
    );

    const forced = acquireSupervisorLock(repo, "forced-run", { force: true });
    assert.equal(inspectSupervisorLock(repo).lock?.runId, "forced-run");
    forced.release();
    assert.equal(inspectSupervisorLock(repo).state, "free");
  });
});

// ---------------------------------------------------------------------------
// Cross-process atomicity probe
// ---------------------------------------------------------------------------

const READER_SOURCE = `
const { existsSync, readFileSync, writeFileSync } = require("node:fs");
const [manifestPath, readyPath, stopPath] = process.argv.slice(2);
let reads = 0;
let timer;
function fail(message) {
  clearInterval(timer);
  console.error(message);
  process.exit(1);
}
function readOnce() {
  const parsed = JSON.parse(readFileSync(manifestPath, "utf8"));
  if (typeof parsed.runId !== "string" || !parsed.tasks) {
    throw new Error("incomplete manifest");
  }
  reads += 1;
}
try {
  readOnce();
} catch (error) {
  fail("atomicity violation: " + error.message);
}
writeFileSync(readyPath, "ready");
timer = setInterval(() => {
  if (existsSync(stopPath)) {
    clearInterval(timer);
    if (reads === 0) fail("reader observed no writes");
    else process.exit(0);
    return;
  }
  try {
    readOnce();
  } catch (error) {
    fail("atomicity violation: " + error.message);
  }
}, 1);
`;

async function assertConcurrentReaderSeesCompleteManifests(
  repo: string,
  runId: string,
): Promise<void> {
  const dir = join(repo, "atomicity-probe");
  mkdirSync(dir, { recursive: true });
  const scriptPath = join(dir, "reader.cjs");
  const readyPath = join(dir, "reader.ready");
  const stopPath = join(dir, "reader.stop");
  writeFileSync(scriptPath, READER_SOURCE, "utf8");

  const child = spawn(
    process.execPath,
    [scriptPath, runManifestPath(repo, runId), readyPath, stopPath],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += String(chunk);
  });

  try {
    await waitForFile(readyPath);
    for (let i = 0; i < 25; i++) {
      updateRunManifest(repo, runId, (manifest) => {
        manifest.tasks["task-b"]!.reason = `checkpoint ${i}`;
        manifest.integrationHead = RESULT_COMMIT;
      });
    }
    writeFileSync(stopPath, "stop", "utf8");
    const [code] = (await once(child, "exit")) as [number | null, string | null];
    assert.equal(code, 0, `reader failed: ${stderr}`);
  } finally {
    if (child.exitCode === null && !child.killed) child.kill();
  }
}

// ---------------------------------------------------------------------------
// StateStore cutover: one-time import, fresh-process rebuild, drift
// ---------------------------------------------------------------------------

const STORE_MODULE_URL = pathToFileURL(
  resolve(dirname(fileURLToPath(import.meta.url)), "../src/supervisor/store.ts"),
).href;

const FRESH_PROCESS_SOURCE = `
const { loadRunManifest, getActiveRunId, inspectSupervisorStateStore } =
  await import(process.argv[2]);
const [repo, runId] = process.argv.slice(3);
try {
  const manifest = loadRunManifest(repo, runId);
  const inspection = inspectSupervisorStateStore(repo);
  process.stdout.write(
    "RESULT:" +
      JSON.stringify({
        manifest,
        activeRunId: getActiveRunId(repo),
        backend: inspection?.backend,
        storedRunIds: inspection?.runs.map((run) => run.runId) ?? [],
      }) +
      "\\n",
  );
} catch (error) {
  console.error(error?.stack ?? String(error));
  process.exit(1);
}
`;

interface FreshProcessState {
  manifest: ReturnType<typeof loadRunManifest>;
  activeRunId: string | undefined;
  backend: string | undefined;
  storedRunIds: string[];
}

function readFreshProcessState(
  repo: string,
  runId: string,
): FreshProcessState {
  const probeDir = mkdtempSync(join(tmpdir(), "cliyard-fresh-probe-"));
  const scriptPath = join(probeDir, "probe.mjs");
  writeFileSync(scriptPath, FRESH_PROCESS_SOURCE, "utf8");
  try {
    const child = spawnSync(
      process.execPath,
      ["--import", "tsx", scriptPath, STORE_MODULE_URL, repo, runId],
      {
        cwd: resolve(dirname(fileURLToPath(import.meta.url)), ".."),
        encoding: "utf8",
      },
    );
    assert.equal(child.status, 0, child.stderr);
    const line = child.stdout
      .split("\n")
      .find((entry) => entry.startsWith("RESULT:"));
    assert.ok(line, `child produced no result: ${child.stdout}`);
    return JSON.parse(line.slice("RESULT:".length)) as FreshProcessState;
  } finally {
    rmSync(probeDir, { recursive: true, force: true });
  }
}

test("first write imports legacy runs once and verifies the import hash", async () => {
  await withTempRepo((repo) => {
    const contractsPath = writeContracts(repo);
    const manifest = createRunManifest(
      repo,
      baseInput(contractsPath, { runId: "legacy-run" }),
    );
    updateRunManifest(repo, manifest.runId, (current) => {
      current.tasks["task-a"]!.status = "accepted";
      current.tasks["task-a"]!.accepted = true;
      current.tasks["task-a"]!.resultCommit = RESULT_COMMIT;
      current.integrationHead = RESULT_COMMIT;
    });

    // Drop the StateStore to simulate a repository written before the cutover.
    rmSync(supervisorStatePaths(repo).stateDir, {
      recursive: true,
      force: true,
    });
    assert.equal(inspectSupervisorStateStore(repo), undefined);
    const legacy = loadRunManifest(repo, manifest.runId);
    assert.equal(legacy.tasks["task-a"]!.accepted, true);

    const updated = updateRunManifest(repo, manifest.runId, (current) => {
      current.tasks["task-b"]!.status = "running";
    });

    const inspection = inspectSupervisorStateStore(repo);
    assert.ok(inspection, "the first write must create the StateStore");
    assert.ok(inspection.migration, "the import marker must be recorded");
    assert.equal(inspection.migration.importedRuns, 1);
    assert.match(inspection.migration.importHash, /^[0-9a-f]{64}$/);
    assert.match(inspection.migration.sourceHash, /^[0-9a-f]{64}$/);
    assert.match(inspection.migration.contentHash, /^[0-9a-f]{64}$/);
    assert.ok(!Number.isNaN(Date.parse(inspection.migration.importedAt)));
    assert.deepEqual(inspection.runs, [updated]);
    assert.equal(inspection.activeRun?.runId, manifest.runId);

    // The import is one-time: later checkpoints must not re-import.
    const second = updateRunManifest(repo, manifest.runId, (current) => {
      current.status = "completed";
    });
    const again = inspectSupervisorStateStore(repo);
    assert.ok(again?.migration);
    assert.equal(again.migration.importedAt, inspection.migration.importedAt);
    assert.equal(again.migration.importHash, inspection.migration.importHash);
    assert.deepEqual(again.runs, [second]);
  });
});

test("a fresh process rebuilds the same run state without JSON exports", async () => {
  await withTempRepo((repo) => {
    const contractsPath = writeContracts(repo);
    const manifest = createRunManifest(
      repo,
      baseInput(contractsPath, { runId: "fresh-run" }),
    );
    const saved = updateRunManifest(repo, manifest.runId, (current) => {
      current.tasks["task-a"]!.status = "accepted";
      current.tasks["task-a"]!.accepted = true;
      current.tasks["task-a"]!.resultCommit = RESULT_COMMIT;
      current.tasks["task-b"]!.status = "running";
      current.integrationHead = RESULT_COMMIT;
      current.status = "completed";
    });

    // Legacy JSON is only an export: deleting it must lose no authority.
    rmSync(supervisorPaths(repo).runsDir, { recursive: true, force: true });
    assert.equal(existsSync(runManifestPath(repo, manifest.runId)), false);
    assert.equal(existsSync(supervisorPaths(repo).activePath), false);

    // Identity is owned by the store, so a deleted export cannot be reused
    // to create a second run with the same id.
    assert.throws(
      () =>
        createRunManifest(
          repo,
          baseInput(contractsPath, { runId: manifest.runId }),
        ),
      /already exists/,
    );

    const rebuilt = readFreshProcessState(repo, manifest.runId);
    assert.deepEqual(rebuilt.manifest, saved);
    assert.equal(rebuilt.manifest.status, "completed");
    assert.equal(rebuilt.manifest.tasks["task-a"]!.accepted, true);
    assert.equal(rebuilt.manifest.tasks["task-a"]!.resultCommit, RESULT_COMMIT);
    assert.equal(rebuilt.activeRunId, manifest.runId);
    assert.deepEqual(rebuilt.storedRunIds, [manifest.runId]);
    assert.ok(rebuilt.backend, "the child must report the store backend");

    // A missing export is a recoverable projection, not drift: the next
    // checkpoint rebuilds it from the StateStore record.
    const recovered = updateRunManifest(repo, manifest.runId, (current) => {
      current.tasks["task-b"]!.reason = "rebuilt export";
    });
    assert.ok(existsSync(runManifestPath(repo, manifest.runId)));
    assert.equal(
      loadRunManifest(repo, manifest.runId).tasks["task-b"]!.reason,
      "rebuilt export",
    );
    assert.deepEqual(inspectSupervisorStateStore(repo)?.runs, [recovered]);
  });
});

test("legacy JSON drift fails closed, keeps facts, and recovers", async () => {
  await withTempRepo((repo) => {
    const contractsPath = writeContracts(repo);
    const manifest = createRunManifest(
      repo,
      baseInput(contractsPath, { runId: "drift-run" }),
    );
    const path = runManifestPath(repo, manifest.runId);
    const original = readFileSync(path, "utf8");
    const before = inspectSupervisorStateStore(repo);
    assert.ok(before);

    const tampered = JSON.parse(original) as ReturnType<
      typeof loadRunManifest
    >;
    tampered.status = "completed";
    tampered.tasks["task-a"]!.status = "accepted";
    tampered.tasks["task-a"]!.accepted = true;
    tampered.tasks["task-a"]!.resultCommit = RESULT_COMMIT;
    const tamperedBytes = JSON.stringify(tampered, null, 2) + "\n";
    writeFileSync(path, tamperedBytes, "utf8");

    assert.throws(
      () =>
        updateRunManifest(repo, manifest.runId, (current) => {
          current.status = "blocked";
        }),
      (error: unknown) => {
        assert.ok(error instanceof StateStoreLegacyDriftError);
        assert.equal(error.code, "statestore.write.legacy_drift");
        assert.equal(error.needsHuman, true);
        assert.match(error.message, /supervisor export drift/);
        assert.match(error.message, /needs human/);
        return true;
      },
    );

    // No fact is appended and the drifted export is not silently overwritten.
    const after = inspectSupervisorStateStore(repo);
    assert.ok(after);
    assert.deepEqual(after.runs, before.runs);
    assert.deepEqual(after.activeRun, before.activeRun);
    assert.equal(readFileSync(path, "utf8"), tamperedBytes);

    // A foreign run export is equally fatal: it has no StateStore record.
    writeFileSync(path, original, "utf8");
    const ghost = JSON.parse(original) as ReturnType<typeof loadRunManifest>;
    ghost.runId = "ghost-run";
    ghost.updatedAt = new Date().toISOString();
    writeFileSync(
      runManifestPath(repo, ghost.runId),
      JSON.stringify(ghost, null, 2) + "\n",
      "utf8",
    );
    assert.throws(
      () =>
        updateRunManifest(repo, manifest.runId, (current) => {
          current.status = "blocked";
        }),
      (error: unknown) =>
        error instanceof StateStoreLegacyDriftError &&
        /ghost-run/.test(error.message),
    );

    // Restoring the export (or removing a foreign one) unblocks writes.
    rmSync(runManifestPath(repo, ghost.runId), { force: true });
    const recovered = updateRunManifest(repo, manifest.runId, (current) => {
      current.status = "blocked";
    });
    assert.equal(recovered.status, "blocked");
    assert.deepEqual(inspectSupervisorStateStore(repo)?.runs, [recovered]);
  });
});

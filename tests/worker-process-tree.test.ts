/**
 * managed-worker-process-tree (design/worker-process-tree-v1.md).
 *
 * Every POSIX test uses real detached Node fixtures that spawn helper
 * processes, so the evidence comes from actual process groups rather than a
 * mocked signal path. Windows cannot provide POSIX group semantics; the
 * platform limit is tested through the documented exact-child mode and all
 * real-group tests are skipped there.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { ProcessInspector } from "../src/runtime/process.js";
import {
  createProcessTreeCleanupFailure,
  isWorkerProcessCleanupFailure,
  MAX_PROCESS_TREE_MEMBERS,
  parseWorkerProcessRecord,
  WorkerProcessTreeManager,
  type WorkerProcessTreeInspector,
  type WorkerProcessTreeManagerOptions,
  type WorkerProcessRecord,
} from "../src/agents/process-tree.js";
import { createClaudeAdapter } from "../src/agents/claude.js";
import { createCodexAdapter } from "../src/agents/codex.js";
import { runClosedLoop } from "../src/repair/loop.js";
import type {
  AgentAdapter,
  AgentResult,
  AgentStartInput,
} from "../src/agents/types.js";
import type { Verifier, VerifyResult } from "../src/verification/verifier.js";
import {
  createRunManifest,
  loadRunManifest,
  runManifestPath,
  saveRunManifest,
} from "../src/supervisor/store.js";
import type { RunManifest, RunTaskState } from "../src/supervisor/types.js";
import type { TaskContract } from "../src/contracts/schema.js";

const POSIX = process.platform !== "win32";
const posixTest = POSIX ? test : test.skip;
const inspector = new ProcessInspector();

const root = mkdtempSync(join(tmpdir(), "cliyard-worker-tree-"));
const fixturePath = join(root, "worker-leader.mjs");
const helperFixture = join(root, "helper.mjs");

writeFileSync(
  fixturePath,
  `import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";

const pidFile = process.argv[2];
const childCount = Number(process.argv[3] ?? "1");
const holdMs = Number(process.argv[4] ?? "60000");
const ignoreTerm = process.argv[5] === "ignore";
const childIgnoreTerm = process.argv[6] === "ignore";

if (ignoreTerm) process.on("SIGTERM", () => {});
const pids = [];
for (let index = 0; index < childCount; index += 1) {
  const child = spawn(
    process.execPath,
    [${JSON.stringify(helperFixture)}, childIgnoreTerm ? "ignore" : "term"],
    { stdio: "ignore" },
  );
  pids.push(child.pid);
}
writeFileSync(pidFile, JSON.stringify(pids));
setTimeout(() => process.exit(0), holdMs);
`,
  "utf8",
);

writeFileSync(
  helperFixture,
  `if (process.argv[2] === "ignore") process.on("SIGTERM", () => {});
setInterval(() => {}, 1000);
`,
  "utf8",
);

let pidSeq = 0;
function nextPidFile(label: string): string {
  pidSeq += 1;
  return join(root, `${label}-${pidSeq}.json`);
}

function manager(
  overrides: Partial<WorkerProcessTreeManagerOptions> = {},
): WorkerProcessTreeManager {
  return new WorkerProcessTreeManager({
    inspector,
    termGraceMs: 400,
    killGraceMs: 1_000,
    pollMs: 20,
    ...overrides,
  });
}

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  label: string,
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await predicate()) return;
    if (Date.now() >= deadline) {
      throw new Error(`timed out waiting for ${label}`);
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 20));
  }
}

async function readHelperPids(path: string): Promise<number[]> {
  await waitFor(() => existsSync(path), `pid file ${path}`);
  await waitFor(() => {
    try {
      return JSON.parse(readFileSync(path, "utf8")).length > 0;
    } catch {
      return false;
    }
  }, `complete pid file ${path}`);
  const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
  assert.ok(Array.isArray(parsed));
  return parsed.map((pid) => Number(pid));
}

function spawnLeader(
  tree: WorkerProcessTreeManager,
  pidFile: string,
  options: {
    children?: number;
    holdMs?: number;
    ignoreTerm?: boolean;
    childIgnoreTerm?: boolean;
  } = {},
) {
  return tree.spawn(
    process.execPath,
    [
      fixturePath,
      pidFile,
      String(options.children ?? 1),
      String(options.holdMs ?? 60_000),
      options.ignoreTerm ? "ignore" : "term",
      options.childIgnoreTerm ? "ignore" : "term",
    ],
    { stdio: ["ignore", "ignore", "ignore"] },
  );
}

function cleanupFixtures(): void {
  rmSync(root, { recursive: true, force: true });
}
process.on("exit", cleanupFixtures);

// ---------------------------------------------------------------------------
// Identity capture and residual cleanup
// ---------------------------------------------------------------------------

posixTest(
  "captures the exact dedicated process-group identity immediately after spawn",
  async () => {
    const tree = manager();
    const pidFile = nextPidFile("identity");
    const managed = spawnLeader(tree, pidFile, { children: 0 });
    try {
      const outcome = await managed.cleanup("timeout");
      const record = outcome.record;
      assert.equal(record.captureSupport, "posix-process-group");
      assert.equal(record.captureSource, "ps-exact");
      assert.ok(record.identity);
      assert.equal(record.identity.pid, record.pid);
      assert.equal(record.identity.pgid, record.pid);
      assert.equal(record.pgid, record.pid);
      assert.equal(record.cleanupReason, "timeout");
      assert.equal(record.cleanupState, "terminated");
      assert.equal(outcome.treeOk, true);
      assert.equal(record.signals[0]?.signal, "SIGTERM");
      assert.equal(record.signals[0]?.scope, "process-group");
      assert.equal(record.host, inspector.host);
      assert.deepEqual(record.residualMembers, []);
    } finally {
      await managed.cleanup("cancel");
    }
  },
);

posixTest(
  "cleans residual descendants after normal leader exit (prior leak reproduction)",
  async () => {
    const tree = manager();
    const pidFile = nextPidFile("normal-exit");
    // The leader spawns a helper and exits immediately. The helper remains in
    // the dedicated group: this is the leak observed in CONTINUATION_SELF_HOST.
    const managed = spawnLeader(tree, pidFile, {
      children: 1,
      holdMs: 0,
    });
    // Subscribe before the leader can exit; `once` does not replay events.
    const exited = once(managed.child, "exit");
    const [helperPid] = await readHelperPids(pidFile);
    assert.ok(helperPid);
    assert.equal(inspector.isAlive(helperPid), true);

    await exited;
    const outcome = await managed.cleanup("child-close");
    const record = outcome.record;
    assert.equal(record.cleanupReason, "child-close");
    assert.equal(record.cleanupState, "terminated");
    assert.ok(record.residualCount >= 1);
    assert.ok(record.residualMembers.some((member) => member.pid === helperPid));
    assert.equal(record.exitCode, 0);
    await waitFor(
      () => !inspector.isAlive(helperPid),
      "residual helper death",
    );
  },
);

posixTest("timeout cleanup terminates helper descendants", async () => {
  const tree = manager();
  const pidFile = nextPidFile("timeout");
  const managed = spawnLeader(tree, pidFile, { children: 1 });
  const [helperPid] = await readHelperPids(pidFile);
  const outcome = await managed.cleanup("timeout");
  const record = outcome.record;
  assert.equal(record.cleanupReason, "timeout");
  assert.equal(record.cleanupState, "terminated");
  assert.ok(record.signals.some((signal) => signal.scope === "process-group"));
  await waitFor(() => !inspector.isAlive(helperPid), "helper death after timeout");
});

posixTest("cancel cleanup terminates helper descendants and is idempotent", async () => {
  const tree = manager();
  const pidFile = nextPidFile("cancel");
  const managed = spawnLeader(tree, pidFile, { children: 1 });
  const [helperPid] = await readHelperPids(pidFile);
  const [first, second] = await Promise.all([
    managed.cleanup("cancel"),
    managed.cleanup("timeout"),
  ]);
  // First reason wins; both callers observe the same terminal record.
  assert.equal(first.record.cleanupReason, "cancel");
  assert.deepEqual(first.record, second.record);
  assert.equal(first.record.cleanupState, "terminated");
  const signalCount = first.record.signals.length;
  const third = await managed.cleanup("child-close");
  assert.deepEqual(first.record, third.record);
  assert.equal(third.record.signals.length, signalCount);
  await waitFor(() => !inspector.isAlive(helperPid), "helper death after cancel");
});

posixTest(
  "escalates SIGTERM to SIGKILL only when the managed group ignores SIGTERM",
  async () => {
    const tree = manager({ termGraceMs: 250, killGraceMs: 1_500 });
    const pidFile = nextPidFile("escalate");
    const managed = spawnLeader(tree, pidFile, {
      children: 1,
      ignoreTerm: true,
      childIgnoreTerm: true,
    });
    const [helperPid] = await readHelperPids(pidFile);
    const startedAt = Date.now();
    const outcome = await managed.cleanup("timeout");
    const elapsed = Date.now() - startedAt;
    const record = outcome.record;
    assert.equal(record.cleanupState, "terminated");
    assert.ok(elapsed >= 200, `expected a bounded grace wait, got ${elapsed}ms`);
    assert.deepEqual(
      record.signals.map((signal) => `${signal.signal}:${signal.scope}`),
      ["SIGTERM:process-group", "SIGKILL:process-group"],
    );
    await waitFor(
      () => !inspector.isAlive(helperPid),
      "helper death after escalation",
    );
    assert.equal(inspector.isAlive(record.pid), false);
  },
);

posixTest("bounds residual evidence while reporting the true count", async () => {
  const tree = manager({ termGraceMs: 250, killGraceMs: 2_000 });
  const pidFile = nextPidFile("bounded");
  const helperCount = MAX_PROCESS_TREE_MEMBERS + 2;
  const managed = spawnLeader(tree, pidFile, {
    children: helperCount,
    ignoreTerm: true,
    childIgnoreTerm: true,
  });
  const helperPids = await readHelperPids(pidFile);
  const outcome = await managed.cleanup("cancel");
  const record = outcome.record;
  assert.equal(record.cleanupState, "terminated");
  assert.equal(record.residualMembers.length, MAX_PROCESS_TREE_MEMBERS);
  assert.ok(record.residualCount >= MAX_PROCESS_TREE_MEMBERS + 1);
  assert.equal(
    record.residualMembers.length <= MAX_PROCESS_TREE_MEMBERS,
    true,
  );
  // The persisted record stays bounded even when the group is larger.
  assert.equal(record.signals.length <= 8, true);
  await waitFor(
    () => helperPids.every((pid) => !inspector.isAlive(pid)),
    "all bounded residual helpers death",
  );
});

// ---------------------------------------------------------------------------
// Identity fallback and fail-closed behavior
// ---------------------------------------------------------------------------

posixTest(
  "uses the reserved spawned pgid when the leader exited before identity capture",
  async () => {
    const reservationInspector: WorkerProcessTreeInspector = {
      get host() {
        return inspector.host;
      },
      get supported() {
        return inspector.supported;
      },
      isAlive: (pid) => inspector.isAlive(pid),
      capture: async (pid) =>
        pid === process.pid ? inspector.capture(pid) : undefined,
      listGroupMembers: (pgid) => inspector.listGroupMembers(pgid),
    };
    const tree = manager({ inspector: reservationInspector });
    const pidFile = nextPidFile("reservation");
    const managed = spawnLeader(tree, pidFile, { children: 1 });
    const [helperPid] = await readHelperPids(pidFile);
    const outcome = await managed.cleanup("cancel");
    const record = outcome.record;
    assert.equal(record.captureSource, "pgid-reservation");
    assert.equal(record.identity, undefined);
    assert.equal(record.pgid, record.pid);
    assert.equal(record.cleanupState, "terminated");
    await waitFor(
      () => !inspector.isAlive(helperPid),
      "helper death after reservation cleanup",
    );
  },
);

posixTest("fails closed when group inspection stays ambiguous", async () => {
  const ambiguous: WorkerProcessTreeInspector = {
    get host() {
      return inspector.host;
    },
    get supported() {
      return inspector.supported;
    },
    isAlive: (pid) => inspector.isAlive(pid),
    capture: async () => undefined,
    listGroupMembers: async () => {
      throw new Error("ps unavailable");
    },
  };
  const tree = manager({ inspector: ambiguous });
  const pidFile = nextPidFile("ambiguous");
  const managed = spawnLeader(tree, pidFile, { children: 0 });
  const outcome = await managed.cleanup("timeout");
  const record = outcome.record;
  assert.equal(outcome.treeOk, false);
  assert.equal(record.cleanupState, "failed");
  assert.equal(isWorkerProcessCleanupFailure(record), true);
  assert.ok(record.detail);
  assert.match(record.detail ?? "", /inspect|process group/i);
  // The exact direct child is still signalled so the adapter cannot hang.
  assert.ok(record.signals.some((signal) => signal.scope === "pid"));
  const failure = createProcessTreeCleanupFailure(record);
  assert.equal(failure.stage, "worker");
  assert.equal(failure.code, "process_tree_cleanup_failed");
  await waitFor(() => !inspector.isAlive(record.pid), "direct child death");
  // Parseable and explicit: a reader sees the failure state, never a guess.
  assert.deepEqual(parseWorkerProcessRecord(record), record);
});

posixTest(
  "refuses to signal a group that matches cliyard's own group",
  async () => {
    let leaderPid: number | undefined;
    const ownGroupInspector: WorkerProcessTreeInspector = {
      get host() {
        return inspector.host;
      },
      get supported() {
        return inspector.supported;
      },
      isAlive: (pid) => inspector.isAlive(pid),
      capture: async (pid) => {
        // Worker identity is unavailable (reservation path), and cliyard's own
        // group appears to be the managed group: the guard must refuse.
        if (pid === leaderPid && pid !== process.pid) return undefined;
        if (pid !== process.pid) return undefined;
        return { pid: process.pid, pgid: leaderPid!, startedAt: "fixture" };
      },
      listGroupMembers: (pgid) => inspector.listGroupMembers(pgid),
    };
    const tree = manager({ inspector: ownGroupInspector });
    const pidFile = nextPidFile("own-group");
    const managed = spawnLeader(tree, pidFile, { children: 1 });
    leaderPid = managed.pid;
    const [helperPid] = await readHelperPids(pidFile);
    const outcome = await managed.cleanup("cancel");
    const record = outcome.record;
    try {
      assert.equal(outcome.treeOk, false);
      assert.equal(record.cleanupState, "failed");
      assert.match(record.detail ?? "", /cliyard's own process group/);
      assert.ok(record.signals.every((signal) => signal.scope === "pid"));
      // No group signal was sent: the helper in the group is still alive.
      assert.equal(inspector.isAlive(helperPid), true);
    } finally {
      if (inspector.isAlive(helperPid)) {
        process.kill(helperPid, "SIGKILL");
      }
    }
  },
);

// ---------------------------------------------------------------------------
// Windows limitation (documented, never claimed as group ownership)
// ---------------------------------------------------------------------------

test(
  "win32 mode records the exact-child limitation and never claims a group",
  async () => {
    const tree = manager({ platform: "win32" });
    const pidFile = nextPidFile("windows");
    const managed = spawnLeader(tree, pidFile, { children: 1 });
    const helperPids = await readHelperPids(pidFile);
    const outcome = await managed.cleanup("cancel");
    const record = outcome.record;
    try {
      assert.equal(record.captureSupport, "windows-exact-child");
      assert.equal(record.captureSource, "unsupported");
      assert.equal(record.cleanupState, "unsupported");
      assert.equal(record.pgid, undefined);
      assert.equal(record.residualCount, 0);
      assert.ok(record.signals.every((signal) => signal.scope === "pid"));
      assert.match(record.detail ?? "", /win32|POSIX/i);
      // The helper is intentionally outside the claimed cleanup scope.
      assert.equal(
        helperPids.some((pid) => inspector.isAlive(pid)),
        true,
      );
    } finally {
      for (const pid of helperPids) {
        if (inspector.isAlive(pid)) {
          try {
            process.kill(pid, "SIGKILL");
          } catch {
            // Already gone.
          }
        }
      }
    }
  },
);

// ---------------------------------------------------------------------------
// Adapter integration
// ---------------------------------------------------------------------------

function initRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), "cliyard-worker-tree-repo-"));
  spawnSync("git", ["init"], { cwd: repo, stdio: "ignore" });
  spawnSync("git", ["config", "user.email", "t@t.com"], {
    cwd: repo,
    stdio: "ignore",
  });
  spawnSync("git", ["config", "user.name", "t"], {
    cwd: repo,
    stdio: "ignore",
  });
  writeFileSync(join(repo, "allowed.ts"), "export const value = 1;\n");
  spawnSync("git", ["add", "."], { cwd: repo, stdio: "ignore" });
  spawnSync("git", ["commit", "-m", "init"], { cwd: repo, stdio: "ignore" });
  return repo;
}

function contractFor(repo: string): TaskContract {
  const baseCommit = spawnSync("git", ["rev-parse", "HEAD"], {
    cwd: repo,
    encoding: "utf8",
  }).stdout.trim();
  return {
    taskId: "worker-process-tree",
    version: 1,
    frozen: true,
    goals: ["Prove tree cleanup"],
    dependsOn: [],
    readPaths: ["."],
    writePaths: ["allowed.ts"],
    sharedResources: [],
    baseCommit,
    verifyCommands: ["true"],
    maxRepairs: 0,
  };
}

posixTest(
  "both adapters clean helper descendants left after a normal worker exit",
  async () => {
    const repo = initRepo();
    try {
      const contract = contractFor(repo);
      for (const kind of ["claude", "codex"] as const) {
        const pidFile = nextPidFile(`adapter-${kind}`);
        const binary = join(root, `fake-${kind}`);
        writeFileSync(
          binary,
          `#!/bin/sh
"${process.execPath}" -e 'setInterval(() => {}, 1000)' &
echo "[$!]" > "${pidFile}"
exit 0
`,
        );
        chmodSync(binary, 0o755);
        const worker =
          kind === "claude"
            ? createClaudeAdapter({ binary, cwd: repo, model: "fixture" })
            : createCodexAdapter({ binary, cwd: repo, model: "fixture" });
        const { sessionId } = await worker.start({ contract, attempt: 0 });
        const result = await worker.collect(sessionId);
        assert.equal(result.exitCode, 0, `${kind} worker should succeed`);
        assert.equal(result.processTrees?.length, 1);
        const tree = result.processTrees![0]!;
        assert.equal(tree.cleanupReason, "child-close");
        assert.equal(tree.cleanupState, "terminated");
        assert.ok(tree.residualCount >= 1);
        const [helperPid] = await readHelperPids(pidFile);
        await waitFor(
          () => !inspector.isAlive(helperPid),
          `${kind} helper death`,
        );
        await worker.cancel(sessionId);
      }
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  },
);

// ---------------------------------------------------------------------------
// RunManifest persistence
// ---------------------------------------------------------------------------

const sampleIdentity = {
  pid: 12_345,
  pgid: 12_345,
  startedAt: "Mon Jan  1 00:00:00 2024",
};

function sampleRecord(): WorkerProcessRecord {
  return {
    version: 1,
    host: "test-host",
    pid: 12_345,
    pgid: 12_345,
    identity: { ...sampleIdentity },
    captureSource: "ps-exact",
    captureSupport: "posix-process-group",
    cleanupReason: "timeout",
    cleanupState: "terminated",
    signals: [
      {
        signal: "SIGTERM",
        scope: "process-group",
        at: "2026-01-01T00:00:01.000Z",
        result: "sent",
      },
    ],
    residualMembers: [
      { pid: 12_346, pgid: 12_345, startedAt: "Mon Jan  1 00:00:02 2024" },
    ],
    residualCount: 1,
    exitCode: 124,
    startedAt: "2026-01-01T00:00:00.000Z",
    closedAt: "2026-01-01T00:00:02.000Z",
    cleanedAt: "2026-01-01T00:00:03.000Z",
    detail: "bounded cleanup detail",
  };
}

function writeContracts(repo: string): string {
  const path = join(repo, "contracts.json");
  writeFileSync(
    path,
    JSON.stringify(
      {
        taskId: "task-a",
        version: 1,
        frozen: true,
        goals: ["prove process-tree persistence"],
        dependsOn: [],
        readPaths: [],
        writePaths: ["src/agents/process-tree.ts"],
        sharedResources: [],
        baseCommit: "a".repeat(40),
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

test("manifest round-trips process-tree evidence and rejects malformed records", () => {
  const repo = mkdtempSync(join(tmpdir(), "cliyard-worker-tree-manifest-"));
  try {
    const contractsPath = writeContracts(repo);
    const record = sampleRecord();
    const cleanupFailure = createProcessTreeCleanupFailure(record);
    const task: RunTaskState = {
      taskId: "task-a",
      status: "rejected",
      accepted: false,
      processTrees: [record],
      cleanupFailure,
    };
    const manifest = createRunManifest(repo, {
      planId: "plan-a",
      contractsPath,
      baseCommit: "a".repeat(40),
      integrationBranch: "cliyard/integration",
      tasks: [task],
      activate: false,
    });
    saveRunManifest(manifest);
    const loaded = loadRunManifest(repo, manifest.runId);
    assert.deepEqual(loaded.tasks["task-a"]?.processTrees, [record]);
    assert.deepEqual(
      loaded.tasks["task-a"]?.cleanupFailure,
      cleanupFailure,
    );

    // Malformed evidence is fail-closed at load time, never silently dropped.
    const path = runManifestPath(repo, manifest.runId);
    const raw = JSON.parse(readFileSync(path, "utf8")) as RunManifest;
    const malformed = [
      { ...record, cleanupState: "running" },
      {
        ...record,
        residualMembers: Array.from(
          { length: MAX_PROCESS_TREE_MEMBERS + 1 },
          (_, index) => ({
            pid: 20_000 + index,
            pgid: 12_345,
            startedAt: "Mon Jan  1 00:00:02 2024",
          }),
        ),
        residualCount: MAX_PROCESS_TREE_MEMBERS + 1,
      },
      { ...record, cleanupReason: "made-up" },
      { ...record, signals: [{ signal: "SIGTERM" }] },
    ];
    for (const bad of malformed) {
      const corrupted = structuredClone(raw);
      corrupted.tasks["task-a"] = {
        ...corrupted.tasks["task-a"]!,
        processTrees: [bad as unknown as WorkerProcessRecord],
      };
      writeFileSync(path, JSON.stringify(corrupted), "utf8");
      assert.throws(
        () => loadRunManifest(repo, manifest.runId),
        /process-tree record/,
      );
    }
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Closed-loop aggregation
// ---------------------------------------------------------------------------

function fakeSuccessWorker(result: AgentResult): AgentAdapter {
  return {
    id: "mock",
    async discover() {
      return { id: "mock", ok: true, supportsModelFlag: false, notes: [] };
    },
    async start(_input: AgentStartInput) {
      return { sessionId: "tree-loop" };
    },
    async collect() {
      return result;
    },
    async cancel() {},
  };
}

const passingVerifier: Verifier = {
  async run(): Promise<VerifyResult> {
    return {
      ok: true,
      exitCode: 0,
      commandResults: [],
      logTail: "verifier would accept",
    };
  },
};

async function runLoopWith(
  repo: string,
  result: AgentResult,
  label: string,
) {
  return runClosedLoop({
    contract: contractFor(repo),
    worker: fakeSuccessWorker(result),
    verifier: passingVerifier,
    ledgerPath: join(repo, `.cliyard/${label}.json`),
  });
}

test("closed loop rejects worker success when tree cleanup failed", async () => {
  const repo = initRepo();
  try {
    const failedRecord: WorkerProcessRecord = {
      ...sampleRecord(),
      cleanupState: "failed",
      detail: "cannot inspect the managed process group",
    };
    const loop = await runLoopWith(
      repo,
      {
        sessionId: "tree-loop",
        exitCode: 0,
        touchedPaths: ["allowed.ts"],
        logTail: "worker succeeded",
        processTrees: [failedRecord],
      },
      "failed-cleanup",
    );
    assert.equal(loop.verdict, "rejected");
    assert.match(loop.reason, /process-tree cleanup failed/);
    assert.equal(loop.cleanupFailure?.code, "process_tree_cleanup_failed");
    assert.equal(loop.failure?.code, "process_tree_cleanup_failed");
    assert.equal(loop.processTrees.length, 1);
    assert.equal(loop.processTrees[0]?.cleanupState, "failed");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("closed loop rejects malformed process-tree records", async () => {
  const repo = initRepo();
  try {
    const loop = await runLoopWith(
      repo,
      {
        sessionId: "tree-loop",
        exitCode: 0,
        touchedPaths: ["allowed.ts"],
        logTail: "worker succeeded",
        processTrees: [
          { not: "a record" } as unknown as WorkerProcessRecord,
        ],
      },
      "invalid-cleanup",
    );
    assert.equal(loop.verdict, "rejected");
    assert.equal(loop.cleanupFailure?.code, "process_tree_record_invalid");
    assert.equal(loop.processTrees.length, 0);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

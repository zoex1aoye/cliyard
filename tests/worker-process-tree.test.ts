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
import { EventEmitter, once } from "node:events";
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
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import {
  compareProcessIdentity,
  isProcessPid,
  ProcessInspector,
  type ProcessTableEntry,
} from "../src/runtime/process.js";
import type { RuntimeProcessIdentity } from "../src/runtime/types.js";
import {
  createProcessTreeCleanupFailure,
  isWorkerProcessCleanupFailure,
  MAX_PERSISTED_EXTERNAL_DESCENDANTS,
  MAX_PROCESS_TREE_MEMBERS,
  MAX_PROCESS_TREE_SIGNALS,
  MAX_SAMPLED_DESCENDANTS,
  parseWorkerProcessRecord,
  WorkerProcessTreeManager,
  type WorkerNestedProcesses,
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
const detachHelper = process.argv[7] === "detach";
const staggerMs = Number(process.argv[8] ?? "0");
const largeGroup = process.argv[9] === "large-group";

if (ignoreTerm) process.on("SIGTERM", () => {});
const pids = [];
const spawnChild = (index) => {
  const child = spawn(
    process.execPath,
    [
      ${JSON.stringify(helperFixture)},
      largeGroup && index === 0 ? "large-group" : childIgnoreTerm ? "ignore" : "term",
    ],
    { stdio: "ignore", detached: detachHelper },
  );
  pids.push(child.pid);
  writeFileSync(pidFile, JSON.stringify(pids));
};
if (staggerMs > 0 && childCount > 1) {
  spawnChild(0);
  for (let index = 1; index < childCount; index += 1) {
    setTimeout(() => spawnChild(index), staggerMs * index);
  }
} else {
  for (let index = 0; index < childCount; index += 1) spawnChild(index);
}
setTimeout(() => process.exit(0), holdMs);
`,
  "utf8",
);

writeFileSync(
  helperFixture,
  `import { spawn } from "node:child_process";
if (process.argv[2] === "ignore") process.on("SIGTERM", () => {});
// A detached nested group with 512 lightweight members. Every member inherits
// the helper's dedicated process group, so cleanup must treat it as one unit.
if (process.argv[2] === "large-group") {
  for (let index = 0; index < 512; index += 1) {
    spawn("/bin/sleep", ["600"], { stdio: "ignore" });
  }
}
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

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

let fakePsSeq = 0;
/** A finite fake `ps` that emits fixed stdout (args are ignored). */
function fakePsScript(output: string): string {
  fakePsSeq += 1;
  const path = join(root, `fake-ps-${fakePsSeq}.sh`);
  writeFileSync(path, `#!/bin/sh\ncat <<'CLIYARD_PS_EOF'\n${output}CLIYARD_PS_EOF\n`, "utf8");
  chmodSync(path, 0o755);
  return path;
}

/**
 * Exact fixture identities this test file created, so a failed assertion can
 * never leave a fixture tree behind. The real GroupCleanup path proves normal
 * cleanup; this net only handles test failure and process-exit paths.
 */
const liveFixtures = new Map<number, RuntimeProcessIdentity>();

function trackFixture(identity: RuntimeProcessIdentity | undefined): void {
  if (
    identity &&
    isProcessPid(identity.pid) &&
    identity.pid > 1 &&
    identity.pid !== process.pid
  ) {
    liveFixtures.set(identity.pid, { ...identity });
  }
}

/**
 * Synchronously re-read every tracked identity and SIGKILL only an exact
 * `(pid, pgid, lstart)` match. A reused pid is never signalled, even by this
 * test-only failure net.
 */
function forceKillFixtures(): void {
  if (liveFixtures.size === 0) return;
  if (process.platform !== "darwin" && process.platform !== "linux") {
    liveFixtures.clear();
    return;
  }
  const pids = [...liveFixtures.keys()];
  const result = spawnSync(
    "ps",
    [
      "-p",
      pids.join(","),
      "-o",
      "pid=",
      "-o",
      "pgid=",
      "-o",
      "lstart=",
    ],
    { encoding: "utf8", timeout: 2_000 },
  );
  for (const row of (result.stdout ?? "").split(/\r?\n/)) {
    if (row.trim() === "") continue;
    const match = /^\s*(\d+)\s+(\d+)\s+(.+?)\s*$/.exec(row);
    if (!match) continue;
    const observed: RuntimeProcessIdentity = {
      pid: Number(match[1]),
      pgid: Number(match[2]),
      startedAt: match[3]!.trim().replace(/\s+/g, " "),
    };
    const expected = liveFixtures.get(observed.pid);
    if (!expected || compareProcessIdentity(expected, observed) !== "match") {
      continue;
    }
    try {
      process.kill(observed.pid, "SIGKILL");
    } catch {
      // Already gone.
    }
  }
  liveFixtures.clear();
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
  const pids = parsed.map((pid) => Number(pid));
  for (const pid of pids) {
    if (Number.isInteger(pid) && pid > 1 && pid !== process.pid) {
      trackFixture(await inspector.capture(pid));
    }
  }
  return pids;
}

function spawnLeader(
  tree: WorkerProcessTreeManager,
  pidFile: string,
  options: {
    children?: number;
    holdMs?: number;
    ignoreTerm?: boolean;
    childIgnoreTerm?: boolean;
    detachHelper?: boolean;
    staggerMs?: number;
    largeGroup?: boolean;
  } = {},
) {
  const managed = tree.spawn(
    process.execPath,
    [
      fixturePath,
      pidFile,
      String(options.children ?? 1),
      String(options.holdMs ?? 60_000),
      options.ignoreTerm ? "ignore" : "term",
      options.childIgnoreTerm ? "ignore" : "term",
      options.detachHelper ? "detach" : "same-group",
      String(options.staggerMs ?? 0),
      options.largeGroup ? "large-group" : "regular",
    ],
    { stdio: ["ignore", "ignore", "ignore"] },
  );
  void managed.captureIdentity().then((capture) => {
    trackFixture(capture.identity);
  });
  return managed;
}

function cleanupFixtures(): void {
  forceKillFixtures();
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
  // Same-group descendants stay on the existing group-only path.
  assert.equal(
    record.signals.some((signal) => signal.scope === "descendant-pid"),
    false,
  );
  assert.equal(record.nestedCleanup, undefined);
  assert.equal(record.observedExternalDescendants, undefined);
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
// Nested process groups that left the managed group (worker-process-tree-v1.1)
// ---------------------------------------------------------------------------

posixTest(
  "takes a bounded process-table snapshot with ppid links for a live tree",
  async () => {
    const tree = manager();
    const pidFile = nextPidFile("snapshot");
    const managed = spawnLeader(tree, pidFile, { children: 1 });
    try {
      const [helperPid] = await readHelperPids(pidFile);
      const table = await inspector.snapshotProcessTable();
      const pids = table.map((entry) => entry.pid);
      assert.deepEqual(pids, [...pids].sort((a, b) => a - b));
      const leader = table.find((entry) => entry.pid === managed.pid);
      const helper = table.find((entry) => entry.pid === helperPid);
      assert.ok(leader);
      assert.ok(helper);
      assert.equal(helper.ppid, managed.pid);
      assert.equal(helper.pgid, managed.pid);
      assert.ok(leader.startedAt.length > 0);
    } finally {
      await managed.cleanup("cancel");
    }
  },
);

for (const reason of ["timeout", "cancel"] as const) {
  posixTest(
    `${reason} cleanup kills a descendant that created its own process group`,
    async () => {
      const tree = manager();
      const pidFile = nextPidFile(`nested-${reason}`);
      const managed = spawnLeader(tree, pidFile, {
        children: 1,
        detachHelper: true,
      });
      const [helperPid] = await readHelperPids(pidFile);
      const helperIdentity = await inspector.capture(helperPid);
      assert.ok(helperIdentity);
      assert.equal(helperIdentity.pgid, helperPid);
      assert.notEqual(helperIdentity.pgid, managed.pid);
      try {
        const outcome = await managed.cleanup(reason);
        const record = outcome.record;
        assert.equal(outcome.treeOk, true);
        assert.equal(record.cleanupReason, reason);
        assert.equal(record.cleanupState, "terminated");
        assert.equal(record.nestedCleanup?.state, "terminated");
        assert.ok((record.nestedCleanup?.observedGroups ?? 0) >= 1);
        assert.ok((record.nestedCleanup?.signalledGroups ?? 0) >= 1);
        assert.equal(record.nestedCleanup?.residualGroups, 0);
        assert.equal(record.nestedCleanup?.residualDescendants, 0);
        assert.equal(
          (record.observedExternalDescendants ?? []).some(
            (identity) => identity.pid === helperPid,
          ),
          false,
          "members of a proven group are not duplicated as fallback pids",
        );
        assert.ok(record.observedExternalGroups?.includes(helperPid));
        assert.ok(
          record.signals.some(
            (signal) =>
              signal.scope === "nested-process-group" &&
              signal.pgid === helperPid,
          ),
        );
        // The top-level group and the exact nested group are both gone.
        assert.equal(inspector.isAlive(managed.pid), false);
        await waitFor(
          () => !inspector.isAlive(helperPid),
          `${reason} nested helper death`,
        );
      } finally {
        if (inspector.isAlive(helperPid)) {
          try {
            process.kill(helperPid, "SIGKILL");
          } catch {
            // Already gone.
          }
        }
      }
    },
  );
}

posixTest(
  "cleans a sampled nested descendant after the leader dies before cleanup",
  async () => {
    const tree = manager({ descendantPollMs: 250 });
    const pidFile = nextPidFile("nested-child-close");
    const managed = spawnLeader(tree, pidFile, {
      children: 1,
      detachHelper: true,
    });
    const [helperPid] = await readHelperPids(pidFile);
    try {
      // The leader is still alive here, so the low-frequency sampler must
      // observe the detached helper before the leader disappears. Two full
      // sampler periods leave room for ps scheduling.
      await delay(1_200);
      assert.equal(inspector.isAlive(helperPid), true);
      assert.ok(managed.pid);
      process.kill(managed.pid, "SIGKILL");

      const outcome = await managed.cleanup("child-close");
      const record = outcome.record;
      assert.equal(record.cleanupReason, "child-close");
      assert.equal(record.cleanupState, "terminated");
      assert.equal(record.nestedCleanup?.state, "terminated");
      assert.ok((record.nestedCleanup?.observedGroups ?? 0) >= 1);
      assert.ok((record.nestedCleanup?.signalledGroups ?? 0) >= 1);
      assert.ok(
        record.signals.some(
          (signal) =>
            signal.scope === "nested-process-group" &&
            signal.pgid === helperPid,
        ),
      );
      await waitFor(
        () => !inspector.isAlive(helperPid),
        "sampled nested helper death",
      );
    } finally {
      if (inspector.isAlive(helperPid)) {
        try {
          process.kill(helperPid, "SIGKILL");
        } catch {
          // Already gone.
        }
      }
    }
  },
);

posixTest(
  "cleans a 512-member detached nested group as one bounded unit",
  async () => {
    const tree = manager({ descendantPollMs: 250 });
    const pidFile = nextPidFile("nested-group-512");
    const managed = spawnLeader(tree, pidFile, {
      children: 1,
      detachHelper: true,
      largeGroup: true,
    });
    const [groupPid] = await readHelperPids(pidFile);
    const snapshots: WorkerNestedProcesses[] = [];
    const unsubscribe = managed.observeExternalDescendants!((snapshot) => {
      snapshots.push(snapshot);
    });
    try {
      // Sampling must report the whole owned group (leader plus >=512
      // members) without truncating at the old 256 related-process bound.
      await waitFor(
        () =>
          snapshots.some((snapshot) =>
            snapshot.groups?.some(
              (group) =>
                group.pgid === groupPid && group.observedMemberCount >= 513,
            ),
          ),
        "512-member nested group observation",
        15_000,
      );
      const observed = snapshots.find((snapshot) =>
        snapshot.groups?.some(
          (group) => group.pgid === groupPid && group.observedMemberCount >= 513,
        ),
      )!;
      assert.equal(observed.truncated, false);
      assert.equal(observed.identities.length, 0);
      const before = await inspector.listGroupMembers(groupPid);
      assert.ok(before.length >= 513);
      for (const member of before) trackFixture(member);

      const outcome = await managed.cleanup("timeout");
      assert.equal(outcome.treeOk, true);
      assert.equal(outcome.record.cleanupState, "terminated");
      assert.equal(outcome.record.nestedCleanup?.state, "terminated");
      assert.ok((outcome.record.nestedCleanup?.observedGroups ?? 0) >= 1);
      assert.ok((outcome.record.nestedCleanup?.signalledGroups ?? 0) >= 1);
      assert.equal(outcome.record.nestedCleanup?.residualGroups, 0);
      assert.equal(outcome.record.nestedCleanup?.observedDescendants, 0);
      assert.ok(outcome.record.observedExternalGroups?.includes(groupPid));
      assert.equal(outcome.record.observedExternalDescendants?.length ?? 0, 0);
      assert.ok(
        outcome.record.signals.some(
          (signal) =>
            signal.scope === "nested-process-group" &&
            signal.pgid === groupPid,
        ),
      );
      await waitFor(
        async () => (await inspector.listGroupMembers(groupPid)).length === 0,
        "512-member nested group death",
        15_000,
      );
      assert.equal(inspector.isAlive(groupPid), false);
      for (const member of before) liveFixtures.delete(member.pid);
    } finally {
      unsubscribe();
      if (inspector.isAlive(groupPid)) {
        try {
          process.kill(-groupPid, "SIGKILL");
        } catch {
          // Already gone.
        }
      }
    }
  },
);

posixTest(
  "cleans more than 16 external groups with a 512-member group and only truncates durable recovery",
  async () => {
    const tree = manager({
      termGraceMs: 1_000,
      killGraceMs: 2_000,
      descendantPollMs: 250,
    });
    const pidFile = nextPidFile("nested-groups-many");
    // 20 detached group leaders; the first owns 512 + 1 members. The live
    // group view must see all 20 even though the durable registry persists 16.
    const managed = spawnLeader(tree, pidFile, {
      children: 20,
      detachHelper: true,
      largeGroup: true,
    });
    await readHelperPids(pidFile);
    await waitFor(() => {
      try {
        return (JSON.parse(readFileSync(pidFile, "utf8")) as number[]).length === 20;
      } catch {
        return false;
      }
    }, "all 20 detached group leaders", 20_000);
    const groupPids = JSON.parse(readFileSync(pidFile, "utf8")) as number[];
    assert.equal(groupPids.length, 20);
    for (const pid of groupPids) trackFixture(await inspector.capture(pid));
    const snapshots: WorkerNestedProcesses[] = [];
    const unsubscribe = managed.observeExternalDescendants!((snapshot) => {
      snapshots.push(snapshot);
    });
    try {
      for (const pid of groupPids) {
        const captured = await inspector.capture(pid);
        assert.ok(captured);
        assert.equal(captured.pgid, pid, "every helper leads its own group");
      }
      await waitFor(
        () =>
          snapshots.some(
            (snapshot) =>
              snapshot.truncated && (snapshot.groups?.length ?? 0) === 16,
          ),
        "truncated 20-group registry observation",
        20_000,
      );
      const largePid = groupPids[0]!;
      const largeMembers = await inspector.listGroupMembers(largePid);
      assert.ok(largeMembers.length >= 513);
      for (const member of largeMembers) trackFixture(member);

      const outcome = await managed.cleanup("timeout");
      const record = outcome.record;
      // The live cleanup is complete even though the durable registry is
      // explicitly truncated for controller-death recovery.
      assert.equal(outcome.treeOk, true);
      assert.equal(record.cleanupState, "terminated");
      assert.equal(record.cleanupCompleteness, "complete");
      assert.equal(record.durableRecoveryCompleteness, "truncated");
      assert.equal(record.nestedCleanup?.state, "terminated");
      assert.ok((record.nestedCleanup?.observedGroups ?? 0) >= 20);
      assert.ok((record.nestedCleanup?.signalledGroups ?? 0) >= 20);
      assert.equal(record.nestedCleanup?.residualGroups, 0);
      assert.equal(record.nestedCleanup?.residualDescendants, 0);
      assert.equal(record.nestedCleanup?.cleanupCompleteness, "complete");
      assert.equal(
        record.nestedCleanup?.durableRecoveryCompleteness,
        "truncated",
      );
      // Only the persisted registry is bounded.
      assert.equal(record.observedExternalGroups?.length, 16);
      assert.deepEqual(parseWorkerProcessRecord(record), record);
      assert.ok(
        record.signals.some(
          (signal) =>
            signal.scope === "nested-process-group" &&
            signal.pgid === largePid,
        ),
      );
      for (const groupPid of groupPids) {
        await waitFor(
          async () =>
            (await inspector.listGroupMembers(groupPid)).length === 0,
          `external group ${groupPid} death`,
          20_000,
        );
        assert.equal(inspector.isAlive(groupPid), false);
      }
      for (const member of largeMembers) liveFixtures.delete(member.pid);
    } finally {
      unsubscribe();
      for (const groupPid of groupPids) {
        if (inspector.isAlive(groupPid)) {
          try {
            process.kill(-groupPid, "SIGKILL");
          } catch {
            // Already gone.
          }
        }
      }
    }
  },
);

posixTest(
  "cleans a nested group and an ungrouped fallback with distinct signal scopes",
  async () => {
    const foreign = spawn(
      process.execPath,
      ["-e", "setInterval(() => {}, 1000)"],
      { detached: true, stdio: "ignore", windowsHide: true },
    );
    await once(foreign, "spawn");
    const foreignPid = foreign.pid;
    assert.ok(foreignPid);
    const foreignIdentity = await inspector.capture(foreignPid);
    assert.ok(foreignIdentity);
    assert.equal(foreignIdentity.pgid, foreignPid);

    // Present the real foreign process as an external descendant whose pgid
    // has no observed leader row: exactly the ungrouped fallback shape. The
    // signal itself still targets the real exact pid.
    const forgedPgid = 8_888_881;
    let managedPid: number | undefined;
    const mixedInspector: WorkerProcessTreeInspector = {
      get host() {
        return inspector.host;
      },
      get supported() {
        return inspector.supported;
      },
      isAlive: (pid) => inspector.isAlive(pid),
      async capture(pid) {
        if (pid === foreignPid && inspector.isAlive(foreignPid)) {
          const real = await inspector.capture(foreignPid);
          return real ? { ...real, pgid: forgedPgid } : undefined;
        }
        return inspector.capture(pid);
      },
      listGroupMembers: (pgid) => inspector.listGroupMembers(pgid),
      async snapshotProcessTable(options) {
        const table = await inspector.snapshotProcessTable(options);
        if (
          managedPid === undefined ||
          !inspector.isAlive(foreignPid) ||
          !inspector.isAlive(managedPid)
        ) {
          return table;
        }
        const rows = table.filter((entry) => entry.pid !== foreignPid);
        rows.push({
          pid: foreignPid,
          ppid: managedPid,
          pgid: forgedPgid,
          startedAt: foreignIdentity.startedAt,
        });
        rows.sort((first, second) => first.pid - second.pid);
        return rows;
      },
    };

    const tree = manager({ inspector: mixedInspector });
    const pidFile = nextPidFile("nested-mixed");
    const managed = spawnLeader(tree, pidFile, {
      children: 1,
      detachHelper: true,
    });
    managedPid = managed.pid;
    const [groupPid] = await readHelperPids(pidFile);
    try {
      const outcome = await managed.cleanup("cancel");
      const record = outcome.record;
      assert.equal(outcome.treeOk, true);
      assert.equal(record.cleanupState, "terminated");
      assert.equal(record.nestedCleanup?.state, "terminated");
      assert.ok((record.nestedCleanup?.observedGroups ?? 0) >= 1);
      assert.ok((record.nestedCleanup?.signalledGroups ?? 0) >= 1);
      assert.ok((record.nestedCleanup?.observedDescendants ?? 0) >= 1);
      assert.ok((record.nestedCleanup?.signalledDescendants ?? 0) >= 1);
      assert.ok(
        record.signals.some(
          (signal) =>
            signal.scope === "nested-process-group" &&
            signal.pgid === groupPid,
        ),
      );
      assert.ok(
        record.signals.some(
          (signal) =>
            signal.scope === "descendant-pid" && signal.pid === foreignPid,
        ),
      );
      assert.ok(
        record.observedExternalDescendants?.some(
          (identity) =>
            identity.pid === foreignPid && identity.pgid === forgedPgid,
        ),
      );
      await waitFor(
        () => !inspector.isAlive(foreignPid),
        "ungrouped fallback death",
      );
      await waitFor(
        async () => (await inspector.listGroupMembers(groupPid)).length === 0,
        "mixed nested group death",
      );
    } finally {
      try {
        process.kill(-foreignPid, "SIGKILL");
      } catch {
        // Already gone.
      }
    }
  },
);

posixTest(
  "refuses a changed identity and never signals the unrelated live process",
  async () => {
    const unrelated = spawn(
      process.execPath,
      ["-e", "setInterval(() => {}, 1000)"],
      { detached: true, stdio: "ignore", windowsHide: true },
    );
    await once(unrelated, "spawn");
    const unrelatedPid = unrelated.pid;
    assert.ok(unrelatedPid);
    assert.equal(inspector.isAlive(unrelatedPid), true);

    const unrelatedIdentity = await inspector.capture(unrelatedPid);
    assert.ok(unrelatedIdentity);
    let managedPid: number | undefined;
    // The sampler records the fresh pid under a forged start identity. A later
    // table shows the pid reused as the same group leader with its real start
    // identity, so cleanup must detect a changed identity and refuse.
    const forgedStart = "Mon Jan  1 00:00:00 2001";
    let forgeMode: "forged" | "reused" = "forged";
    const forgedInspector: WorkerProcessTreeInspector = {
      get host() {
        return inspector.host;
      },
      get supported() {
        return inspector.supported;
      },
      isAlive: (pid) => inspector.isAlive(pid),
      capture: (pid) => inspector.capture(pid),
      listGroupMembers: (pgid) => inspector.listGroupMembers(pgid),
      async snapshotProcessTable(options) {
        const table = await inspector.snapshotProcessTable(options);
        if (managedPid === undefined) return table;
        const withoutUnrelated = table.filter(
          (entry) => entry.pid !== unrelatedPid,
        );
        withoutUnrelated.push({
          pid: unrelatedPid,
          ppid: managedPid,
          pgid: unrelatedPid,
          startedAt:
            forgeMode === "forged"
              ? forgedStart
              : unrelatedIdentity.startedAt,
        });
        withoutUnrelated.sort((first, second) => first.pid - second.pid);
        return withoutUnrelated;
      },
    };

    const tree = manager({ inspector: forgedInspector });
    const pidFile = nextPidFile("reused");
    const managed = spawnLeader(tree, pidFile, { children: 0 });
    managedPid = managed.pid;
    const observed: WorkerNestedProcesses[] = [];
    const unsubscribe = managed.observeExternalDescendants!((snapshot) => {
      observed.push(snapshot);
    });
    try {
      await waitFor(
        () =>
          observed.some((snapshot) =>
            snapshot.groups?.some((group) => group.pgid === unrelatedPid),
          ),
        "forged external group observation",
      );
      forgeMode = "reused";
      const outcome = await managed.cleanup("timeout");
      const record = outcome.record;
      // The persisted group's leader identity no longer matches: the group has
      // vanished and the unrelated process that reused the pid/pgid must never
      // be signalled or counted as a residual leak.
      assert.equal(outcome.treeOk, true);
      assert.equal(record.cleanupState, "terminated");
      assert.equal(record.cleanupCompleteness, "complete");
      assert.equal(record.nestedCleanup?.state, "clean");
      assert.equal(record.nestedCleanup?.vanishedGroups, 1);
      assert.equal(record.nestedCleanup?.residualGroups, 0);
      assert.equal(record.nestedCleanup?.residualDescendants, 0);
      assert.equal(record.nestedCleanup?.detail, undefined);
      assert.ok(record.observedExternalGroups?.includes(unrelatedPid));
      assert.equal(record.observedExternalDescendants?.length ?? 0, 0);
      assert.equal(
        record.signals.some(
          (signal) =>
            signal.scope === "nested-process-group" ||
            signal.scope === "descendant-pid",
        ),
        false,
      );
      assert.doesNotMatch(record.detail ?? "", /changed or was reused/);
      assert.deepEqual(parseWorkerProcessRecord(record), record);
      assert.equal(inspector.isAlive(unrelatedPid), true);
    } finally {
      unsubscribe();
      try {
        process.kill(-unrelatedPid, "SIGKILL");
      } catch {
        // Already gone.
      }
      try {
        unrelated.kill("SIGKILL");
      } catch {
        // Already gone.
      }
    }
  },
);

posixTest(
  "treats a reused leader pid as clean when the persisted group is gone",
  async () => {
    // A normal (non-detached) child preserves the reused leader PID in the
    // test runner's group. The forged observation records that pid as the old
    // group leader; the old group then disappears from fresh snapshots. A
    // persisted group with no remaining member must be treated as gone
    // without signalling the reused pid.
    const unrelated = spawn(
      process.execPath,
      ["-e", "setInterval(() => {}, 1000)"],
      { stdio: "ignore", windowsHide: true },
    );
    await once(unrelated, "spawn");
    const unrelatedPid = unrelated.pid;
    assert.ok(unrelatedPid);

    let managedPid: number | undefined;
    let forgeReused = true;
    const reusedInspector: WorkerProcessTreeInspector = {
      get host() {
        return inspector.host;
      },
      get supported() {
        return inspector.supported;
      },
      isAlive: (pid) => inspector.isAlive(pid),
      capture: (pid) => inspector.capture(pid),
      listGroupMembers: (pgid) => {
        if (pgid === unrelatedPid) return Promise.resolve([]);
        return inspector.listGroupMembers(pgid);
      },
      async snapshotProcessTable(options) {
        const table = await inspector.snapshotProcessTable(options);
        if (managedPid === undefined || !forgeReused) return table;
        const withoutUnrelated = table.filter(
          (entry) => entry.pid !== unrelatedPid,
        );
        withoutUnrelated.push({
          pid: unrelatedPid,
          ppid: managedPid,
          pgid: unrelatedPid,
          startedAt: "Mon Jan  1 00:00:00 2001",
        });
        withoutUnrelated.sort((first, second) => first.pid - second.pid);
        return withoutUnrelated;
      },
    };

    const tree = manager({ inspector: reusedInspector });
    const pidFile = nextPidFile("reused-gone");
    const managed = spawnLeader(tree, pidFile, { children: 0 });
    managedPid = managed.pid;
    const observed: WorkerNestedProcesses[] = [];
    const unsubscribe = managed.observeExternalDescendants!((snapshot) => {
      observed.push(snapshot);
    });
    try {
      await waitFor(
        () =>
          observed.some((snapshot) =>
            snapshot.groups?.some((group) => group.pgid === unrelatedPid),
          ),
        "reused external group observation",
      );
      forgeReused = false;
      const outcome = await managed.cleanup("timeout");
      const record = outcome.record;
      assert.equal(outcome.treeOk, true);
      assert.equal(record.cleanupState, "terminated");
      assert.equal(record.cleanupCompleteness, "complete");
      assert.equal(record.nestedCleanup?.state, "clean");
      assert.ok((record.nestedCleanup?.observedGroups ?? 0) >= 1);
      assert.equal(record.nestedCleanup?.signalledGroups, 0);
      assert.equal(record.nestedCleanup?.residualGroups, 0);
      assert.equal(record.residualCount, 0);
      assert.equal(inspector.isAlive(unrelatedPid), true);
    } finally {
      unsubscribe();
      try {
        unrelated.kill("SIGKILL");
      } catch {
        // Already gone.
      }
    }
  },
);

posixTest("process-table snapshots fail closed on malformed rows, duplicates and bounds", async () => {
  const valid =
    // Linux kernel threads legitimately report pgid 0.
    "   2   0   0 Wed Jan  3 00:00:00 2024\n" +
    "  10  0  10 Mon Jan  1 00:00:00 2024\n" +
    "  20  10 10 Tue Jan  2 00:00:00 2024\n" +
    // The pid-0 idle/kernel task is out of scope and skipped, never signalled.
    "   0   0   0 Thu Jan  4 00:00:00 2024\n";
  const parsed = await new ProcessInspector({
    psPath: fakePsScript(valid),
  }).snapshotProcessTable();
  assert.deepEqual(parsed, [
    { pid: 2, ppid: 0, pgid: 0, startedAt: "Wed Jan 3 00:00:00 2024" },
    { pid: 10, ppid: 0, pgid: 10, startedAt: "Mon Jan 1 00:00:00 2024" },
    { pid: 20, ppid: 10, pgid: 10, startedAt: "Tue Jan 2 00:00:00 2024" },
  ]);
  assert.deepEqual(
    await new ProcessInspector({
      psPath: fakePsScript(""),
    }).snapshotProcessTable(),
    [],
  );

  await assert.rejects(
    new ProcessInspector({
      psPath: fakePsScript("10 0 10\n"),
    }).snapshotProcessTable(),
    /cannot parse ps process table row/,
  );
  await assert.rejects(
    new ProcessInspector({
      psPath: fakePsScript(
        valid + "  10  0  10 Wed Jan  3 00:00:00 2024\n",
      ),
    }).snapshotProcessTable(),
    /duplicate pid 10/,
  );
  await assert.rejects(
    new ProcessInspector({
      psPath: fakePsScript(valid),
    }).snapshotProcessTable({ maxEntries: 1 }),
    /exceeds 1 rows/,
  );
  await assert.rejects(
    new ProcessInspector({
      psPath: fakePsScript(valid),
    }).snapshotProcessTable({ maxEntries: 0 }),
    /maxEntries must be a positive integer/,
  );
  await assert.rejects(
    new ProcessInspector({ platform: "win32" }).snapshotProcessTable(),
    /requires macOS or Linux/,
  );
});

posixTest(
  "fails closed and stays parseable when nested cleanup cannot complete",
  async () => {
    // The cleanup snapshot still observes the detached helper, but group
    // inspection fails before the nested plan can run. That ambiguity must
    // fail the result closed and still produce a record its own parser accepts.
    const failingGroupInspector: WorkerProcessTreeInspector = {
      get host() {
        return inspector.host;
      },
      get supported() {
        return inspector.supported;
      },
      isAlive: (pid) => inspector.isAlive(pid),
      capture: (pid) => inspector.capture(pid),
      listGroupMembers: async () => {
        throw new Error("group inspection unavailable");
      },
      snapshotProcessTable: (options) =>
        inspector.snapshotProcessTable(options),
    };
    const tree = manager({ inspector: failingGroupInspector });
    const pidFile = nextPidFile("nested-ambiguous");
    const managed = spawnLeader(tree, pidFile, {
      children: 1,
      detachHelper: true,
    });
    const [helperPid] = await readHelperPids(pidFile);
    try {
      const outcome = await managed.cleanup("timeout");
      const record = outcome.record;
      assert.equal(outcome.treeOk, false);
      assert.equal(record.cleanupState, "failed");
      assert.equal(record.nestedCleanup?.state, "failed");
      assert.ok((record.nestedCleanup?.observedGroups ?? 0) >= 1);
      assert.ok((record.nestedCleanup?.residualGroups ?? 0) >= 1);
      assert.ok(record.observedExternalGroups?.includes(helperPid));
      assert.match(record.detail ?? "", /cannot inspect the managed process group/);
      // No identity was revalidated and no nested signal was authorized.
      assert.equal(
        record.signals.some(
          (signal) =>
            signal.scope === "nested-process-group" ||
            signal.scope === "descendant-pid",
        ),
        false,
      );
      assert.deepEqual(parseWorkerProcessRecord(record), record);
    } finally {
      if (inspector.isAlive(helperPid)) {
        try {
          process.kill(helperPid, "SIGKILL");
        } catch {
          // Already gone.
        }
      }
    }
  },
);

posixTest(
  "incomplete current process-table inspection still fails closed",
  async () => {
    let failSnapshots = false;
    const flakySnapshotInspector: WorkerProcessTreeInspector = {
      get host() {
        return inspector.host;
      },
      get supported() {
        return inspector.supported;
      },
      isAlive: (pid) => inspector.isAlive(pid),
      capture: (pid) => inspector.capture(pid),
      listGroupMembers: (pgid) => inspector.listGroupMembers(pgid),
      async snapshotProcessTable(options) {
        if (failSnapshots) {
          throw new Error("ps became unavailable during cleanup");
        }
        return inspector.snapshotProcessTable(options);
      },
    };
    const tree = manager({
      inspector: flakySnapshotInspector,
      descendantPollMs: 250,
    });
    const pidFile = nextPidFile("live-incomplete");
    const managed = spawnLeader(tree, pidFile, {
      children: 1,
      detachHelper: true,
    });
    const [helperPid] = await readHelperPids(pidFile);
    const snapshots: WorkerNestedProcesses[] = [];
    const unsubscribe = managed.observeExternalDescendants!((snapshot) => {
      snapshots.push(snapshot);
    });
    try {
      await waitFor(
        () => snapshots.some((snapshot) => (snapshot.groups?.length ?? 0) >= 1),
        "nested group observation before cleanup",
      );
      failSnapshots = true;
      const outcome = await managed.cleanup("timeout");
      const record = outcome.record;
      // The live registry is known, but a current inspection failure still
      // fails the cleanup closed instead of claiming completeness.
      assert.equal(outcome.treeOk, false);
      assert.equal(record.cleanupState, "failed");
      assert.equal(record.cleanupCompleteness, "incomplete");
      assert.equal(record.nestedCleanup?.state, "failed");
      assert.equal(record.nestedCleanup?.cleanupCompleteness, "incomplete");
      assert.match(record.detail ?? "", /snapshot the worker process tree/);
      assert.equal(
        record.signals.some((signal) => signal.scope === "descendant-pid"),
        false,
      );
      assert.deepEqual(parseWorkerProcessRecord(record), record);
    } finally {
      unsubscribe();
      if (inspector.isAlive(helperPid)) {
        try {
          process.kill(-helperPid, "SIGKILL");
        } catch {
          // Already gone.
        }
      }
    }
  },
);

// ---------------------------------------------------------------------------
// Bounded process-table projection for high-fanout external groups
// ---------------------------------------------------------------------------

interface SyntheticExternalGroup {
  pgid: number;
  /** Members beyond the leader row. */
  members: number;
  startedAt: string;
}

/**
 * Deterministic process table for batched external-group cleanup. Groups are
 * synthetic pids; `withRecordedSignals` intercepts `process.kill`, so a test
 * observes every signal without touching a real process.
 */
class TableGroupInspector implements WorkerProcessTreeInspector {
  readonly host = "host-a";
  readonly supported = true;
  readonly leaderPid = 9_000_001;
  readonly leaderStartedAt = "Mon Jan  1 00:00:00 2024";
  readonly ownGroupId = 9_000_002;
  readonly groups: SyntheticExternalGroup[];
  /** Groups removed from the table when a signal is delivered. */
  readonly terminated = new Set<number>();
  /** Groups whose leader row disappears on signal while members stay. */
  readonly hideLeaderOnSignal = new Set<number>();
  /** Leader rows removed from the table while their members stay. */
  readonly hiddenLeaders = new Set<number>();
  /** Replacement start identity for a group leader row (pid reuse). */
  readonly reusedLeaderStartedAt = new Map<number, string>();
  snapshotCalls = 0;
  captureCalls: number[] = [];
  listCalls: number[] = [];
  snapshotProcessTable: WorkerProcessTreeInspector["snapshotProcessTable"] =
    async (): Promise<ProcessTableEntry[]> => {
      this.snapshotCalls += 1;
      return this.rows();
    };

  constructor(groups: SyntheticExternalGroup[]) {
    this.groups = groups;
  }

  isAlive(): boolean {
    return false;
  }

  async capture(
    pid: number | undefined,
  ): Promise<RuntimeProcessIdentity | undefined> {
    if (pid !== undefined) this.captureCalls.push(pid);
    if (pid === process.pid) {
      return {
        pid: process.pid,
        pgid: this.ownGroupId,
        startedAt: this.leaderStartedAt,
      };
    }
    const row = this.rows().find((entry) => entry.pid === pid);
    return row
      ? { pid: row.pid, pgid: row.pgid, startedAt: row.startedAt }
      : undefined;
  }

  async listGroupMembers(
    pgid: number | undefined,
  ): Promise<RuntimeProcessIdentity[]> {
    if (pgid === undefined) return [];
    this.listCalls.push(pgid);
    // The managed worker group is empty; only nested groups are listed.
    if (pgid === this.leaderPid) return [];
    return this.rows()
      .filter((entry) => entry.pgid === pgid)
      .map((entry) => ({ ...entry }));
  }

  /** Simulate the effect of a delivered group signal. */
  applySignal(pgid: number): void {
    if (this.hideLeaderOnSignal.has(pgid)) {
      this.hiddenLeaders.add(pgid);
    } else {
      this.terminated.add(pgid);
    }
  }

  private rows(): ProcessTableEntry[] {
    const rows: ProcessTableEntry[] = [
      {
        pid: this.leaderPid,
        ppid: 1,
        pgid: this.leaderPid,
        startedAt: this.leaderStartedAt,
      },
    ];
    for (const group of this.groups) {
      if (this.terminated.has(group.pgid)) continue;
      if (!this.hiddenLeaders.has(group.pgid)) {
        rows.push({
          pid: group.pgid,
          ppid: this.leaderPid,
          pgid: group.pgid,
          startedAt:
            this.reusedLeaderStartedAt.get(group.pgid) ?? group.startedAt,
        });
      }
      for (let index = 0; index < group.members; index += 1) {
        rows.push({
          pid: group.pgid + 1 + index,
          ppid: group.pgid,
          pgid: group.pgid,
          startedAt: group.startedAt,
        });
      }
    }
    rows.sort((first, second) => first.pid - second.pid);
    return rows;
  }
}

/**
 * Run `body` with `process.kill` intercepted. Negative-pgid signals are
 * recorded and applied to the synthetic table; no OS signal is delivered.
 */
async function withRecordedSignals(
  fake: TableGroupInspector,
  body: () => Promise<void>,
): Promise<Array<{ pid: number; signal: string }>> {
  const originalKill = process.kill;
  const signals: Array<{ pid: number; signal: string }> = [];
  process.kill = ((pid: number, signal?: NodeJS.Signals | number) => {
    if (signal === undefined || signal === 0) {
      return originalKill(pid, signal);
    }
    signals.push({ pid, signal: String(signal) });
    if (pid < 0) fake.applySignal(-pid);
    return true;
  }) as typeof process.kill;
  try {
    await body();
  } finally {
    process.kill = originalKill;
  }
  return signals;
}

function fakeManagedChild(pid: number): ChildProcess {
  return Object.assign(new EventEmitter(), {
    pid,
    exitCode: null,
    signalCode: null,
    kill() {
      return true;
    },
  }) as unknown as ChildProcess;
}

const syntheticStartedAt = "Mon Jan  1 00:00:00 2024";

test(
  "high-fanout cleanup projects every external group from bounded snapshots",
  async () => {
    const groupCount = 40;
    const groups: SyntheticExternalGroup[] = Array.from(
      { length: groupCount },
      (_, index) => ({
        pgid: 9_100_000 + index * 10,
        members: 3,
        startedAt: syntheticStartedAt,
      }),
    );
    const expectedPgids = groups.map((group) => group.pgid).sort((a, b) => a - b);
    const fake = new TableGroupInspector(groups);
    const tree = manager({
      platform: "linux",
      inspector: fake,
      termGraceMs: 200,
      killGraceMs: 200,
      pollMs: 5,
      descendantPollMs: 250,
    });
    const managed = tree.manage(fakeManagedChild(fake.leaderPid));
    const snapshots: WorkerNestedProcesses[] = [];
    const unsubscribe = managed.observeExternalDescendants!((snapshot) => {
      snapshots.push(snapshot);
    });
    try {
      await waitFor(
        () =>
          snapshots.some(
            (snapshot) =>
              snapshot.truncated && (snapshot.groups?.length ?? 0) === 16,
          ),
        "truncated 40-group observation",
      );
      let record: WorkerProcessRecord | undefined;
      let treeOk = false;
      const signals = await withRecordedSignals(fake, async () => {
        const outcome = await managed.cleanup("timeout");
        record = outcome.record;
        treeOk = outcome.treeOk;
      });
      assert.ok(record);
      assert.equal(treeOk, true);
      assert.equal(record.cleanupState, "terminated");
      assert.equal(record.cleanupCompleteness, "complete");
      assert.equal(record.durableRecoveryCompleteness, "truncated");
      assert.equal(record.nestedCleanup?.state, "terminated");
      assert.equal(record.nestedCleanup?.observedGroups, groupCount);
      assert.equal(record.nestedCleanup?.signalledGroups, groupCount);
      assert.equal(record.nestedCleanup?.residualGroups, 0);
      assert.equal(record.nestedCleanup?.residualDescendants, 0);
      assert.equal(record.observedExternalGroups?.length, 16);
      assert.deepEqual(parseWorkerProcessRecord(record), record);

      // Grouped cleanup never launches one membership listing per group and
      // never re-captures a group leader: the managed group is listed once and
      // all external work comes from bounded table snapshots.
      assert.deepEqual(fake.listCalls, [fake.leaderPid]);
      assert.equal(
        fake.captureCalls.some((pid) => expectedPgids.includes(pid)),
        false,
        "no per-group leader capture",
      );
      // Sampling ticks plus initial/wait phases stay a small constant even
      // with 40 external groups.
      assert.ok(fake.snapshotCalls <= 8, `snapshots=${fake.snapshotCalls}`);
      assert.ok(fake.snapshotCalls >= 3);

      // Only exact negative-pgid group signals were sent: no positive-pid and
      // no SIGKILL/broad target was used.
      assert.deepEqual(
        signals.map((entry) => entry.signal),
        Array.from({ length: groupCount }, () => "SIGTERM"),
      );
      assert.deepEqual(
        signals.map((entry) => -entry.pid).sort((a, b) => a - b),
        expectedPgids,
      );
      assert.ok(signals.every((entry) => entry.pid < 0));
      assert.ok(
        record.signals.every(
          (signal) =>
            signal.scope === "nested-process-group" &&
            signal.result === "sent" &&
            expectedPgids.includes(signal.pgid as number),
        ),
      );
    } finally {
      unsubscribe();
    }
  },
);

test(
  "fails closed when a group leader disappears before batched cleanup",
  async () => {
    const cleanGroup: SyntheticExternalGroup = {
      pgid: 9_100_010,
      members: 2,
      startedAt: syntheticStartedAt,
    };
    const vanishedGroup: SyntheticExternalGroup = {
      pgid: 9_100_000,
      members: 2,
      startedAt: syntheticStartedAt,
    };
    const fake = new TableGroupInspector([vanishedGroup, cleanGroup]);
    const tree = manager({
      platform: "linux",
      inspector: fake,
      termGraceMs: 100,
      killGraceMs: 100,
      pollMs: 5,
    });
    const managed = tree.manage(fakeManagedChild(fake.leaderPid));
    const snapshots: WorkerNestedProcesses[] = [];
    const unsubscribe = managed.observeExternalDescendants!((snapshot) => {
      snapshots.push(snapshot);
    });
    try {
      await waitFor(
        () => snapshots.some((snapshot) => (snapshot.groups?.length ?? 0) === 2),
        "two-group observation",
      );
      // The leader row disappears while its members remain: the group still
      // has processes but no exact identity may authorize a group signal.
      fake.hiddenLeaders.add(vanishedGroup.pgid);
      let record: WorkerProcessRecord | undefined;
      const signals = await withRecordedSignals(fake, async () => {
        record = (await managed.cleanup("timeout")).record;
      });
      assert.ok(record);
      assert.equal(record.cleanupState, "failed");
      assert.equal(record.nestedCleanup?.state, "failed");
      assert.equal(record.nestedCleanup?.observedGroups, 2);
      assert.equal(record.nestedCleanup?.signalledGroups, 1);
      assert.equal(record.nestedCleanup?.residualGroups, 1);
      assert.match(record.detail ?? "", /leader is absent while 2 member/);
      assert.deepEqual(parseWorkerProcessRecord(record), record);
      // The intact group was cleaned; the leaderless group was never signalled.
      assert.deepEqual(
        signals.map((entry) => ({ pid: entry.pid, signal: entry.signal })),
        [{ pid: -cleanGroup.pgid, signal: "SIGTERM" }],
      );
      assert.equal(
        record.signals.some(
          (signal) =>
            signal.scope === "nested-process-group" &&
            signal.pgid === vanishedGroup.pgid,
        ),
        false,
      );
      assert.deepEqual(fake.listCalls, [fake.leaderPid]);
    } finally {
      unsubscribe();
    }
  },
);

test(
  "refuses SIGKILL when a leader disappears between SIGTERM and escalation",
  async () => {
    const group: SyntheticExternalGroup = {
      pgid: 9_100_000,
      members: 2,
      startedAt: syntheticStartedAt,
    };
    const fake = new TableGroupInspector([group]);
    fake.hideLeaderOnSignal.add(group.pgid);
    const tree = manager({
      platform: "linux",
      inspector: fake,
      termGraceMs: 80,
      killGraceMs: 100,
      pollMs: 5,
    });
    const managed = tree.manage(fakeManagedChild(fake.leaderPid));
    const snapshots: WorkerNestedProcesses[] = [];
    const unsubscribe = managed.observeExternalDescendants!((snapshot) => {
      snapshots.push(snapshot);
    });
    try {
      await waitFor(
        () => snapshots.some((snapshot) => (snapshot.groups?.length ?? 0) === 1),
        "one-group observation",
      );
      let record: WorkerProcessRecord | undefined;
      const signals = await withRecordedSignals(fake, async () => {
        record = (await managed.cleanup("timeout")).record;
      });
      assert.ok(record);
      assert.equal(record.cleanupState, "failed");
      assert.equal(record.nestedCleanup?.state, "failed");
      assert.equal(record.nestedCleanup?.signalledGroups, 1);
      assert.equal(record.nestedCleanup?.residualGroups, 1);
      assert.match(record.detail ?? "", /refusing SIGKILL/);
      assert.deepEqual(parseWorkerProcessRecord(record), record);
      // The leader disappeared while its members survived: TERM was already
      // delivered, but no identity may authorize escalation.
      assert.deepEqual(
        signals.map((entry) => ({ pid: entry.pid, signal: entry.signal })),
        [{ pid: -group.pgid, signal: "SIGTERM" }],
      );
      assert.equal(fake.hiddenLeaders.has(group.pgid), true);
      assert.deepEqual(fake.listCalls, [fake.leaderPid]);
    } finally {
      unsubscribe();
    }
  },
);

test(
  "classifies a reused leader identity as vanished evidence without a signal",
  async () => {
    const group: SyntheticExternalGroup = {
      pgid: 9_100_000,
      members: 2,
      startedAt: syntheticStartedAt,
    };
    const fake = new TableGroupInspector([group]);
    const tree = manager({
      platform: "linux",
      inspector: fake,
      termGraceMs: 100,
      killGraceMs: 100,
      pollMs: 5,
    });
    const managed = tree.manage(fakeManagedChild(fake.leaderPid));
    const snapshots: WorkerNestedProcesses[] = [];
    const unsubscribe = managed.observeExternalDescendants!((snapshot) => {
      snapshots.push(snapshot);
    });
    try {
      await waitFor(
        () => snapshots.some((snapshot) => (snapshot.groups?.length ?? 0) === 1),
        "one-group observation before pid reuse",
      );
      // The original members exit and the leader pid is reused by an unrelated
      // process. A row with the group id still exists, but its exact leader
      // identity changed and no sampled worker descendant remains.
      fake.reusedLeaderStartedAt.set(group.pgid, "Tue Feb  2 00:00:00 2027");
      group.members = 0;
      let record: WorkerProcessRecord | undefined;
      let treeOk = false;
      const signals = await withRecordedSignals(fake, async () => {
        const outcome = await managed.cleanup("timeout");
        record = outcome.record;
        treeOk = outcome.treeOk;
      });
      assert.ok(record);
      assert.equal(treeOk, true);
      assert.equal(record.cleanupState, "clean");
      assert.equal(record.cleanupCompleteness, "complete");
      assert.equal(record.nestedCleanup?.state, "clean");
      assert.equal(record.nestedCleanup?.observedGroups, 1);
      assert.equal(record.nestedCleanup?.signalledGroups, 0);
      assert.equal(record.nestedCleanup?.residualGroups, 0);
      assert.equal(record.nestedCleanup?.vanishedGroups, 1);
      assert.equal(record.nestedCleanup?.residualDescendants, 0);
      assert.deepEqual(parseWorkerProcessRecord(record), record);
      // The unverified group id was never signalled, not even for revalidation.
      assert.deepEqual(signals, []);
      assert.equal(record.signals.length, 0);
    } finally {
      unsubscribe();
    }
  },
);

test(
  "keeps needs_human when a reused group id still holds a sampled descendant",
  async () => {
    const group: SyntheticExternalGroup = {
      pgid: 9_100_000,
      members: 2,
      startedAt: syntheticStartedAt,
    };
    const fake = new TableGroupInspector([group]);
    const tree = manager({
      platform: "linux",
      inspector: fake,
      termGraceMs: 100,
      killGraceMs: 100,
      pollMs: 5,
    });
    const managed = tree.manage(fakeManagedChild(fake.leaderPid));
    const snapshots: WorkerNestedProcesses[] = [];
    const unsubscribe = managed.observeExternalDescendants!((snapshot) => {
      snapshots.push(snapshot);
    });
    try {
      await waitFor(
        () => snapshots.some((snapshot) => (snapshot.groups?.length ?? 0) === 1),
        "one-group observation before pid reuse",
      );
      // The leader pid is reused, but the exact identities sampled for the
      // group's members are still present. The group must stay needs_human:
      // never signal it and never auto-accept the vanished classification.
      fake.reusedLeaderStartedAt.set(group.pgid, "Tue Feb  2 00:00:00 2027");
      let record: WorkerProcessRecord | undefined;
      let treeOk = true;
      const signals = await withRecordedSignals(fake, async () => {
        const outcome = await managed.cleanup("timeout");
        record = outcome.record;
        treeOk = outcome.treeOk;
      });
      assert.ok(record);
      assert.equal(treeOk, false);
      assert.equal(record.cleanupState, "failed");
      assert.equal(record.cleanupCompleteness, "incomplete");
      assert.equal(record.nestedCleanup?.state, "failed");
      assert.equal(record.nestedCleanup?.observedGroups, 1);
      assert.equal(record.nestedCleanup?.signalledGroups, 0);
      assert.equal(record.nestedCleanup?.residualGroups, 1);
      assert.equal(record.nestedCleanup?.vanishedGroups, undefined);
      assert.match(record.detail ?? "", /sampled worker descendant remains/);
      assert.deepEqual(parseWorkerProcessRecord(record), record);
      // The unverified group id was never signalled.
      assert.deepEqual(signals, []);
      assert.equal(record.signals.length, 0);
    } finally {
      unsubscribe();
    }
  },
);

test(
  "keeps the legacy per-group inspector fallback when snapshots are unavailable",
  async () => {
    const groups: SyntheticExternalGroup[] = [
      { pgid: 9_100_000, members: 2, startedAt: syntheticStartedAt },
      { pgid: 9_100_010, members: 2, startedAt: syntheticStartedAt },
    ];
    const fake = new TableGroupInspector(groups);
    const tree = manager({
      platform: "linux",
      inspector: fake,
      termGraceMs: 100,
      killGraceMs: 100,
      pollMs: 5,
    });
    const managed = tree.manage(fakeManagedChild(fake.leaderPid));
    const snapshots: WorkerNestedProcesses[] = [];
    const unsubscribe = managed.observeExternalDescendants!((snapshot) => {
      snapshots.push(snapshot);
    });
    try {
      await waitFor(
        () => snapshots.some((snapshot) => (snapshot.groups?.length ?? 0) === 2),
        "legacy fallback observation",
      );
      // Observation used a snapshot; cleanup must fall back to exact per-group
      // capture plus membership listings when no snapshot source remains.
      fake.snapshotProcessTable = undefined;
      const beforeSnapshotCalls = fake.snapshotCalls;
      let record: WorkerProcessRecord | undefined;
      const signals = await withRecordedSignals(fake, async () => {
        record = (await managed.cleanup("timeout")).record;
      });
      assert.ok(record);
      assert.equal(record.cleanupState, "terminated");
      assert.equal(record.nestedCleanup?.state, "terminated");
      assert.equal(record.nestedCleanup?.observedGroups, 2);
      assert.equal(record.nestedCleanup?.signalledGroups, 2);
      assert.equal(record.nestedCleanup?.residualGroups, 0);
      assert.equal(fake.snapshotCalls, beforeSnapshotCalls);
      for (const group of groups) {
        assert.ok(
          fake.listCalls.includes(group.pgid),
          `legacy listing for ${group.pgid}`,
        );
        assert.ok(
          fake.captureCalls.includes(group.pgid),
          `legacy exact capture for ${group.pgid}`,
        );
      }
      assert.deepEqual(
        signals.map((entry) => -entry.pid).sort((a, b) => a - b),
        groups.map((group) => group.pgid),
      );
      assert.ok(signals.every((entry) => entry.signal === "SIGTERM"));
    } finally {
      unsubscribe();
    }
  },
);

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

test("legacy process-tree records stay readable and nested evidence is validated", () => {
  // Version-1 records written before nested tracking have none of the new
  // fields and must keep parsing unchanged.
  const legacy = sampleRecord();
  assert.deepEqual(parseWorkerProcessRecord(legacy), legacy);

  const nested: WorkerProcessRecord = {
    ...legacy,
    observedExternalDescendants: [
      { pid: 12_347, pgid: 12_347, startedAt: "Mon Jan  1 00:00:04 2024" },
    ],
    observedExternalDescendantCount: 1,
    observedExternalGroups: [12_347],
    nestedCleanup: {
      state: "terminated",
      observedDescendants: 1,
      signalledDescendants: 1,
      residualDescendants: 0,
    },
    signals: [
      ...legacy.signals,
      {
        signal: "SIGTERM",
        scope: "descendant-pid",
        pid: 12_347,
        at: "2026-01-01T00:00:01.500Z",
        result: "sent",
      },
    ],
  };
  assert.deepEqual(parseWorkerProcessRecord(nested), nested);

  // Group-only evidence round-trips without inventing fallback pids.
  const grouped: WorkerProcessRecord = {
    ...legacy,
    observedExternalGroups: [12_500],
    nestedCleanup: {
      state: "terminated",
      observedDescendants: 0,
      signalledDescendants: 0,
      residualDescendants: 0,
      observedGroups: 1,
      signalledGroups: 1,
      residualGroups: 0,
    },
    signals: [
      ...legacy.signals,
      {
        signal: "SIGTERM",
        scope: "nested-process-group",
        pgid: 12_500,
        at: "2026-01-01T00:00:01.500Z",
        result: "sent",
      },
    ],
  };
  assert.deepEqual(parseWorkerProcessRecord(grouped), grouped);
  const groupedBase = grouped as unknown as Record<string, unknown>;
  const groupedSignal = (grouped.signals.at(-1) ?? {}) as Record<string, unknown>;
  const groupedCleanup = grouped.nestedCleanup as unknown as Record<string, unknown>;
  for (const bad of [
    {
      ...groupedBase,
      signals: [...grouped.signals.slice(0, -1), { ...groupedSignal, pgid: undefined }],
    },
    {
      ...groupedBase,
      signals: [...grouped.signals.slice(0, -1), { ...groupedSignal, pid: 12_500 }],
    },
    {
      ...groupedBase,
      nestedCleanup: { ...groupedCleanup, observedGroups: 0 },
    },
    {
      ...groupedBase,
      nestedCleanup: { ...groupedCleanup, signalledGroups: 2 },
    },
    {
      ...groupedBase,
      nestedCleanup: {
        ...groupedCleanup,
        state: "clean",
        signalledDescendants: 0,
        signalledGroups: 1,
      },
    },
    {
      ...groupedBase,
      observedExternalGroups: Array.from(
        { length: 17 },
        (_, index) => 12_500 + index,
      ),
    },
  ]) {
    assert.equal(parseWorkerProcessRecord(bad), undefined);
  }

  const base = nested as unknown as Record<string, unknown>;
  const signals = base.signals as Record<string, unknown>[];
  const nestedCleanup = base.nestedCleanup as Record<string, unknown>;
  const invalid: Record<string, unknown>[] = [
    // Evidence is all-or-nothing.
    { ...base, observedExternalDescendantCount: undefined },
    { ...base, observedExternalDescendants: undefined },
    { ...base, observedExternalDescendantCount: 2 },
    { ...base, observedExternalDescendantCount: MAX_SAMPLED_DESCENDANTS + 1 },
    { ...base, observedExternalGroups: undefined },
    { ...base, observedExternalGroups: [12_347, 12_347] },
    { ...base, nestedCleanup: undefined },
    // Nested counters must agree with the observed evidence.
    { ...base, nestedCleanup: { ...nestedCleanup, observedDescendants: 2 } },
    { ...base, nestedCleanup: { ...nestedCleanup, state: "none" } },
    { ...base, nestedCleanup: { ...nestedCleanup, residualDescendants: 1 } },
    // Signal scopes carry exactly the pid they may signal.
    { ...base, signals: [signals[0], { ...signals[1], pid: undefined }] },
    { ...base, signals: [{ ...signals[0], pid: 12_345 }, signals[1]] },
    {
      ...base,
      signals: Array.from({ length: MAX_PROCESS_TREE_SIGNALS + 1 }, () => signals[0]),
    },
    {
      ...base,
      observedExternalDescendants: Array.from(
        { length: MAX_PERSISTED_EXTERNAL_DESCENDANTS + 1 },
        (_, index) => ({
          pid: 30_000 + index,
          pgid: 30_000 + index,
          startedAt: "Mon Jan  1 00:00:04 2024",
        }),
      ),
      observedExternalDescendantCount: MAX_PERSISTED_EXTERNAL_DESCENDANTS + 1,
    },
  ];
  for (const bad of invalid) {
    assert.equal(
      parseWorkerProcessRecord(bad),
      undefined,
      `should reject ${JSON.stringify(bad).slice(0, 160)}`,
    );
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

// ---------------------------------------------------------------------------
// External-descendant observation
// ---------------------------------------------------------------------------

posixTest(
  "observer replays the current external-descendant snapshot and emits changes",
  async () => {
    const tree = manager({ descendantPollMs: 250 });
    const pidFile = nextPidFile("observe");
    // Two helpers; the second is spawned after a pause so the observer sees
    // both an initial snapshot and a later changed one.
    const managed = spawnLeader(tree, pidFile, {
      children: 2,
      detachHelper: true,
      staggerMs: 600,
    });
    const snapshots: WorkerNestedProcesses[] = [];
    const unsubscribe = managed.observeExternalDescendants!((snapshot) => {
      snapshots.push(snapshot);
    });
    try {
      await waitFor(
        () => snapshots.some((snapshot) => snapshot.groups.length === 1),
        "first external group snapshot",
        10_000,
      );
      await waitFor(() => {
        try {
          return JSON.parse(readFileSync(pidFile, "utf8")).length === 2;
        } catch {
          return false;
        }
      }, "second helper pid");
      const helperPids = await readHelperPids(pidFile);
      await waitFor(
        () => snapshots.some((snapshot) => snapshot.groups.length === 2),
        "updated external group snapshot",
        10_000,
      );

      const latest = snapshots[snapshots.length - 1]!;
      assert.equal(latest.version, 1);
      assert.equal(latest.host, inspector.host);
      assert.equal(latest.truncated, false);
      assert.equal(latest.observedCount, 0);
      assert.equal(latest.groups.length, 2);
      assert.equal(latest.identities.length, 0);
      assert.ok(!Number.isNaN(Date.parse(latest.lastObservedAt)));
      for (const pid of helperPids) {
        const group = latest.groups.find((entry) => entry.pgid === pid);
        assert.ok(group, `snapshot contains group ${pid}`);
        assert.equal(group.leader.pid, pid);
        assert.equal(group.leader.pgid, pid);
        assert.equal(group.observedMemberCount, 1);
        // Observation is read-only: every helper is still running.
        assert.equal(inspector.isAlive(pid), true);
      }

      // A late subscriber receives the current snapshot immediately, and
      // unsubscribing stops further deliveries.
      const replayed: WorkerNestedProcesses[] = [];
      const off = managed.observeExternalDescendants!((snapshot) => {
        replayed.push(snapshot);
      });
      assert.equal(replayed.length, 1);
      assert.equal(replayed[0]?.groups.length, 2);
      off();
      const delivered = replayed.length;
      await delay(350);
      assert.equal(replayed.length, delivered);

      const outcome = await managed.cleanup("cancel");
      assert.equal(outcome.treeOk, true);
      for (const pid of helperPids) {
        await waitFor(
          () => !inspector.isAlive(pid),
          `observed helper ${pid} death`,
        );
        liveFixtures.delete(pid);
      }
    } finally {
      unsubscribe();
      await managed.cleanup("cancel");
    }
  },
);

/** Deterministic snapshot source for the bounded/truncated observation test. */
class SyntheticSnapshotInspector implements WorkerProcessTreeInspector {
  readonly host = "host-a";
  readonly supported = true;
  readonly leaderPid = 9_000_001;
  readonly leaderStartedAt = "Mon Jan  1 00:00:00 2024";
  external: ProcessTableEntry[] = [];
  signals: Array<{ pid: number; signal: string }> = [];
  snapshotCalls = 0;

  isAlive(pid: number | undefined): boolean {
    return pid === this.leaderPid;
  }

  async capture(
    pid: number | undefined,
  ): Promise<RuntimeProcessIdentity | undefined> {
    if (pid !== this.leaderPid) return undefined;
    return {
      pid: this.leaderPid,
      pgid: this.leaderPid,
      startedAt: this.leaderStartedAt,
    };
  }

  async listGroupMembers(): Promise<RuntimeProcessIdentity[]> {
    return [];
  }

  async snapshotProcessTable(): Promise<ProcessTableEntry[]> {
    this.snapshotCalls += 1;
    return [
      {
        pid: this.leaderPid,
        ppid: 1,
        pgid: this.leaderPid,
        startedAt: this.leaderStartedAt,
      },
      ...this.external,
    ];
  }
}

test(
  "observer marks an over-bound external snapshot truncated and never signals",
  async () => {
    const fake = new SyntheticSnapshotInspector();
    fake.external = Array.from({ length: 33 }, (_, index) => ({
      pid: 9_000_100 + index,
      ppid: fake.leaderPid,
      pgid: 9_000_200 + index,
      startedAt: "Mon Jan  1 00:00:00 2024",
    }));
    const tree = manager({ platform: "linux", inspector: fake });
    const child = Object.assign(new EventEmitter(), {
      pid: fake.leaderPid,
      exitCode: null,
      signalCode: null,
      kill(signal: NodeJS.Signals) {
        fake.signals.push({ pid: fake.leaderPid, signal });
        return true;
      },
    }) as unknown as ChildProcess;
    const managed = tree.manage(child);
    const snapshots: WorkerNestedProcesses[] = [];
    const unsubscribe = managed.observeExternalDescendants!((snapshot) => {
      snapshots.push(snapshot);
    });
    try {
      await waitFor(() => snapshots.length > 0, "truncated snapshot");
      const snapshot = snapshots[snapshots.length - 1]!;
      assert.equal(snapshot.truncated, true);
      assert.equal(snapshot.observedCount, 33);
      assert.equal(
        snapshot.identities.length,
        MAX_PERSISTED_EXTERNAL_DESCENDANTS,
      );
      // An unchanged process table produces no duplicate emission.
      await waitFor(
        () => fake.snapshotCalls >= 2,
        "second unchanged sample",
      );
      assert.equal(snapshots.length, 1);
      // Observation alone never signals anything, including the leader.
      assert.deepEqual(fake.signals, []);
    } finally {
      unsubscribe();
      await managed.cleanup("cancel");
    }
    assert.deepEqual(fake.signals, []);
  },
);

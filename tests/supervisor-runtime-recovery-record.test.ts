/**
 * Supervisor consumption of `RuntimeRecoveryRecord.runtimeId`
 * (design/runtime-orphan-hardening.md, finding 2).
 *
 * Recovery identity belongs to the record itself. The Supervisor must not
 * rebuild it by matching state and reason text against a second preflight:
 * reasons are not unique, so a reason-keyed lookup can silently swap labels
 * when two runtimes collide.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { RUNTIME_MANIFEST_FILE } from "../src/runtime/manager.js";
import type {
  RuntimeManifest,
  RuntimeRecoveryRecord,
} from "../src/runtime/types.js";
import { runSupervisorCli } from "../src/supervisor/cli.js";
import { createRunManifest } from "../src/supervisor/store.js";

/** A pid above every configured OS pid limit: always provably dead. */
const DEAD_PID = 999_999_999;

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

async function withTempRepo(
  fn: (repo: string) => Promise<void>,
): Promise<void> {
  const repo = mkdtempSync(join(tmpdir(), "cliyard-supervisor-record-"));
  try {
    await fn(repo);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
}

function writeRawManifest(
  repo: string,
  runtimeId: string,
  value: unknown,
): void {
  const dir = join(repo, ".cliyard", "runtime", runtimeId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, RUNTIME_MANIFEST_FILE),
    JSON.stringify(value, null, 2) + "\n",
    "utf8",
  );
}

/** Ownerless: preflight fails closed with one constant reason. */
function ownerlessManifest(runtimeId: string): RuntimeManifest {
  return {
    version: 1,
    runtimeId,
    taskId: `task-${runtimeId}`,
    attempt: 1,
    worktree: "/tmp/cliyard-supervisor-record-worktree",
    services: [],
    startedAt: "2026-10-27T00:00:00.000Z",
    cleanup: "pending",
  };
}

function completedManifest(
  runtimeId: string,
  recovery: RuntimeRecoveryRecord,
): RuntimeManifest {
  return {
    version: 1,
    runtimeId,
    taskId: `task-${runtimeId}`,
    attempt: 1,
    worktree: "/tmp/cliyard-supervisor-record-worktree",
    owner: { pid: DEAD_PID, host: hostname() },
    services: [],
    startedAt: "2026-10-26T00:00:00.000Z",
    cleanup: "complete",
    recovery,
  };
}

function parseJson(lines: readonly string[]): Record<string, any> {
  return JSON.parse(lines.join("\n")) as Record<string, any>;
}

/** Assert the group collides on reason but every record still names an id. */
function assertCollidingReasons(
  records: readonly RuntimeRecoveryRecord[],
): void {
  assert.equal(records.length, 2);
  assert.equal(new Set(records.map((record) => record.reason)).size, 1);
  const ids = records.map((record) => record.runtimeId);
  assert.ok(
    ids.every((id) => typeof id === "string" && id.length > 0),
    "every report record must carry its runtime id",
  );
  assert.equal(new Set(ids).size, ids.length);
}

// ---------------------------------------------------------------------------
// reap: colliding reasons stay distinctly labelled
// ---------------------------------------------------------------------------

test("supervisor reap labels colliding reasons with each record's runtimeId", async () => {
  await withTempRepo(async (repo) => {
    // Both fail preflight with the identical no-owner reason.
    const humanRuntimeIds = ["runtime-alpha", "runtime-beta"];
    for (const runtimeId of humanRuntimeIds) {
      writeRawManifest(repo, runtimeId, ownerlessManifest(runtimeId));
    }
    // Both are skipped for the same constant "cleanup is complete" reason.
    const skippedRuntimeIds = ["runtime-gamma", "runtime-delta"];
    for (const runtimeId of skippedRuntimeIds) {
      writeRawManifest(repo, runtimeId, {
        ...ownerlessManifest(runtimeId),
        cleanup: "complete",
      });
    }

    const jsonLines: string[] = [];
    assert.equal(
      await runSupervisorCli(["reap", "--repo", repo, "--json"], {
        log: (line) => jsonLines.push(line),
      }),
      0,
    );
    const report = parseJson(jsonLines);
    assert.equal(report.reaped.length, 0);
    assert.equal(report.needsHuman.length, 2);
    assert.equal(report.skipped.length, 2);

    assertCollidingReasons(report.needsHuman as RuntimeRecoveryRecord[]);
    assertCollidingReasons(report.skipped as RuntimeRecoveryRecord[]);
    assert.deepEqual(
      (report.needsHuman as RuntimeRecoveryRecord[])
        .map((record) => record.runtimeId)
        .sort(),
      [...humanRuntimeIds].sort(),
    );
    assert.deepEqual(
      (report.skipped as RuntimeRecoveryRecord[])
        .map((record) => record.runtimeId)
        .sort(),
      [...skippedRuntimeIds].sort(),
    );

    // Human output uses the same record ids, not reason matching.
    const humanLines: string[] = [];
    assert.equal(
      await runSupervisorCli(["reap", "--repo", repo], {
        log: (line) => humanLines.push(line),
      }),
      0,
    );
    const detailLines = humanLines.filter((line) =>
      /^(?:needs human|reaped|skipped) /.test(line),
    );
    assert.equal(detailLines.length, 4);
    const expectedLabels = [
      ...humanRuntimeIds.map(
        (id) => `needs human ${id}: manifest has no valid owner identity`,
      ),
      ...skippedRuntimeIds.map((id) => `skipped ${id}: cleanup is complete`),
    ];
    for (const label of expectedLabels) {
      assert.ok(
        detailLines.some((line) => line.startsWith(label)),
        `missing report line for ${label}`,
      );
    }
    assert.equal(
      humanLines.join("\n").includes(String.fromCharCode(0)),
      false,
      "report lines must not contain NUL delimiters",
    );
  });
});

// ---------------------------------------------------------------------------
// status: the record id wins, legacy records fall back to the manifest
// ---------------------------------------------------------------------------

test("supervisor status reads the record runtimeId and falls back to the manifest", async () => {
  await withTempRepo(async (repo) => {
    const contractsPath = join(repo, "contracts.json");
    writeFileSync(contractsPath, '{"contracts":[]}\n', "utf8");
    const run = createRunManifest(repo, {
      planId: "recovery-record",
      contractsPath,
      baseCommit: "0".repeat(40),
      integrationBranch: "cliyard/integration/recovery-record",
      tasks: [],
    });

    // A new record: status must report the id written in the evidence itself.
    writeRawManifest(
      repo,
      "runtime-record-id",
      completedManifest("runtime-record-id", {
        runtimeId: "runtime-record-id-directly",
        state: "reaped",
        reason: "owner pid 999999999 is not running on this host",
        at: "2026-10-26T00:00:00.000Z",
        reaperPid: 4242,
        reaperHost: hostname(),
        services: [],
      }),
    );
    // A legacy record without an id: the manifest id is the fallback.
    writeRawManifest(
      repo,
      "runtime-legacy",
      completedManifest("runtime-legacy", {
        state: "needs_human",
        reason: "manifest has no valid owner identity",
        at: "2026-10-26T00:00:01.000Z",
        reaperPid: 4242,
        reaperHost: hostname(),
        services: [],
      }),
    );

    const jsonLines: string[] = [];
    assert.equal(
      await runSupervisorCli(
        ["status", "--repo", repo, "--run", run.runId, "--json"],
        { log: (line) => jsonLines.push(line) },
      ),
      0,
    );
    const status = parseJson(jsonLines);
    const entries = status.runtimeRecovery as Array<{
      runtimeId: string;
      recovery: RuntimeRecoveryRecord;
    }>;
    const byId = new Map(entries.map((entry) => [entry.runtimeId, entry]));
    assert.deepEqual([...byId.keys()].sort(), [
      "runtime-legacy",
      "runtime-record-id-directly",
    ]);
    assert.equal(
      byId.get("runtime-record-id-directly")?.recovery.runtimeId,
      "runtime-record-id-directly",
    );
    assert.equal(
      "runtimeId" in (byId.get("runtime-legacy")!.recovery),
      false,
      "fixture legacy record must not carry an id",
    );

    const humanLines: string[] = [];
    assert.equal(
      await runSupervisorCli(["status", "--repo", repo, "--run", run.runId], {
        log: (line) => humanLines.push(line),
      }),
      0,
    );
    const text = humanLines.join("\n");
    assert.match(
      text,
      /runtime recovery: runtime-record-id-directly reaped at /,
    );
    assert.match(text, /runtime recovery: runtime-legacy needs_human at /);
  });
});

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { hostname, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { runtimePaths } from "../src/runtime/manager.js";
import { preflightOrphanedRuntimes } from "../src/runtime/reaper.js";
import { reapOrphanedRuntimes } from "../src/runtime/reaper-execute.js";
import type {
  RuntimeCleanupState,
  RuntimeManifest,
  RuntimeRecoveryRecord,
  RuntimeRecoveryState,
} from "../src/runtime/types.js";

/**
 * A pid above every configured OS pid limit: `kill(pid, 0)` always reports
 * ESRCH, so fixtures exercise orphan handling without racing a real exit.
 */
const DEAD_PID = 999_999_999;

const EXECUTE_OPTIONS = {
  stopGraceMs: 500,
  killGraceMs: 500,
  portReleaseTimeoutMs: 1_000,
  lockTimeoutMs: 10_000,
} as const;

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

async function withTempRepo(
  fn: (repo: string) => Promise<void>,
): Promise<void> {
  const base = mkdtempSync(join(tmpdir(), "cliyard-recovery-record-"));
  const repo = join(base, "control");
  mkdirSync(repo, { recursive: true });
  try {
    await fn(repo);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
}

interface ManifestInput {
  runtimeId: string;
  cleanup?: RuntimeCleanupState;
  recovery?: RuntimeRecoveryRecord;
}

/**
 * Owner is always dead and no service ever started, so every fixture runtime
 * is orphan-eligible without spawning processes or leasing ports.
 */
function makeManifest(input: ManifestInput): RuntimeManifest {
  return {
    version: 1,
    runtimeId: input.runtimeId,
    taskId: `task-${input.runtimeId}`,
    attempt: 1,
    worktree: "/tmp/cliyard-recovery-record-worktree",
    owner: { pid: DEAD_PID, host: hostname() },
    services: [],
    startedAt: "2026-10-27T00:00:00.000Z",
    cleanup: input.cleanup ?? "pending",
    ...(input.recovery !== undefined ? { recovery: input.recovery } : {}),
  };
}

/**
 * A record written before runtime identity was carried. The omitted
 * `runtimeId` must remain valid evidence, not a parse error.
 */
function legacyRecovery(state: RuntimeRecoveryState): RuntimeRecoveryRecord {
  return {
    state,
    reason: "owner pid 999999999 is not running on this host",
    at: "2026-10-26T00:00:00.000Z",
    reaperPid: 4242,
    reaperHost: hostname(),
    services: [],
  };
}

function manifestPathOf(repo: string, runtimeId: string): string {
  return runtimePaths(repo, runtimeId).manifestPath;
}

function writeManifest(repo: string, manifest: RuntimeManifest): string {
  const path = manifestPathOf(repo, manifest.runtimeId);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(manifest, null, 2) + "\n", "utf8");
  return path;
}

function readManifest(repo: string, runtimeId: string): RuntimeManifest {
  return JSON.parse(
    readFileSync(manifestPathOf(repo, runtimeId), "utf8"),
  ) as RuntimeManifest;
}

// ---------------------------------------------------------------------------
// New records
// ---------------------------------------------------------------------------

test("executor records carry runtimeId for reaped, skipped and needs_human plans", async () => {
  await withTempRepo(async (repo) => {
    // Eligible orphan: executed and persisted.
    writeManifest(repo, makeManifest({ runtimeId: "runtime-reaped" }));
    // Already closed: reported as skipped, never rewritten.
    const skippedPath = writeManifest(
      repo,
      makeManifest({ runtimeId: "runtime-complete", cleanup: "complete" }),
    );
    // Unparseable manifest: needs_human, with the directory as runtime id.
    const brokenPath = manifestPathOf(repo, "runtime-broken");
    mkdirSync(dirname(brokenPath), { recursive: true });
    writeFileSync(brokenPath, "{not json", "utf8");

    const skippedBefore = readFileSync(skippedPath, "utf8");

    const report = await reapOrphanedRuntimes(repo, EXECUTE_OPTIONS);

    assert.equal(report.scanned, 3);
    assert.equal(report.reaped.length, 1);
    assert.equal(report.skipped.length, 1);
    assert.equal(report.needsHuman.length, 1);

    // Every record names its runtime directly; none is reconstructed from the
    // reason text.
    assert.equal(report.reaped[0].runtimeId, "runtime-reaped");
    assert.equal(report.skipped[0].runtimeId, "runtime-complete");
    assert.equal(report.needsHuman[0].runtimeId, "runtime-broken");
    assert.match(report.needsHuman[0].reason, /invalid JSON/);

    // The executed record keeps its runtimeId through manifest persistence.
    const finalized = readManifest(repo, "runtime-reaped");
    assert.equal(finalized.cleanup, "complete");
    assert.equal(finalized.recovery?.runtimeId, "runtime-reaped");
    assert.deepEqual(finalized.recovery, report.reaped[0]);

    // Reported-only plans do not touch the manifest.
    assert.equal(readFileSync(skippedPath, "utf8"), skippedBefore);
    assert.equal(readFileSync(brokenPath, "utf8"), "{not json");
  });
});

test("a persisted needs_human record keeps its runtimeId", async () => {
  await withTempRepo(async (repo) => {
    writeManifest(repo, makeManifest({ runtimeId: "runtime-human" }));

    // Preflight lists leases once; the executor's pre-release reread fails, so
    // the plan is reported and persisted as needs_human.
    let listCalls = 0;
    const allocator = {
      list: () => {
        listCalls += 1;
        if (listCalls > 1) throw new Error("injected lease read failure");
        return [];
      },
      release: async () => true,
    };

    const report = await reapOrphanedRuntimes(repo, {
      ...EXECUTE_OPTIONS,
      allocator,
    });

    assert.equal(report.reaped.length, 0);
    assert.equal(report.needsHuman.length, 1);
    assert.equal(report.needsHuman[0].runtimeId, "runtime-human");
    assert.match(report.needsHuman[0].reason, /cannot re-read port leases/);

    const manifest = readManifest(repo, "runtime-human");
    assert.equal(manifest.cleanup, "failed");
    assert.equal(manifest.recovery?.state, "needs_human");
    assert.equal(manifest.recovery?.runtimeId, "runtime-human");
    assert.deepEqual(manifest.recovery, report.needsHuman[0]);
  });
});

// ---------------------------------------------------------------------------
// Legacy records
// ---------------------------------------------------------------------------

test("recovery records without runtimeId remain readable", async () => {
  await withTempRepo(async (repo) => {
    const settledPath = writeManifest(
      repo,
      makeManifest({
        runtimeId: "runtime-legacy-settled",
        cleanup: "complete",
        recovery: legacyRecovery("reaped"),
      }),
    );
    writeManifest(
      repo,
      makeManifest({
        runtimeId: "runtime-legacy-open",
        cleanup: "failed",
        recovery: legacyRecovery("needs_human"),
      }),
    );
    const settledBefore = readFileSync(settledPath, "utf8");

    // Preflight parses both legacy manifests and classifies them from state,
    // not from the fact that a record lacks runtimeId.
    const preflight = await preflightOrphanedRuntimes(repo);
    assert.equal(preflight.scanned, 2);
    assert.equal(preflight.needsHuman.length, 0);
    assert.deepEqual(
      preflight.plans.map((plan) => [plan.runtimeId, plan.state]),
      [
        ["runtime-legacy-open", "safe_to_reap"],
        ["runtime-legacy-settled", "skip"],
      ],
    );
    const settledPlan = preflight.plans.find(
      (plan) => plan.runtimeId === "runtime-legacy-settled",
    );
    assert.ok(settledPlan, "missing plan for the settled legacy runtime");
    assert.equal(settledPlan.manifest?.recovery?.state, "reaped");
    assert.equal(settledPlan.manifest?.recovery?.runtimeId, undefined);

    const report = await reapOrphanedRuntimes(repo, EXECUTE_OPTIONS);

    // Both reported records carry a runtimeId, including the skipped legacy
    // runtime whose persisted record still has none.
    assert.equal(report.reaped.length, 1);
    assert.equal(report.reaped[0].runtimeId, "runtime-legacy-open");
    assert.equal(report.skipped.length, 1);
    assert.equal(report.skipped[0].runtimeId, "runtime-legacy-settled");

    // The settled legacy evidence is readable and left byte-identical.
    assert.equal(readFileSync(settledPath, "utf8"), settledBefore);
    const settled = readManifest(repo, "runtime-legacy-settled");
    assert.equal(settled.recovery?.state, "reaped");
    assert.equal("runtimeId" in (settled.recovery ?? {}), false);

    // Reaping an unreconciled legacy runtime replaces its record with one that
    // carries the runtime id.
    const open = readManifest(repo, "runtime-legacy-open");
    assert.equal(open.cleanup, "complete");
    assert.equal(open.recovery?.state, "reaped");
    assert.equal(open.recovery?.runtimeId, "runtime-legacy-open");
    assert.deepEqual(open.recovery, report.reaped[0]);
  });
});

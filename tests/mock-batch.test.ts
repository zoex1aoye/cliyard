import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { TaskContract } from "../src/contracts/schema.js";
import { createMockAdapter } from "../src/agents/mock.js";
import { createMockVerifier } from "../src/verification/verifier.js";
import {
  loadContractsInput,
  runMockBatch,
} from "../src/scheduler/mock-batch.js";

const chainFixture = fileURLToPath(
  new URL("../examples/mock-batch.chain.json", import.meta.url),
);

function base(overrides: Partial<TaskContract> & { taskId: string }): TaskContract {
  return {
    version: 1,
    frozen: true,
    goals: [`goal for ${overrides.taskId}`],
    dependsOn: [],
    readPaths: ["src/"],
    writePaths: [`src/${overrides.taskId}/`],
    sharedResources: [],
    baseCommit: "HEAD",
    verifyCommands: [],
    maxRepairs: 2,
    ...overrides,
  };
}

function withTempLedger<T>(fn: (ledgerPath: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "cliyard-batch-"));
  const ledgerPath = join(dir, "ledger.json");
  return fn(ledgerPath).finally(() => {
    rmSync(dir, { recursive: true, force: true });
  });
}

test("loadContractsInput: chain fixture", () => {
  const contracts = loadContractsInput(chainFixture);
  assert.equal(contracts.length, 2);
  assert.equal(contracts[0].taskId, "api");
  assert.deepEqual(contracts[1].dependsOn, ["api"]);
});

test("runMockBatch: 2-task chain starts api before web", async () => {
  await withTempLedger(async (ledgerPath) => {
    const startSnapshots: { id: string; accepted: string[] }[] = [];
    const result = await runMockBatch({
      contracts: [
        base({ taskId: "api" }),
        base({ taskId: "web", dependsOn: ["api"] }),
      ],
      createWorker: () => createMockAdapter({ failVerifyTimes: 0 }),
      verifier: createMockVerifier(),
      ledgerPath,
      onTaskStart: (id, accepted) => {
        startSnapshots.push({ id, accepted: [...accepted] });
      },
    });
    assert.deepEqual(result.startOrder, ["api", "web"]);
    assert.equal(result.allAccepted, true);
    assert.equal(result.skipped.length, 0);
    assert.deepEqual(startSnapshots[0], { id: "api", accepted: [] });
    assert.deepEqual(startSnapshots[1], { id: "web", accepted: ["api"] });
  });
});

test("runMockBatch: diamond — leaf waits for both middles", async () => {
  await withTempLedger(async (ledgerPath) => {
    const startSnapshots: { id: string; accepted: string[] }[] = [];
    const result = await runMockBatch({
      contracts: [
        base({ taskId: "root" }),
        base({ taskId: "left", dependsOn: ["root"] }),
        base({ taskId: "right", dependsOn: ["root"] }),
        base({ taskId: "leaf", dependsOn: ["left", "right"] }),
      ],
      createWorker: () => createMockAdapter({ failVerifyTimes: 0 }),
      verifier: createMockVerifier(),
      ledgerPath,
      onTaskStart: (id, accepted) => {
        startSnapshots.push({ id, accepted: [...accepted].sort() });
      },
    });
    assert.deepEqual(result.startOrder, ["root", "left", "right", "leaf"]);
    assert.equal(result.allAccepted, true);

    const leaf = startSnapshots.find((s) => s.id === "leaf");
    assert.ok(leaf);
    assert.deepEqual(leaf!.accepted, ["left", "right", "root"].sort());

    const left = startSnapshots.find((s) => s.id === "left");
    assert.ok(left);
    assert.deepEqual(left!.accepted, ["root"]);
  });
});

test("runMockBatch: blocked tasks wait — dependent never starts if dep rejected", async () => {
  await withTempLedger(async (ledgerPath) => {
    const started: string[] = [];
    const result = await runMockBatch({
      contracts: [
        base({ taskId: "api", maxRepairs: 0 }),
        base({ taskId: "web", dependsOn: ["api"] }),
      ],
      // api always fails verify → rejected with maxRepairs=0
      createWorker: (c) =>
        createMockAdapter({
          failVerifyTimes: c.taskId === "api" ? 99 : 0,
        }),
      verifier: createMockVerifier(),
      ledgerPath,
      onTaskStart: (id) => {
        started.push(id);
      },
    });
    assert.deepEqual(started, ["api"]);
    assert.deepEqual(result.startOrder, ["api"]);
    assert.equal(result.results[0].verdict, "rejected");
    assert.equal(result.skipped.length, 1);
    assert.equal(result.skipped[0].taskId, "web");
    assert.match(result.skipped[0].reason, /dependencies not accepted/);
    assert.equal(result.allAccepted, false);
  });
});

test("runMockBatch: writes all accepted tasks into shared ledger", async () => {
  await withTempLedger(async (ledgerPath) => {
    await runMockBatch({
      contracts: loadContractsInput(chainFixture),
      createWorker: () => createMockAdapter({ failVerifyTimes: 0 }),
      verifier: createMockVerifier(),
      ledgerPath,
    });
    const ledger = JSON.parse(readFileSync(ledgerPath, "utf8")) as {
      tasks: Record<string, { status: string }>;
    };
    assert.equal(ledger.tasks.api.status, "accepted");
    assert.equal(ledger.tasks.web.status, "accepted");
  });
});

test("runMockBatch: cycle throws", async () => {
  await withTempLedger(async (ledgerPath) => {
    await assert.rejects(
      () =>
        runMockBatch({
          contracts: [
            base({ taskId: "a", dependsOn: ["b"] }),
            base({ taskId: "b", dependsOn: ["a"] }),
          ],
          ledgerPath,
        }),
      /cycle/,
    );
  });
});

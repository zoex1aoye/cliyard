import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createMockAdapter } from "../src/agents/mock.js";
import { createMockVerifier } from "../src/verification/verifier.js";
import {
  loadContractsInput,
  runMockBatch,
} from "../src/scheduler/mock-batch.js";

const parallelFixture = fileURLToPath(
  new URL("../examples/mock-batch.parallel.json", import.meta.url),
);

test("runMockBatch: two independent modules start in one wave", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cliyard-par-"));
  const ledgerPath = join(dir, "ledger.json");
  try {
    const startedAt: Record<string, number> = {};
    const contracts = loadContractsInput(parallelFixture);
    const result = await runMockBatch({
      contracts,
      createWorker: () => createMockAdapter({ failVerifyTimes: 0 }),
      verifier: createMockVerifier(),
      ledgerPath,
      onTaskStart: (id) => {
        startedAt[id] = Date.now();
      },
    });
    assert.equal(result.allAccepted, true);
    assert.deepEqual(result.startOrder.sort(), ["module-a", "module-b"]);
    // Both should be present in ledger
    const ledger = JSON.parse(readFileSync(ledgerPath, "utf8")) as {
      tasks: Record<string, { status: string }>;
    };
    assert.equal(ledger.tasks["module-a"].status, "accepted");
    assert.equal(ledger.tasks["module-b"].status, "accepted");
    assert.ok(startedAt["module-a"]);
    assert.ok(startedAt["module-b"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

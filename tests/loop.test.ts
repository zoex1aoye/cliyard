import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadContractJson } from "../src/contracts/schema.js";
import { createMockAdapter } from "../src/agents/mock.js";
import type {
  AgentAdapter,
  AgentStartInput,
} from "../src/agents/types.js";
import { createMockVerifier } from "../src/verification/verifier.js";
import { runClosedLoop } from "../src/repair/loop.js";
import { readFileSync } from "node:fs";

const baseContract = loadContractJson(
  readFileSync(new URL("../examples/mock.contract.json", import.meta.url), "utf8"),
);

function withTempLedger<T>(fn: (ledgerPath: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "cliyard-loop-"));
  const ledgerPath = join(dir, "ledger.json");
  return fn(ledgerPath).finally(() => {
    rmSync(dir, { recursive: true, force: true });
  });
}

test("runClosedLoop happy path: verify ok on first attempt → accepted", async () => {
  await withTempLedger(async (ledgerPath) => {
    const result = await runClosedLoop({
      contract: { ...baseContract, maxRepairs: 2 },
      worker: createMockAdapter({ failVerifyTimes: 0 }),
      verifier: createMockVerifier(),
      ledgerPath,
    });
    assert.equal(result.verdict, "accepted");
    assert.equal(result.status, "accepted");
    assert.equal(result.repairCount, 0);
    assert.match(result.reason, /verified after 0 repair/);
    assert.ok(result.events.some((e) => e.type === "verdict"));
  });
});

test("runClosedLoop repair path: first verify fails then accept", async () => {
  await withTempLedger(async (ledgerPath) => {
    const result = await runClosedLoop({
      contract: { ...baseContract, maxRepairs: 2 },
      worker: createMockAdapter({ failVerifyTimes: 1 }),
      verifier: createMockVerifier(),
      ledgerPath,
    });
    assert.equal(result.verdict, "accepted");
    assert.equal(result.status, "accepted");
    assert.equal(result.repairCount, 1);
    assert.ok(result.events.some((e) => e.type === "repair"));
    assert.ok(result.events.filter((e) => e.type === "verify.start").length >= 2);
  });
});

test("runClosedLoop maxRepairs reject: verify keeps failing", async () => {
  await withTempLedger(async (ledgerPath) => {
    const result = await runClosedLoop({
      contract: { ...baseContract, maxRepairs: 2 },
      worker: createMockAdapter({ failVerifyTimes: 99 }),
      verifier: createMockVerifier(),
      ledgerPath,
    });
    assert.equal(result.verdict, "rejected");
    assert.equal(result.status, "rejected");
    assert.equal(result.repairCount, 2);
    assert.match(result.reason, /maxRepairs=2 exhausted/);
  });
});

test("runClosedLoop implement crash → rejected without repair", async () => {
  await withTempLedger(async (ledgerPath) => {
    const result = await runClosedLoop({
      contract: { ...baseContract, maxRepairs: 2 },
      worker: createMockAdapter({ implementCrash: true }),
      verifier: createMockVerifier(),
      ledgerPath,
    });
    assert.equal(result.verdict, "rejected");
    assert.equal(result.status, "rejected");
    assert.equal(result.repairCount, 0);
    assert.match(result.reason, /implement failed/);
  });
});

test("repair attempt receives the previous verifier failure evidence", async () => {
  await withTempLedger(async (ledgerPath) => {
    const starts: AgentStartInput[] = [];
    const worker: AgentAdapter = {
      id: "mock",
      async discover() {
        return {
          id: "mock",
          ok: true,
          supportsModelFlag: false,
          notes: [],
        };
      },
      async start(input) {
        starts.push(input);
        return { sessionId: `session-${input.attempt}` };
      },
      async collect(sessionId) {
        return {
          sessionId,
          exitCode: 0,
          touchedPaths: ["src/hello/"],
          logTail: "implemented",
        };
      },
      async cancel() {},
    };
    let verifyCount = 0;
    const result = await runClosedLoop({
      contract: { ...baseContract, maxRepairs: 1 },
      worker,
      verifier: {
        async run() {
          verifyCount += 1;
          return verifyCount === 1
            ? {
                ok: false,
                exitCode: 1,
                commandResults: [],
                logTail: "EXPECTED_REPAIR_DETAIL: missing hello export",
              }
            : {
                ok: true,
                exitCode: 0,
                commandResults: [],
                logTail: "repair passed",
              };
        },
      },
      ledgerPath,
    });

    assert.equal(result.verdict, "accepted");
    assert.equal(starts.length, 2);
    assert.equal(starts[1]?.attempt, 1);
    assert.match(
      starts[1]?.priorFailure?.verifyLog ?? "",
      /EXPECTED_REPAIR_DETAIL/,
    );
  });
});

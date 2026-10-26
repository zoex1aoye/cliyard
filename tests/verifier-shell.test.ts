import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TaskContract } from "../src/contracts/schema.js";
import type { AgentResult } from "../src/agents/types.js";
import {
  createShellVerifier,
  wantsRealVerify,
} from "../src/verification/verifier.js";
import { createMockAdapter } from "../src/agents/mock.js";
import { runClosedLoop } from "../src/repair/loop.js";

function contract(overrides: Partial<TaskContract> = {}): TaskContract {
  return {
    taskId: "shell-verify-unit",
    version: 1,
    frozen: true,
    goals: ["unit"],
    dependsOn: [],
    readPaths: ["src/"],
    writePaths: ["src/hello/"],
    sharedResources: [],
    baseCommit: "HEAD",
    verifyCommands: ["true"],
    maxRepairs: 2,
    ...overrides,
  };
}

function okAgent(overrides: Partial<AgentResult> = {}): AgentResult {
  return {
    sessionId: "s1",
    exitCode: 0,
    touchedPaths: ["src/hello/x.ts"],
    logTail: "ok",
    ...overrides,
  };
}

test("wantsRealVerify: flag and env", () => {
  assert.equal(wantsRealVerify(["--real-verify"], {}), true);
  assert.equal(wantsRealVerify([], { CLIYARD_REAL_VERIFY: "1" }), true);
  assert.equal(wantsRealVerify([], { CLIYARD_REAL_VERIFY: "true" }), true);
  assert.equal(wantsRealVerify([], {}), false);
  assert.equal(wantsRealVerify(["--ledger", "x"], {}), false);
});

test("createShellVerifier: true command passes", async () => {
  const v = createShellVerifier();
  const r = await v.run(contract({ verifyCommands: ["true"] }), okAgent());
  assert.equal(r.ok, true);
  assert.equal(r.exitCode, 0);
  assert.match(r.logTail, /shell-verify/);
});

test("createShellVerifier: false command fails", async () => {
  const v = createShellVerifier();
  const r = await v.run(contract({ verifyCommands: ["false"] }), okAgent());
  assert.equal(r.ok, false);
  assert.notEqual(r.exitCode, 0);
});

test("createShellVerifier: echo captures stdout", async () => {
  const v = createShellVerifier();
  const r = await v.run(
    contract({ verifyCommands: ["echo cliyard-shell-ok"] }),
    okAgent(),
  );
  assert.equal(r.ok, true);
  assert.match(r.logTail, /cliyard-shell-ok/);
});

test("createShellVerifier: ignores mockMeta intendedVerifyFail", async () => {
  const v = createShellVerifier();
  const r = await v.run(
    contract({ verifyCommands: ["true"] }),
    okAgent({ mockMeta: { intendedVerifyFail: true } }),
  );
  assert.equal(r.ok, true);
});

test("runClosedLoop + shell verifier: true → accepted (ledger written)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cliyard-shell-"));
  const ledgerPath = join(dir, "ledger.json");
  try {
    const result = await runClosedLoop({
      contract: contract({ verifyCommands: ["true"], maxRepairs: 1 }),
      worker: createMockAdapter({ failVerifyTimes: 99 }), // mockMeta ignored
      verifier: createShellVerifier(),
      ledgerPath,
    });
    assert.equal(result.verdict, "accepted");
    assert.equal(result.repairCount, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runClosedLoop + shell verifier: false exhausts maxRepairs → rejected", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cliyard-shell-"));
  const ledgerPath = join(dir, "ledger.json");
  try {
    const result = await runClosedLoop({
      contract: contract({ verifyCommands: ["false"], maxRepairs: 1 }),
      worker: createMockAdapter({ failVerifyTimes: 0 }),
      verifier: createShellVerifier(),
      ledgerPath,
    });
    assert.equal(result.verdict, "rejected");
    assert.equal(result.repairCount, 1);
    assert.match(result.reason, /maxRepairs/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

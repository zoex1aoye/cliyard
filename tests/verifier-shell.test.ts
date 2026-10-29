import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_VERIFY_TIMEOUT_MS,
  type TaskContract,
} from "../src/contracts/schema.js";
import type { AgentResult } from "../src/agents/types.js";
import {
  createShellVerifier,
  wantsRealVerify,
} from "../src/verification/verifier.js";
import { createMockAdapter } from "../src/agents/mock.js";
import { classifyFailure } from "../src/failures.js";
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

test("createShellVerifier: legacy contract keeps the 30-second default", async () => {
  assert.equal(DEFAULT_VERIFY_TIMEOUT_MS, 30_000);
  const v = createShellVerifier();
  const r = await v.run(
    contract({
      verifyCommands: [
        'node -e "setTimeout(() => {}, 250)"',
      ],
    }),
    okAgent(),
  );
  assert.equal(r.ok, true);
  assert.doesNotMatch(r.logTail, /TIMEOUT/);
});

test("createShellVerifier: option timeout is the fallback for legacy contracts", async () => {
  const v = createShellVerifier({ timeoutMs: 150 });
  const r = await v.run(
    contract({ verifyCommands: ["sleep 5"] }),
    okAgent(),
  );
  assert.equal(r.ok, false);
  assert.equal(r.exitCode, 124);
  assert.match(r.commandResults[0]!.log, /TIMEOUT \(150ms\): sleep 5/);
});

test("createShellVerifier: contract timeout overrides the option per command", async () => {
  const v = createShellVerifier({ timeoutMs: 10_000 });
  const started = Date.now();
  const r = await v.run(
    contract({
      verifyCommands: ["sleep 5", "true"],
      verifyTimeoutMs: 150,
    }),
    okAgent(),
  );
  assert.equal(r.ok, false);
  assert.equal(r.exitCode, 124);
  // The first command times out and the remaining command never runs.
  assert.equal(r.commandResults.length, 1);
  assert.equal(r.commandResults[0]!.exitCode, 124);
  assert.match(r.commandResults[0]!.log, /TIMEOUT \(150ms\): sleep 5/);
  assert.ok(
    Date.now() - started < 2_000,
    "contract timeout did not override the wider verifier option",
  );
});

test("createShellVerifier: timeout is a verifier failure, not accepted evidence", async () => {
  const v = createShellVerifier();
  const r = await v.run(
    contract({ verifyCommands: ["sleep 5"], verifyTimeoutMs: 100 }),
    okAgent(),
  );
  assert.equal(r.ok, false);
  assert.equal(r.exitCode, 124);
  assert.deepEqual(
    classifyFailure({
      exitCode: r.exitCode,
      text: r.logTail,
      stage: "verifier",
    }),
    { category: "timeout", stage: "verifier" },
  );
});

test("runClosedLoop + shell verifier: timeout exhausts repairs as rejected", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cliyard-shell-timeout-"));
  const ledgerPath = join(dir, "ledger.json");
  try {
    const result = await runClosedLoop({
      contract: contract({
        verifyCommands: ["sleep 5"],
        verifyTimeoutMs: 100,
        maxRepairs: 0,
      }),
      worker: createMockAdapter({ failVerifyTimes: 99 }),
      verifier: createShellVerifier(),
      ledgerPath,
    });
    assert.equal(result.verdict, "rejected");
    assert.equal(result.repairCount, 0);
    assert.equal(result.failure?.category, "verifier_rejected");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
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

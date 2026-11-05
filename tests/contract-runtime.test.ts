import { test } from "node:test";
import assert from "node:assert/strict";
import {
  compilePlan,
  makeContractDocument,
  PlanValidationError,
} from "../src/planner/plan.js";
import {
  DEFAULT_EXECUTION_CONTINUITY,
  DEFAULT_VERIFY_TIMEOUT_MS,
  EXECUTION_CONTINUITY_POLICIES,
  executionContinuity,
  loadContractJson,
  MAX_VERIFY_TIMEOUT_MS,
  validateContract,
} from "../src/contracts/schema.js";
import { taskFileToContracts } from "../src/contracts/fromTaskfile.js";

const base = "b".repeat(40);

function baseContractRaw(): Record<string, unknown> {
  return {
    taskId: "timeout-contract",
    version: 1,
    frozen: true,
    goals: ["Bound verifier commands"],
    dependsOn: [],
    readPaths: ["."],
    writePaths: ["src/server.ts"],
    sharedResources: [],
    baseCommit: base,
    verifyCommands: ["test -f src/server.ts"],
    maxRepairs: 0,
  };
}

const validRuntime = {
  services: [
    {
      name: "web",
      command: ["node", "server.cjs"],
      cwd: "services/web",
      portEnv: "PORT",
      urlEnv: "WEB_URL",
      readiness: {
        path: "/health",
        expectedStatus: 204,
        timeoutMs: 5_000,
      },
    },
    {
      name: "api",
      command: ["node", "--enable-source-maps", "api.js"],
      cwd: ".",
    },
  ],
};

function taskPlan(runtime?: unknown): Record<string, unknown> {
  const task: Record<string, unknown> = {
    taskId: "web-runtime",
    goal: "Expose a verified health endpoint",
    writePaths: ["src/server.ts"],
    verifyCommands: ['curl -fsS "$WEB_URL/health"'],
  };
  if (runtime !== undefined) task.runtime = runtime;
  return { planId: "runtime-contract", tasks: [task] };
}

function compileWithRuntime(runtime?: unknown) {
  return compilePlan(taskPlan(runtime), { baseCommit: base });
}

function rejectsRuntime(runtime: unknown, expected: RegExp): void {
  assert.throws(
    () => compileWithRuntime(runtime),
    (error: unknown) => {
      assert.ok(error instanceof PlanValidationError);
      assert.match(error.message, expected);
      return true;
    },
  );
}

test("compilePlan: valid runtime is preserved on the frozen contract", () => {
  const compiled = compileWithRuntime(validRuntime);
  const contract = compiled.contracts[0]!;
  assert.equal(contract.frozen, true);
  assert.equal(contract.baseCommit, base);
  assert.deepEqual(contract.runtime, validRuntime);

  const document = JSON.parse(
    JSON.stringify(makeContractDocument(compiled)),
  ) as { contracts: { runtime?: unknown }[] };
  assert.deepEqual(document.contracts[0]!.runtime, validRuntime);

  const revalidated = validateContract(contract);
  assert.equal(revalidated.ok, true);
  if (!revalidated.ok) return;
  assert.deepEqual(revalidated.contract.runtime, validRuntime);
});

test("compilePlan: contracts without runtime keep their previous shape", () => {
  const compiled = compileWithRuntime();
  const contract = compiled.contracts[0]!;
  assert.equal(Object.hasOwn(contract, "runtime"), false);
  assert.equal("runtime" in contract, false);

  const loaded = loadContractJson(JSON.stringify(contract));
  assert.equal(Object.hasOwn(loaded, "runtime"), false);
  assert.equal(JSON.stringify(contract).includes('"runtime"'), false);
});

test("compilePlan: runtime service names must be safe path segments", () => {
  for (const name of [
    "",
    "   ",
    "../web",
    "services/web",
    "web server",
    "-web",
    ".web",
    "web:1",
  ]) {
    rejectsRuntime(
      { services: [{ name, command: ["node", "server.cjs"] }] },
      /tasks\[0\]\.runtime\.services\[0\]\.name/,
    );
  }
});

test("compilePlan: duplicate runtime service names are rejected", () => {
  rejectsRuntime(
    {
      services: [
        { name: "web", command: ["node", "one.cjs"] },
        { name: "web", command: ["node", "two.cjs"] },
      ],
    },
    /tasks\[0\]\.runtime\.services\[1\]\.name: duplicate service name "web"/,
  );
});

test("compilePlan: runtime commands must be non-empty argv arrays", () => {
  rejectsRuntime(
    { services: [{ name: "web", command: "node server.cjs" }] },
    /tasks\[0\]\.runtime\.services\[0\]\.command: must be an argv string\[\]; shell command strings are not allowed/,
  );
  rejectsRuntime(
    { services: [{ name: "web", command: [] }] },
    /runtime\.services\[0\]\.command: must be a non-empty argv string\[\]/,
  );
  rejectsRuntime(
    { services: [{ name: "web" }] },
    /runtime\.services\[0\]\.command: must be a non-empty argv string\[\]/,
  );
  rejectsRuntime(
    { services: [{ name: "web", command: ["node", ""] }] },
    /runtime\.services\[0\]\.command\[1\]: must be a non-empty string/,
  );
  rejectsRuntime(
    { services: [{ name: "web", command: ["node", 42] }] },
    /runtime\.services\[0\]\.command\[1\]: must be a non-empty string/,
  );
});

test("compilePlan: runtime cwd must stay inside the repository", () => {
  for (const cwd of [
    "",
    "/etc",
    "/tmp/web",
    "../outside",
    "services/../../outside",
    "C:\\Windows",
    "\\\\server\\share",
  ]) {
    rejectsRuntime(
      { services: [{ name: "web", command: ["node", "server.cjs"], cwd }] },
      /tasks\[0\]\.runtime\.services\[0\]\.cwd/,
    );
  }
});

test("compilePlan: runtime environment variable names must be safe", () => {
  for (const field of ["portEnv", "urlEnv"] as const) {
    for (const name of [
      "",
      "1PORT",
      "PORT-NAME",
      "PORT NAME",
      "PORT=1",
      "PORT.NAME",
    ]) {
      rejectsRuntime(
        {
          services: [
            { name: "web", command: ["node", "server.cjs"], [field]: name },
          ],
        },
        new RegExp(
          `tasks\\[0\\]\\.runtime\\.services\\[0\\]\\.${field}`,
        ),
      );
    }
  }
});

test("compilePlan: readiness values must be positive", () => {
  const withReadiness = (readiness: unknown) => ({
    services: [{ name: "web", command: ["node", "server.cjs"], readiness }],
  });

  for (const timeoutMs of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, "5000"]) {
    rejectsRuntime(
      withReadiness({ timeoutMs }),
      /runtime\.services\[0\]\.readiness\.timeoutMs: must be a positive number of milliseconds/,
    );
  }
  for (const expectedStatus of [0, -1, 200.5, "200"]) {
    rejectsRuntime(
      withReadiness({ expectedStatus }),
      /runtime\.services\[0\]\.readiness\.expectedStatus: must be a positive integer HTTP status/,
    );
  }
  for (const path of ["", "health", "/health check"]) {
    rejectsRuntime(
      withReadiness({ path }),
      /runtime\.services\[0\]\.readiness\.path: must be a URL path/,
    );
  }
  rejectsRuntime(
    withReadiness("healthy"),
    /runtime\.services\[0\]\.readiness: must be an object/,
  );
});

test("compilePlan: malformed runtime containers fail before dispatch", () => {
  rejectsRuntime(
    "node server.cjs",
    /tasks\[0\]\.runtime: must be an object/,
  );
  rejectsRuntime(
    { services: [] },
    /tasks\[0\]\.runtime\.services: must be a non-empty array/,
  );
  rejectsRuntime(
    {},
    /tasks\[0\]\.runtime\.services: must be a non-empty array/,
  );
  rejectsRuntime(
    { services: ["web"] },
    /tasks\[0\]\.runtime\.services\[0\]: must be an object/,
  );
});

test("validateContract/loadContractJson: runtime validation is not plan-only", () => {
  const raw = {
    taskId: "web-runtime",
    version: 1,
    frozen: true,
    goals: ["Expose a verified health endpoint"],
    dependsOn: [],
    readPaths: ["."],
    writePaths: ["src/server.ts"],
    sharedResources: [],
    baseCommit: base,
    verifyCommands: ["test -f src/server.ts"],
    maxRepairs: 0,
  };

  const ok = validateContract({ ...raw, runtime: validRuntime });
  assert.equal(ok.ok, true);
  if (!ok.ok) return;
  assert.deepEqual(ok.contract.runtime, validRuntime);

  const bad = validateContract({
    ...raw,
    runtime: {
      services: [{ name: "web", command: "node server.cjs" }],
    },
  });
  assert.equal(bad.ok, false);
  if (bad.ok) return;
  assert.ok(
    bad.issues.some(
      (issue) =>
        issue.path === "runtime.services[0].command" &&
        /shell command strings/.test(issue.message),
    ),
  );

  assert.throws(
    () =>
      loadContractJson(
        JSON.stringify({
          ...raw,
          runtime: { services: [{ name: "web", command: [] }] },
        }),
      ),
    /invalid TaskContract: runtime\.services\[0\]\.command/,
  );
});

test("validateContract: legacy contracts keep the 30-second timeout default", () => {
  assert.equal(DEFAULT_VERIFY_TIMEOUT_MS, 30_000);

  const result = validateContract(baseContractRaw());
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.contract.verifyTimeoutMs, undefined);
  assert.equal(Object.hasOwn(result.contract, "verifyTimeoutMs"), false);
  assert.equal(
    JSON.stringify(result.contract).includes('"verifyTimeoutMs"'),
    false,
  );
});

test("validateContract: verifyTimeoutMs accepts the documented bounds", () => {
  for (const value of [1, DEFAULT_VERIFY_TIMEOUT_MS, MAX_VERIFY_TIMEOUT_MS]) {
    const result = validateContract({
      ...baseContractRaw(),
      verifyTimeoutMs: value,
    });
    assert.equal(result.ok, true, `expected ${value} to validate`);
    if (!result.ok) continue;
    assert.equal(result.contract.verifyTimeoutMs, value);
  }
});

test("validateContract: invalid verifyTimeoutMs values fail validation", () => {
  for (const value of [
    0,
    -1,
    1.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.MAX_SAFE_INTEGER,
    MAX_VERIFY_TIMEOUT_MS + 1,
    "5000",
  ]) {
    const result = validateContract({
      ...baseContractRaw(),
      verifyTimeoutMs: value,
    });
    assert.equal(result.ok, false, `expected ${String(value)} to fail`);
    if (result.ok) continue;
    assert.ok(
      result.issues.some(
        (issue) =>
          issue.path === "verifyTimeoutMs" &&
          /positive safe integer/.test(issue.message),
      ),
      `unexpected issues: ${JSON.stringify(result.issues)}`,
    );
  }
});

test("loadContractJson: verifyTimeoutMs and runtime survive a round-trip", () => {
  const validated = validateContract({
    ...baseContractRaw(),
    verifyTimeoutMs: 120_000,
    runtime: validRuntime,
  });
  assert.equal(validated.ok, true);
  if (!validated.ok) return;

  const loaded = loadContractJson(JSON.stringify(validated.contract));
  assert.equal(loaded.verifyTimeoutMs, 120_000);
  assert.deepEqual(loaded.runtime, validRuntime);
});

function taskPlanWithExecution(execution: unknown): Record<string, unknown> {
  const plan = taskPlan();
  (plan.tasks as Record<string, unknown>[])[0]!.execution = execution;
  return plan;
}

function compileWithExecution(execution: unknown) {
  return compilePlan(taskPlanWithExecution(execution), { baseCommit: base });
}

test("compilePlan: execution.continuity is preserved through the contract", () => {
  const expected = ["fail-closed", "durable"] as const;
  assert.deepEqual(EXECUTION_CONTINUITY_POLICIES, expected);
  assert.equal(DEFAULT_EXECUTION_CONTINUITY, "fail-closed");

  for (const continuity of expected) {
    const compiled = compileWithExecution({ continuity });
    const contract = compiled.contracts[0]!;
    assert.deepEqual(contract.execution, { continuity });
    assert.equal(executionContinuity(contract), continuity);

    const document = JSON.parse(
      JSON.stringify(makeContractDocument(compiled)),
    ) as { contracts: { execution?: unknown }[] };
    assert.deepEqual(document.contracts[0]!.execution, { continuity });

    const revalidated = validateContract(contract);
    assert.equal(revalidated.ok, true);
    if (!revalidated.ok) continue;
    assert.deepEqual(revalidated.contract.execution, { continuity });

    const loaded = loadContractJson(JSON.stringify(contract));
    assert.deepEqual(loaded.execution, { continuity });
  }
});

test("compilePlan: contracts without execution stay legacy fail-closed", () => {
  const compiled = compileWithRuntime();
  const contract = compiled.contracts[0]!;
  assert.equal(Object.hasOwn(contract, "execution"), false);
  assert.equal("execution" in contract, false);
  assert.equal(executionContinuity(contract), "fail-closed");
  assert.equal(executionContinuity(undefined), "fail-closed");
  assert.equal(JSON.stringify(contract).includes('"execution"'), false);

  const loaded = loadContractJson(JSON.stringify(contract));
  assert.equal(Object.hasOwn(loaded, "execution"), false);
  assert.equal(executionContinuity(loaded), "fail-closed");
});

test("compilePlan: invalid execution.continuity fails validation", () => {
  const rejects = (execution: unknown, expected: RegExp): void => {
    assert.throws(
      () => compileWithExecution(execution),
      (error: unknown) => {
        assert.ok(error instanceof PlanValidationError);
        assert.match(error.message, expected);
        return true;
      },
    );
  };

  rejects("durable", /tasks\[0\]\.execution: must be an object/);
  rejects([], /tasks\[0\]\.execution: must be an object/);
  rejects({}, /tasks\[0\]\.execution\.continuity: is required/);
  rejects(
    { continuity: "eventual" },
    /tasks\[0\]\.execution\.continuity: must be one of fail-closed, durable/,
  );
  rejects(
    { continuity: 1 },
    /tasks\[0\]\.execution\.continuity: must be one of fail-closed, durable/,
  );
  rejects(
    { continuity: "durable " },
    /tasks\[0\]\.execution\.continuity: must be one of fail-closed, durable/,
  );
});

test("validateContract/loadContractJson: continuity is not plan-only", () => {
  const ok = validateContract({
    ...baseContractRaw(),
    execution: { continuity: "durable" },
  });
  assert.equal(ok.ok, true);
  if (!ok.ok) return;
  assert.deepEqual(ok.contract.execution, { continuity: "durable" });

  const invalid = validateContract({
    ...baseContractRaw(),
    execution: { continuity: "best-effort" },
  });
  assert.equal(invalid.ok, false);
  if (invalid.ok) return;
  assert.ok(
    invalid.issues.some(
      (issue) =>
        issue.path === "execution.continuity" &&
        /must be one of fail-closed, durable/.test(issue.message),
    ),
  );

  assert.throws(
    () =>
      loadContractJson(
        JSON.stringify({
          ...baseContractRaw(),
          execution: { continuity: "" },
        }),
      ),
    /invalid TaskContract: execution\.continuity/,
  );

  // A legacy contract still resolves to fail-closed without being rewritten.
  const legacy = validateContract(baseContractRaw());
  assert.equal(legacy.ok, true);
  if (!legacy.ok) return;
  assert.equal(executionContinuity(legacy.contract), "fail-closed");
  assert.equal(Object.hasOwn(legacy.contract, "execution"), false);
});

test("taskFileToContracts: continuity default is opt-in", () => {
  const taskFile = {
    repo: "target",
    tasks: [
      {
        id: "imported",
        prompt: "Implement the imported task",
        paths: ["src/a.ts"],
      },
    ],
  };

  const [legacy] = taskFileToContracts(taskFile);
  assert.equal(Object.hasOwn(legacy!, "execution"), false);
  assert.equal(executionContinuity(legacy), "fail-closed");

  const [durable] = taskFileToContracts(taskFile, { continuity: "durable" });
  assert.deepEqual(durable!.execution, { continuity: "durable" });
  assert.equal(executionContinuity(durable), "durable");

  const [failClosed] = taskFileToContracts(taskFile, {
    continuity: "fail-closed",
  });
  assert.deepEqual(failClosed!.execution, { continuity: "fail-closed" });

  assert.throws(
    () =>
      taskFileToContracts(taskFile, {
        continuity: "best-effort" as never,
      }),
    /execution\.continuity: must be one of fail-closed, durable/,
  );
});

test("taskFileToContracts: verifyTimeoutMs default is opt-in", () => {
  const taskFile = {
    repo: "target",
    tasks: [
      {
        id: "imported",
        prompt: "Implement the imported task",
        paths: ["src/a.ts"],
      },
    ],
  };

  const [legacy] = taskFileToContracts(taskFile);
  assert.equal(Object.hasOwn(legacy!, "verifyTimeoutMs"), false);

  const [bounded] = taskFileToContracts(taskFile, {
    verifyTimeoutMs: 120_000,
  });
  assert.equal(bounded!.verifyTimeoutMs, 120_000);

  assert.throws(
    () => taskFileToContracts(taskFile, { verifyTimeoutMs: 0 }),
    /verifyTimeoutMs: must be a positive safe integer/,
  );
});

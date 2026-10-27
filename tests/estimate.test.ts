import { test } from "node:test";
import assert from "node:assert/strict";
import { estimatePlan, estimateTask } from "../src/planner/estimate.js";
import type { TaskContract } from "../src/contracts/schema.js";

const contract: TaskContract = {
  taskId: "component-task",
  version: 1,
  frozen: true,
  goals: [
    "Implement a Vue component wrapper with loading, disabled, hover and focus states plus a Lab demo",
  ],
  dependsOn: [],
  readPaths: ["README.md", "design/foundation.md", "src/tokens.css"],
  writePaths: ["src/components/Card.vue", "src/demos/CardDemo.vue"],
  sharedResources: [],
  baseCommit: "HEAD",
  verifyCommands: ["test -f src/components/Card.vue", "npm run build"],
  maxRepairs: 1,
};

test("estimateTask classifies a component plus demo as a dispatchable large task", () => {
  const result = estimateTask(contract);
  assert.equal(result.size, "L");
  assert.ok(result.guardBudgetUsd >= 8);
  assert.ok(result.turns.min >= 35);
  assert.ok(result.drivers.includes("component implementation"));
  assert.ok(result.drivers.includes("demo/lab coverage"));
});

test("estimatePlan returns aggregate budget and public-price reference ranges", () => {
  const result = estimatePlan({
    planId: "estimate-fixture",
    tasks: [
      {
        taskId: "doc",
        goal: "Update one documentation file",
        writePaths: ["README.md"],
        verifyCommands: ["test -f README.md"],
      },
      {
        taskId: "card",
        goal: contract.goals[0],
        readPaths: contract.readPaths,
        writePaths: contract.writePaths,
        verifyCommands: contract.verifyCommands,
      },
    ],
  });
  assert.equal(result.planId, "estimate-fixture");
  assert.equal(result.tasks.length, 2);
  assert.ok(result.totalGuardBudgetUsd > result.tasks[0]!.guardBudgetUsd);
  assert.ok(
    result.totalApiCostCnyPeak.max >=
      result.totalApiCostCnyOffPeak.max,
  );
  assert.deepEqual(result.pricingReference, {
    state: "public-reference",
    provider: "deepseek",
    model: "deepseek-flash",
    currency: "CNY",
    appliesToCurrentBinding: false,
    balanceIncluded: false,
    observedAt: null,
  });
  assert.ok(
    result.notes.some((note) =>
      note.includes("not current subscription pricing"),
    ),
  );
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { estimatePlan, estimateTask } from "../src/planner/estimate.js";
import {
  calibrateGuardUsd,
  ESTIMATE_COST_SAMPLES,
  ESTIMATE_GUARD_MARGIN,
  ESTIMATE_GUARD_MIN_SAMPLES,
  percentile,
  STATIC_GUARD_FLOOR_USD,
  type EstimateCostSample,
} from "../src/planner/estimate-telemetry.js";
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
  assert.equal(result.calibration.basis, "telemetry-p75-margin");
  assert.ok(result.calibration.sampleSize >= ESTIMATE_GUARD_MIN_SAMPLES);
  assert.equal(result.calibration.margin, ESTIMATE_GUARD_MARGIN);
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
    result.totalApiCostCnyPeak.max >= result.totalApiCostCnyOffPeak.max,
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
  assert.equal(result.calibration.margin, ESTIMATE_GUARD_MARGIN);
  assert.equal(result.calibration.taskSummaries.length, 2);
});

test("percentile P75 interpolates on curated amounts", () => {
  assert.equal(percentile([1, 2, 3, 4], 75), 3.25);
  assert.equal(percentile([10], 75), 10);
  assert.equal(percentile([], 75), null);
});

test("calibrateGuardUsd uses P75 times margin for a well-sampled size", () => {
  const amounts = ESTIMATE_COST_SAMPLES.filter((sample) => sample.size === "L").map(
    (sample) => sample.cliEstimatedUsd,
  );
  assert.ok(amounts.length >= ESTIMATE_GUARD_MIN_SAMPLES);
  const p75 = percentile(amounts, 75);
  assert.ok(p75 !== null);
  const expected = Math.max(
    STATIC_GUARD_FLOOR_USD.L,
    Math.round(p75! * ESTIMATE_GUARD_MARGIN * 100) / 100,
  );

  const calibrated = calibrateGuardUsd("L");
  assert.equal(calibrated.basis, "telemetry-p75-margin");
  assert.equal(calibrated.guardBudgetUsd, expected);
  assert.equal(calibrated.p75Usd, Math.round(p75! * 100) / 100);
  assert.ok(calibrated.sampleSize >= ESTIMATE_GUARD_MIN_SAMPLES);
  assert.ok(["medium", "high"].includes(calibrated.confidence));
  assert.ok(calibrated.evidencePaths.length > 0);
  assert.ok(
    calibrated.evidencePaths.every((path) => path.startsWith("docs/")),
  );
});

test("calibrateGuardUsd keeps the static floor when a size is under-sampled", () => {
  const sparse: EstimateCostSample[] = [
    {
      id: "only-xl",
      size: "XL",
      cliEstimatedUsd: 12.00335,
      authoritative: false,
      source: "cli",
      evidencePath: "docs/evidence/STATESTORE_WRITE_CUTOVER.md",
    },
  ];
  const calibrated = calibrateGuardUsd("XL", { samples: sparse });
  assert.equal(calibrated.basis, "static-floor-cold-start");
  assert.equal(calibrated.usedStaticFloor, true);
  assert.equal(calibrated.confidence, "low");
  assert.equal(calibrated.sampleSize, 1);
  assert.equal(calibrated.guardBudgetUsd, STATIC_GUARD_FLOOR_USD.XL);
});

test("catalog samples are explicitly non-authoritative CLI observations", () => {
  assert.ok(ESTIMATE_COST_SAMPLES.length > 0);
  for (const sample of ESTIMATE_COST_SAMPLES) {
    assert.equal(sample.authoritative, false);
    assert.equal(sample.source, "cli");
    assert.ok(sample.cliEstimatedUsd > 0);
    assert.ok(sample.evidencePath.length > 0);
  }
});

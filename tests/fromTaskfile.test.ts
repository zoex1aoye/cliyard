import { test } from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  loadTaskFileAsContracts,
  taskFileToContracts,
} from "../src/contracts/fromTaskfile.js";
import { loadTaskFile } from "../src/taskfile.js";
import { validateContract } from "../src/contracts/schema.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const exampleYaml = resolve(root, "examples/module.tasks.yaml");

test("loadTaskFileAsContracts: module.tasks.yaml → 3 valid contracts", () => {
  const contracts = loadTaskFileAsContracts(exampleYaml);
  assert.equal(contracts.length, 3);
  assert.deepEqual(
    contracts.map((c) => c.taskId),
    ["api", "web", "tests"],
  );

  for (const c of contracts) {
    const again = validateContract(c);
    assert.equal(again.ok, true);
    assert.equal(c.version, 1);
    assert.equal(c.frozen, true);
    assert.equal(c.baseCommit, "HEAD");
    assert.equal(c.maxRepairs, 2);
    assert.deepEqual(c.dependsOn, []);
    assert.deepEqual(c.verifyCommands, []);
    assert.ok(c.writePaths.length >= 1);
    assert.ok(c.goals.length >= 1);
    assert.ok(c.readPaths.includes("docs/reqs/module.md"));
  }

  assert.deepEqual(contracts[0].writePaths, ["src/api/"]);
  assert.deepEqual(contracts[1].writePaths, ["src/web/"]);
  assert.deepEqual(contracts[2].writePaths, ["tests/"]);
});

test("taskFileToContracts: custom verifyCommands / maxRepairs options", () => {
  const file = loadTaskFile(exampleYaml);
  const [api] = taskFileToContracts(file, {
    verifyCommands: ["npm test"],
    maxRepairs: 0,
  });
  assert.deepEqual(api.verifyCommands, ["npm test"]);
  assert.equal(api.maxRepairs, 0);
  assert.match(api.goals[0], /Implement the backend/);
});

test("taskFileToContracts: empty paths → validate error", () => {
  const file = loadTaskFile(exampleYaml);
  file.tasks[0].paths = [];
  assert.throws(
    () => taskFileToContracts(file),
    /writePaths/,
  );
});

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  findCycle,
  readyIds,
  topologicalOrder,
  type DagNode,
} from "../src/scheduler/dag.js";

const twoTaskFixture: DagNode[] = [
  { id: "api", dependsOn: [] },
  { id: "web", dependsOn: ["api"] },
];

test("readyIds: with empty done, only roots are ready", () => {
  assert.deepEqual(readyIds(twoTaskFixture, new Set()), ["api"]);
});

test("readyIds: after api done, web becomes ready", () => {
  assert.deepEqual(readyIds(twoTaskFixture, new Set(["api"])), ["web"]);
});

test("readyIds: done tasks are not re-listed", () => {
  assert.deepEqual(
    readyIds(twoTaskFixture, new Set(["api", "web"])),
    [],
  );
});

test("readyIds: three-task diamond — both middles after root", () => {
  const nodes: DagNode[] = [
    { id: "root", dependsOn: [] },
    { id: "a", dependsOn: ["root"] },
    { id: "b", dependsOn: ["root"] },
    { id: "leaf", dependsOn: ["a", "b"] },
  ];
  assert.deepEqual(readyIds(nodes, new Set()), ["root"]);
  assert.deepEqual(readyIds(nodes, new Set(["root"])), ["a", "b"]);
  assert.deepEqual(readyIds(nodes, new Set(["root", "a"])), ["b"]);
  assert.deepEqual(readyIds(nodes, new Set(["root", "a", "b"])), ["leaf"]);
});

test("findCycle: acyclic returns ok", () => {
  assert.deepEqual(findCycle(twoTaskFixture), { ok: true });
});

test("findCycle: simple cycle detected", () => {
  const nodes: DagNode[] = [
    { id: "a", dependsOn: ["b"] },
    { id: "b", dependsOn: ["a"] },
  ];
  const r = findCycle(nodes);
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.ok(r.cycle.length >= 3);
    assert.equal(r.cycle[0], r.cycle[r.cycle.length - 1]);
  }
});

test("readyIds throws on cycle", () => {
  const nodes: DagNode[] = [
    { id: "a", dependsOn: ["b"] },
    { id: "b", dependsOn: ["a"] },
  ];
  assert.throws(() => readyIds(nodes, new Set()), /cycle/);
});

test("topologicalOrder: api before web", () => {
  assert.deepEqual(topologicalOrder(twoTaskFixture), ["api", "web"]);
});

test("topologicalOrder: unknown dependency throws", () => {
  assert.throws(
    () => topologicalOrder([{ id: "web", dependsOn: ["missing"] }]),
    /unknown dependency/,
  );
});

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  assertTransition,
  canTransition,
  isTerminal,
} from "../src/core/status.js";

test("canTransition ready→running returns true", () => {
  assert.equal(canTransition("ready", "running"), true);
});

test("canTransition accepted→running returns false", () => {
  assert.equal(canTransition("accepted", "running"), false);
});

test("isTerminal accepted returns true", () => {
  assert.equal(isTerminal("accepted"), true);
});

test("assertTransition ready→rejected throws", () => {
  assert.throws(
    () => assertTransition("ready", "rejected"),
    /illegal status transition: ready → rejected/,
  );
});

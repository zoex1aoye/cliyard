import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  assertLocalCliTaskContract,
  validateLocalCliTaskContract,
} from "../src/mvp/index.js";

const FIXTURE = join(
  process.cwd(),
  "examples/mvp/code-local-cli.mock.contract.json",
);

test("code local-cli mock fixture validates", () => {
  const raw = JSON.parse(readFileSync(FIXTURE, "utf8"));
  const result = validateLocalCliTaskContract(raw);
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.contract.contractId, "mvp-echo-worktree");
    assert.equal(result.contract.driver.kind, "local-cli");
    assert.equal(result.contract.driver.target, "custom:echo-ok");
  }
});

test("rejects absolute driver.target", () => {
  const raw = JSON.parse(readFileSync(FIXTURE, "utf8"));
  raw.driver.target = "/usr/bin/claude";
  const result = validateLocalCliTaskContract(raw);
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.ok(
      result.issues.some(
        (i) =>
          i.path === "driver.target" && /absolute|registry/i.test(i.message),
      ),
    );
  }
});

test("rejects git-worktree without baseRef", () => {
  const raw = JSON.parse(readFileSync(FIXTURE, "utf8"));
  delete raw.workspace.baseRef;
  assert.throws(
    () => assertLocalCliTaskContract(raw),
    /workspace\.baseRef/,
  );
});

test("rejects empty writeRoots", () => {
  const raw = JSON.parse(readFileSync(FIXTURE, "utf8"));
  raw.workspace.writeRoots = [];
  const result = validateLocalCliTaskContract(raw);
  assert.equal(result.ok, false);
});

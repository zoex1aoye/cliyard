import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  assertFrozenImmutable,
  compileMvpPlan,
  freezeContract,
  loadContractFile,
  runIdleSpin,
  writeFrozenContract,
} from "../src/mvp/index.js";

test("compileMvpPlan emits unfrozen drafts", () => {
  const plan = JSON.parse(
    readFileSync(resolve("examples/mvp/echo.plan.json"), "utf8"),
  );
  const { planId, drafts } = compileMvpPlan(plan);
  assert.equal(planId, "mvp-echo-plan");
  assert.equal(drafts.length, 1);
  assert.equal(drafts[0]!.frozen, false);
  assert.equal(drafts[0]!.contractId, "mvp-echo-from-plan");
  assert.equal(drafts[0]!.frozenAt, undefined);
});

test("freeze writes frozenAt + sha256; tamper fails closed", () => {
  const dir = mkdtempSync(join(tmpdir(), "mvp-freeze-"));
  try {
    const plan = JSON.parse(
      readFileSync(resolve("examples/mvp/echo.plan.json"), "utf8"),
    );
    const { drafts } = compileMvpPlan(plan);
    const frozen = freezeContract(drafts[0], {
      frozenAt: "2026-11-08T13:30:00Z",
    });
    assert.equal(frozen.frozen, true);
    assert.equal(frozen.frozenAt, "2026-11-08T13:30:00Z");
    const out = join(dir, "echo.frozen.contract.json");
    const written = writeFrozenContract({ contract: frozen, outPath: out });
    assert.match(written.sha256, /^[0-9a-f]{64}$/);
    assert.equal(
      readFileSync(written.hashPath, "utf8").trim(),
      written.sha256,
    );
    const ok = assertFrozenImmutable(out);
    assert.equal(ok.checked, true);

    // Silent mutate bytes → hash mismatch.
    const mutated = JSON.parse(readFileSync(out, "utf8"));
    mutated.intent.goal = "tampered";
    writeFileSync(out, `${JSON.stringify(mutated, null, 2)}\n`, "utf8");
    assert.throws(
      () => assertFrozenImmutable(out),
      /bytes changed without re-freeze/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("idle-spin refuses unfrozen draft contract", async () => {
  const plan = JSON.parse(
    readFileSync(resolve("examples/mvp/echo.plan.json"), "utf8"),
  );
  const { drafts } = compileMvpPlan(plan);
  const repo = mkdtempSync(join(tmpdir(), "mvp-unfrozen-"));
  try {
    await assert.rejects(
      () =>
        runIdleSpin({
          repoRoot: repo,
          contract: drafts[0]!,
        }),
      /frozen=true/,
    );
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("loadContractFile accepts legacy frozen fixture without sidecar", () => {
  const contract = loadContractFile(
    resolve("examples/mvp/code-local-cli.mock.contract.json"),
  );
  assert.equal(contract.frozen, true);
  assert.equal(contract.contractId, "mvp-echo-worktree");
});

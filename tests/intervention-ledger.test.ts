import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  INTERVENTION_ROLES,
  InterventionLedgerError,
  InterventionSanitizeError,
  listInterventions,
  loadIntervention,
  recordIntervention,
  resolveIntervention,
} from "../src/intervention/index.js";

test("records all six intervention roles as unresolved", () => {
  const repo = mkdtempSync(join(tmpdir(), "cliyard-iv-"));
  try {
    for (const role of INTERVENTION_ROLES) {
      const event = recordIntervention({
        repoRoot: repo,
        loopId: "loop-1",
        role,
        reason: `human ${role} for fixture`,
        runId: "run-1",
        id: `iv-${role}`,
        now: () => "2026-11-07T14:00:00.000Z",
      });
      assert.equal(event.role, role);
      assert.equal(event.outcome, "unresolved");
      assert.equal(loadIntervention(repo, event.id)?.role, role);
    }
    assert.equal(listInterventions(repo).length, 6);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("resolve allows unresolved → resolved|rejected|obsolete only once", () => {
  const repo = mkdtempSync(join(tmpdir(), "cliyard-iv-"));
  try {
    recordIntervention({
      repoRoot: repo,
      loopId: "loop-2",
      role: "approve",
      reason: "human approved the Plan",
      id: "iv-approve-1",
      now: () => "2026-11-07T14:00:00.000Z",
    });
    const resolved = resolveIntervention({
      repoRoot: repo,
      id: "iv-approve-1",
      outcome: "resolved",
      note: "plan hash frozen",
      now: () => "2026-11-07T14:05:00.000Z",
    });
    assert.equal(resolved.outcome, "resolved");
    assert.equal(resolved.resolvedAt, "2026-11-07T14:05:00.000Z");
    assert.throws(
      () =>
        resolveIntervention({
          repoRoot: repo,
          id: "iv-approve-1",
          outcome: "rejected",
        }),
      (e: unknown) =>
        e instanceof InterventionLedgerError &&
        /cannot resolve/.test(e.message),
    );
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("refuses secret-like reasons", () => {
  const repo = mkdtempSync(join(tmpdir(), "cliyard-iv-"));
  try {
    assert.throws(
      () =>
        recordIntervention({
          repoRoot: repo,
          loopId: "loop-3",
          role: "retry",
          reason: "retry with Bearer sk-abcdefghijklmnopqrstuvwxyz",
        }),
      (e: unknown) => e instanceof InterventionSanitizeError,
    );
    assert.throws(
      () =>
        recordIntervention({
          repoRoot: repo,
          loopId: "loop-3",
          role: "trigger",
          reason: "api_key=sk-proj-abcdefghijklmnopqrstuvwxyz",
        }),
      (e: unknown) => e instanceof InterventionSanitizeError,
    );
    assert.equal(listInterventions(repo).length, 0);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("refuses invalid role and empty reason", () => {
  const repo = mkdtempSync(join(tmpdir(), "cliyard-iv-"));
  try {
    assert.throws(
      () =>
        recordIntervention({
          repoRoot: repo,
          loopId: "loop-4",
          role: "merge" as never,
          reason: "nope",
        }),
      (e: unknown) => e instanceof InterventionLedgerError,
    );
    assert.throws(
      () =>
        recordIntervention({
          repoRoot: repo,
          loopId: "loop-4",
          role: "judge",
          reason: "   ",
        }),
      (e: unknown) => e instanceof InterventionSanitizeError,
    );
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

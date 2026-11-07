import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ProfileCatalogError,
  UNKNOWN_EXECUTION_PROFILE_PERMIT,
  activateProfile,
  admitHierarchical,
  effectiveProfilePermit,
  getBindingCapacity,
  getProfile,
  listProfiles,
  removeProfile,
  setBindingCapacity,
} from "../src/admission/index.js";
import type { ExecutionProfile } from "../src/execution/profile.js";

function sampleProfile(
  overrides: Partial<ExecutionProfile> = {},
): ExecutionProfile {
  return {
    version: 1,
    profileId: "claude-deepseek-flash",
    runtimeId: "claude",
    modelId: "deepseek-flash",
    providerId: "deepseek",
    endpointRef: "deepseek-claude-default",
    capabilities: {
      mappedProgress: true,
      providerSessionResume: true,
    },
    ...overrides,
  };
}

test("activateProfile persists secret-free profiles; unknown capacity ⇒ permit 1", () => {
  const repo = mkdtempSync(join(tmpdir(), "cliyard-adm-"));
  try {
    const catalog = activateProfile({
      repoRoot: repo,
      profile: sampleProfile(),
      now: () => "2026-11-07T15:00:00.000Z",
    });
    assert.equal(catalog.profiles.length, 1);
    assert.equal(getProfile(repo, "claude-deepseek-flash")?.modelId, "deepseek-flash");
    assert.deepEqual(listProfiles(repo).map((p) => p.profileId), [
      "claude-deepseek-flash",
    ]);

    const cap = getBindingCapacity(repo, "claude-deepseek-flash");
    assert.equal(cap?.configuredMax, null);
    assert.equal(cap?.limitSource, "unknown");
    assert.equal(effectiveProfilePermit(cap ?? undefined), UNKNOWN_EXECUTION_PROFILE_PERMIT);
    assert.equal(UNKNOWN_EXECUTION_PROFILE_PERMIT, 1);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("refuses secret-bearing / URL endpoint and removes profiles", () => {
  const repo = mkdtempSync(join(tmpdir(), "cliyard-adm-"));
  try {
    assert.throws(
      () =>
        activateProfile({
          repoRoot: repo,
          profile: {
            ...sampleProfile(),
            endpointRef: "https://api.example.com/v1",
          },
        }),
      (err: unknown) =>
        err instanceof ProfileCatalogError &&
        /secret-bearing|invalid/.test(err.message),
    );

    activateProfile({
      repoRoot: repo,
      profile: sampleProfile({ profileId: "keep-me" }),
    });
    activateProfile({
      repoRoot: repo,
      profile: sampleProfile({
        profileId: "drop-me",
        modelId: "deepseek-flash",
      }),
    });
    removeProfile(repo, "drop-me");
    assert.equal(getProfile(repo, "drop-me"), null);
    assert.equal(listProfiles(repo).length, 1);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("admitHierarchical takes conjunctive min; unknown ≠ infinity", () => {
  const denied = admitHierarchical({
    scopes: [
      { name: "globalTasks", limit: 4, inUse: 1 },
      { name: "itemTasks", limit: 2, inUse: 0 },
      { name: "profilePermit", limit: 1, inUse: 0 },
    ],
    request: 2,
  });
  assert.equal(denied.admitted, false);
  assert.equal(denied.limitingScope, "profilePermit");
  assert.equal(denied.effective, 1);

  const admitted = admitHierarchical({
    scopes: [
      { name: "globalTasks", limit: 4, inUse: 1 },
      { name: "itemTasks", limit: 2, inUse: 0 },
      { name: "profilePermit", limit: 1, inUse: 0 },
    ],
    request: 1,
  });
  assert.equal(admitted.admitted, true);
  assert.equal(admitted.limitingScope, "profilePermit");
  assert.equal(admitted.remaining, 1);

  const allUnknown = admitHierarchical({
    scopes: [
      { name: "hostCpu", limit: null, inUse: 0 },
      { name: "hostMemory", limit: null, inUse: 0 },
    ],
  });
  assert.equal(allUnknown.admitted, false);
  assert.match(allUnknown.reasons.join("\n"), /unknown ≠ unlimited|not treated as infinity/);
});

test("setBindingCapacity upgrades unknown to operator max; warm-start 3 is not hard-coded", () => {
  const repo = mkdtempSync(join(tmpdir(), "cliyard-adm-"));
  try {
    activateProfile({
      repoRoot: repo,
      profile: sampleProfile(),
    });
    const upgraded = setBindingCapacity({
      repoRoot: repo,
      profileId: "claude-deepseek-flash",
      configuredMax: 5,
      limitSource: "operator",
    });
    assert.equal(upgraded.configuredMax, 5);
    assert.equal(effectiveProfilePermit(upgraded), 5);

    // Admission must not embed a permanent product constant of 3.
    const decision = admitHierarchical({
      scopes: [
        {
          name: "profilePermit",
          limit: effectiveProfilePermit(upgraded),
          inUse: 0,
        },
        { name: "globalTasks", limit: 10, inUse: 0 },
      ],
      request: 3,
    });
    assert.equal(decision.admitted, true);
    assert.equal(decision.effective, 5);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

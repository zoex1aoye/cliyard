import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  activateProfile,
  appendRoutingDecision,
  readRoutingDecisions,
  selectExecutionProfile,
  setBindingCapacity,
} from "../src/admission/index.js";
import type { ExecutionProfile } from "../src/execution/profile.js";

const CLAUDE: ExecutionProfile = {
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
};

const CODEX: ExecutionProfile = {
  version: 1,
  profileId: "codex-deepseek-v4",
  runtimeId: "codex",
  modelId: "deepseek-v4-pro",
  providerId: "deepseek",
  endpointRef: "deepseek-codex-default",
  capabilities: {
    mappedProgress: false,
    providerSessionResume: false,
  },
};

test("selectExecutionProfile fail-closed on empty catalog", () => {
  const repo = mkdtempSync(join(tmpdir(), "cliyard-route-"));
  try {
    const decision = selectExecutionProfile({ repoRoot: repo });
    assert.equal(decision.code, "no_activated_profiles");
    assert.equal(decision.selected, null);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("capability filter prefers claude when resume required; stable tie-break", () => {
  const repo = mkdtempSync(join(tmpdir(), "cliyard-route-"));
  try {
    activateProfile({ repoRoot: repo, profile: CODEX });
    activateProfile({ repoRoot: repo, profile: CLAUDE });

    const needResume = selectExecutionProfile({
      repoRoot: repo,
      requirements: { requireProviderSessionResume: true },
    });
    assert.equal(needResume.code, "selected");
    assert.equal(needResume.selected?.profileId, "claude-deepseek-flash");
    assert.ok(
      needResume.candidates.some(
        (c) => c.profileId === "codex-deepseek-v4" && c.excluded,
      ),
    );

    const preferredCodex = selectExecutionProfile({
      repoRoot: repo,
      requirements: { preferredRuntimeId: "codex" },
    });
    assert.equal(preferredCodex.selected?.profileId, "codex-deepseek-v4");
    assert.equal(
      preferredCodex.candidates.find((c) => c.profileId === "codex-deepseek-v4")
        ?.score,
      4,
    );

    // No preferences: lexicographic profileId among equal scores.
    const any = selectExecutionProfile({ repoRoot: repo });
    assert.equal(any.code, "selected");
    assert.equal(any.selected?.profileId, "claude-deepseek-flash");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("respectAdmission skips zero-remaining profiles", () => {
  const repo = mkdtempSync(join(tmpdir(), "cliyard-route-"));
  try {
    activateProfile({ repoRoot: repo, profile: CLAUDE });
    activateProfile({ repoRoot: repo, profile: CODEX });
    setBindingCapacity({
      repoRoot: repo,
      profileId: CLAUDE.profileId,
      configuredMax: 1,
      limitSource: "operator",
      inFlight: 1,
    });

    const denied = selectExecutionProfile({
      repoRoot: repo,
      requirements: { requireMappedProgress: true },
      respectAdmission: true,
    });
    assert.equal(denied.code, "no_capacity");
    assert.equal(denied.selected, null);

    const fallback = selectExecutionProfile({
      repoRoot: repo,
      respectAdmission: true,
    });
    assert.equal(fallback.code, "selected");
    assert.equal(fallback.selected?.profileId, "codex-deepseek-v4");

    appendRoutingDecision(repo, {
      at: "2026-11-07T15:00:00.000Z",
      code: fallback.code,
      selectedProfileId: fallback.selected?.profileId ?? null,
      reasons: fallback.reasons,
      candidateProfileIds: fallback.candidates.map((c) => c.profileId),
    });
    assert.equal(readRoutingDecisions(repo).at(-1)?.selectedProfileId, "codex-deepseek-v4");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  activateProfile,
  appendRoutingDecision,
  readRoutingDecisions,
  selectDesignElaboratorProfile,
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

test("selectDesignElaboratorProfile fail-closed on empty catalog", () => {
  const repo = mkdtempSync(join(tmpdir(), "cliyard-route-a-"));
  try {
    const decision = selectDesignElaboratorProfile({ repoRoot: repo });
    assert.equal(decision.code, "no_activated_profiles");
    assert.equal(decision.role, "design-elaborator");
    assert.equal(decision.mode, "routine");
    assert.equal(decision.selected, null);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("routine mode stable tie-break; preferredProfileId exact", () => {
  const repo = mkdtempSync(join(tmpdir(), "cliyard-route-a-"));
  try {
    activateProfile({ repoRoot: repo, profile: CODEX });
    activateProfile({ repoRoot: repo, profile: CLAUDE });

    const routine = selectDesignElaboratorProfile({
      repoRoot: repo,
      requirements: { mode: "routine" },
    });
    assert.equal(routine.code, "selected");
    assert.equal(routine.selected?.profileId, "claude-deepseek-flash");
    assert.equal(routine.role, "design-elaborator");

    const exact = selectDesignElaboratorProfile({
      repoRoot: repo,
      requirements: {
        mode: "elevated",
        preferredProfileId: "codex-deepseek-v4",
      },
    });
    assert.equal(exact.code, "selected");
    assert.equal(exact.selected?.profileId, "codex-deepseek-v4");
    assert.equal(exact.mode, "elevated");

    const missing = selectDesignElaboratorProfile({
      repoRoot: repo,
      requirements: { preferredProfileId: "no-such-profile" },
    });
    assert.equal(missing.code, "no_capability_match");
    assert.equal(missing.selected, null);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("elevated without preferences fails closed; with preference scores", () => {
  const repo = mkdtempSync(join(tmpdir(), "cliyard-route-a-"));
  try {
    activateProfile({ repoRoot: repo, profile: CLAUDE });
    activateProfile({ repoRoot: repo, profile: CODEX });

    const bare = selectDesignElaboratorProfile({
      repoRoot: repo,
      requirements: { mode: "elevated" },
    });
    assert.equal(bare.code, "no_capability_match");
    assert.equal(bare.selected, null);
    assert.ok(
      bare.reasons.some((r) => /will not invent a stronger model/.test(r)),
    );

    const preferred = selectDesignElaboratorProfile({
      repoRoot: repo,
      requirements: {
        mode: "elevated",
        preferredRuntimeId: "codex",
        preferredModelId: "deepseek-v4-pro",
      },
    });
    assert.equal(preferred.code, "selected");
    assert.equal(preferred.selected?.profileId, "codex-deepseek-v4");
    assert.equal(
      preferred.candidates.find((c) => c.profileId === "codex-deepseek-v4")
        ?.score,
      5,
    );

    appendRoutingDecision(repo, {
      at: "2026-11-07T16:00:00.000Z",
      code: preferred.code,
      selectedProfileId: preferred.selected?.profileId ?? null,
      reasons: preferred.reasons,
      candidateProfileIds: preferred.candidates.map((c) => c.profileId),
      role: preferred.role,
    });
    const last = readRoutingDecisions(repo).at(-1);
    assert.equal(last?.role, "design-elaborator");
    assert.equal(last?.selectedProfileId, "codex-deepseek-v4");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

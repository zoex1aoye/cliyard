import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  SkillPackBuildError,
  bindSkillPackToRun,
  buildSkillPackFromAgentsDir,
  loadSkillPack,
  loadSkillPackBinding,
  saveSkillPack,
} from "../src/skillpack/index.js";

function fixtureSkills(): { repo: string; skillsRoot: string } {
  const repo = mkdtempSync(join(tmpdir(), "cliyard-sp-"));
  const skillsRoot = join(repo, ".agents", "skills");
  mkdirSync(join(skillsRoot, "alpha"), { recursive: true });
  mkdirSync(join(skillsRoot, "beta"), { recursive: true });
  writeFileSync(join(skillsRoot, "alpha", "SKILL.md"), "# alpha\n", "utf8");
  writeFileSync(join(skillsRoot, "beta", "SKILL.md"), "# beta\n", "utf8");
  return { repo, skillsRoot };
}

test("buildSkillPackFromAgentsDir digests skills stably", () => {
  const { repo, skillsRoot } = fixtureSkills();
  try {
    const a = buildSkillPackFromAgentsDir({
      repoRoot: repo,
      skillsRoot,
      id: "fixture-pack",
      packVersion: "1.0.0",
      now: () => "2026-11-07T15:00:00.000Z",
    });
    const b = buildSkillPackFromAgentsDir({
      repoRoot: repo,
      skillsRoot,
      id: "fixture-pack",
      packVersion: "1.0.0",
      now: () => "2026-11-07T16:00:00.000Z",
    });
    assert.equal(a.skills.length, 2);
    assert.equal(a.digest, b.digest);
    assert.equal(a.skills[0]!.name, "alpha");
    assert.match(a.skills[0]!.digest, /^[a-f0-9]{64}$/);

    const path = saveSkillPack(repo, a);
    assert.ok(path.includes("fixture-pack@1.0.0.json"));
    assert.equal(loadSkillPack(repo, "fixture-pack", "1.0.0")?.digest, a.digest);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("bindSkillPackToRun writes durable binding", () => {
  const { repo, skillsRoot } = fixtureSkills();
  try {
    const pack = buildSkillPackFromAgentsDir({
      repoRoot: repo,
      skillsRoot,
      id: "fixture-pack",
      packVersion: "1.0.0",
    });
    saveSkillPack(repo, pack);
    const binding = bindSkillPackToRun(repo, "run-abc", pack, () =>
      "2026-11-07T15:01:00.000Z",
    );
    assert.equal(binding.digest, pack.digest);
    assert.equal(loadSkillPackBinding(repo, "run-abc")?.skillPackId, "fixture-pack");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("refuses empty skills root and escaping symlink", () => {
  const repo = mkdtempSync(join(tmpdir(), "cliyard-sp-"));
  try {
    const empty = join(repo, ".agents", "skills");
    mkdirSync(empty, { recursive: true });
    assert.throws(
      () => buildSkillPackFromAgentsDir({ repoRoot: repo, skillsRoot: empty }),
      (e: unknown) => e instanceof SkillPackBuildError && /no SKILL.md/.test(String(e)),
    );

    const outside = mkdtempSync(join(tmpdir(), "cliyard-sp-out-"));
    writeFileSync(join(outside, "SKILL.md"), "leak\n", "utf8");
    const skillsRoot = join(repo, "skills2");
    mkdirSync(skillsRoot, { recursive: true });
    try {
      symlinkSync(outside, join(skillsRoot, "evil"));
      assert.throws(
        () => buildSkillPackFromAgentsDir({ repoRoot: repo, skillsRoot }),
        (e: unknown) =>
          e instanceof SkillPackBuildError && /escapes skills root/.test(String(e)),
      );
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

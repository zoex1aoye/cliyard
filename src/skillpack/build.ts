/**
 * Build a SkillPack digest from .agents/skills slash-star SKILL.md entries.
 */
import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  readdirSync,
  readFileSync,
  realpathSync,
} from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import type { SkillPack, SkillPackSkill } from "./types.js";

export class SkillPackBuildError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

export interface BuildSkillPackOptions {
  repoRoot: string;
  /** Override skills root (tests). Default: repoRoot + "/.agents/skills". */
  skillsRoot?: string;
  id?: string;
  packVersion?: string;
  entrypoint?: string;
  harnesses?: string[];
  minControlPlaneVersion?: string;
  now?: () => string;
}

function sha256Bytes(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

function assertInsideRoot(root: string, candidate: string): string {
  const rootReal = realpathSync(root);
  const candReal = realpathSync(candidate);
  const rel = relative(rootReal, candReal);
  if (rel.startsWith("..") || rel.includes(".." + sep)) {
    throw new SkillPackBuildError(
      "skill path escapes skills root: " + candidate,
    );
  }
  return candReal;
}

/**
 * Scan a skills directory and produce a SkillPack with per-skill and pack
 * digests. Symlinks that escape the skills root are refused.
 */
export function buildSkillPackFromAgentsDir(
  options: BuildSkillPackOptions,
): SkillPack {
  const repoRoot = resolve(options.repoRoot);
  const skillsRoot = resolve(
    options.skillsRoot ?? join(repoRoot, ".agents", "skills"),
  );
  if (!existsSync(skillsRoot) || !lstatSync(skillsRoot).isDirectory()) {
    throw new SkillPackBuildError("skills root missing: " + skillsRoot);
  }
  const rootReal = realpathSync(skillsRoot);
  const entries = readdirSync(skillsRoot, { withFileTypes: true });
  const skills: SkillPackSkill[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    const dirPath = join(skillsRoot, entry.name);
    let dirReal: string;
    try {
      dirReal = assertInsideRoot(rootReal, dirPath);
    } catch (error) {
      throw error;
    }
    if (!lstatSync(dirReal).isDirectory()) continue;
    const skillFile = join(dirReal, "SKILL.md");
    if (!existsSync(skillFile)) continue;
    const skillReal = assertInsideRoot(rootReal, skillFile);
    if (!lstatSync(skillReal).isFile()) {
      throw new SkillPackBuildError(
        "skill entrypoint is not a file: " + skillReal,
      );
    }
    const bytes = readFileSync(skillReal);
    const digest = sha256Bytes(bytes);
    const relEntrypoint = relative(rootReal, skillReal).split(sep).join("/");
    skills.push({
      name: entry.name,
      digest,
      entrypoint: relEntrypoint,
    });
  }

  skills.sort((a, b) => a.name.localeCompare(b.name));
  if (skills.length === 0) {
    throw new SkillPackBuildError(
      "no SKILL.md files found under " + skillsRoot,
    );
  }

  const id = options.id?.trim() || "cliyard-agents";
  const packVersion = options.packVersion?.trim() || "0.0.0-dev";
  const entrypoint = options.entrypoint?.trim() || ".agents/skills";
  const harnesses = options.harnesses ?? ["cursor", "codex", "claude"];
  const canonical = {
    id,
    packVersion,
    entrypoint,
    skills: skills.map((s) => ({
      name: s.name,
      digest: s.digest,
      entrypoint: s.entrypoint,
    })),
    compatibility: {
      harnesses: [...harnesses],
      ...(options.minControlPlaneVersion
        ? { minControlPlaneVersion: options.minControlPlaneVersion }
        : {}),
    },
  };
  const digest = sha256Bytes(Buffer.from(JSON.stringify(canonical), "utf8"));
  const now = options.now ?? (() => new Date().toISOString());

  return {
    version: 1,
    id,
    packVersion,
    digest,
    entrypoint,
    skills,
    compatibility: canonical.compatibility,
    sourceRoot: rootReal,
    capturedAt: now(),
  };
}

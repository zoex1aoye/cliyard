/**
 * Durable SkillPack snapshots under `.cliyard/skillpacks/`.
 */
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { isSkillPack, type SkillPack } from "./types.js";

export function skillPackDir(repoRoot: string): string {
  return join(repoRoot, ".cliyard", "skillpacks");
}

export function skillPackPath(
  repoRoot: string,
  id: string,
  packVersion: string,
): string {
  if (!/^[A-Za-z0-9._-]+$/.test(id) || !/^[A-Za-z0-9._-]+$/.test(packVersion)) {
    throw new Error(`invalid skillpack id/version: ${id}@${packVersion}`);
  }
  return join(skillPackDir(repoRoot), `${id}@${packVersion}.json`);
}

export function saveSkillPack(repoRoot: string, pack: SkillPack): string {
  if (!isSkillPack(pack)) {
    throw new Error("refusing to persist invalid SkillPack");
  }
  mkdirSync(skillPackDir(repoRoot), { recursive: true });
  const path = skillPackPath(repoRoot, pack.id, pack.packVersion);
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(pack, null, 2)}\n`, "utf8");
  renameSync(tmp, path);
  return path;
}

export function loadSkillPack(
  repoRoot: string,
  id: string,
  packVersion: string,
): SkillPack | null {
  const path = skillPackPath(repoRoot, id, packVersion);
  if (!existsSync(path)) return null;
  const raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
  if (!isSkillPack(raw)) {
    throw new Error(`invalid SkillPack at ${path}`);
  }
  return raw;
}

export function listSkillPacks(repoRoot: string): SkillPack[] {
  const dir = skillPackDir(repoRoot);
  if (!existsSync(dir)) return [];
  const out: SkillPack[] = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".json") || name.includes(".tmp") || name === "bindings") {
      continue;
    }
    const raw = JSON.parse(
      readFileSync(join(dir, name), "utf8"),
    ) as unknown;
    if (isSkillPack(raw)) out.push(raw);
  }
  out.sort((a, b) =>
    `${a.id}@${a.packVersion}`.localeCompare(`${b.id}@${b.packVersion}`),
  );
  return out;
}

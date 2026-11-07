/**
 * Bind a SkillPack digest to a run id (v0 side file; RunManifest attach later).
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { skillPackDir } from "./store.js";
import {
  isSkillPackRunBinding,
  type SkillPack,
  type SkillPackRunBinding,
} from "./types.js";

export function skillPackBindingsDir(repoRoot: string): string {
  return join(skillPackDir(repoRoot), "bindings");
}

export function skillPackBindingPath(repoRoot: string, runId: string): string {
  if (!/^[A-Za-z0-9._-]+$/.test(runId)) {
    throw new Error(`invalid runId for skillpack binding: ${runId}`);
  }
  return join(skillPackBindingsDir(repoRoot), `${runId}.json`);
}

export function bindSkillPackToRun(
  repoRoot: string,
  runId: string,
  pack: SkillPack,
  now: () => string = () => new Date().toISOString(),
): SkillPackRunBinding {
  const binding: SkillPackRunBinding = {
    version: 1,
    runId,
    skillPackId: pack.id,
    packVersion: pack.packVersion,
    digest: pack.digest,
    boundAt: now(),
  };
  mkdirSync(skillPackBindingsDir(repoRoot), { recursive: true });
  const path = skillPackBindingPath(repoRoot, runId);
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(binding, null, 2)}\n`, "utf8");
  renameSync(tmp, path);
  return binding;
}

export function loadSkillPackBinding(
  repoRoot: string,
  runId: string,
): SkillPackRunBinding | null {
  const path = skillPackBindingPath(repoRoot, runId);
  if (!existsSync(path)) return null;
  const raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
  if (!isSkillPackRunBinding(raw)) {
    throw new Error(`invalid SkillPackRunBinding at ${path}`);
  }
  return raw;
}

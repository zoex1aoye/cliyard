/**
 * SkillPack provenance model
 * (design/skillpack-provenance-v0.md, continuous-harness-v2).
 */
export interface SkillPackSkill {
  name: string;
  digest: string;
  entrypoint: string;
}

export interface SkillPackCompatibility {
  harnesses: string[];
  minControlPlaneVersion?: string;
}

export interface SkillPack {
  version: 1;
  id: string;
  packVersion: string;
  digest: string;
  entrypoint: string;
  skills: SkillPackSkill[];
  compatibility: SkillPackCompatibility;
  /** Absolute agents skills root used to build this pack. */
  sourceRoot: string;
  capturedAt: string;
}

export interface SkillPackRunBinding {
  version: 1;
  runId: string;
  skillPackId: string;
  packVersion: string;
  digest: string;
  boundAt: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function isSkillPack(value: unknown): value is SkillPack {
  if (!isRecord(value)) return false;
  if (value.version !== 1) return false;
  if (typeof value.id !== "string" || value.id.trim() === "") return false;
  if (typeof value.packVersion !== "string" || value.packVersion.trim() === "") {
    return false;
  }
  if (typeof value.digest !== "string" || value.digest.length < 16) return false;
  if (typeof value.entrypoint !== "string" || value.entrypoint.trim() === "") {
    return false;
  }
  if (!Array.isArray(value.skills)) return false;
  for (const skill of value.skills) {
    if (!isRecord(skill)) return false;
    if (typeof skill.name !== "string" || skill.name.trim() === "") return false;
    if (typeof skill.digest !== "string" || skill.digest.length < 16) return false;
    if (typeof skill.entrypoint !== "string" || skill.entrypoint.trim() === "") {
      return false;
    }
  }
  if (!isRecord(value.compatibility)) return false;
  if (
    !Array.isArray(value.compatibility.harnesses) ||
    !value.compatibility.harnesses.every((h) => typeof h === "string")
  ) {
    return false;
  }
  if (typeof value.sourceRoot !== "string") return false;
  if (typeof value.capturedAt !== "string") return false;
  return true;
}

export function isSkillPackRunBinding(
  value: unknown,
): value is SkillPackRunBinding {
  if (!isRecord(value)) return false;
  if (value.version !== 1) return false;
  if (typeof value.runId !== "string" || value.runId.trim() === "") return false;
  if (typeof value.skillPackId !== "string") return false;
  if (typeof value.packVersion !== "string") return false;
  if (typeof value.digest !== "string") return false;
  if (typeof value.boundAt !== "string") return false;
  return true;
}

/**
 * Mount cliyard Master persona into DSH systemPrompt when available.
 * Mirrors src/mvp/master-persona.ts for the Cordis plugin (plain ESM).
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const MASTER_PERSONA_SECTION_NAME = "cliyard:master-persona";
export const MASTER_PERSONA_SECTION_ORDER = 50;

function pluginDir() {
  return dirname(fileURLToPath(import.meta.url));
}

/** Repo root when plugin lives at plugins/dsh-cliyard/lib. */
export function defaultPromptPath() {
  return join(
    pluginDir(),
    "..",
    "..",
    "..",
    "design",
    "dsh-master-persona-v0.prompt.txt",
  );
}

export function loadMasterPersonaText(promptPath = defaultPromptPath()) {
  const text = readFileSync(promptPath, "utf8").trim();
  if (!text) {
    throw new Error(`Master persona prompt is empty: ${promptPath}`);
  }
  return `${text}\n`;
}

/**
 * @param {object} ctx Cordis context
 * @param {{ promptPath?: string, order?: number }} [opts]
 * @returns {{ mounted: boolean, sectionName: string, chars: number }}
 */
export function mountMasterPersona(ctx, opts = {}) {
  const sectionName = MASTER_PERSONA_SECTION_NAME;
  const systemPrompt = ctx?.systemPrompt;
  if (!systemPrompt || typeof systemPrompt.section !== "function") {
    return { mounted: false, sectionName, chars: 0 };
  }
  const text = loadMasterPersonaText(opts.promptPath);
  systemPrompt.section({
    name: sectionName,
    order: opts.order ?? MASTER_PERSONA_SECTION_ORDER,
    text,
    interpolate: false,
  });
  return { mounted: true, sectionName, chars: text.length };
}

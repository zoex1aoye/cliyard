/**
 * Master system-persona text for DSH systemPrompt mount (M0.5).
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const MASTER_PERSONA_SECTION_NAME = "cliyard:master-persona";
/** After deployment personaPrefix (0); before most tool guidance. */
export const MASTER_PERSONA_SECTION_ORDER = 50;

const PROMPT_RELATIVE = join(
  "design",
  "dsh-master-persona-v0.prompt.txt",
);

export function defaultMasterPersonaPromptPath(
  repoRoot: string = findRepoRootFromModule(),
): string {
  return join(repoRoot, PROMPT_RELATIVE);
}

function findRepoRootFromModule(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  // src/mvp → repo root
  return join(here, "..", "..");
}

export function loadMasterPersonaText(promptPath?: string): string {
  const path = promptPath ?? defaultMasterPersonaPromptPath();
  const text = readFileSync(path, "utf8").trim();
  if (text.length === 0) {
    throw new Error(`Master persona prompt is empty: ${path}`);
  }
  return `${text}\n`;
}

export interface SystemPromptSectionApi {
  section: (input: {
    name: string;
    order: number;
    text: string;
    interpolate?: boolean;
  }) => unknown;
}

/**
 * Register Master persona on DSH `ctx.systemPrompt` when present.
 * Returns false when the host has no systemPrompt (unit / standalone).
 */
export function mountMasterPersona(input: {
  systemPrompt: SystemPromptSectionApi | null | undefined;
  promptPath?: string;
  order?: number;
}): { mounted: boolean; sectionName: string; chars: number } {
  const sectionName = MASTER_PERSONA_SECTION_NAME;
  if (
    !input.systemPrompt ||
    typeof input.systemPrompt.section !== "function"
  ) {
    return { mounted: false, sectionName, chars: 0 };
  }
  const text = loadMasterPersonaText(input.promptPath);
  input.systemPrompt.section({
    name: sectionName,
    order: input.order ?? MASTER_PERSONA_SECTION_ORDER,
    text,
    interpolate: false,
  });
  return { mounted: true, sectionName, chars: text.length };
}

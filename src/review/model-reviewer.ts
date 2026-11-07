/**
 * Model-backed Reviewer adapter over CleanReviewContext only
 * (design/reviewer-model-adapter-v0.md).
 *
 * Findings never grant acceptance. Provider transcripts are not persisted.
 */
import type { CleanReviewContext, ReviewSessionRecord } from "./types.js";
import {
  ReviewFindingError,
  validateReviewFinding,
  type ProposeReviewFindingInput,
} from "./findings.js";
import { proposeFindings } from "./session.js";
import type { Reviewer } from "./reviewer.js";

export class ModelReviewerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/**
 * Injected model/CLI call. Receives the CleanReviewContext-only prompt text
 * and returns raw model text expected to contain a JSON findings array.
 * Must not be given chat transcripts by this adapter.
 */
export type ModelReviewInvoker = (input: {
  prompt: string;
  context: CleanReviewContext;
}) => string | Promise<string>;

export interface ModelReviewerOptions {
  invoke: ModelReviewInvoker;
  /**
   * When true (default), any invalid finding refuses the whole response.
   * When false, invalid entries are skipped (still no chat persistence).
   */
  strict?: boolean;
}

export interface ModelReviewer extends Reviewer {
  /** Build the secret-free prompt (exported for tests / audit). */
  buildPrompt(context: CleanReviewContext): string;
}

const FORBIDDEN_PROMPT_KEYS = [
  "chat",
  "prompt",
  "selfAssessment",
  "self_assessment",
  "transcript",
  "conversation",
  "authorNotes",
] as const;

/**
 * Serialize only CleanReviewContext fields into the model prompt payload.
 */
export function buildModelReviewPrompt(context: CleanReviewContext): string {
  const payload = {
    role: "clean-context-reviewer",
    instructions: [
      "Review the artifact against approved requirements only.",
      "Return a JSON array of findings.",
      "Each finding MUST include: id, requirementRef, severity",
      '(blocking|should-fix|nit), problem, location.path, reason.',
      "Do not invent acceptance or merge decisions.",
      "Do not include chat, self-assessment, or secrets.",
    ],
    context: {
      artifactCommit: context.artifactCommit,
      ...(context.baseCommit !== undefined
        ? { baseCommit: context.baseCommit }
        : {}),
      contextHash: context.contextHash,
      requirementRefs: context.requirementRefs,
      ...(context.requirementText !== undefined
        ? { requirementText: context.requirementText }
        : {}),
      evidenceRefs: context.evidenceRefs,
      unifiedDiff: context.unifiedDiff,
    },
  };
  return `${JSON.stringify(payload, null, 2)}\n`;
}

function extractJsonArray(text: string): unknown {
  const trimmed = text.trim();
  if (trimmed.startsWith("[")) {
    return JSON.parse(trimmed) as unknown;
  }
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced?.[1]) {
    return JSON.parse(fenced[1].trim()) as unknown;
  }
  const start = trimmed.indexOf("[");
  const end = trimmed.lastIndexOf("]");
  if (start >= 0 && end > start) {
    return JSON.parse(trimmed.slice(start, end + 1)) as unknown;
  }
  throw new ModelReviewerError("model response does not contain a JSON array");
}

function assertNoContamination(value: unknown, path: string): void {
  if (value === null || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      assertNoContamination(value[i], `${path}[${i}]`);
    }
    return;
  }
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (
      (FORBIDDEN_PROMPT_KEYS as readonly string[]).includes(key) ||
      /chat|transcript|self.?assess|conversation/i.test(key)
    ) {
      throw new ModelReviewerError(
        `model finding payload refuses contaminated key: ${key} at ${path}`,
      );
    }
    assertNoContamination(child, `${path}.${key}`);
  }
}

function parseFindings(
  text: string,
  artifactCommit: string,
  strict: boolean,
): ProposeReviewFindingInput[] {
  let raw: unknown;
  try {
    raw = extractJsonArray(text);
  } catch (error) {
    if (error instanceof ModelReviewerError) throw error;
    throw new ModelReviewerError(
      `invalid model JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!Array.isArray(raw)) {
    throw new ModelReviewerError("model findings must be a JSON array");
  }
  assertNoContamination(raw, "$");

  const out: ProposeReviewFindingInput[] = [];
  for (let i = 0; i < raw.length; i++) {
    const entry = raw[i];
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      if (strict) {
        throw new ModelReviewerError(`finding[${i}] must be an object`);
      }
      continue;
    }
    const record = entry as Record<string, unknown>;
    const locationRaw = record.location;
    const location =
      locationRaw !== null &&
      typeof locationRaw === "object" &&
      !Array.isArray(locationRaw)
        ? {
            path: String((locationRaw as Record<string, unknown>).path ?? ""),
            ...((locationRaw as Record<string, unknown>).line !== undefined
              ? {
                  line: Number((locationRaw as Record<string, unknown>).line),
                }
              : {}),
          }
        : { path: "" };

    const input: ProposeReviewFindingInput = {
      id: String(record.id ?? `model-${i + 1}`),
      artifactCommit:
        typeof record.artifactCommit === "string" &&
        record.artifactCommit.trim() !== ""
          ? record.artifactCommit
          : artifactCommit,
      requirementRef: String(record.requirementRef ?? ""),
      severity: record.severity as ProposeReviewFindingInput["severity"],
      problem: String(record.problem ?? ""),
      location,
      reason: String(record.reason ?? ""),
    };

    try {
      validateReviewFinding(input);
      out.push(input);
    } catch (error) {
      if (strict || error instanceof ReviewFindingError === false) {
        throw new ModelReviewerError(
          `finding[${i}] refused: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
      // non-strict: skip opinions
    }
  }
  return out;
}

/**
 * Create a model-backed reviewer. The invoker is injected so tests never need
 * a live provider; production can wrap Claude/Codex CLI behind the same seam.
 */
export function createModelReviewer(
  options: ModelReviewerOptions,
): ModelReviewer {
  if (typeof options.invoke !== "function") {
    throw new ModelReviewerError("ModelReviewInvoker is required");
  }
  const strict = options.strict !== false;

  return {
    buildPrompt: buildModelReviewPrompt,
    async review(
      repoRoot: string,
      reviewId: string,
      context: CleanReviewContext,
      _proposals?: Omit<ProposeReviewFindingInput, "artifactCommit">[],
    ): Promise<ReviewSessionRecord> {
      const prompt = buildModelReviewPrompt(context);
      // Defense in depth: prompt text must not contain contamination keys as
      // top-level instruction smuggling from context (context builder already
      // refuses them; re-check serialized form for forbidden labels).
      for (const key of FORBIDDEN_PROMPT_KEYS) {
        if (new RegExp(`"${key}"\\s*:`).test(prompt)) {
          throw new ModelReviewerError(
            `refusing to invoke model with contaminated prompt key: ${key}`,
          );
        }
      }

      const raw = await options.invoke({ prompt, context });
      if (typeof raw !== "string") {
        throw new ModelReviewerError("invoker must return a string");
      }
      const proposals = parseFindings(raw, context.artifactCommit, strict);
      return proposeFindings(repoRoot, reviewId, proposals, {
        expectedContextHash: context.contextHash,
      });
    },
  };
}

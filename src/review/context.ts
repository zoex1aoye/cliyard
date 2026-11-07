/**
 * Build a chat-free CleanReviewContext
 * (design/reviewer-clean-context-v0.md).
 */
import { createHash } from "node:crypto";
import type { CleanReviewContext } from "./types.js";

export const MAX_REVIEW_DIFF_CHARS = 200_000;
export const MAX_REVIEW_REQUIREMENT_TEXT_CHARS = 20_000;
export const MAX_REVIEW_EVIDENCE_REFS = 64;
export const MAX_REVIEW_REQUIREMENT_REFS = 64;

/** Keys that must never enter a clean review context. */
export const FORBIDDEN_REVIEW_CONTEXT_KEYS = [
  "chat",
  "transcript",
  "prompt",
  "prompts",
  "selfAssessment",
  "self_assessment",
  "authorNotes",
  "author_notes",
  "conversation",
  "workerLog",
  "worker_log",
] as const;

export class CleanReviewContextError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

export interface BuildCleanReviewContextInput {
  artifactCommit: string;
  baseCommit?: string;
  unifiedDiff: string;
  requirementRefs: string[];
  requirementText?: string;
  evidenceRefs?: string[];
  /**
   * Extra bag inspected only to refuse forbidden keys. Any present forbidden
   * key fails closed — even if other fields are valid.
   */
  refuseExtras?: Record<string, unknown>;
}

function assertCommit(value: string, label: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new CleanReviewContextError(`${label} is required`);
  return trimmed;
}

function hashContext(payload: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(payload))
    .digest("hex");
}

/**
 * Construct a CleanReviewContext. Throws when forbidden contamination keys
 * are present or bounds are violated.
 */
export function buildCleanReviewContext(
  input: BuildCleanReviewContextInput,
): CleanReviewContext {
  if (input.refuseExtras !== undefined) {
    for (const key of Object.keys(input.refuseExtras)) {
      if (
        (FORBIDDEN_REVIEW_CONTEXT_KEYS as readonly string[]).includes(key)
      ) {
        throw new CleanReviewContextError(
          `clean review context refuses contaminated key: ${key}`,
        );
      }
    }
  }

  const artifactCommit = assertCommit(input.artifactCommit, "artifactCommit");
  const baseCommit =
    input.baseCommit !== undefined
      ? assertCommit(input.baseCommit, "baseCommit")
      : undefined;
  if (typeof input.unifiedDiff !== "string") {
    throw new CleanReviewContextError("unifiedDiff must be a string");
  }
  if (input.unifiedDiff.length > MAX_REVIEW_DIFF_CHARS) {
    throw new CleanReviewContextError(
      `unifiedDiff exceeds ${MAX_REVIEW_DIFF_CHARS} characters`,
    );
  }
  if (!Array.isArray(input.requirementRefs)) {
    throw new CleanReviewContextError("requirementRefs must be an array");
  }
  if (input.requirementRefs.length > MAX_REVIEW_REQUIREMENT_REFS) {
    throw new CleanReviewContextError(
      `requirementRefs exceeds ${MAX_REVIEW_REQUIREMENT_REFS}`,
    );
  }
  for (const ref of input.requirementRefs) {
    if (typeof ref !== "string" || ref.trim() === "") {
      throw new CleanReviewContextError("requirementRefs entries must be non-empty strings");
    }
  }
  let requirementText: string | undefined;
  if (input.requirementText !== undefined) {
    if (typeof input.requirementText !== "string") {
      throw new CleanReviewContextError("requirementText must be a string");
    }
    if (input.requirementText.length > MAX_REVIEW_REQUIREMENT_TEXT_CHARS) {
      throw new CleanReviewContextError(
        `requirementText exceeds ${MAX_REVIEW_REQUIREMENT_TEXT_CHARS} characters`,
      );
    }
    requirementText = input.requirementText;
  }
  const evidenceRefs = [...(input.evidenceRefs ?? [])];
  if (evidenceRefs.length > MAX_REVIEW_EVIDENCE_REFS) {
    throw new CleanReviewContextError(
      `evidenceRefs exceeds ${MAX_REVIEW_EVIDENCE_REFS}`,
    );
  }
  for (const ref of evidenceRefs) {
    if (typeof ref !== "string" || ref.trim() === "") {
      throw new CleanReviewContextError("evidenceRefs entries must be non-empty strings");
    }
  }

  const canonical = {
    artifactCommit,
    ...(baseCommit !== undefined ? { baseCommit } : {}),
    unifiedDiff: input.unifiedDiff,
    requirementRefs: [...input.requirementRefs],
    ...(requirementText !== undefined ? { requirementText } : {}),
    evidenceRefs,
  };
  return {
    ...canonical,
    contextHash: hashContext(canonical),
  };
}

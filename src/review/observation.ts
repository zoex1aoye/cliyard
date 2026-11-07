/**
 * Bounded clean-review observation for LoopResult / RunManifest
 * (design/reviewer-acceptance-wire-v0.md).
 *
 * Observational only — never grants acceptance or merge.
 */
export const MAX_REVIEW_OBSERVATION_FINDING_IDS = 64;

export interface ReviewObservation {
  reviewId: string;
  contextHash: string;
  findingCount: number;
  blockingCount: number;
  /** Bounded finding ids only — no bodies, reasons, or transcripts. */
  findingIds: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function isReviewObservation(value: unknown): value is ReviewObservation {
  if (!isRecord(value)) return false;
  if (typeof value.reviewId !== "string" || value.reviewId.trim() === "") {
    return false;
  }
  if (typeof value.contextHash !== "string" || value.contextHash.trim() === "") {
    return false;
  }
  if (
    typeof value.findingCount !== "number" ||
    !Number.isInteger(value.findingCount) ||
    value.findingCount < 0
  ) {
    return false;
  }
  if (
    typeof value.blockingCount !== "number" ||
    !Number.isInteger(value.blockingCount) ||
    value.blockingCount < 0
  ) {
    return false;
  }
  if (!Array.isArray(value.findingIds)) return false;
  if (value.findingIds.length > MAX_REVIEW_OBSERVATION_FINDING_IDS) return false;
  if (value.findingIds.length !== value.findingCount) return false;
  if (value.blockingCount > value.findingCount) return false;
  for (const id of value.findingIds) {
    if (typeof id !== "string" || id.trim() === "") return false;
  }
  return true;
}

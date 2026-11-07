/**
 * Validate and normalize ReviewFinding records
 * (design/reviewer-clean-context-v0.md).
 */
import {
  isReviewFindingSeverity,
  type ReviewFinding,
  type ReviewFindingSeverity,
} from "./types.js";

export class ReviewFindingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

export interface ProposeReviewFindingInput {
  id: string;
  artifactCommit: string;
  requirementRef: string;
  severity: ReviewFindingSeverity;
  problem: string;
  location: { path: string; line?: number };
  reason: string;
}

/**
 * Findings without a path location or reason are opinions and must not enter
 * the durable review session.
 */
export function validateReviewFinding(
  input: ProposeReviewFindingInput,
): ReviewFinding {
  if (typeof input.id !== "string" || input.id.trim() === "") {
    throw new ReviewFindingError("finding id is required");
  }
  if (
    typeof input.artifactCommit !== "string" ||
    input.artifactCommit.trim() === ""
  ) {
    throw new ReviewFindingError("finding artifactCommit is required");
  }
  if (
    typeof input.requirementRef !== "string" ||
    input.requirementRef.trim() === ""
  ) {
    throw new ReviewFindingError("finding requirementRef is required");
  }
  if (!isReviewFindingSeverity(input.severity)) {
    throw new ReviewFindingError("finding severity is invalid");
  }
  if (typeof input.problem !== "string" || input.problem.trim() === "") {
    throw new ReviewFindingError("finding problem is required");
  }
  if (
    input.location === null ||
    typeof input.location !== "object" ||
    typeof input.location.path !== "string" ||
    input.location.path.trim() === ""
  ) {
    throw new ReviewFindingError(
      "finding without location.path is an opinion and is refused",
    );
  }
  if (
    input.location.line !== undefined &&
    (typeof input.location.line !== "number" ||
      !Number.isInteger(input.location.line) ||
      input.location.line < 1)
  ) {
    throw new ReviewFindingError("finding location.line must be a positive integer");
  }
  if (typeof input.reason !== "string" || input.reason.trim() === "") {
    throw new ReviewFindingError(
      "finding without reason is an opinion and is refused",
    );
  }
  return {
    id: input.id.trim(),
    artifactCommit: input.artifactCommit.trim(),
    requirementRef: input.requirementRef.trim(),
    severity: input.severity,
    problem: input.problem.trim(),
    location: {
      path: input.location.path.trim(),
      ...(input.location.line !== undefined
        ? { line: input.location.line }
        : {}),
    },
    reason: input.reason.trim(),
    status: "proposed",
  };
}

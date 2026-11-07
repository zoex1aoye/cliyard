/**
 * Clean-context ReviewFinding model
 * (design/reviewer-clean-context-v0.md, continuous-harness-v2).
 *
 * Findings never grant acceptance or merge by themselves.
 */
export const REVIEW_FINDING_SEVERITIES = [
  "blocking",
  "should-fix",
  "nit",
] as const;

export type ReviewFindingSeverity = (typeof REVIEW_FINDING_SEVERITIES)[number];

export const REVIEW_FINDING_STATUSES = [
  "proposed",
  "confirmed",
  "rejected",
  "fixed",
] as const;

export type ReviewFindingStatus = (typeof REVIEW_FINDING_STATUSES)[number];

export interface ReviewFindingLocation {
  path: string;
  line?: number;
}

export interface ReviewFinding {
  id: string;
  artifactCommit: string;
  requirementRef: string;
  severity: ReviewFindingSeverity;
  problem: string;
  location: ReviewFindingLocation;
  reason: string;
  status: ReviewFindingStatus;
  resolution?: string;
}

export interface CleanReviewContext {
  artifactCommit: string;
  baseCommit?: string;
  /** Bounded unified diff text. */
  unifiedDiff: string;
  /** Approved requirement references (paths or ids). */
  requirementRefs: string[];
  /** Optional bounded approved requirement prose. */
  requirementText?: string;
  /** Bounded evidence references (paths/uris), never transcripts. */
  evidenceRefs: string[];
  /** SHA-256 of the canonical context payload. */
  contextHash: string;
}

export interface ReviewResolutionEvent {
  at: string;
  findingId: string;
  from: ReviewFindingStatus;
  to: ReviewFindingStatus;
  note?: string;
}

export interface ReviewSessionRecord {
  version: 1;
  id: string;
  createdAt: string;
  context: CleanReviewContext;
  findings: ReviewFinding[];
  events: ReviewResolutionEvent[];
}

export function isReviewFindingSeverity(
  value: unknown,
): value is ReviewFindingSeverity {
  return (
    typeof value === "string" &&
    (REVIEW_FINDING_SEVERITIES as readonly string[]).includes(value)
  );
}

export function isReviewFindingStatus(
  value: unknown,
): value is ReviewFindingStatus {
  return (
    typeof value === "string" &&
    (REVIEW_FINDING_STATUSES as readonly string[]).includes(value)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function isReviewFinding(value: unknown): value is ReviewFinding {
  if (!isRecord(value)) return false;
  if (typeof value.id !== "string" || value.id.trim() === "") return false;
  if (typeof value.artifactCommit !== "string" || value.artifactCommit.trim() === "") {
    return false;
  }
  if (typeof value.requirementRef !== "string" || value.requirementRef.trim() === "") {
    return false;
  }
  if (!isReviewFindingSeverity(value.severity)) return false;
  if (typeof value.problem !== "string" || value.problem.trim() === "") return false;
  if (!isRecord(value.location)) return false;
  if (typeof value.location.path !== "string" || value.location.path.trim() === "") {
    return false;
  }
  if (
    value.location.line !== undefined &&
    (typeof value.location.line !== "number" ||
      !Number.isInteger(value.location.line) ||
      value.location.line < 1)
  ) {
    return false;
  }
  if (typeof value.reason !== "string" || value.reason.trim() === "") return false;
  if (!isReviewFindingStatus(value.status)) return false;
  if (value.resolution !== undefined && typeof value.resolution !== "string") {
    return false;
  }
  return true;
}

export function isCleanReviewContext(value: unknown): value is CleanReviewContext {
  if (!isRecord(value)) return false;
  if (typeof value.artifactCommit !== "string" || value.artifactCommit.trim() === "") {
    return false;
  }
  if (value.baseCommit !== undefined && typeof value.baseCommit !== "string") {
    return false;
  }
  if (typeof value.unifiedDiff !== "string") return false;
  if (
    !Array.isArray(value.requirementRefs) ||
    !value.requirementRefs.every((r) => typeof r === "string")
  ) {
    return false;
  }
  if (
    value.requirementText !== undefined &&
    typeof value.requirementText !== "string"
  ) {
    return false;
  }
  if (
    !Array.isArray(value.evidenceRefs) ||
    !value.evidenceRefs.every((r) => typeof r === "string")
  ) {
    return false;
  }
  if (typeof value.contextHash !== "string" || value.contextHash.length < 16) {
    return false;
  }
  return true;
}

export function isReviewSessionRecord(value: unknown): value is ReviewSessionRecord {
  if (!isRecord(value)) return false;
  if (value.version !== 1) return false;
  if (typeof value.id !== "string" || value.id.trim() === "") return false;
  if (typeof value.createdAt !== "string") return false;
  if (!isCleanReviewContext(value.context)) return false;
  if (!Array.isArray(value.findings) || !value.findings.every(isReviewFinding)) {
    return false;
  }
  if (!Array.isArray(value.events)) return false;
  for (const event of value.events) {
    if (!isRecord(event)) return false;
    if (typeof event.at !== "string") return false;
    if (typeof event.findingId !== "string") return false;
    if (!isReviewFindingStatus(event.from) || !isReviewFindingStatus(event.to)) {
      return false;
    }
  }
  return true;
}

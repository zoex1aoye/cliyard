/**
 * Durable review session lifecycle
 * (design/reviewer-clean-context-v0.md).
 */
import { randomUUID } from "node:crypto";
import type { CleanReviewContext, ReviewFinding, ReviewSessionRecord } from "./types.js";
import {
  validateReviewFinding,
  type ProposeReviewFindingInput,
  ReviewFindingError,
} from "./findings.js";
import { loadReviewSession, saveReviewSession } from "./store.js";

export class ReviewSessionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

export interface CreateReviewSessionInput {
  repoRoot: string;
  context: CleanReviewContext;
  id?: string;
  now?: () => string;
}

export function createReviewSession(
  input: CreateReviewSessionInput,
): ReviewSessionRecord {
  const now = input.now ?? (() => new Date().toISOString());
  const session: ReviewSessionRecord = {
    version: 1,
    id: input.id ?? `review-${randomUUID()}`,
    createdAt: now(),
    context: input.context,
    findings: [],
    events: [],
  };
  saveReviewSession(input.repoRoot, session);
  return session;
}

export function proposeFindings(
  repoRoot: string,
  reviewId: string,
  proposals: ProposeReviewFindingInput[],
  options: { expectedContextHash?: string } = {},
): ReviewSessionRecord {
  const session = loadReviewSession(repoRoot, reviewId);
  if (!session) throw new ReviewSessionError(`unknown review session: ${reviewId}`);
  if (
    options.expectedContextHash !== undefined &&
    options.expectedContextHash !== session.context.contextHash
  ) {
    throw new ReviewSessionError(
      "review contextHash mismatch; refusing to attach findings",
    );
  }
  const nextFindings = [...session.findings];
  for (const proposal of proposals) {
    if (proposal.artifactCommit !== session.context.artifactCommit) {
      throw new ReviewSessionError(
        `finding artifactCommit ${proposal.artifactCommit} does not match context`,
      );
    }
    const finding = validateReviewFinding(proposal);
    if (nextFindings.some((f) => f.id === finding.id)) {
      throw new ReviewSessionError(`duplicate finding id: ${finding.id}`);
    }
    nextFindings.push(finding);
  }
  const next: ReviewSessionRecord = { ...session, findings: nextFindings };
  saveReviewSession(repoRoot, next);
  return next;
}

export type ReviewResolveAction = "confirm" | "reject" | "fix";

const ALLOWED: Record<
  ReviewFinding["status"],
  ReadonlySet<ReviewResolveAction>
> = {
  proposed: new Set(["confirm", "reject", "fix"]),
  confirmed: new Set(["fix", "reject"]),
  rejected: new Set(),
  fixed: new Set(),
};

export function resolveFinding(
  repoRoot: string,
  reviewId: string,
  findingId: string,
  action: ReviewResolveAction,
  options: { note?: string; now?: () => string } = {},
): ReviewSessionRecord {
  const session = loadReviewSession(repoRoot, reviewId);
  if (!session) throw new ReviewSessionError(`unknown review session: ${reviewId}`);
  const index = session.findings.findIndex((f) => f.id === findingId);
  if (index < 0) {
    throw new ReviewSessionError(`unknown finding: ${findingId}`);
  }
  const finding = session.findings[index]!;
  if (!ALLOWED[finding.status].has(action)) {
    throw new ReviewSessionError(
      `cannot ${action} finding in status ${finding.status}`,
    );
  }
  const to =
    action === "confirm"
      ? "confirmed"
      : action === "reject"
        ? "rejected"
        : "fixed";
  const now = options.now ?? (() => new Date().toISOString());
  const updated: ReviewFinding = {
    ...finding,
    status: to,
    ...(options.note !== undefined ? { resolution: options.note } : {}),
  };
  const findings = [...session.findings];
  findings[index] = updated;
  const next: ReviewSessionRecord = {
    ...session,
    findings,
    events: [
      ...session.events,
      {
        at: now(),
        findingId,
        from: finding.status,
        to,
        ...(options.note !== undefined ? { note: options.note } : {}),
      },
    ],
  };
  saveReviewSession(repoRoot, next);
  return next;
}

export { ReviewFindingError };

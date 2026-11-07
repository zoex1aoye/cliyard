/**
 * Deterministic fixture reviewer — no model / provider call
 * (design/reviewer-clean-context-v0.md).
 */
import type { CleanReviewContext, ReviewSessionRecord } from "./types.js";
import {
  validateReviewFinding,
  type ProposeReviewFindingInput,
} from "./findings.js";
import { proposeFindings } from "./session.js";
import type { Reviewer } from "./reviewer.js";

export interface FixtureReviewer extends Reviewer {
  /**
   * Validate injected findings against the clean context and attach them to
   * the durable session. Never invents findings from chat.
   */
  review(
    repoRoot: string,
    reviewId: string,
    context: CleanReviewContext,
    proposals?: Omit<ProposeReviewFindingInput, "artifactCommit">[],
  ): ReviewSessionRecord;
}

/**
 * Create a fixture reviewer. Callers supply structured proposals; this
 * adapter only binds artifactCommit from the clean context and validates.
 */
export function createFixtureReviewer(): FixtureReviewer {
  return {
    review(repoRoot, reviewId, context, proposals = []) {
      const bound: ProposeReviewFindingInput[] = proposals.map((p) => {
        const input: ProposeReviewFindingInput = {
          ...p,
          artifactCommit: context.artifactCommit,
        };
        // Fail closed before persistence if a proposal is an opinion.
        validateReviewFinding(input);
        return input;
      });
      return proposeFindings(repoRoot, reviewId, bound, {
        expectedContextHash: context.contextHash,
      });
    },
  };
}

/**
 * Shared Reviewer surface (design/reviewer-model-adapter-v0.md).
 *
 * Findings never grant acceptance or merge by themselves.
 */
import type { CleanReviewContext, ReviewSessionRecord } from "./types.js";
import type { ProposeReviewFindingInput } from "./findings.js";

export interface Reviewer {
  /**
   * Produce and persist proposed findings for a frozen clean context.
   * Implementations must not accept chat / prompt / selfAssessment as input.
   */
  review(
    repoRoot: string,
    reviewId: string,
    context: CleanReviewContext,
    /**
     * Fixture path may supply proposals; model path ignores this and derives
     * findings from the invoker response.
     */
    proposals?: Omit<ProposeReviewFindingInput, "artifactCommit">[],
  ): ReviewSessionRecord | Promise<ReviewSessionRecord>;
}

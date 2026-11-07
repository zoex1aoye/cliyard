/**
 * Opt-in clean review on the acceptance path
 * (design/reviewer-acceptance-wire-v0.md).
 *
 * Findings never flip the loop verdict.
 */
import { spawnSync } from "node:child_process";
import type { TaskContract } from "../contracts/schema.js";
import {
  MAX_REVIEW_DIFF_CHARS,
  buildCleanReviewContext,
} from "./context.js";
import { createFixtureReviewer } from "./fixture-reviewer.js";
import type { ProposeReviewFindingInput } from "./findings.js";
import {
  MAX_REVIEW_OBSERVATION_FINDING_IDS,
  type ReviewObservation,
} from "./observation.js";
import type { Reviewer } from "./reviewer.js";
import { createReviewSession } from "./session.js";

export class AcceptanceReviewError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

export interface CleanReviewWireOptions {
  /** Explicit enable. When omitted, `CLIYARD_CLEAN_REVIEW=1` enables. */
  enabled?: boolean;
  /**
   * Control repository for `.cliyard/reviews/` durability. Defaults to
   * `worktree` when omitted (standalone tests).
   */
  controlRepoRoot?: string;
  /** Absolute task worktree (required when enabled unless collectors injected). */
  worktree?: string;
  /** Diff base (default: contract.baseCommit). */
  baseCommit?: string;
  /** Injected reviewer (default: fixture with optional proposals). */
  reviewer?: Reviewer;
  /** Fixture proposals when using the default reviewer. */
  proposals?: Omit<ProposeReviewFindingInput, "artifactCommit">[];
  /** Optional evidence refs attached to the clean context. */
  evidenceRefs?: string[];
  collectUnifiedDiff?: (input: {
    worktree: string;
    baseCommit: string;
  }) => string | Promise<string>;
  resolveArtifactCommit?: (worktree: string) => string | Promise<string>;
  now?: () => string;
}

export function isCleanReviewEnabled(
  options: CleanReviewWireOptions | undefined,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (options?.enabled === true) return true;
  if (options?.enabled === false) return false;
  return (
    env.CLIYARD_CLEAN_REVIEW === "1" || env.CLIYARD_CLEAN_REVIEW === "true"
  );
}

function defaultArtifactCommit(worktree: string): string {
  const result = spawnSync("git", ["rev-parse", "HEAD"], {
    cwd: worktree,
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new AcceptanceReviewError(
      `cannot resolve artifact commit: ${(result.stderr || result.stdout || "").trim()}`,
    );
  }
  const head = (result.stdout || "").trim();
  if (!head) {
    throw new AcceptanceReviewError("cannot resolve artifact commit: empty HEAD");
  }
  return head;
}

function defaultUnifiedDiff(input: {
  worktree: string;
  baseCommit: string;
}): string {
  const result = spawnSync(
    "git",
    ["diff", "--no-color", input.baseCommit, "--"],
    { cwd: input.worktree, encoding: "utf8", maxBuffer: 2 * 1024 * 1024 },
  );
  if (result.status !== 0) {
    throw new AcceptanceReviewError(
      `git diff failed: ${(result.stderr || result.stdout || "").trim()}`,
    );
  }
  const text = result.stdout || "";
  if (text.length <= MAX_REVIEW_DIFF_CHARS) return text;
  return `${text.slice(0, MAX_REVIEW_DIFF_CHARS)}\n/* truncated */\n`;
}

/**
 * Open a durable clean-review session for one acceptance candidate.
 * Does not accept, reject, or merge — caller keeps verify-based verdict.
 */
export async function runAcceptanceReview(input: {
  contract: TaskContract;
  options: CleanReviewWireOptions;
}): Promise<ReviewObservation> {
  const worktree = input.options.worktree;
  if (!worktree || worktree.trim() === "") {
    throw new AcceptanceReviewError(
      "clean review requires an absolute task worktree",
    );
  }
  const repoRoot =
    input.options.controlRepoRoot?.trim() || worktree;

  const baseCommit =
    input.options.baseCommit?.trim() || input.contract.baseCommit;
  if (!baseCommit) {
    throw new AcceptanceReviewError("clean review requires a baseCommit");
  }

  const resolveCommit =
    input.options.resolveArtifactCommit ?? defaultArtifactCommit;
  const collectDiff =
    input.options.collectUnifiedDiff ?? defaultUnifiedDiff;

  const artifactCommit = await resolveCommit(worktree);
  const unifiedDiff = await collectDiff({ worktree, baseCommit });

  const requirementText = [
    ...input.contract.goals,
    ...(input.contract.nonGoals ?? []).map((g) => `non-goal: ${g}`),
  ].join("\n");

  const context = buildCleanReviewContext({
    artifactCommit,
    baseCommit,
    unifiedDiff,
    requirementRefs: [
      `contract:${input.contract.taskId}`,
      ...input.contract.readPaths.slice(0, 32),
    ],
    requirementText,
    evidenceRefs: input.options.evidenceRefs ?? [],
  });

  const session = createReviewSession({
    repoRoot,
    context,
    now: input.options.now,
  });

  const reviewer = input.options.reviewer ?? createFixtureReviewer();
  const reviewed = await reviewer.review(
    repoRoot,
    session.id,
    context,
    input.options.proposals,
  );

  const findingIds = reviewed.findings
    .map((f) => f.id)
    .slice(0, MAX_REVIEW_OBSERVATION_FINDING_IDS);
  const blockingCount = reviewed.findings.filter(
    (f) => f.severity === "blocking",
  ).length;

  return {
    reviewId: reviewed.id,
    contextHash: context.contextHash,
    findingCount: findingIds.length,
    blockingCount: Math.min(blockingCount, findingIds.length),
    findingIds,
  };
}

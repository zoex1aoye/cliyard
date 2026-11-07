/**
 * Opt-in queue admission gate over ProfileCatalog
 * (design/admission-queue-wire-v0.md).
 */
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import type { ExecutionProfile } from "../execution/profile.js";
import { admitHierarchical, effectiveProfilePermit } from "./admit.js";
import { getBindingCapacity, getProfile } from "./catalog.js";
import type {
  HierarchicalAdmissionDecision,
  HierarchicalAdmissionRequest,
} from "./types.js";

export interface QueueAdmissionOptions {
  /** Explicit enable. When omitted, `CLIYARD_ADMISSION=1` enables. */
  enabled?: boolean;
  /**
   * Optional finite global concurrent-item budget. null/undefined ⇒ scope
   * omitted (not treated as infinity).
   */
  globalTaskLimit?: number | null;
}

export interface QueueAdmissionItemView {
  id: string;
  status: string;
  executionProfile?: ExecutionProfile;
}

export interface EvaluateQueueAdmissionInput {
  repoRoot: string;
  /** Candidate about to dispatch (must still be pending). */
  candidate: QueueAdmissionItemView;
  /** Full queue snapshot used only for running-item counts. */
  items: readonly QueueAdmissionItemView[];
  options?: QueueAdmissionOptions;
}

export interface QueueAdmissionEvaluation {
  admitted: boolean;
  profileId: string | null;
  decision: HierarchicalAdmissionDecision | null;
  reasons: string[];
  code:
    | "admitted"
    | "admission_denied"
    | "profile_missing"
    | "profile_not_activated"
    | "disabled";
}

export interface AdmissionDecisionRecord {
  at: string;
  itemId: string;
  profileId: string | null;
  admitted: boolean;
  code: QueueAdmissionEvaluation["code"];
  reasons: string[];
  limitingScope?: string | null;
  effective?: number | null;
}

export function isQueueAdmissionEnabled(
  options: QueueAdmissionOptions | undefined,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (options?.enabled === true) return true;
  if (options?.enabled === false) return false;
  return env.CLIYARD_ADMISSION === "1" || env.CLIYARD_ADMISSION === "true";
}

export function admissionDecisionsPath(repoRoot: string): string {
  return join(repoRoot, ".cliyard", "admission", "decisions.jsonl");
}

export function appendAdmissionDecision(
  repoRoot: string,
  record: AdmissionDecisionRecord,
): string {
  const path = admissionDecisionsPath(repoRoot);
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify(record)}\n`, "utf8");
  return path;
}

function countRunning(
  items: readonly QueueAdmissionItemView[],
  profileId?: string,
): number {
  let n = 0;
  for (const item of items) {
    if (item.status !== "running") continue;
    if (profileId !== undefined) {
      if (item.executionProfile?.profileId !== profileId) continue;
    }
    n += 1;
  }
  return n;
}

/**
 * Evaluate whether one queue item may start under activated catalog capacity.
 * Does not mutate queue state. Deny is capacity/policy at the gate — caller
 * must leave the item pending (not permanently blocked).
 */
export function evaluateQueueAdmission(
  input: EvaluateQueueAdmissionInput,
): QueueAdmissionEvaluation {
  const profile = input.candidate.executionProfile;
  if (!profile) {
    return {
      admitted: false,
      profileId: null,
      decision: null,
      reasons: ["candidate has no executionProfile"],
      code: "profile_missing",
    };
  }

  const activated = getProfile(input.repoRoot, profile.profileId);
  if (!activated) {
    return {
      admitted: false,
      profileId: profile.profileId,
      decision: null,
      reasons: [
        `profile ${JSON.stringify(profile.profileId)} is not activated in ProfileCatalog`,
      ],
      code: "profile_not_activated",
    };
  }

  const capacity = getBindingCapacity(input.repoRoot, profile.profileId);
  const permit = effectiveProfilePermit(capacity ?? undefined);
  const profileInUse = countRunning(input.items, profile.profileId);
  const globalInUse = countRunning(input.items);

  const scopes: HierarchicalAdmissionRequest["scopes"] = [
    {
      name: "profilePermit",
      limit: permit,
      inUse: profileInUse,
    },
  ];

  const globalLimit = input.options?.globalTaskLimit;
  if (
    globalLimit !== undefined &&
    globalLimit !== null &&
    Number.isInteger(globalLimit) &&
    globalLimit >= 0
  ) {
    scopes.push({
      name: "globalTasks",
      limit: globalLimit,
      inUse: globalInUse,
    });
  }

  const decision = admitHierarchical({ scopes, request: 1 });
  return {
    admitted: decision.admitted,
    profileId: profile.profileId,
    decision,
    reasons: decision.reasons,
    code: decision.admitted ? "admitted" : "admission_denied",
  };
}

export function readAdmissionDecisions(
  repoRoot: string,
): AdmissionDecisionRecord[] {
  const path = admissionDecisionsPath(repoRoot);
  if (!existsSync(path)) return [];
  const lines = readFileSync(path, "utf8").split("\n").filter(Boolean);
  const out: AdmissionDecisionRecord[] = [];
  for (const line of lines) {
    try {
      out.push(JSON.parse(line) as AdmissionDecisionRecord);
    } catch {
      /* skip malformed observational lines */
    }
  }
  return out;
}

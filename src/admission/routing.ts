/**
 * Deterministic execution routing (Routing B)
 * (design/execution-routing-v0.md, PRODUCT_STRATEGY_V2 §3.1–3.2).
 *
 * Selects an activated ProfileCatalog binding only. Never dispatches.
 */
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import type {
  ExecutionProfile,
  ExecutionRuntimeId,
} from "../execution/profile.js";
import { effectiveProfilePermit } from "./admit.js";
import { getBindingCapacity, listProfiles } from "./catalog.js";

export class ExecutionRoutingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

export interface TaskRoutingRequirements {
  /** Prefer runtimes that map assistant/tool progress. */
  requireMappedProgress?: boolean;
  /** Prefer/require provider-session resume (budget continuation). */
  requireProviderSessionResume?: boolean;
  preferredRuntimeId?: ExecutionRuntimeId;
  preferredProviderId?: string;
  preferredModelId?: string;
}

export type RoutingDecisionCode =
  | "selected"
  | "no_activated_profiles"
  | "no_capability_match"
  | "no_capacity";

export interface RoutingCandidateView {
  profileId: string;
  runtimeId: ExecutionRuntimeId;
  modelId: string;
  providerId: string;
  score: number;
  excluded?: string;
}

export interface ExecutionRoutingDecision {
  code: RoutingDecisionCode;
  selected: ExecutionProfile | null;
  candidates: RoutingCandidateView[];
  reasons: string[];
}

export interface SelectExecutionProfileInput {
  repoRoot: string;
  requirements?: TaskRoutingRequirements;
  /**
   * When true, exclude profiles whose effective remaining permit is 0
   * (unknown capacity still allows the 1-probe). Uses catalog capacities
   * and optional inFlightOverrides; does not read the queue document.
   */
  respectAdmission?: boolean;
  /** Optional in-flight counts keyed by profileId (tests / callers). */
  inFlightByProfileId?: Readonly<Record<string, number>>;
}

function capabilityOk(
  profile: ExecutionProfile,
  requirements: TaskRoutingRequirements,
): string | null {
  if (
    requirements.requireMappedProgress === true &&
    !profile.capabilities.mappedProgress
  ) {
    return "missing mappedProgress";
  }
  if (
    requirements.requireProviderSessionResume === true &&
    !profile.capabilities.providerSessionResume
  ) {
    return "missing providerSessionResume";
  }
  return null;
}

function scoreProfile(
  profile: ExecutionProfile,
  requirements: TaskRoutingRequirements,
): number {
  let score = 0;
  if (
    requirements.preferredRuntimeId !== undefined &&
    profile.runtimeId === requirements.preferredRuntimeId
  ) {
    score += 4;
  }
  if (
    requirements.preferredProviderId !== undefined &&
    profile.providerId === requirements.preferredProviderId
  ) {
    score += 2;
  }
  if (
    requirements.preferredModelId !== undefined &&
    profile.modelId === requirements.preferredModelId
  ) {
    score += 1;
  }
  return score;
}

/**
 * Select one activated ExecutionProfile for execution attribution (Routing B).
 * Fail closed when the catalog is empty or no candidate matches.
 */
export function selectExecutionProfile(
  input: SelectExecutionProfileInput,
): ExecutionRoutingDecision {
  const requirements = input.requirements ?? {};
  const activated = listProfiles(input.repoRoot);
  const reasons: string[] = [];
  const candidates: RoutingCandidateView[] = [];

  if (activated.length === 0) {
    return {
      code: "no_activated_profiles",
      selected: null,
      candidates: [],
      reasons: ["ProfileCatalog has no activated profiles"],
    };
  }

  const eligible: { profile: ExecutionProfile; score: number }[] = [];
  let capabilityCompatible = 0;
  let admissionBlocked = 0;

  for (const profile of activated) {
    const capFail = capabilityOk(profile, requirements);
    if (capFail) {
      candidates.push({
        profileId: profile.profileId,
        runtimeId: profile.runtimeId,
        modelId: profile.modelId,
        providerId: profile.providerId,
        score: 0,
        excluded: capFail,
      });
      continue;
    }
    capabilityCompatible += 1;

    if (input.respectAdmission === true) {
      const capacity = getBindingCapacity(input.repoRoot, profile.profileId);
      const permit = effectiveProfilePermit(capacity ?? undefined);
      const inFlight =
        input.inFlightByProfileId?.[profile.profileId] ??
        capacity?.inFlight ??
        0;
      const remaining = Math.max(0, permit - inFlight);
      if (remaining < 1) {
        admissionBlocked += 1;
        candidates.push({
          profileId: profile.profileId,
          runtimeId: profile.runtimeId,
          modelId: profile.modelId,
          providerId: profile.providerId,
          score: 0,
          excluded: `admission remaining=0 (permit=${permit} inFlight=${inFlight})`,
        });
        continue;
      }
    }

    const score = scoreProfile(profile, requirements);
    eligible.push({ profile, score });
    candidates.push({
      profileId: profile.profileId,
      runtimeId: profile.runtimeId,
      modelId: profile.modelId,
      providerId: profile.providerId,
      score,
    });
  }

  if (eligible.length === 0) {
    const code: RoutingDecisionCode =
      capabilityCompatible > 0 && admissionBlocked === capabilityCompatible
        ? "no_capacity"
        : "no_capability_match";
    reasons.push(
      code === "no_capacity"
        ? "all capability-compatible profiles have zero remaining admission permit"
        : "no activated profile satisfies capability requirements",
    );
    for (const c of candidates) {
      if (c.excluded) reasons.push(`${c.profileId}: excluded (${c.excluded})`);
    }
    return { code, selected: null, candidates, reasons };
  }

  eligible.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a.profile.profileId.localeCompare(b.profile.profileId);
  });
  const winner = eligible[0]!;
  reasons.push(
    `selected ${winner.profile.profileId}` +
      ` (runtime=${winner.profile.runtimeId}` +
      ` model=${winner.profile.modelId}` +
      ` provider=${winner.profile.providerId}` +
      ` score=${winner.score})`,
  );
  if (eligible.length > 1) {
    reasons.push(
      `tie-break among ${eligible.length} eligible: highest score then profileId`,
    );
  }
  return {
    code: "selected",
    selected: winner.profile,
    candidates,
    reasons,
  };
}

export interface RoutingDecisionRecord {
  at: string;
  code: RoutingDecisionCode;
  selectedProfileId: string | null;
  reasons: string[];
  candidateProfileIds: string[];
}

export function routingDecisionsPath(repoRoot: string): string {
  return join(repoRoot, ".cliyard", "routing", "decisions.jsonl");
}

export function appendRoutingDecision(
  repoRoot: string,
  record: RoutingDecisionRecord,
): string {
  const path = routingDecisionsPath(repoRoot);
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify(record)}\n`, "utf8");
  return path;
}

export function readRoutingDecisions(
  repoRoot: string,
): RoutingDecisionRecord[] {
  const path = routingDecisionsPath(repoRoot);
  if (!existsSync(path)) return [];
  const lines = readFileSync(path, "utf8").split("\n").filter(Boolean);
  const out: RoutingDecisionRecord[] = [];
  for (const line of lines) {
    try {
      out.push(JSON.parse(line) as RoutingDecisionRecord);
    } catch {
      /* skip malformed observational lines */
    }
  }
  return out;
}

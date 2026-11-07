/**
 * Opt-in Routing B helpers for queue add / run
 * (design/routing-queue-wire-v0.md).
 */
import type {
  ExecutionProfile,
  ExecutionRuntimeId,
} from "../execution/profile.js";
import { getProfile } from "./catalog.js";
import {
  appendRoutingDecision,
  selectExecutionProfile,
  type ExecutionRoutingDecision,
  type TaskRoutingRequirements,
} from "./routing.js";

export interface QueueRoutingOptions {
  /** Explicit enable. When omitted, `CLIYARD_ROUTING=1` enables. */
  enabled?: boolean;
  /** When true on run, also require remaining admission permit. */
  respectAdmission?: boolean;
  requirements?: TaskRoutingRequirements;
}

export function isQueueRoutingEnabled(
  options: QueueRoutingOptions | undefined,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (options?.enabled === true) return true;
  if (options?.enabled === false) return false;
  return env.CLIYARD_ROUTING === "1" || env.CLIYARD_ROUTING === "true";
}

export interface ResolveRoutedExecutionProfileInput {
  repoRoot: string;
  worker?: ExecutionRuntimeId;
  model?: string;
  requirements?: TaskRoutingRequirements;
  respectAdmission?: boolean;
  inFlightByProfileId?: Readonly<Record<string, number>>;
  now?: () => string;
}

/**
 * Select an activated catalog profile for queue add when no profile file was
 * supplied. Fail closed — never invent a legacy profile under routing mode.
 */
export function resolveRoutedExecutionProfile(
  input: ResolveRoutedExecutionProfileInput,
): { profile: ExecutionProfile; decision: ExecutionRoutingDecision } {
  const requirements: TaskRoutingRequirements = {
    ...(input.requirements ?? {}),
    ...(input.worker !== undefined
      ? { preferredRuntimeId: input.worker }
      : {}),
    ...(input.model !== undefined && input.model.trim() !== ""
      ? { preferredModelId: input.model.trim() }
      : {}),
  };
  const decision = selectExecutionProfile({
    repoRoot: input.repoRoot,
    requirements,
    ...(input.respectAdmission !== undefined
      ? { respectAdmission: input.respectAdmission }
      : {}),
    ...(input.inFlightByProfileId !== undefined
      ? { inFlightByProfileId: input.inFlightByProfileId }
      : {}),
  });
  appendRoutingDecision(input.repoRoot, {
    at: (input.now ?? (() => new Date().toISOString()))(),
    code: decision.code,
    selectedProfileId: decision.selected?.profileId ?? null,
    reasons: decision.reasons,
    candidateProfileIds: decision.candidates.map((c) => c.profileId),
  });
  if (decision.code !== "selected" || !decision.selected) {
    throw new Error(
      `routing failed (${decision.code}): ${decision.reasons.join("; ")}`,
    );
  }
  return { profile: decision.selected, decision };
}

/**
 * Run-time gate: item profile must be activated. Optional admission remaining.
 */
export function evaluateQueueRoutingGate(input: {
  repoRoot: string;
  profile: ExecutionProfile | undefined;
  options?: QueueRoutingOptions;
  inFlightByProfileId?: Readonly<Record<string, number>>;
  now?: () => string;
}): {
  ok: boolean;
  code: string;
  reasons: string[];
  decision?: ExecutionRoutingDecision;
} {
  if (!input.profile) {
    return {
      ok: false,
      code: "profile_missing",
      reasons: ["queue item has no executionProfile"],
    };
  }
  const activated = getProfile(input.repoRoot, input.profile.profileId);
  if (!activated) {
    const reasons = [
      `profile ${JSON.stringify(input.profile.profileId)} is not activated in ProfileCatalog`,
    ];
    appendRoutingDecision(input.repoRoot, {
      at: (input.now ?? (() => new Date().toISOString()))(),
      code: "no_activated_profiles",
      selectedProfileId: null,
      reasons,
      candidateProfileIds: [],
    });
    return { ok: false, code: "profile_not_activated", reasons };
  }

  if (input.options?.respectAdmission === true) {
    const decision = selectExecutionProfile({
      repoRoot: input.repoRoot,
      requirements: {
        ...(input.options.requirements ?? {}),
        preferredRuntimeId: input.profile.runtimeId,
        preferredModelId: input.profile.modelId,
        preferredProviderId: input.profile.providerId,
      },
      respectAdmission: true,
      ...(input.inFlightByProfileId !== undefined
        ? { inFlightByProfileId: input.inFlightByProfileId }
        : {}),
    });
    appendRoutingDecision(input.repoRoot, {
      at: (input.now ?? (() => new Date().toISOString()))(),
      code: decision.code,
      selectedProfileId: decision.selected?.profileId ?? null,
      reasons: decision.reasons,
      candidateProfileIds: decision.candidates.map((c) => c.profileId),
    });
    if (
      decision.code !== "selected" ||
      decision.selected?.profileId !== input.profile.profileId
    ) {
      return {
        ok: false,
        code: decision.code === "no_capacity" ? "no_capacity" : "routing_mismatch",
        reasons: decision.reasons,
        decision,
      };
    }
    return { ok: true, code: "selected", reasons: decision.reasons, decision };
  }

  const reasons = [
    `activated profile ${input.profile.profileId} accepted for dispatch`,
  ];
  appendRoutingDecision(input.repoRoot, {
    at: (input.now ?? (() => new Date().toISOString()))(),
    code: "selected",
    selectedProfileId: input.profile.profileId,
    reasons,
    candidateProfileIds: [input.profile.profileId],
  });
  return { ok: true, code: "selected", reasons };
}

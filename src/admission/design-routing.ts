/**
 * Deterministic design elaborator attribution (Routing A)
 * (design/routing-a-design-v0.md, PRODUCT_STRATEGY_V2 §3.1).
 *
 * Selects an activated ProfileCatalog binding for Plan/design draft work.
 * Never freezes contracts, never dispatches workers, never ranks model
 * "strength" from brand or model names.
 */
import type {
  ExecutionProfile,
  ExecutionRuntimeId,
} from "../execution/profile.js";
import { listProfiles } from "./catalog.js";
import type {
  RoutingAttributionRole,
  RoutingCandidateView,
  RoutingDecisionCode,
} from "./routing.js";

export type DesignElaboratorMode = "routine" | "elevated";

export interface DesignRoutingRequirements {
  /**
   * Operator signal only. `elevated` does not invent a stronger model —
   * pass preferred* / preferredProfileId to choose the elaborator binding.
   */
  mode?: DesignElaboratorMode;
  preferredProfileId?: string;
  preferredRuntimeId?: ExecutionRuntimeId;
  preferredProviderId?: string;
  preferredModelId?: string;
}

export interface DesignRoutingDecision {
  code: RoutingDecisionCode;
  mode: DesignElaboratorMode;
  role: RoutingAttributionRole;
  selected: ExecutionProfile | null;
  candidates: RoutingCandidateView[];
  reasons: string[];
}

export interface SelectDesignElaboratorProfileInput {
  repoRoot: string;
  requirements?: DesignRoutingRequirements;
}

function scoreDesignProfile(
  profile: ExecutionProfile,
  requirements: DesignRoutingRequirements,
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
 * Select one activated ExecutionProfile for design elaborator attribution
 * (Routing A). Fail closed when the catalog is empty or preferredProfileId
 * is not activated. Does not invent strength ranks from model names.
 */
export function selectDesignElaboratorProfile(
  input: SelectDesignElaboratorProfileInput,
): DesignRoutingDecision {
  const requirements = input.requirements ?? {};
  const mode: DesignElaboratorMode = requirements.mode ?? "routine";
  const role: RoutingAttributionRole = "design-elaborator";
  const activated = listProfiles(input.repoRoot);
  const reasons: string[] = [
    `routing-a mode=${mode} (operator signal; no model-strength invention)`,
  ];

  if (activated.length === 0) {
    return {
      code: "no_activated_profiles",
      mode,
      role,
      selected: null,
      candidates: [],
      reasons: [
        ...reasons,
        "ProfileCatalog has no activated profiles",
      ],
    };
  }

  const preferredId = requirements.preferredProfileId?.trim();
  if (preferredId) {
    const exact = activated.find((p) => p.profileId === preferredId);
    const candidates: RoutingCandidateView[] = activated.map((profile) => ({
      profileId: profile.profileId,
      runtimeId: profile.runtimeId,
      modelId: profile.modelId,
      providerId: profile.providerId,
      score: profile.profileId === preferredId ? 100 : 0,
      ...(profile.profileId === preferredId
        ? {}
        : { excluded: "not preferredProfileId" }),
    }));
    if (!exact) {
      reasons.push(
        `preferredProfileId ${JSON.stringify(preferredId)} is not activated`,
      );
      return {
        code: "no_capability_match",
        mode,
        role,
        selected: null,
        candidates,
        reasons,
      };
    }
    reasons.push(
      `selected ${exact.profileId} by preferredProfileId` +
        ` (runtime=${exact.runtimeId} model=${exact.modelId}` +
        ` provider=${exact.providerId})`,
    );
    return {
      code: "selected",
      mode,
      role,
      selected: exact,
      candidates,
      reasons,
    };
  }

  if (
    mode === "elevated" &&
    requirements.preferredRuntimeId === undefined &&
    requirements.preferredProviderId === undefined &&
    requirements.preferredModelId === undefined
  ) {
    reasons.push(
      "elevated mode requires preferredRuntimeId, preferredProviderId," +
        " preferredModelId, or preferredProfileId" +
        " (control plane will not invent a stronger model)",
    );
    return {
      code: "no_capability_match",
      mode,
      role,
      selected: null,
      candidates: activated.map((profile) => ({
        profileId: profile.profileId,
        runtimeId: profile.runtimeId,
        modelId: profile.modelId,
        providerId: profile.providerId,
        score: 0,
        excluded: "elevated without operator preference",
      })),
      reasons,
    };
  }

  const eligible: { profile: ExecutionProfile; score: number }[] = [];
  const candidates: RoutingCandidateView[] = [];
  for (const profile of activated) {
    const score = scoreDesignProfile(profile, requirements);
    eligible.push({ profile, score });
    candidates.push({
      profileId: profile.profileId,
      runtimeId: profile.runtimeId,
      modelId: profile.modelId,
      providerId: profile.providerId,
      score,
    });
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
    mode,
    role,
    selected: winner.profile,
    candidates,
    reasons,
  };
}

/**
 * HumanInterventionEvent model
 * (design/intervention-ledger-v0.md, continuous-harness-v2).
 *
 * Observational only — never grants acceptance, merge, or Plan approval.
 */
export const INTERVENTION_ROLES = [
  "retry",
  "judge",
  "approve",
  "carry",
  "trigger",
  "stand-in",
] as const;

export type InterventionRole = (typeof INTERVENTION_ROLES)[number];

export const INTERVENTION_OUTCOMES = [
  "unresolved",
  "resolved",
  "rejected",
  "obsolete",
] as const;

export type InterventionOutcome = (typeof INTERVENTION_OUTCOMES)[number];

export interface HumanInterventionEvent {
  version: 1;
  id: string;
  runId?: string;
  loopId: string;
  role: InterventionRole;
  reason: string;
  outcome: InterventionOutcome;
  artifactRef?: string;
  observedAt: string;
  resolvedAt?: string;
  resolutionNote?: string;
}

export function isInterventionRole(value: unknown): value is InterventionRole {
  return (
    typeof value === "string" &&
    (INTERVENTION_ROLES as readonly string[]).includes(value)
  );
}

export function isInterventionOutcome(
  value: unknown,
): value is InterventionOutcome {
  return (
    typeof value === "string" &&
    (INTERVENTION_OUTCOMES as readonly string[]).includes(value)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function isHumanInterventionEvent(
  value: unknown,
): value is HumanInterventionEvent {
  if (!isRecord(value)) return false;
  if (value.version !== 1) return false;
  if (typeof value.id !== "string" || value.id.trim() === "") return false;
  if (value.runId !== undefined && typeof value.runId !== "string") return false;
  if (typeof value.loopId !== "string" || value.loopId.trim() === "") return false;
  if (!isInterventionRole(value.role)) return false;
  if (typeof value.reason !== "string" || value.reason.trim() === "") return false;
  if (!isInterventionOutcome(value.outcome)) return false;
  if (value.artifactRef !== undefined && typeof value.artifactRef !== "string") {
    return false;
  }
  if (typeof value.observedAt !== "string") return false;
  if (value.resolvedAt !== undefined && typeof value.resolvedAt !== "string") {
    return false;
  }
  if (
    value.resolutionNote !== undefined &&
    typeof value.resolutionNote !== "string"
  ) {
    return false;
  }
  return true;
}

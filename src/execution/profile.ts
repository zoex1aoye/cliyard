/**
 * Versioned, secret-free execution identity for a queue item.
 *
 * Capabilities are derived from the runtime implementation, never accepted as
 * an assertion from a profile file. Unknown fields, including credential-like
 * fields and endpoint URLs, are rejected so they cannot become queue state.
 */
import { createHash } from "node:crypto";
import {
  parseQueueContinuationPolicy,
  summarizeQueueContinuationPolicy,
  type QueueContinuationPolicy,
  type QueueContinuationPolicySummary,
} from "../agents/continuation.js";

export {
  continuationPolicyToSupervisorArgs,
  parseQueueContinuationPolicy,
  parseQueueContinuationPolicyJson,
  summarizeQueueContinuationPolicy,
  type BudgetContinuationPolicy,
  type DeadlineExtensionPolicy,
  type QueueContinuationPolicy,
  type QueueContinuationPolicySummary,
} from "../agents/continuation.js";

export const EXECUTION_PROFILE_VERSION = 1 as const;
export const MAX_EXECUTION_PROFILE_ID_LENGTH = 128;
export const MAX_EXECUTION_MODEL_ID_LENGTH = 128;
export const MAX_EXECUTION_PROVIDER_ID_LENGTH = 128;
export const MAX_EXECUTION_REF_LENGTH = 128;

export type ExecutionRuntimeId = "claude" | "codex";

export interface ExecutionCapabilities {
  /** Maps Claude assistant/tool stream records to meaningful progress. */
  mappedProgress: boolean;
  /** Can resume the exact provider conversation after budget exhaustion. */
  providerSessionResume: boolean;
}

export interface ExecutionProfile {
  version: typeof EXECUTION_PROFILE_VERSION;
  profileId: string;
  runtimeId: ExecutionRuntimeId;
  modelId: string;
  providerId: string;
  /** Opaque credential/endpoint reference; never a URL or secret. */
  endpointRef?: string;
  /** Opaque account/subscription binding reference; never account data. */
  accountBindingId?: string;
  capabilities: ExecutionCapabilities;
}

export const DEFAULT_EXECUTION_MODELS: Readonly<
  Record<ExecutionRuntimeId, string>
> = Object.freeze({
  claude: "deepseek-flash",
  codex: "deepseek-v4-pro",
});

export const DEFAULT_EXECUTION_ENDPOINT_REFS: Readonly<
  Record<ExecutionRuntimeId, string>
> = Object.freeze({
  claude: "deepseek-claude-default",
  codex: "deepseek-codex-default",
});

export interface CreateExecutionProfileInput {
  profileId?: string;
  runtimeId: ExecutionRuntimeId;
  modelId?: string;
  providerId?: string;
  endpointRef?: string;
  accountBindingId?: string;
}

export interface ExecutionProfileEventFields {
  executionProfileId?: string;
  runtimeId?: ExecutionRuntimeId;
  modelId?: string;
  providerId?: string;
  mappedProgress?: boolean;
  providerSessionResume?: boolean;
  deadlineAutoExtend?: boolean;
  deadlineMaxExtensions?: number;
  budgetAutoContinue?: boolean;
  budgetMaxContinuations?: number;
}

export interface ExecutionPolicyCompatibility {
  ok: boolean;
  code?: string;
  reason?: string;
}

const PROFILE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const MODEL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:+/[\]-]{0,127}$/;
const OPAQUE_REF_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export function executionCapabilitiesForRuntime(
  runtimeId: ExecutionRuntimeId,
): ExecutionCapabilities {
  return runtimeId === "claude"
    ? Object.freeze({
        mappedProgress: true,
        providerSessionResume: true,
      })
    : Object.freeze({
        mappedProgress: false,
        providerSessionResume: false,
      });
}

/**
 * Parse a profile file or persisted queue profile. Existing capabilities are
 * accepted only when they exactly equal the runtime-derived values.
 */
export function parseExecutionProfile(
  value: unknown,
): ExecutionProfile | undefined {
  if (!isRecord(value)) return undefined;
  if (
    !hasOnlyKeys(value, [
      "version",
      "profileId",
      "runtimeId",
      "modelId",
      "providerId",
      "endpointRef",
      "accountBindingId",
      "capabilities",
    ])
  ) {
    return undefined;
  }
  if (
    value.version !== EXECUTION_PROFILE_VERSION ||
    !isProfileId(value.profileId) ||
    !isExecutionRuntime(value.runtimeId) ||
    !isModelId(value.modelId) ||
    !isOpaqueRef(value.providerId)
  ) {
    return undefined;
  }
  if (
    value.endpointRef !== undefined &&
    !isOpaqueRef(value.endpointRef)
  ) {
    return undefined;
  }
  if (
    value.accountBindingId !== undefined &&
    !isOpaqueRef(value.accountBindingId)
  ) {
    return undefined;
  }

  const runtimeId = value.runtimeId;
  const capabilities = executionCapabilitiesForRuntime(runtimeId);
  if (value.capabilities !== undefined) {
    if (
      !isRecord(value.capabilities) ||
      !hasOnlyKeys(value.capabilities, [
        "mappedProgress",
        "providerSessionResume",
      ]) ||
      value.capabilities.mappedProgress !== capabilities.mappedProgress ||
      value.capabilities.providerSessionResume !==
        capabilities.providerSessionResume
    ) {
      return undefined;
    }
  }

  return Object.freeze({
    version: EXECUTION_PROFILE_VERSION,
    profileId: value.profileId,
    runtimeId,
    modelId: value.modelId,
    providerId: value.providerId,
    ...(value.endpointRef !== undefined
      ? { endpointRef: value.endpointRef }
      : {}),
    ...(value.accountBindingId !== undefined
      ? { accountBindingId: value.accountBindingId }
      : {}),
    capabilities,
  });
}

export function parseExecutionProfileJson(
  text: string,
): ExecutionProfile | undefined {
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
  return parseExecutionProfile(value);
}

/**
 * Derive the profile used when queue add is given only worker/model flags.
 * No environment variable participates in this normalization.
 */
export function createLegacyExecutionProfile(
  input: CreateExecutionProfileInput,
): ExecutionProfile {
  if (!isExecutionRuntime(input.runtimeId)) {
    throw new Error(`unsupported execution runtime: ${String(input.runtimeId)}`);
  }
  const modelId = input.modelId ?? DEFAULT_EXECUTION_MODELS[input.runtimeId];
  const providerId = input.providerId ?? "deepseek";
  const endpointRef =
    input.endpointRef ?? DEFAULT_EXECUTION_ENDPOINT_REFS[input.runtimeId];
  const profileId =
    input.profileId ??
    deriveExecutionProfileId({
      runtimeId: input.runtimeId,
      modelId,
      providerId,
      endpointRef,
      ...(input.accountBindingId !== undefined
        ? { accountBindingId: input.accountBindingId }
        : {}),
    });
  const parsed = parseExecutionProfile({
    version: EXECUTION_PROFILE_VERSION,
    profileId,
    runtimeId: input.runtimeId,
    modelId,
    providerId,
    endpointRef,
    ...(input.accountBindingId !== undefined
      ? { accountBindingId: input.accountBindingId }
      : {}),
  });
  if (!parsed) {
    throw new Error("derived execution profile is invalid");
  }
  return parsed;
}

export function deriveExecutionProfileId(input: {
  runtimeId: ExecutionRuntimeId;
  modelId: string;
  providerId: string;
  endpointRef?: string;
  accountBindingId?: string;
}): string {
  const canonical = JSON.stringify({
    version: EXECUTION_PROFILE_VERSION,
    runtimeId: input.runtimeId,
    modelId: input.modelId,
    providerId: input.providerId,
    endpointRef: input.endpointRef ?? null,
    accountBindingId: input.accountBindingId ?? null,
  });
  const digest = createHash("sha256").update(canonical).digest("hex");
  return `queue-${input.runtimeId}-${digest.slice(0, 20)}`;
}

/** Exact mirror validation used when loading and immediately before dispatch. */
export function executionProfileMirrorReason(
  profile: ExecutionProfile | undefined,
  worker: string,
  model: string | undefined,
): string | undefined {
  if (!profile) return undefined;
  const parsed = parseExecutionProfile(profile);
  if (!parsed) return "executionProfile is not a valid v1 profile";
  if (worker !== parsed.runtimeId) {
    return (
      `worker ${JSON.stringify(worker)} does not match execution profile ` +
      `runtimeId ${JSON.stringify(parsed.runtimeId)}`
    );
  }
  if (model !== parsed.modelId) {
    return (
      `model ${JSON.stringify(model)} does not match execution profile ` +
      `modelId ${JSON.stringify(parsed.modelId)}`
    );
  }
  return undefined;
}

/**
 * Read-only capability gate. It never changes the item, policy, environment or
 * Supervisor state; the queue persists only a pre-dispatch failure when this
 * returns incompatible.
 */
export function checkExecutionPolicyCompatibility(
  profileValue: ExecutionProfile | undefined,
  policyValue: QueueContinuationPolicy | undefined,
): ExecutionPolicyCompatibility {
  if (!profileValue) {
    if (policyValue !== undefined) {
      return {
        ok: false,
        code: "execution_profile_required",
        reason: "continuationPolicy requires a frozen executionProfile",
      };
    }
    return { ok: true };
  }
  const profile = parseExecutionProfile(profileValue);
  if (!profile) {
    return {
      ok: false,
      code: "invalid_execution_profile",
      reason: "executionProfile is not a valid v1 profile",
    };
  }
  if (policyValue === undefined) return { ok: true };
  const policy = parseQueueContinuationPolicy(policyValue);
  if (!policy) {
    return {
      ok: false,
      code: "invalid_continuation_policy",
      reason: "continuationPolicy is not a valid v1 queue policy",
    };
  }
  if (
    policy.deadlineExtension?.autoExtend === true &&
    !profile.capabilities.mappedProgress
  ) {
    return {
      ok: false,
      code: "mapped_progress_required",
      reason:
        `execution profile ${profile.profileId} cannot auto-extend its ` +
        "deadline without mapped assistant/tool progress",
    };
  }
  if (
    policy.budgetContinuation !== undefined &&
    (profile.runtimeId === "codex" ||
      !profile.capabilities.providerSessionResume)
  ) {
    return {
      ok: false,
      code: "provider_session_resume_required",
      reason:
        `execution profile ${profile.profileId} cannot use budget ` +
        "continuation because provider-session resume is unavailable",
    };
  }
  return { ok: true };
}

export function executionProfileEventFields(
  profile: ExecutionProfile | undefined,
  policy: QueueContinuationPolicy | undefined,
): ExecutionProfileEventFields {
  if (!profile) return {};
  const parsed = parseExecutionProfile(profile);
  if (!parsed) return {};
  const summary = summarizeQueueContinuationPolicy(policy);
  return {
    executionProfileId: parsed.profileId,
    runtimeId: parsed.runtimeId,
    modelId: parsed.modelId,
    providerId: parsed.providerId,
    mappedProgress: parsed.capabilities.mappedProgress,
    providerSessionResume: parsed.capabilities.providerSessionResume,
    ...(summary?.deadlineExtension
      ? {
          deadlineAutoExtend: summary.deadlineExtension.autoExtend,
          deadlineMaxExtensions:
            summary.deadlineExtension.maxExtensions,
        }
      : {}),
    ...(summary?.budgetContinuation
      ? {
          budgetAutoContinue: summary.budgetContinuation.autoContinue,
          budgetMaxContinuations:
            summary.budgetContinuation.maxContinuations,
        }
      : {}),
  };
}

export function summarizeExecutionProfile(
  profile: ExecutionProfile | undefined,
): string {
  if (!profile) return "legacy worker/model";
  return (
    `${profile.profileId} ${profile.runtimeId}/${profile.modelId} ` +
    `provider=${profile.providerId} ` +
    `mappedProgress=${String(profile.capabilities.mappedProgress)} ` +
    `providerSessionResume=${String(
      profile.capabilities.providerSessionResume,
    )}`
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
): boolean {
  const allowedSet = new Set(allowed);
  return Object.keys(value).every((key) => allowedSet.has(key));
}

function isExecutionRuntime(value: unknown): value is ExecutionRuntimeId {
  return value === "claude" || value === "codex";
}

function isProfileId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    PROFILE_ID_PATTERN.test(value) &&
    !looksLikeSecret(value)
  );
}

function isModelId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= MAX_EXECUTION_MODEL_ID_LENGTH &&
    MODEL_ID_PATTERN.test(value) &&
    !value.includes("://")
  );
}

function isOpaqueRef(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= MAX_EXECUTION_REF_LENGTH &&
    OPAQUE_REF_PATTERN.test(value) &&
    !value.includes("://") &&
    !looksLikeSecret(value)
  );
}

function looksLikeSecret(value: string): boolean {
  const lower = value.toLowerCase();
  return (
    lower.includes("apikey") ||
    lower.includes("api_key") ||
    lower.includes("secret") ||
    lower.startsWith("sk-") ||
    lower.startsWith("sk_") ||
    lower.includes("bearer")
  );
}

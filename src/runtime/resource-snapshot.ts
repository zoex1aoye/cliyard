/**
 * Non-authoritative host/provider capacity observations used by the queue
 * control projection (design/dynamic-parallel-admission-v0.md).
 *
 * Missing data stays explicit. A provider's public concurrency, quota, price
 * or balance is never filled in from a model-name lookup here.
 */
import {
  cpus,
  freemem,
  hostname,
  loadavg,
  totalmem,
} from "node:os";

export const RESOURCE_SNAPSHOT_VERSION = 1 as const;

export type Unknownable<T> = T | null;

export interface ProviderCapacitySnapshot {
  executionProfileId: string;
  runtimeId: string;
  modelId: string | null;
  observedInFlight: number | null;
  capacity: {
    configuredMax: number | null;
    learnedSafeInFlight: number | null;
    limitSource:
      | "operator"
      | "provider-reported"
      | "observed"
      | "unknown";
    confidence: "none" | "low" | "medium" | "high";
  };
  recent429: number | null;
  recentRetryAfterMs: number | null;
  quota: StatefulValue;
  balance: StatefulValue;
  pricing: PricingState;
}

export interface StatefulValue {
  state: "known" | "unknown" | "stale" | "unsupported";
  remaining?: number;
  unit?: string;
  currency?: string;
  observedAt?: string;
}

export interface PricingState {
  state: "known" | "unknown" | "stale" | "unsupported";
  inputPerMillion?: number;
  outputPerMillion?: number;
  currency?: string;
  observedAt?: string;
}

export interface ResourceSnapshot {
  version: typeof RESOURCE_SNAPSHOT_VERSION;
  at: string;
  host: string;
  cpu: {
    logicalCpus: number;
    load1: Unknownable<number>;
    load5: Unknownable<number>;
    load15: Unknownable<number>;
    source: "node-os" | "unknown";
  };
  memory: {
    totalBytes: Unknownable<number>;
    freeBytes: Unknownable<number>;
    availableBytesEstimate: Unknownable<number>;
    pressure: "normal" | "warning" | "critical" | "unknown";
    swapUsedBytes: Unknownable<number>;
    source: "node-os" | "unknown";
  };
  runtime: {
    activeTaskAttempts: Unknownable<number>;
    activeRuntimeServices: Unknownable<number>;
    activeBrowsers: Unknownable<number>;
    leasedPorts: Unknownable<number>;
  };
  provider: ProviderCapacitySnapshot[];
  limitations: string[];
}

export interface ResourceSampleOptions {
  at?: Date;
  provider?: ProviderCapacitySnapshot[];
  runtime?: Partial<ResourceSnapshot["runtime"]>;
}

/**
 * Sample non-authoritative host metrics. `freeBytes` is a conservative lower
 * bound, not an availability claim; platform memory pressure remains unknown
 * until a host adapter measures it.
 */
export function sampleResourceSnapshot(
  options: ResourceSampleOptions = {},
): ResourceSnapshot {
  const at = options.at ?? new Date();
  const logicalCpus = cpus().length;
  const loads = process.platform === "win32" ? null : loadavg();
  const freeBytes = freemem();
  const totalBytes = totalmem();

  return {
    version: RESOURCE_SNAPSHOT_VERSION,
    at: at.toISOString(),
    host: hostname(),
    cpu: {
      logicalCpus,
      load1: loads?.[0] ?? null,
      load5: loads?.[1] ?? null,
      load15: loads?.[2] ?? null,
      source: loads === null ? "unknown" : "node-os",
    },
    memory: {
      totalBytes,
      freeBytes,
      availableBytesEstimate: freeBytes,
      pressure: "unknown",
      swapUsedBytes: null,
      source: "node-os",
    },
    runtime: {
      activeTaskAttempts: null,
      activeRuntimeServices: null,
      activeBrowsers: null,
      leasedPorts: null,
      ...options.runtime,
    },
    provider: (options.provider ?? []).map((entry) => ({
      ...entry,
      capacity: { ...entry.capacity },
      quota: { ...entry.quota },
      balance: { ...entry.balance },
      pricing: { ...entry.pricing },
    })),
    limitations: [
      "memory pressure and swap are not measured by the portable sampler",
      "runtime, browser and port counts require a runtime lease projection",
      "provider capacity, quota, balance and pricing are binding-specific and may be unknown",
    ],
  };
}

/**
 * An unresolved queue worker/model pair. It deliberately has no endpoint,
 * public concurrency, price or balance defaults.
 */
export function unresolvedProviderCapacity(
  runtimeId: string,
  modelId: string | null,
  observedInFlight: number | null,
): ProviderCapacitySnapshot {
  const model = modelId ?? "<cli-default>";
  return {
    executionProfileId: `unresolved:${runtimeId}:${model}`,
    runtimeId,
    modelId,
    observedInFlight,
    capacity: {
      configuredMax: null,
      learnedSafeInFlight: null,
      limitSource: "unknown",
      confidence: "none",
    },
    recent429: null,
    recentRetryAfterMs: null,
    quota: { state: "unknown" },
    balance: { state: "unknown" },
    pricing: { state: "unknown" },
  };
}

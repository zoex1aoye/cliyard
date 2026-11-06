/**
 * Curated, non-authoritative CLI cost telemetry for estimate-plan guards.
 *
 * Samples come from committed evidence documents. They are never provider
 * invoices, balances or quotas. Production CostTruth remains the run authority.
 */
import type { TaskSize } from "./estimate.js";

export const ESTIMATE_TELEMETRY_VERSION = 1 as const;
export const ESTIMATE_GUARD_MARGIN = 1.25;
export const ESTIMATE_GUARD_MIN_SAMPLES = 3;

export type EstimateCalibrationConfidence = "low" | "medium" | "high";
export type EstimateCalibrationBasis =
  | "telemetry-p75-margin"
  | "static-floor-cold-start";

export interface EstimateCostSample {
  id: string;
  size: TaskSize;
  /** Claude CLI total_cost_usd style observation; never authoritative. */
  cliEstimatedUsd: number;
  authoritative: false;
  source: "cli";
  /** Repo-relative evidence path that documents the observation. */
  evidencePath: string;
  notes?: string;
}

export interface GuardCalibration {
  size: TaskSize;
  guardBudgetUsd: number;
  staticFloorUsd: number;
  p75Usd: number | null;
  margin: number;
  sampleSize: number;
  confidence: EstimateCalibrationConfidence;
  basis: EstimateCalibrationBasis;
  usedStaticFloor: boolean;
  evidencePaths: string[];
}

/** Static floors retained as cold-start / never-under-cut baselines. */
export const STATIC_GUARD_FLOOR_USD: Record<TaskSize, number> = {
  S: 1,
  M: 4,
  L: 8,
  XL: 12,
};

/**
 * Hand-curated samples from docs/evidence. Amounts are cli-estimated USD.
 * Size labels mirror the heuristic classifier buckets used by estimate-plan.
 */
export const ESTIMATE_COST_SAMPLES: readonly EstimateCostSample[] = [
  {
    id: "attempt-continuity-smoke-a",
    size: "S",
    cliEstimatedUsd: 0.139976,
    authoritative: false,
    source: "cli",
    evidencePath: "docs/evidence/ATTEMPT_CONTINUITY_PROGRESS.md",
    notes: "Accepted continuity smoke attempt.",
  },
  {
    id: "attempt-continuity-smoke-b",
    size: "S",
    cliEstimatedUsd: 0.161518,
    authoritative: false,
    source: "cli",
    evidencePath: "docs/evidence/ATTEMPT_CONTINUITY_PROGRESS.md",
    notes: "Accepted continuity follow-up attempt.",
  },
  {
    id: "winui-foundation",
    size: "M",
    cliEstimatedUsd: 2.17,
    authoritative: false,
    source: "cli",
    evidencePath: "docs/TASK_ESTIMATION.md",
    notes: "WinUI Foundation accepted attempt.",
  },
  {
    id: "winui-textfield",
    size: "M",
    cliEstimatedUsd: 3.23,
    authoritative: false,
    source: "cli",
    evidencePath: "docs/TASK_ESTIMATION.md",
    notes: "WinUI TextField accepted attempt.",
  },
  {
    id: "failure-cost-docs",
    size: "M",
    cliEstimatedUsd: 4.883416,
    authoritative: false,
    source: "cli",
    evidencePath: "docs/evidence/FAILURE_COST_TRUTH.md",
    notes: "Docs attempt exhausted a $5 guard.",
  },
  {
    id: "ledger-event-cutover",
    size: "M",
    cliEstimatedUsd: 5.259895,
    authoritative: false,
    source: "cli",
    evidencePath: "docs/evidence/STATESTORE_WRITE_CUTOVER.md",
  },
  {
    id: "task-budget-ledger",
    size: "M",
    cliEstimatedUsd: 5.338021,
    authoritative: false,
    source: "cli",
    evidencePath: "docs/evidence/PILOT_FOUNDATION_RELIABILITY.md",
  },
  {
    id: "nested-registry-live-cleanup",
    size: "L",
    cliEstimatedUsd: 6.445692,
    authoritative: false,
    source: "cli",
    evidencePath: "docs/evidence/NESTED_REGISTRY_LIVE_CLEANUP_V1_2.md",
  },
  {
    id: "winui-button",
    size: "L",
    cliEstimatedUsd: 7.05,
    authoritative: false,
    source: "cli",
    evidencePath: "docs/TASK_ESTIMATION.md",
    notes: "WinUI Button accepted attempt.",
  },
  {
    id: "statestore-write-api",
    size: "L",
    cliEstimatedUsd: 8.022892,
    authoritative: false,
    source: "cli",
    evidencePath: "docs/evidence/STATESTORE_WRITE_CUTOVER.md",
  },
  {
    id: "queue-execution-profile",
    size: "L",
    cliEstimatedUsd: 9.325543,
    authoritative: false,
    source: "cli",
    evidencePath: "docs/evidence/QUEUE_EXECUTION_PROFILE.md",
  },
  {
    id: "failure-cost-durable",
    size: "L",
    cliEstimatedUsd: 9.939564,
    authoritative: false,
    source: "cli",
    evidencePath: "docs/evidence/FAILURE_COST_TRUTH.md",
    notes: "Durable failure/cost attempt exhausted a $10 guard.",
  },
  {
    id: "queue-write-cutover",
    size: "L",
    cliEstimatedUsd: 10.392325,
    authoritative: false,
    source: "cli",
    evidencePath: "docs/evidence/STATESTORE_WRITE_CUTOVER.md",
  },
  {
    id: "supervisor-write-cutover",
    size: "XL",
    cliEstimatedUsd: 12.00335,
    authoritative: false,
    source: "cli",
    evidencePath: "docs/evidence/STATESTORE_WRITE_CUTOVER.md",
    notes: "Largest cutover task; single XL sample so cold-start still applies.",
  },
];

export function samplesForSize(
  size: TaskSize,
  samples: readonly EstimateCostSample[] = ESTIMATE_COST_SAMPLES,
): EstimateCostSample[] {
  return samples.filter((sample) => sample.size === size);
}

/** Inclusive percentile on a sorted copy; empty input returns null. */
export function percentile(
  values: readonly number[],
  p: number,
): number | null {
  if (values.length === 0) return null;
  if (!Number.isFinite(p) || p < 0 || p > 100) {
    throw new Error(`percentile p must be in [0, 100], got ${p}`);
  }
  const sorted = [...values].sort((a, b) => a - b);
  if (sorted.length === 1) return sorted[0]!;
  const rank = (p / 100) * (sorted.length - 1);
  const low = Math.floor(rank);
  const high = Math.ceil(rank);
  if (low === high) return sorted[low]!;
  const weight = rank - low;
  return sorted[low]! * (1 - weight) + sorted[high]! * weight;
}

export function roundMoney(value: number): number {
  return Math.round(value * 100) / 100;
}

export function calibrateGuardUsd(
  size: TaskSize,
  options: {
    samples?: readonly EstimateCostSample[];
    margin?: number;
    minSamples?: number;
  } = {},
): GuardCalibration {
  const samples = samplesForSize(size, options.samples ?? ESTIMATE_COST_SAMPLES);
  const margin = options.margin ?? ESTIMATE_GUARD_MARGIN;
  const minSamples = options.minSamples ?? ESTIMATE_GUARD_MIN_SAMPLES;
  const staticFloorUsd = STATIC_GUARD_FLOOR_USD[size];
  const amounts = samples.map((sample) => sample.cliEstimatedUsd);
  const p75Usd = percentile(amounts, 75);
  const evidencePaths = [
    ...new Set(samples.map((sample) => sample.evidencePath)),
  ].sort();

  if (p75Usd === null || samples.length < minSamples) {
    return {
      size,
      guardBudgetUsd: staticFloorUsd,
      staticFloorUsd,
      p75Usd,
      margin,
      sampleSize: samples.length,
      confidence: "low",
      basis: "static-floor-cold-start",
      usedStaticFloor: true,
      evidencePaths,
    };
  }

  const calibrated = roundMoney(p75Usd * margin);
  const guardBudgetUsd = Math.max(staticFloorUsd, calibrated);
  const confidence: EstimateCalibrationConfidence =
    samples.length >= 6 ? "high" : "medium";

  return {
    size,
    guardBudgetUsd,
    staticFloorUsd,
    p75Usd: roundMoney(p75Usd),
    margin,
    sampleSize: samples.length,
    confidence,
    basis: "telemetry-p75-margin",
    usedStaticFloor: guardBudgetUsd === staticFloorUsd && calibrated <= staticFloorUsd,
    evidencePaths,
  };
}

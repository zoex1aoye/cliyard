import type { TaskContract } from "../contracts/schema.js";
import { compilePlan } from "./plan.js";

export type TaskSize = "S" | "M" | "L" | "XL";

export interface NumericRange {
  min: number;
  max: number;
}

export interface TaskEstimate {
  taskId: string;
  size: TaskSize;
  score: number;
  turns: NumericRange;
  wallMinutes: NumericRange;
  outputTokens: NumericRange;
  guardBudgetUsd: number;
  apiCostCnyOffPeak: NumericRange;
  apiCostCnyPeak: NumericRange;
  recommendedMaxRepairs: number;
  drivers: string[];
  recommendation: string;
}

export interface PlanEstimate {
  planId: string;
  tasks: TaskEstimate[];
  totalGuardBudgetUsd: number;
  totalApiCostCnyOffPeak: NumericRange;
  totalApiCostCnyPeak: NumericRange;
  notes: string[];
}

const STATE_TERMS =
  /\b(loading|disabled|hover|focus|pressed|error|readonly|success|warning|reduced-motion|forced-colors)\b/gi;

export function estimatePlan(raw: unknown): PlanEstimate {
  const plan = compilePlan(raw, { baseCommit: "HEAD" });
  const tasks = plan.contracts.map(estimateTask);
  return {
    planId: plan.planId,
    tasks,
    totalGuardBudgetUsd: sum(tasks.map((task) => task.guardBudgetUsd)),
    totalApiCostCnyOffPeak: sumRanges(
      tasks.map((task) => task.apiCostCnyOffPeak),
    ),
    totalApiCostCnyPeak: sumRanges(tasks.map((task) => task.apiCostCnyPeak)),
    notes: [
      "Heuristic ranges, not a quote.",
      "guardBudgetUsd is the local Claude --max-budget-usd guard and is deliberately conservative.",
      "DeepSeek API cost uses deepseek-flash public prices: off-peak is half of peak.",
      "Ranges are calibrated from the first WinUI 3 Key Mind run and should be replaced by empirical history per task type.",
    ],
  };
}

export function estimateTask(contract: TaskContract): TaskEstimate {
  const text = [
    ...contract.goals,
    ...(contract.nonGoals ?? []),
    ...(contract.forbidden ?? []),
    ...contract.verifyCommands,
    ...contract.readPaths,
    ...contract.writePaths,
  ].join("\n");
  const normalized = text.toLowerCase();
  const positiveGoals = contract.goals
    .join("\n")
    .replace(/\b(do not|don't|never)\b[^.;\n]*/gi, "")
    .toLowerCase();
  const drivers: string[] = [];
  let score = 5;

  score += contract.writePaths.length * 3;
  if (contract.writePaths.length > 0) {
    drivers.push(`${contract.writePaths.length} write paths`);
  }
  score += contract.verifyCommands.length * 1.5;
  if (contract.verifyCommands.length > 0) {
    drivers.push(`${contract.verifyCommands.length} verify commands`);
  }
  score += Math.min(contract.readPaths.length, 8) * 0.3;
  if (contract.readPaths.length >= 5) {
    drivers.push(`${contract.readPaths.length} read paths`);
  }

  const words = text.split(/\s+|[\u4e00-\u9fff]/).filter(Boolean).length;
  score += Math.min(5, words / 80);

  if (/\b(foundation|token|theme|material|palette)\b/.test(positiveGoals)) {
    score += 10;
    drivers.push("foundation/theme work");
  }
  if (/\b(component|wrapper|tdesign|vue|props|slots)\b/.test(positiveGoals)) {
    score += 7;
    drivers.push("component implementation");
  }
  if (/\b(demo|lab|gallery|story)\b/.test(positiveGoals)) {
    score += 6;
    drivers.push("demo/lab coverage");
  }
  if (/\b(assembly|integrat|barrel|export|converge)\b/.test(positiveGoals)) {
    score += 5;
    drivers.push("integration assembly");
  }
  if (
    /\b(aria|a11y|accessibility|keyboard|focus|screen reader)\b/.test(
      positiveGoals,
    )
  ) {
    score += 4;
    drivers.push("accessibility requirements");
  }
  if (
    /\b(dialog|overlay|table|form|migration|multi-service)\b/.test(
      positiveGoals,
    )
  ) {
    score += 5;
    drivers.push("high-risk component family");
  }

  const stateMatches = new Set(
    [...positiveGoals.matchAll(STATE_TERMS)].map((match) => match[1]),
  );
  score += Math.min(8, stateMatches.size * 1.5);
  if (stateMatches.size > 0) {
    drivers.push(`${stateMatches.size} interaction states`);
  }
  score += contract.sharedResources.length * 10;
  if (contract.sharedResources.length > 0) {
    drivers.push("shared-resource serialization");
  }

  score = Math.round(score * 10) / 10;
  const size = sizeFor(score);
  const profile = profileFor(size);
  const peak = scaleRange(profile.apiCostCnyOffPeak, 2);

  return {
    taskId: contract.taskId,
    size,
    score,
    turns: profile.turns,
    wallMinutes: profile.wallMinutes,
    outputTokens: profile.outputTokens,
    guardBudgetUsd: profile.guardBudgetUsd,
    apiCostCnyOffPeak: profile.apiCostCnyOffPeak,
    apiCostCnyPeak: peak,
    recommendedMaxRepairs:
      size === "S" ? 0 : size === "XL" ? 0 : 1,
    drivers,
    recommendation:
      size === "XL"
        ? "Split before dispatch: one component contract, one implementation, one demo/QA unit."
        : size === "L" && score >= 55
          ? "Dispatchable, but consider separating demo or evidence work."
          : "Dispatchable as one acceptance unit.",
  };
}

function sizeFor(score: number): TaskSize {
  if (score < 22) return "S";
  if (score < 36) return "M";
  if (score < 62) return "L";
  return "XL";
}

function profileFor(size: TaskSize): {
  turns: NumericRange;
  wallMinutes: NumericRange;
  outputTokens: NumericRange;
  guardBudgetUsd: number;
  apiCostCnyOffPeak: NumericRange;
} {
  switch (size) {
    case "S":
      return {
        turns: { min: 5, max: 15 },
        wallMinutes: { min: 1, max: 4 },
        outputTokens: { min: 5_000, max: 25_000 },
        guardBudgetUsd: 1,
        apiCostCnyOffPeak: { min: 0.03, max: 0.2 },
      };
    case "M":
      return {
        turns: { min: 20, max: 40 },
        wallMinutes: { min: 4, max: 9 },
        outputTokens: { min: 25_000, max: 80_000 },
        guardBudgetUsd: 4,
        apiCostCnyOffPeak: { min: 0.2, max: 0.6 },
      };
    case "L":
      return {
        turns: { min: 35, max: 70 },
        wallMinutes: { min: 6, max: 15 },
        outputTokens: { min: 50_000, max: 140_000 },
        guardBudgetUsd: 8,
        apiCostCnyOffPeak: { min: 0.3, max: 1.2 },
      };
    case "XL":
      return {
        turns: { min: 60, max: 120 },
        wallMinutes: { min: 12, max: 30 },
        outputTokens: { min: 100_000, max: 240_000 },
        guardBudgetUsd: 12,
        apiCostCnyOffPeak: { min: 0.8, max: 2.5 },
      };
  }
}

function scaleRange(range: NumericRange, factor: number): NumericRange {
  return {
    min: roundMoney(range.min * factor),
    max: roundMoney(range.max * factor),
  };
}

function sum(values: number[]): number {
  return roundMoney(values.reduce((total, value) => total + value, 0));
}

function sumRanges(ranges: NumericRange[]): NumericRange {
  return {
    min: roundMoney(ranges.reduce((total, range) => total + range.min, 0)),
    max: roundMoney(ranges.reduce((total, range) => total + range.max, 0)),
  };
}

function roundMoney(value: number): number {
  return Math.round(value * 100) / 100;
}

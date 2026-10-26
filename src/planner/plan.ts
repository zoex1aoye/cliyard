/**
 * Human/Master-facing Plan → frozen TaskContract compiler.
 *
 * A Plan intentionally stays smaller than a TaskContract: the deterministic
 * control plane owns version, frozen state, base commit, defaults, and safety
 * checks. This keeps chat-generated plans reviewable and prevents an LLM from
 * silently choosing scheduler authority.
 */
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import {
  validateContract,
  type ContractIssue,
  type TaskContract,
} from "../contracts/schema.js";
import { findCycle } from "../scheduler/dag.js";

export interface PlanCompileOptions {
  /** Exact git commit that every worker worktree starts from. */
  baseCommit: string;
  /** Contract version assigned by the control plane (default 1). */
  version?: number;
  /** Repair budget used when a task does not set one (default 1). */
  maxRepairs?: number;
}

export interface CompiledPlan {
  planId: string;
  baseCommit: string;
  contracts: TaskContract[];
}

export class PlanValidationError extends Error {
  readonly issues: ContractIssue[];

  constructor(issues: ContractIssue[]) {
    super(
      `invalid Plan: ${issues
        .map((i) => `${i.path || "(root)"}: ${i.message}`)
        .join("; ")}`,
    );
    this.name = "PlanValidationError";
    this.issues = issues;
  }
}

export function parsePlanJson(text: string): unknown {
  let candidate = text.trim();
  if (candidate.startsWith("```")) {
    const firstLineEnd = candidate.indexOf("\n");
    if (firstLineEnd < 0) {
      throw new Error("invalid Plan JSON: unterminated code fence");
    }
    candidate = candidate.slice(firstLineEnd + 1).trimEnd();
    if (candidate.endsWith("```")) {
      candidate = candidate.slice(0, -3).trimEnd();
    }
  }

  try {
    return JSON.parse(candidate);
  } catch (e) {
    throw new Error(
      `invalid Plan JSON: ${e instanceof Error ? e.message : e}`,
    );
  }
}

export function compilePlan(
  raw: unknown,
  opts: PlanCompileOptions,
): CompiledPlan {
  const issues: ContractIssue[] = [];
  if (!isRecord(raw)) {
    throw new PlanValidationError([
      { path: "", message: "Plan must be an object" },
    ]);
  }

  const planId = readString(raw.planId, "planId", issues, {
    pattern: /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/,
    patternMessage:
      "must start with a letter or digit and contain only letters, digits, '.', '_' or '-' (max 64)",
  });
  const baseCommit = opts.baseCommit.trim();
  if (!baseCommit) {
    issues.push({ path: "baseCommit", message: "resolved commit is empty" });
  }

  const tasksRaw = raw.tasks;
  if (!Array.isArray(tasksRaw) || tasksRaw.length === 0) {
    issues.push({
      path: "tasks",
      message: "must be a non-empty array of module plans",
    });
  }

  const contracts: TaskContract[] = [];
  if (Array.isArray(tasksRaw)) {
    tasksRaw.forEach((taskRaw, index) => {
      contracts.push(
        compileTask(taskRaw, `tasks[${index}]`, {
          baseCommit,
          version: opts.version ?? 1,
          maxRepairs: opts.maxRepairs ?? 1,
          issues,
        }),
      );
    });
  }

  validatePlanGraph(contracts, issues);

  if (issues.length > 0) {
    throw new PlanValidationError(issues);
  }
  return { planId: planId!, baseCommit, contracts };
}

interface CompileTaskDefaults {
  baseCommit: string;
  version: number;
  maxRepairs: number;
  issues: ContractIssue[];
}

function compileTask(
  raw: unknown,
  path: string,
  defaults: CompileTaskDefaults,
): TaskContract {
  const {
    baseCommit,
    version,
    maxRepairs: defaultMaxRepairs,
    issues,
  } = defaults;
  if (!isRecord(raw)) {
    issues.push({ path, message: "must be an object" });
    return placeholderContract(path);
  }

  const taskId = readString(raw.taskId, `${path}.taskId`, issues, {
    pattern: /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/,
    patternMessage:
      "must start with a letter or digit and contain only letters, digits, '.', '_' or '-' (max 64)",
  });

  const goal = readOptionalString(raw.goal, `${path}.goal`, issues);
  const goalsInput = readOptionalStringArray(raw.goals, `${path}.goals`, issues);
  if (goal !== undefined && goalsInput !== undefined) {
    issues.push({
      path: `${path}.goals`,
      message: "use either `goal` or `goals`, not both",
    });
  }
  const goals =
    goalsInput?.filter(Boolean) ??
    (goal === undefined ? [] : [goal]);
  if (goals.length === 0) {
    issues.push({
      path: `${path}.goal`,
      message: "required non-empty goal (or goals)",
    });
  }

  const writePaths = readRepoPaths(raw.writePaths, `${path}.writePaths`, issues, {
    required: true,
    allowRoot: false,
  });
  const explicitReadPaths = readRepoPaths(
    raw.readPaths,
    `${path}.readPaths`,
    issues,
    { required: false, allowRoot: true },
  );
  const readPaths =
    explicitReadPaths && explicitReadPaths.length > 0
      ? unique(explicitReadPaths)
      : unique([".", "AGENTS.md", ...writePaths]);

  const verifyCommands = readOptionalStringArray(
    raw.verifyCommands,
    `${path}.verifyCommands`,
    issues,
  );
  if (!verifyCommands || verifyCommands.length === 0) {
    issues.push({
      path: `${path}.verifyCommands`,
      message: "must contain at least one acceptance command",
    });
  }

  const dependsOn =
    readOptionalStringArray(raw.dependsOn, `${path}.dependsOn`, issues) ?? [];
  const sharedResources =
    readOptionalStringArray(
      raw.sharedResources,
      `${path}.sharedResources`,
      issues,
    ) ?? [];
  if (sharedResources.length > 0) {
    issues.push({
      path: `${path}.sharedResources`,
      message:
        "shared-resource locking is not implemented; split the task or remove this field",
    });
  }

  const nonGoals = readOptionalStringArray(
    raw.nonGoals,
    `${path}.nonGoals`,
    issues,
  );
  const deliverables = readOptionalStringArray(
    raw.deliverables,
    `${path}.deliverables`,
    issues,
  );
  const forbidden = readOptionalStringArray(
    raw.forbidden,
    `${path}.forbidden`,
    issues,
  );

  const maxRepairsRaw = raw.maxRepairs ?? defaultMaxRepairs;
  if (
    typeof maxRepairsRaw !== "number" ||
    !Number.isInteger(maxRepairsRaw) ||
    maxRepairsRaw < 0 ||
    maxRepairsRaw > 10
  ) {
    issues.push({
      path: `${path}.maxRepairs`,
      message: "must be an integer between 0 and 10",
    });
  }

  const result = validateContract({
    taskId: taskId ?? path,
    version,
    frozen: true,
    goals,
    nonGoals,
    dependsOn: unique(dependsOn),
    readPaths,
    writePaths,
    sharedResources: [],
    baseCommit,
    verifyCommands: verifyCommands ?? [],
    deliverables,
    forbidden,
    maxRepairs: maxRepairsRaw,
  });
  if (!result.ok) {
    for (const issue of result.issues) {
      issues.push({
        path: `${path}.${issue.path}`,
        message: issue.message,
      });
    }
    return placeholderContract(path);
  }
  return result.contract;
}

function validatePlanGraph(
  contracts: TaskContract[],
  issues: ContractIssue[],
): void {
  const ids = new Map<string, number>();
  contracts.forEach((contract, index) => {
    const existing = ids.get(contract.taskId);
    if (existing !== undefined) {
      issues.push({
        path: `tasks[${index}].taskId`,
        message: `duplicate taskId "${contract.taskId}" (already used by tasks[${existing}])`,
      });
      return;
    }
    ids.set(contract.taskId, index);
  });

  contracts.forEach((contract, index) => {
    for (const dependency of contract.dependsOn) {
      if (!ids.has(dependency)) {
        issues.push({
          path: `tasks[${index}].dependsOn`,
          message: `unknown task "${dependency}"`,
        });
      }
    }
  });

  const cycle = findCycle(
    contracts.map((contract) => ({
      id: contract.taskId,
      dependsOn: contract.dependsOn,
    })),
  );
  if (!cycle.ok) {
    issues.push({
      path: "tasks.dependsOn",
      message: `dependency cycle: ${cycle.cycle.join(" → ")}`,
    });
  }

  for (let i = 0; i < contracts.length; i++) {
    for (let j = i + 1; j < contracts.length; j++) {
      const left = contracts[i]!;
      const right = contracts[j]!;
      const collision = firstPathCollision(
        left.writePaths,
        right.writePaths,
      );
      if (collision) {
        issues.push({
          path: `tasks[${j}].writePaths`,
          message:
            `"${right.taskId}" overlaps "${left.taskId}" at ${collision}; ` +
            "current isolated worktrees do not compose overlapping edits",
        });
      }
    }
  }
}

function firstPathCollision(left: string[], right: string[]): string | undefined {
  for (const a of left) {
    for (const b of right) {
      if (pathsOverlap(a, b)) return a === b ? a : `${a} / ${b}`;
    }
  }
  return undefined;
}

function pathsOverlap(left: string, right: string): boolean {
  const a = left.replace(/\/+$/, "");
  const b = right.replace(/\/+$/, "");
  return (
    a === b ||
    a.startsWith(`${b}/`) ||
    b.startsWith(`${a}/`)
  );
}

function readString(
  value: unknown,
  path: string,
  issues: ContractIssue[],
  opts?: { pattern: RegExp; patternMessage: string },
): string | undefined {
  if (typeof value !== "string" || !value.trim()) {
    issues.push({ path, message: "must be a non-empty string" });
    return undefined;
  }
  const out = value.trim();
  if (opts && !opts.pattern.test(out)) {
    issues.push({ path, message: opts.patternMessage });
    return undefined;
  }
  return out;
}

function readOptionalString(
  value: unknown,
  path: string,
  issues: ContractIssue[],
): string | undefined {
  if (value === undefined || value === null) return undefined;
  return readString(value, path, issues);
}

function readOptionalStringArray(
  value: unknown,
  path: string,
  issues: ContractIssue[],
): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) {
    issues.push({ path, message: "must be a string[]" });
    return undefined;
  }
  const out: string[] = [];
  value.forEach((item, index) => {
    if (typeof item !== "string" || !item.trim()) {
      issues.push({
        path: `${path}[${index}]`,
        message: "must be a non-empty string",
      });
      return;
    }
    out.push(item.trim());
  });
  return out;
}

function readRepoPaths(
  value: unknown,
  path: string,
  issues: ContractIssue[],
  opts: { required: boolean; allowRoot: boolean },
): string[] {
  const rawPaths = readOptionalStringArray(value, path, issues);
  if (opts.required && (!rawPaths || rawPaths.length === 0)) {
    issues.push({
      path,
      message: "must contain at least one repository-relative path",
    });
    return [];
  }
  const normalized: string[] = [];
  for (const [index, item] of (rawPaths ?? []).entries()) {
    const candidate = normalizeRepoPath(item, opts.allowRoot);
    if (!candidate) {
      issues.push({
        path: `${path}[${index}]`,
        message:
          `must stay inside the repository and be relative ` +
          `(received "${item}")`,
      });
      continue;
    }
    normalized.push(candidate);
  }
  return unique(normalized);
}

function normalizeRepoPath(value: string, allowRoot: boolean): string | undefined {
  if (value.includes("\0") || isAbsolute(value) || /^[a-zA-Z]:[\\/]/.test(value)) {
    return undefined;
  }
  const segments = value
    .replace(/\\/g, "/")
    .split("/")
    .filter((segment) => segment.length > 0 && segment !== ".");
  if (segments.some((segment) => segment === "..")) return undefined;
  const normalized = segments.join("/");
  if (!normalized) return allowRoot ? "." : undefined;
  return normalized;
}

function placeholderContract(taskId: string): TaskContract {
  return {
    taskId,
    version: 1,
    frozen: true,
    goals: [],
    dependsOn: [],
    readPaths: [],
    writePaths: [],
    sharedResources: [],
    baseCommit: "HEAD",
    verifyCommands: [],
    maxRepairs: 0,
  };
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function defaultPlanArtifactPath(
  repoRoot: string,
  planId: string,
): string {
  return join(repoRoot, ".cliyard", "plans", `${planId}.json`);
}

export function defaultContractsPath(
  repoRoot: string,
  planId: string,
): string {
  return join(
    repoRoot,
    ".cliyard",
    "contracts",
    `${planId}.contracts.json`,
  );
}

export function makeContractDocument(plan: CompiledPlan): {
  planId: string;
  contracts: TaskContract[];
} {
  return {
    planId: plan.planId,
    contracts: plan.contracts,
  };
}

export function writeJsonArtifact(path: string, value: unknown): string {
  const absolute = resolve(path);
  mkdirSync(dirname(absolute), { recursive: true });
  const temporary = `${absolute}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  renameSync(temporary, absolute);
  return absolute;
}

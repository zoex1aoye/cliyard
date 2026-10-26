/**
 * Frozen dispatch contract (Route C). Validated before mock or real workers run.
 * Aligns with docs/SCAFFOLD_FROM_OSS.md §4 and MVP_IMPLEMENTATION_PLAN §5.
 */
export interface TaskContract {
  taskId: string;
  version: number;
  frozen: boolean;
  goals: string[];
  nonGoals?: string[];
  dependsOn: string[];
  readPaths: string[];
  writePaths: string[];
  sharedResources: string[];
  baseCommit: string;
  verifyCommands: string[];
  deliverables?: string[];
  forbidden?: string[];
  maxRepairs: number;
}

export type ContractIssue = { path: string; message: string };

export function validateContract(raw: unknown): {
  ok: true;
  contract: TaskContract;
} | {
  ok: false;
  issues: ContractIssue[];
} {
  const issues: ContractIssue[] = [];
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, issues: [{ path: "", message: "contract must be an object" }] };
  }
  const o = raw as Record<string, unknown>;

  const str = (key: string, required = true): string | undefined => {
    const v = o[key];
    if (v === undefined || v === null) {
      if (required) issues.push({ path: key, message: "required string" });
      return undefined;
    }
    if (typeof v !== "string" || !v.trim()) {
      issues.push({ path: key, message: "must be a non-empty string" });
      return undefined;
    }
    return v;
  };

  const num = (key: string): number | undefined => {
    const v = o[key];
    if (typeof v !== "number" || !Number.isFinite(v)) {
      issues.push({ path: key, message: "must be a finite number" });
      return undefined;
    }
    return v;
  };

  const bool = (key: string): boolean | undefined => {
    const v = o[key];
    if (typeof v !== "boolean") {
      issues.push({ path: key, message: "must be boolean" });
      return undefined;
    }
    return v;
  };

  const strArr = (key: string, required = true): string[] | undefined => {
    const v = o[key];
    if (v === undefined || v === null) {
      if (required) issues.push({ path: key, message: "required string[]" });
      return required ? undefined : [];
    }
    if (!Array.isArray(v) || !v.every((x) => typeof x === "string")) {
      issues.push({ path: key, message: "must be string[]" });
      return undefined;
    }
    return v as string[];
  };

  const taskId = str("taskId");
  const version = num("version");
  const frozen = bool("frozen");
  const goals = strArr("goals");
  const dependsOn = strArr("dependsOn");
  const readPaths = strArr("readPaths");
  const writePaths = strArr("writePaths");
  const sharedResources = strArr("sharedResources");
  const baseCommit = str("baseCommit");
  const verifyCommands = strArr("verifyCommands");
  const maxRepairs = num("maxRepairs");
  const nonGoals = strArr("nonGoals", false);
  const deliverables = strArr("deliverables", false);
  const forbidden = strArr("forbidden", false);

  if (goals && goals.length === 0) {
    issues.push({ path: "goals", message: "must have at least one goal" });
  }
  if (writePaths && writePaths.length === 0) {
    issues.push({ path: "writePaths", message: "must have at least one write path" });
  }
  if (maxRepairs !== undefined && (maxRepairs < 0 || !Number.isInteger(maxRepairs))) {
    issues.push({ path: "maxRepairs", message: "must be a non-negative integer" });
  }
  if (version !== undefined && (!Number.isInteger(version) || version < 1)) {
    issues.push({ path: "version", message: "must be integer >= 1" });
  }

  if (issues.length > 0) return { ok: false, issues };

  return {
    ok: true,
    contract: {
      taskId: taskId!,
      version: version!,
      frozen: frozen!,
      goals: goals!,
      nonGoals: nonGoals?.length ? nonGoals : undefined,
      dependsOn: dependsOn!,
      readPaths: readPaths!,
      writePaths: writePaths!,
      sharedResources: sharedResources!,
      baseCommit: baseCommit!,
      verifyCommands: verifyCommands!,
      deliverables: deliverables?.length ? deliverables : undefined,
      forbidden: forbidden?.length ? forbidden : undefined,
      maxRepairs: maxRepairs!,
    },
  };
}

export function loadContractJson(text: string): TaskContract {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    throw new Error(`invalid JSON: ${e instanceof Error ? e.message : e}`);
  }
  const result = validateContract(parsed);
  if (!result.ok) {
    const detail = result.issues.map((i) => `${i.path || "(root)"}: ${i.message}`).join("; ");
    throw new Error(`invalid TaskContract: ${detail}`);
  }
  return result.contract;
}

import { isAbsolute } from "node:path";
import type {
  RuntimeReadinessSpec,
  RuntimeServiceSpec,
  RuntimeSpec,
} from "../runtime/types.js";

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
  /** Optional RuntimeManager v0 services; absent means static verification only. */
  runtime?: RuntimeSpec;
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
  const runtime = readRuntimeSpec(o.runtime, issues);

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
      ...(runtime === undefined ? {} : { runtime }),
    },
  };
}

const SERVICE_NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;
const ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Validate and normalize an optional RuntimeSpec. Issue paths are relative to
 * the contract (`runtime.services[0].name`); compilePlan prefixes the task.
 */
function readRuntimeSpec(
  value: unknown,
  issues: ContractIssue[],
): RuntimeSpec | undefined {
  if (value === undefined || value === null) return undefined;
  if (!isRecord(value)) {
    issues.push({ path: "runtime", message: "must be an object" });
    return undefined;
  }
  if (!Array.isArray(value.services) || value.services.length === 0) {
    issues.push({
      path: "runtime.services",
      message: "must be a non-empty array of runtime services",
    });
    return undefined;
  }

  const services: RuntimeServiceSpec[] = [];
  const seenNames = new Map<string, number>();
  value.services.forEach((rawService, index) => {
    const path = `runtime.services[${index}]`;
    if (!isRecord(rawService)) {
      issues.push({ path, message: "must be an object" });
      return;
    }

    const name = readServiceName(rawService.name, `${path}.name`, issues);
    if (name !== undefined) {
      const previous = seenNames.get(name);
      if (previous !== undefined) {
        issues.push({
          path: `${path}.name`,
          message:
            `duplicate service name "${name}" ` +
            `(already used by runtime.services[${previous}])`,
        });
      } else {
        seenNames.set(name, index);
      }
    }

    const command = readServiceCommand(
      rawService.command,
      `${path}.command`,
      issues,
    );
    const cwd = readRepoRelativePath(rawService.cwd, `${path}.cwd`, issues);
    const portEnv = readEnvName(rawService.portEnv, `${path}.portEnv`, issues);
    const urlEnv = readEnvName(rawService.urlEnv, `${path}.urlEnv`, issues);
    const readiness = readReadiness(
      rawService.readiness,
      `${path}.readiness`,
      issues,
    );

    if (name === undefined || command === undefined) return;
    const service: RuntimeServiceSpec = { name, command };
    if (cwd !== undefined) service.cwd = cwd;
    if (portEnv !== undefined) service.portEnv = portEnv;
    if (urlEnv !== undefined) service.urlEnv = urlEnv;
    if (readiness !== undefined) service.readiness = readiness;
    services.push(service);
  });

  return { services };
}

function readServiceName(
  value: unknown,
  path: string,
  issues: ContractIssue[],
): string | undefined {
  if (typeof value !== "string" || !value.trim()) {
    issues.push({ path, message: "must be a non-empty string" });
    return undefined;
  }
  if (!SERVICE_NAME_PATTERN.test(value)) {
    issues.push({
      path,
      message:
        "must be a safe path segment: start with a letter or digit and " +
        "contain only letters, digits, '.', '_' or '-' (max 64)",
    });
    return undefined;
  }
  return value;
}

function readServiceCommand(
  value: unknown,
  path: string,
  issues: ContractIssue[],
): string[] | undefined {
  if (typeof value === "string") {
    issues.push({
      path,
      message:
        "must be an argv string[]; shell command strings are not allowed",
    });
    return undefined;
  }
  if (!Array.isArray(value) || value.length === 0) {
    issues.push({ path, message: "must be a non-empty argv string[]" });
    return undefined;
  }
  const argv: string[] = [];
  let ok = true;
  value.forEach((item, index) => {
    if (typeof item !== "string" || !item.trim() || item.includes("\0")) {
      issues.push({
        path: `${path}[${index}]`,
        message: "must be a non-empty string",
      });
      ok = false;
      return;
    }
    argv.push(item);
  });
  return ok ? argv : undefined;
}

function readRepoRelativePath(
  value: unknown,
  path: string,
  issues: ContractIssue[],
): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string" || !value.trim()) {
    issues.push({
      path,
      message: "must be a non-empty repository-relative path",
    });
    return undefined;
  }
  const normalized = normalizeRepoRelative(value);
  if (normalized === undefined) {
    issues.push({
      path,
      message:
        `must stay inside the repository and be relative ` +
        `(received "${value}")`,
    });
    return undefined;
  }
  return normalized;
}

function normalizeRepoRelative(value: string): string | undefined {
  if (
    value.includes("\0") ||
    isAbsolute(value) ||
    /^[a-zA-Z]:[\\/]/.test(value) ||
    value.startsWith("\\\\")
  ) {
    return undefined;
  }
  const segments = value
    .replace(/\\/g, "/")
    .split("/")
    .filter((segment) => segment.length > 0 && segment !== ".");
  if (segments.some((segment) => segment === "..")) return undefined;
  return segments.length > 0 ? segments.join("/") : ".";
}

function readEnvName(
  value: unknown,
  path: string,
  issues: ContractIssue[],
): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string" || !ENV_NAME_PATTERN.test(value)) {
    issues.push({
      path,
      message:
        "must be a valid environment variable name " +
        "(letters, digits and '_', not starting with a digit)",
    });
    return undefined;
  }
  return value;
}

function readReadiness(
  value: unknown,
  path: string,
  issues: ContractIssue[],
): RuntimeReadinessSpec | undefined {
  if (value === undefined || value === null) return undefined;
  if (!isRecord(value)) {
    issues.push({ path, message: "must be an object" });
    return undefined;
  }

  const readiness: RuntimeReadinessSpec = {};
  const rawPath = value.path;
  if (rawPath !== undefined && rawPath !== null) {
    if (
      typeof rawPath !== "string" ||
      !rawPath.startsWith("/") ||
      /[\s\0]/.test(rawPath)
    ) {
      issues.push({
        path: `${path}.path`,
        message: "must be a URL path starting with '/' without whitespace",
      });
    } else {
      readiness.path = rawPath;
    }
  }

  const expectedStatus = value.expectedStatus;
  if (expectedStatus !== undefined && expectedStatus !== null) {
    if (
      typeof expectedStatus !== "number" ||
      !Number.isInteger(expectedStatus) ||
      expectedStatus <= 0
    ) {
      issues.push({
        path: `${path}.expectedStatus`,
        message: "must be a positive integer HTTP status",
      });
    } else {
      readiness.expectedStatus = expectedStatus;
    }
  }

  const timeoutMs = value.timeoutMs;
  if (timeoutMs !== undefined && timeoutMs !== null) {
    if (
      typeof timeoutMs !== "number" ||
      !Number.isFinite(timeoutMs) ||
      timeoutMs <= 0
    ) {
      issues.push({
        path: `${path}.timeoutMs`,
        message: "must be a positive number of milliseconds",
      });
    } else {
      readiness.timeoutMs = timeoutMs;
    }
  }

  return readiness;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
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

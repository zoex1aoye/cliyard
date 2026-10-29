/**
 * DeepSeek Harness Master plugin (Cordis).
 * Thin: Plan bridge + dispatch + monitor; business state stays in cliyard.
 *
 * Install (when dsh is available):
 *   dsh plugin --profile web add link:/absolute/path/to/plugins/dsh-cliyard
 *
 * Model-visible dispatch selects a configured `executionProfileId` alias only.
 * The alias is mapped to a worker and model here, on the server. Arbitrary
 * worker, model or permission values from tool input are rejected.
 */
import { resolve } from "node:path";
import { dispatchBatch, dispatchPlan } from "./lib/dispatch.js";
import {
  startMonitorServer,
  readLedgerSnapshot,
  watchLedger,
} from "./lib/monitor.js";
import {
  resolveControlRoot,
  resolveRepoRoot,
} from "./lib/paths.js";

export const name = "dsh-cliyard";
export const inject = ["tools"];

/** Alias synthesized from defaultWorker/model when config defines no profiles. */
export const DEFAULT_EXECUTION_PROFILE_ID = "default";

const SUPPORTED_WORKERS = new Set(["mock", "codex", "claude"]);
const PROFILE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const MODEL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:+/@,\[\]-]{0,127}$/;
const PLAN_TOOL_ARGUMENTS = new Set([
  "plan",
  "dispatch",
  "dryRun",
  "executionProfileId",
]);

/**
 * Build the execution-profile alias map from plugin config.
 *
 * Config shapes:
 * - `executionProfiles: { alias: { worker, model? }, ... }` (preferred);
 * - legacy `defaultWorker` + `model`, exposed as the `default` alias.
 *
 * Unknown worker names, extra profile fields (for example permissions) and
 * malformed ids fail closed instead of reaching the CLI.
 */
export function normalizeExecutionProfiles(config = {}) {
  const configured = config?.executionProfiles;
  if (configured === undefined) {
    const worker = normalizeWorker(
      config?.defaultWorker ?? "mock",
      "defaultWorker",
    );
    const model = normalizeModel(config?.model, "model");
    return new Map([
      [DEFAULT_EXECUTION_PROFILE_ID, Object.freeze({ worker, model })],
    ]);
  }
  if (
    configured === null ||
    typeof configured !== "object" ||
    Array.isArray(configured)
  ) {
    throw new Error(
      "executionProfiles must be an object keyed by execution-profile alias",
    );
  }
  const entries = Object.entries(configured);
  if (entries.length === 0) {
    throw new Error("executionProfiles must define at least one alias");
  }
  const profiles = new Map();
  for (const [alias, value] of entries) {
    if (!PROFILE_ID_PATTERN.test(alias)) {
      throw new Error(`Invalid execution profile alias "${alias}"`);
    }
    profiles.set(alias, normalizeExecutionProfile(alias, value));
  }
  return profiles;
}

/**
 * Resolve the tool's default alias: an explicit `defaultExecutionProfileId`,
 * otherwise the `default` alias, otherwise the first configured alias.
 */
export function resolveDefaultExecutionProfileId(profiles, configuredId) {
  const first = profiles.keys().next().value;
  const preferred = profiles.has(DEFAULT_EXECUTION_PROFILE_ID)
    ? DEFAULT_EXECUTION_PROFILE_ID
    : first;
  if (configuredId === undefined) return preferred;
  if (typeof configuredId !== "string" || !profiles.has(configuredId)) {
    throw new Error(
      `defaultExecutionProfileId "${String(configuredId)}" is not a configured execution profile. ` +
        `Configured profiles: ${formatProfileIds(profiles)}`,
    );
  }
  return configuredId;
}

/** Map a configured alias to its frozen worker/model pair. */
export function resolveExecutionProfile(
  profiles,
  executionProfileId,
  defaultExecutionProfileId = DEFAULT_EXECUTION_PROFILE_ID,
) {
  const requested = executionProfileId ?? defaultExecutionProfileId;
  const profile =
    typeof requested === "string" ? profiles.get(requested) : undefined;
  if (!profile) {
    throw new Error(
      `Unknown execution profile "${String(requested)}". ` +
        `Configured profiles: ${formatProfileIds(profiles)}`,
    );
  }
  return Object.freeze({
    executionProfileId: requested,
    worker: profile.worker,
    model: profile.model,
  });
}

function normalizeExecutionProfile(alias, value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(
      `Execution profile "${alias}" must be an object with worker and optional model`,
    );
  }
  for (const key of Object.keys(value)) {
    if (key !== "worker" && key !== "model") {
      throw new Error(
        `Execution profile "${alias}" does not accept "${key}"; only worker and model are configurable`,
      );
    }
  }
  return Object.freeze({
    worker: normalizeWorker(value.worker, `executionProfiles.${alias}.worker`),
    model: normalizeModel(value.model, `executionProfiles.${alias}.model`),
  });
}

function normalizeWorker(value, label) {
  if (typeof value !== "string" || !SUPPORTED_WORKERS.has(value)) {
    throw new Error(
      `${label} must be one of: ${[...SUPPORTED_WORKERS].join(", ")}`,
    );
  }
  return value;
}

function normalizeModel(value, label) {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string" || !MODEL_ID_PATTERN.test(value)) {
    throw new Error(`${label} must be a bounded model id`);
  }
  return value;
}

function formatProfileIds(profiles) {
  return [...profiles.keys()].join(", ") || "none";
}

export function apply(ctx, config = {}) {
  const controlRoot = resolveControlRoot(config.controlRoot);
  const repoRoot = resolveRepoRoot(
    config.targetRepo ?? config.repoRoot,
  );
  const ledgerPath = resolve(
    repoRoot,
    config.ledgerPath ?? ".cliyard/ledger.json",
  );
  const defaultContracts = resolve(
    controlRoot,
    config.defaultContracts ?? "examples/mock-batch.parallel.json",
  );
  const monitorPort = Number(config.monitorPort ?? 3927);
  const defaultWorker = config.defaultWorker ?? "mock";
  const defaultModel = config.model;
  const keepWorktrees = config.keepWorktrees !== false;
  const executionProfiles = normalizeExecutionProfiles(config);
  const defaultExecutionProfileId = resolveDefaultExecutionProfileId(
    executionProfiles,
    config.defaultExecutionProfileId,
  );

  let monitor = null;
  let stopWatch = null;

  // Trusted programmatic calls keep the legacy worker/model defaults. A
  // supplied executionProfileId resolves server-side and cannot be mixed with
  // worker/model overrides.
  const executionFor = (opts) => {
    if (opts.executionProfileId !== undefined) {
      if (opts.worker !== undefined || opts.model !== undefined) {
        throw new Error(
          "executionProfileId cannot be combined with worker or model overrides",
        );
      }
      return resolveExecutionProfile(
        executionProfiles,
        opts.executionProfileId,
        defaultExecutionProfileId,
      );
    }
    return {
      worker: opts.worker ?? defaultWorker,
      model: opts.model ?? defaultModel,
    };
  };

  const api = {
    name: "cliyard",
    async dispatch(opts = {}) {
      const execution = executionFor(opts);
      return dispatchBatch({
        controlRoot,
        targetRepo: opts.targetRepo ?? repoRoot,
        contracts: opts.contracts ?? defaultContracts,
        worker: execution.worker,
        ledgerPath: opts.ledgerPath ?? ledgerPath,
        model: execution.model,
        dryRun: opts.dryRun,
        keepWorktrees: opts.keepWorktrees ?? keepWorktrees,
      });
    },
    async dispatchPlan(opts = {}) {
      const execution = executionFor(opts);
      return dispatchPlan({
        plan: opts.plan,
        controlRoot,
        targetRepo: opts.targetRepo ?? repoRoot,
        contractsPath: opts.contractsPath,
        ledgerPath: opts.ledgerPath ?? ledgerPath,
        worker: execution.worker,
        model: execution.model,
        dispatch: opts.dispatch === true,
        dryRun: opts.dryRun !== false,
        keepWorktrees: opts.keepWorktrees ?? keepWorktrees,
        background: opts.background === true,
      });
    },
    snapshot() {
      return readLedgerSnapshot(ledgerPath);
    },
    async startMonitor(port = monitorPort) {
      if (monitor) return monitor;
      monitor = await startMonitorServer({ repoRoot, ledgerPath, port });
      return monitor;
    },
    async stopMonitor() {
      if (monitor) {
        await monitor.close();
        monitor = null;
      }
    },
  };

  // Best-effort: register on ctx if the host supports these hooks.
  try {
    if (ctx && typeof ctx.set === "function") {
      ctx.set("cliyard", api);
    } else if (ctx) {
      ctx.cliyard = api;
    }
  } catch {
    /* host without service registry */
  }

  registerPlanTool(ctx, {
    controlRoot,
    targetRepo: repoRoot,
    executionProfiles,
    defaultExecutionProfileId,
    keepWorktrees,
  });

  try {
    if (ctx && typeof ctx.on === "function") {
      ctx.on("ready", async () => {
        console.log(
          `[dsh-cliyard] Master plugin ready control=${controlRoot} target=${repoRoot}`,
        );
        try {
          monitor = await startMonitorServer({
            repoRoot,
            ledgerPath,
            port: monitorPort,
          });
          console.log(`[dsh-cliyard] monitor ${monitor.url}`);
        } catch (e) {
          console.warn(
            `[dsh-cliyard] monitor not started: ${e instanceof Error ? e.message : e}`,
          );
        }
        stopWatch = watchLedger(ledgerPath, () => {
          /* snapshot available via api.snapshot(); hosts may subscribe later */
        });
      });
      ctx.on("dispose", async () => {
        stopWatch?.();
        await api.stopMonitor();
      });
    } else {
      console.log(
        `[dsh-cliyard] loaded (standalone-compatible) control=${controlRoot} target=${repoRoot}`,
      );
    }
  } catch (e) {
    console.warn(
      `[dsh-cliyard] lifecycle hooks skipped: ${e instanceof Error ? e.message : e}`,
    );
  }

  return api;
}

function registerPlanTool(ctx, opts) {
  if (!ctx?.tools || typeof ctx.tools.register !== "function") return;

  const profileIds = [...opts.executionProfiles.keys()];
  const definition = {
    name: "cliyard_plan_dispatch",
    description:
      "Compile a structured cliyard Plan into frozen TaskContracts, persist " +
      "them under the target repository, and optionally dispatch isolated " +
      "workers. Use one task per independently reviewable module. Every task " +
      "needs taskId, goal or goals, writePaths and verifyCommands. Keep " +
      "writePaths disjoint. Call with dispatch=false first to compile and " +
      "inspect; set dispatch=true only when the user asked to execute. " +
      "dryRun defaults true; set it false only for an explicitly requested " +
      "real worker run. Dispatch returns a background pid/log receipt; " +
      "task status is read from the cliyard ledger/monitor. Execution behavior " +
      `comes only from the configured executionProfileId aliases ` +
      `(${profileIds.join(", ")}); worker, model and permission overrides ` +
      "are rejected.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        plan: {
          type: "object",
          additionalProperties: true,
          description:
            "Plan object: { planId, tasks: [{ taskId, goal|goals, " +
            "nonGoals?, dependsOn?, readPaths?, writePaths, " +
            "verifyCommands, maxRepairs? }] }. Paths are relative to the " +
            "target repository.",
        },
        executionProfileId: {
          type: "string",
          enum: profileIds,
          description:
            "Configured execution-profile alias. The plugin maps it to a " +
            "worker and model on the server; selecting an alias never grants " +
            "additional permissions.",
        },
        dispatch: {
          type: "boolean",
          description:
            "Start workers after compilation. Omit or set false to only " +
            "produce the contract file.",
        },
        dryRun: {
          type: "boolean",
          description:
            "For Codex dispatch, use dry-run stubs instead of the CLI/API. " +
            "Defaults true.",
        },
      },
      required: ["plan"],
    },
    output: {
      schema: { type: "string" },
      render: (_args, value) => [{ type: "text", text: value }],
    },
    timeoutMs: 30 * 60_000,
    async execute(args) {
      const input = validatePlanToolArguments(args);
      const execution = resolveExecutionProfile(
        opts.executionProfiles,
        input.executionProfileId,
        opts.defaultExecutionProfileId,
      );
      const result = await dispatchPlan({
        plan: input.plan,
        controlRoot: opts.controlRoot,
        targetRepo: opts.targetRepo,
        worker: execution.worker,
        model: execution.model,
        dispatch: input.dispatch === true,
        dryRun: input.dryRun !== false,
        keepWorktrees: opts.keepWorktrees,
        background: input.dispatch === true,
      });
      if (!result.ok) {
        throw new Error(
          result.stderr.trim() ||
            result.stdout.trim() ||
            `cliyard dispatch failed with exit ${result.exitCode}`,
        );
      }
      return result.stdout.trim();
    },
  };

  const install = () => ctx.tools.register(definition);
  try {
    if (typeof ctx.effect === "function") {
      ctx.effect(install);
    } else {
      install();
    }
  } catch (e) {
    console.warn(
      `[dsh-cliyard] plan tool not registered: ${
        e instanceof Error ? e.message : e
      }`,
    );
  }
}

/**
 * Tool arguments are a closed set. Rejecting unknown keys keeps worker,
 * model, permission and CLI-injection attempts out of the model-visible path
 * even when a host does not enforce the JSON schema.
 */
function validatePlanToolArguments(args) {
  if (args === null || typeof args !== "object" || Array.isArray(args)) {
    throw new Error("cliyard_plan_dispatch expects a single object argument");
  }
  for (const key of Object.keys(args)) {
    if (!PLAN_TOOL_ARGUMENTS.has(key)) {
      throw new Error(
        `cliyard_plan_dispatch does not accept "${key}"; select a configured ` +
          "executionProfileId instead of worker, model or permission values",
      );
    }
  }
  if (args.plan === undefined) {
    throw new Error("cliyard_plan_dispatch requires a plan object");
  }
  if (args.dispatch !== undefined && typeof args.dispatch !== "boolean") {
    throw new Error("cliyard_plan_dispatch dispatch must be a boolean");
  }
  if (args.dryRun !== undefined && typeof args.dryRun !== "boolean") {
    throw new Error("cliyard_plan_dispatch dryRun must be a boolean");
  }
  if (
    args.executionProfileId !== undefined &&
    typeof args.executionProfileId !== "string"
  ) {
    throw new Error(
      "cliyard_plan_dispatch executionProfileId must be a configured alias",
    );
  }
  return {
    plan: args.plan,
    dispatch: args.dispatch,
    dryRun: args.dryRun,
    executionProfileId: args.executionProfileId,
  };
}

/**
 * DeepSeek Harness Master plugin (Cordis).
 * Thin: Plan bridge + dispatch + monitor; business state stays in cliyard.
 *
 * Install (when dsh is available):
 *   dsh plugin --profile web add link:/absolute/path/to/plugins/dsh-cliyard
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

  let monitor = null;
  let stopWatch = null;

  const api = {
    name: "cliyard",
    async dispatch(opts = {}) {
      return dispatchBatch({
        controlRoot,
        targetRepo: opts.targetRepo ?? repoRoot,
        contracts: opts.contracts ?? defaultContracts,
        worker: opts.worker ?? defaultWorker,
        ledgerPath: opts.ledgerPath ?? ledgerPath,
        model: opts.model ?? defaultModel,
        dryRun: opts.dryRun,
        keepWorktrees: opts.keepWorktrees ?? keepWorktrees,
      });
    },
    async dispatchPlan(opts = {}) {
      return dispatchPlan({
        plan: opts.plan,
        controlRoot,
        targetRepo: opts.targetRepo ?? repoRoot,
        contractsPath: opts.contractsPath,
        ledgerPath: opts.ledgerPath ?? ledgerPath,
        worker: opts.worker ?? defaultWorker,
        model: opts.model ?? defaultModel,
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
    worker: defaultWorker,
    model: defaultModel,
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
      "task status is read from the cliyard ledger/monitor.",
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
        worker: {
          type: "string",
          enum: ["claude", "codex", "mock"],
          description: "Worker adapter. Defaults to plugin config.",
        },
        model: {
          type: "string",
          description: "Codex model id. Defaults to plugin config or the CLI.",
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
      const result = await dispatchPlan({
        plan: args.plan,
        controlRoot: opts.controlRoot,
        targetRepo: opts.targetRepo,
        worker: args.worker ?? opts.worker,
        model: args.model ?? opts.model,
        dispatch: args.dispatch === true,
        dryRun: args.dryRun !== false,
        keepWorktrees: opts.keepWorktrees,
        background: args.dispatch === true,
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

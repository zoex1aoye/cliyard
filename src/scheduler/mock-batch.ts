/**
 * Thin multi-task mock scheduler: DAG readyIds + closed loop + ledger.
 * Mock agent/verifier by default; no WSL spawn.
 */
import { readFileSync, existsSync } from "node:fs";
import { resolve, extname } from "node:path";
import {
  loadContractJson,
  validateContract,
  type TaskContract,
} from "../contracts/schema.js";
import { loadTaskFileAsContracts } from "../contracts/fromTaskfile.js";
import { createMockAdapter } from "../agents/mock.js";
import type { AgentAdapter } from "../agents/types.js";
import {
  createMockVerifier,
  createShellVerifier,
  wantsRealVerify,
  type Verifier,
} from "../verification/verifier.js";
import { runClosedLoop, type LoopResult } from "../repair/loop.js";
import { defaultLedgerPath } from "../persistence/ledger.js";
import { findCycle, readyIds, type DagNode } from "./dag.js";

export interface MockBatchOptions {
  contracts: TaskContract[];
  /** Factory so each task can get a fresh mock worker (default: failVerifyTimes=0). */
  createWorker?: (contract: TaskContract) => AgentAdapter;
  verifier?: Verifier;
  ledgerPath?: string;
  verbose?: boolean;
  /**
   * Called when a task is about to enter the closed loop (after deps accepted).
   * Useful for tests asserting start order / blocked wait.
   */
  onTaskStart?: (taskId: string, acceptedSoFar: ReadonlySet<string>) => void;
}

export interface MockBatchSkipped {
  taskId: string;
  reason: string;
}

export interface MockBatchResult {
  results: LoopResult[];
  skipped: MockBatchSkipped[];
  startOrder: string[];
  ledgerPath: string;
  allAccepted: boolean;
}

/**
 * Run contracts in dependsOn order. Only `accepted` deps unlock dependents.
 * Rejected/missing deps leave dependents in `skipped` (never started).
 */
export async function runMockBatch(
  opts: MockBatchOptions,
): Promise<MockBatchResult> {
  const { contracts } = opts;
  if (contracts.length === 0) {
    throw new Error("mock-batch: no contracts");
  }

  const byId = new Map<string, TaskContract>();
  for (const c of contracts) {
    if (byId.has(c.taskId)) {
      throw new Error(`mock-batch: duplicate taskId ${c.taskId}`);
    }
    if (!c.frozen) {
      throw new Error(`mock-batch: task ${c.taskId} is not frozen`);
    }
    if (c.sharedResources.length > 0) {
      throw new Error(
        `mock-batch: task ${c.taskId} uses sharedResources, but locking is not implemented`,
      );
    }
    byId.set(c.taskId, c);
  }

  for (let i = 0; i < contracts.length; i++) {
    for (let j = i + 1; j < contracts.length; j++) {
      const left = contracts[i]!;
      const right = contracts[j]!;
      for (const a of left.writePaths) {
        for (const b of right.writePaths) {
          if (pathsOverlap(a, b)) {
            throw new Error(
              `mock-batch: writePaths overlap between ${left.taskId} (${a}) ` +
                `and ${right.taskId} (${b})`,
            );
          }
        }
      }
    }
  }

  const nodes: DagNode[] = contracts.map((c) => ({
    id: c.taskId,
    dependsOn: c.dependsOn,
  }));
  const cycle = findCycle(nodes);
  if (!cycle.ok) {
    throw new Error(`mock-batch: DAG has a cycle: ${cycle.cycle.join(" → ")}`);
  }

  const ledgerPath = opts.ledgerPath ?? defaultLedgerPath();
  const verifier = opts.verifier ?? createMockVerifier();
  const createWorker =
    opts.createWorker ??
    ((_c: TaskContract) => createMockAdapter({ failVerifyTimes: 0 }));
  const log = opts.verbose
    ? (s: string) => console.log(s)
    : (_s: string) => undefined;

  const pending = new Set(contracts.map((c) => c.taskId));
  const accepted = new Set<string>();
  const results: LoopResult[] = [];
  const skipped: MockBatchSkipped[] = [];
  const startOrder: string[] = [];

  log(`[mock-batch] tasks=${contracts.length} ledger=${ledgerPath}`);

  while (pending.size > 0) {
    const ready = readyIds(nodes, accepted).filter((id) => pending.has(id));
    if (ready.length === 0) {
      for (const id of [...pending]) {
        const contract = byId.get(id)!;
        const badDeps = contract.dependsOn.filter((d) => !accepted.has(d));
        const reason =
          badDeps.length > 0
            ? `blocked: dependencies not accepted: ${badDeps.join(", ")}`
            : "blocked: no ready path";
        skipped.push({ taskId: id, reason });
        pending.delete(id);
        log(`[mock-batch] skip ${id}: ${reason}`);
      }
      break;
    }

    // Parallel among currently-ready set (stable startOrder = readyIds order).
    const wave = ready.filter((id) => pending.has(id));
    for (const id of wave) {
      opts.onTaskStart?.(id, new Set(accepted));
      startOrder.push(id);
      log(
        `[mock-batch] start ${id} (accepted so far: ${[...accepted].join(",") || "∅"})`,
      );
    }

    const waveResults = await Promise.all(
      wave.map((id) => {
        const contract = byId.get(id)!;
        return runClosedLoop({
          contract,
          worker: createWorker(contract),
          verifier,
          ledgerPath,
          verbose: opts.verbose,
        });
      }),
    );

    for (let i = 0; i < wave.length; i++) {
      const id = wave[i]!;
      const result = waveResults[i]!;
      results.push(result);
      pending.delete(id);
      if (result.verdict === "accepted") {
        accepted.add(id);
        log(`[mock-batch] accepted ${id}`);
      } else {
        log(`[mock-batch] rejected ${id}: ${result.reason}`);
      }
    }
  }

  return {
    results,
    skipped,
    startOrder,
    ledgerPath,
    allAccepted:
      skipped.length === 0 && results.every((r) => r.verdict === "accepted"),
  };
}

function pathsOverlap(left: string, right: string): boolean {
  const a = left.replace(/\/+$/, "");
  const b = right.replace(/\/+$/, "");
  return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}

/** Load TaskContract[] from JSON array, `{contracts:[…]}`, single contract, or YAML taskfile. */
export function loadContractsInput(path: string): TaskContract[] {
  const abs = resolve(path);
  if (!existsSync(abs)) {
    throw new Error(`mock-batch: file not found: ${abs}`);
  }
  const ext = extname(abs).toLowerCase();
  if (ext === ".yaml" || ext === ".yml") {
    return loadTaskFileAsContracts(abs);
  }
  const text = readFileSync(abs, "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    throw new Error(
      `mock-batch: invalid JSON: ${e instanceof Error ? e.message : e}`,
    );
  }

  if (Array.isArray(parsed)) {
    return parsed.map((item, i) => validateOne(item, `[${i}]`));
  }
  if (
    parsed !== null &&
    typeof parsed === "object" &&
    Array.isArray((parsed as { contracts?: unknown }).contracts)
  ) {
    const list = (parsed as { contracts: unknown[] }).contracts;
    return list.map((item, i) => validateOne(item, `contracts[${i}]`));
  }
  return [loadContractJson(text)];
}

function validateOne(raw: unknown, label: string): TaskContract {
  const result = validateContract(raw);
  if (!result.ok) {
    const detail = result.issues
      .map((i) => `${i.path || "(root)"}: ${i.message}`)
      .join("; ");
    throw new Error(`mock-batch: invalid TaskContract at ${label}: ${detail}`);
  }
  return result.contract;
}

function usage(): never {
  console.log(`cliyard mock-batch — multi-task mock scheduler (DAG + closed loop)

Usage:
  cliyard mock-batch <contracts.json|taskfile.yaml> [--ledger path] [--real-verify]
                     [--fail-verify-times N]

Input:
  JSON array of TaskContract, or { "contracts": [ … ] }, or a single contract,
  or a YAML taskfile (via TaskFile→Contract adapter; dependsOn default []).

Defaults:
  verify: Mock. --real-verify / CLIYARD_REAL_VERIFY=1 → local shell verifyCommands
  fail-verify-times: 0 (each task accepts on first verify under mock)
  ledger: .cliyard/ledger.json
`);
  process.exit(1);
}

function arg(flag: string, argv: string[]): string | undefined {
  const i = argv.indexOf(flag);
  if (i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--")) return argv[i + 1];
  const eq = argv.find((a) => a.startsWith(`${flag}=`));
  return eq?.slice(flag.length + 1);
}

function positionalArg(argv: string[]): string | undefined {
  const valueFlags = new Set(["--ledger", "--fail-verify-times"]);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      if (valueFlags.has(a)) i += 1;
      continue;
    }
    return a;
  }
  return undefined;
}

export async function runMockBatchCli(argv: string[]): Promise<void> {
  if (argv.includes("-h") || argv.includes("--help") || argv.length === 0) {
    usage();
  }

  const file = positionalArg(argv);
  if (!file) usage();

  const ledgerPath = arg("--ledger", argv) ?? defaultLedgerPath();
  const realVerify = wantsRealVerify(argv);
  const failRaw = arg("--fail-verify-times", argv);
  const failVerifyTimes = failRaw !== undefined ? Number(failRaw) : 0;
  if (!Number.isInteger(failVerifyTimes) || failVerifyTimes < 0) {
    throw new Error("--fail-verify-times must be a non-negative integer");
  }

  const contracts = loadContractsInput(file!);
  console.log(`mock-batch input=${resolve(file!)} tasks=${contracts.length}`);
  console.log(
    `  verifier=${realVerify ? "shell" : "mock"} failVerifyTimes=${failVerifyTimes} ledger=${ledgerPath}`,
  );
  console.log("");

  const result = await runMockBatch({
    contracts,
    createWorker: () => createMockAdapter({ failVerifyTimes }),
    verifier: realVerify ? createShellVerifier() : createMockVerifier(),
    ledgerPath,
    verbose: true,
  });

  console.log("");
  console.log(
    JSON.stringify(
      {
        startOrder: result.startOrder,
        allAccepted: result.allAccepted,
        results: result.results.map((r) => ({
          taskId: r.taskId,
          verdict: r.verdict,
          status: r.status,
          repairCount: r.repairCount,
          reason: r.reason,
        })),
        skipped: result.skipped,
        ledgerPath: result.ledgerPath,
      },
      null,
      2,
    ),
  );
  process.exit(result.allAccepted ? 0 : 1);
}

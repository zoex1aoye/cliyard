/**
 * MVP M4: run code + novel demos (compile → freeze → idle-spin → status).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { compileMvpPlan } from "./compile.js";
import { freezeContract, writeFrozenContract } from "./freeze.js";
import { runIdleSpin, type IdleSpinResult } from "./idle-spin.js";

export interface DemoSceneResult {
  scene: string;
  planId: string;
  contractId: string;
  target: string;
  ok: boolean;
  workspaceKind: string;
  spawnCwd: string;
  spawnExitCode: number;
  trunkClean: boolean;
  disposed: boolean;
  codexMode?: "live" | "standin" | "unknown";
  frozenPath: string;
  error?: string;
}

export interface DemoRunResult {
  ok: boolean;
  repoRoot: string;
  statusPath: string;
  scenes: DemoSceneResult[];
}

const DEFAULT_PLANS = [
  "examples/mvp/code-codex.plan.json",
  "examples/mvp/novel-ep1.plan.json",
] as const;

function readCodexMode(workspacePath: string): "live" | "standin" | "unknown" {
  const modePath = join(workspacePath, ".cliyard/mvp-code-demo/MODE.txt");
  if (!existsSync(modePath)) return "unknown";
  const text = readFileSync(modePath, "utf8").trim();
  if (text === "live") return "live";
  if (text === "standin") return "standin";
  return "unknown";
}

async function runOnePlan(input: {
  repoRoot: string;
  planPath: string;
  outDir: string;
  replaceExisting: boolean;
}): Promise<DemoSceneResult> {
  const raw = JSON.parse(readFileSync(resolve(input.planPath), "utf8"));
  const { planId, drafts } = compileMvpPlan(raw);
  const draft = drafts[0];
  if (!draft) throw new Error(`no drafts from ${input.planPath}`);
  const frozen = freezeContract(draft);
  const frozenPath = join(
    input.outDir,
    `${frozen.contractId}.frozen.contract.json`,
  );
  writeFrozenContract({ contract: frozen, outPath: frozenPath });
  const spin: IdleSpinResult = await runIdleSpin({
    repoRoot: input.repoRoot,
    contract: frozen,
    replaceExisting: input.replaceExisting,
  });
  const scene: DemoSceneResult = {
    scene: frozen.scene,
    planId,
    contractId: frozen.contractId,
    target: String(frozen.driver.target),
    ok: spin.ok,
    workspaceKind: spin.workspaceKind,
    spawnCwd: spin.spawnCwd,
    spawnExitCode: spin.spawnExitCode,
    trunkClean: spin.trunkClean,
    disposed: spin.disposed,
    frozenPath,
    ...(spin.error ? { error: spin.error } : {}),
  };
  if (frozen.scene === "code" && frozen.driver.target === "codex") {
    scene.codexMode = readCodexMode(spin.worktreePath);
  }
  return scene;
}

export async function runMvpDemo(input: {
  repoRoot: string;
  planPaths?: string[];
  replaceExisting?: boolean;
}): Promise<DemoRunResult> {
  const repoRoot = resolve(input.repoRoot);
  const replaceExisting = input.replaceExisting !== false;
  const planPaths = (input.planPaths?.length
    ? input.planPaths
    : [...DEFAULT_PLANS]
  ).map((p) => resolve(p));
  const outDir = join(repoRoot, ".cliyard", "mvp-demo", "contracts");
  mkdirSync(outDir, { recursive: true });

  const scenes: DemoSceneResult[] = [];
  for (const planPath of planPaths) {
    scenes.push(
      await runOnePlan({
        repoRoot,
        planPath,
        outDir,
        replaceExisting,
      }),
    );
  }

  const status = {
    ok: scenes.every((s) => s.ok),
    generatedAt: new Date().toISOString(),
    repoRoot,
    scenes,
    nonClaims: [
      "No auto-merge to main",
      "codexMode=standin means binary was absent; not a live model session",
      "novel scene uses local-cli stand-in, not live dsh-llm",
    ],
  };
  const statusPath = join(repoRoot, ".cliyard", "mvp-demo", "status.json");
  writeFileSync(statusPath, `${JSON.stringify(status, null, 2)}\n`, "utf8");
  return {
    ok: status.ok,
    repoRoot,
    statusPath,
    scenes,
  };
}

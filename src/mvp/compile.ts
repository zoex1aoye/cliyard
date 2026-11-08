/**
 * MVP M3: deterministic Plan → unfrozen local-cli TaskContract draft(s).
 * No LLM. Does not dispatch.
 */
import {
  LOCAL_CLI_TASK_CONTRACT_VERSION,
  assertLocalCliTaskContract,
  type LocalCliScene,
  type LocalCliTaskContract,
} from "./taskcontract.js";

export interface MvpPlanTask {
  taskId: string;
  goal: string;
  acceptance: string[];
  nonGoals?: string[];
  workspace: LocalCliTaskContract["workspace"];
  driver: LocalCliTaskContract["driver"];
  verify: LocalCliTaskContract["verify"];
  cleanup?: LocalCliTaskContract["cleanup"];
  sandbox?: LocalCliTaskContract["sandbox"];
  dependsOn?: string[];
  assets?: LocalCliTaskContract["intent"]["assets"];
}

export interface MvpPlan {
  planId: string;
  scene?: LocalCliScene;
  tasks: MvpPlanTask[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function parseMvpPlan(raw: unknown): MvpPlan {
  if (!isRecord(raw)) throw new Error("plan must be an object");
  if (typeof raw.planId !== "string" || raw.planId.trim() === "") {
    throw new Error("plan.planId required");
  }
  if (!Array.isArray(raw.tasks) || raw.tasks.length === 0) {
    throw new Error("plan.tasks must be a non-empty array");
  }
  const scene =
    raw.scene === "novel" || raw.scene === "drama" || raw.scene === "code"
      ? raw.scene
      : "code";
  const tasks: MvpPlanTask[] = raw.tasks.map((task, i) => {
    if (!isRecord(task)) throw new Error(`plan.tasks[${i}] must be object`);
    if (typeof task.taskId !== "string" || task.taskId.trim() === "") {
      throw new Error(`plan.tasks[${i}].taskId required`);
    }
    if (typeof task.goal !== "string" || task.goal.trim() === "") {
      throw new Error(`plan.tasks[${i}].goal required`);
    }
    if (
      !Array.isArray(task.acceptance) ||
      task.acceptance.length === 0 ||
      !task.acceptance.every((x) => typeof x === "string" && x.trim() !== "")
    ) {
      throw new Error(`plan.tasks[${i}].acceptance must be non-empty string[]`);
    }
    if (!isRecord(task.workspace)) {
      throw new Error(`plan.tasks[${i}].workspace required`);
    }
    if (!isRecord(task.driver)) {
      throw new Error(`plan.tasks[${i}].driver required`);
    }
    if (!isRecord(task.verify)) {
      throw new Error(`plan.tasks[${i}].verify required`);
    }
    return {
      taskId: task.taskId,
      goal: task.goal,
      acceptance: task.acceptance as string[],
      ...(Array.isArray(task.nonGoals)
        ? { nonGoals: task.nonGoals as string[] }
        : {}),
      workspace: task.workspace as LocalCliTaskContract["workspace"],
      driver: task.driver as LocalCliTaskContract["driver"],
      verify: task.verify as LocalCliTaskContract["verify"],
      ...(isRecord(task.cleanup)
        ? { cleanup: task.cleanup as LocalCliTaskContract["cleanup"] }
        : {}),
      ...(isRecord(task.sandbox)
        ? { sandbox: task.sandbox as LocalCliTaskContract["sandbox"] }
        : {}),
      ...(Array.isArray(task.dependsOn)
        ? { dependsOn: task.dependsOn as string[] }
        : {}),
      ...(Array.isArray(task.assets)
        ? { assets: task.assets as LocalCliTaskContract["intent"]["assets"] }
        : {}),
    };
  });
  return { planId: raw.planId.trim(), scene, tasks };
}

/**
 * Compile Plan → unfrozen drafts. Validates shape as if frozen=false.
 */
export function compileMvpPlan(raw: unknown): {
  planId: string;
  drafts: LocalCliTaskContract[];
} {
  const plan = parseMvpPlan(raw);
  const drafts = plan.tasks.map((task) => {
    const draft: LocalCliTaskContract = {
      contractVersion: LOCAL_CLI_TASK_CONTRACT_VERSION,
      contractId: task.taskId,
      scene: plan.scene ?? "code",
      frozen: false,
      planId: plan.planId,
      dependsOn: task.dependsOn ?? [],
      intent: {
        goal: task.goal,
        acceptance: task.acceptance,
        ...(task.nonGoals ? { nonGoals: task.nonGoals } : {}),
        ...(task.assets ? { assets: task.assets } : {}),
      },
      workspace: task.workspace,
      driver: task.driver,
      sandbox: task.sandbox ?? { mode: "none" },
      verify: task.verify,
      cleanup: task.cleanup ?? {
        onCancel: "dispose-child",
        keepWorkspace: true,
      },
    };
    // Validate draft (frozen=false is allowed by schema).
    return assertLocalCliTaskContract(draft);
  });
  return { planId: plan.planId, drafts };
}

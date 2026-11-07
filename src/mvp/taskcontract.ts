/**
 * Local-CLI TaskContract v0 — hand validator (no ajv).
 * Design: design/dsh-plugin-cliyard-taskcontract-v0.md
 */
export const LOCAL_CLI_TASK_CONTRACT_VERSION = 1 as const;

export type LocalCliScene = "code" | "novel" | "drama";
export type SandboxMode = "none" | "docker" | "low-priv";

const CONTRACT_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const REGISTRY_TARGET =
  /^(claude|codex|opencode|dsh\.chat|multimodal\.render|custom:[A-Za-z0-9][A-Za-z0-9._:-]{0,63})$/;

export type TaskContractIssue = { path: string; message: string };

export interface LocalCliTaskContract {
  contractVersion: typeof LOCAL_CLI_TASK_CONTRACT_VERSION;
  contractId: string;
  scene: LocalCliScene;
  frozen: boolean;
  frozenAt?: string;
  planId?: string;
  dependsOn?: string[];
  intent: {
    goal: string;
    nonGoals?: string[];
    acceptance: string[];
    assets?: Array<{
      id: string;
      kind: "text" | "image" | "video" | "audio" | "code" | "url";
      path?: string;
      uri?: string;
      role: "style" | "spec" | "reference" | "input" | "fixture";
    }>;
  };
  workspace: {
    kind: "git-worktree" | "assets";
    path: string;
    baseRef?: string;
    writeRoots: string[];
    snapshotFrom?: string;
  };
  driver: Record<string, unknown>;
  sandbox: { mode: SandboxMode };
  verify: {
    commands: Array<{ argv: string[]; cwd?: "workspace" | "repo" }>;
  };
  cleanup: { onCancel: "dispose-child"; keepWorkspace: boolean };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function looksAbsolutePath(value: string): boolean {
  if (value.startsWith("/") || value.startsWith("\\")) return true;
  if (/^[A-Za-z]:[\\/]/.test(value)) return true;
  return false;
}

export function validateLocalCliTaskContract(raw: unknown): {
  ok: true;
  contract: LocalCliTaskContract;
} | {
  ok: false;
  issues: TaskContractIssue[];
} {
  const issues: TaskContractIssue[] = [];
  if (!isRecord(raw)) {
    return {
      ok: false,
      issues: [{ path: "", message: "contract must be an object" }],
    };
  }

  if (raw.contractVersion !== LOCAL_CLI_TASK_CONTRACT_VERSION) {
    issues.push({
      path: "contractVersion",
      message: `must be ${LOCAL_CLI_TASK_CONTRACT_VERSION}`,
    });
  }
  if (typeof raw.contractId !== "string" || !CONTRACT_ID.test(raw.contractId)) {
    issues.push({
      path: "contractId",
      message: "must match safe id pattern",
    });
  }
  if (raw.scene !== "code" && raw.scene !== "novel" && raw.scene !== "drama") {
    issues.push({ path: "scene", message: "must be code|novel|drama" });
  }
  if (typeof raw.frozen !== "boolean") {
    issues.push({ path: "frozen", message: "must be boolean" });
  }
  if (raw.frozen === true) {
    if (typeof raw.frozenAt !== "string" || raw.frozenAt.trim() === "") {
      issues.push({
        path: "frozenAt",
        message: "required non-empty string when frozen",
      });
    }
  }

  if (!isRecord(raw.intent)) {
    issues.push({ path: "intent", message: "required object" });
  } else {
    if (typeof raw.intent.goal !== "string" || raw.intent.goal.trim() === "") {
      issues.push({ path: "intent.goal", message: "required non-empty string" });
    }
    if (
      !Array.isArray(raw.intent.acceptance) ||
      raw.intent.acceptance.length === 0 ||
      !raw.intent.acceptance.every(
        (x) => typeof x === "string" && x.trim() !== "",
      )
    ) {
      issues.push({
        path: "intent.acceptance",
        message: "must be non-empty string[]",
      });
    }
    if (raw.intent.assets !== undefined) {
      if (!Array.isArray(raw.intent.assets)) {
        issues.push({ path: "intent.assets", message: "must be array" });
      } else {
        raw.intent.assets.forEach((asset, i) => {
          if (!isRecord(asset)) {
            issues.push({
              path: `intent.assets[${i}]`,
              message: "must be object",
            });
            return;
          }
          if (typeof asset.id !== "string" || asset.id.trim() === "") {
            issues.push({
              path: `intent.assets[${i}].id`,
              message: "required",
            });
          }
          const hasPath = typeof asset.path === "string" && asset.path !== "";
          const hasUri = typeof asset.uri === "string" && asset.uri !== "";
          if (!hasPath && !hasUri) {
            issues.push({
              path: `intent.assets[${i}]`,
              message: "path or uri required",
            });
          }
          if (hasPath && looksAbsolutePath(String(asset.path))) {
            issues.push({
              path: `intent.assets[${i}].path`,
              message: "must be repo-relative (no absolute path)",
            });
          }
        });
      }
    }
  }

  if (!isRecord(raw.workspace)) {
    issues.push({ path: "workspace", message: "required object" });
  } else {
    if (
      raw.workspace.kind !== "git-worktree" &&
      raw.workspace.kind !== "assets"
    ) {
      issues.push({
        path: "workspace.kind",
        message: "must be git-worktree|assets",
      });
    }
    if (
      typeof raw.workspace.path !== "string" ||
      raw.workspace.path.trim() === ""
    ) {
      issues.push({ path: "workspace.path", message: "required" });
    } else if (looksAbsolutePath(raw.workspace.path)) {
      issues.push({
        path: "workspace.path",
        message: "must be repo-relative (no absolute path)",
      });
    }
    if (raw.workspace.kind === "git-worktree") {
      if (
        typeof raw.workspace.baseRef !== "string" ||
        raw.workspace.baseRef.trim() === ""
      ) {
        issues.push({
          path: "workspace.baseRef",
          message: "required for git-worktree",
        });
      }
    }
    if (
      !Array.isArray(raw.workspace.writeRoots) ||
      raw.workspace.writeRoots.length === 0 ||
      !raw.workspace.writeRoots.every(
        (x) => typeof x === "string" && x.trim() !== "",
      )
    ) {
      issues.push({
        path: "workspace.writeRoots",
        message: "must be non-empty string[]",
      });
    }
  }

  if (!isRecord(raw.driver)) {
    issues.push({ path: "driver", message: "required object" });
  } else {
    const kind = raw.driver.kind;
    if (
      kind !== "local-cli" &&
      kind !== "dsh-llm" &&
      kind !== "external-api"
    ) {
      issues.push({
        path: "driver.kind",
        message: "must be local-cli|dsh-llm|external-api",
      });
    }
    if (typeof raw.driver.target !== "string") {
      issues.push({ path: "driver.target", message: "required string" });
    } else {
      if (looksAbsolutePath(raw.driver.target)) {
        issues.push({
          path: "driver.target",
          message: "registry id only; absolute paths forbidden",
        });
      } else if (!REGISTRY_TARGET.test(raw.driver.target)) {
        issues.push({
          path: "driver.target",
          message:
            "must be claude|codex|opencode|dsh.chat|multimodal.render|custom:<name>",
        });
      }
    }
    if (
      typeof raw.driver.timeoutSec !== "number" ||
      !Number.isInteger(raw.driver.timeoutSec) ||
      raw.driver.timeoutSec < 1
    ) {
      issues.push({
        path: "driver.timeoutSec",
        message: "must be integer >= 1",
      });
    }
    if (kind === "local-cli") {
      if (
        !Array.isArray(raw.driver.argv) ||
        raw.driver.argv.length === 0 ||
        !raw.driver.argv.every((x) => typeof x === "string")
      ) {
        issues.push({
          path: "driver.argv",
          message: "required non-empty string[] for local-cli",
        });
      }
    }
  }

  if (!isRecord(raw.sandbox) || typeof raw.sandbox.mode !== "string") {
    issues.push({ path: "sandbox.mode", message: "required" });
  } else if (
    raw.sandbox.mode !== "none" &&
    raw.sandbox.mode !== "docker" &&
    raw.sandbox.mode !== "low-priv"
  ) {
    issues.push({
      path: "sandbox.mode",
      message: "must be none|docker|low-priv",
    });
  }

  if (!isRecord(raw.verify) || !Array.isArray(raw.verify.commands)) {
    issues.push({ path: "verify.commands", message: "required array" });
  } else if (raw.verify.commands.length === 0) {
    issues.push({
      path: "verify.commands",
      message: "must have at least one command",
    });
  } else {
    raw.verify.commands.forEach((cmd, i) => {
      if (!isRecord(cmd) || !Array.isArray(cmd.argv) || cmd.argv.length === 0) {
        issues.push({
          path: `verify.commands[${i}].argv`,
          message: "required non-empty string[]",
        });
      }
    });
  }

  if (!isRecord(raw.cleanup)) {
    issues.push({ path: "cleanup", message: "required object" });
  } else {
    if (raw.cleanup.onCancel !== "dispose-child") {
      issues.push({
        path: "cleanup.onCancel",
        message: 'must be "dispose-child"',
      });
    }
    if (typeof raw.cleanup.keepWorkspace !== "boolean") {
      issues.push({
        path: "cleanup.keepWorkspace",
        message: "must be boolean",
      });
    }
  }

  if (issues.length > 0) return { ok: false, issues };
  return { ok: true, contract: raw as unknown as LocalCliTaskContract };
}

export function assertLocalCliTaskContract(
  raw: unknown,
): LocalCliTaskContract {
  const result = validateLocalCliTaskContract(raw);
  if (!result.ok) {
    const detail = result.issues
      .map((i) => `${i.path || "(root)"}: ${i.message}`)
      .join("; ");
    throw new Error(`invalid local-CLI TaskContract: ${detail}`);
  }
  return result.contract;
}

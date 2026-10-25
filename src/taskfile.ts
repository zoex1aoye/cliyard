import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type {
  PermissionIntent,
  TaskFile,
  TaskFileItem,
  WorkerId,
} from "./types.js";

/**
 * Minimal YAML loader for taskfiles (no dependency).
 * Supports the shape in examples/module.tasks.yaml.
 */
export function loadTaskFile(path: string): TaskFile {
  const text = readFileSync(resolve(path), "utf8");
  const lines = text.split(/\r?\n/);

  let repo = "";
  const shared: TaskFile["shared"] = {
    contract_files: [],
  };
  const tasks: TaskFileItem[] = [];

  type Mode = "root" | "shared" | "shared_contracts" | "tasks" | "task";
  let mode: Mode = "root";
  let current: Partial<TaskFileItem> | null = null;
  let promptBuf: string[] | null = null;
  let promptIndent = 0;

  const flushTask = () => {
    if (!current) return;
    if (promptBuf) {
      current.prompt = promptBuf.join("\n").trimEnd();
      promptBuf = null;
    }
    if (!current.id || !current.prompt) {
      throw new Error(
        `Invalid task (need id + prompt): ${JSON.stringify(current)}`,
      );
    }
    tasks.push({
      id: current.id,
      prompt: current.prompt,
      model: current.model,
      fallback_model: current.fallback_model,
      paths: current.paths ?? [],
      worker: current.worker,
      permission: current.permission,
    });
    current = null;
  };

  for (const raw of lines) {
    const noComment = raw.replace(/(^|\s)#.*$/, "");
    if (promptBuf) {
      const indent = noComment.match(/^(\s*)/)?.[1].length ?? 0;
      if (noComment.trim() === "" || indent > promptIndent) {
        promptBuf.push(noComment.slice(Math.min(indent, promptIndent + 2)));
        continue;
      }
      current!.prompt = promptBuf.join("\n").trimEnd();
      promptBuf = null;
    }

    if (!noComment.trim()) continue;

    if (/^repo:\s*/.test(noComment)) {
      repo = unquote(noComment.replace(/^repo:\s*/, "").trim());
      mode = "root";
      continue;
    }
    if (/^shared:\s*$/.test(noComment)) {
      mode = "shared";
      continue;
    }
    if (/^tasks:\s*$/.test(noComment)) {
      flushTask();
      mode = "tasks";
      continue;
    }

    if (mode === "shared" || mode === "shared_contracts") {
      if (/^\s+contract_files:\s*$/.test(noComment)) {
        mode = "shared_contracts";
        continue;
      }
      if (mode === "shared_contracts" && /^\s+-\s+/.test(noComment)) {
        shared.contract_files!.push(
          unquote(noComment.replace(/^\s+-\s+/, "").trim()),
        );
        continue;
      }
      const m = noComment.match(/^\s+(permission|worker|max_parallel):\s*(.+)$/);
      if (m) {
        const key = m[1];
        const val = unquote(m[2].trim());
        if (key === "permission" && isPermission(val)) shared.permission = val;
        if (key === "worker" && isWorkerOrAuto(val)) shared.worker = val;
        if (key === "max_parallel") shared.max_parallel = Number(val);
        mode = "shared";
        continue;
      }
      if (/^[a-z]/.test(noComment)) {
        mode = "root";
      }
    }

    if (mode === "tasks" || mode === "task") {
      if (/^\s*-\s+id:\s*/.test(noComment)) {
        flushTask();
        current = {
          id: unquote(noComment.replace(/^\s*-\s+id:\s*/, "").trim()),
          paths: [],
        };
        mode = "task";
        continue;
      }
      if (!current) continue;

      if (/^\s+prompt:\s*\|\s*$/.test(noComment)) {
        promptBuf = [];
        promptIndent = (noComment.match(/^(\s*)/)?.[1].length ?? 0);
        continue;
      }
      if (/^\s+prompt:\s+/.test(noComment)) {
        current.prompt = unquote(noComment.replace(/^\s+prompt:\s+/, "").trim());
        continue;
      }
      if (/^\s+paths:\s*$/.test(noComment)) {
        current.paths = current.paths ?? [];
        continue;
      }
      if (/^\s+-\s+/.test(noComment) && current.paths) {
        // could be paths list item
        const item = unquote(noComment.replace(/^\s+-\s+/, "").trim());
        if (!noComment.includes("id:")) current.paths.push(item);
        continue;
      }
      const kv = noComment.match(
        /^\s+(model|fallback_model|worker|permission):\s*(.+)$/,
      );
      if (kv) {
        const key = kv[1];
        const val = unquote(kv[2].trim());
        if (key === "model") current.model = val;
        if (key === "fallback_model") current.fallback_model = val;
        if (key === "worker" && isWorkerOrAuto(val)) current.worker = val;
        if (key === "permission" && isPermission(val)) current.permission = val;
      }
    }
  }
  flushTask();

  if (!repo) throw new Error(`taskfile missing repo: ${path}`);
  if (!tasks.length) throw new Error(`taskfile has no tasks: ${path}`);

  return { repo, shared, tasks };
}

function unquote(s: string): string {
  return s.replace(/^["']|["']$/g, "");
}

function isPermission(s: string): s is PermissionIntent {
  return s === "accept" || s === "bypass";
}

function isWorkerOrAuto(s: string): s is WorkerId | "auto" {
  return (
    s === "auto" || s === "claude" || s === "codex" || s === "codebuddy"
  );
}

export function buildPrompt(task: TaskFileItem, contractFiles: string[]): string {
  const parts: string[] = [];
  if (contractFiles.length) {
    parts.push(
      "Read these contract files before coding (do not modify them unless the task says so):",
    );
    for (const f of contractFiles) parts.push(`- ${f}`);
    parts.push("");
  }
  if (task.paths?.length) {
    parts.push(
      `Only modify files under these paths: ${task.paths.join(", ")}`,
    );
    parts.push("");
  }
  parts.push(task.prompt.trim());
  return parts.join("\n");
}

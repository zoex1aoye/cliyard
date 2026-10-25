import type { PermissionIntent, WorkerId } from "./types.js";
import { shellQuote } from "./wsl.js";

/**
 * Map harness intent → CLI-native argv.
 * Prefer each product's own sandbox/permission flags; do not wrap Docker here.
 */
export function buildWorkerCommand(
  worker: WorkerId,
  prompt: string,
  permission: PermissionIntent,
): string {
  const q = shellQuote(prompt);

  switch (worker) {
    case "claude": {
      // Non-interactive print mode. Sandbox is CLI-managed when enabled by user.
      const perm =
        permission === "bypass"
          ? "--permission-mode bypassPermissions"
          : "--permission-mode acceptEdits";
      return `claude -p ${q} ${perm}`;
    }
    case "codex": {
      // exec = non-interactive. workspace-write = OS sandbox when available.
      const sandbox =
        permission === "bypass"
          ? "--sandbox danger-full-access"
          : "--sandbox workspace-write";
      const approval =
        permission === "bypass"
          ? "--ask-for-approval never"
          : "--ask-for-approval on-failure";
      return `codex exec ${sandbox} ${approval} ${q}`;
    }
    case "codebuddy": {
      const perm =
        permission === "bypass"
          ? "--permission-mode bypassPermissions"
          : "--permission-mode acceptEdits";
      // -p print/non-interactive; bypass often required with -p when tools need auth
      const danger = permission === "bypass" ? "--dangerously-skip-permissions" : "";
      return `codebuddy -p ${q} ${perm} ${danger}`.trim();
    }
    default: {
      const _exhaustive: never = worker;
      return _exhaustive;
    }
  }
}

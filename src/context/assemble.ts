/**
 * Assemble a self-contained briefing markdown for a TaskContract.
 * Workers (mock or real) can read this file instead of a chat history.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { TaskContract } from "../contracts/schema.js";

export interface AssembleExtras {
  /** Extra contract / req file paths to list (in addition to readPaths). */
  contractFiles?: string[];
  /** Short notes from upstream accepted tasks. */
  priorOutcomes?: string[];
  /** Repo / run label for the header. */
  repoHint?: string;
}

/** Render briefing markdown (no I/O). */
export function assembleBriefing(
  contract: TaskContract,
  extras: AssembleExtras = {},
): string {
  const lines: string[] = [];
  lines.push(`# Briefing: ${contract.taskId}`);
  lines.push("");
  lines.push(`- version: ${contract.version}`);
  lines.push(`- frozen: ${contract.frozen}`);
  lines.push(`- baseCommit: \`${contract.baseCommit}\``);
  lines.push(`- maxRepairs: ${contract.maxRepairs}`);
  if (extras.repoHint) lines.push(`- repo: ${extras.repoHint}`);
  lines.push("");

  lines.push("## Goals");
  for (const g of contract.goals) lines.push(`- ${g}`);
  lines.push("");

  if (contract.nonGoals?.length) {
    lines.push("## Non-goals");
    for (const g of contract.nonGoals) lines.push(`- ${g}`);
    lines.push("");
  }

  if (contract.dependsOn.length) {
    lines.push("## Depends on");
    for (const d of contract.dependsOn) lines.push(`- ${d}`);
    lines.push("");
  }

  const contractFiles = extras.contractFiles ?? [];
  if (contractFiles.length) {
    lines.push("## Contract files (read first)");
    for (const f of contractFiles) lines.push(`- ${f}`);
    lines.push("");
  }

  lines.push("## Paths");
  lines.push("### Read");
  for (const p of contract.readPaths) lines.push(`- ${p}`);
  if (!contract.readPaths.length) lines.push("- _(none)_");
  lines.push("");
  lines.push("### Write (only these)");
  for (const p of contract.writePaths) lines.push(`- ${p}`);
  lines.push("");

  if (contract.sharedResources.length) {
    lines.push("## Shared resources (serialize)");
    for (const r of contract.sharedResources) lines.push(`- ${r}`);
    lines.push("");
  }

  if (contract.verifyCommands.length) {
    lines.push("## Verify commands");
    for (const c of contract.verifyCommands) lines.push(`- \`${c}\``);
    lines.push("");
  }

  if (contract.deliverables?.length) {
    lines.push("## Deliverables");
    for (const d of contract.deliverables) lines.push(`- ${d}`);
    lines.push("");
  }

  if (contract.forbidden?.length) {
    lines.push("## Forbidden");
    for (const f of contract.forbidden) lines.push(`- ${f}`);
    lines.push("");
  }

  if (extras.priorOutcomes?.length) {
    lines.push("## Prior task outcomes");
    for (const o of extras.priorOutcomes) lines.push(`- ${o}`);
    lines.push("");
  }

  lines.push("## Instructions");
  lines.push(
    "Stay inside writePaths. Do not modify contract files unless a goal says so.",
  );
  lines.push(
    "Acceptance is decided by an independent verifier after implement — exit 0 from the worker is not acceptance.",
  );
  lines.push("");

  return lines.join("\n");
}

/**
 * Write `briefing/<taskId>.md` under `briefingDir` (created if needed).
 * Returns the absolute path written.
 */
export function writeBriefingFile(
  contract: TaskContract,
  briefingDir: string,
  extras: AssembleExtras = {},
): string {
  mkdirSync(briefingDir, { recursive: true });
  const outPath = join(briefingDir, `${contract.taskId}.md`);
  writeFileSync(outPath, assembleBriefing(contract, extras), "utf8");
  return outPath;
}

/**
 * Durable human intervention ledger
 * (design/intervention-ledger-v0.md).
 */
import { randomUUID } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  isHumanInterventionEvent,
  isInterventionOutcome,
  isInterventionRole,
  type HumanInterventionEvent,
  type InterventionOutcome,
  type InterventionRole,
} from "./types.js";
import {
  MAX_INTERVENTION_ARTIFACT_REF_CHARS,
  MAX_INTERVENTION_NOTE_CHARS,
  MAX_INTERVENTION_REASON_CHARS,
  InterventionSanitizeError,
  sanitizeInterventionText,
} from "./sanitize.js";

export class InterventionLedgerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

export function interventionDir(repoRoot: string): string {
  return join(repoRoot, ".cliyard", "interventions");
}

export function interventionPath(repoRoot: string, id: string): string {
  if (!/^[A-Za-z0-9._-]+$/.test(id)) {
    throw new InterventionLedgerError(`invalid intervention id: ${id}`);
  }
  return join(interventionDir(repoRoot), `${id}.json`);
}

function indexPath(repoRoot: string): string {
  return join(interventionDir(repoRoot), "index.jsonl");
}

function ensureDir(repoRoot: string): void {
  mkdirSync(interventionDir(repoRoot), { recursive: true });
}

function saveEvent(repoRoot: string, event: HumanInterventionEvent): void {
  if (!isHumanInterventionEvent(event)) {
    throw new InterventionLedgerError("refusing to persist invalid event");
  }
  ensureDir(repoRoot);
  const path = interventionPath(repoRoot, event.id);
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(event, null, 2)}\n`, "utf8");
  renameSync(tmp, path);
}

function appendIndex(repoRoot: string, id: string, observedAt: string): void {
  ensureDir(repoRoot);
  appendFileSync(
    indexPath(repoRoot),
    `${JSON.stringify({ id, observedAt })}\n`,
    "utf8",
  );
}

export interface RecordInterventionInput {
  repoRoot: string;
  loopId: string;
  role: InterventionRole;
  reason: string;
  runId?: string;
  artifactRef?: string;
  id?: string;
  now?: () => string;
}

export function recordIntervention(
  input: RecordInterventionInput,
): HumanInterventionEvent {
  if (!isInterventionRole(input.role)) {
    throw new InterventionLedgerError(`invalid intervention role: ${String(input.role)}`);
  }
  const loopId = sanitizeInterventionText(
    input.loopId,
    "loopId",
    MAX_INTERVENTION_ARTIFACT_REF_CHARS,
  );
  const reason = sanitizeInterventionText(
    input.reason,
    "reason",
    MAX_INTERVENTION_REASON_CHARS,
  );
  const now = input.now ?? (() => new Date().toISOString());
  const observedAt = now();
  const id = input.id ?? `iv-${randomUUID()}`;
  let artifactRef: string | undefined;
  if (input.artifactRef !== undefined) {
    artifactRef = sanitizeInterventionText(
      input.artifactRef,
      "artifactRef",
      MAX_INTERVENTION_ARTIFACT_REF_CHARS,
    );
  }
  let runId: string | undefined;
  if (input.runId !== undefined) {
    runId = sanitizeInterventionText(
      input.runId,
      "runId",
      MAX_INTERVENTION_ARTIFACT_REF_CHARS,
    );
  }
  const event: HumanInterventionEvent = {
    version: 1,
    id,
    loopId,
    role: input.role,
    reason,
    outcome: "unresolved",
    observedAt,
    ...(runId !== undefined ? { runId } : {}),
    ...(artifactRef !== undefined ? { artifactRef } : {}),
  };
  saveEvent(input.repoRoot, event);
  appendIndex(input.repoRoot, event.id, observedAt);
  return event;
}

export interface ResolveInterventionInput {
  repoRoot: string;
  id: string;
  outcome: Exclude<InterventionOutcome, "unresolved">;
  note?: string;
  now?: () => string;
}

export function resolveIntervention(
  input: ResolveInterventionInput,
): HumanInterventionEvent {
  if (
    input.outcome !== "resolved" &&
    input.outcome !== "rejected" &&
    input.outcome !== "obsolete"
  ) {
    throw new InterventionLedgerError(
      `resolve outcome must be resolved|rejected|obsolete`,
    );
  }
  const existing = loadIntervention(input.repoRoot, input.id);
  if (!existing) {
    throw new InterventionLedgerError(`unknown intervention: ${input.id}`);
  }
  if (existing.outcome !== "unresolved") {
    throw new InterventionLedgerError(
      `cannot resolve intervention in outcome ${existing.outcome}`,
    );
  }
  const now = input.now ?? (() => new Date().toISOString());
  let resolutionNote: string | undefined;
  if (input.note !== undefined) {
    resolutionNote = sanitizeInterventionText(
      input.note,
      "resolutionNote",
      MAX_INTERVENTION_NOTE_CHARS,
    );
  }
  const next: HumanInterventionEvent = {
    ...existing,
    outcome: input.outcome,
    resolvedAt: now(),
    ...(resolutionNote !== undefined ? { resolutionNote } : {}),
  };
  saveEvent(input.repoRoot, next);
  return next;
}

export function loadIntervention(
  repoRoot: string,
  id: string,
): HumanInterventionEvent | null {
  const path = interventionPath(repoRoot, id);
  if (!existsSync(path)) return null;
  const raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
  if (!isHumanInterventionEvent(raw)) {
    throw new InterventionLedgerError(`invalid intervention at ${path}`);
  }
  return raw;
}

export function listInterventions(
  repoRoot: string,
): HumanInterventionEvent[] {
  const dir = interventionDir(repoRoot);
  if (!existsSync(dir)) return [];
  const out: HumanInterventionEvent[] = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".json") || name.includes(".tmp")) continue;
    const id = name.slice(0, -".json".length);
    const event = loadIntervention(repoRoot, id);
    if (event) out.push(event);
  }
  out.sort((a, b) => {
    const byTime = a.observedAt.localeCompare(b.observedAt);
    return byTime !== 0 ? byTime : a.id.localeCompare(b.id);
  });
  return out;
}

export { InterventionSanitizeError };

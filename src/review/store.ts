/**
 * Durable review session store under `.cliyard/reviews/<id>.json`.
 */
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  isReviewSessionRecord,
  type ReviewSessionRecord,
} from "./types.js";

export function reviewDir(repoRoot: string): string {
  return join(repoRoot, ".cliyard", "reviews");
}

export function reviewSessionPath(repoRoot: string, id: string): string {
  if (!/^[A-Za-z0-9._-]+$/.test(id)) {
    throw new Error(`invalid review session id: ${id}`);
  }
  return join(reviewDir(repoRoot), `${id}.json`);
}

export function ensureReviewDir(repoRoot: string): string {
  const dir = reviewDir(repoRoot);
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function saveReviewSession(
  repoRoot: string,
  session: ReviewSessionRecord,
): void {
  if (!isReviewSessionRecord(session)) {
    throw new Error("refusing to persist invalid ReviewSessionRecord");
  }
  ensureReviewDir(repoRoot);
  const path = reviewSessionPath(repoRoot, session.id);
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(session, null, 2)}\n`, "utf8");
  renameSync(tmp, path);
}

export function loadReviewSession(
  repoRoot: string,
  id: string,
): ReviewSessionRecord | null {
  const path = reviewSessionPath(repoRoot, id);
  if (!existsSync(path)) return null;
  const raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
  if (!isReviewSessionRecord(raw)) {
    throw new Error(`invalid ReviewSessionRecord at ${path}`);
  }
  return raw;
}

export function listReviewSessions(repoRoot: string): ReviewSessionRecord[] {
  const dir = reviewDir(repoRoot);
  if (!existsSync(dir)) return [];
  const out: ReviewSessionRecord[] = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".json") || name.includes(".tmp")) continue;
    const id = name.slice(0, -".json".length);
    const session = loadReviewSession(repoRoot, id);
    if (session) out.push(session);
  }
  out.sort((a, b) => a.id.localeCompare(b.id));
  return out;
}

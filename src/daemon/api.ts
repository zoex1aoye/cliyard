/**
 * cliyardd read-only Control API v1 (P2a).
 *
 * Three GET endpoints, and nothing else:
 *
 * - `GET /v1/status` — the authoritative control snapshot reconstructed from
 *   the StateStore read projection, plus an opaque state version token;
 * - `GET /v1/events?after=<cursor>[&limit=<n>]` — bounded NDJSON replay of the
 *   queue event journal, newest window first bounded by the projection;
 * - `GET /v1/runs/:runId` — one projected RunManifest and its content-addressed
 *   evidence reference.
 *
 * Read-only discipline: every request rebuilds the read projection through
 * `buildStateStoreReadView` (JSON truth -> in-memory StateStore -> projected
 * records). Nothing here appends a fact, writes a queue/run/ledger file or
 * changes acceptance. The projection is process-local and discarded after the
 * response.
 *
 * Version token: `st1_<seedHash>` is the StateStore read projection's seed
 * hash. It covers queue, run, ledger and journal records and deliberately
 * excludes the materialized control snapshot, which carries host-sampled
 * resources and read-time worker ages. Two requests over unchanged durable
 * state therefore return the same token even though `observedAt` differs.
 *
 * Cursors are content-addressed (`ev1_<hash>`) rather than positional, so an
 * old cursor either identifies the same journal event or fails as an unknown
 * cursor after the bounded window rolls; it can never silently point at a
 * different event.
 */
import { createHash } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { QueueControlEvent } from "../orchestration/event-journal.js";
import {
  MemoryStateStoreEvidenceStore,
  buildStateStoreReadView,
  canonicalJson,
  type StateStoreReadView,
  type StateStoreSeedRecord,
} from "../statestore/read.js";
import { validateEvidenceRef, type EvidenceRef } from "../statestore/schema.js";
import {
  StateStore,
  createMemoryStateStoreDriver,
  type StateStoreDriver,
  type StateStoreTransaction,
} from "../statestore/store.js";
import type { RunManifest } from "../supervisor/types.js";

export const CONTROL_API_VERSION = 1 as const;
/**
 * The journal reader caps a replay window at 5,000 valid events. The same
 * bound is used for status and events so the version token never depends on
 * per-request query options.
 */
export const CONTROL_API_EVENT_WINDOW = 5_000;
export const CONTROL_API_DEFAULT_EVENT_LIMIT = 200;
export const CONTROL_API_MAX_EVENT_LIMIT = 500;
export const CONTROL_API_MAX_URL_LENGTH = 4_096;
export const CONTROL_API_MAX_ERROR_MESSAGE = 200;
const CONTROL_API_MAX_RUN_ID_LENGTH = 128;
const CONTROL_API_MAX_RAW_RUN_ID_LENGTH = 512;

const RUN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const CURSOR_PATTERN = /^ev1_[0-9a-f]{32}$/;
const LIMIT_PATTERN = /^[0-9]{1,6}$/;

// ---------------------------------------------------------------------------
// Response DTOs
// ---------------------------------------------------------------------------

export interface ControlApiStoreSummary {
  lastSeq: number;
  recordCount: number;
  sources: StateStoreReadView["store"]["sources"];
}

export interface ControlApiStatusResponse {
  apiVersion: typeof CONTROL_API_VERSION;
  /** Opaque state token; equal iff the durable projection is equal. */
  version: string;
  snapshot: StateStoreReadView["status"];
  store: ControlApiStoreSummary;
}

/** One NDJSON line: the journal event plus the cursor that addresses it. */
export interface ControlApiEventLine extends QueueControlEvent {
  /** Content-addressed replay cursor; pass to `?after=`. */
  cursor: string;
}

export interface ControlApiRunEvidence {
  attemptId: string;
  recordedAt: string;
  ref: EvidenceRef;
}

export interface ControlApiRunResponse {
  apiVersion: typeof CONTROL_API_VERSION;
  version: string;
  runId: string;
  manifest: RunManifest;
  evidence: ControlApiRunEvidence;
}

export interface ControlApiErrorResponse {
  apiVersion: typeof CONTROL_API_VERSION;
  error: {
    code: string;
    message: string;
  };
}

// ---------------------------------------------------------------------------
// Projection access
// ---------------------------------------------------------------------------

export interface ControlApiRunRecord {
  manifest: RunManifest;
  evidence: EvidenceRef;
  attemptId: string;
  recordedAt: string;
}

export interface ControlApiProjection {
  view: StateStoreReadView;
  version: string;
  readonly driver: StateStoreDriver;
  readonly evidence: MemoryStateStoreEvidenceStore;
  close(): void;
}

/**
 * Build one process-local read projection. `buildStateStoreReadView` closes
 * the driver it was given, so a close-shielded wrapper is passed; the raw
 * in-memory driver is retained for the per-request run lookup and closed by
 * `close()`.
 */
export async function openControlApiProjection(
  repoRoot: string,
): Promise<ControlApiProjection> {
  const driver = createMemoryStateStoreDriver();
  const evidence = new MemoryStateStoreEvidenceStore();
  try {
    const view = await buildStateStoreReadView(repoRoot, {
      journalLimit: CONTROL_API_EVENT_WINDOW,
      driver: shieldDriver(driver),
      evidence,
    });
    return {
      view,
      version: versionToken(view),
      driver,
      evidence,
      close: () => driver.close(),
    };
  } catch (error) {
    driver.close();
    throw error;
  }
}

/**
 * Find one run's projected seed record and evidence reference. The projection
 * stores each seed record as content-addressed evidence on an attempt whose
 * id is derived from `source:id`; scanning the evidence rows keeps this lookup
 * independent of that id derivation.
 */
export function findProjectedRun(
  projection: ControlApiProjection,
  runId: string,
): ControlApiRunRecord | null {
  const store = StateStore.open(projection.driver);
  try {
    for (const row of store.snapshot().evidence) {
      if (!row.attemptId.startsWith("run.")) continue;
      const ref = validateEvidenceRef({
        contentHash: row.contentHash,
        byteLength: row.byteLength,
        mediaType: row.mediaType,
        path: row.path,
      });
      let record: StateStoreSeedRecord;
      try {
        record = parseSeedRecord(
          JSON.parse(projection.evidence.read(ref).toString("utf8")),
        );
      } catch {
        continue;
      }
      if (record.source !== "run" || record.id !== runId) continue;
      const manifest = record.payload;
      if (!isRunManifest(manifest) || manifest.runId !== runId) continue;
      return {
        manifest,
        evidence: ref,
        attemptId: row.attemptId,
        recordedAt: row.recordedAt,
      };
    }
    return null;
  } finally {
    // Closes the raw driver; the projection is finished after this lookup.
    store.close();
  }
}

function versionToken(view: StateStoreReadView): string {
  return `st1_${view.store.seedHash}`;
}

function shieldDriver(driver: StateStoreDriver): StateStoreDriver {
  return {
    kind: driver.kind,
    initialize: () => driver.initialize(),
    transaction: <T>(work: (tx: StateStoreTransaction) => T): T =>
      driver.transaction(work),
    close: () => {
      /* the projection owner closes the raw driver */
    },
  };
}

function parseSeedRecord(value: unknown): StateStoreSeedRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("seed evidence must be a JSON object");
  }
  const record = value as Record<string, unknown>;
  if (
    record.version !== 1 ||
    typeof record.source !== "string" ||
    typeof record.id !== "string" ||
    !Object.hasOwn(record, "payload")
  ) {
    throw new Error("seed evidence is malformed");
  }
  return record as unknown as StateStoreSeedRecord;
}

function isRunManifest(value: unknown): value is RunManifest {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    typeof (value as { runId?: unknown }).runId === "string"
  );
}

// ---------------------------------------------------------------------------
// HTTP handler
// ---------------------------------------------------------------------------

export interface ControlApiHandlerOptions {
  repoRoot: string;
}

/**
 * Create a request handler for a loopback-only Control API server. The
 * caller owns the HTTP server; this module never binds a socket.
 */
export function createControlApiHandler(
  options: ControlApiHandlerOptions,
): (req: IncomingMessage, res: ServerResponse) => void {
  if (typeof options?.repoRoot !== "string" || options.repoRoot.length === 0) {
    throw new Error("Control API handler requires a repository root");
  }
  return (req, res) => {
    void handleControlApiRequest(options.repoRoot, req, res).catch((error) => {
      if (!res.headersSent) {
        sendError(
          res,
          500,
          "internal_error",
          `control projection could not be read: ${errorMessage(error)}`,
          null,
          req.method === "HEAD",
        );
        return;
      }
      res.destroy();
    });
  };
}

async function handleControlApiRequest(
  repoRoot: string,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  // A client that disconnects while a projection is being built must not
  // surface as an unhandled stream error.
  req.on("error", () => {});
  res.on("error", () => {});
  // Read-only requests have no body; drain anything a client sent so a
  // keep-alive connection cannot stall on unread bytes.
  req.resume();
  const headOnly = req.method === "HEAD";

  if (req.method !== "GET" && !headOnly) {
    sendError(res, 405, "method_not_allowed", "only GET is supported", {
      Allow: "GET, HEAD",
    }, headOnly);
    return;
  }

  const target = req.url ?? "/";
  if (target.length > CONTROL_API_MAX_URL_LENGTH) {
    sendError(res, 414, "uri_too_long", "request URL is too long", null, headOnly);
    return;
  }
  let url: URL;
  try {
    url = new URL(target, "http://127.0.0.1");
  } catch {
    sendError(res, 400, "invalid_request", "request URL is malformed", null, headOnly);
    return;
  }

  const pathname = url.pathname;
  if (pathname === "/v1/status" || pathname === "/v1/status/") {
    await serveStatus(repoRoot, res, headOnly);
    return;
  }
  if (pathname === "/v1/events" || pathname === "/v1/events/") {
    await serveEvents(repoRoot, url, res, headOnly);
    return;
  }
  if (pathname.startsWith("/v1/runs/")) {
    await serveRun(repoRoot, pathname, res, headOnly);
    return;
  }
  sendError(res, 404, "not_found", "no such control API endpoint", null, headOnly);
}

async function serveStatus(
  repoRoot: string,
  res: ServerResponse,
  headOnly: boolean,
): Promise<void> {
  const projection = await openControlApiProjection(repoRoot);
  try {
    const body: ControlApiStatusResponse = {
      apiVersion: CONTROL_API_VERSION,
      version: projection.version,
      snapshot: projection.view.status,
      store: {
        lastSeq: projection.view.store.lastSeq,
        recordCount: projection.view.store.recordCount,
        sources: projection.view.store.sources,
      },
    };
    sendJson(res, 200, body, projection.version, headOnly);
  } finally {
    projection.close();
  }
}

async function serveEvents(
  repoRoot: string,
  url: URL,
  res: ServerResponse,
  headOnly: boolean,
): Promise<void> {
  const after = parseAfter(url.searchParams.get("after"));
  if (!after.ok) {
    sendError(res, 400, after.code, after.message, null, headOnly);
    return;
  }
  const limit = parseLimit(url.searchParams.get("limit"));
  if (!limit.ok) {
    sendError(res, 400, "invalid_limit", limit.message, null, headOnly);
    return;
  }

  const projection = await openControlApiProjection(repoRoot);
  try {
    const events = projection.view.events.journal.events;
    const cursors = events.map(eventCursor);
    let start = 0;
    if (after.value !== null) {
      const index = cursors.indexOf(after.value);
      if (index < 0) {
        sendError(
          res,
          400,
          "unknown_cursor",
          "cursor is not in the current bounded event window",
          null,
          headOnly,
        );
        return;
      }
      start = index + 1;
    }
    const end = Math.min(events.length, start + limit.value);
    const lines: string[] = [];
    for (let index = start; index < end; index += 1) {
      const line: ControlApiEventLine = {
        ...events[index]!,
        // Appended last so a malformed journal record cannot shadow it.
        cursor: cursors[index]!,
      };
      lines.push(JSON.stringify(line));
    }
    const nextCursor =
      end > start ? cursors[end - 1]! : (after.value ?? "");
    sendNdjson(
      res,
      lines,
      {
        version: projection.version,
        nextCursor,
        hasMore: end < events.length,
      },
      headOnly,
    );
  } finally {
    projection.close();
  }
}

async function serveRun(
  repoRoot: string,
  pathname: string,
  res: ServerResponse,
  headOnly: boolean,
): Promise<void> {
  const raw = pathname.slice("/v1/runs/".length);
  if (raw.length === 0 || raw.length > CONTROL_API_MAX_RAW_RUN_ID_LENGTH) {
    sendError(res, 400, "invalid_run_id", "run id is missing or too long", null, headOnly);
    return;
  }
  let runId: string;
  try {
    runId = decodeURIComponent(raw);
  } catch {
    sendError(res, 400, "invalid_run_id", "run id is not valid URL text", null, headOnly);
    return;
  }
  if (
    runId.length > CONTROL_API_MAX_RUN_ID_LENGTH ||
    !RUN_ID_PATTERN.test(runId)
  ) {
    sendError(
      res,
      400,
      "invalid_run_id",
      "run id must be 1-128 characters of letters, digits, dot, dash or underscore",
      null,
      headOnly,
    );
    return;
  }

  const projection = await openControlApiProjection(repoRoot);
  try {
    const found = findProjectedRun(projection, runId);
    if (found === null) {
      sendError(
        res,
        404,
        "run_not_found",
        `run ${runId} was not found in the projection`,
        null,
        headOnly,
      );
      return;
    }
    const body: ControlApiRunResponse = {
      apiVersion: CONTROL_API_VERSION,
      version: projection.version,
      runId,
      manifest: found.manifest,
      evidence: {
        attemptId: found.attemptId,
        recordedAt: found.recordedAt,
        ref: found.evidence,
      },
    };
    sendJson(res, 200, body, projection.version, headOnly);
  } finally {
    projection.close();
  }
}

// ---------------------------------------------------------------------------
// Query parsing
// ---------------------------------------------------------------------------

type ParsedAfter =
  | { ok: true; value: string | null }
  | { ok: false; code: string; message: string };

function parseAfter(raw: string | null): ParsedAfter {
  if (raw === null) return { ok: true, value: null };
  if (!CURSOR_PATTERN.test(raw)) {
    return {
      ok: false,
      code: "invalid_cursor",
      message: "after must be a cursor returned by GET /v1/events",
    };
  }
  return { ok: true, value: raw };
}

type ParsedLimit =
  | { ok: true; value: number }
  | { ok: false; message: string };

function parseLimit(raw: string | null): ParsedLimit {
  if (raw === null) {
    return { ok: true, value: CONTROL_API_DEFAULT_EVENT_LIMIT };
  }
  if (!LIMIT_PATTERN.test(raw)) {
    return {
      ok: false,
      message: "limit must be a positive integer",
    };
  }
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    return {
      ok: false,
      message: "limit must be a positive integer",
    };
  }
  return {
    ok: true,
    value: Math.min(parsed, CONTROL_API_MAX_EVENT_LIMIT),
  };
}

// ---------------------------------------------------------------------------
// Serialization
// ---------------------------------------------------------------------------

function eventCursor(event: QueueControlEvent): string {
  return (
    "ev1_" +
    createHash("sha256")
      .update(canonicalJson(event), "utf8")
      .digest("hex")
      .slice(0, 32)
  );
}

function sendJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  version: string | undefined,
  headOnly: boolean,
): void {
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, {
    ...baseHeaders(version),
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": String(Buffer.byteLength(text, "utf8")),
  });
  if (headOnly) res.end();
  else res.end(text);
}

function sendNdjson(
  res: ServerResponse,
  lines: readonly string[],
  meta: { version: string; nextCursor: string; hasMore: boolean },
  headOnly: boolean,
): void {
  const body = lines.length === 0 ? "" : `${lines.join("\n")}\n`;
  res.writeHead(200, {
    ...baseHeaders(meta.version),
    "Content-Type": "application/x-ndjson; charset=utf-8",
    "Content-Length": String(Buffer.byteLength(body, "utf8")),
    "X-Cliyard-Next-Cursor": meta.nextCursor,
    "X-Cliyard-Has-More": meta.hasMore ? "true" : "false",
  });
  if (headOnly) res.end();
  else res.end(body);
}

function sendError(
  res: ServerResponse,
  status: number,
  code: string,
  message: string,
  extraHeaders: Record<string, string> | null,
  headOnly: boolean,
): void {
  const body: ControlApiErrorResponse = {
    apiVersion: CONTROL_API_VERSION,
    error: { code, message: boundMessage(message) },
  };
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, {
    ...baseHeaders(undefined),
    ...(extraHeaders ?? {}),
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": String(Buffer.byteLength(text, "utf8")),
  });
  if (headOnly) res.end();
  else res.end(text);
}

function baseHeaders(version: string | undefined): Record<string, string> {
  const headers: Record<string, string> = {
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "X-Cliyard-Api-Version": String(CONTROL_API_VERSION),
  };
  if (version !== undefined) headers["X-Cliyard-Version"] = version;
  return headers;
}

function boundMessage(message: string): string {
  const normalized = message.replace(/[\r\n]+/g, " ").trim();
  return normalized.length <= CONTROL_API_MAX_ERROR_MESSAGE
    ? normalized
    : `${normalized.slice(0, CONTROL_API_MAX_ERROR_MESSAGE - 1)}…`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

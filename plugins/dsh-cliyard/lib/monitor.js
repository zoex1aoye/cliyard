/**
 * Read-only ledger snapshot for the Master monitor console.
 *
 * The development cockpit treats ledger text as data, never as markup: the
 * document shell is static, ledger values arrive as JSON, and the served
 * client script writes them into DOM text nodes. A restrictive
 * Content-Security-Policy keeps inline script, inline style and third-party
 * origins out of the page.
 */
import { readFileSync, existsSync, watch } from "node:fs";
import { createServer } from "node:http";
import { resolve } from "node:path";
import { resolveRepoRoot } from "./paths.js";

const MONITOR_CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "connect-src 'self'",
  "img-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join("; ");

const SECURITY_HEADERS = Object.freeze({
  "content-security-policy": MONITOR_CSP,
  "cross-origin-resource-policy": "same-origin",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "cache-control": "no-store",
});

export function readLedgerSnapshot(ledgerPath) {
  if (!existsSync(ledgerPath)) {
    return {
      path: ledgerPath,
      tasks: [],
      updatedAt: null,
      missing: true,
    };
  }
  const raw = JSON.parse(readFileSync(ledgerPath, "utf8"));
  const tasks = Object.values(raw.tasks ?? {}).map((entry) => {
    const task =
      entry && typeof entry === "object" && !Array.isArray(entry) ? entry : {};
    const events = Array.isArray(task.events) ? task.events : [];
    return {
      taskId: task.taskId,
      status: task.status,
      repairCount: task.repairCount ?? 0,
      verdict: task.verdict,
      reason: task.reason,
      lastEvent: events.length > 0 ? events[events.length - 1] : null,
      eventCount: events.length,
    };
  });
  return {
    path: ledgerPath,
    tasks,
    updatedAt: new Date().toISOString(),
    missing: false,
  };
}

/** Static document shell. It contains no ledger data and no inline behavior. */
export const MONITOR_HTML = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>cliyard Master Monitor</title>
  <link rel="stylesheet" href="/app.css" />
</head>
<body>
  <h1>cliyard Master Monitor</h1>
  <p class="sub">Ledger: <code id="path"></code> · <span id="updated"></span></p>
  <table>
    <thead><tr><th>taskId</th><th>status</th><th>repairs</th><th>verdict</th><th>last event</th></tr></thead>
    <tbody id="rows" aria-live="polite"><tr><td colspan="5">waiting for ledger…</td></tr></tbody>
  </table>
  <script src="/app.js" defer></script>
</body>
</html>`;

/** Served stylesheet so the page needs no inline style allowance. */
export const MONITOR_STYLESHEET = `:root { font-family: ui-sans-serif, system-ui, sans-serif; color: #1a1a1a; background: #f6f4ef; }
body { margin: 1.5rem; max-width: 52rem; }
h1 { font-size: 1.25rem; margin: 0 0 0.25rem; }
.sub { color: #666; font-size: 0.85rem; margin-bottom: 1rem; }
table { width: 100%; border-collapse: collapse; background: #fff; }
th, td { text-align: left; padding: 0.5rem 0.6rem; border-bottom: 1px solid #e8e4dc; font-size: 0.9rem; }
th { background: #efebe3; }
.st-accepted { color: #0a7a3e; font-weight: 600; }
.st-rejected { color: #b00020; font-weight: 600; }
.st-running, .st-verifying, .st-repairing { color: #8a5a00; font-weight: 600; }
code { font-size: 0.8rem; }`;

/**
 * Served client script.
 *
 * Ledger-derived values are written with `textContent` only. The script never
 * assembles markup strings, so task ids, statuses, verdicts and event text
 * cannot become elements or attributes.
 */
export const MONITOR_CLIENT_SCRIPT = `(() => {
  "use strict";

  const COLSPAN = 5;
  const REFRESH_MS = 1000;

  function asText(value) {
    if (value === undefined || value === null || value === "") return "—";
    return String(value);
  }

  function emptyRow(message) {
    const row = document.createElement("tr");
    const cell = document.createElement("td");
    cell.colSpan = COLSPAN;
    cell.textContent = message;
    row.appendChild(cell);
    return row;
  }

  function statusClass(status) {
    const normalized = String(status === undefined || status === null ? "" : status)
      .toLowerCase()
      .replace(/[^a-z0-9_-]/g, "");
    return normalized ? "st-" + normalized : "";
  }

  function eventText(event) {
    if (!event || typeof event !== "object") return "—";
    const type = asText(event.type);
    const detail =
      event.detail === undefined || event.detail === null
        ? ""
        : String(event.detail);
    if (type !== "—" && detail) return type + ": " + detail;
    if (type !== "—") return type;
    return detail || "—";
  }

  function textCell(value, className) {
    const cell = document.createElement("td");
    if (className) cell.className = className;
    cell.textContent = asText(value);
    return cell;
  }

  function eventCell(event) {
    const cell = document.createElement("td");
    const code = document.createElement("code");
    code.textContent = eventText(event);
    cell.appendChild(code);
    return cell;
  }

  function taskRow(task) {
    const value = task && typeof task === "object" ? task : {};
    const row = document.createElement("tr");
    row.appendChild(textCell(value.taskId));
    row.appendChild(textCell(value.status, statusClass(value.status)));
    row.appendChild(textCell(value.repairCount));
    row.appendChild(textCell(value.verdict));
    row.appendChild(eventCell(value.lastEvent));
    return row;
  }

  async function tick() {
    const response = await fetch("/api/ledger", { cache: "no-store" });
    if (!response.ok) throw new Error("ledger request failed: " + response.status);
    const data = await response.json();
    document.getElementById("path").textContent = asText(data.path);
    document.getElementById("updated").textContent =
      data.updatedAt || (data.missing ? "missing" : "");
    const rows = document.getElementById("rows");
    const tasks = Array.isArray(data.tasks) ? data.tasks : [];
    if (tasks.length === 0) {
      rows.replaceChildren(
        emptyRow(data.missing ? "ledger not created yet" : "no tasks"),
      );
      return;
    }
    rows.replaceChildren(...tasks.map(taskRow));
  }

  function showError(error) {
    const rows = document.getElementById("rows");
    rows.replaceChildren(
      emptyRow(
        "monitor error: " +
          (error instanceof Error ? error.message : String(error)),
      ),
    );
  }

  tick().catch(showError);
  setInterval(() => {
    tick().catch(() => {});
  }, REFRESH_MS);
})();`;

export function startMonitorServer(opts = {}) {
  const repoRoot = resolveRepoRoot(opts.repoRoot);
  const ledgerPath =
    opts.ledgerPath ?? resolve(repoRoot, ".cliyard/ledger.json");
  const requestedPort = Number(opts.port ?? 3927);

  const server = createServer((req, res) => {
    if (req.method !== "GET" && req.method !== "HEAD") {
      send(res, 405, { "content-type": "text/plain; charset=utf-8", allow: "GET, HEAD" }, "method not allowed");
      return;
    }

    const pathname = requestPath(req.url);
    if (pathname === "/api/ledger") {
      const snap = readLedgerSnapshot(ledgerPath);
      send(
        res,
        200,
        { "content-type": "application/json; charset=utf-8" },
        JSON.stringify(snap),
      );
      return;
    }
    if (pathname === "/" || pathname === "/index.html") {
      send(
        res,
        200,
        { "content-type": "text/html; charset=utf-8" },
        MONITOR_HTML,
      );
      return;
    }
    if (pathname === "/app.js") {
      send(
        res,
        200,
        { "content-type": "text/javascript; charset=utf-8" },
        MONITOR_CLIENT_SCRIPT,
      );
      return;
    }
    if (pathname === "/app.css") {
      send(
        res,
        200,
        { "content-type": "text/css; charset=utf-8" },
        MONITOR_STYLESHEET,
      );
      return;
    }
    send(res, 404, { "content-type": "text/plain; charset=utf-8" }, "not found");
  });

  return new Promise((resolvePromise, rejectPromise) => {
    server.once("error", rejectPromise);
    server.listen(requestedPort, "127.0.0.1", () => {
      server.removeListener("error", rejectPromise);
      const address = server.address();
      const port =
        address && typeof address === "object" ? address.port : requestedPort;
      resolvePromise({
        server,
        port,
        url: `http://127.0.0.1:${port}/`,
        ledgerPath,
        close: () =>
          new Promise((r) => server.close(() => r(undefined))),
      });
    });
  });
}

function requestPath(rawUrl) {
  try {
    return new URL(rawUrl ?? "/", "http://127.0.0.1").pathname;
  } catch {
    return "/";
  }
}

function send(res, status, headers, body) {
  res.writeHead(status, { ...SECURITY_HEADERS, ...headers });
  res.end(body);
}

/** Optional file watch helper for plugin hosts that prefer push over HTTP. */
export function watchLedger(ledgerPath, onChange) {
  if (!existsSync(ledgerPath)) {
    onChange(readLedgerSnapshot(ledgerPath));
  }
  try {
    const w = watch(ledgerPath, () => {
      onChange(readLedgerSnapshot(ledgerPath));
    });
    return () => w.close();
  } catch {
    const t = setInterval(() => onChange(readLedgerSnapshot(ledgerPath)), 1000);
    return () => clearInterval(t);
  }
}

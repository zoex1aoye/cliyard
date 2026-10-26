/**
 * Read-only ledger snapshot for the Master monitor console.
 */
import { readFileSync, existsSync, watch } from "node:fs";
import { createServer } from "node:http";
import { resolve } from "node:path";
import { resolveRepoRoot } from "./paths.js";

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
  const tasks = Object.values(raw.tasks ?? {}).map((t) => ({
    taskId: t.taskId,
    status: t.status,
    repairCount: t.repairCount ?? 0,
    verdict: t.verdict,
    reason: t.reason,
    lastEvent: t.events?.[t.events.length - 1] ?? null,
    eventCount: t.events?.length ?? 0,
  }));
  return {
    path: ledgerPath,
    tasks,
    updatedAt: new Date().toISOString(),
    missing: false,
  };
}

export function startMonitorServer(opts = {}) {
  const repoRoot = resolveRepoRoot(opts.repoRoot);
  const ledgerPath =
    opts.ledgerPath ?? resolve(repoRoot, ".cliyard/ledger.json");
  const port = Number(opts.port ?? 3927);

  const html = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <title>cliyard Master Monitor</title>
  <style>
    :root { font-family: ui-sans-serif, system-ui, sans-serif; color: #1a1a1a; background: #f6f4ef; }
    body { margin: 1.5rem; max-width: 52rem; }
    h1 { font-size: 1.25rem; margin: 0 0 0.25rem; }
    .sub { color: #666; font-size: 0.85rem; margin-bottom: 1rem; }
    table { width: 100%; border-collapse: collapse; background: #fff; }
    th, td { text-align: left; padding: 0.5rem 0.6rem; border-bottom: 1px solid #e8e4dc; font-size: 0.9rem; }
    th { background: #efebe3; }
    .st-accepted { color: #0a7a3e; font-weight: 600; }
    .st-rejected { color: #b00020; font-weight: 600; }
    .st-running, .st-verifying, .st-repairing { color: #8a5a00; font-weight: 600; }
    code { font-size: 0.8rem; }
  </style>
</head>
<body>
  <h1>cliyard Master Monitor</h1>
  <p class="sub">Ledger: <code id="path"></code> · <span id="updated"></span></p>
  <table>
    <thead><tr><th>taskId</th><th>status</th><th>repairs</th><th>verdict</th><th>last event</th></tr></thead>
    <tbody id="rows"><tr><td colspan="5">waiting for ledger…</td></tr></tbody>
  </table>
  <script>
    async function tick() {
      const r = await fetch('/api/ledger');
      const data = await r.json();
      document.getElementById('path').textContent = data.path;
      document.getElementById('updated').textContent = data.updatedAt || (data.missing ? 'missing' : '');
      const tb = document.getElementById('rows');
      if (!data.tasks || !data.tasks.length) {
        tb.innerHTML = '<tr><td colspan="5">' + (data.missing ? 'ledger not created yet' : 'no tasks') + '</td></tr>';
        return;
      }
      tb.innerHTML = data.tasks.map(t => {
        const st = 'st-' + (t.status || '');
        const last = t.lastEvent ? (t.lastEvent.type + (t.lastEvent.detail ? ': ' + t.lastEvent.detail : '')) : '—';
        return '<tr><td>' + t.taskId + '</td><td class="' + st + '">' + t.status + '</td><td>' + t.repairCount + '</td><td>' + (t.verdict || '—') + '</td><td><code>' + last + '</code></td></tr>';
      }).join('');
    }
    tick();
    setInterval(tick, 1000);
  </script>
</body>
</html>`;

  const server = createServer((req, res) => {
    if (req.url === "/api/ledger" || req.url?.startsWith("/api/ledger?")) {
      const snap = readLedgerSnapshot(ledgerPath);
      res.writeHead(200, {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
      });
      res.end(JSON.stringify(snap));
      return;
    }
    if (req.url === "/" || req.url === "/index.html") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(html);
      return;
    }
    res.writeHead(404);
    res.end("not found");
  });

  return new Promise((resolvePromise) => {
    server.listen(port, "127.0.0.1", () => {
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

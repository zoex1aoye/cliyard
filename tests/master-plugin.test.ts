import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { runInNewContext } from "node:vm";
import { dispatchBatch } from "../plugins/dsh-cliyard/lib/dispatch.js";
import {
  MONITOR_CLIENT_SCRIPT,
  MONITOR_HTML,
  readLedgerSnapshot,
  startMonitorServer,
} from "../plugins/dsh-cliyard/lib/monitor.js";
import {
  apply,
  normalizeExecutionProfiles,
  resolveDefaultExecutionProfileId,
  resolveExecutionProfile,
} from "../plugins/dsh-cliyard/index.js";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

type ToolDefinition = {
  name?: string;
  description?: string;
  parameters?: {
    additionalProperties?: boolean;
    properties?: Record<string, { enum?: string[]; type?: string }>;
    required?: string[];
  };
  execute?: (args: Record<string, unknown>) => Promise<string>;
};

function capturePlanTool(config: Record<string, unknown> = {}): ToolDefinition {
  let registered: ToolDefinition | undefined;
  const fakeCtx = {
    tools: {
      register(definition: ToolDefinition) {
        registered = definition;
        return () => undefined;
      },
    },
    effect(install: () => unknown) {
      install();
    },
  };

  apply(fakeCtx, { repoRoot, monitorPort: 0, ...config });
  assert.ok(registered, "cliyard_plan_dispatch should be registered");
  return registered!;
}

function writeLedger(dir: string, value: unknown): string {
  mkdirSync(join(dir, ".cliyard"), { recursive: true });
  const ledgerPath = join(dir, ".cliyard", "ledger.json");
  writeFileSync(ledgerPath, JSON.stringify(value), "utf8");
  return ledgerPath;
}

class FakeElement {
  tagName = "";
  children: FakeElement[] = [];
  textContent = "";
  className = "";
  colSpan = 0;
  static innerHTMLWrites: string[] = [];

  set innerHTML(value: string) {
    FakeElement.innerHTMLWrites.push(value);
  }

  appendChild(child: FakeElement) {
    this.children.push(child);
    return child;
  }

  replaceChildren(...children: FakeElement[]) {
    this.children = children;
  }
}

function fakeDocument() {
  const elements = new Map<string, FakeElement>();
  for (const id of ["path", "updated", "rows"]) {
    elements.set(id, new FakeElement());
  }
  const document = {
    createElement(tagName: string) {
      const element = new FakeElement();
      element.tagName = tagName.toUpperCase();
      return element;
    },
    getElementById(id: string) {
      return elements.get(id) ?? null;
    },
  };
  return { document, elements };
}

async function flushAsync() {
  for (let i = 0; i < 4; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

test("dsh-cliyard apply exports dispatch API without Cordis host", () => {
  const api = apply(null, { repoRoot, monitorPort: 0 });
  assert.equal(api.name, "cliyard");
  assert.equal(typeof api.dispatch, "function");
  assert.equal(typeof api.snapshot, "function");
});

test("master dispatch mock parallel + monitor snapshot", async () => {
  const contracts = join(repoRoot, "examples/mock-batch.parallel.json");
  const ledgerPath = join(repoRoot, ".cliyard", "ledger-master-test.json");
  const result = await dispatchBatch({
    repoRoot,
    contracts,
    worker: "mock",
    ledgerPath,
  });
  assert.equal(result.ok, true, result.stderr || result.stdout);

  const snap = readLedgerSnapshot(ledgerPath);
  assert.equal(snap.missing, false);
  const ids = snap.tasks.map((t) => t.taskId).sort();
  assert.deepEqual(ids, ["module-a", "module-b"]);
  assert.ok(snap.tasks.every((t) => t.status === "accepted"));

  const mon = await startMonitorServer({
    repoRoot,
    ledgerPath,
    port: 0,
  });
  try {
    const res = await fetch(new URL("/api/ledger", mon.url));
    assert.equal(res.status, 200);
    const body = (await res.json()) as { tasks: unknown[] };
    assert.equal(body.tasks.length, 2);
  } finally {
    await mon.close();
  }
});

test("master dispatch treats repoRoot as the target, not the cliyard checkout", async () => {
  const targetRepo = mkdtempSync(join(tmpdir(), "cliyard-target-"));
  const ledgerPath = join(targetRepo, ".cliyard", "ledger.json");
  try {
    const contracts = join(repoRoot, "examples/mock-batch.parallel.json");
    const result = await dispatchBatch({
      repoRoot: targetRepo,
      contracts,
      worker: "mock",
      ledgerPath,
    });
    assert.equal(result.ok, true, result.stderr || result.stdout);
    assert.equal(result.targetRepo, targetRepo);
    const ledger = JSON.parse(readFileSync(ledgerPath, "utf8")) as {
      tasks: Record<string, { status: string }>;
    };
    assert.equal(ledger.tasks["module-a"]?.status, "accepted");
    assert.equal(ledger.tasks["module-b"]?.status, "accepted");
  } finally {
    rmSync(targetRepo, { recursive: true, force: true });
  }
});

test("dsh plugin registers a chat-callable Plan bridge tool", () => {
  const tool = capturePlanTool();
  assert.equal(tool.name, "cliyard_plan_dispatch");
  assert.ok(tool.parameters);
  assert.deepEqual(
    tool.parameters?.properties?.executionProfileId?.enum,
    ["default"],
  );
  assert.equal(tool.parameters?.properties?.worker, undefined);
  assert.equal(tool.parameters?.properties?.model, undefined);
  assert.equal(tool.parameters?.additionalProperties, false);
});

test("dsh Plan tool exposes only configured execution-profile aliases", () => {
  const tool = capturePlanTool({
    executionProfiles: {
      "claude-deepseek-flash": { worker: "claude", model: "deepseek-flash" },
      "mock-safe": { worker: "mock" },
    },
    defaultExecutionProfileId: "mock-safe",
  });
  const properties = tool.parameters?.properties ?? {};

  assert.deepEqual(properties.executionProfileId?.enum, [
    "claude-deepseek-flash",
    "mock-safe",
  ]);
  assert.equal(properties.worker, undefined);
  assert.equal(properties.model, undefined);
  assert.equal(properties.permission, undefined);
  assert.equal(properties.permissionMode, undefined);
  assert.equal(tool.parameters?.additionalProperties, false);
});

test("execution profiles map aliases to worker and model server-side", () => {
  const profiles = normalizeExecutionProfiles({
    executionProfiles: {
      "claude-deepseek-flash": { worker: "claude", model: "deepseek-flash" },
      "mock-safe": { worker: "mock" },
    },
  });

  assert.deepEqual(resolveExecutionProfile(profiles, "claude-deepseek-flash"), {
    executionProfileId: "claude-deepseek-flash",
    worker: "claude",
    model: "deepseek-flash",
  });
  assert.deepEqual(resolveExecutionProfile(profiles, "mock-safe"), {
    executionProfileId: "mock-safe",
    worker: "mock",
    model: undefined,
  });
  assert.equal(
    resolveDefaultExecutionProfileId(profiles),
    "claude-deepseek-flash",
  );
  assert.equal(
    resolveDefaultExecutionProfileId(profiles, "mock-safe"),
    "mock-safe",
  );

  const legacyDefaults = normalizeExecutionProfiles({
    defaultWorker: "mock",
    model: "deepseek-flash",
  });
  assert.deepEqual(resolveExecutionProfile(legacyDefaults, undefined), {
    executionProfileId: "default",
    worker: "mock",
    model: "deepseek-flash",
  });
});

test("execution-profile config rejects injected fields and unknown defaults", () => {
  assert.throws(
    () =>
      normalizeExecutionProfiles({
        executionProfiles: {
          unsafe: { worker: "claude", permission: "allow-all" },
        },
      }),
    /does not accept "permission"/,
  );
  assert.throws(
    () =>
      normalizeExecutionProfiles({
        executionProfiles: { unsafe: { worker: "bash" } },
      }),
    /must be one of/,
  );
  assert.throws(
    () =>
      normalizeExecutionProfiles({
        executionProfiles: { unsafe: { worker: "claude", model: "bad model" } },
      }),
    /must be a bounded model id/,
  );

  const profiles = normalizeExecutionProfiles({
    executionProfiles: { "mock-safe": { worker: "mock" } },
  });
  assert.throws(
    () => resolveDefaultExecutionProfileId(profiles, "missing"),
    /is not a configured execution profile/,
  );
});

test("dsh Plan tool rejects unknown profiles and worker/model/permission injection", async () => {
  const tool = capturePlanTool({
    executionProfiles: { "mock-safe": { worker: "mock" } },
  });
  const execute = tool.execute!;

  await assert.rejects(
    () => execute({ plan: {}, executionProfileId: "missing" }),
    /Unknown execution profile "missing"/,
  );
  await assert.rejects(
    () => execute({ plan: {}, worker: "claude" }),
    /does not accept "worker"/,
  );
  await assert.rejects(
    () => execute({ plan: {}, model: "deepseek-flash" }),
    /does not accept "model"/,
  );
  await assert.rejects(
    () => execute({ plan: {}, permission: "allow-all" }),
    /does not accept "permission"/,
  );
  await assert.rejects(
    () => execute({ plan: {}, permissionMode: "bypassPermissions" }),
    /does not accept "permissionMode"/,
  );
});

test("standalone API keeps dispatch defaults and rejects unknown profile overrides", async () => {
  const api = apply(null, {
    repoRoot,
    monitorPort: 0,
    defaultWorker: "mock",
  });

  await assert.rejects(
    () => api.dispatch({ executionProfileId: "missing" }),
    /Unknown execution profile "missing"/,
  );
  await assert.rejects(
    () => api.dispatchPlan({ plan: {}, executionProfileId: "missing" }),
    /Unknown execution profile "missing"/,
  );
  await assert.rejects(
    () => api.dispatchPlan({ plan: {}, executionProfileId: "default", model: "x" }),
    /cannot be combined/,
  );
});

test("monitor serves a strict CSP and security headers", async () => {
  const targetRepo = mkdtempSync(join(tmpdir(), "cliyard-monitor-"));
  const payload = '<img src=x onerror="globalThis.__cliyardPwned=true">';
  try {
    const ledgerPath = writeLedger(targetRepo, {
      tasks: {
        "module-a": {
          taskId: payload,
          status: "accepted",
          repairCount: 1,
          verdict: "ok",
          events: [{ type: "done", detail: payload }],
        },
      },
    });
    const mon = await startMonitorServer({
      repoRoot: targetRepo,
      ledgerPath,
      port: 0,
    });
    try {
      for (const pathname of ["/", "/app.js", "/app.css", "/api/ledger"]) {
        const res = await fetch(new URL(pathname, mon.url));
        assert.equal(res.status, 200, pathname);
        const csp = res.headers.get("content-security-policy") ?? "";
        assert.match(csp, /default-src 'none'/, pathname);
        assert.match(csp, /script-src 'self'/, pathname);
        assert.match(csp, /style-src 'self'/, pathname);
        assert.match(csp, /frame-ancestors 'none'/, pathname);
        assert.doesNotMatch(csp, /unsafe-inline|unsafe-eval/, pathname);
        assert.equal(
          res.headers.get("x-content-type-options"),
          "nosniff",
          pathname,
        );
        assert.equal(
          res.headers.get("referrer-policy"),
          "no-referrer",
          pathname,
        );
        assert.equal(res.headers.get("x-frame-options"), "DENY", pathname);
        assert.equal(res.headers.get("cache-control"), "no-store", pathname);
      }

      assert.doesNotMatch(MONITOR_HTML, /<style[\s>]/i);
      assert.doesNotMatch(MONITOR_HTML, /<script(?![^>]*\bsrc=)[^>]*>/i);
      assert.match(MONITOR_HTML, /<script src="\/app\.js" defer><\/script>/);
      assert.match(MONITOR_HTML, /<link rel="stylesheet" href="\/app\.css"/);
      assert.equal(MONITOR_HTML.includes(payload), false);

      const apiBody = (await (
        await fetch(new URL("/api/ledger", mon.url))
      ).json()) as {
        tasks: { taskId: string; lastEvent: { detail: string } }[];
      };
      assert.equal(apiBody.tasks[0]?.taskId, payload);
      assert.equal(apiBody.tasks[0]?.lastEvent?.detail, payload);

      const servedScript = await (
        await fetch(new URL("/app.js", mon.url))
      ).text();
      assert.equal(servedScript, MONITOR_CLIENT_SCRIPT);
      assert.doesNotMatch(
        servedScript,
        /innerHTML|outerHTML|insertAdjacentHTML|document\.write/,
      );
    } finally {
      await mon.close();
    }
  } finally {
    rmSync(targetRepo, { recursive: true, force: true });
  }
});

test("monitor client renders malicious ledger text as data, never markup", async () => {
  const payload = '<img src=x onerror="globalThis.__cliyardPwned=true">';
  const status = '"><script>alert(1)</script>';
  const detail = '</td><td onmouseover="alert(2)">';
  const snapshot = {
    path: payload,
    tasks: [
      {
        taskId: payload,
        status,
        repairCount: 3,
        verdict: payload,
        lastEvent: { type: payload, detail },
        eventCount: 1,
      },
    ],
    updatedAt: "2026-10-29T00:00:00.000Z",
    missing: false,
  };

  FakeElement.innerHTMLWrites = [];
  const { document, elements } = fakeDocument();
  runInNewContext(MONITOR_CLIENT_SCRIPT, {
    document,
    fetch: async () => ({ ok: true, json: async () => snapshot }),
    setInterval: () => 0,
    console,
  });
  await flushAsync();

  const rows = elements.get("rows")!;
  assert.equal(rows.children.length, 1);
  const cells = rows.children[0]!.children;
  assert.equal(cells.length, 5);
  assert.equal(cells[0]!.textContent, payload);
  assert.equal(cells[1]!.textContent, status);
  assert.equal(cells[2]!.textContent, "3");
  assert.equal(cells[3]!.textContent, payload);
  assert.equal(cells[4]!.children[0]!.tagName, "CODE");
  assert.equal(cells[4]!.children[0]!.textContent, `${payload}: ${detail}`);
  assert.equal(elements.get("path")!.textContent, payload);

  assert.match(cells[1]!.className, /^st-[a-z0-9_-]+$/);
  assert.doesNotMatch(cells[1]!.className, /["<>]/);
  assert.deepEqual(FakeElement.innerHTMLWrites, []);
});

test("plugin and core declare conservative compatibility metadata", () => {
  const pluginPkg = JSON.parse(
    readFileSync(join(repoRoot, "plugins/dsh-cliyard/package.json"), "utf8"),
  ) as { engines?: { node?: string; dsh?: string } };
  const corePkg = JSON.parse(
    readFileSync(join(repoRoot, "package.json"), "utf8"),
  ) as { engines?: { node?: string } };

  assert.equal(corePkg.engines?.node, ">=20");
  assert.equal(pluginPkg.engines?.node, ">=20");
  assert.equal(pluginPkg.engines?.dsh, "0.2.1-rc.3");
  assert.doesNotMatch(pluginPkg.engines?.dsh ?? "", /alpha/i);
  assert.equal((pluginPkg.engines?.dsh ?? "").includes("0.2.2"), false);
});

test("dsh Plan tool compiles a contract inside a sibling target repo", async () => {
  const targetRepo = mkdtempSync(join(tmpdir(), "cliyard-dsh-plan-"));
  try {
    spawnSync("git", ["init"], { cwd: targetRepo, stdio: "ignore" });
    spawnSync("git", ["config", "user.email", "t@t.com"], {
      cwd: targetRepo,
      stdio: "ignore",
    });
    spawnSync("git", ["config", "user.name", "t"], {
      cwd: targetRepo,
      stdio: "ignore",
    });
    writeFileSync(join(targetRepo, "README.md"), "# target\n");
    spawnSync("git", ["add", "."], { cwd: targetRepo, stdio: "ignore" });
    spawnSync("git", ["commit", "-m", "init"], {
      cwd: targetRepo,
      stdio: "ignore",
    });

    let execute:
      | ((args: {
          plan: unknown;
          dispatch?: boolean;
          executionProfileId?: string;
        }) => Promise<string>)
      | undefined;
    const fakeCtx = {
      tools: {
        register(definition: {
          execute?: (args: {
            plan: unknown;
            dispatch?: boolean;
            executionProfileId?: string;
          }) => Promise<string>;
        }) {
          execute = definition.execute;
          return () => undefined;
        },
      },
      effect(install: () => unknown) {
        install();
      },
    };

    apply(fakeCtx, {
      repoRoot: targetRepo,
      monitorPort: 0,
      defaultWorker: "mock",
    });
    assert.ok(execute);
    const stdout = await execute!({
      plan: {
        planId: "dsh-chat-plan",
        tasks: [
          {
            taskId: "readme-check",
            goal: "Keep the target README",
            writePaths: ["README.md"],
            verifyCommands: ["test -f README.md"],
          },
        ],
      },
      dispatch: false,
    });
    const result = JSON.parse(stdout) as {
      planId: string;
      dispatched: boolean;
      contractsPath: string;
    };
    assert.equal(result.planId, "dsh-chat-plan");
    assert.equal(result.dispatched, false);
    assert.ok(result.contractsPath.startsWith(targetRepo));
    assert.ok(result.contractsPath.endsWith(".contracts.json"));

    const written = JSON.parse(
      readFileSync(result.contractsPath, "utf8"),
    ) as { contracts: { frozen: boolean; baseCommit: string }[] };
    assert.equal(written.contracts[0]?.frozen, true);
    assert.match(written.contracts[0]?.baseCommit ?? "", /^[0-9a-f]{40}$/);
  } finally {
    rmSync(targetRepo, { recursive: true, force: true });
  }
});

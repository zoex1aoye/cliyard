import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { dispatchBatch } from "../plugins/dsh-cliyard/lib/dispatch.js";
import {
  readLedgerSnapshot,
  startMonitorServer,
} from "../plugins/dsh-cliyard/lib/monitor.js";
import { apply } from "../plugins/dsh-cliyard/index.js";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

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
    port: 3928,
  });
  try {
    const res = await fetch(`${mon.url}api/ledger`);
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
  let registered: { name?: string; parameters?: unknown } | undefined;
  const fakeCtx = {
    tools: {
      register(definition: { name?: string; parameters?: unknown }) {
        registered = definition;
        return () => undefined;
      },
    },
    effect(install: () => unknown) {
      install();
    },
  };

  apply(fakeCtx, { repoRoot, monitorPort: 0 });
  assert.equal(registered?.name, "cliyard_plan_dispatch");
  assert.ok(registered?.parameters);
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
      | ((args: { plan: unknown; dispatch?: boolean }) => Promise<string>)
      | undefined;
    const fakeCtx = {
      tools: {
        register(definition: {
          execute?: (args: {
            plan: unknown;
            dispatch?: boolean;
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

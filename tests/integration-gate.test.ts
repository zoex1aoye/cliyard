import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  AgentAdapter,
  AgentResult,
  AgentStartInput,
} from "../src/agents/types.js";
import type { TaskContract } from "../src/contracts/schema.js";
import {
  runCodexBatch,
  type IntegrationGateResult,
} from "../src/scheduler/codex-batch.js";
import {
  createRunManifest,
  loadRunManifest,
} from "../src/supervisor/store.js";

function runGit(repo: string, args: string[]): string {
  const result = spawnSync("git", args, { cwd: repo, encoding: "utf8" });
  assert.equal(
    result.status,
    0,
    `git ${args.join(" ")} failed: ${result.stderr}`,
  );
  return result.stdout.trim();
}

function initRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), "cliyard-integration-gate-"));
  runGit(repo, ["init"]);
  runGit(repo, ["config", "user.email", "t@t.com"]);
  runGit(repo, ["config", "user.name", "t"]);
  writeFileSync(join(repo, "README.md"), "# fixture\n");
  runGit(repo, ["add", "."]);
  runGit(repo, ["commit", "-m", "init"]);
  return repo;
}

function contract(
  taskId: string,
  writePath: string,
  baseCommit: string,
  verifyCommands: string[],
  dependsOn: string[] = [],
): TaskContract {
  return {
    taskId,
    version: 1,
    frozen: true,
    goals: [`Create ${writePath}`],
    dependsOn,
    readPaths: ["."],
    writePaths: [writePath],
    sharedResources: [],
    baseCommit,
    verifyCommands,
    maxRepairs: 0,
  };
}

function writeContracts(repo: string, contracts: TaskContract[]): string {
  const path = join(repo, "contracts.json");
  writeFileSync(path, JSON.stringify({ contracts }, null, 2) + "\n", "utf8");
  return path;
}

function fixtureAdapter(
  cwd: string,
  build: (input: AgentStartInput, sessionId: string) => AgentResult,
): AgentAdapter {
  let current: AgentStartInput | undefined;
  return {
    id: "claude",
    async discover() {
      return {
        id: "claude",
        ok: true,
        supportsModelFlag: true,
        notes: ["integration-gate fixture"],
      };
    },
    async start(input) {
      current = input;
      return { sessionId: `fixture-${input.contract.taskId}` };
    },
    async collect(sessionId) {
      if (!current) throw new Error("worker did not start");
      return build(current, sessionId);
    },
    async cancel() {},
  };
}

function acceptingWorker(cwd: string): AgentAdapter {
  return fixtureAdapter(cwd, (input, sessionId) => {
    const writePath = input.contract.writePaths[0]!;
    writeFileSync(join(cwd, writePath), "done\n");
    return {
      sessionId,
      exitCode: 0,
      touchedPaths: [writePath],
      logTail: `wrote ${writePath}`,
    };
  });
}

test("accepted tasks plus a green integration gate yield completed", async () => {
  const repo = initRepo();
  let gateCalls = 0;
  try {
    const base = runGit(repo, ["rev-parse", "HEAD"]);
    const contractsPath = writeContracts(repo, [
      contract("task", "task.txt", base, ["test -f task.txt"]),
    ]);
    const manifest = createRunManifest(repo, {
      planId: "gate-green",
      contractsPath,
      baseCommit: base,
      integrationBranch: "cliyard/integration/gate-green",
      tasks: ["task"],
    });

    const result = await runCodexBatch({
      contractsPath,
      repoRoot: repo,
      ledgerPath: join(repo, ".cliyard", "ledger.json"),
      worker: "claude",
      keepWorktrees: false,
      runManifest: manifest,
      enableIntegrationGate: true,
      integrationGateCommands: ["true"],
      integrationGateRunner: async ({ cwd, commands }) => {
        gateCalls += 1;
        return {
          ok: true,
          cwd,
          commands: commands.map((command) => ({
            command,
            exitCode: 0,
            logTail: `[integration-gate] exit=0: ${command}`,
          })),
        } satisfies IntegrationGateResult;
      },
      workerFactory: (_worker, cwd) => acceptingWorker(cwd),
    });

    assert.equal(gateCalls, 1);
    assert.equal(result.allAccepted, true);
    assert.equal(result.results[0]?.verdict, "accepted");
    assert.equal(result.integrationGate?.ok, true);
    assert.equal(result.integrationGate?.skipped, undefined);

    const saved = loadRunManifest(repo, manifest.runId);
    assert.equal(saved.status, "completed");
    assert.equal(saved.tasks["task"]?.accepted, true);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("accepted tasks plus a red integration gate block without rewriting verdicts", async () => {
  const repo = initRepo();
  let gateCalls = 0;
  try {
    const base = runGit(repo, ["rev-parse", "HEAD"]);
    const contractsPath = writeContracts(repo, [
      contract("task", "task.txt", base, ["test -f task.txt"]),
    ]);
    const manifest = createRunManifest(repo, {
      planId: "gate-red",
      contractsPath,
      baseCommit: base,
      integrationBranch: "cliyard/integration/gate-red",
      tasks: ["task"],
    });

    const result = await runCodexBatch({
      contractsPath,
      repoRoot: repo,
      ledgerPath: join(repo, ".cliyard", "ledger.json"),
      worker: "claude",
      keepWorktrees: false,
      runManifest: manifest,
      enableIntegrationGate: true,
      integrationGateCommands: ["npm test", "npm run build"],
      integrationGateRunner: async ({ cwd, commands }) => {
        gateCalls += 1;
        return {
          ok: false,
          cwd,
          commands: [
            {
              command: commands[0]!,
              exitCode: 1,
              logTail: "[integration-gate] exit=1: npm test\n4 failing",
            },
          ],
        } satisfies IntegrationGateResult;
      },
      workerFactory: (_worker, cwd) => acceptingWorker(cwd),
    });

    assert.equal(gateCalls, 1);
    assert.equal(result.allAccepted, false);
    assert.equal(result.results[0]?.verdict, "accepted");
    assert.equal(result.integrationGate?.ok, false);
    assert.equal(result.integrationGate?.commands[0]?.exitCode, 1);
    assert.match(
      result.integrationGate?.commands[0]?.logTail ?? "",
      /4 failing/,
    );

    const saved = loadRunManifest(repo, manifest.runId);
    assert.equal(saved.status, "blocked");
    assert.equal(saved.tasks["task"]?.accepted, true);
    assert.equal(saved.tasks["task"]?.status, "accepted");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("dependency skip yields allAccepted false without invoking the gate", async () => {
  const repo = initRepo();
  let gateCalls = 0;
  try {
    const base = runGit(repo, ["rev-parse", "HEAD"]);
    const contractsPath = writeContracts(repo, [
      contract("upstream", "upstream.txt", base, ["test -f missing.txt"]),
      contract(
        "downstream",
        "downstream.txt",
        base,
        ["test -f downstream.txt"],
        ["upstream"],
      ),
    ]);
    const manifest = createRunManifest(repo, {
      planId: "gate-skip",
      contractsPath,
      baseCommit: base,
      integrationBranch: "cliyard/integration/gate-skip",
      tasks: ["upstream", "downstream"],
    });

    const result = await runCodexBatch({
      contractsPath,
      repoRoot: repo,
      ledgerPath: join(repo, ".cliyard", "ledger.json"),
      worker: "claude",
      keepWorktrees: false,
      runManifest: manifest,
      enableIntegrationGate: true,
      integrationGateRunner: async ({ cwd, commands }) => {
        gateCalls += 1;
        return {
          ok: true,
          cwd,
          commands: commands.map((command) => ({
            command,
            exitCode: 0,
            logTail: command,
          })),
        };
      },
      workerFactory: (_worker, cwd) =>
        fixtureAdapter(cwd, (input, sessionId) => {
          // Succeed the worker without creating the verified file so the
          // verifier rejects upstream and downstream is dependency-skipped.
          return {
            sessionId,
            exitCode: 0,
            touchedPaths: [],
            logTail: `noop ${input.contract.taskId}`,
          };
        }),
    });

    assert.equal(gateCalls, 0);
    assert.equal(result.allAccepted, false);
    assert.equal(result.integrationGate, undefined);
    assert.ok(result.skipped.some((item) => item.taskId === "downstream"));

    const saved = loadRunManifest(repo, manifest.runId);
    assert.equal(saved.status, "blocked");
    assert.equal(saved.tasks["downstream"]?.accepted, false);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

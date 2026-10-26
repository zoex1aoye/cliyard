import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import type {
  AgentAdapter,
  AgentResult,
  AgentStartInput,
} from "../src/agents/types.js";
import type { TaskContract } from "../src/contracts/schema.js";
import { runCodexBatch } from "../src/scheduler/codex-batch.js";

const filesByTask: Record<string, string> = {
  foundation: "foundation.ts",
  left: "left.ts",
  right: "right.ts",
  upper: "upper.ts",
};

function createSnapshotWorker(
  cwd: string,
  failTask?: string,
): AgentAdapter {
  let contract: TaskContract | undefined;
  return {
    id: "claude",
    async discover() {
      return {
        id: "claude",
        ok: true,
        supportsModelFlag: true,
        notes: ["continuous integration fixture"],
      };
    },
    async start(input: AgentStartInput) {
      contract = input.contract;
      return { sessionId: `fixture-${input.contract.taskId}` };
    },
    async collect(sessionId: string): Promise<AgentResult> {
      if (!contract) throw new Error("worker did not start");
      if (contract.taskId === failTask) {
        return {
          sessionId,
          exitCode: 1,
          touchedPaths: [],
          logTail: `[fixture] forced failure for ${contract.taskId}`,
        };
      }
      const file = filesByTask[contract.taskId];
      if (!file) throw new Error(`unknown fixture task ${contract.taskId}`);
      writeFileSync(join(cwd, file), `export const name = '${contract.taskId}';\n`);
      return {
        sessionId,
        exitCode: 0,
        touchedPaths: [file],
        logTail: `[fixture] wrote ${file}`,
      };
    },
    async cancel() {},
  };
}

test("continuous worker waves see accepted upstream artifacts", async () => {
  const repo = mkdtempSync(join(tmpdir(), "cliyard-continuous-"));
  try {
    spawnSync("git", ["init"], { cwd: repo, stdio: "ignore" });
    spawnSync("git", ["config", "user.email", "t@t.com"], {
      cwd: repo,
      stdio: "ignore",
    });
    spawnSync("git", ["config", "user.name", "t"], {
      cwd: repo,
      stdio: "ignore",
    });
    writeFileSync(join(repo, "README.md"), "# fixture\n");
    spawnSync("git", ["add", "."], { cwd: repo, stdio: "ignore" });
    spawnSync("git", ["commit", "-m", "init"], {
      cwd: repo,
      stdio: "ignore",
    });
    mkdirSync(join(repo, "contracts"));
    const contractsPath = join(repo, "contracts", "continuous.json");
    writeFileSync(
      contractsPath,
      JSON.stringify({
        contracts: [
          contract("foundation", [], "foundation.ts", [
            "test -f foundation.ts",
          ]),
          contract("left", ["foundation"], "left.ts", [
            "test -f foundation.ts",
            "test -f left.ts",
          ]),
          contract("right", ["foundation"], "right.ts", [
            "test -f foundation.ts",
            "test -f right.ts",
          ]),
          contract("upper", ["left", "right"], "upper.ts", [
            "test -f foundation.ts",
            "test -f left.ts",
            "test -f right.ts",
            "test -f upper.ts",
          ]),
        ],
      }),
    );

    const result = await runCodexBatch({
      contractsPath,
      repoRoot: repo,
      ledgerPath: join(repo, ".cliyard", "ledger.json"),
      worker: "claude",
      dryRun: false,
      keepWorktrees: true,
      workerFactory: (_worker, cwd) => createSnapshotWorker(cwd),
    });

    assert.equal(result.allAccepted, true);
    assert.deepEqual(result.startOrder, [
      "foundation",
      "left",
      "right",
      "upper",
    ]);
    assert.deepEqual(result.waves, [
      ["foundation"],
      ["left", "right"],
      ["upper"],
    ]);
    for (const file of Object.values(filesByTask)) {
      assert.match(
        readFileSync(join(result.integration.path, file), "utf8"),
        /export const name/,
      );
    }
    assert.equal(result.results.length, 4);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("rejected foundation blocks every dependent wave", async () => {
  const repo = mkdtempSync(join(tmpdir(), "cliyard-continuous-fail-"));
  try {
    spawnSync("git", ["init"], { cwd: repo, stdio: "ignore" });
    spawnSync("git", ["config", "user.email", "t@t.com"], {
      cwd: repo,
      stdio: "ignore",
    });
    spawnSync("git", ["config", "user.name", "t"], {
      cwd: repo,
      stdio: "ignore",
    });
    writeFileSync(join(repo, "README.md"), "# fixture\n");
    spawnSync("git", ["add", "."], { cwd: repo, stdio: "ignore" });
    spawnSync("git", ["commit", "-m", "init"], {
      cwd: repo,
      stdio: "ignore",
    });
    const contractsPath = join(repo, "contracts.json");
    writeFileSync(
      contractsPath,
      JSON.stringify({
        contracts: [
          contract("foundation", [], "foundation.ts", [
            "test -f foundation.ts",
          ]),
          contract("left", ["foundation"], "left.ts", [
            "test -f foundation.ts",
            "test -f left.ts",
          ]),
          contract("right", ["foundation"], "right.ts", [
            "test -f foundation.ts",
            "test -f right.ts",
          ]),
          contract("upper", ["left", "right"], "upper.ts", [
            "test -f upper.ts",
          ]),
        ],
      }),
    );

    const result = await runCodexBatch({
      contractsPath,
      repoRoot: repo,
      ledgerPath: join(repo, ".cliyard", "ledger.json"),
      worker: "claude",
      dryRun: false,
      keepWorktrees: true,
      workerFactory: (_worker, cwd) =>
        createSnapshotWorker(cwd, "foundation"),
    });

    assert.equal(result.allAccepted, false);
    assert.deepEqual(result.waves, [["foundation"]]);
    assert.deepEqual(
      result.skipped.map((task) => task.taskId).sort(),
      ["left", "right", "upper"],
    );
    assert.ok(
      result.results.some(
        (task) => task.taskId === "foundation" && task.verdict === "rejected",
      ),
    );
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

function contract(
  taskId: string,
  dependsOn: string[],
  writePath: string,
  verifyCommands: string[],
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
    baseCommit: "HEAD",
    verifyCommands,
    maxRepairs: 0,
  };
}

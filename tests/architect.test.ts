import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentAdapter, AgentStartInput } from "../src/agents/types.js";
import {
  ARCHITECT_ALLOWED_TOOLS,
  ARCHITECT_PERMISSION_MODE,
  runArchitect,
  type ArchitectWorkerConfig,
} from "../src/architect/runner.js";

const cliyardRoot = fileURLToPath(new URL("..", import.meta.url));
const cliPath = join(cliyardRoot, "src", "cli.ts");
const PLAN_ID = "architect-smoke";
const DESIGN_PATH = "design/architect.md";
const DESIGN_TEXT =
  "# Health endpoint design\n\nAdd a health endpoint in src/health.ts.\n";

function runGit(repo: string, args: string[]): string {
  const result = spawnSync("git", args, { cwd: repo, encoding: "utf8" });
  assert.equal(
    result.status,
    0,
    `git ${args.join(" ")} failed: ${result.stderr}`,
  );
  return result.stdout.trim();
}

function initRepo(): { repo: string; baseCommit: string } {
  const repo = mkdtempSync(join(tmpdir(), "cliyard-architect-"));
  runGit(repo, ["init"]);
  runGit(repo, ["config", "user.email", "t@t.com"]);
  runGit(repo, ["config", "user.name", "t"]);
  mkdirSync(join(repo, "design"), { recursive: true });
  mkdirSync(join(repo, "src"), { recursive: true });
  writeFileSync(join(repo, DESIGN_PATH), DESIGN_TEXT);
  writeFileSync(join(repo, "src", "app.ts"), "export const app = 1;\n");
  runGit(repo, ["add", "."]);
  runGit(repo, ["commit", "-m", "init"]);
  return { repo, baseCommit: runGit(repo, ["rev-parse", "HEAD"]) };
}

function samplePlan(): {
  planId: string;
  tasks: Record<string, unknown>[];
} {
  return {
    planId: PLAN_ID,
    tasks: [
      {
        taskId: "health-endpoint",
        goal: "Add a health endpoint",
        nonGoals: ["Do not change deployment"],
        dependsOn: [],
        readPaths: ["src/app.ts"],
        writePaths: ["src/health.ts"],
        verifyCommands: ["node --version"],
        maxRepairs: 1,
      },
    ],
  };
}

function writeFakeClaude(dir: string, plan: unknown): string {
  const binary = join(dir, "fake-claude");
  const resultLine = JSON.stringify({
    type: "result",
    is_error: false,
    result: JSON.stringify(plan),
  });
  writeFileSync(
    binary,
    `#!/usr/bin/env node\nprocess.stdout.write(${JSON.stringify(
      `${resultLine}\n`,
    )});\n`,
    { mode: 0o755 },
  );
  chmodSync(binary, 0o755);
  return binary;
}

function createFakeWorker(
  options: {
    finalText?: string;
    touchedPaths?: string[];
    exitCode?: number;
    onStart?: (input: AgentStartInput) => void;
  } = {},
): AgentAdapter {
  return {
    id: "claude",
    async discover() {
      return { id: "claude", ok: true, notes: ["fake"] };
    },
    async start(input) {
      options.onStart?.(input);
      return { sessionId: "fake-session" };
    },
    async collect(sessionId) {
      return {
        sessionId,
        exitCode: options.exitCode ?? 0,
        touchedPaths: options.touchedPaths ?? [],
        logTail: "[fake] architect worker",
        ...(options.finalText === undefined
          ? {}
          : { finalText: options.finalText }),
      };
    },
    async cancel() {},
  };
}

test("architect: a valid Plan becomes the only artifact", async () => {
  const { repo, baseCommit } = initRepo();
  try {
    let config: ArchitectWorkerConfig | undefined;
    let startInput: AgentStartInput | undefined;
    const plan = samplePlan();

    const result = await runArchitect({
      repoRoot: repo,
      designPath: DESIGN_PATH,
      planId: PLAN_ID,
      model: "fake-model",
      createWorker: (workerConfig) => {
        config = workerConfig;
        return createFakeWorker({
          finalText: JSON.stringify(plan),
          onStart: (input) => {
            startInput = input;
          },
        });
      },
    });

    assert.equal(result.ok, true);
    assert.equal(result.planId, PLAN_ID);
    assert.equal(result.baseCommit, baseCommit);
    assert.deepEqual(result.taskIds, ["health-endpoint"]);
    assert.equal(result.worker, "claude");
    assert.equal(result.sessionId, "fake-session");
    assert.deepEqual(result.touchedPaths, []);
    assert.ok(
      result.planPath.endsWith(
        join(".cliyard", "plans", `${PLAN_ID}.json`),
      ),
    );
    assert.deepEqual(JSON.parse(readFileSync(result.planPath, "utf8")), plan);
    assert.equal(existsSync(join(repo, ".cliyard", "contracts")), false);
    assert.equal(existsSync(join(repo, ".cliyard", "worktrees")), false);

    assert.ok(config);
    assert.equal(config.cwd, result.repoRoot);
    assert.equal(config.model, "fake-model");
    assert.equal(config.permissionMode, ARCHITECT_PERMISSION_MODE);
    assert.deepEqual([...config.allowedTools], [...ARCHITECT_ALLOWED_TOOLS]);

    assert.ok(startInput);
    assert.equal(startInput.attempt, 0);
    assert.equal(startInput.contract.baseCommit, baseCommit);
    assert.deepEqual(startInput.contract.readPaths, [DESIGN_PATH]);
    assert.deepEqual(startInput.contract.writePaths, []);
    const briefing = startInput.briefing ?? "";
    assert.ok(briefing.includes(PLAN_ID));
    assert.ok(briefing.includes(DESIGN_TEXT.trim()));
    assert.ok(briefing.includes(`Base commit: ${baseCommit}`));
    assert.ok(briefing.includes("only with the Read, Grep and Glob tools"));
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("architect: fenced Plan JSON with surrounding prose is accepted", async () => {
  const { repo } = initRepo();
  try {
    const finalText =
      "Here is the Plan:\n\n```json\n" +
      `${JSON.stringify(samplePlan(), null, 2)}\n` +
      "```\n";
    const result = await runArchitect({
      repoRoot: repo,
      designPath: DESIGN_PATH,
      planId: PLAN_ID,
      createWorker: () => createFakeWorker({ finalText }),
    });
    assert.deepEqual(
      JSON.parse(readFileSync(result.planPath, "utf8")),
      samplePlan(),
    );
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("architect: a dirty target is rejected before the worker starts", async () => {
  const { repo } = initRepo();
  try {
    writeFileSync(join(repo, "src", "app.ts"), "export const app = 2;\n");
    let workerCreated = false;
    await assert.rejects(
      () =>
        runArchitect({
          repoRoot: repo,
          designPath: DESIGN_PATH,
          planId: PLAN_ID,
          createWorker: () => {
            workerCreated = true;
            return createFakeWorker({
              finalText: JSON.stringify(samplePlan()),
            });
          },
        }),
      /not clean/,
    );
    assert.equal(workerCreated, false);
    assert.equal(existsSync(join(repo, ".cliyard")), false);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("architect: touched paths are rejected and no Plan is written", async () => {
  const { repo } = initRepo();
  try {
    await assert.rejects(
      () =>
        runArchitect({
          repoRoot: repo,
          designPath: DESIGN_PATH,
          planId: PLAN_ID,
          createWorker: () =>
            createFakeWorker({
              finalText: JSON.stringify(samplePlan()),
              touchedPaths: ["src/health.ts"],
            }),
        }),
      /worker touched paths/,
    );
    assert.equal(existsSync(join(repo, ".cliyard")), false);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("architect: a worktree change during the run is rejected", async () => {
  const { repo } = initRepo();
  try {
    await assert.rejects(
      () =>
        runArchitect({
          repoRoot: repo,
          designPath: DESIGN_PATH,
          planId: PLAN_ID,
          createWorker: () =>
            createFakeWorker({
              finalText: JSON.stringify(samplePlan()),
              onStart: () => {
                writeFileSync(join(repo, "rogue.txt"), "rogue\n");
              },
            }),
        }),
      /worktree changed/,
    );
    assert.equal(existsSync(join(repo, ".cliyard")), false);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("architect: a moved HEAD during the run is rejected", async () => {
  const { repo } = initRepo();
  try {
    await assert.rejects(
      () =>
        runArchitect({
          repoRoot: repo,
          designPath: DESIGN_PATH,
          planId: PLAN_ID,
          createWorker: () =>
            createFakeWorker({
              finalText: JSON.stringify(samplePlan()),
              onStart: () => {
                runGit(repo, ["commit", "--allow-empty", "-m", "rogue"]);
              },
            }),
        }),
      /HEAD moved/,
    );
    assert.equal(existsSync(join(repo, ".cliyard")), false);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("architect: invalid JSON, schema, and cycles are rejected", async (t) => {
  const { repo } = initRepo();
  try {
    const cases = [
      {
        name: "invalid JSON",
        finalText: "I could not produce a Plan.",
        pattern: /invalid Plan JSON/,
      },
      {
        name: "invalid schema",
        finalText: JSON.stringify({ planId: PLAN_ID, tasks: [] }),
        pattern: /invalid Plan/,
      },
      {
        name: "dependency cycle",
        finalText: JSON.stringify({
          planId: PLAN_ID,
          tasks: [
            {
              taskId: "a",
              goal: "A",
              dependsOn: ["b"],
              writePaths: ["a.txt"],
              verifyCommands: ["true"],
            },
            {
              taskId: "b",
              goal: "B",
              dependsOn: ["a"],
              writePaths: ["b.txt"],
              verifyCommands: ["true"],
            },
          ],
        }),
        pattern: /dependency cycle/,
      },
    ];

    for (const item of cases) {
      await t.test(item.name, async () => {
        await assert.rejects(
          () =>
            runArchitect({
              repoRoot: repo,
              designPath: DESIGN_PATH,
              planId: PLAN_ID,
              createWorker: () =>
                createFakeWorker({ finalText: item.finalText }),
            }),
          item.pattern,
        );
        assert.equal(
          existsSync(
            join(repo, ".cliyard", "plans", `${PLAN_ID}.json`),
          ),
          false,
        );
      });
    }
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("architect: the design document must be tracked and repo-relative", async () => {
  const { repo } = initRepo();
  try {
    // Ignored so the worktree stays clean while the design remains untracked.
    writeFileSync(join(repo, ".gitignore"), "design/untracked.md\n");
    runGit(repo, ["add", ".gitignore"]);
    runGit(repo, ["commit", "-m", "ignore untracked design"]);
    writeFileSync(join(repo, "design", "untracked.md"), "# untracked\n");

    let workerCreated = false;
    const createWorker = () => {
      workerCreated = true;
      return createFakeWorker({ finalText: JSON.stringify(samplePlan()) });
    };

    await assert.rejects(
      () =>
        runArchitect({
          repoRoot: repo,
          designPath: "design/untracked.md",
          planId: PLAN_ID,
          createWorker,
        }),
      /not tracked/,
    );
    assert.equal(workerCreated, false);

    await assert.rejects(
      () =>
        runArchitect({
          repoRoot: repo,
          designPath: "../outside.md",
          planId: PLAN_ID,
          createWorker,
        }),
      /repository-relative/,
    );
    assert.equal(workerCreated, false);

    await assert.rejects(
      () =>
        runArchitect({
          repoRoot: repo,
          designPath: join(repo, DESIGN_PATH),
          planId: PLAN_ID,
          createWorker,
        }),
      /repository-relative/,
    );
    assert.equal(workerCreated, false);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("architect CLI help documents the read-only command", () => {
  const help = spawnSync(
    "npx",
    ["tsx", cliPath, "architect", "--help"],
    { cwd: cliyardRoot, encoding: "utf8" },
  );
  assert.equal(help.status, 1);
  assert.match(help.stdout, /cliyard architect/);
  assert.match(help.stdout, /--design/);
  assert.match(help.stdout, /--plan-id/);
  assert.match(help.stdout, /No contracts, worktrees, dispatch/);

  const top = spawnSync("npx", ["tsx", cliPath, "--help"], {
    cwd: cliyardRoot,
    encoding: "utf8",
  });
  assert.equal(top.status, 1);
  assert.match(top.stdout, /cliyard architect/);
});

test("architect CLI writes a Plan and prints a JSON summary", () => {
  const { repo, baseCommit } = initRepo();
  const binRoot = mkdtempSync(join(tmpdir(), "cliyard-architect-bin-"));
  try {
    const binary = writeFakeClaude(binRoot, samplePlan());
    const outPath = join(binRoot, "explicit-plan.json");

    const run = spawnSync(
      "npx",
      [
        "tsx",
        cliPath,
        "architect",
        "--repo",
        repo,
        "--design",
        DESIGN_PATH,
        "--plan-id",
        PLAN_ID,
        "--out",
        outPath,
        "--json",
      ],
      {
        cwd: cliyardRoot,
        encoding: "utf8",
        env: { ...process.env, CLIYARD_CLAUDE_BINARY: binary },
      },
    );
    assert.equal(run.status, 0, run.stderr || run.stdout);
    const summary = JSON.parse(run.stdout) as {
      ok: boolean;
      planId: string;
      baseCommit: string;
      taskIds: string[];
      worker: string;
      sessionId: string;
      touchedPaths: string[];
      planPath: string;
    };
    assert.equal(summary.ok, true);
    assert.equal(summary.planId, PLAN_ID);
    assert.equal(summary.baseCommit, baseCommit);
    assert.deepEqual(summary.taskIds, ["health-endpoint"]);
    assert.equal(summary.worker, "claude");
    assert.ok(summary.sessionId);
    assert.deepEqual(summary.touchedPaths, []);
    assert.equal(summary.planPath, outPath);
    assert.ok(existsSync(summary.planPath));
    assert.deepEqual(
      JSON.parse(readFileSync(summary.planPath, "utf8")),
      samplePlan(),
    );
    assert.equal(existsSync(join(repo, ".cliyard", "contracts")), false);
    assert.equal(existsSync(join(repo, ".cliyard", "worktrees")), false);
  } finally {
    rmSync(binRoot, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  }
});

test("architect CLI prints a human-readable summary", () => {
  const { repo } = initRepo();
  const binRoot = mkdtempSync(join(tmpdir(), "cliyard-architect-bin-"));
  try {
    const binary = writeFakeClaude(binRoot, samplePlan());
    const run = spawnSync(
      "npx",
      [
        "tsx",
        cliPath,
        "architect",
        "--repo",
        repo,
        "--design",
        DESIGN_PATH,
        "--plan-id",
        PLAN_ID,
      ],
      {
        cwd: cliyardRoot,
        encoding: "utf8",
        env: { ...process.env, CLIYARD_CLAUDE_BINARY: binary },
      },
    );
    assert.equal(run.status, 0, run.stderr || run.stdout);
    assert.match(run.stdout, /Task Architect: Plan written/);
    assert.match(run.stdout, /artifact:/);
    assert.match(run.stdout, /tasks:\s+health-endpoint/);
    assert.match(run.stdout, /touched:\s+\(none\)/);
    assert.match(run.stdout, /no contracts, worktrees, dispatch/);
    assert.ok(
      existsSync(join(repo, ".cliyard", "plans", `${PLAN_ID}.json`)),
    );
  } finally {
    rmSync(binRoot, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  }
});

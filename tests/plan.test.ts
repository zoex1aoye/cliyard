import { test } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import {
  compilePlan,
  parsePlanJson,
  PlanValidationError,
} from "../src/planner/plan.js";
import { runPlanBridge } from "../src/planner/bridge.js";

const base = "a".repeat(40);
const cliyardRoot = fileURLToPath(new URL("..", import.meta.url));

test("compilePlan: two independent module plans become frozen contracts", () => {
  const result = compilePlan(
    {
      planId: "glass-a11y",
      tasks: [
        {
          taskId: "glass-empty",
          goal: "Add status semantics to GlassEmpty",
          nonGoals: ["Do not redesign the visuals"],
          writePaths: ["src/components/GlassEmpty.vue"],
          verifyCommands: ["grep -q 'role=' src/components/GlassEmpty.vue"],
        },
        {
          taskId: "glass-skeleton",
          goals: ["Add busy semantics to GlassSkeleton"],
          dependsOn: [],
          writePaths: ["src/components/GlassSkeleton.vue"],
          verifyCommands: ["grep -q 'aria-busy' src/components/GlassSkeleton.vue"],
          maxRepairs: 2,
        },
      ],
    },
    { baseCommit: base },
  );

  assert.equal(result.planId, "glass-a11y");
  assert.deepEqual(
    result.contracts.map((contract) => contract.taskId),
    ["glass-empty", "glass-skeleton"],
  );
  assert.ok(result.contracts.every((contract) => contract.frozen));
  assert.ok(result.contracts.every((contract) => contract.baseCommit === base));
  assert.deepEqual(result.contracts[0]!.goals, [
    "Add status semantics to GlassEmpty",
  ]);
  assert.deepEqual(result.contracts[1]!.goals, [
    "Add busy semantics to GlassSkeleton",
  ]);
  assert.equal(result.contracts[1]!.maxRepairs, 2);
  assert.deepEqual(result.contracts[0]!.readPaths, [
    ".",
    "AGENTS.md",
    "src/components/GlassEmpty.vue",
  ]);
});

test("compilePlan: overlapping parallel writePaths are rejected", () => {
  assert.throws(
    () =>
      compilePlan(
        {
          planId: "overlap",
          tasks: [
            {
              taskId: "one",
              goal: "Edit component",
              writePaths: ["src/components/"],
              verifyCommands: ["test -d src/components"],
            },
            {
              taskId: "two",
              goal: "Edit same component",
              writePaths: ["src/components/Card.vue"],
              verifyCommands: ["test -f src/components/Card.vue"],
            },
          ],
        },
        { baseCommit: base },
      ),
    (error: unknown) => {
      assert.ok(error instanceof PlanValidationError);
      assert.match(error.message, /overlaps/);
      return true;
    },
  );
});

test("compilePlan: paths cannot escape the target repo", () => {
  assert.throws(
    () =>
      compilePlan(
        {
          planId: "escape",
          tasks: [
            {
              taskId: "one",
              goal: "Escape repo",
              writePaths: ["../outside.ts"],
              verifyCommands: ["true"],
            },
          ],
        },
        { baseCommit: base },
      ),
    /must stay inside the repository/,
  );
});

test("compilePlan: unknown dependencies and cycles are rejected", () => {
  assert.throws(
    () =>
      compilePlan(
        {
          planId: "bad-graph",
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
              dependsOn: ["a", "missing"],
              writePaths: ["b.txt"],
              verifyCommands: ["true"],
            },
          ],
        },
        { baseCommit: base },
      ),
    (error: unknown) => {
      assert.ok(error instanceof PlanValidationError);
      assert.match(error.message, /unknown task "missing"/);
      assert.match(error.message, /dependency cycle/);
      return true;
    },
  );
});

test("parsePlanJson accepts a fenced JSON block from chat", () => {
  const parsed = parsePlanJson(
    '```json\n{"planId":"chat","tasks":[]}\n```',
  ) as { planId: string };
  assert.equal(parsed.planId, "chat");
});

test("checked-in Glass Plan fixture compiles", () => {
  const fixture = fileURLToPath(
    new URL("../examples/glass-parallel.plan.json", import.meta.url),
  );
  const compiled = compilePlan(
    JSON.parse(readFileSync(fixture, "utf8")),
    { baseCommit: base },
  );
  assert.equal(compiled.planId, "glass-parallel-a11y");
  assert.deepEqual(compiled.contracts.map((contract) => contract.taskId), [
    "glass-empty-a11y",
    "glass-skeleton-a11y",
  ]);
});

test("plan-dispatch CLI compiles stdin Plan without dispatching", () => {
  const repo = mkdtempSync(join(tmpdir(), "cliyard-plan-cli-"));
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
    writeFileSync(join(repo, "README.md"), "# target\n");
    spawnSync("git", ["add", "."], { cwd: repo, stdio: "ignore" });
    spawnSync("git", ["commit", "-m", "init"], {
      cwd: repo,
      stdio: "ignore",
    });

    const cli = join(cliyardRoot, "src", "cli.ts");
    const run = spawnSync(
      "npx",
      ["tsx", cli, "plan-dispatch", "-", "--repo", repo],
      {
        cwd: cliyardRoot,
        input: JSON.stringify({
          planId: "stdin-plan",
          tasks: [
            {
              taskId: "readme",
              goal: "Preserve README",
              writePaths: ["README.md"],
              verifyCommands: ["test -f README.md"],
            },
          ],
        }),
        encoding: "utf8",
      },
    );
    assert.equal(run.status, 0, run.stderr);
    const result = JSON.parse(run.stdout) as {
      ok: boolean;
      dispatched: boolean;
      contractsPath: string;
    };
    assert.equal(result.ok, true);
    assert.equal(result.dispatched, false);
    assert.ok(result.contractsPath.includes(".cliyard/contracts/stdin-plan"));
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("runPlanBridge: compiles, persists, and dry-dispatches two worktrees", async () => {
  const repo = mkdtempSync(join(tmpdir(), "cliyard-plan-"));
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
    writeFileSync(join(repo, "a.ts"), "export const a = 1;\n");
    writeFileSync(join(repo, "b.ts"), "export const b = 1;\n");
    spawnSync("git", ["add", "."], { cwd: repo, stdio: "ignore" });
    spawnSync("git", ["commit", "-m", "init"], {
      cwd: repo,
      stdio: "ignore",
    });

    const result = await runPlanBridge({
      repoRoot: repo,
      plan: {
        planId: "two-modules",
        tasks: [
          {
            taskId: "module-a",
            goal: "Implement module A",
            writePaths: ["a.ts"],
            verifyCommands: ["test -f a.ts"],
          },
          {
            taskId: "module-b",
            goal: "Implement module B",
            writePaths: ["b.ts"],
            verifyCommands: ["test -f b.ts"],
          },
        ],
      },
      worker: "codex",
      dispatch: true,
      dryRun: true,
      keepWorktrees: false,
    });

    assert.equal(result.ok, true);
    assert.equal(result.dispatched, true);
    assert.equal(result.dispatchResult?.allAccepted, true);
    assert.deepEqual(result.warnings, []);
    assert.deepEqual(
      result.dispatchResult?.startOrder.sort(),
      ["module-a", "module-b"],
    );
    assert.equal(readFileSync(join(repo, "a.ts"), "utf8"), "export const a = 1;\n");
    assert.equal(
      readFileSync(join(repo, "b.ts"), "utf8"),
      "export const b = 1;\n",
    );

    const contracts = JSON.parse(
      readFileSync(result.contractsPath, "utf8"),
    ) as { planId: string; contracts: { frozen: boolean }[] };
    assert.equal(contracts.planId, "two-modules");
    assert.ok(contracts.contracts.every((contract) => contract.frozen));
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("runPlanBridge: background dispatch returns a job while ledger advances", async () => {
  const repo = mkdtempSync(join(tmpdir(), "cliyard-plan-bg-"));
  const ledgerPath = join(repo, ".cliyard", "ledger.json");
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
    writeFileSync(join(repo, "README.md"), "# target\n");
    spawnSync("git", ["add", "."], { cwd: repo, stdio: "ignore" });
    spawnSync("git", ["commit", "-m", "init"], {
      cwd: repo,
      stdio: "ignore",
    });

    const result = await runPlanBridge({
      repoRoot: repo,
      plan: {
        planId: "background-plan",
        tasks: [
          {
            taskId: "background-task",
            goal: "Exercise background dispatch",
            writePaths: ["README.md"],
            verifyCommands: ["test -f README.md"],
          },
        ],
      },
      worker: "mock",
      ledgerPath,
      dispatch: true,
      background: true,
    });
    assert.equal(result.ok, true);
    assert.ok(result.dispatchJob?.pid);
    assert.ok(result.dispatchJob?.logPath.startsWith(repo));

    let accepted = false;
    for (let i = 0; i < 40; i++) {
      if (existsSync(ledgerPath)) {
        const ledger = JSON.parse(readFileSync(ledgerPath, "utf8")) as {
          tasks: Record<string, { status: string }>;
        };
        if (ledger.tasks["background-task"]?.status === "accepted") {
          accepted = true;
          break;
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.equal(accepted, true, "background worker did not reach accepted");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

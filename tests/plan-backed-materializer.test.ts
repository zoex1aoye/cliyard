import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compilePlan } from "../src/planner/plan.js";
import {
  PlanMaterializationError,
  materializePlan,
  materializedContractsPath,
  type MaterializePlanInput,
  type PlanUpstreamEvidence,
} from "../src/orchestration/plan-materializer.js";
import {
  createRunManifest,
  runManifestPath,
  updateRunManifest,
  type CreateRunManifestInput,
} from "../src/supervisor/store.js";

const NOW = "2026-10-27T00:00:00.000Z";
const LATER = "2026-10-27T01:00:00.000Z";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

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
  const repo = mkdtempSync(join(tmpdir(), "cliyard-materializer-"));
  runGit(repo, ["init"]);
  runGit(repo, ["config", "user.email", "t@t.com"]);
  runGit(repo, ["config", "user.name", "t"]);
  writeFileSync(join(repo, "README.md"), "# fixture\n");
  runGit(repo, ["add", "."]);
  runGit(repo, ["commit", "-m", "init"]);
  return repo;
}

function withRepo(fn: (repo: string) => void): void {
  const repo = initRepo();
  try {
    fn(repo);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
}

function commitFile(
  repo: string,
  name: string,
  content: string,
  message: string,
): string {
  writeFileSync(join(repo, name), content);
  runGit(repo, ["add", name]);
  runGit(repo, ["commit", "-m", message]);
  return runGit(repo, ["rev-parse", "HEAD"]);
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

interface PlanFixture {
  path: string;
  hash: string;
  text: string;
  document: {
    planId: string;
    tasks: Array<{
      taskId: string;
      goal: string;
      writePaths: string[];
      verifyCommands: string[];
    }>;
  };
}

function planTasks(
  entries: Array<{ taskId: string; writePath: string }> = [
    { taskId: "task-a", writePath: "src/a.txt" },
  ],
): PlanFixture["document"]["tasks"] {
  return entries.map((entry) => ({
    taskId: entry.taskId,
    goal: `Produce ${entry.taskId}`,
    writePaths: [entry.writePath],
    verifyCommands: [`test -f ${entry.writePath}`],
  }));
}

function writePlan(
  repo: string,
  planId: string,
  tasks = planTasks(),
): PlanFixture {
  const document = { planId, tasks };
  const text = `${JSON.stringify(document, null, 2)}\n`;
  const path = join(repo, `${planId}.plan.json`);
  writeFileSync(path, text, "utf8");
  return { path, hash: sha256(text), text, document };
}

function writeContractsFile(
  repo: string,
  name = "upstream.contracts.json",
  marker = "v1",
): { path: string; hash: string } {
  const text = `${JSON.stringify(
    { planId: "upstream-plan", marker, contracts: [] },
    null,
    2,
  )}\n`;
  const path = join(repo, name);
  writeFileSync(path, text, "utf8");
  return { path, hash: sha256(text) };
}

interface ManifestFixture {
  runId: string;
  contractsPath: string;
  contractsHash?: string;
  baseCommit: string;
  integrationHead?: string;
}

/** Create a completed RunManifest with an optional explicit integration head. */
function completedManifest(repo: string, fixture: ManifestFixture): void {
  const input: CreateRunManifestInput = {
    runId: fixture.runId,
    planId: "upstream-plan",
    contractsPath: fixture.contractsPath,
    baseCommit: fixture.baseCommit,
    integrationBranch: `cliyard/integration/${fixture.runId}`,
    tasks: ["upstream-task"],
    ...(fixture.contractsHash !== undefined
      ? { contractsHash: fixture.contractsHash }
      : {}),
    ...(fixture.integrationHead !== undefined
      ? { integrationHead: fixture.integrationHead }
      : {}),
  };
  createRunManifest(repo, input);
  updateRunManifest(repo, fixture.runId, (manifest) => {
    manifest.status = "completed";
  });
}

function upstreamEvidence(
  contracts: { path: string; hash: string },
  overrides: Partial<PlanUpstreamEvidence> = {},
): PlanUpstreamEvidence {
  return {
    queueId: "upstream-item",
    status: "completed",
    lastRunId: "run-upstream",
    contractsPath: contracts.path,
    contractsHash: contracts.hash,
    ...overrides,
  };
}

function input(
  repo: string,
  plan: PlanFixture,
  overrides: Partial<MaterializePlanInput> = {},
): MaterializePlanInput {
  return {
    repoRoot: repo,
    queueId: "plan-item",
    planPath: plan.path,
    planHash: plan.hash,
    planId: plan.document.planId,
    materializedAt: NOW,
    ...overrides,
  };
}

function readJson(path: string): any {
  return JSON.parse(readFileSync(path, "utf8"));
}

// ---------------------------------------------------------------------------
// Root base
// ---------------------------------------------------------------------------

test("root materializes at the pinned older commit after HEAD moves", () => {
  withRepo((repo) => {
    const older = runGit(repo, ["rev-parse", "HEAD"]);
    const plan = writePlan(repo, "root-plan");
    const newer = commitFile(repo, "later.txt", "later\n", "later");
    assert.notEqual(older, newer);

    const result = materializePlan(
      input(repo, plan, {
        queueId: "root-item",
        rootBaseCommit: older,
      }),
    );

    assert.equal(result.baseCommit, older);
    assert.equal(result.planId, "root-plan");
    assert.equal(
      result.contractsPath,
      join(
        repo,
        ".cliyard",
        "queue",
        "materialized",
        "root-item",
        `${older}-${plan.hash}.contracts.json`,
      ),
    );
    const artifact = readJson(result.contractsPath);
    assert.ok(
      artifact.contracts.every((contract: any) => contract.baseCommit === older),
    );
    assert.equal(artifact.provenance.baseCommit, older);
    assert.equal(artifact.provenance.upstreamQueueId, undefined);
    // Materialization never moves the repository.
    assert.equal(runGit(repo, ["rev-parse", "HEAD"]), newer);
  });
});

test("rootBaseCommit must be an exact, resolvable commit revision", () => {
  withRepo((repo) => {
    const plan = writePlan(repo, "root-plan");
    const head = runGit(repo, ["rev-parse", "HEAD"]);
    const blob = runGit(repo, ["rev-parse", "HEAD:README.md"]);

    for (const [value, pattern] of [
      ["HEAD", /exact full git commit hash/],
      ["main", /exact full git commit hash/],
      [head.slice(0, 12), /exact full git commit hash/],
      ["not-a-revision", /exact full git commit hash/],
      ["f".repeat(40), /cannot resolve/],
      [blob, /cannot resolve/],
    ] as const) {
      assert.throws(
        () =>
          materializePlan(
            input(repo, plan, {
              queueId: `root-${value.slice(0, 6)}-${value.length}`,
              rootBaseCommit: value,
            }),
          ),
        (error: unknown) =>
          error instanceof PlanMaterializationError && pattern.test(error.message),
        `root base ${JSON.stringify(value)} must fail closed`,
      );
    }
    assert.equal(existsSync(join(repo, ".cliyard", "queue", "materialized")), false);
  });
});

test("exactly one of rootBaseCommit or upstream evidence is required", () => {
  withRepo((repo) => {
    const head = runGit(repo, ["rev-parse", "HEAD"]);
    const plan = writePlan(repo, "choice-plan");
    const contracts = writeContractsFile(repo);

    assert.throws(
      () => materializePlan(input(repo, plan)),
      /exactly one of rootBaseCommit or upstream evidence/,
    );
    assert.throws(
      () =>
        materializePlan(
          input(repo, plan, {
            rootBaseCommit: head,
            upstream: upstreamEvidence(contracts),
          }),
        ),
      /exactly one of rootBaseCommit or upstream evidence/,
    );
  });
});

// ---------------------------------------------------------------------------
// Dependent base
// ---------------------------------------------------------------------------

test("dependent materializes at the completed upstream integrationHead", () => {
  withRepo((repo) => {
    const base = runGit(repo, ["rev-parse", "HEAD"]);
    const integrationHead = commitFile(
      repo,
      "upstream.txt",
      "accepted upstream\n",
      "accept upstream",
    );
    const contracts = writeContractsFile(repo);
    completedManifest(repo, {
      runId: "run-upstream",
      contractsPath: contracts.path,
      baseCommit: base,
      integrationHead,
    });

    const plan = writePlan(repo, "dependent-plan");
    const result = materializePlan(
      input(repo, plan, {
        queueId: "dependent-item",
        upstream: upstreamEvidence(contracts),
      }),
    );

    assert.equal(result.baseCommit, integrationHead);
    assert.equal(result.upstreamQueueId, "upstream-item");
    assert.equal(result.upstreamRunId, "run-upstream");
    assert.equal(result.upstreamIntegrationHead, integrationHead);

    const artifact = readJson(result.contractsPath);
    assert.ok(
      artifact.contracts.every(
        (contract: any) => contract.baseCommit === integrationHead,
      ),
    );
    assert.deepEqual(artifact.provenance, {
      queueId: "dependent-item",
      planPath: plan.path,
      planHash: plan.hash,
      planId: "dependent-plan",
      baseCommit: integrationHead,
      upstreamQueueId: "upstream-item",
      upstreamRunId: "run-upstream",
      upstreamIntegrationHead: integrationHead,
    });
  });
});

test("base selection ignores current HEAD, the active run pointer and branches", () => {
  withRepo((repo) => {
    const rootBase = runGit(repo, ["rev-parse", "HEAD"]);
    const contracts = writeContractsFile(repo);

    const upstreamHead = commitFile(
      repo,
      "upstream.txt",
      "upstream\n",
      "upstream",
    );
    completedManifest(repo, {
      runId: "run-upstream",
      contractsPath: contracts.path,
      baseCommit: rootBase,
      integrationHead: upstreamHead,
    });

    // A later completed run becomes the active pointer and a branch points at
    // it; neither may influence the dependent base.
    const unrelatedHead = commitFile(repo, "other.txt", "other\n", "other");
    completedManifest(repo, {
      runId: "run-unrelated",
      contractsPath: contracts.path,
      baseCommit: rootBase,
      integrationHead: unrelatedHead,
    });
    runGit(repo, ["branch", "cliyard/integration/upstream-item", unrelatedHead]);

    // Current HEAD is yet another commit.
    const currentHead = commitFile(repo, "current.txt", "current\n", "current");
    assert.notEqual(currentHead, unrelatedHead);

    const plan = writePlan(repo, "no-inference-plan");
    const rootResult = materializePlan(
      input(repo, plan, {
        queueId: "root-item",
        rootBaseCommit: rootBase,
      }),
    );
    assert.equal(rootResult.baseCommit, rootBase);
    assert.notEqual(rootResult.baseCommit, currentHead);

    const dependentResult = materializePlan(
      input(repo, plan, {
        queueId: "dependent-item",
        upstream: upstreamEvidence(contracts, { lastRunId: "run-upstream" }),
      }),
    );
    assert.equal(dependentResult.baseCommit, upstreamHead);
    assert.notEqual(dependentResult.baseCommit, unrelatedHead);
    assert.notEqual(dependentResult.baseCommit, currentHead);
    assert.equal(
      runGit(repo, ["rev-parse", "HEAD"]),
      currentHead,
      "materialization must not move HEAD",
    );
  });
});

// ---------------------------------------------------------------------------
// Artifact identity
// ---------------------------------------------------------------------------

test("artifact path, bytes and provenance are exact and deterministic", () => {
  withRepo((repo) => {
    const base = runGit(repo, ["rev-parse", "HEAD"]);
    const plan = writePlan(
      repo,
      "exact-plan",
      planTasks([
        { taskId: "task-a", writePath: "src/a.txt" },
        { taskId: "task-b", writePath: "src/b.txt" },
      ]),
    );

    const result = materializePlan(
      input(repo, plan, {
        queueId: "exact-item",
        rootBaseCommit: base,
      }),
    );

    const expectedPath = join(
      repo,
      ".cliyard",
      "queue",
      "materialized",
      "exact-item",
      `${base}-${plan.hash}.contracts.json`,
    );
    assert.equal(result.contractsPath, expectedPath);
    assert.equal(
      result.contractsPath,
      materializedContractsPath(repo, "exact-item", base, plan.hash),
    );
    assert.equal(result.planPath, plan.path);
    assert.equal(result.planHash, plan.hash);
    assert.equal(result.planId, "exact-plan");
    assert.equal(result.materializedAt, NOW);

    const expectedArtifact = {
      planId: "exact-plan",
      contracts: compilePlan(plan.document, { baseCommit: base }).contracts,
      provenance: {
        queueId: "exact-item",
        planPath: plan.path,
        planHash: plan.hash,
        planId: "exact-plan",
        baseCommit: base,
      },
    };
    const expectedBytes = Buffer.from(
      `${JSON.stringify(expectedArtifact, null, 2)}\n`,
      "utf8",
    );
    const actualBytes = readFileSync(result.contractsPath);
    assert.deepEqual(actualBytes, expectedBytes);
    assert.equal(result.contractsHash, sha256(actualBytes));

    const document = JSON.parse(actualBytes.toString("utf8"));
    assert.deepEqual(Object.keys(document).sort(), [
      "contracts",
      "planId",
      "provenance",
    ]);
    assert.deepEqual(Object.keys(document.provenance).sort(), [
      "baseCommit",
      "planHash",
      "planId",
      "planPath",
      "queueId",
    ]);
    assert.ok(!actualBytes.toString("utf8").includes("materializedAt"));
    assert.equal(document.contracts.length, 2);
  });
});

test("materialization is idempotent and reuses byte-identical artifacts", () => {
  withRepo((repo) => {
    const base = runGit(repo, ["rev-parse", "HEAD"]);
    const plan = writePlan(repo, "reuse-plan");

    const first = materializePlan(
      input(repo, plan, { queueId: "reuse-item", rootBaseCommit: base }),
    );
    const bytes = readFileSync(first.contractsPath);
    const inode = statSync(first.contractsPath).ino;

    const second = materializePlan(
      input(repo, plan, {
        queueId: "reuse-item",
        rootBaseCommit: base,
        materializedAt: LATER,
      }),
    );

    assert.deepEqual(second, { ...first, materializedAt: LATER });
    assert.deepEqual(readFileSync(first.contractsPath), bytes);
    assert.equal(
      statSync(first.contractsPath).ino,
      inode,
      "reuse must not rewrite the recorded artifact",
    );
  });
});

// ---------------------------------------------------------------------------
// Plan failures
// ---------------------------------------------------------------------------

test("a changed or missing Plan fails closed before writing", () => {
  withRepo((repo) => {
    const base = runGit(repo, ["rev-parse", "HEAD"]);
    const plan = writePlan(repo, "changed-plan");

    const first = materializePlan(
      input(repo, plan, { queueId: "changed-item", rootBaseCommit: base }),
    );
    const recordedBytes = readFileSync(first.contractsPath);

    writeFileSync(plan.path, `${plan.text}\n`, "utf8");
    assert.throws(
      () =>
        materializePlan(
          input(repo, plan, {
            queueId: "changed-item",
            rootBaseCommit: base,
          }),
        ),
      /Plan hash mismatch/,
    );
    assert.deepEqual(
      readFileSync(first.contractsPath),
      recordedBytes,
      "a changed Plan must not rewrite the recorded artifact",
    );

    rmSync(plan.path);
    assert.throws(
      () =>
        materializePlan(
          input(repo, plan, {
            queueId: "changed-item",
            rootBaseCommit: base,
          }),
        ),
      /missing or unreadable/,
    );
  });
});

test("a malformed Plan fails closed even when its freeze hash matches", () => {
  withRepo((repo) => {
    const base = runGit(repo, ["rev-parse", "HEAD"]);
    const text = "{not valid json\n";
    const path = join(repo, "malformed.plan.json");
    writeFileSync(path, text, "utf8");

    assert.throws(
      () =>
        materializePlan({
          repoRoot: repo,
          queueId: "malformed-item",
          planPath: path,
          planHash: sha256(text),
          planId: "malformed",
          rootBaseCommit: base,
          materializedAt: NOW,
        }),
      /invalid Plan JSON/,
    );
  });
});

test("a Plan id different from the queue item fails closed", () => {
  withRepo((repo) => {
    const base = runGit(repo, ["rev-parse", "HEAD"]);
    const plan = writePlan(repo, "declared-plan");

    assert.throws(
      () =>
        materializePlan(
          input(repo, plan, {
            queueId: "mismatch-item",
            planId: "expected-plan",
            rootBaseCommit: base,
          }),
        ),
      /Plan id mismatch/,
    );
    assert.equal(existsSync(join(repo, ".cliyard", "queue", "materialized")), false);
  });
});

// ---------------------------------------------------------------------------
// Artifact change
// ---------------------------------------------------------------------------

test("a changed recorded artifact fails closed without overwriting", () => {
  withRepo((repo) => {
    const base = runGit(repo, ["rev-parse", "HEAD"]);
    const plan = writePlan(repo, "artifact-plan");
    const first = materializePlan(
      input(repo, plan, { queueId: "artifact-item", rootBaseCommit: base }),
    );

    const tampered = Buffer.concat([
      readFileSync(first.contractsPath),
      Buffer.from("\n", "utf8"),
    ]);
    writeFileSync(first.contractsPath, tampered);

    assert.throws(
      () =>
        materializePlan(
          input(repo, plan, {
            queueId: "artifact-item",
            rootBaseCommit: base,
          }),
        ),
      /artifact changed or is ambiguous/,
    );
    assert.deepEqual(
      readFileSync(first.contractsPath),
      tampered,
      "the changed artifact must be left untouched",
    );
  });
});

// ---------------------------------------------------------------------------
// Upstream failures
// ---------------------------------------------------------------------------

test("upstream must be completed and carry a recorded run id", () => {
  withRepo((repo) => {
    const base = runGit(repo, ["rev-parse", "HEAD"]);
    const plan = writePlan(repo, "upstream-plan");
    const contracts = writeContractsFile(repo);
    completedManifest(repo, {
      runId: "run-upstream",
      contractsPath: contracts.path,
      baseCommit: base,
    });

    for (const [override, pattern] of [
      [{ status: "pending" }, /is not completed/],
      [{ status: "running" }, /is not completed/],
      [{ status: "blocked" }, /is not completed/],
      [{ status: "cancelled" }, /is not completed/],
      [{ lastRunId: undefined }, /lastRunId must be a non-empty string/],
    ] as const) {
      assert.throws(
        () =>
          materializePlan(
            input(repo, plan, {
              queueId: "upstream-item",
              upstream: upstreamEvidence(contracts, override as any),
            }),
          ),
        (error: unknown) =>
          error instanceof PlanMaterializationError && pattern.test(error.message),
        `upstream ${JSON.stringify(override)} must fail closed`,
      );
    }
    assert.equal(existsSync(join(repo, ".cliyard", "queue", "materialized")), false);
  });
});

test("a missing or incomplete upstream RunManifest fails closed", () => {
  withRepo((repo) => {
    const base = runGit(repo, ["rev-parse", "HEAD"]);
    const plan = writePlan(repo, "upstream-plan");
    const contracts = writeContractsFile(repo);

    assert.throws(
      () =>
        materializePlan(
          input(repo, plan, {
            queueId: "upstream-item",
            upstream: upstreamEvidence(contracts, {
              lastRunId: "run-missing",
            }),
          }),
        ),
      /cannot load upstream RunManifest "run-missing"/,
    );

    createRunManifest(repo, {
      runId: "run-blocked",
      planId: "upstream-plan",
      contractsPath: contracts.path,
      baseCommit: base,
      integrationBranch: "cliyard/integration/blocked",
      tasks: ["upstream-task"],
    });
    updateRunManifest(repo, "run-blocked", (manifest) => {
      manifest.status = "blocked";
    });
    assert.throws(
      () =>
        materializePlan(
          input(repo, plan, {
            queueId: "upstream-item",
            upstream: upstreamEvidence(contracts, { lastRunId: "run-blocked" }),
          }),
        ),
      /upstream RunManifest "run-blocked" is not completed/,
    );
    assert.equal(existsSync(join(repo, ".cliyard", "queue", "materialized")), false);
  });
});

test("upstream RunManifest contracts and run identity must match exactly", () => {
  withRepo((repo) => {
    const base = runGit(repo, ["rev-parse", "HEAD"]);
    const plan = writePlan(repo, "upstream-plan");
    const contracts = writeContractsFile(repo, "one.contracts.json");
    const otherContracts = writeContractsFile(
      repo,
      "two.contracts.json",
      "v2",
    );

    completedManifest(repo, {
      runId: "run-hash",
      contractsPath: contracts.path,
      baseCommit: base,
    });
    assert.throws(
      () =>
        materializePlan(
          input(repo, plan, {
            queueId: "upstream-item",
            upstream: upstreamEvidence(contracts, {
              lastRunId: "run-hash",
              contractsHash: otherContracts.hash,
            }),
          }),
        ),
      /contracts identity does not match/,
    );

    completedManifest(repo, {
      runId: "run-path",
      contractsPath: contracts.path,
      baseCommit: base,
    });
    assert.throws(
      () =>
        materializePlan(
          input(repo, plan, {
            queueId: "upstream-item",
            upstream: upstreamEvidence(contracts, {
              lastRunId: "run-path",
              contractsPath: otherContracts.path,
            }),
          }),
        ),
      /contracts identity does not match/,
    );

    // A manifest file whose recorded runId was forged/renamed must not pass as
    // the run the queue item recorded.
    completedManifest(repo, {
      runId: "run-forged",
      contractsPath: contracts.path,
      baseCommit: base,
    });
    const forgedPath = runManifestPath(repo, "run-forged");
    const forged = readJson(forgedPath);
    forged.runId = "run-other";
    writeFileSync(forgedPath, `${JSON.stringify(forged, null, 2)}\n`, "utf8");
    assert.throws(
      () =>
        materializePlan(
          input(repo, plan, {
            queueId: "upstream-item",
            upstream: upstreamEvidence(contracts, { lastRunId: "run-forged" }),
          }),
        ),
      /run id .* does not match recorded lastRunId/,
    );
    assert.equal(existsSync(join(repo, ".cliyard", "queue", "materialized")), false);
  });
});

test("integrationHead must be an exact, resolvable commit", () => {
  withRepo((repo) => {
    const base = runGit(repo, ["rev-parse", "HEAD"]);
    const plan = writePlan(repo, "upstream-plan");
    const contracts = writeContractsFile(repo);
    const head = runGit(repo, ["rev-parse", "HEAD"]);

    for (const [runId, integrationHead, pattern] of [
      ["run-branch", "main", /exact full git commit hash/],
      ["run-short", head.slice(0, 12), /exact full git commit hash/],
      ["run-fake", "f".repeat(40), /cannot resolve/],
    ] as const) {
      completedManifest(repo, {
        runId,
        contractsPath: contracts.path,
        baseCommit: base,
        integrationHead,
      });
      assert.throws(
        () =>
          materializePlan(
            input(repo, plan, {
              queueId: "upstream-item",
              upstream: upstreamEvidence(contracts, { lastRunId: runId }),
            }),
          ),
        (error: unknown) =>
          error instanceof PlanMaterializationError && pattern.test(error.message),
        `integrationHead ${JSON.stringify(integrationHead)} must fail closed`,
      );
    }
    assert.equal(existsSync(join(repo, ".cliyard", "queue", "materialized")), false);
  });
});

test("a non-ancestral upstream manifest base fails closed", () => {
  withRepo((repo) => {
    const root = runGit(repo, ["rev-parse", "HEAD"]);
    const branch = runGit(repo, ["rev-parse", "--abbrev-ref", "HEAD"]);
    const mainHead = commitFile(repo, "main.txt", "main\n", "main");

    runGit(repo, ["checkout", "--detach", root]);
    const sideHead = commitFile(repo, "side.txt", "side\n", "side");
    runGit(repo, ["checkout", branch]);
    assert.notEqual(mainHead, sideHead);

    const contracts = writeContractsFile(repo);
    completedManifest(repo, {
      runId: "run-divergent",
      contractsPath: contracts.path,
      baseCommit: sideHead,
      integrationHead: mainHead,
    });

    const plan = writePlan(repo, "ancestry-plan");
    assert.throws(
      () =>
        materializePlan(
          input(repo, plan, {
            queueId: "upstream-item",
            upstream: upstreamEvidence(contracts, {
              lastRunId: "run-divergent",
            }),
          }),
        ),
      /is not an ancestor of integration head/,
    );
    assert.equal(existsSync(join(repo, ".cliyard", "queue", "materialized")), false);
  });
});

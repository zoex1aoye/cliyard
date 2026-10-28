import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runQueueCli } from "../src/orchestration/cli.js";
import {
  buildControlSnapshot,
} from "../src/orchestration/control-snapshot.js";
import {
  runQueue,
  type QueueSupervisorRequest,
  type QueueSupervisorResult,
  type QueueSupervisorRunner,
} from "../src/orchestration/queue-runner.js";
import {
  MAX_REVIEW_EVIDENCE_BYTES,
  QueueValidationError,
  adoptQueueItem,
  addPlanQueueItem,
  cancelQueueItem,
  isPlanBackedQueueItem,
  loadQueue,
  queueAdoptionEventsPath,
  queuePaths,
  readQueueAdoptionEvents,
  retryQueueItem,
  saveQueue,
  type QueueItem,
} from "../src/orchestration/queue-store.js";
import {
  createRunManifest,
  loadRunManifest,
  updateRunManifest,
} from "../src/supervisor/store.js";
import type { RunStatus } from "../src/supervisor/types.js";

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
  const repo = mkdtempSync(join(tmpdir(), "cliyard-adoption-"));
  runGit(repo, ["init"]);
  runGit(repo, ["config", "user.email", "t@t.com"]);
  runGit(repo, ["config", "user.name", "t"]);
  writeFileSync(join(repo, "README.md"), "# fixture\n");
  runGit(repo, ["add", "."]);
  runGit(repo, ["commit", "-m", "init"]);
  return repo;
}

async function withRepo(fn: (repo: string) => Promise<void>): Promise<void> {
  const repo = initRepo();
  try {
    await fn(repo);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function commitFile(
  repo: string,
  name: string,
  content: string,
  message: string,
): string {
  writeFileSync(join(repo, name), content, "utf8");
  runGit(repo, ["add", name]);
  runGit(repo, ["commit", "-m", message]);
  return runGit(repo, ["rev-parse", "HEAD"]);
}

interface PlanTask {
  taskId: string;
  goal: string;
  readPaths?: string[];
  writePaths: string[];
  verifyCommands: string[];
}

interface PlanFixture {
  path: string;
  hash: string;
  text: string;
  document: { planId: string; tasks: PlanTask[] };
}

function planTasks(planId: string): PlanTask[] {
  return [
    {
      taskId: `${planId}-task`,
      goal: `Produce the ${planId} artifact`,
      writePaths: [`${planId}.txt`],
      verifyCommands: [`test -f ${planId}.txt`],
    },
  ];
}

function writePlan(repo: string, planId: string): PlanFixture {
  const document = { planId, tasks: planTasks(planId) };
  const text = `${JSON.stringify(document, null, 2)}\n`;
  const path = join(repo, `${planId}.plan.json`);
  writeFileSync(path, text, "utf8");
  return { path, hash: sha256(text), text, document };
}

function addRootPlan(repo: string, id: string): PlanFixture {
  const plan = writePlan(repo, id);
  addPlanQueueItem(repo, { id, planPath: plan.path });
  return plan;
}

function addDependentPlan(
  repo: string,
  id: string,
  dependsOn: string,
): PlanFixture {
  const plan = writePlan(repo, id);
  addPlanQueueItem(repo, { id, planPath: plan.path, dependsOn: [dependsOn] });
  return plan;
}

function itemById(repo: string, id: string): QueueItem {
  const item = loadQueue(repo).items.find((candidate) => candidate.id === id);
  assert.ok(item, `queue item ${id} must exist`);
  return item;
}

function materializationOf(request: QueueSupervisorRequest) {
  const materialization = request.item.materialization;
  assert.ok(
    materialization,
    `expected a plan materialization before dispatch of ${request.item.id}`,
  );
  return materialization;
}

function writeManifestForRequest(
  repo: string,
  request: QueueSupervisorRequest,
  options: { runId: string; status: RunStatus; integrationHead?: string },
): void {
  const materialization = materializationOf(request);
  createRunManifest(repo, {
    runId: options.runId,
    planId: request.item.planId ?? request.item.id,
    contractsPath: materialization.contractsPath,
    contractsHash: materialization.contractsHash,
    baseCommit: materialization.baseCommit,
    integrationBranch: `cliyard/integration/${options.runId}`,
    ...(options.integrationHead !== undefined
      ? { integrationHead: options.integrationHead }
      : {}),
    tasks: [],
  });
  updateRunManifest(repo, options.runId, (manifest) => {
    manifest.status = options.status;
  });
}

/**
 * Dispatch one root Plan item and leave the blocked RunManifest a real
 * Supervisor would leave. Retains the materialization and run binding.
 */
async function blockedRoot(
  repo: string,
  id: string,
  runId: string,
): Promise<{ item: QueueItem; plan: PlanFixture }> {
  const plan = addRootPlan(repo, id);
  const summary = await runQueue(repo, {
    runner: async (request) => {
      writeManifestForRequest(repo, request, {
        runId,
        status: "blocked",
      });
      return {
        exitCode: 1,
        status: "blocked",
        runId,
        reason: "verification rejected the worker artifact",
      };
    },
  });
  assert.equal(summary.dispatched, 1);
  const item = itemById(repo, id);
  assert.equal(item.status, "blocked");
  assert.equal(item.lastRunId, runId);
  assert.ok(item.materialization);
  return { item, plan };
}

interface EvidenceOverrides {
  version?: unknown;
  reviewedAt?: unknown;
  reviewedCommit?: unknown;
  commands?: unknown;
  notes?: unknown;
  extra?: Record<string, unknown>;
}

function writeEvidence(
  repo: string,
  name: string,
  overrides: EvidenceOverrides = {},
): { path: string; hash: string; text: string } {
  const { extra, ...fields } = overrides;
  const document = {
    version: 1,
    reviewedAt: "2026-10-28T10:00:00.000Z",
    commands: [
      {
        command: "npm test -- queue",
        exitCode: 0,
        outputSha256: sha256("all checks passed"),
        notes: "focused suite",
      },
    ],
    ...fields,
    ...(extra ?? {}),
  };
  const text = `${JSON.stringify(document, null, 2)}\n`;
  const path = join(repo, name);
  writeFileSync(path, text, "utf8");
  return { path, hash: sha256(text), text };
}

interface AdoptOptions {
  runId: string;
  artifact: string;
  evidencePath: string;
  approvedBy?: string;
  reason?: string;
}

function adopt(repo: string, id: string, options: AdoptOptions): QueueItem {
  return adoptQueueItem(repo, {
    id,
    runId: options.runId,
    artifact: options.artifact,
    evidencePath: options.evidencePath,
    approvedBy: options.approvedBy ?? "operator-a",
    reason: options.reason ?? "manually reviewed and integrated",
  });
}

// ---------------------------------------------------------------------------
// Adoption success / idempotency / status
// ---------------------------------------------------------------------------

test("adopt closes a blocked Plan item without changing RunManifest authority", async () => {
  await withRepo(async (repo) => {
    const { item: blocked } = await blockedRoot(
      repo,
      "root",
      "run-blocked-root",
    );
    const manifestBefore = loadRunManifest(repo, "run-blocked-root");
    const reviewedCommit = commitFile(
      repo,
      "reviewed.txt",
      "reviewed work\n",
      "integrate reviewed work",
    );
    const evidence = writeEvidence(repo, "evidence.json", {
      reviewedCommit,
    });

    const adopted = adopt(repo, "root", {
      runId: "run-blocked-root",
      artifact: reviewedCommit,
      evidencePath: evidence.path,
      approvedBy: "operator-a",
      reason: "checker output reviewed and commit integrated",
    });

    assert.equal(adopted.status, "completed");
    assert.equal(adopted.attempts, blocked.attempts);
    assert.equal(adopted.lastRunId, "run-blocked-root");
    assert.equal(adopted.reason, undefined);
    assert.equal(adopted.failure, undefined);
    const resolution = adopted.resolution;
    assert.ok(resolution);
    assert.deepEqual(resolution, {
      version: 1,
      kind: "manual-adoption",
      queueItemId: "root",
      sourceRunId: "run-blocked-root",
      sourceManifestStatus: "blocked",
      baseCommit: blocked.materialization!.baseCommit,
      contractsHash: blocked.materialization!.contractsHash,
      reviewedCommit,
      reviewEvidencePath: evidence.path,
      reviewEvidenceHash: evidence.hash,
      approvedBy: "operator-a",
      approvedAt: resolution.approvedAt,
      reason: "checker output reviewed and commit integrated",
    });
    assert.equal(Number.isNaN(Date.parse(resolution.approvedAt)), false);
    // Evidence is hashed byte-for-byte, not semantically.
    assert.equal(
      resolution.reviewEvidenceHash,
      sha256(readFileSync(evidence.path)),
    );
    assert.equal(resolution.reviewEvidenceHash, evidence.hash);

    // The source RunManifest is evidence only and remains untouched.
    assert.deepEqual(
      loadRunManifest(repo, "run-blocked-root"),
      manifestBefore,
    );
    assert.equal(manifestBefore.status, "blocked");

    // Persistence is durable and preserves the frozen Plan/artifact identity.
    const persisted = itemById(repo, "root");
    assert.deepEqual(persisted, adopted);
    assert.equal(isPlanBackedQueueItem(persisted), true);
    assert.deepEqual(persisted.materialization, blocked.materialization);

    // A repeated adoption with byte-identical identity is idempotent.
    const repeated = adopt(repo, "root", {
      runId: "run-blocked-root",
      artifact: reviewedCommit,
      evidencePath: evidence.path,
      approvedBy: "operator-a",
      reason: "checker output reviewed and commit integrated",
    });
    assert.deepEqual(repeated, adopted);
    assert.equal(readQueueAdoptionEvents(repo).totalEvents, 1);

    const eventFile = queueAdoptionEventsPath(repo);
    assert.equal(existsSync(eventFile), true);
    const eventLines = readFileSync(eventFile, "utf8")
      .trim()
      .split("\n");
    assert.equal(eventLines.length, 1);
    const event = JSON.parse(eventLines[0]!) as Record<string, unknown>;
    assert.deepEqual(Object.keys(event).sort(), [
      "approvedBy",
      "at",
      "baseCommit",
      "contractsHash",
      "eventId",
      "itemId",
      "reason",
      "reviewEvidenceHash",
      "reviewEvidencePath",
      "reviewedCommit",
      "runId",
      "sourceManifestStatus",
      "status",
      "type",
      "version",
    ]);
    assert.equal(event.type, "queue.item.adopted");
    assert.equal(event.itemId, "root");
    assert.equal(event.runId, "run-blocked-root");
    assert.equal(event.status, "completed");
    assert.equal(event.reviewedCommit, reviewedCommit);
    // The event is bounded metadata; review command text never enters it.
    assert.ok(!JSON.stringify(event).includes("npm test"));

    // Completed adoption is monotonic for retry and cancel.
    assert.throws(
      () => retryQueueItem(repo, "root"),
      /completed items never run again/,
    );
    assert.throws(
      () => cancelQueueItem(repo, "root"),
      /completed items never run again/,
    );

    // Status distinguishes adopted completion and preserves run inspection.
    const snapshot = await buildControlSnapshot(repo);
    const snapshotItem = snapshot.items[0]!;
    assert.equal(snapshotItem.status, "completed");
    assert.equal(snapshotItem.completion, "adopted");
    assert.deepEqual(snapshotItem.resolution, resolution);
    assert.equal(snapshotItem.run?.runId, "run-blocked-root");
    assert.equal(snapshotItem.run?.status, "blocked");
    assert.equal(snapshotItem.run?.effectiveStatus, "blocked");
    assert.equal(snapshotItem.run?.accepted, 0);
    assert.deepEqual(snapshotItem.errors, []);
    assert.equal(snapshotItem.retryable, false);
    assert.equal(snapshotItem.observedNextAction, "none");
    assert.equal(snapshotItem.decision.category, "none");
    assert.equal(snapshot.queue.adoptionEvents.totalEvents, 1);
    assert.equal(snapshot.queue.adoptionEvents.events[0]?.type, "queue.item.adopted");
    assert.equal(snapshot.queue.adoptionEvents.events[0]?.itemId, "root");

    const human: string[] = [];
    const json: string[] = [];
    await runQueueCli(["status", "--repo", repo], {
      log: (line) => human.push(line),
    });
    await runQueueCli(["status", "--repo", repo, "--json"], {
      log: (line) => json.push(line),
    });
    const humanText = human.join("\n");
    assert.match(humanText, /adoptions: 1 event\(s\), 0 malformed/);
    assert.match(humanText, /root {2}completed \(adopted\)/);
    assert.match(humanText, /adoption: manual adoption of run run-blocked-root/);
    assert.match(humanText, /reviewed commit: [0-9a-f]{40}/);
    assert.match(humanText, /run: run-blocked-root {2}blocked {2}tasks=0\/0/);
    const parsed = JSON.parse(json.join("\n")) as {
      items: Array<Record<string, unknown>>;
    };
    assert.equal(parsed.items[0]?.completion, "adopted");
    assert.deepEqual(parsed.items[0]?.resolution, resolution);
  });
});

// ---------------------------------------------------------------------------
// State / run / contract preconditions
// ---------------------------------------------------------------------------

test("adoption requires a blocked item bound to the exact run", async () => {
  await withRepo(async (repo) => {
    const reviewedCommit = commitFile(
      repo,
      "reviewed.txt",
      "reviewed\n",
      "reviewed",
    );
    const evidence = writeEvidence(repo, "evidence.json");
    addRootPlan(repo, "pending-root");

    assert.throws(
      () =>
        adopt(repo, "pending-root", {
          runId: "run-any",
          artifact: reviewedCommit,
          evidencePath: evidence.path,
        }),
      /only a blocked item with a reviewed run may be adopted/,
    );
    assert.equal(itemById(repo, "pending-root").status, "pending");
  });

  await withRepo(async (repo) => {
    await blockedRoot(repo, "root", "run-blocked-root");
    const reviewedCommit = commitFile(
      repo,
      "reviewed.txt",
      "reviewed\n",
      "reviewed",
    );
    const evidence = writeEvidence(repo, "evidence.json");
    const before = loadQueue(repo);

    assert.throws(
      () =>
        adopt(repo, "root", {
          runId: "run-other",
          artifact: reviewedCommit,
          evidencePath: evidence.path,
        }),
      /lastRunId "run-blocked-root" does not match --run "run-other"/,
    );
    assert.deepEqual(loadQueue(repo), before);
    assert.throws(
      () => adopt(repo, "missing", {
        runId: "run-blocked-root",
        artifact: reviewedCommit,
        evidencePath: evidence.path,
      }),
      /queue item not found/,
    );
  });
});

test("adoption requires unchanged frozen contracts and approved Plan", async () => {
  await withRepo(async (repo) => {
    const { item: blocked } = await blockedRoot(
      repo,
      "root",
      "run-blocked-root",
    );
    const reviewedCommit = commitFile(
      repo,
      "reviewed.txt",
      "reviewed\n",
      "reviewed",
    );
    const evidence = writeEvidence(repo, "evidence.json");
    writeFileSync(
      blocked.materialization!.contractsPath,
      `${readFileSync(blocked.materialization!.contractsPath, "utf8")}\n`,
      "utf8",
    );

    assert.throws(
      () =>
        adopt(repo, "root", {
          runId: "run-blocked-root",
          artifact: reviewedCommit,
          evidencePath: evidence.path,
        }),
      /frozen contracts changed/,
    );
    assert.equal(itemById(repo, "root").status, "blocked");
  });

  await withRepo(async (repo) => {
    const { plan } = await blockedRoot(repo, "root", "run-blocked-root");
    const reviewedCommit = commitFile(
      repo,
      "reviewed.txt",
      "reviewed\n",
      "reviewed",
    );
    const evidence = writeEvidence(repo, "evidence.json");
    writeFileSync(plan.path, `${plan.text}\n`, "utf8");

    assert.throws(
      () =>
        adopt(repo, "root", {
          runId: "run-blocked-root",
          artifact: reviewedCommit,
          evidencePath: evidence.path,
        }),
      /approved Plan changed/,
    );
    assert.equal(itemById(repo, "root").status, "blocked");
  });
});

// ---------------------------------------------------------------------------
// Evidence validation
// ---------------------------------------------------------------------------

test("review evidence is versioned, bounded, secret-free and exactly hashed", async () => {
  await withRepo(async (repo) => {
    await blockedRoot(repo, "root", "run-blocked-root");
    const reviewedCommit = commitFile(
      repo,
      "reviewed.txt",
      "reviewed\n",
      "reviewed",
    );
    const validEvidence = writeEvidence(repo, "evidence.json", {
      reviewedCommit,
    });
    const adoptWith = (path: string) =>
      adopt(repo, "root", {
        runId: "run-blocked-root",
        artifact: reviewedCommit,
        evidencePath: path,
      });

    const invalidJson = join(repo, "invalid.json");
    writeFileSync(invalidJson, "{not json\n", "utf8");
    assert.throws(() => adoptWith(invalidJson), /not valid JSON/);

    const wrongVersion = writeEvidence(repo, "wrong-version.json", {
      version: 2,
    });
    assert.throws(() => adoptWith(wrongVersion.path), /version must be 1/);

    const unknownField = writeEvidence(repo, "unknown-field.json", {
      extra: { rawOutput: "full worker log" },
    });
    assert.throws(
      () => adoptWith(unknownField.path),
      /unsupported field "rawOutput"/,
    );

    const noSuccess = writeEvidence(repo, "no-success.json", {
      commands: [
        {
          command: "npm test",
          exitCode: 1,
          outputSha256: sha256("failed"),
        },
      ],
    });
    assert.throws(
      () => adoptWith(noSuccess.path),
      /at least one successful command/,
    );

    const badExit = writeEvidence(repo, "bad-exit.json", {
      commands: [
        {
          command: "npm test",
          exitCode: "0",
          outputSha256: sha256("ok"),
        },
      ],
    });
    assert.throws(
      () => adoptWith(badExit.path),
      /exitCode must be an integer/,
    );

    const badDigest = writeEvidence(repo, "bad-digest.json", {
      commands: [
        { command: "npm test", exitCode: 0, outputSha256: "not-a-digest" },
      ],
    });
    assert.throws(
      () => adoptWith(badDigest.path),
      /outputSha256 must be a hex SHA-256 digest/,
    );

    const secret = writeEvidence(repo, "secret.json", {
      commands: [
        {
          command: "curl -H 'Authorization: Bearer abcdefghijklmnopqrstuvwxyz012345'",
          exitCode: 0,
          outputSha256: sha256("ok"),
        },
      ],
    });
    assert.throws(
      () => adoptWith(secret.path),
      /appears to contain a credential/,
    );

    const secretAssignment = writeEvidence(repo, "secret-assign.json", {
      notes: "api_key=abcdefgh12345678",
    });
    assert.throws(
      () => adoptWith(secretAssignment.path),
      /appears to contain a credential/,
    );

    const tooMany = writeEvidence(repo, "too-many.json", {
      commands: Array.from({ length: 65 }, (_, index) => ({
        command: `true #${index}`,
        exitCode: 0,
        outputSha256: sha256("ok"),
      })),
    });
    assert.throws(
      () => adoptWith(tooMany.path),
      /non-empty array of at most 64 entries/,
    );

    // The byte bound is checked before parsing.
    const oversized = join(repo, "oversized.json");
    writeFileSync(
      oversized,
      JSON.stringify({
        version: 1,
        reviewedAt: "2026-10-28T10:00:00.000Z",
        commands: [
          {
            command: "npm test",
            exitCode: 0,
            outputSha256: sha256("ok"),
            notes: "x".repeat(MAX_REVIEW_EVIDENCE_BYTES),
          },
        ],
      }),
      "utf8",
    );
    assert.throws(
      () => adoptWith(oversized),
      new RegExp(`exceeds the ${MAX_REVIEW_EVIDENCE_BYTES}-byte`),
    );

    const abbreviated = writeEvidence(repo, "abbreviated.json", {
      reviewedCommit: reviewedCommit.slice(0, 12),
    });
    assert.throws(
      () => adoptWith(abbreviated.path),
      /reviewedCommit must be a full git commit hash/,
    );

    // The valid evidence is accepted exactly once.
    const adopted = adoptWith(validEvidence.path);
    assert.equal(adopted.status, "completed");

    // A changed evidence location or byte content changes the identity and
    // cannot replace the existing resolution.
    const changedEvidence = writeEvidence(repo, "changed-evidence.json", {
      reviewedCommit,
    });
    assert.throws(
      () => adoptWith(changedEvidence.path),
      /different reviewEvidencePath/,
    );
    assert.throws(
      () =>
        adopt(repo, "root", {
          runId: "run-blocked-root",
          artifact: reviewedCommit,
          evidencePath: validEvidence.path,
          approvedBy: "operator-b",
        }),
      /different approvedBy/,
    );
    assert.deepEqual(itemById(repo, "root"), adopted);
    const changedBytes = writeEvidence(repo, "evidence.json", {
      reviewedCommit,
      reviewedAt: "2026-10-28T11:00:00.000Z",
    });
    assert.throws(
      () => adoptWith(changedBytes.path),
      /different reviewEvidenceHash/,
    );
    assert.deepEqual(itemById(repo, "root"), adopted);
    assert.equal(readQueueAdoptionEvents(repo).totalEvents, 1);
  });
});

// ---------------------------------------------------------------------------
// Commit proofs
// ---------------------------------------------------------------------------

test("the reviewed artifact must be a full, existing commit in HEAD lineage", async () => {
  await withRepo(async (repo) => {
    await blockedRoot(repo, "root", "run-blocked-root");
    const reviewedCommit = commitFile(
      repo,
      "reviewed.txt",
      "reviewed\n",
      "reviewed",
    );
    const evidence = writeEvidence(repo, "evidence.json");
    const adoptCommit = (artifact: string) =>
      adopt(repo, "root", {
        runId: "run-blocked-root",
        artifact,
        evidencePath: evidence.path,
      });

    for (const bad of [
      "main",
      "HEAD",
      reviewedCommit.slice(0, 12),
      "f".repeat(40),
    ]) {
      assert.throws(
        () => adoptCommit(bad),
        /must be an exact full git commit hash|cannot resolve --artifact/,
        bad,
      );
    }

    // A commit outside HEAD lineage is rejected even when it exists.
    const originalBranch = runGit(repo, [
      "rev-parse",
      "--abbrev-ref",
      "HEAD",
    ]);
    runGit(repo, ["checkout", "-b", "side"]);
    const sideCommit = commitFile(
      repo,
      "side.txt",
      "side work\n",
      "side commit",
    );
    runGit(repo, ["checkout", originalBranch]);
    assert.throws(
      () => adoptCommit(sideCommit),
      /not an ancestor of or equal to the current HEAD/,
    );

    assert.equal(itemById(repo, "root").status, "blocked");
  });

  await withRepo(async (repo) => {
    await blockedRoot(repo, "root", "run-blocked-root");
    const evidence = writeEvidence(repo, "evidence.json");
    // An unrelated orphan commit is checked out as HEAD: it exists, but it is
    // not a descendant of the pinned source base.
    runGit(repo, ["checkout", "--orphan", "unrelated"]);
    const orphanCommit = commitFile(
      repo,
      "orphan.txt",
      "orphan\n",
      "orphan commit",
    );
    assert.throws(
      () =>
        adopt(repo, "root", {
          runId: "run-blocked-root",
          artifact: orphanCommit,
          evidencePath: evidence.path,
        }),
      /not a descendant of the pinned source base/,
    );
    assert.equal(itemById(repo, "root").status, "blocked");
  });
});

// ---------------------------------------------------------------------------
// Dependent lineage
// ---------------------------------------------------------------------------

test("adopted dependants use explicit reviewed lineage and preserve the queue binding", async () => {
  await withRepo(async (repo) => {
    addRootPlan(repo, "root");
    addDependentPlan(repo, "upper", "root");
    addDependentPlan(repo, "upper-head", "root");
    await runQueue(repo, {
      runner: async (request) => {
        writeManifestForRequest(repo, request, {
          runId: "run-blocked-root",
          status: "blocked",
        });
        return {
          exitCode: 1,
          status: "blocked",
          runId: "run-blocked-root",
        };
      },
    });
    assert.equal(itemById(repo, "upper").status, "pending");
    assert.equal(itemById(repo, "upper-head").status, "pending");

    const reviewedCommit = commitFile(
      repo,
      "reviewed.txt",
      "reviewed\n",
      "reviewed",
    );
    const evidence = writeEvidence(repo, "evidence.json", {
      reviewedCommit,
    });
    adopt(repo, "root", {
      runId: "run-blocked-root",
      artifact: reviewedCommit,
      evidencePath: evidence.path,
    });

    const dispatched: QueueSupervisorRequest[] = [];
    const runner: QueueSupervisorRunner = async (request) => {
      dispatched.push(request);
      const runId = `run-${request.item.id}`;
      const result: QueueSupervisorResult = {
        exitCode: 0,
        status: "completed",
        runId,
      };
      writeManifestForRequest(repo, request, {
        runId,
        status: "completed",
        integrationHead: materializationOf(request).baseCommit,
      });
      return result;
    };
    const summary = await runQueue(repo, {
      runner,
      maxDispatches: 1,
    });
    assert.equal(summary.dispatched, 1);
    assert.deepEqual(
      dispatched.map((request) => request.item.id),
      ["upper"],
    );

    const upperMaterialization = materializationOf(dispatched[0]!);
    // The source manifest stays blocked, so its integration head is not
    // usable; the reviewed commit becomes the explicit adopted base.
    assert.equal(upperMaterialization.baseCommit, reviewedCommit);
    assert.equal(upperMaterialization.upstreamQueueId, "root");
    assert.equal(upperMaterialization.upstreamRunId, "run-blocked-root");
    assert.equal(upperMaterialization.upstreamIntegrationHead, undefined);
    assert.equal(upperMaterialization.upstreamAdoptedCommit, reviewedCommit);
    const adoptedArtifact = JSON.parse(
      readFileSync(upperMaterialization.contractsPath, "utf8"),
    ) as {
      provenance: Record<string, unknown>;
    };
    assert.equal(adoptedArtifact.provenance.upstreamQueueId, "root");
    assert.equal(adoptedArtifact.provenance.upstreamRunId, "run-blocked-root");
    assert.equal(
      adoptedArtifact.provenance.upstreamAdoptedCommit,
      reviewedCommit,
    );
    assert.equal(adoptedArtifact.provenance.baseCommit, reviewedCommit);
    assert.equal(itemById(repo, "upper").status, "completed");

    // When the source run later carries a usable completed integration head
    // containing the reviewed commit, that head is the dependant base. The
    // adopted lineage is still recorded explicitly.
    const integratedHead = commitFile(
      repo,
      "integrated.txt",
      "integrated\n",
      "complete the source integration",
    );
    updateRunManifest(repo, "run-blocked-root", (manifest) => {
      manifest.status = "completed";
      manifest.integrationHead = integratedHead;
    });

    const secondDispatched: QueueSupervisorRequest[] = [];
    await runQueue(repo, {
      runner: async (request) => {
        secondDispatched.push(request);
        const runId = `run-${request.item.id}`;
        writeManifestForRequest(repo, request, {
          runId,
          status: "completed",
          integrationHead: materializationOf(request).baseCommit,
        });
        return { exitCode: 0, status: "completed", runId };
      },
      maxDispatches: 1,
    });
    assert.deepEqual(
      secondDispatched.map((request) => request.item.id),
      ["upper-head"],
    );
    const headMaterialization = materializationOf(secondDispatched[0]!);
    assert.equal(headMaterialization.baseCommit, integratedHead);
    assert.equal(
      headMaterialization.upstreamIntegrationHead,
      integratedHead,
    );
    assert.equal(headMaterialization.upstreamAdoptedCommit, reviewedCommit);
    assert.equal(itemById(repo, "upper-head").status, "completed");

    // Reuse verification accepts the recorded adopted lineage on a later run.
    const replay = await runQueue(repo, { runner });
    assert.equal(replay.dispatched, 0);
    assert.equal(itemById(repo, "upper-head").materialization!.baseCommit, integratedHead);
  });
});

test("tampered adopted lineage fails closed before a dependant dispatch", async () => {
  await withRepo(async (repo) => {
    addRootPlan(repo, "root");
    addDependentPlan(repo, "upper", "root");
    await runQueue(repo, {
      runner: async (request) => {
        writeManifestForRequest(repo, request, {
          runId: "run-blocked-root",
          status: "blocked",
        });
        return { exitCode: 1, status: "blocked", runId: "run-blocked-root" };
      },
    });
    const reviewedCommit = commitFile(
      repo,
      "reviewed.txt",
      "reviewed\n",
      "reviewed",
    );
    const evidence = writeEvidence(repo, "evidence.json", {
      reviewedCommit,
    });
    adopt(repo, "root", {
      runId: "run-blocked-root",
      artifact: reviewedCommit,
      evidencePath: evidence.path,
    });
    await runQueue(repo, {
      runner: async (request) => {
        const runId = `run-${request.item.id}`;
        writeManifestForRequest(repo, request, {
          runId,
          status: "completed",
          integrationHead: materializationOf(request).baseCommit,
        });
        return { exitCode: 0, status: "completed", runId };
      },
    });
    const recorded = itemById(repo, "upper").materialization;
    assert.ok(recorded);
    assert.equal(recorded.baseCommit, reviewedCommit);

    // Change only the persisted resolution identity. The recorded artifact
    // still points at the original reviewed commit, so reuse must fail closed.
    const document = loadQueue(repo);
    const root = document.items.find((item) => item.id === "root")!;
    root.resolution!.reviewedCommit = root.resolution!.baseCommit;
    const upper = document.items.find((item) => item.id === "upper")!;
    upper.status = "blocked";
    upper.reason = "force reuse verification";
    saveQueue(repo, document);
    retryQueueItem(repo, "upper");

    let runnerCalls = 0;
    const summary = await runQueue(repo, {
      runner: async () => {
        runnerCalls += 1;
        return { exitCode: 0, status: "completed", runId: "must-not-run" };
      },
    });
    assert.equal(runnerCalls, 0);
    assert.equal(summary.dispatched, 0);
    const blocked = itemById(repo, "upper");
    assert.equal(blocked.status, "blocked");
    assert.match(
      blocked.reason!,
      /plan materialization verification failed: .*adopted commit .* does not match the adoption resolution reviewed commit/,
    );
    assert.deepEqual(blocked.materialization, recorded);
  });
});

// ---------------------------------------------------------------------------
// Queue file parsing integrity
// ---------------------------------------------------------------------------

test("a persisted resolution must stay versioned, item-bound and completed", async () => {
  await withRepo(async (repo) => {
    await blockedRoot(repo, "root", "run-blocked-root");
    const reviewedCommit = commitFile(
      repo,
      "reviewed.txt",
      "reviewed\n",
      "reviewed",
    );
    const evidence = writeEvidence(repo, "evidence.json");
    adopt(repo, "root", {
      runId: "run-blocked-root",
      artifact: reviewedCommit,
      evidencePath: evidence.path,
    });

    const pristine = readFileSync(queuePaths(repo).queuePath, "utf8");
    const raw = JSON.parse(pristine) as {
      items: Array<Record<string, unknown>>;
    };
    const resolution = raw.items[0]!.resolution as Record<string, unknown>;
    assert.equal(resolution.kind, "manual-adoption");

    const rejectWith = (
      mutate: (item: Record<string, unknown>) => void,
      pattern: RegExp,
    ) => {
      const document = JSON.parse(pristine) as {
        items: Array<Record<string, unknown>>;
      };
      mutate(document.items[0]!);
      writeFileSync(
        queuePaths(repo).queuePath,
        `${JSON.stringify(document, null, 2)}\n`,
        "utf8",
      );
      assert.throws(() => loadQueue(repo), pattern);
    };

    rejectWith((item) => {
      (item.resolution as Record<string, unknown>).version = 2;
    }, /version must be 1/);
    rejectWith((item) => {
      (item.resolution as Record<string, unknown>).queueItemId = "other";
    }, /queueItemId must equal the queue item id/);
    rejectWith((item) => {
      (item.resolution as Record<string, unknown>).sourceManifestStatus =
        "completed";
    }, /sourceManifestStatus must be blocked or interrupted/);
    rejectWith((item) => {
      (item.resolution as Record<string, unknown>).reviewedCommit = "abc";
    }, /reviewedCommit must be a full git commit hash/);
    rejectWith((item) => {
      item.status = "blocked";
    }, /resolution requires a completed queue item/);
    rejectWith((item) => {
      (item.resolution as Record<string, unknown>).approvedAt = "not-a-date";
    }, /approvedAt must be an ISO-8601 timestamp/);
    rejectWith((item) => {
      (item.resolution as Record<string, unknown>).sourceRunId = "run-other";
    }, /sourceRunId must equal the item lastRunId/);

    // A parse failure never rewrites the queue document.
    assert.throws(
      () => loadQueue(repo),
      QueueValidationError,
    );
  });
});

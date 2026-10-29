import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildEvidenceBundle,
  evidenceBundlePath,
  EvidenceBundleInputError,
  EvidenceBundleManifestError,
  EvidenceBundleNotTerminalError,
  MAX_EVIDENCE_PATH_LENGTH,
  runManifestHash,
  serializeEvidenceBundle,
  writeEvidenceBundle,
  type BuildEvidenceBundleOptions,
  type EvidenceRepositoryFacts,
} from "../src/supervisor/evidence-bundle.js";
import {
  createCostObservation,
  createCostTruth,
  createFailureRecord,
  type CostTruth,
  type FailureRecord,
} from "../src/failures.js";
import type {
  PathAuditRecord,
  RunManifest,
  RunTaskState,
  WorkspaceBoundaryRecord,
} from "../src/supervisor/types.js";
import type { WorkerProcessRecord } from "../src/agents/process-tree.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const CONTRACTS_HASH = "d".repeat(64);
const BASE_COMMIT = "a".repeat(40);
const RESULT_COMMIT = "b".repeat(40);
const INTEGRATION_HEAD = "c".repeat(40);
const DIGEST_BEFORE = "1".repeat(64);
const DIGEST_AFTER = "2".repeat(64);
const CREATED_AT = "2026-10-01T00:00:00.000Z";
const UPDATED_AT = "2026-10-01T01:00:00.000Z";
const OBSERVED_AT = "2026-10-01T00:30:00.000Z";
const FACTS: EvidenceRepositoryFacts = {
  contractsHash: CONTRACTS_HASH,
  integrationHead: INTEGRATION_HEAD,
};

function costFixture(): CostTruth {
  return createCostTruth({
    observations: [
      createCostObservation({
        sessionId: "session-1",
        amount: 1.25,
        currency: "USD",
        source: "cli",
        usage: {
          inputTokens: 100,
          outputTokens: 50,
          cacheCreationInputTokens: 0,
          cacheReadInputTokens: 25,
        },
      }),
    ],
  });
}

function pathAuditFixture(
  overrides: Partial<PathAuditRecord> = {},
): PathAuditRecord {
  return {
    attempt: 0,
    observedAt: OBSERVED_AT,
    exitCode: 0,
    changedPaths: ["src/task-a.ts"],
    outsideWritePaths: [],
    ...overrides,
  };
}

function processTreeFixture(
  overrides: Partial<WorkerProcessRecord> = {},
): WorkerProcessRecord {
  return {
    version: 1,
    host: "test-host",
    pid: 4242,
    pgid: 4242,
    captureSource: "ps-exact",
    captureSupport: "posix-process-group",
    cleanupReason: "child-close",
    cleanupState: "clean",
    cleanupCompleteness: "complete",
    durableRecoveryCompleteness: "complete",
    signals: [],
    residualMembers: [],
    residualCount: 0,
    startedAt: OBSERVED_AT,
    closedAt: "2026-10-01T00:31:00.000Z",
    cleanedAt: "2026-10-01T00:31:01.000Z",
    ...overrides,
  };
}

function boundaryFixture(
  overrides: Partial<WorkspaceBoundaryRecord> = {},
): WorkspaceBoundaryRecord {
  return {
    version: 1,
    status: "clean",
    enforcement: "guard-only",
    capturedAt: OBSERVED_AT,
    comparedAt: "2026-10-01T00:32:00.000Z",
    changes: [],
    ...overrides,
  };
}

function acceptedTask(
  taskId: string,
  overrides: Partial<RunTaskState> = {},
): RunTaskState {
  return {
    taskId,
    status: "accepted",
    accepted: true,
    resultCommit: RESULT_COMMIT,
    cost: costFixture(),
    pathAudits: [pathAuditFixture()],
    processTrees: [processTreeFixture()],
    workspaceBoundary: boundaryFixture(),
    ...overrides,
  };
}

function manifestFixture(
  repoRoot: string,
  overrides: Partial<RunManifest> = {},
): RunManifest {
  return {
    version: 1,
    runId: "run-evidence-1",
    planId: "evidence-v0",
    repoRoot,
    contractsPath: join(repoRoot, "contracts.json"),
    contractsHash: CONTRACTS_HASH,
    baseCommit: BASE_COMMIT,
    integrationBranch: "cliyard/integration/evidence-v0",
    integrationHead: INTEGRATION_HEAD,
    status: "completed",
    createdAt: CREATED_AT,
    updatedAt: UPDATED_AT,
    owner: { pid: 4242, host: "test-host" },
    tasks: { "task-a": acceptedTask("task-a") },
    ...overrides,
  };
}

function timeoutFailure(): FailureRecord {
  return createFailureRecord({
    timedOut: true,
    stage: "worker",
    text: "worker timed out after 1000ms",
    retryableHint: true,
    observedAt: OBSERVED_AT,
  });
}

function policyFailure(): FailureRecord {
  return createFailureRecord({
    policyBlocked: true,
    code: "dependency_blocked",
    text: "task dependency blocked",
    retryableHint: false,
    observedAt: OBSERVED_AT,
  });
}

function buildFor(
  repoRoot: string,
  overrides: Partial<RunManifest> = {},
  options: BuildEvidenceBundleOptions = {},
): ReturnType<typeof buildEvidenceBundle> {
  return buildEvidenceBundle(manifestFixture(repoRoot, overrides), options);
}

async function withTempRepo(
  fn: (repo: string) => void | Promise<void>,
): Promise<void> {
  const repo = mkdtempSync(join(tmpdir(), "cliyard-evidence-"));
  try {
    await fn(repo);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const key of Object.keys(value)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
    Object.freeze(value);
  }
  return value;
}

// ---------------------------------------------------------------------------
// Success path
// ---------------------------------------------------------------------------

test("builds a completed bundle from a terminal manifest and repository facts", async () => {
  await withTempRepo((repo) => {
    const manifest = deepFreeze(
      manifestFixture(repo, {
        tasks: { "task-a": acceptedTask("task-a") },
      }),
    );
    const snapshot = structuredClone(manifest);

    const bundle = buildEvidenceBundle(manifest, { facts: FACTS });

    assert.equal(bundle.version, 1);
    assert.equal(bundle.generatedAt, UPDATED_AT);
    assert.deepEqual(bundle.run, {
      runId: "run-evidence-1",
      planId: "evidence-v0",
      status: "completed",
      terminal: true,
      createdAt: CREATED_AT,
      updatedAt: UPDATED_AT,
    });
    assert.equal(bundle.authority.taskAuthority, "run-manifest");
    assert.equal(bundle.authority.grantsAcceptance, false);
    assert.equal(bundle.authority.authorizesMerge, false);
    assert.equal(bundle.authority.replacesVerification, false);

    assert.equal(
      bundle.authority.manifest.path,
      ".cliyard/runs/run-evidence-1.json",
    );
    const expectedManifestHash = createHash("sha256")
      .update(`${JSON.stringify(manifest, null, 2)}\n`, "utf8")
      .digest("hex");
    assert.equal(bundle.authority.manifest.hash, expectedManifestHash);
    assert.equal(runManifestHash(manifest), expectedManifestHash);
    assert.equal(bundle.authority.manifest.algorithm, "sha256");

    assert.equal(bundle.authority.contracts.path, manifest.contractsPath);
    assert.equal(bundle.authority.contracts.hash, CONTRACTS_HASH);
    assert.equal(bundle.authority.contracts.observedHash, CONTRACTS_HASH);
    assert.equal(bundle.authority.contracts.verified, true);

    assert.deepEqual(bundle.repository, {
      baseCommit: BASE_COMMIT,
      integrationBranch: "cliyard/integration/evidence-v0",
      integrationHead: INTEGRATION_HEAD,
      observedIntegrationHead: INTEGRATION_HEAD,
      integrationHeadVerified: true,
    });

    assert.equal(bundle.tasks.length, 1);
    const task = bundle.tasks[0]!;
    assert.equal(task.taskId, "task-a");
    assert.equal(task.status, "accepted");
    assert.equal(task.verdict, "accepted");
    assert.equal(task.accepted, true);
    assert.equal(task.resultCommit, RESULT_COMMIT);
    assert.deepEqual(task.pathAudits, [pathAuditFixture()]);
    assert.equal(task.processTrees[0]!.cleanupState, "clean");
    assert.equal(task.workspaceBoundary?.status, "clean");
    assert.equal(task.cost?.amount, 1.25);
    assert.equal(task.cost?.currency, "USD");

    assert.equal(bundle.cost.state, "cli-estimated");
    assert.equal(bundle.cost.source, "cli");
    assert.equal(bundle.cost.authoritative, false);
    assert.equal(bundle.cost.amount, 1.25);
    assert.equal(bundle.cost.currency, "USD");
    assert.deepEqual(bundle.cost.missing, []);

    assert.deepEqual(bundle.missing, []);
    assert.equal(bundle.humanReviewRequired, true);
    assert.equal(bundle.nextAction, "human-review");

    // Pure projection: frozen input is untouched.
    assert.deepEqual(manifest, snapshot);
  });
});

// ---------------------------------------------------------------------------
// Terminal failure and interrupted states
// ---------------------------------------------------------------------------

test("projects blocked failures with a bounded next action", async () => {
  await withTempRepo((repo) => {
    const blocked = buildFor(repo, {
      status: "blocked",
      tasks: {
        "task-a": acceptedTask("task-a"),
        "task-b": {
          taskId: "task-b",
          status: "rejected",
          accepted: false,
          failure: timeoutFailure(),
          cost: costFixture(),
        },
      },
    });

    assert.equal(blocked.run.status, "blocked");
    assert.equal(blocked.humanReviewRequired, true);
    assert.equal(blocked.nextAction, "resume");
    const rejected = blocked.tasks.find((task) => task.taskId === "task-b")!;
    assert.equal(rejected.status, "rejected");
    assert.equal(rejected.verdict, "rejected");
    assert.equal(rejected.accepted, false);
    assert.equal(rejected.failure?.category, "timeout");
    assert.equal(rejected.failure?.retryableHint, true);
    assert.match(rejected.failure?.message ?? "", /timed out/);
    assert.deepEqual(blocked.missing, []);

    const policyBlocked = buildFor(repo, {
      status: "blocked",
      tasks: {
        "task-a": {
          taskId: "task-a",
          status: "blocked",
          accepted: false,
          failure: policyFailure(),
        },
      },
    });
    assert.equal(policyBlocked.nextAction, "inspect-failure");
    assert.equal(policyBlocked.tasks[0]!.verdict, "blocked");
  });
});

test("supports interrupted runs without inventing completion", async () => {
  await withTempRepo((repo) => {
    const bundle = buildFor(repo, {
      status: "interrupted",
      tasks: {
        "task-a": {
          taskId: "task-a",
          status: "running",
          accepted: false,
        },
      },
    });

    assert.equal(bundle.run.status, "interrupted");
    assert.equal(bundle.run.terminal, true);
    assert.equal(bundle.tasks[0]!.verdict, "unresolved");
    assert.equal(bundle.tasks[0]!.accepted, false);
    assert.deepEqual(bundle.missing, ["task.task-a.terminalStatus"]);
    assert.equal(bundle.nextAction, "resume");
    assert.equal(bundle.humanReviewRequired, true);
  });
});

// ---------------------------------------------------------------------------
// Missing required evidence
// ---------------------------------------------------------------------------

test("reports missing required evidence instead of treating a run as complete", async () => {
  await withTempRepo((repo) => {
    const incomplete = buildFor(repo, {
      tasks: {
        "task-a": {
          taskId: "task-a",
          status: "accepted",
          accepted: true,
        },
      },
    });
    assert.deepEqual(incomplete.missing, [
      "task.task-a.cost",
      "task.task-a.pathAudits",
      "task.task-a.processTrees",
      "task.task-a.resultCommit",
      "task.task-a.workspaceBoundary",
    ]);
    assert.equal(incomplete.nextAction, "needs-human");
    assert.equal(incomplete.cost.state, "unavailable");
    assert.equal(incomplete.cost.amount, null);
    assert.equal(incomplete.cost.usage, null);
    assert.ok(incomplete.cost.missing.includes("cost.observation"));
    assert.ok(incomplete.cost.missing.includes("cost.amount"));
    assert.ok(incomplete.cost.missing.includes("cost.usage"));

    const onlyResult = buildFor(repo, {
      tasks: {
        "task-a": acceptedTask("task-a", {
          pathAudits: undefined,
          processTrees: undefined,
          workspaceBoundary: undefined,
          cost: undefined,
        }),
      },
    });
    assert.deepEqual(onlyResult.missing, [
      "task.task-a.cost",
      "task.task-a.pathAudits",
      "task.task-a.processTrees",
      "task.task-a.workspaceBoundary",
    ]);
    // Missing observations stay visible, but a completed run with an
    // accepted result still routes to human review rather than auto-merge.
    assert.equal(onlyResult.nextAction, "human-review");

    const unexplained = buildFor(repo, {
      status: "blocked",
      tasks: {
        "task-a": acceptedTask("task-a"),
        "task-b": {
          taskId: "task-b",
          status: "rejected",
          accepted: false,
        },
      },
    });
    assert.deepEqual(unexplained.missing, ["task.task-b.failure"]);
    assert.equal(unexplained.nextAction, "needs-human");

    const empty = buildFor(repo, { tasks: {} });
    assert.deepEqual(empty.missing, ["run.tasks"]);
    assert.equal(empty.nextAction, "needs-human");
  });
});

// ---------------------------------------------------------------------------
// Integrity observations
// ---------------------------------------------------------------------------

test("contract, integration, boundary and cleanup problems force human review", async () => {
  await withTempRepo((repo) => {
    const contractMismatch = buildFor(
      repo,
      {},
      {
        facts: {
          contractsHash: "e".repeat(64),
          integrationHead: INTEGRATION_HEAD,
        },
      },
    );
    assert.equal(contractMismatch.authority.contracts.verified, false);
    assert.equal(contractMismatch.nextAction, "needs-human");

    const headMismatch = buildFor(
      repo,
      {},
      {
        facts: {
          contractsHash: CONTRACTS_HASH,
          integrationHead: "f".repeat(40),
        },
      },
    );
    assert.equal(headMismatch.repository.integrationHeadVerified, false);
    assert.equal(headMismatch.nextAction, "needs-human");

    const boundaryViolation = buildFor(repo, {
      tasks: {
        "task-a": acceptedTask("task-a", {
          workspaceBoundary: boundaryFixture({
            status: "violation",
            changes: [
              {
                rootIndex: 0,
                change: "modified",
                kind: "file",
                path: "src/outside.ts",
                beforeDigest: DIGEST_BEFORE,
                afterDigest: DIGEST_AFTER,
              },
            ],
          }),
        }),
      },
    });
    assert.equal(
      boundaryViolation.tasks[0]!.workspaceBoundary?.status,
      "violation",
    );
    assert.deepEqual(
      boundaryViolation.tasks[0]!.workspaceBoundary?.changes,
      [
        {
          rootIndex: 0,
          change: "modified",
          kind: "file",
          path: "src/outside.ts",
          beforeDigest: DIGEST_BEFORE,
          afterDigest: DIGEST_AFTER,
        },
      ],
    );
    assert.equal(boundaryViolation.nextAction, "needs-human");

    const cleanupFailed = buildFor(repo, {
      tasks: {
        "task-a": acceptedTask("task-a", {
          cleanupFailure: createFailureRecord({
            stage: "worker",
            text: "process cleanup failed",
            observedAt: OBSERVED_AT,
          }),
          processTrees: [processTreeFixture({ cleanupState: "failed" })],
        }),
      },
    });
    assert.equal(cleanupFailed.nextAction, "needs-human");

    const contradictory = buildFor(repo, {
      tasks: {
        "task-a": acceptedTask("task-a", { failure: timeoutFailure() }),
      },
    });
    assert.equal(contradictory.nextAction, "needs-human");
  });
});

// ---------------------------------------------------------------------------
// Malformed input and bounds
// ---------------------------------------------------------------------------

test("fails closed on malformed manifests, records and inputs", async () => {
  await withTempRepo((repo) => {
    const base = manifestFixture(repo);
    const manifest = (value: unknown): RunManifest => value as RunManifest;

    assert.throws(
      () => buildEvidenceBundle({ ...base, status: "running" }),
      EvidenceBundleNotTerminalError,
    );
    assert.throws(
      () => buildEvidenceBundle(manifest({ ...base, version: 2 })),
      EvidenceBundleManifestError,
    );
    assert.throws(
      () => buildEvidenceBundle(manifest({ ...base, status: "done" })),
      EvidenceBundleManifestError,
    );
    assert.throws(
      () => buildEvidenceBundle(manifest({ ...base, contractsHash: "nope" })),
      EvidenceBundleManifestError,
    );
    assert.throws(
      () => buildEvidenceBundle(manifest({ ...base, baseCommit: "abc" })),
      EvidenceBundleManifestError,
    );
    assert.throws(
      () => buildEvidenceBundle(manifest({ ...base, owner: null })),
      EvidenceBundleManifestError,
    );
    assert.throws(
      () =>
        buildEvidenceBundle(
          manifest({
            ...base,
            tasks: {
              "task-a": { ...acceptedTask("task-a"), status: "blocked" },
            },
          }),
        ),
      EvidenceBundleManifestError,
    );
    assert.throws(
      () =>
        buildEvidenceBundle(
          manifest({
            ...base,
            tasks: {
              "task-a": { ...acceptedTask("task-a"), status: "unknown" },
            },
          }),
        ),
      EvidenceBundleManifestError,
    );
    assert.throws(
      () =>
        buildEvidenceBundle(
          manifest({
            ...base,
            tasks: {
              "task-a": {
                taskId: "task-a",
                status: "rejected",
                accepted: false,
                failure: {
                  version: 1,
                  category: "not-a-category",
                  stage: "worker",
                  message: "bad",
                  observedAt: OBSERVED_AT,
                },
              },
            },
          }),
        ),
      EvidenceBundleManifestError,
    );
    assert.throws(
      () =>
        buildEvidenceBundle(
          manifest({
            ...base,
            tasks: {
              "task-a": acceptedTask("task-a", {
                pathAudits: [
                  {
                    ...pathAuditFixture(),
                    changedPaths: "not-an-array",
                  } as unknown as PathAuditRecord,
                ],
              }),
            },
          }),
        ),
      EvidenceBundleManifestError,
    );
    assert.throws(
      () =>
        buildEvidenceBundle(
          manifest({
            ...base,
            tasks: {
              "task-a": acceptedTask("task-a", {
                processTrees: [
                  {
                    ...processTreeFixture(),
                    captureSource: "bogus",
                  } as unknown as WorkerProcessRecord,
                ],
              }),
            },
          }),
        ),
      EvidenceBundleManifestError,
    );
    assert.throws(
      () =>
        buildEvidenceBundle(
          manifest({
            ...base,
            tasks: {
              "task-a": acceptedTask("task-a", {
                workspaceBoundary: boundaryFixture({
                  changes: [
                    {
                      rootIndex: 0,
                      change: "modified",
                      kind: "file",
                      path: "../escape",
                    },
                  ],
                }),
              }),
            },
          }),
        ),
      EvidenceBundleManifestError,
    );
    assert.throws(
      () =>
        buildEvidenceBundle(manifest(base), {
          facts: { contractsHash: "not-a-hash" },
        }),
      EvidenceBundleInputError,
    );
    assert.throws(
      () =>
        buildEvidenceBundle(
          manifest(base),
          null as unknown as BuildEvidenceBundleOptions,
        ),
      EvidenceBundleInputError,
    );

    const tooManyTasks: Record<string, RunTaskState> = {};
    for (let index = 0; index < 257; index++) {
      tooManyTasks[`task-${index}`] = {
        taskId: `task-${index}`,
        status: "ready",
        accepted: false,
      };
    }
    assert.throws(
      () => buildEvidenceBundle(manifest({ ...base, tasks: tooManyTasks })),
      EvidenceBundleManifestError,
    );

    assert.throws(
      () =>
        buildEvidenceBundle(
          manifest({
            ...base,
            tasks: {
              a: acceptedTask("duplicate"),
              b: acceptedTask("duplicate"),
            },
          }),
        ),
      EvidenceBundleManifestError,
    );

    assert.throws(
      () =>
        buildEvidenceBundle(
          manifest({
            ...base,
            tasks: {
              "task-a": acceptedTask("task-a", {
                pathAudits: [
                  pathAuditFixture({
                    changedPaths: ["x".repeat(MAX_EVIDENCE_PATH_LENGTH + 1)],
                  }),
                ],
              }),
            },
          }),
        ),
      EvidenceBundleManifestError,
    );
  });
});

test("keeps the output path inside the evidence directory", async () => {
  await withTempRepo((repo) => {
    const expected = join(
      repo,
      ".cliyard",
      "evidence",
      "run-evidence-1.json",
    );
    assert.equal(evidenceBundlePath(repo, "run-evidence-1"), expected);
    assert.throws(() => evidenceBundlePath(repo, "../escape"));
    assert.throws(() => evidenceBundlePath(repo, "bad/id"));
    assert.throws(() => evidenceBundlePath(repo, ""));
    assert.throws(() => evidenceBundlePath(repo, "x".repeat(129)));

    const base = manifestFixture(repo);
    assert.throws(
      () => writeEvidenceBundle(join(repo, "other"), base),
      EvidenceBundleManifestError,
    );
    assert.equal(existsSync(join(repo, ".cliyard")), false);

    assert.throws(
      () =>
        writeEvidenceBundle(
          repo,
          manifestFixture(repo, { runId: "../escape" }),
        ),
      EvidenceBundleManifestError,
    );
  });
});

// ---------------------------------------------------------------------------
// Deterministic bytes and idempotent atomic writes
// ---------------------------------------------------------------------------

test("serializes deterministically and rewrites idempotently", async () => {
  await withTempRepo((repo) => {
    const manifest = manifestFixture(repo, {
      tasks: { "task-a": acceptedTask("task-a") },
    });
    const first = buildEvidenceBundle(manifest, { facts: FACTS });
    const second = buildEvidenceBundle(manifest, { facts: FACTS });
    const bytes = serializeEvidenceBundle(first);
    assert.equal(serializeEvidenceBundle(second), bytes);
    assert.deepEqual(JSON.parse(bytes), first);
    assert.ok(bytes.endsWith("\n"));

    const explicit = buildEvidenceBundle(manifest, {
      facts: FACTS,
      generatedAt: "2026-10-02T00:00:00Z",
    });
    assert.equal(explicit.generatedAt, "2026-10-02T00:00:00Z");

    const wrote = writeEvidenceBundle(repo, manifest, { facts: FACTS });
    assert.equal(wrote.written, true);
    assert.equal(wrote.path, evidenceBundlePath(repo, manifest.runId));
    assert.equal(wrote.byteLength, Buffer.byteLength(bytes, "utf8"));
    assert.equal(readFileSync(wrote.path, "utf8"), bytes);

    const rewrote = writeEvidenceBundle(repo, manifest, { facts: FACTS });
    assert.equal(rewrote.written, false);
    assert.equal(readFileSync(rewrote.path, "utf8"), bytes);
    assert.deepEqual(
      readdirSync(join(repo, ".cliyard", "evidence")),
      ["run-evidence-1.json"],
    );

    writeFileSync(wrote.path, "corrupt\n", "utf8");
    const repaired = writeEvidenceBundle(repo, manifest, { facts: FACTS });
    assert.equal(repaired.written, true);
    assert.equal(readFileSync(repaired.path, "utf8"), bytes);
    assert.deepEqual(
      readdirSync(join(repo, ".cliyard", "evidence")),
      ["run-evidence-1.json"],
    );
  });
});

// ---------------------------------------------------------------------------
// Credential-free projection
// ---------------------------------------------------------------------------

test("does not copy prompts, transcripts, environment dumps or secrets", async () => {
  await withTempRepo((repo) => {
    const secrets = [
      "sk-ABCDEFGH12345678",
      "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345",
      "xoxb-1234567890-abcdefghij",
      "Bearer abcdefghijklmnop",
      "api_key=supersecretvalue",
      "password=supersecretvalue",
      "AKIAABCDEFGHIJKLMNOP",
      "TOP SECRET",
    ];

    const baseCost = costFixture();
    const secretCost: CostTruth = {
      ...baseCost,
      observations: baseCost.observations.map((observation) => ({
        ...observation,
        sessionId: "session sk-ABCDEFGH12345678",
        note: "note xoxb-1234567890-abcdefghij",
      })),
      missing: ["cost.note api_key=supersecretvalue"],
    };

    const task = acceptedTask("task-a", {
      reason: "failed api_key=supersecretvalue",
      failure: {
        version: 1,
        category: "provider_auth",
        stage: "provider",
        code: "sk-ABCDEFGH12345678",
        message: "provider rejected Bearer abcdefghijklmnop",
        observedAt: OBSERVED_AT,
        retryableHint: false,
      },
      cleanupFailure: {
        version: 1,
        category: "unknown",
        stage: "worker",
        code: "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345",
        message: "cleanup failed password=supersecretvalue",
        observedAt: OBSERVED_AT,
      },
      cost: secretCost,
      pathAudits: [
        pathAuditFixture({
          exitCode: 1,
          changedPaths: ["src/sk-ABCDEFGH12345678.ts"],
          changedPathsError: "path scan failed access_token=supersecretvalue",
        }),
      ],
      processTrees: [
        processTreeFixture({
          cleanupState: "failed",
          detail: "process detail AKIAABCDEFGHIJKLMNOP",
          signals: [
            {
              signal: "SIGTERM",
              scope: "process-group",
              at: OBSERVED_AT,
              result: "sent",
              detail: "signal failed Bearer abcdefghijklmnop",
            },
          ],
        }),
      ],
      workspaceBoundary: boundaryFixture({
        status: "violation",
        error: "boundary failed api_key=supersecretvalue",
        changes: [
          {
            rootIndex: 0,
            change: "modified",
            kind: "file",
            path: "src/ok.ts",
            beforeDigest: DIGEST_BEFORE,
            afterDigest: DIGEST_AFTER,
          },
        ],
      }),
    });
    const unknownTaskFields = task as unknown as Record<string, unknown>;
    unknownTaskFields.prompt = "TOP SECRET prompt sk-ABCDEFGH12345678";
    unknownTaskFields.transcript = "TOP SECRET transcript";
    unknownTaskFields.environment = { TOKEN: "TOP SECRET env" };

    const manifest = manifestFixture(repo, {
      tasks: { "task-a": task },
    }) as unknown as Record<string, unknown>;
    manifest.prompt = "TOP SECRET manifest prompt";

    const bundle = buildEvidenceBundle(manifest as unknown as RunManifest);
    const serialized = serializeEvidenceBundle(bundle);

    for (const secret of secrets) {
      assert.equal(
        serialized.includes(secret),
        false,
        `bundle leaked secret: ${secret}`,
      );
    }
    assert.ok(serialized.includes("[redacted]"));
    assert.equal("prompt" in bundle.tasks[0]!, false);
    assert.equal("transcript" in bundle.tasks[0]!, false);
    assert.equal("environment" in bundle.tasks[0]!, false);
    assert.match(
      bundle.tasks[0]!.failure?.message ?? "",
      /provider rejected Bearer \[redacted\]/,
    );
    assert.match(
      bundle.tasks[0]!.reason ?? "",
      /api_key=\[redacted\]/,
    );
    assert.ok(bundle.tasks[0]!.processTrees[0]!.detail?.includes("[redacted]"));
    assert.ok(
      bundle.tasks[0]!.workspaceBoundary?.error?.includes("[redacted]"),
    );
  });
});

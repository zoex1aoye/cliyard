import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, sep } from "node:path";
import {
  queueEventJournalPath,
  type QueueControlEvent,
} from "../src/orchestration/event-journal.js";
import {
  loadQueue,
  queuePaths,
  type QueueDocument,
} from "../src/orchestration/queue-store.js";
import {
  defaultLedgerPath,
  loadLedger,
  type Ledger,
} from "../src/persistence/ledger.js";
import {
  loadRunManifest,
  runManifestPath,
  supervisorPaths,
} from "../src/supervisor/store.js";
import type {
  ActiveRunPointer,
  RunManifest,
} from "../src/supervisor/types.js";
import {
  FACT_KINDS,
  SequenceConflictError,
  StateStore,
  StateStoreCorruptionError,
  createMemoryStateStoreDriver,
  type EvidenceRef,
} from "../src/statestore/store.js";
import {
  MAX_DOMAIN_EVIDENCE_BYTES,
  MemoryDomainEvidenceStore,
  STATE_STORE_DOMAIN_MEDIA_TYPE,
  StateStoreDomainWriter,
  StateStoreLegacyDriftError,
  StateStoreMigrationRequiredError,
  StateStoreWriteValidationError,
  canonicalStateStoreJson,
  encodeStateStoreDomainRecord,
  exportStateStoreJson,
  exportStateStoreJsonFiles,
  projectStateStoreDomainRecords,
  readStateStoreDomainRecords,
  sha256Hex,
} from "../src/statestore/write.js";
import {
  createLegacyJsonGuard,
  migrateLegacyJson,
} from "../src/statestore/migrate.js";

const FIXED_NOW = "2026-02-01T00:00:00.000Z";
const MIGRATION_AT = "2026-03-01T00:00:00.000Z";

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

interface Harness {
  store: StateStore;
  evidence: MemoryDomainEvidenceStore;
  writer: StateStoreDomainWriter;
}

function openHarness(
  evidence = new MemoryDomainEvidenceStore(),
): Harness {
  let eventCounter = 0;
  const clock = () => FIXED_NOW;
  const newEventId = () => `test-event-${++eventCounter}`;
  const store = StateStore.open(createMemoryStateStoreDriver(), {
    clock,
    newEventId,
  });
  const writer = new StateStoreDomainWriter({
    store,
    evidence,
    clock,
    newEventId,
    workspaceId: "test",
  });
  return { store, evidence, writer };
}

function withRepo(fn: (repo: string) => void): void {
  const repo = mkdtempSync(join(tmpdir(), "cliyard-statestore-write-"));
  try {
    fn(repo);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2) + "\n", "utf8");
}

/** Every file under `root` with its exact bytes, for no-mutation checks. */
function snapshotTree(root: string): Record<string, string> {
  const snapshot: Record<string, string> = {};
  const walk = (directory: string): void => {
    for (const name of readdirSync(directory).sort()) {
      const path = join(directory, name);
      if (statSync(path).isDirectory()) {
        walk(path);
        continue;
      }
      snapshot[relative(root, path).split(sep).join("/")] = readFileSync(
        path,
        "utf8",
      );
    }
  };
  walk(root);
  return snapshot;
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function runManifest(repoRoot: string): RunManifest {
  return {
    version: 1,
    runId: "run-1",
    planId: "plan-1",
    repoRoot,
    contractsPath: join(repoRoot, "contracts.json"),
    contractsHash: "a".repeat(64),
    baseCommit: "b".repeat(40),
    integrationBranch: "cliyard/integration/run-1",
    integrationHead: "c".repeat(40),
    status: "running",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:01:00.000Z",
    owner: { pid: 4242, host: "test-host" },
    tasks: {
      task: {
        taskId: "task",
        status: "running",
        accepted: false,
      },
    },
  };
}

function activePointer(): ActiveRunPointer {
  return {
    version: 1,
    runId: "run-1",
    updatedAt: "2026-01-01T00:01:30.000Z",
  };
}

function queueDocument(repoRoot: string): QueueDocument {
  return {
    version: 1,
    updatedAt: "2026-01-01T00:02:00.000Z",
    items: [
      {
        id: "item-1",
        contractsPath: join(repoRoot, "contracts.json"),
        contractsHash: "a".repeat(64),
        worker: "claude",
        model: "subscription-model",
        status: "pending",
        attempts: 0,
        maxAttempts: 3,
        dependsOn: [],
        runIds: [],
        nextAction: "start",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
    ],
  };
}

function ledgerDocument(repoRoot: string): Ledger {
  return {
    path: defaultLedgerPath(repoRoot),
    tasks: {
      task: {
        taskId: "task",
        status: "accepted",
        repairCount: 0,
        contract: {
          path: join(repoRoot, "contracts.json"),
          hash: "a".repeat(64),
        } as never,
        events: [
          {
            at: "2026-01-01T00:03:00.000Z",
            type: "task.accepted",
            status: "accepted",
          },
        ],
        sessionIds: ["session-1"],
        verdict: "accepted",
      },
    },
  };
}

function auditEventFixtures(): QueueControlEvent[] {
  return [
    {
      version: 1,
      eventId: "event-1",
      at: "2026-01-01T00:04:00.000Z",
      type: "run.started",
      runId: "run-1",
    },
    {
      version: 1,
      eventId: "event-2",
      at: "2026-01-01T00:05:00.000Z",
      type: "run.completed",
      runId: "run-1",
      status: "completed",
    },
  ];
}

interface LegacyFixture {
  manifest: RunManifest;
  active: ActiveRunPointer;
  queue: QueueDocument;
  ledger: Ledger;
  events: QueueControlEvent[];
}

/** Write the legacy JSON authority directly, as the current writers would. */
function seedLegacyRepo(repo: string): LegacyFixture {
  const fixture: LegacyFixture = {
    manifest: runManifest(repo),
    active: activePointer(),
    queue: queueDocument(repo),
    ledger: ledgerDocument(repo),
    events: auditEventFixtures(),
  };
  writeJson(
    runManifestPath(repo, fixture.manifest.runId),
    fixture.manifest,
  );
  writeJson(supervisorPaths(repo).activePath, fixture.active);
  writeJson(queuePaths(repo).queuePath, fixture.queue);
  writeJson(defaultLedgerPath(repo), {
    path: defaultLedgerPath(repo),
    tasks: fixture.ledger.tasks,
  });
  const journal = queueEventJournalPath(repo);
  mkdirSync(dirname(journal), { recursive: true });
  writeFileSync(
    journal,
    fixture.events.map((event) => `${JSON.stringify(event)}\n`).join(""),
    "utf8",
  );
  return fixture;
}

function expectedLedgerExport(repo: string): Ledger {
  return {
    path: ".cliyard/ledger.json",
    tasks: loadLedger(defaultLedgerPath(repo)).tasks,
  };
}

// ---------------------------------------------------------------------------
// Typed append
// ---------------------------------------------------------------------------

test("typed append stores references, not documents, and projects the latest state", () => {
  const harness = openHarness();
  const { store, evidence, writer } = harness;
  const repo = "/fixture/repo";
  const manifest = runManifest(repo);
  const active = activePointer();
  const queue = queueDocument(repo);
  const ledger = ledgerDocument(repo);

  const started = writer.appendRunManifest(manifest);
  assert.equal(started.createdAttempt, true);
  assert.equal(started.kind, "run.manifest");
  assert.equal(started.domain, "run");
  writer.appendActiveRun(active);
  writer.appendQueue(queue);
  writer.appendLedger(ledger);
  for (const event of auditEventFixtures()) {
    writer.appendAuditEvent(event);
  }

  // Six logical records, each a start fact plus an evidence fact.
  const facts = store.exportFacts();
  assert.equal(facts.length, 12);
  for (const fact of facts) {
    assert.ok(
      (FACT_KINDS as readonly string[]).includes(fact.kind),
      `unexpected fact kind ${fact.kind}`,
    );
    assert.ok(
      Buffer.byteLength(JSON.stringify(fact.payload), "utf8") < 2_048,
      "domain documents must never enter the fact payload",
    );
  }
  const domainRows = store
    .snapshot()
    .evidence.filter(
      (row) => row.mediaType === STATE_STORE_DOMAIN_MEDIA_TYPE,
    );
  assert.equal(domainRows.length, 6);
  for (const row of domainRows) {
    assert.ok(row.byteLength > 0);
    assert.ok(row.byteLength <= MAX_DOMAIN_EVIDENCE_BYTES);
  }

  const records = readStateStoreDomainRecords({ store, evidence });
  assert.deepEqual(
    records.map((record) => record.kind),
    [
      "run.manifest",
      "run.active",
      "queue.document",
      "ledger.document",
      "audit-event.recorded",
      "audit-event.recorded",
    ],
  );
  for (const record of records) {
    assert.equal(record.json, canonicalStateStoreJson(record.envelope));
    assert.equal(record.contentHash, sha256Hex(record.json));
    assert.equal(record.byteLength, Buffer.byteLength(record.json, "utf8"));
  }

  const state = projectStateStoreDomainRecords(records);
  assert.deepEqual(state.runs, [manifest]);
  assert.deepEqual(state.activeRun, active);
  assert.deepEqual(state.queue, queue);
  assert.deepEqual(state.ledger, ledger);
  assert.deepEqual(state.auditEvents, auditEventFixtures());

  // A newer revision wins in the projection but both remain addressed.
  const updatedQueue: QueueDocument = {
    ...queue,
    updatedAt: "2026-01-01T00:06:00.000Z",
    items: [],
  };
  writer.appendQueue(updatedQueue);
  const afterUpdate = readStateStoreDomainRecords({ store, evidence });
  const projected = projectStateStoreDomainRecords(afterUpdate);
  assert.deepEqual(projected.queue, updatedQueue);
  assert.equal(
    afterUpdate.filter((record) => record.kind === "queue.document")
      .length,
    2,
  );

  store.close();
});

test("writer rejects forged records, mismatched identities and stale sequences", () => {
  const harness = openHarness();
  const { store, evidence, writer } = harness;
  const repo = "/fixture/repo";
  const queue = queueDocument(repo);
  const at = "2026-01-01T00:07:00.000Z";

  assert.throws(
    () =>
      encodeStateStoreDomainRecord({
        kind: "run.manifest",
        id: "other-run",
        at,
        payload: runManifest(repo),
      }),
    StateStoreWriteValidationError,
  );
  assert.throws(
    () =>
      encodeStateStoreDomainRecord({
        kind: "run.active",
        id: "not-active",
        at,
        payload: activePointer(),
      }),
    StateStoreWriteValidationError,
  );
  assert.throws(
    () =>
      encodeStateStoreDomainRecord({
        kind: "audit-event.recorded",
        id: "other-event",
        at,
        payload: auditEventFixtures()[0]!,
      }),
    StateStoreWriteValidationError,
  );
  assert.throws(
    () =>
      encodeStateStoreDomainRecord({
        kind: "queue.document",
        id: "queue",
        at: "not-a-timestamp",
        payload: queue,
      }),
    StateStoreWriteValidationError,
  );

  const encoded = encodeStateStoreDomainRecord({
    kind: "queue.document",
    id: "queue",
    at,
    payload: queue,
  });
  assert.throws(
    () =>
      writer.appendRecord({
        ...encoded,
        contentHash: "0".repeat(64),
      }),
    StateStoreWriteValidationError,
  );

  writer.appendQueue(queue);
  assert.throws(
    () => writer.appendQueue(queue, { expectedSeq: 0 }),
    SequenceConflictError,
  );
  // The failed append leaves exactly the initial two facts.
  assert.equal(store.lastSeq, 2);
  assert.equal(
    readStateStoreDomainRecords({ store, evidence }).length,
    1,
  );

  // `expectedSeq` refers to the sequence observed before the call, including
  // the synthesized identity start.
  const cas = openHarness();
  cas.writer.appendQueue(queue, { expectedSeq: 0 });
  assert.equal(cas.store.lastSeq, 2);
  cas.store.close();

  const staleCas = openHarness();
  assert.throws(
    () => staleCas.writer.appendQueue(queue, { expectedSeq: 1 }),
    SequenceConflictError,
  );
  assert.equal(staleCas.store.lastSeq, 0);
  staleCas.store.close();

  // Audit event ids are immutable: identical content is idempotent, a
  // different body under the same id is rejected before appending.
  const event = auditEventFixtures()[0]!;
  writer.appendAuditEvent(event);
  assert.throws(
    () =>
      writer.appendAuditEvent({
        ...event,
        status: "blocked",
      }),
    StateStoreWriteValidationError,
  );
  assert.equal(store.lastSeq, 4);
  assert.doesNotThrow(() => writer.appendAuditEvent(event));
  assert.equal(store.lastSeq, 5);

  store.close();
});

// ---------------------------------------------------------------------------
// Migration and export
// ---------------------------------------------------------------------------

test("one-shot migration imports, verifies hashes, and exports read-only JSON", () => {
  withRepo((repo) => {
    const fixture = seedLegacyRepo(repo);
    const before = snapshotTree(repo);
    const { store, evidence, writer } = openHarness();

    const first = migrateLegacyJson({
      repoRoot: repo,
      writer,
      at: MIGRATION_AT,
    });
    assert.equal(first.status, "imported");
    assert.deepEqual(first.domains, [
      "run",
      "queue",
      "ledger",
      "audit-event",
    ]);
    assert.equal(first.counts.runs, 1);
    assert.equal(first.counts.queueItems, 1);
    assert.equal(first.counts.ledgerTasks, 1);
    assert.equal(first.counts.auditEvents, 2);
    assert.equal(first.counts.malformedAuditLines, 0);
    assert.equal(first.appendedRecords, 6);
    assert.match(first.sourceHash, /^[0-9a-f]{64}$/);
    assert.match(first.contentHash, /^[0-9a-f]{64}$/);
    assert.match(first.importHash, /^[0-9a-f]{64}$/);
    assert.ok(first.markerSeq > 0);

    // Every legacy source existed and is recorded by exact bytes.
    assert.equal(first.sources.length, 5);
    assert.ok(first.sources.every((source) => source.exists));
    assert.deepEqual(
      first.sources.map((source) => source.path).sort(),
      [
        ".cliyard/ledger.json",
        ".cliyard/queue-events/events.jsonl",
        ".cliyard/queue.json",
        ".cliyard/runs/active.json",
        ".cliyard/runs/run-1.json",
      ],
    );

    const second = migrateLegacyJson({
      repoRoot: repo,
      writer,
      at: MIGRATION_AT,
    });
    assert.equal(second.status, "already-imported");
    assert.equal(second.appendedRecords, 0);
    assert.equal(second.sourceHash, first.sourceHash);
    assert.equal(second.contentHash, first.contentHash);
    assert.equal(second.importHash, first.importHash);
    assert.ok(second.markerSeq > 0);

    const exported = exportStateStoreJson({
      store,
      evidence,
      at: FIXED_NOW,
    });
    assert.equal(exported.version, 1);
    assert.equal(exported.readOnly, true);
    assert.equal(exported.exportedAt, FIXED_NOW);
    assert.deepEqual(exported.runs, [
      loadRunManifest(repo, "run-1"),
    ]);
    assert.deepEqual(exported.activeRun, fixture.active);
    assert.deepEqual(exported.queue, loadQueue(repo));
    assert.deepEqual(exported.ledger, expectedLedgerExport(repo));
    assert.deepEqual(exported.auditEvents, fixture.events);
    assert.equal(exported.migrationMarkers.length, 1);
    const marker = exported.migrationMarkers[0]!;
    assert.equal(marker.sourceHash, first.sourceHash);
    assert.equal(marker.contentHash, first.contentHash);
    assert.equal(marker.importHash, first.importHash);
    assert.equal(marker.importedAt, MIGRATION_AT);
    assert.deepEqual(marker.domains, first.domains);

    // File export is the legacy layout, read-only and in memory only.
    const files = exportStateStoreJsonFiles(exported);
    assert.equal(files.length, 5);
    assert.ok(files.every((file) => file.readOnly === true));
    const byPath = new Map(
      files.map((file) => [file.relativePath, file.content]),
    );
    assert.deepEqual(
      JSON.parse(byPath.get(".cliyard/runs/run-1.json")!),
      loadRunManifest(repo, "run-1"),
    );
    assert.deepEqual(
      JSON.parse(byPath.get(".cliyard/runs/active.json")!),
      fixture.active,
    );
    assert.deepEqual(
      JSON.parse(byPath.get(".cliyard/queue.json")!),
      loadQueue(repo),
    );
    assert.deepEqual(
      JSON.parse(byPath.get(".cliyard/ledger.json")!),
      expectedLedgerExport(repo),
    );
    assert.deepEqual(
      byPath
        .get(".cliyard/queue-events/events.jsonl")!
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line)),
      fixture.events,
    );

    // Replay from the fact log is deterministic.
    store.rebuild();
    const rebuilt = exportStateStoreJson({
      store,
      evidence,
      at: FIXED_NOW,
    });
    assert.deepEqual(rebuilt, exported);

    // A fresh process/store against the same JSON imports identically.
    const fresh = openHarness();
    const freshResult = migrateLegacyJson({
      repoRoot: repo,
      writer: fresh.writer,
      at: MIGRATION_AT,
    });
    assert.equal(freshResult.importHash, first.importHash);
    const freshExport = exportStateStoreJson({
      store: fresh.store,
      evidence: fresh.evidence,
      at: FIXED_NOW,
    });
    assert.deepEqual(freshExport, exported);
    fresh.store.close();

    // Nothing wrote to the repository, including the export.
    assert.deepEqual(snapshotTree(repo), before);
    store.close();
  });
});

test("malformed audit lines are counted but preserved in the raw source hash", () => {
  withRepo((repo) => {
    seedLegacyRepo(repo);
    const journal = queueEventJournalPath(repo);
    writeFileSync(
      journal,
      readFileSync(journal, "utf8") + "{not json}\n",
      "utf8",
    );
    const { store, writer } = openHarness();
    const result = migrateLegacyJson({
      repoRoot: repo,
      writer,
      at: MIGRATION_AT,
    });
    assert.equal(result.counts.malformedAuditLines, 1);
    assert.equal(result.counts.auditEvents, 2);
    store.close();
  });
});

// ---------------------------------------------------------------------------
// Drift and scope
// ---------------------------------------------------------------------------

function isDrift(error: unknown): boolean {
  return (
    error instanceof StateStoreLegacyDriftError &&
    error.needsHuman === true &&
    error.code === "statestore.write.legacy_drift"
  );
}

test("post-import legacy drift fails closed until the bytes are restored", () => {
  withRepo((repo) => {
    seedLegacyRepo(repo);
    const { store, evidence, writer } = openHarness();
    migrateLegacyJson({ repoRoot: repo, writer, at: MIGRATION_AT });

    const guard = createLegacyJsonGuard({ repoRoot: repo, writer });
    writer.setLegacyGuard(guard);
    assert.doesNotThrow(() => guard.assertUnchanged());

    const ledgerPath = defaultLedgerPath(repo);
    const original = readFileSync(ledgerPath, "utf8");
    const changed = JSON.parse(original) as {
      tasks: Record<string, { reason?: string }>;
    };
    changed.tasks.task!.reason = "operator edited JSON after import";
    writeFileSync(ledgerPath, JSON.stringify(changed, null, 2) + "\n");

    assert.throws(() => guard.assertUnchanged(), isDrift);
    assert.throws(
      () => writer.appendQueue(loadQueue(repo)),
      isDrift,
      "a domain append must not proceed after drift",
    );
    assert.throws(
      () =>
        migrateLegacyJson({
          repoRoot: repo,
          writer,
          at: MIGRATION_AT,
        }),
      isDrift,
      "re-running the migration must not pick a winner",
    );

    // The failed append did not write a fact.
    const factsAfterDrift = store.exportFacts().length;
    writeFileSync(ledgerPath, original, "utf8");
    assert.doesNotThrow(() => guard.assertUnchanged());
    assert.equal(store.exportFacts().length, factsAfterDrift);

    const retried = migrateLegacyJson({
      repoRoot: repo,
      writer,
      at: MIGRATION_AT,
    });
    assert.equal(retried.status, "already-imported");
    assert.equal(retried.appendedRecords, 0);

    // Deleting a source that existed at import time is also drift.
    rmSync(supervisorPaths(repo).activePath);
    assert.throws(() => guard.assertUnchanged(), isDrift);
    const exported = exportStateStoreJson({
      store,
      evidence,
      at: FIXED_NOW,
    });
    assert.deepEqual(exported.activeRun, activePointer());
    store.close();
  });
});

test("scoped migration supports per-domain cutovers and scoped drift", () => {
  withRepo((repo) => {
    seedLegacyRepo(repo);
    const { store, evidence, writer } = openHarness();

    const result = migrateLegacyJson({
      repoRoot: repo,
      writer,
      domains: ["queue"],
      at: MIGRATION_AT,
    });
    assert.equal(result.status, "imported");
    assert.deepEqual(result.domains, ["queue"]);
    assert.equal(result.counts.runs, 0);
    assert.equal(result.counts.queueItems, 1);
    assert.equal(result.counts.ledgerTasks, 0);
    assert.equal(result.appendedRecords, 1);

    const exported = exportStateStoreJson({
      store,
      evidence,
      at: FIXED_NOW,
    });
    assert.deepEqual(exported.runs, []);
    assert.equal(exported.activeRun, null);
    assert.deepEqual(exported.queue, loadQueue(repo));
    assert.equal(exported.ledger, null);
    assert.deepEqual(exported.auditEvents, []);

    const queueGuard = createLegacyJsonGuard({
      repoRoot: repo,
      writer,
      domains: ["queue"],
    });
    assert.doesNotThrow(() => queueGuard.assertUnchanged());
    const ledgerGuard = createLegacyJsonGuard({
      repoRoot: repo,
      writer,
      domains: ["ledger"],
    });
    assert.throws(
      () => ledgerGuard.assertUnchanged(),
      StateStoreMigrationRequiredError,
    );

    // Out-of-scope drift is ignored by the queue guard.
    const runPath = runManifestPath(repo, "run-1");
    const originalRun = readFileSync(runPath, "utf8");
    const changedRun = JSON.parse(originalRun) as RunManifest;
    changedRun.status = "blocked";
    writeFileSync(runPath, JSON.stringify(changedRun, null, 2) + "\n");
    assert.doesNotThrow(() => queueGuard.assertUnchanged());

    // In-scope drift is refused.
    const queuePath = queuePaths(repo).queuePath;
    const originalQueue = readFileSync(queuePath, "utf8");
    const changedQueue = JSON.parse(originalQueue) as QueueDocument;
    changedQueue.updatedAt = "2026-01-02T00:00:00.000Z";
    writeFileSync(
      queuePath,
      JSON.stringify(changedQueue, null, 2) + "\n",
    );
    assert.throws(() => queueGuard.assertUnchanged(), isDrift);

    // Restoring both makes the scoped guard pass again.
    writeFileSync(runPath, originalRun, "utf8");
    writeFileSync(queuePath, originalQueue, "utf8");
    assert.doesNotThrow(() => queueGuard.assertUnchanged());

    // Importing the run scope later is a separate, still-verifiable import.
    const runResult = migrateLegacyJson({
      repoRoot: repo,
      writer,
      domains: ["run"],
      at: MIGRATION_AT,
    });
    assert.equal(runResult.status, "imported");
    assert.deepEqual(runResult.domains, ["run"]);
    assert.deepEqual(
      exportStateStoreJson({ store, evidence, at: FIXED_NOW }).runs,
      [loadRunManifest(repo, "run-1")],
    );
    store.close();
  });
});

test("a guard refuses writes before the first import", () => {
  withRepo((repo) => {
    seedLegacyRepo(repo);
    const { writer } = openHarness();
    const guard = createLegacyJsonGuard({ repoRoot: repo, writer });
    writer.setLegacyGuard(guard);
    assert.throws(
      () => guard.assertUnchanged(),
      StateStoreMigrationRequiredError,
    );
    assert.throws(
      () => writer.appendQueue(loadQueue(repo)),
      StateStoreMigrationRequiredError,
      "no domain write may precede the import marker",
    );
  });
});

test("missing legacy files import as empty truth and later creation is drift", () => {
  withRepo((repo) => {
    const { store, evidence, writer } = openHarness();
    const result = migrateLegacyJson({
      repoRoot: repo,
      writer,
      at: MIGRATION_AT,
    });
    assert.equal(result.status, "imported");
    assert.equal(result.counts.runs, 0);
    assert.equal(result.counts.queueItems, 0);
    assert.equal(result.counts.ledgerTasks, 0);
    assert.equal(result.counts.auditEvents, 0);
    assert.equal(result.sources.length, 4);
    assert.ok(result.sources.every((source) => !source.exists));
    assert.ok(result.sources.every((source) => source.contentHash === null));

    const exported = exportStateStoreJson({
      store,
      evidence,
      at: FIXED_NOW,
    });
    assert.deepEqual(exported.queue, {
      version: 1,
      updatedAt: new Date(0).toISOString(),
      items: [],
    });
    assert.deepEqual(exported.ledger, {
      path: ".cliyard/ledger.json",
      tasks: {},
    });

    const guard = createLegacyJsonGuard({ repoRoot: repo, writer });
    writer.setLegacyGuard(guard);
    writeJson(queuePaths(repo).queuePath, {
      version: 1,
      updatedAt: new Date(0).toISOString(),
      items: [],
    });
    assert.throws(() => guard.assertUnchanged(), isDrift);
    store.close();
  });
});

// ---------------------------------------------------------------------------
// Evidence integrity
// ---------------------------------------------------------------------------

class TamperingEvidenceStore extends MemoryDomainEvidenceStore {
  target: string | null = null;

  override read(ref: EvidenceRef): Buffer {
    const bytes = super.read(ref);
    if (this.target !== ref.contentHash) return bytes;
    const tampered = Buffer.from(bytes);
    tampered[0] = tampered[0]! ^ 0xff;
    return tampered;
  }
}

test("domain evidence hash corruption fails closed", () => {
  const evidence = new TamperingEvidenceStore();
  const { store, writer } = openHarness(evidence);
  const queue = queueDocument("/fixture/repo");
  writer.appendQueue(queue);

  const records = readStateStoreDomainRecords({ store, evidence });
  assert.equal(records.length, 1);
  evidence.target = records[0]!.contentHash;

  assert.throws(
    () => readStateStoreDomainRecords({ store, evidence }),
    (error: unknown) =>
      error instanceof StateStoreCorruptionError &&
      error.code === "statestore.corrupt",
  );
  assert.throws(
    () =>
      exportStateStoreJson({ store, evidence, at: FIXED_NOW }),
    StateStoreCorruptionError,
  );
  store.close();
});

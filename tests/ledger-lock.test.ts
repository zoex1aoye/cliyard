import { test } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  attachLedgerStateStore,
  defaultLedgerPath,
  detachLedgerStateStore,
  loadLedger,
  updateLedger,
  type LedgerTaskRecord,
} from "../src/persistence/ledger.js";
import {
  appendQueueEvent,
  attachQueueEventStateStore,
  detachQueueEventStateStore,
  queueEventJournalPath,
  readQueueAdoptionEvents,
  readQueueEventJournal,
  tryAppendQueueEvent,
  type QueueControlEvent,
} from "../src/orchestration/event-journal.js";
import {
  StateStore,
  createMemoryStateStoreDriver,
} from "../src/statestore/store.js";
import {
  MemoryDomainEvidenceStore,
  StateStoreLegacyDriftError,
  readStateStoreDomainRecords,
  sha256Hex,
} from "../src/statestore/write.js";
import {
  findCoveringMarker,
  hashLegacySources,
  readLegacySourceRefs,
} from "../src/statestore/migrate.js";

test("updateLedger: parallel writers keep all task ids", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cliyard-lock-"));
  const path = join(dir, "ledger.json");
  try {
    await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        updateLedger(path, (ledger) => {
          ledger.tasks[`t${i}`] = {
            taskId: `t${i}`,
            status: "accepted",
            repairCount: 0,
            contract: {
              taskId: `t${i}`,
              version: 1,
              frozen: true,
              goals: ["g"],
              dependsOn: [],
              readPaths: [],
              writePaths: [`src/t${i}/`],
              sharedResources: [],
              baseCommit: "HEAD",
              verifyCommands: [],
              maxRepairs: 0,
            },
            events: [],
            sessionIds: [],
            verdict: "accepted",
          };
        }),
      ),
    );
    const ledger = loadLedger(path);
    assert.equal(Object.keys(ledger.tasks).length, 8);
    const disk = JSON.parse(readFileSync(path, "utf8")) as {
      tasks: Record<string, unknown>;
    };
    assert.equal(Object.keys(disk.tasks).length, 8);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("updateLedger: cross-process writers keep every task", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cliyard-cross-process-"));
  const path = join(dir, "ledger.json");
  const script = join(dir, "writer.mts");
  const ledgerModule = fileURLToPath(
    new URL("../src/persistence/ledger.ts", import.meta.url),
  );
  try {
    writeFileSync(
      script,
      `import { updateLedger } from ${JSON.stringify(ledgerModule)};
const [path, taskId] = process.argv.slice(2);
await updateLedger(path, (ledger) => {
  ledger.tasks[taskId] = {
    taskId,
    status: "accepted",
    repairCount: 0,
    contract: {
      taskId,
      version: 1,
      frozen: true,
      goals: ["cross process"],
      dependsOn: [],
      readPaths: [],
      writePaths: [taskId + ".ts"],
      sharedResources: [],
      baseCommit: "HEAD",
      verifyCommands: [],
      maxRepairs: 0
    },
    events: [],
    sessionIds: [],
    verdict: "accepted"
  };
});
`,
    );
    await Promise.all(
      Array.from({ length: 6 }, (_, i) =>
        runWriter(script, path, `process-${i}`, process.cwd()),
      ),
    );
    const ledger = loadLedger(path);
    assert.deepEqual(
      Object.keys(ledger.tasks).sort(),
      Array.from({ length: 6 }, (_, i) => `process-${i}`).sort(),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

function runWriter(
  script: string,
  ledgerPath: string,
  taskId: string,
  cwd: string,
): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn("npx", ["tsx", script, ledgerPath, taskId], {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (data) => {
      stderr += String(data);
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolvePromise();
      else reject(new Error(`writer ${taskId} failed: ${stderr}`));
    });
  });
}

// ---------------------------------------------------------------------------
// Ledger and event-journal StateStore cutover
// ---------------------------------------------------------------------------

const CUTOVER_CLOCK = "2026-04-01T00:00:00.000Z";
const CUTOVER_IMPORTED_AT = "2026-04-02T00:00:00.000Z";

function ledgerTask(taskId: string): LedgerTaskRecord {
  return {
    taskId,
    status: "accepted",
    repairCount: 0,
    contract: { taskId } as never,
    events: [
      {
        at: "2026-03-01T00:00:00.000Z",
        type: "task.accepted",
        status: "accepted",
      },
    ],
    sessionIds: [`session-${taskId}`],
    verdict: "accepted",
  };
}

function legacyJournalEvents(): QueueControlEvent[] {
  return [
    {
      version: 1,
      eventId: "legacy-event-1",
      at: "2026-03-01T00:00:00.000Z",
      type: "run.started",
      runId: "run-1",
    },
    {
      version: 1,
      eventId: "legacy-adoption-1",
      at: "2026-03-02T00:00:00.000Z",
      type: "queue.item.adopted",
      itemId: "item-1",
      runId: "run-1",
      status: "completed",
      sourceManifestStatus: "blocked",
      baseCommit: "a".repeat(40),
      reviewedCommit: "b".repeat(40),
      contractsHash: "c".repeat(64),
      reviewEvidencePath: "docs/evidence/review.md",
      reviewEvidenceHash: "d".repeat(64),
      approvedBy: "operator",
      reason: "reviewed",
    },
  ];
}

interface CutoverFixture {
  dir: string;
  repo: string;
  ledgerPath: string;
  journalPath: string;
  manifestPath: string;
  ledgerBytes: string;
  journalBytes: string;
  manifestBytes: string;
}

function seedCutoverRepo(): CutoverFixture {
  const dir = mkdtempSync(join(tmpdir(), "cliyard-ledger-cutover-"));
  const repo = join(dir, "repo");
  const ledgerPath = defaultLedgerPath(repo);
  const journalPath = queueEventJournalPath(repo);
  const manifestPath = join(repo, ".cliyard", "runs", "run-1", "run-manifest.json");
  mkdirSync(dirname(ledgerPath), { recursive: true });
  mkdirSync(dirname(journalPath), { recursive: true, mode: 0o700 });
  mkdirSync(dirname(manifestPath), { recursive: true });
  const ledgerBytes =
    JSON.stringify(
      {
        path: ledgerPath,
        tasks: { alpha: ledgerTask("alpha") },
      },
      null,
      2,
    ) + "\n";
  const journalBytes = legacyJournalEvents()
    .map((event) => `${JSON.stringify(event)}\n`)
    .join("");
  // A run manifest sits outside both imported domains. Appending journal facts
  // must never mutate it (events are observational, not acceptance).
  const manifestBytes =
    JSON.stringify(
      {
        version: 1,
        runId: "run-1",
        status: "blocked",
        taskId: "alpha",
        updatedAt: "2026-03-01T00:00:00.000Z",
      },
      null,
      2,
    ) + "\n";
  writeFileSync(ledgerPath, ledgerBytes, "utf8");
  writeFileSync(journalPath, journalBytes, "utf8");
  writeFileSync(manifestPath, manifestBytes, "utf8");
  return {
    dir,
    repo,
    ledgerPath,
    journalPath,
    manifestPath,
    ledgerBytes,
    journalBytes,
    manifestBytes,
  };
}

function openCutoverStore(): {
  store: StateStore;
  evidence: MemoryDomainEvidenceStore;
} {
  return {
    store: StateStore.open(createMemoryStateStoreDriver()),
    evidence: new MemoryDomainEvidenceStore(),
  };
}

function isLegacyDrift(error: unknown): boolean {
  return (
    error instanceof StateStoreLegacyDriftError &&
    error.needsHuman === true &&
    error.code === "statestore.write.legacy_drift"
  );
}

test("cutover imports ledger and journal once, verifies hashes, then appends facts", async () => {
  const fixture = seedCutoverRepo();
  const { store, evidence } = openCutoverStore();
  try {
    const ledgerBinding = attachLedgerStateStore({
      repoRoot: fixture.repo,
      store,
      evidence,
      clock: () => CUTOVER_CLOCK,
      importedAt: CUTOVER_IMPORTED_AT,
    });
    const ledgerMigration = ledgerBinding.migration;
    assert.ok(ledgerMigration, "first attach must import the legacy ledger");
    assert.equal(ledgerMigration.status, "imported");
    assert.deepEqual(ledgerMigration.domains, ["ledger"]);
    assert.equal(ledgerMigration.counts.ledgerTasks, 1);
    assert.equal(ledgerMigration.appendedRecords, 1);
    assert.match(ledgerMigration.sourceHash, /^[0-9a-f]{64}$/);
    assert.match(ledgerMigration.contentHash, /^[0-9a-f]{64}$/);
    assert.match(ledgerMigration.importHash, /^[0-9a-f]{64}$/);

    // The raw-byte hash is verified against the legacy file, not the parsed
    // form, so whitespace edits are drift too.
    const ledgerRefs = readLegacySourceRefs(fixture.repo, ["ledger"]);
    assert.equal(ledgerRefs.length, 1);
    assert.equal(ledgerRefs[0]!.path, ".cliyard/ledger.json");
    assert.equal(ledgerRefs[0]!.contentHash, sha256Hex(fixture.ledgerBytes));
    assert.equal(ledgerMigration.sourceHash, hashLegacySources(ledgerRefs));

    const eventBinding = await attachQueueEventStateStore({
      repoRoot: fixture.repo,
      store,
      evidence,
      clock: () => CUTOVER_CLOCK,
      importedAt: CUTOVER_IMPORTED_AT,
    });
    const eventMigration = eventBinding.migration;
    assert.ok(eventMigration, "first attach must import the event journal");
    assert.equal(eventMigration.status, "imported");
    assert.deepEqual(eventMigration.domains, ["audit-event"]);
    assert.equal(eventMigration.counts.auditEvents, 2);
    assert.equal(eventMigration.counts.malformedAuditLines, 0);
    assert.equal(eventMigration.appendedRecords, 2);
    const journalRefs = readLegacySourceRefs(fixture.repo, ["audit-event"]);
    assert.equal(journalRefs.length, 1);
    assert.equal(journalRefs[0]!.path, ".cliyard/queue-events/events.jsonl");
    assert.equal(journalRefs[0]!.contentHash, sha256Hex(fixture.journalBytes));
    assert.equal(eventMigration.sourceHash, hashLegacySources(journalRefs));

    const importedRecords = readStateStoreDomainRecords({ store, evidence });
    const ledgerMarker = findCoveringMarker(importedRecords, ["ledger"]);
    const eventMarker = findCoveringMarker(importedRecords, ["audit-event"]);
    assert.equal(ledgerMarker?.payload.importHash, ledgerMigration.importHash);
    assert.equal(ledgerMarker?.payload.sourceHash, ledgerMigration.sourceHash);
    assert.equal(eventMarker?.payload.importHash, eventMigration.importHash);
    assert.equal(eventMarker?.payload.sourceHash, eventMigration.sourceHash);

    // Ledger mutations append facts; the JSON authority is never rewritten.
    await updateLedger(fixture.ledgerPath, (ledger) => {
      ledger.tasks.beta = ledgerTask("beta");
    });
    assert.equal(
      readFileSync(fixture.ledgerPath, "utf8"),
      fixture.ledgerBytes,
      "cutover must not write ledger.json",
    );
    assert.deepEqual(
      Object.keys(loadLedger(fixture.ledgerPath).tasks).sort(),
      ["alpha", "beta"],
    );

    // Journal appends are new facts; the JSONL file is never appended to.
    const appended = appendQueueEvent(fixture.repo, {
      type: "run.completed",
      at: "2026-03-03T00:00:00.000Z",
      runId: "run-1",
      status: "completed",
    });
    assert.equal(
      readFileSync(fixture.journalPath, "utf8"),
      fixture.journalBytes,
      "cutover must not append to events.jsonl",
    );
    // Events stay observational: a completed run event grants no acceptance
    // and leaves the RunManifest byte-for-byte untouched.
    assert.equal(
      readFileSync(fixture.manifestPath, "utf8"),
      fixture.manifestBytes,
      "cutover must never mutate a RunManifest via events",
    );

    const journal = readQueueEventJournal(fixture.repo);
    assert.equal(journal.exists, true);
    assert.equal(journal.totalEvents, 3);
    assert.equal(journal.malformedLines, 0);
    assert.equal(journal.lastEventAt, appended.at);
    assert.deepEqual(
      journal.events.map((event) => event.eventId),
      ["legacy-event-1", "legacy-adoption-1", appended.eventId],
      "events keep append order",
    );

    // Bounded limits still apply to the store-backed view.
    const limited = readQueueEventJournal(fixture.repo, 1);
    assert.equal(limited.totalEvents, 3);
    assert.deepEqual(
      limited.events.map((event) => event.eventId),
      [appended.eventId],
    );
    const adoptions = readQueueAdoptionEvents(fixture.repo);
    assert.equal(adoptions.totalEvents, 1);
    assert.equal(adoptions.events[0]!.eventId, "legacy-adoption-1");

    // Append-only: both the imported and the appended revisions remain.
    const finalRecords = readStateStoreDomainRecords({ store, evidence });
    const ledgerRecords = finalRecords.filter(
      (record) => record.kind === "ledger.document",
    );
    const auditRecords = finalRecords.filter(
      (record) => record.kind === "audit-event.recorded",
    );
    assert.equal(ledgerRecords.length, 2);
    assert.equal(auditRecords.length, 3);
    assert.equal(ledgerRecords.at(-1)!.payload.tasks.beta?.taskId, "beta");
    assert.equal(auditRecords.at(-1)!.id, appended.eventId);
  } finally {
    detachLedgerStateStore(fixture.ledgerPath);
    detachQueueEventStateStore(fixture.repo);
    store.close();
    rmSync(fixture.dir, { recursive: true, force: true });
  }
});

test("cutover attach is one-shot and never re-imports after appends", async () => {
  const fixture = seedCutoverRepo();
  const { store, evidence } = openCutoverStore();
  try {
    attachLedgerStateStore({
      repoRoot: fixture.repo,
      store,
      evidence,
      clock: () => CUTOVER_CLOCK,
      importedAt: CUTOVER_IMPORTED_AT,
    });
    await attachQueueEventStateStore({
      repoRoot: fixture.repo,
      store,
      evidence,
      clock: () => CUTOVER_CLOCK,
      importedAt: CUTOVER_IMPORTED_AT,
    });
    await updateLedger(fixture.ledgerPath, (ledger) => {
      ledger.tasks.beta = ledgerTask("beta");
    });
    appendQueueEvent(fixture.repo, {
      type: "run.resumed",
      at: "2026-03-03T00:00:00.000Z",
      runId: "run-1",
    });
    const seqAfterWrites = store.lastSeq;

    detachLedgerStateStore(fixture.ledgerPath);
    detachQueueEventStateStore(fixture.repo);

    // A restart-style re-attach sees the covering markers and skips the
    // import, so newer appended revisions are not compared to the old
    // snapshot and no duplicate facts are written.
    const reattachedLedger = attachLedgerStateStore({
      repoRoot: fixture.repo,
      store,
      evidence,
      clock: () => CUTOVER_CLOCK,
      importedAt: CUTOVER_IMPORTED_AT,
    });
    const reattachedEvents = await attachQueueEventStateStore({
      repoRoot: fixture.repo,
      store,
      evidence,
      clock: () => CUTOVER_CLOCK,
      importedAt: CUTOVER_IMPORTED_AT,
    });
    assert.equal(reattachedLedger.migration, null);
    assert.equal(reattachedEvents.migration, null);
    assert.equal(store.lastSeq, seqAfterWrites);

    assert.deepEqual(
      Object.keys(loadLedger(fixture.ledgerPath).tasks).sort(),
      ["alpha", "beta"],
    );
    assert.equal(readQueueEventJournal(fixture.repo).totalEvents, 3);
    assert.equal(
      readFileSync(fixture.ledgerPath, "utf8"),
      fixture.ledgerBytes,
    );
    assert.equal(
      readFileSync(fixture.journalPath, "utf8"),
      fixture.journalBytes,
    );

    await updateLedger(fixture.ledgerPath, (ledger) => {
      ledger.tasks.gamma = ledgerTask("gamma");
    });
    assert.equal(loadLedger(fixture.ledgerPath).tasks.gamma?.taskId, "gamma");
  } finally {
    detachLedgerStateStore(fixture.ledgerPath);
    detachQueueEventStateStore(fixture.repo);
    store.close();
    rmSync(fixture.dir, { recursive: true, force: true });
  }
});

test("legacy drift after cutover fails closed until the bytes are restored", async () => {
  const fixture = seedCutoverRepo();
  const { store, evidence } = openCutoverStore();
  try {
    attachLedgerStateStore({
      repoRoot: fixture.repo,
      store,
      evidence,
      clock: () => CUTOVER_CLOCK,
      importedAt: CUTOVER_IMPORTED_AT,
    });
    await attachQueueEventStateStore({
      repoRoot: fixture.repo,
      store,
      evidence,
      clock: () => CUTOVER_CLOCK,
      importedAt: CUTOVER_IMPORTED_AT,
    });
    const seqBeforeDrift = store.lastSeq;

    const driftedLedger = JSON.parse(fixture.ledgerBytes) as {
      tasks: Record<string, LedgerTaskRecord>;
    };
    driftedLedger.tasks.drifted = ledgerTask("drifted");
    writeFileSync(
      fixture.ledgerPath,
      JSON.stringify(driftedLedger, null, 2) + "\n",
      "utf8",
    );

    await assert.rejects(
      updateLedger(fixture.ledgerPath, (ledger) => {
        ledger.tasks.afterDrift = ledgerTask("afterDrift");
      }),
      isLegacyDrift,
      "a ledger append must refuse to choose a winner on drift",
    );
    assert.equal(store.lastSeq, seqBeforeDrift, "drift must write no fact");
    // The store, not the drifted JSON, remains the read authority.
    assert.equal(loadLedger(fixture.ledgerPath).tasks.drifted, undefined);

    const driftedEvent = {
      version: 1,
      eventId: "drifted-event",
      at: "2026-03-04T00:00:00.000Z",
      type: "run.blocked",
      runId: "run-1",
    };
    writeFileSync(
      fixture.journalPath,
      fixture.journalBytes + `${JSON.stringify(driftedEvent)}\n`,
      "utf8",
    );
    assert.throws(
      () =>
        appendQueueEvent(fixture.repo, {
          type: "run.completed",
          runId: "run-1",
        }),
      isLegacyDrift,
      "a journal append must refuse to choose a winner on drift",
    );
    // Best-effort appends stay observational: they report failure instead of
    // masking the queue authority, and still write no fact.
    assert.equal(
      tryAppendQueueEvent(fixture.repo, {
        type: "run.completed",
        runId: "run-1",
      }),
      undefined,
    );
    assert.equal(store.lastSeq, seqBeforeDrift);
    assert.equal(readQueueEventJournal(fixture.repo).totalEvents, 2);

    // Restoring the exact imported bytes re-enables both write paths.
    writeFileSync(fixture.ledgerPath, fixture.ledgerBytes, "utf8");
    writeFileSync(fixture.journalPath, fixture.journalBytes, "utf8");
    await updateLedger(fixture.ledgerPath, (ledger) => {
      ledger.tasks.restored = ledgerTask("restored");
    });
    const restoredEvent = appendQueueEvent(fixture.repo, {
      type: "run.completed",
      at: "2026-03-05T00:00:00.000Z",
      runId: "run-1",
    });
    assert.ok(restoredEvent.eventId);
    assert.ok(store.lastSeq > seqBeforeDrift);
    assert.equal(
      loadLedger(fixture.ledgerPath).tasks.restored?.taskId,
      "restored",
    );
    assert.equal(readQueueEventJournal(fixture.repo).totalEvents, 3);

    // A fresh attach also refuses drifted legacy bytes when a marker exists.
    detachLedgerStateStore(fixture.ledgerPath);
    writeFileSync(
      fixture.ledgerPath,
      JSON.stringify(driftedLedger, null, 2) + "\n",
      "utf8",
    );
    assert.throws(
      () =>
        attachLedgerStateStore({
          repoRoot: fixture.repo,
          store,
          evidence,
          clock: () => CUTOVER_CLOCK,
          importedAt: CUTOVER_IMPORTED_AT,
        }),
      isLegacyDrift,
    );
    writeFileSync(fixture.ledgerPath, fixture.ledgerBytes, "utf8");
  } finally {
    detachLedgerStateStore(fixture.ledgerPath);
    detachQueueEventStateStore(fixture.repo);
    store.close();
    rmSync(fixture.dir, { recursive: true, force: true });
  }
});

test("cutover imports missing legacy files as empty truth and creates no JSON", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cliyard-ledger-cutover-empty-"));
  const repo = join(dir, "repo");
  const { store, evidence } = openCutoverStore();
  try {
    const ledgerBinding = attachLedgerStateStore({
      repoRoot: repo,
      store,
      evidence,
      clock: () => CUTOVER_CLOCK,
      importedAt: CUTOVER_IMPORTED_AT,
    });
    assert.equal(ledgerBinding.migration?.counts.ledgerTasks, 0);
    const eventBinding = await attachQueueEventStateStore({
      repoRoot: repo,
      store,
      evidence,
      clock: () => CUTOVER_CLOCK,
      importedAt: CUTOVER_IMPORTED_AT,
    });
    assert.equal(eventBinding.migration?.counts.auditEvents, 0);
    assert.equal(eventBinding.journalExists, false);
    assert.equal(readQueueEventJournal(repo).exists, false);
    assert.equal(readQueueEventJournal(repo).totalEvents, 0);

    await updateLedger(defaultLedgerPath(repo), (ledger) => {
      ledger.tasks.fresh = ledgerTask("fresh");
    });
    appendQueueEvent(repo, {
      type: "controller.started",
      at: "2026-03-06T00:00:00.000Z",
    });
    assert.equal(loadLedger(defaultLedgerPath(repo)).tasks.fresh?.taskId, "fresh");
    const journal = readQueueEventJournal(repo);
    assert.equal(journal.totalEvents, 1);
    assert.equal(journal.exists, true);
    assert.equal(existsSync(defaultLedgerPath(repo)), false);
    assert.equal(existsSync(queueEventJournalPath(repo)), false);
  } finally {
    detachLedgerStateStore(defaultLedgerPath(repo));
    detachQueueEventStateStore(repo);
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

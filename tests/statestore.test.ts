import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AttemptIdentityConflictError,
  FileEvidenceStore,
  MAX_ATTEMPT_ID_LENGTH,
  MAX_EVIDENCE_PATH_LENGTH,
  MAX_FACT_PAYLOAD_BYTES,
  MAX_RUNTIME_HANDLE_LENGTH,
  META_PROJECTION_FORMAT,
  PROJECTION_FORMAT_VERSION,
  SequenceConflictError,
  StateStore,
  StateStoreCorruptionError,
  StateStoreDriverUnavailableError,
  StateStoreValidationError,
  UnknownAttemptError,
  createBetterSqlite3Driver,
  createMemoryStateStoreDriver,
  openFileStateStore,
  type AppendFactInput,
  type AttemptDesiredState,
  type AttemptStartedInput,
  type ExecutionBackendType,
  type StateStoreDriver,
} from "../src/statestore/store.js";
import {
  projectionSnapshot,
  replayFacts,
} from "../src/statestore/projection.js";

const ATTEMPT_ID = "attempt-1";
const RUNTIME_HANDLE = "com.cliyard.attempt.1";
const LEASE_DEADLINE = "2026-01-02T00:00:00.000Z";

const requireFromTest = createRequire(import.meta.url);

function betterSqlite3Installed(): boolean {
  try {
    requireFromTest.resolve("better-sqlite3");
    return true;
  } catch {
    return false;
  }
}

const sqliteSkip = betterSqlite3Installed()
  ? false
  : "better-sqlite3 is not installed in this workspace";

/**
 * Deterministic host boundary. Same `prefix` + start second yields the same
 * timestamps and event ids, which is how replay equivalence is asserted.
 */
function deterministicBoundary(prefix = "store", startSecond = 0) {
  let second = startSecond;
  let event = 0;
  return {
    clock: () =>
      new Date(Date.UTC(2026, 0, 1, 0, 0, second++)).toISOString(),
    newEventId: () => `${prefix}-event-${String(++event).padStart(6, "0")}`,
  };
}

function startedInput(
  attemptId = ATTEMPT_ID,
  overrides: Partial<AttemptStartedInput> = {},
): AppendFactInput {
  return {
    kind: "attempt.started",
    attemptId,
    payload: {
      backendType: "launchd",
      runtimeHandle: RUNTIME_HANDLE,
      workspaceId: "workspace-1",
      ...overrides,
    },
  };
}

function observedInput(
  attemptId = ATTEMPT_ID,
  observedState: "unknown" | "running" | "exited" | "lost" = "running",
  pid: number | null = 4242,
): AppendFactInput {
  return {
    kind: "attempt.observed-state-changed",
    attemptId,
    payload: {
      observedState,
      diagnostics: { pid, pgid: pid },
    },
  };
}

function desiredInput(
  desiredState: AttemptDesiredState = "stopped",
): AppendFactInput {
  return {
    kind: "attempt.desired-state-changed",
    attemptId: ATTEMPT_ID,
    payload: { desiredState, leaseDeadline: LEASE_DEADLINE },
  };
}

function appendUnsafe(store: StateStore, input: unknown): void {
  store.append(input as AppendFactInput);
}

// ---------------------------------------------------------------------------
// Append, projection, append-only log
// ---------------------------------------------------------------------------

test("append commits the fact and its projection row in one view", () => {
  const store = StateStore.open(
    createMemoryStateStoreDriver(),
    deterministicBoundary(),
  );
  try {
    const start = store.append(startedInput());
    const desired = store.append(desiredInput());
    const observed = store.append(observedInput(ATTEMPT_ID, "exited"));

    assert.deepEqual(
      [start.seq, desired.seq, observed.seq],
      [1, 2, 3],
    );
    const snapshot = store.snapshot();
    assert.equal(snapshot.lastSeq, 3);
    assert.equal(snapshot.attempts.length, 1);
    assert.deepEqual(snapshot.attempts[0], {
      attemptId: ATTEMPT_ID,
      backendType: "launchd",
      runtimeHandle: RUNTIME_HANDLE,
      workspaceId: "workspace-1",
      desiredState: "stopped",
      observedState: "exited",
      leaseDeadline: LEASE_DEADLINE,
      diagnostics: { pid: 4242, pgid: 4242 },
      updatedAt: new Date(Date.UTC(2026, 0, 1, 0, 0, 2)).toISOString(),
      lastSeq: 3,
    });

    const facts = store.exportFacts();
    assert.deepEqual(
      facts.map((fact) => fact.kind),
      [
        "attempt.started",
        "attempt.desired-state-changed",
        "attempt.observed-state-changed",
      ],
    );
    assert.deepEqual(facts.map((fact) => fact.seq), [1, 2, 3]);
    // PID/PGID never enter the start fact; they are later diagnostics only.
    assert.equal(
      "pid" in (facts[0]!.payload as unknown as Record<string, unknown>),
      false,
    );

    // Existing facts are immutable when later facts append.
    const prefix = store.exportFacts();
    store.append(observedInput(ATTEMPT_ID, "lost", 999));
    assert.deepEqual(store.exportFacts().slice(0, prefix.length), prefix);
  } finally {
    store.close();
  }
});

test("a repeated start with the same identity is idempotent", () => {
  const store = StateStore.open(
    createMemoryStateStoreDriver(),
    deterministicBoundary(),
  );
  try {
    store.append(startedInput());
    store.append(startedInput());
    const snapshot = store.snapshot();
    assert.equal(snapshot.attempts.length, 1);
    assert.equal(snapshot.attempts[0]!.lastSeq, 2);
  } finally {
    store.close();
  }
});

// ---------------------------------------------------------------------------
// Optimistic concurrency
// ---------------------------------------------------------------------------

test("sequence compare-and-swap rejects a stale expectedSeq", () => {
  const store = StateStore.open(
    createMemoryStateStoreDriver(),
    deterministicBoundary(),
  );
  try {
    store.append(startedInput(), { expectedSeq: 0 });
    assert.throws(
      () => store.append(startedInput("attempt-2"), { expectedSeq: 0 }),
      (error: unknown) =>
        error instanceof SequenceConflictError &&
        error.expectedSeq === 0 &&
        error.actualSeq === 1,
    );
    assert.equal(store.lastSeq, 1);
    assert.deepEqual(
      store.snapshot().attempts.map((row) => row.attemptId),
      [ATTEMPT_ID],
    );
    assert.throws(
      () => store.append(startedInput("attempt-2"), { expectedSeq: 1.5 }),
      StateStoreValidationError,
    );
    assert.throws(
      () => store.append(startedInput("attempt-2"), { expectedSeq: -1 }),
      StateStoreValidationError,
    );
  } finally {
    store.close();
  }
});

test("two sessions sharing a driver detect the conflict and catch up", () => {
  const driver = createMemoryStateStoreDriver();
  const first = StateStore.open(driver, deterministicBoundary("first"));
  const second = StateStore.open(driver, deterministicBoundary("second"));
  try {
    first.append(startedInput("attempt-a"), { expectedSeq: 0 });
    assert.throws(
      () => second.append(startedInput("attempt-b"), { expectedSeq: 0 }),
      SequenceConflictError,
    );

    const appended = second.append(startedInput("attempt-b"), {
      expectedSeq: 1,
    });
    assert.equal(appended.seq, 2);
    assert.deepEqual(
      second.snapshot().attempts.map((row) => row.attemptId),
      ["attempt-a", "attempt-b"],
    );

    const observer = StateStore.open(
      driver,
      deterministicBoundary("observer"),
    );
    assert.deepEqual(observer.snapshot(), second.snapshot());
    assert.equal(observer.lastSeq, 2);
  } finally {
    second.close();
    first.close();
  }
});

// ---------------------------------------------------------------------------
// Rebuild from the fact log
// ---------------------------------------------------------------------------

test("a projection format change rebuilds from the fact log", () => {
  const driver = createMemoryStateStoreDriver();
  const store = StateStore.open(driver, deterministicBoundary());
  store.append(startedInput());
  store.append(desiredInput());
  store.append(observedInput(ATTEMPT_ID, "exited"));
  const before = store.snapshot();

  driver.transaction((tx) => {
    const row = tx.readAttempts()[0]!;
    tx.putAttempt({
      ...row,
      desiredState: "running",
      observedState: "lost",
      updatedAt: "1999-01-01T00:00:00.000Z",
    });
    tx.setMeta(META_PROJECTION_FORMAT, "9999");
  });

  const reopened = StateStore.open(
    driver,
    deterministicBoundary("reopened"),
  );
  try {
    assert.deepEqual(reopened.snapshot(), before);
    assert.equal(reopened.lastSeq, 3);
  } finally {
    reopened.close();
  }
});

test("explicit rebuild repairs a stale projection without a format bump", () => {
  const driver = createMemoryStateStoreDriver();
  const store = StateStore.open(driver, deterministicBoundary());
  store.append(startedInput());
  store.append(observedInput(ATTEMPT_ID, "running"));
  const before = store.snapshot();

  driver.transaction((tx) => {
    const row = tx.readAttempts()[0]!;
    tx.putAttempt({ ...row, observedState: "lost" });
    tx.setMeta(META_PROJECTION_FORMAT, String(PROJECTION_FORMAT_VERSION));
  });

  const reopened = StateStore.open(
    driver,
    deterministicBoundary("loaded"),
  );
  try {
    // The matching sequence marker means the store trusts the corrupted row.
    assert.equal(reopened.snapshot().attempts[0]!.observedState, "lost");
    reopened.rebuild();
    assert.deepEqual(reopened.snapshot(), before);
  } finally {
    reopened.close();
  }
});

// ---------------------------------------------------------------------------
// Deterministic replay
// ---------------------------------------------------------------------------

test("replay from exported facts is deterministic and matches the store", () => {
  const firstStore = StateStore.open(
    createMemoryStateStoreDriver(),
    deterministicBoundary("same"),
  );
  const secondStore = StateStore.open(
    createMemoryStateStoreDriver(),
    deterministicBoundary("same"),
  );
  try {
    for (const store of [firstStore, secondStore]) {
      store.append(startedInput());
      store.append(desiredInput());
      store.append(observedInput(ATTEMPT_ID, "exited"));
    }

    const facts = firstStore.exportFacts();
    assert.deepEqual(secondStore.exportFacts(), facts);

    const firstReplay = projectionSnapshot(replayFacts(facts));
    const secondReplay = projectionSnapshot(replayFacts(facts));
    assert.deepEqual(firstReplay, firstStore.snapshot());
    assert.deepEqual(secondReplay, firstReplay);
    assert.equal(
      JSON.stringify(firstReplay),
      JSON.stringify(secondReplay),
    );
  } finally {
    firstStore.close();
    secondStore.close();
  }
});

test("replay rejects gaps, reordering, duplicate ids and invalid identities", () => {
  const store = StateStore.open(
    createMemoryStateStoreDriver(),
    deterministicBoundary(),
  );
  const facts = (() => {
    store.append(startedInput());
    store.append(desiredInput());
    store.append(observedInput(ATTEMPT_ID, "exited"));
    return store.exportFacts();
  })();
  store.close();

  assert.throws(
    () => replayFacts([facts[0]!, facts[2]!]),
    StateStoreCorruptionError,
  );
  assert.throws(
    () => replayFacts([facts[1]!, facts[0]!]),
    StateStoreCorruptionError,
  );
  assert.throws(
    () =>
      replayFacts([
        facts[0]!,
        { ...facts[1]!, eventId: facts[0]!.eventId },
      ]),
    StateStoreCorruptionError,
  );
  assert.throws(
    () =>
      replayFacts([
        {
          ...facts[0]!,
          attemptId: "a".repeat(MAX_ATTEMPT_ID_LENGTH + 1),
        },
      ]),
    StateStoreValidationError,
  );
});

// ---------------------------------------------------------------------------
// Bounded identity validation
// ---------------------------------------------------------------------------

test("identity and payload fields are bounded and fail closed", () => {
  const store = StateStore.open(
    createMemoryStateStoreDriver(),
    deterministicBoundary(),
  );
  try {
    const invalidInputs: Array<[string, unknown]> = [
      [
        "overlong attempt id",
        startedInput("a".repeat(MAX_ATTEMPT_ID_LENGTH + 1)),
      ],
      ["attempt id with spaces", startedInput("bad attempt id")],
      [
        "unknown backend type",
        startedInput(ATTEMPT_ID, {
          backendType: "docker" as ExecutionBackendType,
        }),
      ],
      [
        "overlong runtime handle",
        startedInput(ATTEMPT_ID, {
          runtimeHandle: "r".repeat(MAX_RUNTIME_HANDLE_LENGTH + 1),
        }),
      ],
      [
        "empty workspace id",
        startedInput(ATTEMPT_ID, { workspaceId: "" }),
      ],
      [
        "unknown desired state",
        startedInput(ATTEMPT_ID, {
          desiredState: "paused" as AttemptDesiredState,
        }),
      ],
      [
        "negative pid diagnostic",
        observedInput(ATTEMPT_ID, "running", -1),
      ],
      [
        "fractional pid diagnostic",
        observedInput(ATTEMPT_ID, "running", 1.5),
      ],
      [
        "unknown attempt observed state",
        {
          kind: "attempt.observed-state-changed",
          attemptId: ATTEMPT_ID,
          payload: { observedState: "zombie" },
        },
      ],
      [
        "malformed evidence hash",
        {
          kind: "attempt.evidence-recorded",
          attemptId: ATTEMPT_ID,
          payload: {
            evidence: [
              {
                contentHash: "abc",
                byteLength: 1,
                mediaType: "text/plain",
                path: "sha256/abc",
              },
            ],
          },
        },
      ],
      [
        "evidence path traversal",
        {
          kind: "attempt.evidence-recorded",
          attemptId: ATTEMPT_ID,
          payload: {
            evidence: [
              {
                contentHash: "a".repeat(64),
                byteLength: 1,
                mediaType: "text/plain",
                path: "../escape",
              },
            ],
          },
        },
      ],
      [
        "inline evidence content",
        {
          kind: "attempt.evidence-recorded",
          attemptId: ATTEMPT_ID,
          payload: {
            evidence: [
              {
                contentHash: "a".repeat(64),
                byteLength: 1,
                mediaType: "text/plain",
                path: `sha256/${"a".repeat(64)}`,
                content: "inline bytes are not allowed",
              },
            ],
          },
        },
      ],
      [
        "identity fields in the start payload",
        {
          ...startedInput(),
          payload: { ...startedInput().payload, pid: 1234 },
        },
      ],
      [
        "overlong evidence path",
        {
          kind: "attempt.evidence-recorded",
          attemptId: ATTEMPT_ID,
          payload: {
            evidence: [
              {
                contentHash: "a".repeat(64),
                byteLength: 1,
                mediaType: "text/plain",
                path: `sha256/${"p".repeat(MAX_EVIDENCE_PATH_LENGTH)}`,
              },
            ],
          },
        },
      ],
    ];

    for (const [label, input] of invalidInputs) {
      assert.throws(
        () => appendUnsafe(store, input),
        StateStoreValidationError,
        label,
      );
    }
    assert.equal(store.lastSeq, 0);
    assert.equal(store.snapshot().attempts.length, 0);
  } finally {
    store.close();
  }
});

test("identity is the runtime handle, not pid/pgid diagnostics", () => {
  const store = StateStore.open(
    createMemoryStateStoreDriver(),
    deterministicBoundary(),
  );
  try {
    store.append(startedInput());
    for (const [label, input] of [
      [
        "runtime handle",
        startedInput(ATTEMPT_ID, {
          runtimeHandle: "com.cliyard.attempt.other",
        }),
      ],
      [
        "backend type",
        startedInput(ATTEMPT_ID, { backendType: "systemd" }),
      ],
      [
        "workspace id",
        startedInput(ATTEMPT_ID, { workspaceId: "workspace-2" }),
      ],
    ] as Array<[string, AppendFactInput]>) {
      assert.throws(
        () => store.append(input),
        AttemptIdentityConflictError,
        label,
      );
    }

    store.append(observedInput(ATTEMPT_ID, "running", 100));
    store.append(observedInput(ATTEMPT_ID, "running", 200));
    const row = store.attempt(ATTEMPT_ID);
    assert.ok(row);
    assert.equal(row.runtimeHandle, RUNTIME_HANDLE);
    assert.equal(row.backendType, "launchd");
    assert.deepEqual(row.diagnostics, { pid: 200, pgid: 200 });
  } finally {
    store.close();
  }
});

test("facts about an unknown attempt are rejected", () => {
  const store = StateStore.open(
    createMemoryStateStoreDriver(),
    deterministicBoundary(),
  );
  try {
    assert.throws(
      () => store.append(desiredInput()),
      UnknownAttemptError,
    );
    assert.throws(
      () => store.append(observedInput()),
      UnknownAttemptError,
    );
    assert.throws(
      () =>
        store.append({
          kind: "attempt.evidence-recorded",
          attemptId: ATTEMPT_ID,
          payload: {
            evidence: [
              {
                contentHash: "a".repeat(64),
                byteLength: 1,
                mediaType: "text/plain",
                path: `sha256/${"a".repeat(64)}`,
              },
            ],
          },
        }),
      UnknownAttemptError,
    );
    assert.equal(store.lastSeq, 0);
  } finally {
    store.close();
  }
});

// ---------------------------------------------------------------------------
// Content-addressed evidence
// ---------------------------------------------------------------------------

test("evidence bytes stay in content-addressed files, not the fact log", () => {
  const directory = mkdtempSync(join(tmpdir(), "cliyard-evidence-"));
  const store = StateStore.open(
    createMemoryStateStoreDriver(),
    deterministicBoundary(),
  );
  try {
    const files = new FileEvidenceStore({ directory });
    const content = "verifier transcript line\n".repeat(500);
    const ref = files.put(content, "text/plain");

    assert.equal(ref.byteLength, Buffer.byteLength(content));
    assert.equal(
      ref.contentHash,
      createHash("sha256").update(content).digest("hex"),
    );
    assert.equal(ref.path, `sha256/${ref.contentHash}`);
    assert.equal(
      readFileSync(join(directory, ref.path), "utf8"),
      content,
    );
    assert.equal(files.read(ref).toString("utf8"), content);

    store.append(startedInput());
    const recorded = store.append({
      kind: "attempt.evidence-recorded",
      attemptId: ATTEMPT_ID,
      payload: { evidence: [ref] },
    });
    assert.deepEqual(store.evidence(ATTEMPT_ID), [
      {
        attemptId: ATTEMPT_ID,
        ...ref,
        recordedAt: recorded.at,
        seq: recorded.seq,
      },
    ]);

    const serializedFacts = JSON.stringify(store.exportFacts());
    assert.equal(serializedFacts.includes("verifier transcript"), false);
    assert.ok(serializedFacts.includes(ref.contentHash));

    // Same content hash with contradictory metadata is rejected and the
    // transaction, including the fact append, rolls back.
    assert.throws(
      () =>
        store.append({
          kind: "attempt.evidence-recorded",
          attemptId: ATTEMPT_ID,
          payload: {
            evidence: [{ ...ref, byteLength: ref.byteLength + 1 }],
          },
        }),
      StateStoreValidationError,
    );
    assert.equal(store.lastSeq, 2);

    // Duplicate hashes in one fact are not canonical.
    assert.throws(
      () =>
        store.append({
          kind: "attempt.evidence-recorded",
          attemptId: ATTEMPT_ID,
          payload: { evidence: [ref, ref] },
        }),
      StateStoreValidationError,
    );

    const limited = new FileEvidenceStore({ directory, maxBytes: 4 });
    assert.throws(
      () => limited.put("too large", "text/plain"),
      StateStoreValidationError,
    );
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("oversized fact payloads are rejected before append", () => {
  const store = StateStore.open(
    createMemoryStateStoreDriver(),
    deterministicBoundary(),
  );
  try {
    store.append(startedInput());
    const evidence = Array.from({ length: 64 }, (_, index) => ({
      contentHash: index.toString(16).padStart(64, "0"),
      byteLength: 1,
      mediaType: "text/plain",
      path: `sha256/${"p".repeat(400)}-${index}`,
    }));
    assert.ok(
      Buffer.byteLength(JSON.stringify({ evidence })) >
        MAX_FACT_PAYLOAD_BYTES,
    );
    assert.throws(
      () =>
        store.append({
          kind: "attempt.evidence-recorded",
          attemptId: ATTEMPT_ID,
          payload: { evidence },
        }),
      StateStoreValidationError,
    );
    assert.equal(store.lastSeq, 1);
  } finally {
    store.close();
  }
});

// ---------------------------------------------------------------------------
// Driver swapability
// ---------------------------------------------------------------------------

function runDriverConformance(driver: StateStoreDriver): void {
  const store = StateStore.open(driver, deterministicBoundary("conformance"));
  const start = store.append(startedInput());
  assert.equal(start.seq, 1);
  const observed = store.append(observedInput(ATTEMPT_ID, "running", 101));
  assert.equal(observed.seq, 2);

  assert.throws(
    () => store.append(startedInput("attempt-2"), { expectedSeq: 0 }),
    SequenceConflictError,
  );

  const snapshot = store.snapshot();
  const facts = store.exportFacts();
  assert.deepEqual(projectionSnapshot(replayFacts(facts)), snapshot);

  driver.transaction((tx) => {
    tx.setMeta(META_PROJECTION_FORMAT, "conformance-format-change");
  });
  const reopened = StateStore.open(
    driver,
    deterministicBoundary("conformance-reopened"),
  );
  assert.deepEqual(reopened.snapshot(), snapshot);
}

test("driver swapability: reference memory driver", () => {
  const driver = createMemoryStateStoreDriver();
  try {
    runDriverConformance(driver);
  } finally {
    driver.close();
  }
});

test(
  "driver swapability: default better-sqlite3 file driver",
  { skip: sqliteSkip },
  () => {
    const directory = mkdtempSync(join(tmpdir(), "cliyard-sqlite-"));
    try {
      const driver = createBetterSqlite3Driver({
        path: join(directory, "state.sqlite3"),
      });
      try {
        runDriverConformance(driver);
      } finally {
        driver.close();
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  },
);

test(
  "better-sqlite3 persists facts and projection across connections with WAL",
  { skip: sqliteSkip },
  () => {
    const directory = mkdtempSync(join(tmpdir(), "cliyard-sqlite-"));
    const path = join(directory, "state.sqlite3");
    try {
      const first = StateStore.open(
        createBetterSqlite3Driver({ path }),
        deterministicBoundary("persist"),
      );
      first.append(startedInput());
      first.append(observedInput(ATTEMPT_ID, "exited"));
      const before = first.snapshot();
      first.close();

      const second = StateStore.open(
        createBetterSqlite3Driver({ path }),
        deterministicBoundary("persist-reopened"),
      );
      try {
        assert.deepEqual(second.snapshot(), before);
      } finally {
        second.close();
      }

      const Database = requireFromTest("better-sqlite3") as new (
        databasePath: string,
      ) => {
        pragma(source: string, options?: { simple?: boolean }): unknown;
        close(): void;
      };
      const probe = new Database(path);
      try {
        assert.equal(
          String(
            probe.pragma("journal_mode", { simple: true }),
          ).toLowerCase(),
          "wal",
        );
      } finally {
        probe.close();
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  },
);

test(
  "openFileStateStore is the default durable entry point",
  { skip: sqliteSkip },
  () => {
    const directory = mkdtempSync(join(tmpdir(), "cliyard-sqlite-"));
    try {
      const store = openFileStateStore({
        path: join(directory, "default.sqlite3"),
        ...deterministicBoundary("default"),
      });
      try {
        store.append(startedInput());
        store.append(observedInput(ATTEMPT_ID, "running"));
        assert.equal(store.lastSeq, 2);
        assert.equal(store.snapshot().attempts[0]!.attemptId, ATTEMPT_ID);
      } finally {
        store.close();
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  },
);

test(
  "file driver reports a typed unavailable error without better-sqlite3",
  { skip: betterSqlite3Installed() ? "better-sqlite3 is installed" : false },
  () => {
    assert.throws(
      () => createBetterSqlite3Driver({ path: ":memory:" }),
      StateStoreDriverUnavailableError,
    );
  },
);

test("the default driver validates its options before loading the module", () => {
  assert.throws(
    () => createBetterSqlite3Driver({ path: "" }),
    StateStoreValidationError,
  );
  assert.throws(
    () =>
      createBetterSqlite3Driver({
        path: ":memory:",
        busyTimeoutMs: -1,
      }),
    StateStoreValidationError,
  );
});

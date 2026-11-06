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
import { join } from "node:path";
import {
  CONTROL_STATE_DB_FILE,
  LEGACY_SUPERVISOR_STATE_DIR,
  controlStatePaths,
  readLegacyRelocateMarker,
  resolveControlStatePaths,
} from "../src/statestore/paths.js";
import { StateStoreCorruptionError } from "../src/statestore/store.js";
import { supervisorStatePaths } from "../src/supervisor/store.js";
import { queueStatePaths } from "../src/orchestration/queue-store.js";
import { daemonStatePaths } from "../src/daemon/core.js";

test("supervisor, queue and daemon resolve the same sqlite path", () => {
  const dir = mkdtempSync(join(tmpdir(), "cliyard-path-unify-"));
  const repo = join(dir, "repo");
  mkdirSync(repo);
  try {
    const supervisor = supervisorStatePaths(repo);
    const queue = queueStatePaths(repo);
    const daemon = daemonStatePaths(repo);
    const control = controlStatePaths(repo);
    assert.equal(supervisor.sqlitePath, queue.dbPath);
    assert.equal(supervisor.sqlitePath, daemon.sqlitePath);
    assert.equal(supervisor.sqlitePath, control.dbPath);
    assert.equal(
      supervisor.sqlitePath,
      join(repo, ".cliyard", CONTROL_STATE_DB_FILE),
    );
    assert.equal(supervisor.evidenceDir, queue.evidenceDir);
    assert.equal(supervisor.factsPath, queue.fallbackFactsPath);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("legacy-only supervisor store relocates once into canonical layout", () => {
  const dir = mkdtempSync(join(tmpdir(), "cliyard-path-relocate-"));
  const repo = join(dir, "repo");
  const paths = controlStatePaths(repo);
  mkdirSync(paths.legacyStateDir, { recursive: true, mode: 0o700 });
  writeFileSync(paths.legacySqlitePath, "sqlite-bytes", "utf8");
  mkdirSync(paths.legacyEvidenceDir, { recursive: true });
  writeFileSync(join(paths.legacyEvidenceDir, "obj"), "evidence", "utf8");

  try {
    const first = resolveControlStatePaths(repo, {
      now: () => "2026-11-06T00:00:00.000Z",
    });
    assert.equal(first.relocated, true);
    assert.equal(existsSync(paths.dbPath), true);
    assert.equal(readFileSync(paths.dbPath, "utf8"), "sqlite-bytes");
    assert.equal(existsSync(join(paths.evidenceDir, "obj")), true);
    assert.equal(existsSync(paths.legacySqlitePath), false);
    const marker = readLegacyRelocateMarker(repo);
    assert.ok(marker);
    assert.equal(marker.relocatedAt, "2026-11-06T00:00:00.000Z");
    assert.equal(marker.to.dbPath, paths.dbPath);

    const second = resolveControlStatePaths(repo);
    assert.equal(second.relocated, false);
    assert.equal(existsSync(paths.dbPath), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("dual canonical + legacy authorities fail closed", () => {
  const dir = mkdtempSync(join(tmpdir(), "cliyard-path-dual-"));
  const repo = join(dir, "repo");
  const paths = controlStatePaths(repo);
  mkdirSync(paths.cliyardDir, { recursive: true, mode: 0o700 });
  mkdirSync(paths.legacyStateDir, { recursive: true, mode: 0o700 });
  writeFileSync(paths.dbPath, "canonical", "utf8");
  writeFileSync(paths.legacySqlitePath, "legacy", "utf8");
  try {
    assert.throws(
      () => resolveControlStatePaths(repo),
      (error: unknown) =>
        error instanceof StateStoreCorruptionError &&
        /two authorities/.test(error.message) &&
        /needs human/.test(error.message),
    );
    assert.equal(
      existsSync(join(repo, ".cliyard", LEGACY_SUPERVISOR_STATE_DIR)),
      true,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

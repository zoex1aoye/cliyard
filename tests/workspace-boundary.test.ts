import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  captureWorkspaceBoundary,
  compareWorkspaceBoundary,
  normalizeEvidencePath,
  resolveWorkspaceBoundaryPolicy,
  sanitizeDiagnosticText,
  WorkspaceBoundaryGuard,
  WorkspaceBoundaryInspectionError,
  WorkspaceBoundaryPolicyError,
  type WorkspaceBoundaryChange,
  type WorkspaceBoundaryPolicy,
  type WorkspaceBoundarySnapshot,
} from "../src/agents/workspace-boundary.js";

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

interface Fixture {
  root: string;
  write: (rel: string, content?: string) => string;
  remove: (rel: string) => void;
  policy: (extra?: Partial<WorkspaceBoundaryPolicy>) => WorkspaceBoundaryPolicy;
}

function fixture(t: TestContext): Fixture {
  const root = mkdtempSync(join(tmpdir(), "cliyard-boundary-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return {
    root,
    write(rel: string, content = "default"): string {
      const abs = join(root, rel);
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, content);
      return abs;
    },
    remove(rel: string): void {
      unlinkSync(join(root, rel));
    },
    policy(extra: Partial<WorkspaceBoundaryPolicy> = {}): WorkspaceBoundaryPolicy {
      return { authorityRoot: root, ...extra };
    },
  };
}

async function capture(fx: Fixture, extra?: Partial<WorkspaceBoundaryPolicy>) {
  return captureWorkspaceBoundary(fx.policy(extra));
}

function changedPaths(changes: readonly WorkspaceBoundaryChange[]): string[] {
  return changes.map((change) => change.path);
}

test("clean boundary reports clean with no changes", async (t) => {
  const fx = fixture(t);
  fx.write("a.txt", "one");
  fx.write("sub/b.txt", "two");
  symlinkSync("a.txt", join(fx.root, "link-a"));

  const guard = new WorkspaceBoundaryGuard(fx.policy());
  await guard.capture();
  const result = await guard.compare();
  assert.deepEqual(result, { status: "clean", changes: [] });

  const before = await capture(fx);
  const after = await capture(fx);
  assert.deepEqual(compareWorkspaceBoundary(before, after), {
    status: "clean",
    changes: [],
  });
});

test("modified files are detected by content digest, not timestamps", async (t) => {
  const fx = fixture(t);
  const abs = fx.write("file.txt", "AAAA");
  const before = await capture(fx);

  // Same length, different content, and the mtime is pinned back so only a
  // content digest can observe the modification.
  const original = statSync(abs);
  writeFileSync(abs, "BBBB");
  utimesSync(abs, original.atime, original.mtime);
  const after = await capture(fx);

  const result = compareWorkspaceBoundary(before, after);
  assert.equal(result.status, "dirty");
  if (result.status !== "dirty") return;
  assert.equal(result.changes.length, 1);
  assert.deepEqual(result.changes[0], {
    rootIndex: 0,
    change: "modified",
    kind: "file",
    path: "file.txt",
    beforeDigest: sha256("AAAA"),
    afterDigest: sha256("BBBB"),
  });
});

test("added and removed files are detected", async (t) => {
  const fx = fixture(t);
  fx.write("keep.txt", "keep");
  fx.write("remove-me.txt", "gone soon");
  const before = await capture(fx);

  fx.remove("remove-me.txt");
  fx.write("added.txt", "new");
  const after = await capture(fx);

  const result = compareWorkspaceBoundary(before, after);
  assert.equal(result.status, "dirty");
  if (result.status !== "dirty") return;
  assert.deepEqual(changedPaths(result.changes), ["added.txt", "remove-me.txt"]);
  const added = result.changes.find((c) => c.path === "added.txt");
  const removed = result.changes.find((c) => c.path === "remove-me.txt");
  assert.equal(added?.change, "added");
  assert.equal(added?.kind, "file");
  assert.equal(added?.afterDigest, sha256("new"));
  assert.equal(removed?.change, "removed");
  assert.equal(removed?.kind, "file");
  assert.equal(removed?.beforeDigest, sha256("gone soon"));
});

test("directory presence changes are detected", async (t) => {
  const fx = fixture(t);
  fx.write("dir-one/a.txt", "a");
  const before = await capture(fx);

  rmSync(join(fx.root, "dir-one"), { recursive: true, force: true });
  fx.write("dir-two/b.txt", "b");
  const after = await capture(fx);

  const result = compareWorkspaceBoundary(before, after);
  assert.equal(result.status, "dirty");
  if (result.status !== "dirty") return;
  assert.deepEqual(changedPaths(result.changes), ["dir-one", "dir-one/a.txt", "dir-two", "dir-two/b.txt"]);
  assert.deepEqual(
    result.changes.find((c) => c.path === "dir-one"),
    { rootIndex: 0, change: "removed", kind: "directory", path: "dir-one" },
  );
  assert.deepEqual(
    result.changes.find((c) => c.path === "dir-two"),
    { rootIndex: 0, change: "added", kind: "directory", path: "dir-two" },
  );
});

test("symlinks are snapshotted by target and never followed", async (t) => {
  const fx = fixture(t);
  const outside = mkdtempSync(join(tmpdir(), "cliyard-outside-"));
  t.after(() => rmSync(outside, { recursive: true, force: true }));
  const outsideFile = join(outside, "secret.txt");
  writeFileSync(outsideFile, "outside-content");

  fx.write("real.txt", "hello");
  const linkPath = join(fx.root, "link-x");
  symlinkSync(outsideFile, linkPath);

  const before = await capture(fx);
  const beforeEntry = [...before.entries.values()].find(
    (entry) => entry.path === "link-x",
  );
  assert.deepEqual(beforeEntry, {
    kind: "symlink",
    path: "link-x",
    digest: sha256(outsideFile),
  });

  // Mutating the target outside the protected root must not dirty the
  // boundary: the walk never followed the symlink.
  writeFileSync(outsideFile, "mutated-outside");
  const afterOutside = await capture(fx);
  assert.deepEqual(compareWorkspaceBoundary(before, afterOutside), {
    status: "clean",
    changes: [],
  });

  // Repointing the link at an in-root file is a modified symlink entry.
  unlinkSync(linkPath);
  symlinkSync(join(fx.root, "real.txt"), linkPath);
  const afterRepoint = await capture(fx);
  const repointResult = compareWorkspaceBoundary(before, afterRepoint);
  assert.equal(repointResult.status, "dirty");
  if (repointResult.status !== "dirty") return;
  assert.deepEqual(repointResult.changes, [
    {
      rootIndex: 0,
      change: "modified",
      kind: "symlink",
      path: "link-x",
      beforeDigest: sha256(outsideFile),
      afterDigest: sha256(join(fx.root, "real.txt")),
    },
  ]);

  // A kind change at the same path (symlink replaced by a file) is detected.
  unlinkSync(linkPath);
  fx.write("link-x", "now-a-file");
  const kindResult = compareWorkspaceBoundary(before, await capture(fx));
  assert.equal(kindResult.status, "dirty");
  if (kindResult.status !== "dirty") return;
  const kindChange = kindResult.changes.find((c) => c.path === "link-x");
  assert.equal(kindChange?.change, "modified");
  assert.equal(kindChange?.kind, "file");
  assert.equal(kindChange?.afterDigest, sha256("now-a-file"));
});

test("excluded control-plane paths never dirty the boundary", async (t) => {
  const fx = fixture(t);
  for (const rel of [
    ".cliyard/worktrees/w1/scratch.txt",
    ".cliyard/runtime/reaper.json",
    ".cliyard/worker-events/event.jsonl",
    ".cliyard/worker-leases/lease.json",
    ".cliyard/queue-events/queue.jsonl",
    ".cliyard/logs/run.log",
    ".cliyard/ledger.json",
  ]) {
    fx.write(rel, "mutable");
  }
  const protectedAuthority = [
    ".cliyard/contracts/plan.json",
    ".cliyard/queue.json",
    ".cliyard/runs/run-1.json",
  ];
  for (const rel of protectedAuthority) fx.write(rel, "protected");
  fx.write("src/app.ts", "protected source");
  const before = await capture(fx);

  for (const rel of [
    ".cliyard/worktrees/w1/scratch.txt",
    ".cliyard/worktrees/w2/new.txt",
    ".cliyard/runtime/reaper.json",
    ".cliyard/worker-events/event.jsonl",
    ".cliyard/worker-leases/lease.json",
    ".cliyard/queue-events/queue.jsonl",
    ".cliyard/logs/run.log",
    ".cliyard/ledger.json",
  ]) {
    fx.write(rel, "mutated by control plane");
  }
  const after = await capture(fx);
  assert.deepEqual(compareWorkspaceBoundary(before, after), {
    status: "clean",
    changes: [],
  });

  // Control authority files under .cliyard stay protected.
  for (const rel of protectedAuthority) {
    // Restore the baseline before mutating one authority file.
    for (const restore of protectedAuthority) fx.write(restore, "protected");
    fx.write(rel, "tampered");
    const tampered = compareWorkspaceBoundary(before, await capture(fx));
    assert.equal(tampered.status, "dirty", `expected dirty for ${rel}`);
    if (tampered.status !== "dirty") continue;
    assert.deepEqual(changedPaths(tampered.changes), [rel]);
  }
});

test("unreadable excluded directories are skipped, not inspected", async (t) => {
  const fx = fixture(t);
  fx.write("src/app.ts", "protected");
  fx.write(".cliyard/logs/run.log", "mutable");
  const logs = join(fx.root, ".cliyard", "logs");
  chmodSync(logs, 0o000);
  try {
    if (typeof process.getuid === "function" && process.getuid() === 0) {
      // Root bypasses permission bits; the assertion cannot hold.
      return;
    }
    const before = await capture(fx);
    const after = await capture(fx);
    assert.deepEqual(compareWorkspaceBoundary(before, after), {
      status: "clean",
      changes: [],
    });
  } finally {
    chmodSync(logs, 0o755);
  }
});

test("a configured ledger path is excluded from comparison", async (t) => {
  const fx = fixture(t);
  const ledgerAbs = join(fx.root, "state", "ledger.json");
  fx.write("state/ledger.json", "ledger-v1");
  fx.write("src/app.ts", "protected");
  const before = await capture(fx, { ledgerPath: ledgerAbs });

  fx.write("state/ledger.json", "ledger-v2");
  const result = compareWorkspaceBoundary(before, await capture(fx, { ledgerPath: ledgerAbs }));
  assert.deepEqual(result, { status: "clean", changes: [] });
});

test("important git state is protected while the rest of .git is excluded", async (t) => {
  const fx = fixture(t);
  fx.write(".git/HEAD", "ref: refs/heads/main\n");
  fx.write(".git/index", "index-bytes");
  fx.write(".git/packed-refs", "packed");
  fx.write(".git/config", "[core]");
  fx.write(".git/hooks/pre-commit", "#!/bin/sh");
  fx.write(".git/refs/heads/main", "0123456789abcdef");
  fx.write(".git/logs/HEAD", "log-entry");
  fx.write(".git/objects/ab/cdef0123", "object-blob");
  fx.write("src/app.ts", "source");

  const before = await capture(fx);
  const entryPaths = [...before.entries.values()].map((entry) => entry.path);
  assert.ok(entryPaths.includes(".git"));
  assert.ok(entryPaths.includes(".git/index"));
  assert.ok(entryPaths.includes(".git/hooks/pre-commit"));
  assert.ok(entryPaths.includes(".git/refs/heads/main"));
  assert.ok(!entryPaths.includes(".git/logs/HEAD"));
  assert.ok(!entryPaths.includes(".git/objects/ab/cdef0123"));

  // Objects and logs legitimately mutate without dirtying the boundary.
  fx.write(".git/logs/HEAD", "another-log-entry");
  fx.write(".git/objects/ab/cdef0123", "another-object");
  const afterMutableGit = await capture(fx);
  assert.deepEqual(compareWorkspaceBoundary(before, afterMutableGit), {
    status: "clean",
    changes: [],
  });

  // Each piece of important common-directory state is protected.
  const originalGitState = new Map<string, string>([
    [".git/HEAD", "ref: refs/heads/main\n"],
    [".git/index", "index-bytes"],
    [".git/packed-refs", "packed"],
    [".git/config", "[core]"],
    [".git/hooks/pre-commit", "#!/bin/sh"],
    [".git/refs/heads/main", "0123456789abcdef"],
  ]);
  for (const path of originalGitState.keys()) {
    // Restore every piece of state to the baseline before mutating one.
    for (const [statePath, content] of originalGitState) {
      fx.write(statePath, content);
    }
    fx.write(path, "tampered");
    const result = compareWorkspaceBoundary(before, await capture(fx));
    assert.equal(result.status, "dirty", `expected dirty for ${path}`);
    if (result.status !== "dirty") continue;
    assert.deepEqual(changedPaths(result.changes), [path]);
    const change = result.changes[0];
    assert.equal(change.change, "modified");
    assert.equal(change.kind, "file");
  }
});

test("changes are deterministically ordered", async (t) => {
  const fx = fixture(t);
  const before = await capture(fx);

  fx.write("zeta.txt", "z");
  fx.write("alpha.txt", "a");
  fx.write("mid/beta.txt", "b");
  const addedResult = compareWorkspaceBoundary(before, await capture(fx));
  assert.equal(addedResult.status, "dirty");
  if (addedResult.status !== "dirty") return;
  const addedPaths = changedPaths(addedResult.changes);
  assert.deepEqual(addedPaths, ["alpha.txt", "mid", "mid/beta.txt", "zeta.txt"]);
  assert.deepEqual(addedPaths, [...addedPaths].sort());

  // Comparison is a pure function of its inputs, so it is repeatable.
  const repeated = compareWorkspaceBoundary(before, await capture(fx));
  assert.deepEqual(repeated, addedResult);
});

test("extra-root changes are ordered after authority-root changes", async (t) => {
  const fx = fixture(t);
  const extra = mkdtempSync(join(tmpdir(), "cliyard-extra-"));
  t.after(() => rmSync(extra, { recursive: true, force: true }));
  const writeExtra = (rel: string, content = "x") => {
    const abs = join(extra, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  };
  fx.write("z-authority.txt", "z");
  writeExtra("a-extra.txt", "a");
  const before = await capture(fx, { extraRoots: [extra] });

  fx.write("z-authority.txt", "changed");
  writeExtra("a-extra.txt", "changed");
  const result = compareWorkspaceBoundary(before, await capture(fx, { extraRoots: [extra] }));
  assert.equal(result.status, "dirty");
  if (result.status !== "dirty") return;
  assert.deepEqual(result.changes, [
    {
      rootIndex: 0,
      change: "modified",
      kind: "file",
      path: "z-authority.txt",
      beforeDigest: sha256("z"),
      afterDigest: sha256("changed"),
    },
    {
      rootIndex: 1,
      change: "modified",
      kind: "file",
      path: "a-extra.txt",
      beforeDigest: sha256("a"),
      afterDigest: sha256("changed"),
    },
  ]);
});

test("normalizeEvidencePath rejects absolute, traversal and control-character paths", () => {
  assert.equal(normalizeEvidencePath("a/b"), "a/b");
  assert.equal(normalizeEvidencePath("a\\b"), "a/b");
  assert.equal(normalizeEvidencePath("./a//b/"), "a/b");
  assert.equal(normalizeEvidencePath("a/./b"), "a/b");
  for (const unsafe of [
    "",
    ".",
    "/abs/path",
    "//host/share",
    "a/../b",
    "../a",
    "..",
    "a\u0000b",
    "a\nb",
    "a\tb",
    "a\u007fb",
    "C:\\temp\\x",
    "D:/temp/x",
  ]) {
    assert.equal(normalizeEvidencePath(unsafe), undefined, JSON.stringify(unsafe));
  }
});

test("diagnostics are sanitized and capped", () => {
  assert.equal(sanitizeDiagnosticText("a\nb\u0007c", 2), "a\uFFFD");
  assert.equal(sanitizeDiagnosticText("plain", 100), "plain");
  assert.equal(sanitizeDiagnosticText(42, 5), "42");
});

test("duplicate and overlapping roots are deduplicated", async (t) => {
  const fx = fixture(t);
  fx.write("authority.txt", "a");

  // Identical duplicates are dropped.
  const duplicate = resolveWorkspaceBoundaryPolicy(
    fx.policy({ extraRoots: [fx.root, fx.root] }),
  );
  assert.equal(duplicate.roots.length, 1);

  // A root strictly inside another root is dropped.
  const nested = join(fx.root, "nested");
  const inside = resolveWorkspaceBoundaryPolicy(
    fx.policy({ extraRoots: [nested] }),
  );
  assert.deepEqual(inside.roots, [fx.root]);

  // Disjoint roots that contain the same relative path stay distinct.
  const extra = mkdtempSync(join(tmpdir(), "cliyard-overlap-"));
  t.after(() => rmSync(extra, { recursive: true, force: true }));
  const writeExtra = (rel: string, content: string) => {
    const abs = join(extra, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  };
  writeExtra("shared.txt", "extra-v1");
  const before = await capture(fx, { extraRoots: [extra] });
  fx.write("shared.txt", "authority-v1");
  writeExtra("shared.txt", "extra-v2");
  const result = compareWorkspaceBoundary(before, await capture(fx, { extraRoots: [extra] }));
  assert.equal(result.status, "dirty");
  if (result.status !== "dirty") return;
  assert.equal(result.changes.length, 2);
  assert.deepEqual(changedPaths(result.changes), ["shared.txt", "shared.txt"]);
  assert.deepEqual(
    result.changes.map((change) => change.rootIndex),
    [0, 1],
  );
  assert.equal(result.changes[0].afterDigest, sha256("authority-v1"));
  assert.equal(result.changes[1].afterDigest, sha256("extra-v2"));
});

test("missing, invalid and unreadable roots fail closed", async (t) => {
  const fx = fixture(t);
  fx.write("file.txt", "x");

  // Missing authority root.
  await assert.rejects(
    capture(fx, { authorityRoot: join(fx.root, "missing") }),
    (error: unknown) =>
      error instanceof WorkspaceBoundaryInspectionError &&
      /ENOENT/.test(error.message),
  );

  // Missing extra root.
  const missingExtra = mkdtempSync(join(tmpdir(), "cliyard-missing-"));
  rmSync(missingExtra, { recursive: true, force: true });
  await assert.rejects(
    capture(fx, { extraRoots: [missingExtra] }),
    (error: unknown) => error instanceof WorkspaceBoundaryInspectionError,
  );

  // A regular file is not a readable root.
  await assert.rejects(
    capture(fx, { authorityRoot: join(fx.root, "file.txt") }),
    (error: unknown) => error instanceof WorkspaceBoundaryInspectionError,
  );

  // Guard fails closed when recapture cannot inspect the root.
  const guard = new WorkspaceBoundaryGuard(fx.policy());
  await guard.capture();
  rmSync(fx.root, { recursive: true, force: true });
  const result = await guard.compare();
  assert.equal(result.status, "inspection_failed");
  if (result.status !== "inspection_failed") return;
  assert.ok(result.error.length > 0);
  assert.deepEqual(result.changes, []);

  // A guard that never captured also fails closed.
  const fresh = new WorkspaceBoundaryGuard(fx.policy());
  const uncaptured = await fresh.compare();
  assert.equal(uncaptured.status, "inspection_failed");
});

test("unreadable subdirectory fails closed", async (t) => {
  const fx = fixture(t);
  fx.write("locked/secret.txt", "x");
  const locked = join(fx.root, "locked");
  chmodSync(locked, 0o000);
  try {
    if (typeof process.getuid === "function" && process.getuid() === 0) {
      // Root bypasses permission bits; the assertion cannot hold.
      return;
    }
    await assert.rejects(
      capture(fx),
      (error: unknown) => error instanceof WorkspaceBoundaryInspectionError,
    );
  } finally {
    chmodSync(locked, 0o755);
  }
});

test("entry and path caps fail closed", async (t) => {
  const fx = fixture(t);
  fx.write("a.txt", "a");
  fx.write("b.txt", "b");
  fx.write("c.txt", "c");

  await assert.rejects(
    capture(fx, { caps: { maxEntriesPerRoot: 2 } }),
    (error: unknown) =>
      error instanceof WorkspaceBoundaryInspectionError &&
      /entry cap/.test(error.message),
  );

  await assert.rejects(
    capture(fx, { caps: { maxPathLength: 3 } }),
    (error: unknown) =>
      error instanceof WorkspaceBoundaryInspectionError &&
      /path exceeds cap/.test(error.message),
  );

  await assert.rejects(
    capture(fx, { caps: { maxEntriesPerRoot: 0 } }),
    (error: unknown) => error instanceof WorkspaceBoundaryPolicyError,
  );
  await assert.rejects(
    capture(fx, { caps: { maxChanges: -1 } }),
    (error: unknown) => error instanceof WorkspaceBoundaryPolicyError,
  );
});

test("change record cap fails closed with bounded evidence", async (t) => {
  const fx = fixture(t);
  fx.write("a.txt", "a-v1");
  fx.write("b.txt", "b-v1");
  const before = await capture(fx);

  fx.write("a.txt", "a-v2");
  fx.write("b.txt", "b-v2");
  fx.write("c.txt", "c-v1");
  const after = await capture(fx);

  const result = compareWorkspaceBoundary(before, after, { maxChanges: 2 });
  assert.equal(result.status, "inspection_failed");
  if (result.status !== "inspection_failed") return;
  assert.match(result.error, /change record cap exceeded: 3 changes/);
  assert.equal(result.changes.length, 2);
  assert.deepEqual(changedPaths(result.changes), ["a.txt", "b.txt"]);
});

test("unsafe entry names and unsafe policies are rejected", async (t) => {
  const fx = fixture(t);
  fx.write("bad\nname.txt", "x");
  await assert.rejects(
    capture(fx),
    (error: unknown) => error instanceof WorkspaceBoundaryInspectionError,
  );

  const safe = fixture(t);
  safe.write("ok.txt", "x");
  assert.throws(
    () => resolveWorkspaceBoundaryPolicy(safe.policy({ excludedPaths: ["../escape"] })),
    WorkspaceBoundaryPolicyError,
  );
  assert.throws(
    () => resolveWorkspaceBoundaryPolicy(safe.policy({ excludedPaths: ["/etc"] })),
    WorkspaceBoundaryPolicyError,
  );
  assert.throws(
    () => resolveWorkspaceBoundaryPolicy(safe.policy({ authorityRoot: "relative" })),
    WorkspaceBoundaryPolicyError,
  );
  assert.throws(
    () => resolveWorkspaceBoundaryPolicy(safe.policy({ extraRoots: ["relative"] })),
    WorkspaceBoundaryPolicyError,
  );
});

test("comparison over different roots fails closed", async (t) => {
  const first = fixture(t);
  const second = fixture(t);
  first.write("a.txt", "x");
  second.write("a.txt", "x");
  const result = compareWorkspaceBoundary(await capture(first), await capture(second));
  assert.equal(result.status, "inspection_failed");
});

test("comparison rejects unsafe snapshot evidence", async (t) => {
  const fx = fixture(t);
  const clean = await capture(fx);
  const unsafeEntry: WorkspaceBoundarySnapshot = {
    roots: [...clean.roots],
    entries: new Map([
      ["000000\u0000/absolute", {
        kind: "file",
        path: "/absolute",
        digest: sha256("x"),
      }],
    ]),
  };
  const result = compareWorkspaceBoundary(clean, unsafeEntry);
  assert.equal(result.status, "inspection_failed");
  if (result.status !== "inspection_failed") return;
  assert.match(result.error, /unsafe snapshot entry path/);
});

test("snapshots and evidence retain digests only, never file contents", async (t) => {
  const fx = fixture(t);
  const secret = "SECRET-CONTENT-9f28ab";
  fx.write("secret.txt", secret);
  const before = await capture(fx);

  const serializedSnapshot = JSON.stringify([...before.entries.values()]);
  assert.ok(!serializedSnapshot.includes(secret));
  assert.equal(
    [...before.entries.values()].find((entry) => entry.path === "secret.txt")
      ?.digest,
    sha256(secret),
  );

  fx.write("secret.txt", "OTHER-SECRET-11aa");
  const result = compareWorkspaceBoundary(before, await capture(fx));
  assert.equal(result.status, "dirty");
  if (result.status !== "dirty") return;
  const serializedChanges = JSON.stringify(result.changes);
  assert.ok(!serializedChanges.includes("SECRET-CONTENT-9f28ab"));
  assert.ok(!serializedChanges.includes("OTHER-SECRET-11aa"));
  assert.equal(result.changes[0].beforeDigest, sha256(secret));
  assert.equal(result.changes[0].afterDigest, sha256("OTHER-SECRET-11aa"));
});

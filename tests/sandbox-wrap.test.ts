import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  NONO_PINNED_VERSION,
  NonoSandboxAdapter,
  applySandboxWrapToSpawn,
  buildNonoWrapCommand,
  buildSandboxReport,
  measureNonoFilesystemEnforcement,
  sandboxCapabilityGaps,
  writeNonEnforcingNonoStub,
} from "../src/sandbox/index.js";

test("buildNonoWrapCommand shapes silent allow/read wrap argv", () => {
  const wrapped = buildNonoWrapCommand({
    nonoBinary: "/opt/nono",
    allowDirs: ["/ws"],
    readDirs: ["/repo"],
    command: "codex",
    args: ["exec", "-m", "x", "prompt"],
  });
  assert.equal(wrapped.command, "/opt/nono");
  assert.deepEqual(wrapped.args, [
    "wrap",
    "-s",
    "--allow-cwd",
    "-a",
    "/ws",
    "-r",
    "/repo",
    "--",
    "codex",
    "exec",
    "-m",
    "x",
    "prompt",
  ]);
});

test("applySandboxWrapToSpawn only wraps prepared nono reports", () => {
  const prepared = buildSandboxReport({
    capabilities: {
      backendType: "nono",
      backendVersion: NONO_PINNED_VERSION,
      filesystemIsolation: "partial",
      networkIsolation: "unsupported",
      credentialIsolation: "unsupported",
      notes: ["n"],
    },
    status: "prepared",
    capturedAt: "2026-11-06T00:00:00.000Z",
  });
  const wrapped = applySandboxWrapToSpawn("claude", ["-p", "hi"], {
    report: prepared,
    workspaceRoot: "/ws",
    repoRoot: "/repo",
    nonoBinary: "nono",
  });
  assert.equal(wrapped.command, "nono");
  assert.ok(wrapped.args.includes("wrap"));
  assert.ok(wrapped.args.includes("/ws"));

  const refused = buildSandboxReport({
    capabilities: prepared.capabilities,
    status: "refused",
    capturedAt: "2026-11-06T00:00:00.000Z",
  });
  const unchanged = applySandboxWrapToSpawn("claude", ["-p", "hi"], {
    report: refused,
    workspaceRoot: "/ws",
  });
  assert.equal(unchanged.command, "claude");
  assert.deepEqual(unchanged.args, ["-p", "hi"]);
});

test("non-enforcing stub measurement reports enforced=false", () => {
  const dir = mkdtempSync(join(tmpdir(), "cliyard-nono-stub-"));
  const bin = join(dir, "nono");
  try {
    writeNonEnforcingNonoStub(bin);
    const measured = measureNonoFilesystemEnforcement({ binaryPath: bin });
    assert.equal(measured.enforced, false);
    assert.equal(measured.allowWriteOk, true);
    assert.equal(measured.denyWriteHeld, false);
    assert.match(measured.detail, /outside-allow write persisted|Landlock/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("gate refuses partial isolation when measurement leaves filesystem unsupported", () => {
  const adapter = NonoSandboxAdapter.create({
    probe: () => ({
      available: true,
      version: NONO_PINNED_VERSION,
      binaryPath: "/tmp/x",
      detail: "ok",
    }),
    measureFilesystem: () => ({
      enforced: false,
      detail: "no Landlock on this host",
    }),
  });
  const gaps = sandboxCapabilityGaps(adapter.capabilities(), {
    filesystemIsolation: "partial",
  });
  assert.ok(gaps.length >= 1);
  assert.match(gaps[0]!, /filesystemIsolation requires partial/);
});

test("injected enforced measurement keeps partial capability", () => {
  const adapter = NonoSandboxAdapter.create({
    probe: () => ({
      available: true,
      version: NONO_PINNED_VERSION,
      binaryPath: "/tmp/x",
      detail: "ok",
    }),
    measureFilesystem: () => ({ enforced: true, detail: "ok" }),
  });
  assert.equal(adapter.capabilities().filesystemIsolation, "partial");
  assert.equal(
    sandboxCapabilityGaps(adapter.capabilities(), {
      filesystemIsolation: "partial",
    }).length,
    0,
  );
});

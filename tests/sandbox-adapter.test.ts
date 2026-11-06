import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  NONO_PINNED_VERSION,
  NonoSandboxAdapter,
  UnavailableSandboxAdapter,
  buildSandboxReport,
  isSandboxReport,
  probeNonoBinary,
  sandboxAdapterSatisfies,
  sandboxCapabilityGaps,
  selectSandboxAdapter,
  unavailableSandboxCapabilities,
} from "../src/sandbox/index.js";
import { buildEvidenceBundle } from "../src/supervisor/evidence-bundle.js";
import type { RunManifest } from "../src/supervisor/types.js";

test("capability gate refuses silent downgrade", () => {
  const caps = unavailableSandboxCapabilities();
  const gaps = sandboxCapabilityGaps(caps, {
    filesystemIsolation: "full",
  });
  assert.equal(gaps.length, 1);
  assert.match(gaps[0]!, /filesystemIsolation requires full/);
  assert.equal(
    sandboxCapabilityGaps(caps, { filesystemIsolation: "unsupported" }).length,
    0,
  );
});

test("unavailable prepare reports ok=false and unavailable status", async () => {
  const adapter = new UnavailableSandboxAdapter("test unavailable");
  const result = await adapter.prepare({
    workspaceRoot: "/tmp/ws",
    repoRoot: "/tmp/repo",
    requirements: { filesystemIsolation: "full" },
    now: () => "2026-11-06T00:00:00.000Z",
  });
  assert.equal(result.ok, false);
  assert.equal(result.report.status, "unavailable");
  assert.ok(result.report.gaps.length >= 1);
  assert.equal(isSandboxReport(result.report), true);
});

test("nono pin mismatch yields unavailable adapter", () => {
  const adapter = NonoSandboxAdapter.create({
    probe: () => ({
      available: true,
      version: "0.1.0",
      binaryPath: "/tmp/fake-nono",
      detail: "fake",
    }),
  });
  assert.equal(adapter.capabilities().backendType, "unavailable");
  assert.match(
    adapter.capabilities().notes[0] ?? "",
    /does not match pin/,
  );
});

test("pinned nono with measured enforcement declares partial isolation", async () => {
  const adapter = NonoSandboxAdapter.create({
    probe: () => ({
      available: true,
      version: NONO_PINNED_VERSION,
      binaryPath: "/tmp/fake-nono",
      detail: "pinned",
    }),
    measureFilesystem: () => ({
      enforced: true,
      detail: "test measured ok",
    }),
  });
  assert.equal(adapter.capabilities().backendType, "nono");
  assert.equal(adapter.capabilities().backendVersion, NONO_PINNED_VERSION);
  assert.equal(adapter.capabilities().filesystemIsolation, "partial");
  assert.equal(
    sandboxAdapterSatisfies(adapter, { filesystemIsolation: "partial" }),
    true,
  );
  assert.equal(
    sandboxAdapterSatisfies(adapter, { filesystemIsolation: "full" }),
    false,
  );
  const prepared = await adapter.prepare({
    workspaceRoot: "/tmp/ws",
    repoRoot: "/tmp/repo",
    requirements: { filesystemIsolation: "partial" },
    policyBytes: '{"allow":["workspace"]}',
    now: () => "2026-11-06T00:00:00.000Z",
  });
  assert.equal(prepared.ok, true);
  assert.equal(prepared.report.status, "prepared");
  assert.match(prepared.report.policyHash ?? "", /^[0-9a-f]{64}$/);
});

test("pinned nono without enforcement declares filesystem unsupported", async () => {
  const adapter = NonoSandboxAdapter.create({
    probe: () => ({
      available: true,
      version: NONO_PINNED_VERSION,
      binaryPath: "/tmp/fake-nono",
      detail: "pinned",
    }),
    measureFilesystem: () => ({
      enforced: false,
      detail: "no Landlock",
    }),
  });
  assert.equal(adapter.capabilities().filesystemIsolation, "unsupported");
  assert.equal(
    sandboxAdapterSatisfies(adapter, { filesystemIsolation: "partial" }),
    false,
  );
  const prepared = await adapter.prepare({
    workspaceRoot: "/tmp/ws",
    repoRoot: "/tmp/repo",
    requirements: { filesystemIsolation: "partial" },
  });
  assert.equal(prepared.ok, false);
  assert.equal(prepared.report.status, "refused");
});

test("selectSandboxAdapter can force unavailable", () => {
  const adapter = selectSandboxAdapter({ preferNono: false });
  assert.equal(adapter.capabilities().backendType, "unavailable");
});

test("fake nono binary probe parses semver from --version", () => {
  const dir = mkdtempSync(join(tmpdir(), "cliyard-nono-probe-"));
  const bin = join(dir, "nono");
  try {
    writeFileSync(
      bin,
      "#!/bin/sh\necho \"nono ${1:-} 0.81.0 (test)\"\n",
      "utf8",
    );
    chmodSync(bin, 0o755);
    const probe = probeNonoBinary(bin);
    assert.equal(probe.available, true);
    assert.equal(probe.version, NONO_PINNED_VERSION);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("SandboxReport on RunManifest projects into EvidenceBundle", () => {
  const report = buildSandboxReport({
    capabilities: unavailableSandboxCapabilities("fixture"),
    status: "unavailable",
    capturedAt: "2026-11-06T00:00:00.000Z",
  });
  const manifest: RunManifest = {
    version: 1,
    runId: "run-sandbox",
    planId: "plan",
    repoRoot: "/tmp/repo",
    contractsPath: "design/x.contracts.json",
    contractsHash: "a".repeat(64),
    baseCommit: "b".repeat(40),
    integrationBranch: "branch",
    integrationHead: "c".repeat(40),
    status: "blocked",
    createdAt: "2026-11-06T00:00:00.000Z",
    updatedAt: "2026-11-06T00:00:00.000Z",
    owner: { pid: 1, host: "host" },
    tasks: {
      t1: {
        taskId: "t1",
        status: "blocked",
        accepted: false,
        reason: "sandbox refused",
        sandbox: report,
      },
    },
  };
  const bundle = buildEvidenceBundle(manifest, {
    facts: {
      repoRoot: "/tmp/repo",
      headCommit: "c".repeat(40),
      branch: "branch",
    },
  });
  assert.equal(bundle.tasks[0]!.sandbox?.backendType, "unavailable");
  assert.equal(bundle.tasks[0]!.sandbox?.status, "unavailable");
});

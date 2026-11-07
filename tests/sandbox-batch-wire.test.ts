import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { createCodexAdapter } from "../src/agents/codex.js";
import type { TaskContract } from "../src/contracts/schema.js";
import {
  NONO_PINNED_VERSION,
  NonoSandboxAdapter,
  UnavailableSandboxAdapter,
  createSandboxRefusalFailure,
  isWorkerSandboxEnabled,
  prepareWorkerSandbox,
  wrapWorkerCommand,
} from "../src/sandbox/index.js";

function initRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), "cliyard-p3c-"));
  const git = (args: string[]) => {
    const r = spawnSync("git", args, {
      cwd: repo,
      encoding: "utf8",
    });
    assert.equal(r.status, 0, r.stderr || r.stdout);
    return (r.stdout || "").trim();
  };
  git(["init"]);
  git(["config", "user.email", "p3c@example.com"]);
  git(["config", "user.name", "p3c"]);
  writeFileSync(join(repo, "README.md"), "p3c\n", "utf8");
  git(["add", "."]);
  git(["commit", "-m", "init"]);
  return repo;
}

function fixtureContract(baseCommit: string): TaskContract {
  return {
    taskId: "sandbox-batch-wire",
    version: 1,
    frozen: true,
    goals: ["noop"],
    nonGoals: [],
    dependsOn: [],
    readPaths: ["README.md"],
    writePaths: ["src/"],
    sharedResources: [],
    baseCommit,
    verifyCommands: ["true"],
    deliverables: ["noop"],
    forbidden: [],
    maxRepairs: 0,
  };
}

test("isWorkerSandboxEnabled respects explicit flag and CLIYARD_SANDBOX", () => {
  assert.equal(isWorkerSandboxEnabled({ enabled: true }), true);
  assert.equal(isWorkerSandboxEnabled({ enabled: false }, { CLIYARD_SANDBOX: "1" }), false);
  assert.equal(isWorkerSandboxEnabled(undefined, { CLIYARD_SANDBOX: "1" }), true);
  assert.equal(isWorkerSandboxEnabled(undefined, { CLIYARD_SANDBOX: "true" }), true);
  assert.equal(isWorkerSandboxEnabled(undefined, {}), false);
});

test("prepareWorkerSandbox refuses unavailable adapter when enabled", async () => {
  const prepared = await prepareWorkerSandbox({
    workspaceRoot: "/tmp/ws",
    options: {
      enabled: true,
      createAdapter: () => new UnavailableSandboxAdapter("fixture unavailable"),
    },
  });
  assert.ok(prepared);
  assert.equal(prepared!.ok, false);
  assert.equal(prepared!.wrap, undefined);
  assert.ok(prepared!.report.status === "refused" || prepared!.report.status === "unavailable");
  const failure = createSandboxRefusalFailure(prepared!.report);
  assert.equal(failure.category, "policy_blocked");
  assert.equal(failure.code, "sandbox_refused");
  assert.equal(failure.retryableHint, false);
});

test("prepareWorkerSandbox wraps argv when prepare succeeds", async () => {
  const prepared = await prepareWorkerSandbox({
    workspaceRoot: "/ws",
    options: {
      enabled: true,
      repoRoot: "/repo",
      nonoBinary: "/opt/nono",
      createAdapter: () =>
        NonoSandboxAdapter.create({
          binaryPath: "/opt/nono",
          probe: () => ({
            available: true,
            version: NONO_PINNED_VERSION,
            binaryPath: "/opt/nono",
            detail: "ok",
          }),
          measureFilesystem: () => ({ enforced: true, detail: "ok" }),
        }),
    },
  });
  assert.ok(prepared);
  assert.equal(prepared!.ok, true);
  assert.equal(prepared!.report.status, "prepared");
  const wrapped = wrapWorkerCommand("codex", ["exec", "hi"], prepared!);
  assert.equal(wrapped.command, "/opt/nono");
  assert.ok(wrapped.args.includes("wrap"));
  assert.ok(wrapped.args.includes("/ws"));
  assert.ok(wrapped.args.includes("/repo"));
  assert.ok(wrapped.args.includes("codex"));
});

test("codex adapter fails closed when sandbox prepare refuses", async () => {
  const repo = initRepo();
  const binaries = mkdtempSync(join(tmpdir(), "cliyard-p3c-bin-"));
  try {
    const binary = join(binaries, "codex");
    writeFileSync(binary, "#!/bin/sh\nexit 0\n");
    chmodSync(binary, 0o755);
    const base = spawnSync("git", ["rev-parse", "HEAD"], {
      cwd: repo,
      encoding: "utf8",
    }).stdout!.trim();
    const worker = createCodexAdapter({
      binary,
      cwd: repo,
      model: "fixture",
      sandbox: {
        enabled: true,
        createAdapter: () =>
          new UnavailableSandboxAdapter("p3c refuse fixture"),
      },
    });
    const { sessionId } = await worker.start({
      contract: fixtureContract(base),
      attempt: 0,
    });
    const result = await worker.collect(sessionId);
    assert.equal(result.exitCode, 1);
    assert.equal(result.failure?.code, "sandbox_refused");
    assert.equal(result.failure?.category, "policy_blocked");
    assert.ok(result.sandbox);
    assert.notEqual(result.sandbox!.status, "prepared");
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(binaries, { recursive: true, force: true });
  }
});

test("codex adapter attaches prepared sandbox report on success", async () => {
  const repo = initRepo();
  const binaries = mkdtempSync(join(tmpdir(), "cliyard-p3c-bin-"));
  try {
    const binary = join(binaries, "codex");
    writeFileSync(binary, "#!/bin/sh\nexit 0\n");
    chmodSync(binary, 0o755);
    // Stub nono that execs the wrapped child after `--` so wrap is exercised
    // without requiring Landlock for this unit fixture.
    const nonoStub = join(binaries, "nono");
    writeFileSync(
      nonoStub,
      [
        "#!/bin/sh",
        `if [ "$1" = "--version" ]; then echo "nono ${NONO_PINNED_VERSION}"; exit 0; fi`,
        'while [ "$#" -gt 0 ]; do',
        '  if [ "$1" = "--" ]; then shift; exec "$@"; fi',
        "  shift",
        "done",
        "exit 1",
        "",
      ].join("\n"),
    );
    chmodSync(nonoStub, 0o755);
    const base = spawnSync("git", ["rev-parse", "HEAD"], {
      cwd: repo,
      encoding: "utf8",
    }).stdout!.trim();
    const worker = createCodexAdapter({
      binary,
      cwd: repo,
      model: "fixture",
      sandbox: {
        enabled: true,
        nonoBinary: nonoStub,
        createAdapter: () =>
          NonoSandboxAdapter.create({
            binaryPath: nonoStub,
            probe: () => ({
              available: true,
              version: NONO_PINNED_VERSION,
              binaryPath: nonoStub,
              detail: "ok",
            }),
            measureFilesystem: () => ({ enforced: true, detail: "ok" }),
          }),
      },
    });
    const { sessionId } = await worker.start({
      contract: fixtureContract(base),
      attempt: 0,
    });
    const result = await worker.collect(sessionId);
    assert.equal(result.exitCode, 0, result.logTail);
    assert.ok(result.sandbox);
    assert.equal(result.sandbox!.status, "prepared");
    assert.equal(result.sandbox!.capabilities.filesystemIsolation, "partial");
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(binaries, { recursive: true, force: true });
  }
});

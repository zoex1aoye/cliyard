/**
 * cliyard mvp-* CLI — M1 idle-spin, M2 dispose, M3 compile/freeze.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { compileMvpPlan } from "./compile.js";
import { runMvpDemo } from "./demo.js";
import {
  freezeContract,
  stableStringify,
  writeFrozenContract,
} from "./freeze.js";
import { runIdleSpinFromFile } from "./idle-spin.js";

function arg(flag: string, argv: string[]): string | undefined {
  const i = argv.indexOf(flag);
  if (i >= 0 && argv[i + 1] && !argv[i + 1]!.startsWith("--")) {
    return argv[i + 1];
  }
  const eq = argv.find((item) => item.startsWith(`${flag}=`));
  return eq?.slice(flag.length + 1);
}

function usage(): never {
  console.log(`cliyard mvp-test — M1 idle-spin + M2 dispose probe

Usage:
  cliyard mvp-test --repo <git-repo> [contract.json]
                   [--replace-existing] [--cancel-after-ms N] [--json]

Default contract: examples/mvp/code-local-cli.mock.contract.json

Spawns driver.argv with cwd = absolute worktree path (never repoRoot).
--cancel-after-ms aborts the child (process group) after N milliseconds.
`);
  process.exit(1);
}

export async function runMvpTestCli(argv: string[]): Promise<void> {
  if (argv.includes("-h") || argv.includes("--help")) usage();
  const json = argv.includes("--json");
  const replaceExisting = argv.includes("--replace-existing");
  const repo = arg("--repo", argv);
  if (!repo) {
    console.error("mvp-test requires --repo <git-repo>");
    process.exitCode = 1;
    return;
  }

  const cancelRaw = arg("--cancel-after-ms", argv);
  const cancelAfterMs =
    cancelRaw !== undefined ? Number(cancelRaw) : undefined;
  if (
    cancelRaw !== undefined &&
    (!Number.isFinite(cancelAfterMs) || (cancelAfterMs as number) < 0)
  ) {
    console.error("--cancel-after-ms must be a non-negative number");
    process.exitCode = 1;
    return;
  }

  let contractPath = "examples/mvp/code-local-cli.mock.contract.json";
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--repo" || a === "--cancel-after-ms") {
      i += 1;
      continue;
    }
    if (a.startsWith("--repo=") || a.startsWith("--cancel-after-ms=")) continue;
    if (a === "--json" || a === "--replace-existing") continue;
    if (a.startsWith("-")) continue;
    contractPath = a;
    break;
  }

  const controller = new AbortController();
  let cancelTimer: ReturnType<typeof setTimeout> | undefined;
  if (cancelAfterMs !== undefined) {
    cancelTimer = setTimeout(() => controller.abort(), cancelAfterMs);
  }

  try {
    const result = await runIdleSpinFromFile({
      repoRoot: resolve(repo),
      contractPath: resolve(contractPath),
      replaceExisting,
      signal: controller.signal,
    });
    if (json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log(
        [
          result.ok ? "mvp-test: ok" : "mvp-test: failed",
          `  contract:   ${result.contractId}`,
          `  target:     ${result.target}`,
          `  worktree:   ${result.worktreePath}`,
          `  spawnCwd:   ${result.spawnCwd}`,
          `  spawnExit:  ${result.spawnExitCode}`,
          `  spawnPid:   ${result.spawnPid ?? "-"}`,
          `  disposed:   ${result.disposed}`,
          `  trunkClean: ${result.trunkClean}`,
          `  kept:       ${result.keptWorkspace}`,
          ...(result.error ? [`  error:      ${result.error}`] : []),
        ].join("\n"),
      );
    }
    // Dispose probe: success means the child was cancelled and is gone.
    if (cancelAfterMs !== undefined) {
      const disposeOk =
        result.disposed === true &&
        result.dispose?.aliveAfter === false;
      if (!disposeOk) process.exitCode = 1;
      else if (!json) {
        console.log("mvp-test: dispose probe ok (child dead)");
      }
      return;
    }
    if (!result.ok) process.exitCode = 1;
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    if (json) {
      console.log(JSON.stringify({ ok: false, error: detail }, null, 2));
    } else {
      console.error(`mvp-test: ${detail}`);
    }
    process.exitCode = 1;
  } finally {
    if (cancelTimer) clearTimeout(cancelTimer);
  }
}

function compileUsage(): never {
  console.log(`cliyard mvp-compile — M3 Plan → unfrozen TaskContract draft(s)

Usage:
  cliyard mvp-compile <plan.json> --out <dir> [--json]

Writes one draft JSON per task (frozen=false). Does not dispatch.
`);
  process.exit(1);
}

export async function runMvpCompileCli(argv: string[]): Promise<void> {
  if (argv.includes("-h") || argv.includes("--help")) compileUsage();
  const json = argv.includes("--json");
  const out = arg("--out", argv);
  if (!out) {
    console.error("mvp-compile requires --out <dir>");
    process.exitCode = 1;
    return;
  }
  let planPath: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--out") {
      i += 1;
      continue;
    }
    if (a.startsWith("--out=")) continue;
    if (a === "--json") continue;
    if (a.startsWith("-")) continue;
    planPath = a;
    break;
  }
  if (!planPath) {
    console.error("mvp-compile requires <plan.json>");
    process.exitCode = 1;
    return;
  }
  try {
    const raw = JSON.parse(readFileSync(resolve(planPath), "utf8"));
    const { planId, drafts } = compileMvpPlan(raw);
    const outDir = resolve(out);
    mkdirSync(outDir, { recursive: true });
    const written: string[] = [];
    for (const draft of drafts) {
      const path = join(outDir, `${draft.contractId}.draft.contract.json`);
      writeFileSync(path, stableStringify(draft), "utf8");
      written.push(path);
    }
    const summary = { ok: true, planId, drafts: written, frozen: false };
    if (json) console.log(JSON.stringify(summary, null, 2));
    else {
      console.log(
        [
          "mvp-compile: ok",
          `  planId: ${planId}`,
          `  drafts: ${written.length}`,
          ...written.map((p) => `    ${p}`),
        ].join("\n"),
      );
    }
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    if (json) console.log(JSON.stringify({ ok: false, error: detail }, null, 2));
    else console.error(`mvp-compile: ${detail}`);
    process.exitCode = 1;
  }
}

function demoUsage(): never {
  console.log(`cliyard mvp-demo — M4 dual-scene demos (code + novel)

Usage:
  cliyard mvp-demo --repo <git-repo> [--json] [--no-replace]
                   [plan.json ...]

Default plans: examples/mvp/code-codex.plan.json + novel-ep1.plan.json
Runs compile → freeze → idle-spin for each plan; writes
.cliyard/mvp-demo/status.json. Does not merge to main.
`);
  process.exit(1);
}

export async function runMvpDemoCli(argv: string[]): Promise<void> {
  if (argv.includes("-h") || argv.includes("--help")) demoUsage();
  const json = argv.includes("--json");
  const replaceExisting = !argv.includes("--no-replace");
  const repo = arg("--repo", argv);
  if (!repo) {
    console.error("mvp-demo requires --repo <git-repo>");
    process.exitCode = 1;
    return;
  }
  const plans: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--repo") {
      i += 1;
      continue;
    }
    if (a.startsWith("--repo=")) continue;
    if (a === "--json" || a === "--no-replace") continue;
    if (a.startsWith("-")) continue;
    plans.push(a);
  }
  try {
    const result = await runMvpDemo({
      repoRoot: resolve(repo),
      ...(plans.length ? { planPaths: plans } : {}),
      replaceExisting,
    });
    if (json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log(
        [
          result.ok ? "mvp-demo: ok" : "mvp-demo: failed",
          `  status: ${result.statusPath}`,
          ...result.scenes.map(
            (s) =>
              `  - ${s.scene}/${s.contractId} ok=${s.ok} target=${s.target}` +
              (s.codexMode ? ` codexMode=${s.codexMode}` : "") +
              (s.error ? ` err=${s.error}` : ""),
          ),
        ].join("\n"),
      );
    }
    if (!result.ok) process.exitCode = 1;
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    if (json) console.log(JSON.stringify({ ok: false, error: detail }, null, 2));
    else console.error(`mvp-demo: ${detail}`);
    process.exitCode = 1;
  }
}

function freezeUsage(): never {
  console.log(`cliyard mvp-freeze — M3 human freeze of a TaskContract draft

Usage:
  cliyard mvp-freeze <draft.contract.json> --out <frozen.contract.json> [--json]

Sets frozen=true + frozenAt, validates schema, writes bytes + .sha256 sidecar.
Does not dispatch.
`);
  process.exit(1);
}

export async function runMvpFreezeCli(argv: string[]): Promise<void> {
  if (argv.includes("-h") || argv.includes("--help")) freezeUsage();
  const json = argv.includes("--json");
  const out = arg("--out", argv);
  if (!out) {
    console.error("mvp-freeze requires --out <frozen.contract.json>");
    process.exitCode = 1;
    return;
  }
  let draftPath: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--out") {
      i += 1;
      continue;
    }
    if (a.startsWith("--out=")) continue;
    if (a === "--json") continue;
    if (a.startsWith("-")) continue;
    draftPath = a;
    break;
  }
  if (!draftPath) {
    console.error("mvp-freeze requires <draft.contract.json>");
    process.exitCode = 1;
    return;
  }
  try {
    const raw = JSON.parse(readFileSync(resolve(draftPath), "utf8"));
    const frozen = freezeContract(raw);
    const written = writeFrozenContract({
      contract: frozen,
      outPath: resolve(out),
    });
    const summary = {
      ok: true,
      contractId: frozen.contractId,
      frozen: true,
      frozenAt: frozen.frozenAt,
      path: written.path,
      hashPath: written.hashPath,
      sha256: written.sha256,
    };
    if (json) console.log(JSON.stringify(summary, null, 2));
    else {
      console.log(
        [
          "mvp-freeze: ok",
          `  contract: ${frozen.contractId}`,
          `  frozenAt: ${frozen.frozenAt}`,
          `  path:     ${written.path}`,
          `  sha256:   ${written.sha256}`,
        ].join("\n"),
      );
    }
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    if (json) console.log(JSON.stringify({ ok: false, error: detail }, null, 2));
    else console.error(`mvp-freeze: ${detail}`);
    process.exitCode = 1;
  }
}

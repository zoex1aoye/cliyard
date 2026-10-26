import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { updateLedger, loadLedger } from "../src/persistence/ledger.js";

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

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadContractJson } from "../src/contracts/schema.js";
import { assembleBriefing, writeBriefingFile } from "../src/context/assemble.js";

const contract = loadContractJson(
  readFileSync(new URL("../examples/mock.contract.json", import.meta.url), "utf8"),
);

test("assembleBriefing includes goals, paths, verify, forbidden", () => {
  const md = assembleBriefing(contract, {
    contractFiles: ["docs/reqs/module.md"],
    priorOutcomes: ["api: accepted"],
    repoHint: "~/work/my-app",
  });
  assert.match(md, /# Briefing: spike-hello/);
  assert.match(md, /hello helper/);
  assert.match(md, /src\/hello\//);
  assert.match(md, /npm test -- --grep hello/);
  assert.match(md, /git push/);
  assert.match(md, /docs\/reqs\/module\.md/);
  assert.match(md, /api: accepted/);
  assert.match(md, /independent verifier/);
});

test("writeBriefingFile writes briefing/<taskId>.md", () => {
  const dir = mkdtempSync(join(tmpdir(), "cliyard-brief-"));
  const briefingDir = join(dir, "briefing");
  try {
    const path = writeBriefingFile(contract, briefingDir);
    assert.equal(path, join(briefingDir, "spike-hello.md"));
    assert.ok(existsSync(path));
    const body = readFileSync(path, "utf8");
    assert.match(body, /# Briefing: spike-hello/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

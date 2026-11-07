import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MASTER_PERSONA_SECTION_NAME,
  loadMasterPersonaText,
  mountMasterPersona,
} from "../src/mvp/index.js";

test("loadMasterPersonaText returns Master law body", () => {
  const text = loadMasterPersonaText();
  assert.match(text, /cliyard Master/);
  assert.match(text, /不是实现 Worker/);
  assert.match(text, /本机 CLI/);
  assert.doesNotMatch(text, /^\s*$/);
});

test("mountMasterPersona no-ops without systemPrompt", () => {
  const result = mountMasterPersona({ systemPrompt: null });
  assert.equal(result.mounted, false);
  assert.equal(result.sectionName, MASTER_PERSONA_SECTION_NAME);
});

test("mountMasterPersona registers section when API present", () => {
  const calls: Array<{ name: string; order: number; text: string }> = [];
  const result = mountMasterPersona({
    systemPrompt: {
      section(input) {
        calls.push(input);
      },
    },
  });
  assert.equal(result.mounted, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.name, MASTER_PERSONA_SECTION_NAME);
  assert.match(calls[0]?.text ?? "", /禁止/);
});

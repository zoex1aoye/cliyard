import { test } from "node:test";
import assert from "node:assert/strict";
import { buildWorkerCommand } from "../src/adapters.js";

test("Claude command uses the DeepSeek launcher by default", () => {
  const previous = process.env.CLIYARD_CLAUDE_BINARY;
  try {
    delete process.env.CLIYARD_CLAUDE_BINARY;
    const command = buildWorkerCommand("claude", {
      prompt: "fixture prompt",
      permission: "accept",
    });
    assert.match(command, /^'claude-ds' -p /);
    assert.doesNotMatch(command, /^'claude' -p /);
  } finally {
    if (previous === undefined) {
      delete process.env.CLIYARD_CLAUDE_BINARY;
    } else {
      process.env.CLIYARD_CLAUDE_BINARY = previous;
    }
  }
});

test("Claude command honors an explicit launcher override", () => {
  const previous = process.env.CLIYARD_CLAUDE_BINARY;
  try {
    process.env.CLIYARD_CLAUDE_BINARY = "fixture-claude";
    const command = buildWorkerCommand("claude", {
      prompt: "fixture prompt",
      permission: "accept",
    });
    assert.match(command, /^'fixture-claude' -p /);
  } finally {
    if (previous === undefined) {
      delete process.env.CLIYARD_CLAUDE_BINARY;
    } else {
      process.env.CLIYARD_CLAUDE_BINARY = previous;
    }
  }
});

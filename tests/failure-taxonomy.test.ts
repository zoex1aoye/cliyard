import { test } from "node:test";
import assert from "node:assert/strict";
import {
  COST_STATES,
  FAILURE_CATEGORIES,
  FAILURE_STAGES,
  MAX_FAILURE_MESSAGE,
  aggregateCostTruth,
  classifyFailure,
  costCompleteness,
  createCostObservation,
  createCostTruth,
  createFailureRecord,
  isCostTruth,
  isFailureRecord,
  parseCostObservation,
  parseCostTruth,
  parseFailureRecord,
  parseTokenUsage,
  sumTokenUsage,
  unavailableCostTruth,
  type CostTruth,
  type FailureCategory,
  type FailureSignals,
  type FailureStage,
  type TokenUsage,
} from "../src/failures.js";

const FULL_USAGE: TokenUsage = {
  inputTokens: 10,
  outputTokens: 20,
  cacheCreationInputTokens: 30,
  cacheReadInputTokens: 40,
};

const ZERO_USAGE: TokenUsage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheCreationInputTokens: 0,
  cacheReadInputTokens: 0,
};

// ---------------------------------------------------------------------------
// Taxonomy and priority
// ---------------------------------------------------------------------------

test("failure categories cover exactly the ten design values", () => {
  assert.equal(FAILURE_CATEGORIES.length, 10);
  assert.equal(new Set(FAILURE_CATEGORIES).size, 10);
  assert.deepEqual(
    [...FAILURE_CATEGORIES].sort(),
    [
      "budget_exhausted",
      "policy_blocked",
      "provider_auth",
      "provider_protocol",
      "provider_transient",
      "resource_exhausted",
      "timeout",
      "unknown",
      "verifier_rejected",
      "worker_process_exit",
    ],
  );
  assert.ok(FAILURE_STAGES.includes("provider"));
  assert.ok(FAILURE_STAGES.includes("verifier"));
  assert.ok(COST_STATES.includes("cli-estimated"));
  assert.ok(COST_STATES.includes("usage-only"));
});

test("classification follows the design priority", () => {
  const cases: Array<{
    name: string;
    signals: FailureSignals;
    category: FailureCategory;
    stage: FailureStage;
  }> = [
    {
      name: "adapter timeout beats budget text",
      signals: { timedOut: true, exitCode: 1, text: "budget exhausted" },
      category: "timeout",
      stage: "worker",
    },
    {
      name: "exit 124 beats auth text",
      signals: { exitCode: 124, text: "401 unauthorized" },
      category: "timeout",
      stage: "worker",
    },
    {
      name: "timeout text without the adapter flag",
      signals: { exitCode: 1, text: "provider operation timed out" },
      category: "timeout",
      stage: "provider",
    },
    {
      name: "budget beats auth",
      signals: { exitCode: 1, text: "401 unauthorized; budget exhausted" },
      category: "budget_exhausted",
      stage: "provider",
    },
    {
      name: "auth beats transient",
      signals: { exitCode: 1, text: "401 unauthorized after 429 retries" },
      category: "provider_auth",
      stage: "provider",
    },
    {
      name: "resource exhaustion beats transient",
      signals: { exitCode: 1, text: "ENOMEM while handling 503" },
      category: "resource_exhausted",
      stage: "worker",
    },
    {
      name: "rate limit is transient",
      signals: { exitCode: 1, text: "API Error: 429 rate limit exceeded" },
      category: "provider_transient",
      stage: "provider",
    },
    {
      name: "5xx gateway timeout remains transient",
      signals: { exitCode: 1, text: "HTTP 504 Gateway Timeout" },
      category: "provider_transient",
      stage: "provider",
    },
    {
      name: "protocol beats process exit",
      signals: {
        exitCode: 1,
        text: "invalid JSONL record: unexpected token <",
      },
      category: "provider_protocol",
      stage: "provider",
    },
    {
      name: "process exit when nothing stronger",
      signals: { exitCode: 7, text: "fatal worker error" },
      category: "worker_process_exit",
      stage: "worker",
    },
    {
      name: "terminating signal is a process failure",
      signals: { signal: "SIGKILL" },
      category: "worker_process_exit",
      stage: "worker",
    },
    {
      name: "spawn failure",
      signals: { spawnFailed: true },
      category: "worker_process_exit",
      stage: "spawn",
    },
    {
      name: "verifier rejection after worker success",
      signals: { workerSucceeded: true, verifierRejected: true },
      category: "verifier_rejected",
      stage: "verifier",
    },
    {
      name: "worker failure is never relabeled verifier rejection",
      signals: {
        workerSucceeded: false,
        verifierRejected: true,
        exitCode: 1,
      },
      category: "worker_process_exit",
      stage: "worker",
    },
    {
      name: "pre-dispatch policy block",
      signals: { policyBlocked: true },
      category: "policy_blocked",
      stage: "policy",
    },
    {
      name: "fail closed to unknown",
      signals: { text: "something unexpected happened" },
      category: "unknown",
      stage: "unknown",
    },
    {
      name: "provider is_error with no stronger text stays unknown",
      signals: { providerError: true },
      category: "unknown",
      stage: "provider",
    },
    {
      name: "post-run check hint",
      signals: { postCheckFailed: true },
      category: "unknown",
      stage: "worker",
    },
    {
      name: "explicit stage override",
      signals: { exitCode: 1, stage: "contract" },
      category: "worker_process_exit",
      stage: "contract",
    },
  ];

  for (const { name, signals, category, stage } of cases) {
    assert.deepEqual(classifyFailure(signals), { category, stage }, name);
  }
});

test("provider result subtypes classify budget and preserve unknown codes", () => {
  const budget = createFailureRecord({
    subtype: "error_max_budget_usd",
    exitCode: 1,
  });
  assert.equal(budget.category, "budget_exhausted");
  assert.equal(budget.stage, "provider");
  assert.equal(budget.code, "error_max_budget_usd");
  assert.equal(budget.retryableHint, false);

  // An explicit wall-clock timeout outranks the provider subtype, including
  // in the record code.
  for (const signals of [
    { subtype: "error_max_budget_usd", timedOut: true },
    { subtype: "error_max_budget_usd", exitCode: 124 },
    {
      subtype: "error_max_budget_usd",
      exitCode: 1,
      text: "provider operation timed out",
    },
  ] satisfies FailureSignals[]) {
    const record = createFailureRecord(signals);
    assert.equal(record.category, "timeout", JSON.stringify(signals));
    assert.equal(record.code, "timeout", JSON.stringify(signals));
  }

  // Unknown subtypes stay codes; they never invent a category.
  const processExit = createFailureRecord({
    subtype: "error_max_turns",
    exitCode: 1,
    text: "stopped after the configured turn limit",
  });
  assert.equal(processExit.category, "worker_process_exit");
  assert.equal(processExit.stage, "worker");
  assert.equal(processExit.code, "error_max_turns");
  assert.ok(FAILURE_CATEGORIES.includes(processExit.category));

  const providerError = createFailureRecord({
    subtype: "error_during_execution",
    providerError: true,
  });
  assert.equal(providerError.category, "unknown");
  assert.equal(providerError.stage, "provider");
  assert.equal(providerError.code, "error_during_execution");

  // The success marker is not a failure code, and explicit codes still win.
  assert.equal(
    createFailureRecord({ subtype: "success", exitCode: 1 }).code,
    "exit_1",
  );
  assert.equal(
    createFailureRecord({
      subtype: "error_max_turns",
      exitCode: 1,
      code: "explicit_code",
    }).code,
    "explicit_code",
  );

  // Only a bounded, credential-free subtype may reach the code field.
  const longCode = createFailureRecord({
    subtype: `error_custom_${"x".repeat(200)}`,
  }).code;
  assert.ok(longCode);
  assert.ok(longCode.length <= 64);
  const redacted = createFailureRecord({
    subtype: "error_custom_sk-live-SECRET123456789012345",
  });
  assert.ok(redacted.code);
  assert.equal(redacted.code.includes("SECRET"), false);
  assert.equal(
    createFailureRecord({ subtype: 42 as unknown as string }).code,
    undefined,
  );
});

test("failure records are bounded and credential-free", () => {
  const observedAt = "2026-10-27T10:00:00.000Z";
  const secretTexts: Array<[string, string]> = [
    ["authentication failed: 401 invalid api key sk-live-SECRET123456789", "sk-live-SECRET123456789"],
    ["push failed: ghp_abcdefghijklmnopqrstuvwx0123456789", "ghp_abcdefghijklmnopqrstuvwx0123456789"],
    ["slack said xoxb-1234567890-abcdefghijkl", "xoxb-1234567890-abcdefghijkl"],
    ["aws key AKIAABCDEFGHIJKLMNOP", "AKIAABCDEFGHIJKLMNOP"],
    ["Authorization: Bearer abcdefghijklmnopqrstuvwxyz012345", "abcdefghijklmnopqrstuvwxyz012345"],
    ["api_key=supersecretvalue", "supersecretvalue"],
    ["password: hunter2", "hunter2"],
    ['{"client_secret":"json-secret-value"}', "json-secret-value"],
    ['{"authorization":"Basic dXNlcjpwYXNzd29yZA=="}', "dXNlcjpwYXNzd29yZA=="],
    ["-----BEGIN RSA PRIVATE KEY-----\nMIIEow\n-----END RSA PRIVATE KEY-----", "MIIEow"],
  ];
  for (const [text, secret] of secretTexts) {
    const record = createFailureRecord({ exitCode: 1, text, observedAt });
    assert.equal(
      record.message.includes(secret),
      false,
      `message retained secret: ${secret}`,
    );
  }

  const longText =
    "authentication failed: 401 invalid api key " +
    "x".repeat(2_000) +
    " trailing context";
  const signals = {
    exitCode: 1,
    text: longText,
    observedAt,
    rawPayload: { prompt: "PROMPT-CONTENT", headers: { auth: "secret" } },
    prompt: "PROMPT-CONTENT",
    authHeader: "Bearer raw-header-secret",
  } as FailureSignals;

  const record = createFailureRecord(signals);
  assert.equal(record.observedAt, observedAt);
  assert.equal(record.category, "provider_auth");
  assert.ok(record.message.length <= MAX_FAILURE_MESSAGE);
  assert.equal(record.message.includes("PROMPT-CONTENT"), false);
  assert.equal(record.message.includes("Bearer raw-header-secret"), false);
  const serialized = JSON.stringify(record);
  assert.equal(serialized.includes("PROMPT-CONTENT"), false);
  assert.equal("rawPayload" in record, false);
  assert.equal("prompt" in record, false);
  assert.deepEqual(
    Object.keys(record).sort(),
    ["category", "code", "message", "observedAt", "retryableHint", "stage", "version"].sort(),
  );
});

test("bounded trust: timeout messages, advisory retry hints and deterministic time", () => {
  const timeout = createFailureRecord({
    timedOut: true,
    exitCode: 124,
    timeoutMs: 50,
  });
  assert.equal(timeout.category, "timeout");
  assert.equal(timeout.code, "timeout");
  assert.match(timeout.message, /50ms/);
  assert.equal(timeout.retryableHint, true);

  const budget = createFailureRecord({
    exitCode: 1,
    text: "provider budget exhausted",
  });
  assert.equal(budget.category, "budget_exhausted");
  assert.equal(budget.retryableHint, false);
  assert.match(budget.message, /budget exhausted/);

  const override = createFailureRecord({
    exitCode: 1,
    retryableHint: true,
  });
  assert.equal(override.retryableHint, true);

  const detail = createFailureRecord({
    exitCode: 0,
    postCheckFailed: true,
    messageDetail: "git diff failed: fatal",
  });
  assert.equal(detail.category, "unknown");
  assert.equal(detail.stage, "worker");
  assert.match(detail.message, /git diff failed/);

  assert.equal(Number.isNaN(Date.parse(createFailureRecord().observedAt)), false);
});

// ---------------------------------------------------------------------------
// Failure record parsing
// ---------------------------------------------------------------------------

test("failure record parser fails closed and drops unknown fields", () => {
  const valid = createFailureRecord({
    exitCode: 3,
    text: "worker crashed",
    observedAt: "2026-10-27T10:00:00Z",
  });
  const parsed = parseFailureRecord({
    ...valid,
    raw_payload: { transcript: "nope" },
    observedAt: "2026-10-27T10:00:00Z",
  });
  assert.ok(parsed);
  assert.equal(isFailureRecord(parsed), true);
  assert.equal(parsed.observedAt, "2026-10-27T10:00:00.000Z");
  assert.equal(parsed.code, "exit_3");
  assert.equal("raw_payload" in parsed, false);

  const invalid: unknown[] = [
    null,
    {},
    { ...valid, version: 2 },
    { ...valid, category: "made_up" },
    { ...valid, stage: "made_up" },
    { ...valid, message: "" },
    { ...valid, message: "x".repeat(MAX_FAILURE_MESSAGE + 1) },
    { ...valid, observedAt: "not-a-date" },
    { ...valid, observedAt: 123 },
    { ...valid, code: 3 },
    { ...valid, code: "" },
    { ...valid, retryableHint: "yes" },
  ];
  for (const value of invalid) {
    assert.equal(parseFailureRecord(value), null, JSON.stringify(value));
    assert.equal(isFailureRecord(value), false);
  }
});

// ---------------------------------------------------------------------------
// Token usage
// ---------------------------------------------------------------------------

test("token usage parser preserves explicit zero and partial fields", () => {
  assert.deepEqual(
    parseTokenUsage({
      input_tokens: 0,
      output_tokens: 0,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    }),
    ZERO_USAGE,
  );
  assert.deepEqual(
    parseTokenUsage({
      inputTokens: 1,
      outputTokens: 2,
      cacheCreationInputTokens: 3,
      cacheReadInputTokens: 4,
      raw: "dropped",
    }),
    {
      inputTokens: 1,
      outputTokens: 2,
      cacheCreationInputTokens: 3,
      cacheReadInputTokens: 4,
    },
  );
  assert.deepEqual(parseTokenUsage({ input_tokens: 5, output_tokens: "bad" }), {
    inputTokens: 5,
    outputTokens: null,
    cacheCreationInputTokens: null,
    cacheReadInputTokens: null,
  });

  for (const malformed of [
    null,
    undefined,
    "usage",
    [],
    {},
    { input_tokens: -1, output_tokens: "bad" },
    { input_tokens: 1.5, output_tokens: 2.5 },
    { input_tokens: "10", output_tokens: true },
  ]) {
    assert.equal(parseTokenUsage(malformed), null, JSON.stringify(malformed));
  }
});

test("token usage sums only fields known for every usage", () => {
  assert.deepEqual(sumTokenUsage([FULL_USAGE, FULL_USAGE]), {
    inputTokens: 20,
    outputTokens: 40,
    cacheCreationInputTokens: 60,
    cacheReadInputTokens: 80,
  });
  assert.deepEqual(
    sumTokenUsage([
      FULL_USAGE,
      { ...FULL_USAGE, cacheReadInputTokens: null },
    ]),
    {
      inputTokens: 20,
      outputTokens: 40,
      cacheCreationInputTokens: 60,
      cacheReadInputTokens: null,
    },
  );
  assert.equal(sumTokenUsage([]), null);
  assert.equal(sumTokenUsage([null, undefined]), null);
});

// ---------------------------------------------------------------------------
// Cost truth
// ---------------------------------------------------------------------------

test("cost construction preserves explicit zero, token-only and unavailable", () => {
  const zero = createCostTruth({
    observations: [
      createCostObservation({
        sessionId: "session-zero",
        amount: 0,
        currency: "USD",
        usage: ZERO_USAGE,
      }),
    ],
    guardBudgetUsd: 5,
  });
  assert.equal(zero.state, "cli-estimated");
  assert.equal(zero.source, "cli");
  assert.equal(zero.authoritative, false);
  assert.equal(zero.amount, 0);
  assert.equal(zero.currency, "USD");
  assert.equal(zero.guardBudgetUsd, 5);
  assert.deepEqual(zero.usage, ZERO_USAGE);
  assert.deepEqual(zero.missing, []);
  assert.equal(costCompleteness(zero), "complete");
  assert.equal(isCostTruth(parseCostTruth(zero)), true);

  const usageOnly = createCostTruth({
    observations: [
      createCostObservation({ sessionId: "session-usage", usage: FULL_USAGE }),
    ],
  });
  assert.equal(usageOnly.state, "usage-only");
  assert.equal(usageOnly.source, "none");
  assert.equal(usageOnly.authoritative, false);
  assert.equal(usageOnly.amount, null);
  assert.deepEqual(usageOnly.usage, FULL_USAGE);
  assert.ok(usageOnly.missing.includes("cost.amount"));
  assert.equal(costCompleteness(usageOnly), "partial");

  const unavailable = createCostTruth({
    observations: [
      createCostObservation({
        sessionId: "session-missing",
        amount: null,
        usage: null,
      }),
    ],
  });
  assert.equal(unavailable.state, "unavailable");
  assert.equal(unavailable.source, "none");
  assert.equal(unavailable.amount, null);
  assert.equal(unavailable.usage, null);
  assert.ok(unavailable.missing.includes("cost.amount"));
  assert.ok(unavailable.missing.includes("cost.usage"));
  assert.equal(costCompleteness(unavailable), "missing");

  const amountOnly = createCostTruth({
    observations: [
      createCostObservation({
        sessionId: "session-amount",
        amount: 0.25,
        currency: "USD",
      }),
    ],
  });
  assert.equal(amountOnly.state, "cli-estimated");
  assert.equal(amountOnly.amount, 0.25);
  assert.equal(amountOnly.usage, null);
  assert.ok(amountOnly.missing.includes("cost.usage"));
  assert.equal(costCompleteness(amountOnly), "partial");

  assert.equal(costCompleteness(null), "missing");
  const empty = unavailableCostTruth();
  assert.equal(empty.state, "unavailable");
  assert.ok(empty.missing.includes("cost.observation"));
  assert.equal(costCompleteness(empty), "missing");
});

test("malformed provider values never become zero or a guessed cost", () => {
  const observation = createCostObservation({
    sessionId: "session-malformed",
    amount: "12.50",
    usage: { input_tokens: -1, output_tokens: "many" },
    currency: "USD",
  });
  assert.equal(observation.state, "unavailable");
  assert.equal(observation.amount, null);
  assert.equal(observation.usage, null);
  assert.equal(observation.currency, null);

  const truth = createCostTruth({ observations: [observation] });
  assert.equal(truth.state, "unavailable");
  assert.equal(truth.amount, null);
  assert.ok(truth.missing.includes("cost.amount"));
  assert.ok(truth.missing.includes("cost.usage"));

  // A partially malformed usage keeps only the fields that parsed.
  const partialUsage = createCostTruth({
    observations: [
      createCostObservation({
        sessionId: "session-partial",
        usage: { input_tokens: 7, output_tokens: "bad" },
      }),
    ],
  });
  assert.equal(partialUsage.state, "usage-only");
  assert.equal(partialUsage.usage?.inputTokens, 7);
  assert.equal(partialUsage.usage?.outputTokens, null);
  assert.ok(partialUsage.missing.includes("cost.usage"));
});

test("cost aggregation sums known CLI subtotals and keeps provenance", () => {
  const first = createCostTruth({
    observations: [
      createCostObservation({
        sessionId: "s1",
        amount: 0.01,
        currency: "USD",
        usage: FULL_USAGE,
      }),
    ],
    guardBudgetUsd: 2,
  });
  const second = createCostTruth({
    observations: [
      createCostObservation({
        sessionId: "s2",
        amount: 0.02,
        currency: "USD",
        usage: FULL_USAGE,
      }),
    ],
    guardBudgetUsd: 3,
  });

  const aggregated = aggregateCostTruth([first, second]);
  assert.equal(aggregated.state, "cli-estimated");
  assert.equal(aggregated.authoritative, false);
  assert.equal(aggregated.amount, 0.03);
  assert.equal(aggregated.currency, "USD");
  assert.equal(aggregated.guardBudgetUsd, 5);
  assert.deepEqual(aggregated.usage, {
    inputTokens: 20,
    outputTokens: 40,
    cacheCreationInputTokens: 60,
    cacheReadInputTokens: 80,
  });
  assert.deepEqual(
    aggregated.observations.map((observation) => observation.sessionId),
    ["s1", "s2"],
  );
  assert.deepEqual(aggregated.missing, []);
  assert.equal(costCompleteness(aggregated), "complete");

  const overridden = aggregateCostTruth([first, second], {
    guardBudgetUsd: 7,
  });
  assert.equal(overridden.guardBudgetUsd, 7);
});

test("aggregation keeps unknown components missing and never combines currencies", () => {
  const known = createCostTruth({
    observations: [
      createCostObservation({
        sessionId: "known",
        amount: 0.04,
        currency: "USD",
        usage: FULL_USAGE,
      }),
    ],
  });
  const unknown = unavailableCostTruth({ sessionId: "unknown" });

  const partial = aggregateCostTruth([known, unknown]);
  assert.equal(partial.state, "cli-estimated");
  assert.equal(partial.amount, 0.04);
  assert.ok(partial.missing.includes("cost.amount"));
  assert.ok(partial.missing.includes("cost.usage"));
  assert.equal(partial.authoritative, false);
  assert.equal(costCompleteness(partial), "partial");

  const usd = createCostTruth({
    observations: [
      createCostObservation({
        sessionId: "usd",
        amount: 1,
        currency: "USD",
        usage: FULL_USAGE,
      }),
    ],
  });
  const eur = createCostTruth({
    observations: [
      createCostObservation({
        sessionId: "eur",
        amount: 2,
        currency: "EUR",
        usage: FULL_USAGE,
      }),
    ],
  });
  const mixed = aggregateCostTruth([usd, eur]);
  assert.equal(mixed.amount, null);
  assert.equal(mixed.currency, null);
  assert.equal(mixed.state, "usage-only");
  assert.ok(mixed.missing.includes("cost.currency"));
  assert.ok(mixed.missing.includes("cost.amount"));
  assert.equal(mixed.observations.length, 2);
  assert.equal(costCompleteness(mixed), "partial");

  // An unknown currency component prevents attributing the subtotal currency.
  const unknownCurrency = createCostTruth({
    observations: [
      createCostObservation({ sessionId: "unknown-currency", amount: 0.5 }),
    ],
  });
  assert.equal(unknownCurrency.currency, null);
  assert.ok(unknownCurrency.missing.includes("cost.currency"));
  const combined = aggregateCostTruth([usd, unknownCurrency]);
  assert.equal(combined.amount, 1.5);
  assert.equal(combined.currency, null);
  assert.ok(combined.missing.includes("cost.currency"));
  assert.equal(combined.authoritative, false);

  const noCost = aggregateCostTruth([]);
  assert.equal(noCost.state, "unavailable");
  assert.deepEqual(noCost.observations, []);
  assert.ok(noCost.missing.includes("cost.observation"));
  assert.equal(costCompleteness(noCost), "missing");
});

test("provider-reported cost stays authoritative only when the amount is complete", () => {
  const provider = createCostTruth({
    observations: [
      createCostObservation({
        sessionId: "provider",
        amount: 2,
        currency: "USD",
        usage: FULL_USAGE,
        source: "provider",
      }),
    ],
  });
  assert.equal(provider.state, "provider-reported");
  assert.equal(provider.source, "provider");
  assert.equal(provider.authoritative, true);
  assert.deepEqual(provider.missing, []);
  assert.equal(costCompleteness(provider), "complete");

  const providerWithoutUsage = createCostTruth({
    observations: [
      createCostObservation({
        sessionId: "provider-no-usage",
        amount: 2,
        currency: "USD",
        source: "provider",
      }),
    ],
  });
  assert.equal(providerWithoutUsage.authoritative, true);
  assert.ok(providerWithoutUsage.missing.includes("cost.usage"));
  assert.equal(costCompleteness(providerWithoutUsage), "partial");

  const cli = createCostTruth({
    observations: [
      createCostObservation({
        sessionId: "cli",
        amount: 1,
        currency: "USD",
        usage: FULL_USAGE,
      }),
    ],
  });
  const mixed = aggregateCostTruth([provider, cli]);
  assert.equal(mixed.state, "cli-estimated");
  assert.equal(mixed.authoritative, false);
  assert.equal(mixed.amount, 3);

  const incomplete = aggregateCostTruth([
    provider,
    unavailableCostTruth({ sessionId: "missing-amount" }),
  ]);
  assert.equal(incomplete.state, "provider-reported");
  assert.equal(incomplete.authoritative, false);
  assert.ok(incomplete.missing.includes("cost.amount"));
});

test("provider observations require currency and authoritative totals require complete provenance", () => {
  const providerObservation = {
    sessionId: "provider",
    state: "provider-reported",
    source: "provider",
    currency: "USD",
    amount: 2,
    usage: FULL_USAGE,
  };
  assert.ok(parseCostObservation(providerObservation));
  assert.equal(
    parseCostObservation({ ...providerObservation, currency: null }),
    null,
  );
  assert.equal(
    parseCostObservation({ ...providerObservation, currency: undefined }),
    null,
  );

  const authoritative = {
    version: 1,
    state: "provider-reported",
    source: "provider",
    authoritative: true,
    currency: "USD",
    amount: 2,
    usage: null,
    guardBudgetUsd: null,
    observations: [providerObservation],
    missing: ["cost.usage"],
  };
  const parsed = parseCostTruth(authoritative);
  assert.ok(parsed);
  assert.equal(parsed.authoritative, true);
  assert.equal(parsed.currency, "USD");

  // Empty observations are allowed for an authoritative provider total.
  assert.ok(parseCostTruth({ ...authoritative, observations: [] }));

  const cliObservation = {
    sessionId: "cli",
    state: "cli-estimated",
    source: "cli",
    currency: "USD",
    amount: 1,
    usage: null,
  };
  const usageOnlyObservation = {
    sessionId: "usage",
    state: "usage-only",
    source: "none",
    currency: null,
    amount: null,
    usage: FULL_USAGE,
  };
  const invalid = [
    { ...authoritative, source: "cli" },
    { ...authoritative, amount: null },
    { ...authoritative, currency: null },
    { ...authoritative, missing: ["cost.amount"] },
    { ...authoritative, missing: ["cost.currency"] },
    { ...authoritative, observations: [cliObservation] },
    { ...authoritative, observations: [usageOnlyObservation] },
    { ...authoritative, observations: [providerObservation, cliObservation] },
    // A provider observation without currency is invalid even when the
    // aggregate carries a currency.
    {
      ...authoritative,
      observations: [
        { ...providerObservation, currency: null },
      ],
    },
  ];
  for (const value of invalid) {
    assert.equal(parseCostTruth(value), null, JSON.stringify(value));
  }

  // A non-authoritative provider total may still report a missing currency,
  // but it can never become authoritative.
  const partialProvider = {
    ...authoritative,
    authoritative: false,
    currency: null,
    observations: [],
    missing: ["cost.currency", "cost.usage"],
  };
  assert.ok(parseCostTruth(partialProvider));
  assert.equal(
    parseCostTruth({ ...partialProvider, authoritative: true }),
    null,
  );

  // Valid CLI estimates with unknown currency remain parseable and
  // non-authoritative.
  const cliUnknownCurrency = {
    version: 1,
    state: "cli-estimated",
    source: "cli",
    authoritative: false,
    currency: null,
    amount: 1,
    usage: FULL_USAGE,
    guardBudgetUsd: null,
    observations: [
      {
        sessionId: "cli",
        state: "cli-estimated",
        source: "cli",
        currency: null,
        amount: 1,
        usage: FULL_USAGE,
      },
    ],
    missing: ["cost.currency"],
  };
  const parsedCli = parseCostTruth(cliUnknownCurrency);
  assert.ok(parsedCli);
  assert.equal(parsedCli.authoritative, false);
  assert.equal(parsedCli.currency, null);
  assert.equal(
    parseCostTruth({ ...cliUnknownCurrency, authoritative: true }),
    null,
  );

  // Creation fails closed to token-only truth when a provider amount has no
  // currency instead of emitting an observation the parser would reject.
  const downgraded = createCostObservation({
    sessionId: "provider-no-currency",
    amount: 2,
    usage: FULL_USAGE,
    source: "provider",
  });
  assert.equal(downgraded.state, "usage-only");
  assert.equal(downgraded.source, "none");
  assert.equal(downgraded.amount, null);
  assert.deepEqual(downgraded.usage, FULL_USAGE);
  const downgradedTruth = createCostTruth({ observations: [downgraded] });
  assert.equal(downgradedTruth.state, "usage-only");
  assert.equal(downgradedTruth.authoritative, false);
  assert.equal(downgradedTruth.amount, null);
});

test("cost truth parser fails closed and drops unknown fields", () => {
  const cost = createCostTruth({
    observations: [
      createCostObservation({
        sessionId: "roundtrip",
        amount: 0,
        currency: "USD",
        usage: ZERO_USAGE,
      }),
    ],
    guardBudgetUsd: 5,
  });
  const parsed = parseCostTruth({
    ...JSON.parse(JSON.stringify(cost)),
    raw_payload: { transcript: "nope" },
  });
  assert.deepEqual(parsed, cost);
  assert.equal("raw_payload" in (parsed as object), false);

  const base = JSON.parse(JSON.stringify(cost)) as Record<string, unknown>;
  const invalid: unknown[] = [
    null,
    {},
    { ...base, version: 2 },
    { ...base, state: "guessed" },
    { ...base, source: "guess" },
    { ...base, authoritative: "yes" },
    { ...base, amount: "0" },
    { ...base, amount: -1 },
    { ...base, usage: [] },
    { ...base, observations: "none" },
    {
      ...base,
      observations: [
        {
          sessionId: "bad",
          state: "usage-only",
          source: "none",
          currency: null,
          amount: 1,
          usage: null,
        },
      ],
    },
    { ...base, missing: [1] },
    { ...base, missing: "cost.amount" },
    { ...base, authoritative: true },
    {
      ...base,
      state: "usage-only",
      source: "none",
      authoritative: false,
      amount: 1,
      usage: ZERO_USAGE,
    },
    {
      ...base,
      state: "unavailable",
      source: "none",
      authoritative: false,
      amount: null,
      usage: ZERO_USAGE,
    },
  ];
  for (const value of invalid) {
    assert.equal(parseCostTruth(value), null, JSON.stringify(value));
    assert.equal(isCostTruth(value), false);
  }

  const invalidObservation = parseCostObservation({
    sessionId: "s",
    state: "cli-estimated",
    source: "cli",
    currency: "USD",
    amount: null,
    usage: null,
  });
  assert.equal(invalidObservation, null);
});

test("aggregation preserves a top-level-only truth with an explicit provenance gap", () => {
  const topLevelOnly: CostTruth = {
    version: 1,
    state: "cli-estimated",
    source: "cli",
    authoritative: false,
    currency: "USD",
    amount: 0.5,
    usage: null,
    guardBudgetUsd: null,
    observations: [],
    missing: ["cost.usage"],
  };
  const aggregated = aggregateCostTruth([topLevelOnly]);
  assert.equal(aggregated.amount, 0.5);
  assert.equal(aggregated.observations.length, 1);
  assert.match(aggregated.observations[0].note ?? "", /without per-session/);
  assert.ok(aggregated.missing.includes("cost.observation"));
});

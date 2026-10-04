import assert from "node:assert/strict";
import { test } from "node:test";
import {
  readXEditorialCallUsage,
  summarizeXEditorialUsage,
  xEditorialUsageSchema,
} from "./services/x-editorial-usage.js";

const model = "openai/gpt-6.1-sol";

test("X editorial accounting prioritizes reported costs, including zero and ticks", () => {
  const usage = { prompt_tokens: 1000, completion_tokens: 200, cost: 0.03 };
  assert.equal(readXEditorialCallUsage({ usage }, model).chargedCostUsd, 0.03);
  assert.equal(
    readXEditorialCallUsage({ usage: { ...usage, cost: 0 } }, model)
      .chargedCostUsd,
    0,
  );
  assert.equal(
    readXEditorialCallUsage({ usage: { cost_in_usd_ticks: 300000000 } }, model)
      .chargedCostUsd,
    0.03,
  );
});

test("X editorial estimates complete usage without double charging reasoning tokens", () => {
  const call = readXEditorialCallUsage(
    {
      usage: {
        prompt_tokens: 1000,
        completion_tokens: 200,
        completion_tokens_details: { reasoning_tokens: 100 },
      },
    },
    model,
  );
  assert.equal(call.chargedCostUsd, 0.004);
  assert.equal(call.costSource, "estimated");
  assert.equal(call.reasoningTokens, 100);
});

test("X editorial missing or malformed usage is unknown, not a zero-cost call", () => {
  for (const payload of [
    null,
    {},
    { usage: null },
    { usage: { prompt_tokens: 1000 } },
    {
      usage: {
        prompt_tokens: 1.5,
        completion_tokens: 200,
        completion_tokens_details: { reasoning_tokens: 0.1 },
      },
    },
  ]) {
    const call = readXEditorialCallUsage(payload, model);
    assert.equal(call.chargedCostUsd, null);
    assert.equal(call.costSource, "unknown");
    assert.ok(
      xEditorialUsageSchema.safeParse(summarizeXEditorialUsage([call])).success,
    );
  }
  assert.equal(
    readXEditorialCallUsage(
      { usage: { prompt_tokens: 1000, completion_tokens: 200 } },
      "unknown-model",
    ).chargedCostUsd,
    null,
  );
});

test("X editorial aggregates both repair attempts and retains partial accounting", () => {
  const first = readXEditorialCallUsage({ usage: { cost: 0.01 } }, model);
  const second = readXEditorialCallUsage({ usage: { cost: 0.02 } }, model);
  assert.deepEqual(summarizeXEditorialUsage([first, second]), {
    calls: [first, second],
    chargedCostUsd: 0.03,
    knownCostUsd: 0.03,
    unknownCostCalls: 0,
  });
  const partial = summarizeXEditorialUsage([
    first,
    readXEditorialCallUsage(null, model),
  ]);
  assert.equal(partial?.chargedCostUsd, null);
  assert.equal(partial?.knownCostUsd, 0.01);
  assert.equal(partial?.unknownCostCalls, 1);
  assert.equal(summarizeXEditorialUsage([]), undefined);
});

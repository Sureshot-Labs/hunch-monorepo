import assert from "node:assert/strict";
import { marketMapModelTestHooks } from "./ai-map-build-run.js";
import { mapSignalsModelTestHooks } from "./ai-map-signals-run.js";
import {
  getIntelPolicyDefaults,
  getIntelPolicySchema,
} from "./services/runtime-policies.js";
import { buildMapOpenRouterOptions } from "./services/map-openrouter-request.js";

assert.deepEqual(
  buildMapOpenRouterOptions({ model: "openai/gpt-5.4", stage: "label" }),
  { temperature: 0, reasoning: { effort: "low" } },
);
assert.deepEqual(
  buildMapOpenRouterOptions({ model: "openai/gpt-5.4", stage: "signals" }),
  {
    temperature: 0,
    reasoning: { effort: "low" },
    response_format: { type: "json_object" },
  },
);
const originalFetch = globalThis.fetch;
const requests: Array<{
  model: string;
  temperature?: number;
  reasoning: { effort: string; exclude?: boolean };
  response_format?: { type: string; json_schema?: { strict: boolean } };
}> = [];
try {
  globalThis.fetch = async (_url, options) => {
    const request = JSON.parse(String(options?.body));
    requests.push(request);
    return new Response(
      JSON.stringify({
        choices: [
          {
            message: {
              content: request.response_format ? "{}" : "European Elections",
            },
            finish_reason: "stop",
          },
        ],
        usage: { prompt_tokens: 100, completion_tokens: 10, cost: 0.002 },
      }),
    );
  };
  for (const model of [
    "openai/gpt-5.6-sol",
    "openai/gpt-5.6-luna",
    "openai/gpt-5.6-terra",
    "openai/gpt-6-astra",
  ]) {
    const policy = getIntelPolicyDefaults("market_map");
    const config = marketMapModelTestHooks.buildConfig([], {
      ...policy,
      labelModel: model,
      labelReasoningEffort: "low",
      labelTemperature: 0.7,
    });
    const result = await marketMapModelTestHooks.callOpenRouterLabel({
      model: config.labelModel,
      reasoningEffort: config.labelReasoningEffort,
      temperature: config.labelTemperature,
      labelMaxTokens: 2000,
      timeoutMs: 1000,
      prompt: {
        system: "Return a short label.",
        user: "European elections",
        promptChars: 50,
      },
    });
    assert.equal(result.label, "European Elections");
    const labelRequest = requests.at(-1);
    assert.ok(labelRequest);
    assert.equal(labelRequest.model, model);
    assert.equal(labelRequest.temperature, undefined);
    assert.deepEqual(labelRequest.reasoning, { effort: "low", exclude: true });
    assert.equal(labelRequest.response_format, undefined);
    const args = mapSignalsModelTestHooks.resolveArgs([
      "--model",
      model,
      "--reasoning-effort",
      "medium",
      "--temperature",
      "0.7",
    ]);
    await mapSignalsModelTestHooks.callOpenRouter(args, "system", "user");
    const signalRequest = requests.at(-1);
    assert.ok(signalRequest);
    assert.equal(signalRequest.model, model);
    assert.equal(signalRequest.temperature, undefined);
    assert.equal(signalRequest.reasoning.effort, "medium");
    assert.equal(signalRequest.response_format?.type, "json_schema");
    assert.equal(signalRequest.response_format?.json_schema?.strict, true);
  }
} finally {
  globalThis.fetch = originalFetch;
}
assert.throws(() =>
  mapSignalsModelTestHooks.resolveArgs(["--temperature", "bad"]),
);
assert.throws(() =>
  mapSignalsModelTestHooks.resolveArgs(["--reasoning-effort", "invalid"]),
);
assert.equal(getIntelPolicyDefaults("market_map").labelReasoningEffort, null);
assert.equal(getIntelPolicyDefaults("map_signals").reasoningEffort, null);
assert.ok(
  getIntelPolicySchema("market_map").safeParse({
    labelModel: "openai/gpt-5.6-luna",
    labelReasoningEffort: "low",
    labelTemperature: null,
  }).success,
);
assert.ok(
  getIntelPolicySchema("map_signals").safeParse({
    model: "openai/gpt-5.6-sol",
    reasoningEffort: "high",
    temperature: null,
  }).success,
);
assert.equal(
  getIntelPolicySchema("market_map").safeParse({
    labelModel: "openai/gpt-6-astra",
    labelReasoningEffort: "none",
  }).success,
  false,
);
assert.equal(
  getIntelPolicySchema("map_signals").safeParse({
    model: "openai/gpt-6-astra",
    reasoningEffort: "none",
  }).success,
  false,
);
console.log(
  "✓ Market Map labels and macro signals: actual request builders, policy/CLI plumbing, legacy compatibility, reasoning and temperature",
);

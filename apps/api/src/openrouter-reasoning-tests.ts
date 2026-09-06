import assert from "node:assert/strict";
import { buildOpenRouterReasoningOptions } from "./lib/openrouter-reasoning.js";
import { getOpenRouterModelPricingPerM } from "./lib/ai-pricing.js";
import { buildHolderResearchResponseFormat } from "./services/holder-research-request.js";
import {
  getIntelPolicyDefaults,
  getIntelPolicySchema,
} from "./services/runtime-policies.js";
import {
  getDefaultSignalBotPolicy,
  signalBotSchema,
} from "./services/signal-bot-trading-policy.js";
import { resolveSignalBotEditorialConfig } from "./services/signal-bot-editorial-config.js";
import {
  createOpenRouterXEditorialDraftComposer,
  type XEditorialDraftSource,
} from "./services/x-editorial-draft.js";

const legacy = "openai/gpt-5.5";
assert.equal(
  buildHolderResearchResponseFormat({
    model: "openai/gpt-6-astra",
    stage: "final",
    useV2: false,
  }).type,
  "json_schema",
);
assert.equal(
  buildOpenRouterReasoningOptions({
    model: "openai/gpt-6-astra",
    legacyEffort: "minimal",
    legacyTemperature: 0.1,
  }).reasoning?.effort,
  "low",
);
assert.throws(
  () =>
    buildOpenRouterReasoningOptions({
      model: "openai/gpt-6-astra",
      effort: "none",
    }),
  /requires reasoning/,
);
assert.deepEqual(
  buildOpenRouterReasoningOptions({ model: legacy, legacyTemperature: 0.1 }),
  { temperature: 0.1 },
);
assert.deepEqual(
  buildOpenRouterReasoningOptions({
    model: legacy,
    effort: null,
    legacyEffort: "minimal",
  }),
  { reasoning: { effort: "minimal", exclude: true } },
);
assert.deepEqual(
  buildHolderResearchResponseFormat({
    model: legacy,
    stage: "final",
    useV2: false,
  }),
  { type: "json_object" },
);
for (const name of ["sol", "luna", "terra"]) {
  const model = `openai/gpt-5.6-${name}`;
  assert.ok(getOpenRouterModelPricingPerM(model)?.inputPerM);
  assert.deepEqual(
    buildOpenRouterReasoningOptions({ model, legacyTemperature: 0.1 }),
    { provider: { require_parameters: true } },
  );
  assert.equal(
    buildOpenRouterReasoningOptions({ model, legacyEffort: "minimal" })
      .reasoning?.effort,
    "low",
  );
  assert.equal(
    buildOpenRouterReasoningOptions({ model, effort: "none" }).reasoning
      ?.effort,
    "none",
  );
  for (const stage of ["triage", "final"] as const)
    for (const useV2 of [false, true]) {
      const format = buildHolderResearchResponseFormat({ model, stage, useV2 });
      assert.equal(format.type, "json_schema");
      assert.equal(format.json_schema?.strict, true);
      const schema = format.json_schema?.schema as Record<string, unknown>;
      assert.equal(schema.additionalProperties, false);
      assert.deepEqual(
        schema.required,
        Object.keys(schema.properties as object),
      );
      const version = (schema.properties as Record<string, { const: string }>)
        .version;
      assert.ok(version.const.includes(useV2 ? "v2" : "v1"));
    }
}
const hr = getIntelPolicySchema("holder_research");
assert.equal(
  hr.safeParse({ model: "openai/gpt-6-astra", reasoningEffort: "none" })
    .success,
  false,
);
assert.equal(
  hr.safeParse({ model: "openai/gpt-6-astra", reasoningEffort: "low" }).success,
  true,
);
assert.equal(
  signalBotSchema.safeParse({
    xEditorialModel: "openai/gpt-6-astra",
    xEditorialReasoningEffort: "none",
  }).success,
  false,
);
assert.ok(hr.safeParse({ enabled: true }).success);
assert.ok(
  hr.safeParse({
    model: legacy,
    reasoningEffort: null,
    triageReasoningEffort: null,
  }).success,
);
assert.ok(
  hr.safeParse({
    model: "openai/gpt-5.6-sol",
    reasoningEffort: "high",
    triageModel: "openai/gpt-5.6-luna",
    triageReasoningEffort: "low",
  }).success,
);
assert.equal(hr.safeParse({ reasoningEffort: "ultra" }).success, false);
assert.equal(getIntelPolicyDefaults("holder_research").reasoningEffort, null);
assert.equal(getIntelPolicyDefaults("holder_research").model, legacy);
const base = {
  enabled: true,
  model: legacy,
  maxOutputTokens: 700,
  maxCharacters: 1000,
  maxParagraphs: 10,
};
const restored = resolveSignalBotEditorialConfig(
  base,
  getDefaultSignalBotPolicy(),
);
assert.equal(restored.model, base.model);
assert.equal(restored.maxOutputTokens, base.maxOutputTokens);
assert.equal(restored.reasoningEffort, undefined);
assert.ok(
  signalBotSchema.safeParse({
    tradingEnabled: true,
    xEditorialModel: "openai/gpt-5.6-luna",
    xEditorialReasoningEffort: "low",
    xEditorialMaxOutputTokens: 2000,
  }).success,
);
assert.equal(
  signalBotSchema.safeParse({ xEditorialReasoningEffort: "invalid" }).success,
  false,
);

// A policy edit is picked up on the next composition, and both repair attempts
// use one resolved config. No network calls are made by this regression test.
const originalFetch = globalThis.fetch;
const requests: Array<{
  model: string;
  reasoning: { effort: string; exclude: boolean };
}> = [];
let resolutions = 0;
const source: XEditorialDraftSource = {
  facts: [],
  kind: "initial",
  marketId: "market-1",
  noteId: "note-1",
  recentOpenings: [],
  selectedSide: "YES",
};
try {
  globalThis.fetch = async (_url, options) => {
    requests.push(JSON.parse(String(options?.body)));
    const content =
      requests.length % 2 === 1
        ? "{"
        : JSON.stringify({
            version: 1,
            status: "blocked",
            marketId: source.marketId,
            selectedSide: "YES",
            postText: null,
            formatting: [],
            storyFamily: "fresh_bet",
            usedFactIds: [],
            safetyFlags: ["insufficient_evidence"],
          });
    return new Response(
      JSON.stringify({
        choices: [{ message: { content }, finish_reason: "stop" }],
      }),
      { status: 200 },
    );
  };
  const composer = createOpenRouterXEditorialDraftComposer({
    apiKey: "unit-test",
    config: base,
    resolveConfig: async () => {
      resolutions += 1;
      return {
        ...base,
        model: resolutions === 1 ? "openai/gpt-5.6-luna" : legacy,
        reasoningEffort: resolutions === 1 ? "low" : null,
        maxOutputTokens: 2000,
      };
    },
  });
  await composer({ source });
  assert.equal(resolutions, 1);
  assert.equal(requests.length, 2);
  assert.equal(requests[0]?.model, "openai/gpt-5.6-luna");
  assert.deepEqual(requests[0]?.reasoning, { effort: "low", exclude: true });
  assert.equal(requests[1]?.model, requests[0]?.model);
  await composer({ source });
  assert.equal(resolutions, 2);
  assert.equal(requests[2]?.model, legacy);
  assert.equal(requests[2]?.reasoning.effort, "minimal");
} finally {
  globalThis.fetch = originalFetch;
}
console.log(
  "✓ OpenRouter model/reasoning compatibility, strict schemas, policy defaults and editorial reload",
);

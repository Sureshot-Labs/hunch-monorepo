import assert from "node:assert/strict";
import { env } from "./env.js";
import { clusterModelTestHooks } from "./ai-embed-cluster.js";
import { whaleProfileModelTestHooks } from "./services/whale-profiles.js";
import { mapSearchModelTestHooks } from "./ai-map-search-run.js";
import { marketMapModelTestHooks } from "./ai-map-build-run.js";
import { mapSignalsModelTestHooks } from "./ai-map-signals-run.js";
import { buildOpenRouterReasoningOptions } from "./lib/openrouter-reasoning.js";
import {
  buildXaiReasoningOptions,
  xaiReasoningEffortSchema,
} from "./lib/xai-reasoning.js";
import { aiCompletionError } from "./lib/ai-completion-diagnostics.js";
import {
  getIntelPolicyDefaults,
  getIntelPolicySchema,
  resolveIntelPolicy,
} from "./services/runtime-policies.js";

// No provider requests, DB access, secrets output or generated artifacts.
assert.deepEqual(buildXaiReasoningOptions({}), {});
assert.deepEqual(
  buildXaiReasoningOptions({ effort: null, legacyEffort: "low" }),
  { reasoning: { effort: "low" } },
);
assert.deepEqual(
  buildXaiReasoningOptions({ effort: "high", legacyEffort: "low" }),
  { reasoning: { effort: "high" } },
);
assert.equal(xaiReasoningEffortSchema.safeParse("none").success, false);
assert.equal(xaiReasoningEffortSchema.safeParse("max").success, false);
assert.deepEqual(
  buildOpenRouterReasoningOptions({
    model: "other/model",
    legacyTemperature: 0,
    legacyEffort: "low",
    legacyExcludeReasoning: false,
  }),
  { temperature: 0, reasoning: { effort: "low" } },
);
for (const model of [
  "openai/gpt-5.4",
  "openai/gpt-5.4-nano",
  "openai/gpt-5.5",
  "openai/gpt-5.6-luna",
  "openai/gpt-5.6-sol",
  "openai/gpt-5.6-terra",
  "openai/gpt-6-astra",
  "openai/gpt-6-luna",
  "openai/gpt-6-sol",
  "openai/gpt-6-astra-pro",
  "openai/gpt-5.6-luna:batch",
]) {
  const options = buildOpenRouterReasoningOptions({
    model,
    legacyTemperature: 0,
    legacyEffort: "low",
  });
  assert.equal("temperature" in options, false, model);
  assert.equal(options.reasoning?.effort, "low");
  assert.equal(options.provider?.require_parameters, true);
}
assert.throws(
  () =>
    buildOpenRouterReasoningOptions({ model: "openai/gpt-5.5", effort: "max" }),
  /unsupported effort/,
);
assert.throws(
  () =>
    buildOpenRouterReasoningOptions({
      model: "openai/gpt-6-astra-pro",
      effort: "none",
    }),
  /unsupported effort/,
);
for (const key of [
  "ai_clusters",
  "ai_whale_profiles",
  "map_search",
  "holder_research",
] as const) {
  assert.ok(getIntelPolicySchema(key).safeParse({}).success, key);
  assert.ok(
    getIntelPolicySchema(key).safeParse(getIntelPolicyDefaults(key)).success,
    key,
  );
}
assert.equal(getIntelPolicyDefaults("ai_clusters").maxTokensFast, 800);
assert.equal(getIntelPolicyDefaults("ai_clusters").reasoningEffortFast, "low");
assert.ok(
  getIntelPolicySchema("ai_clusters").safeParse({
    reasoningEffortFast: "low",
    reasoningEffortFinal: "high",
    maxTokensFast: 2000,
  }).success,
);
assert.equal(
  getIntelPolicySchema("ai_clusters").safeParse({
    modelFallback: "openai/gpt-6-astra",
    reasoningEffortFast: "none",
  }).success,
  false,
);
assert.equal(
  getIntelPolicySchema("ai_whale_profiles").safeParse({
    model: "openai/gpt-6-astra",
    reasoningEffort: "none",
  }).success,
  false,
);
assert.equal(
  getIntelPolicySchema("map_search").safeParse({ reasoningEffort: "minimal" })
    .success,
  false,
);
assert.equal(
  getIntelPolicySchema("holder_research").safeParse({
    externalSearchReasoningEffort: "none",
  }).success,
  false,
);

// Saved partial policies retain their model and merge the new optional fields.
for (const key of [
  "ai_clusters",
  "ai_whale_profiles",
  "map_search",
  "holder_research",
] as const) {
  const payload =
    key === "ai_clusters"
      ? {
          modelFast: "openai/gpt-5.6-luna",
          reasoningEffortFast: "high",
          maxTokensFast: 2000,
        }
      : key === "holder_research"
        ? { externalSearchReasoningEffort: "medium" }
        : { reasoningEffort: "low" };
  const db = {
    query: async () => ({
      rows: [
        {
          policy_key: key,
          payload,
          effective_at: new Date(),
          created_at: new Date(),
        },
      ],
    }),
  } as unknown as Parameters<typeof resolveIntelPolicy>[0];
  const resolved = await resolveIntelPolicy(db, key);
  assert.equal(resolved.source, "db");
  assert.equal(resolved.invalidOverride, false);
  for (const [field, value] of Object.entries(payload))
    assert.equal(
      (resolved.effective as unknown as Record<string, unknown>)[field],
      value,
    );
}

const truncated = {
  choices: [{ finish_reason: "length", message: { content: "{}" } }],
  usage: {
    completion_tokens: 800,
    completion_tokens_details: { reasoning_tokens: 790 },
  },
};
assert.match(aiCompletionError(truncated) ?? "", /length.*800.*790/);
assert.equal(aiCompletionError({ choices: [{ finish_reason: "stop" }] }), null);
assert.match(
  aiCompletionError({ choices: [{ error: { code: "test" } }] }) ?? "",
  /provider_error/,
);
assert.match(
  aiCompletionError({
    status: "incomplete",
    incomplete_details: { reason: "max_output_tokens" },
  }) ?? "",
  /incomplete:max_output_tokens/,
);
assert.match(
  aiCompletionError({ choices: [{ message: { refusal: "no" } }] }) ?? "",
  /refusal/,
);

const originalFetch = globalThis.fetch;
const originalKey = env.openRouterKey;
const requests: Array<Record<string, unknown>> = [];
let reply: unknown = {
  choices: [{ finish_reason: "stop", message: { content: "{}" } }],
};
try {
  env.openRouterKey = "unit-test-not-a-key";
  globalThis.fetch = async (_url, init) => {
    requests.push(JSON.parse(String(init?.body)));
    return new Response(JSON.stringify(reply));
  };
  for (const model of ["openai/gpt-5.6-luna", "openai/gpt-5.4"]) {
    await clusterModelTestHooks.callOpenRouter(
      model,
      [],
      800,
      { type: "json_object" },
      "low",
    );
    await whaleProfileModelTestHooks.callOpenRouter(model, [], 1600, "high");
    for (const request of requests.slice(-2)) {
      assert.equal(request.model, model);
      assert.equal("temperature" in request, false);
      assert.deepEqual(request.provider, { require_parameters: true });
    }
    assert.equal(requests.at(-1)?.max_tokens, 1600);
    assert.deepEqual(requests.at(-1)?.reasoning, {
      effort: "high",
      exclude: true,
    });
  }
  reply = truncated;
  await assert.rejects(
    clusterModelTestHooks.callOpenRouter("openai/gpt-5.6-luna", [], 800),
    /completion length/,
  );
  assert.equal(
    await whaleProfileModelTestHooks.callOpenRouter(
      "openai/gpt-5.6-luna",
      [],
      800,
    ),
    "",
  );
  const label = await marketMapModelTestHooks.callOpenRouterLabel({
    model: "openai/gpt-5.6-luna",
    labelMaxTokens: 800,
    timeoutMs: 1000,
    prompt: { system: "test", user: "test", promptChars: 8 },
  });
  assert.equal(label.label, null);
  assert.equal(label.finishReason, "length");
  assert.equal(label.completionTokens, 800);
  const signal = await mapSignalsModelTestHooks.callOpenRouter(
    mapSignalsModelTestHooks.resolveArgs(["--model=openai/gpt-5.6-luna"]),
    "system",
    "user",
  );
  assert.match(signal.completionError ?? "", /length/);
  assert.equal(signal.usage.completionTokens, 800);
  assert.equal(signal.usage.reasoningTokens, 790);

  const args = mapSearchModelTestHooks.resolveArgs([
    "--model=grok-4.6",
    "--reasoning-effort=low",
  ]);
  reply = { status: "completed", output_text: "{}" };
  assert.ok(
    (
      await mapSearchModelTestHooks.callXaiOnce(
        args,
        "unit-test",
        { system: "test", user: "test" },
        [],
      )
    ).ok,
  );
  assert.deepEqual(requests.at(-1)?.reasoning, { effort: "low" });
  assert.equal(
    (requests.at(-1)?.text as { format?: { type?: string } })?.format?.type,
    "json_schema",
  );
  assert.deepEqual(requests.at(-1)?.include, ["no_inline_citations"]);
  reply = {
    status: "incomplete",
    incomplete_details: { reason: "max_output_tokens" },
    usage: {
      output_tokens: 100,
      output_tokens_details: { reasoning_tokens: 99 },
    },
  };
  const incomplete = await mapSearchModelTestHooks.callXaiOnce(
    args,
    "unit-test",
    { system: "test", user: "test" },
    [],
  );
  assert.equal(incomplete.ok, false);
  assert.equal(incomplete.usage.outputTokens, 100);
  assert.match(incomplete.error ?? "", /incomplete/);
  await mapSearchModelTestHooks.callXaiOnce(
    mapSearchModelTestHooks.resolveArgs([]),
    "unit-test",
    { system: "test", user: "test" },
    [],
  );
  assert.equal("reasoning" in (requests.at(-1) ?? {}), false);
} finally {
  globalThis.fetch = originalFetch;
  env.openRouterKey = originalKey;
}
console.log(
  "✓ Provider support: policies, request payloads, legacy defaults, truncation and xAI accounting",
);

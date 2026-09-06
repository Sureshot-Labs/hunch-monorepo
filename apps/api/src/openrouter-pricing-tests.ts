import assert from "node:assert/strict";
import {
  createOpenRouterPricingCatalog,
  type OpenRouterPricingCache,
} from "./lib/openrouter-pricing-catalog.js";
import {
  getOpenRouterModelPricingPerM,
  refreshOpenRouterModelPricing,
} from "./lib/ai-pricing.js";

let clock = Date.now();
let calls = 0;
let fail = false;
let payload: unknown = {
  data: [
    {
      id: "test/new-model",
      pricing: {
        prompt: "0.000002",
        completion: "0.00001",
        overrides: [
          {
            min_prompt_tokens: 272000,
            prompt: "0.000004",
            completion: "0.000015",
          },
        ],
      },
    },
    { id: "test/bad-price", pricing: { prompt: "-1", completion: "NaN" } },
  ],
};
const fakeFetch: typeof fetch = async () => {
  calls += 1;
  if (fail) throw new Error("offline");
  return new Response(JSON.stringify(payload));
};
const storage = new Map<string, string>();
const cache: OpenRouterPricingCache = {
  get: async (key) => storage.get(key) ?? null,
  set: async (key, value, options) => {
    assert.equal(options.EX, 86400);
    storage.set(key, value);
  },
};
const catalog = createOpenRouterPricingCatalog({
  now: () => clock,
  fetch: fakeFetch,
});
await Promise.all([catalog.refresh(cache), catalog.refresh(cache)]);
assert.equal(calls, 1);
assert.deepEqual(catalog.get("test/new-model"), {
  inputPerM: 2,
  outputPerM: 10,
});
assert.deepEqual(catalog.get("test/new-model", 272001), {
  inputPerM: 4,
  outputPerM: 15,
});
assert.equal(catalog.get("test/bad-price"), null);
assert.equal(catalog.get("test/missing"), null);
await catalog.refresh(cache);
assert.equal(calls, 1);
const secondProcess = createOpenRouterPricingCatalog({
  now: () => clock,
  fetch: fakeFetch,
});
await secondProcess.refresh(cache);
assert.equal(calls, 1);
assert.equal(secondProcess.get("test/new-model")?.inputPerM, 2);
clock += 6 * 60 * 60 * 1000 + 1;
payload = {
  data: [
    {
      id: "test/new-model",
      pricing: { prompt: "0.000003", completion: "0.000011" },
    },
  ],
};
await catalog.refresh(cache);
assert.equal(calls, 2);
assert.equal(catalog.get("test/new-model")?.inputPerM, 3);
clock += 6 * 60 * 60 * 1000 + 1;
fail = true;
await catalog.refresh(cache);
assert.equal(calls, 3);
assert.equal(catalog.get("test/new-model")?.inputPerM, 3);
await catalog.refresh(cache);
assert.equal(calls, 3);
clock += 24 * 60 * 60 * 1000;
assert.equal(catalog.get("test/new-model"), null);
const corruptCache: OpenRouterPricingCache = {
  get: async () => "broken",
  set: async () => {
    throw new Error("redis down");
  },
};
fail = false;
await catalog.refresh(corruptCache);
assert.equal(catalog.get("test/new-model")?.inputPerM, 3);
clock += 6 * 60 * 60 * 1000 + 1;
payload = {
  data: [{ id: "test/new-model", pricing: { prompt: null, completion: "" } }],
};
await catalog.refresh();
assert.equal(catalog.get("test/new-model")?.inputPerM, 3);

assert.equal(
  getOpenRouterModelPricingPerM("openai/gpt-6-astra")?.inputPerM,
  10,
);
assert.equal(
  getOpenRouterModelPricingPerM("openai/gpt-6-astra", 300000)?.outputPerM,
  75,
);
const originalFetch = globalThis.fetch;
try {
  // A promotional/discounted catalog price cannot lower Astra's standard estimate.
  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({
        data: [
          {
            id: "openai/gpt-6-astra",
            pricing: { prompt: "0.000005", completion: "0.000025" },
          },
        ],
      }),
    );
  await refreshOpenRouterModelPricing();
  assert.equal(
    getOpenRouterModelPricingPerM("openai/gpt-6-astra")?.inputPerM,
    10,
  );
  assert.equal(
    getOpenRouterModelPricingPerM("openai/gpt-6-astra")?.outputPerM,
    50,
  );
} finally {
  globalThis.fetch = originalFetch;
}
console.log(
  "✓ OpenRouter pricing: catalog, Redis/memory TTL, concurrency, stale fallback, malformed prices, context tiers, Astra standard floor",
);

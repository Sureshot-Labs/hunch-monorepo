import assert from "node:assert/strict";
import { env } from "./env.js";
import {
  normalizeWhaleProfile,
  whaleProfileModelTestHooks as hooks,
} from "./services/whale-profiles.js";
import {
  getIntelPolicyDefaults,
  resolveIntelPolicy,
} from "./services/runtime-policies.js";

const profile = {
  label_short: "Macro Contrarian",
  label_long: "Trades against macro consensus.",
  archetype: "macro_contrarian",
  risk_style: "focused",
  confidence: 0.7,
  evidence: ["Supplied macro positions"],
  notes:
    "- Follows macro markets.\n- Concentrates positions.\n- Fades consensus.\n- Repeats setups.",
};
const complete = {
  choices: [
    { finish_reason: "stop", message: { content: JSON.stringify(profile) } },
  ],
};
const truncated = {
  choices: [{ finish_reason: "length", message: { content: "" } }],
  usage: {
    completion_tokens: 1600,
    completion_tokens_details: { reasoning_tokens: 1600 },
  },
};
const options = {
  model: "openai/gpt-6-luna",
  system: "test",
  user: "facts",
  compactUser: "compact facts",
  maxTokens: 1600,
  maxTokensFallback: 1000,
  reasoningEffort: "high" as const,
};
const originalFetch = globalThis.fetch;
const originalKey = env.openRouterKey;
const originalModel = env.aiWhaleProfileModel;
let responses: unknown[] = [];
const requests: Array<Record<string, unknown>> = [];
try {
  env.aiWhaleProfileModel = "openai/gpt-6-luna";
  env.openRouterKey = "unit-test-not-a-key";
  globalThis.fetch = async (_url, init) => {
    assert.ok(init?.signal); // a hung call cannot occupy the whole cron window
    requests.push(JSON.parse(String(init?.body)));
    const response = responses.shift();
    assert.ok(response, "no third paid attempt permitted");
    if (response instanceof Error) throw response;
    return new Response(JSON.stringify(response));
  };
  for (const first of [
    truncated,
    { choices: [{ finish_reason: "stop", message: { content: "{}" } }] },
  ]) {
    requests.length = 0;
    responses = [first, complete];
    const draft = await hooks.generateProfileDraft(options);
    assert.ok(normalizeWhaleProfile(draft.parsed));
    assert.equal(requests.length, 2);
    assert.deepEqual(
      requests.map((req) => req.max_tokens),
      [1600, 1000],
    );
    assert.deepEqual(
      requests.map((req) => (req.reasoning as { effort: string }).effort),
      ["high", "none"],
    );
  }
  requests.length = 0;
  responses = [complete];
  assert.ok(
    normalizeWhaleProfile((await hooks.generateProfileDraft(options)).parsed),
  );
  assert.equal(requests.length, 1);
  requests.length = 0;
  responses = [truncated, truncated];
  assert.equal(
    normalizeWhaleProfile((await hooks.generateProfileDraft(options)).parsed),
    null,
  );
  assert.equal(requests.length, 2);
  requests.length = 0;
  responses = [new Error("unknown provider timeout")];
  await assert.rejects(hooks.generateProfileDraft(options), /timeout/);
  assert.equal(requests.length, 1); // never retry an unknown-cost transport error
  assert.equal(hooks.compactProfileEffort("openai/gpt-6.1-sol", "high"), "low");
  assert.equal(
    hooks.compactProfileEffort("openai/gpt-5.4-pro", "high"),
    "high",
  ); // legacy family unchanged
  assert.equal(hooks.compactProfileEffort("other/model", "high"), "high");
  assert.equal(
    getIntelPolicyDefaults("ai_whale_profiles").reasoningEffort,
    "low",
  );
  env.aiWhaleProfileModel = "openai/gpt-5.4-pro";
  assert.equal(
    getIntelPolicyDefaults("ai_whale_profiles").reasoningEffort,
    "high",
  );
  env.aiWhaleProfileModel = "openai/gpt-6-luna";
  for (const payload of [
    { model: "openai/gpt-5.4-pro" },
    { model: "openai/gpt-6-luna", reasoningEffort: "high" },
    { model: "openai/gpt-6-luna", reasoningEffort: "none" },
  ]) {
    const db = {
      query: async () => ({
        rows: [
          {
            policy_key: "ai_whale_profiles",
            payload,
            effective_at: new Date(),
            created_at: new Date(),
          },
        ],
      }),
    } as unknown as Parameters<typeof resolveIntelPolicy>[0];
    const effective = (await resolveIntelPolicy(db, "ai_whale_profiles"))
      .effective;
    assert.equal(effective.reasoningEffort, payload.reasoningEffort ?? "high");
  }
} finally {
  globalThis.fetch = originalFetch;
  env.openRouterKey = originalKey;
  env.aiWhaleProfileModel = originalModel;
}
console.log(
  "whale profile completion tests passed (mock provider, no paid calls)",
);

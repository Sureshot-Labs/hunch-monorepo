import { createHash, randomBytes } from "node:crypto";
import {
  qualityAbKeyMode,
  qualityCases,
  qualityPrompt,
} from "./product-quality-prompt-cases.js";
import {
  DEFAULT_JEV_MODEL,
  jevRequestModel,
} from "./lib/jev-model-identity.js";
import { getOpenRouterModelPricingPerM } from "./lib/ai-pricing.js";
import { extractProviderCostUsd } from "./lib/ai-cost.js";
import { buildOpenRouterReasoningOptions } from "./lib/openrouter-reasoning.js";

// Offline only: no service imports that open pools, no production configuration.
const args = process.argv.slice(2);
const execute = args.includes("--execute");
const { shared, scoutOnly } = qualityAbKeyMode(args);
const seed =
  process.env.HUNCH_QA_BLIND_SEED ??
  (execute ? randomBytes(16).toString("hex") : "offline-dry-run");
function flip(id: string) {
  return (
    createHash("sha256").update(seed).update(":").update(id).digest()[0] % 2 ===
    1
  );
}
if (args.includes("--reveal")) {
  if (!process.env.HUNCH_QA_BLIND_SEED)
    throw Error("The original blinding seed is required");
  console.log(
    JSON.stringify(
      qualityCases.map((c) => ({
        id: c.id,
        A: flip(c.id) ? "candidate" : "current",
        expected: c.expected,
      })),
    ),
  );
} else if (!execute) {
  console.log(
    JSON.stringify({
      mode: "dry_run",
      cases: qualityCases.length,
      calls: qualityCases.length * 2,
      spendUsd: 0,
      limitUsd: 10,
    }),
  );
} else {
  const apiKey = shared
    ? process.env.OPENROUTER_API_KEY
    : process.env.HUNCH_QA_OPENROUTER_API_KEY;
  if (!apiKey || !process.env.HUNCH_QA_BLIND_SEED)
    throw Error(
      "An explicitly selected key and a private blinding seed are required",
    );
  const models = {
    scout: jevRequestModel(DEFAULT_JEV_MODEL),
    map: process.env.HUNCH_QA_MAP_MODEL ?? "openai/gpt-6-sol",
    writer: process.env.HUNCH_QA_WRITER_MODEL ?? "openai/gpt-6.1-sol",
  };
  const headers = {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
    "X-Title": "Hunch offline product QA",
  };
  const getLimit = shared
    ? null
    : await fetch("https://openrouter.ai/api/v1/key", {
        headers,
        redirect: "error",
        signal: AbortSignal.timeout(10_000),
      }).catch(() => null);
  if (!shared && !getLimit?.ok)
    throw Error("Could not verify the dedicated key cap");
  const { data } = getLimit ? await getLimit.json() : { data: null };
  const remaining = shared ? 10 : data?.limit_remaining;
  if (
    !shared &&
    (typeof data?.limit !== "number" ||
      data.limit <= 0 ||
      data.limit > 10 ||
      typeof remaining !== "number" ||
      remaining <= 0 ||
      remaining > 10 ||
      data.limit_reset != null)
  ) {
    throw Error(
      "QA key needs a non-resetting maximum total spend of $10 or less",
    );
  }
  let reserved = 0;
  let reported = 0;
  let unconfirmedCosts = 0;
  const pairs = [];
  for (const c of qualityCases) {
    if (shared && c.stage === "scout") continue;
    if (scoutOnly && c.stage !== "scout") continue;
    const trial = (variant: "current" | "candidate") => {
      const prompt = qualityPrompt(c.stage, variant);
      const model = models[c.stage];
      const isScout = c.stage === "scout";
      const options = Object.entries(
        "options" in c.input ? c.input.options : {},
      );
      const pricing = isScout
        ? null
        : getOpenRouterModelPricingPerM(model, 32_768);
      if (!isScout && !pricing)
        throw Error("Unlisted model pricing; abort before sending prompts");
      const body = isScout
        ? {
            model,
            state: Object.fromEntries(options),
            questions: {
              preselect: {
                type: "choice",
                instructions: prompt,
                criteria: Object.fromEntries([
                  ...options.map(([key]) => [key, `Investigate option ${key}`]),
                  ["none", "No lead worth further investigation"],
                ]),
              },
            },
          }
        : {
            model,
            max_tokens: 4096,
            ...buildOpenRouterReasoningOptions({
              model,
              effort: "low",
              legacyTemperature: 0,
            }),
            response_format: { type: "json_object" },
            messages: [
              { role: "system", content: prompt },
              { role: "user", content: JSON.stringify(c.input) },
            ],
            provider: {
              allow_fallbacks: false,
              require_parameters: true,
              max_price: {
                prompt: pricing?.inputPerM ?? 0,
                completion: pricing?.outputPerM ?? 0,
                request: 0,
              },
            },
          };
      const json = JSON.stringify(body);
      if (Buffer.byteLength(json) > 16_384)
        throw Error("Fixture exceeds conservative prompt budget");
      // Jev 1.14 text-only list price $0.042/M input; reserve more than
      // its entire published 262144-token context would cost, no fallback.
      const reserve = pricing
        ? (2 * (32768 * pricing.inputPerM + 4096 * pricing.outputPerM)) / 1e6
        : 0.02;
      return {
        path: isScout ? "/api/alpha/decisions" : "/api/v1/chat/completions",
        json,
        reserve,
      };
    };
    const order = (
      flip(c.id) ? ["candidate", "current"] : ["current", "candidate"]
    ) as ["current" | "candidate", "current" | "candidate"];
    const trials = order.map(trial);
    if (reserved + trials.reduce((sum, t) => sum + t.reserve, 0) > remaining)
      break;
    const outputs = [];
    for (const t of trials) {
      reserved += t.reserve; // Do not release ambiguous or failed requests or retry them.
      const res = await fetch(`https://openrouter.ai${t.path}`, {
        method: "POST",
        headers,
        body: t.json,
        redirect: "error",
        signal: AbortSignal.timeout(45_000),
      }).catch(() => null);
      if (!res?.ok) {
        unconfirmedCosts++;
        outputs.push({ failure: res?.status ?? "transport" });
        continue;
      }
      const payload = await res.json().catch(() => null);
      const charged = extractProviderCostUsd(payload).providerCostUsd;
      if (charged != null) {
        reported += charged;
        reserved += Math.max(0, charged - t.reserve);
      } else unconfirmedCosts++;
      outputs.push({
        output:
          c.stage === "scout"
            ? payload?.answers?.preselect
            : (payload?.choices?.[0]?.message?.content ?? null),
      });
    }
    pairs.push({
      id: c.id,
      stage: c.stage,
      input: c.input,
      A: outputs[0],
      B: outputs[1],
    });
    if (reserved >= remaining) break;
  }
  console.log(
    JSON.stringify({
      pairs,
      reportedUsd: reported,
      unconfirmedCosts,
      reservedUpperBoundUsd: reserved,
      limitUsd: remaining,
      scoutSkipped: shared,
    }),
  );
}

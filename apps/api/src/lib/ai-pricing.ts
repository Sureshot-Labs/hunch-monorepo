import { createOpenRouterPricingCatalog } from "./openrouter-pricing-catalog.js";

const livePricing = createOpenRouterPricingCatalog();
export const refreshOpenRouterModelPricing = livePricing.refresh;

export type OpenRouterModelPricingPerM = {
  inputPerM: number;
  outputPerM: number;
  webSearchPerCallUsd?: number;
  xSearchPerCallUsd?: number;
};

export type OpenRouterEmbeddingPricingPerM = {
  inputPerM: number;
  outputPerM: number;
};

// Verified from OpenRouter `/api/v1/models` and live usage.cost probes (2026-02-27).
const OPENROUTER_MODEL_PRICING_PER_M: Record<
  string,
  OpenRouterModelPricingPerM
> = {
  "openai/gpt-5.2": {
    inputPerM: 1.75,
    outputPerM: 14,
    webSearchPerCallUsd: 0.01,
  },
  "openai/gpt-5-nano": {
    inputPerM: 0.05,
    outputPerM: 0.4,
    webSearchPerCallUsd: 0.01,
  },
  "openai/gpt-5.4": {
    inputPerM: 2.5,
    outputPerM: 15,
    webSearchPerCallUsd: 0.01,
  },
  "openai/gpt-5.4-mini": {
    inputPerM: 0.75,
    outputPerM: 4.5,
    webSearchPerCallUsd: 0.01,
  },
  "openai/gpt-5.4-nano": {
    inputPerM: 0.2,
    outputPerM: 1.25,
    webSearchPerCallUsd: 0.01,
  },
  "openai/gpt-5.5": {
    inputPerM: 5,
    outputPerM: 30,
    webSearchPerCallUsd: 0.01,
  },
  // OpenRouter catalog verified 2026-09-06; provider usage.cost remains primary.
  "openai/gpt-5.6-sol": {
    inputPerM: 2,
    outputPerM: 10,
    webSearchPerCallUsd: 0.01,
  },
  "openai/gpt-5.6-luna": {
    inputPerM: 0.2,
    outputPerM: 1.2,
    webSearchPerCallUsd: 0.01,
  },
  "openai/gpt-5.6-terra": {
    inputPerM: 2,
    outputPerM: 12,
    webSearchPerCallUsd: 0.01,
  },
  // Standard, non-promotional Astra tariff (OpenAI + OpenRouter, 2026-09-06).
  "openai/gpt-6-astra": {
    inputPerM: 10,
    outputPerM: 50,
    webSearchPerCallUsd: 0.01,
  },
};

// Verified from live usage.cost probe for openai/text-embedding-3-small.
const OPENROUTER_EMBEDDING_PRICING_PER_M: Record<
  string,
  OpenRouterEmbeddingPricingPerM
> = {
  "openai/text-embedding-3-small": {
    inputPerM: 0.02,
    outputPerM: 0,
  },
};

function normalizeModelId(id: string | null | undefined): string {
  return (id ?? "").trim().toLowerCase();
}

export function getOpenRouterModelPricingPerM(
  model: string | null | undefined,
  inputTokens = 0,
): OpenRouterModelPricingPerM | null {
  const normalized = normalizeModelId(model);
  if (!normalized) return null;
  const fallback =
    OPENROUTER_MODEL_PRICING_PER_M[normalized.replace(/-\d{8}$/, "")] ?? null;
  const current = livePricing.get(normalized, inputTokens) ?? fallback;
  if (/^openai\/gpt-6-astra(?:-\d{8})?$/.test(normalized) && current) {
    // Budget/fallback estimates must not rely on a temporary promotion.
    // Actual usage.cost is still accounted at the price really charged.
    return {
      ...current,
      inputPerM: Math.max(current.inputPerM, inputTokens > 272000 ? 20 : 10),
      outputPerM: Math.max(current.outputPerM, inputTokens > 272000 ? 75 : 50),
    };
  }
  return current;
}

export function getOpenRouterEmbeddingPricingPerM(
  model: string | null | undefined,
): OpenRouterEmbeddingPricingPerM | null {
  const normalized = normalizeModelId(model);
  if (!normalized) return null;
  return OPENROUTER_EMBEDDING_PRICING_PER_M[normalized] ?? null;
}

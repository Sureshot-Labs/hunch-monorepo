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
const OPENROUTER_MODEL_PRICING_PER_M: Record<string, OpenRouterModelPricingPerM> = {
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
): OpenRouterModelPricingPerM | null {
  const normalized = normalizeModelId(model);
  if (!normalized) return null;
  return OPENROUTER_MODEL_PRICING_PER_M[normalized] ?? null;
}

export function getOpenRouterEmbeddingPricingPerM(
  model: string | null | undefined,
): OpenRouterEmbeddingPricingPerM | null {
  const normalized = normalizeModelId(model);
  if (!normalized) return null;
  return OPENROUTER_EMBEDDING_PRICING_PER_M[normalized] ?? null;
}

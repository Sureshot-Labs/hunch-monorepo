const USD_TICKS_PER_USD = 10_000_000_000;

export type CostSource = "provider_reported" | "estimated";

export type ProviderCost = {
  providerCostUsd: number | null;
  providerCostField: string | null;
  providerCostUsdTicks: number | null;
};

export type EstimatedCost = {
  inputCostUsd: number;
  outputCostUsd: number;
  tokenCostUsd: number;
  toolCostUsd: number;
  estimatedCostUsd: number;
};

export type ResolvedCost = EstimatedCost &
  ProviderCost & {
    chargedCostUsd: number;
    costSource: CostSource;
  };

type EstimateParams = {
  inputTokens: number;
  outputTokens: number;
  priceInputPerM: number;
  priceOutputPerM: number;
  webSearchCalls?: number;
  xSearchCalls?: number;
  priceWebPer1k?: number;
  priceXPer1k?: number;
};

type ResolveParams = EstimateParams &
  Partial<
    Pick<
      ProviderCost,
      "providerCostUsd" | "providerCostField" | "providerCostUsdTicks"
    >
  >;

function toFiniteNonNegative(value: unknown): number | null {
  if (typeof value === "number") {
    if (Number.isFinite(value) && value >= 0) return value;
    return null;
  }
  if (typeof value === "string") {
    const cleaned = value.replace(/[$,\s]/g, "").trim();
    if (!cleaned) return null;
    const parsed = Number(cleaned);
    if (Number.isFinite(parsed) && parsed >= 0) return parsed;
    return null;
  }
  return null;
}

function pickObject(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function pickCostField(
  obj: Record<string, unknown>,
  keys: readonly string[],
): { value: number; field: string } | null {
  for (const key of keys) {
    if (!(key in obj)) continue;
    const direct = toFiniteNonNegative(obj[key]);
    if (direct != null) return { value: direct, field: key };

    const nested = pickObject(obj[key]);
    if (!nested) continue;
    const nestedDirect =
      toFiniteNonNegative(nested.usd) ??
      toFiniteNonNegative(nested.value) ??
      toFiniteNonNegative(nested.amount);
    if (nestedDirect != null)
      return { value: nestedDirect, field: `${key}.usd` };
  }
  return null;
}

export function extractProviderCostUsd(payloadOrUsage: unknown): ProviderCost {
  const root = pickObject(payloadOrUsage);
  const usage = root ? pickObject(root.usage) : null;
  const searchScopes = usage ? [usage, root] : [root];

  for (const scope of searchScopes) {
    if (!scope) continue;
    const ticks = pickCostField(scope, [
      "cost_in_usd_ticks",
      "provider_cost_in_usd_ticks",
    ]);
    if (ticks) {
      return {
        providerCostUsd: ticks.value / USD_TICKS_PER_USD,
        providerCostField: ticks.field,
        providerCostUsdTicks: ticks.value,
      };
    }
  }

  for (const scope of searchScopes) {
    if (!scope) continue;
    const usd = pickCostField(scope, [
      "cost_in_usd",
      "provider_cost_usd",
      "cost_usd",
      "total_cost_usd",
      "usd_cost",
      "cost",
    ]);
    if (usd) {
      return {
        providerCostUsd: usd.value,
        providerCostField: usd.field,
        providerCostUsdTicks: null,
      };
    }
  }

  return {
    providerCostUsd: null,
    providerCostField: null,
    providerCostUsdTicks: null,
  };
}

export function computeEstimatedCostUsd(params: EstimateParams): EstimatedCost {
  const inputTokens = Math.max(0, Number(params.inputTokens) || 0);
  const outputTokens = Math.max(0, Number(params.outputTokens) || 0);
  const priceInputPerM = Math.max(0, Number(params.priceInputPerM) || 0);
  const priceOutputPerM = Math.max(0, Number(params.priceOutputPerM) || 0);
  const webSearchCalls = Math.max(0, Number(params.webSearchCalls) || 0);
  const xSearchCalls = Math.max(0, Number(params.xSearchCalls) || 0);
  const priceWebPer1k = Math.max(0, Number(params.priceWebPer1k) || 0);
  const priceXPer1k = Math.max(0, Number(params.priceXPer1k) || 0);

  const inputCostUsd = (inputTokens / 1_000_000) * priceInputPerM;
  const outputCostUsd = (outputTokens / 1_000_000) * priceOutputPerM;
  const tokenCostUsd = inputCostUsd + outputCostUsd;
  const toolCostUsd =
    (webSearchCalls / 1_000) * priceWebPer1k +
    (xSearchCalls / 1_000) * priceXPer1k;
  const estimatedCostUsd = tokenCostUsd + toolCostUsd;

  return {
    inputCostUsd,
    outputCostUsd,
    tokenCostUsd,
    toolCostUsd,
    estimatedCostUsd,
  };
}

export function resolveAiCost(params: ResolveParams): ResolvedCost {
  const estimated = computeEstimatedCostUsd(params);
  const providerCostUsd =
    typeof params.providerCostUsd === "number" &&
    Number.isFinite(params.providerCostUsd)
      ? Math.max(0, params.providerCostUsd)
      : null;
  const providerCostUsdTicks =
    typeof params.providerCostUsdTicks === "number" &&
    Number.isFinite(params.providerCostUsdTicks)
      ? Math.max(0, params.providerCostUsdTicks)
      : null;
  const costSource: CostSource =
    providerCostUsd != null ? "provider_reported" : "estimated";
  const chargedCostUsd = providerCostUsd ?? estimated.estimatedCostUsd;

  return {
    ...estimated,
    providerCostUsd,
    providerCostField: params.providerCostField ?? null,
    providerCostUsdTicks,
    chargedCostUsd,
    costSource,
  };
}

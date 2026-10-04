import { z } from "zod";
import { extractAiUsageMetrics } from "../lib/ai-response.js";
import { resolveAiCost } from "../lib/ai-cost.js";
import { getOpenRouterModelPricingPerM } from "../lib/ai-pricing.js";

const cost = z.number().finite().nonnegative().nullable();
export const xEditorialCallUsageSchema = z
  .object({
    model: z.string().min(1).max(200),
    inputTokens: z.number().int().nonnegative(),
    outputTokens: z.number().int().nonnegative(),
    reasoningTokens: z.number().int().nonnegative(),
    providerCostUsd: cost,
    chargedCostUsd: cost,
    costSource: z.enum(["provider_reported", "estimated", "unknown"]),
  })
  .strict();

export const xEditorialUsageSchema = z
  .object({
    calls: z.array(xEditorialCallUsageSchema).min(1).max(2),
    chargedCostUsd: cost,
    knownCostUsd: z.number().finite().nonnegative(),
    unknownCostCalls: z.number().int().min(0).max(2),
  })
  .strict();

export type XEditorialCallUsage = z.infer<typeof xEditorialCallUsageSchema>;
export type XEditorialUsage = z.infer<typeof xEditorialUsageSchema>;

/** No extra request. Provider cost wins; incomplete usage is never free usage. */
export function readXEditorialCallUsage(
  payload: unknown,
  model: string,
): XEditorialCallUsage {
  const usage = extractAiUsageMetrics(payload);
  const tokenCount = (value: number) =>
    Number.isSafeInteger(value) && value >= 0 ? value : 0;
  const inputTokens = tokenCount(usage.inputTokens);
  const outputTokens = tokenCount(usage.outputTokens);
  const rawUsage =
    payload && typeof payload === "object"
      ? (
          payload as {
            usage?: { prompt_tokens?: unknown; completion_tokens?: unknown };
          }
        ).usage
      : undefined;
  const hasTokens = [
    rawUsage?.prompt_tokens,
    rawUsage?.completion_tokens,
  ].every(
    (value) =>
      typeof value === "number" && Number.isSafeInteger(value) && value >= 0,
  );
  const pricing = hasTokens
    ? getOpenRouterModelPricingPerM(model, inputTokens)
    : null;
  const resolved = resolveAiCost({
    inputTokens,
    outputTokens,
    priceInputPerM: pricing?.inputPerM ?? 0,
    priceOutputPerM: pricing?.outputPerM ?? 0,
    providerCostUsd: usage.providerCostUsd,
    providerCostField: usage.providerCostField,
    providerCostUsdTicks: usage.providerCostUsdTicks,
  });
  const known = usage.providerCostUsd != null || pricing != null;
  return {
    model,
    inputTokens,
    outputTokens,
    reasoningTokens: tokenCount(usage.reasoningTokens),
    providerCostUsd: usage.providerCostUsd,
    chargedCostUsd: known ? resolved.chargedCostUsd : null,
    costSource: known ? resolved.costSource : "unknown",
  };
}

export function summarizeXEditorialUsage(
  calls: readonly XEditorialCallUsage[],
): XEditorialUsage | undefined {
  if (!calls.length) return undefined;
  const knownCostUsd = calls.reduce(
    (sum, call) => sum + (call.chargedCostUsd ?? 0),
    0,
  );
  const unknownCostCalls = calls.filter(
    (call) => call.chargedCostUsd == null,
  ).length;
  return {
    calls: [...calls],
    chargedCostUsd: unknownCostCalls ? null : knownCostUsd,
    knownCostUsd,
    unknownCostCalls,
  };
}

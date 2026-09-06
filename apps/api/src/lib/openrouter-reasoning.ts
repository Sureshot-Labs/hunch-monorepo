import { z } from "zod";

export const openRouterReasoningEffortSchema = z.enum([
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);
export type OpenRouterReasoningEffort = z.infer<
  typeof openRouterReasoningEffortSchema
>;
export const openRouterTemperatureSchema = z.coerce
  .number()
  .finite()
  .min(0)
  .max(2);

export function isModernOpenAIReasoningModel(model: string): boolean {
  return /^openai\/(?:gpt-5\.6(?:-(?:sol|luna|terra))?|gpt-6-astra)(?:-\d{8})?$/.test(
    model.trim(),
  );
}

export function supportsOpenRouterReasoningEffort(
  model: string | undefined,
  effort: OpenRouterReasoningEffort | null | undefined,
): boolean {
  return !(
    model &&
    /^openai\/gpt-6-astra(?:-\d{8})?$/.test(model.trim()) &&
    effort === "none"
  );
}

// No option preserves the caller's legacy request. GPT-5.6 does not accept
// temperature or minimal effort; an inherited editorial minimal maps to low.
export function buildOpenRouterReasoningOptions(input: {
  model: string;
  effort?: OpenRouterReasoningEffort | null;
  legacyTemperature?: number;
  legacyEffort?: OpenRouterReasoningEffort;
  legacyExcludeReasoning?: boolean;
}) {
  const modern = isModernOpenAIReasoningModel(input.model);
  const requested = input.effort ?? input.legacyEffort;
  const effort = modern && requested === "minimal" ? "low" : requested;
  if (!supportsOpenRouterReasoningEffort(input.model, effort)) {
    throw new Error(
      "GPT-6 Astra requires reasoning: choose low, medium, high, xhigh or max",
    );
  }
  return {
    ...(!modern && input.effort == null && input.legacyTemperature != null
      ? { temperature: input.legacyTemperature }
      : {}),
    ...(effort != null
      ? {
          reasoning: {
            effort,
            ...(input.legacyExcludeReasoning === false &&
            input.effort == null &&
            !modern
              ? {}
              : { exclude: true }),
          },
        }
      : {}),
    ...(modern || input.effort != null
      ? { provider: { require_parameters: true } }
      : {}),
  };
}

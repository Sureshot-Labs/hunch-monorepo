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
  return /^openai\/(?:gpt-5\.6(?:-(?:sol|luna|terra))?|gpt-6-astra)(?:-pro)?(?:-\d{8})?(?::[\w-]+)?$/.test(
    model.trim(),
  );
}

// Verified against OpenRouter's public model catalog. Keep this separate from
// the structured-output capability check used by existing callers.
function omitsTemperature(model: string): boolean {
  return (
    isModernOpenAIReasoningModel(model) ||
    /^openai\/gpt-5\.[45](?:-(?:mini|nano|pro))?(?:-\d{8})?(?::[\w-]+)?$/.test(
      model.trim(),
    )
  );
}

export function supportsOpenRouterReasoningEffort(
  model: string | undefined,
  effort: OpenRouterReasoningEffort | null | undefined,
): boolean {
  if (
    model &&
    /^openai\/gpt-5\.[45](?:-(?:mini|nano))?(?:-\d{8})?(?::[\w-]+)?$/.test(
      model.trim(),
    ) &&
    effort === "max"
  )
    return false;
  if (
    model &&
    /^openai\/gpt-5\.4-pro(?:-\d{8})?(?::[\w-]+)?$/.test(model.trim()) &&
    effort != null &&
    !["medium", "high", "xhigh"].includes(effort)
  )
    return false;
  return !(
    model &&
    /^openai\/gpt-6-astra(?:-pro)?(?:-\d{8})?(?::[\w-]+)?$/.test(
      model.trim(),
    ) &&
    effort === "none"
  );
}

// Preserve legacy options for other families. Catalogued GPT models omit
// temperature; the historical editorial minimal setting maps to low.
export function buildOpenRouterReasoningOptions(input: {
  model: string;
  effort?: OpenRouterReasoningEffort | null;
  legacyTemperature?: number;
  legacyEffort?: OpenRouterReasoningEffort;
  legacyExcludeReasoning?: boolean;
}) {
  const modern = omitsTemperature(input.model);
  const requested = input.effort ?? input.legacyEffort;
  const effort = modern && requested === "minimal" ? "low" : requested;
  if (!supportsOpenRouterReasoningEffort(input.model, effort)) {
    throw new Error(
      `Model ${input.model} requires reasoning settings it supports; unsupported effort: ${effort}`,
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

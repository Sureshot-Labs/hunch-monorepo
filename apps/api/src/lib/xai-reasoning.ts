import { z } from "zod";

// Responses API vocabulary, not OpenRouter's expanded effort enum.
export const xaiReasoningEffortSchema = z.enum([
  "low",
  "medium",
  "high",
  "xhigh",
]);
export type XaiReasoningEffort = z.infer<typeof xaiReasoningEffortSchema>;

export function buildXaiReasoningOptions(input: {
  effort?: XaiReasoningEffort | null;
  legacyEffort?: XaiReasoningEffort;
}) {
  const effort = input.effort ?? input.legacyEffort;
  return effort == null ? {} : { reasoning: { effort } };
}

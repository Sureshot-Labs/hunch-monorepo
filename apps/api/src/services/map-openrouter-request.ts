import {
  buildOpenRouterReasoningOptions,
  isModernOpenAIReasoningModel,
  type OpenRouterReasoningEffort,
} from "../lib/openrouter-reasoning.js";
import { MAP_SIGNALS_AGENT_OUTPUT_V2_JSON_SCHEMA } from "../schemas/ai-map-signals.js";
const { $schema: _dialect, ...signalSchema } =
  MAP_SIGNALS_AGENT_OUTPUT_V2_JSON_SCHEMA;

export function buildMapOpenRouterOptions(input: {
  model: string;
  reasoningEffort?: OpenRouterReasoningEffort | null;
  temperature?: number | null;
  stage: "label" | "signals";
}) {
  return {
    ...buildOpenRouterReasoningOptions({
      model: input.model,
      effort: input.reasoningEffort,
      legacyTemperature: input.temperature ?? 0,
      legacyEffort: "low",
      legacyExcludeReasoning: false,
    }),
    ...(input.stage === "signals"
      ? {
          response_format: isModernOpenAIReasoningModel(input.model)
            ? {
                type: "json_schema",
                json_schema: {
                  name: "map_signals_v2",
                  strict: true,
                  schema: signalSchema,
                },
              }
            : { type: "json_object" },
        }
      : {}),
  };
}

import { z } from "zod";
import { isModernOpenAIReasoningModel } from "../lib/openrouter-reasoning.js";
import {
  holderResearchAgentOutputV1Schema,
  holderResearchFinalOutputV2Schema,
  holderResearchTriageOutputV1Schema,
  holderResearchTriageOutputV2Schema,
} from "../schemas/holder-research.js";

export function buildHolderResearchResponseFormat(input: {
  model: string;
  stage: "triage" | "final";
  useV2: boolean;
}) {
  if (!isModernOpenAIReasoningModel(input.model))
    return { type: "json_object" };
  const schema =
    input.stage === "triage"
      ? input.useV2
        ? holderResearchTriageOutputV2Schema
        : holderResearchTriageOutputV1Schema
      : input.useV2
        ? holderResearchFinalOutputV2Schema
        : holderResearchAgentOutputV1Schema;
  // Strict provider schemas require every declared property to be required.
  // Existing optional fields remain valid parser inputs when explicitly returned.
  const strictSchema = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(strictSchema);
    if (value == null || typeof value !== "object") return value;
    const source = value as Record<string, unknown>;
    const result = Object.fromEntries(
      Object.entries(source)
        .filter(([key]) => key !== "$schema" && key !== "default")
        .map(([key, entry]) => [key, strictSchema(entry)]),
    );
    if (source.type === "object" && source.properties) {
      result.required = Object.keys(source.properties);
      result.additionalProperties = false;
    }
    return result;
  };
  return {
    type: "json_schema",
    json_schema: {
      name: `holder_research_${input.stage}_v${input.useV2 ? 2 : 1}`,
      strict: true,
      schema: strictSchema(z.toJSONSchema(schema)),
    },
  };
}

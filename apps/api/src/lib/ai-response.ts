import { extractProviderCostUsd } from "./ai-cost.js";

export type AiToolUsageDetails = {
  code_interpreter_calls: number;
  document_search_calls: number;
  file_search_calls: number;
  mcp_calls: number;
  web_search_calls: number;
  x_search_calls: number;
};

export type AiUsageMetrics = {
  cachedInputTokens: number;
  inputTokens: number;
  numServerSideToolsUsed: number;
  outputTokens: number;
  providerCostField: string | null;
  providerCostUsd: number | null;
  providerCostUsdTicks: number | null;
  reasoningTokens: number;
  toolUsageDetails: AiToolUsageDetails;
  totalTokens: number;
};

const EMPTY_TOOL_USAGE: AiToolUsageDetails = {
  code_interpreter_calls: 0,
  document_search_calls: 0,
  file_search_calls: 0,
  mcp_calls: 0,
  web_search_calls: 0,
  x_search_calls: 0,
};

export const EMPTY_AI_USAGE: AiUsageMetrics = {
  cachedInputTokens: 0,
  inputTokens: 0,
  numServerSideToolsUsed: 0,
  outputTokens: 0,
  providerCostField: null,
  providerCostUsd: null,
  providerCostUsdTicks: null,
  reasoningTokens: 0,
  toolUsageDetails: EMPTY_TOOL_USAGE,
  totalTokens: 0,
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function toNonNegativeNumber(value: unknown): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

function toPositiveReportedCount(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : 0;
}

function extractOutputItems(payload: unknown): Array<Record<string, unknown>> {
  const output = asRecord(payload)?.output;
  if (!Array.isArray(output)) return [];
  return output.flatMap((item) => {
    const record = asRecord(item);
    return record ? [record] : [];
  });
}

export function extractAiOutputText(payload: unknown): string {
  const root = asRecord(payload);
  if (!root) return "";
  if (
    typeof root.output_text === "string" &&
    root.output_text.trim().length > 0
  ) {
    return root.output_text;
  }

  const parts: string[] = [];
  for (const item of extractOutputItems(payload)) {
    if (item.type !== "message" || !Array.isArray(item.content)) continue;
    for (const block of item.content) {
      const text = asRecord(block)?.text;
      if (typeof text === "string" && text.trim().length > 0) {
        parts.push(text);
      }
    }
  }
  return parts.join("\n\n");
}

export function countAiCitations(payload: unknown): number {
  const urls = new Set<string>();
  const citations = asRecord(payload)?.citations;
  if (Array.isArray(citations)) {
    for (const citation of citations) {
      const url = asRecord(citation)?.url;
      if (typeof url === "string" && url.trim().length > 0) {
        urls.add(url.trim());
      }
    }
  }

  for (const item of extractOutputItems(payload)) {
    if (item.type !== "message" || !Array.isArray(item.content)) continue;
    for (const block of item.content) {
      const annotations = asRecord(block)?.annotations;
      if (!Array.isArray(annotations)) continue;
      for (const annotation of annotations) {
        const url = asRecord(annotation)?.url;
        if (typeof url === "string" && url.trim().length > 0) {
          urls.add(url.trim());
        }
      }
    }
  }
  return urls.size;
}

export function extractAiServerSideToolUsage(
  payload: unknown,
): Record<string, unknown> | null {
  const root = asRecord(payload);
  if (!root) return null;
  const topLevel = asRecord(root.server_side_tool_usage);
  if (topLevel) return topLevel;
  return asRecord(asRecord(root.usage)?.server_side_tool_usage_details);
}

export function extractAiSuccessfulToolCount(payload: unknown): number {
  const usage = asRecord(asRecord(payload)?.usage);
  if (!usage) return 0;
  const direct = toPositiveReportedCount(usage.num_server_side_tools_used);
  if (direct > 0) return direct;
  return Object.values(
    extractAiServerSideToolUsage(payload) ?? {},
  ).reduce<number>((sum, value) => sum + toPositiveReportedCount(value), 0);
}

export function countAiToolAttempts(payload: unknown): number {
  const topToolCalls = asRecord(payload)?.tool_calls;
  if (Array.isArray(topToolCalls)) return topToolCalls.length;
  return extractOutputItems(payload).filter((output) => {
    const type = output.type;
    return (
      type === "web_search_call" ||
      type === "x_search_call" ||
      type === "custom_tool_call" ||
      type === "code_interpreter_call" ||
      type === "file_search_call" ||
      type === "mcp_call"
    );
  }).length;
}

export function extractAiUsageMetrics(payload: unknown): AiUsageMetrics {
  const usage = asRecord(asRecord(payload)?.usage);
  if (!usage) return EMPTY_AI_USAGE;

  const inputTokens = toNonNegativeNumber(
    usage.input_tokens ?? usage.prompt_tokens,
  );
  const outputTokens = toNonNegativeNumber(
    usage.output_tokens ?? usage.completion_tokens,
  );
  const reportedTotal =
    usage.total_tokens == null ? Number.NaN : Number(usage.total_tokens);
  const totalTokens =
    Number.isFinite(reportedTotal) && reportedTotal >= 0
      ? reportedTotal
      : inputTokens + outputTokens;
  const inputDetails =
    asRecord(usage.input_tokens_details) ??
    asRecord(usage.prompt_tokens_details);
  const outputDetails =
    asRecord(usage.output_tokens_details) ??
    asRecord(usage.completion_tokens_details);
  const details = asRecord(usage.server_side_tool_usage_details);
  const topLevelUsage = extractAiServerSideToolUsage(payload) ?? {};
  const toolUsageDetails: AiToolUsageDetails = {
    code_interpreter_calls: toNonNegativeNumber(
      details?.code_interpreter_calls,
    ),
    document_search_calls: toNonNegativeNumber(details?.document_search_calls),
    file_search_calls: toNonNegativeNumber(details?.file_search_calls),
    mcp_calls: toNonNegativeNumber(details?.mcp_calls),
    web_search_calls: toNonNegativeNumber(
      details?.web_search_calls ??
        topLevelUsage.SERVER_SIDE_TOOL_WEB_SEARCH ??
        topLevelUsage.web_search_calls,
    ),
    x_search_calls: toNonNegativeNumber(
      details?.x_search_calls ??
        topLevelUsage.SERVER_SIDE_TOOL_X_SEARCH ??
        topLevelUsage.x_search_calls,
    ),
  };
  const providerCost = extractProviderCostUsd(payload);

  return {
    cachedInputTokens: toNonNegativeNumber(inputDetails?.cached_tokens),
    inputTokens,
    numServerSideToolsUsed: toNonNegativeNumber(
      usage.num_server_side_tools_used,
    ),
    outputTokens,
    providerCostField: providerCost.providerCostField,
    providerCostUsd: providerCost.providerCostUsd,
    providerCostUsdTicks: providerCost.providerCostUsdTicks,
    reasoningTokens: toNonNegativeNumber(
      outputDetails?.reasoning_tokens ?? outputDetails?.reasoning,
    ),
    toolUsageDetails,
    totalTokens,
  };
}

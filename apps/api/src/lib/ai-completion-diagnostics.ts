import { extractAiUsageMetrics } from "./ai-response.js";

export function aiCompletionMetadata(payload: unknown) {
  const usage = extractAiUsageMetrics(payload);
  const root = payload as {
    choices?: Array<{ finish_reason?: string }>;
    status?: string;
  } | null;
  return {
    finishReason: root?.choices?.[0]?.finish_reason ?? root?.status ?? null,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    reasoningTokens: usage.reasoningTokens,
    providerCostUsd: usage.providerCostUsd,
  };
}

// Only metadata: never log prompts, provider reasoning or generated content.
export function aiCompletionError(payload: unknown): string | null {
  const root = payload as {
    error?: unknown;
    status?: string;
    incomplete_details?: { reason?: string };
    choices?: Array<{
      error?: unknown;
      finish_reason?: string;
      message?: { refusal?: unknown };
    }>;
  } | null;
  const choice = root?.choices?.[0];
  let reason: string | null = null;
  if (root?.error || choice?.error) reason = "provider_error";
  else if (root?.status === "incomplete")
    reason = `incomplete:${root.incomplete_details?.reason ?? "unknown"}`;
  else if (root?.status === "failed") reason = "failed";
  else if (choice?.message?.refusal) reason = "refusal";
  else if (
    ["length", "content_filter", "error"].includes(choice?.finish_reason ?? "")
  )
    reason = choice?.finish_reason ?? null;
  if (reason) {
    const usage = extractAiUsageMetrics(payload);
    return `AI completion ${reason} (outputTokens=${usage.outputTokens}, reasoningTokens=${usage.reasoningTokens})`;
  }
  return null;
}

export function assertAiCompletionComplete(payload: unknown): void {
  const error = aiCompletionError(payload);
  if (error) throw new Error(error);
}

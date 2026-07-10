import assert from "node:assert/strict";

import {
  countAiCitations,
  countAiToolAttempts,
  EMPTY_AI_USAGE,
  extractAiOutputText,
  extractAiServerSideToolUsage,
  extractAiSuccessfulToolCount,
  extractAiUsageMetrics,
} from "./lib/ai-response.js";

function test(name: string, fn: () => void) {
  try {
    fn();
    console.log(`ok - ${name}`);
  } catch (error) {
    console.error(`not ok - ${name}`);
    throw error;
  }
}

test("AI output text falls back from blank aggregate text to message blocks", () => {
  assert.equal(
    extractAiOutputText({
      output_text: "   ",
      output: [
        {
          type: "message",
          content: [{ text: "first" }, { text: "  " }, { text: "second" }],
        },
      ],
    }),
    "first\n\nsecond",
  );
  assert.equal(extractAiOutputText({ output_text: "aggregate" }), "aggregate");
});

test("AI citation counting deduplicates top-level and annotated URLs", () => {
  assert.equal(
    countAiCitations({
      citations: [{ url: "https://one.example " }],
      output: [
        {
          type: "message",
          content: [
            {
              annotations: [
                { url: "https://one.example" },
                { url: "https://two.example" },
              ],
            },
          ],
        },
      ],
    }),
    2,
  );
});

test("AI usage metrics normalize aliases, tool details, and provider cost", () => {
  assert.deepEqual(
    extractAiUsageMetrics({
      usage: {
        prompt_tokens: 10,
        completion_tokens: 5,
        prompt_tokens_details: { cached_tokens: 3 },
        completion_tokens_details: { reasoning: 2 },
        num_server_side_tools_used: 4,
        server_side_tool_usage_details: {
          web_search_calls: 2,
          x_search_calls: 1,
          mcp_calls: 1,
        },
        cost_in_usd_ticks: 2_000_000_000,
      },
    }),
    {
      cachedInputTokens: 3,
      inputTokens: 10,
      numServerSideToolsUsed: 4,
      outputTokens: 5,
      providerCostField: "cost_in_usd_ticks",
      providerCostUsd: 0.2,
      providerCostUsdTicks: 2_000_000_000,
      reasoningTokens: 2,
      toolUsageDetails: {
        code_interpreter_calls: 0,
        document_search_calls: 0,
        file_search_calls: 0,
        mcp_calls: 1,
        web_search_calls: 2,
        x_search_calls: 1,
      },
      totalTokens: 15,
    },
  );
});

test("AI usage metrics reject invalid numeric values", () => {
  const usage = extractAiUsageMetrics({
    usage: {
      input_tokens: "bad",
      output_tokens: -4,
      total_tokens: Number.NaN,
      num_server_side_tools_used: Number.POSITIVE_INFINITY,
      server_side_tool_usage_details: { web_search_calls: -1 },
    },
  });
  assert.equal(usage.inputTokens, 0);
  assert.equal(usage.outputTokens, 0);
  assert.equal(usage.totalTokens, 0);
  assert.equal(usage.numServerSideToolsUsed, 0);
  assert.equal(usage.toolUsageDetails.web_search_calls, 0);
  assert.equal(extractAiUsageMetrics(null), EMPTY_AI_USAGE);
});

test("AI usage metrics treat null total tokens as unreported", () => {
  assert.equal(
    extractAiUsageMetrics({
      usage: { input_tokens: 7, output_tokens: 3, total_tokens: null },
    }).totalTokens,
    10,
  );
});

test("AI successful tool count uses direct count then detail fallback", () => {
  assert.equal(
    extractAiSuccessfulToolCount({
      usage: {
        num_server_side_tools_used: 3,
        server_side_tool_usage_details: { web_search_calls: 9 },
      },
    }),
    3,
  );
  const payload = {
    usage: {
      server_side_tool_usage_details: {
        web_search_calls: 2,
        x_search_calls: 1,
      },
    },
  };
  assert.equal(extractAiSuccessfulToolCount(payload), 3);
  assert.equal(
    extractAiSuccessfulToolCount({
      usage: { server_side_tool_usage_details: { web_search_calls: "2" } },
    }),
    0,
  );
  assert.deepEqual(extractAiServerSideToolUsage(payload), {
    web_search_calls: 2,
    x_search_calls: 1,
  });
});

test("AI tool attempts count top-level and response output calls", () => {
  assert.equal(countAiToolAttempts({ tool_calls: [{}, {}] }), 2);
  assert.equal(
    countAiToolAttempts({
      output: [
        { type: "message" },
        { type: "web_search_call" },
        { type: "mcp_call" },
      ],
    }),
    2,
  );
});

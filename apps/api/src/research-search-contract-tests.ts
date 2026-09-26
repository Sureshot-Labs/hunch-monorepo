import assert from "node:assert/strict";
import {
  buildXaiSearchResponseFormat,
  searchSchemaIssues,
} from "./lib/xai-search-contract.js";
import { countAiCitations, extractAiSourceUrls } from "./lib/ai-response.js";
import {
  holderResearchExternalSearchResponseSchema,
  holderResearchAgentOutputV1Schema,
} from "./schemas/holder-research.js";
import {
  mapSearchAgentOutputV2Schema,
  buildMapSearchUserPromptV2,
} from "./schemas/ai-map-search.js";
import { mapSearchModelTestHooks } from "./ai-map-search-run.js";

for (const [name, schema] of [
  ["holder", holderResearchExternalSearchResponseSchema],
  ["maps", mapSearchAgentOutputV2Schema],
] as const) {
  const request = buildXaiSearchResponseFormat(name, schema);
  assert.equal(request.text.format.type, "json_schema");
  assert.equal(request.text.format.strict, true);
  assert.equal(request.text.format.schema.additionalProperties, false);
  assert.equal("$schema" in request.text.format.schema, false);
  assert.deepEqual(request.include, ["no_inline_citations"]);
}
assert.equal(
  holderResearchAgentOutputV1Schema.shape.summary.safeParse("x".repeat(321))
    .success,
  false,
);
assert.ok(
  searchSchemaIssues(holderResearchExternalSearchResponseSchema, {
    summary: "x".repeat(2049),
  }).some((i) => i.path === "summary"),
);

const provider = {
  citations: ["https://source.test/a"],
  output: [
    {
      type: "web_search_call",
      action: {
        sources: [{ url: "https://source.test/b" }, "https://source.test/c"],
      },
    },
    {
      type: "message",
      content: [{ annotations: [{ url: "https://source.test/a" }] }],
    },
  ],
};
assert.deepEqual(extractAiSourceUrls(provider), [
  "https://source.test/a",
  "https://source.test/b",
  "https://source.test/c",
]);
assert.equal(countAiCitations(provider), 3);

const brief =
  "Factual source context. ".repeat(18) + "Decisive exception at the end.";
const prompt = buildMapSearchUserPromptV2(
  {
    runId: "test",
    level: 1,
    nodeId: "test",
    nodeLabel: "test",
    nodeRepresentative: "test",
    parentLabel: null,
    siblingLabels: [],
    childLabels: [],
    sampleEventTitles: [],
    sampleEventMarketTitles: [],
    priorHeadlines: [],
    priorEvidenceBriefs: [brief],
    softToolCapThisCall: 2,
    windowHoursForThisCall: 72,
  },
  {
    maxEvidence: 2,
    windowHours: 72,
    recentHoursHint: 24,
    includeWebTool: true,
    includeXTool: false,
    requireDistinctDomains: false,
  },
);
assert.ok(prompt.includes(brief));

// Legacy lenient repair must not silently change an otherwise valid URL.
const sourceUrl = "https://source.test/article?query=" + "a".repeat(1300);
const recovered = mapSearchModelTestHooks.parseAgentOutput(
  JSON.stringify({
    version: "legacy",
    status: "OK",
    summary: "Older response recovered without changing its link.",
    evidence: [
      {
        headline: "Article headline ".repeat(30),
        summary:
          "A concrete update with important qualifying context for this market.",
        source_url: sourceUrl,
        source_domain: "source.test",
        published_at: null,
        author_handle: null,
        confirmation: "developing",
        source_tier: "specialist",
        relevance: 0.8,
        confidence: 0.7,
      },
    ],
  }),
  false,
);
assert.equal(recovered.valid, true);
assert.equal(recovered.data?.evidence[0]?.source_url, sourceUrl);

console.log(
  "[research-search-contract-tests] passed provider schemas, source metadata, public-copy limits, full background and intact URL recovery",
);

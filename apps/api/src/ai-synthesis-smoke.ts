import { readFile, writeFile } from "fs/promises";
import { resolve } from "path";
import { createHash } from "crypto";
import { pool } from "./db.js";
import { env } from "./env.js";
import {
  buildSynthesisSystemPromptV1,
  buildSynthesisUserPromptV1,
  parseSynthesisInputV1,
  parseSynthesisOutputV1,
  type SynthesisInputV1,
  type SynthesisOutputV1,
} from "./schemas/ai-synthesis.js";

const QA_CONTRACT_VERSION = "qa_contract_v1";

type Tier = "A" | "B" | "C";
type SearchStatus = "OK" | "PARTIAL" | "NO_EVIDENCE" | "INVALID";

type TopicsDryRunFile = {
  qaContract?: {
    version?: string;
    script?: string;
    generatedAt?: string;
  };
  topTopics?: Array<{
    topicKey: string;
    category: string;
    entity: string;
    marketCount: number;
    sampleEventId?: string | null;
    sampleMarketId?: string | null;
    sampleVenue?: string | null;
    sampleMarketUpdatedAt?: string | null;
    sampleEventTitle?: string | null;
    sampleMarketTitle?: string | null;
  }>;
  searchPlan?: {
    queryExamples?: Array<{
      topicKey: string;
      tier: Tier;
      category: string;
      entity: string;
      marketCount: number;
      sampleEventId?: string | null;
      sampleMarketId?: string | null;
      sampleVenue?: string | null;
      sampleMarketUpdatedAt?: string | null;
      retrievalPlan?: {
        intentAnchor?: string;
        minEvidence?: number;
      };
    }>;
  };
};

type SearchResultFile = {
  qaContract?: {
    version?: string;
    script?: string;
    generatedAt?: string;
  };
  results: Array<{
    topicKey: string;
    tier: Tier;
    category: string;
    entity: string;
    marketCount: number;
    minEvidence: number;
    intentAnchor: string | null;
    status: number;
    ok: boolean;
    parsed: {
      status: SearchStatus;
      supportsTopicCount: number;
      evidenceCount: number;
      json: unknown;
    };
  }>;
};

type MetricSource = NonNullable<
  SynthesisInputV1["event"]["volume_24h_source"]
>;

type MarketRow = {
  id: string;
  event_id: string;
  title: string;
  status: string;
  best_bid: number | null;
  best_ask: number | null;
  last_price: number | null;
  volume_24h: number | null;
  volume_24h_source: MetricSource | null;
  liquidity: number | null;
  liquidity_source: MetricSource | null;
  market_updated_at: string | null;
  trade_updated_at: string | null;
};

type EventRow = {
  id: string;
  venue: string;
  title: string;
  status: string;
  end_date: string | null;
  volume_24h: number | null;
  volume_24h_source: MetricSource | null;
  liquidity: number | null;
  liquidity_source: MetricSource | null;
  open_interest: number | null;
  event_updated_at: string | null;
  trade_updated_at: string | null;
};

type ResolvedTopicContext = {
  topicKey: string;
  tier: Tier;
  category: string;
  entity: string;
  marketCount: number;
  minEvidence: number;
  intentAnchor: string;
  sampleEventId: string | null;
  sampleMarketId: string | null;
  sampleVenue: string | null;
  sampleMarketUpdatedAt: string | null;
  sampleEventTitle: string;
  sampleMarketTitle: string | null;
  searchResult?: SearchResultFile["results"][number];
};

type GateResult = {
  decision: SynthesisOutputV1["publish_recommendation"]["decision"];
  reasonCodes: string[];
  representativePrice: number | null;
};

type SynthesisRunResult = {
  topicKey: string;
  tier: Tier;
  category: string;
  entity: string;
  eventId: string;
  eventTitle: string;
  status: "ok" | "input_invalid" | "model_error" | "output_invalid";
  model: string;
  durationMs: number;
  promptTokens: number;
  completionTokens: number;
  tokenCostUsd: number;
  synthesisInput?: SynthesisInputV1;
  synthesisOutput?: SynthesisOutputV1;
  gate?: GateResult;
  rawOutputText?: string;
  schemaRepairAttempted?: boolean;
  schemaRepairSuccess?: boolean;
  schemaRepairError?: string;
  error?: string;
};

type Args = {
  topicsFile: string;
  searchResultsFile: string | null;
  out: string | null;
  model: string;
  maxTopics: number;
  maxContextMarkets: number;
  maxSampleMarketAgeHours: number;
  topicKeys: Set<string>;
  includeStatuses: Set<SearchStatus>;
  concurrency: number;
  maxOutputTokens: number;
  timeoutSec: number;
  priceInputPerM: number;
  priceOutputPerM: number;
  dryRun: boolean;
  verbose: boolean;
};

type OpenRouterUsage = {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  reasoningTokens: number;
};

type OpenRouterCallResult = {
  content: string;
  usage: OpenRouterUsage;
};

const TRUSTED_WEB_DOMAINS = [
  "reuters.com",
  "apnews.com",
  "bloomberg.com",
  "ft.com",
  "wsj.com",
  "economist.com",
  "nytimes.com",
  "washingtonpost.com",
  "cnbc.com",
  "marketwatch.com",
  "coindesk.com",
  "theblock.co",
];

function mergeUsage(a: OpenRouterUsage, b: OpenRouterUsage): OpenRouterUsage {
  return {
    promptTokens: a.promptTokens + b.promptTokens,
    completionTokens: a.completionTokens + b.completionTokens,
    totalTokens: a.totalTokens + b.totalTokens,
    reasoningTokens: a.reasoningTokens + b.reasoningTokens,
  };
}

function buildSynthesisRepairPromptWithReason(
  rawOutput: string,
  reason: string | undefined,
): string {
  return [
    "Repair the malformed model output into valid synthesis_output_v1 JSON.",
    "Return exactly one JSON object and nothing else.",
    "Do not add markdown/code fences/explanations.",
    "Keep facts unchanged; only fix structure and schema compliance.",
    ...(reason ? [`Repair reason: ${reason}`] : []),
    "Malformed output:",
    rawOutput,
  ].join("\n");
}

const SUMMARY_HYGIENE_FORBIDDEN: Array<{ token: string; pattern: RegExp }> = [
  { token: "fallback", pattern: /\bfallback\b/i },
  { token: "_source", pattern: /_source\b/i },
  { token: "tier-a", pattern: /\btier[-\s]?a\b/i },
  { token: "tier-b", pattern: /\btier[-\s]?b\b/i },
  { token: "tier-c", pattern: /\btier[-\s]?c\b/i },
  { token: "link_confidence", pattern: /\blink_confidence\b/i },
  { token: "supports_topic_count", pattern: /\bsupports_topic_count\b/i },
  { token: "supports_topic", pattern: /\bsupports_topic\b/i },
  { token: "data_completeness_score", pattern: /\bdata_completeness_score\b/i },
  { token: "policy.", pattern: /\bpolicy\./i },
  { token: "open_interest_fallback", pattern: /\bopen_interest_fallback\b/i },
  {
    token: "market_volume_total_fallback",
    pattern: /\bmarket_volume_total_fallback\b/i,
  },
  { token: "trade_rollup", pattern: /\btrade_rollup\b/i },
];

function collectSummaryHygieneViolations(text: string): string[] {
  const out: string[] = [];
  for (const item of SUMMARY_HYGIENE_FORBIDDEN) {
    if (item.pattern.test(text)) {
      out.push(item.token);
    }
  }
  return out;
}

function validateUserFacingSummary(output: SynthesisOutputV1): void {
  const joined = `${output.summary_short}\n${output.summary_long}`;
  const violations = collectSummaryHygieneViolations(joined);
  if (violations.length > 0) {
    throw new Error(`summary_hygiene_violation:${violations.join(",")}`);
  }
}

function parseFlag(argv: string[], name: string): string | undefined {
  const idx = argv.findIndex(token => token === name);
  if (idx === -1) return undefined;
  return argv[idx + 1];
}

function hasFlag(argv: string[], name: string): boolean {
  return argv.includes(name);
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return n;
}

function parseNonNegativeFloat(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const n = Number.parseFloat(value);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return n;
}

function parseCsvSet(raw: string | undefined): Set<string> {
  if (!raw) return new Set();
  return new Set(
    raw
      .split(",")
      .map(v => v.trim())
      .filter(Boolean),
  );
}

function parseStatusSet(raw: string | undefined): Set<SearchStatus> {
  const allowed = new Set<SearchStatus>(["OK", "PARTIAL", "NO_EVIDENCE", "INVALID"]);
  const parsed = parseCsvSet(raw);
  const out = new Set<SearchStatus>();
  for (const item of parsed) {
    const upper = item.toUpperCase() as SearchStatus;
    if (allowed.has(upper)) out.add(upper);
  }
  if (!out.size) {
    out.add("OK");
    out.add("PARTIAL");
    out.add("NO_EVIDENCE");
  }
  return out;
}

function parseArgs(argv: string[]): Args {
  const topicsFile = parseFlag(argv, "--topics-file");
  if (!topicsFile) {
    throw new Error("--topics-file is required");
  }

  return {
    topicsFile,
    searchResultsFile: parseFlag(argv, "--search-results-file") ?? null,
    out: parseFlag(argv, "--out") ?? null,
    model:
      parseFlag(argv, "--model") ??
      env.aiClusterModelFinal ??
      "openai/gpt-5.2",
    maxTopics: parsePositiveInt(parseFlag(argv, "--max-topics"), 3),
    maxContextMarkets: Math.min(
      10,
      parsePositiveInt(parseFlag(argv, "--max-context-markets"), 5),
    ),
    maxSampleMarketAgeHours: parseNonNegativeFloat(
      parseFlag(argv, "--max-sample-market-age-hours"),
      24,
    ),
    topicKeys: parseCsvSet(parseFlag(argv, "--topic-keys")),
    includeStatuses: parseStatusSet(parseFlag(argv, "--statuses")),
    concurrency: parsePositiveInt(parseFlag(argv, "--concurrency"), 2),
    maxOutputTokens: parsePositiveInt(parseFlag(argv, "--max-output-tokens"), 1200),
    timeoutSec: parsePositiveInt(parseFlag(argv, "--timeout-sec"), 120),
    priceInputPerM: parseNonNegativeFloat(parseFlag(argv, "--price-input-per-m"), 0.2),
    priceOutputPerM: parseNonNegativeFloat(parseFlag(argv, "--price-output-per-m"), 0.5),
    dryRun: hasFlag(argv, "--dry-run"),
    verbose: hasFlag(argv, "--verbose"),
  };
}

function printHelp(): void {
  console.log(`Usage: pnpm -C hunch-monorepo -F api run ai:synthesis:smoke -- --topics-file <path> [options]

Required:
  --topics-file <path>           JSON output from ai:topics:dry-run (should include topTopics + searchPlan.queryExamples)

Optional:
  --search-results-file <path>   JSON output from ai:search:smoke (adds external evidence)
  --topic-keys <k1,k2,...>       Restrict to specific topic keys
  --statuses <list>              Filter search statuses: OK,PARTIAL,NO_EVIDENCE,INVALID (default: OK,PARTIAL,NO_EVIDENCE)
  --max-topics <n>               Max topics to synthesize (default: 3)
  --max-context-markets <n>      Max market snapshots per event context (default: 5, max: 10)
  --max-sample-market-age-hours <n>  Skip topics whose sample market is older than N hours (default: 24, 0 disables)
  --model <id>                   OpenRouter model (default: openai/gpt-5.2)
  --concurrency <n>              Parallel synthesis calls (default: 2)
  --max-output-tokens <n>        Max completion tokens (default: 1200)
  --timeout-sec <n>              HTTP timeout per call (default: 120)
  --price-input-per-m <usd>      Input token price per 1M (default: 0.2)
  --price-output-per-m <usd>     Output token price per 1M (default: 0.5)
  --out <path>                   Write full JSON results
  --dry-run                      Build and validate inputs only, skip model call
  --verbose                      Print per-topic details
  --help                         Show this help
`);
}

function toIsoOrNull(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(value.trim())) {
    return `${value.trim()}T00:00:00.000Z`;
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString();
}

function normalizeEvidenceItems(raw: unknown): Array<SynthesisInputV1["external_evidence"]["items"][number]> {
  if (!raw || typeof raw !== "object") return [];
  const evidence = (raw as { evidence?: unknown }).evidence;
  if (!Array.isArray(evidence)) return [];
  return evidence
    .map((item, idx) => {
      if (!item || typeof item !== "object") return null;
      const obj = item as Record<string, unknown>;
      const claim = typeof obj.claim === "string" ? obj.claim.trim() : "";
      const sourceDomain =
        typeof obj.source_domain === "string" && obj.source_domain.trim()
          ? obj.source_domain.trim()
          : "unknown";
      const sourceUrl =
        typeof obj.source_url === "string" && obj.source_url.trim()
          ? obj.source_url.trim()
          : null;
      const publishedAt = toIsoOrNull(obj.published_at);
      const authorHandle =
        typeof obj.author_handle === "string" && obj.author_handle.trim()
          ? obj.author_handle.trim()
          : null;
      const supportsTopic = Boolean(obj.supports_topic);
      const confidenceRaw = Number(obj.confidence);
      const confidence = Number.isFinite(confidenceRaw)
        ? Math.max(0, Math.min(1, confidenceRaw))
        : 0.5;
      if (!claim) return null;
      return {
        evidence_id: `e${idx + 1}`,
        claim,
        source_url: sourceUrl,
        source_domain: sourceDomain,
        published_at: publishedAt,
        author_handle: authorHandle,
        supports_topic: supportsTopic,
        confidence,
      };
    })
    .filter(
      (
        item,
      ): item is SynthesisInputV1["external_evidence"]["items"][number] =>
        item != null,
    );
}

function safeNumber(value: unknown): number | null {
  if (value == null) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function deriveImpliedMid(bid: number | null, ask: number | null, last: number | null): number | null {
  if (bid != null && ask != null) return (bid + ask) / 2;
  if (last != null) return last;
  return null;
}

function normalizeDomain(raw: string): string {
  const value = raw.trim().toLowerCase();
  return value.startsWith("www.") ? value.slice(4) : value;
}

function isTrustedWebDomain(raw: string): boolean {
  const domain = normalizeDomain(raw);
  return TRUSTED_WEB_DOMAINS.some(
    trusted => domain === trusted || domain.endsWith(`.${trusted}`),
  );
}

function computeDataCompletenessScore(event: EventRow, markets: MarketRow[]): number {
  const requiredValues = [
    event.volume_24h,
    event.liquidity,
    ...markets.flatMap(m => [m.best_bid, m.best_ask, m.last_price, m.volume_24h, m.liquidity]),
  ];
  const valid = requiredValues.filter(value => value != null).length;
  if (requiredValues.length === 0) return 0;
  return Number((valid / requiredValues.length).toFixed(4));
}

function chooseRepresentativePrice(input: SynthesisInputV1): number | null {
  const sample = input.markets.find(m => m.role === "sample");
  const first = sample ?? input.markets[0];
  if (!first) return null;
  return (
    first.implied_mid ??
    deriveImpliedMid(first.best_bid, first.best_ask, first.last_price)
  );
}

function isEventClosed(input: SynthesisInputV1): boolean {
  if (input.event.status !== "ACTIVE") return true;
  if (!input.event.end_date) return false;
  const endTs = new Date(input.event.end_date).getTime();
  if (!Number.isFinite(endTs)) return false;
  return endTs <= Date.now();
}

function evaluatePublishGate(input: SynthesisInputV1, output: SynthesisOutputV1): GateResult {
  const reasonCodes = new Set<string>(output.publish_recommendation.reason_codes);
  const representativePrice = chooseRepresentativePrice(input);

  let decision = output.publish_recommendation.decision;

  if (isEventClosed(input)) {
    decision = "skip_external_publish";
    reasonCodes.add("EVENT_NOT_ACTIVE");
  }

  if (input.mapping.link_confidence < input.policy.min_link_confidence) {
    decision = "store_weak_signal";
    reasonCodes.add("LOW_LINK_CONF");
  }
  if (input.external_evidence.supports_topic_count < input.policy.min_evidence) {
    decision = "skip_external_publish";
    reasonCodes.add("WEAK_EVIDENCE");
  }
  if (
    input.gate_primitives.independent_sources_count < 2 &&
    !(input.gate_primitives.high_trust_source && input.gate_primitives.strong_internal_corroboration)
  ) {
    if (decision === "publish_candidate") decision = "publish_context_only";
    reasonCodes.add("LOW_SOURCE_INDEPENDENCE");
  }
  if (!input.gate_primitives.strong_internal_corroboration) {
    if (decision === "publish_candidate") decision = "publish_context_only";
    reasonCodes.add("WEAK_INTERNAL_CORROBORATION");
  }
  if (input.gate_primitives.data_completeness_score < input.policy.min_data_completeness) {
    if (decision === "publish_candidate") decision = "publish_context_only";
    reasonCodes.add("LOW_DATA_COMPLETENESS");
  }
  if (!input.freshness.is_fresh_tier_a) {
    if (decision === "publish_candidate") decision = "store_weak_signal";
    reasonCodes.add("STALE_DATA");
  }
  if (output.confidence < input.policy.min_confidence) {
    if (decision === "publish_candidate") decision = "store_weak_signal";
    reasonCodes.add("LOW_MODEL_CONF");
  }
  if (
    decision === "publish_candidate" &&
    representativePrice != null &&
    (representativePrice <= input.policy.extreme_price_low ||
      representativePrice >= input.policy.extreme_price_high)
  ) {
    decision = "publish_context_only";
    reasonCodes.add("EXTREME_PRICE");
  }

  if (reasonCodes.size === 0) {
    reasonCodes.add("PASS");
  }

  return {
    decision,
    reasonCodes: [...reasonCodes],
    representativePrice,
  };
}

function parsePossibleJson(raw: string): unknown {
  const trimmed = raw.trim();
  if (!trimmed) throw new Error("Model returned empty output");
  try {
    return JSON.parse(trimmed);
  } catch {
    const first = trimmed.indexOf("{");
    const last = trimmed.lastIndexOf("}");
    if (first >= 0 && last > first) {
      return JSON.parse(trimmed.slice(first, last + 1));
    }
    throw new Error("Model output is not valid JSON");
  }
}

function parseMessageContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map(part => {
        if (typeof part === "string") return part;
        if (!part || typeof part !== "object") return "";
        if ("text" in part) {
          const text = (part as { text?: unknown }).text;
          return typeof text === "string" ? text : "";
        }
        if ("content" in part) {
          const text = (part as { content?: unknown }).content;
          return typeof text === "string" ? text : "";
        }
        return "";
      })
      .join("");
  }
  if (content && typeof content === "object" && "text" in content) {
    const text = (content as { text?: unknown }).text;
    return typeof text === "string" ? text : "";
  }
  return "";
}

function parseAndValidateSynthesisOutput(rawText: string): SynthesisOutputV1 {
  const parsed = parsePossibleJson(rawText);
  const output = parseSynthesisOutputV1(parsed);
  validateUserFacingSummary(output);
  return output;
}

async function callOpenRouter(
  args: Args,
  systemPrompt: string,
  userPrompt: string,
): Promise<OpenRouterCallResult> {
  if (!env.openRouterKey) {
    throw new Error("OPENROUTER_API_KEY missing");
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), args.timeoutSec * 1000);
  try {
    const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.openRouterKey}`,
        "Content-Type": "application/json",
        "X-Title": "Hunch AI Synthesis Smoke",
      },
      body: JSON.stringify({
        model: args.model,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
        temperature: 0,
        max_tokens: args.maxOutputTokens,
        response_format: { type: "json_object" },
        reasoning: { effort: "low" },
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`OpenRouter ${response.status}: ${text}`);
    }

    const payload = (await response.json()) as {
      choices?: Array<{ message?: { content?: unknown } }>;
      usage?: {
        prompt_tokens?: unknown;
        completion_tokens?: unknown;
        total_tokens?: unknown;
        completion_tokens_details?: { reasoning_tokens?: unknown } | null;
      };
    };

    const content = parseMessageContent(payload.choices?.[0]?.message?.content);
    const promptTokens = safeNumber(payload.usage?.prompt_tokens) ?? 0;
    const completionTokens = safeNumber(payload.usage?.completion_tokens) ?? 0;
    const totalTokens =
      safeNumber(payload.usage?.total_tokens) ?? promptTokens + completionTokens;
    const reasoningTokens =
      safeNumber(payload.usage?.completion_tokens_details?.reasoning_tokens) ?? 0;

    return {
      content,
      usage: {
        promptTokens,
        completionTokens,
        totalTokens,
        reasoningTokens,
      },
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function readJsonFile<T>(path: string): Promise<T> {
  const raw = await readFile(resolve(path), "utf8");
  return JSON.parse(raw) as T;
}

function validateTopicsContract(file: TopicsDryRunFile): void {
  const version = file.qaContract?.version;
  if (version && version !== QA_CONTRACT_VERSION) {
    throw new Error(
      `Invalid topics contract: expected ${QA_CONTRACT_VERSION}, got ${version}`,
    );
  }
  if (!file.searchPlan?.queryExamples || !Array.isArray(file.searchPlan.queryExamples)) {
    throw new Error("Invalid topics file: expected searchPlan.queryExamples array");
  }
}

function validateSearchContract(file: SearchResultFile): void {
  const version = file.qaContract?.version;
  if (version && version !== QA_CONTRACT_VERSION) {
    throw new Error(
      `Invalid search contract: expected ${QA_CONTRACT_VERSION}, got ${version}`,
    );
  }
  if (!Array.isArray(file.results)) {
    throw new Error("Invalid search file: expected results array");
  }
}

const EVENT_SELECT_SQL = `
    select
      e.id,
      e.venue,
      e.title,
      e.status::text as status,
      e.end_date::text as end_date,
      coalesce(
        nullif(e.volume_24h, 0),
        nullif(et.volume_24h, 0),
        nullif(e.volume_total, 0)
      )::float8 as volume_24h,
      (
        case
          when e.volume_24h is not null and e.volume_24h > 0 then 'event_volume_24h'
          when et.volume_24h is not null and et.volume_24h > 0 then 'event_trade_rollup_24h'
          when e.volume_total is not null and e.volume_total > 0 then 'event_volume_total_fallback'
          else 'missing'
        end
      )::text as volume_24h_source,
      coalesce(
        nullif(e.liquidity, 0),
        nullif(e.open_interest, 0)
      )::float8 as liquidity,
      (
        case
          when e.liquidity is not null and e.liquidity > 0 then 'event_liquidity'
          when e.open_interest is not null and e.open_interest > 0 then 'open_interest_fallback'
          else 'missing'
        end
      )::text as liquidity_source,
      e.open_interest::float8 as open_interest,
      coalesce(e.updated_at_db, e.updated_at)::text as event_updated_at,
      et.updated_at::text as trade_updated_at
    from unified_events e
    left join unified_event_trade_24h et
      on et.event_id = e.id
`;

async function fetchEventById(eventId: string): Promise<EventRow | null> {
  const sql = `
    ${EVENT_SELECT_SQL}
    where e.id = $1
    limit 1
  `;
  const result = await pool.query<EventRow>(sql, [eventId]);
  return result.rows[0] ?? null;
}

async function fetchEventByTitle(title: string): Promise<EventRow | null> {
  const sql = `
    ${EVENT_SELECT_SQL}
    where e.title = $1
      and e.status = 'ACTIVE'
      and (e.end_date is null or e.end_date > now())
    order by coalesce(e.updated_at_db, e.updated_at) desc nulls last
    limit 1
  `;
  const result = await pool.query<EventRow>(sql, [title]);
  return result.rows[0] ?? null;
}

const MARKET_SELECT_SQL = `
    select
      m.id,
      m.event_id,
      m.title,
      m.status::text as status,
      m.best_bid::float8 as best_bid,
      m.best_ask::float8 as best_ask,
      m.last_price::float8 as last_price,
      coalesce(
        nullif(m.volume_24h, 0),
        nullif(mt.volume_24h, 0),
        nullif(m.volume_total, 0)
      )::float8 as volume_24h,
      (
        case
          when m.volume_24h is not null and m.volume_24h > 0 then 'market_volume_24h'
          when mt.volume_24h is not null and mt.volume_24h > 0 then 'trade_rollup_24h'
          when m.volume_total is not null and m.volume_total > 0 then 'market_volume_total_fallback'
          else 'missing'
        end
      )::text as volume_24h_source,
      coalesce(
        nullif(m.liquidity, 0),
        nullif(m.open_interest, 0)
      )::float8 as liquidity,
      (
        case
          when m.liquidity is not null and m.liquidity > 0 then 'market_liquidity'
          when m.open_interest is not null and m.open_interest > 0 then 'open_interest_fallback'
          else 'missing'
        end
      )::text as liquidity_source,
      coalesce(m.updated_at_db, m.updated_at)::text as market_updated_at,
      mt.updated_at::text as trade_updated_at
    from unified_markets m
    left join unified_market_trade_24h mt
      on mt.market_id = m.id
`;

async function fetchMarketById(marketId: string): Promise<MarketRow | null> {
  const sql = `
    ${MARKET_SELECT_SQL}
    where m.id = $1
    order by coalesce(m.updated_at_db, m.updated_at) desc nulls last
    limit 1
  `;
  const result = await pool.query<MarketRow>(sql, [marketId]);
  return result.rows[0] ?? null;
}

async function fetchMarketByTitle(eventId: string, title: string): Promise<MarketRow | null> {
  const sql = `
    ${MARKET_SELECT_SQL}
    where m.event_id = $1
      and m.title = $2
      and m.status = 'ACTIVE'
      and (m.close_time is null or m.close_time > now())
      and (m.expiration_time is null or m.expiration_time > now())
    order by coalesce(m.updated_at_db, m.updated_at) desc nulls last
    limit 1
  `;
  const result = await pool.query<MarketRow>(sql, [eventId, title]);
  return result.rows[0] ?? null;
}

async function fetchTopMarkets(eventId: string, limit: number): Promise<MarketRow[]> {
  const sql = `
    ${MARKET_SELECT_SQL}
    where m.event_id = $1
      and m.status = 'ACTIVE'
      and (m.close_time is null or m.close_time > now())
      and (m.expiration_time is null or m.expiration_time > now())
    order by
      coalesce(nullif(m.volume_24h, 0), nullif(mt.volume_24h, 0), nullif(m.volume_total, 0)) desc nulls last,
      coalesce(nullif(m.liquidity, 0), nullif(m.open_interest, 0)) desc nulls last,
      coalesce(m.updated_at_db, m.updated_at) desc nulls last
    limit $2
  `;
  const result = await pool.query<MarketRow>(sql, [eventId, Math.max(1, limit)]);
  return result.rows;
}

function runHash(topicKey: string): string {
  return createHash("sha1").update(topicKey).digest("hex").slice(0, 12);
}

function buildContextIndex(
  file: TopicsDryRunFile,
  maxSampleMarketAgeHours: number,
): Map<string, ResolvedTopicContext> {
  const topByKey = new Map(
    (file.topTopics ?? []).map(item => [item.topicKey, item]),
  );
  const out = new Map<string, ResolvedTopicContext>();
  for (const query of file.searchPlan?.queryExamples ?? []) {
    const topic = topByKey.get(query.topicKey);
    const sampleMarketUpdatedAt =
      query.sampleMarketUpdatedAt ?? topic?.sampleMarketUpdatedAt ?? null;
    if (maxSampleMarketAgeHours > 0) {
      const ageSec = estimateAgeSec(sampleMarketUpdatedAt);
      const maxAgeSec = maxSampleMarketAgeHours * 3600;
      if (ageSec == null || ageSec > maxAgeSec) {
        continue;
      }
    }

    out.set(query.topicKey, {
      topicKey: query.topicKey,
      tier: query.tier,
      category: query.category,
      entity: query.entity,
      marketCount: query.marketCount,
      minEvidence: query.retrievalPlan?.minEvidence ?? 2,
      intentAnchor: query.retrievalPlan?.intentAnchor ?? query.entity,
      sampleEventId: query.sampleEventId ?? topic?.sampleEventId ?? null,
      sampleMarketId: query.sampleMarketId ?? topic?.sampleMarketId ?? null,
      sampleVenue: query.sampleVenue ?? topic?.sampleVenue ?? null,
      sampleMarketUpdatedAt,
      sampleEventTitle: topic?.sampleEventTitle?.trim() || "(unknown event)",
      sampleMarketTitle: topic?.sampleMarketTitle ?? null,
    });
  }
  return out;
}

function enrichWithSearchResults(
  contextByKey: Map<string, ResolvedTopicContext>,
  search: SearchResultFile | null,
  includeStatuses: Set<SearchStatus>,
): void {
  if (!search) return;
  const byKey = new Map(search.results.map(item => [item.topicKey, item]));
  for (const [topicKey, context] of contextByKey.entries()) {
    const hit = byKey.get(topicKey);
    if (!hit) continue;
    if (!includeStatuses.has(hit.parsed.status)) {
      contextByKey.delete(topicKey);
      continue;
    }
    context.searchResult = hit;
    context.minEvidence = hit.minEvidence ?? context.minEvidence;
    context.intentAnchor = hit.intentAnchor ?? context.intentAnchor;
  }
}

function estimateAgeSec(iso: string | null): number | null {
  if (!iso) return null;
  const ts = new Date(iso).getTime();
  if (Number.isNaN(ts)) return null;
  const age = (Date.now() - ts) / 1000;
  return age >= 0 ? age : null;
}

function buildSynthesisInput(
  context: ResolvedTopicContext,
  event: EventRow,
  selectedMarkets: MarketRow[],
  sampleMarketId: string | null,
  topByVolumeMarketId: string | null,
  mappingReason: string,
): SynthesisInputV1 {
  const marketItems: SynthesisInputV1["markets"] = [];
  let topByVolumeAssigned = false;
  for (const market of selectedMarkets) {
    const role: SynthesisInputV1["markets"][number]["role"] =
      sampleMarketId != null && market.id === sampleMarketId
        ? "sample"
        : !topByVolumeAssigned &&
            topByVolumeMarketId != null &&
            market.id === topByVolumeMarketId
          ? "top_by_volume"
          : "linked";
    if (role === "top_by_volume") {
      topByVolumeAssigned = true;
    }
    marketItems.push({
      role,
      market_id: market.id,
      title: market.title,
      status: market.status,
      best_bid: market.best_bid,
      best_ask: market.best_ask,
      last_price: market.last_price,
      volume_24h: market.volume_24h,
      volume_24h_source: market.volume_24h_source ?? undefined,
      liquidity: market.liquidity,
      liquidity_source: market.liquidity_source ?? undefined,
      implied_mid: deriveImpliedMid(
        market.best_bid,
        market.best_ask,
        market.last_price,
      ),
    });
  }
  if (marketItems.length === 0) {
    throw new Error("No market snapshots available for synthesis input");
  }

  const evidenceItems = normalizeEvidenceItems(context.searchResult?.parsed?.json);
  const supportsTopicCount =
    context.searchResult?.parsed.supportsTopicCount ??
    evidenceItems.filter(item => item.supports_topic).length;
  const evidenceCount = context.searchResult?.parsed.evidenceCount ?? evidenceItems.length;
  const uniqueSourceDomains = new Set(
    evidenceItems
      .map(item => normalizeDomain(item.source_domain))
      .filter(domain => domain !== "unknown"),
  );
  const independentSourcesCount = uniqueSourceDomains.size;
  const highTrustSource = evidenceItems.some(item =>
    isTrustedWebDomain(item.source_domain),
  );

  const ageCandidates = [
    ...selectedMarkets.map(market =>
      estimateAgeSec(market.market_updated_at ?? null),
    ),
    estimateAgeSec(event.event_updated_at),
  ].filter((value): value is number => value != null);
  const tradeAgeCandidates = [
    ...selectedMarkets.map(market =>
      estimateAgeSec(market.trade_updated_at ?? null),
    ),
    estimateAgeSec(event.trade_updated_at),
  ].filter((value): value is number => value != null);
  const bestAgeSec = ageCandidates.length ? Math.min(...ageCandidates) : null;
  const bestTradeAgeSec = tradeAgeCandidates.length
    ? Math.min(...tradeAgeCandidates)
    : null;
  const marketFreshTierA = bestAgeSec != null && bestAgeSec <= 1800;
  const tradeFreshTierA = bestTradeAgeSec != null && bestTradeAgeSec <= 1800;
  const marketFreshTierB = bestAgeSec != null && bestAgeSec <= 7200;
  const tradeFreshTierB = bestTradeAgeSec != null && bestTradeAgeSec <= 7200;
  const isFreshTierA = marketFreshTierA || tradeFreshTierA;
  const isFreshTierB = marketFreshTierB || tradeFreshTierB;
  const freshnessReasons: string[] = [];
  if (bestAgeSec == null) freshnessReasons.push("missing_market_update_ts");
  if (bestTradeAgeSec == null) freshnessReasons.push("missing_trade_rollup_update_ts");
  if (!isFreshTierA) freshnessReasons.push("stale_market_and_trade_data");

  const linkConfidence = (() => {
    const status = context.searchResult?.parsed.status;
    if (status === "OK") return 0.8;
    if (status === "PARTIAL") return 0.65;
    return 0.55;
  })();
  const dataCompletenessScore = computeDataCompletenessScore(event, selectedMarkets);
  const strongInternalCorroboration =
    isFreshTierA &&
    (event.volume_24h != null ||
      marketItems.some(
        market => market.volume_24h != null || market.implied_mid != null,
      ));

  return parseSynthesisInputV1({
    version: "synthesis_input_v1",
    run: {
      run_id: `syn-${runHash(context.topicKey)}`,
      generated_at: new Date().toISOString(),
      stage: "SynthesisLite",
      model: env.aiClusterModelFinal || "openai/gpt-5.2",
      prompt_version: "v1",
    },
    topic: {
      topic_key: context.topicKey,
      tier: context.tier,
      category: context.category,
      entity: context.entity,
      intent_anchor: context.intentAnchor,
    },
    event: {
      event_id: event.id,
      venue: event.venue,
      title: event.title,
      status: event.status,
      end_date: toIsoOrNull(event.end_date),
      volume_24h: event.volume_24h,
      volume_24h_source: event.volume_24h_source ?? undefined,
      liquidity: event.liquidity,
      liquidity_source: event.liquidity_source ?? undefined,
      open_interest: event.open_interest,
    },
    markets: marketItems,
    freshness: {
      is_fresh_tier_a: isFreshTierA,
      is_fresh_tier_b: isFreshTierB,
      market_age_sec: bestAgeSec,
      trade_age_sec: bestTradeAgeSec,
      wallet_age_sec: null,
      reasons: freshnessReasons,
    },
    mapping: {
      link_confidence: linkConfidence,
      reasons: [mappingReason],
    },
    external_evidence: {
      status: context.searchResult?.parsed.status ?? "NO_EVIDENCE",
      window_hours: 24,
      supports_topic_count: supportsTopicCount,
      evidence_count: evidenceCount,
      items: evidenceItems,
    },
    gate_primitives: {
      independent_sources_count: independentSourcesCount,
      high_trust_source: highTrustSource,
      strong_internal_corroboration: strongInternalCorroboration,
      data_completeness_score: dataCompletenessScore,
    },
    policy: {
      min_evidence: Math.max(1, context.minEvidence),
      min_confidence: 0.62,
      min_link_confidence: 0.7,
      min_data_completeness: 0.55,
      extreme_price_low: 0.08,
      extreme_price_high: 0.92,
    },
  });
}

async function runOne(args: Args, context: ResolvedTopicContext): Promise<SynthesisRunResult> {
  const started = Date.now();
  let event: EventRow | null = null;
  let mappingReason = "sample_event_title_match";
  if (context.sampleEventId) {
    event = await fetchEventById(context.sampleEventId);
    if (event) {
      mappingReason = "sample_event_id_match";
    }
  }
  if (!event) {
    event = await fetchEventByTitle(context.sampleEventTitle);
  }
  if (!event) {
    return {
      topicKey: context.topicKey,
      tier: context.tier,
      category: context.category,
      entity: context.entity,
      eventId: "n/a",
      eventTitle: context.sampleEventTitle,
      status: "input_invalid",
      model: args.model,
      durationMs: Date.now() - started,
      promptTokens: 0,
      completionTokens: 0,
      tokenCostUsd: 0,
      error: "Event not found by sampleEventTitle",
    };
  }

  let sampleMarket: MarketRow | null = null;
  if (context.sampleMarketId) {
    const marketById = await fetchMarketById(context.sampleMarketId);
    if (marketById && marketById.event_id === event.id) {
      sampleMarket = marketById;
      mappingReason = "sample_event_id_and_market_id_match";
    }
  }
  if (!sampleMarket && context.sampleMarketTitle) {
    sampleMarket = await fetchMarketByTitle(event.id, context.sampleMarketTitle);
    if (mappingReason === "sample_event_id_match") {
      mappingReason = "sample_event_id_and_market_title_match";
    } else {
      mappingReason = "sample_event_title_and_market_title_match";
    }
  }
  const topMarkets = await fetchTopMarkets(event.id, args.maxContextMarkets);
  const selectedMarkets: MarketRow[] = [];
  const selectedMarketIds = new Set<string>();
  const pushUniqueMarket = (market: MarketRow | null): void => {
    if (!market || selectedMarketIds.has(market.id)) return;
    selectedMarketIds.add(market.id);
    selectedMarkets.push(market);
  };
  pushUniqueMarket(sampleMarket);
  for (const market of topMarkets) {
    pushUniqueMarket(market);
    if (selectedMarkets.length >= args.maxContextMarkets) break;
  }
  const topByVolumeMarketId =
    topMarkets.find(market => market.id !== sampleMarket?.id)?.id ??
    topMarkets[0]?.id ??
    null;

  let synthesisInput: SynthesisInputV1;
  try {
    synthesisInput = buildSynthesisInput(
      context,
      event,
      selectedMarkets,
      sampleMarket?.id ?? null,
      topByVolumeMarketId,
      mappingReason,
    );
  } catch (error) {
    return {
      topicKey: context.topicKey,
      tier: context.tier,
      category: context.category,
      entity: context.entity,
      eventId: event.id,
      eventTitle: event.title,
      status: "input_invalid",
      model: args.model,
      durationMs: Date.now() - started,
      promptTokens: 0,
      completionTokens: 0,
      tokenCostUsd: 0,
      error: error instanceof Error ? error.message : String(error),
    };
  }

  if (args.dryRun) {
    return {
      topicKey: context.topicKey,
      tier: context.tier,
      category: context.category,
      entity: context.entity,
      eventId: event.id,
      eventTitle: event.title,
      status: "ok",
      model: args.model,
      durationMs: Date.now() - started,
      promptTokens: 0,
      completionTokens: 0,
      tokenCostUsd: 0,
      synthesisInput,
      synthesisOutput: undefined,
      gate: undefined,
      rawOutputText: undefined,
    };
  }

  let schemaRepairAttempted = false;
  let schemaRepairSuccess = false;
  let schemaRepairError: string | undefined;
  let usageForError: OpenRouterUsage | null = null;
  let rawOutputForError: string | undefined;

  try {
    const systemPrompt = buildSynthesisSystemPromptV1();
    const userPrompt = buildSynthesisUserPromptV1(synthesisInput);
    const raw = await callOpenRouter(args, systemPrompt, userPrompt);
    let usage = raw.usage;
    let rawOutputText = raw.content;
    usageForError = usage;
    rawOutputForError = rawOutputText;
    let synthesisOutput: SynthesisOutputV1;
    try {
      synthesisOutput = parseAndValidateSynthesisOutput(rawOutputText);
    } catch (firstError) {
      schemaRepairAttempted = true;
      try {
        const repairRaw = await callOpenRouter(
          args,
          systemPrompt,
          buildSynthesisRepairPromptWithReason(
            rawOutputText,
            firstError instanceof Error ? firstError.message : String(firstError),
          ),
        );
        usage = mergeUsage(usage, repairRaw.usage);
        rawOutputText = repairRaw.content;
        usageForError = usage;
        rawOutputForError = rawOutputText;
        synthesisOutput = parseAndValidateSynthesisOutput(rawOutputText);
        schemaRepairSuccess = true;
      } catch (repairError) {
        schemaRepairError =
          repairError instanceof Error ? repairError.message : String(repairError);
        throw repairError;
      }
    }
    const gate = evaluatePublishGate(synthesisInput, synthesisOutput);
    const tokenCostUsd =
      (usage.promptTokens * args.priceInputPerM) / 1_000_000 +
      (usage.completionTokens * args.priceOutputPerM) / 1_000_000;

    return {
      topicKey: context.topicKey,
      tier: context.tier,
      category: context.category,
      entity: context.entity,
      eventId: event.id,
      eventTitle: event.title,
      status: "ok",
      model: args.model,
      durationMs: Date.now() - started,
      promptTokens: usage.promptTokens,
      completionTokens: usage.completionTokens,
      tokenCostUsd,
      synthesisInput,
      synthesisOutput,
      gate,
      rawOutputText,
      schemaRepairAttempted,
      schemaRepairSuccess,
      ...(schemaRepairError ? { schemaRepairError } : {}),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const promptTokens = usageForError?.promptTokens ?? 0;
    const completionTokens = usageForError?.completionTokens ?? 0;
    const tokenCostUsd =
      (promptTokens * args.priceInputPerM) / 1_000_000 +
      (completionTokens * args.priceOutputPerM) / 1_000_000;
    const parseLikeError =
      message.includes("SynthesisOutputV1") ||
      message.includes("summary_hygiene_violation") ||
      message.toLowerCase().includes("json") ||
      message.toLowerCase().includes("parse") ||
      message.toLowerCase().includes("validation");
    return {
      topicKey: context.topicKey,
      tier: context.tier,
      category: context.category,
      entity: context.entity,
      eventId: event.id,
      eventTitle: event.title,
      status: parseLikeError ? "output_invalid" : "model_error",
      model: args.model,
      durationMs: Date.now() - started,
      promptTokens,
      completionTokens,
      tokenCostUsd,
      synthesisInput,
      rawOutputText: rawOutputForError,
      schemaRepairAttempted,
      schemaRepairSuccess,
      ...(schemaRepairError ? { schemaRepairError } : {}),
      error: message,
    };
  }
}

async function runParallel<T, R>(
  items: readonly T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;

  async function worker() {
    while (true) {
      const idx = next;
      next += 1;
      if (idx >= items.length) return;
      out[idx] = await fn(items[idx], idx);
    }
  }

  const workers = Array.from(
    { length: Math.min(concurrency, items.length) },
    () => worker(),
  );
  await Promise.all(workers);
  return out;
}

async function main() {
  const argv = process.argv.slice(2);
  if (hasFlag(argv, "--help")) {
    printHelp();
    return;
  }

  const args = parseArgs(argv);
  const topics = await readJsonFile<TopicsDryRunFile>(args.topicsFile);
  validateTopicsContract(topics);
  const search = args.searchResultsFile
    ? await readJsonFile<SearchResultFile>(args.searchResultsFile)
    : null;
  if (search) {
    validateSearchContract(search);
  }

  const contextByKey = buildContextIndex(topics, args.maxSampleMarketAgeHours);
  enrichWithSearchResults(contextByKey, search, args.includeStatuses);

  const orderedTopicKeys: string[] = [];
  const seenTopicKeys = new Set<string>();

  const pushKey = (topicKey: string): void => {
    if (seenTopicKeys.has(topicKey)) return;
    seenTopicKeys.add(topicKey);
    orderedTopicKeys.push(topicKey);
  };

  if (search) {
    for (const item of search.results) {
      if (!args.includeStatuses.has(item.parsed.status)) continue;
      pushKey(item.topicKey);
    }
  } else {
    for (const topicKey of contextByKey.keys()) {
      pushKey(topicKey);
    }
  }

  let filteredTopicKeys = orderedTopicKeys;
  if (args.topicKeys.size > 0) {
    filteredTopicKeys = filteredTopicKeys.filter(topicKey =>
      args.topicKeys.has(topicKey),
    );
  }

  const contexts = filteredTopicKeys
    .map(topicKey => contextByKey.get(topicKey))
    .filter((item): item is ResolvedTopicContext => item != null)
    .slice(0, args.maxTopics);

  if (!contexts.length) {
    throw new Error("No topics selected for synthesis");
  }

  console.log(`[ai-synthesis-smoke] selected topics: ${contexts.length}`);
  console.log(`[ai-synthesis-smoke] model: ${args.model}`);
  console.log(
    `[ai-synthesis-smoke] maxSampleMarketAgeHours: ${args.maxSampleMarketAgeHours}`,
  );
  console.log(`[ai-synthesis-smoke] dryRun: ${args.dryRun}`);

  const results = await runParallel(
    contexts,
    args.concurrency,
    async (context, index) => {
      const result = await runOne(args, context);
      if (args.verbose) {
        console.log(
          `[ai-synthesis-smoke] [${index + 1}/${contexts.length}] ${context.topicKey} -> ${result.status} (${result.durationMs}ms)`,
        );
      }
      return result;
    },
  );

  const totals = results.reduce(
    (acc, item) => {
      acc.total += 1;
      acc.promptTokens += item.promptTokens;
      acc.completionTokens += item.completionTokens;
      acc.tokenCostUsd += item.tokenCostUsd;
      acc.totalMs += item.durationMs;
      acc.statusCounts[item.status] = (acc.statusCounts[item.status] ?? 0) + 1;
      if (item.status === "ok" && item.gate) {
        acc.gateCounts[item.gate.decision] =
          (acc.gateCounts[item.gate.decision] ?? 0) + 1;
      }
      if (item.schemaRepairAttempted) {
        acc.schemaRepairAttempted += 1;
      }
      if (item.schemaRepairSuccess) {
        acc.schemaRepairSuccess += 1;
      }
      return acc;
    },
    {
      total: 0,
      promptTokens: 0,
      completionTokens: 0,
      tokenCostUsd: 0,
      totalMs: 0,
      statusCounts: {} as Record<string, number>,
      gateCounts: {} as Record<string, number>,
      schemaRepairAttempted: 0,
      schemaRepairSuccess: 0,
    },
  );
  const gateReasonCounts = results.reduce<Record<string, number>>((acc, item) => {
    for (const reason of item.gate?.reasonCodes ?? []) {
      acc[reason] = (acc[reason] ?? 0) + 1;
    }
    return acc;
  }, {});

  const report = {
    qaContract: {
      version: QA_CONTRACT_VERSION,
      script: "ai-synthesis-smoke",
      generatedAt: new Date().toISOString(),
    },
    generatedAt: new Date().toISOString(),
    model: args.model,
    topicsFile: resolve(args.topicsFile),
    searchResultsFile: args.searchResultsFile
      ? resolve(args.searchResultsFile)
      : null,
    maxSampleMarketAgeHours: args.maxSampleMarketAgeHours,
    dryRun: args.dryRun,
    totals: {
      ...totals,
      averageMs: totals.total ? totals.totalMs / totals.total : 0,
    },
    gateSummary: {
      decisionCounts: totals.gateCounts,
      reasonCounts: gateReasonCounts,
    },
    results,
  };

  if (args.out) {
    await writeFile(resolve(args.out), JSON.stringify(report, null, 2));
    console.log(`[ai-synthesis-smoke] wrote ${resolve(args.out)}`);
  }

  console.log(
    `[ai-synthesis-smoke] done total=${totals.total} ok=${totals.statusCounts.ok ?? 0} tokenCostUsd=${totals.tokenCostUsd.toFixed(6)} avgMs=${(totals.total ? totals.totalMs / totals.total : 0).toFixed(1)}`,
  );
  console.log(
    `[ai-synthesis-smoke] gate decisions: ${JSON.stringify(totals.gateCounts)}`,
  );
  console.log(
    `[ai-synthesis-smoke] schema_repair attempted=${totals.schemaRepairAttempted} success=${totals.schemaRepairSuccess}`,
  );
}

main()
  .catch(error => {
    console.error("[ai-synthesis-smoke] failed", error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end().catch(() => undefined);
  });

import { readFile, writeFile } from "fs/promises";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { config } from "dotenv";
import { createHash } from "crypto";

const envPath = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../.env",
);
console.log(`[ai-search-smoke] Loading env from ${envPath}`);
config({ path: envPath, override: false });

const SYSTEM_JSON_ENFORCER =
  "You are a structured evidence extraction assistant. Return exactly one JSON object and nothing else. " +
  'Use schema: {"status":"OK|NO_EVIDENCE|PARTIAL","window_hours":number,"evidence":[{"claim":"string","source_url":"https://...","source_domain":"string","published_at":"ISO8601|null","author_handle":"string|null","supports_topic":boolean,"confidence":number}],"notes":"string"}. ' +
  "Do not output markdown, code fences, or commentary.";

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

const QA_CONTRACT_VERSION = "qa_contract_v1";

type SearchMode = "combined" | "web_only" | "internal_only";
type Tier = "A" | "B" | "C";
type QueryType = "combined" | "web_only" | "internal_only";

type ToolUsageDetails = {
  web_search_calls: number;
  x_search_calls: number;
  code_interpreter_calls: number;
  file_search_calls: number;
  mcp_calls: number;
  document_search_calls: number;
};

type UsageMetrics = {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  reasoningTokens: number;
  cachedInputTokens: number;
  numServerSideToolsUsed: number;
  toolUsageDetails: ToolUsageDetails;
  providerCostUsdTicks: number | null;
};

type CostEstimate = {
  inputCostUsd: number;
  outputCostUsd: number;
  tokenCostUsd: number;
  toolCostUsd: number;
  totalCostUsd: number;
};

type RetrievalPlan = {
  intentAnchor?: string;
  mustTerms?: string[];
  optionalTerms?: string[];
  aliasTerms?: string[];
  minEvidence?: number;
  strict?: {
    combinedPrompt?: string;
  };
};

type QueryExample = {
  topicKey: string;
  tier: Tier;
  category: string;
  entity: string;
  marketCount: number;
  sampleEventId?: string | null;
  sampleMarketId?: string | null;
  sampleVenue?: string | null;
  sampleMarketUpdatedAt?: string | null;
  promptCombined: string;
  retrievalPlan?: RetrievalPlan;
  webSearchTool: {
    type: "web_search";
    filters?: {
      excluded_domains?: string[];
      allowed_domains?: string[];
    };
  };
  xSearchTool: {
    type: "x_search";
    from_date: string;
    to_date: string;
    excluded_x_handles?: string[];
    allowed_x_handles?: string[];
  };
  pack: {
    combinedCount: number;
  };
};

type TopicsSummary = {
  qaContract?: {
    version?: string;
    script?: string;
    generatedAt?: string;
  };
  generatedAt: string;
  searchPlan: {
    queryExamples: QueryExample[];
  };
};

type SearchOutcomeClass =
  | "OK"
  | "NO_EVIDENCE"
  | "PROVIDER_LIMIT"
  | "PROVIDER_ERROR"
  | "TIMEOUT"
  | "SCHEMA_INVALID";

type PlannedCall = {
  callId: string;
  topicKey: string;
  tier: Tier;
  category: string;
  entity: string;
  marketCount: number;
  sampleEventId: string | null;
  sampleMarketId: string | null;
  sampleVenue: string | null;
  sampleMarketUpdatedAt: string | null;
  queryType: QueryType;
  prompt: string;
  minEvidence: number;
  intentAnchor: string | null;
  tools: Array<Record<string, unknown>>;
};

type ParsedStructuredResult = {
  valid: boolean;
  parseError: string | null;
  status: "OK" | "NO_EVIDENCE" | "PARTIAL" | "INVALID";
  evidenceCount: number;
  supportsTopicCount: number;
  claimsCount: number;
  uniqueDomainCount: number;
  trustedEvidenceCount: number;
  notes: string | null;
  json: unknown | null;
};

type XaiCallRaw = {
  ok: boolean;
  status: number;
  durationMs: number;
  attempts: number;
  retried: boolean;
  prompt: string;
  outputText: string;
  outputPreview: string;
  outputTextLength: number;
  citationsCount: number;
  toolAttemptCount: number;
  successfulToolCount: number;
  usage: UsageMetrics;
  costEstimate: CostEstimate;
  serverSideToolUsage: unknown;
  rawResponse: unknown | null;
  error?: string;
};

type SmokeResult = {
  callId: string;
  topicKey: string;
  tier: Tier;
  category: string;
  entity: string;
  marketCount: number;
  sampleEventId: string | null;
  sampleMarketId: string | null;
  sampleVenue: string | null;
  sampleMarketUpdatedAt: string | null;
  queryType: QueryType;
  ok: boolean;
  status: number;
  durationMs: number;
  prompt: string;
  intentAnchor: string | null;
  minEvidence: number;
  outputText: string;
  outputPreview: string;
  outputTextLength: number;
  parsed: ParsedStructuredResult;
  outcomeClass: SearchOutcomeClass;
  citationsCount: number;
  toolAttemptCount: number;
  successfulToolCount: number;
  usage: UsageMetrics;
  costEstimate: CostEstimate;
  serverSideToolUsage: unknown;
  toolCallCount: number;
  provenanceOk: boolean;
  provenanceReason: string;
  stagesExecuted: number;
  stageTurns: number[];
  earlyStop: boolean;
  earlyStopReason: string | null;
  toolBudgetExceeded: boolean;
  toolAttemptsBudget: number;
  attempts: number;
  retried: boolean;
  rawResponse?: unknown;
  error?: string;
};

type Args = {
  topicsFile: string;
  model: string;
  mode: SearchMode;
  tiers: Set<Tier>;
  maxTopics: number;
  maxOutputTokens: number;
  timeoutSec: number;
  concurrency: number;
  maxRetries: number;
  retryBaseMs: number;
  maxTurns: number;
  stage1Turns: number;
  maxCallsPerTopic: number;
  maxToolAttemptsPerTopic: number;
  strictProvenance: boolean;
  sampleSeed: number | null;
  saveRaw: boolean;
  priceInputPerM: number;
  priceOutputPerM: number;
  priceWebPer1k: number;
  priceXPer1k: number;
  out: string | null;
  dryRun: boolean;
  verbose: boolean;
  baseUrl: string;
};

const ZERO_TOOL_USAGE: ToolUsageDetails = {
  web_search_calls: 0,
  x_search_calls: 0,
  code_interpreter_calls: 0,
  file_search_calls: 0,
  mcp_calls: 0,
  document_search_calls: 0,
};

const ZERO_USAGE: UsageMetrics = {
  inputTokens: 0,
  outputTokens: 0,
  totalTokens: 0,
  reasoningTokens: 0,
  cachedInputTokens: 0,
  numServerSideToolsUsed: 0,
  toolUsageDetails: ZERO_TOOL_USAGE,
  providerCostUsdTicks: null,
};

const ZERO_COST: CostEstimate = {
  inputCostUsd: 0,
  outputCostUsd: 0,
  tokenCostUsd: 0,
  toolCostUsd: 0,
  totalCostUsd: 0,
};

function parseFlag(argv: string[], name: string): string | undefined {
  const idx = argv.findIndex((value) => value === name);
  if (idx === -1) return undefined;
  return argv[idx + 1];
}

function hasFlag(argv: string[], name: string): boolean {
  return argv.includes(name);
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return parsed;
}

function parseNonNegativeFloat(
  value: string | undefined,
  fallback: number,
): number {
  if (!value) return fallback;
  const parsed = Number.parseFloat(value);
  if (!Number.isFinite(parsed) || parsed < 0) return fallback;
  return parsed;
}

function parseInteger(value: string | undefined): number | null {
  if (!value) return null;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return null;
  return parsed;
}

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value == null) return fallback;
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "y", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "n", "off"].includes(normalized)) return false;
  return fallback;
}

function parseMode(value: string | undefined): SearchMode {
  if (!value) return "combined";
  const normalized = value.trim().toLowerCase();
  if (
    normalized === "combined" ||
    normalized === "web_only" ||
    normalized === "internal_only"
  ) {
    return normalized;
  }
  console.warn(
    `[ai-search-smoke] invalid --mode=${value}; fallback to mode=combined`,
  );
  return "combined";
}

function parseTiers(value: string | undefined): Set<Tier> {
  if (!value) return new Set<Tier>(["A", "B", "C"]);
  const parsed = value
    .split(",")
    .map((entry) => entry.trim().toUpperCase())
    .filter(
      (entry) => entry === "A" || entry === "B" || entry === "C",
    ) as Tier[];
  if (parsed.length === 0) return new Set<Tier>(["A", "B", "C"]);
  return new Set(parsed);
}

function usage(exitCode = 1): never {
  console.error(
    [
      "Usage:",
      "  pnpm -C hunch-monorepo -F api run ai:search:smoke -- --topics-file <dry-run.json> [options]",
      "",
      "Required env:",
      "  XAI_API_KEY=...",
      "",
      "Options:",
      "  --topics-file <path>        ai-topics-dry-run JSON output file",
      "  --mode <combined|web_only|internal_only>  Query mode (default: combined)",
      "  --tiers <csv>               Topic tiers to include, e.g. A,B (default: A,B,C)",
      "  --max-topics <n>            Max topics to test (default: 8)",
      "  --model <name>              xAI model (default: grok-4-1-fast-reasoning)",
      "  --max-output-tokens <n>     Max output tokens per call (default: 600)",
      "  --timeout-sec <n>           Per-call timeout seconds (default: 120)",
      "  --concurrency <n>           Max in-flight calls (default: 2)",
      "  --max-retries <n>           Retry attempts for transient failures (default: 1)",
      "  --retry-base-ms <n>         Base backoff in ms for retries (default: 800)",
      "  --max-turns <n>             Max assistant/tool-call turns per topic (default: 6)",
      "  --stage1-turns <n>          Turns used in first pass before optional second pass (default: 3)",
      "  --max-calls-per-topic <n>   Max API calls per topic (default: 2)",
      "  --max-tool-attempts <n>     Soft cap on tool attempts per topic (default: 20)",
      "  --strict-provenance <bool>  Fail when OK/PARTIAL outputs miss provenance/evidence checks (default: true)",
      "  --sample-seed <n>           Deterministic topic sampling seed (optional)",
      "  --save-raw                  Save raw response payloads in output JSON",
      "  --price-input-per-m <usd>   Input token price per 1M tokens (default: 0.20)",
      "  --price-output-per-m <usd>  Output token price per 1M tokens (default: 0.50)",
      "  --price-web-per-1k <usd>    Web search tool price per 1k calls (default: 5)",
      "  --price-x-per-1k <usd>      X search tool price per 1k calls (default: 5)",
      "  --base-url <url>            Responses endpoint base (default: https://api.x.ai/v1)",
      "  --out <path>                Write JSON report to file",
      "  --dry-run                   Print planned calls only (no API requests)",
      "  --verbose                   Print each call status line",
      "",
      "Examples:",
      "  XAI_API_KEY=... pnpm -C hunch-monorepo -F api run ai:topics:dry-run -- --limit 50 --sampling per-venue --json --out /tmp/topics.json",
      "  XAI_API_KEY=... pnpm -C hunch-monorepo -F api run ai:search:smoke -- --topics-file /tmp/topics.json --tiers A,B --max-topics 6 --mode combined --out /tmp/ai-search-smoke.json",
      "  XAI_API_KEY=... pnpm -C hunch-monorepo -F api run ai:search:smoke -- --topics-file /tmp/topics.json --tiers A --max-topics 6 --mode web_only --out /tmp/ai-search-smoke-web.json",
    ].join("\n"),
  );
  process.exit(exitCode);
}

function resolveArgs(argv: string[]): Args {
  const topicsFile = parseFlag(argv, "--topics-file");
  if (!topicsFile) usage();

  const maxTurns = Math.max(
    1,
    Math.min(20, parsePositiveInt(parseFlag(argv, "--max-turns"), 6)),
  );
  const stage1Turns = Math.max(
    1,
    Math.min(maxTurns, parsePositiveInt(parseFlag(argv, "--stage1-turns"), 3)),
  );

  return {
    topicsFile,
    model:
      parseFlag(argv, "--model")?.trim() ||
      process.env.XAI_SEARCH_MODEL?.trim() ||
      "grok-4-1-fast-reasoning",
    mode: parseMode(parseFlag(argv, "--mode")),
    tiers: parseTiers(parseFlag(argv, "--tiers")),
    maxTopics: parsePositiveInt(parseFlag(argv, "--max-topics"), 8),
    maxOutputTokens: parsePositiveInt(
      parseFlag(argv, "--max-output-tokens"),
      600,
    ),
    timeoutSec: parsePositiveInt(parseFlag(argv, "--timeout-sec"), 120),
    concurrency: Math.max(
      1,
      Math.min(8, parsePositiveInt(parseFlag(argv, "--concurrency"), 2)),
    ),
    maxRetries: Math.max(
      0,
      Math.min(3, parsePositiveInt(parseFlag(argv, "--max-retries"), 1)),
    ),
    retryBaseMs: Math.max(
      100,
      Math.min(
        5_000,
        parsePositiveInt(parseFlag(argv, "--retry-base-ms"), 800),
      ),
    ),
    maxTurns,
    stage1Turns,
    maxCallsPerTopic: Math.max(
      1,
      Math.min(
        3,
        parsePositiveInt(parseFlag(argv, "--max-calls-per-topic"), 2),
      ),
    ),
    maxToolAttemptsPerTopic: Math.max(
      1,
      Math.min(
        200,
        parsePositiveInt(parseFlag(argv, "--max-tool-attempts"), 20),
      ),
    ),
    strictProvenance: parseBoolean(
      parseFlag(argv, "--strict-provenance"),
      true,
    ),
    sampleSeed: parseInteger(parseFlag(argv, "--sample-seed")),
    saveRaw: hasFlag(argv, "--save-raw"),
    priceInputPerM: parseNonNegativeFloat(
      parseFlag(argv, "--price-input-per-m") ??
        process.env.XAI_PRICE_INPUT_PER_M,
      0.2,
    ),
    priceOutputPerM: parseNonNegativeFloat(
      parseFlag(argv, "--price-output-per-m") ??
        process.env.XAI_PRICE_OUTPUT_PER_M,
      0.5,
    ),
    priceWebPer1k: parseNonNegativeFloat(
      parseFlag(argv, "--price-web-per-1k") ?? process.env.XAI_PRICE_WEB_PER_1K,
      5,
    ),
    priceXPer1k: parseNonNegativeFloat(
      parseFlag(argv, "--price-x-per-1k") ?? process.env.XAI_PRICE_X_PER_1K,
      5,
    ),
    out: parseFlag(argv, "--out") ?? null,
    dryRun: hasFlag(argv, "--dry-run"),
    verbose: hasFlag(argv, "--verbose"),
    baseUrl:
      parseFlag(argv, "--base-url")?.trim() ||
      process.env.XAI_BASE_URL?.trim() ||
      "https://api.x.ai/v1",
  };
}

function preview(text: string, maxLen = 240): string {
  const compact = text.replace(/\s+/g, " ").trim();
  if (compact.length <= maxLen) return compact;
  return `${compact.slice(0, maxLen)}...`;
}

function stringifyPayload(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function extractOutputText(payload: unknown): string {
  if (!payload || typeof payload !== "object") return "";
  const obj = payload as Record<string, unknown>;
  if (typeof obj.output_text === "string") return obj.output_text;

  const output = obj.output;
  if (!Array.isArray(output)) return "";
  const parts: string[] = [];
  for (const message of output) {
    if (!message || typeof message !== "object") continue;
    const content = (message as Record<string, unknown>).content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (!block || typeof block !== "object") continue;
      const text = (block as Record<string, unknown>).text;
      if (typeof text === "string" && text.length > 0) {
        parts.push(text);
      }
    }
  }
  return parts.join("\n\n");
}

function extractOutputItems(payload: unknown): Array<Record<string, unknown>> {
  if (!payload || typeof payload !== "object") return [];
  const output = (payload as Record<string, unknown>).output;
  if (!Array.isArray(output)) return [];
  return output.filter((item) => item && typeof item === "object") as Array<
    Record<string, unknown>
  >;
}

function extractCitationsCount(payload: unknown): number {
  const urls = new Set<string>();
  if (payload && typeof payload === "object") {
    const citations = (payload as Record<string, unknown>).citations;
    if (Array.isArray(citations)) {
      for (const citation of citations) {
        if (!citation || typeof citation !== "object") continue;
        const url = (citation as Record<string, unknown>).url;
        if (typeof url === "string" && url.trim().length > 0) {
          urls.add(url.trim());
        }
      }
    }
  }
  const outputItems = extractOutputItems(payload);
  for (const output of outputItems) {
    if (output.type !== "message") continue;
    const content = output.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (!block || typeof block !== "object") continue;
      const annotations = (block as Record<string, unknown>).annotations;
      if (!Array.isArray(annotations)) continue;
      for (const annotation of annotations) {
        if (!annotation || typeof annotation !== "object") continue;
        const url = (annotation as Record<string, unknown>).url;
        if (typeof url === "string" && url.trim().length > 0) {
          urls.add(url.trim());
        }
      }
    }
  }
  return urls.size;
}

function extractServerSideToolUsage(
  payload: unknown,
): Record<string, unknown> | null {
  if (!payload || typeof payload !== "object") return null;
  const top = (payload as Record<string, unknown>).server_side_tool_usage;
  if (top && typeof top === "object" && !Array.isArray(top)) {
    return top as Record<string, unknown>;
  }
  const usage = (payload as Record<string, unknown>).usage;
  if (!usage || typeof usage !== "object") return null;
  const details = (usage as Record<string, unknown>)
    .server_side_tool_usage_details;
  if (details && typeof details === "object" && !Array.isArray(details)) {
    return details as Record<string, unknown>;
  }
  return null;
}

function extractSuccessfulToolCount(payload: unknown): number {
  if (!payload || typeof payload !== "object") return 0;
  const usage = (payload as Record<string, unknown>).usage;
  if (!usage || typeof usage !== "object") return 0;
  const direct = (usage as Record<string, unknown>).num_server_side_tools_used;
  if (typeof direct === "number" && Number.isFinite(direct) && direct > 0) {
    return direct;
  }
  const details = extractServerSideToolUsage(payload);
  if (!details) return 0;
  return Object.values(details).reduce<number>((sum, value) => {
    if (typeof value === "number" && Number.isFinite(value) && value > 0) {
      return sum + value;
    }
    return sum;
  }, 0);
}

function extractUsageMetrics(payload: unknown): UsageMetrics {
  if (!payload || typeof payload !== "object") return ZERO_USAGE;
  const usage = (payload as Record<string, unknown>).usage;
  if (!usage || typeof usage !== "object") return ZERO_USAGE;
  const obj = usage as Record<string, unknown>;
  const inputTokens = Number(obj.input_tokens ?? obj.prompt_tokens ?? 0);
  const outputTokens = Number(obj.output_tokens ?? obj.completion_tokens ?? 0);
  const totalTokens = Number(obj.total_tokens ?? inputTokens + outputTokens);
  const inputDetails =
    obj.input_tokens_details && typeof obj.input_tokens_details === "object"
      ? (obj.input_tokens_details as Record<string, unknown>)
      : obj.prompt_tokens_details &&
          typeof obj.prompt_tokens_details === "object"
        ? (obj.prompt_tokens_details as Record<string, unknown>)
        : null;
  const outputDetails =
    obj.output_tokens_details && typeof obj.output_tokens_details === "object"
      ? (obj.output_tokens_details as Record<string, unknown>)
      : obj.completion_tokens_details &&
          typeof obj.completion_tokens_details === "object"
        ? (obj.completion_tokens_details as Record<string, unknown>)
        : null;
  const cachedInputTokens = Number(inputDetails?.cached_tokens ?? 0);
  const reasoningTokens = Number(outputDetails?.reasoning_tokens ?? 0);
  const numServerSideToolsUsed = Number(obj.num_server_side_tools_used ?? 0);
  const providerCostUsdTicksRaw = obj.cost_in_usd_ticks;
  const providerCostUsdTicks =
    typeof providerCostUsdTicksRaw === "number" &&
    Number.isFinite(providerCostUsdTicksRaw)
      ? providerCostUsdTicksRaw
      : null;
  const detailsRaw = obj.server_side_tool_usage_details;
  const detailsObj =
    detailsRaw && typeof detailsRaw === "object" && !Array.isArray(detailsRaw)
      ? (detailsRaw as Record<string, unknown>)
      : null;
  const topLevelUsage = extractServerSideToolUsage(payload) ?? {};
  const webFallback = Number(
    topLevelUsage.SERVER_SIDE_TOOL_WEB_SEARCH ??
      topLevelUsage.web_search_calls ??
      0,
  );
  const xFallback = Number(
    topLevelUsage.SERVER_SIDE_TOOL_X_SEARCH ??
      topLevelUsage.x_search_calls ??
      0,
  );
  const toolUsageDetails: ToolUsageDetails = {
    web_search_calls: Number(detailsObj?.web_search_calls ?? webFallback),
    x_search_calls: Number(detailsObj?.x_search_calls ?? xFallback),
    code_interpreter_calls: Number(detailsObj?.code_interpreter_calls ?? 0),
    file_search_calls: Number(detailsObj?.file_search_calls ?? 0),
    mcp_calls: Number(detailsObj?.mcp_calls ?? 0),
    document_search_calls: Number(detailsObj?.document_search_calls ?? 0),
  };
  return {
    inputTokens: Number.isFinite(inputTokens) ? inputTokens : 0,
    outputTokens: Number.isFinite(outputTokens) ? outputTokens : 0,
    totalTokens: Number.isFinite(totalTokens) ? totalTokens : 0,
    reasoningTokens: Number.isFinite(reasoningTokens) ? reasoningTokens : 0,
    cachedInputTokens: Number.isFinite(cachedInputTokens)
      ? cachedInputTokens
      : 0,
    numServerSideToolsUsed: Number.isFinite(numServerSideToolsUsed)
      ? numServerSideToolsUsed
      : 0,
    toolUsageDetails,
    providerCostUsdTicks,
  };
}

function computeEstimatedCost(args: Args, usage: UsageMetrics): CostEstimate {
  const inputCostUsd = (usage.inputTokens / 1_000_000) * args.priceInputPerM;
  const outputCostUsd = (usage.outputTokens / 1_000_000) * args.priceOutputPerM;
  const tokenCostUsd = inputCostUsd + outputCostUsd;
  const toolCostUsd =
    (usage.toolUsageDetails.web_search_calls / 1_000) * args.priceWebPer1k +
    (usage.toolUsageDetails.x_search_calls / 1_000) * args.priceXPer1k;
  return {
    inputCostUsd,
    outputCostUsd,
    tokenCostUsd,
    toolCostUsd,
    totalCostUsd: tokenCostUsd + toolCostUsd,
  };
}

function extractToolAttemptCount(payload: unknown): number {
  if (!payload || typeof payload !== "object") return 0;
  const topToolCalls = (payload as Record<string, unknown>).tool_calls;
  if (Array.isArray(topToolCalls)) return topToolCalls.length;
  const outputItems = extractOutputItems(payload);
  return outputItems.filter((output) => {
    const type = output.type;
    if (typeof type !== "string") return false;
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

function normalizeDomain(raw: string): string {
  const value = raw.trim().toLowerCase();
  return value.startsWith("www.") ? value.slice(4) : value;
}

function isTrustedWebDomain(raw: string): boolean {
  const domain = normalizeDomain(raw);
  return TRUSTED_WEB_DOMAINS.some(
    (trusted) => domain === trusted || domain.endsWith(`.${trusted}`),
  );
}

function extractJsonCandidate(raw: string): string | null {
  const text = raw.trim();
  if (!text) return null;
  if (text.startsWith("{") && text.endsWith("}")) {
    return text;
  }
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced?.[1]) {
    return fenced[1].trim();
  }
  const firstBrace = text.indexOf("{");
  if (firstBrace === -1) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let idx = firstBrace; idx < text.length; idx += 1) {
    const ch = text[idx];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === "{") {
      depth += 1;
    } else if (ch === "}") {
      depth -= 1;
      if (depth === 0) {
        return text.slice(firstBrace, idx + 1).trim();
      }
    }
  }
  return null;
}

function parseStructuredOutput(raw: string): ParsedStructuredResult {
  const candidate = extractJsonCandidate(raw);
  if (!candidate) {
    return {
      valid: false,
      parseError: "no_json_object",
      status: "INVALID",
      evidenceCount: 0,
      supportsTopicCount: 0,
      claimsCount: 0,
      uniqueDomainCount: 0,
      trustedEvidenceCount: 0,
      notes: null,
      json: null,
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate);
  } catch (error) {
    return {
      valid: false,
      parseError: error instanceof Error ? error.message : "json_parse_error",
      status: "INVALID",
      evidenceCount: 0,
      supportsTopicCount: 0,
      claimsCount: 0,
      uniqueDomainCount: 0,
      trustedEvidenceCount: 0,
      notes: null,
      json: null,
    };
  }

  if (!parsed || typeof parsed !== "object") {
    return {
      valid: false,
      parseError: "json_not_object",
      status: "INVALID",
      evidenceCount: 0,
      supportsTopicCount: 0,
      claimsCount: 0,
      uniqueDomainCount: 0,
      trustedEvidenceCount: 0,
      notes: null,
      json: parsed,
    };
  }

  const obj = parsed as Record<string, unknown>;
  const rawStatus =
    typeof obj.status === "string" ? obj.status.trim().toUpperCase() : "";
  const status: ParsedStructuredResult["status"] =
    rawStatus === "OK" || rawStatus === "NO_EVIDENCE" || rawStatus === "PARTIAL"
      ? rawStatus
      : "INVALID";
  const evidence = Array.isArray(obj.evidence)
    ? obj.evidence.filter((item) => item && typeof item === "object")
    : [];
  const supportsTopicCount = evidence.filter((item) => {
    const value = (item as Record<string, unknown>).supports_topic;
    return value === true;
  }).length;
  const claimsCount = evidence.filter((item) => {
    const claim = (item as Record<string, unknown>).claim;
    return typeof claim === "string" && claim.trim().length > 0;
  }).length;
  const domains = evidence
    .map((item) => (item as Record<string, unknown>).source_domain)
    .filter(
      (domain): domain is string =>
        typeof domain === "string" && domain.trim().length > 0,
    )
    .map(normalizeDomain);
  const uniqueDomainCount = new Set(domains).size;
  const trustedEvidenceCount = domains.filter(isTrustedWebDomain).length;
  const notes = typeof obj.notes === "string" ? obj.notes : null;

  return {
    valid: status !== "INVALID",
    parseError: status === "INVALID" ? "invalid_status" : null,
    status,
    evidenceCount: evidence.length,
    supportsTopicCount,
    claimsCount,
    uniqueDomainCount,
    trustedEvidenceCount,
    notes,
    json: parsed,
  };
}

function resolveTopicPrompt(topic: QueryExample): string {
  const strict = topic.retrievalPlan?.strict;
  return strict?.combinedPrompt ?? topic.promptCombined;
}

function promptForMode(prompt: string, mode: SearchMode): string {
  if (mode === "combined") return prompt;
  if (mode === "web_only") {
    return prompt.replaceAll(
      "web_search and x_search together",
      "web_search only",
    );
  }
  return prompt.replaceAll(
    "web_search and x_search together",
    "internal context only",
  );
}

function resolveMinEvidence(topic: QueryExample): number {
  const raw = topic.retrievalPlan?.minEvidence;
  const parsed = typeof raw === "number" ? raw : Number.NaN;
  if (!Number.isFinite(parsed) || parsed < 1) return 1;
  return Math.min(6, Math.floor(parsed));
}

function resolveIntentAnchor(topic: QueryExample): string | null {
  const anchor = topic.retrievalPlan?.intentAnchor;
  if (!anchor || typeof anchor !== "string") return null;
  const compact = anchor.trim();
  return compact.length > 0 ? compact : null;
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort((a, b) => a.localeCompare(b));
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(obj[key])}`).join(",")}}`;
}

function buildCallId(call: Omit<PlannedCall, "callId">): string {
  const payload = [
    call.topicKey,
    call.queryType,
    call.prompt,
    stableStringify(call.tools),
  ].join("|");
  return createHash("sha256").update(payload).digest("hex");
}

function buildPlannedCalls(topics: QueryExample[], args: Args): PlannedCall[] {
  const calls: PlannedCall[] = [];
  const seen = new Set<string>();
  for (const topic of topics) {
    if (!args.tiers.has(topic.tier)) continue;
    if (
      !Number.isFinite(topic.pack.combinedCount) ||
      topic.pack.combinedCount <= 0
    ) {
      continue;
    }
    const minEvidence = resolveMinEvidence(topic);
    const intentAnchor = resolveIntentAnchor(topic);
    const tools =
      args.mode === "combined"
        ? [topic.webSearchTool, topic.xSearchTool]
        : args.mode === "web_only"
          ? [topic.webSearchTool]
          : [];
    const next: Omit<PlannedCall, "callId"> = {
      topicKey: topic.topicKey,
      tier: topic.tier,
      category: topic.category,
      entity: topic.entity,
      marketCount: topic.marketCount,
      sampleEventId: topic.sampleEventId ?? null,
      sampleMarketId: topic.sampleMarketId ?? null,
      sampleVenue: topic.sampleVenue ?? null,
      sampleMarketUpdatedAt: topic.sampleMarketUpdatedAt ?? null,
      queryType: args.mode,
      prompt: promptForMode(resolveTopicPrompt(topic), args.mode),
      minEvidence,
      intentAnchor,
      tools,
    };
    const callId = buildCallId(next);
    if (seen.has(callId)) continue;
    seen.add(callId);
    calls.push({ ...next, callId });
  }
  return calls;
}

function validateTopicsContract(summary: TopicsSummary): void {
  const version = summary.qaContract?.version;
  if (version && version !== QA_CONTRACT_VERSION) {
    throw new Error(
      `Invalid topics file contract: expected ${QA_CONTRACT_VERSION}, got ${version}`,
    );
  }
  if (!summary.searchPlan || !Array.isArray(summary.searchPlan.queryExamples)) {
    throw new Error(
      "Invalid topics file: expected searchPlan.queryExamples array",
    );
  }
}

function deterministicTopicOrder(
  topics: QueryExample[],
  seed: number | null,
): QueryExample[] {
  if (seed == null) return topics;
  return [...topics].sort((a, b) => {
    const ha = createHash("sha1").update(`${seed}|${a.topicKey}`).digest("hex");
    const hb = createHash("sha1").update(`${seed}|${b.topicKey}`).digest("hex");
    return ha.localeCompare(hb);
  });
}

function hasProviderLimitSignal(text: string | null | undefined): boolean {
  if (!text) return false;
  return /tool limit|rate limit|quota|too many requests|429/i.test(text);
}

function classifyOutcome(result: SmokeResult): SearchOutcomeClass {
  if (!result.ok) {
    if (
      result.status === 429 ||
      hasProviderLimitSignal(result.error) ||
      hasProviderLimitSignal(result.outputText)
    ) {
      return "PROVIDER_LIMIT";
    }
    if (
      result.status === 408 ||
      /abort|timeout|timed out/i.test(result.error ?? "")
    ) {
      return "TIMEOUT";
    }
    return "PROVIDER_ERROR";
  }

  if (result.parsed.status === "INVALID") {
    return "SCHEMA_INVALID";
  }

  if (result.parsed.status === "NO_EVIDENCE") {
    if (
      hasProviderLimitSignal(result.parsed.notes) ||
      hasProviderLimitSignal(result.outputText)
    ) {
      return "PROVIDER_LIMIT";
    }
    return "NO_EVIDENCE";
  }

  if (
    result.parsed.status === "PARTIAL" &&
    result.parsed.supportsTopicCount < result.minEvidence
  ) {
    return "NO_EVIDENCE";
  }

  return "OK";
}

async function callXaiOnce(
  apiKey: string,
  args: Args,
  prompt: string,
  tools: Array<Record<string, unknown>>,
  maxTurns: number,
): Promise<XaiCallRaw> {
  const startedAt = Date.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), args.timeoutSec * 1000);
  try {
    const normalizedBase = args.baseUrl.endsWith("/")
      ? args.baseUrl
      : `${args.baseUrl}/`;
    const endpoint = new URL("responses", normalizedBase).toString();
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: args.model,
        max_output_tokens: args.maxOutputTokens,
        max_turns: maxTurns,
        input: [
          {
            role: "system",
            content: SYSTEM_JSON_ENFORCER,
          },
          {
            role: "user",
            content: prompt,
          },
        ],
        tools,
      }),
      signal: controller.signal,
    });

    const rawText = await response.text();
    let payload: unknown = rawText;
    try {
      payload = JSON.parse(rawText);
    } catch {
      // keep raw text
    }
    const outputText = extractOutputText(payload);
    const payloadText = stringifyPayload(payload);
    const resolvedOutputText = outputText || payloadText;
    const usage = extractUsageMetrics(payload);

    return {
      ok: response.ok,
      status: response.status,
      durationMs: Date.now() - startedAt,
      attempts: 1,
      retried: false,
      prompt,
      outputText: resolvedOutputText,
      outputPreview: preview(resolvedOutputText),
      outputTextLength: resolvedOutputText.length,
      citationsCount: extractCitationsCount(payload),
      toolAttemptCount: extractToolAttemptCount(payload),
      successfulToolCount: extractSuccessfulToolCount(payload),
      usage,
      costEstimate: computeEstimatedCost(args, usage),
      serverSideToolUsage: extractServerSideToolUsage(payload),
      rawResponse: payload,
      ...(response.ok
        ? {}
        : {
            error: `HTTP ${response.status}: ${preview(
              stringifyPayload(payload),
              400,
            )}`,
          }),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      status: 0,
      durationMs: Date.now() - startedAt,
      attempts: 1,
      retried: false,
      prompt,
      outputText: "",
      outputPreview: "",
      outputTextLength: 0,
      citationsCount: 0,
      toolAttemptCount: 0,
      successfulToolCount: 0,
      usage: ZERO_USAGE,
      costEstimate: ZERO_COST,
      serverSideToolUsage: null,
      rawResponse: null,
      error: message,
    };
  } finally {
    clearTimeout(timeout);
  }
}

function isRetriableFailure(raw: XaiCallRaw): boolean {
  if (raw.ok) return false;
  if (raw.status === 429) return true;
  if (raw.status >= 500 && raw.status < 600) return true;
  if (raw.status === 0) return true;
  const message = raw.error?.toLowerCase() ?? "";
  return (
    message.includes("abort") ||
    message.includes("timed out") ||
    message.includes("timeout") ||
    message.includes("network")
  );
}

function computeBackoffMs(baseMs: number, attempt: number): number {
  const exp = Math.min(attempt, 6);
  const jitterFactor = 0.75 + Math.random() * 0.5;
  return Math.round(baseMs * 2 ** exp * jitterFactor);
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

async function callXaiWithRetry(
  apiKey: string,
  args: Args,
  prompt: string,
  tools: Array<Record<string, unknown>>,
  maxTurns: number,
): Promise<XaiCallRaw> {
  let attempts = 0;
  let last: XaiCallRaw | null = null;
  const totalAttempts = args.maxRetries + 1;
  while (attempts < totalAttempts) {
    const currentAttempt = attempts + 1;
    const raw = await callXaiOnce(apiKey, args, prompt, tools, maxTurns);
    attempts = currentAttempt;
    last = raw;
    if (!isRetriableFailure(raw) || currentAttempt >= totalAttempts) {
      return {
        ...raw,
        attempts: currentAttempt,
        retried: currentAttempt > 1,
      };
    }
    const backoffMs = computeBackoffMs(args.retryBaseMs, attempts - 1);
    if (args.verbose) {
      console.log(
        `[ai-search-smoke] retry ${currentAttempt}/${totalAttempts - 1} after ${backoffMs}ms status=${raw.status} err=${raw.error ?? "unknown"}`,
      );
    }
    await sleep(backoffMs);
  }
  return {
    ...(last ?? {
      ok: false,
      status: 0,
      durationMs: 0,
      prompt,
      outputText: "",
      outputPreview: "",
      outputTextLength: 0,
      citationsCount: 0,
      toolAttemptCount: 0,
      successfulToolCount: 0,
      usage: ZERO_USAGE,
      costEstimate: ZERO_COST,
      serverSideToolUsage: null,
      rawResponse: null,
      error: "retry_exhausted_without_response",
    }),
    attempts,
    retried: attempts > 1,
  };
}

function extractToolCallCount(usage: unknown): number {
  if (!usage) return 0;
  if (Array.isArray(usage)) {
    return usage.reduce((sum, item) => {
      if (!item || typeof item !== "object") return sum;
      const count = (item as Record<string, unknown>).count;
      if (typeof count === "number" && Number.isFinite(count) && count > 0) {
        return sum + count;
      }
      return sum + 1;
    }, 0);
  }
  if (typeof usage === "object") {
    const obj = usage as Record<string, unknown>;
    let sum = 0;
    for (const value of Object.values(obj)) {
      if (typeof value === "number" && Number.isFinite(value) && value > 0) {
        sum += value;
        continue;
      }
      if (value && typeof value === "object") {
        const nested = value as Record<string, unknown>;
        const count = nested.count;
        if (typeof count === "number" && Number.isFinite(count) && count > 0) {
          sum += count;
        }
      }
    }
    return sum;
  }
  return 0;
}

function evaluateProvenance(raw: XaiCallRaw): {
  ok: boolean;
  reason: string;
  toolCallCount: number;
} {
  const toolCallCount = Math.max(
    extractToolCallCount(raw.serverSideToolUsage),
    raw.successfulToolCount,
  );
  const citationsOk = raw.citationsCount > 0;
  const toolsOk = toolCallCount > 0;
  const attemptedTools = raw.toolAttemptCount > 0;
  if (citationsOk || toolsOk) {
    const reason = [
      citationsOk ? `citations:${raw.citationsCount}` : null,
      toolsOk ? `tool_calls:${toolCallCount}` : null,
      attemptedTools ? `tool_attempts:${raw.toolAttemptCount}` : null,
    ]
      .filter(Boolean)
      .join(",");
    return { ok: true, reason, toolCallCount };
  }
  return {
    ok: false,
    reason: "missing_citations_and_tool_usage",
    toolCallCount,
  };
}

function meetsEvidenceThreshold(
  parsed: ParsedStructuredResult,
  minEvidence: number,
  provenanceOk: boolean,
  queryType: QueryType,
): boolean {
  if (queryType === "internal_only") {
    return parsed.valid && parsed.status !== "INVALID";
  }
  return (
    provenanceOk &&
    parsed.valid &&
    parsed.status !== "INVALID" &&
    parsed.supportsTopicCount >= minEvidence
  );
}

function parsedStatusScore(status: ParsedStructuredResult["status"]): number {
  if (status === "OK") return 3;
  if (status === "PARTIAL") return 2;
  if (status === "NO_EVIDENCE") return 1;
  return 0;
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, Math.min(sorted.length - 1, idx))];
}

async function runWithConcurrency<TInput, TOutput>(
  items: TInput[],
  concurrency: number,
  worker: (item: TInput) => Promise<TOutput>,
): Promise<TOutput[]> {
  const results = new Array<TOutput>(items.length);
  let index = 0;
  const size = Math.max(1, Math.min(concurrency, items.length));
  const runners = Array.from({ length: size }, async () => {
    while (true) {
      const current = index;
      index += 1;
      if (current >= items.length) return;
      results[current] = await worker(items[current]);
    }
  });
  await Promise.all(runners);
  return results;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (hasFlag(argv, "--help")) {
    usage(0);
  }
  const args = resolveArgs(argv);
  const apiKey = process.env.XAI_API_KEY?.trim();
  if (!apiKey && !args.dryRun) {
    console.error("[ai-search-smoke] Missing XAI_API_KEY.");
    usage();
  }
  const resolvedApiKey = apiKey ?? "";

  const raw = await readFile(args.topicsFile, "utf8");
  const summary = JSON.parse(raw) as TopicsSummary;
  validateTopicsContract(summary);
  const queryExamples = summary.searchPlan.queryExamples;
  const eligibleTopics = queryExamples.filter((topic) =>
    args.tiers.has(topic.tier),
  );
  const orderedTopics = deterministicTopicOrder(
    eligibleTopics,
    args.sampleSeed,
  );
  const selectedTopics = orderedTopics.slice(0, args.maxTopics);
  const plannedCalls = buildPlannedCalls(selectedTopics, args);
  if (plannedCalls.length === 0) {
    console.log(
      `[ai-search-smoke] No calls planned for mode=${args.mode}, tiers=${Array.from(args.tiers).join(",")}`,
    );
    return;
  }

  if (args.dryRun) {
    const dry = plannedCalls.map((item) => ({
      callId: item.callId,
      topicKey: item.topicKey,
      tier: item.tier,
      category: item.category,
      entity: item.entity,
      queryType: item.queryType,
      sampleEventId: item.sampleEventId,
      sampleMarketId: item.sampleMarketId,
      sampleVenue: item.sampleVenue,
      sampleMarketUpdatedAt: item.sampleMarketUpdatedAt,
      prompt: item.prompt,
      minEvidence: item.minEvidence,
      intentAnchor: item.intentAnchor,
      tools: item.tools,
    }));
    const dryPayload = {
      qaContract: {
        version: QA_CONTRACT_VERSION,
        script: "ai-search-smoke",
        generatedAt: new Date().toISOString(),
      },
      plannedCalls: dry,
    };
    if (args.out) {
      await writeFile(args.out, JSON.stringify(dryPayload, null, 2), "utf8");
      console.error(`[ai-search-smoke] wrote ${args.out}`);
    }
    console.log(JSON.stringify(dryPayload, null, 2));
    return;
  }

  const results = await runWithConcurrency(
    plannedCalls,
    args.concurrency,
    async (call) => {
      const topicStartedAt = Date.now();
      const stageTurns: number[] = [];
      const firstTurns = Math.max(1, Math.min(args.stage1Turns, args.maxTurns));
      stageTurns.push(firstTurns);
      const remainingTurns = Math.max(0, args.maxTurns - firstTurns);
      const extraCalls = Math.max(0, args.maxCallsPerTopic - 1);
      if (extraCalls > 0 && remainingTurns > 0) {
        const base = Math.floor(remainingTurns / extraCalls);
        let rem = remainingTurns % extraCalls;
        for (let i = 0; i < extraCalls; i += 1) {
          const turns = base + (rem > 0 ? 1 : 0);
          if (turns > 0) stageTurns.push(turns);
          rem = Math.max(0, rem - 1);
        }
      }

      const stageRuns: Array<{
        turns: number;
        raw: XaiCallRaw;
        parsed: ParsedStructuredResult;
        provenance: { ok: boolean; reason: string; toolCallCount: number };
      }> = [];

      const usageAcc: UsageMetrics = {
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        reasoningTokens: 0,
        cachedInputTokens: 0,
        numServerSideToolsUsed: 0,
        toolUsageDetails: {
          web_search_calls: 0,
          x_search_calls: 0,
          code_interpreter_calls: 0,
          file_search_calls: 0,
          mcp_calls: 0,
          document_search_calls: 0,
        },
        providerCostUsdTicks: 0,
      };
      const costAcc: CostEstimate = {
        inputCostUsd: 0,
        outputCostUsd: 0,
        tokenCostUsd: 0,
        toolCostUsd: 0,
        totalCostUsd: 0,
      };

      let totalToolAttempts = 0;
      let totalSuccessfulTools = 0;
      let totalToolCalls = 0;
      let attemptsTotal = 0;
      let retriedAny = false;
      let earlyStop = false;
      let earlyStopReason: string | null = null;
      let toolBudgetExceeded = false;

      for (const turns of stageTurns) {
        const raw = await callXaiWithRetry(
          resolvedApiKey,
          args,
          call.prompt,
          call.tools,
          turns,
        );
        const parsed = parseStructuredOutput(raw.outputText);
        const provenance = evaluateProvenance(raw);
        stageRuns.push({ turns, raw, parsed, provenance });

        usageAcc.inputTokens += raw.usage.inputTokens;
        usageAcc.outputTokens += raw.usage.outputTokens;
        usageAcc.totalTokens += raw.usage.totalTokens;
        usageAcc.reasoningTokens += raw.usage.reasoningTokens;
        usageAcc.cachedInputTokens += raw.usage.cachedInputTokens;
        usageAcc.numServerSideToolsUsed += raw.usage.numServerSideToolsUsed;
        usageAcc.toolUsageDetails.web_search_calls +=
          raw.usage.toolUsageDetails.web_search_calls;
        usageAcc.toolUsageDetails.x_search_calls +=
          raw.usage.toolUsageDetails.x_search_calls;
        usageAcc.toolUsageDetails.code_interpreter_calls +=
          raw.usage.toolUsageDetails.code_interpreter_calls;
        usageAcc.toolUsageDetails.file_search_calls +=
          raw.usage.toolUsageDetails.file_search_calls;
        usageAcc.toolUsageDetails.mcp_calls +=
          raw.usage.toolUsageDetails.mcp_calls;
        usageAcc.toolUsageDetails.document_search_calls +=
          raw.usage.toolUsageDetails.document_search_calls;
        usageAcc.providerCostUsdTicks =
          (usageAcc.providerCostUsdTicks ?? 0) +
          (raw.usage.providerCostUsdTicks ?? 0);

        costAcc.inputCostUsd += raw.costEstimate.inputCostUsd;
        costAcc.outputCostUsd += raw.costEstimate.outputCostUsd;
        costAcc.tokenCostUsd += raw.costEstimate.tokenCostUsd;
        costAcc.toolCostUsd += raw.costEstimate.toolCostUsd;
        costAcc.totalCostUsd += raw.costEstimate.totalCostUsd;

        totalToolAttempts += raw.toolAttemptCount;
        totalSuccessfulTools += raw.successfulToolCount;
        totalToolCalls += provenance.toolCallCount;
        attemptsTotal += raw.attempts;
        retriedAny = retriedAny || raw.retried;

        if (
          meetsEvidenceThreshold(
            parsed,
            call.minEvidence,
            provenance.ok,
            call.queryType,
          )
        ) {
          earlyStop = true;
          earlyStopReason = "evidence_threshold_met";
          break;
        }
        if (totalToolAttempts >= args.maxToolAttemptsPerTopic) {
          earlyStop = true;
          earlyStopReason = "tool_attempt_budget_reached";
          toolBudgetExceeded = true;
          break;
        }
      }

      const selected = stageRuns.reduce(
        (best, current) => {
          if (!best) return current;
          const bestScore =
            parsedStatusScore(best.parsed.status) * 100 +
            (best.provenance.ok ? 20 : 0) +
            Math.min(19, best.parsed.supportsTopicCount);
          const currentScore =
            parsedStatusScore(current.parsed.status) * 100 +
            (current.provenance.ok ? 20 : 0) +
            Math.min(19, current.parsed.supportsTopicCount);
          if (currentScore > bestScore) return current;
          if (currentScore === bestScore && current.raw.ok && !best.raw.ok)
            return current;
          return best;
        },
        null as {
          turns: number;
          raw: XaiCallRaw;
          parsed: ParsedStructuredResult;
          provenance: { ok: boolean; reason: string; toolCallCount: number };
        } | null,
      );

      if (!selected) {
        throw new Error("No stage results collected");
      }

      const strictResult: SmokeResult = {
        callId: call.callId,
        topicKey: call.topicKey,
        tier: call.tier,
        category: call.category,
        entity: call.entity,
        marketCount: call.marketCount,
        queryType: call.queryType,
        sampleEventId: call.sampleEventId,
        sampleMarketId: call.sampleMarketId,
        sampleVenue: call.sampleVenue,
        sampleMarketUpdatedAt: call.sampleMarketUpdatedAt,
        ok: selected.raw.ok,
        status: selected.raw.status,
        durationMs: Date.now() - topicStartedAt,
        prompt: selected.raw.prompt,
        intentAnchor: call.intentAnchor,
        minEvidence: call.minEvidence,
        outputText: selected.raw.outputText,
        outputPreview: selected.raw.outputPreview,
        outputTextLength: selected.raw.outputTextLength,
        parsed: selected.parsed,
        outcomeClass: "OK",
        citationsCount: selected.raw.citationsCount,
        toolAttemptCount: totalToolAttempts,
        successfulToolCount: totalSuccessfulTools,
        usage: usageAcc,
        costEstimate: costAcc,
        serverSideToolUsage: selected.raw.serverSideToolUsage,
        toolCallCount: totalToolCalls,
        provenanceOk: selected.provenance.ok,
        provenanceReason: selected.provenance.reason,
        stagesExecuted: stageRuns.length,
        stageTurns: stageRuns.map((run) => run.turns),
        earlyStop,
        earlyStopReason,
        toolBudgetExceeded,
        toolAttemptsBudget: args.maxToolAttemptsPerTopic,
        attempts: attemptsTotal,
        retried: retriedAny,
        ...(args.saveRaw ? { rawResponse: selected.raw.rawResponse } : {}),
        ...(selected.raw.error ? { error: selected.raw.error } : {}),
      };
      strictResult.outcomeClass = classifyOutcome(strictResult);
      if (args.verbose) {
        console.log(
          `[ai-search-smoke] ${selected.raw.ok ? "OK" : "ERR"} ${selected.raw.status} ${strictResult.durationMs}ms ${call.tier} ${call.queryType} ${call.entity} parsed=${selected.parsed.status} outcome=${strictResult.outcomeClass} ev=${selected.parsed.supportsTopicCount}/${call.minEvidence} trusted=${selected.parsed.trustedEvidenceCount} domains=${selected.parsed.uniqueDomainCount} prov=${selected.provenance.ok ? "OK" : "MISS"} stages=${strictResult.stagesExecuted} turns=${strictResult.stageTurns.join("+")} early_stop=${strictResult.earlyStopReason ?? "none"} tool_attempts=${totalToolAttempts}/${args.maxToolAttemptsPerTopic} tool_success=${totalSuccessfulTools}`,
        );
      }
      return strictResult;
    },
  );

  const success = results.filter((row) => row.ok).length;
  const failed = results.length - success;
  const averageMs =
    results.length === 0
      ? 0
      : Math.round(
          results.reduce((acc, row) => acc + row.durationMs, 0) /
            results.length,
        );

  const qaViolations = {
    missingProvenanceForSupported: results.filter(
      (row) =>
        (row.parsed.status === "OK" || row.parsed.status === "PARTIAL") &&
        row.parsed.supportsTopicCount >= row.minEvidence &&
        !row.provenanceOk,
    ).length,
    belowEvidenceThresholdForOkPartial: results.filter(
      (row) =>
        (row.parsed.status === "OK" || row.parsed.status === "PARTIAL") &&
        row.parsed.supportsTopicCount < row.minEvidence,
    ).length,
    okWithoutEvidence: results.filter(
      (row) => row.parsed.status === "OK" && row.parsed.evidenceCount === 0,
    ).length,
  };
  const qaViolationTotal =
    qaViolations.missingProvenanceForSupported +
    qaViolations.belowEvidenceThresholdForOkPartial +
    qaViolations.okWithoutEvidence;
  const outcomeSummary = results.reduce<Record<SearchOutcomeClass, number>>(
    (acc, row) => {
      acc[row.outcomeClass] += 1;
      return acc;
    },
    {
      OK: 0,
      NO_EVIDENCE: 0,
      PROVIDER_LIMIT: 0,
      PROVIDER_ERROR: 0,
      TIMEOUT: 0,
      SCHEMA_INVALID: 0,
    },
  );
  const qualityMisses =
    outcomeSummary.NO_EVIDENCE + outcomeSummary.SCHEMA_INVALID;
  const providerFailures =
    outcomeSummary.PROVIDER_ERROR +
    outcomeSummary.PROVIDER_LIMIT +
    outcomeSummary.TIMEOUT;

  const report = {
    qaContract: {
      version: QA_CONTRACT_VERSION,
      script: "ai-search-smoke",
      generatedAt: new Date().toISOString(),
    },
    generatedAt: new Date().toISOString(),
    topicsFile: args.topicsFile,
    model: args.model,
    mode: args.mode,
    tiers: Array.from(args.tiers),
    maxTopics: args.maxTopics,
    timeoutSec: args.timeoutSec,
    concurrency: args.concurrency,
    maxRetries: args.maxRetries,
    retryBaseMs: args.retryBaseMs,
    maxTurns: args.maxTurns,
    stage1Turns: args.stage1Turns,
    maxCallsPerTopic: args.maxCallsPerTopic,
    maxToolAttemptsPerTopic: args.maxToolAttemptsPerTopic,
    strictProvenance: args.strictProvenance,
    sampleSeed: args.sampleSeed,
    saveRaw: args.saveRaw,
    pricing: {
      inputPerMillionUsd: args.priceInputPerM,
      outputPerMillionUsd: args.priceOutputPerM,
      webPer1kUsd: args.priceWebPer1k,
      xPer1kUsd: args.priceXPer1k,
    },
    totals: {
      topicsSelected: selectedTopics.length,
      callsPlanned: plannedCalls.length,
      callsExecuted: results.length,
      success,
      failed,
      successRate:
        results.length > 0 ? Number((success / results.length).toFixed(4)) : 0,
      averageMs,
      retried: results.filter((row) => row.retried).length,
      earlyStopped: results.filter((row) => row.earlyStop).length,
      toolBudgetExceeded: results.filter((row) => row.toolBudgetExceeded)
        .length,
      toolAttemptsTotal: results.reduce(
        (sum, row) => sum + row.toolAttemptCount,
        0,
      ),
      toolAttemptsP95: percentile(
        results.map((row) => row.toolAttemptCount),
        95,
      ),
      stageCallsTotal: results.reduce(
        (sum, row) => sum + row.stagesExecuted,
        0,
      ),
      stageCallsP95: percentile(
        results.map((row) => row.stagesExecuted),
        95,
      ),
      inputTokens: results.reduce((sum, row) => sum + row.usage.inputTokens, 0),
      outputTokens: results.reduce(
        (sum, row) => sum + row.usage.outputTokens,
        0,
      ),
      estimatedInputCostUsd: Number(
        results
          .reduce((sum, row) => sum + row.costEstimate.inputCostUsd, 0)
          .toFixed(6),
      ),
      estimatedOutputCostUsd: Number(
        results
          .reduce((sum, row) => sum + row.costEstimate.outputCostUsd, 0)
          .toFixed(6),
      ),
      estimatedTokenCostUsd: Number(
        results
          .reduce((sum, row) => sum + row.costEstimate.tokenCostUsd, 0)
          .toFixed(6),
      ),
      estimatedToolCostUsd: Number(
        results
          .reduce((sum, row) => sum + row.costEstimate.toolCostUsd, 0)
          .toFixed(6),
      ),
      estimatedTotalCostUsd: Number(
        results
          .reduce((sum, row) => sum + row.costEstimate.totalCostUsd, 0)
          .toFixed(6),
      ),
      providerCostUsdTicks: results.reduce(
        (sum, row) => sum + (row.usage.providerCostUsdTicks ?? 0),
        0,
      ),
    },
    byQueryType: {
      combined: results.filter((row) => row.queryType === "combined").length,
      web_only: results.filter((row) => row.queryType === "web_only").length,
      internal_only: results.filter((row) => row.queryType === "internal_only")
        .length,
    },
    parsedSummary: {
      ok: results.filter((row) => row.parsed.status === "OK").length,
      partial: results.filter((row) => row.parsed.status === "PARTIAL").length,
      noEvidence: results.filter((row) => row.parsed.status === "NO_EVIDENCE")
        .length,
      invalid: results.filter((row) => row.parsed.status === "INVALID").length,
      provenanceOk: results.filter((row) => row.provenanceOk).length,
      provenanceMissing: results.filter((row) => !row.provenanceOk).length,
    },
    outcomeSummary,
    qa: {
      strictProvenance: args.strictProvenance,
      violationTotal: qaViolationTotal,
      qualityMisses,
      providerFailures,
      violations: qaViolations,
    },
    results,
  };

  if (args.out) {
    await writeFile(args.out, JSON.stringify(report, null, 2), "utf8");
    console.log(`[ai-search-smoke] wrote ${args.out}`);
  }

  console.log(
    `[ai-search-smoke] calls=${report.totals.callsExecuted} planned=${report.totals.callsPlanned} success=${success} failed=${failed} avg_ms=${averageMs}`,
  );
  console.log(
    `[ai-search-smoke] qa strict=${args.strictProvenance} violations=${qaViolationTotal} missing_prov=${qaViolations.missingProvenanceForSupported} below_min_ev=${qaViolations.belowEvidenceThresholdForOkPartial} ok_without_ev=${qaViolations.okWithoutEvidence}`,
  );
  console.log(
    `[ai-search-smoke] outcomes ok=${outcomeSummary.OK} no_evidence=${outcomeSummary.NO_EVIDENCE} schema_invalid=${outcomeSummary.SCHEMA_INVALID} provider_limit=${outcomeSummary.PROVIDER_LIMIT} provider_error=${outcomeSummary.PROVIDER_ERROR} timeout=${outcomeSummary.TIMEOUT}`,
  );
  console.table(
    results.map((row) => ({
      tier: row.tier,
      type: row.queryType,
      outcome: row.outcomeClass,
      status: row.status,
      ok: row.ok,
      ms: row.durationMs,
      parsed: row.parsed.status,
      evidence: `${row.parsed.supportsTopicCount}/${row.minEvidence}`,
      trusted: `${row.parsed.trustedEvidenceCount}/${row.parsed.evidenceCount}`,
      domains: row.parsed.uniqueDomainCount,
      citations: row.citationsCount,
      tools: row.toolCallCount,
      attempts_tool: row.toolAttemptCount,
      success_tool: row.successfulToolCount,
      stages: row.stagesExecuted,
      turns: row.stageTurns.join("+"),
      early_stop: row.earlyStopReason ?? "-",
      prov: row.provenanceOk ? "ok" : row.provenanceReason,
      attempts: row.attempts,
      est_cost_usd: Number(row.costEstimate.totalCostUsd.toFixed(5)),
      entity: row.entity,
      preview: row.outputPreview.slice(0, 80),
    })),
  );

  if (args.strictProvenance && qaViolationTotal > 0) {
    console.error(
      `[ai-search-smoke] strict provenance failure: ${qaViolationTotal} violation(s)`,
    );
    process.exitCode = 2;
  }
}

main().catch((error) => {
  console.error("[ai-search-smoke] failed", error);
  process.exit(1);
});

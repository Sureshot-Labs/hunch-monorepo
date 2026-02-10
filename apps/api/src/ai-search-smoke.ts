import { readFile, writeFile } from "fs/promises";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { config } from "dotenv";

const envPath = resolve(dirname(fileURLToPath(import.meta.url)), "../../../.env");
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

type SearchMode = "web" | "x" | "both";
type Tier = "A" | "B" | "C";
type QueryType = "web_news" | "x_signal";

type RetrievalPlan = {
  intentAnchor?: string;
  mustTerms?: string[];
  optionalTerms?: string[];
  aliasTerms?: string[];
  minEvidence?: number;
  strict?: {
    webNewsPrompt?: string;
    webDriversPrompt?: string;
    xSignalPrompt?: string;
  };
};

type QueryExample = {
  topicKey: string;
  tier: Tier;
  category: string;
  entity: string;
  marketCount: number;
  promptWebNews: string;
  promptWebDrivers: string;
  promptXSignal: string;
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
    webCount: number;
    xCount: number;
  };
};

type TopicsSummary = {
  generatedAt: string;
  searchPlan: {
    queryExamples: QueryExample[];
  };
};

type PlannedCall = {
  topicKey: string;
  tier: Tier;
  category: string;
  entity: string;
  marketCount: number;
  queryType: QueryType;
  prompt: string;
  minEvidence: number;
  intentAnchor: string | null;
  tool: Record<string, unknown>;
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
  prompt: string;
  outputText: string;
  outputPreview: string;
  outputTextLength: number;
  citationsCount: number;
  serverSideToolUsage: unknown;
  error?: string;
};

type SmokeResult = {
  topicKey: string;
  tier: Tier;
  category: string;
  entity: string;
  marketCount: number;
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
  citationsCount: number;
  serverSideToolUsage: unknown;
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
  out: string | null;
  dryRun: boolean;
  verbose: boolean;
  baseUrl: string;
};

function parseFlag(argv: string[], name: string): string | undefined {
  const idx = argv.findIndex(value => value === name);
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

function parseMode(value: string | undefined): SearchMode {
  if (value === "web" || value === "x" || value === "both") return value;
  return "both";
}

function parseTiers(value: string | undefined): Set<Tier> {
  if (!value) return new Set<Tier>(["A", "B", "C"]);
  const parsed = value
    .split(",")
    .map(entry => entry.trim().toUpperCase())
    .filter(entry => entry === "A" || entry === "B" || entry === "C") as Tier[];
  if (parsed.length === 0) return new Set<Tier>(["A", "B", "C"]);
  return new Set(parsed);
}

function usage(): never {
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
      "  --mode <web|x|both>         Which tool prompts to execute (default: both)",
      "  --tiers <csv>               Topic tiers to include, e.g. A,B (default: A,B,C)",
      "  --max-topics <n>            Max topics to test (default: 8)",
      "  --model <name>              xAI model (default: grok-4-1-fast-reasoning)",
      "  --max-output-tokens <n>     Max output tokens per call (default: 600)",
      "  --timeout-sec <n>           Per-call timeout seconds (default: 120)",
      "  --base-url <url>            Responses endpoint base (default: https://api.x.ai/v1)",
      "  --out <path>                Write JSON report to file",
      "  --dry-run                   Print planned calls only (no API requests)",
      "  --verbose                   Print each call status line",
      "",
      "Examples:",
      "  XAI_API_KEY=... pnpm -C hunch-monorepo -F api run ai:topics:dry-run -- --limit 50 --sampling per-venue --json --out /tmp/topics.json",
      "  XAI_API_KEY=... pnpm -C hunch-monorepo -F api run ai:search:smoke -- --topics-file /tmp/topics.json --tiers A,B --max-topics 6 --mode both --out /tmp/ai-search-smoke.json",
    ].join("\n"),
  );
  process.exit(1);
}

function resolveArgs(argv: string[]): Args {
  const topicsFile = parseFlag(argv, "--topics-file");
  if (!topicsFile) usage();

  return {
    topicsFile,
    model:
      parseFlag(argv, "--model")?.trim() ||
      process.env.XAI_SEARCH_MODEL?.trim() ||
      "grok-4-1-fast-reasoning",
    mode: parseMode(parseFlag(argv, "--mode")),
    tiers: parseTiers(parseFlag(argv, "--tiers")),
    maxTopics: parsePositiveInt(parseFlag(argv, "--max-topics"), 8),
    maxOutputTokens: parsePositiveInt(parseFlag(argv, "--max-output-tokens"), 600),
    timeoutSec: parsePositiveInt(parseFlag(argv, "--timeout-sec"), 120),
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

function extractCitationsCount(payload: unknown): number {
  if (!payload || typeof payload !== "object") return 0;
  const citations = (payload as Record<string, unknown>).citations;
  if (!Array.isArray(citations)) return 0;
  return citations.length;
}

function extractServerSideToolUsage(payload: unknown): unknown {
  if (!payload || typeof payload !== "object") return null;
  return (payload as Record<string, unknown>).server_side_tool_usage ?? null;
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
      } else if (ch === "\"") {
        inString = false;
      }
      continue;
    }
    if (ch === "\"") {
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
    ? obj.evidence.filter(item => item && typeof item === "object")
    : [];
  const supportsTopicCount = evidence.filter(item => {
    const value = (item as Record<string, unknown>).supports_topic;
    return value === true;
  }).length;
  const claimsCount = evidence.filter(item => {
    const claim = (item as Record<string, unknown>).claim;
    return typeof claim === "string" && claim.trim().length > 0;
  }).length;
  const domains = evidence
    .map(item => (item as Record<string, unknown>).source_domain)
    .filter((domain): domain is string => typeof domain === "string" && domain.trim().length > 0)
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

function resolveTopicPrompt(topic: QueryExample, queryType: QueryType): string {
  const strict = topic.retrievalPlan?.strict;
  if (queryType === "web_news") {
    return strict?.webNewsPrompt ?? topic.promptWebNews;
  }
  return strict?.xSignalPrompt ?? topic.promptXSignal;
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

function buildPlannedCalls(topics: QueryExample[], args: Args): PlannedCall[] {
  const calls: PlannedCall[] = [];
  for (const topic of topics) {
    if (!args.tiers.has(topic.tier)) continue;
    const minEvidence = resolveMinEvidence(topic);
    const intentAnchor = resolveIntentAnchor(topic);
    if (args.mode === "web" || args.mode === "both") {
      if (topic.pack.webCount > 0) {
        calls.push({
          topicKey: topic.topicKey,
          tier: topic.tier,
          category: topic.category,
          entity: topic.entity,
          marketCount: topic.marketCount,
          queryType: "web_news",
          prompt: resolveTopicPrompt(topic, "web_news"),
          minEvidence,
          intentAnchor,
          tool: topic.webSearchTool,
        });
      }
    }
    if (args.mode === "x" || args.mode === "both") {
      if (topic.pack.xCount > 0) {
        calls.push({
          topicKey: topic.topicKey,
          tier: topic.tier,
          category: topic.category,
          entity: topic.entity,
          marketCount: topic.marketCount,
          queryType: "x_signal",
          prompt: resolveTopicPrompt(topic, "x_signal"),
          minEvidence,
          intentAnchor,
          tool: topic.xSearchTool,
        });
      }
    }
  }
  return calls;
}

async function callXai(
  apiKey: string,
  args: Args,
  prompt: string,
  tool: Record<string, unknown>,
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
        tools: [tool],
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

    return {
      ok: response.ok,
      status: response.status,
      durationMs: Date.now() - startedAt,
      prompt,
      outputText: resolvedOutputText,
      outputPreview: preview(resolvedOutputText),
      outputTextLength: resolvedOutputText.length,
      citationsCount: extractCitationsCount(payload),
      serverSideToolUsage: extractServerSideToolUsage(payload),
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
      prompt,
      outputText: "",
      outputPreview: "",
      outputTextLength: 0,
      citationsCount: 0,
      serverSideToolUsage: null,
      error: message,
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function main(): Promise<void> {
  const args = resolveArgs(process.argv.slice(2));
  const apiKey = process.env.XAI_API_KEY?.trim();
  if (!apiKey && !args.dryRun) {
    console.error("[ai-search-smoke] Missing XAI_API_KEY.");
    usage();
  }
  const resolvedApiKey = apiKey ?? "";

  const raw = await readFile(args.topicsFile, "utf8");
  const summary = JSON.parse(raw) as TopicsSummary;
  const queryExamples = summary.searchPlan?.queryExamples;
  if (!Array.isArray(queryExamples)) {
    throw new Error(
      "Invalid topics file: expected searchPlan.queryExamples array",
    );
  }

  const selectedTopics = queryExamples.slice(0, args.maxTopics);
  const plannedCalls = buildPlannedCalls(selectedTopics, args);
  if (plannedCalls.length === 0) {
    console.log(
      `[ai-search-smoke] No calls planned for mode=${args.mode}, tiers=${Array.from(args.tiers).join(",")}`,
    );
    return;
  }

  if (args.dryRun) {
    const dry = plannedCalls.map(item => ({
      topicKey: item.topicKey,
      tier: item.tier,
      category: item.category,
      entity: item.entity,
      queryType: item.queryType,
      prompt: item.prompt,
      minEvidence: item.minEvidence,
      intentAnchor: item.intentAnchor,
      tool: item.tool,
    }));
    console.log(JSON.stringify({ plannedCalls: dry }, null, 2));
    return;
  }

  const results: SmokeResult[] = [];
  for (const call of plannedCalls) {
    const strictRaw = await callXai(resolvedApiKey, args, call.prompt, call.tool);
    const strictParsed = parseStructuredOutput(strictRaw.outputText);

    const strictResult: SmokeResult = {
      topicKey: call.topicKey,
      tier: call.tier,
      category: call.category,
      entity: call.entity,
      marketCount: call.marketCount,
      queryType: call.queryType,
      ok: strictRaw.ok,
      status: strictRaw.status,
      durationMs: strictRaw.durationMs,
      prompt: strictRaw.prompt,
      intentAnchor: call.intentAnchor,
      minEvidence: call.minEvidence,
      outputText: strictRaw.outputText,
      outputPreview: strictRaw.outputPreview,
      outputTextLength: strictRaw.outputTextLength,
      parsed: strictParsed,
      citationsCount: strictRaw.citationsCount,
      serverSideToolUsage: strictRaw.serverSideToolUsage,
      ...(strictRaw.error ? { error: strictRaw.error } : {}),
    };
    results.push(strictResult);

    if (args.verbose) {
      console.log(
        `[ai-search-smoke] ${strictRaw.ok ? "OK" : "ERR"} ${strictRaw.status} ${strictRaw.durationMs}ms ${call.tier} ${call.queryType} ${call.entity} parsed=${strictParsed.status} ev=${strictParsed.supportsTopicCount}/${call.minEvidence} trusted=${strictParsed.trustedEvidenceCount} domains=${strictParsed.uniqueDomainCount}`,
      );
    }
  }

  const success = results.filter(row => row.ok).length;
  const failed = results.length - success;
  const averageMs =
    results.length === 0
      ? 0
      : Math.round(results.reduce((acc, row) => acc + row.durationMs, 0) / results.length);

  const report = {
    generatedAt: new Date().toISOString(),
    topicsFile: args.topicsFile,
    model: args.model,
    mode: args.mode,
    tiers: Array.from(args.tiers),
    maxTopics: args.maxTopics,
    timeoutSec: args.timeoutSec,
    totals: {
      topicsSelected: selectedTopics.length,
      callsPlanned: plannedCalls.length,
      callsExecuted: results.length,
      success,
      failed,
      successRate: results.length > 0 ? Number((success / results.length).toFixed(4)) : 0,
      averageMs,
    },
    byQueryType: {
      web_news: results.filter(row => row.queryType === "web_news").length,
      x_signal: results.filter(row => row.queryType === "x_signal").length,
    },
    parsedSummary: {
      ok: results.filter(row => row.parsed.status === "OK").length,
      partial: results.filter(row => row.parsed.status === "PARTIAL").length,
      noEvidence: results.filter(row => row.parsed.status === "NO_EVIDENCE").length,
      invalid: results.filter(row => row.parsed.status === "INVALID").length,
      webNewsStrictNoTrusted: results.filter(
        row =>
          row.queryType === "web_news" &&
          row.parsed.evidenceCount > 0 &&
          row.parsed.trustedEvidenceCount === 0,
      ).length,
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
  console.table(
    results.map(row => ({
      tier: row.tier,
      type: row.queryType,
      status: row.status,
      ok: row.ok,
      ms: row.durationMs,
      parsed: row.parsed.status,
      evidence: `${row.parsed.supportsTopicCount}/${row.minEvidence}`,
      trusted: `${row.parsed.trustedEvidenceCount}/${row.parsed.evidenceCount}`,
      domains: row.parsed.uniqueDomainCount,
      citations: row.citationsCount,
      entity: row.entity,
      preview: row.outputPreview.slice(0, 80),
    })),
  );
}

main().catch(error => {
  console.error("[ai-search-smoke] failed", error);
  process.exit(1);
});

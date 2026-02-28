import { readFile, writeFile } from "fs/promises";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import { createRedisClient, ensureRedis } from "@hunch/infra";
import { pool } from "./db.js";
import { env } from "./env.js";
import {
  getOpenRouterEmbeddingPricingPerM,
  getOpenRouterModelPricingPerM,
} from "./lib/ai-pricing.js";
import { extractProviderCostUsd, resolveAiCost, type CostSource } from "./lib/ai-cost.js";
import {
  buildMapSignalsSystemPromptV2,
  buildMapSignalsUserPromptV2,
  parseMapSignalsAgentOutputV2,
  type MapSignalsAgentOutputV2,
} from "./schemas/ai-map-signals.js";
import {
  marketMapRunMetaKey,
  marketMapRunNodeEventsKey,
  marketMapRunNodesGlobalKey,
  safeJsonParse,
  type MarketMapEventSummary,
  type MarketMapMeta,
  type MarketMapNode,
} from "./services/market-map.js";

const QA_CONTRACT_VERSION = "qa_contract_v1";

type MapSignalsRunContext = {
  commandName: string;
  scriptTag: string;
  qaScriptName: string;
};

const DEFAULT_RUN_CONTEXT: MapSignalsRunContext = {
  commandName: "ai:map-signals:run",
  scriptTag: "ai-map-signals-run",
  qaScriptName: "ai-map-signals-run",
};

let activeRunContext: MapSignalsRunContext = DEFAULT_RUN_CONTEXT;

function logPrefix(): string {
  return `[${activeRunContext.scriptTag}]`;
}

type Confirmation = "confirmed" | "developing" | "unconfirmed";
type SourceTier = "official" | "wire" | "major_media" | "specialist" | "social";
type RouteReason =
  | "assigned_child"
  | "below_threshold"
  | "below_min_similarity"
  | "low_margin"
  | "no_candidate"
  | "leaf_self"
  | null;

type MapSearchEvidence = {
  id: string;
  headline: string;
  summary: string;
  sourceUrl: string;
  sourceDomain: string;
  publishedAt: string | null;
  confirmation: Confirmation;
  sourceTier: SourceTier;
  relevance: number;
  confidence: number;
  nodeId: string;
  callIndex: number;
  assignedNodeId: string | null;
  assignedSimilarity: number | null;
  routeReason: RouteReason;
};

type MapSearchCall = {
  callIndex: number;
  nodeId: string;
  nodeLabel: string;
  level: number;
};

type MapSearchRun = {
  runId: string;
  mapGeneratedAt: string;
};

type MapSearchArtifactFile = {
  run: MapSearchRun;
  totals: {
    callsExecuted: number;
    evidenceTotal: number;
    estimatedTotalCostUsd: number;
    chargedTotalCostUsd?: number;
    providerReportedCostUsd?: number;
    providerReportedCostCalls?: number;
  };
  calls: MapSearchCall[];
  evidence: MapSearchEvidence[];
};

type OpenRouterUsage = {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  reasoningTokens: number;
  providerCostUsd: number | null;
  providerCostField: string | null;
  providerCostUsdTicks: number | null;
};

type CostBreakdown = {
  inputCostUsd: number;
  outputCostUsd: number;
  tokenCostUsd: number;
  estimatedCostUsd: number;
  chargedCostUsd: number;
  providerCostUsd: number | null;
  providerCostField: string | null;
  providerCostUsdTicks: number | null;
  costSource: CostSource;
};

type OpenRouterCallResult = {
  content: string;
  usage: OpenRouterUsage;
  cost: CostBreakdown;
};

type EmbeddingCallResult = {
  vectors: Array<number[] | null>;
  usage: OpenRouterUsage;
  cost: CostBreakdown;
};

type EvidenceEmbeddingInput = {
  evidenceId: string;
  text: string;
};

type MarketEmbeddingInput = {
  marketId: string;
  eventId: string;
  text: string;
};

type Args = {
  inputPath: string;
  outPath: string | null;
  reportPath: string | null;
  model: string;
  embedModel: string;
  maxNodes: number;
  maxEvidencePerNode: number;
  maxMarketsPerNode: number;
  minEvidence: number;
  minConfirmed: number;
  minDistinctDomains: number;
  minEvidenceIdsForPublish: number;
  minAffinityForPublish: number;
  maxSignals: number;
  concurrency: number;
  maxOutputTokens: number;
  timeoutSec: number;
  priceInputPerM: number;
  priceOutputPerM: number;
  embedPriceInputPerM: number;
  embedPriceOutputPerM: number;
  dryRun: boolean;
  verbose: boolean;
};

type NodeBucket = {
  nodeId: string;
  nodeLabel: string;
  level: number;
  evidence: MapSearchEvidence[];
};

type MarketCandidate = {
  marketId: string;
  eventId: string;
  eventTitle: string;
  marketTitle: string | null;
  venue: string;
  yesProb: number | null;
  noProb: number | null;
  volume24h: number;
  liquidity: number;
  openInterest: number;
  score: number;
  affinityScore: number;
  affinityRank: number;
};

type SignalDecision = "publish_candidate" | "context_only" | "skip";
type SignalDirection = "up" | "down" | "mixed";
type SignalType = "catalyst" | "risk" | "update";

type SignalCandidate = {
  signalId: string;
  runId: string;
  nodeId: string;
  nodeLabel: string;
  level: number;
  decision: SignalDecision;
  signalType: SignalType;
  direction: SignalDirection;
  confidence: number;
  headline: string;
  summary: string;
  rationale: string;
  targetMarketId: string | null;
  targetEventId: string | null;
  targetMarketTitle: string | null;
  targetEventTitle: string | null;
  targetVenue: string | null;
  reasonCodes: string[];
  metrics: {
    evidenceCount: number;
    confirmedCount: number;
    distinctDomains: number;
    candidateMarkets: number;
    selectedMarketAffinity: number | null;
    bestMarketAffinity: number | null;
  };
  evidenceRefs: Array<{
    evidenceId: string;
    headline: string;
    sourceDomain: string;
    publishedAt: string | null;
    confirmation: Confirmation;
    sourceTier: SourceTier;
  }>;
  modelOutput: MapSignalsAgentOutputV2 | null;
  usage: OpenRouterUsage;
  tokenCostUsd: number;
  estimatedCostUsd: number;
  chargedCostUsd: number;
  providerCostUsd: number | null;
  providerCostField: string | null;
  providerCostUsdTicks: number | null;
  costSource: CostSource;
  error: string | null;
  modelStatus: MapSignalsAgentOutputV2["status"] | "NONE";
  downgradedFromPublish: boolean;
  schemaRepairAttempted: boolean;
  schemaRepairSuccess: boolean;
};

function parseFlag(argv: string[], flag: string): string | undefined {
  const inlinePrefix = `${flag}=`;
  const inlineValue = argv.find(arg => arg.startsWith(inlinePrefix));
  if (inlineValue) return inlineValue.slice(inlinePrefix.length);
  const idx = argv.indexOf(flag);
  if (idx === -1) return undefined;
  return argv[idx + 1];
}

function hasFlag(argv: string[], flag: string): boolean {
  return argv.includes(flag);
}

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return n;
}

function parsePositiveNumber(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return n;
}

function parseNonNegativeNumber(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return n;
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

function parsePossibleJson(raw: string): unknown {
  const trimmed = raw.trim();
  if (!trimmed) throw new Error("model_empty_output");
  try {
    return JSON.parse(trimmed);
  } catch {
    const first = trimmed.indexOf("{");
    const last = trimmed.lastIndexOf("}");
    if (first >= 0 && last > first) {
      return JSON.parse(trimmed.slice(first, last + 1));
    }
    throw new Error("model_output_not_json");
  }
}

function toIsoNow(): string {
  return new Date().toISOString();
}

function formatUsd(value: number): string {
  return `$${value.toFixed(6)}`;
}

function preview(value: string, maxChars: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, Math.max(0, maxChars - 1))}…`;
}

function resolveArgs(argv: string[]): Args {
  const model = parseFlag(argv, "--model") ?? "openai/gpt-5.2";
  const embedModel =
    parseFlag(argv, "--embed-model") ??
    process.env.OPENROUTER_EMBED_MODEL ??
    process.env.AI_EMBED_MODEL ??
    "intfloat/e5-large-v2";
  const modelPricing = getOpenRouterModelPricingPerM(model);
  const embedPricing = getOpenRouterEmbeddingPricingPerM(embedModel);
  return {
    inputPath:
      parseFlag(argv, "--in") ??
      parseFlag(argv, "--input") ??
      "/tmp/ai-map-search-smoke.json",
    outPath: parseFlag(argv, "--out") ?? null,
    reportPath: parseFlag(argv, "--report-out") ?? null,
    model,
    embedModel,
    maxNodes: parsePositiveInt(parseFlag(argv, "--max-nodes"), 20),
    maxEvidencePerNode: parsePositiveInt(parseFlag(argv, "--max-evidence-per-node"), 12),
    maxMarketsPerNode: parsePositiveInt(parseFlag(argv, "--max-markets-per-node"), 12),
    minEvidence: parsePositiveInt(parseFlag(argv, "--min-evidence"), 1),
    minConfirmed: parsePositiveInt(parseFlag(argv, "--min-confirmed"), 1),
    minDistinctDomains: parsePositiveInt(parseFlag(argv, "--min-distinct-domains"), 1),
    minEvidenceIdsForPublish: parsePositiveInt(
      parseFlag(argv, "--min-evidence-ids-for-publish"),
      1,
    ),
    minAffinityForPublish: parseNonNegativeNumber(
      parseFlag(argv, "--min-affinity-for-publish"),
      0.15,
    ),
    maxSignals: parsePositiveInt(parseFlag(argv, "--max-signals"), 20),
    concurrency: parsePositiveInt(parseFlag(argv, "--concurrency"), 3),
    maxOutputTokens: parsePositiveInt(parseFlag(argv, "--max-output-tokens"), 900),
    timeoutSec: parsePositiveInt(parseFlag(argv, "--timeout-sec"), 90),
    priceInputPerM: parsePositiveNumber(
      parseFlag(argv, "--price-input-per-m"),
      modelPricing?.inputPerM ?? 0.2,
    ),
    priceOutputPerM: parsePositiveNumber(
      parseFlag(argv, "--price-output-per-m"),
      modelPricing?.outputPerM ?? 1,
    ),
    embedPriceInputPerM: parseNonNegativeNumber(
      parseFlag(argv, "--embed-price-input-per-m"),
      embedPricing?.inputPerM ?? 0,
    ),
    embedPriceOutputPerM: parseNonNegativeNumber(
      parseFlag(argv, "--embed-price-output-per-m"),
      embedPricing?.outputPerM ?? 0,
    ),
    dryRun: hasFlag(argv, "--dry-run"),
    verbose: hasFlag(argv, "--verbose"),
  };
}

function usage(context: MapSignalsRunContext, exitCode = 1): never {
  console.error(`Usage: pnpm -C hunch-monorepo -F api run ${context.commandName} -- [options]

Input:
  --in <path>                    Map-search JSON artifact (default: /tmp/ai-map-search-smoke.json)
  --out <path>                   Output JSON path
  --report-out <path>            Output markdown summary path

Model:
  --model <id>                   OpenRouter model (default: openai/gpt-5.2)
  --embed-model <id>             OpenRouter embeddings model (default: OPENROUTER_EMBED_MODEL or AI_EMBED_MODEL or intfloat/e5-large-v2)
  --max-output-tokens <n>        Max output tokens per node call (default: 900)
  --timeout-sec <n>              Request timeout seconds (default: 90)
  --concurrency <n>              Parallel node calls (default: 3)

Selection:
  --max-nodes <n>                Max node buckets considered (default: 20)
  --max-signals <n>              Max returned signals (default: 20)
  --max-evidence-per-node <n>    Evidence rows per node in prompt (default: 12)
  --max-markets-per-node <n>     Candidate markets per node (default: 12)

Quality gates:
  --min-evidence <n>             Minimum evidence for publish candidate (default: 1)
  --min-confirmed <n>            Minimum confirmed evidence for publish (default: 1)
  --min-distinct-domains <n>     Minimum source-domain diversity (default: 1)
  --min-evidence-ids-for-publish <n> Minimum linked evidence IDs for publish (default: 1)
  --min-affinity-for-publish <n> Minimum evidence→market affinity for publish (default: 0.15)

Cost model:
  --price-input-per-m <usd>      Input tokens USD / 1M (default: model table, fallback 0.2)
  --price-output-per-m <usd>     Output tokens USD / 1M (default: model table, fallback 1)
  --embed-price-input-per-m <usd> Embedding input tokens USD / 1M (default: model table, fallback 0)
  --embed-price-output-per-m <usd> Embedding output tokens USD / 1M (default: model table, fallback 0)

Flags:
  --dry-run                      Build deterministic context-only outputs (no model call)
  --verbose                      Print per-node details
`);
  process.exit(exitCode);
}

async function readInput(path: string): Promise<MapSearchArtifactFile> {
  const raw = await readFile(path, "utf8");
  const parsed = JSON.parse(raw) as MapSearchArtifactFile;
  if (!parsed || typeof parsed !== "object") throw new Error("invalid_input_payload");
  if (!parsed.run?.runId) throw new Error("missing_run_id");
  if (!Array.isArray(parsed.calls) || !Array.isArray(parsed.evidence)) {
    throw new Error("missing_calls_or_evidence");
  }
  return parsed;
}

function clamp01(value: number): number {
  if (Number.isNaN(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

function numericOrZero(value: number | null | undefined): number {
  return Number.isFinite(value) ? Number(value) : 0;
}

function safeNumber(value: unknown): number | null {
  if (typeof value !== "number") return null;
  if (!Number.isFinite(value)) return null;
  return value;
}

function computeMid(a: number | null | undefined, b: number | null | undefined): number | null {
  if (Number.isFinite(a) && Number.isFinite(b)) {
    return clamp01((Number(a) + Number(b)) / 2);
  }
  if (Number.isFinite(a)) return clamp01(Number(a));
  if (Number.isFinite(b)) return clamp01(Number(b));
  return null;
}

function inferYesNoProbabilities(event: MarketMapEventSummary): {
  yesProb: number | null;
  noProb: number | null;
} {
  if (event.resolvedOutcomePct != null && Number.isFinite(event.resolvedOutcomePct)) {
    const yes = clamp01(event.resolvedOutcomePct / 100);
    return { yesProb: yes, noProb: clamp01(1 - yes) };
  }

  const yesMid = computeMid(event.yesBid ?? null, event.yesAsk ?? null);
  const noMid = computeMid(event.noBid ?? null, event.noAsk ?? null);

  if (yesMid != null && noMid != null) {
    const total = yesMid + noMid;
    if (total > 0.000001) {
      const yes = clamp01(yesMid / total);
      return { yesProb: yes, noProb: clamp01(1 - yes) };
    }
  }
  if (yesMid != null) return { yesProb: yesMid, noProb: clamp01(1 - yesMid) };
  if (noMid != null) return { yesProb: clamp01(1 - noMid), noProb: noMid };

  const marketMid = computeMid(event.marketBestBid ?? null, event.marketBestAsk ?? null);
  if (marketMid != null) return { yesProb: marketMid, noProb: clamp01(1 - marketMid) };

  if (event.lastPrice != null && Number.isFinite(event.lastPrice)) {
    const yes = clamp01(event.lastPrice);
    return { yesProb: yes, noProb: clamp01(1 - yes) };
  }

  return { yesProb: null, noProb: null };
}

function buildSignalId(runId: string, nodeId: string): string {
  return createHash("sha1")
    .update(`${runId}:${nodeId}:signal-v2`)
    .digest("hex");
}

function normalizeEvidenceQuality(
  evidenceCount: number,
  confirmedCount: number,
  distinctDomains: number,
  minEvidence: number,
  minConfirmed: number,
  minDistinctDomains: number,
): number {
  const evidenceScore = clamp01(evidenceCount / Math.max(minEvidence, 1));
  const confirmedScore = clamp01(confirmedCount / Math.max(minConfirmed, 1));
  const domainScore = clamp01(distinctDomains / Math.max(minDistinctDomains, 1));
  return clamp01(0.45 * evidenceScore + 0.35 * confirmedScore + 0.2 * domainScore);
}

function sortEvidenceByQuality(items: MapSearchEvidence[]): MapSearchEvidence[] {
  const sorted = items
    .slice()
    .sort((a, b) => {
      const aq = 0.5 * clamp01((a.relevance + a.confidence) / 2) +
        0.25 * (a.confirmation === "confirmed" ? 1 : a.confirmation === "developing" ? 0.7 : 0.4) +
        0.25 * (a.sourceTier === "official" ? 1 : a.sourceTier === "wire" ? 0.95 : a.sourceTier === "major_media" ? 0.9 : a.sourceTier === "specialist" ? 0.8 : 0.65);
      const bq = 0.5 * clamp01((b.relevance + b.confidence) / 2) +
        0.25 * (b.confirmation === "confirmed" ? 1 : b.confirmation === "developing" ? 0.7 : 0.4) +
        0.25 * (b.sourceTier === "official" ? 1 : b.sourceTier === "wire" ? 0.95 : b.sourceTier === "major_media" ? 0.9 : b.sourceTier === "specialist" ? 0.8 : 0.65);
      return bq - aq;
    });

  // Keep high-quality ordering, but aggressively collapse near-duplicate social items.
  const deduped: MapSearchEvidence[] = [];
  const seenExact = new Set<string>();
  const keptSocial: Array<{ domain: string; text: string }> = [];
  for (const item of sorted) {
    const domain = (item.sourceDomain ?? "").toLowerCase();
    const headlineNorm = normalizeText(item.headline ?? "");
    const summaryNorm = normalizeText(item.summary ?? "");
    const exactKey = `${domain}|${headlineNorm}|${summaryNorm}`;
    if (seenExact.has(exactKey)) continue;
    seenExact.add(exactKey);

    const socialLike = item.sourceTier === "social" || domain === "x.com";
    if (socialLike) {
      const socialText = `${headlineNorm} ${summaryNorm}`.trim();
      if (!socialText) continue;
      let duplicate = false;
      for (const existing of keptSocial) {
        const sim = lexicalSimilarity(socialText, existing.text);
        if (existing.domain === domain && sim >= 0.9) {
          duplicate = true;
          break;
        }
        if (existing.domain !== domain && sim >= 0.96) {
          duplicate = true;
          break;
        }
      }
      if (duplicate) continue;
      keptSocial.push({ domain, text: socialText });
    }
    deduped.push(item);
  }
  return deduped;
}

function normalizeVector(values: readonly number[]): number[] {
  let norm = 0;
  for (const value of values) norm += value * value;
  if (!Number.isFinite(norm) || norm <= 0) return Array.from(values, () => 0);
  const mag = Math.sqrt(norm);
  return values.map(value => value / mag);
}

function parseEmbeddingBuffer(buffer: Buffer): number[] | null {
  if (!buffer || buffer.length === 0 || buffer.length % 4 !== 0) return null;
  const aligned = new ArrayBuffer(buffer.byteLength);
  new Uint8Array(aligned).set(buffer);
  const view = new Float32Array(aligned);
  return normalizeVector(Array.from(view));
}

function dot(a: readonly number[], b: readonly number[]): number {
  const size = Math.min(a.length, b.length);
  let sum = 0;
  for (let i = 0; i < size; i += 1) sum += a[i] * b[i];
  return sum;
}

function normalizeText(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
}

function tokenSet(value: string): Set<string> {
  const out = new Set<string>();
  for (const token of normalizeText(value).split(" ")) {
    if (token.length < 3) continue;
    out.add(token);
  }
  return out;
}

function lexicalSimilarity(a: string, b: string): number {
  const aTokens = tokenSet(a);
  const bTokens = tokenSet(b);
  if (aTokens.size === 0 || bTokens.size === 0) return 0;
  let overlap = 0;
  for (const token of aTokens) {
    if (bTokens.has(token)) overlap += 1;
  }
  const denom = Math.sqrt(aTokens.size * bTokens.size);
  if (denom <= 0) return 0;
  return clamp01(overlap / denom);
}

function pushUniqueReason(codes: string[], code: string): void {
  if (!codes.includes(code)) codes.push(code);
}

function includesAny(haystack: string, needles: readonly string[]): boolean {
  for (const needle of needles) {
    if (haystack.includes(needle)) return true;
  }
  return false;
}

function hasTargetIntentMismatch(
  selectedEvidence: MapSearchEvidence[],
  targetEventTitle: string | null,
  targetMarketTitle: string | null,
): boolean {
  if (selectedEvidence.length === 0) return false;
  const target = normalizeText(
    `${targetEventTitle ?? ""} ${targetMarketTitle ?? ""}`.trim(),
  );
  if (!target) return false;

  const targetIsNomination = includesAny(target, [
    "nomination",
    "nominee",
    "nominate",
    "primary",
  ]);
  if (targetIsNomination) return false;

  const targetIsWinnerLike = includesAny(target, [
    "winner",
    "champion",
    "best picture",
    "to win",
    "wins",
    "election winner",
  ]);
  if (!targetIsWinnerLike) return false;

  const evidenceText = normalizeText(
    selectedEvidence.map(item => `${item.headline} ${item.summary}`).join(" "),
  );
  if (!evidenceText) return false;

  const evidenceHasNominationLike = includesAny(evidenceText, [
    "nomination",
    "nominee",
    "nominate",
    "primary",
    "poll",
  ]);
  const evidenceHasWinnerLike = includesAny(evidenceText, [
    "winner",
    "champion",
    "best picture",
    "won",
    "wins",
    "title",
  ]);
  return evidenceHasNominationLike && !evidenceHasWinnerLike;
}

function isCircularSourceEvidence(
  selectedEvidence: MapSearchEvidence[],
  targetEventTitle: string | null,
  targetMarketTitle: string | null,
): boolean {
  if (selectedEvidence.length === 0) return false;
  const target = `${targetEventTitle ?? ""} ${targetMarketTitle ?? ""}`.trim();
  if (!target) return false;
  const targetNorm = normalizeText(target);
  if (!targetNorm) return false;

  for (const item of selectedEvidence) {
    const domain = (item.sourceDomain ?? "").toLowerCase();
    const socialLike = item.sourceTier === "social" || domain === "x.com";
    if (!socialLike) continue;

    const headline = item.headline ?? "";
    const headlineNorm = normalizeText(headline);
    if (!headlineNorm) continue;

    const sim = lexicalSimilarity(headline, target);
    const questionLike = /[?]/.test(headline) || /\b(who|what|when|how many|will)\b/i.test(headline);
    const mirror = headlineNorm === targetNorm || sim >= 0.9;
    if (mirror) return true;
    if (questionLike && sim >= 0.75) return true;
  }
  return false;
}

function evidenceMarketAffinity(
  evidence: MapSearchEvidence[],
  marketText: string,
): number {
  if (evidence.length === 0) return 0;
  let weightedSum = 0;
  let totalWeight = 0;
  for (const item of evidence) {
    const text = `${item.headline} ${item.summary}`;
    const sim = lexicalSimilarity(text, marketText);
    const weight = 0.5 + 0.5 * clamp01((item.relevance + item.confidence) / 2);
    weightedSum += sim * weight;
    totalWeight += weight;
  }
  if (totalWeight <= 0) return 0;
  return clamp01(weightedSum / totalWeight);
}

function evidenceMarketAffinityHybrid(
  evidence: MapSearchEvidence[],
  marketText: string,
  marketEmbedding: number[] | null,
  evidenceEmbeddings: Map<string, number[] | null>,
): number {
  if (evidence.length === 0) return 0;
  let weightedSum = 0;
  let totalWeight = 0;
  for (const item of evidence) {
    const text = `${item.headline} ${item.summary}`;
    const lexical = lexicalSimilarity(text, marketText);
    const route = clamp01(item.assignedSimilarity ?? 0);
    const evidenceVec = evidenceEmbeddings.get(item.id) ?? null;
    let blended = 0;
    if (marketEmbedding && evidenceVec) {
      const semantic = clamp01(Math.max(0, dot(evidenceVec, marketEmbedding)));
      blended = 0.65 * semantic + 0.2 * lexical + 0.15 * route;
    } else {
      blended = 0.85 * lexical + 0.15 * route;
    }
    const weight = 0.5 + 0.5 * clamp01((item.relevance + item.confidence) / 2);
    weightedSum += blended * weight;
    totalWeight += weight;
  }
  if (totalWeight <= 0) return 0;
  return clamp01(weightedSum / totalWeight);
}

function toParseErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function shouldAttemptSummaryTruncate(error: unknown): boolean {
  const message = toParseErrorMessage(error).toLowerCase();
  return message.includes("\"summary\"") && message.includes("too_big");
}

function truncateSummaryInPayload(payload: unknown, maxChars: number): unknown {
  if (!payload || typeof payload !== "object") return payload;
  const out = { ...(payload as Record<string, unknown>) };
  const summary = out.summary;
  if (typeof summary === "string" && summary.length > maxChars) {
    out.summary = `${summary.slice(0, maxChars).trimEnd()}`;
  }
  return out;
}

function buildRepairPrompt(rawOutput: string, reason: string): string {
  return [
    "Repair the malformed output into valid map_signals_v2 JSON.",
    "Return exactly one JSON object and nothing else.",
    "Do not add markdown/code fences/explanations.",
    "Keep facts unchanged; only fix structure/schema compliance.",
    `Repair reason: ${reason}`,
    "Malformed output:",
    rawOutput,
  ].join("\n");
}

function extractNodeBuckets(
  input: MapSearchArtifactFile,
  nodeLabelById: Map<string, string>,
  nodeLevelById: Map<string, number>,
): NodeBucket[] {
  const grouped = new Map<string, MapSearchEvidence[]>();
  for (const item of input.evidence) {
    const bucketNodeId = item.assignedNodeId ?? item.nodeId;
    const list = grouped.get(bucketNodeId);
    if (list) {
      list.push(item);
      continue;
    }
    grouped.set(bucketNodeId, [item]);
  }

  const buckets: NodeBucket[] = [];
  for (const [nodeId, evidence] of grouped.entries()) {
    const label = nodeLabelById.get(nodeId) ?? nodeId;
    const level = nodeLevelById.get(nodeId) ?? 99;
    buckets.push({
      nodeId,
      nodeLabel: label,
      level,
      evidence: sortEvidenceByQuality(evidence),
    });
  }

  buckets.sort((a, b) => {
    if (b.evidence.length !== a.evidence.length) return b.evidence.length - a.evidence.length;
    if (a.level !== b.level) return a.level - b.level;
    return a.nodeId.localeCompare(b.nodeId);
  });
  return buckets;
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
    { length: Math.min(Math.max(concurrency, 1), items.length) },
    () => worker(),
  );
  await Promise.all(workers);
  return out;
}

async function callOpenRouter(
  args: Args,
  systemPrompt: string,
  userPrompt: string,
): Promise<OpenRouterCallResult> {
  if (!env.openRouterKey) throw new Error("OPENROUTER_API_KEY missing");

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), args.timeoutSec * 1000);

  try {
    const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.openRouterKey}`,
        "Content-Type": "application/json",
        "X-Title": "Hunch AI Map Signals",
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
    const providerCost = extractProviderCostUsd(payload);
    const resolvedCost = resolveAiCost({
      inputTokens: promptTokens,
      outputTokens: completionTokens,
      priceInputPerM: args.priceInputPerM,
      priceOutputPerM: args.priceOutputPerM,
      providerCostUsd: providerCost.providerCostUsd,
      providerCostField: providerCost.providerCostField,
      providerCostUsdTicks: providerCost.providerCostUsdTicks,
    });

    return {
      content,
      usage: {
        promptTokens,
        completionTokens,
        totalTokens,
        reasoningTokens,
        providerCostUsd: providerCost.providerCostUsd,
        providerCostField: providerCost.providerCostField,
        providerCostUsdTicks: providerCost.providerCostUsdTicks,
      },
      cost: {
        inputCostUsd: resolvedCost.inputCostUsd,
        outputCostUsd: resolvedCost.outputCostUsd,
        tokenCostUsd: resolvedCost.tokenCostUsd,
        estimatedCostUsd: resolvedCost.estimatedCostUsd,
        chargedCostUsd: resolvedCost.chargedCostUsd,
        providerCostUsd: resolvedCost.providerCostUsd,
        providerCostField: resolvedCost.providerCostField,
        providerCostUsdTicks: resolvedCost.providerCostUsdTicks,
        costSource: resolvedCost.costSource,
      },
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function callOpenRouterEmbeddings(
  args: Args,
  texts: readonly string[],
): Promise<EmbeddingCallResult> {
  if (texts.length === 0) {
    return {
      vectors: [],
      usage: {
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
        reasoningTokens: 0,
        providerCostUsd: null,
        providerCostField: null,
        providerCostUsdTicks: null,
      },
      cost: {
        inputCostUsd: 0,
        outputCostUsd: 0,
        tokenCostUsd: 0,
        estimatedCostUsd: 0,
        chargedCostUsd: 0,
        providerCostUsd: null,
        providerCostField: null,
        providerCostUsdTicks: null,
        costSource: "estimated",
      },
    };
  }
  if (!env.openRouterKey) throw new Error("OPENROUTER_API_KEY missing");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), args.timeoutSec * 1000);
  try {
    const response = await fetch("https://openrouter.ai/api/v1/embeddings", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.openRouterKey}`,
        "Content-Type": "application/json",
        "X-Title": "Hunch AI Map Signals",
      },
      body: JSON.stringify({
        model: args.embedModel,
        input: texts,
        encoding_format: "float",
      }),
      signal: controller.signal,
    });
    if (!response.ok) {
      const body = await response.text();
      throw new Error(`OpenRouter embeddings failed: ${response.status} ${body}`);
    }
    const json = (await response.json()) as {
      data?: Array<{ embedding?: number[]; index?: number }>;
      usage?: {
        prompt_tokens?: unknown;
        completion_tokens?: unknown;
        total_tokens?: unknown;
        completion_tokens_details?: { reasoning_tokens?: unknown } | null;
      };
    };
    if (!Array.isArray(json.data)) throw new Error("OpenRouter embeddings missing data");
    const out: Array<number[] | null> = new Array(texts.length).fill(null);
    for (const item of json.data) {
      const idx = typeof item.index === "number" ? item.index : -1;
      if (idx < 0 || idx >= texts.length) continue;
      if (!Array.isArray(item.embedding)) continue;
      out[idx] = normalizeVector(item.embedding);
    }
    const promptTokens = safeNumber(json.usage?.prompt_tokens) ?? 0;
    const completionTokens = safeNumber(json.usage?.completion_tokens) ?? 0;
    const totalTokens =
      safeNumber(json.usage?.total_tokens) ?? promptTokens + completionTokens;
    const reasoningTokens =
      safeNumber(json.usage?.completion_tokens_details?.reasoning_tokens) ?? 0;
    const providerCost = extractProviderCostUsd(json);
    const resolvedCost = resolveAiCost({
      inputTokens: promptTokens,
      outputTokens: completionTokens,
      priceInputPerM: args.embedPriceInputPerM,
      priceOutputPerM: args.embedPriceOutputPerM,
      providerCostUsd: providerCost.providerCostUsd,
      providerCostField: providerCost.providerCostField,
      providerCostUsdTicks: providerCost.providerCostUsdTicks,
    });
    return {
      vectors: out,
      usage: {
        promptTokens,
        completionTokens,
        totalTokens,
        reasoningTokens,
        providerCostUsd: providerCost.providerCostUsd,
        providerCostField: providerCost.providerCostField,
        providerCostUsdTicks: providerCost.providerCostUsdTicks,
      },
      cost: {
        inputCostUsd: resolvedCost.inputCostUsd,
        outputCostUsd: resolvedCost.outputCostUsd,
        tokenCostUsd: resolvedCost.tokenCostUsd,
        estimatedCostUsd: resolvedCost.estimatedCostUsd,
        chargedCostUsd: resolvedCost.chargedCostUsd,
        providerCostUsd: resolvedCost.providerCostUsd,
        providerCostField: resolvedCost.providerCostField,
        providerCostUsdTicks: resolvedCost.providerCostUsdTicks,
        costSource: resolvedCost.costSource,
      },
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function toMarketCandidates(
  events: MarketMapEventSummary[],
  maxItems: number,
  evidence: MapSearchEvidence[],
  options: {
    includeSemanticAffinity: boolean;
    getEvidenceEmbeddings: (
      rows: EvidenceEmbeddingInput[],
    ) => Promise<Map<string, number[] | null>>;
    getMarketEmbeddings: (
      rows: MarketEmbeddingInput[],
    ) => Promise<Map<string, number[] | null>>;
  },
): Promise<MarketCandidate[]> {
  const out: MarketCandidate[] = [];
  const seen = new Set<string>();
  const emitted = new Set<string>();
  const marketRows: MarketEmbeddingInput[] = [];

  for (const event of events) {
    if (!event.representativeMarketId) continue;
    const marketId = event.representativeMarketId;
    if (seen.has(marketId)) continue;
    seen.add(marketId);
    marketRows.push({
      marketId,
      eventId: event.eventId,
      text: `${event.title} ${event.representativeMarketTitle ?? ""}`,
    });
  }

  const evidenceRows = evidence.map(item => ({
    evidenceId: item.id,
    text: `${item.headline} ${item.summary}`,
  }));

  const [evidenceEmbeddings, marketEmbeddings] = await Promise.all([
    options.includeSemanticAffinity
      ? options.getEvidenceEmbeddings(evidenceRows)
      : Promise.resolve(new Map<string, number[] | null>()),
    options.includeSemanticAffinity
      ? options.getMarketEmbeddings(marketRows)
      : Promise.resolve(new Map<string, number[] | null>()),
  ]);

  for (const event of events) {
    if (!event.representativeMarketId) continue;
    const marketId = event.representativeMarketId;
    if (emitted.has(marketId)) continue;
    emitted.add(marketId);

    const probs = inferYesNoProbabilities(event);
    const marketText = `${event.title} ${event.representativeMarketTitle ?? ""}`;
    const marketEmbedding =
      options.includeSemanticAffinity ? (marketEmbeddings.get(marketId) ?? null) : null;
    const affinityScore = options.includeSemanticAffinity
      ? evidenceMarketAffinityHybrid(
          evidence,
          marketText,
          marketEmbedding,
          evidenceEmbeddings,
        )
      : evidenceMarketAffinity(evidence, marketText);
    out.push({
      marketId,
      eventId: event.eventId,
      eventTitle: event.title,
      marketTitle: event.representativeMarketTitle ?? null,
      venue: event.venue,
      yesProb: probs.yesProb,
      noProb: probs.noProb,
      volume24h: numericOrZero(event.volume24h),
      liquidity: numericOrZero(event.liquidity),
      openInterest: numericOrZero(event.openInterest),
      score: numericOrZero(event.score),
      affinityScore,
      affinityRank: 0,
    });
  }

  out.sort(
    (a, b) =>
      b.affinityScore - a.affinityScore ||
      b.liquidity - a.liquidity ||
      b.openInterest - a.openInterest ||
      b.volume24h - a.volume24h ||
      b.score - a.score ||
      a.marketId.localeCompare(b.marketId),
  );

  const sliced = out.slice(0, Math.max(maxItems, 1));
  for (let i = 0; i < sliced.length; i += 1) {
    sliced[i].affinityRank = i + 1;
  }
  return sliced;
}

function summarizeDeterministic(
  bucket: NodeBucket,
  candidateMarkets: MarketCandidate[],
  args: Args,
  runId: string,
): SignalCandidate {
  const evidence = bucket.evidence.slice(0, args.maxEvidencePerNode);
  const evidenceCount = evidence.length;
  const confirmedCount = evidence.filter(item => item.confirmation === "confirmed").length;
  const distinctDomains = new Set(evidence.map(item => item.sourceDomain)).size;

  const evidenceQuality = normalizeEvidenceQuality(
    evidenceCount,
    confirmedCount,
    distinctDomains,
    args.minEvidence,
    args.minConfirmed,
    args.minDistinctDomains,
  );

  const decision: SignalDecision =
    evidenceCount >= args.minEvidence &&
    confirmedCount >= args.minConfirmed &&
    distinctDomains >= args.minDistinctDomains &&
    candidateMarkets.length > 0
      ? "publish_candidate"
      : evidenceCount > 0
        ? "context_only"
        : "skip";

  const topMarket = candidateMarkets[0] ?? null;
  const bestMarketAffinity = topMarket?.affinityScore ?? null;
  const topEvidence = evidence[0] ?? null;
  const reasonCodes: string[] = [];

  if (evidenceCount < args.minEvidence) reasonCodes.push("LOW_EVIDENCE");
  if (confirmedCount < args.minConfirmed) reasonCodes.push("LOW_CONFIRMED");
  if (distinctDomains < args.minDistinctDomains) reasonCodes.push("LOW_DOMAIN_DIVERSITY");
  if (candidateMarkets.length === 0) reasonCodes.push("NO_MARKET_CANDIDATES");
  if (reasonCodes.length === 0) reasonCodes.push("PASS");

  return {
    signalId: buildSignalId(runId, bucket.nodeId),
    runId,
    nodeId: bucket.nodeId,
    nodeLabel: bucket.nodeLabel,
    level: bucket.level,
    decision,
    signalType: "update",
    direction: "mixed",
    confidence: Number(evidenceQuality.toFixed(4)),
    headline: topEvidence
      ? `${bucket.nodeLabel}: ${topEvidence.headline}`.slice(0, 140)
      : `${bucket.nodeLabel}: context update`.slice(0, 140),
    summary: topEvidence?.summary ?? `${bucket.nodeLabel}: no model call (dry-run).`,
    rationale: "deterministic dry-run fallback",
    targetMarketId: decision === "publish_candidate" ? (topMarket?.marketId ?? null) : null,
    targetEventId: decision === "publish_candidate" ? (topMarket?.eventId ?? null) : null,
    targetMarketTitle:
      decision === "publish_candidate" ? (topMarket?.marketTitle ?? null) : null,
    targetEventTitle:
      decision === "publish_candidate" ? (topMarket?.eventTitle ?? null) : null,
    targetVenue: decision === "publish_candidate" ? (topMarket?.venue ?? null) : null,
    reasonCodes,
    metrics: {
      evidenceCount,
      confirmedCount,
      distinctDomains,
      candidateMarkets: candidateMarkets.length,
      selectedMarketAffinity: topMarket?.affinityScore ?? null,
      bestMarketAffinity,
    },
    evidenceRefs: evidence.slice(0, 6).map(item => ({
      evidenceId: item.id,
      headline: item.headline,
      sourceDomain: item.sourceDomain,
      publishedAt: item.publishedAt,
      confirmation: item.confirmation,
      sourceTier: item.sourceTier,
    })),
    modelOutput: null,
    usage: {
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      reasoningTokens: 0,
      providerCostUsd: null,
      providerCostField: null,
      providerCostUsdTicks: null,
    },
    tokenCostUsd: 0,
    estimatedCostUsd: 0,
    chargedCostUsd: 0,
    providerCostUsd: null,
    providerCostField: null,
    providerCostUsdTicks: null,
    costSource: "estimated",
    error: null,
    modelStatus: "NONE",
    downgradedFromPublish: false,
    schemaRepairAttempted: false,
    schemaRepairSuccess: false,
  };
}

function mapStatusToDecision(status: MapSignalsAgentOutputV2["status"]): SignalDecision {
  if (status === "PUBLISH") return "publish_candidate";
  if (status === "CONTEXT") return "context_only";
  return "skip";
}

async function evaluateNodeWithModel(params: {
  args: Args;
  runId: string;
  bucket: NodeBucket;
  candidateMarkets: MarketCandidate[];
}): Promise<SignalCandidate> {
  const { args, runId, bucket, candidateMarkets } = params;
  const evidence = bucket.evidence.slice(0, args.maxEvidencePerNode);
  const evidenceCount = evidence.length;
  const confirmedCount = evidence.filter(item => item.confirmation === "confirmed").length;
  const distinctDomains = new Set(evidence.map(item => item.sourceDomain)).size;

  const baseReasonCodes: string[] = [];
  if (evidenceCount < args.minEvidence) baseReasonCodes.push("LOW_EVIDENCE");
  if (confirmedCount < args.minConfirmed) baseReasonCodes.push("LOW_CONFIRMED");
  if (distinctDomains < args.minDistinctDomains) baseReasonCodes.push("LOW_DOMAIN_DIVERSITY");
  if (candidateMarkets.length === 0) baseReasonCodes.push("NO_MARKET_CANDIDATES");

  const signalId = buildSignalId(runId, bucket.nodeId);
  const baseRefs = evidence.slice(0, 6).map(item => ({
    evidenceId: item.id,
    headline: item.headline,
    sourceDomain: item.sourceDomain,
    publishedAt: item.publishedAt,
    confirmation: item.confirmation,
    sourceTier: item.sourceTier,
  }));

  const evidenceQuality = normalizeEvidenceQuality(
    evidenceCount,
    confirmedCount,
    distinctDomains,
    args.minEvidence,
    args.minConfirmed,
    args.minDistinctDomains,
  );

  if (baseReasonCodes.includes("NO_MARKET_CANDIDATES") || evidence.length === 0) {
    return {
      signalId,
      runId,
      nodeId: bucket.nodeId,
      nodeLabel: bucket.nodeLabel,
      level: bucket.level,
      decision: evidence.length === 0 ? "skip" : "context_only",
      signalType: "update",
      direction: "mixed",
      confidence: Number((evidenceQuality * 0.9).toFixed(4)),
      headline: `${bucket.nodeLabel}: insufficient target market candidates`.slice(0, 140),
      summary: evidence[0]?.summary ?? "No market candidates available for model targeting.",
      rationale: "gated before model call",
      targetMarketId: null,
      targetEventId: null,
      targetMarketTitle: null,
      targetEventTitle: null,
      targetVenue: null,
      reasonCodes: baseReasonCodes,
      metrics: {
        evidenceCount,
        confirmedCount,
        distinctDomains,
        candidateMarkets: candidateMarkets.length,
        selectedMarketAffinity: null,
        bestMarketAffinity: candidateMarkets[0]?.affinityScore ?? null,
      },
      evidenceRefs: baseRefs,
      modelOutput: null,
      usage: {
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
        reasoningTokens: 0,
        providerCostUsd: null,
        providerCostField: null,
        providerCostUsdTicks: null,
      },
      tokenCostUsd: 0,
      estimatedCostUsd: 0,
      chargedCostUsd: 0,
      providerCostUsd: null,
      providerCostField: null,
      providerCostUsdTicks: null,
      costSource: "estimated",
      error: null,
      modelStatus: "NONE",
      downgradedFromPublish: false,
      schemaRepairAttempted: false,
      schemaRepairSuccess: false,
    };
  }

  const systemPrompt = buildMapSignalsSystemPromptV2();
  const userPrompt = buildMapSignalsUserPromptV2({
    runId,
    nodeId: bucket.nodeId,
    nodeLabel: bucket.nodeLabel,
    level: bucket.level,
    evidenceCount,
    confirmedCount,
    evidence: evidence.map(item => ({
      id: item.id,
      headline: item.headline,
      summary: item.summary,
      sourceDomain: item.sourceDomain,
      publishedAt: item.publishedAt,
      confirmation: item.confirmation,
      relevance: item.relevance,
      confidence: item.confidence,
    })),
    candidateMarkets,
  });

  let parsed: MapSignalsAgentOutputV2;
  const usage: OpenRouterUsage = {
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    reasoningTokens: 0,
    providerCostUsd: null,
    providerCostField: null,
    providerCostUsdTicks: null,
  };
  let estimatedCostUsd = 0;
  let chargedCostUsd = 0;
  let providerCostUsdTotal = 0;
  let providerCostField: string | null = null;
  let providerCostUsdTicksTotal: number | null = null;
  let providerReportedCostCalls = 0;
  let schemaRepairAttempted = false;
  let schemaRepairSuccess = false;
  try {
    const addCallCost = (result: OpenRouterCallResult): void => {
      usage.promptTokens += result.usage.promptTokens;
      usage.completionTokens += result.usage.completionTokens;
      usage.totalTokens += result.usage.totalTokens;
      usage.reasoningTokens += result.usage.reasoningTokens;
      estimatedCostUsd += result.cost.estimatedCostUsd;
      chargedCostUsd += result.cost.chargedCostUsd;
      if (result.cost.providerCostUsd != null) {
        providerCostUsdTotal += result.cost.providerCostUsd;
        providerReportedCostCalls += 1;
      }
      if (result.cost.providerCostField && !providerCostField) {
        providerCostField = result.cost.providerCostField;
      }
      if (result.cost.providerCostUsdTicks != null) {
        providerCostUsdTicksTotal =
          (providerCostUsdTicksTotal ?? 0) + result.cost.providerCostUsdTicks;
      }
    };

    const raw = await callOpenRouter(args, systemPrompt, userPrompt);
    addCallCost(raw);
    const firstParsed = parsePossibleJson(raw.content);
    try {
      parsed = parseMapSignalsAgentOutputV2(firstParsed);
    } catch (parseError) {
      if (shouldAttemptSummaryTruncate(parseError)) {
        const truncated = truncateSummaryInPayload(firstParsed, 320);
        parsed = parseMapSignalsAgentOutputV2(truncated);
      } else {
        schemaRepairAttempted = true;
        const repairRaw = await callOpenRouter(
          args,
          systemPrompt,
          buildRepairPrompt(raw.content, toParseErrorMessage(parseError)),
        );
        addCallCost(repairRaw);
        const repairedParsed = parsePossibleJson(repairRaw.content);
        try {
          parsed = parseMapSignalsAgentOutputV2(repairedParsed);
          schemaRepairSuccess = true;
        } catch (repairParseError) {
          if (shouldAttemptSummaryTruncate(repairParseError)) {
            const truncated = truncateSummaryInPayload(repairedParsed, 320);
            parsed = parseMapSignalsAgentOutputV2(truncated);
            schemaRepairSuccess = true;
          } else {
            throw repairParseError;
          }
        }
      }
    }
    usage.providerCostUsd =
      providerReportedCostCalls > 0
        ? Number(providerCostUsdTotal.toFixed(6))
        : null;
    usage.providerCostField = providerCostField;
    usage.providerCostUsdTicks = providerCostUsdTicksTotal;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const providerCostUsd =
      providerReportedCostCalls > 0
        ? Number(providerCostUsdTotal.toFixed(6))
        : null;
    const resolvedCostSource: CostSource =
      providerReportedCostCalls > 0 ? "provider_reported" : "estimated";
    if (providerCostUsd != null && usage.providerCostUsd == null) {
      usage.providerCostUsd = providerCostUsd;
      usage.providerCostField = providerCostField;
      usage.providerCostUsdTicks = providerCostUsdTicksTotal;
    }
    return {
      signalId,
      runId,
      nodeId: bucket.nodeId,
      nodeLabel: bucket.nodeLabel,
      level: bucket.level,
      decision: "context_only",
      signalType: "update",
      direction: "mixed",
      confidence: Number((evidenceQuality * 0.75).toFixed(4)),
      headline: `${bucket.nodeLabel}: model error fallback`.slice(0, 140),
      summary: evidence[0]?.summary ?? "Model error with no fallback summary.",
      rationale: "openrouter/model parse failure",
      targetMarketId: null,
      targetEventId: null,
      targetMarketTitle: null,
      targetEventTitle: null,
      targetVenue: null,
      reasonCodes: [...baseReasonCodes, "MODEL_ERROR"],
      metrics: {
        evidenceCount,
        confirmedCount,
        distinctDomains,
        candidateMarkets: candidateMarkets.length,
        selectedMarketAffinity: null,
        bestMarketAffinity: candidateMarkets[0]?.affinityScore ?? null,
      },
      evidenceRefs: baseRefs,
      modelOutput: null,
      usage,
      tokenCostUsd: Number(estimatedCostUsd.toFixed(6)),
      estimatedCostUsd: Number(estimatedCostUsd.toFixed(6)),
      chargedCostUsd: Number(chargedCostUsd.toFixed(6)),
      providerCostUsd,
      providerCostField,
      providerCostUsdTicks: providerCostUsdTicksTotal,
      costSource: resolvedCostSource,
      error: message,
      modelStatus: "NONE",
      downgradedFromPublish: false,
      schemaRepairAttempted,
      schemaRepairSuccess,
    };
  }

  const allowedMarketIds = new Set(candidateMarkets.map(item => item.marketId));
  const marketById = new Map(candidateMarkets.map(item => [item.marketId, item]));
  const evidenceById = new Map(evidence.map(item => [item.id, item]));
  const selectedEvidenceIds = new Set(evidence.map(item => item.id));
  const modelReasonCodes = [...baseReasonCodes];

  const targetMarketId = parsed.target_market_id;
  const targetEventId = parsed.target_event_id;
  const marketIsValid = targetMarketId != null && allowedMarketIds.has(targetMarketId);
  const selectedMarket = targetMarketId ? marketById.get(targetMarketId) ?? null : null;
  const selectedMarketAffinity = selectedMarket?.affinityScore ?? null;
  const bestMarketAffinity = candidateMarkets[0]?.affinityScore ?? null;

  if (parsed.status === "PUBLISH" && !marketIsValid) {
    pushUniqueReason(modelReasonCodes, "INVALID_TARGET_MARKET");
  }

  const filteredEvidenceIds = parsed.evidence_ids.filter(id => selectedEvidenceIds.has(id));
  const selectedEvidence = filteredEvidenceIds
    .map(id => evidenceById.get(id))
    .filter((item): item is MapSearchEvidence => item != null);
  if (filteredEvidenceIds.length === 0) {
    pushUniqueReason(modelReasonCodes, "NO_VALID_EVIDENCE_IDS");
  }

  const tokenCostUsd = estimatedCostUsd;
  const costSource: CostSource =
    providerReportedCostCalls > 0 ? "provider_reported" : "estimated";

  let decision = mapStatusToDecision(parsed.status);
  const originalModelDecision = decision;
  if (decision === "publish_candidate") {
    if (!marketIsValid) decision = "context_only";
    if (evidenceCount < args.minEvidence) decision = "context_only";
    if (confirmedCount < args.minConfirmed) decision = "context_only";
    if (distinctDomains < args.minDistinctDomains) decision = "context_only";
    if (filteredEvidenceIds.length < args.minEvidenceIdsForPublish) {
      decision = "context_only";
      pushUniqueReason(modelReasonCodes, "INSUFFICIENT_EVIDENCE_LINKS");
    }
    if (selectedMarketAffinity == null || selectedMarketAffinity < args.minAffinityForPublish) {
      decision = "context_only";
      pushUniqueReason(modelReasonCodes, "LOW_MARKET_AFFINITY");
    }
    if (
      hasTargetIntentMismatch(
        selectedEvidence,
        selectedMarket?.eventTitle ?? null,
        selectedMarket?.marketTitle ?? null,
      )
    ) {
      decision = "context_only";
      pushUniqueReason(modelReasonCodes, "TARGET_INTENT_MISMATCH");
    }
    if (
      isCircularSourceEvidence(
        selectedEvidence,
        selectedMarket?.eventTitle ?? null,
        selectedMarket?.marketTitle ?? null,
      )
    ) {
      decision = "context_only";
      pushUniqueReason(modelReasonCodes, "CIRCULAR_SOURCE");
    }
  }

  const downgradedFromPublish =
    originalModelDecision === "publish_candidate" && decision !== "publish_candidate";
  if (downgradedFromPublish && modelReasonCodes.length === 0) {
    pushUniqueReason(modelReasonCodes, "DOWNGRADED_POST_GATES");
  }

  const confidence = clamp01(
    parsed.confidence * (0.7 + 0.3 * evidenceQuality) * (decision === "publish_candidate" ? 1 : 0.9),
  );

  const evidenceRefMap = new Map(baseRefs.map(item => [item.evidenceId, item]));
  const selectedRefs = filteredEvidenceIds
    .map(id => evidenceRefMap.get(id))
    .filter((item): item is NonNullable<typeof item> => item != null)
    .slice(0, 6);

  return {
    signalId,
    runId,
    nodeId: bucket.nodeId,
    nodeLabel: bucket.nodeLabel,
    level: bucket.level,
    decision,
    signalType: parsed.signal_type,
    direction: parsed.direction,
    confidence: Number(confidence.toFixed(4)),
    headline: parsed.headline,
    summary: parsed.summary,
    rationale: parsed.rationale,
    targetMarketId: decision === "publish_candidate" ? targetMarketId : null,
    targetEventId: decision === "publish_candidate" ? targetEventId : null,
    targetMarketTitle:
      decision === "publish_candidate" ? (selectedMarket?.marketTitle ?? null) : null,
    targetEventTitle:
      decision === "publish_candidate" ? (selectedMarket?.eventTitle ?? null) : null,
    targetVenue: decision === "publish_candidate" ? (selectedMarket?.venue ?? null) : null,
    reasonCodes: modelReasonCodes.length > 0 ? modelReasonCodes : ["PASS"],
    metrics: {
      evidenceCount,
      confirmedCount,
      distinctDomains,
      candidateMarkets: candidateMarkets.length,
      selectedMarketAffinity,
      bestMarketAffinity,
    },
    evidenceRefs: selectedRefs.length > 0 ? selectedRefs : baseRefs,
    modelOutput: parsed,
    usage,
    tokenCostUsd: Number(tokenCostUsd.toFixed(6)),
    estimatedCostUsd: Number(estimatedCostUsd.toFixed(6)),
    chargedCostUsd: Number(chargedCostUsd.toFixed(6)),
    providerCostUsd:
      usage.providerCostUsd == null ? null : Number(usage.providerCostUsd.toFixed(6)),
    providerCostField: usage.providerCostField,
    providerCostUsdTicks: usage.providerCostUsdTicks,
    costSource,
    error: null,
    modelStatus: parsed.status,
    downgradedFromPublish,
    schemaRepairAttempted,
    schemaRepairSuccess,
  };
}

function buildMarkdown(
  input: MapSearchArtifactFile,
  args: Args,
  signals: SignalCandidate[],
  durationMs: number,
  embeddingTotals: {
    calls: number;
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    estimatedCostUsd: number;
    chargedCostUsd: number;
    providerReportedCostUsd: number;
    providerReportedCostCalls: number;
  },
): string {
  const modelPublishCount = signals.filter(
    item => item.modelStatus === "PUBLISH",
  ).length;
  const downgradedPublishCount = signals.filter(
    item => item.downgradedFromPublish,
  ).length;
  const downgradeReasonCounts = new Map<string, number>();
  for (const signal of signals) {
    if (!signal.downgradedFromPublish) continue;
    for (const code of signal.reasonCodes) {
      downgradeReasonCounts.set(code, (downgradeReasonCounts.get(code) ?? 0) + 1);
    }
  }

  const lines: string[] = [];
  lines.push("# AI Map Signals Report");
  lines.push("");
  lines.push(`- run_id: \`${input.run.runId}\``);
  lines.push(`- map_generated_at: ${input.run.mapGeneratedAt}`);
  lines.push(`- source_calls: ${input.totals.callsExecuted}`);
  lines.push(`- source_evidence: ${input.totals.evidenceTotal}`);
  lines.push(`- source_spent_usd_estimated: $${input.totals.estimatedTotalCostUsd.toFixed(6)}`);
  lines.push(
    `- source_spent_usd_charged: $${(input.totals.chargedTotalCostUsd ?? input.totals.estimatedTotalCostUsd).toFixed(6)}`,
  );
  lines.push(`- model: ${args.model}`);
  lines.push(`- generated_signals: ${signals.length}`);
  lines.push(`- publish_candidates: ${signals.filter(item => item.decision === "publish_candidate").length}`);
  lines.push(`- context_only: ${signals.filter(item => item.decision === "context_only").length}`);
  lines.push(`- skipped: ${signals.filter(item => item.decision === "skip").length}`);
  lines.push(`- model_publish_count: ${modelPublishCount}`);
  lines.push(`- downgraded_publish_count: ${downgradedPublishCount}`);
  const modelEstimatedCostUsd = signals.reduce(
    (sum, item) => sum + item.estimatedCostUsd,
    0,
  );
  const modelChargedCostUsd = signals.reduce(
    (sum, item) => sum + item.chargedCostUsd,
    0,
  );
  const modelProviderReportedCostCalls = signals.filter(
    item => item.providerCostUsd != null,
  ).length;
  const modelProviderReportedCostUsd = signals.reduce(
    (sum, item) => sum + (item.providerCostUsd ?? 0),
    0,
  );
  lines.push(`- model_cost_usd_estimated: $${modelEstimatedCostUsd.toFixed(6)}`);
  lines.push(`- model_cost_usd_charged: $${modelChargedCostUsd.toFixed(6)}`);
  lines.push(`- model_provider_reported_calls: ${modelProviderReportedCostCalls}`);
  lines.push(`- model_provider_reported_cost_usd: $${modelProviderReportedCostUsd.toFixed(6)}`);
  lines.push(`- embed_calls: ${embeddingTotals.calls}`);
  lines.push(`- embed_tokens_prompt: ${embeddingTotals.promptTokens}`);
  lines.push(`- embed_tokens_completion: ${embeddingTotals.completionTokens}`);
  lines.push(`- embed_tokens_total: ${embeddingTotals.totalTokens}`);
  lines.push(`- embed_cost_usd_estimated: $${embeddingTotals.estimatedCostUsd.toFixed(6)}`);
  lines.push(`- embed_cost_usd_charged: $${embeddingTotals.chargedCostUsd.toFixed(6)}`);
  lines.push(`- embed_provider_reported_calls: ${embeddingTotals.providerReportedCostCalls}`);
  lines.push(
    `- embed_provider_reported_cost_usd: $${embeddingTotals.providerReportedCostUsd.toFixed(6)}`,
  );
  lines.push(
    `- total_cost_usd_estimated: $${(modelEstimatedCostUsd + embeddingTotals.estimatedCostUsd).toFixed(6)}`,
  );
  lines.push(
    `- total_cost_usd_charged: $${(modelChargedCostUsd + embeddingTotals.chargedCostUsd).toFixed(6)}`,
  );
  lines.push(`- duration_ms: ${durationMs}`);
  if (downgradeReasonCounts.size > 0) {
    lines.push(
      `- downgrade_reason_counts: ${Array.from(downgradeReasonCounts.entries())
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .map(([key, value]) => `${key}=${value}`)
        .join(", ")}`,
    );
  }
  lines.push("");
  lines.push("## Signals");
  lines.push("");

  for (const signal of signals) {
    lines.push(
      `- ${signal.nodeLabel} | decision=${signal.decision} | type=${signal.signalType} | dir=${signal.direction} | conf=${signal.confidence.toFixed(3)} | evidence=${signal.metrics.evidenceCount} | confirmed=${signal.metrics.confirmedCount} | domains=${signal.metrics.distinctDomains} | target=${signal.targetMarketId ?? "-"}`,
    );
  }

  lines.push("");
  lines.push("## Top Candidates");
  lines.push("");

  for (const signal of signals.slice(0, 8)) {
    lines.push(`### ${signal.nodeLabel}`);
    lines.push(`- headline: ${signal.headline}`);
    lines.push(`- summary: ${signal.summary}`);
    lines.push(`- rationale: ${signal.rationale}`);
    lines.push(`- decision: ${signal.decision}`);
    lines.push(`- signal_type: ${signal.signalType}`);
    lines.push(`- direction: ${signal.direction}`);
    lines.push(`- target_market_id: ${signal.targetMarketId ?? "-"}`);
    lines.push(`- target_event_id: ${signal.targetEventId ?? "-"}`);
    lines.push(`- target_market_name: ${signal.targetMarketTitle ?? "-"}`);
    lines.push(`- target_event_name: ${signal.targetEventTitle ?? "-"}`);
    lines.push(`- target_venue: ${signal.targetVenue ?? "-"}`);
    lines.push(`- reason_codes: ${signal.reasonCodes.join(", ")}`);
    lines.push(`- model_status: ${signal.modelStatus}`);
    lines.push(`- downgraded_from_publish: ${signal.downgradedFromPublish}`);
    lines.push(
      `- selected_market_affinity: ${signal.metrics.selectedMarketAffinity == null ? "-" : signal.metrics.selectedMarketAffinity.toFixed(6)}`,
    );
    lines.push(
      `- best_market_affinity: ${signal.metrics.bestMarketAffinity == null ? "-" : signal.metrics.bestMarketAffinity.toFixed(6)}`,
    );
    lines.push(`- token_cost_usd_estimated: $${signal.tokenCostUsd.toFixed(6)}`);
    lines.push(`- cost_usd_charged: $${signal.chargedCostUsd.toFixed(6)}`);
    lines.push(`- cost_source: ${signal.costSource}`);
    lines.push("- evidence:");
    for (const ref of signal.evidenceRefs.slice(0, 4)) {
      lines.push(
        `  - ${ref.headline} (${ref.sourceDomain}, ${ref.confirmation}, ${ref.publishedAt ?? "-"})`,
      );
    }
    lines.push("");
  }

  return lines.join("\n");
}

export async function runMapSignals(
  argv: string[] = process.argv.slice(2),
  context: Partial<MapSignalsRunContext> = {},
): Promise<void> {
  activeRunContext = { ...DEFAULT_RUN_CONTEXT, ...context };
  if (hasFlag(argv, "--help") || hasFlag(argv, "-h")) usage(activeRunContext, 0);
  const args = resolveArgs(argv);

  const input = await readInput(args.inputPath);
  const runId = input.run.runId;

  const redis = createRedisClient({ url: env.redisUrl });
  await ensureRedis(redis, { waitForReady: true, logLabel: activeRunContext.scriptTag });

  try {
    const startedAt = Date.now();

    console.log(`${logPrefix()} start`, {
      runId,
      mapGeneratedAt: input.run.mapGeneratedAt,
      model: args.model,
      embedModel: args.embedModel,
      maxNodes: args.maxNodes,
      maxSignals: args.maxSignals,
      maxEvidencePerNode: args.maxEvidencePerNode,
      maxMarketsPerNode: args.maxMarketsPerNode,
      minEvidence: args.minEvidence,
      minConfirmed: args.minConfirmed,
      minDistinctDomains: args.minDistinctDomains,
      minEvidenceIdsForPublish: args.minEvidenceIdsForPublish,
      minAffinityForPublish: args.minAffinityForPublish,
      concurrency: args.concurrency,
      maxOutputTokens: args.maxOutputTokens,
      timeoutSec: args.timeoutSec,
      priceInputPerM: args.priceInputPerM,
      priceOutputPerM: args.priceOutputPerM,
      embedPriceInputPerM: args.embedPriceInputPerM,
      embedPriceOutputPerM: args.embedPriceOutputPerM,
      dryRun: args.dryRun,
    });

    const [metaRaw, nodesRaw] = await Promise.all([
      redis.get(marketMapRunMetaKey(runId)),
      redis.get(marketMapRunNodesGlobalKey(runId)),
    ]);

    const meta = safeJsonParse<MarketMapMeta>(metaRaw);
    const nodes = safeJsonParse<MarketMapNode[]>(nodesRaw) ?? [];
    if (!meta) {
      throw new Error(`missing_market_map_meta_for_run:${runId}`);
    }

    const nodeLabelById = new Map(nodes.map(node => [node.id, node.labelAi ?? node.labelRepresentative ?? node.label]));
    const nodeLevelById = new Map(nodes.map(node => [node.id, node.level]));

    const callLabelByNode = new Map(input.calls.map(call => [call.nodeId, call.nodeLabel]));
    const callLevelByNode = new Map(input.calls.map(call => [call.nodeId, call.level]));
    for (const [nodeId, label] of callLabelByNode) {
      if (!nodeLabelById.has(nodeId)) nodeLabelById.set(nodeId, label);
    }
    for (const [nodeId, level] of callLevelByNode) {
      if (!nodeLevelById.has(nodeId)) nodeLevelById.set(nodeId, level);
    }

    const buckets = extractNodeBuckets(input, nodeLabelById, nodeLevelById).slice(0, args.maxNodes);
    console.log(`${logPrefix()} plan`, {
      bucketCount: buckets.length,
      sourceEvidenceTotal: input.evidence.length,
    });

    const nodeEventsCache = new Map<string, MarketMapEventSummary[]>();
    const evidenceEmbeddingCache = new Map<string, number[] | null>();
    const marketEmbeddingCache = new Map<string, number[] | null>();
    const eventEmbeddingCache = new Map<string, number[] | null>();
    const textEmbeddingCache = new Map<string, number[] | null>();
    const marketTitleCache = new Map<string, string | null>();
    const embeddingCostTotals = {
      calls: 0,
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      estimatedCostUsd: 0,
      chargedCostUsd: 0,
      providerReportedCostUsd: 0,
      providerReportedCostCalls: 0,
    };
    function accountEmbeddingCost(result: EmbeddingCallResult): void {
      embeddingCostTotals.calls += 1;
      embeddingCostTotals.promptTokens += result.usage.promptTokens;
      embeddingCostTotals.completionTokens += result.usage.completionTokens;
      embeddingCostTotals.totalTokens += result.usage.totalTokens;
      embeddingCostTotals.estimatedCostUsd += result.cost.estimatedCostUsd;
      embeddingCostTotals.chargedCostUsd += result.cost.chargedCostUsd;
      if (result.cost.providerCostUsd != null) {
        embeddingCostTotals.providerReportedCostUsd += result.cost.providerCostUsd;
        embeddingCostTotals.providerReportedCostCalls += 1;
      }
    }
    async function getNodeEvents(nodeId: string): Promise<MarketMapEventSummary[]> {
      if (nodeEventsCache.has(nodeId)) return nodeEventsCache.get(nodeId) ?? [];
      const raw = await redis.get(marketMapRunNodeEventsKey(runId, nodeId));
      const rows = safeJsonParse<MarketMapEventSummary[]>(raw) ?? [];
      const sorted = rows
        .slice()
        .sort((a, b) => numericOrZero(b.score) - numericOrZero(a.score));
      nodeEventsCache.set(nodeId, sorted);
      return sorted;
    }

    async function getEventEmbedding(eventId: string): Promise<number[] | null> {
      if (eventEmbeddingCache.has(eventId)) return eventEmbeddingCache.get(eventId) ?? null;
      const raw = await redis.hGet(`ai:embed:event:${eventId}`, "embedding");
      const vec = Buffer.isBuffer(raw) ? parseEmbeddingBuffer(raw) : null;
      eventEmbeddingCache.set(eventId, vec);
      return vec;
    }

    async function getMarketEmbedding(
      marketId: string,
      eventId: string,
      fallbackText: string,
    ): Promise<number[] | null> {
      if (marketEmbeddingCache.has(marketId)) return marketEmbeddingCache.get(marketId) ?? null;

      let vec: number[] | null = null;
      const raw = await redis.hGet(`ai:embed:market:${marketId}`, "embedding");
      if (Buffer.isBuffer(raw)) {
        vec = parseEmbeddingBuffer(raw);
      }
      if (!vec && eventId) {
        vec = await getEventEmbedding(eventId);
      }
      if (!vec) {
        const textHash = createHash("sha1").update(fallbackText).digest("hex");
        if (textEmbeddingCache.has(textHash)) {
          vec = textEmbeddingCache.get(textHash) ?? null;
        } else {
          try {
            const result = await callOpenRouterEmbeddings(args, [fallbackText]);
            accountEmbeddingCost(result);
            vec = result.vectors[0] ?? null;
          } catch {
            vec = null;
          }
          textEmbeddingCache.set(textHash, vec);
        }
      }

      marketEmbeddingCache.set(marketId, vec);
      return vec;
    }

    async function getEvidenceEmbeddings(
      rows: EvidenceEmbeddingInput[],
    ): Promise<Map<string, number[] | null>> {
      const out = new Map<string, number[] | null>();
      const missing: EvidenceEmbeddingInput[] = [];
      for (const row of rows) {
        if (evidenceEmbeddingCache.has(row.evidenceId)) {
          out.set(row.evidenceId, evidenceEmbeddingCache.get(row.evidenceId) ?? null);
        } else {
          missing.push(row);
        }
      }
      if (missing.length > 0) {
        try {
          const result = await callOpenRouterEmbeddings(
            args,
            missing.map(item => item.text),
          );
          accountEmbeddingCost(result);
          for (let i = 0; i < missing.length; i += 1) {
            const id = missing[i].evidenceId;
            const vec = result.vectors[i] ?? null;
            evidenceEmbeddingCache.set(id, vec);
            out.set(id, vec);
          }
        } catch {
          for (const row of missing) {
            evidenceEmbeddingCache.set(row.evidenceId, null);
            out.set(row.evidenceId, null);
          }
        }
      }
      return out;
    }

    async function getMarketEmbeddings(
      rows: MarketEmbeddingInput[],
    ): Promise<Map<string, number[] | null>> {
      const out = new Map<string, number[] | null>();
      await Promise.all(
        rows.map(async row => {
          const vec = await getMarketEmbedding(row.marketId, row.eventId, row.text);
          out.set(row.marketId, vec);
        }),
      );
      return out;
    }

    async function enrichCandidateMarketTitles(
      candidateMarkets: MarketCandidate[],
    ): Promise<void> {
      const missingIds: string[] = [];
      for (const market of candidateMarkets) {
        const direct = market.marketTitle?.trim() ?? "";
        if (direct) {
          market.marketTitle = direct;
          marketTitleCache.set(market.marketId, direct);
          continue;
        }
        if (marketTitleCache.has(market.marketId)) {
          market.marketTitle = marketTitleCache.get(market.marketId) ?? null;
          continue;
        }
        missingIds.push(market.marketId);
      }
      if (missingIds.length === 0) return;

      const uniqueMissing = Array.from(new Set(missingIds));
      try {
        const { rows } = await pool.query<{ id: string; title: string | null }>(
          `
            select id, title
            from unified_markets
            where id = any($1::text[])
          `,
          [uniqueMissing],
        );
        const returned = new Set<string>();
        for (const row of rows) {
          const title = row.title?.trim() || null;
          marketTitleCache.set(row.id, title);
          returned.add(row.id);
        }
        for (const marketId of uniqueMissing) {
          if (!returned.has(marketId)) {
            marketTitleCache.set(marketId, null);
          }
        }
      } catch (error) {
        console.warn(`${logPrefix()} market title enrichment failed`, {
          error: error instanceof Error ? error.message : String(error),
          marketCount: uniqueMissing.length,
        });
      }

      for (const market of candidateMarkets) {
        if (market.marketTitle) continue;
        market.marketTitle = marketTitleCache.get(market.marketId) ?? null;
      }
    }

    let inFlight = 0;
    let completed = 0;
    let runningCostUsd = 0;
    let runningPublish = 0;
    let runningContext = 0;
    let runningSkip = 0;

    const signals = await runParallel(buckets, args.concurrency, async (bucket, idx) => {
      const callIndex = idx + 1;
      inFlight += 1;
      console.log(
        `${logPrefix()} call_start #${callIndex} node="${bucket.nodeLabel}" level=${bucket.level} queue=${Math.max(buckets.length - callIndex, 0)} evidence=${bucket.evidence.length} in_flight=${inFlight}`,
      );

      const events = await getNodeEvents(bucket.nodeId);
      const candidateMarkets = await toMarketCandidates(
        events,
        args.maxMarketsPerNode,
        bucket.evidence.slice(0, args.maxEvidencePerNode),
        {
          includeSemanticAffinity: !args.dryRun,
          getEvidenceEmbeddings,
          getMarketEmbeddings,
        },
      );
      await enrichCandidateMarketTitles(candidateMarkets);

      if (args.verbose) {
        console.log(
          `${logPrefix()} call_ctx #${callIndex} candidates=${candidateMarkets.length} first_market=${candidateMarkets[0]?.marketId ?? "-"}`,
        );
      }

      let signal: SignalCandidate;
      if (args.dryRun) {
        signal = summarizeDeterministic(bucket, candidateMarkets, args, runId);
      } else {
        signal = await evaluateNodeWithModel({
          args,
          runId,
          bucket,
          candidateMarkets,
        });
      }

      completed += 1;
      inFlight = Math.max(0, inFlight - 1);
      runningCostUsd += signal.chargedCostUsd;
      if (signal.decision === "publish_candidate") runningPublish += 1;
      else if (signal.decision === "context_only") runningContext += 1;
      else runningSkip += 1;

      const parseStatus = args.dryRun
        ? "dry_run"
        : signal.modelOutput
          ? "valid"
          : "invalid";
      console.log(
        `${logPrefix()} call_done #${callIndex} parse=${parseStatus} model_status=${signal.modelStatus} decision=${signal.decision} downgraded=${signal.downgradedFromPublish} conf=${signal.confidence.toFixed(3)} evidence=${signal.metrics.evidenceCount} markets=${signal.metrics.candidateMarkets} affinity=${signal.metrics.selectedMarketAffinity == null ? "-" : signal.metrics.selectedMarketAffinity.toFixed(3)} target=${signal.targetMarketId ?? "-"} cost=${formatUsd(signal.chargedCostUsd)} est=${formatUsd(signal.estimatedCostUsd)} src=${signal.costSource} total_cost=${formatUsd(runningCostUsd)} completed=${completed}/${buckets.length} pub=${runningPublish} ctx=${runningContext} skip=${runningSkip} err=${signal.error ? preview(signal.error, 80) : "-"}`,
      );
      return signal;
    });

    signals.sort((a, b) => {
      if (a.decision !== b.decision) {
        if (a.decision === "publish_candidate") return -1;
        if (b.decision === "publish_candidate") return 1;
        if (a.decision === "context_only") return -1;
        if (b.decision === "context_only") return 1;
      }
      if (b.confidence !== a.confidence) return b.confidence - a.confidence;
      return b.metrics.evidenceCount - a.metrics.evidenceCount;
    });

    const limitedSignals = signals.slice(0, args.maxSignals);
    const durationMs = Date.now() - startedAt;
    const totalTokenCostUsd = limitedSignals.reduce((sum, item) => sum + item.tokenCostUsd, 0);
    const modelEstimatedCostUsd = limitedSignals.reduce(
      (sum, item) => sum + item.estimatedCostUsd,
      0,
    );
    const modelChargedCostUsd = limitedSignals.reduce(
      (sum, item) => sum + item.chargedCostUsd,
      0,
    );
    const modelProviderReportedCostUsd = limitedSignals.reduce(
      (sum, item) => sum + (item.providerCostUsd ?? 0),
      0,
    );
    const modelProviderReportedCostCalls = limitedSignals.filter(
      item => item.providerCostUsd != null,
    ).length;
    const promptTokens = limitedSignals.reduce((sum, item) => sum + item.usage.promptTokens, 0);
    const completionTokens = limitedSignals.reduce((sum, item) => sum + item.usage.completionTokens, 0);
    const totalTokens = limitedSignals.reduce((sum, item) => sum + item.usage.totalTokens, 0);
    const totalEstimatedCostUsd = modelEstimatedCostUsd + embeddingCostTotals.estimatedCostUsd;
    const totalChargedCostUsd = modelChargedCostUsd + embeddingCostTotals.chargedCostUsd;
    const totalProviderReportedCostUsd =
      modelProviderReportedCostUsd + embeddingCostTotals.providerReportedCostUsd;
    const totalProviderReportedCostCalls =
      modelProviderReportedCostCalls + embeddingCostTotals.providerReportedCostCalls;
    const modelPublishCount = limitedSignals.filter(
      item => item.modelStatus === "PUBLISH",
    ).length;
    const downgradedPublishCount = limitedSignals.filter(
      item => item.downgradedFromPublish,
    ).length;
    const downgradeReasonCounts: Record<string, number> = {};
    for (const signal of limitedSignals) {
      if (!signal.downgradedFromPublish) continue;
      for (const code of signal.reasonCodes) {
        downgradeReasonCounts[code] = (downgradeReasonCounts[code] ?? 0) + 1;
      }
    }

    const payload = {
      qaContract: {
        version: QA_CONTRACT_VERSION,
        script: activeRunContext.qaScriptName,
        generatedAt: toIsoNow(),
      },
      source: {
        runId: input.run.runId,
        mapGeneratedAt: input.run.mapGeneratedAt,
        mapMetaGeneratedAt: meta.generatedAt,
        callsExecuted: input.totals.callsExecuted,
        evidenceTotal: input.totals.evidenceTotal,
        estimatedSearchCostUsd: input.totals.estimatedTotalCostUsd,
        chargedSearchCostUsd:
          input.totals.chargedTotalCostUsd ?? input.totals.estimatedTotalCostUsd,
        providerReportedSearchCostUsd: input.totals.providerReportedCostUsd ?? 0,
        providerReportedSearchCostCalls: input.totals.providerReportedCostCalls ?? 0,
        inputPath: args.inputPath,
      },
      config: {
        model: args.model,
        maxNodes: args.maxNodes,
        maxSignals: args.maxSignals,
        maxEvidencePerNode: args.maxEvidencePerNode,
        maxMarketsPerNode: args.maxMarketsPerNode,
        minEvidence: args.minEvidence,
        minConfirmed: args.minConfirmed,
        minDistinctDomains: args.minDistinctDomains,
        minEvidenceIdsForPublish: args.minEvidenceIdsForPublish,
        minAffinityForPublish: args.minAffinityForPublish,
        concurrency: args.concurrency,
        maxOutputTokens: args.maxOutputTokens,
        timeoutSec: args.timeoutSec,
        dryRun: args.dryRun,
      },
      totals: {
        generatedSignals: limitedSignals.length,
        publishCandidates: limitedSignals.filter(item => item.decision === "publish_candidate").length,
        contextOnly: limitedSignals.filter(item => item.decision === "context_only").length,
        skipped: limitedSignals.filter(item => item.decision === "skip").length,
        promptTokens,
        completionTokens,
        totalTokens,
        tokenCostUsd: Number(totalTokenCostUsd.toFixed(6)),
        modelEstimatedCostUsd: Number(modelEstimatedCostUsd.toFixed(6)),
        modelChargedCostUsd: Number(modelChargedCostUsd.toFixed(6)),
        modelProviderReportedCostUsd: Number(
          modelProviderReportedCostUsd.toFixed(6),
        ),
        modelProviderReportedCostCalls,
        embeddingPromptTokens: embeddingCostTotals.promptTokens,
        embeddingCompletionTokens: embeddingCostTotals.completionTokens,
        embeddingTotalTokens: embeddingCostTotals.totalTokens,
        embeddingEstimatedCostUsd: Number(
          embeddingCostTotals.estimatedCostUsd.toFixed(6),
        ),
        embeddingChargedCostUsd: Number(
          embeddingCostTotals.chargedCostUsd.toFixed(6),
        ),
        embeddingProviderReportedCostUsd: Number(
          embeddingCostTotals.providerReportedCostUsd.toFixed(6),
        ),
        embeddingProviderReportedCostCalls:
          embeddingCostTotals.providerReportedCostCalls,
        estimatedCostUsd: Number(totalEstimatedCostUsd.toFixed(6)),
        chargedCostUsd: Number(totalChargedCostUsd.toFixed(6)),
        providerReportedCostUsd: Number(totalProviderReportedCostUsd.toFixed(6)),
        providerReportedCostCalls: totalProviderReportedCostCalls,
        modelPublishCount,
        downgradedPublishCount,
        downgradeReasonCounts,
        durationMs,
      },
      signals: limitedSignals,
    };

    if (args.outPath) {
      await writeFile(args.outPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
      console.log(`${logPrefix()} wrote ${args.outPath}`);
    }

    if (args.reportPath) {
      const markdown = buildMarkdown(
        input,
        args,
        limitedSignals,
        durationMs,
        embeddingCostTotals,
      );
      await writeFile(args.reportPath, `${markdown}\n`, "utf8");
      console.log(`${logPrefix()} wrote ${args.reportPath}`);
    }

    console.log(
      `${logPrefix()} done signals=${limitedSignals.length} publish=${payload.totals.publishCandidates} context_only=${payload.totals.contextOnly} skipped=${payload.totals.skipped} model_publish=${payload.totals.modelPublishCount} downgraded=${payload.totals.downgradedPublishCount} charged_cost_usd=$${payload.totals.chargedCostUsd.toFixed(6)} est_cost_usd=$${payload.totals.estimatedCostUsd.toFixed(6)} duration_ms=${durationMs}`,
    );
  } finally {
    await redis.quit();
  }
}

const isDirectRun = (() => {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return import.meta.url === pathToFileURL(entry).href;
  } catch {
    return false;
  }
})();

if (isDirectRun) {
  runMapSignals().catch(async error => {
    console.error(`${logPrefix()} failed`, error);
    process.exit(1);
  });
}

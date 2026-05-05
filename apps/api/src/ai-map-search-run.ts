import { writeFile } from "fs/promises";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import { createRedisClient, ensureRedis } from "@hunch/infra";
import { RESP_TYPES } from "redis";
import { ZodError } from "zod";
import { pool } from "./db.js";
import { env } from "./env.js";
import {
  buildMapSearchSystemPromptV2,
  buildMapSearchUserPromptV2,
  mapSearchEvidenceItemV2Schema,
  parseMapSearchAgentOutputV2,
  type MapSearchAgentOutputV2,
  type MapSearchEvidenceItemV2,
} from "./schemas/ai-map-search.js";
import {
  marketMapActiveKey,
  marketMapRunMetaKey,
  marketMapRunNodeEventsKey,
  marketMapRunNodesGlobalKey,
  safeJsonParse,
  type MarketMapEventSummary,
  type MarketMapMeta,
  type MarketMapNode,
} from "./services/market-map.js";
import {
  eventVenueKey,
  selectRankedRepresentativeMarketsForEvents,
  type RankedRepresentativeMarket,
} from "./services/market-map-representative.js";
import { isMarketMapUsable } from "./services/market-map-quality.js";
import { extractProviderCostUsd, resolveAiCost } from "./lib/ai-cost.js";

const QA_CONTRACT_VERSION = "qa_contract_v1";
const DEFAULT_XAI_BASE_URL = "https://api.x.ai/v1";
const MAP_SEARCH_KEY_PREFIX = "ai:map_search:v1";
const MAP_SEARCH_LATEST_KEY = `${MAP_SEARCH_KEY_PREFIX}:latest`;
const MAP_SEARCH_RECENT_EVIDENCE_KEY = `${MAP_SEARCH_KEY_PREFIX}:recent_evidence`;
const MAP_SEARCH_RECENT_EVIDENCE_TTL_SEC = 60 * 60 * 24 * 7;

function mapSearchArtifactKey(runId: string): string {
  return `${MAP_SEARCH_KEY_PREFIX}:run:${runId}:artifact`;
}

function mapSearchStateKey(runId: string): string {
  return `${MAP_SEARCH_KEY_PREFIX}:run:${runId}:state`;
}

function mapSearchRunStatusKey(runId: string): string {
  return `${MAP_SEARCH_KEY_PREFIX}:run:${runId}:status`;
}

function mapSearchLatestForMapRunKey(runId: string): string {
  return `${MAP_SEARCH_KEY_PREFIX}:map_run:${runId}:latest_search`;
}

function mapSearchEvidenceDocKey(evidenceId: string): string {
  return `${MAP_SEARCH_KEY_PREFIX}:evidence:${evidenceId}`;
}

function mapSearchNewsEmbeddingKey(evidenceId: string): string {
  return `ai:embed:news:v1:${evidenceId}`;
}

type ReuseMode =
  | "auto"
  | "cold_start"
  | "same_run_diversify"
  | "same_run_seed"
  | "resume_same_run"
  | "warm_start_prior_run";
type PersistenceMode = "artifact_only" | "normalized_keys";

type MapSearchRunContext = {
  commandName: string;
  scriptTag: string;
  qaScriptName: string;
};

const DEFAULT_RUN_CONTEXT: MapSearchRunContext = {
  commandName: "ai:map-search:run",
  scriptTag: "ai-map-search-run",
  qaScriptName: "ai-map-search-run",
};

let activeRunContext: MapSearchRunContext = DEFAULT_RUN_CONTEXT;

function logPrefix(): string {
  return `[${activeRunContext.scriptTag}]`;
}

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
  providerCostUsd: number | null;
  providerCostField: string | null;
  providerCostUsdTicks: number | null;
};

type CostEstimate = {
  inputCostUsd: number;
  outputCostUsd: number;
  tokenCostUsd: number;
  toolCostUsd: number;
  estimatedCostUsd: number;
  providerCostUsd: number | null;
  providerCostField: string | null;
  chargedCostUsd: number;
  costSource: "provider_reported" | "estimated";
  totalCostUsd: number;
};

type NodeQueueItem = {
  nodeId: string;
  priority: number;
  reason: string;
};

type RouteCandidate = {
  childId: string;
  score: number;
  evidenceCount: number;
  avgSimilarity: number;
};

type MapEvidence = {
  id: string;
  headline: string;
  summary: string;
  sourceUrl: string;
  sourceDomain: string;
  publishedAt: string | null;
  authorHandle: string | null;
  confirmation: "confirmed" | "developing" | "unconfirmed";
  sourceTier: "official" | "wire" | "major_media" | "specialist" | "social";
  relevance: number;
  confidence: number;
  callIndex: number;
  nodeId: string;
  embedding: number[] | null;
  assignedNodeId: string | null;
  assignedSimilarity: number | null;
  routeMethod: "hybrid" | "lexical_only" | "none";
  routeBestChildId: string | null;
  routeBestScore: number | null;
  routeSecondScore: number | null;
  routeMargin: number | null;
  routeThresholdUsed: number | null;
  routeReason:
    | "assigned_child"
    | "below_threshold"
    | "below_min_similarity"
    | "low_margin"
    | "no_candidate"
    | "leaf_self"
    | null;
};

type EvidencePreview = {
  headline: string;
  summary: string;
  sourceUrl: string;
  sourceDomain: string;
  publishedAt: string | null;
  confirmation?: "confirmed" | "developing" | "unconfirmed";
  sourceTier?: "official" | "wire" | "major_media" | "specialist" | "social";
  relevance: number;
  confidence: number;
  assignedNodeId?: string | null;
  assignedSimilarity?: number | null;
  routeMethod?: "hybrid" | "lexical_only" | "none";
  routeBestChildId?: string | null;
  routeBestScore?: number | null;
  routeSecondScore?: number | null;
  routeMargin?: number | null;
  routeThresholdUsed?: number | null;
  routeReason?:
    | "assigned_child"
    | "below_threshold"
    | "below_min_similarity"
    | "low_margin"
    | "no_candidate"
    | "leaf_self"
    | null;
};

type NodeCallRecord = {
  callIndex: number;
  nodeId: string;
  nodeLabel: string;
  level: number;
  parentId: string | null;
  statusCode: number;
  ok: boolean;
  durationMs: number;
  parseStatus: "valid" | "invalid";
  parseError: string | null;
  agentStatus: string | null;
  returnedEvidenceCount: number;
  newEvidenceCount: number;
  droppedByFreshnessCount: number;
  droppedBySourceCapCount: number;
  droppedByDomainPolicyCount: number;
  leafAssignmentFixesCount: number;
  assignedToSelfCount: number;
  assignedToChildCount: number;
  assignedNullCount: number;
  assignedWithSimilarityCount: number;
  assignedAvgSimilarity: number | null;
  fallbackSuppressed: boolean;
  routeCandidates: RouteCandidate[];
  toolAttemptCount: number;
  successfulToolCount: number;
  toolCallCount: number;
  usage: UsageMetrics;
  costEstimate: CostEstimate;
  promptPreview: string;
  promptChars: number;
  outputPreview: string;
  finishReason: string | null;
  error: string | null;
  budgetStop: string | null;
  returnedEvidence: EvidencePreview[];
  newEvidence: EvidencePreview[];
};

type ParsedAgentOutput = {
  valid: boolean;
  parseError: string | null;
  data: MapSearchAgentOutputV2 | null;
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
  toolAttemptCount: number;
  successfulToolCount: number;
  toolCallCount: number;
  usage: UsageMetrics;
  costEstimate: CostEstimate;
  finishReason: string | null;
  rawResponse: unknown | null;
  error: string | null;
};

type SnapshotContext = {
  runId: string;
  meta: MarketMapMeta;
  nodes: MarketMapNode[];
  nodeById: Map<string, MarketMapNode>;
  childrenByParent: Map<string | null, MarketMapNode[]>;
};

type BudgetState = {
  callsExecuted: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalToolAttempts: number;
  totalEstimatedCostUsd: number;
  totalChargedCostUsd: number;
  totalProviderReportedCostUsd: number;
  providerReportedCostCalls: number;
  expectedNextInputTokens: number;
  expectedNextCallCostUsd: number;
  expectedNextOutputTokens: number;
};

type PersistedEvidence = {
  id: string;
  headline: string;
  summary: string;
  sourceUrl: string;
  sourceDomain: string;
  publishedAt: string | null;
  authorHandle: string | null;
  confirmation: "confirmed" | "developing" | "unconfirmed";
  sourceTier: "official" | "wire" | "major_media" | "specialist" | "social";
  relevance: number;
  confidence: number;
  callIndex: number;
  nodeId: string;
  assignedNodeId: string | null;
  assignedSimilarity: number | null;
  routeMethod: "hybrid" | "lexical_only" | "none";
  routeBestChildId: string | null;
  routeBestScore: number | null;
  routeSecondScore: number | null;
  routeMargin: number | null;
  routeThresholdUsed: number | null;
  routeReason:
    | "assigned_child"
    | "below_threshold"
    | "below_min_similarity"
    | "low_margin"
    | "no_candidate"
    | "leaf_self"
    | null;
};

type ResumeStatePayload = {
  version: "map_search_resume_v1";
  runId: string;
  at: string;
  state: "running" | "completed" | "failed" | "aborted" | "dry_run";
  reason: string;
  resume: {
    queue: NodeQueueItem[];
    visited: string[];
    budgetState: BudgetState;
    droppedByFreshnessTotal: number;
    droppedBySourceCapTotal: number;
    droppedByDomainPolicyTotal: number;
    leafAssignmentFixesTotal: number;
    fallbackSuppressedTotal: number;
    consecutiveTransportFailures: number;
    consecutiveLowYieldHighTools: number;
    evidence: PersistedEvidence[];
    callRecords: NodeCallRecord[];
  };
};

type Args = {
  runId: string | null;
  out: string | null;
  reportOut: string | null;
  reuseMode: ReuseMode;
  persistenceMode: PersistenceMode;
  artifactTtlSec: number;
  stateTtlSec: number;
  statusTtlSec: number;
  warmStartEvidenceLimit: number;
  warmStartMinSimilarity: number;
  warmStartQueueBoost: number;
  sameRunNoveltyAlpha: number;
  sameRunNoveltyFloor: number;
  sameRunNoveltyBoost: number;
  model: string;
  embedModel: string;
  includeWebTool: boolean;
  includeXTool: boolean;
  strictSchema: boolean;
  requireDistinctDomains: boolean;
  concurrency: number;
  maxCalls: number;
  maxTurns: number;
  maxOutputTokens: number;
  maxEvidencePerCall: number;
  maxEvidenceTotal: number;
  timeoutSec: number;
  maxRetries: number;
  retryBaseMs: number;
  budgetUsd: number;
  bootstrapExpectedInputTokens: number;
  bootstrapExpectedCallCostUsd: number;
  bootstrapExpectedOutputTokens: number;
  ewmaAlpha: number;
  maxTotalInputTokens: number;
  maxTotalOutputTokens: number;
  maxTotalToolAttempts: number;
  maxToolAttemptsPerCall: number;
  windowHours: number;
  windowHoursL1: number;
  windowHoursL2: number;
  windowHoursL3: number;
  recentHoursHint: number;
  topRootCount: number;
  branchPerCall: number;
  childSampleLimit: number;
  siblingSampleLimit: number;
  eventSampleLimit: number;
  topMarketsPerEvent: number;
  leafEventEmbeddingCap: number;
  routeMinSimilarity: number;
  routeThresholdL1: number;
  routeThresholdL2: number;
  routeThresholdL3: number;
  routeMinMargin: number;
  routeMinMarginL1: number;
  routeMinMarginL2: number;
  routeMinMarginL3: number;
  sourceAllowDomains: string[];
  sourceDenyDomains: string[];
  maxXEvidencePerCall: number;
  maxUnconfirmedEvidencePerCall: number;
  lowYieldToolAttemptThreshold: number;
  lowYieldConsecutiveThreshold: number;
  enforceFreshness: boolean;
  reportTopLeaves: number;
  reportTopEvidence: number;
  dryRun: boolean;
  verbose: boolean;
  leanOutput: boolean;
  verboseOutput: boolean;
  xaiBaseUrl: string;
  priceInputPerM: number;
  priceOutputPerM: number;
  priceWebPer1k: number;
  priceXPer1k: number;
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
  providerCostUsd: null,
  providerCostField: null,
  providerCostUsdTicks: null,
};

const ZERO_COST: CostEstimate = {
  inputCostUsd: 0,
  outputCostUsd: 0,
  tokenCostUsd: 0,
  toolCostUsd: 0,
  estimatedCostUsd: 0,
  providerCostUsd: null,
  providerCostField: null,
  chargedCostUsd: 0,
  costSource: "estimated",
  totalCostUsd: 0,
};

function parseFlag(args: string[], flag: string): string | undefined {
  const inlinePrefix = `${flag}=`;
  const inlineValue = args.find((arg) => arg.startsWith(inlinePrefix));
  if (inlineValue) return inlineValue.slice(inlinePrefix.length);
  const idx = args.indexOf(flag);
  if (idx === -1) return undefined;
  return args[idx + 1];
}

function hasFlag(args: string[], flag: string): boolean {
  return args.includes(flag);
}

function parseBoolean(raw: string | undefined, fallback: boolean): boolean {
  if (!raw) return fallback;
  const normalized = raw.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return fallback;
}

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return n;
}

function parseNonNegativeFloat(
  raw: string | undefined,
  fallback: number,
): number {
  if (!raw) return fallback;
  const n = Number.parseFloat(raw);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return n;
}

function parseRatio(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  const n = Number.parseFloat(raw);
  if (!Number.isFinite(n)) return fallback;
  if (n < 0 || n > 1) return fallback;
  return n;
}

function parseModeTool(raw: string | undefined): "both" | "web" | "x" | "none" {
  if (!raw) return "both";
  const value = raw.trim().toLowerCase();
  if (value === "web") return "web";
  if (value === "x") return "x";
  if (value === "none") return "none";
  return "both";
}

function parseReuseMode(raw: string | undefined): ReuseMode {
  if (!raw) return "auto";
  const value = raw.trim().toLowerCase();
  if (value === "auto") return "auto";
  if (value === "cold_start") return "cold_start";
  if (value === "same_run_diversify") return "same_run_diversify";
  if (value === "same_run_seed") return "same_run_seed";
  if (value === "resume_same_run") return "resume_same_run";
  if (value === "warm_start_prior_run") return "warm_start_prior_run";
  return "auto";
}

function parsePersistenceMode(raw: string | undefined): PersistenceMode {
  if (!raw) return "normalized_keys";
  const value = raw.trim().toLowerCase();
  if (value === "artifact_only") return "artifact_only";
  return "normalized_keys";
}

function parseDomainCsv(raw: string | undefined): string[] {
  if (!raw) return [];
  const normalized = raw.trim().toLowerCase();
  if (!normalized || normalized === "none") return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of normalized.split(",")) {
    const token = part.trim().replace(/^www\./, "");
    if (!token) continue;
    if (!/^[a-z0-9.-]+$/.test(token)) continue;
    if (seen.has(token)) continue;
    seen.add(token);
    out.push(token);
  }
  return out;
}

function resolveArgs(argv: string[]): Args {
  const toolMode = parseModeTool(parseFlag(argv, "--tool-mode"));
  const parsedSourceDenyDomains = parseDomainCsv(
    parseFlag(argv, "--source-deny-domains"),
  );
  const baseWindowHours = parsePositiveInt(
    parseFlag(argv, "--window-hours"),
    24,
  );
  const windowHoursL3 = parsePositiveInt(
    parseFlag(argv, "--window-hours-l3"),
    baseWindowHours,
  );
  const windowHoursL2 = parsePositiveInt(
    parseFlag(argv, "--window-hours-l2"),
    Math.max(windowHoursL3, 72),
  );
  const windowHoursL1 = parsePositiveInt(
    parseFlag(argv, "--window-hours-l1"),
    Math.max(windowHoursL2, 96),
  );
  const legacyRouteMinMarginRaw = parseFlag(argv, "--route-min-margin");
  const legacyRouteMinMargin = parseRatio(legacyRouteMinMarginRaw, 0.02);
  const routeMinMarginL1 = parseRatio(
    parseFlag(argv, "--route-min-margin-l1"),
    legacyRouteMinMarginRaw != null ? legacyRouteMinMargin : 0.015,
  );
  const routeMinMarginL2 = parseRatio(
    parseFlag(argv, "--route-min-margin-l2"),
    legacyRouteMinMarginRaw != null ? legacyRouteMinMargin : 0.02,
  );
  const routeMinMarginL3 = parseRatio(
    parseFlag(argv, "--route-min-margin-l3"),
    legacyRouteMinMarginRaw != null ? legacyRouteMinMargin : 0.025,
  );
  return {
    runId: parseFlag(argv, "--run-id") ?? null,
    out: parseFlag(argv, "--out") ?? null,
    reportOut: parseFlag(argv, "--report-out") ?? null,
    reuseMode: parseReuseMode(parseFlag(argv, "--reuse-mode")),
    persistenceMode: parsePersistenceMode(
      parseFlag(argv, "--persistence-mode"),
    ),
    artifactTtlSec: parsePositiveInt(
      parseFlag(argv, "--artifact-ttl-sec"),
      60 * 60 * 24 * 3,
    ),
    stateTtlSec: parsePositiveInt(
      parseFlag(argv, "--state-ttl-sec"),
      60 * 60 * 24 * 3,
    ),
    statusTtlSec: parsePositiveInt(
      parseFlag(argv, "--status-ttl-sec"),
      60 * 60 * 24 * 7,
    ),
    warmStartEvidenceLimit: parsePositiveInt(
      parseFlag(argv, "--warm-start-evidence-limit"),
      120,
    ),
    warmStartMinSimilarity: parseRatio(
      parseFlag(argv, "--warm-start-min-similarity"),
      0.18,
    ),
    warmStartQueueBoost: parseNonNegativeFloat(
      parseFlag(argv, "--warm-start-queue-boost"),
      0.8,
    ),
    sameRunNoveltyAlpha: parseNonNegativeFloat(
      parseFlag(argv, "--same-run-novelty-alpha"),
      1.2,
    ),
    sameRunNoveltyFloor: parseRatio(
      parseFlag(argv, "--same-run-novelty-floor"),
      0.35,
    ),
    sameRunNoveltyBoost: parseNonNegativeFloat(
      parseFlag(argv, "--same-run-novelty-boost"),
      0.25,
    ),
    model:
      parseFlag(argv, "--model") ??
      process.env.XAI_SEARCH_MODEL?.trim() ??
      "grok-4-1-fast-reasoning",
    embedModel:
      parseFlag(argv, "--embed-model") ??
      process.env.OPENROUTER_EMBED_MODEL ??
      process.env.AI_EMBED_MODEL ??
      "intfloat/e5-large-v2",
    includeWebTool: toolMode === "both" || toolMode === "web",
    includeXTool: toolMode === "both" || toolMode === "x",
    strictSchema: parseBoolean(parseFlag(argv, "--strict-schema"), true),
    requireDistinctDomains: parseBoolean(
      parseFlag(argv, "--require-distinct-domains"),
      true,
    ),
    concurrency: Math.min(
      8,
      parsePositiveInt(parseFlag(argv, "--concurrency"), 1),
    ),
    maxCalls: parsePositiveInt(parseFlag(argv, "--max-calls"), 16),
    maxTurns: parsePositiveInt(parseFlag(argv, "--max-turns"), 2),
    maxOutputTokens: parsePositiveInt(
      parseFlag(argv, "--max-output-tokens"),
      900,
    ),
    maxEvidencePerCall: parsePositiveInt(
      parseFlag(argv, "--max-evidence-per-call"),
      8,
    ),
    maxEvidenceTotal: parsePositiveInt(
      parseFlag(argv, "--max-evidence-total"),
      240,
    ),
    timeoutSec: parsePositiveInt(parseFlag(argv, "--timeout-sec"), 80),
    maxRetries: parsePositiveInt(parseFlag(argv, "--max-retries"), 1),
    retryBaseMs: parsePositiveInt(parseFlag(argv, "--retry-base-ms"), 1200),
    budgetUsd: parseNonNegativeFloat(parseFlag(argv, "--budget-usd"), 1),
    bootstrapExpectedInputTokens: parsePositiveInt(
      parseFlag(argv, "--bootstrap-expected-input-tokens"),
      25_000,
    ),
    bootstrapExpectedCallCostUsd: parseNonNegativeFloat(
      parseFlag(argv, "--bootstrap-expected-call-cost-usd"),
      0.07,
    ),
    bootstrapExpectedOutputTokens: parsePositiveInt(
      parseFlag(argv, "--bootstrap-expected-output-tokens"),
      5000,
    ),
    ewmaAlpha: parseRatio(parseFlag(argv, "--ewma-alpha"), 0.4),
    maxTotalInputTokens: parsePositiveInt(
      parseFlag(argv, "--max-total-input-tokens"),
      500_000,
    ),
    maxTotalOutputTokens: parsePositiveInt(
      parseFlag(argv, "--max-total-output-tokens"),
      150_000,
    ),
    maxTotalToolAttempts: parsePositiveInt(
      parseFlag(argv, "--max-total-tool-attempts"),
      600,
    ),
    maxToolAttemptsPerCall: parsePositiveInt(
      parseFlag(argv, "--max-tool-attempts-per-call"),
      20,
    ),
    windowHours: baseWindowHours,
    windowHoursL1,
    windowHoursL2,
    windowHoursL3,
    recentHoursHint: parsePositiveInt(
      parseFlag(argv, "--recent-hours-hint"),
      6,
    ),
    topRootCount: parsePositiveInt(parseFlag(argv, "--top-root-count"), 6),
    branchPerCall: parsePositiveInt(parseFlag(argv, "--branch-per-call"), 3),
    childSampleLimit: parsePositiveInt(
      parseFlag(argv, "--child-sample-limit"),
      8,
    ),
    siblingSampleLimit: parsePositiveInt(
      parseFlag(argv, "--sibling-sample-limit"),
      6,
    ),
    eventSampleLimit: parsePositiveInt(
      parseFlag(argv, "--event-sample-limit"),
      10,
    ),
    topMarketsPerEvent: parsePositiveInt(
      parseFlag(argv, "--top-markets-per-event"),
      3,
    ),
    leafEventEmbeddingCap: parsePositiveInt(
      parseFlag(argv, "--leaf-event-embedding-cap"),
      20,
    ),
    routeMinSimilarity: parseRatio(
      parseFlag(argv, "--route-min-similarity"),
      0,
    ),
    routeThresholdL1: parseRatio(parseFlag(argv, "--route-threshold-l1"), 0.2),
    routeThresholdL2: parseRatio(parseFlag(argv, "--route-threshold-l2"), 0.24),
    routeThresholdL3: parseRatio(parseFlag(argv, "--route-threshold-l3"), 0.28),
    routeMinMargin: legacyRouteMinMargin,
    routeMinMarginL1,
    routeMinMarginL2,
    routeMinMarginL3,
    sourceAllowDomains: parseDomainCsv(
      parseFlag(argv, "--source-allow-domains"),
    ),
    sourceDenyDomains:
      parsedSourceDenyDomains.length > 0
        ? parsedSourceDenyDomains
        : [
            "polymarket.com",
            "kalshi.com",
            "limitless.exchange",
            "hunch.trade",
            "app.hunch.trade",
            "instagram.com",
            "facebook.com",
            "tiktok.com",
            "mexc.com",
            "mexc.co",
            "kucoin.com",
          ],
    maxXEvidencePerCall: parsePositiveInt(
      parseFlag(argv, "--max-x-evidence-per-call"),
      2,
    ),
    maxUnconfirmedEvidencePerCall: parsePositiveInt(
      parseFlag(argv, "--max-unconfirmed-evidence-per-call"),
      2,
    ),
    lowYieldToolAttemptThreshold: parsePositiveInt(
      parseFlag(argv, "--low-yield-tool-attempt-threshold"),
      6,
    ),
    lowYieldConsecutiveThreshold: parsePositiveInt(
      parseFlag(argv, "--low-yield-consecutive-threshold"),
      3,
    ),
    enforceFreshness: parseBoolean(
      parseFlag(argv, "--enforce-freshness"),
      true,
    ),
    reportTopLeaves: parsePositiveInt(
      parseFlag(argv, "--report-top-leaves"),
      8,
    ),
    reportTopEvidence: parsePositiveInt(
      parseFlag(argv, "--report-top-evidence"),
      20,
    ),
    dryRun: hasFlag(argv, "--dry-run"),
    verbose: hasFlag(argv, "--verbose"),
    leanOutput: hasFlag(argv, "--lean-output"),
    verboseOutput: hasFlag(argv, "--verbose-output"),
    xaiBaseUrl:
      parseFlag(argv, "--xai-base-url")?.trim() ||
      process.env.XAI_BASE_URL?.trim() ||
      DEFAULT_XAI_BASE_URL,
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
  };
}

function usage(context: MapSearchRunContext, exitCode = 1): never {
  console.error(`Usage: pnpm -C hunch-monorepo -F api run ${context.commandName} -- [options]

Core:
  --run-id <id>                       Optional map snapshot run id (default: active)
  --model <id>                        xAI responses model (default: XAI_SEARCH_MODEL or grok-4-1-fast-reasoning)
  --embed-model <id>                  OpenRouter embeddings model (default: OPENROUTER_EMBED_MODEL or AI_EMBED_MODEL or intfloat/e5-large-v2)
  --tool-mode <both|web|x|none>       Tool surface (default: both)
  --out <path>                        JSON report output path
  --report-out <path>                 Markdown report output path
  --reuse-mode <mode>                 auto | cold_start | same_run_diversify | same_run_seed | resume_same_run | warm_start_prior_run (default: auto)
  --persistence-mode <mode>           artifact_only | normalized_keys (default: normalized_keys)
  --artifact-ttl-sec <n>              Redis TTL for artifact writes (default: 259200)
  --state-ttl-sec <n>                 Redis TTL for resumable state (default: 259200)
  --status-ttl-sec <n>                Redis TTL for status hashes (default: 604800)
  --dry-run                           Plan + traversal only, no model/tool calls
  --verbose                           Verbose logs

Budget and limits (global controls):
  --budget-usd <n>                    Total run budget in USD (default: 1)
  --concurrency <n>                   Parallel calls per batch (default: 1, max: 8)
  --max-calls <n>                     Max agent calls per run (default: 16)
  --max-total-input-tokens <n>        Hard cap on input tokens (default: 500000)
  --max-total-output-tokens <n>       Hard cap on output tokens (default: 150000)
  --max-total-tool-attempts <n>       Hard cap on tool attempts (default: 600)
  --bootstrap-expected-input-tokens   First-call expected input tokens guard (default: 25000)
  --bootstrap-expected-call-cost-usd  First-call expected cost for budget guard (default: 0.07)
  --bootstrap-expected-output-tokens  First-call expected output tokens guard (default: 5000)
  --ewma-alpha <0..1>                 EWMA alpha for next-call cost estimate (default: 0.4)

Per-call controls:
  --max-turns <n>                     Max turns for xAI responses (default: 2)
  --max-output-tokens <n>             Max completion tokens per call (default: 900)
  --max-tool-attempts-per-call <n>    Stop run if a call exceeds this (default: 20)
  --max-evidence-per-call <n>         Max evidence items requested from agent (default: 8)
  --timeout-sec <n>                   HTTP timeout per call in seconds (default: 80)
  --max-retries <n>                   Retries on retriable provider failure (default: 1)
  --retry-base-ms <n>                 Retry backoff base ms (default: 1200)
  --strict-schema <bool>              Fail parse if output schema invalid (default: true)

Traversal and routing:
  --window-hours <n>                  Base recency window (default: 24, used for L3 if not overridden)
  --window-hours-l1 <n>               Recency window for level 1 nodes (default: max(L2,96))
  --window-hours-l2 <n>               Recency window for level 2 nodes (default: max(L3,72))
  --window-hours-l3 <n>               Recency window for level >=3 nodes (default: --window-hours)
  --recent-hours-hint <n>             Strong recency hint in prompt (default: 6)
  --top-root-count <n>                Initial root nodes from level=1 (default: 6)
  --branch-per-call <n>               Max routed children enqueued per call (default: 3)
  --child-sample-limit <n>            Child label samples passed to prompt (default: 8)
  --sibling-sample-limit <n>          Sibling samples passed to prompt (default: 6)
  --event-sample-limit <n>            Event title samples passed to prompt (default: 10)
  --top-markets-per-event <n>         Representative markets per sampled event in prompt (default: 3)
  --leaf-event-embedding-cap <n>      Max event embeddings used per node centroid (default: 20)
  --route-min-similarity <0..1>       Optional extra child-routing floor (default: 0; disabled)
  --route-threshold-l1 <0..1>         Hybrid routing threshold at level 1 (default: 0.20)
  --route-threshold-l2 <0..1>         Hybrid routing threshold at level 2 (default: 0.24)
  --route-threshold-l3 <0..1>         Hybrid routing threshold at level >=3 (default: 0.28)
  --route-min-margin <0..1>           Legacy margin applied to all levels (default: 0.02)
  --route-min-margin-l1 <0..1>        Min top1-top2 score margin at level 1 (default: 0.015)
  --route-min-margin-l2 <0..1>        Min top1-top2 score margin at level 2 (default: 0.02)
  --route-min-margin-l3 <0..1>        Min top1-top2 score margin at level >=3 (default: 0.025)
  --warm-start-evidence-limit <n>     Max prior evidence items loaded for warm-start (default: 120)
  --warm-start-min-similarity <0..1>  Minimum warm-start assignment similarity (default: 0.18)
  --warm-start-queue-boost <n>        Priority boost for warm-start queue seeds (default: 0.8)
  --same-run-novelty-alpha <n>        Novelty penalty strength for same_run_diversify (default: 1.2)
  --same-run-novelty-floor <0..1>     Minimum novelty multiplier floor (default: 0.35)
  --same-run-novelty-boost <n>        Bonus priority for unseen nodes (default: 0.25)
  --source-deny-domains <csv>         Drop evidence from denied domains (default includes market operators + low-signal social/exchange domains)
  --source-allow-domains <csv>        Optional allowlist. If set, only listed domains are accepted
  --max-x-evidence-per-call <n>       Max accepted x.com evidence items per call (default: 2)
  --max-unconfirmed-evidence-per-call <n> Max accepted unconfirmed evidence items per call (default: 2)
  --low-yield-tool-attempt-threshold  High-tool threshold for low-yield breaker (default: 6)
  --low-yield-consecutive-threshold   Consecutive low-yield calls before fallback suppression (default: 3)
  --enforce-freshness <bool>          Enforce published_at within window-hours (default: true)
  --max-evidence-total <n>            Global evidence cap (default: 240)

Output shape:
  --lean-output                       Write compact calls payload in JSON output/checkpoints
  --verbose-output                    Include prompt/output previews and evidence arrays per call

Pricing (for estimated cost):
  --price-input-per-m <usd>           Input token $/1M (default: 0.2)
  --price-output-per-m <usd>          Output token $/1M (default: 0.5)
  --price-web-per-1k <usd>            web_search $/1k calls (default: 5)
  --price-x-per-1k <usd>              x_search $/1k calls (default: 5)
`);
  process.exit(exitCode);
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

function extractOutputItems(payload: unknown): Array<Record<string, unknown>> {
  if (!payload || typeof payload !== "object") return [];
  const output = (payload as Record<string, unknown>).output;
  if (!Array.isArray(output)) return [];
  return output.filter((item) => item && typeof item === "object") as Array<
    Record<string, unknown>
  >;
}

function extractOutputText(payload: unknown): string {
  if (!payload || typeof payload !== "object") return "";
  const obj = payload as Record<string, unknown>;
  if (
    typeof obj.output_text === "string" &&
    obj.output_text.trim().length > 0
  ) {
    return obj.output_text;
  }
  const items = extractOutputItems(payload);
  const parts: string[] = [];
  for (const item of items) {
    if (item.type !== "message") continue;
    const content = item.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (!block || typeof block !== "object") continue;
      const text = (block as Record<string, unknown>).text;
      if (typeof text === "string" && text.trim().length > 0) {
        parts.push(text);
      }
    }
  }
  return parts.join("\n\n");
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
  const providerCost = extractProviderCostUsd(payload);
  return {
    inputTokens: Number.isFinite(inputTokens) ? inputTokens : 0,
    outputTokens: Number.isFinite(outputTokens) ? outputTokens : 0,
    totalTokens: Number.isFinite(totalTokens) ? totalTokens : 0,
    reasoningTokens: Number(
      outputDetails?.reasoning_tokens ?? outputDetails?.reasoning ?? 0,
    ),
    cachedInputTokens: Number(inputDetails?.cached_tokens ?? 0),
    numServerSideToolsUsed: Number(obj.num_server_side_tools_used ?? 0),
    toolUsageDetails,
    providerCostUsd: providerCost.providerCostUsd,
    providerCostField: providerCost.providerCostField,
    providerCostUsdTicks: providerCost.providerCostUsdTicks,
  };
}

function computeEstimatedCost(args: Args, usage: UsageMetrics): CostEstimate {
  const resolved = resolveAiCost({
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    priceInputPerM: args.priceInputPerM,
    priceOutputPerM: args.priceOutputPerM,
    webSearchCalls: usage.toolUsageDetails.web_search_calls,
    xSearchCalls: usage.toolUsageDetails.x_search_calls,
    priceWebPer1k: args.priceWebPer1k,
    priceXPer1k: args.priceXPer1k,
    providerCostUsd: usage.providerCostUsd,
    providerCostField: usage.providerCostField,
    providerCostUsdTicks: usage.providerCostUsdTicks,
  });
  return {
    inputCostUsd: resolved.inputCostUsd,
    outputCostUsd: resolved.outputCostUsd,
    tokenCostUsd: resolved.tokenCostUsd,
    toolCostUsd: resolved.toolCostUsd,
    estimatedCostUsd: resolved.estimatedCostUsd,
    providerCostUsd: resolved.providerCostUsd,
    providerCostField: resolved.providerCostField,
    chargedCostUsd: resolved.chargedCostUsd,
    costSource: resolved.costSource,
    totalCostUsd: resolved.estimatedCostUsd,
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

function extractFinishReason(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") return null;
  const choices = (payload as Record<string, unknown>).choices;
  if (Array.isArray(choices) && choices[0] && typeof choices[0] === "object") {
    const finish = (choices[0] as Record<string, unknown>).finish_reason;
    return typeof finish === "string" ? finish : null;
  }
  return null;
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
    if (ch === "{") depth += 1;
    if (ch === "}") {
      depth -= 1;
      if (depth === 0) return text.slice(firstBrace, idx + 1);
    }
  }
  return null;
}

function formatZodErrorCompact(error: ZodError): string {
  const issues = error.issues.slice(0, 8).map((issue) => {
    const path = issue.path.length > 0 ? issue.path.join(".") : "root";
    return `${path}:${issue.message}`;
  });
  return issues.length > 0 ? issues.join("; ") : "schema_invalid";
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function clampStringValue(
  value: unknown,
  maxLen: number,
  fallback: string,
): string {
  if (typeof value !== "string") return fallback;
  const trimmed = value.trim();
  if (!trimmed) return fallback;
  if (trimmed.length <= maxLen) return trimmed;
  return trimmed.slice(0, maxLen).trimEnd();
}

function salvageAgentOutput(parsed: unknown): {
  data: MapSearchAgentOutputV2;
  droppedEvidence: number;
  droppedIssues: number;
} | null {
  const record = asRecord(parsed);
  if (!record) return null;

  const rawEvidence = Array.isArray(record.evidence)
    ? record.evidence.slice(0, 12)
    : [];
  const keptEvidence: MapSearchEvidenceItemV2[] = [];
  let droppedEvidence = 0;
  let droppedIssues = 0;
  for (const item of rawEvidence) {
    const evidenceParsed = mapSearchEvidenceItemV2Schema.safeParse(item);
    if (evidenceParsed.success) {
      keptEvidence.push(evidenceParsed.data);
    } else {
      droppedEvidence += 1;
      droppedIssues += evidenceParsed.error.issues.length;
    }
  }

  const candidate: Record<string, unknown> = {
    version: record.version,
    status: record.status,
    summary: clampStringValue(
      record.summary,
      260,
      "Partial evidence recovered.",
    ),
    next_focus: record.next_focus,
    evidence: keptEvidence,
  };
  if ("notes" in record) {
    candidate.notes = clampStringValue(record.notes, 400, "");
  }

  try {
    const data = parseMapSearchAgentOutputV2(candidate);
    return { data, droppedEvidence, droppedIssues };
  } catch {
    return null;
  }
}

function buildLenientAgentOutput(
  parsed: unknown,
): MapSearchAgentOutputV2 | null {
  const record = asRecord(parsed);
  if (!record) return null;

  const rawEvidence = Array.isArray(record.evidence)
    ? record.evidence.slice(0, 12)
    : [];
  const keptEvidence: MapSearchEvidenceItemV2[] = [];
  for (const item of rawEvidence) {
    const direct = mapSearchEvidenceItemV2Schema.safeParse(item);
    if (direct.success) {
      keptEvidence.push(direct.data);
      continue;
    }
    const candidateRecord = asRecord(item);
    if (!candidateRecord) continue;
    const fallbackCandidate = {
      headline: clampStringValue(candidateRecord.headline, 240, ""),
      summary: clampStringValue(candidateRecord.summary, 300, ""),
      source_url: clampStringValue(candidateRecord.source_url, 1024, ""),
      source_domain: clampStringValue(candidateRecord.source_domain, 120, ""),
      published_at:
        typeof candidateRecord.published_at === "string"
          ? candidateRecord.published_at
          : null,
      author_handle:
        typeof candidateRecord.author_handle === "string"
          ? candidateRecord.author_handle
          : null,
      confirmation: candidateRecord.confirmation,
      source_tier: candidateRecord.source_tier,
      relevance:
        typeof candidateRecord.relevance === "number" &&
        Number.isFinite(candidateRecord.relevance)
          ? candidateRecord.relevance
          : 0.5,
      confidence:
        typeof candidateRecord.confidence === "number" &&
        Number.isFinite(candidateRecord.confidence)
          ? candidateRecord.confidence
          : 0.5,
    };
    const fallbackParsed =
      mapSearchEvidenceItemV2Schema.safeParse(fallbackCandidate);
    if (fallbackParsed.success) keptEvidence.push(fallbackParsed.data);
  }

  const rawStatus =
    typeof record.status === "string" ? record.status.trim().toUpperCase() : "";
  const normalizedStatus: MapSearchAgentOutputV2["status"] =
    rawStatus === "OK" || rawStatus === "PARTIAL" || rawStatus === "NO_EVIDENCE"
      ? (rawStatus as MapSearchAgentOutputV2["status"])
      : keptEvidence.length > 0
        ? "PARTIAL"
        : "NO_EVIDENCE";
  const summaryFallback =
    keptEvidence[0]?.summary ??
    keptEvidence[0]?.headline ??
    (normalizedStatus === "NO_EVIDENCE"
      ? "No eligible evidence found."
      : "Partial evidence recovered.");
  const summary = clampStringValue(record.summary, 260, summaryFallback);
  const nextFocus = Array.isArray(record.next_focus)
    ? record.next_focus
        .map((item) => clampStringValue(item, 120, ""))
        .filter((item) => item.length > 0)
        .slice(0, 8)
    : [];
  const notes = clampStringValue(record.notes, 400, "");
  const candidate: Record<string, unknown> = {
    version: "map_search_v2",
    status:
      normalizedStatus === "OK" && keptEvidence.length === 0
        ? "PARTIAL"
        : normalizedStatus,
    summary,
    next_focus: nextFocus,
    evidence: keptEvidence,
  };
  if (notes) candidate.notes = notes;
  try {
    return parseMapSearchAgentOutputV2(candidate);
  } catch {
    return null;
  }
}

function parseAgentOutput(raw: string, strict: boolean): ParsedAgentOutput {
  const candidate = extractJsonCandidate(raw);
  if (!candidate) {
    return {
      valid: false,
      parseError: "no_json_object",
      data: null,
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate);
  } catch (error) {
    return {
      valid: false,
      parseError: error instanceof Error ? error.message : "json_parse_failed",
      data: null,
    };
  }
  try {
    const data = parseMapSearchAgentOutputV2(parsed);
    return { valid: true, parseError: null, data };
  } catch (error) {
    const schemaError =
      error instanceof ZodError
        ? formatZodErrorCompact(error)
        : error instanceof Error
          ? error.message
          : "schema_invalid";
    const salvaged = salvageAgentOutput(parsed);
    if (salvaged) {
      return {
        valid: true,
        parseError: `salvaged:dropped_evidence=${salvaged.droppedEvidence};dropped_issues=${salvaged.droppedIssues};root=${schemaError}`,
        data: salvaged.data,
      };
    }
    if (!strict) {
      const lenient = buildLenientAgentOutput(parsed);
      if (lenient) {
        return {
          valid: true,
          parseError: `lenient_recovery:root=${schemaError}`,
          data: lenient,
        };
      }
    }
    if (strict) {
      return {
        valid: false,
        parseError: schemaError,
        data: null,
      };
    }
    return {
      valid: false,
      parseError: schemaError,
      data: null,
    };
  }
}

function normalizeVector(values: readonly number[]): number[] {
  let norm = 0;
  for (const value of values) norm += value * value;
  if (!Number.isFinite(norm) || norm <= 0) return Array.from(values, () => 0);
  const mag = Math.sqrt(norm);
  return values.map((value) => value / mag);
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

function averageVectors(vectors: readonly number[][]): number[] | null {
  if (vectors.length === 0) return null;
  const dims = vectors[0].length;
  const acc = new Array<number>(dims).fill(0);
  for (const vec of vectors) {
    for (let i = 0; i < dims; i += 1) {
      acc[i] += vec[i] ?? 0;
    }
  }
  return normalizeVector(acc.map((value) => value / vectors.length));
}

function parseDateIso(raw: string | null): Date | null {
  if (!raw) return null;
  const ts = Date.parse(raw);
  if (Number.isNaN(ts)) return null;
  return new Date(ts);
}

function normalizeSourceDomain(url: string, fallbackDomain: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./i, "").toLowerCase();
  } catch {
    return fallbackDomain.trim().toLowerCase();
  }
}

function hostMatchesDomain(host: string, rule: string): boolean {
  if (host === rule) return true;
  return host.endsWith(`.${rule}`);
}

function domainAllowedByPolicy(
  domain: string,
  allowSet: ReadonlySet<string>,
  denySet: ReadonlySet<string>,
): boolean {
  let explicitlyAllowed = false;
  if (allowSet.size > 0) {
    for (const allowed of allowSet) {
      if (hostMatchesDomain(domain, allowed)) {
        explicitlyAllowed = true;
        break;
      }
    }
    if (!explicitlyAllowed) return false;
  }
  for (const denied of denySet) {
    if (hostMatchesDomain(domain, denied) && !explicitlyAllowed) return false;
  }
  return true;
}

function normalizeEvidenceReliability(
  sourceDomain: string,
  sourceTier: MapEvidence["sourceTier"],
  confirmation: MapEvidence["confirmation"],
): Pick<MapEvidence, "sourceTier" | "confirmation"> {
  const isSocialDomain =
    hostMatchesDomain(sourceDomain, "x.com") ||
    hostMatchesDomain(sourceDomain, "instagram.com") ||
    hostMatchesDomain(sourceDomain, "facebook.com") ||
    hostMatchesDomain(sourceDomain, "tiktok.com");
  const normalizedSourceTier: MapEvidence["sourceTier"] = isSocialDomain
    ? "social"
    : sourceTier;
  const normalizedConfirmation: MapEvidence["confirmation"] =
    normalizedSourceTier === "social" && confirmation === "confirmed"
      ? "developing"
      : confirmation;
  return {
    sourceTier: normalizedSourceTier,
    confirmation: normalizedConfirmation,
  };
}

function toEvidencePreviewFromAgent(
  evidence: MapSearchEvidenceItemV2,
): EvidencePreview {
  return {
    headline: evidence.headline,
    summary: evidence.summary,
    sourceUrl: evidence.source_url,
    sourceDomain: normalizeSourceDomain(
      evidence.source_url,
      evidence.source_domain,
    ),
    publishedAt: evidence.published_at,
    confirmation: evidence.confirmation,
    sourceTier: evidence.source_tier,
    relevance: evidence.relevance,
    confidence: evidence.confidence,
  };
}

function toEvidencePreviewFromMapEvidence(
  evidence: MapEvidence,
): EvidencePreview {
  return {
    headline: evidence.headline,
    summary: evidence.summary,
    sourceUrl: evidence.sourceUrl,
    sourceDomain: evidence.sourceDomain,
    publishedAt: evidence.publishedAt,
    confirmation: evidence.confirmation,
    sourceTier: evidence.sourceTier,
    relevance: evidence.relevance,
    confidence: evidence.confidence,
    assignedNodeId: evidence.assignedNodeId,
    assignedSimilarity: evidence.assignedSimilarity,
    routeMethod: evidence.routeMethod,
    routeBestChildId: evidence.routeBestChildId,
    routeBestScore: evidence.routeBestScore,
    routeSecondScore: evidence.routeSecondScore,
    routeMargin: evidence.routeMargin,
    routeThresholdUsed: evidence.routeThresholdUsed,
    routeReason: evidence.routeReason,
  };
}

function toPersistedEvidence(evidence: MapEvidence): PersistedEvidence {
  return {
    id: evidence.id,
    headline: evidence.headline,
    summary: evidence.summary,
    sourceUrl: evidence.sourceUrl,
    sourceDomain: evidence.sourceDomain,
    publishedAt: evidence.publishedAt,
    authorHandle: evidence.authorHandle,
    confirmation: evidence.confirmation,
    sourceTier: evidence.sourceTier,
    relevance: evidence.relevance,
    confidence: evidence.confidence,
    callIndex: evidence.callIndex,
    nodeId: evidence.nodeId,
    assignedNodeId: evidence.assignedNodeId,
    assignedSimilarity: evidence.assignedSimilarity,
    routeMethod: evidence.routeMethod,
    routeBestChildId: evidence.routeBestChildId,
    routeBestScore: evidence.routeBestScore,
    routeSecondScore: evidence.routeSecondScore,
    routeMargin: evidence.routeMargin,
    routeThresholdUsed: evidence.routeThresholdUsed,
    routeReason: evidence.routeReason,
  };
}

function fromPersistedEvidence(
  evidence: PersistedEvidence,
  nodeById: Map<string, MarketMapNode>,
): MapEvidence | null {
  if (!nodeById.has(evidence.nodeId)) return null;
  const assignedNodeId =
    evidence.assignedNodeId && nodeById.has(evidence.assignedNodeId)
      ? evidence.assignedNodeId
      : nodeById.has(evidence.nodeId)
        ? evidence.nodeId
        : null;
  return {
    id: evidence.id,
    headline: evidence.headline,
    summary: evidence.summary,
    sourceUrl: evidence.sourceUrl,
    sourceDomain: evidence.sourceDomain,
    publishedAt: evidence.publishedAt,
    authorHandle: evidence.authorHandle,
    confirmation: evidence.confirmation,
    sourceTier: evidence.sourceTier,
    relevance: evidence.relevance,
    confidence: evidence.confidence,
    callIndex: evidence.callIndex,
    nodeId: evidence.nodeId,
    embedding: null,
    assignedNodeId,
    assignedSimilarity: evidence.assignedSimilarity,
    routeMethod: evidence.routeMethod,
    routeBestChildId: evidence.routeBestChildId,
    routeBestScore: evidence.routeBestScore,
    routeSecondScore: evidence.routeSecondScore,
    routeMargin: evidence.routeMargin,
    routeThresholdUsed: evidence.routeThresholdUsed,
    routeReason: evidence.routeReason,
  };
}

function parseResumeStatePayload(
  raw: string | null,
): ResumeStatePayload | null {
  const parsed = safeJsonParse<ResumeStatePayload>(raw);
  if (!parsed || parsed.version !== "map_search_resume_v1") return null;
  if (!parsed.resume || !Array.isArray(parsed.resume.queue)) return null;
  if (!Array.isArray(parsed.resume.visited)) return null;
  if (!Array.isArray(parsed.resume.evidence)) return null;
  if (!Array.isArray(parsed.resume.callRecords)) return null;
  return parsed;
}

function parsePriorEvidenceFromArtifact(
  raw: string | null,
  limit: number,
): PersistedEvidence[] {
  if (!raw) return [];
  const parsed = safeJsonParse<{ evidence?: PersistedEvidence[] }>(raw);
  const evidence = parsed?.evidence;
  if (!Array.isArray(evidence)) return [];
  return evidence.slice(0, Math.max(0, limit));
}

function serializeCallRecord(
  call: NodeCallRecord,
  args: Args,
): Record<string, unknown> {
  const compactBase: Record<string, unknown> = {
    callIndex: call.callIndex,
    nodeId: call.nodeId,
    nodeLabel: call.nodeLabel,
    level: call.level,
    parentId: call.parentId,
    statusCode: call.statusCode,
    ok: call.ok,
    durationMs: call.durationMs,
    parseStatus: call.parseStatus,
    parseError: call.parseError,
    agentStatus: call.agentStatus,
    returnedEvidenceCount: call.returnedEvidenceCount,
    newEvidenceCount: call.newEvidenceCount,
    droppedByFreshnessCount: call.droppedByFreshnessCount,
    droppedBySourceCapCount: call.droppedBySourceCapCount,
    droppedByDomainPolicyCount: call.droppedByDomainPolicyCount,
    leafAssignmentFixesCount: call.leafAssignmentFixesCount,
    assignedToSelfCount: call.assignedToSelfCount,
    assignedToChildCount: call.assignedToChildCount,
    assignedNullCount: call.assignedNullCount,
    assignedWithSimilarityCount: call.assignedWithSimilarityCount,
    assignedAvgSimilarity: call.assignedAvgSimilarity,
    fallbackSuppressed: call.fallbackSuppressed,
    routeCandidates: call.routeCandidates,
    toolAttemptCount: call.toolAttemptCount,
    successfulToolCount: call.successfulToolCount,
    toolCallCount: call.toolCallCount,
    costEstimate: call.costEstimate,
    budgetStop: call.budgetStop,
  };
  if (!args.leanOutput) {
    compactBase.usage = call.usage;
    compactBase.finishReason = call.finishReason;
    compactBase.error = call.error;
  }
  if (args.verboseOutput) {
    compactBase.promptPreview = call.promptPreview;
    compactBase.promptChars = call.promptChars;
    compactBase.outputPreview = call.outputPreview;
    compactBase.returnedEvidence = call.returnedEvidence;
    compactBase.newEvidence = call.newEvidence;
  }
  return compactBase;
}

function toDateOnly(value: Date): string {
  return value.toISOString().slice(0, 10);
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function computeBackoffMs(baseMs: number, attempt: number): number {
  const exp = Math.min(attempt, 6);
  const jitterFactor = 0.75 + Math.random() * 0.5;
  return Math.round(baseMs * 2 ** exp * jitterFactor);
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

async function callXaiOnce(
  args: Args,
  apiKey: string,
  prompt: { system: string; user: string },
  tools: Array<Record<string, unknown>>,
): Promise<XaiCallRaw> {
  const startedAt = Date.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), args.timeoutSec * 1000);
  try {
    const normalizedBase = args.xaiBaseUrl.endsWith("/")
      ? args.xaiBaseUrl
      : `${args.xaiBaseUrl}/`;
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
        max_turns: args.maxTurns,
        input: [
          {
            role: "system",
            content: prompt.system,
          },
          {
            role: "user",
            content: prompt.user,
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
    const costEstimate = computeEstimatedCost(args, usage);
    const serverSideUsage = extractServerSideToolUsage(payload);
    const toolCallCount = Math.max(
      extractToolCallCount(serverSideUsage),
      extractSuccessfulToolCount(payload),
    );
    return {
      ok: response.ok,
      status: response.status,
      durationMs: Date.now() - startedAt,
      prompt: `${prompt.system}\n\n${prompt.user}`,
      outputText: resolvedOutputText,
      outputPreview: preview(resolvedOutputText),
      outputTextLength: resolvedOutputText.length,
      citationsCount: extractCitationsCount(payload),
      toolAttemptCount: extractToolAttemptCount(payload),
      successfulToolCount: extractSuccessfulToolCount(payload),
      toolCallCount,
      usage,
      costEstimate,
      finishReason: extractFinishReason(payload),
      rawResponse: payload,
      error: response.ok
        ? null
        : `HTTP ${response.status}: ${preview(stringifyPayload(payload), 400)}`,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      status: 0,
      durationMs: Date.now() - startedAt,
      prompt: `${prompt.system}\n\n${prompt.user}`,
      outputText: "",
      outputPreview: "",
      outputTextLength: 0,
      citationsCount: 0,
      toolAttemptCount: 0,
      successfulToolCount: 0,
      toolCallCount: 0,
      usage: ZERO_USAGE,
      costEstimate: ZERO_COST,
      finishReason: null,
      rawResponse: null,
      error: message,
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function callXaiWithRetry(
  args: Args,
  apiKey: string,
  prompt: { system: string; user: string },
  tools: Array<Record<string, unknown>>,
): Promise<XaiCallRaw> {
  let attempts = 0;
  let last: XaiCallRaw | null = null;
  const totalAttempts = args.maxRetries + 1;
  while (attempts < totalAttempts) {
    const currentAttempt = attempts + 1;
    const raw = await callXaiOnce(args, apiKey, prompt, tools);
    attempts = currentAttempt;
    last = raw;
    if (!isRetriableFailure(raw) || currentAttempt >= totalAttempts) {
      return raw;
    }
    const backoffMs = computeBackoffMs(args.retryBaseMs, attempts - 1);
    if (args.verbose) {
      console.log(
        `${logPrefix()} retry ${currentAttempt}/${totalAttempts - 1} after ${backoffMs}ms status=${raw.status} err=${raw.error ?? "unknown"}`,
      );
    }
    await sleep(backoffMs);
  }
  return (
    last ?? {
      ok: false,
      status: 0,
      durationMs: 0,
      prompt: `${prompt.system}\n\n${prompt.user}`,
      outputText: "",
      outputPreview: "",
      outputTextLength: 0,
      citationsCount: 0,
      toolAttemptCount: 0,
      successfulToolCount: 0,
      toolCallCount: 0,
      usage: ZERO_USAGE,
      costEstimate: ZERO_COST,
      finishReason: null,
      rawResponse: null,
      error: "retry_exhausted_without_response",
    }
  );
}

async function fetchOpenRouterEmbeddings(
  openRouterKey: string,
  model: string,
  texts: string[],
): Promise<number[][]> {
  if (texts.length === 0) return [];
  const response = await fetch("https://openrouter.ai/api/v1/embeddings", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${openRouterKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      input: texts,
    }),
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`OpenRouter embeddings failed: ${response.status} ${body}`);
  }
  const payload = (await response.json()) as {
    data?: Array<{ embedding?: number[]; index?: number }>;
  };
  if (!payload.data || !Array.isArray(payload.data)) {
    throw new Error("OpenRouter embeddings missing data");
  }
  const out: number[][] = [];
  for (const item of payload.data) {
    if (!item.embedding || !Array.isArray(item.embedding)) {
      throw new Error("OpenRouter embedding missing vector");
    }
    const idx = typeof item.index === "number" ? item.index : out.length;
    out[idx] = normalizeVector(item.embedding);
  }
  return out;
}

function buildNodePathLabels(
  nodeId: string,
  nodeById: Map<string, MarketMapNode>,
): string[] {
  const labels: string[] = [];
  let current: MarketMapNode | undefined = nodeById.get(nodeId);
  while (current) {
    labels.push(
      current.labelAi ??
        current.labelRepresentative ??
        current.label ??
        current.id,
    );
    if (!current.parentId) break;
    current = nodeById.get(current.parentId);
  }
  return labels.reverse();
}

function nodeDisplayLabel(node: MarketMapNode): string {
  return node.labelAi ?? node.labelRepresentative ?? node.label ?? node.id;
}

async function loadSnapshot(
  redis: ReturnType<typeof createRedisClient>,
  requestedRunId: string | null,
): Promise<SnapshotContext> {
  const runId = requestedRunId ?? (await redis.get(marketMapActiveKey()));
  if (!runId) {
    throw new Error("No active market map snapshot");
  }
  const [metaRaw, nodesRaw] = await Promise.all([
    redis.get(marketMapRunMetaKey(runId)),
    redis.get(marketMapRunNodesGlobalKey(runId)),
  ]);
  const meta = safeJsonParse<MarketMapMeta>(metaRaw);
  const nodes = safeJsonParse<MarketMapNode[]>(nodesRaw) ?? [];
  if (!meta) {
    throw new Error(`Missing map metadata for runId=${runId}`);
  }
  if (!Array.isArray(nodes)) {
    throw new Error(`Invalid map nodes payload for runId=${runId}`);
  }
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const childrenByParent = new Map<string | null, MarketMapNode[]>();
  for (const node of nodes) {
    const key = node.parentId ?? null;
    const list = childrenByParent.get(key) ?? [];
    list.push(node);
    childrenByParent.set(key, list);
  }
  for (const [parentId, list] of childrenByParent.entries()) {
    list.sort((a, b) => {
      if (b.sumVolume24h !== a.sumVolume24h)
        return b.sumVolume24h - a.sumVolume24h;
      if (b.score !== a.score) return b.score - a.score;
      return a.id.localeCompare(b.id);
    });
    childrenByParent.set(parentId, list);
  }
  return {
    runId,
    meta,
    nodes,
    nodeById,
    childrenByParent,
  };
}

function addQueueItem(
  queue: NodeQueueItem[],
  queued: Set<string>,
  item: NodeQueueItem,
): void {
  if (queued.has(item.nodeId)) return;
  queue.push(item);
  queued.add(item.nodeId);
}

function popHighestPriority(queue: NodeQueueItem[]): NodeQueueItem | null {
  if (queue.length === 0) return null;
  let bestIndex = 0;
  for (let i = 1; i < queue.length; i += 1) {
    if (queue[i].priority > queue[bestIndex].priority) {
      bestIndex = i;
    }
  }
  const [item] = queue.splice(bestIndex, 1);
  return item ?? null;
}

function tokenizeLoose(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .map((token) => token.trim())
      .filter((token) => token.length > 2),
  );
}

function lexicalSimilarity(a: string, b: string): number {
  const ta = tokenizeLoose(a);
  const tb = tokenizeLoose(b);
  if (ta.size === 0 || tb.size === 0) return 0;
  let overlap = 0;
  for (const token of ta) {
    if (tb.has(token)) overlap += 1;
  }
  return overlap / Math.sqrt(ta.size * tb.size);
}

function getWindowHoursForLevel(level: number, args: Args): number {
  if (level <= 1) return args.windowHoursL1;
  if (level === 2) return args.windowHoursL2;
  return args.windowHoursL3;
}

function getRouteThresholdForLevel(level: number, args: Args): number {
  if (level <= 1) return args.routeThresholdL1;
  if (level === 2) return args.routeThresholdL2;
  return args.routeThresholdL3;
}

function getRouteMinMarginForLevel(level: number, args: Args): number {
  if (level <= 1) return args.routeMinMarginL1;
  if (level === 2) return args.routeMinMarginL2;
  return args.routeMinMarginL3;
}

function buildXTools(
  args: Args,
  windowHours: number,
): Array<Record<string, unknown>> {
  const tools: Array<Record<string, unknown>> = [];
  if (args.includeWebTool) {
    tools.push({ type: "web_search" });
  }
  if (args.includeXTool) {
    const now = new Date();
    const from = new Date(now.getTime() - windowHours * 3_600_000);
    tools.push({
      type: "x_search",
      from_date: toDateOnly(from),
      to_date: toDateOnly(now),
    });
  }
  return tools;
}

function buildEvidenceId(evidence: {
  sourceUrl: string;
  headline: string;
}): string {
  let normalizedUrl = evidence.sourceUrl.trim().toLowerCase();
  try {
    const url = new URL(evidence.sourceUrl.trim());
    const params = new URLSearchParams(url.search);
    for (const key of Array.from(params.keys())) {
      const lower = key.toLowerCase();
      if (
        lower.startsWith("utm_") ||
        lower === "fbclid" ||
        lower === "gclid" ||
        lower === "mc_cid" ||
        lower === "mc_eid"
      ) {
        params.delete(key);
      }
    }
    const serializedParams = params.toString();
    let pathname = url.pathname.replace(/\/+$/g, "");
    if (!pathname) pathname = "/";
    normalizedUrl = `${url.protocol}//${url.hostname.toLowerCase()}${pathname}${serializedParams ? `?${serializedParams}` : ""}`;
  } catch {
    // keep normalizedUrl fallback
  }
  const normalizedHeadline = evidence.headline
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
  return createHash("sha1")
    .update(normalizedUrl)
    .update("|")
    .update(normalizedHeadline)
    .digest("hex");
}

function updateBudgetState(
  state: BudgetState,
  call: XaiCallRaw,
  alpha: number,
): void {
  state.callsExecuted += 1;
  state.totalInputTokens += call.usage.inputTokens;
  state.totalOutputTokens += call.usage.outputTokens;
  state.totalToolAttempts += call.toolAttemptCount;
  state.totalEstimatedCostUsd += call.costEstimate.estimatedCostUsd;
  state.totalChargedCostUsd += call.costEstimate.chargedCostUsd;
  if (call.costEstimate.providerCostUsd != null) {
    state.totalProviderReportedCostUsd += call.costEstimate.providerCostUsd;
    state.providerReportedCostCalls += 1;
  }
  const nextExpectedInput =
    state.callsExecuted === 1
      ? call.usage.inputTokens
      : alpha * call.usage.inputTokens +
        (1 - alpha) * state.expectedNextInputTokens;
  state.expectedNextInputTokens = Number.isFinite(nextExpectedInput)
    ? Math.max(0, nextExpectedInput)
    : state.expectedNextInputTokens;
  const nextExpected =
    state.callsExecuted === 1
      ? call.costEstimate.chargedCostUsd
      : alpha * call.costEstimate.chargedCostUsd +
        (1 - alpha) * state.expectedNextCallCostUsd;
  state.expectedNextCallCostUsd = Number.isFinite(nextExpected)
    ? Math.max(0, nextExpected)
    : state.expectedNextCallCostUsd;
  const nextExpectedOutput =
    state.callsExecuted === 1
      ? call.usage.outputTokens
      : alpha * call.usage.outputTokens +
        (1 - alpha) * state.expectedNextOutputTokens;
  state.expectedNextOutputTokens = Number.isFinite(nextExpectedOutput)
    ? Math.max(0, nextExpectedOutput)
    : state.expectedNextOutputTokens;
}

function evaluateBudgetStop(args: Args, state: BudgetState): string | null {
  if (state.callsExecuted >= args.maxCalls) return "max_calls";
  if (state.totalInputTokens >= args.maxTotalInputTokens)
    return "max_total_input_tokens";
  if (state.totalOutputTokens >= args.maxTotalOutputTokens)
    return "max_total_output_tokens";
  if (state.totalToolAttempts >= args.maxTotalToolAttempts)
    return "max_total_tool_attempts";
  if (state.totalChargedCostUsd >= args.budgetUsd)
    return "budget_usd_exhausted";
  if (state.callsExecuted > 0) {
    const remainingInput = args.maxTotalInputTokens - state.totalInputTokens;
    if (remainingInput < state.expectedNextInputTokens) {
      return "input_guard_expected_next_call";
    }
    const remainingOutput = args.maxTotalOutputTokens - state.totalOutputTokens;
    if (remainingOutput < state.expectedNextOutputTokens) {
      return "output_guard_expected_next_call";
    }
    const remaining = args.budgetUsd - state.totalChargedCostUsd;
    if (remaining < state.expectedNextCallCostUsd) {
      return "budget_guard_expected_next_call";
    }
  }
  return null;
}

function formatUsd(value: number): string {
  return `$${value.toFixed(6)}`;
}

async function setSearchStatus(
  redis: ReturnType<typeof createRedisClient>,
  key: string,
  ttlSec: number,
  payload: Record<string, string | number | null>,
): Promise<void> {
  const cleaned = Object.fromEntries(
    Object.entries(payload).map(([k, v]) => [k, v ?? ""]),
  );
  await redis.hSet(key, cleaned);
  await redis.expire(key, ttlSec);
}

export async function runMapSearch(
  argv: string[] = process.argv.slice(2),
  context: Partial<MapSearchRunContext> = {},
): Promise<void> {
  activeRunContext = { ...DEFAULT_RUN_CONTEXT, ...context };
  if (hasFlag(argv, "--help")) usage(activeRunContext, 0);
  const args = resolveArgs(argv);

  if (!env.redisUrl) {
    throw new Error("REDIS_URL is required");
  }
  if (!args.dryRun && !process.env.XAI_API_KEY?.trim()) {
    throw new Error("XAI_API_KEY is required when not dry-run");
  }
  if (
    !args.dryRun &&
    args.maxCalls > 0 &&
    !process.env.OPENROUTER_API_KEY?.trim()
  ) {
    console.warn(
      `${logPrefix()} OPENROUTER_API_KEY missing; semantic routing will fallback to lexical only`,
    );
  }

  const xaiApiKey = process.env.XAI_API_KEY?.trim() ?? "";
  const openRouterKey = process.env.OPENROUTER_API_KEY?.trim() ?? "";
  const redis = createRedisClient({ url: env.redisUrl });
  await ensureRedis(redis, {
    waitForReady: true,
    logLabel: activeRunContext.scriptTag,
  });
  const bufferRedis = redis.withTypeMapping({
    [RESP_TYPES.BLOB_STRING]: Buffer,
  });

  const startedAt = Date.now();
  const snapshot = await loadSnapshot(redis, args.runId);
  const runId = snapshot.runId;
  const nodes = snapshot.nodes;
  const nodeById = snapshot.nodeById;
  const childrenByParent = snapshot.childrenByParent;

  const rootNodes = (childrenByParent.get(null) ?? [])
    .slice()
    .sort((a, b) => b.sumVolume24h - a.sumVolume24h || a.id.localeCompare(b.id))
    .slice(0, args.topRootCount);
  if (rootNodes.length === 0) {
    throw new Error("No root nodes found in active map snapshot");
  }

  const queue: NodeQueueItem[] = [];
  const queued = new Set<string>();
  const visited = new Set<string>();
  const nodeEventsCache = new Map<string, MarketMapEventSummary[]>();
  const representativeMarketByEventVenue = new Map<
    string,
    RankedRepresentativeMarket | null
  >();
  const topMarketsByEventVenue = new Map<
    string,
    RankedRepresentativeMarket[]
  >();
  const eventEmbeddingCache = new Map<string, number[] | null>();
  const nodeCentroidCache = new Map<string, number[] | null>();
  const nodeRepresentativeEmbeddingCache = new Map<string, number[] | null>();
  const nodeEvidenceHeadlines = new Map<string, string[]>();
  const leafEvidenceIds = new Map<string, Set<string>>();
  const evidenceById = new Map<string, MapEvidence>();
  const callRecords: NodeCallRecord[] = [];
  let consecutiveTransportFailures = 0;
  let consecutiveLowYieldHighTools = 0;
  let droppedByFreshnessTotal = 0;
  let droppedBySourceCapTotal = 0;
  let droppedByDomainPolicyTotal = 0;
  let leafAssignmentFixesTotal = 0;
  let fallbackSuppressedTotal = 0;
  const sourceAllowSet = new Set(args.sourceAllowDomains);
  const sourceDenySet = new Set(args.sourceDenyDomains);
  const nowIso = () => new Date().toISOString();
  let resumeLoaded = false;
  let resumeStateReason: string | null = null;
  let sameRunSeedCandidates = 0;
  let sameRunSeedAssigned = 0;
  let warmStartCandidates = 0;
  let warmStartAssigned = 0;

  const budgetState: BudgetState = {
    callsExecuted: 0,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalToolAttempts: 0,
    totalEstimatedCostUsd: 0,
    totalChargedCostUsd: 0,
    totalProviderReportedCostUsd: 0,
    providerReportedCostCalls: 0,
    expectedNextInputTokens: args.bootstrapExpectedInputTokens,
    expectedNextCallCostUsd: args.bootstrapExpectedCallCostUsd,
    expectedNextOutputTokens: args.bootstrapExpectedOutputTokens,
  };

  const sameRunCoverageByNode = new Map<string, number>();
  let sameRunDiversifyActive = false;

  const applySameRunNoveltyPriority = (
    nodeId: string,
    priority: number,
  ): number => {
    if (!sameRunDiversifyActive) return priority;
    const coverage = sameRunCoverageByNode.get(nodeId) ?? 0;
    const noveltyMultiplier = Math.max(
      args.sameRunNoveltyFloor,
      1 / (1 + args.sameRunNoveltyAlpha * Math.log1p(coverage)),
    );
    const unseenBoost = coverage === 0 ? args.sameRunNoveltyBoost : 0;
    return Number((priority * noveltyMultiplier + unseenBoost).toFixed(6));
  };

  const markCoverageForNodeAndAncestors = (nodeId: string): void => {
    let cursor: MarketMapNode | null = nodeById.get(nodeId) ?? null;
    while (cursor) {
      const current = sameRunCoverageByNode.get(cursor.id) ?? 0;
      sameRunCoverageByNode.set(cursor.id, current + 1);
      cursor = cursor.parentId ? (nodeById.get(cursor.parentId) ?? null) : null;
    }
  };

  const loadSameRunCoverage = (priorEvidence: PersistedEvidence[]): number => {
    sameRunCoverageByNode.clear();
    for (const prior of priorEvidence) {
      const assigned =
        prior.assignedNodeId && nodeById.has(prior.assignedNodeId)
          ? prior.assignedNodeId
          : nodeById.has(prior.nodeId)
            ? prior.nodeId
            : null;
      if (!assigned) continue;
      markCoverageForNodeAndAncestors(assigned);
    }
    return sameRunCoverageByNode.size;
  };

  const seedRoots = () => {
    for (const node of rootNodes) {
      const basePriority = Math.log10(1 + Math.max(1, node.sumVolume24h));
      addQueueItem(queue, queued, {
        nodeId: node.id,
        priority: applySameRunNoveltyPriority(node.id, basePriority),
        reason: "root_seed",
      });
    }
  };

  const shouldTryResume =
    args.reuseMode === "auto" || args.reuseMode === "resume_same_run";
  const shouldTrySameRunDiversify =
    args.reuseMode === "auto" || args.reuseMode === "same_run_diversify";
  const shouldTrySameRunSeed = args.reuseMode === "same_run_seed";
  const shouldTryWarmStart =
    args.reuseMode === "auto" || args.reuseMode === "warm_start_prior_run";

  if (shouldTryResume && args.persistenceMode === "normalized_keys") {
    const resumeRaw = await redis.get(mapSearchStateKey(runId));
    const resumed = parseResumeStatePayload(resumeRaw);
    if (
      resumed &&
      resumed.runId === runId &&
      resumed.resume &&
      resumed.state !== "completed" &&
      resumed.state !== "dry_run"
    ) {
      queue.length = 0;
      queued.clear();
      visited.clear();
      evidenceById.clear();
      callRecords.length = 0;

      for (const visitedNodeId of resumed.resume.visited) {
        if (nodeById.has(visitedNodeId)) visited.add(visitedNodeId);
      }
      for (const queuedItem of resumed.resume.queue) {
        if (!nodeById.has(queuedItem.nodeId)) continue;
        if (visited.has(queuedItem.nodeId)) continue;
        addQueueItem(queue, queued, queuedItem);
      }
      for (const evidenceRaw of resumed.resume.evidence) {
        const restored = fromPersistedEvidence(evidenceRaw, nodeById);
        if (!restored) continue;
        evidenceById.set(restored.id, restored);
        const assignedNodeId = restored.assignedNodeId ?? restored.nodeId;
        const set = leafEvidenceIds.get(assignedNodeId) ?? new Set<string>();
        set.add(restored.id);
        leafEvidenceIds.set(assignedNodeId, set);
        const headlines = nodeEvidenceHeadlines.get(restored.nodeId) ?? [];
        headlines.push(restored.headline);
        nodeEvidenceHeadlines.set(restored.nodeId, headlines.slice(-20));
      }
      for (const record of resumed.resume.callRecords) {
        callRecords.push(record);
      }

      budgetState.callsExecuted = resumed.resume.budgetState.callsExecuted ?? 0;
      budgetState.totalInputTokens =
        resumed.resume.budgetState.totalInputTokens ?? 0;
      budgetState.totalOutputTokens =
        resumed.resume.budgetState.totalOutputTokens ?? 0;
      budgetState.totalToolAttempts =
        resumed.resume.budgetState.totalToolAttempts ?? 0;
      budgetState.totalEstimatedCostUsd =
        resumed.resume.budgetState.totalEstimatedCostUsd ?? 0;
      budgetState.totalChargedCostUsd =
        resumed.resume.budgetState.totalChargedCostUsd ?? 0;
      budgetState.totalProviderReportedCostUsd =
        resumed.resume.budgetState.totalProviderReportedCostUsd ?? 0;
      budgetState.providerReportedCostCalls =
        resumed.resume.budgetState.providerReportedCostCalls ?? 0;
      budgetState.expectedNextInputTokens =
        resumed.resume.budgetState.expectedNextInputTokens ??
        budgetState.expectedNextInputTokens;
      budgetState.expectedNextCallCostUsd =
        resumed.resume.budgetState.expectedNextCallCostUsd ??
        budgetState.expectedNextCallCostUsd;
      budgetState.expectedNextOutputTokens =
        resumed.resume.budgetState.expectedNextOutputTokens ??
        budgetState.expectedNextOutputTokens;

      droppedByFreshnessTotal = resumed.resume.droppedByFreshnessTotal ?? 0;
      droppedBySourceCapTotal = resumed.resume.droppedBySourceCapTotal ?? 0;
      droppedByDomainPolicyTotal =
        resumed.resume.droppedByDomainPolicyTotal ?? 0;
      leafAssignmentFixesTotal = resumed.resume.leafAssignmentFixesTotal ?? 0;
      fallbackSuppressedTotal = resumed.resume.fallbackSuppressedTotal ?? 0;
      consecutiveTransportFailures =
        resumed.resume.consecutiveTransportFailures ?? 0;
      consecutiveLowYieldHighTools =
        resumed.resume.consecutiveLowYieldHighTools ?? 0;

      resumeLoaded = true;
      resumeStateReason = resumed.reason ?? "resume_state";
      console.log(`${logPrefix()} resume_loaded`, {
        runId,
        at: resumed.at,
        reason: resumeStateReason,
        queueSize: queue.length,
        visited: visited.size,
        evidence: evidenceById.size,
        callsExecuted: budgetState.callsExecuted,
      });
    }
  }

  const seedQueueFromEvidence = async (
    sourceId: string,
    priorEvidence: PersistedEvidence[],
    reasonPrefix: "same_run_seed" | "same_run_diversify" | "warm_start",
  ): Promise<number> => {
    let assigned = 0;
    const rootById = new Map(rootNodes.map((node) => [node.id, node]));
    for (const prior of priorEvidence) {
      const sourceText = `${prior.headline} ${prior.summary}`.trim();
      const cachedEmbeddingRaw = await redis.get(
        mapSearchNewsEmbeddingKey(prior.id),
      );
      const cachedEmbedding = (() => {
        if (!cachedEmbeddingRaw) return null;
        const parsed = safeJsonParse<number[]>(cachedEmbeddingRaw);
        if (!Array.isArray(parsed) || parsed.length === 0) return null;
        return normalizeVector(parsed);
      })();
      let bestRootId: string | null = null;
      let bestRootScore = 0;
      for (const root of rootNodes) {
        const lexicalScore = lexicalSimilarity(
          sourceText,
          nodeDisplayLabel(root),
        );
        let score = lexicalScore;
        if (cachedEmbedding) {
          const representativeEmbedding = await getNodeRepresentativeEmbedding(
            root.id,
          );
          const semanticScore = representativeEmbedding
            ? Math.max(0, dot(cachedEmbedding, representativeEmbedding))
            : 0;
          score = 0.75 * semanticScore + 0.25 * lexicalScore;
        }
        if (score > bestRootScore) {
          bestRootScore = score;
          bestRootId = root.id;
        }
      }
      if (!bestRootId || bestRootScore < args.warmStartMinSimilarity) continue;
      const root = rootById.get(bestRootId);
      if (!root) continue;

      const headlines = nodeEvidenceHeadlines.get(root.id) ?? [];
      headlines.push(prior.headline);
      nodeEvidenceHeadlines.set(root.id, headlines.slice(-20));
      addQueueItem(queue, queued, {
        nodeId: root.id,
        priority: applySameRunNoveltyPriority(
          root.id,
          Math.log10(1 + Math.max(1, root.sumVolume24h)) +
            args.warmStartQueueBoost +
            bestRootScore,
        ),
        reason: `${reasonPrefix}:${sourceId}`,
      });

      const children = childrenByParent.get(root.id) ?? [];
      let bestChild: MarketMapNode | null = null;
      let bestChildScore = 0;
      for (const child of children) {
        const lexicalScore = lexicalSimilarity(
          sourceText,
          nodeDisplayLabel(child),
        );
        let score = lexicalScore;
        if (cachedEmbedding) {
          const representativeEmbedding = await getNodeRepresentativeEmbedding(
            child.id,
          );
          const semanticScore = representativeEmbedding
            ? Math.max(0, dot(cachedEmbedding, representativeEmbedding))
            : 0;
          score = 0.75 * semanticScore + 0.25 * lexicalScore;
        }
        if (score > bestChildScore) {
          bestChildScore = score;
          bestChild = child;
        }
      }
      if (bestChild && bestChildScore >= args.warmStartMinSimilarity) {
        addQueueItem(queue, queued, {
          nodeId: bestChild.id,
          priority: applySameRunNoveltyPriority(
            bestChild.id,
            Math.log10(1 + Math.max(1, bestChild.sumVolume24h)) +
              args.warmStartQueueBoost * 0.9 +
              bestChildScore,
          ),
          reason: `${reasonPrefix}_child:${sourceId}`,
        });
        const childHeadlines = nodeEvidenceHeadlines.get(bestChild.id) ?? [];
        childHeadlines.push(prior.headline);
        nodeEvidenceHeadlines.set(bestChild.id, childHeadlines.slice(-20));
      }
      assigned += 1;
    }
    return assigned;
  };

  if (!resumeLoaded && (shouldTrySameRunDiversify || shouldTrySameRunSeed)) {
    const sameRunArtifactRaw = await redis.get(mapSearchArtifactKey(runId));
    const sameRunEvidence = parsePriorEvidenceFromArtifact(
      sameRunArtifactRaw,
      args.warmStartEvidenceLimit,
    );
    sameRunSeedCandidates = sameRunEvidence.length;
    if (sameRunSeedCandidates > 0) {
      if (shouldTrySameRunDiversify) {
        const coverageNodes = loadSameRunCoverage(sameRunEvidence);
        sameRunDiversifyActive = coverageNodes > 0;
      }
      sameRunSeedAssigned = await seedQueueFromEvidence(
        runId,
        sameRunEvidence,
        shouldTrySameRunDiversify ? "same_run_diversify" : "same_run_seed",
      );
      if (sameRunSeedAssigned > 0) {
        console.log(
          `${logPrefix()} ${shouldTrySameRunDiversify ? "same_run_diversify" : "same_run_seed"}`,
          {
            runId,
            candidates: sameRunSeedCandidates,
            assigned: sameRunSeedAssigned,
            sameRunDiversifyActive,
            sameRunCoverageNodes: sameRunCoverageByNode.size,
            noveltyAlpha: args.sameRunNoveltyAlpha,
            noveltyFloor: args.sameRunNoveltyFloor,
            noveltyBoost: args.sameRunNoveltyBoost,
          },
        );
      }
    }
  }

  if (!resumeLoaded && sameRunSeedAssigned === 0 && shouldTryWarmStart) {
    const previousRunIdRaw =
      (await redis.get(MAP_SEARCH_LATEST_KEY))?.trim() ?? "";
    const previousRunId =
      previousRunIdRaw.length > 0 && previousRunIdRaw !== runId
        ? previousRunIdRaw
        : null;
    if (previousRunId) {
      const priorArtifactRaw = await redis.get(
        mapSearchArtifactKey(previousRunId),
      );
      const priorEvidence = parsePriorEvidenceFromArtifact(
        priorArtifactRaw,
        args.warmStartEvidenceLimit,
      );
      warmStartCandidates = priorEvidence.length;
      if (warmStartCandidates > 0) {
        warmStartAssigned = await seedQueueFromEvidence(
          previousRunId,
          priorEvidence,
          "warm_start",
        );
        console.log(`${logPrefix()} warm_start`, {
          previousRunId,
          candidates: warmStartCandidates,
          assigned: warmStartAssigned,
        });
      }
    }
  }

  if (!resumeLoaded) {
    seedRoots();
  }

  console.log(`${logPrefix()} start`, {
    runId,
    mapGeneratedAt: snapshot.meta.generatedAt,
    model: args.model,
    toolMode:
      args.includeWebTool && args.includeXTool
        ? "both"
        : args.includeWebTool
          ? "web"
          : args.includeXTool
            ? "x"
            : "none",
    maxCalls: args.maxCalls,
    concurrency: args.concurrency,
    budgetUsd: args.budgetUsd,
    windowHoursByLevel: {
      l1: args.windowHoursL1,
      l2: args.windowHoursL2,
      l3: args.windowHoursL3,
    },
    routeThresholdByLevel: {
      l1: args.routeThresholdL1,
      l2: args.routeThresholdL2,
      l3: args.routeThresholdL3,
    },
    routeMinSimilarity: args.routeMinSimilarity,
    routeMinMarginByLevel: {
      l1: args.routeMinMarginL1,
      l2: args.routeMinMarginL2,
      l3: args.routeMinMarginL3,
    },
    sourceAllowDomains: args.sourceAllowDomains,
    sourceDenyDomains: args.sourceDenyDomains,
    maxUnconfirmedEvidencePerCall: args.maxUnconfirmedEvidencePerCall,
    rootSeedCount: rootNodes.length,
    reuseMode: args.reuseMode,
    persistenceMode: args.persistenceMode,
    resumeLoaded,
    resumeStateReason,
    sameRunSeedCandidates,
    sameRunSeedAssigned,
    sameRunDiversifyActive,
    sameRunCoverageNodes: sameRunCoverageByNode.size,
    sameRunNoveltyAlpha: args.sameRunNoveltyAlpha,
    sameRunNoveltyFloor: args.sameRunNoveltyFloor,
    sameRunNoveltyBoost: args.sameRunNoveltyBoost,
    warmStartCandidates,
    warmStartAssigned,
    dryRun: args.dryRun,
  });

  if (args.persistenceMode === "normalized_keys") {
    await setSearchStatus(
      redis,
      mapSearchRunStatusKey(runId),
      args.statusTtlSec,
      {
        state: args.dryRun ? "dry_run" : "running",
        reason: "started",
        runId,
        at: nowIso(),
        callsExecuted: budgetState.callsExecuted,
        evidenceTotal: evidenceById.size,
        chargedCostUsd: Number(budgetState.totalChargedCostUsd.toFixed(6)),
        estimatedCostUsd: Number(budgetState.totalEstimatedCostUsd.toFixed(6)),
      },
    );
    await setSearchStatus(
      redis,
      `${MAP_SEARCH_KEY_PREFIX}:status:last`,
      args.statusTtlSec,
      {
        state: args.dryRun ? "dry_run" : "running",
        reason: "started",
        runId,
        at: nowIso(),
        callsExecuted: budgetState.callsExecuted,
        evidenceTotal: evidenceById.size,
        chargedCostUsd: Number(budgetState.totalChargedCostUsd.toFixed(6)),
        estimatedCostUsd: Number(budgetState.totalEstimatedCostUsd.toFixed(6)),
      },
    );
  }

  async function writeCheckpoint(reason: string): Promise<void> {
    const evidence = Array.from(evidenceById.values())
      .sort(
        (a, b) =>
          a.callIndex - b.callIndex ||
          b.relevance + b.confidence - (a.relevance + a.confidence),
      )
      .map((item) => ({
        id: item.id,
        callIndex: item.callIndex,
        nodeId: item.nodeId,
        assignedNodeId: item.assignedNodeId,
        assignedSimilarity: item.assignedSimilarity,
        ...toEvidencePreviewFromMapEvidence(item),
      }));
    const checkpoint = {
      qaContract: {
        version: QA_CONTRACT_VERSION,
        script: activeRunContext.qaScriptName,
        generatedAt: new Date().toISOString(),
      },
      partial: true,
      reason,
      run: {
        runId,
        mapGeneratedAt: snapshot.meta.generatedAt,
        mapVersion: snapshot.meta.version,
        projectionMethod: snapshot.meta.projectionMethod,
        projectionFallback: snapshot.meta.projectionFallback,
        venues: snapshot.meta.venues,
        depth: snapshot.meta.depth,
        eventCountTotal: snapshot.meta.eventCountTotal,
        nodeCountTotal: nodes.length,
      },
      totals: {
        durationMs: Date.now() - startedAt,
        callsExecuted: budgetState.callsExecuted,
        nodesVisited: visited.size,
        queueRemaining: queue.length,
        evidenceTotal: evidenceById.size,
        inputTokens: budgetState.totalInputTokens,
        outputTokens: budgetState.totalOutputTokens,
        toolAttempts: budgetState.totalToolAttempts,
        estimatedTotalCostUsd: Number(
          budgetState.totalEstimatedCostUsd.toFixed(6),
        ),
        chargedTotalCostUsd: Number(budgetState.totalChargedCostUsd.toFixed(6)),
        providerReportedCostUsd: Number(
          budgetState.totalProviderReportedCostUsd.toFixed(6),
        ),
        providerReportedCostCalls: budgetState.providerReportedCostCalls,
        expectedNextInputTokens: Math.round(
          budgetState.expectedNextInputTokens,
        ),
        expectedNextCallCostUsd: Number(
          budgetState.expectedNextCallCostUsd.toFixed(6),
        ),
        expectedNextOutputTokens: Math.round(
          budgetState.expectedNextOutputTokens,
        ),
        droppedByFreshnessTotal,
        droppedBySourceCapTotal,
        droppedByDomainPolicyTotal,
        leafAssignmentFixesTotal,
        fallbackSuppressedTotal,
        resumeLoaded,
        sameRunSeedCandidates,
        sameRunSeedAssigned,
        warmStartCandidates,
        warmStartAssigned,
      },
      callsCompact: callRecords.map((call) => ({
        callIndex: call.callIndex,
        nodeId: call.nodeId,
        nodeLabel: call.nodeLabel,
        statusCode: call.statusCode,
        parseStatus: call.parseStatus,
        returnedEvidenceCount: call.returnedEvidenceCount,
        newEvidenceCount: call.newEvidenceCount,
        droppedByFreshnessCount: call.droppedByFreshnessCount,
        droppedBySourceCapCount: call.droppedBySourceCapCount,
        droppedByDomainPolicyCount: call.droppedByDomainPolicyCount,
        assignedToSelfCount: call.assignedToSelfCount,
        assignedToChildCount: call.assignedToChildCount,
        assignedNullCount: call.assignedNullCount,
        assignedWithSimilarityCount: call.assignedWithSimilarityCount,
        assignedAvgSimilarity: call.assignedAvgSimilarity,
        fallbackSuppressed: call.fallbackSuppressed,
        budgetStop: call.budgetStop,
      })),
      calls: callRecords.map((call) => serializeCallRecord(call, args)),
      evidence,
    };
    if (args.out) {
      await writeFile(args.out, JSON.stringify(checkpoint, null, 2), "utf8");
    }

    const shouldPersistArtifact =
      args.persistenceMode === "artifact_only" ||
      args.persistenceMode === "normalized_keys";
    if (!shouldPersistArtifact) return;

    await redis.set(mapSearchArtifactKey(runId), JSON.stringify(checkpoint), {
      EX: args.artifactTtlSec,
    });

    if (args.persistenceMode !== "normalized_keys") return;

    const resumePayload: ResumeStatePayload = {
      version: "map_search_resume_v1",
      runId,
      at: nowIso(),
      state: args.dryRun ? "dry_run" : "running",
      reason,
      resume: {
        queue: queue.slice(0, 1_500),
        visited: Array.from(visited),
        budgetState: { ...budgetState },
        droppedByFreshnessTotal,
        droppedBySourceCapTotal,
        droppedByDomainPolicyTotal,
        leafAssignmentFixesTotal,
        fallbackSuppressedTotal,
        consecutiveTransportFailures,
        consecutiveLowYieldHighTools,
        evidence: Array.from(evidenceById.values()).map(toPersistedEvidence),
        callRecords: callRecords.slice(),
      },
    };

    await redis.set(mapSearchStateKey(runId), JSON.stringify(resumePayload), {
      EX: args.stateTtlSec,
    });

    await setSearchStatus(
      redis,
      mapSearchRunStatusKey(runId),
      args.statusTtlSec,
      {
        state: args.dryRun ? "dry_run" : "running",
        reason,
        runId,
        at: nowIso(),
        callsExecuted: budgetState.callsExecuted,
        evidenceTotal: evidenceById.size,
        chargedCostUsd: Number(budgetState.totalChargedCostUsd.toFixed(6)),
        estimatedCostUsd: Number(budgetState.totalEstimatedCostUsd.toFixed(6)),
      },
    );
    await setSearchStatus(
      redis,
      `${MAP_SEARCH_KEY_PREFIX}:status:last`,
      args.statusTtlSec,
      {
        state: args.dryRun ? "dry_run" : "running",
        reason,
        runId,
        at: nowIso(),
        callsExecuted: budgetState.callsExecuted,
        evidenceTotal: evidenceById.size,
        chargedCostUsd: Number(budgetState.totalChargedCostUsd.toFixed(6)),
        estimatedCostUsd: Number(budgetState.totalEstimatedCostUsd.toFixed(6)),
      },
    );
  }

  async function getNodeEvents(
    nodeId: string,
  ): Promise<MarketMapEventSummary[]> {
    if (nodeEventsCache.has(nodeId)) return nodeEventsCache.get(nodeId) ?? [];
    const raw = await redis.get(marketMapRunNodeEventsKey(runId, nodeId));
    const events = safeJsonParse<MarketMapEventSummary[]>(raw) ?? [];
    const normalized = events.map((event) => {
      const liquidity =
        event.liquidity > 0
          ? event.liquidity
          : event.openInterest > 0
            ? event.openInterest
            : 0;
      const openInterest =
        event.openInterest > 0 ? event.openInterest : liquidity;
      return {
        ...event,
        liquidity,
        openInterest,
      };
    });
    const sorted = normalized
      .slice()
      .sort((a, b) => b.score - a.score || a.eventId.localeCompare(b.eventId));

    const missingInputs: Array<{
      eventId: string;
      venue: string;
      preferredMarketId: string | null;
    }> = [];
    let enrichmentFailed = false;
    for (const event of sorted) {
      const key = eventVenueKey(event.eventId, event.venue);
      if (representativeMarketByEventVenue.has(key)) continue;
      missingInputs.push({
        eventId: event.eventId,
        venue: event.venue,
        preferredMarketId: event.representativeMarketId ?? null,
      });
    }

    if (missingInputs.length > 0) {
      try {
        const ranked = await selectRankedRepresentativeMarketsForEvents(
          pool,
          missingInputs,
          1,
        );
        const selectedByKey = new Map<string, RankedRepresentativeMarket>();
        for (const row of ranked) {
          const key = eventVenueKey(row.eventId, row.venue);
          if (!selectedByKey.has(key)) selectedByKey.set(key, row);
        }
        for (const input of missingInputs) {
          const key = eventVenueKey(input.eventId, input.venue);
          representativeMarketByEventVenue.set(
            key,
            selectedByKey.get(key) ?? null,
          );
        }
      } catch (error) {
        enrichmentFailed = true;
        console.warn(`${logPrefix()} representative market enrichment failed`, {
          error: error instanceof Error ? error.message : String(error),
          eventCount: missingInputs.length,
        });
        for (const input of missingInputs) {
          const key = eventVenueKey(input.eventId, input.venue);
          representativeMarketByEventVenue.set(key, null);
        }
      }
    }

    const enriched = sorted.map((event) => {
      const key = eventVenueKey(event.eventId, event.venue);
      const selected = representativeMarketByEventVenue.get(key);
      if (!selected) return event;
      const oddsSource: MarketMapEventSummary["oddsSource"] =
        event.representativeMarketId &&
        selected.marketId === event.representativeMarketId
          ? "representative"
          : "fallback";
      return {
        ...event,
        representativeMarketId: selected.marketId,
        representativeMarketTitle:
          selected.marketTitle ?? event.representativeMarketTitle ?? null,
        liquidity:
          event.liquidity > 0
            ? event.liquidity
            : selected.liquidity > 0
              ? selected.liquidity
              : selected.openInterest > 0
                ? selected.openInterest
                : 0,
        openInterest:
          event.openInterest > 0
            ? event.openInterest
            : selected.openInterest > 0
              ? selected.openInterest
              : event.liquidity > 0
                ? event.liquidity
                : selected.liquidity > 0
                  ? selected.liquidity
                  : 0,
        oddsSource,
        tokenYes: selected.tokenYes,
        tokenNo: selected.tokenNo,
        yesBid: selected.yesBid,
        yesAsk: selected.yesAsk,
        noBid: selected.noBid,
        noAsk: selected.noAsk,
        marketBestBid: selected.marketBestBid,
        marketBestAsk: selected.marketBestAsk,
        lastPrice: selected.lastPrice,
        marketStatus: selected.marketStatus,
        acceptingOrders: selected.acceptingOrders,
        resolvedOutcome: selected.resolvedOutcome,
        resolvedOutcomePct: selected.resolvedOutcomePct,
      };
    });

    const filtered = enrichmentFailed
      ? enriched
      : enriched.filter((event) =>
          isMarketMapUsable({
            tokenYes: event.tokenYes ?? null,
            tokenNo: event.tokenNo ?? null,
            acceptingOrders: event.acceptingOrders ?? null,
            marketStatus: event.marketStatus ?? null,
            yesBid: event.yesBid ?? null,
            yesAsk: event.yesAsk ?? null,
            noBid: event.noBid ?? null,
            noAsk: event.noAsk ?? null,
            marketBestBid: event.marketBestBid ?? null,
            marketBestAsk: event.marketBestAsk ?? null,
            lastPrice: event.lastPrice ?? null,
            resolvedOutcome: event.resolvedOutcome ?? null,
            resolvedOutcomePct: event.resolvedOutcomePct ?? null,
          }),
        );
    if (!enrichmentFailed && filtered.length !== enriched.length) {
      console.log(`${logPrefix()} node_event_quality_prune`, {
        nodeId,
        before: enriched.length,
        after: filtered.length,
        dropped: enriched.length - filtered.length,
      });
    }

    nodeEventsCache.set(nodeId, filtered);
    return filtered;
  }

  async function getTopMarketsForEvents(
    events: MarketMapEventSummary[],
  ): Promise<Map<string, RankedRepresentativeMarket[]>> {
    const out = new Map<string, RankedRepresentativeMarket[]>();
    const uniqueEvents = new Map<string, MarketMapEventSummary>();
    for (const event of events) {
      const eventId = event.eventId.trim();
      const venue = event.venue.trim().toLowerCase();
      if (!eventId || !venue) continue;
      const key = eventVenueKey(eventId, venue);
      if (!uniqueEvents.has(key)) uniqueEvents.set(key, event);
    }

    const missingInputs: Array<{
      eventId: string;
      venue: string;
      preferredMarketId: string | null;
    }> = [];
    for (const [key, event] of uniqueEvents) {
      if (!topMarketsByEventVenue.has(key)) {
        missingInputs.push({
          eventId: event.eventId,
          venue: event.venue,
          preferredMarketId: event.representativeMarketId ?? null,
        });
      }
    }

    if (missingInputs.length > 0) {
      try {
        const ranked = await selectRankedRepresentativeMarketsForEvents(
          pool,
          missingInputs,
          args.topMarketsPerEvent,
        );
        const grouped = new Map<string, RankedRepresentativeMarket[]>();
        for (const row of ranked) {
          if (
            !isMarketMapUsable({
              tokenYes: row.tokenYes,
              tokenNo: row.tokenNo,
              acceptingOrders: row.acceptingOrders,
              marketStatus: row.marketStatus,
              yesBid: row.yesBid,
              yesAsk: row.yesAsk,
              noBid: row.noBid,
              noAsk: row.noAsk,
              marketBestBid: row.marketBestBid,
              marketBestAsk: row.marketBestAsk,
              lastPrice: row.lastPrice,
              resolvedOutcome: row.resolvedOutcome,
              resolvedOutcomePct: row.resolvedOutcomePct,
              yesProbability: row.yesProbability,
            })
          ) {
            continue;
          }
          const key = eventVenueKey(row.eventId, row.venue);
          const existing = grouped.get(key);
          if (existing) existing.push(row);
          else grouped.set(key, [row]);
        }
        for (const input of missingInputs) {
          const key = eventVenueKey(input.eventId, input.venue);
          topMarketsByEventVenue.set(key, grouped.get(key) ?? []);
        }
      } catch (error) {
        console.warn(`${logPrefix()} top markets enrichment failed`, {
          error: error instanceof Error ? error.message : String(error),
          eventCount: missingInputs.length,
        });
        for (const input of missingInputs) {
          const key = eventVenueKey(input.eventId, input.venue);
          topMarketsByEventVenue.set(key, []);
        }
      }
    }

    for (const [key] of uniqueEvents) {
      out.set(key, topMarketsByEventVenue.get(key) ?? []);
    }
    return out;
  }

  async function getEventEmbedding(eventId: string): Promise<number[] | null> {
    if (eventEmbeddingCache.has(eventId)) {
      return eventEmbeddingCache.get(eventId) ?? null;
    }
    const raw = await bufferRedis.hGet(
      `ai:embed:event:${eventId}`,
      "embedding",
    );
    const vec = Buffer.isBuffer(raw) ? parseEmbeddingBuffer(raw) : null;
    eventEmbeddingCache.set(eventId, vec);
    return vec;
  }

  async function getNodeCentroid(nodeId: string): Promise<number[] | null> {
    if (nodeCentroidCache.has(nodeId))
      return nodeCentroidCache.get(nodeId) ?? null;
    const events = await getNodeEvents(nodeId);
    const vectors: number[][] = [];
    for (const event of events.slice(0, args.leafEventEmbeddingCap)) {
      const vec = await getEventEmbedding(event.eventId);
      if (vec) vectors.push(vec);
    }
    const centroid = averageVectors(vectors);
    nodeCentroidCache.set(nodeId, centroid);
    return centroid;
  }

  async function getNodeRepresentativeEmbedding(
    nodeId: string,
  ): Promise<number[] | null> {
    if (nodeRepresentativeEmbeddingCache.has(nodeId)) {
      return nodeRepresentativeEmbeddingCache.get(nodeId) ?? null;
    }
    const events = await getNodeEvents(nodeId);
    const representativeEventId = events[0]?.eventId ?? null;
    if (!representativeEventId) {
      nodeRepresentativeEmbeddingCache.set(nodeId, null);
      return null;
    }
    const vec = await getEventEmbedding(representativeEventId);
    nodeRepresentativeEmbeddingCache.set(nodeId, vec);
    return vec;
  }

  function assignEvidenceToNode(nodeId: string, evidenceId: string): void {
    const set = leafEvidenceIds.get(nodeId) ?? new Set<string>();
    set.add(evidenceId);
    leafEvidenceIds.set(nodeId, set);
  }

  function pushNodeHeadline(nodeId: string, headline: string): void {
    const list = nodeEvidenceHeadlines.get(nodeId) ?? [];
    list.push(headline);
    nodeEvidenceHeadlines.set(nodeId, list.slice(-20));
  }

  type PreparedCallTask = {
    node: MarketMapNode;
    children: MarketMapNode[];
    systemPrompt: string;
    userPrompt: string;
    nodeWindowHours: number;
    rawCall: XaiCallRaw;
  };

  await writeCheckpoint("started");

  while (queue.length > 0) {
    const budgetStopBefore = evaluateBudgetStop(args, budgetState);
    if (budgetStopBefore) {
      console.log(
        `${logPrefix()} stop=${budgetStopBefore} calls=${budgetState.callsExecuted} spent=${formatUsd(budgetState.totalChargedCostUsd)} est=${formatUsd(budgetState.totalEstimatedCostUsd)} expected_next=${formatUsd(budgetState.expectedNextCallCostUsd)} expected_next_input=${Math.round(budgetState.expectedNextInputTokens)} expected_next_output=${Math.round(budgetState.expectedNextOutputTokens)}`,
      );
      break;
    }
    if (evidenceById.size >= args.maxEvidenceTotal) {
      console.log(
        `${logPrefix()} stop=max_evidence_total current=${evidenceById.size}`,
      );
      break;
    }

    const launches: Array<{
      reserveInputTokens: number;
      reserveCostUsd: number;
      reserveOutputTokens: number;
      promise: Promise<PreparedCallTask>;
    }> = [];
    let launchGuardStop: string | null = null;
    let batchReservedInputTokens = 0;
    let batchReservedCostUsd = 0;
    let batchReservedOutputTokens = 0;

    while (launches.length < args.concurrency && queue.length > 0) {
      if (budgetState.callsExecuted + launches.length >= args.maxCalls) {
        launchGuardStop = "max_calls";
        break;
      }
      const reserveInputTokens = Math.max(
        0,
        budgetState.expectedNextInputTokens,
      );
      const reserveCostUsd = Math.max(0, budgetState.expectedNextCallCostUsd);
      const reserveOutputTokens = Math.max(
        0,
        budgetState.expectedNextOutputTokens,
      );
      const projectedInput =
        budgetState.totalInputTokens +
        batchReservedInputTokens +
        reserveInputTokens;
      const projectedCost =
        budgetState.totalChargedCostUsd + batchReservedCostUsd + reserveCostUsd;
      const projectedOutput =
        budgetState.totalOutputTokens +
        batchReservedOutputTokens +
        reserveOutputTokens;
      if (projectedInput > args.maxTotalInputTokens) {
        launchGuardStop = "input_guard_parallel_reservation";
        break;
      }
      if (projectedCost > args.budgetUsd) {
        launchGuardStop = "budget_guard_parallel_reservation";
        break;
      }
      if (projectedOutput > args.maxTotalOutputTokens) {
        launchGuardStop = "output_guard_parallel_reservation";
        break;
      }

      const item = popHighestPriority(queue);
      if (!item) break;
      queued.delete(item.nodeId);
      if (visited.has(item.nodeId)) continue;
      const node = nodeById.get(item.nodeId);
      if (!node) continue;
      visited.add(item.nodeId);

      const launchOrder = budgetState.callsExecuted + launches.length + 1;
      const inFlightAtLaunch = launches.length + 1;
      const promise = (async (): Promise<PreparedCallTask> => {
        const children = childrenByParent.get(node.id) ?? [];
        const parent = node.parentId
          ? (nodeById.get(node.parentId) ?? null)
          : null;
        const siblings = parent ? (childrenByParent.get(parent.id) ?? []) : [];
        const siblingLabels = siblings
          .filter((sibling) => sibling.id !== node.id)
          .slice(0, args.siblingSampleLimit)
          .map(nodeDisplayLabel);
        const childLabels = children
          .slice(0, args.childSampleLimit)
          .map(nodeDisplayLabel);
        const events = await getNodeEvents(node.id);
        const sampledEvents = events.slice(0, args.eventSampleLimit);
        const sampleEventTitles = sampledEvents.map((event) =>
          event.title.trim(),
        );
        const marketsByEvent = await getTopMarketsForEvents(sampledEvents);
        const sampleEventMarketTitles = sampledEvents.map((event) => {
          const eventTitle = event.title.trim();
          const key = eventVenueKey(event.eventId, event.venue);
          const markets = marketsByEvent.get(key) ?? [];
          if (markets.length === 0) {
            return eventTitle;
          }
          const labels = markets
            .slice(0, args.topMarketsPerEvent)
            .map((market) => market.marketTitle?.trim() || market.marketId);
          return `${eventTitle} | ${labels.join(" ; ")}`;
        });
        const priorHeadlines = nodeEvidenceHeadlines.get(node.id) ?? [];
        const nodeWindowHours = getWindowHoursForLevel(node.level, args);
        const softToolCapThisCall = Math.min(
          args.maxToolAttemptsPerCall,
          Math.max(2, args.lowYieldToolAttemptThreshold),
        );

        const systemPrompt = buildMapSearchSystemPromptV2({
          maxEvidence: args.maxEvidencePerCall,
          windowHours: nodeWindowHours,
          recentHoursHint: args.recentHoursHint,
          includeWebTool: args.includeWebTool,
          includeXTool: args.includeXTool,
          requireDistinctDomains: args.requireDistinctDomains,
          disallowedSourceDomains: args.sourceDenyDomains,
        });
        const userPrompt = buildMapSearchUserPromptV2(
          {
            runId,
            level: node.level,
            nodeId: node.id,
            nodeLabel: nodeDisplayLabel(node),
            nodeRepresentative: node.labelRepresentative,
            parentLabel: parent ? nodeDisplayLabel(parent) : null,
            siblingLabels,
            childLabels,
            sampleEventTitles,
            sampleEventMarketTitles,
            priorHeadlines,
            softToolCapThisCall,
            windowHoursForThisCall: nodeWindowHours,
          },
          {
            maxEvidence: args.maxEvidencePerCall,
            windowHours: nodeWindowHours,
            recentHoursHint: args.recentHoursHint,
            includeWebTool: args.includeWebTool,
            includeXTool: args.includeXTool,
            requireDistinctDomains: args.requireDistinctDomains,
            disallowedSourceDomains: args.sourceDenyDomains,
          },
        );
        const tools = buildXTools(args, nodeWindowHours);

        console.log(
          `${logPrefix()} call_start #${launchOrder} node="${nodeDisplayLabel(node)}" level=${node.level} queue=${queue.length} evidence=${evidenceById.size} in_flight=${inFlightAtLaunch}`,
        );

        try {
          let rawCall: XaiCallRaw;
          if (args.dryRun) {
            rawCall = {
              ok: true,
              status: 200,
              durationMs: 0,
              prompt: `${systemPrompt}\n\n${userPrompt}`,
              outputText: JSON.stringify(
                {
                  version: "map_search_v2",
                  status: "NO_EVIDENCE",
                  summary: "dry-run",
                  next_focus: childLabels.slice(0, 3),
                  evidence: [],
                  notes: "dry-run",
                },
                null,
                2,
              ),
              outputPreview: "dry-run",
              outputTextLength: 0,
              citationsCount: 0,
              toolAttemptCount: 0,
              successfulToolCount: 0,
              toolCallCount: 0,
              usage: ZERO_USAGE,
              costEstimate: ZERO_COST,
              finishReason: null,
              rawResponse: null,
              error: null,
            };
          } else {
            rawCall = await callXaiWithRetry(
              args,
              xaiApiKey,
              { system: systemPrompt, user: userPrompt },
              tools,
            );
          }
          return {
            node,
            children,
            systemPrompt,
            userPrompt,
            nodeWindowHours,
            rawCall,
          };
        } catch (error) {
          const message =
            error instanceof Error ? error.message : String(error);
          return {
            node,
            children,
            systemPrompt,
            userPrompt,
            nodeWindowHours,
            rawCall: {
              ok: false,
              status: 0,
              durationMs: 0,
              prompt: `${systemPrompt}\n\n${userPrompt}`,
              outputText: "",
              outputPreview: "",
              outputTextLength: 0,
              citationsCount: 0,
              toolAttemptCount: 0,
              successfulToolCount: 0,
              toolCallCount: 0,
              usage: ZERO_USAGE,
              costEstimate: ZERO_COST,
              finishReason: null,
              rawResponse: null,
              error: message,
            },
          };
        }
      })();

      launches.push({
        reserveInputTokens,
        reserveCostUsd,
        reserveOutputTokens,
        promise,
      });
      batchReservedInputTokens += reserveInputTokens;
      batchReservedCostUsd += reserveCostUsd;
      batchReservedOutputTokens += reserveOutputTokens;
    }

    if (launches.length === 0) {
      if (launchGuardStop) {
        console.log(
          `${logPrefix()} stop=${launchGuardStop} calls=${budgetState.callsExecuted} spent=${formatUsd(budgetState.totalChargedCostUsd)} est=${formatUsd(budgetState.totalEstimatedCostUsd)} total_evidence=${evidenceById.size}`,
        );
        break;
      }
      continue;
    }

    const results = await Promise.all(launches.map((launch) => launch.promise));
    let batchStopReason: string | null = null;

    for (const task of results) {
      const node = task.node;
      const children = task.children;
      const systemPrompt = task.systemPrompt;
      const userPrompt = task.userPrompt;
      const nodeWindowHours = task.nodeWindowHours;
      const rawCall = task.rawCall;

      updateBudgetState(budgetState, rawCall, args.ewmaAlpha);
      if (rawCall.status === 0) {
        consecutiveTransportFailures += 1;
      } else {
        consecutiveTransportFailures = 0;
      }
      const parseResult = parseAgentOutput(
        rawCall.outputText,
        args.strictSchema,
      );
      const routeCandidates: RouteCandidate[] = [];
      let newEvidenceCount = 0;
      let droppedByFreshnessCount = 0;
      let droppedBySourceCapCount = 0;
      let droppedByDomainPolicyCount = 0;
      let leafAssignmentFixesCount = 0;
      let assignedToSelfCount = 0;
      let assignedToChildCount = 0;
      let assignedNullCount = 0;
      let assignedWithSimilarityCount = 0;
      let assignedSimilaritySum = 0;
      let fallbackSuppressed = false;

      const agentData = parseResult.data;
      const newEvidence: MapEvidence[] = [];
      if (agentData) {
        const callStartedMs = Date.now();
        const freshnessCutoffMs = callStartedMs - nodeWindowHours * 3_600_000;
        const acceptedDomainCounts = new Map<string, number>();
        let acceptedUnconfirmedCount = 0;
        for (const itemEvidence of agentData.evidence.slice(
          0,
          args.maxEvidencePerCall,
        )) {
          const sourceDomain = normalizeSourceDomain(
            itemEvidence.source_url,
            itemEvidence.source_domain,
          );
          if (args.enforceFreshness) {
            const publishedAt = parseDateIso(itemEvidence.published_at);
            if (!publishedAt || publishedAt.getTime() < freshnessCutoffMs) {
              droppedByFreshnessCount += 1;
              continue;
            }
          }
          const domainCount = acceptedDomainCounts.get(sourceDomain) ?? 0;
          if (
            sourceDomain === "x.com" &&
            domainCount >= args.maxXEvidencePerCall
          ) {
            droppedBySourceCapCount += 1;
            continue;
          }
          if (
            !domainAllowedByPolicy(sourceDomain, sourceAllowSet, sourceDenySet)
          ) {
            droppedByDomainPolicyCount += 1;
            continue;
          }
          const reliability = normalizeEvidenceReliability(
            sourceDomain,
            itemEvidence.source_tier,
            itemEvidence.confirmation,
          );
          if (
            reliability.confirmation === "unconfirmed" &&
            acceptedUnconfirmedCount >= args.maxUnconfirmedEvidencePerCall
          ) {
            droppedBySourceCapCount += 1;
            continue;
          }
          const evidenceId = buildEvidenceId({
            sourceUrl: itemEvidence.source_url,
            headline: itemEvidence.headline,
          });
          if (evidenceById.has(evidenceId)) continue;
          acceptedDomainCounts.set(sourceDomain, domainCount + 1);
          const evidence: MapEvidence = {
            id: evidenceId,
            headline: itemEvidence.headline,
            summary: itemEvidence.summary,
            sourceUrl: itemEvidence.source_url,
            sourceDomain,
            publishedAt: itemEvidence.published_at,
            authorHandle: itemEvidence.author_handle,
            confirmation: reliability.confirmation,
            sourceTier: reliability.sourceTier,
            relevance: itemEvidence.relevance,
            confidence: itemEvidence.confidence,
            callIndex: budgetState.callsExecuted,
            nodeId: node.id,
            embedding: null,
            assignedNodeId: null,
            assignedSimilarity: null,
            routeMethod: "none",
            routeBestChildId: null,
            routeBestScore: null,
            routeSecondScore: null,
            routeMargin: null,
            routeThresholdUsed: null,
            routeReason: null,
          };
          evidenceById.set(evidence.id, evidence);
          newEvidence.push(evidence);
          if (evidence.confirmation === "unconfirmed") {
            acceptedUnconfirmedCount += 1;
          }
          pushNodeHeadline(node.id, evidence.headline);
        }
      }
      droppedByFreshnessTotal += droppedByFreshnessCount;
      droppedBySourceCapTotal += droppedBySourceCapCount;
      droppedByDomainPolicyTotal += droppedByDomainPolicyCount;

      if (newEvidence.length > 0 && openRouterKey) {
        try {
          const texts = newEvidence.map(
            (evidence) =>
              `${evidence.headline}\n${evidence.summary}\nconfirmation:${evidence.confirmation}\nsource_tier:${evidence.sourceTier}`,
          );
          const vectors = await fetchOpenRouterEmbeddings(
            openRouterKey,
            args.embedModel,
            texts,
          );
          for (let i = 0; i < newEvidence.length; i += 1) {
            newEvidence[i].embedding = vectors[i] ?? null;
          }
        } catch (error) {
          console.warn(`${logPrefix()} evidence embedding failed`, {
            err: error instanceof Error ? error.message : String(error),
          });
        }
      }

      if (newEvidence.length > 0 && children.length > 0) {
        const childScore = new Map<
          string,
          {
            score: number;
            evidenceCount: number;
            simSum: number;
          }
        >();
        const childCentroids = new Map<string, number[] | null>();
        const childRepresentativeEmbeddings = new Map<
          string,
          number[] | null
        >();
        for (const child of children) {
          childCentroids.set(child.id, await getNodeCentroid(child.id));
          childRepresentativeEmbeddings.set(
            child.id,
            await getNodeRepresentativeEmbedding(child.id),
          );
        }
        const routeThresholdUsed = getRouteThresholdForLevel(node.level, args);
        const routeMinMarginUsed = getRouteMinMarginForLevel(node.level, args);

        for (const evidence of newEvidence) {
          const evidenceText = `${evidence.headline} ${evidence.summary}`;
          const method: MapEvidence["routeMethod"] = evidence.embedding
            ? "hybrid"
            : "lexical_only";
          let bestChildId: string | null = null;
          let bestScore = -1;
          let secondScore = -1;

          for (const child of children) {
            const lexicalScore = lexicalSimilarity(
              evidenceText,
              nodeDisplayLabel(child),
            );
            let score = lexicalScore;
            if (evidence.embedding) {
              const centroid = childCentroids.get(child.id) ?? null;
              const representative =
                childRepresentativeEmbeddings.get(child.id) ?? null;
              const centroidScore = centroid
                ? Math.max(0, dot(evidence.embedding, centroid))
                : 0;
              const representativeScore = representative
                ? Math.max(0, dot(evidence.embedding, representative))
                : 0;
              score =
                0.65 * centroidScore +
                0.2 * representativeScore +
                0.15 * lexicalScore;
            }
            if (score > bestScore) {
              secondScore = bestScore;
              bestScore = score;
              bestChildId = child.id;
            } else if (score > secondScore) {
              secondScore = score;
            }
          }

          if (!bestChildId) {
            evidence.assignedNodeId = node.id;
            evidence.assignedSimilarity = null;
            evidence.routeMethod = "none";
            evidence.routeBestChildId = null;
            evidence.routeBestScore = null;
            evidence.routeSecondScore = null;
            evidence.routeMargin = null;
            evidence.routeThresholdUsed = routeThresholdUsed;
            evidence.routeReason = "no_candidate";
            continue;
          }

          const margin = bestScore - Math.max(0, secondScore);
          evidence.routeMethod = method;
          evidence.routeBestChildId = bestChildId;
          evidence.routeBestScore = Number(bestScore.toFixed(6));
          evidence.routeSecondScore =
            secondScore >= 0 ? Number(secondScore.toFixed(6)) : null;
          evidence.routeMargin = Number(margin.toFixed(6));
          evidence.routeThresholdUsed = routeThresholdUsed;

          const minSimilarityPass =
            args.routeMinSimilarity <= 0 ||
            bestScore >= args.routeMinSimilarity;
          if (
            bestScore >= routeThresholdUsed &&
            margin >= routeMinMarginUsed &&
            minSimilarityPass
          ) {
            evidence.assignedNodeId = bestChildId;
            evidence.assignedSimilarity = Number(bestScore.toFixed(6));
            evidence.routeReason = "assigned_child";
            const current = childScore.get(bestChildId) ?? {
              score: 0,
              evidenceCount: 0,
              simSum: 0,
            };
            current.score +=
              evidence.relevance + evidence.confidence + bestScore;
            current.evidenceCount += 1;
            current.simSum += bestScore;
            childScore.set(bestChildId, current);
          } else {
            evidence.assignedNodeId = node.id;
            evidence.assignedSimilarity = null;
            evidence.routeReason =
              bestScore < routeThresholdUsed
                ? "below_threshold"
                : !minSimilarityPass
                  ? "below_min_similarity"
                  : "low_margin";
          }
        }

        const rankedChildren = Array.from(childScore.entries())
          .map(([childId, stats]) => ({
            childId,
            score: stats.score,
            evidenceCount: stats.evidenceCount,
            avgSimilarity:
              stats.evidenceCount > 0 ? stats.simSum / stats.evidenceCount : 0,
          }))
          .sort(
            (a, b) =>
              b.score - a.score ||
              b.evidenceCount - a.evidenceCount ||
              b.avgSimilarity - a.avgSimilarity,
          );
        for (const route of rankedChildren) {
          routeCandidates.push(route);
        }
        for (const route of rankedChildren.slice(0, args.branchPerCall)) {
          const child = nodeById.get(route.childId);
          if (!child) continue;
          if (visited.has(child.id)) continue;
          const base = Math.log10(1 + Math.max(1, child.sumVolume24h));
          const routePriority =
            base * 0.2 + route.score + route.evidenceCount * 0.35;
          addQueueItem(queue, queued, {
            nodeId: child.id,
            priority: applySameRunNoveltyPriority(child.id, routePriority),
            reason: `route:${node.id}`,
          });
        }
      }

      if (children.length === 0) {
        for (const evidence of newEvidence) {
          evidence.routeMethod = "none";
          evidence.routeBestChildId = null;
          evidence.routeBestScore = null;
          evidence.routeSecondScore = null;
          evidence.routeMargin = null;
          evidence.routeThresholdUsed = getRouteThresholdForLevel(
            node.level,
            args,
          );
          evidence.routeReason = "leaf_self";
          if (!evidence.assignedNodeId) {
            evidence.assignedNodeId = node.id;
            evidence.assignedSimilarity = null;
            leafAssignmentFixesCount += 1;
          }
        }
      }

      for (const evidence of newEvidence) {
        if (!evidence.assignedNodeId) {
          evidence.assignedNodeId = node.id;
          evidence.assignedSimilarity = null;
          if (!evidence.routeReason) {
            evidence.routeMethod = "none";
            evidence.routeBestChildId = null;
            evidence.routeBestScore = null;
            evidence.routeSecondScore = null;
            evidence.routeMargin = null;
            evidence.routeThresholdUsed = getRouteThresholdForLevel(
              node.level,
              args,
            );
            evidence.routeReason =
              children.length === 0 ? "leaf_self" : "no_candidate";
          }
          leafAssignmentFixesCount += 1;
        }
        const assigned = evidence.assignedNodeId ?? node.id;
        assignEvidenceToNode(assigned, evidence.id);
        if (!assigned) {
          assignedNullCount += 1;
        } else if (assigned === node.id) {
          assignedToSelfCount += 1;
        } else {
          assignedToChildCount += 1;
        }
        if (evidence.assignedSimilarity != null) {
          assignedWithSimilarityCount += 1;
          assignedSimilaritySum += evidence.assignedSimilarity;
        }
      }
      leafAssignmentFixesTotal += leafAssignmentFixesCount;
      newEvidenceCount = newEvidence.length;

      const lowYieldHighTools =
        rawCall.ok &&
        newEvidenceCount === 0 &&
        rawCall.toolAttemptCount >= args.lowYieldToolAttemptThreshold;
      consecutiveLowYieldHighTools = lowYieldHighTools
        ? consecutiveLowYieldHighTools + 1
        : 0;
      fallbackSuppressed =
        lowYieldHighTools &&
        consecutiveLowYieldHighTools >= args.lowYieldConsecutiveThreshold;

      if (
        rawCall.ok &&
        (newEvidence.length === 0 || assignedToChildCount === 0) &&
        children.length > 0 &&
        !fallbackSuppressed
      ) {
        const fallbackChildren = children
          .slice()
          .sort(
            (a, b) =>
              b.sumVolume24h - a.sumVolume24h ||
              b.eventCount - a.eventCount ||
              a.id.localeCompare(b.id),
          )
          .slice(0, Math.max(1, args.branchPerCall));
        for (const fallback of fallbackChildren) {
          if (visited.has(fallback.id)) continue;
          addQueueItem(queue, queued, {
            nodeId: fallback.id,
            priority: applySameRunNoveltyPriority(
              fallback.id,
              Math.log10(1 + Math.max(1, fallback.sumVolume24h)) * 0.1,
            ),
            reason: `fallback:${node.id}`,
          });
        }
      }
      if (fallbackSuppressed) {
        fallbackSuppressedTotal += 1;
      }

      const hardFailureStop =
        !rawCall.ok &&
        (rawCall.status === 400 ||
          rawCall.status === 401 ||
          rawCall.status === 403)
          ? `hard_fail_http_${rawCall.status}`
          : null;
      const budgetStopAfter =
        hardFailureStop ??
        (consecutiveTransportFailures >= 2 ? "hard_fail_transport" : null) ??
        (rawCall.toolAttemptCount > args.maxToolAttemptsPerCall
          ? "max_tool_attempts_per_call"
          : evaluateBudgetStop(args, budgetState));

      const record: NodeCallRecord = {
        callIndex: budgetState.callsExecuted,
        nodeId: node.id,
        nodeLabel: nodeDisplayLabel(node),
        level: node.level,
        parentId: node.parentId,
        statusCode: rawCall.status,
        ok: rawCall.ok,
        durationMs: rawCall.durationMs,
        parseStatus: parseResult.valid ? "valid" : "invalid",
        parseError: parseResult.parseError,
        agentStatus: agentData?.status ?? null,
        returnedEvidenceCount: agentData?.evidence.length ?? 0,
        newEvidenceCount,
        droppedByFreshnessCount,
        droppedBySourceCapCount,
        droppedByDomainPolicyCount,
        leafAssignmentFixesCount,
        assignedToSelfCount,
        assignedToChildCount,
        assignedNullCount,
        assignedWithSimilarityCount,
        assignedAvgSimilarity:
          assignedWithSimilarityCount > 0
            ? Number(
                (assignedSimilaritySum / assignedWithSimilarityCount).toFixed(
                  6,
                ),
              )
            : null,
        fallbackSuppressed,
        routeCandidates: routeCandidates.slice(0, args.branchPerCall),
        toolAttemptCount: rawCall.toolAttemptCount,
        successfulToolCount: rawCall.successfulToolCount,
        toolCallCount: rawCall.toolCallCount,
        usage: rawCall.usage,
        costEstimate: rawCall.costEstimate,
        promptPreview: preview(userPrompt, 220),
        promptChars: systemPrompt.length + userPrompt.length,
        outputPreview: rawCall.outputPreview,
        finishReason: rawCall.finishReason,
        error: rawCall.error,
        budgetStop: budgetStopAfter,
        returnedEvidence: (agentData?.evidence ?? []).map(
          toEvidencePreviewFromAgent,
        ),
        newEvidence: newEvidence.map(toEvidencePreviewFromMapEvidence),
      };
      callRecords.push(record);

      if (!args.verbose) {
        console.log(
          `${logPrefix()} call_done #${record.callIndex} status=${record.statusCode} parse=${record.parseStatus} new_ev=${record.newEvidenceCount} drop_fresh=${record.droppedByFreshnessCount} drop_src=${record.droppedBySourceCapCount} drop_dom=${record.droppedByDomainPolicyCount} tools=${record.toolAttemptCount} cost=${formatUsd(record.costEstimate.chargedCostUsd)} src=${record.costEstimate.costSource} stop=${record.budgetStop ?? "-"} err=${record.error ? preview(record.error, 120) : "-"}`,
        );
      }

      await writeCheckpoint("after_call");

      if (args.verbose) {
        console.log(`${logPrefix()} call`, {
          idx: record.callIndex,
          nodeId: record.nodeId,
          level: record.level,
          ok: record.ok,
          status: record.statusCode,
          parse: record.parseStatus,
          agentStatus: record.agentStatus,
          returnedEvidenceCount: record.returnedEvidenceCount,
          newEvidenceCount: record.newEvidenceCount,
          droppedByFreshnessCount: record.droppedByFreshnessCount,
          droppedBySourceCapCount: record.droppedBySourceCapCount,
          droppedByDomainPolicyCount: record.droppedByDomainPolicyCount,
          assignedToSelfCount: record.assignedToSelfCount,
          assignedToChildCount: record.assignedToChildCount,
          assignedWithSimilarityCount: record.assignedWithSimilarityCount,
          assignedAvgSimilarity: record.assignedAvgSimilarity,
          fallbackSuppressed: record.fallbackSuppressed,
          toolAttempts: record.toolAttemptCount,
          chargedCostUsd: Number(record.costEstimate.chargedCostUsd.toFixed(6)),
          estimatedCostUsd: Number(
            record.costEstimate.estimatedCostUsd.toFixed(6),
          ),
          costSource: record.costEstimate.costSource,
          budgetStop: record.budgetStop,
        });
      }

      if (budgetStopAfter && !batchStopReason) {
        batchStopReason = budgetStopAfter;
      }
    }

    if (batchStopReason) {
      console.log(
        `${logPrefix()} stop=${batchStopReason} calls=${budgetState.callsExecuted} spent=${formatUsd(budgetState.totalChargedCostUsd)} est=${formatUsd(budgetState.totalEstimatedCostUsd)} total_evidence=${evidenceById.size}`,
      );
      break;
    }
  }

  const leafRows = Array.from(leafEvidenceIds.entries())
    .map(([nodeId, ids]) => {
      const node = nodeById.get(nodeId);
      if (!node) return null;
      return {
        nodeId,
        level: node.level,
        label: nodeDisplayLabel(node),
        eventCount: node.eventCount,
        evidenceCount: ids.size,
        volume24h: node.sumVolume24h,
      };
    })
    .filter((row): row is NonNullable<typeof row> => row != null)
    .sort(
      (a, b) =>
        b.evidenceCount - a.evidenceCount ||
        b.volume24h - a.volume24h ||
        a.nodeId.localeCompare(b.nodeId),
    );

  const topLeaves = leafRows.slice(0, args.reportTopLeaves);
  const topEvidence = Array.from(evidenceById.values())
    .sort(
      (a, b) =>
        b.relevance + b.confidence - (a.relevance + a.confidence) ||
        a.id.localeCompare(b.id),
    )
    .slice(0, args.reportTopEvidence);

  const markdownLines: string[] = [];
  markdownLines.push("# AI Map Search Smoke Report");
  markdownLines.push("");
  markdownLines.push(`- run_id: \`${runId}\``);
  markdownLines.push(`- map_generated_at: ${snapshot.meta.generatedAt}`);
  markdownLines.push(`- calls_executed: ${budgetState.callsExecuted}`);
  markdownLines.push(`- evidence_total: ${evidenceById.size}`);
  markdownLines.push(
    `- spent_usd_charged: ${formatUsd(budgetState.totalChargedCostUsd)}`,
  );
  markdownLines.push(
    `- spent_usd_est: ${formatUsd(budgetState.totalEstimatedCostUsd)}`,
  );
  markdownLines.push(
    `- token_totals: input=${budgetState.totalInputTokens}, output=${budgetState.totalOutputTokens}`,
  );
  markdownLines.push("");
  markdownLines.push("## Newsline");
  markdownLines.push("");
  if (topEvidence.length === 0) {
    markdownLines.push("- No evidence collected.");
  } else {
    for (const evidence of topEvidence.slice(0, 10)) {
      const when = parseDateIso(evidence.publishedAt)
        ? evidence.publishedAt
        : "unknown_time";
      markdownLines.push(
        `- ${evidence.headline} — ${evidence.summary} (${evidence.sourceDomain}, ${when})`,
      );
    }
  }
  markdownLines.push("");
  markdownLines.push("## Top Leaf Clusters");
  markdownLines.push("");
  if (topLeaves.length === 0) {
    markdownLines.push("- No routed leaf clusters.");
  } else {
    for (const row of topLeaves) {
      const path = buildNodePathLabels(row.nodeId, nodeById).join(" > ");
      markdownLines.push(
        `- ${row.label} | evidence=${row.evidenceCount} | volume24h=${row.volume24h.toFixed(2)} | path=${path}`,
      );
      const events = (await getNodeEvents(row.nodeId)).slice(0, 3);
      for (const event of events) {
        const base = `/events/${encodeURIComponent(event.eventId)}`;
        const href = event.representativeMarketId
          ? `${base}?market=${encodeURIComponent(event.representativeMarketId)}`
          : base;
        markdownLines.push(`  - [${event.title}](${href})`);
      }
    }
  }
  markdownLines.push("");
  markdownLines.push("## Calls");
  markdownLines.push("");
  for (const call of callRecords) {
    markdownLines.push(
      `- #${call.callIndex} node=${call.nodeLabel} level=${call.level} status=${call.statusCode} parse=${call.parseStatus} evidence=${call.newEvidenceCount}/${call.returnedEvidenceCount} tools=${call.toolAttemptCount} cost=${formatUsd(call.costEstimate.chargedCostUsd)} src=${call.costEstimate.costSource} stop=${call.budgetStop ?? "-"}`,
    );
  }
  const markdownReport = markdownLines.join("\n");

  const report = {
    qaContract: {
      version: QA_CONTRACT_VERSION,
      script: activeRunContext.qaScriptName,
      generatedAt: new Date().toISOString(),
    },
    generatedAt: new Date().toISOString(),
    run: {
      runId,
      mapGeneratedAt: snapshot.meta.generatedAt,
      mapVersion: snapshot.meta.version,
      projectionMethod: snapshot.meta.projectionMethod,
      projectionFallback: snapshot.meta.projectionFallback,
      venues: snapshot.meta.venues,
      depth: snapshot.meta.depth,
      eventCountTotal: snapshot.meta.eventCountTotal,
      nodeCountTotal: nodes.length,
    },
    config: {
      ...args,
      out: args.out,
      reportOut: args.reportOut,
    },
    totals: {
      durationMs: Date.now() - startedAt,
      callsExecuted: budgetState.callsExecuted,
      nodesVisited: visited.size,
      queueRemaining: queue.length,
      evidenceTotal: evidenceById.size,
      inputTokens: budgetState.totalInputTokens,
      outputTokens: budgetState.totalOutputTokens,
      toolAttempts: budgetState.totalToolAttempts,
      estimatedTotalCostUsd: Number(
        budgetState.totalEstimatedCostUsd.toFixed(6),
      ),
      chargedTotalCostUsd: Number(budgetState.totalChargedCostUsd.toFixed(6)),
      providerReportedCostUsd: Number(
        budgetState.totalProviderReportedCostUsd.toFixed(6),
      ),
      providerReportedCostCalls: budgetState.providerReportedCostCalls,
      expectedNextInputTokens: Math.round(budgetState.expectedNextInputTokens),
      expectedNextCallCostUsd: Number(
        budgetState.expectedNextCallCostUsd.toFixed(6),
      ),
      expectedNextOutputTokens: Math.round(
        budgetState.expectedNextOutputTokens,
      ),
      droppedByFreshnessTotal,
      droppedBySourceCapTotal,
      droppedByDomainPolicyTotal,
      leafAssignmentFixesTotal,
      fallbackSuppressedTotal,
      consecutiveTransportFailures,
      resumeLoaded,
      sameRunSeedCandidates,
      sameRunSeedAssigned,
      warmStartCandidates,
      warmStartAssigned,
      topLeaves: topLeaves.length,
    },
    callsCompact: callRecords.map((call) => ({
      callIndex: call.callIndex,
      nodeId: call.nodeId,
      nodeLabel: call.nodeLabel,
      statusCode: call.statusCode,
      parseStatus: call.parseStatus,
      returnedEvidenceCount: call.returnedEvidenceCount,
      newEvidenceCount: call.newEvidenceCount,
      droppedByFreshnessCount: call.droppedByFreshnessCount,
      droppedBySourceCapCount: call.droppedBySourceCapCount,
      droppedByDomainPolicyCount: call.droppedByDomainPolicyCount,
      assignedToSelfCount: call.assignedToSelfCount,
      assignedToChildCount: call.assignedToChildCount,
      assignedNullCount: call.assignedNullCount,
      assignedWithSimilarityCount: call.assignedWithSimilarityCount,
      assignedAvgSimilarity: call.assignedAvgSimilarity,
      fallbackSuppressed: call.fallbackSuppressed,
      budgetStop: call.budgetStop,
    })),
    evidence: Array.from(evidenceById.values())
      .sort(
        (a, b) =>
          a.callIndex - b.callIndex ||
          b.relevance + b.confidence - (a.relevance + a.confidence),
      )
      .map((evidence) => ({
        id: evidence.id,
        callIndex: evidence.callIndex,
        nodeId: evidence.nodeId,
        assignedNodeId: evidence.assignedNodeId,
        assignedSimilarity: evidence.assignedSimilarity,
        ...toEvidencePreviewFromMapEvidence(evidence),
      })),
    topLeaves,
    topEvidence: topEvidence.map((evidence) => ({
      id: evidence.id,
      headline: evidence.headline,
      summary: evidence.summary,
      sourceUrl: evidence.sourceUrl,
      sourceDomain: evidence.sourceDomain,
      publishedAt: evidence.publishedAt,
      confirmation: evidence.confirmation,
      sourceTier: evidence.sourceTier,
      relevance: evidence.relevance,
      confidence: evidence.confidence,
      assignedNodeId: evidence.assignedNodeId,
      assignedSimilarity: evidence.assignedSimilarity,
      routeMethod: evidence.routeMethod,
      routeBestChildId: evidence.routeBestChildId,
      routeBestScore: evidence.routeBestScore,
      routeSecondScore: evidence.routeSecondScore,
      routeMargin: evidence.routeMargin,
      routeThresholdUsed: evidence.routeThresholdUsed,
      routeReason: evidence.routeReason,
      nodeId: evidence.nodeId,
      callIndex: evidence.callIndex,
    })),
    calls: callRecords.map((call) => serializeCallRecord(call, args)),
    markdownReport: args.leanOutput ? undefined : markdownReport,
  };

  if (
    args.persistenceMode === "artifact_only" ||
    args.persistenceMode === "normalized_keys"
  ) {
    await redis.set(mapSearchArtifactKey(runId), JSON.stringify(report), {
      EX: args.artifactTtlSec,
    });
    await redis.set(MAP_SEARCH_LATEST_KEY, runId, { EX: args.artifactTtlSec });
    await redis.set(
      mapSearchLatestForMapRunKey(runId),
      JSON.stringify({
        runId,
        completedAt: nowIso(),
      }),
      { EX: args.artifactTtlSec },
    );
  }

  if (args.persistenceMode === "normalized_keys") {
    const finalResumePayload: ResumeStatePayload = {
      version: "map_search_resume_v1",
      runId,
      at: nowIso(),
      state: args.dryRun ? "dry_run" : "completed",
      reason: "completed",
      resume: {
        queue: queue.slice(0, 1_500),
        visited: Array.from(visited),
        budgetState: { ...budgetState },
        droppedByFreshnessTotal,
        droppedBySourceCapTotal,
        droppedByDomainPolicyTotal,
        leafAssignmentFixesTotal,
        fallbackSuppressedTotal,
        consecutiveTransportFailures,
        consecutiveLowYieldHighTools,
        evidence: Array.from(evidenceById.values()).map(toPersistedEvidence),
        callRecords: callRecords.slice(),
      },
    };
    await redis.set(
      mapSearchStateKey(runId),
      JSON.stringify(finalResumePayload),
      {
        EX: args.stateTtlSec,
      },
    );
    await setSearchStatus(
      redis,
      mapSearchRunStatusKey(runId),
      args.statusTtlSec,
      {
        state: args.dryRun ? "dry_run" : "completed",
        reason: "completed",
        runId,
        at: nowIso(),
        callsExecuted: budgetState.callsExecuted,
        evidenceTotal: evidenceById.size,
        chargedCostUsd: Number(budgetState.totalChargedCostUsd.toFixed(6)),
        estimatedCostUsd: Number(budgetState.totalEstimatedCostUsd.toFixed(6)),
        reuseMode: args.reuseMode,
        resumeLoaded: resumeLoaded ? 1 : 0,
        sameRunSeedAssigned,
        warmStartAssigned,
      },
    );
    await setSearchStatus(
      redis,
      `${MAP_SEARCH_KEY_PREFIX}:status:last`,
      args.statusTtlSec,
      {
        state: args.dryRun ? "dry_run" : "completed",
        reason: "completed",
        runId,
        at: nowIso(),
        callsExecuted: budgetState.callsExecuted,
        evidenceTotal: evidenceById.size,
        chargedCostUsd: Number(budgetState.totalChargedCostUsd.toFixed(6)),
        estimatedCostUsd: Number(budgetState.totalEstimatedCostUsd.toFixed(6)),
        reuseMode: args.reuseMode,
        resumeLoaded: resumeLoaded ? 1 : 0,
        sameRunSeedAssigned,
        warmStartAssigned,
      },
    );
  }

  if (!args.dryRun) {
    const nowMs = Date.now();
    const evidenceItems = Array.from(evidenceById.values());
    if (evidenceItems.length > 0) {
      for (const evidence of evidenceItems) {
        await redis.set(
          mapSearchEvidenceDocKey(evidence.id),
          JSON.stringify({
            ...toPersistedEvidence(evidence),
            runId,
            capturedAt: nowIso(),
          }),
          {
            EX: Math.max(
              args.artifactTtlSec,
              MAP_SEARCH_RECENT_EVIDENCE_TTL_SEC,
            ),
          },
        );
        const publishedTs =
          parseDateIso(evidence.publishedAt)?.getTime() ?? nowMs;
        await redis.zAdd(MAP_SEARCH_RECENT_EVIDENCE_KEY, {
          score: publishedTs,
          value: evidence.id,
        });
        if (evidence.embedding && evidence.embedding.length > 0) {
          await redis.set(
            mapSearchNewsEmbeddingKey(evidence.id),
            JSON.stringify(evidence.embedding),
            {
              EX: Math.max(
                args.artifactTtlSec,
                MAP_SEARCH_RECENT_EVIDENCE_TTL_SEC,
              ),
            },
          );
        }
      }
      await redis.expire(
        MAP_SEARCH_RECENT_EVIDENCE_KEY,
        MAP_SEARCH_RECENT_EVIDENCE_TTL_SEC,
      );
      await redis.zRemRangeByScore(
        MAP_SEARCH_RECENT_EVIDENCE_KEY,
        0,
        nowMs - MAP_SEARCH_RECENT_EVIDENCE_TTL_SEC * 1000,
      );
    }
  }

  if (args.out) {
    await writeFile(args.out, JSON.stringify(report, null, 2), "utf8");
    console.log(`${logPrefix()} wrote ${args.out}`);
  }
  if (args.reportOut) {
    await writeFile(args.reportOut, markdownReport, "utf8");
    console.log(`${logPrefix()} wrote ${args.reportOut}`);
  }

  console.log(
    `${logPrefix()} done calls=${budgetState.callsExecuted} evidence=${evidenceById.size} spent=${formatUsd(budgetState.totalChargedCostUsd)} est=${formatUsd(budgetState.totalEstimatedCostUsd)} duration_ms=${Date.now() - startedAt}`,
  );
  if (!args.out) {
    console.log(
      JSON.stringify(
        {
          runId,
          callsExecuted: budgetState.callsExecuted,
          evidenceTotal: evidenceById.size,
          estimatedTotalCostUsd: Number(
            budgetState.totalEstimatedCostUsd.toFixed(6),
          ),
          chargedTotalCostUsd: Number(
            budgetState.totalChargedCostUsd.toFixed(6),
          ),
          topLeaves,
        },
        null,
        2,
      ),
    );
  }
  await redis.quit();
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
  runMapSearch().catch(async (error) => {
    console.error(`${logPrefix()} failed`, error);
    process.exit(1);
  });
}

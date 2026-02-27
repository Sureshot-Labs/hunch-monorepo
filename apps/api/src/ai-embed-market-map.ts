import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { createRedisClient, ensureRedis } from "@hunch/infra";
import { PCA } from "ml-pca";
import { RESP_TYPES } from "redis";
import { UMAP } from "umap-js";
import { pool } from "./db.js";
import { env } from "./env.js";
import {
  getOpenRouterModelPricingPerM,
} from "./lib/ai-pricing.js";
import { extractProviderCostUsd, resolveAiCost } from "./lib/ai-cost.js";
import {
  buildMarketMapNodeId,
  type MarketMapEventSummary,
  marketMapActiveKey,
  MARKET_MAP_DEFAULT_VENUES,
  type MarketMapMeta,
  type MarketMapNode,
  type MarketMapNodeVenueMetrics,
  marketMapRunMetaKey,
  marketMapRunNodeEventsKey,
  marketMapRunNodeKey,
  marketMapRunNodesGlobalKey,
  normalizeMarketMapVenues,
  type MarketMapVenue,
} from "./services/market-map.js";
import {
  resolveMarketMapPolicy,
  type MarketMapPolicy,
} from "./services/runtime-policies.js";

const MARKET_MAP_VERSION = "v1";
const DEFAULT_MAX_AI_LABELS_PER_RUN = 400;
const DEFAULT_AI_LABEL_TIMEOUT_MS = 8_000;
const DEFAULT_AI_LABEL_CONCURRENCY = 4;
const DEFAULT_LABEL_PRICE_INPUT_PER_M = 0.05;
const DEFAULT_LABEL_PRICE_OUTPUT_PER_M = 0.4;

type EventCandidateRow = {
  event_id: string;
  venue: MarketMapVenue;
  title: string | null;
  event_image: string | null;
  event_icon: string | null;
  volume24h: unknown;
  liquidity: unknown;
  open_interest: unknown;
  score: unknown;
  representative_market_id: string | null;
  representative_market_title: string | null;
  representative_market_image: string | null;
  representative_market_icon: string | null;
};

type EventPoint = {
  eventId: string;
  venue: MarketMapVenue;
  title: string;
  representativeMarketId: string | null;
  representativeMarketTitle: string | null;
  image: string | null;
  icon: string | null;
  volume24h: number;
  liquidity: number;
  openInterest: number;
  score: number;
  vector: number[];
  x: number;
  y: number;
};

type BuildConfig = {
  enabled: boolean;
  venues: MarketMapVenue[];
  depth: number;
  k1: number;
  k2: number;
  k3: number;
  maxEventsPerVenue: number;
  ttlSec: number;
  minEventVolume24h: number;
  minEventLiquidity: number;
  labelAiEnabled: boolean;
  labelLevels: number[];
  labelModel: string;
  labelMaxTokens: number;
  labelChildSamplesMax: number;
  labelSiblingSamplesMax: number;
  labelSampleMaxChars: number;
  maxAiLabelsPerRun: number;
  projectionPcaDims: number;
  projectionUmapNeighbors: number;
  projectionUmapMinDist: number;
  projectionSeed: number;
  projectionBudgetMs: number;
  debugLogs: boolean;
  dryRun: boolean;
};

type BuildResult = {
  nodes: MarketMapNode[];
  byNodeEvents: Map<string, MarketMapEventSummary[]>;
  meta: Omit<MarketMapMeta, "runId">;
  labelCostSummary: LabelCostSummary;
};

type AiLabelResponse = {
  label?: unknown;
};

type AiLabelResult = {
  label: string | null;
  reason:
    | "ok"
    | "timeout"
    | "http_error"
    | "empty_content"
    | "json_parse_failed"
    | "invalid_schema"
    | "generic_label";
  statusCode?: number;
  detail?: string;
  finishReason?: string | null;
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  reasoningTokens?: number;
  promptChars?: number;
  providerCostUsd?: number | null;
  providerCostField?: string | null;
  providerCostUsdTicks?: number | null;
};

type LabelCostSummary = {
  attempted: number;
  labeled: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  reasoningTokens: number;
  estimatedCostUsd: number;
  chargedCostUsd: number;
  providerReportedCostUsd: number;
  providerReportedCostCalls: number;
  providerReportedCostShare: number;
};

type MarketMapBuildRunResult = {
  status: "completed" | "dry_run" | "skipped_disabled";
  source: "env" | "db";
  effectiveAt: string | null;
  redisRunId: string | null;
  eventCountTotal: number;
  nodeCountTotal: number;
  projectionMethod: "umap" | "pca2";
  projectionFallback: boolean;
  projectionDurationMs: number;
  buildDurationMs: number;
  labelCostSummary: LabelCostSummary;
};

type LabelPromptPayload = {
  system: string;
  user: string;
  promptChars: number;
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

function parseBoolean(value: string | undefined): boolean | undefined {
  if (!value) return undefined;
  const normalized = value.trim().toLowerCase();
  const token = normalized
    .split(/[\s,]+/)[0]
    .replace(/^['"]+/, "")
    .replace(/['"]+$/, "");
  if (
    token === "1" ||
    token === "true" ||
    token === "yes" ||
    token === "on"
  ) {
    return true;
  }
  if (
    token === "0" ||
    token === "false" ||
    token === "no" ||
    token === "off"
  ) {
    return false;
  }
  return undefined;
}

function parseNumber(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function emptyLabelCostSummary(): LabelCostSummary {
  return {
    attempted: 0,
    labeled: 0,
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    reasoningTokens: 0,
    estimatedCostUsd: 0,
    chargedCostUsd: 0,
    providerReportedCostUsd: 0,
    providerReportedCostCalls: 0,
    providerReportedCostShare: 0,
  };
}

async function forEachConcurrent<T>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<void>,
): Promise<void> {
  if (items.length === 0) return;
  const limit = clamp(Math.trunc(concurrency), 1, items.length);
  let nextIndex = 0;
  const runners = Array.from({ length: limit }, async () => {
    while (true) {
      const current = nextIndex;
      nextIndex += 1;
      if (current >= items.length) return;
      await worker(items[current], current);
    }
  });
  await Promise.all(runners);
}

function toNumber(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : 0;
}

function normalizeOptionalUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed;
}

function normalizeVector(values: readonly number[]): number[] {
  let norm = 0;
  for (const value of values) norm += value * value;
  if (!Number.isFinite(norm) || norm <= 0) return Array.from(values, () => 0);
  const mag = Math.sqrt(norm);
  return values.map((value) => value / mag);
}

function dot(a: readonly number[], b: readonly number[]): number {
  const size = Math.min(a.length, b.length);
  let sum = 0;
  for (let i = 0; i < size; i += 1) sum += a[i] * b[i];
  return sum;
}

function cosineDistance(a: readonly number[], b: readonly number[]): number {
  return 1 - dot(a, b);
}

function parseEmbeddingBuffer(buffer: Buffer): number[] | null {
  if (!buffer || buffer.length === 0 || buffer.length % 4 !== 0) return null;
  const aligned = new ArrayBuffer(buffer.byteLength);
  new Uint8Array(aligned).set(buffer);
  const view = new Float32Array(aligned);
  return normalizeVector(Array.from(view));
}

function mulberry32(seed: number): () => number {
  let t = seed >>> 0;
  return () => {
    t += 0x6d2b79f5;
    let x = Math.imul(t ^ (t >>> 15), 1 | t);
    x ^= x + Math.imul(x ^ (x >>> 7), 61 | x);
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

function normalizeCoordinates(points: number[][]): number[][] {
  if (points.length === 0) return [];
  let minX = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const [x, y] of points) {
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  const rangeX = maxX - minX;
  const rangeY = maxY - minY;
  return points.map(([x, y]) => {
    const nx = rangeX > 0 ? ((x - minX) / rangeX) * 2 - 1 : 0;
    const ny = rangeY > 0 ? ((y - minY) / rangeY) * 2 - 1 : 0;
    return [nx, ny];
  });
}

function projectPca2(matrix: number[][], pcaDims: number): number[][] {
  if (matrix.length === 0) return [];
  const dims = Math.max(2, Math.min(pcaDims, matrix[0].length));
  const pca = new PCA(matrix, { center: true, scale: false });
  const reduced = pca.predict(matrix, { nComponents: dims }).to2DArray();
  return reduced.map((row) => [row[0] ?? 0, row[1] ?? 0]);
}

function projectUmap(
  matrix: number[][],
  config: Pick<
    BuildConfig,
    | "projectionPcaDims"
    | "projectionUmapNeighbors"
    | "projectionUmapMinDist"
    | "projectionSeed"
  >,
): number[][] {
  if (matrix.length === 0) return [];
  const dims = Math.max(2, Math.min(config.projectionPcaDims, matrix[0].length));
  const pca = new PCA(matrix, { center: true, scale: false });
  const reduced = pca.predict(matrix, { nComponents: dims }).to2DArray();
  const neighbors = Math.max(
    2,
    Math.min(config.projectionUmapNeighbors, Math.max(2, reduced.length - 1)),
  );
  const umap = new UMAP({
    nComponents: 2,
    nNeighbors: neighbors,
    minDist: config.projectionUmapMinDist,
    distanceFn: cosineDistance,
    random: mulberry32(config.projectionSeed),
  });
  return umap.fit(reduced);
}

function formatCoord(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Number(value.toFixed(6));
}

function summarizeEvent(point: EventPoint): MarketMapEventSummary {
  return {
    eventId: point.eventId,
    title: point.title,
    venue: point.venue,
    representativeMarketId: point.representativeMarketId,
    representativeMarketTitle: point.representativeMarketTitle,
    image: point.image,
    icon: point.icon,
    volume24h: point.volume24h,
    liquidity: point.liquidity,
    openInterest: point.openInterest,
    score: point.score,
    x: point.x,
    y: point.y,
  };
}

function averageVector(points: EventPoint[]): number[] {
  if (points.length === 0) return [];
  const dims = points[0].vector.length;
  const out = Array.from({ length: dims }, () => 0);
  for (const point of points) {
    for (let i = 0; i < dims; i += 1) out[i] += point.vector[i];
  }
  for (let i = 0; i < dims; i += 1) out[i] /= points.length;
  return normalizeVector(out);
}

function pickSeedItems(points: EventPoint[], k: number): EventPoint[] {
  const effectiveK = Math.max(1, Math.min(k, points.length));
  const sorted = points
    .slice()
    .sort((a, b) => b.score - a.score || a.eventId.localeCompare(b.eventId));
  const seeds: EventPoint[] = [sorted[0]];
  while (seeds.length < effectiveK) {
    let best: EventPoint | null = null;
    let bestDist = Number.NEGATIVE_INFINITY;
    for (const point of sorted) {
      if (seeds.some((seed) => seed.eventId === point.eventId)) continue;
      let nearest = Number.POSITIVE_INFINITY;
      for (const seed of seeds) {
        const dist = cosineDistance(point.vector, seed.vector);
        if (dist < nearest) nearest = dist;
      }
      if (nearest > bestDist) {
        bestDist = nearest;
        best = point;
      }
    }
    if (!best) break;
    seeds.push(best);
  }
  return seeds;
}

function partitionCluster(points: EventPoint[], k: number): EventPoint[][] {
  if (points.length <= 1) return [points.slice()];
  const effectiveK = Math.max(1, Math.min(k, points.length));
  if (effectiveK <= 1) return [points.slice()];

  let centroids = pickSeedItems(points, effectiveK).map((point) => point.vector);
  let prevAssignment: string | null = null;

  for (let iter = 0; iter < 6; iter += 1) {
    const buckets = Array.from({ length: centroids.length }, () => [] as EventPoint[]);
    for (const point of points) {
      let bestIdx = 0;
      let bestDist = Number.POSITIVE_INFINITY;
      for (let i = 0; i < centroids.length; i += 1) {
        const dist = cosineDistance(point.vector, centroids[i]);
        if (dist < bestDist) {
          bestDist = dist;
          bestIdx = i;
        }
      }
      buckets[bestIdx].push(point);
    }

    const assignment = buckets
      .map((bucket) => bucket.map((point) => point.eventId).sort().join(","))
      .join("|");
    if (prevAssignment && prevAssignment === assignment) break;
    prevAssignment = assignment;

    centroids = buckets.map((bucket, idx) =>
      bucket.length > 0 ? averageVector(bucket) : centroids[idx],
    );
  }

  const out = Array.from({ length: centroids.length }, () => [] as EventPoint[]);
  for (const point of points) {
    let bestIdx = 0;
    let bestDist = Number.POSITIVE_INFINITY;
    for (let i = 0; i < centroids.length; i += 1) {
      const dist = cosineDistance(point.vector, centroids[i]);
      if (dist < bestDist) {
        bestDist = dist;
        bestIdx = i;
      }
    }
    out[bestIdx].push(point);
  }

  return out
    .filter((bucket) => bucket.length > 0)
    .map((bucket) =>
      bucket
        .slice()
        .sort((a, b) => b.score - a.score || a.eventId.localeCompare(b.eventId)),
    );
}

function pickRepresentative(points: EventPoint[]): EventPoint {
  if (points.length === 1) return points[0];
  const centroid = averageVector(points);
  let best = points[0];
  let bestDist = cosineDistance(points[0].vector, centroid);
  for (let i = 1; i < points.length; i += 1) {
    const dist = cosineDistance(points[i].vector, centroid);
    if (
      dist < bestDist ||
      (dist === bestDist && points[i].score > best.score) ||
      (dist === bestDist &&
        points[i].score === best.score &&
        points[i].eventId < best.eventId)
    ) {
      best = points[i];
      bestDist = dist;
    }
  }
  return best;
}

function buildTreeGlobal(params: {
  points: EventPoint[];
  depth: number;
  k1: number;
  k2: number;
  k3: number;
  nowIso: string;
  byNodeEvents: Map<string, MarketMapEventSummary[]>;
}): MarketMapNode[] {
  const { points, depth, k1, k2, k3, nowIso, byNodeEvents } = params;
  const nodes: MarketMapNode[] = [];

  function makeNodes(
    clusterPoints: EventPoint[],
    level: number,
    parentId: string | null,
  ): string[] {
    if (clusterPoints.length === 0) return [];
    const splitK = level === 1 ? k1 : level === 2 ? k2 : k3;
    const clusters = partitionCluster(clusterPoints, splitK);
    const createdIds: string[] = [];

    for (const bucket of clusters) {
      if (bucket.length === 0) continue;
      const eventIds = bucket.map((point) => point.eventId);
      const nodeId = buildMarketMapNodeId({
        scope: "global",
        level,
        parentId,
        eventIds,
      });
      const representative = pickRepresentative(bucket);
      const eventCount = bucket.length;
      const sumVolume24h = bucket.reduce((sum, row) => sum + row.volume24h, 0);
      const sumLiquidity = bucket.reduce((sum, row) => sum + row.liquidity, 0);
      const sumOpenInterest = bucket.reduce((sum, row) => sum + row.openInterest, 0);
      const score = bucket.reduce((sum, row) => sum + row.score, 0) / eventCount;
      const x =
        bucket.reduce((sum, row) => sum + row.x * Math.max(row.score, 1), 0) /
        bucket.reduce((sum, row) => sum + Math.max(row.score, 1), 0);
      const y =
        bucket.reduce((sum, row) => sum + row.y * Math.max(row.score, 1), 0) /
        bucket.reduce((sum, row) => sum + Math.max(row.score, 1), 0);
      const venueBreakdown: Record<MarketMapVenue, MarketMapNodeVenueMetrics> = {};
      for (const row of bucket) {
        const venue = row.venue;
        if (!venueBreakdown[venue]) {
          venueBreakdown[venue] = {
            eventCount: 0,
            sumVolume24h: 0,
            sumLiquidity: 0,
            sumOpenInterest: 0,
          };
        }
        venueBreakdown[venue].eventCount += 1;
        venueBreakdown[venue].sumVolume24h += row.volume24h;
        venueBreakdown[venue].sumLiquidity += row.liquidity;
        venueBreakdown[venue].sumOpenInterest += row.openInterest;
      }
      const dominantVenue =
        Object.entries(venueBreakdown).sort(
          (a, b) =>
            b[1].sumVolume24h - a[1].sumVolume24h ||
            b[1].eventCount - a[1].eventCount,
        )[0]?.[0] ?? null;
      const venueCount = Object.values(venueBreakdown).filter(
        (entry) => entry.eventCount > 0,
      ).length;
      const normalizedVenueBreakdown: Record<MarketMapVenue, MarketMapNodeVenueMetrics> =
        Object.fromEntries(
          Object.entries(venueBreakdown).map(([venue, entry]) => [
            venue,
            {
              eventCount: entry.eventCount,
              sumVolume24h: formatCoord(entry.sumVolume24h),
              sumLiquidity: formatCoord(entry.sumLiquidity),
              sumOpenInterest: formatCoord(entry.sumOpenInterest),
            },
          ]),
        );

      const node: MarketMapNode = {
        id: nodeId,
        venue: dominantVenue ?? "mixed",
        dominantVenue,
        venueCount,
        venueBreakdown: normalizedVenueBreakdown,
        level,
        parentId,
        childIds: [],
        label: representative.title,
        labelRepresentative: representative.title,
        labelAi: null,
        labelSource: "representative",
        x: formatCoord(x),
        y: formatCoord(y),
        eventCount,
        sumVolume24h: formatCoord(sumVolume24h),
        sumLiquidity: formatCoord(sumLiquidity),
        sumOpenInterest: formatCoord(sumOpenInterest),
        score: formatCoord(score),
        sampleEventIds: bucket.slice(0, 6).map((row) => row.eventId),
        heroEventId: representative.eventId,
        heroMarketId: representative.representativeMarketId,
        heroImage: representative.image,
        heroIcon: representative.icon,
        updatedAt: nowIso,
      };
      nodes.push(node);
      createdIds.push(nodeId);
      byNodeEvents.set(
        nodeId,
        bucket
          .slice()
          .sort((a, b) => b.score - a.score || a.eventId.localeCompare(b.eventId))
          .map(summarizeEvent),
      );

      if (level < depth && bucket.length >= 2) {
        const childIds = makeNodes(bucket, level + 1, nodeId);
        node.childIds = childIds;
      }
    }
    return createdIds;
  }

  makeNodes(points, 1, null);
  return nodes;
}

function safeJsonParse<T>(raw: string): T | null {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

function asFiniteNumber(value: unknown): number | undefined {
  const num = typeof value === "number" ? value : Number(value);
  return Number.isFinite(num) ? num : undefined;
}

function extractUsage(payload: unknown): Pick<
  AiLabelResult,
  "promptTokens" | "completionTokens" | "totalTokens" | "reasoningTokens"
> {
  if (!payload || typeof payload !== "object") return {};
  const usage = "usage" in payload ? (payload as { usage?: unknown }).usage : null;
  if (!usage || typeof usage !== "object") return {};
  const usageObj = usage as {
    prompt_tokens?: unknown;
    completion_tokens?: unknown;
    total_tokens?: unknown;
    reasoning_tokens?: unknown;
    completion_tokens_details?: unknown;
  };
  const completionDetails =
    usageObj.completion_tokens_details &&
    typeof usageObj.completion_tokens_details === "object"
      ? (usageObj.completion_tokens_details as { reasoning_tokens?: unknown })
      : null;

  return {
    promptTokens: asFiniteNumber(usageObj.prompt_tokens),
    completionTokens: asFiniteNumber(usageObj.completion_tokens),
    totalTokens: asFiniteNumber(usageObj.total_tokens),
    reasoningTokens: asFiniteNumber(
      completionDetails?.reasoning_tokens ?? usageObj.reasoning_tokens,
    ),
  };
}

function parsePossibleJson<T>(raw: string): T | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const direct = safeJsonParse<T>(trimmed);
  if (direct) return direct;
  const first = trimmed.indexOf("{");
  const last = trimmed.lastIndexOf("}");
  if (first >= 0 && last > first) {
    return safeJsonParse<T>(trimmed.slice(first, last + 1));
  }
  return null;
}

function extractPartialLabel(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  const closedMatch = trimmed.match(
    /"label"\s*:\s*"([^"]{1,400})"\s*(?:[,}])/s,
  );
  if (closedMatch?.[1]) return closedMatch[1];

  const closedAtEndMatch = trimmed.match(/"label"\s*:\s*"([^"]{1,400})"\s*$/s);
  if (closedAtEndMatch?.[1]) return closedAtEndMatch[1];

  const openEndedMatch = trimmed.match(/"label"\s*:\s*"([^"]{1,400})$/s);
  if (openEndedMatch?.[1]) return openEndedMatch[1];

  return null;
}

function unwrapTextValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (value && typeof value === "object" && "value" in value) {
    const inner = (value as { value?: unknown }).value;
    return typeof inner === "string" ? inner : "";
  }
  return "";
}

function parseOpenRouterMessageContent(content: unknown): string {
  if (typeof content === "string") return content;

  const extractPart = (part: unknown): string => {
    if (typeof part === "string") return part;
    if (!part || typeof part !== "object") return "";
    if ("text" in part) {
      return unwrapTextValue((part as { text?: unknown }).text);
    }
    if ("content" in part) {
      return unwrapTextValue((part as { content?: unknown }).content);
    }
    if ("refusal" in part) {
      const refusal = (part as { refusal?: unknown }).refusal;
      return typeof refusal === "string" ? refusal : "";
    }
    return "";
  };

  if (Array.isArray(content)) {
    return content.map((part) => extractPart(part)).join("");
  }

  if (content && typeof content === "object" && "text" in content) {
    return unwrapTextValue((content as { text?: unknown }).text);
  }

  if (content && typeof content === "object" && "content" in content) {
    return unwrapTextValue((content as { content?: unknown }).content);
  }

  if (content && typeof content === "object" && "refusal" in content) {
    const refusal = (content as { refusal?: unknown }).refusal;
    return typeof refusal === "string" ? refusal : "";
  }

  return "";
}

function isGenericLabel(label: string): boolean {
  const normalized = label.trim().toLowerCase();
  if (!normalized) return true;
  const generic = new Set([
    "politics",
    "sports",
    "crypto",
    "finance",
    "macro",
    "entertainment",
    "culture",
    "climate",
    "events",
    "markets",
    "predictions",
  ]);
  return generic.has(normalized);
}

function normalizeLabelSampleText(value: string, maxChars: number): string {
  const flattened = value.replace(/\s+/g, " ").trim();
  if (!flattened) return "";
  if (flattened.length <= maxChars) return flattened;
  return `${flattened.slice(0, Math.max(1, maxChars - 1)).trimEnd()}…`;
}

function buildLabelSystemPrompt(): string {
  return [
    "You label prediction-market event clusters.",
    "Return exactly one short label line.",
    "Do not return JSON, markdown, explanations, or extra text.",
    "Rules:",
    "- 2 to 6 words, max 60 characters.",
    "- Analyze the full in-cluster input and produce a label that represents the whole cluster, not just one sample.",
    "- Use nearby sibling examples to avoid collisions.",
    "- Avoid generic labels (Politics, Sports, Crypto, Markets, Predictions).",
    "- Avoid numeric-only labels, odds, prices, punctuation fluff, and emojis.",
    "- Do not copy a sibling label unless the topic is truly identical.",
    "- Keep wording concrete and specific.",
  ].join("\n");
}

function buildLabelUserPrompt(params: {
  level: number;
  representative: string;
  sampleKind: "child_clusters" | "event_titles";
  samples: string[];
  siblingSamples: string[];
}): string {
  const inScopeSamples = params.samples
    .map((title, idx) => `${idx + 1}. ${title}`)
    .join("\n");
  const nearbySamples = params.siblingSamples
    .map((title, idx) => `${idx + 1}. ${title}`)
    .join("\n");
  const taskHint =
    params.sampleKind === "child_clusters"
      ? "Build a parent-level label that covers all in-scope child clusters."
      : "Build a representative label for the shared topic across these events.";
  return [
    "Cluster labeling request.",
    "",
    `level: ${params.level}`,
    `sample_kind: ${params.sampleKind}`,
    "",
    taskHint,
    "",
    `Representative title: ${params.representative}`,
    "",
    "In-scope samples:",
    inScopeSamples || "- none",
    "",
    "Nearby sibling samples (for disambiguation):",
    nearbySamples || "- none",
    "",
    "Output: one label line only.",
  ].join("\n");
}

function buildLabelPromptPayload(params: {
  level: number;
  representative: string;
  sampleKind: "child_clusters" | "event_titles";
  samples: string[];
  siblingSamples: string[];
}): LabelPromptPayload {
  const system = buildLabelSystemPrompt();
  const user = buildLabelUserPrompt(params);
  return {
    system,
    user,
    promptChars: system.length + user.length,
  };
}

function sanitizeLabelCandidate(raw: string): string {
  let text = raw.trim();
  if (!text) return "";
  text = text.replace(/^`+|`+$/g, "").trim();
  text = text.replace(/^"+|"+$/g, "").trim();
  text = text.replace(/^'+|'+$/g, "").trim();
  return text.slice(0, 60).trim();
}

function parseLabelFromRawOutput(raw: string): {
  label: string | null;
  parseIssue: "json_parse_failed" | "invalid_schema" | null;
  detail?: string;
} {
  const trimmed = raw.trim();
  if (!trimmed) {
    return { label: null, parseIssue: "invalid_schema" };
  }

  const parsed = parsePossibleJson<AiLabelResponse>(trimmed);
  if (parsed && typeof parsed.label === "string") {
    return { label: sanitizeLabelCandidate(parsed.label), parseIssue: null };
  }

  const partial = extractPartialLabel(trimmed);
  if (partial) {
    return { label: sanitizeLabelCandidate(partial), parseIssue: null };
  }

  const deFenced = trimmed
    .replace(/^```(?:json|text)?\s*/i, "")
    .replace(/```$/i, "")
    .trim();
  const lines = deFenced
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  for (const line of lines) {
    const withoutBullet = line.replace(/^[-*]\s+/, "").trim();
    const labelPrefixMatch = withoutBullet.match(/^label\s*:\s*(.+)$/i);
    if (
      !labelPrefixMatch &&
      (withoutBullet.startsWith("{") ||
        withoutBullet.startsWith("[") ||
        withoutBullet.startsWith('"label"'))
    ) {
      continue;
    }
    const candidate = labelPrefixMatch
      ? labelPrefixMatch[1]
      : withoutBullet;
    const sanitized = sanitizeLabelCandidate(candidate);
    if (sanitized) {
      return { label: sanitized, parseIssue: null };
    }
  }

  const parseIssue =
    trimmed.startsWith("{") || trimmed.startsWith("[")
      ? "json_parse_failed"
      : "invalid_schema";
  return {
    label: null,
    parseIssue,
    detail: trimmed.slice(0, 180),
  };
}

async function callOpenRouterLabel(params: {
  model: string;
  labelMaxTokens: number;
  timeoutMs: number;
  prompt: LabelPromptPayload;
}): Promise<AiLabelResult> {
  if (!env.openRouterKey) return { label: null, reason: "http_error" };
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), params.timeoutMs);
  let response: Response;
  try {
    response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.openRouterKey}`,
        "Content-Type": "application/json",
        "X-Title": "Hunch Market Map Labels",
      },
      body: JSON.stringify({
        model: params.model,
        messages: [
          { role: "system", content: params.prompt.system },
          { role: "user", content: params.prompt.user },
        ],
        temperature: 0,
        max_tokens: params.labelMaxTokens,
        reasoning: { effort: "low" },
      }),
      signal: controller.signal,
    });
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      return { label: null, reason: "timeout", promptChars: params.prompt.promptChars };
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
  if (!response.ok) {
    const text = await response.text();
    return {
      label: null,
      reason: "http_error",
      statusCode: response.status,
      detail: text.slice(0, 180),
      promptChars: params.prompt.promptChars,
    };
  }
  const payload = (await response.json()) as {
    choices?: Array<{
      message?: { content?: unknown };
      finish_reason?: string | null;
    }>;
    usage?: unknown;
  };
  const usage = extractUsage(payload);
  const providerCost = extractProviderCostUsd(payload);
  const finishReason = payload.choices?.[0]?.finish_reason ?? null;
  const messageContent = payload.choices?.[0]?.message?.content;
  const raw = parseOpenRouterMessageContent(messageContent);
  const trimmed = raw.trim();
  if (!trimmed) {
    const contentType = Array.isArray(messageContent)
      ? "array"
      : messageContent == null
        ? "nullish"
        : typeof messageContent;
    return {
      label: null,
      reason: "empty_content",
      finishReason,
      ...usage,
      providerCostUsd: providerCost.providerCostUsd,
      providerCostField: providerCost.providerCostField,
      providerCostUsdTicks: providerCost.providerCostUsdTicks,
      detail: JSON.stringify({
        contentType,
        finishReason,
        usage,
        messageKeys:
          payload.choices?.[0]?.message &&
          typeof payload.choices?.[0]?.message === "object"
            ? Object.keys(payload.choices?.[0]?.message as Record<string, unknown>)
            : [],
        payloadSample: JSON.stringify(payload).slice(0, 240),
      }).slice(0, 240),
      promptChars: params.prompt.promptChars,
    };
  }

  const parsedOutput = parseLabelFromRawOutput(trimmed);
  if (!parsedOutput.label) {
    return {
      label: null,
      reason: parsedOutput.parseIssue ?? "invalid_schema",
      finishReason,
      ...usage,
      providerCostUsd: providerCost.providerCostUsd,
      providerCostField: providerCost.providerCostField,
      providerCostUsdTicks: providerCost.providerCostUsdTicks,
      detail: parsedOutput.detail ?? trimmed.slice(0, 180),
      promptChars: params.prompt.promptChars,
    };
  }
  const label = parsedOutput.label;
  if (!label || isGenericLabel(label)) {
    return {
      label: null,
      reason: "generic_label",
      finishReason,
      ...usage,
      providerCostUsd: providerCost.providerCostUsd,
      providerCostField: providerCost.providerCostField,
      providerCostUsdTicks: providerCost.providerCostUsdTicks,
      detail: label.slice(0, 120),
      promptChars: params.prompt.promptChars,
    };
  }
  return {
    label,
    reason: "ok",
    finishReason,
    ...usage,
    providerCostUsd: providerCost.providerCostUsd,
    providerCostField: providerCost.providerCostField,
    providerCostUsdTicks: providerCost.providerCostUsdTicks,
    promptChars: params.prompt.promptChars,
  };
}

async function applyAiLabels(params: {
  nodes: MarketMapNode[];
  byNodeEvents: Map<string, MarketMapEventSummary[]>;
  config: BuildConfig;
}): Promise<LabelCostSummary> {
  const { nodes, byNodeEvents, config } = params;
  if (!config.labelAiEnabled) {
    console.log("[market-map] ai labels skipped (disabled)");
    return emptyLabelCostSummary();
  }
  if (!env.openRouterKey) {
    console.log("[market-map] ai labels skipped (OPENROUTER_API_KEY missing)");
    return emptyLabelCostSummary();
  }
  const allowedLevels = new Set(config.labelLevels);
  const deepestExistingLevel = nodes.reduce(
    (max, node) => Math.max(max, node.level),
    1,
  );
  if (deepestExistingLevel > 1) {
    // Force bottom-up label propagation by always labeling the deepest existing level.
    allowedLevels.add(deepestExistingLevel);
  }
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const candidates = nodes.filter((node) => allowedLevels.has(node.level));
  if (candidates.length === 0) {
    console.log("[market-map] ai labels skipped (no candidate nodes)");
    return emptyLabelCostSummary();
  }
  const levelsDesc = Array.from(
    new Set(candidates.map((node) => node.level)),
  ).sort((a, b) => b - a);
  const deepestLevel = levelsDesc[0] ?? 1;
  const bucketsByLevel = new Map<number, MarketMapNode[]>(
    levelsDesc.map((level) => [
      level,
      candidates
        .filter((node) => node.level === level)
        .sort((a, b) => b.score - a.score),
    ]),
  );
  const quotasByLevel = new Map<number, number>();
  const parentLevels = levelsDesc.filter((level) => level !== deepestLevel);
  const requiredParentLabels = parentLevels.reduce(
    (sum, level) => sum + (bucketsByLevel.get(level)?.length ?? 0),
    0,
  );
  if (requiredParentLabels > config.maxAiLabelsPerRun) {
    console.log("[market-map] ai labels budget raised to include parent levels", {
      configuredMaxAiLabels: config.maxAiLabelsPerRun,
      requiredParentLabels,
    });
  }
  const targetBudget = Math.max(config.maxAiLabelsPerRun, requiredParentLabels);
  for (const level of parentLevels) {
    quotasByLevel.set(level, bucketsByLevel.get(level)?.length ?? 0);
  }
  const deepestAvailable = bucketsByLevel.get(deepestLevel)?.length ?? 0;
  const remainingForDeepest = Math.max(0, targetBudget - requiredParentLabels);
  quotasByLevel.set(deepestLevel, Math.min(deepestAvailable, remainingForDeepest));

  const maxAttempts = targetBudget;
  const plannedAttempts = levelsDesc.reduce(
    (sum, level) => sum + (quotasByLevel.get(level) ?? 0),
    0,
  );
  if (plannedAttempts <= 0) {
    console.log("[market-map] ai labels skipped (zero planned attempts)");
    return emptyLabelCostSummary();
  }
  const pricing = getOpenRouterModelPricingPerM(config.labelModel);
  const labelPriceInputPerM = pricing?.inputPerM ?? DEFAULT_LABEL_PRICE_INPUT_PER_M;
  const labelPriceOutputPerM =
    pricing?.outputPerM ?? DEFAULT_LABEL_PRICE_OUTPUT_PER_M;
  const concurrency = clamp(
    DEFAULT_AI_LABEL_CONCURRENCY,
    1,
    Math.max(1, plannedAttempts),
  );
  const plannedLevels = levelsDesc.filter((level) => (quotasByLevel.get(level) ?? 0) > 0);
  console.log("[market-map] ai labels start", {
    candidateNodes: candidates.length,
    maxAttempts,
    plannedAttempts,
    deepestLevel,
    requiredParentLabels,
    configuredMaxAiLabels: config.maxAiLabelsPerRun,
    concurrency,
    timeoutMs: DEFAULT_AI_LABEL_TIMEOUT_MS,
    labelChildSamplesMax: config.labelChildSamplesMax,
    labelSiblingSamplesMax: config.labelSiblingSamplesMax,
    labelSampleMaxChars: config.labelSampleMaxChars,
    levels: levelsDesc,
    candidateCountsByLevel: Object.fromEntries(
      levelsDesc.map((level) => [level, bucketsByLevel.get(level)?.length ?? 0]),
    ),
    selectedCountsByLevel: Object.fromEntries(
      levelsDesc.map((level) => [level, quotasByLevel.get(level) ?? 0]),
    ),
  });

  const startedAt = Date.now();
  let labeled = 0;
  let completed = 0;
  let attemptCursor = 0;
  let levelBatchIndex = 0;
  let totalPromptTokens = 0;
  let totalCompletionTokens = 0;
  let totalLabelTokens = 0;
  let totalReasoningTokens = 0;
  let totalEstimatedCostUsd = 0;
  let totalChargedCostUsd = 0;
  let totalProviderReportedCostUsd = 0;
  let providerReportedCostCalls = 0;
  const issueReasonCounts = new Map<string, number>();
  const finishReasonCounts = new Map<string, number>();
  const errorSamples: Array<{
    attempt: number;
    nodeId: string;
    level: number;
    reason: string;
    finishReason: string | null;
    durationMs: number;
    error: string | null;
  }> = [];
  const incrementCount = (map: Map<string, number>, key: string) => {
    map.set(key, (map.get(key) ?? 0) + 1);
  };
  const percentile = (values: number[], p: number): number => {
    if (values.length === 0) return 0;
    const sorted = values.slice().sort((a, b) => a - b);
    const idx = Math.min(
      sorted.length - 1,
      Math.max(0, Math.ceil((p / 100) * sorted.length) - 1),
    );
    return Number(sorted[idx].toFixed(2));
  };
  const average = (values: number[]): number => {
    if (values.length === 0) return 0;
    const sum = values.reduce((acc, value) => acc + value, 0);
    return Number((sum / values.length).toFixed(2));
  };
  const samplingSummaryByLevel: Record<
    number,
    {
      attempts: number;
      avgChildSamples: number;
      p95ChildSamples: number;
      avgSiblingSamples: number;
      p95SiblingSamples: number;
      avgPromptChars: number;
      p95PromptChars: number;
      avgPromptTokens: number;
      p95PromptTokens: number;
      avgCompletionTokens: number;
      p95CompletionTokens: number;
      avgReasoningTokens: number;
      p95ReasoningTokens: number;
    }
  > = {};

  for (const level of plannedLevels) {
    const quota = quotasByLevel.get(level) ?? 0;
    if (quota <= 0) continue;
    const levelCandidates = (bucketsByLevel.get(level) ?? [])
      .slice(0, quota)
      .map((node, idx) => ({
        node,
        attempt: attemptCursor + idx + 1,
      }));
    attemptCursor += levelCandidates.length;
    levelBatchIndex += 1;
    console.log("[market-map] ai labels batch start", {
      batch: `${levelBatchIndex}/${plannedLevels.length}`,
      level,
      attempts: levelCandidates.length,
      remainingBudget: plannedAttempts - attemptCursor,
      completedSoFar: completed,
      labeledSoFar: labeled,
      labelChildSamplesMax: config.labelChildSamplesMax,
      labelSiblingSamplesMax: config.labelSiblingSamplesMax,
      labelSampleMaxChars: config.labelSampleMaxChars,
    });
    let levelCompleted = 0;
    let levelLabeled = 0;
    let levelIssues = 0;
    const levelChildSampleCounts: number[] = [];
    const levelSiblingSampleCounts: number[] = [];
    const levelPromptChars: number[] = [];
    const levelPromptTokens: number[] = [];
    const levelCompletionTokens: number[] = [];
    const levelReasoningTokens: number[] = [];

    await forEachConcurrent(levelCandidates, concurrency, async (job) => {
      const { node, attempt } = job;
      const callStartedAt = Date.now();

      const siblingNodes = nodes.filter(
        (entry) => entry.level === node.level && entry.parentId === node.parentId,
      );
      const siblingCandidates = siblingNodes
        .filter((entry) => entry.id !== node.id)
        .map((entry) => {
          const raw = entry.label?.trim() || entry.labelRepresentative;
          const normalized = normalizeLabelSampleText(
            raw,
            config.labelSampleMaxChars,
          );
          const dx = entry.x - node.x;
          const dy = entry.y - node.y;
          return { normalized, dist2: dx * dx + dy * dy };
        })
        .filter((entry) => entry.normalized.length > 0)
        .sort(
          (a, b) =>
            a.dist2 - b.dist2 ||
            a.normalized.localeCompare(b.normalized),
        );
      const siblingSamples: string[] = [];
      const siblingSeen = new Set<string>();
      for (const sibling of siblingCandidates) {
        const key = sibling.normalized.toLowerCase();
        if (siblingSeen.has(key)) continue;
        siblingSeen.add(key);
        siblingSamples.push(sibling.normalized);
        if (siblingSamples.length >= config.labelSiblingSamplesMax) break;
      }
      const childSamplesRaw = node.childIds
        .map((childId) => {
          const child = nodeById.get(childId);
          if (!child) return "";
          return child.label?.trim() || child.labelRepresentative;
        })
        .map((value) => normalizeLabelSampleText(value, config.labelSampleMaxChars))
        .filter((value) => value.length > 0);
      const childSamples: string[] = [];
      const childSeen = new Set<string>();
      for (const value of childSamplesRaw) {
        const key = value.toLowerCase();
        if (childSeen.has(key)) continue;
        childSeen.add(key);
        childSamples.push(value);
        if (childSamples.length >= config.labelChildSamplesMax) break;
      }
      const sampleKind: "child_clusters" | "event_titles" =
        childSamples.length > 0 ? "child_clusters" : "event_titles";
      const samples =
        sampleKind === "child_clusters"
          ? childSamples
          : (() => {
              const out: string[] = [];
              const seen = new Set<string>();
              for (const event of byNodeEvents.get(node.id) ?? []) {
                const normalized = normalizeLabelSampleText(
                  event.title,
                  config.labelSampleMaxChars,
                );
                if (!normalized) continue;
                const key = normalized.toLowerCase();
                if (seen.has(key)) continue;
                seen.add(key);
                out.push(normalized);
                if (out.length >= config.labelChildSamplesMax) break;
              }
              return out;
            })();
      const normalizedRepresentative = normalizeLabelSampleText(
        node.labelRepresentative,
        config.labelSampleMaxChars,
      );
      const normalizedSamples =
        samples.length > 0
          ? samples
          : [normalizedRepresentative || node.labelRepresentative];
      const prompt = buildLabelPromptPayload({
        level: node.level,
        representative: normalizedRepresentative || node.labelRepresentative,
        sampleKind,
        samples: normalizedSamples,
        siblingSamples,
      });
      const childSampleCount = normalizedSamples.length;
      const siblingSampleCount = siblingSamples.length;
      levelChildSampleCounts.push(childSampleCount);
      levelSiblingSampleCounts.push(siblingSampleCount);
      levelPromptChars.push(prompt.promptChars);

      let status: "labeled" | "no_label" | "error" = "no_label";
      let noLabelReason: AiLabelResult["reason"] | null = null;
      let errorMessage: string | null = null;
      let finishReason: string | null | undefined;
      let promptChars: number | undefined = prompt.promptChars;
      let promptTokens: number | undefined;
      let completionTokens: number | undefined;
      let totalTokens: number | undefined;
      let reasoningTokens: number | undefined;
      let providerCostUsd: number | null = null;
      let providerCostField: string | null = null;
      let providerCostUsdTicks: number | null = null;
      let labelMaxTokensUsed = config.labelMaxTokens;
      try {
        let result = await callOpenRouterLabel({
          model: config.labelModel,
          labelMaxTokens: config.labelMaxTokens,
          timeoutMs: DEFAULT_AI_LABEL_TIMEOUT_MS,
          prompt,
        });
        if (
          !result.label &&
          (result.reason === "empty_content" ||
            result.reason === "json_parse_failed" ||
            result.reason === "invalid_schema") &&
          result.finishReason === "length"
        ) {
          const retryLabelMaxTokens = Math.min(
            Math.max(config.labelMaxTokens * 2, 800),
            2_000,
          );
          if (retryLabelMaxTokens > config.labelMaxTokens) {
            labelMaxTokensUsed = retryLabelMaxTokens;
            result = await callOpenRouterLabel({
              model: config.labelModel,
              labelMaxTokens: retryLabelMaxTokens,
              timeoutMs: DEFAULT_AI_LABEL_TIMEOUT_MS,
              prompt,
            });
          }
        }
        if (result.label) {
          node.labelAi = result.label;
          node.label = result.label;
          node.labelSource = "ai";
          labeled += 1;
          levelLabeled += 1;
          status = "labeled";
        } else {
          noLabelReason = result.reason;
          incrementCount(issueReasonCounts, result.reason);
          levelIssues += 1;
          if (result.detail) {
            errorMessage = result.detail;
          } else if (result.statusCode) {
            errorMessage = String(result.statusCode);
          }
        }
        finishReason = result.finishReason;
        promptChars = result.promptChars ?? prompt.promptChars;
        promptTokens = result.promptTokens;
        completionTokens = result.completionTokens;
        totalTokens = result.totalTokens;
        reasoningTokens = result.reasoningTokens;
        providerCostUsd = result.providerCostUsd ?? null;
        providerCostField = result.providerCostField ?? null;
        providerCostUsdTicks = result.providerCostUsdTicks ?? null;
      } catch (error) {
        status = "error";
        incrementCount(issueReasonCounts, "unexpected_error");
        levelIssues += 1;
        errorMessage = error instanceof Error ? error.message : String(error);
      }
      completed += 1;
      levelCompleted += 1;
      if (typeof promptTokens === "number" && Number.isFinite(promptTokens)) {
        levelPromptTokens.push(promptTokens);
      }
      if (
        typeof completionTokens === "number" &&
        Number.isFinite(completionTokens)
      ) {
        levelCompletionTokens.push(completionTokens);
      }
      if (
        typeof reasoningTokens === "number" &&
        Number.isFinite(reasoningTokens)
      ) {
        levelReasoningTokens.push(reasoningTokens);
      }
      const resolvedCost = resolveAiCost({
        inputTokens:
          typeof promptTokens === "number" && Number.isFinite(promptTokens)
            ? promptTokens
            : 0,
        outputTokens:
          typeof completionTokens === "number" &&
            Number.isFinite(completionTokens)
            ? completionTokens
            : 0,
        priceInputPerM: labelPriceInputPerM,
        priceOutputPerM: labelPriceOutputPerM,
        providerCostUsd,
        providerCostField,
        providerCostUsdTicks,
      });
      totalEstimatedCostUsd += resolvedCost.estimatedCostUsd;
      totalChargedCostUsd += resolvedCost.chargedCostUsd;
      if (resolvedCost.providerCostUsd != null) {
        totalProviderReportedCostUsd += resolvedCost.providerCostUsd;
        providerReportedCostCalls += 1;
      }
      if (typeof promptTokens === "number" && Number.isFinite(promptTokens)) {
        totalPromptTokens += promptTokens;
      }
      if (
        typeof completionTokens === "number" &&
        Number.isFinite(completionTokens)
      ) {
        totalCompletionTokens += completionTokens;
      }
      if (typeof totalTokens === "number" && Number.isFinite(totalTokens)) {
        totalLabelTokens += totalTokens;
      }
      if (
        typeof reasoningTokens === "number" &&
        Number.isFinite(reasoningTokens)
      ) {
        totalReasoningTokens += reasoningTokens;
      }
      if (finishReason) {
        incrementCount(finishReasonCounts, finishReason);
      }
      const isIssue =
        status === "error" ||
        noLabelReason === "timeout" ||
        noLabelReason === "http_error" ||
        noLabelReason === "empty_content" ||
        noLabelReason === "json_parse_failed" ||
        noLabelReason === "invalid_schema";
      if (isIssue) {
        const reason = status === "error" ? "unexpected_error" : (noLabelReason ?? "unknown");
        const durationMs = Date.now() - callStartedAt;
        console.error("[market-map] ai label issue", {
          attempt,
          maxAttempts,
          nodeId: node.id,
          level: node.level,
          status,
          reason,
          finishReason,
          sampleKind,
          childSampleCount,
          siblingSampleCount,
          durationMs,
          promptChars,
          promptTokens,
          completionTokens,
          reasoningTokens,
          totalTokens,
          estimatedCostUsd: Number(resolvedCost.estimatedCostUsd.toFixed(6)),
          chargedCostUsd: Number(resolvedCost.chargedCostUsd.toFixed(6)),
          costSource: resolvedCost.costSource,
          labelMaxTokensUsed,
          remaining: plannedAttempts - completed,
          error: errorMessage,
        });
        if (errorSamples.length < 20) {
          errorSamples.push({
            attempt,
            nodeId: node.id,
            level: node.level,
            reason,
            finishReason: finishReason ?? null,
            durationMs,
            error: errorMessage,
          });
        }
      } else if (config.debugLogs) {
        console.log("[market-map] ai label call done", {
          attempt,
          maxAttempts,
          nodeId: node.id,
          status,
          reason: noLabelReason,
          finishReason,
          sampleKind,
          childSampleCount,
          siblingSampleCount,
          durationMs: Date.now() - callStartedAt,
          promptChars,
          promptTokens,
          completionTokens,
          reasoningTokens,
          totalTokens,
          estimatedCostUsd: Number(resolvedCost.estimatedCostUsd.toFixed(6)),
          chargedCostUsd: Number(resolvedCost.chargedCostUsd.toFixed(6)),
          costSource: resolvedCost.costSource,
          labelMaxTokensUsed,
          labeledSoFar: labeled,
          completed,
          remaining: plannedAttempts - completed,
        });
      }
    });
    console.log("[market-map] ai labels batch done", {
      batch: `${levelBatchIndex}/${plannedLevels.length}`,
      level,
      attempted: levelCandidates.length,
      completed: levelCompleted,
      labeled: levelLabeled,
      issues: levelIssues,
      remaining: plannedAttempts - completed,
      sampling: {
        avgChildSamples: average(levelChildSampleCounts),
        p95ChildSamples: percentile(levelChildSampleCounts, 95),
        avgSiblingSamples: average(levelSiblingSampleCounts),
        p95SiblingSamples: percentile(levelSiblingSampleCounts, 95),
        avgPromptChars: average(levelPromptChars),
        p95PromptChars: percentile(levelPromptChars, 95),
        avgPromptTokens: average(levelPromptTokens),
        p95PromptTokens: percentile(levelPromptTokens, 95),
        avgCompletionTokens: average(levelCompletionTokens),
        p95CompletionTokens: percentile(levelCompletionTokens, 95),
        avgReasoningTokens: average(levelReasoningTokens),
        p95ReasoningTokens: percentile(levelReasoningTokens, 95),
      },
    });
    samplingSummaryByLevel[level] = {
      attempts: levelCandidates.length,
      avgChildSamples: average(levelChildSampleCounts),
      p95ChildSamples: percentile(levelChildSampleCounts, 95),
      avgSiblingSamples: average(levelSiblingSampleCounts),
      p95SiblingSamples: percentile(levelSiblingSampleCounts, 95),
      avgPromptChars: average(levelPromptChars),
      p95PromptChars: percentile(levelPromptChars, 95),
      avgPromptTokens: average(levelPromptTokens),
      p95PromptTokens: percentile(levelPromptTokens, 95),
      avgCompletionTokens: average(levelCompletionTokens),
      p95CompletionTokens: percentile(levelCompletionTokens, 95),
      avgReasoningTokens: average(levelReasoningTokens),
      p95ReasoningTokens: percentile(levelReasoningTokens, 95),
    };
  }

  const issueReasonSummary = Object.fromEntries(
    Array.from(issueReasonCounts.entries()).sort((a, b) => b[1] - a[1]),
  );
  const finishReasonSummary = Object.fromEntries(
    Array.from(finishReasonCounts.entries()).sort((a, b) => b[1] - a[1]),
  );
  const issuesTotal = Object.values(issueReasonSummary).reduce(
    (sum, value) => sum + value,
    0,
  );
  const providerReportedCostShare =
    plannedAttempts > 0 ? providerReportedCostCalls / plannedAttempts : 0;
  const labelCostSummary: LabelCostSummary = {
    attempted: plannedAttempts,
    labeled,
    promptTokens: totalPromptTokens,
    completionTokens: totalCompletionTokens,
    totalTokens: totalLabelTokens,
    reasoningTokens: totalReasoningTokens,
    estimatedCostUsd: Number(totalEstimatedCostUsd.toFixed(6)),
    chargedCostUsd: Number(totalChargedCostUsd.toFixed(6)),
    providerReportedCostUsd: Number(totalProviderReportedCostUsd.toFixed(6)),
    providerReportedCostCalls,
    providerReportedCostShare: Number(providerReportedCostShare.toFixed(4)),
  };
  console.log("[market-map] ai labels done", {
    attempted: plannedAttempts,
    labeled,
    unlabeled: plannedAttempts - labeled,
    issuesTotal,
    issueReasonSummary,
    finishReasonSummary,
    samplingSummaryByLevel,
    errorSamples: errorSamples.length,
    cost: labelCostSummary,
    durationMs: Date.now() - startedAt,
  });
  if (errorSamples.length > 0) {
    console.log("[market-map] ai labels issue samples", errorSamples);
  }
  return labelCostSummary;
}

async function fetchVenueCandidates(
  venue: MarketMapVenue,
  config: BuildConfig,
): Promise<EventCandidateRow[]> {
  const now = new Date();
  const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  const sevenDaysFromNow = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
  const queryLimit = Math.max(config.maxEventsPerVenue, config.maxEventsPerVenue * 2);
  const { rows } = await pool.query<EventCandidateRow>(
    `
      with candidate_events as (
        select
          e.id as event_id,
          e.venue::text as venue,
          e.title,
          e.image as event_image,
          e.icon as event_icon,
          (
            case
              when e.volume_24h is not null and e.volume_24h > 0 then e.volume_24h
              when e.volume_total is not null and e.volume_total > 0 then e.volume_total
              else 0
            end
          )::double precision as volume24h,
          coalesce(
            nullif(case when e.liquidity >= 9e16 then null else e.liquidity end, 0),
            nullif(e.open_interest, 0),
            0
          )::double precision as liquidity,
          coalesce(nullif(e.open_interest, 0), 0)::double precision as open_interest
        from unified_events e
        where e.status = 'ACTIVE'
          and e.venue = $1
          and (e.end_date is null or e.end_date > $2)
          and (
            (
              case
                when e.volume_24h is not null and e.volume_24h > 0 then e.volume_24h
                when e.volume_total is not null and e.volume_total > 0 then e.volume_total
                else 0
              end
            ) >= $3
            or (
              coalesce(
                nullif(case when e.liquidity >= 9e16 then null else e.liquidity end, 0),
                nullif(e.open_interest, 0),
                0
              ) >= $4
            )
          )
          and exists (
            select 1
            from unified_markets m
            where m.event_id = e.id
              and m.status = 'ACTIVE'
              and m.venue = $1
              and (m.expiration_time is null or m.expiration_time > $2)
              and (m.close_time is null or m.close_time > $2)
          )
        order by
          (
            coalesce(
              case
                when e.volume_24h is not null and e.volume_24h > 0 then e.volume_24h
                when e.volume_total is not null and e.volume_total > 0 then e.volume_total
                else 0
              end,
              0
            ) * 0.4
            +
            coalesce(
              coalesce(
                nullif(case when e.liquidity >= 9e16 then null else e.liquidity end, 0),
                nullif(e.open_interest, 0),
                0
              ),
              0
            ) * 0.3
            +
            case when e.start_date >= $6::timestamptz then 1000 else 0 end * 0.2
            +
            case when e.end_date <= $7::timestamptz then 500 else 0 end * 0.1
          ) desc nulls last,
          e.id
        limit $5
      ),
      rep_market as (
        select distinct on (m.event_id)
          m.event_id,
          m.id as representative_market_id,
          m.title as representative_market_title,
          m.image as representative_market_image,
          m.icon as representative_market_icon,
          (
            (case
              when m.volume_24h is not null and m.volume_24h > 0 then m.volume_24h
              when m.volume_total is not null and m.volume_total > 0 then m.volume_total
              else 0
            end) * 2 +
            coalesce(nullif(m.liquidity, 0), nullif(m.open_interest, 0), 0) +
            coalesce(m.open_interest, 0) +
            coalesce(m.volume_total, 0) * 0.2
          )::double precision as rep_score
        from unified_markets m
        join candidate_events ce on ce.event_id = m.event_id
        where m.status = 'ACTIVE'
          and m.venue = $1
          and (m.expiration_time is null or m.expiration_time > $2)
          and (m.close_time is null or m.close_time > $2)
        order by
          m.event_id,
          (case when m.best_bid is not null or m.best_ask is not null or m.last_price is not null then 1 else 0 end) desc,
          rep_score desc
      )
      select
        em.event_id,
        em.venue,
        em.title,
        em.event_image,
        em.event_icon,
        em.volume24h,
        em.liquidity,
        em.open_interest,
        (
          coalesce(em.volume24h, 0) * 2 +
          coalesce(em.liquidity, 0) +
          coalesce(em.open_interest, 0)
        )::double precision as score,
        rep_market.representative_market_id,
        rep_market.representative_market_title,
        rep_market.representative_market_image,
        rep_market.representative_market_icon
      from candidate_events em
      join rep_market on rep_market.event_id = em.event_id
      order by score desc
      limit $5
    `,
    [
      venue,
      now,
      config.minEventVolume24h,
      config.minEventLiquidity,
      queryLimit,
      sevenDaysAgo.toISOString(),
      sevenDaysFromNow.toISOString(),
    ],
  );
  return rows;
}

function buildConfig(args: string[], policy: MarketMapPolicy): BuildConfig {
  const venuesArg = parseFlag(args, "--venues");
  const venues =
    venuesArg && venuesArg.trim().length > 0
      ? normalizeMarketMapVenues(venuesArg.split(","))
      : policy.venuesEnabled;

  const withAiLabels = hasFlag(args, "--with-ai-labels");
  const withoutAiLabels = hasFlag(args, "--without-ai-labels");
  const dryRun = hasFlag(args, "--dry-run");
  const forceEnabled = hasFlag(args, "--force");
  const enabledOverride = parseBoolean(parseFlag(args, "--enabled"));

  return {
    enabled:
      enabledOverride ?? (forceEnabled ? true : policy.enabled),
    venues: venues.length > 0 ? venues : [...MARKET_MAP_DEFAULT_VENUES],
    depth: clamp(
      Math.trunc(parseNumber(parseFlag(args, "--depth")) ?? policy.depth),
      2,
      4,
    ),
    k1: clamp(Math.trunc(parseNumber(parseFlag(args, "--k1")) ?? policy.k1), 2, 24),
    k2: clamp(Math.trunc(parseNumber(parseFlag(args, "--k2")) ?? policy.k2), 2, 24),
    k3: clamp(Math.trunc(parseNumber(parseFlag(args, "--k3")) ?? policy.k3), 2, 24),
    maxEventsPerVenue: clamp(
      Math.trunc(
        parseNumber(parseFlag(args, "--max-events-per-venue")) ??
          policy.maxEventsPerVenue,
      ),
      100,
      20_000,
    ),
    ttlSec: clamp(
      Math.trunc(parseNumber(parseFlag(args, "--ttl-sec")) ?? policy.ttlSec),
      1_800,
      604_800,
    ),
    minEventVolume24h:
      parseNumber(parseFlag(args, "--min-event-volume-24h")) ??
      policy.minEventVolume24h,
    minEventLiquidity:
      parseNumber(parseFlag(args, "--min-event-liquidity")) ??
      policy.minEventLiquidity,
    labelAiEnabled:
      withoutAiLabels
        ? false
        : withAiLabels
          ? true
          : policy.labelAiEnabled,
    labelLevels: policy.labelLevels,
    labelModel: policy.labelModel,
    labelMaxTokens: clamp(
      Math.trunc(
        parseNumber(parseFlag(args, "--label-max-tokens")) ?? policy.labelMaxTokens,
      ),
      64,
      8_000,
    ),
    labelChildSamplesMax: clamp(
      Math.trunc(
        parseNumber(parseFlag(args, "--label-child-samples-max")) ??
          policy.labelChildSamplesMax,
      ),
      1,
      20,
    ),
    labelSiblingSamplesMax: clamp(
      Math.trunc(
        parseNumber(parseFlag(args, "--label-sibling-samples-max")) ??
          policy.labelSiblingSamplesMax,
      ),
      0,
      20,
    ),
    labelSampleMaxChars: clamp(
      Math.trunc(
        parseNumber(parseFlag(args, "--label-sample-max-chars")) ??
          policy.labelSampleMaxChars,
      ),
      24,
      200,
    ),
    maxAiLabelsPerRun: clamp(
      Math.trunc(
        parseNumber(parseFlag(args, "--max-ai-labels")) ??
          policy.maxAiLabelsPerRun ??
          DEFAULT_MAX_AI_LABELS_PER_RUN,
      ),
      1,
      2_000,
    ),
    projectionPcaDims: policy.projectionPcaDims,
    projectionUmapNeighbors: policy.projectionUmapNeighbors,
    projectionUmapMinDist: policy.projectionUmapMinDist,
    projectionSeed: policy.projectionSeed,
    projectionBudgetMs: policy.projectionBudgetMs,
    debugLogs: policy.debugLogs,
    dryRun,
  };
}

function printHelp(): void {
  console.log(`Usage: pnpm -C hunch-monorepo -F api run ai:embed:market-map -- [options]

Options:
  --venues <csv>                 Venues to include (default policy venuesEnabled)
  --depth <n>                    Tree depth (2..4)
  --k1 <n>                       Top-level split factor
  --k2 <n>                       2nd-level split factor
  --k3 <n>                       3rd+ level split factor
  --max-events-per-venue <n>     Candidate cap per venue
  --min-event-volume-24h <n>     Min 24h event volume
  --min-event-liquidity <n>      Min event liquidity
  --ttl-sec <n>                  Snapshot TTL in Redis
  --label-max-tokens <n>         Max completion tokens for AI labels
  --label-child-samples-max <n>  Max in-scope samples per label prompt
  --label-sibling-samples-max <n> Max sibling disambiguation samples per prompt
  --label-sample-max-chars <n>   Max chars per sample string in prompt
  --max-ai-labels <n>            Max AI label calls per run (default 400)
  --with-ai-labels               Enable AI label rewrite for this run
  --without-ai-labels            Disable AI labels for this run
  --enabled=<bool>               Override policy enabled (true/false)
  --force                        Run even if policy enabled=false
  --dry-run                      Build only, do not write Redis
  --help                         Show this help
`);
}

async function buildSnapshot(config: BuildConfig): Promise<BuildResult> {
  const startedAt = Date.now();
  const nowIso = new Date().toISOString();
  const byNodeEvents = new Map<string, MarketMapEventSummary[]>();
  const byVenuePoints: Record<MarketMapVenue, EventPoint[]> = {};
  const diagnostics: Record<
    MarketMapVenue,
    {
      candidates: number;
      embedded: number;
      selected: number;
      candidateQueryMs: number;
      sampleCandidateIds: string[];
      sampleKeyHits: number;
      sampleEmbeddingFieldHits: number;
      sampleEmbeddingBufferHits: number;
    }
  > = {};

  const redis = createRedisClient({ url: env.redisUrl });
  await ensureRedis(redis, { waitForReady: true, logLabel: "market-map-build" });
  const bufferClient = redis.withTypeMapping({
    [RESP_TYPES.BLOB_STRING]: Buffer,
  });
  try {
    for (const venue of config.venues) {
      const queryStartedAt = Date.now();
      const candidates = await fetchVenueCandidates(venue, config);
      const candidateQueryMs = Date.now() - queryStartedAt;
      const sampleCandidateIds = candidates.slice(0, 8).map((row) => row.event_id);
      let sampleKeyHits = 0;
      let sampleEmbeddingFieldHits = 0;
      let sampleEmbeddingBufferHits = 0;
      if (sampleCandidateIds.length > 0) {
        const sampleExists = redis.multi();
        const sampleFields = redis.multi();
        for (const eventId of sampleCandidateIds) {
          const key = `ai:embed:event:${eventId}`;
          sampleExists.exists(key);
          sampleFields.hExists(key, "embedding");
        }
        const existsRaw = (await sampleExists.exec()) as unknown as Array<number>;
        const fieldRaw = (await sampleFields.exec()) as unknown as Array<number>;
        const sampleRaw = await Promise.all(
          sampleCandidateIds.map((eventId) =>
            bufferClient.hGet(`ai:embed:event:${eventId}`, "embedding"),
          ),
        );
        for (const value of existsRaw) {
          const n = typeof value === "number" ? value : Number(value);
          sampleKeyHits += Number.isFinite(n) ? n : 0;
        }
        for (const value of fieldRaw) {
          const n = typeof value === "number" ? value : Number(value);
          sampleEmbeddingFieldHits += Number.isFinite(n) ? n : 0;
        }
        for (const value of sampleRaw) {
          if (Buffer.isBuffer(value)) sampleEmbeddingBufferHits += 1;
        }
      }
      diagnostics[venue] = {
        candidates: candidates.length,
        embedded: 0,
        selected: 0,
        candidateQueryMs,
        sampleCandidateIds,
        sampleKeyHits,
        sampleEmbeddingFieldHits,
        sampleEmbeddingBufferHits,
      };
      if (candidates.length === 0) continue;

      const raw = await Promise.all(
        candidates.map((row) =>
          bufferClient.hGet(`ai:embed:event:${row.event_id}`, "embedding"),
        ),
      );
      const points: EventPoint[] = [];
      for (let i = 0; i < candidates.length; i += 1) {
        const row = candidates[i];
        const embedding = raw[i];
        if (!embedding || !Buffer.isBuffer(embedding)) continue;
        const vector = parseEmbeddingBuffer(embedding);
        if (!vector) continue;
        points.push({
          eventId: row.event_id,
          venue: row.venue,
          title: row.title?.trim() || row.event_id,
          representativeMarketId: row.representative_market_id ?? null,
          representativeMarketTitle: row.representative_market_title?.trim() || null,
          image:
            normalizeOptionalUrl(row.representative_market_image) ??
            normalizeOptionalUrl(row.event_image),
          icon:
            normalizeOptionalUrl(row.representative_market_icon) ??
            normalizeOptionalUrl(row.event_icon),
          volume24h: toNumber(row.volume24h),
          liquidity: toNumber(row.liquidity),
          openInterest: toNumber(row.open_interest),
          score: toNumber(row.score),
          vector,
          x: 0,
          y: 0,
        });
      }
      diagnostics[venue].embedded = points.length;
      byVenuePoints[venue] = points
        .sort((a, b) => b.score - a.score || a.eventId.localeCompare(b.eventId))
        .slice(0, config.maxEventsPerVenue);
      diagnostics[venue].selected = byVenuePoints[venue].length;
    }
  } finally {
    await redis.quit();
  }

  console.log("[market-map] candidate diagnostics", diagnostics);

  const allPoints = config.venues.flatMap((venue) => byVenuePoints[venue]);
  if (allPoints.length === 0) {
    console.warn(
      "[market-map] no embedded event candidates; run ai:embed:backfill and verify active events/markets per venue",
    );
  }
  console.log("[market-map] projection start", {
    points: allPoints.length,
    budgetMs: config.projectionBudgetMs,
    pcaDims: config.projectionPcaDims,
    umapNeighbors: config.projectionUmapNeighbors,
    umapMinDist: config.projectionUmapMinDist,
  });
  const matrix = allPoints.map((point) => point.vector);
  const projectionStarted = Date.now();
  let projectionMethod: "umap" | "pca2" = "umap";
  let projectionFallback = false;
  let projected: number[][];
  try {
    projected = projectUmap(matrix, config);
    if (Date.now() - projectionStarted > config.projectionBudgetMs) {
      projectionFallback = true;
      projectionMethod = "pca2";
      console.log("[market-map] projection fallback (budget exceeded)", {
        elapsedMs: Date.now() - projectionStarted,
        budgetMs: config.projectionBudgetMs,
      });
      projected = projectPca2(matrix, config.projectionPcaDims);
    }
  } catch (error) {
    projectionFallback = true;
    projectionMethod = "pca2";
    console.log("[market-map] projection fallback (umap failed)", {
      error: error instanceof Error ? error.message : String(error),
    });
    projected = projectPca2(matrix, config.projectionPcaDims);
  }

  const normalizedProjected = normalizeCoordinates(projected);
  for (let i = 0; i < allPoints.length; i += 1) {
    allPoints[i].x = formatCoord(normalizedProjected[i]?.[0] ?? 0);
    allPoints[i].y = formatCoord(normalizedProjected[i]?.[1] ?? 0);
  }

  console.log("[market-map] clustering start", {
    depth: config.depth,
    k1: config.k1,
    k2: config.k2,
    k3: config.k3,
    perVenueEventCounts: Object.fromEntries(
      config.venues.map((venue) => [venue, byVenuePoints[venue]?.length ?? 0]),
    ),
  });
  const nodes = buildTreeGlobal({
    points: allPoints,
    depth: config.depth,
    k1: config.k1,
    k2: config.k2,
    k3: config.k3,
    nowIso,
    byNodeEvents,
  });
  const levelNodeCounts = nodes.reduce(
    (acc, node) => {
      acc[node.level] = (acc[node.level] ?? 0) + 1;
      return acc;
    },
    {} as Record<number, number>,
  );
  console.log("[market-map] clustering done", {
    totalNodes: nodes.length,
    levelNodeCounts,
    dominantVenueNodeCounts: Object.fromEntries(
      config.venues.map((venue) => [
        venue,
        nodes.filter((node) => node.dominantVenue === venue).length,
      ]),
    ),
  });

  const labelCostSummary = await applyAiLabels({ nodes, byNodeEvents, config });

  const projectionDurationMs = Date.now() - projectionStarted;
  const buildDurationMs = Date.now() - startedAt;

  return {
    nodes,
    byNodeEvents,
    labelCostSummary,
    meta: {
      generatedAt: nowIso,
      version: MARKET_MAP_VERSION,
      venues: config.venues,
      depth: config.depth,
      eventCountTotal: allPoints.length,
      projectionMethod,
      projectionFallback,
      projectionDurationMs,
      buildDurationMs,
    },
  };
}

async function storeSnapshot(
  redisUrl: string,
  config: BuildConfig,
  result: BuildResult,
): Promise<string> {
  const runId = `${Date.now()}-${randomUUID().slice(0, 8)}`;
  const redis = createRedisClient({ url: redisUrl });
  await ensureRedis(redis, { waitForReady: true, logLabel: "market-map-store" });
  try {
    const totalNodes = result.nodes.length;
    console.log("[market-map] storing snapshot", {
      runId,
      ttlSec: config.ttlSec,
      totalNodes,
      totalNodeEvents: result.byNodeEvents.size,
    });

    const multi = redis.multi();
    const meta: MarketMapMeta = {
      runId,
      ...result.meta,
    };
    multi.set(marketMapRunMetaKey(runId), JSON.stringify(meta), {
      EX: config.ttlSec,
    });
    multi.set(marketMapRunNodesGlobalKey(runId), JSON.stringify(result.nodes), {
      EX: config.ttlSec,
    });

    for (const node of result.nodes) {
      multi.set(marketMapRunNodeKey(runId, node.id), JSON.stringify(node), {
        EX: config.ttlSec,
      });
      const events = result.byNodeEvents.get(node.id) ?? [];
      multi.set(
        marketMapRunNodeEventsKey(runId, node.id),
        JSON.stringify(events),
        {
          EX: config.ttlSec,
        },
      );
    }
    multi.set(marketMapActiveKey(), runId, { EX: config.ttlSec });
    await multi.exec();
    console.log("[market-map] stored", {
      runId,
      ttlSec: config.ttlSec,
      eventCountTotal: result.meta.eventCountTotal,
      projectionMethod: result.meta.projectionMethod,
      projectionFallback: result.meta.projectionFallback,
      projectionDurationMs: result.meta.projectionDurationMs,
      buildDurationMs: result.meta.buildDurationMs,
    });
    return runId;
  } finally {
    await redis.quit();
  }
}

export async function runMarketMapBuild(
  args: string[] = process.argv.slice(2),
): Promise<MarketMapBuildRunResult> {
  if (hasFlag(args, "--help")) {
    printHelp();
    return {
      status: "skipped_disabled",
      source: "env",
      effectiveAt: null,
      redisRunId: null,
      eventCountTotal: 0,
      nodeCountTotal: 0,
      projectionMethod: "umap",
      projectionFallback: false,
      projectionDurationMs: 0,
      buildDurationMs: 0,
      labelCostSummary: emptyLabelCostSummary(),
    };
  }

  const policy = await resolveMarketMapPolicy(pool);
  const config = buildConfig(args, policy.effective);
  if (!config.enabled) {
    console.log(
      "[market-map] skipped (policy disabled). use --force to run anyway",
    );
    return {
      status: "skipped_disabled",
      source: policy.source,
      effectiveAt: policy.effectiveAt?.toISOString() ?? null,
      redisRunId: null,
      eventCountTotal: 0,
      nodeCountTotal: 0,
      projectionMethod: "umap",
      projectionFallback: false,
      projectionDurationMs: 0,
      buildDurationMs: 0,
      labelCostSummary: emptyLabelCostSummary(),
    };
  }
  if (!env.redisUrl) {
    throw new Error("[market-map] REDIS_URL is required");
  }

  console.log("[market-map] start", {
    source: policy.source,
    effectiveAt: policy.effectiveAt?.toISOString() ?? null,
    config,
  });

  const result = await buildSnapshot(config);
  const perVenueNodeCounts = Object.fromEntries(
    config.venues.map((venue) => [
      venue,
      result.nodes.filter((node) => node.dominantVenue === venue).length,
    ]),
  );
  console.log("[market-map] built", {
    eventCountTotal: result.meta.eventCountTotal,
    perVenueNodeCounts,
    projectionMethod: result.meta.projectionMethod,
    projectionFallback: result.meta.projectionFallback,
    projectionDurationMs: result.meta.projectionDurationMs,
    buildDurationMs: result.meta.buildDurationMs,
    labelCostSummary: result.labelCostSummary,
  });

  if (config.dryRun) {
    console.log("[market-map] dry-run complete (no Redis writes)");
    return {
      status: "dry_run",
      source: policy.source,
      effectiveAt: policy.effectiveAt?.toISOString() ?? null,
      redisRunId: null,
      eventCountTotal: result.meta.eventCountTotal,
      nodeCountTotal: result.nodes.length,
      projectionMethod: result.meta.projectionMethod,
      projectionFallback: result.meta.projectionFallback,
      projectionDurationMs: result.meta.projectionDurationMs,
      buildDurationMs: result.meta.buildDurationMs,
      labelCostSummary: result.labelCostSummary,
    };
  }
  const redisRunId = await storeSnapshot(env.redisUrl, config, result);
  return {
    status: "completed",
    source: policy.source,
    effectiveAt: policy.effectiveAt?.toISOString() ?? null,
    redisRunId,
    eventCountTotal: result.meta.eventCountTotal,
    nodeCountTotal: result.nodes.length,
    projectionMethod: result.meta.projectionMethod,
    projectionFallback: result.meta.projectionFallback,
    projectionDurationMs: result.meta.projectionDurationMs,
    buildDurationMs: result.meta.buildDurationMs,
    labelCostSummary: result.labelCostSummary,
  };
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
  runMarketMapBuild()
    .then(async () => {
      await pool.end();
      process.exit(0);
    })
    .catch(async (error) => {
      console.error("[market-map] failed", error);
      await pool.end();
      process.exit(1);
    });
}

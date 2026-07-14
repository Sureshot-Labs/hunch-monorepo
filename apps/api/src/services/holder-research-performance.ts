import type { DbQuery } from "../db.js";
import {
  buildMarketTypeText,
  classifyMarketSegmentFromText,
  classifyMarketTypeFromText,
  formatMarketSegmentLabel,
  type MarketSegment,
  type MarketType,
} from "./market-type-classifier.js";
import type { HolderResearchPolicy } from "./runtime-policies.js";
import { buildWalletIntelAcceptingOrdersSql } from "./wallet-intel-market-eligibility.js";

export type HolderResearchSignalSide = "YES" | "NO";
export type HolderResearchExecutionPriority = "normal" | "high_conviction";

export type HolderResearchSignalSnapshot = {
  version: 1;
  recordedAt: string;
  marketId: string;
  eventId: string | null;
  venue: string;
  side: HolderResearchSignalSide;
  direction: "up" | "down";
  marketStatus: string | null;
  acceptingOrders: boolean | null;
  resolvedOutcome: HolderResearchSignalSide | null;
  resolvedOutcomePct: number | null;
  tokens: {
    yes: string | null;
    no: string | null;
  };
  quote: {
    yesBid: number | null;
    yesAsk: number | null;
    lastPrice: number | null;
    yesMid: number | null;
    buyPrice: number | null;
    buyPriceSource: HolderResearchBuyPriceSource;
  };
};

export type HolderResearchBuyPriceSource =
  | "yes_ask"
  | "no_from_yes_bid"
  | "yes_mid"
  | "no_from_yes_mid"
  | "yes_last"
  | "no_from_yes_last"
  | "missing";

export type HolderResearchMarkPriceSource =
  | "yes_bid"
  | "no_from_yes_ask"
  | "yes_mid"
  | "no_from_yes_mid"
  | "yes_last"
  | "no_from_yes_last"
  | "resolved_outcome"
  | "resolved_outcome_pct"
  | "terminal_price"
  | "missing";

export type HolderResearchSignalPerformance = {
  version: 1;
  evaluatedAt: string;
  noteId: string;
  thesisKey: string;
  tradeKey: string;
  marketId: string;
  venue: string;
  bucket: string | null;
  marketType: MarketType;
  marketSegment: MarketSegment;
  actorMode: string | null;
  executionPriority: HolderResearchExecutionPriority;
  confidence: number | null;
  confidenceBand: string;
  signalSide: HolderResearchSignalSide | null;
  direction: string | null;
  state: "open" | "resolved" | "unknown";
  outcome: "correct" | "wrong" | "open" | "unknown";
  createdAt: string;
  hoursToCloseAtNote: number | null;
  noteYesProbability: number | null;
  currentYesProbability: number | null;
  finalYesProbability: number | null;
  entryPrice: number | null;
  entryPriceSource:
    | "frozen_delivery"
    | "signal_snapshot"
    | "nearest_trade"
    | "missing";
  entryQuality:
    | "exact_snapshot"
    | "near_trade"
    | "distant_trade"
    | "missing_entry";
  entryApproxDistanceMinutes: number | null;
  markPrice: number | null;
  markPriceSource: HolderResearchMarkPriceSource;
  pnlPerShare: number | null;
  pnlPerDollar: number | null;
  excessProbability: number | null;
  sideAdjustedPriceMove: number | null;
  priceSourceQuality: "exact" | "approximate" | "missing";
  resolvedOutcome: HolderResearchSignalSide | null;
  resolvedOutcomePct: number | null;
  primaryHolderWalletId: string | null;
  primaryHolderLabel: string | null;
  primaryHolderPositionUsd: number | null;
  primaryHolderPnl30dUsd: number | null;
  primaryHolderOpenPnlUsd: number | null;
};

export type HolderResearchPerformanceAggregate = {
  notes: number;
  withEntry: number;
  missingEntry: number;
  open: number;
  resolved: number;
  unknown: number;
  correct: number;
  wrong: number;
  positive: number;
  negative: number;
  flat: number;
  hitRate: number | null;
  averageRoi: number | null;
  medianRoi: number | null;
  totalPnlPerDollar: number;
  expectedWins?: number;
  excessProbability?: number;
  excessZ?: number | null;
  entryQualityCoverage?: number | null;
};

export type HolderResearchPerformanceAuditResult = {
  considered: number;
  evaluated: number;
  written: number;
  unchanged: number;
  errors: number;
  missingEntry: number;
  open: number;
  resolved: number;
  unknown: number;
  correct: number;
  wrong: number;
  aggregates: {
    overall: HolderResearchPerformanceAggregate;
    byVenue: Record<string, HolderResearchPerformanceAggregate>;
    byBucket: Record<string, HolderResearchPerformanceAggregate>;
    byMarketType: Record<string, HolderResearchPerformanceAggregate>;
    byMarketSegment: Record<string, HolderResearchPerformanceAggregate>;
    byActorMode: Record<string, HolderResearchPerformanceAggregate>;
    byExecutionPriority: Record<string, HolderResearchPerformanceAggregate>;
    byConfidenceBand: Record<string, HolderResearchPerformanceAggregate>;
    bySide: Record<string, HolderResearchPerformanceAggregate>;
    byState: Record<string, HolderResearchPerformanceAggregate>;
  };
  items: HolderResearchSignalPerformance[];
};

export type HolderResearchPerformanceAuditOptions = {
  lookbackHours: number;
  limit: number;
  noteIds?: string[];
  persist?: boolean;
  includeOpen?: boolean;
  includeResolved?: boolean;
  force?: boolean;
  activeOnly?: boolean;
  directionalOnly?: boolean;
  minConfidence?: number | null;
  approxEntryBeforeHours?: number;
  approxEntryAfterHours?: number;
  deliveredInitialOnly?: boolean;
};

type HolderResearchPerformanceNoteRow = {
  observation_id?: string | null;
  note_id: string;
  direction: string | null;
  confidence: string | number | null;
  created_at: Date | string;
  metrics: unknown;
  model_meta: unknown;
  target_meta: unknown;
  market_id: string;
  event_id: string | null;
  venue: string;
  market_status: string | null;
  market_title: string | null;
  event_title: string | null;
  category: string | null;
  close_time: Date | string | null;
  expiration_time: Date | string | null;
  best_bid: string | number | null;
  best_ask: string | number | null;
  last_price: string | number | null;
  resolved_outcome: string | null;
  resolved_outcome_pct: string | number | null;
  accepting_orders: boolean | null;
  yes_token_id: string | null;
  no_token_id: string | null;
  market_token_yes: string | null;
  market_token_no: string | null;
  clob_token_ids: string | null;
  frozen_entry_price?: string | number | null;
  frozen_side?: string | null;
  thesis_key?: string | null;
};

type NearestTradeRow = {
  note_id: string;
  price: string | number | null;
  ts: Date | string;
  distance_minutes: string | number | null;
};

type NearestTrade = {
  price: number;
  ts: string;
  distanceMinutes: number | null;
};

type MutableAggregate = Omit<
  HolderResearchPerformanceAggregate,
  "entryQualityCoverage" | "excessProbability" | "excessZ" | "expectedWins"
> & {
  entryQualityCoverage: number | null;
  excessProbability: number;
  excessZ: number | null;
  expectedWins: number;
  rois: number[];
  excessVariance: number;
};

const DEFAULT_NEAR_TRADE_MAX_MINUTES = 120;
export const HOLDER_RESEARCH_CALIBRATION_POSITIVE_MIN_SAMPLES = 30;
export const HOLDER_RESEARCH_CALIBRATION_CAUTION_MIN_SAMPLES = 15;
export const HOLDER_RESEARCH_CALIBRATION_SIGNIFICANCE_Z = 1.64;
export const HOLDER_RESEARCH_PERFORMANCE_APPROX_ENTRY_AFTER_HOURS = 2;
export const HOLDER_RESEARCH_PERFORMANCE_APPROX_ENTRY_BEFORE_HOURS = 24;

function toNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function toIso(value: Date | string | null | undefined): string | null {
  if (value == null) return null;
  if (value instanceof Date) return value.toISOString();
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) return null;
  return parsed.toISOString();
}

function objectRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function normalizePrice(value: unknown): number | null {
  const parsed = toNumber(value);
  if (parsed == null || parsed < 0 || parsed > 1) return null;
  return clamp01(parsed);
}

function normalizeSide(value: unknown): HolderResearchSignalSide | null {
  if (typeof value !== "string") return null;
  const side = value.trim().toUpperCase();
  return side === "YES" || side === "NO" ? side : null;
}

function parseClobTokenIds(value: unknown): string[] {
  if (typeof value !== "string" || !value.trim()) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed)
      ? parsed.filter((token): token is string => typeof token === "string")
      : [];
  } catch {
    return [];
  }
}

function resolveSideToken(
  row: Pick<
    HolderResearchPerformanceNoteRow,
    | "clob_token_ids"
    | "market_token_no"
    | "market_token_yes"
    | "no_token_id"
    | "yes_token_id"
  >,
  side: HolderResearchSignalSide,
): string | null {
  if (side === "YES") {
    return (
      row.yes_token_id ??
      row.market_token_yes ??
      parseClobTokenIds(row.clob_token_ids)[0] ??
      null
    );
  }
  return (
    row.no_token_id ??
    row.market_token_no ??
    parseClobTokenIds(row.clob_token_ids)[1] ??
    null
  );
}

function sideFromDirection(
  direction: string | null,
): HolderResearchSignalSide | null {
  if (direction === "up") return "YES";
  if (direction === "down") return "NO";
  return null;
}

function directionFromSide(side: HolderResearchSignalSide): "up" | "down" {
  return side === "YES" ? "up" : "down";
}

function confidenceBand(confidence: number | null): string {
  if (confidence == null) return "unknown";
  if (confidence >= 0.8) return "0.80+";
  if (confidence >= 0.7) return "0.70-0.79";
  if (confidence >= 0.6) return "0.60-0.69";
  return "<0.60";
}

export function resolveHolderResearchYesProbability(row: {
  best_bid: unknown;
  best_ask: unknown;
  last_price: unknown;
}): number | null {
  const bid = normalizePrice(row.best_bid);
  const ask = normalizePrice(row.best_ask);
  if (bid != null && ask != null) return clamp01((bid + ask) / 2);
  return normalizePrice(row.last_price);
}

function terminalYesProbabilityFromPrice(row: {
  best_bid: unknown;
  best_ask: unknown;
  last_price: unknown;
}): number | null {
  const yesProbability = resolveHolderResearchYesProbability(row);
  if (yesProbability == null) return null;
  if (yesProbability <= 0.01) return 0;
  if (yesProbability >= 0.99) return 1;
  return null;
}

export function resolveHolderResearchFinalYesProbability(row: {
  resolved_outcome?: unknown;
  resolvedOutcome?: unknown;
  resolved_outcome_pct?: unknown;
  resolvedOutcomePct?: unknown;
  best_bid: unknown;
  best_ask: unknown;
  last_price: unknown;
}): {
  finalYesProbability: number | null;
  source:
    | "resolved_outcome"
    | "resolved_outcome_pct"
    | "terminal_price"
    | "missing";
} {
  const resolved = normalizeSide(row.resolved_outcome ?? row.resolvedOutcome);
  if (resolved === "YES")
    return { finalYesProbability: 1, source: "resolved_outcome" };
  if (resolved === "NO")
    return { finalYesProbability: 0, source: "resolved_outcome" };
  const pct = toNumber(row.resolved_outcome_pct ?? row.resolvedOutcomePct);
  if (pct != null) {
    return {
      finalYesProbability: clamp01(pct / 10_000),
      source: "resolved_outcome_pct",
    };
  }
  const terminal = terminalYesProbabilityFromPrice(row);
  if (terminal != null) {
    return { finalYesProbability: terminal, source: "terminal_price" };
  }
  return { finalYesProbability: null, source: "missing" };
}

export function resolveHolderResearchSignalQuote(
  row: {
    best_bid: unknown;
    best_ask: unknown;
    last_price: unknown;
  },
  side: HolderResearchSignalSide,
): {
  yesBid: number | null;
  yesAsk: number | null;
  lastPrice: number | null;
  yesMid: number | null;
  buyPrice: number | null;
  buyPriceSource: HolderResearchBuyPriceSource;
  markPrice: number | null;
  markPriceSource: HolderResearchMarkPriceSource;
} {
  const yesBid = normalizePrice(row.best_bid);
  const yesAsk = normalizePrice(row.best_ask);
  const lastPrice = normalizePrice(row.last_price);
  const yesMid =
    yesBid != null && yesAsk != null
      ? clamp01((yesBid + yesAsk) / 2)
      : lastPrice;

  let buyPrice: number | null = null;
  let buyPriceSource: HolderResearchBuyPriceSource = "missing";
  let markPrice: number | null = null;
  let markPriceSource: HolderResearchMarkPriceSource = "missing";

  if (side === "YES") {
    if (yesAsk != null) {
      buyPrice = yesAsk;
      buyPriceSource = "yes_ask";
    } else if (yesMid != null) {
      buyPrice = yesMid;
      buyPriceSource = "yes_mid";
    } else if (lastPrice != null) {
      buyPrice = lastPrice;
      buyPriceSource = "yes_last";
    }

    if (yesBid != null) {
      markPrice = yesBid;
      markPriceSource = "yes_bid";
    } else if (yesMid != null) {
      markPrice = yesMid;
      markPriceSource = "yes_mid";
    } else if (lastPrice != null) {
      markPrice = lastPrice;
      markPriceSource = "yes_last";
    }
  } else {
    if (yesBid != null) {
      buyPrice = clamp01(1 - yesBid);
      buyPriceSource = "no_from_yes_bid";
    } else if (yesMid != null) {
      buyPrice = clamp01(1 - yesMid);
      buyPriceSource = "no_from_yes_mid";
    } else if (lastPrice != null) {
      buyPrice = clamp01(1 - lastPrice);
      buyPriceSource = "no_from_yes_last";
    }

    if (yesAsk != null) {
      markPrice = clamp01(1 - yesAsk);
      markPriceSource = "no_from_yes_ask";
    } else if (yesMid != null) {
      markPrice = clamp01(1 - yesMid);
      markPriceSource = "no_from_yes_mid";
    } else if (lastPrice != null) {
      markPrice = clamp01(1 - lastPrice);
      markPriceSource = "no_from_yes_last";
    }
  }

  return {
    yesBid,
    yesAsk,
    lastPrice,
    yesMid,
    buyPrice,
    buyPriceSource,
    markPrice,
    markPriceSource,
  };
}

export async function buildHolderResearchSignalSnapshot(
  client: DbQuery,
  params: {
    marketId: string;
    side: HolderResearchSignalSide | null;
    direction: string | null;
    recordedAt?: Date;
  },
): Promise<HolderResearchSignalSnapshot | null> {
  const side = params.side ?? sideFromDirection(params.direction);
  if (!side) return null;
  const acceptingSql = buildWalletIntelAcceptingOrdersSql({
    marketAlias: "m",
    eventAlias: "e",
  });
  const { rows } = await client.query<HolderResearchPerformanceNoteRow>(
    `
      select
        m.id as market_id,
        m.event_id,
        m.venue,
        m.status as market_status,
        m.best_bid,
        m.best_ask,
        m.last_price,
        m.resolved_outcome,
        m.resolved_outcome_pct::text as resolved_outcome_pct,
        m.token_yes as market_token_yes,
        m.token_no as market_token_no,
        m.clob_token_ids,
        ${acceptingSql} as accepting_orders,
        token_yes.token_id as yes_token_id,
        token_no.token_id as no_token_id
      from unified_markets m
      left join unified_events e on e.id = m.event_id
      left join lateral (
        select token_id
        from unified_market_tokens
        where market_id = m.id and outcome_side = 'YES'
        order by token_id
        limit 1
      ) token_yes on true
      left join lateral (
        select token_id
        from unified_market_tokens
        where market_id = m.id and outcome_side = 'NO'
        order by token_id
        limit 1
      ) token_no on true
      where m.id = $1
      limit 1
    `,
    [params.marketId],
  );
  const row = rows[0];
  if (!row) return null;
  const quote = resolveHolderResearchSignalQuote(row, side);
  return {
    version: 1,
    recordedAt: (params.recordedAt ?? new Date()).toISOString(),
    marketId: row.market_id,
    eventId: row.event_id,
    venue: row.venue,
    side,
    direction: directionFromSide(side),
    marketStatus: row.market_status,
    acceptingOrders: row.accepting_orders,
    resolvedOutcome: normalizeSide(row.resolved_outcome),
    resolvedOutcomePct: toNumber(row.resolved_outcome_pct),
    tokens: {
      yes: resolveSideToken(row, "YES"),
      no: resolveSideToken(row, "NO"),
    },
    quote: {
      yesBid: quote.yesBid,
      yesAsk: quote.yesAsk,
      lastPrice: quote.lastPrice,
      yesMid: quote.yesMid,
      buyPrice: quote.buyPrice,
      buyPriceSource: quote.buyPriceSource,
    },
  };
}

function stableJson(value: unknown): string {
  const normalize = (input: unknown): unknown => {
    if (Array.isArray(input)) return input.map(normalize);
    if (!input || typeof input !== "object") return input;
    return Object.fromEntries(
      Object.entries(input as Record<string, unknown>)
        .filter(([key]) => key !== "evaluatedAt")
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, normalize(nested)]),
    );
  };
  return JSON.stringify(normalize(value));
}

function readSignalSnapshot(
  metrics: unknown,
): HolderResearchSignalSnapshot | null {
  const snapshot = objectRecord(objectRecord(metrics).signalSnapshot);
  if (toNumber(snapshot.version) !== 1) return null;
  const side = normalizeSide(snapshot.side);
  if (!side) return null;
  const quote = objectRecord(snapshot.quote);
  const tokens = objectRecord(snapshot.tokens);
  return {
    version: 1,
    recordedAt:
      typeof snapshot.recordedAt === "string" ? snapshot.recordedAt : "",
    marketId: String(snapshot.marketId ?? ""),
    eventId: typeof snapshot.eventId === "string" ? snapshot.eventId : null,
    venue: String(snapshot.venue ?? ""),
    side,
    direction: side === "YES" ? "up" : "down",
    marketStatus:
      typeof snapshot.marketStatus === "string" ? snapshot.marketStatus : null,
    acceptingOrders:
      typeof snapshot.acceptingOrders === "boolean"
        ? snapshot.acceptingOrders
        : null,
    resolvedOutcome: normalizeSide(snapshot.resolvedOutcome),
    resolvedOutcomePct: toNumber(snapshot.resolvedOutcomePct),
    tokens: {
      yes: typeof tokens.yes === "string" ? tokens.yes : null,
      no: typeof tokens.no === "string" ? tokens.no : null,
    },
    quote: {
      yesBid: toNumber(quote.yesBid),
      yesAsk: toNumber(quote.yesAsk),
      lastPrice: toNumber(quote.lastPrice),
      yesMid: toNumber(quote.yesMid),
      buyPrice: toNumber(quote.buyPrice),
      buyPriceSource:
        typeof quote.buyPriceSource === "string"
          ? (quote.buyPriceSource as HolderResearchBuyPriceSource)
          : "missing",
    },
  };
}

function readExistingPerformance(
  metrics: unknown,
): HolderResearchSignalPerformance | null {
  const performance = objectRecord(objectRecord(metrics).signalPerformance);
  return toNumber(performance.version) === 1
    ? (performance as HolderResearchSignalPerformance)
    : null;
}

function samePerformance(
  metrics: unknown,
  performance: HolderResearchSignalPerformance,
): boolean {
  const existing = readExistingPerformance(metrics);
  if (!existing) return false;
  return stableJson(existing) === stableJson(performance);
}

async function loadNearestTrades(
  client: DbQuery,
  requests: Array<{
    requestId: string;
    tokenId: string;
    createdAt: string;
  }>,
  beforeHours: number,
  afterHours: number,
): Promise<Map<string, NearestTrade>> {
  if (requests.length === 0) return new Map();
  const { rows } = await client.query<NearestTradeRow>(
    `
      with input as (
        select
          request_id,
          token_id,
          created_at::timestamptz as created_at
        from jsonb_to_recordset($1::jsonb)
          as x(request_id text, token_id text, created_at text)
      )
      select distinct on (i.request_id)
        i.request_id as note_id,
        t.price,
        t.ts,
        (abs(extract(epoch from (t.ts - i.created_at))) / 60.0)::numeric
          as distance_minutes
      from input i
      join unified_last_trade t
        on t.token_id = i.token_id
       and t.ts >= i.created_at - ($2::numeric * interval '1 hour')
       and t.ts <= i.created_at + ($3::numeric * interval '1 hour')
      order by i.request_id, abs(extract(epoch from (t.ts - i.created_at))), t.ts desc
    `,
    [
      JSON.stringify(
        requests.map((request) => ({
          request_id: request.requestId,
          note_id: request.requestId,
          token_id: request.tokenId,
          created_at: request.createdAt,
        })),
      ),
      beforeHours,
      afterHours,
    ],
  );
  return new Map(
    rows.flatMap((row) => {
      const price = normalizePrice(row.price);
      const ts = toIso(row.ts);
      if (price == null || !ts) return [];
      return [
        [
          row.note_id,
          {
            price,
            ts,
            distanceMinutes: toNumber(row.distance_minutes),
          },
        ],
      ];
    }),
  );
}

function resolveSignalSide(
  row: HolderResearchPerformanceNoteRow,
): HolderResearchSignalSide | null {
  const frozenSide = normalizeSide(row.frozen_side);
  if (frozenSide) return frozenSide;
  const targetSide = normalizeSide(objectRecord(row.target_meta).side);
  return targetSide ?? sideFromDirection(row.direction);
}

function rowMarketType(row: HolderResearchPerformanceNoteRow): MarketType {
  const createdAt = toIso(row.created_at);
  const closeAt = toIso(row.close_time);
  const createdMs = createdAt ? new Date(createdAt).getTime() : NaN;
  const closeMs = closeAt ? new Date(closeAt).getTime() : NaN;
  const hoursToClose =
    Number.isFinite(createdMs) && Number.isFinite(closeMs)
      ? (closeMs - createdMs) / 3_600_000
      : null;
  const text = buildMarketTypeText({
    category: row.category,
    eventTitle: row.event_title,
    marketTitle: row.market_title,
  });
  return classifyMarketTypeFromText(text, hoursToClose);
}

function rowMarketSegment(
  row: HolderResearchPerformanceNoteRow,
): MarketSegment {
  const createdAt = toIso(row.created_at);
  const closeAt = toIso(row.close_time);
  const createdMs = createdAt ? new Date(createdAt).getTime() : NaN;
  const closeMs = closeAt ? new Date(closeAt).getTime() : NaN;
  const hoursToClose =
    Number.isFinite(createdMs) && Number.isFinite(closeMs)
      ? (closeMs - createdMs) / 3_600_000
      : null;
  const text = buildMarketTypeText({
    category: row.category,
    eventTitle: row.event_title,
    marketTitle: row.market_title,
  });
  return classifyMarketSegmentFromText(text, hoursToClose);
}

function hoursToCloseAtNote(
  row: HolderResearchPerformanceNoteRow,
): number | null {
  const createdAt = toIso(row.created_at);
  const closeAt = toIso(row.close_time);
  if (!createdAt || !closeAt) return null;
  return (
    (new Date(closeAt).getTime() - new Date(createdAt).getTime()) / 3_600_000
  );
}

function noteYesProbability(metrics: unknown): number | null {
  const market = objectRecord(objectRecord(metrics).market);
  return toNumber(market.yesProbability);
}

function metricBucket(metrics: unknown, targetMeta: unknown): string | null {
  const targetBucket = objectRecord(targetMeta).bucket;
  if (typeof targetBucket === "string" && targetBucket.trim()) {
    return targetBucket;
  }
  const bucket = objectRecord(metrics).bucket;
  return typeof bucket === "string" && bucket.trim() ? bucket : null;
}

function actorMode(modelMeta: unknown): string | null {
  const actor = objectRecord(
    objectRecord(modelMeta).primary_holder_credentials,
  );
  return typeof actor.mode === "string" && actor.mode.trim()
    ? actor.mode
    : null;
}

function executionPriority(
  modelMeta: unknown,
): HolderResearchExecutionPriority {
  const meta = objectRecord(modelMeta);
  return meta.execution_priority === "high_conviction" ||
    meta.executionPriority === "high_conviction"
    ? "high_conviction"
    : "normal";
}

function primaryHolderRecord(modelMeta: unknown): Record<string, unknown> {
  const actor = objectRecord(
    objectRecord(modelMeta).primary_holder_credentials,
  );
  return objectRecord(actor.primaryHolder);
}

function resolveEntryPrice(input: {
  row: HolderResearchPerformanceNoteRow;
  side: HolderResearchSignalSide | null;
  nearestTrade: NearestTrade | null;
}): {
  price: number | null;
  source: HolderResearchSignalPerformance["entryPriceSource"];
  distanceMinutes: number | null;
  quality: HolderResearchSignalPerformance["priceSourceQuality"];
  entryQuality: HolderResearchSignalPerformance["entryQuality"];
} {
  const frozenEntryPrice = normalizePrice(input.row.frozen_entry_price);
  if (frozenEntryPrice != null) {
    return {
      price: frozenEntryPrice,
      source: "frozen_delivery",
      distanceMinutes: null,
      quality: "exact",
      entryQuality: "exact_snapshot",
    };
  }
  const snapshot = readSignalSnapshot(input.row.metrics);
  if (
    snapshot &&
    snapshot.marketId === input.row.market_id &&
    snapshot.side === input.side &&
    snapshot.quote.buyPrice != null
  ) {
    return {
      price: snapshot.quote.buyPrice,
      source: "signal_snapshot",
      distanceMinutes: null,
      quality: "exact",
      entryQuality: "exact_snapshot",
    };
  }
  if (input.nearestTrade) {
    const distance = input.nearestTrade.distanceMinutes;
    return {
      price: input.nearestTrade.price,
      source: "nearest_trade",
      distanceMinutes: distance,
      quality: "approximate",
      entryQuality:
        distance == null || distance <= DEFAULT_NEAR_TRADE_MAX_MINUTES
          ? "near_trade"
          : "distant_trade",
    };
  }
  return {
    price: null,
    source: "missing",
    distanceMinutes: null,
    quality: "missing",
    entryQuality: "missing_entry",
  };
}

function resolveMarkPrice(input: {
  row: HolderResearchPerformanceNoteRow;
  side: HolderResearchSignalSide | null;
  finalYesProbability: number | null;
  finalSource:
    | "resolved_outcome"
    | "resolved_outcome_pct"
    | "terminal_price"
    | "missing";
  state: HolderResearchSignalPerformance["state"];
}): {
  price: number | null;
  source: HolderResearchMarkPriceSource;
} {
  if (input.side && input.finalYesProbability != null) {
    return {
      price:
        input.side === "YES"
          ? input.finalYesProbability
          : clamp01(1 - input.finalYesProbability),
      source: input.finalSource,
    };
  }
  if (input.state !== "open" || !input.side) {
    return { price: null, source: "missing" };
  }
  const quote = resolveHolderResearchSignalQuote(input.row, input.side);
  return {
    price: quote.markPrice,
    source: quote.markPriceSource,
  };
}

function buildPerformanceForRow(input: {
  row: HolderResearchPerformanceNoteRow;
  nearestTrade: NearestTrade | null;
}): HolderResearchSignalPerformance | null {
  const side = resolveSignalSide(input.row);
  const createdAt = toIso(input.row.created_at);
  if (!createdAt) return null;
  const final = resolveHolderResearchFinalYesProbability(input.row);
  const state: HolderResearchSignalPerformance["state"] =
    final.finalYesProbability != null
      ? "resolved"
      : input.row.accepting_orders
        ? "open"
        : "unknown";
  const entry = resolveEntryPrice({
    row: input.row,
    side,
    nearestTrade: input.nearestTrade,
  });
  const mark = resolveMarkPrice({
    row: input.row,
    side,
    finalYesProbability: final.finalYesProbability,
    finalSource: final.source,
    state,
  });
  const pnlPerShare =
    entry.price != null && mark.price != null ? mark.price - entry.price : null;
  const pnlPerDollar =
    pnlPerShare != null && entry.price != null && entry.price > 0
      ? pnlPerShare / entry.price
      : null;
  const resolvedPayout =
    state === "resolved" && mark.price != null ? mark.price : null;
  const excessProbability =
    resolvedPayout != null && entry.price != null
      ? resolvedPayout - entry.price
      : null;
  const outcome: HolderResearchSignalPerformance["outcome"] =
    state === "open"
      ? "open"
      : side == null || final.finalYesProbability == null
        ? "unknown"
        : side === "YES"
          ? final.finalYesProbability >= 0.5
            ? "correct"
            : "wrong"
          : final.finalYesProbability <= 0.5
            ? "correct"
            : "wrong";
  const confidence = toNumber(input.row.confidence);
  const marketType = rowMarketType(input.row);
  const marketSegment = rowMarketSegment(input.row);
  const primaryHolder = primaryHolderRecord(input.row.model_meta);
  const thesisKey =
    input.row.thesis_key?.trim() ||
    `holder_research:v2:${input.row.market_id}:${side ?? "MIXED"}`;
  return {
    version: 1,
    evaluatedAt: new Date().toISOString(),
    noteId: input.row.note_id,
    thesisKey,
    tradeKey: `${thesisKey}:${input.row.market_id}:${side ?? "MIXED"}`,
    marketId: input.row.market_id,
    venue: input.row.venue,
    bucket: metricBucket(input.row.metrics, input.row.target_meta),
    marketType,
    marketSegment,
    actorMode: actorMode(input.row.model_meta),
    executionPriority: executionPriority(input.row.model_meta),
    confidence,
    confidenceBand: confidenceBand(confidence),
    signalSide: side,
    direction: input.row.direction,
    state,
    outcome,
    createdAt,
    hoursToCloseAtNote: hoursToCloseAtNote(input.row),
    noteYesProbability: noteYesProbability(input.row.metrics),
    currentYesProbability: resolveHolderResearchYesProbability(input.row),
    finalYesProbability: final.finalYesProbability,
    entryPrice: entry.price,
    entryPriceSource: entry.source,
    entryQuality: entry.entryQuality,
    entryApproxDistanceMinutes: entry.distanceMinutes,
    markPrice: mark.price,
    markPriceSource: mark.source,
    pnlPerShare,
    pnlPerDollar,
    excessProbability,
    sideAdjustedPriceMove: pnlPerShare,
    priceSourceQuality: entry.quality,
    resolvedOutcome: normalizeSide(input.row.resolved_outcome),
    resolvedOutcomePct: toNumber(input.row.resolved_outcome_pct),
    primaryHolderWalletId:
      typeof primaryHolder.walletId === "string"
        ? primaryHolder.walletId
        : null,
    primaryHolderLabel:
      typeof primaryHolder.label === "string" ? primaryHolder.label : null,
    primaryHolderPositionUsd: toNumber(primaryHolder.positionUsd),
    primaryHolderPnl30dUsd: toNumber(primaryHolder.pnl30dUsd),
    primaryHolderOpenPnlUsd: toNumber(primaryHolder.openPnlUsd),
  };
}

function emptyMutableAggregate(): MutableAggregate {
  return {
    notes: 0,
    withEntry: 0,
    missingEntry: 0,
    open: 0,
    resolved: 0,
    unknown: 0,
    correct: 0,
    wrong: 0,
    positive: 0,
    negative: 0,
    flat: 0,
    hitRate: null,
    averageRoi: null,
    medianRoi: null,
    totalPnlPerDollar: 0,
    expectedWins: 0,
    excessProbability: 0,
    excessZ: null,
    entryQualityCoverage: null,
    rois: [],
    excessVariance: 0,
  };
}

function addAggregateItem(
  aggregate: MutableAggregate,
  item: HolderResearchSignalPerformance,
): void {
  aggregate.notes += 1;
  if (item.entryPrice != null) aggregate.withEntry += 1;
  else aggregate.missingEntry += 1;
  if (item.state === "open") aggregate.open += 1;
  else if (item.state === "resolved") aggregate.resolved += 1;
  else aggregate.unknown += 1;
  if (item.outcome === "correct") aggregate.correct += 1;
  else if (item.outcome === "wrong") aggregate.wrong += 1;
  if (
    item.state === "resolved" &&
    item.entryPrice != null &&
    item.excessProbability != null
  ) {
    aggregate.expectedWins += item.entryPrice;
    aggregate.excessProbability += item.excessProbability;
    aggregate.excessVariance += item.entryPrice * (1 - item.entryPrice);
  }
  if (item.pnlPerDollar != null) {
    aggregate.rois.push(item.pnlPerDollar);
    aggregate.totalPnlPerDollar += item.pnlPerDollar;
    if (item.pnlPerDollar > 0.000001) aggregate.positive += 1;
    else if (item.pnlPerDollar < -0.000001) aggregate.negative += 1;
    else aggregate.flat += 1;
  }
}

function finalizeAggregate(
  aggregate: MutableAggregate,
): HolderResearchPerformanceAggregate {
  const rois = aggregate.rois.slice().sort((left, right) => left - right);
  const averageRoi =
    rois.length > 0
      ? rois.reduce((sum, value) => sum + value, 0) / rois.length
      : null;
  const medianRoi =
    rois.length === 0
      ? null
      : rois.length % 2 === 1
        ? rois[Math.floor(rois.length / 2)]
        : (rois[rois.length / 2 - 1] + rois[rois.length / 2]) / 2;
  const resolvedWithKnownOutcome = aggregate.correct + aggregate.wrong;
  const { excessVariance, rois: _rois, ...result } = aggregate;
  void _rois;
  return {
    ...result,
    hitRate:
      resolvedWithKnownOutcome > 0
        ? aggregate.correct / resolvedWithKnownOutcome
        : null,
    averageRoi,
    medianRoi,
    excessZ:
      excessVariance > 0
        ? aggregate.excessProbability / Math.sqrt(excessVariance)
        : null,
    entryQualityCoverage:
      aggregate.notes > 0 ? aggregate.withEntry / aggregate.notes : null,
  };
}

function aggregateItems(items: HolderResearchSignalPerformance[]) {
  const overall = emptyMutableAggregate();
  const byVenue = new Map<string, MutableAggregate>();
  const byBucket = new Map<string, MutableAggregate>();
  const byMarketType = new Map<string, MutableAggregate>();
  const byMarketSegment = new Map<string, MutableAggregate>();
  const byActorMode = new Map<string, MutableAggregate>();
  const byExecutionPriority = new Map<string, MutableAggregate>();
  const byConfidenceBand = new Map<string, MutableAggregate>();
  const bySide = new Map<string, MutableAggregate>();
  const byState = new Map<string, MutableAggregate>();
  const addGroup = (map: Map<string, MutableAggregate>, key: string) => {
    let aggregate = map.get(key);
    if (!aggregate) {
      aggregate = emptyMutableAggregate();
      map.set(key, aggregate);
    }
    return aggregate;
  };
  for (const item of items) {
    addAggregateItem(overall, item);
    addAggregateItem(addGroup(byVenue, item.venue || "unknown"), item);
    addAggregateItem(addGroup(byBucket, item.bucket ?? "unknown"), item);
    addAggregateItem(addGroup(byMarketType, item.marketType), item);
    addAggregateItem(addGroup(byMarketSegment, item.marketSegment), item);
    addAggregateItem(addGroup(byActorMode, item.actorMode ?? "unknown"), item);
    addAggregateItem(
      addGroup(byExecutionPriority, item.executionPriority),
      item,
    );
    addAggregateItem(addGroup(byConfidenceBand, item.confidenceBand), item);
    addAggregateItem(addGroup(bySide, item.signalSide ?? "unknown"), item);
    addAggregateItem(addGroup(byState, item.state), item);
  }
  const finishMap = (map: Map<string, MutableAggregate>) =>
    Object.fromEntries(
      Array.from(map.entries()).map(([key, value]) => [
        key,
        finalizeAggregate(value),
      ]),
    );
  return {
    overall: finalizeAggregate(overall),
    byVenue: finishMap(byVenue),
    byBucket: finishMap(byBucket),
    byMarketType: finishMap(byMarketType),
    byMarketSegment: finishMap(byMarketSegment),
    byActorMode: finishMap(byActorMode),
    byExecutionPriority: finishMap(byExecutionPriority),
    byConfidenceBand: finishMap(byConfidenceBand),
    bySide: finishMap(bySide),
    byState: finishMap(byState),
  };
}

export async function auditHolderResearchSignalPerformance(
  client: DbQuery,
  options: HolderResearchPerformanceAuditOptions,
): Promise<HolderResearchPerformanceAuditResult> {
  const limit = Math.max(1, Math.min(10_000, Math.trunc(options.limit)));
  const noteIds = Array.from(new Set(options.noteIds ?? [])).filter(Boolean);
  const params: unknown[] = [];
  const where = [
    "n.note_type = 'signal'",
    "n.producer_type = 'holder_research'",
  ];
  if (options.activeOnly) {
    where.push("n.status = 'active'");
  }
  if (options.directionalOnly) {
    where.push("n.direction in ('up', 'down')");
  }
  if (noteIds.length > 0) {
    params.push(noteIds);
    where.push(`n.id = any($${params.length}::uuid[])`);
  } else {
    params.push(Math.max(1, Math.trunc(options.lookbackHours)));
    where.push(
      `n.created_at >= now() - ($${params.length}::numeric * interval '1 hour')`,
    );
  }
  if (options.minConfidence != null && Number.isFinite(options.minConfidence)) {
    params.push(Math.max(0, Math.min(1, options.minConfidence)));
    where.push(`n.confidence >= $${params.length}::numeric`);
  }
  params.push(limit);
  const limitParam = params.length;
  const acceptingSql = buildWalletIntelAcceptingOrdersSql({
    marketAlias: "m",
    eventAlias: "e",
  });
  const deliveryJoin = options.deliveredInitialOnly
    ? `
      join lateral (
        select distinct on (target_market_id, target_side)
          target_market_id,
          target_side,
          target_price
        from (
          select
            nullif(sbm.metrics #>> '{delivery,view,target,marketId}', '') as target_market_id,
            upper(nullif(sbm.metrics #>> '{delivery,view,target,side}', '')) as target_side,
            nullif(sbm.metrics #>> '{delivery,view,target,price}', '')::numeric as target_price,
            sbm.sent_at
          from signal_bot_messages sbm
          where sbm.note_id = n.id
            and sbm.message_kind = 'initial'
            and coalesce(sbm.metrics->>'status', 'sent') = 'sent'
        ) delivered
        where target_market_id is not null
          and target_side in ('YES', 'NO')
          and target_price between 0 and 1
        order by target_market_id, target_side, sent_at asc
      ) delivery on true
    `
    : "";
  const marketJoin = options.deliveredInitialOnly
    ? "join unified_markets m on m.id = delivery.target_market_id"
    : "join unified_markets m on m.id = t.target_id";
  const { rows } = await client.query<HolderResearchPerformanceNoteRow>(
    `
      select
        n.id as note_id,
        n.id::text || ':' || m.id || ':' || coalesce(
          ${options.deliveredInitialOnly ? "delivery.target_side" : "upper(t.target_meta->>'side')"},
          'MIXED'
        ) as observation_id,
        coalesce(
          n.lineage->>'thesis_key',
          'holder_research:v2:' || n.source_id || ':' || upper(coalesce(n.lineage->>'side', t.target_meta->>'side', 'MIXED'))
        ) as thesis_key,
        ${options.deliveredInitialOnly ? "delivery.target_side" : "null::text"} as frozen_side,
        ${options.deliveredInitialOnly ? "delivery.target_price" : "null::numeric"} as frozen_entry_price,
        n.direction,
        n.confidence,
        n.created_at,
        n.metrics,
        n.model_meta,
        t.target_meta,
        m.id as market_id,
        m.event_id,
        m.venue,
        m.status as market_status,
        m.title as market_title,
        e.title as event_title,
        coalesce(m.category, e.category) as category,
        m.close_time,
        m.expiration_time,
        m.best_bid,
        m.best_ask,
        m.last_price,
        m.resolved_outcome,
        m.resolved_outcome_pct::text as resolved_outcome_pct,
        m.token_yes as market_token_yes,
        m.token_no as market_token_no,
        m.clob_token_ids,
        ${acceptingSql} as accepting_orders,
        token_yes.token_id as yes_token_id,
        token_no.token_id as no_token_id
      from ai_notes n
      join ai_note_targets t
        on t.note_id = n.id
       and t.target_kind = 'market'
       and t.is_primary = true
      ${deliveryJoin}
      ${marketJoin}
      left join unified_events e on e.id = m.event_id
      left join lateral (
        select token_id
        from unified_market_tokens
        where market_id = m.id and outcome_side = 'YES'
        order by token_id
        limit 1
      ) token_yes on true
      left join lateral (
        select token_id
        from unified_market_tokens
        where market_id = m.id and outcome_side = 'NO'
        order by token_id
        limit 1
      ) token_no on true
      where ${where.join("\n        and ")}
      order by n.created_at desc, n.id desc, m.id, frozen_side
      limit $${limitParam}::int
    `,
    params,
  );

  const fallbackRequests = rows.flatMap((row) => {
    const side = resolveSignalSide(row);
    if (!side) return [];
    if (normalizePrice(row.frozen_entry_price) != null) return [];
    const snapshot = readSignalSnapshot(row.metrics);
    if (
      snapshot &&
      snapshot.marketId === row.market_id &&
      snapshot.side === side &&
      snapshot.quote.buyPrice != null
    ) {
      return [];
    }
    const createdAt = toIso(row.created_at);
    const tokenId = resolveSideToken(row, side);
    if (!createdAt || !tokenId) return [];
    return [
      {
        requestId: row.observation_id ?? row.note_id,
        tokenId,
        createdAt,
      },
    ];
  });
  const nearestTrades = await loadNearestTrades(
    client,
    fallbackRequests,
    Math.max(0, options.approxEntryBeforeHours ?? 24),
    Math.max(0, options.approxEntryAfterHours ?? 2),
  );

  const items: HolderResearchSignalPerformance[] = [];
  const stats = {
    considered: rows.length,
    evaluated: 0,
    written: 0,
    unchanged: 0,
    errors: 0,
    missingEntry: 0,
    open: 0,
    resolved: 0,
    unknown: 0,
    correct: 0,
    wrong: 0,
  };

  for (const row of rows) {
    const performance = buildPerformanceForRow({
      row,
      nearestTrade:
        nearestTrades.get(row.observation_id ?? row.note_id) ?? null,
    });
    if (!performance) continue;
    if (performance.state === "open" && options.includeOpen === false) continue;
    if (performance.state !== "open" && options.includeResolved === false) {
      continue;
    }
    items.push(performance);
    stats.evaluated += 1;
    if (performance.entryPrice == null) stats.missingEntry += 1;
    if (performance.state === "open") stats.open += 1;
    else if (performance.state === "resolved") stats.resolved += 1;
    else stats.unknown += 1;
    if (performance.outcome === "correct") stats.correct += 1;
    else if (performance.outcome === "wrong") stats.wrong += 1;

    const unchanged =
      !options.force && samePerformance(row.metrics, performance);
    if (unchanged) {
      stats.unchanged += 1;
      continue;
    }
    if (!options.persist || options.deliveredInitialOnly) continue;
    try {
      const result = await client.query(
        `
          update ai_notes
          set
            metrics = jsonb_set(
              coalesce(metrics, '{}'::jsonb),
              '{signalPerformance}',
              $2::jsonb,
              true
            ),
            updated_at = now()
          where id = $1::uuid
        `,
        [row.note_id, JSON.stringify(performance)],
      );
      const rowCount =
        typeof result.rowCount === "number" ? result.rowCount : 1;
      if (rowCount > 0) stats.written += 1;
    } catch {
      stats.errors += 1;
    }
  }

  return {
    ...stats,
    aggregates: aggregateItems(items),
    items,
  };
}

function dedupeDeliveredPerformanceTrades(
  items: HolderResearchSignalPerformance[],
): HolderResearchSignalPerformance[] {
  const byTradeKey = new Map<string, HolderResearchSignalPerformance>();
  for (const item of items) {
    const current = byTradeKey.get(item.tradeKey);
    if (!current || item.createdAt < current.createdAt) {
      byTradeKey.set(item.tradeKey, item);
    }
  }
  return [...byTradeKey.values()];
}

export function buildHolderResearchCalibrationMemoFromItems(
  rawItems: HolderResearchSignalPerformance[],
  policy: HolderResearchPolicy,
): string[] {
  const items = dedupeDeliveredPerformanceTrades(rawItems).filter(
    (item) =>
      item.state === "resolved" &&
      item.entryPrice != null &&
      item.pnlPerDollar != null &&
      item.excessProbability != null,
  );
  const minimumResolved = Math.max(
    policy.performanceCalibrationMinSamples,
    policy.performanceCalibrationMinResolvedSamples,
  );
  const positiveMinimum = Math.max(
    minimumResolved,
    HOLDER_RESEARCH_CALIBRATION_POSITIVE_MIN_SAMPLES,
  );
  const cautionMinimum = Math.max(
    minimumResolved,
    HOLDER_RESEARCH_CALIBRATION_CAUTION_MIN_SAMPLES,
  );
  if (items.length < minimumResolved) return [];

  const groups: Array<{
    label: string;
    items: HolderResearchSignalPerformance[];
  }> = [{ label: "all delivered trades", items }];
  for (const segment of new Set(items.map((item) => item.marketSegment))) {
    groups.push({
      label: formatMarketSegmentLabel(segment).toLowerCase(),
      items: items.filter((item) => item.marketSegment === segment),
    });
  }
  for (const bucket of new Set(items.map((item) => item.bucket))) {
    if (!bucket) continue;
    groups.push({
      label: bucket.replace(/_/g, " "),
      items: items.filter((item) => item.bucket === bucket),
    });
  }

  const positive: string[] = [];
  const caution: string[] = [];
  const seenCohorts = new Set<string>();
  for (const group of groups) {
    const cohortKey = group.items
      .map((item) => item.tradeKey)
      .sort()
      .join("|");
    if (seenCohorts.has(cohortKey)) continue;
    seenCohorts.add(cohortKey);
    const aggregate = aggregateItems(group.items).overall;
    if (
      group.items.length >= positiveMinimum &&
      aggregate.averageRoi != null &&
      aggregate.averageRoi > 0 &&
      aggregate.excessZ != null &&
      aggregate.excessZ >= HOLDER_RESEARCH_CALIBRATION_SIGNIFICANCE_Z
    ) {
      positive.push(
        `Positive calibrated pattern: ${group.label} has ${group.items.length} independent trades, mean ROI ${(aggregate.averageRoi * 100).toFixed(1)}%, excess z=${aggregate.excessZ.toFixed(2)}, and ${aggregate.correct} actual wins versus ${(aggregate.expectedWins ?? 0).toFixed(1)} expected at entry.`,
      );
      continue;
    }
    if (
      group.items.length >= cautionMinimum &&
      aggregate.averageRoi != null &&
      aggregate.averageRoi < 0
    ) {
      const evidence =
        aggregate.excessZ != null &&
        aggregate.excessZ <= -HOLDER_RESEARCH_CALIBRATION_SIGNIFICANCE_Z
          ? "statistically supported negative edge"
          : "observed losses, not yet statistically proven negative edge";
      caution.push(
        `Calibration caution: ${group.label} has ${group.items.length} independent trades and mean ROI ${(aggregate.averageRoi * 100).toFixed(1)}% (${evidence}; excess z=${aggregate.excessZ?.toFixed(2) ?? "n/a"}).`,
      );
    }
  }
  return [...caution, ...positive].slice(0, 4);
}

export async function loadHolderResearchPerformanceCalibrationMemo(
  client: DbQuery,
  policy: HolderResearchPolicy,
): Promise<string[]> {
  if (!policy.calibrationMemoEnabled) return [];
  const audit = await auditHolderResearchSignalPerformance(client, {
    approxEntryAfterHours: policy.performanceAuditApproxEntryAfterHours,
    approxEntryBeforeHours: policy.performanceAuditApproxEntryBeforeHours,
    deliveredInitialOnly: true,
    includeOpen: false,
    includeResolved: true,
    limit: 1_000,
    lookbackHours: policy.performanceAuditLookbackHours,
    persist: false,
  });
  return buildHolderResearchCalibrationMemoFromItems(audit.items, policy);
}

export async function loadLegacyHolderResearchPerformanceCalibrationMemo(
  client: DbQuery,
  policy: HolderResearchPolicy,
): Promise<string[]> {
  if (!policy.calibrationMemoEnabled) return [];
  const { rows } = await client.query<HolderResearchCalibrationRow>(
    `
      select
        n.id as note_id,
        n.created_at,
        coalesce(
          n.metrics #>> '{signalPerformance,outcome}',
          n.metrics #>> '{resolvedEvaluation,outcome}'
        ) as outcome,
        coalesce(
          n.metrics #>> '{signalPerformance,marketType}',
          n.metrics #>> '{resolvedEvaluation,marketType}'
        ) as market_type,
        coalesce(
          n.metrics #>> '{signalPerformance,marketSegment}',
          n.metrics #>> '{resolvedEvaluation,marketSegment}'
        ) as market_segment,
        coalesce(
          n.metrics #>> '{signalPerformance,actorMode}',
          n.metrics #>> '{resolvedEvaluation,actorMode}'
        ) as actor_mode,
        coalesce(
          n.metrics #>> '{signalPerformance,bucket}',
          n.metrics #>> '{bucket}'
        ) as bucket,
        t.target_id as market_id,
        coalesce(
          n.metrics #>> '{signalPerformance,signalSide}',
          t.target_meta #>> '{side}',
          case
            when n.direction = 'up' then 'YES'
            when n.direction = 'down' then 'NO'
            else null
          end
        ) as signal_side,
        n.metrics #>> '{signalPerformance,entryQuality}' as entry_quality,
        n.metrics #>> '{signalPerformance,entryApproxDistanceMinutes}' as entry_approx_distance_minutes,
        n.metrics #>> '{signalPerformance,pnlPerDollar}' as pnl_per_dollar,
        n.metrics #>> '{signalPerformance,state}' as state,
        coalesce(
          n.metrics #>> '{signalPerformance,primaryHolderWalletId}',
          n.model_meta #>> '{primary_holder_credentials,primaryHolder,walletId}'
        ) as primary_holder_wallet_id,
        coalesce(
          n.metrics #>> '{signalPerformance,primaryHolderLabel}',
          n.model_meta #>> '{primary_holder_credentials,primaryHolder,label}'
        ) as primary_holder_label,
        coalesce(
          n.metrics #>> '{signalPerformance,primaryHolderPnl30dUsd}',
          n.metrics #>> '{resolvedEvaluation,primaryHolderPnl30dUsd}'
        ) as primary_holder_pnl_30d_usd,
        coalesce(
          n.metrics #>> '{signalPerformance,primaryHolderPositionUsd}',
          n.metrics #>> '{resolvedEvaluation,primaryHolderPositionUsd}'
        ) as primary_holder_position_usd
      from ai_notes n
      left join ai_note_targets t
        on t.note_id = n.id
       and t.target_kind = 'market'
       and t.is_primary = true
      where n.note_type = 'signal'
        and n.producer_type = 'holder_research'
        and (
          n.metrics ? 'signalPerformance'
          or n.metrics ? 'resolvedEvaluation'
        )
        and n.created_at >= now() - ($1::numeric * interval '1 hour')
      order by n.updated_at desc, n.created_at desc
      limit 100
    `,
    [policy.performanceAuditLookbackHours],
  );
  const resolvedRows = dedupeCalibrationRows(
    rows.filter((row) => row.outcome === "correct" || row.outcome === "wrong"),
    policy,
  );
  const minResolvedSamples = Math.max(
    policy.performanceCalibrationMinSamples,
    policy.performanceCalibrationMinResolvedSamples,
  );
  if (resolvedRows.length < minResolvedSamples) return [];

  const minPatternSamples = policy.performanceCalibrationMinPatternSamples;
  const failedSportsSingles = resolvedRows.filter(
    (row) =>
      row.outcome === "wrong" &&
      row.market_type === "single_game_sports" &&
      row.actor_mode === "single_holder",
  );
  const successfulSportsStrong = resolvedRows.filter(
    (row) =>
      row.outcome === "correct" &&
      row.market_type === "single_game_sports" &&
      (row.actor_mode === "sharp_cluster" ||
        (row.actor_mode === "single_holder" &&
          (toNumber(row.primary_holder_pnl_30d_usd) ?? 0) > 0 &&
          (toNumber(row.primary_holder_position_usd) ?? 0) >=
            policy.singleGameSportsMinHolderUsd)),
  );
  const failedSharpMinority = resolvedRows.filter(
    (row) => row.outcome === "wrong" && row.bucket === "sharp_minority",
  );
  const goodNonSports = resolvedRows.filter(
    (row) =>
      row.outcome === "correct" && row.market_type !== "single_game_sports",
  );

  const memo: string[] = [];
  if (failedSportsSingles.length >= minPatternSamples) {
    memo.push(
      `Early caution: ${failedSportsSingles.length} resolved ${describeCalibrationSegmentBasis(failedSportsSingles)} single-holder notes lost (${describeCalibrationWalletBasis(failedSportsSingles)}; ${describeWeakSportsEvidence(failedSportsSingles, policy)}). For similar sports singles, require exceptional holder history or a same-side wallet cluster before publishing.`,
    );
  }
  if (successfulSportsStrong.length >= minPatternSamples) {
    memo.push(
      `Recent successful sports pattern: ${successfulSportsStrong.length} resolved notes worked with ${describeCalibrationWalletBasis(successfulSportsStrong)} and ${describeStrongSportsEvidence(successfulSportsStrong, policy)}.`,
    );
  }
  if (failedSharpMinority.length >= minPatternSamples) {
    memo.push(
      `Early caution: ${failedSharpMinority.length} sharp-minority notes resolved wrong (${describeCalibrationWalletBasis(failedSharpMinority)}). Do not publish minority reads when public price action already explains the move.`,
    );
  }
  if (goodNonSports.length >= minPatternSamples) {
    memo.push(
      `Recent non-sports wins: ${goodNonSports.length} politics, geo, crypto, or outright notes resolved correctly; do not apply sports-only caution to those markets.`,
    );
  }
  return memo.slice(0, 4);
}

type HolderResearchCalibrationRow = {
  note_id: string;
  created_at: Date | string | null;
  outcome: string | null;
  market_type: string | null;
  market_segment: string | null;
  actor_mode: string | null;
  bucket: string | null;
  market_id: string | null;
  signal_side: string | null;
  entry_quality: string | null;
  entry_approx_distance_minutes: string | number | null;
  pnl_per_dollar: string | number | null;
  state: string | null;
  primary_holder_wallet_id: string | null;
  primary_holder_label: string | null;
  primary_holder_pnl_30d_usd: string | number | null;
  primary_holder_position_usd: string | number | null;
};

function dedupeCalibrationRows(
  rows: HolderResearchCalibrationRow[],
  policy: HolderResearchPolicy,
): HolderResearchCalibrationRow[] {
  if (!policy.performanceCalibrationDedupMarketSide) return rows;
  const bestByKey = new Map<string, HolderResearchCalibrationRow>();
  for (const row of rows) {
    const key = [
      row.market_id ?? row.note_id,
      row.signal_side ?? "unknown",
      row.bucket ?? "unknown",
    ].join(":");
    const current = bestByKey.get(key);
    if (
      !current ||
      compareCalibrationRows(
        row,
        current,
        policy.performanceCalibrationMaxNearTradeMinutes,
      ) < 0
    ) {
      bestByKey.set(key, row);
    }
  }
  return [...bestByKey.values()];
}

function compareCalibrationRows(
  left: HolderResearchCalibrationRow,
  right: HolderResearchCalibrationRow,
  nearTradeMaxMinutes: number,
): number {
  const qualityDiff =
    calibrationEntryQualityRank(left, nearTradeMaxMinutes) -
    calibrationEntryQualityRank(right, nearTradeMaxMinutes);
  if (qualityDiff !== 0) return qualityDiff;
  return calibrationCreatedAtMs(left) - calibrationCreatedAtMs(right);
}

function calibrationCreatedAtMs(row: HolderResearchCalibrationRow): number {
  const iso = toIso(row.created_at);
  if (!iso) return Number.MAX_SAFE_INTEGER;
  return new Date(iso).getTime();
}

function calibrationEntryQualityRank(
  row: HolderResearchCalibrationRow,
  nearTradeMaxMinutes: number,
): number {
  if (row.entry_quality === "exact_snapshot") return 0;
  if (
    row.entry_quality === "near_trade" &&
    (toNumber(row.entry_approx_distance_minutes) ?? 0) <= nearTradeMaxMinutes
  ) {
    return 1;
  }
  if (row.entry_quality === "distant_trade") return 2;
  return 3;
}

function describeCalibrationWalletBasis(
  rows: HolderResearchCalibrationRow[],
): string {
  const counts = new Map<
    string,
    { count: number; label: string | null; walletId: string }
  >();
  for (const row of rows) {
    const walletId = row.primary_holder_wallet_id;
    if (!walletId) continue;
    const current = counts.get(walletId) ?? {
      count: 0,
      label: row.primary_holder_label,
      walletId,
    };
    current.count += 1;
    if (!current.label && row.primary_holder_label) {
      current.label = row.primary_holder_label;
    }
    counts.set(walletId, current);
  }
  const sorted = [...counts.values()].sort((a, b) => b.count - a.count);
  const top = sorted[0];
  if (!top) return "holder identity unavailable";
  if (top.count >= 2 && top.count / rows.length >= 0.6) {
    return `same tracked wallet ${formatCalibrationWallet(top)} in ${top.count}/${rows.length}`;
  }
  return `${sorted.length} tracked wallets`;
}

function describeCalibrationSegmentBasis(
  rows: HolderResearchCalibrationRow[],
): string {
  const counts = new Map<string, number>();
  for (const row of rows) {
    const key = row.market_segment ?? row.market_type ?? "unknown";
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const sorted = [...counts.entries()].sort((left, right) => {
    if (right[1] !== left[1]) return right[1] - left[1];
    return left[0].localeCompare(right[0]);
  });
  const top = sorted[0];
  if (!top || top[0] === "unknown") return "sports";
  return formatMarketSegmentLabel(top[0]).toLowerCase();
}

function formatCalibrationWallet(input: {
  walletId: string;
  label: string | null;
}): string {
  const label = input.label?.trim();
  if (label) return label.slice(0, 48);
  return input.walletId.length > 8
    ? `${input.walletId.slice(0, 8)}...`
    : input.walletId;
}

function describeWeakSportsEvidence(
  rows: HolderResearchCalibrationRow[],
  policy: HolderResearchPolicy,
): string {
  const nonPositivePnl = rows.filter(
    (row) => (toNumber(row.primary_holder_pnl_30d_usd) ?? 0) <= 0,
  ).length;
  const smallStake = rows.filter(
    (row) =>
      (toNumber(row.primary_holder_position_usd) ?? 0) <
      policy.singleGameSportsMinHolderUsd,
  ).length;
  const facts: string[] = [];
  if (nonPositivePnl > 0) {
    facts.push(
      `${nonPositivePnl}/${rows.length} lacked positive 30d holder PnL`,
    );
  }
  if (smallStake > 0) {
    facts.push(
      `${smallStake}/${rows.length} were below the sports holder-size bar`,
    );
  }
  return facts.length > 0
    ? facts.join(", ")
    : "holder evidence was not clearly exceptional";
}

function describeStrongSportsEvidence(
  rows: HolderResearchCalibrationRow[],
  policy: HolderResearchPolicy,
): string {
  const clusters = rows.filter(
    (row) => row.actor_mode === "sharp_cluster",
  ).length;
  const positivePnl = rows.filter(
    (row) => (toNumber(row.primary_holder_pnl_30d_usd) ?? 0) > 0,
  ).length;
  const materialStake = rows.filter(
    (row) =>
      (toNumber(row.primary_holder_position_usd) ?? 0) >=
      policy.singleGameSportsMinHolderUsd,
  ).length;
  const facts: string[] = [];
  if (clusters > 0) facts.push(`${clusters}/${rows.length} were clusters`);
  if (positivePnl > 0) {
    facts.push(`${positivePnl}/${rows.length} had positive 30d holder PnL`);
  }
  if (materialStake > 0) {
    facts.push(`${materialStake}/${rows.length} had material holder size`);
  }
  return facts.length > 0 ? facts.join(", ") : "stronger holder evidence";
}

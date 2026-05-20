import type { UnifiedEventRow, UnifiedMarketRow } from "@hunch/db";

import type {
  TDflowEvent,
  TDflowMarket,
  TDflowMarketAccount,
} from "./types.js";
import type { DflowSeriesInfo } from "./seriesClient.js";

export type DflowCategory =
  | "politics"
  | "crypto"
  | "sports"
  | "economics"
  | "technology"
  | "entertainment"
  | "weather"
  | "health"
  | "mentions"
  | "other";

const DFLOW_U64_SENTINEL_MIN = 9e18;

const DFLOW_CATEGORY_MAP = new Map<string, DflowCategory>([
  ["politics", "politics"],
  ["crypto", "crypto"],
  ["sports", "sports"],
  ["economics", "economics"],
  ["technology", "technology"],
  ["entertainment", "entertainment"],
  ["weather", "weather"],
  ["health", "health"],
  ["mentions", "mentions"],
  ["other", "other"],
  ["climate", "weather"],
  ["climate and weather", "weather"],
  ["financials", "economics"],
  ["science and technology", "technology"],
  ["companies", "economics"],
  ["elections", "politics"],
  ["world", "politics"],
  ["social", "other"],
]);

function n(v: unknown): number | undefined {
  if (v == null) return undefined;
  const parsed = typeof v === "string" ? Number(v) : (v as number);
  if (!Number.isFinite(parsed)) return undefined;
  if (parsed < 0) return undefined;
  // DFlow sometimes returns unsigned 64-bit sentinel values (~2^64) for missing metrics.
  // Treat them as absent so they don't dominate sorting or UI.
  if (parsed >= DFLOW_U64_SENTINEL_MIN) return undefined;
  return parsed;
}

function s(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined;
  const trimmed = v.trim();
  return trimmed.length ? trimmed : undefined;
}

function normalizeCategoryKey(
  value: string | null | undefined,
): string | undefined {
  const trimmed = s(value);
  if (!trimmed) return undefined;
  return trimmed
    .toLowerCase()
    .replace(/\s*&\s*/g, " and ")
    .replace(/\s+/g, " ");
}

function compactMetadata(
  values: Record<string, unknown>,
): Record<string, unknown> | undefined {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(values)) {
    if (value == null) continue;
    if (typeof value === "string" && value.trim().length === 0) continue;
    if (Array.isArray(value) && value.length === 0) continue;
    out[key] = value;
  }
  return Object.keys(out).length ? out : undefined;
}

export function normalizeDflowCategory(
  value: string | null | undefined,
): DflowCategory | undefined {
  const normalized = normalizeCategoryKey(value);
  if (!normalized) return undefined;
  return DFLOW_CATEGORY_MAP.get(normalized);
}

export function resolveDflowSeriesTagCategory(
  tags?: string[] | null,
): DflowCategory | undefined {
  if (!tags?.length) return undefined;
  for (const tag of tags) {
    const normalized = normalizeDflowCategory(tag);
    if (normalized) return normalized;
  }
  return undefined;
}

export function resolveDflowEventCategory(input: {
  eventCategory?: string | null;
  seriesCategory?: string | null;
  seriesTags?: string[] | null;
}): DflowCategory {
  return (
    normalizeDflowCategory(input.eventCategory) ??
    normalizeDflowCategory(input.seriesCategory) ??
    resolveDflowSeriesTagCategory(input.seriesTags) ??
    "other"
  );
}

export function resolveDflowMarketCategory(input: {
  marketCategory?: string | null;
  eventCategory?: string | null;
}): DflowCategory {
  return (
    normalizeDflowCategory(input.marketCategory) ??
    normalizeDflowCategory(input.eventCategory) ??
    "other"
  );
}

function pickNumber(
  sources: Array<Record<string, unknown> | undefined | null>,
  keys: string[],
): number | undefined {
  for (const source of sources) {
    if (!source) continue;
    for (const key of keys) {
      if (!(key in source)) continue;
      const value = source[key];
      const parsed = n(value);
      if (parsed !== undefined) return parsed;
    }
  }
  return undefined;
}

function parseDate(v: unknown): Date | undefined {
  if (typeof v === "string") {
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? undefined : d;
  }

  if (typeof v === "number" && Number.isFinite(v)) {
    const ms = v < 1e12 ? v * 1000 : v;
    const d = new Date(ms);
    return Number.isNaN(d.getTime()) ? undefined : d;
  }

  return undefined;
}

function minDate(values: Array<Date | undefined>): Date | undefined {
  const filtered = values.filter(Boolean) as Date[];
  filtered.sort((a, b) => a.getTime() - b.getTime());
  return filtered[0];
}

function maxDate(values: Array<Date | undefined>): Date | undefined {
  const filtered = values.filter(Boolean) as Date[];
  filtered.sort((a, b) => b.getTime() - a.getTime());
  return filtered[0];
}

function normalizeStatus(value: unknown): string {
  if (typeof value !== "string") return "";
  return value.trim().toLowerCase();
}

function isNonTerminalAsk(value: number | undefined): boolean {
  return value != null && value > 0 && value < 1;
}

export function mapDflowStatusToUnified(
  value: unknown,
): "ACTIVE" | "CLOSED" | "SETTLED" | "ARCHIVED" {
  const s = normalizeStatus(value);
  if (!s) return "ACTIVE";

  if (["archived"].includes(s)) return "ARCHIVED";
  if (
    ["finalized", "finalised", "determined", "settled", "resolved"].includes(s)
  )
    return "SETTLED";
  if (
    [
      "closed",
      "expired",
      "halted",
      "suspended",
      "inactive",
      "paused",
      "cancelled",
      "canceled",
      "void",
    ].includes(s)
  )
    return "CLOSED";

  return "ACTIVE";
}

function aggregateEventStatus(
  markets: TDflowMarket[],
): "ACTIVE" | "CLOSED" | "SETTLED" | "ARCHIVED" {
  if (!markets.length) return "ACTIVE";
  const mapped = markets.map((m) => mapDflowStatusToUnified(m.status));
  if (mapped.includes("ACTIVE")) return "ACTIVE";
  if (mapped.includes("SETTLED")) return "SETTLED";
  if (mapped.includes("CLOSED")) return "CLOSED";
  if (mapped.includes("ARCHIVED")) return "ARCHIVED";
  return "ACTIVE";
}

function pickEventTicker(e: TDflowEvent): string | null {
  const candidates = [e.event_ticker, e.eventTicker, e.ticker, e.id].filter(
    (x): x is string => typeof x === "string" && x.trim().length > 0,
  );
  return candidates[0] ? candidates[0].trim() : null;
}

export function mapToUnifiedEvent(
  e: TDflowEvent,
  seriesLookup?: Map<string, DflowSeriesInfo>,
): UnifiedEventRow | null {
  const venueEventId = pickEventTicker(e);
  if (!venueEventId) return null;

  const extra = e as Record<string, unknown>;
  const markets = (e.markets ?? []) as TDflowMarket[];
  const openTimes = markets.map((m) =>
    parseDate(m.openTime ?? (m as Record<string, unknown>).open_time),
  );
  const closeTimes = markets.map((m) =>
    parseDate(m.closeTime ?? (m as Record<string, unknown>).close_time),
  );
  const expTimes = markets.map((m) =>
    parseDate(
      m.expirationTime ?? (m as Record<string, unknown>).expiration_time,
    ),
  );

  const start_date =
    parseDate((e as Record<string, unknown>).openTime) ??
    parseDate((e as Record<string, unknown>).open_time) ??
    parseDate(e.startDate) ??
    minDate(openTimes);
  const end_date =
    parseDate((e as Record<string, unknown>).closeTime) ??
    parseDate((e as Record<string, unknown>).close_time) ??
    parseDate(e.endDate) ??
    maxDate(expTimes.concat(closeTimes));

  const derivedVolumeTotal = markets.reduce(
    (sum, m) => sum + (n(m.volume) ?? 0),
    0,
  );
  const derivedVolume24h = markets.reduce(
    (sum, m) => sum + (n(m.volume24h) ?? 0),
    0,
  );
  const derivedLiquidityCents = markets.reduce(
    (sum, m) => sum + (n(m.liquidity) ?? 0),
    0,
  );
  const derivedOpenInterest = markets.reduce(
    (sum, m) => sum + (n(m.openInterest) ?? 0),
    0,
  );

  const volume_total =
    pickNumber([extra], ["volume", "volumeTotal", "volume_total"]) ??
    (derivedVolumeTotal > 0 ? derivedVolumeTotal : undefined);
  const volume_24h =
    pickNumber([extra], ["volume24h", "volume_24h", "volume24hr"]) ??
    (derivedVolume24h > 0 ? derivedVolume24h : undefined);
  const liquidityUsd = pickNumber([extra], ["liquidityUsd", "liquidity_usd"]);
  const liquidityCents =
    pickNumber([extra], ["liquidity", "liquidityNum"]) ??
    (derivedLiquidityCents > 0 ? derivedLiquidityCents : undefined);
  const liquidity =
    liquidityUsd ?? (liquidityCents != null ? liquidityCents / 100 : undefined);
  const open_interest =
    pickNumber([extra], ["openInterest", "open_interest", "openInterestNum"]) ??
    (derivedOpenInterest > 0 ? derivedOpenInterest : undefined);

  const status = aggregateEventStatus(markets);

  const image =
    s(extra.imageUrl) ?? s(extra.image_url) ?? s(extra.image) ?? undefined;
  const icon = s(extra.icon) ?? s(extra.iconUrl) ?? s(extra.icon_url);
  const slug = s(extra.slug);
  const subtitle = s(extra.subtitle);
  const seriesTicker = s(extra.seriesTicker) ?? s(extra.series_ticker);
  const seriesTitle = s(extra.seriesTitle) ?? s(extra.series_title);
  const seriesInfo =
    seriesTicker && seriesLookup ? seriesLookup.get(seriesTicker) : undefined;
  const seriesTitleResolved = seriesTitle ?? seriesInfo?.title;
  const seriesTags =
    Array.isArray(extra.seriesTags) &&
    extra.seriesTags.every((value) => typeof value === "string")
      ? (extra.seriesTags as string[])
      : Array.isArray(extra.series_tags) &&
          extra.series_tags.every((value) => typeof value === "string")
        ? (extra.series_tags as string[])
        : seriesInfo?.tags;
  const eventCategory = resolveDflowEventCategory({
    eventCategory: e.category,
    seriesCategory: seriesInfo?.category,
    seriesTags,
  });
  const competition = s(extra.competition);
  const competitionScope =
    s(extra.competitionScope) ?? s(extra.competition_scope);
  const strikeDate = s(extra.strikeDate) ?? s(extra.strike_date);
  const strikePeriod = s(extra.strikePeriod) ?? s(extra.strike_period);
  const settlementSources =
    Array.isArray(extra.settlementSources) && extra.settlementSources.length
      ? extra.settlementSources
      : Array.isArray(extra.settlement_sources) &&
          extra.settlement_sources.length
        ? extra.settlement_sources
        : undefined;
  const metadata = compactMetadata({
    seriesTicker,
    subtitle,
    competition,
    competitionScope,
    strikeDate,
    strikePeriod,
    settlementSources,
    seriesCategory: seriesInfo?.category,
    seriesTags,
    seriesTitle: seriesTitleResolved,
  });

  return {
    id: `kalshi:${venueEventId}`,
    venue: "kalshi",
    venue_event_id: venueEventId,
    title:
      (typeof e.title === "string" && e.title.trim().length
        ? e.title.trim()
        : venueEventId) || venueEventId,
    description:
      typeof (e as Record<string, unknown>).description === "string"
        ? ((e as Record<string, unknown>).description as string)
        : undefined,
    category: eventCategory,
    status,
    series_key: seriesTicker ?? undefined,
    series_title: seriesTitleResolved ?? undefined,
    start_date,
    end_date,
    volume_total,
    volume_24h,
    open_interest,
    liquidity,
    metadata,
    slug,
    image,
    icon,
    created_at: undefined,
    updated_at: undefined,
  };
}

type Instrument = {
  settlementMint: string;
  yesMint: string;
  noMint: string;
  account?: Record<string, unknown>;
};

function pickUsdcInstrument(
  market: TDflowMarket,
  usdcMint: string,
): Instrument | null {
  const accounts = market.accounts ?? {};
  const entry = (accounts as Record<string, TDflowMarketAccount | null>)[
    usdcMint
  ];
  if (!entry) return null;

  const yes = entry.yesMint?.trim();
  const no = entry.noMint?.trim();
  if (!yes || !no) return null;

  return {
    settlementMint: usdcMint,
    yesMint: yes,
    noMint: no,
    account: entry as unknown as Record<string, unknown>,
  };
}

export type DflowMarketSnapshot = {
  marketId: string;
  yesTokenId: string;
  noTokenId: string;
  yesBid: number | null;
  yesAsk: number | null;
  noBid: number | null;
  noAsk: number | null;
  volumeTotal: number;
  volume24h: number;
  openInterest: number;
  liquidity: number;
};

export type DflowMappedMarket = {
  marketRow: UnifiedMarketRow;
  tokenRows: Array<{
    token_id: string;
    market_id: string;
    side: "YES" | "NO";
  }>;
  snapshot: DflowMarketSnapshot | null;
};

export function mapToUnifiedMarket(
  market: TDflowMarket,
  eventId: string,
  eventTitle: string,
  eventCategory: string | null | undefined,
  usdcMint: string,
  requireInitialized: boolean,
): DflowMappedMarket | null {
  const status = mapDflowStatusToUnified(market.status);
  const instrument = pickUsdcInstrument(market, usdcMint);
  if (!instrument) return null;

  const extra = market as Record<string, unknown>;
  const account = instrument.account;

  const yesTokenId = `sol:${instrument.yesMint}`;
  const noTokenId = `sol:${instrument.noMint}`;

  const yesBid = n(market.yesBid);
  const yesAsk = n(market.yesAsk);
  const noBid = n(market.noBid);
  const noAsk = n(market.noAsk);

  const volumeTotal = pickNumber(
    [account, extra],
    ["volume", "volumeTotal", "volume_total", "volumeNum"],
  );
  const volume24h = pickNumber(
    [account, extra],
    ["volume24h", "volume_24h", "volume24hr", "volume_24hr", "volume24Hr"],
  );
  const liquidityUsd = pickNumber(
    [account, extra],
    ["liquidityUsd", "liquidity_usd"],
  );
  const liquidityCents = pickNumber(
    [account, extra],
    ["liquidity", "liquidityNum"],
  );
  const openInterest = pickNumber(
    [account, extra],
    ["openInterest", "open_interest", "openInterestNum"],
  );

  const marketLedgerRaw =
    typeof account?.marketLedger === "string"
      ? account.marketLedger
      : typeof account?.market_ledger === "string"
        ? account.market_ledger
        : undefined;
  const marketLedger = marketLedgerRaw?.trim() || undefined;

  const redemptionRaw =
    typeof account?.redemptionStatus === "string"
      ? account.redemptionStatus
      : typeof account?.redemption_status === "string"
        ? account.redemption_status
        : undefined;
  const redemptionStatus = redemptionRaw?.trim() || undefined;

  const isInitialized =
    typeof account?.isInitialized === "boolean"
      ? account.isInitialized
      : undefined;
  const initializedForTrading = !requireInitialized || isInitialized === true;
  const dflowNativeAcceptingOrders =
    status === "ACTIVE" &&
    initializedForTrading &&
    (isNonTerminalAsk(yesAsk) || isNonTerminalAsk(noAsk));
  const tradableYesBid = dflowNativeAcceptingOrders ? yesBid : undefined;
  const tradableYesAsk = dflowNativeAcceptingOrders ? yesAsk : undefined;

  const normalizedVolume24h = volume24h ?? 0;
  const normalizedLiquidity =
    liquidityUsd ?? (liquidityCents != null ? liquidityCents / 100 : 0);

  const open_time =
    parseDate(
      market.openTime ?? (market as Record<string, unknown>).open_time,
    ) ??
    parseDate((market as Record<string, unknown>).startDate) ??
    undefined;
  const close_time =
    parseDate(
      market.closeTime ?? (market as Record<string, unknown>).close_time,
    ) ??
    parseDate((market as Record<string, unknown>).endDate) ??
    undefined;
  const expiration_time =
    parseDate(
      market.expirationTime ??
        (market as Record<string, unknown>).expiration_time,
    ) ?? close_time;

  const outcomeLabel = (() => {
    const record = market as Record<string, unknown>;
    const candidates = [
      record.yesSubTitle,
      record.yes_sub_title,
      record.noSubTitle,
      record.no_sub_title,
    ];
    for (const c of candidates) {
      if (typeof c !== "string") continue;
      const trimmed = c.trim();
      if (trimmed.length) return trimmed;
    }
    return null;
  })();

  const title =
    (outcomeLabel ??
      (typeof market.title === "string" && market.title.trim().length
        ? market.title.trim()
        : eventTitle.trim().length
          ? eventTitle
          : market.ticker)) ||
    market.ticker;

  const subtitle = s(extra.subtitle);
  const yesSubTitle = s(extra.yesSubTitle) ?? s(extra.yes_sub_title);
  const noSubTitle = s(extra.noSubTitle) ?? s(extra.no_sub_title);
  const rulesPrimary = s(extra.rulesPrimary) ?? s(extra.rules_primary);
  const rulesSecondary = s(extra.rulesSecondary) ?? s(extra.rules_secondary);
  const earlyCloseCondition =
    s(extra.earlyCloseCondition) ?? s(extra.early_close_condition);
  const result = s(extra.result);
  const scalarOutcomePct = pickNumber(
    [account, extra],
    ["scalarOutcomePct", "scalar_outcome_pct"],
  );
  const resolvedOutcome =
    result?.toLowerCase() === "yes"
      ? "YES"
      : result?.toLowerCase() === "no"
        ? "NO"
        : undefined;
  const marketType = s(extra.marketType) ?? s(extra.market_type);
  const canCloseEarly =
    typeof extra.canCloseEarly === "boolean" ? extra.canCloseEarly : undefined;
  const metadata = compactMetadata({
    subtitle,
    yesSubTitle,
    noSubTitle,
    rulesPrimary,
    rulesSecondary,
    earlyCloseCondition,
    canCloseEarly,
    result,
    scalarOutcomePct,
    marketType,
    dflowNativeAcceptingOrders,
  });

  const image =
    s(extra.imageUrl) ?? s(extra.image_url) ?? s(extra.image) ?? undefined;
  const icon = s(extra.icon) ?? s(extra.iconUrl) ?? s(extra.icon_url);
  const slug = s(extra.slug);

  const marketRow: UnifiedMarketRow = {
    id: `kalshi:${market.ticker}`,
    venue: "kalshi",
    venue_market_id: market.ticker,
    event_id: eventId,
    title,
    description:
      typeof (market as Record<string, unknown>).description === "string"
        ? ((market as Record<string, unknown>).description as string)
        : undefined,
    category: resolveDflowMarketCategory({
      marketCategory:
        typeof (market as Record<string, unknown>).category === "string"
          ? ((market as Record<string, unknown>).category as string)
          : undefined,
      eventCategory,
    }),
    status,
    market_type: "binary",
    open_time,
    close_time,
    expiration_time,
    best_bid: tradableYesBid,
    best_ask: tradableYesAsk,
    last_price:
      tradableYesBid != null && tradableYesAsk != null
        ? (tradableYesBid + tradableYesAsk) / 2
        : undefined,
    volume_total: volumeTotal,
    volume_24h: normalizedVolume24h,
    open_interest: openInterest,
    liquidity: normalizedLiquidity,
    metadata,
    outcomes: JSON.stringify(["YES", "NO"]),
    token_yes: yesTokenId,
    token_no: noTokenId,
    condition_id: undefined,
    market_ledger: marketLedger,
    settlement_mint: instrument.settlementMint,
    is_initialized: isInitialized,
    redemption_status: redemptionStatus,
    resolved_outcome: resolvedOutcome,
    resolved_outcome_pct: scalarOutcomePct,
    slug,
    image,
    icon,
    created_at: undefined,
    updated_at: undefined,
  };

  const tokenRows = [
    { token_id: yesTokenId, market_id: marketRow.id, side: "YES" as const },
    { token_id: noTokenId, market_id: marketRow.id, side: "NO" as const },
  ];

  const snapshot: DflowMarketSnapshot | null =
    status === "ACTIVE" &&
    dflowNativeAcceptingOrders &&
    (!requireInitialized || isInitialized === true)
      ? {
          marketId: marketRow.id,
          yesTokenId,
          noTokenId,
          yesBid: yesBid ?? null,
          yesAsk: yesAsk ?? null,
          noBid: noBid ?? null,
          noAsk: noAsk ?? null,
          volumeTotal: volumeTotal ?? 0,
          volume24h: volume24h ?? 0,
          openInterest: openInterest ?? 0,
          liquidity: normalizedLiquidity,
        }
      : null;

  return { marketRow, tokenRows, snapshot };
}

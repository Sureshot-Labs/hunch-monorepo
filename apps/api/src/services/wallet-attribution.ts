import type { PoolClient } from "pg";

import type {
  WalletActivitySignalSummary,
  WalletActivityTopChange,
} from "./wallet-activity-summary.js";
import type { WalletIntelAttributionPolicy } from "./runtime-policies.js";

export type WalletAttributionPrimaryKey =
  | "whale"
  | "specialist"
  | "bot"
  | "insider";

export type WalletAttributionLabelKey =
  | "sports_specialist"
  | "politics_specialist"
  | "crypto_specialist"
  | "macro_specialist"
  | "tech_specialist"
  | "weather_specialist"
  | "health_specialist"
  | "culture_specialist"
  | "mentions_specialist"
  | "high_win_rate"
  | "high_conviction"
  | "consistent_performer"
  | "100k_pnl"
  | "1m_pnl"
  | "10m_pnl"
  | "large_positions"
  | "market_mover"
  | "fresh_wallet"
  | "dormant_wake_up"
  | "late_entry"
  | "close_to_settlement"
  | "unusual_behavior"
  | "high_frequency"
  | "volume_trader";

export type WalletSignalSeverity = "low" | "medium" | "high" | "critical";

export type WalletAttributionCandidate = {
  key: WalletAttributionPrimaryKey;
  score: number;
};

export type WalletAttribution = {
  primary: WalletAttributionPrimaryKey | null;
  primaryCandidates: WalletAttributionCandidate[];
  secondary: WalletAttributionLabelKey[];
  supporting: WalletAttributionLabelKey[];
  display: {
    listPrimary: WalletAttributionPrimaryKey[];
    listSecondary: WalletAttributionLabelKey[];
    detailsSecondary: WalletAttributionLabelKey[];
    detailsSupporting: WalletAttributionLabelKey[];
  };
  reasons: string[];
  version: "v1";
};

export type WalletAttributionTag = {
  slug: string;
  label?: string;
  tag_type?: string;
  is_system?: boolean;
};

export type WalletAttributionMetrics = {
  volume_usd?: number | string | null;
  pnl_usd?: number | string | null;
  trades_count?: number | null;
  win_rate?: number | string | null;
};

export type WalletAttributionInput = {
  walletId: string;
  tags?: WalletAttributionTag[] | null;
  metrics?: WalletAttributionMetrics | null;
  inferredWinRate?: number | null;
  inferredResolvedCount?: number | null;
  trackedExposureUsd?: number | null;
  signalSummary?: WalletActivitySignalSummary | null;
  topChanges?: WalletActivityTopChange[] | null;
};

export type WalletAttributionBuildOptions = {
  mode?: "full" | "filters";
  filterPrimary?: WalletAttributionPrimaryKey[] | null;
  filterLabels?: WalletAttributionLabelKey[] | null;
};

type VenueKey = "polymarket" | "kalshi" | "limitless";

type WalletVenueStats = {
  volume30dUsd: number;
  trades30d: number;
  activeDays30d: number;
  maxStakeUsd: number;
  medianStakeUsd: number | null;
  maxStakeToMarketVolRatio: number | null;
  topCategoryFamily: SpecialistFamily | null;
  topCategoryShare: number | null;
};

type WalletComputedStats = {
  exposureUsd: number;
  hedgedNotionalUsd: number;
  netImbalanceUsd: number;
  hedgeRatio: number;
  twoSidedMarkets: number;
  inferredWinRate: number | null;
  inferredResolvedCount: number | null;
  pnl30dUsd: number | null;
  trades30dTotal: number;
  maxStakeUsdAnyVenue: number;
  maxStakeToMarketVolRatioAnyVenue: number | null;
};

type CandidateScore = {
  key: WalletAttributionPrimaryKey;
  score: number;
  reasons: string[];
  venue: VenueKey | null;
  venueVolume30d: number;
};

type VenueStatsRow = {
  wallet_id: string;
  venue: string;
  volume_30d_usd: string | null;
  trades_30d: number | null;
  active_days_30d: number | null;
  max_stake_usd: string | null;
  median_stake_usd: string | null;
};

type CategoryVolumeRow = {
  wallet_id: string;
  venue: string;
  raw_category: string | null;
  volume_usd: string | null;
};

type RatioRow = {
  wallet_id: string;
  venue: string;
  max_stake_to_market_vol_ratio: string | null;
};

type ExposureRow = {
  wallet_id: string;
  exposure_usd: string | null;
  hedged_notional_usd: string | null;
  net_imbalance_usd: string | null;
  hedge_ratio: string | null;
  two_sided_markets: number | null;
};

type InferredOutcomeRow = {
  wallet_id: string;
  wins: number;
  total: number;
};

type SpecialistFamily =
  | "sports"
  | "politics"
  | "crypto"
  | "macro"
  | "technology"
  | "weather"
  | "health"
  | "culture"
  | "mentions";

const SPECIALIST_LABEL_BY_FAMILY: Record<SpecialistFamily, WalletAttributionLabelKey> =
  {
    sports: "sports_specialist",
    politics: "politics_specialist",
    crypto: "crypto_specialist",
    macro: "macro_specialist",
    technology: "tech_specialist",
    weather: "weather_specialist",
    health: "health_specialist",
    culture: "culture_specialist",
    mentions: "mentions_specialist",
  };

const FAMILY_ALIASES: Record<SpecialistFamily, Set<string>> = {
  sports: new Set([
    "sports",
    "nba playoffs",
    "football matches",
    "esports",
    "cricket",
    "olympics",
    "chess",
    "poker",
  ]),
  politics: new Set([
    "politics",
    "us-current-affairs",
    "global politics",
    "elections",
    "world",
    "social",
  ]),
  crypto: new Set([
    "crypto",
    "bitcoin",
    "ethereum",
    "solana",
    "nfts",
    "pre-tge",
  ]),
  macro: new Set([
    "economics",
    "economy",
    "financials",
    "business",
    "companies",
    "company news",
    "company-news",
    "oil & gas",
    "oil-gas",
    "commodities",
  ]),
  technology: new Set([
    "technology",
    "tech",
    "science and technology",
    "science",
    "space",
  ]),
  weather: new Set(["weather", "climate and weather"]),
  health: new Set(["health", "coronavirus", "medical", "biotech"]),
  culture: new Set(["entertainment", "pop-culture", "culture", "art"]),
  mentions: new Set(["mentions"]),
};

const UNMAPPED_CATEGORY_ALIASES = new Set([
  "hourly",
  "daily",
  "weekly",
  "this vs that",
  "off the pitch",
  "korean market",
  "other",
]);

const PRIMARY_KEY_ORDER_FALLBACK: WalletAttributionPrimaryKey[] = [
  "whale",
  "specialist",
  "bot",
  "insider",
];

const LABEL_ORDER: WalletAttributionLabelKey[] = [
  "sports_specialist",
  "politics_specialist",
  "crypto_specialist",
  "macro_specialist",
  "tech_specialist",
  "weather_specialist",
  "health_specialist",
  "culture_specialist",
  "mentions_specialist",
  "high_win_rate",
  "high_conviction",
  "consistent_performer",
  "100k_pnl",
  "1m_pnl",
  "10m_pnl",
  "large_positions",
  "market_mover",
  "fresh_wallet",
  "dormant_wake_up",
  "late_entry",
  "close_to_settlement",
  "unusual_behavior",
  "high_frequency",
  "volume_trader",
];

const PRIMARY_KEY_SET = new Set<WalletAttributionPrimaryKey>(
  PRIMARY_KEY_ORDER_FALLBACK,
);
const LABEL_KEY_SET = new Set<WalletAttributionLabelKey>(LABEL_ORDER);
const SPECIALIST_LABEL_SET = new Set<WalletAttributionLabelKey>([
  "sports_specialist",
  "politics_specialist",
  "crypto_specialist",
  "macro_specialist",
  "tech_specialist",
  "weather_specialist",
  "health_specialist",
  "culture_specialist",
  "mentions_specialist",
]);

const VENUE_ORDER_FALLBACK: VenueKey[] = ["polymarket", "kalshi", "limitless"];

const REASON_PRIORITY: Record<string, number> = {
  high_risk_longshot: 0,
  reactivated_after_idle: 1,
  narrow_history: 2,
  unusual_size: 3,
  entered_late: 4,
  out_of_pattern: 5,
  longshot_odds: 6,
  high_notional: 7,
};

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function isPositiveThreshold(value: number | null | undefined): boolean {
  return Number.isFinite(value) && (value ?? 0) > 0;
}

export function minPositiveThreshold(values: number[]): number | null {
  const positives = values.filter((value) => isPositiveThreshold(value));
  if (positives.length === 0) return null;
  return Math.min(...positives);
}

function toNumber(value: unknown): number | null {
  if (value == null) return null;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseVenue(value: string | null | undefined): VenueKey | null {
  if (!value) return null;
  const normalized = value.trim().toLowerCase();
  if (
    normalized === "polymarket" ||
    normalized === "kalshi" ||
    normalized === "limitless"
  ) {
    return normalized;
  }
  return null;
}

function normalizeCategoryAlias(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const normalized = raw.trim().toLowerCase();
  if (!normalized) return null;
  return normalized.replace(/_/g, " ");
}

function mapCategoryToFamily(raw: string | null | undefined): SpecialistFamily | null {
  const normalized = normalizeCategoryAlias(raw);
  if (!normalized) return null;
  if (UNMAPPED_CATEGORY_ALIASES.has(normalized)) return null;
  for (const [family, aliases] of Object.entries(FAMILY_ALIASES) as Array<
    [SpecialistFamily, Set<string>]
  >) {
    if (aliases.has(normalized)) return family;
  }
  return null;
}

export function normalizeAttributionPrimaryFilters(
  values: string[] | null | undefined,
): WalletAttributionPrimaryKey[] {
  if (!values || values.length === 0) return [];
  return Array.from(
    new Set(
      values
        .map((value) => value.trim().toLowerCase())
        .filter((value): value is WalletAttributionPrimaryKey =>
          PRIMARY_KEY_SET.has(value as WalletAttributionPrimaryKey),
        ),
    ),
  );
}

export function normalizeAttributionLabelFilters(
  values: string[] | null | undefined,
): WalletAttributionLabelKey[] {
  if (!values || values.length === 0) return [];
  return Array.from(
    new Set(
      values
        .map((value) => value.trim().toLowerCase())
        .filter((value): value is WalletAttributionLabelKey =>
          LABEL_KEY_SET.has(value as WalletAttributionLabelKey),
        ),
    ),
  );
}

function normalizedReasonCodes(change: WalletActivityTopChange): string[] {
  const merged = new Set<string>();
  for (const label of change.signalLabels ?? []) {
    if (label?.trim()) merged.add(label.trim());
  }
  for (const label of change.labels ?? []) {
    if (label?.trim()) merged.add(label.trim());
  }
  return Array.from(merged);
}

function deriveSignalSummaryFromTopChanges(
  topChanges: WalletActivityTopChange[],
): WalletActivitySignalSummary {
  const signalScores = topChanges
    .map((change) => toNumber(change.signalScore))
    .filter((value): value is number => value != null);
  return {
    criticalSignals30d: signalScores.filter((score) => score >= 0.9).length,
    avgSignalScore30d:
      signalScores.length > 0
        ? signalScores.reduce((sum, value) => sum + value, 0) /
          signalScores.length
        : null,
    hasReactivatedAfterIdle: topChanges.some((change) =>
      normalizedReasonCodes(change).includes("reactivated_after_idle"),
    ),
    hasLateEntry: topChanges.some((change) => {
      const labels = new Set(normalizedReasonCodes(change));
      return (
        labels.has("entered_late") ||
        change.lateBucket === "late" ||
        change.lateBucket === "very_late"
      );
    }),
    hasVeryLateEntry: topChanges.some(
      (change) => change.lateBucket === "very_late",
    ),
    hasUnusualBehavior: topChanges.some((change) => {
      const labels = new Set(normalizedReasonCodes(change));
      return (
        labels.has("unusual_size") ||
        labels.has("out_of_pattern") ||
        labels.has("high_risk_longshot")
      );
    }),
  };
}

function sortReasonCodes(reasonCodes: string[]): string[] {
  const deduped = Array.from(new Set(reasonCodes.filter(Boolean)));
  return deduped.sort((a, b) => {
    const pa = REASON_PRIORITY[a] ?? 99;
    const pb = REASON_PRIORITY[b] ?? 99;
    if (pa !== pb) return pa - pb;
    return a.localeCompare(b);
  });
}

function sortAttributionLabels(
  labels: Iterable<WalletAttributionLabelKey>,
): WalletAttributionLabelKey[] {
  const index = new Map<WalletAttributionLabelKey, number>();
  for (let i = 0; i < LABEL_ORDER.length; i += 1) {
    index.set(LABEL_ORDER[i], i);
  }
  return Array.from(new Set(labels)).sort((a, b) => {
    const ia = index.get(a) ?? 999;
    const ib = index.get(b) ?? 999;
    if (ia !== ib) return ia - ib;
    return a.localeCompare(b);
  });
}

function buildDisplayReasons(
  reasonCodes: string[],
  policy: WalletIntelAttributionPolicy,
): string[] {
  const sorted = sortReasonCodes(reasonCodes);
  const hideGateReasons =
    policy.signalsDisplay.hideRedundantReasonsWhenGateImplies &&
    sorted.some(
      (reason) => reason !== "longshot_odds" && reason !== "high_notional",
    );
  const filtered = hideGateReasons
    ? sorted.filter((reason) => reason !== "longshot_odds" && reason !== "high_notional")
    : sorted;
  return filtered.slice(0, policy.signalsDisplay.maxDisplayReasons);
}

function resolveSignalSeverity(
  venue: VenueKey | null,
  score: number | null | undefined,
  policy: WalletIntelAttributionPolicy,
): WalletSignalSeverity {
  const parsedScore = clamp(toNumber(score) ?? 0, 0, 1);
  const thresholds = venue
    ? policy.signalsDisplay.severityThresholds[venue]
    : policy.signalsDisplay.severityThresholds.default;
  if (parsedScore >= thresholds.critical) return "critical";
  if (parsedScore >= thresholds.high) return "high";
  if (parsedScore >= thresholds.medium) return "medium";
  return "low";
}

function normalizeTieBreakOrder(
  policy: WalletIntelAttributionPolicy,
): WalletAttributionPrimaryKey[] {
  const values = Array.from(
    new Set(
      policy.ruleWeights.primaryTieBreakOrder.filter((item) =>
        PRIMARY_KEY_ORDER_FALLBACK.includes(item),
      ),
    ),
  );
  for (const key of PRIMARY_KEY_ORDER_FALLBACK) {
    if (!values.includes(key)) values.push(key);
  }
  return values;
}

function normalizeVenueOrder(policy: WalletIntelAttributionPolicy): VenueKey[] {
  const values = Array.from(
    new Set(
      policy.multiVenueMerge.fixedVenueOrder.filter((item) =>
        VENUE_ORDER_FALLBACK.includes(item),
      ),
    ),
  );
  for (const venue of VENUE_ORDER_FALLBACK) {
    if (!values.includes(venue)) values.push(venue);
  }
  return values;
}

async function loadVenueStats(
  client: PoolClient,
  walletIds: string[],
  options?: {
    includeCategoryStats?: boolean;
    includeRatioStats?: boolean;
  },
): Promise<Map<string, Map<VenueKey, WalletVenueStats>>> {
  const byWallet = new Map<string, Map<VenueKey, WalletVenueStats>>();
  if (walletIds.length === 0) return byWallet;
  const includeCategoryStats = options?.includeCategoryStats ?? true;
  const includeRatioStats = options?.includeRatioStats ?? true;

  const [statsResult, categoryRows, ratioRows] = await Promise.all([
    client.query<VenueStatsRow>(
      `
        select
          wah.wallet_id,
          wah.venue,
          sum(coalesce(wah.volume_usd, abs(wah.signed_delta_usd), 0)) as volume_30d_usd,
          sum(coalesce(wah.event_count, 0))::int as trades_30d,
          count(distinct date(wah.hour_bucket))::int as active_days_30d,
          max(coalesce(wah.max_abs_delta_usd, wah.abs_delta_usd, abs(wah.signed_delta_usd), 0)) as max_stake_usd,
          percentile_cont(0.5) within group (
            order by coalesce(
              nullif(abs(wah.abs_delta_usd), 0),
              nullif(abs(wah.max_abs_delta_usd), 0),
              abs(coalesce(wah.signed_delta_usd, 0))
            )
          ) as median_stake_usd
        from wallet_activity_hourly wah
        where wah.wallet_id = any($1::uuid[])
          and wah.activity_type in ('delta', 'trade')
          and wah.hour_bucket >= now() - interval '30 days'
        group by wah.wallet_id, wah.venue
      `,
      [walletIds],
    ),
    includeCategoryStats
      ? client
          .query<CategoryVolumeRow>(
            `
              with wallet_market as (
                select
                  wah.wallet_id,
                  wah.venue,
                  wah.market_id,
                  sum(coalesce(wah.volume_usd, abs(wah.signed_delta_usd), 0)) as volume_usd
                from wallet_activity_hourly wah
                where wah.wallet_id = any($1::uuid[])
                  and wah.activity_type in ('delta', 'trade')
                  and wah.hour_bucket >= now() - interval '30 days'
                group by wah.wallet_id, wah.venue, wah.market_id
              ),
              market_meta as (
                select
                  um.id as market_id,
                  lower(um.category) as market_category,
                  um.event_id
                from unified_markets um
                join (
                  select distinct market_id
                  from wallet_market
                ) mk on mk.market_id = um.id
              ),
              event_lookup as (
                select
                  ue.id as event_id,
                  lower(ue.category) as event_category
                from unified_events ue
                join (
                  select distinct mm.event_id
                  from market_meta mm
                  where mm.market_category is null
                    and mm.event_id is not null
                ) ev on ev.event_id = ue.id
              )
              select
                wm.wallet_id,
                wm.venue,
                coalesce(mm.market_category, el.event_category) as raw_category,
                sum(wm.volume_usd) as volume_usd
              from wallet_market wm
              left join market_meta mm on mm.market_id = wm.market_id
              left join event_lookup el on el.event_id = mm.event_id
              group by wm.wallet_id, wm.venue, coalesce(mm.market_category, el.event_category)
            `,
            [walletIds],
          )
          .then((result) => result.rows)
      : Promise.resolve([] as CategoryVolumeRow[]),
    includeRatioStats
      ? client
          .query<RatioRow>(
            `
              with wallet_market as (
                select
                  wah.wallet_id,
                  wah.venue,
                  wah.market_id,
                  sum(coalesce(wah.abs_delta_usd, abs(wah.signed_delta_usd), 0)) as wallet_notional_24h
                from wallet_activity_hourly wah
                where wah.wallet_id = any($1::uuid[])
                  and wah.activity_type in ('delta', 'trade')
                  and wah.hour_bucket >= now() - interval '24 hours'
                group by wah.wallet_id, wah.venue, wah.market_id
              ),
              market_scope as (
                select distinct venue, market_id
                from wallet_market
              ),
              market_total as (
                select
                  wah.venue,
                  wah.market_id,
                  sum(coalesce(wah.abs_delta_usd, abs(wah.signed_delta_usd), 0)) as market_notional_24h
                from wallet_activity_hourly wah
                join market_scope ms
                  on ms.venue = wah.venue
                 and ms.market_id = wah.market_id
                where wah.activity_type in ('delta', 'trade')
                  and wah.hour_bucket >= now() - interval '24 hours'
                group by wah.venue, wah.market_id
              )
              select
                wm.wallet_id,
                wm.venue,
                max(
                  case
                    when mt.market_notional_24h > 0
                      then wm.wallet_notional_24h / mt.market_notional_24h
                    else null
                  end
                ) as max_stake_to_market_vol_ratio
              from wallet_market wm
              left join market_total mt
                on mt.venue = wm.venue
               and mt.market_id = wm.market_id
              group by wm.wallet_id, wm.venue
            `,
            [walletIds],
          )
          .then((result) => result.rows)
      : Promise.resolve([] as RatioRow[]),
  ]);

  for (const row of statsResult.rows) {
    const venue = parseVenue(row.venue);
    if (!venue) continue;
    const walletMap = byWallet.get(row.wallet_id) ?? new Map<VenueKey, WalletVenueStats>();
    walletMap.set(venue, {
      volume30dUsd: toNumber(row.volume_30d_usd) ?? 0,
      trades30d: Math.max(0, Number(row.trades_30d ?? 0)),
      activeDays30d: Math.max(0, Number(row.active_days_30d ?? 0)),
      maxStakeUsd: toNumber(row.max_stake_usd) ?? 0,
      medianStakeUsd: toNumber(row.median_stake_usd),
      maxStakeToMarketVolRatio: null,
      topCategoryFamily: null,
      topCategoryShare: null,
    });
    byWallet.set(row.wallet_id, walletMap);
  }

  const categoryVolume = new Map<
    string,
    { totals: number; familyTotals: Map<SpecialistFamily, number> }
  >();
  for (const row of categoryRows) {
    const venue = parseVenue(row.venue);
    if (!venue) continue;
    const key = `${row.wallet_id}:${venue}`;
    const volume = Math.max(0, toNumber(row.volume_usd) ?? 0);
    if (volume <= 0) continue;
    const bucket = categoryVolume.get(key) ?? {
      totals: 0,
      familyTotals: new Map<SpecialistFamily, number>(),
    };
    bucket.totals += volume;
    const family = mapCategoryToFamily(row.raw_category);
    if (family) {
      bucket.familyTotals.set(family, (bucket.familyTotals.get(family) ?? 0) + volume);
    }
    categoryVolume.set(key, bucket);
  }

  for (const [key, value] of categoryVolume) {
    const [walletId, venueRaw] = key.split(":");
    const venue = parseVenue(venueRaw);
    if (!venue) continue;
    const walletMap = byWallet.get(walletId);
    const stats = walletMap?.get(venue);
    if (!walletMap || !stats || value.totals <= 0) continue;
    let bestFamily: SpecialistFamily | null = null;
    let bestShare = 0;
    for (const [family, familyVolume] of value.familyTotals) {
      const share = familyVolume / value.totals;
      if (share > bestShare) {
        bestShare = share;
        bestFamily = family;
      }
    }
    stats.topCategoryFamily = bestFamily;
    stats.topCategoryShare = bestFamily ? bestShare : null;
  }

  for (const row of ratioRows) {
    const venue = parseVenue(row.venue);
    if (!venue) continue;
    const walletMap = byWallet.get(row.wallet_id);
    const stats = walletMap?.get(venue);
    if (!stats) continue;
    stats.maxStakeToMarketVolRatio = toNumber(row.max_stake_to_market_vol_ratio);
  }

  return byWallet;
}

async function loadComputedStats(
  client: PoolClient,
  wallets: WalletAttributionInput[],
): Promise<Map<string, WalletComputedStats>> {
  const map = new Map<string, WalletComputedStats>();
  if (wallets.length === 0) return map;
  const walletIds = wallets.map((wallet) => wallet.walletId);

  const [exposureResult, inferredResult] = await Promise.all([
    client.query<ExposureRow>(
      `
        select
          wallet_id,
          exposure_usd,
          hedged_notional_usd,
          net_imbalance_usd,
          hedge_ratio,
          two_sided_markets
        from wallet_position_exposure
        where wallet_id = any($1::uuid[])
      `,
      [walletIds],
    ),
    client.query<InferredOutcomeRow>(
      `
        select wallet_id, wins, total
        from wallet_inferred_outcomes
        where wallet_id = any($1::uuid[])
      `,
      [walletIds],
    ),
  ]);

  const exposureByWallet = new Map<
    string,
    {
      exposureUsd: number;
      hedgedNotionalUsd: number;
      netImbalanceUsd: number;
      hedgeRatio: number;
      twoSidedMarkets: number;
    }
  >();
  for (const row of exposureResult.rows) {
    exposureByWallet.set(row.wallet_id, {
      exposureUsd: Math.max(0, toNumber(row.exposure_usd) ?? 0),
      hedgedNotionalUsd: Math.max(0, toNumber(row.hedged_notional_usd) ?? 0),
      netImbalanceUsd: Math.max(0, toNumber(row.net_imbalance_usd) ?? 0),
      hedgeRatio: clamp(toNumber(row.hedge_ratio) ?? 0, 0, 1),
      twoSidedMarkets: Math.max(0, Number(row.two_sided_markets ?? 0)),
    });
  }

  const inferredByWallet = new Map<string, { winRate: number | null; resolved: number | null }>();
  for (const row of inferredResult.rows) {
    const resolved = Math.max(0, Number(row.total ?? 0));
    const wins = Math.max(0, Number(row.wins ?? 0));
    inferredByWallet.set(row.wallet_id, {
      winRate: resolved > 0 ? wins / resolved : null,
      resolved: resolved > 0 ? resolved : null,
    });
  }

  for (const wallet of wallets) {
    const inferred = inferredByWallet.get(wallet.walletId);
    const exposureRecord = exposureByWallet.get(wallet.walletId);
    const exposureFromInput = toNumber(wallet.trackedExposureUsd);
    const exposure =
      exposureFromInput != null
        ? Math.max(0, exposureFromInput)
        : exposureRecord?.exposureUsd ?? 0;
    const resolvedFromInput = toNumber(wallet.inferredResolvedCount);
    const winRateFromInput = toNumber(wallet.inferredWinRate);
    const inferredResolvedCount =
      resolvedFromInput != null
        ? Math.max(0, Math.trunc(resolvedFromInput))
        : inferred?.resolved ?? null;
    const inferredWinRate =
      winRateFromInput != null
        ? clamp(winRateFromInput, 0, 1)
        : inferred?.winRate ?? null;
    const pnl30dUsd = toNumber(wallet.metrics?.pnl_usd);
    const trades30dTotal = Math.max(
      0,
      Math.trunc(toNumber(wallet.metrics?.trades_count) ?? 0),
    );
    map.set(wallet.walletId, {
      exposureUsd: exposure,
      hedgedNotionalUsd: exposureRecord?.hedgedNotionalUsd ?? 0,
      netImbalanceUsd: exposureRecord?.netImbalanceUsd ?? 0,
      hedgeRatio: exposureRecord?.hedgeRatio ?? 0,
      twoSidedMarkets: exposureRecord?.twoSidedMarkets ?? 0,
      inferredWinRate,
      inferredResolvedCount,
      pnl30dUsd,
      trades30dTotal,
      maxStakeUsdAnyVenue: 0,
      maxStakeToMarketVolRatioAnyVenue: null,
    });
  }

  return map;
}

function scoreVenueCandidate(inputs: {
  policy: WalletIntelAttributionPolicy;
  venue: VenueKey;
  stats: WalletVenueStats;
  computed: WalletComputedStats;
  hasWhaleTag: boolean;
  criticalSignals30d: number;
  avgSignalScore30d: number | null;
}): CandidateScore[] {
  const candidates: CandidateScore[] = [];
  const thresholds = inputs.policy.venueThresholds[inputs.venue];
  const venueVolume = inputs.stats.volume30dUsd;

  const whaleQualified =
    inputs.hasWhaleTag ||
    (thresholds.whaleExposureUsd > 0 &&
      inputs.computed.exposureUsd >= thresholds.whaleExposureUsd) ||
    (thresholds.whaleVolume30dUsd > 0 &&
      inputs.stats.volume30dUsd >= thresholds.whaleVolume30dUsd) ||
    (thresholds.highConvictionStakeUsd > 0 &&
      inputs.stats.maxStakeUsd >= thresholds.highConvictionStakeUsd);
  if (whaleQualified) {
    const whaleScore = clamp(
      Math.max(
        inputs.hasWhaleTag ? 1 : 0,
        thresholds.whaleExposureUsd > 0
          ? inputs.computed.exposureUsd / thresholds.whaleExposureUsd
          : 0,
        thresholds.whaleVolume30dUsd > 0
          ? inputs.stats.volume30dUsd / thresholds.whaleVolume30dUsd
          : 0,
        thresholds.highConvictionStakeUsd > 0
          ? inputs.stats.maxStakeUsd / thresholds.highConvictionStakeUsd
          : 0,
      ),
      0,
      1,
    );
    const reasons: string[] = [];
    if (inputs.hasWhaleTag) reasons.push("whale_tag=true");
    if (
      thresholds.whaleExposureUsd > 0 &&
      inputs.computed.exposureUsd >= thresholds.whaleExposureUsd
    ) {
      reasons.push("exposure>=whale_exposure");
    }
    if (
      thresholds.whaleVolume30dUsd > 0 &&
      inputs.stats.volume30dUsd >= thresholds.whaleVolume30dUsd
    ) {
      reasons.push("volume30d>=whale_volume");
    }
    if (
      thresholds.highConvictionStakeUsd > 0 &&
      inputs.stats.maxStakeUsd >= thresholds.highConvictionStakeUsd
    ) {
      reasons.push("max_stake>=high_conviction");
    }
    candidates.push({
      key: "whale",
      score: whaleScore * Math.max(0, inputs.policy.ruleWeights.whale),
      reasons,
      venue: inputs.venue,
      venueVolume30d: venueVolume,
    });
  }

  if (inputs.policy.venueCapabilities[inputs.venue].specialistEnabled) {
    const share = inputs.stats.topCategoryShare;
    if (
      inputs.stats.topCategoryFamily &&
      share != null &&
      share >= thresholds.specialistCategoryShareMin
    ) {
      const specialistScore = clamp(
        share / Math.max(thresholds.specialistCategoryShareMin, 0.0001),
        0,
        1,
      );
      candidates.push({
        key: "specialist",
        score: specialistScore * Math.max(0, inputs.policy.ruleWeights.specialist),
        reasons: [
          `top_category=${inputs.stats.topCategoryFamily}`,
          "category_share>=specialist_min",
        ],
        venue: inputs.venue,
        venueVolume30d: venueVolume,
      });
    }
  }

  if (inputs.policy.sensitiveLabels.botEnabled) {
    const medianStake = inputs.stats.medianStakeUsd;
    const botQualified =
      inputs.stats.trades30d >= thresholds.highFrequencyTrades30d &&
      inputs.stats.activeDays30d >= thresholds.botMinActiveDays30d &&
      medianStake != null &&
      medianStake <= thresholds.botMaxMedianStakeUsd;
    if (botQualified) {
      const tradesRatio =
        thresholds.highFrequencyTrades30d > 0
          ? inputs.stats.trades30d / thresholds.highFrequencyTrades30d
          : 1;
      const activeDaysRatio =
        thresholds.botMinActiveDays30d > 0
          ? inputs.stats.activeDays30d / thresholds.botMinActiveDays30d
          : 1;
      const medianStakeRatio =
        thresholds.botMaxMedianStakeUsd > 0 && medianStake != null
          ? thresholds.botMaxMedianStakeUsd / Math.max(medianStake, 1)
          : 1;
      const botScore = clamp(
        (tradesRatio + activeDaysRatio + medianStakeRatio) / 3,
        0,
        1,
      );
      candidates.push({
        key: "bot",
        score: botScore * Math.max(0, inputs.policy.ruleWeights.bot),
        reasons: [
          "trades30d>=bot_hf_min",
          "active_days30d>=bot_active_days_min",
          "median_stake<=bot_median_stake_max",
        ],
        venue: inputs.venue,
        venueVolume30d: venueVolume,
      });
    }
  }

  if (inputs.policy.sensitiveLabels.insiderEnabled) {
    const insiderQualified =
      inputs.criticalSignals30d >= thresholds.insiderCriticalSignals30dMin &&
      (inputs.avgSignalScore30d ?? 0) >= thresholds.insiderAvgSignalScoreMin &&
      (inputs.computed.inferredResolvedCount ?? 0) >= thresholds.insiderMinResolvedBets &&
      (inputs.computed.inferredWinRate ?? 0) >= thresholds.insiderWinRateMin;
    if (insiderQualified) {
      const insiderScore = clamp(
        Math.max(
          thresholds.insiderCriticalSignals30dMin > 0
            ? inputs.criticalSignals30d / thresholds.insiderCriticalSignals30dMin
            : 1,
          thresholds.insiderAvgSignalScoreMin > 0
            ? (inputs.avgSignalScore30d ?? 0) / thresholds.insiderAvgSignalScoreMin
            : 1,
          thresholds.insiderMinResolvedBets > 0
            ? (inputs.computed.inferredResolvedCount ?? 0) /
                thresholds.insiderMinResolvedBets
            : 1,
          thresholds.insiderWinRateMin > 0
            ? (inputs.computed.inferredWinRate ?? 0) / thresholds.insiderWinRateMin
            : 1,
        ),
        0,
        1,
      );
      candidates.push({
        key: "insider",
        score: insiderScore * Math.max(0, inputs.policy.ruleWeights.insider),
        reasons: [
          "critical_signals>=insider_min",
          "avg_signal_score>=insider_min",
          "resolved_bets>=insider_min",
          "win_rate>=insider_min",
        ],
        venue: inputs.venue,
        venueVolume30d: venueVolume,
      });
    }
  }

  return candidates;
}

function choosePrimaryCandidate(
  candidates: CandidateScore[],
  policy: WalletIntelAttributionPolicy,
): CandidateScore | null {
  if (candidates.length === 0) return null;
  const tieBreak = normalizeTieBreakOrder(policy);
  const venueOrder = normalizeVenueOrder(policy);
  const sorted = [...candidates].sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (b.venueVolume30d !== a.venueVolume30d) {
      return b.venueVolume30d - a.venueVolume30d;
    }
    const tieA = tieBreak.indexOf(a.key);
    const tieB = tieBreak.indexOf(b.key);
    if (tieA !== tieB) return tieA - tieB;
    const venueA = a.venue ? venueOrder.indexOf(a.venue) : 999;
    const venueB = b.venue ? venueOrder.indexOf(b.venue) : 999;
    if (venueA !== venueB) return venueA - venueB;
    return a.key.localeCompare(b.key);
  });
  return sorted[0] ?? null;
}

function deriveSecondaryAndSupportingLabels(inputs: {
  policy: WalletIntelAttributionPolicy;
  wallet: WalletAttributionInput;
  computed: WalletComputedStats;
  venueStatsMap: Map<VenueKey, WalletVenueStats>;
  hasWhaleTag: boolean;
  signalSummary: WalletActivitySignalSummary;
}): { secondary: WalletAttributionLabelKey[]; supporting: WalletAttributionLabelKey[]; reasons: string[] } {
  const secondary = new Set<WalletAttributionLabelKey>();
  const supporting = new Set<WalletAttributionLabelKey>();
  const reasons = new Set<string>();
  const venues = Array.from(inputs.venueStatsMap.entries());

  for (const [venue, stats] of venues) {
    const thresholds = inputs.policy.venueThresholds[venue];
    if (
      inputs.policy.venueCapabilities[venue].specialistEnabled &&
      isPositiveThreshold(thresholds.specialistCategoryShareMin) &&
      stats.topCategoryFamily &&
      stats.topCategoryShare != null &&
      stats.topCategoryShare >= thresholds.specialistCategoryShareMin
    ) {
      secondary.add(SPECIALIST_LABEL_BY_FAMILY[stats.topCategoryFamily]);
      reasons.add(`specialist:${venue}:${stats.topCategoryFamily}`);
    }
    if (
      isPositiveThreshold(thresholds.highConvictionStakeUsd) &&
      stats.maxStakeUsd >= thresholds.highConvictionStakeUsd
    ) {
      secondary.add("high_conviction");
      reasons.add(`high_conviction:${venue}`);
    }
    if (
      isPositiveThreshold(thresholds.highFrequencyTrades30d) &&
      stats.trades30d >= thresholds.highFrequencyTrades30d
    ) {
      secondary.add("high_frequency");
      reasons.add(`high_frequency:${venue}`);
    }
    if (
      isPositiveThreshold(thresholds.volumeTraderVolume30dUsd) &&
      isPositiveThreshold(thresholds.highFrequencyTrades30d) &&
      stats.volume30dUsd >= thresholds.volumeTraderVolume30dUsd &&
      stats.trades30d >= Math.max(10, Math.floor(thresholds.highFrequencyTrades30d / 4))
    ) {
      secondary.add("volume_trader");
      reasons.add(`volume_trader:${venue}`);
    }
    if (
      isPositiveThreshold(thresholds.marketMoverStakeUsd) &&
      stats.maxStakeUsd >= thresholds.marketMoverStakeUsd
    ) {
      if (
        !isPositiveThreshold(thresholds.marketMoverStakeToMarketVolRatio) ||
        stats.maxStakeToMarketVolRatio == null ||
        stats.maxStakeToMarketVolRatio >= thresholds.marketMoverStakeToMarketVolRatio
      ) {
        secondary.add("market_mover");
        reasons.add(
          stats.maxStakeToMarketVolRatio == null
            ? `market_mover:${venue}:absolute_only`
            : `market_mover:${venue}:ratio`,
        );
      }
    }
  }

  const winRate = inputs.computed.inferredWinRate;
  const resolvedCount = inputs.computed.inferredResolvedCount;
  if (winRate != null && resolvedCount != null && resolvedCount >= 20 && winRate >= 0.75) {
    secondary.add("high_win_rate");
    reasons.add("high_win_rate");
  }

  if (
    winRate != null &&
    inputs.computed.trades30dTotal >= 30 &&
    winRate >= 0.6 &&
    (inputs.computed.pnl30dUsd ?? 0) >= 0
  ) {
    secondary.add("consistent_performer");
    reasons.add("consistent_performer");
  }

  const pnl = inputs.computed.pnl30dUsd ?? 0;
  if (pnl >= 10_000_000) secondary.add("10m_pnl");
  else if (pnl >= 1_000_000) secondary.add("1m_pnl");
  else if (pnl >= 100_000) secondary.add("100k_pnl");

  const minWhaleExposure = minPositiveThreshold(
    Object.values(inputs.policy.venueThresholds).map(
      (value) => value.whaleExposureUsd,
    ),
  );
  if (
    minWhaleExposure != null &&
    inputs.computed.exposureUsd >= minWhaleExposure
  ) {
    secondary.add("large_positions");
    reasons.add("large_positions");
  }

  const tagSlugs = new Set((inputs.wallet.tags ?? []).map((tag) => tag.slug));
  if (tagSlugs.has("fresh")) secondary.add("fresh_wallet");
  if (tagSlugs.has("dormant") && inputs.signalSummary.hasReactivatedAfterIdle) {
    secondary.add("dormant_wake_up");
  }
  if (tagSlugs.has("whale") || inputs.hasWhaleTag) {
    reasons.add("whale_tag");
  }

  if (inputs.signalSummary.hasLateEntry) supporting.add("late_entry");
  if (inputs.signalSummary.hasVeryLateEntry) {
    supporting.add("close_to_settlement");
  }
  if (inputs.signalSummary.hasUnusualBehavior) {
    supporting.add("unusual_behavior");
  }

  return {
    secondary: sortAttributionLabels(secondary),
    supporting: sortAttributionLabels(supporting),
    reasons: Array.from(reasons).sort((a, b) => a.localeCompare(b)),
  };
}

export async function buildWalletAttributionMap(
  client: PoolClient,
  wallets: WalletAttributionInput[],
  policy: WalletIntelAttributionPolicy,
  options?: WalletAttributionBuildOptions,
): Promise<Map<string, WalletAttribution>> {
  const byWallet = new Map<string, WalletAttribution>();
  if (wallets.length === 0) return byWallet;

  const mode = options?.mode ?? "full";
  const requestedPrimary = new Set(options?.filterPrimary ?? []);
  const requestedLabels = new Set(options?.filterLabels ?? []);
  const includeCategoryStats =
    mode === "full" ||
    requestedPrimary.has("specialist") ||
    Array.from(requestedLabels).some((label) =>
      SPECIALIST_LABEL_SET.has(label),
    );
  const includeRatioStats =
    mode === "full" || requestedLabels.has("market_mover");
  const walletIds = wallets.map((wallet) => wallet.walletId);
  const [venueStatsByWallet, computedStatsByWallet] = await Promise.all([
    loadVenueStats(client, walletIds, {
      includeCategoryStats,
      includeRatioStats,
    }),
    loadComputedStats(client, wallets),
  ]);

  const tieBreak = normalizeTieBreakOrder(policy);
  for (const wallet of wallets) {
    const venueStatsMap = venueStatsByWallet.get(wallet.walletId) ?? new Map<VenueKey, WalletVenueStats>();
    const computed =
      computedStatsByWallet.get(wallet.walletId) ??
      ({
        exposureUsd: 0,
        hedgedNotionalUsd: 0,
        netImbalanceUsd: 0,
        hedgeRatio: 0,
        twoSidedMarkets: 0,
        inferredWinRate: null,
        inferredResolvedCount: null,
        pnl30dUsd: null,
        trades30dTotal: 0,
        maxStakeUsdAnyVenue: 0,
        maxStakeToMarketVolRatioAnyVenue: null,
      } satisfies WalletComputedStats);
    const hasWhaleTag = (wallet.tags ?? []).some((tag) => tag.slug === "whale");
    const topChanges = wallet.topChanges ?? [];
    const signalSummary =
      wallet.signalSummary ?? deriveSignalSummaryFromTopChanges(topChanges);
    const criticalSignals30d = signalSummary.criticalSignals30d;
    const avgSignalScore30d = signalSummary.avgSignalScore30d;

    const candidateByKey = new Map<WalletAttributionPrimaryKey, CandidateScore>();
    for (const [venue, stats] of venueStatsMap.entries()) {
      computed.maxStakeUsdAnyVenue = Math.max(computed.maxStakeUsdAnyVenue, stats.maxStakeUsd);
      const ratio = stats.maxStakeToMarketVolRatio;
      if (ratio != null) {
        computed.maxStakeToMarketVolRatioAnyVenue =
          computed.maxStakeToMarketVolRatioAnyVenue == null
            ? ratio
            : Math.max(computed.maxStakeToMarketVolRatioAnyVenue, ratio);
      }
      const venueCandidates = scoreVenueCandidate({
        policy,
        venue,
        stats,
        computed,
        hasWhaleTag,
        criticalSignals30d,
        avgSignalScore30d,
      });
      for (const candidate of venueCandidates) {
        const existing = candidateByKey.get(candidate.key);
        if (!existing || candidate.score > existing.score) {
          candidateByKey.set(candidate.key, candidate);
          continue;
        }
        if (candidate.score === existing.score) {
          if (candidate.venueVolume30d > existing.venueVolume30d) {
            candidateByKey.set(candidate.key, candidate);
            continue;
          }
          const tieA = tieBreak.indexOf(candidate.key);
          const tieB = tieBreak.indexOf(existing.key);
          if (tieA < tieB) {
            candidateByKey.set(candidate.key, candidate);
          }
        }
      }
    }

    if (hasWhaleTag && !candidateByKey.has("whale")) {
      candidateByKey.set("whale", {
        key: "whale",
        score: Math.max(0, policy.ruleWeights.whale),
        reasons: ["whale_tag=true"],
        venue: null,
        venueVolume30d: 0,
      });
    }

    const candidates = Array.from(candidateByKey.values());
    const primaryCandidate = choosePrimaryCandidate(candidates, policy);
    const sortedCandidates = [...candidates]
      .sort((a, b) => b.score - a.score || a.key.localeCompare(b.key))
      .map((candidate) => ({
        key: candidate.key,
        score: Number(candidate.score.toFixed(6)),
      }));

    const labelResult = deriveSecondaryAndSupportingLabels({
      policy,
      wallet,
      computed,
      venueStatsMap,
      hasWhaleTag,
      signalSummary,
    });
    const reasons = new Set<string>(labelResult.reasons);
    if (primaryCandidate) {
      for (const reason of primaryCandidate.reasons) reasons.add(reason);
    }
    const detailsSecondary = labelResult.secondary.slice(
      0,
      policy.display.detailsSecondaryMax,
    );
    const detailsSupporting = labelResult.supporting.slice(
      0,
      policy.display.detailsSupportingMax,
    );
    const listSecondary = detailsSecondary.slice(
      0,
      policy.display.listSecondaryCount,
    );
    const listPrimary =
      primaryCandidate?.key && policy.display.listPrimaryCount > 0
        ? [primaryCandidate.key]
        : [];

    byWallet.set(wallet.walletId, {
      primary: primaryCandidate?.key ?? null,
      primaryCandidates: sortedCandidates,
      secondary: labelResult.secondary,
      supporting: labelResult.supporting,
      display: {
        listPrimary,
        listSecondary,
        detailsSecondary,
        detailsSupporting,
      },
      reasons: Array.from(reasons).sort((a, b) => a.localeCompare(b)),
      version: "v1",
    });
  }

  return byWallet;
}

export function buildSignalPresentation(input: {
  signalLabels?: string[] | null;
  labels?: string[] | null;
  signalScore?: number | null;
  venue?: string | null;
  policy: WalletIntelAttributionPolicy;
}): {
  reasonCodes: string[];
  displayReasons: string[];
  severity: WalletSignalSeverity;
} {
  const reasonCodes = Array.from(
    sortReasonCodes([
      ...(input.signalLabels ?? []).filter(Boolean),
      ...(input.labels ?? []).filter(Boolean),
    ]),
  );
  const venue = parseVenue(input.venue ?? null);
  return {
    reasonCodes,
    displayReasons: buildDisplayReasons(reasonCodes, input.policy),
    severity: resolveSignalSeverity(venue, input.signalScore, input.policy),
  };
}

export function walletMatchesFilters(
  walletTags: WalletAttributionTag[] | null | undefined,
  attribution: WalletAttribution | null | undefined,
  filters: {
    tags?: string[] | null;
    tagMode?: "any" | "all";
    primary?: string[] | null;
    labels?: string[] | null;
    labelMode?: "any" | "all";
  },
): boolean {
  const tagsFilter = (filters.tags ?? []).map((value) => value.trim()).filter(Boolean);
  if (tagsFilter.length > 0) {
    const walletTagSet = new Set((walletTags ?? []).map((tag) => tag.slug));
    const mode = filters.tagMode ?? "any";
    const matched =
      mode === "all"
        ? tagsFilter.every((tag) => walletTagSet.has(tag))
        : tagsFilter.some((tag) => walletTagSet.has(tag));
    if (!matched) return false;
  }

  const primaryFilter = (filters.primary ?? [])
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
  if (primaryFilter.length > 0) {
    const primary = attribution?.primary ?? null;
    if (!primary || !primaryFilter.includes(primary)) return false;
  }

  const labelsFilter = (filters.labels ?? [])
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
  if (labelsFilter.length > 0) {
    const labels = new Set([
      ...(attribution?.secondary ?? []),
      ...(attribution?.supporting ?? []),
    ]);
    const mode = filters.labelMode ?? "any";
    const matched =
      mode === "all"
        ? labelsFilter.every((label) => labels.has(label as WalletAttributionLabelKey))
        : labelsFilter.some((label) => labels.has(label as WalletAttributionLabelKey));
    if (!matched) return false;
  }

  return true;
}

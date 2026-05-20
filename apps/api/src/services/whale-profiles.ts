import crypto from "node:crypto";

import type { PoolClient } from "pg";
import { z } from "zod";

import { pool } from "../db.js";
import { env } from "../env.js";
import {
  normalizeOutcomeSideForApi,
  outcomeLabelOrSide,
  parseMarketOutcomes,
} from "./wallet-intel-helpers.js";
import type { AiWhaleProfilesPolicy } from "./runtime-policies.js";
import {
  compareWalletActivitySummaryStats,
  fetchWalletActivitySignalRowsFast,
  fetchWalletActivitySignalSummary,
  fetchWalletActivitySummaryStats,
  fetchWalletActivitySummaries,
  type WalletActivitySignalRow,
  type WalletActivitySignalSummary,
  type WalletActivitySummary,
  type WalletActivitySummaryStats,
} from "./wallet-activity-summary.js";
import {
  loadWalletCategoryMix,
  loadWalletEntryBracketStats,
  loadWalletPerformance30dSummary,
  loadWalletResolvedPositionSamples,
  type WalletCategoryMixItem,
  type WalletEntryBracketKey,
  type WalletEntryBracketStat,
  type WalletPerformance30dSummary,
  type WalletResolvedPositionSample,
} from "./wallet-profile-features.js";
import {
  aggregateWalletMetricsFilterSql,
  aggregateWalletMetricsPreferenceSql,
} from "./wallet-metrics-constants.js";

const PROFILE_VERSION = "v12";
const CATEGORY_VALUES = [
  "politics",
  "crypto",
  "sports",
  "economics",
  "technology",
  "entertainment",
  "weather",
  "health",
  "mentions",
  "other",
] as const;

type WhaleCategory = (typeof CATEGORY_VALUES)[number];
const categorySchema = z.enum(CATEGORY_VALUES);
const whaleProfileOutputSchema = z
  .object({
    label_short: z.string().trim().min(1).max(256),
    label_long: z.string().trim().min(1).max(2_000),
    archetype: z
      .string()
      .trim()
      .min(1)
      .max(256)
      .regex(/^[a-z0-9_ -]+$/i),
    categories: z.array(z.string().trim().min(1).max(96)).max(12).optional(),
    theme_focus: z.array(z.string().trim().min(1).max(96)).max(12).optional(),
    risk_style: z.string().trim().min(1).max(256),
    confidence: z.coerce.number().min(0).max(1),
    evidence: z.array(z.string().trim().min(1).max(512)).min(1).max(12),
    notes: z.string().trim().min(1).max(4_000).optional(),
  })
  .passthrough();

type WhaleProfile = {
  label_short?: string;
  label_long?: string;
  archetype?: string;
  categories?: string[];
  theme_focus?: string[];
  risk_style?: string;
  confidence?: number;
  evidence?: string[];
  notes?: string;
  _naming_signature?: string;
};

type ExistingWhaleProfileState = {
  featuresHash: string;
  version: string;
  profile: WhaleProfile | null;
  namingSignature: string | null;
};

type WhaleProfileInput = {
  context: {
    purpose: "wallet_whale_profile";
    ui: string;
    top_markets_limit: number;
    window_days: number;
    currency: "USD";
    display_notes: string;
    style_guide: string;
  };
  wallet: {
    chain: string;
    source_label: string | null;
    source_label_quality: "descriptive" | "generic" | "missing";
    owner_label: string | null;
    kind: "eoa" | "safe" | "contract" | "unknown";
    role: "trading_wallet" | "signer_wallet" | "unknown";
    owner_role: "signer_wallet" | "unknown";
  };
  metrics: {
    volume_30d: number | null;
    pnl_30d: number | null;
    trades_30d: number | null;
    avg_trade_usd: number | null;
    roi: number | null;
    pnl_to_volume_ratio: number | null;
    win_rate: number | null;
    last_trade_at: string | null;
  };
  performance_context: {
    start_marked_pnl_30d: number | null;
    current_marked_pnl: number | null;
    portfolio_change_30d: number | null;
    min_portfolio_change_30d: number | null;
    max_portfolio_change_30d: number | null;
    trade_pnl_30d: number | null;
    trade_roi_30d: number | null;
    pnl_to_volume_ratio: number | null;
  };
  positioning_context: {
    avg_open_position_usd: number | null;
    largest_position_usd: number | null;
    weighted_avg_held_odds: number | null;
    high_probability_exposure_share: number | null;
    low_probability_exposure_share: number | null;
  };
  inferred: {
    win_rate: number | null;
    resolved_count: number | null;
  };
  exposure: {
    gross_usd: number | null;
    net_imbalance_usd: number | null;
    hedged_notional_usd: number | null;
    hedge_ratio: number | null;
    two_sided_markets: number;
    posture: "directional" | "partially_hedged" | "heavily_hedged" | "unknown";
  };
  current_portfolio: {
    snapshot_at: string | null;
    market_count_total: number;
    event_count_total: number;
    gross_usd_total: number;
    yes_gross_usd: number;
    no_gross_usd: number;
    largest_position_share: number | null;
    top_markets_gross_usd: number;
    omitted_market_count: number;
    omitted_gross_usd: number;
  };
  activity: {
    last_activity_at: string | null;
    kind: "trade" | "holder" | "mixed" | "unknown";
  };
  summary: {
    top_market_concentration: number | null;
    concentration_label: "high" | "medium" | "low" | "unknown";
    side_bias: { yes: number; no: number; ratio: number | null };
    side_bias_label: "mostly_yes" | "mostly_no" | "mixed" | "unknown";
    category_counts: Record<string, number>;
    market_state_counts: { active: number; ended: number; resolved: number };
  };
  category_mix: WalletCategoryMixItem[];
  entry_brackets: WalletEntryBracketStat[];
  performance_30d: WalletPerformance30dSummary;
  signals: {
    summary: WalletActivitySignalSummary | null;
    examples: Array<{
      market_title: string | null;
      outcomes: string[] | null;
      event_title: string | null;
      venue: string;
      category: string | null;
      market_status: string | null;
      resolved_outcome: string | null;
      action: string | null;
      position_side: string | null;
      position_label: string | null;
      delta_usd: number | null;
      stake_usd: number | null;
      odds: number | null;
      signal_score: number | null;
      signal_type: string | null;
      late_bucket: string | null;
      reason_codes: string[];
      occurred_at: string | null;
    }>;
  };
  top_events: Array<{
    event_title: string;
    gross_usd: number | null;
    market_count: number;
  }>;
  recent_window: {
    window_hours: number;
    last_activity_at: string | null;
    net_change_usd: number;
    net_change_yes_usd: number;
    net_change_no_usd: number;
    counts: {
      new: number;
      increase: number;
      reduce: number;
      exit: number;
      flip: number;
    };
    unusual_score: number | null;
    top_changes: Array<{
      market_title: string | null;
      outcomes: string[] | null;
      event_title: string | null;
      venue: string;
      category: string | null;
      market_status: string | null;
      resolved_outcome: string | null;
      action: string | null;
      position_side: string | null;
      position_label: string | null;
      delta_usd: number | null;
      odds: number | null;
      labels: string[];
      occurred_at: string | null;
    }>;
  };
  closed_positions_sample: WalletResolvedPositionSample[];
  top_markets: Array<{
    market_id: string;
    market_title: string | null;
    outcomes: string[] | null;
    event_id: string | null;
    event_title: string | null;
    venue: string;
    category: string | null;
    status: string | null;
    close_time: string | null;
    expiration_time: string | null;
    resolved_outcome: string | null;
    is_active: boolean;
    snapshot_at: string | null;
    recent_activity: {
      last_activity_at: string | null;
      volume_usd: number | null;
      activity_count: number;
      avg_price: number | null;
    };
    best_bid: number | null;
    best_ask: number | null;
    last_yes_price: number | null;
    held_odds: number | null;
    position_side: string | null;
    position_label: string | null;
    yes_label: string | null;
    no_label: string | null;
    is_two_sided: boolean;
    position_shares: number | null;
    position_value_usd: number | null;
    position_price: number | null;
    yes_position_shares: number | null;
    yes_position_value_usd: number | null;
    yes_position_price: number | null;
    no_position_shares: number | null;
    no_position_value_usd: number | null;
    no_position_price: number | null;
  }>;
};

type WhaleRow = {
  id: string;
  address: string;
  chain: string;
  label: string | null;
  is_safe: boolean;
  owner_address: string | null;
  owner_label: string | null;
  metrics_volume: string | null;
  metrics_pnl: string | null;
  metrics_trades: number | null;
  metrics_roi: string | null;
  metrics_win_rate: string | null;
  metrics_last_trade_at: Date | null;
  exposure_usd: string | null;
  hedged_notional_usd: string | null;
  net_imbalance_usd: string | null;
  hedge_ratio: string | null;
  two_sided_markets: number | null;
  whale_score: string | null;
  signal_abs_usd: string | null;
  last_activity_at: Date | null;
  has_trade_activity: boolean | null;
  has_holder_activity: boolean | null;
  inferred_wins: number | null;
  inferred_total: number | null;
  rank_tracker_recent: number | string | null;
  rank_tracker_pnl: number | string | null;
  rank_tracker_win_rate: number | string | null;
  rank_recent: number | string | null;
  rank_pnl: number | string | null;
  rank_signal: number | string | null;
  source_hits: number;
};

type WhaleSelectableRow = {
  id: string;
  last_activity_at: Date | null;
  rank_tracker_recent: number | string | null;
  rank_tracker_pnl: number | string | null;
  rank_tracker_win_rate: number | string | null;
  rank_recent: number | string | null;
  rank_pnl: number | string | null;
  rank_signal: number | string | null;
  source_hits: number;
};

type WhaleSelectionRow = WhaleSelectableRow;

type WhaleProfileSourceKey =
  | "trackerRecent"
  | "trackerPnl"
  | "trackerWinRate"
  | "recent"
  | "pnl"
  | "signals";

type WhaleProfileSourceDef = {
  key: WhaleProfileSourceKey;
  targetLimit: number;
  fetchLimit: number;
  rankOf: (row: WhaleSelectableRow) => number | null;
};

type WhaleMarketRow = {
  wallet_id: string;
  market_id: string;
  event_id: string | null;
  market_title: string | null;
  outcomes: string | null;
  event_title: string | null;
  venue: string;
  category: string | null;
  status: string | null;
  close_time: Date | null;
  expiration_time: Date | null;
  resolved_outcome: string | null;
  snapshot_at: Date | null;
  recent_volume_usd: string | null;
  recent_activity_count: number;
  recent_last_activity_at: Date | null;
  recent_avg_price: string | null;
  best_bid: string | null;
  best_ask: string | null;
  last_price: string | null;
  position_side: string | null;
  has_yes_position: boolean;
  has_no_position: boolean;
  position_shares: string | null;
  position_value_usd: string | null;
  position_price: string | null;
  yes_position_shares: string | null;
  yes_position_value_usd: string | null;
  yes_position_price: string | null;
  no_position_shares: string | null;
  no_position_value_usd: string | null;
  no_position_price: string | null;
};

type WhaleProfileOptions = {
  limit: number;
  marketLimit: number;
  windowDays: number;
  policy?: AiWhaleProfilesPolicy;
  force?: boolean;
  dryRun?: boolean;
  verbose?: boolean;
  logEvery?: number;
};

const clampNumber = (value: number, min: number, max: number) =>
  Math.min(Math.max(value, min), max);

const parseNumber = (
  value: string | number | null | undefined,
): number | null => {
  if (value == null) return null;
  const num = typeof value === "string" ? Number(value) : value;
  return Number.isFinite(num) ? num : null;
};

function normalizeText(value: string | null | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function formatShortAddressLike(address: string): string {
  return address.length > 14
    ? `${address.slice(0, 6)}...${address.slice(-4)}`
    : address;
}

const GENERIC_WALLET_LABEL_PATTERNS = [
  /^wallet(?: \d+)?$/i,
  /^(unknown|unnamed) wallet$/i,
  /^(evm|sol)(?: wallet)? [a-z0-9].*$/i,
  /^safe(?: wallet)?$/i,
  /^contract(?: wallet)?$/i,
  /^wallet(?: \d+)?(?: \(auto\))?$/i,
  /^trading wallet(?: \(auto\))?$/i,
  /^signer wallet$/i,
  /^directional trader$/i,
  /^active trader$/i,
  /^mixed trader$/i,
  /^hedged trader$/i,
  /^whale trader$/i,
  /^event trader$/i,
  /^portfolio$/i,
];

const BANNED_LABEL_SHORT_PATTERNS = [
  /\s*\([^)]*\)\s*/g,
  /\b(?:safe|gnosis|multisig)\b/gi,
];

function isGenericWalletLabel(
  label: string | null | undefined,
  address: string | null | undefined,
): boolean {
  const normalizedLabel = normalizeText(label)?.toLowerCase();
  if (!normalizedLabel) return true;
  const normalizedAddress = normalizeText(address)?.toLowerCase() ?? null;
  const shortAddress = normalizedAddress
    ? formatShortAddressLike(normalizedAddress).toLowerCase()
    : null;
  const shortAddressEllipsis = shortAddress?.replace("...", "…") ?? null;
  if (
    normalizedAddress &&
    (normalizedLabel === normalizedAddress ||
      normalizedLabel === shortAddress ||
      normalizedLabel === shortAddressEllipsis)
  ) {
    return true;
  }
  return GENERIC_WALLET_LABEL_PATTERNS.some((pattern) =>
    pattern.test(normalizedLabel),
  );
}

function resolveWalletLabelQuality(
  label: string | null | undefined,
  address: string | null | undefined,
): WhaleProfileInput["wallet"]["source_label_quality"] {
  const normalized = normalizeText(label);
  if (!normalized) return "missing";
  return isGenericWalletLabel(normalized, address) ? "generic" : "descriptive";
}

function sanitizeProfileLabelShort(
  label: string | null | undefined,
): string | null {
  const normalized = normalizeText(label);
  if (!normalized) return null;
  const stripped = BANNED_LABEL_SHORT_PATTERNS.reduce(
    (value, pattern) => value.replace(pattern, " "),
    normalized,
  )
    .replace(/\s+/g, " ")
    .trim();
  return stripped.length > 0 ? stripped : null;
}

function titleCaseToken(token: string): string {
  if (!token) return token;
  if (/^[a-z]{1,3}$/i.test(token)) return token.toUpperCase();
  return token.charAt(0).toUpperCase() + token.slice(1).toLowerCase();
}

const LABEL_STOP_WORDS = new Set([
  "wallet",
  "trader",
  "trading",
  "portfolio",
  "event",
  "events",
  "market",
  "markets",
  "directional",
  "mixed",
  "hedged",
  "active",
  "auto",
  "yes",
  "no",
  "high",
  "odds",
  "probability",
  "sweep",
  "sweeper",
  "accumulator",
  "the",
  "a",
  "an",
  "of",
  "in",
  "on",
  "to",
  "for",
  "by",
  "before",
  "after",
  "when",
  "will",
  "is",
  "be",
  "become",
]);

function formatFocusCandidate(raw: string | null | undefined): string | null {
  const normalized = normalizeText(raw);
  if (!normalized) return null;
  const cleaned = normalized
    .replace(/[?()[\],:/]+/g, " ")
    .replace(/[_-]+/g, " ")
    .split(/\s+/)
    .map((token) => token.trim())
    .filter(Boolean)
    .filter((token) => !LABEL_STOP_WORDS.has(token.toLowerCase()));
  if (cleaned.length === 0) return null;
  return cleaned.slice(0, 2).map(titleCaseToken).join(" ");
}

function isGenericProfileLabelShort(
  label: string | null | undefined,
  input: WhaleProfileInput,
): boolean {
  const normalized = sanitizeProfileLabelShort(label);
  if (!normalized) return true;
  if (isGenericWalletLabel(normalized, null)) return true;
  if (
    input.wallet.source_label_quality === "generic" &&
    input.wallet.source_label &&
    normalized.toLowerCase() === input.wallet.source_label.toLowerCase()
  ) {
    return true;
  }
  return false;
}

function resolveFallbackProfileLabelShort(input: WhaleProfileInput): string {
  const focusCandidates = [
    ...input.signals.examples.flatMap((example) => [
      example.event_title,
      example.market_title,
    ]),
    ...input.top_events.map((event) => event.event_title),
    ...(input.category_mix.length > 0
      ? input.category_mix.map((item) => item.category)
      : Object.keys(input.summary.category_counts)),
  ];
  const focus =
    focusCandidates
      .map((candidate) => formatFocusCandidate(candidate))
      .find(Boolean) ?? "Event";
  const stance =
    input.exposure.posture === "partially_hedged" ||
    input.exposure.posture === "heavily_hedged"
      ? "Hedged"
      : input.summary.side_bias_label === "mostly_no"
        ? "NO"
        : input.summary.side_bias_label === "mostly_yes"
          ? "YES"
          : "Mixed";
  const noun =
    input.current_portfolio.market_count_total >= 20 ? "Portfolio" : "Trader";
  return truncateText(
    `${focus} ${stance} ${noun}`.replace(/\s+/g, " ").trim(),
    56,
  );
}

function deriveProfileNamingCategories(input: WhaleProfileInput): string[] {
  const fromMix = input.category_mix
    .map((item) => normalizeText(item.category)?.toLowerCase())
    .filter((value): value is string => Boolean(value))
    .slice(0, 2);
  if (fromMix.length > 0) {
    return Array.from(new Set(fromMix)).sort();
  }
  return Object.entries(input.summary.category_counts)
    .filter(([, count]) => Number.isFinite(count) && count > 0)
    .sort((left, right) => {
      if (right[1] !== left[1]) return right[1] - left[1];
      return left[0].localeCompare(right[0]);
    })
    .slice(0, 2)
    .map(([category]) => category.toLowerCase())
    .sort();
}

function resolvePrimaryEntryBracket(
  input: WhaleProfileInput,
): WalletEntryBracketKey | "none" {
  const bracket = [...input.entry_brackets]
    .sort((left, right) => {
      if (right.totalStakeUsd !== left.totalStakeUsd) {
        return right.totalStakeUsd - left.totalStakeUsd;
      }
      if (right.tradeCount !== left.tradeCount) {
        return right.tradeCount - left.tradeCount;
      }
      return left.bracket.localeCompare(right.bracket);
    })
    .find((entry) => entry.totalStakeUsd > 0 || entry.tradeCount > 0);
  return bracket?.bracket ?? "none";
}

function computeProfileNamingSignature(input: WhaleProfileInput): string {
  return [
    input.activity.kind,
    input.exposure.posture,
    input.summary.side_bias_label,
    resolvePrimaryEntryBracket(input),
    deriveProfileNamingCategories(input).join("+") || "none",
  ].join("|");
}

function parseStoredWhaleProfileState(row: {
  features_hash: string;
  version: string;
  profile: unknown;
}): ExistingWhaleProfileState {
  const profile = normalizeWhaleProfile(row.profile);
  const namingSignature =
    isRecord(row.profile) && typeof row.profile._naming_signature === "string"
      ? normalizeText(row.profile._naming_signature)
      : null;
  return {
    featuresHash: row.features_hash,
    version: row.version,
    profile,
    namingSignature,
  };
}

function shouldPreserveExistingProfileLabelShort(
  existing: ExistingWhaleProfileState | undefined,
  input: WhaleProfileInput,
  currentNamingSignature: string,
): boolean {
  const existingLabel = normalizeText(existing?.profile?.label_short);
  if (!existingLabel) return false;
  if (input.wallet.source_label_quality === "descriptive") return false;
  if (isGenericProfileLabelShort(existingLabel, input)) return false;
  if (!existing?.namingSignature) return true;
  return existing.namingSignature === currentNamingSignature;
}

const USD_BUCKETS = [
  100, 1_000, 10_000, 100_000, 1_000_000, 10_000_000, 100_000_000,
  1_000_000_000,
] as const;

const COUNT_BUCKETS = [
  1, 2, 5, 10, 25, 50, 100, 250, 500, 1_000, 2_500, 5_000,
] as const;

const UNUSUAL_BUCKETS = [1, 2, 5, 10, 20, 50] as const;

function bucketRate(
  value: number | null | undefined,
  step = 0.05,
): number | null {
  if (value == null || !Number.isFinite(value)) return null;
  return clampNumber(Math.round(value / step) * step, 0, 1);
}

function bucketSignedDecimal(
  value: number | null | undefined,
  step = 0.05,
  maxAbs = 5,
): number | null {
  if (value == null || !Number.isFinite(value)) return null;
  const rounded = Math.round(value / step) * step;
  return clampNumber(rounded, -maxAbs, maxAbs);
}

function normalizeBulletNotes(
  value: string | null | undefined,
): string | undefined {
  const normalized = normalizeText(value);
  if (!normalized) return undefined;
  const lines = normalized
    .replace(/\r/g, "\n")
    .split(/\n+/)
    .map((line) =>
      line
        .trim()
        .replace(/^[•*-]\s*/, "")
        .replace(/^\d+[.)]\s*/, "")
        .trim(),
    )
    .filter(Boolean);
  if (lines.length === 0) return undefined;
  return lines
    .slice(0, 5)
    .map((line) => `- ${line}`)
    .join("\n");
}

function truncateText(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  return value.slice(0, Math.max(0, maxLength - 1)).trimEnd() + "…";
}

function bucketSignedUsd(value: number | null | undefined): number | null {
  if (value == null || !Number.isFinite(value)) return null;
  const sign = value < 0 ? -1 : 1;
  const abs = Math.abs(value);
  let bucket = 0;
  for (const threshold of USD_BUCKETS) {
    if (abs >= threshold) bucket = threshold;
    else break;
  }
  return sign * bucket;
}

function bucketCount(value: number | null | undefined): number {
  if (value == null || !Number.isFinite(value) || value <= 0) return 0;
  let bucket = 0;
  for (const threshold of COUNT_BUCKETS) {
    if (value >= threshold) bucket = threshold;
    else break;
  }
  return bucket;
}

function bucketUnusual(value: number | null | undefined): number | null {
  if (value == null || !Number.isFinite(value) || value <= 0) return null;
  let bucket: number = UNUSUAL_BUCKETS[0];
  for (const threshold of UNUSUAL_BUCKETS) {
    if (value >= threshold) bucket = threshold;
    else break;
  }
  return bucket;
}

function truncateIsoToHour(value: string | null | undefined): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return null;
  date.setMinutes(0, 0, 0);
  return date.toISOString();
}

function resolveExposurePosture(inputs: {
  exposureUsd: number | null;
  hedgedNotionalUsd: number | null;
  hedgeRatio: number | null;
  twoSidedMarkets: number | null;
}): WhaleProfileInput["exposure"]["posture"] {
  const exposureUsd = Math.max(0, inputs.exposureUsd ?? 0);
  const hedgedNotionalUsd = Math.max(0, inputs.hedgedNotionalUsd ?? 0);
  const hedgeRatio = Math.max(0, Math.min(1, inputs.hedgeRatio ?? 0));
  const twoSidedMarkets = Math.max(0, Math.trunc(inputs.twoSidedMarkets ?? 0));
  if (exposureUsd <= 0) return "unknown";
  if (hedgeRatio >= 0.6 || (hedgedNotionalUsd > 0 && twoSidedMarkets >= 3)) {
    return "heavily_hedged";
  }
  if (hedgeRatio >= 0.15 || hedgedNotionalUsd > 0 || twoSidedMarkets > 0) {
    return "partially_hedged";
  }
  return "directional";
}

function resolveMarketGrossUsd(
  market: WhaleProfileInput["top_markets"][number],
): number {
  const splitGross =
    (market.yes_position_value_usd ?? 0) + (market.no_position_value_usd ?? 0);
  if (splitGross > 0) return splitGross;
  return Math.max(0, market.position_value_usd ?? 0);
}

function resolveMarketStateCounts(
  markets: WhaleProfileInput["top_markets"],
): WhaleProfileInput["summary"]["market_state_counts"] {
  return markets.reduce(
    (acc, market) => {
      if (market.resolved_outcome) {
        acc.resolved += 1;
        return acc;
      }
      const status = market.status?.toUpperCase();
      if (status && status !== "ACTIVE") {
        acc.ended += 1;
        return acc;
      }
      const closeAt = market.close_time ?? market.expiration_time;
      if (closeAt && new Date(closeAt).getTime() < Date.now()) {
        acc.ended += 1;
        return acc;
      }
      acc.active += 1;
      return acc;
    },
    { active: 0, ended: 0, resolved: 0 },
  );
}

export function summarizeProfileMarkets(
  markets: WhaleProfileInput["top_markets"],
  marketLimit: number,
): {
  topMarkets: WhaleProfileInput["top_markets"];
  currentPortfolio: WhaleProfileInput["current_portfolio"];
  topEvents: WhaleProfileInput["top_events"];
  summary: WhaleProfileInput["summary"];
} {
  const sortedMarkets = [...markets].sort((a, b) => {
    const valueDiff = resolveMarketGrossUsd(b) - resolveMarketGrossUsd(a);
    if (Math.abs(valueDiff) > 1e-9) return valueDiff;
    const shareDiff = (b.position_shares ?? 0) - (a.position_shares ?? 0);
    if (Math.abs(shareDiff) > 1e-9) return shareDiff;
    const aTitle = `${a.event_title ?? ""} ${a.market_title ?? ""}`;
    const bTitle = `${b.event_title ?? ""} ${b.market_title ?? ""}`;
    return aTitle.localeCompare(bTitle);
  });
  const topMarkets = sortedMarkets.slice(0, Math.max(1, marketLimit));
  const grossUsdTotal = sortedMarkets.reduce(
    (sum, market) => sum + resolveMarketGrossUsd(market),
    0,
  );
  const yesGrossUsd = sortedMarkets.reduce(
    (sum, market) => sum + (market.yes_position_value_usd ?? 0),
    0,
  );
  const noGrossUsd = sortedMarkets.reduce(
    (sum, market) => sum + (market.no_position_value_usd ?? 0),
    0,
  );
  const largestGrossUsd = topMarkets[0]
    ? resolveMarketGrossUsd(topMarkets[0])
    : 0;
  const topMarketsGrossUsd = topMarkets.reduce(
    (sum, market) => sum + resolveMarketGrossUsd(market),
    0,
  );
  const omittedMarketCount = Math.max(
    0,
    sortedMarkets.length - topMarkets.length,
  );
  const omittedGrossUsd = Math.max(0, grossUsdTotal - topMarketsGrossUsd);

  const eventKeys = new Set<string>();
  const eventRollup = new Map<
    string,
    { title: string; grossUsd: number; count: number }
  >();
  const categoryCounts = sortedMarkets.reduce<Record<string, number>>(
    (acc, market) => {
      const category = market.category?.trim();
      if (category) acc[category] = (acc[category] ?? 0) + 1;
      return acc;
    },
    {},
  );
  const snapshotAt = sortedMarkets.reduce<string | null>((latest, market) => {
    if (!market.snapshot_at) return latest;
    if (!latest) return market.snapshot_at;
    return market.snapshot_at > latest ? market.snapshot_at : latest;
  }, null);

  for (const market of sortedMarkets) {
    const rawTitle = market.event_title?.trim() || market.market_title?.trim();
    const eventKey = market.event_id?.trim() || rawTitle;
    if (eventKey) eventKeys.add(eventKey);
    if (!rawTitle) continue;
    const grossUsd = resolveMarketGrossUsd(market);
    const entry = eventRollup.get(rawTitle) ?? {
      title: rawTitle,
      grossUsd: 0,
      count: 0,
    };
    entry.grossUsd += grossUsd;
    entry.count += 1;
    eventRollup.set(rawTitle, entry);
  }

  const { yesValue, noValue, sideRatio, sideBiasLabel } =
    computeProfileSideBias(sortedMarkets);
  const concentration =
    grossUsdTotal > 0
      ? clampNumber(largestGrossUsd / grossUsdTotal, 0, 1)
      : null;
  const concentrationLabel: WhaleProfileInput["summary"]["concentration_label"] =
    concentration == null
      ? "unknown"
      : concentration >= 0.6
        ? "high"
        : concentration >= 0.3
          ? "medium"
          : "low";

  return {
    topMarkets,
    currentPortfolio: {
      snapshot_at: snapshotAt,
      market_count_total: sortedMarkets.length,
      event_count_total: eventKeys.size,
      gross_usd_total: grossUsdTotal,
      yes_gross_usd: yesGrossUsd,
      no_gross_usd: noGrossUsd,
      largest_position_share: concentration,
      top_markets_gross_usd: topMarketsGrossUsd,
      omitted_market_count: omittedMarketCount,
      omitted_gross_usd: omittedGrossUsd,
    },
    topEvents: Array.from(eventRollup.values())
      .sort((a, b) => b.grossUsd - a.grossUsd)
      .slice(0, 3)
      .map((entry) => ({
        event_title: entry.title,
        gross_usd: entry.grossUsd || null,
        market_count: entry.count,
      })),
    summary: {
      top_market_concentration: concentration,
      concentration_label: concentrationLabel,
      side_bias: {
        yes: yesValue,
        no: noValue,
        ratio: sideRatio,
      },
      side_bias_label: sideBiasLabel,
      category_counts: categoryCounts,
      market_state_counts: resolveMarketStateCounts(sortedMarkets),
    },
  };
}

function buildPositioningContext(input: {
  grossExposureUsd: number | null;
  markets: WhaleProfileInput["top_markets"];
}): WhaleProfileInput["positioning_context"] {
  const marketCount = input.markets.length;
  const grossExposureUsd = Math.max(0, input.grossExposureUsd ?? 0);
  let largestPositionUsd = 0;
  let heldOddsWeightUsd = 0;
  let weightedHeldOddsTotal = 0;
  let highProbabilityUsd = 0;
  let lowProbabilityUsd = 0;

  for (const market of input.markets) {
    const grossUsd = resolveMarketGrossUsd(market);
    if (grossUsd <= 0) continue;
    largestPositionUsd = Math.max(largestPositionUsd, grossUsd);

    const heldOdds = market.held_odds;
    if (heldOdds == null || !Number.isFinite(heldOdds)) continue;
    heldOddsWeightUsd += grossUsd;
    weightedHeldOddsTotal += heldOdds * grossUsd;
    if (heldOdds >= 0.8) highProbabilityUsd += grossUsd;
    if (heldOdds <= 0.2) lowProbabilityUsd += grossUsd;
  }

  return {
    avg_open_position_usd:
      grossExposureUsd > 0 && marketCount > 0
        ? grossExposureUsd / marketCount
        : null,
    largest_position_usd: largestPositionUsd > 0 ? largestPositionUsd : null,
    weighted_avg_held_odds:
      heldOddsWeightUsd > 0 ? weightedHeldOddsTotal / heldOddsWeightUsd : null,
    high_probability_exposure_share:
      heldOddsWeightUsd > 0 ? highProbabilityUsd / heldOddsWeightUsd : null,
    low_probability_exposure_share:
      heldOddsWeightUsd > 0 ? lowProbabilityUsd / heldOddsWeightUsd : null,
  };
}

function buildProfileHashInput(input: WhaleProfileInput): WhaleProfileInput {
  const recent = input.recent_window;
  const recentHash: WhaleProfileInput["recent_window"] = {
    window_hours: recent.window_hours,
    last_activity_at: truncateIsoToHour(recent.last_activity_at),
    net_change_usd: bucketSignedUsd(recent.net_change_usd) ?? 0,
    net_change_yes_usd: bucketSignedUsd(recent.net_change_yes_usd) ?? 0,
    net_change_no_usd: bucketSignedUsd(recent.net_change_no_usd) ?? 0,
    counts: {
      new: bucketCount(recent.counts.new),
      increase: bucketCount(recent.counts.increase),
      reduce: bucketCount(recent.counts.reduce),
      exit: bucketCount(recent.counts.exit),
      flip: bucketCount(recent.counts.flip),
    },
    unusual_score: bucketUnusual(recent.unusual_score),
    // Avoid churn from rapidly changing market-level details.
    top_changes: [
      {
        market_title: null,
        outcomes: null,
        event_title: null,
        venue: "summary",
        category: null,
        market_status: null,
        resolved_outcome: null,
        action: null,
        position_side: null,
        position_label: null,
        delta_usd: bucketCount(recent.top_changes.length),
        odds: null,
        labels: [],
        occurred_at: null,
      },
    ],
  };
  const performanceHash: WhaleProfileInput["performance_30d"] = {
    ...input.performance_30d,
    startAsOf: truncateIsoToHour(input.performance_30d.startAsOf),
    endAsOf: truncateIsoToHour(input.performance_30d.endAsOf),
    startPnlUsd: bucketSignedUsd(input.performance_30d.startPnlUsd),
    endPnlUsd: bucketSignedUsd(input.performance_30d.endPnlUsd),
    deltaPnlUsd: bucketSignedUsd(input.performance_30d.deltaPnlUsd),
    startRoi: bucketSignedDecimal(input.performance_30d.startRoi),
    endRoi: bucketSignedDecimal(input.performance_30d.endRoi),
    deltaRoi: bucketSignedDecimal(input.performance_30d.deltaRoi),
    minPnlUsd: bucketSignedUsd(input.performance_30d.minPnlUsd),
    maxPnlUsd: bucketSignedUsd(input.performance_30d.maxPnlUsd),
    minRoi: bucketSignedDecimal(input.performance_30d.minRoi),
    maxRoi: bucketSignedDecimal(input.performance_30d.maxRoi),
    points: input.performance_30d.points.slice(0, 6).map((point) => ({
      asOf: truncateIsoToHour(point.asOf) ?? point.asOf,
      pnlUsd: bucketSignedUsd(point.pnlUsd),
      roi: bucketSignedDecimal(point.roi),
    })),
  };
  const metricsHash: WhaleProfileInput["metrics"] = {
    ...input.metrics,
    pnl_30d: bucketSignedUsd(input.metrics.pnl_30d),
    avg_trade_usd: bucketSignedUsd(input.metrics.avg_trade_usd),
    pnl_to_volume_ratio: bucketSignedDecimal(input.metrics.pnl_to_volume_ratio),
  };
  const performanceContextHash: WhaleProfileInput["performance_context"] = {
    start_marked_pnl_30d: bucketSignedUsd(
      input.performance_context.start_marked_pnl_30d,
    ),
    current_marked_pnl: bucketSignedUsd(
      input.performance_context.current_marked_pnl,
    ),
    portfolio_change_30d: bucketSignedUsd(
      input.performance_context.portfolio_change_30d,
    ),
    min_portfolio_change_30d: bucketSignedUsd(
      input.performance_context.min_portfolio_change_30d,
    ),
    max_portfolio_change_30d: bucketSignedUsd(
      input.performance_context.max_portfolio_change_30d,
    ),
    trade_pnl_30d: bucketSignedUsd(input.performance_context.trade_pnl_30d),
    trade_roi_30d: bucketSignedDecimal(input.performance_context.trade_roi_30d),
    pnl_to_volume_ratio: bucketSignedDecimal(
      input.performance_context.pnl_to_volume_ratio,
    ),
  };
  const positioningContextHash: WhaleProfileInput["positioning_context"] = {
    avg_open_position_usd: bucketSignedUsd(
      input.positioning_context.avg_open_position_usd,
    ),
    largest_position_usd: bucketSignedUsd(
      input.positioning_context.largest_position_usd,
    ),
    weighted_avg_held_odds: bucketRate(
      input.positioning_context.weighted_avg_held_odds,
    ),
    high_probability_exposure_share: bucketRate(
      input.positioning_context.high_probability_exposure_share,
    ),
    low_probability_exposure_share: bucketRate(
      input.positioning_context.low_probability_exposure_share,
    ),
  };
  const signalsHash: WhaleProfileInput["signals"] = {
    summary: input.signals.summary
      ? {
          criticalSignals30d: bucketCount(
            input.signals.summary.criticalSignals30d,
          ),
          avgSignalScore30d: bucketRate(
            input.signals.summary.avgSignalScore30d,
          ),
          hasReactivatedAfterIdle:
            input.signals.summary.hasReactivatedAfterIdle,
          hasLateEntry: input.signals.summary.hasLateEntry,
          hasVeryLateEntry: input.signals.summary.hasVeryLateEntry,
          hasUnusualBehavior: input.signals.summary.hasUnusualBehavior,
        }
      : null,
    examples: input.signals.examples.slice(0, 3).map((example) => ({
      ...example,
      delta_usd: bucketSignedUsd(example.delta_usd),
      stake_usd: bucketSignedUsd(example.stake_usd),
      odds: bucketRate(example.odds),
      signal_score: bucketRate(example.signal_score),
      occurred_at: truncateIsoToHour(example.occurred_at),
      reason_codes: example.reason_codes.slice(0, 4),
    })),
  };

  return {
    ...input,
    metrics: metricsHash,
    performance_context: performanceContextHash,
    positioning_context: positioningContextHash,
    category_mix: input.category_mix.map((item) => ({
      category: item.category,
      volumeUsd: bucketSignedUsd(item.volumeUsd) ?? 0,
      tradeCount: bucketCount(item.tradeCount),
      share: bucketRate(item.share) ?? 0,
    })),
    entry_brackets: input.entry_brackets.map((item) => ({
      bracket: item.bracket,
      avgStakeUsd: bucketSignedUsd(item.avgStakeUsd),
      totalStakeUsd: bucketSignedUsd(item.totalStakeUsd) ?? 0,
      tradeCount: bucketCount(item.tradeCount),
      resolvedCount: bucketCount(item.resolvedCount),
      winRate: bucketRate(item.winRate),
    })),
    performance_30d: performanceHash,
    signals: signalsHash,
    closed_positions_sample: input.closed_positions_sample
      .slice(0, 4)
      .map((item) => ({
        ...item,
        sizeUsd: bucketSignedUsd(item.sizeUsd),
        entryPrice: bucketRate(item.entryPrice),
        snapshotAt: truncateIsoToHour(item.snapshotAt),
      })),
    recent_window: recentHash,
  };
}

function hashProfileInput(input: WhaleProfileInput): string {
  const hashInput = buildProfileHashInput(input);
  return crypto
    .createHash("sha256")
    .update(JSON.stringify(hashInput))
    .digest("hex");
}

function coerceRank(value: number | string | null | undefined): number | null {
  if (value == null) return null;
  const parsed =
    typeof value === "string" ? Number.parseInt(value, 10) : Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function getWhaleProfileSourceRows<T extends WhaleSelectableRow>(
  rows: T[],
  source: WhaleProfileSourceDef,
): T[] {
  if (source.fetchLimit <= 0) return [];
  return rows
    .filter((row) => {
      const rank = source.rankOf(row);
      return rank != null && rank <= source.fetchLimit;
    })
    .sort((left, right) => {
      const leftRank = source.rankOf(left) ?? Number.MAX_SAFE_INTEGER;
      const rightRank = source.rankOf(right) ?? Number.MAX_SAFE_INTEGER;
      if (leftRank !== rightRank) return leftRank - rightRank;
      if (left.source_hits !== right.source_hits) {
        return right.source_hits - left.source_hits;
      }
      const leftActivity = left.last_activity_at?.getTime() ?? 0;
      const rightActivity = right.last_activity_at?.getTime() ?? 0;
      return rightActivity - leftActivity;
    });
}

function selectWhaleProfileRows<T extends WhaleSelectableRow>(
  rows: T[],
  limit: number,
  sources: WhaleProfileSourceDef[],
): {
  rows: T[];
  pinnedCoverage: Record<WhaleProfileSourceKey, number>;
} {
  const selected: T[] = [];
  const seen = new Set<string>();
  const pinnedCoverage: Record<WhaleProfileSourceKey, number> = {
    trackerRecent: 0,
    trackerPnl: 0,
    trackerWinRate: 0,
    recent: 0,
    pnl: 0,
    signals: 0,
  };

  for (const source of sources) {
    if (selected.length >= limit) break;
    let sourceSelected = 0;
    for (const row of getWhaleProfileSourceRows(rows, source)) {
      if (selected.length >= limit || sourceSelected >= source.targetLimit) {
        break;
      }
      if (seen.has(row.id)) continue;
      selected.push(row);
      seen.add(row.id);
      sourceSelected += 1;
    }
    pinnedCoverage[source.key] = sourceSelected;
  }

  if (selected.length < limit) {
    for (const row of rows) {
      if (selected.length >= limit) break;
      if (seen.has(row.id)) continue;
      selected.push(row);
      seen.add(row.id);
    }
  }

  return { rows: selected, pinnedCoverage };
}

async function loadTrackerSurfaceIds(
  client: PoolClient,
  options: {
    windowHours: number;
    limit: number;
    minActivityUsd: number;
    minActivityShares: number;
  },
): Promise<string[]> {
  if (options.limit <= 0) return [];
  const activeRows = await client.query<{ wallet_id: string }>(
    `
      select wah.wallet_id
      from wallet_activity_hourly wah
      where wah.activity_type in ('delta', 'trade')
        and wah.hour_bucket >= now() - ($1::text || ' hours')::interval
      group by wah.wallet_id
      having (
        $2::numeric <= 0
        and $3::numeric <= 0
      )
      or coalesce(sum(abs(wah.signed_delta_usd)), 0) >= $2::numeric
      or coalesce(sum(abs(wah.signed_delta_shares)), 0) >= $3::numeric
    `,
    [
      Math.max(1, Math.trunc(options.windowHours)),
      options.minActivityUsd,
      options.minActivityShares,
    ],
  );
  const activeWalletIds = activeRows.rows.map((row) => row.wallet_id);
  if (activeWalletIds.length === 0) return [];

  const summaryStatsMap = await fetchWalletActivitySummaryStats(
    client,
    activeWalletIds,
    {
      windowHours: Math.max(1, Math.trunc(options.windowHours)),
      topChanges: 1,
      baselineDays: 30,
    },
  );

  return Array.from(summaryStatsMap.values())
    .filter((row: WalletActivitySummaryStats) => Boolean(row.lastActivityAt))
    .sort((left, right) =>
      compareWalletActivitySummaryStats(left, right, "last_activity"),
    )
    .slice(0, Math.max(1, Math.trunc(options.limit)))
    .map((row) => row.walletId);
}

async function loadWhaleSelectionRows(
  client: PoolClient,
  params: {
    windowDays: number;
    limit: number;
    trackerWindowHours: number;
    signalsWindowHours: number;
    trackerSurfaceIds: string[];
    selectTrackerRecentLimit: number;
    selectTrackerPnlLimit: number;
    selectTrackerWinRateLimit: number;
    selectRecentLimit: number;
    selectPnlLimit: number;
    selectSignalsLimit: number;
    trackerRecentFetchLimit: number;
    trackerPnlFetchLimit: number;
    trackerWinRateFetchLimit: number;
    recentFetchLimit: number;
    pnlFetchLimit: number;
    signalsFetchLimit: number;
    candidateFetchLimit: number;
  },
): Promise<WhaleSelectionRow[]> {
  const result = await client.query<WhaleSelectionRow>(
    `
      with whale_wallets as (
        select distinct tm.wallet_id
        from wallet_tag_map tm
        join wallet_tags t on t.id = tm.tag_id
        where t.slug = 'whale'
      ),
      tracker_surface as (
        select
          ts.wallet_id as id,
          ts.ordinality::int as rank_tracker_recent
        from unnest($10::uuid[]) with ordinality as ts(wallet_id, ordinality)
      ),
      selection_wallets as (
        select wallet_id as id from whale_wallets
        union
        select id from tracker_surface
      ),
      tracker_start_snap as (
        select distinct on (s.wallet_id)
          s.wallet_id,
          s.as_of,
          s.pnl_usd
        from wallet_metrics_snapshots s
        join tracker_surface ts on ts.id = s.wallet_id
        where s.period = 'all'
          and s.pnl_usd is not null
          and ${aggregateWalletMetricsFilterSql("s")}
          and s.as_of <= now() - interval '720 hours'
        order by s.wallet_id, s.as_of desc, ${aggregateWalletMetricsPreferenceSql("s")}
      ),
      tracker_fallback_start as (
        select distinct on (s.wallet_id)
          s.wallet_id,
          s.as_of,
          s.pnl_usd
        from wallet_metrics_snapshots s
        join tracker_surface ts on ts.id = s.wallet_id
        where s.period = 'all'
          and s.pnl_usd is not null
          and ${aggregateWalletMetricsFilterSql("s")}
          and s.as_of > now() - interval '720 hours'
          and s.as_of <= now()
        order by s.wallet_id, s.as_of asc, ${aggregateWalletMetricsPreferenceSql("s")}
      ),
      tracker_end_snap as (
        select distinct on (s.wallet_id)
          s.wallet_id,
          s.as_of,
          s.pnl_usd
        from wallet_metrics_snapshots s
        join tracker_surface ts on ts.id = s.wallet_id
        where s.period = 'all'
          and s.pnl_usd is not null
          and ${aggregateWalletMetricsFilterSql("s")}
          and s.as_of <= now()
        order by s.wallet_id, s.as_of desc, ${aggregateWalletMetricsPreferenceSql("s")}
      ),
      tracker_portfolio_pnl as (
        select
          ts.id,
          case
            when es.pnl_usd is null then null
            when coalesce(ss.pnl_usd, fs.pnl_usd) is null then null
            else es.pnl_usd - coalesce(ss.pnl_usd, fs.pnl_usd)
          end as tracker_visible_pnl
        from tracker_surface ts
        left join tracker_start_snap ss on ss.wallet_id = ts.id
        left join tracker_fallback_start fs on fs.wallet_id = ts.id
        left join tracker_end_snap es on es.wallet_id = ts.id
      ),
      latest_metrics as (
        select distinct on (s.wallet_id)
          s.wallet_id,
          s.volume_usd as metrics_volume,
          s.pnl_usd as metrics_pnl,
          s.trades_count as metrics_trades,
          s.win_rate as metrics_win_rate,
          s.last_trade_at as metrics_last_trade_at
        from wallet_metrics_snapshots s
        join selection_wallets sw on sw.id = s.wallet_id
        where s.period = '30d'
          and ${aggregateWalletMetricsFilterSql("s")}
        order by s.wallet_id, s.as_of desc, ${aggregateWalletMetricsPreferenceSql("s")}
      ),
      activity as (
        select
          wah.wallet_id,
          max(wah.hour_bucket) as last_activity_at,
          bool_or(wah.activity_type in ('delta', 'trade')) as has_trade_activity,
          bool_or(wah.activity_type = 'holder') as has_holder_activity,
          max(coalesce(wah.max_abs_delta_usd, 0)) filter (
            where wah.activity_type in ('delta', 'trade')
              and wah.hour_bucket >= now() - ($9::text || ' hours')::interval
          ) as signal_abs_usd
        from wallet_activity_hourly wah
        join selection_wallets sw on sw.id = wah.wallet_id
        where wah.activity_type in ('delta', 'trade', 'holder')
          and wah.hour_bucket >= now() - ($1::text || ' days')::interval
        group by wah.wallet_id
      ),
      wallet_base as (
        select
          w.id,
          coalesce(
            activity.last_activity_at,
            metrics.metrics_last_trade_at,
            w.last_seen_at
          ) as last_activity_at,
          ts.rank_tracker_recent,
          coalesce(tpp.tracker_visible_pnl, metrics.metrics_pnl) as tracker_visible_pnl,
          metrics.metrics_pnl,
          metrics.metrics_win_rate,
          metrics.metrics_trades,
          coalesce(activity.signal_abs_usd, 0) as signal_abs_usd,
          case
            when w.chain = 'solana'
              then coalesce(
                nullif(metrics.metrics_volume, 0),
                exposure.exposure_usd,
                0
              )
            else coalesce(metrics.metrics_volume, 0)
          end as whale_score,
          (ww.wallet_id is not null) as is_whale_candidate
        from selection_wallets sw
        join wallets w on w.id = sw.id
        left join whale_wallets ww on ww.wallet_id = w.id
        left join tracker_surface ts on ts.id = w.id
        left join tracker_portfolio_pnl tpp on tpp.id = w.id
        left join latest_metrics metrics on metrics.wallet_id = w.id
        left join activity on activity.wallet_id = w.id
        left join wallet_position_exposure exposure on exposure.wallet_id = w.id
      ),
      tracker_pnl_ranked as (
        select
          id,
          row_number() over (
            order by
              tracker_visible_pnl desc nulls last,
              rank_tracker_recent asc nulls last,
              id asc
          ) as rank_tracker_pnl
        from wallet_base
        where rank_tracker_recent is not null
      ),
      tracker_win_rate_ranked as (
        select
          id,
          row_number() over (
            order by
              metrics_win_rate desc nulls last,
              metrics_trades desc nulls last,
              rank_tracker_recent asc nulls last,
              id asc
          ) as rank_tracker_win_rate
        from wallet_base
        where rank_tracker_recent is not null
          and metrics_win_rate is not null
          and coalesce(metrics_trades, 0) >= 5
      ),
      recent_ranked as (
        select
          id,
          row_number() over (
            order by
              last_activity_at desc nulls last,
              whale_score desc nulls last,
              id asc
          ) as rank_recent
        from wallet_base
        where is_whale_candidate
      ),
      pnl_ranked as (
        select
          id,
          row_number() over (
            order by
              metrics_pnl desc nulls last,
              last_activity_at desc nulls last,
              id asc
          ) as rank_pnl
        from wallet_base
        where is_whale_candidate
      ),
      signal_ranked as (
        select
          id,
          row_number() over (
            order by
              signal_abs_usd desc nulls last,
              last_activity_at desc nulls last,
              id asc
          ) as rank_signal
        from wallet_base
        where is_whale_candidate
      ),
      candidate_ids as (
        select id from tracker_surface where rank_tracker_recent <= $11
        union
        select id from tracker_pnl_ranked where rank_tracker_pnl <= $12
        union
        select id from tracker_win_rate_ranked where rank_tracker_win_rate <= $13
        union
        select id from recent_ranked where rank_recent <= $14
        union
        select id from pnl_ranked where rank_pnl <= $15
        union
        select id from signal_ranked where rank_signal <= $16
      )
      select
        wb.id,
        wb.last_activity_at,
        wb.rank_tracker_recent,
        tp.rank_tracker_pnl,
        tw.rank_tracker_win_rate,
        r.rank_recent,
        p.rank_pnl,
        s.rank_signal,
        (
          case when $3 > 0 and wb.rank_tracker_recent <= $3 then 1 else 0 end +
          case when $4 > 0 and tp.rank_tracker_pnl <= $4 then 1 else 0 end +
          case when $5 > 0 and tw.rank_tracker_win_rate <= $5 then 1 else 0 end +
          case when $6 > 0 and r.rank_recent <= $6 then 1 else 0 end +
          case when $7 > 0 and p.rank_pnl <= $7 then 1 else 0 end +
          case when $8 > 0 and s.rank_signal <= $8 then 1 else 0 end
        )::int as source_hits
      from wallet_base wb
      join candidate_ids c on c.id = wb.id
      left join tracker_pnl_ranked tp on tp.id = wb.id
      left join tracker_win_rate_ranked tw on tw.id = wb.id
      left join recent_ranked r on r.id = wb.id
      left join pnl_ranked p on p.id = wb.id
      left join signal_ranked s on s.id = wb.id
      order by
        (
          case when $3 > 0 and wb.rank_tracker_recent <= $3 then 1 else 0 end +
          case when $4 > 0 and tp.rank_tracker_pnl <= $4 then 1 else 0 end +
          case when $5 > 0 and tw.rank_tracker_win_rate <= $5 then 1 else 0 end
        ) desc,
        (
          case when $3 > 0 and wb.rank_tracker_recent <= $3 then 1 else 0 end +
          case when $4 > 0 and tp.rank_tracker_pnl <= $4 then 1 else 0 end +
          case when $5 > 0 and tw.rank_tracker_win_rate <= $5 then 1 else 0 end +
          case when $6 > 0 and r.rank_recent <= $6 then 1 else 0 end +
          case when $7 > 0 and p.rank_pnl <= $7 then 1 else 0 end +
          case when $8 > 0 and s.rank_signal <= $8 then 1 else 0 end
        ) desc,
        wb.rank_tracker_recent asc nulls last,
        tp.rank_tracker_pnl asc nulls last,
        tw.rank_tracker_win_rate asc nulls last,
        r.rank_recent asc nulls last,
        p.rank_pnl asc nulls last,
        s.rank_signal asc nulls last,
        wb.last_activity_at desc nulls last,
        wb.id asc
      limit greatest($2::int, $17::int)
    `,
    [
      params.windowDays,
      params.limit,
      params.selectTrackerRecentLimit,
      params.selectTrackerPnlLimit,
      params.selectTrackerWinRateLimit,
      params.selectRecentLimit,
      params.selectPnlLimit,
      params.selectSignalsLimit,
      params.signalsWindowHours,
      params.trackerSurfaceIds,
      params.trackerRecentFetchLimit,
      params.trackerPnlFetchLimit,
      params.trackerWinRateFetchLimit,
      params.recentFetchLimit,
      params.pnlFetchLimit,
      params.signalsFetchLimit,
      params.candidateFetchLimit,
    ],
  );
  return result.rows;
}

async function loadWhaleRowsByIds(
  client: PoolClient,
  params: {
    walletIds: string[];
    windowDays: number;
    signalsWindowHours: number;
  },
): Promise<Map<string, Omit<WhaleRow, keyof WhaleSelectableRow>>> {
  if (params.walletIds.length === 0) return new Map();
  const result = await client.query<
    Omit<WhaleRow, keyof WhaleSelectableRow> & {
      id: string;
      last_activity_at: Date | null;
    }
  >(
    `
      with selected_wallets as (
        select
          ws.wallet_id as id,
          ws.ordinality::int as ordinality
        from unnest($1::uuid[]) with ordinality as ws(wallet_id, ordinality)
      )
      select
        w.id,
        w.address,
        w.chain,
        w.label,
        (w.metadata->>'kind' = 'safe') as is_safe,
        owner.owner_address,
        owner.owner_label,
        metrics.metrics_volume,
        metrics.metrics_pnl,
        metrics.metrics_trades,
        metrics.metrics_roi,
        metrics.metrics_win_rate,
        metrics.metrics_last_trade_at,
        exposure.exposure_usd,
        exposure.hedged_notional_usd,
        exposure.net_imbalance_usd,
        exposure.hedge_ratio,
        exposure.two_sided_markets,
        coalesce(activity.last_activity_at, metrics.metrics_last_trade_at, w.last_seen_at) as last_activity_at,
        activity.has_trade_activity,
        activity.has_holder_activity,
        signal.signal_abs_usd,
        case
          when w.chain = 'solana'
            then coalesce(nullif(metrics.metrics_volume, 0), exposure.exposure_usd, 0)
          else coalesce(metrics.metrics_volume, 0)
        end as whale_score,
        inferred.wins as inferred_wins,
        inferred.total as inferred_total
      from selected_wallets sw
      join wallets w on w.id = sw.id
      left join lateral (
        select
          s.volume_usd as metrics_volume,
          s.pnl_usd as metrics_pnl,
          s.trades_count as metrics_trades,
          s.roi as metrics_roi,
          s.win_rate as metrics_win_rate,
          s.last_trade_at as metrics_last_trade_at
        from wallet_metrics_snapshots s
        where s.wallet_id = w.id
          and s.period = '30d'
          and ${aggregateWalletMetricsFilterSql("s")}
        order by s.as_of desc, ${aggregateWalletMetricsPreferenceSql("s")}
        limit 1
      ) metrics on true
      left join lateral (
        select
          max(wa.occurred_at) as last_activity_at,
          bool_or(wa.activity_type in ('delta', 'trade')) as has_trade_activity,
          bool_or(wa.activity_type = 'holder') as has_holder_activity
        from wallet_activity_events wa
        where wa.wallet_id = w.id
          and wa.activity_type in ('delta', 'trade', 'holder')
          and wa.occurred_at >= now() - ($2::text || ' days')::interval
      ) activity on true
      left join lateral (
        select
          max(coalesce(wah.max_abs_delta_usd, 0)) as signal_abs_usd
        from wallet_activity_hourly wah
        where wah.wallet_id = w.id
          and wah.activity_type in ('delta', 'trade')
          and wah.hour_bucket >= now() - ($3::text || ' hours')::interval
      ) signal on true
      left join wallet_position_exposure exposure on exposure.wallet_id = w.id
      left join lateral (
        select
          w2.address as owner_address,
          w2.label as owner_label
        from wallets w2
        where w2.chain = w.chain
          and (
            (
              w.metadata->>'linkedOwnerAddress' is not null
              and lower(w2.address) = lower(w.metadata->>'linkedOwnerAddress')
            )
            or (
              w.metadata->>'kind' = 'safe'
              and w2.metadata->>'kind' = 'safe_owner'
              and w2.metadata->>'derivedFrom' = w.address
            )
          )
        order by case
          when w.metadata->>'linkedOwnerAddress' is not null
            and lower(w2.address) = lower(w.metadata->>'linkedOwnerAddress')
          then 0
          else 1
        end
        limit 1
      ) owner on true
      left join lateral (
        with latest as (
          select distinct on (ws.market_id, ws.outcome_side)
            ws.market_id,
            ws.outcome_side,
            ws.shares
          from wallet_position_snapshots ws
          where ws.wallet_id = w.id
            and ws.shares > 0
          order by ws.market_id, ws.outcome_side, ws.snapshot_at desc
        ),
        agg as (
          select
            market_id,
            sum(case when outcome_side = 'YES' then shares else 0 end) as yes_shares,
            sum(case when outcome_side = 'NO' then shares else 0 end) as no_shares
          from latest
          group by market_id
        ),
        resolved as (
          select
            agg.market_id,
            agg.yes_shares,
            agg.no_shares,
            upper(m.resolved_outcome) as resolved_outcome
          from agg
          join unified_markets m on m.id = agg.market_id
          where m.resolved_outcome is not null
            and upper(m.resolved_outcome) in ('YES', 'NO')
        ),
        eligible as (
          select *
          from resolved
          where (yes_shares > 0 and coalesce(no_shares, 0) = 0)
             or (no_shares > 0 and coalesce(yes_shares, 0) = 0)
        )
        select
          count(*) filter (
            where (resolved_outcome = 'YES' and yes_shares > 0 and no_shares = 0)
               or (resolved_outcome = 'NO' and no_shares > 0 and yes_shares = 0)
          ) as wins,
          count(*)::int as total
        from eligible
      ) inferred on true
      order by sw.ordinality asc
    `,
    [params.walletIds, params.windowDays, params.signalsWindowHours],
  );

  const byId = new Map<string, Omit<WhaleRow, keyof WhaleSelectableRow>>();
  for (const row of result.rows) {
    const { id, last_activity_at, ...rest } = row;
    void last_activity_at;
    byId.set(id, rest);
  }
  return byId;
}

export function parseProfileJson(raw: string): unknown | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    const start = raw.indexOf("{");
    const end = raw.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(raw.slice(start, end + 1));
      } catch {
        return null;
      }
    }
    return null;
  }
}

export function normalizeWhaleProfile(raw: unknown): WhaleProfile | null {
  const parsed = whaleProfileOutputSchema.safeParse(raw);
  if (!parsed.success) return null;
  const archetype = parsed.data.archetype
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 80);
  if (!archetype) return null;
  const categories = normalizeCategoryList(parsed.data.categories ?? [])
    .filter((entry) => categorySchema.safeParse(entry).success)
    .slice(0, 3);
  const themeFocus = Array.from(
    new Set(
      (parsed.data.theme_focus ?? [])
        .map((entry) => entry.trim().toLowerCase())
        .filter((entry) => entry.length > 0),
    ),
  ).slice(0, 3);
  const evidence = Array.from(
    new Set(parsed.data.evidence.map((entry) => entry.trim()).filter(Boolean)),
  )
    .slice(0, 4)
    .map((entry) => truncateText(entry, 160));
  const notes = normalizeBulletNotes(parsed.data.notes);
  const labelShort = truncateText(
    sanitizeProfileLabelShort(parsed.data.label_short.trim()) ?? "",
    56,
  );
  const labelLong = parsed.data.label_long.trim();
  const riskStyle = truncateText(parsed.data.risk_style.trim(), 96);
  if (!labelShort) return null;

  return {
    label_short: labelShort,
    label_long: labelLong,
    archetype: truncateText(archetype, 80),
    ...(categories.length ? { categories } : {}),
    ...(themeFocus.length ? { theme_focus: themeFocus } : {}),
    risk_style: riskStyle,
    confidence: parsed.data.confidence,
    evidence,
    ...(notes ? { notes: truncateText(notes, 560) } : {}),
  };
}

function mapCategory(raw: string): WhaleCategory | null {
  const key = raw.trim().toLowerCase();
  if (!key) return null;
  if (CATEGORY_VALUES.includes(key as WhaleCategory))
    return key as WhaleCategory;
  if (key.includes("sport")) return "sports";
  if (
    key.includes("politic") ||
    key.includes("election") ||
    key.includes("geopolit") ||
    key === "world"
  ) {
    return "politics";
  }
  if (
    key.includes("crypto") ||
    key.includes("blockchain") ||
    key.includes("web3")
  ) {
    return "crypto";
  }
  if (key.includes("weather") || key.includes("climate")) {
    return "weather";
  }
  if (
    key.includes("finance") ||
    key.includes("financial") ||
    key.includes("econom") ||
    key.includes("macro") ||
    key.includes("rates") ||
    key.includes("fed") ||
    key.includes("stocks") ||
    key.includes("equities") ||
    key.includes("markets") ||
    key.includes("companies")
  ) {
    return "economics";
  }
  if (
    key.includes("entertain") ||
    key.includes("culture") ||
    key.includes("celebrity") ||
    key.includes("music")
  ) {
    return "entertainment";
  }
  if (
    key.includes("tech") ||
    key.includes("ai") ||
    key.includes("software") ||
    key.includes("science")
  ) {
    return "technology";
  }
  if (key.includes("health") || key.includes("medicine")) {
    return "health";
  }
  if (key.includes("mention")) return "mentions";
  if (
    key.includes("social") ||
    key.includes("twitter") ||
    key.includes("tweets")
  ) {
    return "other";
  }
  return null;
}

function normalizeCategoryList(raw: unknown): WhaleCategory[] {
  if (!Array.isArray(raw)) return [];
  const deduped = new Set<WhaleCategory>();
  for (const entry of raw) {
    if (typeof entry !== "string") continue;
    const mapped = mapCategory(entry);
    if (mapped) deduped.add(mapped);
  }
  return Array.from(deduped);
}

function deriveCategoriesFromInput(
  input: WhaleProfileInput,
  themeFocus?: string[],
): WhaleCategory[] {
  const counts = new Map<WhaleCategory, number>();
  for (const item of input.category_mix) {
    const mapped = mapCategory(item.category);
    if (!mapped) continue;
    counts.set(mapped, (counts.get(mapped) ?? 0) + Math.max(item.share, 0));
  }
  for (const [rawKey, count] of Object.entries(input.summary.category_counts)) {
    const mapped = mapCategory(rawKey);
    if (!mapped) continue;
    counts.set(mapped, (counts.get(mapped) ?? 0) + count);
  }
  if (counts.size === 0 && themeFocus?.length) {
    for (const focus of themeFocus) {
      const mapped = mapCategory(focus);
      if (!mapped) continue;
      counts.set(mapped, (counts.get(mapped) ?? 0) + 1);
    }
  }
  const ranked = Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1])
    .map(([category]) => category);
  return ranked.slice(0, 3);
}

function resolveHeldOdds(
  side: string | null | undefined,
  positionPrice: number | null,
  lastYesPrice: number | null,
): number | null {
  if (positionPrice != null && Number.isFinite(positionPrice)) {
    return positionPrice;
  }
  if (lastYesPrice == null || !Number.isFinite(lastYesPrice) || !side)
    return null;
  const normalized = side.toUpperCase();
  if (normalized === "YES") return lastYesPrice;
  if (normalized === "NO") return 1 - lastYesPrice;
  return null;
}

type ProfileTopMarket = WhaleProfileInput["top_markets"][number];

function normalizeProfilePositionSide(
  side: string | null | undefined,
  hasYesPosition: boolean,
  hasNoPosition: boolean,
): ProfileTopMarket["position_side"] {
  if (hasYesPosition && hasNoPosition) return "BOTH";
  return normalizeOutcomeSideForApi(side);
}

export function mapWhaleMarketToProfileMarket(
  market: WhaleMarketRow,
  nowMs: number = Date.now(),
): ProfileTopMarket {
  const snapshotAt = market.snapshot_at
    ? market.snapshot_at.toISOString()
    : null;
  const closeTime = market.close_time ? market.close_time.toISOString() : null;
  const expirationTime = market.expiration_time
    ? market.expiration_time.toISOString()
    : null;
  const resolved = Boolean(market.resolved_outcome);
  const status = market.status?.toUpperCase();
  const hasEndedStatus = status != null && status !== "ACTIVE";
  const endTimestamp = closeTime ?? expirationTime;
  const endTimeMs = endTimestamp ? new Date(endTimestamp).getTime() : null;
  const endedByTime = endTimeMs != null && endTimeMs < nowMs;
  const isActive = !(resolved || hasEndedStatus || endedByTime);
  const hasYesPosition = Boolean(market.has_yes_position);
  const hasNoPosition = Boolean(market.has_no_position);
  const positionSide = normalizeProfilePositionSide(
    market.position_side,
    hasYesPosition,
    hasNoPosition,
  );
  const yesPositionShares = parseNumber(market.yes_position_shares);
  const yesPositionValueUsd = parseNumber(market.yes_position_value_usd);
  const yesPositionPrice = parseNumber(market.yes_position_price);
  const noPositionShares = parseNumber(market.no_position_shares);
  const noPositionValueUsd = parseNumber(market.no_position_value_usd);
  const noPositionPrice = parseNumber(market.no_position_price);
  const lastYesPrice = parseNumber(market.last_price);
  const outcomes = parseMarketOutcomes(market.outcomes);
  const yesLabel = outcomeLabelOrSide(outcomes, "YES");
  const noLabel = outcomeLabelOrSide(outcomes, "NO");
  const positionLabel =
    positionSide === "YES" || positionSide === "NO"
      ? outcomeLabelOrSide(outcomes, positionSide)
      : null;

  return {
    market_id: market.market_id,
    market_title: market.market_title,
    outcomes,
    event_id: market.event_id,
    event_title: market.event_title,
    venue: market.venue,
    category: market.category,
    status: market.status,
    close_time: closeTime,
    expiration_time: expirationTime,
    resolved_outcome: market.resolved_outcome,
    is_active: isActive,
    snapshot_at: snapshotAt,
    recent_activity: {
      last_activity_at: market.recent_last_activity_at
        ? market.recent_last_activity_at.toISOString()
        : null,
      volume_usd: parseNumber(market.recent_volume_usd),
      activity_count: market.recent_activity_count,
      avg_price: parseNumber(market.recent_avg_price),
    },
    best_bid: parseNumber(market.best_bid),
    best_ask: parseNumber(market.best_ask),
    last_yes_price: lastYesPrice,
    held_odds: resolveHeldOdds(
      positionSide,
      parseNumber(market.position_price),
      lastYesPrice,
    ),
    position_side: positionSide,
    position_label: positionLabel,
    yes_label: yesLabel,
    no_label: noLabel,
    is_two_sided: hasYesPosition && hasNoPosition,
    position_shares: parseNumber(market.position_shares),
    position_value_usd: parseNumber(market.position_value_usd),
    position_price: parseNumber(market.position_price),
    yes_position_shares: yesPositionShares,
    yes_position_value_usd: yesPositionValueUsd,
    yes_position_price: yesPositionPrice,
    no_position_shares: noPositionShares,
    no_position_value_usd: noPositionValueUsd,
    no_position_price: noPositionPrice,
  };
}

export function computeProfileSideBias(markets: ProfileTopMarket[]): {
  yesValue: number;
  noValue: number;
  sideRatio: number | null;
  sideBiasLabel: WhaleProfileInput["summary"]["side_bias_label"];
} {
  let yesValue = 0;
  let noValue = 0;
  for (const market of markets) {
    yesValue +=
      market.yes_position_value_usd ??
      market.yes_position_shares ??
      (market.position_side?.toUpperCase() === "YES"
        ? (market.position_value_usd ?? market.position_shares ?? 0)
        : 0);
    noValue +=
      market.no_position_value_usd ??
      market.no_position_shares ??
      (market.position_side?.toUpperCase() === "NO"
        ? (market.position_value_usd ?? market.position_shares ?? 0)
        : 0);
  }
  const totalSide = yesValue + noValue;
  const sideRatio = totalSide > 0 ? yesValue / totalSide : null;
  const sideBiasLabel: WhaleProfileInput["summary"]["side_bias_label"] =
    sideRatio == null
      ? "unknown"
      : sideRatio >= 0.65
        ? "mostly_yes"
        : sideRatio <= 0.35
          ? "mostly_no"
          : "mixed";
  return { yesValue, noValue, sideRatio, sideBiasLabel };
}

async function callOpenRouter(
  model: string,
  messages: Array<{ role: "system" | "user"; content: string }>,
  maxTokens: number,
): Promise<string> {
  if (!env.openRouterKey) {
    throw new Error("OPENROUTER_API_KEY missing");
  }

  const response = await fetch(
    "https://openrouter.ai/api/v1/chat/completions",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.openRouterKey}`,
        "Content-Type": "application/json",
        "X-Title": "Hunch Whale Profiles",
      },
      body: JSON.stringify({
        model,
        messages,
        temperature: 0,
        max_tokens: maxTokens,
        reasoning: { effort: "low" },
        response_format: { type: "json_object" },
      }),
    },
  );

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`OpenRouter ${response.status}: ${text}`);
  }

  const payload = (await response.json()) as {
    choices?: Array<{ message?: { content?: unknown } }>;
  };
  const content = payload.choices?.[0]?.message?.content;
  if (typeof content === "string") return content;
  if (content && typeof content === "object" && "text" in content) {
    const text = (content as { text?: unknown }).text;
    return typeof text === "string" ? text : "";
  }
  return "";
}

function toActivityKind(
  hasTrade: boolean | null,
  hasHolder: boolean | null,
): "trade" | "holder" | "mixed" | "unknown" {
  if (hasTrade && hasHolder) return "mixed";
  if (hasTrade) return "trade";
  if (hasHolder) return "holder";
  return "unknown";
}

function mapSignalRowToProfileSignalExample(
  row: WalletActivitySignalRow,
): WhaleProfileInput["signals"]["examples"][number] {
  const positionSide = row.positionSide ?? null;
  return {
    market_title: row.marketTitle ?? null,
    outcomes: row.outcomes ?? null,
    event_title: row.eventTitle ?? null,
    venue: row.venue,
    category: row.category ?? null,
    market_status: row.marketStatus ?? null,
    resolved_outcome: row.resolvedOutcome ?? null,
    action: row.action ?? null,
    position_side: positionSide,
    position_label:
      positionSide === "YES" || positionSide === "NO"
        ? outcomeLabelOrSide(row.outcomes, positionSide)
        : null,
    delta_usd: row.deltaUsd ?? null,
    stake_usd: row.stakeUsd ?? null,
    odds: row.odds ?? null,
    signal_score: row.signalScore ?? null,
    signal_type: row.signalType ?? null,
    late_bucket: row.lateBucket ?? null,
    reason_codes: row.reasonCodes ?? [],
    occurred_at: row.occurredAt ? row.occurredAt.toISOString() : null,
  };
}

function buildProfileInput(
  wallet: WhaleRow,
  currentMarkets: WhaleMarketRow[],
  context: {
    marketLimit: number;
    windowDays: number;
    recentSummary: WalletActivitySummary | null;
    recentWindowHours: number;
    recentTopChanges: number;
    styleGuide: string;
    categoryMix: WalletCategoryMixItem[];
    entryBracketStats: WalletEntryBracketStat[];
    performance30d: WalletPerformance30dSummary;
    signalSummary: WalletActivitySignalSummary | null;
    signalExamples: WalletActivitySignalRow[];
    closedPositionsSample: WalletResolvedPositionSample[];
  },
): WhaleProfileInput {
  const allCurrentMarkets = currentMarkets.map((market) =>
    mapWhaleMarketToProfileMarket(market),
  );
  const { topMarkets, currentPortfolio, topEvents, summary } =
    summarizeProfileMarkets(allCurrentMarkets, context.marketLimit);
  const grossExposureUsd = parseNumber(wallet.exposure_usd);
  const portfolioGrossUsd = currentPortfolio.gross_usd_total;
  const effectiveGrossUsd =
    grossExposureUsd != null && grossExposureUsd > 0
      ? grossExposureUsd
      : portfolioGrossUsd > 0
        ? portfolioGrossUsd
        : null;
  const effectiveHedgedNotionalUsd = parseNumber(wallet.hedged_notional_usd);
  const effectiveHedgeRatio =
    parseNumber(wallet.hedge_ratio) ??
    (effectiveGrossUsd && effectiveGrossUsd > 0
      ? clampNumber(
          Math.max(0, effectiveHedgedNotionalUsd ?? 0) / effectiveGrossUsd,
          0,
          1,
        )
      : null);
  const derivedTwoSidedMarkets = allCurrentMarkets.filter(
    (market) => market.is_two_sided,
  ).length;
  const ownerRole: WhaleProfileInput["wallet"]["owner_role"] =
    wallet.owner_address ? "signer_wallet" : "unknown";
  const recentSummary = context.recentSummary;
  const recentTopChanges = (recentSummary?.topChanges ?? [])
    .slice(0, context.recentTopChanges)
    .map((change) => {
      const positionSide = normalizeOutcomeSideForApi(change.positionSide);
      return {
        market_title: change.marketTitle ?? null,
        event_title: change.eventTitle ?? null,
        venue: change.venue,
        category: change.category ?? null,
        market_status: change.marketStatus ?? null,
        resolved_outcome: change.resolvedOutcome ?? null,
        action: change.action ?? null,
        position_side: positionSide,
        outcomes: change.outcomes ?? null,
        position_label:
          positionSide != null
            ? outcomeLabelOrSide(change.outcomes, positionSide)
            : null,
        delta_usd: change.deltaUsd ?? null,
        odds: change.odds ?? null,
        labels: change.labels ?? [],
        occurred_at: change.occurredAt ? change.occurredAt.toISOString() : null,
      };
    });
  const recentWindow: WhaleProfileInput["recent_window"] = {
    window_hours: context.recentWindowHours,
    last_activity_at: recentSummary?.lastActivityAt
      ? recentSummary.lastActivityAt.toISOString()
      : null,
    net_change_usd: recentSummary?.netChangeUsd ?? 0,
    net_change_yes_usd: recentSummary?.netChangeYesUsd ?? 0,
    net_change_no_usd: recentSummary?.netChangeNoUsd ?? 0,
    counts: {
      new: recentSummary?.countsNew ?? 0,
      increase: recentSummary?.countsIncrease ?? 0,
      reduce: recentSummary?.countsReduce ?? 0,
      exit: recentSummary?.countsExit ?? 0,
      flip: recentSummary?.countsFlip ?? 0,
    },
    unusual_score: recentSummary?.unusualScore ?? null,
    top_changes: recentTopChanges,
  };
  const walletKind: WhaleProfileInput["wallet"]["kind"] = wallet.is_safe
    ? "safe"
    : "eoa";
  const walletRole: WhaleProfileInput["wallet"]["role"] = "trading_wallet";
  const sourceLabel = normalizeText(wallet.label);
  const volume30d = parseNumber(wallet.metrics_volume);
  const pnl30d = parseNumber(wallet.metrics_pnl);
  const trades30d = wallet.metrics_trades ?? null;
  const roi30d = parseNumber(wallet.metrics_roi);
  const avgTradeUsd =
    volume30d != null && trades30d != null && trades30d > 0
      ? volume30d / trades30d
      : null;
  const pnlToVolumeRatio =
    pnl30d != null && volume30d != null && volume30d > 0
      ? pnl30d / volume30d
      : roi30d;
  const positioningContext = buildPositioningContext({
    grossExposureUsd: effectiveGrossUsd,
    markets: allCurrentMarkets,
  });

  return {
    context: {
      purpose: "wallet_whale_profile",
      ui: "Shown in tracker list cards and the wallet detail page.",
      top_markets_limit: context.marketLimit,
      window_days: context.windowDays,
      currency: "USD",
      display_notes:
        "Write for end-users. Notes render as multiline bullets in the wallet detail view.",
      style_guide: context.styleGuide,
    },
    wallet: {
      chain: wallet.chain,
      source_label: sourceLabel,
      source_label_quality: resolveWalletLabelQuality(
        sourceLabel,
        wallet.address,
      ),
      owner_label: normalizeText(wallet.owner_label),
      kind: walletKind,
      role: walletRole,
      owner_role: ownerRole,
    },
    metrics: {
      volume_30d: volume30d,
      pnl_30d: pnl30d,
      trades_30d: trades30d,
      avg_trade_usd: avgTradeUsd,
      roi: roi30d,
      pnl_to_volume_ratio: pnlToVolumeRatio,
      win_rate: parseNumber(wallet.metrics_win_rate),
      last_trade_at: wallet.metrics_last_trade_at
        ? wallet.metrics_last_trade_at.toISOString()
        : null,
    },
    performance_context: {
      start_marked_pnl_30d: context.performance30d.startPnlUsd,
      current_marked_pnl: context.performance30d.endPnlUsd,
      portfolio_change_30d: context.performance30d.deltaPnlUsd,
      min_portfolio_change_30d: context.performance30d.minPnlUsd,
      max_portfolio_change_30d: context.performance30d.maxPnlUsd,
      trade_pnl_30d: pnl30d,
      trade_roi_30d: roi30d,
      pnl_to_volume_ratio: pnlToVolumeRatio,
    },
    positioning_context: positioningContext,
    inferred: {
      win_rate:
        wallet.inferred_total && wallet.inferred_total > 0
          ? (wallet.inferred_wins ?? 0) / wallet.inferred_total
          : null,
      resolved_count:
        wallet.inferred_total != null ? Number(wallet.inferred_total) : null,
    },
    exposure: {
      gross_usd: effectiveGrossUsd,
      net_imbalance_usd: parseNumber(wallet.net_imbalance_usd),
      hedged_notional_usd: effectiveHedgedNotionalUsd,
      hedge_ratio: effectiveHedgeRatio,
      two_sided_markets: Math.max(
        0,
        Math.trunc(wallet.two_sided_markets ?? derivedTwoSidedMarkets),
      ),
      posture: resolveExposurePosture({
        exposureUsd: effectiveGrossUsd,
        hedgedNotionalUsd: effectiveHedgedNotionalUsd,
        hedgeRatio: effectiveHedgeRatio,
        twoSidedMarkets: wallet.two_sided_markets ?? derivedTwoSidedMarkets,
      }),
    },
    current_portfolio: {
      ...currentPortfolio,
      gross_usd_total: effectiveGrossUsd ?? currentPortfolio.gross_usd_total,
      yes_gross_usd:
        effectiveGrossUsd != null &&
        currentPortfolio.gross_usd_total > 0 &&
        currentPortfolio.yes_gross_usd > 0
          ? clampNumber(
              (currentPortfolio.yes_gross_usd /
                currentPortfolio.gross_usd_total) *
                effectiveGrossUsd,
              0,
              effectiveGrossUsd,
            )
          : currentPortfolio.yes_gross_usd,
      no_gross_usd:
        effectiveGrossUsd != null &&
        currentPortfolio.gross_usd_total > 0 &&
        currentPortfolio.no_gross_usd > 0
          ? clampNumber(
              (currentPortfolio.no_gross_usd /
                currentPortfolio.gross_usd_total) *
                effectiveGrossUsd,
              0,
              effectiveGrossUsd,
            )
          : currentPortfolio.no_gross_usd,
      top_markets_gross_usd:
        effectiveGrossUsd != null &&
        currentPortfolio.gross_usd_total > 0 &&
        currentPortfolio.top_markets_gross_usd > 0
          ? clampNumber(
              (currentPortfolio.top_markets_gross_usd /
                currentPortfolio.gross_usd_total) *
                effectiveGrossUsd,
              0,
              effectiveGrossUsd,
            )
          : currentPortfolio.top_markets_gross_usd,
      omitted_gross_usd:
        effectiveGrossUsd != null &&
        currentPortfolio.gross_usd_total > 0 &&
        currentPortfolio.omitted_gross_usd > 0
          ? clampNumber(
              (currentPortfolio.omitted_gross_usd /
                currentPortfolio.gross_usd_total) *
                effectiveGrossUsd,
              0,
              effectiveGrossUsd,
            )
          : currentPortfolio.omitted_gross_usd,
    },
    activity: {
      last_activity_at: wallet.last_activity_at
        ? wallet.last_activity_at.toISOString()
        : null,
      kind: toActivityKind(
        wallet.has_trade_activity,
        wallet.has_holder_activity,
      ),
    },
    summary,
    category_mix: context.categoryMix,
    entry_brackets: context.entryBracketStats,
    performance_30d: context.performance30d,
    signals: {
      summary: context.signalSummary,
      examples: context.signalExamples
        .slice(0, 3)
        .map(mapSignalRowToProfileSignalExample),
    },
    top_events: topEvents,
    recent_window: recentWindow,
    closed_positions_sample: context.closedPositionsSample.slice(0, 5),
    top_markets: topMarkets,
  };
}

export async function runWhaleProfiles(options: WhaleProfileOptions) {
  if (!env.openRouterKey) {
    console.warn("[whale-profile] OPENROUTER_API_KEY missing, skipping");
    return { processed: 0, updated: 0, skipped: 0, failed: 0 };
  }

  const policy: AiWhaleProfilesPolicy = options.policy ?? {
    autoRun: env.aiWhaleProfileAutoRun,
    limit: env.aiWhaleProfileLimit,
    marketLimit: env.aiWhaleProfileMarketLimit,
    windowDays: env.aiWhaleProfileWindowDays,
    selectionMode: env.aiWhaleProfileSelectionMode,
    selectionRecentLimit: env.aiWhaleProfileSelectionRecentLimit,
    selectionPnlLimit: env.aiWhaleProfileSelectionPnlLimit,
    selectionTrackerRecentLimit: env.aiWhaleProfileSelectionTrackerRecentLimit,
    selectionTrackerPnlLimit: env.aiWhaleProfileSelectionTrackerPnlLimit,
    selectionTrackerWinRateLimit:
      env.aiWhaleProfileSelectionTrackerWinRateLimit,
    selectionSignalsLimit: env.aiWhaleProfileSelectionSignalsLimit,
    selectionTrackerWindowHours: env.aiWhaleProfileSelectionTrackerWindowHours,
    selectionTrackerSurfaceLimit:
      env.aiWhaleProfileSelectionTrackerSurfaceLimit,
    selectionSignalsWindowHours: env.aiWhaleProfileSelectionSignalsWindowHours,
    model: env.aiWhaleProfileModel,
    styleGuide: env.aiWhaleProfileStyleGuide,
    maxTokens: env.aiWhaleProfileMaxTokens,
    maxTokensFallback: env.aiWhaleProfileMaxTokensFallback,
    promptVersion: "v1",
  };

  const limit = Math.max(1, options.limit);
  const marketLimit = Math.max(1, options.marketLimit);
  const windowDays = Math.max(1, options.windowDays);
  const verbose = Boolean(options.verbose);
  const logEvery = Math.max(1, Math.trunc(options.logEvery ?? 10));
  const effectiveProfileVersion = `${PROFILE_VERSION}:${policy.promptVersion.trim() || "v1"}`;
  let selectTrackerRecentLimit = Math.max(
    0,
    Math.trunc(policy.selectionTrackerRecentLimit),
  );
  let selectTrackerPnlLimit =
    policy.selectionMode === "tracker_like"
      ? Math.max(0, Math.trunc(policy.selectionTrackerPnlLimit))
      : 0;
  let selectTrackerWinRateLimit =
    policy.selectionMode === "tracker_like"
      ? Math.max(0, Math.trunc(policy.selectionTrackerWinRateLimit))
      : 0;
  const signalsWindowHours = Math.max(1, policy.selectionSignalsWindowHours);
  const trackerWindowHours = Math.max(1, policy.selectionTrackerWindowHours);
  let trackerSurfaceLimit = Math.max(
    1,
    Math.trunc(policy.selectionTrackerSurfaceLimit),
  );
  let selectRecentLimit = Math.max(0, Math.trunc(policy.selectionRecentLimit));
  let selectPnlLimit = Math.max(0, Math.trunc(policy.selectionPnlLimit));
  let selectSignalsLimit = Math.max(
    0,
    Math.trunc(policy.selectionSignalsLimit),
  );
  if (policy.selectionMode === "recent") {
    selectTrackerRecentLimit = 0;
    selectTrackerPnlLimit = 0;
    selectTrackerWinRateLimit = 0;
    selectRecentLimit = limit;
    selectPnlLimit = 0;
    selectSignalsLimit = 0;
  } else if (policy.selectionMode === "pnl") {
    selectTrackerRecentLimit = 0;
    selectTrackerPnlLimit = 0;
    selectTrackerWinRateLimit = 0;
    selectRecentLimit = 0;
    selectPnlLimit = limit;
    selectSignalsLimit = 0;
  }
  if (
    selectTrackerRecentLimit === 0 &&
    selectTrackerPnlLimit === 0 &&
    selectTrackerWinRateLimit === 0
  ) {
    trackerSurfaceLimit = 0;
  } else {
    trackerSurfaceLimit = Math.max(
      trackerSurfaceLimit,
      selectTrackerRecentLimit,
      selectTrackerPnlLimit,
      selectTrackerWinRateLimit,
    );
  }
  if (
    selectTrackerRecentLimit === 0 &&
    selectTrackerPnlLimit === 0 &&
    selectTrackerWinRateLimit === 0 &&
    selectRecentLimit === 0 &&
    selectPnlLimit === 0 &&
    selectSignalsLimit === 0
  ) {
    selectRecentLimit = limit;
  }
  const trackerRecentFetchLimit =
    selectTrackerRecentLimit > 0
      ? Math.min(trackerSurfaceLimit, selectTrackerRecentLimit + limit)
      : 0;
  const trackerPnlFetchLimit =
    selectTrackerPnlLimit > 0
      ? Math.min(trackerSurfaceLimit, selectTrackerPnlLimit + limit)
      : 0;
  const trackerWinRateFetchLimit =
    selectTrackerWinRateLimit > 0
      ? Math.min(trackerSurfaceLimit, selectTrackerWinRateLimit + limit)
      : 0;
  const recentFetchLimit =
    selectRecentLimit > 0 ? selectRecentLimit + limit : 0;
  const pnlFetchLimit = selectPnlLimit > 0 ? selectPnlLimit + limit : 0;
  const signalsFetchLimit =
    selectSignalsLimit > 0 ? selectSignalsLimit + limit : 0;
  const sourceDefs: WhaleProfileSourceDef[] = [
    {
      key: "trackerRecent" as const,
      targetLimit: selectTrackerRecentLimit,
      fetchLimit: trackerRecentFetchLimit,
      rankOf: (row: WhaleSelectableRow) => coerceRank(row.rank_tracker_recent),
    },
    {
      key: "trackerPnl" as const,
      targetLimit: selectTrackerPnlLimit,
      fetchLimit: trackerPnlFetchLimit,
      rankOf: (row: WhaleSelectableRow) => coerceRank(row.rank_tracker_pnl),
    },
    {
      key: "trackerWinRate" as const,
      targetLimit: selectTrackerWinRateLimit,
      fetchLimit: trackerWinRateFetchLimit,
      rankOf: (row: WhaleSelectableRow) =>
        coerceRank(row.rank_tracker_win_rate),
    },
    {
      key: "recent" as const,
      targetLimit: selectRecentLimit,
      fetchLimit: recentFetchLimit,
      rankOf: (row: WhaleSelectableRow) => coerceRank(row.rank_recent),
    },
    {
      key: "pnl" as const,
      targetLimit: selectPnlLimit,
      fetchLimit: pnlFetchLimit,
      rankOf: (row: WhaleSelectableRow) => coerceRank(row.rank_pnl),
    },
    {
      key: "signals" as const,
      targetLimit: selectSignalsLimit,
      fetchLimit: signalsFetchLimit,
      rankOf: (row: WhaleSelectableRow) => coerceRank(row.rank_signal),
    },
  ].filter((source) => source.targetLimit > 0 && source.fetchLimit > 0);
  const candidateFetchLimit = Math.max(
    limit,
    sourceDefs.reduce((sum, source) => sum + source.fetchLimit, 0),
  );
  console.log("[whale-profile] selection config", {
    mode: policy.selectionMode,
    limit,
    marketLimit,
    windowDays,
    selectTrackerRecentLimit,
    selectTrackerPnlLimit,
    selectTrackerWinRateLimit,
    selectRecentLimit,
    selectPnlLimit,
    selectSignalsLimit,
    trackerSurfaceLimit,
    trackerRecentFetchLimit,
    trackerPnlFetchLimit,
    trackerWinRateFetchLimit,
    recentFetchLimit,
    pnlFetchLimit,
    signalsFetchLimit,
    candidateFetchLimit,
    trackerWindowHours,
    signalsWindowHours,
    force: Boolean(options.force),
    dryRun: Boolean(options.dryRun),
    verbose,
    logEvery,
  });
  // Keep recent-window inputs small and stable; hashing is bucketed below.
  const recentWindowHours = 24;
  const recentTopChanges = 3;
  const profileSignalsWindowHours = 720;
  const client = await pool.connect();
  try {
    await client.query("SET statement_timeout = '120s'");
    const trackerSurfaceIds =
      trackerSurfaceLimit > 0
        ? await loadTrackerSurfaceIds(client, {
            windowHours: trackerWindowHours,
            limit: trackerSurfaceLimit,
            minActivityUsd: env.walletIntelMinActivityUsd,
            minActivityShares: env.walletIntelMinActivityShares,
          })
        : [];
    console.log("[whale-profile] tracker surface", {
      requested: trackerSurfaceLimit,
      actual: trackerSurfaceIds.length,
      sample: trackerSurfaceIds.slice(0, 5),
    });
    const whaleSelectionRows = await loadWhaleSelectionRows(client, {
      windowDays,
      limit,
      trackerWindowHours,
      signalsWindowHours,
      trackerSurfaceIds,
      selectTrackerRecentLimit,
      selectTrackerPnlLimit,
      selectTrackerWinRateLimit,
      selectRecentLimit,
      selectPnlLimit,
      selectSignalsLimit,
      trackerRecentFetchLimit,
      trackerPnlFetchLimit,
      trackerWinRateFetchLimit,
      recentFetchLimit,
      pnlFetchLimit,
      signalsFetchLimit,
      candidateFetchLimit,
    });
    const { rows: selectedWhaleSelectionRows, pinnedCoverage } =
      selectWhaleProfileRows(whaleSelectionRows, limit, sourceDefs);
    const sourceCoverage = {
      trackerRecent: selectedWhaleSelectionRows.filter(
        (row) =>
          (coerceRank(row.rank_tracker_recent) ?? Number.MAX_SAFE_INTEGER) <=
          selectTrackerRecentLimit,
      ).length,
      trackerPnl: selectedWhaleSelectionRows.filter(
        (row) =>
          (coerceRank(row.rank_tracker_pnl) ?? Number.MAX_SAFE_INTEGER) <=
          selectTrackerPnlLimit,
      ).length,
      trackerWinRate: selectedWhaleSelectionRows.filter(
        (row) =>
          (coerceRank(row.rank_tracker_win_rate) ?? Number.MAX_SAFE_INTEGER) <=
          selectTrackerWinRateLimit,
      ).length,
      recent: selectedWhaleSelectionRows.filter(
        (row) =>
          (coerceRank(row.rank_recent) ?? Number.MAX_SAFE_INTEGER) <=
          selectRecentLimit,
      ).length,
      pnl: selectedWhaleSelectionRows.filter(
        (row) =>
          (coerceRank(row.rank_pnl) ?? Number.MAX_SAFE_INTEGER) <=
          selectPnlLimit,
      ).length,
      signals: selectedWhaleSelectionRows.filter(
        (row) =>
          (coerceRank(row.rank_signal) ?? Number.MAX_SAFE_INTEGER) <=
          selectSignalsLimit,
      ).length,
      multiSource: selectedWhaleSelectionRows.filter(
        (row) => row.source_hits >= 2,
      ).length,
    };
    console.log("[whale-profile] selected wallets", {
      candidates: whaleSelectionRows.length,
      count: selectedWhaleSelectionRows.length,
      pinnedCoverage,
      sourceCoverage,
      sample: selectedWhaleSelectionRows.slice(0, 5).map((row) => ({
        walletId: row.id,
        sourceHits: row.source_hits,
        rankTrackerRecent: row.rank_tracker_recent,
        rankTrackerPnl: row.rank_tracker_pnl,
        rankTrackerWinRate: row.rank_tracker_win_rate,
        rankRecent: row.rank_recent,
        rankPnl: row.rank_pnl,
        rankSignal: row.rank_signal,
      })),
    });

    if (selectedWhaleSelectionRows.length === 0) {
      return { processed: 0, updated: 0, skipped: 0, failed: 0 };
    }

    const whaleHydrationMap = await loadWhaleRowsByIds(client, {
      walletIds: selectedWhaleSelectionRows.map((row) => row.id),
      windowDays,
      signalsWindowHours,
    });
    const selectedWhaleRows: WhaleRow[] = selectedWhaleSelectionRows
      .map((row) => {
        const hydration = whaleHydrationMap.get(row.id);
        if (!hydration) return null;
        return {
          ...hydration,
          ...row,
        };
      })
      .filter((row): row is WhaleRow => row != null);

    if (selectedWhaleRows.length === 0) {
      return { processed: 0, updated: 0, skipped: 0, failed: 0 };
    }

    const whaleIds = selectedWhaleRows.map((row) => row.id);
    let recentSummaryMap = new Map<string, WalletActivitySummary>();
    try {
      recentSummaryMap = await fetchWalletActivitySummaries(client, whaleIds, {
        windowHours: recentWindowHours,
        topChanges: recentTopChanges,
        baselineDays: windowDays,
      });
      console.log("[whale-profile] recent summary loaded", {
        wallets: whaleIds.length,
        summarized: recentSummaryMap.size,
        windowHours: recentWindowHours,
      });
    } catch (error) {
      console.warn("[whale-profile] recent summary failed", { error });
    }
    let signalSummaryMap = new Map<string, WalletActivitySignalSummary>();
    try {
      signalSummaryMap = await fetchWalletActivitySignalSummary(
        client,
        whaleIds,
        {
          windowHours: profileSignalsWindowHours,
          baselineDays: windowDays,
          topChanges: recentTopChanges,
        },
      );
      console.log("[whale-profile] signal summary loaded", {
        wallets: whaleIds.length,
        summarized: signalSummaryMap.size,
        windowHours: profileSignalsWindowHours,
      });
    } catch (error) {
      console.warn("[whale-profile] signal summary failed", { error });
    }
    const marketRows = await client.query<WhaleMarketRow>(
      `
        with latest_snapshots as (
          select
            ws.wallet_id,
            ws.venue,
            max(ws.snapshot_at) as snapshot_at
          from wallet_position_snapshots ws
          where ws.wallet_id = any($1::uuid[])
          group by ws.wallet_id, ws.venue
        ),
        recent_activity as (
          select
            wa.wallet_id,
            wa.market_id,
            wa.venue,
            sum(wa.size_usd) as recent_volume_usd,
            count(*)::int as recent_activity_count,
            max(wa.occurred_at) as recent_last_activity_at,
            case
              when sum(wa.delta_shares) is null or sum(wa.delta_shares) = 0
                then null
              else sum(wa.price * wa.delta_shares) / nullif(sum(wa.delta_shares), 0)
            end as recent_avg_price
          from wallet_activity_events wa
          where wa.wallet_id = any($1::uuid[])
            and wa.activity_type in ('delta', 'trade', 'holder')
            and wa.occurred_at >= now() - ($2::text || ' days')::interval
          group by wa.wallet_id, wa.market_id, wa.venue
        ),
        current_rows as (
          select
            ws.wallet_id,
            ws.market_id,
            ws.venue,
            ws.snapshot_at,
            upper(coalesce(ws.outcome_side, '')) as normalized_outcome_side,
            ws.shares,
            ws.size_usd,
            ws.price
          from wallet_position_snapshots ws
          join latest_snapshots ls
            on ls.wallet_id = ws.wallet_id
           and ls.venue = ws.venue
           and ls.snapshot_at = ws.snapshot_at
          where ws.wallet_id = any($1::uuid[])
            and ws.shares > 0
        )
        select
          cr.wallet_id,
          cr.market_id,
          um.event_id,
          um.title as market_title,
          um.outcomes,
          ue.title as event_title,
          cr.venue,
          um.category,
          um.status,
          um.close_time,
          um.expiration_time,
          um.resolved_outcome,
          max(cr.snapshot_at) as snapshot_at,
          ra.recent_volume_usd,
          coalesce(ra.recent_activity_count, 0)::int as recent_activity_count,
          ra.recent_last_activity_at,
          ra.recent_avg_price,
          um.best_bid,
          um.best_ask,
          um.last_price,
          case
            when bool_or(cr.normalized_outcome_side = 'YES')
             and bool_or(cr.normalized_outcome_side = 'NO')
              then 'BOTH'
            when bool_or(cr.normalized_outcome_side = 'YES')
              then 'YES'
            when bool_or(cr.normalized_outcome_side = 'NO')
              then 'NO'
            else null
          end as position_side,
          bool_or(cr.normalized_outcome_side = 'YES') as has_yes_position,
          bool_or(cr.normalized_outcome_side = 'NO') as has_no_position,
          sum(cr.shares) as position_shares,
          sum(cr.size_usd) as position_value_usd,
          case
            when bool_or(cr.normalized_outcome_side = 'YES')
             and bool_or(cr.normalized_outcome_side = 'NO')
              then null
            else max(cr.price)
          end as position_price,
          sum(case when cr.normalized_outcome_side = 'YES' then cr.shares else 0 end) as yes_position_shares,
          sum(case when cr.normalized_outcome_side = 'YES' then cr.size_usd else 0 end) as yes_position_value_usd,
          max(case when cr.normalized_outcome_side = 'YES' then cr.price end) as yes_position_price,
          sum(case when cr.normalized_outcome_side = 'NO' then cr.shares else 0 end) as no_position_shares,
          sum(case when cr.normalized_outcome_side = 'NO' then cr.size_usd else 0 end) as no_position_value_usd,
          max(case when cr.normalized_outcome_side = 'NO' then cr.price end) as no_position_price
        from current_rows cr
        left join unified_markets um on um.id = cr.market_id
        left join unified_events ue on ue.id = um.event_id
        left join recent_activity ra
          on ra.wallet_id = cr.wallet_id
         and ra.market_id = cr.market_id
         and ra.venue = cr.venue
        group by
          cr.wallet_id,
          cr.market_id,
          um.event_id,
          um.title,
          um.outcomes,
          ue.title,
          cr.venue,
          um.category,
          um.status,
          um.close_time,
          um.expiration_time,
          um.resolved_outcome,
          ra.recent_volume_usd,
          ra.recent_activity_count,
          ra.recent_last_activity_at,
          ra.recent_avg_price,
          um.best_bid,
          um.best_ask,
          um.last_price
        order by
          cr.wallet_id,
          sum(cr.size_usd) desc nulls last,
          sum(cr.shares) desc nulls last,
          coalesce(um.title, cr.market_id) asc
      `,
      [whaleIds, windowDays],
    );
    console.log("[whale-profile] top markets loaded", {
      wallets: whaleIds.length,
      rows: marketRows.rows.length,
      marketLimit,
      windowDays,
    });

    const marketMap = new Map<string, WhaleMarketRow[]>();
    for (const row of marketRows.rows) {
      const list = marketMap.get(row.wallet_id) ?? [];
      list.push(row);
      marketMap.set(row.wallet_id, list);
    }

    const existingRows = await client.query<{
      wallet_id: string;
      features_hash: string;
      version: string;
      profile: unknown;
    }>(
      `
        select wallet_id, features_hash, version, profile
        from wallet_profiles
        where wallet_id = any($1::uuid[])
      `,
      [whaleIds],
    );
    const existingMap = new Map<string, ExistingWhaleProfileState>();
    for (const row of existingRows.rows) {
      existingMap.set(row.wallet_id, parseStoredWhaleProfileState(row));
    }

    let processed = 0;
    let updated = 0;
    let skipped = 0;
    let failed = 0;

    for (const [index, whale] of selectedWhaleRows.entries()) {
      processed += 1;
      if (verbose) {
        console.log("[whale-profile] wallet start", {
          index: index + 1,
          total: selectedWhaleRows.length,
          walletId: whale.id,
          chain: whale.chain,
          sourceHits: whale.source_hits,
          rankTrackerRecent: whale.rank_tracker_recent,
          rankTrackerPnl: whale.rank_tracker_pnl,
          rankTrackerWinRate: whale.rank_tracker_win_rate,
          rankRecent: whale.rank_recent,
          rankPnl: whale.rank_pnl,
          rankSignal: whale.rank_signal,
        });
      }
      const currentMarkets = marketMap.get(whale.id) ?? [];
      const recentSummary = recentSummaryMap.get(whale.id) ?? null;
      const [
        categoryMix,
        entryBracketStats,
        performance30d,
        closedPositionsSample,
        signalExamples,
      ] = await Promise.all([
        loadWalletCategoryMix(client, whale.id, windowDays),
        loadWalletEntryBracketStats(client, whale.id, windowDays),
        loadWalletPerformance30dSummary(client, whale.id),
        loadWalletResolvedPositionSamples(client, whale.id, 5),
        fetchWalletActivitySignalRowsFast(client, [whale.id], {
          windowHours: profileSignalsWindowHours,
          baselineDays: windowDays,
          topChanges: recentTopChanges,
          limit: 3,
        }),
      ]);
      const input = buildProfileInput(whale, currentMarkets, {
        marketLimit,
        windowDays,
        recentSummary,
        recentWindowHours,
        recentTopChanges,
        styleGuide: policy.styleGuide,
        categoryMix,
        entryBracketStats,
        performance30d,
        signalSummary: signalSummaryMap.get(whale.id) ?? null,
        signalExamples,
        closedPositionsSample,
      });
      const featuresHash = hashProfileInput(input);
      const existing = existingMap.get(whale.id);
      const namingSignature = computeProfileNamingSignature(input);
      if (
        !options.force &&
        existing?.featuresHash === featuresHash &&
        existing.version === effectiveProfileVersion
      ) {
        skipped += 1;
        if (verbose) {
          console.log("[whale-profile] wallet skipped (unchanged)", {
            walletId: whale.id,
          });
        } else if (processed % logEvery === 0) {
          console.log("[whale-profile] progress", {
            processed,
            total: selectedWhaleRows.length,
            updated,
            skipped,
            failed,
          });
        }
        continue;
      }

      const system =
        "You write short, factual trader archetype profiles for a prediction market product. The output should read like a clean intelligence brief: concise, analytical, human-readable, and fast to scan. Use simple English, avoid hype and filler, and return strict JSON only.";
      const namingStabilityHint = existing?.profile?.label_short
        ? `\nCurrent stored profile hint:
- previous_label_short: ${JSON.stringify(existing.profile.label_short)}
- previous_label_long: ${JSON.stringify(existing.profile.label_long ?? null)}
- previous_naming_signature: ${JSON.stringify(existing.namingSignature)}
- current_naming_signature: ${JSON.stringify(namingSignature)}

Naming stability rule:
- If the current naming signature matches the previous naming signature, keep previous_label_short unless wallet.source_label_quality is "descriptive" and the source label should anchor the name.
- If previous_naming_signature is missing, prefer keeping previous_label_short unless the current behavior clearly no longer fits it.
- Rename only when the trading pattern materially changed.\n`
        : "";
      const user = `Create a compact whale profile for a tracker UI.
Output JSON with:
- label_short: short trader archetype title (target <= 36 chars, hard max 56).
  Prefer 2 to 4 words.
  It should sound like a human trader archetype or desk nickname, not a robotic taxonomy label.
  It must read like one clean name, not a list of traits.
  Do not write comma-separated labels or stacked descriptors.
  Never use parentheses in label_short.
  Never mention wallet structure or custody words in label_short, including Safe, Gnosis, multisig, wallet, signer, owner, EOA, contract, or chain labels.
  Bad example: "NBA whale, often late, mixed sides".
  If wallet.source_label_quality is "descriptive" and wallet.source_label exists, keep label_short close to that source label instead of inventing a persona name.
  If wallet.source_label_quality is "generic" or "missing", create a concise descriptive alias from the trading pattern.
  Avoid awkward words like accumulator, scalper, bettor, mixed buyer, participant, and diversified unless truly necessary.
  Avoid broad template names that many unrelated wallets could share, like "Late Sports Trader", "Politics NO Trader", or "Crypto Whale".
  If a draft name feels generic, add one concrete hook from the actual behavior: theme, timing, side, market type, or recurring setup.
  Slight edge, mild slang, or light irony is allowed if it still feels clean and readable.
  Avoid hype, memes, jokes, mascots, fantasy nicknames, and robotic wording.
  Good styles: "Fed Fade Trader", "Iran Deadline NO", "Late Tennis Fade", "Tariff Headline Buyer", "Oil Spike Chaser".
  Bad styles: "High-odds NO accumulator (diversified)", "Late Sports Trader", "Politics NO Trader", "Crypto Whale", "Sports markets trader with late entries", "Mixed-sided high-frequency participant".
- label_long: exactly 1 short sentence (target <= 140 chars, hard max 200).
  This is the lead sentence shown above the trader bullets.
  It should explain what kind of trader this is in plain language.
  Keep it compact, direct, and useful in one read.
- archetype: short snake_case tag.
- categories: array of 1–3 from [politics, crypto, sports, economics, technology, entertainment, weather, health, mentions, other].
- theme_focus: array of up to 3 lowercase tags.
- risk_style: short phrase (target <= 54 chars, hard max 96).
- confidence: number 0–1.
- evidence: array of 2–4 short market or event titles (prefer event titles if multiple markets share the same event).
- notes: multiline string with exactly 4 bullet lines for the detail view.
  Each line must start with "- ".
  The 4 bullets must answer, in order:
  1. market focus
  2. entry style or timing
  3. positioning style
  4. notable recurring pattern, if relevant
  Keep each bullet short, distinct, and easy to scan.
  Do not repeat the same idea across bullets.
  Do not use numbering inside the bullets.
  Do not use parentheses unless truly necessary.
  Avoid percentages, exact metrics, and stat-heavy phrasing unless essential.
  Do not make the bullets read like a metrics dump or a blockchain explorer.

Rules:
- Use ONLY provided data. Do NOT mention wallet IDs or addresses.
- No claims of insider or informed intent.
- Be factual, pattern-based, and neutral in tone.
- Write for a trader-facing product UI, not a blockchain explorer.
- Use plain English. If a technical term can be replaced by a simpler phrase, replace it.
- Do not use desk jargon or compressed analyst language.
- Avoid phrases like "implied probability band", "cluster", "two-sided hedging", "directional positioning", "notional", "posture", or "80-100 band" unless there is no simpler wording.
- Prefer phrases like "very likely outcomes", "big positions", "mostly bets one way", "buys both sides to reduce risk", "Fed-related markets", and "often trades near major events".
- Write like a clear product intelligence brief, not a marketer.
- Avoid clutter like "(often near 99%)", long qualifiers, or stacked caveats.
- Avoid vague filler like "mixed activity", "shows some exposure", or "participates across markets" unless it adds real meaning.
- Make the wording feel natural when rendered as one short sentence plus 4 bullets in a UI card.
- If data is limited or mixed, keep confidence <= 0.55 and mention uncertainty.
- Stay comfortably below the hard limits; exact character counting is approximate.
- Prioritize immediate reader understanding over exhaustive detail.
- If activity kind is "holder" (no trades), emphasize exposure/holdings vs trade timing.
- If most top markets are resolved or ended, mention that the pattern is historical.
- Exposure fields:
  - exposure.gross_usd is total tracked gross exposure.
  - exposure.net_imbalance_usd is directional exposure after offsetting opposite-side positions.
  - exposure.hedged_notional_usd is the offsetting notional paired across opposite sides.
  - exposure.hedge_ratio is 0..1 and shows how much of gross exposure is hedged.
  - exposure.two_sided_markets counts markets with both sides held.
- Do not describe a wallet as strongly bullish or bearish from gross exposure alone.
- If exposure.posture is partially_hedged or heavily_hedged, say that the wallet buys both sides or balances risk. Avoid hedge jargon if a simpler phrase works.
- If net imbalance is much smaller than gross exposure, emphasize balanced activity over one-way conviction.
- current_portfolio summarizes the full current tracked portfolio.
  - current_portfolio.market_count_total is the total number of currently held markets.
  - current_portfolio.top_markets_gross_usd is the gross value represented by top_markets.
  - current_portfolio.omitted_market_count and omitted_gross_usd describe the held tail not listed in top_markets.
- category_mix is the 30d traded-volume mix by canonical category.
- entry_brackets describes where this wallet tends to enter positions, grouped by price/likelihood ranges.
- metrics.pnl_30d is current 30d trade-ledger PnL.
- metrics.avg_trade_usd is average observed 30d trade/change size.
- metrics.pnl_to_volume_ratio shows whether PnL is large or tiny relative to 30d volume.
- performance_context gives direct PnL context:
  - current_marked_pnl is the latest marked PnL snapshot.
  - portfolio_change_30d is the 30d change in marked PnL from start to end.
  - trade_pnl_30d and trade_roi_30d describe the current 30d trade ledger.
  Use these to understand magnitude and swings, but do not turn the profile into a metrics dump.
- positioning_context summarizes current book shape:
  - avg_open_position_usd and largest_position_usd show position sizing.
  - weighted_avg_held_odds and high_probability_exposure_share show whether the wallet mostly holds likely outcomes.
- performance_30d summarizes the 30d PnL/ROI path.
  - delta_* shows change across the 30d window.
  - min_* and max_* show the range inside the window.
  - points is a compressed chart sample for trend direction only.
- signals.summary describes recent unusual/late/reactivation behavior.
- signals.examples are the strongest recent signal rows.
- closed_positions_sample are recent ended/resolved examples. Use them to talk about historical behavior, not current exposure.
- recent_window summarizes the last recent_window.window_hours hours.
  Use it to explain timing behavior or what changed recently,
  but treat it as secondary to the broader 30d pattern.
- recent_window.top_changes are already aggregated per market/outcome;
  avoid repeating identical markets.
- top_markets are the largest current held positions, ordered by current gross value.
- Use real outcome labels whenever they are provided:
  - top_markets.position_label, top_markets.yes_label, and top_markets.no_label map YES/NO to the actual market labels.
  - signals.examples.position_label and recent_window.top_changes.position_label do the same for recent activity.
  - Prefer those labels over raw YES/NO when they are present and not generic placeholders.
- top_events are rolled up from current held positions, not from recent traded volume.
- Price fields:
  - top_markets.last_yes_price is the latest tracked YES-side market price field.
    Treat it as the current market price field, not necessarily the last executed trade.
  - top_markets.held_odds is the side-aware price (YES/NO) for the held position.
    It is null when top_markets.position_side is BOTH.
  - top_changes.odds is also side-aware for the change row.
- Recent activity fields:
  - top_markets.recent_activity.last_activity_at is the latest recent wallet activity timestamp for that held market.
  - top_markets.recent_activity.volume_usd and top_markets.recent_activity.activity_count describe recent wallet activity on that held market.
- Position fields:
  - top_markets.position_side can be YES, NO, or BOTH.
  - BOTH means the wallet currently holds both YES and NO in that market.
  - top_markets.position_value_usd is gross value across held sides.
  - top_markets.yes_position_value_usd and no_position_value_usd split the market by side.
  - Never rewrite a BOTH market as a single YES or single NO position.
- Wallet type/roles:
  - wallet.kind: "eoa" (normal), "safe" (Gnosis Safe multisig), "contract" (other contract), or "unknown".
  - wallet.role: "trading_wallet" for the wallet holding positions.
  - wallet.owner_role: "signer_wallet" when the owner address controls a Safe.
  - These fields are context only. Never put Safe, Gnosis, multisig, signer, owner, or wallet-type terms into label_short.
- Naming:
  - If wallet.source_label_quality is "descriptive", preserve the semantics of wallet.source_label.
  - Do not replace a meaningful existing label with a completely unrelated nickname.
  - If label_short sounds like metadata tags, analyst shorthand, a broad template, or a list of traits instead of a natural archetype name, rewrite it.
  - If another unrelated wallet could easily end up with the same label_short, rewrite it to be more specific.
- Prefer evidence from top_events when available; fall back to top_markets or recent_window.top_changes.
- Use summary.side_bias_label and summary.concentration_label as hints.
- If exposure.two_sided_markets > 0 or any top market has position_side = BOTH, explain it simply as buying both sides or balancing risk unless one side is clearly negligible.
- If signals.summary or signals.examples indicate late entry, reactivation, or unusual behavior, mention that carefully as observed trading behavior, not intent.
- Use category_mix plus top_events/top_markets to describe thematic focus.
- Use entry_brackets and held_odds to describe entry style in simple language, for example "usually buys when the outcome already looks very likely" or "usually buys lower-probability outcomes".
- Prefer simple phrases like "focuses on", "usually buys", "often trades around", and "style is".
- When performance_30d and closed_positions_sample are sparse or mixed, say so.
- Target style example:
  - label_short: "Fed Fade Trader"
  - label_long: "Macro-focused trader who often leans against consensus in Fed-related markets."
  - notes:
    - Focuses mostly on Fed and rate-related markets.
    - Often enters around major macro headlines or meeting windows.
    - Usually takes one-way positions rather than balancing both sides.
    - Tends to repeat the same macro setup across related contracts.
- Style guide: ${policy.styleGuide}
- Profile revision: ${effectiveProfileVersion}
- Never suggest insider information.
${namingStabilityHint}

Whale data (JSON):\n${JSON.stringify(input)}`;
      const compactUser = `${user}

Extra constraint: Keep label_short and label_long compact. Keep notes to exactly 4 concise bullet lines. Before returning JSON, verify that label_short sounds like a natural trader archetype, not a comma-separated trait list, metadata tags, analyst shorthand, or a broad template; label_short contains no parentheses and no Safe/Gnosis/multisig wording; label_long is exactly one sentence; each bullet covers a different angle; and the wording avoids numeric clutter unless essential.`;

      let profileRaw = "";
      try {
        profileRaw = await callOpenRouter(
          policy.model,
          [
            { role: "system", content: system },
            { role: "user", content: user },
          ],
          policy.maxTokens,
        );
      } catch (error) {
        failed += 1;
        console.warn("[whale-profile] openrouter error", {
          walletId: whale.id,
          address: whale.address,
          error,
        });
        if (!verbose && processed % logEvery === 0) {
          console.log("[whale-profile] progress", {
            processed,
            total: selectedWhaleRows.length,
            updated,
            skipped,
            failed,
          });
        }
        continue;
      }

      let parsed = parseProfileJson(profileRaw);
      if (!parsed) {
        try {
          profileRaw = await callOpenRouter(
            policy.model,
            [
              { role: "system", content: system },
              { role: "user", content: compactUser },
            ],
            policy.maxTokensFallback,
          );
          parsed = parseProfileJson(profileRaw);
        } catch (error) {
          failed += 1;
          console.warn("[whale-profile] openrouter retry failed", {
            walletId: whale.id,
            address: whale.address,
            error,
          });
          if (!verbose && processed % logEvery === 0) {
            console.log("[whale-profile] progress", {
              processed,
              total: selectedWhaleRows.length,
              updated,
              skipped,
              failed,
            });
          }
          continue;
        }
      }

      let normalized = normalizeWhaleProfile(parsed);
      if (!normalized) {
        failed += 1;
        console.warn("[whale-profile] invalid json", {
          walletId: whale.id,
          address: whale.address,
          raw: profileRaw.slice(0, 500),
        });
        if (!verbose && processed % logEvery === 0) {
          console.log("[whale-profile] progress", {
            processed,
            total: selectedWhaleRows.length,
            updated,
            skipped,
            failed,
          });
        }
        continue;
      }

      if (isGenericProfileLabelShort(normalized.label_short, input)) {
        normalized = {
          ...normalized,
          label_short: resolveFallbackProfileLabelShort(input),
        };
      }

      if (
        shouldPreserveExistingProfileLabelShort(
          existing,
          input,
          namingSignature,
        )
      ) {
        normalized = {
          ...normalized,
          label_short:
            normalizeText(existing?.profile?.label_short) ??
            normalized.label_short,
        };
      }

      if (!normalized.categories || normalized.categories.length === 0) {
        const derivedCategories = deriveCategoriesFromInput(
          input,
          normalized.theme_focus,
        );
        if (derivedCategories.length > 0) {
          normalized = { ...normalized, categories: derivedCategories };
        }
      }

      if (options.dryRun) {
        updated += 1;
        if (verbose) {
          console.log("[whale-profile] wallet dry-run update", {
            walletId: whale.id,
            markets: currentMarkets.length,
          });
        } else if (processed % logEvery === 0) {
          console.log("[whale-profile] progress", {
            processed,
            total: selectedWhaleRows.length,
            updated,
            skipped,
            failed,
          });
        }
        continue;
      }

      await client.query(
        `
          insert into wallet_profiles (
            wallet_id,
            profile,
            features_hash,
            model,
            version
          )
          values ($1, $2, $3, $4, $5)
          on conflict (wallet_id)
          do update set
            profile = excluded.profile,
            features_hash = excluded.features_hash,
            model = excluded.model,
            version = excluded.version,
            updated_at = now()
        `,
        [
          whale.id,
          JSON.stringify({
            ...normalized,
            _naming_signature: namingSignature,
          }),
          featuresHash,
          policy.model,
          effectiveProfileVersion,
        ],
      );
      updated += 1;
      if (verbose) {
        console.log("[whale-profile] wallet updated", {
          walletId: whale.id,
          markets: currentMarkets.length,
        });
      } else if (processed % logEvery === 0) {
        console.log("[whale-profile] progress", {
          processed,
          total: selectedWhaleRows.length,
          updated,
          skipped,
          failed,
        });
      }
    }

    return { processed, updated, skipped, failed };
  } finally {
    client.release();
  }
}

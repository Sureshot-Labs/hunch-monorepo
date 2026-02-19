import crypto from "node:crypto";

import { pool } from "../db.js";
import { env } from "../env.js";
import { isRecord } from "../lib/type-guards.js";
import type { AiWhaleProfilesPolicy } from "./runtime-policies.js";
import {
  fetchWalletActivitySummaries,
  type WalletActivitySummary,
} from "./wallet-activity-summary.js";

const PROFILE_VERSION = "v3";
const CATEGORY_VALUES = [
  "sports",
  "politics",
  "crypto",
  "finance",
  "entertainment",
  "tech",
  "macro",
  "social",
  "other",
] as const;

type WhaleCategory = (typeof CATEGORY_VALUES)[number];

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
    address: string;
    chain: string;
    label: string | null;
    owner_address: string | null;
    owner_label: string | null;
    kind: "eoa" | "safe" | "contract" | "unknown";
    role: "trading_wallet" | "signer_wallet" | "unknown";
    owner_role: "signer_wallet" | "unknown";
  };
  metrics: {
    volume_30d: number | null;
    trades_30d: number | null;
    roi: number | null;
    win_rate: number | null;
    last_trade_at: string | null;
  };
  inferred: {
    win_rate: number | null;
    resolved_count: number | null;
  };
  exposure_usd: number | null;
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
  top_events: Array<{
    event_title: string;
    total_volume_usd: number | null;
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
      event_title: string | null;
      venue: string;
      category: string | null;
      market_status: string | null;
      resolved_outcome: string | null;
      action: string | null;
      position_side: string | null;
      delta_usd: number | null;
      odds: number | null;
      labels: string[];
      occurred_at: string | null;
    }>;
  };
  top_markets: Array<{
    market_id: string;
    market_title: string | null;
    event_title: string | null;
    venue: string;
    category: string | null;
    status: string | null;
    close_time: string | null;
    expiration_time: string | null;
    resolved_outcome: string | null;
    is_active: boolean;
    volume_usd: number | null;
    activity_count: number;
    last_activity_at: string | null;
    avg_price: number | null;
    best_bid: number | null;
    best_ask: number | null;
    last_yes_price: number | null;
    held_odds: number | null;
    position_side: string | null;
    position_shares: number | null;
    position_value_usd: number | null;
    position_price: number | null;
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
  whale_score: string | null;
  signal_abs_usd: string | null;
  last_activity_at: Date | null;
  has_trade_activity: boolean | null;
  has_holder_activity: boolean | null;
  inferred_wins: number | null;
  inferred_total: number | null;
  rank_recent: number | null;
  rank_pnl: number | null;
  rank_signal: number | null;
  source_hits: number;
};

type WhaleMarketRow = {
  wallet_id: string;
  market_id: string;
  market_title: string | null;
  event_title: string | null;
  venue: string;
  category: string | null;
  status: string | null;
  close_time: Date | null;
  expiration_time: Date | null;
  resolved_outcome: string | null;
  volume_usd: string | null;
  activity_count: number;
  last_activity_at: Date | null;
  avg_price: string | null;
  best_bid: string | null;
  best_ask: string | null;
  last_price: string | null;
  position_side: string | null;
  position_shares: string | null;
  position_value_usd: string | null;
  position_price: string | null;
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

const parseNumber = (value: string | number | null | undefined): number | null => {
  if (value == null) return null;
  const num = typeof value === "string" ? Number(value) : value;
  return Number.isFinite(num) ? num : null;
};

const USD_BUCKETS = [
  100,
  1_000,
  10_000,
  100_000,
  1_000_000,
  10_000_000,
  100_000_000,
  1_000_000_000,
] as const;

const COUNT_BUCKETS = [
  1,
  2,
  5,
  10,
  25,
  50,
  100,
  250,
  500,
  1_000,
  2_500,
  5_000,
] as const;

const UNUSUAL_BUCKETS = [1, 2, 5, 10, 20, 50] as const;

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
        event_title: null,
        venue: "summary",
        category: null,
        market_status: null,
        resolved_outcome: null,
        action: null,
        position_side: null,
        delta_usd: bucketCount(recent.top_changes.length),
        odds: null,
        labels: [],
        occurred_at: null,
      },
    ],
  };

  return {
    ...input,
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

function normalizeProfile(raw: unknown): WhaleProfile | null {
  if (!isRecord(raw)) return null;
  const labelShort =
    typeof raw.label_short === "string" ? raw.label_short.trim() : null;
  const labelLong =
    typeof raw.label_long === "string" ? raw.label_long.trim() : null;
  const archetype =
    typeof raw.archetype === "string" ? raw.archetype.trim() : null;
  const categories = normalizeCategoryList(raw.categories);
  const riskStyle =
    typeof raw.risk_style === "string" ? raw.risk_style.trim() : null;
  const notes = typeof raw.notes === "string" ? raw.notes.trim() : null;
  const confidenceRaw = raw.confidence;
  const confidence =
    typeof confidenceRaw === "number"
      ? clampNumber(confidenceRaw, 0, 1)
      : null;
  const themeFocus = Array.isArray(raw.theme_focus)
    ? raw.theme_focus
        .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
        .filter((entry) => entry.length > 0)
    : [];
  const evidence = Array.isArray(raw.evidence)
    ? raw.evidence
        .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
        .filter((entry) => entry.length > 0)
    : [];

  return {
    ...(labelShort ? { label_short: labelShort } : {}),
    ...(labelLong ? { label_long: labelLong } : {}),
    ...(archetype ? { archetype } : {}),
    ...(categories.length ? { categories } : {}),
    ...(themeFocus.length ? { theme_focus: themeFocus } : {}),
    ...(riskStyle ? { risk_style: riskStyle } : {}),
    ...(confidence != null ? { confidence } : {}),
    ...(evidence.length ? { evidence } : {}),
    ...(notes ? { notes } : {}),
  };
}

function parseProfileJson(raw: string): unknown | null {
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

function mapCategory(raw: string): WhaleCategory | null {
  const key = raw.trim().toLowerCase();
  if (!key) return null;
  if (key.includes("sport")) return "sports";
  if (key.includes("politic") || key.includes("election") || key.includes("geopolit")) {
    return "politics";
  }
  if (key.includes("crypto") || key.includes("blockchain") || key.includes("web3")) {
    return "crypto";
  }
  if (key.includes("macro") || key.includes("rates") || key.includes("fed")) {
    return "macro";
  }
  if (
    key.includes("finance") ||
    key.includes("econom") ||
    key.includes("stocks") ||
    key.includes("equities") ||
    key.includes("markets")
  ) {
    return "finance";
  }
  if (key.includes("entertain") || key.includes("culture") || key.includes("celebrity") || key.includes("music")) {
    return "entertainment";
  }
  if (key.includes("tech") || key.includes("ai") || key.includes("software")) {
    return "tech";
  }
  if (key.includes("social") || key.includes("twitter") || key.includes("tweets")) {
    return "social";
  }
  if (CATEGORY_VALUES.includes(key as WhaleCategory)) return key as WhaleCategory;
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
  if (lastYesPrice == null || !Number.isFinite(lastYesPrice) || !side) return null;
  const normalized = side.toUpperCase();
  if (normalized === "YES") return lastYesPrice;
  if (normalized === "NO") return 1 - lastYesPrice;
  return null;
}

async function callOpenRouter(
  model: string,
  messages: Array<{ role: "system" | "user"; content: string }>,
  maxTokens: number,
): Promise<string> {
  if (!env.openRouterKey) {
    throw new Error("OPENROUTER_API_KEY missing");
  }

  const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
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
  });

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

function buildProfileInput(
  wallet: WhaleRow,
  topMarkets: WhaleMarketRow[],
  context: {
    marketLimit: number;
    windowDays: number;
    recentSummary: WalletActivitySummary | null;
    recentWindowHours: number;
    recentTopChanges: number;
    styleGuide: string;
  },
): WhaleProfileInput {
  const now = Date.now();
  const markets = topMarkets.map((market) => {
    const closeTime = market.close_time ? market.close_time.toISOString() : null;
    const expirationTime = market.expiration_time
      ? market.expiration_time.toISOString()
      : null;
    const resolved = Boolean(market.resolved_outcome);
    const status = market.status?.toUpperCase();
    const hasEndedStatus = status != null && status !== "ACTIVE";
    const endTimestamp = closeTime ?? expirationTime;
    const endTimeMs = endTimestamp ? new Date(endTimestamp).getTime() : null;
    const endedByTime = endTimeMs != null && endTimeMs < now;
    const isActive = !(resolved || hasEndedStatus || endedByTime);

    return {
      market_id: market.market_id,
      market_title: market.market_title,
      event_title: market.event_title,
      venue: market.venue,
      category: market.category,
      status: market.status,
      close_time: closeTime,
      expiration_time: expirationTime,
      resolved_outcome: market.resolved_outcome,
      is_active: isActive,
      volume_usd: parseNumber(market.volume_usd),
      activity_count: market.activity_count,
      last_activity_at: market.last_activity_at
        ? market.last_activity_at.toISOString()
        : null,
      avg_price: parseNumber(market.avg_price),
      best_bid: parseNumber(market.best_bid),
      best_ask: parseNumber(market.best_ask),
      last_yes_price: parseNumber(market.last_price),
      held_odds: resolveHeldOdds(
        market.position_side,
        parseNumber(market.position_price),
        parseNumber(market.last_price),
      ),
      position_side: market.position_side,
      position_shares: parseNumber(market.position_shares),
      position_value_usd: parseNumber(market.position_value_usd),
      position_price: parseNumber(market.position_price),
    };
  });

  const totalVolume = markets.reduce(
    (sum, market) => sum + (market.volume_usd ?? 0),
    0,
  );
  const topVolume = markets[0]?.volume_usd ?? null;
  const concentration =
    topVolume != null && totalVolume > 0 ? topVolume / totalVolume : null;

  let yesValue = 0;
  let noValue = 0;
  for (const market of markets) {
    const value =
      market.position_value_usd ??
      market.position_shares ??
      market.volume_usd ??
      0;
    if (market.position_side?.toUpperCase() === "YES") {
      yesValue += value;
    } else if (market.position_side?.toUpperCase() === "NO") {
      noValue += value;
    }
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

  const concentrationLabel: WhaleProfileInput["summary"]["concentration_label"] =
    concentration == null
      ? "unknown"
      : concentration >= 0.6
        ? "high"
        : concentration >= 0.3
          ? "medium"
          : "low";

  const categoryCounts = markets.reduce<Record<string, number>>((acc, market) => {
    const category = market.category?.trim();
    if (!category) return acc;
    acc[category] = (acc[category] ?? 0) + 1;
    return acc;
  }, {});

  const marketStateCounts = markets.reduce(
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
      if (closeAt && new Date(closeAt).getTime() < now) {
        acc.ended += 1;
        return acc;
      }
      acc.active += 1;
      return acc;
    },
    { active: 0, ended: 0, resolved: 0 },
  );

  const eventRollup = new Map<
    string,
    { title: string; total: number; count: number }
  >();
  for (const market of markets) {
    const rawTitle = market.event_title?.trim() || market.market_title?.trim();
    if (!rawTitle) continue;
    const entry = eventRollup.get(rawTitle) ?? {
      title: rawTitle,
      total: 0,
      count: 0,
    };
    entry.total += market.volume_usd ?? 0;
    entry.count += 1;
    eventRollup.set(rawTitle, entry);
  }
  const topEvents = Array.from(eventRollup.values())
    .sort((a, b) => b.total - a.total)
    .slice(0, 3)
    .map((entry) => ({
      event_title: entry.title,
      total_volume_usd: entry.total || null,
      market_count: entry.count,
    }));

  const walletKind: WhaleProfileInput["wallet"]["kind"] =
    wallet.is_safe ? "safe" : "eoa";
  const walletRole: WhaleProfileInput["wallet"]["role"] = "trading_wallet";
  const ownerRole: WhaleProfileInput["wallet"]["owner_role"] =
    wallet.owner_address ? "signer_wallet" : "unknown";
  const recentSummary = context.recentSummary;
  const recentTopChanges = (recentSummary?.topChanges ?? [])
    .slice(0, context.recentTopChanges)
    .map((change) => ({
      market_title: change.marketTitle ?? null,
      event_title: change.eventTitle ?? null,
      venue: change.venue,
      category: change.category ?? null,
      market_status: change.marketStatus ?? null,
      resolved_outcome: change.resolvedOutcome ?? null,
      action: change.action ?? null,
      position_side: change.positionSide ?? null,
      delta_usd: change.deltaUsd ?? null,
      odds: change.odds ?? null,
      labels: change.labels ?? [],
      occurred_at: change.occurredAt ? change.occurredAt.toISOString() : null,
    }));
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

  return {
    context: {
      purpose: "wallet_whale_profile",
      ui: "Shown in a whale list and a detail modal on the Wallets/Trackers page.",
      top_markets_limit: context.marketLimit,
      window_days: context.windowDays,
      currency: "USD",
      display_notes:
        "Write for end-users. Avoid jargon, avoid market IDs, no insider claims.",
      style_guide: context.styleGuide,
    },
    wallet: {
      address: wallet.address,
      chain: wallet.chain,
      label: wallet.label,
      owner_address: wallet.owner_address,
      owner_label: wallet.owner_label,
      kind: walletKind,
      role: walletRole,
      owner_role: ownerRole,
    },
    metrics: {
      volume_30d: parseNumber(wallet.metrics_volume),
      trades_30d: wallet.metrics_trades ?? null,
      roi: parseNumber(wallet.metrics_roi),
      win_rate: parseNumber(wallet.metrics_win_rate),
      last_trade_at: wallet.metrics_last_trade_at
        ? wallet.metrics_last_trade_at.toISOString()
        : null,
    },
    inferred: {
      win_rate:
        wallet.inferred_total && wallet.inferred_total > 0
          ? (wallet.inferred_wins ?? 0) / wallet.inferred_total
          : null,
      resolved_count:
        wallet.inferred_total != null ? Number(wallet.inferred_total) : null,
    },
    exposure_usd: parseNumber(wallet.exposure_usd),
    activity: {
      last_activity_at: wallet.last_activity_at
        ? wallet.last_activity_at.toISOString()
        : null,
      kind: toActivityKind(
        wallet.has_trade_activity,
        wallet.has_holder_activity,
      ),
    },
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
      market_state_counts: marketStateCounts,
    },
    top_events: topEvents,
    recent_window: recentWindow,
    top_markets: markets,
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
    selectionSignalsLimit: env.aiWhaleProfileSelectionSignalsLimit,
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
  const signalsWindowHours = Math.max(1, policy.selectionSignalsWindowHours);
  let selectRecentLimit = Math.max(0, Math.trunc(policy.selectionRecentLimit));
  let selectPnlLimit = Math.max(0, Math.trunc(policy.selectionPnlLimit));
  let selectSignalsLimit = Math.max(0, Math.trunc(policy.selectionSignalsLimit));
  if (policy.selectionMode === "recent") {
    selectRecentLimit = limit;
    selectPnlLimit = 0;
    selectSignalsLimit = 0;
  } else if (policy.selectionMode === "pnl") {
    selectRecentLimit = 0;
    selectPnlLimit = limit;
    selectSignalsLimit = 0;
  }
  if (
    selectRecentLimit === 0 &&
    selectPnlLimit === 0 &&
    selectSignalsLimit === 0
  ) {
    selectRecentLimit = limit;
  }
  console.log("[whale-profile] selection config", {
    mode: policy.selectionMode,
    limit,
    marketLimit,
    windowDays,
    selectRecentLimit,
    selectPnlLimit,
    selectSignalsLimit,
    signalsWindowHours,
    force: Boolean(options.force),
    dryRun: Boolean(options.dryRun),
    verbose,
    logEvery,
  });
  // Keep recent-window inputs small and stable; hashing is bucketed below.
  const recentWindowHours = 24;
  const recentTopChanges = 3;
  const client = await pool.connect();
  try {
    const whaleRows = await client.query<WhaleRow>(
      `
        with whale_base as (
          select
            w.id,
            w.address,
            w.chain,
            w.label,
            w.last_seen_at,
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
            activity.last_activity_at,
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
          from wallets w
          join wallet_tag_map tm on tm.wallet_id = w.id
          join wallet_tags t on t.id = tm.tag_id and t.slug = 'whale'
          left join lateral (
            select
              s.volume_usd as metrics_volume,
              s.pnl_usd as metrics_pnl,
              s.trades_count as metrics_trades,
              s.roi as metrics_roi,
              s.win_rate as metrics_win_rate,
              s.last_trade_at as metrics_last_trade_at
            from wallet_metrics_snapshots s
            where s.wallet_id = w.id and s.period = '30d'
            order by s.as_of desc
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
              and wa.occurred_at >= now() - ($1::text || ' days')::interval
          ) activity on true
          left join lateral (
            select
              max(coalesce(wah.max_abs_delta_usd, 0)) as signal_abs_usd
            from wallet_activity_hourly wah
            where wah.wallet_id = w.id
              and wah.activity_type in ('delta', 'trade')
              and wah.hour_bucket >= now() - ($6::text || ' hours')::interval
          ) signal on true
          left join lateral (
            select
              sum(coalesce(ws.size_usd, 0)) as exposure_usd
            from wallet_position_snapshots ws
            join (
              select venue, max(snapshot_at) as snapshot_at
              from wallet_position_snapshots
              where wallet_id = w.id
              group by venue
            ) latest on latest.venue = ws.venue and latest.snapshot_at = ws.snapshot_at
            where ws.wallet_id = w.id
          ) exposure on true
          left join lateral (
            select
              w2.address as owner_address,
              w2.label as owner_label
            from wallets w2
            where w.metadata->>'kind' = 'safe'
              and w2.metadata->>'kind' = 'safe_owner'
              and w2.metadata->>'derivedFrom' = w.address
              and w2.chain = w.chain
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
        ),
        recent_ranked as (
          select
            id,
            row_number() over (
              order by last_activity_at desc nulls last, whale_score desc nulls last, last_seen_at desc
            ) as rank_recent
          from whale_base
        ),
        pnl_ranked as (
          select
            id,
            row_number() over (
              order by metrics_pnl desc nulls last, last_activity_at desc nulls last, last_seen_at desc
            ) as rank_pnl
          from whale_base
        ),
        signal_ranked as (
          select
            id,
            row_number() over (
              order by signal_abs_usd desc nulls last, last_activity_at desc nulls last, last_seen_at desc
            ) as rank_signal
          from whale_base
        ),
        candidate_ids as (
          select id from recent_ranked where rank_recent <= $3
          union
          select id from pnl_ranked where rank_pnl <= $4
          union
          select id from signal_ranked where rank_signal <= $5
        )
        select
          wb.id,
          wb.address,
          wb.chain,
          wb.label,
          wb.is_safe,
          wb.owner_address,
          wb.owner_label,
          wb.metrics_volume,
          wb.metrics_pnl,
          wb.metrics_trades,
          wb.metrics_roi,
          wb.metrics_win_rate,
          wb.metrics_last_trade_at,
          wb.exposure_usd,
          wb.whale_score,
          wb.signal_abs_usd,
          wb.last_activity_at,
          wb.has_trade_activity,
          wb.has_holder_activity,
          wb.inferred_wins,
          wb.inferred_total,
          r.rank_recent,
          p.rank_pnl,
          s.rank_signal,
          (
            case when $3 > 0 and r.rank_recent <= $3 then 1 else 0 end +
            case when $4 > 0 and p.rank_pnl <= $4 then 1 else 0 end +
            case when $5 > 0 and s.rank_signal <= $5 then 1 else 0 end
          )::int as source_hits
        from whale_base wb
        join candidate_ids c on c.id = wb.id
        left join recent_ranked r on r.id = wb.id
        left join pnl_ranked p on p.id = wb.id
        left join signal_ranked s on s.id = wb.id
        order by
          (
            case when $3 > 0 and r.rank_recent <= $3 then 1 else 0 end +
            case when $4 > 0 and p.rank_pnl <= $4 then 1 else 0 end +
            case when $5 > 0 and s.rank_signal <= $5 then 1 else 0 end
          ) desc,
          r.rank_recent asc nulls last,
          p.rank_pnl asc nulls last,
          s.rank_signal asc nulls last,
          wb.last_activity_at desc nulls last,
          wb.whale_score desc nulls last,
          wb.last_seen_at desc
        limit $2
      `,
      [
        windowDays,
        limit,
        selectRecentLimit,
        selectPnlLimit,
        selectSignalsLimit,
        signalsWindowHours,
      ],
    );
    const sourceCoverage = {
      recent: whaleRows.rows.filter(
        (row) => row.rank_recent != null && row.rank_recent <= selectRecentLimit,
      ).length,
      pnl: whaleRows.rows.filter(
        (row) => row.rank_pnl != null && row.rank_pnl <= selectPnlLimit,
      ).length,
      signals: whaleRows.rows.filter(
        (row) => row.rank_signal != null && row.rank_signal <= selectSignalsLimit,
      ).length,
      multiSource: whaleRows.rows.filter((row) => row.source_hits >= 2).length,
    };
    console.log("[whale-profile] selected wallets", {
      count: whaleRows.rows.length,
      sourceCoverage,
      sample: whaleRows.rows.slice(0, 5).map((row) => ({
        walletId: row.id,
        chain: row.chain,
        sourceHits: row.source_hits,
        rankRecent: row.rank_recent,
        rankPnl: row.rank_pnl,
        rankSignal: row.rank_signal,
      })),
    });

    if (whaleRows.rows.length === 0) {
      return { processed: 0, updated: 0, skipped: 0, failed: 0 };
    }

    const whaleIds = whaleRows.rows.map((row) => row.id);
    let recentSummaryMap = new Map<string, WalletActivitySummary>();
    try {
      recentSummaryMap = await fetchWalletActivitySummaries(
        client,
        whaleIds,
        {
          windowHours: recentWindowHours,
          topChanges: recentTopChanges,
          baselineDays: windowDays,
        },
      );
      console.log("[whale-profile] recent summary loaded", {
        wallets: whaleIds.length,
        summarized: recentSummaryMap.size,
        windowHours: recentWindowHours,
      });
    } catch (error) {
      console.warn("[whale-profile] recent summary failed", { error });
    }
    const marketRows = await client.query<WhaleMarketRow>(
      `
        select
          ranked.*,
          pos.outcome_side as position_side,
          pos.shares as position_shares,
          pos.size_usd as position_value_usd,
          pos.price as position_price
        from (
          select
            wa.wallet_id,
            wa.market_id,
            um.title as market_title,
            ue.title as event_title,
            wa.venue,
            um.category,
            um.status,
            um.close_time,
            um.expiration_time,
            um.resolved_outcome,
            sum(wa.size_usd) as volume_usd,
            count(*)::int as activity_count,
            max(wa.occurred_at) as last_activity_at,
            case
              when sum(wa.delta_shares) is null or sum(wa.delta_shares) = 0
                then null
              else sum(wa.price * wa.delta_shares) / nullif(sum(wa.delta_shares), 0)
            end as avg_price,
            um.best_bid,
            um.best_ask,
            um.last_price,
            row_number() over (
              partition by wa.wallet_id
              order by sum(wa.size_usd) desc nulls last,
                       count(*) desc,
                       max(wa.occurred_at) desc
            ) as rn
          from wallet_activity_events wa
          left join unified_markets um on um.id = wa.market_id
          left join unified_events ue on ue.id = um.event_id
          where wa.wallet_id = any($1::uuid[])
            and wa.activity_type in ('delta', 'trade', 'holder')
            and wa.occurred_at >= now() - ($3::text || ' days')::interval
          group by
            wa.wallet_id,
            wa.market_id,
            um.title,
            ue.title,
            wa.venue,
            um.category,
            um.best_bid,
            um.best_ask,
            um.last_price,
            um.status,
            um.close_time,
            um.expiration_time,
            um.resolved_outcome
        ) ranked
        left join lateral (
          select
            ws.outcome_side,
            ws.shares,
            ws.size_usd,
            ws.price
          from wallet_position_snapshots ws
          where ws.wallet_id = ranked.wallet_id
            and ws.market_id = ranked.market_id
            and ws.shares > 0
          order by ws.snapshot_at desc, ws.size_usd desc nulls last, ws.shares desc
          limit 1
        ) pos on true
        where ranked.rn <= $2
        order by ranked.wallet_id, ranked.rn
      `,
      [whaleIds, marketLimit, windowDays],
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
    }>(
      `
        select wallet_id, features_hash
        from wallet_profiles
        where wallet_id = any($1::uuid[])
      `,
      [whaleIds],
    );
    const existingMap = new Map<string, string>();
    for (const row of existingRows.rows) {
      existingMap.set(row.wallet_id, row.features_hash);
    }

    let processed = 0;
    let updated = 0;
    let skipped = 0;
    let failed = 0;

    for (const [index, whale] of whaleRows.rows.entries()) {
      processed += 1;
      if (verbose) {
        console.log("[whale-profile] wallet start", {
          index: index + 1,
          total: whaleRows.rows.length,
          walletId: whale.id,
          chain: whale.chain,
          sourceHits: whale.source_hits,
          rankRecent: whale.rank_recent,
          rankPnl: whale.rank_pnl,
          rankSignal: whale.rank_signal,
        });
      }
      const topMarkets = marketMap.get(whale.id) ?? [];
      const recentSummary = recentSummaryMap.get(whale.id) ?? null;
      const input = buildProfileInput(whale, topMarkets, {
        marketLimit,
        windowDays,
        recentSummary,
        recentWindowHours,
        recentTopChanges,
        styleGuide: policy.styleGuide,
      });
      const featuresHash = hashProfileInput(input);
      if (!options.force && existingMap.get(whale.id) === featuresHash) {
        skipped += 1;
        if (verbose) {
          console.log("[whale-profile] wallet skipped (unchanged)", {
            walletId: whale.id,
          });
        } else if (processed % logEvery === 0) {
          console.log("[whale-profile] progress", {
            processed,
            total: whaleRows.rows.length,
            updated,
            skipped,
            failed,
          });
        }
        continue;
      }

      const system =
        "You are a market analyst writing concise, user-facing whale profiles. Return strict JSON only.";
      const user = `Create a compact whale profile for display in a product UI.
Output JSON with:
- label_short: short name (<= 40 chars), no venue names, no chain names.
- label_long: 1–2 sentences (<= 220 chars) summarizing the main behavior pattern.
- archetype: short snake_case tag.
- categories: array of 1–3 from [sports, politics, crypto, finance, entertainment, tech, macro, social, other].
- theme_focus: array of up to 3 lowercase tags.
- risk_style: short phrase (<= 60 chars).
- confidence: number 0–1.
- evidence: array of 2–4 short market or event titles (prefer event titles if multiple markets share the same event).
- notes: optional 2–3 sentences (<= 300 chars) with extra context for the detail view.

Rules:
- Use ONLY provided data. Do NOT mention wallet IDs or addresses.
- No claims of insider or informed intent.
- Be factual, pattern-based, and neutral in tone.
- If data is limited or mixed, keep confidence <= 0.55 and mention uncertainty.
- If activity kind is "holder" (no trades), emphasize exposure/holdings vs trade timing.
- If most top markets are resolved or ended, mention that the pattern is historical.
- recent_window summarizes the last recent_window.window_hours hours.
  Use it to explain what changed recently (net change, many exits, spikes),
  but treat it as secondary to the broader 30d pattern.
- recent_window.top_changes are already aggregated per market/outcome;
  avoid repeating identical markets.
- Price fields:
  - top_markets.last_yes_price is the YES price from the market.
  - top_markets.held_odds is the side-aware price (YES/NO) for the held position.
  - top_changes.odds is also side-aware for the change row.
- Wallet type/roles:
  - wallet.kind: "eoa" (normal), "safe" (Gnosis Safe multisig), "contract" (other contract), or "unknown".
  - wallet.role: "trading_wallet" for the wallet holding positions.
  - wallet.owner_role: "signer_wallet" when the owner address controls a Safe.
 - Prefer evidence from top_events when available; fall back to top_markets.
- Use summary.side_bias_label and summary.concentration_label as hints.
- Style guide: ${policy.styleGuide}
- Prompt version: ${policy.promptVersion}
- Never suggest insider information.

Whale data (JSON):\n${JSON.stringify(input)}`;
      const compactUser = `${user}

Extra constraint: Keep notes <= 120 chars and prefer shorter labels.`;

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
            total: whaleRows.rows.length,
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
              total: whaleRows.rows.length,
              updated,
              skipped,
              failed,
            });
          }
          continue;
        }
      }

      let normalized = normalizeProfile(parsed);
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
            total: whaleRows.rows.length,
            updated,
            skipped,
            failed,
          });
        }
        continue;
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
            markets: topMarkets.length,
          });
        } else if (processed % logEvery === 0) {
          console.log("[whale-profile] progress", {
            processed,
            total: whaleRows.rows.length,
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
          JSON.stringify(normalized),
          featuresHash,
          policy.model,
          PROFILE_VERSION,
        ],
      );
      updated += 1;
      if (verbose) {
        console.log("[whale-profile] wallet updated", {
          walletId: whale.id,
          markets: topMarkets.length,
        });
      } else if (processed % logEvery === 0) {
        console.log("[whale-profile] progress", {
          processed,
          total: whaleRows.rows.length,
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

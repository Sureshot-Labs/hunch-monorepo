import { createHash } from "node:crypto";
import type {
  DiscoveryInstrument,
  DiscoveryItem,
  DiscoveryQuery,
  DiscoveryResearch,
  DiscoverySection,
  DiscoveryTrader,
} from "../schemas/discovery.js";
import { buildSocialInstrument } from "./social-instrument.js";
import { publicHunchAcceptingOrders } from "./hunch-market-availability.js";
import { publicHunchPricePresentation } from "./hunch-price-presentation.js";
import {
  publicHunchSources,
  publicHolderDisplayName,
} from "./hunch-public-presentation.js";
import {
  compareSocialDecimal as cmp,
  subtractSocialDecimal as sub,
  multiplySocialDecimal as mul,
  divideSocialDecimal as div,
} from "./social-primitives.js";

export const DISCOVERY_QUOTE_AGE_MS = 300_000;
export const DISCOVERY_QUICK_MIN_PRICE = "0.85";
export const DISCOVERY_QUICK_MAX_PRICE = "0.95";
export const DISCOVERY_SNAPSHOT_TTL_MS = 900_000;
export const DISCOVERY_REFRESH_MS: Record<DiscoverySection, number> = {
  "quick-wins": 60_000,
  "smart-money": 300_000,
  "hidden-gems": 60_000,
};
export const DISCOVERY_MAX_AGE_MS: Record<DiscoverySection, number> = {
  "quick-wins": 300_000,
  "smart-money": 900_000,
  "hidden-gems": 300_000,
};
export type DiscoverySnapshot = {
  version: 1;
  id: string;
  section: DiscoverySection;
  generatedAt: string;
  sourceAsOf: string;
  projectionRefreshedAt: string | null;
  warnings: string[];
  lifecycleRevision: string;
  items: DiscoveryItem[];
};
export class DiscoveryError extends Error {
  constructor(
    readonly code:
      | "discovery_unavailable"
      | "discovery_cursor_expired"
      | "discovery_invalid_cursor",
    readonly statusCode: 400 | 409 | 503,
  ) {
    super(code);
  }
}
export type RawDiscoveryRow = Record<string, unknown>;
export const record = (value: unknown): RawDiscoveryRow =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as RawDiscoveryRow)
    : {};
export function iso(value: unknown): string | null {
  const ms =
    value instanceof Date
      ? value.getTime()
      : typeof value === "string"
        ? Date.parse(value)
        : NaN;
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}
export function decimal(value: unknown): string | null {
  const text =
    typeof value === "number" && Number.isFinite(value)
      ? String(value)
      : typeof value === "string"
        ? value
        : "";
  return /^-?\d{1,100}(?:\.\d{1,40})?$/.test(text) ? text : null;
}
export const add = (a: string, b: string) => sub(a, sub("0", b));
export const minDecimal = (a: string, b: string) => (cmp(a, b) <= 0 ? a : b);
const string = (value: unknown) => (typeof value === "string" ? value : "");
function array(value: unknown): unknown[] {
  try {
    const parsed = typeof value === "string" ? JSON.parse(value) : value;
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}
export function sameInstrument(
  a: DiscoveryInstrument | null,
  b: DiscoveryInstrument | null,
): boolean {
  return (
    !!a &&
    !!b &&
    a.marketId === b.marketId &&
    a.venue === b.venue &&
    a.outcome === b.outcome &&
    a.tokenId === b.tokenId &&
    a.generation === b.generation &&
    a.expiry === b.expiry
  );
}
export function researchFromRow(
  row: RawDiscoveryRow,
): DiscoveryResearch | null {
  const metrics = record(row.metrics),
    lineage = record(row.lineage),
    meta = record(row.model_meta);
  const side = string(lineage.side).toUpperCase();
  if (
    row.note_type !== "signal" ||
    row.status !== "active" ||
    row.producer_type !== "holder_research" ||
    row.source_kind !== "market" ||
    !["YES", "NO"].includes(side)
  )
    return null;
  const approval = record(metrics.publicationDecisionV1);
  if (
    approval.status !== "PUBLISH" ||
    approval.authority !== "holder_research_quality_gate"
  )
    return null;
  const createdAt = iso(row.created_at);
  if (!createdAt) return null;
  const price = record(metrics.signalPriceSnapshotV1);
  const rawInstrument = record(metrics.socialInstrumentV1);
  const instrument =
    typeof rawInstrument.marketId === "string" &&
    typeof rawInstrument.tokenId === "string" &&
    typeof rawInstrument.generation === "string" &&
    rawInstrument.marketId === row.source_id &&
    rawInstrument.outcome === side &&
    ["polymarket", "limitless", "kalshi"].includes(string(rawInstrument.venue))
      ? {
          marketId: rawInstrument.marketId,
          venue: rawInstrument.venue as DiscoveryInstrument["venue"],
          tokenId: rawInstrument.tokenId,
          generation: rawInstrument.generation,
          outcome: side as "YES" | "NO",
          expiry: iso(rawInstrument.expiry),
        }
      : null;
  return {
    noteId: string(row.id),
    createdAt,
    headline: string(row.title),
    summary: string(row.description),
    side: side as "YES" | "NO",
    strength:
      record(metrics.hunchStrengthV1).grade === "strong" ? "strong" : "good",
    researchedPrice:
      price.displaySide === side ? decimal(price.displayPrice) : null,
    researchedAt: iso(price.asOf),
    sources: publicHunchSources({ kind: "signal", metrics, modelMeta: meta }),
    caveats: array(meta.caveats).filter(
      (v): v is string => typeof v === "string",
    ),
    instrument,
  };
}
export function marketCard(
  row: RawDiscoveryRow,
  now: number,
  limitlessPositionContract: string,
): Omit<DiscoveryItem, "id" | "reason" | "research"> | null {
  const venue = string(row.venue),
    side = string(row.side);
  if (
    !["polymarket", "limitless", "kalshi"].includes(venue) ||
    !["YES", "NO"].includes(side)
  )
    return null;
  const metadata = record(row.metadata);
  if (
    !publicHunchAcceptingOrders({
      venue,
      status: string(row.status),
      eventStatus: string(row.event_status),
      resolvedOutcome:
        row.resolved_outcome == null ? null : string(row.resolved_outcome),
      closeTime: row.close_time,
      expirationTime: row.expiration_time,
      eventEndTime: row.event_end_time,
      pmAcceptingOrders:
        typeof row.pm_accepting_orders === "boolean"
          ? row.pm_accepting_orders
          : null,
      dflowNativeAcceptingOrders: metadata.dflowNativeAcceptingOrders === true,
      nowMs: now,
    })
  )
    return null;
  if (
    row.pm_closed === true ||
    row.pm_archived === true ||
    row.pm_active === false ||
    row.resolved_outcome_pct != null
  )
    return null;
  const resolution = publicHunchPricePresentation({
    kind: "signal",
    side,
    researchedSide: side,
    researchedPrice: null,
    researchedAt: null,
    acceptingOrders: true,
    venue,
    metadata,
    marketUpdatedAt: row.updated_at,
    resolvedOutcome: null,
    quotePrice: null,
    quoteAsOf: null,
    now,
  }).resolutionStatus;
  if (resolution !== null) return null;
  const instrument = buildSocialInstrument({
    marketId: string(row.id),
    venue,
    outcome: side as "YES" | "NO",
    tokenId: typeof row.token_id === "string" ? row.token_id : null,
    expiry: iso(row.expiration_time),
    metadata,
    limitlessPositionContract,
  });
  const ask = decimal(row.best_ask),
    bid = decimal(row.best_bid),
    asOf = iso(row.quote_at);
  const valid =
    !!ask &&
    !!bid &&
    cmp(bid, "0") > 0 &&
    cmp(ask, "1") < 0 &&
    cmp(bid, ask) <= 0 &&
    !!asOf &&
    Date.parse(asOf) <= now + 5000;
  const fresh = valid && now - Date.parse(asOf) <= DISCOVERY_QUOTE_AGE_MS;
  const outcomes = array(row.outcomes),
    label = outcomes[side === "YES" ? 0 : 1];
  return {
    market: {
      marketId: string(row.id),
      eventId: string(row.event_id) || string(row.id),
      title: string(row.title),
      eventTitle: string(row.event_title) || string(row.title),
      category: typeof row.category === "string" ? row.category : null,
      venue: venue as DiscoveryInstrument["venue"],
      image: typeof row.image === "string" ? row.image : null,
      resolutionCondition: string(row.description),
    },
    selection: {
      side: side as "YES" | "NO",
      outcomeLabel: typeof label === "string" && label.trim() ? label : side,
      instrument,
    },
    quote: {
      status: fresh ? "fresh" : valid ? "stale" : "unavailable",
      bid: valid ? bid : null,
      ask: valid ? ask : null,
      midpoint: valid ? div(add(bid, ask), "2") : null,
      asOf,
    },
    timing: {
      marketEndAt: iso(row.expiration_time),
      closeAt: iso(row.close_time),
      eventEndAt: iso(row.event_end_time),
      basis: "venue_market_expiration_not_guaranteed_settlement",
      settlementAt: null,
    },
    copyAvailable: !!instrument && fresh,
  };
}
export function quickPriceEligible(
  card: Omit<DiscoveryItem, "id" | "reason" | "research">,
  liquidity: string,
  volume: string,
  now: number,
  horizonHours = 168,
): boolean {
  const { ask, bid, midpoint, status } = card.quote;
  const end = Date.parse(card.timing.marketEndAt ?? "");
  return (
    status === "fresh" &&
    !!ask &&
    !!bid &&
    !!midpoint &&
    cmp(ask, DISCOVERY_QUICK_MIN_PRICE) >= 0 &&
    cmp(ask, DISCOVERY_QUICK_MAX_PRICE) <= 0 &&
    cmp(midpoint, DISCOVERY_QUICK_MIN_PRICE) >= 0 &&
    cmp(midpoint, DISCOVERY_QUICK_MAX_PRICE) <= 0 &&
    cmp(sub(ask, bid), "0.03") <= 0 &&
    cmp(liquidity, "1000") >= 0 &&
    cmp(volume, "0") > 0 &&
    end > now &&
    end <= now + horizonHours * 3600000
  );
}
export function quickEligible(
  card: Omit<DiscoveryItem, "id" | "reason" | "research">,
  liquidity: string,
  volume: string,
  now: number,
  horizonHours = 168,
): boolean {
  return (
    !!card.selection.instrument &&
    !!card.market.resolutionCondition.trim() &&
    quickPriceEligible(card, liquidity, volume, now, horizonHours)
  );
}
export function quickReason(
  ask: string,
  liquidityUsd: string,
  volume24hUsd: string,
): Extract<DiscoveryItem["reason"], { kind: "quick-wins" }> {
  return {
    kind: "quick-wins",
    volume24hUsd,
    liquidityUsd,
    grossReturnIfWin: sub(div("1", ask) ?? "0", "1"),
    returnBasis: "top_ask_excludes_depth_fees_slippage",
    resolutionClarity: "rules_provided_not_human_reviewed",
  };
}
export function normalizeDiscoveryText(text: string): string {
  return text
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}
export function normalizeDiscoveryQuery(query: DiscoveryQuery) {
  const list = (value: string | undefined) =>
    [
      ...new Set(
        (value ?? "")
          .split(",")
          .map((v) => v.trim())
          .filter(Boolean),
      ),
    ].sort();
  return {
    q: normalizeDiscoveryText(query.q ?? ""),
    categories: list(query.categories),
    venues: list(query.venues),
    withResearch: query.withResearch === "true",
    horizonHours: query.horizonHours ?? 72,
  };
}
export function discoveryFilterHash(
  section: DiscoverySection,
  query: DiscoveryQuery,
): string {
  return createHash("sha256")
    .update(JSON.stringify([section, normalizeDiscoveryQuery(query)]))
    .digest("hex");
}
export function matchesDiscovery(
  item: DiscoveryItem,
  query: DiscoveryQuery,
  snapshotTime: number,
): boolean {
  const filters = normalizeDiscoveryQuery(query);
  return (
    (!filters.categories.length ||
      filters.categories.includes(item.market.category ?? "")) &&
    (!filters.venues.length || filters.venues.includes(item.market.venue)) &&
    (!filters.withResearch || !!item.research) &&
    (!filters.q ||
      filters.q
        .split(" ")
        .every((term) =>
          normalizeDiscoveryText(
            [
              item.market.title,
              item.market.eventTitle,
              item.selection.outcomeLabel,
            ].join(" "),
          ).includes(term),
        )) &&
    (item.reason.kind !== "quick-wins" ||
      Date.parse(item.timing.marketEndAt ?? "") <=
        snapshotTime + filters.horizonHours * 3600000)
  );
}
export function compareDiscovery(a: DiscoveryItem, b: DiscoveryItem): number {
  if (a.reason.kind === "quick-wins" && b.reason.kind === "quick-wins")
    return (
      Date.parse(a.timing.marketEndAt ?? "") -
        Date.parse(b.timing.marketEndAt ?? "") ||
      cmp(
        sub(a.quote.ask ?? "1", a.quote.bid ?? "0"),
        sub(b.quote.ask ?? "1", b.quote.bid ?? "0"),
      ) ||
      -cmp(a.reason.liquidityUsd, b.reason.liquidityUsd) ||
      a.id.localeCompare(b.id)
    );
  if (a.reason.kind === "smart-money" && b.reason.kind === "smart-money")
    return (
      b.reason.ownerGroups - a.reason.ownerGroups ||
      -cmp(
        a.reason.observedIncreaseValueUsd,
        b.reason.observedIncreaseValueUsd,
      ) ||
      a.id.localeCompare(b.id)
    );
  return (
    Number(b.research?.strength === "strong") -
      Number(a.research?.strength === "strong") ||
    Date.parse(b.research?.createdAt ?? "") -
      Date.parse(a.research?.createdAt ?? "") ||
    a.id.localeCompare(b.id)
  );
}
export type DiscoveryCursor = {
  v: 1;
  snapshotId: string;
  section: DiscoverySection;
  hash: string;
  position: number;
  member: number;
};
export function encodeDiscoveryCursor(value: DiscoveryCursor): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}
export function decodeDiscoveryCursor(
  value: string | undefined,
  section: DiscoverySection,
  hash: string,
): DiscoveryCursor | null {
  if (!value) return null;
  try {
    const raw = record(
      JSON.parse(Buffer.from(value, "base64url").toString("utf8")),
    );
    if (
      raw.v !== 1 ||
      raw.section !== section ||
      raw.hash !== hash ||
      !/^[0-9a-f-]{36}$/.test(string(raw.snapshotId)) ||
      !Number.isSafeInteger(raw.position) ||
      Number(raw.position) < 0 ||
      !Number.isSafeInteger(raw.member) ||
      Number(raw.member) < 0
    )
      throw Error();
    return raw as DiscoveryCursor;
  } catch {
    throw new DiscoveryError("discovery_invalid_cursor", 400);
  }
}

export type SmartWallet = {
  walletId: string;
  ownerKey: string;
  trader: DiscoveryTrader;
  qualified?: boolean;
};
export type SmartPosition = {
  walletId: string;
  venue: string;
  marketId: string;
  side: string;
  shares: string;
  valueUsd: string;
  snapshotAt: string;
};
export type SmartChange = {
  walletId: string;
  venue: string;
  marketId: string;
  side: string;
  netShares: string;
  observedAt: string;
};
export type SmartSelection = {
  marketId: string;
  venue: string;
  side: "YES" | "NO";
  reason: Extract<DiscoveryItem["reason"], { kind: "smart-money" }>;
};
export function smartWalletFromRow(row: RawDiscoveryRow): SmartWallet | null {
  const pnl = decimal(row.metrics_pnl_30d),
    edge = decimal(row.metrics_resolved_win_rate_edge_30d),
    at = iso(row.metrics_as_of);
  if (!pnl || !edge || !at) return null;
  return {
    walletId: string(row.wallet_id),
    ownerKey: string(row.owner_key) || string(row.wallet_id),
    trader: {
      walletId: string(row.wallet_id),
      displayName: publicHolderDisplayName({
        profileLabel: row.profile_label,
        identityDisplayName: row.identity_display_name,
        identityDisplayNameSource: row.identity_display_name_source,
        address: typeof row.address === "string" ? row.address : null,
      }),
      pnl30dUsd: pnl,
      pnlIsApproximate: true,
      resolvedObservations30d: Number(
        row.metrics_resolved_edge_sample_count_30d,
      ),
      edge30d: edge,
      metricsAsOf: at,
    },
  };
}
/** Full-window changes are signed by SQL action, not by absolute delta_shares. */
export function aggregateSmartMoney(
  wallets: SmartWallet[],
  positions: SmartPosition[],
  changes: SmartChange[],
): SmartSelection[] {
  const identity = new Map(wallets.map((w) => [w.walletId, w]));
  const key = (p: {
    walletId: string;
    venue: string;
    marketId: string;
    side: string;
  }) => [p.walletId, p.venue, p.marketId, p.side].join("|");
  const current = new Map(positions.map((p) => [key(p), p]));
  const ownerHoldings = new Map<string, { shares: string; value: string }>();
  for (const position of positions) {
    const wallet = identity.get(position.walletId);
    if (wallet && cmp(position.shares, "0") > 0) {
      const ownerKey = [
        wallet.ownerKey,
        position.venue,
        position.marketId,
        position.side,
      ].join("|");
      const previous = ownerHoldings.get(ownerKey) ?? {
        shares: "0",
        value: "0",
      };
      ownerHoldings.set(ownerKey, {
        shares: add(previous.shares, position.shares),
        value: add(previous.value, position.valueUsd),
      });
    }
  }
  const owners = new Map<
    string,
    {
      marketId: string;
      venue: string;
      side: "YES" | "NO";
      value: string;
      at: string;
      wallet: SmartWallet;
    }
  >();
  const ownerChanges = new Map<
    string,
    {
      marketId: string;
      venue: string;
      side: "YES" | "NO";
      netShares: string;
      qualifiedNet: string;
      at: string;
      wallet: SmartWallet;
      fresh: boolean;
    }
  >();
  for (const change of changes) {
    const position = current.get(key(change)),
      wallet = identity.get(change.walletId);
    if (!wallet || !["YES", "NO"].includes(change.side)) continue;
    const ownerKey = [
      wallet.ownerKey,
      change.venue,
      change.marketId,
      change.side,
    ].join("|");
    const previous = ownerChanges.get(ownerKey);
    const fresh =
      cmp(change.netShares, "0") <= 0 ||
      (!!position &&
        Date.parse(position.snapshotAt) >= Date.parse(change.observedAt));
    const representative =
      previous &&
      (wallet.qualified === false ||
        (previous.wallet.qualified !== false &&
          cmp(previous.wallet.trader.pnl30dUsd, wallet.trader.pnl30dUsd) > 0))
        ? previous.wallet
        : wallet;
    ownerChanges.set(ownerKey, {
      marketId: change.marketId,
      venue: change.venue,
      side: change.side as "YES" | "NO",
      netShares: add(previous?.netShares ?? "0", change.netShares),
      qualifiedNet: add(
        previous?.qualifiedNet ?? "0",
        wallet.qualified === false ? "0" : change.netShares,
      ),
      at:
        previous && previous.at > change.observedAt
          ? previous.at
          : change.observedAt,
      wallet: representative,
      fresh: fresh && (previous?.fresh ?? true),
    });
  }
  for (const [ownerKey, change] of ownerChanges) {
    const holding = ownerHoldings.get(ownerKey),
      opposite = ownerHoldings.get(
        [
          change.wallet.ownerKey,
          change.venue,
          change.marketId,
          change.side === "YES" ? "NO" : "YES",
        ].join("|"),
      );
    if (
      !holding ||
      !change.fresh ||
      change.wallet.qualified === false ||
      cmp(change.netShares, "0") <= 0 ||
      cmp(change.qualifiedNet, "0") <= 0 ||
      cmp(holding.shares, "0") <= 0 ||
      cmp(holding.value, "100") < 0 ||
      (opposite && cmp(opposite.value, "100") >= 0)
    )
      continue;
    const value =
      div(
        mul(
          minDecimal(
            minDecimal(change.netShares, change.qualifiedNet),
            holding.shares,
          ),
          holding.value,
        ),
        holding.shares,
      ) ?? "0";
    if (cmp(value, "100") >= 0) owners.set(ownerKey, { ...change, value });
  }
  const grouped = new Map<string, SmartSelection>();
  for (const owner of owners.values()) {
    const groupKey = [owner.venue, owner.marketId, owner.side].join("|");
    const group = grouped.get(groupKey) ?? {
      marketId: owner.marketId,
      venue: owner.venue,
      side: owner.side,
      reason: {
        kind: "smart-money" as const,
        evidenceBasis: "observed_snapshot_increase" as const,
        ownerGroups: 0,
        oppositeOwnerGroups: 0,
        observedIncreaseValueUsd: "0",
        observedAt: owner.at,
        windowHours: 24 as const,
        traders: [],
        opposingViews: false,
      },
    };
    group.reason.ownerGroups++;
    group.reason.observedIncreaseValueUsd = add(
      group.reason.observedIncreaseValueUsd,
      owner.value,
    );
    if (owner.at > group.reason.observedAt) group.reason.observedAt = owner.at;
    group.reason.traders.push(owner.wallet.trader);
    grouped.set(groupKey, group);
  }
  for (const group of grouped.values()) {
    const opposite = grouped.get(
      [group.venue, group.marketId, group.side === "YES" ? "NO" : "YES"].join(
        "|",
      ),
    );
    group.reason.oppositeOwnerGroups = opposite?.reason.ownerGroups ?? 0;
    group.reason.opposingViews = group.reason.oppositeOwnerGroups > 0;
    group.reason.traders.sort(
      (a, b) =>
        -cmp(a.pnl30dUsd, b.pnl30dUsd) || a.walletId.localeCompare(b.walletId),
    );
    group.reason.traders = group.reason.traders.slice(0, 3);
  }
  return [...grouped.values()].filter((g) => g.reason.ownerGroups >= 2);
}

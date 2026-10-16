import {
  hip4BinaryPayout,
  hip4Identity,
  hip4ReadMarketSchema,
  type Hip4ReadMarket,
  type Hip4ReadPolicy,
} from "@hunch/shared";
import type { FeedMarket } from "../server-types.js";
import { ageHip4Market } from "./hip4-mapping.js";

export type FeedReadContext = {
  hip4Policy: Hip4ReadPolicy | null;
  now: number;
};

function readSnapshot(
  row: FeedMarket,
  eventId: string,
  metadata: unknown,
  context: FeedReadContext,
): Hip4ReadMarket | null {
  if (!context.hip4Policy || !context.hip4Policy.enabled) return null;
  if (!metadata || typeof metadata !== "object" || !("hip4" in metadata))
    return null;
  const parsed = hip4ReadMarketSchema.safeParse(metadata.hip4);
  if (!parsed.success) return null;
  const market = parsed.data;
  const identity = hip4Identity(market.environment, market.outcome);
  const expectedEvent =
    market.questionId == null
      ? identity.marketId
      : `hyperliquid:${market.environment}:question:${market.questionId}`;
  if (
    market.environment !== context.hip4Policy.environment ||
    market.marketId !== identity.marketId ||
    row.marketId !== identity.marketId ||
    market.eventId !== expectedEvent ||
    eventId !== expectedEvent ||
    !Number.isFinite(Date.parse(market.fetchedAt)) ||
    !identity.sides.every((expected) => {
      const side = market.sides.find(
        (value) => value.sideIndex === expected.sideIndex,
      );
      const token = expected.sideIndex === 0 ? row.tokens.yes : row.tokens.no;
      return (
        side?.tokenId === expected.tokenId &&
        token === expected.tokenId &&
        side.coin === expected.coin &&
        side.assetId === expected.assetId &&
        side.tokenName === expected.tokenName
      );
    })
  )
    return null;
  try {
    // Reuse the public detail reader's policy, including a shorter effective
    // freshness bound. Reading this snapshot does not refresh its provenance.
    // Canonical schema order also keeps cached bytes/ETags stable on a second
    // pass after optional freshness fields were added by the ageing step.
    return hip4ReadMarketSchema.parse(
      ageHip4Market(market, context.now, context.hip4Policy),
    );
  } catch {
    // A malformed historical timestamp affects one row, not the whole feed.
    return null;
  }
}

function currentObservation(
  at: string | null,
  until: string | null | undefined,
  now: number,
) {
  return (
    at != null &&
    until != null &&
    Date.parse(at) <= now &&
    Date.parse(until) > now
  );
}

/** Common feed DTO built from already-selected columns. No provider/DB reads,
 * ranking changes, side-complement quotes or invented lifetime aggregates. */
export function applyFeedReadPresentation(
  row: FeedMarket,
  eventId: string,
  metadata: unknown,
  context: FeedReadContext,
): FeedMarket {
  if (row.venue !== "hyperliquid") return row;
  const market = readSnapshot(row, eventId, metadata, context);
  const unavailable: FeedMarket = {
    ...row,
    volume24h: null,
    volumeTotal: null,
    volumeDisplay: null,
    volumeDisplayPeriod: "24h",
    volumeValidUntil: null,
    openInterest: null,
    liquidity: null,
    liquidityDisplay: null,
    acceptingOrders: false,
    lastPrice: null,
    change24h: null,
    resolvedOutcome: null,
    resolvedOutcomePct: null,
    marketMetadata: null,
    top: { yesBid: null, yesAsk: null, noBid: null, noAsk: null },
    topAsOf: { YES: null, NO: null },
    topValidUntil: { YES: null, NO: null },
  };
  if (!market) return unavailable;
  const primary = market.sides.find((side) => side.sideIndex === 0);
  const secondary = market.sides.find((side) => side.sideIndex === 1);
  // readSnapshot already validated both identities; retain that invariant
  // explicitly here instead of asserting away the mapper's nullable type.
  if (!primary || !secondary) return unavailable;
  const book = (side: typeof primary) => {
    const fresh =
      !market.settlement &&
      market.status === "observed" &&
      side.bookState === "fresh" &&
      currentObservation(side.bookAt, side.bookValidUntil, context.now);
    return {
      bid: fresh && side.bid != null ? Number(side.bid) : null,
      ask: fresh && side.ask != null ? Number(side.ask) : null,
      at: fresh ? side.bookAt : null,
      until: side.bookValidUntil ?? null,
    };
  };
  const yes = book(primary),
    no = book(secondary);
  const volume = market.volume24h;
  const value = volume == null ? NaN : Number(volume.usd);
  const currentVolume =
    market.quoteToken === "USDC" &&
    volume?.basis === "primary_outcome" &&
    volume.coin === primary.coin &&
    currentObservation(volume.observedAt, volume.validUntil, context.now) &&
    Number.isFinite(value) &&
    value >= 0;
  const yesPayout = hip4BinaryPayout(primary.payout);
  const noPayout = hip4BinaryPayout(secondary.payout);
  const resolved =
    market.settlement &&
    yesPayout != null &&
    noPayout != null &&
    yesPayout !== noPayout
      ? yesPayout === 1
        ? "YES"
        : "NO"
      : null;
  return {
    ...unavailable,
    volume24h: currentVolume ? value : null,
    volumeDisplay: currentVolume ? value : null,
    volumeValidUntil: volume?.validUntil ?? null,
    marketMetadata: { hip4: market },
    outcomes: [primary.label, secondary.label],
    closeTime: market.expiry,
    expirationTime: market.expiry,
    status: market.settlement
      ? "RESOLVED"
      : market.status === "expired"
        ? "CLOSED"
        : row.status,
    resolvedOutcome: resolved,
    top: { yesBid: yes.bid, yesAsk: yes.ask, noBid: no.bid, noAsk: no.ask },
    topAsOf: { YES: yes.at, NO: no.at },
    topValidUntil: { YES: yes.until, NO: no.until },
  };
}

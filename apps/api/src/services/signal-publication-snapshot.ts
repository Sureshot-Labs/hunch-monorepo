import type { SignalPriceSnapshotV1 } from "./signal-publication-contract.js";
import { SIGNAL_BOT_QUOTE_MAX_AGE_MS } from "./signal-bot-delivery-policy.js";

export type SignalPublicationSnapshotV1 = {
  version: 1;
  marketId: string;
  venue: string;
  side: "YES" | "NO";
  preparedAt: string;
  quoteAsOf: string | null;
  displayPrice: number | null;
  displayPriceSource: "midpoint" | "delivery_target" | "missing";
  bid: number | null;
  ask: number | null;
  quoteSource: "research_snapshot" | "native_ask" | "missing";
  // A quoted ask is not proof of execution or sufficient order-book depth.
  quoteQuality: "quoted_ask" | "missing_ask" | "stale_quote" | "invalid_quote";
};

function probability(value: unknown): number | null {
  return typeof value === "number" &&
    Number.isFinite(value) &&
    value >= 0 &&
    value <= 1
    ? value
    : null;
}

export function publicationQuoteQuality(
  snapshot: Pick<SignalPublicationSnapshotV1, "ask" | "bid" | "quoteAsOf">,
  at: Date,
): SignalPublicationSnapshotV1["quoteQuality"] {
  if (snapshot.ask == null) return "missing_ask";
  if (
    probability(snapshot.ask) == null ||
    snapshot.ask <= 0 ||
    snapshot.ask >= 1 ||
    (snapshot.bid != null &&
      (probability(snapshot.bid) == null || snapshot.bid > snapshot.ask))
  )
    return "invalid_quote";
  const quoteMs = Date.parse(snapshot.quoteAsOf ?? "");
  if (
    !Number.isFinite(quoteMs) ||
    !Number.isFinite(at.getTime()) ||
    quoteMs > at.getTime() ||
    at.getTime() - quoteMs > SIGNAL_BOT_QUOTE_MAX_AGE_MS
  )
    return "stale_quote";
  return "quoted_ask";
}

export function buildSignalPublicationSnapshot(input: {
  marketId: string;
  venue: string;
  side: "YES" | "NO";
  priceSnapshot: SignalPriceSnapshotV1 | null;
  nativeQuote?: {
    ask: number;
    bid?: number | null;
    asOf: string | null;
  } | null;
  displayPrice?: number | null;
  now?: Date;
}): SignalPublicationSnapshotV1 {
  const now = input.now ?? new Date();
  const source = input.priceSnapshot;
  const matches =
    source?.marketId === input.marketId &&
    source.venue === input.venue &&
    source.displaySide === input.side;
  const sideQuote = matches ? source[input.side] : null;
  const native = input.nativeQuote;
  const quote = {
    ask: native ? native.ask : (sideQuote?.ask ?? null),
    bid: native ? (native.bid ?? null) : (sideQuote?.bid ?? null),
    quoteAsOf: native ? native.asOf : matches ? source.asOf : null,
  };
  return {
    version: 1,
    marketId: input.marketId,
    venue: input.venue,
    side: input.side,
    preparedAt: now.toISOString(),
    ...quote,
    displayPrice: probability(
      input.displayPrice ?? (matches ? source.displayPrice : null),
    ),
    displayPriceSource:
      input.displayPrice != null
        ? "delivery_target"
        : matches
          ? "midpoint"
          : "missing",
    quoteSource: native
      ? "native_ask"
      : matches
        ? "research_snapshot"
        : "missing",
    quoteQuality: publicationQuoteQuality(quote, now),
  };
}

export function parseSignalPublicationSnapshot(
  value: unknown,
): SignalPublicationSnapshotV1 | null {
  if (value == null || typeof value !== "object" || Array.isArray(value))
    return null;
  const row = value as SignalPublicationSnapshotV1;
  if (
    row.version !== 1 ||
    typeof row.marketId !== "string" ||
    !row.marketId ||
    typeof row.venue !== "string" ||
    !row.venue ||
    (row.side !== "YES" && row.side !== "NO") ||
    typeof row.preparedAt !== "string" ||
    !Number.isFinite(Date.parse(row.preparedAt)) ||
    (row.quoteAsOf !== null && typeof row.quoteAsOf !== "string") ||
    (row.ask !== null && probability(row.ask) == null) ||
    (row.bid !== null && probability(row.bid) == null) ||
    (row.displayPrice !== null && probability(row.displayPrice) == null)
  )
    return null;
  return row;
}

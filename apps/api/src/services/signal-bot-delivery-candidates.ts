import { normalizeHunchVenue } from "@hunch/shared";
import type { SignalBotNote } from "./signal-bot-contracts.js";
import type { ClusterMarketSummary } from "./clusters.js";
import { resolveNativeOutcomeForCanonicalSide } from "./cluster-execution.js";
import type { SignalDeliveryCandidate } from "./signal-delivery-target.js";

export function signalDeliveryCandidateFromSource(input: {
  quoteAsOf?: string | null;
  buySide: "NO" | "YES";
  executablePrice: number | null;
  note: SignalBotNote;
  priceAsOf: string;
}): SignalDeliveryCandidate | null {
  const venue = normalizeHunchVenue(input.note.marketVenue);
  if (
    !venue ||
    !input.note.eventId ||
    !input.note.marketId ||
    input.executablePrice == null
  ) {
    return null;
  }
  return {
    active: true,
    eventId: input.note.eventId,
    executablePrice: input.executablePrice,
    matchMethod: "source_identity",
    marketId: input.note.marketId,
    mappedSide: input.buySide,
    mappingConfidence: 1,
    mappingMethod: "source_identity",
    orderable: true,
    priceAsOf: input.priceAsOf,
    quoteAsOf: input.quoteAsOf ?? null,
    sourceSide: input.buySide,
    venue,
  };
}

export function signalDeliveryCandidateFromAgg(input: {
  quoteAsOf?: string | null;
  buySide: "NO" | "YES";
  executablePrice: number | null;
  market: ClusterMarketSummary;
  priceAsOf: string;
}): SignalDeliveryCandidate | null {
  const mapping = input.market.outcomeMapping;
  const mappedSide = mapping
    ? resolveNativeOutcomeForCanonicalSide(mapping.sourceYesTo, input.buySide)
    : null;
  if (
    !mapping ||
    !mappedSide ||
    input.executablePrice == null ||
    !input.market.eventId ||
    !input.market.marketId ||
    !input.market.matchMethod
  ) {
    return null;
  }
  return {
    active: input.market.active === true,
    eventId: input.market.eventId,
    executablePrice: input.executablePrice,
    matchMethod: input.market.matchMethod,
    marketId: input.market.marketId,
    mappedSide,
    mappingConfidence: mapping.confidence,
    mappingMethod: mapping.method,
    orderable: input.market.orderable === true,
    priceAsOf: input.priceAsOf,
    quoteAsOf: input.quoteAsOf ?? null,
    sourceSide: input.buySide,
    venue: input.market.venue,
  };
}

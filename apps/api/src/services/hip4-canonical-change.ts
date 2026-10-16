import { createHash } from "node:crypto";
import type { Hip4ReadMarket } from "@hunch/shared";
import { hip4RawSnapshotSchema } from "@hunch/shared";
import { parseHip4FormalTerms } from "./hip4-formal-terms.js";

export type Hip4CanonicalChange = {
  marketId: string;
  eventIds: string[];
  fingerprint: string;
};
export type Hip4CanonicalObserver = (
  change: Hip4CanonicalChange,
) => Promise<void>;

/** Material canonical facts only. Refresh UUIDs, attempts, books, marks and
 * rolling volume must not generate paid embedding/matching work. */
export function hip4CanonicalFingerprint(input: {
  market: Hip4ReadMarket;
  raw: unknown;
}) {
  const raw = hip4RawSnapshotSchema.parse(input.raw);
  const market = input.market;
  const terms = parseHip4FormalTerms({
    environment: market.environment,
    nativeOutcome: raw.outcome,
    nativeQuestion: raw.question,
  });
  return createHash("sha256")
    .update(
      JSON.stringify([
        market.environment,
        market.marketId,
        market.eventId,
        market.questionId,
        market.title,
        market.eventTitle,
        market.description,
        market.status,
        market.expiry,
        market.quoteToken,
        market.sides.map((side) => [
          side.sideIndex,
          side.tokenId,
          side.coin,
          side.assetId,
          side.label,
          side.payout,
        ]),
        terms.sourceFingerprint,
      ]),
    )
    .digest("hex");
}

export function hip4CanonicalChange(
  previous: Parameters<typeof hip4CanonicalFingerprint>[0] | null,
  next: Parameters<typeof hip4CanonicalFingerprint>[0],
): Hip4CanonicalChange | null {
  const fingerprint = hip4CanonicalFingerprint(next);
  if (previous && hip4CanonicalFingerprint(previous) === fingerprint)
    return null;
  return {
    marketId: next.market.marketId,
    eventIds: [
      ...new Set([previous?.market.eventId, next.market.eventId]),
    ].filter((id): id is string => Boolean(id)),
    fingerprint,
  };
}

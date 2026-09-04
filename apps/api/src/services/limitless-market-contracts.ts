import { ethers } from "ethers";

import { isRecord } from "../lib/type-guards.js";

/**
 * Resolve the contract that owns a Limitless CLOB market.
 *
 * Limitless exposes this value in both its market API payload (`market`) and
 * in our persisted market metadata.  A global CLOB address is only a legacy
 * fallback for records that predate this field: it must never replace an
 * explicit market contract.
 */
export function extractLimitlessMarketExchangeAddress(
  payload: unknown,
): string | null {
  const marketRecord = isRecord(payload)
    ? isRecord(payload.market)
      ? payload.market
      : payload
    : null;
  if (!marketRecord) return null;

  const directCandidates = [
    marketRecord.negRiskExchange,
    marketRecord.neg_risk_exchange,
    marketRecord.exchangeAddress,
    marketRecord.exchange_address,
    marketRecord.exchange,
    marketRecord.venueExchange,
    marketRecord.venue_exchange,
  ];
  const direct = firstAddress(directCandidates);
  if (direct) return direct;

  const venue = marketRecord.venue;
  if (!isRecord(venue)) return null;
  return firstAddress([
    venue.negRiskExchange,
    venue.neg_risk_exchange,
    venue.exchangeAddress,
    venue.exchange_address,
    venue.exchange,
    venue.venueExchange,
    venue.venue_exchange,
  ]);
}

function firstAddress(candidates: readonly unknown[]): string | null {
  for (const candidate of candidates) {
    if (typeof candidate !== "string" || !ethers.isAddress(candidate.trim())) {
      continue;
    }
    return ethers.getAddress(candidate.trim());
  }
  return null;
}

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
  return firstAddress(marketExchangeCandidates(payload));
}

/** Missing legacy metadata may fall back; malformed explicit metadata may not. */
export function resolveLimitlessMarketExchangeAddress(
  payload: unknown,
  legacyAddress: string,
): string | null {
  const candidates = marketExchangeCandidates(payload);
  return candidates.some((candidate) => candidate != null && candidate !== "")
    ? firstAddress(candidates)
    : firstAddress([legacyAddress]);
}

export type LimitlessMarketAdapter =
  | Readonly<{ status: "resolved"; address: string }>
  | Readonly<{ status: "missing" | "invalid"; address: null }>;

/** Upstream venue metadata and the indexer's scalar projections are equivalent.
 * A malformed explicit adapter must not be interpreted as "no approval needed".
 */
export function resolveLimitlessMarketAdapter(
  payload: unknown,
): LimitlessMarketAdapter {
  const candidates = marketAdapterCandidates(payload);
  const address = firstAddress(candidates);
  if (address) return { status: "resolved", address };
  return {
    status: candidates.some((value) => value != null && value !== "")
      ? "invalid"
      : "missing",
    address: null,
  };
}

export function extractLimitlessMarketAdapterAddress(
  payload: unknown,
): string | null {
  return resolveLimitlessMarketAdapter(payload).address;
}

function marketAdapterCandidates(payload: unknown): unknown[] {
  const record = isRecord(payload)
    ? isRecord(payload.market)
      ? payload.market
      : payload
    : null;
  if (!record) return [];
  // Retain the live-market reader's existing alias priority.
  const direct = [
    record.operator,
    record.operatorAddress,
    record.negRiskOperator,
    record.negRiskOperatorAddress,
    record.negRiskAdapter,
    record.adapter,
    record.adapterAddress,
    record.venueAdapter,
    record.exchangeAdapter,
    record.operator_address,
    record.neg_risk_operator,
    record.neg_risk_operator_address,
    record.neg_risk_adapter,
    record.adapter_address,
    record.venue_adapter,
    record.exchange_adapter,
  ];
  const venue = record.venue;
  if (!isRecord(venue)) return direct;
  return [
    ...direct,
    venue.operator,
    venue.operatorAddress,
    venue.negRiskOperator,
    venue.negRiskOperatorAddress,
    venue.adapter,
    venue.adapterAddress,
    venue.exchangeAdapter,
    venue.negRiskAdapter,
    venue.operator_address,
    venue.neg_risk_operator,
    venue.neg_risk_operator_address,
    venue.neg_risk_adapter,
    venue.adapter_address,
    venue.venueAdapter,
    venue.venue_adapter,
    venue.exchange_adapter,
  ];
}

function marketExchangeCandidates(payload: unknown): unknown[] {
  const marketRecord = isRecord(payload)
    ? isRecord(payload.market)
      ? payload.market
      : payload
    : null;
  if (!marketRecord) return [];

  const directCandidates = [
    marketRecord.negRiskExchange,
    marketRecord.neg_risk_exchange,
    marketRecord.exchangeAddress,
    marketRecord.exchange_address,
    marketRecord.exchange,
    marketRecord.venueExchange,
    marketRecord.venue_exchange,
  ];
  const venue = marketRecord.venue;
  if (!isRecord(venue)) return directCandidates;
  return [
    ...directCandidates,
    venue.negRiskExchange,
    venue.neg_risk_exchange,
    venue.exchangeAddress,
    venue.exchange_address,
    venue.exchange,
    venue.venueExchange,
    venue.venue_exchange,
  ];
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

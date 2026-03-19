import type { WsTargets } from "./wsMarket.js";

export type HotLimitlessMarketRow = {
  market_id: string;
  hot_rank: number;
  slug: string | null;
  address: string | null;
  trade_type: string | null;
  token_yes: string | null;
  token_no: string | null;
  volume_total: number | null;
  liquidity: number | null;
};

export type WsMarketRefRow = {
  slug: string | null;
  address: string | null;
  trade_type: string | null;
};

function normalizeMarketRefRow(row: WsMarketRefRow) {
  return {
    tradeType: row.trade_type?.trim().toLowerCase() ?? null,
    slug: row.slug?.trim() ?? null,
    address: row.address?.trim().toLowerCase() ?? null,
  };
}

function isHotAmmQuoteCandidate(row: HotLimitlessMarketRow): boolean {
  return (
    row.trade_type?.trim().toLowerCase() === "amm" &&
    !!row.address &&
    !!row.token_yes &&
    !!row.token_no
  );
}

export function selectHotAmmQuoteCandidates(
  rows: ReadonlyArray<HotLimitlessMarketRow>,
  maxMarkets: number,
): HotLimitlessMarketRow[] {
  const limit = Math.max(0, Math.trunc(maxMarkets));
  if (limit <= 0) return [];

  const out: HotLimitlessMarketRow[] = [];
  const seenAddresses = new Set<string>();
  for (const row of rows) {
    if (!isHotAmmQuoteCandidate(row)) continue;
    const address = row.address?.trim().toLowerCase();
    if (!address || seenAddresses.has(address)) continue;
    seenAddresses.add(address);
    out.push(row);
    if (out.length >= limit) break;
  }
  return out;
}

export function countHotAmmQuoteCandidates(
  rows: ReadonlyArray<HotLimitlessMarketRow>,
): number {
  const seenAddresses = new Set<string>();
  let count = 0;
  for (const row of rows) {
    if (!isHotAmmQuoteCandidate(row)) continue;
    const address = row.address?.trim().toLowerCase();
    if (!address || seenAddresses.has(address)) continue;
    seenAddresses.add(address);
    count += 1;
  }
  return count;
}

export function buildWsTargets(
  rows: ReadonlyArray<WsMarketRefRow>,
  limit: number,
): WsTargets {
  const normalized = rows.map(normalizeMarketRefRow);

  const totalLimit = Math.max(0, Math.trunc(limit));
  if (totalLimit <= 0) return { slugs: [], addresses: [] };

  const minAddressBudget = Math.min(
    totalLimit,
    Math.max(25, Math.round(totalLimit * 0.35)),
  );
  let addressBudget = minAddressBudget;
  let slugBudget = Math.max(0, totalLimit - addressBudget);

  const slugs: string[] = [];
  const addresses: string[] = [];
  const seenSlugs = new Set<string>();
  const seenAddresses = new Set<string>();

  const tryAddRow = (
    row: (typeof normalized)[number],
    budgets: { slugs: number; addresses: number },
  ): boolean => {
    if (row.tradeType === "amm") {
      if (!row.address || seenAddresses.has(row.address)) return false;
      if (addresses.length >= budgets.addresses) return false;
      seenAddresses.add(row.address);
      addresses.push(row.address);
      return true;
    }

    if (!row.slug || seenSlugs.has(row.slug)) return false;
    if (slugs.length >= budgets.slugs) return false;
    seenSlugs.add(row.slug);
    slugs.push(row.slug);
    return true;
  };

  for (const row of normalized) {
    if (slugs.length + addresses.length >= totalLimit) break;
    tryAddRow(row, { slugs: slugBudget, addresses: addressBudget });
  }

  if (slugs.length < slugBudget) {
    addressBudget = Math.min(totalLimit - slugs.length, totalLimit);
    slugBudget = totalLimit - addressBudget;
  } else if (addresses.length < addressBudget) {
    slugBudget = Math.min(totalLimit - addresses.length, totalLimit);
    addressBudget = totalLimit - slugBudget;
  }

  for (const row of normalized) {
    if (slugs.length + addresses.length >= totalLimit) break;
    tryAddRow(row, { slugs: slugBudget, addresses: addressBudget });
  }

  if (slugs.length + addresses.length < totalLimit) {
    for (const row of normalized) {
      if (slugs.length + addresses.length >= totalLimit) break;
      if (row.tradeType === "amm") {
        if (!row.address || seenAddresses.has(row.address)) continue;
        seenAddresses.add(row.address);
        addresses.push(row.address);
      } else {
        if (!row.slug || seenSlugs.has(row.slug)) continue;
        seenSlugs.add(row.slug);
        slugs.push(row.slug);
      }
    }
  }

  return {
    slugs: slugs.slice(0, totalLimit),
    addresses: addresses.slice(0, totalLimit),
  };
}

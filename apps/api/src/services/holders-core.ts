import { isAbortError, isRpcRateLimit, sleep } from "@hunch/shared";
import type { PoolClient } from "pg";

import { pool } from "../db.js";
import { env } from "../env.js";
import { isRecord } from "../lib/type-guards.js";
import {
  fetchSolanaTokenAccountOwners,
  fetchSolanaTokenLargestAccounts,
} from "./solana-rpc.js";

export type MarketRow = {
  id: string;
  venue: string;
  title: string;
  outcomes: string | null;
  condition_id: string | null;
  token_yes: string | null;
  token_no: string | null;
  clob_token_ids: string | null;
  best_bid: string | null;
  best_ask: string | null;
  last_price: string | null;
};

export type TokenRow = {
  token_id: string;
  side: "YES" | "NO";
};

type TopRow = {
  token_id: string;
  best_bid: string | null;
  best_ask: string | null;
};

export type HolderEntry = {
  wallet: string;
  side: "YES" | "NO";
  shares: number;
};

export type MarketHolderData = {
  market: MarketRow;
  holders: HolderEntry[];
  tokenIdsBySide: { YES: string | null; NO: string | null };
  priceBySide: Record<"YES" | "NO", number | null>;
  outcomeLabels: Record<"YES" | "NO", string>;
  source: string;
  asOf: string;
};

type Queryable = Pick<PoolClient, "query">;

const POLYMARKET_HOLDER_LIMIT = 20;
const HOLDERS_TIMEOUT_MS = 10_000;
const HOLDERS_RETRY_ATTEMPTS = 2;
const HOLDERS_RETRY_DELAY_MS = 250;

function parseOutcomes(outcomes: string | null): string[] {
  if (!outcomes) return [];
  try {
    const parsed = JSON.parse(outcomes) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.map((value) =>
      typeof value === "string" && value.trim().length
        ? value.trim()
        : String(value),
    );
  } catch {
    return [];
  }
}

function resolveTokenIds(
  tokens: TokenRow[],
  market: MarketRow,
): { YES?: string; NO?: string } {
  const bySide: { YES?: string; NO?: string } = {};
  for (const token of tokens) {
    if (token.side === "YES") bySide.YES = token.token_id;
    if (token.side === "NO") bySide.NO = token.token_id;
  }

  if (bySide.YES && bySide.NO) return bySide;

  if (market.token_yes) bySide.YES = bySide.YES ?? market.token_yes;
  if (market.token_no) bySide.NO = bySide.NO ?? market.token_no;

  if (bySide.YES && bySide.NO) return bySide;

  if (market.clob_token_ids) {
    try {
      const parsed = JSON.parse(market.clob_token_ids) as unknown;
      if (Array.isArray(parsed)) {
        const yes = parsed[0];
        const no = parsed[1];
        if (typeof yes === "string" && yes.length) {
          bySide.YES = bySide.YES ?? yes;
        }
        if (typeof no === "string" && no.length) {
          bySide.NO = bySide.NO ?? no;
        }
      }
    } catch {
      return bySide;
    }
  }

  return bySide;
}

function resolveMidPrice(
  bid: string | null,
  ask: string | null,
): number | null {
  const bidNum = bid ? Number(bid) : null;
  const askNum = ask ? Number(ask) : null;
  if (bidNum != null && askNum != null) return (bidNum + askNum) / 2;
  if (bidNum != null) return bidNum;
  if (askNum != null) return askNum;
  return null;
}

function clampProb(value: number | null): number | null {
  if (value == null || !Number.isFinite(value)) return null;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

function normalizeTokenId(value: string | null | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed.length) return null;
  const parts = trimmed.split(":");
  return parts[parts.length - 1] ?? null;
}

function normalizeSolanaMint(value: string | null | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed.length) return null;
  if (trimmed.startsWith("sol:")) return trimmed.slice(4);
  return trimmed;
}

function pickHolderWallet(holder: Record<string, unknown>): string | null {
  const candidates = [
    holder.proxyWallet,
    holder.wallet,
    holder.address,
    holder.owner,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim().length) {
      return candidate;
    }
  }
  return null;
}

function parseNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim().length) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

async function fetchPolymarketHolders(inputs: {
  conditionId: string;
  limit: number;
}): Promise<{ wallet: string; outcomeIndex: number; shares: number }[]> {
  const url = new URL("/holders", env.polymarketDataApiBase);
  url.searchParams.set("limit", String(inputs.limit));
  url.searchParams.set("minBalance", "1");
  url.searchParams.set("market", inputs.conditionId);

  for (let attempt = 0; attempt < HOLDERS_RETRY_ATTEMPTS; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), HOLDERS_TIMEOUT_MS);
    try {
      const response = await fetch(url.toString(), {
        method: "GET",
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new Error(`Polymarket holders failed: ${response.status}`);
      }
      const payload = (await response.json()) as unknown;
      const entries = Array.isArray(payload) ? payload : [];
      const results: {
        wallet: string;
        outcomeIndex: number;
        shares: number;
      }[] = [];

      for (const token of entries) {
        if (!isRecord(token)) continue;
        const holders = Array.isArray(token.holders) ? token.holders : [];
        for (const holder of holders) {
          if (!isRecord(holder)) continue;
          const wallet = pickHolderWallet(holder);
          if (!wallet) continue;
          const shares = parseNumber(holder.amount);
          if (shares == null || shares <= 0) continue;
          const outcomeIndex = parseNumber(holder.outcomeIndex);
          if (outcomeIndex == null) continue;
          results.push({
            wallet,
            outcomeIndex: Math.round(outcomeIndex),
            shares,
          });
        }
      }
      return results;
    } catch (error) {
      if (isAbortError(error)) {
        if (attempt < HOLDERS_RETRY_ATTEMPTS - 1) {
          await sleep(HOLDERS_RETRY_DELAY_MS);
          continue;
        }
        return [];
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  return [];
}

async function fetchAlchemyOwners(inputs: {
  baseUrl: string;
  contractAddress: string;
  tokenId: string;
  limit: number;
}): Promise<{ wallet: string; shares: number }[]> {
  if (!inputs.baseUrl) return [];
  const url = new URL(
    `${inputs.baseUrl.replace(/\/$/, "")}/getOwnersForNFT`,
  );
  url.searchParams.set("contractAddress", inputs.contractAddress);
  url.searchParams.set("tokenId", inputs.tokenId);
  url.searchParams.set("pageSize", String(inputs.limit));
  url.searchParams.set("withTokenBalances", "true");

  for (let attempt = 0; attempt < HOLDERS_RETRY_ATTEMPTS; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), HOLDERS_TIMEOUT_MS);
    try {
      const response = await fetch(url.toString(), {
        method: "GET",
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new Error(`Alchemy owners failed: ${response.status}`);
      }
      const payload = (await response.json()) as unknown;
      const ownersRaw = isRecord(payload) && Array.isArray(payload.owners)
        ? payload.owners
        : [];
      const owners: { wallet: string; shares: number }[] = [];

      for (const owner of ownersRaw) {
        if (typeof owner === "string") {
          owners.push({ wallet: owner, shares: 1 });
          continue;
        }
        if (!isRecord(owner)) continue;
        const wallet = pickHolderWallet(owner);
        if (!wallet) continue;

        const directBalance = parseNumber(owner.balance);
        if (directBalance != null) {
          owners.push({ wallet, shares: directBalance });
          continue;
        }

        const tokenBalances = Array.isArray(owner.tokenBalances)
          ? owner.tokenBalances
          : [];
        const tokenBalance = tokenBalances.find((entry) => isRecord(entry));
        const balance = tokenBalance ? parseNumber(tokenBalance.balance) : null;
        if (balance != null) {
          owners.push({ wallet, shares: balance });
          continue;
        }

        owners.push({ wallet, shares: 1 });
      }

      return owners;
    } catch (error) {
      if (isAbortError(error)) {
        if (attempt < HOLDERS_RETRY_ATTEMPTS - 1) {
          await sleep(HOLDERS_RETRY_DELAY_MS);
          continue;
        }
        return [];
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  return [];
}

async function fetchSolanaHolders(inputs: {
  mint: string;
  limit: number;
}): Promise<{ wallet: string; shares: number }[]> {
  const largest = await fetchSolanaTokenLargestAccounts({
    rpcUrls: env.solanaRpcUrls,
    timeoutMs: env.solanaRpcTimeoutMs,
    mint: inputs.mint,
  });
  const topAccounts = largest.slice(0, inputs.limit);
  const owners = await fetchSolanaTokenAccountOwners({
    rpcUrls: env.solanaRpcUrls,
    timeoutMs: env.solanaRpcTimeoutMs,
    accounts: topAccounts.map((entry) => entry.address),
  });

  return topAccounts.map((entry) => ({
    wallet: owners[entry.address] ?? entry.address,
    shares: parseNumber(entry.uiAmountString) ?? 0,
  }));
}

function isSolanaMintNotFound(error: unknown): boolean {
  if (!error) return false;
  const message =
    error instanceof Error ? error.message : String(error);
  return (
    message.includes("could not find mint") ||
    message.includes("Invalid param: could not find mint") ||
    message.includes("Invalid param")
  );
}

export async function fetchMarketHolderData(inputs: {
  marketId: string;
  limit: number;
  client?: PoolClient;
}): Promise<MarketHolderData> {
  const db: Queryable = inputs.client ?? pool;
  const { rows: markets } = await db.query<MarketRow>(
    `
      select id, venue, title, outcomes, condition_id, token_yes, token_no, clob_token_ids,
             best_bid, best_ask, last_price
      from unified_markets
      where id = $1
    `,
    [inputs.marketId],
  );

  const market = markets[0];
  if (!market) {
    throw new Error("Market not found");
  }

  const { rows: tokens } = await db.query<TokenRow>(
    `
      select token_id, side
      from unified_tokens
      where market_id = $1
    `,
    [inputs.marketId],
  );

  const tokenIdsBySide = resolveTokenIds(tokens, market);
  const yesToken = tokenIdsBySide.YES ?? null;
  const noToken = tokenIdsBySide.NO ?? null;
  const tokenIds = [yesToken, noToken].filter(
    (token): token is string => Boolean(token),
  );

  const priceBySide: Record<"YES" | "NO", number | null> = {
    YES: null,
    NO: null,
  };

  if (tokenIds.length > 0) {
    const { rows: topRows } = await db.query<TopRow>(
      `
        select distinct on (token_id)
          token_id,
          best_bid,
          best_ask
        from unified_book_top
        where token_id = any($1::text[])
        order by token_id, ts desc
      `,
      [tokenIds],
    );

    for (const row of topRows) {
      if (row.token_id === yesToken) {
        priceBySide.YES = resolveMidPrice(row.best_bid, row.best_ask);
      }
      if (row.token_id === noToken) {
        priceBySide.NO = resolveMidPrice(row.best_bid, row.best_ask);
      }
    }

    const missingTokenIds = tokenIds.filter((tokenId) => {
      if (tokenId === yesToken && priceBySide.YES == null) return true;
      if (tokenId === noToken && priceBySide.NO == null) return true;
      return false;
    });

    if (missingTokenIds.length > 0) {
      const { rows: lastRows } = await db.query<{
        token_id: string;
        price: string | null;
      }>(
        `
          select distinct on (token_id)
            token_id,
            price
          from unified_last_trade
          where token_id = any($1::text[])
          order by token_id, ts desc
        `,
        [missingTokenIds],
      );

      for (const row of lastRows) {
        const price =
          row.price != null ? Number(row.price) : null;
        if (row.token_id === yesToken && priceBySide.YES == null) {
          priceBySide.YES = price;
        }
        if (row.token_id === noToken && priceBySide.NO == null) {
          priceBySide.NO = price;
        }
      }
    }
  }

  if (priceBySide.YES == null || priceBySide.NO == null) {
    const marketYes = clampProb(
      resolveMidPrice(market.best_bid, market.best_ask) ??
        (market.last_price != null ? Number(market.last_price) : null),
    );
    if (priceBySide.YES == null && marketYes != null) {
      priceBySide.YES = marketYes;
    }
    if (priceBySide.NO == null && marketYes != null) {
      priceBySide.NO = clampProb(1 - marketYes);
    }
  }

  if (priceBySide.YES == null && priceBySide.NO != null) {
    priceBySide.YES = clampProb(1 - priceBySide.NO);
  }
  if (priceBySide.NO == null && priceBySide.YES != null) {
    priceBySide.NO = clampProb(1 - priceBySide.YES);
  }

  const outcomes = parseOutcomes(market.outcomes);
  const outcomeLabels: Record<"YES" | "NO", string> = {
    YES: outcomes[0] ?? "YES",
    NO: outcomes[1] ?? "NO",
  };

  const holderEntries: HolderEntry[] = [];
  let source = "unavailable";

  if (market.venue === "polymarket" && market.condition_id) {
    source = "polymarket";
    try {
      const holders = await fetchPolymarketHolders({
        conditionId: market.condition_id,
        limit: Math.min(inputs.limit, POLYMARKET_HOLDER_LIMIT),
      });
      for (const holder of holders) {
        let side: "YES" | "NO" | null = null;
        if (holder.outcomeIndex === 0) side = "YES";
        if (holder.outcomeIndex === 1) side = "NO";
        if (!side) continue;
        holderEntries.push({
          wallet: holder.wallet,
          side,
          shares: holder.shares,
        });
      }
    } catch {
      source = "unavailable";
    }
  }

  if (holderEntries.length === 0) {
    const useAlchemy =
      market.venue === "polymarket" || market.venue === "limitless";
    if (useAlchemy) {
      const baseUrl =
        market.venue === "polymarket"
          ? env.alchemyPolygonNftBaseUrl
          : env.alchemyBaseNftBaseUrl;
      const contractAddress =
        market.venue === "polymarket"
          ? env.polymarketConditionalTokensAddress
          : env.limitlessConditionalTokensAddress;
      if (baseUrl && contractAddress) {
        source = "alchemy";
        const yesId = normalizeTokenId(yesToken);
        const noId = normalizeTokenId(noToken);
        const [yesOwners, noOwners] = await Promise.all([
          yesId
            ? fetchAlchemyOwners({
                baseUrl,
                contractAddress,
                tokenId: yesId,
                limit: inputs.limit,
              })
            : Promise.resolve([]),
          noId
            ? fetchAlchemyOwners({
                baseUrl,
                contractAddress,
                tokenId: noId,
                limit: inputs.limit,
              })
            : Promise.resolve([]),
        ]);
        for (const owner of yesOwners) {
          holderEntries.push({
            wallet: owner.wallet,
            side: "YES",
            shares: owner.shares,
          });
        }
        for (const owner of noOwners) {
          holderEntries.push({
            wallet: owner.wallet,
            side: "NO",
            shares: owner.shares,
          });
        }
      }
    }
  }

  if (holderEntries.length === 0 && market.venue === "kalshi") {
    const yesMint = normalizeSolanaMint(yesToken);
    const noMint = normalizeSolanaMint(noToken);
    source = "solana";
    const safeFetch = async (mint: string | null) => {
      if (!mint) return [];
      const retry = 2;
      const backoffMs = 250;
      const delayMs = 50;
      let attempt = 0;
      while (true) {
        try {
          const owners = await fetchSolanaHolders({ mint, limit: inputs.limit });
          if (delayMs > 0) await sleep(delayMs);
          return owners;
        } catch (error) {
          if (isSolanaMintNotFound(error)) {
            return [];
          }
          if ((isRpcRateLimit(error) || isAbortError(error)) && attempt < retry) {
            await sleep(backoffMs * Math.max(1, 2 ** attempt));
            attempt += 1;
            continue;
          }
          throw error;
        }
      }
    };
    const yesOwners = await safeFetch(yesMint);
    const noOwners = await safeFetch(noMint);
    for (const owner of yesOwners) {
      holderEntries.push({
        wallet: owner.wallet,
        side: "YES",
        shares: owner.shares,
      });
    }
    for (const owner of noOwners) {
      holderEntries.push({
        wallet: owner.wallet,
        side: "NO",
        shares: owner.shares,
      });
    }
  }

  const holders = holderEntries
    .filter((entry) => Number.isFinite(entry.shares) && entry.shares > 0)
    .sort((a, b) => b.shares - a.shares)
    .slice(0, inputs.limit);

  return {
    market,
    holders,
    tokenIdsBySide: {
      YES: yesToken,
      NO: noToken,
    },
    priceBySide,
    outcomeLabels,
    source,
    asOf: new Date().toISOString(),
  };
}

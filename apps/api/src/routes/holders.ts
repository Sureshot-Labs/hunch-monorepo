import type { FastifyPluginAsync } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { pool } from "../db.js";
import { env } from "../env.js";
import { isRecord } from "../lib/type-guards.js";
import { getRedis } from "../redis.js";
import { holdersQuerySchema } from "../schemas/holders.js";
import {
  fetchSolanaTokenAccountOwners,
  fetchSolanaTokenLargestAccounts,
} from "../services/solana-rpc.js";

type MarketRow = {
  id: string;
  venue: string;
  title: string;
  outcomes: string | null;
  condition_id: string | null;
  token_yes: string | null;
  token_no: string | null;
  clob_token_ids: string | null;
};

type TokenRow = {
  token_id: string;
  side: "YES" | "NO";
};

type TopRow = {
  token_id: string;
  best_bid: string | null;
  best_ask: string | null;
};

type HolderEntry = {
  wallet: string;
  side: "YES" | "NO";
  shares: number;
};

type HolderRow = {
  rank: number;
  wallet: string;
  market: string;
  outcome: string;
  shares: number;
  price: number | null;
  value: number | null;
};

const POLYMARKET_HOLDER_LIMIT = 20;
const HOLDERS_TIMEOUT_MS = 10_000;

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
    const results: { wallet: string; outcomeIndex: number; shares: number }[] =
      [];

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
  } finally {
    clearTimeout(timeout);
  }
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
  } finally {
    clearTimeout(timeout);
  }
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

export const holdersRoutes: FastifyPluginAsync = async (app) => {
  const z = app.withTypeProvider<ZodTypeProvider>();

  z.get(
    "/holders",
    {
      schema: { querystring: holdersQuerySchema },
    },
    async (request, reply) => {
      const { marketId, limit } = request.query;

      if (!marketId) {
        reply.code(400);
        return { error: "marketId is required" };
      }

      const cacheKey = `holders:v1:${marketId}:${limit}`;
      const cacheTtl = env.holdersTtlSec > 0 ? env.holdersTtlSec : 300;
      const r = await getRedis();

      if (r) {
        const cached = await r.get(cacheKey);
        if (cached) {
          reply.header("x-cache", "hit");
          reply.header("Content-Type", "application/json; charset=utf-8");
          reply.header(
            "Cache-Control",
            `private, max-age=${cacheTtl}, stale-while-revalidate=${cacheTtl * 2}`,
          );
          return reply.send(cached);
        }
      }

      const { rows: markets } = await pool.query<MarketRow>(
        `
          select id, venue, title, outcomes, condition_id, token_yes, token_no, clob_token_ids
          from unified_markets
          where id = $1
        `,
        [marketId],
      );

      const market = markets[0];
      if (!market) {
        reply.code(404);
        return { error: "Market not found" };
      }

      const { rows: tokens } = await pool.query<TokenRow>(
        `
          select token_id, side
          from unified_tokens
          where market_id = $1
        `,
        [marketId],
      );

      const tokenIdsBySide = resolveTokenIds(tokens, market);
      const yesToken = tokenIdsBySide.YES ?? null;
      const noToken = tokenIdsBySide.NO ?? null;

      const tokenIds = [yesToken, noToken].filter(
        (token): token is string => Boolean(token),
      );

      if (tokenIds.length === 0) {
        return {
          marketId,
          venue: market.venue,
          asOf: new Date().toISOString(),
          holders: [],
          source: "unavailable",
        };
      }

      const { rows: topRows } = await pool.query<TopRow>(
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

      const priceBySide: Record<"YES" | "NO", number | null> = {
        YES: null,
        NO: null,
      };

      for (const row of topRows) {
        if (row.token_id === yesToken) {
          priceBySide.YES = resolveMidPrice(row.best_bid, row.best_ask);
        }
        if (row.token_id === noToken) {
          priceBySide.NO = resolveMidPrice(row.best_bid, row.best_ask);
        }
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
            limit: Math.min(limit, POLYMARKET_HOLDER_LIMIT),
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
                    limit,
                  })
                : Promise.resolve([]),
              noId
                ? fetchAlchemyOwners({
                    baseUrl,
                    contractAddress,
                    tokenId: noId,
                    limit,
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
        const [yesOwners, noOwners] = await Promise.all([
          yesMint ? fetchSolanaHolders({ mint: yesMint, limit }) : [],
          noMint ? fetchSolanaHolders({ mint: noMint, limit }) : [],
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

      const holders = holderEntries
        .filter((entry) => Number.isFinite(entry.shares) && entry.shares > 0)
        .sort((a, b) => b.shares - a.shares)
        .slice(0, limit)
        .map((entry, index): HolderRow => {
          const price = priceBySide[entry.side];
          const value =
            price != null ? Number((price * entry.shares).toFixed(6)) : null;
          return {
            rank: index + 1,
            wallet: entry.wallet,
            market: market.title,
            outcome: outcomeLabels[entry.side],
            shares: entry.shares,
            price,
            value,
          };
        });

      const response = {
        marketId,
        venue: market.venue,
        asOf: new Date().toISOString(),
        holders,
        source,
      };

      const responseBody = JSON.stringify(response);
      if (r) {
        await r.set(cacheKey, responseBody, { EX: cacheTtl });
        reply.header("x-cache", "miss");
      }
      reply.header("Content-Type", "application/json; charset=utf-8");
      reply.header(
        "Cache-Control",
        `private, max-age=${cacheTtl}, stale-while-revalidate=${cacheTtl * 2}`,
      );
      return reply.send(responseBody);
    },
  );
};

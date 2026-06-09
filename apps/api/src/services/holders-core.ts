import { isAbortError, isRpcRateLimit } from "@hunch/shared";
import { ethers } from "ethers";
import type { PoolClient } from "pg";

import { pool } from "../db.js";
import { env } from "../env.js";
import { isRecord } from "../lib/type-guards.js";
import { fetchErc1155BalancesForOwnerTokenPairs } from "./polygon-rpc.js";
import {
  fetchSolanaTokenAccountOwners,
  fetchSolanaTokenLargestAccounts,
} from "./solana-rpc.js";
import {
  fetchWithWalletIntelRetry,
  type WalletIntelRetryTelemetry,
} from "./wallet-intel-retry.js";

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
type MarketHolderTelemetry = {
  holdersPolymarket?: WalletIntelRetryTelemetry | null;
  holdersAlchemyPolygon?: WalletIntelRetryTelemetry | null;
  holdersAlchemyBase?: WalletIntelRetryTelemetry | null;
  holdersLimitlessBalanceVerify?: WalletIntelRetryTelemetry | null;
  holdersSolana?: WalletIntelRetryTelemetry | null;
  holdersSolanaLargestAccounts?: WalletIntelRetryTelemetry | null;
  holdersSolanaOwnerLookup?: WalletIntelRetryTelemetry | null;
};

const POLYMARKET_HOLDER_LIMIT = 20;
const HOLDERS_TIMEOUT_MS = 10_000;
const LIMITLESS_BALANCE_BATCH_MAX_PAIRS = 200;

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
    holder.ownerAddress,
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
  telemetry?: WalletIntelRetryTelemetry | null;
}): Promise<{ wallet: string; outcomeIndex: number; shares: number }[]> {
  const url = new URL("/holders", env.polymarketDataApiBase);
  url.searchParams.set("limit", String(inputs.limit));
  url.searchParams.set("minBalance", "1");
  url.searchParams.set("market", inputs.conditionId);

  const response = await fetchWithWalletIntelRetry({
    url: url.toString(),
    init: { method: "GET" },
    timeoutMs: HOLDERS_TIMEOUT_MS,
    allowRetry: true,
    telemetry: inputs.telemetry,
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
}

async function fetchAlchemyOwners(inputs: {
  baseUrl: string;
  contractAddress: string;
  tokenId: string;
  limit: number;
  telemetry?: WalletIntelRetryTelemetry | null;
}): Promise<{ wallet: string; shares: number }[]> {
  if (!inputs.baseUrl) return [];
  const url = new URL(`${inputs.baseUrl.replace(/\/$/, "")}/getOwnersForNFT`);
  url.searchParams.set("contractAddress", inputs.contractAddress);
  url.searchParams.set("tokenId", inputs.tokenId);
  url.searchParams.set("pageSize", String(inputs.limit));
  url.searchParams.set("withTokenBalances", "true");

  const response = await fetchWithWalletIntelRetry({
    url: url.toString(),
    init: { method: "GET" },
    timeoutMs: HOLDERS_TIMEOUT_MS,
    allowRetry: true,
    telemetry: inputs.telemetry,
  });
  if (!response.ok) {
    throw new Error(`Alchemy owners failed: ${response.status}`);
  }
  const payload = (await response.json()) as unknown;
  const ownersRaw =
    isRecord(payload) && Array.isArray(payload.owners) ? payload.owners : [];
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
}

function normalizeEvmAddress(value: string): string | null {
  try {
    const address = ethers.getAddress(value);
    return address === ethers.ZeroAddress ? null : address;
  } catch {
    return null;
  }
}

async function fetchLimitlessVerifiedAlchemyHolders(inputs: {
  yesId: string | null;
  noId: string | null;
  yesOwners: Array<{ wallet: string; shares: number }>;
  noOwners: Array<{ wallet: string; shares: number }>;
  telemetry?: WalletIntelRetryTelemetry | null;
}): Promise<HolderEntry[]> {
  const pairs: Array<{ owner: string; tokenId: string }> = [];
  const appendPairs = (
    tokenId: string | null,
    owners: Array<{ wallet: string; shares: number }>,
  ) => {
    if (!tokenId) return;
    for (const owner of owners) {
      const address = normalizeEvmAddress(owner.wallet);
      if (!address) continue;
      pairs.push({ owner: address, tokenId });
    }
  };
  appendPairs(inputs.yesId, inputs.yesOwners);
  appendPairs(inputs.noId, inputs.noOwners);
  if (pairs.length === 0) return [];

  recordTelemetryAttempt(
    inputs.telemetry,
    Math.ceil(pairs.length / LIMITLESS_BALANCE_BATCH_MAX_PAIRS),
  );
  let balancesByOwner: Map<string, Map<string, bigint>>;
  try {
    balancesByOwner = await fetchErc1155BalancesForOwnerTokenPairs({
      rpcUrl: env.baseRpcUrl,
      timeoutMs: env.baseRpcTimeoutMs,
      contractAddress: env.limitlessConditionalTokensAddress,
      pairs,
      maxPairsPerCall: LIMITLESS_BALANCE_BATCH_MAX_PAIRS,
      onRpcCall: () => recordTelemetryActualCall(inputs.telemetry),
    });
    recordTelemetrySuccess(inputs.telemetry);
  } catch (error) {
    recordTelemetryFailure(inputs.telemetry, error);
    throw error;
  }

  const output: HolderEntry[] = [];
  output.push(
    ...resolveLimitlessVerifiedHoldersFromBalances({
      yesId: inputs.yesId,
      noId: inputs.noId,
      yesOwners: inputs.yesOwners,
      noOwners: inputs.noOwners,
      balancesByOwner,
    }),
  );
  return output;
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
  const message = error instanceof Error ? error.message : String(error);
  return (
    message.includes("could not find mint") ||
    message.includes("Invalid param: could not find mint") ||
    message.includes("Invalid param")
  );
}

type MarketHolderContext = {
  market: MarketRow;
  tokenIdsBySide: { YES: string | null; NO: string | null };
  priceBySide: Record<"YES" | "NO", number | null>;
  outcomeLabels: Record<"YES" | "NO", string>;
};

export type MarketHolderDataBatchResult = {
  market: { id: string; venue: string };
  data: MarketHolderData | null;
  error: unknown | null;
};

function buildMarketHolderData(
  context: MarketHolderContext,
  holders: HolderEntry[],
  source: string,
  limit: number,
): MarketHolderData {
  return {
    market: context.market,
    holders: holders
      .filter((entry) => Number.isFinite(entry.shares) && entry.shares > 0)
      .sort((a, b) => b.shares - a.shares)
      .slice(0, limit),
    tokenIdsBySide: context.tokenIdsBySide,
    priceBySide: context.priceBySide,
    outcomeLabels: context.outcomeLabels,
    source,
    asOf: new Date().toISOString(),
  };
}

async function loadMarketHolderContexts(
  db: Queryable,
  marketIds: string[],
): Promise<Map<string, MarketHolderContext>> {
  const ids = Array.from(new Set(marketIds));
  if (ids.length === 0) return new Map();

  const { rows: markets } = await db.query<MarketRow>(
    `
      select id, venue, title, outcomes, condition_id, token_yes, token_no, clob_token_ids,
             best_bid, best_ask, last_price
      from unified_markets
      where id = any($1::text[])
    `,
    [ids],
  );

  const { rows: tokens } = await db.query<TokenRow & { market_id: string }>(
    `
      select market_id, token_id, side
      from unified_tokens
      where market_id = any($1::text[])
    `,
    [ids],
  );

  const tokensByMarket = new Map<string, TokenRow[]>();
  for (const token of tokens) {
    const list = tokensByMarket.get(token.market_id) ?? [];
    list.push({ token_id: token.token_id, side: token.side });
    tokensByMarket.set(token.market_id, list);
  }

  const rawTokenIdsByMarket = new Map<
    string,
    { YES: string | null; NO: string | null }
  >();
  const allTokenIds: string[] = [];
  for (const market of markets) {
    const tokenIds = resolveTokenIds(tokensByMarket.get(market.id) ?? [], market);
    const yesToken = tokenIds.YES ?? null;
    const noToken = tokenIds.NO ?? null;
    rawTokenIdsByMarket.set(market.id, { YES: yesToken, NO: noToken });
    if (yesToken) allTokenIds.push(yesToken);
    if (noToken) allTokenIds.push(noToken);
  }

  const priceByToken = new Map<string, number | null>();
  if (allTokenIds.length > 0) {
    const { rows: topRows } = await db.query<TopRow>(
      `
        select
          token_id,
          best_bid,
          best_ask
        from unified_token_top_latest
        where token_id = any($1::text[])
      `,
      [allTokenIds],
    );
    for (const row of topRows) {
      priceByToken.set(row.token_id, resolveMidPrice(row.best_bid, row.best_ask));
    }

    const missingTokenIds = Array.from(
      new Set(
        allTokenIds.filter(
          (tokenId) => !priceByToken.has(tokenId) || priceByToken.get(tokenId) == null,
        ),
      ),
    );
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
        priceByToken.set(row.token_id, row.price != null ? Number(row.price) : null);
      }
    }
  }

  const contexts = new Map<string, MarketHolderContext>();
  for (const market of markets) {
    const tokenIdsBySide = rawTokenIdsByMarket.get(market.id) ?? {
      YES: null,
      NO: null,
    };
    const priceBySide: Record<"YES" | "NO", number | null> = {
      YES: tokenIdsBySide.YES ? (priceByToken.get(tokenIdsBySide.YES) ?? null) : null,
      NO: tokenIdsBySide.NO ? (priceByToken.get(tokenIdsBySide.NO) ?? null) : null,
    };

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
    contexts.set(market.id, {
      market,
      tokenIdsBySide,
      priceBySide,
      outcomeLabels: {
        YES: outcomes[0] ?? "YES",
        NO: outcomes[1] ?? "NO",
      },
    });
  }

  return contexts;
}

async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  handler: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (items.length === 0) return [];
  const concurrency = Math.max(1, Math.min(Math.trunc(limit), items.length));
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  const workers = Array.from({ length: concurrency }, async () => {
    while (true) {
      const index = nextIndex++;
      if (index >= items.length) return;
      results[index] = await handler(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

function recordTelemetryAttempt(
  bucket: WalletIntelRetryTelemetry | null | undefined,
  estimatedCalls = 0,
) {
  if (!bucket) return;
  bucket.attempted += 1;
  bucket.estimatedCalls += estimatedCalls;
}

function recordTelemetryActualCall(
  bucket: WalletIntelRetryTelemetry | null | undefined,
) {
  if (!bucket) return;
  bucket.actualCalls += 1;
}

function recordTelemetrySuccess(
  bucket: WalletIntelRetryTelemetry | null | undefined,
) {
  if (!bucket) return;
  bucket.succeeded += 1;
}

function recordTelemetryFailure(
  bucket: WalletIntelRetryTelemetry | null | undefined,
  error: unknown,
) {
  if (!bucket) return;
  bucket.failed += 1;
  if (isAbortError(error)) bucket.aborted += 1;
  else if (isRpcRateLimit(error)) bucket.rateLimited += 1;
  else bucket.otherErrors += 1;
}

function resolveLimitlessVerifiedHoldersFromBalances(inputs: {
  yesId: string | null;
  noId: string | null;
  yesOwners: Array<{ wallet: string; shares: number }>;
  noOwners: Array<{ wallet: string; shares: number }>;
  balancesByOwner: Map<string, Map<string, bigint>>;
}): HolderEntry[] {
  const output: HolderEntry[] = [];
  const appendSide = (
    side: "YES" | "NO",
    tokenId: string | null,
    ownersForSide: Array<{ wallet: string; shares: number }>,
  ) => {
    if (!tokenId) return;
    const seen = new Set<string>();
    for (const owner of ownersForSide) {
      const address = normalizeEvmAddress(owner.wallet);
      if (!address) continue;
      const ownerKey = address.toLowerCase();
      if (seen.has(ownerKey)) continue;
      seen.add(ownerKey);

      const balance = inputs.balancesByOwner.get(ownerKey)?.get(tokenId) ?? 0n;
      if (balance <= 0n) continue;
      const shares = Number(ethers.formatUnits(balance, 6));
      if (!Number.isFinite(shares) || shares <= 0) continue;
      output.push({ wallet: address, side, shares });
    }
  };

  appendSide("YES", inputs.yesId, inputs.yesOwners);
  appendSide("NO", inputs.noId, inputs.noOwners);
  return output;
}

export async function fetchMarketHolderData(inputs: {
  marketId: string;
  limit: number;
  client?: PoolClient;
  telemetry?: MarketHolderTelemetry;
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
  const tokenIds = [yesToken, noToken].filter((token): token is string =>
    Boolean(token),
  );

  const priceBySide: Record<"YES" | "NO", number | null> = {
    YES: null,
    NO: null,
  };

  if (tokenIds.length > 0) {
    const { rows: topRows } = await db.query<TopRow>(
      `
        select
          token_id,
          best_bid,
          best_ask
        from unified_token_top_latest
        where token_id = any($1::text[])
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
        const price = row.price != null ? Number(row.price) : null;
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
        telemetry: inputs.telemetry?.holdersPolymarket ?? null,
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
        let alchemyFailed = false;
        const fetchAlchemyOwnersSafe = async (
          tokenId: string | null,
          telemetry: WalletIntelRetryTelemetry | null,
        ): Promise<{ wallet: string; shares: number }[]> => {
          if (!tokenId) return [];
          try {
            return await fetchAlchemyOwners({
              baseUrl,
              contractAddress,
              tokenId,
              limit: inputs.limit,
              telemetry,
            });
          } catch {
            alchemyFailed = true;
            return [];
          }
        };
        const [yesOwners, noOwners] = await Promise.all([
          fetchAlchemyOwnersSafe(
            yesId,
            market.venue === "polymarket"
              ? (inputs.telemetry?.holdersAlchemyPolygon ?? null)
              : (inputs.telemetry?.holdersAlchemyBase ?? null),
          ),
          fetchAlchemyOwnersSafe(
            noId,
            market.venue === "polymarket"
              ? (inputs.telemetry?.holdersAlchemyPolygon ?? null)
              : (inputs.telemetry?.holdersAlchemyBase ?? null),
          ),
        ]);
        if (alchemyFailed) {
          source = "unavailable";
        } else if (market.venue === "limitless") {
          try {
            holderEntries.push(
              ...(await fetchLimitlessVerifiedAlchemyHolders({
                yesId,
                noId,
                yesOwners,
                noOwners,
                telemetry: inputs.telemetry?.holdersLimitlessBalanceVerify,
              })),
            );
          } catch {
            source = "unavailable";
          }
        } else {
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
  }

  if (holderEntries.length === 0 && market.venue === "kalshi") {
    const yesMint = normalizeSolanaMint(yesToken);
    const noMint = normalizeSolanaMint(noToken);
    source = "solana";
    let solanaFailed = false;
    const safeFetch = async (mint: string | null) => {
      if (!mint) return [];
      const telemetry = inputs.telemetry?.holdersSolana ?? null;
      if (telemetry) {
        telemetry.attempted += 1;
        telemetry.estimatedCalls += 2;
        telemetry.actualCalls += 1;
      }
      try {
        const owners = await fetchSolanaHolders({ mint, limit: inputs.limit });
        if (telemetry) telemetry.succeeded += 1;
        return owners;
      } catch (error) {
        if (isSolanaMintNotFound(error)) {
          if (telemetry) telemetry.succeeded += 1;
          return [];
        }
        solanaFailed = true;
        if (telemetry) {
          telemetry.failed += 1;
          if (isAbortError(error)) telemetry.aborted += 1;
          else if (isRpcRateLimit(error)) telemetry.rateLimited += 1;
          else telemetry.otherErrors += 1;
        }
        return [];
      }
    };
    const yesOwners = await safeFetch(yesMint);
    const noOwners = await safeFetch(noMint);
    if (solanaFailed) {
      source = "unavailable";
    } else {
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

export async function fetchMarketHolderDataBatch(inputs: {
  markets: Array<{ id: string; venue: string }>;
  limit: number;
  client?: PoolClient;
  marketFetchConcurrency?: number;
  telemetry?: MarketHolderTelemetry;
}): Promise<MarketHolderDataBatchResult[]> {
  const db: Queryable = inputs.client ?? pool;
  const concurrency = inputs.marketFetchConcurrency ?? 2;
  const contexts = await loadMarketHolderContexts(
    db,
    inputs.markets.map((market) => market.id),
  );
  const results = new Map<string, MarketHolderDataBatchResult>();

  for (const market of inputs.markets) {
    if (!contexts.has(market.id)) {
      results.set(market.id, {
        market,
        data: null,
        error: new Error("Market not found"),
      });
    }
  }

  const polymarketContexts = Array.from(contexts.values()).filter(
    (context) => context.market.venue === "polymarket",
  );
  const limitlessContexts = Array.from(contexts.values()).filter(
    (context) => context.market.venue === "limitless",
  );
  const kalshiContexts = Array.from(contexts.values()).filter(
    (context) => context.market.venue === "kalshi",
  );

  await mapWithConcurrency(polymarketContexts, concurrency, async (context) => {
    try {
      const data = await fetchMarketHolderData({
        marketId: context.market.id,
        limit: inputs.limit,
        client: inputs.client,
        telemetry: inputs.telemetry,
      });
      results.set(context.market.id, {
        market: context.market,
        data,
        error: null,
      });
    } catch (error) {
      results.set(context.market.id, {
        market: context.market,
        data: null,
        error,
      });
    }
  });

  type LimitlessCandidate = {
    context: MarketHolderContext;
    yesId: string | null;
    noId: string | null;
    yesOwners: Array<{ wallet: string; shares: number }>;
    noOwners: Array<{ wallet: string; shares: number }>;
    failed: boolean;
  };
  const limitlessCandidates = await mapWithConcurrency(
    limitlessContexts,
    concurrency,
    async (context): Promise<LimitlessCandidate> => {
      const yesId = normalizeTokenId(context.tokenIdsBySide.YES);
      const noId = normalizeTokenId(context.tokenIdsBySide.NO);
      const hasAlchemyConfig = Boolean(
        env.alchemyBaseNftBaseUrl && env.limitlessConditionalTokensAddress,
      );
      let failed = !hasAlchemyConfig;
      const fetchOwners = async (tokenId: string | null) => {
        if (!tokenId || !hasAlchemyConfig) return [];
        try {
          return await fetchAlchemyOwners({
            baseUrl: env.alchemyBaseNftBaseUrl,
            contractAddress: env.limitlessConditionalTokensAddress,
            tokenId,
            limit: inputs.limit,
            telemetry: inputs.telemetry?.holdersAlchemyBase ?? null,
          });
        } catch {
          failed = true;
          return [];
        }
      };
      const [yesOwners, noOwners] = await Promise.all([
        fetchOwners(yesId),
        fetchOwners(noId),
      ]);
      return { context, yesId, noId, yesOwners, noOwners, failed };
    },
  );

  const limitlessPairs: Array<{ owner: string; tokenId: string }> = [];
  for (const candidate of limitlessCandidates) {
    if (candidate.failed) continue;
    const appendPairs = (
      tokenId: string | null,
      owners: Array<{ wallet: string; shares: number }>,
    ) => {
      if (!tokenId) return;
      for (const owner of owners) {
        const address = normalizeEvmAddress(owner.wallet);
        if (!address) continue;
        limitlessPairs.push({ owner: address, tokenId });
      }
    };
    appendPairs(candidate.yesId, candidate.yesOwners);
    appendPairs(candidate.noId, candidate.noOwners);
  }

  let limitlessBalancesByOwner = new Map<string, Map<string, bigint>>();
  let limitlessBalanceError: unknown = null;
  if (limitlessPairs.length > 0) {
    const bucket = inputs.telemetry?.holdersLimitlessBalanceVerify ?? null;
    recordTelemetryAttempt(
      bucket,
      Math.ceil(limitlessPairs.length / LIMITLESS_BALANCE_BATCH_MAX_PAIRS),
    );
    try {
      limitlessBalancesByOwner = await fetchErc1155BalancesForOwnerTokenPairs({
        rpcUrl: env.baseRpcUrl,
        timeoutMs: env.baseRpcTimeoutMs,
        contractAddress: env.limitlessConditionalTokensAddress,
        pairs: limitlessPairs,
        maxPairsPerCall: LIMITLESS_BALANCE_BATCH_MAX_PAIRS,
        onRpcCall: () => recordTelemetryActualCall(bucket),
      });
      recordTelemetrySuccess(bucket);
    } catch (error) {
      limitlessBalanceError = error;
      recordTelemetryFailure(bucket, error);
      console.warn("[holders] Limitless balance verification failed", {
        markets: limitlessContexts.length,
        pairs: limitlessPairs.length,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  for (const candidate of limitlessCandidates) {
    const source =
      candidate.failed || limitlessBalanceError ? "unavailable" : "alchemy";
    const holders =
      source === "alchemy"
        ? resolveLimitlessVerifiedHoldersFromBalances({
            yesId: candidate.yesId,
            noId: candidate.noId,
            yesOwners: candidate.yesOwners,
            noOwners: candidate.noOwners,
            balancesByOwner: limitlessBalancesByOwner,
          })
        : [];
    results.set(candidate.context.market.id, {
      market: candidate.context.market,
      data: buildMarketHolderData(
        candidate.context,
        holders,
        source,
        inputs.limit,
      ),
      error: null,
    });
  }

  type SolanaMintCandidate = {
    context: MarketHolderContext;
    side: "YES" | "NO";
    mint: string;
  };
  const solanaMintCandidates: SolanaMintCandidate[] = [];
  for (const context of kalshiContexts) {
    const yesMint = normalizeSolanaMint(context.tokenIdsBySide.YES);
    const noMint = normalizeSolanaMint(context.tokenIdsBySide.NO);
    if (yesMint) solanaMintCandidates.push({ context, side: "YES", mint: yesMint });
    if (noMint) solanaMintCandidates.push({ context, side: "NO", mint: noMint });
  }

  const solanaFailedMarkets = new Set<string>();
  const solanaLargestByMint = new Map<
    string,
    Awaited<ReturnType<typeof fetchSolanaTokenLargestAccounts>>
  >();
  await mapWithConcurrency(
    solanaMintCandidates,
    concurrency,
    async (candidate) => {
      const aggregateBucket = inputs.telemetry?.holdersSolana ?? null;
      const largestBucket = inputs.telemetry?.holdersSolanaLargestAccounts ?? null;
      recordTelemetryAttempt(aggregateBucket, 1);
      recordTelemetryAttempt(largestBucket, 1);
      recordTelemetryActualCall(aggregateBucket);
      recordTelemetryActualCall(largestBucket);
      try {
        const accounts = await fetchSolanaTokenLargestAccounts({
          rpcUrls: env.solanaRpcUrls,
          timeoutMs: env.solanaRpcTimeoutMs,
          mint: candidate.mint,
        });
        recordTelemetrySuccess(aggregateBucket);
        recordTelemetrySuccess(largestBucket);
        solanaLargestByMint.set(candidate.mint, accounts.slice(0, inputs.limit));
      } catch (error) {
        if (isSolanaMintNotFound(error)) {
          recordTelemetrySuccess(aggregateBucket);
          recordTelemetrySuccess(largestBucket);
          solanaLargestByMint.set(candidate.mint, []);
          return;
        }
        recordTelemetryFailure(aggregateBucket, error);
        recordTelemetryFailure(largestBucket, error);
        solanaFailedMarkets.add(candidate.context.market.id);
      }
    },
  );

  const solanaAccounts = Array.from(
    new Set(
      Array.from(solanaLargestByMint.values()).flatMap((accounts) =>
        accounts.map((account) => account.address),
      ),
    ),
  );
  let solanaOwnersByAccount: Record<string, string | null> = {};
  let solanaOwnerLookupFailed = false;
  if (solanaAccounts.length > 0) {
    const bucket = inputs.telemetry?.holdersSolanaOwnerLookup ?? null;
    const aggregateBucket = inputs.telemetry?.holdersSolana ?? null;
    const estimatedCalls = Math.ceil(solanaAccounts.length / 100);
    recordTelemetryAttempt(bucket, estimatedCalls);
    recordTelemetryAttempt(aggregateBucket, estimatedCalls);
    try {
      solanaOwnersByAccount = await fetchSolanaTokenAccountOwners({
        rpcUrls: env.solanaRpcUrls,
        timeoutMs: env.solanaRpcTimeoutMs,
        accounts: solanaAccounts,
        onRpcCall: () => {
          recordTelemetryActualCall(bucket);
          recordTelemetryActualCall(aggregateBucket);
        },
      });
      recordTelemetrySuccess(bucket);
      recordTelemetrySuccess(aggregateBucket);
    } catch (error) {
      solanaOwnerLookupFailed = true;
      recordTelemetryFailure(bucket, error);
      recordTelemetryFailure(aggregateBucket, error);
    }
  }

  for (const context of kalshiContexts) {
    const holderEntries: HolderEntry[] = [];
    if (!solanaFailedMarkets.has(context.market.id) && !solanaOwnerLookupFailed) {
      const appendSide = (side: "YES" | "NO", tokenId: string | null) => {
        const mint = normalizeSolanaMint(tokenId);
        if (!mint) return;
        const accounts = solanaLargestByMint.get(mint) ?? [];
        for (const account of accounts) {
          const owner = solanaOwnersByAccount[account.address];
          if (!owner) continue;
          const shares = parseNumber(account.uiAmountString) ?? 0;
          if (!Number.isFinite(shares) || shares <= 0) continue;
          holderEntries.push({ wallet: owner, side, shares });
        }
      };
      appendSide("YES", context.tokenIdsBySide.YES);
      appendSide("NO", context.tokenIdsBySide.NO);
    }

    results.set(context.market.id, {
      market: context.market,
      data: buildMarketHolderData(
        context,
        holderEntries,
        solanaFailedMarkets.has(context.market.id) || solanaOwnerLookupFailed
          ? "unavailable"
          : "solana",
        inputs.limit,
      ),
      error: null,
    });
  }

  return inputs.markets.map(
    (market) =>
      results.get(market.id) ?? {
        market,
        data: null,
        error: new Error("Market not found"),
      },
  );
}

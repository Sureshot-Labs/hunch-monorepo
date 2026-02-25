import type { FastifyPluginAsync } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { ethers } from "ethers";

import { AuthService, createAuthMiddleware } from "../auth.js";
import { pool } from "../db.js";
import { env } from "../env.js";
import { verifyProofAddress } from "../services/proof-client.js";
import { fetchSolanaBalanceLamports, fetchSolanaMintDecimals, fetchSolanaTokenBalanceByOwnerAndMint, formatUiAmount } from "../services/solana-rpc.js";
import {
  fetchErc20BalanceOf,
  fetchEvmBalance,
  fetchEvmCode,
} from "../services/polygon-rpc.js";
import { fetchPolymarketOnchainSnapshot } from "../services/polymarket-onchain.js";
import {
  walletBalancesBatchQuerySchema,
  walletBalancesQuerySchema,
  walletVenueStatusQuerySchema,
} from "../schemas/wallets.js";

type WalletBalanceItem = {
  chainId: string;
  address: string;
  symbol: string | null;
  name: string | null;
  decimals: number | null;
  balance: string;
  balanceRaw: string;
  isNative: boolean;
};

type TokenMeta = {
  address: string;
  symbol: string | null;
  name: string | null;
  decimals: number | null;
  logoURI?: string | null;
  tags?: unknown;
};

type WalletVenueStatus = Record<string, unknown>;
type BalanceWalletResolution = {
  walletAddress: string;
  walletType: string | null | undefined;
  linkedWalletAddress: string;
  source: "linked" | "derived_funder";
};

const SOLANA_CHAIN_ID = "7565164";
const POLYGON_CHAIN_ID = "137";
const BASE_CHAIN_ID = "8453";
const SOLANA_NATIVE_ADDRESS = "11111111111111111111111111111111";
const EVM_NATIVE_ADDRESS = "0x0000000000000000000000000000000000000000";
const EVM_NATIVE_ALT = "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
const VENUE_STATUS_TTL_MS = 15_000;
const BALANCE_WALLET_LOOKUP_TTL_MS = 10_000;

type VenueStatusCacheEntry = {
  value: WalletVenueStatus;
  expiresAt: number;
};

const venueStatusCache = new Map<string, VenueStatusCacheEntry>();
const venueStatusInflight = new Map<string, Promise<WalletVenueStatus>>();
const balanceWalletLookupCache = new Map<
  string,
  { lookup: Map<string, BalanceWalletResolution>; expiresAt: number }
>();
const walletBalancesInflight = new Map<
  string,
  Promise<{ balances: WalletBalanceItem[]; warnings: string[] }>
>();

function getVenueStatusCacheKey(inputs: {
  userId: string;
  walletAddress: string;
  walletType: string;
  funder?: string | null;
  funderUpdatedAt?: string | null;
  relayerEnabled: boolean;
}) {
  const funderKey = inputs.funder?.toLowerCase() ?? "none";
  const funderUpdatedAt = inputs.funderUpdatedAt ?? "none";
  return [
    inputs.userId,
    inputs.walletAddress.toLowerCase(),
    inputs.walletType,
    funderKey,
    funderUpdatedAt,
    inputs.relayerEnabled ? "relayer:1" : "relayer:0",
  ].join("|");
}

function readVenueStatusCache(key: string): WalletVenueStatus | null {
  if (VENUE_STATUS_TTL_MS <= 0) return null;
  const entry = venueStatusCache.get(key);
  if (!entry) return null;
  if (entry.expiresAt <= Date.now()) {
    venueStatusCache.delete(key);
    return null;
  }
  return entry.value;
}

function writeVenueStatusCache(key: string, value: WalletVenueStatus) {
  if (VENUE_STATUS_TTL_MS <= 0) return;
  venueStatusCache.set(key, {
    value,
    expiresAt: Date.now() + VENUE_STATUS_TTL_MS,
  });
}

const FALLBACK_TOKEN_META: Record<string, Record<string, TokenMeta>> = {
  [POLYGON_CHAIN_ID]: {
    [env.polymarketUsdcAddress.toLowerCase()]: {
      address: env.polymarketUsdcAddress,
      symbol: "USDC",
      decimals: 6,
      name: "USD Coin (PoS)",
    },
    "0x3c499c542cef5e3811e1192ce70d8cc03d5c3359": {
      address: "0x3c499c542cef5e3811e1192ce70d8cc03d5c3359",
      symbol: "USDC",
      decimals: 6,
      name: "USD Coin",
    },
    [EVM_NATIVE_ADDRESS]: {
      address: EVM_NATIVE_ADDRESS,
      symbol: "MATIC",
      decimals: 18,
      name: "Polygon",
    },
  },
  [BASE_CHAIN_ID]: {
    [env.limitlessUsdcAddress.toLowerCase()]: {
      address: env.limitlessUsdcAddress,
      symbol: "USDC",
      decimals: 6,
      name: "USD Coin",
    },
    [EVM_NATIVE_ADDRESS]: {
      address: EVM_NATIVE_ADDRESS,
      symbol: "ETH",
      decimals: 18,
      name: "Ethereum",
    },
  },
  [SOLANA_CHAIN_ID]: {
    [env.solanaUsdcMint]: {
      address: env.solanaUsdcMint,
      symbol: "USDC",
      decimals: 6,
      name: "USD Coin",
    },
    [SOLANA_NATIVE_ADDRESS]: {
      address: SOLANA_NATIVE_ADDRESS,
      symbol: "SOL",
      decimals: 9,
      name: "Solana",
    },
    So11111111111111111111111111111111111111112: {
      address: "So11111111111111111111111111111111111111112",
      symbol: "SOL",
      decimals: 9,
      name: "Wrapped SOL",
    },
  },
};

function normalizeTokenAddress(address: string) {
  if (address.startsWith("0x")) return address.toLowerCase();
  return address;
}

function normalizeTokenKey(chainId: string, address: string) {
  return `${chainId}:${normalizeTokenAddress(address)}`;
}

function getFallbackTokenMeta(chainId: string, address: string): TokenMeta | null {
  const chainMeta = FALLBACK_TOKEN_META[chainId];
  if (!chainMeta) return null;
  const normalized = normalizeTokenAddress(address);
  const hit =
    chainMeta[normalized] ??
    chainMeta[normalized.toLowerCase()] ??
    chainMeta[address];
  return hit ?? null;
}

async function loadTokenMetaMap(
  chainId: string,
  addresses: string[],
): Promise<Map<string, TokenMeta>> {
  const normalizedAddresses = addresses.map(normalizeTokenAddress);
  const output = new Map<string, TokenMeta>();
  if (normalizedAddresses.length === 0) return output;

  const result = await pool.query<{
    chain_id: string;
    address: string;
    symbol: string | null;
    name: string | null;
    decimals: number | null;
    logo_uri: string | null;
    tags: unknown;
  }>(
    `
      select chain_id, address, symbol, name, decimals, logo_uri, tags
      from bridge_token_cache
      where provider = 'debridge'
        and chain_id = $1
        and address = any($2::text[])
    `,
    [chainId, normalizedAddresses],
  );

  for (const row of result.rows) {
    output.set(normalizeTokenKey(chainId, row.address), {
      address: row.address,
      symbol: row.symbol,
      name: row.name,
      decimals: row.decimals,
      logoURI: row.logo_uri,
      tags: row.tags,
    });
  }

  return output;
}

function parseTokenRef(raw: string): { chainId: string; address: string } | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const [chainId, address] = trimmed.split(":");
  if (!chainId || !address) return null;
  return { chainId: chainId.trim(), address: address.trim() };
}

function isEvmWalletAddress(address: string) {
  return /^0x[a-fA-F0-9]{40}$/.test(address);
}

function normalizeWalletLookupKey(address: string) {
  const trimmed = address.trim();
  if (!trimmed) return "";
  return trimmed.startsWith("0x") ? trimmed.toLowerCase() : trimmed;
}

function readBalanceWalletLookupCache(
  userId: string,
): Map<string, BalanceWalletResolution> | null {
  const entry = balanceWalletLookupCache.get(userId);
  if (!entry) return null;
  if (entry.expiresAt <= Date.now()) {
    balanceWalletLookupCache.delete(userId);
    return null;
  }
  return entry.lookup;
}

function writeBalanceWalletLookupCache(
  userId: string,
  lookup: Map<string, BalanceWalletResolution>,
) {
  balanceWalletLookupCache.set(userId, {
    lookup,
    expiresAt: Date.now() + BALANCE_WALLET_LOOKUP_TTL_MS,
  });
}

async function loadBalanceWalletLookup(
  userId: string,
): Promise<Map<string, BalanceWalletResolution>> {
  const cached = readBalanceWalletLookupCache(userId);
  if (cached) return cached;

  const linkedWallets = await AuthService.getUserWallets(userId);
  const lookup = new Map<string, BalanceWalletResolution>();

  for (const wallet of linkedWallets) {
    const key = normalizeWalletLookupKey(wallet.walletAddress);
    if (!key) continue;
    const walletType =
      wallet.walletType ??
      (isEvmWalletAddress(wallet.walletAddress) ? "ethereum" : "solana");
    lookup.set(key, {
      walletAddress: wallet.walletAddress,
      walletType,
      linkedWalletAddress: wallet.walletAddress,
      source: "linked",
    });
  }

  const evmWallets = linkedWallets.filter(
    (wallet) =>
      wallet.walletType === "ethereum" ||
      isEvmWalletAddress(wallet.walletAddress),
  );

  if (evmWallets.length > 0) {
    const configuredConcurrency = Number(env.walletBalancesBatchConcurrency);
    const concurrency = Math.max(
      1,
      Math.min(
        Number.isFinite(configuredConcurrency) ? configuredConcurrency : 4,
        8,
      ),
    );
    const derived = await mapWithConcurrency(
      evmWallets,
      concurrency,
      async (wallet) => {
        try {
          const creds = await AuthService.getVenueCredentialsInfo(
            userId,
            "polymarket",
            wallet.walletAddress,
          );
          return {
            signerWalletAddress: wallet.walletAddress,
            funderAddress: creds?.funderAddress ?? null,
          };
        } catch {
          return {
            signerWalletAddress: wallet.walletAddress,
            funderAddress: null,
          };
        }
      },
    );

    for (const candidate of derived) {
      const funderAddress = candidate.funderAddress?.trim();
      if (!funderAddress || !isEvmWalletAddress(funderAddress)) continue;
      const key = normalizeWalletLookupKey(funderAddress);
      if (!key || lookup.has(key)) continue;
      lookup.set(key, {
        walletAddress: funderAddress,
        walletType: "ethereum",
        linkedWalletAddress: candidate.signerWalletAddress,
        source: "derived_funder",
      });
    }
  }

  writeBalanceWalletLookupCache(userId, lookup);
  return lookup;
}

function isEvmNativeAddress(address: string) {
  const lower = address.toLowerCase();
  return lower === EVM_NATIVE_ADDRESS || lower === EVM_NATIVE_ALT;
}

function getEvmRpcConfig(chainId: string) {
  if (chainId === POLYGON_CHAIN_ID) {
    return {
      rpcUrl: env.polygonRpcUrl,
      timeoutMs: env.polygonRpcTimeoutMs,
    };
  }
  if (chainId === BASE_CHAIN_ID) {
    return {
      rpcUrl: env.baseRpcUrl,
      timeoutMs: env.baseRpcTimeoutMs,
    };
  }
  return null;
}

function sleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

function isRpcRateLimitError(error: unknown) {
  if (!(error instanceof Error)) return false;
  const message = error.message.toLowerCase();
  return (
    message.includes("429") ||
    message.includes("too many requests") ||
    message.includes("rate limit")
  );
}

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  mapper: (item: T) => Promise<R>,
): Promise<R[]> {
  if (items.length === 0) return [];
  const width = Math.max(1, Math.min(concurrency, items.length));
  const output = new Array<R>(items.length);
  let cursor = 0;
  const workers = Array.from({ length: width }, async () => {
    while (true) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      output[index] = await mapper(items[index] as T);
    }
  });
  await Promise.all(workers);
  return output;
}

async function resolveWalletBalancesForWallet(inputs: {
  walletAddress: string;
  walletType: string | null | undefined;
  tokens: string[];
  chains: string[];
}): Promise<{ balances: WalletBalanceItem[]; warnings: string[] }> {
  const tokens = inputs.tokens;
  const chains = inputs.chains;
  const warnings: string[] = [];

  const entries = new Map<
    string,
    { chainId: string; address: string; isNative: boolean }
  >();

  for (const chainId of chains) {
    const nativeAddress =
      chainId === SOLANA_CHAIN_ID ? SOLANA_NATIVE_ADDRESS : EVM_NATIVE_ADDRESS;
    const key = normalizeTokenKey(chainId, nativeAddress);
    entries.set(key, { chainId, address: nativeAddress, isNative: true });
  }

  for (const token of tokens) {
    const parsed = parseTokenRef(token);
    if (!parsed) {
      warnings.push(`Invalid token reference: ${token}`);
      continue;
    }
    const key = normalizeTokenKey(parsed.chainId, parsed.address);
    entries.set(key, {
      chainId: parsed.chainId,
      address: parsed.address,
      isNative:
        parsed.chainId !== SOLANA_CHAIN_ID && isEvmNativeAddress(parsed.address),
    });
  }

  const isEvmWallet =
    inputs.walletType === "ethereum" || isEvmWalletAddress(inputs.walletAddress);
  const isSolanaWallet = !isEvmWallet;
  const balances: WalletBalanceItem[] = [];

  const addressesByChain = new Map<string, string[]>();
  for (const entry of entries.values()) {
    if (!addressesByChain.has(entry.chainId)) {
      addressesByChain.set(entry.chainId, []);
    }
    addressesByChain.get(entry.chainId)?.push(entry.address);
  }

  const tokenMetaMapByChain = new Map<string, Map<string, TokenMeta>>();
  for (const [chainId, addresses] of addressesByChain.entries()) {
    tokenMetaMapByChain.set(chainId, await loadTokenMetaMap(chainId, addresses));
  }

  const resolveEntryBalance = async (entry: {
    chainId: string;
    address: string;
    isNative: boolean;
  }) => {
    if (entry.chainId === SOLANA_CHAIN_ID) {
      if (!isSolanaWallet) {
        warnings.push(`Solana balances require a Solana wallet (${entry.address})`);
        return;
      }

      if (entry.address === SOLANA_NATIVE_ADDRESS) {
        const lamports = await fetchSolanaBalanceLamports({
          rpcUrls: env.solanaRpcUrls,
          owner: inputs.walletAddress,
          timeoutMs: env.solanaRpcTimeoutMs,
        });
        const decimals = 9;
        balances.push({
          chainId: entry.chainId,
          address: entry.address,
          symbol: "SOL",
          name: "Solana",
          decimals,
          balanceRaw: lamports.toString(),
          balance: formatUiAmount(lamports, decimals),
          isNative: true,
        });
        return;
      }

      const tokenBalance = await fetchSolanaTokenBalanceByOwnerAndMint({
        rpcUrls: env.solanaRpcUrls,
        owner: inputs.walletAddress,
        mint: entry.address,
        timeoutMs: env.solanaRpcTimeoutMs,
      });

      const amount = tokenBalance?.amount ?? 0n;
      let decimals = tokenBalance?.decimals ?? null;
      if (decimals == null) {
        try {
          decimals = await fetchSolanaMintDecimals({
            rpcUrls: env.solanaRpcUrls,
            mint: entry.address,
            timeoutMs: env.solanaRpcTimeoutMs,
          });
        } catch {
          decimals = null;
        }
      }

      const metaMap = tokenMetaMapByChain.get(entry.chainId);
      const meta =
        metaMap?.get(normalizeTokenKey(entry.chainId, entry.address)) ??
        getFallbackTokenMeta(entry.chainId, entry.address);

      balances.push({
        chainId: entry.chainId,
        address: entry.address,
        symbol: meta?.symbol ?? null,
        name: meta?.name ?? null,
        decimals,
        balanceRaw: amount.toString(),
        balance:
          decimals == null ? amount.toString() : formatUiAmount(amount, decimals),
        isNative: false,
      });
      return;
    }

    if (!isEvmWallet) {
      warnings.push(`EVM balances require an EVM wallet (${entry.address})`);
      return;
    }

    const rpcConfig = getEvmRpcConfig(entry.chainId);
    if (!rpcConfig) {
      warnings.push(`Unsupported EVM chain: ${entry.chainId}`);
      return;
    }

    const metaMap = tokenMetaMapByChain.get(entry.chainId);
    const meta =
      metaMap?.get(normalizeTokenKey(entry.chainId, entry.address)) ??
      getFallbackTokenMeta(entry.chainId, entry.address);

    if (isEvmNativeAddress(entry.address)) {
      const balanceRaw = await fetchEvmBalance({
        rpcUrl: rpcConfig.rpcUrl,
        timeoutMs: rpcConfig.timeoutMs,
        address: inputs.walletAddress,
      });
      const decimals = meta?.decimals ?? 18;
      balances.push({
        chainId: entry.chainId,
        address: entry.address,
        symbol: meta?.symbol ?? null,
        name: meta?.name ?? null,
        decimals,
        balanceRaw: balanceRaw.toString(),
        balance: ethers.formatUnits(balanceRaw, decimals),
        isNative: true,
      });
      return;
    }

    const balanceRaw = await fetchErc20BalanceOf({
      rpcUrl: rpcConfig.rpcUrl,
      timeoutMs: rpcConfig.timeoutMs,
      tokenAddress: entry.address,
      owner: inputs.walletAddress,
    });
    const decimals = meta?.decimals ?? null;
    balances.push({
      chainId: entry.chainId,
      address: entry.address,
      symbol: meta?.symbol ?? null,
      name: meta?.name ?? null,
      decimals,
      balanceRaw: balanceRaw.toString(),
      balance:
        decimals == null
          ? balanceRaw.toString()
          : ethers.formatUnits(balanceRaw, decimals),
      isNative: false,
    });
  };

  const tokenConcurrency = Math.max(
    1,
    Math.min(env.walletBalancesTokenConcurrency, entries.size || 1),
  );

  await mapWithConcurrency(
    Array.from(entries.values()),
    tokenConcurrency,
    async (entry) => {
      for (let attempt = 1; attempt <= env.walletBalancesRpcMaxAttempts; attempt += 1) {
        try {
          await resolveEntryBalance(entry);
          return;
        } catch (error) {
          const canRetry =
            isRpcRateLimitError(error) &&
            attempt < env.walletBalancesRpcMaxAttempts;
          if (canRetry) {
            const delayMs = Math.min(
              env.walletBalancesRpcRetryBaseMs * 2 ** (attempt - 1),
              2_000,
            );
            await sleep(delayMs);
            continue;
          }

          const reason =
            error instanceof Error && error.message.trim().length > 0
              ? error.message
              : "unknown error";
          warnings.push(
            `Failed to fetch balance for ${entry.chainId}:${entry.address} (${reason})`,
          );
          return;
        }
      }
    },
  );
  return { balances, warnings };
}

function buildWalletBalancesInflightKey(inputs: {
  walletAddress: string;
  walletType: string | null | undefined;
  tokens: string[];
  chains: string[];
}) {
  const tokens = [...inputs.tokens].sort((left, right) =>
    left.localeCompare(right),
  );
  const chains = [...inputs.chains].sort((left, right) =>
    left.localeCompare(right),
  );
  return JSON.stringify({
    walletAddress: inputs.walletAddress.toLowerCase(),
    walletType: inputs.walletType ?? null,
    tokens,
    chains,
  });
}

async function resolveWalletBalancesForWalletWithInflight(inputs: {
  walletAddress: string;
  walletType: string | null | undefined;
  tokens: string[];
  chains: string[];
}): Promise<{ balances: WalletBalanceItem[]; warnings: string[] }> {
  const key = buildWalletBalancesInflightKey(inputs);
  const pending = walletBalancesInflight.get(key);
  if (pending) return pending;
  const request = resolveWalletBalancesForWallet(inputs).finally(() => {
    walletBalancesInflight.delete(key);
  });
  walletBalancesInflight.set(key, request);
  return request;
}

export const walletsRoutes: FastifyPluginAsync = async (app) => {
  const z = app.withTypeProvider<ZodTypeProvider>();

  /**
   * GET /wallets/balances
   * Returns wallet balances for selected tokens.
   */
  z.get(
    "/wallets/balances",
    {
      preHandler: createAuthMiddleware(),
      schema: { querystring: walletBalancesQuerySchema },
    },
    async (request, reply) => {
      const user = request.user;
      const sessionWallet = request.walletAddress;
      if (!user || !sessionWallet) {
        reply.code(401);
        return reply.send({ error: "Unauthorized" });
      }

      const query = request.query;
      const requestedWallet = query.walletAddress?.trim();
      const walletAddress = requestedWallet || sessionWallet;
      const walletLookup = await loadBalanceWalletLookup(user.id);
      const wallet = walletLookup.get(normalizeWalletLookupKey(walletAddress));

      if (!wallet) {
        reply.code(403);
        return reply.send({
          error: "Wallet is not linked to the authenticated user",
        });
      }

      const tokens = query.tokens ?? [];
      const chains = query.chains ?? [];

      if (tokens.length === 0 && chains.length === 0) {
        reply.code(400);
        return reply.send({ error: "tokens or chains must be provided" });
      }

      try {
        const { balances, warnings } =
          await resolveWalletBalancesForWalletWithInflight({
          walletAddress: wallet.walletAddress,
          walletType: wallet.walletType,
          tokens,
          chains,
        });
        reply.header("Content-Type", "application/json; charset=utf-8");
        return reply.send({
          ok: true,
          walletAddress: wallet.walletAddress,
          walletType: wallet.walletType,
          balances,
          warnings,
        });
      } catch (error) {
        app.log.error(
          { error, walletAddress: wallet.walletAddress },
          "Wallet balance lookup failed",
        );
        reply.code(502);
        return reply.send({
          error: "Wallet balance lookup failed",
        });
      }
    },
  );

  /**
   * GET /wallets/balances/batch
   * Returns wallet balances for selected tokens across multiple linked wallets.
   */
  z.get(
    "/wallets/balances/batch",
    {
      preHandler: createAuthMiddleware(),
      schema: { querystring: walletBalancesBatchQuerySchema },
    },
    async (request, reply) => {
      const user = request.user;
      const sessionWallet = request.walletAddress;
      if (!user || !sessionWallet) {
        reply.code(401);
        return reply.send({ error: "Unauthorized" });
      }

      const query = request.query;
      const walletsRequested = Array.from(
        new Set(query.wallets.map((wallet) => wallet.trim()).filter(Boolean)),
      );

      if (walletsRequested.length === 0) {
        reply.code(400);
        return reply.send({ error: "wallets is required" });
      }

      if (walletsRequested.length > env.walletBalancesBatchMaxWallets) {
        reply.code(400);
        return reply.send({
          error: `wallets exceeds max size (${env.walletBalancesBatchMaxWallets})`,
        });
      }

      const tokens = query.tokens ?? [];
      const chains = query.chains ?? [];

      if (tokens.length === 0 && chains.length === 0) {
        reply.code(400);
        return reply.send({ error: "tokens or chains must be provided" });
      }

      const walletLookup = await loadBalanceWalletLookup(user.id);
      const resolvedWallets = walletsRequested.map((walletAddress) =>
        walletLookup.get(normalizeWalletLookupKey(walletAddress)) ?? null,
      );

      if (resolvedWallets.some((wallet) => wallet == null)) {
        reply.code(403);
        return reply.send({
          error: "Wallet is not linked to the authenticated user",
        });
      }

      const walletsToQuery = resolvedWallets.filter(
        (wallet): wallet is BalanceWalletResolution => wallet != null,
      );

      const results = await mapWithConcurrency(
        walletsToQuery,
        env.walletBalancesBatchConcurrency,
        async (wallet) => {
          try {
            const resolved =
              await resolveWalletBalancesForWalletWithInflight({
              walletAddress: wallet.walletAddress,
              walletType: wallet.walletType,
              tokens,
              chains,
            });
            return {
              walletAddress: wallet.walletAddress,
              walletType: wallet.walletType,
              balances: resolved.balances,
              warnings: resolved.warnings,
            };
          } catch (error) {
            app.log.error(
              { error, walletAddress: wallet.walletAddress },
              "Wallet balance lookup failed in batch",
            );
            return {
              walletAddress: wallet.walletAddress,
              walletType: wallet.walletType,
              balances: [] as WalletBalanceItem[],
              warnings: [] as string[],
              error: "Balance lookup failed",
            };
          }
        },
      );

      reply.header("Content-Type", "application/json; charset=utf-8");
      return reply.send({
        ok: true,
        wallets: results,
      });
    },
  );

  /**
   * GET /wallets/venue-status
   * Returns venue readiness + on-chain status per wallet.
   */
  z.get(
    "/wallets/venue-status",
    {
      preHandler: createAuthMiddleware(),
      schema: { querystring: walletVenueStatusQuerySchema },
    },
    async (request, reply) => {
      const user = request.user;
      const sessionWallet = request.walletAddress;
      if (!user || !sessionWallet) {
        reply.code(401);
        return reply.send({ error: "Unauthorized" });
      }

      const query = request.query;
      const includeAll = Boolean(query.includeAllWallets);
      const refresh = Boolean(query.refresh);

      let walletList = [] as Awaited<
        ReturnType<typeof AuthService.getUserWallets>
      >;

      if (query.wallets && query.wallets.length > 0) {
        const resolved: typeof walletList = [];
        for (const address of query.wallets) {
          const wallet = await AuthService.getUserWalletByAddress(
            user.id,
            address,
          );
          if (!wallet) {
            reply.code(403);
            return reply.send({
              error: "Wallet is not linked to the authenticated user",
            });
          }
          resolved.push(wallet);
        }
        walletList = resolved;
      } else if (query.walletAddress) {
        const wallet = await AuthService.getUserWalletByAddress(
          user.id,
          query.walletAddress,
        );
        if (!wallet) {
          reply.code(403);
          return reply.send({
            error: "Wallet is not linked to the authenticated user",
          });
        }
        walletList = [wallet];
      } else if (includeAll) {
        walletList = await AuthService.getUserWallets(user.id);
      } else {
        const wallet = await AuthService.getUserWalletByAddress(
          user.id,
          sessionWallet,
        );
        if (wallet) walletList = [wallet];
      }

      const relayerEnabled = Boolean(
        env.polymarketBuilderApiKey &&
          env.polymarketBuilderApiSecret &&
          env.polymarketBuilderApiPassphrase,
      );

      const results = await Promise.all(
        walletList.map(async (wallet) => {
          const walletAddress = wallet.walletAddress;
          const walletType =
            wallet.walletType ||
            (isEvmWalletAddress(walletAddress) ? "ethereum" : "solana");

          const response: Record<string, unknown> = {
            walletAddress,
            walletType,
            isPrimary: wallet.isPrimary,
          };

          if (walletType === "ethereum" || isEvmWalletAddress(walletAddress)) {
            try {
              const creds = await AuthService.getVenueCredentialsInfo(
                user.id,
                "polymarket",
                walletAddress,
              );
              const funder = creds?.funderAddress ?? walletAddress;
              const funderSource = creds?.funderAddress ? "credentials" : "signer";
              const funderUpdatedAtValue =
                creds?.funderUpdatedAt instanceof Date
                  ? creds.funderUpdatedAt.toISOString()
                  : creds?.funderUpdatedAt ?? null;
              const signerNormalized = walletAddress.toLowerCase();
              const funderNormalized = funder.toLowerCase();
              const signerMatchesFunder = signerNormalized === funderNormalized;
              const shouldFetchSignerUsdc = signerNormalized !== funderNormalized;

              const feeCollectorAddress = env.feeCollectorAddress?.trim() || "";
              const negRiskAdapterAddress =
                env.polymarketNegRiskAdapterAddress?.trim() || "";

              const cacheKey = getVenueStatusCacheKey({
                userId: user.id,
                walletAddress,
                walletType,
                funder,
                funderUpdatedAt: funderUpdatedAtValue,
                relayerEnabled,
              });

              if (!refresh) {
                const cached = readVenueStatusCache(cacheKey);
                if (cached) {
                  return cached;
                }

                const inflight = venueStatusInflight.get(cacheKey);
                if (inflight) {
                  return await inflight;
                }
              }

              const computePromise = (async () => {
                const signerCodePromise = fetchEvmCode({
                  rpcUrl: env.polygonRpcUrl,
                  timeoutMs: env.polygonRpcTimeoutMs,
                  address: walletAddress,
                });
                const funderCodePromise = signerMatchesFunder
                  ? signerCodePromise
                  : fetchEvmCode({
                      rpcUrl: env.polygonRpcUrl,
                      timeoutMs: env.polygonRpcTimeoutMs,
                      address: funder,
                    });

                const [signerCode, funderCode, snapshot] = await Promise.all([
                  signerCodePromise,
                  funderCodePromise,
                  fetchPolymarketOnchainSnapshot({
                    rpcUrl: env.polygonRpcUrl,
                    timeoutMs: env.polygonRpcTimeoutMs,
                    signer: walletAddress,
                    funder,
                    includeSignerUsdc: shouldFetchSignerUsdc,
                    negRiskAdapterAddress,
                    feeCollectorAddress,
                  }),
                ]);

                const usdcBalance = snapshot.usdcBalance;
                const signerUsdcBalance = snapshot.signerUsdcBalance;
                const allowanceExchange = snapshot.allowanceExchange;
                const allowanceNegRisk = snapshot.allowanceNegRisk;
                const okExchange = snapshot.okExchange;
                const okNegRisk = snapshot.okNegRisk;
                const okNegRiskAdapter = snapshot.okNegRiskAdapter;
                const allowanceNegRiskAdapter = snapshot.allowanceNegRiskAdapter;
                const allowanceFeeCollector = snapshot.allowanceFeeCollector;

                const signerIsContract =
                  typeof signerCode === "string" && signerCode.length > 2;
                const funderIsContract =
                  typeof funderCode === "string" && funderCode.length > 2;
                const signerUsdcBalanceResolved =
                  shouldFetchSignerUsdc && signerUsdcBalance != null
                    ? signerUsdcBalance
                    : usdcBalance;

                const reasons: string[] = [];
                if (!creds) reasons.push("missing_credentials");
                if (funderIsContract && !relayerEnabled) {
                  reasons.push("relayer_disabled");
                }
                if (usdcBalance <= 0n) reasons.push("insufficient_usdc");
                if (allowanceExchange <= 0n) reasons.push("allowance_exchange");
                if (!okExchange) reasons.push("approval_exchange");

                const negRiskReasons: string[] = [];
                if (!creds) negRiskReasons.push("missing_credentials");
                if (funderIsContract && !relayerEnabled) {
                  negRiskReasons.push("relayer_disabled");
                }
                if (allowanceNegRisk <= 0n) {
                  negRiskReasons.push("allowance_neg_risk");
                }
                if (!okNegRisk) negRiskReasons.push("approval_neg_risk");
                if (negRiskAdapterAddress && !okNegRiskAdapter) {
                  negRiskReasons.push("approval_neg_risk_adapter");
                }
                if (
                  negRiskAdapterAddress &&
                  (allowanceNegRiskAdapter ?? 0n) <= 0n
                ) {
                  negRiskReasons.push("allowance_neg_risk_adapter");
                }

                response.polymarket = {
                  supported: true,
                  ready: reasons.length === 0,
                  readyNegRisk: negRiskReasons.length === 0,
                  reasons,
                  negRiskReasons,
                  hasCredentials: Boolean(creds),
                  signerIsContract,
                  funder,
                  funderSource,
                  funderIsContract,
                  relayerEnabled,
                  usdc: {
                    tokenAddress: env.polymarketUsdcAddress,
                    decimals: 6,
                    balance: ethers.formatUnits(usdcBalance, 6),
                    balanceRaw: usdcBalance.toString(),
                    allowance: {
                      exchange: {
                        spender: env.polymarketExchangeAddress,
                        allowance: ethers.formatUnits(allowanceExchange, 6),
                        allowanceRaw: allowanceExchange.toString(),
                      },
                      negRiskExchange: {
                        spender: env.polymarketNegRiskExchangeAddress,
                        allowance: ethers.formatUnits(allowanceNegRisk, 6),
                        allowanceRaw: allowanceNegRisk.toString(),
                      },
                      ...(negRiskAdapterAddress
                        ? {
                            negRiskAdapter: {
                              spender: negRiskAdapterAddress,
                              allowance: ethers.formatUnits(
                                allowanceNegRiskAdapter ?? 0n,
                                6,
                              ),
                              allowanceRaw: (
                                allowanceNegRiskAdapter ?? 0n
                              ).toString(),
                            },
                          }
                        : {}),
                      ...(feeCollectorAddress
                        ? {
                            feeCollector: {
                              spender: feeCollectorAddress,
                              allowance: ethers.formatUnits(
                                allowanceFeeCollector ?? 0n,
                                6,
                              ),
                              allowanceRaw: (
                                allowanceFeeCollector ?? 0n
                              ).toString(),
                            },
                          }
                        : {}),
                    },
                  },
                  ...(funderIsContract
                    ? {
                        signerUsdc: {
                          tokenAddress: env.polymarketUsdcAddress,
                          decimals: 6,
                          balance: ethers.formatUnits(
                            signerUsdcBalanceResolved ?? 0n,
                            6,
                          ),
                          balanceRaw: (
                            signerUsdcBalanceResolved ?? 0n
                          ).toString(),
                        },
                      }
                    : {}),
                  conditionalTokens: {
                    contractAddress: env.polymarketConditionalTokensAddress,
                    isApprovedForAll: {
                      exchange: okExchange,
                      negRiskExchange: okNegRisk,
                      ...(negRiskAdapterAddress
                        ? { negRiskAdapter: okNegRiskAdapter }
                        : {}),
                    },
                  },
                };

                return response as WalletVenueStatus;
              })();

              if (!refresh) {
                venueStatusInflight.set(cacheKey, computePromise);
              }

              try {
                const computed = await computePromise;
                if (!refresh) {
                  writeVenueStatusCache(cacheKey, computed);
                }
                return computed;
              } finally {
                venueStatusInflight.delete(cacheKey);
              }
            } catch (error) {
              app.log.warn(
                { error, walletAddress },
                "Polymarket venue status lookup failed",
              );
              response.polymarket = {
                supported: true,
                ready: false,
                error: "Polymarket status lookup failed",
              };
            }

            response.kalshi = {
              supported: false,
              ready: false,
              reasons: ["wallet_type_mismatch"],
            };

            return response;
          }

          if (walletType === "solana") {
            try {
              const creds = await AuthService.getVenueCredentialsInfo(
                user.id,
                "kalshi",
                walletAddress,
              );
              const [solBalance, usdcBalance] = await Promise.all([
                fetchSolanaBalanceLamports({
                  rpcUrls: env.solanaRpcUrls,
                  owner: walletAddress,
                  timeoutMs: env.solanaRpcTimeoutMs,
                }),
                fetchSolanaTokenBalanceByOwnerAndMint({
                  rpcUrls: env.solanaRpcUrls,
                  owner: walletAddress,
                  mint: env.solanaUsdcMint,
                  timeoutMs: env.solanaRpcTimeoutMs,
                }),
              ]);

              const usdcAmount = usdcBalance?.amount ?? 0n;
              const usdcDecimals = usdcBalance?.decimals ?? 6;
              const reasons: string[] = [];
              if (solBalance <= 0n) reasons.push("insufficient_sol");
              if (usdcAmount <= 0n) reasons.push("insufficient_usdc");

              const proofBypass =
                user.kalshiProofBypass ? "user" : "none";
              let proofVerified = false;
              let proofRequiredForBuy = false;
              let proofReason:
                | "required"
                | "unavailable"
                | "disabled"
                | "bypassed"
                | undefined;

              if (!env.kalshiProofEnabled) {
                proofReason = "disabled";
              } else if (proofBypass !== "none") {
                proofReason = "bypassed";
              } else {
                const proofCheck = await verifyProofAddress({
                  address: walletAddress,
                  forceRefresh: refresh,
                });
                if (proofCheck.ok) {
                  proofVerified = proofCheck.verified;
                  if (!proofCheck.verified) {
                    proofRequiredForBuy = true;
                    proofReason = "required";
                  }
                } else {
                  proofRequiredForBuy = true;
                  proofReason = "unavailable";
                }
              }

              response.kalshi = {
                supported: true,
                ready: reasons.length === 0,
                reasons,
                hasCredentials: Boolean(creds),
                proofVerified,
                proofRequiredForBuy,
                proofBypass,
                ...(proofReason ? { proofReason } : {}),
                sol: {
                  balance: formatUiAmount(solBalance, 9),
                  balanceRaw: solBalance.toString(),
                  decimals: 9,
                  symbol: "SOL",
                },
                usdc: {
                  mint: env.solanaUsdcMint,
                  balance: formatUiAmount(usdcAmount, usdcDecimals),
                  balanceRaw: usdcAmount.toString(),
                  decimals: usdcDecimals,
                  symbol: "USDC",
                },
              };
            } catch (error) {
              app.log.warn({ error, walletAddress }, "Kalshi venue status lookup failed");
              response.kalshi = {
                supported: true,
                ready: false,
                error: "Kalshi status lookup failed",
              };
            }

            response.polymarket = {
              supported: false,
              ready: false,
              reasons: ["wallet_type_mismatch"],
            };

            return response;
          }

          response.polymarket = {
            supported: false,
            ready: false,
            reasons: ["wallet_type_mismatch"],
          };
          response.kalshi = {
            supported: false,
            ready: false,
            reasons: ["wallet_type_mismatch"],
          };

          return response;
        }),
      );

      reply.header("Content-Type", "application/json; charset=utf-8");
      return reply.send({ ok: true, wallets: results });
    },
  );
};

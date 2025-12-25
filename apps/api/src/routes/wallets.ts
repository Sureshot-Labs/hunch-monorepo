import type { FastifyPluginAsync } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { ethers } from "ethers";

import { AuthService, createAuthMiddleware } from "../auth.js";
import { pool } from "../db.js";
import { env } from "../env.js";
import { fetchSolanaBalanceLamports, fetchSolanaMintDecimals, fetchSolanaTokenBalanceByOwnerAndMint, formatUiAmount } from "../services/solana-rpc.js";
import {
  fetchErc1155IsApprovedForAll,
  fetchErc20Allowance,
  fetchErc20BalanceOf,
  fetchEvmBalance,
  fetchEvmCode,
} from "../services/polygon-rpc.js";
import {
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

const SOLANA_CHAIN_ID = "7565164";
const POLYGON_CHAIN_ID = "137";
const BASE_CHAIN_ID = "8453";
const SOLANA_NATIVE_ADDRESS = "11111111111111111111111111111111";
const EVM_NATIVE_ADDRESS = "0x0000000000000000000000000000000000000000";
const EVM_NATIVE_ALT = "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";

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

      const wallet =
        requestedWallet != null
          ? await AuthService.getUserWalletByAddress(user.id, walletAddress)
          : await AuthService.getUserWalletByAddress(user.id, sessionWallet);

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
        wallet.walletType === "ethereum" || isEvmWalletAddress(walletAddress);
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
        tokenMetaMapByChain.set(
          chainId,
          await loadTokenMetaMap(chainId, addresses),
        );
      }

      const fetchTasks = Array.from(entries.values()).map(async (entry) => {
        if (entry.chainId === SOLANA_CHAIN_ID) {
          if (!isSolanaWallet) {
            warnings.push(
              `Solana balances require a Solana wallet (${entry.address})`,
            );
            return;
          }

          if (entry.address === SOLANA_NATIVE_ADDRESS) {
            const lamports = await fetchSolanaBalanceLamports({
              rpcUrls: env.solanaRpcUrls,
              owner: walletAddress,
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
            owner: walletAddress,
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
          warnings.push(
            `EVM balances require an EVM wallet (${entry.address})`,
          );
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
            address: walletAddress,
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
          owner: walletAddress,
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
      });

      try {
        await Promise.all(fetchTasks);
      } catch (error) {
        app.log.error(
          { error, walletAddress },
          "Wallet balance lookup failed",
        );
        reply.code(502);
        return reply.send({
          error: "Wallet balance lookup failed",
          message: error instanceof Error ? error.message : "Unknown error",
        });
      }

      reply.header("Content-Type", "application/json; charset=utf-8");
      return reply.send({
        ok: true,
        walletAddress: wallet.walletAddress,
        walletType: wallet.walletType,
        balances,
        warnings,
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
              const signerNormalized = walletAddress.toLowerCase();
              const funderNormalized = funder.toLowerCase();
              const shouldFetchSignerUsdc = signerNormalized !== funderNormalized;

              const feeCollectorAddress = env.feeCollectorAddress?.trim() || "";
              const negRiskAdapterAddress =
                env.polymarketNegRiskAdapterAddress?.trim() || "";

              const [
                signerCode,
                funderCode,
                usdcBalance,
                signerUsdcBalance,
                allowanceExchange,
                allowanceNegRisk,
                okExchange,
                okNegRisk,
                okNegRiskAdapter,
                allowanceNegRiskAdapter,
                allowanceFeeCollector,
              ] = await Promise.all([
                fetchEvmCode({
                  rpcUrl: env.polygonRpcUrl,
                  timeoutMs: env.polygonRpcTimeoutMs,
                  address: walletAddress,
                }),
                fetchEvmCode({
                  rpcUrl: env.polygonRpcUrl,
                  timeoutMs: env.polygonRpcTimeoutMs,
                  address: funder,
                }),
                fetchErc20BalanceOf({
                  rpcUrl: env.polygonRpcUrl,
                  timeoutMs: env.polygonRpcTimeoutMs,
                  tokenAddress: env.polymarketUsdcAddress,
                  owner: funder,
                }),
                shouldFetchSignerUsdc
                  ? fetchErc20BalanceOf({
                      rpcUrl: env.polygonRpcUrl,
                      timeoutMs: env.polygonRpcTimeoutMs,
                      tokenAddress: env.polymarketUsdcAddress,
                      owner: walletAddress,
                    })
                  : Promise.resolve(null),
                fetchErc20Allowance({
                  rpcUrl: env.polygonRpcUrl,
                  timeoutMs: env.polygonRpcTimeoutMs,
                  tokenAddress: env.polymarketUsdcAddress,
                  owner: funder,
                  spender: env.polymarketExchangeAddress,
                }),
                fetchErc20Allowance({
                  rpcUrl: env.polygonRpcUrl,
                  timeoutMs: env.polygonRpcTimeoutMs,
                  tokenAddress: env.polymarketUsdcAddress,
                  owner: funder,
                  spender: env.polymarketNegRiskExchangeAddress,
                }),
                fetchErc1155IsApprovedForAll({
                  rpcUrl: env.polygonRpcUrl,
                  timeoutMs: env.polygonRpcTimeoutMs,
                  contractAddress: env.polymarketConditionalTokensAddress,
                  owner: funder,
                  operator: env.polymarketExchangeAddress,
                }),
                fetchErc1155IsApprovedForAll({
                  rpcUrl: env.polygonRpcUrl,
                  timeoutMs: env.polygonRpcTimeoutMs,
                  contractAddress: env.polymarketConditionalTokensAddress,
                  owner: funder,
                  operator: env.polymarketNegRiskExchangeAddress,
                }),
                negRiskAdapterAddress
                  ? fetchErc1155IsApprovedForAll({
                      rpcUrl: env.polygonRpcUrl,
                      timeoutMs: env.polygonRpcTimeoutMs,
                      contractAddress: env.polymarketConditionalTokensAddress,
                      owner: funder,
                      operator: negRiskAdapterAddress,
                    })
                  : Promise.resolve(null),
                negRiskAdapterAddress
                  ? fetchErc20Allowance({
                      rpcUrl: env.polygonRpcUrl,
                      timeoutMs: env.polygonRpcTimeoutMs,
                      tokenAddress: env.polymarketUsdcAddress,
                      owner: funder,
                      spender: negRiskAdapterAddress,
                    })
                  : Promise.resolve(null),
                feeCollectorAddress
                  ? fetchErc20Allowance({
                      rpcUrl: env.polygonRpcUrl,
                      timeoutMs: env.polygonRpcTimeoutMs,
                      tokenAddress: env.polymarketUsdcAddress,
                      owner: funder,
                      spender: feeCollectorAddress,
                    })
                  : Promise.resolve(null),
              ]);

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
              if (allowanceNegRisk <= 0n) negRiskReasons.push("allowance_neg_risk");
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
            } catch (error) {
              response.polymarket = {
                supported: true,
                ready: false,
                error: error instanceof Error ? error.message : "Unknown error",
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

              response.kalshi = {
                supported: true,
                ready: reasons.length === 0,
                reasons,
                hasCredentials: Boolean(creds),
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
              response.kalshi = {
                supported: true,
                ready: false,
                error: error instanceof Error ? error.message : "Unknown error",
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

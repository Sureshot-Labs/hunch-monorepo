import type { FastifyPluginAsync } from "fastify";
import { ethers } from "ethers";
import type { ZodTypeProvider } from "fastify-type-provider-zod";

import { createAuthMiddleware } from "../auth.js";
import { pool } from "../db.js";
import { env } from "../env.js";
import { isRecord } from "../lib/type-guards.js";
import { fetchSolanaSignatureStatus } from "../services/solana-rpc.js";
import {
  bridgeChainsQuerySchema,
  bridgeOrderBodySchema,
  bridgeOrdersQuerySchema,
  bridgeQuoteQuerySchema,
  bridgeStatusQuerySchema,
  bridgeSubmitBodySchema,
  bridgeTokensQuerySchema,
} from "../schemas/bridge.js";
import {
  debridgeRequest,
  extractDebridgeErrorMessage,
} from "../services/debridge-client.js";

type DebridgeChain = {
  chainId: string;
  originalChainId: string | null;
  chainName: string | null;
};

type DebridgeToken = {
  address: string;
  symbol: string | null;
  name: string | null;
  decimals: number | null;
  logoURI: string | null;
  tags: unknown | null;
};

type DebridgeOrderInputs = {
  srcChainId: string;
  dstChainId: string;
  srcToken: string;
  dstToken: string;
  amountIn: string;
  senderAddress: string;
  recipientAddress: string;
  dstChainTokenOutAmount?: string;
  slippage?: number;
  additionalTakerRewardBps?: number;
  referralCode?: number;
  affiliateFeePercent?: number;
  affiliateFeeRecipient?: string;
  deBridgeApp?: string;
  prependOperatingExpenses?: boolean;
  srcChainOrderAuthorityAddress?: string;
  srcChainRefundAddress?: string;
  dstChainOrderAuthorityAddress?: string;
};

type BridgeSwapType = "cross_chain" | "same_chain";

type DebridgeSameChainInputs = {
  chainId: string;
  srcToken: string;
  dstToken: string;
  amountIn: string;
  senderAddress: string;
  recipientAddress: string;
  slippage?: number;
  affiliateFeePercent?: number;
  affiliateFeeRecipient?: string;
  deBridgeApp?: string;
};

type AffiliateDefaults = {
  affiliateFeePercent?: number;
  affiliateFeeRecipient?: string;
};

const FALLBACK_TOKEN_META: Record<
  string,
  Record<string, { symbol: string; decimals: number; name?: string }>
> = {
  "137": {
    "0x2791bca1f2de4661ed88a30c99a7a9449aa84174": {
      symbol: "USDC",
      decimals: 6,
      name: "USD Coin (PoS)",
    },
    "0x3c499c542cef5e3811e1192ce70d8cc03d5c3359": {
      symbol: "USDC",
      decimals: 6,
      name: "USD Coin",
    },
    "0x0000000000000000000000000000000000000000": {
      symbol: "MATIC",
      decimals: 18,
      name: "Polygon",
    },
  },
  "8453": {
    "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913": {
      symbol: "USDC",
      decimals: 6,
      name: "USD Coin",
    },
    "0x0000000000000000000000000000000000000000": {
      symbol: "ETH",
      decimals: 18,
      name: "Ethereum",
    },
  },
  "7565164": {
    EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v: {
      symbol: "USDC",
      decimals: 6,
      name: "USD Coin",
    },
    So11111111111111111111111111111111111111112: {
      symbol: "SOL",
      decimals: 9,
      name: "Solana",
    },
  },
};

function getFallbackTokenMeta(chainId: string, address: string) {
  const chainMeta = FALLBACK_TOKEN_META[chainId];
  if (!chainMeta) return null;
  const lower = address.toLowerCase();
  for (const [key, value] of Object.entries(chainMeta)) {
    if (key.toLowerCase() === lower) return value;
  }
  return null;
}

function normalizeDebridgeChains(payload: unknown): DebridgeChain[] {
  if (!isRecord(payload) || !Array.isArray(payload.chains)) return [];
  return payload.chains
    .map((entry) => {
      if (!isRecord(entry)) return null;
      const chainId = entry.chainId ?? entry.id ?? null;
      if (chainId == null) return null;
      const originalChainId =
        entry.originalChainId == null ? null : String(entry.originalChainId);
      const chainName =
        typeof entry.chainName === "string" ? entry.chainName : null;
      return {
        chainId: String(chainId),
        originalChainId,
        chainName,
      };
    })
    .filter((entry): entry is DebridgeChain => Boolean(entry));
}

function normalizeDebridgeTokens(payload: unknown): DebridgeToken[] {
  if (!isRecord(payload) || !isRecord(payload.tokens)) return [];
  const tokens: DebridgeToken[] = [];
  for (const [key, value] of Object.entries(payload.tokens)) {
    if (!isRecord(value)) continue;
    const addressRaw =
      typeof value.address === "string" && value.address.trim().length > 0
        ? value.address
        : key;
    if (!addressRaw || !addressRaw.trim()) continue;
    const symbol =
      typeof value.symbol === "string" ? value.symbol.trim() : null;
    const name = typeof value.name === "string" ? value.name.trim() : null;
    const decimalsRaw = value.decimals;
    const decimals =
      typeof decimalsRaw === "number"
        ? decimalsRaw
        : typeof decimalsRaw === "string" && decimalsRaw.trim().length
          ? Number(decimalsRaw)
          : null;
    const logoURI =
      typeof value.logoURI === "string" ? value.logoURI.trim() : null;
    const tags = value.tags ?? null;
    tokens.push({
      address: addressRaw,
      symbol: symbol && symbol.length ? symbol : null,
      name: name && name.length ? name : null,
      decimals: Number.isFinite(decimals ?? NaN) ? decimals : null,
      logoURI: logoURI && logoURI.length ? logoURI : null,
      tags,
    });
  }
  return tokens;
}

function parseAffiliateRecipientMap(raw: string): Record<string, string> {
  const trimmed = raw.trim();
  if (!trimmed) return {};

  try {
    const parsed = JSON.parse(trimmed);
    if (isRecord(parsed)) {
      const map: Record<string, string> = {};
      for (const [key, value] of Object.entries(parsed)) {
        if (typeof value !== "string") continue;
        const recipient = value.trim();
        if (!recipient) continue;
        map[String(key).trim()] = recipient;
      }
      return map;
    }
  } catch {
    // fall through to text parsing
  }

  const map: Record<string, string> = {};
  for (const entry of trimmed.split(",")) {
    const [chainId, recipient] = entry.split(":");
    if (!chainId || !recipient) continue;
    const chainKey = chainId.trim();
    const address = recipient.trim();
    if (!chainKey || !address) continue;
    map[chainKey] = address;
  }
  return map;
}

function resolveAffiliateDefaults(inputs: {
  swapType: BridgeSwapType;
  srcChainId: string;
  dstChainId: string;
  affiliateFeePercent?: number;
  affiliateFeeRecipient?: string;
}): AffiliateDefaults {
  if (
    inputs.affiliateFeePercent != null ||
    (inputs.affiliateFeeRecipient &&
      inputs.affiliateFeeRecipient.trim().length > 0)
  ) {
    return {
      affiliateFeePercent: inputs.affiliateFeePercent,
      affiliateFeeRecipient: inputs.affiliateFeeRecipient?.trim() || undefined,
    };
  }

  const percent = env.debridgeAffiliateFeePercent;
  if (!percent || percent <= 0) return {};

  const recipients = parseAffiliateRecipientMap(
    env.debridgeAffiliateFeeRecipients,
  );
  const chainId = inputs.srcChainId;
  const recipient = recipients[chainId];
  if (!recipient) return {};
  if (chainId !== "7565164" && !ethers.isAddress(recipient)) return {};
  if (chainId === "7565164" && recipient.startsWith("0x")) return {};

  return {
    affiliateFeePercent: percent,
    affiliateFeeRecipient: recipient,
  };
}

function buildDebridgeCreateTxQuery(inputs: DebridgeOrderInputs) {
  const senderAddress = inputs.senderAddress;
  const recipientAddress = inputs.recipientAddress;

  const query: Record<string, string | number | boolean> = {
    srcChainId: inputs.srcChainId,
    srcChainTokenIn: inputs.srcToken,
    srcChainTokenInAmount: inputs.amountIn,
    dstChainId: inputs.dstChainId,
    dstChainTokenOut: inputs.dstToken,
    dstChainTokenOutRecipient: recipientAddress,
    senderAddress,
    dstChainTokenOutAmount: inputs.dstChainTokenOutAmount || "auto",
    prependOperatingExpenses: inputs.prependOperatingExpenses ?? true,
    srcChainOrderAuthorityAddress:
      inputs.srcChainOrderAuthorityAddress || senderAddress,
    srcChainRefundAddress: inputs.srcChainRefundAddress || senderAddress,
    dstChainOrderAuthorityAddress:
      inputs.dstChainOrderAuthorityAddress || recipientAddress,
  };

  if (inputs.slippage != null) query.slippage = inputs.slippage;
  if (inputs.additionalTakerRewardBps != null) {
    query.additionalTakerRewardBps = inputs.additionalTakerRewardBps;
  }
  if (inputs.referralCode != null) query.referralCode = inputs.referralCode;

  if (
    inputs.affiliateFeePercent != null &&
    inputs.affiliateFeeRecipient &&
    inputs.affiliateFeeRecipient.trim().length > 0
  ) {
    query.affiliateFeePercent = inputs.affiliateFeePercent;
    query.affiliateFeeRecipient = inputs.affiliateFeeRecipient.trim();
  }

  if (inputs.deBridgeApp && inputs.deBridgeApp.trim().length > 0) {
    query.deBridgeApp = inputs.deBridgeApp.trim();
  }

  return query;
}

function buildDebridgeSameChainQuery(inputs: DebridgeSameChainInputs) {
  const query: Record<string, string | number | boolean> = {
    chainId: inputs.chainId,
    tokenIn: inputs.srcToken,
    tokenInAmount: inputs.amountIn,
    tokenOut: inputs.dstToken,
    tokenOutRecipient: inputs.recipientAddress,
    senderAddress: inputs.senderAddress,
  };

  if (inputs.slippage != null) query.slippage = inputs.slippage;
  if (
    inputs.affiliateFeePercent != null &&
    inputs.affiliateFeeRecipient &&
    inputs.affiliateFeeRecipient.trim().length > 0
  ) {
    query.affiliateFeePercent = inputs.affiliateFeePercent;
    query.affiliateFeeRecipient = inputs.affiliateFeeRecipient.trim();
  }
  if (inputs.deBridgeApp && inputs.deBridgeApp.trim().length > 0) {
    query.deBridgeApp = inputs.deBridgeApp.trim();
  }

  return query;
}

async function fetchEvmReceiptStatus(inputs: {
  chainId: string;
  txHash: string;
}) {
  if (inputs.chainId !== "137") return null;
  const provider = new ethers.JsonRpcProvider(env.polygonRpcUrl);
  const receipt = await provider.getTransactionReceipt(inputs.txHash);
  if (!receipt) return { status: "submitted" };
  if (receipt.status === 1) return { status: "fulfilled" };
  if (receipt.status === 0) return { status: "failed" };
  return { status: "submitted" };
}

async function fetchSolanaReceiptStatus(inputs: {
  chainId: string;
  txHash: string;
}) {
  if (inputs.chainId !== "7565164") return null;
  const result = await fetchSolanaSignatureStatus({
    rpcUrls: env.solanaRpcUrls,
    signature: inputs.txHash,
    timeoutMs: 10_000,
  });
  return result;
}

function resolveBridgeAddresses(
  senderAddress: string | undefined,
  recipientAddress: string | undefined,
  fallback: string | undefined,
): { senderAddress: string; recipientAddress: string } | null {
  const sender = senderAddress?.trim() || fallback?.trim() || "";
  const recipient = recipientAddress?.trim() || fallback?.trim() || "";
  if (!sender || !recipient) return null;
  return { senderAddress: sender, recipientAddress: recipient };
}

function resolveSwapType(
  srcChainId: string,
  dstChainId: string,
  swapType?: BridgeSwapType | null,
): BridgeSwapType | null {
  if (swapType) {
    if (swapType === "same_chain" && srcChainId !== dstChainId) return null;
    if (swapType === "cross_chain" && srcChainId === dstChainId) return null;
    return swapType;
  }
  return srcChainId === dstChainId ? "same_chain" : "cross_chain";
}

export const bridgeRoutes: FastifyPluginAsync = async (app) => {
  const z = app.withTypeProvider<ZodTypeProvider>();

  z.get(
    "/bridge/chains",
    { schema: { querystring: bridgeChainsQuerySchema } },
    async (request, reply) => {
      const { provider } = request.query;
      if (provider !== "debridge") {
        reply.code(400);
        return reply.send({ error: "Unsupported bridge provider" });
      }

      const upstream = await debridgeRequest({
        baseUrl: env.debridgeDlnBase,
        timeoutMs: 10_000,
        method: "GET",
        requestPath: "/supported-chains-info",
      });

      if (!upstream.ok) {
        reply.code(502);
        return reply.send({
          error: "deBridge chains fetch failed",
          status: upstream.status,
          message: extractDebridgeErrorMessage(upstream.payload),
          payload: upstream.payload,
        });
      }

      const chains = normalizeDebridgeChains(upstream.payload);
      reply.header("Content-Type", "application/json; charset=utf-8");
      return reply.send({
        ok: true,
        provider,
        chains,
      });
    },
  );

  z.get(
    "/bridge/quote",
    { schema: { querystring: bridgeQuoteQuerySchema } },
    async (request, reply) => {
      const query = request.query;
      if (query.provider !== "debridge") {
        reply.code(400);
        return reply.send({ error: "Unsupported bridge provider" });
      }
      const swapType = resolveSwapType(
        query.srcChainId,
        query.dstChainId,
        query.swapType ?? null,
      );
      if (!swapType) {
        reply.code(400);
        return reply.send({
          error: "swapType does not match srcChainId/dstChainId",
        });
      }

      const addresses = resolveBridgeAddresses(
        query.senderAddress,
        query.recipientAddress,
        undefined,
      );
      if (!addresses) {
        reply.code(400);
        return reply.send({
          error: "senderAddress and recipientAddress are required",
        });
      }

      const affiliateDefaults = resolveAffiliateDefaults({
        swapType,
        srcChainId: query.srcChainId,
        dstChainId: query.dstChainId,
        affiliateFeePercent: query.affiliateFeePercent,
        affiliateFeeRecipient: query.affiliateFeeRecipient,
      });

      const upstream =
        swapType === "same_chain"
          ? await debridgeRequest({
              baseUrl: env.debridgeDlnBase,
              timeoutMs: 15_000,
              method: "GET",
              requestPath: "/chain/transaction",
              query: buildDebridgeSameChainQuery({
                chainId: query.srcChainId,
                srcToken: query.srcToken,
                dstToken: query.dstToken,
                amountIn: query.amountIn,
                senderAddress: addresses.senderAddress,
                recipientAddress: addresses.recipientAddress,
                slippage: query.slippage,
                affiliateFeePercent: affiliateDefaults.affiliateFeePercent,
                affiliateFeeRecipient: affiliateDefaults.affiliateFeeRecipient,
                deBridgeApp: query.deBridgeApp,
              }),
            })
          : await debridgeRequest({
              baseUrl: env.debridgeDlnBase,
              timeoutMs: 15_000,
              method: "GET",
              requestPath: "/dln/order/create-tx",
              query: buildDebridgeCreateTxQuery({
                srcChainId: query.srcChainId,
                dstChainId: query.dstChainId,
                srcToken: query.srcToken,
                dstToken: query.dstToken,
                amountIn: query.amountIn,
                senderAddress: addresses.senderAddress,
                recipientAddress: addresses.recipientAddress,
                dstChainTokenOutAmount: query.dstChainTokenOutAmount,
                slippage: query.slippage,
                additionalTakerRewardBps: query.additionalTakerRewardBps,
                referralCode: query.referralCode,
                affiliateFeePercent: affiliateDefaults.affiliateFeePercent,
                affiliateFeeRecipient: affiliateDefaults.affiliateFeeRecipient,
                deBridgeApp: query.deBridgeApp,
                prependOperatingExpenses: query.prependOperatingExpenses,
                srcChainOrderAuthorityAddress: query.srcChainOrderAuthorityAddress,
                srcChainRefundAddress: query.srcChainRefundAddress,
                dstChainOrderAuthorityAddress: query.dstChainOrderAuthorityAddress,
              }),
            });

      if (!upstream.ok) {
        reply.code(502);
        return reply.send({
          error: "deBridge quote failed",
          status: upstream.status,
          message: extractDebridgeErrorMessage(upstream.payload),
          payload: upstream.payload,
        });
      }

      reply.header("Content-Type", "application/json; charset=utf-8");
      return reply.send({
        ...((isRecord(upstream.payload) ? upstream.payload : {}) as Record<
          string,
          unknown
        >),
        swapType,
      });
    },
  );

  z.post(
    "/bridge/order",
    {
      preHandler: createAuthMiddleware(),
      schema: { body: bridgeOrderBodySchema },
    },
    async (request, reply) => {
      const user = request.user;
      if (!user) {
        reply.code(401);
        return reply.send({ error: "Unauthorized" });
      }

      const body = request.body;
      if (body.provider !== "debridge") {
        reply.code(400);
        return reply.send({ error: "Unsupported bridge provider" });
      }
      const swapType = resolveSwapType(
        body.srcChainId,
        body.dstChainId,
        body.swapType ?? null,
      );
      if (!swapType) {
        reply.code(400);
        return reply.send({
          error: "swapType does not match srcChainId/dstChainId",
        });
      }

      const addresses = resolveBridgeAddresses(
        body.senderAddress,
        body.recipientAddress,
        request.walletAddress,
      );
      if (!addresses) {
        reply.code(400);
        return reply.send({
          error: "senderAddress and recipientAddress are required",
        });
      }

      const affiliateDefaults = resolveAffiliateDefaults({
        swapType,
        srcChainId: body.srcChainId,
        dstChainId: body.dstChainId,
        affiliateFeePercent: body.affiliateFeePercent,
        affiliateFeeRecipient: body.affiliateFeeRecipient,
      });

      const upstream =
        swapType === "same_chain"
          ? await debridgeRequest({
              baseUrl: env.debridgeDlnBase,
              timeoutMs: 20_000,
              method: "GET",
              requestPath: "/chain/transaction",
              query: buildDebridgeSameChainQuery({
                chainId: body.srcChainId,
                srcToken: body.srcToken,
                dstToken: body.dstToken,
                amountIn: body.amountIn,
                senderAddress: addresses.senderAddress,
                recipientAddress: addresses.recipientAddress,
                slippage: body.slippage,
                affiliateFeePercent: affiliateDefaults.affiliateFeePercent,
                affiliateFeeRecipient: affiliateDefaults.affiliateFeeRecipient,
                deBridgeApp: body.deBridgeApp,
              }),
            })
          : await debridgeRequest({
              baseUrl: env.debridgeDlnBase,
              timeoutMs: 20_000,
              method: "GET",
              requestPath: "/dln/order/create-tx",
              query: buildDebridgeCreateTxQuery({
                srcChainId: body.srcChainId,
                dstChainId: body.dstChainId,
                srcToken: body.srcToken,
                dstToken: body.dstToken,
                amountIn: body.amountIn,
                senderAddress: addresses.senderAddress,
                recipientAddress: addresses.recipientAddress,
                dstChainTokenOutAmount: body.dstChainTokenOutAmount,
                slippage: body.slippage,
                additionalTakerRewardBps: body.additionalTakerRewardBps,
                referralCode: body.referralCode,
                affiliateFeePercent: affiliateDefaults.affiliateFeePercent,
                affiliateFeeRecipient: affiliateDefaults.affiliateFeeRecipient,
                deBridgeApp: body.deBridgeApp,
                prependOperatingExpenses: body.prependOperatingExpenses,
                srcChainOrderAuthorityAddress: body.srcChainOrderAuthorityAddress,
                srcChainRefundAddress: body.srcChainRefundAddress,
                dstChainOrderAuthorityAddress: body.dstChainOrderAuthorityAddress,
              }),
            });

      if (!upstream.ok) {
        reply.code(502);
        return reply.send({
          error: "deBridge order failed",
          status: upstream.status,
          message: extractDebridgeErrorMessage(upstream.payload),
          payload: upstream.payload,
        });
      }

      let orderId: string | null = null;
      let txMeta: Record<string, unknown> | null = null;
      let estimation: unknown | null = null;
      let fees: unknown | null = null;
      let tokenIn: unknown | null = null;
      let tokenOut: unknown | null = null;

      if (isRecord(upstream.payload)) {
        orderId =
          typeof upstream.payload.orderId === "string"
            ? upstream.payload.orderId
            : null;
        if (isRecord(upstream.payload.tx)) {
          txMeta = {
            to:
              typeof upstream.payload.tx.to === "string"
                ? upstream.payload.tx.to
                : null,
            value:
              typeof upstream.payload.tx.value === "string"
                ? upstream.payload.tx.value
                : null,
          };
        }
        if (upstream.payload.estimation !== undefined) {
          estimation = upstream.payload.estimation;
          if (isRecord(upstream.payload.estimation)) {
            fees = upstream.payload.estimation.fees ?? null;
          }
        }
        if (swapType === "same_chain") {
          if (isRecord(upstream.payload.tokenIn)) {
            tokenIn = upstream.payload.tokenIn;
          }
          if (isRecord(upstream.payload.tokenOut)) {
            tokenOut = upstream.payload.tokenOut;
          }
        }
      }

      const insertResult = await pool.query<{ id: string }>(
        `
          insert into bridge_orders (
            user_id,
            provider,
            swap_type,
            src_chain_id,
            dst_chain_id,
            src_token,
            dst_token,
            amount_in,
            slippage_bps,
            order_id,
            status,
            fees,
            metadata
          )
          values (
            $1,
            $2,
            $3,
            $4,
            $5,
            $6,
            $7,
            $8,
            $9,
            $10,
            $11,
            $12,
            $13
          )
          returning id
        `,
        [
          user.id,
          body.provider,
          swapType,
          body.srcChainId,
          body.dstChainId,
          body.srcToken,
          body.dstToken,
          body.amountIn,
          body.slippage != null ? Math.round(body.slippage * 100) : null,
          orderId,
          "created",
          fees,
          { tx: txMeta, estimation, tokenIn, tokenOut },
        ],
      );

      reply.header("Content-Type", "application/json; charset=utf-8");
      const bridgeOrderId = insertResult.rows[0]?.id ?? null;
      return reply.send({
        ...((isRecord(upstream.payload) ? upstream.payload : {}) as Record<
          string,
          unknown
        >),
        bridgeOrderId,
        swapType,
      });
    },
  );

  z.get(
    "/bridge/status",
    { schema: { querystring: bridgeStatusQuerySchema } },
    async (request, reply) => {
      const query = request.query;
      if (query.provider !== "debridge") {
        reply.code(400);
        return reply.send({ error: "Unsupported bridge provider" });
      }

      const orderId = query.orderId?.trim();
      const txHash = query.txHash?.trim();
      if (!orderId && !txHash) {
        reply.code(400);
        return reply.send({ error: "orderId or txHash is required" });
      }

      let resolvedSwapType: BridgeSwapType | null =
        query.swapType ?? null;
      let resolvedChainId = query.chainId?.trim() || null;

      if (!resolvedSwapType) {
        const lookupColumn = orderId ? "order_id" : "tx_hash_src";
        const lookupValue = orderId ?? txHash ?? "";
        const { rows } = await pool.query<{
          swap_type: BridgeSwapType;
          src_chain_id: string;
        }>(
          `
            select swap_type, src_chain_id
            from bridge_orders
            where provider = 'debridge'
              and ${lookupColumn} = $1
            order by updated_at desc
            limit 1
          `,
          [lookupValue],
        );
        if (rows[0]) {
          resolvedSwapType = rows[0].swap_type;
          if (!resolvedChainId) {
            resolvedChainId = rows[0].src_chain_id;
          }
        }
      }

      if (resolvedSwapType === "same_chain") {
        if (!txHash) {
          reply.code(400);
          return reply.send({ error: "txHash is required for same-chain" });
        }
        if (!resolvedChainId) {
          reply.code(400);
          return reply.send({ error: "chainId is required for same-chain" });
        }

        const orderRes = await debridgeRequest({
          baseUrl: env.debridgeStatsBase,
          timeoutMs: 15_000,
          method: "GET",
          requestPath: `/SameChainSwap/${resolvedChainId}/tx/${txHash}`,
        });

        if (!orderRes.ok) {
          const fallback =
            (await fetchEvmReceiptStatus({
              chainId: resolvedChainId,
              txHash,
            })) ??
            (await fetchSolanaReceiptStatus({
              chainId: resolvedChainId,
              txHash,
            }));
          if (fallback?.status) {
            await pool.query(
              `
                update bridge_orders
                set status = $1, updated_at = now()
                where provider = 'debridge'
                  and tx_hash_src = $2
              `,
              [fallback.status, txHash],
            );
            reply.header("Content-Type", "application/json; charset=utf-8");
            return reply.send({
              ok: true,
              provider: query.provider,
              swapType: "same_chain",
              chainId: resolvedChainId,
              orderIds: [],
              txLookup: null,
              orders: [
                {
                  orderId: txHash,
                  payload: { status: fallback.status, source: "rpc" },
                },
              ],
            });
          }

          const message = extractDebridgeErrorMessage(orderRes.payload);
          reply.header("Content-Type", "application/json; charset=utf-8");
          return reply.send({
            ok: true,
            provider: query.provider,
            swapType: "same_chain",
            chainId: resolvedChainId,
            orderIds: [],
            txLookup: null,
            orders: [
              {
                orderId: txHash,
                payload: {
                  status: "submitted",
                  source: "indexer_pending",
                  error: message ?? null,
                },
              },
            ],
          });
        }

        if (isRecord(orderRes.payload)) {
          const status =
            typeof orderRes.payload.status === "string"
              ? orderRes.payload.status
              : typeof orderRes.payload.state === "string"
                ? orderRes.payload.state
                : null;
          const isTerminalStatus = (value: string) => {
            const normalized = value.trim().toLowerCase();
            return normalized === "fulfilled" ||
              normalized === "failed" ||
              normalized === "completed" ||
              normalized === "cancelled" ||
              normalized === "canceled";
          };
          if (status && !isTerminalStatus(status)) {
            const fallback =
              (await fetchEvmReceiptStatus({
                chainId: resolvedChainId,
                txHash,
              })) ??
              (await fetchSolanaReceiptStatus({
                chainId: resolvedChainId,
                txHash,
              }));
            if (fallback?.status) {
              await pool.query(
                `
                  update bridge_orders
                  set status = $1, updated_at = now()
                  where provider = 'debridge'
                    and tx_hash_src = $2
                `,
                [fallback.status, txHash],
              );
              reply.header("Content-Type", "application/json; charset=utf-8");
              return reply.send({
                ok: true,
                provider: query.provider,
                swapType: "same_chain",
                chainId: resolvedChainId,
                orderIds: [],
                txLookup: null,
                orders: [
                  {
                    orderId: txHash,
                    payload: { status: fallback.status, source: "rpc" },
                  },
                ],
              });
            }
          }
          if (status) {
            await pool.query(
              `
                update bridge_orders
                set status = $1, updated_at = now()
                where provider = 'debridge'
                  and tx_hash_src = $2
              `,
              [status, txHash],
            );
          }
        }

        reply.header("Content-Type", "application/json; charset=utf-8");
        return reply.send({
          ok: true,
          provider: query.provider,
          swapType: "same_chain",
          chainId: resolvedChainId,
          orderIds: [],
          txLookup: null,
          orders: [{ orderId: txHash, payload: orderRes.payload }],
        });
      }

      let orderIds: string[] = [];
      let txLookup: unknown = null;

      if (!orderId && txHash) {
        const lookup = await debridgeRequest({
          baseUrl: env.debridgeStatsBase,
          timeoutMs: 15_000,
          method: "GET",
          requestPath: `/Transaction/${txHash}/orderIds`,
        });

        if (!lookup.ok) {
          reply.code(502);
          return reply.send({
            error: "deBridge order lookup failed",
            status: lookup.status,
            message: extractDebridgeErrorMessage(lookup.payload),
            payload: lookup.payload,
          });
        }

        txLookup = lookup.payload;
        if (isRecord(lookup.payload) && Array.isArray(lookup.payload.orderIds)) {
          orderIds = lookup.payload.orderIds
            .map((id) => (typeof id === "string" ? id : null))
            .filter((id): id is string => Boolean(id));
        }
      }

      if (orderId) orderIds = [orderId];

      const orders: Array<{ orderId: string; payload: unknown }> = [];
      for (const id of orderIds) {
        const orderRes = await debridgeRequest({
          baseUrl: env.debridgeStatsBase,
          timeoutMs: 15_000,
          method: "GET",
          requestPath: `/Orders/${id}`,
        });

        if (!orderRes.ok) {
          orders.push({
            orderId: id,
            payload: {
              error: "deBridge order status failed",
              status: orderRes.status,
              payload: orderRes.payload,
            },
          });
          continue;
        }

        orders.push({ orderId: id, payload: orderRes.payload });

        if (isRecord(orderRes.payload)) {
          const status =
            typeof orderRes.payload.status === "string"
              ? orderRes.payload.status
              : typeof orderRes.payload.state === "string"
                ? orderRes.payload.state
                : null;
          if (status) {
            await pool.query(
              `
                update bridge_orders
                set status = $1, updated_at = now()
                where provider = 'debridge' and order_id = $2
              `,
              [status, id],
            );
          }
        }
      }

      reply.header("Content-Type", "application/json; charset=utf-8");
      return reply.send({
        ok: true,
        provider: query.provider,
        swapType: resolvedSwapType ?? "cross_chain",
        orderIds,
        txLookup,
        orders,
      });
    },
  );

  z.post(
    "/bridge/submit",
    {
      preHandler: createAuthMiddleware(),
      schema: { body: bridgeSubmitBodySchema },
    },
    async (request, reply) => {
      const user = request.user;
      if (!user) {
        reply.code(401);
        return reply.send({ error: "Unauthorized" });
      }

      const body = request.body;
      if (body.provider !== "debridge") {
        reply.code(400);
        return reply.send({ error: "Unsupported bridge provider" });
      }

      const bridgeOrderId = body.bridgeOrderId?.trim() || null;
      const orderId = body.orderId?.trim() || null;
      if (!bridgeOrderId && !orderId) {
        reply.code(400);
        return reply.send({ error: "bridgeOrderId or orderId is required" });
      }

      const txColumn = body.txChain === "dst" ? "tx_hash_dst" : "tx_hash_src";
      const status = body.status?.trim() || "submitted";

      const txHashValue = body.txHash;
      const updateQuery = bridgeOrderId
        ? `
            update bridge_orders
            set ${txColumn} = $1,
                status = $2,
                updated_at = now()
            where id = $3
              and user_id = $4
          `
        : `
            update bridge_orders
            set ${txColumn} = $1,
                status = $2,
                updated_at = now()
            where provider = 'debridge'
              and order_id = $3
              and user_id = $4
          `;
      const updateParams = bridgeOrderId
        ? [txHashValue, status, bridgeOrderId, user.id]
        : [txHashValue, status, orderId, user.id];
      const { rowCount } = await pool.query(updateQuery, updateParams);

      if (!rowCount) {
        reply.code(404);
        return reply.send({ error: "Bridge order not found" });
      }

      reply.header("Content-Type", "application/json; charset=utf-8");
      return reply.send({ ok: true });
    },
  );

  z.get(
    "/bridge/orders",
    {
      preHandler: createAuthMiddleware(),
      schema: { querystring: bridgeOrdersQuerySchema },
    },
    async (request, reply) => {
      const user = request.user;
      if (!user) {
        reply.code(401);
        return reply.send({ error: "Unauthorized" });
      }

      const {
        provider,
        limit = 50,
        offset = 0,
        sync,
        syncLimit,
      } = request.query;
      if (sync && provider && provider !== "debridge") {
        reply.code(400);
        return reply.send({ error: "Sync only supported for debridge" });
      }
      const countParams: Array<string | number> = [user.id];
      const countProviderClause = provider ? `and provider = $2` : "";
      if (provider) countParams.push(provider);

      const countRes = await pool.query<{ total: string }>(
        `
          select count(*)::text as total
          from bridge_orders
          where user_id = $1
          ${countProviderClause}
        `,
        countParams,
      );
      const total = Number(countRes.rows[0]?.total ?? 0);

      const params: Array<string | number> = [user.id, limit, offset];
      const providerClause = provider ? `and provider = $4` : "";
      if (provider) params.push(provider);

      if (sync) {
        const syncProvider = provider ?? "debridge";
        const maxSync = syncLimit ?? 3;
        const { rows: pendingRows } = await pool.query<{
          id: string;
          swap_type: BridgeSwapType;
          src_chain_id: string;
          order_id: string | null;
          tx_hash_src: string | null;
        }>(
          `
            select
              id,
              swap_type,
              src_chain_id,
              order_id,
              tx_hash_src
            from bridge_orders
            where user_id = $1
              and provider = $2
              and lower(status) in ('created', 'submitted')
              and (order_id is not null or tx_hash_src is not null)
            order by
              case when lower(status) = 'submitted' then 0 else 1 end,
              updated_at desc
            limit $3
          `,
          [user.id, syncProvider, maxSync],
        );

        const extractStatus = (payload: unknown) => {
          if (!isRecord(payload)) return null;
          if (typeof payload.status === "string") return payload.status;
          if (typeof payload.state === "string") return payload.state;
          return null;
        };
        const isTerminalStatus = (value: string) => {
          const normalized = value.trim().toLowerCase();
          return normalized === "fulfilled" ||
            normalized === "failed" ||
            normalized === "completed" ||
            normalized === "cancelled" ||
            normalized === "canceled";
        };

        for (const row of pendingRows) {
          try {
            if (row.swap_type === "same_chain") {
              if (!row.tx_hash_src) continue;
              const orderRes = await debridgeRequest({
                baseUrl: env.debridgeStatsBase,
                timeoutMs: 15_000,
                method: "GET",
                requestPath: `/SameChainSwap/${row.src_chain_id}/tx/${row.tx_hash_src}`,
              });

              if (orderRes.ok) {
                const status = extractStatus(orderRes.payload);
                if (status && isTerminalStatus(status)) {
                  await pool.query(
                    `
                      update bridge_orders
                      set status = $1, updated_at = now()
                      where id = $2
                    `,
                    [status, row.id],
                  );
                  continue;
                }
                const fallback =
                  (await fetchEvmReceiptStatus({
                    chainId: row.src_chain_id,
                    txHash: row.tx_hash_src,
                  })) ??
                  (await fetchSolanaReceiptStatus({
                    chainId: row.src_chain_id,
                    txHash: row.tx_hash_src,
                  }));
                if (fallback?.status) {
                  await pool.query(
                    `
                      update bridge_orders
                      set status = $1, updated_at = now()
                      where id = $2
                    `,
                    [fallback.status, row.id],
                  );
                }
                continue;
              }

              const fallback =
                (await fetchEvmReceiptStatus({
                  chainId: row.src_chain_id,
                  txHash: row.tx_hash_src,
                })) ??
                (await fetchSolanaReceiptStatus({
                  chainId: row.src_chain_id,
                  txHash: row.tx_hash_src,
                }));
              if (fallback?.status) {
                await pool.query(
                  `
                    update bridge_orders
                    set status = $1, updated_at = now()
                    where id = $2
                  `,
                  [fallback.status, row.id],
                );
              }
              continue;
            }

            let resolvedOrderId = row.order_id;
            if (!resolvedOrderId && row.tx_hash_src) {
              const lookup = await debridgeRequest({
                baseUrl: env.debridgeStatsBase,
                timeoutMs: 15_000,
                method: "GET",
                requestPath: `/Transaction/${row.tx_hash_src}/orderIds`,
              });
              if (lookup.ok) {
                const ids = isRecord(lookup.payload) &&
                  Array.isArray(lookup.payload.orderIds)
                  ? lookup.payload.orderIds
                      .map((id) => (typeof id === "string" ? id : null))
                      .filter((id): id is string => Boolean(id))
                  : [];
                if (ids[0]) {
                  resolvedOrderId = ids[0];
                  await pool.query(
                    `
                      update bridge_orders
                      set order_id = $1, updated_at = now()
                      where id = $2
                    `,
                    [resolvedOrderId, row.id],
                  );
                }
              }
            }

            if (!resolvedOrderId) continue;
            const orderRes = await debridgeRequest({
              baseUrl: env.debridgeStatsBase,
              timeoutMs: 15_000,
              method: "GET",
              requestPath: `/Orders/${resolvedOrderId}`,
            });
            if (!orderRes.ok) continue;

            const status = extractStatus(orderRes.payload);
            if (status) {
              await pool.query(
                `
                  update bridge_orders
                  set status = $1, updated_at = now()
                  where id = $2
                `,
                [status, row.id],
              );
            }
          } catch (error) {
            request.log.warn({ error, orderId: row.id }, "Bridge sync failed");
          }
        }
      }

      const { rows } = await pool.query(
        `
          select
            id,
            provider,
            swap_type,
            src_chain_id,
            dst_chain_id,
            src_token,
            dst_token,
            amount_in,
            min_amount_out,
            slippage_bps,
            quote_id,
            order_id,
            request_hash,
            tx_hash_src,
            tx_hash_dst,
            status,
            route_name,
            fees,
            metadata,
            created_at,
            updated_at
          from bridge_orders
          where user_id = $1
          ${providerClause}
          order by created_at desc
          limit $2 offset $3
        `,
        params,
      );

      const tokenLookup = new Map<
        string,
        {
          address: string;
          symbol: string | null;
          name: string | null;
          decimals: number | null;
          logo_uri: string | null;
          tags: unknown;
        }
      >();
      const chainAddressMap = new Map<string, Set<string>>();
      const normalizeDecimals = (value: unknown) => {
        if (typeof value === "number" && Number.isFinite(value)) return value;
        if (typeof value === "string") {
          const trimmed = value.trim();
          if (!trimmed) return null;
          const parsed = Number(trimmed);
          return Number.isFinite(parsed) ? parsed : null;
        }
        return null;
      };
      const readString = (value: unknown) =>
        typeof value === "string" ? value : null;
      for (const row of rows) {
        const srcChain = row.src_chain_id as string;
        const dstChain = row.dst_chain_id as string;
        const srcAddress = (row.src_token as string).toLowerCase();
        const dstAddress = (row.dst_token as string).toLowerCase();
        if (!chainAddressMap.has(srcChain)) {
          chainAddressMap.set(srcChain, new Set());
        }
        if (!chainAddressMap.has(dstChain)) {
          chainAddressMap.set(dstChain, new Set());
        }
        chainAddressMap.get(srcChain)?.add(srcAddress);
        chainAddressMap.get(dstChain)?.add(dstAddress);
      }

      for (const [chainId, addressSet] of chainAddressMap.entries()) {
        const addresses = Array.from(addressSet);
        if (!addresses.length) continue;
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
          [chainId, addresses],
        );
        for (const token of result.rows) {
          const key = `${token.chain_id}:${token.address.toLowerCase()}`;
          tokenLookup.set(key, token);
        }
      }

      const enrichedRows = rows.map((row) => {
        const metadata = isRecord(row.metadata)
          ? { ...row.metadata }
          : {};
        const tokenIn =
          metadata.tokenIn && isRecord(metadata.tokenIn)
            ? metadata.tokenIn
            : null;
        const tokenOut =
          metadata.tokenOut && isRecord(metadata.tokenOut)
            ? metadata.tokenOut
            : null;

        const srcKey = `${row.src_chain_id}:${row.src_token.toLowerCase()}`;
        const dstKey = `${row.dst_chain_id}:${row.dst_token.toLowerCase()}`;
        const srcToken = tokenLookup.get(srcKey);
        const dstToken = tokenLookup.get(dstKey);
        const srcFallback = getFallbackTokenMeta(
          row.src_chain_id,
          row.src_token,
        );
        const dstFallback = getFallbackTokenMeta(
          row.dst_chain_id,
          row.dst_token,
        );

        metadata.tokenIn = {
          address: readString(tokenIn?.address) ?? row.src_token,
          symbol:
            readString(tokenIn?.symbol) ??
            srcToken?.symbol ??
            srcFallback?.symbol ??
            null,
          name:
            readString(tokenIn?.name) ??
            srcToken?.name ??
            srcFallback?.name ??
            null,
          decimals:
            normalizeDecimals(tokenIn?.decimals) ??
            srcToken?.decimals ??
            srcFallback?.decimals ??
            null,
          amount: readString(tokenIn?.amount) ?? row.amount_in,
          logoURI: readString(tokenIn?.logoURI) ?? srcToken?.logo_uri ?? null,
          tags: tokenIn?.tags ?? srcToken?.tags ?? null,
        };

        metadata.tokenOut = {
          address: readString(tokenOut?.address) ?? row.dst_token,
          symbol:
            readString(tokenOut?.symbol) ??
            dstToken?.symbol ??
            dstFallback?.symbol ??
            null,
          name:
            readString(tokenOut?.name) ??
            dstToken?.name ??
            dstFallback?.name ??
            null,
          decimals:
            normalizeDecimals(tokenOut?.decimals) ??
            dstToken?.decimals ??
            dstFallback?.decimals ??
            null,
          amount: readString(tokenOut?.amount) ?? row.min_amount_out ?? null,
          logoURI: readString(tokenOut?.logoURI) ?? dstToken?.logo_uri ?? null,
          tags: tokenOut?.tags ?? dstToken?.tags ?? null,
        };

        return { ...row, metadata };
      });

      reply.header("Content-Type", "application/json; charset=utf-8");
      return reply.send({
        ok: true,
        total,
        limit,
        offset,
        orders: enrichedRows,
      });
    },
  );

  z.get(
    "/bridge/tokens",
    { schema: { querystring: bridgeTokensQuerySchema } },
    async (request, reply) => {
      const { provider, chainId, search, limit } = request.query;
      if (provider !== "debridge") {
        reply.code(400);
        return reply.send({ error: "Unsupported bridge provider" });
      }

      const upstream = await debridgeRequest({
        baseUrl: env.debridgeDlnBase,
        timeoutMs: 15_000,
        method: "GET",
        requestPath: "/token-list",
        query: { chainId },
      });

      if (!upstream.ok) {
        reply.code(502);
        return reply.send({
          error: "deBridge token list fetch failed",
          status: upstream.status,
          message: extractDebridgeErrorMessage(upstream.payload),
          payload: upstream.payload,
        });
      }

      let tokens = normalizeDebridgeTokens(upstream.payload);
      if (search && search.trim().length) {
        const needle = search.trim().toLowerCase();
        tokens = tokens.filter((token) => {
          const address = token.address.toLowerCase();
          const symbol = token.symbol?.toLowerCase() ?? "";
          const name = token.name?.toLowerCase() ?? "";
          return (
            address.includes(needle) ||
            symbol.includes(needle) ||
            name.includes(needle)
          );
        });
      }

      const cap = limit ?? 500;
      if (tokens.length > cap) tokens = tokens.slice(0, cap);

      if (tokens.length) {
        const values: Array<string | number | null> = [];
        const placeholders = tokens.map((token, index) => {
          const offset = index * 8;
          values.push(
            provider,
            chainId,
            token.address.toLowerCase(),
            token.symbol ?? null,
            token.name ?? null,
            token.decimals ?? null,
            token.logoURI ?? null,
            JSON.stringify(token.tags ?? null),
          );
          return `($${offset + 1}, $${offset + 2}, $${offset + 3}, $${
            offset + 4
          }, $${offset + 5}, $${offset + 6}, $${offset + 7}, $${
            offset + 8
          })`;
        });

        await pool.query(
          `
            insert into bridge_token_cache (
              provider,
              chain_id,
              address,
              symbol,
              name,
              decimals,
              logo_uri,
              tags
            )
            values ${placeholders.join(", ")}
            on conflict (provider, chain_id, address) do update
            set symbol = excluded.symbol,
                name = excluded.name,
                decimals = excluded.decimals,
                logo_uri = excluded.logo_uri,
                tags = excluded.tags,
                updated_at = now()
          `,
          values,
        );
      }

      reply.header("Content-Type", "application/json; charset=utf-8");
      return reply.send({
        ok: true,
        provider,
        chainId,
        total: tokens.length,
        tokens,
      });
    },
  );
};

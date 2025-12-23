import type { FastifyPluginAsync } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";

import { createAuthMiddleware } from "../auth.js";
import { pool } from "../db.js";
import { env } from "../env.js";
import { isRecord } from "../lib/type-guards.js";
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
      if (query.srcChainId === query.dstChainId) {
        reply.code(400);
        return reply.send({
          error: "srcChainId and dstChainId must be different",
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

      const upstream = await debridgeRequest({
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
          affiliateFeePercent: query.affiliateFeePercent,
          affiliateFeeRecipient: query.affiliateFeeRecipient,
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
      return reply.send(upstream.payload);
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
      if (body.srcChainId === body.dstChainId) {
        reply.code(400);
        return reply.send({
          error: "srcChainId and dstChainId must be different",
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

      const upstream = await debridgeRequest({
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
          affiliateFeePercent: body.affiliateFeePercent,
          affiliateFeeRecipient: body.affiliateFeeRecipient,
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
      }

      await pool.query(
        `
          insert into bridge_orders (
            user_id,
            provider,
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
            $12
          )
        `,
        [
          user.id,
          body.provider,
          body.srcChainId,
          body.dstChainId,
          body.srcToken,
          body.dstToken,
          body.amountIn,
          body.slippage != null ? Math.round(body.slippage * 100) : null,
          orderId,
          "created",
          fees,
          { tx: txMeta, estimation },
        ],
      );

      reply.header("Content-Type", "application/json; charset=utf-8");
      return reply.send(upstream.payload);
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

      if (!body.orderId) {
        reply.code(400);
        return reply.send({ error: "orderId is required" });
      }

      const txColumn = body.txChain === "dst" ? "tx_hash_dst" : "tx_hash_src";
      const status = body.status?.trim() || "submitted";

      const txHashValue = body.txHash;
      const { rowCount } = await pool.query(
        `
          update bridge_orders
          set ${txColumn} = $1,
              status = $2,
              updated_at = now()
          where provider = 'debridge'
            and order_id = $3
            and user_id = $4
        `,
        [txHashValue, status, body.orderId, user.id],
      );

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

      const { provider, limit = 50, offset = 0 } = request.query;
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

      const { rows } = await pool.query(
        `
          select
            id,
            provider,
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

      reply.header("Content-Type", "application/json; charset=utf-8");
      return reply.send({
        ok: true,
        total,
        limit,
        offset,
        orders: rows,
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

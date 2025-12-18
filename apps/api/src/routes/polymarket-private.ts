import type { FastifyPluginAsync } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { ethers } from "ethers";
import { AuthService, createAuthMiddleware } from "../auth.js";
import { pool } from "../db.js";
import { env } from "../env.js";
import { storeOrder } from "../repos/orders-repo.js";
import {
  fetchErc1155IsApprovedForAll,
  fetchErc20Allowance,
  fetchErc20BalanceOf,
  fetchEvmCode,
} from "../services/polygon-rpc.js";
import {
  extractOrderArray,
  extractOrderId,
  extractTokenId,
  polymarketL2Request,
} from "../services/polymarket-clob-l2.js";

export const polymarketPrivateRoutes: FastifyPluginAsync = async (app) => {
  const z = app.withTypeProvider<ZodTypeProvider>();

  /**
   * GET /polymarket/account
   * Returns a wallet-scoped Polymarket account snapshot (Polygon on-chain reads).
   *
   * Notes:
   * - `X-HUNCH-WALLET` is the signer EOA (selected wallet).
   * - `funder_address` (if set) is used as the on-chain owner for balances/allowances.
   */
  z.get(
    "/polymarket/account",
    { preHandler: createAuthMiddleware() },
    async (request, reply) => {
      const user = request.user;
      const signer = request.walletAddress;
      if (!user || !signer) {
        reply.code(401);
        return reply.send({ error: "Unauthorized" });
      }

      if (!signer.startsWith("0x")) {
        reply.code(400);
        return reply.send({
          error: "Polymarket account snapshot requires an EVM wallet address",
        });
      }

      const credsInfo = await AuthService.getVenueCredentialsInfo(
        user.id,
        "polymarket",
        signer,
      );

      const funder = credsInfo?.funderAddress ?? signer;
      const funderSource = credsInfo?.funderAddress ? "credentials" : "signer";

      try {
        const [code, usdcBalance, allowanceExchange, allowanceNegRisk, okExchange, okNegRisk] =
          await Promise.all([
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
          ]);

        const isContract = typeof code === "string" && code.length > 2;

        reply.header("Content-Type", "application/json; charset=utf-8");
        return reply.send({
          ok: true,
          venue: "polymarket",
          chainId: 137,
          signer,
          funder,
          funderSource,
          funderUpdatedAt: credsInfo?.funderUpdatedAt ?? null,
          funderIsContract: isContract,
          rpcUrl: env.polygonRpcUrl,
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
            },
          },
          conditionalTokens: {
            contractAddress: env.polymarketConditionalTokensAddress,
            isApprovedForAll: {
              exchange: okExchange,
              negRiskExchange: okNegRisk,
            },
          },
          hasCredentials: Boolean(credsInfo),
        });
      } catch (error) {
        app.log.error(
          { error, userId: user.id, signer, funder },
          "Failed to fetch Polymarket account snapshot",
        );
        reply.code(502);
        return reply.send({
          error: "Failed to fetch Polymarket account snapshot",
          message: error instanceof Error ? error.message : "Unknown error",
        });
      }
    },
  );

  /**
   * POST /polymarket/orders/sync
   * Fetch open orders from Polymarket CLOB using stored L2 credentials and upsert them into `orders`.
   */
  z.post(
    "/polymarket/orders/sync",
    { preHandler: createAuthMiddleware() },
    async (request, reply) => {
      const user = request.user;
      const signer = request.walletAddress;
      if (!user || !signer) {
        reply.code(401);
        return reply.send({ error: "Unauthorized" });
      }

      if (!signer.startsWith("0x")) {
        reply.code(400);
        return reply.send({
          error: "Polymarket orders sync requires an EVM wallet address",
        });
      }

      const creds = await AuthService.getVenueCredentials(
        user.id,
        "polymarket",
        signer,
      );
      if (!creds || !creds.apiKey || !creds.apiSecret || !creds.apiPassphrase) {
        reply.code(400);
        return reply.send({
          error: "Polymarket credentials not found (connect first)",
        });
      }

      // Per CLOB docs, open orders live under `/data/orders` (L2 header required).
      // Some deployments may require filtering by `asset_id`/`market`; we first try "all open orders".
      const requestPathAll = "/data/orders";

      const upstreamAll = await polymarketL2Request({
        baseUrl: env.polymarketClobBase,
        timeoutMs: 10_000,
        address: signer,
        creds: {
          apiKey: creds.apiKey,
          apiSecret: creds.apiSecret,
          apiPassphrase: creds.apiPassphrase,
        },
        method: "GET",
        requestPath: requestPathAll,
      });

      let upstream = upstreamAll;
      let triedAssetIds: string[] = [];
      if (!upstream.ok && upstream.status === 400) {
        // Fallback: fetch open orders by a candidate set of assetIds (watchlist + existing positions).
        const candidateRows = await pool.query<{ token_id: string }>(
          `
            with watchlist_tokens as (
              select json_array_elements_text(m.clob_token_ids::json) as token_id
              from user_watchlist w
              join unified_markets m
                on m.id = w.market_id
              where w.user_id = $1
                and m.venue = 'polymarket'
                and m.clob_token_ids is not null
                and m.clob_token_ids <> '[]'
            ),
            position_tokens as (
              select token_id
              from positions
              where user_id = $1
                and wallet_address = $2
                and venue = 'polymarket'
            )
            select distinct token_id
            from (
              select token_id from watchlist_tokens
              union all
              select token_id from position_tokens
            ) t
            where token_id is not null
              and token_id <> ''
              and token_id ~ '^[0-9]+$'
            limit 50
          `,
          [user.id, signer],
        );

        const tokenIds = candidateRows.rows
          .map((row) => row.token_id)
          .filter((tokenId): tokenId is string => Boolean(tokenId));
        triedAssetIds = tokenIds;

        const aggregated: unknown[] = [];
        for (const tokenId of tokenIds) {
          const byAsset = await polymarketL2Request({
            baseUrl: env.polymarketClobBase,
            timeoutMs: 10_000,
            address: signer,
            creds: {
              apiKey: creds.apiKey,
              apiSecret: creds.apiSecret,
              apiPassphrase: creds.apiPassphrase,
            },
            method: "GET",
            requestPath: `/data/orders?asset_id=${encodeURIComponent(tokenId)}`,
          });

          if (!byAsset.ok) continue;
          aggregated.push(...extractOrderArray(byAsset.payload));
        }

        upstream = { ok: true, payload: aggregated };
      }

      if (!upstream.ok) {
        reply.code(502);
        return reply.send({
          error: "Polymarket orders sync failed",
          status: upstream.status,
          tried: {
            get: requestPathAll,
            ...(triedAssetIds.length
              ? { assetIdFallback: triedAssetIds.slice(0, 10) }
              : {}),
          },
          payload: upstream.payload,
        });
      }

      const ordersRaw = extractOrderArray(upstream.payload);

      let storedNew = 0;
      let alreadyKnown = 0;
      let skippedNoId = 0;
      const orderIds: string[] = [];

      for (const o of ordersRaw) {
        const venueOrderId = extractOrderId(o);
        if (!venueOrderId) {
          skippedNoId += 1;
          continue;
        }
        orderIds.push(venueOrderId);

        const tokenId = extractTokenId(o);
        const sideRaw =
          typeof (o as Record<string, unknown>).side === "string"
            ? ((o as Record<string, unknown>).side as string).toUpperCase()
            : null;
        const side =
          sideRaw === "BUY" || sideRaw === "SELL" ? sideRaw : null;

        const result = await storeOrder(pool, {
          userId: user.id,
          walletAddress: signer,
          venue: "polymarket",
          venueOrderId,
          tokenId,
          side,
          price: null,
          size: null,
          status: "live",
          errorMessage: null,
          rawError: null,
        });

        if (result.kind === "stored") storedNew += 1;
        if (result.kind === "exists") alreadyKnown += 1;
      }

      reply.header("Content-Type", "application/json; charset=utf-8");
      return reply.send({
        ok: true,
        venue: "polymarket",
        walletAddress: signer,
        fetched: ordersRaw.length,
        storedNew,
        alreadyKnown,
        skippedNoId,
        sampleVenueOrderIds: orderIds.slice(0, 10),
      });
    },
  );
};

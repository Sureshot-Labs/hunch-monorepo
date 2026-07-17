import type { Pool } from "@hunch/infra";

import type { User } from "../auth.js";
import type { DbQuery } from "../db.js";
import {
  computeAcceptingOrders,
  readDflowNativeAcceptingOrders,
} from "../lib/market-availability.js";
import type { SupportedBotTradingVenue } from "./api-trading-types.js";
import type {
  TradingReadiness,
  VenueTradingCapabilities,
} from "./trading-types.js";
import { readNumber, tradingError } from "./api-trading-utils.js";
import { canonicalMarketTokenIdSql } from "../repos/canonical-market-token-sql.js";

export type ApiTradeMarket = {
  accepting_orders: boolean | null;
  best_ask: string | null;
  best_bid: string | null;
  clob_token_ids: string | null;
  close_time: Date | null;
  condition_id?: string | null;
  event_id: string;
  event_end_time: Date | null;
  event_title: string | null;
  expiration_time: Date | null;
  id: string;
  is_initialized: boolean | null;
  last_price: string | null;
  metadata: unknown;
  neg_risk?: boolean | null;
  neg_risk_parent_condition_id?: string | null;
  neg_risk_request_id?: string | null;
  outcomes: string | null;
  question_id?: string | null;
  slug: string | null;
  status: string;
  title: string;
  token_no: string | null;
  token_yes: string | null;
  venue: SupportedBotTradingVenue;
  venue_market_id: string;
};

const TRADE_MARKET_SELECT_SQL = `SELECT
       m.id,
       m.venue::text AS venue,
       m.venue_market_id,
       m.event_id,
       e.title AS event_title,
       e.end_date AS event_end_time,
       m.title,
       m.slug,
       m.status::text AS status,
       m.outcomes,
       m.metadata,
       m.is_initialized,
       ${canonicalMarketTokenIdSql("m", "YES")} AS token_yes,
       ${canonicalMarketTokenIdSql("m", "NO")} AS token_no,
       m.clob_token_ids,
       coalesce(m.condition_id, pm.condition_id) AS condition_id,
       pm.neg_risk AS neg_risk,
       pm_parent.condition_id AS neg_risk_parent_condition_id,
       pm.neg_risk_request_id AS neg_risk_request_id,
       pm.question_id AS question_id,
       pm.accepting_orders AS accepting_orders,
       m.close_time,
       m.expiration_time,
       m.best_bid,
       m.best_ask,
       m.last_price
     FROM unified_markets m
     LEFT JOIN unified_events e ON e.id = m.event_id
     LEFT JOIN polymarket_markets pm
       ON pm.id = m.venue_market_id
      AND m.venue = 'polymarket'
     LEFT JOIN polymarket_markets pm_parent
       ON pm_parent.question_id = coalesce(pm.neg_risk_market_id, pm.raw->>'negRiskMarketID')`;

export async function findTradeMarketById(
  db: DbQuery,
  marketId: string,
): Promise<ApiTradeMarket | null> {
  const { rows } = await db.query<ApiTradeMarket>(
    `${TRADE_MARKET_SELECT_SQL}
     WHERE m.id = $1
     LIMIT 1`,
    [marketId],
  );
  return rows[0] ?? null;
}

export async function findTradeMarketByRef(
  db: DbQuery,
  marketRef: string,
): Promise<ApiTradeMarket | null> {
  const { rows } = await db.query<ApiTradeMarket>(
    `${TRADE_MARKET_SELECT_SQL}
     WHERE m.id = $1
        OR m.venue_market_id = $1
        OR m.slug = $1
     ORDER BY
       CASE WHEN m.id = $1 THEN 0 WHEN m.venue_market_id = $1 THEN 1 ELSE 2 END,
       m.updated_at_db DESC NULLS LAST
     LIMIT 1`,
    [marketRef],
  );
  return rows[0] ?? null;
}

export async function loadUser(pool: Pool, userId: string): Promise<User> {
  const { rows } = await pool.query<{
    avatar_url: string | null;
    created_at: Date;
    display_name: string | null;
    email: string | null;
    id: string;
    is_active: boolean;
    is_admin: boolean | null;
    is_verified: boolean;
    kalshi_proof_bypass: boolean | null;
    last_login_at: Date | null;
    privy_user_id: string | null;
    updated_at: Date;
    username: string | null;
  }>(
    `SELECT id, privy_user_id, email, username, display_name, avatar_url,
            is_admin, kalshi_proof_bypass, is_active, is_verified, created_at,
            updated_at, last_login_at
       FROM users
      WHERE id = $1
      LIMIT 1`,
    [userId],
  );
  const row = rows[0];
  if (!row) {
    throw tradingError({
      code: "insufficient_readiness",
      message: "User not found.",
      statusCode: 404,
    });
  }
  return {
    id: row.id,
    privyUserId: row.privy_user_id ?? undefined,
    email: row.email ?? undefined,
    username: row.username ?? undefined,
    displayName: row.display_name ?? undefined,
    avatarUrl: row.avatar_url ?? undefined,
    isAdmin: Boolean(row.is_admin),
    kalshiProofBypass: Boolean(row.kalshi_proof_bypass),
    isActive: row.is_active,
    isVerified: row.is_verified,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastLoginAt: row.last_login_at ?? undefined,
  };
}

export async function verifyLinkedWallet(input: {
  pool: Pool;
  userId: string;
  walletAddress: string | null;
  walletChain: string | null | undefined;
}): Promise<boolean> {
  if (!input.walletAddress || !input.walletChain) return false;
  const { rowCount } = await input.pool.query(
    `SELECT 1
       FROM user_wallets
      WHERE user_id = $1
        AND wallet_type = $2
        AND is_verified = true
        AND (
          ($2 = 'ethereum' AND lower(wallet_address) = lower($3))
          OR ($2 <> 'ethereum' AND wallet_address = $3)
        )
      LIMIT 1`,
    [input.userId, input.walletChain, input.walletAddress],
  );
  return (rowCount ?? 0) > 0;
}

export async function loadMarket(
  db: DbQuery,
  marketId: string | null | undefined,
): Promise<ApiTradeMarket> {
  if (!marketId) {
    throw tradingError({
      code: "invalid_trade_request",
      message: "Trade target market id is required.",
      statusCode: 400,
    });
  }
  const row = await findTradeMarketById(db, marketId);
  if (!row) {
    throw tradingError({
      code: "invalid_trade_request",
      message: "Market not found.",
      statusCode: 404,
    });
  }
  if (
    row.venue !== "polymarket" &&
    row.venue !== "limitless" &&
    row.venue !== "kalshi"
  ) {
    throw tradingError({
      code: "unsupported_capability",
      message: "Venue is not supported for Telegram bot trading.",
      venue: row.venue,
    });
  }
  return row;
}

export async function loadMarketForVenue(
  db: DbQuery,
  marketId: string | null | undefined,
  venue: SupportedBotTradingVenue,
): Promise<ApiTradeMarket> {
  const market = await loadMarket(db, marketId);
  if (market.venue !== venue) {
    throw tradingError({
      code: "invalid_trade_request",
      message: `Market venue mismatch. Expected ${venue}, got ${market.venue}.`,
      statusCode: 400,
      venue,
    });
  }
  return market;
}

export function isOrderable(
  market: Pick<
    ApiTradeMarket,
    | "accepting_orders"
    | "close_time"
    | "event_end_time"
    | "expiration_time"
    | "metadata"
    | "status"
    | "venue"
  >,
): boolean {
  return computeAcceptingOrders({
    venue: market.venue,
    status: market.status,
    pmAcceptingOrders: market.accepting_orders,
    closeTime: market.close_time,
    expirationTime: market.expiration_time,
    eventEndTime: market.event_end_time,
    dflowNativeAcceptingOrders: readDflowNativeAcceptingOrders(market.metadata),
  });
}

export function isKalshiMarketMintContextValid(input: {
  inputMint: string | null | undefined;
  market: Pick<ApiTradeMarket, "token_no" | "token_yes">;
  outputMint: string | null | undefined;
  usdcMint: string;
}): boolean {
  const normalizeMint = (mint: string | null | undefined) => {
    const trimmed = mint?.trim() ?? "";
    return trimmed.startsWith("sol:") ? trimmed.slice(4) : trimmed;
  };
  const expectedUsdc = normalizeMint(input.usdcMint);
  const inputMint = normalizeMint(input.inputMint);
  const outputMint = normalizeMint(input.outputMint);
  if (!expectedUsdc || inputMint !== expectedUsdc || !outputMint) return false;
  return [input.market.token_yes, input.market.token_no]
    .map(normalizeMint)
    .filter(Boolean)
    .includes(outputMint);
}

export function tokenForSide(
  market: ApiTradeMarket,
  side: "NO" | "YES",
): string {
  const token = side === "YES" ? market.token_yes : market.token_no;
  if (!token) {
    throw tradingError({
      code: "invalid_trade_request",
      message: "Market token for requested side is unavailable.",
      venue: market.venue,
    });
  }
  return token;
}

export function readiness(
  venue: SupportedBotTradingVenue,
  capabilities: VenueTradingCapabilities,
  input:
    | {
        ok: true;
        maxExecutableBuyUsd?: number | null;
        message?: string | null;
        raw?: unknown;
      }
    | {
        ok: false;
        code: string;
        maxExecutableBuyUsd?: number | null;
        message: string;
        repair?: TradingReadiness["repair"];
        raw?: unknown;
        setupRequired?: boolean;
      },
): TradingReadiness {
  return {
    ready: input.ok,
    executable: input.ok,
    reasonCode: input.ok ? null : input.code,
    message: input.ok ? (input.message ?? null) : input.message,
    setupRequired: input.ok ? false : (input.setupRequired ?? false),
    capabilities,
    ...(input.maxExecutableBuyUsd !== undefined
      ? { maxExecutableBuyUsd: input.maxExecutableBuyUsd }
      : {}),
    ...(!input.ok && input.repair ? { repair: input.repair } : {}),
    ...(input.raw !== undefined ? { raw: input.raw } : {}),
  };
}

export async function bestAskForToken(
  pool: Pool,
  tokenId: string,
): Promise<number | null> {
  const { rows } = await pool.query<{
    best_ask: string | null;
    best_bid: string | null;
  }>(
    `
      select best_bid, best_ask
      from unified_token_top_latest
      where token_id = $1
        and ts >= now() - interval '10 minutes'
        and best_ask > 0
        and best_ask < 1
      limit 1
    `,
    [tokenId],
  );
  const ask = readNumber(rows[0]?.best_ask ?? null);
  const bid = readNumber(rows[0]?.best_bid ?? null);
  return ask != null && (bid == null || bid <= ask) ? ask : null;
}

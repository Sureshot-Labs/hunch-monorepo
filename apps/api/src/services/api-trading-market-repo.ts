import type { Pool } from "@hunch/infra";

import type { User } from "../auth.js";
import type { SupportedBotTradingVenue } from "./api-trading-types.js";
import type {
  TradingReadiness,
  VenueTradingCapabilities,
} from "./trading-types.js";
import { readNumber, tradingError } from "./api-trading-utils.js";

export type ApiTradeMarket = {
  accepting_orders: boolean | null;
  clob_token_ids: string | null;
  close_time: Date | null;
  event_id: string | null;
  expiration_time: Date | null;
  id: string;
  metadata: unknown;
  outcomes: string | null;
  slug: string | null;
  status: string | null;
  title: string | null;
  token_no: string | null;
  token_yes: string | null;
  venue: SupportedBotTradingVenue;
  venue_market_id: string | null;
};

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
  pool: Pool,
  marketId: string | null | undefined,
): Promise<ApiTradeMarket> {
  if (!marketId) {
    throw tradingError({
      code: "invalid_trade_request",
      message: "Trade target market id is required.",
      statusCode: 400,
    });
  }
  const { rows } = await pool.query<ApiTradeMarket>(
    `SELECT
       id,
       venue::text AS venue,
       venue_market_id,
       event_id,
       title,
       slug,
       status::text AS status,
       outcomes,
       metadata,
       CASE
         WHEN venue = 'polymarket' AND clob_token_ids IS NOT NULL AND clob_token_ids <> ''
           THEN clob_token_ids::jsonb->>0
         ELSE token_yes
       END AS token_yes,
       CASE
         WHEN venue = 'polymarket' AND clob_token_ids IS NOT NULL AND clob_token_ids <> ''
           THEN clob_token_ids::jsonb->>1
         ELSE token_no
       END AS token_no,
       clob_token_ids,
       accepting_orders,
       close_time,
       expiration_time
     FROM unified_markets
     WHERE id = $1
     LIMIT 1`,
    [marketId],
  );
  const row = rows[0];
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
  pool: Pool,
  marketId: string | null | undefined,
  venue: SupportedBotTradingVenue,
): Promise<ApiTradeMarket> {
  const market = await loadMarket(pool, marketId);
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

export function isOrderable(market: ApiTradeMarket): boolean {
  const status = market.status?.toLowerCase() ?? null;
  if (status && !["active", "open", "trading"].includes(status)) return false;
  if (market.accepting_orders === false) return false;
  const close = market.close_time?.getTime() ?? market.expiration_time?.getTime();
  return close == null || close > Date.now();
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
    | { ok: true; message?: string | null }
    | { ok: false; code: string; message: string; setupRequired?: boolean },
): TradingReadiness {
  return {
    ready: input.ok,
    executable: input.ok,
    reasonCode: input.ok ? null : input.code,
    message: input.ok ? (input.message ?? null) : input.message,
    setupRequired: input.ok ? false : (input.setupRequired ?? false),
    capabilities,
  };
}

export async function bestAskForToken(
  pool: Pool,
  tokenId: string,
): Promise<number | null> {
  const { rows } = await pool.query<{ best_ask: string | null }>(
    `SELECT best_ask FROM unified_token_top_latest WHERE token_id = $1 LIMIT 1`,
    [tokenId],
  );
  return readNumber(rows[0]?.best_ask ?? null);
}

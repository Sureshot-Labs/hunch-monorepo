import type { Pool, PoolClient } from "@hunch/infra";
import { MIN_POSITION_SIZE } from "../lib/positions-constants.js";
import {
  isEvmAddress,
  normalizeWalletForStorage,
} from "../lib/wallet-address.js";
import {
  markPositionFlatByIdInTx,
  withPositionMutationLock,
} from "../repos/positions-repo.js";
import { recomputePositionMetricsForWallet } from "./positions-metrics.js";

type SupportedVenue = "polymarket" | "kalshi" | "limitless";
type TradeSide = "BUY" | "SELL";

type PositionRow = {
  id: string;
  side: string;
  size: string;
  average_price: string | null;
  realized_pnl: string | null;
};

export type OptimisticPositionTradeInput = {
  userId: string;
  walletAddress: string;
  venue: SupportedVenue;
  tokenId: string;
  side: TradeSide;
  shares: number;
  notionalUsd: number;
};

export type OptimisticPositionTradeResult = {
  applied: boolean;
  reason?: string;
};

export type ReconcileExactPositionBalanceInput = {
  userId: string;
  walletAddress: string;
  venue: SupportedVenue;
  tokenId: string;
  size: number;
  averagePrice?: number | null;
};

function parseNumber(value: string | null | undefined): number {
  if (value == null) return 0;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function clampPositive(value: number): number | null {
  if (!Number.isFinite(value)) return null;
  if (value <= 0) return null;
  return value;
}

function clampNonNegative(value: number): number | null {
  if (!Number.isFinite(value)) return null;
  if (value < 0) return null;
  return value;
}

function isEthAddress(value: string): boolean {
  return isEvmAddress(value);
}

async function selectPositionForUpdate(
  client: PoolClient,
  inputs: {
    userId: string;
    walletAddress: string;
    venue: SupportedVenue;
    tokenId: string;
  },
): Promise<PositionRow | null> {
  const walletClause = isEthAddress(inputs.walletAddress)
    ? "lower(wallet_address) = lower($2)"
    : "wallet_address = $2";
  const { rows } = await client.query<PositionRow>(
    `
      select id, side, size::text, average_price::text, realized_pnl::text
      from positions
      where user_id = $1
        and ${walletClause}
        and venue = $3
        and token_id = $4
        and position_scope = 'own'
      order by token_id, id
      for update
    `,
    [inputs.userId, inputs.walletAddress, inputs.venue, inputs.tokenId],
  );
  return rows[0] ?? null;
}

async function insertLongPosition(
  client: PoolClient,
  inputs: {
    userId: string;
    walletAddress: string;
    venue: SupportedVenue;
    tokenId: string;
    size: number;
    averagePrice: number;
  },
): Promise<void> {
  await client.query(
    `
      insert into positions (
        id,
        user_id,
        wallet_address,
        venue,
        position_scope,
        token_id,
        side,
        size,
        average_price,
        unrealized_pnl,
        realized_pnl,
        is_hidden,
        hidden_reason,
        hidden_at,
        last_updated_at,
        created_at,
        updated_at
      )
      values (
        gen_random_uuid(),
        $1, $2, $3, 'own', $4, 'LONG',
        $5, $6, 0, 0, false, null, null, now(), now(), now()
      )
      on conflict on constraint positions_user_id_wallet_address_venue_token_id_key
      do update set
        side = 'LONG',
        size = excluded.size,
        average_price = excluded.average_price,
        is_hidden = false,
        hidden_reason = null,
        hidden_at = null,
        last_updated_at = now(),
        updated_at = now()
    `,
    [
      inputs.userId,
      inputs.walletAddress,
      inputs.venue,
      inputs.tokenId,
      inputs.size,
      inputs.averagePrice,
    ],
  );
}

async function applyBuy(
  client: PoolClient,
  inputs: OptimisticPositionTradeInput,
): Promise<OptimisticPositionTradeResult> {
  const current = await selectPositionForUpdate(client, inputs);
  const tradePrice = inputs.notionalUsd / inputs.shares;
  if (!Number.isFinite(tradePrice) || tradePrice <= 0) {
    return { applied: false, reason: "invalid_trade_price" };
  }

  if (!current) {
    await insertLongPosition(client, {
      userId: inputs.userId,
      walletAddress: inputs.walletAddress,
      venue: inputs.venue,
      tokenId: inputs.tokenId,
      size: inputs.shares,
      averagePrice: tradePrice,
    });
    return { applied: true };
  }

  const currentSize = parseNumber(current.size);
  const currentAverage = parseNumber(current.average_price);

  const baseSize = currentSize > 0 ? currentSize : 0;
  const nextSize = baseSize + inputs.shares;
  const nextAverage =
    baseSize > 0 && currentAverage > 0
      ? (baseSize * currentAverage + inputs.notionalUsd) / nextSize
      : tradePrice;

  await client.query(
    `
      update positions
      set
        side = 'LONG',
        size = $2,
        average_price = $3,
        is_hidden = false,
        hidden_reason = null,
        hidden_at = null,
        last_updated_at = now(),
        updated_at = now()
      where id = $1
    `,
    [current.id, nextSize, nextAverage],
  );

  return { applied: true };
}

async function applySell(
  client: PoolClient,
  inputs: OptimisticPositionTradeInput,
): Promise<OptimisticPositionTradeResult> {
  const current = await selectPositionForUpdate(client, inputs);
  if (!current) return { applied: false, reason: "position_not_found" };

  const currentSize = parseNumber(current.size);
  if (!Number.isFinite(currentSize) || currentSize <= 0) {
    return { applied: false, reason: "position_empty" };
  }

  const tradePrice = inputs.notionalUsd / inputs.shares;
  if (!Number.isFinite(tradePrice) || tradePrice <= 0) {
    return { applied: false, reason: "invalid_trade_price" };
  }

  const sellSize = Math.min(inputs.shares, currentSize);
  if (sellSize <= 0) return { applied: false, reason: "sell_size_zero" };

  const averagePriceRaw = parseNumber(current.average_price);
  const averagePrice = averagePriceRaw > 0 ? averagePriceRaw : tradePrice;
  const proceeds = sellSize * tradePrice;
  const realizedDelta = proceeds - sellSize * averagePrice;

  const currentRealized = parseNumber(current.realized_pnl);
  const nextRealized = currentRealized + realizedDelta;
  const remainingSize = Math.max(0, currentSize - sellSize);
  const nextSize = remainingSize < MIN_POSITION_SIZE ? 0 : remainingSize;
  const nextSide = nextSize > 0 ? "LONG" : "FLAT";
  const nextAveragePrice = nextSize > 0 ? averagePrice : null;

  await client.query(
    `
      update positions
      set
        side = $2,
        size = $3,
        average_price = $4,
        realized_pnl = $5,
        last_updated_at = now(),
        updated_at = now()
      where id = $1
    `,
    [current.id, nextSide, nextSize, nextAveragePrice, nextRealized],
  );

  return { applied: true };
}

export async function applyOptimisticPositionTrade(
  pool: Pool,
  input: OptimisticPositionTradeInput,
): Promise<OptimisticPositionTradeResult> {
  return applyPositionTradeDelta(pool, input);
}

export async function applyVenueConfirmedPositionTrade(
  pool: Pool,
  input: OptimisticPositionTradeInput,
): Promise<OptimisticPositionTradeResult> {
  return applyPositionTradeDelta(pool, input);
}

export async function reconcileExactPositionBalance(
  pool: Pool,
  input: ReconcileExactPositionBalanceInput,
): Promise<OptimisticPositionTradeResult> {
  const walletAddress = normalizeWalletForStorage(input.walletAddress);
  const tokenId = input.tokenId.trim();
  const exactSize = clampNonNegative(input.size);
  const averagePrice =
    input.averagePrice != null ? clampPositive(input.averagePrice) : null;

  if (!walletAddress) return { applied: false, reason: "wallet_missing" };
  if (!tokenId) return { applied: false, reason: "token_missing" };
  if (exactSize == null) return { applied: false, reason: "size_invalid" };

  const result = await withPositionMutationLock(
    pool,
    { userId: input.userId, venue: input.venue },
    async (client: PoolClient) => {
      const current = await selectPositionForUpdate(client, {
        userId: input.userId,
        walletAddress,
        venue: input.venue,
        tokenId,
      });

      if (exactSize < MIN_POSITION_SIZE) {
        if (!current) return { applied: false, reason: "position_not_found" };

        const currentSize = parseNumber(current.size);
        if (current.side === "FLAT" && currentSize <= 0) {
          return { applied: false, reason: "position_already_flat" };
        }

        await markPositionFlatByIdInTx(client, {
          positionId: current.id,
          clearAveragePrice: true,
        });
        return { applied: true };
      }

      if (!current) {
        await client.query(
          `
            insert into positions (
              id,
              user_id,
              wallet_address,
              venue,
              position_scope,
              token_id,
              side,
              size,
              average_price,
              unrealized_pnl,
              realized_pnl,
              is_hidden,
              hidden_reason,
              hidden_at,
              last_updated_at,
              created_at,
              updated_at
            )
            values (
              gen_random_uuid(),
              $1, $2, $3, 'own', $4, 'LONG',
              $5, $6, 0, 0, false, null, null, now(), now(), now()
            )
            on conflict on constraint positions_user_id_wallet_address_venue_token_id_key
            do update set
              side = 'LONG',
              size = excluded.size,
              average_price = coalesce(positions.average_price, excluded.average_price),
              is_hidden = case
                when positions.side = 'FLAT' or positions.size <= 0 then false
                else positions.is_hidden
              end,
              hidden_reason = case
                when positions.side = 'FLAT' or positions.size <= 0 then null
                else positions.hidden_reason
              end,
              hidden_at = case
                when positions.side = 'FLAT' or positions.size <= 0 then null
                else positions.hidden_at
              end,
              last_updated_at = case
                when positions.side is distinct from 'LONG'
                  or positions.size is distinct from excluded.size
                  then now()
                else positions.last_updated_at
              end,
              updated_at = now()
          `,
          [
            input.userId,
            walletAddress,
            input.venue,
            tokenId,
            exactSize,
            averagePrice,
          ],
        );
        return { applied: true };
      }

      await client.query(
        `
          update positions
          set
            side = 'LONG',
            size = $2,
            average_price = coalesce(positions.average_price, $3),
            is_hidden = case
              when positions.side = 'FLAT' or positions.size <= 0 then false
              else positions.is_hidden
            end,
            hidden_reason = case
              when positions.side = 'FLAT' or positions.size <= 0 then null
              else positions.hidden_reason
            end,
            hidden_at = case
              when positions.side = 'FLAT' or positions.size <= 0 then null
              else positions.hidden_at
            end,
            last_updated_at = case
              when positions.side is distinct from 'LONG'
                or positions.size is distinct from $2
                then now()
              else positions.last_updated_at
            end,
            updated_at = now()
          where id = $1
        `,
        [current.id, exactSize, averagePrice],
      );

      return { applied: true };
    },
  );

  if (!result.applied) return result;

  try {
    await recomputePositionMetricsForWallet(pool, {
      userId: input.userId,
      walletAddress,
      venue: input.venue,
    });
  } catch (error) {
    console.error("Exact position metrics recompute failed", {
      error,
      userId: input.userId,
      walletAddress,
      venue: input.venue,
      tokenId,
    });
  }

  return result;
}

async function applyPositionTradeDelta(
  pool: Pool,
  input: OptimisticPositionTradeInput,
): Promise<OptimisticPositionTradeResult> {
  const walletAddress = normalizeWalletForStorage(input.walletAddress);
  const tokenId = input.tokenId.trim();
  const shares = clampPositive(input.shares);
  const notionalUsd = clampPositive(input.notionalUsd);

  if (!walletAddress) return { applied: false, reason: "wallet_missing" };
  if (!tokenId) return { applied: false, reason: "token_missing" };
  if (shares == null) return { applied: false, reason: "shares_invalid" };
  if (notionalUsd == null) {
    return { applied: false, reason: "notional_invalid" };
  }

  const tradeInput: OptimisticPositionTradeInput = {
    ...input,
    walletAddress,
    tokenId,
    shares,
    notionalUsd,
  };

  const result = await withPositionMutationLock(
    pool,
    { userId: tradeInput.userId, venue: tradeInput.venue },
    async (client: PoolClient) => {
      if (tradeInput.side === "BUY") {
        return applyBuy(client, tradeInput);
      }
      return applySell(client, tradeInput);
    },
  );

  if (!result.applied) return result;

  try {
    await recomputePositionMetricsForWallet(pool, {
      userId: tradeInput.userId,
      walletAddress: tradeInput.walletAddress,
      venue: tradeInput.venue,
    });
  } catch (error) {
    console.error("Optimistic position metrics recompute failed", {
      error,
      userId: tradeInput.userId,
      walletAddress: tradeInput.walletAddress,
      venue: tradeInput.venue,
      tokenId: tradeInput.tokenId,
    });
  }

  return result;
}

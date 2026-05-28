import { tx, type Pool, type PoolClient } from "@hunch/infra";
import { withRewardsChainLocks } from "../lib/rewards-locks.js";
import { usdcMicroToDecimalString } from "../lib/usdc.js";
import { resolveFeeEventSnapshotAtWrite } from "./rewards-fee-snapshot.js";
import { getRewardsTreasuryReport } from "./rewards-treasury.js";

export type VenueFeeAccrualInput = {
  userId: string;
  walletAddress: string | null;
  signerAddress: string | null;
  venue: string;
  feeProgram: string;
  chainId: string;
  orderId: string;
  orderHash: string;
  venueOrderId: string | null;
  venueFillId: string;
  venueTradeId: string | null;
  txHash: string | null;
  tokenId: string | null;
  side: "BUY" | "SELL";
  role: "maker" | "taker";
  attributionCode: string | null;
  feeRateBps: number;
  feeBasis?: "notional" | "venue_fee_share" | null;
  notionalAmountRaw: string;
  notionalAmount: string;
  feeAmountRaw: string;
  feeAmount: string;
  feeAsset: string;
  venueFeeRateBps?: number | null;
  venueEffectiveFeeBps?: number | null;
  venueFeeAmountRaw?: string | null;
  venueFeeAmount?: string | null;
  filledAt: Date;
};

export type VenueFeeAccrualRow = {
  id: string;
  user_id: string;
  wallet_address: string | null;
  venue: string;
  fee_program: string;
  chain_id: string | null;
  order_hash: string;
  venue_fill_id: string;
  venue_trade_id: string | null;
  tx_hash: string | null;
  token_id: string | null;
  side: "BUY" | "SELL";
  role: "maker" | "taker";
  attribution_code: string | null;
  fee_rate_bps: number;
  fee_amount: string;
  fee_amount_raw: string;
  fee_asset: string;
  filled_at: Date;
};

export type VenueFeeBackfillAttemptStatus = "retry" | "skipped" | "failed";

export type VenueFeeBackfillAttemptInput = {
  venue: string;
  feeProgram: string;
  orderId: string;
  venueOrderId: string | null;
  status: VenueFeeBackfillAttemptStatus;
  reason: string;
  nextAttemptAt?: Date | null;
};

type VenueFeeAccrualQueryable = Pick<PoolClient, "query">;

function microToDecimal(rawMicro: bigint): string {
  return usdcMicroToDecimalString(rawMicro);
}

function feeEventSourceIdForAccrual(row: VenueFeeAccrualRow): string {
  if (
    row.venue === "limitless" &&
    row.fee_program === "venue_share_contract" &&
    row.tx_hash &&
    !row.venue_fill_id.startsWith("status:")
  ) {
    return `limitless:venue_share_contract:${row.tx_hash}:${row.venue_fill_id}`;
  }
  return `${row.venue}:${row.fee_program}:${row.order_hash}:${row.venue_fill_id}`;
}

export async function upsertVenueFeeAccruals(
  pool: VenueFeeAccrualQueryable,
  inputs: Array<VenueFeeAccrualInput | null>,
): Promise<{ upserted: number }> {
  const rows = inputs.filter(
    (input): input is VenueFeeAccrualInput => input != null,
  );
  if (!rows.length) return { upserted: 0 };

  const result = await pool.query(
    `
      with input as (
        select *
        from unnest(
          $1::uuid[],
          $2::text[],
          $3::text[],
          $4::text[],
          $5::text[],
          $6::text[],
          $7::uuid[],
          $8::text[],
          $9::text[],
          $10::text[],
          $11::text[],
          $12::text[],
          $13::text[],
          $14::text[],
          $15::text[],
          $16::text[],
          $17::text[],
          $18::integer[],
          $19::text[],
          $20::numeric[],
          $21::text[],
          $22::numeric[],
          $23::text[],
          $24::integer[],
          $25::integer[],
          $26::numeric[],
          $27::text[],
          $28::timestamptz[]
        ) as t(
          user_id, wallet_address, signer_address, venue, fee_program, chain_id,
          order_id, order_hash, venue_order_id, venue_fill_id, venue_trade_id,
          tx_hash, token_id, side, role, attribution_code, fee_asset,
          fee_rate_bps, fee_basis, notional_amount, notional_amount_raw,
          fee_amount, fee_amount_raw, venue_fee_rate_bps,
          venue_effective_fee_bps, venue_fee_amount, venue_fee_amount_raw,
          filled_at
        )
      )
      insert into venue_fee_accruals (
        user_id, wallet_address, signer_address, venue, fee_program, chain_id,
        order_id, order_hash, venue_order_id, venue_fill_id, venue_trade_id,
        tx_hash, token_id, side, role, attribution_code, fee_asset,
        fee_rate_bps, fee_basis, notional_amount, notional_amount_raw,
        fee_amount, fee_amount_raw, venue_fee_rate_bps,
        venue_effective_fee_bps, venue_fee_amount, venue_fee_amount_raw,
        filled_at, status, created_at, updated_at
      )
      select
        user_id, wallet_address, signer_address, venue, fee_program, chain_id,
        order_id, order_hash, venue_order_id, venue_fill_id, venue_trade_id,
        tx_hash, token_id, side, role, attribution_code, fee_asset,
        fee_rate_bps, fee_basis, notional_amount, notional_amount_raw,
        fee_amount, fee_amount_raw, venue_fee_rate_bps,
        venue_effective_fee_bps, venue_fee_amount, venue_fee_amount_raw,
        filled_at, 'accrued', now(), now()
      from input
      on conflict (venue, fee_program, order_id, venue_fill_id)
      do update set
        tx_hash = coalesce(excluded.tx_hash, venue_fee_accruals.tx_hash),
        venue_trade_id = coalesce(excluded.venue_trade_id, venue_fee_accruals.venue_trade_id),
        attribution_code = excluded.attribution_code,
        fee_rate_bps = excluded.fee_rate_bps,
        fee_basis = excluded.fee_basis,
        notional_amount = excluded.notional_amount,
        notional_amount_raw = excluded.notional_amount_raw,
        fee_amount = excluded.fee_amount,
        fee_amount_raw = excluded.fee_amount_raw,
        venue_fee_rate_bps = excluded.venue_fee_rate_bps,
        venue_effective_fee_bps = excluded.venue_effective_fee_bps,
        venue_fee_amount = excluded.venue_fee_amount,
        venue_fee_amount_raw = excluded.venue_fee_amount_raw,
        filled_at = excluded.filled_at,
        updated_at = now()
      where venue_fee_accruals.status in ('accrued', 'verified')
      returning id
    `,
    [
      rows.map((row) => row.userId),
      rows.map((row) => row.walletAddress),
      rows.map((row) => row.signerAddress),
      rows.map((row) => row.venue),
      rows.map((row) => row.feeProgram),
      rows.map((row) => row.chainId),
      rows.map((row) => row.orderId),
      rows.map((row) => row.orderHash),
      rows.map((row) => row.venueOrderId),
      rows.map((row) => row.venueFillId),
      rows.map((row) => row.venueTradeId),
      rows.map((row) => row.txHash),
      rows.map((row) => row.tokenId),
      rows.map((row) => row.side),
      rows.map((row) => row.role),
      rows.map((row) => row.attributionCode),
      rows.map((row) => row.feeAsset),
      rows.map((row) => row.feeRateBps),
      rows.map((row) => row.feeBasis ?? null),
      rows.map((row) => row.notionalAmount),
      rows.map((row) => row.notionalAmountRaw),
      rows.map((row) => row.feeAmount),
      rows.map((row) => row.feeAmountRaw),
      rows.map((row) => row.venueFeeRateBps ?? null),
      rows.map((row) => row.venueEffectiveFeeBps ?? null),
      rows.map((row) => row.venueFeeAmount ?? null),
      rows.map((row) => row.venueFeeAmountRaw ?? null),
      rows.map((row) => row.filledAt),
    ],
  );

  return { upserted: result.rowCount ?? 0 };
}

export async function markVenueFeeBackfillAttempts(
  pool: Pool,
  inputs: VenueFeeBackfillAttemptInput[],
  options: { maxRetryAttempts?: number } = {},
): Promise<{ marked: number }> {
  if (!inputs.length) return { marked: 0 };
  const maxRetryAttempts = Math.max(
    1,
    Math.trunc(options.maxRetryAttempts ?? 8),
  );
  const result = await pool.query(
    `
      with input as (
        select *
        from unnest(
          $1::text[],
          $2::text[],
          $3::uuid[],
          $4::text[],
          $5::text[],
          $6::text[],
          $7::timestamptz[]
        ) as t(
          venue, fee_program, order_id, venue_order_id, status, reason,
          next_attempt_at
        )
      )
      insert into venue_fee_backfill_attempts (
        venue, fee_program, order_id, venue_order_id, status, reason, attempts,
        next_attempt_at, first_attempted_at, last_attempted_at, created_at,
        updated_at
      )
      select
        venue, fee_program, order_id, venue_order_id, status, reason, 1,
        next_attempt_at, now(), now(), now(), now()
      from input
      on conflict (venue, fee_program, order_id)
      do update set
        venue_order_id = coalesce(
          excluded.venue_order_id,
          venue_fee_backfill_attempts.venue_order_id
        ),
        status = case
          when excluded.status = 'retry'
            and venue_fee_backfill_attempts.attempts + 1 >= $8::int
            then 'failed'
          else excluded.status
        end,
        reason = case
          when excluded.status = 'retry'
            and venue_fee_backfill_attempts.attempts + 1 >= $8::int
            then excluded.reason || ' (max attempts reached)'
          else excluded.reason
        end,
        attempts = venue_fee_backfill_attempts.attempts + 1,
        next_attempt_at = case
          when excluded.status = 'retry'
            and venue_fee_backfill_attempts.attempts + 1 >= $8::int
            then null
          else excluded.next_attempt_at
        end,
        last_attempted_at = now(),
        updated_at = now()
      returning id
    `,
    [
      inputs.map((input) => input.venue),
      inputs.map((input) => input.feeProgram),
      inputs.map((input) => input.orderId),
      inputs.map((input) => input.venueOrderId),
      inputs.map((input) => input.status),
      inputs.map((input) => input.reason),
      inputs.map((input) => input.nextAttemptAt ?? null),
      maxRetryAttempts,
    ],
  );
  return { marked: result.rowCount ?? 0 };
}

export async function clearVenueFeeBackfillAttempts(
  pool: Pool,
  inputs: { venue: string; feeProgram: string; orderIds: string[] },
): Promise<{ deleted: number }> {
  if (!inputs.orderIds.length) return { deleted: 0 };
  const result = await pool.query(
    `
      delete from venue_fee_backfill_attempts
      where venue = $1
        and fee_program = $2
        and order_id = any($3::uuid[])
    `,
    [inputs.venue, inputs.feeProgram, inputs.orderIds],
  );
  return { deleted: result.rowCount ?? 0 };
}

async function insertCollectedFeeEventForAccrual(
  client: PoolClient,
  row: VenueFeeAccrualRow,
): Promise<string> {
  const snapshot = await resolveFeeEventSnapshotAtWrite(client, {
    userId: row.user_id,
    eventTime: row.filled_at,
    feeUsd: row.fee_amount,
  });
  const sourceId = feeEventSourceIdForAccrual(row);
  const result = await client.query<{ id: string }>(
    `
      insert into fee_events (
        id,
        user_id,
        wallet_address,
        venue,
        chain_id,
        source_type,
        source_id,
        fee_amount,
        fee_asset,
        fee_usd,
        cashback_bps_applied,
        referral_bps_applied,
        cashback_earned_usdc,
        referral_earned_usdc,
        liability_snapshot_source,
        tx_hash,
        collected_at,
        status,
        created_at,
        updated_at
      )
      values (
        gen_random_uuid(),
        $1, $2, $3, $4, 'order', $5,
        $6, $7, $6, $8, $9, $10, $11, $12, $13, now(), 'collected', now(), now()
      )
      on conflict (user_id, source_type, source_id)
      do update set
        tx_hash = excluded.tx_hash,
        collected_at = excluded.collected_at,
        status = excluded.status,
        updated_at = now()
      where fee_events.fee_amount = excluded.fee_amount
        and fee_events.fee_usd = excluded.fee_usd
        and fee_events.cashback_bps_applied = excluded.cashback_bps_applied
        and fee_events.referral_bps_applied = excluded.referral_bps_applied
        and fee_events.cashback_earned_usdc = excluded.cashback_earned_usdc
        and fee_events.referral_earned_usdc = excluded.referral_earned_usdc
        and fee_events.liability_snapshot_source = excluded.liability_snapshot_source
      returning id
    `,
    [
      row.user_id,
      row.wallet_address,
      row.venue,
      row.chain_id,
      sourceId,
      row.fee_amount,
      row.fee_asset,
      snapshot.cashbackBpsApplied,
      snapshot.referralBpsApplied,
      snapshot.cashbackEarnedUsdc,
      snapshot.referralEarnedUsdc,
      snapshot.liabilitySnapshotSource,
      row.tx_hash,
    ],
  );
  const feeEventId = result.rows[0]?.id;
  if (!feeEventId) {
    throw new Error(`fee_events immutable economic mismatch for ${sourceId}`);
  }
  return feeEventId;
}

export async function fetchVenueFeeAccrualReserveMicro(
  pool: Pool,
  options: { chainId?: string } = {},
): Promise<bigint> {
  const params: string[] = [];
  let chainClause = "";
  if (options.chainId) {
    params.push(options.chainId);
    chainClause = `and chain_id = $${params.length}`;
  }
  const { rows } = await pool.query<{ reserve_micro: string | null }>(
    `
      select coalesce(sum(fee_amount_raw::numeric), 0)::text as reserve_micro
      from venue_fee_accruals
      where status in ('accrued', 'verified')
        and fee_event_id is null
        and fee_amount_raw ~ '^[0-9]+$'
        ${chainClause}
    `,
    params,
  );
  return BigInt(rows[0]?.reserve_micro ?? "0");
}

export async function unlockVenueFeeAccruals(
  pool: Pool,
  options: {
    chainId: string;
    venue?: string;
    feeProgram?: string;
    limit?: number;
    dryRun?: boolean;
    assumeRewardsChainLock?: boolean;
  },
): Promise<{
  considered: number;
  unlocked: number;
  skipped: number;
  budgetMicro: string;
}> {
  const run = async () => {
    const params: string[] = [options.chainId];
    let filter = `
      chain_id = $1
      and status = 'verified'
      and fee_event_id is null
    `;
    if (options.venue) {
      params.push(options.venue);
      filter += ` and venue = $${params.length}`;
    }
    if (options.feeProgram) {
      params.push(options.feeProgram);
      filter += ` and fee_program = $${params.length}`;
    }

    const hasVerifiedRows = await pool.query<{ exists: number }>(
      `
        select 1 as exists
        from venue_fee_accruals
        where ${filter}
        limit 1
      `,
      params,
    );
    if (!hasVerifiedRows.rows.length) {
      return {
        considered: 0,
        unlocked: 0,
        skipped: 0,
        budgetMicro: "0",
      };
    }

    const report = await getRewardsTreasuryReport(pool, {
      chainId: options.chainId,
    });
    const chain = report.chains.find(
      (entry) => entry.chainId === options.chainId,
    );
    const budgetMicro = BigInt(chain?.sweepableNowMicro ?? "0");
    if (budgetMicro <= 0n) {
      return {
        considered: 0,
        unlocked: 0,
        skipped: 0,
        budgetMicro: budgetMicro.toString(),
      };
    }

    const limit = Math.max(1, Math.min(Math.trunc(options.limit ?? 25), 250));
    return tx(pool, async (client) => {
      const { rows } = await client.query<VenueFeeAccrualRow>(
        `
          select id, user_id, wallet_address, venue, fee_program, chain_id,
                 order_hash, venue_fill_id, venue_trade_id, tx_hash, token_id,
                 side, role, attribution_code, fee_rate_bps, fee_amount,
                 fee_amount_raw, fee_asset, filled_at
          from venue_fee_accruals
          where ${filter}
          order by filled_at asc, created_at asc
          limit $${params.length + 1}
          for update skip locked
        `,
        [...params, limit],
      );

      let remainingMicro = budgetMicro;
      let unlocked = 0;
      let skipped = 0;
      for (const row of rows) {
        const feeMicro = BigInt(row.fee_amount_raw || "0");
        if (feeMicro <= 0n) {
          skipped += 1;
          continue;
        }
        if (feeMicro > remainingMicro) {
          skipped += 1;
          continue;
        }
        if (options.dryRun) {
          remainingMicro -= feeMicro;
          unlocked += 1;
          continue;
        }

        const feeEventId = await insertCollectedFeeEventForAccrual(client, row);
        await client.query(
          `
            update venue_fee_accruals
            set fee_event_id = $2,
                collected_at = now(),
                status = 'collected',
                updated_at = now()
            where id = $1
          `,
          [row.id, feeEventId],
        );
        remainingMicro -= feeMicro;
        unlocked += 1;
      }

      return {
        considered: rows.length,
        unlocked,
        skipped,
        budgetMicro: budgetMicro.toString(),
      };
    });
  };

  if (options.assumeRewardsChainLock) return run();
  return withRewardsChainLocks(pool, [options.chainId], run);
}

export function venueFeeMicroToDecimal(rawMicro: bigint): string {
  return microToDecimal(rawMicro);
}

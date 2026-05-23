import { tx, type Pool, type PoolClient } from "@hunch/infra";
import { normalizeLimitlessRawTokenId } from "../lib/limitless-token.js";
import { usdcMicroToDecimalString } from "../lib/usdc.js";
import { isRecord } from "../lib/type-guards.js";
import { fetchConditionalTokensPayouts } from "./limitless-redemption.js";
import {
  extractLimitlessMessage,
  limitlessRequest,
} from "./limitless-client.js";

const LIMITLESS_VENUE = "limitless";
const LIMITLESS_FEE_PROGRAM = "venue_share";
export const LIMITLESS_CONTRACT_FEE_PROGRAM = "venue_share_contract";
const BASE_CHAIN_ID = "8453";

export type LimitlessContractFeeReceivableStatus =
  | "pending_resolution"
  | "resolved_payable"
  | "converted_to_fee_event"
  | "settled_zero"
  | "refunded"
  | "failed";

export type LimitlessContractFeeReceivableInput = {
  userId: string;
  walletAddress: string | null;
  signerAddress: string | null;
  orderId: string;
  orderHash: string;
  venueOrderId: string | null;
  txHash: string;
  logIndex: number;
  feeChargedLogIndex: number | null;
  feeRefundedLogIndex: number | null;
  feeReceiverAddress: string | null;
  rawTokenId: string;
  tokenId: string;
  side: "BUY" | "SELL";
  role: "maker" | "taker";
  feeRateBps: number;
  grossTokenAmountRaw: string;
  receivableTokenAmountRaw: string;
  filledAt: Date;
  status?: LimitlessContractFeeReceivableStatus;
  resolutionError?: string | null;
};

type ReceivableResolutionRow = {
  id: string;
  user_id: string;
  wallet_address: string | null;
  order_id: string;
  order_hash: string;
  venue_order_id: string | null;
  tx_hash: string;
  log_index: number;
  raw_token_id: string;
  token_id: string;
  side: "BUY" | "SELL";
  role: "maker" | "taker";
  fee_rate_bps: number;
  outcome_side: "YES" | "NO" | null;
  market_id: string | null;
  event_id: string | null;
  condition_id: string | null;
  receivable_token_amount_raw: string;
  filled_at: Date;
  resolution_attempts: number;
  token_market_id: string | null;
  token_outcome_side: "YES" | "NO" | null;
  unified_event_id: string | null;
  unified_condition_id: string | null;
  unified_resolved_outcome: "YES" | "NO" | null;
  unified_resolved_outcome_pct: string | null;
  unified_expiration_time: Date | null;
};

type ResolutionResult =
  | {
      kind: "resolved";
      source: string;
      resolvedOutcome: "YES" | "NO" | null;
      resolvedUsdcAmountRaw: string;
    }
  | {
      kind: "unresolved";
      reason: string;
      nextCheckAt: Date | null;
    }
  | {
      kind: "failed";
      reason: string;
    };

export function buildLimitlessContractFeeSourceId(inputs: {
  txHash: string;
  logIndex: number | string;
}): string {
  return `${LIMITLESS_VENUE}:${LIMITLESS_CONTRACT_FEE_PROGRAM}:${inputs.txHash}:${inputs.logIndex}`;
}

function clampBps(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(Math.max(Math.trunc(value), 0), 10_000);
}

function normalizeTokenId(rawTokenId: string): string {
  const stripped = normalizeLimitlessRawTokenId(rawTokenId) ?? rawTokenId;
  return stripped.startsWith("limitless:") ? stripped : `limitless:${stripped}`;
}

function rawDigits(value: unknown): string | null {
  if (typeof value === "bigint") return value >= 0n ? value.toString() : null;
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) {
    return String(value);
  }
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return /^\d+$/.test(trimmed) ? trimmed : null;
}

function microToDecimal(rawMicro: string): string {
  return usdcMicroToDecimalString(BigInt(rawMicro));
}

function stripLimitlessPrefix(value: string | null): string | null {
  if (!value) return null;
  return value.startsWith("limitless:") ? value.slice(10) : value;
}

function isConditionId(value: string | null): value is string {
  return typeof value === "string" && /^0x[0-9a-fA-F]{64}$/.test(value);
}

function backoffNextCheck(
  attempts: number,
  expirationTime: Date | null,
  now = new Date(),
): Date {
  if (expirationTime && expirationTime.getTime() > now.getTime()) {
    return new Date(expirationTime.getTime() + 15 * 60 * 1000);
  }
  const delaysMs = [
    15 * 60 * 1000,
    60 * 60 * 1000,
    6 * 60 * 60 * 1000,
    24 * 60 * 60 * 1000,
  ];
  return new Date(
    now.getTime() + delaysMs[Math.min(attempts, delaysMs.length - 1)],
  );
}

export function convertLimitlessReceivableRaw(
  receivableRaw: string,
  payoutNumerator: string | bigint,
  payoutDenominator: string | bigint,
): string {
  const raw = BigInt(receivableRaw);
  const numerator =
    typeof payoutNumerator === "bigint"
      ? payoutNumerator
      : BigInt(payoutNumerator);
  const denominator =
    typeof payoutDenominator === "bigint"
      ? payoutDenominator
      : BigInt(payoutDenominator);
  if (raw <= 0n || numerator <= 0n || denominator <= 0n) return "0";
  return ((raw * numerator) / denominator).toString();
}

export async function upsertLimitlessContractFeeReceivables(
  pool: Pool,
  inputs: Array<LimitlessContractFeeReceivableInput | null>,
): Promise<{ upserted: number }> {
  const rows = inputs.filter(
    (input): input is LimitlessContractFeeReceivableInput => input != null,
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
          $5::uuid[],
          $6::text[],
          $7::text[],
          $8::text[],
          $9::int[],
          $10::int[],
          $11::int[],
          $12::text[],
          $13::text[],
          $14::text[],
          $15::text[],
          $16::text[],
          $17::int[],
          $18::text[],
          $19::text[],
          $20::text[],
          $21::text[],
          $22::timestamptz[],
          $23::text[],
          $24::text[]
        ) as t(
          user_id, wallet_address, signer_address, chain_id, order_id,
          order_hash, venue_order_id, tx_hash, log_index,
          fee_charged_log_index, fee_refunded_log_index, fee_receiver_address,
          raw_token_id, token_id, side, role, fee_rate_bps,
          gross_token_amount_raw, receivable_token_amount_raw, status,
          resolution_error, filled_at, venue, fee_program
        )
      )
      insert into limitless_contract_fee_receivables (
        user_id, wallet_address, signer_address, chain_id, order_id,
        order_hash, venue_order_id, tx_hash, log_index,
        fee_charged_log_index, fee_refunded_log_index, fee_receiver_address,
        raw_token_id, token_id, side, role, fee_rate_bps,
        gross_token_amount_raw, receivable_token_amount_raw, status,
        resolution_error, next_resolution_check_at, filled_at, venue,
        fee_program, created_at, updated_at
      )
      select
        user_id, wallet_address, signer_address, chain_id, order_id,
        order_hash, venue_order_id, tx_hash, log_index,
        fee_charged_log_index, fee_refunded_log_index, fee_receiver_address,
        raw_token_id, token_id, side, role, fee_rate_bps,
        gross_token_amount_raw, receivable_token_amount_raw, status,
        resolution_error,
        case when status = 'pending_resolution' then now() else null end,
        filled_at, venue, fee_program, now(), now()
      from input
      on conflict (venue, fee_program, tx_hash, log_index, token_id)
      do update set
        wallet_address = coalesce(excluded.wallet_address, limitless_contract_fee_receivables.wallet_address),
        signer_address = coalesce(excluded.signer_address, limitless_contract_fee_receivables.signer_address),
        order_hash = excluded.order_hash,
        venue_order_id = coalesce(excluded.venue_order_id, limitless_contract_fee_receivables.venue_order_id),
        fee_charged_log_index = coalesce(excluded.fee_charged_log_index, limitless_contract_fee_receivables.fee_charged_log_index),
        fee_refunded_log_index = coalesce(excluded.fee_refunded_log_index, limitless_contract_fee_receivables.fee_refunded_log_index),
        fee_receiver_address = coalesce(excluded.fee_receiver_address, limitless_contract_fee_receivables.fee_receiver_address),
        role = excluded.role,
        fee_rate_bps = excluded.fee_rate_bps,
        gross_token_amount_raw = excluded.gross_token_amount_raw,
        receivable_token_amount_raw = excluded.receivable_token_amount_raw,
        status = case
          when limitless_contract_fee_receivables.status = 'converted_to_fee_event' then limitless_contract_fee_receivables.status
          when excluded.status = 'refunded' then 'refunded'
          else limitless_contract_fee_receivables.status
        end,
        resolution_error = case
          when excluded.status = 'refunded' then excluded.resolution_error
          else limitless_contract_fee_receivables.resolution_error
        end,
        updated_at = now()
      returning id
    `,
    [
      rows.map((row) => row.userId),
      rows.map((row) => row.walletAddress),
      rows.map((row) => row.signerAddress),
      rows.map(() => BASE_CHAIN_ID),
      rows.map((row) => row.orderId),
      rows.map((row) => row.orderHash),
      rows.map((row) => row.venueOrderId),
      rows.map((row) => row.txHash),
      rows.map((row) => row.logIndex),
      rows.map((row) => row.feeChargedLogIndex),
      rows.map((row) => row.feeRefundedLogIndex),
      rows.map((row) => row.feeReceiverAddress),
      rows.map(
        (row) => normalizeLimitlessRawTokenId(row.rawTokenId) ?? row.rawTokenId,
      ),
      rows.map((row) => normalizeTokenId(row.tokenId)),
      rows.map((row) => row.side),
      rows.map((row) => row.role),
      rows.map((row) => clampBps(row.feeRateBps)),
      rows.map((row) => row.grossTokenAmountRaw),
      rows.map((row) => row.receivableTokenAmountRaw),
      rows.map((row) => row.status ?? "pending_resolution"),
      rows.map((row) => row.resolutionError ?? null),
      rows.map((row) => row.filledAt),
      rows.map(() => LIMITLESS_VENUE),
      rows.map(() => LIMITLESS_FEE_PROGRAM),
    ],
  );

  return { upserted: result.rowCount ?? 0 };
}

function apiRecord(payload: unknown): Record<string, unknown> | null {
  if (!isRecord(payload)) return null;
  if (isRecord(payload.data)) return payload.data;
  return payload;
}

function apiResolvedOutcomeFromMarket(
  market: Record<string, unknown>,
): "YES" | "NO" | null {
  const status = typeof market.status === "string" ? market.status : null;
  if (status !== "RESOLVED") return null;
  const indexRaw = market.winningOutcomeIndex;
  const winningOutcomeIndex =
    typeof indexRaw === "number"
      ? indexRaw
      : typeof indexRaw === "string"
        ? Number(indexRaw)
        : null;
  if (winningOutcomeIndex == null || !Number.isFinite(winningOutcomeIndex)) {
    return null;
  }

  const tokens = isRecord(market.tokens) ? market.tokens : null;
  const yes =
    rawDigits(tokens?.yes) ??
    (typeof tokens?.yes === "string" ? stripLimitlessPrefix(tokens.yes) : null);
  const no =
    rawDigits(tokens?.no) ??
    (typeof tokens?.no === "string" ? stripLimitlessPrefix(tokens.no) : null);
  const outcomeTokens = Array.isArray(market.outcomeTokens)
    ? market.outcomeTokens
        .filter((value): value is string => typeof value === "string")
        .map(stripLimitlessPrefix)
    : [];
  const winningToken = outcomeTokens[winningOutcomeIndex] ?? null;
  if (winningToken && yes && winningToken === stripLimitlessPrefix(yes)) {
    return "YES";
  }
  if (winningToken && no && winningToken === stripLimitlessPrefix(no)) {
    return "NO";
  }
  return winningOutcomeIndex === 0
    ? "YES"
    : winningOutcomeIndex === 1
      ? "NO"
      : null;
}

async function fetchLimitlessApiResolution(
  row: ReceivableResolutionRow,
): Promise<ResolutionResult | null> {
  const marketRef = stripLimitlessPrefix(row.market_id);
  if (!marketRef) return null;
  const upstream = await limitlessRequest({
    method: "GET",
    requestPath: `/markets/${encodeURIComponent(marketRef)}`,
    auth: "none",
  });
  if (!upstream.ok) {
    const message = extractLimitlessMessage(upstream.payload);
    return {
      kind: "unresolved",
      reason: message
        ? `Limitless API market resolution unavailable (${upstream.status}): ${message}`
        : `Limitless API market resolution unavailable (${upstream.status})`,
      nextCheckAt: backoffNextCheck(
        row.resolution_attempts,
        row.unified_expiration_time,
      ),
    };
  }
  const market = apiRecord(upstream.payload);
  if (!market) return null;
  const resolvedOutcome = apiResolvedOutcomeFromMarket(market);
  if (!resolvedOutcome) return null;
  const raw =
    resolvedOutcome === row.outcome_side
      ? row.receivable_token_amount_raw
      : "0";
  return {
    kind: "resolved",
    source: "limitless_api",
    resolvedOutcome,
    resolvedUsdcAmountRaw: raw,
  };
}

async function resolveReceivable(
  row: ReceivableResolutionRow,
): Promise<ResolutionResult> {
  const outcomeSide = row.outcome_side ?? row.token_outcome_side;
  if (!outcomeSide) {
    return {
      kind: "unresolved",
      reason: "Limitless receivable token outcome side not indexed yet",
      nextCheckAt: backoffNextCheck(
        row.resolution_attempts,
        row.unified_expiration_time,
      ),
    };
  }

  if (row.unified_resolved_outcome) {
    const raw =
      row.unified_resolved_outcome === outcomeSide
        ? row.receivable_token_amount_raw
        : "0";
    return {
      kind: "resolved",
      source: "db",
      resolvedOutcome: row.unified_resolved_outcome,
      resolvedUsdcAmountRaw: raw,
    };
  }

  if (row.unified_resolved_outcome_pct != null) {
    const pct = Number(row.unified_resolved_outcome_pct);
    if (Number.isFinite(pct) && pct >= 0 && pct <= 10_000) {
      const numerator =
        outcomeSide === "YES" ? Math.trunc(pct) : 10_000 - Math.trunc(pct);
      return {
        kind: "resolved",
        source: "db_pct",
        resolvedOutcome: pct === 10_000 ? "YES" : pct === 0 ? "NO" : null,
        resolvedUsdcAmountRaw: convertLimitlessReceivableRaw(
          row.receivable_token_amount_raw,
          String(numerator),
          "10000",
        ),
      };
    }
  }

  const conditionId = row.condition_id ?? row.unified_condition_id;
  if (isConditionId(conditionId)) {
    const [payout] = await fetchConditionalTokensPayouts({
      conditionIds: [conditionId],
    });
    if (payout && payout.redeemable) {
      const numerator =
        outcomeSide === "YES"
          ? payout.payoutNumerators[0]
          : payout.payoutNumerators[1];
      return {
        kind: "resolved",
        source: "onchain",
        resolvedOutcome: payout.resolvedOutcome,
        resolvedUsdcAmountRaw: convertLimitlessReceivableRaw(
          row.receivable_token_amount_raw,
          numerator,
          payout.payoutDenominator,
        ),
      };
    }
  }

  const apiResolution = await fetchLimitlessApiResolution({
    ...row,
    outcome_side: outcomeSide,
  });
  if (apiResolution) return apiResolution;

  return {
    kind: "unresolved",
    reason: "Limitless market is not resolved yet",
    nextCheckAt: backoffNextCheck(
      row.resolution_attempts,
      row.unified_expiration_time,
    ),
  };
}

async function upsertVerifiedAccrualForReceivable(
  client: PoolClient,
  row: ReceivableResolutionRow,
  feeUsdRaw: string,
): Promise<string> {
  const feeUsd = microToDecimal(feeUsdRaw);
  const result = await client.query<{ id: string }>(
    `
      with upserted as (
        insert into venue_fee_accruals (
          user_id,
          wallet_address,
          signer_address,
          venue,
          fee_program,
          chain_id,
          order_id,
          order_hash,
          venue_order_id,
          venue_fill_id,
          venue_trade_id,
          tx_hash,
          log_index,
          token_id,
          side,
          role,
          attribution_code,
          fee_rate_bps,
          fee_basis,
          notional_amount,
          notional_amount_raw,
          fee_amount,
          fee_amount_raw,
          fee_asset,
          filled_at,
          chain_verified_at,
          status,
          created_at,
          updated_at
        )
        values (
          $1, $2, null, 'limitless', 'venue_share_contract', '8453',
          $3, $4, $5, $6, null, $7, $8, $9, $10, $11, null, $12,
          'venue_fee_share', $13, $14, $13, $14, 'USDC', $15, now(),
          'verified', now(), now()
        )
        on conflict (venue, fee_program, order_id, venue_fill_id)
        do update set
          tx_hash = coalesce(excluded.tx_hash, venue_fee_accruals.tx_hash),
          log_index = coalesce(excluded.log_index, venue_fee_accruals.log_index),
          token_id = excluded.token_id,
          fee_basis = excluded.fee_basis,
          notional_amount = excluded.notional_amount,
          notional_amount_raw = excluded.notional_amount_raw,
          fee_amount = excluded.fee_amount,
          fee_amount_raw = excluded.fee_amount_raw,
          fee_asset = excluded.fee_asset,
          filled_at = excluded.filled_at,
          chain_verified_at = coalesce(venue_fee_accruals.chain_verified_at, excluded.chain_verified_at),
          status = case
            when venue_fee_accruals.status = 'accrued' then 'verified'
            else venue_fee_accruals.status
          end,
          updated_at = now()
        where venue_fee_accruals.status in ('accrued', 'verified')
        returning id
      )
      select id from upserted
      union all
      select id
      from venue_fee_accruals
      where venue = 'limitless'
        and fee_program = 'venue_share_contract'
        and order_id = $3
        and venue_fill_id = $6
        and status in ('accrued', 'verified', 'collected')
      limit 1
    `,
    [
      row.user_id,
      row.wallet_address,
      row.order_id,
      row.order_hash,
      row.venue_order_id,
      String(row.log_index),
      row.tx_hash,
      row.log_index,
      row.token_id,
      row.side,
      row.role,
      row.fee_rate_bps,
      feeUsd,
      feeUsdRaw,
      row.filled_at,
    ],
  );
  const accrualId = result.rows[0]?.id;
  if (!accrualId) {
    const sourceId = buildLimitlessContractFeeSourceId({
      txHash: row.tx_hash,
      logIndex: row.log_index,
    });
    throw new Error(`venue_fee_accruals immutable mismatch for ${sourceId}`);
  }
  return accrualId;
}

export async function syncLimitlessContractReceivablesFromAccruals(
  pool: Pool,
): Promise<{ synced: number }> {
  const result = await pool.query(
    `
      update limitless_contract_fee_receivables r
      set status = 'converted_to_fee_event',
          fee_event_id = a.fee_event_id,
          updated_at = now()
      from venue_fee_accruals a
      where r.accrual_id = a.id
        and r.status = 'resolved_payable'
        and a.status = 'collected'
        and a.fee_event_id is not null
    `,
  );
  return { synced: result.rowCount ?? 0 };
}

async function linkPendingFeeEventIfPresent(
  client: PoolClient,
  row: ReceivableResolutionRow,
): Promise<string | null> {
  const sourceId = buildLimitlessContractFeeSourceId({
    txHash: row.tx_hash,
    logIndex: row.log_index,
  });
  const result = await client.query<{ id: string }>(
    `
      select id
      from fee_events
      where user_id = $1
        and source_type = 'order'
        and source_id = $2
        and status = 'pending'
      limit 1
    `,
    [row.user_id, sourceId],
  );
  return result.rows[0]?.id ?? null;
}

export function buildLimitlessContractAccrualSourceId(inputs: {
  venue: string;
  feeProgram: string;
  orderHash: string;
  venueFillId: string;
  txHash: string | null;
}): string {
  if (
    inputs.venue === LIMITLESS_VENUE &&
    inputs.feeProgram === LIMITLESS_CONTRACT_FEE_PROGRAM &&
    inputs.txHash
  ) {
    return buildLimitlessContractFeeSourceId({
      txHash: inputs.txHash,
      logIndex: inputs.venueFillId,
    });
  }
  return `${inputs.venue}:${inputs.feeProgram}:${inputs.orderHash}:${inputs.venueFillId}`;
}

export async function reconcileLimitlessContractFeeReceivables(
  pool: Pool,
  options: { limit?: number; dryRun?: boolean } = {},
): Promise<{
  checked: number;
  pending: number;
  settledZero: number;
  converted: number;
  failed: number;
}> {
  const limit = Math.max(1, Math.min(Math.trunc(options.limit ?? 25), 100));
  const { rows } = await pool.query<ReceivableResolutionRow>(
    `
      select
        r.id,
        r.user_id,
        r.wallet_address,
        r.order_id,
        r.order_hash,
        r.venue_order_id,
        r.tx_hash,
        r.log_index,
        r.raw_token_id,
        r.token_id,
        r.side,
        r.role,
        r.fee_rate_bps,
        r.outcome_side,
        r.market_id,
        r.event_id,
        r.condition_id,
        r.receivable_token_amount_raw,
        r.filled_at,
        r.resolution_attempts,
        mt.market_id as token_market_id,
        case when mt.outcome_side in ('YES', 'NO') then mt.outcome_side else null end as token_outcome_side,
        m.event_id as unified_event_id,
        m.condition_id as unified_condition_id,
        case when m.resolved_outcome in ('YES', 'NO') then m.resolved_outcome else null end as unified_resolved_outcome,
        m.resolved_outcome_pct::text as unified_resolved_outcome_pct,
        m.expiration_time as unified_expiration_time
      from limitless_contract_fee_receivables r
      left join unified_market_tokens mt
        on mt.venue = 'limitless'
       and mt.token_id = r.token_id
      left join unified_markets m
        on m.id = coalesce(r.market_id, mt.market_id)
      where r.status = 'pending_resolution'
        and coalesce(r.next_resolution_check_at, now()) <= now()
      order by r.next_resolution_check_at asc nulls first, r.filled_at asc, r.id asc
      limit $1
    `,
    [limit],
  );
  if (!rows.length) {
    return { checked: 0, pending: 0, settledZero: 0, converted: 0, failed: 0 };
  }

  let pending = 0;
  let settledZero = 0;
  let converted = 0;
  let failed = 0;
  for (const row of rows) {
    try {
      const resolution = await resolveReceivable(row);
      if (resolution.kind === "unresolved") {
        pending += 1;
        if (!options.dryRun) {
          await pool.query(
            `
              update limitless_contract_fee_receivables
              set market_id = coalesce(market_id, $2),
                  event_id = coalesce(event_id, $3),
                  condition_id = coalesce(condition_id, $4),
                  outcome_side = coalesce(outcome_side, $5),
                  resolution_attempts = resolution_attempts + 1,
                  last_resolution_checked_at = now(),
                  next_resolution_check_at = $6,
                  resolution_error = $7,
                  updated_at = now()
              where id = $1
            `,
            [
              row.id,
              row.token_market_id,
              row.unified_event_id,
              row.unified_condition_id,
              row.token_outcome_side,
              resolution.nextCheckAt,
              resolution.reason,
            ],
          );
        }
        continue;
      }
      if (resolution.kind === "failed") {
        failed += 1;
        if (!options.dryRun) {
          await pool.query(
            `
              update limitless_contract_fee_receivables
              set status = 'failed',
                  resolution_attempts = resolution_attempts + 1,
                  last_resolution_checked_at = now(),
                  next_resolution_check_at = null,
                  resolution_error = $2,
                  updated_at = now()
              where id = $1
            `,
            [row.id, resolution.reason],
          );
        }
        continue;
      }

      const resolvedRaw = resolution.resolvedUsdcAmountRaw;
      if (BigInt(resolvedRaw) <= 0n) {
        settledZero += 1;
        if (!options.dryRun) {
          await pool.query(
            `
              update limitless_contract_fee_receivables
              set status = 'settled_zero',
                  market_id = coalesce(market_id, $2),
                  event_id = coalesce(event_id, $3),
                  condition_id = coalesce(condition_id, $4),
                  outcome_side = coalesce(outcome_side, $5),
                  resolved_outcome = $6,
                  resolution_source = $7,
                  resolved_usdc_amount_raw = '0',
                  resolved_usdc_amount = 0,
                  resolved_at = coalesce(resolved_at, now()),
                  last_resolution_checked_at = now(),
                  next_resolution_check_at = null,
                  resolution_error = null,
                  updated_at = now()
              where id = $1
            `,
            [
              row.id,
              row.token_market_id,
              row.unified_event_id,
              row.unified_condition_id,
              row.token_outcome_side,
              resolution.resolvedOutcome,
              resolution.source,
            ],
          );
        }
        continue;
      }

      converted += 1;
      if (!options.dryRun) {
        await tx(pool, async (client) => {
          const latest = await client.query<ReceivableResolutionRow>(
            `
              select
                id, user_id, wallet_address, order_id, order_hash,
                venue_order_id, tx_hash, log_index, raw_token_id, token_id,
                side, role, fee_rate_bps, outcome_side, market_id, event_id, condition_id,
                receivable_token_amount_raw, filled_at, resolution_attempts,
                null::text as token_market_id,
                null::text as token_outcome_side,
                null::text as unified_event_id,
                null::text as unified_condition_id,
                null::text as unified_resolved_outcome,
                null::text as unified_resolved_outcome_pct,
                null::timestamptz as unified_expiration_time
              from limitless_contract_fee_receivables
              where id = $1
                and status = 'pending_resolution'
              for update
            `,
            [row.id],
          );
          const locked = latest.rows[0];
          if (!locked) return;
          const accrualId = await upsertVerifiedAccrualForReceivable(
            client,
            { ...locked, ...row },
            resolvedRaw,
          );
          const pendingFeeEventId = await linkPendingFeeEventIfPresent(
            client,
            { ...locked, ...row },
          );
          await client.query(
            `
              update limitless_contract_fee_receivables
              set status = 'resolved_payable',
                  market_id = coalesce(market_id, $2),
                  event_id = coalesce(event_id, $3),
                  condition_id = coalesce(condition_id, $4),
                  outcome_side = coalesce(outcome_side, $5),
                  resolved_outcome = $6,
                  resolution_source = $7,
                  resolved_usdc_amount_raw = $8,
                  resolved_usdc_amount = $9,
                  accrual_id = $10,
                  fee_event_id = coalesce(fee_event_id, $11),
                  resolved_at = coalesce(resolved_at, now()),
                  last_resolution_checked_at = now(),
                  next_resolution_check_at = null,
                  resolution_error = null,
                  updated_at = now()
              where id = $1
            `,
            [
              row.id,
              row.token_market_id,
              row.unified_event_id,
              row.unified_condition_id,
              row.token_outcome_side,
              resolution.resolvedOutcome,
              resolution.source,
              resolvedRaw,
              microToDecimal(resolvedRaw),
              accrualId,
              pendingFeeEventId,
            ],
          );
        });
      }
    } catch (error) {
      failed += 1;
      const message = error instanceof Error ? error.message : String(error);
      if (!options.dryRun) {
        await pool.query(
          `
            update limitless_contract_fee_receivables
            set resolution_attempts = resolution_attempts + 1,
                last_resolution_checked_at = now(),
                next_resolution_check_at = $2,
                resolution_error = $3,
                updated_at = now()
            where id = $1
          `,
          [
            row.id,
            backoffNextCheck(
              row.resolution_attempts,
              row.unified_expiration_time,
            ),
            message,
          ],
        );
      }
    }
  }

  return {
    checked: rows.length,
    pending,
    settledZero,
    converted,
    failed,
  };
}

export function buildLimitlessContractFeeReceivableInput(inputs: {
  userId: string;
  walletAddress: string | null;
  signerAddress: string | null;
  orderId: string;
  orderHash: string;
  venueOrderId: string | null;
  txHash: string;
  logIndex: number;
  feeChargedLogIndex: number | null;
  feeRefundedLogIndex: number | null;
  feeReceiverAddress: string | null;
  rawTokenId: string;
  side: "BUY" | "SELL";
  role: "maker" | "taker";
  feeRateBps: number;
  grossTokenAmountRaw: string;
  receivableTokenAmountRaw: string;
  filledAt: Date;
  refunded?: boolean;
}): LimitlessContractFeeReceivableInput {
  return {
    ...inputs,
    tokenId: normalizeTokenId(inputs.rawTokenId),
    status: inputs.refunded ? "refunded" : "pending_resolution",
    resolutionError: inputs.refunded
      ? "Limitless contract-denominated fee was refunded in the same transaction"
      : null,
  };
}

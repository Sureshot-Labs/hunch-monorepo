import type { Pool } from "@hunch/infra";
import type { PgParams } from "../server-types.js";

export type ExecutionRow = {
  id: string;
  user_id: string;
  wallet_address: string | null;
  venue: string;
  unified_market_id: string | null;
  side: string | null;
  outcome: string | null;
  input_mint: string | null;
  output_mint: string | null;
  amount_in: string | null;
  amount_out: string | null;
  input_decimals: number | null;
  output_decimals: number | null;
  quote_id: string | null;
  tx_signature: string | null;
  venue_order_id: string | null;
  status: string | null;
  raw: unknown;
  created_at: Date;
  updated_at: Date;
};

function buildExecutionStatusUpdateSql(): string {
  return `
    case
      when executions.status in ('fulfilled', 'no_fill', 'failed') then executions.status
      when excluded.status is null then executions.status
      when excluded.status in ('fulfilled', 'no_fill', 'failed') then excluded.status
      when executions.status = 'pending_close' and excluded.status in ('submitted', 'open') then executions.status
      when executions.status = 'open' and excluded.status = 'submitted' then executions.status
      else excluded.status
    end
  `;
}

const EXECUTION_STATUS_UPDATE_SQL = buildExecutionStatusUpdateSql();

function buildExecutionRawUpdateSql(): string {
  return `
    case
      when executions.status in ('fulfilled', 'no_fill', 'failed')
        and (
          excluded.status is null or excluded.status not in ('fulfilled', 'no_fill', 'failed')
        )
        then coalesce(executions.raw, excluded.raw)
      else coalesce(excluded.raw, executions.raw)
    end
  `;
}

const EXECUTION_RAW_UPDATE_SQL = buildExecutionRawUpdateSql();

export async function storeExecution(
  pool: Pool,
  inputs: {
    userId: string;
    walletAddress: string;
    venue: string;
    unifiedMarketId?: string | null;
    side?: string | null;
    outcome?: string | null;
    inputMint?: string | null;
    outputMint?: string | null;
    amountIn?: string | number | null;
    amountOut?: string | number | null;
    inputDecimals?: number | null;
    outputDecimals?: number | null;
    quoteId?: string | null;
    txSignature?: string | null;
    venueOrderId?: string | null;
    status?: string | null;
    raw?: unknown;
  },
): Promise<ExecutionRow> {
  const amountIn =
    inputs.amountIn == null ? null : String(inputs.amountIn);
  const amountOut =
    inputs.amountOut == null ? null : String(inputs.amountOut);

  const { rows } = await pool.query<ExecutionRow>(
    `
      insert into executions (
        id,
        user_id,
        wallet_address,
        venue,
        unified_market_id,
        side,
        outcome,
        input_mint,
        output_mint,
        amount_in,
        amount_out,
        input_decimals,
        output_decimals,
        quote_id,
        tx_signature,
        venue_order_id,
        status,
        raw,
        created_at,
        updated_at
      )
      values (
        gen_random_uuid(),
        $1, $2, $3, $4, $5, $6, $7, $8, $9,
        $10, $11, $12, $13, $14, $15, $16, $17,
        now(), now()
      )
      on conflict on constraint executions_user_id_wallet_address_venue_tx_signature_key
      do update set
        unified_market_id = excluded.unified_market_id,
        side = coalesce(excluded.side, executions.side),
        outcome = coalesce(excluded.outcome, executions.outcome),
        input_mint = coalesce(excluded.input_mint, executions.input_mint),
        output_mint = coalesce(excluded.output_mint, executions.output_mint),
        amount_in = coalesce(excluded.amount_in, executions.amount_in),
        amount_out = coalesce(excluded.amount_out, executions.amount_out),
        input_decimals = coalesce(excluded.input_decimals, executions.input_decimals),
        output_decimals = coalesce(excluded.output_decimals, executions.output_decimals),
        quote_id = coalesce(excluded.quote_id, executions.quote_id),
        venue_order_id = coalesce(excluded.venue_order_id, executions.venue_order_id),
        status = ${EXECUTION_STATUS_UPDATE_SQL},
        raw = ${EXECUTION_RAW_UPDATE_SQL},
        updated_at = now()
      returning
        id,
        user_id,
        wallet_address,
        venue,
        unified_market_id,
        side,
        outcome,
        input_mint,
        output_mint,
        amount_in,
        amount_out,
        input_decimals,
        output_decimals,
        quote_id,
        tx_signature,
        venue_order_id,
        status,
        raw,
        created_at,
        updated_at
    `,
    [
      inputs.userId,
      inputs.walletAddress,
      inputs.venue,
      inputs.unifiedMarketId ?? null,
      inputs.side ?? null,
      inputs.outcome ?? null,
      inputs.inputMint ?? null,
      inputs.outputMint ?? null,
      amountIn,
      amountOut,
      inputs.inputDecimals ?? null,
      inputs.outputDecimals ?? null,
      inputs.quoteId ?? null,
      inputs.txSignature ?? null,
      inputs.venueOrderId ?? null,
      inputs.status ?? null,
      inputs.raw ?? null,
    ],
  );

  if (!rows[0]) {
    throw new Error("Failed to store execution");
  }

  return rows[0];
}

export async function fetchPendingKalshiExecutions(
  pool: Pool,
  inputs: {
    limit: number;
    minAgeSec: number;
  },
): Promise<ExecutionRow[]> {
  const limit = Math.max(1, Math.trunc(inputs.limit));
  const minAgeSec = Math.max(0, Math.trunc(inputs.minAgeSec));
  const { rows } = await pool.query<ExecutionRow>(
    `
      select
        id,
        user_id,
        wallet_address,
        venue,
        unified_market_id,
        side,
        outcome,
        input_mint,
        output_mint,
        amount_in,
        amount_out,
        input_decimals,
        output_decimals,
        quote_id,
        tx_signature,
        venue_order_id,
        status,
        raw,
        created_at,
        updated_at
      from executions
      where venue = 'kalshi'
        and wallet_address is not null
        and tx_signature is not null
        and coalesce(status, 'submitted') in ('submitted', 'open', 'pending_close')
        and created_at <= now() - ($1::int * interval '1 second')
      order by created_at asc
      limit $2
    `,
    [minAgeSec, limit],
  );

  return rows;
}

export async function fetchFulfilledKalshiTradeExecutionsMissingFeeEvent(
  pool: Pool,
  inputs: {
    limit: number;
    minAgeSec: number;
  },
): Promise<ExecutionRow[]> {
  const limit = Math.max(1, Math.trunc(inputs.limit));
  const minAgeSec = Math.max(0, Math.trunc(inputs.minAgeSec));
  const { rows } = await pool.query<ExecutionRow>(
    `
      select
        e.id,
        e.user_id,
        e.wallet_address,
        e.venue,
        e.unified_market_id,
        e.side,
        e.outcome,
        e.input_mint,
        e.output_mint,
        e.amount_in,
        e.amount_out,
        e.input_decimals,
        e.output_decimals,
        e.quote_id,
        e.tx_signature,
        e.venue_order_id,
        e.status,
        e.raw,
        e.created_at,
        e.updated_at
      from executions e
      left join fee_events fe
        on fe.user_id = e.user_id
       and fe.source_type = 'execution'
       and fe.source_id = e.id::text
      where e.venue = 'kalshi'
        and e.wallet_address is not null
        and e.tx_signature is not null
        and e.status = 'fulfilled'
        and coalesce(e.raw->>'purpose', 'trade') = 'trade'
        and fe.id is null
        and e.created_at <= now() - ($1::int * interval '1 second')
      order by e.created_at asc
      limit $2
    `,
    [minAgeSec, limit],
  );

  return rows;
}

export async function fetchExecutionsForUserWallet(
  pool: Pool,
  inputs: {
    userId: string;
    walletAddress: string;
    venue?: string;
    marketId?: string;
    limit: number;
    offset: number;
  },
): Promise<{ rows: ExecutionRow[]; total: number }> {
  let whereClause =
    "where user_id = $1 and (wallet_address is null or wallet_address = $2)";
  const params: PgParams = [inputs.userId, inputs.walletAddress];
  let paramCount = 2;

  if (inputs.venue) {
    paramCount += 1;
    whereClause += ` and venue = $${paramCount}`;
    params.push(inputs.venue);
  }

  if (inputs.marketId) {
    paramCount += 1;
    whereClause += ` and unified_market_id = $${paramCount}`;
    params.push(inputs.marketId);
  }

  const limit = inputs.limit;
  const offset = inputs.offset;

  const { rows } = await pool.query<ExecutionRow>(
    `
      select
        id,
        user_id,
        wallet_address,
        venue,
        unified_market_id,
        side,
        outcome,
        input_mint,
        output_mint,
        amount_in,
        amount_out,
        input_decimals,
        output_decimals,
        quote_id,
        tx_signature,
        venue_order_id,
        status,
        raw,
        created_at,
        updated_at
      from executions
      ${whereClause}
      order by created_at desc
      limit $${paramCount + 1} offset $${paramCount + 2}
    `,
    [...params, limit, offset],
  );

  const countResult = await pool.query<{ total: string }>(
    `select count(*) as total from executions ${whereClause}`,
    params,
  );

  return {
    rows,
    total: Number(countResult.rows[0]?.total ?? 0),
  };
}

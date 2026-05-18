import type { Pool } from "@hunch/infra";

export type PolymarketMarketInfoRow = {
  polymarket_id: string;
  unified_market_id: string | null;
  condition_id: string | null;
  clob_token_ids: string | null;
  neg_risk: boolean | null;
  order_price_min_tick_size: unknown;
  order_min_size: unknown;
  accepting_orders: boolean | null;
  taker_fee_bps: string | null;
  maker_fee_bps: string | null;
};

export async function fetchPolymarketMarketInfo(
  pool: Pool,
  inputs: { tokenId?: string; marketId?: string; conditionId?: string },
): Promise<PolymarketMarketInfoRow | null> {
  const tokenId = inputs.tokenId?.trim();
  const marketId = inputs.marketId?.trim();
  const conditionId = inputs.conditionId?.trim();

  if (tokenId) {
    const fastResult = await pool.query<PolymarketMarketInfoRow>(
      `
        select
          pm.id as polymarket_id,
          m.id as unified_market_id,
          pm.condition_id,
          pm.clob_token_ids,
          pm.neg_risk,
          pm.order_price_min_tick_size,
          pm.order_min_size,
          pm.accepting_orders,
          coalesce(pm.raw->>'takerBaseFee', pm.raw->>'taker_fee_bps') as taker_fee_bps,
          coalesce(pm.raw->>'makerBaseFee', pm.raw->>'maker_fee_bps') as maker_fee_bps
        from unified_tokens ut
        join unified_markets m
          on m.id = ut.market_id
         and m.venue = 'polymarket'
        join polymarket_markets pm
          on pm.id = m.venue_market_id
        where ut.token_id = $1
          and ut.venue = 'polymarket'
        limit 1
      `,
      [tokenId],
    );

    if (fastResult.rows[0]) return fastResult.rows[0];

    const fallbackResult = await pool.query<PolymarketMarketInfoRow>(
      `
        select
          pm.id as polymarket_id,
          m.id as unified_market_id,
          pm.condition_id,
          pm.clob_token_ids,
          pm.neg_risk,
          pm.order_price_min_tick_size,
          pm.order_min_size,
          pm.accepting_orders,
          coalesce(pm.raw->>'takerBaseFee', pm.raw->>'taker_fee_bps') as taker_fee_bps,
          coalesce(pm.raw->>'makerBaseFee', pm.raw->>'maker_fee_bps') as maker_fee_bps
        from unified_markets m
        join polymarket_markets pm
          on pm.id = m.venue_market_id
        where m.venue = 'polymarket'
          and m.clob_token_ids is not null
          and m.clob_token_ids <> ''
          and m.clob_token_ids <> '[]'
          and m.clob_token_ids::jsonb ? $1
        limit 1
      `,
      [tokenId],
    );

    return fallbackResult.rows[0] ?? null;
  }

  if (conditionId) {
    const { rows } = await pool.query<PolymarketMarketInfoRow>(
      `
        select
          pm.id as polymarket_id,
          m.id as unified_market_id,
          pm.condition_id,
          pm.clob_token_ids,
          pm.neg_risk,
          pm.order_price_min_tick_size,
          pm.order_min_size,
          pm.accepting_orders,
          coalesce(pm.raw->>'takerBaseFee', pm.raw->>'taker_fee_bps') as taker_fee_bps,
          coalesce(pm.raw->>'makerBaseFee', pm.raw->>'maker_fee_bps') as maker_fee_bps
        from polymarket_markets pm
        left join unified_markets m
          on m.venue = 'polymarket' and m.venue_market_id = pm.id
        where pm.condition_id = $1
           or m.condition_id = $1
        limit 1
      `,
      [conditionId],
    );

    return rows[0] ?? null;
  }

  if (!marketId) return null;

  const rawMarketId = marketId.startsWith("polymarket:")
    ? marketId.slice("polymarket:".length)
    : marketId;

  const { rows } = await pool.query<PolymarketMarketInfoRow>(
    `
      select
        pm.id as polymarket_id,
        m.id as unified_market_id,
        pm.condition_id,
        pm.clob_token_ids,
        pm.neg_risk,
        pm.order_price_min_tick_size,
        pm.order_min_size,
        pm.accepting_orders,
        coalesce(pm.raw->>'takerBaseFee', pm.raw->>'taker_fee_bps') as taker_fee_bps,
        coalesce(pm.raw->>'makerBaseFee', pm.raw->>'maker_fee_bps') as maker_fee_bps
      from polymarket_markets pm
      left join unified_markets m
        on m.venue = 'polymarket' and m.venue_market_id = pm.id
      where pm.id = $1
         or m.id = $2
         or m.venue_market_id = $1
      limit 1
    `,
    [rawMarketId, marketId],
  );

  return rows[0] ?? null;
}

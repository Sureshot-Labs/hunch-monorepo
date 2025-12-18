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
};

export async function fetchPolymarketMarketInfo(
  pool: Pool,
  inputs: { tokenId?: string; marketId?: string },
): Promise<PolymarketMarketInfoRow | null> {
  const tokenId = inputs.tokenId?.trim();
  const marketId = inputs.marketId?.trim();

  if (tokenId) {
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
          pm.accepting_orders
        from polymarket_markets pm
        left join unified_markets m
          on m.venue = 'polymarket' and m.venue_market_id = pm.id
        where pm.clob_token_ids is not null
          and pm.clob_token_ids <> ''
          and pm.clob_token_ids::jsonb ? $1
        limit 1
      `,
      [tokenId],
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
        pm.accepting_orders
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
